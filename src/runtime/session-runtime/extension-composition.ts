import { join, resolve } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import type { ExtensionPublicSnapshot, ExtensionReloadResult } from "../../extensions/manager.ts";
import { ExtensionManager } from "../../extensions/manager.ts";
import { PluginManager } from "../../extensions/plugins/manager.ts";
import { ExtensionStateStore } from "../../extensions/state-store.ts";
import { createSkillRegistry } from "../../extensions/skills/registry.ts";
import { resolveSkillsPolicy } from "../../extensions/skills/policy.ts";
import { loadProjectSettings, saveProjectSettings } from "../../storage/settings-manager.ts";
import { NodeExtensionStorage } from "../../storage/extensions/extension-storage.ts";
import { NodeExtensionDistributionStorage } from "../../storage/extensions/distribution-storage.ts";
import { ExtensionDistributionRegistry, resolveExtensionDistributionPaths } from "../../extensions/plugins/marketplace/registry.ts";
import { ExtensionInstaller, type ExtensionSourceMaterializer } from "../../extensions/plugins/installer.ts";
import { MarketplaceFetcher } from "../../extensions/plugins/marketplace/fetcher.ts";
import { resolveExtensionCachePaths } from "../../extensions/plugins/marketplace/cache.ts";
import { createManagedGitMaterializer } from "../../extensions/plugins/git-materializer.ts";
import { distributionPluginRoots } from "../../extensions/plugins/discovery-bridge.ts";
import { createExtensionReloadWatcher, type ExtensionReloadOutcome, type ExtensionWatchPort } from "../../extensions/plugins/reload-watcher.ts";
import { NodeExtensionWatchPort } from "../../storage/extensions/watch-adapter.ts";
import { loadInstalledRunledgerManifests, selectDistributionHostCandidates } from "../../extensions/plugins/host-activation.ts";
import { applySettingDefaults, resolvePluginSettings, validatePluginSettings } from "../../extensions/plugins/settings-schema.ts";
import { applyPluginFeatureSelection, describePluginFeatures } from "../../extensions/plugins/features.ts";
import type { ExtensionSettingDescriptor } from "../../contracts/extensions/manifest.ts";
import type { DistributionHostCandidate, DistributionHostSelection } from "../../extensions/plugins/host-activation.ts";
import { admitExtensionTools, type ExtensionToolInvoker } from "../../extensions/tools/admission.ts";
import type { ExtensionRegistrySnapshot } from "../../contracts/extensions/registry.ts";
import { ExtensionHostSupervisor } from "../../extensions/host/supervisor.ts";
import { EXTENSION_HOST_API_VERSION } from "../../extensions/host/runtime.ts";
import { createExtensionActionHandler, type ExtensionActionActorPort } from "../../extensions/actions/handler.ts";
import { ExtensionEventBridge } from "../../extensions/events/bridge.ts";
import { admitExtensionTools as admitExtensionToolsForHost, type ExtensionToolInvoker as ExtensionToolInvokerForHost } from "../../extensions/tools/admission.ts";
import { fileURLToPath } from "node:url";
import { MarketplaceManager } from "../../extensions/plugins/marketplace/manager.ts";
import { runExtensionDoctor } from "../../extensions/plugins/doctor.ts";
import { TrustStore } from "../../extensions/trust/trust-store.ts";
import { sourceKey } from "../../extensions/paths.ts";
import type { ExtensionSource, ExtensionSourceRoot } from "../../extensions/types.ts";
import type { McpManagerResult, McpServerSnapshot } from "../../extensions/mcp/connection-manager.ts";
import { McpConnectionManager } from "../../extensions/mcp/connection-manager.ts";
import { createMcpExecutionEnvFetch, createSdkMcpClientFactory } from "../../extensions/mcp/sdk-factory.ts";
import { loadCanonicalMcpConfigs, parseMcpConfigDocument } from "../../extensions/mcp/config.ts";
import type { McpServerConfig } from "../../extensions/mcp/types.ts";
import { SkillCatalog } from "../../extensions/skills/catalog.ts";
import { SkillToolResolver } from "../../extensions/skills/skill-tool.ts";
import { skillCatalogPromptFragment } from "../../extensions/skills/renderer.ts";
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
import type { PrincipalId } from "../protocol/ids.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import type { SessionResourceDomainPort } from "./session-runtime.ts";
import type { RuntimeContextSource } from "../context/runtime-adapter.ts";
import type { ExtensionEventOutcome } from "../../extensions/host/client.ts";

export interface SessionExtensionManagerPort {
	load(): Promise<ExtensionReloadResult>;
	reload(): Promise<ExtensionReloadResult>;
	setEnabled(pluginId: string, enabled: boolean): Promise<ExtensionReloadResult>;
	trust(pluginId: string): Promise<ExtensionReloadResult>;
	untrust(pluginId: string): Promise<ExtensionReloadResult>;
	trustSkill(skillId: string): Promise<ExtensionReloadResult>;
	untrustSkill(skillId: string): Promise<ExtensionReloadResult>;
	setSkillProviderEnabled(providerId: string, enabled: boolean, scope: "user" | "workspace"): Promise<ExtensionReloadResult>;
	publicSnapshot(): ExtensionPublicSnapshot | undefined;
}

export interface SessionMcpRuntimePort {
	start(): Promise<{
		readonly ok: boolean;
		readonly snapshots: readonly McpServerSnapshot[];
		readonly requiredFailures: readonly { readonly serverId: string; readonly code: string; readonly message: string }[];
	}>;
	snapshots(): readonly McpServerSnapshot[];
	restart(serverId: string): Promise<McpManagerResult<McpServerSnapshot>>;
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
	readonly contextSources?: (modelContextChars: number) => readonly RuntimeContextSource[];
	readonly closeHooks: () => Promise<void>;
	readonly closePlugins: () => Promise<void>;
	readonly cleanup: () => Promise<void>;
	readonly audit?: (event: SessionExtensionAuditEvent) => Promise<void>;
	/** mutation 经 recovery barrier 记账;缺省时 mutation 直通(测试接缝)。 */
	readonly attemptPort?: () => AttemptPort | undefined;
	/** P5 分发面;缺省时所有分发操作返回 operation_unavailable。 */
	readonly distribution?: { readonly read: SessionDistributionReadPort; readonly mutate: SessionDistributionMutationPort };
	/** `extension.host.inspect` 的后端;缺省时返回 disabled。 */
	readonly hostInspect?: SessionHostInspect;
	/** 扩展动作的真实命令面;缺省时动作返回 session_command_unavailable。 */
	readonly actorHost?: SessionExtensionActionHostHolder;
	/** 可选文件 watcher;缺省时不观察任何 root。 */
	readonly reloadWatch?: { start(): void; stop(): void };
	/** P5/P1 可执行扩展 host;缺省(或 Profile 关闭)时扩展工具与事件桥不可用。 */
	readonly hostExtensions?: SessionExtensionHostPort;
}

/** `extension.host.inspect` 的后端形状；composition 把它接进 resource domain。 */
export type SessionHostInspect = () => Promise<Record<string, unknown>>;

/**
 * 扩展 host 的生命周期与查询面（P1–P4 的装配缝）。
 *
 * `start` **不得抛错**：host 失败只让该 generation failed，session 必须继续
 * （D2）。因此失败被表达为 `{ok:false}`，由 composition 记审计并保持空工具集。
 */
export interface SessionExtensionHostPort {
	start(): Promise<{ readonly ok: true; readonly tools: readonly AgentTool[] } | { readonly ok: false; readonly code: string; readonly message: string }>;
	/** 已准入的扩展工具；start 之前为空。 */
	tools(): readonly AgentTool[];
	shutdown(reason: "paused" | "detached" | "error" | "fenced"): Promise<void>;
	/** host 与候选状态的 bounded 只读投影；未装配 host 时也返回选择结果。 */
	inspect(): Promise<Record<string, unknown>>;
	/** 事件桥派发；未装配时返回 host_unavailable，交由调用方 fail-closed 处理。 */
	dispatchEvent(input: {
		readonly name: string;
		readonly cancelable: boolean;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly signal?: AbortSignal;
	}): Promise<ExtensionEventOutcome>;
}

export interface SessionExtensionComposition {
	readonly tools: readonly AgentTool[];
	readonly resources: SessionResourceDomainPort;
	readonly contextSources: (modelContextChars: number) => readonly RuntimeContextSource[];
	readonly hookRuntime?: ExtensionHookRuntime;
	readonly turnLifecycle?: ExtensionTurnLifecycle;
	/** host 在 `start` 后才公布注册表；调用方在 start 之后用 `addTools` 追加。 */
	extensionTools(): readonly AgentTool[];
	/** `extension.host.inspect` 的后端；未装配 host 时返回 disabled 而不是空对象。 */
	hostInspect(): Promise<Record<string, unknown>>;
	dispatchExtensionEvent(input: {
		readonly name: string;
		readonly cancelable: boolean;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly signal?: AbortSignal;
	}): Promise<ExtensionEventOutcome>;
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
	/** composition root 解析的兼容 Skill locator；providers 不自行读取 OS/cwd。 */
	readonly skillCompatibility?: Readonly<{
		readonly osUserHome: string;
		readonly projectBoundary: string;
	}>;
	/**
	 * 扩展动作的真实命令面。controller 在 extension composition **之后**构建，
	 * 因此这里传一个晚绑定持有者；未注入时动作返回 `session_command_unavailable`。
	 */
	readonly actorHost?: SessionExtensionActionHostHolder;
}

/**
 * 可执行扩展 host 的运行时缝：把「选包 → 起进程 → 拿注册表」与「准入 → 工具」
 * 分开,以便在不起真实进程的情况下测试准入与失败语义。
 */
export interface SessionExtensionHostRuntime {
	readonly start: (candidate: DistributionHostCandidate) => Promise<
		| { readonly ok: true; readonly snapshot: ExtensionRegistrySnapshot }
		| { readonly ok: false; readonly code: string; readonly message: string }
	>;
	readonly shutdown: () => Promise<void>;
	readonly dispatch: (input: {
		readonly name: string;
		readonly cancelable: boolean;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly signal?: AbortSignal;
	}) => Promise<ExtensionEventOutcome>;
	/** 已订阅某个投影事件的扩展 id;用于跳过无人订阅的跨进程往返。 */
	readonly subscribersFor: (name: string) => readonly string[];
	/** host 生命周期与候选 gate 的只读投影。 */
	readonly inspect: () => Promise<Record<string, unknown>>;
}

export interface SessionExtensionHostPortOptions {
	readonly selection: () => Promise<DistributionHostSelection>;
	readonly runtime: SessionExtensionHostRuntime;
	/** stdlib/base/MCP/Skill 等既有工具名;扩展不得占用。 */
	readonly reservedNames: () => readonly string[];
	readonly invoke: ExtensionToolInvoker;
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
}

/**
 * 装配 host 端口。每个 session 最多起 1 个 host（D1）：多个 ready 候选时按
 * `project` 优先、再按 packageId 排序确定性取第一个,其余**记录为跳过原因**,
 * 不静默忽略。host 启动失败返回 `{ok:false}`,绝不让 session 启动失败（D2）。
 */
export function createSessionExtensionHostPort(options: SessionExtensionHostPortOptions): SessionExtensionHostPort {
	let active: DistributionHostCandidate | undefined;
	let admitted: readonly AgentTool[] = [];
	return {
		start: async () => {
			const selection = await options.selection();
			if (selection.ready.length === 0) {
				// 没有可执行扩展是正常状态：不记失败,也不起进程。
				return { ok: true, tools: [] };
			}
			const ordered = [...selection.ready].sort((left, right) => {
				const leftRank = left.candidate.scope === "project" ? 0 : 1;
				const rightRank = right.candidate.scope === "project" ? 0 : 1;
				return leftRank - rightRank || left.candidate.packageId.localeCompare(right.candidate.packageId);
			});
			const chosen = ordered[0];
			if (chosen === undefined) return { ok: true, tools: [] };
			const skipped = ordered.slice(1).map((gate) => gate.candidate.packageId);
			if (skipped.length > 0) await options.audit?.({ eventType: "extension.host.candidates_skipped", payload: { skipped, reason: "one host per session" } });

			const started = await options.runtime.start(chosen.candidate);
			if (!started.ok) {
				active = undefined;
				admitted = [];
				return { ok: false, code: started.code, message: started.message };
			}
			const result = admitExtensionTools({
				packages: [{
					packageId: chosen.candidate.packageId,
					digest: chosen.candidate.digest,
					generation: started.snapshot.generation,
					declaredTools: chosen.candidate.declaredTools,
					tools: started.snapshot.tools,
				}],
				reservedNames: options.reservedNames(),
				invoke: options.invoke,
			});
			active = chosen.candidate;
			admitted = Object.freeze(result.admitted.map((entry) => entry.tool));
			if (result.rejected.length > 0) {
				await options.audit?.({
					eventType: "extension.host.tools_rejected",
					payload: { code: result.rejected[0]?.code ?? "unknown", count: result.rejected.length, name: result.rejected[0]?.name ?? "unknown" },
				});
			}
			return { ok: true, tools: admitted };
		},
		tools: () => admitted,
		inspect: () => options.runtime.inspect(),
		shutdown: async () => {
			if (active === undefined) return;
			active = undefined;
			admitted = [];
			await options.runtime.shutdown().catch(() => undefined);
		},
		dispatchEvent: (input) => options.runtime.dispatch(input),
	};
}

/**
 * 扩展动作需要的**最小** controller 面。只列真正被动作使用的三个方法，避免把
 * controller 整体类型拉进 extensions 组合层；由 `domain.ts` 在 controller 构建
 * 之后注入，因此是晚绑定的（construct 期拿不到）。
 *
 * `getAvailableModels` 只用于把 `setModel` 的 (providerId, modelId) 解析成
 * controller 认识的模型实例；找不到就返回失败，不做模糊匹配。
 */
export interface SessionExtensionActionHost {
	readonly prompt: (text: string, behavior: "steer" | "followUp", origin: "user" | "runtime") => Promise<void>;
	readonly setThinkingLevel: (level: string) => Promise<string>;
	readonly getAvailableModels: (provider?: string) => Promise<readonly { readonly id: string; readonly provider: string }[]>;
	readonly selectModel: (model: unknown) => Promise<void>;
}

/** 晚绑定持有者：domain.ts 在 controller 就绪后 `.current = () => controller`。 */
export interface SessionExtensionActionHostHolder {
	current?: () => SessionExtensionActionHost | undefined;
}

/**
 * 可选文件 watcher 的生产接线（默认关闭）。
 *
 * `requestReload` 必须**等** `manager.reload()` 的结果：它在 turn 进行中返回
 * `pending`、在 idle 边界才真正交换，因此 outcome 由既有 snapshot 决定，watcher
 * 只是如实上报（D11）。猜会让审计把"没交换"报成 ready。
 */
export function createSessionReloadWatch(input: {
	readonly manager: SessionExtensionManagerPort;
	readonly roots: () => readonly string[];
	readonly enabled: () => boolean;
	readonly watch?: ExtensionWatchPort;
	readonly debounceMs?: number;
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
}) {
	return createExtensionReloadWatcher({
		watch: input.watch ?? new NodeExtensionWatchPort({
			onError: (error) => { void input.audit?.({ eventType: "extension.watch.unavailable", payload: { message: error.message } }); },
		}),
		roots: input.roots,
		requestReload: async (): Promise<ExtensionReloadOutcome> => {
			const reloaded = await input.manager.reload();
			return reloaded.status === "ready" ? "ready" : "pending";
		},
		enabled: input.enabled,
		...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
		audit: input.audit,
	});
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
	Object.freeze({ operation: "skill.provider.list", capability: "session.skills", access: "read" }),
	Object.freeze({ operation: "hook.list", capability: "session.hooks", access: "read" }),
	Object.freeze({ operation: "mcp.list", capability: "session.mcp", access: "read" }),
	Object.freeze({ operation: "mcp.doctor", capability: "session.mcp", access: "read" }),
	Object.freeze({ operation: "extension.reload", capability: "session.extensions", access: "mutate" }),
	Object.freeze({ operation: "plugin.enable", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.disable", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.trust", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.untrust", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "skill.trust", capability: "session.skills", access: "mutate" }),
	Object.freeze({ operation: "skill.untrust", capability: "session.skills", access: "mutate" }),
	Object.freeze({ operation: "skill.provider.enable", capability: "session.skills", access: "mutate" }),
	Object.freeze({ operation: "skill.provider.disable", capability: "session.skills", access: "mutate" }),
	Object.freeze({ operation: "mcp.restart", capability: "session.mcp", access: "mutate" }),
	// P5 分发面（§8 operation manifest 增量）。安装/启用/信任三者严格分离：
	// 这些 mutate 只落盘与记账，绝不顺带授予执行。
	Object.freeze({ operation: "extension.host.inspect", capability: "session.extensions", access: "read" }),
	Object.freeze({ operation: "plugin.distribution.list", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.doctor", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.config.read", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.features.read", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "marketplace.discover", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.install", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.uninstall", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.link", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.config.write", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.features.write", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.upgrade", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "marketplace.add", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "marketplace.remove", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "marketplace.update", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "marketplace.upgrade", capability: "session.plugins", access: "mutate" }),
]);

/** 分发面读取操作的返回形状（bounded，不含 native path 之外的运行时私有上下文）。 */
export interface SessionDistributionReadPort {
	list(): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	doctor(): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	/** 读取所有已安装 package 的已声明 settings 与当前值；不需要 payload。 */
	marketplaces(): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	/** 每个已安装包的声明式 settings schema 与 user 层已生效值。 */
	configRead(): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	/** 每个已安装包的 feature 声明与账本里的选择/生效集合。 */
	featuresRead(): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
}

/** 分发面变更操作。全部经 attempt barrier 记账后才返回。 */
export interface SessionDistributionMutationPort {
	install(input: { readonly spec: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	uninstall(input: { readonly packageId: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	link(input: { readonly packageId: string; readonly name: string; readonly localPath: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	upgrade(input: { readonly spec: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	addMarketplace(input: { readonly name: string; readonly sourceType: string; readonly sourceUri: string }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	removeMarketplace(input: { readonly name: string }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	updateMarketplace(input: { readonly name: string }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	upgradeFromMarketplace(input: { readonly marketplace: string; readonly scope: "user" | "workspace" }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	configWrite(input: { readonly packageId: string; readonly values: Readonly<Record<string, unknown>> }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
	featuresWrite(input: { readonly packageId: string; readonly enabledFeatures: readonly string[] | null }): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string; readonly message?: string }>;
}

/**
 * S5:协调一个 owned SessionRuntime 私有的扩展快照、MCP 连接与清理顺序。
 * 具体 filesystem/network/process adapter 由 production factory 注入，本层不
 * 持有 raw handle，也不共享跨 Session registry。
 */
export function createSessionExtensionComposition(options: SessionExtensionCompositionOptions): SessionExtensionComposition {
	let shutdownPromise: Promise<void> | undefined;
	let hostTools: readonly AgentTool[] = [];
	const tools: AgentTool[] = [
		...(options.skillLoader === undefined ? [] : [createSkillTool({ loader: options.skillLoader })]),
		...options.mcp.tools(),
	];
	const resources: SessionResourceDomainPort = {
		operationManifest: OPERATION_MANIFEST,
		query: async (operation) => queryResources(options, operation),
		mutate: (operation, payload, context) => mutateResources(options, operation, payload, context),
	};
	return {
		tools,
		extensionTools: () => hostTools,
		hostInspect: async () => {
			const host = options.hostExtensions;
			if (host === undefined) return { host: "disabled", reason: "no executable extension host is assembled for this session" };
			return host.inspect();
		},
		dispatchExtensionEvent: async (input) => {
			const host = options.hostExtensions;
			if (host === undefined) return { ok: false, code: "host_unavailable", message: "no extension host is assembled for this session" };
			return host.dispatchEvent(input);
		},
		resources,
		contextSources: options.contextSources ?? (() => []),
		start: async () => {
			const loaded = await options.manager.load();
			if (loaded.status === "failed") {
				await audit(options, "extension.snapshot.required_failed", { error: loaded.error ?? "extension snapshot load failed" });
				throw new SessionExtensionStartupError(loaded.error ?? "extension snapshot load failed");
			}
			options.reloadWatch?.start();
			await audit(options, "extension.snapshot.loaded", {
				snapshotId: options.manager.publicSnapshot()?.snapshotId ?? "unavailable",
				generation: options.manager.publicSnapshot()?.generation ?? 0,
			});
			// 可执行扩展 host：失败只记审计并保持空工具集，绝不让 session 启动失败（D2）。
			if (options.hostExtensions !== undefined) {
				const hosted = await options.hostExtensions.start();
				if (hosted.ok) {
					hostTools = hosted.tools;
					await audit(options, "extension.host.tools_admitted", { count: hostTools.length, names: hostTools.map((tool) => tool.name) });
				} else {
					hostTools = [];
					await audit(options, "extension.host.start_failed", { code: hosted.code, message: hosted.message });
				}
			}
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
				options.reloadWatch?.stop();
				await options.hostExtensions?.shutdown(reason).catch(() => undefined);
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

async function queryResources(options: SessionExtensionCompositionOptions, operation: string): Promise<SessionDomainResult> {
	const snapshot = options.manager.publicSnapshot();
	const mcp = options.mcp.snapshots();
	if (operation === "extension.inspect") {
		return ok(operation, options.generation, { snapshot: snapshot ?? emptySnapshot(options.generation), mcp });
	}
	if (operation === "skill.provider.list") {
		return ok(operation, options.generation, { items: snapshot?.skillProviders ?? [] });
	}
	if (operation === "mcp.list" || operation === "mcp.doctor") {
		return ok(operation, options.generation, { items: mcp });
	}
	if (operation === "extension.host.inspect") {
		return ok(operation, options.generation, options.hostInspect === undefined
			? { host: "disabled", reason: "this session has no extension host composition" }
			: await options.hostInspect());
	}
	if (DISTRIBUTION_READ_OPERATIONS.has(operation)) {
		const distribution = options.distribution?.read;
		if (distribution === undefined) return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
		const read = operation === "plugin.distribution.list"
			? await distribution.list()
			: operation === "plugin.doctor"
				? await distribution.doctor()
				: operation === "plugin.config.read"
					? await distribution.configRead()
					: operation === "plugin.features.read"
						? await distribution.featuresRead()
						: await distribution.marketplaces();
		return read.ok ? ok(operation, options.generation, read.value ?? {}) : { ok: false, status: "failed", code: read.code ?? "distribution_read_failed", operation };
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

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * payload 里的 feature 选择：`null` = 声明默认值，数组 = 精确集合（`[]` = 全关）。
 * 其它类型是形状错误，不能当作"全关"或"默认"处理。
 */
function parseFeatureSelectionPayload(value: unknown): readonly string[] | null | undefined {
	if (value === null) return null;
	if (!Array.isArray(value)) return undefined;
	if (value.some((item) => typeof item !== "string" || item.length === 0)) return undefined;
	return [...value] as readonly string[];
}

/** P5 分发 read 操作名；与 OPERATION_MANIFEST 中的 read 项一一对应。 */
const DISTRIBUTION_READ_OPERATIONS = new Set<string>([
	"plugin.distribution.list",
	"plugin.doctor",
	"plugin.config.read",
	"plugin.features.read",
	"marketplace.discover",
]);

/** P5 分发 mutate 操作名；与 OPERATION_MANIFEST 中的 mutate 项一一对应。 */
const DISTRIBUTION_MUTATION_OPERATIONS = new Set<string>([
	"plugin.install",
	"plugin.uninstall",
	"plugin.link",
	"plugin.upgrade",
	"plugin.config.write",
	"plugin.features.write",
	"marketplace.add",
	"marketplace.remove",
	"marketplace.update",
	"marketplace.upgrade",
]);

/**
 * 分发 mutate 的 payload 校验与路由。所有分支都要求 durable command 已带
 * expected revision（由调用方保证），并且**只**落盘/记账：不启用、不信任、
 * 不起 host（D7）。
 */
async function dispatchDistributionMutation(
	port: SessionDistributionMutationPort,
	operation: string,
	payload: Record<string, unknown>,
	scope: "user" | "workspace",
	stringValue: (value: unknown) => string | undefined,
): Promise<{ readonly ok: boolean; readonly value?: Record<string, unknown>; readonly code?: string }> {
	switch (operation) {
		case "plugin.install":
		case "plugin.upgrade": {
			const spec = stringValue(payload.spec);
			if (spec === undefined) return { ok: false, code: "spec_required" };
			const applied = operation === "plugin.install"
				? await port.install({ spec, scope })
				: await port.upgrade({ spec, scope });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "install_failed" };
		}
		case "plugin.uninstall": {
			const packageId = stringValue(payload.pluginId);
			if (packageId === undefined) return { ok: false, code: "plugin_id_required" };
			const applied = await port.uninstall({ packageId, scope });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "uninstall_failed" };
		}
		case "plugin.config.write": {
			const packageId = stringValue(payload.pluginId);
			if (packageId === undefined) return { ok: false, code: "plugin_id_required" };
			const values = typeof payload.values === "object" && payload.values !== null && !Array.isArray(payload.values)
				? payload.values as Record<string, unknown>
				: undefined;
			if (values === undefined) return { ok: false, code: "values_required" };
			const applied = await port.configWrite({ packageId, values });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "config_write_failed" };
		}
		case "plugin.link": {
			const packageId = stringValue(payload.pluginId);
			const name = stringValue(payload.name);
			const localPath = stringValue(payload.localPath);
			if (packageId === undefined || name === undefined || localPath === undefined) return { ok: false, code: "link_arguments_required" };
			const applied = await port.link({ packageId, name, localPath, scope });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "link_failed" };
		}
		case "plugin.features.write": {
			const packageId = stringValue(payload.pluginId);
			if (packageId === undefined) return { ok: false, code: "plugin_id_required" };
			// `null`（声明默认值）与 `[]`（全关）是两种合法选择，必须与"缺参数"区分。
			const selection = "enabledFeatures" in payload ? parseFeatureSelectionPayload(payload.enabledFeatures) : undefined;
			if (selection === undefined) return { ok: false, code: "feature_selection_required" };
			const applied = await port.featuresWrite({ packageId, enabledFeatures: selection });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "feature_write_failed" };
		}
		case "marketplace.add": {
			const name = stringValue(payload.name);
			const sourceType = stringValue(payload.sourceType);
			const sourceUri = stringValue(payload.sourceUri);
			if (name === undefined || sourceType === undefined || sourceUri === undefined) return { ok: false, code: "marketplace_arguments_required" };
			const applied = await port.addMarketplace({ name, sourceType, sourceUri });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "marketplace_add_failed" };
		}
		case "marketplace.remove":
		case "marketplace.update": {
			const name = stringValue(payload.name);
			if (name === undefined) return { ok: false, code: "marketplace_name_required" };
			const applied = operation === "marketplace.remove"
				? await port.removeMarketplace({ name })
				: await port.updateMarketplace({ name });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "marketplace_operation_failed" };
		}
		case "marketplace.upgrade": {
			const marketplace = stringValue(payload.marketplace);
			if (marketplace === undefined) return { ok: false, code: "marketplace_name_required" };
			const applied = await port.upgradeFromMarketplace({ marketplace, scope });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "marketplace_upgrade_failed" };
		}
		default:
			return { ok: false, code: "operation_unavailable" };
	}
}

function mutationResult(
	operation: string,
	options: SessionExtensionCompositionOptions,
	result: { readonly ok: boolean; readonly value?: Record<string, unknown>; readonly nextSnapshot?: ExtensionPublicSnapshot; readonly code?: string },
): SessionDomainResult {
	if (!result.ok) return { ok: false, status: "failed", code: result.code ?? "extension_operation_failed", operation };
	return ok(operation, options.manager.publicSnapshot()?.generation ?? options.generation, result.value ?? {});
}

/**
 * S5.1:Session extension mutation 面。plugin/skill/hook 的 enable/trust 与
 * extension.reload 经 manager 持久化并 swap snapshot;mcp.restart 走
 * McpConnectionManager 既有 config 重启。全部经 recovery barrier 的
 * beginAttempt/settleAttempt(崩溃后遗留 started receipt 由 takeover assess)。
 */
async function mutateResources(
	options: SessionExtensionCompositionOptions,
	operation: string,
	payload: Record<string, unknown>,
	context: SessionDomainMutationContext,
): Promise<SessionDomainResult> {
	const attemptPort = options.attemptPort?.();
	const begun = attemptPort?.beginAttempt("external_mutation", runtimeDigest({
		operation,
		payload,
		correlationId: context.correlationId,
		effectId: context.effectId,
		expectedRevision: context.expectedRevision,
	}));
	const attemptId = begun !== undefined && "attemptId" in begun ? begun.attemptId : undefined;
	const settle = (outcome: "committed" | "rejected", details: unknown): boolean => {
		if (attemptPort === undefined || attemptId === undefined) return true;
		const settled = attemptPort.settleAttempt(attemptId, outcome, runtimeDigest({ operation, ...payload, details }));
		return settled.ok;
	};
	try {
		let result: { readonly ok: boolean; readonly value?: Record<string, unknown>; readonly nextSnapshot?: ExtensionPublicSnapshot; readonly code?: string };
		if (operation === "extension.reload") {
			const reloaded = await options.manager.reload();
			result = reloaded.status === "failed"
				? { ok: false, code: "extension_reload_failed" }
				: { ok: true, nextSnapshot: reloaded.snapshot ?? reloaded.retained ?? options.manager.publicSnapshot() };
		} else if (operation === "plugin.enable" || operation === "plugin.disable" || operation === "plugin.trust" || operation === "plugin.untrust") {
			const pluginId = stringValue(payload.pluginId);
			if (pluginId === undefined) return { ok: false, status: "failed", code: "plugin_id_required", operation };
			let applied: ExtensionReloadResult;
			switch (operation) {
				case "plugin.enable": applied = await options.manager.setEnabled(pluginId, true); break;
				case "plugin.disable": applied = await options.manager.setEnabled(pluginId, false); break;
				case "plugin.trust": applied = await options.manager.trust(pluginId); break;
				default: applied = await options.manager.untrust(pluginId); break;
			}
			result = applied.status === "failed"
				? { ok: false, code: "extension_operation_failed" }
				: { ok: true, nextSnapshot: applied.snapshot ?? applied.retained ?? options.manager.publicSnapshot() };
		} else if (operation === "skill.trust" || operation === "skill.untrust") {
			const skillId = stringValue(payload.skillId);
			if (skillId === undefined) return { ok: false, status: "failed", code: "skill_id_required", operation };
			const applied = operation === "skill.trust"
				? await options.manager.trustSkill(skillId)
				: await options.manager.untrustSkill(skillId);
			result = applied.status === "failed"
				? { ok: false, code: "extension_operation_failed" }
				: { ok: true, nextSnapshot: applied.snapshot ?? applied.retained ?? options.manager.publicSnapshot() };
		} else if (operation === "skill.provider.enable" || operation === "skill.provider.disable") {
			const providerId = stringValue(payload.providerId);
			if (providerId === undefined) return { ok: false, status: "failed", code: "provider_id_required", operation };
			const scope = payload.scope === "workspace" ? "workspace" as const : "user" as const;
			const applied = operation === "skill.provider.enable"
				? await options.manager.setSkillProviderEnabled(providerId, true, scope)
				: await options.manager.setSkillProviderEnabled(providerId, false, scope);
			result = applied.status === "failed"
				? { ok: false, code: "extension_operation_failed" }
				: { ok: true, nextSnapshot: applied.snapshot ?? applied.retained ?? options.manager.publicSnapshot() };
		} else if (operation === "mcp.restart") {
			const serverId = stringValue(payload.serverId);
			if (serverId === undefined) return { ok: false, status: "failed", code: "mcp_server_required", operation };
			const restarted = await options.mcp.restart(serverId);
			result = restarted.ok
				? { ok: true, value: { server: restarted.value } }
				: { ok: false, code: `mcp_${restarted.error.code}` };
		} else if (DISTRIBUTION_MUTATION_OPERATIONS.has(operation)) {
			const distribution = options.distribution?.mutate;
			if (distribution === undefined) return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
			const scope = payload.scope === "workspace" ? "workspace" as const : "user" as const;
			result = await dispatchDistributionMutation(distribution, operation, payload, scope, stringValue);
		} else {
			return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
		}
		if (!settle(result.ok ? "committed" : "rejected", result)) return { ok: false, status: "failed", code: "attempt_settle_failed", operation };
		return mutationResult(operation, options, result);
	} catch (error) {
		settle("rejected", error instanceof Error ? error.message : String(error));
		return { ok: false, status: "failed", code: "extension_mutation_failed", operation };
	}
}

function emptySnapshot(generation: number): ExtensionPublicSnapshot {
	return {
		snapshotId: "snapshot_unavailable",
		generation,
		createdAt: new Date(0).toISOString(),
		descriptors: [],
		diagnostics: [],
		counts: { plugins: 0, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 0, blocked: 0, disabled: 0, error: 0 },
		skillProviders: [],
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
	const principalId = createRuntimeId("principal", `local-user-extension-${runtimeDigest({ authorityId, tenantId }).digest.slice(0, 48)}`);
	const trustStore = new TrustStore(join(stateRoot, "trust.json"), storage);
	const distribution = createSessionDistribution({
		home: options.layout.home,
		stateRoot,
		storageKey,
		distributionRoot: join(stateRoot, "plugins"),
		managedProcess: options.managedProcess,
		cwd: options.cwd,
		trustStore,
		principalId,
		layout: options.layout,
	});
	// 已安装的声明式包回灌到既有 PluginManager 发现面：安装只落盘，是否生效
	// 仍由既有 enable/trust 决定（§1.2 缺口 #11）。
	const installedDistributionRoots = await distribution.declarativeRoots();
	const extensionStateStore = new ExtensionStateStore(join(stateRoot, "extensions-state.json"), storage);
	// 声明式发现根 = 既有 user/workspace 根 + 已安装分发包的当前版本目录。
	const declarativeRoots = await discoverPluginRoots(storage, [
		{ source: "user", root: join(stateRoot, "user", "plugins"), priority: 100 },
		{ source: "project", root: join(stateRoot, "workspaces", storageKey, "plugins"), priority: 200 },
	]);
	const pluginManager = new PluginManager({
		storage,
		trustStore,
		stateStore: extensionStateStore,
		scope: { authorityId, tenantId, principalId },
		roots: [...declarativeRoots, ...installedDistributionRoots],
	});
	const skillRegistry = createSkillRegistry({
		storage,
		trustStore,
		stateStore: extensionStateStore,
		scope: { authorityId, tenantId, principalId },
		pluginContributions: () => pluginManager.last()?.skillContributions ?? [],
		userSkillRoot: join(stateRoot, "user", "skills"),
		workspaceSkillRoot: join(stateRoot, "workspaces", storageKey, "skills"),
		...(options.skillCompatibility === undefined ? {} : {
			ompUserHome: options.skillCompatibility.osUserHome,
			ompProjectBoundary: options.skillCompatibility.projectBoundary,
			codexUserHome: options.skillCompatibility.osUserHome,
			codexProjectBoundary: options.skillCompatibility.projectBoundary,
			agentsUserHome: options.skillCompatibility.osUserHome,
			agentsProjectBoundary: options.skillCompatibility.projectBoundary,
			claudeUserHome: options.skillCompatibility.osUserHome,
			claudeProjectBoundary: options.skillCompatibility.projectBoundary,
			claudePluginsHome: options.skillCompatibility.osUserHome,
		}),
	});
	const manager = new ExtensionManager({
		pluginManager,
		skillRegistry,
		skillsPolicyLoader: async () => {
			const settings = await loadProjectSettings({ layout: options.layout });
			return resolveSkillsPolicy(settings.skills, undefined);
		},
		updateSkillsProviderPolicy: async (providerId, enabled, scope) => {
			if (scope !== "user") throw new Error("workspace-scoped provider mutation is not wired in the session path");
			const settings = await loadProjectSettings({ layout: options.layout });
			const providers = { ...(settings.skills?.providers ?? {}) };
			providers[providerId] = enabled;
			await saveProjectSettings({ layout: options.layout }, { ...settings, skills: { enabled: settings.skills?.enabled ?? true, providers } });
		},
	});
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
	// 可执行扩展 host：选包 → 起进程 → 准入工具 → 事件桥。没有可执行包时
	// 整条链路保持惰性（不起进程、不读 trust 之外的任何东西）。
	// 可选 watcher：默认关闭（settings.plugins.watch）。settings 在构造期读一次，
	// in-session 变更需重开会话生效。
	const distributionSettings = await loadProjectSettings({ layout: options.layout });
	const reloadWatch = createSessionReloadWatch({
		manager,
		roots: () => [...declarativeRoots, ...installedDistributionRoots].map((root) => root.rootPath),
		enabled: () => distributionSettings.plugins?.watch === true,
		audit: async (event) => appendSessionExtensionAudit(options.store, options.fence, {
			eventType: event.eventType,
			sessionId: options.fence.sessionId,
			ownerGeneration: options.fence.generation,
			payload: event.payload,
		}),
	});
	const hostExtensions = createSessionHostAssembly({
		options,
		distribution,
		reservedNames: [...options.baseToolNames, "Skill", ...mcp.tools().map((tool) => tool.name)],
	});
	const composition = createSessionExtensionComposition({
		sessionId: options.fence.sessionId,
		generation: options.fence.generation,
		manager,
		mcp,
		skillLoader,
		distribution: distribution.ports,
		hostExtensions,
		hostInspect: () => hostExtensions.inspect(),
		reloadWatch,
		contextSources: (modelContextChars) => {
			const skills = manager.currentSkills().filter((skill) => skill.descriptor.activation === "ready");
			if (skills.length === 0) return [];
			const content = skillCatalogPromptFragment(skills, modelContextChars);
			if (content.length === 0) return [];
			return [{
				fragmentId: `skill-catalog-${runtimeDigest(content).digest.slice(0, 32)}`,
				key: "skill-catalog",
				layer: "resources",
				content,
				trust: "trusted",
				taint: "none",
				priority: "normal",
				estimatedTokens: Math.max(1, Math.ceil(content.length / 4)),
			}];
		},
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
		restart: (serverId: string) => input.manager.restart(serverId),
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

/** host 程序在构建产物里的位置；src 与 dist 布局相同，因此从 package root 拼。 */
function extensionHostEntrypoint(): string {
	return join(fileURLToPath(new URL("../../../", import.meta.url)), "dist", "extensions", "host", "entry.js");
}

/**
 * 可执行扩展 host 的完整装配（P1–P5 的汇合点）。
 *
 * 顺序：`host-activation` 选包 → supervisor 起进程并握手 → P2 准入把注册表投影为
 * 带 provenance 的 `AgentTool` → P3 事件桥 → P4 动作处理器。
 *
 * 诚实边界：actor port 的真实 Session 命令面尚未接线，因此所有会改变会话状态的
 * 动作返回 `session_command_unavailable`（明确失败，不是静默 no-op）；`intent` 只记
 * 审计。工具调用经 `tool:<runtimeName>` 请求名路由到 host 内的 handler。
 */
function createSessionHostAssembly(input: {
	readonly options: ProductionSessionExtensionCompositionOptions;
	readonly distribution: {
		readonly ports: { readonly read: SessionDistributionReadPort; readonly mutate: SessionDistributionMutationPort };
		readonly selectHostCandidates: () => Promise<DistributionHostSelection>;
	};
	readonly reservedNames: readonly string[];
}): SessionExtensionHostPort {
	const { options } = input;
	let supervisor: ExtensionHostSupervisor | undefined;
	let activePackageId: string | undefined;

	const audit = async (eventType: string, payload: Record<string, unknown>): Promise<void> => {
		await appendSessionExtensionAudit(options.store, options.fence, {
			eventType,
			sessionId: options.fence.sessionId,
			ownerGeneration: options.fence.generation,
			payload,
		});
	};

	const actorPort = createExtensionActionActorPort({
		host: () => input.options.actorHost?.current?.(),
		audit: async (eventType, payload) => { await audit(eventType, payload); },
	});
	const actions = createExtensionActionHandler({
		port: actorPort,
		generation: options.fence.generation,
		admittedTools: () => [],
		audit: async (event) => { await audit(event.eventType, event.payload); },
	});

	const runtime: SessionExtensionHostRuntime = {
		start: async (candidate) => {
			const relative = candidate.entrypoints[0];
			if (relative === undefined) return { ok: false, code: "no_entrypoints", message: "candidate declares no entrypoint" };
			supervisor = new ExtensionHostSupervisor({
				managedProcess: options.managedProcess,
				startCommand: { runtimeCommand: process.execPath, runtimeArgs: [], hostEntrypoint: extensionHostEntrypoint() },
				apiVersion: EXTENSION_HOST_API_VERSION,
				actionHandler: actions.handle,
				audit: async (event) => { await audit(event.eventType, event.payload); },
			});
			const started = await supervisor.start({
				generation: options.fence.generation,
				packageId: candidate.packageId,
				digest: candidate.digest,
				rootPath: candidate.installPath,
				entrypoint: join(candidate.installPath, relative.replace(/^\.\//u, "")),
			});
			if (started.status !== "ready") {
				const code = started.status === "failed" ? started.code : "host_not_ready";
				const message = started.status === "failed" ? started.message : "extension host did not become ready";
				supervisor = undefined;
				return { ok: false, code, message };
			}
			const state = supervisor.client()?.state();
			if (state === undefined || state.status !== "ready") {
				await supervisor.stop("protocol-violation").catch(() => undefined);
				supervisor = undefined;
				return { ok: false, code: "registry_unavailable", message: "extension host did not publish a registry" };
			}
			activePackageId = candidate.packageId;
			return { ok: true, snapshot: state.registry };
		},
		shutdown: async () => {
			const current = supervisor;
			supervisor = undefined;
			activePackageId = undefined;
			await current?.stop("owner-request").catch(() => undefined);
		},
		dispatch: async (event) => {
			if (supervisor === undefined) return { ok: false, code: "host_unavailable", message: "extension host is not running" };
			return supervisor.dispatchEvent(event);
		},
		subscribersFor: (name) => {
			const state = supervisor?.client()?.state();
			if (state === undefined || state.status !== "ready" || activePackageId === undefined) return [];
			return state.registry.subscriptions.some((subscription) => subscription.name === name) ? [activePackageId] : [];
		},
		inspect: async () => {
			// 只读投影：host 生命周期 + 候选 gate。不暴露 entrypoint 之外的 native 路径。
			const selection = await input.distribution.selectHostCandidates();
			const status = supervisor?.status();
			const state = supervisor?.client()?.state();
			return {
				host: status === undefined ? "idle" : status.status,
				...(status === undefined || status.status !== "ready" ? {} : {
					generation: status.generation,
					registryDigest: status.registryDigest,
					hostPid: status.hostPid,
					activatedAt: status.activatedAt,
					subscriptions: state?.status === "ready" ? state.registry.subscriptions.length : 0,
					tools: state?.status === "ready" ? state.registry.tools.length : 0,
				}),
				...(status !== undefined && status.status === "failed" ? { code: status.code, message: status.message, retainedGeneration: status.retainedGeneration ?? null } : {}),
				candidates: selection.candidates.map((candidate) => ({
					packageId: candidate.packageId,
					version: candidate.version,
					scope: candidate.scope,
					enabled: candidate.enabled,
					entrypoints: candidate.entrypoints.length,
					declaredTools: candidate.declaredTools.length,
					eligibility: selection.gates.find((gate) => gate.candidate.packageId === candidate.packageId)?.ok === true
						? "host-ready"
						: (selection.gates.find((gate) => gate.candidate.packageId === candidate.packageId) as { readonly code?: string } | undefined)?.code ?? "not-selected",
				})),
				diagnostics: selection.diagnostics,
			};
		},
	};

	const invoke: ExtensionToolInvokerForHost = async ({ provenance, toolCallId, args, signal }) => {
		const outcome = await runtime.dispatch({
			name: `tool:${provenance.runtimeName}`,
			cancelable: false,
			payload: { toolCallId, args },
			...(signal === undefined ? {} : { signal }),
		});
		if (!outcome.ok) return toolErrorResult(outcome.code, outcome.message);
		const handlers = typeof outcome.value === "object" && outcome.value !== null && Array.isArray((outcome.value as { handlers?: unknown }).handlers)
			? (outcome.value as { handlers: readonly { readonly result?: unknown }[] }).handlers
			: [];
		return normalizeHostToolResult(handlers[0]?.result);
	};

	return createSessionExtensionHostPort({
		selection: () => input.distribution.selectHostCandidates(),
		runtime,
		reservedNames: () => input.reservedNames,
		invoke,
		audit: async (event) => { await audit(event.eventType, event.payload); },
	});
}

/** 从已读 manifest 里取声明式 settings；未声明返回 undefined。 */
function declaredSettings(manifest: unknown): Readonly<Record<string, ExtensionSettingDescriptor>> | undefined {
	if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;
	const settings = (manifest as Record<string, unknown>).settings;
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return undefined;
	const entries = Object.entries(settings as Record<string, unknown>);
	return entries.length === 0 ? undefined : settings as Readonly<Record<string, ExtensionSettingDescriptor>>;
}

/**
 * 扩展运行时动作的 actor port（D4）。
 *
 * 有真实命令面的动作走**晚绑定**的 controller（见 `SessionExtensionActionHostHolder`）；
 * 没有对应能力的动作给出各自的具体原因，而不是统一一句“未接线”，更不是静默 no-op。
 *
 * 安全选择：`sendMessage` 的 origin 固定为 `runtime`——扩展可以注入消息，但不得冒充
 * 真实用户输入。
 */
export function createExtensionActionActorPort(input: {
	readonly host: () => SessionExtensionActionHost | undefined;
	readonly audit: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
}): ExtensionActionActorPort {
	const host = input.host;
	const audit = input.audit;
	const port: ExtensionActionActorPort = {
	// 动作：intent 是投影（只记审计）；有真实命令面的动作走晚绑定的 controller；
	// 没有对应能力的动作明确失败并说明原因，不做静默 no-op。
		sendMessage: async ({ text }) => {
			const current = host();
			if (current === undefined) return unavailable("send-message");
			// origin 固定为 runtime：扩展不得冒充真实用户输入（D4/D9）。
			await current.prompt(text, "followUp", "runtime");
			return { ok: true, value: { queued: "follow-up", origin: "runtime" } };
		},
		appendEntry: async ({ entry }) => {
			await audit("extension.action.append_entry", { keys: Object.keys(entry).slice(0, 16) });
			return { ok: false, code: "session_command_unavailable", message: "append-entry has no session ledger surface yet" };
		},
		setActiveTools: async () => unavailable("set-active-tools", "the controller exposes no active-tool setter; use addTools through composition"),
		setModel: async ({ providerId, modelId }) => {
			const current = host();
			if (current === undefined) return unavailable("set-model");
			const models = await current.getAvailableModels(providerId);
			const match = models.find((model) => model.id === modelId && model.provider === providerId);
			if (match === undefined) return { ok: false, code: "model_unavailable", message: `no available model ${providerId}/${modelId}` };
			await current.selectModel(match);
			return { ok: true, value: { providerId, modelId } };
		},
		setThinkingLevel: async ({ level }) => {
			const current = host();
			if (current === undefined) return unavailable("set-thinking-level");
			const applied = await current.setThinkingLevel(level);
			return { ok: true, value: { level: applied } };
		},
		setSessionName: async () => unavailable("set-session-name", "session title mutation is not wired to the extension action surface yet"),
		exec: async () => unavailable("exec", "extension exec must go through a governed managed process; that port is not wired yet"),
		emitIntent: async ({ intent }) => {
			await audit("extension.intent", { kind: intent.kind, level: intent.level, key: intent.key ?? null, textDigest: runtimeDigest(intent.text).digest });
			return { ok: true, value: { projected: "audit-only" } };
		},
	};
	return port;
}

function unavailable(action: string, reason?: string): { readonly ok: false; readonly code: string; readonly message: string } {
	return { ok: false, code: "session_command_unavailable", message: reason ?? `extension action ${action} is not wired to the session command surface yet` };
}

function toolErrorResult(code: string, message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: JSON.stringify({ code }) ?? "null" }], details: { code, message }, isError: true };
}

/** host 返回值按 AgentToolResult 形状归一；其它值包成文本结果。 */
function normalizeHostToolResult(value: unknown): AgentToolResult<unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as { content?: unknown }).content)) {
		const record = value as { content: AgentToolResult<unknown>["content"]; details?: unknown; isError?: boolean };
		return { content: record.content, details: record.details ?? null, ...(record.isError === true ? { isError: true } : {}) };
	}
	let text: string;
	try { text = JSON.stringify(value) ?? "null"; }
	catch { text = "[unserializable extension tool result]"; }
	return { content: [{ type: "text", text }], details: value ?? null };
}

/**
 * Session 私有分发接线（P5）。
 *
 * 安装/启用/信任三者分离：这里只提供落盘、账本与查询能力，**不**启用、不信任、
 * 也不启动 extension host。git 源的受治 materialize 尚未接线，因此所有
 * 非本地源都明确返回 `network_denied`（D7 的默认拒绝姿态），而不是回退到
 * 本地猜测路径。
 */
function createSessionDistribution(input: {
	readonly home: string;
	readonly stateRoot: string;
	readonly storageKey: string;
	readonly distributionRoot: string;
	readonly managedProcess: ProcessToolClient & Pick<ManagedBackgroundBashOperations, "start">;
	readonly cwd: string;
	readonly trustStore: TrustStore;
	readonly principalId: PrincipalId;
	readonly layout: RunledgerLayout;
	readonly actorHost?: SessionExtensionActionHostHolder;
}): {
	readonly ports: { readonly read: SessionDistributionReadPort; readonly mutate: SessionDistributionMutationPort };
	/** 已安装声明式包的发现根；注册表不可读时返回空数组（不阻断会话启动）。 */
	readonly declarativeRoots: () => Promise<readonly ExtensionSourceRoot[]>;
	/** host 候选选择（enabled + trusted + 有 entrypoint），供 host 装配使用。 */
	readonly selectHostCandidates: () => Promise<DistributionHostSelection>;
} {
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: input.home });
	const registry = new ExtensionDistributionRegistry({
		storage,
		paths: resolveExtensionDistributionPaths({ stateRoot: input.stateRoot, pluginsRoot: input.distributionRoot }),
	});
	// git 源经既有 governed managed process 执行（D7）：network policy 仍由该
	// 会话的 ExecutionEnv 决定，默认拒绝；被拒绝时明确返回而不是静默回退。
	const materializer: ExtensionSourceMaterializer = createManagedGitMaterializer({
		managedProcess: input.managedProcess,
		storage,
		cwd: input.cwd,
	});
	const scopeRoot = (scope: "user" | "workspace"): string => scope === "user"
		? join(input.distributionRoot, "user")
		: join(input.distributionRoot, "workspaces", input.storageKey);
	const installer = new ExtensionInstaller({ storage, registry, materializer, pluginsRoot: input.distributionRoot, scopeRoot });
	const fetcher = new MarketplaceFetcher({
		storage,
		cache: resolveExtensionCachePaths({ pluginsRoot: input.distributionRoot }),
		materializer,
	});
	const manager = new MarketplaceManager({ registry, fetcher, installer, scope: () => "workspace" });
	const scopeRootForDoctor = (scope: "user" | "project"): string => scope === "user"
		? join(input.distributionRoot, "user")
		: join(input.distributionRoot, "workspaces", input.storageKey);

	const read: SessionDistributionReadPort = {
		list: async () => {
			const listed = await manager.listInstalled();
			if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
			// 附上 host 资格与原因，让 CLI/TUI 能回答“为什么这个扩展没在跑”。
			const selection = await selectDistributionHostCandidates({ registry, storage, trustStore: input.trustStore, principalId: input.principalId });
			const reasons = new Map(selection.gates.map((gate) => [gate.candidate.packageId, gate.ok ? "host-ready" : gate.code]));
			return {
				ok: true,
				value: {
					items: listed.value.map((item) => ({ ...item, hostEligibility: reasons.get(item.packageId) ?? "no-entrypoints" })),
					diagnostics: selection.diagnostics,
				},
			};
		},
		doctor: async () => {
			const report = await runExtensionDoctor({ storage, registry, scopeRoot: scopeRootForDoctor });
			return { ok: true, value: { findings: report.findings, counts: report.counts } };
		},
		configRead: async () => {
			const loaded = await loadInstalledRunledgerManifests({ registry, storage });
			const settings = await loadProjectSettings({ layout: input.layout });
			const items: Record<string, unknown>[] = [];
			for (const entry of loaded.manifests) {
				const declared = declaredSettings(entry.manifest);
				if (declared === undefined) continue;
				// D13：值只在 user 层授权；workspace 收窄由 settings 层叠加，这里给出
				// user 层已生效值 + 默认值，并由 resolvePluginSettings 复核。
				const stored = settings.plugins?.values?.[entry.packageId] ?? {};
				const resolved = resolvePluginSettings(declared, [{ scope: "user", values: stored }]);
				if (!resolved.ok) {
					items.push({ packageId: entry.packageId, declared, values: {}, error: { code: resolved.code, key: resolved.key } });
					continue;
				}
				items.push({ packageId: entry.packageId, declared, values: applySettingDefaults(declared, resolved.values), narrowed: resolved.narrowed });
			}
			return { ok: true, value: { items, diagnostics: loaded.diagnostics } };
		},
		marketplaces: async () => {
			const listed = await manager.listMarketplaces();
			if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
			const updates = await manager.pendingUpdates();
			return { ok: true, value: { marketplaces: listed.value, pendingUpdates: updates.ok ? updates.value : [] } };
		},
		featuresRead: async () => {
			const loaded = await loadInstalledRunledgerManifests({ registry, storage });
			const ledger = await registry.loadRunledgerRegistry();
			if (!ledger.ok) return { ok: false, code: ledger.code, message: ledger.message };
			const items: Record<string, unknown>[] = [];
			for (const entry of loaded.manifests) {
				const record = ledger.document.plugins[entry.packageId];
				// 只有账本里存在的记录才有选择；账本不一致时报告 diagnostic 而不是编造默认值。
				if (record === undefined) continue;
				const state = describePluginFeatures({
					packageId: entry.packageId,
					manifest: entry.manifest,
					selection: record.enabledFeatures,
				});
				if (state.declared.length === 0) continue;
				items.push({ ...state });
			}
			return { ok: true, value: { items, diagnostics: loaded.diagnostics } };
		},
	};
	const mutate: SessionDistributionMutationPort = {
		install: async ({ spec, scope }) => {
			const installed = await manager.installPlugin({ spec, scope });
			return installed.ok ? { ok: true, value: { receipt: installed.value.receipt } } : { ok: false, code: installed.code, message: installed.message };
		},
		uninstall: async ({ packageId, scope }) => {
			const removed = await installer.uninstall({ packageId, scope });
			return removed.ok ? { ok: true, value: { removedPath: removed.removedPath } } : { ok: false, code: removed.code, message: removed.message };
		},
		link: async ({ packageId, name, localPath, scope }) => {
			const linked = await installer.link({ packageId, name, localPath, scope });
			return linked.ok ? { ok: true, value: { receipt: linked.receipt } } : { ok: false, code: linked.code, message: linked.message };
		},
		upgrade: async ({ spec, scope }) => {
			const installed = await manager.installPlugin({ spec, scope });
			return installed.ok ? { ok: true, value: { receipt: installed.value.receipt } } : { ok: false, code: installed.code, message: installed.message };
		},
		addMarketplace: async ({ name, sourceType, sourceUri }) => {
			const added = await manager.addMarketplace({
				name,
				sourceType: sourceType === "github" || sourceType === "git" || sourceType === "url" ? sourceType : "local",
				sourceUri,
			});
			return added.ok ? { ok: true, value: { marketplace: added.value } } : { ok: false, code: added.code, message: added.message };
		},
		removeMarketplace: async ({ name }) => {
			const removed = await manager.removeMarketplace(name);
			return removed.ok ? { ok: true, value: { ...removed.value } } : { ok: false, code: removed.code, message: removed.message };
		},
		updateMarketplace: async ({ name }) => {
			const refreshed = await manager.refreshMarketplace(name);
			return refreshed.ok ? { ok: true, value: { marketplace: refreshed.value } } : { ok: false, code: refreshed.code, message: refreshed.message };
		},
		configWrite: async ({ packageId, values }) => {
			const listed = await loadInstalledRunledgerManifests({ registry, storage });
			const entry = listed.manifests.find((manifest) => manifest.packageId === packageId);
			if (entry === undefined) return { ok: false, code: "plugin_not_installed", message: `no installed package matches ${packageId}` };
			const declared = declaredSettings(entry.manifest);
			if (declared === undefined) return { ok: false, code: "no_declared_settings", message: `${packageId} declares no settings` };
			const validated = validatePluginSettings(declared, values);
			if (!validated.ok) return { ok: false, code: validated.code, message: validated.message };
			const settings = await loadProjectSettings({ layout: input.layout });
			const stored = { ...(settings.plugins?.values?.[packageId] ?? {}) };
			for (const key of validated.accepted) {
				const value = values[key];
				if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") stored[key] = value;
			}
			await saveProjectSettings({ layout: input.layout }, {
				...settings,
				plugins: { values: { ...(settings.plugins?.values ?? {}), [packageId]: stored } },
			});
			return { ok: true, value: { packageId, accepted: validated.accepted } };
		},
		featuresWrite: async ({ packageId, enabledFeatures }) => {
			const listed = await loadInstalledRunledgerManifests({ registry, storage });
			const entry = listed.manifests.find((manifest) => manifest.packageId === packageId);
			if (entry === undefined) return { ok: false, code: "plugin_not_installed", message: `no installed package matches ${packageId}` };
			// 只改账本里的选择字段：不启用、不信任、不重启 host（D7）。
			const applied = await applyPluginFeatureSelection({ registry, packageId, manifest: entry.manifest, selection: enabledFeatures });
			return applied.ok
				? { ok: true, value: { ...applied.value } }
				: { ok: false, code: applied.code, message: applied.message };
		},
		upgradeFromMarketplace: async ({ marketplace, scope }) => {
			const updates = await manager.pendingUpdates();
			if (!updates.ok) return { ok: false, code: updates.code, message: updates.message };
			const applied: Record<string, unknown>[] = [];
			for (const update of updates.value.filter((item) => item.marketplace === marketplace)) {
				const installed = await manager.installPlugin({ spec: `${update.name}@${marketplace}`, scope });
				if (!installed.ok) return { ok: false, code: installed.code, message: installed.message };
				applied.push({ packageId: update.packageId, version: installed.value.receipt.version });
			}
			return { ok: true, value: { upgraded: applied } };
		},
	};
	return {
		ports: { read, mutate },
		declarativeRoots: async () => {
			const bridged = await distributionPluginRoots({ registry, storageKey: input.storageKey });
			return bridged.ok ? bridged.roots : [];
		},
		selectHostCandidates: () => selectDistributionHostCandidates({ registry, storage, trustStore: input.trustStore, principalId: input.principalId }),
	};
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
