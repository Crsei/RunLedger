/**
 * S2 拆分:permission request 翻译与 authorization request 构造。
 *
 * 本模块还持有 `createAuthorizer`(authorization request 流程工厂):fs/network
 * governed leaf 共用同一 authorizer,且它依赖 `authorizationRequest`,与
 * permission-requester 同属 request 翻译域;归置在此避免 facade ↔ leaf 环。
 */

import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/ids.ts";
import { evaluateExecutionConstraints, type ExecutionConstraintProviders } from "../../runtime/process/execution-decision.ts";
import type { OwnerFence } from "../../runtime/session-owner/types.ts";
import { PermissionEngine } from "../permission/engine.ts";
import { MemoryPermissionGrantStore } from "../permission/grants.ts";
import { ApprovalCoordinator } from "../permission/approval-coordinator.ts";
import { ExecutionGateway, gatewayRequestDigest, type ExecutionGatewayContext } from "../execution-gateway.ts";
import { digestOf } from "../sandbox/common.ts";
import { unwrapSecurityResult } from "./audit-settlement.ts";
import { executionConstraintInput } from "./constraint-providers.ts";
import type { RequestPermissionsPort, GovernedPermissionRequest } from "../tools/request-permissions.ts";
import type {
	AccessRequest,
	AuthorizationRequest,
	HostWorkspaceExecutionContext,
	SecurityResult,
	SecuritySnapshot,
} from "../types.ts";
import type { SessionIdentity, SessionSecurityCompositionOptions } from "./session-security.ts";
import { authorizationSignal, type SecurityPolicyRevisionPort } from "../policy-revision.ts";

export function createPermissionRequester(input: {
	readonly revision?: SecurityPolicyRevisionPort;
	readonly options: SessionSecurityCompositionOptions;
	readonly snapshot: SecuritySnapshot;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
	readonly permissionEngine: PermissionEngine;
	readonly approvalCoordinator: ApprovalCoordinator;
	readonly permissionGrantStore: MemoryPermissionGrantStore;
	readonly cwd: string;
}): RequestPermissionsPort {
	return {
		request: async (request, signal) => {
			const requests = permissionGrantRequests(request);
			if (!requests.ok) return requests;
			const toolCallId = createRuntimeId("toolCall", canonicalDigest(request.toolCallId).slice(0, 64));
			const workspace = input.workspace(toolCallId, input.cwd);
			const authorization = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, "request_permissions", requests.value, request, input.cwd);
			const category = input.permissionEngine.evaluate([{ kind: "tool", toolName: "request_permissions" }], input.snapshot);
			const evaluation = { ...category, requests: requests.value };
			const approved = await input.approvalCoordinator.authorize(authorization, evaluation, () => ({
				argumentsDigest: authorization.argumentsDigest,
				cwd: authorization.cwd,
				policyDigest: authorization.snapshot.policyDigest,
			}), authorizationSignal(input.revision, signal));
			if (!approved.ok) return approved;
			if (approved.value.outcome !== "allow") return { ok: false, error: { code: "policy_denied", message: approved.value.reason, retryable: false } };
			const current = input.revision?.checkAdmission();
			if (current !== undefined && !current.ok) return current;
			return { ok: true, value: await input.permissionGrantStore.issue({
				scope: request.scope,
				sessionId: authorization.sessionId,
				turnId: authorization.turnId,
				policyDigest: authorization.snapshot.policyDigest,
				requests: requests.value,
			}) };
		},
	};
}

function permissionGrantRequests(input: GovernedPermissionRequest): SecurityResult<readonly AccessRequest[]> {
	const requests: AccessRequest[] = [];
	for (const permission of input.permissions.filesystem ?? []) {
		if (permission.access === "deny") return { ok: false, error: { code: "invalid_request", message: "request_permissions cannot elevate a deny filesystem entry", retryable: false } };
		requests.push({ kind: "filesystem", operation: permission.access, path: permission.path });
	}
	for (const permission of input.permissions.network ?? []) {
		if (permission.access === "deny") return { ok: false, error: { code: "invalid_request", message: "request_permissions cannot elevate a deny network entry", retryable: false } };
		requests.push({ kind: "network", operation: "connect", host: permission.host, protocol: permission.protocol, ...(permission.port === undefined ? {} : { port: permission.port }) });
	}
	return requests.length === 0
		? { ok: false, error: { code: "invalid_request", message: "request_permissions requires at least one permission", retryable: false } }
		: { ok: true, value: requests };
}

export function authorizationRequest(
	fence: OwnerFence,
	snapshot: SecuritySnapshot,
	workspace: HostWorkspaceExecutionContext,
	toolCallId: ReturnType<typeof createRuntimeId<"toolCall">>,
	toolName: string,
	requests: readonly AccessRequest[],
	args: unknown,
	cwd: string,
): AuthorizationRequest {
	const requestId = createRuntimeId("command", canonicalDigest({ sessionId: fence.sessionId, toolCallId, toolName, requests, args, cwd }).slice(0, 64));
	return {
		requestId,
		sessionId: fence.sessionId,
		turnId: createRuntimeId("turn", canonicalDigest({ requestId, toolCallId, fence }).slice(0, 64)),
		toolCallId,
		toolName,
		argumentsDigest: digestOf(args),
		cwd,
		requests,
		workspace,
		snapshot,
	};
}

export function createAuthorizer(input: {
	readonly options: SessionSecurityCompositionOptions;
	readonly identity: SessionIdentity;
	readonly snapshot: SecuritySnapshot;
	readonly gateway: ExecutionGateway;
	readonly providers: ExecutionConstraintProviders;
	readonly workspace: (toolCallId: string, cwd?: string) => HostWorkspaceExecutionContext;
}) {
	return async (
		toolName: string,
		requests: readonly AccessRequest[],
		args: unknown,
		requestCwd: string,
		signal?: AbortSignal,
	): Promise<ExecutionGatewayContext> => {
		const toolCallId = createRuntimeId("toolCall", canonicalDigest({ toolName, requests, args, requestCwd }).slice(0, 64));
		const workspace = input.workspace(toolCallId, requestCwd);
		const request = authorizationRequest(input.options.fence, input.snapshot, workspace, toolCallId, toolName, requests, args, requestCwd);
		const requestDigest = gatewayRequestDigest(request);
		const constraintInput = executionConstraintInput(input.identity, input.options.fence, request.requestId, requestDigest, input.snapshot, "none");
		const constraints = await evaluateExecutionConstraints(constraintInput, input.providers);
		if (!constraints.ok) throw new Error(`execution constraint ${constraints.code} at ${constraints.dimension}`);
		const opened = await input.gateway.authorize({ request, requestDigest, constraintInput, constraintSnapshot: constraints.snapshot }, signal);
		return unwrapSecurityResult(opened);
	};
}
