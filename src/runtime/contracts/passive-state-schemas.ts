/** Runtime passive projection 与 snapshot 的 exact TypeBox schemas。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../protocol/ids.ts";
import { RuntimeEventRangeRefSchema, isRuntimeEventRangeRef } from "../protocol/schemas.ts";
import type { RuntimeProjection, RuntimeSnapshotDescriptor } from "./passive-state.ts";

const ProjectionCompletenessSchema = Type.Union([Type.Literal("complete"), Type.Literal("partial")]);

function projectionMetadataSchemas() {
	return {
		sourceHead: RuntimeStreamHeadSchema,
		projectionDigest: RuntimeDigestSchema,
		builtAt: CanonicalUtcTimestampSchema,
		completeness: ProjectionCompletenessSchema,
	};
}

export const SessionProjectionSchema = Type.Object(
	{
		projectionKind: Type.Literal("session"),
		sessionId: RuntimeIdSchema,
		status: Type.Union([
			Type.Literal("created"),
			Type.Literal("running"),
			Type.Literal("stopping"),
			Type.Literal("stopped"),
			Type.Literal("closed"),
			Type.Literal("corrupted"),
		]),
		rootGoalId: RuntimeIdSchema,
		rootAgentId: RuntimeIdSchema,
		...projectionMetadataSchemas(),
	},
	{ additionalProperties: false },
);

export const GoalProjectionSchema = Type.Object(
	{
		projectionKind: Type.Literal("goal"),
		sessionId: RuntimeIdSchema,
		goalId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		status: Type.Union([
			Type.Literal("proposed"),
			Type.Literal("active"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		completionRef: Type.Optional(RuntimeContentRefSchema),
		verificationRef: Type.Optional(RuntimeContentRefSchema),
		...projectionMetadataSchemas(),
	},
	{ additionalProperties: false },
);

const TaskPassiveStateSchema = Type.Object(
	{
		taskId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("failed"),
			Type.Literal("cancelled"),
		]),
		priority: Type.Union([
			Type.Literal("low"),
			Type.Literal("normal"),
			Type.Literal("high"),
			Type.Literal("critical"),
		]),
		definitionDigest: RuntimeDigestSchema,
		dependencyIds: Type.Array(RuntimeIdSchema, { maxItems: 64 }),
		outputRefs: Type.Array(RuntimeContentRefSchema, { maxItems: 16 }),
	},
	{ additionalProperties: false },
);

export const TaskProjectionSchema = Type.Object(
	{
		projectionKind: Type.Literal("task"),
		sessionId: RuntimeIdSchema,
		tasks: Type.Array(TaskPassiveStateSchema, { maxItems: 256 }),
		...projectionMetadataSchemas(),
	},
	{ additionalProperties: false },
);

const QueueItemPassiveStateSchema = Type.Object(
	{
		queueItemId: RuntimeIdSchema,
		kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
		status: Type.Union([
			Type.Literal("enqueued"),
			Type.Literal("claimed"),
			Type.Literal("consumed"),
			Type.Literal("cancelled"),
		]),
		order: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		targetTurnId: Type.Optional(RuntimeIdSchema),
		payloadRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const QueueProjectionSchema = Type.Object(
	{
		projectionKind: Type.Literal("queue"),
		sessionId: RuntimeIdSchema,
		items: Type.Array(QueueItemPassiveStateSchema, { maxItems: 256 }),
		...projectionMetadataSchemas(),
	},
	{ additionalProperties: false },
);

const AgentGraphNodeSchema = Type.Object(
	{
		agentId: RuntimeIdSchema,
		parentAgentId: Type.Optional(RuntimeIdSchema),
		status: Type.Union([
			Type.Literal("requested"),
			Type.Literal("running"),
			Type.Literal("paused"),
			Type.Literal("stopped"),
			Type.Literal("finished"),
			Type.Literal("failed"),
		]),
		delegationDigest: RuntimeDigestSchema,
		budgetRef: Type.Optional(RuntimeContentRefSchema),
		workspaceRef: Type.Optional(RuntimeContentRefSchema),
		capabilityRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const AgentGraphProjectionSchema = Type.Object(
	{
		projectionKind: Type.Literal("agent_graph"),
		sessionId: RuntimeIdSchema,
		nodes: Type.Array(AgentGraphNodeSchema, { maxItems: 128 }),
		...projectionMetadataSchemas(),
	},
	{ additionalProperties: false },
);

export const RUNTIME_PROJECTION_SCHEMAS = {
	session: SessionProjectionSchema,
	goal: GoalProjectionSchema,
	task: TaskProjectionSchema,
	queue: QueueProjectionSchema,
	agent_graph: AgentGraphProjectionSchema,
} as const;

export const RuntimeSnapshotDescriptorSchema = Type.Object(
	{
		snapshotId: RuntimeIdSchema,
		snapshotKind: Type.Union([
			Type.Literal("session_projection"),
			Type.Literal("resource_catalog"),
			Type.Literal("context"),
			Type.Literal("workspace"),
			Type.Literal("composite"),
		]),
		sourceRange: RuntimeEventRangeRefSchema,
		snapshotDigest: RuntimeDigestSchema,
		artifactRef: Type.Optional(RuntimeContentRefSchema),
		builtAt: CanonicalUtcTimestampSchema,
		completeness: ProjectionCompletenessSchema,
	},
	{ additionalProperties: false },
);

export function isRuntimeProjection(value: unknown): value is RuntimeProjection {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.projectionKind !== "string" || !(candidate.projectionKind in RUNTIME_PROJECTION_SCHEMAS)) return false;
	const schema = RUNTIME_PROJECTION_SCHEMAS[candidate.projectionKind as keyof typeof RUNTIME_PROJECTION_SCHEMAS];
	if (!Value.Check(schema, value) || !isCanonicalUtcTimestamp(candidate.builtAt)) return false;
	if (!isRuntimeId(candidate.sessionId, "session")) return false;
	switch (candidate.projectionKind) {
		case "session":
			return isRuntimeId(candidate.rootGoalId, "goal") && isRuntimeId(candidate.rootAgentId, "agent");
		case "goal":
			return isRuntimeId(candidate.goalId, "goal");
		case "task":
			return (candidate.tasks as readonly { taskId: unknown; dependencyIds: readonly unknown[] }[]).every(
				(task) => isRuntimeId(task.taskId, "task") && task.dependencyIds.every((id) => isRuntimeId(id, "task")),
			);
		case "queue":
			return (candidate.items as readonly { queueItemId: unknown; targetTurnId?: unknown }[]).every(
				(item) => isRuntimeId(item.queueItemId, "queueItem") && (item.targetTurnId === undefined || isRuntimeId(item.targetTurnId, "turn")),
			);
		case "agent_graph":
			return (candidate.nodes as readonly { agentId: unknown; parentAgentId?: unknown }[]).every(
				(node) => isRuntimeId(node.agentId, "agent") && (node.parentAgentId === undefined || isRuntimeId(node.parentAgentId, "agent")),
			);
	}
	return false;
}

export function isRuntimeSnapshotDescriptor(value: unknown): value is RuntimeSnapshotDescriptor {
	if (!Value.Check(RuntimeSnapshotDescriptorSchema, value)) return false;
	return (
		isRuntimeId(value.snapshotId, "snapshot") &&
		isCanonicalUtcTimestamp(value.builtAt) &&
		isRuntimeEventRangeRef(value.sourceRange)
	);
}
