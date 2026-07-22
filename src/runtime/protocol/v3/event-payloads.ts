/** 每一种 Runtime v3 event type 的独立、封闭且有界 payload schema。 */

import { Type, type Static, type TSchema } from "typebox";
import { ArtifactRefSchema, GatewayRateLimitReceiptSchema } from "./capability.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	IdempotencyKeySchema,
	type ControlPlaneCommandType,
} from "./coordination.ts";
import type { RuntimeEventType } from "./event-catalog.ts";
import { EventCursorSchema, ExpectedRevisionSchema } from "./event-references.ts";
import type { RuntimeId, RuntimeIdKind } from "./ids.ts";
import {
	PermissionDecidedPayloadSchema,
	PermissionExpiredPayloadSchema,
	PermissionRequestedPayloadSchema,
	PermissionRevokedPayloadSchema,
	SandboxExecutionRecordedPayloadSchema,
	SandboxResolvedPayloadSchema,
	ToolAuthorizedPayloadSchema,
} from "./security-events.ts";
import {
	LeaseAcquiredPayloadSchema,
	LeaseReleasedPayloadSchema,
	LeaseTakenOverPayloadSchema,
	WorkspaceBoundPayloadSchema,
	WorkspaceReleasedPayloadSchema,
	WorkspaceValidationRecordedPayloadSchema,
} from "./workspace-events.ts";
import {
	DeclassificationReceiptRefSchema,
	InputSourceRefSchema,
	type DeclassificationReceiptRef,
	type InputSourceRef,
} from "./taint.ts";

const idPattern = "^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9][A-Za-z0-9._~-]*$";
const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";

const id = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const brandedId = <TKind extends RuntimeIdKind>(kind: TKind) => Type.Unsafe<RuntimeId<TKind>>(id(kind));
const anyId = Type.String({ pattern: idPattern, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 128 });
const shortText = Type.String({ minLength: 1, maxLength: 512 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveInteger = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const nonNegativeNumber = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const readonlyArray = <TItem extends TSchema>(
	items: TItem,
	options: { minItems?: number; maxItems?: number; uniqueItems?: boolean } = {},
) => Type.Unsafe<readonly Static<TItem>[]>(Type.Array(items, options));
const expectedRevision = ExpectedRevisionSchema;
const errorRef = exact({ code: token, messageDigest: digest, retryable: Type.Boolean() });
const integrityStatus = Type.Union([Type.Literal("valid"), Type.Literal("partial"), Type.Literal("corrupted")]);
const attestationStatus = Type.Union([
	Type.Literal("attested"),
	Type.Literal("unattested"),
	Type.Literal("unavailable"),
]);
const eventCursor = EventCursorSchema;
const artifactKind = Type.Union([
	Type.Literal("diff"),
	Type.Literal("tool_output"),
	Type.Literal("log"),
	Type.Literal("test_report"),
	Type.Literal("screenshot"),
	Type.Literal("dom_snapshot"),
	Type.Literal("console_log"),
	Type.Literal("network_trace"),
	Type.Literal("episode_manifest"),
	Type.Literal("change_proposal"),
	Type.Literal("session_report"),
]);
const artifactRef = exact({
	authorityId: id("authority"),
	tenantId: id("tenant"),
	artifactId: id("artifact"),
	storedDigest: digest,
	kind: artifactKind,
	originalSize: revision,
	storedSize: revision,
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	redaction: Type.Union([
		Type.Literal("metadata_only"),
		Type.Literal("redacted"),
		Type.Literal("encrypted_forensic"),
	]),
	transformReceipt: id("receipt"),
	workspaceId: Type.Optional(id("workspace")),
});
const mutationEffect = Type.Union([
	Type.Literal("none"),
	Type.Literal("committed"),
	Type.Literal("uncertain"),
]);
const taskIdentifier = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$", maxLength: 128 });
const taskStatus = Type.Union([
	Type.Literal("pending"),
	Type.Literal("ready"),
	Type.Literal("running"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
]);
const taskOwner = Type.Union([
	exact({ kind: Type.Literal("agent"), id: id("agent") }),
	exact({ kind: Type.Literal("principal"), id: id("principal") }),
]);
const taskWorkspaceRef = exact({
	workspaceId: id("workspace"),
	bindingRevision: revision,
	bindingDigest: digest,
});
const taskCapabilityRef = exact({
	receiptId: id("receipt"),
	capability: token,
	decisionRevision: revision,
	receiptDigest: digest,
});
const taskExpectedArtifact = exact({
	kind: artifactKind,
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	logicalName: Type.String({ minLength: 1, maxLength: 256 }),
});
const taskDefinition = exact({
	taskId: taskIdentifier,
	goalId: id("goal"),
	definitionRevision: positiveInteger,
	owner: taskOwner,
	dependsOn: Type.Array(taskIdentifier, { maxItems: 256, uniqueItems: true }),
	expectedArtifacts: Type.Array(taskExpectedArtifact, { minItems: 1, maxItems: 64 }),
	workspace: taskWorkspaceRef,
	capabilities: Type.Array(taskCapabilityRef, { minItems: 1, maxItems: 64 }),
	definitionDigest: digest,
});
const sessionHeadRef = exact({
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sessionId: id("session"),
	cursor: eventCursor,
});
const agentInputSource = Type.Unsafe<InputSourceRef>(InputSourceRefSchema);
const agentDeclassificationReceipt = Type.Unsafe<DeclassificationReceiptRef>(DeclassificationReceiptRefSchema);
const agentEventCursor = exact({
	stream: Type.Union([
		exact({
			scope: Type.Literal("session"),
			streamId: brandedId("eventStream"),
			sessionId: brandedId("session"),
		}),
		exact({ scope: Type.Literal("authority_tenant"), streamId: brandedId("eventStream") }),
	]),
	sequence: revision,
	eventId: brandedId("event"),
	eventHash: digest,
});
const agentRole = Type.Union([
	Type.Literal("search"),
	Type.Literal("build"),
	Type.Literal("review"),
	Type.Literal("qa"),
]);
const agentState = Type.Union([
	Type.Literal("pending"),
	Type.Literal("starting"),
	Type.Literal("running"),
	Type.Literal("paused"),
	Type.Literal("partial"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
]);
const agentStateReason = Type.Union([
	Type.Literal("cancelled"),
	Type.Literal("timeout"),
	Type.Literal("crash"),
	Type.Literal("residency_evicted"),
	Type.Literal("budget_exhausted"),
	Type.Literal("delegation_revoked"),
	Type.Literal("workspace_lost"),
	Type.Literal("launch_rejected"),
	Type.Literal("resume_rejected"),
]);
const agentResidencyState = Type.Union([
	Type.Literal("nonresident"),
	Type.Literal("resident"),
	Type.Literal("evicted"),
	Type.Literal("recovering"),
	Type.Literal("unavailable"),
]);
const agentBudgetRequest = exact({
	maxTurns: revision,
	maxInputTokens: revision,
	maxOutputTokens: revision,
	maxUsdMicros: revision,
	maxWallTimeMs: revision,
	maxToolCalls: revision,
	maxNetworkBytes: revision,
	maxStorageBytes: revision,
});
const agentBudgetReservation = exact({
	reservationId: brandedId("budgetReservation"),
	operationId: brandedId("command"),
	requestDigest: digest,
});
const agentParentGrant = exact({
	receiptId: brandedId("receipt"),
	receiptDigest: digest,
	decisionRevision: revision,
	expiresAt: Type.Optional(timestamp),
});
const agentCapabilityRequest = Type.Union([
	exact({
		kind: Type.Literal("capability"),
		requestId: brandedId("command"),
		capability: Type.Union([
			Type.Literal("repository_read"),
			Type.Literal("workspace_write"),
			Type.Literal("dependency_install"),
			Type.Literal("network"),
			Type.Literal("process"),
			Type.Literal("credential"),
			Type.Literal("browser"),
			Type.Literal("deploy"),
			Type.Literal("cross_workspace"),
		]),
		requestDigest: digest,
	}),
	exact({
		kind: Type.Literal("tool"),
		requestId: brandedId("command"),
		toolKind: Type.Union([
			Type.Literal("builtin"),
			Type.Literal("mcp"),
			Type.Literal("custom"),
			Type.Literal("unknown"),
		]),
		resourceId: brandedId("resource"),
		manifestDigest: digest,
		requiredClaimsDigest: digest,
	}),
]);
const agentDelegationReceipt = exact({
	receiptId: brandedId("receipt"),
	parentAgentId: brandedId("agent"),
	childAgentId: brandedId("agent"),
	parentGrantReceiptId: brandedId("receipt"),
	parentGrantDigest: digest,
	requestDigest: digest,
	decision: Type.Union([Type.Literal("allowed"), Type.Literal("denied")]),
	childSpawnAllowed: Type.Boolean(),
	decisionRevision: revision,
	evaluatorId: brandedId("principal"),
	evaluatedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
	receiptDigest: digest,
});
const agentWorkspaceStrategy = exact({
	strategyId: brandedId("resource"),
	kind: Type.Union([
		Type.Literal("managed_worktree"),
		Type.Literal("isolated_lease"),
		Type.Literal("readonly_checkout"),
	]),
	strategyDigest: digest,
});
const agentWorkspaceReceipt = exact({
	receiptId: brandedId("receipt"),
	strategy: agentWorkspaceStrategy,
	sessionId: brandedId("session"),
	workspaceId: brandedId("workspace"),
	repositoryId: brandedId("repository"),
	bindingRevision: revision,
	bindingDigest: digest,
	leaseId: Type.Optional(brandedId("lease")),
	leaseRevision: Type.Optional(revision),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("readonly"),
		Type.Literal("released"),
		Type.Literal("stale"),
		Type.Literal("unavailable"),
	]),
	issuedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
	receiptDigest: digest,
});
const agentExpectedArtifact = exact({
	kind: artifactKind,
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	logicalName: Type.String({ minLength: 1, maxLength: 256 }),
});
const agentArtifactContract = exact({
	expected: readonlyArray(agentExpectedArtifact, { maxItems: 64 }),
	allowPartial: Type.Boolean(),
	contractDigest: digest,
});
const agentArtifactReport = exact({
	agentId: brandedId("agent"),
	logicalName: Type.String({ minLength: 1, maxLength: 256 }),
	artifact: ArtifactRefSchema,
	integrity: integrityStatus,
	verification: Type.Union([
		Type.Literal("verified"),
		Type.Literal("unverified"),
		Type.Literal("failed"),
		Type.Literal("inconclusive"),
	]),
	inputSources: readonlyArray(agentInputSource, { maxItems: 256 }),
	declassificationReceipts: readonlyArray(agentDeclassificationReceipt, { maxItems: 256 }),
	reportedAt: timestamp,
});
const agentResidencyReceipt = exact({
	receiptId: brandedId("receipt"),
	agentId: brandedId("agent"),
	sessionId: brandedId("session"),
	runtimeInstanceId: brandedId("runtime"),
	state: agentResidencyState,
	revision,
	observedAt: timestamp,
	reasonDigest: Type.Optional(digest),
	receiptDigest: digest,
});
const agentLaunchReceipt = exact({
	receiptId: brandedId("receipt"),
	agentId: brandedId("agent"),
	sessionId: brandedId("session"),
	launchRevision: revision,
	launchedAt: timestamp,
	receiptDigest: digest,
});
const agentDenialReceipt = exact({
	receiptId: brandedId("receipt"),
	agentId: brandedId("agent"),
	sessionId: brandedId("session"),
	status: Type.Union([
		Type.Literal("allowed"),
		Type.Literal("denied"),
		Type.Literal("revoked"),
		Type.Literal("unavailable"),
	]),
	decisionRevision: revision,
	checkedAt: timestamp,
	receiptDigest: digest,
});
const agentNode = exact({
	agentId: brandedId("agent"),
	rootAgentId: brandedId("agent"),
	parentAgentId: Type.Optional(brandedId("agent")),
	sessionId: brandedId("session"),
	goalId: brandedId("goal"),
	role: agentRole,
	objectiveDigest: digest,
	admissionRequestDigest: Type.Optional(digest),
	depth: revision,
	state: agentState,
	stateReason: Type.Optional(agentStateReason),
	capabilityGrant: Type.Optional(agentParentGrant),
	requestedCapabilities: readonlyArray(agentCapabilityRequest, { maxItems: 64 }),
	delegationReceipt: Type.Optional(agentDelegationReceipt),
	workspaceReceipt: agentWorkspaceReceipt,
	budget: agentBudgetRequest,
	budgetReservation: Type.Optional(agentBudgetReservation),
	turnsUsed: revision,
	turnIds: readonlyArray(brandedId("turn"), { maxItems: 1_000, uniqueItems: true }),
	artifactContract: agentArtifactContract,
	artifacts: readonlyArray(agentArtifactReport, { maxItems: 64 }),
	inputSources: readonlyArray(agentInputSource, { maxItems: 256 }),
	declassificationReceipts: readonlyArray(agentDeclassificationReceipt, { maxItems: 256 }),
	cursor: Type.Optional(agentEventCursor),
	residency: Type.Optional(agentResidencyReceipt),
	launchReceipt: Type.Optional(agentLaunchReceipt),
	createdAt: timestamp,
	updatedAt: timestamp,
});
const agentGraphEdge = exact({
	parentAgentId: brandedId("agent"),
	childAgentId: brandedId("agent"),
	createdAt: timestamp,
});
const agentSpawnIntent = exact({
	requestId: brandedId("command"),
	admissionRequestDigest: digest,
	parentAgentId: brandedId("agent"),
	childAgentId: brandedId("agent"),
	childSessionId: brandedId("session"),
	role: agentRole,
	objectiveDigest: digest,
	expectedArtifacts: readonlyArray(agentExpectedArtifact, { minItems: 1, maxItems: 64 }),
	allowPartial: Type.Boolean(),
	depth: revision,
	budget: agentBudgetRequest,
	parentGrant: agentParentGrant,
	requestedCapabilities: readonlyArray(agentCapabilityRequest, { maxItems: 64 }),
	workspaceStrategy: agentWorkspaceStrategy,
	inputSources: readonlyArray(agentInputSource, { maxItems: 256 }),
	declassificationReceipts: readonlyArray(agentDeclassificationReceipt, { maxItems: 256 }),
	requestedAt: timestamp,
});
const agentFailure = exact({
	code: token,
	messageDigest: digest,
	retryable: Type.Boolean(),
	outcomeCertain: Type.Boolean(),
	effect: mutationEffect,
});
const agentHandoffManifest = exact({
	manifestVersion: Type.Literal(1),
	handoffId: brandedId("command"),
	agentId: brandedId("agent"),
	parentAgentId: brandedId("agent"),
	sessionId: brandedId("session"),
	workspaceId: brandedId("workspace"),
	cursor: Type.Optional(agentEventCursor),
	delegationReceiptId: brandedId("receipt"),
	workspaceReceiptId: brandedId("receipt"),
	artifacts: readonlyArray(agentArtifactReport, { maxItems: 64 }),
	inputSources: readonlyArray(agentInputSource, { maxItems: 256 }),
	declassificationReceipts: readonlyArray(agentDeclassificationReceipt, { maxItems: 256 }),
	status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("failed")]),
	integrity: integrityStatus,
	createdAt: timestamp,
	manifestDigest: digest,
});
const agentMergeRequest = exact({
	requestId: brandedId("command"),
	idempotencyKey: IdempotencyKeySchema,
	parentAgentId: brandedId("agent"),
	childAgentId: brandedId("agent"),
	targetWorkspace: agentWorkspaceReceipt,
	sourceHandoff: agentHandoffManifest,
	artifacts: readonlyArray(agentArtifactReport, { minItems: 1, maxItems: 64 }),
	inputSources: readonlyArray(agentInputSource, { maxItems: 256 }),
	declassificationReceipts: readonlyArray(agentDeclassificationReceipt, { maxItems: 256 }),
	requestDigest: digest,
});
const agentMergeReceipt = exact({
	receiptId: brandedId("receipt"),
	requestId: brandedId("command"),
	parentAgentId: brandedId("agent"),
	childAgentId: brandedId("agent"),
	targetWorkspaceId: brandedId("workspace"),
	artifactIds: readonlyArray(brandedId("artifact"), { minItems: 1, maxItems: 64, uniqueItems: true }),
	outcome: Type.Union([Type.Literal("applied"), Type.Literal("conflict"), Type.Literal("rejected")]),
	resultArtifactRefs: readonlyArray(ArtifactRefSchema, { maxItems: 64 }),
	preservedArtifactRefs: readonlyArray(ArtifactRefSchema, { maxItems: 64 }),
	appliedAt: timestamp,
	receiptDigest: digest,
});
const agentCommandBase = {
	rootAgentId: brandedId("agent"),
	graphRevision: positiveInteger,
	requestId: brandedId("command"),
	idempotencyKey: IdempotencyKeySchema,
	commandDigest: digest,
} as const;
const commandDomain = Type.Union([
	Type.Literal("session"),
	Type.Literal("daemon"),
	Type.Literal("lifecycle"),
	Type.Literal("policy"),
]);
const controlPlaneCommandType = Type.Unsafe<ControlPlaneCommandType>(
	Type.Union(CONTROL_PLANE_COMMAND_TYPES.map((entry) => Type.Literal(entry))),
);
const commandClaimRef = exact({
	commandId: id("command"),
	claimEventId: id("event"),
	requestDigest: digest,
});
const commandSessionHandle = exact({
	handleId: Type.String({ pattern: "^handle_[A-Za-z0-9-]{16,96}$", maxLength: 103 }),
	sessionId: id("session"),
	generation: positiveInteger,
});
const commandSessionBootstrap = exact({
	sessionId: id("session"),
	handle: commandSessionHandle,
	head: Type.Union([eventCursor, Type.Null()]),
	recovery: Type.Union([Type.Literal("new"), Type.Literal("resumed"), Type.Literal("forked")]),
});
const commandQueueCancellationReceipt = exact({
	queueItemId: id("queueItem"),
	sourceCommandId: id("command"),
	kind: Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]),
	contentDigest: digest,
	durableCursor: eventCursor,
});
const commandDraftPrProviderReceipt = exact({
	schemaVersion: Type.Literal(1),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	receiptId: id("receipt"),
	requestId: id("command"),
	providerId: Type.String({ minLength: 1, maxLength: 512 }),
	proposalId: id("changeProposal"),
	proposalDigest: digest,
	sealId: id("episodeSeal"),
	sealDigest: digest,
	repositoryId: id("repository"),
	candidateCommit: Type.String({ minLength: 1, maxLength: 512 }),
	draft: Type.Literal(true),
	externalReferenceDigest: digest,
	providerRevision: revision,
	createdAt: timestamp,
	receiptDigest: digest,
});
const commandHumanGateDecision = exact({
	schemaVersion: Type.Literal(1),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	humanGateId: id("humanGate"),
	requestId: id("command"),
	proposalId: id("changeProposal"),
	proposalDigest: digest,
	action: Type.Union([Type.Literal("merge"), Type.Literal("deploy")]),
	decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
	decisionAuthority: Type.Union([Type.Literal("human"), Type.Literal("organization")]),
	decidedBy: id("principal"),
	receiptId: id("receipt"),
	decisionReasonDigest: digest,
	decidedAt: timestamp,
	receiptDigest: digest,
});
/**
 * command terminal 必须自包含完整结果，不能只保留 digest 再依赖进程内 cache。
 * 事件层仍受 64 KiB payload 总上限约束，内部集合另设显式上限。
 */
const commandEffect = Type.Union([
	exact({ type: Type.Literal("session:start"), bootstrap: commandSessionBootstrap }),
	exact({ type: Type.Literal("session:resume"), bootstrap: commandSessionBootstrap }),
	exact({ type: Type.Literal("session:fork"), bootstrap: commandSessionBootstrap }),
	exact({ type: Type.Literal("session:stop"), sessionId: id("session"), terminalCursor: eventCursor }),
	exact({
		type: Type.Literal("turn:start"),
		sessionId: id("session"),
		queueItemId: id("queueItem"),
		durableCursor: eventCursor,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:steer"),
		sessionId: id("session"),
		queueItemId: id("queueItem"),
		durableCursor: eventCursor,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:followUp"),
		sessionId: id("session"),
		queueItemId: id("queueItem"),
		durableCursor: eventCursor,
		preflightDigest: digest,
	}),
	exact({
		type: Type.Literal("turn:interrupt"),
		sessionId: id("session"),
		status: Type.Union([Type.Literal("accepted"), Type.Literal("already_terminal")]),
		durableCursor: eventCursor,
	}),
	exact({
		type: Type.Literal("queue:cancel"),
		sessionId: id("session"),
		previousQueueRevision: digest,
		queueRevision: digest,
		receipts: readonlyArray(commandQueueCancellationReceipt, { minItems: 1, maxItems: 1024 }),
	}),
	exact({
		type: Type.Literal("approval:resolve"),
		approvalId: id("approval"),
		requestId: id("command"),
		ticketDigest: digest,
		decisionRevision: revision,
		receiptDigest: digest,
	}),
	exact({ type: Type.Literal("changeProposal:requestDraftPr"), receipt: commandDraftPrProviderReceipt }),
	exact({ type: Type.Literal("humanGate:resolve"), decision: commandHumanGateDecision }),
	exact({ type: Type.Literal("shutdown"), acceptedAt: timestamp, drainDeadline: timestamp }),
]);
const commandErrorDetailValue = Type.Union([
	Type.String({ maxLength: 512 }),
	Type.Number(),
	Type.Boolean(),
]);
const commandError = exact({
	code: token,
	message: Type.String({ minLength: 1, maxLength: 1024 }),
	retryable: Type.Boolean(),
	details: Type.Optional(Type.Record(
		Type.String({ minLength: 1, maxLength: 64 }),
		commandErrorDetailValue,
		{ maxProperties: 32 },
	)),
});
const shutdownRequestRef = exact({
	claim: commandClaimRef,
	requestedEventId: id("event"),
	requestedPayloadDigest: digest,
});
const shutdownFailureBase = {
	request: shutdownRequestRef,
	runtimeId: brandedId("runtime"),
	runtimeGeneration: positiveInteger,
	drainDeadline: timestamp,
	error: errorRef,
} as const;
const queueKind = Type.Union([Type.Literal("steer"), Type.Literal("follow_up")]);
const remoteExecutorKind = Type.Union([
	Type.Literal("ci"),
	Type.Literal("ssh"),
	Type.Literal("relay"),
]);
const remoteExecutorOutcome = Type.Union([
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("uncertain"),
]);
const queueNextTurnPolicy = Type.Union([
	Type.Literal("next_model_turn"),
	Type.Literal("after_active_run"),
]);
const queueTargetTurnRevision = Type.Union([
	exact({
		turnId: id("turn"),
		sessionRevision: expectedRevision,
	}),
	Type.Null(),
]);
export const QueueItemV3ContentSchema = Type.Union([
	exact({
		storage: Type.Literal("bounded_text"),
		messageJson: Type.String({ minLength: 2, maxLength: 60 * 1024 }),
	}),
	exact({
		storage: Type.Literal("artifact"),
		artifact: ArtifactRefSchema,
	}),
]);
const goalPhase = Type.Union([
	Type.Literal("planning"),
	Type.Literal("awaiting_plan_approval"),
	Type.Literal("implementation"),
	Type.Literal("build"),
	Type.Literal("test"),
	Type.Literal("security_review"),
	Type.Literal("independent_review"),
	Type.Literal("remediation"),
	Type.Literal("reverification"),
	Type.Literal("awaiting_verification"),
	Type.Literal("awaiting_human"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
]);
const resumableGoalPhase = Type.Union([
	Type.Literal("planning"),
	Type.Literal("awaiting_plan_approval"),
	Type.Literal("implementation"),
	Type.Literal("build"),
	Type.Literal("test"),
	Type.Literal("security_review"),
	Type.Literal("independent_review"),
	Type.Literal("remediation"),
	Type.Literal("reverification"),
	Type.Literal("awaiting_verification"),
]);
const goalEvidenceKind = Type.Union([
	Type.Literal("plan"),
	Type.Literal("plan_approval"),
	Type.Literal("implementation"),
	Type.Literal("build"),
	Type.Literal("test"),
	Type.Literal("security_review"),
	Type.Literal("independent_review"),
	Type.Literal("pull_request"),
	Type.Literal("finding"),
	Type.Literal("remediation"),
	Type.Literal("reverification"),
	Type.Literal("verification"),
	Type.Literal("human_request"),
	Type.Literal("human_decision"),
	Type.Literal("failure"),
	Type.Literal("stop_request"),
]);
const episodeSealCompletionRef = exact({
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sealId: id("episodeSeal"),
	sealDigest: digest,
	sealRecordDigest: digest,
	manifestBodyDigest: digest,
});
const goalEvidence = exact({
	kind: goalEvidenceKind,
	receiptId: id("receipt"),
	digest,
	outcome: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("recorded")]),
	issuerId: Type.String({ minLength: 1, maxLength: 256 }),
	issuedAt: timestamp,
	artifact: Type.Optional(ArtifactRefSchema),
	episodeSeal: Type.Optional(episodeSealCompletionRef),
});
const goalState = exact({
	goalId: id("goal"),
	phase: goalPhase,
	revision,
	evidence: readonlyArray(goalEvidence, { maxItems: 512 }),
	partialResults: readonlyArray(ArtifactRefSchema, { maxItems: 64 }),
	pausedFrom: Type.Optional(resumableGoalPhase),
});
const goalTransitionRequest = exact({
	to: goalPhase,
	actor: Type.Union([
		Type.Literal("runtime"),
		Type.Literal("human"),
		Type.Literal("trusted_verifier"),
		Type.Literal("model"),
	]),
	expectedRevision: revision,
	evidence: readonlyArray(goalEvidence, { maxItems: 128 }),
	partialResults: Type.Optional(readonlyArray(ArtifactRefSchema, { maxItems: 64 })),
});
const durableMutationIdentity = {
	transactionId: id("command"),
	idempotencyKey: IdempotencyKeySchema,
	transactionDigest: digest,
} as const;

const budgetDimension = Type.Union([
	Type.Literal("inputTokens"),
	Type.Literal("outputTokens"),
	Type.Literal("usdMicros"),
	Type.Literal("wallTimeMs"),
	Type.Literal("toolCalls"),
	Type.Literal("retries"),
	Type.Literal("networkBytes"),
	Type.Literal("storageBytes"),
	Type.Literal("artifactCount"),
	Type.Literal("verifications"),
	Type.Literal("activeAgents"),
]);
const budgetVector = exact({
	inputTokens: revision,
	outputTokens: revision,
	usdMicros: revision,
	wallTimeMs: revision,
	toolCalls: revision,
	retries: revision,
	networkBytes: revision,
	storageBytes: revision,
	artifactCount: revision,
	verifications: revision,
	activeAgents: revision,
});
const budgetThreshold = exact({ soft: revision, hard: revision });
const budgetLimits = exact({
	inputTokens: budgetThreshold,
	outputTokens: budgetThreshold,
	usdMicros: budgetThreshold,
	wallTimeMs: budgetThreshold,
	toolCalls: budgetThreshold,
	retries: budgetThreshold,
	networkBytes: budgetThreshold,
	storageBytes: budgetThreshold,
	artifactCount: budgetThreshold,
	verifications: budgetThreshold,
	activeAgents: budgetThreshold,
});
const budgetDelta = Type.Integer({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const budgetDeltaVector = exact({
	inputTokens: budgetDelta,
	outputTokens: budgetDelta,
	usdMicros: budgetDelta,
	wallTimeMs: budgetDelta,
	toolCalls: budgetDelta,
	retries: budgetDelta,
	networkBytes: budgetDelta,
	storageBytes: budgetDelta,
	artifactCount: budgetDelta,
	verifications: budgetDelta,
	activeAgents: budgetDelta,
});
const budgetDimensions = readonlyArray(budgetDimension, { minItems: 1, maxItems: 11, uniqueItems: true });
const budgetJournalRecord = Type.Union([
	exact({
		kind: Type.Literal("budget.reserved"),
		goalId: id("goal"),
		reservationId: id("budgetReservation"),
		operationId: id("command"),
		estimatedUpperBound: budgetVector,
		reservedAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.committed"),
		goalId: id("goal"),
		reservationId: id("budgetReservation"),
		actual: budgetVector,
		committedAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.refunded"),
		goalId: id("goal"),
		reservationId: id("budgetReservation"),
		amount: budgetVector,
		reason: Type.Union([
			Type.Literal("unused_reservation"),
			Type.Literal("cancelled"),
			Type.Literal("not_started"),
		]),
		refundedAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.reconciled"),
		goalId: id("goal"),
		reservationId: id("budgetReservation"),
		previousActual: budgetVector,
		correctedActual: budgetVector,
		delta: budgetDeltaVector,
		tokenErrorBps: revision,
		usdErrorBps: revision,
		withinAllowedError: Type.Boolean(),
		reconciledAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.soft_threshold"),
		goalId: id("goal"),
		dimensions: budgetDimensions,
		observed: budgetVector,
		remindedAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.reservation_denied"),
		goalId: id("goal"),
		reservationId: id("budgetReservation"),
		operationId: id("command"),
		estimatedUpperBound: budgetVector,
		dimensions: budgetDimensions,
		reason: Type.Union([Type.Literal("concurrency_limit"), Type.Literal("hard_limit")]),
		deniedAt: timestamp,
	}),
	exact({
		kind: Type.Literal("budget.hard_stopped"),
		goalId: id("goal"),
		dimensions: budgetDimensions,
		reason: Type.Union([
			Type.Literal("reservation_exceeded"),
			Type.Literal("threshold_reached"),
			Type.Literal("reconciliation_overage"),
		]),
		partialResults: readonlyArray(ArtifactRefSchema, { maxItems: 64 }),
		stoppedAt: timestamp,
	}),
]);

export const MAX_ORCHESTRATOR_JOURNAL_RECORDS = 64;
export const MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES = 32 * 1024;
export const MAX_EPISODE_VERIFICATION_RECEIPTS = 64;
export const MAX_AGENT_GRAPH_TRANSACTION_RECORDS = 16;
export const MAX_AGENT_GRAPH_RECORDS_JSON_BYTES = 56 * 1024;
export const ORCHESTRATOR_JOURNAL_KINDS = ["goal", "save_point", "budget", "queue"] as const;
export type OrchestratorJournalKind = (typeof ORCHESTRATOR_JOURNAL_KINDS)[number];

const orchestratorJournalKind = Type.Union([
	Type.Literal("goal"),
	Type.Literal("save_point"),
	Type.Literal("budget"),
	Type.Literal("queue"),
]);

const modelRoutePayloadBase = {
	turnId: id("turn"),
	routeRequestId: id("command"),
	decisionId: id("receipt"),
	decisionDigest: digest,
} as const;

const modelRoutedPayload = Type.Union([
	exact({
		...modelRoutePayloadBase,
		outcome: Type.Literal("compatible"),
		profileId: id("resource"),
		manifestDigest: digest,
		profileDigest: digest,
	}),
	exact({
		...modelRoutePayloadBase,
		outcome: Type.Literal("fork"),
		profileId: id("resource"),
		manifestDigest: digest,
		profileDigest: digest,
	}),
	exact({
		...modelRoutePayloadBase,
		outcome: Type.Literal("deny"),
		profileId: Type.Optional(id("resource")),
		manifestDigest: Type.Optional(digest),
		profileDigest: Type.Optional(digest),
	}),
]);

const legacyMigrationImportBase = {
	manifestDigest: digest,
	sourceVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
	sourceIndex: revision,
	sourceEntryId: Type.String({ minLength: 1, maxLength: 512 }),
	sourceRecordDigest: digest,
	contentDigest: digest,
	recoveredFields: Type.Array(token, { maxItems: 32, uniqueItems: true }),
	lostFields: Type.Array(token, { maxItems: 32, uniqueItems: true }),
} as const;

const legacyLedgerEntryType = Type.Union([
	Type.Literal("session"),
	Type.Literal("message"),
	Type.Literal("tool_call"),
	Type.Literal("tool_result"),
	Type.Literal("turn"),
	Type.Literal("agent_event"),
	Type.Literal("custom"),
]);

const legacyMessageKind = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("toolResult"),
]);

export const RUNTIME_EVENT_PAYLOAD_SCHEMAS = {
	"session.created": exact({
		origin: Type.Union([Type.Literal("new"), Type.Literal("import"), Type.Literal("test")]),
		runtimeId: id("runtime"),
		featureDigest: digest,
		initialGoalId: id("goal"),
		rootAgentId: id("agent"),
	}),
	"session.forked": exact({
		parentSessionId: id("session"),
		parentSequence: revision,
		parentEventHash: digest,
		parentLeafId: id("leaf"),
		goalMode: Type.Union([
			Type.Literal("continue_existing_goal"),
			Type.Literal("create_child_goal"),
		]),
		initialGoalId: id("goal"),
		rootAgentId: id("agent"),
		parentRootAgentId: id("agent"),
		idempotencyKey: id("command"),
	}),
	"session.migration_started": exact({
		mode: Type.Union([Type.Literal("migrate"), Type.Literal("fork-to-v3")]),
		sourceVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
		sourceDigest: digest,
		sourceSize: revision,
		headerDigest: digest,
		sourceSessionId: Type.String({ minLength: 1, maxLength: 512 }),
		importerVersion: token,
		importSchema: token,
		configurationJson: Type.String({ minLength: 2, maxLength: 8 * 1024 }),
		configurationDigest: digest,
		recoveredFields: Type.Array(token, { maxItems: 128, uniqueItems: true }),
		lostFields: Type.Array(token, { maxItems: 128, uniqueItems: true }),
		expectedRecordCount: revision,
		expectedRecordSetDigest: digest,
		manifestDigest: digest,
		idempotencyKey: id("command"),
	}),
	"session.legacy_message_imported": Type.Union([
			exact({
			...legacyMigrationImportBase,
			entryType: Type.Literal("message"),
			messageKind: legacyMessageKind,
			disposition: Type.Literal("recovered"),
			messageJson: Type.String({ minLength: 2, maxLength: 48 * 1024 }),
		}),
		exact({
			...legacyMigrationImportBase,
			entryType: legacyLedgerEntryType,
			messageKind: Type.Union([legacyMessageKind, Type.Literal("non_message")]),
			disposition: Type.Literal("omitted"),
		}),
	]),
	"session.migration_committed": exact({
		manifestDigest: digest,
		expectedRecordCount: revision,
		importedRecordCount: revision,
		recordSetDigest: digest,
	}),
	"session.migration_failed": exact({
		manifestDigest: digest,
		expectedRecordCount: revision,
		importedRecordCount: revision,
		reasonCode: token,
		reasonDigest: digest,
	}),
	"session.stop_requested": exact({ reason: shortText, requestedBy: id("principal"), expectedRevision }),
	"session.stopped": exact({ reason: shortText, tombstoneDigest: digest, lastDurableSequence: revision }),
	"session.closed": exact({
		headHash: digest,
		eventCount: positiveInteger,
		integrity: integrityStatus,
		attestation: attestationStatus,
	}),
	"session.corrupted": exact({
		firstBadSequence: Type.Optional(revision),
		error: errorRef,
		reportArtifactId: Type.Optional(id("artifact")),
	}),
	"session.repair_reported": exact({
		sourceHeadHash: digest,
		reportArtifactId: id("artifact"),
		outcome: Type.Union([Type.Literal("salvaged"), Type.Literal("unrecoverable")]),
	}),
	"session.handoff_requested": exact({
		handoffId: id("command"),
		idempotencyKey: IdempotencyKeySchema,
		subjectSessionId: id("session"),
		sourceAuthorityId: id("authority"),
		sourceTenantId: id("tenant"),
		targetAuthorityId: id("authority"),
		targetTenantId: id("tenant"),
		finalSessionHead: sessionHeadRef,
		referenceGraphDigest: digest,
		leaseTransferIntentDigest: digest,
	}),
	"session.handoff_committed": exact({
		handoffId: id("command"),
		subjectSessionId: id("session"),
		finalSessionHead: sessionHeadRef,
		targetAuthorityId: id("authority"),
		targetTenantId: id("tenant"),
		targetRuntimeId: id("runtime"),
		leaseTransferReceiptId: id("receipt"),
		leaseTransferReceiptDigest: digest,
		referenceGraphDigest: digest,
	}),
	"session.handoff_failed": exact({
		handoffId: id("command"),
		subjectSessionId: id("session"),
		finalSessionHead: sessionHeadRef,
		error: errorRef,
		outcomeCertain: Type.Boolean(),
	}),
	"session.deletion_planned": exact({
		deletionId: id("command"),
		idempotencyKey: IdempotencyKeySchema,
		subjectSessionId: id("session"),
		finalSessionHead: sessionHeadRef,
		referenceGraphDigest: digest,
		legalHoldDecision: Type.Union([Type.Literal("clear"), Type.Literal("blocked")]),
		legalHoldReceiptId: id("receipt"),
		legalHoldReceiptDigest: digest,
	}),
	"session.deletion_tombstoned": exact({
		deletionId: id("command"),
		subjectSessionId: id("session"),
		plannedEventId: id("event"),
		finalSessionHead: sessionHeadRef,
		referenceGraphDigest: digest,
		tombstoneReceiptId: id("receipt"),
		tombstoneReceiptDigest: digest,
	}),
	"session.deletion_committed": exact({
		deletionId: id("command"),
		subjectSessionId: id("session"),
		tombstoneEventId: id("event"),
		finalSessionHead: sessionHeadRef,
		referenceGraphDigest: digest,
		deletionReceiptId: id("receipt"),
		deletionReceiptDigest: digest,
	}),
	"session.deletion_failed": exact({
		deletionId: id("command"),
		subjectSessionId: id("session"),
		finalSessionHead: sessionHeadRef,
		error: errorRef,
		outcomeCertain: Type.Boolean(),
	}),
	"input.source_recorded": exact({
		source: InputSourceRefSchema,
		contentArtifactId: Type.Optional(id("artifact")),
	}),
	"input.declassification_decided": Type.Union([
		exact({
			source: InputSourceRefSchema,
			decision: Type.Literal("allowed"),
			receipt: DeclassificationReceiptRefSchema,
			reasonDigest: digest,
		}),
		exact({
			source: InputSourceRefSchema,
			decision: Type.Literal("denied"),
			allowedSink: token,
			policyDigest: digest,
			decidedBy: id("principal"),
			decisionRevision: revision,
			reasonDigest: digest,
		}),
	]),
	"conversation.message_recorded": exact({
		role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("toolResult")]),
		messageJson: Type.String({ minLength: 2, maxLength: 131_072 }),
		contentDigest: digest,
	}),
	"orchestrator.journal_committed": exact({
		journalKind: orchestratorJournalKind,
		journalRevision: positiveInteger,
		transactionId: id("command"),
		idempotencyKey: IdempotencyKeySchema,
		transactionDigest: digest,
		recordCount: Type.Integer({ minimum: 1, maximum: MAX_ORCHESTRATOR_JOURNAL_RECORDS }),
		recordsByteLength: Type.Integer({ minimum: 2, maximum: MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES }),
		recordsJson: Type.String({ minLength: 2, maxLength: MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES }),
	}),
	"goal.created": exact({
		...durableMutationIdentity,
		journalRevision: positiveInteger,
		state: goalState,
		stateDigest: digest,
	}),
	"goal.transitioned": exact({
		...durableMutationIdentity,
		journalRevision: positiveInteger,
		request: goalTransitionRequest,
		state: goalState,
		stateDigest: digest,
	}),
	"task.created": exact({
		...durableMutationIdentity,
		repositoryRevision: positiveInteger,
		task: taskDefinition,
	}),
	"task.definition_revised": exact({
		...durableMutationIdentity,
		repositoryRevision: positiveInteger,
		taskId: taskIdentifier,
		fromDefinitionRevision: positiveInteger,
		toDefinition: taskDefinition,
	}),
	"task.transitioned": exact({
		...durableMutationIdentity,
		repositoryRevision: positiveInteger,
		taskId: taskIdentifier,
		definitionRevision: positiveInteger,
		from: taskStatus,
		to: taskStatus,
		reasonDigest: digest,
		evidenceArtifactIds: Type.Array(id("artifact"), { maxItems: 64, uniqueItems: true }),
	}),
	"task.output_bound": exact({
		...durableMutationIdentity,
		repositoryRevision: positiveInteger,
		taskId: taskIdentifier,
		definitionRevision: positiveInteger,
		logicalName: Type.String({ minLength: 1, maxLength: 256 }),
		artifact: ArtifactRefSchema,
		bindingDigest: digest,
	}),
	"turn.started": exact({ turnId: id("turn"), goalId: id("goal"), queueItemId: Type.Optional(id("queueItem")) }),
	"turn.finished": exact({ turnId: id("turn"), resultDigest: digest, stopReason: token }),
	"turn.interrupted": exact({ turnId: id("turn"), reason: shortText, partialArtifactId: Type.Optional(id("artifact")) }),
	"turn.failed": exact({ turnId: id("turn"), error: errorRef, partialArtifactId: Type.Optional(id("artifact")) }),
	"model.routed": modelRoutedPayload,
	"model.requested": exact({ turnId: id("turn"), requestId: id("modelRequest"), modelId: token, contextDigest: digest }),
	"model.finished": exact({
		turnId: id("turn"),
		requestId: id("modelRequest"),
		responseDigest: digest,
		inputTokens: revision,
		outputTokens: revision,
	}),
	"model.failed": exact({ turnId: id("turn"), requestId: id("modelRequest"), error: errorRef }),
	"tool.requested": exact({
		turnId: id("turn"),
		toolCallId: id("toolCall"),
		agentId: id("agent"),
		toolIdentityDigest: digest,
		argumentsDigest: digest,
	}),
	"tool.authorized": ToolAuthorizedPayloadSchema,
	"tool.started": exact({ toolCallId: id("toolCall"), invocationDigest: digest, workspaceReceiptId: id("receipt") }),
	"tool.finished": exact({ toolCallId: id("toolCall"), resultDigest: digest, artifactId: Type.Optional(id("artifact")) }),
	"tool.interrupted": exact({ toolCallId: id("toolCall"), reason: shortText, outcomeCertain: Type.Boolean() }),
	"tool.failed": exact({ toolCallId: id("toolCall"), error: errorRef, outcomeCertain: Type.Boolean() }),
	"permission.requested": PermissionRequestedPayloadSchema,
	"permission.decided": PermissionDecidedPayloadSchema,
	"permission.expired": PermissionExpiredPayloadSchema,
	"permission.revoked": PermissionRevokedPayloadSchema,
	"capability.rate_limit_recorded": exact({
		receipt: GatewayRateLimitReceiptSchema,
		expectedRevision,
	}),
	"workspace.bound": WorkspaceBoundPayloadSchema,
	"workspace.validation_recorded": WorkspaceValidationRecordedPayloadSchema,
	"workspace.released": WorkspaceReleasedPayloadSchema,
	"sandbox.resolved": SandboxResolvedPayloadSchema,
	"sandbox.execution_recorded": SandboxExecutionRecordedPayloadSchema,
	"executor.requested": exact({
		requestId: id("command"),
		idempotencyKey: id("command"),
		executorId: id("resource"),
		executorKind: remoteExecutorKind,
		invocationDigest: digest,
	}),
	"executor.execution_recorded": exact({
		requestId: id("command"),
		executorId: id("resource"),
		executorKind: remoteExecutorKind,
		invocationDigest: digest,
		receiptId: id("receipt"),
		receiptDigest: digest,
		status: remoteExecutorOutcome,
	}),
	"queue.enqueued": exact({
		queueItemId: id("queueItem"),
		sourceCommandId: id("command"),
		kind: queueKind,
		enqueueRevision: expectedRevision,
		targetTurnRevision: queueTargetTurnRevision,
		nextTurnPolicy: queueNextTurnPolicy,
		contentDigest: digest,
		content: QueueItemV3ContentSchema,
	}),
	"queue.claimed": exact({
		queueItemId: id("queueItem"),
		sourceCommandId: id("command"),
		kind: queueKind,
		turnId: id("turn"),
		modelRequestId: id("modelRequest"),
		contentDigest: digest,
	}),
	"queue.consumed": exact({
		queueItemId: id("queueItem"),
		sourceCommandId: id("command"),
		kind: queueKind,
		turnId: id("turn"),
		modelRequestId: id("modelRequest"),
		contentDigest: digest,
	}),
	"queue.cancelled": exact({
		queueItemId: id("queueItem"),
		sourceCommandId: id("command"),
		kind: queueKind,
		contentDigest: digest,
		reason: shortText,
		cancellationCommandId: id("command"),
	}),
	"checkpoint.created": exact({
		checkpointId: id("checkpoint"),
		sequence: revision,
		eventHash: digest,
		reducerDigest: digest,
		activeLeafId: id("leaf"),
		activePlanDigest: Type.Optional(digest),
		compositeCheckpointRef: Type.Optional(token),
	}),
	"checkpoint.rewound": exact({
		checkpointId: id("checkpoint"),
		fromLeafId: id("leaf"),
		toLeafId: id("leaf"),
		workspaceRewindReceiptId: Type.Optional(id("receipt")),
	}),
	"artifact.intent_recorded": exact({
		artifactId: id("artifact"),
		operationId: id("command"),
		metadataDigest: digest,
		idempotencyKey: id("command"),
		sourceSessionId: id("session"),
		workspaceId: Type.Optional(id("workspace")),
		producerId: anyId,
		kind: artifactKind,
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		lineageDigest: digest,
		createdAt: timestamp,
	}),
	"artifact.aborted": exact({
		artifactId: id("artifact"),
		operationId: id("command"),
		reason: Type.Union([
			Type.Literal("staging_failed"),
			Type.Literal("metadata_failed"),
			Type.Literal("reconciled_rollback"),
		]),
		reasonDigest: digest,
	}),
	"artifact.created": exact({
		artifactId: id("artifact"),
		operationId: id("command"),
		storedDigest: digest,
		storedSize: revision,
		metadataDigest: digest,
	}),
	"artifact.committed": exact({
		artifactId: id("artifact"),
		operationId: id("command"),
		storedDigest: digest,
		storedSize: revision,
		metadataDigest: digest,
		receiptId: id("receipt"),
	}),
	"resource.snapshot": exact({ snapshotId: id("snapshot"), generation: revision, resourceCount: revision, snapshotDigest: digest }),
	"resource.lifecycle_recorded": exact({
		resourceId: id("resource"),
		state: Type.Union([
			Type.Literal("discovered"),
			Type.Literal("approved"),
			Type.Literal("revoked"),
			Type.Literal("activated"),
			Type.Literal("deactivated"),
			Type.Literal("failed"),
		]),
		identityDigest: digest,
		receiptId: Type.Optional(id("receipt")),
	}),
	"resource.approved": exact({ resourceId: id("resource"), identityDigest: digest, receiptId: id("receipt") }),
	"resource.revoked": exact({ resourceId: id("resource"), identityDigest: digest, revocationRevision: revision, receiptId: id("receipt") }),
	"mode.transitioned": exact({
		from: Type.Union([Type.Literal("default"), Type.Literal("plan")]),
		to: Type.Union([Type.Literal("default"), Type.Literal("plan")]),
		fromState: Type.Union([
			Type.Literal("inactive"),
			Type.Literal("pending_activation"),
			Type.Literal("active"),
			Type.Literal("awaiting_approval"),
			Type.Literal("exit_pending"),
		]),
		toState: Type.Union([
			Type.Literal("inactive"),
			Type.Literal("pending_activation"),
			Type.Literal("active"),
			Type.Literal("awaiting_approval"),
			Type.Literal("exit_pending"),
		]),
		modeRevision: revision,
		commandId: id("command"),
		approvalId: Type.Optional(id("approval")),
	}),
	"plan.proposed": exact({ planId: id("plan"), planRevision: revision, artifactId: id("artifact"), planDigest: digest }),
	"plan.approved": exact({ planId: id("plan"), planRevision: revision, approvalId: id("approval"), receiptId: id("receipt") }),
	"plan.rejected": exact({ planId: id("plan"), planRevision: revision, approvalId: id("approval"), reasonDigest: digest }),
	"plan.invalidated": exact({ planId: id("plan"), planRevision: revision, reasonDigest: digest }),
	"context.assembled": exact({
		requestId: id("contextRequest"),
		receiptId: id("receipt"),
		modelId: token,
		modelProfileId: id("resource"),
		contextDigest: digest,
		receiptDigest: digest,
		includedCount: revision,
		omittedCount: revision,
	}),
	"compaction.started": exact({
		compactionId: id("compaction"),
		reason: Type.Union([
			Type.Literal("manual"),
			Type.Literal("auto"),
			Type.Literal("overflow"),
			Type.Literal("model_switch"),
		]),
		sourceFromSequence: revision,
		sourceToSequence: revision,
		retainedFromSequence: revision,
		invariantDigest: digest,
		idempotencyKey: id("command"),
	}),
	"compaction.completed": exact({
		compactionId: id("compaction"),
		checkpointId: id("checkpoint"),
		checkpointDigest: digest,
		summaryArtifactId: id("artifact"),
		summaryDigest: digest,
		invariantDigest: digest,
		previousCheckpointId: Type.Optional(id("checkpoint")),
	}),
	"compaction.failed": exact({ compactionId: id("compaction"), error: errorRef, originalProjectionDigest: digest }),
	"compaction.suppressed": exact({ compactionId: id("compaction"), reason: shortText, attemptDigest: digest }),
	"memory.proposed": exact({
		memoryId: id("memory"),
		proposalId: id("memoryProposal"),
		scope: Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("session")]),
		contentDigest: digest,
		diffArtifactId: id("artifact"),
		diffDigest: digest,
		approvalId: id("approval"),
	}),
	"memory.approved": exact({ memoryId: id("memory"), proposalId: id("memoryProposal"), approvalId: id("approval"), receiptId: id("receipt") }),
	"memory.rejected": exact({ memoryId: id("memory"), proposalId: id("memoryProposal"), approvalId: id("approval"), reasonDigest: digest }),
	"memory.published": exact({ memoryId: id("memory"), recordDigest: digest, publicationReceiptId: id("receipt") }),
	"memory.searched": exact({
		requestId: id("command"),
		receiptId: id("receipt"),
		queryDigest: digest,
		mode: Type.Union([Type.Literal("lexical"), Type.Literal("vector"), Type.Literal("hybrid"), Type.Literal("none")]),
		resultCount: revision,
		receiptDigest: digest,
	}),
	"memory.injected": exact({
		memoryId: id("memory"),
		contextRequestId: id("contextRequest"),
		receiptId: id("receipt"),
		recordDigest: digest,
		receiptDigest: digest,
	}),
	"memory.revoked": exact({ memoryId: id("memory"), revocationRevision: revision, receiptId: id("receipt") }),
	"memory.expired": exact({ memoryId: id("memory"), expiredAt: timestamp, recordDigest: digest }),
	"budget.transaction_committed": exact({
		...durableMutationIdentity,
		journalRevision: positiveInteger,
		goalId: id("goal"),
		limits: budgetLimits,
		limitsDigest: digest,
		records: readonlyArray(budgetJournalRecord, { minItems: 1, maxItems: MAX_ORCHESTRATOR_JOURNAL_RECORDS }),
	}),
	"verification.started": exact({ verificationId: id("verification"), gateDigest: digest, candidateDigest: digest, idempotencyKey: id("command") }),
	"verification.finished": exact({
		verificationId: id("verification"),
		outcome: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]),
		resultArtifactId: id("artifact"),
		issuerReceiptId: id("receipt"),
	}),
	"episode.manifest_committed": exact({
		receiptId: id("receipt"),
		manifestBodyDigest: digest,
		manifestArtifact: artifactRef,
		evidenceHead: eventCursor,
	}),
	"episode.seal_recorded": exact({
		receiptId: id("receipt"),
		sealId: id("episodeSeal"),
		sealDigest: digest,
		manifestBodyDigest: digest,
		manifestCommitCursor: eventCursor,
		referenceClosureDigest: digest,
		verificationReceiptDigests: Type.Array(digest, {
			maxItems: MAX_EPISODE_VERIFICATION_RECEIPTS,
			uniqueItems: true,
		}),
		sealJson: Type.String({ minLength: 2, maxLength: 48 * 1024 }),
	}),
	"draft_pr.requested": exact({
		requestId: id("command"),
		idempotencyKey: id("command"),
		proposalId: id("changeProposal"),
		proposalDigest: digest,
		sealId: id("episodeSeal"),
		sealDigest: digest,
		repositoryId: id("repository"),
		workspaceId: id("workspace"),
		candidateCommit: token,
		providerId: token,
		authorizationReceiptId: id("receipt"),
		authorizationReceiptDigest: digest,
	}),
	"draft_pr.created": exact({
		requestId: id("command"),
		proposalId: id("changeProposal"),
		proposalDigest: digest,
		sealId: id("episodeSeal"),
		sealDigest: digest,
		providerId: token,
		receiptId: id("receipt"),
		receiptDigest: digest,
		draft: Type.Literal(true),
		externalReferenceDigest: digest,
		providerRevision: revision,
	}),
	"draft_pr.failed": exact({
		requestId: id("command"),
		proposalId: id("changeProposal"),
		proposalDigest: digest,
		providerId: token,
		error: errorRef,
		outcomeCertain: Type.Boolean(),
	}),
	"human_gate.requested": exact({
		humanGateId: id("humanGate"),
		requestId: id("command"),
		requestedBy: id("principal"),
		action: Type.Union([Type.Literal("merge"), Type.Literal("deploy")]),
		proposalId: id("changeProposal"),
		proposalDigest: digest,
		sealId: id("episodeSeal"),
		sealDigest: digest,
		requestDigest: digest,
	}),
	"human_gate.decided": exact({
		humanGateId: id("humanGate"),
		requestId: id("command"),
		proposalId: id("changeProposal"),
		proposalDigest: digest,
		action: Type.Union([Type.Literal("merge"), Type.Literal("deploy")]),
		decision: Type.Union([Type.Literal("approved"), Type.Literal("denied")]),
		decisionAuthority: Type.Union([Type.Literal("human"), Type.Literal("organization")]),
		decidedBy: id("principal"),
		receiptId: id("receipt"),
		decisionReasonDigest: digest,
		receiptDigest: digest,
	}),
	"command.claimed": exact({
		commandId: id("command"),
		commandType: controlPlaneCommandType,
		idempotencyKey: IdempotencyKeySchema,
		requestDigest: digest,
		requestedBy: id("principal"),
		runtimeId: id("runtime"),
		runtimeGeneration: positiveInteger,
		domain: commandDomain,
		subjectSessionId: Type.Optional(id("session")),
		domainExpectedRevision: Type.Union([expectedRevision, Type.Null()]),
	}),
	"command.applied": exact({
		claim: commandClaimRef,
		runtimeId: id("runtime"),
		runtimeGeneration: positiveInteger,
		appliedCursor: eventCursor,
		result: commandEffect,
		resultDigest: digest,
		effect: Type.Literal("committed"),
	}),
	"command.rejected": exact({
		claim: commandClaimRef,
		runtimeId: id("runtime"),
		runtimeGeneration: positiveInteger,
		code: token,
		error: commandError,
		reasonDigest: digest,
		retryable: Type.Boolean(),
		effect: Type.Literal("none"),
	}),
	"command.reconciliation_required": exact({
		claim: commandClaimRef,
		runtimeId: id("runtime"),
		runtimeGeneration: positiveInteger,
		effect: Type.Literal("uncertain"),
		reconciliationReceiptId: id("receipt"),
		reconciliationDigest: digest,
	}),
	"runtime.replacement_prepared": exact({
		replacementId: id("command"),
		idempotencyKey: IdempotencyKeySchema,
		previousRuntimeId: Type.Optional(id("runtime")),
		previousGeneration: revision,
		candidateRuntimeId: id("runtime"),
		candidateGeneration: positiveInteger,
		compositionReceiptId: id("compositionReceipt"),
		compositionDigest: digest,
		fencingIntentDigest: digest,
	}),
	"runtime.generation_activated": exact({
		replacementId: id("command"),
		activeRuntimeId: id("runtime"),
		activeGeneration: positiveInteger,
		compositionReceiptId: id("compositionReceipt"),
		compositionDigest: digest,
		fencingReceiptId: id("receipt"),
		fencingReceiptDigest: digest,
	}),
	"runtime.replacement_failed": exact({
		replacementId: id("command"),
		candidateRuntimeId: id("runtime"),
		candidateGeneration: positiveInteger,
		error: errorRef,
		outcomeCertain: Type.Boolean(),
	}),
	"daemon.shutdown_requested": exact({
		claim: commandClaimRef,
		idempotencyKey: IdempotencyKeySchema,
		runtimeId: brandedId("runtime"),
		runtimeGeneration: positiveInteger,
		reasonDigest: digest,
		drainDeadline: timestamp,
	}),
	"daemon.shutdown_completed": exact({
		request: shutdownRequestRef,
		runtimeId: brandedId("runtime"),
		runtimeGeneration: positiveInteger,
		drainDeadline: timestamp,
		outcome: Type.Union([Type.Literal("drained"), Type.Literal("recovery_required")]),
		shutdownReceiptId: brandedId("receipt"),
		shutdownReceiptDigest: digest,
		outcomeCertain: Type.Literal(true),
	}),
	"daemon.shutdown_failed": Type.Union([
		exact({
			...shutdownFailureBase,
			outcomeCertain: Type.Literal(true),
			effect: Type.Literal("none"),
		}),
		exact({
			...shutdownFailureBase,
			outcomeCertain: Type.Literal(false),
			effect: Type.Literal("uncertain"),
		}),
	]),
	"policy.effective_recorded": exact({
		policyId: id("resource"),
		policyRevision: positiveInteger,
		policyDigest: digest,
		sourceReceiptId: id("receipt"),
		sourceReceiptDigest: digest,
		effectiveAt: timestamp,
	}),
	"policy.normalization_recorded": exact({
		policyId: id("resource"),
		policyRevision: positiveInteger,
		inputDigest: digest,
		normalizedDigest: digest,
		normalizerVersion: token,
		receiptId: id("receipt"),
		receiptDigest: digest,
	}),
	"cost.recorded": exact({
		costId: id("receipt"),
		operationId: id("command"),
		idempotencyKey: id("command"),
		dimension: token,
		amount: nonNegativeNumber,
		unit: token,
		sourceReceiptId: id("receipt"),
		sourceReceiptDigest: digest,
		expectedRevision,
	}),
	"cost.reconciled": exact({
		costId: id("receipt"),
		operationId: id("command"),
		recordedAmount: nonNegativeNumber,
		actualAmount: nonNegativeNumber,
		unit: token,
		reconciliationReceiptId: id("receipt"),
		reconciliationDigest: digest,
		expectedRevision,
	}),
	"telemetry.delivery_recorded": exact({
		deliveryId: id("receipt"),
		exporterId: id("resource"),
		batchDigest: digest,
		fromSequence: revision,
		throughSequence: revision,
		outcome: Type.Union([
			Type.Literal("delivered"),
			Type.Literal("retry_scheduled"),
			Type.Literal("failed"),
			Type.Literal("dropped_by_policy"),
		]),
		attempt: positiveInteger,
		receiptDigest: digest,
	}),
	"finding.transitioned": exact({ findingId: id("finding"), from: token, to: token, evidenceArtifactId: Type.Optional(id("artifact")), expectedRevision }),
	"agent.root_registered": exact({
		...agentCommandBase,
		node: agentNode,
	}),
	"agent.root_revalidated": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		workspaceReceipt: agentWorkspaceReceipt,
		capabilityGrant: agentParentGrant,
	}),
	"agent.spawn_requested": exact({
		...agentCommandBase,
		intent: agentSpawnIntent,
	}),
	"agent.spawned": exact({
		...agentCommandBase,
		intentRequestId: brandedId("command"),
		node: agentNode,
		edge: agentGraphEdge,
	}),
	"agent.spawn_failed": exact({
		...agentCommandBase,
		intentRequestId: brandedId("command"),
		agentId: brandedId("agent"),
		error: agentFailure,
	}),
	"agent.transitioned": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
		to: Type.Union([Type.Literal("starting"), Type.Literal("running")]),
		reason: Type.Optional(agentStateReason),
	}),
	"agent.paused": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
		reason: agentStateReason,
	}),
	"agent.stopped": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
		reason: agentStateReason,
	}),
	"agent.partial_committed": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
		reason: agentStateReason,
	}),
	"agent.cursor_advanced": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		cursor: agentEventCursor,
	}),
	"agent.artifact_reported": exact({
		...agentCommandBase,
		report: agentArtifactReport,
	}),
	"agent.residency_changed": exact({
		...agentCommandBase,
		receipt: agentResidencyReceipt,
	}),
	"agent.budget_rebound": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		previousReservationId: brandedId("budgetReservation"),
		reservation: agentBudgetReservation,
	}),
	"agent.turn_recorded": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		turnId: brandedId("turn"),
		turnNumber: positiveInteger,
	}),
	"agent.launch_recorded": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		launchReceipt: agentLaunchReceipt,
		residencyReceipt: agentResidencyReceipt,
	}),
	"agent.resume_revalidated": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		delegationReceipt: agentDelegationReceipt,
		workspaceReceipt: agentWorkspaceReceipt,
		denialReceipt: agentDenialReceipt,
	}),
	"agent.handoff_requested": exact({
		...agentCommandBase,
		handoff: agentHandoffManifest,
	}),
	"agent.handoff_committed": exact({
		...agentCommandBase,
		handoff: agentHandoffManifest,
	}),
	"agent.handoff_failed": exact({
		...agentCommandBase,
		handoffId: brandedId("command"),
		agentId: brandedId("agent"),
		error: agentFailure,
	}),
	"agent.merge_requested": exact({
		...agentCommandBase,
		request: agentMergeRequest,
	}),
	"agent.merge_committed": exact({
		...agentCommandBase,
		receipt: agentMergeReceipt,
	}),
	"agent.merge_conflicted": exact({
		...agentCommandBase,
		receipt: agentMergeReceipt,
	}),
	"agent.merge_failed": exact({
		...agentCommandBase,
		parentAgentId: brandedId("agent"),
		childAgentId: brandedId("agent"),
		error: agentFailure,
	}),
	"agent.finished": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
	}),
	"agent.failed": exact({
		...agentCommandBase,
		agentId: brandedId("agent"),
		from: agentState,
		reason: agentStateReason,
		error: agentFailure,
	}),
	"lease.acquired": LeaseAcquiredPayloadSchema,
	"lease.taken_over": LeaseTakenOverPayloadSchema,
	"lease.released": LeaseReleasedPayloadSchema,
} as const satisfies Record<RuntimeEventType, TSchema>;

export type RuntimeEventPayloadMap = {
	[TType in RuntimeEventType]: Static<(typeof RUNTIME_EVENT_PAYLOAD_SCHEMAS)[TType]>;
};

export function runtimeEventPayloadSchema<TType extends RuntimeEventType>(
	type: TType,
): (typeof RUNTIME_EVENT_PAYLOAD_SCHEMAS)[TType] {
	return RUNTIME_EVENT_PAYLOAD_SCHEMAS[type];
}

export const RUNTIME_EVENT_PAYLOAD_SCHEMA_COUNT = Object.keys(RUNTIME_EVENT_PAYLOAD_SCHEMAS).length;

// 保留一个显式引用，防止未来 helper 放宽为 Type.Unknown/Record。
export const RUNTIME_EVENT_REFERENCE_SCHEMA = exact({ id: anyId, digest });
