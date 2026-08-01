/** Runtime 可重建 projection 与 snapshot 的被动 DTO。 */

import type { RuntimeEventRangeRef } from "../protocol/events.ts";
import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../protocol/foundation.ts";
import type { AgentId, GoalId, QueueItemId, SessionId, SnapshotId, TaskId, TurnId } from "../protocol/ids.ts";

export type ProjectionCompleteness = "complete" | "partial";

export interface ProjectionMetadata {
	readonly sourceHead: RuntimeStreamHead;
	readonly projectionDigest: RuntimeDigest;
	readonly builtAt: string;
	readonly completeness: ProjectionCompleteness;
}

export interface SessionProjection extends ProjectionMetadata {
	readonly projectionKind: "session";
	readonly sessionId: SessionId;
	readonly status: "created" | "running" | "stopping" | "stopped" | "closed" | "corrupted";
	readonly rootGoalId: GoalId;
	readonly rootAgentId: AgentId;
}

export interface GoalProjection extends ProjectionMetadata {
	readonly projectionKind: "goal";
	readonly sessionId: SessionId;
	readonly goalId: GoalId;
	readonly revision: number;
	readonly status: "proposed" | "active" | "blocked" | "completed" | "failed" | "cancelled";
	readonly completionRef?: RuntimeContentRef;
	readonly verificationRef?: RuntimeContentRef;
}

export interface TaskPassiveState {
	readonly taskId: TaskId;
	readonly revision: number;
	readonly status: "pending" | "in_progress" | "blocked" | "completed" | "failed" | "cancelled";
	readonly priority: "low" | "normal" | "high" | "critical";
	readonly definitionDigest: RuntimeDigest;
	readonly dependencyIds: readonly TaskId[];
	readonly outputRefs: readonly RuntimeContentRef[];
}

export interface TaskProjection extends ProjectionMetadata {
	readonly projectionKind: "task";
	readonly sessionId: SessionId;
	readonly tasks: readonly TaskPassiveState[];
}

export interface QueueItemPassiveState {
	readonly queueItemId: QueueItemId;
	readonly kind: "steer" | "follow_up";
	readonly status: "enqueued" | "claimed" | "consumed" | "cancelled";
	readonly order: number;
	readonly revision: number;
	readonly targetTurnId?: TurnId;
	readonly payloadRef?: RuntimeContentRef;
}

export interface QueueProjection extends ProjectionMetadata {
	readonly projectionKind: "queue";
	readonly sessionId: SessionId;
	readonly items: readonly QueueItemPassiveState[];
}

export interface AgentGraphNode {
	readonly agentId: AgentId;
	readonly parentAgentId?: AgentId;
	readonly status: "requested" | "running" | "paused" | "stopped" | "finished" | "failed";
	readonly delegationDigest: RuntimeDigest;
	readonly budgetRef?: RuntimeContentRef;
	readonly workspaceRef?: RuntimeContentRef;
	readonly capabilityRef?: RuntimeContentRef;
}

export interface AgentGraphProjection extends ProjectionMetadata {
	readonly projectionKind: "agent_graph";
	readonly sessionId: SessionId;
	readonly nodes: readonly AgentGraphNode[];
}

export type RuntimeProjection = SessionProjection | GoalProjection | TaskProjection | QueueProjection | AgentGraphProjection;

export interface RuntimeSnapshotDescriptor {
	readonly snapshotId: SnapshotId;
	readonly snapshotKind: "session_projection" | "resource_catalog" | "context" | "workspace" | "composite";
	readonly sourceRange: RuntimeEventRangeRef;
	readonly snapshotDigest: RuntimeDigest;
	readonly artifactRef?: RuntimeContentRef;
	readonly builtAt: string;
	readonly completeness: ProjectionCompleteness;
}
