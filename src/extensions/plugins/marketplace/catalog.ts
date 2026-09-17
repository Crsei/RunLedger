/**
 * Marketplace catalog 的读取与条目解析（P5）。
 *
 * 查找顺序与 Claude 兼容：`.runledger-plugin/marketplace.json` 优先，
 * `.omp-plugin/marketplace.json` 次之，`.claude-plugin/marketplace.json` 回退。
 * catalog 只描述“有什么”，不安装任何东西：条目 source 仍要经过
 * `resolveExtensionSource` 的 containment 与 npm 拒绝。
 */

import { Value } from "typebox/value";
import { MarketplaceCatalogSchema } from "../../../contracts/extensions/marketplace.ts";
import type { MarketplaceCatalog, MarketplacePluginEntry, MarketplacePluginSource } from "../../../contracts/extensions/marketplace.ts";
import type { ExtensionStoragePort } from "../../storage-port.ts";
import { resolveExtensionSource } from "./source-resolver.ts";
import type { ExtensionSourceResolution } from "./source-resolver.ts";

export const MARKETPLACE_CATALOG_MAX_BYTES = 4 * 1024 * 1024;

/** 与 contracts 中的顺序保持一致；这里给出可直接消费的常量。 */
export const MARKETPLACE_CATALOG_LOOKUP = Object.freeze([
	".runledger-plugin/marketplace.json",
	".omp-plugin/marketplace.json",
	".claude-plugin/marketplace.json",
] as const);

export type MarketplaceCatalogLoad =
	| { readonly ok: true; readonly catalog: MarketplaceCatalog; readonly catalogPath: string }
	| { readonly ok: false; readonly code: "missing" | "invalid" | "unavailable"; readonly message: string };

/**
 * 按回退顺序读取第一个存在的 catalog。文件存在但不是合法 catalog 是错误，
 * 不静默跳到下一个候选：否则一个坏 catalog 会被另一个无关 catalog 顶替。
 */
export async function loadMarketplaceCatalog(storage: ExtensionStoragePort, rootPath: string): Promise<MarketplaceCatalogLoad> {
	for (const relative of MARKETPLACE_CATALOG_LOOKUP) {
		const path = `${rootPath}/${relative}`;
		const info = await storage.stat(path);
		if (!info.ok || info.value.kind !== "file") continue;
		// 第一个**存在**的候选就是权威：它损坏就报错，不回退到下一个候选。
		// 否则一个坏的自有 catalog 会被无关的 Claude catalog 悄悄顶替。
		const read = await storage.readFile(path, MARKETPLACE_CATALOG_MAX_BYTES);
		if (!read.ok) return { ok: false, code: read.code === "oversize" ? "invalid" : "unavailable", message: `marketplace catalog could not be read: ${relative}` };
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(read.value)) as unknown;
		} catch {
			return { ok: false, code: "invalid", message: `${relative} is not valid JSON` };
		}
		if (!Value.Check(MarketplaceCatalogSchema, parsed)) {
			return { ok: false, code: "invalid", message: `${relative} does not match the marketplace catalog contract` };
		}
		return { ok: true, catalog: parsed as MarketplaceCatalog, catalogPath: path };
	}
	return { ok: false, code: "missing", message: "marketplace root does not contain a catalog" };
}

export function findMarketplacePlugin(catalog: MarketplaceCatalog, name: string): MarketplacePluginEntry | undefined {
	return catalog.plugins.find((entry) => entry.name === name);
}

/**
 * 解析条目 source。`metadata.pluginRoot` 会前置到相对 source 上，再交给
 * source-resolver 做 containment 与 npm 拒绝。
 */
export function resolveMarketplacePluginSource(catalog: MarketplaceCatalog, entry: MarketplacePluginEntry, catalogRoot: string): ExtensionSourceResolution {
	const base = catalog.metadata?.pluginRoot === undefined ? catalogRoot : `${catalogRoot}/${catalog.metadata.pluginRoot.replace(/^\.\//u, "")}`;
	const source: MarketplacePluginSource | string = entry.source;
	if (typeof source === "string" && catalog.metadata?.pluginRoot !== undefined) {
		return resolveExtensionSource(`./${catalog.metadata.pluginRoot.replace(/^\.\//u, "")}/${source.replace(/^\.\//u, "")}`, catalogRoot);
	}
	return resolveExtensionSource(source, base);
}

/** 版本解析顺序（§2.2 复刻）：catalog 声明优先，其次 manifest，最后占位。 */
export function resolveCatalogVersion(entry: MarketplacePluginEntry, manifestVersion: string | undefined): string {
	return entry.version ?? manifestVersion ?? "0.0.0";
}
