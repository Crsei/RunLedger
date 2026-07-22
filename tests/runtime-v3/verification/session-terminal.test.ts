import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEpisodeManifest,
	createEpisodeSeal,
	episodeSealIdFor,
} from "../../../src/runtime/artifacts/episode-manifest.ts";
import type { EpisodeManifest, EpisodeSeal, EpisodeSealBody } from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { FileEpisodeManifestStore } from "../../../src/runtime/verification/manifest-store.ts";
import { SessionEpisodeLifecycleWriter } from "../../../src/runtime/verification/session-terminal.ts";
import { AUTHORITY_ID, PRINCIPAL_ID, REPOSITORY_ID, RUNTIME_ID, SESSION_ID, SESSION_STREAM, TENANT_ID, WORKSPACE_ID } from "./helpers.ts";

const NOW = "2026-07-22T08:00:05.000Z";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options?: {
	manifestStore?: FileEpisodeManifestStore;
	onPhase?: ConstructorParameters<typeof SessionEpisodeLifecycleWriter>[0]["onPhase"];
}) {
	const root = await mkdtemp(join(tmpdir(), "runledger-episode-lifecycle-"));
	roots.push(root);
	const fence: WriterFence = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		leaseId: createRuntimeId("lease", "episode-lifecycle"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "episode-lifecycle-fence-0001",
	};
	const store = new MemoryEventStore({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		validateFence: () => true,
	});
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
		traceId: createRuntimeId("trace", "episode-lifecycle-genesis"),
		payload: {
			origin: "test",
			runtimeId: RUNTIME_ID,
			featureDigest: canonicalDigest("episode-lifecycle-features"),
			initialGoalId: createRuntimeId("goal", "episode-lifecycle"),
			rootAgentId: createRuntimeId("agent", "episode-lifecycle"),
		},
	});
	if (!genesis.ok) throw new Error(genesis.error.message);
	const manifestStore = options?.manifestStore ?? new FileEpisodeManifestStore({ rootDir: root });
	const lifecycle = new SessionEpisodeLifecycleWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		principalId: PRINCIPAL_ID,
		writer,
		store,
		manifestStore,
		traceIdFactory: () => createRuntimeId("trace", "episode-lifecycle"),
		onPhase: options?.onPhase,
	});
	return { root, fence, store, writer, manifestStore, lifecycle, head: writer.currentHead() };
}

function manifestFor(evidenceHead: ReturnType<EventWriter["currentHead"]>): EpisodeManifest {
	if (!evidenceHead) throw new Error("missing evidence head");
	const result = createEpisodeManifest({
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
			baseCommit: "1".repeat(40),
			headCommit: "2".repeat(40),
		},
		artifacts: [],
		permissionReceiptIds: [createRuntimeId("receipt", "episode-permission")],
		approvalIds: [createRuntimeId("approval", "episode-approval")],
		cost: { status: "complete", totalUsd: 0.1 },
		verification: { status: "complete", verificationIds: [createRuntimeId("verification", "episode") ] },
		artifactKeyState: "available",
		legacyUnverifiedCount: 0,
		createdAt: NOW,
	});
	if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(evidenceHead)}`);
	return result.value;
}

function sealFor(manifest: EpisodeManifest, manifestCommitCursor: Awaited<ReturnType<SessionEpisodeLifecycleWriter["commitManifest"]>>): EpisodeSeal {
	if (!manifestCommitCursor.ok) throw new Error(manifestCommitCursor.error.message);
	const identity = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		manifestBodyDigest: manifest.manifestDigest,
		evidenceHead: manifest.evidenceHead,
		manifestCommitCursor: manifestCommitCursor.value.manifestCommitCursor,
		referenceClosureDigest: canonicalDigest("episode-closure"),
		verificationReceiptDigests: [canonicalDigest("verification-receipt")],
	};
	const body: Omit<EpisodeSealBody, "signerAttestation"> = {
		...identity,
		schemaVersion: 1,
		sealId: episodeSealIdFor(identity),
	};
	const created = createEpisodeSeal({
		...body,
		signerAttestation: {
			issuerId: "production-verifier",
			schemaVersion: 1,
			algorithm: "hmac-sha256",
			keyId: "verification-key-v1",
			issuedAt: NOW,
			signature: canonicalDigest("episode-signature"),
		},
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

describe("SessionEpisodeLifecycleWriter", () => {
	it("writes one manifest commit followed by one seal record and returns both idempotently", async () => {
		const context = await setup();
		const manifest = manifestFor(context.head);
		const committed = await context.lifecycle.commitManifest({ manifest });
		expect(committed.ok).toBe(true);
		expect(await context.lifecycle.commitManifest({ manifest })).toEqual(committed);
		const seal = sealFor(manifest, committed);
		const recorded = await context.lifecycle.recordSeal({ seal });
		expect(recorded.ok).toBe(true);
		expect(await context.lifecycle.recordSeal({ seal })).toEqual(recorded);
		const page = await context.store.readPage(SESSION_STREAM, { limit: 8 });
		expect(page.ok && page.value.events.map((event) => event.type)).toEqual([
			"session.created",
			"episode.manifest_committed",
			"episode.seal_recorded",
		]);
		const resolved = await context.lifecycle.resolveBySealDigest(seal.sealDigest);
		expect(resolved.ok && resolved.value.seal).toEqual(seal);
	});

	it("replays acknowledgements after crashes at both event boundaries without duplicate seals", async () => {
		let manifestCrash = true;
		let sealCrash = true;
		const context = await setup({
			onPhase: (phase) => {
				if (phase === "after_manifest_committed_before_return" && manifestCrash) {
					manifestCrash = false;
					throw new Error("manifest crash");
				}
				if (phase === "after_seal_recorded_before_return" && sealCrash) {
					sealCrash = false;
					throw new Error("seal crash");
				}
			},
		});
		const manifest = manifestFor(context.head);
		expect(await context.lifecycle.commitManifest({ manifest })).toMatchObject({
			ok: false,
			error: { code: "lifecycle_paused" },
		});
		const replayedCommit = await context.lifecycle.commitManifest({ manifest });
		expect(replayedCommit.ok).toBe(true);
		const seal = sealFor(manifest, replayedCommit);
		expect(await context.lifecycle.recordSeal({ seal })).toMatchObject({
			ok: false,
			error: { code: "lifecycle_paused" },
		});
		expect((await context.lifecycle.recordSeal({ seal })).ok).toBe(true);
		const page = await context.store.readPage(SESSION_STREAM, { limit: 8 });
		expect(page.ok && page.value.events.filter((event) => event.type === "episode.manifest_committed")).toHaveLength(1);
		expect(page.ok && page.value.events.filter((event) => event.type === "episode.seal_recorded")).toHaveLength(1);
	});

	it("recovers a body-store crash before the manifest event and then commits once", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-episode-body-crash-"));
		roots.push(root);
		let crash = true;
		const context = await setup({
			manifestStore: new FileEpisodeManifestStore({
				rootDir: root,
				onPhase: (phase) => {
					if (phase === "after_link" && crash) {
						crash = false;
						throw new Error("body crash");
					}
				},
			}),
		});
		const manifest = manifestFor(context.head);
		expect(await context.lifecycle.commitManifest({ manifest })).toMatchObject({
			ok: false,
			error: { code: "lifecycle_paused" },
		});
		const replay = new SessionEpisodeLifecycleWriter({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			sessionId: SESSION_ID,
			principalId: PRINCIPAL_ID,
			writer: context.writer,
			store: context.store,
			manifestStore: new FileEpisodeManifestStore({ rootDir: root }),
		});
		expect((await replay.commitManifest({ manifest })).ok).toBe(true);
		const page = await context.store.readPage(SESSION_STREAM, { limit: 8 });
		expect(page.ok && page.value.events.filter((event) => event.type === "episode.manifest_committed")).toHaveLength(1);
	});

	it("pauses instead of sealing when any event appears after the manifest commit", async () => {
		const context = await setup();
		const manifest = manifestFor(context.head);
		const committed = await context.lifecycle.commitManifest({ manifest });
		if (!committed.ok) throw new Error(committed.error.message);
		const unrelated = await context.writer.append({
			type: "conversation.message_recorded",
			principalId: PRINCIPAL_ID,
			traceId: createRuntimeId("trace", "episode-interleaving"),
			payload: { role: "user", messageJson: "[]", contentDigest: canonicalDigest([]) },
		});
		if (!unrelated.ok) throw new Error(unrelated.error.message);
		const seal = sealFor(manifest, committed);
		expect(await context.lifecycle.recordSeal({ seal })).toMatchObject({
			ok: false,
			error: { code: "lifecycle_paused" },
		});
		const page = await context.store.readPage(SESSION_STREAM, { limit: 8 });
		expect(page.ok && page.value.events.some((event) => event.type === "episode.seal_recorded")).toBe(false);
	});

	it.each(["noncanonical_json", "cursor_mismatch", "digest_mismatch"] as const)(
		"rejects a durable seal projection with %s",
		async (tamper) => {
			const context = await setup();
			const manifest = manifestFor(context.head);
			const committed = await context.lifecycle.commitManifest({ manifest });
			if (!committed.ok) throw new Error(committed.error.message);
			const seal = sealFor(manifest, committed);
			const payload = {
				receiptId: createRuntimeId("receipt", `forged-seal-${tamper}`),
				sealId: seal.sealId,
				sealDigest: seal.sealDigest,
				manifestBodyDigest: seal.manifestBodyDigest,
				manifestCommitCursor: seal.manifestCommitCursor,
				referenceClosureDigest: seal.referenceClosureDigest,
				verificationReceiptDigests: [...seal.verificationReceiptDigests],
				sealJson: canonicalJson(seal),
			};
			if (tamper === "noncanonical_json") payload.sealJson = ` ${payload.sealJson}`;
			if (tamper === "cursor_mismatch") payload.manifestCommitCursor = manifest.evidenceHead;
			if (tamper === "digest_mismatch") payload.sealDigest = canonicalDigest("forged-seal-digest");
			const appended = await context.writer.append({
				type: "episode.seal_recorded",
				principalId: PRINCIPAL_ID,
				traceId: createRuntimeId("trace", `forged-seal-${tamper}`),
				payload,
			});
			if (!appended.ok) throw new Error(appended.error.message);
			expect(await context.lifecycle.resolveBySealDigest(payload.sealDigest)).toMatchObject({
				ok: false,
				error: { code: "invalid_digest" },
			});
		},
	);
});
