import {
	CapabilityDecisionReceiptSchema,
	SandboxExecutionReceiptRefSchema,
	WorkspaceExecutionEnvelopeSchema,
} from "../../../src/runtime/contracts/public.ts";
import type {
	ApprovalCoordinatorPort,
	CapabilityDecisionReceipt,
	CapabilityGatewayPort,
	SandboxExecutionPort,
	SandboxExecutionReceiptRef,
	WorkspaceExecutionEnvelope,
	WorkspaceServicePort,
} from "../../../src/runtime/contracts/public.ts";

export interface SecurityWorktreeContractConsumer {
	readonly workspaces: WorkspaceServicePort;
	readonly capabilities: CapabilityGatewayPort;
	readonly approvals: ApprovalCoordinatorPort;
	readonly sandbox: SandboxExecutionPort;
	acceptWorkspace(envelope: WorkspaceExecutionEnvelope): void;
	acceptCapabilityDecision(receipt: CapabilityDecisionReceipt): void;
	acceptSandboxReceipt(receipt: SandboxExecutionReceiptRef): void;
}

export const SECURITY_WORKTREE_SCHEMAS = [
	WorkspaceExecutionEnvelopeSchema,
	CapabilityDecisionReceiptSchema,
	SandboxExecutionReceiptRefSchema,
] as const;
