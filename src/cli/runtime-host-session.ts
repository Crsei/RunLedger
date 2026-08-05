/** Host-side SessionManager/Agent composition. */

import { resolve } from "node:path";
import type { ProjectSettings } from "../storage/settings-manager.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { replaySession } from "../storage/session-codec.ts";
import type { RunledgerLayout } from "../runtime/contracts/public.ts";
import type { Models } from "../models.ts";
import type { TraceRecorderFactory } from "../runtime/trace/composition.ts";
import { InteractiveSessionController } from "../runtime/interactive-session-controller.ts";
import { createStdlibTools } from "../runtime/tools/index.ts";
import { createPlanMemoryTools } from "../runtime/tools/plan-memory-tools.ts";
import type { HostSessionOpenRequest, HostSessionRuntime } from "./runtime-host-service.ts";
import type { ProductionManagedProcessPort } from "./runtime-host-process.ts";
import type { ProductionHostSecurity } from "./runtime-host-security.ts";
import type { ExtensionReloadResult } from "../extensions/host-manager.ts";
import type { ToolResultOverflowStore } from "../runtime/types.ts";
import type { ContextAssemblySink } from "../runtime/types.ts";
import type { ModelRequestRouter } from "../runtime/interactive-session-controller.ts";
import type { ToolRegistry } from "../runtime/tool-registry.ts";
import type { HostMcpRuntime } from "./runtime-host-mcp.ts";
import type { McpServerConfig } from "../extensions/mcp/connection-manager.ts";
import type { PlanModeState } from "../runtime/modes/plan/types.ts";
import type { AdapterIdentityRef } from "../runtime/protocol/adapter.ts";
import type { IdentityContext } from "../runtime/identity/types.ts";
import type { RuntimeEventWriter } from "../storage/host/runtime-event-store.ts";
import { createExtensionInvocationEvent } from "../extensions/integration/runtime-events.ts";
import { parseRuntimeId } from "../runtime/protocol/ids.ts";
import { HostGovernedToolAuthorizationPolicy } from "../security/integration/runtime-tool-authorization.ts";
import { assembleAgentModelContext } from "../runtime/context/model-request-adapter.ts";
import type { RuntimeContextSource } from "../runtime/context/runtime-adapter.ts";
import { ExtensionTurnLifecycle, type ExtensionTurnLifecycleManager } from "../extensions/turn-lifecycle.ts";
import { HostHookRuntime } from "../extensions/hooks/runtime.ts";
import { RuntimeHookAdapter } from "../extensions/integration/runtime-hook-adapter.ts";
import { runHookPipeline } from "../extensions/hooks/pipeline.ts";
import { createHostManagedHookRunner, type ManagedHookProcess } from "../extensions/hooks/host-runner.ts";
import { createHostHookResourceInvocationPort } from "./runtime-host-hooks.ts";
import {
	validateWorkspaceBindingObservation,
	type PersistedWorkspaceBinding,
	type WorkspaceBindingResult,
	JsonWorkspaceBindingStore,
} from "../worktree/persisted-binding.ts";

export interface ProductionHostSessionFactoryOptions {
	readonly layout: RunledgerLayout;
	readonly defaultCwd: string;
	readonly systemPrompt: string;
	readonly models: Models;
	readonly settings: ProjectSettings;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly processPort?: ProductionManagedProcessPort;
	readonly toolResultOverflowStore?: ToolResultOverflowStore;
	readonly security?: ProductionHostSecurity;
	/** Rebuilds Security against the session's current canonical workspace binding. */
	readonly createSecurity?: (input: {
		readonly sessionId: string;
		readonly cwd: string;
		readonly workspaceBinding?: PersistedWorkspaceBinding;
	}) => Promise<ProductionHostSecurity>;
	/** Resident Host-owned extension snapshot fence for this session. */
	readonly extensionManager?: ExtensionTurnLifecycleManager;
	/** 渐进披露 Skill loader（trust + digest 复核），注入 stdlib Skill 工具。 */
	readonly skillLoader?: import("../runtime/tools/skill.ts").SkillLoader;
	/** Host-owned 领域上下文碎片（Plan Mode / approved memory），叠加进唯一 model-request 投影。 */
	readonly contextSourceProvider?: (sessionId: string) => Promise<readonly RuntimeContextSource[]>;
	/** Host 内部 domain client（plan.write / memory.* agent 工具使用）。 */
	readonly domainClient?: import("../runtime/tools/plan-memory-tools.ts").HostDomainToolClient;
	/** Canonical event sink callback for a reload applied at Agent idle. */
	readonly onExtensionIdleReload?: (sessionId: string, result: ExtensionReloadResult) => Promise<void>;
	/** Binding restored once by the resident Host composition root. */
	readonly workspaceBinding?: PersistedWorkspaceBinding;
	/** Optional canonical binding; when present every cold/open session must match it. */
  readonly workspaceBindingStore?: JsonWorkspaceBindingStore;
  /** Canonical Host event sink for model context receipts. */
	readonly contextAssemblySink?: ContextAssemblySink;
	/** Host-owned route gate created after the canonical session identity is known. */
	readonly createModelRequestRouter?: (sessionId: string) => ModelRequestRouter;
	/** Host-owned Plan Mode state read used only for pre-execution denial. */
	readonly planStateProvider?: (sessionId: string) => PlanModeState | undefined;
	/** Host composition creates the MCP adapter against this session's process facade. */
	readonly createMcpRuntime?: (input: {
		readonly sessionId: string;
		readonly sessionGeneration: number;
		readonly cwd: string;
		readonly toolRegistry: ToolRegistry;
		readonly security: ProductionHostSecurity;
	}) => Promise<HostMcpRuntime>;
	/** Canonical config is loaded by the resident Host, never by the client. */
	readonly mcpConfigs?: readonly McpServerConfig[];
	/** Host-issued extension identity used for resource authorization. */
	readonly extensionIdentity?: IdentityContext;
	/** Host-owned adapter identity for hook invocations. */
	readonly extensionAdapter?: AdapterIdentityRef;
	/** The resident Host's sole canonical Runtime event writer. */
	readonly runtimeEventWriter?: RuntimeEventWriter;
}

export interface ProductionHostHookRuntimeOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly managedProcess: ManagedHookProcess;
	readonly extensionManager: ExtensionTurnLifecycleManager;
	readonly security: Pick<ProductionHostSecurity, "authorizeResource">;
	readonly identity: IdentityContext;
	readonly adapter: AdapterIdentityRef;
	readonly runtimeEventWriter?: RuntimeEventWriter;
}

/** Compose hooks only from resident Host ports; no client-local effect owner is created. */
export function createProductionHostHookRuntime(options: ProductionHostHookRuntimeOptions): HostHookRuntime {
	const adapter = new RuntimeHookAdapter({
		pipeline: runHookPipeline,
		runner: createHostManagedHookRunner({ managedProcess: options.managedProcess, defaultCwd: options.cwd }),
		resources: {
			invocation: createHostHookResourceInvocationPort({
				adapter: options.adapter,
				sessionId: options.sessionId,
				principalId: options.identity.principalId,
				cwd: options.cwd,
				authorize: options.security.authorizeResource,
			}),
		},
		adapter: options.adapter,
	});
	return new HostHookRuntime({
		hooks: () => options.extensionManager.currentHooks?.() ?? [],
		adapter,
		identity: options.identity,
		source: "host",
		audit: options.runtimeEventWriter === undefined ? undefined : async ({ audit, auditDigest }) => {
			const sessionId = parseRuntimeId("session", options.sessionId);
			if (sessionId === undefined) throw new Error("hook audit session identity is invalid");
			await options.runtimeEventWriter!.append(createExtensionInvocationEvent({
				authorityId: options.identity.authorityId,
				tenantId: options.identity.tenantId,
				principalId: options.identity.principalId,
				sessionId,
				audit,
				auditDigest,
			}));
		},
	});
}

export function validateHostWorkspaceBinding(input: {
	readonly binding: PersistedWorkspaceBinding;
	readonly cwd: string;
}): WorkspaceBindingResult<PersistedWorkspaceBinding> {
	const cwd = resolve(input.cwd);
	return validateWorkspaceBindingObservation(input.binding, {
		workspaceId: input.binding.binding.workspaceId,
		repositoryId: input.binding.binding.repositoryId,
		worktreeId: input.binding.worktreeId,
		sourceSubdir: input.binding.sourceSubdir,
		worktreePath: input.binding.worktreePath,
		effectiveCwd: cwd,
		baseCommit: input.binding.baseCommit,
		...(input.binding.headCommit === undefined ? {} : { headCommit: input.binding.headCommit }),
	});
}

export function resolveProductionSessionWorkspace(input: {
	readonly requestedCwd?: string;
	readonly defaultCwd: string;
	readonly binding?: PersistedWorkspaceBinding;
}): { readonly cwd: string; readonly binding?: PersistedWorkspaceBinding } {
	if (input.binding === undefined) return { cwd: resolve(input.requestedCwd ?? input.defaultCwd) };
	const cwd = resolve(input.binding.effectiveCwd);
	const validation = validateHostWorkspaceBinding({ binding: input.binding, cwd });
	if (!validation.ok) throw new Error(`${validation.error.code}: ${validation.error.message}`);
	return { cwd, binding: validation.value };
}

export function createProductionHostSessionFactory(options: ProductionHostSessionFactoryOptions): (input: HostSessionOpenRequest) => Promise<HostSessionRuntime> {
	return async (input) => {
		const sessionGeneration = input.sessionGeneration ?? 1;
		if (!Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1) throw new Error("Host session generation is invalid");
		const storedBinding = options.workspaceBinding ?? await options.workspaceBindingStore?.read();
		const workspace = resolveProductionSessionWorkspace({
			...(input.cwd === undefined ? {} : { requestedCwd: input.cwd }),
			defaultCwd: options.defaultCwd,
			...(storedBinding === undefined ? {} : { binding: storedBinding }),
		});
		const cwd = workspace.cwd;
		const manager = await selectSessionManager(options.layout, cwd, input);
		let mcp: HostMcpRuntime | undefined;
		let removeSessionSecurity: (() => void) | undefined;
		try {
			await manager.acquireLock();
			const replay = await replaySession(manager.ledger());
			const security = options.createSecurity === undefined
				? options.security
				: await options.createSecurity({
					sessionId: manager.sessionId(),
					cwd,
					...(workspace.binding === undefined ? {} : { workspaceBinding: workspace.binding }),
				});
			if (security !== undefined) removeSessionSecurity = options.processPort?.registerSessionSecurity(manager.sessionId(), security);
			const managedProcess = options.processPort?.toolClient(manager.sessionId(), sessionGeneration, "host-agent");
			const executionEnv = security?.createExecutionEnv({
				sessionId: manager.sessionId(),
				principalId: "principal_host-agent",
				cwd,
			});
			const tools = createStdlibTools(cwd, {
				requireExecutionEnv: true,
				...(managedProcess === undefined ? {} : { managedProcess }),
				...(executionEnv === undefined ? {} : { executionEnv }),
				...(options.skillLoader === undefined ? {} : { skillLoader: options.skillLoader }),
			});
			if (options.domainClient !== undefined) {
				// 绑定 session 的 domain client：agent 工具的 plan.write / memory.*
				// 都经 Host domain 执行，带 Host-owned principal 与 durable receipt。
				const sessionId = manager.sessionId();
				const bound: import("../runtime/tools/plan-memory-tools.ts").HostDomainToolClient = {
					query: (operation, body = {}) => options.domainClient!.query(operation, { sessionId, ...body }),
					command: (operation, body = {}) => options.domainClient!.command(operation, { sessionId, ...body }),
				};
				for (const tool of createPlanMemoryTools(bound)) {
					tools.register(tool, { namespace: "stdlib" });
				}
			}
			const authorizationPolicy = options.planStateProvider === undefined
				? security?.toolAuthorizationPolicy
				: new HostGovernedToolAuthorizationPolicy({
					basePolicy: security?.toolAuthorizationPolicy,
					planState: () => options.planStateProvider?.(manager.sessionId()),
				});
			if (options.createMcpRuntime !== undefined) {
				if (security === undefined) throw new Error("Host MCP requires session Security");
				mcp = await options.createMcpRuntime({ sessionId: manager.sessionId(), sessionGeneration, cwd, toolRegistry: tools, security });
				const started = await mcp.start(options.mcpConfigs ?? []);
				if (!started.ok) throw new Error(`required MCP server failed: ${started.requiredFailures.map((failure) => failure.serverId).join(",")}`);
			}
			let extensionLifecycle: ExtensionTurnLifecycle | undefined;
			let extensionHookRuntime: HostHookRuntime | undefined;
			if (options.extensionManager !== undefined) {
				if (managedProcess === undefined || security === undefined || options.extensionIdentity === undefined || options.extensionAdapter === undefined) {
					throw new Error("Host extension hooks require the resident managed process, Security Gateway, identity, and adapter");
				}
				extensionHookRuntime = createProductionHostHookRuntime({
					sessionId: manager.sessionId(),
					cwd,
					managedProcess,
					extensionManager: options.extensionManager,
					security,
					identity: options.extensionIdentity,
					adapter: options.extensionAdapter,
				});
				extensionLifecycle = new ExtensionTurnLifecycle({
					manager: options.extensionManager,
					sessionId: manager.sessionId(),
					hookRuntime: extensionHookRuntime,
					onIdleReload: (result) => options.onExtensionIdleReload?.(manager.sessionId(), result),
				});
			}
			const controller = await InteractiveSessionController.create({
				cwd,
				layout: options.layout,
				systemPrompt: options.systemPrompt,
				models: options.models,
				settings: options.settings,
				replay,
				ledger: manager.ledger(),
				tools: tools.toContext(),
				overrides: {
					provider: input.provider,
					model: input.model,
					thinkingLevel: input.thinkingLevel,
				},
				traceRecorderFactory: options.traceRecorderFactory,
				executionEnv,
				toolResultOverflowStore: options.toolResultOverflowStore,
				authorizationPolicy,
                ...(options.createModelRequestRouter === undefined ? {} : { modelRequestRouter: options.createModelRequestRouter(manager.sessionId()) }),
                modelContextAssembler: options.contextSourceProvider === undefined
                  ? assembleAgentModelContext
                  : async (input) => assembleAgentModelContext({
                      ...input,
                      sources: await options.contextSourceProvider!(manager.sessionId()),
                    }),
                ...(options.contextAssemblySink === undefined ? {} : { contextAssemblySink: options.contextAssemblySink }),
				...(extensionHookRuntime === undefined ? {} : {
					extensionHookRuntime,
					extensionHookSnapshotId: () => extensionLifecycle?.snapshotId(),
					extensionTurnAdmission: extensionLifecycle === undefined ? undefined : () => extensionLifecycle.admitTurn(),
					extensionTurnAbort: extensionLifecycle === undefined ? undefined : () => extensionLifecycle.cancelTurn(),
				}),
              });
			const removeExtensionLifecycle = extensionLifecycle === undefined ? undefined : controller.subscribe((event) => extensionLifecycle.handle(event));
			const removeCompletion = options.processPort?.attachCompletionAgent(
				manager.sessionId(),
				controller,
				(listener) => controller.subscribe((event) => {
					if (event.type === "agent_end") listener();
				}),
			);
			return {
				controller,
				...(mcp === undefined ? {} : { mcp }),
				close: async () => {
					removeExtensionLifecycle?.();
					removeCompletion?.();
					await mcp?.close().catch(() => undefined);
					removeSessionSecurity?.();
					await manager.closeAll();
				},
			};
		} catch (error) {
			await mcp?.close().catch(() => undefined);
			removeSessionSecurity?.();
			await manager.closeAll().catch(() => undefined);
			throw error;
		}
	};
}

async function selectSessionManager(
	layout: RunledgerLayout,
	cwd: string,
	input: HostSessionOpenRequest,
): Promise<SessionManager> {
	switch (input.mode) {
		case "create":
			return SessionManager.create({ layout, cwd, ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }), metadata: { cwd } });
		case "open": {
			if (input.sessionPath) return SessionManager.open(layout, input.sessionPath);
			if (!input.sessionId) throw new Error("session id required");
			const session = (await SessionManager.listAll(layout)).find((candidate) => candidate.id === input.sessionId);
			if (!session) throw new Error("session id not found");
			return SessionManager.open(layout, session.filePath);
		}
		case "continue_recent":
			return SessionManager.continueRecent(layout, cwd);
		case "resume": {
			const sessions = await SessionManager.list(layout, cwd);
			if (sessions.length === 0) return SessionManager.create({ layout, cwd, metadata: { cwd } });
			return SessionManager.open(layout, sessions[0]!.filePath);
		}
		case "fork":
			if (!input.sessionPath) throw new Error("fork source is required");
			return SessionManager.forkFrom(layout, input.sessionPath, cwd);
	}
}
