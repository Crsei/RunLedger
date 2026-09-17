/**
 * websource 设置 port。
 *
 * 上游 `web/search` 与两个 provider 直接调用全局 `settings.get(...)`
 * （`providers.webSearchOrder` / `webSearchExclude` / `webSearchTimeoutSeconds` /
 * `searxng.*` / `exa.*`）。RunLedger 的设置由 composition 解析，库级模块不持有
 * 全局设置单例，因此这里只暴露不可变快照 + 一个同步取值函数。
 */

import {
	DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS,
	MAX_WEB_SEARCH_TIMEOUT_SECONDS,
	type SearchProviderId,
} from "./search/types.ts";

export interface SearxngSettings {
	readonly endpoint?: string;
	readonly token?: string;
	readonly basicUsername?: string;
	readonly basicPassword?: string;
	readonly engines?: readonly string[];
	readonly categories?: readonly string[];
	readonly language?: string;
	readonly safesearch?: number;
}

export interface ExaSettings {
	readonly enabled?: boolean;
	readonly searchDelayMs?: number;
}

export interface KimiSettings {
	/** 覆盖 Kimi Code 检索端点（自建网关/区域端点）。 */
	readonly baseUrl?: string;
}

export interface WebSearchSettings {
	/** 优先 provider 列表；空表示使用内建顺序。 */
	readonly order?: readonly SearchProviderId[];
	/** 永不使用的 provider（自动链与 Public Web fan-out 都遵守）。 */
	readonly exclude?: readonly SearchProviderId[];
	/** 单次 provider 传输的硬超时（秒）；上限 300。 */
	readonly timeoutSeconds?: number;
	readonly searxng?: SearxngSettings;
	readonly exa?: ExaSettings;
	readonly kimi?: KimiSettings;
}

export interface WebSearchSettingsPort {
	get(): WebSearchSettings | undefined;
}

export function emptyWebSearchSettings(): WebSearchSettingsPort {
	return { get: () => undefined };
}

/** 有效硬超时（毫秒）；未配置或非法时取上游默认 60s，并夹到 300s 上限。 */
export function webSearchTimeoutMs(settings: WebSearchSettings | undefined): number {
	const seconds = settings?.timeoutSeconds;
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
		return DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS * 1000;
	}
	return Math.ceil(Math.min(seconds, MAX_WEB_SEARCH_TIMEOUT_SECONDS) * 1000);
}
