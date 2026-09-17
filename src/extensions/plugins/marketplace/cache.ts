/**
 * Marketplace/plugin 缓存路径（P5）。
 *
 * 缓存只放**已获取但未启用**的内容：catalog 快照与按版本落盘的 package。
 * 缓存键必须是 collision-safe 的：名字段先做保守 slug，再附一段名字的
 * digest 前缀，避免大小写或标点在文件系统上撞车（omp 只用
 * `nameSegmentCollisionKey` 检测冲突，这里直接消除冲突）。
 */

import { runtimeDigest } from "../../../runtime/protocol/foundation.ts";

/** 名字段 → 文件系统安全 slug；只保留 `[a-z0-9._-]`。 */
export function cacheSegment(value: string): string {
	const slug = value.toLocaleLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return `${slug.length === 0 ? "item" : slug.slice(0, 48)}-${runtimeDigest(value).digest.slice(0, 8)}`;
}

export interface ExtensionCachePaths {
	readonly marketplacesRoot: string;
	readonly pluginsRoot: string;
}

export function resolveExtensionCachePaths(input: { readonly pluginsRoot: string }): ExtensionCachePaths {
	return {
		marketplacesRoot: `${input.pluginsRoot}/cache/marketplaces`,
		pluginsRoot: `${input.pluginsRoot}/cache/plugins`,
	};
}

export function marketplaceCachePath(paths: ExtensionCachePaths, marketplaceName: string): string {
	return `${paths.marketplacesRoot}/${cacheSegment(marketplaceName)}`;
}

export function pluginCachePath(paths: ExtensionCachePaths, marketplaceName: string, pluginName: string, version: string): string {
	return `${paths.pluginsRoot}/${cacheSegment(marketplaceName)}___${cacheSegment(pluginName)}___${cacheSegment(version)}`;
}

/** 缓存内的 staging 目录；激活前的一切都先落这里。 */
export function cacheStagingPath(paths: ExtensionCachePaths, key: string, sequence: number): string {
	return `${paths.marketplacesRoot}/.staging/${cacheSegment(key)}-${sequence}`;
}
