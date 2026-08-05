import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface PromptTemplateSnapshot {
	readonly templateId: string;
	readonly label: SafeBoundedText;
	readonly text: SafeBoundedText;
	readonly availability: "available" | "unavailable" | "unknown";
	readonly generation: number;
}

export type PromptSubmissionState =
	| { readonly state: "idle" }
	| { readonly state: "submitting"; readonly requestId: string }
	| { readonly state: "submitted"; readonly requestId: string; readonly receiptPrefix?: SafeBoundedText }
	| { readonly state: "failed"; readonly requestId: string; readonly code: string; readonly message: SafeBoundedText; readonly retryable: boolean }
	| { readonly state: "aborted"; readonly requestId: string; readonly reason: string };

export interface PromptSnapshot {
	readonly templates: readonly PromptTemplateSnapshot[];
	readonly submission: PromptSubmissionState;
	readonly generation: number;
}

export type PromptWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: PromptSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type PromptWorkflowResult = TuiResultEnvelope<PromptSnapshot>;

export interface PromptWorkflowPort {
	readonly list: (input: TuiPortRequest) => Promise<PromptWorkflowResult>;
	readonly submit: (input: TuiPortRequest & { readonly templateId: string; readonly text: SafeBoundedText }) => Promise<PromptWorkflowResult>;
}
