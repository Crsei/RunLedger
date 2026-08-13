/** OpenTUI managed-process view model; backend details stay outside this type. */

import type { ExecutionId, AttemptId } from "../../runtime/protocol/ids.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import type { ProcessState } from "../../runtime/process/types.ts";
import type { TuiField, TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";

export interface ProcessOverlayItem {
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly state: string;
	readonly outputCursor: OutputCursor;
	readonly outputSize: number;
	readonly canWrite: boolean;
	readonly canResize: boolean;
	readonly canStop: boolean;
	readonly commandDisplay:
		| { readonly authority: "unavailable" }
		| { readonly authority: "authorized" | "spawned"; readonly label: string; readonly receiptDigest: RuntimeDigest };
}

export interface ProcessOverlayState {
	readonly open: boolean;
	readonly mode: "list" | "detail" | "terminal";
	readonly processes: readonly ProcessOverlayItem[];
	readonly selectedExecutionId?: ExecutionId;
	readonly output: string;
	readonly cursor: OutputCursor;
	readonly truncated: boolean;
	readonly driver: boolean;
	readonly pendingAction?: "write" | "resize" | "stop";
	readonly editorFocusRestored: boolean;
	readonly terminalSize: { readonly columns: number; readonly rows: number };
}

export interface ProcessOverlaySeed {
	readonly processes: readonly ProcessOverlayItem[];
	readonly driver: boolean;
}

export type ProcessOverlayAction =
	| { readonly type: "open_list" }
	| { readonly type: "open_detail"; readonly executionId: ExecutionId }
	| { readonly type: "open_terminal"; readonly executionId: ExecutionId }
	| { readonly type: "output_resync"; readonly cursor: OutputCursor }
	| { readonly type: "output_page"; readonly text: string; readonly nextCursor: OutputCursor; readonly truncated: boolean }
	| { readonly type: "driver_changed"; readonly driver: boolean }
	| { readonly type: "request_write" }
	| { readonly type: "request_resize" }
	| { readonly type: "request_stop" }
	| { readonly type: "resize"; readonly columns: number; readonly rows: number }
	| { readonly type: "close" };

/** 只读 managed-process 合同；既有 overlay state/adapter 仍由 process authority 管理。 */
export interface ProcessPassiveSnapshot {
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly state: ProcessState;
	readonly authorityGeneration: number;
	readonly hostRevision: TuiField<number>;
	readonly output: {
		readonly cursor: TuiField<string>;
		readonly preview?: SafeBoundedText;
		readonly bytes: TuiField<number>;
		readonly truncated: boolean;
	};
	readonly driver: "driver" | "observer" | "unknown";
}

export interface ProcessPassiveOutputPage {
	readonly executionId: ExecutionId;
	readonly cursor: TuiField<string>;
	readonly text: SafeBoundedText;
	readonly nextCursor: TuiField<string>;
	readonly closed: boolean;
}

export type ProcessPassiveResult = TuiResultEnvelope<readonly ProcessPassiveSnapshot[]>;
export type ProcessPassiveOutputResult = TuiResultEnvelope<ProcessPassiveOutputPage>;
export type ProcessPassiveMutationResult = TuiResultEnvelope<{
	readonly executionId: ExecutionId;
	readonly operation: "detach" | "stop";
	readonly receiptPrefix: SafeBoundedText;
	readonly outcome: "accepted" | "completed" | "uncertain";
	readonly recoveryRequired: boolean;
}>;

export type ProcessPassiveWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: readonly ProcessPassiveSnapshot[] }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean; readonly recoveryRequired?: boolean };

export interface ProcessPassivePort {
	readonly list: (input: TuiPortRequest) => Promise<ProcessPassiveResult>;
	readonly output: (input: TuiPortRequest & { readonly executionId: ExecutionId; readonly cursor: TuiField<string> }) => Promise<ProcessPassiveOutputResult>;
	readonly mutate: (input: TuiPortRequest & { readonly executionId: ExecutionId; readonly operation: "detach" | "stop" }) => Promise<ProcessPassiveMutationResult>;
}
