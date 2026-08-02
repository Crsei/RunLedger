/** Terminal completion delivery key and pure durable-outcome projector. */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import type { AgentId, AttemptId, AuthorityId, ExecutionId, SessionId } from "../protocol/ids.ts";

export interface CompletionDeliveryKeyParts {
	readonly authorityId: AuthorityId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	readonly executionId: ExecutionId;
	readonly attemptId: AttemptId;
	readonly terminalSequence: number;
	readonly deliveryPolicyDigest: RuntimeDigest;
}

export function createCompletionDeliveryKey(parts: CompletionDeliveryKeyParts): string {
	return `completion-${canonicalDigest(parts)}`;
}

export type CompletionDeliveryStatus =
	| "pending"
	| "explicit_delivery_committed"
	| "follow_up_enqueued"
	| "follow_up_claimed"
	| "follow_up_consumed"
	| "suppressed"
	| "uncertain";

export interface CompletionDeliveryState {
	readonly key: string;
	readonly terminalSequence: number;
	readonly revision: number;
	readonly status: CompletionDeliveryStatus;
}

export type CompletionDeliveryAction =
	| { readonly type: "explicit_delivery_committed" }
	| { readonly type: "follow_up_enqueued" }
	| { readonly type: "follow_up_claimed" }
	| { readonly type: "follow_up_consumed" }
	| { readonly type: "claim_interrupted" }
	| { readonly type: "suppressed" }
	| { readonly type: "uncertain" }
	| { readonly type: "wait_timed_out" | "wait_cancelled" };

export function createPendingCompletionDelivery(key: string, terminalSequence: number): CompletionDeliveryState {
	return { key, terminalSequence, revision: 0, status: "pending" };
}

export function applyCompletionDelivery(
	state: CompletionDeliveryState,
	action: CompletionDeliveryAction,
): CompletionDeliveryState {
	if (action.type === "wait_timed_out" || action.type === "wait_cancelled") return state;
	if (state.status === "follow_up_consumed" || state.status === "suppressed") return state;
	if (action.type === "uncertain") return next(state, "uncertain");
	if (state.status === "uncertain") return state;

	switch (state.status) {
		case "pending":
			if (action.type === "explicit_delivery_committed") return next(state, "explicit_delivery_committed");
			if (action.type === "follow_up_enqueued") return next(state, "follow_up_enqueued");
			if (action.type === "suppressed") return next(state, "suppressed");
			return state;
		case "explicit_delivery_committed":
			if (action.type === "follow_up_enqueued" || action.type === "follow_up_claimed") return next(state, "suppressed");
			return state;
		case "follow_up_enqueued":
			if (action.type === "follow_up_claimed") return next(state, "follow_up_claimed");
			if (action.type === "explicit_delivery_committed") return next(state, "suppressed");
			if (action.type === "suppressed") return next(state, "suppressed");
			return state;
		case "follow_up_claimed":
			if (action.type === "follow_up_consumed") return next(state, "follow_up_consumed");
			if (action.type === "claim_interrupted") return next(state, "follow_up_enqueued");
			if (action.type === "explicit_delivery_committed") return next(state, "suppressed");
			if (action.type === "suppressed") return next(state, "suppressed");
			return state;
	}
}

function next(state: CompletionDeliveryState, status: CompletionDeliveryStatus): CompletionDeliveryState {
	return { ...state, status, revision: state.revision + 1 };
}
