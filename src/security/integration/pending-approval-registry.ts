/** Gateway 与 ApprovalCoordinator adapter 共享的 pending ticket registry。 */

import { approvalTicketDigest, type ApprovalReceiptRef, type ApprovalTicket } from "../../runtime/protocol/v3/capability.ts";
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

	public terminal(approvalId: ApprovalTicket["approvalId"]): ApprovalReceiptRef | undefined {
		return this.#terminal.get(approvalId);
	}

	public complete(ticket: ApprovalTicket, receipt: ApprovalReceiptRef): boolean {
		const record = this.read(ticket);
		if (!record) return false;
		this.#records.delete(ticket.approvalId);
		this.#terminal.set(ticket.approvalId, receipt);
		return true;
	}

	public cancelByRequest(requestId: ApprovalTicket["request"]["requestId"]): readonly PendingApprovalRecord[] {
		const cancelled: PendingApprovalRecord[] = [];
		for (const [approvalId, record] of this.#records) {
			if (record.ticket.request.requestId !== requestId) continue;
			this.#records.delete(approvalId);
			cancelled.push(record);
		}
		return cancelled;
	}
}
