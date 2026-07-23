import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactCasStore, ArtifactRepository } from "../../../src/runtime/artifacts/cas-store.ts";
import {
	OsKeyringArtifactKeyProvider,
	UnavailableArtifactKeyProvider,
	type ArtifactKeyProviderStatus,
	type OsKeyringPort,
	type OsKeyringReadResult,
} from "../../../src/runtime/artifacts/key-provider.ts";
import { ArtifactMetadataStore } from "../../../src/runtime/artifacts/metadata-store.ts";
import { SessionArtifactJournal } from "../../../src/runtime/artifacts/session-journal.ts";
import type {
	CapabilityGatewayPort,
	CapabilityGatewayRequest,
	CapabilityGatewayResult,
	SandboxExecutorPort,
	SandboxExecutorRequest,
	SecurityPortCancelRequest,
	SecurityPortCancelResult,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, type WorkspaceId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createWorktreeId,
	type WorkspaceExecutionEnvelope,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
} from "../../../src/runtime/protocol/v3/workspace.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { GATE_MANIFEST_SCHEMA_DIGEST } from "../../../src/runtime/verification/gate-loader.ts";
import {
	createProductionVerificationComposition,
	productionVerificationAdmissionAdapterIdentity,
	productionVerificationArtifactAdapterIdentity,
	type ProductionVerificationArtifactPort,
	type ProductionVerificationAdmissionInputPort,
} from "../../../src/runtime/verification/integration/production-composition.ts";
import { runtimeFeatureReadiness } from "../../../src/runtime/integration/dependency-readiness.ts";
import {
	createVerificationReport,
	createVerifierReceipt,
} from "../../../src/runtime/verification/security.ts";
import type {
	GateManifest,
	GateManifestBody,
	TrustedVerificationPolicy,
	VerificationArtifactEvidenceRequest,
	VerificationCoreResult,
	VerificationExecutionEvidence,
	VerificationPipelineRequest,
	VerificationRunnerIdentity,
	VerificationRunnerRequest,
} from "../../../src/runtime/verification/types.ts";
import {
	isBrowserBackendRequest,
	productionBrowserBackendDescriptorDigest,
	type BrowserBackendRequest,
	type BrowserBackendResult,
	type ProductionBrowserBackendDescriptor,
	type ProductionBrowserBackendPort,
} from "../../../src/verification-runner/browser/evidence.ts";
import {
	MemoryWorktreeRegistryMutationPort,
	WorktreeRegistry,
} from "../../../src/worktree/registry.ts";
import type { WorktreeRecord } from "../../../src/worktree/types.ts";
import {
	AGENT_ID,
	ADMISSION_SOURCE_DIGEST,
	ADMISSION_SOURCE_ID,
	AUTHORITY_ID,
	BASE_COMMIT,
	CANDIDATE_COMMIT,
	ISSUER_ID,
	NOW,
	PRINCIPAL_ID,
	REPOSITORY_ID,
	REQUEST_ID,
	RUNNER_ID,
	RUNTIME_ID,
	SESSION_ID,
	SESSION_STREAM,
	TENANT_ID,
	TRACE_ID,
	VERIFICATION_ID,
	WORKSPACE_ID,
	artifactReceipt,
	admissionInputForRequest,
	candidate,
	candidateEnvelope,
	digest,
	executionEvidence,
	gateManifest,
} from "./helpers.ts";

const roots: string[] = [];
const CLOCK = "2026-07-22T08:00:04.000Z";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryOsKeyring implements OsKeyringPort {
	public readonly backend = "os_keyring" as const;
	readonly #key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
	public available = true;

	public async readArtifactKey(version?: string): Promise<OsKeyringReadResult> {
		if (!this.available || (version !== undefined && version !== "verification-v1")) {
			return { status: "unavailable", activeVersion: "verification-v1", availableVersions: ["verification-v1"] };
		}
		return { status: "available", version: "verification-v1", key: Uint8Array.from(this.#key) };
	}

	public async status(): Promise<ArtifactKeyProviderStatus> {
		return this.available
			? { state: "available", activeVersion: "verification-v1", availableVersions: ["verification-v1"], backend: "os_keyring" }
			: { state: "unavailable", availableVersions: [], backend: "os_keyring" };
	}
}

function cancelResult(request: SecurityPortCancelRequest): SecurityPortCancelResult {
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		requestId: request.requestId,
		status: "not_found",
	};
}

class ProductionWorkspacePort implements WorkspaceServicePort {
	public readonly requests: WorkspaceServiceRequest[] = [];
	readonly #baseline: WorktreeRecord;
	readonly #candidate: WorkspaceExecutionEnvelope;

	public constructor(baseline: WorktreeRecord, candidateValue: WorkspaceExecutionEnvelope) {
		this.#baseline = baseline;
		this.#candidate = candidateValue;
	}

	public async request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		this.requests.push(request);
		if (request.kind === "bind") {
			const lease = this.#baseline.lease;
			if (!lease) throw new Error("baseline fixture has no lease");
			return {
				schemaVersion: 1,
				requestId: request.requestId,
				kind: "bound",
				receiptId: createRuntimeId("receipt", "production-baseline-bind"),
				binding: {
					authorityId: this.#baseline.authorityId,
					tenantId: this.#baseline.tenantId,
					workspaceId: this.#baseline.workspaceId,
					repositoryId: this.#baseline.repositoryId,
					bindingKind: "readonly_checkout",
					canonicalCwd: this.#baseline.worktreePath,
					effectiveCwd: this.#baseline.effectiveCwd,
					branch: this.#baseline.branch,
					baseCommit: this.#baseline.baseCommit,
					headCommit: this.#baseline.headCommit,
					...(this.#baseline.worktreeId ? { worktreeId: this.#baseline.worktreeId } : {}),
				},
				lease,
			};
		}
		if (request.kind === "validate") {
			const correlated = request.envelope.workspaceId === this.#candidate.workspaceId;
			return {
				schemaVersion: 1,
				requestId: request.requestId,
				kind: "validated",
				validation: {
					authorityId: request.authorityId,
					tenantId: request.tenantId,
					principalId: request.principalId,
					receiptId: createRuntimeId("receipt", "production-candidate-validation"),
					workspaceId: request.envelope.workspaceId,
					envelopeDigest: request.envelopeDigest,
					validatorId: RUNNER_ID,
					validatedAt: NOW,
					outcome: correlated ? "valid" : "invalid",
				},
			};
		}
		return {
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "rejected",
			code: "unexpected",
			messageDigest: digest("unexpected workspace operation"),
			retryable: false,
		};
	}
}

class RecordingCapabilityGateway implements CapabilityGatewayPort {
	public readonly requests: CapabilityGatewayRequest[] = [];

	public async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		this.requests.push(request);
		return {
			requestId: request.request.requestId,
			decision: "allow",
			decisionDigest: digest("production-verification-allow"),
			sandboxProfile: {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				profileId: createRuntimeId("resource", "production-verification-sandbox"),
				requested: "strict",
				policyDigest: request.request.policyDigest,
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class RecordingSandbox implements SandboxExecutorPort {
	public readonly requests: SandboxExecutorRequest[] = [];

	public async execute(request: SandboxExecutorRequest) {
		this.requests.push(request);
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId("receipt", "production-sandbox-resolution"),
			executionReceipt: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", "production-sandbox-execution"),
				requestId: request.requestId,
				profileId: request.profile.profileId,
				requested: request.profile.requested,
				resolved: request.profile.requested,
				policyDigest: request.profile.policyDigest,
				backendId: "production-test-backend",
				effectiveEnforcement: "enforced" as const,
				invocationDigest: request.invocationDigest,
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class RecordingProductionEvidence implements ProductionVerificationArtifactPort {
	public readonly environment: "production" | "test-only";
	public readonly runnerIdentity: VerificationRunnerIdentity;
	public readonly adapterId = "durable-artifact-evidence-v1";
	public readonly adapterIdentityDigest: string;
	public readonly requests: VerificationArtifactEvidenceRequest[] = [];
	public preflightAvailable = true;

	public constructor(runner: VerificationRunnerIdentity, environment: "production" | "test-only" = "production") {
		this.runnerIdentity = runner;
		this.environment = environment;
		this.adapterIdentityDigest = productionVerificationArtifactAdapterIdentity(runner, this.adapterId);
	}

	public async preflight(): Promise<VerificationCoreResult<void>> {
		return this.preflightAvailable
			? { ok: true, value: undefined }
			: { ok: false, error: { code: "evidence_unavailable", message: "fixture evidence unavailable", retryable: true } };
	}

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		this.requests.push(request);
		const value = executionEvidence({
			invocationDigest: request.invocationDigest,
			requestId: request.requestId,
			verificationId: request.verificationId,
			sandboxReceipt: request.sandboxReceipt,
			artifacts: request.expectedArtifacts.map((artifact) => artifactReceipt({
				requestId: request.requestId,
				verificationId: request.verificationId,
				candidateCommit: request.candidate.candidateCommit,
				outputName: artifact.name,
				kind: artifact.kind,
				mediaType: artifact.mediaType,
				schemaDigest: artifact.schemaDigest,
				artifactSeed: `production-${artifact.name}`,
			})),
		});
		return { ok: true, value };
	}
}

class RecordingProductionAdmission implements ProductionVerificationAdmissionInputPort {
	public readonly environment = "production" as const;
	public readonly collectorId = ADMISSION_SOURCE_ID;
	public readonly collectorIdentityDigest = ADMISSION_SOURCE_DIGEST;
	public readonly adapterId = "production-admission-input-v1";
	public readonly adapterIdentityDigest = productionVerificationAdmissionAdapterIdentity(
		this.collectorId,
		this.collectorIdentityDigest,
		this.adapterId,
	);
	public readonly requests: VerificationRunnerRequest[] = [];
	public preflightAvailable = true;

	public async preflight(): Promise<VerificationCoreResult<void>> {
		return this.preflightAvailable
			? { ok: true, value: undefined }
			: { ok: false, error: { code: "evidence_unavailable", message: "fixture admission unavailable", retryable: true } };
	}

	public async collect(request: VerificationRunnerRequest) {
		this.requests.push(request);
		return { ok: true as const, value: admissionInputForRequest(request) };
	}
}

class RecordingProductionBrowserBackend implements ProductionBrowserBackendPort {
	public readonly environment = "production" as const;
	public readonly descriptor: ProductionBrowserBackendDescriptor;
	public readonly requests: BrowserBackendRequest[] = [];

	public constructor() {
		const body = {
			contractId: "runledger.production-browser-backend" as const,
			schemaVersion: 1 as const,
			environment: "production" as const,
			backendId: "production-browser-backend",
			runtimeId: "chromium-production-runtime",
			runtimeVersion: "128.0.0",
			adapterIdentityDigest: digest("production-browser-backend"),
			generation: 1,
			generationDigest: digest("production-browser-generation"),
		};
		this.descriptor = {
			...body,
			descriptorDigest: productionBrowserBackendDescriptorDigest(body),
		};
	}

	public async preflight() {
		return {
			status: "ready" as const,
			descriptorDigest: this.descriptor.descriptorDigest,
			recoveryEvidenceDigest: digest("production-browser-recovery"),
		};
	}

	public async execute(request: BrowserBackendRequest): Promise<BrowserBackendResult> {
		if (!isBrowserBackendRequest(request)) throw new Error("invalid production Browser backend request");
		this.requests.push(request);
		const common = {
			schemaVersion: 1 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			verificationRequestId: request.verificationRequestId,
			operationId: request.operationId,
			verificationId: request.verificationId,
			requestDigest: request.requestDigest,
			operationDigest: request.operationDigest,
			bindingDigest: request.bindingDigest,
			capabilityDecisionDigest: request.capabilityDecisionDigest,
			sandboxReceiptId: request.sandboxReceipt.receiptId,
			sandboxReceiptDigest: request.sandboxReceiptDigest,
			backendId: "production-browser-backend",
			backendIdentityDigest: digest("production-browser-backend"),
			receiptId: createRuntimeId("receipt", `production-browser-${this.requests.length}`),
			completedAt: CLOCK,
		};
		const output = (() => {
			switch (request.operation.kind) {
				case "screenshot":
					return { outputName: request.operation.outputName, kind: "screenshot" as const, mediaType: "image/png", contentHandleDigest: digest("production-screenshot"), originalBytes: 128 };
				case "dom_read":
					return { outputName: request.operation.outputName, kind: "dom_snapshot" as const, mediaType: "application/json", contentHandleDigest: digest("production-dom"), originalBytes: 128 };
				case "console_read":
					return { outputName: request.operation.outputName, kind: "console_log" as const, mediaType: "application/json", contentHandleDigest: digest("production-console"), originalBytes: 128 };
				case "network_evidence":
					return { outputName: request.operation.outputName, kind: "network_trace" as const, mediaType: "application/json", contentHandleDigest: digest("production-network"), originalBytes: 128 };
				default:
					return undefined;
			}
		})();
		const body = { ...common, status: "completed" as const, ...(output ? { output } : {}) };
		return { ...body, receiptDigest: canonicalDigest(body) };
	}
}

function verifierRunnerIdentity(): VerificationRunnerIdentity {
	const body = { issuerId: ISSUER_ID, runnerId: RUNNER_ID, version: "1.0.0" };
	return { ...body, identityDigest: canonicalDigest(body) };
}

function policyFor(manifest: ReturnType<typeof gateManifest>, sourceRoot: string): TrustedVerificationPolicy {
	const body: Omit<TrustedVerificationPolicy, "policyDigest"> = {
		schemaVersion: 1,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		policyId: "production-trusted-gates",
		policyRevision: 1,
		repositoryId: REPOSITORY_ID,
		baseCommit: BASE_COMMIT,
		baseBranch: "main",
		protectedRoot: sourceRoot,
		gateManifestPath: "ci/trusted-gates/test.json",
		expectedGateManifestDigest: manifest.manifestDigest,
		gateSchemaDigest: GATE_MANIFEST_SCHEMA_DIGEST,
	};
	return { ...body, policyDigest: canonicalDigest(body) };
}

const BROWSER_NETWORK: GateManifestBody["network"] = {
	mode: "allowlist",
	hosts: ["app.example.test"],
};

function browserGateManifest(): GateManifest {
	return gateManifest({
		kind: "browser",
		network: BROWSER_NETWORK,
		browser: {
			runtime: {
				resourceId: createRuntimeId("resource", "production-browser-runtime"),
				version: "chromium-128.0.0",
				identityDigest: digest("production-browser-runtime"),
			},
			profile: {
				resourceId: createRuntimeId("resource", "production-browser-profile"),
				identityDigest: digest("production-browser-profile"),
				policyDigest: digest("production-browser-profile-policy"),
			},
			entryUrl: "https://app.example.test/verification",
			origin: "https://app.example.test",
			stepSchemaDigest: digest("production-browser-step-schema"),
			stepsDigest: digest("production-browser-steps"),
			assertionSchemaDigest: digest("production-browser-assertion-schema"),
			trustedAssertionsDigest: digest("production-browser-assertions"),
			networkPolicyDigest: canonicalDigest(BROWSER_NETWORK),
			networkEvidence: {
				maxEntries: 1_000,
				maxBodyBytes: 64 * 1024,
				redactionPolicyDigest: digest("production-browser-network-redaction"),
			},
		},
		expectedArtifacts: [
			{ name: "screenshot", kind: "screenshot", mediaType: "image/png", schemaDigest: digest("production-screenshot-schema"), required: true, maxBytes: 5_000_000 },
			{ name: "dom", kind: "dom_snapshot", mediaType: "application/json", schemaDigest: digest("production-dom-schema"), required: true, maxBytes: 2_000_000 },
			{ name: "console", kind: "console_log", mediaType: "application/json", schemaDigest: digest("production-console-schema"), required: true, maxBytes: 1_000_000 },
			{ name: "network", kind: "network_trace", mediaType: "application/json", schemaDigest: digest("production-network-schema"), required: true, maxBytes: 2_000_000 },
		],
	});
}

interface Fixture {
	root: string;
	baselineWorkspaceId: WorkspaceId;
	baselineGatePath: string;
	candidateGatePath: string;
	trustedBin: string;
	candidateBin: string;
	trustedEnvironment: Record<string, string>;
	trustedPathDirectories: string[];
	keyProvider: OsKeyringArtifactKeyProvider;
	evidence: RecordingProductionEvidence;
	admission: RecordingProductionAdmission;
	workspace: ProductionWorkspacePort;
	capability: RecordingCapabilityGateway;
	sandbox: RecordingSandbox;
	browserBackend: RecordingProductionBrowserBackend;
	registry: WorktreeRegistry;
	request: VerificationPipelineRequest;
	options(
		evidence?: ProductionVerificationArtifactPort,
		browserBackend?: ProductionBrowserBackendPort,
	): Parameters<typeof createProductionVerificationComposition>[0];
}

async function fixture(manifest: GateManifest = gateManifest()): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "runledger-production-verification-"));
	roots.push(root);
	const sourceRoot = join(root, "source");
	const baselineRoot = join(root, "trusted-baseline");
	const candidateRoot = join(root, "candidate");
	const baselineGatePath = join(baselineRoot, "ci", "trusted-gates", "test.json");
	const candidateGatePath = join(candidateRoot, "ci", "trusted-gates", "test.json");
	const trustedBin = join(root, "trusted-bin");
	const candidateBin = join(root, "candidate-bin");
	await Promise.all([
		mkdir(join(baselineRoot, "ci", "trusted-gates"), { recursive: true }),
		mkdir(join(candidateRoot, "ci", "trusted-gates"), { recursive: true }),
		mkdir(sourceRoot, { recursive: true }),
		mkdir(trustedBin, { recursive: true }),
		mkdir(candidateBin, { recursive: true }),
	]);
	await writeFile(baselineGatePath, JSON.stringify(manifest), "utf8");
	await writeFile(candidateGatePath, JSON.stringify({ ...manifest, executable: { path: "candidate-owned" } }), "utf8");
	const trustedPolicy = policyFor(manifest, sourceRoot);
	const baselineWorkspaceId = createRuntimeId("workspace", "production-trusted-baseline");
	const baselineLease = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		leaseId: createRuntimeId("lease", "production-trusted-baseline"),
		workspaceId: baselineWorkspaceId,
		ownerRuntimeId: RUNTIME_ID,
		leaseRevision: 1,
		fencingTokenDigest: digest("production-trusted-baseline-fence"),
		state: "active" as const,
	};
	const record: WorktreeRecord = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		workspaceId: baselineWorkspaceId,
		repositoryId: REPOSITORY_ID,
		sessionId: SESSION_ID,
		createRequestId: createRuntimeId("command", "production-trusted-baseline"),
		createRequestDigest: digest("production-trusted-baseline-request"),
		bindingKind: "readonly_checkout",
		sourceRepo: sourceRoot,
		sourceCwd: sourceRoot,
		worktreeId: createWorktreeId("production-trusted-baseline"),
		worktreePath: baselineRoot,
		effectiveCwd: baselineRoot,
		subdirOffset: "",
		label: "production-trusted-baseline",
		baseRef: BASE_COMMIT,
		baseCommit: BASE_COMMIT,
		headCommit: BASE_COMMIT,
		branch: "main",
		state: "active",
		createdAt: NOW,
		lastAccessedAt: NOW,
		ownerRuntimeId: RUNTIME_ID,
		leaseRevision: 1,
		lease: baselineLease,
	};
	const registry = new WorktreeRegistry(new MemoryWorktreeRegistryMutationPort());
	const appended = await registry.append("upsert", record);
	if (!appended.ok) throw new Error(appended.error.message);
	const envelope = { ...candidateEnvelope(), worktreePath: candidateRoot, cwd: candidateRoot };
	const workspace = new ProductionWorkspacePort(record, envelope);
	const capability = new RecordingCapabilityGateway();
	const sandbox = new RecordingSandbox();
	const browserBackend = new RecordingProductionBrowserBackend();
	const evidence = new RecordingProductionEvidence(verifierRunnerIdentity());
	const admission = new RecordingProductionAdmission();
	const keyProvider = new OsKeyringArtifactKeyProvider(new MemoryOsKeyring());

	const store = new MemoryEventStore({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		validateFence: () => true,
	});
	const fence: WriterFence = {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		leaseId: createRuntimeId("lease", "production-verification-session"),
		ownerRuntimeId: RUNTIME_ID,
		writerEpoch: 1,
		fencingToken: "production-verification-session-fence",
	};
	const writer = new EventWriter({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		stream: SESSION_STREAM,
		store,
		fence,
		clock: () => new Date(CLOCK),
	});
	const genesis = await writer.append({
		type: "session.created",
		principalId: PRINCIPAL_ID,
		traceId: createRuntimeId("trace", "production-verification-genesis"),
		payload: {
			origin: "test",
			runtimeId: RUNTIME_ID,
			featureDigest: digest("production-verification-features"),
			initialGoalId: createRuntimeId("goal", "production-verification"),
			rootAgentId: AGENT_ID,
		},
	});
	if (!genesis.ok) throw new Error(genesis.error.message);
	const artifactRoot = join(root, "artifacts");
	const cas = new ArtifactCasStore({ rootDir: artifactRoot });
	const metadata = new ArtifactMetadataStore({ rootDir: artifactRoot });
	const artifactJournal = new SessionArtifactJournal({
		writer,
		store,
		principalId: PRINCIPAL_ID,
		traceIdFactory: () => createRuntimeId("trace", "production-verification-artifact"),
	});
	const artifacts = new ArtifactRepository({
		cas,
		metadata,
		journal: artifactJournal,
		keyProvider,
		clock: () => new Date(CLOCK),
	});
	const trustedEnvironment = { CI: "1" };
	const trustedPathDirectories = [trustedBin];
	const request: VerificationPipelineRequest = {
		requestId: createRuntimeId("command", "production-baseline-request"),
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		sessionId: SESSION_ID,
		agentId: AGENT_ID,
		traceId: TRACE_ID,
		repositoryId: REPOSITORY_ID,
		gateKey: "test",
		ownerRuntimeId: RUNTIME_ID,
		verificationId: VERIFICATION_ID,
		runnerRequestId: REQUEST_ID,
		candidate: candidate(CANDIDATE_COMMIT),
		candidateEnvelope: envelope,
	};
	const options = (
		selectedEvidence: ProductionVerificationArtifactPort = evidence,
		selectedBrowserBackend?: ProductionBrowserBackendPort,
	) => ({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		principalId: PRINCIPAL_ID,
		issuerId: ISSUER_ID,
		runnerId: RUNNER_ID,
		runnerVersion: "1.0.0",
		keyProvider,
		workspace,
		worktreeRegistry: registry,
		policy: { resolve: async () => ({ ok: true as const, value: trustedPolicy }) },
		capability,
		sandbox,
		...(selectedBrowserBackend ? { browserBackend: selectedBrowserBackend } : {}),
		evidence: selectedEvidence,
		admission,
		episodeSeals: {
			resolveBySealDigest: async () => ({
				ok: false as const,
				error: { code: "evidence_unavailable" as const, message: "no Episode seal in this fixture", retryable: false },
			}),
		},
		sessionJournal: {
			writer,
			store,
			artifacts,
			metadata,
			cas,
			traceIdFactory: () => createRuntimeId("trace", "production-verification-runtime"),
		},
		trustedPathDirectories,
		trustedEnvironment,
		clock: () => new Date(CLOCK),
	});
	return {
		root,
		baselineWorkspaceId,
		baselineGatePath,
		candidateGatePath,
		trustedBin,
		candidateBin,
		trustedEnvironment,
		trustedPathDirectories,
		keyProvider,
		evidence,
		admission,
		workspace,
		capability,
		sandbox,
		browserBackend,
		registry,
		request,
		options,
	};
}

describe("production Verification composition", () => {
	it("persists Finding snapshots through production Artifact and session event adapters", async () => {
		const context = await fixture();
		const options = context.options();
		const composed = await createProductionVerificationComposition(options);
		if (!composed.ok) throw new Error(composed.error.message);
		const finding = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			findingId: createRuntimeId("finding", "production"),
			verificationId: VERIFICATION_ID,
			gateDigest: digest("production-finding-gate"),
			baseCommit: BASE_COMMIT,
			candidateCommit: CANDIDATE_COMMIT,
			source: "security_review" as const,
			state: "detected" as const,
			severity: "high" as const,
			policyClass: "secret_scan",
			summaryDigest: digest("production-finding-summary"),
			evidenceArtifactIds: [createRuntimeId("artifact", "production-finding-evidence")],
			confirmation: "candidate" as const,
			revision: 0,
		};
		const writerHead = options.sessionJournal.writer.currentHead();
		if (!writerHead) throw new Error("production Finding fixture has no event head");
		const recorded = await composed.value.findings.record(finding, writerHead);
		if (!recorded.ok) throw new Error(`${recorded.error.code}: ${recorded.error.message}`);
		expect(recorded.ok && recorded.value).toEqual(finding);
		const loaded = await composed.value.findings.load();
		expect(loaded.ok && loaded.value).toEqual([finding]);
	});

	it("uses the readonly baseline and frozen trusted PATH, signs the report, and replays it after reconstruction", async () => {
		const context = await fixture();
		const composed = await createProductionVerificationComposition(context.options());
		expect(composed.ok).toBe(true);
		if (!composed.ok) throw new Error(composed.error.message);

		context.trustedEnvironment.CI = "candidate-overwrite";
		context.trustedPathDirectories[0] = context.candidateBin;
		await writeFile(context.candidateGatePath, JSON.stringify({ packageScript: "candidate-owned" }), "utf8");

		const verified = await composed.value.pipeline.verify(context.request);
		expect(verified.ok && verified.value.result.outcome).toBe("passed");
		if (!verified.ok) throw new Error(verified.error.message);
		expect((await composed.value.issuerRegistry.verify(verified.value)).ok).toBe(true);
		const invocation = context.capability.requests[0]?.invocation.rawArguments;
		expect(invocation).toMatchObject({
			executable: { source: "trusted_baseline", path: "ci/trusted-gates/run-tests" },
			baseConfiguration: [{ path: "ci/trusted-gates/vitest.config.ts" }],
			environment: [
				{ name: "CI", value: "1" },
				{ name: "PATH", value: context.trustedBin },
			],
		});
		expect(JSON.stringify(invocation)).not.toContain("candidate-overwrite");
		expect(JSON.stringify(invocation)).not.toContain(context.candidateBin);
		expect(context.workspace.requests.map((entry) => entry.kind)).toEqual(["bind", "validate"]);

		const beforeRestart = {
			workspace: context.workspace.requests.length,
			capability: context.capability.requests.length,
			sandbox: context.sandbox.requests.length,
			evidence: context.evidence.requests.length,
		};
		const restarted = await createProductionVerificationComposition(context.options());
		if (!restarted.ok) throw new Error(restarted.error.message);
		const replayed = await restarted.value.pipeline.verify(context.request);
		expect(replayed.ok && replayed.value.reportDigest).toBe(verified.value.reportDigest);
		expect({
			workspace: context.workspace.requests.length,
			capability: context.capability.requests.length,
			sandbox: context.sandbox.requests.length,
			evidence: context.evidence.requests.length,
		}).toEqual(beforeRestart);

		const receipt = verified.value.receipt;
		const { signature: _signature, receiptDigest: _receiptDigest, ...body } = receipt;
		const forgedReceipt = createVerifierReceipt(body, { ...receipt.signature, value: "0".repeat(64) });
		if (!forgedReceipt.ok) throw new Error(forgedReceipt.error.message);
		const forgedReport = createVerificationReport(verified.value.result, forgedReceipt.value);
		if (!forgedReport.ok) throw new Error(forgedReport.error.message);
		expect((await restarted.value.issuerRegistry.verify(forgedReport.value)).ok).toBe(false);
	});

	it("rejects trusted-base Gate tampering before authorization or sandbox execution", async () => {
		const context = await fixture();
		const manifest = gateManifest();
		await writeFile(
			context.baselineGatePath,
			JSON.stringify({ ...manifest, executable: { ...manifest.executable, path: "candidate/override" } }),
			"utf8",
		);
		const composed = await createProductionVerificationComposition(context.options());
		if (!composed.ok) throw new Error(composed.error.message);
		const result = await composed.value.pipeline.verify(context.request);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(["invalid_schema", "invalid_digest", "untrusted_gate"]).toContain(result.error.code);
		expect(context.capability.requests).toHaveLength(0);
		expect(context.sandbox.requests).toHaveLength(0);
	});

	it("rejects a baseline allocation that aliases the candidate workspace", async () => {
		const context = await fixture();
		const composed = await createProductionVerificationComposition(context.options());
		if (!composed.ok) throw new Error(composed.error.message);
		const collision = {
			...context.request,
			candidate: { ...context.request.candidate, workspaceId: context.baselineWorkspaceId },
			candidateEnvelope: { ...context.request.candidateEnvelope, workspaceId: context.baselineWorkspaceId },
		};
		const result = await composed.value.pipeline.verify(collision);
		expect(result).toMatchObject({ ok: false, error: { code: "scope_mismatch" } });
		expect(context.capability.requests).toHaveLength(0);
		expect(context.sandbox.requests).toHaveLength(0);
	});

	it("keeps production Browser verification unavailable when no backend is configured", async () => {
		const context = await fixture(browserGateManifest());
		const composed = await createProductionVerificationComposition(context.options());
		if (!composed.ok) throw new Error(composed.error.message);
		expect(composed.value.readiness.entries.find((entry) => entry.scope === "browser_backend")?.status)
			.toBe("external_gap");
		expect(runtimeFeatureReadiness(composed.value.readiness, "completion")).toBe("external_gap");
		const result = await composed.value.pipeline.verify(context.request);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "sandbox_unavailable", message: "verification runner is unavailable" },
		});
		expect(context.workspace.requests.map((entry) => entry.kind)).toEqual(["bind"]);
		expect(context.capability.requests).toHaveLength(0);
		expect(context.sandbox.requests).toHaveLength(0);
		expect(context.browserBackend.requests).toHaveLength(0);
		expect(context.evidence.requests).toHaveLength(0);
	});

	it("enables the restricted Browser provider only when a production backend is injected", async () => {
		const context = await fixture(browserGateManifest());
		const composed = await createProductionVerificationComposition(
			context.options(context.evidence, context.browserBackend),
		);
		if (!composed.ok) throw new Error(composed.error.message);
		expect(composed.value.readiness.entries.find((entry) => entry.scope === "browser_backend")?.status)
			.toBe("ready");
		expect(runtimeFeatureReadiness(composed.value.readiness, "completion")).toBe("external_gap");
		const result = await composed.value.pipeline.verify(context.request);
		expect(result.ok && result.value.result.outcome).toBe("passed");
		if (!result.ok) throw new Error(result.error.message);
		expect(context.workspace.requests.map((entry) => entry.kind)).toEqual(["bind", "validate"]);
		expect(context.capability.requests).toHaveLength(8);
		expect(context.sandbox.requests).toHaveLength(8);
		expect(context.browserBackend.requests.map((entry) => entry.operation.kind)).toEqual([
			"launch",
			"network",
			"navigate",
			"screenshot",
			"dom_read",
			"console_read",
			"network_evidence",
			"evidence_seal",
		]);
		expect(context.evidence.requests).toHaveLength(1);
		expect(result.value.result.browserExecution?.operationReceipts).toHaveLength(8);
	});

	it("returns unavailable for test-only evidence, fake issuers, and unavailable OS keyring state", async () => {
		const context = await fixture();
		const testOnly = new RecordingProductionEvidence(verifierRunnerIdentity(), "test-only");
		expect(await createProductionVerificationComposition(context.options(testOnly))).toMatchObject({
			ok: false,
			error: { code: "evidence_unavailable" },
		});

		const fakeIssuerOptions = {
			...context.options(),
			keyProvider: new UnavailableArtifactKeyProvider() as unknown as OsKeyringArtifactKeyProvider,
		};
		expect(await createProductionVerificationComposition(fakeIssuerOptions)).toMatchObject({
			ok: false,
			error: { code: "untrusted_issuer" },
		});

		const unavailableKeyring = new MemoryOsKeyring();
		unavailableKeyring.available = false;
		const unavailableOptions = {
			...context.options(),
			keyProvider: new OsKeyringArtifactKeyProvider(unavailableKeyring),
		};
		expect(await createProductionVerificationComposition(unavailableOptions)).toMatchObject({
			ok: false,
			error: { code: "evidence_unavailable" },
		});
	});
});
