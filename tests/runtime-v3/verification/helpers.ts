import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../../src/runtime/protocol/v3/workspace.ts";
import {
	artifactEvidenceReceiptDigest,
	createVerificationResult,
	executionEvidenceDigest,
} from "../../../src/runtime/verification/evidence.ts";
import { createGateManifest, GATE_MANIFEST_SCHEMA_DIGEST } from "../../../src/runtime/verification/gate-loader.ts";
import {
	createVerificationReport,
	createVerifierReceipt,
	TrustedVerifierIssuerRegistry,
	verifierSignatureInputDigest,
} from "../../../src/runtime/verification/security.ts";
import { createVerificationInvocation } from "../../../src/runtime/verification/runner.ts";
import {
	verificationAdmissionBundleDigest,
} from "../../../src/runtime/verification/admission.ts";
import {
	dependencyAdmissionInputDigest,
	dependencyObservationDigest,
	evaluateDependencyAdmission,
} from "../../../src/runtime/verification/dependency-admission.ts";
import {
	SecretScanGate,
	secretScanCoverageDigest,
	secretScanInventoryDigest,
} from "../../../src/runtime/verification/secret-scan.ts";
import type {
	ArtifactEvidenceReceipt,
	BrowserExecutionReceipt,
	CandidateIdentity,
	DependencyAdmissionPolicy,
	DependencyAdmissionInput,
	DependencyObservation,
	GateManifest,
	GateManifestBody,
	SecretScanPolicy,
	SecretScanCoverage,
	SecretScanInput,
	TrustedBaselineReceipt,
	TrustedVerificationPolicy,
	VerificationExecutionEvidence,
	VerificationAdmissionBundle,
	VerificationAdmissionInput,
	VerificationAdmissionPort,
	VerificationReport,
	VerificationResult,
	VerificationRunnerRequest,
	VerifierIssuerPort,
	VerifierReceipt,
	VerifierReceiptBody,
} from "../../../src/runtime/verification/types.ts";

export const NOW = "2026-07-22T08:00:00.000Z";
export const FINISHED = "2026-07-22T08:00:02.000Z";
export const ISSUED = "2026-07-22T08:00:03.000Z";
export const AUTHORITY_ID = createRuntimeId("authority", "verification-test");
export const TENANT_ID = createRuntimeId("tenant", "verification-test");
export const PRINCIPAL_ID = createRuntimeId("principal", "verification-test");
export const RUNNER_ID = createRuntimeId("principal", "trusted-runner");
export const SESSION_ID = createRuntimeId("session", "verification-test");
export const SESSION_STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
export const AGENT_ID = createRuntimeId("agent", "verification-test");
export const TRACE_ID = createRuntimeId("trace", "verification-test");
export const RUNTIME_ID = createRuntimeId("runtime", "verification-test");
export const REPOSITORY_ID = createRuntimeId("repository", "verification-test");
export const WORKSPACE_ID = createRuntimeId("workspace", "candidate-test");
export const BASE_WORKSPACE_ID = createRuntimeId("workspace", "baseline-test");
export const VERIFICATION_ID = createRuntimeId("verification", "verification-test");
export const REQUEST_ID = createRuntimeId("command", "verification-run");
export const BASE_COMMIT = "1".repeat(40);
export const CANDIDATE_COMMIT = "2".repeat(40);
export const ISSUER_ID = "production-verifier";
export const KEY_ID = "verification-key-v1";

export function digest(seed: string): string {
	return canonicalDigest(seed);
}

export function dependencyPolicy(
	overrides: Partial<Omit<DependencyAdmissionPolicy, "policyDigest">> = {},
): DependencyAdmissionPolicy {
	const candidate: Omit<DependencyAdmissionPolicy, "policyDigest"> = {
		schemaVersion: 1,
		policyId: "trusted-dependencies",
		policyRevision: 1,
		installMode: "frozen",
		lockfileSource: "trusted_baseline",
		lockfilePath: "ci/trusted-gates/package-lock.json",
		lockfileDigest: digest("lockfile"),
		requireLockfileEntry: true,
		requireIntegrityDigest: true,
		allowedRegistries: [{
			registryId: "npmjs",
			source: "https://registry.npmjs.org/",
			identityDigest: digest("registry-npmjs"),
		}],
		minimumPublishAgeMs: 7 * 24 * 60 * 60 * 1_000,
		lifecycleScripts: "deny",
		exceptions: [],
		maxDependencies: 10_000,
		maxFindings: 256,
		...overrides,
	};
	const body: Omit<DependencyAdmissionPolicy, "policyDigest"> = candidate.lockfileSource === "none"
		? (({ lockfilePath: _lockfilePath, lockfileDigest: _lockfileDigest, ...rest }) => rest)(candidate)
		: candidate;
	return { ...body, policyDigest: canonicalDigest(body) };
}

export function secretScanPolicy(
	overrides: Partial<Omit<SecretScanPolicy, "policyDigest">> = {},
): SecretScanPolicy {
	const body: Omit<SecretScanPolicy, "policyDigest"> = {
		schemaVersion: 1,
		policyId: "trusted-secret-scan",
		policyRevision: 1,
		rules: [{
			ruleId: "credential-assignment",
			label: "credential assignment",
			pattern: "(?:api[_-]?key|token|password)\\s*[:=]\\s*[A-Za-z0-9_~-]{12,}",
			caseSensitive: false,
		}],
		allowlist: [],
		requiredScopes: [
			"candidate_diff",
			"tracked_workspace",
			"untracked_workspace",
			"pending_artifact",
			"generated_config",
		],
		maxItems: 10_000,
		maxInputBytes: 64 * 1024 * 1024,
		maxFindings: 256,
		...overrides,
	};
	return { ...body, policyDigest: canonicalDigest(body) };
}

export function gateManifest(overrides: Partial<GateManifestBody> = {}): GateManifest {
	const body: GateManifestBody = {
		schemaVersion: 1,
		gateId: "trusted-test",
		gateVersion: 1,
		kind: "test",
		executable: { source: "trusted_baseline", path: "ci/trusted-gates/run-tests", digest: digest("executable") },
		arguments: [
			{ kind: "literal", value: "--format=json" },
			{ kind: "candidate_path", relativePath: "." },
			{ kind: "artifact_output", name: "test-report" },
		],
		cwd: { source: "candidate_workspace", relativePath: "." },
		baseConfiguration: [{ path: "ci/trusted-gates/vitest.config.ts", digest: digest("config") }],
		dependencyPolicy: dependencyPolicy(),
		secretScanPolicy: secretScanPolicy(),
		environment: {
			inherit: false,
			allowlist: ["CI", "PATH"],
			values: [
				{ name: "CI", source: "fixed", value: "1" },
				{ name: "PATH", source: "trusted_runner" },
			],
		},
		sandbox: { profile: "strict", policyDigest: digest("sandbox-policy"), requireEnforced: true },
		network: { mode: "deny", hosts: [] },
		timeoutMs: 120_000,
		expectedExitCodes: [0],
		expectedArtifacts: [
			{
				name: "test-report",
				kind: "test_report",
				mediaType: "application/json",
				schemaDigest: digest("test-report-schema"),
				required: true,
				maxBytes: 1_000_000,
			},
		],
		...overrides,
	};
	const created = createGateManifest(body);
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

export function policy(manifest: GateManifest = gateManifest()): TrustedVerificationPolicy {
	const body: Omit<TrustedVerificationPolicy, "policyDigest"> = {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		policyId: "runtime-trusted-gates",
		policyRevision: 4,
		repositoryId: REPOSITORY_ID,
		baseCommit: BASE_COMMIT,
		baseBranch: "main",
		protectedRoot: "/trusted/base",
		gateManifestPath: "ci/trusted-gates/test.json",
		expectedGateManifestDigest: manifest.manifestDigest,
		gateSchemaDigest: GATE_MANIFEST_SCHEMA_DIGEST,
	};
	return { ...body, policyDigest: canonicalDigest(body) };
}

export function baselineReceipt(gatePolicy: TrustedVerificationPolicy = policy()): TrustedBaselineReceipt {
	const body: Omit<TrustedBaselineReceipt, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		receiptId: createRuntimeId("receipt", "trusted-baseline"),
		policyId: gatePolicy.policyId,
		policyRevision: gatePolicy.policyRevision,
		policyDigest: gatePolicy.policyDigest,
		repositoryId: REPOSITORY_ID,
		workspaceId: BASE_WORKSPACE_ID,
		bindingDigest: digest("baseline-binding"),
		leaseRevision: 7,
		baseCommit: BASE_COMMIT,
		materializedCommit: BASE_COMMIT,
		protectedRoot: gatePolicy.protectedRoot,
		gateManifestPath: gatePolicy.gateManifestPath,
		gateSchemaDigest: gatePolicy.gateSchemaDigest,
		issuedAt: NOW,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function candidate(commit = CANDIDATE_COMMIT): CandidateIdentity {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		repositoryId: REPOSITORY_ID,
		workspaceId: WORKSPACE_ID,
		baseCommit: BASE_COMMIT,
		candidateCommit: commit,
		bindingDigest: digest("candidate-binding"),
	};
}

export function candidateEnvelope(): WorkspaceExecutionEnvelope {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		workspaceId: WORKSPACE_ID,
		repositoryId: REPOSITORY_ID,
		worktreePath: "/candidate/worktree",
		branch: "agent/change",
		baseCommit: BASE_COMMIT,
		agentId: AGENT_ID,
		toolCallId: createRuntimeId("toolCall", "verification-test"),
		traceId: TRACE_ID,
		cwd: "/candidate/worktree",
		ownerRuntimeId: RUNTIME_ID,
		leaseRevision: 11,
		fencingToken: "opaque-candidate-fence",
	};
}

export const ADMISSION_SOURCE_ID = "trusted-admission-collector";
export const ADMISSION_SOURCE_DIGEST = digest("trusted-admission-collector-identity");

function dependencyInputFor(
	manifest: Pick<GateManifest, "manifestDigest" | "dependencyPolicy">,
	requestId = REQUEST_ID,
	verificationId = VERIFICATION_ID,
	identity = candidate(),
): DependencyAdmissionInput {
	const dependencies: DependencyObservation[] = manifest.dependencyPolicy.installMode === "none" ? [] : [(() => {
		const body: Omit<DependencyObservation, "observationDigest"> = {
			packageName: "trusted-package",
			version: "1.2.3",
			registryId: "npmjs",
			source: "https://registry.npmjs.org/",
			registryIdentityDigest: digest("registry-npmjs"),
			integrityDigest: digest("trusted-package-integrity"),
			lockfileIntegrityDigest: digest("trusted-package-integrity"),
			lockfileEntryDigest: digest("trusted-package-lock-entry"),
			publishedAt: "2026-06-01T00:00:00.000Z",
			lifecycleScripts: [],
		};
		return { ...body, observationDigest: dependencyObservationDigest(body) };
	})()];
	const body: Omit<DependencyAdmissionInput, "evidenceDigest"> = {
		schemaVersion: 1,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		requestId,
		verificationId,
		gateDigest: manifest.manifestDigest,
		candidateCommit: identity.candidateCommit,
		policyDigest: manifest.dependencyPolicy.policyDigest,
		collectorId: ADMISSION_SOURCE_ID,
		collectorIdentityDigest: ADMISSION_SOURCE_DIGEST,
		lockfile: manifest.dependencyPolicy.lockfileSource === "none"
			? { entryCount: dependencies.length, complete: true }
			: {
				path: manifest.dependencyPolicy.lockfilePath,
				observedDigest: manifest.dependencyPolicy.lockfileDigest,
				entryCount: dependencies.length,
				complete: true,
			},
		manifestInventoryDigest: digest("dependency-manifest-inventory"),
		manifestCount: 1,
		dependencies,
		truncated: false,
		collectedAt: NOW,
	};
	return { ...body, evidenceDigest: dependencyAdmissionInputDigest(body) };
}

function secretInputFor(
	manifest: Pick<GateManifest, "manifestDigest" | "secretScanPolicy">,
	requestId = REQUEST_ID,
	verificationId = VERIFICATION_ID,
	identity = candidate(),
): SecretScanInput {
	const coverage: SecretScanCoverage[] = manifest.secretScanPolicy.requiredScopes.map((scope) => {
		const body: Omit<SecretScanCoverage, "inventoryDigest"> = {
			scope,
			complete: true,
			itemCount: 0,
			itemDigests: [],
		};
		return { ...body, inventoryDigest: secretScanCoverageDigest(body) };
	});
	return {
		schemaVersion: 1,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		requestId,
		verificationId,
		gateDigest: manifest.manifestDigest,
		candidateCommit: identity.candidateCommit,
		policyDigest: manifest.secretScanPolicy.policyDigest,
		scannerId: ADMISSION_SOURCE_ID,
		scannerIdentityDigest: ADMISSION_SOURCE_DIGEST,
		coverage,
		items: [],
		truncated: false,
		collectedAt: NOW,
		inventoryDigest: secretScanInventoryDigest(coverage),
	};
}

export function admissionBundleForRequest(request: {
	manifest: GateManifest;
	requestId: typeof REQUEST_ID;
	verificationId: typeof VERIFICATION_ID;
	candidate: CandidateIdentity;
}): VerificationAdmissionBundle {
	return admissionBundleFor({
		dependencyPolicy: request.manifest.dependencyPolicy,
		secretScanPolicy: request.manifest.secretScanPolicy,
		gateDigest: request.manifest.manifestDigest,
		requestId: request.requestId,
		verificationId: request.verificationId,
		candidate: request.candidate,
	});
}

export function admissionInputForRequest(request: VerificationRunnerRequest): VerificationAdmissionInput {
	return {
		dependency: dependencyInputFor(
			request.manifest,
			request.requestId,
			request.verificationId,
			request.candidate,
		),
		secretScan: secretInputFor(
			request.manifest,
			request.requestId,
			request.verificationId,
			request.candidate,
		),
	};
}

function admissionBundleFor(request: {
	dependencyPolicy: DependencyAdmissionPolicy;
	secretScanPolicy: SecretScanPolicy;
	gateDigest: string;
	requestId: typeof REQUEST_ID;
	verificationId: typeof VERIFICATION_ID;
	candidate: CandidateIdentity;
}): VerificationAdmissionBundle {
	const manifest = {
		manifestDigest: request.gateDigest,
		dependencyPolicy: request.dependencyPolicy,
		secretScanPolicy: request.secretScanPolicy,
	};
	const dependency = evaluateDependencyAdmission(
		request.dependencyPolicy,
		dependencyInputFor(manifest, request.requestId, request.verificationId, request.candidate),
		{
			clock: () => new Date(FINISHED),
			expectedCollectorId: ADMISSION_SOURCE_ID,
			expectedCollectorIdentityDigest: ADMISSION_SOURCE_DIGEST,
		},
	);
	const secretScan = new SecretScanGate({ clock: () => new Date(FINISHED) }).evaluate(
		request.secretScanPolicy,
		secretInputFor(manifest, request.requestId, request.verificationId, request.candidate),
		{
			expectedScannerId: ADMISSION_SOURCE_ID,
			expectedScannerIdentityDigest: ADMISSION_SOURCE_DIGEST,
		},
	);
	if (!dependency.ok || !secretScan.ok || dependency.value.outcome !== "passed" || secretScan.value.outcome !== "passed") {
		throw new Error("failed to create passing admission fixture");
	}
	const body: Omit<VerificationAdmissionBundle, "bundleDigest"> = {
		schemaVersion: 1,
		authorityId: request.candidate.authorityId,
		tenantId: request.candidate.tenantId,
		requestId: request.requestId,
		verificationId: request.verificationId,
		gateDigest: request.gateDigest,
		candidateCommit: request.candidate.candidateCommit,
		dependency: dependency.value,
		secretScan: secretScan.value,
		outcome: "passed",
		reasonCodes: [],
	};
	return { ...body, bundleDigest: verificationAdmissionBundleDigest(body) };
}

export function admissionBundle(command = invocation()): VerificationAdmissionBundle {
	return admissionBundleFor({
		dependencyPolicy: command.dependencyPolicy,
		secretScanPolicy: command.secretScanPolicy,
		gateDigest: command.gateDigest,
		requestId: command.requestId,
		verificationId: command.verificationId,
		candidate: command.candidate,
	});
}

export function passingAdmissionPort(): VerificationAdmissionPort {
	return {
		evaluate: async (request) => ({ ok: true, value: admissionBundleForRequest(request) }),
	};
}

export function artifactReceipt(input: {
	candidateCommit?: string;
	requestId?: ArtifactEvidenceReceipt["requestId"];
	verificationId?: ArtifactEvidenceReceipt["verificationId"];
	validation?: ArtifactEvidenceReceipt["validation"];
	lineageStatus?: ArtifactEvidenceReceipt["lineageStatus"];
	outputName?: string;
	kind?: ArtifactEvidenceReceipt["artifact"]["kind"];
	mediaType?: string;
	schemaDigest?: string;
	artifactSeed?: string;
} = {}): ArtifactEvidenceReceipt {
	const body: Omit<ArtifactEvidenceReceipt, "receiptDigest"> = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		receiptId: createRuntimeId("receipt", "artifact-evidence"),
		requestId: input.requestId ?? REQUEST_ID,
		verificationId: input.verificationId ?? VERIFICATION_ID,
		outputName: input.outputName ?? "test-report",
		artifact: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			artifactId: createRuntimeId("artifact", input.artifactSeed ?? "test-report"),
			storedDigest: digest("stored-test-report"),
			kind: input.kind ?? "test_report",
			originalSize: 128,
			storedSize: 96,
			mediaType: input.mediaType ?? "application/json",
			redaction: "redacted",
			transformReceipt: createRuntimeId("receipt", "artifact-transform"),
			workspaceId: WORKSPACE_ID,
		},
		candidateCommit: input.candidateCommit ?? CANDIDATE_COMMIT,
		schemaDigest: input.schemaDigest ?? digest("test-report-schema"),
		validation: input.validation ?? "valid",
		lineageStatus: input.lineageStatus ?? "verified",
		lineageDigest: digest("artifact-lineage"),
		taintUpperBound: ["candidate_controlled"],
		validatorId: RUNNER_ID,
		validatedAt: FINISHED,
	};
	return { ...body, receiptDigest: artifactEvidenceReceiptDigest(body) };
}

export function executionEvidence(input: {
	invocationDigest: string;
	exitCode?: number | null;
	artifacts?: readonly ArtifactEvidenceReceipt[];
	enforcement?: "enforced" | "degraded";
	verificationId?: VerificationExecutionEvidence["verificationId"];
	requestId?: VerificationExecutionEvidence["requestId"];
	sandboxReceipt?: VerificationExecutionEvidence["sandboxReceipt"];
	browserExecution?: BrowserExecutionReceipt;
}): VerificationExecutionEvidence {
	const runner = {
		issuerId: ISSUER_ID,
		runnerId: RUNNER_ID,
		version: "1.0.0",
		identityDigest: canonicalDigest({ issuerId: ISSUER_ID, runnerId: RUNNER_ID, version: "1.0.0" }),
	};
	const enforcement = input.enforcement ?? "enforced";
	const requestId = input.requestId ?? REQUEST_ID;
	const verificationId = input.verificationId ?? VERIFICATION_ID;
	const sandboxReceipt: VerificationExecutionEvidence["sandboxReceipt"] = input.sandboxReceipt ?? {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", "sandbox-execution"),
		requestId,
		profileId: createRuntimeId("resource", "sandbox-profile"),
		requested: "strict" as const,
		resolved: "strict" as const,
		policyDigest: digest("sandbox-policy"),
		backendId: "fake-sandbox",
		effectiveEnforcement: enforcement,
		invocationDigest: input.invocationDigest,
		...(enforcement === "degraded" ? { reasonDigest: digest("sandbox-degraded") } : {}),
	};
	const body: Omit<VerificationExecutionEvidence, "evidenceDigest"> = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		requestId,
		verificationId,
		invocationDigest: input.invocationDigest,
		sandboxReceipt,
		exit: { code: input.exitCode === undefined ? 0 : input.exitCode, signal: null, timedOut: false },
		artifacts: input.artifacts ?? [artifactReceipt()],
		...(input.browserExecution ? { browserExecution: input.browserExecution } : {}),
		startedAt: NOW,
		finishedAt: FINISHED,
		runner,
	};
	return { ...body, evidenceDigest: executionEvidenceDigest(body) };
}

export function invocation(input: {
	manifest?: GateManifest;
	baseline?: TrustedBaselineReceipt;
	candidate?: CandidateIdentity;
	verificationId?: VerificationExecutionEvidence["verificationId"];
	requestId?: VerificationExecutionEvidence["requestId"];
} = {}) {
	const created = createVerificationInvocation(
		{
			manifest: input.manifest ?? gateManifest(),
			baseline: input.baseline ?? baselineReceipt(),
			candidate: input.candidate ?? candidate(),
			candidateEnvelope: candidateEnvelope(),
			verificationId: input.verificationId ?? VERIFICATION_ID,
			requestId: input.requestId ?? REQUEST_ID,
		},
		{ PATH: "/trusted/bin" },
	);
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

export function verificationResult(input: {
	manifest?: GateManifest;
	baseline?: TrustedBaselineReceipt;
	candidate?: CandidateIdentity;
	verificationId?: VerificationExecutionEvidence["verificationId"];
	requestId?: VerificationExecutionEvidence["requestId"];
	exitCode?: number | null;
	enforcement?: "enforced" | "degraded";
	artifacts?: readonly ArtifactEvidenceReceipt[];
} = {}): VerificationResult {
	const selectedCandidate = input.candidate ?? candidate();
	const selectedVerificationId = input.verificationId ?? VERIFICATION_ID;
	const selectedRequestId = input.requestId ?? REQUEST_ID;
	const command = invocation({
		manifest: input.manifest,
		baseline: input.baseline,
		candidate: selectedCandidate,
		verificationId: selectedVerificationId,
		requestId: selectedRequestId,
	});
	const artifacts = input.artifacts ?? [artifactReceipt({
		candidateCommit: selectedCandidate.candidateCommit,
		verificationId: selectedVerificationId,
		requestId: selectedRequestId,
	})];
	const evidence = executionEvidence({
		invocationDigest: command.invocationDigest,
		exitCode: input.exitCode,
		enforcement: input.enforcement,
		artifacts,
		verificationId: selectedVerificationId,
		requestId: selectedRequestId,
	});
	const created = createVerificationResult(
		input.baseline ?? baselineReceipt(),
		command,
		evidence,
		admissionBundle(command),
	);
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

export function makeReceipt(result: VerificationResult): VerifierReceipt {
	const body: VerifierReceiptBody = {
		schemaVersion: 1,
		authorityId: result.authorityId,
		tenantId: result.tenantId,
		receiptId: createRuntimeId("receipt", `verifier-${result.outcome}`),
		verificationId: result.verificationId,
		issuerId: ISSUER_ID,
		resultDigest: result.resultDigest,
		gateDigest: result.gateDigest,
		baselineReceiptDigest: result.baseline.receiptDigest,
		candidateCommit: result.candidate.candidateCommit,
		outcome: result.outcome,
		issuedAt: ISSUED,
	};
	const inputDigest = verifierSignatureInputDigest(body);
	const created = createVerifierReceipt(body, {
		algorithm: "hmac-sha256",
		keyId: KEY_ID,
		value: canonicalDigest({ key: "test-secret", inputDigest }),
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

export function registry(environment: "production" | "test" = "test"): TrustedVerifierIssuerRegistry {
	const instance = new TrustedVerifierIssuerRegistry({
		environment,
		clock: () => new Date("2026-07-22T08:00:04.000Z"),
	});
	const registered = instance.register({
		issuerId: ISSUER_ID,
		environment: "production",
		schemaVersions: [1],
		algorithms: ["hmac-sha256"],
		keyIds: [KEY_ID],
		verify: (inputDigest, signature) => signature.value === canonicalDigest({ key: "test-secret", inputDigest }),
	});
	if (!registered.ok) throw new Error(registered.error.message);
	return instance;
}

export function reportFor(result: VerificationResult): VerificationReport {
	const report = createVerificationReport(result, makeReceipt(result));
	if (!report.ok) throw new Error(report.error.message);
	return report.value;
}

export class FakeIssuer implements VerifierIssuerPort {
	public async issue(result: VerificationResult) {
		return { ok: true as const, value: makeReceipt(result) };
	}
}
