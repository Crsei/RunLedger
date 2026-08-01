/** Plan Mode exact schemas 与 runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../../protocol/ids.ts";
import type { PlanApprovalRef, PlanArtifactRef, PlanModeState } from "./types.ts";

export const PlanArtifactRefSchema = Type.Object(
	{
		goalId: RuntimeIdSchema,
		workspaceId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		digest: RuntimeDigestSchema,
		artifactRef: RuntimeContentRefSchema,
	},
	{ additionalProperties: false },
);

export const PlanApprovalRefSchema = Type.Object(
	{
		approvalId: RuntimeIdSchema,
		goalId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		digest: RuntimeDigestSchema,
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("approved"),
			Type.Literal("rejected"),
			Type.Literal("expired"),
			Type.Literal("invalidated"),
		]),
		receiptRef: Type.Optional(RuntimeContentRefSchema),
	},
	{ additionalProperties: false },
);

export const PlanModeStateSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("inactive"),
			Type.Literal("pending"),
			Type.Literal("active"),
			Type.Literal("awaiting_approval"),
			Type.Literal("exit_pending"),
		]),
		sessionId: RuntimeIdSchema,
		goalId: RuntimeIdSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		plan: Type.Optional(PlanArtifactRefSchema),
		approval: Type.Optional(PlanApprovalRefSchema),
		policyCeilingDigest: RuntimeDigestSchema,
		sourceHead: RuntimeStreamHeadSchema,
		projectionDigest: RuntimeDigestSchema,
		completeness: Type.Union([Type.Literal("complete"), Type.Literal("partial")]),
		updatedAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export function isPlanArtifactRef(value: unknown): value is PlanArtifactRef {
	if (!Value.Check(PlanArtifactRefSchema, value)) return false;
	return isRuntimeId(value.goalId, "goal") && isRuntimeId(value.workspaceId, "workspace");
}

export function isPlanApprovalRef(value: unknown): value is PlanApprovalRef {
	if (!Value.Check(PlanApprovalRefSchema, value)) return false;
	return isRuntimeId(value.approvalId, "approval") && isRuntimeId(value.goalId, "goal");
}

export function isPlanModeState(value: unknown): value is PlanModeState {
	if (!Value.Check(PlanModeStateSchema, value)) return false;
	return (
		isRuntimeId(value.sessionId, "session") &&
		isRuntimeId(value.goalId, "goal") &&
		(value.plan === undefined || (isPlanArtifactRef(value.plan) && value.plan.goalId === value.goalId)) &&
		(value.approval === undefined || (isPlanApprovalRef(value.approval) && value.approval.goalId === value.goalId)) &&
		isCanonicalUtcTimestamp(value.updatedAt)
	);
}
