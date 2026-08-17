/** Model Compatibility Router 的被动公共合同。 */

import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import type { CommandId, SessionId, TraceId } from "../protocol/ids.ts";

export type ModelRouteOperation = "request" | "switch" | "summarize" | "compact";
export type ModelRouteOutcome = "compatible" | "fork" | "deny";
export type ModelRequestKind = "interactive" | "idle-recap" | "auto-title";

export interface ModelCapabilityProfile {
	readonly profileId: string;
	readonly providerId: string;
	readonly modelId: string;
	readonly manifestVersion: string;
	readonly manifestDigest: RuntimeDigest;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly reasoningProtocol: "none" | "native" | "signature";
	readonly toolProtocol: "none" | "json" | "provider-native";
	readonly imageInput: boolean;
	readonly compaction: "none" | "summary" | "full-replace";
	readonly status: "verified" | "unknown" | "retired";
	readonly conversionRef?: RuntimeContentRef;
	readonly adapterStateRef?: RuntimeContentRef;
}

export interface ModelRouteRequest {
	readonly requestId: CommandId;
	readonly operation: ModelRouteOperation;
	/** Identifies the bounded request purpose without exposing prompt content. */
	readonly requestKind?: ModelRequestKind;
	readonly sourceProfileId?: string;
	readonly targetProfileId: string;
	readonly contextDigest: RuntimeDigest;
	readonly planDigest: RuntimeDigest;
	readonly resourceDigest: RuntimeDigest;
	readonly requiredContextTokens: number;
	readonly requiredOutputTokens: number;
	readonly requiresTools: boolean;
	readonly requiresReasoningReplay: boolean;
	readonly requiresImages: boolean;
	readonly traceId: TraceId;
}

export interface ModelRouteDecision {
	readonly requestId: CommandId;
	readonly outcome: ModelRouteOutcome;
	readonly targetProviderId: string;
	readonly targetModelId: string;
	readonly targetProfileId: string;
	readonly manifestDigest: RuntimeDigest;
	readonly reasonCode: string;
	readonly diagnostics: readonly ModelRouteDiagnostic[];
	readonly decisionDigest: RuntimeDigest;
	readonly conversionRef?: RuntimeContentRef;
	readonly forkSessionId?: SessionId;
}

export interface ModelRouteDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
}
