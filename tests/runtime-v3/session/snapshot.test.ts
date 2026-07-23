import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import {
	createSessionSnapshot,
	loadSessionProjection,
	readAllRuntimeEvents,
	readSessionSnapshot,
	replaySessionSnapshot,
	writeSessionSnapshot,
	type SessionSnapshot,
} from "../../../src/runtime/session/snapshot.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function valueOf<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function setup() {
	const authorityId = createRuntimeId("authority", "snapshot");
	const tenantId = createRuntimeId("tenant", "snapshot");
	const principalId = createRuntimeId("principal", "snapshot");
	const sessionId = createRuntimeId("session", "snapshot");
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const runtimeId = createRuntimeId("runtime", "snapshot");
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", "snapshot"),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: "snapshot-fence",
	};
	const store = new MemoryEventStore({ authorityId, tenantId, stream, validateFence: () => true });
	const writer = new EventWriter({
		authorityId,
		tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	return { authorityId, tenantId, principalId, sessionId, stream, runtimeId, store, writer };
}

async function appendSnapshotPrefix(context: ReturnType<typeof setup>) {
	valueOf(
		await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-genesis"),
			payload: {
				origin: "test",
				runtimeId: context.runtimeId,
				featureDigest: DIGEST,
				initialGoalId: createRuntimeId("goal", "snapshot"),
				rootAgentId: createRuntimeId("agent", "snapshot"),
			},
		}),
	);
	valueOf(
		await context.writer.append({
			type: "queue.enqueued",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-queue"),
			payload: {
				queueItemId: createRuntimeId("queueItem", "snapshot"),
				sourceCommandId: createRuntimeId("command", "snapshot-queue"),
				kind: "follow_up",
				enqueueRevision: {
					stream: context.stream,
					sequence: 0,
					eventHash: context.writer.currentHead()!.eventHash,
				},
				targetTurnRevision: null,
				nextTurnPolicy: "after_active_run",
				contentDigest: canonicalDigest({ storage: "bounded_text", messageJson: "{}" }),
				content: { storage: "bounded_text", messageJson: "{}" },
			},
		}),
	);
}

async function temporarySnapshotPath(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-snapshot-"));
	roots.push(root);
	return join(root, "private", "session.snapshot.json");
}

describe("SessionSnapshot", () => {
	it("atomically persists a canonical summary and proves snapshot plus tail against the Event Store", async () => {
		const context = setup();
		await appendSnapshotPrefix(context);
		const prefix = valueOf(await readAllRuntimeEvents(context.store));
		const prefixProjection = valueOf(reduceSessionEvents(prefix));
		const snapshot = valueOf(
			createSessionSnapshot(prefix, {
				snapshotId: createRuntimeId("snapshot", "phase-one"),
				activeLeafId: prefixProjection.activeLeafId,
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		expect(snapshot.queue).toEqual([
			expect.objectContaining({ queueItemId: "queueItem_snapshot", kind: "follow_up" }),
		]);
		expect(snapshot.goal).toEqual({ goalId: "goal_snapshot", phase: null });
		expect(snapshot.initialGoalId).toBe("goal_snapshot");
		expect(snapshot.forkGoalMode).toBeNull();
		expect(snapshot.parentRootAgentId).toBeNull();
		expect(snapshot.budgets).toEqual([]);

		const filePath = await temporarySnapshotPath();
		valueOf(await writeSessionSnapshot(filePath, snapshot));
		expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
		expect(await readFile(filePath, "utf8")).toBe(`${canonicalJson(snapshot)}\n`);

		valueOf(
			await context.writer.append({
				type: "turn.started",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "snapshot-tail-turn"),
				payload: {
					turnId: createRuntimeId("turn", "snapshot-tail"),
					goalId: createRuntimeId("goal", "snapshot"),
					queueItemId: createRuntimeId("queueItem", "snapshot"),
				},
			}),
		);
		valueOf(
			await context.writer.append({
				type: "model.requested",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "snapshot-tail-model"),
				payload: {
					turnId: createRuntimeId("turn", "snapshot-tail"),
					requestId: createRuntimeId("modelRequest", "snapshot-tail"),
					modelId: "snapshot",
					contextDigest: DIGEST,
				},
			}),
		);
		valueOf(
			await context.writer.append({
				type: "queue.consumed",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "snapshot-tail"),
				payload: {
					queueItemId: createRuntimeId("queueItem", "snapshot"),
					sourceCommandId: createRuntimeId("command", "snapshot-queue"),
					kind: "follow_up",
					turnId: createRuntimeId("turn", "snapshot-tail"),
					modelRequestId: createRuntimeId("modelRequest", "snapshot-tail"),
					contentDigest: canonicalDigest({ storage: "bounded_text", messageJson: "{}" }),
				},
			}),
		);
		const replay = valueOf(await loadSessionProjection(context.store, filePath));
		expect(replay.source).toBe("snapshot");
		expect(replay.tailEvents.map((event) => event.type)).toEqual(["turn.started", "model.requested", "queue.consumed"]);
		expect(replay.projection.queueItems[0]?.status).toBe("consumed");
		expect(replay.projection.headSequence).toBe(4);
	});

	it("round-trips every ArtifactRef QueueItemV3 field through snapshot schema v3", async () => {
		const context = setup();
		const goalId = createRuntimeId("goal", "snapshot-queue-v3");
		const rootAgentId = createRuntimeId("agent", "snapshot-queue-v3");
		const turnId = createRuntimeId("turn", "snapshot-queue-v3");
		const queueItemId = createRuntimeId("queueItem", "snapshot-queue-v3");
		const sourceCommandId = createRuntimeId("command", "snapshot-queue-v3");
		valueOf(await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-queue-v3-genesis"),
			payload: {
				origin: "test",
				runtimeId: context.runtimeId,
				featureDigest: DIGEST,
				initialGoalId: goalId,
				rootAgentId,
			},
		}));
		valueOf(await context.writer.append({
			type: "turn.started",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-queue-v3-turn"),
			payload: { turnId, goalId },
		}));
		const head = context.writer.currentHead();
		if (!head) throw new Error("fixture head missing");
		const enqueueRevision = { stream: head.stream, sequence: head.sequence, eventHash: head.eventHash };
		const artifact = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			artifactId: createRuntimeId("artifact", "snapshot-queue-v3"),
			storedDigest: "c".repeat(64),
			kind: "tool_output" as const,
			originalSize: 256,
			storedSize: 192,
			mediaType: "application/json",
			redaction: "redacted" as const,
			transformReceipt: createRuntimeId("receipt", "snapshot-queue-v3"),
		};
		const content = { storage: "artifact" as const, artifact };
		const contentDigest = canonicalDigest(content);
		valueOf(await context.writer.append({
			type: "queue.enqueued",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-queue-v3-enqueue"),
			payload: {
				queueItemId,
				sourceCommandId,
				kind: "steer",
				enqueueRevision,
				targetTurnRevision: { turnId, sessionRevision: enqueueRevision },
				nextTurnPolicy: "next_model_turn",
				contentDigest,
				content,
			},
		}));
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(createSessionSnapshot(events, {
			snapshotId: createRuntimeId("snapshot", "queue-v3"),
			activeLeafId: projection.activeLeafId,
			writtenAt: "2026-07-22T00:00:01.000Z",
		}));
		const expectedQueueItem = {
			queueItemId,
			sourceCommandId,
			kind: "steer",
			enqueueRevision,
			targetTurnRevision: { turnId, sessionRevision: enqueueRevision },
			nextTurnPolicy: "next_model_turn",
			contentDigest,
			content,
			status: "enqueued",
			enqueuedSequence: 2,
			claimedSequence: null,
			turnId: null,
			modelRequestId: null,
		};
		expect(snapshot.schemaVersion).toBe(3);
		expect(snapshot.queue).toEqual([expectedQueueItem]);

		const filePath = await temporarySnapshotPath();
		valueOf(await writeSessionSnapshot(filePath, snapshot));
		const restored = valueOf(await readSessionSnapshot(filePath));
		expect(restored?.schemaVersion).toBe(3);
		expect(restored?.queue).toEqual([expectedQueueItem]);
	});

	it("preserves explicit fork goal and root-agent lineage in the disposable snapshot", async () => {
		const context = setup();
		const initialGoalId = createRuntimeId("goal", "snapshot-fork-child");
		const rootAgentId = createRuntimeId("agent", "snapshot-fork-child");
		const parentRootAgentId = createRuntimeId("agent", "snapshot-fork-parent");
		valueOf(await context.writer.append({
			type: "session.forked",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "snapshot-fork"),
			payload: {
				parentSessionId: createRuntimeId("session", "snapshot-fork-parent"),
				parentSequence: 12,
				parentEventHash: DIGEST,
				parentLeafId: createRuntimeId("leaf", "snapshot-fork-parent"),
				goalMode: "create_child_goal",
				initialGoalId,
				rootAgentId,
				parentRootAgentId,
				idempotencyKey: createRuntimeId("command", "snapshot-fork"),
			},
		}));
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(createSessionSnapshot(events, {
			snapshotId: createRuntimeId("snapshot", "fork-lineage"),
			activeLeafId: projection.activeLeafId,
			writtenAt: "2026-07-22T00:00:01.000Z",
		}));
		expect(snapshot).toMatchObject({
			initialGoalId,
			rootAgentId,
			forkGoalMode: "create_child_goal",
			parentRootAgentId,
			goal: { goalId: initialGoalId, phase: null },
		});
		const replay = valueOf(await replaySessionSnapshot(context.store, snapshot));
		expect(replay.projection.genesis).toMatchObject({
			kind: "forked",
			goalMode: "create_child_goal",
			initialGoalId,
			rootAgentId,
			parentRootAgentId,
		});
	});

	it("rejects a self-consistent forged projection digest when the verified prefix disagrees", async () => {
		const context = setup();
		await appendSnapshotPrefix(context);
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(
			createSessionSnapshot(events, {
				snapshotId: createRuntimeId("snapshot", "forged"),
				activeLeafId: projection.activeLeafId,
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		const { snapshotDigest: _snapshotDigest, ...body } = snapshot;
		const forgedBody = { ...body, projectionDigest: "f".repeat(64) };
		const forged: SessionSnapshot = { ...forgedBody, snapshotDigest: canonicalDigest(forgedBody) };
		const replay = await replaySessionSnapshot(context.store, forged);
		expect(replay).toMatchObject({ ok: false, error: { code: "corrupted_log" } });
	});

	it("fails closed on malformed/non-canonical snapshot files and falls back only when no file exists", async () => {
		const context = setup();
		await appendSnapshotPrefix(context);
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(
			createSessionSnapshot(events, {
				snapshotId: createRuntimeId("snapshot", "strict"),
				activeLeafId: projection.activeLeafId,
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		const filePath = await temporarySnapshotPath();
		await mkdir(join(filePath, ".."), { recursive: true });
		await writeFile(filePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
		expect(await readSessionSnapshot(filePath)).toMatchObject({
			ok: false,
			error: { code: "corrupted_log" },
		});

		const missing = join(filePath, "..", "missing.snapshot.json");
		const replay = valueOf(await loadSessionProjection(context.store, missing));
		expect(replay.source).toBe("full");
		expect(replay.snapshot).toBeUndefined();
	});

	it("does not publish a snapshot when atomic rename fails", async () => {
		const context = setup();
		await appendSnapshotPrefix(context);
		const events = valueOf(await readAllRuntimeEvents(context.store));
		const projection = valueOf(reduceSessionEvents(events));
		const snapshot = valueOf(
			createSessionSnapshot(events, {
				snapshotId: createRuntimeId("snapshot", "rename-failure"),
				activeLeafId: projection.activeLeafId,
				writtenAt: "2026-07-22T00:00:01.000Z",
			}),
		);
		const filePath = await temporarySnapshotPath();
		const result = await writeSessionSnapshot(filePath, snapshot, {
			onWritePhase: (phase) => {
				if (phase === "before_rename") {
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				}
			},
		});
		expect(result).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
		await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(valueOf(await loadSessionProjection(context.store, filePath)).source).toBe("full");
	});
});
