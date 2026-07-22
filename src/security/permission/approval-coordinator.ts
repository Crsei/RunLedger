/** ask -> exact prompt -> immutable Runtime ApprovalReceiptRef。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
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
}

export class MemoryApprovalStateStore implements ApprovalStateStorePort {
	readonly #receipts = new Map<ApprovalTicket["approvalId"], ApprovalReceiptRef>();

	public async read(approvalId: ApprovalTicket["approvalId"]): Promise<ApprovalReceiptRef | undefined> {
		return this.#receipts.get(approvalId);
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		const current = this.#receipts.get(receipt.approvalId);
		if (current) {
			return current.receiptDigest === receipt.receiptDigest
				? { ok: true, value: current }
				: { ok: false, error: { code: "approval_stale", message: "approval already has a different terminal decision", retryable: false } };
		}
		if (expectedRevision !== 0 || receipt.decisionRevision !== 1) {
			return { ok: false, error: { code: "approval_stale", message: "approval decision revision conflict", retryable: false } };
		}
		this.#receipts.set(receipt.approvalId, receipt);
		return { ok: true, value: receipt };
	}
}

export class HeadlessDenyPrompter implements PermissionPrompter {
	readonly #principalId: PermissionPromptResponse["decidedBy"];

	public constructor(principalId: PermissionPromptResponse["decidedBy"]) {
		this.#principalId = principalId;
	}

	public async request(): Promise<PermissionPromptResponse> {
		return { decision: "deny", decidedBy: this.#principalId, reason: "interactive approval is unavailable" };
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
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ticket, decision, decidedAt }).slice(0, 48)}`),
		approvalId: ticket.approvalId,
		requestId: ticket.request.requestId,
		requestDigest: approvalTicketRequestDigest(ticket),
		ticketDigest: approvalTicketDigest(ticket),
		decision,
		decisionRevision,
		decidedAt,
		evidenceComplete: true,
		evidenceTruncated: false,
		originalInputDigest: ticket.request.argumentsDigest,
		...(ticket.expiresAt ? { expiresAt: ticket.expiresAt } : {}),
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
	fallbackPrincipalId: PermissionPromptResponse["decidedBy"];
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
	readonly #fallbackPrincipalId: PermissionPromptResponse["decidedBy"];
	readonly #pending = new Map<string, Promise<SecurityResult<AuthorizationResult>>>();

	public constructor(options: ApprovalCoordinatorOptions) {
		this.#prompter = options.prompter;
		this.#store = options.store ?? new MemoryApprovalStateStore();
		this.#clock = options.clock ?? (() => new Date());
		this.#timeoutMs = options.timeoutMs ?? 60_000;
		this.#fallbackPrincipalId = options.fallbackPrincipalId;
	}

	async #prompt(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse> {
		if (signal?.aborted) return abortResponse(this.#fallbackPrincipalId);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<PermissionPromptResponse>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(abortResponse(this.#fallbackPrincipalId));
			}, this.#timeoutMs);
		});
		try {
			return await Promise.race([
				this.#prompter.request(prompt, controller.signal).catch(() => channelFailureResponse(this.#fallbackPrincipalId)),
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
		revalidate: () => ApprovalRevalidation,
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
		revalidate: () => ApprovalRevalidation,
		signal?: AbortSignal,
	): Promise<SecurityResult<ApprovalReceiptRef>> {
		const existing = await this.#store.read(ticket.approvalId);
		if (existing) return { ok: true, value: existing };
		if (expectedDecisionRevision !== 0) {
			return { ok: false, error: { code: "approval_stale", message: "new approval must start at revision zero", retryable: false } };
		}
		let response = await this.#prompt(prompt, signal);
		const current = revalidate();
		if (
			response.decision === "allow-once" &&
			(current.argumentsDigest !== prompt.argumentsDigest || current.cwd !== prompt.cwd || current.policyDigest !== prompt.policyDigest)
		) response = { decision: "cancel", decidedBy: response.decidedBy };
		const receipt = createApprovalReceipt(ticket, response, this.#clock().toISOString());
		return this.#store.commit(receipt, expectedDecisionRevision);
	}

	public authorize(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: () => ApprovalRevalidation,
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
