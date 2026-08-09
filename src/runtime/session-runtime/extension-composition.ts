import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ExtensionPublicSnapshot, ExtensionReloadResult } from "../../extensions/manager.ts";
import { ExtensionManager } from "../../extensions/manager.ts";
import { PluginManager } from "../../extensions/plugins/manager.ts";
import { ExtensionStateStore } from "../../extensions/state-store.ts";
import { NodeExtensionStorage } from "../../storage/extensions/extension-storage.ts";
import { TrustStore } from "../../extensions/trust/trust-store.ts";
import { sourceKey } from "../../extensions/paths.ts";
import type { ExtensionSource, ExtensionSourceRoot } from "../../extensions/types.ts";
import type { McpServerSnapshot } from "../../extensions/mcp/connection-manager.ts";
import { McpConnectionManager } from "../../extensions/mcp/connection-manager.ts";
import { createMcpExecutionEnvFetch, createSdkMcpClientFactory } from "../../extensions/mcp/sdk-factory.ts";
import { loadCanonicalMcpConfigs, parseMcpConfigDocument } from "../../extensions/mcp/config.ts";
import type { McpServerConfig } from "../../extensions/mcp/types.ts";
import { SkillCatalog } from "../../extensions/skills/catalog.ts";
import { SkillToolResolver } from "../../extensions/skills/skill-tool.ts";
import { RuntimeHookAdapter } from "../../extensions/integration/runtime-hook-adapter.ts";
import { runHookPipeline } from "../../extensions/hooks/pipeline.ts";
import { createHostManagedHookRunner } from "../../extensions/hooks/host-runner.ts";
import { HostHookRuntime } from "../../extensions/hooks/runtime.ts";
import { ExtensionTurnLifecycle, type ExtensionHookRuntime } from "../../extensions/turn-lifecycle.ts";
import { createSkillTool, type SkillLoader } from "../tools/skill.ts";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import type { ProcessToolClient } from "../tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../tools/bash.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import { workspaceStorageKey } from "../contracts/storage-layout.ts";
import { createRuntimeId, parseRuntimeId } from "../protocol/ids.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { SessionDomainResult } from "./domain-router.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";

export interface SessionExtensionManagerPort {
	load(): Promise<ExtensionReloadResult>;
	publicSnapshot(): ExtensionPublicSnapshot | undefined;
}

export interface SessionMcpRuntimePort {
	start(): Promise<{
		readonly ok: boolean;
		readonly snapshots: readonly McpServerSnapshot[];
		readonly requiredFailures: readonly { readonly serverId: string; readonly code: string; readonly message: string }[];
	}>;
	snapshots(): readonly McpServerSnapshot[];
	tools(): readonly AgentTool[];
	close(): Promise<void>;
}

export interface SessionExtensionAuditEvent {
	readonly eventType: string;
	readonly sessionId: string;
	readonly ownerGeneration: number;
	readonly payload: Record<string, unknown>;
}

export interface SessionExtensionCompositionOptions {
	readonly sessionId: string;
	readonly generation: number;
	readonly manager: SessionExtensionManagerPort;
	readonly mcp: SessionMcpRuntimePort;
	readonly skillLoader?: SkillLoader;
	readonly closeHooks: () => Promise<void>;
	readonly closePlugins: () => Promise<void>;
	readonly cleanup: () => Promise<void>;
	readonly audit?: (event: SessionExtensionAuditEvent) => Promise<void>;
}

export interface SessionExtensionComposition {
	readonly tools: readonly AgentTool[];
	readonly resources: SessionResourceDomainPort;
	readonly hookRuntime?: ExtensionHookRuntime;
	readonly turnLifecycle?: ExtensionTurnLifecycle;
	start(): Promise<void>;
	shutdown(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
}

export interface ProductionSessionExtensionCompositionOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly workspaceId: string;
	readonly repositoryId: string;
	readonly executionEnv: ExecutionEnv;
	readonly managedProcess: ProcessToolClient & Pick<ManagedBackgroundBashOperations, "start">;
	readonly attemptPort: () => AttemptPort | undefined;
	readonly baseToolNames: readonly string[];
}

export class SessionExtensionStartupError extends Error {
	public readonly code: "required_extension_startup_failed";

	public constructor(message: string) {
		super(message);
		this.name = "SessionExtensionStartupError";
		this.code = "required_extension_startup_failed";
	}
}

const OPERATION_MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "extension.inspect", capability: "session.extensions", access: "read" }),
	Object.freeze({ operation: "plugin.list", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "skill.list", capability: "session.skills", access: "read" }),
	Object.freeze({ operation: "hook.list", capability: "session.hooks", access: "read" }),
	Object.freeze({ operation: "mcp.list", capability: "session.mcp", access: "read" }),
	Object.freeze({ operation: "mcp.doctor", capability: "session.mcp", access: "read" }),
]);

/**
 * S5:协调一个 owned SessionRuntime 私有的扩展快照、MCP 连接与清理顺序。
 * 具体 filesystem/network/process adapter 由 production factory 注入，本层不
 * 持有 raw handle，也不共享跨 Session registry。
 */
export function createSessionExtensionComposition(options: SessionExtensionCompositionOptions): SessionExtensionComposition {
	let shutdownPromise: Promise<void> | undefined;
	const tools: AgentTool[] = [
		...(options.skillLoader === undefined ? [] : [createSkillTool({ loader: options.skillLoader })]),
		...options.mcp.tools(),
	];
	const resources: SessionResourceDomainPort = {
		operationManifest: OPERATION_MANIFEST,
		query: async (operation) => queryResources(options, operation),
	};
	return {
		tools,
		resources,
		start: async () => {
			const loaded = await options.manager.load();
			if (loaded.status === "failed") {
				await audit(options, "extension.snapshot.required_failed", { error: loaded.error ?? "extension snapshot load failed" });
				throw new SessionExtensionStartupError(loaded.error ?? "extension snapshot load failed");
			}
			await audit(options, "extension.snapshot.loaded", {
				snapshotId: options.manager.publicSnapshot()?.snapshotId ?? "unavailable",
				generation: options.manager.publicSnapshot()?.generation ?? 0,
			});
			const started = await options.mcp.start();
			for (const snapshot of started.snapshots) {
				if (snapshot.state === "failed" && !snapshot.required) {
					await audit(options, "extension.mcp.optional_failed", { serverId: snapshot.serverId, generation: snapshot.generation });
				}
			}
			if (!started.ok || started.requiredFailures.length > 0) {
				await audit(options, "extension.mcp.required_failed", {
					failures: started.requiredFailures.map((failure) => ({ serverId: failure.serverId, code: failure.code })),
				});
				await options.mcp.close().catch(() => undefined);
				throw new SessionExtensionStartupError("required MCP startup failed");
			}
		},
		shutdown: (reason) => {
			shutdownPromise ??= (async () => {
				await options.mcp.close();
				await options.closeHooks();
				await options.closePlugins();
				await options.cleanup();
				await audit(options, "extension.shutdown.completed", { reason });
			})();
			return shutdownPromise;
		},
	};
}

function queryResources(options: SessionExtensionCompositionOptions, operation: string): SessionDomainResult {
	const snapshot = options.manager.publicSnapshot();
	const mcp = options.mcp.snapshots();
	if (operation === "extension.inspect") {
		return ok(operation, options.generation, { snapshot: snapshot ?? emptySnapshot(options.generation), mcp });
	}
	if (operation === "mcp.list" || operation === "mcp.doctor") {
		return ok(operation, options.generation, { items: mcp });
	}
	const kind = operation === "plugin.list" ? "plugin" : operation === "skill.list" ? "skill" : operation === "hook.list" ? "hook" : undefined;
	if (kind !== undefined) {
		return ok(operation, options.generation, {
			items: (snapshot?.descriptors ?? []).filter((descriptor) => descriptor.kind === kind || descriptor.identity.kind === kind),
		});
	}
	return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
}

function ok(operation: string, domainRevision: number, value: Record<string, unknown>): SessionDomainResult {
	return { ok: true, status: "ok", operation, domainRevision, value };
}

function emptySnapshot(generation: number): ExtensionPublicSnapshot {
	return {
		snapshotId: "snapshot_unavailable",
		generation,
		createdAt: new Date(0).toISOString(),
		descriptors: [],
		diagnostics: [],
		counts: { plugins: 0, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 0, blocked: 0, disabled: 0, error: 0 },
		digest: "0".repeat(64),
	};
}

async function audit(options: SessionExtensionCompositionOptions, eventType: string, payload: Record<string, unknown>): Promise<void> {
	await options.audit?.({ eventType, sessionId: options.sessionId, ownerGeneration: options.generation, payload });
}

const mcpCatalogSchema = Type.Object({}, { additionalProperties: false });
const mcpSearchSchema = Type.Object({
	query: Type.String({ minLength: 0, maxLength: 512 }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
}, { additionalProperties: false });
const mcpCallSchema = Type.Object({
	serverId: Type.String({ minLength: 1, maxLength: 256 }),
	toolName: Type.String({ minLength: 1, maxLength: 256 }),
	input: Type.Unknown(),
}, { additionalProperties: false });

type McpSearchInput = Static<typeof mcpSearchSchema>;
type McpCallInput = Static<typeof mcpCallSchema>;

/**
 * S5 production factory：每次 owned Session 都创建独立 manager、snapshot、
 * MCP connection 与 Skill resolver；不复用 resident Host composition。
 */
export async function createProductionSessionExtensionComposition(
	options: ProductionSessionExtensionCompositionOptions,
): Promise<SessionExtensionComposition> {
	const storage = new NodeExtensionStorage({ runledgerHome: options.layout.home });
	const stateRoot = join(options.layout.state, "extensions");
	const authorityId = createRuntimeId("authority", "session-owner-runtime");
	const tenantId = createRuntimeId("tenant", "local-user");
	const workspaceId = parseRuntimeId("workspace", options.workspaceId) ?? createRuntimeId("workspace", runtimeDigest(options.workspaceId).digest);
	const repositoryId = parseRuntimeId("repository", options.repositoryId) ?? createRuntimeId("repository", runtimeDigest(options.repositoryId).digest);
	const storageKey = workspaceStorageKey({ authorityId, tenantId, workspaceId, repositoryId });
	const principalId = createRuntimeId("principal", `session-extension-${runtimeDigest({ sessionId: options.fence.sessionId, generation: options.fence.generation }).digest.slice(0, 48)}`);
	const trustStore = new TrustStore(join(stateRoot, "trust.json"), storage);
	const pluginManager = new PluginManager({
		storage,
		trustStore,
		stateStore: new ExtensionStateStore(join(stateRoot, "extensions-state.json"), storage),
		scope: { authorityId, tenantId, principalId },
		roots: await discoverPluginRoots(storage, [
			{ source: "user", root: join(stateRoot, "user", "plugins"), priority: 100 },
			{ source: "project", root: join(stateRoot, "workspaces", storageKey, "plugins"), priority: 200 },
		]),
	});
	const manager = new ExtensionManager({ pluginManager });
	const mcpManager = new McpConnectionManager({
		factory: createSdkMcpClientFactory({
			managedProcess: options.managedProcess,
			managedProcessCwd: options.cwd,
			...(options.executionEnv.network === undefined ? {} : { httpFetch: createMcpExecutionEnvFetch(options.executionEnv.network) }),
		}),
	});
	const mcp = createSessionMcpRuntime({
		manager: mcpManager,
		configs: async () => loadSessionMcpConfigs({ options, storage, storageKey, pluginManager }),
		attemptPort: options.attemptPort,
	});
	const extensionToolNames = ["Skill", ...mcp.tools().map((tool) => tool.name)];
	const skillLoader: SkillLoader = async (name) => {
		const resolver = new SkillToolResolver({
			catalog: new SkillCatalog(manager.currentSkills()),
			trustStore,
			principalId,
			storage,
			currentTools: () => [...options.baseToolNames, ...extensionToolNames],
		});
		const loaded = await resolver.load(name);
		return loaded.ok
			? { ok: true, body: loaded.value.body, allowedTools: loaded.value.allowedTools }
			: { ok: false, code: loaded.code, message: loaded.message };
	};
	const adapter = {
		adapterId: "runledger.session.hooks",
		generation: options.fence.generation,
		configDigest: runtimeDigest({ sessionId: options.fence.sessionId, generation: options.fence.generation, storageKey }),
	};
	const identity = {
		authorityId,
		tenantId,
		principalId,
		principalKind: "local" as const,
		issuedAt: new Date().toISOString(),
	};
	const hookRuntime = new HostHookRuntime({
		hooks: () => manager.currentHooks(),
		adapter: new RuntimeHookAdapter({
			pipeline: runHookPipeline,
			runner: createHostManagedHookRunner({ managedProcess: options.managedProcess, defaultCwd: options.cwd }),
			resources: {
				invocation: {
					execute: async (request) => ({
						port: request.port,
						action: request.action,
						requestId: request.requestId,
						outcome: "ok",
						effect: "terminal",
						adapter,
						outputDigest: runtimeDigest({ sessionId: options.fence.sessionId, generation: options.fence.generation, requestId: request.requestId }),
						receiptRef: { subjectKind: "receipt", digest: runtimeDigest({ sessionId: options.fence.sessionId, generation: options.fence.generation, inputDigest: request.inputDigest }), mediaType: "application/vnd.runledger.session-extension-gate+json", size: 0 },
						completedAt: new Date().toISOString(),
					}),
				},
			},
			adapter,
		}),
		identity,
		source: "session-runtime",
		audit: async ({ audit: hookAudit, auditDigest }) => appendSessionExtensionAudit(options.store, options.fence, {
			eventType: "extension.hook.invoked",
			sessionId: options.fence.sessionId,
			ownerGeneration: options.fence.generation,
			payload: { requestId: hookAudit.requestId, outcome: hookAudit.outcome, auditDigest },
		}),
	});
	const turnLifecycle = new ExtensionTurnLifecycle({
		manager,
		sessionId: options.fence.sessionId,
		hookRuntime,
		onIdleReload: async (result) => appendSessionExtensionAudit(options.store, options.fence, {
			eventType: "extension.snapshot.idle_reloaded",
			sessionId: options.fence.sessionId,
			ownerGeneration: options.fence.generation,
			payload: { status: result.status, snapshotId: manager.publicSnapshot()?.snapshotId ?? "unavailable" },
		}),
	});
	const composition = createSessionExtensionComposition({
		sessionId: options.fence.sessionId,
		generation: options.fence.generation,
		manager,
		mcp,
		skillLoader,
		closeHooks: () => turnLifecycle.cancelTurn(),
		closePlugins: async () => undefined,
		cleanup: async () => undefined,
		audit: async (event) => appendSessionExtensionAudit(options.store, options.fence, event),
	});
	return { ...composition, hookRuntime, turnLifecycle };
}

function createSessionMcpRuntime(input: {
	readonly manager: McpConnectionManager;
	readonly configs: () => Promise<readonly McpServerConfig[]>;
	readonly attemptPort: () => AttemptPort | undefined;
}): SessionMcpRuntimePort {
	const catalog = (): readonly McpServerSnapshot[] => input.manager.snapshots();
	const catalogTool: AgentTool<typeof mcpCatalogSchema> = {
			name: "mcp_catalog",
			label: "MCP catalog",
			description: "List this Session's bounded MCP server and tool catalog.",
			parameters: mcpCatalogSchema,
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			execute: async () => toolResult({ servers: catalog() }),
	};
	const searchTool: AgentTool<typeof mcpSearchSchema> = {
			name: "mcp_search",
			label: "MCP search",
			description: "Search this Session's MCP tool catalog without invoking a server.",
			parameters: mcpSearchSchema,
			isReadOnly: () => true,
			isConcurrencySafe: () => true,
			execute: async (_toolCallId: string, args: McpSearchInput) => {
				const query = args.query.toLocaleLowerCase();
				const results = catalog().flatMap((server) => server.tools
					.filter((tool) => `${server.serverId} ${tool.rawName} ${tool.runtimeName} ${tool.description ?? ""}`.toLocaleLowerCase().includes(query))
					.map((tool) => ({ serverId: server.serverId, rawName: tool.rawName, runtimeName: tool.runtimeName, description: tool.description ?? "", inputSchema: tool.inputSchema })))
					.slice(0, args.maxResults ?? 32);
				return toolResult({ query: args.query, results });
			},
	};
	const callTool: AgentTool<typeof mcpCallSchema> = {
			name: "mcp_call",
			label: "MCP call",
			description: "Invoke one MCP tool through this Session's recovery barrier.",
			parameters: mcpCallSchema,
			isDestructive: () => true,
			execute: async (_toolCallId: string, args: McpCallInput, signal?: AbortSignal) => {
				const port = input.attemptPort();
				if (port === undefined) return toolResult({ code: "attempt_port_unavailable" }, true);
				const begun = port.beginAttempt("external_mutation", runtimeDigest({ operation: "mcp.call", serverId: args.serverId, toolName: args.toolName, input: args.input }));
				if ("error" in begun) return toolResult({ code: begun.error }, true);
				const called = await input.manager.call({ serverId: args.serverId, toolName: args.toolName, input: args.input }, signal);
				const settled = port.settleAttempt(begun.attemptId, called.ok ? "committed" : "rejected", runtimeDigest(called));
				if (!settled.ok) return toolResult({ code: settled.code }, true);
				return called.ok ? toolResult(called.value, called.value.outcome !== "ok") : toolResult(called.error, true);
			},
	};
	const tools: readonly AgentTool[] = [catalogTool, searchTool, callTool];
	return {
		start: async () => {
			const requiredFailures: Array<{ readonly serverId: string; readonly code: string; readonly message: string }> = [];
			for (const config of await input.configs()) {
				const started = await input.manager.start(config);
				if (!started.ok && config.required) requiredFailures.push({ serverId: config.serverId, code: started.error.code, message: started.error.message });
			}
			return { ok: requiredFailures.length === 0, snapshots: catalog(), requiredFailures };
		},
		snapshots: catalog,
		tools: () => tools,
		close: () => input.manager.closeAll(),
	};
}

async function loadSessionMcpConfigs(input: {
	readonly options: ProductionSessionExtensionCompositionOptions;
	readonly storage: NodeExtensionStorage;
	readonly storageKey: string;
	readonly pluginManager: PluginManager;
}): Promise<readonly McpServerConfig[]> {
	const canonical = await loadCanonicalMcpConfigs({
		layout: input.options.layout,
		workspaceStorageKey: input.storageKey,
		storage: input.storage,
		environment: process.env,
	});
	if (canonical.diagnostics.some((item) => item.severity === "error")) {
		throw new SessionExtensionStartupError("canonical MCP configuration is invalid");
	}
	const configs = [...canonical.configs];
	for (const plugin of input.pluginManager.last()?.plugins ?? []) {
		const declaration = plugin.manifest.mcpServers;
		if (!plugin.descriptor.ready || !plugin.descriptor.enabled || !plugin.descriptor.trusted || declaration === undefined) continue;
		const path = resolve(plugin.rootPath, declaration);
		const bytes = await input.storage.readFile(path, 4 * 1024 * 1024);
		if (!bytes.ok) throw new SessionExtensionStartupError(`plugin MCP configuration is unavailable: ${plugin.descriptor.identity.qualifiedId}`);
		let document: unknown;
		try { document = JSON.parse(new TextDecoder().decode(bytes.value)) as unknown; }
		catch { throw new SessionExtensionStartupError(`plugin MCP configuration is invalid: ${plugin.descriptor.identity.qualifiedId}`); }
		const parsed = parseMcpConfigDocument(document, {
			source: "plugin",
			path,
			rootPath: plugin.rootPath,
			serverIdPrefix: `mcp-server:${plugin.descriptor.identity.qualifiedId}`,
			trusted: true,
			environment: process.env,
		});
		if (!parsed.ok) throw new SessionExtensionStartupError(`plugin MCP configuration is invalid: ${plugin.descriptor.identity.qualifiedId}`);
		configs.push(...parsed.configs);
	}
	return configs.sort((left, right) => left.serverId.localeCompare(right.serverId));
}

async function discoverPluginRoots(
	storage: NodeExtensionStorage,
	inputs: readonly { readonly source: ExtensionSource; readonly root: string; readonly priority: number }[],
): Promise<readonly ExtensionSourceRoot[]> {
	const roots: ExtensionSourceRoot[] = [];
	for (const input of inputs) {
		const root = await storage.realpath(input.root);
		if (!root.ok) continue;
		const candidates = [root.value];
		const entries = await storage.readDirectory(root.value);
		if (entries.ok) candidates.push(...entries.value.filter((entry) => entry.kind === "directory").sort((left, right) => left.name.localeCompare(right.name)).map((entry) => join(root.value, entry.name)));
		for (const candidate of candidates) {
			const manifest = await storage.stat(join(candidate, ".runledger-plugin", "plugin.json"));
			if (!manifest.ok || manifest.value.kind !== "file") continue;
			const canonical = await storage.realpath(candidate);
			if (canonical.ok) roots.push({ source: input.source, sourceKey: sourceKey(input.source, canonical.value), rootPath: canonical.value, priority: input.priority, layout: "plugin-root" });
		}
	}
	return roots;
}

function toolResult<T>(details: T, isError = false): AgentToolResult<T> {
	let text: string;
	try { text = JSON.stringify(details) ?? "null"; }
	catch { text = "[unserializable MCP result]"; }
	return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}

function appendSessionExtensionAudit(
	store: SessionStore,
	fence: OwnerFence,
	event: SessionExtensionAuditEvent,
): void {
	const tail = store.replaySessionEvents(fence.sessionId).at(-1);
	store.appendEvent(fence, {
		eventId: createRuntimeId("event", `extension-${runtimeDigest({ event, head: tail?.sequence ?? 0 }).digest.slice(0, 48)}`),
		ownerGeneration: fence.generation,
		eventType: event.eventType,
		payloadJson: JSON.stringify(event.payload),
		createdAtMs: Date.now(),
		expectedPreviousEventHash: tail?.currentEventHash ?? null,
	});
}
