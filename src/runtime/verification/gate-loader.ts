/** 只从 trusted baseline 读取并校验 exact GateManifest。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { ARTIFACT_KINDS } from "../protocol/v3/capability.ts";
import { isDependencyAdmissionPolicy } from "./dependency-admission.ts";
import { isSecretScanPolicy } from "./secret-scan.ts";
import {
	BROWSER_EVIDENCE_ARTIFACT_KINDS,
	DEPENDENCY_ADMISSION_REASON_CODES,
	DEPENDENCY_ADMISSION_SCHEMA_VERSION,
	GATE_MANIFEST_SCHEMA_VERSION,
	SECRET_SCAN_SCHEMA_VERSION,
	SECRET_SCAN_SCOPES,
	VERIFICATION_GATE_KINDS,
	type GateManifest,
	type GateManifestBody,
	type TrustedBaselineReceipt,
	type TrustedGateSourcePort,
	type TrustedVerificationPolicy,
	type VerificationCoreResult,
} from "./types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const pathText = Type.String({ minLength: 1, maxLength: 4096 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const envName = Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$", maxLength: 128 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const GateArgumentSchema = Type.Union([
	exact({ kind: Type.Literal("literal"), value: Type.String({ maxLength: 16_384 }) }),
	exact({ kind: Type.Literal("candidate_path"), relativePath: pathText }),
	exact({ kind: Type.Literal("baseline_path"), relativePath: pathText }),
	exact({ kind: Type.Literal("artifact_output"), name: token }),
]);

export const GateExpectedArtifactSchema = exact({
	name: token,
	kind: Type.Union(ARTIFACT_KINDS.map((kind) => Type.Literal(kind))),
	mediaType: Type.String({ minLength: 1, maxLength: 256 }),
	schemaDigest: digest,
	required: Type.Boolean(),
	maxBytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
});

export const BrowserVerificationGateSchema = exact({
	runtime: exact({
		resourceId: Type.String({ pattern: "^resource_[A-Za-z0-9][A-Za-z0-9._~-]*$", maxLength: 128 }),
		version: token,
		identityDigest: digest,
	}),
	profile: exact({
		resourceId: Type.String({ pattern: "^resource_[A-Za-z0-9][A-Za-z0-9._~-]*$", maxLength: 128 }),
		identityDigest: digest,
		policyDigest: digest,
	}),
	entryUrl: Type.String({ minLength: 1, maxLength: 4096 }),
	origin: Type.String({ minLength: 1, maxLength: 512 }),
	stepSchemaDigest: digest,
	stepsDigest: digest,
	assertionSchemaDigest: digest,
	trustedAssertionsDigest: digest,
	networkPolicyDigest: digest,
	networkEvidence: exact({
		maxEntries: Type.Integer({ minimum: 1, maximum: 100_000 }),
		maxBodyBytes: Type.Integer({ minimum: 0, maximum: 16_777_216 }),
		redactionPolicyDigest: digest,
	}),
});

const dependencyReason = Type.Union(DEPENDENCY_ADMISSION_REASON_CODES.map((code) => Type.Literal(code)));

export const DependencyAdmissionPolicySchema = exact({
	schemaVersion: Type.Literal(DEPENDENCY_ADMISSION_SCHEMA_VERSION),
	policyId: token,
	policyRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	installMode: Type.Union([Type.Literal("none"), Type.Literal("frozen")]),
	lockfileSource: Type.Union([
		Type.Literal("none"),
		Type.Literal("trusted_baseline"),
		Type.Literal("candidate_pinned"),
	]),
	lockfilePath: Type.Optional(pathText),
	lockfileDigest: Type.Optional(digest),
	requireLockfileEntry: Type.Boolean(),
	requireIntegrityDigest: Type.Boolean(),
	allowedRegistries: Type.Array(exact({
		registryId: token,
		source: Type.String({ minLength: 1, maxLength: 4096 }),
		identityDigest: digest,
	}), { maxItems: 64 }),
	minimumPublishAgeMs: Type.Integer({ minimum: 0, maximum: 31_536_000_000 }),
	lifecycleScripts: Type.Literal("deny"),
	exceptions: Type.Array(exact({
		exceptionId: token,
		packageName: token,
		version: token,
		registryIdentityDigest: digest,
		allowedReasonCodes: Type.Array(dependencyReason, { minItems: 1, maxItems: 16 }),
		approvalReceiptDigest: digest,
		reasonDigest: digest,
		expiresAt: timestamp,
	}), { maxItems: 256 }),
	maxDependencies: Type.Integer({ minimum: 1, maximum: 100_000 }),
	maxFindings: Type.Integer({ minimum: 1, maximum: 10_000 }),
	policyDigest: digest,
});

export const SecretScanPolicySchema = exact({
	schemaVersion: Type.Literal(SECRET_SCAN_SCHEMA_VERSION),
	policyId: token,
	policyRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	rules: Type.Array(exact({
		ruleId: token,
		label: Type.String({ minLength: 1, maxLength: 128 }),
		pattern: Type.String({ minLength: 1, maxLength: 1024 }),
		caseSensitive: Type.Boolean(),
	}), { minItems: 1, maxItems: 256 }),
	allowlist: Type.Array(exact({
		allowlistId: token,
		findingDigest: digest,
		approvalReceiptDigest: digest,
		reasonDigest: digest,
		expiresAt: timestamp,
	}), { maxItems: 1_000 }),
	requiredScopes: Type.Array(Type.Union(SECRET_SCAN_SCOPES.map((scope) => Type.Literal(scope))), {
		minItems: SECRET_SCAN_SCOPES.length,
		maxItems: SECRET_SCAN_SCOPES.length,
	}),
	maxItems: Type.Integer({ minimum: 5, maximum: 100_000 }),
	maxInputBytes: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
	maxFindings: Type.Integer({ minimum: 1, maximum: 100_000 }),
	policyDigest: digest,
});

export const GateManifestBodySchema = exact({
	schemaVersion: Type.Literal(GATE_MANIFEST_SCHEMA_VERSION),
	gateId: token,
	gateVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	kind: Type.Union(VERIFICATION_GATE_KINDS.map((kind) => Type.Literal(kind))),
	executable: exact({
		source: Type.Literal("trusted_baseline"),
		path: pathText,
		digest,
	}),
	arguments: Type.Array(GateArgumentSchema, { maxItems: 256 }),
	cwd: exact({ source: Type.Literal("candidate_workspace"), relativePath: pathText }),
	baseConfiguration: Type.Array(exact({ path: pathText, digest }), { maxItems: 256 }),
	dependencyPolicy: DependencyAdmissionPolicySchema,
	secretScanPolicy: SecretScanPolicySchema,
	environment: exact({
		inherit: Type.Literal(false),
		allowlist: Type.Array(envName, { maxItems: 128 }),
		values: Type.Array(
			exact({
				name: envName,
				source: Type.Union([Type.Literal("fixed"), Type.Literal("trusted_runner")]),
				value: Type.Optional(Type.String({ maxLength: 16_384 })),
			}),
			{ maxItems: 128 },
		),
	}),
	sandbox: exact({
		profile: Type.Union([
			Type.Literal("read-only"),
			Type.Literal("workspace-write"),
			Type.Literal("strict"),
			Type.Literal("external"),
		]),
		policyDigest: digest,
		requireEnforced: Type.Boolean(),
	}),
	network: exact({
		mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
		hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 256 }),
	}),
	browser: Type.Optional(BrowserVerificationGateSchema),
	timeoutMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
	expectedExitCodes: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { minItems: 1, maxItems: 32 }),
	expectedArtifacts: Type.Array(GateExpectedArtifactSchema, { maxItems: 256 }),
});

export const GateManifestSchema = exact({ ...GateManifestBodySchema.properties, manifestDigest: digest });

/** Policy 固定这个合同版本，不能采纳 candidate 自带 schema。 */
export const GATE_MANIFEST_SCHEMA_DIGEST = canonicalDigest({
	contract: "runledger.verification.gate-manifest",
	version: GATE_MANIFEST_SCHEMA_VERSION,
	exact: true,
});

function failure(message: string, code: "invalid_schema" | "invalid_digest" | "untrusted_gate" = "untrusted_gate"):
	VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function bodyOf(manifest: GateManifest): GateManifestBody {
	const { manifestDigest: _manifestDigest, ...body } = manifest;
	return body;
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

/** 路径由 adapter 最终解析；这里仅拒绝绝对路径、反斜线与 traversal。 */
export function isSafeGateRelativePath(value: string): boolean {
	if (value === ".") return true;
	if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
	const segments = value.split("/");
	return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasValidSemantics(manifest: GateManifest): boolean {
	if (!isDependencyAdmissionPolicy(manifest.dependencyPolicy) || !isSecretScanPolicy(manifest.secretScanPolicy)) return false;
	const paths = [
		manifest.executable.path,
		manifest.cwd.relativePath,
		...manifest.baseConfiguration.map((entry) => entry.path),
		...manifest.arguments.flatMap((argument) =>
			argument.kind === "candidate_path" || argument.kind === "baseline_path" ? [argument.relativePath] : [],
		),
	];
	if (!paths.every(isSafeGateRelativePath)) return false;
	if (!unique(manifest.environment.allowlist)) return false;
	if (!unique(manifest.environment.values.map((entry) => entry.name))) return false;
	if (!manifest.environment.values.every((entry) => manifest.environment.allowlist.includes(entry.name))) return false;
	if (!manifest.environment.values.every((entry) => entry.source === "fixed" ? entry.value !== undefined : entry.value === undefined)) {
		return false;
	}
	if (!unique(manifest.expectedExitCodes.map(String))) return false;
	if (!unique(manifest.expectedArtifacts.map((entry) => entry.name))) return false;
	if (manifest.kind === "browser") {
		if (!manifest.browser) return false;
		const requiredKinds = manifest.expectedArtifacts.filter((entry) => entry.required).map((entry) => entry.kind).sort();
		const browserKinds = [...BROWSER_EVIDENCE_ARTIFACT_KINDS].sort();
		if (
			requiredKinds.length !== browserKinds.length ||
			requiredKinds.some((entry, index) => entry !== browserKinds[index])
			) return false;
		let entryUrl: URL;
		try {
			entryUrl = new URL(manifest.browser.entryUrl);
		} catch {
			return false;
		}
		if (
			entryUrl.origin !== manifest.browser.origin ||
			(entryUrl.protocol !== "https:" && !(entryUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(entryUrl.hostname))) ||
			manifest.browser.networkPolicyDigest !== canonicalDigest(manifest.network) ||
			(manifest.network.mode === "allowlist" && !manifest.network.hosts.includes(entryUrl.hostname))
		) return false;
	} else if (manifest.browser !== undefined) {
		return false;
	}
	if (!unique(manifest.baseConfiguration.map((entry) => entry.path))) return false;
	if (manifest.network.mode === "deny" && manifest.network.hosts.length !== 0) return false;
	if (manifest.network.mode === "allowlist" && manifest.network.hosts.length === 0) return false;
	if (manifest.network.hosts.some((host) => host.includes("://") || host.includes("/") || host.includes("@"))) return false;
	const lockfileRequired = manifest.dependencyPolicy.lockfileSource !== "none";
	if (lockfileRequired !== Boolean(manifest.dependencyPolicy.lockfilePath && manifest.dependencyPolicy.lockfileDigest)) return false;
	if (manifest.dependencyPolicy.lockfilePath && !isSafeGateRelativePath(manifest.dependencyPolicy.lockfilePath)) return false;
	if (manifest.dependencyPolicy.installMode === "frozen" && !lockfileRequired) return false;
	return true;
}

export function isGateManifest(value: unknown): value is GateManifest {
	if (!Check(GateManifestSchema, value)) return false;
	const manifest = value as GateManifest;
	return manifest.manifestDigest === canonicalDigest(bodyOf(manifest)) && hasValidSemantics(manifest);
}

export interface LoadedTrustedGate {
	policy: TrustedVerificationPolicy;
	baseline: TrustedBaselineReceipt;
	manifest: GateManifest;
	documentDigest: string;
}

export async function loadTrustedGate(
	policy: TrustedVerificationPolicy,
	baseline: TrustedBaselineReceipt,
	source: TrustedGateSourcePort,
): Promise<VerificationCoreResult<LoadedTrustedGate>> {
	if (policy.gateSchemaDigest !== GATE_MANIFEST_SCHEMA_DIGEST || baseline.gateSchemaDigest !== GATE_MANIFEST_SCHEMA_DIGEST) {
		return failure("trusted policy does not bind the built-in exact GateManifest schema", "invalid_digest");
	}
	if (
		baseline.policyDigest !== policy.policyDigest ||
		baseline.policyId !== policy.policyId ||
		baseline.policyRevision !== policy.policyRevision ||
		baseline.baseCommit !== policy.baseCommit ||
		baseline.materializedCommit !== policy.baseCommit ||
		baseline.gateManifestPath !== policy.gateManifestPath
	) {
		return failure("trusted baseline receipt is not correlated with policy");
	}
	if (!isSafeGateRelativePath(policy.gateManifestPath)) {
		return failure("protected gate manifest path is not a safe relative path", "invalid_schema");
	}
	let loaded: Awaited<ReturnType<TrustedGateSourcePort["read"]>>;
	try {
		loaded = await source.read({ policy, baseline, protectedPath: policy.gateManifestPath });
	} catch {
		return { ok: false, error: { code: "baseline_unavailable", message: "trusted gate source is unavailable", retryable: true } };
	}
	if (!loaded.ok) return loaded;
	const document = loaded.value;
	if (
		document.baselineReceiptDigest !== baseline.receiptDigest ||
		document.sourceCommit !== policy.baseCommit ||
		document.protectedPath !== policy.gateManifestPath ||
		document.documentDigest !== canonicalDigest(document.document)
	) {
		return failure("gate document provenance or digest is invalid", "invalid_digest");
	}
	if (!isGateManifest(document.document)) return failure("gate document does not match exact GateManifest", "invalid_schema");
	if (document.document.manifestDigest !== policy.expectedGateManifestDigest) {
		return failure("gate manifest does not match trusted policy digest", "invalid_digest");
	}
	return { ok: true, value: { policy, baseline, manifest: document.document, documentDigest: document.documentDigest } };
}

export function createGateManifest(body: GateManifestBody): VerificationCoreResult<GateManifest> {
	const manifest: GateManifest = { ...body, manifestDigest: canonicalDigest(body) };
	return isGateManifest(manifest)
		? { ok: true, value: manifest }
		: failure("GateManifest body is not schema-compatible", "invalid_schema");
}
