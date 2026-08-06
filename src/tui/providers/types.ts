import type { PortAvailability, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface ProviderSnapshot {
	readonly providerId: string;
	readonly label: SafeBoundedText;
	readonly status: "ready" | "not-configured" | "error" | "unknown";
	readonly authKinds: readonly ("api-key" | "oauth" | "unknown")[];
	readonly generation: number;
}

export interface ProviderModelOption {
	readonly providerId: string;
	readonly modelId: string;
	readonly label: SafeBoundedText;
	readonly availability: PortAvailability;
}

export interface ProviderCatalogSnapshot {
	readonly providers: readonly ProviderSnapshot[];
	readonly models: readonly ProviderModelOption[];
	readonly generation: number;
}

export interface ProviderSelectionSnapshot {
	readonly providerId: string;
	readonly modelId: string;
	readonly generation: number;
}

export type ProviderWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: ProviderCatalogSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type ProviderCatalogResult = TuiResultEnvelope<ProviderCatalogSnapshot>;
export type ProviderSelectionResult = TuiResultEnvelope<ProviderSelectionSnapshot>;

export interface ProviderWorkflowPort {
	readonly list: (input: TuiPortRequest) => Promise<ProviderCatalogResult>;
	readonly select: (input: TuiPortRequest & { readonly providerId: string; readonly modelId: string }) => Promise<ProviderSelectionResult>;
}
