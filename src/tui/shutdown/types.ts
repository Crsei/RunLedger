import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type ShutdownTrigger = "user" | "host" | "signal" | "unknown";

export interface ShutdownReceipt {
	readonly trigger: ShutdownTrigger;
	readonly outcome: "accepted" | "completed" | "failed" | "uncertain";
	readonly message?: SafeBoundedText;
	readonly recoveryRequired: boolean;
}

export type ShutdownResult = TuiResultEnvelope<ShutdownReceipt>;

export type ShutdownWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "requesting"; readonly generation: number; readonly requestId: string; readonly trigger: ShutdownTrigger }
	| { readonly state: "succeeded"; readonly generation: number; readonly trigger: ShutdownTrigger }
	| { readonly state: "recovery-required"; readonly generation: number; readonly trigger: ShutdownTrigger; readonly message: string }
	| { readonly state: "failed"; readonly generation: number; readonly trigger: ShutdownTrigger; readonly message: string; readonly retryable: boolean };

export interface ShutdownWorkflowPort {
	readonly request: (input: TuiPortRequest & { readonly trigger: ShutdownTrigger }) => Promise<ShutdownResult>;
}
