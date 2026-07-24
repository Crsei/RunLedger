import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import {
	JournaledPlanContextMemoryControlPlaneAdapter,
	type PlanContextMemoryMutationExecutorPort,
} from "../../../src/runtime/control-plane/plan-context-memory-control-plane.ts";
import type {
	PlanEnterCommandV2,
	PlanInspectQueryV2,
	PlanContextMemoryMutationEffectV2,
} from "../../../src/runtime/control-plane/plan-context-memory-contracts.ts";
import type { ControlPlaneRequestContext } from "../../../src/runtime/control-plane/types.ts";

const authorityId = createRuntimeId("authority", "pcm-adapter");
const tenantId = createRuntimeId("tenant", "pcm-adapter");
const principalId = createRuntimeId("principal", "pcm-adapter");
const sessionId = createRuntimeId("session", "pcm-adapter");
const runtimeId = createRuntimeId("runtime", "pcm-adapter");
const digest = "a".repeat(64);
const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
const handle = { handleId: "handle_0123456789abcdef", sessionId, generation: 4 };
const expectedSessionRevision = { stream, sequence: 2, eventHash: digest };
const durableCursor = {
	stream,
	sequence: 3,
	eventId: createRuntimeId("event", "pcm-effect"),
	eventHash: digest,
};

function command(): PlanEnterCommandV2 {
	return {
		kind: "command",
		type: "plan:enter",
		commandId: createRuntimeId("command", "pcm-enter"),
		idempotencyKey: createIdempotencyKey("pcm-enter-contract-key"),
		authorityId,
		tenantId,
		principalId,
		expectedSessionRevision,
		expectedDomainRevision: 2,
		sessionHandle: handle,
		payload: { sessionId, requestedBy: "user" },
	};
}

function context(): ControlPlaneRequestContext {
	return {
		peer: {
			kind: "local",
			transport: "jsonl",
			pid: 1,
			uid: 1,
			principalId,
			authenticatedVia: "stdio_parent",
		},
		handshake: {
			kind: "handshake_result",
			requestId: "handshake",
			protocol: { major: 1, minor: 1 },
			controlPlaneSchemaVersion: 2,
			runtimeSchemaVersion: 3,
			features: ["plan_context_memory"],
			serverInstanceId: runtimeId,
			remoteAccess: "disabled",
			deliveryGuarantee: "at_least_once",
		},
	};
}

function effect(): PlanContextMemoryMutationEffectV2 {
	const body = {
		type: "plan:enter" as const,
		sessionId,
		domainRevision: 3,
		durableCursor,
		stateKind: "pending_activation" as const,
		modeRevision: 3,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

describe("Journaled Plan/Context/Memory Control Plane adapter", () => {
	it("commits once and replays the canonical effect as duplicate", async () => {
		let calls = 0;
		const mutations: PlanContextMemoryMutationExecutorPort = {
			execute: async () => {
				calls += 1;
				return { ok: true, value: effect() };
			},
		};
		const idempotency = new InMemoryCommandIdempotencyRepository();
		const gate = { assertMutationOpen: () => ({ ok: true as const, value: undefined }) };
		const adapter = new JournaledPlanContextMemoryControlPlaneAdapter({
			handles: { validate: () => ({ ok: true, value: undefined }) },
			mutationGate: gate,
			mutations,
			queries: {
				query: async (query) => ({
					ok: true,
					value: {
						kind: "query_result",
						queryId: query.queryId,
						type: "plan:inspect",
						result: {
							type: "plan:inspect",
							sessionId,
							state: {
								schemaVersion: 1,
								authorityId,
								tenantId,
								sessionId,
								modeRevision: 3,
								updatedByPrincipalId: principalId,
								updatedAt: "2026-07-24T00:00:00.000Z",
								kind: "inactive",
								mode: "default",
							},
							projectionDigest: digest,
						},
					},
				}),
			},
			idempotency,
			runtimeGeneration: () => 4,
		});
		expect(adapter.matchesProductionBinding({
			idempotency,
			mutationGate: gate,
			runtimeGeneration: 4,
		})).toBe(true);
		expect(await adapter.execute(command(), context())).toMatchObject({
			ok: true,
			value: { status: "executed", result: { domainRevision: 3 } },
		});
		expect(await adapter.execute(command(), context())).toMatchObject({
			ok: true,
			value: { status: "duplicate", result: { domainRevision: 3 } },
		});
		expect(calls).toBe(1);
	});

	it("rejects reused idempotency identity and invalid query correlation", async () => {
		const adapter = new JournaledPlanContextMemoryControlPlaneAdapter({
			handles: { validate: () => ({ ok: true, value: undefined }) },
			mutationGate: { assertMutationOpen: () => ({ ok: true, value: undefined }) },
			mutations: { execute: async () => ({ ok: true, value: effect() }) },
			queries: {
				query: async (query) => ({
					ok: true,
					value: {
						kind: "query_result",
						queryId: query.queryId,
						type: "plan:inspect",
						result: {
							type: "plan:inspect",
							sessionId: createRuntimeId("session", "wrong"),
							state: {
								schemaVersion: 1,
								authorityId,
								tenantId,
								sessionId,
								modeRevision: 0,
								updatedByPrincipalId: principalId,
								updatedAt: "2026-07-24T00:00:00.000Z",
								kind: "inactive",
								mode: "default",
							},
							projectionDigest: digest,
						},
					},
				}),
			},
			idempotency: new InMemoryCommandIdempotencyRepository(),
			runtimeGeneration: () => 4,
		});
		expect(await adapter.execute(command(), context())).toMatchObject({ ok: true });
		expect(await adapter.execute({
			...command(),
			payload: { sessionId, requestedBy: "agent" },
		}, context())).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		const query: PlanInspectQueryV2 = {
			kind: "query",
			type: "plan:inspect",
			queryId: "plan-inspect",
			authorityId,
			tenantId,
			principalId,
			payload: { sessionId, sessionHandle: handle },
		};
		expect(await adapter.query(query, context())).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});
});
