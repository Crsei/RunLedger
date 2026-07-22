/** Orchestrator 对 Session Kernel canonical queue 的只转发 adapter。 */

import type { AgentMessage } from "../types.ts";
import type {
	AgentLoopSessionEvents,
	DurableQueueCancellationResult,
	DurableQueueCancellationTarget,
	DurableQueueEnqueueOptions,
	DurableQueueKind,
	DurableQueueReceipt,
	DurableQueueStateSnapshot,
} from "../session/agent-loop-events.ts";
import type { CommandId } from "../protocol/v3/ids.ts";

export interface CanonicalQueueEventPort {
	inspectQueue(): Promise<DurableQueueStateSnapshot>;
	enqueueWithReceipt(
		kind: DurableQueueKind,
		message: AgentMessage,
		options?: DurableQueueEnqueueOptions,
	): Promise<DurableQueueReceipt>;
	cancelQueueItems(
		expectedQueueRevision: string,
		targets: readonly DurableQueueCancellationTarget[],
		reason: string,
		cancellationCommandId: CommandId,
	): Promise<DurableQueueCancellationResult>;
}

/** 不保存 queue 状态；所有读取和 mutation 都委托给 AgentLoopSessionEvents。 */
export class CanonicalAgentQueueAdapter {
	readonly #events: CanonicalQueueEventPort;

	public constructor(events: AgentLoopSessionEvents | CanonicalQueueEventPort) {
		this.#events = events;
	}

	public inspect(): Promise<DurableQueueStateSnapshot> {
		return this.#events.inspectQueue();
	}

	public enqueue(
		kind: DurableQueueKind,
		message: AgentMessage,
		options?: DurableQueueEnqueueOptions,
	): Promise<DurableQueueReceipt> {
		return this.#events.enqueueWithReceipt(kind, message, options);
	}

	public cancel(
		expectedQueueRevision: string,
		targets: readonly DurableQueueCancellationTarget[],
		reason: string,
		cancellationCommandId: CommandId,
	): Promise<DurableQueueCancellationResult> {
		return this.#events.cancelQueueItems(
			expectedQueueRevision,
			targets,
			reason,
			cancellationCommandId,
		);
	}
}
