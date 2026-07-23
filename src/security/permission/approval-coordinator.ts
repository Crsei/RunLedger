/** ask -> exact prompt -> immutable Runtime ApprovalReceiptRef。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	approvalReceiptMatchesTicket,
	isApprovalReceiptRef,
	type ApprovalReceiptRef,
	type ApprovalTicket,
	type CapabilityName,
} from "../../runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import { workspaceExecutionEnvelopeDigest } from "../../runtime/protocol/v3/workspace.ts";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	PermissionPrompt,
	PermissionPromptResponse,
	PermissionPrompter,
	SecurityAccessEvaluation,
	SecurityResult,
} from "../types.ts";

export interface ApprovalStateStorePort {
	read(approvalId: ApprovalTicket["approvalId"]): Promise<ApprovalReceiptRef | undefined>;
	commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>>;
	/**
	 * 与 commit 共用 approval identity lock。operation 返回前，exact allowed
	 * receipt 不可能被 revoke/expire revision 抢占。
	 */
	withCurrentApproval<T>(
		receipt: ApprovalReceiptRef,
		operation: () => Promise<T>,
	): Promise<SecurityResult<T>>;
}

/** 自动超时、通道失败和到期转换的稳定审计主体，不能冒充被授权 principal。 */
export const SYSTEM_APPROVAL_PRINCIPAL_ID = createRuntimeId("principal", "runledger-system-approval");

export type ApprovalStateCommitDisposition = "apply" | "idempotent";

function approvalStale(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "approval_stale", message, retryable: false } };
}

function sameApprovalBinding(current: ApprovalReceiptRef, next: ApprovalReceiptRef): boolean {
	return (
		current.authorityId === next.authorityId &&
		current.tenantId === next.tenantId &&
		current.principalId === next.principalId &&
		current.approvalId === next.approvalId &&
		current.requestId === next.requestId &&
		current.requestDigest === next.requestDigest &&
		current.ticketDigest === next.ticketDigest &&
		current.expiresAt === next.expiresAt &&
		current.evidenceComplete === next.evidenceComplete &&
		current.evidenceTruncated === next.evidenceTruncated &&
		current.originalInputDigest === next.originalInputDigest &&
		current.originalArtifactId === next.originalArtifactId &&
		current.originalArtifactDigest === next.originalArtifactDigest
	);
}

function exactCurrentApproval(
	current: ApprovalReceiptRef | undefined,
	receipt: ApprovalReceiptRef,
): SecurityResult<ApprovalReceiptRef> {
	if (
		!isApprovalReceiptRef(receipt) || receipt.decision !== "allowed" ||
		current === undefined || !isApprovalReceiptRef(current) || current.decision !== "allowed" ||
		current.approvalId !== receipt.approvalId || current.receiptId !== receipt.receiptId ||
		current.decisionRevision !== receipt.decisionRevision || current.receiptDigest !== receipt.receiptDigest
	) return approvalStale("approval receipt is no longer the exact current allowed revision");
	return { ok: true, value: current };
}

/** Approval receipt 的共享 expected-revision CAS 与合法 supersession 校验。 */
export function validateApprovalStateCommit(
	current: ApprovalReceiptRef | undefined,
	receipt: ApprovalReceiptRef,
	expectedRevision: number,
): SecurityResult<ApprovalStateCommitDisposition> {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !isApprovalReceiptRef(receipt)) {
		return approvalStale("approval decision or expected revision is invalid");
	}
	if (current === undefined) {
		return expectedRevision === 0 && receipt.decisionRevision === 1 && receipt.decision !== "revoked"
			? { ok: true, value: "apply" }
			: approvalStale("new approval must start at a non-revoked revision one from expected revision zero");
	}
	if (!isApprovalReceiptRef(current)) return approvalStale("current approval state is invalid");
	if (
		current.receiptDigest === receipt.receiptDigest &&
		current.decisionRevision === receipt.decisionRevision &&
		expectedRevision === receipt.decisionRevision - 1
	) return { ok: true, value: "idempotent" };
	if (expectedRevision !== current.decisionRevision) {
		return approvalStale("approval expected revision is stale");
	}
	if (receipt.decisionRevision !== current.decisionRevision + 1) {
		return approvalStale("approval decision revision must advance exactly once");
	}
	if (!sameApprovalBinding(current, receipt)) {
		return approvalStale("approval supersession changed immutable request binding or evidence");
	}
	if (current.decision !== "allowed" || (receipt.decision !== "revoked" && receipt.decision !== "expired")) {
		return approvalStale("only an allowed approval may be revoked or expired");
	}
	if (Date.parse(receipt.decidedAt) < Date.parse(current.decidedAt)) {
		return approvalStale("approval supersession time precedes the current decision");
	}
	if (
		receipt.decision === "revoked" &&
		(receipt.revokedAt === undefined || Date.parse(receipt.revokedAt) < Date.parse(current.decidedAt))
	) {
		return approvalStale("approval revocation time precedes the allowed decision");
	}
	if (
		receipt.decision === "expired" &&
		(receipt.expiresAt === undefined || Date.parse(receipt.decidedAt) < Date.parse(receipt.expiresAt))
	) return approvalStale("approval expiry precedes its bound expiration time");
	return { ok: true, value: "apply" };
}

export class MemoryApprovalStateStore implements ApprovalStateStorePort {
	readonly #receipts = new Map<ApprovalTicket["approvalId"], ApprovalReceiptRef>();
	readonly #identityTails = new Map<ApprovalTicket["approvalId"], Promise<void>>();

	async #lockIdentity<T>(approvalId: ApprovalTicket["approvalId"], operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#identityTails.get(approvalId) ?? Promise.resolve();
		let release: () => void = () => undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = predecessor.then(() => current);
		this.#identityTails.set(approvalId, tail);
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
			if (this.#identityTails.get(approvalId) === tail) this.#identityTails.delete(approvalId);
		}
	}

	public async read(approvalId: ApprovalTicket["approvalId"]): Promise<ApprovalReceiptRef | undefined> {
		const receipt = this.#receipts.get(approvalId);
		return receipt === undefined ? undefined : structuredClone(receipt);
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		return this.#lockIdentity(receipt.approvalId, async () => {
			const current = this.#receipts.get(receipt.approvalId);
			const validation = validateApprovalStateCommit(current, receipt, expectedRevision);
			if (!validation.ok) return validation;
			if (validation.value === "idempotent" && current) return { ok: true, value: structuredClone(current) };
			const stored = structuredClone(receipt);
			this.#receipts.set(receipt.approvalId, stored);
			return { ok: true, value: structuredClone(stored) };
		});
	}

	public async withCurrentApproval<T>(
		receipt: ApprovalReceiptRef,
		operation: () => Promise<T>,
	): Promise<SecurityResult<T>> {
		if (!isApprovalReceiptRef(receipt)) return approvalStale("approval receipt is invalid");
		return this.#lockIdentity(receipt.approvalId, async () => {
			const validation = exactCurrentApproval(this.#receipts.get(receipt.approvalId), receipt);
			if (!validation.ok) return validation;
			return { ok: true, value: await operation() };
		});
	}
}

export class HeadlessDenyPrompter implements PermissionPrompter {
	public async request(): Promise<PermissionPromptResponse> {
		return {
			decision: "deny",
			decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID,
			reason: "interactive approval is unavailable",
		};
	}
}

function capabilityFor(evaluation: SecurityAccessEvaluation): CapabilityName {
	if (evaluation.capability) return evaluation.capability;
	const kinds = new Set(evaluation.requests.map((request) => request.kind));
	if (kinds.has("credential")) return "credential";
	if (kinds.has("network")) return "network";
	if (kinds.has("shell")) return "process";
	if (evaluation.requests.some((request) => request.kind === "filesystem" && request.operation !== "read")) return "workspace_write";
	return "repository_read";
}

export function createApprovalReceipt(
	ticket: ApprovalTicket,
	response: PermissionPromptResponse,
	decidedAt: string,
	decisionRevision = 1,
): ApprovalReceiptRef {
	const decision = response.decision === "allow-once"
		? "allowed" as const
		: response.decision === "deny"
			? "denied" as const
			: response.decision === "follow-up-replacement"
				? "follow_up_replaced" as const
				: response.decision === "channel-failure"
					? "channel_failed" as const
					: "cancelled" as const;
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		authorityId: ticket.authorityId,
		tenantId: ticket.tenantId,
		principalId: ticket.principalId,
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ticket, decision, decidedBy: response.decidedBy, decidedAt }).slice(0, 48)}`),
		approvalId: ticket.approvalId,
		requestId: ticket.request.requestId,
		requestDigest: approvalTicketRequestDigest(ticket),
		ticketDigest: approvalTicketDigest(ticket),
		decision,
		decisionRevision,
		decidedBy: response.decidedBy,
		decidedAt,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: ticket.request.argumentsDigest,
		...(ticket.expiresAt ? { expiresAt: ticket.expiresAt } : {}),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

export function createApprovalSupersessionReceipt(
	current: ApprovalReceiptRef,
	decision: "expired" | "revoked",
	decidedAt: string,
	decidedBy: ApprovalReceiptRef["decidedBy"],
): ApprovalReceiptRef {
	if (!isApprovalReceiptRef(current) || current.decision !== "allowed") {
		throw new TypeError("only an exact allowed approval may be superseded");
	}
	const {
		receiptDigest: _receiptDigest,
		receiptId: _receiptId,
		decision: _decision,
		decisionRevision: _decisionRevision,
		decidedAt: _decidedAt,
		revokedAt: _revokedAt,
		...binding
	} = current;
	const decisionRevision = current.decisionRevision + 1;
	const receiptId = createRuntimeId("receipt", `approval-${canonicalDigest({
		previousReceiptDigest: current.receiptDigest,
		decision,
		decisionRevision,
		decidedBy,
		decidedAt,
	}).slice(0, 48)}`);
	const body: Omit<ApprovalReceiptRef, "receiptDigest"> = {
		...binding,
		receiptId,
		decision,
		decisionRevision,
		decidedBy,
		decidedAt,
		...(decision === "revoked" ? { revokedAt: decidedAt } : {}),
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function abortResponse(principalId: PermissionPromptResponse["decidedBy"]): PermissionPromptResponse {
	return { decision: "cancel", decidedBy: principalId };
}

function channelFailureResponse(principalId: PermissionPromptResponse["decidedBy"]): PermissionPromptResponse {
	return { decision: "channel-failure", decidedBy: principalId };
}

export interface ApprovalCoordinatorOptions {
	prompter: PermissionPrompter;
	store?: ApprovalStateStorePort;
	clock?: () => Date;
	timeoutMs?: number;
	/** @deprecated 自动决策始终归属于 SYSTEM_APPROVAL_PRINCIPAL_ID。 */
	fallbackPrincipalId?: PermissionPromptResponse["decidedBy"];
}

export interface ApprovalRevalidation {
	argumentsDigest: string;
	cwd: string;
	policyDigest: string;
}

export class ApprovalCoordinator {
	readonly #prompter: PermissionPrompter;
	readonly #store: ApprovalStateStorePort;
	readonly #clock: () => Date;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Promise<SecurityResult<AuthorizationResult>>>();

	public constructor(options: ApprovalCoordinatorOptions) {
		this.#prompter = options.prompter;
		this.#store = options.store ?? new MemoryApprovalStateStore();
		this.#clock = options.clock ?? (() => new Date());
		this.#timeoutMs = options.timeoutMs ?? 60_000;
	}

	async #prompt(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse> {
		if (signal?.aborted) return abortResponse(SYSTEM_APPROVAL_PRINCIPAL_ID);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<PermissionPromptResponse>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(abortResponse(SYSTEM_APPROVAL_PRINCIPAL_ID));
			}, this.#timeoutMs);
		});
		try {
			return await Promise.race([
				this.#prompter.request(prompt, controller.signal).catch(() => channelFailureResponse(SYSTEM_APPROVAL_PRINCIPAL_ID)),
				timeout,
			]);
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #coordinate(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: () => ApprovalRevalidation | Promise<ApprovalRevalidation>,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		const createdAt = this.#clock().toISOString();
		const expiresAt = new Date(this.#clock().getTime() + this.#timeoutMs).toISOString();
		const capability = capabilityFor(evaluation);
		const approvalId = createRuntimeId("approval", `tool-${canonicalDigest({
			requestId: request.requestId,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			capability,
			argumentsDigest: request.argumentsDigest,
			policyDigest: request.snapshot.policyDigest,
		}).slice(0, 48)}`);
		const capabilityRequest = {
			authorityId: request.workspace.authorityId,
			tenantId: request.workspace.tenantId,
			principalId: request.workspace.principalId,
			requestId: request.requestId,
			approvalId,
			sessionId: request.sessionId,
			runtimeId: request.workspace.ownerRuntimeId,
			runtimeGeneration: request.workspace.leaseRevision,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			capability,
			argumentsDigest: request.argumentsDigest,
			workspaceEnvelopeDigest: workspaceExecutionEnvelopeDigest(request.workspace),
			policyDigest: request.snapshot.policyDigest,
			serverScope: "tool_server" as const,
			resourceScopeDigest: canonicalDigest({ toolName: request.toolName, capability }),
			commandScopeDigest: canonicalDigest({ requestId: request.requestId, argumentsDigest: request.argumentsDigest }),
		};
		const ticket: ApprovalTicket = {
			authorityId: request.workspace.authorityId,
			tenantId: request.workspace.tenantId,
			principalId: request.workspace.principalId,
			approvalId,
			request: capabilityRequest,
			scope: "once",
			createdAt,
			expiresAt,
		};
		const prompt: PermissionPrompt = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			summary: evaluation.reason.slice(0, 512),
			requests: request.requests,
			argumentsDigest: request.argumentsDigest,
			cwd: request.cwd,
			policyDigest: request.snapshot.policyDigest,
			createdAt,
			expiresAt,
		};
		const stored = await this.resolveTicket(ticket, prompt, 0, revalidate, signal);
		if (!stored.ok) return stored;
		return {
			ok: true,
			value: {
				outcome: stored.value.decision === "allowed" ? "allow" : "deny",
				decisionSource: "approval",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				approval: stored.value,
				reason: stored.value.decision === "allowed" ? "exact request approved once" : `approval ${stored.value.decision}`,
			},
		};
	}

	public async resolveTicket(
		ticket: ApprovalTicket,
		prompt: PermissionPrompt,
		expectedDecisionRevision: number,
		revalidate: () => ApprovalRevalidation | Promise<ApprovalRevalidation>,
		signal?: AbortSignal,
	): Promise<SecurityResult<ApprovalReceiptRef>> {
		const existing = await this.#store.read(ticket.approvalId);
		if (existing) {
			if (!approvalReceiptMatchesTicket(existing, ticket)) {
				return { ok: false, error: { code: "approval_stale", message: "stored approval is not bound to the current ticket", retryable: false } };
			}
			if (existing.decision === "allowed" && existing.expiresAt !== undefined && Date.parse(existing.expiresAt) <= this.#clock().getTime()) {
				return { ok: false, error: { code: "approval_stale", message: "stored approval has expired", retryable: false } };
			}
			return { ok: true, value: existing };
		}
		if (expectedDecisionRevision !== 0) {
			return { ok: false, error: { code: "approval_stale", message: "new approval must start at revision zero", retryable: false } };
		}
		let response = await this.#prompt(prompt, signal);
		const current = await revalidate();
		if (
			response.decision === "allow-once" &&
			(current.argumentsDigest !== prompt.argumentsDigest || current.cwd !== prompt.cwd || current.policyDigest !== prompt.policyDigest)
		) response = { decision: "cancel", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID };
		const receipt = createApprovalReceipt(ticket, response, this.#clock().toISOString());
		return this.#store.commit(receipt, expectedDecisionRevision);
	}

	public async cancelTicket(
		ticket: ApprovalTicket,
		decidedBy: PermissionPromptResponse["decidedBy"],
	): Promise<SecurityResult<ApprovalReceiptRef>> {
		const existing = await this.#store.read(ticket.approvalId);
		if (existing) {
			return approvalReceiptMatchesTicket(existing, ticket)
				? { ok: true, value: existing }
				: { ok: false, error: { code: "approval_stale", message: "stored approval is not bound to the cancelled ticket", retryable: false } };
		}
		const receipt = createApprovalReceipt(
			ticket,
			{ decision: "cancel", decidedBy },
			this.#clock().toISOString(),
		);
		const committed = await this.#store.commit(receipt, 0);
		if (committed.ok) return committed;
		const winner = await this.#store.read(ticket.approvalId);
		return winner && approvalReceiptMatchesTicket(winner, ticket)
			? { ok: true, value: winner }
			: committed;
	}

	public authorize(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: () => ApprovalRevalidation | Promise<ApprovalRevalidation>,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		if (evaluation.decision !== "ask") {
			return Promise.resolve({
				ok: true,
				value: {
					outcome: evaluation.decision === "allow" ? "allow" : "deny",
					decisionSource: evaluation.requestDecisions[0]?.source ?? "fallback",
					requests: request.requests,
					policyDigest: request.snapshot.policyDigest,
					reason: evaluation.reason,
				},
			});
		}
		const key = `${request.sessionId}/${request.toolCallId}`;
		const pending = this.#pending.get(key);
		if (pending) return pending;
		const created = this.#coordinate(request, evaluation, revalidate, signal).finally(() => {
			this.#pending.delete(key);
		});
		this.#pending.set(key, created);
		return created;
	}
}
