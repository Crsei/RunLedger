import { describe, expect, it } from "vitest";
import {
	validatePhase11ProductionEffectBinding,
	type Phase11ProductionEffectBinding,
} from "../../../src/daemon/composition-root.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";
import type {
	ChangeProposalControlPlanePort,
	HumanGateControlPlanePort,
} from "../../../src/runtime/control-plane/types.ts";

const changeProposals = {} as ChangeProposalControlPlanePort;
const humanGates = {} as HumanGateControlPlanePort;

describe("Phase 11 production daemon binding", () => {
	it("requires advertised proposal/human-gate effects to share journal, generation and shutdown authority", () => {
		const idempotency = new InMemoryCommandIdempotencyRepository();
		const mutationGate = new ShutdownCoordinator();
		const runtimeGeneration = () => 4;
		const binding: Phase11ProductionEffectBinding = {
			matchesProductionBinding: (candidate) =>
				candidate.idempotency === idempotency &&
				candidate.mutationGate === mutationGate &&
				candidate.runtimeGeneration === runtimeGeneration &&
				candidate.expectedRuntimeGeneration === 4 &&
				candidate.changeProposals === changeProposals &&
				candidate.humanGates === humanGates,
		};
		expect(validatePhase11ProductionEffectBinding({
			features: ["change_proposal", "human_gate"],
			idempotency,
			mutationGate,
			runtimeGeneration,
			expectedRuntimeGeneration: 4,
			changeProposals,
			humanGates,
			binding,
		})).toEqual({ ok: true, value: undefined });
		expect(validatePhase11ProductionEffectBinding({
			features: ["change_proposal", "human_gate"],
			idempotency,
			mutationGate,
			runtimeGeneration,
			expectedRuntimeGeneration: 5,
			changeProposals,
			humanGates,
			binding,
		})).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
	});

	it("keeps absent external adapters non-advertised without requiring placeholder receipts", () => {
		expect(validatePhase11ProductionEffectBinding({
			features: ["session", "health"],
			expectedRuntimeGeneration: 1,
		})).toEqual({ ok: true, value: undefined });
		expect(validatePhase11ProductionEffectBinding({
			features: ["change_proposal"],
			expectedRuntimeGeneration: 1,
			changeProposals,
		})).toMatchObject({ ok: false, error: { code: "adapter_contract_violation" } });
	});
});
