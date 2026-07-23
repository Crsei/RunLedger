/** 其他 agent 目录的显式、默认关闭兼容导入。 */

import { join } from "node:path";
import { extensionDiagnostic } from "./diagnostics.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import { sourceKey } from "./paths.ts";
import type { ExtensionStoragePort } from "./storage-port.ts";
import type { ExtensionSourceRoot } from "./types.ts";

export type CompatibilitySource = "agents" | "claude" | "grok";

const directories: Readonly<Record<CompatibilitySource, string>> = {
	agents: ".agents",
	claude: ".claude",
	grok: ".grok",
};

export async function compatibilitySkillRoots(options: {
	projectRoot: string;
	storage: ExtensionStoragePort;
	enabledSources?: readonly CompatibilitySource[];
}): Promise<{ roots: readonly ExtensionSourceRoot[]; diagnostics: readonly ExtensionDiagnostic[] }> {
	const enabled = new Set(options.enabledSources ?? []);
	const roots: ExtensionSourceRoot[] = [];
	const diagnostics: ExtensionDiagnostic[] = [];
	for (const source of Object.keys(directories) as CompatibilitySource[]) {
		if (!enabled.has(source)) {
			diagnostics.push(extensionDiagnostic("compatibility.disabled", "info", `${source} compatibility import is disabled`, "compatibility"));
			continue;
		}
		const root = join(options.projectRoot, directories[source]);
		const resolved = await options.storage.realpath(root);
		if (!resolved.ok) continue;
		roots.push({ source: "project", sourceKey: sourceKey("project", `${source}:${resolved.value}`), rootPath: resolved.value, priority: 50 });
		diagnostics.push(extensionDiagnostic("compatibility.enabled", "warning", `${source} compatibility import is enabled with explicit provenance`, "compatibility", resolved.value));
	}
	return { roots, diagnostics };
}
