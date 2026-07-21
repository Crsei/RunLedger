/**
 * Model Compatibility Router 的公共类型占位。
 *
 * TODO(runtime-phase-6): 由 Runtime contract 冻结 manifest/profile 字段、fork
 * ref 和 provider-private state 边界；本文件不读取模型 catalog，也不执行 fork。
 */

export type ModelRouteOperation = "switch" | "summarize" | "compact";
export type ModelRouteOutcome = "compatible" | "fork" | "deny";

export interface ModelCapabilityProfile {
	profileId: string;
	modelId: string;
	manifestVersion: string;
	manifestDigest: string;
	contextWindow: number;
	maxOutputTokens: number;
	reasoningProtocol: "none" | "native" | "signature";
	toolProtocol: "none" | "json" | "provider-native";
	imageInput: boolean;
	compaction: "none" | "summary" | "full-replace";
	status: "verified" | "unknown" | "retired";
}

export interface ModelRouteRequest {
	operation: ModelRouteOperation;
	fromModelId?: string;
	targetModelId: string;
	requiredContextTokens: number;
	requiredOutputTokens: number;
	requiresTools: boolean;
	requiresReasoningReplay: boolean;
	requiresImages: boolean;
}

export interface ModelRouteDecision {
	outcome: ModelRouteOutcome;
	targetModelId: string;
	profileId?: string;
	manifestDigest?: string;
	reason: string;
	decisionDigest: string;
	forkSession?: boolean;
}
