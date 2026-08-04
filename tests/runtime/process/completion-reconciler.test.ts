import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ProcessCompletionEnvelope } from "../../../src/runtime/process/types.ts";
import { JsonlProcessCompletionQueue } from "../../../src/storage/process/completion-queue.ts";
import { CompletionReconciler } from "../../../src/runtime/process/completion-reconciler.ts";
import { DurableAgentCompletionBridge, completionDeliveryMarker } from "../../../src/runtime/process/completion-reconciler.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";

function envelope(): ProcessCompletionEnvelope {
	const handle = {
		authorityId: createRuntimeId("authority", "reconcile"),
		tenantId: createRuntimeId("tenant", "reconcile"),
		workspaceId: createRuntimeId("workspace", "reconcile"),
		sessionId: createRuntimeId("session", "reconcile"),
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: createRuntimeId("execution", "reconcile"),
		attemptId: createRuntimeId("attempt", "reconcile_1"),
		revision: 3,
		requestDigest: runtimeDigest("request"),
	};
	return {
		deliveryKey: "completion-reconcile",
		origin: "automatic_follow_up",
		handle,
		terminalSequence: 3,
		summary: { handle, state: "completed", outputCursor: { sequence: 1, byteOffset: 4 }, outputSize: 4, capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true }, terminal: { state: "completed", evidenceRef: { subjectKind: "receipt", digest: runtimeDigest("evidence") } } },
		nextCursor: { sequence: 1, byteOffset: 4 },
		policyDigest: runtimeDigest("policy"),
		budgetDigest: runtimeDigest("budget"),
	};
}

describe("R8 completion delivery reconciler", () => {
	it("suppresses an automatic Queue item when explicit tool delivery is durable", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-reconcile-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "a".repeat(64) };
			const queue = new JsonlProcessCompletionQueue(options);
			const reconciler = new CompletionReconciler(queue);
			const automatic = envelope();
			expect((await reconciler.enqueueAutomatic(automatic)).ok).toBe(true);
			expect((await queue.pending())).toHaveLength(1);
			const explicit = { ...automatic, origin: "explicit_wait" as const };
			expect(await reconciler.commitExplicit(explicit)).toMatchObject({ ok: true, suppressed: true });
			expect(await queue.pending()).toEqual([]);
			expect(await reconciler.commitExplicit(explicit)).toMatchObject({ ok: true });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("durably suppresses a later automatic item when explicit delivery wins the race", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-reconcile-before-auto-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "b".repeat(64) };
			const queue = new JsonlProcessCompletionQueue(options);
			const reconciler = new CompletionReconciler(queue);
			const explicit = { ...envelope(), origin: "explicit_wait" as const };
			expect(await reconciler.commitExplicit(explicit)).toMatchObject({ ok: true, suppressed: true });
			expect(await reconciler.enqueueAutomatic(envelope())).toMatchObject({ ok: true });
			expect(await queue.pending()).toEqual([]);

			const recoveredQueue = new JsonlProcessCompletionQueue(options);
			expect(await new CompletionReconciler(recoveredQueue).enqueueAutomatic(envelope())).toMatchObject({ ok: true });
			expect(await recoveredQueue.pending()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("defers automatic completion while an Agent turn or user input is active", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-reconcile-deferred-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const queue = new JsonlProcessCompletionQueue({ layout, workspaceStorageKey: "ws-" + "c".repeat(64) });
			const reconciler = new CompletionReconciler(queue);
			await queue.enqueue(envelope());
			let deliveries = 0;
			const agent = {
				isTurnActive: () => true,
				hasPendingUserInput: () => false,
				hasDurableDelivery: async () => "absent" as const,
				deliverCompletionBatch: async () => { deliveries += 1; return { ok: true as const }; },
			};
			expect(await reconciler.reconcile(agent)).toEqual({ ok: true, outcome: "deferred_active_turn", delivered: 0 });
			expect(deliveries).toBe(0);
			expect(await queue.pending()).toHaveLength(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("delivers an idle completion batch once and consumes every Queue claim", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-reconcile-batch-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const queue = new JsonlProcessCompletionQueue({ layout, workspaceStorageKey: "ws-" + "d".repeat(64) });
			const reconciler = new CompletionReconciler(queue);
			const first = envelope();
			const second = { ...envelope(), deliveryKey: "completion-reconcile-2" };
			await queue.enqueue(first);
			await queue.enqueue(second);
			const batches: string[][] = [];
			const agent = {
				isTurnActive: () => false,
				hasPendingUserInput: () => false,
				hasDurableDelivery: async () => "absent" as const,
				deliverCompletionBatch: async (items: readonly { readonly deliveryKey: string }[]) => {
					batches.push(items.map((item) => item.deliveryKey));
					return { ok: true as const };
				},
			};
			expect(await reconciler.reconcile(agent)).toEqual({ ok: true, outcome: "delivered", delivered: 2 });
			expect(batches).toEqual([[first.deliveryKey, second.deliveryKey]]);
			expect(await queue.pending()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("consumes a claimed completion after response loss when Agent input is already durable", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-reconcile-recovery-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "e".repeat(64) };
			const queue = new JsonlProcessCompletionQueue(options);
			const reconciler = new CompletionReconciler(queue);
			const value = envelope();
			await queue.enqueue(value);
			const claimed = await queue.claim(1);
			if (!claimed.ok) throw new Error("claim failed");
			let deliveries = 0;
			const agent = {
				isTurnActive: () => false,
				hasPendingUserInput: () => false,
				hasDurableDelivery: async (deliveryKey: string) => deliveryKey === value.deliveryKey ? "committed" as const : "absent" as const,
				deliverCompletionBatch: async () => { deliveries += 1; return { ok: true as const }; },
			};
			expect(await reconciler.reconcile(agent)).toEqual({ ok: true, outcome: "recovered", delivered: 1 });
			expect(deliveries).toBe(0);
			expect(await new JsonlProcessCompletionQueue(options).pending()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses a durable Agent message marker to recover a response-loss delivery without re-prompting", async () => {
		const ledger = new MemoryLedger({ sessionId: "session_completion_bridge" });
		let prompts = 0;
		const agent = {
			inFlight: false,
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
			ledger,
			prompt: async (input: string) => {
				prompts += 1;
				ledger.append({
					id: `message-${prompts}`,
					parentId: "",
					timestamp: Date.now(),
					type: "message",
					payload: { role: "user", content: input },
					sessionId: ledger.sessionId,
				});
				throw new Error("provider response lost after Agent input commit");
			},
		};
		const bridge = new DurableAgentCompletionBridge(agent);
		const value = envelope();
		expect(await bridge.deliverCompletionBatch([value])).toEqual({ ok: false, code: "delivery_uncertain" });
		expect(prompts).toBe(1);
		expect(await bridge.hasDurableDelivery(value.deliveryKey)).toBe("committed");
		expect((await bridge.hasDurableDelivery(value.deliveryKey)) === "committed").toBe(true);
		expect(completionDeliveryMarker(value.deliveryKey)).toContain(value.deliveryKey);
	});
});
