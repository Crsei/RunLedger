/**
 * S8.2 拆分:chat_template_kwargs 构造(thinking 模板参数)。
 */

import type { ChatTemplateKwargValue, Model } from "../../types.ts";
import type { ResolvedOpenAICompletionsCompat } from "./compat-detection.ts";
import type { OpenAICompletionsOptions } from "./types.ts";

export type ResolvedChatTemplateKwargValue = string | number | boolean | null;

export function buildChatTemplateKwargs(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	compat: ResolvedOpenAICompletionsCompat,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const kwargs: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(compat.chatTemplateKwargs)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value);
		if (resolved !== undefined) {
			kwargs[key] = resolved;
		}
	}

	return Object.keys(kwargs).length > 0 ? kwargs : undefined;
}

export function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}
