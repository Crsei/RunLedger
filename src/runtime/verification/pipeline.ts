/** Trusted baseline -> typed runner -> evidence -> signed report 的独立流水线。 */

import type { TrustedBaselineCoordinator } from "./baseline.ts";
import { createVerificationResult } from "./evidence.ts";
import { loadTrustedGate } from "./gate-loader.ts";
import { createVerificationReport, TrustedVerifierIssuerRegistry } from "./security.ts";
import type {
	TrustedGateSourcePort,
	VerificationAdmissionPort,
	VerificationCoreResult,
	VerificationPipelineJournalPort,
	VerificationPipelineRequest,
	VerificationReport,
	VerificationRunnerPort,
	VerifierIssuerPort,
} from "./types.ts";

export interface VerificationPipelineOptions {
	baseline: TrustedBaselineCoordinator;
	gateSource: TrustedGateSourcePort;
	runner: VerificationRunnerPort;
	admission: VerificationAdmissionPort;
	issuer: VerifierIssuerPort;
	issuerRegistry: TrustedVerifierIssuerRegistry;
	journal?: VerificationPipelineJournalPort;
}

function failure(
	code: "scope_mismatch" | "authorization_required" | "authorization_denied" | "sandbox_unavailable" | "evidence_unavailable" | "invalid_signature" | "admission_blocked" | "admission_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

export class VerificationPipeline {
	readonly #baseline: TrustedBaselineCoordinator;
	readonly #gateSource: TrustedGateSourcePort;
	readonly #runner: VerificationRunnerPort;
	readonly #admission: VerificationAdmissionPort;
	readonly #issuer: VerifierIssuerPort;
	readonly #issuerRegistry: TrustedVerifierIssuerRegistry;
	readonly #journal: VerificationPipelineJournalPort | undefined;

	public constructor(options: VerificationPipelineOptions) {
		this.#baseline = options.baseline;
		this.#gateSource = options.gateSource;
		this.#runner = options.runner;
		this.#admission = options.admission;
		this.#issuer = options.issuer;
		this.#issuerRegistry = options.issuerRegistry;
		this.#journal = options.journal;
	}

	public async verify(
		request: VerificationPipelineRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationReport>> {
		if (this.#journal) {
			let existing: Awaited<ReturnType<VerificationPipelineJournalPort["resolveExisting"]>>;
			try {
				existing = await this.#journal.resolveExisting(request);
			} catch {
				return failure("evidence_unavailable", "verification journal is unavailable", true);
			}
			if (!existing.ok) return existing;
			if (existing.value) {
				const report = existing.value;
				if (
					report.result.verificationId !== request.verificationId ||
					report.result.authorityId !== request.authorityId ||
					report.result.tenantId !== request.tenantId ||
					report.result.candidate.repositoryId !== request.repositoryId ||
					report.result.candidate.workspaceId !== request.candidate.workspaceId ||
					report.result.candidate.candidateCommit !== request.candidate.candidateCommit ||
					!(await this.#issuerRegistry.verify(report)).ok
				) return failure("invalid_signature", "durable verification report does not match the request");
				return { ok: true, value: report };
			}
		}
		const materialized = await this.#baseline.materialize(request, signal);
		if (!materialized.ok) return materialized;
		const { policy, receipt: baseline } = materialized.value;
		if (
			request.candidate.authorityId !== request.authorityId ||
			request.candidate.tenantId !== request.tenantId ||
			request.candidate.repositoryId !== request.repositoryId ||
			request.candidate.baseCommit !== policy.baseCommit
		) return failure("scope_mismatch", "candidate identity is not based on trusted policy commit");
		const loaded = await loadTrustedGate(policy, baseline, this.#gateSource);
		if (!loaded.ok) return loaded;
		let admission: Awaited<ReturnType<VerificationAdmissionPort["evaluate"]>>;
		try {
			admission = await this.#admission.evaluate({
				manifest: loaded.value.manifest,
				baseline,
				candidate: request.candidate,
				candidateEnvelope: request.candidateEnvelope,
				verificationId: request.verificationId,
				requestId: request.runnerRequestId,
			}, signal);
		} catch {
			return failure("admission_unavailable", "verification admission controller is unavailable", true);
		}
		if (!admission.ok) return admission;
		if (admission.value.outcome !== "passed") {
			return {
				ok: false,
				error: {
					code: admission.value.outcome === "blocked" ? "admission_blocked" : "admission_unavailable",
					message: admission.value.outcome === "blocked"
						? "candidate failed required dependency or Secret Scan admission"
						: "candidate admission evidence is incomplete or unavailable",
					retryable: admission.value.outcome === "inconclusive",
					details: { admissionReceiptDigest: admission.value.bundleDigest },
					admission: admission.value,
				},
			};
		}
		if (this.#journal) {
			let started: Awaited<ReturnType<VerificationPipelineJournalPort["recordStarted"]>>;
			try {
				started = await this.#journal.recordStarted(request, loaded.value.manifest, baseline);
			} catch {
				return failure("evidence_unavailable", "verification start could not be committed", true);
			}
			if (!started.ok) return started;
		}
		const attempt = await this.#runner.run(
			{
				manifest: loaded.value.manifest,
				baseline,
				candidate: request.candidate,
				candidateEnvelope: request.candidateEnvelope,
				verificationId: request.verificationId,
				requestId: request.runnerRequestId,
			},
			signal,
		);
		if (!attempt.ok) return attempt;
		if (attempt.value.status !== "executed" || !attempt.value.evidence) {
			if (attempt.value.status === "authorization_required") {
				return failure("authorization_required", "verification execution requires approval", true);
			}
			if (attempt.value.status === "denied") {
				return failure("authorization_denied", "verification execution was denied");
			}
			return failure("sandbox_unavailable", "verification runner is unavailable", true);
		}
		const result = createVerificationResult(baseline, attempt.value.invocation, attempt.value.evidence, admission.value);
		if (!result.ok) return result;
		let issued: Awaited<ReturnType<VerifierIssuerPort["issue"]>>;
		try {
			issued = await this.#issuer.issue(result.value);
		} catch {
			return failure("evidence_unavailable", "verifier issuer is unavailable", true);
		}
		if (!issued.ok) return issued;
		const report = createVerificationReport(result.value, issued.value);
		if (!report.ok) return report;
		const trusted = await this.#issuerRegistry.verify(report.value);
		if (!trusted.ok) return failure("invalid_signature", trusted.error.message);
		if (this.#journal) {
			let finished: Awaited<ReturnType<VerificationPipelineJournalPort["recordFinished"]>>;
			try {
				finished = await this.#journal.recordFinished(request, report.value);
			} catch {
				return failure("evidence_unavailable", "verification report could not be committed", true);
			}
			if (!finished.ok) return finished;
		}
		return report;
	}
}
