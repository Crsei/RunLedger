import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	type ApprovalTicket,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type SandboxExecutorPort,
	type SandboxExecutorRequest,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { WorkspaceServicePort, WorkspaceServiceRequest, WorkspaceServiceResult } from "../../../src/runtime/protocol/v3/workspace.ts";
import type {
	VerificationArtifactEvidenceRequest,
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationExecutionEvidence,
} from "../../../src/runtime/verification/types.ts";
import { PortBackedVerificationRunner } from "../../../src/verification-runner/runner.ts";
import {
	PRINCIPAL_ID,
	REQUEST_ID,
	RUNNER_ID,
	VERIFICATION_ID,
	artifactReceipt,
	baselineReceipt,
	candidate,
	candidateEnvelope,
	digest,
	executionEvidence,
	gateManifest,
} from "./helpers.ts";

function cancelResult(request: SecurityPortCancelRequest): SecurityPortCancelResult {
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		requestId: request.requestId,
		status: "not_found",
	};
}

class FakeWorkspace implements WorkspaceServicePort {
	readonly requests: WorkspaceServiceRequest[] = [];
	valid = true;

	public async request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		this.requests.push(request);
		if (request.kind !== "validate") {
			return { schemaVersion: 1, requestId: request.requestId, kind: "rejected", code: "unexpected", messageDigest: digest("unexpected"), retryable: false };
		}
		return {
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "validated",
			validation: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", "candidate-validation"),
				workspaceId: request.envelope.workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId: RUNNER_ID,
				validatedAt: "2026-07-22T08:00:00.000Z",
				outcome: this.valid ? "valid" : "invalid",
			},
		};
	}
}

class FakeCapability implements CapabilityGatewayPort {
	readonly requests: CapabilityGatewayRequest[] = [];
	mode: "allow" | "ask" | "deny" = "allow";
	forgeTicketCorrelation = false;
	forgeDenialCorrelation = false;

	public async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		this.requests.push(request);
		if (this.mode === "allow") {
			return {
				requestId: request.request.requestId,
				decision: "allow",
				decisionDigest: digest("allow"),
				sandboxProfile: {
					authorityId: request.request.authorityId,
					tenantId: request.request.tenantId,
					profileId: createRuntimeId("resource", "verification-sandbox"),
					requested: "strict",
					policyDigest: request.request.policyDigest,
				},
			};
		}
		if (this.mode === "ask") {
			const ticketRequest = this.forgeTicketCorrelation
				? { ...request.request, turnId: createRuntimeId("turn", "forged-verification") }
				: request.request;
			return {
				requestId: request.request.requestId,
				decision: "ask",
				decisionDigest: digest("ask"),
				approvalTicket: {
					authorityId: request.request.authorityId,
					tenantId: request.request.tenantId,
					principalId: request.request.principalId,
					approvalId: request.request.approvalId,
					request: ticketRequest,
					scope: "once",
					createdAt: "2026-07-22T08:00:00.000Z",
				},
			};
		}
		const ticket: ApprovalTicket = {
			authorityId: request.request.authorityId,
			tenantId: request.request.tenantId,
			principalId: request.request.principalId,
			approvalId: request.request.approvalId,
			request: request.request,
			scope: "once",
			createdAt: "2026-07-22T08:00:00.000Z",
		};
		const deniedReceiptBody = {
			authorityId: request.request.authorityId,
			tenantId: request.request.tenantId,
			principalId: request.request.principalId,
			receiptId: createRuntimeId("receipt", "verification-denied"),
			approvalId: request.request.approvalId,
			requestId: request.request.requestId,
			requestDigest: approvalTicketRequestDigest(ticket),
			ticketDigest: approvalTicketDigest(ticket),
			decision: "denied" as const,
			decisionRevision: 1,
			decidedBy: request.request.principalId,
			decidedAt: "2026-07-22T08:00:00.000Z",
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: request.request.argumentsDigest,
		};
		const denialBody = this.forgeDenialCorrelation
			? { ...deniedReceiptBody, originalInputDigest: digest("forged-input") }
			: deniedReceiptBody;
		return {
			requestId: request.request.requestId,
			decision: "deny",
			decisionDigest: digest("deny"),
			approvalReceipt: { ...denialBody, receiptDigest: canonicalDigest(denialBody) },
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class FakeSandbox implements SandboxExecutorPort {
	readonly requests: SandboxExecutorRequest[] = [];
	enforcement: "enforced" | "degraded" = "enforced";

	public async execute(request: SandboxExecutorRequest) {
		this.requests.push(request);
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId("receipt", "sandbox-resolution"),
			executionReceipt: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", "sandbox-execution"),
				requestId: request.requestId,
				profileId: request.profile.profileId,
				requested: request.profile.requested,
				resolved: request.profile.requested,
				policyDigest: request.profile.policyDigest,
				backendId: "fake-sandbox",
				effectiveEnforcement: this.enforcement,
				invocationDigest: request.invocationDigest,
				...(this.enforcement === "degraded" ? { reasonDigest: digest("degraded") } : {}),
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class FakeArtifacts implements VerificationArtifactPort {
	readonly requests: VerificationArtifactEvidenceRequest[] = [];
	forgeSandboxReceipt = false;

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		this.requests.push(request);
		const sandboxReceipt = this.forgeSandboxReceipt
			? { ...request.sandboxReceipt, receiptId: createRuntimeId("receipt", "forged-sandbox") }
			: request.sandboxReceipt;
		return {
			ok: true,
			value: executionEvidence({
				invocationDigest: request.invocationDigest,
				requestId: request.requestId,
				verificationId: request.verificationId,
				sandboxReceipt,
				artifacts: [artifactReceipt({
					requestId: request.requestId,
					verificationId: request.verificationId,
					candidateCommit: request.candidate.candidateCommit,
				})],
			}),
		};
	}
}

function harness() {
	const workspace = new FakeWorkspace();
	const capability = new FakeCapability();
	const sandbox = new FakeSandbox();
	const artifacts = new FakeArtifacts();
	const runner = new PortBackedVerificationRunner({
		workspace,
		capability,
		sandbox,
		artifacts,
		trustedEnvironment: {
			PATH: "/trusted/runner/bin",
			EVIL: "candidate-value",
			npm_lifecycle_script: "node candidate-script.js",
		},
	});
	return { workspace, capability, sandbox, artifacts, runner };
}

function request() {
	return {
		manifest: gateManifest(),
		baseline: baselineReceipt(),
		candidate: candidate(),
		candidateEnvelope: candidateEnvelope(),
		verificationId: VERIFICATION_ID,
		requestId: REQUEST_ID,
	};
}

describe("port-backed verification runner", () => {
	it("uses only typed trusted gate argv/env and injected Workspace, Capability, Sandbox, Artifact ports", async () => {
		const ports = harness();
		const result = await ports.runner.run(request());
		expect(result.ok && result.value.status).toBe("executed");
		expect(ports.workspace.requests[0]).toMatchObject({ kind: "validate" });
		expect(ports.capability.requests[0]?.invocation.rawArguments).toMatchObject({
			executable: { source: "trusted_baseline", path: "ci/trusted-gates/run-tests" },
			environment: [
				{ name: "CI", value: "1" },
				{ name: "PATH", value: "/trusted/runner/bin" },
			],
			dependencyPolicy: { lifecycleScripts: "deny", lockfileSource: "trusted_baseline" },
		});
		const serializedInvocation = JSON.stringify(ports.capability.requests[0]?.invocation.rawArguments);
		expect(serializedInvocation).not.toContain("candidate-value");
		expect(serializedInvocation).not.toContain("candidate-script.js");
		expect(ports.capability.requests[0]?.invocation.requestedClaims.map((entry) => entry.name)).toEqual([
			"repository_read",
			"process",
			"dependency_install",
		]);
		expect(ports.sandbox.requests).toHaveLength(1);
		expect(ports.artifacts.requests).toHaveLength(1);
	});

	it.each(["ask", "deny"] as const)("stops before sandbox execution on capability %s", async (mode) => {
		const ports = harness();
		ports.capability.mode = mode;
		const result = await ports.runner.run(request());
		expect(result.ok && result.value.status).toBe(mode === "ask" ? "authorization_required" : "denied");
		expect(ports.sandbox.requests).toHaveLength(0);
		expect(ports.artifacts.requests).toHaveLength(0);
	});

	it.each(["ask", "deny"] as const)("rejects a structurally valid but cross-correlated capability %s response", async (mode) => {
		const ports = harness();
		ports.capability.mode = mode;
		if (mode === "ask") ports.capability.forgeTicketCorrelation = true;
		else ports.capability.forgeDenialCorrelation = true;
		const result = await ports.runner.run(request());
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
		expect(ports.sandbox.requests).toHaveLength(0);
		expect(ports.artifacts.requests).toHaveLength(0);
	});

	it("fails closed before authorization when Workspace validation is invalid", async () => {
		const ports = harness();
		ports.workspace.valid = false;
		const result = await ports.runner.run(request());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("workspace_invalid");
		expect(ports.capability.requests).toHaveLength(0);
	});

	it("rejects candidate-added manifest fields before any port call", async () => {
		const ports = harness();
		const normal = request();
		const forged = {
			...normal,
			manifest: { ...normal.manifest, packageScript: "npm test", policyOverride: "allow-all" },
		};
		const result = await ports.runner.run(forged);
		expect(result.ok).toBe(false);
		expect(ports.workspace.requests).toHaveLength(0);
		expect(ports.capability.requests).toHaveLength(0);
	});

	it("rejects Artifact evidence that substitutes another sandbox receipt", async () => {
		const ports = harness();
		ports.artifacts.forgeSandboxReceipt = true;
		const result = await ports.runner.run(request());
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("evidence_unavailable");
	});

	it("preserves degraded sandbox enforcement for deterministic inconclusive classification", async () => {
		const ports = harness();
		ports.sandbox.enforcement = "degraded";
		const result = await ports.runner.run(request());
		expect(result.ok && result.value.evidence?.sandboxReceipt.effectiveEnforcement).toBe("degraded");
	});
});
