import { describe, expect, it } from "vitest";
import {
	isCapabilityGatewayRequest,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type SandboxExecutorPort,
	type SandboxExecutorRequest,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type {
	WorkspaceServicePort,
	WorkspaceServiceRequest,
	WorkspaceServiceResult,
} from "../../src/runtime/protocol/v3/workspace.ts";
import { isBrowserExecutionReceipt } from "../../src/runtime/verification/evidence.ts";
import type {
	GateManifest,
	GateManifestBody,
	VerificationArtifactEvidenceRequest,
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationExecutionEvidence,
} from "../../src/runtime/verification/types.ts";
import {
	isBrowserBackendRequest,
	type BrowserBackendPort,
	type BrowserBackendRequest,
	type BrowserBackendResult,
} from "../../src/verification-runner/browser/evidence.ts";
import { PortBackedVerificationRunner } from "../../src/verification-runner/runner.ts";
import {
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
	policy,
} from "../runtime-v3/verification/helpers.ts";

const NETWORK: GateManifestBody["network"] = {
	mode: "allowlist",
	hosts: ["app.example.test"],
};

function browserManifest(): GateManifest {
	return gateManifest({
		kind: "browser",
		network: NETWORK,
		browser: {
			runtime: {
				resourceId: createRuntimeId("resource", "e2e-browser-runtime"),
				version: "chromium-128.0.0",
				identityDigest: digest("e2e-browser-runtime"),
			},
			profile: {
				resourceId: createRuntimeId("resource", "e2e-browser-profile"),
				identityDigest: digest("e2e-browser-profile"),
				policyDigest: digest("e2e-browser-profile-policy"),
			},
			entryUrl: "https://app.example.test/verification",
			origin: "https://app.example.test",
			stepSchemaDigest: digest("e2e-browser-step-schema"),
			stepsDigest: digest("e2e-browser-steps"),
			assertionSchemaDigest: digest("e2e-browser-assertion-schema"),
			trustedAssertionsDigest: digest("e2e-browser-assertions"),
			networkPolicyDigest: canonicalDigest(NETWORK),
			networkEvidence: {
				maxEntries: 1_000,
				maxBodyBytes: 64 * 1024,
				redactionPolicyDigest: digest("e2e-browser-network-redaction"),
			},
		},
		expectedArtifacts: [
			{ name: "screenshot", kind: "screenshot", mediaType: "image/png", schemaDigest: digest("e2e-screenshot-schema"), required: true, maxBytes: 5_000_000 },
			{ name: "dom", kind: "dom_snapshot", mediaType: "application/json", schemaDigest: digest("e2e-dom-schema"), required: true, maxBytes: 2_000_000 },
			{ name: "console", kind: "console_log", mediaType: "application/json", schemaDigest: digest("e2e-console-schema"), required: true, maxBytes: 1_000_000 },
			{ name: "network", kind: "network_trace", mediaType: "application/json", schemaDigest: digest("e2e-network-schema"), required: true, maxBytes: 2_000_000 },
		],
	});
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

class FederatedWorkspace implements WorkspaceServicePort {
	public readonly requests: WorkspaceServiceRequest[] = [];

	public async request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		this.requests.push(request);
		if (request.kind !== "validate") {
			return {
				schemaVersion: 1,
				requestId: request.requestId,
				kind: "rejected",
				code: "unexpected",
				messageDigest: digest("unexpected Browser workspace operation"),
				retryable: false,
			};
		}
		return {
			schemaVersion: 1,
			requestId: request.requestId,
			kind: "validated",
			validation: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", "e2e-browser-workspace-validation"),
				workspaceId: request.envelope.workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId: RUNNER_ID,
				validatedAt: "2026-07-22T08:00:00.000Z",
				outcome: "valid",
			},
		};
	}
}

class FederatedCapabilityGateway implements CapabilityGatewayPort {
	public readonly requests: CapabilityGatewayRequest[] = [];

	public async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		if (!isCapabilityGatewayRequest(request)) throw new Error("invalid Browser capability request");
		this.requests.push(request);
		return {
			requestId: request.request.requestId,
			decision: "allow",
			decisionDigest: digest(`e2e-browser-allow-${this.requests.length}`),
			sandboxProfile: {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				profileId: createRuntimeId("resource", "e2e-browser-sandbox"),
				requested: "strict",
				policyDigest: request.request.policyDigest,
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class FederatedSandbox implements SandboxExecutorPort {
	public readonly requests: SandboxExecutorRequest[] = [];

	public async execute(request: SandboxExecutorRequest) {
		this.requests.push(request);
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId("receipt", `e2e-browser-resolution-${this.requests.length}`),
			executionReceipt: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", `e2e-browser-sandbox-${this.requests.length}`),
				requestId: request.requestId,
				profileId: request.profile.profileId,
				requested: request.profile.requested,
				resolved: request.profile.requested,
				policyDigest: request.profile.policyDigest,
				backendId: "e2e-browser-sandbox",
				effectiveEnforcement: "enforced" as const,
				invocationDigest: request.invocationDigest,
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class FederatedBrowserBackend implements BrowserBackendPort {
	public readonly requests: BrowserBackendRequest[] = [];

	public async execute(request: BrowserBackendRequest): Promise<BrowserBackendResult> {
		if (!isBrowserBackendRequest(request)) throw new Error("invalid Browser backend request");
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
			backendId: "e2e-browser-backend",
			backendIdentityDigest: digest("e2e-browser-backend"),
			receiptId: createRuntimeId("receipt", `e2e-browser-backend-${this.requests.length}`),
			completedAt: "2026-07-22T08:00:01.000Z",
		};
		const output = (() => {
			switch (request.operation.kind) {
				case "screenshot":
					return { outputName: request.operation.outputName, kind: "screenshot" as const, mediaType: "image/png", contentHandleDigest: digest("e2e-screenshot"), originalBytes: 256 };
				case "dom_read":
					return { outputName: request.operation.outputName, kind: "dom_snapshot" as const, mediaType: "application/json", contentHandleDigest: digest("e2e-dom"), originalBytes: 256 };
				case "console_read":
					return { outputName: request.operation.outputName, kind: "console_log" as const, mediaType: "application/json", contentHandleDigest: digest("e2e-console"), originalBytes: 256 };
				case "network_evidence":
					return { outputName: request.operation.outputName, kind: "network_trace" as const, mediaType: "application/json", contentHandleDigest: digest("e2e-network"), originalBytes: 256 };
				default:
					return undefined;
			}
		})();
		const body = { ...common, status: "completed" as const, ...(output ? { output } : {}) };
		return { ...body, receiptDigest: canonicalDigest(body) };
	}
}

class FederatedArtifacts implements VerificationArtifactPort {
	public readonly requests: VerificationArtifactEvidenceRequest[] = [];

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		this.requests.push(request);
		const artifacts = request.expectedArtifacts.map((expected) => artifactReceipt({
			requestId: request.requestId,
			verificationId: request.verificationId,
			candidateCommit: request.candidate.candidateCommit,
			outputName: expected.name,
			kind: expected.kind,
			mediaType: expected.mediaType,
			schemaDigest: expected.schemaDigest,
			artifactSeed: `e2e-${expected.name}`,
		}));
		return {
			ok: true,
			value: executionEvidence({
				invocationDigest: request.invocationDigest,
				requestId: request.requestId,
				verificationId: request.verificationId,
				sandboxReceipt: request.sandboxReceipt,
				artifacts,
			}),
		};
	}
}

describe("Browser verification federation E2E", () => {
	it("binds all Browser operations across Workspace, Gateway, Sandbox, backend, and Artifact evidence", async () => {
		const manifest = browserManifest();
		const workspace = new FederatedWorkspace();
		const capability = new FederatedCapabilityGateway();
		const sandbox = new FederatedSandbox();
		const backend = new FederatedBrowserBackend();
		const artifacts = new FederatedArtifacts();
		const runner = new PortBackedVerificationRunner({
			workspace,
			capability,
			sandbox,
			browserBackend: backend,
			artifacts,
			trustedEnvironment: { PATH: "/trusted/browser/bin" },
			clock: () => new Date("2026-07-22T08:00:02.000Z"),
		});

		const result = await runner.run({
			manifest,
			baseline: baselineReceipt(policy(manifest)),
			candidate: candidate(),
			candidateEnvelope: candidateEnvelope(),
			verificationId: VERIFICATION_ID,
			requestId: REQUEST_ID,
		});

		expect(result.ok && result.value.status).toBe("executed");
		if (!result.ok || !result.value.evidence?.browserExecution) return;
		expect(isBrowserExecutionReceipt(result.value.evidence.browserExecution)).toBe(true);
		expect(workspace.requests).toHaveLength(1);
		expect(capability.requests).toHaveLength(8);
		expect(sandbox.requests).toHaveLength(8);
		expect(backend.requests).toHaveLength(8);
		expect(artifacts.requests).toHaveLength(1);
		expect(backend.requests.map((request) => request.operation.kind)).toEqual([
			"launch",
			"network",
			"navigate",
			"screenshot",
			"dom_read",
			"console_read",
			"network_evidence",
			"evidence_seal",
		]);
		for (const [index, request] of backend.requests.entries()) {
			expect(request.capabilityRequestDigest).toBe(capability.requests[index]?.authentication.requestDigest);
			expect(request.sandboxReceipt.requestId).toBe(request.operationId);
			expect(result.value.evidence.browserExecution.operationReceipts[index]).toMatchObject({
				operationId: request.operationId,
				operationDigest: request.operationDigest,
				capabilityDecisionDigest: request.capabilityDecisionDigest,
				sandboxReceiptId: request.sandboxReceipt.receiptId,
				bindingDigest: request.bindingDigest,
			});
		}
		expect(result.value.evidence.artifacts.map((entry) => entry.artifact.kind).sort()).toEqual([
			"console_log",
			"dom_snapshot",
			"network_trace",
			"screenshot",
		]);
	});
});
