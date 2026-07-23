/** Trusted-base dependency admission policy 与 bounded receipt。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../protocol/v3/ids.ts";
import {
	DEPENDENCY_ADMISSION_SCHEMA_VERSION,
	type AdmissionOutcome,
	type DependencyAdmissionException,
	type DependencyAdmissionFinding,
	type DependencyAdmissionInput,
	type DependencyAdmissionPolicy,
	type DependencyAdmissionReasonCode,
	type DependencyAdmissionReceipt,
	type DependencyObservation,
	type VerificationCoreResult,
} from "./types.ts";

const DIGEST = /^[a-f0-9]{64}$/u;
const TOKEN = /^[A-Za-z0-9@][A-Za-z0-9@/._+~-]{0,511}$/u;
const EXCEPTION_FORBIDDEN = new Set<DependencyAdmissionReasonCode>([
	"collector_unavailable",
	"coverage_incomplete",
	"evidence_truncated",
	"lifecycle_script_present",
	"policy_mismatch",
]);

function policyBody(
	policy: DependencyAdmissionPolicy,
): Omit<DependencyAdmissionPolicy, "policyDigest"> {
	const { policyDigest: _policyDigest, ...body } = policy;
	return body;
}

function observationBody(
	observation: DependencyObservation,
): Omit<DependencyObservation, "observationDigest"> {
	const { observationDigest: _observationDigest, ...body } = observation;
	return body;
}

function inputBody(input: DependencyAdmissionInput): Omit<DependencyAdmissionInput, "evidenceDigest"> {
	const { evidenceDigest: _evidenceDigest, ...body } = input;
	return body;
}

function receiptBody(
	receipt: DependencyAdmissionReceipt,
): Omit<DependencyAdmissionReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function validTimestamp(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
}

function validRegistrySource(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			url.toString() === value
		);
	} catch {
		return false;
	}
}

function unique(values: readonly string[]): boolean {
	return new Set(values).size === values.length;
}

function validException(value: DependencyAdmissionException): boolean {
	return (
		TOKEN.test(value.exceptionId) &&
		TOKEN.test(value.packageName) &&
		TOKEN.test(value.version) &&
		DIGEST.test(value.registryIdentityDigest) &&
		value.allowedReasonCodes.length > 0 &&
		unique(value.allowedReasonCodes) &&
		value.allowedReasonCodes.every((code) => !EXCEPTION_FORBIDDEN.has(code)) &&
		DIGEST.test(value.approvalReceiptDigest) &&
		DIGEST.test(value.reasonDigest) &&
		validTimestamp(value.expiresAt)
	);
}

export function dependencyAdmissionPolicyDigest(
	policy: Omit<DependencyAdmissionPolicy, "policyDigest">,
): string {
	return canonicalDigest(policy);
}

export function isDependencyAdmissionPolicy(value: unknown): value is DependencyAdmissionPolicy {
	if (typeof value !== "object" || value === null) return false;
	const policy = value as Partial<DependencyAdmissionPolicy>;
	if (
		policy.schemaVersion !== DEPENDENCY_ADMISSION_SCHEMA_VERSION ||
		typeof policy.policyId !== "string" || !TOKEN.test(policy.policyId) ||
		!Number.isSafeInteger(policy.policyRevision) || Number(policy.policyRevision) < 1 ||
		(policy.installMode !== "none" && policy.installMode !== "frozen") ||
		(policy.lockfileSource !== "none" && policy.lockfileSource !== "trusted_baseline" && policy.lockfileSource !== "candidate_pinned") ||
		typeof policy.requireLockfileEntry !== "boolean" ||
		typeof policy.requireIntegrityDigest !== "boolean" ||
		!Array.isArray(policy.allowedRegistries) || policy.allowedRegistries.length > 64 ||
		!Number.isSafeInteger(policy.minimumPublishAgeMs) || Number(policy.minimumPublishAgeMs) < 0 || Number(policy.minimumPublishAgeMs) > 31_536_000_000 ||
		policy.lifecycleScripts !== "deny" ||
		!Array.isArray(policy.exceptions) || policy.exceptions.length > 256 ||
		!Number.isSafeInteger(policy.maxDependencies) || Number(policy.maxDependencies) < 1 || Number(policy.maxDependencies) > 100_000 ||
		!Number.isSafeInteger(policy.maxFindings) || Number(policy.maxFindings) < 1 || Number(policy.maxFindings) > 10_000 ||
		typeof policy.policyDigest !== "string" || !DIGEST.test(policy.policyDigest)
	) return false;
	const lockfileRequired = policy.lockfileSource !== "none";
	if (
		lockfileRequired !== Boolean(policy.lockfilePath && policy.lockfileDigest) ||
		(policy.installMode === "frozen" && !lockfileRequired) ||
		(policy.lockfilePath !== undefined && (policy.lockfilePath.length > 4096 || policy.lockfilePath.startsWith("/") || policy.lockfilePath.includes("\\") || policy.lockfilePath.split("/").some((part) => part === "" || part === "." || part === ".."))) ||
		(policy.lockfileDigest !== undefined && !DIGEST.test(policy.lockfileDigest))
	) return false;
	if (!policy.allowedRegistries.every((registry) => (
		TOKEN.test(registry.registryId) && validRegistrySource(registry.source) && DIGEST.test(registry.identityDigest)
	))) return false;
	if (!unique(policy.allowedRegistries.map((registry) => registry.registryId))) return false;
	if (!policy.exceptions.every(validException) || !unique(policy.exceptions.map((entry) => entry.exceptionId))) return false;
	const complete = policy as DependencyAdmissionPolicy;
	return complete.policyDigest === dependencyAdmissionPolicyDigest(policyBody(complete));
}

export function dependencyObservationDigest(
	observation: Omit<DependencyObservation, "observationDigest">,
): string {
	return canonicalDigest(observation);
}

function validObservation(value: DependencyObservation): boolean {
	return (
		TOKEN.test(value.packageName) &&
		TOKEN.test(value.version) &&
		TOKEN.test(value.registryId) &&
		typeof value.source === "string" && value.source.length <= 4096 &&
		DIGEST.test(value.registryIdentityDigest) &&
		(value.integrityDigest === undefined || DIGEST.test(value.integrityDigest)) &&
		(value.lockfileIntegrityDigest === undefined || DIGEST.test(value.lockfileIntegrityDigest)) &&
		(value.lockfileEntryDigest === undefined || DIGEST.test(value.lockfileEntryDigest)) &&
		(value.publishedAt === undefined || validTimestamp(value.publishedAt)) &&
		Array.isArray(value.lifecycleScripts) && value.lifecycleScripts.length <= 32 &&
		value.lifecycleScripts.every((script) => TOKEN.test(script)) &&
		unique(value.lifecycleScripts) &&
		DIGEST.test(value.observationDigest) &&
		value.observationDigest === dependencyObservationDigest(observationBody(value))
	);
}

export function dependencyAdmissionInputDigest(
	input: Omit<DependencyAdmissionInput, "evidenceDigest">,
): string {
	return canonicalDigest(input);
}

export function isDependencyAdmissionInput(value: unknown): value is DependencyAdmissionInput {
	if (typeof value !== "object" || value === null) return false;
	const input = value as Partial<DependencyAdmissionInput>;
	return (
		input.schemaVersion === DEPENDENCY_ADMISSION_SCHEMA_VERSION &&
		typeof input.authorityId === "string" && input.authorityId.startsWith("authority_") &&
		typeof input.tenantId === "string" && input.tenantId.startsWith("tenant_") &&
		typeof input.requestId === "string" && input.requestId.startsWith("command_") &&
		typeof input.verificationId === "string" && input.verificationId.startsWith("verification_") &&
		typeof input.gateDigest === "string" && DIGEST.test(input.gateDigest) &&
		typeof input.candidateCommit === "string" && input.candidateCommit.length > 0 && input.candidateCommit.length <= 512 &&
		typeof input.policyDigest === "string" && DIGEST.test(input.policyDigest) &&
		typeof input.collectorId === "string" && TOKEN.test(input.collectorId) &&
		typeof input.collectorIdentityDigest === "string" && DIGEST.test(input.collectorIdentityDigest) &&
		typeof input.lockfile === "object" && input.lockfile !== null &&
		(input.lockfile.path === undefined || (typeof input.lockfile.path === "string" && input.lockfile.path.length <= 4096)) &&
		(input.lockfile.observedDigest === undefined || (typeof input.lockfile.observedDigest === "string" && DIGEST.test(input.lockfile.observedDigest))) &&
		Number.isSafeInteger(input.lockfile.entryCount) && Number(input.lockfile.entryCount) >= 0 &&
		typeof input.lockfile.complete === "boolean" &&
		typeof input.manifestInventoryDigest === "string" && DIGEST.test(input.manifestInventoryDigest) &&
		Number.isSafeInteger(input.manifestCount) && Number(input.manifestCount) >= 0 &&
		Array.isArray(input.dependencies) && input.dependencies.every(validObservation) &&
		typeof input.truncated === "boolean" &&
		typeof input.collectedAt === "string" && validTimestamp(input.collectedAt) &&
		typeof input.evidenceDigest === "string" && DIGEST.test(input.evidenceDigest) &&
		input.evidenceDigest === dependencyAdmissionInputDigest(inputBody(input as DependencyAdmissionInput))
	);
}

export function dependencyAdmissionReceiptDigest(
	receipt: Omit<DependencyAdmissionReceipt, "receiptDigest">,
): string {
	return canonicalDigest(receipt);
}

export function isDependencyAdmissionReceipt(value: unknown): value is DependencyAdmissionReceipt {
	if (typeof value !== "object" || value === null) return false;
	const receipt = value as Partial<DependencyAdmissionReceipt>;
	return (
		receipt.schemaVersion === DEPENDENCY_ADMISSION_SCHEMA_VERSION &&
		typeof receipt.receiptId === "string" && receipt.receiptId.startsWith("receipt_") &&
		typeof receipt.requestId === "string" && receipt.requestId.startsWith("command_") &&
		typeof receipt.verificationId === "string" && receipt.verificationId.startsWith("verification_") &&
		typeof receipt.gateDigest === "string" && DIGEST.test(receipt.gateDigest) &&
		typeof receipt.policyDigest === "string" && DIGEST.test(receipt.policyDigest) &&
		(receipt.outcome === "passed" || receipt.outcome === "blocked" || receipt.outcome === "inconclusive") &&
		Array.isArray(receipt.findings) && receipt.findings.length <= 10_000 &&
		typeof receipt.receiptDigest === "string" && DIGEST.test(receipt.receiptDigest) &&
		receipt.receiptDigest === dependencyAdmissionReceiptDigest(receiptBody(receipt as DependencyAdmissionReceipt))
	);
}

function exceptionAllows(
	exceptions: readonly DependencyAdmissionException[],
	observation: DependencyObservation,
	code: DependencyAdmissionReasonCode,
	at: number,
): boolean {
	if (EXCEPTION_FORBIDDEN.has(code)) return false;
	return exceptions.some((entry) => (
		entry.packageName === observation.packageName &&
		entry.version === observation.version &&
		entry.registryIdentityDigest === observation.registryIdentityDigest &&
		entry.allowedReasonCodes.some((allowed) => allowed === code) &&
		Date.parse(entry.expiresAt) > at
	));
}

function finding(
	code: DependencyAdmissionReasonCode,
	input: DependencyAdmissionInput,
	observation?: DependencyObservation,
): DependencyAdmissionFinding {
	const subject = observation
		? {
			packageName: observation.packageName,
			version: observation.version,
			registryId: observation.registryId,
			sourceDigest: canonicalDigest(observation.source),
			observationDigest: observation.observationDigest,
		}
		: { evidenceDigest: input.evidenceDigest, code };
	return {
		code,
		...(observation ? { packageName: observation.packageName, version: observation.version } : {}),
		subjectDigest: canonicalDigest(subject),
	};
}

function createReceipt(
	policy: DependencyAdmissionPolicy,
	input: DependencyAdmissionInput,
	outcome: AdmissionOutcome,
	findings: readonly DependencyAdmissionFinding[],
	findingsTruncated: boolean,
	evaluatedAt: string,
): DependencyAdmissionReceipt {
	const body: Omit<DependencyAdmissionReceipt, "receiptDigest"> = {
		schemaVersion: DEPENDENCY_ADMISSION_SCHEMA_VERSION,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		receiptId: createRuntimeId("receipt", `dependency-admission-${canonicalDigest({
			requestId: input.requestId,
			verificationId: input.verificationId,
			policyDigest: policy.policyDigest,
			inputEvidenceDigest: input.evidenceDigest,
		}).slice(0, 48)}`),
		requestId: input.requestId,
		verificationId: input.verificationId,
		gateDigest: input.gateDigest,
		candidateCommit: input.candidateCommit,
		policyId: policy.policyId,
		policyRevision: policy.policyRevision,
		policyDigest: policy.policyDigest,
		collectorId: input.collectorId,
		collectorIdentityDigest: input.collectorIdentityDigest,
		inputEvidenceDigest: input.evidenceDigest,
		outcome,
		dependencyCount: input.dependencies.length,
		findings,
		findingsTruncated,
		evaluatedAt,
	};
	return { ...body, receiptDigest: dependencyAdmissionReceiptDigest(body) };
}

export interface DependencyAdmissionEvaluationOptions {
	clock?: () => Date;
	expectedCollectorId?: string;
	expectedCollectorIdentityDigest?: string;
}

export function evaluateDependencyAdmission(
	policy: DependencyAdmissionPolicy,
	input: DependencyAdmissionInput,
	options: DependencyAdmissionEvaluationOptions = {},
): VerificationCoreResult<DependencyAdmissionReceipt> {
	const evaluatedAt = (options.clock ?? (() => new Date()))().toISOString();
	if (!isDependencyAdmissionPolicy(policy)) {
		return { ok: false, error: { code: "invalid_schema", message: "dependency admission policy is invalid", retryable: false } };
	}
	if (!isDependencyAdmissionInput(input)) {
		return { ok: false, error: { code: "invalid_schema", message: "dependency admission evidence is invalid", retryable: false } };
	}
	const findings: DependencyAdmissionFinding[] = [];
	const add = (code: DependencyAdmissionReasonCode, observation?: DependencyObservation): void => {
		if (observation && exceptionAllows(policy.exceptions, observation, code, Date.parse(evaluatedAt))) return;
		findings.push(finding(code, input, observation));
	};
	if (
		input.policyDigest !== policy.policyDigest ||
		(options.expectedCollectorId !== undefined && input.collectorId !== options.expectedCollectorId) ||
		(options.expectedCollectorIdentityDigest !== undefined && input.collectorIdentityDigest !== options.expectedCollectorIdentityDigest)
	) add("policy_mismatch");
	if (policy.installMode === "none" && (input.dependencies.length > 0 || input.lockfile.entryCount > 0)) {
		add("policy_mismatch");
	}
	if (!input.lockfile.complete) add("coverage_incomplete");
	if (input.truncated || input.dependencies.length > policy.maxDependencies) add("evidence_truncated");
	if (policy.lockfileSource !== "none") {
		if (!input.lockfile.path || !input.lockfile.observedDigest) add("lockfile_missing");
		else if (input.lockfile.path !== policy.lockfilePath || input.lockfile.observedDigest !== policy.lockfileDigest) add("lockfile_digest_mismatch");
		if (policy.requireLockfileEntry && input.lockfile.entryCount !== input.dependencies.length) add("coverage_incomplete");
	}
	const observedKeys = new Set<string>();
	const collectedAt = Date.parse(input.collectedAt);
	for (const observation of input.dependencies) {
		const key = `${observation.packageName}\0${observation.version}\0${observation.source}`;
		if (observedKeys.has(key)) {
			add("coverage_incomplete", observation);
			continue;
		}
		observedKeys.add(key);
		const registry = policy.allowedRegistries.find((entry) => entry.registryId === observation.registryId);
		if (!registry) add("registry_not_allowed", observation);
		else {
			if (registry.source !== observation.source) add("source_not_allowed", observation);
			if (registry.identityDigest !== observation.registryIdentityDigest) add("registry_identity_mismatch", observation);
		}
		if (policy.requireLockfileEntry && !observation.lockfileEntryDigest) add("lockfile_entry_missing", observation);
		if (policy.requireIntegrityDigest) {
			if (!observation.integrityDigest || !observation.lockfileIntegrityDigest) add("integrity_digest_missing", observation);
			else if (observation.integrityDigest !== observation.lockfileIntegrityDigest) add("integrity_digest_mismatch", observation);
		}
		if (policy.minimumPublishAgeMs > 0) {
			if (!observation.publishedAt) add("publish_time_missing", observation);
			else {
				const publishedAt = Date.parse(observation.publishedAt);
				if (!Number.isFinite(publishedAt) || publishedAt > collectedAt) add("publish_time_invalid", observation);
				else if (collectedAt - publishedAt < policy.minimumPublishAgeMs) add("cooling_period_active", observation);
			}
		}
		if (observation.lifecycleScripts.length > 0) add("lifecycle_script_present", observation);
	}
	const inconclusive = findings.some((entry) => [
		"collector_unavailable",
		"coverage_incomplete",
		"evidence_truncated",
		"policy_mismatch",
	].includes(entry.code));
	const outcome: AdmissionOutcome = findings.length === 0 ? "passed" : inconclusive ? "inconclusive" : "blocked";
	const bounded = findings.slice(0, policy.maxFindings);
	return {
		ok: true,
		value: createReceipt(policy, input, outcome, bounded, findings.length > bounded.length, evaluatedAt),
	};
}

export function createUnavailableDependencyAdmissionReceipt(input: {
	policy: DependencyAdmissionPolicy;
	authorityId: DependencyAdmissionInput["authorityId"];
	tenantId: DependencyAdmissionInput["tenantId"];
	requestId: DependencyAdmissionInput["requestId"];
	verificationId: DependencyAdmissionInput["verificationId"];
	gateDigest: string;
	candidateCommit: string;
	collectorId: string;
	collectorIdentityDigest: string;
	evaluatedAt: string;
}): DependencyAdmissionReceipt {
	const evidence: Omit<DependencyAdmissionInput, "evidenceDigest"> = {
		schemaVersion: DEPENDENCY_ADMISSION_SCHEMA_VERSION,
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		requestId: input.requestId,
		verificationId: input.verificationId,
		gateDigest: input.gateDigest,
		candidateCommit: input.candidateCommit,
		policyDigest: input.policy.policyDigest,
		collectorId: input.collectorId,
		collectorIdentityDigest: input.collectorIdentityDigest,
		lockfile: { entryCount: 0, complete: false },
		manifestInventoryDigest: canonicalDigest({ unavailable: true, kind: "dependency_inventory" }),
		manifestCount: 0,
		dependencies: [],
		truncated: true,
		collectedAt: input.evaluatedAt,
	};
	const completed: DependencyAdmissionInput = {
		...evidence,
		evidenceDigest: dependencyAdmissionInputDigest(evidence),
	};
	return createReceipt(
		input.policy,
		completed,
		"inconclusive",
		[finding("collector_unavailable", completed)],
		false,
		input.evaluatedAt,
	);
}
