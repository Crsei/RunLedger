/** Runtime v3 的穷尽事件联合、cursor 与状态转换合同。 */

import type {
	AuthorityId,
	EventId,
	EventStreamId,
	PrincipalId,
	RuntimeScope,
	SessionId,
	TenantId,
	TraceId,
} from "./ids.ts";
import { createEventStreamId } from "./ids.ts";
import type { RuntimeEventPayloadMap } from "./event-payloads.ts";
import type { SecurityRuntimeEventType } from "./security-events.ts";
import type { WorkspaceRuntimeEventType } from "./workspace-events.ts";

export {
	RUNTIME_EVENT_ALLOWED_STREAM_SCOPES,
	RUNTIME_EVENT_TYPES,
	isKnownRuntimeEventType,
	isRuntimeEventTypeAllowedInStream,
} from "./event-catalog.ts";
export type { RuntimeEventStreamScope, RuntimeEventType } from "./event-catalog.ts";
import type { RuntimeEventStreamScope, RuntimeEventType } from "./event-catalog.ts";

export const RUNTIME_SCHEMA_VERSION = 3 as const;
export const RUNTIME_EVENT_MAJOR_VERSION = 3 as const;

export interface SessionEventStreamRef {
	scope: "session";
	streamId: EventStreamId;
	sessionId: SessionId;
}

export interface AuthorityTenantEventStreamRef {
	scope: "authority_tenant";
	streamId: EventStreamId;
}

export type RuntimeEventStreamRef = SessionEventStreamRef | AuthorityTenantEventStreamRef;

export type RuntimeEventStreamComparable =
	| { scope: "session"; streamId: string; sessionId: string }
	| { scope: "authority_tenant"; streamId: string };

export function createSessionEventStreamRef(scope: RuntimeScope, sessionId: SessionId): SessionEventStreamRef {
	return { scope: "session", streamId: createEventStreamId(scope, sessionId), sessionId };
}

export function createAuthorityTenantEventStreamRef(scope: RuntimeScope): AuthorityTenantEventStreamRef {
	return { scope: "authority_tenant", streamId: createEventStreamId(scope) };
}

export function sameRuntimeEventStream(
	left: RuntimeEventStreamComparable,
	right: RuntimeEventStreamComparable,
): boolean {
	return (
		left.scope === right.scope &&
		left.streamId === right.streamId &&
		(left.scope !== "session" || (right.scope === "session" && left.sessionId === right.sessionId))
	);
}

export function isRuntimeEventStreamScope(value: unknown): value is RuntimeEventStreamScope {
	return value === "session" || value === "authority_tenant";
}

export interface EventCursor {
	stream: RuntimeEventStreamRef;
	sequence: number;
	eventId: EventId;
	eventHash: string;
}

export interface ExpectedRevision {
	stream: RuntimeEventStreamRef;
	sequence: number;
	eventHash: string;
}

export interface RuntimeEventEnvelopeV3<TType extends RuntimeEventType = RuntimeEventType> {
	schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	eventId: EventId;
	stream: RuntimeEventStreamRef;
	sequence: number;
	timestamp: string;
	type: TType;
	previousEventHash: string | null;
	payloadDigest: string;
	currentEventHash: string;
	traceId: TraceId;
	payload: RuntimeEventPayloadMap[TType];
}

export type RuntimeEventV3 = {
	[TType in RuntimeEventType]: RuntimeEventEnvelopeV3<TType>;
}[RuntimeEventType];

export type WorkspaceRuntimeEventV3 = {
	[TType in WorkspaceRuntimeEventType]: RuntimeEventEnvelopeV3<TType>;
}[WorkspaceRuntimeEventType];

export type SecurityRuntimeEventV3 = {
	[TType in SecurityRuntimeEventType]: RuntimeEventEnvelopeV3<TType>;
}[SecurityRuntimeEventType];

export { SECURITY_RUNTIME_EVENT_TYPES } from "./security-events.ts";
export type {
	PermissionDecidedPayload,
	PermissionExpiredPayload,
	PermissionRequestedPayload,
	PermissionRequestSummary,
	PermissionRevokedPayload,
	SandboxExecutionRecordedPayload,
	SandboxResolvedPayload,
	SecurityRuntimeEventType,
	ToolAuthorizedPayload,
} from "./security-events.ts";

export { WORKSPACE_RUNTIME_EVENT_TYPES } from "./workspace-events.ts";
export type {
	LeaseAcquiredPayload,
	LeaseReleasedPayload,
	LeaseTakenOverPayload,
	WorkspaceBoundPayload,
	WorkspaceReleasedPayload,
	WorkspaceRuntimeEventType,
	WorkspaceValidationRecordedPayload,
} from "./workspace-events.ts";

export type IntegrityStatus = "valid" | "partial" | "corrupted";
export type AttestationStatus = "attested" | "unattested" | "unavailable";

export const GOAL_PHASES = [
	"planning",
	"awaiting_plan_approval",
	"implementation",
	"build",
	"test",
	"security_review",
	"independent_review",
	"remediation",
	"reverification",
	"awaiting_verification",
	"awaiting_human",
	"completed",
	"failed",
	"stopped",
] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

export const GOAL_PHASE_TRANSITIONS: Readonly<Record<GoalPhase, readonly GoalPhase[]>> = {
	planning: ["awaiting_plan_approval", "awaiting_human", "failed", "stopped"],
	awaiting_plan_approval: ["implementation", "planning", "awaiting_human", "failed", "stopped"],
	implementation: ["build", "awaiting_human", "failed", "stopped"],
	build: ["test", "remediation", "failed", "stopped"],
	test: ["security_review", "remediation", "failed", "stopped"],
	security_review: ["independent_review", "remediation", "failed", "stopped"],
	independent_review: ["awaiting_verification", "remediation", "failed", "stopped"],
	remediation: ["build", "reverification", "awaiting_human", "failed", "stopped"],
	reverification: ["awaiting_verification", "remediation", "failed", "stopped"],
	awaiting_verification: ["completed", "remediation", "awaiting_human", "failed", "stopped"],
	awaiting_human: ["planning", "implementation", "remediation", "failed", "stopped"],
	completed: [],
	failed: [],
	stopped: [],
};

export function isAllowedGoalTransition(from: GoalPhase, to: GoalPhase): boolean {
	return GOAL_PHASE_TRANSITIONS[from].includes(to);
}
