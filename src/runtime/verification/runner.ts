/** Typed invocation 构造；不解析 shell 字符串，也不执行进程。 */

import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isWorkspaceExecutionEnvelope } from "../protocol/v3/workspace.ts";
import { isTrustedBaselineReceipt } from "./baseline.ts";
import { CandidateIdentitySchema } from "./evidence.ts";
import { isGateManifest } from "./gate-loader.ts";
import type {
	GateManifest,
	TrustedBaselineReceipt,
	VerificationCoreResult,
	VerificationInvocation,
	VerificationRunnerRequest,
} from "./types.ts";

function failure(message: string): VerificationCoreResult<never> {
	return { ok: false, error: { code: "invalid_schema", message, retryable: false } };
}

function invocationBody(invocation: VerificationInvocation): Omit<VerificationInvocation, "invocationDigest"> {
	const { invocationDigest: _invocationDigest, ...body } = invocation;
	return body;
}

export function candidateEnvelopeMatches(request: VerificationRunnerRequest): boolean {
	const { candidate, candidateEnvelope: envelope } = request;
	return (
		candidate.authorityId === envelope.authorityId &&
		candidate.tenantId === envelope.tenantId &&
		candidate.repositoryId === envelope.repositoryId &&
		candidate.workspaceId === envelope.workspaceId &&
		candidate.baseCommit === envelope.baseCommit &&
		request.baseline.authorityId === candidate.authorityId &&
		request.baseline.tenantId === candidate.tenantId &&
		request.baseline.repositoryId === candidate.repositoryId &&
		request.baseline.baseCommit === candidate.baseCommit
	);
}

/**
 * trustedEnvironment 由 verification-runner composition root 注入。candidate env 不在
 * 此函数参数中，因此不能覆盖 PATH、CI 或 gate 固定值。
 */
export function createVerificationInvocation(
	request: VerificationRunnerRequest,
	trustedEnvironment: Readonly<Record<string, string>>,
): VerificationCoreResult<VerificationInvocation> {
	if (
		!isGateManifest(request.manifest) ||
		!isTrustedBaselineReceipt(request.baseline) ||
		!Check(CandidateIdentitySchema, request.candidate) ||
		!isWorkspaceExecutionEnvelope(request.candidateEnvelope)
	) return failure("verification runner request contains an invalid manifest, baseline, or workspace envelope");
	if (!candidateEnvelopeMatches(request)) return failure("candidate identity does not match workspace envelope");
	const values: { name: string; value: string }[] = [];
	for (const entry of request.manifest.environment.values) {
		const value = entry.source === "fixed" ? entry.value : trustedEnvironment[entry.name];
		if (value === undefined || value.length > 16_384 || value.includes("\0")) {
			return failure(`trusted environment value is unavailable or invalid: ${entry.name}`);
		}
		values.push({ name: entry.name, value });
	}
	values.sort((left, right) => left.name.localeCompare(right.name));
	const body: Omit<VerificationInvocation, "invocationDigest"> = {
		schemaVersion: 1,
		requestId: request.requestId,
		verificationId: request.verificationId,
		gateId: request.manifest.gateId,
		gateDigest: request.manifest.manifestDigest,
		baselineReceiptDigest: request.baseline.receiptDigest,
		candidate: request.candidate,
		executable: request.manifest.executable,
		arguments: request.manifest.arguments,
		cwd: request.manifest.cwd,
		baseConfiguration: request.manifest.baseConfiguration,
		dependencyPolicy: request.manifest.dependencyPolicy,
		secretScanPolicy: request.manifest.secretScanPolicy,
		environment: values,
			environmentAllowlist: request.manifest.environment.allowlist,
			network: request.manifest.network,
			...(request.manifest.browser ? { browser: request.manifest.browser } : {}),
			sandbox: request.manifest.sandbox,
		timeoutMs: request.manifest.timeoutMs,
		expectedExitCodes: request.manifest.expectedExitCodes,
		expectedArtifacts: request.manifest.expectedArtifacts,
	};
	try {
		return { ok: true, value: { ...body, invocationDigest: canonicalDigest(body) } };
	} catch {
		return failure("typed verification invocation is not canonically encodable");
	}
}

export function isVerificationInvocationCorrelated(
	invocation: VerificationInvocation,
	manifest: GateManifest,
	baseline: TrustedBaselineReceipt,
): boolean {
	return (
		invocation.invocationDigest === canonicalDigest(invocationBody(invocation)) &&
		invocation.gateId === manifest.gateId &&
		invocation.gateDigest === manifest.manifestDigest &&
		invocation.baselineReceiptDigest === baseline.receiptDigest &&
		invocation.executable.source === "trusted_baseline" &&
		invocation.executable.digest === manifest.executable.digest &&
		canonicalDigest(invocation.dependencyPolicy) === canonicalDigest(manifest.dependencyPolicy) &&
		canonicalDigest(invocation.secretScanPolicy) === canonicalDigest(manifest.secretScanPolicy) &&
		canonicalDigest(invocation.browser ?? null) === canonicalDigest(manifest.browser ?? null)
	);
}
