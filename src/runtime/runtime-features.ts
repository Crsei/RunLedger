/** Runtime v3 rollout flags、依赖顺序与 legacy compatibility matrix。 */

export const RUNTIME_FEATURE_NAMES = [
	"sessionV3",
	"workspaceContracts",
	"securityContracts",
	"workspaceGuard",
	"capabilityGateway",
	"sandboxEnforcement",
	"artifactCas",
	"resourceContracts",
	"planContextMemoryContracts",
	"orchestrator",
	"verification",
	"daemon",
] as const;

export type RuntimeFeatureName = (typeof RUNTIME_FEATURE_NAMES)[number];
export type RuntimeFeatureFlags = Record<RuntimeFeatureName, boolean>;

export const DEFAULT_RUNTIME_FEATURES: Readonly<RuntimeFeatureFlags> = {
	sessionV3: false,
	workspaceContracts: false,
	securityContracts: false,
	workspaceGuard: false,
	capabilityGateway: false,
	sandboxEnforcement: false,
	artifactCas: false,
	resourceContracts: false,
	planContextMemoryContracts: false,
	orchestrator: false,
	verification: false,
	daemon: false,
};

export const RUNTIME_FEATURE_DEPENDENCIES: Readonly<Record<RuntimeFeatureName, readonly RuntimeFeatureName[]>> = {
	sessionV3: [],
	workspaceContracts: ["sessionV3"],
	securityContracts: ["workspaceContracts"],
	workspaceGuard: ["workspaceContracts"],
	capabilityGateway: ["securityContracts", "workspaceGuard"],
	sandboxEnforcement: ["capabilityGateway"],
	artifactCas: ["sessionV3", "workspaceContracts", "securityContracts"],
	resourceContracts: ["securityContracts"],
	planContextMemoryContracts: ["artifactCas"],
	orchestrator: ["artifactCas", "resourceContracts", "planContextMemoryContracts"],
	verification: ["orchestrator", "sandboxEnforcement"],
	daemon: ["sessionV3", "orchestrator", "verification"],
};

export function isRuntimeFeatureEnabled(flags: RuntimeFeatureFlags, feature: RuntimeFeatureName): boolean {
	return flags[feature];
}

export function validateRuntimeFeatureFlags(flags: RuntimeFeatureFlags): readonly string[] {
	return RUNTIME_FEATURE_NAMES.flatMap((feature) => {
		if (!flags[feature]) return [];
		const missing = RUNTIME_FEATURE_DEPENDENCIES[feature].filter((dependency) => !flags[dependency]);
		return missing.map((dependency) => `${feature} requires ${dependency}`);
	});
}

export type SessionFormatVersion = 1 | 2 | 3;
export type SessionCompatibilityOperation = "read" | "append" | "migrate_to_v3" | "fork_to_v3" | "downgrade";
export type SessionCompatibilityDecision = "allow" | "legacy_read_only" | "explicit_migration_required" | "deny";

export const SESSION_V3_FEATURE_STATES = ["off", "opt_in", "default", "required"] as const;
export type SessionV3FeatureState = (typeof SESSION_V3_FEATURE_STATES)[number];

export const SESSION_CLI_ACTIONS = [
	"create_default",
	"create_v2",
	"create_v3",
	"inspect",
	"export",
	"read",
	"append",
	"migrate_to_v3",
	"fork_to_v3",
	"downgrade",
] as const;
export type SessionCliAction = (typeof SESSION_CLI_ACTIONS)[number];

export const SESSION_CLI_DIAGNOSTIC_CODES = [
	"allowed",
	"legacy_read_only",
	"v3_disabled",
	"v2_creation_disabled",
	"migration_required",
	"rollback_read_only",
	"downgrade_denied",
	"unsupported_action",
] as const;
export type SessionCliDiagnosticCode = (typeof SESSION_CLI_DIAGNOSTIC_CODES)[number];

export interface SessionCliCompatibilityRequest {
	featureState: SessionV3FeatureState;
	/** 记录进程/项目曾启用到的最高状态，防止普通回滚重新开放旧格式写入。 */
	highestActivatedState?: SessionV3FeatureState;
	sessionVersion: SessionFormatVersion | "new";
	action: SessionCliAction;
}

export interface SessionCliCompatibilityResult {
	allowed: boolean;
	diagnostic: SessionCliDiagnosticCode;
	writeVersion?: 2 | 3;
}

export const SESSION_V3_FEATURE_STATE_RANK: Readonly<Record<SessionV3FeatureState, number>> = {
	off: 0,
	opt_in: 1,
	default: 2,
	required: 3,
};

export interface SessionV3RolloutConfiguration {
	/** 当前请求状态；旧 boolean `true` 等价于既有行为 `default`。 */
	requestedState?: SessionV3FeatureState;
	legacyEnabled?: boolean;
	/** 已持久化的历史最高状态，用于回滚写屏障。 */
	highestActivatedState?: SessionV3FeatureState;
}

export interface ResolvedSessionV3Rollout {
	state: SessionV3FeatureState;
	highestActivatedState: SessionV3FeatureState;
	enabled: boolean;
	requiresHistoryPersistence: boolean;
}

export function isSessionV3FeatureState(value: unknown): value is SessionV3FeatureState {
	return typeof value === "string" && (SESSION_V3_FEATURE_STATES as readonly string[]).includes(value);
}

/**
 * 解析 session v3 rollout，并把旧 boolean 配置映射到不会改变既有行为的状态。
 *
 * 历史 `sessionV3=true` 会让新 session 直接写 v3，因此只能映射为 `default`；
 * 映射成 `opt_in` 会在升级后静默把默认格式退回 v2。
 */
export function resolveSessionV3Rollout(
	configuration: SessionV3RolloutConfiguration,
): ResolvedSessionV3Rollout {
	const state = configuration.requestedState ?? (configuration.legacyEnabled ? "default" : "off");
	const configuredHighest = configuration.highestActivatedState ?? "off";
	const highestActivatedState =
		SESSION_V3_FEATURE_STATE_RANK[state] > SESSION_V3_FEATURE_STATE_RANK[configuredHighest]
			? state
			: configuredHighest;
	return {
		state,
		highestActivatedState,
		enabled: state !== "off",
		requiresHistoryPersistence: highestActivatedState !== configuration.highestActivatedState,
	};
}

function result(
	allowed: boolean,
	diagnostic: SessionCliDiagnosticCode,
	writeVersion?: 2 | 3,
): SessionCliCompatibilityResult {
	return { allowed, diagnostic, ...(writeVersion ? { writeVersion } : {}) };
}

/** §6.1 feature-state × session version × CLI action 的唯一判定入口。 */
export function resolveSessionCliCompatibility(
	request: SessionCliCompatibilityRequest,
): SessionCliCompatibilityResult {
	const highest = request.highestActivatedState ?? request.featureState;
	if (
		SESSION_V3_FEATURE_STATE_RANK[highest] >= SESSION_V3_FEATURE_STATE_RANK.default &&
		SESSION_V3_FEATURE_STATE_RANK[request.featureState] < SESSION_V3_FEATURE_STATE_RANK.default
	) {
		return request.sessionVersion !== "new" && (request.action === "inspect" || request.action === "export")
			? result(true, "rollback_read_only")
			: result(false, "rollback_read_only");
	}
	if (request.action === "downgrade") return result(false, "downgrade_denied");
	if (request.sessionVersion === "new") {
		if (request.action === "create_default") {
			return request.featureState === "off" || request.featureState === "opt_in"
				? result(true, "allowed", 2)
				: result(true, "allowed", 3);
		}
		if (request.action === "create_v2") {
			return request.featureState === "off" || request.featureState === "opt_in"
				? result(true, "allowed", 2)
				: result(false, "v2_creation_disabled");
		}
		if (request.action === "create_v3") {
			return request.featureState === "off"
				? result(false, "v3_disabled")
				: result(true, "allowed", 3);
		}
		return result(false, "unsupported_action");
	}
	if (request.action === "inspect" || request.action === "export") return result(true, "allowed");
	if (request.sessionVersion === 1) {
		if (request.action === "migrate_to_v3" && request.featureState !== "off") return result(true, "migration_required", 3);
		return result(false, request.featureState === "off" ? "v3_disabled" : "legacy_read_only");
	}
	if (request.sessionVersion === 2) {
		if (request.featureState === "off") {
			return request.action === "read" || request.action === "append"
				? result(true, "allowed", request.action === "append" ? 2 : undefined)
				: result(false, "v3_disabled");
		}
		if (request.featureState === "opt_in") {
			if (request.action === "read" || request.action === "append") {
				return result(true, "allowed", request.action === "append" ? 2 : undefined);
			}
			if (request.action === "migrate_to_v3" || request.action === "fork_to_v3") {
				return result(true, "migration_required", 3);
			}
			return result(false, "unsupported_action");
		}
		if (request.action === "migrate_to_v3" || request.action === "fork_to_v3") {
			return result(true, "migration_required", 3);
		}
		return result(false, "migration_required");
	}
	if (request.action === "read" || request.action === "append") {
		return request.featureState === "off"
			? result(false, "v3_disabled")
			: result(true, "allowed", request.action === "append" ? 3 : undefined);
	}
	if (request.action === "fork_to_v3" && request.featureState !== "off") return result(true, "allowed", 3);
	return result(false, request.featureState === "off" ? "v3_disabled" : "unsupported_action");
}

export const SESSION_COMPATIBILITY_MATRIX: Readonly<
	Record<SessionFormatVersion, Readonly<Record<SessionCompatibilityOperation, SessionCompatibilityDecision>>>
> = {
	1: {
		read: "legacy_read_only",
		append: "explicit_migration_required",
		migrate_to_v3: "allow",
		fork_to_v3: "allow",
		downgrade: "deny",
	},
	2: {
		read: "legacy_read_only",
		append: "explicit_migration_required",
		migrate_to_v3: "allow",
		fork_to_v3: "allow",
		downgrade: "deny",
	},
	3: {
		read: "allow",
		append: "allow",
		migrate_to_v3: "deny",
		fork_to_v3: "allow",
		downgrade: "deny",
	},
};

export function sessionCompatibilityDecision(
	version: SessionFormatVersion,
	operation: SessionCompatibilityOperation,
): SessionCompatibilityDecision {
	return SESSION_COMPATIBILITY_MATRIX[version][operation];
}

/**
 * 根据 rollout flag 解析当前真正可执行的 session 操作。
 *
 * `SESSION_COMPATIBILITY_MATRIX` 描述 v3 已启用后的目标状态；关闭 v3 时仍由
 * 既有 v2 ledger 承担写入，且任何会创建或迁移到 v3 的操作都必须失败。
 * 已存在的 v3 session 只允许只读导出，不能在回滚状态下继续 append。
 */
export function resolveSessionCompatibilityDecision(
	flags: Readonly<Pick<RuntimeFeatureFlags, "sessionV3">>,
	version: SessionFormatVersion,
	operation: SessionCompatibilityOperation,
): SessionCompatibilityDecision {
	if (flags.sessionV3) return sessionCompatibilityDecision(version, operation);

	if (operation === "migrate_to_v3" || operation === "fork_to_v3") return "deny";
	if (version === 2 && operation === "append") return "allow";
	if (version === 3 && operation === "read") return "legacy_read_only";
	if (version === 3) return "deny";

	return sessionCompatibilityDecision(version, operation);
}
