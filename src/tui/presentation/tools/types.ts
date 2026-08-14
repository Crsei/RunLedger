import type { TuiField } from "../../application/common.ts";

export type SafeBoundedText = {
	readonly text: string;
	readonly truncated: boolean;
	readonly byteLength: number;
};

export type SafeCount = TuiField<number>;

export type SafeToolRenderer =
	| "generic"
	| "plan"
	| "edit"
	| "write"
	| "read"
	| "grep"
	| "media"
	| "goal"
	| "shell";

export type SafeToolInputMetadata =
	| { readonly kind: "generic" }
	| { readonly kind: "edit"; readonly path: SafeBoundedText; readonly editCount: SafeCount }
	| { readonly kind: "write"; readonly path: SafeBoundedText; readonly lineCount: SafeCount; readonly byteCount: SafeCount }
	| { readonly kind: "read"; readonly path: SafeBoundedText; readonly offset?: SafeCount; readonly limit?: SafeCount }
	| { readonly kind: "grep"; readonly path: SafeBoundedText }
	| { readonly kind: "shell"; readonly commandLabel: SafeBoundedText; readonly background?: boolean };

export type SafeDiffLine =
	| { readonly kind: "context"; readonly oldLine: number; readonly newLine: number; readonly text: SafeBoundedText }
	| { readonly kind: "delete"; readonly oldLine: number; readonly text: SafeBoundedText }
	| { readonly kind: "add"; readonly newLine: number; readonly text: SafeBoundedText };

export interface SafeDiffHunk {
	readonly oldStart: number;
	readonly newStart: number;
	readonly lines: readonly SafeDiffLine[];
}

export interface SafeDiffDocument {
	readonly kind: "document";
	readonly path: SafeBoundedText;
	readonly hunks: readonly SafeDiffHunk[];
	readonly addedLines: SafeCount;
	readonly removedLines: SafeCount;
	readonly truncated: boolean;
	readonly diagnostic?: "invalid" | "limit" | "unavailable";
}

export interface SafeMediaView {
	readonly mimeType: SafeBoundedText | string;
	readonly byteCount: SafeCount;
	readonly artifact: TuiField<{ readonly id: SafeBoundedText; readonly digest: SafeBoundedText }>;
	readonly truncated: boolean;
	readonly diagnostic?: "invalid" | "limit" | "unsupported";
}

export interface SafeShellChunk {
	readonly channel: "stdout" | "stderr";
	readonly text: SafeBoundedText;
	/** 仅含安全 SGR 的同正文投影；缺失时 renderer 使用 plain text。 */
	readonly safeSgrText?: SafeBoundedText;
}

export type SafePlanStepStatus = "pending" | "in-progress" | "completed";

export interface SafePlanStep {
	readonly text: SafeBoundedText;
	readonly status: SafePlanStepStatus;
}

export interface SafePlanUpdate {
	readonly explanation?: SafeBoundedText;
	readonly steps: readonly SafePlanStep[];
}

export type SafeToolResultMetadata =
	| { readonly kind: "generic" }
	| { readonly kind: "edit"; readonly document?: SafeDiffDocument; readonly addedLines?: SafeCount; readonly removedLines?: SafeCount }
	| { readonly kind: "read"; readonly lineCount: SafeCount; readonly truncated: boolean }
	| { readonly kind: "grep"; readonly matchCount: SafeCount; readonly fileCount: SafeCount; readonly samples: readonly SafeBoundedText[]; readonly truncated: boolean }
	| { readonly kind: "media"; readonly items: readonly SafeMediaView[] }
	| { readonly kind: "shell"; readonly chunks: readonly SafeShellChunk[]; readonly truncated: boolean; readonly exitCode: SafeCount; readonly durationMs: SafeCount; readonly background: boolean }
	| { readonly kind: "goal"; readonly goalId: SafeBoundedText; readonly phase: SafeBoundedText; readonly revision: number; readonly evidenceCount: SafeCount };

export interface SafeToolChip {
	readonly label: SafeBoundedText;
	readonly tone: "neutral" | "positive" | "negative" | "warning" | "error";
}

export type SafeToolBodyBlock =
	| { readonly kind: "text"; readonly content: SafeBoundedText }
	| { readonly kind: "diff"; readonly document: SafeDiffDocument };

export type SafeUsageQuantity =
	| { readonly state: "exact" | "estimated"; readonly value: number }
	| { readonly state: "unknown" | "unavailable" | "not-applicable"; readonly reason: string };

export interface SafeToolUsageView {
	readonly input: SafeUsageQuantity;
	readonly output: SafeUsageQuantity;
	readonly accounting: "billable" | "estimated" | "non-billable" | "unavailable";
	readonly request?: {
		readonly ordinal: number;
		readonly provider: SafeBoundedText;
		readonly model: SafeBoundedText;
		readonly requestIdPrefix?: SafeBoundedText;
	};
}

export interface SafeToolPresentation {
	readonly renderer: SafeToolRenderer;
	readonly title: SafeBoundedText;
	readonly input?: SafeToolInputMetadata;
	readonly chips: readonly SafeToolChip[];
	readonly body: readonly SafeToolBodyBlock[];
	readonly plan?: SafePlanUpdate;
	readonly result?: SafeToolResultMetadata;
	readonly error?: SafeBoundedText;
	readonly usage?: SafeToolUsageView;
	readonly timestamps: {
		readonly startedAt: string;
		readonly endedAt?: string;
	};
}

export type SafeToolView =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "ready"; readonly value: SafeToolPresentation };
