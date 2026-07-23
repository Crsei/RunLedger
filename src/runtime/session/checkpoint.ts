/** Phase 1 logical checkpoint/fork/rewind；不表达或修改物理 workspace 状态。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	isRuntimeId,
	type AgentId,
	type CheckpointId,
	type CommandId,
	type GoalId,
	type LeafId,
	type PrincipalId,
	type SessionId,
	type TraceId,
} from "../protocol/v3/ids.ts";
import type {
	SessionForkGoalMode,
	SessionProjection,
	SessionProjectionState,
} from "./projections.ts";
import { verifyRuntimeEventChain } from "./chain-verification.ts";
import { reduceSessionEvents } from "./reducer.ts";
import type { RuntimeEventDraft, SessionKernelError, SessionResult } from "./types.ts";

export interface LogicalCheckpoint {
	checkpointId: CheckpointId;
	cursor: EventCursor;
	reducerDigest: string;
	activeLeafId: LeafId;
	activePlanDigest?: string;
	compositeCheckpointRef?: string;
}

export interface CreateLogicalCheckpointOptions {
	checkpointId: CheckpointId;
	activeLeafId: LeafId;
	activePlanDigest?: string;
	compositeCheckpointRef?: string;
}

export interface CheckpointEventPlan {
	checkpoint: LogicalCheckpoint;
	draft: RuntimeEventDraft<"checkpoint.created">;
}

export interface StableForkPlan {
	sourceSessionId: SessionId;
	newSessionId: SessionId;
	parentCursor: EventCursor;
	parentLeafId: LeafId;
	goalMode: StableForkGoalMode;
	initialGoalId: GoalId;
	rootAgentId: AgentId;
	parentRootAgentId: AgentId;
	genesisDraft: RuntimeEventDraft<"session.forked">;
}

export type StableForkGoalMode = SessionForkGoalMode;

export interface LogicalRewindPlan {
	checkpointId: CheckpointId;
	targetCursor: EventCursor;
	checkpointLeafId: LeafId;
	fromLeafId: LeafId;
	toLeafId: LeafId;
	workspaceState: "unchanged";
	draft: RuntimeEventDraft<"checkpoint.rewound">;
}

function fail<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function invalid<T>(message: string, details?: SessionKernelError["details"]): SessionResult<T> {
	return fail({ code: "invalid_event", message, retryable: false, ...(details ? { details } : {}) });
}

function isDigest(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

function projectionState(projection: SessionProjection): SessionProjectionState {
	const { projectionDigest: _projectionDigest, ...state } = projection;
	return state;
}

function validateProjectionDigest(projection: SessionProjection): boolean {
	try {
		return canonicalDigest(projectionState(projection)) === projection.projectionDigest;
	} catch {
		return false;
	}
}

export function requireStableTurnBoundary(projection: SessionProjection): SessionResult<void> {
	if (!validateProjectionDigest(projection)) return invalid("session projection digest is invalid");
	if (projection.lifecycle !== "active") {
		return invalid("logical checkpoint operations require an active session", { lifecycle: projection.lifecycle });
	}
	if (projection.activeTurnId !== null || projection.activeModelRequestId !== null) {
		return invalid("logical checkpoint operations require a completed turn boundary", {
			activeTurn: projection.activeTurnId !== null,
			activeModelRequest: projection.activeModelRequestId !== null,
		});
	}
	const openTool = projection.toolCalls.some(
		(tool) => tool.status === "requested" || tool.status === "authorized" || tool.status === "started",
	);
	if (openTool || projection.hasUncertainOperations) {
		return invalid("logical checkpoint operations require all side effects to be terminal and certain", {
			openTool,
			hasUncertainOperations: projection.hasUncertainOperations,
		});
	}
	return { ok: true, value: undefined };
}

function requireStableForkBoundary(projection: SessionProjection): SessionResult<void> {
	if (!validateProjectionDigest(projection)) return invalid("session projection digest is invalid");
	if (projection.lifecycle === "corrupted" || projection.lifecycle === "stop_requested") {
		return invalid("stable fork cannot use a corrupted or partially stopped parent", {
			lifecycle: projection.lifecycle,
		});
	}
	if (projection.activeTurnId !== null || projection.activeModelRequestId !== null) {
		return invalid("stable fork requires a completed turn boundary");
	}
	const openTool = projection.toolCalls.some(
		(tool) => tool.status === "requested" || tool.status === "authorized" || tool.status === "started",
	);
	if (openTool || projection.hasUncertainOperations) {
		return invalid("stable fork requires all side effects to be terminal and certain");
	}
	return { ok: true, value: undefined };
}

export function createLogicalCheckpoint(
	projection: SessionProjection,
	options: CreateLogicalCheckpointOptions,
): SessionResult<LogicalCheckpoint> {
	const stable = requireStableTurnBoundary(projection);
	if (!stable.ok) return stable;
	if (!isRuntimeId(options.checkpointId, "checkpoint") || !isRuntimeId(options.activeLeafId, "leaf")) {
		return invalid("logical checkpoint ids are invalid");
	}
	if (options.activeLeafId !== projection.activeLeafId || !projection.knownLeafIds.includes(options.activeLeafId)) {
		return invalid("logical checkpoint must bind the active connected leaf", {
			activeLeafId: options.activeLeafId,
			expectedLeafId: projection.activeLeafId,
		});
	}
	if (options.activePlanDigest !== undefined && !isDigest(options.activePlanDigest)) {
		return invalid("active plan digest is invalid");
	}
	if (
		options.compositeCheckpointRef !== undefined &&
		(options.compositeCheckpointRef.length < 1 || options.compositeCheckpointRef.length > 128)
	) return invalid("composite checkpoint reference is invalid");
	return {
		ok: true,
		value: {
			checkpointId: options.checkpointId,
			cursor: {
				stream: projection.stream,
				sequence: projection.headSequence,
				eventId: projection.headEventId,
				eventHash: projection.headEventHash,
			},
			reducerDigest: projection.projectionDigest,
			activeLeafId: options.activeLeafId,
			...(options.activePlanDigest ? { activePlanDigest: options.activePlanDigest } : {}),
			...(options.compositeCheckpointRef ? { compositeCheckpointRef: options.compositeCheckpointRef } : {}),
		},
	};
}

export function createCheckpointEventPlan(
	projection: SessionProjection,
	options: CreateLogicalCheckpointOptions & { principalId: PrincipalId; traceId: TraceId },
): SessionResult<CheckpointEventPlan> {
	if (!isRuntimeId(options.principalId, "principal") || !isRuntimeId(options.traceId, "trace")) {
		return invalid("checkpoint event identity is invalid");
	}
	const checkpoint = createLogicalCheckpoint(projection, options);
	if (!checkpoint.ok) return checkpoint;
	return {
		ok: true,
		value: {
			checkpoint: checkpoint.value,
			draft: {
				type: "checkpoint.created",
				principalId: options.principalId,
				traceId: options.traceId,
				payload: {
					checkpointId: checkpoint.value.checkpointId,
					sequence: checkpoint.value.cursor.sequence,
					eventHash: checkpoint.value.cursor.eventHash,
					reducerDigest: checkpoint.value.reducerDigest,
					activeLeafId: checkpoint.value.activeLeafId,
					...(checkpoint.value.activePlanDigest
						? { activePlanDigest: checkpoint.value.activePlanDigest }
						: {}),
					...(checkpoint.value.compositeCheckpointRef
						? { compositeCheckpointRef: checkpoint.value.compositeCheckpointRef }
						: {}),
				},
			},
		},
	};
}

export function createStableForkPlan(
	parent: SessionProjection,
	options: {
		newSessionId: SessionId;
		parentLeafId: LeafId;
		goalMode: StableForkGoalMode;
		initialGoalId: GoalId;
		rootAgentId: AgentId;
		idempotencyKey: CommandId;
		principalId: PrincipalId;
		traceId: TraceId;
	},
): SessionResult<StableForkPlan> {
	const stable = requireStableForkBoundary(parent);
	if (!stable.ok) return stable;
	if (
		!isRuntimeId(options.newSessionId, "session") ||
		!isRuntimeId(options.parentLeafId, "leaf") ||
		!isRuntimeId(options.initialGoalId, "goal") ||
		!isRuntimeId(options.rootAgentId, "agent") ||
		!isRuntimeId(options.idempotencyKey, "command") ||
		!isRuntimeId(options.principalId, "principal") ||
		!isRuntimeId(options.traceId, "trace")
	) return invalid("stable fork identity is invalid");
	if (options.newSessionId === parent.sessionId) return invalid("stable fork must target a distinct session");
	if (options.rootAgentId === parent.genesis.rootAgentId) {
		return invalid("stable fork must create a distinct root agent identity");
	}
	if (
		(options.goalMode === "continue_existing_goal" && options.initialGoalId !== parent.genesis.initialGoalId) ||
		(options.goalMode === "create_child_goal" && options.initialGoalId === parent.genesis.initialGoalId)
	) {
		return invalid("stable fork goal identity does not match the selected goal mode", {
			goalMode: options.goalMode,
			parentGoalId: parent.genesis.initialGoalId,
			initialGoalId: options.initialGoalId,
		});
	}
	if (options.parentLeafId !== parent.activeLeafId || !parent.knownLeafIds.includes(options.parentLeafId)) {
		return invalid("stable fork parent leaf is not the active connected leaf");
	}
	const parentCursor: EventCursor = {
		stream: parent.stream,
		sequence: parent.headSequence,
		eventId: parent.headEventId,
		eventHash: parent.headEventHash,
	};
	return {
		ok: true,
		value: {
			sourceSessionId: parent.sessionId,
			newSessionId: options.newSessionId,
			parentCursor,
			parentLeafId: options.parentLeafId,
			goalMode: options.goalMode,
			initialGoalId: options.initialGoalId,
			rootAgentId: options.rootAgentId,
			parentRootAgentId: parent.genesis.rootAgentId,
			genesisDraft: {
				type: "session.forked",
				principalId: options.principalId,
				traceId: options.traceId,
				payload: {
					parentSessionId: parent.sessionId,
					parentSequence: parent.headSequence,
					parentEventHash: parent.headEventHash,
					parentLeafId: options.parentLeafId,
					goalMode: options.goalMode,
					initialGoalId: options.initialGoalId,
					rootAgentId: options.rootAgentId,
					parentRootAgentId: parent.genesis.rootAgentId,
					idempotencyKey: options.idempotencyKey,
				},
			},
		},
	};
}

export function createLogicalRewindPlan(
	events: readonly RuntimeEventV3[],
	projection: SessionProjection,
	options: {
		checkpointId: CheckpointId;
		fromLeafId: LeafId;
		toLeafId: LeafId;
		principalId: PrincipalId;
		traceId: TraceId;
	},
): SessionResult<LogicalRewindPlan> {
	const stable = requireStableTurnBoundary(projection);
	if (!stable.ok) return stable;
	if (
		!isRuntimeId(options.checkpointId, "checkpoint") ||
		!isRuntimeId(options.fromLeafId, "leaf") ||
		!isRuntimeId(options.toLeafId, "leaf") ||
		!isRuntimeId(options.principalId, "principal") ||
		!isRuntimeId(options.traceId, "trace")
	) return invalid("logical rewind identity is invalid");
	if (options.fromLeafId === options.toLeafId) return invalid("logical rewind must create a new leaf");
	if (options.fromLeafId !== projection.activeLeafId || !projection.knownLeafIds.includes(options.fromLeafId)) {
		return invalid("logical rewind source must be the active connected leaf");
	}
	if (projection.knownLeafIds.includes(options.toLeafId)) {
		return invalid("logical rewind target must be a new leaf");
	}
	const checkpoint = projection.checkpoints.find((candidate) => candidate.checkpointId === options.checkpointId);
	if (!checkpoint || checkpoint.status !== "created") {
		return invalid("logical rewind requires an unconsumed checkpoint", { checkpointId: options.checkpointId });
	}
	const targetEvent = events[checkpoint.eventSequence];
	const chain = verifyRuntimeEventChain(events, {
		authorityId: projection.authorityId,
		tenantId: projection.tenantId,
		stream: projection.stream,
	});
	if (chain.integrity === "corrupted") {
		return fail(chain.error ?? { code: "corrupted_log", message: "logical rewind source chain is corrupted", retryable: false });
	}
	const liveProjection = reduceSessionEvents(events);
	if (!liveProjection.ok) return liveProjection;
	if (liveProjection.value.projectionDigest !== projection.projectionDigest) {
		return invalid("logical rewind projection does not match the source chain");
	}
	if (
		!targetEvent ||
			!sameRuntimeEventStream(targetEvent.stream, projection.stream) ||
		targetEvent.currentEventHash !== checkpoint.eventHash
	) return invalid("logical rewind checkpoint is not present in the source chain", {
		sequence: checkpoint.eventSequence,
	});
	const targetProjection = reduceSessionEvents(events.slice(0, checkpoint.eventSequence + 1));
	if (!targetProjection.ok) return targetProjection;
	if (targetProjection.value.projectionDigest !== checkpoint.reducerDigest) {
		return invalid("logical rewind checkpoint digest does not match the source prefix", {
			sequence: checkpoint.eventSequence,
		});
	}
	const checkpointLeafId = checkpoint.activeLeafId;
	return {
		ok: true,
		value: {
			checkpointId: options.checkpointId,
			targetCursor: {
					stream: projection.stream,
					sequence: checkpoint.eventSequence,
					eventId: targetEvent.eventId,
				eventHash: checkpoint.eventHash,
			},
			checkpointLeafId,
			fromLeafId: options.fromLeafId,
			toLeafId: options.toLeafId,
			workspaceState: "unchanged",
			draft: {
				type: "checkpoint.rewound",
				principalId: options.principalId,
				traceId: options.traceId,
				payload: {
					checkpointId: options.checkpointId,
					fromLeafId: options.fromLeafId,
					toLeafId: options.toLeafId,
				},
			},
		},
	};
}

export function projectAtLogicalCheckpoint(
	events: readonly RuntimeEventV3[],
	checkpoint: LogicalCheckpoint,
): SessionResult<SessionProjection> {
	if (!isRuntimeId(checkpoint.checkpointId, "checkpoint") || !isRuntimeId(checkpoint.activeLeafId, "leaf")) {
		return invalid("logical checkpoint is invalid");
	}
	if (
		!isDigest(checkpoint.reducerDigest) ||
		(checkpoint.activePlanDigest !== undefined && !isDigest(checkpoint.activePlanDigest)) ||
		(checkpoint.compositeCheckpointRef !== undefined &&
			(checkpoint.compositeCheckpointRef.length < 1 || checkpoint.compositeCheckpointRef.length > 128))
	) return invalid("logical checkpoint metadata is invalid");
	const first = events[0];
	if (!first) return invalid("logical checkpoint source chain is empty");
	const chain = verifyRuntimeEventChain(events, {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
	});
	if (chain.integrity === "corrupted") {
		return fail(chain.error ?? { code: "corrupted_log", message: "logical checkpoint source chain is corrupted", retryable: false });
	}
	const target = events[checkpoint.cursor.sequence];
	if (
		!target ||
			!sameRuntimeEventStream(target.stream, checkpoint.cursor.stream) ||
		target.eventId !== checkpoint.cursor.eventId ||
		target.currentEventHash !== checkpoint.cursor.eventHash
	) return invalid("logical checkpoint cursor is not present in the source chain", { sequence: checkpoint.cursor.sequence });
	const projection = reduceSessionEvents(events.slice(0, checkpoint.cursor.sequence + 1));
	if (!projection.ok) return projection;
	if (projection.value.projectionDigest !== checkpoint.reducerDigest) {
		return invalid("logical checkpoint reducer digest does not match its source prefix", {
			sequence: checkpoint.cursor.sequence,
		});
	}
	return projection;
}
