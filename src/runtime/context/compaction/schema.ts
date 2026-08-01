/**
 * Compaction schema guard。
 *
 * TODO(runtime-phase-6): 增加 tool batch 配对、summary validation 和 crash boundary
 * 的 golden fixtures；失败时必须保持原 projection。
 */

import type { CompactionCheckpoint } from "./types.ts";

export function isCompactionCheckpoint(value: unknown): value is CompactionCheckpoint {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.compactionId === "string" &&
		typeof candidate.sessionId === "string" &&
		(candidate.reason === "manual" ||
			candidate.reason === "auto" ||
			candidate.reason === "overflow" ||
			candidate.reason === "model_switch") &&
		(candidate.status === "planned" ||
			candidate.status === "started" ||
			candidate.status === "completed" ||
			candidate.status === "failed") &&
		typeof candidate.cutSequence === "number" &&
		typeof candidate.retainedTailStart === "number" &&
		typeof candidate.invariantDigest === "string" &&
		typeof candidate.projectionDigest === "string" &&
		typeof candidate.createdAt === "string"
	);
}
