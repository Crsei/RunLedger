/**
 * Marketplace catalog 的获取（P5、D7）。
 *
 * 本地 marketplace 直接原地读取；git/url marketplace 由注入的受治
 * materializer 拉到 cache staging，校验 catalog 可解析后再原子激活到
 * `<cache>/marketplaces/<name>`。**默认无网络**：没有 materializer 或它拒绝时
 * 明确失败，不回退到本地猜测路径。
 */

import { canonicalDigest } from "../../../runtime/protocol/canonical-json.ts";
import { loadMarketplaceCatalog } from "./catalog.ts";
import type { MarketplaceCatalogLoad } from "./catalog.ts";
import { marketplaceCachePath, cacheStagingPath } from "./cache.ts";
import type { ExtensionCachePaths } from "./cache.ts";
import type { ExtensionDistributionPort } from "../distribution-port.ts";
import type { ExtensionSourceMaterializer } from "../installer.ts";
import { resolveExtensionSource } from "./source-resolver.ts";

export interface MarketplaceFetchRequest {
	readonly name: string;
	readonly sourceType: "github" | "git" | "url" | "local";
	readonly sourceUri: string;
	readonly signal?: AbortSignal;
}

export type MarketplaceFetchResult =
	| { readonly ok: true; readonly rootPath: string; readonly catalog: MarketplaceCatalogLoad & { readonly ok: true }; readonly catalogDigest: string; readonly fromCache: boolean }
	| { readonly ok: false; readonly code: "source_invalid" | "materialize_failed" | "catalog_invalid" | "cache_failed"; readonly message: string };

export interface MarketplaceFetcherOptions {
	readonly storage: ExtensionDistributionPort;
	readonly cache: ExtensionCachePaths;
	readonly materializer: ExtensionSourceMaterializer;
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

export class MarketplaceFetcher {
	readonly #options: MarketplaceFetcherOptions;
	#sequence = 0;

	public constructor(options: MarketplaceFetcherOptions) {
		this.#options = options;
	}

	/** 解析并获取 catalog，返回可读取的根目录与解析结果。 */
	public async fetch(request: MarketplaceFetchRequest, options: { readonly refresh?: boolean } = {}): Promise<MarketplaceFetchResult> {
		const cached = marketplaceCachePath(this.#options.cache, request.name);

		if (request.sourceType === "local") {
			// 本地 marketplace 不复制：用户期望看到的是自己目录里的实时内容。
			const resolved = resolveExtensionSource(request.sourceUri.startsWith("./") ? request.sourceUri : `./${request.sourceUri}`, "/");
			const rootPath = resolved.ok && resolved.source.kind === "local" ? resolved.source.path : request.sourceUri;
			const catalog = await loadMarketplaceCatalog(this.#options.storage, rootPath);
			if (!catalog.ok) return { ok: false, code: "catalog_invalid", message: catalog.message };
			return { ok: true, rootPath, catalog, catalogDigest: canonicalDigest(catalog.catalog), fromCache: false };
		}

		if (options.refresh !== true) {
			const cachedCatalog = await loadMarketplaceCatalog(this.#options.storage, cached);
			if (cachedCatalog.ok) return { ok: true, rootPath: cached, catalog: cachedCatalog, catalogDigest: canonicalDigest(cachedCatalog.catalog), fromCache: true };
		}

		const resolved = resolveExtensionSource({ source: "url", url: request.sourceUri }, "/");
		if (!resolved.ok || resolved.source.kind !== "git") return { ok: false, code: "source_invalid", message: "marketplace source must be an https git url" };

		this.#sequence += 1;
		const staging = cacheStagingPath(this.#options.cache, request.name, this.#sequence);
		const materialized = await this.#options.materializer.materialize({
			source: resolved.source,
			destination: staging,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		if (!materialized.ok) {
			await this.#options.storage.remove(staging, { recursive: true }).catch(() => undefined);
			return { ok: false, code: "materialize_failed", message: materialized.message };
		}
		const catalog = await loadMarketplaceCatalog(this.#options.storage, staging);
		if (!catalog.ok) {
			await this.#options.storage.remove(staging, { recursive: true }).catch(() => undefined);
			return { ok: false, code: "catalog_invalid", message: catalog.message };
		}
		await this.#options.storage.remove(cached, { recursive: true }).catch(() => undefined);
		const activated = await this.#options.storage.rename(staging, cached);
		if (!activated.ok) {
			await this.#options.storage.remove(staging, { recursive: true }).catch(() => undefined);
			return { ok: false, code: "cache_failed", message: activated.message };
		}
		return { ok: true, rootPath: cached, catalog, catalogDigest: canonicalDigest(catalog.catalog), fromCache: false };
	}
}
