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
import {
	isWorkspaceBindingRef,
	isWorkspaceLeaseRef,
	isWorkspaceReleaseReceiptRef,
	type WorkspaceBindingKind,
	type WorkspaceExecutionEnvelope,
	type WorkspaceReleaseRequest,
} from "../../protocol/v3/workspace.ts";
import type { WorktreeManager } from "../../../worktree/manager.ts";
import type { WorktreeCreateResult, WorktreeRecord } from "../../../worktree/types.ts";
import type {
	AgentErrorCode,
	AgentResult,
	AgentWorkspaceAllocateRequest,
	AgentWorkspacePort,
	AgentWorkspaceReceiptRef,
	AgentWorkspaceReleaseReceiptRef,
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

interface WorkspaceReleaseOperation {
	promise: Promise<AgentResult<AgentWorkspaceReleaseReceiptRef>>;
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

function releasedRecordMatches(
	record: WorktreeRecord,
	authorityReceipt: AgentWorkspaceReleaseReceiptRef["authorityReceipt"],
	request: WorkspaceReleaseRequest,
	previous: AgentWorkspaceReceiptRef,
): boolean {
	return (
		isWorkspaceReleaseReceiptRef(authorityReceipt) &&
		authorityReceipt.requestId === request.requestId &&
		authorityReceipt.requestDigest === canonicalDigest(request) &&
		authorityReceipt.callerRequestDigest === request.callerRequestDigest &&
		authorityReceipt.authorityId === request.authorityId &&
		authorityReceipt.tenantId === request.tenantId &&
		authorityReceipt.principalId === request.principalId &&
		authorityReceipt.sessionId === request.sessionId &&
		authorityReceipt.agentId === request.agentId &&
		authorityReceipt.workspaceId === previous.workspaceId &&
		authorityReceipt.repositoryId === previous.repositoryId &&
		authorityReceipt.envelopeDigest === request.envelopeDigest &&
		authorityReceipt.leaseId === previous.leaseId &&
		authorityReceipt.leaseRevision === previous.leaseRevision &&
		record.authorityId === request.authorityId &&
		record.tenantId === request.tenantId &&
		record.principalId === request.principalId &&
		record.sessionId === request.sessionId &&
		record.workspaceId === previous.workspaceId &&
		record.repositoryId === previous.repositoryId &&
		record.state === "retained" &&
		record.lease?.state === "released" &&
		record.lease.leaseId === previous.leaseId &&
		record.lease.leaseRevision === previous.leaseRevision &&
		authorityReceipt.releasedLeaseDigest === canonicalDigest(record.lease) &&
		authorityReceipt.retainedRecordDigest === canonicalDigest(record)
	);
}

function replayedRecordMatches(
	record: WorktreeRecord,
	authorityReceipt: AgentWorkspaceReleaseReceiptRef["authorityReceipt"],
	request: AgentWorkspaceReleaseRequest,
	options: ProductionAgentWorkspaceOptions,
): boolean {
	const previous = request.previousReceipt;
	return (
		isWorkspaceReleaseReceiptRef(authorityReceipt) &&
		authorityReceipt.requestId === request.requestId &&
		authorityReceipt.callerRequestDigest === request.requestDigest &&
		authorityReceipt.authorityId === options.authorityId &&
		authorityReceipt.tenantId === options.tenantId &&
		authorityReceipt.principalId === options.principalId &&
		authorityReceipt.sessionId === request.sessionId &&
		authorityReceipt.agentId === request.agentId &&
		authorityReceipt.workspaceId === previous.workspaceId &&
		authorityReceipt.repositoryId === previous.repositoryId &&
		authorityReceipt.leaseId === previous.leaseId &&
		authorityReceipt.leaseRevision === previous.leaseRevision &&
		record.authorityId === options.authorityId &&
		record.tenantId === options.tenantId &&
		record.principalId === options.principalId &&
		record.sessionId === request.sessionId &&
		record.workspaceId === previous.workspaceId &&
		record.repositoryId === previous.repositoryId &&
		record.state === "retained" &&
		record.lease?.state === "released" &&
		record.lease.leaseId === previous.leaseId &&
		record.lease.leaseRevision === previous.leaseRevision &&
		authorityReceipt.releasedLeaseDigest === canonicalDigest(record.lease) &&
		authorityReceipt.retainedRecordDigest === canonicalDigest(record)
	);
}

function agentReleaseReceipt(
	request: AgentWorkspaceReleaseRequest,
	authorityReceipt: AgentWorkspaceReleaseReceiptRef["authorityReceipt"],
): AgentResult<AgentWorkspaceReleaseReceiptRef> {
	const previous = request.previousReceipt;
	if (!previous.leaseId || previous.leaseRevision === undefined) {
		return fail("workspace_invalid", "Agent Workspace release lacks a durable lease correlation");
	}
	const releasedBody: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		...receiptBody(previous),
		receiptId: authorityReceipt.receiptId,
		status: "released",
		issuedAt: authorityReceipt.releasedAt,
	};
	const releasedWorkspaceReceipt: AgentWorkspaceReceiptRef = {
		...releasedBody,
		receiptDigest: canonicalDigest(releasedBody),
	};
	const body: Omit<AgentWorkspaceReleaseReceiptRef, "receiptDigest"> = {
		schemaVersion: 1,
		kind: "agent_workspace_release_receipt",
		receiptId: authorityReceipt.receiptId,
		requestId: request.requestId,
		requestDigest: request.requestDigest,
		agentId: request.agentId,
		sessionId: request.sessionId,
		workspaceId: previous.workspaceId,
		repositoryId: previous.repositoryId,
		previousReceiptId: previous.receiptId,
		previousReceiptDigest: previous.receiptDigest,
		bindingDigest: previous.bindingDigest,
		leaseId: previous.leaseId,
		leaseRevision: previous.leaseRevision,
		releasedWorkspaceReceipt,
		authorityReceipt,
		releasedAt: authorityReceipt.releasedAt,
	};
	return {
		ok: true,
		value: {
			...body,
			receiptDigest: canonicalDigest(body),
		},
	};
}

function bindingKindForStrategy(kind: AgentWorkspaceStrategyRef["kind"]): WorkspaceBindingKind {
	if (kind === "isolated_lease") return "source";
	return kind;
}

function persistedBindingDigestIsValid(binding: WorktreeCreateResult["binding"]): boolean {
	const { bindingDigest, ...body } = binding;
	return bindingDigest === canonicalDigest(body);
}

function resultHasExactScope(result: WorktreeCreateResult): boolean {
	const { record, binding, runtimeBinding, lease } = result;
	const expectedRuntimeBinding = {
		authorityId: binding.authorityId,
		tenantId: binding.tenantId,
		workspaceId: binding.workspaceId,
		repositoryId: binding.repositoryId,
		bindingKind: binding.bindingKind,
		canonicalCwd: binding.worktreePath,
		effectiveCwd: binding.effectiveCwd,
		branch: binding.branch,
		baseCommit: binding.baseCommit,
		headCommit: binding.headCommit,
		...(binding.worktreeId === undefined ? {} : { worktreeId: binding.worktreeId }),
	};
	return (
		persistedBindingDigestIsValid(binding) &&
		isWorkspaceBindingRef(runtimeBinding) &&
		canonicalDigest(runtimeBinding) === canonicalDigest(expectedRuntimeBinding) &&
		isWorkspaceLeaseRef(lease) &&
		result.fencingToken.length > 0 &&
		result.fencingToken.length <= 512 &&
		Number.isFinite(Date.parse(record.lastAccessedAt)) &&
		lease.authorityId === binding.authorityId &&
		lease.tenantId === binding.tenantId &&
		lease.principalId === binding.principalId &&
		lease.workspaceId === binding.workspaceId &&
		lease.leaseId === binding.leaseId &&
		lease.leaseRevision === binding.leaseRevision &&
		lease.ownerRuntimeId === binding.ownerRuntimeId &&
		lease.fencingTokenDigest === canonicalDigest(result.fencingToken) &&
		lease.state === "active" &&
		record.authorityId === binding.authorityId &&
		record.tenantId === binding.tenantId &&
		record.principalId === binding.principalId &&
		record.sessionId === binding.sessionId &&
		record.bindingKind === binding.bindingKind &&
		record.workspaceId === binding.workspaceId &&
		record.repositoryId === binding.repositoryId &&
		record.sourceRepo === binding.sourceRepo &&
		record.sourceCwd === binding.sourceCwd &&
		record.effectiveCwd === binding.effectiveCwd &&
		record.worktreePath === binding.worktreePath &&
		record.subdirOffset === binding.subdirOffset &&
		record.baseCommit === binding.baseCommit &&
		record.headCommit === binding.headCommit &&
		record.branch === binding.branch &&
		record.worktreeId === binding.worktreeId &&
		record.ownerRuntimeId === binding.ownerRuntimeId &&
		record.leaseRevision === binding.leaseRevision &&
		record.state === "active" &&
		record.lease !== undefined &&
		canonicalDigest(record.lease) === canonicalDigest(lease) &&
		result.receiptId === createRuntimeId(
			"receipt",
			canonicalDigest({ record, lease }).slice(0, 48),
		)
	);
}

export class ProductionAgentWorkspaceAdapter implements AgentWorkspacePort {
	readonly #options: ProductionAgentWorkspaceOptions;
	readonly #clock: () => Date;
	readonly #handles = new Map<string, PrivateWorkspaceHandle>();
	readonly #releaseRequestDigests = new Map<string, string>();
	readonly #releaseOperations = new Map<string, WorkspaceReleaseOperation>();

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
			issuedAt: result.record.lastAccessedAt,
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
			!isRuntimeId(request.strategy.strategyId, "resource") ||
			!/^[a-f0-9]{64}$/u.test(request.strategy.strategyDigest) ||
			request.agentId !== this.#options.rootAgentId ||
			request.strategy.kind !== "isolated_lease"
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
		if (!bound.ok) return fail("workspace_invalid", bound.error.message, bound.error.retryable);
		return resultHasExactScope(bound.value)
			? { ok: true, value: this.#store(request.agentId, request.sessionId, bound.value, request.strategy) }
			: fail("workspace_invalid", "root Agent Workspace result is internally inconsistent");
	}

	/**
	 * 接入父 runtime 已经完成的 production Workspace binding。raw fencing token 只存入
	 * 本 adapter 的私有 handle，不进入 Agent graph 或 composition 返回值。
	 */
	public async adoptRoot(
		request: BindRootAgentWorkspaceRequest,
		result: WorktreeCreateResult,
	): Promise<AgentResult<AgentWorkspaceReceiptRef>> {
		const binding = result.binding;
		if (
			!isRuntimeId(request.requestId, "command") ||
			!isRuntimeId(request.agentId, "agent") ||
			!isRuntimeId(request.sessionId, "session") ||
			!isRuntimeId(request.strategy.strategyId, "resource") ||
			!/^[a-f0-9]{64}$/u.test(request.strategy.strategyDigest) ||
			request.agentId !== this.#options.rootAgentId ||
			request.sessionId !== binding.sessionId ||
			binding.bindingKind !== bindingKindForStrategy(request.strategy.kind) ||
			binding.authorityId !== this.#options.authorityId ||
			binding.tenantId !== this.#options.tenantId ||
			binding.principalId !== this.#options.principalId ||
			binding.repositoryId !== this.#options.repositoryId ||
			binding.sourceRepo !== this.#options.sourceRepo ||
			binding.sourceCwd !== this.#options.sourceCwd ||
			binding.ownerRuntimeId !== this.#options.rootOwnerRuntimeId ||
			result.record.workspaceId !== binding.workspaceId ||
			result.lease.workspaceId !== binding.workspaceId ||
			result.lease.leaseId !== binding.leaseId ||
			result.lease.leaseRevision !== binding.leaseRevision ||
			result.lease.state !== "active" ||
			!resultHasExactScope(result)
		) return fail("workspace_invalid", "existing root Workspace binding is outside the production Agent scope");
		const receipt = this.#receipt(result, request.sessionId, request.strategy);
		const handle = { agentId: request.agentId, sessionId: request.sessionId, result, receipt };
		try {
			const validated = await this.#options.manager.validate(this.#envelope(handle, request.requestId));
			if (
				!validated.ok ||
				validated.value.validation.outcome !== "valid" ||
				canonicalDigest(validated.value.binding) !== canonicalDigest(binding)
			) return fail("workspace_invalid", "existing root Workspace binding is not current in the production registry");
		} catch {
			return fail("workspace_invalid", "existing root Workspace binding could not be revalidated", true);
		}
		this.#handles.set(receipt.receiptId, handle);
		return { ok: true, value: receipt };
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

	public release(
		request: AgentWorkspaceReleaseRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentWorkspaceReleaseReceiptRef>> {
		if (request.requestDigest !== releaseDigest(request)) {
			return Promise.resolve(fail("workspace_invalid", "Agent Workspace release request digest is invalid"));
		}
		const claimedDigest = this.#releaseRequestDigests.get(request.requestId);
		if (claimedDigest !== undefined && claimedDigest !== request.requestDigest) {
			return Promise.resolve(fail("idempotency_conflict", "Agent Workspace release request identity was reused"));
		}
		this.#releaseRequestDigests.set(request.requestId, request.requestDigest);
		const previous = this.#releaseOperations.get(request.requestId);
		if (previous) {
			return previous.promise;
		}
		if (signal?.aborted) {
			return Promise.resolve(fail("reference_unavailable", "Agent Workspace release was aborted", true));
		}
		const promise = this.#releaseOnce(request);
		this.#releaseOperations.set(request.requestId, { promise });
		void promise.then(
			(result) => {
				if (!result.ok && this.#releaseOperations.get(request.requestId)?.promise === promise) {
					this.#releaseOperations.delete(request.requestId);
				}
			},
			() => {
				if (this.#releaseOperations.get(request.requestId)?.promise === promise) {
					this.#releaseOperations.delete(request.requestId);
				}
			},
		);
		return promise;
	}

	async #releaseOnce(request: AgentWorkspaceReleaseRequest): Promise<AgentResult<AgentWorkspaceReleaseReceiptRef>> {
		let handle = this.#handle(request.previousReceipt, request.agentId, request.sessionId);
		if (!handle.ok) {
			if (this.#handles.has(request.previousReceipt.receiptId)) return handle;
			if (!request.previousReceipt.leaseId || request.previousReceipt.leaseRevision === undefined) {
				return fail("workspace_invalid", "Agent Workspace release lacks a durable lease correlation");
			}
			const replayed = await this.#options.manager.replayRelease({
				requestId: request.requestId,
				callerRequestDigest: request.requestDigest,
				authorityId: this.#options.authorityId,
				tenantId: this.#options.tenantId,
				principalId: this.#options.principalId,
				sessionId: request.sessionId,
				agentId: request.agentId,
				workspaceId: request.previousReceipt.workspaceId,
				leaseId: request.previousReceipt.leaseId,
				leaseRevision: request.previousReceipt.leaseRevision,
			});
			if (replayed.ok) {
				if (
					!replayedRecordMatches(
						replayed.value.record,
						replayed.value.receipt,
						request,
						this.#options,
					)
				) {
					return fail("workspace_invalid", "Workspace release replay returned uncorrelated authority evidence");
				}
				const wrapped = agentReleaseReceipt(request, replayed.value.receipt);
				return wrapped.ok
					? { ok: true, value: structuredClone(wrapped.value) }
					: wrapped;
			}
			if (replayed.error.code !== "not_found") {
				return replayed.error.code === "invalid_request"
					? fail("idempotency_conflict", "Agent Workspace release request identity was reused")
					: fail("workspace_invalid", replayed.error.message, replayed.error.retryable);
			}
			handle = await this.#rehydrateHandle(
				request.previousReceipt,
				request.agentId,
				request.sessionId,
			);
			if (!handle.ok) return handle;
		}
		const envelope = this.#envelope(handle.value, request.requestId);
		const managerRequest: WorkspaceReleaseRequest = {
			schemaVersion: 1,
			kind: "release",
			requestId: request.requestId,
			authorityId: this.#options.authorityId,
			tenantId: this.#options.tenantId,
			principalId: this.#options.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: envelope.traceId,
			envelope,
			envelopeDigest: canonicalDigest(envelope),
			callerRequestDigest: request.requestDigest,
			expectedLeaseId: handle.value.result.lease.leaseId,
			expectedLeaseRevision: request.previousReceipt.leaseRevision ?? -1,
		};
		const released = await this.#options.manager.release(managerRequest);
		if (!released.ok) return fail("workspace_invalid", released.error.message, released.error.retryable);
		if (
			!releasedRecordMatches(
				released.value.record,
				released.value.receipt,
				managerRequest,
				request.previousReceipt,
			)
		) {
			return fail("workspace_invalid", "Workspace manager returned uncorrelated release authority evidence");
		}
		const wrapped = agentReleaseReceipt(request, released.value.receipt);
		if (!wrapped.ok) return wrapped;
		this.#handles.set(request.previousReceipt.receiptId, {
			...handle.value,
			receipt: wrapped.value.releasedWorkspaceReceipt,
		});
		return { ok: true, value: structuredClone(wrapped.value) };
	}
}
