/**
 * 工具中止错误。
 *
 * 上游对应物是 `coding-agent/src/tools/tool-errors.ts` 的 `ToolAbortError` /
 * `throwIfAborted`。RunLedger 的工具契约是「失败即 throw」，循环层按普通异常
 * 兜底渲染，因此这里只保留这两项；`ToolError` / `renderError` 属上游渲染面，
 * 未移植。
 */

export class ToolAbortError extends Error {
	static readonly MESSAGE = "Operation aborted";

	constructor(message: string = ToolAbortError.MESSAGE, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolAbortError";
	}
}

/** 已中止时抛出 `ToolAbortError`，保持与上游一致的错误类型。 */
export function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason instanceof Error ? signal.reason : undefined;
	throw reason instanceof ToolAbortError ? reason : new ToolAbortError(undefined, { cause: signal.reason });
}
