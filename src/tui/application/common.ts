/**
 * TUI 被动合同共享 envelope。
 *
 * 这些类型只描述已注入的事实和一次请求的关联信息，不拥有执行器、
 * AbortController 或任何 renderer/runtime 对象。
 */

export type TuiField<T> =
	| { readonly state: "known"; readonly value: T }
	| { readonly state: "unknown"; readonly reason: string }
	| { readonly state: "unavailable"; readonly reason: string };

export type Loadable<T> =
	| { readonly state: "idle" }
	| { readonly state: "loading"; readonly requestId: string; readonly generation: number }
	| { readonly state: "ready"; readonly value: T; readonly generation: number }
	| { readonly state: "empty"; readonly generation: number }
	| {
			readonly state: "error";
			readonly code: string;
			readonly message: string;
			readonly retryable: boolean;
			readonly generation: number;
			readonly previous?: T;
	  };

export type QueryGuard =
	| { readonly state: "idle" }
	| {
			readonly state: "dispatching";
			readonly correlationId: string;
			readonly effectId: string;
			readonly generation: number;
	  }
	| {
			readonly state: "running";
			readonly correlationId: string;
			readonly effectId: string;
			readonly generation: number;
	  };

export interface CorrelatedRequestRef {
	readonly generation: number;
	readonly effectId: string;
	readonly correlationId: string;
}

/** Port 执行时可以接收取消信号；该字段不进入 TuiState 或 result snapshot。 */
export interface TuiPortRequest extends CorrelatedRequestRef {
	readonly signal: AbortSignal;
	readonly authorityGeneration?: number;
}

export interface TuiError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
	readonly recoveryRequired?: boolean;
}

export type TuiTerminalState =
	| { readonly state: "succeeded"; readonly summary?: string }
	| { readonly state: "failed"; readonly code: string; readonly message: string; readonly retryable: boolean; readonly recoveryRequired?: boolean }
	| { readonly state: "cancelled"; readonly reason?: string }
	| { readonly state: "aborted"; readonly reason: string };

export type TuiExecutionState =
	| { readonly state: "pending"; readonly summary?: string }
	| { readonly state: "running"; readonly effectId: string }
	| TuiTerminalState;

export type PortAvailability =
	| { readonly state: "available" }
	| { readonly state: "unavailable"; readonly reason: string };

export type TuiResultEnvelope<T> =
	| { readonly ok: true; readonly ref: CorrelatedRequestRef; readonly value: T }
	| { readonly ok: false; readonly ref: CorrelatedRequestRef; readonly error: TuiError };

export type TuiRevision = number;
