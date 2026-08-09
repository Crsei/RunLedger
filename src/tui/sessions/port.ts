import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SessionCatalogResult, SessionTransitionResult } from "./types.ts";

export interface SessionCreateRequest extends TuiPortRequest {
	readonly expectedRevision: number;
}

export interface SessionResumeRequest extends TuiPortRequest {
	readonly targetSessionId: string;
	readonly expectedRevision: number;
}

export interface SessionForkRequest extends TuiPortRequest {
	readonly sourceSessionId: string;
	readonly expectedSourceHeadSequence: number;
	readonly expectedRevision: number;
}

/** TUI 只依赖这一个 Session authority port。 */
export interface SessionWorkflowPort {
	list(request: TuiPortRequest): Promise<TuiResultEnvelope<SessionCatalogResult>>;
	create(request: SessionCreateRequest): Promise<TuiResultEnvelope<SessionTransitionResult>>;
	resume(request: SessionResumeRequest): Promise<TuiResultEnvelope<SessionTransitionResult>>;
	fork(request: SessionForkRequest): Promise<TuiResultEnvelope<SessionTransitionResult>>;
}
