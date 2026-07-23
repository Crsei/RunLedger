/** Production Verification composition root；任一信任依赖缺失时显式 unavailable。 */

import { lstat, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { CapabilityGatewayPort, SandboxExecutorPort } from "../../protocol/v3/capability.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, sameRuntimeEventStream } from "../../protocol/v3/events.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type PrincipalId,
	type SessionId,
	type TenantId,
} from "../../protocol/v3/ids.ts";
import type { WorkspaceServicePort } from "../../protocol/v3/workspace.ts";
import { OsKeyringArtifactKeyProvider } from "../../artifacts/key-provider.ts";
import type { ProductionVerificationServices } from "../../integration/production-session-runtime.ts";
import {
	createRuntimeDependencyReadinessEntry,
	createRuntimeDependencyReadinessReceipt,
	type RuntimeDependencyReadinessReceipt,
} from "../../integration/dependency-readiness.ts";
import { TrustedBaselineCoordinator } from "../baseline.ts";
import { isVerificationExecutionEvidence } from "../evidence.ts";
import { VerificationAdmissionController } from "../admission.ts";
import { VerificationPipeline } from "../pipeline.ts";
import {
	EpisodeSealCompletionTrustAdapter,
	type DurableEpisodeSealResolverPort,
	type EpisodeSealSignerPort,
} from "../report.ts";
import { TrustedVerifierIssuerRegistry } from "../security.ts";
import {
	VerificationSessionRuntime,
	type VerificationSessionRuntimeOptions,
} from "../session-runtime.ts";
import type {
	TrustedVerificationPolicyPort,
	VerificationArtifactEvidenceRequest,
	VerificationAdmissionInputPort,
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationExecutionEvidence,
	VerificationRunnerAttempt,
	VerificationRunnerIdentity,
	VerificationRunnerPort,
	VerificationRunnerRequest,
} from "../types.ts";
import { PortBackedVerificationRunner } from "../../../verification-runner/runner.ts";
import {
	isProductionBrowserBackendDescriptor,
	type BrowserBackendPort,
	type ProductionBrowserBackendPort,
} from "../../../verification-runner/browser/evidence.ts";
import type { WorktreeRegistry } from "../../../worktree/registry.ts";
import { createOsKeyringVerifierComposition } from "./os-keyring-issuer.ts";
import { WorktreeTrustedGateSource } from "./worktree-gate-source.ts";
import { ProductionFindingSnapshotArtifactPort } from "./production-finding-snapshots.ts";
import { SessionFindingRepository } from "../session-finding-repository.ts";

const FORBIDDEN_ENVIRONMENT_KEYS = new Set([
	"BASH_ENV",
	"ENV",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"PS4",
	"SHELLOPTS",
]);
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u;

function failure<T>(
	code: "invalid_schema" | "scope_mismatch" | "evidence_unavailable" | "untrusted_issuer",
	message: string,
	retryable = false,
): VerificationCoreResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function runnerIdentity(issuerId: string, runnerId: PrincipalId, version: string): VerificationRunnerIdentity {
	const body = { issuerId, runnerId, version };
	return { ...body, identityDigest: canonicalDigest(body) };
}

function sameRunnerIdentity(left: VerificationRunnerIdentity, right: VerificationRunnerIdentity): boolean {
	return (
		left.issuerId === right.issuerId &&
		left.runnerId === right.runnerId &&
		left.version === right.version &&
		left.identityDigest === right.identityDigest &&
		left.identityDigest === canonicalDigest({
			issuerId: left.issuerId,
			runnerId: left.runnerId,
			version: left.version,
		})
	);
}

async function trustedPath(directories: readonly string[]): Promise<VerificationCoreResult<string>> {
	if (directories.length === 0 || directories.length > 64) {
		return failure("evidence_unavailable", "production verifier requires a bounded trusted PATH");
	}
	const canonicalDirectories: string[] = [];
	for (const directory of directories) {
		if (!isAbsolute(directory) || resolve(directory) !== directory || directory.includes("\0")) {
			return failure("invalid_schema", "production verifier PATH contains a non-canonical directory");
		}
		try {
			const [canonical, stats] = await Promise.all([realpath(directory), lstat(directory)]);
			if (resolve(canonical) !== directory || !stats.isDirectory() || stats.isSymbolicLink()) {
				return failure("evidence_unavailable", "production verifier PATH directory is not a canonical directory");
			}
		} catch {
			return failure("evidence_unavailable", "production verifier PATH directory is unavailable", true);
		}
		canonicalDirectories.push(directory);
	}
	if (new Set(canonicalDirectories).size !== canonicalDirectories.length) {
		return failure("invalid_schema", "production verifier PATH contains duplicate directories");
	}
	return { ok: true, value: canonicalDirectories.join(delimiter) };
}

function trustedEnvironment(
	base: Readonly<Record<string, string>> | undefined,
	path: string,
): VerificationCoreResult<Readonly<Record<string, string>>> {
	const output: Record<string, string> = { PATH: path };
	for (const [name, value] of Object.entries(base ?? {})) {
		if (
			!ENVIRONMENT_NAME.test(name) ||
			name === "PATH" ||
			name.startsWith("DYLD_") ||
			name.startsWith("npm_") ||
			FORBIDDEN_ENVIRONMENT_KEYS.has(name) ||
			value.length > 16_384 ||
			value.includes("\0")
		) return failure("invalid_schema", `production verifier environment key is not allowed: ${name}`);
		output[name] = value;
	}
	return { ok: true, value: Object.freeze(output) };
}

export interface ProductionVerificationArtifactPort extends VerificationArtifactPort {
	readonly environment: "production" | "test-only";
	readonly runnerIdentity: VerificationRunnerIdentity;
	readonly adapterId: string;
	readonly adapterIdentityDigest: string;
	preflight(): Promise<VerificationCoreResult<void>>;
}

export interface ProductionVerificationAdmissionInputPort extends VerificationAdmissionInputPort {
	readonly environment: "production";
	readonly adapterId: string;
	readonly adapterIdentityDigest: string;
	preflight(): Promise<VerificationCoreResult<void>>;
}

export function productionVerificationAdmissionAdapterIdentity(
	collectorId: string,
	collectorIdentityDigest: string,
	adapterId: string,
): string {
	return canonicalDigest({
		contract: "runledger.production-verification-admission-input",
		version: 1,
		environment: "production",
		collectorId,
		collectorIdentityDigest,
		adapterId,
	});
}

export function productionVerificationArtifactAdapterIdentity(
	runner: VerificationRunnerIdentity,
	adapterId: string,
): string {
	return canonicalDigest({
		contract: "runledger.production-verification-artifact-port",
		version: 1,
		environment: "production",
		adapterId,
		runner,
	});
}

class CorrelatedProductionArtifactPort implements VerificationArtifactPort {
	readonly #delegate: ProductionVerificationArtifactPort;
	readonly #runner: VerificationRunnerIdentity;

	public constructor(delegate: ProductionVerificationArtifactPort, runner: VerificationRunnerIdentity) {
		this.#delegate = delegate;
		this.#runner = runner;
	}

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		let resolved: Awaited<ReturnType<VerificationArtifactPort["resolveExecutionEvidence"]>>;
		try {
			resolved = await this.#delegate.resolveExecutionEvidence(request, signal);
		} catch {
			return failure("evidence_unavailable", "production verification Artifact adapter is unavailable", true);
		}
		if (!resolved.ok) return resolved;
		if (!isVerificationExecutionEvidence(resolved.value) || !sameRunnerIdentity(resolved.value.runner, this.#runner)) {
			return failure("evidence_unavailable", "production execution evidence has an untrusted runner identity");
		}
		return resolved;
	}
}

class IndependentBaselineRunner implements VerificationRunnerPort {
	readonly #delegate: VerificationRunnerPort;

	public constructor(delegate: VerificationRunnerPort) {
		this.#delegate = delegate;
	}

	public run(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationRunnerAttempt>> {
		if (
			request.baseline.workspaceId === request.candidate.workspaceId ||
			request.baseline.bindingDigest === request.candidate.bindingDigest
		) {
			return Promise.resolve(failure(
				"scope_mismatch",
				"production Verification requires a baseline workspace independent from the candidate",
			));
		}
		return this.#delegate.run(request, signal);
	}
}

export type ProductionVerificationSessionJournalOptions = Omit<
	VerificationSessionRuntimeOptions,
	"authorityId" | "tenantId" | "sessionId" | "principalId"
>;

export interface ProductionVerificationCompositionOptions {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	principalId: PrincipalId;
	issuerId: string;
	runnerId: PrincipalId;
	runnerVersion: string;
	keyProvider: OsKeyringArtifactKeyProvider;
	workspace: WorkspaceServicePort;
	worktreeRegistry: WorktreeRegistry;
	policy: TrustedVerificationPolicyPort;
	capability: CapabilityGatewayPort;
	sandbox: SandboxExecutorPort;
	browserBackend?: ProductionBrowserBackendPort;
	evidence: ProductionVerificationArtifactPort;
	admission?: ProductionVerificationAdmissionInputPort;
	episodeSeals: DurableEpisodeSealResolverPort;
	sessionJournal: ProductionVerificationSessionJournalOptions;
	trustedPathDirectories: readonly string[];
	trustedEnvironment?: Readonly<Record<string, string>>;
	maxGateBytes?: number;
	clock?: () => Date;
}

export interface ProductionVerificationComposition extends ProductionVerificationServices {
	issuerRegistry: TrustedVerifierIssuerRegistry;
	episodeSealSigner: EpisodeSealSignerPort;
	runnerIdentity: VerificationRunnerIdentity;
	activeKeyId: string;
	trustedEnvironmentDigest: string;
	admissionAdapterIdentityDigest: string;
	gateSource: WorktreeTrustedGateSource;
	readiness: RuntimeDependencyReadinessReceipt;
	findings: SessionFindingRepository;
}

class CorrelatedProductionBrowserBackend implements BrowserBackendPort {
	readonly #delegate: ProductionBrowserBackendPort;

	public constructor(delegate: ProductionBrowserBackendPort) {
		this.#delegate = delegate;
	}

	public async execute(
		request: Parameters<BrowserBackendPort["execute"]>[0],
		signal?: AbortSignal,
	): ReturnType<BrowserBackendPort["execute"]> {
		const result = await this.#delegate.execute(request, signal);
		if (result.backendId === this.#delegate.descriptor.backendId &&
			result.backendIdentityDigest === this.#delegate.descriptor.adapterIdentityDigest
		) return result;
		const body = {
			schemaVersion: result.schemaVersion,
			authorityId: result.authorityId,
			tenantId: result.tenantId,
			verificationRequestId: result.verificationRequestId,
			operationId: result.operationId,
			verificationId: result.verificationId,
			requestDigest: result.requestDigest,
			operationDigest: result.operationDigest,
			bindingDigest: result.bindingDigest,
			capabilityDecisionDigest: result.capabilityDecisionDigest,
			sandboxReceiptId: result.sandboxReceiptId,
			sandboxReceiptDigest: result.sandboxReceiptDigest,
			backendId: this.#delegate.descriptor.backendId,
			backendIdentityDigest: this.#delegate.descriptor.adapterIdentityDigest,
			receiptId: result.receiptId,
			completedAt: result.completedAt,
			status: "unsupported" as const,
			reasonCode: "backend_identity_mismatch",
			reasonDigest: canonicalDigest({
				expected: this.#delegate.descriptor.descriptorDigest,
				actualBackendId: result.backendId,
				actualIdentityDigest: result.backendIdentityDigest,
			}),
		};
		return { ...body, receiptDigest: canonicalDigest(body) };
	}
}

function validScope(options: ProductionVerificationCompositionOptions): boolean {
	return (
		isRuntimeId(options.authorityId, "authority") &&
		isRuntimeId(options.tenantId, "tenant") &&
		isRuntimeId(options.sessionId, "session") &&
		isRuntimeId(options.principalId, "principal") &&
		isRuntimeId(options.runnerId, "principal") &&
		options.issuerId.length > 0 &&
		options.issuerId.length <= 512 &&
		options.runnerVersion.length > 0 &&
		options.runnerVersion.length <= 128
	);
}

export async function createProductionVerificationComposition(
	options: ProductionVerificationCompositionOptions,
): Promise<VerificationCoreResult<ProductionVerificationComposition>> {
	if (!validScope(options)) return failure("invalid_schema", "production Verification scope or identity is invalid");
	if (!(options.keyProvider instanceof OsKeyringArtifactKeyProvider)) {
		return failure("untrusted_issuer", "production Verification rejects non-keyring and test-only issuers");
	}
	const expectedRunner = runnerIdentity(options.issuerId, options.runnerId, options.runnerVersion);
	if (
		options.evidence.environment !== "production" ||
		!sameRunnerIdentity(options.evidence.runnerIdentity, expectedRunner) ||
		!options.evidence.adapterId ||
		options.evidence.adapterId.length > 512 ||
		options.evidence.adapterIdentityDigest !== productionVerificationArtifactAdapterIdentity(
			expectedRunner,
			options.evidence.adapterId,
		)
	) return failure("evidence_unavailable", "production Verification Artifact adapter is absent or test-only");
	let evidencePreflight: Awaited<ReturnType<ProductionVerificationArtifactPort["preflight"]>>;
	try {
		evidencePreflight = await options.evidence.preflight();
	} catch {
		return failure("evidence_unavailable", "production Verification Artifact preflight is unavailable", true);
	}
	if (!evidencePreflight.ok) return evidencePreflight;
	const admissionSource = options.admission;
	if (
		!admissionSource ||
		admissionSource.environment !== "production" ||
		!admissionSource.adapterId ||
		admissionSource.adapterId.length > 512 ||
		!admissionSource.collectorId ||
		admissionSource.collectorId.length > 512 ||
		!/^([a-f0-9]{64})$/u.test(admissionSource.collectorIdentityDigest) ||
		admissionSource.adapterIdentityDigest !== productionVerificationAdmissionAdapterIdentity(
			admissionSource.collectorId,
			admissionSource.collectorIdentityDigest,
			admissionSource.adapterId,
		)
	) return failure("evidence_unavailable", "production dependency and Secret Scan adapter is absent or untrusted");
	let admissionPreflight: Awaited<ReturnType<ProductionVerificationAdmissionInputPort["preflight"]>>;
	try {
		admissionPreflight = await admissionSource.preflight();
	} catch {
		return failure("evidence_unavailable", "production dependency and Secret Scan preflight is unavailable", true);
	}
	if (!admissionPreflight.ok) return admissionPreflight;

	const path = await trustedPath(options.trustedPathDirectories);
	if (!path.ok) return path;
	const environment = trustedEnvironment(options.trustedEnvironment, path.value);
	if (!environment.ok) return environment;

	let browserBackend: BrowserBackendPort | undefined;
	let browserStatus: "ready" | "unsupported" | "external_gap" =
		options.browserBackend ? "unsupported" : "external_gap";
	let browserRecoveryEvidenceDigest: string | undefined;
	let browserReasonDigest = canonicalDigest("production Browser backend is absent");
	if (options.browserBackend) {
		if (
			options.browserBackend.environment !== "production" ||
			!isProductionBrowserBackendDescriptor(options.browserBackend.descriptor)
		) {
			return failure("evidence_unavailable", "production Browser backend descriptor is absent or invalid");
		}
		let preflight: Awaited<ReturnType<ProductionBrowserBackendPort["preflight"]>>;
		try {
			preflight = await options.browserBackend.preflight();
		} catch {
			return failure("evidence_unavailable", "production Browser backend preflight is unavailable", true);
		}
		browserStatus = preflight.status;
		if (preflight.status === "ready") {
			if (
				preflight.descriptorDigest !== options.browserBackend.descriptor.descriptorDigest ||
				!/^[a-f0-9]{64}$/u.test(preflight.recoveryEvidenceDigest)
			) {
				return failure("evidence_unavailable", "production Browser backend preflight is not correlated");
			}
			browserRecoveryEvidenceDigest = preflight.recoveryEvidenceDigest;
			browserBackend = new CorrelatedProductionBrowserBackend(options.browserBackend);
		} else {
			browserReasonDigest = preflight.reasonDigest;
		}
	}

	let eventVerification: Awaited<ReturnType<VerificationSessionRuntimeOptions["store"]["verify"]>>;
	try {
		eventVerification = await options.sessionJournal.store.verify(options.sessionJournal.store.streamRef());
	} catch {
		return failure("evidence_unavailable", "production Verification event store is unavailable", true);
	}
	if (
		!eventVerification.ok ||
		eventVerification.value.integrity !== "valid" ||
		eventVerification.value.authorityId !== options.authorityId ||
		eventVerification.value.tenantId !== options.tenantId ||
		!sameRuntimeEventStream(
			eventVerification.value.stream,
			createSessionEventStreamRef(options, options.sessionId),
		)
	) return failure("scope_mismatch", "production Verification event store scope or integrity is invalid");

	const signer = await createOsKeyringVerifierComposition({
		issuerId: options.issuerId,
		keyProvider: options.keyProvider,
		...(options.clock ? { clock: options.clock } : {}),
	});
	if (!signer.ok) return signer;
	const issuerRegistry = new TrustedVerifierIssuerRegistry({
		environment: "production",
		...(options.clock ? { clock: options.clock } : {}),
	});
	const registered = issuerRegistry.register(signer.value.descriptor);
	if (!registered.ok) return registered;

	const gateSource = new WorktreeTrustedGateSource({
		registry: options.worktreeRegistry,
		...(options.maxGateBytes === undefined ? {} : { maxGateBytes: options.maxGateBytes }),
	});
	const baseline = new TrustedBaselineCoordinator({
		policy: options.policy,
		workspace: options.workspace,
		...(options.clock ? { clock: options.clock } : {}),
	});
	const portBackedRunner = new PortBackedVerificationRunner({
		workspace: options.workspace,
		capability: options.capability,
		sandbox: options.sandbox,
		artifacts: new CorrelatedProductionArtifactPort(options.evidence, expectedRunner),
		eventCursorAuthority: {
			current: async (scope) => {
				if (
					scope.authorityId !== options.authorityId ||
					scope.tenantId !== options.tenantId ||
					scope.sessionId !== options.sessionId
				) return undefined;
				const head = options.sessionJournal.writer.currentHead();
				return head ? structuredClone(head) : undefined;
			},
		},
		...(browserBackend ? { browserBackend } : {}),
		trustedEnvironment: environment.value,
		...(options.clock ? { clock: options.clock } : {}),
	});
	const runner = new IndependentBaselineRunner(portBackedRunner);
	const admission = new VerificationAdmissionController({
		source: admissionSource,
		...(options.clock ? { clock: options.clock } : {}),
	});
	const sessionRuntime = new VerificationSessionRuntime({
		...options.sessionJournal,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		sessionId: options.sessionId,
		principalId: options.principalId,
	});
	const findings = new SessionFindingRepository({
		writer: options.sessionJournal.writer,
		store: options.sessionJournal.store,
		principalId: options.principalId,
		snapshots: new ProductionFindingSnapshotArtifactPort({
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			sessionId: options.sessionId,
			principalId: options.principalId,
			artifacts: options.sessionJournal.artifacts,
			metadata: options.sessionJournal.metadata,
			cas: options.sessionJournal.cas,
		}),
		...(options.clock ? { clock: options.clock } : {}),
	});
	const pipeline = new VerificationPipeline({
		baseline,
		gateSource,
		runner,
		admission,
		issuer: signer.value.issuer,
		issuerRegistry,
		journal: sessionRuntime,
	});
	const trustedEnvironmentDigest = canonicalDigest(environment.value);
	const evidenceDigest = canonicalDigest({
		contract: "runledger.production-verification-composition",
		version: 1,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		sessionId: options.sessionId,
		runner: expectedRunner,
		issuer: {
			issuerId: signer.value.descriptor.issuerId,
			algorithm: "hmac-sha256",
			keyIds: signer.value.keyIds,
			activeKeyId: signer.value.activeKeyId,
		},
		trustedEnvironmentDigest,
		artifactAdapterIdentityDigest: options.evidence.adapterIdentityDigest,
		admissionAdapterIdentityDigest: admissionSource.adapterIdentityDigest,
	});
	const readiness = createRuntimeDependencyReadinessReceipt({
		compositionId: `verification-${options.sessionId}`,
		generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
		entries: [
			...(["plan_context_memory", "resources_extensions", "workspace_security"] as const).map((scope) =>
				createRuntimeDependencyReadinessEntry({
					scope,
					status: "external_gap",
					contractId: `runledger.${scope}`,
					schemaVersion: 1,
					contractDigest: canonicalDigest({ scope, version: 1 }),
					recovery: "unavailable",
					requiredFor: scope === "workspace_security"
						? ["governed_operations", "verification", "browser_verification", "completion"]
						: ["governed_operations", "completion"],
					reasonDigest: canonicalDigest(`${scope} specialty production readiness is external`),
				})),
			createRuntimeDependencyReadinessEntry({
				scope: "verification_core",
				status: "ready",
				contractId: "runledger.production-verification-composition",
				schemaVersion: 1,
				contractDigest: evidenceDigest,
				adapterId: options.evidence.adapterId,
				adapterIdentityDigest: options.evidence.adapterIdentityDigest,
				adapterGeneration: 1,
				adapterGenerationDigest: canonicalDigest({
					artifact: options.evidence.adapterIdentityDigest,
					admission: admissionSource.adapterIdentityDigest,
				}),
				recovery: "recoverable",
				recoveryEvidenceDigest: canonicalDigest(eventVerification.value),
				requiredFor: ["verification", "completion"],
			}),
			createRuntimeDependencyReadinessEntry({
				scope: "browser_backend",
				status: browserStatus,
				contractId: "runledger.production-browser-backend",
				schemaVersion: 1,
				contractDigest: options.browserBackend?.descriptor.descriptorDigest ??
					canonicalDigest("runledger.production-browser-backend"),
				...(browserStatus === "ready" && options.browserBackend
					? {
							adapterId: options.browserBackend.descriptor.backendId,
							adapterIdentityDigest: options.browserBackend.descriptor.adapterIdentityDigest,
							adapterGeneration: options.browserBackend.descriptor.generation,
							adapterGenerationDigest: options.browserBackend.descriptor.generationDigest,
							recoveryEvidenceDigest: browserRecoveryEvidenceDigest,
						}
					: { reasonDigest: browserReasonDigest }),
				recovery: browserStatus === "ready" ? "recoverable" : "unavailable",
				requiredFor: ["browser_verification", "completion"],
			}),
			createRuntimeDependencyReadinessEntry({
				scope: "episode_seal",
				status: "ready",
				contractId: "runledger.episode-seal",
				schemaVersion: 1,
				contractDigest: canonicalDigest({
					issuerId: signer.value.descriptor.issuerId,
					activeKeyId: signer.value.activeKeyId,
				}),
				adapterId: signer.value.descriptor.issuerId,
				adapterIdentityDigest: canonicalDigest(signer.value.descriptor.issuerId),
				adapterGeneration: 1,
				adapterGenerationDigest: canonicalDigest(signer.value.keyIds),
				recovery: "recoverable",
				recoveryEvidenceDigest: canonicalDigest({
					activeKeyId: signer.value.activeKeyId,
					eventHead: options.sessionJournal.writer.currentHead(),
				}),
				requiredFor: ["verification", "completion"],
			}),
		],
	});
	return {
		ok: true,
		value: {
			implementation: "production",
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			sessionId: options.sessionId,
			evidenceDigest,
			pipeline,
			sessionRuntime,
			completionTrust: new EpisodeSealCompletionTrustAdapter(options.episodeSeals, issuerRegistry),
			issuerRegistry,
			episodeSealSigner: signer.value.episodeSealSigner,
			runnerIdentity: expectedRunner,
			activeKeyId: signer.value.activeKeyId,
			trustedEnvironmentDigest,
			admissionAdapterIdentityDigest: admissionSource.adapterIdentityDigest,
			gateSource,
			readiness,
			findings,
		},
	};
}
