/** Gateway 与 ApprovalCoordinator adapter 共享的 pending ticket registry。 */

import { approvalTicketDigest, type ApprovalReceiptRef, type ApprovalTicket } from "../../runtime/protocol/v3/capability.ts";
import type { SecurityPortCancelRequest } from "../../runtime/protocol/v3/capability.ts";
import type { ApprovalRevalidation } from "../permission/approval-coordinator.ts";
import type { PermissionPrompt } from "../types.ts";

export interface PendingApprovalRecord {
	ticket: ApprovalTicket;
	prompt: PermissionPrompt;
	revalidate(): Promise<ApprovalRevalidation>;
}

export class PendingApprovalRegistry {
	readonly #records = new Map<ApprovalTicket["approvalId"], PendingApprovalRecord>();
	readonly #terminal = new Map<ApprovalTicket["approvalId"], ApprovalReceiptRef>();

	public register(record: PendingApprovalRecord): boolean {
		const existing = this.#records.get(record.ticket.approvalId);
		if (existing) return approvalTicketDigest(existing.ticket) === approvalTicketDigest(record.ticket);
		if (this.#terminal.has(record.ticket.approvalId)) return false;
		this.#records.set(record.ticket.approvalId, record);
		return true;
	}

	public read(ticket: ApprovalTicket): PendingApprovalRecord | undefined {
		const record = this.#records.get(ticket.approvalId);
		return record && approvalTicketDigest(record.ticket) === approvalTicketDigest(ticket) ? record : undefined;
	}

	public remove(ticket: ApprovalTicket): boolean {
		const record = this.read(ticket);
		if (!record) return false;
		this.#records.delete(ticket.approvalId);
		return true;
	}

	public terminal(approvalId: ApprovalTicket["approvalId"]): ApprovalReceiptRef | undefined {
		return this.#terminal.get(approvalId);
	}

	public recordsByRequest(request: SecurityPortCancelRequest): readonly PendingApprovalRecord[] {
		return [...this.#records.values()].filter((record) =>
			record.ticket.authorityId === request.authorityId &&
			record.ticket.tenantId === request.tenantId &&
			record.ticket.principalId === request.principalId &&
			record.ticket.request.requestId === request.requestId
		);
	}

	public terminalByRequest(request: SecurityPortCancelRequest): readonly ApprovalReceiptRef[] {
		return [...this.#terminal.values()].filter((receipt) =>
			receipt.authorityId === request.authorityId &&
			receipt.tenantId === request.tenantId &&
			receipt.principalId === request.principalId &&
			receipt.requestId === request.requestId
		);
	}

	public complete(ticket: ApprovalTicket, receipt: ApprovalReceiptRef): boolean {
		const record = this.read(ticket);
		if (!record) return false;
		this.#records.delete(ticket.approvalId);
		this.#terminal.set(ticket.approvalId, receipt);
		return true;
	}

}
