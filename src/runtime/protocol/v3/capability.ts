/**
 * Capability、approval 与 sandbox 的 Runtime 中立合同。
 *
 * 本模块只定义可验证的数据、绑定规则和 opaque adapter ports。策略合并、审批
 * prompt/store、shell 分类、credential 注入和 sandbox backend 执行属于安全专项。
 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "./canonical-json.ts";
import { EventCursorSchema } from "./event-references.ts";
import type { EventCursor } from "./events.ts";
import { createEventStreamId } from "./ids.ts";
import type {
	ApprovalId,
	ArtifactId,
	AuthorityId,
	CommandId,
	PrincipalId,
	RateLimitId,
	ReceiptId,
	ResourceId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	ToolCallId,
	TurnId,
	WorkspaceId,
} from "./ids.ts";
import {
	DeclassificationReceiptRefSchema,
	InputSourceRefSchema,
	TaintSinkSchema,
	inputSourcesAllowedAtSink,
	type DeclassificationReceiptRef,
	type InputSourceRef,
	type TaintSink,
} from "./taint.ts";
import { WorkspaceExecutionEnvelopeSchema, type WorkspaceExecutionEnvelope } from "./workspace.ts";

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 128 });
const nonce = Type.String({ pattern: "^[A-Za-z0-9._~-]+$", minLength: 16, maxLength: 128 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const approvalDecisionRevision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const CAPABILITY_NAMES = [
	"repository_read",
	"workspace_write",
	"dependency_install",
	"network",
	"process",
	"credential",
	"browser",
	"deploy",
	"cross_workspace",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const CAPABILITY_RESOURCE_KINDS = [
	"filesystem",
	"network",
	"process",
	"credential",
	"workspace",
	"native_tool",
	"browser_tool",
	"instruction",
] as const;
export type CapabilityResourceKind = (typeof CAPABILITY_RESOURCE_KINDS)[number];

/** Browser 权限必须逐能力绑定，不能用一个 browser digest 隐式放行全部表面。 */
export interface BrowserCapabilityConstraints {
	navigateOriginDigest: string;
	domReadScopeDigest: string;
	scriptPolicyDigest: string;
	downloadScopeDigest: string;
	uploadScopeDigest: string;
	cookieCredentialScopeDigest: string;
	networkEgressScopeDigest: string;
}

export const CAPABILITY_DECISIONS = ["allow", "ask", "deny"] as const;
export type CapabilityDecision = (typeof CAPABILITY_DECISIONS)[number];

export const APPROVAL_SCOPES = ["once", "session", "project"] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export const APPROVAL_RECEIPT_DECISIONS = [
	"allowed",
	"denied",
	"cancelled",
	"follow_up_replaced",
	"channel_failed",
	"transferred_to_human",
	"expired",
	"revoked",
] as const;
export type ApprovalReceiptDecision = (typeof APPROVAL_RECEIPT_DECISIONS)[number];

export const SANDBOX_PROFILE_NAMES = ["off", "read-only", "workspace-write", "strict", "external"] as const;
export type SandboxProfileName = (typeof SANDBOX_PROFILE_NAMES)[number];

export const SANDBOX_EFFECTIVE_ENFORCEMENTS = ["enforced", "degraded", "unavailable", "off"] as const;
export type SandboxEffectiveEnforcement = (typeof SANDBOX_EFFECTIVE_ENFORCEMENTS)[number];

export const ARTIFACT_KINDS = [
	"diff",
	"tool_output",
	"log",
	"test_report",
	"screenshot",
	"dom_snapshot",
	"console_log",
	"network_trace",
	"episode_manifest",
	"change_proposal",
	"session_report",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_REDACTION_CLASSES = ["metadata_only", "redacted", "encrypted_forensic"] as const;
export type ArtifactRedactionClass = (typeof ARTIFACT_REDACTION_CLASSES)[number];

export const CAPABILITY_AUTH_CHANNELS = ["local_process", "local_socket", "signed_remote"] as const;
export type CapabilityAuthChannel = (typeof CAPABILITY_AUTH_CHANNELS)[number];
export const CAPABILITY_GATEWAY_SCHEMA_VERSION = 2 as const;

export const RATE_LIMIT_OPERATIONS = ["reserve", "commit", "refund"] as const;
export type RateLimitOperation = (typeof RATE_LIMIT_OPERATIONS)[number];

export const RATE_LIMIT_OUTCOMES = ["reserved", "committed", "refunded", "rejected"] as const;
export type RateLimitOutcome = (typeof RATE_LIMIT_OUTCOMES)[number];

export const AUTHORIZATION_SERVER_SCOPES = [
	"daemon_api",
	"extension_server",
	"tool_server",
	"verification_runner",
	"remote_executor",
] as const;
export type AuthorizationServerScope = (typeof AUTHORIZATION_SERVER_SCOPES)[number];

export interface AuthorizationContext {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
}

export interface CapabilityEventCursorScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
}

/**
 * 受信 composition root 提供当前 session head。undefined 表示 session 尚未初始化；
 * adapter 抛错表示 authority 当前不可用。
 */
export interface CapabilityEventCursorAuthorityPort {
	current(scope: CapabilityEventCursorScope): Promise<EventCursor | undefined>;
}

interface CapabilityClaimBase {
	authorityId: AuthorityId;
	tenantId: TenantId;
	name: CapabilityName;
	resourceDigest: string;
	constraintsDigest: string;
}

export type CapabilityClaim =
	| (CapabilityClaimBase & {
			resourceKind: Exclude<CapabilityResourceKind, "browser_tool">;
	  })
	| (CapabilityClaimBase & {
			resourceKind: "browser_tool";
			browserConstraints: BrowserCapabilityConstraints;
	  });

export interface CapabilityRequestRef extends AuthorizationContext {
	requestId: CommandId;
	approvalId: ApprovalId;
	sessionId: SessionId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	turnId: TurnId;
	toolCallId: ToolCallId;
	capability: CapabilityName;
	argumentsDigest: string;
	workspaceEnvelopeDigest: string;
	policyDigest: string;
	serverScope: AuthorizationServerScope;
	resourceScopeDigest: string;
	commandScopeDigest: string;
}

interface CapabilityRequestAuthenticationBase {
	channelBindingDigest: string;
	requestDigest: string;
	nonce: string;
	issuedAt: string;
	expiresAt: string;
	keyRevision: number;
}

export type CapabilityRequestAuthentication =
	| (CapabilityRequestAuthenticationBase & {
			channel: "local_process" | "local_socket";
			eventCursor: EventCursor;
	  })
	| (CapabilityRequestAuthenticationBase & {
			channel: "signed_remote";
			signingKeyId: ResourceId;
			signatureDigest: string;
	  });

export interface ApprovalTicket extends AuthorizationContext {
	approvalId: ApprovalId;
	request: CapabilityRequestRef;
	scope: ApprovalScope;
	createdAt: string;
	expiresAt?: string;
}

/** receipt 同时绑定 approval、request canonical digest 与 ticket canonical digest。 */
export interface ApprovalReceiptRef extends AuthorizationContext {
	receiptId: ReceiptId;
	approvalId: ApprovalId;
	requestId: CommandId;
	requestDigest: string;
	ticketDigest: string;
	decision: ApprovalReceiptDecision;
	decisionRevision: number;
	/** 作出当前 terminal decision 的 principal；不能用被授权主体 principalId 代替。 */
	decidedBy: PrincipalId;
	decidedAt: string;
	expiresAt?: string;
	revokedAt?: string;
	receiptDigest: string;
	evidenceComplete: boolean;
	evidenceTruncated: boolean;
	originalInputDigest: string;
	originalArtifactId?: ArtifactId;
	originalArtifactDigest?: string;
}

export interface CredentialGrantRef extends AuthorizationContext {
	grantId: ReceiptId;
	credentialKind: string;
	audienceDigest: string;
	scopeDigest: string;
	serverScope: AuthorizationServerScope;
	resourceScopeDigest: string;
	commandScopeDigest: string;
	expiresAt: string;
	receiptDigest: string;
}

/** requested 仅表达调用者意图；它不声称 profile 已被解析或强制执行。 */
export interface SandboxProfileRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	profileId: ResourceId;
	requested: SandboxProfileName;
	policyDigest: string;
}

/**
 * resolved 与 effectiveEnforcement 分离，避免把软件策略解析结果误报为 OS 强制。
 * degraded/unavailable 必须携带 reasonDigest，事件中不保存原始 backend 错误文本。
 */
export interface SandboxExecutionReceiptRef extends AuthorizationContext {
	receiptId: ReceiptId;
	requestId: CommandId;
	profileId: ResourceId;
	requested: SandboxProfileName;
	resolved: SandboxProfileName;
	policyDigest: string;
	backendId: string;
	effectiveEnforcement: SandboxEffectiveEnforcement;
	invocationDigest: string;
	reasonDigest?: string;
}

/** rawArguments 只在注入的 Gateway port 内流转，不允许进入 Runtime security event payload。 */
export interface ToolInvocationRequest {
	requestId: CommandId;
	toolManifestDigest: string;
	rawArguments: unknown;
	envelope: WorkspaceExecutionEnvelope;
	requestedClaims: readonly CapabilityClaim[];
}

const authorizationContextProperties = {
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
} as const;

export const CapabilityNameSchema = Type.Union(CAPABILITY_NAMES.map((name) => Type.Literal(name)));
export const CapabilityResourceKindSchema = Type.Union(
	CAPABILITY_RESOURCE_KINDS.map((kind) => Type.Literal(kind)),
);
export const CapabilityDecisionSchema = Type.Union(CAPABILITY_DECISIONS.map((decision) => Type.Literal(decision)));
export const CapabilityAuthChannelSchema = Type.Union(
	CAPABILITY_AUTH_CHANNELS.map((channel) => Type.Literal(channel)),
);
export const RateLimitOperationSchema = Type.Union(
	RATE_LIMIT_OPERATIONS.map((operation) => Type.Literal(operation)),
);
export const RateLimitOutcomeSchema = Type.Union(RATE_LIMIT_OUTCOMES.map((outcome) => Type.Literal(outcome)));
export const AuthorizationServerScopeSchema = Type.Union(
	AUTHORIZATION_SERVER_SCOPES.map((scope) => Type.Literal(scope)),
);
export const ApprovalScopeSchema = Type.Union(APPROVAL_SCOPES.map((scope) => Type.Literal(scope)));
export const SandboxProfileNameSchema = Type.Union(SANDBOX_PROFILE_NAMES.map((profile) => Type.Literal(profile)));
export const SandboxEffectiveEnforcementSchema = Type.Union(
	SANDBOX_EFFECTIVE_ENFORCEMENTS.map((enforcement) => Type.Literal(enforcement)),
);

export const AuthorizationContextSchema = exact(authorizationContextProperties);

const capabilityClaimBaseProperties = {
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	name: CapabilityNameSchema,
	resourceDigest: digest,
	constraintsDigest: digest,
} as const;

export const BrowserCapabilityConstraintsSchema = exact({
	navigateOriginDigest: digest,
	domReadScopeDigest: digest,
	scriptPolicyDigest: digest,
	downloadScopeDigest: digest,
	uploadScopeDigest: digest,
	cookieCredentialScopeDigest: digest,
	networkEgressScopeDigest: digest,
});

export const CapabilityClaimSchema = Type.Union([
	exact({
		...capabilityClaimBaseProperties,
		resourceKind: Type.Union(
			CAPABILITY_RESOURCE_KINDS.filter((kind) => kind !== "browser_tool").map((kind) => Type.Literal(kind)),
		),
	}),
	exact({
		...capabilityClaimBaseProperties,
		resourceKind: Type.Literal("browser_tool"),
		browserConstraints: BrowserCapabilityConstraintsSchema,
	}),
]);

export const CapabilityRequestRefSchema = exact({
	...authorizationContextProperties,
	requestId: runtimeId("command"),
	approvalId: runtimeId("approval"),
	sessionId: runtimeId("session"),
	runtimeId: runtimeId("runtime"),
	runtimeGeneration: revision,
	turnId: runtimeId("turn"),
	toolCallId: runtimeId("toolCall"),
	capability: CapabilityNameSchema,
	argumentsDigest: digest,
	workspaceEnvelopeDigest: digest,
	policyDigest: digest,
	serverScope: AuthorizationServerScopeSchema,
	resourceScopeDigest: digest,
	commandScopeDigest: digest,
});

const capabilityRequestAuthenticationBase = {
	channelBindingDigest: digest,
	requestDigest: digest,
	nonce,
	issuedAt: timestamp,
	expiresAt: timestamp,
	keyRevision: revision,
} as const;

export const CapabilityRequestAuthenticationSchema = Type.Union([
	exact({
		...capabilityRequestAuthenticationBase,
		channel: Type.Literal("local_process"),
		eventCursor: EventCursorSchema,
	}),
	exact({
		...capabilityRequestAuthenticationBase,
		channel: Type.Literal("local_socket"),
		eventCursor: EventCursorSchema,
	}),
	exact({
		...capabilityRequestAuthenticationBase,
		channel: Type.Literal("signed_remote"),
		signingKeyId: runtimeId("resource"),
		signatureDigest: digest,
	}),
]);

export const ApprovalTicketSchema = exact({
	...authorizationContextProperties,
	approvalId: runtimeId("approval"),
	request: CapabilityRequestRefSchema,
	scope: ApprovalScopeSchema,
	createdAt: timestamp,
	expiresAt: Type.Optional(timestamp),
});

const approvalReceiptBaseProperties = {
	...authorizationContextProperties,
	receiptId: runtimeId("receipt"),
	approvalId: runtimeId("approval"),
	requestId: runtimeId("command"),
	requestDigest: digest,
	ticketDigest: digest,
	decisionRevision: approvalDecisionRevision,
	decidedBy: runtimeId("principal"),
	decidedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
	receiptDigest: digest,
	evidenceComplete: Type.Boolean(),
	evidenceTruncated: Type.Boolean(),
	originalInputDigest: digest,
	originalArtifactId: Type.Optional(runtimeId("artifact")),
	originalArtifactDigest: Type.Optional(digest),
} as const;

export const ApprovalReceiptRefSchema = Type.Union([
	exact({
		...approvalReceiptBaseProperties,
		decision: Type.Literal("allowed"),
		evidenceComplete: Type.Literal(true),
		evidenceTruncated: Type.Literal(false),
	}),
	exact({ ...approvalReceiptBaseProperties, decision: Type.Literal("denied") }),
	exact({ ...approvalReceiptBaseProperties, decision: Type.Literal("cancelled") }),
	exact({ ...approvalReceiptBaseProperties, decision: Type.Literal("follow_up_replaced") }),
	exact({ ...approvalReceiptBaseProperties, decision: Type.Literal("channel_failed") }),
	exact({ ...approvalReceiptBaseProperties, decision: Type.Literal("transferred_to_human") }),
	exact({
		...approvalReceiptBaseProperties,
		decision: Type.Literal("expired"),
		expiresAt: timestamp,
	}),
	exact({
		...approvalReceiptBaseProperties,
		decision: Type.Literal("revoked"),
		expiresAt: Type.Optional(timestamp),
		revokedAt: timestamp,
	}),
]);

export const CredentialGrantRefSchema = exact({
	...authorizationContextProperties,
	grantId: runtimeId("receipt"),
	credentialKind: token,
	audienceDigest: digest,
	scopeDigest: digest,
	serverScope: AuthorizationServerScopeSchema,
	resourceScopeDigest: digest,
	commandScopeDigest: digest,
	expiresAt: timestamp,
	receiptDigest: digest,
});

export const SandboxProfileRefSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	profileId: runtimeId("resource"),
	requested: SandboxProfileNameSchema,
	policyDigest: digest,
});

const sandboxReceiptBaseProperties = {
	...authorizationContextProperties,
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	profileId: runtimeId("resource"),
	requested: SandboxProfileNameSchema,
	resolved: SandboxProfileNameSchema,
	policyDigest: digest,
	backendId: token,
	invocationDigest: digest,
} as const;

export const SandboxExecutionReceiptRefSchema = Type.Union([
	exact({
		...sandboxReceiptBaseProperties,
		effectiveEnforcement: Type.Literal("enforced"),
	}),
	exact({
		...sandboxReceiptBaseProperties,
		effectiveEnforcement: Type.Literal("off"),
	}),
	exact({
		...sandboxReceiptBaseProperties,
		effectiveEnforcement: Type.Literal("degraded"),
		reasonDigest: digest,
	}),
	exact({
		...sandboxReceiptBaseProperties,
		effectiveEnforcement: Type.Literal("unavailable"),
		reasonDigest: digest,
	}),
]);

/** ArtifactRef 的唯一 exact schema；各领域模块必须复用，避免新增 kind 后局部拒绝。 */
export const ArtifactRefSchema = Type.Unsafe<ArtifactRef>(exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	artifactId: runtimeId("artifact"),
	storedDigest: digest,
	kind: Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind))),
	originalSize: revision,
	storedSize: revision,
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	redaction: Type.Union(ARTIFACT_REDACTION_CLASSES.map((entry) => Type.Literal(entry))),
	transformReceipt: runtimeId("receipt"),
	workspaceId: Type.Optional(runtimeId("workspace")),
}));

export const ToolInvocationRequestSchema = exact({
	requestId: runtimeId("command"),
	toolManifestDigest: digest,
	rawArguments: Type.Unknown(),
	envelope: WorkspaceExecutionEnvelopeSchema,
	requestedClaims: Type.Array(CapabilityClaimSchema, { maxItems: 64 }),
});

export function isCapabilityClaim(value: unknown): value is CapabilityClaim {
	return Check(CapabilityClaimSchema, value);
}

export function isCapabilityRequestRef(value: unknown): value is CapabilityRequestRef {
	return Check(CapabilityRequestRefSchema, value);
}

export function capabilityGatewayRequestDigest(request: CapabilityGatewayRequestBody): string {
	return canonicalDigest(request);
}

export function isCapabilityRequestAuthentication(value: unknown): value is CapabilityRequestAuthentication {
	if (!Check(CapabilityRequestAuthenticationSchema, value)) return false;
	const authentication = value as CapabilityRequestAuthentication;
	return Date.parse(authentication.expiresAt) > Date.parse(authentication.issuedAt);
}

export function isCapabilityGatewayRequest(value: unknown): value is CapabilityGatewayRequest {
	if (!Check(CapabilityGatewayRequestSchema, value)) return false;
	const gatewayRequest = value as unknown as CapabilityGatewayRequest;
	if (
		gatewayRequest.request.requestId !== gatewayRequest.invocation.requestId ||
		gatewayRequest.request.authorityId !== gatewayRequest.invocation.envelope.authorityId ||
		gatewayRequest.request.tenantId !== gatewayRequest.invocation.envelope.tenantId ||
			gatewayRequest.request.principalId !== gatewayRequest.invocation.envelope.principalId ||
			gatewayRequest.request.sessionId !== gatewayRequest.invocation.envelope.sessionId ||
			gatewayRequest.request.runtimeId !== gatewayRequest.invocation.envelope.ownerRuntimeId ||
			gatewayRequest.request.runtimeGeneration !== gatewayRequest.invocation.envelope.leaseRevision ||
			gatewayRequest.request.toolCallId !== gatewayRequest.invocation.envelope.toolCallId ||
		gatewayRequest.inputSources.some(
			(source) =>
				source.authorityId !== gatewayRequest.request.authorityId ||
				source.tenantId !== gatewayRequest.request.tenantId,
		) ||
		gatewayRequest.declassificationReceipts.some(
			(receipt) =>
				receipt.authorityId !== gatewayRequest.request.authorityId ||
				receipt.tenantId !== gatewayRequest.request.tenantId,
		)
	) return false;
	const { authentication: _authentication, ...body } = gatewayRequest;
	const authentication = gatewayRequest.authentication;
	if (
		authentication.channel !== "signed_remote" &&
		(
			authentication.eventCursor.stream.scope !== "session" ||
			authentication.eventCursor.stream.sessionId !== gatewayRequest.request.sessionId ||
			authentication.eventCursor.stream.streamId !== createEventStreamId(
				{
					authorityId: gatewayRequest.request.authorityId,
					tenantId: gatewayRequest.request.tenantId,
				},
				gatewayRequest.request.sessionId,
			)
		)
	) return false;
	return (
		isCapabilityRequestAuthentication(authentication) &&
		authentication.requestDigest === capabilityGatewayRequestDigest(body)
	);
}

export type CapabilityGatewayRequestRejection =
	| "invalid_schema"
	| "not_yet_valid"
	| "expired"
	| "revoked_key"
	| "replayed_nonce"
	| "taint_not_declassified";

export interface CapabilityReplayClaim {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	channelBindingDigest: string;
	nonce: string;
	keyRevision: number;
	requestDigest: string;
	expiresAt: string;
}

export class CapabilityReplayGuard {
	readonly #claims = new Map<string, CapabilityReplayClaim>();

	public claim(request: CapabilityGatewayRequest, at: Date): boolean {
		this.prune(at);
		const auth = request.authentication;
		const key = [
			request.request.authorityId,
			request.request.tenantId,
			request.request.principalId,
			auth.channelBindingDigest,
			auth.keyRevision,
			auth.nonce,
		].join("/");
		if (this.#claims.has(key)) return false;
		this.#claims.set(key, {
			authorityId: request.request.authorityId,
			tenantId: request.request.tenantId,
			principalId: request.request.principalId,
			channelBindingDigest: auth.channelBindingDigest,
			nonce: auth.nonce,
			keyRevision: auth.keyRevision,
			requestDigest: auth.requestDigest,
			expiresAt: auth.expiresAt,
		});
		return true;
	}

	public prune(at: Date): void {
		for (const [key, claim] of this.#claims) {
			if (Date.parse(claim.expiresAt) <= at.getTime()) this.#claims.delete(key);
		}
	}
}

export interface ValidateCapabilityGatewayRequestOptions {
	at: Date;
	replayGuard?: CapabilityReplayGuard;
	revokedKeyRevisions?: ReadonlySet<number>;
}

export function validateCapabilityGatewayRequest(
	request: unknown,
	options: ValidateCapabilityGatewayRequestOptions,
): { ok: true; value: CapabilityGatewayRequest } | { ok: false; reason: CapabilityGatewayRequestRejection } {
	if (!isCapabilityGatewayRequest(request)) return { ok: false, reason: "invalid_schema" };
	const issuedAt = Date.parse(request.authentication.issuedAt);
	const expiresAt = Date.parse(request.authentication.expiresAt);
	if (issuedAt > options.at.getTime()) return { ok: false, reason: "not_yet_valid" };
	if (expiresAt <= options.at.getTime()) return { ok: false, reason: "expired" };
	if (options.revokedKeyRevisions?.has(request.authentication.keyRevision)) {
		return { ok: false, reason: "revoked_key" };
	}
	if (
		request.targetSink !== "context" &&
		!inputSourcesAllowedAtSink(
			request.inputSources,
			request.targetSink,
			request.declassificationReceipts,
			options.at,
		)
	) return { ok: false, reason: "taint_not_declassified" };
	if (options.replayGuard && !options.replayGuard.claim(request, options.at)) {
		return { ok: false, reason: "replayed_nonce" };
	}
	return { ok: true, value: request };
}

function rateLimitReceiptBody(
	receipt: GatewayRateLimitReceipt,
): Omit<GatewayRateLimitReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isGatewayRateLimitRequest(value: unknown): value is GatewayRateLimitRequest {
	if (!Check(GatewayRateLimitRequestSchema, value)) return false;
	const request = value as unknown as GatewayRateLimitRequest;
	if (Date.parse(request.windowExpiresAt) <= Date.parse(request.windowStartedAt)) return false;
	return request.operation === "reserve" ? request.reservationReceiptId === undefined : request.reservationReceiptId !== undefined;
}

export function isGatewayRateLimitReceipt(value: unknown): value is GatewayRateLimitReceipt {
	if (!Check(GatewayRateLimitReceiptSchema, value)) return false;
	const receipt = value as unknown as GatewayRateLimitReceipt;
	if (
		Date.parse(receipt.windowExpiresAt) <= Date.parse(receipt.windowStartedAt) ||
		Date.parse(receipt.issuedAt) < Date.parse(receipt.windowStartedAt) ||
		receipt.acceptedUnits > receipt.requestedUnits
	) return false;
	if (receipt.outcome === "rejected" && receipt.acceptedUnits !== 0) return false;
	return receipt.receiptDigest === canonicalDigest(rateLimitReceiptBody(receipt));
}

export function gatewayRateLimitReceiptMatchesRequest(
	receipt: GatewayRateLimitReceipt,
	request: GatewayRateLimitRequest,
): boolean {
	return (
		isGatewayRateLimitRequest(request) &&
		isGatewayRateLimitReceipt(receipt) &&
		receipt.authorityId === request.authorityId &&
		receipt.tenantId === request.tenantId &&
		receipt.principalId === request.principalId &&
		receipt.rateLimitId === request.rateLimitId &&
		receipt.requestId === request.requestId &&
		receipt.operation === request.operation &&
		receipt.capability === request.capability &&
		receipt.resourceDigest === request.resourceDigest &&
		receipt.windowStartedAt === request.windowStartedAt &&
		receipt.windowExpiresAt === request.windowExpiresAt &&
		receipt.requestedUnits === request.units
	);
}

export function isApprovalTicket(value: unknown): value is ApprovalTicket {
	if (!Check(ApprovalTicketSchema, value)) return false;
	return (
		value.authorityId === value.request.authorityId &&
		value.tenantId === value.request.tenantId &&
		value.principalId === value.request.principalId &&
		value.approvalId === value.request.approvalId
	);
}

function approvalReceiptBody(receipt: ApprovalReceiptRef): Omit<ApprovalReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isApprovalReceiptRef(value: unknown): value is ApprovalReceiptRef {
	if (!Check(ApprovalReceiptRefSchema, value)) return false;
	const receipt = value as ApprovalReceiptRef;
	const hasArtifactId = receipt.originalArtifactId !== undefined;
	const hasArtifactDigest = receipt.originalArtifactDigest !== undefined;
	if (hasArtifactId !== hasArtifactDigest) return false;
	if (receipt.evidenceTruncated && receipt.evidenceComplete) return false;
	if (receipt.receiptDigest !== canonicalDigest(approvalReceiptBody(receipt))) return false;
	return receipt.decision !== "allowed" || (receipt.evidenceComplete && !receipt.evidenceTruncated);
}

export function isSandboxExecutionReceiptRef(value: unknown): value is SandboxExecutionReceiptRef {
	return Check(SandboxExecutionReceiptRefSchema, value);
}

export function isToolInvocationRequest(value: unknown): value is ToolInvocationRequest {
	if (!Check(ToolInvocationRequestSchema, value)) return false;
	return value.requestedClaims.every(
		(claim) =>
			claim.authorityId === value.envelope.authorityId &&
			claim.tenantId === value.envelope.tenantId,
	);
}

export function approvalTicketRequestDigest(ticket: ApprovalTicket): string {
	return canonicalDigest(ticket.request);
}

export function approvalTicketDigest(ticket: ApprovalTicket): string {
	return canonicalDigest(ticket);
}

/** 校验 receipt 的 scope、request、ticket、expiry 与 revocation 时间绑定。 */
export function approvalReceiptMatchesTicket(receipt: ApprovalReceiptRef, ticket: ApprovalTicket): boolean {
	if (!isApprovalTicket(ticket) || !isApprovalReceiptRef(receipt)) return false;
	if (
		receipt.authorityId !== ticket.authorityId ||
		receipt.tenantId !== ticket.tenantId ||
		receipt.principalId !== ticket.principalId ||
		receipt.approvalId !== ticket.approvalId ||
		receipt.requestId !== ticket.request.requestId ||
		receipt.requestDigest !== approvalTicketRequestDigest(ticket) ||
		receipt.ticketDigest !== approvalTicketDigest(ticket) ||
		receipt.originalInputDigest !== ticket.request.argumentsDigest ||
		receipt.expiresAt !== ticket.expiresAt
	) {
		return false;
	}
	const decidedAt = Date.parse(receipt.decidedAt);
	const createdAt = Date.parse(ticket.createdAt);
	if (decidedAt < createdAt) return false;
	if (receipt.decision === "expired") {
		return ticket.expiresAt !== undefined && decidedAt >= Date.parse(ticket.expiresAt);
	}
	if (receipt.decision === "revoked") {
		return receipt.revokedAt !== undefined && Date.parse(receipt.revokedAt) >= decidedAt;
	}
	return true;
}

export function isApprovalTicketExpired(ticket: ApprovalTicket, at: Date): boolean {
	return isApprovalTicket(ticket) && ticket.expiresAt !== undefined && Date.parse(ticket.expiresAt) <= at.getTime();
}

export interface SecurityPortCancelRequest extends AuthorizationContext {
	requestId: CommandId;
	reasonDigest: string;
}

export interface SecurityPortCancelResult extends AuthorizationContext {
	requestId: CommandId;
	status: "accepted" | "already_terminal" | "not_found";
	receiptId?: ReceiptId;
}

export interface CapabilityGatewayRequestBody {
	schemaVersion: typeof CAPABILITY_GATEWAY_SCHEMA_VERSION;
	request: CapabilityRequestRef;
	invocation: ToolInvocationRequest;
	idempotencyKey: CommandId;
	inputSources: readonly InputSourceRef[];
	targetSink: TaintSink;
	declassificationReceipts: readonly DeclassificationReceiptRef[];
}

export interface CapabilityGatewayRequest extends CapabilityGatewayRequestBody {
	authentication: CapabilityRequestAuthentication;
}

export interface GatewayRateLimitRequest extends AuthorizationContext {
	rateLimitId: RateLimitId;
	requestId: CommandId;
	operation: RateLimitOperation;
	capability: CapabilityName;
	resourceDigest: string;
	windowStartedAt: string;
	windowExpiresAt: string;
	units: number;
	reservationReceiptId?: ReceiptId;
	idempotencyKey: CommandId;
}

export interface GatewayRateLimitReceipt extends AuthorizationContext {
	receiptId: ReceiptId;
	rateLimitId: RateLimitId;
	requestId: CommandId;
	operation: RateLimitOperation;
	outcome: RateLimitOutcome;
	capability: CapabilityName;
	resourceDigest: string;
	windowStartedAt: string;
	windowExpiresAt: string;
	requestedUnits: number;
	acceptedUnits: number;
	remainingUnits: number;
	policyDigest: string;
	issuedAt: string;
	receiptDigest: string;
}

export type CapabilityGatewayResult =
	| {
			requestId: CommandId;
			decision: "allow";
			decisionDigest: string;
			approvalReceipt?: ApprovalReceiptRef;
			sandboxProfile: SandboxProfileRef;
	  }
	| {
			requestId: CommandId;
			decision: "ask";
			decisionDigest: string;
			approvalTicket: ApprovalTicket;
	  }
	| {
			requestId: CommandId;
			decision: "deny";
			decisionDigest: string;
			approvalReceipt: ApprovalReceiptRef;
	  };

export interface ApprovalCoordinatorRequest {
	ticket: ApprovalTicket;
	expectedDecisionRevision: number;
	idempotencyKey: CommandId;
}

export interface ApprovalCoordinatorResult {
	approvalId: ApprovalId;
	ticketDigest: string;
	receipt: ApprovalReceiptRef;
}

export interface SandboxExecutorRequest extends AuthorizationContext {
	requestId: CommandId;
	profile: SandboxProfileRef;
	invocationDigest: string;
	resolutionDigest: string;
	idempotencyKey: CommandId;
	opaqueInvocation: unknown;
}

export interface SandboxExecutorResult extends AuthorizationContext {
	requestId: CommandId;
	resolutionReceiptId: ReceiptId;
	executionReceipt: SandboxExecutionReceiptRef;
}

export const SecurityPortCancelRequestSchema = exact({
	...authorizationContextProperties,
	requestId: runtimeId("command"),
	reasonDigest: digest,
});

export const SecurityPortCancelResultSchema = Type.Union([
	exact({
		...authorizationContextProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("accepted"),
		receiptId: runtimeId("receipt"),
	}),
	exact({
		...authorizationContextProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("already_terminal"),
		receiptId: Type.Optional(runtimeId("receipt")),
	}),
	exact({
		...authorizationContextProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("not_found"),
	}),
]);

export const CapabilityGatewayRequestBodySchema = exact({
	schemaVersion: Type.Literal(CAPABILITY_GATEWAY_SCHEMA_VERSION),
	request: CapabilityRequestRefSchema,
	invocation: ToolInvocationRequestSchema,
	idempotencyKey: runtimeId("command"),
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	targetSink: TaintSinkSchema,
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
});

export const CapabilityGatewayRequestSchema = exact({
	...CapabilityGatewayRequestBodySchema.properties,
	authentication: CapabilityRequestAuthenticationSchema,
});

export const GatewayRateLimitRequestSchema = exact({
	...authorizationContextProperties,
	rateLimitId: runtimeId("rateLimit"),
	requestId: runtimeId("command"),
	operation: RateLimitOperationSchema,
	capability: CapabilityNameSchema,
	resourceDigest: digest,
	windowStartedAt: timestamp,
	windowExpiresAt: timestamp,
	units: Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	reservationReceiptId: Type.Optional(runtimeId("receipt")),
	idempotencyKey: runtimeId("command"),
});

export const GatewayRateLimitReceiptSchema = exact({
	...authorizationContextProperties,
	receiptId: runtimeId("receipt"),
	rateLimitId: runtimeId("rateLimit"),
	requestId: runtimeId("command"),
	operation: RateLimitOperationSchema,
	outcome: RateLimitOutcomeSchema,
	capability: CapabilityNameSchema,
	resourceDigest: digest,
	windowStartedAt: timestamp,
	windowExpiresAt: timestamp,
	requestedUnits: Type.Number({ exclusiveMinimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	acceptedUnits: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	remainingUnits: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	policyDigest: digest,
	issuedAt: timestamp,
	receiptDigest: digest,
});

export const CapabilityGatewayResultSchema = Type.Union([
	exact({
		requestId: runtimeId("command"),
		decision: Type.Literal("allow"),
		decisionDigest: digest,
		approvalReceipt: Type.Optional(ApprovalReceiptRefSchema),
		sandboxProfile: SandboxProfileRefSchema,
	}),
	exact({
		requestId: runtimeId("command"),
		decision: Type.Literal("ask"),
		decisionDigest: digest,
		approvalTicket: ApprovalTicketSchema,
	}),
	exact({
		requestId: runtimeId("command"),
		decision: Type.Literal("deny"),
		decisionDigest: digest,
		approvalReceipt: ApprovalReceiptRefSchema,
	}),
]);

export const ApprovalCoordinatorRequestSchema = exact({
	ticket: ApprovalTicketSchema,
	expectedDecisionRevision: revision,
	idempotencyKey: runtimeId("command"),
});

export const ApprovalCoordinatorResultSchema = exact({
	approvalId: runtimeId("approval"),
	ticketDigest: digest,
	receipt: ApprovalReceiptRefSchema,
});

export const SandboxExecutorRequestSchema = exact({
	...authorizationContextProperties,
	requestId: runtimeId("command"),
	profile: SandboxProfileRefSchema,
	invocationDigest: digest,
	resolutionDigest: digest,
	idempotencyKey: runtimeId("command"),
	opaqueInvocation: Type.Unknown(),
});

export const SandboxExecutorResultSchema = exact({
	...authorizationContextProperties,
	requestId: runtimeId("command"),
	resolutionReceiptId: runtimeId("receipt"),
	executionReceipt: SandboxExecutionReceiptRefSchema,
});

/** Adapter 实现由安全专项注入；Runtime 不在此处评估 policy。 */
export interface CapabilityGatewayPort {
	authorize(request: CapabilityGatewayRequest, signal?: AbortSignal): Promise<CapabilityGatewayResult>;
	cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult>;
}

/** 签名/peer-channel 验证由 composition 注入；Runtime 只冻结输入与相关性。 */
export interface CapabilityAuthenticationPort {
	verify(request: CapabilityGatewayRequest, signal?: AbortSignal): Promise<{
		requestId: CommandId;
		requestDigest: string;
		status: "authenticated" | "rejected" | "unavailable";
		verifierReceiptId?: ReceiptId;
	}>;
}

/** 限流器是独立原子服务，不能用 Orchestrator BudgetGuard 替代。 */
export interface CapabilityRateLimitPort {
	apply(request: GatewayRateLimitRequest, signal?: AbortSignal): Promise<GatewayRateLimitReceipt>;
}

/** Adapter 实现由安全专项注入；Runtime 不在此处持久化或展示审批。 */
export interface ApprovalCoordinatorPort {
	request(request: ApprovalCoordinatorRequest, signal?: AbortSignal): Promise<ApprovalCoordinatorResult>;
	cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult>;
}

/** Adapter 实现由安全专项注入；Runtime 不在此处 probe、prepare 或 spawn。 */
export interface SandboxExecutorPort {
	execute(request: SandboxExecutorRequest, signal?: AbortSignal): Promise<SandboxExecutorResult>;
	cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult>;
}

export interface ArtifactRef {
	authorityId: AuthorityId;
	tenantId: TenantId;
	artifactId: ArtifactId;
	storedDigest: string;
	kind: ArtifactKind;
	originalSize: number;
	storedSize: number;
	mediaType: string;
	redaction: ArtifactRedactionClass;
	transformReceipt: ReceiptId;
	workspaceId?: WorkspaceId;
}
