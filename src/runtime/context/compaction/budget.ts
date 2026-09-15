/*!
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/** 来源 oh-my-pi 3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec packages/agent/src/compaction/compaction.ts；适配 RunLedger 的比例设置。 */
import type { Message } from "../../../types.ts";
import { conservativeTokenEstimate, TokenEstimator } from "../token-estimator.ts";

export const DEFAULT_RESERVE_TOKENS = 16_384;
export interface CompactionBudgetSettings {
	readonly reserveTokens?: number;
	readonly thresholdTokens?: number;
	readonly threshold?: number;
}
export function effectiveReserveTokens(window: number, settings: CompactionBudgetSettings): number {
	return Math.max(Math.floor(window * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}
export function resolveBudgetReserveTokens(window: number, settings: CompactionBudgetSettings): number {
	const reserve = effectiveReserveTokens(window, settings);
	const proportional = Math.max(1, Math.floor(window * 0.15));
	return (settings.reserveTokens === undefined && reserve >= window - proportional) || reserve >= window ? proportional : reserve;
}
export function resolveThresholdTokens(window: number, settings: CompactionBudgetSettings): number {
	if (!Number.isFinite(window) || window <= 1) return 0;
	if (Number.isFinite(settings.thresholdTokens) && settings.thresholdTokens! > 0) return Math.min(window - 1, Math.max(1, settings.thresholdTokens!));
	if (Number.isFinite(settings.threshold) && settings.threshold! > 0) return Math.floor(window * Math.min(0.99, Math.max(0.01, settings.threshold!)));
	return Math.max(0, Math.min(window - 1, window - resolveBudgetReserveTokens(window, settings)));
}
export function compactionContextTokens(providerTokens: number, localEstimate: number): number {
	return Math.max(Number.isFinite(providerTokens) ? Math.max(0, providerTokens) : 0, Number.isFinite(localEstimate) ? Math.max(0, localEstimate) : 0);
}
export function adjustedRetainTokens(tokens: number, providerTokens: number, estimatedTokens: number): number {
	const ratio = estimatedTokens > 0 ? providerTokens / estimatedTokens : 0;
	return Number.isFinite(ratio) && ratio > 1 ? Math.max(1, Math.floor(tokens / ratio)) : tokens;
}

/** 样本只来自当前模型、当前投影世代之后的已完成响应；重启从原始消息确定性重建。 */
export function observeCompactionBudget(messages: readonly Message[], model: { provider: string; id: string }, startIndex = 0): {
	readonly promptTokens: number; readonly contextTokens: number; readonly estimator: TokenEstimator;
} {
	const estimator = new TokenEstimator();
	for (let index = messages.length - 1; index >= startIndex; index -= 1) {
		const message = messages[index]!;
		if (message.role !== "assistant") continue;
		if (message.provider !== model.provider || message.model !== model.id
			|| message.stopReason === "error" || message.stopReason === "aborted") break;
		const usage = message.usage;
		const parts = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
		if (parts.some((value) => !Number.isSafeInteger(value) || value < 0)) break;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens <= 0) break;
		const content = JSON.stringify(messages.slice(0, index));
		estimator.observe({ inputChars: content.length, inputBytes: Buffer.byteLength(content, "utf8"), inputTokens: promptTokens });
		return { promptTokens, contextTokens: promptTokens + usage.output, estimator };
	}
	return { promptTokens: 0, contextTokens: 0, estimator };
}
export function estimateHistoryTokens(messages: readonly Message[]): number {
	return messages.reduce((total, message) => total + conservativeTokenEstimate(JSON.stringify(message)), 0);
}
