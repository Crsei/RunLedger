/** 严格 Runtime v3 event chain 到 RuntimeActivity 的纯 projection。 */

import { latestCanonicalGoalState } from "../orchestrator/canonical-journals.ts";
import { reduceCanonicalTaskEvents, type TaskStatus } from "../orchestrator/task-repository.ts";
import type { GoalPhase } from "../orchestrator/types.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { EventCursor, RuntimeEventV3 } from "../protocol/v3/events.ts";
import type { AgentId, GoalId } from "../protocol/v3/ids.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import { reduceSessionEvents } from "../session/reducer.ts";
import { reduceSessionSecurityEvents } from "../session/security-reducer.ts";
import {
	RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION,
	runtimeActivityProjectionBody,
	runtimeActivityStatus,
	type RuntimeActivityErrorCode,
	type RuntimeActivityLifecycle,
	type RuntimeActivityProjection,
	type RuntimeActivityProjectionBody,
	type RuntimeActivityResult,
} from "./types.ts";

function isTerminalGoalPhase(phase: GoalPhase): boolean {
	return phase === "completed" || phase === "failed" || phase === "stopped";
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function failure<T>(
	code: RuntimeActivityErrorCode,
	message: string,
	details?: Readonly<Record<string, string | number | boolean>>,
): RuntimeActivityResult<T> {
	return { ok: false, error: { code, message, retryable: false, ...(details ? { details } : {}) } };
}

function eventCursor(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function sorted<T extends string>(values: ReadonlySet<T>): readonly T[] {
	return [...values].sort();
}

function terminalLifecycle(lifecycle: RuntimeActivityLifecycle): boolean {
	return lifecycle === "migration_failed" || lifecycle === "stopped" || lifecycle === "closed" || lifecycle === "corrupted";
}

function reduceGoalActivity(
	events: readonly RuntimeEventV3[],
	initialGoalId: GoalId,
): RuntimeActivityResult<ReadonlySet<GoalId>> {
	const projected = latestCanonicalGoalState(events);
	if (!projected.ok) return failure("invalid_event", "canonical goal activity projection failed");
	if (!projected.value) return { ok: true, value: new Set([initialGoalId]) };
	if (projected.value.goalId !== initialGoalId) {
		return failure("invalid_event", "canonical goal activity does not match session genesis", {
			goalId: projected.value.goalId,
		});
	}
	return {
		ok: true,
		value: isTerminalGoalPhase(projected.value.phase)
			? new Set<GoalId>()
			: new Set([projected.value.goalId]),
	};
}

function reduceTaskActivity(events: readonly RuntimeEventV3[]): RuntimeActivityResult<ReadonlySet<string>> {
	const projected = reduceCanonicalTaskEvents(events);
	if (!projected.ok) return failure("invalid_event", "canonical task activity projection failed");
	return {
		ok: true,
		value: new Set(projected.value.tasks.flatMap((task) =>
			isTerminalTaskStatus(task.status) ? [] : [task.definition.taskId],
		)),
	};
}

function reduceNestedAgentActivity(events: readonly RuntimeEventV3[]): RuntimeActivityResult<ReadonlySet<AgentId>> {
	const nestedAgents = new Set<AgentId>();
	for (const event of events) {
		switch (event.type) {
			case "agent.spawned":
				if (
					event.payload.node.parentAgentId === undefined ||
					event.payload.edge.childAgentId !== event.payload.node.agentId ||
					event.payload.edge.parentAgentId !== event.payload.node.parentAgentId
				) {
					return failure("invalid_event", "nested agent spawn lacks a correlated parent edge", {
						sequence: event.sequence,
					});
				}
				if (nestedAgents.has(event.payload.node.agentId)) {
					return failure("invalid_event", "nested agent was spawned more than once", {
						sequence: event.sequence,
						agentId: event.payload.node.agentId,
					});
				}
				if (!["partial", "completed", "failed", "stopped"].includes(event.payload.node.state)) {
					nestedAgents.add(event.payload.node.agentId);
				}
				break;
			case "agent.stopped":
			case "agent.partial_committed":
			case "agent.finished":
			case "agent.failed":
				nestedAgents.delete(event.payload.agentId);
				break;
			default:
				break;
		}
	}
	return { ok: true, value: nestedAgents };
}

/**
 * Event Store replay 是唯一输入。调用者必须传入完整 session stream；partial page、
 * snapshot cache 或 daemon 内存状态均不能作为 canonical activity 真源。
 */
export function projectRuntimeActivityEvents(
	events: readonly RuntimeEventV3[],
): RuntimeActivityResult<RuntimeActivityProjection> {
	const first = events[0];
	const last = events.at(-1);
	if (!first || !last) return failure("invalid_event", "runtime activity requires a non-empty session event chain");
	if (first.stream.scope !== "session") {
		return failure("scope_mismatch", "runtime activity requires a session-scoped event chain");
	}
	const verified = verifyRuntimeEventChain(events, {
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		stream: first.stream,
	});
	if (verified.integrity !== "valid") {
		const code: RuntimeActivityErrorCode = verified.error?.code === "identity_mismatch"
			? "scope_mismatch"
			: verified.error?.code === "sequence_conflict"
				? "out_of_order"
				: "corrupted_log";
		return failure(code, "runtime activity rejected an invalid canonical event chain", {
			...(verified.firstBadSequence === undefined ? {} : { firstBadSequence: verified.firstBadSequence }),
		});
	}
	const session = reduceSessionEvents(events);
	if (!session.ok) {
		const code: RuntimeActivityErrorCode = session.error.code === "identity_mismatch"
			? "scope_mismatch"
			: session.error.code === "sequence_conflict"
				? "out_of_order"
				: "invalid_event";
		return failure(code, "runtime activity session projection failed", session.error.details);
	}
	const security = reduceSessionSecurityEvents(events);
	if (!security.ok) {
		const code: RuntimeActivityErrorCode = security.error.code === "identity_mismatch"
			? "scope_mismatch"
			: security.error.code === "sequence_conflict"
				? "out_of_order"
				: "invalid_event";
		return failure(code, "runtime activity security projection failed", security.error.details);
	}
	const goals = reduceGoalActivity(events, session.value.genesis.initialGoalId);
	if (!goals.ok) return goals;
	const tasks = reduceTaskActivity(events);
	if (!tasks.ok) return tasks;
	const nestedAgents = reduceNestedAgentActivity(events);
	if (!nestedAgents.ok) return nestedAgents;

	const lifecycle = session.value.lifecycle;
	const isTerminal = terminalLifecycle(lifecycle);
	const activeGoalIds = isTerminal ? [] : sorted(goals.value);
	const activeTaskIds = isTerminal ? [] : sorted(tasks.value);
	const activeTurnId = isTerminal ? null : session.value.activeTurnId;
	const activeToolCallIds = isTerminal
		? []
		: session.value.toolCalls
			.filter((tool) => tool.status !== "finished" && tool.status !== "interrupted" && tool.status !== "failed")
			.map((tool) => tool.toolCallId)
			.sort();
	const nestedAgentIds = isTerminal ? [] : sorted(nestedAgents.value);
	const waitingPermissionIds = isTerminal ? [] : [...security.value.pendingApprovalIds].sort();
	const bodyWithoutStatus = {
		schemaVersion: RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION,
		projectionKind: "runtime_activity" as const,
		authorityId: session.value.authorityId,
		tenantId: session.value.tenantId,
		principalId: session.value.principalId,
		sessionId: session.value.sessionId,
		revision: last.sequence + 1,
		lifecycle,
		activeGoalIds,
		activeTaskIds,
		activeTurnId,
		activeToolCallIds,
		nestedAgentIds,
		waitingPermissionIds,
		heartbeat: { observedAt: last.timestamp, cursor: eventCursor(last) },
		projectedThroughSequence: last.sequence,
	};
	const body: RuntimeActivityProjectionBody = {
		...bodyWithoutStatus,
		status: runtimeActivityStatus(bodyWithoutStatus),
	};
	return {
		ok: true,
		value: {
			...body,
			projectionDigest: canonicalDigest(runtimeActivityProjectionBody(body)),
		},
	};
}
