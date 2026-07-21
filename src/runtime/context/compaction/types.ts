/**
 * Compaction checkpoint 的公共合同。
 *
 * TODO(runtime-phase-6): 冻结 safe cut、retained tail、summary artifact、invariant
 * digest 与 intent/commit recovery 字段；CompactionService 不在此实现。
 */

export type CompactionReason = "manual" | "auto" | "overflow" | "model_switch";
export type CompactionStatus = "planned" | "started" | "completed" | "failed";

export interface CompactionCheckpoint {
	compactionId: string;
	sessionId: string;
	reason: CompactionReason;
	status: CompactionStatus;
	cutSequence: number;
	retainedTailStart: number;
	inputArtifactRef?: string;
	summaryArtifactRef?: string;
	invariantDigest: string;
	projectionDigest: string;
	createdAt: string;
}
