/** 分层 ContextEngine 的被动公共合同。 */

import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../protocol/foundation.ts";
import type { CommandId, TraceId } from "../protocol/ids.ts";

export type ContextLayer = "identity" | "policy" | "mode" | "resources" | "history" | "memory" | "task";

export interface ContextFragment {
	readonly fragmentId: string;
	readonly layer: ContextLayer;
	readonly order: number;
	readonly contentRef: RuntimeContentRef;
	readonly contentDigest: RuntimeDigest;
	readonly estimatedTokens: number;
	readonly trust: "trusted" | "untrusted" | "mixed";
	readonly taint: "none" | "user_input" | "tool_output" | "external";
	readonly priority: "required" | "normal" | "optional";
}

export interface ContextAssemblyRequest {
	readonly requestId: CommandId;
	readonly modelProfileId: string;
	readonly contextWindow: number;
	readonly outputReserve: number;
	readonly toolReserve: number;
	readonly fragments: readonly ContextFragment[];
	readonly traceId: TraceId;
}

export interface ContextOmission {
	readonly fragmentId: string;
	readonly reasonCode: string;
}

export interface ContextDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
}

export interface ContextAssemblyReceipt {
	readonly requestId: CommandId;
	readonly modelProfileId: string;
	readonly fragmentIds: readonly string[];
	readonly omittedFragments: readonly ContextOmission[];
	readonly estimatedInputTokens: number;
	readonly reservedOutputTokens: number;
	readonly contextDigest: RuntimeDigest;
	readonly diagnostics: readonly ContextDiagnostic[];
	readonly sourceHead: RuntimeStreamHead;
	readonly projectionDigest: RuntimeDigest;
	readonly assembledAt: string;
}
