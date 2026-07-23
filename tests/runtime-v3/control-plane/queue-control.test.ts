import { describe, expect, it, vi } from "vitest";
import { V3InteractiveDurableQueue } from "../../../src/cli/interactive-control-plane.ts";
import { ControlPlaneCommandBus } from "../../../src/runtime/control-plane/command-bus.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import { ControlPlaneQueryService } from "../../../src/runtime/control-plane/query-service.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import type {
	ControlPlaneQueryValue,
	ControlPlaneRequestContext,
	QueueCancelCommand,
	QueueListQuery,
} from "../../../src/runtime/control-plane/types.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type QueueItemId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	AgentLoopSessionEvents,
	DurableQueueBindingError,
} from "../../../src/runtime/session/agent-loop-events.ts";
import { replayDurableQueue } from "../../../src/runtime/session/durable-queue.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import type { UserAgentMessage } from "../../../src/runtime/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "queue-control");
const TENANT_ID = createRuntimeId("tenant", "queue-control");
const PRINCIPAL_ID = createRuntimeId("principal", "queue-control");
const SESSION_ID = createRuntimeId("session", "queue-control");
const RUNTIME_ID = createRuntimeId("runtime", "queue-control");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
const HANDLE = { handleId: "handle_queuecontrol0001", sessionId: SESSION_ID, generation: 1 } as const;

const CONTEXT: ControlPlaneRequestContext = {
	peer: {
		kind: "local",
		transport: "jsonl",
		pid: 101,
		uid: 1000,
		principalId: PRINCIPAL_ID,
		authenticatedVia: "stdio_parent",
	},
	handshake: {
		kind: "handshake_result",
		requestId: "queue-control-handshake",
		protocol: { major: 1, minor: 0 },
		controlPlaneSchemaVersion: 1,
		runtimeSchemaVersion: 3,
		features: ["session", "queue"],
		serverInstanceId: RUNTIME_ID,
		remoteAccess: "disabled",
		deliveryGuarantee: "at_least_once",
	},
};

function message(text: string): UserAgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function setup() {
	const fence: WriterFence = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		leaseId: createRuntimeId("lease", "queue-control"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "queue-control-fence",
	};
	const store = new MemoryEventStore({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		validateFence: (candidate) => candidate.fencingToken === fence.fencingToken,
	});
	const writer = new EventWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: STREAM,
		store,
		fence,
	});
	const sessionEvents = new AgentLoopSessionEvents({
		writer,
		principalId: PRINCIPAL_ID,
		runtimeId: RUNTIME_ID,
		featureDigest: "a".repeat(64),
	});
	const queue = new V3InteractiveDurableQueue({ sessionEvents: () => sessionEvents });
	return { store, writer, sessionEvents, queue };
}

async function runtimeEvents(store: MemoryEventStore) {
	const page = await store.readPage(STREAM, { limit: 1000 });
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events;
}

function query(): QueueListQuery {
	return {
		kind: "query",
		type: "queue:list",
		queryId: "queue-list",
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		payload: { sessionId: SESSION_ID, sessionHandle: HANDLE },
	};
}

function cancelCommand(
	queueRevision: string,
	items: readonly { queueItemId: QueueItemId; kind: "steer" | "follow_up" }[],
	seed = "queue-cancel",
): QueueCancelCommand {
	return {
		kind: "command",
		type: "queue:cancel",
		commandId: createRuntimeId("command", seed),
		idempotencyKey: createIdempotencyKey(`${seed}-idempotency`),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		expectedSessionRevision: {
			stream: STREAM,
			sequence: 0,
			eventHash: "b".repeat(64),
		},
		expectedTurnId: null,
		sessionHandle: HANDLE,
		payload: {
			sessionId: SESSION_ID,
			expectedQueueRevision: queueRevision,
			items,
			reason: "operator cancellation",
		},
	};
}

function queryService(
	execute: (request: QueueListQuery) => Promise<ReturnType<typeof controlPlaneFailure<ControlPlaneQueryValue>> | { ok: true; value: ControlPlaneQueryValue }>,
) {
	return new ControlPlaneQueryService({
		handles: { validate: () => ({ ok: true, value: undefined }) },
		executor: {
			execute: (request) => request.type === "queue:list"
				? execute(request)
				: Promise.resolve(controlPlaneFailure("unsupported_feature", "fixture only serves queue:list")),
		},
	});
}

function commandBus(queue: V3InteractiveDurableQueue) {
	return new ControlPlaneCommandBus({
		idempotency: new InMemoryCommandIdempotencyRepository(),
		stateGuard: { validate: async () => ({ ok: true, value: undefined }) },
		executor: { execute: async () => controlPlaneFailure("unsupported_feature", "fixture") },
		prompts: {
			preflight: async () => controlPlaneFailure("unsupported_feature", "fixture"),
			enqueueDurable: async () => controlPlaneFailure("unsupported_feature", "fixture"),
		},
		approvals: { resolve: async () => controlPlaneFailure("unsupported_feature", "fixture") },
		queues: queue,
		shutdown: new ShutdownCoordinator(),
	});
}

describe("authoritative Control Plane queue", () => {
	it("returns an exact body-bound ordered queue:list and rejects adapter-added fields", async () => {
		const fixture = setup();
		await fixture.sessionEvents.enqueueWithReceipt("steer", message("first"));
		await fixture.sessionEvents.enqueueWithReceipt("follow_up", message("second"));
		const service = queryService((request) => fixture.queue.list(request, CONTEXT));
		const listed = await service.execute(query(), CONTEXT);
		expect(listed).toMatchObject({
			ok: true,
			value: {
				result: {
					type: "queue:list",
					items: [
						{ kind: "steer", status: "pending", message: message("first") },
						{ kind: "follow_up", status: "pending", message: message("second") },
					],
				},
			},
		});

		if (!listed.ok || listed.value.result.type !== "queue:list") throw new Error("queue fixture failed");
		const malformed = queryService(async () => ({
			ok: true,
			value: { ...listed.value.result, adapterPrivateState: true } as unknown as ControlPlaneQueryValue,
		}));
		expect(await malformed.execute(query(), CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});

	it("rejects a stale queue revision without appending cancellation events", async () => {
		const fixture = setup();
		const first = await fixture.sessionEvents.enqueueWithReceipt("steer", message("first"));
		const stale = await fixture.sessionEvents.inspectQueue();
		await fixture.sessionEvents.enqueueWithReceipt("steer", message("revision changed"));
		const result = await fixture.queue.cancel(
			cancelCommand(stale.queueRevision, [{ queueItemId: first.queueItemId, kind: first.reference.kind }]),
			CONTEXT,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "expected_revision_conflict" }, effect: "none" });
		expect((await runtimeEvents(fixture.store)).filter((event) => event.type === "queue.cancelled")).toHaveLength(0);
	});

	it("binds every cancelled item to the exact cancellation command", async () => {
		const fixture = setup();
		const first = await fixture.sessionEvents.enqueueWithReceipt("steer", message("first"));
		const second = await fixture.sessionEvents.enqueueWithReceipt("follow_up", message("second"));
		const snapshot = await fixture.sessionEvents.inspectQueue();
		const command = cancelCommand(snapshot.queueRevision, [
			{ queueItemId: first.queueItemId, kind: first.reference.kind },
			{ queueItemId: second.queueItemId, kind: second.reference.kind },
		], "exact-cancellation-command");

		expect(await fixture.queue.cancel(command, CONTEXT)).toMatchObject({ ok: true });
		const cancelled = (await runtimeEvents(fixture.store)).filter((event) => event.type === "queue.cancelled");
		expect(cancelled).toHaveLength(2);
		expect(cancelled.every((event) => event.payload.cancellationCommandId === command.commandId)).toBe(true);
	});

	it("serializes cancellation against turn claim and model consumption", async () => {
		const fixture = setup();
		const queuedMessage = message("consume wins");
		const receipt = await fixture.sessionEvents.enqueueWithReceipt("steer", queuedMessage);
		const reference = fixture.sessionEvents.claimQueueReference(receipt.reference, queuedMessage);
		const snapshot = await fixture.sessionEvents.inspectQueue();

		const turnPromise = fixture.sessionEvents.beginTurn([reference]);
		const cancellation = fixture.queue.cancel(
			cancelCommand(snapshot.queueRevision, [{ queueItemId: receipt.queueItemId, kind: receipt.reference.kind }], "queue-race"),
			CONTEXT,
		);
		const turn = await turnPromise;
		expect(await cancellation).toMatchObject({
			ok: false,
			error: { code: "expected_revision_conflict" },
		});
		await fixture.sessionEvents.beginModelRequest(turn, "fixture/model", { messages: [queuedMessage] });

		const events = await runtimeEvents(fixture.store);
		expect(events.filter((event) => event.type === "queue.consumed")).toHaveLength(1);
		expect(events.filter((event) => event.type === "queue.cancelled")).toHaveLength(0);
		expect((await fixture.sessionEvents.inspectQueue()).items).toEqual([]);
	});

	it("keeps only the confirmed cancellation prefix and closes the command gate after a partial barrier failure", async () => {
		const fixture = setup();
		const first = await fixture.sessionEvents.enqueueWithReceipt("steer", message("first"));
		const second = await fixture.sessionEvents.enqueueWithReceipt("follow_up", message("second"));
		const snapshot = await fixture.sessionEvents.inspectQueue();
		const realFlush = fixture.store.flushThrough.bind(fixture.store);
		vi.spyOn(fixture.store, "flushThrough")
			.mockImplementationOnce(realFlush)
			.mockResolvedValueOnce({
				ok: false,
				error: { code: "durable_write_failed", message: "injected second cancellation barrier failure", retryable: false },
			});
		const cancel = vi.spyOn(fixture.queue, "cancel");
		const bus = commandBus(fixture.queue);
		const command = cancelCommand(snapshot.queueRevision, [
			{ queueItemId: first.queueItemId, kind: first.reference.kind },
			{ queueItemId: second.queueItemId, kind: second.reference.kind },
		], "partial-cancel");

		expect(await bus.execute(command, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "recovery_required", details: { confirmedCount: 1 } },
			effect: "uncertain",
		});
		expect((await fixture.sessionEvents.inspectQueue()).items).toEqual([
			expect.objectContaining({ queueItemId: second.queueItemId, status: "pending" }),
		]);
		expect(bus.sessionRecoveryState(SESSION_ID)).toMatchObject({ commandId: command.commandId, phase: "effect" });

		const blocked = cancelCommand(
			(await fixture.sessionEvents.inspectQueue()).queueRevision,
			[{ queueItemId: second.queueItemId, kind: second.reference.kind }],
			"blocked-after-partial",
		);
		expect(await bus.execute(blocked, CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "none",
		});
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("replays the same remaining bodies, order, and revision from canonical events", async () => {
		const fixture = setup();
		const first = await fixture.sessionEvents.enqueueWithReceipt("steer", message("first"));
		const second = await fixture.sessionEvents.enqueueWithReceipt("follow_up", message("second"));
		const third = await fixture.sessionEvents.enqueueWithReceipt("steer", message("third"));
		const before = await fixture.sessionEvents.inspectQueue();
		await fixture.sessionEvents.cancelQueueItems(
			before.queueRevision,
			[{ queueItemId: second.queueItemId, kind: second.reference.kind }],
			"remove middle",
			createRuntimeId("command", "replay-cancel"),
		);
		const live = await fixture.sessionEvents.inspectQueue();
		const replay = replayDurableQueue(await runtimeEvents(fixture.store));
		const restored = new AgentLoopSessionEvents({
			writer: fixture.writer,
			principalId: PRINCIPAL_ID,
			runtimeId: RUNTIME_ID,
			featureDigest: "a".repeat(64),
			restoredQueue: replay,
		});
		const restoredSnapshot = await restored.inspectQueue();

		expect(replay.unrecoverable).toEqual([]);
		expect(restoredSnapshot).toEqual(live);
		expect(restoredSnapshot.items.map((item) => item.queueItemId)).toEqual([first.queueItemId, third.queueItemId]);
	});

	it("does not append events for duplicate, unknown, or wrong-kind cancellation targets", async () => {
		const fixture = setup();
		const queued = await fixture.sessionEvents.enqueueWithReceipt("steer", message("keep"));
		const snapshot = await fixture.sessionEvents.inspectQueue();
		await expect(fixture.sessionEvents.cancelQueueItems(
			snapshot.queueRevision,
			[
				{ queueItemId: queued.queueItemId, kind: queued.reference.kind },
				{ queueItemId: queued.queueItemId, kind: queued.reference.kind },
			],
			"duplicate",
			createRuntimeId("command", "duplicate-cancel"),
		)).rejects.toBeInstanceOf(DurableQueueBindingError);
		await expect(fixture.sessionEvents.cancelQueueItems(
			snapshot.queueRevision,
			[{ queueItemId: createRuntimeId("queueItem", "unknown"), kind: "steer" }],
			"unknown",
			createRuntimeId("command", "unknown-cancel"),
		)).rejects.toBeInstanceOf(DurableQueueBindingError);
		expect(await fixture.queue.cancel(
			cancelCommand(snapshot.queueRevision, [{ queueItemId: queued.queueItemId, kind: "follow_up" }], "wrong-kind"),
			CONTEXT,
		)).toMatchObject({ ok: false, error: { code: "invalid_request" }, effect: "none" });
		expect((await runtimeEvents(fixture.store)).filter((event) => event.type === "queue.cancelled")).toHaveLength(0);
	});
});
