import { describe, expect, it } from "vitest";
import {
	validatePlanContextMemoryProductionBinding,
} from "../../../src/daemon/composition-root.ts";
import { controlPlaneFailure } from "../../../src/runtime/control-plane/errors.ts";
import { InMemoryCommandIdempotencyRepository } from "../../../src/runtime/control-plane/idempotency.ts";
import {
	JournaledPlanContextMemoryControlPlaneAdapter,
} from "../../../src/runtime/control-plane/plan-context-memory-control-plane.ts";
import { ShutdownCoordinator } from "../../../src/runtime/control-plane/shutdown.ts";

function adapter(
	idempotency: InMemoryCommandIdempotencyRepository,
	gate: ShutdownCoordinator,
	generation: number,
) {
	return new JournaledPlanContextMemoryControlPlaneAdapter({
		handles: { validate: () => ({ ok: true, value: undefined }) },
		mutationGate: gate,
		mutations: {
			execute: async () => controlPlaneFailure("adapter_unavailable", "unused"),
		},
		queries: {
			query: async () => controlPlaneFailure("adapter_unavailable", "unused"),
		},
		idempotency,
		runtimeGeneration: () => generation,
	});
}

describe("Plan/Context/Memory production daemon binding", () => {
	it("requires one shared command journal, shutdown gate, and runtime generation", () => {
		const idempotency = new InMemoryCommandIdempotencyRepository();
		const gate = new ShutdownCoordinator();
		const specialty = adapter(idempotency, gate, 7);
		expect(validatePlanContextMemoryProductionBinding({
			features: ["plan_context_memory"],
			idempotency,
			mutationGate: gate,
			runtimeGeneration: () => 7,
			expectedRuntimeGeneration: 7,
			adapter: specialty,
		})).toEqual({ ok: true, value: undefined });
		expect(validatePlanContextMemoryProductionBinding({
			features: ["plan_context_memory"],
			idempotency: new InMemoryCommandIdempotencyRepository(),
			mutationGate: gate,
			runtimeGeneration: () => 7,
			expectedRuntimeGeneration: 7,
			adapter: specialty,
		})).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
		expect(validatePlanContextMemoryProductionBinding({
			features: ["plan_context_memory"],
			idempotency,
			mutationGate: gate,
			runtimeGeneration: () => 8,
			expectedRuntimeGeneration: 8,
			adapter: specialty,
		})).toMatchObject({
			ok: false,
			error: { code: "adapter_contract_violation" },
		});
	});
});
