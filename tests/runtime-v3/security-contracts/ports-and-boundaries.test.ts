import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	ApprovalCoordinatorResultSchema,
	CapabilityGatewayResultSchema,
	SandboxExecutorResultSchema,
	SecurityPortCancelResultSchema,
	approvalTicketDigest,
	approvalTicketRequestDigest,
	capabilityGatewayRequestDigest,
	type ApprovalCoordinatorPort,
	type ApprovalCoordinatorRequest,
	type ApprovalCoordinatorResult,
	type ApprovalReceiptRef,
	type ApprovalTicket,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayRequestBody,
	type CapabilityGatewayResult,
	type SandboxExecutionReceiptRef,
	type SandboxExecutorPort,
	type SandboxExecutorRequest,
	type SandboxExecutorResult,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const AUTHORITY_ID = createRuntimeId("authority", "security-port");
const TENANT_ID = createRuntimeId("tenant", "security-port");
const PRINCIPAL_ID = createRuntimeId("principal", "security-port");
const REQUEST_ID = createRuntimeId("command", "security-port");
const APPROVAL_ID = createRuntimeId("approval", "security-port");
const PROFILE_ID = createRuntimeId("resource", "security-port-profile");
const SESSION_ID = createRuntimeId("session", "security-port");
const RUNTIME_ID = createRuntimeId("runtime", "security-port");
const TURN_ID = createRuntimeId("turn", "security-port");
const TOOL_CALL_ID = createRuntimeId("toolCall", "security-port");

function approvalTicket(): ApprovalTicket {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		approvalId: APPROVAL_ID,
		request: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			requestId: REQUEST_ID,
			approvalId: APPROVAL_ID,
			sessionId: SESSION_ID,
			runtimeId: RUNTIME_ID,
			runtimeGeneration: 1,
			turnId: TURN_ID,
			toolCallId: TOOL_CALL_ID,
			capability: "workspace_write",
			argumentsDigest: DIGEST_A,
			workspaceEnvelopeDigest: DIGEST_B,
			policyDigest: DIGEST_C,
			serverScope: "tool_server",
			resourceScopeDigest: DIGEST_A,
			commandScopeDigest: DIGEST_B,
		},
		scope: "once",
		createdAt: "2026-07-22T00:00:00.000Z",
	};
}

function approvalReceipt(ticket: ApprovalTicket): ApprovalReceiptRef {
	return {
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		receiptId: createRuntimeId("receipt", "security-port-approval"),
		approvalId: APPROVAL_ID,
		requestId: REQUEST_ID,
		requestDigest: approvalTicketRequestDigest(ticket),
		ticketDigest: approvalTicketDigest(ticket),
		decision: "allowed",
		decisionRevision: 1,
		decidedAt: "2026-07-22T00:01:00.000Z",
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: ticket.request.argumentsDigest,
		receiptDigest: DIGEST_A,
	};
}

function cancelResult(request: SecurityPortCancelRequest): SecurityPortCancelResult {
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		requestId: request.requestId,
		status: "accepted",
		receiptId: createRuntimeId("receipt", "security-port-cancel"),
	};
}

class FakeCapabilityGateway implements CapabilityGatewayPort {
	public readonly requests: CapabilityGatewayRequest[] = [];
	public readonly cancellations: SecurityPortCancelRequest[] = [];

	public async authorize(request: CapabilityGatewayRequest, _signal?: AbortSignal): Promise<CapabilityGatewayResult> {
		this.requests.push(request);
		return {
			requestId: request.request.requestId,
			decision: "ask",
			decisionDigest: DIGEST_A,
			approvalTicket: approvalTicket(),
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		this.cancellations.push(request);
		return cancelResult(request);
	}
}

class FakeApprovalCoordinator implements ApprovalCoordinatorPort {
	public readonly requests: ApprovalCoordinatorRequest[] = [];

	public async request(request: ApprovalCoordinatorRequest, _signal?: AbortSignal): Promise<ApprovalCoordinatorResult> {
		this.requests.push(request);
		return {
			approvalId: request.ticket.approvalId,
			ticketDigest: approvalTicketDigest(request.ticket),
			receipt: approvalReceipt(request.ticket),
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

class FakeSandboxExecutor implements SandboxExecutorPort {
	public readonly requests: SandboxExecutorRequest[] = [];

	public async execute(request: SandboxExecutorRequest, _signal?: AbortSignal): Promise<SandboxExecutorResult> {
		this.requests.push(request);
		const receipt: SandboxExecutionReceiptRef = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			receiptId: createRuntimeId("receipt", "security-port-sandbox"),
			requestId: request.requestId,
			profileId: request.profile.profileId,
			requested: request.profile.requested,
			resolved: request.profile.requested,
			policyDigest: request.profile.policyDigest,
			backendId: "fake",
			effectiveEnforcement: "enforced",
			invocationDigest: request.invocationDigest,
		};
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			resolutionReceiptId: createRuntimeId("receipt", "security-port-resolution"),
			executionReceipt: receipt,
		};
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return cancelResult(request);
	}
}

describe("Phase 3 opaque security ports", () => {
	it("lets fakes exchange schema-compatible request/result/cancel data without backend behavior", async () => {
		const ticket = approvalTicket();
		const gateway = new FakeCapabilityGateway();
		const approval = new FakeApprovalCoordinator();
		const sandbox = new FakeSandboxExecutor();
		const envelope = {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			sessionId: SESSION_ID,
			workspaceId: createRuntimeId("workspace", "security-port"),
			repositoryId: createRuntimeId("repository", "security-port"),
			worktreePath: "/workspace/security-port",
			branch: "runtime/security-port",
			baseCommit: "1".repeat(40),
			agentId: createRuntimeId("agent", "security-port"),
			toolCallId: TOOL_CALL_ID,
			traceId: createRuntimeId("trace", "security-port"),
			cwd: "/workspace/security-port",
			ownerRuntimeId: RUNTIME_ID,
			leaseRevision: 1,
			fencingToken: "opaque-fence",
		};
		const gatewayRequestBody: CapabilityGatewayRequestBody = {
			request: ticket.request,
			invocation: {
				requestId: REQUEST_ID,
				toolManifestDigest: DIGEST_A,
				rawArguments: { opaque: true },
				envelope,
				requestedClaims: [
					{
						authorityId: AUTHORITY_ID,
						tenantId: TENANT_ID,
						name: "workspace_write",
						resourceKind: "filesystem",
						resourceDigest: DIGEST_A,
						constraintsDigest: DIGEST_B,
					},
				],
			},
			idempotencyKey: createRuntimeId("command", "security-gateway-idempotency"),
			inputSources: [],
			targetSink: "filesystem",
			declassificationReceipts: [],
		};
		const gatewayRequest: CapabilityGatewayRequest = {
			...gatewayRequestBody,
			authentication: {
				channel: "local_process",
				channelBindingDigest: DIGEST_A,
				requestDigest: capabilityGatewayRequestDigest(gatewayRequestBody),
				nonce: "security-port-nonce-0001",
				issuedAt: "2026-07-22T00:00:00.000Z",
				expiresAt: "2026-07-22T00:05:00.000Z",
				keyRevision: 1,
			},
		};
		const gatewayResult = await gateway.authorize(gatewayRequest);
		expect(Check(CapabilityGatewayResultSchema, gatewayResult)).toBe(true);

		const approvalResult = await approval.request({
			ticket,
			expectedDecisionRevision: 0,
			idempotencyKey: createRuntimeId("command", "security-approval-idempotency"),
		});
		expect(Check(ApprovalCoordinatorResultSchema, approvalResult)).toBe(true);

		const sandboxResult = await sandbox.execute({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			requestId: REQUEST_ID,
			profile: {
				authorityId: AUTHORITY_ID,
				tenantId: TENANT_ID,
				profileId: PROFILE_ID,
				requested: "strict",
				policyDigest: DIGEST_A,
			},
			invocationDigest: DIGEST_B,
			resolutionDigest: DIGEST_C,
			idempotencyKey: createRuntimeId("command", "security-sandbox-idempotency"),
			opaqueInvocation: { fixture: true },
		});
		expect(Check(SandboxExecutorResultSchema, sandboxResult)).toBe(true);

		const cancelled = await gateway.cancel({
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			requestId: REQUEST_ID,
			reasonDigest: DIGEST_C,
		});
		expect(Check(SecurityPortCancelResultSchema, cancelled)).toBe(true);
		expect(gateway.requests).toHaveLength(1);
		expect(approval.requests).toHaveLength(1);
		expect(sandbox.requests).toHaveLength(1);
	});
});

describe("Phase 3 module boundaries", () => {
	it("does not import UI, storage, process/fs/network, or a concrete security backend", () => {
		for (const relativePath of [
			"../../../src/runtime/protocol/v3/capability.ts",
			"../../../src/runtime/protocol/v3/security-events.ts",
			"../../../src/runtime/session/security-projection.ts",
			"../../../src/runtime/session/security-reducer.ts",
		]) {
			const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
			const imports = source.match(/^import .*$/gm) ?? [];
			expect(imports.join("\n")).not.toMatch(
				/from\s+["'](?:node:(?:fs|child_process|net|http|https)|[^"']*(?:\/storage\/|\/tui\/|\/security\/|\/worktree\/))[^"']*["']/,
			);
		}
	});
});
