import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	computeRuntimeEventHash,
	computeRuntimeEventPayloadDigest,
} from "../../../src/runtime/protocol/v3/event-hash.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	BoundedEventSubscription,
	DurableProjectionConsumer,
	EventIdDedupe,
	InMemoryDurableProjectionCheckpointStore,
	type EventSubscriptionSourcePort,
} from "../../../src/runtime/control-plane/subscriptions.ts";
import type { EventSubscriptionRequest } from "../../../src/runtime/control-plane/types.ts";

const AUTHORITY_ID = createRuntimeId("authority", "subscription");
const TENANT_ID = createRuntimeId("tenant", "subscription");
const PRINCIPAL_ID = createRuntimeId("principal", "subscription");
const SESSION_ID = createRuntimeId("session", "subscription");
const TRACE_ID = createRuntimeId("trace", "subscription");
const FEATURE_DIGEST = "f".repeat(64);
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);

function events(): readonly RuntimeEventV3[] {
	const genesisPayload = {
		origin: "test" as const,
		runtimeId: createRuntimeId("runtime", "subscription"),
		featureDigest: FEATURE_DIGEST,
		initialGoalId: createRuntimeId("goal", "subscription"),
		rootAgentId: createRuntimeId("agent", "subscription"),
	};
	const firstInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", "subscription-0"),
		stream: STREAM,
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created" as const,
		previousEventHash: null,
		payloadDigest: computeRuntimeEventPayloadDigest(genesisPayload),
		traceId: TRACE_ID,
	};
	const first = { ...firstInput, currentEventHash: computeRuntimeEventHash(firstInput), payload: genesisPayload };
	const messageJson = JSON.stringify({ role: "user", content: "hello" });
	const messagePayload = { role: "user" as const, messageJson, contentDigest: canonicalDigest({ role: "user", content: "hello" }) };
	const secondInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", "subscription-1"),
		stream: STREAM,
		sequence: 1,
		timestamp: "2026-07-22T00:00:01.000Z",
		type: "conversation.message_recorded" as const,
		previousEventHash: first.currentEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(messagePayload),
		traceId: TRACE_ID,
	};
	const second = { ...secondInput, currentEventHash: computeRuntimeEventHash(secondInput), payload: messagePayload };
	return [first, second];
}

function request(from: RuntimeEventV3 | null, capacity = 8): EventSubscriptionRequest {
	return {
		kind: "subscription",
		type: "events:subscribe",
		subscriptionId: "events-main",
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		sessionHandle: { handleId: "handle_0123456789abcdef", sessionId: SESSION_ID, generation: 1 },
		fromCursor: from
			? { stream: from.stream, sequence: from.sequence, eventId: from.eventId, eventHash: from.currentEventHash }
			: null,
		bufferCapacity: capacity,
	};
}

function source(log: readonly RuntimeEventV3[]): EventSubscriptionSourcePort {
	return {
		subscribe: async function* (_sessionId, afterSequence) {
			for (const event of log) {
				if (event.sequence > afterSequence) yield { event, origin: "replay" as const };
			}
		},
	};
}

describe("at-least-once subscriptions", () => {
	it("redelivers from a stable cursor and lets clients dedupe by eventId without gaps", async () => {
		const log = events();
		const subscription = new BoundedEventSubscription(request(log[0] ?? null), source(log));
		const delivered: RuntimeEventV3[] = [];
		const dedupe = new EventIdDedupe();
		for await (const item of subscription) {
			if (dedupe.accept(item.eventId)) delivered.push(item.event);
		}
		expect(delivered.map((event) => event.sequence)).toEqual([0, 1]);
		expect(dedupe.accept(log[0]?.eventId ?? createRuntimeId("event", "missing"))).toBe(false);
	});

	it("disconnects a slow consumer with a typed retryable error", async () => {
		const subscription = new BoundedEventSubscription(request(null, 1), source(events()));
		await new Promise<void>((resolve) => setImmediate(resolve));
		await expect(subscription.next()).rejects.toMatchObject({ code: "slow_consumer", retryable: true });
	});
});

describe("atomic durable consumer checkpoints", () => {
	it("applies projection and cursor in one CAS and treats redelivery as a duplicate", async () => {
		const store = new InMemoryDurableProjectionCheckpointStore<{ count: number }>(() => ({ count: 0 }));
		const consumer = new DurableProjectionConsumer({
			consumerId: "activity-projection",
			sessionId: SESSION_ID,
			store,
			project: (state) => ({ count: state.count + 1 }),
		});
		const log = events();
		if (!log[0] || !log[1]) throw new Error("fixture is incomplete");
		expect(await consumer.process(log[0])).toEqual({ ok: true, value: "applied" });
		expect(await consumer.process(log[1])).toEqual({ ok: true, value: "applied" });
		expect(await consumer.process(log[1])).toEqual({ ok: true, value: "duplicate" });
		const checkpoint = await store.load("activity-projection", SESSION_ID);
		expect(checkpoint).toMatchObject({
			ok: true,
			value: { revision: 2, cursor: { sequence: 1 }, projection: { count: 2 } },
		});
	});
});
