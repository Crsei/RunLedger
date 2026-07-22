import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactRef, ApprovalReceiptRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createSessionEventStreamRef, type ExpectedRevision } from "../../../src/runtime/protocol/v3/events.ts";
import type { WorkspaceBindingRef } from "../../../src/runtime/protocol/v3/workspace.ts";

export const authorityId = createRuntimeId("authority", "pcm-test");
export const tenantId = createRuntimeId("tenant", "pcm-test");
export const principalId = createRuntimeId("principal", "pcm-test");
export const sessionId = createRuntimeId("session", "pcm-test");
export const workspaceId = createRuntimeId("workspace", "pcm-test");
export const traceId = createRuntimeId("trace", "pcm-test");
export const NOW = "2026-07-22T00:00:00.000Z";
export const DIGEST = canonicalDigest("fixture");

export const expectedRevision: ExpectedRevision = {
	stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
	sequence: 0,
	eventHash: DIGEST,
};

export const workspace: WorkspaceBindingRef = {
	authorityId,
	tenantId,
	workspaceId,
	repositoryId: createRuntimeId("repository", "pcm-test"),
	bindingKind: "source",
	canonicalCwd: "/workspace",
	effectiveCwd: "/workspace",
	branch: "main",
	baseCommit: "a".repeat(40),
	headCommit: "b".repeat(40),
};

export function artifact(contentDigest = DIGEST): ArtifactRef {
	return {
		authorityId,
		tenantId,
		artifactId: createRuntimeId("artifact", `pcm-${contentDigest.slice(0, 20)}`),
		storedDigest: contentDigest,
		kind: "change_proposal",
		originalSize: 10,
		storedSize: 10,
		mediaType: "text/plain",
		redaction: "metadata_only",
		transformReceipt: createRuntimeId("receipt", `transform-${contentDigest.slice(0, 20)}`),
		workspaceId,
	};
}

export function approvalReceipt(
	approvalId = createRuntimeId("approval", "pcm-test"),
	decision: ApprovalReceiptRef["decision"] = "allowed",
): ApprovalReceiptRef {
	const base = {
		authorityId,
		tenantId,
		principalId,
		receiptId: createRuntimeId("receipt", `approval-${decision}`),
		approvalId,
		requestId: createRuntimeId("command", "approval-request"),
		requestDigest: DIGEST,
		ticketDigest: DIGEST,
		decisionRevision: 1,
		decidedAt: NOW,
		receiptDigest: DIGEST,
	};
	const incompleteEvidence = {
		evidenceComplete: false,
		evidenceTruncated: false,
		originalInputDigest: DIGEST,
	} as const;
	if (decision === "allowed") {
		return {
			...base,
			decision,
			evidenceComplete: true,
			evidenceTruncated: false,
			originalInputDigest: DIGEST,
		};
	}
	if (decision === "denied") return { ...base, ...incompleteEvidence, decision };
	if (decision === "cancelled") return { ...base, ...incompleteEvidence, decision };
	if (decision === "follow_up_replaced") return { ...base, ...incompleteEvidence, decision };
	if (decision === "channel_failed") return { ...base, ...incompleteEvidence, decision };
	if (decision === "transferred_to_human") return { ...base, ...incompleteEvidence, decision };
	if (decision === "expired") return { ...base, ...incompleteEvidence, decision, expiresAt: NOW };
	return { ...base, ...incompleteEvidence, decision, revokedAt: NOW };
}
