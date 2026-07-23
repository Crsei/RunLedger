/** Model Compatibility 的 exact TypeBox schema 与跨引用约束。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema, CapabilityClaimSchema } from "../protocol/v3/capability.ts";
import { createSessionEventStreamRef, sameRuntimeEventStream } from "../protocol/v3/events.ts";
import { ExpectedRevisionSchema } from "../protocol/v3/event-references.ts";
import { WorkspaceBindingRefSchema } from "../protocol/v3/workspace.ts";
import {
	DeclassificationReceiptRefSchema,
	InputSourceRefSchema,
	isDeclassificationReceiptRef,
	isInputSourceRef,
} from "../protocol/v3/taint.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	MODEL_CAPABILITY_ALIASES,
	MODEL_COMPACTION_STRATEGIES,
	MODEL_PROFILE_STATUSES,
	MODEL_REASONING_HISTORY_MODES,
	MODEL_ROUTE_DIAGNOSTIC_CODES,
	MODEL_ROUTE_OPERATIONS,
	MODEL_ROUTING_CONTRACT_VERSION,
	MODEL_SWITCH_MODES,
	MODEL_SWITCH_CONVERSION_DISPOSITIONS,
	MODEL_TOOL_REPLAY_MODES,
	type ModelAdapterStateCompatibility,
	type ModelCapabilityProfile,
	type ModelCompatibilityHashSet,
	type ModelCompatibilityManifest,
	type ModelProfileEvidence,
	type ModelRegressionSuiteRef,
	type ModelRouteDecision,
	type ModelRouteDiagnostic,
	type ModelRouteRequest,
	type ModelSwitchConversionDispositions,
	type ModelSwitchConversionReceipt,
} from "./types.ts";

export const MODEL_ROUTING_SCHEMA_VERSION = MODEL_ROUTING_CONTRACT_VERSION;
export const MAX_MODEL_PROFILES = 512;
export const MAX_MODEL_ROUTE_DIAGNOSTICS = 32;
export const MAX_MODEL_CAPABILITY_CLAIMS = 64;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const id = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const commit = Type.String({ pattern: "^[a-f0-9]{40}$", minLength: 40, maxLength: 40 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 256 });
const reason = Type.String({ minLength: 1, maxLength: 1_024 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const boundedTokens = Type.Integer({ minimum: 0, maximum: 4_194_304 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literals = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const ModelRegressionSuiteRefSchema = Type.Unsafe<ModelRegressionSuiteRef>(exact({
	version: token,
	suiteDigest: digest,
	passed: Type.Boolean(),
	completedAt: timestamp,
	evidence: Type.Optional(ArtifactRefSchema),
}));

export const ModelCompatibilityHashSetSchema = Type.Unsafe<ModelCompatibilityHashSet>(exact({
	toolHash: digest,
	reasoningHash: digest,
	adapterStateHash: digest,
	compactionHash: digest,
	contextHash: digest,
	profileHash: digest,
	regressionHash: digest,
}));

export const ModelProfileEvidenceSchema = Type.Unsafe<ModelProfileEvidence>(exact({
	piAiParityManifestDigest: digest,
	catalogDigest: digest,
	upstreamCommit: commit,
	runLedgerBaseCommit: commit,
	catalogEntryDigest: digest,
	compatibilityEvidenceDigest: digest,
	evidenceDigest: digest,
}));

export const ModelCapabilityProfileSchema = Type.Unsafe<ModelCapabilityProfile>(exact({
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	profileId: id("resource"),
	modelId: token,
	providerId: token,
	manifestDigest: digest,
	profileDigest: digest,
	evidence: ModelProfileEvidenceSchema,
	compatibilityHashes: ModelCompatibilityHashSetSchema,
	contextWindow: Type.Integer({ minimum: 1, maximum: 4_194_304 }),
	maxOutputTokens: Type.Integer({ minimum: 1, maximum: 1_048_576 }),
	apiProtocol: token,
	toolCallReplay: literals(MODEL_TOOL_REPLAY_MODES),
	reasoningHistory: literals(MODEL_REASONING_HISTORY_MODES),
	midSessionSwitch: literals(MODEL_SWITCH_MODES),
	imageInput: Type.Boolean(),
	compactionStrategy: literals(MODEL_COMPACTION_STRATEGIES),
	verifiedAliases: Type.Array(literals(MODEL_CAPABILITY_ALIASES), {
		maxItems: MODEL_CAPABILITY_ALIASES.length,
		uniqueItems: true,
	}),
	capabilityClaims: Type.Array(CapabilityClaimSchema, { maxItems: MAX_MODEL_CAPABILITY_CLAIMS }),
	regressionSuite: ModelRegressionSuiteRefSchema,
	status: literals(MODEL_PROFILE_STATUSES),
	verifiedByPrincipalId: Type.Optional(id("principal")),
}));

export const ModelCompatibilityManifestSchema = Type.Unsafe<ModelCompatibilityManifest>(exact({
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	manifestId: id("resource"),
	revision,
	generatedAt: timestamp,
	piAiParityManifestDigest: digest,
	catalogDigest: digest,
	upstreamCommit: commit,
	runLedgerBaseCommit: commit,
	profiles: Type.Array(ModelCapabilityProfileSchema, { maxItems: MAX_MODEL_PROFILES }),
	manifestDigest: digest,
}));

const adapterStateDisposition = literals(["preserve", "drop", "fork_required", "deny"] as const);
export const ModelAdapterStateCompatibilitySchema = Type.Unsafe<ModelAdapterStateCompatibility>(exact({
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sourceProfileId: id("resource"),
	targetProfileId: id("resource"),
	reasoningState: adapterStateDisposition,
	toolReplayState: adapterStateDisposition,
	cacheState: adapterStateDisposition,
	stateDescriptorDigest: digest,
	compatible: Type.Boolean(),
}));

const conversionDisposition = literals(MODEL_SWITCH_CONVERSION_DISPOSITIONS);
export const ModelSwitchConversionDispositionsSchema =
	Type.Unsafe<ModelSwitchConversionDispositions>(exact({
		reasoning: conversionDisposition,
		image: conversionDisposition,
		toolCallIds: conversionDisposition,
		adapterPrivateState: conversionDisposition,
		cache: conversionDisposition,
		transport: conversionDisposition,
		context: conversionDisposition,
		compaction: conversionDisposition,
	}));

export const ModelSwitchConversionReceiptSchema = Type.Unsafe<ModelSwitchConversionReceipt>(exact({
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	receiptId: id("receipt"),
	requestId: id("command"),
	sourceProfileId: Type.Optional(id("resource")),
	sourceProfileDigest: Type.Optional(digest),
	targetProfileId: id("resource"),
	targetProfileDigest: digest,
	manifestDigest: digest,
	dispositions: ModelSwitchConversionDispositionsSchema,
	inputLineageDigest: digest,
	outputLineageDigest: digest,
	conversionEvidenceDigest: digest,
	receiptDigest: digest,
}));

export const ModelRouteDiagnosticSchema = Type.Unsafe<ModelRouteDiagnostic>(exact({
	code: literals(MODEL_ROUTE_DIAGNOSTIC_CODES),
	severity: literals(["info", "warning", "error"] as const),
	messageDigest: digest,
	capability: Type.Optional(token),
}));

export const ModelRouteRequestSchema = Type.Unsafe<ModelRouteRequest>(exact({
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("command"),
	sessionId: id("session"),
	operation: literals(MODEL_ROUTE_OPERATIONS),
	alias: literals(MODEL_CAPABILITY_ALIASES),
	fromModelId: Type.Optional(token),
	fromProfileId: Type.Optional(id("resource")),
	targetModelId: Type.Optional(token),
	targetProfileId: Type.Optional(id("resource")),
	requiredContextTokens: boundedTokens,
	requiredOutputTokens: boundedTokens,
	requiresToolReplay: Type.Boolean(),
	requiresReasoningReplay: Type.Boolean(),
	requiresImages: Type.Boolean(),
	checkpointStrategy: Type.Optional(literals(MODEL_COMPACTION_STRATEGIES)),
	requiredCapabilities: Type.Array(CapabilityClaimSchema, { maxItems: MAX_MODEL_CAPABILITY_CLAIMS }),
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
	workspace: Type.Optional(WorkspaceBindingRefSchema),
	expectedRevision: ExpectedRevisionSchema,
}));

const decisionBase = {
	schemaVersion: Type.Literal(MODEL_ROUTING_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("command"),
	decisionId: id("receipt"),
	adapterState: Type.Optional(ModelAdapterStateCompatibilitySchema),
	inputSources: Type.Array(InputSourceRefSchema, { maxItems: 256 }),
	declassificationReceipts: Type.Array(DeclassificationReceiptRefSchema, { maxItems: 256 }),
	diagnostics: Type.Array(ModelRouteDiagnosticSchema, { maxItems: MAX_MODEL_ROUTE_DIAGNOSTICS }),
	reason,
	decisionDigest: digest,
} as const;

const routedDecision = {
	...decisionBase,
	targetModelId: token,
	profileId: id("resource"),
	manifestDigest: digest,
	profileDigest: digest,
	conversionReceipt: ModelSwitchConversionReceiptSchema,
} as const;

export const ModelRouteDecisionSchema = Type.Unsafe<ModelRouteDecision>(Type.Union([
	exact({ ...routedDecision, outcome: Type.Literal("compatible") }),
	exact({
		...routedDecision,
		outcome: Type.Literal("fork"),
		mustForkReason: literals([
			"provider_private_state",
			"tool_replay_incompatible",
			"reasoning_history_incompatible",
			"mid_session_switch_unsupported",
			"compatibility_hash_mismatch",
			"conversion_lossy_or_unproven",
		] as const),
	}),
	exact({
		...decisionBase,
		outcome: Type.Literal("deny"),
		targetModelId: Type.Optional(token),
		profileId: Type.Optional(id("resource")),
		manifestDigest: Type.Optional(digest),
		profileDigest: Type.Optional(digest),
		missingCapabilities: Type.Array(token, { maxItems: 64, uniqueItems: true }),
	}),
]));

function sameScope(
	value: { authorityId: string; tenantId: string },
	child: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === child.authorityId && value.tenantId === child.tenantId;
}

export function isModelRegressionSuiteRef(value: unknown): value is ModelRegressionSuiteRef {
	return Check(ModelRegressionSuiteRefSchema, value);
}

export function isModelCapabilityProfile(value: unknown): value is ModelCapabilityProfile {
	if (!Check(ModelCapabilityProfileSchema, value)) return false;
	return (
		Object.values(value.compatibilityHashes).every((hash) => hash !== "0".repeat(64)) &&
		Object.values(value.evidence).every((proof) => !/^0+$/u.test(proof)) &&
		value.capabilityClaims.every((claim) => sameScope(value, claim)) &&
		(value.regressionSuite.evidence === undefined || sameScope(value, value.regressionSuite.evidence)) &&
		(value.status === "verified" ? value.verifiedByPrincipalId !== undefined && value.regressionSuite.passed : true)
	);
}

export function isModelCompatibilityManifest(value: unknown): value is ModelCompatibilityManifest {
	if (!Check(ModelCompatibilityManifestSchema, value)) return false;
	return value.profiles.every(
		(profile) =>
			isModelCapabilityProfile(profile) &&
			sameScope(value, profile) &&
			profile.manifestDigest === value.manifestDigest,
	);
}

export function isModelAdapterStateCompatibility(value: unknown): value is ModelAdapterStateCompatibility {
	if (!Check(ModelAdapterStateCompatibilitySchema, value)) return false;
	const dispositions = [value.reasoningState, value.toolReplayState, value.cacheState];
	return value.compatible
		? dispositions.every((entry) => entry === "preserve" || entry === "drop")
		: dispositions.some((entry) => entry === "fork_required" || entry === "deny");
}

function conversionReceiptBody(
	value: ModelSwitchConversionReceipt,
): Omit<ModelSwitchConversionReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = value;
	return body;
}

export function isModelSwitchConversionReceipt(
	value: unknown,
): value is ModelSwitchConversionReceipt {
	if (!Check(ModelSwitchConversionReceiptSchema, value)) return false;
	const sourcePairIsComplete =
		(value.sourceProfileId === undefined && value.sourceProfileDigest === undefined) ||
		(value.sourceProfileId !== undefined && value.sourceProfileDigest !== undefined);
	return (
		sourcePairIsComplete &&
		value.inputLineageDigest === value.outputLineageDigest &&
		value.receiptDigest === canonicalDigest(conversionReceiptBody(value))
	);
}

export function modelSwitchConversionIsLossless(
	receipt: ModelSwitchConversionReceipt,
): boolean {
	return Object.values(receipt.dispositions).every(
		(disposition) =>
			disposition === "preserved" ||
			disposition === "converted_lossless" ||
			disposition === "not_applicable",
	);
}

export function isModelRouteDiagnostic(value: unknown): value is ModelRouteDiagnostic {
	return Check(ModelRouteDiagnosticSchema, value);
}

export function isModelRouteRequest(value: unknown): value is ModelRouteRequest {
	if (!Check(ModelRouteRequestSchema, value)) return false;
	return (
		value.requiredCapabilities.every((claim) => sameScope(value, claim)) &&
		value.inputSources.every((source) => sameScope(value, source) && isInputSourceRef(source)) &&
		value.declassificationReceipts.every(
			(receipt) => sameScope(value, receipt) && isDeclassificationReceiptRef(receipt),
		) &&
		(value.workspace === undefined || sameScope(value, value.workspace)) &&
		value.expectedRevision.stream.scope === "session" &&
		sameRuntimeEventStream(
			value.expectedRevision.stream,
			createSessionEventStreamRef(value, value.sessionId),
		)
	);
}

export function isModelRouteDecision(value: unknown): value is ModelRouteDecision {
	if (!Check(ModelRouteDecisionSchema, value)) return false;
	return (
		value.inputSources.every((source) => sameScope(value, source) && isInputSourceRef(source)) &&
		value.declassificationReceipts.every(
			(receipt) => sameScope(value, receipt) && isDeclassificationReceiptRef(receipt),
		) &&
		(value.adapterState === undefined ||
			(sameScope(value, value.adapterState) && isModelAdapterStateCompatibility(value.adapterState))) &&
		(value.outcome === "deny" ||
			(sameScope(value, value.conversionReceipt) &&
				isModelSwitchConversionReceipt(value.conversionReceipt) &&
				value.conversionReceipt.requestId === value.requestId &&
				value.conversionReceipt.principalId === value.principalId &&
				value.conversionReceipt.targetProfileId === value.profileId &&
				value.conversionReceipt.targetProfileDigest === value.profileDigest &&
				value.conversionReceipt.manifestDigest === value.manifestDigest &&
				(value.outcome !== "compatible" ||
					modelSwitchConversionIsLossless(value.conversionReceipt))))
	);
}

export function modelRouteDecisionPreservesInputSources(
	request: ModelRouteRequest,
	decision: ModelRouteDecision,
): boolean {
	const lineageDigest = canonicalDigest({
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	});
	return (
		isModelRouteRequest(request) &&
		isModelRouteDecision(decision) &&
		request.requestId === decision.requestId &&
		(request.targetProfileId === undefined || decision.profileId === request.targetProfileId) &&
		(request.targetModelId === undefined || decision.targetModelId === request.targetModelId) &&
		canonicalDigest(request.inputSources) === canonicalDigest(decision.inputSources) &&
		canonicalDigest(request.declassificationReceipts) === canonicalDigest(decision.declassificationReceipts) &&
		(decision.outcome === "deny" ||
			(decision.conversionReceipt.inputLineageDigest === lineageDigest &&
				decision.conversionReceipt.outputLineageDigest === lineageDigest &&
				(request.fromProfileId === undefined ||
					decision.conversionReceipt.sourceProfileId === request.fromProfileId)))
	);
}
