/** Control Plane schema v2 的 Plan/Context/Compaction/Memory 专项合同。 */

import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import {
	ApprovalReceiptRefSchema,
	ArtifactRefSchema,
	type ApprovalReceiptRef,
	type ArtifactRef,
} from "../protocol/v3/capability.ts";
import type { EventCursor, ExpectedRevision } from "../protocol/v3/events.ts";
import { EventCursorSchema, ExpectedRevisionSchema } from "../protocol/v3/event-references.ts";
import type {
	ApprovalId,
	AuthorityId,
	CommandId,
	MemoryId,
	MemoryProposalId,
	PlanId,
	PrincipalId,
	SessionId,
	TenantId,
} from "../protocol/v3/ids.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { PlanModeState } from "../modes/plan/types.ts";
import type {
	CompactionCheckpointRef,
	CompactionReason,
	CompactionSuppressionReceipt,
} from "../context/compaction/types.ts";
import type { ContextAssemblyReceipt } from "../context/types.ts";
import type { MemoryProposal, MemoryRecord, MemoryRef, MemoryStatus } from "../context/memory/types.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import {
	ControlPlanePromptSchema,
	ControlPlaneSessionHandleSchema,
	type ControlPlanePrompt,
	type ControlPlaneRequestContext,
	type ControlPlaneSessionHandle,
} from "./types.ts";

export const CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_TYPES = [
	"plan:enter",
	"plan:resolve",
	"context:compact",
	"memory:propose",
	"memory:resolve",
] as const;
export type ControlPlaneV2PlanContextMemoryCommandType =
	(typeof CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_TYPES)[number];

export const CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_TYPES = [
	"plan:inspect",
	"context:inspect",
	"memory:list",
	"memory:inspect",
] as const;
export type ControlPlaneV2PlanContextMemoryQueryType =
	(typeof CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_TYPES)[number];

interface SpecialtyCommandBase<T extends ControlPlaneV2PlanContextMemoryCommandType, P> {
	kind: "command";
	type: T;
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	expectedSessionRevision: ExpectedRevision;
	expectedDomainRevision: number;
	sessionHandle: ControlPlaneSessionHandle;
	payload: P;
}

export type PlanEnterCommandV2 = SpecialtyCommandBase<
	"plan:enter",
	{
		sessionId: SessionId;
		requestedBy: "user" | "agent";
		description?: ControlPlanePrompt;
	}
>;

export type PlanResolveCommandV2 = SpecialtyCommandBase<
	"plan:resolve",
	{
		sessionId: SessionId;
		approvalId: ApprovalId;
		planId: PlanId;
		action: "approve_same_session" | "approve_fresh_context" | "request_changes" | "reject" | "cancel";
		expectedModeRevision: number;
		expectedPlanRevision: number;
		contentDigest: string;
		resolutionReceipt: ApprovalReceiptRef;
		feedback?: ControlPlanePrompt;
	}
>;

export type ContextCompactCommandV2 = SpecialtyCommandBase<
	"context:compact",
	{
		sessionId: SessionId;
		reason: CompactionReason;
		focus?: ControlPlanePrompt;
	}
>;

export type MemoryProposeCommandV2 = SpecialtyCommandBase<
	"memory:propose",
	{
		sessionId: SessionId;
		operation: "create" | "update" | "revoke" | "scope_change";
		expectedMemoryRevision: number | null;
		expectedContentDigest: string | null;
		draftArtifact: ArtifactRef;
		diffArtifact: ArtifactRef;
		proposalDigest: string;
	}
>;

export type MemoryResolveCommandV2 = SpecialtyCommandBase<
	"memory:resolve",
	{
		sessionId: SessionId;
		proposalId: MemoryProposalId;
		action: "approve" | "edit" | "reject" | "revoke" | "expire";
		expectedProposalRevision: number;
		resolutionReceipt: ApprovalReceiptRef;
		replacementDiffArtifact?: ArtifactRef;
	}
>;

export type ControlPlaneV2PlanContextMemoryCommand =
	| PlanEnterCommandV2
	| PlanResolveCommandV2
	| ContextCompactCommandV2
	| MemoryProposeCommandV2
	| MemoryResolveCommandV2;

interface SpecialtyQueryBase<T extends ControlPlaneV2PlanContextMemoryQueryType, P> {
	kind: "query";
	type: T;
	queryId: string;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	payload: P & { sessionId: SessionId; sessionHandle: ControlPlaneSessionHandle };
}

export type PlanInspectQueryV2 = SpecialtyQueryBase<"plan:inspect", Record<never, never>>;
export type ContextInspectQueryV2 = SpecialtyQueryBase<"context:inspect", Record<never, never>>;
export type MemoryListQueryV2 = SpecialtyQueryBase<
	"memory:list",
	{
		statuses: readonly MemoryStatus[];
		cursor: string | null;
		limit: number;
	}
>;
export type MemoryInspectQueryV2 = SpecialtyQueryBase<"memory:inspect", { memoryId: MemoryId }>;

export type ControlPlaneV2PlanContextMemoryQuery =
	| PlanInspectQueryV2
	| ContextInspectQueryV2
	| MemoryListQueryV2
	| MemoryInspectQueryV2;

export type PlanContextMemoryMutationEffectV2 =
	| {
			type: "plan:enter" | "plan:resolve";
			sessionId: SessionId;
			domainRevision: number;
			durableCursor: EventCursor;
			receiptDigest: string;
			stateKind: PlanModeState["kind"];
			modeRevision: number;
	  }
	| {
			type: "context:compact";
			sessionId: SessionId;
			domainRevision: number;
			durableCursor: EventCursor;
			receiptDigest: string;
			attemptStatus: "started" | "completed" | "failed" | "suppressed";
			checkpointId: string | null;
	  }
	| {
			type: "memory:propose" | "memory:resolve";
			sessionId: SessionId;
			domainRevision: number;
			durableCursor: EventCursor;
			receiptDigest: string;
			proposalId: MemoryProposalId;
			proposalStatus: MemoryProposal["status"];
	  };

export interface PlanInspectionV2 {
	type: "plan:inspect";
	sessionId: SessionId;
	state: PlanModeState;
	projectionDigest: string;
}

export interface ContextInspectionV2 {
	type: "context:inspect";
	sessionId: SessionId;
	contextReceipt: ContextAssemblyReceipt | null;
	checkpoint: CompactionCheckpointRef | null;
	suppression: CompactionSuppressionReceipt | null;
	projectionDigest: string;
}

export interface MemoryListInspectionV2 {
	type: "memory:list";
	sessionId: SessionId;
	records: readonly MemoryRef[];
	nextCursor: string | null;
	projectionDigest: string;
}

export interface MemoryInspectionV2 {
	type: "memory:inspect";
	sessionId: SessionId;
	record: MemoryRecord | null;
	proposal: MemoryProposal | null;
	projectionDigest: string;
}

export type PlanContextMemoryQueryValueV2 =
	| PlanInspectionV2
	| ContextInspectionV2
	| MemoryListInspectionV2
	| MemoryInspectionV2;

export interface ControlPlaneV2PlanContextMemoryCommandResponse {
	kind: "command_result";
	commandId: CommandId;
	type: ControlPlaneV2PlanContextMemoryCommandType;
	status: "executed" | "duplicate";
	result: PlanContextMemoryMutationEffectV2;
}

export interface ControlPlaneV2PlanContextMemoryQueryResponse {
	kind: "query_result";
	queryId: string;
	type: ControlPlaneV2PlanContextMemoryQueryType;
	result: PlanContextMemoryQueryValueV2;
}

export interface PlanContextMemoryControlPlanePort {
	execute(
		command: ControlPlaneV2PlanContextMemoryCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryCommandResponse>>;
	query(
		query: ControlPlaneV2PlanContextMemoryQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryQueryResponse>>;
}

const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const idempotencyKey = Type.String({
	pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$",
	maxLength: 128,
});
const memoryStatus = Type.Union([
	Type.Literal("proposed"),
	Type.Literal("approved"),
	Type.Literal("changed_unreviewed"),
	Type.Literal("revoked"),
	Type.Literal("expired"),
]);
const commandBase = {
	kind: Type.Literal("command"),
	commandId: runtimeId("command"),
	idempotencyKey,
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	expectedSessionRevision: ExpectedRevisionSchema,
	expectedDomainRevision: revision,
	sessionHandle: ControlPlaneSessionHandleSchema,
} as const;

export const CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_SCHEMAS: Readonly<
	Record<ControlPlaneV2PlanContextMemoryCommandType, TSchema>
> = {
	"plan:enter": exact({
		...commandBase,
		type: Type.Literal("plan:enter"),
		payload: exact({
			sessionId: runtimeId("session"),
			requestedBy: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
			description: Type.Optional(ControlPlanePromptSchema),
		}),
	}),
	"plan:resolve": exact({
		...commandBase,
		type: Type.Literal("plan:resolve"),
		payload: exact({
			sessionId: runtimeId("session"),
			approvalId: runtimeId("approval"),
			planId: runtimeId("plan"),
			action: Type.Union([
				Type.Literal("approve_same_session"),
				Type.Literal("approve_fresh_context"),
				Type.Literal("request_changes"),
				Type.Literal("reject"),
				Type.Literal("cancel"),
			]),
			expectedModeRevision: revision,
			expectedPlanRevision: revision,
			contentDigest: digest,
			resolutionReceipt: ApprovalReceiptRefSchema,
			feedback: Type.Optional(ControlPlanePromptSchema),
		}),
	}),
	"context:compact": exact({
		...commandBase,
		type: Type.Literal("context:compact"),
		payload: exact({
			sessionId: runtimeId("session"),
			reason: Type.Union([
				Type.Literal("manual"),
				Type.Literal("auto"),
				Type.Literal("overflow"),
				Type.Literal("model_switch"),
			]),
			focus: Type.Optional(ControlPlanePromptSchema),
		}),
	}),
	"memory:propose": exact({
		...commandBase,
		type: Type.Literal("memory:propose"),
		payload: exact({
			sessionId: runtimeId("session"),
			operation: Type.Union([
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("revoke"),
				Type.Literal("scope_change"),
			]),
			expectedMemoryRevision: Type.Union([revision, Type.Null()]),
			expectedContentDigest: Type.Union([digest, Type.Null()]),
			draftArtifact: ArtifactRefSchema,
			diffArtifact: ArtifactRefSchema,
			proposalDigest: digest,
		}),
	}),
	"memory:resolve": exact({
		...commandBase,
		type: Type.Literal("memory:resolve"),
		payload: exact({
			sessionId: runtimeId("session"),
			proposalId: runtimeId("memoryProposal"),
			action: Type.Union([
				Type.Literal("approve"),
				Type.Literal("edit"),
				Type.Literal("reject"),
				Type.Literal("revoke"),
				Type.Literal("expire"),
			]),
			expectedProposalRevision: revision,
			resolutionReceipt: ApprovalReceiptRefSchema,
			replacementDiffArtifact: Type.Optional(ArtifactRefSchema),
		}),
	}),
};

const queryBase = {
	kind: Type.Literal("query"),
	queryId: Type.String({ minLength: 1, maxLength: 128 }),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
} as const;
const queryScope = {
	sessionId: runtimeId("session"),
	sessionHandle: ControlPlaneSessionHandleSchema,
} as const;

export const CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_SCHEMAS: Readonly<
	Record<ControlPlaneV2PlanContextMemoryQueryType, TSchema>
> = {
	"plan:inspect": exact({
		...queryBase,
		type: Type.Literal("plan:inspect"),
		payload: exact(queryScope),
	}),
	"context:inspect": exact({
		...queryBase,
		type: Type.Literal("context:inspect"),
		payload: exact(queryScope),
	}),
	"memory:list": exact({
		...queryBase,
		type: Type.Literal("memory:list"),
		payload: exact({
			...queryScope,
			statuses: Type.Array(memoryStatus, { maxItems: 5, uniqueItems: true }),
			cursor: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
			limit: Type.Integer({ minimum: 1, maximum: 100 }),
		}),
	}),
	"memory:inspect": exact({
		...queryBase,
		type: Type.Literal("memory:inspect"),
		payload: exact({
			...queryScope,
			memoryId: runtimeId("memory"),
		}),
	}),
};

const mutationEffectBase = {
	sessionId: runtimeId("session"),
	domainRevision: revision,
	durableCursor: EventCursorSchema,
	receiptDigest: digest,
} as const;

export const PlanContextMemoryMutationEffectV2Schema = Type.Unsafe<PlanContextMemoryMutationEffectV2>(
	Type.Union([
		exact({
			type: Type.Literal("plan:enter"),
			...mutationEffectBase,
			stateKind: Type.Union([
				Type.Literal("inactive"),
				Type.Literal("pending_activation"),
				Type.Literal("active"),
				Type.Literal("awaiting_approval"),
				Type.Literal("exit_pending"),
			]),
			modeRevision: revision,
		}),
		exact({
			type: Type.Literal("plan:resolve"),
			...mutationEffectBase,
			stateKind: Type.Union([
				Type.Literal("inactive"),
				Type.Literal("pending_activation"),
				Type.Literal("active"),
				Type.Literal("awaiting_approval"),
				Type.Literal("exit_pending"),
			]),
			modeRevision: revision,
		}),
		exact({
			type: Type.Literal("context:compact"),
			...mutationEffectBase,
			attemptStatus: Type.Union([
				Type.Literal("started"),
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("suppressed"),
			]),
			checkpointId: Type.Union([runtimeId("checkpoint"), Type.Null()]),
		}),
		exact({
			type: Type.Literal("memory:propose"),
			...mutationEffectBase,
			proposalId: runtimeId("memoryProposal"),
			proposalStatus: Type.Union([
				Type.Literal("pending"),
				Type.Literal("approved"),
				Type.Literal("rejected"),
				Type.Literal("expired"),
				Type.Literal("revoked"),
			]),
		}),
		exact({
			type: Type.Literal("memory:resolve"),
			...mutationEffectBase,
			proposalId: runtimeId("memoryProposal"),
			proposalStatus: Type.Union([
				Type.Literal("pending"),
				Type.Literal("approved"),
				Type.Literal("rejected"),
				Type.Literal("expired"),
				Type.Literal("revoked"),
			]),
		}),
	]),
);

function invalid(schema: TSchema, value: unknown): ControlPlaneResult<never> {
	const first = [...Errors(schema, value)][0];
	return controlPlaneFailure(
		"invalid_request",
		first?.message ?? "request does not match Plan/Context/Memory Control Plane schema v2",
	);
}

function artifactMatchesScope(
	artifact: ArtifactRef,
	command: ControlPlaneV2PlanContextMemoryCommand,
): boolean {
	return artifact.authorityId === command.authorityId && artifact.tenantId === command.tenantId;
}

export function validateControlPlaneV2PlanContextMemoryCommand(
	value: unknown,
): ControlPlaneResult<ControlPlaneV2PlanContextMemoryCommand> {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return controlPlaneFailure("unknown_command", "unknown Plan/Context/Memory command");
	}
	const type = (value as { type?: unknown }).type;
	if (
		typeof type !== "string" ||
		!(CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_TYPES as readonly string[]).includes(type)
	) return controlPlaneFailure("unknown_command", "unknown Plan/Context/Memory command");
	const schema = CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_SCHEMAS[
		type as ControlPlaneV2PlanContextMemoryCommandType
	];
	if (!Check(schema, value)) return invalid(schema, value);
	const command = value as ControlPlaneV2PlanContextMemoryCommand;
	if (command.payload.sessionId !== command.sessionHandle.sessionId) {
		return controlPlaneFailure("invalid_request", "specialty command handle does not match session");
	}
	if (command.type === "plan:resolve") {
		const receipt = command.payload.resolutionReceipt;
		if (
			receipt.authorityId !== command.authorityId ||
			receipt.tenantId !== command.tenantId ||
			receipt.approvalId !== command.payload.approvalId
		) return controlPlaneFailure("invalid_request", "plan resolution receipt correlation is invalid");
	}
	if (command.type === "memory:propose") {
		const isCreate = command.payload.operation === "create";
		if (
			isCreate !== (
				command.payload.expectedMemoryRevision === null &&
				command.payload.expectedContentDigest === null
			) ||
			!artifactMatchesScope(command.payload.draftArtifact, command) ||
			!artifactMatchesScope(command.payload.diffArtifact, command)
		) return controlPlaneFailure("invalid_request", "memory proposal revision or artifact scope is invalid");
	}
	if (command.type === "memory:resolve") {
		const receipt = command.payload.resolutionReceipt;
		if (
			receipt.authorityId !== command.authorityId ||
			receipt.tenantId !== command.tenantId ||
			(command.payload.replacementDiffArtifact !== undefined &&
				!artifactMatchesScope(command.payload.replacementDiffArtifact, command)) ||
			(command.payload.action === "edit") !== (command.payload.replacementDiffArtifact !== undefined)
		) return controlPlaneFailure("invalid_request", "memory resolution receipt or edit correlation is invalid");
	}
	return { ok: true, value: command };
}

export function validateControlPlaneV2PlanContextMemoryQuery(
	value: unknown,
): ControlPlaneResult<ControlPlaneV2PlanContextMemoryQuery> {
	if (!value || typeof value !== "object" || !("type" in value)) {
		return controlPlaneFailure("invalid_request", "unknown Plan/Context/Memory query");
	}
	const type = (value as { type?: unknown }).type;
	if (
		typeof type !== "string" ||
		!(CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_TYPES as readonly string[]).includes(type)
	) return controlPlaneFailure("invalid_request", "unknown Plan/Context/Memory query");
	const schema = CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_SCHEMAS[
		type as ControlPlaneV2PlanContextMemoryQueryType
	];
	if (!Check(schema, value)) return invalid(schema, value);
	const query = value as ControlPlaneV2PlanContextMemoryQuery;
	if (query.payload.sessionId !== query.payload.sessionHandle.sessionId) {
		return controlPlaneFailure("invalid_request", "specialty query handle does not match session");
	}
	return { ok: true, value: query };
}

export function isControlPlaneV2PlanContextMemoryCommandType(
	value: unknown,
): value is ControlPlaneV2PlanContextMemoryCommandType {
	return typeof value === "string" &&
		(CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_COMMAND_TYPES as readonly string[]).includes(value);
}

export function isControlPlaneV2PlanContextMemoryQueryType(
	value: unknown,
): value is ControlPlaneV2PlanContextMemoryQueryType {
	return typeof value === "string" &&
		(CONTROL_PLANE_V2_PLAN_CONTEXT_MEMORY_QUERY_TYPES as readonly string[]).includes(value);
}
