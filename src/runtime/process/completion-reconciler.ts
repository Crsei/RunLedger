/**
 * Durable terminal-delivery reconciler。
 *
 * Watchers and client RPCs can race. The Queue delivery key is the only
 * dedupe key; this adapter never starts an Agent turn itself. An explicit
 * wait/stop result can suppress a still-pending automatic item after the
 * tool-result range has been committed.
 */

import type { ProcessCompletionEnvelope } from "./types.ts";
import type { QueueItemId } from "../protocol/ids.ts";
import type { LedgerSink } from "../ledger/types.ts";
import { clipUtf8Output } from "./output.ts";
import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";

export interface CompletionQueuePort {
	enqueue(envelope: ProcessCompletionEnvelope): Promise<CompletionQueueMutationResult>;
	pending(sessionId?: string): Promise<readonly CompletionQueuePendingItem[]>;
	suppress(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult>;
	suppressDelivery(envelope: ProcessCompletionEnvelope): Promise<{
		readonly ok: true;
		readonly suppressed: boolean;
	} | { readonly ok: false; readonly code: string }>;
}

interface CompletionQueuePendingItem {
	readonly itemId: QueueItemId;
	readonly envelope: ProcessCompletionEnvelope;
	readonly revision: number;
}

export interface CompletionQueueClaimPort {
	claim(maxItems: number, sessionId?: string): Promise<
		| { readonly ok: true; readonly items: readonly CompletionQueuePendingItem[] }
		| { readonly ok: false; readonly code: string }
	>;
	claimed(sessionId?: string): Promise<readonly CompletionQueuePendingItem[]>;
	consume(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult>;
	requeueClaimed(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult>;
}

export interface CompletionAgentPort {
	isTurnActive(): boolean;
	hasPendingUserInput(): boolean;
	hasDurableDelivery(deliveryKey: string): Promise<"committed" | "absent" | "uncertain">;
	deliverCompletionBatch(envelopes: readonly ProcessCompletionEnvelope[]): Promise<
		| { readonly ok: true }
		| { readonly ok: false; readonly code: "agent_unavailable" | "delivery_uncertain" }
	>;
}

export interface CompletionAgentHostPort {
	readonly inFlight: boolean;
	getSteeringMessages(): readonly unknown[];
	getFollowUpMessages(): readonly unknown[];
	prompt(input: string): Promise<unknown>;
	readonly ledger?: LedgerSink;
}

interface CompletionQueueSuccess {
	readonly ok: true;
	readonly item: CompletionQueuePendingItem;
}

interface CompletionQueueFailure {
	readonly ok: false;
	readonly code: string;
}

type CompletionQueueMutationResult = CompletionQueueSuccess | CompletionQueueFailure;

export type CompletionReconcileResult =
	| { readonly ok: true; readonly itemId?: string; readonly suppressed: boolean }
	| { readonly ok: false; readonly code: "queue_unavailable" | "queue_revision_conflict" };

export type CompletionSchedulerResult =
	| { readonly ok: true; readonly outcome: "idle" | "deferred_active_turn" | "deferred_user_input" | "delivered" | "recovered"; readonly delivered: number }
	| { readonly ok: false; readonly code: "queue_unavailable" | "queue_revision_conflict" | "delivery_uncertain" | "agent_unavailable" };

export class CompletionReconciler {
	private readonly queue: CompletionQueuePort;
	private readonly sessionId: string | undefined;
	private reconciliation: Promise<CompletionSchedulerResult> | undefined;

	public constructor(queue: CompletionQueuePort, options: { readonly sessionId?: string } = {}) {
		this.queue = queue;
		this.sessionId = options.sessionId;
	}

	public async enqueueAutomatic(envelope: ProcessCompletionEnvelope): Promise<
		| { readonly ok: true; readonly itemId: string }
		| { readonly ok: false; readonly code: string }
	> {
		const result = await this.queue.enqueue({ ...envelope, origin: "automatic_follow_up" });
		if (!result.ok && result.code === "delivery_suppressed") return { ok: true, itemId: `suppressed:${envelope.deliveryKey}` };
		return result.ok ? { ok: true, itemId: result.item.itemId } : result;
	}

	public async commitExplicit(envelope: ProcessCompletionEnvelope): Promise<CompletionReconcileResult> {
		const durable = await this.queue.suppressDelivery(envelope);
		if (!durable.ok) {
			return durable.code === "queue_revision_conflict"
				? { ok: false, code: "queue_revision_conflict" }
				: { ok: false, code: "queue_unavailable" };
		}
		const pending = await this.queue.pending(this.sessionId);
		const item = pending.find((candidate) => candidate.envelope.deliveryKey === envelope.deliveryKey);
		if (item === undefined) return { ok: true, suppressed: durable.suppressed };
		const result = await this.queue.suppress(item.itemId, item.revision);
		if (!result.ok) {
			return result.code === "queue_revision_conflict"
				? { ok: false, code: "queue_revision_conflict" }
				: { ok: false, code: "queue_unavailable" };
		}
		return { ok: true, itemId: item.itemId, suppressed: true };
	}

	/**
	 * Claim and deliver automatic completions without ever starting an Agent turn
	 * from a process watcher. The caller supplies the Host-owned Agent port; a
	 * durable Agent input marker is checked before an interrupted claim is
	 * consumed after restart.
	 */
	public reconcile(agent: CompletionAgentPort, maxItems = 32): Promise<CompletionSchedulerResult> {
		this.reconciliation ??= this.reconcileOnce(agent, maxItems).finally(() => {
			this.reconciliation = undefined;
		});
		return this.reconciliation;
	}

	private async reconcileOnce(agent: CompletionAgentPort, maxItems: number): Promise<CompletionSchedulerResult> {
		if (!Number.isSafeInteger(maxItems) || maxItems < 1) return { ok: false, code: "queue_unavailable" };
		const queue = this.queue as CompletionQueuePort & Partial<CompletionQueueClaimPort>;
		if (!queue.claim || !queue.claimed || !queue.consume || !queue.requeueClaimed) {
			return { ok: false, code: "queue_unavailable" };
		}

		let recovered = 0;
		let claimed: readonly CompletionQueuePendingItem[];
		try {
			claimed = await queue.claimed(this.sessionId);
		} catch {
			return { ok: false, code: "queue_unavailable" };
		}
		for (const item of claimed) {
			const state = await agent.hasDurableDelivery(item.envelope.deliveryKey);
			if (state === "uncertain") return { ok: false, code: "delivery_uncertain" };
			const result = state === "committed"
				? await queue.consume(item.itemId, item.revision)
				: await queue.requeueClaimed(item.itemId, item.revision);
			if (!result.ok) return { ok: false, code: mapQueueFailure(result.code) };
			if (state === "committed") recovered += 1;
		}

		if (agent.isTurnActive()) return { ok: true, outcome: "deferred_active_turn", delivered: recovered };
		if (agent.hasPendingUserInput()) return { ok: true, outcome: "deferred_user_input", delivered: recovered };

		const next = await queue.claim(maxItems, this.sessionId);
		if (!next.ok) return { ok: false, code: mapQueueFailure(next.code) };
		if (next.items.length === 0) {
			return recovered > 0
				? { ok: true, outcome: "recovered", delivered: recovered }
				: { ok: true, outcome: "idle", delivered: 0 };
		}

		const delivered = await agent.deliverCompletionBatch(next.items.map((item) => item.envelope));
		if (!delivered.ok) {
			if (delivered.code === "delivery_uncertain") return delivered;
			for (const item of next.items) {
				const requeued = await queue.requeueClaimed(item.itemId, item.revision);
				if (!requeued.ok) return { ok: false, code: mapQueueFailure(requeued.code) };
			}
			return delivered;
		}
		for (const item of next.items) {
			const consumed = await queue.consume(item.itemId, item.revision);
			if (!consumed.ok) return { ok: false, code: mapQueueFailure(consumed.code) };
		}
		return { ok: true, outcome: "delivered", delivered: recovered + next.items.length };
	}
}

/** Adapts the stateful Agent to the Host scheduler without letting the watcher call prompt(). */
export class DurableAgentCompletionBridge implements CompletionAgentPort {
	private readonly agent: CompletionAgentHostPort;

	public constructor(agent: CompletionAgentHostPort) {
		this.agent = agent;
	}

	public isTurnActive(): boolean {
		return this.agent.inFlight;
	}

	public hasPendingUserInput(): boolean {
		return this.agent.getSteeringMessages().length > 0 || this.agent.getFollowUpMessages().length > 0;
	}

	public async hasDurableDelivery(deliveryKey: string): Promise<"committed" | "absent" | "uncertain"> {
		if (!this.agent.ledger) return "absent";
		try {
			const marker = completionDeliveryMarker(deliveryKey);
			const entries = await this.agent.ledger.entries();
			return entries.some((entry) => entry.type === "message" && typeof entry.payload.content === "string" && entry.payload.content.includes(marker))
				? "committed"
				: "absent";
		} catch {
			return "uncertain";
		}
	}

	public async deliverCompletionBatch(envelopes: readonly ProcessCompletionEnvelope[]): Promise<
		| { readonly ok: true }
		| { readonly ok: false; readonly code: "agent_unavailable" | "delivery_uncertain" }
	> {
		if (envelopes.length === 0 || this.isTurnActive() || this.hasPendingUserInput()) return { ok: false, code: "agent_unavailable" };
		const input = clipUtf8Output(
			envelopes.map((envelope) => {
				const marker = completionDeliveryMarker(envelope.deliveryKey);
				const preview = envelope.preview === undefined ? "" : `\noutput:\n${envelope.preview}`;
				return `${marker}\nmanaged process ${envelope.summary.handle.executionId} finished with ${envelope.summary.state}.${preview}`;
			}).join("\n\n"),
			RUNTIME_HOST_BOUNDS.maxCompletionBatchBytes,
		).text;
		try {
			await this.agent.prompt(input);
			return { ok: true };
		} catch {
			return { ok: false, code: "delivery_uncertain" };
		}
	}
}

export function completionDeliveryMarker(deliveryKey: string): string {
	return `[runledger-completion:${deliveryKey}]`;
}

function mapQueueFailure(code: string): "queue_unavailable" | "queue_revision_conflict" {
	return code === "queue_revision_conflict" ? "queue_revision_conflict" : "queue_unavailable";
}
