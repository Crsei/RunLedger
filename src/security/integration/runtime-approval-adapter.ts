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
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import { ApprovalCoordinator, createApprovalReceipt } from "../permission/approval-coordinator.ts";
import { PendingApprovalRegistry } from "./pending-approval-registry.ts";

export interface RuntimeApprovalCoordinatorAdapterOptions {
	coordinator: ApprovalCoordinator;
	registry: PendingApprovalRegistry;
	fallbackPrincipalId: ApprovalCoordinatorRequest["ticket"]["principalId"];
	clock?: () => Date;
}

export class RuntimeApprovalCoordinatorAdapter implements ApprovalCoordinatorPort {
	readonly #coordinator: ApprovalCoordinator;
	readonly #registry: PendingApprovalRegistry;
	readonly #fallbackPrincipalId: ApprovalCoordinatorRequest["ticket"]["principalId"];
	readonly #clock: () => Date;

	public constructor(options: RuntimeApprovalCoordinatorAdapterOptions) {
		this.#coordinator = options.coordinator;
		this.#registry = options.registry;
		this.#fallbackPrincipalId = options.fallbackPrincipalId;
		this.#clock = options.clock ?? (() => new Date());
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
		if (!pending) {
			const receipt = createApprovalReceipt(
				request.ticket,
				{ decision: "cancel", decidedBy: this.#fallbackPrincipalId },
				this.#clock().toISOString(),
				request.expectedDecisionRevision + 1,
			);
			return { approvalId: request.ticket.approvalId, ticketDigest: approvalTicketDigest(request.ticket), receipt };
		}
		const current = await pending.revalidate();
		const resolved = await this.#coordinator.resolveTicket(
			request.ticket,
			pending.prompt,
			request.expectedDecisionRevision,
			() => current,
			signal,
		);
		const receipt = resolved.ok
			? resolved.value
			: createApprovalReceipt(
				request.ticket,
				{ decision: "cancel", decidedBy: this.#fallbackPrincipalId },
				this.#clock().toISOString(),
				request.expectedDecisionRevision + 1,
			);
		this.#registry.complete(request.ticket, receipt);
		return { approvalId: request.ticket.approvalId, ticketDigest: approvalTicketDigest(request.ticket), receipt };
	}

	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		const cancelled = this.#registry.cancelByRequest(request.requestId);
		return {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			requestId: request.requestId,
			...(cancelled.length > 0
				? { status: "accepted" as const, receiptId: createRuntimeId("receipt", `approval-cancel-${request.requestId}`) }
				: { status: "not_found" as const }),
		};
	}
}
