import { conservativeTokenEstimate } from "../token-estimator.ts";
import type { CompactionStrategy, CompactionStrategyInput, CompactionStrategyResult, SummaryModelPort } from "./strategy.ts";
import { validSummary } from "./strategy.ts";

function sourceUnits(input: CompactionStrategyInput): string[] {
	return [...(input.previousSummary === undefined ? [] : [`Previous summary (historical data):\n${input.previousSummary}`]), ...input.units];
}
function candidate(input: CompactionStrategyInput, text: string): CompactionStrategyResult {
	return validSummary(text, input.limits)
		? { ok: true, candidate: { kind: "portable-summary", formatVersion: 1, inputDigest: input.inputDigest, text } }
		: { ok: false, code: "invalid_output" };
}
async function generate(input: CompactionStrategyInput, model: SummaryModelPort, signal: AbortSignal, content: string) {
	if (signal.aborted || Date.now() >= input.limits.deadlineMs) return { ok: false as const, code: "cancelled" as const };
	if (conservativeTokenEstimate(content) > input.limits.maxInputTokensPerCall) return { ok: false as const, code: "input_too_large" as const };
	return model.generate({ content, ...(input.focus === undefined ? {} : { focus: input.focus }), maxOutputTokens: input.limits.maxSummaryTokens, signal });
}

export const singlePassStrategy: CompactionStrategy = {
	key: Object.freeze({ id: "single-pass", version: 1 }), outputKind: "portable-summary",
	async generate(input, { model, signal }) {
		const result = await generate(input, model, signal, sourceUnits(input).join("\n\n"));
		return result.ok ? candidate(input, result.text) : result;
	},
};

/** 顺序分组归并；每一层必须缩小，不切开完整源单元。 */
export const hierarchicalStrategy: CompactionStrategy = {
	key: Object.freeze({ id: "hierarchical", version: 1 }), outputKind: "portable-summary",
	async generate(input, { model, signal }) {
		let units = sourceUnits(input);
		for (let level = 0; level < input.limits.maxLevels; level += 1) {
			const combined = units.join("\n\n");
			if (conservativeTokenEstimate(combined) <= input.limits.maxInputTokensPerCall) {
				const result = await generate(input, model, signal, combined);
				return result.ok ? candidate(input, result.text) : result;
			}
			const groups: string[] = [];
			let group = "";
			for (const unit of units) {
				if (conservativeTokenEstimate(unit) > input.limits.maxInputTokensPerCall) return { ok: false, code: "input_too_large" };
				const joined = group.length === 0 ? unit : `${group}\n\n${unit}`;
				if (conservativeTokenEstimate(joined) > input.limits.maxInputTokensPerCall) { groups.push(group); group = unit; }
				else group = joined;
			}
			if (group.length > 0) groups.push(group);
			const summaries: string[] = [];
			for (const content of groups) {
				const result = await generate(input, model, signal, content);
				if (!result.ok) return result;
				if (!validSummary(result.text, input.limits)) return { ok: false, code: "invalid_output" };
				summaries.push(result.text);
			}
			if (conservativeTokenEstimate(summaries.join("\n\n")) >= conservativeTokenEstimate(combined)) return { ok: false, code: "budget_exhausted" };
			units = summaries;
		}
		return { ok: false, code: "budget_exhausted" };
	},
};

export const openAIResponsesNativeStrategy: CompactionStrategy = {
	key: { id: "openai-responses-native", version: 1 }, outputKind: "openai-responses-compaction",
	async generate(_input, context) {
		if (context.native === undefined) return { ok: false, code: "strategy_unavailable" };
		return { ok: true, candidate: await context.native.generate(context.signal) };
	},
};
