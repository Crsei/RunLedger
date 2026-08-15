import { describe, expect, it } from "vitest";
import {
	MULTI_AGENT_HARD_LIMITS,
	resolveMultiAgentPolicy,
	validateBoundedUtf8Text,
	validateSpawnSubagentRequest,
} from "../../../src/runtime/agents/limits.ts";
import type { MultiAgentPolicy, SpawnSubagentInput } from "../../../src/runtime/agents/types.ts";

function enabledPolicy(overrides: Partial<MultiAgentPolicy["limits"]> = {}): MultiAgentPolicy {
	const resolution = resolveMultiAgentPolicy({
		runtimeEnabled: true,
		user: { enabled: true, ...overrides },
	});
	expect(resolution.policy.enabled).toBe(true);
	return resolution.policy;
}

function validRequest(overrides: Partial<SpawnSubagentInput> = {}): SpawnSubagentInput {
	return {
		role: "research",
		objective: "Read the repository entry points and report the relevant files.",
		...overrides,
	};
}

describe("bounded multi-agent policy and request contracts", () => {
	it("is closed by default and a workspace cannot reopen a disabled user policy", () => {
		const defaultResolution = resolveMultiAgentPolicy({ runtimeEnabled: true });
		const workspaceOnlyResolution = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			workspace: { enabled: true },
		});

		expect(defaultResolution.policy.enabled).toBe(false);
		expect(workspaceOnlyResolution.policy.enabled).toBe(false);
		expect(workspaceOnlyResolution.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy" }),
		]);
	});

	it("applies runtime, user, and workspace gates without widening limits", () => {
		const runtimeDisabled = resolveMultiAgentPolicy({
			runtimeEnabled: false,
			user: { enabled: true },
		});
		const workspaceDisabled = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: { enabled: true },
			workspace: { enabled: false },
		});
		const workspaceWidened = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: { enabled: true, maxToolCallsPerAgent: 4 },
			workspace: { enabled: true, maxToolCallsPerAgent: 5 },
		});

		expect(runtimeDisabled.policy.enabled).toBe(false);
		expect(workspaceDisabled.policy.enabled).toBe(false);
		expect(workspaceWidened.policy.enabled).toBe(false);
		expect(workspaceWidened.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "workspace.maxToolCallsPerAgent" }),
		]);
	});

	it("rejects invalid numeric policy values and invalid cross-field limits without clamping", () => {
		const overHardCeiling = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: { enabled: true, maxReportBytes: MULTI_AGENT_HARD_LIMITS.maxReportBytes + 1 },
		});
		const invalidCrossConstraint = resolveMultiAgentPolicy({
			runtimeEnabled: true,
			user: { enabled: true, maxChildrenPerRoot: 3, maxTotalAgents: 2 },
		});

		expect(overHardCeiling.policy.enabled).toBe(false);
		expect(overHardCeiling.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "user.maxReportBytes" }),
		]);
		expect(invalidCrossConstraint.policy.enabled).toBe(false);
		expect(invalidCrossConstraint.diagnostics).toEqual([
			expect.objectContaining({ code: "invalid_policy", path: "user.limits" }),
		]);
	});

	it("narrows a valid request and rejects a widening request", () => {
		const policy = enabledPolicy({ maxModelTurnsPerAgent: 5, maxToolCallsPerAgent: 7, maxReportBytes: 128 });
		const narrowed = validateSpawnSubagentRequest(
			{
				...validRequest(),
				requestedCapabilities: ["workspace.search", "workspace.search", "workspace.read"],
				budget: { maxModelTurns: 2, maxToolCalls: 3, maxActiveDurationMs: 1000 },
				output: { kind: "report", maxBytes: 64 },
			},
			policy,
		);
		const widened = validateSpawnSubagentRequest(
			{ ...validRequest(), budget: { maxToolCalls: policy.limits.maxToolCallsPerAgent + 1 } },
			policy,
		);

		expect(narrowed).toMatchObject({
			ok: true,
			value: {
				requestedCapabilities: ["workspace.search", "workspace.read"],
				budget: { maxModelTurns: 2, maxToolCalls: 3, maxActiveDurationMs: 1000 },
				output: { kind: "report", maxBytes: 64 },
			},
		});
		expect(widened).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
	});

	it("rejects authority fields, unknown capabilities, and malformed requests", () => {
		const policy = enabledPolicy();
		const authorityField = validateSpawnSubagentRequest(
			{ ...validRequest(), sessionId: "session_forbidden" },
			policy,
		);
		const unknownCapability = validateSpawnSubagentRequest(
			{ ...validRequest(), requestedCapabilities: ["workspace.write"] },
			policy,
		);
		const blankObjective = validateSpawnSubagentRequest({ ...validRequest(), objective: " \n\t" }, policy);

		expect(authorityField).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(unknownCapability).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(blankObjective).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("uses UTF-8 bytes, not JavaScript character count, for objective and report bounds", () => {
		const within = validateBoundedUtf8Text("目标", { field: "objective", minBytes: 1, maxBytes: 6 });
		const over = validateBoundedUtf8Text("目标", { field: "report", minBytes: 1, maxBytes: 5 });

		expect(within).toMatchObject({ ok: true, value: { value: "目标", bytes: 6 } });
		expect(over).toMatchObject({ ok: false, error: { code: "limit_exceeded", path: "report" } });
	});

	it("exposes the complete structured error vocabulary", () => {
		const policy = enabledPolicy();
		expect(validateSpawnSubagentRequest({ ...validRequest(), output: { kind: "report", maxBytes: 0 } }, policy)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		const codes = new Set([
			"invalid_policy",
			"invalid_request",
			"limit_exceeded",
			"idempotency_conflict",
			"unsupported_feature",
			"recovery_required",
			"store_conflict",
			"runtime_unavailable",
		]);
		expect(codes.size).toBe(8);
	});
});
