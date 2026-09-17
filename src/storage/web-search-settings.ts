/**
 * web 检索设置的解析。
 *
 * `ProjectSettings.webSearch` 是用户/工作区可写的原始形状（字符串数组、秒数），
 * `WebSearchSettings` 是库层消费的有效快照（校验过的 provider id、毫秒）。本模块
 * 负责两者之间的转换与收窄:未识别的 provider id 一律丢弃,而不是让一个拼错的
 * 名字悄悄影响 fallback 顺序。
 */

import type { WebSearchSettings as RawWebSearchSettings } from "./settings-manager.ts";
import { isSearchProviderId } from "../websource/search/types.ts";
import type { SearxngSettings, WebSearchSettings } from "../websource/settings.ts";

export function toWebSearchSettings(raw: RawWebSearchSettings): WebSearchSettings {
	const order = raw.order?.filter(isSearchProviderId);
	const exclude = raw.exclude?.filter(isSearchProviderId);
	const searxng = toSearxngSettings(raw.searxng);
	return {
		...(order === undefined || order.length === 0 ? {} : { order }),
		...(exclude === undefined || exclude.length === 0 ? {} : { exclude }),
		...(raw.timeoutSeconds === undefined ? {} : { timeoutSeconds: raw.timeoutSeconds }),
		...(searxng === undefined ? {} : { searxng }),
	};
}

function toSearxngSettings(raw: RawWebSearchSettings["searxng"]): SearxngSettings | undefined {
	if (raw === undefined) return undefined;
	const settings: SearxngSettings = {
		...(raw.endpoint === undefined ? {} : { endpoint: raw.endpoint }),
		...(raw.token === undefined ? {} : { token: raw.token }),
		...(raw.basicUsername === undefined ? {} : { basicUsername: raw.basicUsername }),
		...(raw.basicPassword === undefined ? {} : { basicPassword: raw.basicPassword }),
		...(raw.engines === undefined ? {} : { engines: raw.engines }),
		...(raw.categories === undefined ? {} : { categories: raw.categories }),
		...(raw.language === undefined ? {} : { language: raw.language }),
		...(raw.safesearch === undefined ? {} : { safesearch: raw.safesearch }),
	};
	return Object.keys(settings).length === 0 ? undefined : settings;
}
