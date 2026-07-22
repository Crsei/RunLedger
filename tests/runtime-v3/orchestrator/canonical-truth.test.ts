import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	budgetTruthFromCanonicalEvents,
	latestCanonicalGoalState,
	SessionCanonicalBudgetJournal,
	SessionCanonicalGoalJournal,
} from "../../../src/runtime/orchestrator/canonical-journals.ts";
import {
	BudgetGuard,
	createBudgetReservationId,
	createBudgetVector,
	projectBudgetSnapshotFromJournal,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import { createDurableGoalStateMachine } from "../../../src/runtime/orchestrator/goal-state-machine.ts";
import {
	createCanonicalTaskDefinition,
	reduceCanonicalTaskEvents,
	SessionTaskRepository,
} from "../../../src/runtime/orchestrator/task-repository.ts";
import type { GoalState } from "../../../src/runtime/orchestrator/types.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import { budgetLimits, digest, evidence, idempotency } from "./helpers.ts";

const roots: string[] = [];

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("canonical Goal/Task/Budget truth", () => {
	it("rebuilds the same projections live, by replay, and after a JSONL restart", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-canonical-truth-"));
		roots.push(root);
		let manager = await V3SessionManager.create({
			cwd: root,
			sessionDir: join(root, "sessions"),
			features: DEFAULT_RUNTIME_FEATURES,
		});
		const filePath = manager.filePath();
		const identity = manager.identity();
		const lineage = manager.sessionEvents().lineage();
		const goalId = lineage.goalId;
		let clockTick = 0;
		const clock = () => new Date(Date.now() + (++clockTick * 1_000));
		let traceTick = 0;
		const canonicalOptions = () => ({
			writer: manager.writer(),
			store: manager.eventStore(),
			principalId: identity.principalId,
			traceIdFactory: () => createRuntimeId("trace", `canonical-truth-${++traceTick}`),
		});
		const initialGoal: GoalState = {
			goalId,
			phase: "planning",
			revision: 0,
			evidence: [],
			partialResults: [],
		};
		const completionTrust = { verify: async () => true };

		try {
			const goal = valueOf(await createDurableGoalStateMachine(
				{
					journal: new SessionCanonicalGoalJournal(canonicalOptions()),
					completionTrust,
					clock,
				},
				initialGoal,
				idempotency("canonical-goal-create"),
			));
			const liveGoal = valueOf(await goal.transition({
				to: "awaiting_plan_approval",
				actor: "runtime",
				expectedRevision: 0,
				evidence: [evidence("plan", "recorded")],
			}, idempotency("canonical-goal-transition")));

			const taskRepository = new SessionTaskRepository({ ...canonicalOptions(), clock });
			const taskDefinition = createCanonicalTaskDefinition(goalId, {
				taskId: "canonical-task",
				owner: { kind: "agent", id: lineage.agentId },
				dependsOn: [],
				expectedArtifacts: [{ kind: "test_report", mediaType: "application/json", logicalName: "report" }],
				workspace: {
					workspaceId: createRuntimeId("workspace", "canonical-truth"),
					bindingRevision: 1,
					bindingDigest: digest("c"),
				},
				capabilities: [{
					receiptId: createRuntimeId("receipt", "canonical-truth-capability"),
					capability: "workspace_write",
					decisionRevision: 1,
					receiptDigest: digest("d"),
				}],
			});
			valueOf(await taskRepository.create({
				expectedRevision: 0,
				idempotencyKey: idempotency("canonical-task-create"),
				task: taskDefinition,
			}));
			valueOf(await taskRepository.transition({
				expectedRevision: 1,
				idempotencyKey: idempotency("canonical-task-ready"),
				taskId: taskDefinition.taskId,
				to: "ready",
				reasonDigest: digest("1"),
			}));
			valueOf(await taskRepository.transition({
				expectedRevision: 2,
				idempotencyKey: idempotency("canonical-task-running"),
				taskId: taskDefinition.taskId,
				to: "running",
				reasonDigest: digest("2"),
			}));
			const output: ArtifactRef = {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				artifactId: createRuntimeId("artifact", "canonical-truth-output"),
				storedDigest: digest("e"),
				kind: "test_report",
				originalSize: 16,
				storedSize: 16,
				mediaType: "application/json",
				redaction: "redacted",
				transformReceipt: createRuntimeId("receipt", "canonical-truth-transform"),
			};
			valueOf(await taskRepository.bindOutput({
				expectedRevision: 3,
				idempotencyKey: idempotency("canonical-task-output"),
				taskId: taskDefinition.taskId,
				logicalName: "report",
				artifact: output,
			}));
			const liveTasks = valueOf(await taskRepository.transition({
				expectedRevision: 4,
				idempotencyKey: idempotency("canonical-task-completed"),
				taskId: taskDefinition.taskId,
				to: "completed",
				reasonDigest: digest("3"),
				evidenceArtifactIds: [output.artifactId],
			}));

			const limits = budgetLimits({ soft: 1_000, hard: 2_000 });
			const budgetJournal = new SessionCanonicalBudgetJournal({
				...canonicalOptions(),
				goalId,
				limits,
			});
			const budget = new BudgetGuard({ goalId, limits, journal: budgetJournal, clock });
			const reservationId = createBudgetReservationId();
			const reserved = valueOf(await budget.reserve({
				reservationId,
				operationId: createRuntimeId("command", "canonical-budget-operation"),
				idempotencyKey: idempotency("canonical-budget-reserve"),
				estimatedUpperBound: createBudgetVector({ inputTokens: 100, usdMicros: 200, toolCalls: 1 }),
			}));
			expect(reserved.status).toBe("granted");
			const liveBudget = valueOf(await budget.commit({
				reservationId,
				idempotencyKey: idempotency("canonical-budget-commit"),
				actual: createBudgetVector({ inputTokens: 80, usdMicros: 150, toolCalls: 1 }),
			}));

			const events = valueOf(await readAllRuntimeEvents(manager.eventStore()));
			expect(events.filter((event) => event.type === "goal.created")).toHaveLength(1);
			expect(events.filter((event) => event.type === "goal.transitioned")).toHaveLength(1);
			expect(events.filter((event) => event.type.startsWith("task."))).toHaveLength(5);
			expect(events.filter((event) => event.type === "budget.transaction_committed")).toHaveLength(2);
			expect(valueOf(latestCanonicalGoalState(events))).toEqual(liveGoal);
			expect(valueOf(reduceCanonicalTaskEvents(events))).toEqual(liveTasks);
			const replayedBudgetTruth = valueOf(budgetTruthFromCanonicalEvents(events));
			expect(replayedBudgetTruth.goalId).toBe(goalId);
			expect(valueOf(projectBudgetSnapshotFromJournal(goalId, replayedBudgetTruth.journal))).toEqual(liveBudget);

			await manager.closeAll();
			manager = await V3SessionManager.open(filePath, DEFAULT_RUNTIME_FEATURES, identity);
			const restartedGoal = valueOf(await createDurableGoalStateMachine(
				{
					journal: new SessionCanonicalGoalJournal(canonicalOptions()),
					completionTrust,
					clock,
				},
				initialGoal,
				idempotency("canonical-goal-restart"),
			));
			const restartedTasks = valueOf(await new SessionTaskRepository({ ...canonicalOptions(), clock }).load());
			const restartedBudget = valueOf(await new BudgetGuard({
				goalId,
				limits,
				journal: new SessionCanonicalBudgetJournal({ ...canonicalOptions(), goalId, limits }),
				clock,
			}).snapshot());
			expect(restartedGoal.snapshot()).toEqual(liveGoal);
			expect(restartedTasks).toEqual(liveTasks);
			expect(restartedBudget).toEqual(liveBudget);
		} finally {
			if (!manager.isClosed()) await manager.closeAll();
		}
	});
});
