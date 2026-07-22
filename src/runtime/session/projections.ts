/** Session v3 事件重放得到的纯数据投影。 */

import type {
	AgentId,
	AuthorityId,
	CheckpointId,
	CommandId,
	EventId,
	GoalId,
	LeafId,
	ModelRequestId,
	PrincipalId,
	QueueItemId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	ToolCallId,
	TraceId,
	TurnId,
} from "../protocol/v3/ids.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type {
	AuthorityTenantEventStreamRef,
	EventCursor,
	ExpectedRevision,
	SessionEventStreamRef,
} from "../protocol/v3/events.ts";

export type SessionForkGoalMode = "continue_existing_goal" | "create_child_goal";

export type SessionGenesisProjection =
	| {
			readonly kind: "created";
			readonly eventId: EventId;
			readonly sequence: number;
			readonly runtimeId: RuntimeInstanceId;
			readonly origin: "new" | "import" | "test";
			readonly initialGoalId: GoalId;
			readonly rootAgentId: AgentId;
			readonly initialLeafId: LeafId;
	  }
	| {
			readonly kind: "forked";
			readonly eventId: EventId;
			readonly sequence: number;
			readonly parentSessionId: SessionId;
			readonly parentSequence: number;
			readonly parentEventHash: string;
			readonly parentLeafId: LeafId;
			readonly goalMode: SessionForkGoalMode;
			readonly initialGoalId: GoalId;
			readonly rootAgentId: AgentId;
			readonly parentRootAgentId: AgentId;
			readonly initialLeafId: LeafId;
	  }
	  | {
			readonly kind: "migration";
			readonly eventId: EventId;
			readonly sequence: number;
			readonly mode: "migrate" | "fork-to-v3";
			readonly sourceVersion: 1 | 2;
			readonly sourceDigest: string;
			readonly sourceSize: number;
			readonly headerDigest: string;
			readonly sourceSessionId: string;
			readonly importerVersion: string;
			readonly importSchema: string;
			readonly configurationJson: string;
			readonly configurationDigest: string;
			readonly recoveredFields: readonly string[];
			readonly lostFields: readonly string[];
			readonly manifestDigest: string;
			readonly initialGoalId: GoalId;
			readonly rootAgentId: AgentId;
			readonly initialLeafId: LeafId;
	  };

export type SessionLifecycleStatus =
	| "active"
	| "migration_in_progress"
	| "migration_failed"
	| "stop_requested"
	| "stopped"
	| "closed"
	| "corrupted";
export type LegacyMigrationProjectionStatus = "in_progress" | "committed" | "failed";
export type TurnProjectionStatus = "active" | "finished" | "interrupted" | "failed";
export type ModelRequestProjectionStatus = "requested" | "finished" | "failed";
export type ToolCallProjectionStatus = "requested" | "authorized" | "started" | "finished" | "interrupted" | "failed";
export type QueueItemProjectionStatus = "enqueued" | "claimed" | "consumed" | "cancelled";
export type CheckpointProjectionStatus = "created" | "rewound";

export type QueueItemNextTurnPolicy = "next_model_turn" | "after_active_run";
export type QueueItemContent =
	| { readonly storage: "bounded_text"; readonly messageJson: string }
	| { readonly storage: "artifact"; readonly artifact: ArtifactRef };
export interface QueueItemTargetTurnRevision {
	readonly turnId: TurnId;
	readonly sessionRevision: ExpectedRevision;
}

export interface TurnProjection {
	readonly turnId: TurnId;
	readonly goalId: GoalId;
	readonly queueItemId: QueueItemId | null;
	readonly status: TurnProjectionStatus;
	readonly startedSequence: number;
	readonly terminalSequence: number | null;
}

export interface ModelRequestProjection {
	readonly requestId: ModelRequestId;
	readonly turnId: TurnId;
	readonly modelId: string;
	readonly contextDigest: string;
	readonly status: ModelRequestProjectionStatus;
	readonly requestedSequence: number;
	readonly terminalSequence: number | null;
	readonly uncertain: boolean;
}

export interface ToolCallProjection {
	readonly toolCallId: ToolCallId;
	readonly turnId: TurnId;
	readonly agentId: AgentId;
	readonly status: ToolCallProjectionStatus;
	readonly requestedSequence: number;
	readonly terminalSequence: number | null;
	readonly uncertain: boolean;
}

export interface QueueItemProjection {
	readonly queueItemId: QueueItemId;
	readonly sourceCommandId: CommandId;
	readonly kind: "steer" | "follow_up";
	readonly enqueueRevision: ExpectedRevision;
	readonly targetTurnRevision: QueueItemTargetTurnRevision | null;
	readonly nextTurnPolicy: QueueItemNextTurnPolicy;
	readonly contentDigest: string;
	readonly content: QueueItemContent;
	readonly status: QueueItemProjectionStatus;
	readonly enqueuedSequence: number;
	readonly claimedSequence: number | null;
	readonly consumedSequence: number | null;
	readonly cancelledSequence: number | null;
	readonly turnId: TurnId | null;
	readonly modelRequestId: ModelRequestId | null;
}

export interface CheckpointProjection {
	readonly checkpointId: CheckpointId;
	readonly status: CheckpointProjectionStatus;
	readonly eventSequence: number;
	readonly eventHash: string;
	readonly reducerDigest: string;
	readonly activeLeafId: LeafId;
	readonly createdSequence: number;
	readonly rewoundSequence: number | null;
	readonly fromLeafId: LeafId | null;
	readonly toLeafId: LeafId | null;
}

export interface LegacyMigrationRecordProjection {
	readonly sourceIndex: number;
	readonly sourceEntryId: string;
	readonly sourceRecordDigest: string;
	readonly entryType: "session" | "message" | "tool_call" | "tool_result" | "turn" | "agent_event" | "custom";
	readonly messageKind: "user" | "assistant" | "toolResult" | "non_message";
	readonly contentDigest: string;
	readonly disposition: "recovered" | "omitted";
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
	/** 完整 import descriptor 的摘要，覆盖 message body 与 field-loss 声明。 */
	readonly recordDigest: string;
}

export interface LegacyMigrationProjection {
	readonly status: LegacyMigrationProjectionStatus;
	readonly manifestDigest: string;
	readonly expectedRecordCount: number;
	readonly expectedRecordSetDigest: string;
	readonly configurationJson: string;
	readonly configurationDigest: string;
	readonly recoveredFields: readonly string[];
	readonly lostFields: readonly string[];
	readonly records: readonly LegacyMigrationRecordProjection[];
	readonly terminalSequence: number | null;
	readonly failureReasonCode: string | null;
}

/** 显式跨 stream join 产生的 authority lifecycle head；session reducer 永远不会自行猜测该值。 */
export interface SessionLifecycleHeadRef {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly subjectSessionId: SessionId;
	readonly stream: AuthorityTenantEventStreamRef;
	readonly cursor: EventCursor;
	readonly finalSessionHead: EventCursor;
	readonly lifecycle: "handoff" | "deletion";
	readonly state: "requested" | "planned" | "tombstoned" | "committed" | "failed";
	readonly referenceGraphDigest: string;
}

export interface SessionProjectionState {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly stream: SessionEventStreamRef;
	readonly genesis: SessionGenesisProjection;
	readonly migration: LegacyMigrationProjection | null;
	readonly lifecycleHeadRef: SessionLifecycleHeadRef | null;
	readonly lifecycle: SessionLifecycleStatus;
	readonly terminalEventId: EventId | null;
	readonly activeTurnId: TurnId | null;
	readonly activeModelRequestId: string | null;
	readonly turns: readonly TurnProjection[];
	readonly modelRequests: readonly ModelRequestProjection[];
	readonly toolCalls: readonly ToolCallProjection[];
	readonly queueItems: readonly QueueItemProjection[];
	readonly checkpoints: readonly CheckpointProjection[];
	readonly activeLeafId: LeafId;
	readonly knownLeafIds: readonly LeafId[];
	readonly hasUncertainOperations: boolean;
	readonly headSequence: number;
	readonly headEventId: EventId;
	readonly headEventHash: string;
	readonly headTraceId: TraceId;
}

export interface SessionProjection extends SessionProjectionState {
	readonly projectionDigest: string;
}
