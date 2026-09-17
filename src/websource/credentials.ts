/**
 * websource 凭据 port。
 *
 * 上游 provider 通过 `AuthStorage`（`@oh-my-pi/pi-ai`）取 key，`isAvailable` 再用
 * `getEnvApiKey` 兜底环境变量。RunLedger 的工具面**没有**凭据 port，且模型侧工具
 * 不得自行读取进程环境（`src/security/toolchain.ts` 的 `DENIED_ENV` 语义），因此
 * 这里定义 composition 注入的窄接口：
 *
 * - 存储值由 composition 从用户级 `auth.json`（`CredentialStore.read(id)`）读出；
 * - 环境变量只由 composition 按 `WEB_SEARCH_ENV_KEYS` 白名单读取后注入；
 * - `src/websource/**` 内不得出现 `process.env` / `Bun.env` 直读。
 */

export type WebSearchCredentialId =
	| "tavily" | "brave" | "jina" | "kagi" | "firecrawl" | "exa" | "parallel"
	| "synthetic" | "ollama-cloud" | "tinyfish" | "kimi-code" | "zai" | "github";

/**
 * 每个凭据 id 对应的环境变量名，顺序即优先级。与上游 `getEnvApiKey(provider)`
 * 及各 provider `isAvailable` 的取值一致；`github` 用于站点抓取的 API 调用。
 */
export const WEB_SEARCH_ENV_KEYS: Readonly<Record<WebSearchCredentialId, readonly string[]>> = {
	tavily: ["TAVILY_API_KEY"],
	brave: ["BRAVE_API_KEY"],
	jina: ["JINA_API_KEY"],
	kagi: ["KAGI_API_KEY"],
	firecrawl: ["FIRECRAWL_API_KEY"],
	exa: ["EXA_API_KEY"],
	parallel: ["PARALLEL_API_KEY"],
	synthetic: ["SYNTHETIC_API_KEY"],
	"ollama-cloud": ["OLLAMA_CLOUD_API_KEY"],
	tinyfish: ["TINYFISH_API_KEY"],
	"kimi-code": ["KIMI_SEARCH_API_KEY", "MOONSHOT_SEARCH_API_KEY"],
	zai: ["ZAI_API_KEY"],
	github: ["GITHUB_TOKEN", "GH_TOKEN"],
};

/** Firecrawl 自定义端点的环境变量（不是凭据，但同属 composition 注入的部署配置）。 */
export const FIRECRAWL_BASE_URL_ENV_KEYS: readonly string[] = ["FIRECRAWL_BASE_URL", "FIRECRAWL_API_URL"];
/** SearXNG 端点与可选认证。 */
export const SEARXNG_ENV_KEYS = Object.freeze({
	endpoint: ["SEARXNG_ENDPOINT"],
	token: ["SEARXNG_TOKEN"],
	basicUsername: ["SEARXNG_BASIC_USERNAME"],
	basicPassword: ["SEARXNG_BASIC_PASSWORD"],
});

export interface WebSearchCredentialPort {
	/** 该 id 当前是否可用（存储值或白名单环境变量之一存在）。 */
	has(id: WebSearchCredentialId): Promise<boolean>;
	/** 解析后的 API key；不可用时返回 `undefined`。 */
	getApiKey(id: WebSearchCredentialId): Promise<string | undefined>;
	/** 部署配置值（端点等）；未配置时返回 `undefined`。 */
	getConfig(id: string): Promise<string | undefined>;
}

/** 无凭据环境（库级默认；生产必须注入真实 port）。 */
export function unavailableWebSearchCredentials(): WebSearchCredentialPort {
	return {
		has: async () => false,
		getApiKey: async () => undefined,
		getConfig: async () => undefined,
	};
}

/**
 * 上游 `providers/utils.ts:findCredential` 的替代：按 id 取 key，缺失时抛出
 * 带修复指引的错误，而不是把无认证请求发到上游。
 */
export async function withApiKey<T>(
	credentials: WebSearchCredentialPort,
	id: WebSearchCredentialId,
	missingKeyMessage: string,
	operation: (apiKey: string) => Promise<T>,
): Promise<T> {
	const apiKey = await credentials.getApiKey(id);
	if (apiKey === undefined || apiKey.trim().length === 0) throw new Error(missingKeyMessage);
	return operation(apiKey);
}
