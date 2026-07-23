/** 四数据面的唯一装配入口与 idle 原子 reload。 */

import { join } from "node:path";
import { canonicalDigest, canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { createExtensionResourceIdentity, mcpRuntimeName, qualifiedResourceId } from "./identity.ts";
import { discoverHooks } from "./hooks/discovery.ts";
import type { HookCommandExecutorPort, HookDescriptor } from "./hooks/types.ts";
import { HookRunner } from "./hooks/runner.ts";
import { HookDispatcher } from "./hooks/dispatcher.ts";
import type { McpClientFactoryPort, McpServerDescriptor, McpToolDefinition } from "./mcp/types.ts";
import type { McpServerState } from "./mcp/types.ts";
import { loadMcpConfig, mergeMcpServers } from "./mcp/config.ts";
import { McpConnectionManager } from "./mcp/connection-manager.ts";
import type { McpAuxiliaryAuthorizationPort, McpOperationAuthorizationPort, McpSchedulerPort, McpStateEventSinkPort } from "./mcp/connection-manager.ts";
import { discoverPlugins } from "./plugins/discovery.ts";
import { PluginManager } from "./plugins/plugin-manager.ts";
import type { PluginDescriptor } from "./plugins/types.ts";
import { discoverSkills } from "./skills/discovery.ts";
import { SkillCatalog } from "./skills/catalog.ts";
import type { SkillDescriptor } from "./skills/types.ts";
import { buildExtensionSnapshot, ExtensionSnapshotStore } from "./snapshot.ts";
import type { ExtensionSnapshot } from "./snapshot.ts";
import { ExtensionStateStore } from "./state-store.ts";
import type { ExtensionStoragePort } from "./storage-port.ts";
import type { TrustStore } from "./trust/trust-store.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import { extensionDiagnostic } from "./diagnostics.ts";
import { buildResourceManifestDigest } from "./trust/digest.ts";
import type { ExtensionResourceDescriptor, ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionSpillPort } from "./types.ts";

export interface ExtensionManagerSnapshot {
	snapshot: ExtensionSnapshot;
	plugins: readonly PluginDescriptor[];
	skills: readonly SkillDescriptor[];
	hooks: readonly HookDescriptor[];
	mcpServers: readonly McpServerDescriptor[];
	skillCatalog: SkillCatalog;
	hookDispatcher: HookDispatcher;
	mcp: McpConnectionManager;
}

export type ExtensionReloadResult =
	| { status: "applied"; current: ExtensionManagerSnapshot }
	| { status: "pending"; current?: ExtensionManagerSnapshot }
	| { status: "failed"; reason: string; retained?: ExtensionManagerSnapshot };

function mcpToolDescriptors(servers: readonly McpServerDescriptor[], tools: readonly McpToolDefinition[], scope: ExtensionRuntimeScope): ExtensionResourceDescriptor[] {
	return tools.map((tool) => {
		const server = servers.find((item) => item.descriptor.identity.qualifiedId === tool.serverId);
		if (!server) throw new Error("MCP catalog references an unknown server");
		const qualifiedId = qualifiedResourceId({ kind: "mcp-tool", sourceKey: server.descriptor.identity.qualifiedId, name: tool.rawName, ...(server.descriptor.pluginId ? { pluginId: server.descriptor.pluginId } : {}) });
		const schemaJson = canonicalJson(tool.inputSchema);
		const capabilityDigest = canonicalDigest({ server: server.descriptor.manifest.capabilityDigest, schema: tool.inputSchema, annotations: tool.annotations });
		const manifest = buildResourceManifestDigest({ rootDigest: server.descriptor.manifest.rootDigest, manifestDigest: server.descriptor.manifest.manifestDigest, configDigest: server.descriptor.manifest.configDigest, commandDigest: server.descriptor.manifest.commandDigest, assetsDigest: server.descriptor.manifest.assetsDigest, capabilityDigest });
		const identity = createExtensionResourceIdentity({ scope, kind: "mcp-tool", qualifiedId, version: "1", source: server.descriptor.identity.source, digest: manifest.combinedDigest });
		return {
			schemaVersion: 1,
			kind: "mcp-tool",
			identity,
			provenance: server.descriptor.provenance,
			manifest,
			displayName: tool.rawName,
			description: tool.description,
			runtimeName: mcpRuntimeName(server.rawName, tool.rawName),
			sourcePath: server.configPath,
			...(server.descriptor.pluginId ? { pluginId: server.descriptor.pluginId } : {}),
			enabled: true,
			trust: server.descriptor.trust,
			activation: "ready" as const,
			...(server.descriptor.approvalReceiptId ? { approvalReceiptId: server.descriptor.approvalReceiptId } : {}),
			capabilities: server.descriptor.capabilities,
			risk: { level: tool.annotations.destructive ? "high" as const : "moderate" as const, sideEffect: tool.annotations.readOnly ? "read" as const : "external" as const, rationaleDigest: capabilityDigest },
			exposure: tool.pinned ? "direct" as const : "deferred" as const,
			diagnostics: [],
			tool: { inputSchemaJson: schemaJson, maxInputBytes: 4 * 1024 * 1024, resultContentKinds: ["text", "image", "resource", "json"], execution: { readOnly: tool.annotations.readOnly, destructive: tool.annotations.destructive, concurrencySafe: tool.annotations.concurrencySafe } },
		};
	});
}

function activationForMcpState(state: McpServerState): ExtensionResourceDescriptor["activation"] {
	if (state === "ready") return "ready";
	if (state === "disabled") return "disabled";
	if (state === "blocked-untrusted" || state === "auth-required") return "blocked";
	return "failed";
}

export class ExtensionManager {
	readonly #scope: ExtensionRuntimeScope;
	readonly #roots: readonly ExtensionSourceRoot[];
	readonly #storage: ExtensionStoragePort;
	readonly #trustStore: TrustStore;
	readonly #stateStore: ExtensionStateStore;
	readonly #pluginDataRoot: string;
	readonly #environment: Readonly<Record<string, string | undefined>>;
	readonly #hookExecutor?: HookCommandExecutorPort;
	readonly #mcpFactory?: McpClientFactoryPort;
	readonly #mcpAuthorization?: McpOperationAuthorizationPort;
	readonly #mcpAuxiliaryAuthorization?: McpAuxiliaryAuthorizationPort;
	readonly #mcpEvents?: McpStateEventSinkPort;
	readonly #mcpScheduler?: McpSchedulerPort;
	readonly #spill?: ExtensionSpillPort;
	readonly #snapshots = new ExtensionSnapshotStore();
	#current?: ExtensionManagerSnapshot;
	#reloadPending = false;

	public constructor(options: {
		scope: ExtensionRuntimeScope;
		roots: readonly ExtensionSourceRoot[];
		storage: ExtensionStoragePort;
		trustStore: TrustStore;
		stateStore: ExtensionStateStore;
		pluginDataRoot: string;
		environment?: Readonly<Record<string, string | undefined>>;
		hookExecutor?: HookCommandExecutorPort;
		mcpFactory?: McpClientFactoryPort;
		mcpAuthorization?: McpOperationAuthorizationPort;
		mcpAuxiliaryAuthorization?: McpAuxiliaryAuthorizationPort;
		mcpEvents?: McpStateEventSinkPort;
		mcpScheduler?: McpSchedulerPort;
		spill?: ExtensionSpillPort;
	}) {
		this.#scope = options.scope;
		this.#roots = options.roots;
		this.#storage = options.storage;
		this.#trustStore = options.trustStore;
		this.#stateStore = options.stateStore;
		this.#pluginDataRoot = options.pluginDataRoot;
		this.#environment = options.environment ?? {};
		this.#hookExecutor = options.hookExecutor;
		this.#mcpFactory = options.mcpFactory;
		this.#mcpAuthorization = options.mcpAuthorization;
		this.#mcpAuxiliaryAuthorization = options.mcpAuxiliaryAuthorization;
		this.#mcpEvents = options.mcpEvents;
		this.#mcpScheduler = options.mcpScheduler;
		this.#spill = options.spill;
	}

	public current(): ExtensionManagerSnapshot | undefined { return this.#current; }

	public beginTurn(): ExtensionManagerSnapshot {
		this.#snapshots.beginTurn();
		if (!this.#current) throw new Error("extension manager is not initialized");
		return this.#current;
	}

	public async endTurn(): Promise<ExtensionReloadResult | undefined> {
		const ready = this.#snapshots.endTurn();
		if (ready || this.#reloadPending) return this.reload();
		return undefined;
	}

	public requestReload(): ExtensionReloadResult {
		if (this.#snapshots.requestReload() === "pending") {
			this.#reloadPending = true;
			return { status: "pending", ...(this.#current ? { current: this.#current } : {}) };
		}
		return { status: "pending", ...(this.#current ? { current: this.#current } : {}) };
	}

	public async reload(signal?: AbortSignal): Promise<ExtensionReloadResult> {
		if (this.#snapshots.requestReload() === "pending") {
			this.#reloadPending = true;
			return { status: "pending", ...(this.#current ? { current: this.#current } : {}) };
		}
		const generation = (this.#current?.snapshot.generation ?? 0) + 1;
		try {
			const state = await this.#stateStore.load();
			const standaloneSkills = await discoverSkills({ roots: this.#roots, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, state });
			const standaloneHooks = await discoverHooks({ roots: this.#roots, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, state });
			const standaloneMcpLayers = await Promise.all(this.#roots.map((root) => loadMcpConfig({ configPath: join(root.rootPath, "mcp.json"), root, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, optional: true, environment: this.#environment, state })));
			const pluginDiscovery = await discoverPlugins({ roots: this.#roots, scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, state, pluginDataRoot: this.#pluginDataRoot });
			const pluginManager = new PluginManager({ scope: this.#scope, trustStore: this.#trustStore, storage: this.#storage, state, environment: this.#environment });
			const contributions = await Promise.all(pluginDiscovery.plugins.map((plugin) => pluginManager.contributions(plugin)));
			const skills = [...standaloneSkills.skills, ...contributions.flatMap((value) => value.skills)];
			const hooks = [...standaloneHooks.hooks, ...contributions.flatMap((value) => value.hooks)];
			const mcpMerged = mergeMcpServers([...standaloneMcpLayers, { servers: contributions.flatMap((value) => value.mcpServers), diagnostics: contributions.flatMap((value) => value.diagnostics) }]);
			const mcp = new McpConnectionManager({ servers: mcpMerged.servers, ...(this.#mcpFactory ? { factory: this.#mcpFactory } : {}), ...(this.#mcpAuthorization ? { authorization: this.#mcpAuthorization } : {}), ...(this.#mcpAuxiliaryAuthorization ? { auxiliaryAuthorization: this.#mcpAuxiliaryAuthorization } : {}), ...(this.#mcpEvents ? { events: this.#mcpEvents } : {}), ...(this.#mcpScheduler ? { scheduler: this.#mcpScheduler } : {}), ...(this.#spill ? { spill: this.#spill } : {}) });
			await mcp.startAll(signal);
			const required = mcp.requiredGate();
			if (!required.ok) {
				await mcp.closeAll();
				return { status: "failed", reason: required.message, ...(this.#current ? { retained: this.#current } : {}) };
			}
			const statusByServer = new Map(mcp.status().map((status) => [status.serverId, status]));
			const activatedServers = mcpMerged.servers.map((server) => {
				const status = statusByServer.get(server.descriptor.identity.qualifiedId);
				if (!status) return server;
				const activation = activationForMcpState(status.state);
				const statusDiagnostics = activation === "failed"
					? [extensionDiagnostic("mcp.activation_failed", "error", status.reason ?? "MCP server failed to activate", "mcp", server.configPath)]
					: [];
				return { ...server, descriptor: { ...server.descriptor, activation, diagnostics: [...server.descriptor.diagnostics, ...statusDiagnostics] } };
			});
			const toolDescriptors = mcpToolDescriptors(activatedServers, mcp.catalog().list(), this.#scope);
			const diagnostics: ExtensionDiagnostic[] = [
				...standaloneSkills.diagnostics,
				...standaloneHooks.diagnostics,
				...standaloneMcpLayers.flatMap((value) => value.diagnostics),
				...pluginDiscovery.diagnostics,
				...contributions.flatMap((value) => value.diagnostics),
				...mcp.catalog().diagnostics(),
			];
			if (!this.#mcpEvents && mcpMerged.servers.some((server) => server.descriptor.enabled && server.descriptor.trust === "trusted")) diagnostics.push(extensionDiagnostic("mcp.audit_unavailable", "error", "MCP activation is fail-closed because durable audit is unavailable", "mcp"));
			const snapshot = buildExtensionSnapshot({ generation, createdAt: new Date().toISOString(), descriptors: [...pluginDiscovery.plugins.map((plugin) => plugin.descriptor), ...skills.map((skill) => skill.descriptor), ...hooks.map((hook) => hook.descriptor), ...activatedServers.map((server) => server.descriptor), ...toolDescriptors], diagnostics });
			const swapped = this.#snapshots.swap(snapshot);
			if (!swapped.ok) {
				await mcp.closeAll();
				return { status: "failed", reason: swapped.error, ...(this.#current ? { retained: this.#current } : {}) };
			}
			const next: ExtensionManagerSnapshot = { snapshot, plugins: pluginDiscovery.plugins, skills, hooks, mcpServers: activatedServers, skillCatalog: new SkillCatalog(skills), hookDispatcher: new HookDispatcher(hooks, new HookRunner({ ...(this.#hookExecutor ? { executor: this.#hookExecutor } : {}), ...(this.#spill ? { spill: this.#spill } : {}) })), mcp };
			const previous = this.#current;
			this.#current = next;
			this.#reloadPending = false;
			if (previous) await previous.mcp.closeAll();
			return { status: "applied", current: next };
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : "extension snapshot build failed", ...(this.#current ? { retained: this.#current } : {}) };
		}
	}

	public async close(): Promise<void> {
		await this.#current?.mcp.closeAll();
		this.#current = undefined;
	}
}
