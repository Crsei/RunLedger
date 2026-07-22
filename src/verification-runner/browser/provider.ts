/** 仅供独立 verification runner 使用的 port-backed Browser provider。 */

import { Check } from "typebox/value";
import {
	CapabilityGatewayResultSchema,
	SandboxExecutorResultSchema,
	capabilityGatewayRequestDigest,
	isCapabilityGatewayRequest,
	type CapabilityClaim,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
	type CapabilityName,
	type SandboxExecutionReceiptRef,
	type SandboxExecutorPort,
} from "../../runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import {
	isWorkspaceServiceResult,
	isWorkspaceValidationReceiptForEnvelope,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceServicePort,
	type WorkspaceValidationReceiptRef,
} from "../../runtime/protocol/v3/workspace.ts";
import {
	browserEvidenceArtifactsDigest,
	browserExecutionBindingDigest,
	browserOperationReceiptDigest,
	browserOperationReceiptsDigest,
	executionEvidenceDigest,
	validateExecutionEvidence,
} from "../../runtime/verification/evidence.ts";
import { createVerificationInvocation } from "../../runtime/verification/runner.ts";
import type {
	BrowserExecutionReceipt,
	BrowserOperationReceipt,
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationExecutionEvidence,
	VerificationInvocation,
	VerificationRunnerAttempt,
	VerificationRunnerPort,
	VerificationRunnerRequest,
} from "../../runtime/verification/types.ts";
import {
	browserBackendRequestDigest,
	browserBackendResultMatchesRequest,
	type BrowserBackendPort,
	type BrowserBackendRequest,
	type BrowserBackendResult,
} from "./evidence.ts";
import {
	browserOperationDigest,
	createRestrictedBrowserProfile,
	restrictedProfileAllowsOperation,
	type BrowserBackendOperation,
	type RestrictedBrowserProfile,
} from "./profile.ts";

export interface RestrictedBrowserVerificationProviderOptions {
	workspace: WorkspaceServicePort;
	capability: CapabilityGatewayPort;
	sandbox: SandboxExecutorPort;
	artifacts: VerificationArtifactPort;
	backend: BrowserBackendPort;
	trustedEnvironment?: Readonly<Record<string, string>>;
	clock?: () => Date;
}

type AttemptStatus = Exclude<VerificationRunnerAttempt["status"], "executed">;

type OperationRunResult =
	| {
			status: "executed";
			receipt: BrowserOperationReceipt;
			sandboxReceipt: SandboxExecutionReceiptRef;
			backend: Extract<BrowserBackendResult, { status: "completed" }>;
	  }
	| { status: AttemptStatus; reasonCode: string };

function failure(
	code: "invalid_schema" | "workspace_invalid" | "sandbox_unavailable" | "evidence_unavailable",
	message: string,
	retryable = false,
): VerificationCoreResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function attempt(
	invocation: VerificationInvocation,
	status: AttemptStatus,
	reasonCode: string,
): VerificationCoreResult<VerificationRunnerAttempt> {
	return { ok: true, value: { invocation, status, reasonCodes: [reasonCode] } };
}

function operationId(
	request: VerificationRunnerRequest,
	operation: BrowserBackendOperation,
	sequence: number,
): VerificationRunnerRequest["requestId"] {
	if (operation.kind === "evidence_seal") return request.requestId;
	const digest = canonicalDigest({
		requestId: request.requestId,
		verificationId: request.verificationId,
		sequence,
		operation: browserOperationDigest(operation),
	});
	return createRuntimeId("command", `browser-${digest.slice(0, 48)}`);
}

function browserConstraints(request: VerificationRunnerRequest) {
	const browser = request.manifest.browser;
	if (!browser) throw new Error("browser gate is missing");
	return {
		navigateOriginDigest: canonicalDigest(browser.origin),
		domReadScopeDigest: browser.stepSchemaDigest,
		scriptPolicyDigest: canonicalDigest({ mode: "deny", schemaDigest: browser.assertionSchemaDigest }),
		downloadScopeDigest: canonicalDigest({ mode: "deny", profilePolicyDigest: browser.profile.policyDigest }),
		uploadScopeDigest: canonicalDigest({ mode: "deny", profilePolicyDigest: browser.profile.policyDigest }),
		cookieCredentialScopeDigest: canonicalDigest({
			cookie: "deny",
			credential: "deny",
			profilePolicyDigest: browser.profile.policyDigest,
		}),
		networkEgressScopeDigest: browser.networkPolicyDigest,
	};
}

function browserClaim(request: VerificationRunnerRequest): CapabilityClaim {
	const browser = request.manifest.browser;
	if (!browser) throw new Error("browser gate is missing");
	const constraints = browserConstraints(request);
	return {
		authorityId: request.candidate.authorityId,
		tenantId: request.candidate.tenantId,
		name: "browser",
		resourceKind: "browser_tool",
		resourceDigest: browser.runtime.identityDigest,
		constraintsDigest: canonicalDigest(constraints),
		browserConstraints: constraints,
	};
}

function additionalClaim(
	request: VerificationRunnerRequest,
	name: Exclude<CapabilityName, "browser">,
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

function operationClaims(
	request: VerificationRunnerRequest,
	operation: BrowserBackendOperation,
): readonly CapabilityClaim[] {
	const claims: CapabilityClaim[] = [browserClaim(request)];
	if (operation.kind === "launch") {
		claims.push(additionalClaim(request, "process", "process", request.manifest.browser!.runtime.identityDigest, {
			operation: "launch",
			profileIdentityDigest: request.manifest.browser!.profile.identityDigest,
		}));
	}
	if (operation.kind === "navigate" || operation.kind === "network" || operation.kind === "download") {
		claims.push(additionalClaim(request, "network", "network", request.manifest.browser!.networkPolicyDigest, {
			operation: operation.kind,
			origin: request.manifest.browser!.origin,
			networkPolicyDigest: request.manifest.browser!.networkPolicyDigest,
		}));
	}
	if (operation.kind === "cookie_credential" && operation.access === "credential") {
		claims.push(additionalClaim(request, "credential", "credential", operation.scopeDigest, {
			operation: operation.kind,
			access: operation.access,
		}));
	}
	return claims;
}

function primaryCapability(operation: BrowserBackendOperation): CapabilityName {
	if (operation.kind === "network") return "network";
	if (operation.kind === "cookie_credential" && operation.access === "credential") return "credential";
	return "browser";
}

function targetSink(operation: BrowserBackendOperation): "network" | "credential" | "verification" {
	if (operation.kind === "navigate" || operation.kind === "network" || operation.kind === "download") return "network";
	if (operation.kind === "cookie_credential") return "credential";
	return "verification";
}

function operationReceipt(
	sequence: number,
	operation: BrowserBackendOperation,
	operationCommandId: VerificationRunnerRequest["requestId"],
	operationDigest: string,
	capability: CapabilityName,
	capabilityRequestDigest: string,
	capabilityDecisionDigest: string,
	sandboxReceipt: SandboxExecutionReceiptRef,
	backend: Extract<BrowserBackendResult, { status: "completed" }>,
	bindingDigest: string,
): BrowserOperationReceipt {
	const common = {
		sequence,
		operationId: operationCommandId,
		operationDigest,
		capability,
		capabilityRequestDigest,
		capabilityDecisionDigest,
		sandboxReceiptId: sandboxReceipt.receiptId,
		sandboxInvocationDigest: sandboxReceipt.invocationDigest,
		sandboxReceiptDigest: canonicalDigest(sandboxReceipt),
		backendReceiptId: backend.receiptId,
		backendReceiptDigest: backend.receiptDigest,
		bindingDigest,
	};
	const seal = <T extends Omit<BrowserOperationReceipt, "receiptDigest">>(body: T): BrowserOperationReceipt => ({
		...body,
		receiptDigest: browserOperationReceiptDigest(body),
	} as BrowserOperationReceipt);
	switch (operation.kind) {
		case "launch":
			return seal({ ...common, kind: "launch" });
		case "navigate":
			return seal({
				...common,
				kind: "navigate",
				urlDigest: canonicalDigest(operation.url),
				originDigest: canonicalDigest(operation.origin),
			});
		case "network":
			return seal({
				...common,
				kind: "network",
				originDigest: canonicalDigest(operation.origin),
				networkPolicyDigest: operation.networkPolicyDigest,
			});
		case "download":
			return seal({ ...common, kind: "download", downloadScopeDigest: operation.downloadScopeDigest });
		case "cookie_credential":
			return seal({
				...common,
				kind: "cookie_credential",
				access: operation.access,
				scopeDigest: operation.scopeDigest,
			});
		case "screenshot":
			return seal({ ...common, kind: "screenshot", outputName: operation.outputName });
		case "dom_read":
			return seal({
				...common,
				kind: "dom_read",
				outputName: operation.outputName,
				domScopeDigest: operation.domScopeDigest,
			});
		case "console_read":
			return seal({ ...common, kind: "console_read", outputName: operation.outputName });
		case "network_evidence":
			return seal({
				...common,
				kind: "network_evidence",
				outputName: operation.outputName,
				boundsDigest: canonicalDigest({
					maxEntries: operation.maxEntries,
					maxBodyBytes: operation.maxBodyBytes,
					redactionPolicyDigest: operation.redactionPolicyDigest,
				}),
			});
		case "evidence_seal":
			return seal({ ...common, kind: "evidence_seal", outputNamesDigest: operation.outputNamesDigest });
	}
}

export class RestrictedBrowserVerificationProvider implements VerificationRunnerPort {
	readonly #workspace: WorkspaceServicePort;
	readonly #capability: CapabilityGatewayPort;
	readonly #sandbox: SandboxExecutorPort;
	readonly #artifacts: VerificationArtifactPort;
	readonly #backend: BrowserBackendPort;
	readonly #trustedEnvironment: Readonly<Record<string, string>>;
	readonly #clock: () => Date;

	public constructor(options: RestrictedBrowserVerificationProviderOptions) {
		this.#workspace = options.workspace;
		this.#capability = options.capability;
		this.#sandbox = options.sandbox;
		this.#artifacts = options.artifacts;
		this.#backend = options.backend;
		this.#trustedEnvironment = options.trustedEnvironment ?? {};
		this.#clock = options.clock ?? (() => new Date());
	}

	async #validateWorkspace(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<WorkspaceValidationReceiptRef>> {
		const envelopeDigest = workspaceExecutionEnvelopeDigest(request.candidateEnvelope);
		let result: Awaited<ReturnType<WorkspaceServicePort["request"]>>;
		try {
			result = await this.#workspace.request({
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
			}, signal);
		} catch {
			return failure("workspace_invalid", "browser candidate Workspace validation is unavailable", true);
		}
		if (
			!isWorkspaceServiceResult(result) ||
			result.kind !== "validated" ||
			result.requestId !== request.requestId ||
			result.validation.outcome !== "valid" ||
			!isWorkspaceValidationReceiptForEnvelope(result.validation, request.candidateEnvelope)
		) return failure("workspace_invalid", "browser candidate Workspace receipt is invalid or uncorrelated");
		return { ok: true, value: result.validation };
	}

	async #executeOperation(
		request: VerificationRunnerRequest,
		invocation: VerificationInvocation,
		profile: RestrictedBrowserProfile,
		workspaceReceipt: WorkspaceValidationReceiptRef,
		bindingDigest: string,
		operation: BrowserBackendOperation,
		sequence: number,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<OperationRunResult>> {
		if (!restrictedProfileAllowsOperation(profile, operation)) {
			return { ok: true, value: { status: "denied", reasonCode: `browser_profile_denied_${operation.kind}` } };
		}
		const opDigest = browserOperationDigest(operation);
		const opId = operationId(request, operation, sequence);
		const claims = operationClaims(request, operation);
		const now = this.#clock();
		const body: CapabilityGatewayRequestBody = {
			request: {
				authorityId: request.candidate.authorityId,
				tenantId: request.candidate.tenantId,
				principalId: request.candidateEnvelope.principalId,
				requestId: opId,
				approvalId: createRuntimeId("approval", `browser-${canonicalDigest({ opId, opDigest }).slice(0, 48)}`),
				sessionId: request.candidateEnvelope.sessionId,
				runtimeId: request.candidateEnvelope.ownerRuntimeId,
				runtimeGeneration: request.candidateEnvelope.leaseRevision,
				turnId: createRuntimeId("turn", `browser-${canonicalDigest({ opId, sequence }).slice(0, 48)}`),
				toolCallId: request.candidateEnvelope.toolCallId,
				capability: primaryCapability(operation),
				argumentsDigest: opDigest,
				workspaceEnvelopeDigest: workspaceExecutionEnvelopeDigest(request.candidateEnvelope),
				policyDigest: request.manifest.sandbox.policyDigest,
				serverScope: "verification_runner",
				resourceScopeDigest: canonicalDigest(claims),
				commandScopeDigest: opDigest,
			},
			invocation: {
				requestId: opId,
				toolManifestDigest: request.manifest.manifestDigest,
				rawArguments: { operation, profileDigest: profile.profileDigest, bindingDigest },
				envelope: request.candidateEnvelope,
				requestedClaims: claims,
			},
			idempotencyKey: opId,
			inputSources: [],
			targetSink: targetSink(operation),
			declassificationReceipts: [],
		};
		const capabilityRequestDigest = capabilityGatewayRequestDigest(body);
		const gatewayRequest: CapabilityGatewayRequest = {
			...body,
			authentication: {
				channel: "local_process",
				channelBindingDigest: canonicalDigest({
					principalId: request.candidateEnvelope.principalId,
					verificationId: request.verificationId,
					operationId: opId,
				}),
				requestDigest: capabilityRequestDigest,
				nonce: canonicalDigest({ operationId: opId, issuedAt: now.toISOString() }).slice(0, 32),
				issuedAt: now.toISOString(),
				expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
				keyRevision: 0,
			},
		};
		if (!isCapabilityGatewayRequest(gatewayRequest)) {
			return failure("invalid_schema", "browser capability request construction failed");
		}
		let authorization: Awaited<ReturnType<CapabilityGatewayPort["authorize"]>>;
		try {
			authorization = await this.#capability.authorize(gatewayRequest, signal);
		} catch {
			return { ok: true, value: { status: "unavailable", reasonCode: "browser_capability_gateway_unavailable" } };
		}
		if (!Check(CapabilityGatewayResultSchema, authorization) || authorization.requestId !== opId) {
			return failure("invalid_schema", "browser capability decision is invalid or uncorrelated");
		}
		if (authorization.decision === "ask") {
			return { ok: true, value: { status: "authorization_required", reasonCode: `browser_${operation.kind}_approval_required` } };
		}
		if (authorization.decision === "deny") {
			return { ok: true, value: { status: "denied", reasonCode: `browser_${operation.kind}_capability_denied` } };
		}
		if (
			authorization.sandboxProfile.authorityId !== request.candidate.authorityId ||
			authorization.sandboxProfile.tenantId !== request.candidate.tenantId ||
			authorization.sandboxProfile.requested !== request.manifest.sandbox.profile ||
			authorization.sandboxProfile.policyDigest !== request.manifest.sandbox.policyDigest
		) return failure("invalid_schema", "browser sandbox profile does not match the trusted gate");

		const sandboxInvocationDigest = operation.kind === "evidence_seal" ? invocation.invocationDigest : opDigest;
		let sandboxResult: Awaited<ReturnType<SandboxExecutorPort["execute"]>>;
		try {
			sandboxResult = await this.#sandbox.execute({
				authorityId: request.candidate.authorityId,
				tenantId: request.candidate.tenantId,
				principalId: request.candidateEnvelope.principalId,
				requestId: opId,
				profile: authorization.sandboxProfile,
				invocationDigest: sandboxInvocationDigest,
				resolutionDigest: authorization.decisionDigest,
				idempotencyKey: opId,
				opaqueInvocation: {
					contract: "runledger.browser-verification-operation.v1",
					operation,
					profileDigest: profile.profileDigest,
					bindingDigest,
					capabilityRequestDigest,
				},
			}, signal);
		} catch {
			return { ok: true, value: { status: "unavailable", reasonCode: "browser_sandbox_unavailable" } };
		}
		if (
			!Check(SandboxExecutorResultSchema, sandboxResult) ||
			sandboxResult.requestId !== opId ||
			sandboxResult.executionReceipt.requestId !== opId ||
			sandboxResult.executionReceipt.invocationDigest !== sandboxInvocationDigest ||
			sandboxResult.executionReceipt.policyDigest !== request.manifest.sandbox.policyDigest
		) return failure("sandbox_unavailable", "browser Sandbox receipt is invalid or uncorrelated");
		if (sandboxResult.executionReceipt.effectiveEnforcement !== "enforced") {
			return { ok: true, value: { status: "unavailable", reasonCode: "browser_sandbox_not_enforced" } };
		}

		const backendBody: Omit<BrowserBackendRequest, "requestDigest"> = {
			schemaVersion: 1,
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			verificationRequestId: request.requestId,
			operationId: opId,
			verificationId: request.verificationId,
			gateDigest: request.manifest.manifestDigest,
			candidateCommit: request.candidate.candidateCommit,
			candidateIdentityDigest: canonicalDigest(request.candidate),
			bindingDigest,
			profile,
			operation,
			operationDigest: opDigest,
			workspaceValidationReceiptId: workspaceReceipt.receiptId,
			workspaceValidationReceiptDigest: canonicalDigest(workspaceReceipt),
			capabilityRequestDigest,
			capabilityDecisionDigest: authorization.decisionDigest,
			sandboxReceipt: sandboxResult.executionReceipt,
			sandboxReceiptDigest: canonicalDigest(sandboxResult.executionReceipt),
		};
		const backendRequest: BrowserBackendRequest = {
			...backendBody,
			requestDigest: browserBackendRequestDigest(backendBody),
		};
		let backend: BrowserBackendResult;
		try {
			backend = await this.#backend.execute(backendRequest, signal);
		} catch {
			return { ok: true, value: { status: "unavailable", reasonCode: "browser_backend_unavailable" } };
		}
		if (!browserBackendResultMatchesRequest(backend, backendRequest)) {
			return failure("invalid_schema", "Browser backend receipt is invalid or uncorrelated");
		}
		if (backend.status === "unsupported") {
			return { ok: true, value: { status: "unavailable", reasonCode: `browser_backend_unsupported_${operation.kind}` } };
		}
		if (backend.status === "denied") {
			return { ok: true, value: { status: "denied", reasonCode: `browser_backend_denied_${operation.kind}` } };
		}
		return {
			ok: true,
			value: {
				status: "executed",
				receipt: operationReceipt(
					sequence,
					operation,
					opId,
					opDigest,
					primaryCapability(operation),
					capabilityRequestDigest,
					authorization.decisionDigest,
					sandboxResult.executionReceipt,
					backend,
					bindingDigest,
				),
				sandboxReceipt: sandboxResult.executionReceipt,
				backend,
			},
		};
	}

	public async run(
		request: VerificationRunnerRequest,
		signal?: AbortSignal,
	): Promise<VerificationCoreResult<VerificationRunnerAttempt>> {
		const invocation = createVerificationInvocation(request, this.#trustedEnvironment);
		if (!invocation.ok) return invocation;
		const prepared = createRestrictedBrowserProfile(request.manifest);
		if (!prepared.ok) return prepared;
		const workspace = await this.#validateWorkspace(request, signal);
		if (!workspace.ok) return workspace;
		const browser = request.manifest.browser;
		if (!browser) return failure("invalid_schema", "browser gate is missing after validation");
		const bindingFields = {
			gateDigest: request.manifest.manifestDigest,
			runtimeResourceId: browser.runtime.resourceId,
			runtimeIdentityDigest: browser.runtime.identityDigest,
			profileResourceId: browser.profile.resourceId,
			profileIdentityDigest: browser.profile.identityDigest,
			profilePolicyDigest: browser.profile.policyDigest,
			entryUrl: browser.entryUrl,
			origin: browser.origin,
			networkPolicyDigest: browser.networkPolicyDigest,
			candidateCommit: request.candidate.candidateCommit,
			candidateIdentityDigest: canonicalDigest(request.candidate),
		};
		const bindingDigest = browserExecutionBindingDigest(bindingFields);
		const operationReceipts: BrowserOperationReceipt[] = [];
		let evidenceSealReceipt: SandboxExecutionReceiptRef | undefined;
		for (let sequence = 0; sequence < prepared.value.operations.length; sequence += 1) {
			const operation = prepared.value.operations[sequence]!;
			const result = await this.#executeOperation(
				request,
				invocation.value,
				prepared.value.profile,
				workspace.value,
				bindingDigest,
				operation,
				sequence,
				signal,
			);
			if (!result.ok) return result;
			if (result.value.status !== "executed") {
				return attempt(invocation.value, result.value.status, result.value.reasonCode);
			}
			operationReceipts.push(result.value.receipt);
			if (operation.kind === "evidence_seal") evidenceSealReceipt = result.value.sandboxReceipt;
		}
		if (!evidenceSealReceipt) return failure("evidence_unavailable", "browser evidence seal receipt is missing");

		let resolved: Awaited<ReturnType<VerificationArtifactPort["resolveExecutionEvidence"]>>;
		try {
			resolved = await this.#artifacts.resolveExecutionEvidence({
				authorityId: request.candidate.authorityId,
				tenantId: request.candidate.tenantId,
				requestId: request.requestId,
				verificationId: request.verificationId,
				invocationDigest: invocation.value.invocationDigest,
				candidate: request.candidate,
				expectedArtifacts: request.manifest.expectedArtifacts,
				sandboxReceipt: evidenceSealReceipt,
			}, signal);
		} catch {
			return failure("evidence_unavailable", "browser Artifact evidence adapter is unavailable", true);
		}
		if (!resolved.ok) return resolved;
		if (
			resolved.value.browserExecution !== undefined ||
			canonicalDigest(resolved.value.sandboxReceipt) !== canonicalDigest(evidenceSealReceipt)
		) return failure("evidence_unavailable", "browser Artifact evidence returned an uncorrelated receipt");

		const browserBody: Omit<BrowserExecutionReceipt, "receiptDigest"> = {
			authorityId: request.candidate.authorityId,
			tenantId: request.candidate.tenantId,
			receiptId: createRuntimeId("receipt", `browser-${canonicalDigest({ requestId: request.requestId, bindingDigest }).slice(0, 48)}`),
			requestId: request.requestId,
			verificationId: request.verificationId,
			...bindingFields,
			stepSchemaDigest: browser.stepSchemaDigest,
			stepsDigest: browser.stepsDigest,
			assertionSchemaDigest: browser.assertionSchemaDigest,
			trustedAssertionsDigest: browser.trustedAssertionsDigest,
			workspaceValidationReceiptId: workspace.value.receiptId,
			workspaceValidationReceiptDigest: canonicalDigest(workspace.value),
			bindingDigest,
			operationReceipts,
			operationReceiptsDigest: browserOperationReceiptsDigest(operationReceipts),
			evidenceArtifactsDigest: browserEvidenceArtifactsDigest(resolved.value.artifacts),
			executedAt: this.#clock().toISOString(),
		};
		const browserExecution: BrowserExecutionReceipt = {
			...browserBody,
			receiptDigest: canonicalDigest(browserBody),
		};
		const evidenceBody: Omit<VerificationExecutionEvidence, "evidenceDigest"> = {
			authorityId: resolved.value.authorityId,
			tenantId: resolved.value.tenantId,
			requestId: resolved.value.requestId,
			verificationId: resolved.value.verificationId,
			invocationDigest: resolved.value.invocationDigest,
			sandboxReceipt: resolved.value.sandboxReceipt,
			exit: resolved.value.exit,
			artifacts: resolved.value.artifacts,
			browserExecution,
			startedAt: resolved.value.startedAt,
			finishedAt: resolved.value.finishedAt,
			runner: resolved.value.runner,
		};
		const evidence: VerificationExecutionEvidence = {
			...evidenceBody,
			evidenceDigest: executionEvidenceDigest(evidenceBody),
		};
		const validated = validateExecutionEvidence(evidence, invocation.value);
		if (!validated.ok) return validated;
		return {
			ok: true,
			value: { invocation: invocation.value, evidence, status: "executed", reasonCodes: [] },
		};
	}
}
