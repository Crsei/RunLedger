import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type DurableQueueItemState = "pending" | "claimed" | "cancelled" | "completed" | "unknown";

export interface DurableQueueItemSnapshot {
	readonly itemId: string;
	readonly sessionId: string;
	readonly state: DurableQueueItemState;
	readonly digestPrefix: SafeBoundedText;
	readonly label: SafeBoundedText;
	readonly queueRevision: number;
}

export interface DurableQueueSnapshot {
	readonly authorityGeneration: number;
	readonly queueRevision: number;
	readonly items: readonly DurableQueueItemSnapshot[];
	readonly pendingCount: TuiField<number>;
	readonly claimedCount: TuiField<number>;
}

export interface QueueCancellationReceipt {
	readonly itemId: string;
	readonly queueRevision: number;
	readonly receiptPrefix: SafeBoundedText;
	readonly outcome: "cancelled" | "already-terminal" | "uncertain";
	readonly recoveryRequired: boolean;
}

export type QueueSnapshotResult = TuiResultEnvelope<DurableQueueSnapshot>;
export type QueueCancellationResult = TuiResultEnvelope<QueueCancellationReceipt>;

export type DurableQueueWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: DurableQueueSnapshot }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean; readonly recoveryRequired?: boolean };

export interface DurableQueueWorkflowPort {
	readonly inspect: (input: TuiPortRequest) => Promise<QueueSnapshotResult>;
	readonly cancel: (input: TuiPortRequest & { readonly item: DurableQueueItemSnapshot; readonly reason: SafeBoundedText }) => Promise<QueueCancellationResult>;
}
