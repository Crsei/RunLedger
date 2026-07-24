import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../../src/runtime/protocol/v3/ids.ts";
import { createSessionEventStreamRef } from "../../../../src/runtime/protocol/v3/events.ts";
import {
	createApprovedPlanForkSeed,
	createPlanImplementationHandoffReceipt,
	PlanImplementationHandoffCoordinator,
} from "../../../../src/runtime/modes/plan/implementation-handoff.ts";
import {
	isApprovedPlanForkSeed,
	isApprovedPlanRef,
	isPlanImplementationHandoffReceipt,
} from "../../../../src/runtime/modes/plan/schema.ts";
import type { ApprovedPlanRef, PlanModeState } from "../../../../src/runtime/modes/plan/types.ts";
import {
	SessionRuntimeRegistry,
	type ApprovedPlanSessionRuntimeFactoryPort,
	type ManagedSessionRuntime,
} from "../../../../src/runtime/control-plane/session-registry.ts";
import { controlPlaneFailure } from "../../../../src/runtime/control-plane/errors.ts";
import { asRecord, loadContractFixture } from "../../contracts/helpers.ts";
import {
	authorityId,
	NOW,
	principalId,
	sessionId,
	tenantId,
	traceId,
} from "../../plan-context-memory/helpers.ts";

const digest = "a".repeat(64);

function approvedPlan(): ApprovedPlanRef {
	const value = asRecord(loadContractFixture("plan-mode/approval-resume.json")).approvedPlan;
	if (!isApprovedPlanRef(value)) throw new Error("approved plan fixture is invalid");
	return value;
}

function cursor() {
	return {
		stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
		sequence: 9,
		eventId: createRuntimeId("event", "plan-handoff"),
		eventHash: digest,
	};
}

function inactive(): PlanModeState {
	return {
		schemaVersion: 1,
		authorityId,
		tenantId,
		sessionId,
		modeRevision: 8,
		updatedByPrincipalId: principalId,
		updatedAt: NOW,
		kind: "inactive",
		mode: "default",
	};
}

describe("approved plan implementation handoff", () => {
	it("binds durable handoff and fresh-context seed to the approved revision only", () => {
		const approved = approvedPlan();
		const contextSeedDigest = canonicalDigest({ approved: approved.contentDigest });
		const receipt = createPlanImplementationHandoffReceipt({
			approvedPlan: approved,
			sourceSessionId: sessionId,
			action: "fresh_context",
			implementationPromptDigest: digest,
			policySnapshotDigest: digest,
			contextSeedDigest,
			createdAt: NOW,
		});
		expect(isPlanImplementationHandoffReceipt(receipt)).toBe(true);
		const seed = createApprovedPlanForkSeed({
			parentCursor: cursor(),
			approvedPlan: approved,
			invariantArtifacts: [],
			policySnapshotDigest: digest,
		});
		expect(isApprovedPlanForkSeed(seed)).toBe(true);
		expect(isApprovedPlanForkSeed({ ...seed, seedDigest: "0".repeat(64) })).toBe(false);
	});

	it("settles default mode before persisting and enqueueing same-session implementation", async () => {
		const order: string[] = [];
		const coordinator = new PlanImplementationHandoffCoordinator({
			exit: {
				settleExit: async () => {
					order.push("mode-default");
					return inactive();
				},
			},
			store: {
				persist: async () => {
					order.push("handoff-durable");
					return { ok: true, value: undefined };
				},
			},
			turns: {
				enqueue: async () => {
					order.push("turn-enqueued");
					return { ok: true, value: undefined };
				},
			},
			forks: {
				forkApprovedPlan: async () => {
					throw new Error("same-session handoff must not fork");
				},
			},
			clock: () => new Date(NOW),
		});
		const result = await coordinator.handoff({
			decision: {
				state: inactive(),
				approvedPlan: approvedPlan(),
				implementation: "same_session",
			},
			sourceCursor: cursor(),
			implementationPrompt: "Implement the approved plan.",
			policySnapshotDigest: digest,
			invariantArtifacts: [],
			traceId,
		});
		expect(result).toMatchObject({ ok: true, value: { receipt: { action: "same_session" } } });
		expect(order).toEqual(["mode-default", "handoff-durable", "turn-enqueued"]);
	});

	it("persists fresh-context handoff before consuming one child bootstrap", async () => {
		const order: string[] = [];
		const childSessionId = createRuntimeId("session", "approved-plan-child");
		const coordinator = new PlanImplementationHandoffCoordinator({
			exit: { settleExit: async () => inactive() },
			store: {
				persist: async () => {
					order.push("handoff-durable");
					return { ok: true, value: undefined };
				},
			},
			turns: {
				enqueue: async () => {
					throw new Error("fresh-context handoff must not enqueue on the parent");
				},
			},
			forks: {
				forkApprovedPlan: async (seed) => {
					order.push(`fork:${seed.approvedPlan.contentDigest}`);
					return {
						ok: true,
						value: {
							sessionId: childSessionId,
							handle: {
								handleId: "handle_0123456789abcdef",
								sessionId: childSessionId,
								generation: 10,
							},
							head: null,
							recovery: "forked",
						},
					};
				},
			},
			clock: () => new Date(NOW),
		});
		const result = await coordinator.handoff({
			decision: {
				state: inactive(),
				approvedPlan: approvedPlan(),
				implementation: "fresh_context",
			},
			sourceCursor: cursor(),
			implementationPrompt: "Implement the approved plan.",
			policySnapshotDigest: digest,
			invariantArtifacts: [],
			traceId,
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				receipt: { action: "fresh_context", targetSessionId: null },
				bootstrap: { sessionId: childSessionId },
			},
		});
		expect(order).toEqual(["handoff-durable", `fork:${approvedPlan().contentDigest}`]);
	});

	it("routes an approved-plan seed through the specialized factory without using generic fork", async () => {
		const childSessionId = createRuntimeId("session", "specialized-approved-plan-child");
		const child: ManagedSessionRuntime = {
			sessionId: childSessionId,
			head: () => null,
			teardown: async () => ({ ok: true, value: undefined }),
		};
		const calls: string[] = [];
		const factory: ApprovedPlanSessionRuntimeFactoryPort = {
			start: async () => controlPlaneFailure("adapter_unavailable", "unused"),
			resume: async () => controlPlaneFailure("adapter_unavailable", "unused"),
			fork: async () => {
				calls.push("generic-fork");
				return controlPlaneFailure("adapter_contract_violation", "generic fork must not be used");
			},
			forkApprovedPlan: async (seed) => {
				calls.push(`approved:${seed.seedDigest}`);
				return { ok: true, value: child };
			},
		};
		const registry = new SessionRuntimeRegistry(factory, {
			handleIdFactory: () => "handle_approved_plan_specialized",
		});
		const seed = createApprovedPlanForkSeed({
			parentCursor: cursor(),
			approvedPlan: approvedPlan(),
			invariantArtifacts: [],
			policySnapshotDigest: digest,
		});
		await expect(registry.forkApprovedPlan(seed)).resolves.toMatchObject({
			ok: true,
			value: { sessionId: childSessionId, recovery: "forked" },
		});
		expect(calls).toEqual([`approved:${seed.seedDigest}`]);
	});
});
