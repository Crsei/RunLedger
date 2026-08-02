/** Managed process 合法迁移与可重建 projector。 */

import type { RuntimeDigest } from "../protocol/foundation.ts";
import { processEventDigest, type ProcessEvent } from "./events.ts";
import type { ExecutionHandleRef, ProcessState, ProcessTerminalState } from "./types.ts";

export interface ProcessProjection {
	readonly handle: ExecutionHandleRef;
	readonly state: ProcessState;
	readonly revision: number;
	readonly outputCursor: number;
	readonly outputSize: number;
	readonly terminal?: {
		readonly state: ProcessTerminalState;
		readonly exitCode?: number;
		readonly signal?: string;
	};
	readonly lastSequence: number;
	readonly lastEventHash: RuntimeDigest | null;
}

export type ProcessTransitionErrorCode =
	| "expected_revision_conflict"
	| "illegal_process_transition"
	| "terminal_state_immutable";

export type ProcessTransitionResult =
	| { readonly ok: true; readonly state: ProcessProjection }
	| { readonly ok: false; readonly code: ProcessTransitionErrorCode };

export interface ProcessTransitionInput {
	readonly type: ProcessEvent["type"];
	readonly nextState: ProcessState;
	readonly expectedRevision: number;
	readonly outputCursor?: number;
	readonly outputSize?: number;
	readonly terminal?: ProcessProjection["terminal"];
}

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set([
	"completed",
	"failed",
	"timed_out",
	"killed",
	"lost",
	"uncertain",
]);

const LEGAL_TRANSITIONS: Readonly<Record<ProcessState, readonly ProcessState[]>> = {
	queued: ["queued", "starting", "lost", "uncertain"],
	starting: ["starting", "running", "backgrounded", "failed", "timed_out", "killed", "lost", "uncertain"],
	running: ["running", "backgrounded", "completed", "failed", "timed_out", "killed", "lost", "uncertain"],
	backgrounded: ["backgrounded", "completed", "failed", "timed_out", "killed", "lost", "uncertain"],
	completed: ["completed"],
	failed: ["failed"],
	timed_out: ["timed_out"],
	killed: ["killed"],
	lost: ["lost"],
	uncertain: ["uncertain"],
};

export function createInitialProcessProjection(handle: ExecutionHandleRef): ProcessProjection {
	return {
		handle,
		state: "queued",
		revision: 0,
		outputCursor: 0,
		outputSize: 0,
		lastSequence: -1,
		lastEventHash: null,
	};
}

export function transitionProcess(state: ProcessProjection, input: ProcessTransitionInput): ProcessTransitionResult {
	if (input.expectedRevision !== state.revision) return { ok: false, code: "expected_revision_conflict" };
	if (TERMINAL_STATES.has(state.state) && input.nextState !== state.state) {
		return { ok: false, code: "terminal_state_immutable" };
	}
	if (!LEGAL_TRANSITIONS[state.state].includes(input.nextState)) {
		return { ok: false, code: "illegal_process_transition" };
	}
	return {
		ok: true,
		state: {
			...state,
			handle: { ...state.handle, revision: state.revision + 1 },
			state: input.nextState,
			revision: state.revision + 1,
			outputCursor: input.outputCursor ?? state.outputCursor,
			outputSize: input.outputSize ?? state.outputSize,
			terminal: input.terminal ?? state.terminal,
		},
	};
}

export type ProcessProjectionErrorCode =
	| ProcessTransitionErrorCode
	| "event_sequence_gap"
	| "event_revision_gap"
	| "event_scope_mismatch"
	| "event_previous_hash_mismatch"
	| "event_digest_mismatch"
	| "invalid_initial_process_event";

export type ProcessProjectionResult =
	| { readonly ok: true; readonly state: ProcessProjection }
	| { readonly ok: false; readonly code: ProcessProjectionErrorCode };

export function projectProcessEvents(events: readonly ProcessEvent[]): ProcessProjectionResult {
	if (events.length === 0) {
		return { ok: false, code: "invalid_initial_process_event" };
	}
	const first = events[0];
	const { eventHash: firstEventHash, ...firstBody } = first;
	const firstHash = processEventDigest(firstBody);
	if (firstHash.digest !== firstEventHash.digest) return { ok: false, code: "event_digest_mismatch" };
	if (
		first.sequence !== 0 ||
		first.revision !== 0 ||
		first.type !== "process.execution_requested" ||
		first.previousState !== null ||
		first.nextState !== "queued" ||
		first.previousEventHash !== null
	) {
		return { ok: false, code: "invalid_initial_process_event" };
	}
	let state: ProcessProjection = {
		handle: {
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			workspaceId: first.workspaceId,
			sessionId: first.sessionId,
			hostGeneration: first.hostGeneration,
			sessionGeneration: first.sessionGeneration,
			executionId: first.executionId,
			attemptId: first.attemptId,
			revision: first.revision,
			requestDigest: first.requestDigest,
		},
		state: "queued",
		revision: 0,
		outputCursor: first.outputCursor ?? 0,
		outputSize: first.outputSize ?? 0,
		lastSequence: first.sequence,
		lastEventHash: first.eventHash,
	};
	for (const event of events.slice(1)) {
		const { eventHash: storedEventHash, ...eventBody } = event;
		const eventHash = processEventDigest(eventBody);
		if (eventHash.digest !== storedEventHash.digest) return { ok: false, code: "event_digest_mismatch" };
		if (event.executionId !== state.handle.executionId || event.attemptId !== state.handle.attemptId) {
			return { ok: false, code: "event_scope_mismatch" };
		}
		if (
			event.authorityId !== state.handle.authorityId ||
			event.tenantId !== state.handle.tenantId ||
			event.workspaceId !== state.handle.workspaceId ||
			event.sessionId !== state.handle.sessionId ||
			event.hostGeneration !== state.handle.hostGeneration ||
			event.sessionGeneration !== state.handle.sessionGeneration ||
			event.requestDigest.digest !== state.handle.requestDigest.digest
		) {
			return { ok: false, code: "event_scope_mismatch" };
		}
		if (event.sequence !== state.lastSequence + 1) return { ok: false, code: "event_sequence_gap" };
		if (event.revision !== state.revision + 1) return { ok: false, code: "event_revision_gap" };
		if (event.previousEventHash?.digest !== state.lastEventHash?.digest) {
			return { ok: false, code: "event_previous_hash_mismatch" };
		}
		const next = transitionProcess(state, {
			type: event.type,
			nextState: event.nextState,
			expectedRevision: state.revision,
			outputCursor: event.outputCursor,
			outputSize: event.outputSize,
			terminal: event.terminal,
		});
		if (!next.ok) return next;
		state = { ...next.state, lastSequence: event.sequence, lastEventHash: storedEventHash };
	}
	return { ok: true, state };
}
