import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import { canonicalDigest } from "../../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type PlanId } from "../../../../src/runtime/protocol/v3/ids.ts";
import type { PlanModeCommand, PlanModeState } from "../../../../src/runtime/modes/plan/types.ts";
import { recoverPlanModeState, reducePlanModeCommand } from "../../../../src/runtime/modes/plan/reducer.ts";
import { constrainToolForPlanMode, mergeCapabilityCeilings } from "../../../../src/runtime/modes/plan/policy.ts";
import { resolvePlanApproval } from "../../../../src/runtime/modes/plan/approval-coordinator.ts";
import { createInactivePlanModeState, PlanModeService, type PlanRuntimeEvent } from "../../../../src/runtime/modes/plan/service.ts";
import { PlanArtifactStore, PlanStoreError } from "../../../../src/storage/plan-artifact-store.ts";
import { planDirectory, planWorkingPath } from "../../../../src/storage/context-paths.ts";
import { createPlanWriteTool } from "../../../../src/runtime/tools/plan-write.ts";
import { descriptor, processCapability } from "../../resource-contracts/fixtures.ts";
import { createRuntimeToolDescriptor } from "../../../../src/runtime/resources/schemas.ts";
import { approvalReceipt, authorityId, expectedRevision, NOW, principalId, sessionId, tenantId, traceId, workspaceId } from "../../plan-context-memory/helpers.ts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function store(): Promise<{ root: string; store: PlanArtifactStore }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-plan-"));
	roots.push(root);
	return {
		root,
		store: new PlanArtifactStore(root, { authorityId, tenantId, principalId, sessionId, workspaceId }),
	};
}

function commandBase() {
	return { schemaVersion: 1 as const, authorityId, tenantId, principalId, sessionId, commandId: createRuntimeId("command", "plan-test"), expectedRevision };
}

describe("Plan mode reducer and store", () => {
	it("enforces the legal revisioned activation/write/approval path", async () => {
		const { store: plans } = await store();
		const initial = createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW);
		const pending = reducePlanModeCommand(initial, { ...commandBase(), kind: "request_activation", requestedBy: "user" }, NOW);
		const plan0 = await plans.create("# Plan\n");
		const active = reducePlanModeCommand(pending, { ...commandBase(), kind: "activate", expectedModeRevision: pending.modeRevision, plan: plan0 }, NOW);
		const plan1 = await plans.write(plan0.planId, 0, "# Plan\n\n1. inspect\n");
		const written = reducePlanModeCommand(active, { ...commandBase(), kind: "write_revision", expectedModeRevision: active.modeRevision, expectedPlanRevision: 0, plan: plan1 }, NOW);
		expect(written).toMatchObject({ kind: "active", mode: "plan", plan: { revision: 1 } });
		const plan2 = await plans.write(plan0.planId, 1, "# Plan\n\n1. inspect\n2. verify\n");
		expect(() => reducePlanModeCommand(written, {
			...commandBase(), kind: "write_revision", expectedModeRevision: active.modeRevision, expectedPlanRevision: 1, plan: plan2,
		}, NOW)).toThrowError(expect.objectContaining({ code: "revision_conflict" }));
	});

	it("folds transient states on recovery but preserves durable active state", () => {
		const initial = createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW);
		const pending = reducePlanModeCommand(initial, { ...commandBase(), kind: "request_activation", requestedBy: "user" }, NOW);
		expect(recoverPlanModeState(pending, NOW)).toMatchObject({ state: { kind: "inactive" }, exitReminderRequired: false });
		expect(recoverPlanModeState(initial, NOW)).toEqual({ state: initial, exitReminderRequired: false });
	});

	it("commits immutable revisions atomically, detects conflicts and external working drift", async () => {
		const { root, store: plans } = await store();
		const first = await plans.create("alpha");
		const results = await Promise.allSettled([
			plans.write(first.planId, 0, "beta"),
			plans.write(first.planId, 0, "gamma"),
		]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((item) => item.status === "rejected")[0]).toMatchObject({ reason: expect.objectContaining<PlanStoreError>({ code: "revision_conflict" }) });
		const current = results.find((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof plans.write>>> => item.status === "fulfilled")?.value;
		expect(current).toBeDefined();
		if (current === undefined) throw new Error("missing committed plan");
		expect(await plans.inspectWorkingCopy(current)).toBe("current");
		await writeFile(planWorkingPath(root, sessionId, first.planId), "tampered", "utf8");
		expect(await plans.inspectWorkingCopy(current)).toBe("changed_unreviewed");
		await plans.recoverWorkingCopy(current);
		expect(await readFile(planWorkingPath(root, sessionId, first.planId), "utf8")).toBe((await plans.read(current.planId, current.revision)).body);
		expect(await plans.permissions(first.planId)).toEqual({ directory: 0o700, working: 0o600 });
	});
});

describe("Plan mode policy and service", () => {
	it("keeps read-only tools available but deny overrides ask/always-allow", () => {
		const state = { ...createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW), kind: "active", mode: "plan" } as unknown as PlanModeState;
		const read = descriptor();
		expect(constrainToolForPlanMode(state, read).ceiling).toBe("allow");
		const process = createRuntimeToolDescriptor({
			...read,
			capabilities: [processCapability()],
			risk: { ...read.risk, sideEffect: "write" },
			execution: { readOnly: false, destructive: true, concurrencySafe: false },
		});
		expect(constrainToolForPlanMode(state, process).ceiling).toBe("deny");
		expect(mergeCapabilityCeilings(["allow", "ask", "deny", "allow"])).toBe("deny");
	});

	it("denies unknown MCP, untrusted tools and process-backed command families while plan_write has no path", async () => {
		const state = { ...createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW), kind: "active", mode: "plan" } as unknown as PlanModeState;
		const read = descriptor();
		const unknownMcp = createRuntimeToolDescriptor({
			...read,
			identity: { ...read.identity, resourceId: createRuntimeId("resource", "unknown-mcp"), kind: "mcp-tool", qualifiedId: "mcp:unknown/read" },
			provenance: { ...read.provenance, source: "project" },
			capabilities: [],
		});
		expect(constrainToolForPlanMode(state, unknownMcp).ceiling).toBe("deny");
		const untrusted = createRuntimeToolDescriptor({ ...read, trust: "untrusted" });
		expect(constrainToolForPlanMode(state, untrusted).ceiling).toBe("deny");
		for (const runtimeName of ["bash", "tee", "git", "npm"]) {
			const process = createRuntimeToolDescriptor({
				...read,
				runtimeName,
				capabilities: [processCapability()],
				risk: { ...read.risk, sideEffect: "write" },
				execution: { readOnly: false, destructive: runtimeName === "bash", concurrencySafe: false },
			});
			expect(constrainToolForPlanMode(state, process).ceiling).toBe("deny");
		}

		const { store: plans } = await store();
		const service = new PlanModeService({
			identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
			state: createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW),
			store: plans,
			events: { append: async () => undefined },
			clock: () => new Date(NOW),
		});
		const writer = createPlanWriteTool({ service, expectedEventRevision: () => expectedRevision, traceId: () => traceId });
		expect(Check(writer.parameters, { expectedRevision: 0, body: "plan" })).toBe(true);
		expect(Check(writer.parameters, { expectedRevision: 0, body: "plan", path: "../../escape" })).toBe(false);
		expect(() => planDirectory("/tmp/runledger-plan-root", sessionId, "plan_../../escape" as PlanId)).toThrow();
	});

	it("persists lifecycle receipts and rejects approval after working copy drift", async () => {
		const { root, store: plans } = await store();
		const events: PlanRuntimeEvent[] = [];
		const service = new PlanModeService({
			identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
			state: createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW),
			store: plans,
			events: { append: async (event) => { events.push(event); } },
			clock: () => new Date(NOW),
		});
		await service.requestActivation("user", expectedRevision, traceId);
		const active = await service.activateAtSafePoint(expectedRevision, traceId, "draft");
		if (active.kind !== "active") throw new Error("activation failed");
		await writeFile(planWorkingPath(root, sessionId, active.plan.planId), "external change", "utf8");
		await expect(service.requestApproval(expectedRevision, traceId)).rejects.toThrow("changed outside");
		expect(events.map((event) => event.type)).toEqual(["mode.transitioned", "plan.proposed", "mode.transitioned", "plan.invalidated"]);
	});

	it("pins an immutable approval and distinguishes same-session from fresh-context handoff", async () => {
		const { store: plans } = await store();
		const service = new PlanModeService({
			identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
			state: createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW),
			store: plans,
			events: { append: async () => undefined },
			clock: () => new Date(NOW),
		});
		await service.requestActivation("user", expectedRevision, traceId);
		await service.activateAtSafePoint(expectedRevision, traceId, "approved plan");
		const waiting = await service.requestApproval(expectedRevision, traceId);
		if (waiting.kind !== "awaiting_approval" || waiting.approval.state !== "pending") throw new Error("approval not pending");
		const approved = resolvePlanApproval(waiting.approval, { decision: "allowed", receipt: approvalReceipt(waiting.approval.approvalId) });
		const result = await service.decideApproval(approved, "approve_fresh_context", expectedRevision, traceId);
		expect(result).toMatchObject({ implementation: "fresh_context", state: { kind: "exit_pending" }, approvedPlan: { contentDigest: waiting.plan.contentDigest } });
	});

	it("durably records approval before mode exit and retries idempotently after the crash boundary", async () => {
		const { store: plans } = await store();
		const committed: PlanRuntimeEvent[] = [];
		const seen = new Set<string>();
		let failExitTransition = false;
		const service = new PlanModeService({
			identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
			state: createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW),
			store: plans,
			events: {
				append: async (event) => {
					if (failExitTransition && event.type === "mode.transitioned" && event.payload.toState === "exit_pending") {
						failExitTransition = false;
						throw new Error("crash after durable approval");
					}
					const key = event.type === "plan.approved"
						? `${event.type}:${event.payload.receiptId}`
						: event.type === "mode.transitioned" ? `${event.type}:${event.payload.commandId}` : canonicalDigest(event);
					if (seen.has(key)) return;
					seen.add(key);
					committed.push(event);
				},
			},
			clock: () => new Date(NOW),
		});
		await service.requestActivation("user", expectedRevision, traceId);
		await service.activateAtSafePoint(expectedRevision, traceId, "approved plan");
		const waiting = await service.requestApproval(expectedRevision, traceId);
		if (waiting.kind !== "awaiting_approval" || waiting.approval.state !== "pending") throw new Error("approval not pending");
		const approved = resolvePlanApproval(waiting.approval, { decision: "allowed", receipt: approvalReceipt(waiting.approval.approvalId) });
		const commandId = createRuntimeId("command", "approval-decision");
		committed.length = 0;
		seen.clear();
		failExitTransition = true;
		await expect(service.decideApproval(approved, "approve_same_session", expectedRevision, traceId, commandId)).rejects.toThrow("crash after");
		expect(service.snapshot().kind).toBe("awaiting_approval");
		expect(committed.map((event) => event.type)).toEqual(["plan.approved"]);
		const retried = await service.decideApproval(approved, "approve_same_session", expectedRevision, traceId, commandId);
		expect(retried.state.kind).toBe("exit_pending");
		expect(committed.map((event) => event.type)).toEqual(["plan.approved", "mode.transitioned"]);
	});

	it("does not mark activation delivered until its transition event commits", async () => {
		const { store: plans } = await store();
		let rejectDelivery = false;
		const events: PlanRuntimeEvent[] = [];
		const service = new PlanModeService({
			identity: { authorityId, tenantId, principalId, sessionId, workspaceId },
			state: createInactivePlanModeState({ authorityId, tenantId, principalId, sessionId, workspaceId }, NOW),
			store: plans,
			events: { append: async (event) => {
				if (rejectDelivery && event.type === "mode.transitioned" && event.payload.fromState === "active" && event.payload.toState === "active") {
					throw new Error("delivery event unavailable");
				}
				events.push(event);
			} },
			clock: () => new Date(NOW),
		});
		await service.requestActivation("user", expectedRevision, traceId);
		await service.activateAtSafePoint(expectedRevision, traceId, "draft");
		rejectDelivery = true;
		await expect(service.markActivationDelivered(traceId)).rejects.toThrow("delivery event unavailable");
		expect(service.snapshot()).toMatchObject({ kind: "active", activationDelivered: false });
		rejectDelivery = false;
		expect(await service.markActivationDelivered(traceId)).toMatchObject({ kind: "active", activationDelivered: true });
		expect(events.at(-1)).toMatchObject({ type: "mode.transitioned", payload: { fromState: "active", toState: "active" } });
	});
});
