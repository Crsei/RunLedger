/** Artifact、checkpoint、episode、verification、finding 与 proposal 的被动合同。 */

import type { ArtifactRef } from "../protocol/capability.ts";
import type { RuntimeEventRangeRef } from "../protocol/events.ts";
import type { RuntimeContentRef, RuntimeDigest, RuntimeStreamHead } from "../protocol/foundation.ts";
import type {
	CommandId,
	FindingId,
	ProposalId,
	ReceiptId,
	RuntimeId,
	SessionId,
	SnapshotId,
	TraceId,
} from "../protocol/ids.ts";
import type { WorkspaceCheckpointDescriptor } from "../protocol/workspace.ts";
import type { AdapterIdentityRef } from "./control-telemetry.ts";

export type ArtifactKind = ArtifactRef["kind"];

export interface ArtifactIntent {
	readonly intentId: CommandId;
	readonly subjectId: RuntimeId;
	readonly sourceDigest: RuntimeDigest;
	readonly targetKind: ArtifactKind;
	readonly retentionPolicyDigest: RuntimeDigest;
	readonly accessPolicyDigest: RuntimeDigest;
	readonly idempotencyKey: string;
	readonly traceId: TraceId;
}

export interface ArtifactCommitReceipt {
	readonly receiptId: ReceiptId;
	readonly intentId: CommandId;
	readonly artifact: ArtifactRef;
	readonly contentVerification: "verified" | "mismatch" | "unavailable";
	readonly keyAccessRef: RuntimeContentRef;
	readonly outcome: "durable" | "rejected" | "uncertain";
	readonly committedAt: string;
}

export interface ProjectionCheckpoint {
	readonly snapshotId: SnapshotId;
	readonly sourceRange: RuntimeEventRangeRef;
	readonly projectionKind: "session" | "goal" | "task" | "queue" | "agent_graph" | "resource" | "context";
	readonly projectionDigest: RuntimeDigest;
	readonly artifactRef: RuntimeContentRef;
	readonly builtAt: string;
	readonly completeness: "complete" | "partial";
}

export interface CompositeCheckpoint {
	readonly snapshotId: SnapshotId;
	readonly eventHead: RuntimeStreamHead;
	readonly workspaceCheckpoint: WorkspaceCheckpointDescriptor;
	readonly artifacts: readonly ArtifactRef[];
	readonly workspaceStatusDigest: RuntimeDigest;
	readonly dirtyCount: number;
	readonly untrackedCount: number;
	readonly conflictCount: number;
	readonly builtAt: string;
	readonly completeness: "complete" | "partial";
}

export interface EpisodeManifestBody {
	readonly sessionId: SessionId;
	readonly eventHeads: readonly RuntimeStreamHead[];
	readonly workspaceCheckpoints: readonly WorkspaceCheckpointDescriptor[];
	readonly artifacts: readonly ArtifactRef[];
	readonly permissionRefs: readonly RuntimeContentRef[];
	readonly costRefs: readonly RuntimeContentRef[];
	readonly verificationRefs: readonly RuntimeContentRef[];
	readonly retentionGraphDigest: RuntimeDigest;
	readonly createdAt: string;
}

export interface EpisodeSeal {
	readonly receiptId: ReceiptId;
	readonly manifestDigest: RuntimeDigest;
	readonly terminalEventRef: RuntimeContentRef;
	readonly signerAttestationRef: RuntimeContentRef;
	readonly verificationOutcome: "verified" | "invalid" | "unavailable";
	readonly sealedAt: string;
}

export interface VerificationRequest {
	readonly requestId: CommandId;
	readonly sessionId: SessionId;
	readonly candidateDigest: RuntimeDigest;
	readonly baselineDigest?: RuntimeDigest;
	readonly gateManifestRef: RuntimeContentRef;
	readonly runnerRequirementDigest: RuntimeDigest;
	readonly traceId: TraceId;
}

export interface VerificationResult {
	readonly receiptId: ReceiptId;
	readonly requestId: CommandId;
	readonly outcome: "pass" | "fail" | "error" | "unsupported";
	readonly runner: AdapterIdentityRef;
	readonly evidenceRefs: readonly RuntimeContentRef[];
	readonly findingIds: readonly FindingId[];
	readonly resultDigest: RuntimeDigest;
	readonly finishedAt: string;
}

export interface FindingRecord {
	readonly findingId: FindingId;
	readonly severity: "low" | "medium" | "high" | "critical";
	readonly status: "open" | "acknowledged" | "resolved" | "dismissed";
	readonly revision: number;
	readonly locationRef: RuntimeContentRef;
	readonly evidenceRefs: readonly RuntimeContentRef[];
	readonly resolutionRef?: RuntimeContentRef;
	readonly findingDigest: RuntimeDigest;
}

export interface ChangeProposal {
	readonly proposalId: ProposalId;
	readonly sessionId: SessionId;
	readonly baseDigest: RuntimeDigest;
	readonly candidateDigest: RuntimeDigest;
	readonly diffRef: RuntimeContentRef;
	readonly verificationSummaryRef: RuntimeContentRef;
	readonly requestedAction: "human_review" | "draft_pr";
	readonly proposalDigest: RuntimeDigest;
	readonly createdAt: string;
}
