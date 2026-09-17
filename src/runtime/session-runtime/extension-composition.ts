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
import { selectDistributionHostCandidates } from "../../extensions/plugins/host-activation.ts";
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
}

export interface SessionExtensionComposition {
	readonly tools: readonly AgentTool[];
	readonly resources: SessionResourceDomainPort;
	readonly contextSources: (modelContextChars: number) => readonly RuntimeContextSource[];
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
	/** composition root 解析的兼容 Skill locator；providers 不自行读取 OS/cwd。 */
	readonly skillCompatibility?: Readonly<{
		readonly osUserHome: string;
		readonly projectBoundary: string;
	}>;
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
	Object.freeze({ operation: "plugin.distribution.list", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.doctor", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "marketplace.discover", capability: "session.plugins", access: "read" }),
	Object.freeze({ operation: "plugin.install", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.uninstall", capability: "session.plugins", access: "mutate" }),
	Object.freeze({ operation: "plugin.link", capability: "session.plugins", access: "mutate" }),
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
}

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
		mutate: (operation, payload, context) => mutateResources(options, operation, payload, context),
	};
	return {
		tools,
		resources,
		contextSources: options.contextSources ?? (() => []),
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
	if (operation === "plugin.distribution.list" || operation === "plugin.doctor" || operation === "marketplace.discover") {
		const distribution = options.distribution?.read;
		if (distribution === undefined) return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
		const read = operation === "plugin.distribution.list"
			? await distribution.list()
			: operation === "plugin.doctor"
				? await distribution.doctor()
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

/** P5 分发 mutate 操作名；与 OPERATION_MANIFEST 中的 mutate 项一一对应。 */
const DISTRIBUTION_MUTATION_OPERATIONS = new Set<string>([
	"plugin.install",
	"plugin.uninstall",
	"plugin.link",
	"plugin.upgrade",
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
		case "plugin.link": {
			const packageId = stringValue(payload.pluginId);
			const name = stringValue(payload.name);
			const localPath = stringValue(payload.localPath);
			if (packageId === undefined || name === undefined || localPath === undefined) return { ok: false, code: "link_arguments_required" };
			const applied = await port.link({ packageId, name, localPath, scope });
			return applied.ok ? { ok: true, value: applied.value ?? {} } : { ok: false, code: applied.code ?? "link_failed" };
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
	const composition = createSessionExtensionComposition({
		sessionId: options.fence.sessionId,
		generation: options.fence.generation,
		manager,
		mcp,
		skillLoader,
		distribution: distribution.ports,
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
}): {
	readonly ports: { readonly read: SessionDistributionReadPort; readonly mutate: SessionDistributionMutationPort };
	/** 已安装声明式包的发现根；注册表不可读时返回空数组（不阻断会话启动）。 */
	readonly declarativeRoots: () => Promise<readonly ExtensionSourceRoot[]>;
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
		marketplaces: async () => {
			const listed = await manager.listMarketplaces();
			if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
			const updates = await manager.pendingUpdates();
			return { ok: true, value: { marketplaces: listed.value, pendingUpdates: updates.ok ? updates.value : [] } };
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
