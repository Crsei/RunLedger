/** AgentWorkspacePort 的 production WorktreeManager adapter；raw path/token 只存在于本模块私有 handle。 */

import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AgentId,
	type AuthorityId,
	type CommandId,
	type PrincipalId,
	type RepositoryId,
	type RuntimeInstanceId,
	type SessionId,
	type TenantId,
	type TraceId,
} from "../../protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../../protocol/v3/workspace.ts";
import type { WorktreeManager } from "../../../worktree/manager.ts";
import type { WorktreeCreateResult } from "../../../worktree/types.ts";
import type {
	AgentErrorCode,
	AgentResult,
	AgentWorkspaceAllocateRequest,
	AgentWorkspacePort,
	AgentWorkspaceReceiptRef,
	AgentWorkspaceReleaseRequest,
	AgentWorkspaceStrategyRef,
	AgentWorkspaceValidateRequest,
} from "../types.ts";

export interface ProductionAgentWorkspaceOptions {
	manager: WorktreeManager;
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	repositoryId: RepositoryId;
	sourceRepo: string;
	sourceCwd: string;
	rootAgentId: AgentId;
	rootOwnerRuntimeId: RuntimeInstanceId;
	ownerRuntimeIdForChild?: (agentId: AgentId, sessionId: SessionId) => RuntimeInstanceId;
	clock?: () => Date;
}

export interface BindRootAgentWorkspaceRequest {
	requestId: CommandId;
	agentId: AgentId;
	sessionId: SessionId;
	strategy: AgentWorkspaceStrategyRef;
}

/** 仅供同一 trusted integration 层的 launcher/merge adapter 使用。 */
export interface ValidatedAgentWorkspaceContext {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	repositoryId: RepositoryId;
	agentId: AgentId;
	sessionId: SessionId;
	workspaceReceipt: AgentWorkspaceReceiptRef;
	envelope: WorkspaceExecutionEnvelope;
}

interface PrivateWorkspaceHandle {
	agentId: AgentId;
	sessionId: SessionId;
	result: WorktreeCreateResult;
	receipt: AgentWorkspaceReceiptRef;
}

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function receiptBody(
	receipt: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> | AgentWorkspaceReceiptRef,
): Omit<AgentWorkspaceReceiptRef, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt as AgentWorkspaceReceiptRef;
	return body;
}

function exactReceipt(left: AgentWorkspaceReceiptRef, right: AgentWorkspaceReceiptRef): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

function receiptHasValidDigest(receipt: AgentWorkspaceReceiptRef): boolean {
	return receipt.receiptDigest === canonicalDigest(receiptBody(receipt));
}

/** issuedAt 可在 cold restore 时更新；真正的 binding/lease identity 必须保持 exact。 */
function sameDurableBinding(left: AgentWorkspaceReceiptRef, right: AgentWorkspaceReceiptRef): boolean {
	return (
		left.receiptId === right.receiptId &&
		left.strategy.strategyId === right.strategy.strategyId &&
		left.strategy.kind === right.strategy.kind &&
		left.strategy.strategyDigest === right.strategy.strategyDigest &&
		left.sessionId === right.sessionId &&
		left.workspaceId === right.workspaceId &&
		left.repositoryId === right.repositoryId &&
		left.bindingRevision === right.bindingRevision &&
		left.bindingDigest === right.bindingDigest &&
		left.leaseId === right.leaseId &&
		left.leaseRevision === right.leaseRevision &&
		left.status === right.status
	);
}

function allocateDigest(request: AgentWorkspaceAllocateRequest): string {
	return canonicalDigest({
		requestId: request.requestId,
		parentAgentId: request.parentAgentId,
		parentSessionId: request.parentSessionId,
		parentWorkspaceId: request.parentWorkspaceId,
		childAgentId: request.childAgentId,
		childSessionId: request.childSessionId,
		role: request.role,
		strategy: request.strategy,
	});
}

function validateDigest(request: AgentWorkspaceValidateRequest): string {
	return canonicalDigest({
		requestId: request.requestId,
		agentId: request.agentId,
		sessionId: request.sessionId,
		previousReceipt: request.previousReceipt,
	});
}

function releaseDigest(request: AgentWorkspaceReleaseRequest): string {
	return canonicalDigest({
		requestId: request.requestId,
		agentId: request.agentId,
		sessionId: request.sessionId,
		previousReceipt: request.previousReceipt,
		reason: request.reason,
	});
}

export class ProductionAgentWorkspaceAdapter implements AgentWorkspacePort {
	readonly #options: ProductionAgentWorkspaceOptions;
	readonly #clock: () => Date;
	readonly #handles = new Map<string, PrivateWorkspaceHandle>();

	public constructor(options: ProductionAgentWorkspaceOptions) {
		if (
			!isRuntimeId(options.authorityId, "authority") ||
			!isRuntimeId(options.tenantId, "tenant") ||
			!isRuntimeId(options.principalId, "principal") ||
			!isRuntimeId(options.repositoryId, "repository") ||
			!isRuntimeId(options.rootAgentId, "agent") ||
			!isRuntimeId(options.rootOwnerRuntimeId, "runtime")
		) throw new TypeError("production Agent Workspace scope is invalid");
		this.#options = options;
		this.#clock = options.clock ?? (() => new Date());
	}

	#owner(agentId: AgentId, sessionId: SessionId, root: boolean): RuntimeInstanceId {
		if (root) return this.#options.rootOwnerRuntimeId;
		return this.#options.ownerRuntimeIdForChild?.(agentId, sessionId) ??
			createRuntimeId("runtime", `child-${canonicalDigest({ agentId, sessionId }).slice(0, 48)}`);
	}

	#traceId(agentId: AgentId, sessionId: SessionId, workspaceId: AgentWorkspaceReceiptRef["workspaceId"]): TraceId {
		return createRuntimeId(
			"trace",
			`agent-workspace-restore-${canonicalDigest({ agentId, sessionId, workspaceId }).slice(0, 40)}`,
		);
	}

	#receipt(
		result: WorktreeCreateResult,
		sessionId: SessionId,
		strategy: AgentWorkspaceStrategyRef,
	): AgentWorkspaceReceiptRef {
		const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
			receiptId: result.receiptId,
			strategy: { ...strategy },
			sessionId,
			workspaceId: result.binding.workspaceId,
			repositoryId: result.binding.repositoryId,
			bindingRevision: result.binding.leaseRevision,
			bindingDigest: result.binding.bindingDigest,
			leaseId: result.lease.leaseId,
			leaseRevision: result.lease.leaseRevision,
			status: strategy.kind === "readonly_checkout" ? "readonly" : "active",
			issuedAt: this.#clock().toISOString(),
		};
		return { ...body, receiptDigest: canonicalDigest(receiptBody(body)) };
	}

	#store(
		agentId: AgentId,
		sessionId: SessionId,
		result: WorktreeCreateResult,
		strategy: AgentWorkspaceStrategyRef,
	): AgentWorkspaceReceiptRef {
		const receipt = this.#receipt(result, sessionId, strategy);
		this.#handles.set(receipt.receiptId, { agentId, sessionId, result, receipt });
		return receipt;
	}

	public async bindRoot(
		request: BindRootAgentWorkspaceRequest,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		if (
			!isRuntimeId(request.requestId, "command") ||
			!isRuntimeId(request.agentId, "agent") ||
			!isRuntimeId(request.sessionId, "session") ||
			request.strategy.kind === "readonly_checkout"
		) return fail("workspace_invalid", "root Agent Workspace binding is invalid");
		const bound = await this.#options.manager.bindSource({
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			principalId: this.#options.principalId,
			sessionId: request.sessionId,
			repositoryId: this.#options.repositoryId,
			sourceRepo: this.#options.sourceRepo,
			sourceCwd: this.#options.sourceCwd,
			bindingKind: "source",
			ownerRuntimeId: this.#owner(request.agentId, request.sessionId, true),
			requestId: request.requestId,
		});
		return bound.ok
			? { ok: true, value: this.#store(request.agentId, request.sessionId, bound.value, request.strategy) }
			: fail("workspace_invalid", bound.error.message, bound.error.retryable);
	}

	public async allocate(
		request: AgentWorkspaceAllocateRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		if (signal?.aborted) return fail("reference_unavailable", "Agent Workspace allocation was aborted", true);
		if (
			request.requestDigest !== allocateDigest(request) ||
			!isRuntimeId(request.childAgentId, "agent") ||
			!isRuntimeId(request.childSessionId, "session")
		) return fail("workspace_invalid", "Agent Workspace allocation request is invalid");
		const bindingKind = request.strategy.kind === "readonly_checkout" ? "readonly_checkout" : "managed_worktree";
		const allocated = await this.#options.manager.create({
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			principalId: this.#options.principalId,
			sessionId: request.childSessionId,
			repositoryId: this.#options.repositoryId,
			sourceRepo: this.#options.sourceRepo,
			sourceCwd: this.#options.sourceCwd,
			label: `agent-${canonicalDigest({ agentId: request.childAgentId, sessionId: request.childSessionId }).slice(0, 16)}`,
			bindingKind,
			baseRef: "HEAD",
			ownerRuntimeId: this.#owner(request.childAgentId, request.childSessionId, false),
			requestId: request.requestId,
		}, signal);
		if (!allocated.ok) return fail("workspace_invalid", allocated.error.message, allocated.error.retryable);
		const receipt = this.#store(
			request.childAgentId,
			request.childSessionId,
			allocated.value,
			request.strategy,
		);
		if (receipt.workspaceId === request.parentWorkspaceId) {
			return fail("workspace_shared", "production Workspace allocation aliased the parent workspace");
		}
		return { ok: true, value: receipt };
	}

	#handle(
		receipt: AgentWorkspaceReceiptRef,
		agentId: AgentId,
		sessionId: SessionId,
	): AgentResult<PrivateWorkspaceHandle> {
		const handle = this.#handles.get(receipt.receiptId);
		if (
			!handle ||
			handle.agentId !== agentId ||
			handle.sessionId !== sessionId ||
			!exactReceipt(handle.receipt, receipt) ||
			receipt.bindingRevision !== handle.result.binding.leaseRevision ||
			receipt.leaseRevision !== handle.result.lease.leaseRevision ||
			receipt.bindingDigest !== handle.result.binding.bindingDigest ||
			receipt.workspaceId !== handle.result.binding.workspaceId
		) return fail("workspace_invalid", "Agent Workspace receipt is unknown, stale, or uncorrelated");
		return { ok: true, value: handle };
	}

	/**
	 * Cold restart 只凭 durable receipt + WorktreeManager registry/lease store 重建私有 handle。
	 * raw fencing token 从 lease store 重新读取，绝不进入 graph/session receipt。
	 */
	async #rehydrateHandle(
		receipt: AgentWorkspaceReceiptRef,
		agentId: AgentId,
		sessionId: SessionId,
	): Promise<AgentResult<PrivateWorkspaceHandle>> {
		if (
			!receiptHasValidDigest(receipt) ||
			receipt.sessionId !== sessionId ||
			receipt.repositoryId !== this.#options.repositoryId ||
			(receipt.status !== "active" && receipt.status !== "readonly")
		) return fail("workspace_invalid", "Agent Workspace durable receipt is malformed or out of scope");
		const root = agentId === this.#options.rootAgentId;
		const resumed = await this.#options.manager.resume(
			receipt.workspaceId,
			{
				authorityId: this.#options.authorityId,
				tenantId: this.#options.tenantId,
				principalId: this.#options.principalId,
				sessionId,
				agentId,
				traceId: this.#traceId(agentId, sessionId, receipt.workspaceId),
			},
			this.#owner(agentId, sessionId, root),
		);
		if (!resumed.ok) return fail("workspace_invalid", resumed.error.message, resumed.error.retryable);
		if (
			resumed.value.binding.workspaceId !== receipt.workspaceId ||
			resumed.value.binding.repositoryId !== receipt.repositoryId ||
			resumed.value.binding.sessionId !== sessionId ||
			resumed.value.binding.leaseRevision < receipt.bindingRevision ||
			resumed.value.lease.leaseId !== receipt.leaseId ||
			resumed.value.lease.leaseRevision < (receipt.leaseRevision ?? -1)
		) return fail("workspace_invalid", "durable Workspace resume returned an unrelated or stale binding");
		const currentReceipt = this.#receipt(resumed.value, sessionId, receipt.strategy);
		const handle = { agentId, sessionId, result: resumed.value, receipt: currentReceipt };
		this.#handles.set(currentReceipt.receiptId, handle);
		return { ok: true, value: handle };
	}

	async #validatedContext(
		input: {
			requestId: CommandId;
			agentId: AgentId;
			sessionId: SessionId;
			receipt: AgentWorkspaceReceiptRef;
		},
		allowLeaseAdvance: boolean,
	): Promise<AgentResult<ValidatedAgentWorkspaceContext>> {
		let handle = this.#handle(input.receipt, input.agentId, input.sessionId);
		if (!handle.ok) {
			// 已知 handle 的不匹配代表 stale/forged receipt，不能用 durable reopen 绕过。
			if (this.#handles.has(input.receipt.receiptId)) return handle;
			handle = await this.#rehydrateHandle(input.receipt, input.agentId, input.sessionId);
			if (!handle.ok) return handle;
			if (!allowLeaseAdvance && !sameDurableBinding(input.receipt, handle.value.receipt)) {
				return fail("workspace_invalid", "Workspace lease changed and requires durable graph revalidation");
			}
		}
		if (handle.value.receipt.status !== "active" && handle.value.receipt.status !== "readonly") {
			return fail("workspace_invalid", "Agent Workspace is not active");
		}
		const envelope = this.#envelope(handle.value, input.requestId);
		const validation = await this.#options.manager.validate(envelope);
		if (
			!validation.ok ||
			validation.value.validation.outcome !== "valid" ||
			validation.value.binding.bindingDigest !== handle.value.receipt.bindingDigest ||
			validation.value.binding.leaseRevision !== handle.value.receipt.leaseRevision
		) return fail("workspace_invalid", "Agent Workspace lease validation failed");
		return {
			ok: true,
			value: {
				authorityId: this.#options.authorityId,
				tenantId: this.#options.tenantId,
				principalId: this.#options.principalId,
				repositoryId: this.#options.repositoryId,
				agentId: input.agentId,
				sessionId: input.sessionId,
				workspaceReceipt: { ...handle.value.receipt },
				envelope,
			},
		};
	}

	#envelope(handle: PrivateWorkspaceHandle, requestId: CommandId): WorkspaceExecutionEnvelope {
		const result = handle.result;
		return {
			authorityId: result.binding.authorityId,
			tenantId: result.binding.tenantId,
			principalId: result.binding.principalId,
			sessionId: handle.sessionId,
			workspaceId: result.binding.workspaceId,
			repositoryId: result.binding.repositoryId,
			worktreePath: result.binding.worktreePath,
			branch: result.binding.branch,
			baseCommit: result.binding.baseCommit,
			agentId: handle.agentId,
			toolCallId: createRuntimeId("toolCall", `agent-workspace-${canonicalDigest(requestId).slice(0, 40)}`),
			traceId: createRuntimeId("trace", `agent-workspace-${canonicalDigest({ requestId, agentId: handle.agentId }).slice(0, 40)}`),
			cwd: result.binding.effectiveCwd,
			ownerRuntimeId: result.binding.ownerRuntimeId,
			leaseRevision: result.binding.leaseRevision,
			fencingToken: result.fencingToken,
		};
	}

	public async withValidatedWorkspace<T>(
		input: {
			requestId: CommandId;
			agentId: AgentId;
			sessionId: SessionId;
			receipt: AgentWorkspaceReceiptRef;
		},
		operation: (context: ValidatedAgentWorkspaceContext) => Promise<AgentResult<T>>,
	): Promise<AgentResult<T>> {
		const validated = await this.#validatedContext(input, false);
		return validated.ok ? operation(validated.value) : validated;
	}

	public async validate(
		request: AgentWorkspaceValidateRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		if (signal?.aborted) return fail("reference_unavailable", "Agent Workspace validation was aborted", true);
		if (request.requestDigest !== validateDigest(request)) {
			return fail("workspace_invalid", "Agent Workspace validation request digest is invalid");
		}
		const validated = await this.#validatedContext(
			{
				requestId: request.requestId,
				agentId: request.agentId,
				sessionId: request.sessionId,
				receipt: request.previousReceipt,
			},
			true,
		);
		return validated.ok ? { ok: true, value: validated.value.workspaceReceipt } : validated;
	}

	public async release(
		request: AgentWorkspaceReleaseRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		if (signal?.aborted) return fail("reference_unavailable", "Agent Workspace release was aborted", true);
		if (request.requestDigest !== releaseDigest(request)) {
			return fail("workspace_invalid", "Agent Workspace release request digest is invalid");
		}
		const handle = this.#handle(request.previousReceipt, request.agentId, request.sessionId);
		if (!handle.ok) return handle;
		const envelope = this.#envelope(handle.value, request.requestId);
		const released = await this.#options.manager.release({
			schemaVersion: 1,
			kind: "release",
			requestId: request.requestId,
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			principalId: this.#options.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: createRuntimeId("trace", `agent-release-${canonicalDigest(request.requestId).slice(0, 40)}`),
			envelope,
			envelopeDigest: canonicalDigest(envelope),
			expectedLeaseRevision: request.previousReceipt.leaseRevision ?? -1,
		});
		if (!released.ok) return fail("workspace_invalid", released.error.message, released.error.retryable);
		const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
			...receiptBody(request.previousReceipt),
			status: "released",
		};
		const receipt = { ...body, receiptDigest: canonicalDigest(body) };
		this.#handles.set(request.previousReceipt.receiptId, { ...handle.value, receipt });
		return { ok: true, value: receipt };
	}
}
