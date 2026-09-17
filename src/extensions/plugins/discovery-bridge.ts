/**
 * 分发账本 → 声明式 plugin 发现根 的桥（P5，§1.2 缺口 #11「安装后回灌运行时面」）。
 *
 * 安装落在版本化 store（`<scope>/packages/<packageId>/<version>/`），而既有
 * `PluginManager` 只扫描「根目录及其直接子目录」里的
 * `.runledger-plugin/plugin.json`。本模块把账本里的**当前版本**目录投影为
 * 发现根，于是已安装的**声明式**包（skills/hooks/mcpServers）立刻进入既有的
 * enable/trust/skill/hook/MCP 四层，不需要复制第二套信任或启用语义。
 *
 * 它只做投影：不扫盘、不读 trust、不改任何状态。可执行包（manifest 声明
 * `extensions[]`）的 host 装配是另一件事，不在本模块范围内。
 */

import type { RunledgerPluginRecord } from "../../contracts/extensions/marketplace.ts";
import type { ExtensionSourceRoot } from "../types.ts";
import type { ExtensionDistributionRegistry } from "./marketplace/registry.ts";

export interface DistributionPluginRootsInput {
	readonly registry: ExtensionDistributionRegistry;
	/** 该 Session 的 workspace 存储键；决定 workspace scope 的优先级与 sourceKey。 */
	readonly storageKey: string;
	readonly userPriority?: number;
	readonly workspacePriority?: number;
}

export type DistributionPluginRootsResult =
	| { readonly ok: true; readonly roots: readonly ExtensionSourceRoot[]; readonly skipped: readonly { readonly packageId: string; readonly reason: string }[] }
	| { readonly ok: false; readonly code: "registry_invalid"; readonly message: string };

const DEFAULT_USER_PRIORITY = 100;
const DEFAULT_WORKSPACE_PRIORITY = 200;

/**
 * 把账本记录投影为发现根。**只投影已安装记录指向的版本目录**：记录里的
 * `scope` 决定它是 user 还是 project 源，因此 workspace 记录天然按既有
 * 优先级遮蔽 user 记录。
 */
export async function distributionPluginRoots(input: DistributionPluginRootsInput): Promise<DistributionPluginRootsResult> {
	const loaded = await input.registry.loadRunledgerRegistry();
	if (!loaded.ok) return { ok: false, code: "registry_invalid", message: loaded.message };
	const installed = await input.registry.loadInstalledPlugins();
	const installedPaths = installed.ok ? installed.document.plugins : {};
	const roots: ExtensionSourceRoot[] = [];
	const skipped: Array<{ readonly packageId: string; readonly reason: string }> = [];
	const userPriority = input.userPriority ?? DEFAULT_USER_PRIORITY;
	const workspacePriority = input.workspacePriority ?? DEFAULT_WORKSPACE_PRIORITY;

	for (const [packageId, record] of Object.entries(loaded.document.plugins)) {
		// `link` 安装没有版本目录：它的内容就是用户自己的目录，记录在
		// `runledgerLinkedPath` 里，由调用方决定是否作为发现根。
		const linkedPath = (record as RunledgerPluginRecord & { readonly runledgerLinkedPath?: string }).runledgerLinkedPath;
		if (linkedPath !== undefined) {
			roots.push({
				source: record.scope === "user" ? "user" : "project",
				sourceKey: `distribution-link:${packageId}`,
				rootPath: linkedPath,
				priority: record.scope === "user" ? userPriority : workspacePriority,
				layout: "plugin-root",
			});
			continue;
		}
		const entry = (installedPaths[packageId] ?? []).find((item) => item.scope === record.scope && item.version === record.version);
		if (entry === undefined) {
			skipped.push({ packageId, reason: "installed_plugins.json has no entry for the recorded version" });
			continue;
		}
		roots.push({
			source: record.scope === "user" ? "user" : "project",
			sourceKey: `distribution:${packageId}@${record.version}`,
			rootPath: entry.installPath,
			priority: record.scope === "user" ? userPriority : workspacePriority,
			layout: "plugin-root",
		});
	}
	return {
		ok: true,
		roots: Object.freeze(roots.sort((left, right) => left.priority - right.priority || left.rootPath.localeCompare(right.rootPath))),
		skipped: Object.freeze(skipped),
	};
}
