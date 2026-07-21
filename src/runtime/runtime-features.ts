/**
 * Runtime v3 功能门默认值。
 *
 * TODO(runtime-phase-0): 把 feature flag 的持久化、managed 上限和 rollout receipt
 * 接入配置/事件系统。所有新副作用能力在对应 contract 与实现验收前保持关闭。
 */

export interface RuntimeFeatureFlags {
	sessionV3: boolean;
	workspaceContracts: boolean;
	securityContracts: boolean;
	resourceContracts: boolean;
	planContextMemoryContracts: boolean;
}

export const DEFAULT_RUNTIME_FEATURES: Readonly<RuntimeFeatureFlags> = {
	sessionV3: false,
	workspaceContracts: false,
	securityContracts: false,
	resourceContracts: false,
	planContextMemoryContracts: false,
};

export function isRuntimeFeatureEnabled(
	flags: RuntimeFeatureFlags,
	feature: keyof RuntimeFeatureFlags,
): boolean {
	return flags[feature];
}
