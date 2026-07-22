import { describe, expect, it, vi } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createCheckpointEventPlan,
	createLogicalRewindPlan,
	createStableForkPlan,
	projectAtLogicalCheckpoint,
} from "../../../src/runtime/session/checkpoint.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function valueOf<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function setup(seed: string) {
	const authorityId = createRuntimeId("authority", seed);
	const tenantId = createRuntimeId("tenant", seed);
	const principalId = createRuntimeId("principal", seed);
	const sessionId = createRuntimeId("session", seed);
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const runtimeId = createRuntimeId("runtime", seed);
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", seed),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: `${seed}-fence`,
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
	return { authorityId, tenantId, principalId, sessionId, stream, runtimeId, fence, store, writer };
}

async function appendGenesis(context: ReturnType<typeof setup>): Promise<void> {
	valueOf(
		await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", `${context.sessionId}-genesis`),
			payload: {
				origin: "test",
				runtimeId: context.runtimeId,
				featureDigest: DIGEST,
				initialGoalId: createRuntimeId("goal", `${context.sessionId}-root`),
				rootAgentId: createRuntimeId("agent", `${context.sessionId}-root`),
			},
		}),
	);
}

describe("logical checkpoint, fork, and rewind", () => {
	it("binds a checkpoint to the pre-event reducer digest and creates a non-destructive rewind leaf", async () => {
		const context = setup("checkpoint");
		await appendGenesis(context);
		const beforeEvents = valueOf(await readAllRuntimeEvents(context.store));
		const before = valueOf(reduceSessionEvents(beforeEvents));
		const checkpoint = valueOf(
			createCheckpointEventPlan(before, {
				checkpointId: createRuntimeId("checkpoint", "checkpoint"),
				activeLeafId: before.activeLeafId,
				activePlanDigest: DIGEST,
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "checkpoint-create"),
			}),
		);
		expect(checkpoint.checkpoint.cursor).toMatchObject({ sequence: 0, eventHash: before.headEventHash });
		valueOf(await context.writer.append(checkpoint.draft));

		const withCheckpointEvents = valueOf(await readAllRuntimeEvents(context.store));
		const withCheckpoint = valueOf(reduceSessionEvents(withCheckpointEvents));
		expect(withCheckpoint.checkpoints[0]).toMatchObject({
			checkpointId: checkpoint.checkpoint.checkpointId,
			status: "created",
			eventSequence: 0,
			reducerDigest: before.projectionDigest,
		});

		const rewind = valueOf(
			createLogicalRewindPlan(withCheckpointEvents, withCheckpoint, {
				checkpointId: checkpoint.checkpoint.checkpointId,
				fromLeafId: withCheckpoint.activeLeafId,
				toLeafId: createRuntimeId("leaf", "rewound"),
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "checkpoint-rewind"),
			}),
		);
		expect(rewind).toMatchObject({
			targetCursor: { sequence: 0, eventId: before.headEventId, eventHash: before.headEventHash },
			workspaceState: "unchanged",
		});
		expect(rewind.draft.payload).not.toHaveProperty("workspaceRewindReceiptId");
		valueOf(await context.writer.append(rewind.draft));
		const afterEvents = valueOf(await readAllRuntimeEvents(context.store));
		expect(afterEvents.slice(0, withCheckpointEvents.length)).toEqual(withCheckpointEvents);
		const after = valueOf(reduceSessionEvents(afterEvents));
		expect(after.checkpoints[0]).toMatchObject({
			status: "rewound",
			fromLeafId: withCheckpoint.activeLeafId,
			toLeafId: "leaf_rewound",
		});
		expect(after.activeLeafId).toBe("leaf_rewound");
		expect(valueOf(projectAtLogicalCheckpoint(afterEvents, checkpoint.checkpoint)).projectionDigest).toBe(
			before.projectionDigest,
		);
	});

	it("forks only a stable boundary into a distinct event chain without changing the parent", async () => {
		const parent = setup("parent");
		await appendGenesis(parent);
		const parentEvents = valueOf(await readAllRuntimeEvents(parent.store));
		const parentProjection = valueOf(reduceSessionEvents(parentEvents));
		const childSessionId = createRuntimeId("session", "child");
		const fork = valueOf(
			createStableForkPlan(parentProjection, {
				newSessionId: childSessionId,
				parentLeafId: parentProjection.activeLeafId,
				goalMode: "continue_existing_goal",
				initialGoalId: parentProjection.genesis.initialGoalId,
				rootAgentId: createRuntimeId("agent", "child-root"),
				idempotencyKey: createRuntimeId("command", "fork"),
				principalId: parent.principalId,
				traceId: createRuntimeId("trace", "fork"),
			}),
		);

		const childFence: WriterFence = {
			...parent.fence,
			stream: createSessionEventStreamRef({ authorityId: parent.authorityId, tenantId: parent.tenantId }, childSessionId),
			leaseId: createRuntimeId("lease", "child"),
			fencingToken: "child-fence",
		};
		const childStore = new MemoryEventStore({
			authorityId: parent.authorityId,
			tenantId: parent.tenantId,
			stream: childFence.stream,
			validateFence: () => true,
		});
		const childWriter = new EventWriter({
			authorityId: parent.authorityId,
			tenantId: parent.tenantId,
			stream: childFence.stream,
			store: childStore,
			fence: childFence,
			clock: () => new Date("2026-07-22T00:00:01.000Z"),
		});
		const childGenesis = valueOf(await childWriter.append(fork.genesisDraft));
		expect(childGenesis.event).toMatchObject({
			stream: { scope: "session", sessionId: childSessionId },
			sequence: 0,
			previousEventHash: null,
			payload: {
				parentSessionId: parent.sessionId,
				parentSequence: parentProjection.headSequence,
				parentEventHash: parentProjection.headEventHash,
				goalMode: "continue_existing_goal",
				initialGoalId: parentProjection.genesis.initialGoalId,
				rootAgentId: "agent_child-root",
				parentRootAgentId: parentProjection.genesis.rootAgentId,
			},
		});
		expect(childGenesis.event.eventId).not.toBe(parentProjection.headEventId);
		expect(valueOf(await readAllRuntimeEvents(parent.store))).toEqual(parentEvents);
	});

	it("binds explicit child-goal and root-agent lineage and rejects ambiguous identity reuse", async () => {
		const parent = setup("fork-lineage");
		await appendGenesis(parent);
		const projection = valueOf(reduceSessionEvents(valueOf(await readAllRuntimeEvents(parent.store))));
		const childGoalId = createRuntimeId("goal", "fork-lineage-child");
		const childRootAgentId = createRuntimeId("agent", "fork-lineage-child");
		const base = {
			newSessionId: createRuntimeId("session", "fork-lineage-child"),
			parentLeafId: projection.activeLeafId,
			idempotencyKey: createRuntimeId("command", "fork-lineage"),
			principalId: parent.principalId,
			traceId: createRuntimeId("trace", "fork-lineage"),
		};
		const child = valueOf(createStableForkPlan(projection, {
			...base,
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
			rootAgentId: childRootAgentId,
		}));
		expect(child).toMatchObject({
			goalMode: "create_child_goal",
			initialGoalId: childGoalId,
			rootAgentId: childRootAgentId,
			parentRootAgentId: projection.genesis.rootAgentId,
		});
		expect(createStableForkPlan(projection, {
			...base,
			goalMode: "continue_existing_goal",
			initialGoalId: childGoalId,
			rootAgentId: childRootAgentId,
		})).toMatchObject({ ok: false, error: { code: "invalid_event" } });
		expect(createStableForkPlan(projection, {
			...base,
			goalMode: "continue_existing_goal",
			initialGoalId: projection.genesis.initialGoalId,
			rootAgentId: projection.genesis.rootAgentId,
		})).toMatchObject({ ok: false, error: { code: "invalid_event" } });
	});

	it("rejects checkpoint and fork while a turn is active", async () => {
		const context = setup("unstable");
		await appendGenesis(context);
		valueOf(
			await context.writer.append({
				type: "turn.started",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "unstable-turn"),
				payload: {
					turnId: createRuntimeId("turn", "unstable"),
					goalId: createRuntimeId("goal", "unstable"),
				},
			}),
		);
		const projection = valueOf(reduceSessionEvents(valueOf(await readAllRuntimeEvents(context.store))));
		expect(
			createCheckpointEventPlan(projection, {
				checkpointId: createRuntimeId("checkpoint", "unstable"),
				activeLeafId: createRuntimeId("leaf", "unstable"),
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "unstable-checkpoint"),
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_event" } });
		expect(
			createStableForkPlan(projection, {
				newSessionId: createRuntimeId("session", "unstable-child"),
				parentLeafId: createRuntimeId("leaf", "unstable"),
				goalMode: "create_child_goal",
				initialGoalId: createRuntimeId("goal", "unstable-child"),
				rootAgentId: createRuntimeId("agent", "unstable-child"),
				idempotencyKey: createRuntimeId("command", "unstable"),
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "unstable-fork"),
			}),
		).toMatchObject({ ok: false, error: { code: "invalid_event" } });
	});

	it("fails closed when the mandatory checkpoint flush cannot be confirmed", async () => {
		const context = setup("checkpoint-flush");
		await appendGenesis(context);
		const before = valueOf(reduceSessionEvents(valueOf(await readAllRuntimeEvents(context.store))));
		const checkpoint = valueOf(
			createCheckpointEventPlan(before, {
				checkpointId: createRuntimeId("checkpoint", "flush-failure"),
				activeLeafId: before.activeLeafId,
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "checkpoint-flush-failure"),
			}),
		);
		vi.spyOn(context.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: { code: "durable_write_failed", message: "injected disk full", retryable: false },
		});

		expect(await context.writer.append(checkpoint.draft)).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed" },
		});
		// append 已被 store 接受但 flush receipt 丢失；head 必须保留 uncertain cursor，不能伪装未提交。
		expect(context.writer.currentHead()).toMatchObject({ sequence: 1 });
		expect(
			await context.writer.append({
				type: "session.closed",
				principalId: context.principalId,
				traceId: createRuntimeId("trace", "after-checkpoint-flush-failure"),
				payload: { reason: "test" },
			}),
		).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
	});
});
