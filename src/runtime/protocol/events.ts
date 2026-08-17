/** Runtime 当前 exact event catalog、payload 与 envelope 类型。 */

import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "./foundation.ts";
import type { RuntimeErrorShape } from "./errors.ts";
import type {
	AuthorityId,
	EventId,
	PrincipalId,
	RuntimeId,
	SessionId,
	TenantId,
	TraceId,
} from "./ids.ts";

export const RUNTIME_EVENT_TYPES = [
	"session.created",
	"session.forked",
	"session.stop_requested",
	"session.stopped",
	"session.closed",
	"session.corrupted",
	"session.repair_reported",
	"session.handoff_requested",
	"session.handoff_committed",
	"session.handoff_failed",
	"session.deletion_planned",
	"session.deletion_tombstoned",
	"session.deletion_committed",
	"session.deletion_failed",
	"input.source_recorded",
	"input.declassification_decided",
	"goal.transitioned",
	"task.created",
	"task.definition_revised",
	"task.transitioned",
	"task.output_bound",
	"turn.started",
	"turn.finished",
	"turn.interrupted",
	"turn.failed",
	"model.routed",
	"model.requested",
	"model.finished",
	"model.failed",
	"tool.requested",
	"tool.authorized",
	"tool.started",
	"tool.finished",
	"tool.interrupted",
	"tool.failed",
	"queue.enqueued",
	"queue.claimed",
	"queue.consumed",
	"queue.cancelled",
	"agent.root_registered",
	"agent.spawn_requested",
	"agent.spawned",
	"agent.activated",
	"agent.reconciliation_required",
	"agent.paused",
	"agent.stopped",
	"agent.partial_committed",
	"agent.handoff_requested",
	"agent.handoff_committed",
	"agent.handoff_failed",
	"agent.merge_requested",
	"agent.merge_committed",
	"agent.merge_failed",
	"agent.finished",
	"agent.failed",
	"workspace.bound",
	"workspace.validation_recorded",
	"workspace.released",
	"permission.requested",
	"permission.decided",
	"permission.expired",
	"permission.revoked",
	"capability.rate_limit_recorded",
	"sandbox.resolved",
	"sandbox.execution_recorded",
	"lease.acquired",
	"lease.taken_over",
	"lease.released",
	"checkpoint.created",
	"checkpoint.rewound",
	"artifact.intent_recorded",
	"artifact.created",
	"artifact.committed",
	"episode.manifest_committed",
	"episode.seal_recorded",
	"verification.started",
	"verification.finished",
	"finding.transitioned",
	"change_proposal.created",
	"draft_pr.requested",
	"draft_pr.created",
	"draft_pr.failed",
	"human_gate.requested",
	"human_gate.decided",
	"resource.approved",
	"resource.revoked",
	"resource.snapshot_acquired",
	"resource.activated",
	"resource.deactivated",
	"resource.failed",
	"context.assembled",
	"plan.enter_requested",
	"plan.entered",
	"plan.approval_requested",
	"plan.approved",
	"plan.exit_requested",
	"plan.exited",
	"plan.failed",
	"compaction.started",
	"compaction.completed",
	"compaction.failed",
	"memory.proposed",
	"memory.approved",
	"memory.revoked",
	"memory.search_recorded",
	"command.claimed",
	"command.applied",
	"command.rejected",
	"command.reconciliation_required",
	"owner.claimed",
	"owner.taken_over",
	"owner.released",
	"owner.fenced",
	"driver.claimed",
	"driver.released",
	"driver.reset_on_takeover",
	"recovery.verified_clean",
	"recovery.verify",
	"recovery.abort",
	"recovery.resume_despite_uncertainty",
	"policy.effective_recorded",
	"policy.normalization_recorded",
	"cost.recorded",
	"cost.reconciled",
	"telemetry.delivery_recorded",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export const EVENT_TRANSITION_ACTIONS = [
	"created",
	"forked",
	"stop_requested",
	"stopped",
	"closed",
	"corrupted",
	"handoff_requested",
	"handoff_committed",
	"handoff_failed",
	"deletion_planned",
	"deletion_tombstoned",
	"deletion_committed",
	"deletion_failed",
	"declassification_decided",
	"transitioned",
	"definition_revised",
	"output_bound",
	"started",
	"finished",
	"interrupted",
	"failed",
	"routed",
	"requested",
	"authorized",
	"enqueued",
	"claimed",
	"consumed",
	"cancelled",
	"root_registered",
	"spawn_requested",
	"spawned",
	"paused",
	"partial_committed",
	"merge_requested",
	"merge_committed",
	"merge_failed",
	"bound",
	"released",
	"decided",
	"expired",
	"revoked",
	"resolved",
	"acquired",
	"taken_over",
	"rewound",
	"approved",
	"activated",
	"deactivated",
	"enter_requested",
	"entered",
	"approval_requested",
	"exit_requested",
	"exited",
	"completed",
	"proposed",
	"applied",
	"rejected",
	"reconciliation_required",
	"fenced",
	"verified_clean",
	"verify",
	"abort",
	"reset_on_takeover",
	"resume_despite_uncertainty",
	"reconciled",
] as const;

export const EVENT_BINDING_REQUIRED_TYPES = [
	"session.created",
	"session.forked",
	"session.handoff_requested",
	"session.handoff_committed",
	"session.deletion_planned",
	"task.created",
	"task.definition_revised",
	"task.output_bound",
	"tool.requested",
	"tool.authorized",
	"queue.enqueued",
	"queue.claimed",
	"agent.spawn_requested",
	"agent.spawned",
	"agent.handoff_requested",
	"agent.handoff_committed",
	"agent.merge_requested",
	"agent.merge_committed",
	"workspace.bound",
	"permission.requested",
	"lease.taken_over",
	"draft_pr.requested",
	"draft_pr.created",
	"human_gate.requested",
	"human_gate.decided",
	"resource.approved",
	"resource.snapshot_acquired",
	"command.claimed",
] as const satisfies readonly RuntimeEventType[];

export const EVENT_REF_REQUIRED_ACTIONS = [
	"repair_reported",
	"source_recorded",
	"declassification_decided",
	"validation_recorded",
	"rate_limit_recorded",
	"execution_recorded",
	"intent_recorded",
	"manifest_committed",
	"seal_recorded",
	"search_recorded",
	"effective_recorded",
	"normalization_recorded",
	"recorded",
	"delivery_recorded",
	"requested",
	"started",
	"finished",
	"failed",
	"committed",
	"authorized",
	"decided",
	"expired",
	"revoked",
	"resolved",
	"acquired",
	"taken_over",
	"released",
	"approved",
	"activated",
	"deactivated",
	"snapshot_acquired",
	"assembled",
	"entered",
	"exited",
	"completed",
	"partial_committed",
	"output_bound",
	"routed",
	"applied",
	"rejected",
	"reconciled",
	"corrupted",
	"stopped",
	"closed",
	"rewound",
	"bound",
	"spawned",
] as const;

export const EVENT_REF_REQUIRED_TYPES = [
	"task.created",
	"artifact.created",
	"change_proposal.created",
	"draft_pr.created",
	"agent.reconciliation_required",
] as const satisfies readonly RuntimeEventType[];

export const EVENT_IDEMPOTENCY_ACTIONS = [
	"created",
	"root_registered",
	"requested",
	"started",
	"acquired",
	"claimed",
	"enqueued",
	"proposed",
	"intent_recorded",
] as const;

export const EVENT_REASON_REQUIRED_ACTIONS = [
	"failed",
	"interrupted",
	"cancelled",
	"corrupted",
	"stop_requested",
	"stopped",
	"closed",
	"released",
	"rewound",
	"rejected",
	"revoked",
	"expired",
	"reconciliation_required",
	"abort",
] as const;

export const EVENT_METADATA_REQUIRED_ACTIONS = [
	"repair_reported",
	"source_recorded",
	"validation_recorded",
	"rate_limit_recorded",
	"execution_recorded",
	"intent_recorded",
	"manifest_committed",
	"seal_recorded",
	"search_recorded",
	"effective_recorded",
	"normalization_recorded",
	"recorded",
	"delivery_recorded",
	"definition_revised",
	"routed",
	"assembled",
] as const;

export type RuntimeEventSubjectKind =
	| "authority"
	| "session"
	| "goal"
	| "task"
	| "turn"
	| "toolCall"
	| "queueItem"
	| "agent"
	| "workspace"
	| "approval"
	| "principal"
	| "snapshot"
	| "artifact"
	| "finding"
	| "proposal"
	| "resource"
	| "command";

export interface RuntimeEventSubject {
	readonly kind: RuntimeEventSubjectKind;
	readonly id: RuntimeId;
}

export interface RuntimeEventTransition {
	readonly revision: number;
	readonly previousStatus: string | null;
	readonly nextStatus: string;
}

export interface RuntimeEventBinding {
	readonly role: string;
	readonly subjectId: RuntimeId;
}

export interface RuntimeEventPayload {
	readonly subject: RuntimeEventSubject;
	readonly correlationId: TraceId;
	readonly effect: "none" | "committed" | "uncertain";
	readonly idempotencyKey?: string;
	readonly expectedRevision?: number;
	readonly transition?: RuntimeEventTransition;
	readonly reasonCode?: string;
	readonly bindings?: readonly RuntimeEventBinding[];
	readonly refs?: readonly RuntimeContentRef[];
	readonly metadataDigest?: RuntimeDigest;
}

/** Model route evidence may carry purpose, but never prompt or provider secrets. */
export type RuntimeModelRequestKind = "interactive" | "idle-recap" | "auto-title";

export interface ModelRoutedPayloadFields {
	readonly requestKind?: RuntimeModelRequestKind;
}

type RuntimeEventAction<TType extends RuntimeEventType> = TType extends `${string}.${infer TAction}` ? TAction : never;
type RequiredPayloadField<TKey extends keyof RuntimeEventPayload> = Required<Pick<RuntimeEventPayload, TKey>>;
type EmptyPayloadRequirement = Record<never, never>;
type ActionRequires<TType extends RuntimeEventType, TActions extends string> =
	RuntimeEventAction<TType> extends TActions ? true : false;

export type RuntimeEventPayloadFor<TType extends RuntimeEventType> = RuntimeEventPayload &
	(TType extends "model.routed" ? ModelRoutedPayloadFields : EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_TRANSITION_ACTIONS)[number]> extends true
		? RequiredPayloadField<"transition">
		: EmptyPayloadRequirement) &
	(TType extends (typeof EVENT_BINDING_REQUIRED_TYPES)[number]
		? RequiredPayloadField<"bindings">
		: EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_REF_REQUIRED_ACTIONS)[number]> extends true
		? RequiredPayloadField<"refs">
		: TType extends (typeof EVENT_REF_REQUIRED_TYPES)[number]
			? RequiredPayloadField<"refs">
			: EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_TRANSITION_ACTIONS)[number]> extends true
		? ActionRequires<TType, (typeof EVENT_IDEMPOTENCY_ACTIONS)[number]> extends true
			? EmptyPayloadRequirement
			: RequiredPayloadField<"expectedRevision">
		: EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_IDEMPOTENCY_ACTIONS)[number]> extends true
		? RequiredPayloadField<"idempotencyKey">
		: EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_REASON_REQUIRED_ACTIONS)[number]> extends true
		? RequiredPayloadField<"reasonCode">
		: EmptyPayloadRequirement) &
	(ActionRequires<TType, (typeof EVENT_METADATA_REQUIRED_ACTIONS)[number]> extends true
		? RequiredPayloadField<"metadataDigest">
		: EmptyPayloadRequirement);

export type RuntimeEventPayloadByType = {
	readonly [TType in RuntimeEventType]: RuntimeEventPayloadFor<TType>;
};

export interface SessionRuntimeStreamRef {
	readonly scope: "session";
	readonly streamId: SessionId;
	readonly sessionId: SessionId;
}

export interface AuthorityTenantRuntimeStreamRef {
	readonly scope: "authority_tenant";
	readonly streamId: RuntimeId;
}

export type RuntimeStreamRef = SessionRuntimeStreamRef | AuthorityTenantRuntimeStreamRef;

export interface RuntimeEventEnvelope<
	TType extends RuntimeEventType,
	TPayload extends RuntimeEventPayloadByType[TType],
> {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly eventId: EventId;
	readonly stream: RuntimeStreamRef;
	readonly sequence: number;
	readonly timestamp: string;
	readonly type: TType;
	readonly previousEventHash: RuntimeDigest | null;
	readonly payloadDigest: RuntimeDigest;
	readonly currentEventHash: RuntimeDigest;
	readonly traceId: TraceId;
	readonly payload: TPayload;
}

export type RuntimeEvent = {
	readonly [TType in RuntimeEventType]: RuntimeEventEnvelope<TType, RuntimeEventPayloadByType[TType]>;
}[RuntimeEventType];

export interface DurableEventReceipt {
	readonly receiptId: RuntimeId<"receipt">;
	readonly stream: RuntimeStreamRef;
	readonly cursor: string;
	readonly sequence: number;
	readonly eventHash: RuntimeDigest;
	readonly writerEpoch: number;
	readonly durableAt: string;
}

export interface RuntimeEventRangeRef {
	readonly stream: RuntimeStreamRef;
	readonly startSequence: number;
	readonly endSequence: number;
	readonly head: RuntimeStreamHead;
	readonly rangeDigest: RuntimeDigest;
	readonly complete: boolean;
}

export type AppendEventOutcome =
	| {
			readonly outcome: "accepted";
			readonly eventId: EventId;
			readonly stream: RuntimeStreamRef;
			readonly sequence: number;
			readonly acceptedAt: string;
	  }
	| {
			readonly outcome: "durable";
			readonly receipt: DurableEventReceipt;
	  }
	| {
			readonly outcome: "rejected";
			readonly error: RuntimeErrorShape;
	  }
	| {
			readonly outcome: "uncertain";
			readonly eventId: EventId;
			readonly stream: RuntimeStreamRef;
			readonly error: RuntimeErrorShape;
	  };

export function isKnownRuntimeEventType(value: unknown): value is RuntimeEventType {
	return typeof value === "string" && (RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}
