/** RuntimeActivity 的 canonical metadata-only projection 合同。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import { EventCursorSchema } from "../protocol/v3/event-references.ts";
import type {
	AgentId,
	ApprovalId,
	AuthorityId,
	GoalId,
	PrincipalId,
	SessionId,
	TenantId,
	ToolCallId,
	TurnId,
} from "../protocol/v3/ids.ts";

/** v1 是旧 telemetry signal projector 的只读兼容形状，不再产生新投影。 */
export const LEGACY_RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION = 1 as const;
/** v2 是 Runtime、telemetry、Control Plane 与 daemon 共用的唯一 canonical 形状。 */
export const RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION = 2 as const;

export const RUNTIME_ACTIVITY_LIFECYCLES = [
	"active",
	"migration_in_progress",
	"migration_failed",
	"stop_requested",
	"stopped",
	"closed",
	"corrupted",
] as const;
export type RuntimeActivityLifecycle = (typeof RUNTIME_ACTIVITY_LIFECYCLES)[number];

export const RUNTIME_ACTIVITY_STATUSES = ["idle", "active", "waiting_permission", "draining"] as const;
export type RuntimeActivityStatus = (typeof RUNTIME_ACTIVITY_STATUSES)[number];

export interface RuntimeActivityHeartbeat {
	/** 最后一个已通过 chain verification 的 canonical event 时间。 */
	observedAt: string;
	cursor: EventCursor;
}

/**
 * 只暴露稳定 identity、状态 ID 与 durable cursor；不包含 prompt、tool args/output、
 * objective、permission summary、env 或模型 private reasoning。
 */
export interface RuntimeActivityProjection {
	schemaVersion: typeof RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION;
	projectionKind: "runtime_activity";
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	revision: number;
	lifecycle: RuntimeActivityLifecycle;
	status: RuntimeActivityStatus;
	activeGoalIds: readonly GoalId[];
	activeTaskIds: readonly string[];
	activeTurnId: TurnId | null;
	activeToolCallIds: readonly ToolCallId[];
	nestedAgentIds: readonly AgentId[];
	waitingPermissionIds: readonly ApprovalId[];
	heartbeat: RuntimeActivityHeartbeat;
	projectedThroughSequence: number;
	projectionDigest: string;
}

export interface LegacyRuntimeActivityProjectionV1 {
	schemaVersion: typeof LEGACY_RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION;
	projectionKind: "runtime_activity";
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	revision: number;
	status: "idle" | "active" | "waiting_permission";
	activeTaskIds: readonly string[];
	activeToolCallIds: readonly ToolCallId[];
	nestedAgentIds: readonly AgentId[];
	waitingPermissionIds: readonly ApprovalId[];
	heartbeatAt: string;
	projectedThroughSequence: number;
	projectionDigest: string;
}

export const RUNTIME_ACTIVITY_ERROR_CODES = [
	"invalid_event",
	"scope_mismatch",
	"out_of_order",
	"corrupted_log",
] as const;
export type RuntimeActivityErrorCode = (typeof RUNTIME_ACTIVITY_ERROR_CODES)[number];

export interface RuntimeActivityError {
	code: RuntimeActivityErrorCode;
	message: string;
	retryable: false;
	details?: Readonly<Record<string, string | number | boolean>>;
}

export type RuntimeActivityResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: RuntimeActivityError };

const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const taskId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", maxLength: 128 });

export const RuntimeActivityHeartbeatSchema = exact({
	observedAt: timestamp,
	cursor: EventCursorSchema,
});

/** 仅用于识别已持久化的旧投影；canonical projector 永远不会返回 v1。 */
export const LegacyRuntimeActivityProjectionV1Schema = exact({
	schemaVersion: Type.Literal(LEGACY_RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION),
	projectionKind: Type.Literal("runtime_activity"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	revision: Type.Integer({ minimum: 1 }),
	status: Type.Union([Type.Literal("idle"), Type.Literal("active"), Type.Literal("waiting_permission")]),
	activeTaskIds: Type.Array(taskId, { maxItems: 4_096, uniqueItems: true }),
	activeToolCallIds: Type.Array(runtimeId("toolCall"), { maxItems: 4_096, uniqueItems: true }),
	nestedAgentIds: Type.Array(runtimeId("agent"), { maxItems: 4_096, uniqueItems: true }),
	waitingPermissionIds: Type.Array(runtimeId("approval"), { maxItems: 4_096, uniqueItems: true }),
	heartbeatAt: timestamp,
	projectedThroughSequence: Type.Integer({ minimum: 0 }),
	projectionDigest: digest,
});

export const RuntimeActivityProjectionSchema = exact({
	schemaVersion: Type.Literal(RUNTIME_ACTIVITY_PROJECTION_SCHEMA_VERSION),
	projectionKind: Type.Literal("runtime_activity"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	revision: Type.Integer({ minimum: 1 }),
	lifecycle: Type.Union(RUNTIME_ACTIVITY_LIFECYCLES.map((value) => Type.Literal(value))),
	status: Type.Union(RUNTIME_ACTIVITY_STATUSES.map((value) => Type.Literal(value))),
	activeGoalIds: Type.Array(runtimeId("goal"), { maxItems: 4_096, uniqueItems: true }),
	activeTaskIds: Type.Array(taskId, { maxItems: 4_096, uniqueItems: true }),
	activeTurnId: Type.Union([runtimeId("turn"), Type.Null()]),
	activeToolCallIds: Type.Array(runtimeId("toolCall"), { maxItems: 4_096, uniqueItems: true }),
	nestedAgentIds: Type.Array(runtimeId("agent"), { maxItems: 4_096, uniqueItems: true }),
	waitingPermissionIds: Type.Array(runtimeId("approval"), { maxItems: 4_096, uniqueItems: true }),
	heartbeat: RuntimeActivityHeartbeatSchema,
	projectedThroughSequence: Type.Integer({ minimum: 0 }),
	projectionDigest: digest,
});

export type RuntimeActivityProjectionBody = Omit<RuntimeActivityProjection, "projectionDigest">;

export function runtimeActivityProjectionBody(
	projection: RuntimeActivityProjection | RuntimeActivityProjectionBody,
): RuntimeActivityProjectionBody {
	const {
		schemaVersion,
		projectionKind,
		authorityId,
		tenantId,
		principalId,
		sessionId,
		revision,
		lifecycle,
		status,
		activeGoalIds,
		activeTaskIds,
		activeTurnId,
		activeToolCallIds,
		nestedAgentIds,
		waitingPermissionIds,
		heartbeat,
		projectedThroughSequence,
	} = projection;
	return {
		schemaVersion,
		projectionKind,
		authorityId,
		tenantId,
		principalId,
		sessionId,
		revision,
		lifecycle,
		status,
		activeGoalIds: [...activeGoalIds],
		activeTaskIds: [...activeTaskIds],
		activeTurnId,
		activeToolCallIds: [...activeToolCallIds],
		nestedAgentIds: [...nestedAgentIds],
		waitingPermissionIds: [...waitingPermissionIds],
		heartbeat: { observedAt: heartbeat.observedAt, cursor: structuredClone(heartbeat.cursor) },
		projectedThroughSequence,
	};
}

function sortedUnique(values: readonly string[]): boolean {
	return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function terminalLifecycle(lifecycle: RuntimeActivityLifecycle): boolean {
	return lifecycle === "migration_failed" || lifecycle === "stopped" || lifecycle === "closed" || lifecycle === "corrupted";
}

export function runtimeActivityStatus(projection: Pick<
	RuntimeActivityProjectionBody,
	"lifecycle" | "activeGoalIds" | "activeTaskIds" | "activeTurnId" | "activeToolCallIds" | "nestedAgentIds" | "waitingPermissionIds"
>): RuntimeActivityStatus {
	if (projection.lifecycle === "stop_requested") return "draining";
	if (terminalLifecycle(projection.lifecycle)) return "idle";
	if (projection.waitingPermissionIds.length > 0) return "waiting_permission";
	return (
		projection.activeGoalIds.length > 0 ||
		projection.activeTaskIds.length > 0 ||
		projection.activeTurnId !== null ||
		projection.activeToolCallIds.length > 0 ||
		projection.nestedAgentIds.length > 0
	) ? "active" : "idle";
}

export function isRuntimeActivityProjection(value: unknown): value is RuntimeActivityProjection {
	if (!Check(RuntimeActivityProjectionSchema, value)) return false;
	const projection = value as unknown as RuntimeActivityProjection;
	if (
		projection.revision !== projection.projectedThroughSequence + 1 ||
		projection.heartbeat.cursor.sequence !== projection.projectedThroughSequence ||
		projection.heartbeat.cursor.stream.scope !== "session" ||
		projection.heartbeat.cursor.stream.sessionId !== projection.sessionId ||
		!sortedUnique(projection.activeGoalIds) ||
		!sortedUnique(projection.activeTaskIds) ||
		!sortedUnique(projection.activeToolCallIds) ||
		!sortedUnique(projection.nestedAgentIds) ||
		!sortedUnique(projection.waitingPermissionIds) ||
		projection.status !== runtimeActivityStatus(projection)
	) return false;
	if (
		terminalLifecycle(projection.lifecycle) &&
		(
			projection.activeGoalIds.length > 0 ||
			projection.activeTaskIds.length > 0 ||
			projection.activeTurnId !== null ||
			projection.activeToolCallIds.length > 0 ||
			projection.nestedAgentIds.length > 0 ||
			projection.waitingPermissionIds.length > 0
		)
	) return false;
	return projection.projectionDigest === canonicalDigest(runtimeActivityProjectionBody(projection));
}

export function isLegacyRuntimeActivityProjectionV1(value: unknown): value is LegacyRuntimeActivityProjectionV1 {
	return Check(LegacyRuntimeActivityProjectionV1Schema, value);
}
