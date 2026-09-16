/**
 * Bounded subagent panel 的只读合同。
 *
 * 字段来自 Session domain 的 `agent.inspect`（durable agent graph 投影）：
 * 节点状态、角色、usage、terminal reason 与 lifetime 计数。graph 只保存
 * objective digest 与 bounded report，因此这里不提供 objective/正文——
 * 正文属于父 Session transcript 里的 `spawn_agent` 工具卡。
 *
 * 本模块是 passive contract：只有类型，不持有执行器、计时器或 renderer。
 */

import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText, SafeCount } from "../presentation/tools/types.ts";

/** 无法识别的投影值落 unknown，不猜测成某个具体状态。 */
export type AgentNodeState =
	| "requested"
	| "prepared"
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "recovery_required"
	| "unknown";

export type AgentNodeRole = "root" | "research" | "review" | "qa" | "summarize" | "unknown";

/** `x` 取消需要完整 runtime id，展示宽度由组件自行收敛。 */
export interface AgentNodeView {
	readonly agentId: string;
	readonly role: AgentNodeRole;
	readonly state: AgentNodeState;
	readonly parentAgentId?: string;
	readonly usage: {
		readonly modelTurns: SafeCount;
		readonly toolCalls: SafeCount;
		readonly activeDurationMs: SafeCount;
	};
	readonly reasonCode?: SafeBoundedText;
	readonly reportBytes?: SafeCount;
}

export interface AgentActivityCounts {
	readonly totalAgents: SafeCount;
	readonly nonTerminalChildren: SafeCount;
	readonly remainingLifetimeSlots: SafeCount;
}

export interface AgentActivitySnapshot {
	/** durable agent graph revision；cancel 使用它作为 expectedRevision。 */
	readonly revision: number;
	readonly counts: AgentActivityCounts;
	readonly agents: readonly AgentNodeView[];
}

export type AgentActivityQueryResult = TuiResultEnvelope<AgentActivitySnapshot>;

export type AgentActivityWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: AgentActivitySnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface AgentActivityQueryPort {
	readonly inspect: (input: TuiPortRequest) => Promise<AgentActivityQueryResult>;
}
