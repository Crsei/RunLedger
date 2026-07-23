/** Production daemon composition 的冻结矩阵、可信 adapter 证据与短期签名 receipt。 */

import {
	createPublicKey,
	generateKeyPairSync,
	sign as signBytes,
	verify as verifyBytes,
} from "node:crypto";
import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AuthorityId,
	type CompositionReceiptId,
	type ReceiptId,
	type RuntimeInstanceId,
	type TenantId,
} from "../runtime/protocol/v3/ids.ts";
import {
	defaultEffectiveProductionRequirements,
	minimumProductionRequirement,
	orderProductionAdapterKinds,
	productionEffectiveRequirementsDigest,
	PRODUCTION_ADAPTER_KINDS,
	PRODUCTION_FEATURE_REQUIREMENTS_VERSION,
	PRODUCTION_FEATURE_REQUIREMENTS_V1,
	PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST,
	type EffectiveProductionFeatureRequirementRow,
	type ProductionAdapterKind,
} from "../runtime/control-plane/composition-requirements.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	CONTROL_PLANE_FEATURES,
	CONTROL_PLANE_QUERY_TYPES,
	ControlPlaneFeatureSchema,
	type ControlPlaneCommandType,
	type ControlPlaneFeature,
	type ControlPlaneQueryType,
} from "../runtime/control-plane/types.ts";

export { PRODUCTION_ADAPTER_KINDS } from "../runtime/control-plane/composition-requirements.ts";
export type { ProductionAdapterKind } from "../runtime/control-plane/composition-requirements.ts";

export const PRODUCTION_COMPOSITION_SCHEMA_VERSION = 2 as const;
export const MAX_PRODUCTION_COMPOSITION_LIFETIME_MS = 60 * 60 * 1_000;

const SIGNATURE_DOMAIN = "runledger.production-composition.ed25519.v1";
const DEFAULT_IMPLEMENTATION_DIGEST = canonicalDigest({
	module: "src/daemon/production-composition.ts",
	contractVersion: PRODUCTION_COMPOSITION_SCHEMA_VERSION,
});

export type ProductionAdapterHealth = "healthy" | "degraded" | "unavailable";
export type ProductionProbeStatus = "passed" | "degraded" | "failed";

export interface ProductionAdapterProbe {
	status: ProductionProbeStatus;
	checkedAt: string;
	expiresAt: string;
	evidenceDigest: string;
	probeDigest: string;
}

export interface ProductionAdapterTrustReceipt {
	status: "trusted" | "untrusted";
	issuerId: string;
	issuedAt: string;
	expiresAt: string;
	evidenceDigest: string;
	receiptDigest: string;
}

export interface ProductionAdapterEvidence {
	kind: ProductionAdapterKind;
	adapterId: string;
	implementation: "production";
	implementationId: string;
	implementationDigest: string;
	configDigest: string;
	generation: number;
	health: ProductionAdapterHealth;
	features: readonly ControlPlaneFeature[];
	probe: ProductionAdapterProbe;
	trust: ProductionAdapterTrustReceipt;
}

export interface ManagedPolicyCompositionRef {
	policyId: string;
	revision: number;
	receiptId: ReceiptId;
	snapshotDigest: string;
	effectivePolicyDigest: string;
}

export interface ProductionCompositionTrustRoot {
	trustRootId: string;
	keyId: string;
	algorithm: "ed25519";
	publicKeySpkiDer: string;
	attestedImplementationDigest: string;
}

export interface ProductionCompositionSigner {
	trustRoot: ProductionCompositionTrustRoot;
	sign(inputDigest: string): string;
}

export interface ProductionCompositionAttestation {
	kind: "local_process";
	trustRootId: string;
	signerKeyId: string;
	attestedImplementationDigest: string;
	issuedAt: string;
	expiresAt: string;
	attestationDigest: string;
}

export interface ProductionCompositionSignature {
	algorithm: "ed25519";
	keyId: string;
	value: string;
}

export interface ProductionCompositionReceipt {
	schemaVersion: typeof PRODUCTION_COMPOSITION_SCHEMA_VERSION;
	environment: "production";
	issuer: "runledger.production-composer";
	issuerId: string;
	receiptId: CompositionReceiptId;
	authorityId: AuthorityId;
	tenantId: TenantId;
	serverInstanceId: RuntimeInstanceId;
	runtimeGeneration: number;
	featureMatrixVersion: typeof PRODUCTION_FEATURE_REQUIREMENTS_VERSION;
	protocolMinimumMatrixDigest: string;
	effectiveRequirementsDigest: string;
	managedPolicyRef: ManagedPolicyCompositionRef | null;
	featureRequirements: readonly EffectiveProductionFeatureRequirementRow[];
	issuedAt: string;
	expiresAt: string;
	adapters: readonly ProductionAdapterEvidence[];
	advertisedFeatures: readonly ControlPlaneFeature[];
	attestation: ProductionCompositionAttestation;
	receiptDigest: string;
	signature: ProductionCompositionSignature;
}

export interface ProductionCompositionScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	serverInstanceId: RuntimeInstanceId;
	runtimeGeneration?: number;
	managedPolicyRef?: ManagedPolicyCompositionRef | null;
}

export interface ProductionCompositionValidationOptions {
	at?: Date;
	trustedRoots?: readonly ProductionCompositionTrustRoot[];
}

export interface ValidatedProductionComposition {
	receipt: ProductionCompositionReceipt;
	features: readonly ControlPlaneFeature[];
	commandTypes: readonly ControlPlaneCommandType[];
	queryTypes: readonly ControlPlaneQueryType[];
	eventSubscription: boolean;
	sessionMutationReady: boolean;
}

export interface ProductionAdapterEvidenceInput {
	kind: ProductionAdapterKind;
	adapterId: string;
	implementationId: string;
	implementationDigest: string;
	configDigest: string;
	generation: number;
	health: ProductionAdapterHealth;
	features: readonly ControlPlaneFeature[];
	probe: {
		status: ProductionProbeStatus;
		checkedAt: string;
		expiresAt: string;
		evidenceDigest: string;
	};
	trust: {
		status: "trusted" | "untrusted";
		issuerId: string;
		issuedAt: string;
		expiresAt: string;
		evidenceDigest: string;
	};
}

export interface ProductionCompositionReceiptInput extends ProductionCompositionScope {
	issuerId: string;
	runtimeGeneration: number;
	issuedAt: string;
	expiresAt: string;
	managedPolicyRef?: ManagedPolicyCompositionRef | null;
	effectiveRequirements?: readonly EffectiveProductionFeatureRequirementRow[];
	adapters: readonly ProductionAdapterEvidence[];
	signer?: ProductionCompositionSigner;
}

const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", minLength: 64, maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const boundedIdentity = Type.String({
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:/#-]*$",
	minLength: 1,
	maxLength: 256,
});
const positiveGeneration = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

const ProductionAdapterKindSchema = Type.Union(PRODUCTION_ADAPTER_KINDS.map((kind) => Type.Literal(kind)));
const ProductionAdapterProbeSchema = exact({
	status: Type.Union([Type.Literal("passed"), Type.Literal("degraded"), Type.Literal("failed")]),
	checkedAt: timestamp,
	expiresAt: timestamp,
	evidenceDigest: digest,
	probeDigest: digest,
});
const ProductionAdapterTrustSchema = exact({
	status: Type.Union([Type.Literal("trusted"), Type.Literal("untrusted")]),
	issuerId: boundedIdentity,
	issuedAt: timestamp,
	expiresAt: timestamp,
	evidenceDigest: digest,
	receiptDigest: digest,
});
const ProductionAdapterEvidenceSchema = exact({
	kind: ProductionAdapterKindSchema,
	adapterId: boundedIdentity,
	implementation: Type.Literal("production"),
	implementationId: boundedIdentity,
	implementationDigest: digest,
	configDigest: digest,
	generation: positiveGeneration,
	health: Type.Union([Type.Literal("healthy"), Type.Literal("degraded"), Type.Literal("unavailable")]),
	features: Type.Array(ControlPlaneFeatureSchema, { maxItems: CONTROL_PLANE_FEATURES.length, uniqueItems: true }),
	probe: ProductionAdapterProbeSchema,
	trust: ProductionAdapterTrustSchema,
});
const ManagedPolicyCompositionRefSchema = exact({
	policyId: boundedIdentity,
	revision: positiveGeneration,
	receiptId: runtimeId("receipt"),
	snapshotDigest: digest,
	effectivePolicyDigest: digest,
});
const EffectiveRequirementSchema = exact({
	feature: ControlPlaneFeatureSchema,
	owner: ProductionAdapterKindSchema,
	requiredAdapters: Type.Array(ProductionAdapterKindSchema, {
		minItems: 1,
		maxItems: PRODUCTION_ADAPTER_KINDS.length,
		uniqueItems: true,
	}),
	allowDegradedOwner: Type.Boolean(),
	enabled: Type.Boolean(),
});
const ProductionCompositionAttestationSchema = exact({
	kind: Type.Literal("local_process"),
	trustRootId: boundedIdentity,
	signerKeyId: boundedIdentity,
	attestedImplementationDigest: digest,
	issuedAt: timestamp,
	expiresAt: timestamp,
	attestationDigest: digest,
});
const ProductionCompositionSignatureSchema = exact({
	algorithm: Type.Literal("ed25519"),
	keyId: boundedIdentity,
	value: Type.String({ pattern: "^[A-Za-z0-9+/]+={0,2}$", minLength: 80, maxLength: 128 }),
});
const ProductionCompositionReceiptSchema = exact({
	schemaVersion: Type.Literal(PRODUCTION_COMPOSITION_SCHEMA_VERSION),
	environment: Type.Literal("production"),
	issuer: Type.Literal("runledger.production-composer"),
	issuerId: boundedIdentity,
	receiptId: runtimeId("compositionReceipt"),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	serverInstanceId: runtimeId("runtime"),
	runtimeGeneration: positiveGeneration,
	featureMatrixVersion: Type.Literal(PRODUCTION_FEATURE_REQUIREMENTS_VERSION),
	protocolMinimumMatrixDigest: digest,
	effectiveRequirementsDigest: digest,
	managedPolicyRef: Type.Union([Type.Null(), ManagedPolicyCompositionRefSchema]),
	featureRequirements: Type.Array(EffectiveRequirementSchema, {
		minItems: CONTROL_PLANE_FEATURES.length,
		maxItems: CONTROL_PLANE_FEATURES.length,
	}),
	issuedAt: timestamp,
	expiresAt: timestamp,
	adapters: Type.Array(ProductionAdapterEvidenceSchema, { minItems: 1, maxItems: PRODUCTION_ADAPTER_KINDS.length }),
	advertisedFeatures: Type.Array(ControlPlaneFeatureSchema, { maxItems: CONTROL_PLANE_FEATURES.length, uniqueItems: true }),
	attestation: ProductionCompositionAttestationSchema,
	receiptDigest: digest,
	signature: ProductionCompositionSignatureSchema,
});

const NON_PRODUCTION_MARKERS = new Set(["test", "fake", "mock", "stub", "random"]);

const ADAPTER_FEATURES: Readonly<Record<ProductionAdapterKind, readonly ControlPlaneFeature[]>> = {
	daemon_core: ["health", "shutdown"],
	event_store: [...CONTROL_PLANE_FEATURES],
	model_provider: ["turn"],
	session_reader: ["session", "queue", "event_subscription"],
	session_writer: ["session", "turn", "queue", "shutdown"],
	workspace: ["session", "turn", "shutdown"],
	capability_gateway: ["session", "turn", "approval", "change_proposal", "artifact", "shutdown"],
	approval: ["approval", "turn", "shutdown"],
	sandbox: ["session", "turn", "shutdown"],
	artifact: ["session", "turn", "change_proposal", "artifact", "shutdown"],
	artifact_key_provider: ["turn", "change_proposal", "artifact", "shutdown"],
	resource_catalog: ["turn"],
	resource_invoker: ["turn", "shutdown"],
	verifier_registry: ["session", "turn", "change_proposal", "shutdown"],
	change_proposal: ["change_proposal", "human_gate"],
	credential_broker: ["change_proposal"],
	forge_provider: ["change_proposal"],
	human_gate: ["human_gate"],
	managed_policy: ["human_gate"],
	remote_executor: [],
	telemetry_exporter: [],
	event_delivery: ["event_subscription", "consumer_checkpoint"],
	activity: ["activity"],
	agent_supervisor: ["multi_agent"],
	child_runtime_factory: ["multi_agent"],
	peer_identity_attestor: [],
};

const COMMAND_FEATURES: Readonly<Record<ControlPlaneCommandType, ControlPlaneFeature>> = {
	"session:start": "session",
	"session:resume": "session",
	"session:fork": "session",
	"session:stop": "session",
	"turn:start": "turn",
	"turn:steer": "turn",
	"turn:followUp": "turn",
	"turn:interrupt": "turn",
	"queue:cancel": "queue",
	"approval:resolve": "approval",
	"changeProposal:requestDraftPr": "change_proposal",
	"humanGate:resolve": "human_gate",
	shutdown: "shutdown",
};

const QUERY_FEATURES: Readonly<Record<ControlPlaneQueryType, ControlPlaneFeature>> = {
	"session:inspect": "session",
	"queue:list": "queue",
	"changeProposal:inspect": "change_proposal",
	"artifact:read": "artifact",
	"artifact:metadata": "artifact",
	"activity:get": "activity",
	health: "health",
};

const adapterOrder = new Map(PRODUCTION_ADAPTER_KINDS.map((kind, index) => [kind, index] as const));

function normalizedIdentityTokens(value: string): readonly string[] {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function hasNonProductionIdentity(value: string): boolean {
	return normalizedIdentityTokens(value).some((token) => NON_PRODUCTION_MARKERS.has(token));
}

function isStrongDigest(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value) && new Set(value).size >= 4;
}

function isCanonicalTimestamp(value: string): boolean {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function orderedFeatures(features: readonly ControlPlaneFeature[]): readonly ControlPlaneFeature[] {
	const selected = new Set(features);
	return CONTROL_PLANE_FEATURES.filter((feature) => selected.has(feature));
}

function probeBody(probe: Omit<ProductionAdapterProbe, "probeDigest">): Omit<ProductionAdapterProbe, "probeDigest"> {
	return {
		status: probe.status,
		checkedAt: probe.checkedAt,
		expiresAt: probe.expiresAt,
		evidenceDigest: probe.evidenceDigest,
	};
}

function trustBody(trust: Omit<ProductionAdapterTrustReceipt, "receiptDigest">): Omit<ProductionAdapterTrustReceipt, "receiptDigest"> {
	return {
		status: trust.status,
		issuerId: trust.issuerId,
		issuedAt: trust.issuedAt,
		expiresAt: trust.expiresAt,
		evidenceDigest: trust.evidenceDigest,
	};
}

function attestationBody(
	attestation: Omit<ProductionCompositionAttestation, "attestationDigest">,
): Omit<ProductionCompositionAttestation, "attestationDigest"> {
	return {
		kind: attestation.kind,
		trustRootId: attestation.trustRootId,
		signerKeyId: attestation.signerKeyId,
		attestedImplementationDigest: attestation.attestedImplementationDigest,
		issuedAt: attestation.issuedAt,
		expiresAt: attestation.expiresAt,
	};
}

type ReceiptIdentityBody = Omit<ProductionCompositionReceipt, "receiptId" | "receiptDigest" | "signature">;
type ReceiptDigestBody = Omit<ProductionCompositionReceipt, "receiptDigest" | "signature">;

function receiptIdentityBody(receipt: ProductionCompositionReceipt | ReceiptIdentityBody): ReceiptIdentityBody {
	if (!("receiptId" in receipt)) return { ...receipt };
	const { receiptId: _receiptId, receiptDigest: _receiptDigest, signature: _signature, ...body } = receipt;
	return body;
}

function receiptDigestBody(receipt: ProductionCompositionReceipt | ReceiptDigestBody): ReceiptDigestBody {
	if (!("receiptDigest" in receipt)) return { ...receipt };
	const { receiptDigest: _receiptDigest, signature: _signature, ...body } = receipt;
	return body;
}

function signatureInput(receiptDigest: string): Uint8Array {
	return Buffer.from(`${SIGNATURE_DOMAIN}\0${receiptDigest}`, "utf8");
}

const defaultKeyPair = generateKeyPairSync("ed25519");
const defaultPublicDer = defaultKeyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const DEFAULT_TRUST_ROOT: ProductionCompositionTrustRoot = Object.freeze({
	trustRootId: "runledger.local-process-composer.v1",
	keyId: `composition-${canonicalDigest(defaultPublicDer).slice(0, 32)}`,
	algorithm: "ed25519",
	publicKeySpkiDer: defaultPublicDer,
	attestedImplementationDigest: DEFAULT_IMPLEMENTATION_DIGEST,
});
const DEFAULT_SIGNER: ProductionCompositionSigner = Object.freeze({
	trustRoot: DEFAULT_TRUST_ROOT,
	sign: (inputDigest: string) => signBytes(null, signatureInput(inputDigest), defaultKeyPair.privateKey).toString("base64"),
});

export function defaultProductionCompositionTrustRoot(): ProductionCompositionTrustRoot {
	return { ...DEFAULT_TRUST_ROOT };
}

function adapterMap(adapters: readonly ProductionAdapterEvidence[]): ReadonlyMap<ProductionAdapterKind, ProductionAdapterEvidence> {
	return new Map(adapters.map((adapter) => [adapter.kind, adapter]));
}

function adapterIsReady(adapter: ProductionAdapterEvidence | undefined, receiptExpiresAt: number): boolean {
	if (!adapter || adapter.trust.status !== "trusted") return false;
	if (Date.parse(adapter.probe.expiresAt) < receiptExpiresAt || Date.parse(adapter.trust.expiresAt) < receiptExpiresAt) return false;
	return adapter.health === "healthy" && adapter.probe.status === "passed";
}

function featureIsReady(
	adapters: ReadonlyMap<ProductionAdapterKind, ProductionAdapterEvidence>,
	requirement: EffectiveProductionFeatureRequirementRow,
	receiptExpiresAt: number,
): boolean {
	if (!requirement.enabled) return false;
	const owner = adapters.get(requirement.owner);
	if (!owner || !owner.features.includes(requirement.feature)) return false;
	if (requirement.allowDegradedOwner) {
		if (
			owner.trust.status !== "trusted" ||
			owner.health === "unavailable" ||
			owner.probe.status === "failed" ||
			Date.parse(owner.probe.expiresAt) < receiptExpiresAt ||
			Date.parse(owner.trust.expiresAt) < receiptExpiresAt
		) return false;
	} else if (!adapterIsReady(owner, receiptExpiresAt)) return false;
	return requirement.requiredAdapters.every((kind) => adapterIsReady(adapters.get(kind), receiptExpiresAt));
}

function deriveFeatures(
	adapters: readonly ProductionAdapterEvidence[],
	requirements: readonly EffectiveProductionFeatureRequirementRow[],
	receiptExpiresAt: number,
): readonly ControlPlaneFeature[] {
	const byKind = adapterMap(adapters);
	const byFeature = new Map(requirements.map((requirement) => [requirement.feature, requirement] as const));
	return CONTROL_PLANE_FEATURES.filter((feature) => {
		const requirement = byFeature.get(feature);
		return requirement ? featureIsReady(byKind, requirement, receiptExpiresAt) : false;
	});
}

function sessionMutationIsReady(
	adapters: ReadonlyMap<ProductionAdapterKind, ProductionAdapterEvidence>,
	receiptExpiresAt: number,
): boolean {
	const writer = adapters.get("session_writer");
	return Boolean(
		writer?.features.includes("session") &&
		PRODUCTION_FEATURE_REQUIREMENTS_V1.sessionMutationRequiredAdapters.every((kind) =>
			adapterIsReady(adapters.get(kind), receiptExpiresAt)
		),
	);
}

function sameOrderedValues<T extends string>(left: readonly T[], right: readonly T[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function healthMatchesProbe(adapter: ProductionAdapterEvidence): boolean {
	return (
		(adapter.health === "healthy" && adapter.probe.status === "passed") ||
		(adapter.health === "degraded" && adapter.probe.status === "degraded") ||
		(adapter.health === "unavailable" && adapter.probe.status === "failed")
	);
}

function managedPolicyRefsEqual(
	left: ManagedPolicyCompositionRef | null,
	right: ManagedPolicyCompositionRef | null,
): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function requirementsAreValid(
	requirements: readonly EffectiveProductionFeatureRequirementRow[],
	managedPolicyRef: ManagedPolicyCompositionRef | null,
): boolean {
	if (requirements.length !== CONTROL_PLANE_FEATURES.length) return false;
	return requirements.every((requirement, index) => {
		const feature = CONTROL_PLANE_FEATURES[index];
		if (requirement.feature !== feature) return false;
		const minimum = minimumProductionRequirement(feature);
		const ordered = orderProductionAdapterKinds(requirement.requiredAdapters);
		if (
			requirement.owner !== minimum.owner ||
			requirement.allowDegradedOwner !== minimum.allowDegradedOwner ||
			!sameOrderedValues(requirement.requiredAdapters, ordered) ||
			!minimum.requiredAdapters.every((kind) => requirement.requiredAdapters.includes(kind))
		) return false;
		if (!managedPolicyRef) {
			return requirement.enabled && sameOrderedValues(requirement.requiredAdapters, minimum.requiredAdapters);
		}
		return true;
	});
}

function verifyReceiptSignature(
	receipt: ProductionCompositionReceipt,
	trustedRoots: readonly ProductionCompositionTrustRoot[],
): boolean {
	const root = trustedRoots.find((candidate) =>
		candidate.trustRootId === receipt.attestation.trustRootId &&
		candidate.keyId === receipt.attestation.signerKeyId &&
		candidate.algorithm === receipt.signature.algorithm &&
		candidate.keyId === receipt.signature.keyId &&
		candidate.attestedImplementationDigest === receipt.attestation.attestedImplementationDigest
	);
	if (!root) return false;
	try {
		const publicKey = createPublicKey({
			key: Buffer.from(root.publicKeySpkiDer, "base64"),
			format: "der",
			type: "spki",
		});
		return verifyBytes(
			null,
			signatureInput(receipt.receiptDigest),
			publicKey,
			Buffer.from(receipt.signature.value, "base64"),
		);
	} catch {
		return false;
	}
}

function cloneAndFreezeReceipt(receipt: ProductionCompositionReceipt): ProductionCompositionReceipt {
	const adapters = receipt.adapters.map((adapter) => Object.freeze({
		...adapter,
		features: Object.freeze([...adapter.features]),
		probe: Object.freeze({ ...adapter.probe }),
		trust: Object.freeze({ ...adapter.trust }),
	}));
	const requirements = receipt.featureRequirements.map((requirement) => Object.freeze({
		...requirement,
		requiredAdapters: Object.freeze([...requirement.requiredAdapters]),
	}));
	return Object.freeze({
		...receipt,
		managedPolicyRef: receipt.managedPolicyRef ? Object.freeze({ ...receipt.managedPolicyRef }) : null,
		featureRequirements: Object.freeze(requirements),
		adapters: Object.freeze(adapters),
		advertisedFeatures: Object.freeze([...receipt.advertisedFeatures]),
		attestation: Object.freeze({ ...receipt.attestation }),
		signature: Object.freeze({ ...receipt.signature }),
	});
}

export function controlPlaneFeatureForCommand(type: ControlPlaneCommandType): ControlPlaneFeature {
	return COMMAND_FEATURES[type];
}

export function controlPlaneFeatureForQuery(type: ControlPlaneQueryType): ControlPlaneFeature {
	return QUERY_FEATURES[type];
}

export function createProductionAdapterEvidence(input: ProductionAdapterEvidenceInput): ProductionAdapterEvidence {
	const probe = probeBody(input.probe);
	const trust = trustBody(input.trust);
	return {
		kind: input.kind,
		adapterId: input.adapterId,
		implementation: "production",
		implementationId: input.implementationId,
		implementationDigest: input.implementationDigest,
		configDigest: input.configDigest,
		generation: input.generation,
		health: input.health,
		features: orderedFeatures(input.features),
		probe: { ...probe, probeDigest: canonicalDigest(probe) },
		trust: { ...trust, receiptDigest: canonicalDigest(trust) },
	};
}

export function validateProductionCompositionReceipt(
	value: unknown,
	expected?: ProductionCompositionScope,
	options: ProductionCompositionValidationOptions = {},
): ControlPlaneResult<ValidatedProductionComposition> {
	if (!Check(ProductionCompositionReceiptSchema, value)) {
		return controlPlaneFailure("adapter_contract_violation", "production composition receipt schema is invalid");
	}
	const receipt = value as unknown as ProductionCompositionReceipt;
	const at = options.at ?? new Date();
	const issuedAt = Date.parse(receipt.issuedAt);
	const expiresAt = Date.parse(receipt.expiresAt);
	if (
		!isRuntimeId(receipt.receiptId, "compositionReceipt") ||
		!isRuntimeId(receipt.authorityId, "authority") ||
		!isRuntimeId(receipt.tenantId, "tenant") ||
		!isRuntimeId(receipt.serverInstanceId, "runtime") ||
		!isCanonicalTimestamp(receipt.issuedAt) ||
		!isCanonicalTimestamp(receipt.expiresAt) ||
		!Number.isFinite(at.getTime()) ||
		expiresAt <= issuedAt ||
		expiresAt - issuedAt > MAX_PRODUCTION_COMPOSITION_LIFETIME_MS ||
		at.getTime() < issuedAt ||
		at.getTime() >= expiresAt
	) return controlPlaneFailure("adapter_contract_violation", "production composition receipt identity or expiry is invalid");
	if (
		hasNonProductionIdentity(receipt.issuerId) ||
		receipt.adapters.some((adapter) =>
			hasNonProductionIdentity(adapter.adapterId) ||
			hasNonProductionIdentity(adapter.implementationId) ||
			hasNonProductionIdentity(adapter.trust.issuerId)
		)
	) return controlPlaneFailure("adapter_contract_violation", "test or fake identity is forbidden in production composition");
	if (
		expected &&
		(receipt.authorityId !== expected.authorityId ||
			receipt.tenantId !== expected.tenantId ||
			receipt.serverInstanceId !== expected.serverInstanceId ||
			(expected.runtimeGeneration !== undefined && receipt.runtimeGeneration !== expected.runtimeGeneration) ||
			(expected.managedPolicyRef !== undefined &&
				!managedPolicyRefsEqual(receipt.managedPolicyRef, expected.managedPolicyRef)))
	) return controlPlaneFailure("adapter_contract_violation", "production composition receipt scope does not match daemon identity");
	if (
		receipt.featureMatrixVersion !== PRODUCTION_FEATURE_REQUIREMENTS_VERSION ||
		receipt.protocolMinimumMatrixDigest !== PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST ||
		!requirementsAreValid(receipt.featureRequirements, receipt.managedPolicyRef) ||
		receipt.effectiveRequirementsDigest !== productionEffectiveRequirementsDigest(receipt.featureRequirements)
	) return controlPlaneFailure("adapter_contract_violation", "production feature requirements are invalid or weaker than protocol minimum");

	const kinds = new Set<ProductionAdapterKind>();
	for (const adapter of receipt.adapters) {
		if (kinds.has(adapter.kind)) {
			return controlPlaneFailure("adapter_contract_violation", "production composition contains duplicate adapter kinds");
		}
		kinds.add(adapter.kind);
		if (
			!Number.isSafeInteger(adapter.generation) ||
			adapter.generation !== receipt.runtimeGeneration ||
			!isCanonicalTimestamp(adapter.probe.checkedAt) ||
			!isCanonicalTimestamp(adapter.probe.expiresAt) ||
			!isCanonicalTimestamp(adapter.trust.issuedAt) ||
			!isCanonicalTimestamp(adapter.trust.expiresAt) ||
			Date.parse(adapter.probe.checkedAt) > issuedAt ||
			Date.parse(adapter.trust.issuedAt) > issuedAt ||
			Date.parse(adapter.probe.expiresAt) < expiresAt ||
			Date.parse(adapter.trust.expiresAt) < expiresAt ||
			adapter.trust.status !== "trusted" ||
			!healthMatchesProbe(adapter)
		) return controlPlaneFailure("adapter_contract_violation", "production adapter generation, health, trust, or expiry is invalid");
		if (
			!isStrongDigest(adapter.implementationDigest) ||
			!isStrongDigest(adapter.configDigest) ||
			!isStrongDigest(adapter.probe.evidenceDigest) ||
			!isStrongDigest(adapter.trust.evidenceDigest) ||
			adapter.probe.probeDigest !== canonicalDigest(probeBody(adapter.probe)) ||
			adapter.trust.receiptDigest !== canonicalDigest(trustBody(adapter.trust))
		) return controlPlaneFailure("adapter_contract_violation", "production adapter digest binding is invalid");
		if (
			!sameOrderedValues(adapter.features, orderedFeatures(adapter.features)) ||
			adapter.features.some((feature) => !ADAPTER_FEATURES[adapter.kind].includes(feature))
		) return controlPlaneFailure("adapter_contract_violation", "production adapter feature claim is invalid");
	}
	const expectedAdapterOrder = [...receipt.adapters].sort(
		(left, right) => (adapterOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
			(adapterOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER),
	);
	if (receipt.adapters.some((adapter, index) => adapter.kind !== expectedAdapterOrder[index]?.kind)) {
		return controlPlaneFailure("adapter_contract_violation", "production adapters are not in canonical order");
	}

	const advertisedFeatures = deriveFeatures(receipt.adapters, receipt.featureRequirements, expiresAt);
	if (!sameOrderedValues(receipt.advertisedFeatures, advertisedFeatures)) {
		return controlPlaneFailure("adapter_contract_violation", "production feature advertisement is not derived from frozen requirements");
	}
	if (
		receipt.attestation.issuedAt !== receipt.issuedAt ||
		receipt.attestation.expiresAt !== receipt.expiresAt ||
		receipt.attestation.attestationDigest !== canonicalDigest(attestationBody(receipt.attestation))
	) return controlPlaneFailure("adapter_contract_violation", "production composition attestation is invalid");
	const identityBody = receiptIdentityBody(receipt);
	const expectedReceiptId = createRuntimeId("compositionReceipt", canonicalDigest(identityBody).slice(0, 48));
	if (
		receipt.receiptId !== expectedReceiptId ||
		!isStrongDigest(receipt.receiptDigest) ||
		receipt.receiptDigest !== canonicalDigest(receiptDigestBody(receipt)) ||
		!verifyReceiptSignature(receipt, options.trustedRoots ?? [DEFAULT_TRUST_ROOT])
	) return controlPlaneFailure("adapter_contract_violation", "production composition receipt digest or signature is invalid");

	const byKind = adapterMap(receipt.adapters);
	const mutationReady = sessionMutationIsReady(byKind, expiresAt);
	const commandTypes = CONTROL_PLANE_COMMAND_TYPES.filter((type) => {
		if (COMMAND_FEATURES[type] === "session") return mutationReady;
		return advertisedFeatures.includes(COMMAND_FEATURES[type]);
	});
	const queryTypes = CONTROL_PLANE_QUERY_TYPES.filter((type) => advertisedFeatures.includes(QUERY_FEATURES[type]));
	return {
		ok: true,
		value: {
			receipt: cloneAndFreezeReceipt(receipt),
			features: Object.freeze([...advertisedFeatures]),
			commandTypes: Object.freeze(commandTypes),
			queryTypes: Object.freeze(queryTypes),
			eventSubscription: advertisedFeatures.includes("event_subscription"),
			sessionMutationReady: mutationReady,
		},
	};
}

export function createProductionCompositionReceipt(
	input: ProductionCompositionReceiptInput,
): ControlPlaneResult<ProductionCompositionReceipt> {
	const signer = input.signer ?? DEFAULT_SIGNER;
	const managedPolicyRef = input.managedPolicyRef ?? null;
	const requirements = (input.effectiveRequirements ?? defaultEffectiveProductionRequirements()).map((requirement) => ({
		...requirement,
		requiredAdapters: [...requirement.requiredAdapters],
	}));
	if (!requirementsAreValid(requirements, managedPolicyRef)) {
		return controlPlaneFailure("adapter_contract_violation", "effective requirements cannot weaken protocol minimum");
	}
	const adapters = [...input.adapters]
		.map((adapter) => ({
			...adapter,
			features: orderedFeatures(adapter.features),
			probe: { ...adapter.probe },
			trust: { ...adapter.trust },
		}))
		.sort((left, right) => (adapterOrder.get(left.kind) ?? Number.MAX_SAFE_INTEGER) -
			(adapterOrder.get(right.kind) ?? Number.MAX_SAFE_INTEGER));
	const expiresAtMs = Date.parse(input.expiresAt);
	const advertisedFeatures = deriveFeatures(adapters, requirements, expiresAtMs);
	const attestationWithoutDigest: Omit<ProductionCompositionAttestation, "attestationDigest"> = {
		kind: "local_process",
		trustRootId: signer.trustRoot.trustRootId,
		signerKeyId: signer.trustRoot.keyId,
		attestedImplementationDigest: signer.trustRoot.attestedImplementationDigest,
		issuedAt: input.issuedAt,
		expiresAt: input.expiresAt,
	};
	const attestation: ProductionCompositionAttestation = {
		...attestationWithoutDigest,
		attestationDigest: canonicalDigest(attestationWithoutDigest),
	};
	const identityBody: ReceiptIdentityBody = {
		schemaVersion: PRODUCTION_COMPOSITION_SCHEMA_VERSION,
		environment: "production",
		issuer: "runledger.production-composer",
		issuerId: input.issuerId,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		serverInstanceId: input.serverInstanceId,
		runtimeGeneration: input.runtimeGeneration,
		featureMatrixVersion: PRODUCTION_FEATURE_REQUIREMENTS_VERSION,
		protocolMinimumMatrixDigest: PRODUCTION_FEATURE_REQUIREMENTS_V1_DIGEST,
		effectiveRequirementsDigest: productionEffectiveRequirementsDigest(requirements),
		managedPolicyRef,
		featureRequirements: requirements,
		issuedAt: input.issuedAt,
		expiresAt: input.expiresAt,
		adapters,
		advertisedFeatures,
		attestation,
	};
	const receiptId = createRuntimeId("compositionReceipt", canonicalDigest(identityBody).slice(0, 48));
	const withoutDigest: ReceiptDigestBody = { ...identityBody, receiptId };
	const receiptDigest = canonicalDigest(withoutDigest);
	const receipt: ProductionCompositionReceipt = {
		...withoutDigest,
		receiptDigest,
		signature: {
			algorithm: "ed25519",
			keyId: signer.trustRoot.keyId,
			value: signer.sign(receiptDigest),
		},
	};
	const validated = validateProductionCompositionReceipt(receipt, input, {
		at: new Date(input.issuedAt),
		trustedRoots: [signer.trustRoot],
	});
	return validated.ok ? { ok: true, value: validated.value.receipt } : validated;
}
