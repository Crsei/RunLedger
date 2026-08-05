import type { ModelThinkingLevel } from "../../types.ts";
import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";

export interface ThinkingSnapshot {
	readonly level: ModelThinkingLevel | "unknown";
	readonly availableLevels: readonly (ModelThinkingLevel | "unknown")[];
	readonly generation: number;
}

export type ThinkingWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "ready"; readonly generation: number; readonly value: ThinkingSnapshot }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type ThinkingResult = TuiResultEnvelope<ThinkingSnapshot>;

export interface ThinkingWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<ThinkingResult>;
	readonly select: (input: TuiPortRequest & { readonly level: ModelThinkingLevel }) => Promise<ThinkingResult>;
}
