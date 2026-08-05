import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type RuntimeSnapshotField<T> = TuiField<T>;

export interface TuiRuntimeSnapshot {
	readonly authorityGeneration: number;
	readonly sourceRevision: TuiField<number>;
	readonly session: RuntimeSnapshotField<{ readonly sessionId: string; readonly lifecycle: string }>;
	readonly activity: RuntimeSnapshotField<{ readonly phase: SafeBoundedText; readonly turn: TuiField<number> }>;
	readonly security: RuntimeSnapshotField<{ readonly mode: SafeBoundedText; readonly revision: number }>;
	readonly selection: RuntimeSnapshotField<{ readonly providerId: string; readonly modelId: string; readonly thinkingLevel: string }>;
	readonly context: RuntimeSnapshotField<{ readonly totalTokens: TuiField<number>; readonly contextWindow: TuiField<number> }>;
	readonly queue: {
		readonly steering: TuiField<number>;
		readonly followUp: TuiField<number>;
		readonly claimed: TuiField<number>;
	};
	readonly pendingApprovals: TuiField<number>;
	readonly toolCount: TuiField<number>;
	readonly extensions: RuntimeSnapshotField<{ readonly generation: number; readonly ready: TuiField<number>; readonly blocked: TuiField<number> }>;
}

export type TuiRuntimeSnapshotResult = TuiResultEnvelope<TuiRuntimeSnapshot>;

export type RuntimeSnapshotWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly previous?: TuiRuntimeSnapshot }
	| { readonly state: "ready"; readonly generation: number; readonly value: TuiRuntimeSnapshot }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean; readonly previous?: TuiRuntimeSnapshot };

export interface RuntimeSnapshotQueryPort {
	readonly getSnapshot: (input: TuiPortRequest) => Promise<TuiRuntimeSnapshotResult>;
}
