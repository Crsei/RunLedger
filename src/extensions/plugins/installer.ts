/**
 * Plugin 安装器（P5、D7）。
 *
 * 纪律：
 *   - **不用包管理器**：不运行 `bun install`/`npm install`，不解析
 *     `node_modules`，也不执行任何 lifecycle script。声明 lifecycle script
 *     的包直接拒绝，而不是“恰好没执行”。
 *   - **staging → 校验 → 原子激活**：先在 staging 内 materialize 并计算
 *     digest，通过后同设备 `rename` 到版本目录；任何一步失败都清掉 staging，
 *     目标目录绝不出现半成品。
 *   - **版本化 store**：`<session scope>/packages/<packageId>/<version>/`，
 *     升级保留旧版本目录，回滚只是把账本指回上一个已验证版本。
 *   - **安装不授予执行**：本模块只落盘 + 记 digest；首次启用仍必须显式 trust
 *     （D7、§4.3）。
 */

import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { extensionDiagnostic, type ExtensionDiagnostic } from "../diagnostics.ts";
import { digestDirectory } from "../trust/digest.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import { EXTENSION_DISTRIBUTION_LIMITS, type ExtensionDistributionPort } from "./distribution-port.ts";
import { ExtensionDistributionRegistry } from "./marketplace/registry.ts";
import type { ResolvedGitSource, ResolvedLocalSource, ResolvedExtensionSource } from "./marketplace/source-resolver.ts";
import type { ExtensionEnabledFeatures, InstalledPluginEntry, MarketplacePluginSource, RunledgerPluginRecord } from "../../contracts/extensions/marketplace.ts";

/** catalog/git 源的受治 materialize port；实现方负责 network policy 与超时。 */
export interface ExtensionSourceMaterializer {
	readonly materialize: (input: {
		readonly source: ResolvedGitSource;
		readonly destination: string;
		readonly signal?: AbortSignal;
	}) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string }>;
}

export type ExtensionInstallCode =
	| "install_script_forbidden"
	| "manifest_missing"
	| "manifest_invalid"
	| "source_unavailable"
	| "source_oversize"
	| "already_installed"
	| "not_installed"
	| "registry_invalid"
	| "staging_failed"
	| "activation_failed"
	| "digest_mismatch";

export interface ExtensionInstallReceipt {
	readonly packageId: string;
	readonly name: string;
	readonly version: string;
	readonly digest: string;
	readonly scope: "user" | "workspace";
	readonly installPath: string;
	readonly enabledFeatures: readonly string[] | null;
	readonly marketplace?: string;
	readonly previousVersion?: string;
}

export type ExtensionInstallResult =
	| { readonly ok: true; readonly receipt: ExtensionInstallReceipt; readonly diagnostics: readonly ExtensionDiagnostic[] }
	| { readonly ok: false; readonly code: ExtensionInstallCode; readonly message: string; readonly diagnostics: readonly ExtensionDiagnostic[] };

export interface ExtensionInstallerOptions {
	readonly storage: ExtensionDistributionPort;
	readonly registry: ExtensionDistributionRegistry;
	readonly materializer: ExtensionSourceMaterializer;
	/** canonical home 下的 plugins 根。 */
	readonly pluginsRoot: string;
	/** 每个 scope 的包目录根；packages 与 staging 都建在这里。 */
	readonly scopeRoot: (scope: "user" | "workspace") => string;
	readonly now?: () => string;
	readonly maxEntries?: number;
	readonly maxBytes?: number;
}

const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly"] as const;

function ok(receipt: ExtensionInstallReceipt, diagnostics: readonly ExtensionDiagnostic[] = []): ExtensionInstallResult {
	return { ok: true, receipt, diagnostics };
}

function fail(code: ExtensionInstallCode, message: string, diagnostics: readonly ExtensionDiagnostic[] = []): ExtensionInstallResult {
	return { ok: false, code, message, diagnostics };
}

function scopeSegment(scope: "user" | "workspace"): "user" | "project" {
	return scope === "user" ? "user" : "project";
}

/** 从 `package.json` 提取 RunLedger manifest 原文（D12：自有键，不读 `#omp`/`#pi`）。 */
export function extractRunledgerManifest(packageJson: unknown): { readonly ok: true; readonly manifest: unknown; readonly scripts: readonly string[] } | { readonly ok: false; readonly code: ExtensionInstallCode; readonly message: string } {
	if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
		return { ok: false, code: "manifest_invalid", message: "package.json must be a JSON object" };
	}
	const record = packageJson as Record<string, unknown>;
	const scripts = typeof record.scripts === "object" && record.scripts !== null && !Array.isArray(record.scripts)
		? Object.keys(record.scripts as Record<string, unknown>)
		: [];
	if (record.runledger === undefined) return { ok: false, code: "manifest_missing", message: "package.json is missing the runledger manifest key" };
	return { ok: true, manifest: record.runledger, scripts };
}

export class ExtensionInstaller {
	readonly #options: ExtensionInstallerOptions;
	#sequence = 0;

	public constructor(options: ExtensionInstallerOptions) {
		this.#options = options;
	}

	#now(): string {
		return (this.#options.now ?? (() => new Date().toISOString()))();
	}

	#packageRoot(packageId: string, scope: "user" | "workspace"): string {
		return `${this.#options.scopeRoot(scope)}/packages/${packageId}`;
	}

	#versionPath(packageId: string, version: string, scope: "user" | "workspace"): string {
		return `${this.#packageRoot(packageId, scope)}/${version}`;
	}

	/**
	 * 安装一个 package 到版本目录。`source` 已由 source-resolver 解析过。
	 * 本地源走 bounded 复制；git 源走受治 materializer。
	 */
	public async install(input: {
		readonly packageId: string;
		readonly name: string;
		readonly source: ResolvedExtensionSource;
		readonly scope: "user" | "workspace";
		readonly marketplace?: string;
		readonly enabledFeatures?: ExtensionEnabledFeatures;
		/** catalog 声明的期望 digest；给出时实际 digest 必须一致。 */
		readonly expectedDigest?: string;
		readonly signal?: AbortSignal;
	}): Promise<ExtensionInstallResult> {
		const maxEntries = this.#options.maxEntries ?? EXTENSION_DISTRIBUTION_LIMITS.maxEntries;
		const maxBytes = this.#options.maxBytes ?? EXTENSION_DISTRIBUTION_LIMITS.maxBytes;
		const stagingRoot = `${this.#options.scopeRoot(input.scope)}/staging`;
		this.#sequence += 1;
		const staging = `${stagingRoot}/${input.packageId.replaceAll("/", "_")}-${this.#sequence}`;
		const created = await this.#options.storage.mkdirp(stagingRoot);
		if (!created.ok) return fail("staging_failed", "extension staging root could not be created");

		const cleanup = async (): Promise<void> => { await this.#options.storage.remove(staging, { recursive: true }).catch(() => undefined); };

		const materialized = await this.#materialize(input.source, staging, input.signal);
		if (!materialized.ok) {
			await cleanup();
			return fail(materialized.code, materialized.message);
		}

		const manifestRead = await this.#options.storage.readFile(`${staging}/package.json`, EXTENSION_DISTRIBUTION_LIMITS.maxManifestBytes);
		if (!manifestRead.ok) {
			await cleanup();
			return fail("manifest_missing", "installed package is missing package.json");
		}
		let packageJson: unknown;
		try {
			packageJson = JSON.parse(new TextDecoder().decode(manifestRead.value)) as unknown;
		} catch {
			await cleanup();
			return fail("manifest_invalid", "package.json is not valid JSON");
		}
		const manifest = extractRunledgerManifest(packageJson);
		if (!manifest.ok) {
			await cleanup();
			return fail(manifest.code, manifest.message);
		}
		// 声明 lifecycle script 的包直接拒绝：我们永远不运行它们，不能靠“恰好没跑”
		// 来保证安全（D7）。
		const lifecycle = manifest.scripts.filter((script) => (LIFECYCLE_SCRIPTS as readonly string[]).includes(script));
		if (lifecycle.length > 0) {
			await cleanup();
			return fail("install_script_forbidden", `package declares lifecycle scripts (${lifecycle.sort().join(",")}); RunLedger never runs install scripts`, [
				extensionDiagnostic({ code: "plugin.install_script_forbidden", severity: "error", message: "package declares lifecycle scripts", source: "plugin", path: `${staging}/package.json` }),
			]);
		}

		const digests = await digestDirectory(this.#options.storage, staging, {
			...DEFAULT_EXTENSION_LIMITS,
			maxEntries,
			maxDirectoryBytes: maxBytes,
		});
		if (!digests.ok) {
			await cleanup();
			return fail(digests.code === "oversize" ? "source_oversize" : "staging_failed", digests.message);
		}
		const digest = digests.digest;
		if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
			await cleanup();
			return fail("digest_mismatch", "installed content digest does not match the catalog declaration");
		}

		const version = readVersion(manifest.manifest);
		if (version === undefined) {
			await cleanup();
			return fail("manifest_invalid", "runledger manifest must declare a semver version");
		}

		const registryLoad = await this.#options.registry.loadRunledgerRegistry();
		if (!registryLoad.ok) {
			await cleanup();
			return fail("registry_invalid", registryLoad.message);
		}
		const existing = registryLoad.document.plugins[input.packageId];
		const target = this.#versionPath(input.packageId, version, input.scope);
		if (existing !== undefined && existing.version === version && existing.scope === scopeSegment(input.scope)) {
			await cleanup();
			return fail("already_installed", `${input.packageId}@${version} is already installed in this scope`);
		}
		const targetStat = await this.#options.storage.stat(target, { followSymlinks: false });
		if (targetStat.ok) {
			// 版本目录已存在（例如上一次安装留下的同版本内容）：先移除，保持激活原子。
			const removed = await this.#options.storage.remove(target, { recursive: true });
			if (!removed.ok) {
				await cleanup();
				return fail("activation_failed", "existing version directory could not be cleared");
			}
		}

		const activated = await this.#options.storage.rename(staging, target);
		if (!activated.ok) {
			await cleanup();
			return fail("activation_failed", activated.message);
		}

		const timestamp = this.#now();
		const record: RunledgerPluginRecord = {
			name: input.name,
			version,
			digest,
			scope: scopeSegment(input.scope),
			// 安装不动 enable 状态：已有记录沿用，新记录默认关闭。
			enabled: existing?.enabled ?? false,
			enabledFeatures: input.enabledFeatures ?? existing?.enabledFeatures ?? null,
			source: toContractSource(input.source),
			...(input.marketplace === undefined ? {} : { marketplace: input.marketplace }),
			installedAt: existing?.installedAt ?? timestamp,
			lastUpdated: timestamp,
		};
		const nextRegistry = {
			...registryLoad.document,
			plugins: { ...registryLoad.document.plugins, [input.packageId]: record },
		};
		const savedRegistry = await this.#options.registry.saveRunledgerRegistry(nextRegistry);
		if (!savedRegistry.ok) return fail("activation_failed", savedRegistry.message);

		const installedLoad = await this.#options.registry.loadInstalledPlugins();
		if (!installedLoad.ok) return fail("registry_invalid", installedLoad.message);
		const entry: InstalledPluginEntry = {
			scope: scopeSegment(input.scope),
			installPath: target,
			version,
			installedAt: timestamp,
			lastUpdated: timestamp,
			runledgerDigest: digest,
		};
		const previousEntries = installedLoad.document.plugins[input.packageId] ?? [];
		const savedInstalled = await this.#options.registry.saveInstalledPlugins({
			...installedLoad.document,
			plugins: { ...installedLoad.document.plugins, [input.packageId]: [...previousEntries.filter((item) => !(item.scope === entry.scope && item.version === version)), entry] },
		});
		if (!savedInstalled.ok) return fail("activation_failed", savedInstalled.message);

		return ok({
			packageId: input.packageId,
			name: input.name,
			version,
			digest,
			scope: input.scope,
			installPath: target,
			enabledFeatures: nextRegistry.plugins[input.packageId]?.enabledFeatures ?? null,
			...(input.marketplace === undefined ? {} : { marketplace: input.marketplace }),
			...(existing === undefined ? {} : { previousVersion: existing.version }),
		});
	}

	/** 只链接本地目录（开发用）：不写 dependencies、不复制内容、不授予执行。 */
	public async link(input: {
		readonly packageId: string;
		readonly name: string;
		readonly localPath: string;
		readonly scope: "user" | "workspace";
	}): Promise<ExtensionInstallResult> {
		const stat = await this.#options.storage.stat(input.localPath, { followSymlinks: false });
		if (!stat.ok || stat.value.kind !== "directory") return fail("source_unavailable", "link target must be an existing directory");
		const linkPath = `${this.#options.scopeRoot(input.scope)}/packages/${input.packageId}`;
		const linked = await this.#options.storage.symlink(input.localPath, linkPath);
		if (!linked.ok) return fail("activation_failed", linked.message);
		const timestamp = this.#now();
		const registryLoad = await this.#options.registry.loadRunledgerRegistry();
		if (!registryLoad.ok) return fail("registry_invalid", registryLoad.message);
		const previous = registryLoad.document.plugins[input.packageId];
		const record: RunledgerPluginRecord = {
			name: input.name,
			version: previous?.version ?? "0.0.0",
			digest: runtimeDigest({ link: input.packageId, localPath: input.localPath }).digest,
			scope: scopeSegment(input.scope),
			enabled: previous?.enabled ?? false,
			enabledFeatures: previous?.enabledFeatures ?? null,
			// link 不是 marketplace source：只记录本地目录，不伪造 git/url 来源。
			runledgerLinkedPath: input.localPath,
			installedAt: timestamp,
			lastUpdated: timestamp,
		};
		const saved = await this.#options.registry.saveRunledgerRegistry({ ...registryLoad.document, plugins: { ...registryLoad.document.plugins, [input.packageId]: record } });
		if (!saved.ok) return fail("activation_failed", saved.message);
		return ok({ packageId: input.packageId, name: input.name, version: record.version, digest: record.digest, scope: input.scope, installPath: linkPath, enabledFeatures: record.enabledFeatures });
	}

	/** 卸载：先摘账本，再删目录；不存在即报错，不做“静默成功”。 */
	public async uninstall(input: { readonly packageId: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: true; readonly removedPath: string } | { readonly ok: false; readonly code: ExtensionInstallCode; readonly message: string }> {
		const registryLoad = await this.#options.registry.loadRunledgerRegistry();
		if (!registryLoad.ok) return { ok: false, code: "registry_invalid", message: registryLoad.message };
		const record = registryLoad.document.plugins[input.packageId];
		if (record === undefined) return { ok: false, code: "not_installed", message: `${input.packageId} is not installed` };
		const packageRoot = this.#packageRoot(input.packageId, input.scope);
		const removed = await this.#options.storage.remove(packageRoot, { recursive: true });
		if (!removed.ok) return { ok: false, code: "activation_failed", message: removed.message };
		const plugins = { ...registryLoad.document.plugins };
		delete plugins[input.packageId];
		const settings = { ...registryLoad.document.settings };
		delete settings[input.packageId];
		const savedRegistry = await this.#options.registry.saveRunledgerRegistry({ ...registryLoad.document, plugins, settings });
		if (!savedRegistry.ok) return { ok: false, code: "activation_failed", message: savedRegistry.message };

		const installedLoad = await this.#options.registry.loadInstalledPlugins();
		if (installedLoad.ok) {
			const installedPlugins = { ...installedLoad.document.plugins };
			const remaining = (installedPlugins[input.packageId] ?? []).filter((entry) => entry.scope !== scopeSegment(input.scope));
			if (remaining.length === 0) delete installedPlugins[input.packageId];
			else installedPlugins[input.packageId] = remaining;
			await this.#options.registry.saveInstalledPlugins({ ...installedLoad.document, plugins: installedPlugins });
		}
		return { ok: true, removedPath: packageRoot };
	}

	/** 回滚到账本记录的上一个已验证版本目录；目录不存在时拒绝，不自动重装。 */
	public async rollback(input: { readonly packageId: string; readonly version: string; readonly scope: "user" | "workspace" }): Promise<ExtensionInstallResult> {
		const target = this.#versionPath(input.packageId, input.version, input.scope);
		const stat = await this.#options.storage.stat(target, { followSymlinks: false });
		if (!stat.ok || stat.value.kind !== "directory") return fail("not_installed", `version ${input.version} is not present in the local store`);
		const registryLoad = await this.#options.registry.loadRunledgerRegistry();
		if (!registryLoad.ok) return fail("registry_invalid", registryLoad.message);
		const record = registryLoad.document.plugins[input.packageId];
		if (record === undefined) return fail("not_installed", `${input.packageId} is not installed`);
		const digests = await digestDirectory(this.#options.storage, target, { ...DEFAULT_EXTENSION_LIMITS, maxEntries: this.#options.maxEntries ?? EXTENSION_DISTRIBUTION_LIMITS.maxEntries, maxDirectoryBytes: this.#options.maxBytes ?? EXTENSION_DISTRIBUTION_LIMITS.maxBytes });
		if (!digests.ok) return fail("staging_failed", digests.message);
		const timestamp = this.#now();
		const previousVersion = record.version;
		const saved = await this.#options.registry.saveRunledgerRegistry({
			...registryLoad.document,
			plugins: { ...registryLoad.document.plugins, [input.packageId]: { ...record, version: input.version, digest: digests.digest, lastUpdated: timestamp } },
		});
		if (!saved.ok) return fail("activation_failed", saved.message);
		return ok({ packageId: input.packageId, name: record.name, version: input.version, digest: digests.digest, scope: input.scope, installPath: target, enabledFeatures: record.enabledFeatures, previousVersion });
	}

	async #materialize(source: ResolvedExtensionSource, staging: string, signal?: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: ExtensionInstallCode; readonly message: string }> {
		if (source.kind === "local") {
			const copied = await this.#options.storage.copyTree((source as ResolvedLocalSource).path, staging, {
				maxEntries: this.#options.maxEntries ?? EXTENSION_DISTRIBUTION_LIMITS.maxEntries,
				maxBytes: this.#options.maxBytes ?? EXTENSION_DISTRIBUTION_LIMITS.maxBytes,
			});
			if (copied.ok) return { ok: true };
			return { ok: false, code: copied.code === "oversize" ? "source_oversize" : "source_unavailable", message: copied.message };
		}
		const materialized = await this.#options.materializer.materialize({
			source: source as ResolvedGitSource,
			destination: staging,
			...(signal === undefined ? {} : { signal }),
		});
		return materialized.ok ? { ok: true } : { ok: false, code: "source_unavailable", message: materialized.message };
	}
}

function readVersion(manifest: unknown): string | undefined {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
	const version = (manifest as Record<string, unknown>).version;
	return typeof version === "string" && /^\d+\.\d+\.\d+/u.test(version) ? version : undefined;
}

function toContractSource(source: ResolvedExtensionSource): MarketplacePluginSource {
	if (source.kind === "local") return `./${(source as ResolvedLocalSource).locator}`;
	const git = source as ResolvedGitSource;
	if (git.subdir !== undefined) return { source: "git-subdir", url: git.url, path: git.subdir, ...(git.ref === undefined ? {} : { ref: git.ref }), ...(git.sha === undefined ? {} : { sha: git.sha }) };
	return { source: "url", url: git.url, ...(git.ref === undefined ? {} : { ref: git.ref }), ...(git.sha === undefined ? {} : { sha: git.sha }) };
}

/** 安装结果的稳定 digest；用于审计与 CLI `--json` 输出。 */
export function extensionInstallReceiptDigest(receipt: ExtensionInstallReceipt): string {
	return runtimeDigest(canonicalJson({ ...receipt })).digest;
}
