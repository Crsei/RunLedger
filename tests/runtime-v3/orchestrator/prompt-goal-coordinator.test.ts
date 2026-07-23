import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovedPlanRef } from "../../../src/runtime/modes/plan/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { SessionCanonicalGoalJournal } from "../../../src/runtime/orchestrator/canonical-journals.ts";
import { createDurableGoalStateMachine } from "../../../src/runtime/orchestrator/goal-state-machine.ts";
import {
	PromptGoalCoordinator,
	type ApprovedPlanEvidence,
} from "../../../src/runtime/orchestrator/prompt-goal-coordinator.ts";
import { SessionTaskRepository } from "../../../src/runtime/orchestrator/task-repository.ts";
import type { GoalEvidence, GoalPhase, TaskDag } from "../../../src/runtime/orchestrator/types.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import { digest, evidence } from "./helpers.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PromptGoalCoordinator", () => {
	it("imports an approved Task DAG and reaches completed without requiring a pre-seal PR", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-goal-coordinator-"));
		roots.push(root);
		const manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: DEFAULT_RUNTIME_FEATURES,
		});
		managers.push(manager);
		const identity = manager.identity();
		const lineage = manager.sessionEvents().lineage();
		const journalOptions = {
			writer: manager.writer(),
			store: manager.eventStore(),
			principalId: identity.principalId,
		};
		const goal = await createDurableGoalStateMachine({
			journal: new SessionCanonicalGoalJournal(journalOptions),
			completionTrust: { verify: async () => true },
		}, {
			goalId: lineage.goalId,
			phase: "planning",
			revision: 0,
			evidence: [],
			partialResults: [],
		}, createIdempotencyKey(`coordinator-genesis-${"x".repeat(24)}`));
		if (!goal.ok) throw new Error(goal.error.message);
		const workspaceId = createRuntimeId("workspace", "coordinator");
		const approvalReceipt = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			receiptId: createRuntimeId("receipt", "coordinator-plan-approval"),
			approvalId: createRuntimeId("approval", "coordinator-plan"),
			requestId: createRuntimeId("command", "coordinator-plan-approval"),
			requestDigest: digest("1"),
			ticketDigest: digest("2"),
			decision: "allowed" as const,
			decisionRevision: 1,
			decidedBy: identity.principalId,
			decidedAt: "2026-07-24T00:00:00.000Z",
			receiptDigest: digest("3"),
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: digest("4"),
		};
		const planArtifact = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			artifactId: createRuntimeId("artifact", "coordinator-plan"),
			storedDigest: digest("5"),
			kind: "session_report" as const,
			originalSize: 10,
			storedSize: 10,
			mediaType: "text/markdown",
			redaction: "redacted" as const,
			transformReceipt: createRuntimeId("receipt", "coordinator-plan-transform"),
			workspaceId,
		};
		const approvedPlan: ApprovedPlanRef = {
			schemaVersion: 1,
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			planId: createRuntimeId("plan", "coordinator"),
			workspaceId,
			revision: 1,
			contentDigest: digest("6"),
			artifact: planArtifact,
			approvalReceipt,
		};
		const taskDag: TaskDag = {
			goalId: lineage.goalId,
			revision: 1,
			tasks: [{
				taskId: "implementation",
				owner: { kind: "agent", id: lineage.agentId },
				dependsOn: [],
				expectedArtifacts: [{
					kind: "test_report",
					mediaType: "application/json",
					logicalName: "implementation-report",
				}],
				workspace: {
					workspaceId,
					bindingRevision: 1,
					bindingDigest: digest("7"),
				},
				capabilities: [{
					receiptId: createRuntimeId("receipt", "coordinator-capability"),
					capability: "workspace_write",
					decisionRevision: 1,
					receiptDigest: digest("8"),
				}],
			}],
		};
		const planValue: Extract<ApprovedPlanEvidence, { status: "approved" }> = {
			status: "approved",
			approvedPlan,
			planEvidence: {
				...evidence("plan", "recorded"),
				digest: approvedPlan.contentDigest,
			},
			approvalEvidence: {
				...evidence("plan_approval", "pass"),
				receiptId: approvalReceipt.receiptId,
				digest: approvalReceipt.receiptDigest,
			},
			taskDag,
			taskDagDigest: canonicalDigest(taskDag),
		};
		const seal = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			sealId: createRuntimeId("episodeSeal", "coordinator"),
			sealDigest: digest("9"),
			sealRecordDigest: digest("a"),
			manifestBodyDigest: digest("b"),
		};
		const gateEvidence = (phase: GoalPhase): readonly GoalEvidence[] => {
			switch (phase) {
				case "implementation":
					return [evidence("implementation", "recorded")];
				case "build":
					return [evidence("build", "pass")];
				case "test":
					return [evidence("test", "pass")];
				case "security_review":
					return [evidence("security_review", "pass")];
				case "independent_review":
					return [evidence("independent_review", "pass")];
				case "awaiting_verification":
					return [{
						...evidence("verification", "pass"),
						digest: seal.sealRecordDigest,
						episodeSeal: seal,
					}];
				default:
					return [];
			}
		};
		const tasks = new SessionTaskRepository(journalOptions);
		let candidateReady = false;
		const createCoordinator = () => new PromptGoalCoordinator({
			goal: goal.value,
			tasks,
			plans: { load: async () => ({ ok: true, value: planValue }) },
			candidates: {
				current: async () => ({
					ok: true,
					value: candidateReady
						? {
								status: "ready" as const,
								candidateCommit: "candidate",
								bindingDigest: digest("c"),
								checkpointDigest: digest("d"),
						  }
						: { status: "external_gap" as const, reasonDigest: digest("e") },
				}),
			},
			gates: {
				evaluate: async ({ phase }) => ({
					ok: true,
					value: { status: "passed", evidence: gateEvidence(phase) },
				}),
			},
			taskReferences: {
				workspace: { validate: async () => ({ status: "valid" }) },
				capability: { validate: async () => ({ status: "valid" }) },
			},
			completionEnabled: () => true,
		});
		const interrupted = await createCoordinator().run();
		expect(interrupted.ok && interrupted.value.goal.phase).toBe("implementation");
		expect(interrupted.ok && interrupted.value.reason).toBe("external_gap");
		candidateReady = true;
		const result = await createCoordinator().resume();
		expect(result.ok && result.value.goal.phase).toBe("completed");
		expect(result.ok && result.value.status).toBe("completed");
		expect(result.ok && result.value.taskDagDigest).toBe(planValue.taskDagDigest);
		const taskProjection = await tasks.load();
		expect(taskProjection.ok && taskProjection.value.tasks.map((task) => task.definition.taskId))
			.toEqual(["implementation"]);
		expect(result.ok && result.value.goal.evidence.some((entry) => entry.kind === "pull_request"))
			.toBe(false);
	});
});
