/** ask -> exact prompt -> one-shot Runtime approval receipt。 */

import {
	canonicalDigest,
	createRuntimeId,
	isApprovalReceiptRef,
	runtimeDigest,
} from "../../runtime/contracts/public.ts";
import type {
	ApprovalId,
	ApprovalReceiptRef,
	ApprovalTicket,
	PrincipalId,
	RuntimeDigest,
} from "../../runtime/contracts/public.ts";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	PermissionPrompt,
	PermissionPromptResponse,
	PermissionPrompter,
	SecurityAccessEvaluation,
	SecurityResult,
} from "../types.ts";

export const SYSTEM_APPROVAL_PRINCIPAL_ID = createRuntimeId("principal", "runledger-system-approval");

export interface ApprovalStateStorePort {
	read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined>;
	commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>>;
}

export class MemoryApprovalStateStore implements ApprovalStateStorePort {
	readonly #receipts = new Map<ApprovalId, ApprovalReceiptRef>();

	public async read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined> {
		const receipt = this.#receipts.get(approvalId);
		return receipt ? structuredClone(receipt) : undefined;
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		if (!isApprovalReceiptRef(receipt)) return failure("approval receipt failed Runtime validation", "approval_stale");
		const current = this.#receipts.get(receipt.approvalId);
		const currentRevision = current?.decisionRevision ?? 0;
		if (currentRevision !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) {
			return failure("approval receipt CAS conflict", "approval_stale");
		}
		if (current && (
			current.requestDigest.digest !== receipt.requestDigest.digest ||
			current.scope !== receipt.scope ||
			current.principalId !== receipt.principalId
		)) return failure("approval receipt binding changed", "approval_stale");
		const stored = structuredClone(receipt);
		this.#receipts.set(receipt.approvalId, stored);
		return { ok: true, value: structuredClone(stored) };
	}
}

export interface ApprovalCoordinatorOptions {
	readonly prompter: PermissionPrompter;
	readonly store?: ApprovalStateStorePort;
	readonly clock?: () => Date;
	readonly timeoutMs?: number;
}

export interface ApprovalRevalidation {
	readonly argumentsDigest: RuntimeDigest;
	readonly cwd: string;
	readonly policyDigest: RuntimeDigest;
}

export type ApprovalRevalidationPort = () => ApprovalRevalidation | Promise<ApprovalRevalidation>;

type PromptRace =
	| { readonly kind: "response"; readonly response: PermissionPromptResponse }
	| { readonly kind: "abort" }
	| { readonly kind: "timeout" }
	| { readonly kind: "channel" };

function failure(message: string, code: "approval_stale" | "approval_cancelled" | "approval_expired"): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function requestDigest(request: AuthorizationRequest): RuntimeDigest {
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

function promptSummary(request: AuthorizationRequest): string {
	const summary = request.requests.map((item) => {
		switch (item.kind) {
			case "filesystem": return `${item.operation} filesystem target`;
			case "shell": return `shell command (${item.analysis})`;
			case "network": return `${item.operation} network host ${item.host}`;
			case "worktree": return `worktree ${item.operation}`;
			case "tool": return `tool ${item.toolName}`;
		}
	}).join(", ");
	return `${request.toolName}: ${summary}`.slice(0, 512);
}

function createTicket(request: AuthorizationRequest, now: Date, timeoutMs: number): ApprovalTicket {
	const digest = requestDigest(request);
	const approvalId = createRuntimeId("approval", `tool-${digest.digest.slice(0, 48)}`);
	return {
		approvalId,
		requestDigest: digest,
		scope: "once",
		status: "pending",
		principalId: request.workspace.principalId,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
	};
}

function approvalDecision(response: PermissionPromptResponse, reason: "timeout" | "abort" | "channel" | "response"): ApprovalReceiptRef["decision"] {
	if (reason === "timeout") return "expired";
	if (reason === "abort" || reason === "channel") return "cancelled";
	if (response.decision === "allow-once") return "allowed";
	if (response.decision === "deny") return "denied";
	return "cancelled";
}

export function createApprovalReceipt(
	ticket: ApprovalTicket,
	response: PermissionPromptResponse,
	reason: "timeout" | "abort" | "channel" | "response" = "response",
	decidedAt = new Date().toISOString(),
	): ApprovalReceiptRef {
	const principalId = reason === "response" ? response.decidedBy : SYSTEM_APPROVAL_PRINCIPAL_ID;
	const decision = approvalDecision(response, reason);
	const body: Omit<ApprovalReceiptRef, "receiptId" | "receiptDigest"> = {
		approvalId: ticket.approvalId,
		requestDigest: ticket.requestDigest,
		scope: ticket.scope,
		decision,
		decisionRevision: 1,
		principalId,
		decidedAt,
		expiresAt: ticket.expiresAt,
	};
	const receiptDigest = runtimeDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ...body, receiptDigest }).slice(0, 48)}`),
		receiptDigest,
	};
}

export function createApprovalSupersessionReceipt(
	current: ApprovalReceiptRef,
	decision: Extract<ApprovalReceiptRef["decision"], "expired" | "revoked" | "cancelled" | "denied">,
	decidedAt: string,
	principalId: PrincipalId = SYSTEM_APPROVAL_PRINCIPAL_ID,
): ApprovalReceiptRef {
	const body: Omit<ApprovalReceiptRef, "receiptId" | "receiptDigest"> = {
		approvalId: current.approvalId,
		requestDigest: current.requestDigest,
		scope: current.scope,
		decision,
		decisionRevision: current.decisionRevision + 1,
		principalId,
		decidedAt,
		expiresAt: current.expiresAt,
	};
	const receiptDigest = runtimeDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ...body, receiptDigest }).slice(0, 48)}`),
		receiptDigest,
	};
}

export class HeadlessDenyPrompter implements PermissionPrompter {
	public async request(_prompt: PermissionPrompt, _signal?: AbortSignal): Promise<PermissionPromptResponse> {
		return { decision: "deny", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID, reason: "approval channel is headless" };
	}
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
		this.#timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
	}

	public authorize(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: ApprovalRevalidationPort,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		if (evaluation.decision === "deny") return Promise.resolve({ ok: true, value: { outcome: "deny", decisionSource: "builtin", requests: request.requests, policyDigest: request.snapshot.policyDigest, reason: evaluation.reason } });
		if (evaluation.decision === "allow") return Promise.resolve({ ok: true, value: { outcome: "allow", decisionSource: "builtin", requests: request.requests, policyDigest: request.snapshot.policyDigest, reason: evaluation.reason } });
		const key = `${request.sessionId}/${request.toolCallId}`;
		const existing = this.#pending.get(key);
		if (existing) return existing;
		const pending = this.#coordinate(request, evaluation, revalidate, signal);
		this.#pending.set(key, pending);
		void pending.finally(() => {
			if (this.#pending.get(key) === pending) this.#pending.delete(key);
		});
		return pending;
	}

	async #racePrompt(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PromptRace> {
		if (signal?.aborted) return { kind: "abort" };
		const controller = new AbortController();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const abort = new Promise<PromptRace>((resolve) => {
			abortListener = () => {
				controller.abort(signal?.reason);
				resolve({ kind: "abort" });
			};
			signal?.addEventListener("abort", abortListener, { once: true });
		});
		const timeout = new Promise<PromptRace>((resolve) => {
			timeoutId = setTimeout(() => {
				controller.abort("approval timeout");
				resolve({ kind: "timeout" });
			}, this.#timeoutMs);
		});
		const promptResult = this.#prompter.request(prompt, controller.signal)
			.then((response): PromptRace => ({ kind: "response", response }))
			.catch((): PromptRace => ({ kind: "channel" }));
		const result = await Promise.race([promptResult, abort, timeout]);
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		if (abortListener && signal) signal.removeEventListener("abort", abortListener);
		if (result.kind !== "response") controller.abort(result.kind);
		return result;
	}

	async #coordinate(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: ApprovalRevalidationPort,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		const ticket = createTicket(request, this.#clock(), this.#timeoutMs);
		const prompt: PermissionPrompt = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			summary: promptSummary(request),
			requests: request.requests,
			argumentsDigest: request.argumentsDigest,
			cwd: request.cwd,
			policyDigest: request.snapshot.policyDigest,
			createdAt: ticket.createdAt,
			expiresAt: ticket.expiresAt ?? ticket.createdAt,
		};
		const raced = await this.#racePrompt(prompt, signal);
		const response: PermissionPromptResponse = raced.kind === "response"
			? raced.response
			: { decision: raced.kind === "timeout" ? "cancel" : "cancel", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID };
		if (raced.kind === "response" && response.decision === "allow-once") {
			let current: ApprovalRevalidation;
			try {
				current = await revalidate();
			} catch {
				return this.#commitDenied(ticket, response, "abort", "approval revalidation failed");
			}
			if (current.argumentsDigest.digest !== request.argumentsDigest.digest || current.cwd !== request.cwd || current.policyDigest.digest !== request.snapshot.policyDigest.digest) {
				return this.#commitDenied(ticket, response, "abort", "approval binding changed before execution");
			}
		}
		const receipt = createApprovalReceipt(ticket, response, raced.kind === "response" ? "response" : raced.kind, this.#clock().toISOString());
		const committed = await this.#store.commit(receipt, 0);
		if (!committed.ok) return committed;
		const outcome = committed.value.decision === "allowed" ? "allow" : "deny";
		return {
			ok: true,
			value: {
				outcome,
				decisionSource: "approval",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				approval: committed.value,
				reason: outcome === "allow" ? evaluation.reason : `approval ${committed.value.decision}`,
			},
		};
	}

	async #commitDenied(
		ticket: ApprovalTicket,
		response: PermissionPromptResponse,
		reason: "abort" | "timeout" | "channel",
		message: string,
	): Promise<SecurityResult<AuthorizationResult>> {
		const receipt = createApprovalReceipt(ticket, response, reason, this.#clock().toISOString());
		const committed = await this.#store.commit(receipt, 0);
		if (!committed.ok) return committed;
		return {
			ok: true,
			value: {
				outcome: "deny",
				decisionSource: "approval",
				requests: [],
				policyDigest: ticket.requestDigest,
				approval: committed.value,
				reason: message,
			},
		};
	}
}
