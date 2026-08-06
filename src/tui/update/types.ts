import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export interface UpdateNoticeView {
	readonly channel: SafeBoundedText;
	readonly releasePrefix: SafeBoundedText;
	readonly message: SafeBoundedText;
	readonly policy: "informational" | "disabled" | "unknown";
}

export type UpdateResult = TuiResultEnvelope<UpdateNoticeView>;

export type UpdateWorkflowState =
	| { readonly state: "unavailable"; readonly reason: string }
	| { readonly state: "idle"; readonly generation: number }
	| { readonly state: "loading"; readonly generation: number; readonly requestId: string; readonly effectId: string }
	| { readonly state: "ready"; readonly generation: number; readonly value: UpdateNoticeView }
	| { readonly state: "empty"; readonly generation: number }
	| { readonly state: "error"; readonly generation: number; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface UpdateQueryPort {
	readonly inspect: (input: TuiPortRequest) => Promise<UpdateResult>;
}
