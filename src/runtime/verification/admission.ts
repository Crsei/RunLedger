/** DependencyAdmission + SecretScan 的生产前置门禁组合。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createUnavailableDependencyAdmissionReceipt,
	evaluateDependencyAdmission,
	isDependencyAdmissionReceipt,
} from "./dependency-admission.ts";
import {
	createUnavailableSecretScanReceipt,
	isSecretScanReceipt,
	SecretScanGate,
} from "./secret-scan.ts";
import {
	VERIFICATION_ADMISSION_SCHEMA_VERSION,
	type AdmissionOutcome,
	type VerificationAdmissionBundle,
	type VerificationAdmissionInput,
	type VerificationAdmissionInputPort,
	type VerificationAdmissionPort,
	type VerificationCoreResult,
	type VerificationRunnerRequest,
} from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,511}$/u;

function bundleBody(
	bundle: VerificationAdmissionBundle,
): Omit<VerificationAdmissionBundle, "bundleDigest"> {
	const { bundleDigest: _bundleDigest, ...body } = bundle;
	return body;
}

export function verificationAdmissionBundleDigest(
	bundle: Omit<VerificationAdmissionBundle, "bundleDigest">,
): string {
	return canonicalDigest(bundle);
}

export function isVerificationAdmissionBundle(value: unknown): value is VerificationAdmissionBundle {
	if (typeof value !== "object" || value === null) return false;
	const bundle = value as Partial<VerificationAdmissionBundle>;
	if (
		bundle.schemaVersion !== VERIFICATION_ADMISSION_SCHEMA_VERSION ||
		typeof bundle.authorityId !== "string" || !bundle.authorityId.startsWith("authority_") ||
		typeof bundle.tenantId !== "string" || !bundle.tenantId.startsWith("tenant_") ||
		typeof bundle.requestId !== "string" || !bundle.requestId.startsWith("command_") ||
		typeof bundle.verificationId !== "string" || !bundle.verificationId.startsWith("verification_") ||
		typeof bundle.gateDigest !== "string" || !DIGEST.test(bundle.gateDigest) ||
		typeof bundle.candidateCommit !== "string" || bundle.candidateCommit.length < 1 || bundle.candidateCommit.length > 512 ||
		!isDependencyAdmissionReceipt(bundle.dependency) ||
		!isSecretScanReceipt(bundle.secretScan) ||
		(bundle.outcome !== "passed" && bundle.outcome !== "blocked" && bundle.outcome !== "inconclusive") ||
		!Array.isArray(bundle.reasonCodes) || bundle.reasonCodes.length > 64 ||
		!bundle.reasonCodes.every((code) => typeof code === "string" && code.length > 0 && code.length <= 128) ||
		typeof bundle.bundleDigest !== "string" || !DIGEST.test(bundle.bundleDigest)
	) return false;
	const correlated = [bundle.dependency, bundle.secretScan].every((receipt) => (
		receipt.authorityId === bundle.authorityId &&
		receipt.tenantId === bundle.tenantId &&
		receipt.requestId === bundle.requestId &&
		receipt.verificationId === bundle.verificationId &&
		receipt.gateDigest === bundle.gateDigest &&
		receipt.candidateCommit === bundle.candidateCommit
	));
	const expectedOutcome: AdmissionOutcome =
		bundle.dependency.outcome === "blocked" || bundle.secretScan.outcome === "blocked"
			? "blocked"
			: bundle.dependency.outcome === "inconclusive" || bundle.secretScan.outcome === "inconclusive"
				? "inconclusive"
				: "passed";
	return correlated && bundle.outcome === expectedOutcome && bundle.bundleDigest === verificationAdmissionBundleDigest(bundleBody(bundle as VerificationAdmissionBundle));
}

function correlatedInput(request: VerificationRunnerRequest, input: VerificationAdmissionInput): boolean {
	return [input.dependency, input.secretScan].every((candidate) => (
		candidate.authorityId === request.candidate.authorityId &&
		candidate.tenantId === request.candidate.tenantId &&
		candidate.requestId === request.requestId &&
		candidate.verificationId === request.verificationId &&
		candidate.gateDigest === request.manifest.manifestDigest &&
		candidate.candidateCommit === request.candidate.candidateCommit
	));
}

function outcomeOf(dependency: VerificationAdmissionBundle["dependency"], secretScan: VerificationAdmissionBundle["secretScan"]): AdmissionOutcome {
	if (dependency.outcome === "blocked" || secretScan.outcome === "blocked") return "blocked";
	if (dependency.outcome === "inconclusive" || secretScan.outcome === "inconclusive") return "inconclusive";
	return "passed";
}

function sourceIdentity(source: VerificationAdmissionInputPort): { collectorId: string; collectorIdentityDigest: string } {
	if (SOURCE_ID.test(source.collectorId) && DIGEST.test(source.collectorIdentityDigest)) {
		return { collectorId: source.collectorId, collectorIdentityDigest: source.collectorIdentityDigest };
	}
	const collectorId = "unavailable-admission-source";
	return {
		collectorId,
		collectorIdentityDigest: canonicalDigest({ collectorId, reason: "invalid_source_identity" }),
	};
}

export interface VerificationAdmissionControllerOptions {
	source: VerificationAdmissionInputPort;
	clock?: () => Date;
}

export class VerificationAdmissionController implements VerificationAdmissionPort {
	readonly #source: VerificationAdmissionInputPort;
	readonly #clock: () => Date;
	readonly #secretScan: SecretScanGate;

	public constructor(options: VerificationAdmissionControllerOptions) {
		this.#source = options.source;
		this.#clock = options.clock ?? (() => new Date());
		this.#secretScan = new SecretScanGate({ clock: this.#clock });
	}

	#createUnavailable(request: VerificationRunnerRequest): VerificationAdmissionBundle {
		const evaluatedAt = this.#clock().toISOString();
		const identity = sourceIdentity(this.#source);
		const dependency = createUnavailableDependencyAdmissionReceipt({
			policy: request.manifest.dependencyPolicy,
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			requestId: request.requestId,
			verificationId: request.verificationId,
			gateDigest: request.manifest.manifestDigest,
			candidateCommit: request.candidate.candidateCommit,
			collectorId: identity.collectorId,
			collectorIdentityDigest: identity.collectorIdentityDigest,
			evaluatedAt,
		});
		const secretScan = createUnavailableSecretScanReceipt({
			policy: request.manifest.secretScanPolicy,
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			requestId: request.requestId,
			verificationId: request.verificationId,
			gateDigest: request.manifest.manifestDigest,
			candidateCommit: request.candidate.candidateCommit,
			scannerId: identity.collectorId,
			scannerIdentityDigest: identity.collectorIdentityDigest,
			evaluatedAt,
		});
		const body: Omit<VerificationAdmissionBundle, "bundleDigest"> = {
			schemaVersion: VERIFICATION_ADMISSION_SCHEMA_VERSION,
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			requestId: request.requestId,
			verificationId: request.verificationId,
			gateDigest: request.manifest.manifestDigest,
			candidateCommit: request.candidate.candidateCommit,
			dependency,
			secretScan,
			outcome: "inconclusive",
			reasonCodes: ["dependency:collector_unavailable", "secret_scan:scanner_unavailable"],
		};
		return { ...body, bundleDigest: verificationAdmissionBundleDigest(body) };
	}

	public async evaluate(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationAdmissionBundle>> {
		let collected: Awaited<ReturnType<VerificationAdmissionInputPort["collect"]>>;
		try {
			collected = await this.#source.collect(request, signal);
		} catch {
			return { ok: true, value: this.#createUnavailable(request) };
		}
		if (!collected.ok || !correlatedInput(request, collected.value)) {
			return { ok: true, value: this.#createUnavailable(request) };
		}
		const identity = sourceIdentity(this.#source);
		const dependency = evaluateDependencyAdmission(request.manifest.dependencyPolicy, collected.value.dependency, {
			clock: this.#clock,
			expectedCollectorId: identity.collectorId,
			expectedCollectorIdentityDigest: identity.collectorIdentityDigest,
		});
		const secretScan = this.#secretScan.evaluate(request.manifest.secretScanPolicy, collected.value.secretScan, {
			expectedScannerId: identity.collectorId,
			expectedScannerIdentityDigest: identity.collectorIdentityDigest,
		});
		if (!dependency.ok || !secretScan.ok) return { ok: true, value: this.#createUnavailable(request) };
		const outcome = outcomeOf(dependency.value, secretScan.value);
		const reasonCodes = [
			...dependency.value.findings.map((entry) => `dependency:${entry.code}`),
			...secretScan.value.reasonCodes.map((entry) => `secret_scan:${entry}`),
		];
		const body: Omit<VerificationAdmissionBundle, "bundleDigest"> = {
			schemaVersion: VERIFICATION_ADMISSION_SCHEMA_VERSION,
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			requestId: request.requestId,
			verificationId: request.verificationId,
			gateDigest: request.manifest.manifestDigest,
			candidateCommit: request.candidate.candidateCommit,
			dependency: dependency.value,
			secretScan: secretScan.value,
			outcome,
			reasonCodes: [...new Set(reasonCodes)].slice(0, 64),
		};
		const bundle = { ...body, bundleDigest: verificationAdmissionBundleDigest(body) };
		return isVerificationAdmissionBundle(bundle)
			? { ok: true, value: bundle }
			: { ok: false, error: { code: "invalid_schema", message: "verification admission bundle is invalid", retryable: false } };
	}
}
