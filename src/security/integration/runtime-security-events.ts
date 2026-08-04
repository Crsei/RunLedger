/** Projects security decisions into the Runtime 04 event catalog. */

import {
	createRuntimeId,
	runtimeDigest,
	type ApprovalReceiptRef,
	type ApprovalTicket,
	type AuthorityId,
	type PrincipalId,
	type RuntimeEventPayloadFor,
	type TenantId,
	type TraceId,
} from "../../runtime/contracts/public.ts";
import type { RuntimeEventAppendInput, RuntimeEventAppendResult } from "../../storage/host/runtime-event-store.ts";
import type { ApprovalAuditPort } from "../permission/approval-coordinator.ts";
import type { AuthorizationRequest } from "../types.ts";

export interface RuntimeSecurityEventWriter {
	append(input: RuntimeEventAppendInput): Promise<RuntimeEventAppendResult>;
}

export interface HostSecurityAuditAdapterOptions {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly writer: RuntimeSecurityEventWriter;
}

function ref(digest: ReturnType<typeof runtimeDigest>, mediaType: string): { subjectKind: "receipt"; digest: ReturnType<typeof runtimeDigest>; mediaType: string; size: number } {
	return { subjectKind: "receipt", digest, mediaType, size: 0 };
}

function traceFor(ticket: ApprovalTicket, suffix: string) {
	return createRuntimeId("trace", runtimeDigest({ approvalId: ticket.approvalId, revision: ticket.status, suffix }).digest.slice(0, 48));
}

export class HostSecurityAuditAdapter implements ApprovalAuditPort {
	readonly #authorityId: AuthorityId;
	readonly #tenantId: TenantId;
	readonly #writer: RuntimeSecurityEventWriter;

	public constructor(options: HostSecurityAuditAdapterOptions) {
		this.#authorityId = options.authorityId;
		this.#tenantId = options.tenantId;
		this.#writer = options.writer;
	}

	public async requested(input: { readonly request: AuthorizationRequest; readonly ticket: ApprovalTicket }): Promise<void> {
		const { request, ticket } = input;
		const traceId = traceFor(ticket, "requested");
		const payload: RuntimeEventPayloadFor<"permission.requested"> = {
			subject: { kind: "approval", id: ticket.approvalId },
			correlationId: traceId,
			effect: "none",
			idempotencyKey: `${ticket.approvalId}:requested`,
			transition: { revision: 0, previousStatus: null, nextStatus: "pending" },
			bindings: [
				{ role: "session", subjectId: request.sessionId },
				{ role: "requester", subjectId: request.workspace.principalId },
			],
			refs: [ref(ticket.requestDigest, "application/vnd.runledger.permission-request+json")],
		};
		await this.#append({ request, principalId: request.workspace.principalId, traceId, type: "permission.requested", payload });
	}

	public async decided(input: { readonly request: AuthorizationRequest; readonly ticket: ApprovalTicket; readonly receipt: ApprovalReceiptRef }): Promise<void> {
		const { request, ticket, receipt } = input;
		const type = receipt.decision === "expired" ? "permission.expired" : "permission.decided";
		const traceId = traceFor(ticket, `${type}:${receipt.decisionRevision}`);
		const nextStatus = receipt.decision;
		const base = {
			subject: { kind: "approval" as const, id: ticket.approvalId },
			correlationId: traceId,
			effect: receipt.decision === "allowed" ? "committed" as const : "none" as const,
			idempotencyKey: `${ticket.approvalId}:decision:${receipt.decisionRevision}`,
			transition: { revision: receipt.decisionRevision, previousStatus: "pending", nextStatus },
			expectedRevision: receipt.decisionRevision - 1,
			refs: [ref(receipt.receiptDigest, "application/vnd.runledger.approval-receipt+json")],
		};
		if (type === "permission.expired") {
			const payload: RuntimeEventPayloadFor<"permission.expired"> = { ...base, reasonCode: "approval_expired" };
			await this.#append({ request, principalId: receipt.principalId, traceId, type, payload });
			return;
		}
		const payload: RuntimeEventPayloadFor<"permission.decided"> = base;
		await this.#append({ request, principalId: receipt.principalId, traceId, type, payload });
	}

	public async revoked(input: { readonly request: AuthorizationRequest; readonly receipt: ApprovalReceiptRef }): Promise<void> {
		const traceId = createRuntimeId("trace", runtimeDigest({ approvalId: input.receipt.approvalId, revision: input.receipt.decisionRevision, suffix: "revoked" }).digest.slice(0, 48));
		const payload: RuntimeEventPayloadFor<"permission.revoked"> = {
			subject: { kind: "approval", id: input.receipt.approvalId },
			correlationId: traceId,
			effect: "none",
			idempotencyKey: `${input.receipt.approvalId}:revoked:${input.receipt.decisionRevision}`,
			transition: { revision: input.receipt.decisionRevision, previousStatus: "allowed", nextStatus: "revoked" },
			expectedRevision: input.receipt.decisionRevision - 1,
			reasonCode: "approval_revoked",
			refs: [ref(input.receipt.receiptDigest, "application/vnd.runledger.approval-receipt+json")],
		};
		await this.#append({ request: input.request, principalId: input.receipt.principalId, traceId, type: "permission.revoked", payload });
	}

	async #append(input: {
		readonly request: AuthorizationRequest;
		readonly principalId: PrincipalId;
		readonly traceId: TraceId;
		readonly type: RuntimeEventAppendInput["type"];
		readonly payload: RuntimeEventAppendInput["payload"];
	}): Promise<void> {
		await this.#writer.append({
			authorityId: this.#authorityId,
			tenantId: this.#tenantId,
			principalId: input.principalId,
			sessionId: input.request.sessionId,
			traceId: input.traceId,
			type: input.type,
			payload: input.payload,
		});
	}
}
