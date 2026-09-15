/** 所有策略共享同一次操作的调用预算；迟到结果不得用于提交。 */
import { conservativeTokenEstimate } from "../token-estimator.ts";
import type { CompactionLimits, SummaryModelPort, SummaryResult } from "./strategy.ts";

export interface SummaryUsage { readonly input: number; readonly output: number; readonly calls: number }
export function createBudgetedSummaryModel(
	transport: SummaryModelPort,
	limits: CompactionLimits,
	operationSignal: AbortSignal,
	inputOverheadTokens = 0,
): SummaryModelPort & { usage(): SummaryUsage } {
	let calls = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let active = false;
	return {
		usage: () => ({ calls, input: inputTokens, output: outputTokens }),
		async generate(request): Promise<SummaryResult> {
			if (operationSignal.aborted || request.signal.aborted || Date.now() >= limits.deadlineMs) return { ok: false, code: "cancelled" };
			// 调用预算包括输出预留；失败请求保留预留，不能通过失败规避累计限额。
			const estimate = conservativeTokenEstimate(request.content);
			if (active || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1
				|| request.maxOutputTokens > limits.maxSummaryTokens || calls >= limits.maxModelCalls
				|| estimate > limits.maxInputTokensPerCall || inputTokens + estimate + inputOverheadTokens > limits.maxTotalInputTokens
				|| outputTokens + request.maxOutputTokens > limits.maxTotalOutputTokens) return { ok: false, code: "budget_exhausted" };
			calls += 1; inputTokens += estimate + inputOverheadTokens; outputTokens += request.maxOutputTokens; active = true;
			const controller = new AbortController();
			const abort = (): void => controller.abort();
			operationSignal.addEventListener("abort", abort, { once: true });
			request.signal.addEventListener("abort", abort, { once: true });
			const timeout = setTimeout(abort, Math.max(1, limits.deadlineMs - Date.now()));
			let onAbort: () => void = () => {};
			try {
				const cancelled = new Promise<SummaryResult>((resolve) => {
					onAbort = () => resolve({ ok: false, code: "cancelled" });
					controller.signal.addEventListener("abort", onAbort, { once: true });
				});
				const result = await Promise.race([transport.generate({ ...request, signal: controller.signal }), cancelled]);
				if (controller.signal.aborted || Date.now() >= limits.deadlineMs) return { ok: false, code: "cancelled" };
				return result;
			} catch { return { ok: false, code: "model_failed" }; }
			finally {
				clearTimeout(timeout);
				controller.signal.removeEventListener("abort", onAbort);
				operationSignal.removeEventListener("abort", abort);
				request.signal.removeEventListener("abort", abort);
				active = false;
			}
		},
	};
}
