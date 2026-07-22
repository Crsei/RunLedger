/** Headless Runtime Control Plane 的 exact command/query/subscription 合同。 */

import { Type, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import {
	ApprovalReceiptRefSchema,
	type ApprovalReceiptRef,
	ArtifactRefSchema,
	type ArtifactRef,
} from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createSessionEventStreamRef,
	sameRuntimeEventStream,
	type EventCursor,
	type ExpectedRevision,
	type RuntimeEventV3,
} from "../protocol/v3/events.ts";
import { EventCursorSchema, ExpectedRevisionSchema } from "../protocol/v3/event-references.ts";
import {
	RuntimeActivityProjectionSchema,
	type RuntimeActivityProjection,
} from "../activity/types.ts";
import type {
	ApprovalId,
	ArtifactId,
	AuthorityId,
	ChangeProposalId,
	CommandId,
	EventId,
	PrincipalId,
	QueueItemId,
	ReceiptId,
	SessionId,
	TenantId,
	TurnId,
} from "../protocol/v3/ids.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	isControlPlaneCommandType,
	type ControlPlaneCommandType,
	type IdempotencyKey,
} from "../protocol/v3/coordination.ts";
import type { UserAgentMessage } from "../types.ts";
import {
	ChangeProposalRefSchema,
	DraftPrProviderReceiptSchema,
	HumanGateDecisionSchema,
	HumanGateRequestSchema,
	isChangeProposalRef,
	isHumanGateRequest,
} from "../verification/change-proposal.ts";
import type {
	ChangeProposalRef,
	DraftPrProviderReceipt,
	HumanGateDecision,
	HumanGateRequest,
} from "../verification/types.ts";
import type { ControlPlaneErrorShape, ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";

export const CONTROL_PLANE_PROTOCOL_MAJOR = 1 as const;
export const CONTROL_PLANE_PROTOCOL_MINOR = 0 as const;
export const CONTROL_PLANE_SCHEMA_VERSION = 1 as const;
export const CONTROL_PLANE_RUNTIME_SCHEMA_VERSIONS = [3] as const;
export const MAX_CONTROL_PLANE_PROMPT_CHARS = 32 * 1024;
export const MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES = 4 * 1024 * 1024;

export const CONTROL_PLANE_FEATURES = [
	"session",
	"turn",
	"queue",
	"approval",
	"change_proposal",
	"human_gate",
	"artifact",
	"event_subscription",
	"activity",
	"health",
	"shutdown",
	"consumer_checkpoint",
] as const;

export type ControlPlaneFeature = (typeof CONTROL_PLANE_FEATURES)[number];
export type ControlPlaneTransport = "jsonl" | "sse" | "local_socket" | "named_pipe";

export interface ControlPlaneProtocolRange {
	major: number;
	minMinor: number;
	maxMinor: number;
}

export interface ControlPlaneClientHello {
	kind: "handshake";
	requestId: string;
	clientName: string;
	clientVersion: string;
	protocol: ControlPlaneProtocolRange;
	controlPlaneSchemaVersions: readonly number[];
	runtimeSchemaVersions: readonly number[];
	requestedFeatures: readonly ControlPlaneFeature[];
	requiredFeatures: readonly ControlPlaneFeature[];
	transport: ControlPlaneTransport;
}

export interface ControlPlaneServerHello {
	kind: "handshake_result";
	requestId: string;
	protocol: { major: number; minor: number };
	controlPlaneSchemaVersion: number;
	runtimeSchemaVersion: number;
	features: readonly ControlPlaneFeature[];
	serverInstanceId: string;
	remoteAccess: "disabled";
	deliveryGuarantee: "at_least_once";
}

export interface ControlPlaneScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
}

/** generation 与随机 handleId 一起阻止 replacement 后的旧客户端继续写入。 */
export interface ControlPlaneSessionHandle {
	handleId: string;
	sessionId: SessionId;
	generation: number;
}

export type ControlPlanePrompt =
	| { storage: "bounded_text"; text: string; contentDigest: string }
	| { storage: "artifact"; artifact: ArtifactRef; contentDigest: string };

export { CONTROL_PLANE_COMMAND_TYPES };
export type { ControlPlaneCommandType };

interface ControlPlaneCommandBase<TType extends ControlPlaneCommandType, TPayload> extends ControlPlaneScope {
	kind: "command";
	type: TType;
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
	expectedSessionRevision: ExpectedRevision | null;
	expectedTurnId: TurnId | null;
	sessionHandle: ControlPlaneSessionHandle | null;
	payload: TPayload;
}

export type SessionStartCommand = ControlPlaneCommandBase<
	"session:start",
	{ cwdDigest: string; configurationDigest: string }
>;
export type SessionResumeCommand = ControlPlaneCommandBase<"session:resume", { sessionId: SessionId }>;
export type SessionForkCommand = ControlPlaneCommandBase<
	"session:fork",
	{
		parentSessionId: SessionId;
		parentCursor: EventCursor;
		goalMode: "continue_existing_goal" | "create_child_goal";
	}
>;
export type SessionStopCommand = ControlPlaneCommandBase<"session:stop", { sessionId: SessionId; reasonDigest: string }>;
export type TurnStartCommand = ControlPlaneCommandBase<"turn:start", { sessionId: SessionId; prompt: ControlPlanePrompt }>;
export type TurnSteerCommand = ControlPlaneCommandBase<"turn:steer", { sessionId: SessionId; prompt: ControlPlanePrompt }>;
export type TurnFollowUpCommand = ControlPlaneCommandBase<
	"turn:followUp",
	{ sessionId: SessionId; prompt: ControlPlanePrompt }
>;
export type TurnInterruptCommand = ControlPlaneCommandBase<
	"turn:interrupt",
	{ sessionId: SessionId; reasonDigest: string }
>;
export type QueueCancelCommand = ControlPlaneCommandBase<
	"queue:cancel",
	{
		sessionId: SessionId;
		expectedQueueRevision: string;
		items: readonly QueueCancellationTarget[];
		reason: string;
	}
>;
export type ApprovalResolveCommand = ControlPlaneCommandBase<
	"approval:resolve",
	{
		sessionId: SessionId;
		approvalId: ApprovalId;
		requestId: CommandId;
			ticketDigest: string;
			expectedDecisionRevision: number;
			/** 外部 ApprovalCoordinator 已签发的精确终态 receipt；裸 decision 不可恢复执行。 */
			resolutionReceipt: ApprovalReceiptRef;
	}
>;
export type ChangeProposalRequestDraftPrCommand = ControlPlaneCommandBase<
	"changeProposal:requestDraftPr",
	{
		sessionId: SessionId;
		providerId: string;
		authorizationReceiptId: ReceiptId;
		authorizationReceiptDigest: string;
		proposal: ChangeProposalRef;
	}
>;
export type HumanGateResolveCommand = ControlPlaneCommandBase<
	"humanGate:resolve",
	{ sessionId: SessionId; request: HumanGateRequest }
>;
export type ShutdownCommand = ControlPlaneCommandBase<
	"shutdown",
	{ reasonDigest: string; drainTimeoutMs: number }
>;

export type ControlPlaneCommand =
	| SessionStartCommand
	| SessionResumeCommand
	| SessionForkCommand
	| SessionStopCommand
	| TurnStartCommand
	| TurnSteerCommand
	| TurnFollowUpCommand
	| TurnInterruptCommand
	| QueueCancelCommand
	| ApprovalResolveCommand
	| ChangeProposalRequestDraftPrCommand
	| HumanGateResolveCommand
	| ShutdownCommand;

export const CONTROL_PLANE_QUERY_TYPES = [
	"session:inspect",
	"queue:list",
	"changeProposal:inspect",
	"artifact:read",
	"artifact:metadata",
	"activity:get",
	"health",
] as const;
export type ControlPlaneQueryType = (typeof CONTROL_PLANE_QUERY_TYPES)[number];

interface ControlPlaneQueryBase<TType extends ControlPlaneQueryType, TPayload> extends ControlPlaneScope {
	kind: "query";
	type: TType;
	queryId: string;
	payload: TPayload;
}

export type SessionInspectQuery = ControlPlaneQueryBase<
	"session:inspect",
	{ sessionId: SessionId; sessionHandle: ControlPlaneSessionHandle | null }
>;
export type QueueListQuery = ControlPlaneQueryBase<
	"queue:list",
	{ sessionId: SessionId; sessionHandle: ControlPlaneSessionHandle }
>;
export type ChangeProposalInspectQuery = ControlPlaneQueryBase<
	"changeProposal:inspect",
	{
		sessionId: SessionId;
		sessionHandle: ControlPlaneSessionHandle;
		proposalId: ChangeProposalId;
	}
>;
export type ArtifactReadQuery = ControlPlaneQueryBase<
	"artifact:read",
	{
		sessionId: SessionId;
		sessionHandle: ControlPlaneSessionHandle;
		artifactId: ArtifactId;
		expectedDigest: string;
		maxBytes: number;
	}
>;
export type ArtifactMetadataQuery = ControlPlaneQueryBase<
	"artifact:metadata",
	{ sessionId: SessionId; sessionHandle: ControlPlaneSessionHandle; artifactId: ArtifactId }
>;
export type ActivityGetQuery = ControlPlaneQueryBase<
	"activity:get",
	{ sessionId: SessionId | null; sessionHandle: ControlPlaneSessionHandle | null }
>;
export type HealthQuery = ControlPlaneQueryBase<"health", Record<never, never>>;

export type ControlPlaneQuery =
	| SessionInspectQuery
	| QueueListQuery
	| ChangeProposalInspectQuery
	| ArtifactReadQuery
	| ArtifactMetadataQuery
	| ActivityGetQuery
	| HealthQuery;

export interface EventSubscriptionRequest extends ControlPlaneScope {
	kind: "subscription";
	type: "events:subscribe";
	subscriptionId: string;
	sessionId: SessionId;
	sessionHandle: ControlPlaneSessionHandle;
	fromCursor: EventCursor | null;
	bufferCapacity: number;
}

export type ControlPlaneRequest = ControlPlaneClientHello | ControlPlaneCommand | ControlPlaneQuery | EventSubscriptionRequest;

export interface SessionBootstrap {
	sessionId: SessionId;
	handle: ControlPlaneSessionHandle;
	head: EventCursor | null;
	recovery: "new" | "resumed" | "forked";
}

export type ControlPlaneCommandEffect =
	| { type: "session:start" | "session:resume" | "session:fork"; bootstrap: SessionBootstrap }
	| { type: "session:stop"; sessionId: SessionId; terminalCursor: EventCursor }
	| {
			type: "turn:start" | "turn:steer" | "turn:followUp";
			sessionId: SessionId;
			queueItemId: QueueItemId;
			durableCursor: EventCursor;
			preflightDigest: string;
	  }
	| { type: "turn:interrupt"; sessionId: SessionId; status: "accepted" | "already_terminal"; durableCursor: EventCursor }
	| {
			type: "queue:cancel";
			sessionId: SessionId;
			previousQueueRevision: string;
			queueRevision: string;
			receipts: readonly QueueCancellationReceipt[];
	  }
	| {
			type: "approval:resolve";
			approvalId: ApprovalId;
			requestId: CommandId;
			ticketDigest: string;
			decisionRevision: number;
			receiptDigest: string;
	  }
	| { type: "changeProposal:requestDraftPr"; receipt: DraftPrProviderReceipt }
	| { type: "humanGate:resolve"; decision: HumanGateDecision }
	| { type: "shutdown"; acceptedAt: string; drainDeadline: string };

export interface ControlPlaneCommandResponse {
	kind: "command_result";
	commandId: CommandId;
	type: ControlPlaneCommandType;
	status: "executed" | "duplicate";
	result: ControlPlaneCommandEffect;
}

export type SessionInspection = {
	type: "session:inspect";
	sessionId: SessionId;
	lifecycle: "active" | "paused" | "stopped" | "closed" | "corrupted";
	revision: EventCursor | null;
	activeTurnId: TurnId | null;
	projectionDigest: string;
	replacementFailure?: {
		phase: "teardown_failed" | "create_failed";
		attemptedRecovery: "new" | "resumed" | "forked";
		errorCode: string;
		errorDigest: string;
		recordedAt: string;
	};
};

export interface QueueListItem {
	queueItemId: QueueItemId;
	sourceCommandId: CommandId;
	kind: "steer" | "follow_up";
	enqueueRevision: ExpectedRevision;
	targetTurnRevision: { turnId: TurnId; sessionRevision: ExpectedRevision } | null;
	nextTurnPolicy: "next_model_turn" | "after_active_run";
	contentDigest: string;
	content:
		| { storage: "bounded_text"; messageJson: string }
		| { storage: "artifact"; artifact: ArtifactRef };
	status: "pending" | "claimed";
	enqueuedSequence: number;
	message: UserAgentMessage | null;
}

export interface QueueListValue {
	type: "queue:list";
	sessionId: SessionId;
	queueRevision: string;
	items: readonly QueueListItem[];
}

export interface QueueCancellationReceipt {
	queueItemId: QueueItemId;
	sourceCommandId: CommandId;
	kind: "steer" | "follow_up";
	contentDigest: string;
	durableCursor: EventCursor;
}

export interface QueueCancellationTarget {
	queueItemId: QueueItemId;
	kind: "steer" | "follow_up";
}

export interface ChangeProposalInspection {
	type: "changeProposal:inspect";
	proposal: ChangeProposalRef;
}

export type ArtifactMetadataSummary = {
	type: "artifact:metadata";
	artifactId: ArtifactId;
	storedDigest: string;
	mediaType: string;
	storedSize: number;
	redaction: "metadata_only" | "redacted" | "encrypted_forensic";
};

export type ArtifactReadValue = {
	type: "artifact:read";
	artifactId: ArtifactId;
	storedDigest: string;
	mediaType: string;
	encoding: "base64";
	content: string;
	byteLength: number;
};

export type ActivityValue = {
	type: "activity:get";
	state: "idle" | "running" | "waiting_approval" | "draining";
	sessionId: SessionId | null;
	activeTurnId: TurnId | null;
	updatedAt: string;
	/** null 仅表示 daemon 当前没有可唯一关联的 active session。 */
	snapshot: RuntimeActivityProjection | null;
};

export type HealthValue = {
	type: "health";
	status: "ok" | "degraded" | "draining";
	protocolMajor: number;
	protocolMinor: number;
	uptimeMs: number;
	shuttingDown: boolean;
};

export type ControlPlaneQueryValue =
	| SessionInspection
	| QueueListValue
	| ChangeProposalInspection
	| ArtifactMetadataSummary
	| ArtifactReadValue
	| ActivityValue
	| HealthValue;

export interface ControlPlaneQueryResponse {
	kind: "query_result";
	queryId: string;
	type: ControlPlaneQueryType;
	result: ControlPlaneQueryValue;
}

export interface ControlPlaneSubscriptionResponse {
	kind: "subscription_result";
	subscriptionId: string;
	type: "events:subscribe";
	status: "accepted";
	deliveryGuarantee: "at_least_once";
	fromCursor: EventCursor | null;
}

export interface ControlPlaneErrorResponse {
	kind: "error";
	requestId: string | null;
	error: ControlPlaneErrorShape;
}

export type ControlPlaneResponse =
	| ControlPlaneServerHello
	| ControlPlaneCommandResponse
	| ControlPlaneQueryResponse
	| ControlPlaneSubscriptionResponse
	| ControlPlaneErrorResponse;

export interface LocalPeerIdentity {
	kind: "local";
	transport: ControlPlaneTransport;
	pid: number;
	uid: number | null;
	principalId: PrincipalId;
	authenticatedVia: "stdio_parent" | "socket_peer_credentials" | "named_pipe_acl" | "loopback_process";
}

export interface ControlPlaneRequestContext {
	peer: LocalPeerIdentity;
	handshake: ControlPlaneServerHello;
}

export interface MutationStateGuardPort {
	validate(command: ControlPlaneCommand, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<void>>;
}

export interface MutationExecutorPort {
	execute(command: ControlPlaneCommand, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<ControlPlaneCommandEffect>>;
}

export interface PromptPreflightReceipt {
	commandId: CommandId;
	promptDigest: string;
	preflightDigest: string;
	accepted: true;
}

export interface PromptEnqueuePort {
	preflight(
		command: TurnStartCommand | TurnSteerCommand | TurnFollowUpCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<PromptPreflightReceipt>>;
	enqueueDurable(
		command: TurnStartCommand | TurnSteerCommand | TurnFollowUpCommand,
		preflight: PromptPreflightReceipt,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "turn:start" | "turn:steer" | "turn:followUp" }>>>;
}

export interface ApprovalResolutionRequest {
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	sessionId: SessionId;
	approvalId: ApprovalId;
	requestId: CommandId;
	ticketDigest: string;
	expectedDecisionRevision: number;
	decision: "allowed" | "denied" | "cancelled";
	resolutionReceipt: ApprovalReceiptRef;
}

export interface ApprovalResolutionCoordinatorPort {
	/** opaque coordinator 负责 policy/store/receipt；Control Plane 只转发已验证 correlation。 */
	resolve(
		request: ApprovalResolutionRequest,
		signal?: AbortSignal,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "approval:resolve" }>>>;
}

export interface QueueControlPlanePort {
	list(query: QueueListQuery, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<QueueListValue>>;
	cancel(
		command: QueueCancelCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "queue:cancel" }>>>;
}

export interface ChangeProposalControlPlanePort {
	inspect(
		query: ChangeProposalInspectQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ChangeProposalInspection>>;
	requestDraftPr(
		command: ChangeProposalRequestDraftPrCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "changeProposal:requestDraftPr" }>>>;
}

export interface HumanGateControlPlanePort {
	resolve(
		command: HumanGateResolveCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "humanGate:resolve" }>>>;
}

export interface QueryExecutorPort {
	execute(query: ControlPlaneQuery, context: ControlPlaneRequestContext): Promise<ControlPlaneResult<ControlPlaneQueryValue>>;
}

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const requestToken = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", maxLength: 128 });
const idempotencyKey = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$", maxLength: 128 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const ControlPlaneFeatureSchema = Type.Union(CONTROL_PLANE_FEATURES.map((feature) => Type.Literal(feature)));
export const ControlPlaneTransportSchema = Type.Union([
	Type.Literal("jsonl"),
	Type.Literal("sse"),
	Type.Literal("local_socket"),
	Type.Literal("named_pipe"),
]);

export const ControlPlaneClientHelloSchema = exact({
	kind: Type.Literal("handshake"),
	requestId: requestToken,
	clientName: Type.String({ minLength: 1, maxLength: 128 }),
	clientVersion: Type.String({ minLength: 1, maxLength: 64 }),
	protocol: exact({ major: revision, minMinor: revision, maxMinor: revision }),
	controlPlaneSchemaVersions: Type.Array(revision, { minItems: 1, maxItems: 16, uniqueItems: true }),
	runtimeSchemaVersions: Type.Array(revision, { minItems: 1, maxItems: 16, uniqueItems: true }),
	requestedFeatures: Type.Array(ControlPlaneFeatureSchema, { maxItems: CONTROL_PLANE_FEATURES.length, uniqueItems: true }),
	requiredFeatures: Type.Array(ControlPlaneFeatureSchema, { maxItems: CONTROL_PLANE_FEATURES.length, uniqueItems: true }),
	transport: ControlPlaneTransportSchema,
});

export const ControlPlaneSessionHandleSchema = exact({
	handleId: Type.String({ pattern: "^handle_[A-Za-z0-9-]{16,96}$", maxLength: 103 }),
	sessionId: runtimeId("session"),
	generation: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

export const ControlPlanePromptSchema = Type.Union([
	exact({
		storage: Type.Literal("bounded_text"),
		text: Type.String({ minLength: 1, maxLength: MAX_CONTROL_PLANE_PROMPT_CHARS }),
		contentDigest: digest,
	}),
	exact({
		storage: Type.Literal("artifact"),
		artifact: ArtifactRefSchema,
		contentDigest: digest,
	}),
]);

const commandBase = {
	kind: Type.Literal("command"),
	commandId: runtimeId("command"),
	idempotencyKey,
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	expectedSessionRevision: Type.Union([ExpectedRevisionSchema, Type.Null()]),
	expectedTurnId: Type.Union([runtimeId("turn"), Type.Null()]),
	sessionHandle: Type.Union([ControlPlaneSessionHandleSchema, Type.Null()]),
} as const;

export const CONTROL_PLANE_COMMAND_SCHEMAS: Readonly<Record<ControlPlaneCommandType, TSchema>> = {
	"session:start": exact({
		...commandBase,
		type: Type.Literal("session:start"),
		payload: exact({ cwdDigest: digest, configurationDigest: digest }),
	}),
	"session:resume": exact({
		...commandBase,
		type: Type.Literal("session:resume"),
		payload: exact({ sessionId: runtimeId("session") }),
	}),
	"session:fork": exact({
		...commandBase,
		type: Type.Literal("session:fork"),
		payload: exact({
			parentSessionId: runtimeId("session"),
			parentCursor: EventCursorSchema,
			goalMode: Type.Union([Type.Literal("continue_existing_goal"), Type.Literal("create_child_goal")]),
		}),
	}),
	"session:stop": exact({
		...commandBase,
		type: Type.Literal("session:stop"),
		payload: exact({ sessionId: runtimeId("session"), reasonDigest: digest }),
	}),
	"turn:start": exact({
		...commandBase,
		type: Type.Literal("turn:start"),
		payload: exact({ sessionId: runtimeId("session"), prompt: ControlPlanePromptSchema }),
	}),
	"turn:steer": exact({
		...commandBase,
		type: Type.Literal("turn:steer"),
		payload: exact({ sessionId: runtimeId("session"), prompt: ControlPlanePromptSchema }),
	}),
	"turn:followUp": exact({
		...commandBase,
		type: Type.Literal("turn:followUp"),
		payload: exact({ sessionId: runtimeId("session"), prompt: ControlPlanePromptSchema }),
	}),
	"turn:interrupt": exact({
		...commandBase,
		type: Type.Literal("turn:interrupt"),
		payload: exact({ sessionId: runtimeId("session"), reasonDigest: digest }),
	}),
	"queue:cancel": exact({
		...commandBase,
		type: Type.Literal("queue:cancel"),
		payload: exact({
			sessionId: runtimeId("session"),
			expectedQueueRevision: digest,
			items: Type.Array(exact({
				queueItemId: runtimeId("queueItem"),
				kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
			}), { minItems: 1, maxItems: 1024 }),
			reason: Type.String({ minLength: 1, maxLength: 512 }),
		}),
	}),
	"approval:resolve": exact({
		...commandBase,
		type: Type.Literal("approval:resolve"),
		payload: exact({
			sessionId: runtimeId("session"),
			approvalId: runtimeId("approval"),
			requestId: runtimeId("command"),
				ticketDigest: digest,
				expectedDecisionRevision: revision,
				resolutionReceipt: ApprovalReceiptRefSchema,
		}),
	}),
	"changeProposal:requestDraftPr": exact({
		...commandBase,
		type: Type.Literal("changeProposal:requestDraftPr"),
		payload: exact({
			sessionId: runtimeId("session"),
			providerId: Type.String({ minLength: 1, maxLength: 512 }),
			authorizationReceiptId: runtimeId("receipt"),
			authorizationReceiptDigest: digest,
			proposal: ChangeProposalRefSchema,
		}),
	}),
	"humanGate:resolve": exact({
		...commandBase,
		type: Type.Literal("humanGate:resolve"),
		payload: exact({ sessionId: runtimeId("session"), request: HumanGateRequestSchema }),
	}),
	shutdown: exact({
		...commandBase,
		type: Type.Literal("shutdown"),
		payload: exact({ reasonDigest: digest, drainTimeoutMs: Type.Integer({ minimum: 1, maximum: 300_000 }) }),
	}),
};

export const ControlPlaneCommandSchema = Type.Union(CONTROL_PLANE_COMMAND_TYPES.map((type) => CONTROL_PLANE_COMMAND_SCHEMAS[type]));

export const SessionBootstrapSchema = exact({
	sessionId: runtimeId("session"),
	handle: ControlPlaneSessionHandleSchema,
	head: Type.Union([EventCursorSchema, Type.Null()]),
	recovery: Type.Union([Type.Literal("new"), Type.Literal("resumed"), Type.Literal("forked")]),
});

export const ControlPlaneCommandEffectSchema = Type.Union([
	exact({ type: Type.Literal("session:start"), bootstrap: SessionBootstrapSchema }),
	exact({ type: Type.Literal("session:resume"), bootstrap: SessionBootstrapSchema }),
	exact({ type: Type.Literal("session:fork"), bootstrap: SessionBootstrapSchema }),
	exact({ type: Type.Literal("session:stop"), sessionId: runtimeId("session"), terminalCursor: EventCursorSchema }),
	exact({
		type: Type.Literal("turn:start"),
		sessionId: runtimeId("session"),
		queueItemId: runtimeId("queueItem"),
		durableCursor: EventCursorSchema,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:steer"),
		sessionId: runtimeId("session"),
		queueItemId: runtimeId("queueItem"),
		durableCursor: EventCursorSchema,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:followUp"),
		sessionId: runtimeId("session"),
		queueItemId: runtimeId("queueItem"),
		durableCursor: EventCursorSchema,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:interrupt"),
		sessionId: runtimeId("session"),
		status: Type.Literal("accepted"),
		durableCursor: EventCursorSchema,
	}),
	exact({
		type: Type.Literal("turn:interrupt"),
		sessionId: runtimeId("session"),
		status: Type.Literal("already_terminal"),
		durableCursor: EventCursorSchema,
	}),
	exact({
		type: Type.Literal("queue:cancel"),
		sessionId: runtimeId("session"),
		previousQueueRevision: digest,
		queueRevision: digest,
		receipts: Type.Array(exact({
			queueItemId: runtimeId("queueItem"),
			sourceCommandId: runtimeId("command"),
			kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
			contentDigest: digest,
			durableCursor: EventCursorSchema,
		}), { minItems: 1, maxItems: 1024 }),
	}),
	exact({
		type: Type.Literal("approval:resolve"),
		approvalId: runtimeId("approval"),
		requestId: runtimeId("command"),
		ticketDigest: digest,
		decisionRevision: revision,
		receiptDigest: digest,
	}),
	exact({ type: Type.Literal("changeProposal:requestDraftPr"), receipt: DraftPrProviderReceiptSchema }),
	exact({ type: Type.Literal("humanGate:resolve"), decision: HumanGateDecisionSchema }),
	exact({
		type: Type.Literal("shutdown"),
		acceptedAt: Type.String({ format: "date-time", maxLength: 32 }),
		drainDeadline: Type.String({ format: "date-time", maxLength: 32 }),
	}),
]);

export function isControlPlaneCommandEffect(value: unknown): value is ControlPlaneCommandEffect {
	return Check(ControlPlaneCommandEffectSchema, value);
}

const queryBase = {
	kind: Type.Literal("query"),
	queryId: requestToken,
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
} as const;

export const CONTROL_PLANE_QUERY_SCHEMAS: Readonly<Record<ControlPlaneQueryType, TSchema>> = {
	"session:inspect": exact({
		...queryBase,
		type: Type.Literal("session:inspect"),
		payload: exact({
			sessionId: runtimeId("session"),
			sessionHandle: Type.Union([ControlPlaneSessionHandleSchema, Type.Null()]),
		}),
	}),
	"queue:list": exact({
		...queryBase,
		type: Type.Literal("queue:list"),
		payload: exact({
			sessionId: runtimeId("session"),
			sessionHandle: ControlPlaneSessionHandleSchema,
		}),
	}),
	"changeProposal:inspect": exact({
		...queryBase,
		type: Type.Literal("changeProposal:inspect"),
		payload: exact({
			sessionId: runtimeId("session"),
			sessionHandle: ControlPlaneSessionHandleSchema,
			proposalId: runtimeId("changeProposal"),
		}),
	}),
	"artifact:read": exact({
		...queryBase,
		type: Type.Literal("artifact:read"),
		payload: exact({
			sessionId: runtimeId("session"),
			sessionHandle: ControlPlaneSessionHandleSchema,
			artifactId: runtimeId("artifact"),
			expectedDigest: digest,
			maxBytes: Type.Integer({ minimum: 1, maximum: MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES }),
		}),
	}),
	"artifact:metadata": exact({
		...queryBase,
		type: Type.Literal("artifact:metadata"),
		payload: exact({
			sessionId: runtimeId("session"),
			sessionHandle: ControlPlaneSessionHandleSchema,
			artifactId: runtimeId("artifact"),
		}),
	}),
	"activity:get": exact({
		...queryBase,
		type: Type.Literal("activity:get"),
		payload: exact({
			sessionId: Type.Union([runtimeId("session"), Type.Null()]),
			sessionHandle: Type.Union([ControlPlaneSessionHandleSchema, Type.Null()]),
		}),
	}),
	health: exact({ ...queryBase, type: Type.Literal("health"), payload: exact({}) }),
};

export const ControlPlaneQuerySchema = Type.Union(CONTROL_PLANE_QUERY_TYPES.map((type) => CONTROL_PLANE_QUERY_SCHEMAS[type]));

const UserAgentMessageSchema = exact({
	role: Type.Literal("user"),
	content: Type.Array(exact({
		type: Type.Literal("text"),
		text: Type.String({ maxLength: MAX_CONTROL_PLANE_PROMPT_CHARS }),
		textSignature: Type.Optional(Type.String({ maxLength: 4096 })),
	}), { minItems: 1, maxItems: 64 }),
});
const QueueListContentSchema = Type.Union([
	exact({
		storage: Type.Literal("bounded_text"),
		messageJson: Type.String({ minLength: 2, maxLength: 60 * 1024 }),
	}),
	exact({ storage: Type.Literal("artifact"), artifact: ArtifactRefSchema }),
]);
const QueueTargetTurnRevisionSchema = exact({
	turnId: runtimeId("turn"),
	sessionRevision: ExpectedRevisionSchema,
});

export const CONTROL_PLANE_QUERY_VALUE_SCHEMAS: Readonly<Record<ControlPlaneQueryType, TSchema>> = {
	"session:inspect": exact({
		type: Type.Literal("session:inspect"),
		sessionId: runtimeId("session"),
		lifecycle: Type.Union([
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("stopped"),
			Type.Literal("closed"),
			Type.Literal("corrupted"),
		]),
		revision: Type.Union([EventCursorSchema, Type.Null()]),
		activeTurnId: Type.Union([runtimeId("turn"), Type.Null()]),
		projectionDigest: digest,
		replacementFailure: Type.Optional(exact({
			phase: Type.Union([Type.Literal("teardown_failed"), Type.Literal("create_failed")]),
			attemptedRecovery: Type.Union([Type.Literal("new"), Type.Literal("resumed"), Type.Literal("forked")]),
			errorCode: Type.String({ minLength: 1, maxLength: 128 }),
			errorDigest: digest,
			recordedAt: Type.String({ format: "date-time", maxLength: 64 }),
		})),
	}),
	"queue:list": exact({
		type: Type.Literal("queue:list"),
		sessionId: runtimeId("session"),
		queueRevision: digest,
		items: Type.Array(exact({
			queueItemId: runtimeId("queueItem"),
			sourceCommandId: runtimeId("command"),
			kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
			enqueueRevision: ExpectedRevisionSchema,
			targetTurnRevision: Type.Union([QueueTargetTurnRevisionSchema, Type.Null()]),
			nextTurnPolicy: Type.Union([Type.Literal("next_model_turn"), Type.Literal("after_active_run")]),
			contentDigest: digest,
			content: QueueListContentSchema,
			status: Type.Union([Type.Literal("pending"), Type.Literal("claimed")]),
			enqueuedSequence: revision,
			message: Type.Union([UserAgentMessageSchema, Type.Null()]),
		}), { maxItems: 4096 }),
	}),
	"changeProposal:inspect": exact({
		type: Type.Literal("changeProposal:inspect"),
		proposal: ChangeProposalRefSchema,
	}),
	"artifact:metadata": exact({
		type: Type.Literal("artifact:metadata"),
		artifactId: runtimeId("artifact"),
		storedDigest: digest,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		storedSize: revision,
		redaction: Type.Union([
			Type.Literal("metadata_only"),
			Type.Literal("redacted"),
			Type.Literal("encrypted_forensic"),
		]),
	}),
	"artifact:read": exact({
		type: Type.Literal("artifact:read"),
		artifactId: runtimeId("artifact"),
		storedDigest: digest,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		encoding: Type.Literal("base64"),
		content: Type.String({ maxLength: Math.ceil(MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES * 4 / 3) + 8 }),
		byteLength: Type.Integer({ minimum: 0, maximum: MAX_CONTROL_PLANE_ARTIFACT_READ_BYTES }),
	}),
	"activity:get": exact({
		type: Type.Literal("activity:get"),
		state: Type.Union([
			Type.Literal("idle"),
			Type.Literal("running"),
			Type.Literal("waiting_approval"),
			Type.Literal("draining"),
		]),
		sessionId: Type.Union([runtimeId("session"), Type.Null()]),
		activeTurnId: Type.Union([runtimeId("turn"), Type.Null()]),
		updatedAt: Type.String({ minLength: 20, maxLength: 32 }),
		snapshot: Type.Union([RuntimeActivityProjectionSchema, Type.Null()]),
	}),
	health: exact({
		type: Type.Literal("health"),
		status: Type.Union([Type.Literal("ok"), Type.Literal("degraded"), Type.Literal("draining")]),
		protocolMajor: revision,
		protocolMinor: revision,
		uptimeMs: Type.Number({ minimum: 0 }),
		shuttingDown: Type.Boolean(),
	}),
};

export function isControlPlaneQueryValue<TType extends ControlPlaneQueryType>(
	type: TType,
	value: unknown,
): value is Extract<ControlPlaneQueryValue, { type: TType }> {
	return Check(CONTROL_PLANE_QUERY_VALUE_SCHEMAS[type], value);
}

export const EventSubscriptionRequestSchema = exact({
	kind: Type.Literal("subscription"),
	type: Type.Literal("events:subscribe"),
	subscriptionId: requestToken,
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
	sessionId: runtimeId("session"),
	sessionHandle: ControlPlaneSessionHandleSchema,
	fromCursor: Type.Union([EventCursorSchema, Type.Null()]),
	bufferCapacity: Type.Integer({ minimum: 1, maximum: 4096 }),
});

export const ControlPlaneRequestSchema = Type.Union([
	ControlPlaneClientHelloSchema,
	ControlPlaneCommandSchema,
	ControlPlaneQuerySchema,
	EventSubscriptionRequestSchema,
]);

export interface RequestValidationSuccess<T> {
	ok: true;
	value: T;
}

export type RequestValidationResult<T> = RequestValidationSuccess<T> | { ok: false; error: ControlPlaneErrorShape };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSchema(schema: TSchema, value: unknown): RequestValidationResult<never> {
	const first = Errors(schema, value)[0];
	return {
		ok: false,
		error: {
			code: "invalid_request",
			message: first?.message ?? "request does not match the exact Control Plane schema",
			retryable: false,
		},
	};
}

function promptDigestIsValid(prompt: ControlPlanePrompt): boolean {
	if (prompt.storage === "bounded_text") {
		return prompt.contentDigest === canonicalDigest({ storage: "bounded_text", text: prompt.text });
	}
	return prompt.contentDigest === canonicalDigest({ storage: "artifact", artifact: prompt.artifact });
}

function approvalResolutionReceiptIsValid(command: ApprovalResolveCommand): boolean {
	const receipt = command.payload.resolutionReceipt;
	const { receiptDigest, ...body } = receipt;
	return receiptDigest === canonicalDigest(body) &&
		receipt.authorityId === command.authorityId &&
		receipt.tenantId === command.tenantId &&
		receipt.principalId === command.principalId &&
		receipt.approvalId === command.payload.approvalId &&
		receipt.requestId === command.payload.requestId &&
		receipt.ticketDigest === command.payload.ticketDigest &&
		receipt.decisionRevision === command.payload.expectedDecisionRevision + 1 &&
		(receipt.decision === "allowed" || receipt.decision === "denied" || receipt.decision === "cancelled");
}

function commandSemanticsAreValid(command: ControlPlaneCommand): string | undefined {
	if (command.sessionHandle && "sessionId" in command.payload && command.sessionHandle.sessionId !== command.payload.sessionId) {
		return "session handle does not match command session";
	}
	if (command.expectedSessionRevision && "sessionId" in command.payload) {
		const expectedSessionId = command.type === "session:fork" ? command.payload.parentSessionId : command.payload.sessionId;
		const expectedStream = createSessionEventStreamRef(command, expectedSessionId);
		if (!sameRuntimeEventStream(command.expectedSessionRevision.stream, expectedStream)) return "expected revision does not match command session";
	}
	switch (command.type) {
		case "session:start":
			if (command.expectedSessionRevision || command.expectedTurnId || command.sessionHandle) return "session:start must not carry existing session state";
			return undefined;
		case "session:resume":
			if (command.expectedTurnId || command.sessionHandle) return "session:resume must replace the current handle";
			return undefined;
		case "session:fork":
			if (!command.expectedSessionRevision || command.expectedTurnId) return "session:fork requires the parent revision and a stable turn boundary";
			if (
				!sameRuntimeEventStream(command.payload.parentCursor.stream, command.expectedSessionRevision.stream) ||
				command.payload.parentCursor.sequence !== command.expectedSessionRevision.sequence ||
				command.payload.parentCursor.eventHash !== command.expectedSessionRevision.eventHash
			) return "fork cursor does not match the expected parent revision";
			return undefined;
		case "session:stop":
			if (!command.expectedSessionRevision || !command.sessionHandle) return "session:stop requires a current handle and revision";
			return undefined;
		case "turn:start":
			if (!command.expectedSessionRevision || command.expectedTurnId || !command.sessionHandle) return "turn:start requires a current session revision and no active turn";
			return promptDigestIsValid(command.payload.prompt) ? undefined : "prompt content digest is invalid";
		case "turn:steer":
		case "turn:followUp":
			if (!command.expectedSessionRevision || !command.expectedTurnId || !command.sessionHandle) return `${command.type} requires the current revision, turn, and handle`;
			return promptDigestIsValid(command.payload.prompt) ? undefined : "prompt content digest is invalid";
		case "turn:interrupt":
			if (!command.expectedSessionRevision || !command.expectedTurnId || !command.sessionHandle) return "turn:interrupt requires the current revision, turn, and handle";
			return undefined;
		case "queue:cancel":
			if (!command.expectedSessionRevision || !command.sessionHandle) return "queue:cancel requires a current session revision and handle";
			if (new Set(command.payload.items.map((item) => item.queueItemId)).size !== command.payload.items.length) {
				return "queue:cancel requires distinct queue item ids";
			}
			return undefined;
		case "approval:resolve":
			if (!command.expectedSessionRevision || !command.sessionHandle) return "approval:resolve requires a current revision and handle";
			return approvalResolutionReceiptIsValid(command)
				? undefined
				: "approval:resolve requires a canonical correlated resolution receipt";
		case "changeProposal:requestDraftPr":
			if (!command.expectedSessionRevision || !command.sessionHandle) {
				return "changeProposal:requestDraftPr requires a current revision and handle";
			}
			if (
				!isChangeProposalRef(command.payload.proposal) ||
				command.payload.proposal.authorityId !== command.authorityId ||
				command.payload.proposal.tenantId !== command.tenantId ||
				command.payload.proposal.sessionId !== command.payload.sessionId
			) return "Draft PR request proposal correlation is invalid";
			return undefined;
		case "humanGate:resolve":
			if (!command.expectedSessionRevision || !command.sessionHandle) return "humanGate:resolve requires a current revision and handle";
			if (
				!isHumanGateRequest(command.payload.request) ||
				command.payload.request.requestId !== command.commandId ||
				command.payload.request.requestedBy !== command.principalId ||
				command.payload.request.authorityId !== command.authorityId ||
				command.payload.request.tenantId !== command.tenantId ||
				command.payload.request.proposal.sessionId !== command.payload.sessionId
			) return "human gate request correlation is invalid";
			return undefined;
		case "shutdown":
			if (command.expectedSessionRevision || command.expectedTurnId || command.sessionHandle) return "shutdown is daemon-scoped";
			return undefined;
	}
}

export function validateControlPlaneCommand(value: unknown): RequestValidationResult<ControlPlaneCommand> {
	if (!isRecord(value) || value.kind !== "command") return invalidSchema(ControlPlaneCommandSchema, value);
	if (!isControlPlaneCommandType(value.type)) {
		return { ok: false, error: { code: "unknown_command", message: "unknown Control Plane command", retryable: false } };
	}
	const schema = CONTROL_PLANE_COMMAND_SCHEMAS[value.type as ControlPlaneCommandType];
	if (!Check(schema, value)) return invalidSchema(schema, value);
	const command = value as unknown as ControlPlaneCommand;
	const semanticError = commandSemanticsAreValid(command);
	if (semanticError) return { ok: false, error: { code: "invalid_request", message: semanticError, retryable: false } };
	return { ok: true, value: command };
}

export function validateControlPlaneQuery(value: unknown): RequestValidationResult<ControlPlaneQuery> {
	if (!isRecord(value) || value.kind !== "query") return invalidSchema(ControlPlaneQuerySchema, value);
	if (typeof value.type !== "string" || !CONTROL_PLANE_QUERY_TYPES.includes(value.type as ControlPlaneQueryType)) {
		return { ok: false, error: { code: "unknown_query", message: "unknown Control Plane query", retryable: false } };
	}
	const schema = CONTROL_PLANE_QUERY_SCHEMAS[value.type as ControlPlaneQueryType];
	if (!Check(schema, value)) return invalidSchema(schema, value);
	const query = value as unknown as ControlPlaneQuery;
	if ("sessionHandle" in query.payload) {
		const handle = query.payload.sessionHandle;
		const sessionId = query.payload.sessionId;
		if ((handle === null) !== (sessionId === null) && query.type === "activity:get") {
			return { ok: false, error: { code: "invalid_request", message: "activity session and handle must be supplied together", retryable: false } };
		}
		if (handle && sessionId && handle.sessionId !== sessionId) {
			return { ok: false, error: { code: "invalid_request", message: "session handle does not match query session", retryable: false } };
		}
		}
	if (query.type === "changeProposal:inspect" && !isRuntimeId(query.payload.proposalId, "changeProposal")) {
		return { ok: false, error: { code: "invalid_request", message: "change proposal id is invalid", retryable: false } };
	}
	return { ok: true, value: query };
}

export function validateEventSubscriptionRequest(value: unknown): RequestValidationResult<EventSubscriptionRequest> {
	if (!Check(EventSubscriptionRequestSchema, value)) return invalidSchema(EventSubscriptionRequestSchema, value);
	const request = value as unknown as EventSubscriptionRequest;
	if (request.sessionHandle.sessionId !== request.sessionId) {
		return { ok: false, error: { code: "invalid_request", message: "subscription handle does not match session", retryable: false } };
	}
	if (request.fromCursor && !sameRuntimeEventStream(
		request.fromCursor.stream,
		createSessionEventStreamRef(request, request.sessionId),
	)) {
		return { ok: false, error: { code: "cursor_mismatch", message: "subscription cursor belongs to another session", retryable: false } };
	}
	return { ok: true, value: request };
}

export function validateControlPlaneHello(value: unknown): RequestValidationResult<ControlPlaneClientHello> {
	if (!Check(ControlPlaneClientHelloSchema, value)) return invalidSchema(ControlPlaneClientHelloSchema, value);
	const hello = value as unknown as ControlPlaneClientHello;
	if (hello.protocol.minMinor > hello.protocol.maxMinor) {
		return { ok: false, error: { code: "invalid_request", message: "protocol minor range is inverted", retryable: false } };
	}
	if (hello.requiredFeatures.some((feature) => !hello.requestedFeatures.includes(feature))) {
		return { ok: false, error: { code: "invalid_request", message: "required features must also be requested", retryable: false } };
	}
	return { ok: true, value: hello };
}

export function validateControlPlaneRequest(value: unknown): RequestValidationResult<ControlPlaneRequest> {
	if (!isRecord(value)) return invalidSchema(ControlPlaneRequestSchema, value);
	switch (value.kind) {
		case "handshake":
			return validateControlPlaneHello(value);
		case "command":
			return validateControlPlaneCommand(value);
		case "query":
			return validateControlPlaneQuery(value);
		case "subscription":
			return validateEventSubscriptionRequest(value);
		default:
			return { ok: false, error: { code: "invalid_request", message: "unknown Control Plane request kind", retryable: false } };
	}
}

export function requestIdOf(value: unknown): string | null {
	if (!isRecord(value)) return null;
	for (const key of ["requestId", "commandId", "queryId", "subscriptionId"] as const) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.length <= 128) return candidate;
	}
	return null;
}

export function errorResponse(requestId: string | null, error: ControlPlaneErrorShape): ControlPlaneErrorResponse {
	return { kind: "error", requestId, error };
}

export function adapterException(operation: string, error: unknown): ControlPlaneResult<never> {
	return controlPlaneFailure(
		"adapter_unavailable",
		`${operation} adapter failed`,
		true,
		{ errorName: error instanceof Error ? error.name : "UnknownError" },
		"uncertain",
	);
}

export function controlPlaneCommandDigest(command: ControlPlaneCommand): string {
	return canonicalDigest(command);
}

export type StableEventDelivery = {
	subscriptionId: string;
	delivery: "replay" | "live";
	eventId: EventId;
	sequence: number;
	cursor: EventCursor;
	event: RuntimeEventV3;
};
