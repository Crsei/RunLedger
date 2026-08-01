/** Compaction checkpoint 的被动公共合同。 */

import type { RuntimeEventRangeRef } from "../../protocol/events.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../../protocol/foundation.ts";
import type { SessionId, SnapshotId } from "../../protocol/ids.ts";

export type CompactionReason = "manual" | "auto" | "overflow" | "model_switch";
export type CompactionStatus = "planned" | "started" | "completed" | "failed";

export interface CompactionCheckpoint {
	readonly compactionId: SnapshotId;
	readonly sessionId: SessionId;
	readonly reason: CompactionReason;
	readonly status: CompactionStatus;
	readonly sourceRange: RuntimeEventRangeRef;
	readonly replacementArtifactRef?: RuntimeContentRef;
	readonly invariantDigest: RuntimeDigest;
	readonly attempt: number;
	readonly terminalReceiptRef?: RuntimeContentRef;
	readonly projectionDigest: RuntimeDigest;
	readonly completeness: "complete" | "partial";
	readonly createdAt: string;
}
