/** root/hooks/*.json 的有界发现与组合。 */

import { join } from "node:path";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import { loadHookConfig } from "./config.ts";
import type { HookDescriptor } from "./types.ts";

export async function discoverHooks(options: {
	roots: readonly ExtensionSourceRoot[];
	scope: ExtensionRuntimeScope;
	trustStore: TrustStore;
	storage: ExtensionStoragePort;
	state?: ExtensionStateDocument;
}): Promise<{ hooks: readonly HookDescriptor[]; diagnostics: readonly ExtensionDiagnostic[] }> {
	const hooks: HookDescriptor[] = [];
	const diagnostics: ExtensionDiagnostic[] = [];
	for (const root of options.roots) {
		const directory = join(root.rootPath, "hooks");
		const listed = await options.storage.readDirectory(directory);
		if (!listed.ok) continue;
		for (const entry of [...listed.value].filter((item) => item.kind === "file" && item.name.endsWith(".json")).sort((left, right) => left.name.localeCompare(right.name))) {
			const result = await loadHookConfig({ configPath: join(directory, entry.name), root, scope: options.scope, trustStore: options.trustStore, storage: options.storage, ...(options.state ? { state: options.state } : {}) });
			hooks.push(...result.hooks);
			diagnostics.push(...result.diagnostics);
		}
	}
	return { hooks, diagnostics };
}
