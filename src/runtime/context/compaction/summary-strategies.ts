import { conservativeTokenEstimate } from "../token-estimator.ts";
import type { CompactionStrategy, CompactionStrategyInput, CompactionStrategyResult, SummaryModelPort } from "./strategy.ts";
import { validSummary } from "./strategy.ts";
import { summaryInputTokens, validSummaryFormat, type SummaryFormatId, type SummaryPromptInput } from "./summary-format.ts";

function request(input: CompactionStrategyInput, content: string, previousSummary?: string, format: SummaryFormatId = "headings@1"): SummaryPromptInput {
	return { content, format: previousSummary !== undefined && format === "headings@1" ? "headings-update@1" : format,
		...(previousSummary === undefined ? {} : { previousSummary }), ...(input.focus === undefined ? {} : { focus: input.focus }) };
}
function candidate(input: CompactionStrategyInput, text: string, format: SummaryFormatId = "headings@1"): CompactionStrategyResult {
	return validSummary(text, input.limits) && validSummaryFormat(format, text)
		? { ok: true, candidate: { kind: "portable-summary", formatVersion: 1, inputDigest: input.inputDigest, text } }
		: { ok: false, code: "invalid_output" };
}
async function generate(input: CompactionStrategyInput, model: SummaryModelPort, signal: AbortSignal, value: SummaryPromptInput) {
	if (signal.aborted || Date.now() >= input.limits.deadlineMs) return { ok: false as const, code: "cancelled" as const };
	if (summaryInputTokens(value) > input.limits.maxInputTokensPerCall) return { ok: false as const, code: "input_too_large" as const };
	return model.generate({ ...value, maxOutputTokens: input.limits.maxSummaryTokens, signal });
}

export const singlePassStrategy: CompactionStrategy = {
	key: Object.freeze({ id: "single-pass", version: 1 }), outputKind: "portable-summary", formatId: "headings@1",
	async generate(input, { model, signal }) {
		const value = request(input, input.units.join("\n\n"), input.previousSummary);
		const result = await generate(input, model, signal, value);
		return result.ok ? candidate(input, result.text, value.format) : result;
	},
};

/** 顺序分组归并；前次摘要只进入第一组的独立通道，后续层从生成的摘要归并。 */
export const hierarchicalStrategy: CompactionStrategy = {
	key: Object.freeze({ id: "hierarchical", version: 1 }), outputKind: "portable-summary", formatId: "headings@1",
	async generate(input, { model, signal }) {
		let units = [...input.units];
		let previousSummary = input.previousSummary;
		for (let level = 0; level < input.limits.maxLevels; level += 1) {
			const combined = request(input, units.join("\n\n"), previousSummary);
			if (summaryInputTokens(combined) <= input.limits.maxInputTokensPerCall) {
				const result = await generate(input, model, signal, combined);
				return result.ok ? candidate(input, result.text) : result;
			}
			const groups: SummaryPromptInput[] = [];
			let content = "";
			let prior = previousSummary;
			for (const unit of units) {
				if (summaryInputTokens(request(input, unit)) > input.limits.maxInputTokensPerCall) return { ok: false, code: "input_too_large" };
				const joined = content.length === 0 ? unit : `${content}\n\n${unit}`;
				if (summaryInputTokens(request(input, joined, prior)) > input.limits.maxInputTokensPerCall) {
					const group = request(input, content, prior);
					if (summaryInputTokens(group) > input.limits.maxInputTokensPerCall) return { ok: false, code: "input_too_large" };
					groups.push(group); content = unit; prior = undefined;
				} else content = joined;
			}
			if (content.length > 0 || prior !== undefined) groups.push(request(input, content, prior));
			const summaries: string[] = [];
			for (const group of groups) {
				const result = await generate(input, model, signal, group);
				if (!result.ok) return result;
				if (!validSummary(result.text, input.limits) || !validSummaryFormat(group.format, result.text)) return { ok: false, code: "invalid_output" };
				summaries.push(result.text);
			}
			if (conservativeTokenEstimate(summaries.join("\n\n")) >= conservativeTokenEstimate([...(previousSummary === undefined ? [] : [previousSummary]), ...units].join("\n\n"))) return { ok: false, code: "budget_exhausted" };
			units = summaries; previousSummary = undefined;
		}
		return { ok: false, code: "budget_exhausted" };
	},
};

export const openAIResponsesNativeStrategy: CompactionStrategy = {
	key: { id: "openai-responses-native", version: 1 }, outputKind: "openai-responses-compaction", formatId: undefined,
	async generate(_input, context) {
		if (context.native === undefined) return { ok: false, code: "strategy_unavailable" };
		return { ok: true, candidate: await context.native.generate(context.signal) };
	},
};
