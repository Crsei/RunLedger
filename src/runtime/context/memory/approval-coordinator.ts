import type { ApprovalReceiptRef } from "../../protocol/v3/capability.ts";
import type { MemoryProposal, MemoryProposalStatus } from "./types.ts";

type PendingMemoryProposal = MemoryProposal & { status: "pending" };
type ResolvedMemoryProposal = MemoryProposal & {
	status: Exclude<MemoryProposalStatus, "pending">;
	approvalReceipt: ApprovalReceiptRef;
};

export function resolveMemoryProposal(
	proposal: PendingMemoryProposal,
	receipt: ApprovalReceiptRef,
): ResolvedMemoryProposal {
	if (receipt.approvalId !== proposal.approvalId) throw new Error("memory approval receipt targets another proposal");
	const status = receipt.decision === "allowed" ? "approved"
		: receipt.decision === "denied" ? "rejected"
			: receipt.decision === "expired" ? "expired"
				: receipt.decision === "revoked" ? "revoked"
					: undefined;
	if (status === undefined) throw new Error("cancelled approval cannot publish or mutate memory");
	return { ...proposal, status, approvalReceipt: receipt };
}
