/** 由 Runtime gate 驱动的确定性 Goal 状态机。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import type {
	CompletionTrustPort,
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	GoalEvidence,
	GoalEvidenceKind,
	GoalEvidenceOutcome,
	GoalPhase,
	GoalState,
	GoalTransitionActor,
	GoalTransitionRequest,
	OrchestratorResult,
} from "./types.ts";
import type { EpisodeSealCompletionRef } from "../verification/types.ts";

export interface GoalEvidenceRequirement {
	kind: GoalEvidenceKind;
	outcome: GoalEvidenceOutcome;
}

export interface GoalTransitionRule {
	from: GoalPhase;
	to: GoalPhase;
	actors: readonly GoalTransitionActor[];
	requiredEvidence: readonly GoalEvidenceRequirement[];
	terminal: boolean;
}

const requirement = (kind: GoalEvidenceKind, outcome: GoalEvidenceOutcome): GoalEvidenceRequirement => ({
	kind,
	outcome,
});

const runtimeRule = (
	from: GoalPhase,
	to: GoalPhase,
	requiredEvidence: readonly GoalEvidenceRequirement[],
): GoalTransitionRule => ({ from, to, actors: ["runtime"], requiredEvidence, terminal: false });

const progressRules: readonly GoalTransitionRule[] = [
	runtimeRule("planning", "awaiting_plan_approval", [requirement("plan", "recorded")]),
	runtimeRule("awaiting_plan_approval", "implementation", [requirement("plan_approval", "pass")]),
	{
		from: "awaiting_plan_approval",
		to: "planning",
		actors: ["human"],
		requiredEvidence: [requirement("plan_approval", "fail")],
		terminal: false,
	},
	runtimeRule("implementation", "build", [requirement("implementation", "recorded")]),
	runtimeRule("build", "test", [requirement("build", "pass")]),
	runtimeRule("build", "remediation", [requirement("build", "fail"), requirement("finding", "recorded")]),
	runtimeRule("test", "security_review", [requirement("test", "pass")]),
	runtimeRule("test", "remediation", [requirement("test", "fail"), requirement("finding", "recorded")]),
	runtimeRule("security_review", "independent_review", [requirement("security_review", "pass")]),
	runtimeRule("security_review", "remediation", [
		requirement("security_review", "fail"),
		requirement("finding", "recorded"),
	]),
	runtimeRule("independent_review", "awaiting_verification", [
		requirement("independent_review", "pass"),
		requirement("pull_request", "pass"),
	]),
	runtimeRule("independent_review", "remediation", [
		requirement("independent_review", "fail"),
		requirement("finding", "recorded"),
	]),
	runtimeRule("remediation", "build", [requirement("remediation", "pass")]),
	runtimeRule("remediation", "reverification", [requirement("remediation", "pass")]),
	runtimeRule("reverification", "awaiting_verification", [
		requirement("build", "pass"),
		requirement("test", "pass"),
		requirement("security_review", "pass"),
		requirement("independent_review", "pass"),
		requirement("pull_request", "pass"),
		requirement("reverification", "pass"),
	]),
	runtimeRule("reverification", "remediation", [
		requirement("reverification", "fail"),
		requirement("finding", "recorded"),
	]),
	runtimeRule("awaiting_verification", "remediation", [
		requirement("verification", "fail"),
		requirement("finding", "recorded"),
	]),
	{
		from: "awaiting_verification",
		to: "completed",
		actors: ["trusted_verifier"],
		requiredEvidence: [requirement("verification", "pass")],
		terminal: true,
	},
];

const pausablePhases: readonly GoalPhase[] = [
	"planning",
	"awaiting_plan_approval",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"remediation",
	"reverification",
	"awaiting_verification",
];

const humanResumePhases: readonly GoalPhase[] = [
	"planning",
	"awaiting_plan_approval",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"remediation",
	"reverification",
	"awaiting_verification",
];

const terminalSourcePhases: readonly GoalPhase[] = [...pausablePhases, "awaiting_human"];

export const GOAL_TRANSITION_TABLE: readonly GoalTransitionRule[] = [
	...progressRules,
	...pausablePhases.map(
		(from): GoalTransitionRule => ({
			from,
			to: "awaiting_human",
			actors: ["runtime", "human"],
			requiredEvidence: [requirement("human_request", "recorded")],
			terminal: false,
		}),
	),
	...humanResumePhases.map(
		(to): GoalTransitionRule => ({
			from: "awaiting_human",
			to,
			actors: ["human"],
			requiredEvidence: [requirement("human_decision", "recorded")],
			terminal: false,
		}),
	),
	...terminalSourcePhases.flatMap((from): readonly GoalTransitionRule[] => [
		{
			from,
			to: "failed",
			actors: ["runtime"],
			requiredEvidence: [requirement("failure", "recorded")],
			terminal: true,
		},
		{
			from,
			to: "stopped",
			actors: ["runtime", "human"],
			requiredEvidence: [requirement("stop_request", "recorded")],
			terminal: true,
		},
	]),
];

export const TERMINAL_GOAL_PHASES: ReadonlySet<GoalPhase> = new Set(["completed", "failed", "stopped"]);

function findRule(from: GoalPhase, to: GoalPhase): GoalTransitionRule | undefined {
	return GOAL_TRANSITION_TABLE.find((candidate) => candidate.from === from && candidate.to === to);
}

function evidenceSatisfies(evidence: readonly GoalEvidence[], requirementEntry: GoalEvidenceRequirement): boolean {
	return evidence.some(
		(entry) => entry.kind === requirementEntry.kind && entry.outcome === requirementEntry.outcome,
	);
}

function completionSeal(evidence: readonly GoalEvidence[]): EpisodeSealCompletionRef | undefined {
	const candidates = evidence.filter((candidate) => candidate.kind === "verification" && candidate.outcome === "pass");
	if (candidates.length !== 1) return undefined;
	const entry = candidates[0];
	if (!entry?.episodeSeal) return undefined;
	if (entry.digest !== entry.episodeSeal.sealRecordDigest) return undefined;
	return entry.episodeSeal;
}

function deduplicateArtifacts(state: GoalState, request: GoalTransitionRequest): GoalState["partialResults"] {
	const byId = new Map(state.partialResults.map((artifact) => [artifact.artifactId, artifact]));
	for (const artifact of request.partialResults ?? []) byId.set(artifact.artifactId, artifact);
	return [...byId.values()];
}

/** 只有此 reducer 能产生新 GoalState；调用者不能直接写 phase。 */
export async function transitionGoal(
	state: GoalState,
	request: GoalTransitionRequest,
	completionTrust: CompletionTrustPort,
): Promise<OrchestratorResult<GoalState>> {
	if (request.expectedRevision !== state.revision) {
		return {
			ok: false,
			error: {
				code: "revision_conflict",
				message: "goal revision does not match",
				retryable: true,
				details: { expected: request.expectedRevision, actual: state.revision },
			},
		};
	}
	if (TERMINAL_GOAL_PHASES.has(state.phase)) {
		return {
			ok: false,
			error: { code: "invalid_transition", message: "terminal goal state cannot transition", retryable: false },
		};
	}
	if (request.actor === "model") {
		return {
			ok: false,
			error: { code: "invalid_transition", message: "model output cannot drive a goal transition", retryable: false },
		};
	}
	const rule = findRule(state.phase, request.to);
	if (!rule || !rule.actors.includes(request.actor)) {
		return {
			ok: false,
			error: { code: "invalid_transition", message: `${state.phase} cannot transition to ${request.to}`, retryable: false },
		};
	}
	if (
		state.phase === "awaiting_human" &&
		request.to !== "failed" &&
		request.to !== "stopped" &&
		request.to !== state.pausedFrom
	) {
		return {
			ok: false,
			error: { code: "invalid_transition", message: "human resume must return to the paused phase", retryable: false },
		};
	}
	const missing = rule.requiredEvidence.filter((entry) => !evidenceSatisfies(request.evidence, entry));
	if (missing.length > 0) {
		return {
			ok: false,
			error: {
				code: "missing_evidence",
				message: `missing gate evidence: ${missing.map((entry) => `${entry.kind}:${entry.outcome}`).join(",")}`,
				retryable: false,
			},
		};
	}
	if (request.to === "completed") {
		const seal = completionSeal(request.evidence);
		if (!seal || !(await completionTrust.verify(seal))) {
			return {
				ok: false,
				error: {
					code: "untrusted_verification",
					message: "completed requires a durable EpisodeSeal from a trusted verifier",
					retryable: false,
				},
			};
		}
	}
	const pausedFrom: GoalState["pausedFrom"] =
		request.to === "awaiting_human" &&
		state.phase !== "awaiting_human" &&
		state.phase !== "completed" &&
		state.phase !== "failed" &&
		state.phase !== "stopped"
			? state.phase
			: undefined;
	const nextState: GoalState = {
		goalId: state.goalId,
		phase: request.to,
		revision: state.revision + 1,
		evidence: [...state.evidence, ...request.evidence],
		partialResults: deduplicateArtifacts(state, request),
	};
	if (pausedFrom) nextState.pausedFrom = pausedFrom;
	return { ok: true, value: nextState };
}

export type GoalJournalRecord =
	| { kind: "goal.created"; state: GoalState; stateDigest: string; createdAt: string }
	| {
			kind: "goal.transitioned";
			request: GoalTransitionRequest;
			state: GoalState;
			stateDigest: string;
			transitionedAt: string;
	  };

export interface DurableGoalStateMachineOptions {
	journal: DurableOrchestratorJournalPort<GoalJournalRecord>;
	completionTrust: CompletionTrustPort;
	clock?: () => Date;
}

async function replayGoalJournal(
	snapshot: DurableJournalSnapshot<GoalJournalRecord>,
	completionTrust: CompletionTrustPort,
): Promise<OrchestratorResult<GoalState>> {
	let state: GoalState | undefined;
	for (const transaction of snapshot.transactions) {
		for (const record of transaction.records) {
			if (record.stateDigest !== canonicalDigest(record.state)) {
				return { ok: false, error: { code: "invalid_input", message: "goal state digest mismatch", retryable: false } };
			}
			if (record.kind === "goal.created") {
				if (state || record.state.phase !== "planning" || record.state.revision !== 0) {
					return { ok: false, error: { code: "invalid_input", message: "goal journal genesis is invalid", retryable: false } };
				}
				state = record.state;
			} else {
				if (!state) return { ok: false, error: { code: "invalid_input", message: "goal transition precedes genesis", retryable: false } };
				const transitioned = await transitionGoal(state, record.request, completionTrust);
				if (!transitioned.ok) return transitioned;
				if (canonicalDigest(transitioned.value) !== record.stateDigest) {
					return { ok: false, error: { code: "invalid_input", message: "goal transition replay diverged", retryable: false } };
				}
				state = record.state;
			}
		}
	}
	return state
		? { ok: true, value: state }
		: { ok: false, error: { code: "invalid_input", message: "goal journal has no genesis", retryable: false } };
}

export class DurableGoalStateMachine {
	private readonly journal: DurableOrchestratorJournalPort<GoalJournalRecord>;
	private readonly completionTrust: CompletionTrustPort;
	private readonly clock: () => Date;
	private state: GoalState;
	private serial: Promise<void> = Promise.resolve();

	public constructor(options: DurableGoalStateMachineOptions, state: GoalState) {
		this.journal = options.journal;
		this.completionTrust = options.completionTrust;
		this.clock = options.clock ?? (() => new Date());
		this.state = state;
	}

	private exclusive<T>(operation: () => Promise<OrchestratorResult<T>>): Promise<OrchestratorResult<T>> {
		const result = this.serial.then(operation);
		this.serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	public snapshot(): GoalState {
		return {
			...this.state,
			evidence: [...this.state.evidence],
			partialResults: [...this.state.partialResults],
		};
	}

	public transition(
		request: GoalTransitionRequest,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<GoalState>> {
		return this.exclusive(async () => {
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const loaded = await this.journal.load();
				if (!loaded.ok) return loaded;
				const replayed = await replayGoalJournal(loaded.value, this.completionTrust);
				if (!replayed.ok) return replayed;
				this.state = replayed.value;
				const previous = loaded.value.transactions.find((transaction) => transaction.idempotencyKey === idempotencyKey);
				if (previous) {
					const record = previous.records.find((entry) => entry.kind === "goal.transitioned");
					return record && canonicalDigest(record.request) === canonicalDigest(request)
						? { ok: true, value: record.state }
						: { ok: false, error: { code: "idempotency_conflict", message: "transition key belongs to genesis", retryable: false } };
				}
				const transitioned = await transitionGoal(this.state, request, this.completionTrust);
				if (!transitioned.ok) return transitioned;
				const now = this.clock().toISOString();
				const record: GoalJournalRecord = {
					kind: "goal.transitioned",
					request,
					state: transitioned.value,
					stateDigest: canonicalDigest(transitioned.value),
					transitionedAt: now,
				};
				const transaction: DurableJournalTransaction<GoalJournalRecord> = {
					transactionId: createRuntimeId("command"),
					idempotencyKey,
					transactionDigest: canonicalDigest([record]),
					committedAt: now,
					records: [record],
				};
				const appended = await this.journal.append(loaded.value.revision, transaction);
				if (!appended.ok) return appended;
				if (appended.value.status === "conflict") continue;
				this.state = transitioned.value;
				return { ok: true, value: this.snapshot() };
			}
			return { ok: false, error: { code: "journal_conflict", message: "goal transition CAS did not converge", retryable: true } };
		});
	}
}

export async function createDurableGoalStateMachine(
	options: DurableGoalStateMachineOptions,
	initialState: GoalState,
	idempotencyKey: IdempotencyKey,
): Promise<OrchestratorResult<DurableGoalStateMachine>> {
	const loaded = await options.journal.load();
	if (!loaded.ok) return loaded;
	if (loaded.value.transactions.length === 0) {
		if (initialState.phase !== "planning" || initialState.revision !== 0) {
			return { ok: false, error: { code: "invalid_input", message: "durable goal must start at planning revision 0", retryable: false } };
		}
		const now = (options.clock ?? (() => new Date()))().toISOString();
		const record: GoalJournalRecord = {
			kind: "goal.created",
			state: initialState,
			stateDigest: canonicalDigest(initialState),
			createdAt: now,
		};
		const appended = await options.journal.append(0, {
			transactionId: createRuntimeId("command"),
			idempotencyKey,
			transactionDigest: canonicalDigest([record]),
			committedAt: now,
			records: [record],
		});
		if (!appended.ok) return appended;
		if (appended.value.status === "conflict") {
			return { ok: false, error: { code: "journal_conflict", message: "goal genesis raced another writer", retryable: true } };
		}
	}
	const refreshed = await options.journal.load();
	if (!refreshed.ok) return refreshed;
	const replayed = await replayGoalJournal(refreshed.value, options.completionTrust);
	if (!replayed.ok) return replayed;
	if (replayed.value.goalId !== initialState.goalId) {
		return { ok: false, error: { code: "invalid_input", message: "goal journal belongs to another goal", retryable: false } };
	}
	return { ok: true, value: new DurableGoalStateMachine(options, replayed.value) };
}
