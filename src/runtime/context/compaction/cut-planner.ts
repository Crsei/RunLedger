/**
 * Manual compaction 的纯 cut planner。
 *
 * 它只决定哪些完整 turn 可以进入 summary 输入，不执行摘要生成、事件写入或
 * projection 替换。遇到不稳定 turn 或未配对 tool batch 时保守地不切，避免
 * checkpoint 包含孤立的 tool call/result。
 */

import type { AgentMessage } from "../../types.ts";

export interface CompactionTurn {
	readonly turnId: string;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly stable: boolean;
	readonly toolCallIds: readonly string[];
	readonly toolResultIds: readonly string[];
}

export type CompactionCutPlan =
	| {
			readonly kind: "cut";
			readonly startSequence: number;
			readonly endSequence: number;
			readonly compactedTurnIds: readonly string[];
			readonly retainedTurnIds: readonly string[];
	  }
	| {
			readonly kind: "no_cut";
			readonly reason: "disabled" | "insufficient_history" | "unstable_or_incomplete_prefix";
	  };

export interface CompactionPolicy {
	readonly enabled: boolean;
	readonly midTurnEnabled: boolean;
	readonly strategy: "off" | "summary";
	readonly thresholdPercent: number;
	readonly thresholdTokens: number;
	readonly retainRecentTurns: number;
	readonly minCompactedTurns: number;
}

export type CompactionTriggerReason = "threshold" | "overflow" | "model_switch" | "manual";
type CompactionNoCutReason = Extract<CompactionCutPlan, { readonly kind: "no_cut" }>["reason"];

export interface CompactionTriggerInput {
	readonly policy: CompactionPolicy;
	readonly contextWindow: number;
	readonly estimatedInputTokens: number;
	readonly midTurn: boolean;
	readonly reason: CompactionTriggerReason;
}

export type CompactionTriggerDecision =
	| {
			readonly shouldCompact: true;
			readonly reason: CompactionTriggerReason;
			readonly thresholdTokens: number;
		}
	| {
			readonly shouldCompact: false;
			readonly reason: CompactionTriggerReason;
			readonly blockedReason: "disabled" | "mid_turn_disabled" | "below_threshold" | "invalid_budget";
			readonly thresholdTokens?: number;
		};

export interface CompactMessagesInput {
	readonly messages: readonly AgentMessage[];
	readonly policy: CompactionPolicy;
	readonly contextWindow: number;
	readonly estimatedInputTokens: number;
	readonly midTurn: boolean;
	readonly reason: CompactionTriggerReason;
	readonly summarize: (input: {
		readonly compactedMessages: readonly AgentMessage[];
		readonly cut: Extract<CompactionCutPlan, { readonly kind: "cut" }>;
		readonly reason: CompactionTriggerReason;
	}) => string | Promise<string | undefined> | undefined;
}

export type CompactMessagesResult =
	| {
			readonly status: "not_needed" | "not_available";
			readonly originalMessages: readonly AgentMessage[];
			readonly projectedMessages: readonly AgentMessage[];
			readonly decision: CompactionTriggerDecision;
			readonly plan?: CompactionCutPlan;
			readonly unavailableReason?: "summary_unavailable" | CompactionNoCutReason;
		}
	| {
			readonly status: "compacted";
			readonly originalMessages: readonly AgentMessage[];
			readonly projectedMessages: readonly AgentMessage[];
			readonly decision: Extract<CompactionTriggerDecision, { readonly shouldCompact: true }>;
			readonly plan: Extract<CompactionCutPlan, { readonly kind: "cut" }>;
			readonly summary: string;
		};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = Object.freeze({
	enabled: true,
	midTurnEnabled: false,
	strategy: "summary",
	thresholdPercent: 80,
	thresholdTokens: 0,
	retainRecentTurns: 1,
	minCompactedTurns: 1,
});

/**
 * 统一判断 threshold/overflow/model-switch/manual 入口是否可以启动 compact。
 * thresholdPercent 与 thresholdTokens 都是上限候选，较早达到的候选触发，
 * 未配置 thresholdTokens 时只使用百分比阈值。
 */
export function evaluateCompactionTrigger(input: CompactionTriggerInput): CompactionTriggerDecision {
	const { policy, contextWindow, estimatedInputTokens, midTurn, reason } = input;
	if (!policy.enabled || policy.strategy === "off") return { shouldCompact: false, reason, blockedReason: "disabled" };
	if (midTurn && !policy.midTurnEnabled) return { shouldCompact: false, reason, blockedReason: "mid_turn_disabled" };
	if (!Number.isSafeInteger(contextWindow) || contextWindow < 1 || !Number.isSafeInteger(estimatedInputTokens) || estimatedInputTokens < 0) {
		return { shouldCompact: false, reason, blockedReason: "invalid_budget" };
	}
	const percentThreshold = Math.max(1, Math.ceil(contextWindow * policy.thresholdPercent / 100));
	const candidates = [percentThreshold];
	if (policy.thresholdTokens > 0) candidates.push(policy.thresholdTokens);
	const thresholdTokens = Math.min(...candidates);
	if (reason !== "threshold" || estimatedInputTokens >= thresholdTokens) return { shouldCompact: true, reason, thresholdTokens };
	return { shouldCompact: false, reason, blockedReason: "below_threshold", thresholdTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** 将 effective settings 的 partial group 投影为受限、不可变的 compaction policy。 */
export function resolveCompactionPolicy(input: unknown): CompactionPolicy {
	if (!isRecord(input)) return DEFAULT_COMPACTION_POLICY;
	const enabled = input.enabled;
	const midTurnEnabled = input.midTurnEnabled;
	const strategy = input.strategy;
	const thresholdPercent = input.thresholdPercent;
	const thresholdTokens = input.thresholdTokens;
	const retainRecentTurns = input.retainRecentTurns;
	const minCompactedTurns = input.minCompactedTurns;
	if (enabled !== undefined && typeof enabled !== "boolean") return DEFAULT_COMPACTION_POLICY;
	if (midTurnEnabled !== undefined && typeof midTurnEnabled !== "boolean") return DEFAULT_COMPACTION_POLICY;
	if (strategy !== undefined && strategy !== "off" && strategy !== "summary") return DEFAULT_COMPACTION_POLICY;
	if (thresholdPercent !== undefined && !boundedInteger(thresholdPercent, 1, 100)) return DEFAULT_COMPACTION_POLICY;
	if (thresholdTokens !== undefined && !boundedInteger(thresholdTokens, 0, 16_000_000)) return DEFAULT_COMPACTION_POLICY;
	if (retainRecentTurns !== undefined && !boundedInteger(retainRecentTurns, 1, 10_000)) return DEFAULT_COMPACTION_POLICY;
	if (minCompactedTurns !== undefined && !boundedInteger(minCompactedTurns, 1, 10_000)) return DEFAULT_COMPACTION_POLICY;
	return Object.freeze({
		enabled: enabled === undefined ? DEFAULT_COMPACTION_POLICY.enabled : enabled,
		midTurnEnabled: midTurnEnabled === undefined ? DEFAULT_COMPACTION_POLICY.midTurnEnabled : midTurnEnabled,
		strategy: strategy === undefined ? DEFAULT_COMPACTION_POLICY.strategy : strategy,
		thresholdPercent: thresholdPercent === undefined ? DEFAULT_COMPACTION_POLICY.thresholdPercent : thresholdPercent,
		thresholdTokens: thresholdTokens === undefined ? DEFAULT_COMPACTION_POLICY.thresholdTokens : thresholdTokens,
		retainRecentTurns: retainRecentTurns === undefined ? DEFAULT_COMPACTION_POLICY.retainRecentTurns : retainRecentTurns,
		minCompactedTurns: minCompactedTurns === undefined ? DEFAULT_COMPACTION_POLICY.minCompactedTurns : minCompactedTurns,
	});
}

export interface CompactionCutOptions {
	/** 至少保留多少个最新 turn，默认 1。 */
	readonly retainRecentTurns?: number;
	/** 至少要压缩多少个完整 turn，默认 1。 */
	readonly minCompactedTurns?: number;
	/** 同一份 effective policy；显式 legacy 参数只作为兼容覆写。 */
	readonly policy?: CompactionPolicy;
}

export class CompactionCutPlanningError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "CompactionCutPlanningError";
	}
}

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new CompactionCutPlanningError(`${name} must be a positive safe integer`);
	}
}

function assertTurnShape(turn: CompactionTurn, previous: CompactionTurn | undefined, ids: Set<string>): void {
	if (turn.turnId.length === 0 || ids.has(turn.turnId)) {
		throw new CompactionCutPlanningError("turn ids must be non-empty and unique");
	}
	if (!Number.isSafeInteger(turn.startSequence) || !Number.isSafeInteger(turn.endSequence) || turn.startSequence < 0 || turn.endSequence < turn.startSequence) {
		throw new CompactionCutPlanningError("turn sequence range is invalid");
	}
	if (previous !== undefined && turn.startSequence <= previous.endSequence) {
		throw new CompactionCutPlanningError("turn sequence ranges must be strictly ordered");
	}
	ids.add(turn.turnId);
	if (!isCompleteToolBatch(turn)) {
		return;
	}
}

/** tool call/result 必须一一对应，且同一 ID 不能重复。 */
export function isCompleteToolBatch(turn: Pick<CompactionTurn, "toolCallIds" | "toolResultIds">): boolean {
	const calls = new Set(turn.toolCallIds);
	const results = new Set(turn.toolResultIds);
	return calls.size === turn.toolCallIds.length && results.size === turn.toolResultIds.length && calls.size === results.size && [...calls].every((id) => results.has(id));
}

interface MessageTurn {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly messages: readonly AgentMessage[];
}

function messageTurns(messages: readonly AgentMessage[]): readonly MessageTurn[] {
	if (messages.length === 0) return [];
	const turns: MessageTurn[] = [];
	let startIndex = 0;
	for (let index = 1; index < messages.length; index += 1) {
		if (messages[index]?.role !== "user") continue;
		turns.push({ startIndex, endIndex: index - 1, messages: messages.slice(startIndex, index) });
		startIndex = index;
	}
	turns.push({ startIndex, endIndex: messages.length - 1, messages: messages.slice(startIndex) });
	return turns;
}

function turnDescriptor(turn: MessageTurn, index: number): CompactionTurn {
	const toolCallIds: string[] = [];
	const toolResultIds: string[] = [];
	let stable = true;
	for (const message of turn.messages) {
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") stable = false;
			for (const part of message.content) if (part.type === "toolCall") toolCallIds.push(part.id);
		}
		if (message.role === "toolResult") for (const result of message.content) toolResultIds.push(result.toolCallId);
	}
	return {
		turnId: `turn-${index}`,
		startSequence: turn.startIndex,
		endSequence: turn.endIndex,
		stable: stable && isCompleteToolBatch({ toolCallIds, toolResultIds }),
		toolCallIds,
		toolResultIds,
	};
}

/**
 * 对 model-request 使用的消息做 bounded projection。originalMessages 保持
 * 原引用，调用方可以把 compaction receipt/checkpoint 绑定到原始 ledger；这里只
 * 返回本次请求的视图，不把摘要伪装成已写入 canonical history。
 */
export async function compactMessages(input: CompactMessagesInput): Promise<CompactMessagesResult> {
	const decision = evaluateCompactionTrigger(input);
	if (!decision.shouldCompact) {
		return {
			status: "not_needed",
			originalMessages: input.messages,
			projectedMessages: input.messages,
			decision,
		};
	}
	const turns = messageTurns(input.messages);
	const descriptors = turns.map(turnDescriptor);
	const plan = planCompactionCut(descriptors, { policy: input.policy });
	if (plan.kind !== "cut") {
		return {
			status: "not_available",
			originalMessages: input.messages,
			projectedMessages: input.messages,
			decision,
			plan,
			unavailableReason: plan.reason,
		};
	}
	const compacted = turns
		.filter((_turn, index) => plan.compactedTurnIds.includes(`turn-${index}`))
		.flatMap((turn) => turn.messages);
	const summary = (await input.summarize({ compactedMessages: compacted, cut: plan, reason: input.reason }))?.trim();
	if (summary === undefined || summary.length === 0) {
		return {
			status: "not_available",
			originalMessages: input.messages,
			projectedMessages: input.messages,
			decision,
			plan,
			unavailableReason: "summary_unavailable",
		};
	}
	const summaryMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: `[RunLedger compaction summary]\n${summary}` }],
	};
	const retained = turns
		.filter((_turn, index) => plan.retainedTurnIds.includes(`turn-${index}`))
		.flatMap((turn) => turn.messages);
	return {
		status: "compacted",
		originalMessages: input.messages,
		projectedMessages: [summaryMessage, ...retained],
		decision,
		plan,
		summary,
	};
}

export function planCompactionCut(
	turns: readonly CompactionTurn[],
	options: CompactionCutOptions = {},
): CompactionCutPlan {
	const policy = options.policy;
	if (policy !== undefined && (!policy.enabled || policy.strategy === "off")) {
		return { kind: "no_cut", reason: "disabled" };
	}
	const retainRecentTurns = options.retainRecentTurns ?? policy?.retainRecentTurns ?? 1;
	const minCompactedTurns = options.minCompactedTurns ?? policy?.minCompactedTurns ?? 1;
	assertPositiveInteger(retainRecentTurns, "retainRecentTurns");
	assertPositiveInteger(minCompactedTurns, "minCompactedTurns");

	const ids = new Set<string>();
	for (let index = 0; index < turns.length; index += 1) assertTurnShape(turns[index]!, turns[index - 1], ids);

	const eligibleCount = turns.length - retainRecentTurns;
	if (eligibleCount < minCompactedTurns) return { kind: "no_cut", reason: "insufficient_history" };

	const candidate = turns.slice(0, eligibleCount);
	if (candidate.some((turn) => !turn.stable || !isCompleteToolBatch(turn))) {
		return { kind: "no_cut", reason: "unstable_or_incomplete_prefix" };
	}
	if (candidate.length < minCompactedTurns) return { kind: "no_cut", reason: "insufficient_history" };

	const compactedTurnIds = candidate.map((turn) => turn.turnId);
	return {
		kind: "cut",
		startSequence: candidate[0]!.startSequence,
		endSequence: candidate[candidate.length - 1]!.endSequence,
		compactedTurnIds,
		retainedTurnIds: turns.slice(eligibleCount).map((turn) => turn.turnId),
	};
}
