/** Responses 原生压缩窗口：完整保留 provider 输出，不解释 encrypted_content。 */
import { createHash } from "node:crypto";
import type { ResponseInputItem } from "openai/resources/responses/responses.js";

export interface OpenAICompactionState {
	readonly kind: "openai-responses-compaction";
	readonly formatVersion: 1;
	readonly provider: string;
	readonly model: string;
	readonly endpointDigest: string;
	readonly output: readonly ResponseInputItem[];
	readonly estimatedTokens: number;
}
export function compactionEndpointDigest(baseUrl: string): string { return createHash("sha256").update(baseUrl.replace(/\/$/u, "")).digest("hex"); }

export function isOpenAICompactionState(value: unknown): value is OpenAICompactionState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	if (Object.keys(state).sort().join() !== "endpointDigest,estimatedTokens,formatVersion,kind,model,output,provider"
		|| state.kind !== "openai-responses-compaction" || state.formatVersion !== 1 || state.provider !== "openai"
		|| typeof state.model !== "string" || state.model.length < 1 || state.model.length > 256
		|| typeof state.endpointDigest !== "string" || !/^[a-f0-9]{64}$/u.test(state.endpointDigest)
		|| !Number.isSafeInteger(state.estimatedTokens) || (state.estimatedTokens as number) < 1
		|| !Array.isArray(state.output) || state.output.length < 1 || state.output.length > 100_000) return false;
	let compactions = 0;
	for (const item of state.output) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
		if (item.type === "compaction") {
			if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) return false;
			compactions += 1;
		} else if (item.type === "message" || item.type === undefined) {
			if ((item.role !== "user" && item.role !== "assistant") || (typeof item.content !== "string" && !Array.isArray(item.content))) return false;
		} else if (!["reasoning", "function_call", "function_call_output"].includes(item.type)) return false;
	}
	return compactions >= 1;
}
