import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forkV3FromCli, migrateLegacyFromCli } from "../../../src/cli/v3-session-commands.ts";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import { UnavailableArtifactKeyProvider } from "../../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../../src/runtime/artifacts/session-journal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES, type RuntimeFeatureFlags } from "../../../src/runtime/runtime-features.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { FileWriterLeaseStore } from "../../../src/runtime/session/writer-lease.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { SessionManager } from "../../../src/storage/session-manager.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const FLAGS: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const roots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "runledger-v3-manager-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V3SessionManager", () => {
	it("creates, releases, reopens, recovers, and replays canonical model history", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		await manager.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
		const filePath = manager.filePath();
		const sessionId = manager.sessionId();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.sessionId()).toBe(sessionId);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume", snapshotSource: "full" });
		expect(await reopened.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		]);
		await reopened.closeAll();
	});

	it("stops renewing an uncertain partial close and permits cold takeover only after lease expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const firstFence = manager.writerFenceReceipt();
		const originalClose = JsonlV3EventStore.prototype.close;
		let closeAttempts = 0;
		vi.spyOn(JsonlV3EventStore.prototype, "close").mockImplementation(async function () {
			closeAttempts += 1;
			const result = await originalClose.call(this);
			if (closeAttempts === 1 && result.ok) {
				return {
					ok: false,
					error: {
						code: "durable_write_failed",
						message: "injected result loss after the event store closed",
						retryable: false,
						effect: "uncertain",
					},
				};
			}
			return result;
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const failedClose = manager.closeAll();
		await expect(failedClose).rejects.toThrow("v3 event writer close failed");
		expect(manager.isClosed()).toBe(false);
		expect(manager.closeAll()).toBe(failedClose);
		await expect(manager.closeAll()).rejects.toThrow("v3 event writer close failed");
		expect(closeAttempts).toBe(1);
		await expect(V3SessionManager.open(
			manager.filePath(),
			FLAGS,
			manager.identity(),
			{ runtimeId: createRuntimeId("runtime", "competing-close") },
		)).rejects.toThrow("v3 writer lease unavailable");

		await vi.advanceTimersByTimeAsync(31_000);
		expect(heartbeat).not.toHaveBeenCalled();
		const recovered = await V3SessionManager.open(
			manager.filePath(),
			FLAGS,
			manager.identity(),
			{ runtimeId: createRuntimeId("runtime", "cold-takeover") },
		);
		expect(recovered.writerFenceReceipt().writerEpoch).toBe(firstFence.writerEpoch + 1);
		expect(recovered.recoveryDecision()).toMatchObject({ kind: "resume" });
		await recovered.closeAll();
	});

	it("does not revive its heartbeat when lease release fails after a confirmed writer close", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-23T01:00:00.000Z"));
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const firstFence = manager.writerFenceReceipt();
		const release = vi.spyOn(FileWriterLeaseStore.prototype, "release").mockReturnValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected lease release failure",
				retryable: true,
				effect: "none",
			},
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const failedClose = manager.closeAll();
		await expect(failedClose).rejects.toThrow("v3 writer lease release failed");
		expect(manager.isClosed()).toBe(false);
		expect(manager.closeAll()).toBe(failedClose);
		expect(release).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(31_000);
		expect(heartbeat).not.toHaveBeenCalled();
		const recovered = await V3SessionManager.open(
			manager.filePath(),
			FLAGS,
			manager.identity(),
			{ runtimeId: createRuntimeId("runtime", "release-failure-takeover") },
		);
		expect(recovered.writerFenceReceipt().writerEpoch).toBe(firstFence.writerEpoch + 1);
		await recovered.closeAll();
	});

	it("keeps renewing its writer lease while a slow writer close is still pending", async () => {
		vi.useFakeTimers();
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const originalClose = EventWriter.prototype.close;
		let releaseClose: (() => void) | undefined;
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		vi.spyOn(EventWriter.prototype, "close").mockImplementationOnce(async function () {
			await closeGate;
			return originalClose.call(this);
		});
		const heartbeat = vi.spyOn(FileWriterLeaseStore.prototype, "heartbeat");

		const closing = manager.closeAll();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(heartbeat).toHaveBeenCalledTimes(2);
		expect(manager.isClosed()).toBe(false);

		releaseClose?.();
		await expect(closing).resolves.toBeUndefined();
		expect(manager.isClosed()).toBe(true);
	});

	it("migrates legacy v2 through an explicit empty v3 target and lists it as v3", async () => {
		const root = temporaryRoot();
		const legacyDir = join(root, "legacy");
		const v3Dir = join(root, "v3");
		const legacy = await SessionManager.create({ cwd: root, sessionDir: legacyDir });
		const message = { role: "user", content: [{ type: "text", text: "migrate me" }] } as const;
		await legacy.ledger().append({
			id: "legacy-message",
			sessionId: legacy.sessionId(),
			parentId: legacy.ledger().header().id,
			timestamp: Date.now(),
			type: "message",
			payload: { schema: "agent-message/v1", role: "user", message },
		});
		await legacy.ledger().append({
			id: "legacy-config",
			sessionId: legacy.sessionId(),
			parentId: "legacy-message",
			timestamp: Date.now(),
			type: "custom",
			payload: { kind: "runtime.config", provider: "fixture", model: "fixture-model", thinkingLevel: "high" },
		});
		const sourcePath = legacy.filePath();
		await legacy.closeAll();

		const migrated = await migrateLegacyFromCli({
			sourcePath,
			mode: "migrate",
			cwd: root,
			sessionDir: v3Dir,
			features: FLAGS,
		});
		expect(migrated.importedMessageCount).toBe(1);
		const listed = await SessionManager.list(root, v3Dir);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ filePath: migrated.filePath, format: "v3", version: 3 });

		const manager = await V3SessionManager.open(migrated.filePath, FLAGS);
		expect(await manager.replayMessages()).toEqual([message]);
		expect(await manager.replayRuntimeConfig()).toEqual({
			provider: "fixture",
			model: "fixture-model",
			thinkingLevel: "high",
		});
		await manager.closeAll();
	});

	it("opens an interrupted migration inspect-only until it is resumed or durably failed", async () => {
		const root = temporaryRoot();
		const target = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
			writeGenesis: false,
		});
		const manifest = {
			mode: "migrate" as const,
			sourceVersion: 2 as const,
			sourceDigest: canonicalDigest("legacy-source"),
			sourceSize: 42,
			headerDigest: canonicalDigest("legacy-header"),
			sourceSessionId: "legacy-session",
			importerVersion: "fixture-importer",
			importSchema: "runtime-session-migration/v1",
			configurationJson: "{}",
			configurationDigest: canonicalDigest("{}"),
			recoveredFields: [],
			lostFields: [],
			expectedRecordCount: 1,
			expectedRecordSetDigest: canonicalDigest(["pending-record"]),
		};
		const started = await target.writer().append({
			type: "session.migration_started",
			principalId: target.identity().principalId,
			traceId: createRuntimeId("trace", "partial-migration"),
			payload: {
				...manifest,
				manifestDigest: canonicalDigest(manifest),
				idempotencyKey: createRuntimeId("command", "partial-migration"),
			},
		});
		expect(started.ok).toBe(true);
		const filePath = target.filePath();
		await target.closeAll();

		const paused = await V3SessionManager.open(filePath, FLAGS);
		expect(paused.artifactReconciliation()).toBeUndefined();
		expect(paused.recoveryDecision()).toMatchObject({
			kind: "pause_for_approval",
			reasons: ["uncertain_operation"],
			projection: { lifecycle: "migration_in_progress", migration: { status: "in_progress" } },
		});
		await expect(paused.replayMessages()).rejects.toThrow("legacy migration is not durably committed");
		const failed = await paused.markLegacyMigrationFailed("operator_abandoned", "operator chose a new target");
		expect(failed).toMatchObject({ head: { sequence: 1 }, importedRecordCount: 0 });
		expect(paused.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "migration_failed" });
		await paused.closeAll();

		const terminal = await V3SessionManager.open(filePath, FLAGS);
		expect(terminal.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "migration_failed" });
		expect(terminal.artifactReconciliation()).toBeUndefined();
		await terminal.closeAll();
	});

	it("forks only a stable v3 boundary into a distinct lineage without copying event IDs", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const parent = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		await parent.sessionEvents().recordMessage({ role: "user", content: [{ type: "text", text: "fork me" }] });
		const parentPath = parent.filePath();
		await parent.closeAll();

		const forked = await forkV3FromCli({ sourcePath: parentPath, cwd: root, sessionDir: sessions, features: FLAGS });
		const child = await V3SessionManager.open(forked.filePath, FLAGS);
		const childEvents = await readAllRuntimeEvents(child.eventStore());
		expect(childEvents.ok).toBe(true);
		if (!childEvents.ok) throw new Error(childEvents.error.message);
		expect(childEvents.value[0]).toMatchObject({
			type: "session.forked",
			payload: {
				parentEventHash: forked.parentHeadDigest,
				goalMode: "continue_existing_goal",
				initialGoalId: forked.initialGoalId,
				rootAgentId: forked.rootAgentId,
				parentRootAgentId: forked.parentRootAgentId,
			},
		});
		expect(child.sessionEvents().lineage()).toEqual({
			goalId: forked.initialGoalId,
			agentId: forked.rootAgentId,
		});
		const parentReopened = await V3SessionManager.open(parentPath, FLAGS);
		const parentEvents = await readAllRuntimeEvents(parentReopened.eventStore());
		if (!parentEvents.ok) throw new Error(parentEvents.error.message);
		expect(new Set(parentEvents.value.map((event) => event.eventId)).has(childEvents.value[0]!.eventId)).toBe(false);
		expect(await child.replayMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "fork me" }] },
		]);
		await parentReopened.closeAll();
		await child.closeAll();
	});

	it("persists an explicit create-child-goal selection through CLI fork and reopen", async () => {
		const root = temporaryRoot();
		const sessions = join(root, "sessions");
		const parent = await V3SessionManager.create({ cwd: root, sessionDir: sessions, features: FLAGS });
		const parentLineage = parent.sessionEvents().lineage();
		const parentPath = parent.filePath();
		await parent.closeAll();
		const childGoalId = createRuntimeId("goal", "cli-child-goal");
		const forked = await forkV3FromCli({
			sourcePath: parentPath,
			cwd: root,
			sessionDir: sessions,
			features: FLAGS,
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
		});
		expect(forked).toMatchObject({
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
			parentRootAgentId: parentLineage.agentId,
		});
		expect(forked.rootAgentId).not.toBe(parentLineage.agentId);
		const child = await V3SessionManager.open(forked.filePath, FLAGS);
		expect(child.sessionEvents().lineage()).toEqual({ goalId: childGoalId, agentId: forked.rootAgentId });
		await child.closeAll();
	});

	it("writes a stop tombstone before terminal stop and never resumes it", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: join(root, "sessions"), features: FLAGS });
		const filePath = manager.filePath();
		await manager.requestStop("operator stop");
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "stopped", reason: "stop_tombstone" });
		await reopened.closeAll();
	});

	it("reconciles a committed Artifact left pending by a crash before CAS promotion", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({ cwd: root, sessionDir: join(root, "sessions"), features: FLAGS });
		const artifactRoot = join(manager.stateDirectory(), "artifacts");
		const identity = manager.identity();
		const artifactId = createRuntimeId("artifact", "startup-reconcile");
		const intentId = createRuntimeId("command", "startup-reconcile");
		const crashingRepository = new ArtifactRepository({
			cas: new ArtifactCasStore({
				rootDir: artifactRoot,
				onWritePhase: (phase, targetPath) => {
					if (phase === "before_rename" && targetPath.includes("/blobs/")) throw new Error("simulated crash");
				},
			}),
			metadata: new ArtifactMetadataStore({ rootDir: artifactRoot }),
			journal: new SessionArtifactJournal({
				writer: manager.writer(),
				store: manager.eventStore(),
				principalId: identity.principalId,
			}),
			keyProvider: new UnavailableArtifactKeyProvider(),
			clock: () => new Date("2026-07-22T00:00:00.000Z"),
		});
		const pending = await crashingRepository.write({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId,
			intentId,
			principalId: identity.principalId,
			source: { sessionId: manager.sessionId(), producerId: identity.principalId },
			kind: "tool_output",
			mediaType: "text/plain",
			content: "durable output",
		});
		expect(pending).toMatchObject({ ok: true, value: { state: "pending" } });
		if (!pending.ok) throw new Error(pending.error.message);
		const storedDigest = pending.value.metadata.storedDigest;
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS, identity);
		expect(reopened.artifactReconciliation()).toMatchObject({
			ok: true,
			value: { recovered: [intentId], failed: [] },
		});
		const committed = await new ArtifactMetadataStore({ rootDir: artifactRoot }).readCommitted(
			identity.authorityId,
			identity.tenantId,
			artifactId,
		);
		expect(committed).toMatchObject({ ok: true, value: { state: "committed", storedDigest } });
		expect(await new ArtifactCasStore({ rootDir: artifactRoot }).read(storedDigest)).toMatchObject({ ok: true });
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
		await reopened.closeAll();
	});

	it("preserves the genesis goal and root agent lineage across reopen", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const initialLineage = manager.sessionEvents().lineage();
		const firstTurn = await manager.sessionEvents().beginTurn();
		const firstTool = await manager.sessionEvents().requestTool(firstTurn, "provider-1", "fixture", {});
		await manager.sessionEvents().failTool(firstTool, new Error("fixture"), true);
		await manager.sessionEvents().finishTurn(firstTurn, { ok: false }, "stop");
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.sessionEvents().lineage()).toEqual(initialLineage);
		const secondTurn = await reopened.sessionEvents().beginTurn();
		const secondTool = await reopened.sessionEvents().requestTool(secondTurn, "provider-2", "fixture", {});
		await reopened.sessionEvents().failTool(secondTool, new Error("fixture"), true);
		await reopened.sessionEvents().finishTurn(secondTurn, { ok: false }, "stop");
		const events = await readAllRuntimeEvents(reopened.eventStore());
		if (!events.ok) throw new Error(events.error.message);
		const genesis = events.value[0];
		expect(genesis).toMatchObject({
			type: "session.created",
			payload: {
				initialGoalId: initialLineage.goalId,
				rootAgentId: initialLineage.agentId,
			},
		});
		expect(
			events.value.filter((event) => event.type === "turn.started").map((event) => event.payload.goalId),
		).toEqual([initialLineage.goalId, initialLineage.goalId]);
		expect(
			events.value.filter((event) => event.type === "tool.requested").map((event) => event.payload.agentId),
		).toEqual([initialLineage.agentId, initialLineage.agentId]);
		await reopened.closeAll();
	});

	it("restores pending queue bodies, references, kinds, and enqueue order", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const messages = [
			{ kind: "steer" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "one" }] } },
			{ kind: "follow_up" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "two" }] } },
			{ kind: "steer" as const, message: { role: "user" as const, content: [{ type: "text" as const, text: "three" }] } },
		];
		const receipts = [];
		for (const item of messages) {
			receipts.push(await manager.sessionEvents().enqueueWithReceipt(item.kind, item.message));
		}
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		expect(reopened.recoveryDecision()).toMatchObject({ kind: "resume" });
		expect(reopened.sessionEvents().pendingQueueItems().map((item) => ({
			queueItemId: item.reference.queueItemId,
			kind: item.reference.kind,
			message: item.message,
		}))).toEqual(messages.map((item, index) => ({
			queueItemId: receipts[index]!.queueItemId,
			kind: item.kind,
			message: item.message,
		})));
		await reopened.closeAll();
	});

	it("restarts, lists, replays, and cancels an ArtifactRef-backed QueueItemV3 losslessly", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const identity = manager.identity();
		const artifact = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId: createRuntimeId("artifact", "queued-prompt"),
			storedDigest: "c".repeat(64),
			kind: "tool_output" as const,
			originalSize: 128,
			storedSize: 96,
			mediaType: "application/json",
			redaction: "redacted" as const,
			transformReceipt: createRuntimeId("receipt", "queued-prompt"),
		};
		const sourceCommandId = createRuntimeId("command", "queued-prompt-source");
		const receipt = await manager.sessionEvents().enqueueArtifactWithReceipt("follow_up", artifact, {
			sourceCommandId,
		});
		const before = await manager.sessionEvents().inspectQueue();
		expect(before.items).toEqual([
			expect.objectContaining({
				queueItemId: receipt.queueItemId,
				sourceCommandId,
				kind: "follow_up",
				nextTurnPolicy: "after_active_run",
				content: { storage: "artifact", artifact },
				message: null,
			}),
		]);
		const filePath = manager.filePath();
		await manager.closeAll();

		const reopened = await V3SessionManager.open(filePath, FLAGS);
		const restored = await reopened.sessionEvents().inspectQueue();
		expect(restored).toEqual(before);
		expect(() => reopened.sessionEvents().adoptPendingQueueItems()).toThrow("requires artifact resolution");
		const cancellationCommandId = createRuntimeId("command", "queued-prompt-cancel");
		const cancelled = await reopened.sessionEvents().cancelQueueItems(
			restored.queueRevision,
			[{ queueItemId: receipt.queueItemId, kind: "follow_up" }],
			"operator cancelled artifact prompt",
			cancellationCommandId,
		);
		expect(cancelled.receipts).toEqual([
			expect.objectContaining({
				queueItemId: receipt.queueItemId,
				sourceCommandId,
				kind: "follow_up",
				contentDigest: receipt.contentDigest,
			}),
		]);
		const events = await readAllRuntimeEvents(reopened.eventStore());
		if (!events.ok) throw new Error(events.error.message);
		expect(events.value.find((event) => event.type === "queue.enqueued")?.payload).toMatchObject({
			sourceCommandId,
			content: { storage: "artifact", artifact },
		});
		expect(events.value.find((event) => event.type === "queue.cancelled")?.payload).toMatchObject({
			sourceCommandId,
			kind: "follow_up",
			contentDigest: receipt.contentDigest,
			cancellationCommandId,
		});
		await reopened.closeAll();

		const terminalReplay = await V3SessionManager.open(filePath, FLAGS);
		expect((await terminalReplay.sessionEvents().inspectQueue()).items).toEqual([]);
		await terminalReplay.closeAll();
	});

	it("rejects a digest-only queue event before it can become durable v3 state", async () => {
		const root = temporaryRoot();
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: FLAGS,
		});
		const appended = await manager.writer().append({
			type: "queue.enqueued",
			principalId: manager.identity().principalId,
			traceId: createRuntimeId("trace", "legacy-queue-body"),
			payload: {
				queueItemId: createRuntimeId("queueItem", "legacy-queue-body"),
				kind: "steer",
				contentDigest: "0".repeat(64),
				idempotencyKey: createRuntimeId("command", "legacy-queue-body"),
			} as never,
		});
		expect(appended.ok).toBe(false);
		if (!appended.ok) expect(appended.error.code).toBe("invalid_event");
		await manager.closeAll();
	});
});
