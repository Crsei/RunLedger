/** Tool 自动重试资格：manifest、调用身份、运行绑定与副作用 reconcile 缺一不可。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	CommandId,
	ReceiptId,
	SnapshotId,
	ToolCallId,
	WorkspaceId,
} from "../protocol/v3/ids.ts";

export const TOOL_RETRY_RECONCILIATION_SCHEMA_VERSION = 1 as const;

export interface ToolRetryManifestDeclaration {
	manifestDigest: string;
	idempotent: boolean;
	retrySafe: boolean;
}

export interface ToolRetryInvocationIdentity {
	requestId: CommandId;
	toolCallId: ToolCallId;
	providerToolCallId: string;
	idempotencyKey: CommandId;
	requestDigest: string;
	manifestDigest: string;
}

export interface ToolRetryRuntimeBindings {
	workspace: {
		workspaceId: WorkspaceId;
		bindingRevision: number;
		bindingDigest: string;
	};
	capability: {
		receiptId: ReceiptId;
		decisionRevision: number;
		receiptDigest: string;
	};
	resource: {
		snapshotId: SnapshotId;
		adapterGeneration: number;
		adapterGenerationDigest: string;
	};
}

export type ToolSideEffectReconciliationOutcome =
	| "definitely_not_applied"
	| "already_applied"
	| "uncertain";

export interface ToolSideEffectReconciliationReceiptBody {
	schemaVersion: typeof TOOL_RETRY_RECONCILIATION_SCHEMA_VERSION;
	receiptId: ReceiptId;
	invocationIdentityDigest: string;
	runtimeBindingsDigest: string;
	outcome: ToolSideEffectReconciliationOutcome;
	evidenceDigest: string;
	reconciledAt: string;
}

export interface ToolSideEffectReconciliationReceipt
	extends ToolSideEffectReconciliationReceiptBody {
	receiptDigest: string;
}

export type ToolRetryIneligibleReason =
	| "invalid_contract"
	| "manifest_not_idempotent"
	| "manifest_not_retry_safe"
	| "manifest_changed"
	| "invocation_identity_changed"
	| "runtime_generation_changed"
	| "reconciliation_receipt_invalid"
	| "reconciliation_identity_mismatch"
	| "side_effect_already_applied"
	| "side_effect_uncertain";

export type ToolRetryEligibility =
	| {
			allowed: true;
			invocationIdentityDigest: string;
			runtimeBindingsDigest: string;
			reconciliationReceiptDigest: string;
	  }
	| { allowed: false; reason: ToolRetryIneligibleReason };

const DIGEST = /^[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

function validDigest(value: string): boolean {
	return DIGEST.test(value);
}

function validRevision(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function validManifest(value: ToolRetryManifestDeclaration): boolean {
	return validDigest(value.manifestDigest) && (!value.retrySafe || value.idempotent);
}

function validIdentity(value: ToolRetryInvocationIdentity): boolean {
	return (
		isRuntimeId(value.requestId, "command") &&
		isRuntimeId(value.toolCallId, "toolCall") &&
		value.providerToolCallId.length > 0 &&
		value.providerToolCallId.length <= 512 &&
		isRuntimeId(value.idempotencyKey, "command") &&
		validDigest(value.requestDigest) &&
		validDigest(value.manifestDigest)
	);
}

function validBindings(value: ToolRetryRuntimeBindings): boolean {
	return (
		isRuntimeId(value.workspace.workspaceId, "workspace") &&
		validRevision(value.workspace.bindingRevision) &&
		validDigest(value.workspace.bindingDigest) &&
		isRuntimeId(value.capability.receiptId, "receipt") &&
		validRevision(value.capability.decisionRevision) &&
		validDigest(value.capability.receiptDigest) &&
		isRuntimeId(value.resource.snapshotId, "snapshot") &&
		validRevision(value.resource.adapterGeneration) &&
		validDigest(value.resource.adapterGenerationDigest)
	);
}

function reconciliationBody(
	receipt: ToolSideEffectReconciliationReceipt,
): ToolSideEffectReconciliationReceiptBody {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

export function isToolSideEffectReconciliationReceipt(
	value: ToolSideEffectReconciliationReceipt,
): boolean {
	return (
		value.schemaVersion === TOOL_RETRY_RECONCILIATION_SCHEMA_VERSION &&
		isRuntimeId(value.receiptId, "receipt") &&
		validDigest(value.invocationIdentityDigest) &&
		validDigest(value.runtimeBindingsDigest) &&
		[
			"definitely_not_applied",
			"already_applied",
			"uncertain",
		].includes(value.outcome) &&
		validDigest(value.evidenceDigest) &&
		TIMESTAMP.test(value.reconciledAt) &&
		value.receiptDigest === canonicalDigest(reconciliationBody(value))
	);
}

export function createToolSideEffectReconciliationReceipt(
	input: Omit<ToolSideEffectReconciliationReceiptBody, "schemaVersion">,
): ToolSideEffectReconciliationReceipt {
	const body: ToolSideEffectReconciliationReceiptBody = {
		...input,
		schemaVersion: TOOL_RETRY_RECONCILIATION_SCHEMA_VERSION,
	};
	const receipt = { ...body, receiptDigest: canonicalDigest(body) };
	if (!isToolSideEffectReconciliationReceipt(receipt)) {
		throw new TypeError("tool side-effect reconciliation receipt is invalid");
	}
	return receipt;
}

export function evaluateToolRetryEligibility(input: {
	manifest: ToolRetryManifestDeclaration;
	originalIdentity: ToolRetryInvocationIdentity;
	retryIdentity: ToolRetryInvocationIdentity;
	originalBindings: ToolRetryRuntimeBindings;
	currentBindings: ToolRetryRuntimeBindings;
	reconciliation: ToolSideEffectReconciliationReceipt;
}): ToolRetryEligibility {
	if (
		!validManifest(input.manifest) ||
		!validIdentity(input.originalIdentity) ||
		!validIdentity(input.retryIdentity) ||
		!validBindings(input.originalBindings) ||
		!validBindings(input.currentBindings)
	) return { allowed: false, reason: "invalid_contract" };
	if (!input.manifest.idempotent) {
		return { allowed: false, reason: "manifest_not_idempotent" };
	}
	if (!input.manifest.retrySafe) {
		return { allowed: false, reason: "manifest_not_retry_safe" };
	}
	if (
		input.manifest.manifestDigest !== input.originalIdentity.manifestDigest ||
		input.manifest.manifestDigest !== input.retryIdentity.manifestDigest
	) return { allowed: false, reason: "manifest_changed" };
	const invocationIdentityDigest = canonicalDigest(input.originalIdentity);
	if (canonicalDigest(input.retryIdentity) !== invocationIdentityDigest) {
		return { allowed: false, reason: "invocation_identity_changed" };
	}
	const runtimeBindingsDigest = canonicalDigest(input.originalBindings);
	if (canonicalDigest(input.currentBindings) !== runtimeBindingsDigest) {
		return { allowed: false, reason: "runtime_generation_changed" };
	}
	if (!isToolSideEffectReconciliationReceipt(input.reconciliation)) {
		return { allowed: false, reason: "reconciliation_receipt_invalid" };
	}
	if (
		input.reconciliation.invocationIdentityDigest !== invocationIdentityDigest ||
		input.reconciliation.runtimeBindingsDigest !== runtimeBindingsDigest
	) return { allowed: false, reason: "reconciliation_identity_mismatch" };
	if (input.reconciliation.outcome === "already_applied") {
		return { allowed: false, reason: "side_effect_already_applied" };
	}
	if (input.reconciliation.outcome === "uncertain") {
		return { allowed: false, reason: "side_effect_uncertain" };
	}
	return {
		allowed: true,
		invocationIdentityDigest,
		runtimeBindingsDigest,
		reconciliationReceiptDigest: input.reconciliation.receiptDigest,
	};
}
