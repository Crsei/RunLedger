/** Plugin 只组合 Skill/Hook/MCP descriptor，不启动 client 或执行 handler。 */

import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionStateDocument, ExtensionSourceRoot } from "../types.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { loadHookConfig } from "../hooks/config.ts";
import { loadMcpConfig } from "../mcp/config.ts";
import { discoverSkills } from "../skills/discovery.ts";
import type { PluginContributions, PluginDescriptor } from "./types.ts";
import type { ExtensionResourceDescriptor } from "../types.ts";

export class PluginManager {
	readonly #scope: ExtensionRuntimeScope;
	readonly #trustStore: TrustStore;
	readonly #storage: ExtensionStoragePort;
	readonly #state?: ExtensionStateDocument;
	readonly #environment: Readonly<Record<string, string | undefined>>;

	public constructor(options: { scope: ExtensionRuntimeScope; trustStore: TrustStore; storage: ExtensionStoragePort; state?: ExtensionStateDocument; environment?: Readonly<Record<string, string | undefined>> }) {
		this.#scope = options.scope;
		this.#trustStore = options.trustStore;
		this.#storage = options.storage;
		this.#state = options.state;
		this.#environment = options.environment ?? {};
	}

	public async contributions(plugin: PluginDescriptor): Promise<PluginContributions> {
		if (plugin.descriptor.activation !== "ready" || plugin.descriptor.trust !== "trusted") return { plugin, skills: [], hooks: [], mcpServers: [], diagnostics: plugin.descriptor.diagnostics };
		const sourceRoot: ExtensionSourceRoot = { source: "plugin", sourceKey: plugin.descriptor.identity.qualifiedId, rootPath: plugin.rootPath, priority: 500, pluginId: plugin.descriptor.identity.qualifiedId };
		const skillResults = await Promise.all(plugin.skillRoots.map((skillsPath) => discoverSkills({ roots: [{ ...sourceRoot, skillsPath }], scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, ...(this.#state ? { state: this.#state } : {}) })));
		const hookResults = await Promise.all(plugin.hookConfigs.map((configPath) => loadHookConfig({ configPath, root: sourceRoot, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, pluginRoot: plugin.rootPath, pluginDataPath: plugin.dataRoot, ...(this.#state ? { state: this.#state } : {}) })));
		const mcpResult = plugin.mcpConfig ? await loadMcpConfig({ configPath: plugin.mcpConfig, root: sourceRoot, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, environment: this.#environment, pluginRoot: plugin.rootPath, ...(this.#state ? { state: this.#state } : {}) }) : { servers: [], diagnostics: [] };
		const attachParent = <T extends { descriptor: ExtensionResourceDescriptor }>(value: T): T => ({ ...value, descriptor: { ...value.descriptor, provenance: { ...value.descriptor.provenance, parentPlugin: plugin.descriptor.identity }, trust: "trusted", activation: "ready", ...(plugin.descriptor.approvalReceiptId ? { approvalReceiptId: plugin.descriptor.approvalReceiptId } : {}) } });
		const skills = skillResults.flatMap((result) => result.skills).map((skill) => ({ ...attachParent(skill), trustBinding: { identity: plugin.descriptor.identity, canonicalPath: plugin.rootPath, binding: plugin.descriptor.manifest, ...(plugin.descriptor.approvalReceiptId ? { receiptId: plugin.descriptor.approvalReceiptId } : {}) } }));
		return {
			plugin,
			skills,
			hooks: hookResults.flatMap((result) => result.hooks).map(attachParent),
			mcpServers: mcpResult.servers.map(attachParent),
			diagnostics: [...skillResults.flatMap((result) => result.diagnostics), ...hookResults.flatMap((result) => result.diagnostics), ...mcpResult.diagnostics],
		};
	}
}
