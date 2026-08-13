/**
 * Skill registry 的 observation/status/snapshot 类型与 SkillRegistry 实现。
 *
 * provider 只产出 observation；本 registry 的 skills capability 统一 scanner/
 * normalizer 才创建 SkillDescriptor 与 resource facets；TrustStore/
 * ExtensionStateStore 决定 activation。snapshot 不可变：构建后 Object.freeze，
 * reload 只在 idle 时原子交换（ExtensionManager/turn-lifecycle 负责）。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { join } from "node:path";
import { CapabilityRegistry } from "../capabilities/registry.ts";
import type { CapabilityBuildInput, CapabilityDefinition, DiscoveryProvider, ProviderStatus } from "../capabilities/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, sortExtensionDiagnostics } from "../diagnostics.ts";
import type { ExtensionDiagnostic, ExtensionScanLimits } from "../diagnostics.ts";
import { sourceKey } from "../paths.ts";
import type { PluginSkillContribution } from "../plugins/manager.ts";
import { scanSkill, scanSkillsDirectory } from "./scanner.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { ExtensionStateStore } from "../state-store.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import { TrustStore } from "../trust/trust-store.ts";
import { createPluginContributionsProvider } from "./providers/plugin-contributions.ts";
import { createRunledgerBuiltinProvider, createRunledgerRepoProvider, createRunledgerSessionProvider, createRunledgerUserProvider, createRunledgerWorkspaceProvider } from "./providers/runledger.ts";
import { createCodexProjectProvider, createCodexUserProvider } from "./providers/codex.ts";
import { createAgentsProjectProvider, createAgentsUserProvider } from "./providers/agents.ts";
import { createClaudeProjectProvider, createClaudeUserProvider } from "./providers/claude.ts";
import { createClaudePluginsProvider } from "./providers/claude-plugins.ts";
import type { SkillDescriptor, SkillTrustBinding } from "./types.ts";

export type SkillDiscoveryLevel = "builtin" | "user" | "workspace" | "project" | "plugin" | "session";

export interface SkillDiscoveryObservation {
	readonly providerId: string;
	readonly source: ExtensionSourceRoot["source"];
	readonly level: SkillDiscoveryLevel;
	readonly canonicalRoot: string;
	readonly scanKind: "skills-directory" | "single-skill-directory";
	readonly priority: number;
	readonly pluginId?: string;
	readonly inheritedTrustBinding?: SkillTrustBinding;
	readonly sourceRegistry?: Readonly<{
		readonly locatorDigest: string;
		readonly entryId: string;
		readonly declaredEnabled?: boolean;
	}>;
}

export interface SkillProviderStatus extends ProviderStatus {
	readonly candidateCount: number;
	readonly activeCount: number;
	readonly failedCount: number;
}

export interface SkillRegistrySnapshot {
	readonly generation: number;
	readonly digest: string;
	readonly providers: readonly SkillProviderStatus[];
	readonly all: readonly SkillDescriptor[];
	readonly active: readonly SkillDescriptor[];
	readonly modelDiscoverable: readonly SkillDescriptor[];
	readonly userInvocable: readonly SkillDescriptor[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface SkillRegistryOptions {
	readonly storage: ExtensionStoragePort;
	readonly trustStore: TrustStore;
	readonly stateStore: ExtensionStateStore;
	readonly scope: ExtensionRuntimeScope;
	readonly limits?: ExtensionScanLimits;
	/** PluginManager 的被动 Skill contributions（composition root 注入 getter）。 */
	readonly pluginContributions: () => readonly PluginSkillContribution[];
	/** builtin skill roots（缺省不构造 builtin provider）。 */
	readonly builtinSkillRoots?: readonly string[];
	/** canonical user skills root（`<state>/extensions/user/skills/`）。 */
	readonly userSkillRoot?: string;
	/** canonical workspace skills root（`<state>/extensions/workspaces/<key>/skills/`）。 */
	readonly workspaceSkillRoot?: string;
	/** repo/ancestor `.runledger/skills/` root（默认 off，仅受信 settings 显式开启）。 */
	readonly repoSkillRoot?: string;
	/** session 注入的临时 roots（默认 off/empty）。 */
	readonly sessionSkillRoots?: readonly string[];
	/** Codex user compatibility root（默认 off）：`<os-user-home>`，由 composition root 解析注入。 */
	readonly codexUserHome?: string;
	/** Codex project compatibility root（默认 off）：repo boundary。 */
	readonly codexProjectBoundary?: string;
	/** Agents user compatibility root（默认 off）：`<os-user-home>`（`.agents`+`.agent` 各一 observation）。 */
	readonly agentsUserHome?: string;
	/** Agents project compatibility root（默认 off）：repo boundary。 */
	readonly agentsProjectBoundary?: string;
	/** Claude user compatibility root（默认 off）：`<os-user-home>`。 */
	readonly claudeUserHome?: string;
	/** Claude project compatibility root（默认 off）：repo boundary。 */
	readonly claudeProjectBoundary?: string;
	/** Claude plugins compatibility root（默认 off）：`<os-user-home>`（registry 在 `~/.claude/plugins/`）。 */
	readonly claudePluginsHome?: string;
	/** 额外显式 providers（如测试注入）；缺省构造 builtin/user/workspace/repo/session/plugin。 */
	readonly providers?: readonly DiscoveryProvider<SkillDiscoveryObservation>[];
}

function validateSkillObservation(observation: SkillDiscoveryObservation): readonly ExtensionDiagnostic[] {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (observation.providerId.length === 0) diagnostics.push(extensionDiagnostic("skill.observation_provider_missing", "error", "observation has no provider id", "skill"));
	if (observation.canonicalRoot.length === 0) diagnostics.push(extensionDiagnostic("skill.observation_root_missing", "error", "observation has no canonical root", "skill", observation.providerId));
	if (observation.scanKind !== "skills-directory" && observation.scanKind !== "single-skill-directory") diagnostics.push(extensionDiagnostic("skill.observation_scan_kind_invalid", "error", "observation has an invalid scan kind", "skill", observation.providerId));
	return diagnostics;
}

function trustScopeForSource(source: ExtensionSourceRoot["source"]): "user" | "project" | "session" {
	return source === "user" ? "user" : source === "session" ? "session" : "project";
}

function compareByQualifiedId(left: SkillDescriptor, right: SkillDescriptor): number {
	return left.descriptor.identity.qualifiedId < right.descriptor.identity.qualifiedId ? -1 : left.descriptor.identity.qualifiedId > right.descriptor.identity.qualifiedId ? 1 : 0;
}

/** composition root 的显式构造点：装配 providers、冻结并返回可 load 的 registry。 */
export function createSkillRegistry(options: SkillRegistryOptions): SkillRegistry {
	return new SkillRegistry(options);
}

export class SkillRegistry {
	readonly #storage: ExtensionStoragePort;
	readonly #trustStore: TrustStore;
	readonly #stateStore: ExtensionStateStore;
	readonly #scope: ExtensionRuntimeScope;
	readonly #limits: ExtensionScanLimits;
	readonly #registry: CapabilityRegistry;
	#generation = 0;
	#current: SkillRegistrySnapshot | undefined;

	public constructor(options: SkillRegistryOptions) {
		this.#storage = options.storage;
		this.#trustStore = options.trustStore;
		this.#stateStore = options.stateStore;
		this.#scope = options.scope;
		this.#limits = options.limits ?? DEFAULT_EXTENSION_LIMITS;
		const registry = new CapabilityRegistry();
		const capability: CapabilityDefinition<SkillDiscoveryObservation, SkillRegistrySnapshot> = {
			id: "skills",
			displayName: "Skills",
			validateObservation: validateSkillObservation,
			buildSnapshot: async (input) => this.#buildSnapshot(input),
		};
		registry.registerCapability(capability);
		const defaultProviders: DiscoveryProvider<SkillDiscoveryObservation>[] = [];
		for (const root of options.builtinSkillRoots ?? []) defaultProviders.push(createRunledgerBuiltinProvider(root));
		if (options.userSkillRoot !== undefined) defaultProviders.push(createRunledgerUserProvider(options.userSkillRoot));
		if (options.workspaceSkillRoot !== undefined) defaultProviders.push(createRunledgerWorkspaceProvider(options.workspaceSkillRoot));
		if (options.repoSkillRoot !== undefined) defaultProviders.push(createRunledgerRepoProvider(options.repoSkillRoot));
		for (const root of options.sessionSkillRoots ?? []) defaultProviders.push(createRunledgerSessionProvider(root));
		if (options.codexUserHome !== undefined) defaultProviders.push(createCodexUserProvider(options.codexUserHome));
		if (options.codexProjectBoundary !== undefined) defaultProviders.push(createCodexProjectProvider(options.codexProjectBoundary));
		if (options.agentsUserHome !== undefined) defaultProviders.push(createAgentsUserProvider(options.agentsUserHome));
		if (options.agentsProjectBoundary !== undefined) defaultProviders.push(createAgentsProjectProvider(options.agentsProjectBoundary));
		if (options.claudeUserHome !== undefined) defaultProviders.push(createClaudeUserProvider(options.claudeUserHome));
		if (options.claudeProjectBoundary !== undefined) defaultProviders.push(createClaudeProjectProvider(options.claudeProjectBoundary));
		if (options.claudePluginsHome !== undefined) defaultProviders.push(createClaudePluginsProvider({
			registryPath: join(options.claudePluginsHome, ".claude", "plugins", "installed_plugins.json"),
			pluginCacheRoot: join(options.claudePluginsHome, ".claude", "plugins"),
			...(options.claudeProjectBoundary === undefined ? {} : { activeProjectBoundary: options.claudeProjectBoundary }),
		}));
		defaultProviders.push(createPluginContributionsProvider({ contributions: options.pluginContributions }));
		for (const provider of [...defaultProviders, ...(options.providers ?? [])]) registry.registerProvider(provider);
		registry.freeze();
		this.#registry = registry;
	}

	public current(): SkillRegistrySnapshot | undefined {
		return this.#current;
	}

	/** ExtensionManager 成功交换 parent snapshot 后才发布对应 child snapshot。 */
	public publish(snapshot: SkillRegistrySnapshot): void {
		if (snapshot.generation <= this.#generation) throw new Error("skill snapshot generation must increase");
		this.#generation = snapshot.generation;
		this.#current = snapshot;
	}

	public providers(): readonly DiscoveryProvider<SkillDiscoveryObservation>[] {
		return this.#registry.providers() as readonly DiscoveryProvider<SkillDiscoveryObservation>[];
	}

	public async load(input: { readonly providerEnabled?: ReadonlyMap<string, boolean>; readonly masterEnabled?: boolean; readonly signal?: AbortSignal; readonly publish?: boolean; readonly pluginContributions?: readonly PluginSkillContribution[] } = {}): Promise<SkillRegistrySnapshot> {
		const providerEnabled = input.masterEnabled === false
			? new Map(this.providers().map((provider) => [provider.id, false] as const))
			: input.providerEnabled;
		const result = await this.#registry.load({
			providerEnabled,
			signal: input.signal,
			storage: this.#storage,
			...(input.pluginContributions === undefined ? {} : { inputs: new Map<string, unknown>([["runledger-plugin", input.pluginContributions]]) }),
		});
		const base = result.snapshots.get("skills") as Omit<SkillRegistrySnapshot, "generation"> | undefined;
		if (base === undefined) {
			const failure = result.diagnostics.find((diagnostic) => diagnostic.code === "capability.snapshot_failed");
			throw new Error(failure?.message ?? "skills capability snapshot is unavailable");
		}
		const generation = this.#generation + 1;
		const snapshot: SkillRegistrySnapshot = Object.freeze({
			...base,
			generation,
			providers: Object.freeze([...base.providers]),
			all: Object.freeze([...base.all]),
			active: Object.freeze([...base.active]),
			modelDiscoverable: Object.freeze([...base.modelDiscoverable]),
			userInvocable: Object.freeze([...base.userInvocable]),
			diagnostics: Object.freeze([...base.diagnostics]),
		});
		if (input.publish !== false) this.publish(snapshot);
		return snapshot;
	}

	/** 按 exact resource receipt 授予信任；plugin-owned Skill 应继续走 plugin trust。 */
	public async trust(qualifiedId: string): Promise<void> {
		const skill = this.#current?.all.find((item) => item.descriptor.identity.qualifiedId === qualifiedId);
		if (!skill) throw new Error("skill identity is not present in the current snapshot");
		await this.#trustStore.grant({
			identity: skill.trustBinding.identity,
			canonicalPath: skill.trustBinding.canonicalPath,
			binding: skill.trustBinding.binding,
			principalId: this.#scope.principalId,
			scope: trustScopeForSource(skill.sourceRoot.source),
		});
	}

	public async untrust(qualifiedId: string): Promise<void> {
		const skill = this.#current?.all.find((item) => item.descriptor.identity.qualifiedId === qualifiedId);
		if (!skill) throw new Error("skill identity is not present in the current snapshot");
		await this.#trustStore.revoke(skill.descriptor.resource);
	}

	async #buildSnapshot(input: CapabilityBuildInput<SkillDiscoveryObservation>): Promise<SkillRegistrySnapshot> {
		const diagnostics: ExtensionDiagnostic[] = [...input.diagnostics];
		const state: ExtensionStateDocument = await this.#stateStore.load();
		const stateError = this.#stateStore.loadError();
		if (stateError !== undefined) throw new Error(stateError);
		const scanned: SkillDescriptor[] = [];
		for (const observation of input.observations) {
			const root: ExtensionSourceRoot = {
				source: observation.source,
				sourceKey: sourceKey(observation.source, observation.canonicalRoot),
				rootPath: observation.canonicalRoot,
				priority: observation.priority,
				...(observation.pluginId === undefined ? {} : { pluginId: observation.pluginId }),
			};
			const common = {
				root,
				scope: this.#scope,
				trustStore: this.#trustStore,
				state,
				limits: this.#limits,
				providerId: observation.providerId,
				...(observation.inheritedTrustBinding === undefined ? {} : { inheritedTrustBinding: observation.inheritedTrustBinding }),
			};
			if (observation.scanKind === "single-skill-directory") {
				const result = await scanSkill(this.#storage, { ...common, skillRoot: observation.canonicalRoot });
				diagnostics.push(...result.diagnostics);
				if (result.skill) scanned.push(result.skill);
			} else {
				const result = await scanSkillsDirectory(this.#storage, { ...common, skillsRoot: observation.canonicalRoot });
				diagnostics.push(...result.diagnostics);
				scanned.push(...result.skills);
			}
		}

		// 同一 identity 合并（同 path+digest）或 conflict（不同 path/digest → invariant failure）。
		const merged = new Map<string, SkillDescriptor>();
		for (const skill of scanned) {
			const key = skill.descriptor.identity.qualifiedId;
			const existing = merged.get(key);
			if (existing === undefined) {
				merged.set(key, skill);
				continue;
			}
			if (existing.skillFile === skill.skillFile && existing.bodyDigest === skill.bodyDigest) {
				const ids = [...new Set([...(existing.providerIds ?? []), ...(skill.providerIds ?? [])])].sort();
				merged.set(key, { ...existing, providerIds: ids });
				continue;
			}
			merged.delete(key);
			diagnostics.push(extensionDiagnostic("skill.identity_conflict", "error", `skill identity ${key} maps to different content and cannot be activated`, "skill", key));
		}

		const all = [...merged.values()].sort(compareByQualifiedId);
		const active = all.filter((skill) => skill.descriptor.activation === "ready");
		const modelDiscoverable = active.filter((skill) => skill.frontmatter.disableModelInvocation !== true);
		const userInvocable = active.filter((skill) => skill.frontmatter.userInvocable !== false);
		const providers: SkillProviderStatus[] = input.providerStatuses.map((status) => {
			const descriptors = all.filter((skill) => skill.providerIds?.includes(status.providerId));
			return {
				...status,
				candidateCount: descriptors.length,
				activeCount: descriptors.filter((skill) => skill.descriptor.activation === "ready").length,
				failedCount: 0,
			};
		});
		const sortedDiagnostics = sortExtensionDiagnostics(diagnostics);
		const digest = canonicalDigest({
			all: all.map((skill) => ({ qualifiedId: skill.descriptor.identity.qualifiedId, bodyDigest: skill.bodyDigest, activation: skill.descriptor.activation })),
			providers: providers.map((provider) => ({ id: provider.providerId, state: provider.state })),
			diagnostics: sortedDiagnostics.map((item) => ({ code: item.code, severity: item.severity, path: item.path ?? null })),
		});
		return Object.freeze({
			generation: 0,
			digest,
			providers: Object.freeze(providers),
			all: Object.freeze(all),
			active: Object.freeze(active),
			modelDiscoverable: Object.freeze(modelDiscoverable),
			userInvocable: Object.freeze(userInvocable),
			diagnostics: Object.freeze(sortedDiagnostics),
		});
	}
}
