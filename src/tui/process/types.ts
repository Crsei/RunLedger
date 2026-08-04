/** OpenTUI managed-process view model; backend details stay outside this type. */

import type { ExecutionId, AttemptId } from "../../runtime/protocol/ids.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";

export interface ProcessOverlayItem {
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly state: string;
	readonly outputCursor: OutputCursor;
	readonly outputSize: number;
	readonly canWrite: boolean;
	readonly canResize: boolean;
	readonly canStop: boolean;
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
