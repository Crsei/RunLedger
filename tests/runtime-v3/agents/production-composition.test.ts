import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { AgentSupervisor } from "../../../src/runtime/agents/supervisor.ts";
import type {
	AgentSupervisorPorts,
	AgentWorkspaceReceiptRef,
	SpawnAgentRequest,
} from "../../../src/runtime/agents/types.ts";
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

	it("allows composition close to retry a failed idle-launcher shutdown without taking parent ownership", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const closeFailure = new Error("injected first close failure");
		const close = vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle")
			.mockRejectedValueOnce(closeFailure)
			.mockResolvedValueOnce(undefined);
		const reconcile = vi.spyOn(AgentSupervisor.prototype, "reconcilePendingCleanups").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const composition = await createProductionAgentSupervisorComposition(options);

		await expect(composition.close()).rejects.toBe(closeFailure);
		await expect(composition.close()).resolves.toBeUndefined();
		expect(close).toHaveBeenCalledTimes(2);
		expect(reconcile).toHaveBeenCalledTimes(2);
		expect(closeAll).not.toHaveBeenCalled();
	});

	it("does not expose the production supervisor adapter ports through runtime reflection", async () => {
		const { options } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle").mockResolvedValue(undefined);
		const reconcile = vi.spyOn(AgentSupervisor.prototype, "reconcilePendingCleanups").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const composition = await createProductionAgentSupervisorComposition(options);

		expect(Object.getOwnPropertyNames(composition.supervisor)).not.toContain("ports");
		expect(Reflect.get(composition.supervisor, "ports")).toBeUndefined();
		await composition.close();
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it("refuses to close an active child without inventing terminal usage", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const reconcile = vi.spyOn(AgentSupervisor.prototype, "reconcilePendingCleanups").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const close = vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle").mockRejectedValue(
			new Error("production Agent supervisor close requires governed terminal cleanup for 1 active child runtime(s)"),
		);
		const unsafeClose = vi.spyOn(ProductionChildSessionLauncher.prototype, "close");
		const composition = await createProductionAgentSupervisorComposition(options);

		await expect(composition.close()).rejects.toThrow(
			"requires governed terminal cleanup for 1 active child runtime(s)",
		);
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(unsafeClose).not.toHaveBeenCalled();
		expect(closeAll).not.toHaveBeenCalled();
	});

	it("drains a deferred Supervisor spawn before launcher shutdown and rejects new mutations", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const reconcile = vi.spyOn(AgentSupervisor.prototype, "reconcilePendingCleanups").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const order: string[] = [];
		let entered: (() => void) | undefined;
		let complete: ((result: Awaited<ReturnType<AgentSupervisor["spawn"]>>) => void) | undefined;
		const spawnEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const deferredSpawn = new Promise<Awaited<ReturnType<AgentSupervisor["spawn"]>>>((resolve) => {
			complete = (result) => {
				order.push("spawn_completed");
				resolve(result);
			};
		});
		const spawn = vi.spyOn(AgentSupervisor.prototype, "spawn").mockImplementation(() => {
			entered?.();
			return deferredSpawn;
		});
		const closeLauncher = vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle")
			.mockImplementation(async () => {
				order.push("launcher_closed");
			});
		const composition = await createProductionAgentSupervisorComposition(options);

		const spawning = composition.supervisor.spawn({} as SpawnAgentRequest);
		await spawnEntered;
		let closeSettled = false;
		const closing = composition.close().then(() => {
			closeSettled = true;
			order.push("composition_closed");
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(closeLauncher).not.toHaveBeenCalled();
		expect(await composition.supervisor.spawn({} as SpawnAgentRequest)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(spawn).toHaveBeenCalledTimes(1);

		complete?.({
			ok: false,
			error: { code: "launch_failed", message: "deferred spawn completed", retryable: false },
		});
		await spawning;
		await closing;
		expect(order).toEqual(["spawn_completed", "launcher_closed", "composition_closed"]);
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(closeAll).not.toHaveBeenCalled();
		expect(await composition.supervisor.spawn({} as SpawnAgentRequest)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("reconciles an already-terminal child before closing the now-idle launcher", async () => {
		const { options, closeAll } = fixture();
		vi.spyOn(AgentSupervisor.prototype, "registerRoot").mockResolvedValue({
			ok: true,
			value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
		});
		const activeChild = {
			agentId: createRuntimeId("agent", "production-composition-terminal-child"),
			sessionId: createRuntimeId("session", "production-composition-terminal-child"),
			workspaceId: createRuntimeId("workspace", "production-composition-terminal-child"),
			runtimeInstanceId: createRuntimeId("runtime", "production-composition-terminal-child"),
			launchRevision: 1,
		};
		let resident = true;
		vi.spyOn(ProductionChildSessionLauncher.prototype, "snapshots")
			.mockImplementation(() => resident ? [activeChild] : []);
		const reconcile = vi.spyOn(AgentSupervisor.prototype, "reconcilePendingCleanups").mockImplementation(async () => {
			resident = false;
			return {
				ok: true,
				value: {} as Awaited<ReturnType<AgentSupervisor["graph"]>> extends { ok: true; value: infer T } ? T : never,
			};
		});
		const close = vi.spyOn(ProductionChildSessionLauncher.prototype, "closeIfIdle").mockResolvedValue(undefined);
		const composition = await createProductionAgentSupervisorComposition(options);

		await expect(composition.close()).resolves.toBeUndefined();
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(closeAll).not.toHaveBeenCalled();
	});
});
