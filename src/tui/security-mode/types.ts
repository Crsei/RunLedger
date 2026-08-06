import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface SecurityModeSnapshot {
	readonly authorityGeneration: number;
	readonly mode: TuiField<"guarded" | "unrestricted">;
	readonly modeRevision: TuiField<number>;
}

export interface SecurityModeTransitionReceipt {
	readonly target: "guarded" | "unrestricted";
	readonly revision: number;
	readonly receiptPrefix: SafeBoundedText;
	readonly outcome: "accepted" | "completed" | "uncertain";
	readonly recoveryRequired: boolean;
}

export type SecurityModeResult = TuiResultEnvelope<SecurityModeTransitionReceipt>;

export type SecurityModeWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: SecurityModeSnapshot }
	| { readonly state: "uncertain"; readonly generation: number; readonly message: string; readonly recoveryRequired: true }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface SecurityModeWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<TuiResultEnvelope<SecurityModeSnapshot>>;
	readonly set: (input: TuiPortRequest & { readonly target: "guarded" | "unrestricted"; readonly expectedRevision: TuiField<number> }) => Promise<SecurityModeResult>;
}
