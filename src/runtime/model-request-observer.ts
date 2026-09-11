import type { Api, Model, StopReason } from "../types.ts";
import type { LlmContext } from "./types.ts";

export type ModelRequestObservation =
	| { readonly kind: "assembled"; readonly requestId: string; readonly runId: string; readonly turn: number;
		readonly requestKind: "interactive" | "idle-recap" | "auto-title"; readonly model: Model<Api>;
		readonly thinkingLevel: string; readonly context: LlmContext }
	| { readonly kind: "prepared"; readonly requestId: string; readonly payloadJson: string; readonly model: Model<Api> }
	| { readonly kind: "response"; readonly requestId: string; readonly status: number }
	| { readonly kind: "finished"; readonly requestId: string; readonly stopReason: StopReason };

export type ModelRequestObserver = (event: ModelRequestObservation) => void;

/** 旁路观测不拥有执行或错误 authority。 */
export function observeModelRequest(observer: ModelRequestObserver | undefined, event: ModelRequestObservation): void {
	try { observer?.(event); } catch { /* 保持请求语义，查询不得推测缺失的快照。 */ }
}
