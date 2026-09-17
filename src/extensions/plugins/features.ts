/**
 * Plugin feature 选择域（P6，§5.2 契约增量）。
 *
 * omp 的 feature 语义被完整复刻（§2.2），但值存放位置不同：选择结果落在
 * RunLedger 自有的 `plugins/registry.json` 记录里，而不是 lockfile。
 *   - `selection === null`：只启用声明中 `default: true` 的 feature；
 *   - `selection === []`：全关；
 *   - 非空数组：精确集合，只保留声明过的名字。
 *
 * 声明是**选择域**而非授权：切换 feature 既不启用 plugin，也不改 trust。
 * 安装语法 `pkg[a,b]` / `pkg[*]` / `pkg[]` 的解析由
 * `marketplace/source-resolver.ts` 拥有，本模块只消费它的结果。
 */

import { Value } from "typebox/value";
import type { ExtensionFeatureDeclaration } from "../../contracts/extensions/manifest.ts";
import { ExtensionFeatureDeclarationSchema } from "../../contracts/extensions/manifest.ts";
import type { RunledgerPluginsRegistry } from "../../contracts/extensions/marketplace.ts";
import { resolveEnabledFeatures } from "./marketplace/source-resolver.ts";
import type { ExtensionDistributionRegistry } from "./marketplace/registry.ts";

export interface DeclaredFeaturesRead {
	readonly declarations: readonly ExtensionFeatureDeclaration[];
	/** 形状不合法或重名的声明：跳过并报告，不猜测。 */
	readonly invalid: readonly string[];
}

/**
 * 从已安装包的 `package.json#runledger` manifest 读出 feature 声明。
 * 非数组按“没有声明”处理（安装期 manifest 校验已保证形状），数组内的非法项
 * 逐条跳过并记入 `invalid`，避免一条坏声明让整个包不可解释。
 */
export function readDeclaredFeatures(manifest: unknown): DeclaredFeaturesRead {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return { declarations: [], invalid: [] };
	const raw = (manifest as Record<string, unknown>).features;
	if (!Array.isArray(raw)) return { declarations: [], invalid: [] };
	const declarations: ExtensionFeatureDeclaration[] = [];
	const invalid: string[] = [];
	const seen = new Set<string>();
	for (const [index, item] of raw.entries()) {
		if (!Value.Check(ExtensionFeatureDeclarationSchema, item)) {
			invalid.push(`features[${index}]`);
			continue;
		}
		const declaration = item as ExtensionFeatureDeclaration;
		if (seen.has(declaration.name)) {
			invalid.push(`features[${index}] duplicates ${declaration.name}`);
			continue;
		}
		seen.add(declaration.name);
		declarations.push(declaration);
	}
	return { declarations: Object.freeze(declarations), invalid: Object.freeze(invalid) };
}

export interface PluginFeatureState {
	readonly packageId: string;
	readonly declared: readonly ExtensionFeatureDeclaration[];
	/** 账本里记录的选择；`null` 表示走声明默认值。 */
	readonly selection: readonly string[] | null;
	/** 实际生效的 feature 名（已按声明过滤并排序）。 */
	readonly enabled: readonly string[];
	/** 选择了但声明里没有的名字：报告而不静默丢弃。 */
	readonly unknown: readonly string[];
}

/** 把声明与账本选择合成为可展示状态；纯函数，不触碰磁盘。 */
export function describePluginFeatures(input: {
	readonly packageId: string;
	readonly manifest: unknown;
	readonly selection: readonly string[] | null;
}): PluginFeatureState {
	const { declarations } = readDeclaredFeatures(input.manifest);
	const declaredNames = new Set(declarations.map((declaration) => declaration.name));
	const unknown = input.selection === null ? [] : [...new Set(input.selection)].filter((name) => !declaredNames.has(name)).sort();
	return {
		packageId: input.packageId,
		declared: declarations,
		selection: input.selection,
		enabled: resolveEnabledFeatures(input.selection, declarations),
		unknown: Object.freeze(unknown),
	};
}

export type PluginFeatureWriteResult =
	| { readonly ok: true; readonly value: PluginFeatureState }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * 写入 feature 选择。只改 `plugins/registry.json` 里该记录的 `enabledFeatures`
 * 一个字段：不启用、不信任、不重启 host（D7/三者分离）。未知 feature 名显式
 * 报错而不是静默裁剪，避免“设了但没生效”的静默失败。
 */
export async function applyPluginFeatureSelection(input: {
	readonly registry: ExtensionDistributionRegistry;
	readonly packageId: string;
	readonly manifest: unknown;
	readonly selection: readonly string[] | null;
}): Promise<PluginFeatureWriteResult> {
	const loaded = await input.registry.loadRunledgerRegistry();
	if (!loaded.ok) return { ok: false, code: loaded.code, message: loaded.message };
	const record = loaded.document.plugins[input.packageId];
	if (record === undefined) {
		return { ok: false, code: "plugin_not_installed", message: `no installed package matches ${input.packageId}` };
	}
	const { declarations } = readDeclaredFeatures(input.manifest);
	if (declarations.length === 0) {
		return { ok: false, code: "no_declared_features", message: `${input.packageId} declares no features` };
	}
	const declaredNames = new Set(declarations.map((declaration) => declaration.name));
	const unknown = input.selection === null ? [] : [...new Set(input.selection)].filter((name) => !declaredNames.has(name));
	if (unknown.length > 0) {
		return { ok: false, code: "feature_unknown", message: `undeclared features: ${unknown.sort().join(", ")}` };
	}
	const selection = input.selection === null ? null : [...new Set(input.selection)].sort();
	const next: RunledgerPluginsRegistry = {
		...loaded.document,
		plugins: {
			...loaded.document.plugins,
			[input.packageId]: { ...record, enabledFeatures: selection === null ? null : [...selection] },
		},
	};
	const saved = await input.registry.saveRunledgerRegistry(next);
	if (!saved.ok) return { ok: false, code: saved.code, message: saved.message };
	return { ok: true, value: describePluginFeatures({ packageId: input.packageId, manifest: input.manifest, selection }) };
}

/**
 * 解析 CLI 的选择参数：`*` → `null`（声明默认值）、`none` → `[]`（全关）、
 * 其余按逗号分隔的精确集合。空字符串视为用法错误，避免把“漏写参数”当成全关。
 */
export type FeatureSelectionParse =
	| { readonly ok: true; readonly selection: readonly string[] | null }
	| { readonly ok: false; readonly code: "selection_invalid"; readonly message: string };

const FEATURE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;

export function parseFeatureSelection(input: string): FeatureSelectionParse {
	const trimmed = input.trim();
	if (trimmed.length === 0) return { ok: false, code: "selection_invalid", message: "feature selection must be *, none or a comma-separated list" };
	if (trimmed === "*") return { ok: true, selection: null };
	if (trimmed === "none") return { ok: true, selection: [] };
	const names = trimmed.split(",").map((name) => name.trim());
	if (names.some((name) => !FEATURE_NAME.test(name))) {
		return { ok: false, code: "selection_invalid", message: "feature selection contains an invalid name" };
	}
	return { ok: true, selection: [...new Set(names)].sort() };
}
