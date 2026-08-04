/** 唯一 policy-aware 执行面；不拥有 child process、PTY 或 output 生命周期。 */

import {
	isApprovalReceiptRef,
	runtimeDigest,
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
	type RuntimeDigest,
	type WorkspaceExecutionEnvelope,
} from "../runtime/contracts/public.ts";
import {
	pathWithin,
	PolicyFileSystem,
	type FileSystemBrokerPort,
} from "./policy-filesystem.ts";
import { PolicyNetworkClient, type NetworkBrokerPort } from "./policy-network.ts";
import {
	ApprovalCoordinator,
	type ApprovalRevalidationPort,
} from "./permission/approval-coordinator.ts";
import { PermissionEngine } from "./permission/engine.ts";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	SecurityResult,
	SecuritySnapshot,
} from "./types.ts";
import type {
	HostProcessFinalLeafDecisionPort,
} from "./integration/runtime-gateway-adapter.ts";

export interface ExecutionGatewayOpenRequest {
	readonly request: AuthorizationRequest;
	readonly authorization: AuthorizationResult;
	readonly authorizationDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly constraintInput: ExecutionConstraintInput;
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
}

export type ExecutionGatewayAuthorizationRequest = Omit<ExecutionGatewayOpenRequest, "authorization" | "authorizationDigest">;

export interface ExecutionGatewayContext {
	readonly authorization: AuthorizationResult;
	readonly authorizationDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly constraintSnapshot: ExecutionConstraintSnapshot;
	readonly fs: PolicyFileSystem;
	readonly filesystem: PolicyFileSystem;
	readonly network: PolicyNetworkClient;
	readonly finalLeaf: HostProcessFinalLeafDecisionPort;
}

export interface ExecutionGatewayOptions {
	readonly snapshot: SecuritySnapshot;
	readonly workspace: WorkspaceExecutionEnvelope;
	readonly filesystemBroker: FileSystemBrokerPort;
	readonly networkBroker: NetworkBrokerPort;
	readonly permissionEngine: PermissionEngine;
	readonly approvalCoordinator: ApprovalCoordinator;
	readonly finalLeaf: HostProcessFinalLeafDecisionPort;
}

function invalid(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function denied(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "policy_denied", message, retryable: false } };
}

function validDigest(value: RuntimeDigest): boolean {
	return value.algorithm === "sha256" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function snapshotDigest(snapshot: SecuritySnapshot): RuntimeDigest {
	const {
		policyDigest: _policyDigest,
		...body
	} = snapshot;
	return runtimeDigest(body);
}

function sameWorkspace(left: WorkspaceExecutionEnvelope, right: WorkspaceExecutionEnvelope): boolean {
	return left.authorityId === right.authorityId &&
		left.tenantId === right.tenantId &&
		left.workspaceId === right.workspaceId &&
		left.repositoryId === right.repositoryId &&
		left.worktreePath === right.worktreePath &&
		left.agentId === right.agentId &&
		left.ownerRuntimeId === right.ownerRuntimeId &&
		left.leaseRevision === right.leaseRevision &&
		sameDigest(left.fencingTokenDigest, right.fencingTokenDigest);
}

function requestDigest(request: AuthorizationRequest): RuntimeDigest {
	return runtimeDigest({
		requestId: request.requestId,
		sessionId: request.sessionId,
		turnId: request.turnId,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		argumentsDigest: request.argumentsDigest,
		cwd: request.cwd,
		requests: request.requests,
		workspace: request.workspace,
	});
}

export function gatewayRequestDigest(request: AuthorizationRequest): RuntimeDigest {
	return requestDigest(request);
}

function approvalRequestDigest(request: AuthorizationRequest): RuntimeDigest {
	return runtimeDigest({
		requestId: request.requestId,
		sessionId: request.sessionId,
		toolCallId: request.toolCallId,
		argumentsDigest: request.argumentsDigest,
		cwd: request.cwd,
		requests: request.requests,
		policyDigest: request.snapshot.policyDigest,
	});
}

function approvalReceiptIsBound(request: AuthorizationRequest, authorization: AuthorizationResult): boolean {
	const receipt = authorization.approval;
	if (receipt === undefined) return authorization.decisionSource !== "approval";
	if (!isApprovalReceiptRef(receipt) || receipt.decision !== "allowed") return false;
	if (!sameDigest(receipt.requestDigest, approvalRequestDigest(request))) return false;
	const { receiptId: _receiptId, receiptDigest: _receiptDigest, ...body } = receipt;
	return sameDigest(receipt.receiptDigest, runtimeDigest(body));
}

export class ExecutionGateway {
	readonly #options: ExecutionGatewayOptions;
	readonly #filesystem: PolicyFileSystem;
	readonly #network: PolicyNetworkClient;

	public constructor(options: ExecutionGatewayOptions) {
		this.#options = options;
		this.#filesystem = new PolicyFileSystem(options.filesystemBroker, options.workspace.cwd, options.snapshot);
		this.#network = new PolicyNetworkClient(options.networkBroker, options.snapshot.profile.network);
	}

	public async authorize(
		input: ExecutionGatewayAuthorizationRequest,
		signal?: AbortSignal,
	): Promise<SecurityResult<ExecutionGatewayContext>> {
		const structural = this.#validateRequest(input.request, input.requestDigest, input.constraintInput, input.constraintSnapshot);
		if (!structural.ok) return structural;
		const evaluation = this.#options.permissionEngine.evaluate(input.request.requests, input.request.snapshot);
		const revalidate: ApprovalRevalidationPort = () => ({
			argumentsDigest: input.request.argumentsDigest,
			cwd: input.request.cwd,
			policyDigest: input.request.snapshot.policyDigest,
		});
		const authorized = await this.#options.approvalCoordinator.authorize(input.request, evaluation, revalidate, signal);
		if (!authorized.ok) return authorized;
		if (authorized.value.outcome !== "allow") return denied(authorized.value.reason);
		return this.open({
			...input,
			authorization: authorized.value,
			authorizationDigest: runtimeDigest(authorized.value),
		});
	}

	public async open(input: ExecutionGatewayOpenRequest): Promise<SecurityResult<ExecutionGatewayContext>> {
		const structural = this.#validateRequest(input.request, input.requestDigest, input.constraintInput, input.constraintSnapshot);
		if (!structural.ok) return structural;
		if (!validDigest(input.authorizationDigest) || !sameDigest(input.authorizationDigest, runtimeDigest(input.authorization))) return invalid("authorization receipt digest is stale or invalid");
		if (input.authorization.outcome !== "allow") return denied(input.authorization.reason);
		if (!sameDigest(input.authorization.policyDigest, this.#options.snapshot.policyDigest)) return invalid("authorization policy digest is stale");
		if (runtimeDigest(input.authorization.requests).digest !== runtimeDigest(input.request.requests).digest) return invalid("authorization request set is stale");
		if (!approvalReceiptIsBound(input.request, input.authorization)) return invalid("approval receipt digest or binding is invalid");
		if (input.request.snapshot.profile.sandbox === "off" && input.constraintInput.modes.sandbox !== "none") return invalid("constraint sandbox mode is weaker than the current off policy");
		const requiresProcessSandbox = input.request.requests.some((request) => request.kind === "shell") || input.request.toolName === "bash";
		if (requiresProcessSandbox && input.request.snapshot.profile.sandbox !== "off" && input.constraintInput.modes.sandbox === "none") return invalid("restrictive sandbox decision is missing");
		return {
			ok: true,
			value: {
				authorization: input.authorization,
				authorizationDigest: input.authorizationDigest,
				requestDigest: input.requestDigest,
				constraintSnapshot: input.constraintSnapshot!,
				fs: this.#filesystem,
				filesystem: this.#filesystem,
				network: this.#network,
				finalLeaf: this.#options.finalLeaf,
			},
		};
	}

	#validateRequest(
		request: AuthorizationRequest,
		expectedRequestDigest: RuntimeDigest,
		constraintInput: ExecutionConstraintInput,
		constraintSnapshot: ExecutionConstraintSnapshot | undefined,
	): SecurityResult<void> {
		if (!validDigest(expectedRequestDigest) || !sameDigest(expectedRequestDigest, requestDigest(request))) return invalid("gateway request digest is stale or invalid");
		if (!sameWorkspace(request.workspace, this.#options.workspace)) return invalid("gateway workspace binding is stale");
		if (!sameDigest(this.#options.snapshot.policyDigest, snapshotDigest(this.#options.snapshot)) || !sameDigest(request.snapshot.policyDigest, snapshotDigest(request.snapshot))) return invalid("gateway security policy snapshot digest is invalid");
		if (!sameDigest(request.snapshot.policyDigest, this.#options.snapshot.policyDigest)) return invalid("gateway security policy digest is stale");
		if (request.snapshot.workspaceRoot !== this.#options.workspace.worktreePath || !pathWithin(this.#options.workspace.worktreePath, request.cwd)) return invalid("gateway request cwd is outside the workspace policy");
		if (!constraintSnapshot) return invalid("gateway constraint decision is missing");
		if (!validDigest(constraintInput.requestDigest) || !validDigest(constraintInput.policyDigest)) return invalid("gateway constraint digest is malformed");
		if (!sameDigest(constraintInput.requestDigest, expectedRequestDigest)) return invalid("gateway constraint request digest is stale");
		if (!sameDigest(constraintInput.policyDigest, this.#options.snapshot.policyDigest)) return invalid("gateway constraint policy digest is stale");
		if (constraintInput.authorityId !== request.workspace.authorityId || constraintInput.tenantId !== request.workspace.tenantId || constraintInput.workspaceId !== request.workspace.workspaceId || constraintInput.principalId !== request.workspace.principalId || constraintInput.commandId !== request.requestId) return invalid("gateway constraint identity is not bound to the request");
		if (!validateExecutionConstraintSnapshot(constraintInput, constraintSnapshot)) return invalid("gateway constraint receipt is stale or invalid");
		return { ok: true, value: undefined };
	}
}
