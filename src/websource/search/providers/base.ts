import type { WebSearchFetch } from "../../transport.ts";
import type { WebSearchCredentialPort } from "../../credentials.ts";
import type { WebSearchSettings } from "../../settings.ts";
import type { StructuredQuery } from "../query.ts";
import type { SearchProviderId, SearchResponse } from "../types.ts";

/**
 * Shared web search parameters passed to providers.
 *
 * `credentials` 是 provider 唯一允许的凭据来源;`fetch` 是唯一允许的出站通道
 * (受治 `Network` port 的适配层)。provider 不得直接读取进程环境、打开凭据存储
 * 或自行发起网络请求。
 */
export interface SearchParams {
	query: string;
	/**
	 * Structured view of `query`, parsed once by the search pipeline:
	 * Google-style directives (`site:`, `before:`/`after:`, `inurl:`,
	 * `intitle:`, `filetype:`, quoted phrases, `OR` groups, `-exclusions`)
	 * extracted into fields.
	 *
	 * Providers SHOULD map constraints onto native API parameters
	 * (domain/date filters) or engine query syntax (`formatQuery`) where the
	 * upstream supports them, and lean lenient otherwise: the pipeline
	 * post-filters every response with `applyQueryConstraints`, which
	 * relaxes any constraint that would eliminate all results — so a
	 * best-effort search always beats an empty one. When absent (direct
	 * provider calls), parse with `parseSearchQuery(params.query)`.
	 */
	parsedQuery?: StructuredQuery;
	limit?: number;
	/**
	 * Temporal filter narrowing results to the specified time window.
	 *
	 * Providers MUST interpret this as a pure time filter. Providers MUST NOT
	 * use recency as an implicit signal to change topic scope, content domain,
	 * or ranking strategy. If a provider API couples temporal filtering with
	 * other dimensions (e.g. Tavily's `topic=news`), the provider implementation
	 * is responsible for decoupling them before calling the upstream API.
	 *
	 * Providers that do not support temporal filtering MUST ignore this field
	 * silently; they MUST NOT approximate it by rewriting the query or altering
	 * any other request parameter.
	 */
	recency?: "day" | "week" | "month" | "year";
	/** LLM 介导 provider 的 system 提示;当前 Tier A/B 不使用。 */
	/** LLM 介导 provider 的 system 提示;当前 Tier A/B 不使用。 */
	systemPrompt?: string;
	signal?: AbortSignal;
	/** Hard timeout for this provider's search transport, in milliseconds. */
	timeoutMs?: number;
	/** 受治出站通道;由 composition 注入,provider 不得自行发起网络请求。 */
	fetch: WebSearchFetch;
	numSearchResults?: number;
	/** 凭据唯一来源;由 composition 注入。 */
	credentials: WebSearchCredentialPort;
	/** web 检索相关设置快照;未注入时按内建默认处理。 */
	settings?: WebSearchSettings;
}

/** Base class for web search providers. */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Indicates whether this provider has the credentials/config it needs to
	 * service a request right now. Implementations consult the passed
	 * {@link WebSearchCredentialPort} — never process env or a credential store.
	 *
	 * Drives auto-chain admission: providers that return `false` are skipped
	 * when {@link resolveProviderChain} walks the order. Explicit selection
	 * uses {@link isExplicitlyAvailable} instead.
	 */
	abstract isAvailable(credentials: WebSearchCredentialPort, settings?: WebSearchSettings): Promise<boolean> | boolean;

	/**
	 * Returns `true` when this provider should run when the user explicitly
	 * selects it, even if {@link isAvailable} would reject it for the auto
	 * chain. Providers that ship an unauthenticated fallback (e.g. Exa's
	 * public MCP) override this so explicit selection still routes through
	 * the fallback rather than silently falling back to another provider.
	 *
	 * Defaults to mirroring {@link isAvailable}.
	 */
	isExplicitlyAvailable(credentials: WebSearchCredentialPort, settings?: WebSearchSettings): Promise<boolean> | boolean {
		return this.isAvailable(credentials, settings);
	}

	/**
	 * Execute a search. 凭据与出站必须经 `params.credentials` 与 `params.fetch`。
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
