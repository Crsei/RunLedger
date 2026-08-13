/**
 * 被动 CapabilityRegistry：显式 register/freeze，load 时先按 policy 过滤
 * provider（I/O 前），并发加载后按 rank+id 确定性装配 statuses/diagnostics/
 * observations，再逐 capability 构建快照。
 *
 * 本模块不接 production；ExtensionManager 输出保持不变（P2 才 cutover）。
 */

import { extensionDiagnostic, sortExtensionDiagnostics } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type {
	CapabilityBuildInput,
	CapabilityDefinition,
	CapabilityLoadOptions,
	CapabilityLoadResult,
	CapabilityRegisterResult,
	DiscoveryProvider,
	DiscoveryProviderResult,
	ProviderLoadState,
	ProviderStatus,
} from "./types.ts";

type ProviderOutcome =
	| { readonly kind: "aborted" }
	| { readonly kind: "disabled" }
	| { readonly kind: "threw"; readonly error: unknown }
	| { readonly kind: "result"; readonly result: DiscoveryProviderResult<unknown> };

function compareProviders(left: DiscoveryProvider<unknown>, right: DiscoveryProvider<unknown>): number {
	return left.rank - right.rank || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function statusOf(provider: DiscoveryProvider<unknown>, state: ProviderLoadState, effectiveEnabled: boolean, extra: Partial<Pick<ProviderStatus, "observationCount" | "diagnosticCount" | "lastError">> = {}): ProviderStatus {
	return {
		providerId: provider.id,
		displayName: provider.displayName,
		capabilityId: provider.capabilityId,
		rank: provider.rank,
		defaultEnabled: provider.defaultEnabled,
		effectiveEnabled,
		state,
		observationCount: extra.observationCount ?? 0,
		diagnosticCount: extra.diagnosticCount ?? 0,
		...(extra.lastError === undefined ? {} : { lastError: extra.lastError }),
	};
}

export class CapabilityRegistry {
	readonly #capabilities = new Map<string, CapabilityDefinition<unknown, unknown>>();
	readonly #providers = new Map<string, DiscoveryProvider<unknown>>();
	#frozen = false;

	public registerCapability<TObservation, TSnapshot>(definition: CapabilityDefinition<TObservation, TSnapshot>): CapabilityRegisterResult {
		if (this.#frozen) return { ok: false, error: { code: "frozen", message: "registry is frozen" } };
		if (this.#capabilities.has(definition.id)) return { ok: false, error: { code: "duplicate_capability", capabilityId: definition.id } };
		this.#capabilities.set(definition.id, definition as CapabilityDefinition<unknown, unknown>);
		return { ok: true };
	}

	public registerProvider<TObservation>(provider: DiscoveryProvider<TObservation>): CapabilityRegisterResult {
		if (this.#frozen) return { ok: false, error: { code: "frozen", message: "registry is frozen" } };
		if (this.#providers.has(provider.id)) return { ok: false, error: { code: "duplicate_provider", providerId: provider.id, capabilityId: provider.capabilityId } };
		if (!this.#capabilities.has(provider.capabilityId)) return { ok: false, error: { code: "unknown_capability", providerId: provider.id, capabilityId: provider.capabilityId } };
		this.#providers.set(provider.id, provider as DiscoveryProvider<unknown>);
		return { ok: true };
	}

	public freeze(): CapabilityRegisterResult {
		if (this.#frozen) return { ok: false, error: { code: "frozen", message: "registry is already frozen" } };
		this.#frozen = true;
		return { ok: true };
	}

	public isFrozen(): boolean {
		return this.#frozen;
	}

	public capabilities(): readonly string[] {
		return [...this.#capabilities.keys()].sort();
	}

	public providers(): readonly DiscoveryProvider<unknown>[] {
		return [...this.#providers.values()].sort(compareProviders);
	}

	public async load(options: CapabilityLoadOptions = {}): Promise<CapabilityLoadResult> {
		const signal = options.signal;
		const providerEnabled = options.providerEnabled;
		const providers = this.providers();
		const dispatched: { readonly provider: DiscoveryProvider<unknown>; readonly effectiveEnabled: boolean; readonly work: Promise<ProviderOutcome> }[] = [];
		for (const provider of providers) {
			const effectiveEnabled = providerEnabled?.get(provider.id) ?? provider.defaultEnabled;
			if (signal !== undefined && signal.aborted) {
				dispatched.push({ provider, effectiveEnabled, work: Promise.resolve({ kind: "aborted" as const }) });
				continue;
			}
			if (!effectiveEnabled) {
				dispatched.push({ provider, effectiveEnabled, work: Promise.resolve({ kind: "disabled" as const }) });
				continue;
			}
			dispatched.push({
				provider,
				effectiveEnabled,
				work: provider.load({ signal, ...(options.storage === undefined ? {} : { storage: options.storage }), ...(options.inputs === undefined ? {} : { inputs: options.inputs }) }).then(
					(result): ProviderOutcome => ({ kind: "result", result }),
					(error): ProviderOutcome => ({ kind: "threw", error }),
				),
			});
		}
		const outcomes = await Promise.all(dispatched.map((entry) => entry.work));

		const statuses: ProviderStatus[] = [];
		const observationsByCapability = new Map<string, unknown[]>();
		// capabilityId -> [{ provider, diagnostics }]，按 provider rank+id 顺序。
		const diagnosticGroups = new Map<string, { readonly provider: DiscoveryProvider<unknown>; readonly diagnostics: ExtensionDiagnostic[] }[]>();
		const pushDiagnostic = (capabilityId: string, provider: DiscoveryProvider<unknown>, diagnostic: ExtensionDiagnostic): void => {
			const groups = diagnosticGroups.get(capabilityId) ?? [];
			const group = groups.find((item) => item.provider.id === provider.id);
			if (group) group.diagnostics.push(diagnostic);
			else {
				const created = { provider, diagnostics: [diagnostic] };
				groups.push(created);
				diagnosticGroups.set(capabilityId, groups);
			}
		};

		for (let index = 0; index < dispatched.length; index += 1) {
			const entry = dispatched[index];
			if (!entry) continue;
			const outcome = outcomes[index];
			const { provider, effectiveEnabled } = entry;
			if (outcome === undefined) continue;
			if (outcome.kind === "aborted") {
				statuses.push(statusOf(provider, "aborted", effectiveEnabled));
				continue;
			}
			if (outcome.kind === "disabled") {
				statuses.push(statusOf(provider, "disabled", effectiveEnabled));
				continue;
			}
			if (outcome.kind === "threw") {
				const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
				pushDiagnostic(provider.capabilityId, provider, extensionDiagnostic("capability.provider_failed", "error", message, provider.id));
				statuses.push(statusOf(provider, "failed", effectiveEnabled, { lastError: message, diagnosticCount: 1 }));
				continue;
			}
			const result = outcome.result;
			if (result.providerId !== provider.id) {
				const message = `provider result identity ${result.providerId} does not match registered provider ${provider.id}`;
				pushDiagnostic(provider.capabilityId, provider, extensionDiagnostic("capability.provider_identity_mismatch", "error", message, provider.id));
				statuses.push(statusOf(provider, "failed", effectiveEnabled, { lastError: message, diagnosticCount: 1 }));
				continue;
			}
			if (!result.ok) {
				const message = result.message;
				pushDiagnostic(provider.capabilityId, provider, extensionDiagnostic(
					`capability.provider_${result.code}`,
					result.code === "unavailable" ? "info" : "error",
					message,
					provider.id,
				));
				statuses.push(statusOf(provider, result.code, effectiveEnabled, { lastError: message, diagnosticCount: 1 }));
				continue;
			}
			const capability = this.#capabilities.get(provider.capabilityId);
			const providerDiagnostics = [...(result.diagnostics ?? [])];
			if (capability) {
				for (const observation of result.observations) {
					providerDiagnostics.push(...capability.validateObservation(observation));
				}
			}
			for (const diagnostic of providerDiagnostics) pushDiagnostic(provider.capabilityId, provider, diagnostic);
			const bucket = observationsByCapability.get(provider.capabilityId) ?? [];
			bucket.push(...result.observations);
			observationsByCapability.set(provider.capabilityId, bucket);
			statuses.push(statusOf(provider, "loaded", effectiveEnabled, { observationCount: result.observations.length, diagnosticCount: providerDiagnostics.length }));
		}

		const snapshots = new Map<string, unknown>();
		const snapshotFailures: ExtensionDiagnostic[] = [];
		for (const capability of [...this.#capabilities.values()].sort((left, right) => left.id.localeCompare(right.id))) {
			const groups = diagnosticGroups.get(capability.id) ?? [];
			const capabilityDiagnostics = groups.flatMap((group) => sortExtensionDiagnostics(group.diagnostics));
			const input: CapabilityBuildInput<unknown> = {
				observations: observationsByCapability.get(capability.id) ?? [],
				providerStatuses: statuses.filter((item) => item.capabilityId === capability.id),
				diagnostics: capabilityDiagnostics,
			};
			try {
				snapshots.set(capability.id, await capability.buildSnapshot(input));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				snapshotFailures.push(extensionDiagnostic("capability.snapshot_failed", "error", message, capability.id));
			}
		}
		const diagnostics = [...snapshotFailures, ...[...diagnosticGroups.values()].flatMap((groups) => groups.flatMap((group) => sortExtensionDiagnostics(group.diagnostics)))];
		return { snapshots, providerStatuses: statuses, diagnostics };
	}
}
