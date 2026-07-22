import { describe, expect, it } from "vitest";
import {
	isLegacyRuntimeActivityProjectionV1,
	isRuntimeActivityProjection,
	projectRuntimeActivity,
	RUNTIME_ACTIVITY_SCHEMA_VERSION,
	runtimeActivityProjectionBody,
} from "../../../src/runtime/telemetry/activity.ts";
import { aggregateCostTrace, COST_TRACE_SCHEMA_VERSION, type CostObservation } from "../../../src/runtime/telemetry/cost.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	computeRuntimeEventHash,
	computeRuntimeEventPayloadDigest,
} from "../../../src/runtime/protocol/v3/event-hash.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const authorityId = createRuntimeId("authority", "telemetry");
const tenantId = createRuntimeId("tenant", "telemetry");
const principalId = createRuntimeId("principal", "telemetry");
const sessionId = createRuntimeId("session", "telemetry");
const agentId = createRuntimeId("agent", "telemetry-main");
const nestedAgentId = createRuntimeId("agent", "telemetry-nested");
const goalId = createRuntimeId("goal", "telemetry");
const turnId = createRuntimeId("turn", "telemetry");
const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);

function canonicalActivityEvents(): readonly RuntimeEventV3[] {
	const genesisPayload = {
		origin: "test" as const,
		runtimeId: createRuntimeId("runtime", "telemetry"),
		featureDigest: "f".repeat(64),
		initialGoalId: goalId,
		rootAgentId: agentId,
	};
	const genesisInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		eventId: createRuntimeId("event", "telemetry-0"),
		stream,
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created" as const,
		previousEventHash: null,
		payloadDigest: computeRuntimeEventPayloadDigest(genesisPayload),
		traceId: createRuntimeId("trace", "telemetry-0"),
	};
	const genesis: RuntimeEventEnvelopeV3<"session.created"> = {
		...genesisInput,
		currentEventHash: computeRuntimeEventHash(genesisInput),
		payload: genesisPayload,
	};
	const turnPayload = { turnId, goalId };
	const turnInput = {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		eventId: createRuntimeId("event", "telemetry-1"),
		stream,
		sequence: 1,
		timestamp: "2026-07-22T00:00:01.000Z",
		type: "turn.started" as const,
		previousEventHash: genesis.currentEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(turnPayload),
		traceId: createRuntimeId("trace", "telemetry-1"),
	};
	const turn: RuntimeEventEnvelopeV3<"turn.started"> = {
		...turnInput,
		currentEventHash: computeRuntimeEventHash(turnInput),
		payload: turnPayload,
	};
	return [genesis, turn];
}

describe("RuntimeActivity projection", () => {
	it("projects the canonical v2 event vector and pins its digest", () => {
		const projected = projectRuntimeActivity(canonicalActivityEvents());
		expect(projected).toMatchObject({
			ok: true,
			value: {
				schemaVersion: 2,
				lifecycle: "active",
				status: "active",
				activeGoalIds: [goalId],
				activeTaskIds: [],
				activeTurnId: turnId,
				projectedThroughSequence: 1,
				heartbeat: { observedAt: "2026-07-22T00:00:01.000Z", cursor: { sequence: 1 } },
			},
		});
		if (!projected.ok) throw new Error(projected.error.message);
		expect(projected.value.projectionDigest).toBe("b7caba2a884073bb1ee7ab68b6ca0fd98266472f1b5cae9b8106d586dc364d78");
		expect(projected.value.projectionDigest).toBe(canonicalDigest(runtimeActivityProjectionBody(projected.value)));
		expect(isRuntimeActivityProjection(projected.value)).toBe(true);
		expect(JSON.stringify(projected)).not.toMatch(/prompt|tool output|secret|environment/iu);
	});

	it("keeps v1 read-only and fails closed on invalid canonical chains", () => {
		expect(RUNTIME_ACTIVITY_SCHEMA_VERSION).toBe(2);
		const legacy = {
			schemaVersion: 1,
			projectionKind: "runtime_activity",
			authorityId,
			tenantId,
			principalId,
			sessionId,
			revision: 1,
			status: "idle",
			activeTaskIds: [],
			activeToolCallIds: [],
			nestedAgentIds: [],
			waitingPermissionIds: [],
			heartbeatAt: "2026-07-22T00:00:00.000Z",
			projectedThroughSequence: 0,
			projectionDigest: "a".repeat(64),
		};
		expect(isLegacyRuntimeActivityProjectionV1(legacy)).toBe(true);
		expect(isRuntimeActivityProjection(legacy)).toBe(false);

		const events = canonicalActivityEvents();
		expect(projectRuntimeActivity([...events].reverse())).toMatchObject({
			ok: false,
			error: { code: "out_of_order" },
		});
		const crossTenant = events.map((event, index) => index === 1
			? { ...event, tenantId: createRuntimeId("tenant", "other") } as RuntimeEventV3
			: event);
		expect(projectRuntimeActivity(crossTenant)).toMatchObject({
			ok: false,
			error: { code: "scope_mismatch" },
		});
	});
});

describe("cost trace projection", () => {
	it("aggregates token/USD/time/tool/network/storage/verification/retry dimensions by Agent", () => {
		const context = { schemaVersion: COST_TRACE_SCHEMA_VERSION, authorityId, tenantId, sessionId, agentId, observedAt: "2026-07-22T00:00:00.000Z" } as const;
		const observations: CostObservation[] = [
			{ ...context, kind: "model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 3, costUsd: 0.25, wallTimeMs: 1000 },
			{ ...context, kind: "tool", toolCallId: createRuntimeId("toolCall", "cost"), wallTimeMs: 500 },
			{ ...context, kind: "network", requestCount: 2, bytesSent: 30, bytesReceived: 70 },
			{ ...context, kind: "storage", operationCount: 3, bytesRead: 40, bytesWritten: 60 },
			{ ...context, agentId: nestedAgentId, kind: "verification", verificationId: createRuntimeId("verification", "cost"), wallTimeMs: 700, costUsd: 0.1 },
			{ ...context, kind: "retry", retryCount: 2 },
			{ ...context, agentId: nestedAgentId, kind: "agent", wallTimeMs: 100 },
		];
		const trace = aggregateCostTrace(observations);
		expect(trace).toMatchObject({
			ok: true,
			value: {
				tokens: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 },
				costUsd: 0.35,
				wallTimeMs: 2300,
				tool: { callCount: 1, wallTimeMs: 500 },
				network: { requestCount: 2, bytesSent: 30, bytesReceived: 70 },
				storage: { operationCount: 3, bytesRead: 40, bytesWritten: 60 },
				verification: { runCount: 1, wallTimeMs: 700, costUsd: 0.1 },
				retryCount: 2,
				agentCount: 2,
			},
		});
	});

	it("rejects negative values and mixed tenant observations", () => {
		const base = { schemaVersion: COST_TRACE_SCHEMA_VERSION, authorityId, tenantId, sessionId, agentId, observedAt: "2026-07-22T00:00:00.000Z" } as const;
		expect(aggregateCostTrace([{ ...base, kind: "retry", retryCount: -1 }])).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
		expect(aggregateCostTrace([
			{ ...base, kind: "retry", retryCount: 1 },
			{ ...base, tenantId: createRuntimeId("tenant", "cost-other"), kind: "retry", retryCount: 1 },
		])).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });
	});
});
