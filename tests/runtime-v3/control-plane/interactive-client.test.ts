import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import {
	createSessionEventStreamRef,
	type EventCursor,
	type ExpectedRevision,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type CommandId, type QueueItemId, type TurnId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import {
	createInteractiveControlPlaneComposition,
	type InteractiveControlPlaneRuntimePort,
	type InteractiveControlPlaneState,
	type InteractiveControlPlaneStatePort,
	type InteractiveDurableQueuePort,
} from "../../../src/runtime/control-plane/interactive-client.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import { AgentLoopSessionEvents } from "../../../src/runtime/session/agent-loop-events.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";

const AUTHORITY_ID = createRuntimeId("authority", "interactive-client");
const TENANT_ID = createRuntimeId("tenant", "interactive-client");
const PRINCIPAL_ID = createRuntimeId("principal", "interactive-client");
const SESSION_ID = createRuntimeId("session", "interactive-client");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

function cursor(sequence: number): EventCursor {
	return {
		stream: STREAM,
		sequence,
		eventId: createRuntimeId("event", `interactive-${sequence}`),
		eventHash: sequence.toString(16).padStart(64, "0"),
	};
}

function fakeComposition(options: { failQueue?: boolean; features?: readonly ("turn" | "queue")[] } = {}) {
	let state: InteractiveControlPlaneState = { sessionId: SESSION_ID, revision: cursor(0), activeTurnId: null };
	const acceptedTypes: string[] = [];
	const order: string[] = [];
	const queued: Array<{
		queueItemId: QueueItemId;
		sourceCommandId: CommandId;
		kind: "steer" | "follow_up";
		enqueueRevision: ExpectedRevision;
		targetTurnRevision: { turnId: TurnId; sessionRevision: ExpectedRevision } | null;
		nextTurnPolicy: "next_model_turn" | "after_active_run";
		contentDigest: string;
		content: { storage: "bounded_text"; messageJson: string };
		status: "pending";
		enqueuedSequence: number;
		message: Parameters<InteractiveDurableQueuePort["enqueue"]>[1];
	}> = [];
	const queueRevision = () => canonicalDigest(queued.map(({ message: _message, ...item }) => item));
	const statePort: InteractiveControlPlaneStatePort = {
		inspect: async () => ({ ok: true, value: state }),
	};
	const queue: InteractiveDurableQueuePort = {
		enqueue: async (command, message) => {
			order.push("durable");
			if (options.failQueue) return controlPlaneFailure("durable_enqueue_failed", "injected append failure");
			if (!command.expectedSessionRevision) return controlPlaneFailure("invalid_request", "missing expected revision");
			const enqueueRevision = command.expectedSessionRevision;
			const durableCursor = cursor(state.revision.sequence + 1);
			state = { ...state, revision: durableCursor };
			const queueItemId = createRuntimeId("queueItem");
			queued.push({
				queueItemId,
				sourceCommandId: command.commandId,
				kind: command.type === "turn:followUp" ? "follow_up" : "steer",
				enqueueRevision,
				targetTurnRevision: command.expectedTurnId === null
					? null
					: { turnId: command.expectedTurnId, sessionRevision: enqueueRevision },
				nextTurnPolicy: command.type === "turn:followUp" ? "after_active_run" : "next_model_turn",
				contentDigest: canonicalDigest({ storage: "bounded_text", messageJson: JSON.stringify(message) }),
				content: { storage: "bounded_text", messageJson: JSON.stringify(message) },
				status: "pending",
				enqueuedSequence: durableCursor.sequence,
				message,
			});
			return { ok: true, value: { queueItemId, durableCursor } };
		},
		list: async (query) => ({
			ok: true,
			value: {
				type: "queue:list",
				sessionId: query.payload.sessionId,
				queueRevision: queueRevision(),
				items: queued.map((item) => ({ ...item })),
			},
		}),
		cancel: async (command) => {
			if (command.payload.expectedQueueRevision !== queueRevision()) {
				return controlPlaneFailure("expected_revision_conflict", "stale queue revision");
			}
			const receipts = command.payload.items.map((target) => {
				const index = queued.findIndex((item) => item.queueItemId === target.queueItemId && item.kind === target.kind);
				if (index < 0) throw new Error("missing fake queue item");
				const [item] = queued.splice(index, 1);
				const durableCursor = cursor(state.revision.sequence + 1);
				state = { ...state, revision: durableCursor };
				return {
					queueItemId: target.queueItemId,
					sourceCommandId: item!.sourceCommandId,
					kind: target.kind,
					contentDigest: item!.contentDigest,
					durableCursor,
				};
			});
			return {
				ok: true,
				value: {
					type: "queue:cancel",
					sessionId: command.payload.sessionId,
					previousQueueRevision: command.payload.expectedQueueRevision,
					queueRevision: queueRevision(),
					receipts,
				},
			};
		},
	};
	const runtime: InteractiveControlPlaneRuntimePort = {
		preflight: async () => ({ ok: true, value: undefined }),
		acceptDurablyEnqueued: async (command) => {
			order.push("memory");
			acceptedTypes.push(command.type);
			if (command.type === "turn:start") state = { ...state, activeTurnId: createRuntimeId("turn", "active") };
			return { ok: true, value: { started: Promise.resolve(), completion: Promise.resolve() } };
		},
		interrupt: () => undefined,
		waitForIdle: async () => undefined,
		dispose: () => undefined,
	};
	const composition = createInteractiveControlPlaneComposition({
		scope: { authorityId: AUTHORITY_ID, tenantId: TENANT_ID, principalId: PRINCIPAL_ID },
		sessionId: SESSION_ID,
		serverInstanceId: createRuntimeId("runtime", "interactive-client"),
		features: options.features ?? ["turn", "queue"],
		idempotency: new InMemoryCommandIdempotencyRepository(),
		state: statePort,
		queue,
		runtime,
	});
	return { ...composition, statePort, runtime, acceptedTypes, order, getState: () => state };
}

describe("interactive Control Plane client", () => {
	it("fails closed when the supplied feature evidence does not cover the durable queue", () => {
		expect(() => fakeComposition({ features: ["turn"] })).toThrow(/feature/u);
	});

	it("serializes concurrent submits into one start followed by steer", async () => {
		const fixture = fakeComposition();
		await Promise.all([
			fixture.client.prompt("first"),
			fixture.client.prompt("second"),
		]);
		expect(fixture.acceptedTypes).toEqual(["turn:start", "turn:steer"]);
		expect(fixture.order).toEqual(["durable", "memory", "durable", "memory"]);
	});

	it("does not mutate the runtime when durable enqueue fails", async () => {
		const fixture = fakeComposition({ failQueue: true });
		await expect(fixture.client.prompt("must stay out of memory")).rejects.toMatchObject({
			code: "durable_enqueue_failed",
		});
		expect(fixture.acceptedTypes).toEqual([]);
		expect(fixture.order).toEqual(["durable"]);
	});

	it("deduplicates an exact command before stale-state validation and rejects a new stale command", async () => {
		const fixture = fakeComposition();
		const prompt = {
			storage: "bounded_text" as const,
			text: "retry",
			contentDigest: canonicalDigest({ storage: "bounded_text", text: "retry" }),
		};
		const command = {
			kind: "command" as const,
			type: "turn:start" as const,
			commandId: createRuntimeId("command", "retry"),
			idempotencyKey: createIdempotencyKey("interactive-retry-0001"),
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			expectedSessionRevision: {
				stream: STREAM,
				sequence: 0,
				eventHash: cursor(0).eventHash,
			},
			expectedTurnId: null,
			sessionHandle: fixture.handle,
			payload: { sessionId: SESSION_ID, prompt },
		};
		expect((await fixture.commands.execute(command, fixture.context)).ok).toBe(true);
		const duplicate = await fixture.commands.execute(command, fixture.context);
		expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
		expect(fixture.acceptedTypes).toEqual(["turn:start"]);

		const stale = await fixture.commands.execute({
			...command,
			commandId: createRuntimeId("command", "stale"),
			idempotencyKey: createIdempotencyKey("interactive-stale-0001"),
		}, fixture.context);
		expect(stale).toMatchObject({ ok: false, error: { code: "expected_revision_conflict" } });
	});

	it("lists and durably cancels the exact queued bodies through versioned Control Plane commands", async () => {
		const fixture = fakeComposition();
		await fixture.client.prompt("operator queued body");
		await expect(fixture.client.cancelAllQueues("operator clear")).resolves.toEqual({
			steering: [{ role: "user", content: [{ type: "text", text: "operator queued body" }] }],
			followUp: [],
		});
	});
});

describe("interactive Control Plane v3 event bridge", () => {
	it("binds the accepted first prompt to one durable queue item and consumes it", async () => {
		const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const sessionId = createRuntimeId("session", "interactive-real-events");
		const runtimeId = createRuntimeId("runtime", "interactive-real-events");
		const stream = createSessionEventStreamRef(identity, sessionId);
		const fence: WriterFence = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			stream,
			leaseId: createRuntimeId("lease", "interactive-real-events"),
			ownerRuntimeId: runtimeId,
			writerEpoch: 1,
			fencingToken: "interactive-real-events",
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
			featureDigest: "a".repeat(64),
		});
		await sessionEvents.ensureInitialized();
		const agent = new Agent({
			initialState: { systemPrompt: "fixture", model: mockModel, tools: [echoTool] },
			streamFn: mockStreamFn,
			loopConfig: { sessionEvents },
		});
		const statePort: InteractiveControlPlaneStatePort = {
			inspect: async () => {
				const page = await store.readPage(stream, { limit: 1000 });
				if (!page.ok) return controlPlaneFailure("recovery_required", "fixture replay failed");
				const projection = reduceSessionEvents(page.value.events);
				if (!projection.ok) return controlPlaneFailure("recovery_required", "fixture projection failed");
				const head = writer.currentHead();
				if (!head) return controlPlaneFailure("recovery_required", "fixture head missing");
				return { ok: true, value: { sessionId, revision: head, activeTurnId: projection.value.activeTurnId } };
			},
		};
		const queue: InteractiveDurableQueuePort = {
			enqueue: async (command, message) => {
				if (!command.expectedSessionRevision) {
					return controlPlaneFailure("invalid_request", "fixture requires an expected session revision");
				}
				const kind = command.type === "turn:followUp" ? "follow_up" : "steer";
				const receipt = await sessionEvents.enqueueWithReceipt(kind, message, {
					sourceCommandId: command.commandId,
					enqueueRevision: command.expectedSessionRevision,
					targetTurnRevision: command.expectedTurnId === null
						? null
						: { turnId: command.expectedTurnId, sessionRevision: command.expectedSessionRevision },
					nextTurnPolicy: kind === "follow_up" ? "after_active_run" : "next_model_turn",
				});
				return { ok: true, value: { queueItemId: receipt.queueItemId, durableCursor: receipt.cursor } };
			},
		};
		const runtime: InteractiveControlPlaneRuntimePort = {
			preflight: async () => ({ ok: true, value: undefined }),
			acceptDurablyEnqueued: async (command) => {
				if (command.payload.prompt.storage !== "bounded_text") return controlPlaneFailure("unsupported_feature", "fixture");
				let startedResolve: (() => void) | undefined;
				const started = new Promise<void>((resolve) => { startedResolve = resolve; });
				const unsubscribe = agent.on("turn_start", () => {
					unsubscribe();
					startedResolve?.();
				});
				const completion = agent.prompt(command.payload.prompt.text).then(() => undefined);
				return { ok: true, value: { started, completion } };
			},
			interrupt: () => agent.interrupt(),
			waitForIdle: () => agent.waitForIdle(),
			dispose: () => undefined,
		};
		const composition = createInteractiveControlPlaneComposition({
			scope: { authorityId: identity.authorityId, tenantId: identity.tenantId, principalId: identity.principalId },
			sessionId,
			serverInstanceId: runtimeId,
			features: ["turn", "queue"],
			idempotency: new InMemoryCommandIdempotencyRepository(),
			state: statePort,
			queue,
			runtime,
		});

		await composition.client.prompt("durable first prompt");
		await agent.waitForIdle();
		const page = await store.readPage(stream, { limit: 1000 });
		expect(page.ok).toBe(true);
		if (!page.ok) throw new Error(page.error.message);
		const queueEvents = page.value.events.filter((event) => event.type === "queue.enqueued");
		const turnStarted = page.value.events.find((event) => event.type === "turn.started");
		const consumed = page.value.events.find((event) => event.type === "queue.consumed");
		expect(queueEvents).toHaveLength(1);
		expect(turnStarted?.payload.queueItemId).toBe(queueEvents[0]?.payload.queueItemId);
		expect(consumed?.payload.queueItemId).toBe(queueEvents[0]?.payload.queueItemId);
		expect(page.value.events.indexOf(queueEvents[0]!)).toBeLessThan(page.value.events.indexOf(turnStarted!));
		expect(page.value.events.indexOf(turnStarted!)).toBeLessThan(page.value.events.indexOf(consumed!));
		const projection = reduceSessionEvents(page.value.events);
		expect(projection).toMatchObject({ ok: true, value: { queueItems: [{ status: "consumed" }] } });
	});
});
