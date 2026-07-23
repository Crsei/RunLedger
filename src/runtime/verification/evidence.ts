/** Verification execution evidence、Artifact binding 与确定性结果判定。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	ArtifactRefSchema,
	CapabilityNameSchema,
	isSandboxExecutionReceiptRef,
} from "../protocol/v3/capability.ts";
import { TAINT_LABELS } from "../protocol/v3/taint.ts";
import { parseRuntimeId } from "../protocol/v3/ids.ts";
import { TrustedBaselineReceiptSchema, isTrustedBaselineReceipt } from "./baseline.ts";
import { isVerificationAdmissionBundle } from "./admission.ts";
import {
	BrowserVerificationGateSchema,
	DependencyAdmissionPolicySchema,
	GateArgumentSchema,
	GateExpectedArtifactSchema,
	SecretScanPolicySchema,
} from "./gate-loader.ts";
import {
	VERIFICATION_OUTCOMES,
	VERIFICATION_SCHEMA_VERSION,
	type ArtifactEvidenceReceipt,
	type BrowserExecutionReceipt,
	type BrowserOperationReceipt,
	type CandidateIdentity,
	type GateExpectedArtifact,
	type VerificationCoreResult,
	type VerificationExecutionEvidence,
	type VerificationAdmissionBundle,
	type VerificationInvocation,
	type VerificationOutcome,
	type VerificationResult,
	type VerificationResultBody,
} from "./types.ts";

const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$",
	maxLength: 24,
});
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const token = Type.String({ minLength: 1, maxLength: 512 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

export const CandidateIdentitySchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	repositoryId: runtimeId("repository"),
	workspaceId: runtimeId("workspace"),
	baseCommit: token,
	candidateCommit: token,
	bindingDigest: digest,
});

const GateEnvironmentSchema = Type.Array(exact({ name: token, value: Type.String({ maxLength: 16_384 }) }), {
	maxItems: 128,
});

export const VerificationInvocationSchema = exact({
	schemaVersion: Type.Literal(VERIFICATION_SCHEMA_VERSION),
	requestId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	gateId: token,
	gateDigest: digest,
	baselineReceiptDigest: digest,
	candidate: CandidateIdentitySchema,
	executable: exact({ source: Type.Literal("trusted_baseline"), path: token, digest }),
	arguments: Type.Array(GateArgumentSchema, { maxItems: 256 }),
	cwd: exact({ source: Type.Literal("candidate_workspace"), relativePath: token }),
	baseConfiguration: Type.Array(exact({ path: token, digest }), { maxItems: 256 }),
	dependencyPolicy: DependencyAdmissionPolicySchema,
	secretScanPolicy: SecretScanPolicySchema,
	environment: GateEnvironmentSchema,
	environmentAllowlist: Type.Array(token, { maxItems: 128 }),
	network: exact({
		mode: Type.Union([Type.Literal("deny"), Type.Literal("allowlist")]),
		hosts: Type.Array(token, { maxItems: 256 }),
	}),
	browser: Type.Optional(BrowserVerificationGateSchema),
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
	timeoutMs: Type.Integer({ minimum: 1, maximum: 86_400_000 }),
	expectedExitCodes: Type.Array(Type.Integer({ minimum: 0, maximum: 255 }), { minItems: 1, maxItems: 32 }),
	expectedArtifacts: Type.Array(GateExpectedArtifactSchema, { maxItems: 256 }),
	invocationDigest: digest,
});

export const ArtifactEvidenceReceiptSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	outputName: token,
	artifact: ArtifactRefSchema,
	candidateCommit: token,
	schemaDigest: digest,
	validation: Type.Union([Type.Literal("valid"), Type.Literal("invalid"), Type.Literal("unavailable")]),
	lineageStatus: Type.Union([
		Type.Literal("verified"),
		Type.Literal("quarantined"),
		Type.Literal("legacy_unverified"),
	]),
	lineageDigest: digest,
	taintUpperBound: Type.Array(Type.Union(TAINT_LABELS.map((label) => Type.Literal(label))), {
		maxItems: TAINT_LABELS.length,
		uniqueItems: true,
	}),
	validatorId: runtimeId("principal"),
	validatedAt: timestamp,
	receiptDigest: digest,
});

const browserOperationReceiptBase = {
	sequence: Type.Integer({ minimum: 0, maximum: 255 }),
	operationId: runtimeId("command"),
	operationDigest: digest,
	capability: CapabilityNameSchema,
	capabilityRequestDigest: digest,
	capabilityDecisionDigest: digest,
	sandboxReceiptId: runtimeId("receipt"),
	sandboxInvocationDigest: digest,
	sandboxReceiptDigest: digest,
	backendReceiptId: runtimeId("receipt"),
	backendReceiptDigest: digest,
	bindingDigest: digest,
	receiptDigest: digest,
} as const;

export const BrowserOperationReceiptSchema = Type.Union([
	exact({ ...browserOperationReceiptBase, kind: Type.Literal("launch") }),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("navigate"),
		urlDigest: digest,
		originDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("network"),
		originDigest: digest,
		networkPolicyDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("download"),
		downloadScopeDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("cookie_credential"),
		access: Type.Union([Type.Literal("cookie"), Type.Literal("credential")]),
		scopeDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("screenshot"),
		outputName: token,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("dom_read"),
		outputName: token,
		domScopeDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("console_read"),
		outputName: token,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("network_evidence"),
		outputName: token,
		boundsDigest: digest,
	}),
	exact({
		...browserOperationReceiptBase,
		kind: Type.Literal("evidence_seal"),
		outputNamesDigest: digest,
	}),
]);

export const BrowserExecutionReceiptSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	receiptId: runtimeId("receipt"),
	requestId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	gateDigest: digest,
	runtimeResourceId: runtimeId("resource"),
	runtimeIdentityDigest: digest,
	profileResourceId: runtimeId("resource"),
	profileIdentityDigest: digest,
	profilePolicyDigest: digest,
	entryUrl: Type.String({ minLength: 1, maxLength: 4096 }),
	origin: Type.String({ minLength: 1, maxLength: 512 }),
	stepSchemaDigest: digest,
	stepsDigest: digest,
	assertionSchemaDigest: digest,
	trustedAssertionsDigest: digest,
	networkPolicyDigest: digest,
	candidateCommit: token,
	candidateIdentityDigest: digest,
	workspaceValidationReceiptId: runtimeId("receipt"),
	workspaceValidationReceiptDigest: digest,
	bindingDigest: digest,
	operationReceipts: Type.Array(BrowserOperationReceiptSchema, { minItems: 8, maxItems: 256 }),
	operationReceiptsDigest: digest,
	evidenceArtifactsDigest: digest,
	executedAt: timestamp,
	receiptDigest: digest,
});

const SandboxReceiptSchema = Type.Union([
	exact({
		authorityId: runtimeId("authority"),
		tenantId: runtimeId("tenant"),
		principalId: runtimeId("principal"),
		receiptId: runtimeId("receipt"),
		requestId: runtimeId("command"),
		profileId: runtimeId("resource"),
		requested: token,
		resolved: token,
		policyDigest: digest,
		backendId: token,
		effectiveEnforcement: Type.Union([Type.Literal("enforced"), Type.Literal("off")]),
		invocationDigest: digest,
	}),
	exact({
		authorityId: runtimeId("authority"),
		tenantId: runtimeId("tenant"),
		principalId: runtimeId("principal"),
		receiptId: runtimeId("receipt"),
		requestId: runtimeId("command"),
		profileId: runtimeId("resource"),
		requested: token,
		resolved: token,
		policyDigest: digest,
		backendId: token,
		effectiveEnforcement: Type.Union([Type.Literal("degraded"), Type.Literal("unavailable")]),
		invocationDigest: digest,
		reasonDigest: digest,
	}),
]);

const ExitSchema = exact({
	code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]),
	signal: Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]),
	timedOut: Type.Boolean(),
});

const RunnerIdentitySchema = exact({
	issuerId: token,
	runnerId: runtimeId("principal"),
	version: token,
	identityDigest: digest,
});

export const VerificationExecutionEvidenceSchema = exact({
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	verificationId: runtimeId("verification"),
	invocationDigest: digest,
	sandboxReceipt: SandboxReceiptSchema,
	exit: ExitSchema,
	artifacts: Type.Array(ArtifactEvidenceReceiptSchema, { maxItems: 256 }),
	browserExecution: Type.Optional(BrowserExecutionReceiptSchema),
	startedAt: timestamp,
	finishedAt: timestamp,
	runner: RunnerIdentitySchema,
	evidenceDigest: digest,
});

export const VerificationResultSchema = exact({
	schemaVersion: Type.Literal(VERIFICATION_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	verificationId: runtimeId("verification"),
	gateId: token,
	gateDigest: digest,
	baseline: TrustedBaselineReceiptSchema,
	candidate: CandidateIdentitySchema,
	command: VerificationInvocationSchema,
	admission: Type.Unknown(),
	exit: ExitSchema,
	artifacts: Type.Array(ArtifactEvidenceReceiptSchema, { maxItems: 256 }),
	browserExecution: Type.Optional(BrowserExecutionReceiptSchema),
	startedAt: timestamp,
	finishedAt: timestamp,
	runner: RunnerIdentitySchema,
	outcome: Type.Union(VERIFICATION_OUTCOMES.map((outcome) => Type.Literal(outcome))),
	reasonCodes: Type.Array(token, { maxItems: 256 }),
	resultDigest: digest,
});

function failure(
	code: "invalid_schema" | "invalid_digest" | "scope_mismatch" | "stale_evidence" | "cross_commit_evidence" | "artifact_invalid",
	message: string,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function artifactReceiptBody(receipt: ArtifactEvidenceReceipt): Omit<ArtifactEvidenceReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function browserReceiptBody(receipt: BrowserExecutionReceipt): Omit<BrowserExecutionReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function browserOperationReceiptDigest(
	receipt: Omit<BrowserOperationReceipt, "receiptDigest">,
): string {
	return canonicalDigest(receipt);
}

export function browserOperationReceiptsDigest(receipts: readonly BrowserOperationReceipt[]): string {
	return canonicalDigest(receipts);
}

export function browserEvidenceArtifactsDigest(receipts: readonly ArtifactEvidenceReceipt[]): string {
	return canonicalDigest(
		[...receipts]
			.map((receipt) => ({
				outputName: receipt.outputName,
				receiptDigest: receipt.receiptDigest,
				artifactId: receipt.artifact.artifactId,
				storedDigest: receipt.artifact.storedDigest,
				kind: receipt.artifact.kind,
				candidateCommit: receipt.candidateCommit,
			}))
			.sort((left, right) => left.outputName.localeCompare(right.outputName)),
	);
}

export function browserExecutionBindingDigest(
	receipt: Pick<
		BrowserExecutionReceipt,
		| "gateDigest"
		| "runtimeResourceId"
		| "runtimeIdentityDigest"
		| "profileResourceId"
		| "profileIdentityDigest"
		| "profilePolicyDigest"
		| "entryUrl"
		| "origin"
		| "networkPolicyDigest"
		| "candidateCommit"
		| "candidateIdentityDigest"
	>,
): string {
	return canonicalDigest({
		gateDigest: receipt.gateDigest,
		runtimeResourceId: receipt.runtimeResourceId,
		runtimeIdentityDigest: receipt.runtimeIdentityDigest,
		profileResourceId: receipt.profileResourceId,
		profileIdentityDigest: receipt.profileIdentityDigest,
		profilePolicyDigest: receipt.profilePolicyDigest,
		entryUrl: receipt.entryUrl,
		origin: receipt.origin,
		networkPolicyDigest: receipt.networkPolicyDigest,
		candidateCommit: receipt.candidateCommit,
		candidateIdentityDigest: receipt.candidateIdentityDigest,
	});
}

export function isBrowserOperationReceipt(value: unknown): value is BrowserOperationReceipt {
	if (!Check(BrowserOperationReceiptSchema, value)) return false;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const receipt = value as Record<string, unknown>;
	if (
		typeof receipt.operationId !== "string" ||
		typeof receipt.sandboxReceiptId !== "string" ||
		typeof receipt.backendReceiptId !== "string" ||
		!parseRuntimeId("command", receipt.operationId) ||
		!parseRuntimeId("receipt", receipt.sandboxReceiptId) ||
		!parseRuntimeId("receipt", receipt.backendReceiptId)
	) return false;
	const expectedCapability =
		receipt.kind === "network"
			? "network"
			: receipt.kind === "cookie_credential" && receipt.access === "credential"
				? "credential"
				: "browser";
	const { receiptDigest, ...body } = receipt;
	return (
		receipt.capability === expectedCapability &&
		typeof receiptDigest === "string" &&
		receiptDigest === canonicalDigest(body)
	);
}

export function isBrowserExecutionReceipt(value: unknown): value is BrowserExecutionReceipt {
	if (!Check(BrowserExecutionReceiptSchema, value)) return false;
	const receipt = value as unknown as BrowserExecutionReceipt;
	const operationIds = new Set(receipt.operationReceipts.map((entry) => entry.operationId));
	const requiredKinds = [
		"launch",
		"network",
		"navigate",
		"screenshot",
		"dom_read",
		"console_read",
		"network_evidence",
		"evidence_seal",
	] as const;
	const navigate = receipt.operationReceipts.find((entry) => entry.kind === "navigate");
	const network = receipt.operationReceipts.find((entry) => entry.kind === "network");
	const dom = receipt.operationReceipts.find((entry) => entry.kind === "dom_read");
	return (
		receipt.candidateIdentityDigest.length === 64 &&
		receipt.bindingDigest === browserExecutionBindingDigest(receipt) &&
		receipt.operationReceipts.every(
			(entry, index) =>
				entry.sequence === index &&
				entry.bindingDigest === receipt.bindingDigest &&
				isBrowserOperationReceipt(entry),
		) &&
		operationIds.size === receipt.operationReceipts.length &&
		requiredKinds.every(
			(kind) => receipt.operationReceipts.filter((entry) => entry.kind === kind).length === 1,
		) &&
		navigate?.urlDigest === canonicalDigest(receipt.entryUrl) &&
		navigate.originDigest === canonicalDigest(receipt.origin) &&
		network?.originDigest === canonicalDigest(receipt.origin) &&
		network.networkPolicyDigest === receipt.networkPolicyDigest &&
		dom?.domScopeDigest === receipt.stepSchemaDigest &&
		receipt.operationReceipts[0]?.kind === "launch" &&
		receipt.operationReceipts.at(-1)?.kind === "evidence_seal" &&
		receipt.operationReceiptsDigest === browserOperationReceiptsDigest(receipt.operationReceipts) &&
		receipt.receiptDigest === canonicalDigest(browserReceiptBody(receipt))
	);
}

function evidenceBody(evidence: VerificationExecutionEvidence): Omit<VerificationExecutionEvidence, "evidenceDigest"> {
	const { evidenceDigest: _evidenceDigest, ...body } = evidence;
	return body;
}

function invocationBody(invocation: VerificationInvocation): Omit<VerificationInvocation, "invocationDigest"> {
	const { invocationDigest: _invocationDigest, ...body } = invocation;
	return body;
}

function resultBody(result: VerificationResult): VerificationResultBody {
	const { resultDigest: _resultDigest, ...body } = result;
	return body;
}

export function isArtifactEvidenceReceipt(value: unknown): value is ArtifactEvidenceReceipt {
	if (!Check(ArtifactEvidenceReceiptSchema, value)) return false;
	const { receiptDigest, ...body } = value;
	return receiptDigest === canonicalDigest(body);
}

export function isVerificationExecutionEvidence(value: unknown): value is VerificationExecutionEvidence {
	if (!Check(VerificationExecutionEvidenceSchema, value)) return false;
	const { evidenceDigest, ...body } = value;
	return (
		isSandboxExecutionReceiptRef(value.sandboxReceipt) &&
		value.artifacts.every(isArtifactEvidenceReceipt) &&
		(value.browserExecution === undefined || isBrowserExecutionReceipt(value.browserExecution)) &&
		value.runner.identityDigest === canonicalDigest({
			issuerId: value.runner.issuerId,
			runnerId: value.runner.runnerId,
			version: value.runner.version,
		}) &&
		evidenceDigest === canonicalDigest(body) &&
		Date.parse(value.finishedAt) >= Date.parse(value.startedAt)
	);
}

export function isVerificationResult(value: unknown): value is VerificationResult {
	if (!Check(VerificationResultSchema, value)) return false;
	const { resultDigest, ...body } = value;
	const { invocationDigest, ...invocationBodyValue } = value.command;
	return (
		isTrustedBaselineReceipt(value.baseline) &&
		isVerificationAdmissionBundle(value.admission) &&
		invocationDigest === canonicalDigest(invocationBodyValue) &&
		value.artifacts.every(isArtifactEvidenceReceipt) &&
		(value.browserExecution === undefined || isBrowserExecutionReceipt(value.browserExecution)) &&
		value.runner.identityDigest === canonicalDigest({
			issuerId: value.runner.issuerId,
			runnerId: value.runner.runnerId,
			version: value.runner.version,
		}) &&
		resultDigest === canonicalDigest(body)
	);
}

function expectedByName(expected: readonly GateExpectedArtifact[]): ReadonlyMap<string, GateExpectedArtifact> {
	return new Map(expected.map((entry) => [entry.name, entry]));
}

export function validateExecutionEvidence(
	evidence: VerificationExecutionEvidence,
	invocation: VerificationInvocation,
): VerificationCoreResult<void> {
	if (!isVerificationExecutionEvidence(evidence)) return failure("invalid_schema", "execution evidence schema or digest is invalid");
	if (invocation.invocationDigest !== canonicalDigest(invocationBody(invocation))) {
		return failure("invalid_digest", "typed invocation digest is invalid");
	}
	if (
		evidence.authorityId !== invocation.candidate.authorityId ||
		evidence.tenantId !== invocation.candidate.tenantId ||
		evidence.requestId !== invocation.requestId ||
		evidence.verificationId !== invocation.verificationId ||
		evidence.invocationDigest !== invocation.invocationDigest ||
		evidence.sandboxReceipt.requestId !== invocation.requestId ||
		evidence.sandboxReceipt.invocationDigest !== invocation.invocationDigest ||
		evidence.sandboxReceipt.policyDigest !== invocation.sandbox.policyDigest
	) return failure("scope_mismatch", "execution evidence is not correlated with invocation");
	if ((invocation.browser === undefined) !== (evidence.browserExecution === undefined)) {
		return failure("artifact_invalid", "browser execution receipt presence does not match the gate kind");
	}
	if (invocation.browser && evidence.browserExecution) {
		const browser = evidence.browserExecution;
		if (
			browser.authorityId !== invocation.candidate.authorityId ||
			browser.tenantId !== invocation.candidate.tenantId ||
			browser.requestId !== invocation.requestId ||
			browser.verificationId !== invocation.verificationId ||
			browser.gateDigest !== invocation.gateDigest ||
			browser.runtimeResourceId !== invocation.browser.runtime.resourceId ||
			browser.runtimeIdentityDigest !== invocation.browser.runtime.identityDigest ||
			browser.profileResourceId !== invocation.browser.profile.resourceId ||
			browser.profileIdentityDigest !== invocation.browser.profile.identityDigest ||
			browser.profilePolicyDigest !== invocation.browser.profile.policyDigest ||
			browser.entryUrl !== invocation.browser.entryUrl ||
			browser.origin !== invocation.browser.origin ||
			browser.stepSchemaDigest !== invocation.browser.stepSchemaDigest ||
			browser.stepsDigest !== invocation.browser.stepsDigest ||
			browser.assertionSchemaDigest !== invocation.browser.assertionSchemaDigest ||
			browser.trustedAssertionsDigest !== invocation.browser.trustedAssertionsDigest ||
			browser.networkPolicyDigest !== invocation.browser.networkPolicyDigest ||
			browser.candidateCommit !== invocation.candidate.candidateCommit ||
			browser.candidateIdentityDigest !== canonicalDigest(invocation.candidate) ||
			browser.evidenceArtifactsDigest !== browserEvidenceArtifactsDigest(evidence.artifacts)
		) return failure("cross_commit_evidence", "browser execution receipt is not bound to the trusted gate and candidate");
		const evidenceOperationByKind = new Map<string, string>();
		for (const operation of browser.operationReceipts) {
			switch (operation.kind) {
				case "screenshot":
					evidenceOperationByKind.set("screenshot", operation.outputName);
					break;
				case "dom_read":
					evidenceOperationByKind.set("dom_snapshot", operation.outputName);
					break;
				case "console_read":
					evidenceOperationByKind.set("console_log", operation.outputName);
					break;
				case "network_evidence":
					evidenceOperationByKind.set("network_trace", operation.outputName);
					break;
			}
		}
		if (
			evidence.artifacts.some(
				(artifact) => evidenceOperationByKind.get(artifact.artifact.kind) !== artifact.outputName,
			)
		) return failure("artifact_invalid", "browser Artifact is not bound to its capture operation receipt");
	}
	const expected = expectedByName(invocation.expectedArtifacts);
	const names = new Set<string>();
	const artifactIds = new Set<string>();
	for (const receipt of evidence.artifacts) {
		if (names.has(receipt.outputName) || artifactIds.has(receipt.artifact.artifactId)) {
			return failure("artifact_invalid", "execution evidence reuses an output name or artifact");
		}
		names.add(receipt.outputName);
		artifactIds.add(receipt.artifact.artifactId);
		const declared = expected.get(receipt.outputName);
		if (!declared) return failure("artifact_invalid", "execution evidence contains an undeclared artifact");
		if (receipt.candidateCommit !== invocation.candidate.candidateCommit) {
			return failure("cross_commit_evidence", "artifact evidence belongs to another candidate commit");
		}
		if (
			receipt.authorityId !== invocation.candidate.authorityId ||
			receipt.tenantId !== invocation.candidate.tenantId ||
			receipt.requestId !== invocation.requestId ||
			receipt.verificationId !== invocation.verificationId ||
			receipt.artifact.authorityId !== invocation.candidate.authorityId ||
			receipt.artifact.tenantId !== invocation.candidate.tenantId ||
			receipt.artifact.workspaceId !== invocation.candidate.workspaceId
		) return failure("scope_mismatch", "artifact evidence scope does not match candidate");
		if (
			receipt.artifact.kind !== declared.kind ||
			receipt.artifact.mediaType !== declared.mediaType ||
			receipt.schemaDigest !== declared.schemaDigest ||
			receipt.artifact.storedSize > declared.maxBytes
		) return failure("artifact_invalid", "artifact evidence does not match the trusted expected schema");
	}
	for (const declared of invocation.expectedArtifacts) {
		if (declared.required && !names.has(declared.name)) return failure("artifact_invalid", `required artifact is missing: ${declared.name}`);
	}
	return { ok: true, value: undefined };
}

function determineOutcome(
	evidence: VerificationExecutionEvidence,
	invocation: VerificationInvocation,
): { outcome: VerificationOutcome; reasons: string[] } {
	const reasons: string[] = [];
	if (
		invocation.sandbox.requireEnforced &&
		evidence.sandboxReceipt.effectiveEnforcement !== "enforced"
	) reasons.push("sandbox_not_enforced");
	if (evidence.artifacts.some((entry) => entry.validation === "unavailable")) reasons.push("artifact_validation_unavailable");
	if (evidence.artifacts.some((entry) => entry.lineageStatus !== "verified")) reasons.push("artifact_lineage_unverified");
	if (reasons.length > 0) return { outcome: "inconclusive", reasons };
	if (evidence.exit.timedOut) reasons.push("timeout");
	if (evidence.exit.code === null || !invocation.expectedExitCodes.includes(evidence.exit.code)) reasons.push("unexpected_exit");
	if (evidence.artifacts.some((entry) => entry.validation === "invalid")) reasons.push("artifact_schema_invalid");
	return reasons.length > 0 ? { outcome: "failed", reasons } : { outcome: "passed", reasons: ["trusted_gate_passed"] };
}

export function createVerificationResult(
	baseline: VerificationResultBody["baseline"],
	invocation: VerificationInvocation,
	evidence: VerificationExecutionEvidence,
	admission: VerificationAdmissionBundle,
): VerificationCoreResult<VerificationResult> {
	const validation = validateExecutionEvidence(evidence, invocation);
	if (!validation.ok) return validation;
	if (
		!isVerificationAdmissionBundle(admission) ||
		admission.outcome !== "passed" ||
		admission.authorityId !== invocation.candidate.authorityId ||
		admission.tenantId !== invocation.candidate.tenantId ||
		admission.requestId !== invocation.requestId ||
		admission.verificationId !== invocation.verificationId ||
		admission.gateDigest !== invocation.gateDigest ||
		admission.candidateCommit !== invocation.candidate.candidateCommit
	) return failure("artifact_invalid", "verification admission receipt is missing, non-passing, or uncorrelated");
	const decision = determineOutcome(evidence, invocation);
	const body: VerificationResultBody = {
		schemaVersion: VERIFICATION_SCHEMA_VERSION,
		authorityId: invocation.candidate.authorityId,
		tenantId: invocation.candidate.tenantId,
		verificationId: invocation.verificationId,
		gateId: invocation.gateId,
		gateDigest: invocation.gateDigest,
		baseline,
		candidate: invocation.candidate,
		command: invocation,
		admission,
		exit: evidence.exit,
		artifacts: evidence.artifacts,
		...(evidence.browserExecution ? { browserExecution: evidence.browserExecution } : {}),
		startedAt: evidence.startedAt,
		finishedAt: evidence.finishedAt,
		runner: evidence.runner,
		outcome: decision.outcome,
		reasonCodes: decision.reasons,
	};
	const result: VerificationResult = { ...body, resultDigest: canonicalDigest(body) };
	return isVerificationResult(result)
		? { ok: true, value: result }
		: failure("invalid_schema", "verification result construction failed");
}

export function artifactEvidenceReceiptDigest(receipt: Omit<ArtifactEvidenceReceipt, "receiptDigest">): string {
	return canonicalDigest(receipt);
}

export function executionEvidenceDigest(evidence: Omit<VerificationExecutionEvidence, "evidenceDigest">): string {
	return canonicalDigest(evidence);
}

export function candidateIdentityDigest(candidate: CandidateIdentity): string {
	return canonicalDigest(candidate);
}
