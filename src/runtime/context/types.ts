/**
 * 分层 ContextEngine 的公共类型合同。
 *
 * TODO(runtime-phase-6): 冻结 fragment schema、预算/omission receipt 和 stable
 * ordering。组装算法、token estimator 与 agent-loop seam 不在此文件实现。
 */

export type ContextLayer = "identity" | "policy" | "mode" | "resources" | "history" | "memory" | "task";

export interface ContextFragment {
	fragmentId: string;
	layer: ContextLayer;
	order: number;
	content: string;
	contentDigest: string;
	maxChars: number;
	trusted: boolean;
	priority: "required" | "normal" | "optional";
}

export interface ContextAssemblyRequest {
	modelId: string;
	contextWindow: number;
	outputReserve: number;
	toolReserve: number;
	fragments: readonly ContextFragment[];
}

export interface ContextAssemblyReceipt {
	requestId: string;
	modelId: string;
	fragmentIds: readonly string[];
	omittedFragmentIds: readonly string[];
	estimatedInputTokens: number;
	reservedOutputTokens: number;
	contextDigest: string;
	diagnostics: readonly string[];
}
