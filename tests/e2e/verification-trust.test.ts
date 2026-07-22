import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactCasStore, ArtifactRepository } from "../../src/runtime/artifacts/cas-store.ts";
import { createEpisodeManifest } from "../../src/runtime/artifacts/episode-manifest.ts";
import { OsKeyringArtifactKeyProvider } from "../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../src/runtime/artifacts/session-journal.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { transitionGoal } from "../../src/runtime/orchestrator/goal-state-machine.ts";
import type { GoalEvidence, GoalState } from "../../src/runtime/orchestrator/types.ts";
import { EventWriter } from "../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../src/runtime/session/types.ts";
import {
	EpisodeSealCompletionTrustAdapter,
	resolveEpisodeLifecycleReadiness,
	sealEpisode,
	toEpisodeSealCompletionRef,
	type EpisodeReferenceResolution,
	type EpisodeReferenceResolverPort,
	type EpisodeSealSignerPort,
} from "../../src/runtime/verification/report.ts";
import { FileEpisodeManifestStore } from "../../src/runtime/verification/manifest-store.ts";
import { VerificationSessionRuntime } from "../../src/runtime/verification/session-runtime.ts";
import { SessionEpisodeLifecycleWriter } from "../../src/runtime/verification/session-terminal.ts";
import type { VerificationPipelineRequest, VerificationReport } from "../../src/runtime/verification/types.ts";
import { FakeOsKeyring } from "../runtime-v3/artifacts/helpers.ts";
import {
	AGENT_ID,
	AUTHORITY_ID,
	BASE_COMMIT,
	CANDIDATE_COMMIT,
	ISSUER_ID,
	KEY_ID,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	REQUEST_ID,
	RUNTIME_ID,
	SESSION_ID,
	SESSION_STREAM,
	TENANT_ID,
	TRACE_ID,
	VERIFICATION_ID,
	WORKSPACE_ID,
	baselineReceipt,
	candidate,
	candidateEnvelope,
	gateManifest,
	policy,
	registry,
	reportFor,
	verificationResult,
} from "../runtime-v3/verification/helpers.ts";

const roots: string[] = [];
const NOW = "2026-07-22T08:00:05.000Z";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pipelineRequest(): VerificationPipelineRequest {
	return {
		requestId: createRuntimeId("command", "e2e-verification-baseline"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		traceId: TRACE_ID,
		repositoryId: REPOSITORY_ID,
		gateKey: "test",
		ownerRuntimeId: RUNTIME_ID,
		verificationId: VERIFICATION_ID,
		runnerRequestId: REQUEST_ID,
		candidate: candidate(),
		candidateEnvelope: candidateEnvelope(),
	};
}

function available(seed: string): EpisodeReferenceResolution {
	return { status: "available", referenceDigest: canonicalDigest(seed) };
}

class EpisodeResolver implements EpisodeReferenceResolverPort {
	readonly #verification: VerificationSessionRuntime;

	public constructor(verification: VerificationSessionRuntime) {
		this.#verification = verification;
	}

	public async resolveEventHead() { return available("event-head"); }
	public async resolveWorkspace() { return available("workspace"); }
	public async resolveArtifact() { return available("artifact"); }
	public async resolvePermissionReceipt() { return available("permission"); }
	public async resolveApproval() { return available("approval"); }
	public resolveVerification(verificationId: typeof VERIFICATION_ID) {
		return this.#verification.resolveVerification(verificationId);
	}
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "runledger-verification-e2e-"));
	roots.push(root);
	const store = new MemoryEventStore({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		validateFence: () => true,
	});
	const fence: WriterFence = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		leaseId: createRuntimeId("lease", "verification-e2e"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "verification-e2e-fence-0001",
	};
	const writer = new EventWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		store,
		fence,
		clock: () => new Date(NOW),
	});
	const genesis = await writer.append({
		type: "session.created",
		principalId: PRINCIPAL_ID,
		traceId: createRuntimeId("trace", "verification-e2e-genesis"),
		payload: {
			origin: "test",
			runtimeId: RUNTIME_ID,
			featureDigest: canonicalDigest("verification-e2e-features"),
			initialGoalId: createRuntimeId("goal", "verification-e2e"),
			rootAgentId: AGENT_ID,
		},
	});
	if (!genesis.ok) throw new Error(genesis.error.message);
	const cas = new ArtifactCasStore({ rootDir: root });
	const metadata = new ArtifactMetadataStore({ rootDir: root });
	const artifacts = new ArtifactRepository({
		cas,
		metadata,
		journal: new SessionArtifactJournal({ writer, store, principalId: PRINCIPAL_ID }),
		keyProvider: new OsKeyringArtifactKeyProvider(new FakeOsKeyring()),
		clock: () => new Date(NOW),
	});
	const verification = new VerificationSessionRuntime({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		principalId: PRINCIPAL_ID,
		writer,
		store,
		artifacts,
		metadata,
		cas,
	});
	return { root, store, writer, verification };
}

const signer: EpisodeSealSignerPort = {
	descriptor: { issuerId: ISSUER_ID, schemaVersion: 1, algorithm: "hmac-sha256", keyId: KEY_ID },
	sign: async (inputDigest) => ({ ok: true, value: canonicalDigest({ key: "test-secret", inputDigest }) }),
};

function episodeFor(
	report: VerificationReport,
	evidenceHead: NonNullable<ReturnType<EventWriter["currentHead"]>>,
) {
	const episode = createEpisodeManifest({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		principalId: PRINCIPAL_ID,
		evidenceHead,
		integrity: "valid",
		attestation: "attested",
		workspace: {
			workspaceId: WORKSPACE_ID,
			repositoryId: REPOSITORY_ID,
			baseCommit: BASE_COMMIT,
			headCommit: CANDIDATE_COMMIT,
		},
		artifacts: report.result.artifacts.map((entry) => entry.artifact),
		permissionReceiptIds: [createRuntimeId("receipt", "verification-e2e-permission")],
		approvalIds: [createRuntimeId("approval", "verification-e2e-approval")],
		cost: { status: "complete", totalUsd: 0.25 },
		verification: { status: "complete", verificationIds: [VERIFICATION_ID] },
		createdAt: NOW,
		artifactKeyState: "available",
		legacyUnverifiedCount: 0,
	});
	if (!episode.ok) throw new Error(episode.error.message);
	return episode.value;
}

describe("production verification trust chain", () => {
	it("records a signed durable EpisodeSeal and trusts only its durable seal record", async () => {
		const context = await setup();
		const manifest = gateManifest();
		const baseline = baselineReceipt(policy(manifest));
		const report = reportFor(verificationResult({ manifest, baseline }));
		const request = pipelineRequest();
		expect((await context.verification.recordStarted(request, manifest, baseline)).ok).toBe(true);
		expect((await context.verification.recordFinished(request, report)).ok).toBe(true);

		const eventHead = context.writer.currentHead();
		if (!eventHead) throw new Error("verification did not produce a durable event head");
		const episode = episodeFor(report, eventHead);
		const lifecycle = new SessionEpisodeLifecycleWriter({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			sessionId: SESSION_ID,
			principalId: PRINCIPAL_ID,
			writer: context.writer,
			store: context.store,
			manifestStore: new FileEpisodeManifestStore({ rootDir: context.root }),
		});
		const sealed = await sealEpisode(
			episode,
			new EpisodeResolver(context.verification),
			registry("production"),
			signer,
			lifecycle,
		);
		expect(sealed.ok).toBe(true);
		if (!sealed.ok) return;
		const reference = toEpisodeSealCompletionRef(sealed.value);
		if (!reference) throw new Error("EpisodeSeal completion reference was not constructed");
		const trust = new EpisodeSealCompletionTrustAdapter(lifecycle, registry("production"));
		expect(await trust.verify(reference)).toBe(true);
		expect(await trust.verify({ ...reference, sealRecordDigest: canonicalDigest("caller-forgery") })).toBe(false);
		const awaitingVerification: GoalState = {
			goalId: createRuntimeId("goal", "verification-e2e"),
			phase: "awaiting_verification",
			revision: 7,
			evidence: [],
			partialResults: [],
		};
		const completionEvidence: GoalEvidence = {
			kind: "verification",
			receiptId: sealed.value.sealRecord.receiptId,
			digest: reference.sealRecordDigest,
			outcome: "pass",
			issuerId: ISSUER_ID,
			issuedAt: NOW,
			episodeSeal: reference,
		};
		const completed = await transitionGoal(
			awaitingVerification,
			{
				to: "completed",
				actor: "trusted_verifier",
				expectedRevision: awaitingVerification.revision,
				evidence: [completionEvidence],
			},
			trust,
		);
		expect(completed.ok && completed.value.phase).toBe("completed");
		const forgedCompletion = await transitionGoal(
			awaitingVerification,
			{
				to: "completed",
				actor: "trusted_verifier",
				expectedRevision: awaitingVerification.revision,
				evidence: [{
					...completionEvidence,
					digest: canonicalDigest("caller-forgery"),
					episodeSeal: { ...reference, sealRecordDigest: canonicalDigest("caller-forgery") },
				}],
			},
			trust,
		);
		expect(forgedCompletion.ok).toBe(false);
		const events = await context.store.readPage(SESSION_STREAM, { limit: 32 });
		expect(events.ok && events.value.events.slice(-2).map((event) => event.type)).toEqual([
			"episode.manifest_committed",
			"episode.seal_recorded",
		]);
	});

	it("keeps an inconclusive sandbox result outside Episode seal readiness", async () => {
		const context = await setup();
		const manifest = gateManifest();
		const baseline = baselineReceipt(policy(manifest));
		const report = reportFor(verificationResult({ enforcement: "degraded" }));
		expect(report.result.outcome).toBe("inconclusive");
		const request = pipelineRequest();
		expect((await context.verification.recordStarted(request, manifest, baseline)).ok).toBe(true);
		expect((await context.verification.recordFinished(request, report)).ok).toBe(true);
		const eventHead = context.writer.currentHead();
		if (!eventHead) throw new Error("verification did not produce a durable event head");
		const readiness = await resolveEpisodeLifecycleReadiness(
			episodeFor(report, eventHead),
			new EpisodeResolver(context.verification),
			registry("production"),
		);
		expect(readiness.ok && readiness.value.status).toBe("blocked");
		if (readiness.ok) expect(readiness.value.reasonCodes).toContain("verification_not_trusted_pass");
	});
});
