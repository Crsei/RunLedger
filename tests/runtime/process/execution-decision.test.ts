import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	createBuiltinNoneExecutionDecisionProviders,
	createExecutionConstraintReceipt,
	evaluateExecutionConstraints,
	type ExecutionConstraintInput,
	type ExecutionConstraintProviders,
} from "../../../src/runtime/process/execution-decision.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function input(): ExecutionConstraintInput {
	return {
		authorityId: createRuntimeId("authority", "decision"),
		tenantId: createRuntimeId("tenant", "decision"),
		workspaceId: createRuntimeId("workspace", "decision"),
		principalId: createRuntimeId("principal", "decision"),
		executionId: createRuntimeId("execution", "decision"),
		attemptId: createRuntimeId("attempt", "decision"),
		commandId: createRuntimeId("command", "decision"),
		requestDigest: digest("a"),
		policyDigest: digest("b"),
		modes: {
			permission: "none",
			approval: "none",
			sandbox: "none",
			gateway: "none",
			containment: "none",
		},
	};
}

describe("R6 execution decision barrier", () => {
	it("accepts five explicit none decisions and never claims zero-member containment", async () => {
		const result = await evaluateExecutionConstraints(input(), createBuiltinNoneExecutionDecisionProviders());

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.snapshot.permission.decision).toBe("allow");
		expect(result.snapshot.approval.decision).toBe("not_required");
		expect(result.snapshot.sandbox.enforcement).toBe("off");
		expect(result.snapshot.gateway.route).toBe("direct_local");
		expect(result.snapshot.containment.settlement).toBe("not_requested");
		expect(result.snapshot.containment.settlement).not.toBe("zero_members");
		expect(result.snapshot.snapshotDigest.algorithm).toBe("sha256");
	});

	it("rejects a missing provider or incomplete receipt before a spawn can happen", async () => {
		const providers = createBuiltinNoneExecutionDecisionProviders();
		const missing: ExecutionConstraintProviders = { ...providers, sandbox: undefined };

		expect(await evaluateExecutionConstraints({
			...input(),
			modes: { ...input().modes, sandbox: "profile" },
		}, missing)).toEqual({ ok: false, code: "constraint_provider_unavailable", dimension: "sandbox" });

		const incomplete = {
			...providers,
			gateway: {
				decide: async () => ({
					dimension: "gateway" as const,
					mode: "mediated" as const,
					decision: "allow" as const,
					providerId: "test.gateway",
					providerRevision: 1,
					policyDigest: digest("b"),
					invocationDigest: digest("a"),
					route: "mediated" as const,
				}),
			},
		};
		expect(await evaluateExecutionConstraints({
			...input(),
			modes: { ...input().modes, gateway: "mediated" },
		}, incomplete)).toEqual({ ok: false, code: "constraint_receipt_invalid", dimension: "gateway" });
	});

	it("fails closed for explicit deny and unavailable strong constraints", async () => {
		const providers = createBuiltinNoneExecutionDecisionProviders();
		const deny: ExecutionConstraintProviders = {
			...providers,
			permission: {
				decide: async (request) => createExecutionConstraintReceipt({
					dimension: "permission",
					mode: request.modes.permission,
					decision: "deny",
					providerId: "test.permission",
					providerRevision: 1,
					policyDigest: request.policyDigest,
					invocationDigest: request.requestDigest,
				}),
			},
		};
		expect(await evaluateExecutionConstraints(input(), deny)).toEqual({
			ok: false,
			code: "constraint_denied",
			dimension: "permission",
		});

		expect(await evaluateExecutionConstraints({
			...input(),
			modes: { ...input().modes, containment: "supervisor" },
		}, providers)).toEqual({
			ok: false,
			code: "constraint_provider_unavailable",
			dimension: "containment",
		});
	});

	it("rejects tampered receipts rather than converting them to none", async () => {
		const providers = createBuiltinNoneExecutionDecisionProviders();
		const tampered: ExecutionConstraintProviders = {
			...providers,
			permission: {
				decide: async (request) => ({
					dimension: "permission",
					mode: request.modes.permission,
					decision: "allow",
					providerId: "test.permission",
					providerRevision: 1,
					policyDigest: request.policyDigest,
					invocationDigest: request.requestDigest,
					receiptDigest: digest("wrong"),
				}),
			},
		};

		expect(await evaluateExecutionConstraints(input(), tampered)).toEqual({
			ok: false,
			code: "constraint_receipt_invalid",
			dimension: "permission",
		});
	});

	it("does not accept a none/off/direct-local receipt for a selected restrictive mode", async () => {
		const providers = createBuiltinNoneExecutionDecisionProviders();
		const base = input();
		const restrictive = {
			...base,
			modes: {
				permission: "policy" as const,
				approval: "required" as const,
				sandbox: "profile" as const,
				gateway: "mediated" as const,
				containment: "process_group" as const,
			},
		};
		const wrongMode: ExecutionConstraintProviders = {
			permission: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "permission", mode: request.modes.permission, decision: "not_required",
				providerId: "test.permission", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			approval: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "approval", mode: request.modes.approval, decision: "not_required",
				providerId: "test.approval", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			sandbox: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "sandbox", mode: request.modes.sandbox, decision: "not_required", enforcement: "off",
				providerId: "test.sandbox", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			gateway: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "gateway", mode: request.modes.gateway, decision: "allow", route: "direct_local",
				providerId: "test.gateway", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			containment: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "containment", mode: request.modes.containment, decision: "not_required", settlement: "not_requested",
				providerId: "test.containment", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
		};
		const validStrong: ExecutionConstraintProviders = {
			permission: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "permission", mode: request.modes.permission, decision: "allow",
				providerId: "test.permission", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			approval: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "approval", mode: request.modes.approval, decision: "allow",
				providerId: "test.approval", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			sandbox: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "sandbox", mode: request.modes.sandbox, decision: "allow", enforcement: "enforced",
				providerId: "test.sandbox", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			gateway: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "gateway", mode: request.modes.gateway, decision: "allow", route: "mediated",
				providerId: "test.gateway", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
			containment: { decide: async (request) => createExecutionConstraintReceipt({
				dimension: "containment", mode: request.modes.containment, decision: "allow", settlement: "unknown",
				providerId: "test.containment", providerRevision: 1,
				policyDigest: request.policyDigest, invocationDigest: request.requestDigest,
			}) },
		};
		for (const dimension of ["permission", "approval", "sandbox", "gateway", "containment"] as const) {
			const result = await evaluateExecutionConstraints(restrictive, {
				...validStrong,
				[dimension]: wrongMode[dimension],
			});
			expect(result).toMatchObject({ ok: false, code: "constraint_receipt_invalid", dimension });
		}
	});
});
