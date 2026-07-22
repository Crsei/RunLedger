import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { openSavePointCoordinator } from "../../../src/runtime/orchestrator/save-point.ts";
import type { SavePointJournalRecord } from "../../../src/runtime/orchestrator/types.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import { bindings, digest, idempotency } from "./helpers.ts";

describe("operation save points", () => {
	it("freezes active dependencies and applies queued mutation only after awaited settlement", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<SavePointJournalRecord>();
		const initial = bindings("model-a");
		const opened = await openSavePointCoordinator({ initialBindings: initial, journal });
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		const coordinator = opened.value;
		const operationId = createRuntimeId("command", "operation-a");
		const begun = await coordinator.begin(operationId, idempotency("save-begin"));
		expect(begun.ok).toBe(true);
		if (!begun.ok) return;
		const queued = await coordinator.queueMutation(
			operationId,
			{
				mutationId: createRuntimeId("command", "mutation-model"),
				kind: "model",
				value: { ...initial.model, modelId: "model-b", profileId: createRuntimeId("resource", "profile-b") },
			},
			idempotency("save-mutation"),
		);
		expect(queued.ok).toBe(true);
		expect(coordinator.activeSavePoint()?.bindings.model.modelId).toBe("model-a");
		expect(coordinator.bindings().model.modelId).toBe("model-a");

		let releaseListener: (() => void) | undefined;
		const listenerWait = new Promise<void>((resolve) => {
			releaseListener = resolve;
		});
		const calls: string[] = [];
		coordinator.subscribe(async () => {
			calls.push("listener-start");
			await listenerWait;
			calls.push("listener-end");
		});
		const settlement = coordinator.settle(
			{
				operationId,
				savePoint: begun.value,
				outcome: "succeeded",
				resultDigest: digest("9"),
			},
			idempotency("save-settle"),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(calls).toEqual(["listener-start"]);
		expect(coordinator.activeSavePoint()?.operationId).toBe(operationId);
		releaseListener?.();
		expect((await settlement).ok).toBe(true);
		expect(calls).toEqual(["listener-start", "listener-end"]);
		expect(coordinator.activeSavePoint()).toBeUndefined();
		expect(coordinator.bindings().model.modelId).toBe("model-a");

		const applied = await coordinator.applyPendingAtSafePoint(idempotency("save-apply"));
		expect(applied.ok && applied.value.model.modelId).toBe("model-b");
		const next = await coordinator.begin(createRuntimeId("command", "operation-b"), idempotency("save-next"));
		expect(next.ok && next.value.bindings.model.modelId).toBe("model-b");
	});

	it("replays active operation and pending mutations after a crash", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<SavePointJournalRecord>();
		const initial = bindings("model-a");
		const first = await openSavePointCoordinator({ initialBindings: initial, journal });
		if (!first.ok) throw new Error(first.error.message);
		const operationId = createRuntimeId("command", "crash-operation");
		const begun = await first.value.begin(operationId, idempotency("crash-begin"));
		if (!begun.ok) throw new Error(begun.error.message);
		await first.value.queueMutation(
			operationId,
			{
				mutationId: createRuntimeId("command", "crash-mutation"),
				kind: "config",
				value: { revision: 2, configDigest: digest("8") },
			},
			idempotency("crash-mutation"),
		);

		const recovered = await openSavePointCoordinator({ initialBindings: initial, journal });
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.value.activeSavePoint()?.savePointId).toBe(begun.value.savePointId);
		const competing = await recovered.value.begin(createRuntimeId("command", "other"), idempotency("crash-other"));
		expect(competing.ok).toBe(false);
		await recovered.value.settle(
			{ operationId, savePoint: begun.value, outcome: "succeeded", resultDigest: digest("7") },
			idempotency("crash-settle"),
		);
		const applied = await recovered.value.applyPendingAtSafePoint(idempotency("crash-apply"));
		expect(applied.ok && applied.value.config.revision).toBe(2);
	});

	it("keeps an operation active when any awaited listener rejects", async () => {
		const journal = new InMemoryDurableOrchestratorJournal<SavePointJournalRecord>();
		const opened = await openSavePointCoordinator({ initialBindings: bindings(), journal });
		if (!opened.ok) throw new Error(opened.error.message);
		const operationId = createRuntimeId("command", "listener-operation");
		const begun = await opened.value.begin(operationId, idempotency("listener-begin"));
		if (!begun.ok) throw new Error(begun.error.message);
		opened.value.subscribe(() => {
			throw new Error("listener failed");
		});
		const settled = await opened.value.settle(
			{ operationId, savePoint: begun.value, outcome: "failed", resultDigest: digest("6") },
			idempotency("listener-settle"),
		);
		expect(settled.ok).toBe(false);
		expect(opened.value.activeSavePoint()?.operationId).toBe(operationId);
	});
});
