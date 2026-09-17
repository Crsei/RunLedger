/**
 * Marketplace manager（P5、P6 的命令后端）。
 *
 * 职责：注册/移除 marketplace、从 catalog 安装 plugin、列出已安装（含 scope
 * 遮蔽）、检测可更新项，并把 autoUpdate 模式解析成**用户可见**的行为。
 *
 * 边界：
 *   - 不 clone、不跑包管理器：获取交给 `MarketplaceFetcher`（受治
 *     materializer），安装交给 `ExtensionInstaller`（staging → 原子激活）。
 *   - `notify` 模式必须有可见出口；没有可见出口时降级为 `off`，不允许
 *     “配置项说谎”（D10）。
 *   - 已安装列表同时返回 user 与 workspace，并显式标注被遮蔽项。
 */

import type { MarketplaceRegistryEntry, MarketplaceSourceType, RunledgerPluginRecord } from "../../../contracts/extensions/marketplace.ts";
import { runtimeDigest } from "../../../runtime/protocol/foundation.ts";
import type { ExtensionInstaller, ExtensionInstallReceipt } from "../installer.ts";
import type { ExtensionDistributionRegistry } from "./registry.ts";
import { applyScopeShadowing } from "./registry.ts";
import type { MarketplaceFetcher, MarketplaceFetchRequest } from "./fetcher.ts";
import { findMarketplacePlugin, resolveCatalogVersion, resolveMarketplacePluginSource } from "./catalog.ts";
import { parseExtensionInstallSpec } from "./source-resolver.ts";

export const MARKETPLACE_AUTO_UPDATE_MODES = Object.freeze(["off", "notify", "auto"] as const);
export type MarketplaceAutoUpdateMode = (typeof MARKETPLACE_AUTO_UPDATE_MODES)[number];

export type MarketplaceManagerCode =
	| "marketplace_exists"
	| "marketplace_missing"
	| "marketplace_invalid"
	| "plugin_not_found"
	| "registry_invalid"
	| "install_failed";

export interface MarketplaceManagerOptions {
	readonly registry: ExtensionDistributionRegistry;
	readonly fetcher: MarketplaceFetcher;
	readonly installer: ExtensionInstaller;
	/** user/workspace 各自可见的 marketplace 名；workspace 可遮蔽同名 user。 */
	readonly scope: () => "user" | "workspace";
}

export interface MarketplaceAddRequest {
	readonly name: string;
	readonly sourceType: MarketplaceSourceType;
	readonly sourceUri: string;
	readonly refresh?: boolean;
}

export interface InstalledPluginView {
	readonly packageId: string;
	readonly name: string;
	readonly version: string;
	readonly digest: string;
	readonly scope: "user" | "project";
	readonly enabled: boolean;
	readonly marketplace?: string;
	readonly shadowed: boolean;
}

export interface PendingUpdate {
	readonly packageId: string;
	readonly name: string;
	readonly installedVersion: string;
	readonly availableVersion: string;
	readonly marketplace: string;
}

export interface MarketplaceView {
	readonly name: string;
	readonly sourceType: MarketplaceSourceType;
	readonly sourceUri: string;
	readonly catalogPath: string;
	readonly updatedAt: string;
}

export type MarketplaceManagerResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly code: MarketplaceManagerCode; readonly message: string };

function ok<T>(value: T): MarketplaceManagerResult<T> {
	return { ok: true, value };
}

function fail<T>(code: MarketplaceManagerCode, message: string): MarketplaceManagerResult<T> {
	return { ok: false, code, message };
}

/**
 * 解析 autoUpdate 的实际行为：`notify` 需要真实可见出口（TUI 通知或 CLI
 * 可查询的 pending 列表）。没有出口时降级为 `off`，并把降级原因回给调用方。
 */
export function resolveAutoUpdateMode(input: {
	readonly configured: MarketplaceAutoUpdateMode;
	readonly hasVisibleChannel: boolean;
	readonly pendingUpdates: number;
}): { readonly effective: MarketplaceAutoUpdateMode; readonly degraded: boolean; readonly reason?: string } {
	if (input.configured === "notify" && !input.hasVisibleChannel) {
		return { effective: "off", degraded: true, reason: "notify requires a visible channel; degraded to off" };
	}
	return { effective: input.configured, degraded: false, ...(input.pendingUpdates > 0 ? {} : {}) };
}

export class MarketplaceManager {
	readonly #options: MarketplaceManagerOptions;
	#sequence = 0;

	public constructor(options: MarketplaceManagerOptions) {
		this.#options = options;
	}

	async #registry(): Promise<MarketplaceManagerResult<{ readonly marketplaces: readonly MarketplaceRegistryEntry[]; readonly plugins: Readonly<Record<string, RunledgerPluginRecord>> }>> {
		const loaded = await this.#options.registry.loadRunledgerRegistry();
		if (!loaded.ok) return fail("registry_invalid", loaded.message);
		const marketplaces = await this.#options.registry.loadMarketplaces();
		if (!marketplaces.ok) return fail("registry_invalid", marketplaces.message);
		return ok({ marketplaces: marketplaces.document.marketplaces, plugins: loaded.document.plugins });
	}

	/** 注册一个 marketplace；已存在同名条目时拒绝，不静默覆盖来源。 */
	public async addMarketplace(request: MarketplaceAddRequest): Promise<MarketplaceManagerResult<MarketplaceView>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		if (current.value.marketplaces.some((entry) => entry.name === request.name)) {
			return fail("marketplace_exists", `marketplace is already registered: ${request.name}`);
		}
		const fetchRequest: MarketplaceFetchRequest = { name: request.name, sourceType: request.sourceType, sourceUri: request.sourceUri };
		const fetched = await this.#options.fetcher.resolveCatalog(fetchRequest, request.refresh === true ? { refresh: true } : {});
		if (!fetched.ok) return fail("marketplace_invalid", fetched.message);

		const timestamp = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: request.name,
			sourceType: request.sourceType,
			sourceUri: request.sourceUri,
			catalogPath: fetched.rootPath,
			addedAt: timestamp,
			updatedAt: timestamp,
			runledgerCatalogDigest: fetched.catalogDigest,
		};
		const saved = await this.#options.registry.saveMarketplaces({
			version: 1,
			marketplaces: [...current.value.marketplaces, entry],
		});
		if (!saved.ok) return fail("registry_invalid", saved.message);
		return ok({ name: entry.name, sourceType: entry.sourceType, sourceUri: entry.sourceUri, catalogPath: entry.catalogPath, updatedAt: entry.updatedAt });
	}

	public async removeMarketplace(name: string): Promise<MarketplaceManagerResult<{ readonly removed: string; readonly installedOnMarketplace: number }>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		const entry = current.value.marketplaces.find((item) => item.name === name);
		if (entry === undefined) return fail("marketplace_missing", `marketplace is not registered: ${name}`);
		// 已安装的 plugin 不因为 marketplace 被移除而消失：它们已经是本地内容。
		const installed = Object.values(current.value.plugins).filter((record) => record.marketplace === name).length;
		const saved = await this.#options.registry.saveMarketplaces({
			version: 1,
			marketplaces: current.value.marketplaces.filter((item) => item.name !== name),
		});
		if (!saved.ok) return fail("registry_invalid", saved.message);
		return ok({ removed: name, installedOnMarketplace: installed });
	}

	public async listMarketplaces(): Promise<MarketplaceManagerResult<readonly MarketplaceView[]>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		return ok(current.value.marketplaces.map((entry) => ({
			name: entry.name,
			sourceType: entry.sourceType,
			sourceUri: entry.sourceUri,
			catalogPath: entry.catalogPath,
			updatedAt: entry.updatedAt,
		})));
	}

	/** 刷新一个 marketplace 的 catalog 并记录新 digest。 */
	public async refreshMarketplace(name: string): Promise<MarketplaceManagerResult<MarketplaceView>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		const entry = current.value.marketplaces.find((item) => item.name === name);
		if (entry === undefined) return fail("marketplace_missing", `marketplace is not registered: ${name}`);
		const fetched = await this.#options.fetcher.resolveCatalog({ name: entry.name, sourceType: entry.sourceType, sourceUri: entry.sourceUri }, { refresh: true });
		if (!fetched.ok) return fail("marketplace_invalid", fetched.message);
		const updated: MarketplaceRegistryEntry = { ...entry, catalogPath: fetched.rootPath, updatedAt: new Date().toISOString(), runledgerCatalogDigest: fetched.catalogDigest };
		const saved = await this.#options.registry.saveMarketplaces({
			version: 1,
			marketplaces: current.value.marketplaces.map((item) => (item.name === name ? updated : item)),
		});
		if (!saved.ok) return fail("registry_invalid", saved.message);
		return ok({ name: updated.name, sourceType: updated.sourceType, sourceUri: updated.sourceUri, catalogPath: updated.catalogPath, updatedAt: updated.updatedAt });
	}

	/**
	 * 从 catalog 安装（或升级）一个 plugin。安装 spec 支持
	 * `name`、`name@marketplace`、`name[features]`。
	 */
	public async installPlugin(input: { readonly spec: string; readonly scope?: "user" | "workspace"; readonly signal?: AbortSignal }): Promise<MarketplaceManagerResult<{ readonly receipt: ExtensionInstallReceipt }>> {
		const parsed = parseExtensionInstallSpec(input.spec);
		if (!parsed.ok) return fail("plugin_not_found", parsed.message);
		const current = await this.#registry();
		if (!current.ok) return current;
		const candidates = parsed.spec.marketplace === undefined
			? current.value.marketplaces
			: current.value.marketplaces.filter((entry) => entry.name === parsed.spec.marketplace);
		if (candidates.length === 0) return fail("marketplace_missing", "no marketplace matches the install spec");

		for (const marketplace of candidates) {
			const catalogResult = await this.#options.fetcher.resolveCatalog({ name: marketplace.name, sourceType: marketplace.sourceType, sourceUri: marketplace.sourceUri });
			if (!catalogResult.ok) continue;
			const entry = findMarketplacePlugin(catalogResult.catalog.catalog, parsed.spec.name);
			if (entry === undefined) continue;
			const resolved = resolveMarketplacePluginSource(catalogResult.catalog.catalog, entry, catalogResult.rootPath);
			if (!resolved.ok) return fail("install_failed", resolved.message);
			const scope = input.scope ?? this.#options.scope();
			const installed = await this.#options.installer.install({
				packageId: `${parsed.spec.name}@${marketplace.name}`,
				name: parsed.spec.name,
				source: resolved.source,
				scope,
				marketplace: marketplace.name,
				enabledFeatures: parsed.spec.enabledFeatures === null ? null : [...parsed.spec.enabledFeatures],
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (!installed.ok) return fail("install_failed", `${installed.code}: ${installed.message}`);
			return ok({ receipt: installed.receipt });
		}
		return fail("plugin_not_found", `no registered marketplace provides plugin: ${parsed.spec.name}`);
	}

	/** 已安装视图：user/workspace 合并并显式标注被遮蔽项。 */
	public async listInstalled(): Promise<MarketplaceManagerResult<readonly InstalledPluginView[]>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		const views = Object.entries(current.value.plugins).map(([packageId, record]) => ({
			packageId,
			name: record.name,
			version: record.version,
			digest: record.digest,
			scope: record.scope,
			enabled: record.enabled,
			...(record.marketplace === undefined ? {} : { marketplace: record.marketplace }),
			shadowed: false,
		}));
		// scope 遮蔽在视图上显式标注，被遮蔽项仍然返回（便于诊断），不静默消失。
		const shadowing = applyScopeShadowing(views.map((view) => ({ packageId: view.packageId, scope: view.scope, entry: view })));
		const shadowedKeys = new Set(shadowing.shadowed.map((item) => `${item.entry.packageId}:${item.entry.scope}`));
		return ok(views
			.map((view) => ({ ...view, shadowed: shadowedKeys.has(`${view.packageId}:${view.scope}`) }))
			.sort((left, right) => left.packageId.localeCompare(right.packageId) || left.scope.localeCompare(right.scope)));
	}

	/**
	 * 可更新项：catalog 声明版本高于已安装版本。这是 `notify` 模式的
	 * 可见出口之一（CLI 可查询）。
	 */
	public async pendingUpdates(): Promise<MarketplaceManagerResult<readonly PendingUpdate[]>> {
		const current = await this.#registry();
		if (!current.ok) return current;
		const pending: PendingUpdate[] = [];
		for (const marketplace of current.value.marketplaces) {
			const catalogResult = await this.#options.fetcher.resolveCatalog({ name: marketplace.name, sourceType: marketplace.sourceType, sourceUri: marketplace.sourceUri });
			if (!catalogResult.ok) continue;
			for (const entry of catalogResult.catalog.catalog.plugins) {
				const packageId = `${entry.name}@${marketplace.name}`;
				const installed = current.value.plugins[packageId];
				if (installed === undefined) continue;
				const available = resolveCatalogVersion(entry, undefined);
				if (compareVersions(available, installed.version) > 0) {
					pending.push({ packageId, name: entry.name, installedVersion: installed.version, availableVersion: available, marketplace: marketplace.name });
				}
			}
		}
		return ok(pending.sort((left, right) => left.packageId.localeCompare(right.packageId)));
	}

	/** 自动更新：只写 digest 与可见信号，绝不自动改用户的启用/信任状态。 */
	public async autoUpdatePlan(configured: MarketplaceAutoUpdateMode, options: { readonly hasVisibleChannel: boolean }): Promise<{ readonly effective: MarketplaceAutoUpdateMode; readonly degraded: boolean; readonly updates: readonly PendingUpdate[]; readonly reason?: string }> {
		const pending = await this.pendingUpdates();
		const updates = pending.ok ? pending.value : [];
		const mode = resolveAutoUpdateMode({ configured, hasVisibleChannel: options.hasVisibleChannel, pendingUpdates: updates.length });
		if (mode.effective !== "auto") return { ...mode, updates };
		// `auto` 只刷新 catalog 并重新计算可更新项；安装、启用与信任永远是
		// 用户的决定（D7/D10），自动化不得代替它们。
		const registered = await this.listMarketplaces();
		if (registered.ok) {
			for (const marketplace of registered.value) await this.refreshMarketplace(marketplace.name);
		}
		const refreshed = await this.pendingUpdates();
		return { ...mode, updates: refreshed.ok ? refreshed.value : updates };
	}
}

/** 语义化版本比较（只处理 `major.minor.patch` 与可选预发布后缀）。 */
export function compareVersions(left: string, right: string): number {
	const parse = (value: string): { readonly core: readonly number[]; readonly pre: string | undefined } => {
		const [core = "", pre] = value.split("-", 2);
		return { core: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index += 1) {
		const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	if (a.pre === b.pre) return 0;
	if (a.pre === undefined) return 1;
	if (b.pre === undefined) return -1;
	return a.pre < b.pre ? -1 : 1;
}

/** 审计用 digest：不含安装路径等本地 authority 上下文。 */
export function marketplaceViewDigest(views: readonly MarketplaceView[]): string {
	return runtimeDigest(views.map((view) => ({ name: view.name, sourceType: view.sourceType, sourceUri: view.sourceUri, updatedAt: view.updatedAt }))).digest;
}
