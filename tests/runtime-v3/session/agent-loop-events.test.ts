import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import {
	AgentLoopSessionEvents,
	DurableQueueBindingError,
	DurableQueueEnqueueRevisionConflictError,
} from "../../../src/runtime/session/agent-loop-events.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import type { RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import type { StreamFn } from "../../../src/runtime/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function setup() {
	const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
	const sessionId = createRuntimeId("session", "agent-loop-events");
	const stream = createSessionEventStreamRef(identity, sessionId);
	const runtimeId = createRuntimeId("runtime", "agent-loop-events");
	const fence: WriterFence = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		leaseId: createRuntimeId("lease", "agent-loop-events"),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: "agent-loop-events-fence",
	};
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.fencingToken === fence.fencingToken,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence,
	});
	const sessionEvents = new AgentLoopSessionEvents({
		writer,
		principalId: identity.principalId,
		runtimeId,
		featureDigest: DIGEST,
	});
	return { stream, store, writer, sessionEvents };
}

async function allEvents(store: MemoryEventStore): Promise<readonly RuntimeEventV3[]> {
	const page = await store.readPage(store.streamRef(), { limit: 1000 });
	expect(page.ok).toBe(true);
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events;
}

describe("AgentLoopSessionEvents", () => {
	it("rejects stale enqueue and target-turn revisions before queue.enqueued is appended", async () => {
		const stale = setup();
		await stale.sessionEvents.ensureInitialized();
		const staleHead = stale.writer.currentHead();
		if (!staleHead) throw new Error("fixture head missing");
		await stale.sessionEvents.recordMessage({ role: "user", content: [{ type: "text", text: "advance head" }] });
		const staleRevision = {
			stream: staleHead.stream,
			sequence: staleHead.sequence,
			eventHash: staleHead.eventHash,
		};
		await expect(stale.sessionEvents.enqueueWithReceipt(
			"steer",
			{ role: "user", content: [{ type: "text", text: "stale" }] },
			{ enqueueRevision: staleRevision, sourceCommandId: createRuntimeId("command", "stale-enqueue") },
		)).rejects.toBeInstanceOf(DurableQueueEnqueueRevisionConflictError);
		expect((await allEvents(stale.store)).filter((event) => event.type === "queue.enqueued")).toHaveLength(0);

		const targeted = setup();
		await targeted.sessionEvents.ensureInitialized();
		await targeted.sessionEvents.beginTurn();
		const activeHead = targeted.writer.currentHead();
		if (!activeHead) throw new Error("fixture head missing");
		const activeRevision = {
			stream: activeHead.stream,
			sequence: activeHead.sequence,
			eventHash: activeHead.eventHash,
		};
		await expect(targeted.sessionEvents.enqueueWithReceipt(
			"follow_up",
			{ role: "user", content: [{ type: "text", text: "wrong turn" }] },
			{
				enqueueRevision: activeRevision,
				targetTurnRevision: {
					turnId: createRuntimeId("turn", "tampered-target"),
					sessionRevision: activeRevision,
				},
			},
		)).rejects.toBeInstanceOf(DurableQueueBindingError);
		expect((await allEvents(targeted.store)).filter((event) => event.type === "queue.enqueued")).toHaveLength(0);
	});

	it("fails closed without a governed gateway and flushes every tool terminal before the next model request", async () => {
		const context = setup();
		const flush = vi.spyOn(context.store, "flushThrough");
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel, tools: [echoTool] },
			streamFn: mockStreamFn,
			loopConfig: { sessionEvents: context.sessionEvents },
		});

		await agent.prompt("durable fixture");
		const events = await allEvents(context.store);
		const projection = reduceSessionEvents(events);
		expect(projection.ok).toBe(true);
		if (!projection.ok) throw new Error(projection.error.message);
		expect(projection.value.activeTurnId).toBeNull();
		expect(projection.value.activeModelRequestId).toBeNull();
		expect(projection.value.hasUncertainOperations).toBe(false);
		expect(projection.value.turns.every((turn) => turn.status === "finished")).toBe(true);
		expect(projection.value.modelRequests.every((request) => request.status === "finished")).toBe(true);
		expect(projection.value.toolCalls.every((toolCall) => toolCall.status === "failed")).toBe(true);

		const types = events.map((event) => event.type);
		const toolTerminalIndexes = types.flatMap((type, index) =>
			type === "tool.finished" || type === "tool.failed" || type === "tool.interrupted" ? [index] : [],
		);
		const modelRequestIndexes = types.flatMap((type, index) => type === "model.requested" ? [index] : []);
		expect(toolTerminalIndexes.length).toBeGreaterThan(0);
		for (const terminalIndex of toolTerminalIndexes) {
			const nextModelIndex = modelRequestIndexes.find((index) => index > terminalIndex);
			if (nextModelIndex !== undefined) expect(terminalIndex).toBeLessThan(nextModelIndex);
		}
		expect(flush).toHaveBeenCalledTimes(toolTerminalIndexes.length);
	});

	it("binds model.requested to the routed model and final prepared provider context", async () => {
		const context = setup();
		const observed: Array<{ model: Parameters<StreamFn>[0]; context: Parameters<StreamFn>[1] }> = [];
		const stream: StreamFn = (requestModel, requestContext, options) => {
			observed.push({ model: requestModel, context: requestContext });
			return mockStreamFn(requestModel, requestContext, options);
		};
		const agent = new Agent({
			initialState: { systemPrompt: "unprepared", model: mockModel, tools: [echoTool] },
			streamFn: stream,
			loopConfig: {
				sessionEvents: context.sessionEvents,
				prepareModelRequest: (request) => ({
					model: { ...request.model, id: "routed-model" },
					context: { ...request.context, systemPrompt: "governed-final-context" },
				}),
			},
		});

		await agent.prompt("prepared request");
		const events = await allEvents(context.store);
		const requested = events.find((event) => event.type === "model.requested");
		const first = observed[0];
		expect(first).toBeDefined();
		if (!first || requested?.type !== "model.requested") throw new Error("prepared request evidence missing");
		expect(requested.payload.modelId).toBe(`${first.model.provider}/${first.model.id}`);
		expect(requested.payload.contextDigest).toBe(canonicalDigest(JSON.stringify({
			systemPrompt: first.context.systemPrompt ?? "",
			messages: JSON.stringify(first.context.messages),
			tools: (first.context.tools ?? []).map((tool) => tool.name),
		})));
	});

	it("durably pairs queued steering with the turn that consumes it", async () => {
		const context = setup();
		const message = { role: "user", content: [{ type: "text", text: "steer" }] } as const;
		const receipt = await context.sessionEvents.enqueueWithReceipt("steer", message);
		const reference = context.sessionEvents.claimQueueReference(receipt.reference, message);
		const turn = await context.sessionEvents.beginTurn([reference]);
		const model = await context.sessionEvents.beginModelRequest(turn, "mock/model", { messages: [message] });
		await context.sessionEvents.finishModelRequest(model, { ok: true }, { inputTokens: 1, outputTokens: 1 });
		await context.sessionEvents.finishTurn(turn, { ok: true }, "stop");

		const events = await allEvents(context.store);
		expect(events.map((event) => event.type)).toEqual([
			"session.created",
			"queue.enqueued",
			"turn.started",
			"queue.claimed",
			"model.requested",
			"queue.consumed",
			"model.finished",
			"turn.finished",
		]);
		const projection = reduceSessionEvents(events);
		expect(projection).toMatchObject({
			ok: true,
			value: { queueItems: [{ status: "consumed", turnId: turn.turnId }] },
		});
	});

	it("never issues the next model request when the tool-terminal flush barrier fails", async () => {
		const context = setup();
		let modelRequests = 0;
		const stream: StreamFn = (...args) => {
			modelRequests += 1;
			return mockStreamFn(...args);
		};
		vi.spyOn(context.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: { code: "durable_write_failed", message: "injected disk full", retryable: false },
		});
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel, tools: [echoTool] },
			streamFn: stream,
			loopConfig: { sessionEvents: context.sessionEvents },
		});

		await expect(agent.prompt("barrier failure")).rejects.toThrow("durable event barrier failed");
		expect(modelRequests).toBe(1);
		const events = await allEvents(context.store);
		expect(events.filter((event) => event.type === "model.requested")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("tool.failed");
	});

	it("binds identical steer and follow-up bodies by exact queue reference and kind", async () => {
		const context = setup();
		const steerMessage = { role: "user", content: [{ type: "text", text: "same" }] } as const;
		const followMessage = { role: "user", content: [{ type: "text", text: "same" }] } as const;
		const steer = await context.sessionEvents.enqueueWithReceipt("steer", steerMessage);
		const follow = await context.sessionEvents.enqueueWithReceipt("follow_up", followMessage);
		const steerReference = context.sessionEvents.claimQueueReference(steer.reference, steerMessage);
		const followReference = context.sessionEvents.claimQueueReference(follow.reference, followMessage);

		const turn = await context.sessionEvents.beginTurn([followReference]);
		const model = await context.sessionEvents.beginModelRequest(turn, "mock/model", { messages: [followMessage] });
		await context.sessionEvents.finishModelRequest(model, { ok: true }, { inputTokens: 1, outputTokens: 1 });
		await context.sessionEvents.finishTurn(turn, { ok: true }, "stop");

		const events = await allEvents(context.store);
		const claim = events.find((event) => event.type === "queue.claimed");
		const consumed = events.find((event) => event.type === "queue.consumed");
		expect(claim?.payload).toMatchObject({
			queueItemId: follow.queueItemId,
			kind: "follow_up",
		});
		expect(consumed?.payload).toMatchObject({
			queueItemId: follow.queueItemId,
			kind: "follow_up",
		});
		expect(steerReference.status).toBe("pending");
		expect(followReference.status).toBe("consumed");
	});

	it("returns a reserved durable queue item when the run aborts before turn start", async () => {
		const context = setup();
		const queued = { role: "user", content: [{ type: "text", text: "survive abort" }] } as const;
		await context.sessionEvents.enqueue("steer", queued);
		const abort = new AbortController();
		abort.abort();
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel },
			streamFn: mockStreamFn,
			signal: abort.signal,
			loopConfig: { sessionEvents: context.sessionEvents },
		});

		await agent.prompt("new prompt");
		expect(agent.getSteeringMessages()).toEqual([queued]);
		const events = await allEvents(context.store);
		expect(events.some((event) => event.type === "queue.claimed")).toBe(false);
		expect(events.some((event) => event.type === "queue.consumed")).toBe(false);
	});

	it("requires async durable cancellation instead of pretending a synchronous clear succeeded", async () => {
		const context = setup();
		const queued = { role: "user", content: [{ type: "text", text: "cancel me" }] } as const;
		await context.sessionEvents.enqueue("steer", queued);
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel },
			streamFn: mockStreamFn,
			loopConfig: { sessionEvents: context.sessionEvents },
		});

		expect(() => agent.clearAllQueues()).toThrow("requires awaiting cancelAllQueues");
		expect(await agent.cancelAllQueues()).toEqual({ steering: [queued], followUp: [] });
		expect(agent.getSteeringMessages()).toEqual([]);
		const events = await allEvents(context.store);
		expect(events.at(-1)).toMatchObject({
			type: "queue.cancelled",
			payload: { reason: "operator cleared queued messages" },
		});
	});

	it("keeps a message enqueued at turn tail when the stop policy ends the run", async () => {
		const context = setup();
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const delayedStream: StreamFn = async (...args) => {
			markStarted?.();
			await gate;
			return mockStreamFn(...args);
		};
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel, tools: [echoTool] },
			streamFn: delayedStream,
			loopConfig: {
				sessionEvents: context.sessionEvents,
				shouldStopAfterTurn: () => true,
			},
		});

		const active = agent.prompt("initial");
		await started;
		agent.steer("tail message");
		release?.();
		await active;
		await agent.waitForIdle();

		expect(agent.getSteeringMessages()).toEqual([
			{ role: "user", content: [{ type: "text", text: "tail message" }] },
		]);
		const events = await allEvents(context.store);
		const projection = reduceSessionEvents(events);
		expect(projection).toMatchObject({
			ok: true,
			value: { queueItems: [{ kind: "steer", status: "enqueued" }] },
		});
	});

	it("reports a cancellation flush failure and never returns a false cleared snapshot", async () => {
		const context = setup();
		const queued = { role: "user", content: [{ type: "text", text: "uncertain clear" }] } as const;
		await context.sessionEvents.enqueue("steer", queued);
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel },
			streamFn: mockStreamFn,
			loopConfig: { sessionEvents: context.sessionEvents },
		});
		vi.spyOn(context.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: { code: "durable_write_failed", message: "injected cancellation flush failure", retryable: false },
		});

		await expect(agent.cancelAllQueues()).rejects.toThrow("durable event barrier failed");
		expect(agent.getSteeringMessages()).toEqual([queued]);
		expect(await context.sessionEvents.flush()).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed" },
		});
	});

	it("serializes accepted-vs-cancel so exactly one durable outcome wins", async () => {
		const accepted = setup();
		const acceptedMessage = { role: "user", content: [{ type: "text", text: "accepted" }] } as const;
		const acceptedReceipt = await accepted.sessionEvents.enqueueWithReceipt("steer", acceptedMessage);
		const acceptedReference = accepted.sessionEvents.claimQueueReference(
			acceptedReceipt.reference,
			acceptedMessage,
		);
		const turnPromise = accepted.sessionEvents.beginTurn([acceptedReference]);
		const losingCancel = accepted.sessionEvents.cancelQueueReferences([acceptedReference], "race");
		const turn = await turnPromise;
		await expect(losingCancel).rejects.toThrow("already accepted");
		const model = await accepted.sessionEvents.beginModelRequest(turn, "mock/model", {});
		await accepted.sessionEvents.finishModelRequest(model, {}, { inputTokens: 0, outputTokens: 0 });
		await accepted.sessionEvents.finishTurn(turn, {}, "stop");
		const acceptedEvents = await allEvents(accepted.store);
		expect(acceptedEvents.some((event) => event.type === "queue.consumed")).toBe(true);
		expect(acceptedEvents.some((event) => event.type === "queue.cancelled")).toBe(false);

		const cancelled = setup();
		const cancelledMessage = { role: "user", content: [{ type: "text", text: "cancelled" }] } as const;
		const cancelledReceipt = await cancelled.sessionEvents.enqueueWithReceipt("steer", cancelledMessage);
		const cancelledReference = cancelled.sessionEvents.claimQueueReference(
			cancelledReceipt.reference,
			cancelledMessage,
		);
		const winningCancel = cancelled.sessionEvents.cancelQueueReferences([cancelledReference], "race");
		const losingTurn = cancelled.sessionEvents.beginTurn([cancelledReference]);
		await winningCancel;
		await expect(losingTurn).rejects.toThrow("not an exact claimed pending item");
		expect(cancelled.sessionEvents.activeQueueMessages([cancelledMessage])).toEqual([]);
		const cancelledEvents = await allEvents(cancelled.store);
		expect(cancelledEvents.some((event) => event.type === "queue.cancelled")).toBe(true);
		expect(cancelledEvents.some((event) => event.type === "turn.started")).toBe(false);
	});
});
