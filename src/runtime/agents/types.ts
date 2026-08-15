import type { AgentId, SessionId, ToolCallId } from "../protocol/ids.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";

export const SUBAGENT_ROLES = ["research", "review", "qa", "summarize"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const SUBAGENT_CAPABILITIES = [
	"workspace.read",
	"workspace.search",
	"workspace.list",
] as const;
export type SubagentCapability = (typeof SUBAGENT_CAPABILITIES)[number];

export interface SpawnSubagentInput {
	readonly role: SubagentRole;
	readonly objective: string;
	readonly requestedCapabilities?: readonly SubagentCapability[];
	/** 请求只能进一步收窄 effective per-agent ceiling。 */
	readonly budget?: {
		readonly maxModelTurns?: number;
		readonly maxToolCalls?: number;
		readonly maxActiveDurationMs?: number;
	};
	readonly output?: {
		readonly kind: "report";
		readonly maxBytes?: number;
	};
}

export interface SubagentInvocationContext {
	readonly sessionId: SessionId;
	readonly ownerGeneration: number;
	readonly rootAgentId: AgentId;
	readonly parentAgentId: AgentId;
	readonly source: "model_tool" | "domain_command";
	/** 模型工具由 Host 从 toolCallId 派生；domain command 使用已校验 envelope effectId。 */
	readonly effectId: string;
	readonly toolCallId?: ToolCallId;
	readonly signal: AbortSignal;
}

export const AGENT_STATES = [
	"requested",
	"prepared",
	"running",
	"completed",
	"failed",
	"stopped",
	"recovery_required",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const MULTI_AGENT_ERROR_CODES = [
	"invalid_policy",
	"invalid_request",
	"limit_exceeded",
	"idempotency_conflict",
	"unsupported_feature",
	"recovery_required",
	"store_conflict",
	"runtime_unavailable",
] as const;
export type MultiAgentErrorCode = (typeof MULTI_AGENT_ERROR_CODES)[number];

export interface MultiAgentError {
	readonly code: MultiAgentErrorCode;
	readonly message: string;
	readonly path?: string;
}

export type MultiAgentResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: MultiAgentError };

export interface MultiAgentDiagnostic {
	readonly code: MultiAgentErrorCode;
	readonly path: string;
	readonly message: string;
}

export interface MultiAgentLimits {
	readonly maxChildrenPerRoot: number;
	/** 包含 root，且为 session 生命周期累计值。 */
	readonly maxTotalAgents: number;
	readonly maxModelTurnsPerAgent: number;
	readonly maxToolCallsPerAgent: number;
	readonly maxActiveDurationMsPerAgent: number;
	readonly maxReportBytes: number;
}

export interface MultiAgentSettingsSource {
	readonly enabled?: boolean;
	readonly maxChildrenPerRoot?: number;
	readonly maxTotalAgents?: number;
	readonly maxModelTurnsPerAgent?: number;
	readonly maxToolCallsPerAgent?: number;
	readonly maxActiveDurationMsPerAgent?: number;
	readonly maxReportBytes?: number;
}

export interface MultiAgentPolicy {
	readonly enabled: boolean;
	readonly limits: MultiAgentLimits;
}

export interface MultiAgentPolicyResolution {
	readonly policy: MultiAgentPolicy;
	readonly diagnostics: readonly MultiAgentDiagnostic[];
}

export interface ValidatedSpawnSubagentInput {
	readonly role: SubagentRole;
	readonly objective: string;
	readonly requestedCapabilities: readonly SubagentCapability[];
	readonly budget: {
		readonly maxModelTurns: number;
		readonly maxToolCalls: number;
		readonly maxActiveDurationMs: number;
	};
	readonly output: {
		readonly kind: "report";
		readonly maxBytes: number;
	};
}

export interface MultiAgentPolicyReceipt {
	readonly runtimeEnabled: boolean;
	readonly userSourceDigest: RuntimeDigest;
	readonly workspaceSourceDigest: RuntimeDigest;
	readonly effectiveLimits: MultiAgentLimits;
	readonly diagnostics: readonly MultiAgentDiagnostic[];
	readonly resolverVersion: string;
	readonly receiptDigest: RuntimeDigest;
}

export type ChildTerminalReason =
	| "budget_exhausted"
	| "report_limit_exceeded"
	| "cancelled"
	| "runtime_failed"
	| "activation_uncertain"
	| "owner_takeover";

export interface ChildReport {
	readonly agentId: AgentId;
	readonly outcome: "completed" | "failed" | "stopped";
	readonly report: string;
	readonly reportDigest: RuntimeDigest;
	readonly reportBytes: number;
	readonly usage: {
		readonly modelTurns: number;
		readonly toolCalls: number;
		readonly activeDurationMs: number;
	};
	readonly reasonCode?: ChildTerminalReason;
}

export interface Utf8TextValue {
	readonly value: string;
	readonly bytes: number;
}
