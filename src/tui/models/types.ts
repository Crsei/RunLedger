import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface ModelSnapshot {
	readonly providerId: string;
	readonly modelId: string;
	readonly label: SafeBoundedText;
	readonly contextWindow: TuiField<number>;
	readonly availability: "available" | "unavailable" | "unknown";
	readonly generation: number;
}

export interface ModelSelectionSnapshot {
	readonly providerId: string;
	readonly modelId: string;
	readonly generation: number;
}

export interface ModelCatalogSnapshot {
	readonly providerId: string;
	readonly models: readonly ModelSnapshot[];
	readonly generation: number;
}

export type ModelWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: ModelCatalogSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export type ModelCatalogResult = TuiResultEnvelope<ModelCatalogSnapshot>;
export type ModelSelectionResult = TuiResultEnvelope<ModelSelectionSnapshot>;

export interface ModelWorkflowPort {
	readonly list: (input: TuiPortRequest & { readonly providerId: string }) => Promise<ModelCatalogResult>;
	readonly select: (input: TuiPortRequest & { readonly providerId: string; readonly modelId: string }) => Promise<ModelSelectionResult>;
}
