/**
 * 检索执行：候选 provider 链、约束后处理与 LLM 文本格式化。
 *
 * 来源：oh-my-pi `web/search/index.ts` 的 `executeSearch` / `formatForLLM` /
 * `hasRenderableSearchContent`（快照 `1c0303b1`）。上游把这段逻辑内联在 TUI 工具
 * 类旁边；RunLedger 拆成库层函数，工具只做参数校验与结果包装。
 *
 * 与上游的差异：
 * - 依赖从工具会话/全局设置改为显式入参（`credentials` / `settings` / `fetch`）；
 * - 未移植的 provider 显式选中时给出 typed 错误，不静默换 provider；
 * - 取消（`signal` abort）优先于 provider 失败，向上抛出而不是被吞成失败摘要。
 */

import type { WebSearchCredentialPort } from "../credentials.ts";
import { webSearchTimeoutMs, type WebSearchSettings } from "../settings.ts";
import type { WebSearchFetch } from "../transport.ts";
import { formatAge } from "../scrapers/format.ts";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getSearchProvider,
	getSearchProviderLabel,
	isSearchProviderImplemented,
	resolveProviderCandidates,
	type SearchProvider,
	type SearchProviderCandidate,
} from "./provider.ts";
import { applyQueryConstraints, parseSearchQuery } from "./query.ts";
import { SearchProviderError, type SearchProviderId, type SearchResponse } from "./types.ts";

/** 工具/CLI 传入的检索查询。 */
export interface SearchQueryParams {
	readonly query: string;
	readonly recency?: "day" | "week" | "month" | "year";
	readonly limit?: number;
	readonly num_search_results?: number;
	readonly provider?: SearchProviderId | "auto";
}

export interface ExecuteSearchOptions {
	readonly credentials: WebSearchCredentialPort;
	readonly fetch: WebSearchFetch;
	readonly settings?: WebSearchSettings;
	readonly signal?: AbortSignal;
}

export interface ExecuteSearchResult {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details: { readonly response: SearchResponse; readonly error?: string };
}

/** 截断文本用于工具输出。 */
function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

/** 格式化为 LLM 可读文本；`notes`（例如约束被放宽的提示）置于最前。 */
export function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) parts.push(`Note: ${note}`);

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, src] of response.sources.entries()) {
		const age = formatAge(src.ageSeconds) || src.publishedDate;
		const agePart = age ? ` (${age})` : "";
		parts.push(`[${i + 1}] ${src.title}${agePart}\n    ${src.url}`);
		if (src.snippet) parts.push(`    ${truncateText(src.snippet, 240)}`);
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			const title = citation.title || citation.url;
			parts.push(`[${i + 1}] ${title}\n    ${citation.url}`);
			if (citation.citedText) parts.push(`    ${truncateText(citation.citedText, 240)}`);
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const question of response.relatedQuestions) parts.push(`- ${question}`);
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) parts.push(`- ${truncateText(query, 120)}`);
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some((question) => question.trim())) return true;
	if (response.searchQueries?.some((query) => query.trim())) return true;
	return false;
}

/** 按 fallback 顺序执行检索；第一个产生可渲染内容的 provider 胜出。 */
export async function executeSearch(
	params: SearchQueryParams,
	options: ExecuteSearchOptions,
): Promise<ExecuteSearchResult> {
	const { credentials, fetch, settings, signal } = options;
	const explicitProvider = params.provider;

	let candidates: SearchProviderCandidate[];
	if (explicitProvider !== undefined && explicitProvider !== "auto") {
		if (!isSearchProviderImplemented(explicitProvider)) {
			throw new SearchProviderError(
				explicitProvider,
				`web search provider "${explicitProvider}" is not available in this build`,
			);
		}
		candidates = [{ id: explicitProvider, explicit: true }];
	} else {
		candidates = resolveProviderCandidates({
			...(settings?.order === undefined ? {} : { order: settings.order }),
			...(settings?.exclude === undefined ? {} : { exclude: settings.exclude }),
		});
	}

	const parsedQuery = parseSearchQuery(params.query);
	const timeoutMs = webSearchTimeoutMs(settings);

	const failures: Array<{ provider: Pick<SearchProvider, "id" | "label">; error: unknown }> = [];
	let availableProviderCount = 0;
	let lastProvider: Pick<SearchProvider, "id" | "label"> | undefined;

	for (const candidate of candidates) {
		let provider: SearchProvider | undefined;
		const providerMeta = { id: candidate.id, label: getSearchProviderLabel(candidate.id) };
		lastProvider = providerMeta;
		try {
			provider = await getSearchProvider(candidate.id);
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(credentials, settings)
				: await provider.isAvailable(credentials, settings);
			if (!available && !candidate.explicit) continue;
			if (!available && candidate.explicit) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
				);
			}
			availableProviderCount += 1;
			lastProvider = provider;

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				...(params.limit === undefined ? {} : { limit: params.limit }),
				...(params.recency === undefined ? {} : { recency: params.recency }),
				...(params.num_search_results === undefined ? {} : { numSearchResults: params.num_search_results }),
				...(signal === undefined ? {} : { signal }),
				timeoutMs,
				fetch,
				credentials,
				...(settings === undefined ? {} : { settings }),
			});

			// 宽松约束后处理：provider 未能（或只能部分）兑现的 site:/inurl:/intitle:/
			// filetype:/日期 指令在这里过滤，任何会清空结果集的维度都被放宽并报告。
			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			return {
				content: [{ type: "text", text: formatForLLM(finalResponse, constraintNotes) }],
				details: { response: finalResponse },
			};
		} catch (error) {
			// 用户取消优先：abort 不该被当成 provider 失败，也不该继续 fallback。
			if (signal?.aborted) throw error;
			failures.push({ provider: provider ?? providerMeta, error });
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: { response: { provider: "none", sources: [] }, error: message },
		};
	}

	const lastFailure = failures[failures.length - 1];
	const baseMessage = lastFailure
		? formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1 ? `All web search providers failed: ${formatSearchProviderFailures(failures)}` : baseMessage;

	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: {
			response: { provider: lastFailure?.provider.id ?? lastProvider?.id ?? "none", sources: [] },
			error: message,
		},
	};
}
