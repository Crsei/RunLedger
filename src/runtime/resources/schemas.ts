/** 动态资源合同的 exact TypeBox schemas、digest 绑定和跨字段校验。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { ArtifactRefSchema, CapabilityClaimSchema } from "../protocol/v3/capability.ts";
import { InputSourceRefSchema, isInputSourceRef } from "../protocol/v3/taint.ts";
import type {
	ResourceApprovalReceipt,
	ResourceCacheTicket,
	ResourceCacheTicketBody,
	ResourceClaimDerivationReceipt,
	ResourceEventEmissionRequest,
	ResourceEventEmissionResult,
	ResourceExposure,
	ResourceExposureConsumer,
	ResourceIdentity,
	ResourceLifecycleEvent,
	ResourceManifestDigest,
	ResourceProvenance,
	ResourceProtocolHandshake,
	ResourceResolveRequest,
	ResourceResolveResult,
	ResourceSearchRequest,
	ResourceSearchResult,
	ResourceSnapshotAcquireRequest,
	ResourceSnapshotAcquireResult,
	ResourceSnapshotReleaseRequest,
	ResourceSnapshotReleaseResult,
	RuntimeMetadataDescriptor,
	RuntimeMetadataDescriptorBody,
	RuntimeInstructionDescriptor,
	RuntimeInstructionDescriptorBody,
	RuntimeResourceDescriptor,
	RuntimeResourceDescriptorBody,
	RuntimeResourceInvocationFrame,
	RuntimeResourceSnapshot,
	RuntimeResourceSnapshotBody,
	RuntimeToolDescriptor,
	RuntimeToolDescriptorBody,
	RuntimeToolInvocation,
	RuntimeToolInvocationRequest,
	RuntimeToolResult,
	SkillResourceSet,
	ResourceCancellationRequest,
	ResourceCancellationResult,
	ResourceClaimDerivationResult,
} from "./types.ts";
import {
	RESOURCE_ACTIVATION_STATES,
	RESOURCE_CONTENT_KINDS,
	RESOURCE_CONTRACT_SCHEMA_VERSION,
	RESOURCE_EXPOSURES,
	RESOURCE_KINDS,
	RESOURCE_PROTOCOL_VERSION,
	RESOURCE_RISK_LEVELS,
	RESOURCE_SIDE_EFFECTS,
	RESOURCE_SOURCES,
	RESOURCE_TRUST_STATES,
} from "./types.ts";

export const MAX_RESOURCE_QUALIFIED_ID_LENGTH = 256;
export const MAX_RESOURCE_VERSION_LENGTH = 64;
export const MAX_RESOURCE_LOCATOR_LENGTH = 4_096;
export const MAX_RESOURCE_DESCRIPTION_LENGTH = 2_048;
export const MAX_RESOURCE_SCHEMA_BYTES = 64 * 1_024;
export const MAX_RESOURCE_INPUT_BYTES = 4 * 1_024 * 1_024;
export const MAX_RESOURCE_DESCRIPTORS = 4_096;
export const MAX_RESOURCE_CAPABILITIES = 64;
export const MAX_RESOURCE_DIAGNOSTICS = 1_024;
export const MAX_RESOURCE_SEARCH_LIMIT = 100;
export const MAX_RESOURCE_RESULT_ITEMS = 128;
export const MAX_RESOURCE_RESULT_TEXT_BYTES = 256 * 1_024;
export const MAX_RESOURCE_PEER_FEATURES = 64;
export const MAX_RESOURCE_PROGRESS_FRAMES = 1_024;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const qualifiedIdPattern = "^[A-Za-z0-9][A-Za-z0-9._~-]*(?:(?:/|:)[A-Za-z0-9][A-Za-z0-9._~-]*)+$";
const versionPattern = "^[0-9A-Za-z][0-9A-Za-z.+_-]*$";
const runtimeNamePattern = "^[A-Za-z][A-Za-z0-9_-]*$";
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 256 });
const shortText = Type.String({ minLength: 1, maxLength: 512 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literalUnion = <T extends readonly string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)));

const authorizationProperties = {
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	principalId: runtimeId("principal"),
} as const;

export const ResourceKindSchema = literalUnion(RESOURCE_KINDS);
export const ResourceSourceSchema = literalUnion(RESOURCE_SOURCES);
export const ResourceTrustStateSchema = literalUnion(RESOURCE_TRUST_STATES);
export const ResourceActivationStateSchema = literalUnion(RESOURCE_ACTIVATION_STATES);
export const ResourceExposureSchema = literalUnion(RESOURCE_EXPOSURES);
export const ResourceRiskLevelSchema = literalUnion(RESOURCE_RISK_LEVELS);
export const ResourceSideEffectSchema = literalUnion(RESOURCE_SIDE_EFFECTS);

export const ResourceIdentitySchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	resourceId: runtimeId("resource"),
	kind: ResourceKindSchema,
	qualifiedId: Type.String({ pattern: qualifiedIdPattern, minLength: 3, maxLength: MAX_RESOURCE_QUALIFIED_ID_LENGTH }),
	version: Type.String({ pattern: versionPattern, minLength: 1, maxLength: MAX_RESOURCE_VERSION_LENGTH }),
	source: ResourceSourceSchema,
	digest,
});

export const ResourcePublisherRefSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	publisherId: token,
	identityDigest: digest,
});

export const ResourceProvenanceSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	source: ResourceSourceSchema,
	canonicalLocator: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_LOCATOR_LENGTH }),
	publisher: Type.Optional(ResourcePublisherRefSchema),
	signatureReceiptId: Type.Optional(runtimeId("receipt")),
	parentPlugin: Type.Optional(ResourceIdentitySchema),
});

export const ResourceManifestDigestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	rootDigest: digest,
	manifestDigest: digest,
	configDigest: digest,
	commandDigest: digest,
	assetsDigest: digest,
	capabilityDigest: digest,
	combinedDigest: digest,
});

export const ResourceApprovalReceiptSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	receiptId: runtimeId("receipt"),
	identity: ResourceIdentitySchema,
	binding: ResourceManifestDigestSchema,
	scope: Type.Union([Type.Literal("session"), Type.Literal("project"), Type.Literal("user")]),
	scopeBindingDigest: digest,
	issuedAt: timestamp,
	expiresAt: Type.Union([timestamp, Type.Null()]),
	revocationRevision: revision,
	receiptDigest: digest,
});

export const ResourceCapabilityBoundarySchema = Type.Union([
	exact({ kind: Type.Literal("filesystem"), access: Type.Union([Type.Literal("read"), Type.Literal("write")]), pathScopeDigest: digest }),
	exact({ kind: Type.Literal("network"), access: Type.Union([Type.Literal("connect"), Type.Literal("listen")]), hostScopeDigest: digest }),
	exact({ kind: Type.Literal("process"), access: Type.Union([Type.Literal("spawn"), Type.Literal("signal")]), commandScopeDigest: digest }),
	exact({ kind: Type.Literal("credential"), access: Type.Literal("use"), credentialScopeDigest: digest }),
	exact({
		kind: Type.Literal("browser"),
		access: Type.Union([
			Type.Literal("navigate"),
			Type.Literal("dom_read"),
			Type.Literal("script"),
			Type.Literal("download"),
			Type.Literal("upload"),
			Type.Literal("cookie"),
			Type.Literal("credential"),
			Type.Literal("network_egress"),
		]),
		originScopeDigest: digest,
	}),
]);

export const ResourceCapabilityDeclarationSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	capabilityId: runtimeId("resource"),
	claim: CapabilityClaimSchema,
	boundary: ResourceCapabilityBoundarySchema,
	required: Type.Boolean(),
});

export const ResourceRiskProfileSchema = exact({
	level: ResourceRiskLevelSchema,
	sideEffect: ResourceSideEffectSchema,
	rationaleDigest: digest,
});

export const ResourceProtocolHandshakeSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	protocol: Type.Literal("runledger.resource"),
	protocolVersion: Type.Literal(RESOURCE_PROTOCOL_VERSION),
	sessionId: runtimeId("session"),
	adapterId: runtimeId("resource"),
	adapterGeneration: revision,
	snapshotId: runtimeId("snapshot"),
	snapshotSequence: revision,
	catalogDigest: digest,
	peerFeatures: Type.Array(token, { maxItems: MAX_RESOURCE_PEER_FEATURES, uniqueItems: true }),
	handshakeDigest: digest,
});

export const RuntimeInputSchemaDescriptorSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	mediaType: Type.Literal("application/schema+json"),
	schemaJson: Type.String({ minLength: 2, maxLength: MAX_RESOURCE_SCHEMA_BYTES }),
	schemaDigest: digest,
	maxInputBytes: Type.Integer({ minimum: 1, maximum: MAX_RESOURCE_INPUT_BYTES }),
});

const descriptorCommonProperties = {
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	identity: ResourceIdentitySchema,
	provenance: ResourceProvenanceSchema,
	manifest: ResourceManifestDigestSchema,
	displayName: Type.String({ minLength: 1, maxLength: 256 }),
	description: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_DESCRIPTION_LENGTH }),
	capabilities: Type.Array(ResourceCapabilityDeclarationSchema, {
		maxItems: MAX_RESOURCE_CAPABILITIES,
	}),
	risk: ResourceRiskProfileSchema,
	exposure: ResourceExposureSchema,
	trust: ResourceTrustStateSchema,
	activation: ResourceActivationStateSchema,
	approvalReceiptId: Type.Optional(runtimeId("receipt")),
} as const;

export const RuntimeMetadataDescriptorSchema = exact({
	...descriptorCommonProperties,
	descriptorType: Type.Literal("metadata"),
	descriptorDigest: digest,
});

export const RuntimeToolDescriptorSchema = exact({
	...descriptorCommonProperties,
	descriptorType: Type.Literal("tool"),
	runtimeName: Type.String({ pattern: runtimeNamePattern, minLength: 1, maxLength: 128 }),
	inputSchema: RuntimeInputSchemaDescriptorSchema,
	resultContentKinds: Type.Array(literalUnion(RESOURCE_CONTENT_KINDS), {
		minItems: 1,
		maxItems: RESOURCE_CONTENT_KINDS.length,
		uniqueItems: true,
	}),
	execution: exact({ readOnly: Type.Boolean(), destructive: Type.Boolean(), concurrencySafe: Type.Boolean() }),
	descriptorDigest: digest,
});

export const RuntimeInstructionDescriptorSchema = exact({
	...descriptorCommonProperties,
	descriptorType: Type.Literal("instruction"),
	inputSource: InputSourceRefSchema,
	instructionDigest: digest,
	priority: Type.Union([
		Type.Literal("repository"),
		Type.Literal("user"),
		Type.Literal("organization"),
	]),
	separationOfDutyReceiptId: runtimeId("receipt"),
	descriptorDigest: digest,
});

export const RuntimeResourceDescriptorSchema = Type.Union([
	RuntimeMetadataDescriptorSchema,
	RuntimeToolDescriptorSchema,
	RuntimeInstructionDescriptorSchema,
]);

export const SkillResourceFacetSchema = exact({
	role: Type.Union([Type.Literal("metadata"), Type.Literal("body"), Type.Literal("assets"), Type.Literal("script")]),
	identity: ResourceIdentitySchema,
	capabilities: Type.Array(ResourceCapabilityDeclarationSchema, { maxItems: MAX_RESOURCE_CAPABILITIES }),
});

export const SkillResourceSetSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	qualifiedId: Type.String({ pattern: qualifiedIdPattern, minLength: 3, maxLength: MAX_RESOURCE_QUALIFIED_ID_LENGTH }),
	metadata: SkillResourceFacetSchema,
	body: SkillResourceFacetSchema,
	assets: Type.Optional(SkillResourceFacetSchema),
	script: Type.Optional(SkillResourceFacetSchema),
});

export const RuntimeToolInvocationRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	handshake: ResourceProtocolHandshakeSchema,
	tool: ResourceIdentitySchema,
	snapshotId: runtimeId("snapshot"),
	rawInput: Type.Unknown(),
	requestedClaims: Type.Array(CapabilityClaimSchema, { maxItems: MAX_RESOURCE_CAPABILITIES }),
	correlationId: runtimeId("trace"),
});

export const ResourceClaimDerivationReceiptSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	handshakeDigest: digest,
	snapshotId: runtimeId("snapshot"),
	toolIdentityDigest: digest,
	descriptorDigest: digest,
	canonicalInputJson: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_INPUT_BYTES }),
	canonicalInputDigest: digest,
	claims: Type.Array(CapabilityClaimSchema, { maxItems: MAX_RESOURCE_CAPABILITIES }),
	claimsDigest: digest,
	issuedAt: timestamp,
	receiptDigest: digest,
});

export const ResourcePortErrorSchema = exact({
	code: Type.Union([
		Type.Literal("invalid_request"),
		Type.Literal("not_found"),
		Type.Literal("not_ready"),
		Type.Literal("denied"),
		Type.Literal("conflict"),
		Type.Literal("unavailable"),
	]),
	messageDigest: digest,
	retryable: Type.Boolean(),
});

export const ResourceClaimDerivationResultSchema = Type.Union([
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		status: Type.Literal("derived"),
		receipt: ResourceClaimDerivationReceiptSchema,
	}),
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("rejected"),
		error: ResourcePortErrorSchema,
	}),
]);

export const RuntimeToolInvocationSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	handshake: ResourceProtocolHandshakeSchema,
	invocationSequence: revision,
	tool: ResourceIdentitySchema,
	snapshotId: runtimeId("snapshot"),
	correlationId: runtimeId("trace"),
	derivationReceipt: ResourceClaimDerivationReceiptSchema,
	decision: Type.Literal("allow"),
	authorizationReceiptId: runtimeId("receipt"),
	authorizationDecisionDigest: digest,
});

export const ResourceContentSchema = Type.Union([
	exact({ type: Type.Literal("text"), text: Type.String({ maxLength: MAX_RESOURCE_RESULT_TEXT_BYTES }) }),
	exact({
		type: Type.Literal("image"),
		mediaType: Type.String({ minLength: 1, maxLength: 256 }),
		dataBase64: Type.String({ maxLength: MAX_RESOURCE_RESULT_TEXT_BYTES }),
		contentDigest: digest,
	}),
	exact({
		type: Type.Literal("resource"),
		uri: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_LOCATOR_LENGTH }),
		text: Type.Optional(Type.String({ maxLength: MAX_RESOURCE_RESULT_TEXT_BYTES })),
		contentDigest: digest,
	}),
	exact({
		type: Type.Literal("json"),
		canonicalJson: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_RESULT_TEXT_BYTES }),
		contentDigest: digest,
	}),
]);

export const RuntimeToolResultSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	handshakeDigest: digest,
	invocationSequence: revision,
	terminalSequence: revision,
	terminal: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]),
	tool: ResourceIdentitySchema,
	snapshotId: runtimeId("snapshot"),
	correlationId: runtimeId("trace"),
	content: Type.Array(ResourceContentSchema, { maxItems: MAX_RESOURCE_RESULT_ITEMS }),
	artifact: Type.Optional(ArtifactRefSchema),
	isError: Type.Boolean(),
	originalBytes: revision,
	truncated: Type.Boolean(),
	contentDigest: digest,
});

export const RuntimeResourceInvocationProgressSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	kind: Type.Literal("progress"),
	requestId: runtimeId("command"),
	handshakeDigest: digest,
	invocationSequence: revision,
	sequence: revision,
	messageDigest: digest,
	observedAt: timestamp,
});

export const RuntimeResourceInvocationTerminalSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	kind: Type.Literal("terminal"),
	requestId: runtimeId("command"),
	handshakeDigest: digest,
	invocationSequence: revision,
	sequence: revision,
	result: RuntimeToolResultSchema,
});

export const RuntimeResourceInvocationFrameSchema = Type.Union([
	RuntimeResourceInvocationProgressSchema,
	RuntimeResourceInvocationTerminalSchema,
]);

export const ResourceDiagnosticSummarySchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	code: token,
	severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
	message: shortText,
	resourceId: Type.Optional(runtimeId("resource")),
	detailDigest: Type.Optional(digest),
});

export const RuntimeResourceSnapshotSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	snapshotId: runtimeId("snapshot"),
	adapterId: runtimeId("resource"),
	adapterGeneration: revision,
	adapterGenerationDigest: digest,
	createdAt: timestamp,
	resources: Type.Array(RuntimeResourceDescriptorSchema, { maxItems: MAX_RESOURCE_DESCRIPTORS }),
	diagnostics: Type.Array(ResourceDiagnosticSummarySchema, { maxItems: MAX_RESOURCE_DIAGNOSTICS }),
	digest,
});

export const ResourceCacheTicketSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	ticketId: runtimeId("receipt"),
	snapshotId: runtimeId("snapshot"),
	adapterId: runtimeId("resource"),
	adapterGeneration: revision,
	adapterGenerationDigest: digest,
	resourceIdentityDigest: digest,
	resourceDigest: digest,
	verification: Type.Literal("content_identity_only"),
	issuedAt: timestamp,
	expiresAt: timestamp,
	ticketDigest: digest,
});

const lifecycleCommonProperties = {
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	identity: ResourceIdentitySchema,
	identityDigest: digest,
	snapshotId: runtimeId("snapshot"),
	adapterGeneration: revision,
	correlationId: runtimeId("trace"),
	occurredAt: timestamp,
} as const;

export const ResourceLifecycleEventSchema = Type.Union([
	exact({ ...lifecycleCommonProperties, state: Type.Literal("discovered") }),
	exact({ ...lifecycleCommonProperties, state: Type.Literal("approved"), receiptId: runtimeId("receipt") }),
	exact({
		...lifecycleCommonProperties,
		state: Type.Literal("revoked"),
		receiptId: runtimeId("receipt"),
		revocationRevision: revision,
	}),
	exact({ ...lifecycleCommonProperties, state: Type.Literal("activated"), receiptId: runtimeId("receipt") }),
	exact({
		...lifecycleCommonProperties,
		state: Type.Literal("deactivated"),
		reasonCode: Type.Optional(token),
		reasonDigest: Type.Optional(digest),
	}),
	exact({
		...lifecycleCommonProperties,
		state: Type.Literal("failed"),
		reasonCode: token,
		reasonDigest: digest,
	}),
]);

export const ResourceResolveRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshotId: runtimeId("snapshot"),
	identity: ResourceIdentitySchema,
});

const resolvedContextProperties = {
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshotId: runtimeId("snapshot"),
} as const;

export const ResourceResolveResultSchema = Type.Union([
	exact({
		...resolvedContextProperties,
		status: Type.Literal("found"),
		descriptor: RuntimeResourceDescriptorSchema,
		cacheTicket: ResourceCacheTicketSchema,
	}),
	exact({
		...resolvedContextProperties,
		status: Type.Literal("not_found"),
		identity: ResourceIdentitySchema,
	}),
]);

export const ResourceSearchRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshotId: runtimeId("snapshot"),
	query: Type.String({ minLength: 1, maxLength: 512 }),
	limit: Type.Integer({ minimum: 1, maximum: MAX_RESOURCE_SEARCH_LIMIT }),
});

export const RuntimeResourceSearchItemSchema = exact({
	identity: ResourceIdentitySchema,
	descriptorDigest: digest,
	displayName: Type.String({ minLength: 1, maxLength: 256 }),
	description: Type.String({ minLength: 1, maxLength: MAX_RESOURCE_DESCRIPTION_LENGTH }),
	source: ResourceSourceSchema,
	trust: ResourceTrustStateSchema,
	activation: ResourceActivationStateSchema,
	risk: ResourceRiskLevelSchema,
	exposure: ResourceExposureSchema,
});

export const ResourceSearchResultSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshotId: runtimeId("snapshot"),
	queryDigest: digest,
	items: Type.Array(RuntimeResourceSearchItemSchema, { maxItems: MAX_RESOURCE_SEARCH_LIMIT }),
	truncated: Type.Boolean(),
});

export const ResourceCancellationRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	reasonDigest: digest,
});

export const ResourceCancellationResultSchema = Type.Union([
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("accepted"),
		receiptId: runtimeId("receipt"),
	}),
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("already_terminal"),
		receiptId: Type.Optional(runtimeId("receipt")),
	}),
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		status: Type.Literal("not_found"),
	}),
]);

export const ResourceSnapshotAcquireRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	minimumGeneration: Type.Optional(revision),
});

export const ResourceSnapshotAcquireResultSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshot: RuntimeResourceSnapshotSchema,
	acquisitionReceiptId: runtimeId("receipt"),
	acquiredAt: timestamp,
});

export const ResourceSnapshotReleaseRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	requestId: runtimeId("command"),
	snapshotId: runtimeId("snapshot"),
	expectedGeneration: revision,
});

export const ResourceSnapshotReleaseResultSchema = Type.Union([
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		snapshotId: runtimeId("snapshot"),
		status: Type.Literal("released"),
		receiptId: runtimeId("receipt"),
	}),
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		requestId: runtimeId("command"),
		snapshotId: runtimeId("snapshot"),
		status: Type.Union([
			Type.Literal("already_released"),
			Type.Literal("not_found"),
			Type.Literal("generation_conflict"),
		]),
	}),
]);

export const ResourceEventEmissionRequestSchema = exact({
	schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
	...authorizationProperties,
	idempotencyKey: runtimeId("command"),
	event: ResourceLifecycleEventSchema,
});

export const ResourceEventEmissionResultSchema = Type.Union([
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		idempotencyKey: runtimeId("command"),
		status: Type.Union([Type.Literal("emitted"), Type.Literal("duplicate")]),
		receiptId: runtimeId("receipt"),
		eventDigest: digest,
	}),
	exact({
		schemaVersion: Type.Literal(RESOURCE_CONTRACT_SCHEMA_VERSION),
		...authorizationProperties,
		idempotencyKey: runtimeId("command"),
		status: Type.Literal("rejected"),
		error: ResourcePortErrorSchema,
	}),
]);

function scopeMatches(
	value: { authorityId: string; tenantId: string },
	parent: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === parent.authorityId && value.tenantId === parent.tenantId;
}

function timestampMillis(value: string): number | undefined {
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? millis : undefined;
}

function canonicalStringMatches(value: string, expectedDigest: string): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		return canonicalJson(parsed) === value && canonicalDigest(parsed) === expectedDigest;
	} catch {
		return false;
	}
}

function bodyWithoutDigest<T extends object, K extends keyof T>(value: T, digestKey: K): Omit<T, K> {
	const result = { ...value };
	delete result[digestKey];
	return result;
}

export function resourceIdentityKey(identity: ResourceIdentity): string {
	return `${identity.authorityId}/${identity.tenantId}/${identity.resourceId}/${identity.kind}:${identity.qualifiedId}@${identity.version}:${identity.source}:${identity.digest}`;
}

export function resourceIdentityDigest(identity: ResourceIdentity): string {
	return canonicalDigest(identity);
}

export function isResourceIdentity(value: unknown): value is ResourceIdentity {
	return Check(ResourceIdentitySchema, value);
}

export function isResourceProvenance(value: unknown): value is ResourceProvenance {
	if (!Check(ResourceProvenanceSchema, value)) return false;
	const provenance = value as unknown as ResourceProvenance;
	return (
		(provenance.publisher === undefined || scopeMatches(provenance.publisher, provenance)) &&
		(provenance.parentPlugin === undefined ||
			(provenance.parentPlugin.kind === "plugin" && scopeMatches(provenance.parentPlugin, provenance)))
	);
}

type ResourceManifestDigestInput = Omit<ResourceManifestDigest, "schemaVersion" | "combinedDigest">;

export function createResourceManifestDigest(input: ResourceManifestDigestInput): ResourceManifestDigest {
	const body = { schemaVersion: RESOURCE_CONTRACT_SCHEMA_VERSION, ...input };
	return { ...body, combinedDigest: canonicalDigest(body) };
}

export function isResourceManifestDigest(value: unknown): value is ResourceManifestDigest {
	if (!Check(ResourceManifestDigestSchema, value)) return false;
	const binding = value as ResourceManifestDigest;
	return binding.combinedDigest === canonicalDigest(bodyWithoutDigest(binding, "combinedDigest"));
}

export function resourceApprovalReceiptDigest(
	receipt: Omit<ResourceApprovalReceipt, "receiptDigest">,
): string {
	return canonicalDigest(receipt);
}

export function createResourceApprovalReceipt(
	input: Omit<ResourceApprovalReceipt, "schemaVersion" | "receiptDigest">,
): ResourceApprovalReceipt {
	const body = { schemaVersion: RESOURCE_CONTRACT_SCHEMA_VERSION, ...input };
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function isResourceApprovalReceipt(value: unknown, at: Date = new Date()): value is ResourceApprovalReceipt {
	if (!Check(ResourceApprovalReceiptSchema, value)) return false;
	const receipt = value as unknown as ResourceApprovalReceipt;
	const issuedAt = timestampMillis(receipt.issuedAt);
	const expiresAt = receipt.expiresAt === null ? undefined : timestampMillis(receipt.expiresAt);
	return (
		issuedAt !== undefined &&
		(receipt.expiresAt === null || (expiresAt !== undefined && expiresAt > at.getTime() && expiresAt > issuedAt)) &&
		isResourceIdentity(receipt.identity) &&
		isResourceManifestDigest(receipt.binding) &&
		scopeMatches(receipt.identity, receipt) &&
		receipt.identity.digest === receipt.binding.combinedDigest &&
		receipt.receiptDigest === canonicalDigest(bodyWithoutDigest(receipt, "receiptDigest"))
	);
}

export function resourceApprovalReceiptMatches(
	receipt: ResourceApprovalReceipt,
	expected: {
		identity: ResourceIdentity;
		binding: ResourceManifestDigest;
		principalId: string;
		scope: ResourceApprovalReceipt["scope"];
		scopeBindingDigest: string;
		revocationRevision: number;
		at: Date;
	},
): boolean {
	return (
		isResourceApprovalReceipt(receipt, expected.at) &&
		isResourceIdentity(expected.identity) &&
		isResourceManifestDigest(expected.binding) &&
		expected.identity.digest === expected.binding.combinedDigest &&
		resourceIdentityKey(receipt.identity) === resourceIdentityKey(expected.identity) &&
		receipt.binding.combinedDigest === expected.binding.combinedDigest &&
		receipt.principalId === expected.principalId &&
		receipt.scope === expected.scope &&
		receipt.scopeBindingDigest === expected.scopeBindingDigest &&
		receipt.revocationRevision === expected.revocationRevision
	);
}

function boundaryMatchesClaim(
	declaration: RuntimeResourceDescriptor["capabilities"][number],
): boolean {
	const expectedBoundary = declaration.claim.resourceKind === "browser_tool"
		? "browser"
		: declaration.claim.resourceKind;
	return declaration.boundary.kind === expectedBoundary;
}

function descriptorCommonIsValid(descriptor: RuntimeResourceDescriptor): boolean {
	const capabilityIds = descriptor.capabilities.map((declaration) => declaration.capabilityId);
	return (
		isResourceIdentity(descriptor.identity) &&
		isResourceProvenance(descriptor.provenance) &&
		isResourceManifestDigest(descriptor.manifest) &&
		scopeMatches(descriptor.identity, descriptor) &&
		scopeMatches(descriptor.provenance, descriptor) &&
		descriptor.provenance.source === descriptor.identity.source &&
		descriptor.identity.digest === descriptor.manifest.combinedDigest &&
		descriptor.capabilities.every(
			(declaration) =>
				scopeMatches(declaration, descriptor) &&
				scopeMatches(declaration.claim, descriptor) &&
				boundaryMatchesClaim(declaration),
		) &&
		new Set(capabilityIds).size === capabilityIds.length &&
		(descriptor.activation !== "ready" || descriptor.trust === "trusted") &&
		(descriptor.trust !== "trusted" || descriptor.approvalReceiptId !== undefined)
	);
}

export function runtimeResourceDescriptorDigest(body: RuntimeResourceDescriptorBody): string {
	return canonicalDigest(body);
}

export function createRuntimeMetadataDescriptor(body: RuntimeMetadataDescriptorBody): RuntimeMetadataDescriptor {
	return { ...body, descriptorDigest: canonicalDigest(body) };
}

export function createRuntimeToolDescriptor(body: RuntimeToolDescriptorBody): RuntimeToolDescriptor {
	return { ...body, descriptorDigest: canonicalDigest(body) };
}

export function createRuntimeInstructionDescriptor(
	body: RuntimeInstructionDescriptorBody,
): RuntimeInstructionDescriptor {
	return { ...body, descriptorDigest: canonicalDigest(body) };
}

export function isRuntimeMetadataDescriptor(value: unknown): value is RuntimeMetadataDescriptor {
	if (!Check(RuntimeMetadataDescriptorSchema, value)) return false;
	const descriptor = value as unknown as RuntimeMetadataDescriptor;
	return (
		descriptorCommonIsValid(descriptor) &&
		descriptor.descriptorDigest === canonicalDigest(bodyWithoutDigest(descriptor, "descriptorDigest"))
	);
}

export function isRuntimeToolDescriptor(value: unknown): value is RuntimeToolDescriptor {
	if (!Check(RuntimeToolDescriptorSchema, value)) return false;
	const descriptor = value as unknown as RuntimeToolDescriptor;
	const executableKinds: ReadonlySet<string> = new Set([
		"native-tool",
		"browser-tool",
		"hook",
		"mcp-tool",
		"skill-script",
	]);
	return (
		descriptorCommonIsValid(descriptor) &&
		executableKinds.has(descriptor.identity.kind) &&
		canonicalStringMatches(descriptor.inputSchema.schemaJson, descriptor.inputSchema.schemaDigest) &&
		!(descriptor.execution.readOnly && descriptor.execution.destructive) &&
		descriptor.descriptorDigest === canonicalDigest(bodyWithoutDigest(descriptor, "descriptorDigest"))
	);
}

/** direct-model-only 只向 root model 暴露，nested/child 不能把它折叠成 direct。 */
export function resourceExposureAllows(
	exposure: ResourceExposure,
	consumer: ResourceExposureConsumer,
): boolean {
	switch (exposure) {
		case "direct":
			return consumer === "root_model" || consumer === "nested_model";
		case "direct-model-only":
			return consumer === "root_model";
		case "deferred":
			return consumer === "deferred_executor";
		case "hidden":
			return consumer === "runtime_internal";
	}
}

export function isRuntimeInstructionDescriptor(value: unknown): value is RuntimeInstructionDescriptor {
	if (!Check(RuntimeInstructionDescriptorSchema, value)) return false;
	const descriptor = value as unknown as RuntimeInstructionDescriptor;
	return (
		descriptorCommonIsValid(descriptor) &&
		descriptor.identity.kind === "instruction" &&
		isInputSourceRef(descriptor.inputSource) &&
		descriptor.inputSource.authorityId === descriptor.authorityId &&
		descriptor.inputSource.tenantId === descriptor.tenantId &&
		descriptor.inputSource.kind === "instruction" &&
		descriptor.inputSource.sourceDigest === descriptor.instructionDigest &&
		descriptor.inputSource.taintLabels.includes("executable_instruction") &&
		descriptor.approvalReceiptId !== descriptor.separationOfDutyReceiptId &&
		descriptor.descriptorDigest === canonicalDigest(bodyWithoutDigest(descriptor, "descriptorDigest"))
	);
}

export function isRuntimeResourceDescriptor(value: unknown): value is RuntimeResourceDescriptor {
	return isRuntimeMetadataDescriptor(value) || isRuntimeToolDescriptor(value) || isRuntimeInstructionDescriptor(value);
}

function facetMatches(
	facet: SkillResourceSet["metadata"],
	role: SkillResourceSet["metadata"]["role"],
	kind: ResourceIdentity["kind"],
	skill: SkillResourceSet,
): boolean {
	return (
		facet.role === role &&
		facet.identity.kind === kind &&
		scopeMatches(facet.identity, skill) &&
		facet.identity.qualifiedId.startsWith(`${skill.qualifiedId}/`) &&
		facet.capabilities.every(
			(declaration) => scopeMatches(declaration, skill) && scopeMatches(declaration.claim, skill) && boundaryMatchesClaim(declaration),
		)
	);
}

export function isSkillResourceSet(value: unknown): value is SkillResourceSet {
	if (!Check(SkillResourceSetSchema, value)) return false;
	const skill = value as unknown as SkillResourceSet;
	const facets = [skill.metadata, skill.body, skill.assets, skill.script].filter(
		(facet): facet is SkillResourceSet["metadata"] => facet !== undefined,
	);
	const resourceIds = facets.map((facet) => facet.identity.resourceId);
	const capabilityIds = facets.flatMap((facet) => facet.capabilities.map((item) => item.capabilityId));
	return (
		facetMatches(skill.metadata, "metadata", "skill", skill) &&
		facetMatches(skill.body, "body", "skill-body", skill) &&
		(skill.assets === undefined || facetMatches(skill.assets, "assets", "skill-assets", skill)) &&
		(skill.script === undefined ||
			(facetMatches(skill.script, "script", "skill-script", skill) &&
				skill.script.capabilities.some((item) => item.boundary.kind === "process"))) &&
		[skill.metadata, skill.body, skill.assets]
			.filter((facet): facet is SkillResourceSet["metadata"] => facet !== undefined)
			.every((facet) => facet.capabilities.every((item) => item.boundary.kind !== "process")) &&
		new Set(resourceIds).size === resourceIds.length &&
		new Set(capabilityIds).size === capabilityIds.length
	);
}

export function isRuntimeToolInvocationRequest(value: unknown): value is RuntimeToolInvocationRequest {
	if (!Check(RuntimeToolInvocationRequestSchema, value)) return false;
	const request = value as unknown as RuntimeToolInvocationRequest;
	return (
		isResourceProtocolHandshake(request.handshake) &&
		scopeMatches(request.handshake, request) &&
		request.handshake.snapshotId === request.snapshotId &&
		scopeMatches(request.tool, request) &&
		request.requestedClaims.every((claim) => scopeMatches(claim, request))
	);
}

function resourceProtocolHandshakeBody(
	handshake: ResourceProtocolHandshake,
): Omit<ResourceProtocolHandshake, "handshakeDigest"> {
	const { handshakeDigest: _handshakeDigest, ...body } = handshake;
	return body;
}

export function isResourceProtocolHandshake(value: unknown): value is ResourceProtocolHandshake {
	if (!Check(ResourceProtocolHandshakeSchema, value)) return false;
	const handshake = value as unknown as ResourceProtocolHandshake;
	return handshake.handshakeDigest === canonicalDigest(resourceProtocolHandshakeBody(handshake));
}

export function createResourceProtocolHandshake(
	body: Omit<ResourceProtocolHandshake, "handshakeDigest">,
): ResourceProtocolHandshake {
	return { ...body, handshakeDigest: canonicalDigest(body) };
}

type ResourceClaimDerivationReceiptInput = Omit<ResourceClaimDerivationReceipt, "schemaVersion" | "receiptDigest">;

export function createResourceClaimDerivationReceipt(
	input: ResourceClaimDerivationReceiptInput,
): ResourceClaimDerivationReceipt {
	const body = { schemaVersion: RESOURCE_CONTRACT_SCHEMA_VERSION, ...input };
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function isResourceClaimDerivationReceipt(value: unknown): value is ResourceClaimDerivationReceipt {
	if (!Check(ResourceClaimDerivationReceiptSchema, value)) return false;
	const receipt = value as unknown as ResourceClaimDerivationReceipt;
	return (
		canonicalStringMatches(receipt.canonicalInputJson, receipt.canonicalInputDigest) &&
		receipt.claims.every((claim) => scopeMatches(claim, receipt)) &&
		receipt.claimsDigest === canonicalDigest(receipt.claims) &&
		receipt.receiptDigest === canonicalDigest(bodyWithoutDigest(receipt, "receiptDigest"))
	);
}

export function isResourceClaimDerivationResult(value: unknown): value is ResourceClaimDerivationResult {
	if (!Check(ResourceClaimDerivationResultSchema, value)) return false;
	const result = value as ResourceClaimDerivationResult;
	return result.status === "rejected" || isResourceClaimDerivationReceipt(result.receipt);
}

export function isRuntimeToolInvocation(value: unknown): value is RuntimeToolInvocation {
	if (!Check(RuntimeToolInvocationSchema, value)) return false;
	const invocation = value as unknown as RuntimeToolInvocation;
	const receipt = invocation.derivationReceipt;
	return (
		isResourceIdentity(invocation.tool) &&
		isResourceProtocolHandshake(invocation.handshake) &&
		isResourceClaimDerivationReceipt(receipt) &&
		scopeMatches(invocation.tool, invocation) &&
		scopeMatches(invocation.handshake, invocation) &&
		scopeMatches(receipt, invocation) &&
		invocation.handshake.snapshotId === invocation.snapshotId &&
		receipt.handshakeDigest === invocation.handshake.handshakeDigest &&
		receipt.requestId === invocation.requestId &&
		receipt.snapshotId === invocation.snapshotId &&
		receipt.toolIdentityDigest === resourceIdentityDigest(invocation.tool)
	);
}

export function isRuntimeToolResult(value: unknown): value is RuntimeToolResult {
	if (!Check(RuntimeToolResultSchema, value)) return false;
	const result = value as unknown as RuntimeToolResult;
	return (
		scopeMatches(result.tool, result) &&
		result.terminalSequence >= result.invocationSequence &&
		(result.terminal === "completed" ? !result.isError : result.isError) &&
		(result.artifact === undefined || scopeMatches(result.artifact, result)) &&
		result.content.every((item) =>
			item.type !== "json" ? true : canonicalStringMatches(item.canonicalJson, item.contentDigest),
		) &&
		result.contentDigest === canonicalDigest(result.content)
	);
}

export function isRuntimeResourceInvocationFrame(value: unknown): value is RuntimeResourceInvocationFrame {
	if (!Check(RuntimeResourceInvocationFrameSchema, value)) return false;
	const frame = value as RuntimeResourceInvocationFrame;
	if (frame.kind === "progress") {
		return frame.sequence >= frame.invocationSequence;
	}
	return (
		isRuntimeToolResult(frame.result) &&
		frame.sequence === frame.result.terminalSequence &&
		frame.requestId === frame.result.requestId &&
		frame.handshakeDigest === frame.result.handshakeDigest &&
		frame.invocationSequence === frame.result.invocationSequence &&
		frame.authorityId === frame.result.authorityId &&
		frame.tenantId === frame.result.tenantId &&
		frame.principalId === frame.result.principalId
	);
}

export function runtimeResourceSnapshotDigest(body: RuntimeResourceSnapshotBody): string {
	return canonicalDigest(body);
}

export function createRuntimeResourceSnapshot(body: RuntimeResourceSnapshotBody): RuntimeResourceSnapshot {
	return { ...body, digest: canonicalDigest(body) };
}

export function isRuntimeResourceSnapshot(value: unknown): value is RuntimeResourceSnapshot {
	if (!Check(RuntimeResourceSnapshotSchema, value)) return false;
	const snapshot = value as unknown as RuntimeResourceSnapshot;
	const keys = snapshot.resources.map((descriptor) => resourceIdentityKey(descriptor.identity));
	return (
		snapshot.resources.every(
			(descriptor) => isRuntimeResourceDescriptor(descriptor) && scopeMatches(descriptor, snapshot),
		) &&
		snapshot.diagnostics.every((diagnostic) => scopeMatches(diagnostic, snapshot)) &&
		new Set(keys).size === keys.length &&
		snapshot.digest === canonicalDigest(bodyWithoutDigest(snapshot, "digest"))
	);
}

export function createResourceCacheTicket(body: ResourceCacheTicketBody): ResourceCacheTicket {
	return { ...body, ticketDigest: canonicalDigest(body) };
}

export function isResourceCacheTicket(value: unknown, at: Date = new Date()): value is ResourceCacheTicket {
	if (!Check(ResourceCacheTicketSchema, value)) return false;
	const ticket = value as ResourceCacheTicket;
	const issuedAt = timestampMillis(ticket.issuedAt);
	const expiresAt = timestampMillis(ticket.expiresAt);
	return (
		issuedAt !== undefined &&
		expiresAt !== undefined &&
		expiresAt > issuedAt &&
		expiresAt > at.getTime() &&
		ticket.ticketDigest === canonicalDigest(bodyWithoutDigest(ticket, "ticketDigest"))
	);
}

export function resourceCacheTicketMatches(
	ticket: ResourceCacheTicket,
	snapshot: RuntimeResourceSnapshot,
	identity: ResourceIdentity,
	at: Date = new Date(),
): boolean {
	return (
		isResourceCacheTicket(ticket, at) &&
		isRuntimeResourceSnapshot(snapshot) &&
		ticket.authorityId === snapshot.authorityId &&
		ticket.tenantId === snapshot.tenantId &&
		ticket.principalId === snapshot.principalId &&
		ticket.snapshotId === snapshot.snapshotId &&
		ticket.adapterId === snapshot.adapterId &&
		ticket.adapterGeneration === snapshot.adapterGeneration &&
		ticket.adapterGenerationDigest === snapshot.adapterGenerationDigest &&
		ticket.resourceIdentityDigest === resourceIdentityDigest(identity) &&
		ticket.resourceDigest === identity.digest
	);
}

export function isResourceLifecycleEvent(value: unknown): value is ResourceLifecycleEvent {
	if (!Check(ResourceLifecycleEventSchema, value)) return false;
	const event = value as unknown as ResourceLifecycleEvent;
	return (
		scopeMatches(event.identity, event) &&
		event.identityDigest === resourceIdentityDigest(event.identity) &&
		(event.state !== "deactivated" ||
			((event.reasonCode === undefined) === (event.reasonDigest === undefined)))
	);
}

function checked<T>(schema: TSchema, value: unknown): value is T {
	return Check(schema, value);
}

export function isResourceResolveRequest(value: unknown): value is ResourceResolveRequest {
	return checked<ResourceResolveRequest>(ResourceResolveRequestSchema, value) && scopeMatches(value.identity, value);
}

export function isResourceResolveResult(value: unknown): value is ResourceResolveResult {
	if (!checked<ResourceResolveResult>(ResourceResolveResultSchema, value)) return false;
	if (value.status === "not_found") return scopeMatches(value.identity, value);
	return (
		isRuntimeResourceDescriptor(value.descriptor) &&
		scopeMatches(value.descriptor, value) &&
		isResourceCacheTicket(value.cacheTicket) &&
		value.cacheTicket.snapshotId === value.snapshotId &&
		value.cacheTicket.resourceIdentityDigest === resourceIdentityDigest(value.descriptor.identity)
	);
}

export function isResourceSearchRequest(value: unknown): value is ResourceSearchRequest {
	return checked<ResourceSearchRequest>(ResourceSearchRequestSchema, value);
}

export function isResourceSearchResult(
	value: unknown,
	request?: ResourceSearchRequest,
): value is ResourceSearchResult {
	if (!checked<ResourceSearchResult>(ResourceSearchResultSchema, value)) return false;
	return (
		value.items.every((item) => scopeMatches(item.identity, value) && item.source === item.identity.source) &&
		(request === undefined ||
			(value.requestId === request.requestId &&
				value.snapshotId === request.snapshotId &&
				value.queryDigest === canonicalDigest(request.query) &&
				value.items.length <= request.limit))
	);
}

export function isResourceCancellationRequest(value: unknown): value is ResourceCancellationRequest {
	return checked<ResourceCancellationRequest>(ResourceCancellationRequestSchema, value);
}

export function isResourceCancellationResult(value: unknown): value is ResourceCancellationResult {
	return checked<ResourceCancellationResult>(ResourceCancellationResultSchema, value);
}

export function isResourceSnapshotAcquireRequest(value: unknown): value is ResourceSnapshotAcquireRequest {
	return checked<ResourceSnapshotAcquireRequest>(ResourceSnapshotAcquireRequestSchema, value);
}

export function isResourceSnapshotAcquireResult(value: unknown): value is ResourceSnapshotAcquireResult {
	return (
		checked<ResourceSnapshotAcquireResult>(ResourceSnapshotAcquireResultSchema, value) &&
		isRuntimeResourceSnapshot(value.snapshot) &&
		scopeMatches(value.snapshot, value) &&
		value.snapshot.principalId === value.principalId
	);
}

export function isResourceSnapshotReleaseRequest(value: unknown): value is ResourceSnapshotReleaseRequest {
	return checked<ResourceSnapshotReleaseRequest>(ResourceSnapshotReleaseRequestSchema, value);
}

export function isResourceSnapshotReleaseResult(value: unknown): value is ResourceSnapshotReleaseResult {
	return checked<ResourceSnapshotReleaseResult>(ResourceSnapshotReleaseResultSchema, value);
}

export function isResourceEventEmissionRequest(value: unknown): value is ResourceEventEmissionRequest {
	return (
		checked<ResourceEventEmissionRequest>(ResourceEventEmissionRequestSchema, value) &&
		isResourceLifecycleEvent(value.event) &&
		scopeMatches(value.event, value) &&
		value.event.principalId === value.principalId
	);
}

export function isResourceEventEmissionResult(value: unknown): value is ResourceEventEmissionResult {
	return checked<ResourceEventEmissionResult>(ResourceEventEmissionResultSchema, value);
}
