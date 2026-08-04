import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ProcessCompletionEnvelope } from "../../../src/runtime/process/types.ts";
import { JsonlProcessCompletionQueue } from "../../../src/storage/process/completion-queue.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function item(seed: string, sessionSeed = "queue"): ProcessCompletionEnvelope {
	const handle = {
		authorityId: createRuntimeId("authority", "queue"),
		tenantId: createRuntimeId("tenant", "queue"),
		workspaceId: createRuntimeId("workspace", "queue"),
		sessionId: createRuntimeId("session", sessionSeed),
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: createRuntimeId("execution", seed),
		attemptId: createRuntimeId("attempt", `${seed}_1`),
		revision: 2,
		requestDigest: digest("request"),
	};
	return {
		deliveryKey: `delivery-${seed}`,
		origin: "automatic_follow_up",
		handle,
		terminalSequence: 3,
		summary: {
			handle,
			state: "completed",
			outputCursor: { sequence: 1, byteOffset: 4 },
			outputSize: 4,
			capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true },
		},
		preview: `done-${seed}`,
			nextCursor: { sequence: 1, byteOffset: 4 },
		policyDigest: digest("policy"),
		budgetDigest: digest("budget"),
	};
}

describe("R8 durable process completion queue", () => {
	it("deduplicates delivery keys, survives reload, and recovers interrupted claims", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-completion-queue-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "a".repeat(64), maxItems: 4, maxBytes: 16_384 };
			const queue = new JsonlProcessCompletionQueue(options);
			const first = item("one");
			expect(await queue.enqueue(first)).toMatchObject({ ok: true, item: { envelope: { deliveryKey: first.deliveryKey } } });
			expect(await queue.enqueue(first)).toMatchObject({ ok: true, item: { envelope: { deliveryKey: first.deliveryKey } } });
			expect(await queue.enqueue({ ...first, preview: "conflict" })).toEqual({ ok: false, code: "delivery_key_conflict" });
			const claimed = await queue.claim(1);
			expect(claimed).toMatchObject({ ok: true, items: [{ envelope: { deliveryKey: first.deliveryKey } }] });
			if (!claimed.ok) return;
			expect(await queue.requeueClaimed(claimed.items[0]!.itemId)).toMatchObject({ ok: true });
			const reloaded = new JsonlProcessCompletionQueue(options);
			const claimedAgain = await reloaded.claim(1);
			expect(claimedAgain).toMatchObject({ ok: true, items: [{ envelope: { deliveryKey: first.deliveryKey } }] });
			if (!claimedAgain.ok) return;
			expect(await reloaded.consume(claimedAgain.items[0]!.itemId)).toMatchObject({ ok: true });
			expect(await new JsonlProcessCompletionQueue(options).pending()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("enforces bounded queue capacity before appending another completion", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-completion-queue-cap-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const queue = new JsonlProcessCompletionQueue({ layout, workspaceStorageKey: "ws-" + "b".repeat(64), maxItems: 1, maxBytes: 4_096 });
			expect((await queue.enqueue(item("one"))).ok).toBe(true);
			expect(await queue.enqueue(item("two"))).toEqual({ ok: false, code: "queue_capacity_exceeded" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("claims and lists only the session assigned to a Host completion bridge", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-completion-queue-scope-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const queue = new JsonlProcessCompletionQueue({ layout, workspaceStorageKey: "ws-" + "c".repeat(64) });
			await queue.enqueue(item("first", "one"));
			await queue.enqueue(item("second", "two"));
			expect((await queue.pending("session_one")).map((entry) => entry.envelope.deliveryKey)).toEqual(["delivery-first"]);
			expect((await queue.claim(4, "session_two"))).toMatchObject({ ok: true, items: [{ envelope: { deliveryKey: "delivery-second" } }] });
			expect((await queue.pending("session_one")).map((entry) => entry.envelope.deliveryKey)).toEqual(["delivery-first"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
