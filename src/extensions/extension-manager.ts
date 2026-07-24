/** 四数据面的唯一装配入口与 idle 原子 reload。 */

import { join } from "node:path";
import { canonicalDigest, canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { createExtensionResourceIdentity, mcpRuntimeName, qualifiedResourceId } from "./identity.ts";
import { discoverHooks } from "./hooks/discovery.ts";
import type { HookCommandExecutorPort, HookDescriptor, HookHttpHandlerPort } from "./hooks/types.ts";
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
import { runBoundedDiscovery } from "./discovery-worker.ts";

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

/**
 * discovery-only 结果不持有 runner、client、transport、process 或 executable
 * handler。调用方可安全用于 inspect/list/validate。
 */
export interface ExtensionDiscoverySnapshot {
	schemaVersion: 1;
	snapshot: ExtensionSnapshot;
	plugins: readonly PluginDescriptor[];
	skills: readonly SkillDescriptor[];
	hooks: readonly HookDescriptor[];
	mcpServers: readonly McpServerDescriptor[];
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
	readonly #hookHttpHandler?: HookHttpHandlerPort;
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
			hookHttpHandler?: HookHttpHandlerPort;
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
		this.#hookHttpHandler = options.hookHttpHandler;
		this.#mcpFactory = options.mcpFactory;
		this.#mcpAuthorization = options.mcpAuthorization;
		this.#mcpAuxiliaryAuthorization = options.mcpAuxiliaryAuthorization;
		this.#mcpEvents = options.mcpEvents;
		this.#mcpScheduler = options.mcpScheduler;
		this.#spill = options.spill;
	}

	public current(): ExtensionManagerSnapshot | undefined { return this.#current; }

	async #discover(generation: number): Promise<{
		plugins: readonly PluginDescriptor[];
		skills: readonly SkillDescriptor[];
		hooks: readonly HookDescriptor[];
		mcpServers: readonly McpServerDescriptor[];
		diagnostics: readonly ExtensionDiagnostic[];
	}> {
		const state = await this.#stateStore.load();
		// 即使没有资源，也要验证 trust 文档，确保 inspect 能暴露损坏控制状态。
		await this.#trustStore.load();
		type RootResult =
			| { kind: "skill"; value: Awaited<ReturnType<typeof discoverSkills>> }
			| { kind: "hook"; value: Awaited<ReturnType<typeof discoverHooks>> }
			| { kind: "mcp"; value: Awaited<ReturnType<typeof loadMcpConfig>> }
			| { kind: "plugin"; value: Awaited<ReturnType<typeof discoverPlugins>> };
		const tasks = this.#roots.flatMap((root) => root.layout === "plugin-root" ? [
			{
				rootPriority: root.priority,
				canonicalPath: root.rootPath,
				entryName: "plugin",
				run: async (): Promise<RootResult> => ({
					kind: "plugin",
					value: await discoverPlugins({
						roots: [root],
						scope: this.#scope,
						trustStore: this.#trustStore,
						storage: this.#storage,
						state,
						pluginDataRoot: this.#pluginDataRoot,
					}),
				}),
			},
		] : [
			{
				rootPriority: root.priority,
				canonicalPath: root.rootPath,
				entryName: "skill",
				run: async (): Promise<RootResult> => ({
					kind: "skill",
					value: await discoverSkills({
						roots: [root],
						scope: this.#scope,
						trustStore: this.#trustStore,
						storage: this.#storage,
						state,
					}),
				}),
			},
			{
				rootPriority: root.priority,
				canonicalPath: root.rootPath,
				entryName: "hook",
				run: async (): Promise<RootResult> => ({
					kind: "hook",
					value: await discoverHooks({
						roots: [root],
						scope: this.#scope,
						trustStore: this.#trustStore,
						storage: this.#storage,
						state,
					}),
				}),
			},
			{
				rootPriority: root.priority,
				canonicalPath: root.rootPath,
				entryName: "mcp",
				run: async (): Promise<RootResult> => ({
					kind: "mcp",
					value: await loadMcpConfig({
						configPath: join(root.rootPath, "mcp.json"),
						root,
						scope: this.#scope,
						trustStore: this.#trustStore,
						storage: this.#storage,
						optional: true,
						environment: this.#environment,
						state,
					}),
				}),
			},
			{
				rootPriority: root.priority,
				canonicalPath: root.rootPath,
				entryName: "plugin",
				run: async (): Promise<RootResult> => ({
					kind: "plugin",
					value: await discoverPlugins({
						roots: [root],
						scope: this.#scope,
						trustStore: this.#trustStore,
						storage: this.#storage,
						state,
						pluginDataRoot: this.#pluginDataRoot,
					}),
				}),
			},
		]);
		const rootResults = await runBoundedDiscovery(tasks);
		const skillResults = rootResults.filter(
			(result): result is Extract<RootResult, { kind: "skill" }> => result.kind === "skill",
		);
		const hookResults = rootResults.filter(
			(result): result is Extract<RootResult, { kind: "hook" }> => result.kind === "hook",
		);
		const mcpResults = rootResults.filter(
			(result): result is Extract<RootResult, { kind: "mcp" }> => result.kind === "mcp",
		);
		const pluginResults = rootResults.filter(
			(result): result is Extract<RootResult, { kind: "plugin" }> => result.kind === "plugin",
		);
		const plugins = pluginResults
			.flatMap((result) => result.value.plugins)
			.sort((left, right) =>
				left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)
			);
		const pluginManager = new PluginManager({
			scope: this.#scope,
			trustStore: this.#trustStore,
			storage: this.#storage,
			state,
			environment: this.#environment,
		});
		const contributions = await runBoundedDiscovery(
			plugins.map((plugin) => ({
				rootPriority: 0,
				canonicalPath: plugin.rootPath,
				entryName: plugin.descriptor.identity.qualifiedId,
				run: () => pluginManager.contributions(plugin),
			})),
		);
		const skills = [
			...skillResults.flatMap((result) => result.value.skills),
			...contributions.flatMap((value) => value.skills),
		].sort((left, right) =>
			left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)
		);
		const hooks = [
			...hookResults.flatMap((result) => result.value.hooks),
			...contributions.flatMap((value) => value.hooks),
		].sort((left, right) =>
			left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)
		);
		const mcpMerged = mergeMcpServers([
			...mcpResults.map((result) => result.value),
			{
				servers: contributions.flatMap((value) => value.mcpServers),
				diagnostics: contributions.flatMap((value) => value.diagnostics),
			},
		]);
		const diagnostics = [
			...skillResults.flatMap((result) => result.value.diagnostics),
			...hookResults.flatMap((result) => result.value.diagnostics),
			...mcpResults.flatMap((result) => result.value.diagnostics),
			...pluginResults.flatMap((result) => result.value.diagnostics),
			...contributions.flatMap((value) => value.diagnostics),
			...(this.#stateStore.loadError()
				? [extensionDiagnostic(
					"extensions.state_invalid",
					"error",
					this.#stateStore.loadError()!,
					"extensions",
				)]
				: []),
			...(this.#trustStore.loadError()
				? [extensionDiagnostic(
					"extensions.trust_invalid",
					"error",
					this.#trustStore.loadError()!,
					"extensions",
				)]
				: []),
		];
		void generation;
		return { plugins, skills, hooks, mcpServers: mcpMerged.servers, diagnostics };
	}

	public async inspect(): Promise<ExtensionDiscoverySnapshot> {
		const generation = (this.#current?.snapshot.generation ?? 0) + 1;
		const discovered = await this.#discover(generation);
		const inspectionServers = discovered.mcpServers.map((server) => {
			if (!server.descriptor.enabled || server.descriptor.trust !== "trusted") return server;
			const diagnostic = extensionDiagnostic(
				"mcp.activation_not_attempted",
				"info",
				"MCP activation is intentionally skipped during discovery-only inspection",
				"mcp",
				server.configPath,
			);
			return {
				...server,
				descriptor: {
					...server.descriptor,
					activation: "blocked" as const,
					diagnostics: [...server.descriptor.diagnostics, diagnostic],
				},
			};
		});
		const snapshot = buildExtensionSnapshot({
			generation,
			createdAt: new Date().toISOString(),
			descriptors: [
				...discovered.plugins.map((plugin) => plugin.descriptor),
				...discovered.skills.map((skill) => skill.descriptor),
				...discovered.hooks.map((hook) => hook.descriptor),
				...inspectionServers.map((server) => server.descriptor),
			],
			diagnostics: discovered.diagnostics,
		});
		return Object.freeze({
			schemaVersion: 1 as const,
			snapshot,
			plugins: Object.freeze([...discovered.plugins]),
			skills: Object.freeze([...discovered.skills]),
			hooks: Object.freeze([...discovered.hooks]),
			mcpServers: Object.freeze(inspectionServers),
		});
	}

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
			const discovered = await this.#discover(generation);
			const mcp = new McpConnectionManager({ servers: discovered.mcpServers, ...(this.#mcpFactory ? { factory: this.#mcpFactory } : {}), ...(this.#mcpAuthorization ? { authorization: this.#mcpAuthorization } : {}), ...(this.#mcpAuxiliaryAuthorization ? { auxiliaryAuthorization: this.#mcpAuxiliaryAuthorization } : {}), ...(this.#mcpEvents ? { events: this.#mcpEvents } : {}), ...(this.#mcpScheduler ? { scheduler: this.#mcpScheduler } : {}), ...(this.#spill ? { spill: this.#spill } : {}) });
			await mcp.startAll(signal);
			const required = mcp.requiredGate();
			if (!required.ok) {
				await mcp.closeAll();
				return { status: "failed", reason: required.message, ...(this.#current ? { retained: this.#current } : {}) };
			}
			const statusByServer = new Map(mcp.status().map((status) => [status.serverId, status]));
			const activatedServers = discovered.mcpServers.map((server) => {
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
				...discovered.diagnostics,
				...mcp.catalog().diagnostics(),
			];
			if (!this.#mcpEvents && discovered.mcpServers.some((server) => server.descriptor.enabled && server.descriptor.trust === "trusted")) diagnostics.push(extensionDiagnostic("mcp.audit_unavailable", "error", "MCP activation is fail-closed because durable audit is unavailable", "mcp"));
			const snapshot = buildExtensionSnapshot({ generation, createdAt: new Date().toISOString(), descriptors: [...discovered.plugins.map((plugin) => plugin.descriptor), ...discovered.skills.map((skill) => skill.descriptor), ...discovered.hooks.map((hook) => hook.descriptor), ...activatedServers.map((server) => server.descriptor), ...toolDescriptors], diagnostics });
			const swapped = this.#snapshots.swap(snapshot);
			if (!swapped.ok) {
				await mcp.closeAll();
				return { status: "failed", reason: swapped.error, ...(this.#current ? { retained: this.#current } : {}) };
			}
			const next: ExtensionManagerSnapshot = { snapshot, plugins: discovered.plugins, skills: discovered.skills, hooks: discovered.hooks, mcpServers: activatedServers, skillCatalog: new SkillCatalog(discovered.skills), hookDispatcher: new HookDispatcher(discovered.hooks, new HookRunner({ ...(this.#hookExecutor ? { executor: this.#hookExecutor } : {}), ...(this.#hookHttpHandler ? { http: this.#hookHttpHandler } : {}), ...(this.#spill ? { spill: this.#spill } : {}) })), mcp };
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
