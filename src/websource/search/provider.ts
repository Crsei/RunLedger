/**
 * 检索 provider 注册表。
 *
 * 上游（oh-my-pi `web/search/provider.ts`）用 `Record<id, {load: () => import(...)}>`
 * 惰性加载 24 个 provider 模块。RunLedger 的两条约束改变了实现方式：
 *
 * 1. `AGENTS.md` §4 禁止内联 `await import()`，因此注册表改成顶层静态 import；
 *    构造仍然是按需的（`instanceCache`），模块加载在启动时一次完成。
 * 2. 顺序与排除不再走模块级可变状态：上游的 `setSearchProviderOrder` /
 *    `setExcludedSearchProviders` 让全局设置影响进程内所有调用；这里改为
 *    `resolveProviderCandidates` 的入参（由 `WebSearchSettings` 提供），
 *    同一进程内可并存不同配置，也不需要 reset 钩子。
 *
 * Tier C 的 5 个 LLM 介导 provider（anthropic/codex/gemini/perplexity/xai）本期
 * 未移植：`SEARCH_PROVIDER_OPTIONS` 仍保留这些 id（设置项与后续补移植不需要迁移），
 * 但它们不在 `PROVIDER_META` 中，自动链会跳过，显式选中会得到 typed 不可用错误。
 */

import type { WebSearchCredentialPort } from "../credentials.ts";
import type { WebSearchSettings } from "../settings.ts";
import type { SearchProvider } from "./providers/base.ts";
import { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_ORDER, SearchProviderError, type SearchProviderId } from "./types.ts";
import { BraveProvider } from "./providers/brave.ts";
import { DuckDuckGoProvider } from "./providers/duckduckgo.ts";
import { EcosiaProvider } from "./providers/ecosia.ts";
import { ExaProvider } from "./providers/exa.ts";
import { FirecrawlProvider } from "./providers/firecrawl.ts";
import { GoogleProvider } from "./providers/google.ts";
import { JinaProvider } from "./providers/jina.ts";
import { KagiProvider } from "./providers/kagi.ts";
import { KimiProvider } from "./providers/kimi.ts";
import { MojeekProvider } from "./providers/mojeek.ts";
import { OllamaProvider } from "./providers/ollama.ts";
import { ParallelProvider } from "./providers/parallel.ts";
import { PublicWebProvider } from "./providers/public.ts";
import { SearXNGProvider } from "./providers/searxng.ts";
import { StartpageProvider } from "./providers/startpage.ts";
import { SyntheticProvider } from "./providers/synthetic.ts";
import { TavilyProvider } from "./providers/tavily.ts";
import { TinyFishProvider } from "./providers/tinyfish.ts";
import { ZaiProvider } from "./providers/zai.ts";

export type { SearchParams } from "./providers/base.ts";
export { SearchProvider } from "./providers/base.ts";
export { SEARCH_PROVIDER_ORDER } from "./types.ts";

type ProviderFactory = () => SearchProvider;

/** 已移植的 provider。顺序与上游 `PROVIDER_META` 保持一致的相对次序。 */
const PROVIDER_META: Partial<Record<SearchProviderId, ProviderFactory>> = {
	zai: () => new ZaiProvider(),
	exa: () => new ExaProvider(),
	tinyfish: () => new TinyFishProvider(),
	jina: () => new JinaProvider(),
	kagi: () => new KagiProvider(),
	tavily: () => new TavilyProvider(),
	firecrawl: () => new FirecrawlProvider(),
	brave: () => new BraveProvider(),
	kimi: () => new KimiProvider(),
	parallel: () => new ParallelProvider(),
	synthetic: () => new SyntheticProvider(),
	ollama: () => new OllamaProvider(),
	searxng: () => new SearXNGProvider(),
	startpage: () => new StartpageProvider(),
	duckduckgo: () => new DuckDuckGoProvider(),
	ecosia: () => new EcosiaProvider(),
	google: () => new GoogleProvider(),
	mojeek: () => new MojeekProvider(),
	public: () => new PublicWebProvider(),
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** 未在本次移植范围内的 provider（用于显式选中时的可诊断错误）。 */
export function isSearchProviderImplemented(id: SearchProviderId): boolean {
	return PROVIDER_META[id] !== undefined;
}

/** 廉价同步元数据；不触发 provider 构造。 */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return SEARCH_PROVIDER_LABELS[id] ?? id;
}

/** 把一次 provider 失败格式化为用户可见摘要。 */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError && error.provider === provider.id) return error.message;
	if (error instanceof Error) return `${provider.label}: ${error.message}`;
	return `Unknown error from ${provider.label}`;
}

/** 把有序的 fallback 失败列表格式化为一行摘要。 */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => formatSearchProviderFailure(f.error, f.provider)).join("; ");
}

/** 取（并缓存）provider 实例；未移植的 id 抛出 typed 错误。 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached !== undefined) return cached;
	const factory = PROVIDER_META[id];
	if (factory === undefined) {
		throw new SearchProviderError(id, `web search provider "${id}" is not available in this build`);
	}
	const provider = factory();
	instanceCache.set(id, provider);
	return provider;
}

export interface SearchProviderCandidate {
	readonly id: SearchProviderId;
	readonly explicit: boolean;
}

export interface ResolveProviderCandidatesOptions {
	readonly forcedProvider?: SearchProviderId;
	readonly order?: readonly SearchProviderId[];
	readonly exclude?: readonly SearchProviderId[];
}

/**
 * 按 fallback 顺序给出候选 provider，不构造任何实例。
 *
 * - `forcedProvider`（每次调用的显式选择）优先，且不受 exclude 影响（用户的显式
 *   选择覆盖设置里的排除项）；
 * - `order` 中的 id 被视为显式选择：它们经 `isExplicitlyAvailable` 判定，因此
 *   像 Exa/Parallel 这样的 keyless 兜底在显式选中时仍然可用；
 * - 未移植的 id 一律跳过，自动链不会因此变短到失败。
 */
export function resolveProviderCandidates(options: ResolveProviderCandidatesOptions = {}): SearchProviderCandidate[] {
	const { forcedProvider, order, exclude } = options;
	const excluded = new Set(exclude ?? []);
	const explicit = new Set(order ?? []);
	const ordered = order === undefined || order.length === 0
		? SEARCH_PROVIDER_ORDER
		: [
				...order.filter((id) => SEARCH_PROVIDER_ORDER.includes(id)),
				...SEARCH_PROVIDER_ORDER.filter((id) => !explicit.has(id)),
			];

	const candidates: SearchProviderCandidate[] = [];
	if (forcedProvider !== undefined && isSearchProviderImplemented(forcedProvider)) {
		candidates.push({ id: forcedProvider, explicit: true });
	}
	for (const id of ordered) {
		if (id === forcedProvider) continue;
		// 未移植的 id 一律跳过(它们既不在注册表里,构造必然抛错)。
		if (!isSearchProviderImplemented(id)) continue;
		if (excluded.has(id)) continue;
		candidates.push({ id, explicit: explicit.has(id) });
	}
	return candidates;
}

/**
 * 解析完整的可用 provider 链（会把每个候选实例化）。
 *
 * 检索执行走 {@link resolveProviderCandidates}，使 fallback 只在真正轮到时构造。
 */
export async function resolveProviderChain(
	credentials: WebSearchCredentialPort,
	settings?: WebSearchSettings,
	forcedProvider?: SearchProviderId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];
	for (const candidate of resolveProviderCandidates({ forcedProvider, ...(settings?.order === undefined ? {} : { order: settings.order }), ...(settings?.exclude === undefined ? {} : { exclude: settings.exclude }) })) {
		const provider = await getSearchProvider(candidate.id);
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(credentials, settings)
			: await provider.isAvailable(credentials, settings);
		if (available) providers.push(provider);
	}
	return providers;
}
