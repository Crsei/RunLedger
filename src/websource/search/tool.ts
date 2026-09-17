/**
 * `web_search` 工具定义。
 *
 * 来源：oh-my-pi `web/search/index.ts` 的 `webSearchSchema` / `WebSearchTool`
 * （快照 `1c0303b1`）。上游把 schema 声明为 arktype 并把工具绑到 `ToolSession`
 * 与 TUI renderer；RunLedger 用 TypeBox 声明 schema，执行只依赖注入的
 * transport / 凭据 / 设置，渲染交给 TUI 与 Web 各自的展示层。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { WebSearchCredentialPort } from "../credentials.ts";
import type { WebSearchSettings } from "../settings.ts";
import type { WebSearchFetch } from "../transport.ts";
import type { AgentTool } from "../../runtime/types.ts";
import { executeSearch, type SearchQueryParams } from "./execute.ts";
import { WEB_SEARCH_DESCRIPTION } from "./prompt.ts";
import type { SearchProviderId, SearchResponse } from "./types.ts";
import { isSearchProviderId } from "./types.ts";
import { SEARCH_PROVIDER_ORDER } from "./types.ts";

export const webSearchSchema = Type.Object({
	query: Type.String({
		description:
			"检索词。支持 Google 风格指令：site:/-site:、after:/before:(YYYY-MM-DD)、inurl:、intitle:、filetype:、\"exact phrase\"、-term、OR。",
		minLength: 1,
		maxLength: 4096,
	}),
	recency: Type.Optional(
		Type.Union(
			[Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
			{ description: "按发布时间收窄结果。" },
		),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "结果条数上限。" })),
	num_search_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "结果条数上限。" })),
	provider: Type.Optional(
		Type.String({ description: `指定 provider;缺省 auto 按配置顺序回退。可选值:${SEARCH_PROVIDER_ORDER.join(", ")}。` }),
	),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

export interface WebSearchDetails {
	readonly response: SearchResponse;
	readonly error?: string;
}

export interface WebSearchToolOptions {
	readonly fetch: WebSearchFetch;
	readonly credentials: WebSearchCredentialPort;
	readonly settings?: WebSearchSettings;
}

export function createWebSearchTool(options: WebSearchToolOptions): AgentTool<typeof webSearchSchema, WebSearchDetails> {
	return {
		name: "web_search",
		label: "Web Search",
		description: WEB_SEARCH_DESCRIPTION,
		parameters: webSearchSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		async execute(_toolCallId, params, signal): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: WebSearchDetails;
			isError?: boolean;
		}> {
			// `provider` 在 schema 里是自由字符串（上游同样如此，以兼容设置里保存的
			// 历史值）；非法值不能静默降级成 auto，否则用户以为指定了引擎。
			const requested = params.provider;
			if (requested !== undefined && requested !== "auto" && !isSearchProviderId(requested)) {
				throw new Error(`web_search: unknown provider "${requested}"`);
			}
			const query: SearchQueryParams = {
				query: params.query,
				...(params.recency === undefined ? {} : { recency: params.recency }),
				...(params.limit === undefined ? {} : { limit: params.limit }),
				...(params.num_search_results === undefined ? {} : { num_search_results: params.num_search_results }),
				...(requested === undefined ? {} : { provider: requested as SearchProviderId | "auto" }),
			};
			const result = await executeSearch(query, {
				credentials: options.credentials,
				fetch: options.fetch,
				...(options.settings === undefined ? {} : { settings: options.settings }),
				...(signal === undefined ? {} : { signal }),
			});
			const details: WebSearchDetails = result.details;
			return {
				content: [...result.content],
				details,
				...(details.error === undefined ? {} : { isError: true }),
			};
		},
	};
}
