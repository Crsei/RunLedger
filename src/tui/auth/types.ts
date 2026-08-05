import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type AuthKind = "api-key" | "oauth" | "unknown";

export interface AuthProviderSnapshot {
	readonly providerId: string;
	readonly providerLabel: SafeBoundedText;
	readonly configured: "yes" | "no" | "unknown";
	readonly authKind: AuthKind;
	readonly sourceLabel?: SafeBoundedText;
}

export type AuthPromptView =
	| { readonly kind: "text"; readonly label: SafeBoundedText }
	| { readonly kind: "secret"; readonly label: SafeBoundedText }
	| { readonly kind: "select"; readonly label: SafeBoundedText; readonly options: readonly SafeBoundedText[] };

export type AuthInteractionState =
	| { readonly state: "idle" }
	| { readonly state: "prompting"; readonly requestId: string; readonly prompt: AuthPromptView }
	| { readonly state: "notified"; readonly requestId: string; readonly message: SafeBoundedText }
	| { readonly state: "completed"; readonly requestId: string }
	| { readonly state: "failed"; readonly requestId: string; readonly message: SafeBoundedText };

export interface AuthSnapshot {
	readonly providers: readonly AuthProviderSnapshot[];
	readonly generation: number;
	readonly interaction: AuthInteractionState;
}

export type AuthWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: AuthSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type AuthWorkflowResult = TuiResultEnvelope<AuthSnapshot>;

export interface AuthWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<AuthWorkflowResult>;
	readonly beginLogin: (input: TuiPortRequest & { readonly providerId: string; readonly authKind: AuthKind }) => Promise<AuthWorkflowResult>;
	readonly logout: (input: TuiPortRequest & { readonly providerId: string }) => Promise<AuthWorkflowResult>;
}
