/** 唯一 policy-aware 执行面；不拥有 child process、PTY 或 output 生命周期。 */

import {
	canonicalDigest,
	isApprovalReceiptRef,
	runtimeDigest,
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
	type RuntimeDigest,
} from "../runtime/contracts/public.ts";
import type { HostWorkspaceExecutionContext } from "./types.ts";
import {
	CanonicalPathResolver,
	FileAccessGuard,
	pathWithin,
	PolicyFileSystem,
	type FileSystemBrokerPort,
} from "./policy-filesystem.ts";
import { PolicyNetworkClient, type NetworkBrokerPort } from "./policy-network.ts";
import { normalizeNetworkApprovalKey, type NetworkApprovalReviewPort } from "./network/network-approval.ts";
import {
	ApprovalCoordinator,
	AUTO_REVIEW_APPROVAL_PRINCIPAL_ID,
	SYSTEM_APPROVAL_PRINCIPAL_ID,
	sessionApprovalRequestDigest,
	type ApprovalRevalidationPort,
} from "./permission/approval-coordinator.ts";
import { PermissionEngine, requiresExplicitConfirmation } from "./permission/engine.ts";
import { autoApprovalReviewInputDigest, type AutoApprovalReviewInput } from "./permission/auto-approval-reviewer.ts";
import type { MemoryPermissionGrantStore } from "./permission/grants.ts";
import type {
	AccessRequest,
	AuthorizationRequest,
	AuthorizationResult,
	PendingFilesystemEscalation,
	SecurityResult,
	SecuritySnapshot,
} from "./types.ts";
import type { BashClassificationAuditPort } from "./permission/bash-ast/types.ts";
import type {
	ProcessFinalLeafDecisionPort,
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
	/** 系统确认在最终副作用前复验，不能只在 prepare 时检查。 */
	readonly validateAuthorization: () => Promise<SecurityResult<void>>;
	readonly authorization: AuthorizationResult;
	readonly authorizationDigest: RuntimeDigest;
	readonly requestDigest: RuntimeDigest;
	readonly constraintSnapshot: ExecutionConstraintSnapshot;
	readonly fs: PolicyFileSystem;
	readonly filesystem: PolicyFileSystem;
	readonly network: PolicyNetworkClient;
	readonly finalLeaf: ProcessFinalLeafDecisionPort;
	/** Idempotent durable completion fence for an approval-backed effect. */
	readonly complete: () => Promise<SecurityResult<void>>;
}

export interface ExecutionGatewayOptions {
	readonly snapshot: SecuritySnapshot;
	readonly workspace: HostWorkspaceExecutionContext;
	readonly filesystemBroker: FileSystemBrokerPort;
	readonly networkBroker: NetworkBrokerPort;
	readonly permissionEngine: PermissionEngine;
	readonly approvalCoordinator: ApprovalCoordinator;
	readonly finalLeaf: ProcessFinalLeafDecisionPort;
	readonly permissionGrantStore?: MemoryPermissionGrantStore;
	readonly bashClassificationAudit?: BashClassificationAuditPort;
}

function invalid(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function denied(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "policy_denied", message, retryable: false } };
}

function approvalDenied(authorization: AuthorizationResult): SecurityResult<never> {
	const decision = authorization.approval?.decision;
	const code = decision === "expired"
		? "approval_expired"
		: decision === "cancelled"
			? "approval_cancelled"
			: "policy_denied";
	return { ok: false, error: { code, message: authorization.reason, retryable: false } };
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

function sameWorkspace(left: HostWorkspaceExecutionContext, right: HostWorkspaceExecutionContext): boolean {
	return left.authorityId === right.authorityId &&
		left.tenantId === right.tenantId &&
		left.workspaceId === right.workspaceId &&
		left.repositoryId === right.repositoryId &&
		sameDigest(left.worktreePathDigest, right.worktreePathDigest) &&
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
	const expected = receipt.scope === "session" ? sessionApprovalRequestDigest(request) : approvalRequestDigest(request);
	if (!sameDigest(receipt.requestDigest, expected)) return false;
	const { receiptId: _receiptId, receiptDigest: _receiptDigest, ...body } = receipt;
	return sameDigest(receipt.receiptDigest, runtimeDigest(body));
}

export class ExecutionGateway {
	readonly #options: ExecutionGatewayOptions;

	public constructor(options: ExecutionGatewayOptions) {
		this.#options = options;
	}

	public async authorize(
		input: ExecutionGatewayAuthorizationRequest,
		signal?: AbortSignal,
	): Promise<SecurityResult<ExecutionGatewayContext>> {
		const structural = this.#validateRequest(input.request, input.requestDigest, input.constraintInput, input.constraintSnapshot);
		if (!structural.ok) return structural;
		const evaluation = this.#options.permissionEngine.evaluate(input.request.requests, input.request.snapshot);
		const grant = evaluation.decision === "deny" || requiresExplicitConfirmation(evaluation) ? undefined : await this.#options.permissionGrantStore?.authorize({
			sessionId: input.request.sessionId,
			turnId: input.request.turnId,
			policyDigest: input.request.snapshot.policyDigest,
			requests: input.request.requests,
		});
		if (grant !== undefined) {
			const authorization: AuthorizationResult = {
				outcome: "allow",
				decisionSource: "session",
				requests: input.request.requests,
				policyDigest: input.request.snapshot.policyDigest,
				reason: `matched ${grant.scope} request_permissions grant`,
			};
			return this.#finishAuthorization(input, authorization);
		}
		const revalidate: ApprovalRevalidationPort = () => ({
			argumentsDigest: input.request.argumentsDigest,
			cwd: input.request.cwd,
			policyDigest: input.request.snapshot.policyDigest,
		});
		const autoReview = await this.#autoReviewInput(input.request, evaluation);
		const authorized = await this.#options.approvalCoordinator.authorize(input.request, evaluation, revalidate, signal, autoReview);
		if (!authorized.ok) return authorized;
		return this.#finishAuthorization(input, authorized.value);
	}

	async #autoReviewInput(
		request: AuthorizationRequest,
		evaluation: ReturnType<PermissionEngine["evaluate"]>,
	): Promise<AutoApprovalReviewInput | undefined> {
		if (request.snapshot.approvalReviewer !== "auto-review" || evaluation.decision !== "ask" || request.requests.length !== 1) return undefined;
		const target = request.requests[0];
		if (target?.kind !== "filesystem" || target.operation !== "write") return undefined;
		const decision = evaluation.requestDecisions[0];
		if (decision === undefined || decision.action !== "ask" || decision.matchedRuleIds.includes("builtin-root-boundary-escalation")) return undefined;
		const canonical = await new CanonicalPathResolver(this.#options.filesystemBroker, this.#options.workspace.cwd).resolve(target.path);
		if (!canonical.ok || !pathWithin(request.snapshot.workspaceRoot, canonical.value.canonicalPath)) return undefined;
		const ordinary = new FileAccessGuard(request.snapshot).check("write", canonical.value);
		if (!ordinary.ok) return undefined;
		const body = {
			request,
			evaluation,
			canonicalTarget: canonical.value.canonicalPath,
			sessionGeneration: request.workspace.leaseRevision,
		};
		return { ...body, inputDigest: autoApprovalReviewInputDigest(body) };
	}

	async #finishAuthorization(
		input: ExecutionGatewayAuthorizationRequest,
		authorization: AuthorizationResult,
	): Promise<SecurityResult<ExecutionGatewayContext>> {
		await this.#recordBashClassification(input.request, input.requestDigest, authorization);
		if (authorization.outcome !== "allow") return approvalDenied(authorization);
		return this.open({
			...input,
			authorization,
			authorizationDigest: runtimeDigest(authorization),
		});
	}

	async #recordBashClassification(
		request: AuthorizationRequest,
		requestDigestValue: RuntimeDigest,
		authorization: AuthorizationResult,
	): Promise<void> {
		const audit = this.#options.bashClassificationAudit;
		if (audit === undefined) return;
		const shell = request.requests.find((item): item is Extract<AccessRequest, { readonly kind: "shell" }> =>
			item.kind === "shell" &&
			(item.bashAnalyzerMode === "shadow" || item.bashAnalyzerMode === "ast") &&
			item.bashAst !== undefined,
		);
		const mode = shell?.bashAnalyzerMode;
		if (shell === undefined || shell.bashAst === undefined || (mode !== "shadow" && mode !== "ast")) return;
		const record: Parameters<BashClassificationAuditPort["record"]>[0] = {
			protocolVersion: 1,
			sessionId: request.sessionId,
			toolCallId: request.toolCallId,
			requestDigest: requestDigestValue.digest,
			commandDigest: canonicalDigest(shell.command),
			accessRequestsDigest: runtimeDigest(request.requests).digest,
			mode,
			classification: shell.bashAst.kind,
			configDigest: request.snapshot.bashAnalyzer?.configDigest ?? canonicalDigest({ mode, source: "default" }),
			...(shell.bashAst.kind === "simple" ? {} : { reasonCode: shell.bashAst.reasonCode }),
			...(shell.bashAst.parserDigest === undefined ? {} : { parserDigest: shell.bashAst.parserDigest }),
			...(mode === "shadow" ? { legacyKind: shell.analysis } : {}),
			durationBucket: shell.bashMetrics?.durationBucket ?? "unavailable",
			nodeCountBucket: shell.bashMetrics?.nodeCountBucket ?? "unavailable",
			authorizationOutcome: authorization.outcome,
			...(authorization.approval === undefined ? {} : { approvalReceiptId: authorization.approval.receiptId }),
		};
		try {
			await audit.record(record);
		} catch {
			// 分类审计 sink 是 best-effort；不把 sink 故障变成授权旁路或放权。
		}
	}

	public async open(input: ExecutionGatewayOpenRequest): Promise<SecurityResult<ExecutionGatewayContext>> {
		const structural = this.#validateRequest(input.request, input.requestDigest, input.constraintInput, input.constraintSnapshot);
		if (!structural.ok) return structural;
		if (!validDigest(input.authorizationDigest) || !sameDigest(input.authorizationDigest, runtimeDigest(input.authorization))) return invalid("authorization receipt digest is stale or invalid");
		if (input.authorization.outcome !== "allow") return denied(input.authorization.reason);
		if (!sameDigest(input.authorization.policyDigest, this.#options.snapshot.policyDigest)) return invalid("authorization policy digest is stale");
		if (runtimeDigest(input.authorization.requests).digest !== runtimeDigest(input.request.requests).digest) return invalid("authorization request set is stale");
		if (!approvalReceiptIsBound(input.request, input.authorization)) return invalid("approval receipt digest or binding is invalid");
		const evaluation = this.#options.permissionEngine.evaluate(input.request.requests, input.request.snapshot);
		if (evaluation.decision === "deny") return denied(evaluation.reason);
		if (requiresExplicitConfirmation(evaluation) && (
			input.authorization.decisionSource !== "approval" || input.authorization.approval?.scope !== "once" ||
			input.authorization.approval.principalId === AUTO_REVIEW_APPROVAL_PRINCIPAL_ID ||
			input.authorization.approval.principalId === SYSTEM_APPROVAL_PRINCIPAL_ID
		)) return denied("system circuit breaker requires an exact one-time user approval");
		if (requiresExplicitConfirmation(evaluation) && input.constraintInput.modes.approval !== "required") return denied("system circuit breaker requires an approval constraint receipt");
		if (input.request.snapshot.profile.sandbox === "off" && input.constraintInput.modes.sandbox !== "none") return invalid("constraint sandbox mode is weaker than the current off policy");
		const requiresProcessSandbox = input.request.requests.some((request) => request.kind === "shell") || input.request.toolName === "bash";
		if (requiresProcessSandbox && input.request.snapshot.profile.sandbox !== "off" && input.constraintInput.modes.sandbox === "none") return invalid("restrictive sandbox decision is missing");
		const escalations = await this.#filesystemEscalations(input.request, input.authorization);
		if (!escalations.ok) return escalations;
		const filesystem = new PolicyFileSystem(this.#options.filesystemBroker, this.#options.workspace.cwd, this.#options.snapshot, escalations.value);
		const complete = this.#completion(input.request, input.authorization);
		return {
			ok: true,
			value: {
				validateAuthorization: async () => {
					if (!requiresExplicitConfirmation(evaluation)) return { ok: true, value: undefined };
					const receipt = input.authorization.approval;
					return receipt === undefined ? denied("system circuit breaker approval is missing") : this.#options.approvalCoordinator.validateAllowOnce(input.request, receipt);
				},
				authorization: input.authorization,
				authorizationDigest: input.authorizationDigest,
				requestDigest: input.requestDigest,
				constraintSnapshot: input.constraintSnapshot!,
				fs: filesystem,
				filesystem,
				network: new PolicyNetworkClient(
					this.#options.networkBroker,
					this.#options.snapshot.profile.network,
					exactAuthorizedNetworkReview(input.request.requests),
				),
				finalLeaf: this.#options.finalLeaf,
				complete,
			},
		};
	}

	async #filesystemEscalations(
		request: AuthorizationRequest,
		authorization: AuthorizationResult,
	): Promise<SecurityResult<readonly PendingFilesystemEscalation[]>> {
		const evaluation = this.#options.permissionEngine.evaluate(request.requests, request.snapshot);
		const eligible = evaluation.requestDecisions
			.map((decision, index) => ({ decision, request: request.requests[index] }))
			.filter((entry): entry is {
				readonly decision: typeof evaluation.requestDecisions[number];
				readonly request: Extract<AccessRequest, { readonly kind: "filesystem" }>;
			} => entry.request?.kind === "filesystem" &&
				(entry.request.operation === "write" || entry.request.operation === "delete") &&
				entry.decision.matchedRuleIds.includes("builtin-root-boundary-escalation"));
		if (eligible.length === 0) return { ok: true, value: [] };
		if (
			authorization.decisionSource !== "approval" ||
			authorization.approval?.decision !== "allowed" ||
			authorization.approval.scope !== "once" ||
			eligible.length !== 1 ||
			request.requests.length !== 1
		) return denied("workspace-external filesystem escalation requires one exact allow-once approval");
		const target = eligible[0]!.request;
		if (target.operation !== "write" && target.operation !== "delete") return denied("workspace-external filesystem escalation has an invalid operation");
		const resolver = new CanonicalPathResolver(this.#options.filesystemBroker, this.#options.workspace.cwd);
		const canonical = await resolver.resolve(target.path);
		if (!canonical.ok) return canonical;
		const ordinaryGuard = new FileAccessGuard(this.#options.snapshot);
		const ordinary = ordinaryGuard.check(target.operation, canonical.value);
		if (ordinary.ok) return { ok: true, value: [] };
		if (ordinary.error.code !== "path_escape") return ordinary;
		return {
			ok: true,
			value: [{
				operation: target.operation,
				canonicalTarget: canonical.value.canonicalPath,
				requestedPath: target.path,
				policyDigest: request.snapshot.policyDigest,
				sessionGeneration: request.workspace.leaseRevision,
				scope: "once",
			}],
		};
	}

	#completion(
		request: AuthorizationRequest,
		authorization: AuthorizationResult,
	): () => Promise<SecurityResult<void>> {
		const receipt = authorization.approval;
		let settled: Promise<SecurityResult<void>> | undefined;
		return () => {
			if (settled !== undefined) return settled;
			if (authorization.decisionSource !== "approval" || receipt === undefined || receipt.scope !== "once") {
				settled = Promise.resolve({ ok: true, value: undefined });
				return settled;
			}
			settled = this.#options.approvalCoordinator.consumeAllowOnce(request, receipt).then((result) => result.ok
				? { ok: true, value: undefined }
				: result);
			return settled;
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

function exactAuthorizedNetworkReview(requests: readonly AccessRequest[]): NetworkApprovalReviewPort {
	const allowed = requests.flatMap((request) => {
		if (request.kind !== "network" || request.protocol === undefined) return [];
		const key = normalizeNetworkApprovalKey({ host: request.host, protocol: request.protocol, ...(request.port === undefined ? {} : { port: request.port }) });
		return key === undefined ? [] : [key];
	});
	return {
		authorize: async (input) => {
			const key = normalizeNetworkApprovalKey(input);
			if (key === undefined) return { ok: false, error: { code: "network_denied", message: "network approval key is invalid", retryable: false } };
			const exact = allowed.some((candidate) => candidate.host === key.host && candidate.protocol === key.protocol && candidate.port === key.port);
			return exact
				? { ok: true, value: "allow" }
				: { ok: false, error: { code: "network_denied", message: "network endpoint is not bound to the authorized request", retryable: false } };
		},
	};
}
