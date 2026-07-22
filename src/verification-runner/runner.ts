/** 独立 runner host：只调用注入端口，不直接 spawn、建 worktree 或读取 candidate scripts。 */

import { Check } from "typebox/value";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	CapabilityGatewayResultSchema,
	SandboxExecutorResultSchema,
	capabilityGatewayRequestDigest,
	type ApprovalReceiptRef,
	type CapabilityClaim,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequestBody,
	type CapabilityRequestRef,
	type SandboxExecutorPort,
} from "../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import {
	isWorkspaceServiceResult,
	isWorkspaceValidationReceiptForEnvelope,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceServicePort,
} from "../runtime/protocol/v3/workspace.ts";
import { createVerificationInvocation } from "../runtime/verification/runner.ts";
import type {
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationRunnerAttempt,
	VerificationRunnerPort,
	VerificationRunnerRequest,
} from "../runtime/verification/types.ts";
import type { BrowserBackendPort } from "./browser/evidence.ts";
import { RestrictedBrowserVerificationProvider } from "./browser/provider.ts";

export interface PortBackedVerificationRunnerOptions {
	workspace: WorkspaceServicePort;
	capability: CapabilityGatewayPort;
	sandbox: SandboxExecutorPort;
	artifacts: VerificationArtifactPort;
	browserBackend?: BrowserBackendPort;
	trustedEnvironment?: Readonly<Record<string, string>>;
	clock?: () => Date;
}

function failure(
	code: "workspace_invalid" | "sandbox_unavailable" | "evidence_unavailable" | "invalid_schema",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function approvalReceiptBody(receipt: ApprovalReceiptRef): Omit<ApprovalReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function receiptMatchesRequest(receipt: ApprovalReceiptRef, request: CapabilityRequestRef): boolean {
	return receipt.authorityId === request.authorityId &&
		receipt.tenantId === request.tenantId &&
		receipt.principalId === request.principalId &&
		receipt.approvalId === request.approvalId &&
		receipt.requestId === request.requestId &&
		receipt.requestDigest === canonicalDigest(request) &&
		receipt.originalInputDigest === request.argumentsDigest &&
		receipt.receiptDigest === canonicalDigest(approvalReceiptBody(receipt));
}

function claim(
	request: VerificationRunnerRequest,
	name: CapabilityClaim["name"],
	resourceKind: Exclude<CapabilityClaim["resourceKind"], "browser_tool">,
	resourceDigest: string,
	constraints: unknown,
): CapabilityClaim {
	return {
		authorityId: request.candidate.authorityId,
		tenantId: request.candidate.tenantId,
		name,
		resourceKind,
		resourceDigest,
		constraintsDigest: canonicalDigest(constraints),
	};
}

function browserClaim(request: VerificationRunnerRequest): CapabilityClaim | undefined {
	const browser = request.manifest.browser;
	if (!browser) return undefined;
	const browserConstraints = {
		navigateOriginDigest: canonicalDigest(browser.origin),
		domReadScopeDigest: browser.stepSchemaDigest,
		scriptPolicyDigest: browser.assertionSchemaDigest,
		downloadScopeDigest: canonicalDigest(
			request.manifest.expectedArtifacts.filter((artifact) => artifact.kind === "screenshot"),
		),
		uploadScopeDigest: canonicalDigest({ allowed: false }),
		cookieCredentialScopeDigest: canonicalDigest({ allowed: false, profileDigest: browser.profile.identityDigest }),
		networkEgressScopeDigest: browser.networkPolicyDigest,
	};
	return {
		authorityId: request.candidate.authorityId,
		tenantId: request.candidate.tenantId,
		name: "browser",
		resourceKind: "browser_tool",
		resourceDigest: browser.runtime.identityDigest,
		constraintsDigest: canonicalDigest(browserConstraints),
		browserConstraints,
	};
}

function requestedClaims(request: VerificationRunnerRequest): readonly CapabilityClaim[] {
	const claims: CapabilityClaim[] = [
		claim(request, "repository_read", "workspace", request.candidate.bindingDigest, {
			workspaceId: request.candidate.workspaceId,
			candidateCommit: request.candidate.candidateCommit,
		}),
		claim(request, "process", "process", request.manifest.executable.digest, {
			gateDigest: request.manifest.manifestDigest,
			timeoutMs: request.manifest.timeoutMs,
		}),
	];
	if (request.manifest.dependencyPolicy.installMode === "frozen") {
		claims.push(claim(request, "dependency_install", "process", request.manifest.dependencyPolicy.lockfileDigest ?? request.manifest.manifestDigest, {
			installMode: "frozen",
			lifecycleScripts: "deny",
		}));
	}
	if (request.manifest.network.mode === "allowlist") {
		claims.push(claim(request, "network", "network", canonicalDigest(request.manifest.network.hosts), {
			hosts: request.manifest.network.hosts,
		}));
	}
	const browser = browserClaim(request);
	if (browser) claims.push(browser);
	return claims;
}

export class PortBackedVerificationRunner implements VerificationRunnerPort {
	readonly #workspace: WorkspaceServicePort;
	readonly #capability: CapabilityGatewayPort;
	readonly #sandbox: SandboxExecutorPort;
	readonly #artifacts: VerificationArtifactPort;
	readonly #trustedEnvironment: Readonly<Record<string, string>>;
	readonly #clock: () => Date;
	readonly #browser?: RestrictedBrowserVerificationProvider;

	public constructor(options: PortBackedVerificationRunnerOptions) {
		this.#workspace = options.workspace;
		this.#capability = options.capability;
		this.#sandbox = options.sandbox;
		this.#artifacts = options.artifacts;
		this.#trustedEnvironment = options.trustedEnvironment ?? {};
		this.#clock = options.clock ?? (() => new Date());
		this.#browser = options.browserBackend
			? new RestrictedBrowserVerificationProvider({
					workspace: options.workspace,
					capability: options.capability,
					sandbox: options.sandbox,
					artifacts: options.artifacts,
					backend: options.browserBackend,
					trustedEnvironment: options.trustedEnvironment,
					clock: options.clock,
				})
			: undefined;
	}

	public async run(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationRunnerAttempt>> {
		if (request.manifest.kind === "browser") {
			if (this.#browser) return this.#browser.run(request, signal);
			const invocation = createVerificationInvocation(request, this.#trustedEnvironment);
			if (!invocation.ok) return invocation;
			return {
				ok: true,
				value: {
					invocation: invocation.value,
					status: "unavailable",
					reasonCodes: ["browser_backend_unsupported"],
				},
			};
		}
		const invocation = createVerificationInvocation(request, this.#trustedEnvironment);
		if (!invocation.ok) return invocation;
		const envelopeDigest = workspaceExecutionEnvelopeDigest(request.candidateEnvelope);
		let workspaceResult: Awaited<ReturnType<WorkspaceServicePort["request"]>>;
		try {
			workspaceResult = await this.#workspace.request(
				{
					schemaVersion: 1,
					requestId: request.requestId,
					authorityId: request.candidate.authorityId,
					tenantId: request.candidate.tenantId,
					principalId: request.candidateEnvelope.principalId,
					sessionId: request.candidateEnvelope.sessionId,
					agentId: request.candidateEnvelope.agentId,
					traceId: request.candidateEnvelope.traceId,
					kind: "validate",
					envelope: request.candidateEnvelope,
					envelopeDigest,
				},
				signal,
			);
		} catch {
			return failure("workspace_invalid", "candidate workspace validation is unavailable", true);
		}
		if (
			!isWorkspaceServiceResult(workspaceResult) ||
			workspaceResult.kind !== "validated" ||
			workspaceResult.requestId !== request.requestId ||
			workspaceResult.validation.outcome !== "valid" ||
			!isWorkspaceValidationReceiptForEnvelope(workspaceResult.validation, request.candidateEnvelope)
		) return failure("workspace_invalid", "candidate workspace validation did not return a correlated valid receipt");

		const claims = requestedClaims(request);
		let authorization: Awaited<ReturnType<CapabilityGatewayPort["authorize"]>>;
		let capabilityRequestBody!: CapabilityGatewayRequestBody;
		try {
			const now = this.#clock();
			const correlationDigest = canonicalDigest({
				requestId: request.requestId,
				verificationId: request.verificationId,
				manifestDigest: request.manifest.manifestDigest,
				candidateCommit: request.candidate.candidateCommit,
			});
			capabilityRequestBody = {
				request: {
					authorityId: request.candidate.authorityId,
					tenantId: request.candidate.tenantId,
					principalId: request.candidateEnvelope.principalId,
					requestId: request.requestId,
					approvalId: createRuntimeId("approval", `verification-${correlationDigest.slice(0, 48)}`),
					sessionId: request.candidateEnvelope.sessionId,
					runtimeId: request.candidateEnvelope.ownerRuntimeId,
					runtimeGeneration: request.candidateEnvelope.leaseRevision,
					turnId: createRuntimeId("turn", `verification-${correlationDigest.slice(0, 48)}`),
					toolCallId: request.candidateEnvelope.toolCallId,
					capability: "process",
					argumentsDigest: invocation.value.invocationDigest,
					workspaceEnvelopeDigest: envelopeDigest,
					policyDigest: request.manifest.sandbox.policyDigest,
					serverScope: "verification_runner",
					resourceScopeDigest: canonicalDigest(
						claims.map(({ resourceKind, resourceDigest, constraintsDigest }) => ({
							resourceKind,
							resourceDigest,
							constraintsDigest,
						})),
					),
					commandScopeDigest: canonicalDigest({
						executable: request.manifest.executable,
						arguments: invocation.value.arguments,
						cwd: invocation.value.cwd,
					}),
				},
				invocation: {
					requestId: request.requestId,
					toolManifestDigest: request.manifest.manifestDigest,
					rawArguments: invocation.value,
					envelope: request.candidateEnvelope,
					requestedClaims: claims,
				},
				idempotencyKey: request.requestId,
				inputSources: [{
					schemaVersion: 1,
					authorityId: request.candidate.authorityId,
					tenantId: request.candidate.tenantId,
					sourceId: createRuntimeId(
						"inputSource",
						canonicalDigest({ requestId: request.requestId, gateDigest: request.manifest.manifestDigest }).slice(0, 32),
					),
					kind: "repository",
					sourceDigest: request.manifest.manifestDigest,
					trust: "tainted",
					taintLabels: ["repository_controlled"],
					observedAt: now.toISOString(),
				}],
				targetSink: "shell",
				declassificationReceipts: [],
			};
			authorization = await this.#capability.authorize(
				{
					...capabilityRequestBody,
					authentication: {
						channel: "local_process",
						channelBindingDigest: canonicalDigest({
							principalId: request.candidateEnvelope.principalId,
							requestId: request.requestId,
						}),
						requestDigest: capabilityGatewayRequestDigest(capabilityRequestBody),
						nonce: canonicalDigest({ requestId: request.requestId, issuedAt: now.toISOString() }).slice(0, 32),
						issuedAt: now.toISOString(),
						expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
						keyRevision: 0,
					},
				},
				signal,
			);
		} catch {
			return {
				ok: true,
				value: { invocation: invocation.value, status: "unavailable", reasonCodes: ["capability_gateway_unavailable"] },
			};
		}
		if (!Check(CapabilityGatewayResultSchema, authorization) || authorization.requestId !== request.requestId) {
			return failure("invalid_schema", "capability gateway returned an invalid or uncorrelated result");
		}
		if (authorization.decision === "ask") {
			if (
				authorization.approvalTicket.approvalId !== capabilityRequestBody.request.approvalId ||
				authorization.approvalTicket.authorityId !== capabilityRequestBody.request.authorityId ||
				authorization.approvalTicket.tenantId !== capabilityRequestBody.request.tenantId ||
				authorization.approvalTicket.principalId !== capabilityRequestBody.request.principalId ||
				canonicalDigest(authorization.approvalTicket.request) !== canonicalDigest(capabilityRequestBody.request)
			) return failure("invalid_schema", "capability approval ticket is not correlated to the verification request");
			return {
				ok: true,
				value: { invocation: invocation.value, status: "authorization_required", reasonCodes: ["approval_required"] },
			};
		}
		if (authorization.decision === "deny") {
			if (!receiptMatchesRequest(authorization.approvalReceipt, capabilityRequestBody.request)) {
				return failure("invalid_schema", "capability denial receipt is not correlated to the verification request");
			}
			return { ok: true, value: { invocation: invocation.value, status: "denied", reasonCodes: ["capability_denied"] } };
		}
		if (
			authorization.approvalReceipt !== undefined &&
			(!receiptMatchesRequest(authorization.approvalReceipt, capabilityRequestBody.request) ||
				authorization.approvalReceipt.decision !== "allowed" ||
				!authorization.approvalReceipt.evidenceComplete ||
				authorization.approvalReceipt.evidenceTruncated)
		) return failure("invalid_schema", "capability allow receipt is not correlated or lacks complete evidence");
		if (
			authorization.sandboxProfile.requested !== request.manifest.sandbox.profile ||
			authorization.sandboxProfile.policyDigest !== request.manifest.sandbox.policyDigest ||
			authorization.sandboxProfile.authorityId !== request.candidate.authorityId ||
			authorization.sandboxProfile.tenantId !== request.candidate.tenantId
		) return failure("invalid_schema", "authorized sandbox profile does not match trusted GateManifest");

		let sandboxResult: Awaited<ReturnType<SandboxExecutorPort["execute"]>>;
		try {
			sandboxResult = await this.#sandbox.execute(
				{
					authorityId: request.candidate.authorityId,
					tenantId: request.candidate.tenantId,
					principalId: request.candidateEnvelope.principalId,
					requestId: request.requestId,
					profile: authorization.sandboxProfile,
					invocationDigest: invocation.value.invocationDigest,
					resolutionDigest: authorization.decisionDigest,
					idempotencyKey: request.requestId,
					opaqueInvocation: invocation.value,
				},
				signal,
			);
		} catch {
			return failure("sandbox_unavailable", "sandbox executor is unavailable", true);
		}
		if (
			!Check(SandboxExecutorResultSchema, sandboxResult) ||
			sandboxResult.requestId !== request.requestId ||
			sandboxResult.executionReceipt.invocationDigest !== invocation.value.invocationDigest ||
			sandboxResult.executionReceipt.policyDigest !== request.manifest.sandbox.policyDigest
		) return failure("sandbox_unavailable", "sandbox returned an invalid or uncorrelated execution receipt");

		let evidence: Awaited<ReturnType<VerificationArtifactPort["resolveExecutionEvidence"]>>;
		try {
			evidence = await this.#artifacts.resolveExecutionEvidence(
				{
					authorityId: request.candidate.authorityId,
					tenantId: request.candidate.tenantId,
					requestId: request.requestId,
					verificationId: request.verificationId,
					invocationDigest: invocation.value.invocationDigest,
					candidate: request.candidate,
					expectedArtifacts: request.manifest.expectedArtifacts,
					sandboxReceipt: sandboxResult.executionReceipt,
				},
				signal,
			);
		} catch {
			return failure("evidence_unavailable", "execution Artifact evidence is unavailable", true);
		}
		if (!evidence.ok) return evidence;
		if (canonicalDigest(evidence.value.sandboxReceipt) !== canonicalDigest(sandboxResult.executionReceipt)) {
			return failure("evidence_unavailable", "execution evidence does not bind the sandbox execution receipt");
		}
		return {
			ok: true,
			value: { invocation: invocation.value, evidence: evidence.value, status: "executed", reasonCodes: [] },
		};
	}
}
