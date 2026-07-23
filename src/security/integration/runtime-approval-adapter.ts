/** Runtime ApprovalCoordinatorPort -> interactive/headless ApprovalCoordinator。 */

import {
	approvalReceiptMatchesTicket,
	approvalTicketDigest,
	type ApprovalCoordinatorPort,
	type ApprovalCoordinatorRequest,
	type ApprovalCoordinatorResult,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../runtime/protocol/v3/capability.ts";
import type { ApprovalLifecycleEventPort } from "../../runtime/protocol/v3/security-events.ts";
import { ApprovalCoordinator } from "../permission/approval-coordinator.ts";
import { PendingApprovalRegistry } from "./pending-approval-registry.ts";

export interface RuntimeApprovalCoordinatorAdapterOptions {
	coordinator: ApprovalCoordinator;
	registry: PendingApprovalRegistry;
	events: ApprovalLifecycleEventPort;
}

export class RuntimeApprovalCoordinatorAdapter implements ApprovalCoordinatorPort {
	readonly #coordinator: ApprovalCoordinator;
	readonly #registry: PendingApprovalRegistry;
	readonly #events: ApprovalLifecycleEventPort;
	readonly #activeControllers = new Map<ApprovalCoordinatorRequest["ticket"]["approvalId"], AbortController>();

	public constructor(options: RuntimeApprovalCoordinatorAdapterOptions) {
		this.#coordinator = options.coordinator;
		this.#registry = options.registry;
		this.#events = options.events;
	}

	public async request(
		request: ApprovalCoordinatorRequest,
		signal?: AbortSignal,
	): Promise<ApprovalCoordinatorResult> {
		const terminal = this.#registry.terminal(request.ticket.approvalId);
		if (terminal && approvalReceiptMatchesTicket(terminal, request.ticket)) {
			return { approvalId: request.ticket.approvalId, ticketDigest: approvalTicketDigest(request.ticket), receipt: terminal };
		}
		const pending = this.#registry.read(request.ticket);
		if (!pending) throw new Error("approval request has no durable pending registry entry");
		const controller = new AbortController();
		const abort = () => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		this.#activeControllers.set(request.ticket.approvalId, controller);
		try {
			const resolved = await this.#coordinator.resolveTicket(
				request.ticket,
				pending.prompt,
				request.expectedDecisionRevision,
				() => pending.revalidate(),
				controller.signal,
			);
			if (!resolved.ok) throw new Error(resolved.error.message);
			const receipt = resolved.value;
			await this.#events.recordApprovalTerminal(request.ticket, receipt);
			this.#registry.complete(request.ticket, receipt);
			return { approvalId: request.ticket.approvalId, ticketDigest: approvalTicketDigest(request.ticket), receipt };
		} finally {
			if (this.#activeControllers.get(request.ticket.approvalId) === controller) {
				this.#activeControllers.delete(request.ticket.approvalId);
			}
			signal?.removeEventListener("abort", abort);
		}
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		const terminal = this.#registry.terminalByRequest(request)[0];
		if (terminal) {
			return {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				requestId: request.requestId,
				status: "already_terminal",
				receiptId: terminal.receiptId,
			};
		}
		const pending = this.#registry.recordsByRequest(request);
		let receiptId: SecurityPortCancelResult["receiptId"];
		let accepted = false;
		for (const record of pending) {
			const cancelled = await this.#coordinator.cancelTicket(record.ticket, request.principalId);
			if (!cancelled.ok) throw new Error(cancelled.error.message);
			this.#activeControllers.get(record.ticket.approvalId)?.abort("approval_cancelled");
			await this.#events.recordApprovalTerminal(record.ticket, cancelled.value);
			this.#registry.complete(record.ticket, cancelled.value);
			receiptId ??= cancelled.value.receiptId;
			accepted ||= cancelled.value.decision === "cancelled";
		}
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			...(receiptId === undefined
				? { status: "not_found" as const }
				: { status: accepted ? "accepted" as const : "already_terminal" as const, receiptId }),
		};
	}
}
