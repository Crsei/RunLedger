/** Runtime-owned extension snapshot lifecycle. */

import { createRuntimeId } from "../runtime/protocol/ids.ts";
import { buildExtensionSnapshot, ExtensionSnapshotStore, type ExtensionSnapshot } from "./snapshot.ts";
import type { ExtensionDiagnostic } from "./diagnostics.ts";
import type { ExtensionResourceDescriptor } from "./types.ts";
import type { PluginDiscoveryResult, PluginManager } from "./plugins/manager.ts";
import type { HookDefinition } from "./hooks/types.ts";
import type { SkillDescriptor } from "./skills/types.ts";
import type { SkillRegistry, SkillProviderStatus } from "./skills/registry.ts";
import type { SkillsPolicyResult } from "./skills/policy.ts";
import type { ExtensionSkillProviderProjection } from "./snapshot.ts";

/** 合并 Plugin/Hook/MCP 与 SkillRegistry descriptors，按 identity 去重（保留首个）。 */
function mergeExtensionDescriptors(
	pluginDescriptors: readonly ExtensionResourceDescriptor[],
	skillDescriptors: readonly ExtensionResourceDescriptor[],
): ExtensionResourceDescriptor[] {
	const seen = new Set<string>();
	const merged: ExtensionResourceDescriptor[] = [];
	for (const descriptor of [...pluginDescriptors, ...skillDescriptors]) {
		const key = `${descriptor.identity.kind}:${descriptor.identity.qualifiedId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(descriptor);
	}
	return merged;
}

function projectSkillProvider(status: SkillProviderStatus): ExtensionSkillProviderProjection {
	return {
		providerId: status.providerId,
		displayName: status.displayName,
		rank: status.rank,
		effectiveEnabled: status.effectiveEnabled,
		state: status.state,
		candidateCount: status.candidateCount,
		activeCount: status.activeCount,
		failedCount: status.failedCount,
		...(status.lastError === undefined ? {} : { lastError: status.lastError }),
	};
}

export type ExtensionReloadStatus = "ready" | "pending" | "failed";

export interface ExtensionReloadResult {
	readonly status: ExtensionReloadStatus;
	readonly snapshot?: ExtensionSnapshot;
	readonly retained?: ExtensionSnapshot;
	readonly diagnostics?: readonly ExtensionDiagnostic[];
	readonly error?: string;
}

export interface ExtensionPublicDescriptor {
	readonly kind?: ExtensionResourceDescriptor["kind"];
	readonly identity: ExtensionResourceDescriptor["identity"];
	readonly displayName?: string;
	readonly description?: string;
	readonly pluginId?: string;
	readonly runtimeName?: string;
	readonly priority?: number;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly ready: boolean;
	readonly trust?: ExtensionResourceDescriptor["trust"];
	readonly activation?: ExtensionResourceDescriptor["activation"];
	readonly approvalReceiptId?: string;
	readonly diagnostics?: readonly Pick<ExtensionDiagnostic, "code" | "severity" | "message">[];
	readonly capabilities?: readonly string[];
}

export interface ExtensionPublicSnapshot {
	readonly snapshotId: string;
	readonly generation: number;
	readonly createdAt: string;
	readonly descriptors: readonly ExtensionPublicDescriptor[];
	readonly diagnostics: readonly Pick<ExtensionDiagnostic, "code" | "severity" | "message">[];
	readonly counts: ExtensionSnapshot["counts"];
	readonly skillProviders: ExtensionSnapshot["skillProviders"];
	readonly digest: string;
}

export interface ExtensionManagerOptions {
	readonly pluginManager: PluginManager;
	readonly skillRegistry: SkillRegistry;
	readonly snapshotStore?: ExtensionSnapshotStore;
	readonly now?: () => Date;
	/** 异步返回当前已合并 skills policy（可随 settings mutation 变化）。 */
	readonly skillsPolicyLoader?: () => Promise<SkillsPolicyResult | undefined>;
	/** 持久化 provider enable mutation 到 canonical settings（composition root 注入）。 */
	readonly updateSkillsProviderPolicy?: (providerId: string, enabled: boolean, scope: "user" | "workspace") => Promise<void>;
}

/**
 * The manager owns only discovery state and snapshot swapping. It never starts
 * a process or invokes a resource; those effects remain Host ports.
 */
export class ExtensionManager {
	readonly #pluginManager: PluginManager;
	readonly #skillRegistry: SkillRegistry;
	readonly #snapshots: ExtensionSnapshotStore;
	readonly #now: () => Date;
	readonly #skillsPolicyLoader: (() => Promise<SkillsPolicyResult | undefined>) | undefined;
	readonly #updateSkillsProviderPolicy: ((providerId: string, enabled: boolean, scope: "user" | "workspace") => Promise<void>) | undefined;
	#reloadPromise: Promise<ExtensionReloadResult> | undefined;

	public constructor(options: ExtensionManagerOptions) {
		this.#pluginManager = options.pluginManager;
		this.#skillRegistry = options.skillRegistry;
		this.#snapshots = options.snapshotStore ?? new ExtensionSnapshotStore();
		this.#now = options.now ?? (() => new Date());
		this.#skillsPolicyLoader = options.skillsPolicyLoader;
		this.#updateSkillsProviderPolicy = options.updateSkillsProviderPolicy;
	}

	public current(): ExtensionSnapshot | undefined {
		return this.#snapshots.current();
	}

	/** Returns hook definitions belonging to the currently published snapshot. */
	public currentHooks(): readonly HookDefinition[] {
		return this.current() === undefined ? [] : this.#pluginManager.hooks();
	}

	/** Returns the active Skill descriptors of the currently published snapshot (loader/catalog view). */
	public currentSkills(): readonly SkillDescriptor[] {
		return this.current() === undefined ? [] : this.#skillRegistry.current()?.active ?? [];
	}

	public publicSnapshot(): ExtensionPublicSnapshot | undefined {
		const snapshot = this.current();
		return snapshot === undefined ? undefined : projectExtensionSnapshot(snapshot);
	}

	public beginTurn(): ExtensionSnapshot {
		return this.#snapshots.beginTurn();
	}

	public async endTurn(): Promise<ExtensionReloadResult | undefined> {
		if (!this.#snapshots.endTurn()) return undefined;
		return this.#reloadNow();
	}

	public async load(): Promise<ExtensionReloadResult> {
		return this.#reloadNow();
	}

	public async reload(): Promise<ExtensionReloadResult> {
		if (this.#snapshots.requestReload() === "pending") {
			return { status: "pending", ...(this.current() === undefined ? {} : { retained: this.current() }) };
		}
		return this.#reloadNow();
	}

	public async setEnabled(pluginId: string, enabled: boolean): Promise<ExtensionReloadResult> {
		await this.#ensureDiscovery();
		try {
			await this.#pluginManager.setEnabled(pluginId, enabled);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	public async trust(pluginId: string): Promise<ExtensionReloadResult> {
		await this.#ensureDiscovery();
		try {
			await this.#pluginManager.trust(pluginId);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	public async untrust(pluginId: string): Promise<ExtensionReloadResult> {
		await this.#ensureDiscovery();
		try {
			await this.#pluginManager.untrust(pluginId);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	public async trustSkill(skillId: string): Promise<ExtensionReloadResult> {
		await this.#ensureDiscovery();
		try {
			await this.#skillRegistry.trust(skillId);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	public async untrustSkill(skillId: string): Promise<ExtensionReloadResult> {
		await this.#ensureDiscovery();
		try {
			await this.#skillRegistry.untrust(skillId);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	public async setSkillProviderEnabled(providerId: string, enabled: boolean, scope: "user" | "workspace"): Promise<ExtensionReloadResult> {
		if (this.#updateSkillsProviderPolicy === undefined) return { status: "failed", retained: this.current(), error: "provider policy writer is unavailable" };
		await this.#ensureDiscovery();
		try {
			await this.#updateSkillsProviderPolicy(providerId, enabled, scope);
		} catch (error) {
			return this.#failed(error);
		}
		return this.reload();
	}

	async #ensureDiscovery(): Promise<void> {
		if (this.#pluginManager.last() === undefined) await this.#pluginManager.discover();
	}

	#failed(error: unknown): ExtensionReloadResult {
		return { status: "failed", retained: this.current(), error: error instanceof Error ? error.message : "extension operation failed" };
	}

	async #reloadNow(): Promise<ExtensionReloadResult> {
		if (this.#reloadPromise !== undefined) return this.#reloadPromise;
		this.#reloadPromise = this.#buildAndSwap().finally(() => { this.#reloadPromise = undefined; });
		return this.#reloadPromise;
	}

	async #buildAndSwap(): Promise<ExtensionReloadResult> {
		try {
			const discovered: PluginDiscoveryResult = await this.#pluginManager.discover();
			const skillPolicy = this.#skillsPolicyLoader === undefined ? undefined : await this.#skillsPolicyLoader();
			const skillSnapshot = await this.#skillRegistry.load({
				...(skillPolicy === undefined ? {} : { providerEnabled: skillPolicy.providerEnabled, masterEnabled: skillPolicy.masterEnabled }),
			});
			const current = this.current();
			const generation = (current?.generation ?? 0) + 1;
			const snapshot = buildExtensionSnapshot({
				snapshotId: createRuntimeId("snapshot", `extensions-${generation}`),
				generation,
				createdAt: this.#now().toISOString(),
				descriptors: mergeExtensionDescriptors(discovered.descriptors, skillSnapshot.all.map((skill) => skill.descriptor)),
				diagnostics: [...discovered.diagnostics, ...skillSnapshot.diagnostics, ...(skillPolicy?.diagnostics ?? [])],
				skillProviders: skillSnapshot.providers.map(projectSkillProvider),
			});
			const swapped = this.#snapshots.swap(snapshot);
			if (!swapped.ok) return { status: "failed", retained: swapped.retained, error: swapped.error, diagnostics: discovered.diagnostics };
			return { status: "ready", snapshot: swapped.snapshot, diagnostics: discovered.diagnostics };
		} catch (error) {
			return this.#failed(error);
		}
	}
}

/** Legacy Host compatibility aliases；Session composition 只使用中性名称。 */
export { ExtensionManager as ExtensionHostManager };
export type ExtensionHostManagerOptions = ExtensionManagerOptions;

export function projectExtensionSnapshot(snapshot: ExtensionSnapshot): ExtensionPublicSnapshot {
	return {
		snapshotId: snapshot.snapshotId,
		generation: snapshot.generation,
		createdAt: snapshot.createdAt,
		counts: snapshot.counts,
		digest: snapshot.digest,
		descriptors: snapshot.descriptors.map((descriptor) => ({
			kind: descriptor.kind,
			identity: descriptor.identity,
			displayName: descriptor.displayName,
			description: descriptor.description,
			pluginId: descriptor.pluginId,
			runtimeName: descriptor.runtimeName,
			priority: descriptor.priority,
			enabled: descriptor.enabled,
			trusted: descriptor.trusted,
			ready: descriptor.ready,
			trust: descriptor.trust,
			activation: descriptor.activation,
			approvalReceiptId: descriptor.approvalReceiptId,
			capabilities: descriptor.capabilities,
			diagnostics: descriptor.diagnostics?.map(({ code, severity, message }) => ({ code, severity, message })),
		})),
		diagnostics: snapshot.diagnostics.map(({ code, severity, message }) => ({ code, severity, message })),
		skillProviders: snapshot.skillProviders,
	};
}
