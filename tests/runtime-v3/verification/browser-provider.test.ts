import { describe, expect, it } from "vitest";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	isCapabilityGatewayRequest,
	type ApprovalTicket,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type SandboxExecutorPort,
	type SandboxExecutorRequest,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	WorkspaceServicePort,
	WorkspaceServiceRequest,
	WorkspaceServiceResult,
} from "../../../src/runtime/protocol/v3/workspace.ts";
import type {
	GateManifest,
	GateManifestBody,
	VerificationArtifactEvidenceRequest,
	VerificationArtifactPort,
	VerificationCoreResult,
	VerificationExecutionEvidence,
} from "../../../src/runtime/verification/types.ts";
import {
	browserBackendResultMatchesRequest,
	isBrowserBackendRequest,
	type BrowserBackendPort,
	type BrowserBackendRequest,
	type BrowserBackendResult,
} from "../../../src/verification-runner/browser/evidence.ts";
import {
	createRestrictedBrowserProfile,
	restrictedProfileAllowsOperation,
} from "../../../src/verification-runner/browser/profile.ts";
import { PortBackedVerificationRunner } from "../../../src/verification-runner/runner.ts";
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
} from "./helpers.ts";

const NETWORK: GateManifestBody["network"] = { mode: "allowlist", hosts: ["app.example.test"] };

function browserManifest(): GateManifest {
	return gateManifest({
		kind: "browser",
		network: NETWORK,
		browser: {
			runtime: {
				resourceId: createRuntimeId("resource", "browser-runtime"),
				version: "chromium-128.0.0",
				identityDigest: digest("browser-runtime"),
			},
			profile: {
				resourceId: createRuntimeId("resource", "browser-profile"),
				identityDigest: digest("browser-profile"),
				policyDigest: digest("browser-profile-policy"),
			},
			entryUrl: "https://app.example.test/verification",
			origin: "https://app.example.test",
			stepSchemaDigest: digest("browser-step-schema"),
			stepsDigest: digest("browser-steps"),
			assertionSchemaDigest: digest("browser-assertion-schema"),
			trustedAssertionsDigest: digest("browser-assertions"),
			networkPolicyDigest: canonicalDigest(NETWORK),
			networkEvidence: {
				maxEntries: 1_000,
				maxBodyBytes: 64 * 1024,
				redactionPolicyDigest: digest("browser-network-redaction"),
			},
		},
		expectedArtifacts: [
			{ name: "screenshot", kind: "screenshot", mediaType: "image/png", schemaDigest: digest("screenshot-schema"), required: true, maxBytes: 5_000_000 },
			{ name: "dom", kind: "dom_snapshot", mediaType: "application/json", schemaDigest: digest("dom-schema"), required: true, maxBytes: 2_000_000 },
			{ name: "console", kind: "console_log", mediaType: "application/json", schemaDigest: digest("console-schema"), required: true, maxBytes: 1_000_000 },
			{ name: "network", kind: "network_trace", mediaType: "application/json", schemaDigest: digest("network-schema"), required: true, maxBytes: 2_000_000 },
		],
	});
}

function browserRequest() {
	const manifest = browserManifest();
	return {
		manifest,
		baseline: baselineReceipt(policy(manifest)),
		candidate: candidate(),
		candidateEnvelope: candidateEnvelope(),
		verificationId: VERIFICATION_ID,
		requestId: REQUEST_ID,
	};
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

class BrowserWorkspace implements WorkspaceServicePort {
	public readonly requests: WorkspaceServiceRequest[] = [];

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
				receiptId: createRuntimeId("receipt", "browser-workspace-validation"),
				workspaceId: request.envelope.workspaceId,
				envelopeDigest: request.envelopeDigest,
				validatorId: RUNNER_ID,
				validatedAt: "2026-07-22T08:00:00.000Z",
				outcome: "valid",
			},
		};
	}
}

class BrowserCapability implements CapabilityGatewayPort {
	public readonly requests: CapabilityGatewayRequest[] = [];
	public denyKind?: string;

	public async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		if (!isCapabilityGatewayRequest(request)) throw new Error("invalid test capability request");
		this.requests.push(request);
		const raw = request.invocation.rawArguments as { operation?: { kind?: string } };
		if (raw.operation?.kind === this.denyKind) {
			const ticket: ApprovalTicket = {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				principalId: request.request.principalId,
				approvalId: request.request.approvalId,
				request: request.request,
				scope: "once",
				createdAt: "2026-07-22T08:00:00.000Z",
			};
			const receiptBody = {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				principalId: request.request.principalId,
				receiptId: createRuntimeId("receipt", `deny-${this.requests.length}`),
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
			return {
				requestId: request.request.requestId,
				decision: "deny",
				decisionDigest: digest(`deny-decision-${this.requests.length}`),
				approvalReceipt: { ...receiptBody, receiptDigest: canonicalDigest(receiptBody) },
			};
		}
		return {
			requestId: request.request.requestId,
			decision: "allow",
			decisionDigest: digest(`allow-${this.requests.length}`),
			sandboxProfile: {
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				profileId: createRuntimeId("resource", "browser-sandbox"),
				requested: "strict",
				policyDigest: request.request.policyDigest,
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class BrowserSandbox implements SandboxExecutorPort {
	public readonly requests: SandboxExecutorRequest[] = [];
	public enforcement: "enforced" | "unavailable" = "enforced";

	public async execute(request: SandboxExecutorRequest) {
		this.requests.push(request);
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId("receipt", `resolution-${this.requests.length}`),
			executionReceipt: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				receiptId: createRuntimeId("receipt", `sandbox-${this.requests.length}`),
				requestId: request.requestId,
				profileId: request.profile.profileId,
				requested: request.profile.requested,
				resolved: request.profile.requested,
				policyDigest: request.profile.policyDigest,
				backendId: "federated-browser-sandbox",
				effectiveEnforcement: this.enforcement,
				invocationDigest: request.invocationDigest,
				...(this.enforcement === "unavailable" ? { reasonDigest: digest("sandbox-unavailable") } : {}),
			},
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class BrowserBackend implements BrowserBackendPort {
	public readonly requests: BrowserBackendRequest[] = [];
	public unsupportedKind?: string;
	public forgeBinding = false;

	public async execute(request: BrowserBackendRequest): Promise<BrowserBackendResult> {
		if (!isBrowserBackendRequest(request)) throw new Error("invalid browser backend request");
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
			bindingDigest: this.forgeBinding ? digest("forged-binding") : request.bindingDigest,
			capabilityDecisionDigest: request.capabilityDecisionDigest,
			sandboxReceiptId: request.sandboxReceipt.receiptId,
			sandboxReceiptDigest: request.sandboxReceiptDigest,
			backendId: "federated-browser-backend",
			backendIdentityDigest: digest("federated-browser-backend"),
			receiptId: createRuntimeId("receipt", `browser-backend-${this.requests.length}`),
			completedAt: "2026-07-22T08:00:01.000Z",
		};
		if (request.operation.kind === this.unsupportedKind) {
			const body = { ...common, status: "unsupported" as const, reasonCode: "operation_unsupported", reasonDigest: digest("operation-unsupported") };
			return { ...body, receiptDigest: canonicalDigest(body) };
		}
		const output = (() => {
			switch (request.operation.kind) {
				case "screenshot":
					return { outputName: request.operation.outputName, kind: "screenshot" as const, mediaType: "image/png", contentHandleDigest: digest("screenshot-handle"), originalBytes: 128 };
				case "dom_read":
					return { outputName: request.operation.outputName, kind: "dom_snapshot" as const, mediaType: "application/json", contentHandleDigest: digest("dom-handle"), originalBytes: 128 };
				case "console_read":
					return { outputName: request.operation.outputName, kind: "console_log" as const, mediaType: "application/json", contentHandleDigest: digest("console-handle"), originalBytes: 128 };
				case "network_evidence":
					return { outputName: request.operation.outputName, kind: "network_trace" as const, mediaType: "application/json", contentHandleDigest: digest("network-handle"), originalBytes: 128 };
				default:
					return undefined;
			}
		})();
		const body = { ...common, status: "completed" as const, ...(output ? { output } : {}) };
		return { ...body, receiptDigest: canonicalDigest(body) };
	}
}

class BrowserArtifacts implements VerificationArtifactPort {
	public readonly requests: VerificationArtifactEvidenceRequest[] = [];

	public async resolveExecutionEvidence(
		request: VerificationArtifactEvidenceRequest,
	): Promise<VerificationCoreResult<VerificationExecutionEvidence>> {
		this.requests.push(request);
		const artifacts = request.expectedArtifacts.map((entry) => artifactReceipt({
			requestId: request.requestId,
			verificationId: request.verificationId,
			candidateCommit: request.candidate.candidateCommit,
			outputName: entry.name,
			kind: entry.kind,
			mediaType: entry.mediaType,
			schemaDigest: entry.schemaDigest,
			artifactSeed: `provider-${entry.name}`,
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

function harness(withBackend = true) {
	const workspace = new BrowserWorkspace();
	const capability = new BrowserCapability();
	const sandbox = new BrowserSandbox();
	const artifacts = new BrowserArtifacts();
	const backend = new BrowserBackend();
	const runner = new PortBackedVerificationRunner({
		workspace,
		capability,
		sandbox,
		artifacts,
		eventCursorAuthority: {
			current: async () => {
				const envelope = candidateEnvelope();
				return {
					stream: createSessionEventStreamRef(envelope, envelope.sessionId),
					sequence: 12,
					eventId: createRuntimeId("event", "browser-verification-head"),
					eventHash: digest("browser-verification-head"),
				};
			},
		},
		...(withBackend ? { browserBackend: backend } : {}),
		trustedEnvironment: { PATH: "/trusted/browser/bin" },
		clock: () => new Date("2026-07-22T08:00:00.000Z"),
	});
	return { workspace, capability, sandbox, artifacts, backend, runner };
}

describe("restricted Browser verification provider", () => {
	it("returns explicit unsupported without probing Workspace, Gateway, Sandbox, Artifact, or host execution", async () => {
		const ports = harness(false);
		const result = await ports.runner.run(browserRequest());
		expect(result).toMatchObject({ ok: true, value: { status: "unavailable", reasonCodes: ["browser_backend_unsupported"] } });
		expect(ports.workspace.requests).toHaveLength(0);
		expect(ports.capability.requests).toHaveLength(0);
		expect(ports.sandbox.requests).toHaveLength(0);
		expect(ports.artifacts.requests).toHaveLength(0);
		expect(ports.backend.requests).toHaveLength(0);
	});

	it("federates every operation through correlated Gateway, Sandbox, backend, and Artifact receipts", async () => {
		const ports = harness();
		const result = await ports.runner.run(browserRequest());
		expect(result.ok && result.value.status).toBe("executed");
		if (!result.ok || result.value.status !== "executed" || !result.value.evidence?.browserExecution) return;
		expect(ports.workspace.requests).toHaveLength(1);
		expect(ports.capability.requests).toHaveLength(8);
		expect(ports.sandbox.requests).toHaveLength(8);
		expect(ports.backend.requests).toHaveLength(8);
		expect(ports.artifacts.requests).toHaveLength(1);
		expect(ports.backend.requests.every((entry) => isBrowserBackendRequest(entry))).toBe(true);
		expect(result.value.evidence.browserExecution.operationReceipts.map((entry) => entry.kind)).toEqual([
			"launch",
			"network",
			"navigate",
			"screenshot",
			"dom_read",
			"console_read",
			"network_evidence",
			"evidence_seal",
		]);
		for (const [index, backendRequest] of ports.backend.requests.entries()) {
			expect(backendRequest.capabilityRequestDigest).toBe(ports.capability.requests[index]?.authentication.requestDigest);
			expect(backendRequest.sandboxReceipt.requestId).toBe(backendRequest.operationId);
			expect(result.value.evidence.browserExecution.operationReceipts[index]).toMatchObject({
				operationId: backendRequest.operationId,
				capabilityRequestDigest: backendRequest.capabilityRequestDigest,
				capabilityDecisionDigest: backendRequest.capabilityDecisionDigest,
				sandboxReceiptId: backendRequest.sandboxReceipt.receiptId,
				bindingDigest: result.value.evidence.browserExecution.bindingDigest,
			});
		}
		expect(result.value.evidence.artifacts.map((entry) => entry.artifact.kind).sort()).toEqual([
			"console_log",
			"dom_snapshot",
			"network_trace",
			"screenshot",
		]);
	});

	it("stops before backend execution when a precise navigate capability is denied", async () => {
		const ports = harness();
		ports.capability.denyKind = "navigate";
		const result = await ports.runner.run(browserRequest());
		expect(result).toMatchObject({ ok: true, value: { status: "denied", reasonCodes: ["browser_navigate_capability_denied"] } });
		expect(ports.backend.requests.map((entry) => entry.operation.kind)).toEqual(["launch", "network"]);
		expect(ports.artifacts.requests).toHaveLength(0);
	});

	it("does not call the backend when the Sandbox cannot enforce the Browser profile", async () => {
		const ports = harness();
		ports.sandbox.enforcement = "unavailable";
		const result = await ports.runner.run(browserRequest());
		expect(result).toMatchObject({ ok: true, value: { status: "unavailable", reasonCodes: ["browser_sandbox_not_enforced"] } });
		expect(ports.backend.requests).toHaveLength(0);
		expect(ports.artifacts.requests).toHaveLength(0);
	});

	it("rejects a recomputed backend receipt bound to another gate/profile/candidate tuple", async () => {
		const ports = harness();
		ports.backend.forgeBinding = true;
		const result = await ports.runner.run(browserRequest());
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
		expect(ports.artifacts.requests).toHaveLength(0);
	});

	it("keeps download, cookie, credential, upload, and script outside the fixed profile", () => {
		const prepared = createRestrictedBrowserProfile(browserManifest());
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.profile).toMatchObject({
			download: "deny",
			cookie: "deny",
			credential: "deny",
			upload: "deny",
			script: "deny",
		});
		expect(restrictedProfileAllowsOperation(prepared.value.profile, {
			kind: "download",
			url: "https://app.example.test/export",
			downloadScopeDigest: digest("download-scope"),
		})).toBe(false);
		expect(restrictedProfileAllowsOperation(prepared.value.profile, {
			kind: "cookie_credential",
			access: "credential",
			scopeDigest: digest("credential-scope"),
		})).toBe(false);
	});

	it("backend result matching rejects receipt correlation drift", async () => {
		const ports = harness();
		const result = await ports.runner.run(browserRequest());
		expect(result.ok && result.value.status).toBe("executed");
		const request = ports.backend.requests[0];
		if (!request) throw new Error("backend was not called");
		const valid = await new BrowserBackend().execute(request);
		expect(browserBackendResultMatchesRequest(valid, request)).toBe(true);
		expect(browserBackendResultMatchesRequest({ ...valid, requestDigest: digest("drift") }, request)).toBe(false);
	});
});
