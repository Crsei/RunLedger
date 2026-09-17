/**
 * 分发的磁盘账本（P5）。
 *
 * 三个文件都在 canonical home 下：
 *   - `marketplaces.json`（登记版本 1，Claude 兼容字段）
 *   - `installed_plugins.json`（登记版本 2，Claude 兼容字段）
 *   - `plugins/registry.json`（RunLedger 自有安装/启用/features 账本）
 *
 * 读取时**保留未知顶层键**并在写回时放回，避免 RunLedger 覆盖用户或其它
 * 工具写入的字段；文件缺失是正常的空账本，文件损坏是错误（fail closed），
 * 不静默重置用户数据。
 */

import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import {
	InstalledPluginsRegistrySchema,
	MarketplacesRegistrySchema,
	RunledgerPluginsRegistrySchema,
} from "../../../contracts/extensions/marketplace.ts";
import type {
	InstalledPluginsRegistry,
	MarketplacesRegistry,
	RunledgerPluginsRegistry,
} from "../../../contracts/extensions/marketplace.ts";
import { canonicalJson } from "../../../runtime/protocol/canonical-json.ts";
import type { ExtensionDistributionPort } from "../distribution-port.ts";

export interface ExtensionDistributionPaths {
	readonly marketplacesPath: string;
	readonly installedPluginsPath: string;
	readonly runledgerRegistryPath: string;
}

export function resolveExtensionDistributionPaths(input: {
	/** canonical home 下的 `extensions` 状态目录。 */
	readonly stateRoot: string;
	/** canonical home 下的 `plugins` 目录。 */
	readonly pluginsRoot: string;
}): ExtensionDistributionPaths {
	return {
		marketplacesPath: `${input.pluginsRoot}/marketplaces.json`,
		installedPluginsPath: `${input.pluginsRoot}/installed_plugins.json`,
		runledgerRegistryPath: `${input.pluginsRoot}/registry.json`,
	};
}

export type ExtensionRegistryLoad<T> =
	| { readonly ok: true; readonly document: T }
	| { readonly ok: false; readonly code: "invalid" | "unavailable"; readonly message: string };

const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;

function emptyMarketplaces(): MarketplacesRegistry {
	return { version: 1, marketplaces: [] };
}

function emptyInstalledPlugins(): InstalledPluginsRegistry {
	return { version: 2, plugins: {} };
}

function emptyRunledgerRegistry(): RunledgerPluginsRegistry {
	return { version: 1, plugins: {}, settings: {} };
}

function unknownKeys(value: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
	const extra: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!known.includes(key)) extra[key] = item;
	}
	return extra;
}

export class ExtensionDistributionRegistry {
	readonly #storage: ExtensionDistributionPort;
	readonly #paths: ExtensionDistributionPaths;
	readonly #extra = new Map<string, Record<string, unknown>>();

	public constructor(options: { readonly storage: ExtensionDistributionPort; readonly paths: ExtensionDistributionPaths }) {
		this.#storage = options.storage;
		this.#paths = options.paths;
	}

	async #read(path: string, label: string): Promise<ExtensionRegistryLoad<Record<string, unknown>>> {
		const read = await this.#storage.readFile(path, MAX_REGISTRY_BYTES);
		if (!read.ok) {
			if (read.code === "missing") return { ok: true, document: {} };
			return { ok: false, code: "unavailable", message: `${label} could not be read` };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(read.value)) as unknown;
		} catch {
			return { ok: false, code: "invalid", message: `${label} is not valid JSON` };
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { ok: false, code: "invalid", message: `${label} must be a JSON object` };
		}
		return { ok: true, document: parsed as Record<string, unknown> };
	}

	async #write(path: string, document: Record<string, unknown>): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
		const written = await this.#storage.writeFileAtomic(path, new TextEncoder().encode(`${canonicalJson(document)}\n`), { fileMode: 0o600, directoryMode: 0o700 });
		return written.ok ? { ok: true } : { ok: false, code: written.code, message: "extension registry could not be written" };
	}

	/**
	 * 只校验**已知键**的子集，未知顶层键原样记下并在写回时放回（§11
	 * “未知键 passthrough”）。这样既保持 exact schema，又不会吞掉用户或
	 * 其它工具写入的字段。
	 */
	async #loadValidated<T>(path: string, label: string, schema: TSchema, known: readonly string[], fallback: () => T): Promise<ExtensionRegistryLoad<T>> {
		const raw = await this.#read(path, label);
		if (!raw.ok) return raw;
		if (Object.keys(raw.document).length === 0) return { ok: true, document: fallback() };
		const knownDocument: Record<string, unknown> = {};
		for (const key of known) {
			if (key in raw.document) knownDocument[key] = raw.document[key];
		}
		if (!Value.Check(schema, knownDocument)) return { ok: false, code: "invalid", message: `${label} does not match the registry contract` };
		this.#extra.set(path, unknownKeys(raw.document, known));
		return { ok: true, document: knownDocument as T };
	}

	public async loadMarketplaces(): Promise<ExtensionRegistryLoad<MarketplacesRegistry>> {
		return this.#loadValidated<MarketplacesRegistry>(this.#paths.marketplacesPath, "marketplaces.json", MarketplacesRegistrySchema, ["version", "marketplaces"], emptyMarketplaces);
	}

	public async saveMarketplaces(document: MarketplacesRegistry): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
		const merged = { ...(this.#extra.get(this.#paths.marketplacesPath) ?? {}), ...document as unknown as Record<string, unknown> };
		return this.#write(this.#paths.marketplacesPath, merged);
	}

	public async loadInstalledPlugins(): Promise<ExtensionRegistryLoad<InstalledPluginsRegistry>> {
		return this.#loadValidated<InstalledPluginsRegistry>(this.#paths.installedPluginsPath, "installed_plugins.json", InstalledPluginsRegistrySchema, ["version", "plugins"], emptyInstalledPlugins);
	}

	public async saveInstalledPlugins(document: InstalledPluginsRegistry): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
		const merged = { ...(this.#extra.get(this.#paths.installedPluginsPath) ?? {}), ...document as unknown as Record<string, unknown> };
		return this.#write(this.#paths.installedPluginsPath, merged);
	}

	public async loadRunledgerRegistry(): Promise<ExtensionRegistryLoad<RunledgerPluginsRegistry>> {
		return this.#loadValidated<RunledgerPluginsRegistry>(this.#paths.runledgerRegistryPath, "plugins/registry.json", RunledgerPluginsRegistrySchema, ["version", "plugins", "settings"], emptyRunledgerRegistry);
	}

	public async saveRunledgerRegistry(document: RunledgerPluginsRegistry): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }> {
		const merged = { ...(this.#extra.get(this.#paths.runledgerRegistryPath) ?? {}), ...document as unknown as Record<string, unknown> };
		return this.#write(this.#paths.runledgerRegistryPath, merged);
	}
}

export interface ShadowingInput<T> {
	readonly packageId: string;
	readonly scope: "user" | "project";
	readonly entry: T;
}

export interface ShadowingResult<T> {
	readonly active: readonly ShadowingInput<T>[];
	/** 被 project scope 遮蔽的 user scope 条目。 */
	readonly shadowed: readonly ShadowingInput<T>[];
}

/**
 * project scope 按 packageId 遮蔽 user scope（D6）。遮蔽是显式的：
 * 被遮蔽的条目仍然返回，便于诊断与 UI 展示，而不是静默消失。
 */
export function applyScopeShadowing<T>(entries: readonly ShadowingInput<T>[]): ShadowingResult<T> {
	const projectIds = new Set(entries.filter((entry) => entry.scope === "project").map((entry) => entry.packageId));
	const active: ShadowingInput<T>[] = [];
	const shadowed: ShadowingInput<T>[] = [];
	for (const entry of entries) {
		if (entry.scope === "user" && projectIds.has(entry.packageId)) shadowed.push(entry);
		else active.push(entry);
	}
	return { active, shadowed };
}
