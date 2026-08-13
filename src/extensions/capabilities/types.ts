/** 被动 capability/provider 合同：registry 只注册与编排，不读盘、不持久化、不执行资源。 */

import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";

export interface CapabilityDefinition<TObservation, TSnapshot> {
	readonly id: string;
	readonly displayName: string;
	readonly validateObservation: (value: TObservation) => readonly ExtensionDiagnostic[];
	readonly buildSnapshot: (input: CapabilityBuildInput<TObservation>) => Promise<TSnapshot>;
}

export interface CapabilityBuildInput<TObservation> {
	readonly observations: readonly TObservation[];
	readonly providerStatuses: readonly ProviderStatus[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export interface DiscoveryContext {
	readonly signal?: AbortSignal;
	/** 注入的 storage adapter：provider 只用来 stat/realpath 候选 root，不做扫描。 */
	readonly storage?: ExtensionStoragePort;
}

/** provider result 必须携带自身 ID；registry 校验它等于已注册的 provider，不信任 provider 自报。 */
export type DiscoveryProviderResult<TObservation> =
	| { readonly ok: true; readonly providerId: string; readonly observations: readonly TObservation[]; readonly diagnostics?: readonly ExtensionDiagnostic[] }
	| { readonly ok: false; readonly providerId: string; readonly code: "unavailable" | "failed" | "aborted"; readonly message: string; readonly diagnostics?: readonly ExtensionDiagnostic[] };

export interface DiscoveryProvider<TObservation> {
	readonly id: string;
	readonly displayName: string;
	readonly capabilityId: string;
	readonly rank: number;
	readonly defaultEnabled: boolean;
	load(context: DiscoveryContext): Promise<DiscoveryProviderResult<TObservation>>;
}

export type ProviderLoadState = "disabled" | "unavailable" | "loaded" | "failed" | "aborted";

export interface ProviderStatus {
	readonly providerId: string;
	readonly displayName: string;
	readonly capabilityId: string;
	readonly rank: number;
	readonly defaultEnabled: boolean;
	readonly effectiveEnabled: boolean;
	readonly state: ProviderLoadState;
	readonly observationCount: number;
	readonly diagnosticCount: number;
	readonly lastError?: string;
}

export type CapabilityRegisterError =
	| { readonly code: "duplicate_capability"; readonly capabilityId: string }
	| { readonly code: "duplicate_provider"; readonly providerId: string; readonly capabilityId: string }
	| { readonly code: "unknown_capability"; readonly providerId: string; readonly capabilityId: string }
	| { readonly code: "frozen"; readonly message: string };

export type CapabilityRegisterResult = { readonly ok: true } | { readonly ok: false; readonly error: CapabilityRegisterError };

export interface CapabilityLoadOptions {
	/** 已合并的 provider 有效开关（user/workspace/session policy）；缺省用 provider.defaultEnabled。 */
	readonly providerEnabled?: ReadonlyMap<string, boolean>;
	readonly signal?: AbortSignal;
	/** 注入 provider DiscoveryContext 的 storage adapter（provider 只 stat 候选 root）。 */
	readonly storage?: ExtensionStoragePort;
}

export interface CapabilityLoadResult {
	/** capabilityId -> 该 capability 的 buildSnapshot 输出。 */
	readonly snapshots: ReadonlyMap<string, unknown>;
	readonly providerStatuses: readonly ProviderStatus[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}
