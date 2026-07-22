import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	GOAL_TRANSITION_TABLE,
	createDurableGoalStateMachine,
	transitionGoal,
} from "../../../src/runtime/orchestrator/goal-state-machine.ts";
import type { GoalJournalRecord } from "../../../src/runtime/orchestrator/goal-state-machine.ts";
import { GOAL_PHASES, type CompletionTrustPort, type GoalEvidence, type GoalState } from "../../../src/runtime/orchestrator/types.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import type { EpisodeSealCompletionRef } from "../../../src/runtime/verification/types.ts";
import { digest, evidence, idempotency } from "./helpers.ts";

function state(phase: GoalState["phase"], pausedFrom?: GoalState["pausedFrom"]): GoalState {
	return {
		goalId: createRuntimeId("goal", `state-${phase}`),
		phase,
		revision: 3,
		evidence: [],
		partialResults: [],
		pausedFrom,
	};
}

function episodeSeal(): EpisodeSealCompletionRef {
	return {
		authorityId: createRuntimeId("authority", "test"),
		tenantId: createRuntimeId("tenant", "test"),
		sealId: createRuntimeId("episodeSeal", "test"),
		sealDigest: digest("a"),
		sealRecordDigest: digest("c"),
		manifestBodyDigest: digest("b"),
	};
}

function completionTrust(trusted = true): CompletionTrustPort {
	return {
		verify: async (reference) => trusted && reference.sealRecordDigest === digest("c"),
	};
}

function completionEvidence(reference = episodeSeal()): GoalEvidence {
	return {
		...evidence("verification", "pass"),
		digest: reference.sealRecordDigest,
		episodeSeal: reference,
	};
}

describe("deterministic goal state machine", () => {
	it("accepts every declared rule with its exact actor and evidence", async () => {
		const trust = completionTrust();
		for (const rule of GOAL_TRANSITION_TABLE) {
			const entries: GoalEvidence[] = rule.requiredEvidence.map((requirement) =>
				evidence(requirement.kind, requirement.outcome),
			);
			if (rule.to === "completed") {
				const index = entries.findIndex((entry) => entry.kind === "verification");
				entries[index] = completionEvidence();
			}
			const current = state(rule.from, rule.from === "awaiting_human" ? rule.to as GoalState["pausedFrom"] : undefined);
			const result = await transitionGoal(
				current,
				{
					to: rule.to,
					actor: rule.actors[0]!,
					expectedRevision: current.revision,
					evidence: entries,
				},
				trust,
			);
			expect(result.ok, `${rule.from} -> ${rule.to}`).toBe(true);
		}
	});

	it("rejects every phase pair absent from the transition table", async () => {
		const trust = completionTrust();
		for (const from of GOAL_PHASES) {
			for (const to of GOAL_PHASES) {
				if (GOAL_TRANSITION_TABLE.some((rule) => rule.from === from && rule.to === to)) continue;
				const result = await transitionGoal(
					state(from),
					{ to, actor: "runtime", expectedRevision: 3, evidence: [] },
					trust,
				);
				expect(result.ok, `${from} -> ${to}`).toBe(false);
			}
		}
	});

	it("rejects model-driven gates, missing evidence, revision races and terminal rewrites", async () => {
		const trust = completionTrust();
		const planning = state("planning");
		expect(
			(await transitionGoal(planning, { to: "awaiting_plan_approval", actor: "model", expectedRevision: 3, evidence: [evidence("plan", "recorded")] }, trust)).ok,
		).toBe(false);
		expect(
			(await transitionGoal(planning, { to: "awaiting_plan_approval", actor: "runtime", expectedRevision: 3, evidence: [] }, trust)).ok,
		).toBe(false);
		expect(
			(await transitionGoal(planning, { to: "awaiting_plan_approval", actor: "runtime", expectedRevision: 2, evidence: [evidence("plan", "recorded")] }, trust)).ok,
		).toBe(false);
		expect(
			(await transitionGoal(state("completed"), { to: "stopped", actor: "runtime", expectedRevision: 3, evidence: [evidence("stop_request", "recorded")] }, trust)).ok,
		).toBe(false);
	});

	it("binds human resume to the exact paused phase", async () => {
		const trust = completionTrust();
		const paused = state("awaiting_human", "build");
		const wrong = await transitionGoal(
			paused,
			{ to: "implementation", actor: "human", expectedRevision: 3, evidence: [evidence("human_decision", "recorded")] },
			trust,
		);
		expect(wrong.ok).toBe(false);
		const resumed = await transitionGoal(
			paused,
			{ to: "build", actor: "human", expectedRevision: 3, evidence: [evidence("human_decision", "recorded")] },
			trust,
		);
		expect(resumed.ok && resumed.value.phase).toBe("build");
	});

	it("requires a durable trusted EpisodeSeal and rejects report-shaped or tampered evidence", async () => {
		const reference = episodeSeal();
		const blocked = await transitionGoal(
			state("awaiting_verification"),
			{ to: "completed", actor: "trusted_verifier", expectedRevision: 3, evidence: [evidence("verification", "pass")] },
			completionTrust(),
		);
		expect(blocked.ok).toBe(false);
		const untrusted = await transitionGoal(
			state("awaiting_verification"),
			{ to: "completed", actor: "trusted_verifier", expectedRevision: 3, evidence: [completionEvidence(reference)] },
			completionTrust(false),
		);
		expect(untrusted.ok).toBe(false);
		const tampered = await transitionGoal(
			state("awaiting_verification"),
			{
				to: "completed",
				actor: "trusted_verifier",
				expectedRevision: 3,
				evidence: [{ ...completionEvidence(reference), digest: digest("d") }],
			},
			completionTrust(),
		);
		expect(tampered.ok).toBe(false);

		const completed = await transitionGoal(
			state("awaiting_verification"),
			{ to: "completed", actor: "trusted_verifier", expectedRevision: 3, evidence: [completionEvidence(reference)] },
			completionTrust(),
		);
		expect(completed.ok && completed.value.phase).toBe("completed");
	});

	it("replays durable phase exactly and deduplicates transition commands after restart", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<GoalJournalRecord>();
		const initial: GoalState = {
			goalId: createRuntimeId("goal", "durable"),
			phase: "planning",
			revision: 0,
			evidence: [],
			partialResults: [],
		};
		const options = { journal, completionTrust: completionTrust() };
		const created = await createDurableGoalStateMachine(options, initial, idempotency("goal-create"));
		if (!created.ok) throw new Error(created.error.message);
		const transitionKey = idempotency("goal-transition");
		const request = {
			to: "awaiting_plan_approval" as const,
			actor: "runtime" as const,
			expectedRevision: 0,
			evidence: [evidence("plan", "recorded")],
		};
		const transitioned = await created.value.transition(request, transitionKey);
		expect(transitioned.ok && transitioned.value.phase).toBe("awaiting_plan_approval");

		const recovered = await createDurableGoalStateMachine(options, initial, idempotency("ignored-create"));
		expect(recovered.ok && recovered.value.snapshot().phase).toBe("awaiting_plan_approval");
		if (!recovered.ok) return;
		const duplicate = await recovered.value.transition(request, transitionKey);
		expect(duplicate.ok && duplicate.value.revision).toBe(1);
		const conflicting = await recovered.value.transition(
			{ ...request, evidence: [evidence("plan", "recorded")] },
			transitionKey,
		);
		expect(conflicting.ok).toBe(false);
		const raw = await journal.load();
		expect(raw.ok && raw.value.transactions).toHaveLength(2);
	});
});
