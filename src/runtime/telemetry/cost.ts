/** token/USD/time/tool/network/storage/verification/retry/Agent 成本投影。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type {
	AgentId,
	AuthorityId,
	SessionId,
	TenantId,
	ToolCallId,
	VerificationId,
} from "../protocol/v3/ids.ts";
import type { TelemetryResult } from "./types.ts";

export const COST_TRACE_SCHEMA_VERSION = 1 as const;

interface CostObservationContext {
	schemaVersion: typeof COST_TRACE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	agentId: AgentId;
	observedAt: string;
}

export type CostObservation =
	| (CostObservationContext & {
			kind: "model";
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			costUsd: number;
			wallTimeMs: number;
	  })
	| (CostObservationContext & { kind: "tool"; toolCallId: ToolCallId; wallTimeMs: number })
	| (CostObservationContext & {
			kind: "network";
			requestCount: number;
			bytesSent: number;
			bytesReceived: number;
	  })
	| (CostObservationContext & {
			kind: "storage";
			operationCount: number;
			bytesRead: number;
			bytesWritten: number;
			artifactCount?: number;
	  })
	| (CostObservationContext & {
			kind: "verification";
			verificationId: VerificationId;
			wallTimeMs: number;
			costUsd: number;
	  })
	| (CostObservationContext & { kind: "retry"; retryCount: number })
	| (CostObservationContext & { kind: "agent"; wallTimeMs: number })
	| (CostObservationContext & {
			/** canonical budget 事件中的实际计费；不携带价格表或账单正文。 */
			kind: "charge";
			category: "model" | "verification" | "other";
			costUsd: number;
	  });

export type CostTraceUnavailableDimension =
	| "model_usd"
	| "network_bytes_sent"
	| "network_bytes_received"
	| "storage_bytes_read"
	| "verification_usd"
	| "active_operation_wall_time";

export interface AgentCostProjection {
	agentId: AgentId;
	observationCount: number;
	costUsd: number;
	wallTimeMs: number;
}

export interface CostTrace {
	schemaVersion: typeof COST_TRACE_SCHEMA_VERSION;
	projectionKind: "cost_trace";
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	status: "complete" | "partial";
	unavailableDimensions: readonly CostTraceUnavailableDimension[];
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number;
	wallTimeMs: number;
	tool: { callCount: number; wallTimeMs: number };
	network: { requestCount: number; bytesSent: number; bytesReceived: number; bytesTotal: number };
	storage: { operationCount: number; bytesRead: number; bytesWritten: number; bytesTotal: number; artifactCount: number };
	verification: { runCount: number; wallTimeMs: number; costUsd: number };
	retryCount: number;
	agentCount: number;
	byAgent: readonly AgentCostProjection[];
	traceDigest: string;
}

function nonNegativeFinite(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function observationNumbers(observation: CostObservation): readonly number[] {
	switch (observation.kind) {
		case "model": return [observation.inputTokens, observation.outputTokens, observation.cacheReadTokens, observation.cacheWriteTokens, observation.costUsd, observation.wallTimeMs];
		case "tool": return [observation.wallTimeMs];
		case "network": return [observation.requestCount, observation.bytesSent, observation.bytesReceived];
		case "storage": return [observation.operationCount, observation.bytesRead, observation.bytesWritten, observation.artifactCount ?? 0];
		case "verification": return [observation.wallTimeMs, observation.costUsd];
		case "retry": return [observation.retryCount];
		case "agent": return [observation.wallTimeMs];
		case "charge": return [observation.costUsd];
	}
}

export function aggregateCostTrace(observations: readonly CostObservation[]): TelemetryResult<CostTrace> {
	const first = observations[0];
	if (!first) return { ok: false, error: { code: "invalid_schema", message: "cost trace requires observations", retryable: false } };
	const totals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, wallTimeMs: 0,
		toolCalls: 0, toolMs: 0, networkRequests: 0, bytesSent: 0, bytesReceived: 0,
		storageOperations: 0, bytesRead: 0, bytesWritten: 0, artifactCount: 0, verificationRuns: 0,
		verificationMs: 0, verificationUsd: 0, retries: 0,
	};
	const agents = new Map<AgentId, { observationCount: number; costUsd: number; wallTimeMs: number }>();
	for (const observation of observations) {
		if (
			observation.schemaVersion !== COST_TRACE_SCHEMA_VERSION ||
			!Number.isFinite(Date.parse(observation.observedAt)) ||
			observationNumbers(observation).some((value) => !nonNegativeFinite(value))
		) return { ok: false, error: { code: "invalid_schema", message: "cost observation is invalid", retryable: false } };
		if (
			observation.authorityId !== first.authorityId ||
			observation.tenantId !== first.tenantId ||
			observation.sessionId !== first.sessionId
		) return { ok: false, error: { code: "scope_mismatch", message: "cost observation scope mismatch", retryable: false } };
		const agent = agents.get(observation.agentId) ?? { observationCount: 0, costUsd: 0, wallTimeMs: 0 };
		agent.observationCount += 1;
		switch (observation.kind) {
			case "model":
				totals.input += observation.inputTokens; totals.output += observation.outputTokens;
				totals.cacheRead += observation.cacheReadTokens; totals.cacheWrite += observation.cacheWriteTokens;
				totals.costUsd += observation.costUsd; totals.wallTimeMs += observation.wallTimeMs;
				agent.costUsd += observation.costUsd; agent.wallTimeMs += observation.wallTimeMs;
				break;
			case "tool": totals.toolCalls += 1; totals.toolMs += observation.wallTimeMs; totals.wallTimeMs += observation.wallTimeMs; agent.wallTimeMs += observation.wallTimeMs; break;
			case "network": totals.networkRequests += observation.requestCount; totals.bytesSent += observation.bytesSent; totals.bytesReceived += observation.bytesReceived; break;
			case "storage": totals.storageOperations += observation.operationCount; totals.bytesRead += observation.bytesRead; totals.bytesWritten += observation.bytesWritten; totals.artifactCount += observation.artifactCount ?? 0; break;
			case "verification": totals.verificationRuns += 1; totals.verificationMs += observation.wallTimeMs; totals.verificationUsd += observation.costUsd; totals.costUsd += observation.costUsd; totals.wallTimeMs += observation.wallTimeMs; agent.costUsd += observation.costUsd; agent.wallTimeMs += observation.wallTimeMs; break;
			case "retry": totals.retries += observation.retryCount; break;
			case "agent": totals.wallTimeMs += observation.wallTimeMs; agent.wallTimeMs += observation.wallTimeMs; break;
			case "charge":
				totals.costUsd += observation.costUsd;
				agent.costUsd += observation.costUsd;
				if (observation.category === "verification") totals.verificationUsd += observation.costUsd;
				break;
		}
		agents.set(observation.agentId, agent);
	}
	const byAgent = [...agents.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([agentId, value]) => ({ agentId, ...value }));
	const body = {
		schemaVersion: COST_TRACE_SCHEMA_VERSION,
		projectionKind: "cost_trace" as const,
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		sessionId: first.sessionId,
		status: "complete" as const,
		unavailableDimensions: [] as const,
		tokens: { input: totals.input, output: totals.output, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite },
		costUsd: totals.costUsd,
		wallTimeMs: totals.wallTimeMs,
		tool: { callCount: totals.toolCalls, wallTimeMs: totals.toolMs },
		network: { requestCount: totals.networkRequests, bytesSent: totals.bytesSent, bytesReceived: totals.bytesReceived, bytesTotal: totals.bytesSent + totals.bytesReceived },
		storage: { operationCount: totals.storageOperations, bytesRead: totals.bytesRead, bytesWritten: totals.bytesWritten, bytesTotal: totals.bytesRead + totals.bytesWritten, artifactCount: totals.artifactCount },
		verification: { runCount: totals.verificationRuns, wallTimeMs: totals.verificationMs, costUsd: totals.verificationUsd },
		retryCount: totals.retries,
		agentCount: byAgent.length,
		byAgent,
	};
	return { ok: true, value: { ...body, traceDigest: canonicalDigest(body) } };
}
