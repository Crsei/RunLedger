import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type { AgentSupervisorPorts, AgentWorkspaceReceiptRef } from "../../../src/runtime/agents/types.ts";
import { GatewayBoundCapabilitySubsetEvaluator } from "../../../src/runtime/agents/integration/capability-subset.ts";
import { ProductionChildSessionLauncher } from "../../../src/runtime/agents/integration/child-session-launcher.ts";
import {
	createProductionAgentSupervisorComposition,
	type ProductionAgentSupervisorCompositionOptions,
} from "../../../src/runtime/agents/integration/production-composition.ts";
import { ProductionAgentWorkspaceAdapter } from "../../../src/runtime/agents/integration/worktree-workspace.ts";
import type { SessionMutationAdmissionGatePort } from "../../../src/runtime/lifecycle/mutation-gate.ts";
import type { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const NOW = "2026-07-23T00:00:00.000Z";
const AGENT_ID = createRuntimeId("agent", "production-composition-root");
const GOAL_ID = createRuntimeId("goal", "production-composition-root");
const SESSION_ID = createRuntimeId("session", "production-composition-root");

function workspaceReceipt(): AgentWorkspaceReceiptRef {
	const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		receiptId: createRuntimeId("receipt", "production-composition-workspace"),
		strategy: {
			strategyId: createRuntimeId("resource", "production-composition-workspace"),
			kind: "isolated_lease",
			strategyDigest: canonicalDigest("production composition Workspace strategy"),
		},
		sessionId: SESSION_ID,
		workspaceId: createRuntimeId("workspace", "production-composition-workspace"),
		repositoryId: createRuntimeId("repository", "production-composition-workspace"),
		bindingRevision: 1,
		bindingDigest: canonicalDigest("production composition Workspace binding"),
		leaseId: createRuntimeId("lease", "production-composition-workspace"),
		leaseRevision: 1,
		status: "active",
		issuedAt: NOW,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function fixture(): { options: ProductionAgentSupervisorCompositionOptions; closeAll: ReturnType<typeof vi.fn> } {
	const closeAll = vi.fn(async () => undefined);
	const manager = {
		isClosed: () => false,
		sessionId: () => SESSION_ID,
		sessionEvents: () => ({ lineage: () => ({ agentId: AGENT_ID, goalId: GOAL_ID }) }),
		identity: () => ({
			authorityId: createRuntimeId("authority", "production-composition"),
			tenantId: createRuntimeId("tenant", "production-composition"),
			principalId: createRuntimeId("principal", "production-composition"),
			source: "managed" as const,
			issuedAt: NOW,
		}),
		writer: () => ({}),
		eventStore: () => ({}),
		closeAll,
	} as unknown as V3SessionManager;
	const adapters: ProductionAgentSupervisorCompositionOptions["adapters"] = {
		workspace: {} as ProductionAgentWorkspaceAdapter,
		capabilitySubset: {} as GatewayBoundCapabilitySubsetEvaluator,
		deniedAgents: {} as AgentSupervisorPorts["deniedAgents"],
		budget: {} as AgentSupervisorPorts["budget"],
		merge: {} as AgentSupervisorPorts["merge"],
	};
	return {
		closeAll,
		options: {
			manager,
			parentMutationGate: {} as SessionMutationAdmissionGatePort,
			root: {
				requestId: createRuntimeId("command", "production-composition-root"),
				idempotencyKey: createIdempotencyKey("production-composition-root"),
				agentId: AGENT_ID,
				goalId: GOAL_ID,
				role: "build",
				workspaceReceipt: workspaceReceipt(),
				capabilityGrant: {
					receiptId: createRuntimeId("receipt", "production-composition-grant"),
					receiptDigest: canonicalDigest("production composition grant"),
					decisionRevision: 1,
				},
				inputSources: [],
				declassificationReceipts: [],
				registeredAt: NOW,
			},
			adapters,
			child: {
				sessionDir: "/tmp/runledger-production-composition-test",
				features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
				maxActiveChildren: 1,
			},
			clock: () => new Date(NOW),
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("production Agent supervisor composition lifecycle", () => {
	it("rejects a relative durable child session root before registration", async () => {
		const { options } = fixture();
		const register = vi.spyOn(AgentSupervisor.prototype, "registerRoot");

		await expect(createProductionAgentSupervisorComposition({
			...options,
			child: { ...options.child, sessionDir: "relative-child-sessions" },
		})).rejects.toThrow("absolute session root");
		expect(register).not.toHaveBeenCalled();
	});

	it("closes the launcher when durable root registration returns a typed failure", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: false,
			error: { code: "store_unavailable", message: "injected registration failure", retryable: true },
		});
		const close = vi.spyOn(ProductionChildSessionLauncher.prototype, "close").mockResolvedValue(undefined);

		await expect(createProductionAgentSupervisorComposition(options)).rejects.toThrow(
			"production Agent supervisor root registration failed: store_unavailable",
		);
		expect(close).toHaveBeenCalledTimes(1);
		expect(closeAll).not.toHaveBeenCalled();
	});

	it("preserves both a thrown registration failure and launcher cleanup failure", async () => {
		const { options, closeAll } = fixture();
		const registrationFailure = new Error("injected registration throw");
		const cleanupFailure = new Error("injected launcher cleanup failure");
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockRejectedValue(registrationFailure);
		vi.spyOn(ProductionChildSessionLauncher.prototype, "close").mockRejectedValue(cleanupFailure);

		let caught: unknown;
		try {
			await createProductionAgentSupervisorComposition(options);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AggregateError);
		expect((caught as AggregateError).errors).toEqual([registrationFailure, cleanupFailure]);
		expect(closeAll).not.toHaveBeenCalled();
	});

	it("allows composition close to retry a failed launcher shutdown without taking parent ownership", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const closeFailure = new Error("injected first close failure");
		const close = vi.spyOn(ProductionChildSessionLauncher.prototype, "close")
			.mockRejectedValueOnce(closeFailure)
			.mockResolvedValueOnce(undefined);
		const composition = await createProductionAgentSupervisorComposition(options);

		await expect(composition.close()).rejects.toBe(closeFailure);
		await expect(composition.close()).resolves.toBeUndefined();
		expect(close).toHaveBeenCalledTimes(2);
		expect(closeAll).not.toHaveBeenCalled();
	});
});
