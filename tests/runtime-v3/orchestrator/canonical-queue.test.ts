import { describe, expect, it } from "vitest";
import { CanonicalAgentQueueAdapter, type CanonicalQueueEventPort } from "../../../src/runtime/orchestrator/canonical-queue.ts";
import type {
	DurableQueueCancellationResult,
	DurableQueueCancellationTarget,
	DurableQueueEnqueueOptions,
	DurableQueueKind,
	DurableQueueReceipt,
	DurableQueueStateSnapshot,
} from "../../../src/runtime/session/agent-loop-events.ts";
import type { AgentMessage } from "../../../src/runtime/types.ts";
import type { CommandId } from "../../../src/runtime/protocol/v3/ids.ts";

class RecordingCanonicalQueue implements CanonicalQueueEventPort {
	public readonly calls: string[] = [];
	public readonly snapshot: DurableQueueStateSnapshot = { queueRevision: "a".repeat(64), items: [] };

	public async inspectQueue(): Promise<DurableQueueStateSnapshot> {
		this.calls.push("inspect");
		return this.snapshot;
	}

	public async enqueueWithReceipt(
		_kind: DurableQueueKind,
		_message: AgentMessage,
		_options?: DurableQueueEnqueueOptions,
	): Promise<DurableQueueReceipt> {
		this.calls.push("enqueue");
		throw new Error("forwarded enqueue sentinel");
	}

	public async cancelQueueItems(
		_expectedQueueRevision: string,
		_targets: readonly DurableQueueCancellationTarget[],
		_reason: string,
		_cancellationCommandId: CommandId,
	): Promise<DurableQueueCancellationResult> {
		this.calls.push("cancel");
		throw new Error("forwarded cancel sentinel");
	}
}

describe("CanonicalAgentQueueAdapter", () => {
	it("keeps no queue state and forwards every operation to AgentLoopSessionEvents", async () => {
		const events = new RecordingCanonicalQueue();
		const queue = new CanonicalAgentQueueAdapter(events);
		expect(await queue.inspect()).toBe(events.snapshot);
		await expect(queue.enqueue("steer", {
			role: "user",
			content: [{ type: "text", text: "queued" }],
		})).rejects.toThrow("forwarded enqueue sentinel");
		await expect(queue.cancel("a".repeat(64), [], "cancel", "command_cancel" as CommandId))
			.rejects.toThrow("forwarded cancel sentinel");
		expect(events.calls).toEqual(["inspect", "enqueue", "cancel"]);
	});
});
