import {
	SUBAGENT_CAPABILITIES,
	SUBAGENT_ROLES,
	type MultiAgentDiagnostic,
	type MultiAgentError,
	type MultiAgentLimits,
	type MultiAgentPolicy,
	type MultiAgentPolicyReceipt,
	type MultiAgentPolicyResolution,
	type MultiAgentResult,
	type MultiAgentSettingsSource,
	type SubagentCapability,
	type SubagentRole,
	type Utf8TextValue,
	type ValidatedSpawnSubagentInput,
} from "./types.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import type { TaskPolicyProjection } from "../../storage/settings-policies.ts";

export const MULTI_AGENT_HARD_LIMITS: Readonly<MultiAgentLimits> = Object.freeze({
	maxChildrenPerRoot: 3,
	maxTotalAgents: 4,
	maxModelTurnsPerAgent: 12,
	maxToolCallsPerAgent: 32,
	maxActiveDurationMsPerAgent: 300_000,
	maxReportBytes: 65_536,
});

export const MAX_OBJECTIVE_BYTES = 16 * 1024;
export const MAX_REQUESTED_CAPABILITIES = 8;
export const MAX_DIAGNOSTIC_BYTES = 1024;
export const MULTI_AGENT_RESOLVER_VERSION = "m1.0";

const LIMIT_KEYS = [
	"maxChildrenPerRoot",
	"maxTotalAgents",
	"maxModelTurnsPerAgent",
	"maxToolCallsPerAgent",
	"maxActiveDurationMsPerAgent",
	"maxReportBytes",
] as const satisfies readonly (keyof MultiAgentLimits)[];

type LimitKey = (typeof LIMIT_KEYS)[number];

export interface ResolveMultiAgentPolicyInput {
	readonly runtimeEnabled: boolean;
	readonly user?: unknown;
	readonly workspace?: unknown;
}

export interface Utf8TextBounds {
	readonly field: string;
	readonly minBytes: number;
	readonly maxBytes: number;
	readonly rejectWhitespaceOnly?: boolean;
}

export interface MultiAgentSettingsSourceValidation {
	readonly value?: MultiAgentSettingsSource;
	readonly diagnostics: readonly MultiAgentDiagnostic[];
}

export interface BuildMultiAgentPolicyReceiptInput {
	readonly runtimeEnabled: boolean;
	readonly userSourceDigest: RuntimeDigest;
	readonly workspaceSourceDigest: RuntimeDigest;
	readonly resolution: MultiAgentPolicyResolution;
}

export function resolveMultiAgentPolicy(input: ResolveMultiAgentPolicyInput): MultiAgentPolicyResolution {
	const diagnostics: MultiAgentDiagnostic[] = [];
	const userValidation = validateMultiAgentSettingsSource(input.user, "user");
	const workspaceValidation = validateMultiAgentSettingsSource(input.workspace, "workspace");
	diagnostics.push(...userValidation.diagnostics, ...workspaceValidation.diagnostics);
	const userParsed = userValidation.value;
	const workspaceParsed = workspaceValidation.value;
	let effectiveLimits: MultiAgentLimits = { ...MULTI_AGENT_HARD_LIMITS };

	if (userParsed !== undefined) {
		effectiveLimits = applyLimitOverrides(effectiveLimits, userParsed);
		validateCrossConstraint(effectiveLimits, "user", diagnostics);
	}

	if (workspaceParsed !== undefined) {
		for (const key of LIMIT_KEYS) {
			const requested = workspaceParsed[key];
			if (requested === undefined) continue;
			if (userParsed !== undefined && requested > effectiveLimits[key]) {
				diagnostics.push({
					code: "invalid_policy",
					path: `workspace.${key}`,
					message: `workspace value for ${key} widens the user effective limit`,
				});
				continue;
			}
			effectiveLimits = { ...effectiveLimits, [key]: requested };
		}
		validateCrossConstraint(effectiveLimits, "workspace", diagnostics);
	}

	const userEnabled = userParsed?.enabled === true;
	const workspaceDisabled = workspaceParsed?.enabled === false;
	if (workspaceParsed?.enabled === true && !userEnabled) {
		diagnostics.push({
			code: "invalid_policy",
			path: "workspace.enabled",
			message: "workspace settings cannot enable multi-agent when user settings are disabled",
		});
	}

	const policy: MultiAgentPolicy = Object.freeze({
		enabled: input.runtimeEnabled && userEnabled && !workspaceDisabled && diagnostics.length === 0,
		limits: Object.freeze({ ...effectiveLimits }),
	});
	return Object.freeze({
		policy,
		diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
	});
}

/**
 * Intersect the generic task settings with the current M1 bounded runtime.
 * M1 still fixes direct-root depth and one active child; task settings must
 * never widen those invariants. Only limits already represented by the child
 * runtime are projected here.
 */
export function applyTaskPolicyNarrowing(
	policy: MultiAgentPolicy,
	taskPolicy?: TaskPolicyProjection,
): MultiAgentPolicy {
	if (taskPolicy === undefined) return policy;
	const maxModelTurnsPerAgent = taskPolicy.softRequestBudget === undefined || taskPolicy.softRequestBudget <= 0
		? policy.limits.maxModelTurnsPerAgent
		: Math.min(policy.limits.maxModelTurnsPerAgent, taskPolicy.softRequestBudget);
	const maxActiveDurationMsPerAgent = taskPolicy.maxRuntimeMs === undefined || taskPolicy.maxRuntimeMs <= 0
		? policy.limits.maxActiveDurationMsPerAgent
		: Math.min(policy.limits.maxActiveDurationMsPerAgent, taskPolicy.maxRuntimeMs);
	const disabledAgents = taskPolicy.disabledAgents === undefined
		? policy.disabledAgents
		: Object.freeze([...taskPolicy.disabledAgents]);
	return Object.freeze({
		...policy,
		limits: Object.freeze({
			...policy.limits,
			maxModelTurnsPerAgent,
			maxActiveDurationMsPerAgent,
		}),
		...(disabledAgents === undefined ? {} : { disabledAgents }),
	});
}

export function validateMultiAgentSettingsSource(
	value: unknown,
	path: string,
): MultiAgentSettingsSourceValidation {
	const diagnostics: MultiAgentDiagnostic[] = [];
	const parsed = parseSettingsSource(value, path, diagnostics);
	return Object.freeze({
		...(parsed === undefined ? {} : { value: Object.freeze({ ...parsed }) }),
		diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
	});
}

export function buildMultiAgentPolicyReceipt(
	input: BuildMultiAgentPolicyReceiptInput,
): MultiAgentPolicyReceipt {
	const body = {
		runtimeEnabled: input.runtimeEnabled,
		userSourceDigest: input.userSourceDigest,
		workspaceSourceDigest: input.workspaceSourceDigest,
		effectiveLimits: Object.freeze({ ...input.resolution.policy.limits }),
		diagnostics: Object.freeze(input.resolution.diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
		resolverVersion: MULTI_AGENT_RESOLVER_VERSION,
	};
	return Object.freeze({
		...body,
		receiptDigest: runtimeDigest(body),
	});
}

export function validateSpawnSubagentRequest(
	input: unknown,
	policy: MultiAgentPolicy,
): MultiAgentResult<ValidatedSpawnSubagentInput> {
	if (!policy.enabled) {
		return failure("unsupported_feature", "multi-agent delegation is disabled");
	}
	if (!isRecord(input)) return failure("invalid_request", "spawn_agent input must be an object");

	const allowedKeys = new Set(["role", "objective", "requestedCapabilities", "budget", "output"]);
	for (const key of Object.keys(input)) {
		if (!allowedKeys.has(key)) return failure("invalid_request", `unknown spawn_agent field: ${key}`, key);
	}

	const role = input.role;
	if (!isSubagentRole(role)) return failure("invalid_request", "role is not a supported subagent role", "role");
	if (policy.disabledAgents?.includes(role) === true) {
		return failure("unsupported_feature", "the requested agent role is disabled by task settings", "role");
	}
	const objective = validateBoundedUtf8Text(input.objective, {
		field: "objective",
		minBytes: 1,
		maxBytes: MAX_OBJECTIVE_BYTES,
		rejectWhitespaceOnly: true,
	});
	if (!objective.ok) return objective;

	const capabilities = validateCapabilities(input.requestedCapabilities);
	if (!capabilities.ok) return capabilities;
	const budget = validateBudget(input.budget, policy.limits);
	if (!budget.ok) return budget;
	const output = validateOutput(input.output, policy.limits.maxReportBytes);
	if (!output.ok) return output;

	return {
		ok: true,
		value: Object.freeze({
			role,
			objective: objective.value.value,
			requestedCapabilities: Object.freeze(capabilities.value),
			budget: Object.freeze(budget.value),
			output: Object.freeze(output.value),
		}),
	};
}

export function validateBoundedUtf8Text(
	value: unknown,
	bounds: Utf8TextBounds,
): MultiAgentResult<Utf8TextValue> {
	if (typeof value !== "string" || !isWellFormedUtf16(value)) {
		return failure("invalid_request", `${bounds.field} must be a valid string`, bounds.field);
	}
	if (bounds.rejectWhitespaceOnly === true && value.trim().length === 0) {
		return failure("invalid_request", `${bounds.field} must not be whitespace-only`, bounds.field);
	}
	const bytes = new TextEncoder().encode(value).byteLength;
	if (bytes < bounds.minBytes || bytes > bounds.maxBytes) {
		return failure("limit_exceeded", `${bounds.field} must contain ${bounds.minBytes}-${bounds.maxBytes} UTF-8 bytes`, bounds.field);
	}
	return { ok: true, value: Object.freeze({ value, bytes }) };
}

function parseSettingsSource(
	value: unknown,
	path: string,
	diagnostics: MultiAgentDiagnostic[],
): MultiAgentSettingsSource | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		diagnostics.push({ code: "invalid_policy", path, message: `${path} multi-agent settings must be an object` });
		return undefined;
	}

	const allowedKeys = new Set<string>(["enabled", ...LIMIT_KEYS]);
	let invalid = false;
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) {
			diagnostics.push({ code: "invalid_policy", path: `${path}.${key}`, message: `unknown multi-agent setting: ${key}` });
			invalid = true;
		}
	}
	if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
		diagnostics.push({ code: "invalid_policy", path: `${path}.enabled`, message: "enabled must be boolean" });
		invalid = true;
	}

	const parsed: Record<string, unknown> = {};
	if (typeof value.enabled === "boolean") parsed.enabled = value.enabled;
	for (const key of LIMIT_KEYS) {
		if (!Object.hasOwn(value, key)) continue;
		const candidate = value[key];
		if (!isPositiveSafeInteger(candidate)) {
			diagnostics.push({ code: "invalid_policy", path: `${path}.${key}`, message: `${key} must be a positive safe integer` });
			invalid = true;
			continue;
		}
		if (candidate > MULTI_AGENT_HARD_LIMITS[key]) {
			diagnostics.push({ code: "invalid_policy", path: `${path}.${key}`, message: `${key} exceeds the runtime hard ceiling` });
			invalid = true;
			continue;
		}
		parsed[key] = candidate;
	}
	if (invalid) return undefined;
	return parsed as MultiAgentSettingsSource;
}

function applyLimitOverrides(
	base: MultiAgentLimits,
	source: MultiAgentSettingsSource,
): MultiAgentLimits {
	const next: MultiAgentLimits = { ...base };
	for (const key of LIMIT_KEYS) {
		const value = source[key];
		if (value !== undefined) (next as Record<LimitKey, number>)[key] = value;
	}
	return next;
}

function validateCrossConstraint(
	limits: MultiAgentLimits,
	path: "user" | "workspace",
	diagnostics: MultiAgentDiagnostic[],
): void {
	if (limits.maxTotalAgents < 2 || limits.maxChildrenPerRoot > limits.maxTotalAgents - 1) {
		diagnostics.push({
			code: "invalid_policy",
			path: `${path}.limits`,
			message: "maxTotalAgents must be at least 2 and maxChildrenPerRoot must fit below it",
		});
	}
}

function validateCapabilities(value: unknown): MultiAgentResult<readonly SubagentCapability[]> {
	if (value === undefined) return { ok: true, value: Object.freeze([]) };
	if (!Array.isArray(value)) return failure("invalid_request", "requestedCapabilities must be an array", "requestedCapabilities");
	if (value.length > MAX_REQUESTED_CAPABILITIES) {
		return failure("limit_exceeded", `requestedCapabilities may contain at most ${MAX_REQUESTED_CAPABILITIES} items`, "requestedCapabilities");
	}
	const result: SubagentCapability[] = [];
	for (const item of value) {
		if (!isSubagentCapability(item)) return failure("invalid_request", `unsupported capability: ${String(item)}`, "requestedCapabilities");
		if (!result.includes(item)) result.push(item);
	}
	return { ok: true, value: Object.freeze(result) };
}

function validateBudget(
	value: unknown,
	limits: MultiAgentLimits,
): MultiAgentResult<ValidatedSpawnSubagentInput["budget"]> {
	if (value === undefined) {
		return {
			ok: true,
			value: {
				maxModelTurns: limits.maxModelTurnsPerAgent,
				maxToolCalls: limits.maxToolCallsPerAgent,
				maxActiveDurationMs: limits.maxActiveDurationMsPerAgent,
			},
		};
	}
	if (!isRecord(value)) return failure("invalid_request", "budget must be an object", "budget");
	const allowedKeys = new Set(["maxModelTurns", "maxToolCalls", "maxActiveDurationMs"]);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key)) return failure("invalid_request", `unknown budget field: ${key}`, `budget.${key}`);
	}
	const maxModelTurns = validateBudgetNumber(value.maxModelTurns, limits.maxModelTurnsPerAgent, "budget.maxModelTurns");
	if (!maxModelTurns.ok) return maxModelTurns;
	const maxToolCalls = validateBudgetNumber(value.maxToolCalls, limits.maxToolCallsPerAgent, "budget.maxToolCalls");
	if (!maxToolCalls.ok) return maxToolCalls;
	const maxActiveDurationMs = validateBudgetNumber(value.maxActiveDurationMs, limits.maxActiveDurationMsPerAgent, "budget.maxActiveDurationMs");
	if (!maxActiveDurationMs.ok) return maxActiveDurationMs;
	return {
		ok: true,
		value: {
			maxModelTurns: maxModelTurns.value,
			maxToolCalls: maxToolCalls.value,
			maxActiveDurationMs: maxActiveDurationMs.value,
		},
	};
}

function validateBudgetNumber(value: unknown, ceiling: number, path: string): MultiAgentResult<number> {
	if (value === undefined) return { ok: true, value: ceiling };
	if (!isPositiveSafeInteger(value)) return failure("invalid_request", "budget must use positive safe integers", path);
	if (value > ceiling) return failure("limit_exceeded", "request budget cannot widen the effective policy", path);
	return { ok: true, value };
}

function validateOutput(
	value: unknown,
	maxReportBytes: number,
): MultiAgentResult<ValidatedSpawnSubagentInput["output"]> {
	if (value === undefined) return { ok: true, value: { kind: "report", maxBytes: maxReportBytes } };
	if (!isRecord(value)) return failure("invalid_request", "output must be an object", "output");
	for (const key of Object.keys(value)) {
		if (key !== "kind" && key !== "maxBytes") return failure("invalid_request", `unknown output field: ${key}`, `output.${key}`);
	}
	if (value.kind !== "report") return failure("invalid_request", "output.kind must be report", "output.kind");
	const maxBytes = value.maxBytes === undefined ? maxReportBytes : value.maxBytes;
	if (!isPositiveSafeInteger(maxBytes)) return failure("invalid_request", "output.maxBytes must be a positive safe integer", "output.maxBytes");
	if (maxBytes > maxReportBytes) return failure("limit_exceeded", "output.maxBytes cannot widen the effective report limit", "output.maxBytes");
	return { ok: true, value: { kind: "report", maxBytes } };
}

function failure<T>(code: MultiAgentError["code"], message: string, path?: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message, ...(path === undefined ? {} : { path }) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSubagentRole(value: unknown): value is SubagentRole {
	return typeof value === "string" && (SUBAGENT_ROLES as readonly string[]).includes(value);
}

function isSubagentCapability(value: unknown): value is SubagentCapability {
	return typeof value === "string" && (SUBAGENT_CAPABILITIES as readonly string[]).includes(value);
}

function isWellFormedUtf16(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}
