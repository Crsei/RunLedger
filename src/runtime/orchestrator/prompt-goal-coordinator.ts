/** Durable Goal 状态驱动的 prompt-to-verification lifecycle coordinator。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../protocol/v3/coordination.ts";
import type { GoalId } from "../protocol/v3/ids.ts";
import type { ApprovedPlanRef } from "../modes/plan/types.ts";
import { createCanonicalTaskDefinition, type SessionTaskRepository } from "./task-repository.ts";
import { validateTaskDag, type TaskDagValidationPorts } from "./task-dag.ts";
import type { DurableGoalStateMachine } from "./goal-state-machine.ts";
import type {
	GoalEvidence,
	GoalPhase,
	GoalState,
	OrchestratorResult,
	TaskDag,
} from "./types.ts";

export type ApprovedPlanEvidence =
	| {
			status: "proposed";
			planEvidence: GoalEvidence;
	  }
	| {
			status: "approved";
			approvedPlan: ApprovedPlanRef;
			planEvidence: GoalEvidence;
			approvalEvidence: GoalEvidence;
			taskDag: TaskDag;
			taskDagDigest: string;
	  }
	| {
			status: "missing" | "unsupported";
			reasonDigest: string;
	  };

export interface ApprovedPlanEvidencePort {
	load(goalId: GoalId): Promise<OrchestratorResult<ApprovedPlanEvidence>>;
}

export type CandidateSnapshot =
	| {
			status: "ready";
			candidateCommit: string;
			bindingDigest: string;
			checkpointDigest: string;
	  }
	| {
			status: "external_gap" | "unsupported";
			reasonDigest: string;
	  };

export interface CandidateSnapshotPort {
	current(goalId: GoalId): Promise<OrchestratorResult<CandidateSnapshot>>;
}

export type GoalGateDecision =
	| {
			status: "passed" | "failed";
			evidence: readonly GoalEvidence[];
	  }
	| {
			status: "pending" | "unsupported" | "external_gap";
			reasonDigest: string;
	  };

export interface GoalGatePort {
	evaluate(input: {
		goal: GoalState;
		phase: Exclude<GoalPhase, "planning" | "awaiting_plan_approval" | "awaiting_human" | "completed" | "failed" | "stopped">;
		approvedPlan: ApprovedPlanRef;
		candidate: Extract<CandidateSnapshot, { status: "ready" }>;
	}): Promise<OrchestratorResult<GoalGateDecision>>;
}

export type PromptGoalCoordinatorStatus =
	| "progressed"
	| "awaiting_plan_approval"
	| "waiting"
	| "completed"
	| "failed"
	| "stopped";

export interface PromptGoalCoordinatorSnapshot {
	goal: GoalState;
	status: PromptGoalCoordinatorStatus;
	reason?: "plan_missing" | "dependency_unavailable" | "gate_pending" | "external_gap";
	reasonDigest?: string;
	approvedPlan?: ApprovedPlanRef;
	taskDagDigest?: string;
}

export interface PromptGoalCoordinatorOptions {
	goal: DurableGoalStateMachine;
	tasks: SessionTaskRepository;
	plans: ApprovedPlanEvidencePort;
	candidates: CandidateSnapshotPort;
	gates: GoalGatePort;
	taskReferences: TaskDagValidationPorts;
	/** readiness 未允许 completion 时，awaiting_verification 必须保持不可达 completed。 */
	completionEnabled: () => boolean;
}

function idempotency(goal: GoalState, action: string, body: unknown) {
	return createIdempotencyKey(
		`goal-coordinator-${action}-${canonicalDigest({ goalId: goal.goalId, revision: goal.revision, body }).slice(0, 48)}`,
	);
}

function waiting(
	goal: GoalState,
	status: PromptGoalCoordinatorStatus,
	reason: PromptGoalCoordinatorSnapshot["reason"],
	reasonDigest?: string,
): PromptGoalCoordinatorSnapshot {
	return {
		goal,
		status,
		...(reason ? { reason } : {}),
		...(reasonDigest ? { reasonDigest } : {}),
	};
}

function gateTarget(phase: GoalPhase, decision: "passed" | "failed"): GoalPhase {
	if (decision === "failed") return "remediation";
	switch (phase) {
		case "implementation":
			return "build";
		case "build":
			return "test";
		case "test":
			return "security_review";
		case "security_review":
			return "independent_review";
		case "independent_review":
		case "reverification":
			return "awaiting_verification";
		case "remediation":
			return "reverification";
		case "awaiting_verification":
			return "completed";
		default:
			return phase;
	}
}

export class PromptGoalCoordinator {
	readonly #goal: DurableGoalStateMachine;
	readonly #tasks: SessionTaskRepository;
	readonly #plans: ApprovedPlanEvidencePort;
	readonly #candidates: CandidateSnapshotPort;
	readonly #gates: GoalGatePort;
	readonly #taskReferences: TaskDagValidationPorts;
	readonly #completionEnabled: () => boolean;
	#approvedPlan: ApprovedPlanRef | undefined;
	#taskDagDigest: string | undefined;
	#last: PromptGoalCoordinatorSnapshot;
	#serial: Promise<void> = Promise.resolve();

	public constructor(options: PromptGoalCoordinatorOptions) {
		this.#goal = options.goal;
		this.#tasks = options.tasks;
		this.#plans = options.plans;
		this.#candidates = options.candidates;
		this.#gates = options.gates;
		this.#taskReferences = options.taskReferences;
		this.#completionEnabled = options.completionEnabled;
		this.#last = waiting(this.#goal.snapshot(), "progressed", undefined);
	}

	#exclusive<T>(operation: () => Promise<OrchestratorResult<T>>): Promise<OrchestratorResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(() => undefined, () => undefined);
		return result;
	}

	public snapshot(): PromptGoalCoordinatorSnapshot {
		return structuredClone(this.#last);
	}

	async #approved(): Promise<OrchestratorResult<Extract<ApprovedPlanEvidence, { status: "approved" }>>> {
		const loaded = await this.#plans.load(this.#goal.snapshot().goalId);
		if (!loaded.ok) return loaded;
		if (loaded.value.status !== "approved") {
			return {
				ok: false,
				error: {
					code: "reference_unavailable",
					message: `approved Plan is ${loaded.value.status}`,
					retryable: loaded.value.status === "missing",
				},
			};
		}
		const plan = loaded.value;
		if (
			plan.taskDag.goalId !== this.#goal.snapshot().goalId ||
			plan.taskDag.revision !== plan.approvedPlan.revision ||
			plan.taskDagDigest !== canonicalDigest(plan.taskDag) ||
			plan.approvalEvidence.kind !== "plan_approval" ||
			plan.approvalEvidence.outcome !== "pass" ||
			plan.approvalEvidence.receiptId !== plan.approvedPlan.approvalReceipt.receiptId ||
			plan.approvalEvidence.digest !== plan.approvedPlan.approvalReceipt.receiptDigest
		) {
			return {
				ok: false,
				error: { code: "invalid_dag", message: "approved Plan evidence does not bind the Task DAG", retryable: false },
			};
		}
		return { ok: true, value: plan };
	}

	async #importTasks(plan: Extract<ApprovedPlanEvidence, { status: "approved" }>): Promise<OrchestratorResult<void>> {
		const validated = await validateTaskDag(plan.taskDag, this.#taskReferences);
		if (!validated.ok) return validated;
		let projection = await this.#tasks.load();
		if (!projection.ok) return projection;
		if (projection.value.goalId && projection.value.goalId !== plan.taskDag.goalId) {
			return {
				ok: false,
				error: { code: "invalid_dag", message: "task repository belongs to another Goal", retryable: false },
			};
		}
		const byId = new Map(plan.taskDag.tasks.map((task) => [task.taskId, task]));
		for (const existing of projection.value.tasks) {
			const planned = byId.get(existing.definition.taskId);
			if (
				!planned ||
				canonicalDigest(createCanonicalTaskDefinition(plan.taskDag.goalId, planned)) !==
					canonicalDigest(existing.definition)
			) {
				return {
					ok: false,
					error: { code: "invalid_dag", message: "canonical tasks diverge from the approved Plan", retryable: false },
				};
			}
		}
		for (const taskId of validated.value.topologicalOrder) {
			if (projection.value.tasks.some((task) => task.definition.taskId === taskId)) continue;
			const task = byId.get(taskId);
			if (!task) {
				return {
					ok: false,
					error: { code: "invalid_dag", message: "validated Task DAG lost a task", retryable: false },
				};
			}
			projection = await this.#tasks.create({
				expectedRevision: projection.value.revision,
				idempotencyKey: createIdempotencyKey(
					`approved-plan-task-${canonicalDigest({ taskDagDigest: plan.taskDagDigest, taskId }).slice(0, 48)}`,
				),
				task: createCanonicalTaskDefinition(plan.taskDag.goalId, task),
			});
			if (!projection.ok) return projection;
		}
		this.#approvedPlan = structuredClone(plan.approvedPlan);
		this.#taskDagDigest = plan.taskDagDigest;
		return { ok: true, value: undefined };
	}

	async #recoverApprovedPlan(): Promise<OrchestratorResult<ApprovedPlanRef>> {
		const approved = await this.#approved();
		if (!approved.ok) return approved;
		const imported = await this.#importTasks(approved.value);
		return imported.ok
			? { ok: true, value: structuredClone(approved.value.approvedPlan) }
			: imported;
	}

	async #step(): Promise<OrchestratorResult<PromptGoalCoordinatorSnapshot>> {
		const goal = this.#goal.snapshot();
		if (goal.phase === "completed" || goal.phase === "failed" || goal.phase === "stopped") {
			return { ok: true, value: waiting(goal, goal.phase, undefined) };
		}
		if (goal.phase === "awaiting_human") {
			return { ok: true, value: waiting(goal, "waiting", "gate_pending") };
		}
		if (goal.phase === "planning") {
			const plan = await this.#plans.load(goal.goalId);
			if (!plan.ok) return plan;
			if (plan.value.status === "missing" || plan.value.status === "unsupported") {
				return {
					ok: true,
					value: waiting(goal, "waiting", "plan_missing", plan.value.reasonDigest),
				};
			}
			if (!("planEvidence" in plan.value)) {
				return {
					ok: true,
					value: waiting(goal, "waiting", "plan_missing", plan.value.reasonDigest),
				};
			}
			const transitioned = await this.#goal.transition({
				to: "awaiting_plan_approval",
				actor: "runtime",
				expectedRevision: goal.revision,
				evidence: [plan.value.planEvidence],
			}, idempotency(goal, "await-plan-approval", plan.value.planEvidence));
			return transitioned.ok
				? { ok: true, value: waiting(transitioned.value, "progressed", undefined) }
				: transitioned;
		}
		if (goal.phase === "awaiting_plan_approval") {
			const plan = await this.#plans.load(goal.goalId);
			if (!plan.ok) return plan;
			if (plan.value.status !== "approved") {
				const reasonDigest = "reasonDigest" in plan.value ? plan.value.reasonDigest : undefined;
				return {
					ok: true,
					value: waiting(goal, "awaiting_plan_approval", "plan_missing", reasonDigest),
				};
			}
			const imported = await this.#importTasks(plan.value);
			if (!imported.ok) return imported;
			const transitioned = await this.#goal.transition({
				to: "implementation",
				actor: "runtime",
				expectedRevision: goal.revision,
				evidence: [plan.value.approvalEvidence],
			}, idempotency(goal, "approved-plan", plan.value.approvalEvidence));
			return transitioned.ok
				? { ok: true, value: waiting(transitioned.value, "progressed", undefined) }
				: transitioned;
		}
		const approved = this.#approvedPlan
			? { ok: true as const, value: this.#approvedPlan }
			: await this.#recoverApprovedPlan();
		if (!approved.ok) return approved;
		this.#approvedPlan = structuredClone(approved.value);
		const candidate = await this.#candidates.current(goal.goalId);
		if (!candidate.ok) return candidate;
		if (candidate.value.status !== "ready") {
			return {
				ok: true,
				value: waiting(
					goal,
					"waiting",
					candidate.value.status === "external_gap" ? "external_gap" : "dependency_unavailable",
					candidate.value.reasonDigest,
				),
			};
		}
		if (goal.phase === "awaiting_verification" && !this.#completionEnabled()) {
			return {
				ok: true,
				value: waiting(goal, "waiting", "external_gap", canonicalDigest("production completion is not ready")),
			};
		}
		const evaluated = await this.#gates.evaluate({
			goal,
			phase: goal.phase,
			approvedPlan: approved.value,
			candidate: candidate.value,
		});
		if (!evaluated.ok) return evaluated;
		if (evaluated.value.status === "pending" || evaluated.value.status === "unsupported" ||
			evaluated.value.status === "external_gap") {
			return {
				ok: true,
				value: waiting(
					goal,
					"waiting",
					evaluated.value.status === "external_gap" ? "external_gap" : "gate_pending",
					evaluated.value.reasonDigest,
				),
			};
		}
		if (!("evidence" in evaluated.value)) {
			return {
				ok: false,
				error: { code: "invalid_input", message: "terminal gate decision has no evidence", retryable: false },
			};
		}
		const target = gateTarget(goal.phase, evaluated.value.status);
		const transitioned = await this.#goal.transition({
			to: target,
			actor: target === "completed" ? "trusted_verifier" : "runtime",
			expectedRevision: goal.revision,
			evidence: evaluated.value.evidence,
		}, idempotency(goal, `gate-${target}`, evaluated.value.evidence));
		return transitioned.ok
			? { ok: true, value: waiting(transitioned.value, "progressed", undefined) }
			: transitioned;
	}

	public run(): Promise<OrchestratorResult<PromptGoalCoordinatorSnapshot>> {
		return this.#exclusive(async () => {
			for (let step = 0; step < 32; step += 1) {
				const next = await this.#step();
				if (!next.ok) return next;
				this.#last = {
					...next.value,
					...(this.#approvedPlan ? { approvedPlan: structuredClone(this.#approvedPlan) } : {}),
					...(this.#taskDagDigest ? { taskDagDigest: this.#taskDagDigest } : {}),
				};
				if (next.value.status !== "progressed") return { ok: true, value: this.snapshot() };
			}
			return {
				ok: false,
				error: { code: "loop_broken", message: "goal coordinator exceeded its deterministic stage bound", retryable: false },
			};
		});
	}

	public resume(): Promise<OrchestratorResult<PromptGoalCoordinatorSnapshot>> {
		return this.run();
	}
}
