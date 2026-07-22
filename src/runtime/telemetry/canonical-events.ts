/** 从严格 Runtime v3 event chain 重建 activity 与多维 cost；不读取 prompt/tool output。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type AgentId,
	type ModelRequestId,
	type RuntimeId,
	type RuntimeIdKind,
	type SessionId,
	type ToolCallId,
	type VerificationId,
} from "../protocol/v3/ids.ts";
import { budgetTruthFromCanonicalEvents } from "../orchestrator/canonical-journals.ts";
import {
	projectBudgetSnapshotFromJournal,
	zeroBudgetVector,
	type BudgetVector,
} from "../orchestrator/budget-guard.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import {
	projectRuntimeActivity,
	type RuntimeActivityResult,
	type RuntimeActivityState,
} from "./activity.ts";
import {
	aggregateCostTrace,
	COST_TRACE_SCHEMA_VERSION,
	type CostObservation,
	type CostTrace,
	type CostTraceUnavailableDimension,
} from "./cost.ts";
import type { TelemetryResult } from "./types.ts";

function failure(
	message: string,
	code: "invalid_schema" | "scope_mismatch" | "out_of_order" = "invalid_schema",
): TelemetryResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function typedId<K extends RuntimeIdKind>(kind: K, value: string): RuntimeId<K> {
	const parsed = parseRuntimeId(kind, value);
	if (!parsed) throw new Error(`validated canonical event contains an invalid ${kind} id`);
	return parsed;
}

function validateCanonicalEvents(events: readonly RuntimeEventV3[]): TelemetryResult<RuntimeEventV3> {
	const first = events[0];
	if (!first) return failure("canonical telemetry projection requires at least one event");
	if (first.stream.scope !== "session") return failure("canonical telemetry projection requires a session stream", "scope_mismatch");
	const verified = verifyRuntimeEventChain(events, {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
	});
	if (verified.integrity !== "valid") {
		const code = verified.error?.code === "identity_mismatch"
			? "scope_mismatch"
			: verified.error?.code === "sequence_conflict"
				? "out_of_order"
				: "invalid_schema";
		return failure("canonical telemetry projection rejected an invalid event chain", code);
	}
	return { ok: true, value: first };
}

function eventSessionId(event: RuntimeEventV3): SessionId {
	if (event.stream.scope !== "session") throw new Error("canonical telemetry event is not session scoped");
	return event.stream.sessionId;
}

/** Telemetry 与 daemon/replay 共用同一个 projector，成功结果和 digest 必须逐字段相同。 */
export function projectRuntimeActivityFromCanonicalEvents(
	events: readonly RuntimeEventV3[],
): RuntimeActivityResult<RuntimeActivityState> {
	return projectRuntimeActivity(events);
}

interface TimedOperation<TId extends string> {
	id: TId;
	startedAt: string;
	agentId: AgentId;
}

function elapsed(startedAt: string, finishedAt: string): number | undefined {
	const duration = Date.parse(finishedAt) - Date.parse(startedAt);
	return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function deterministicRootAgentId(sessionId: SessionId): AgentId {
	return createRuntimeId("agent", canonicalDigest({ sessionId, role: "root" }).slice(0, 32));
}

interface ProductionBudgetProjection {
	found: boolean;
	actual: BudgetVector;
}

function productionBudgetProjection(events: readonly RuntimeEventV3[]): TelemetryResult<ProductionBudgetProjection> {
	const truth = budgetTruthFromCanonicalEvents(events);
	if (!truth.ok) return failure(truth.error.message);
	if (!truth.value.goalId) return { ok: true, value: { found: false, actual: zeroBudgetVector() } };
	const projected = projectBudgetSnapshotFromJournal(truth.value.goalId, truth.value.journal);
	if (!projected.ok) return failure(projected.error.message);
	return { ok: true, value: { found: true, actual: projected.value.committed } };
}
function finalizedCostTrace(
	trace: CostTrace,
	unavailableDimensions: readonly CostTraceUnavailableDimension[],
): CostTrace {
	const { traceDigest: _traceDigest, ...previousBody } = trace;
	const body = {
		...previousBody,
		status: unavailableDimensions.length === 0 ? "complete" as const : "partial" as const,
		unavailableDimensions: [...new Set(unavailableDimensions)].sort(),
	};
	return { ...body, traceDigest: canonicalDigest(body) };
}

/**
 * canonical payload 能证明 token、操作次数、Artifact 写入量与 event timestamp 时长。
 * 价格、网络 byte 和读取 byte 若无 canonical receipt 则显式标 partial，禁止猜测。
 */
export function projectCostTraceFromCanonicalEvents(
	events: readonly RuntimeEventV3[],
	options: { rootAgentId?: AgentId } = {},
): TelemetryResult<CostTrace> {
	const validated = validateCanonicalEvents(events);
	if (!validated.ok) return validated;
	const first = validated.value;
	const discoveredRoot = events.find((event) => event.type === "tool.requested");
	const rootAgentId = options.rootAgentId ??
		(discoveredRoot?.type === "tool.requested" ? typedId("agent", discoveredRoot.payload.agentId) : deterministicRootAgentId(eventSessionId(first)));
	const context = {
		schemaVersion: COST_TRACE_SCHEMA_VERSION,
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		sessionId: eventSessionId(first),
	} as const;
	const productionBudget = productionBudgetProjection(events);
	if (!productionBudget.ok) return productionBudget;
	const observations: CostObservation[] = [{
		...context,
		agentId: rootAgentId,
		observedAt: first.timestamp,
		kind: "agent",
		wallTimeMs: 0,
	}];
	const models = new Map<ModelRequestId, TimedOperation<ModelRequestId>>();
	const tools = new Map<ToolCallId, TimedOperation<ToolCallId>>();
	const verifications = new Map<VerificationId, TimedOperation<VerificationId>>();
	const agents = new Map<AgentId, TimedOperation<AgentId>>();
	let modelChargeRecorded = false;
	let verificationChargeRecorded = false;
	let networkObserved = false;
	let storageObserved = false;
	let activeOperation = false;

	for (const event of events) {
		switch (event.type) {
			case "model.requested":
				models.set(typedId("modelRequest", event.payload.requestId), { id: typedId("modelRequest", event.payload.requestId), startedAt: event.timestamp, agentId: rootAgentId });
				observations.push({ ...context, agentId: rootAgentId, observedAt: event.timestamp, kind: "network", requestCount: 1, bytesSent: 0, bytesReceived: 0 });
				networkObserved = true;
				break;
			case "model.finished": {
				const started = models.get(typedId("modelRequest", event.payload.requestId));
				const wallTimeMs = started ? elapsed(started.startedAt, event.timestamp) : undefined;
				if (!started || wallTimeMs === undefined) return failure("model terminal event has no valid projection start");
				observations.push({
					...context, agentId: started.agentId, observedAt: event.timestamp, kind: "model",
					inputTokens: event.payload.inputTokens, outputTokens: event.payload.outputTokens,
					cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, wallTimeMs,
				});
				models.delete(typedId("modelRequest", event.payload.requestId));
				break;
			}
			case "model.failed": {
				const started = models.get(typedId("modelRequest", event.payload.requestId));
				const wallTimeMs = started ? elapsed(started.startedAt, event.timestamp) : undefined;
				if (!started || wallTimeMs === undefined) return failure("failed model event has no valid projection start");
				observations.push({
					...context, agentId: started.agentId, observedAt: event.timestamp, kind: "model",
					inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
					costUsd: 0, wallTimeMs,
				});
				observations.push({ ...context, agentId: started.agentId, observedAt: event.timestamp, kind: "retry", retryCount: 1 });
				models.delete(typedId("modelRequest", event.payload.requestId));
				break;
			}
			case "tool.requested":
				tools.set(typedId("toolCall", event.payload.toolCallId), { id: typedId("toolCall", event.payload.toolCallId), startedAt: event.timestamp, agentId: typedId("agent", event.payload.agentId) });
				break;
			case "tool.started": {
				const requested = tools.get(typedId("toolCall", event.payload.toolCallId));
				if (!requested) return failure("tool start has no projection request");
				tools.set(typedId("toolCall", event.payload.toolCallId), { ...requested, startedAt: event.timestamp });
				break;
			}
			case "tool.finished":
			case "tool.interrupted":
			case "tool.failed": {
				const started = tools.get(typedId("toolCall", event.payload.toolCallId));
				const wallTimeMs = started ? elapsed(started.startedAt, event.timestamp) : undefined;
				if (!started || wallTimeMs === undefined) return failure("tool terminal event has no valid projection start");
				observations.push({ ...context, agentId: started.agentId, observedAt: event.timestamp, kind: "tool", toolCallId: started.id, wallTimeMs });
				tools.delete(typedId("toolCall", event.payload.toolCallId));
				break;
			}
			case "artifact.committed":
				observations.push({
					...context, agentId: rootAgentId, observedAt: event.timestamp, kind: "storage",
					operationCount: 1, bytesRead: 0, bytesWritten: event.payload.storedSize, artifactCount: 1,
				});
				storageObserved = true;
				break;
			case "verification.started":
				verifications.set(typedId("verification", event.payload.verificationId), { id: typedId("verification", event.payload.verificationId), startedAt: event.timestamp, agentId: rootAgentId });
				break;
			case "verification.finished": {
				const started = verifications.get(typedId("verification", event.payload.verificationId));
				const wallTimeMs = started ? elapsed(started.startedAt, event.timestamp) : undefined;
				if (!started || wallTimeMs === undefined) return failure("verification terminal event has no valid projection start");
				observations.push({
					...context, agentId: started.agentId, observedAt: event.timestamp, kind: "verification",
					verificationId: started.id, wallTimeMs, costUsd: 0,
				});
				verifications.delete(typedId("verification", event.payload.verificationId));
				break;
			}
			case "agent.spawned":
				agents.set(event.payload.node.agentId, { id: event.payload.node.agentId, startedAt: event.timestamp, agentId: event.payload.node.agentId });
				break;
			case "agent.stopped":
			case "agent.partial_committed":
			case "agent.finished":
			case "agent.failed": {
				const started = agents.get(typedId("agent", event.payload.agentId));
				const wallTimeMs = started ? elapsed(started.startedAt, event.timestamp) : undefined;
				if (!started || wallTimeMs === undefined) return failure("agent terminal event has no valid projection start");
				observations.push({ ...context, agentId: started.agentId, observedAt: event.timestamp, kind: "agent", wallTimeMs });
				agents.delete(typedId("agent", event.payload.agentId));
				break;
			}
			default:
				break;
		}
	}
	activeOperation = models.size + tools.size + verifications.size + agents.size > 0;
	if (productionBudget.value.found && productionBudget.value.actual.usdMicros > 0) {
		observations.push({
			...context,
			agentId: rootAgentId,
			observedAt: events.at(-1)?.timestamp ?? first.timestamp,
			kind: "charge",
			category: "other",
			costUsd: productionBudget.value.actual.usdMicros / 1_000_000,
		});
	}
	const aggregated = aggregateCostTrace(observations);
	if (!aggregated.ok) return aggregated;
	let trace = aggregated.value;
	if (productionBudget.value.found) {
		const actual = productionBudget.value.actual;
		const { traceDigest: _traceDigest, ...previousBody } = trace;
		const body = {
			...previousBody,
			tokens: {
				input: actual.inputTokens,
				output: actual.outputTokens,
				cacheRead: previousBody.tokens.cacheRead,
				cacheWrite: previousBody.tokens.cacheWrite,
			},
			costUsd: actual.usdMicros / 1_000_000,
			wallTimeMs: actual.wallTimeMs,
			tool: { ...previousBody.tool, callCount: actual.toolCalls },
			network: { ...previousBody.network, bytesTotal: actual.networkBytes },
			storage: {
				...previousBody.storage,
				bytesTotal: actual.storageBytes,
				artifactCount: actual.artifactCount,
			},
			verification: { ...previousBody.verification, runCount: actual.verifications },
			retryCount: actual.retries,
		};
		trace = { ...body, traceDigest: canonicalDigest(body) };
		if (actual.networkBytes > 0) networkObserved = true;
		if (actual.storageBytes > 0 || actual.artifactCount > 0) storageObserved = true;
	}
	const unavailable: CostTraceUnavailableDimension[] = [];
	if (events.some((event) => event.type === "model.finished" || event.type === "model.failed") && !modelChargeRecorded) unavailable.push("model_usd");
	if (events.some((event) => event.type === "verification.finished") && !verificationChargeRecorded) unavailable.push("verification_usd");
	if (networkObserved) unavailable.push("network_bytes_sent", "network_bytes_received");
	if (storageObserved || events.some((event) => event.type === "tool.finished")) unavailable.push("storage_bytes_read");
	if (activeOperation) unavailable.push("active_operation_wall_time");
	return { ok: true, value: finalizedCostTrace(trace, unavailable) };
}
