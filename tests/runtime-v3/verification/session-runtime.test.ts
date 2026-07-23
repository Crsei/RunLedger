import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import { OsKeyringArtifactKeyProvider } from "../../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../../src/runtime/artifacts/session-journal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { EventWriter, openEventWriter } from "../../../src/runtime/session/event-writer.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import {
	VerificationSessionRuntime,
	verificationReportArtifactIdentity,
} from "../../../src/runtime/verification/session-runtime.ts";
import type { VerificationPipelineRequest } from "../../../src/runtime/verification/types.ts";
import { FakeOsKeyring } from "../artifacts/helpers.ts";
import {
	AGENT_ID,
	AUTHORITY_ID,
	BASE_COMMIT,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	REQUEST_ID,
	RUNTIME_ID,
	SESSION_ID,
	SESSION_STREAM,
	TENANT_ID,
	TRACE_ID,
	VERIFICATION_ID,
	baselineReceipt,
	candidate,
	candidateEnvelope,
	gateManifest,
	policy,
	registry,
	reportFor,
	verificationResult,
} from "./helpers.ts";

const roots: string[] = [];
const CLOCK = "2026-07-22T08:00:04.000Z";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(): VerificationPipelineRequest {
	return {
		requestId: createRuntimeId("command", "verification-baseline-request"),
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

async function setup(onPhase?: () => Promise<void> | void) {
	const root = await mkdtemp(join(tmpdir(), "runledger-verification-session-"));
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
		leaseId: createRuntimeId("lease", "verification-session"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "verification-session-fence-0001",
	};
	const keyProvider = new OsKeyringArtifactKeyProvider(new FakeOsKeyring());
	const cas = new ArtifactCasStore({ rootDir: root });
	const metadata = new ArtifactMetadataStore({ rootDir: root });
	const makeRuntime = (writer: EventWriter, phaseHook?: () => Promise<void> | void) => {
		const journal = new SessionArtifactJournal({
			writer,
			store,
			principalId: PRINCIPAL_ID,
			traceIdFactory: () => createRuntimeId("trace", "verification-artifact"),
		});
		const artifacts = new ArtifactRepository({
			cas,
			metadata,
			journal,
			keyProvider,
			clock: () => new Date(CLOCK),
		});
		return new VerificationSessionRuntime({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			sessionId: SESSION_ID,
			principalId: PRINCIPAL_ID,
			writer,
			store,
			artifacts,
			metadata,
			cas,
			traceIdFactory: () => createRuntimeId("trace", "verification-runtime"),
			...(phaseHook ? { onPhase: phaseHook } : {}),
		});
	};
	const writer = new EventWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		store,
		fence,
		clock: () => new Date(CLOCK),
	});
	expect((await writer.append({
		type: "session.created",
		principalId: PRINCIPAL_ID,
		traceId: createRuntimeId("trace", "verification-genesis"),
		payload: {
			origin: "test",
			runtimeId: RUNTIME_ID,
			featureDigest: canonicalDigest("verification-features"),
			initialGoalId: createRuntimeId("goal", "verification-session"),
			rootAgentId: AGENT_ID,
		},
	})).ok).toBe(true);
	return {
		store,
		metadata,
		runtime: makeRuntime(writer, onPhase),
		reopen: async () => {
			const reopened = await openEventWriter({
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				stream: SESSION_STREAM,
				store,
				fence,
				clock: () => new Date(CLOCK),
			});
			if (!reopened.ok) throw new Error(reopened.error.message);
			return makeRuntime(reopened.value);
		},
	};
}

describe("VerificationSessionRuntime", () => {
	it("stores the canonical report in Artifact CAS and resolves it for seal-readiness issuer verification", async () => {
		const context = await setup();
		const manifest = gateManifest();
		const baseline = baselineReceipt(policy(manifest));
		const report = reportFor(verificationResult({ manifest, baseline }));
		const pipelineRequest = request();
		expect((await context.runtime.recordStarted(pipelineRequest, manifest, baseline)).ok).toBe(true);
		expect((await context.runtime.recordFinished(pipelineRequest, report)).ok).toBe(true);

		const identity = verificationReportArtifactIdentity(pipelineRequest, report);
		const metadata = await context.metadata.readCommitted(AUTHORITY_ID, TENANT_ID, identity.artifactId);
		expect(metadata.ok && metadata.value.transformReceipt.replacementCount).toBe(0);
		expect(metadata.ok && metadata.value.sourceReceipt.status).toBe("protected");
		const page = await context.store.readPage(SESSION_STREAM, { limit: 32 });
		expect(page.ok && page.value.events.map((event) => event.type)).toEqual([
			"session.created",
			"verification.started",
			"artifact.intent_recorded",
			"artifact.created",
			"artifact.committed",
			"verification.finished",
		]);

		const reopened = await context.reopen();
		const resolved = await reopened.resolveExisting(pipelineRequest);
		expect(resolved.ok && resolved.value?.reportDigest).toBe(report.reportDigest);
		if (!resolved.ok || !resolved.value) throw new Error("verification report was not durably resolved");
		expect((await registry().verify(resolved.value)).ok).toBe(true);
	});

	it("repairs the finished event after a crash following Artifact commit without rerunning", async () => {
		const context = await setup(() => {
			throw new Error("simulated crash after Artifact commit");
		});
		const manifest = gateManifest();
		const baseline = baselineReceipt(policy(manifest));
		const report = reportFor(verificationResult({ manifest, baseline }));
		const pipelineRequest = request();
		expect((await context.runtime.recordStarted(pipelineRequest, manifest, baseline)).ok).toBe(true);
		expect(await context.runtime.recordFinished(pipelineRequest, report)).toMatchObject({
			ok: false,
			error: { code: "evidence_unavailable", retryable: true },
		});
		let page = await context.store.readPage(SESSION_STREAM, { limit: 32 });
		expect(page.ok && page.value.events.filter((event) => event.type === "verification.finished")).toHaveLength(0);

		const reopened = await context.reopen();
		const recovered = await reopened.resolveExisting(pipelineRequest);
		expect(recovered.ok && recovered.value?.reportDigest).toBe(report.reportDigest);
		const repeated = await reopened.resolveExisting(pipelineRequest);
		expect(repeated.ok && repeated.value?.reportDigest).toBe(report.reportDigest);
		page = await context.store.readPage(SESSION_STREAM, { limit: 32 });
		expect(page.ok && page.value.events.filter((event) => event.type === "verification.finished")).toHaveLength(1);
	});
});
