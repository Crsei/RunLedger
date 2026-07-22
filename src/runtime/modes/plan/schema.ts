/** Plan Mode 的 exact TypeBox schema、版本栅栏与引用绑定。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema, ApprovalReceiptRefSchema, isApprovalReceiptRef } from "../../protocol/v3/capability.ts";
import { createSessionEventStreamRef, sameRuntimeEventStream } from "../../protocol/v3/events.ts";
import { ExpectedRevisionSchema } from "../../protocol/v3/event-references.ts";
import {
	PLAN_MODE_CONTRACT_VERSION,
	type ApprovedPlanRef,
	type PlanApprovalRef,
	type PlanArtifactRef,
	type PlanModeCommand,
	type PlanModeState,
} from "./types.ts";

export const PLAN_MODE_SCHEMA_VERSION = PLAN_MODE_CONTRACT_VERSION;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const id = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literals = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const PlanArtifactRefSchema = Type.Unsafe<PlanArtifactRef>(exact({
	schemaVersion: Type.Literal(PLAN_MODE_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	planId: id("plan"),
	workspaceId: id("workspace"),
	revision,
	contentDigest: digest,
	artifact: ArtifactRefSchema,
	createdByPrincipalId: id("principal"),
	createdAt: timestamp,
}));

const approvalBase = {
	schemaVersion: Type.Literal(PLAN_MODE_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	approvalId: id("approval"),
	planId: id("plan"),
	planRevision: revision,
	contentDigest: digest,
	workspaceId: id("workspace"),
	requestedByPrincipalId: id("principal"),
	requestedAt: timestamp,
} as const;

export const PlanApprovalRefSchema = Type.Unsafe<PlanApprovalRef>(Type.Union([
	exact({ ...approvalBase, state: Type.Literal("pending") }),
	exact({
		...approvalBase,
		state: literals(["approved", "rejected", "expired", "revoked"] as const),
		receipt: ApprovalReceiptRefSchema,
	}),
]));

export const ApprovedPlanRefSchema = Type.Unsafe<ApprovedPlanRef>(exact({
	schemaVersion: Type.Literal(PLAN_MODE_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	planId: id("plan"),
	workspaceId: id("workspace"),
	revision,
	contentDigest: digest,
	artifact: ArtifactRefSchema,
	approvalReceipt: ApprovalReceiptRefSchema,
}));

const stateBase = {
	schemaVersion: Type.Literal(PLAN_MODE_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sessionId: id("session"),
	modeRevision: revision,
	updatedByPrincipalId: id("principal"),
	updatedAt: timestamp,
} as const;

export const PlanModeStateSchema = Type.Unsafe<PlanModeState>(Type.Union([
	exact({ ...stateBase, kind: Type.Literal("inactive"), mode: Type.Literal("default") }),
	exact({
		...stateBase,
		kind: Type.Literal("pending_activation"),
		mode: Type.Literal("default"),
		requestedBy: literals(["user", "agent"] as const),
		commandId: id("command"),
		approval: Type.Optional(PlanApprovalRefSchema),
	}),
	exact({
		...stateBase,
		kind: Type.Literal("active"),
		mode: Type.Literal("plan"),
		plan: PlanArtifactRefSchema,
		activationDelivered: Type.Boolean(),
	}),
	exact({
		...stateBase,
		kind: Type.Literal("awaiting_approval"),
		mode: Type.Literal("plan"),
		plan: PlanArtifactRefSchema,
		approval: PlanApprovalRefSchema,
	}),
	exact({
		...stateBase,
		kind: Type.Literal("exit_pending"),
		mode: Type.Literal("plan"),
		plan: PlanArtifactRefSchema,
		reason: literals(["user_toggle", "approved", "cancelled"] as const),
		approvedPlan: Type.Optional(ApprovedPlanRefSchema),
	}),
]));

const commandBase = {
	schemaVersion: Type.Literal(PLAN_MODE_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	sessionId: id("session"),
	commandId: id("command"),
	expectedRevision: ExpectedRevisionSchema,
} as const;
const modeRevisionCommand = { ...commandBase, expectedModeRevision: revision } as const;

export const PlanModeCommandSchema = Type.Unsafe<PlanModeCommand>(Type.Union([
	exact({ ...commandBase, kind: Type.Literal("request_activation"), requestedBy: literals(["user", "agent"] as const) }),
	exact({ ...modeRevisionCommand, kind: Type.Literal("activate"), plan: PlanArtifactRefSchema }),
	exact({
		...modeRevisionCommand,
		kind: Type.Literal("write_revision"),
		expectedPlanRevision: revision,
		plan: PlanArtifactRefSchema,
	}),
	exact({
		...modeRevisionCommand,
		kind: Type.Literal("request_approval"),
		plan: PlanArtifactRefSchema,
		approval: PlanApprovalRefSchema,
	}),
	exact({
		...modeRevisionCommand,
		kind: Type.Literal("resolve_approval"),
		plan: PlanArtifactRefSchema,
		approval: PlanApprovalRefSchema,
		action: literals(["approve_same_session", "approve_fresh_context", "request_changes", "reject", "cancel"] as const),
	}),
	exact({
		...modeRevisionCommand,
		kind: Type.Literal("request_exit"),
		reason: literals(["user_toggle", "approved", "cancelled"] as const),
	}),
]));

function sameScope(
	value: { authorityId: string; tenantId: string },
	child: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === child.authorityId && value.tenantId === child.tenantId;
}

function artifactMatchesPlan(plan: PlanArtifactRef): boolean {
	return (
		sameScope(plan, plan.artifact) &&
		plan.artifact.storedDigest === plan.contentDigest &&
		(plan.artifact.workspaceId === undefined || plan.artifact.workspaceId === plan.workspaceId)
	);
}

export function isPlanArtifactRef(value: unknown): value is PlanArtifactRef {
	return Check(PlanArtifactRefSchema, value) && artifactMatchesPlan(value);
}

export function isPlanApprovalRef(value: unknown): value is PlanApprovalRef {
	if (!Check(PlanApprovalRefSchema, value)) return false;
	if (value.state === "pending") return true;
	if (!isApprovalReceiptRef(value.receipt) || !sameScope(value, value.receipt)) return false;
	if (value.receipt.approvalId !== value.approvalId) return false;
	const decisions = {
		approved: "allowed",
		rejected: "denied",
		expired: "expired",
		revoked: "revoked",
	} as const;
	return value.receipt.decision === decisions[value.state];
}

export function isApprovedPlanRef(value: unknown): value is ApprovedPlanRef {
	return (
		Check(ApprovedPlanRefSchema, value) &&
		sameScope(value, value.artifact) &&
		sameScope(value, value.approvalReceipt) &&
		value.artifact.storedDigest === value.contentDigest &&
		value.approvalReceipt.decision === "allowed" &&
		(value.artifact.workspaceId === undefined || value.artifact.workspaceId === value.workspaceId)
	);
}

function planMatchesState(
	state: { authorityId: string; tenantId: string },
	plan: PlanArtifactRef,
): boolean {
	return sameScope(state, plan) && isPlanArtifactRef(plan);
}

export function isPlanModeState(value: unknown): value is PlanModeState {
	if (!Check(PlanModeStateSchema, value)) return false;
	if (value.kind === "inactive") return true;
	if (value.kind === "pending_activation") {
		return value.approval === undefined || (sameScope(value, value.approval) && isPlanApprovalRef(value.approval));
	}
	if (!planMatchesState(value, value.plan)) return false;
	if (value.kind === "awaiting_approval") {
		return (
			sameScope(value, value.approval) &&
			isPlanApprovalRef(value.approval) &&
			value.approval.planId === value.plan.planId &&
			value.approval.planRevision === value.plan.revision &&
			value.approval.contentDigest === value.plan.contentDigest &&
			value.approval.workspaceId === value.plan.workspaceId
		);
	}
	if (value.kind === "exit_pending" && value.approvedPlan !== undefined) {
		return (
			isApprovedPlanRef(value.approvedPlan) &&
			value.approvedPlan.planId === value.plan.planId &&
			value.approvedPlan.revision === value.plan.revision &&
			value.approvedPlan.contentDigest === value.plan.contentDigest
		);
	}
	return true;
}

export function isPlanModeCommand(value: unknown): value is PlanModeCommand {
	if (
		!Check(PlanModeCommandSchema, value) ||
		value.expectedRevision.stream.scope !== "session" ||
		!sameRuntimeEventStream(
			value.expectedRevision.stream,
			createSessionEventStreamRef(value, value.sessionId),
		)
	) return false;
	if (value.kind === "request_activation" || value.kind === "request_exit") return true;
	if (!planMatchesState(value, value.plan)) return false;
	if (value.kind === "write_revision") return value.plan.revision === value.expectedPlanRevision + 1;
	if (value.kind === "request_approval" || value.kind === "resolve_approval") {
		return (
			isPlanApprovalRef(value.approval) &&
			value.approval.planId === value.plan.planId &&
			value.approval.planRevision === value.plan.revision &&
			value.approval.contentDigest === value.plan.contentDigest &&
			value.approval.workspaceId === value.plan.workspaceId &&
			(value.kind !== "resolve_approval" || value.approval.state !== "pending")
		);
	}
	return true;
}
