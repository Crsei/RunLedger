/** Session durable compact record：公开 checkpoint + 有界的恢复元数据。 */
import type { CompactionCheckpoint } from "./types.ts";
import { isCompactionCheckpoint } from "./schema.ts";
import { isCompactionInvariantDigestValid } from "../invariants.ts";
import type { RuntimeDigest } from "../../protocol/foundation.ts";
import { isRuntimeDigest } from "../../protocol/foundation-schemas.ts";
import { isRuntimeId, type AttemptId, type CommandId } from "../../protocol/ids.ts";
import type { TraceArtifactRef } from "../../trace/types.ts";
import type { CompactionStrategyKey } from "./strategy.ts";
import type { SummaryUsage } from "./budgeted-model.ts";

export const COMPACTION_RECORD_SCHEMA = "runledger.session-compaction";
export interface CompactionRecord {
	readonly schema: typeof COMPACTION_RECORD_SCHEMA;
	readonly checkpoint: CompactionCheckpoint;
	readonly revision: number;
	readonly requestId: string;
	readonly requestDigest: RuntimeDigest;
	readonly commandId: CommandId;
	readonly attemptId: AttemptId;
	readonly strategy: CompactionStrategyKey;
	readonly replacementKind: "portable-summary" | "openai-responses-compaction";
	readonly model: { readonly provider: string; readonly id: string };
	readonly requestModel: { readonly provider: string; readonly id: string; readonly contextWindow: number };
	readonly configDigest: RuntimeDigest;
	readonly inputDigest: RuntimeDigest;
	readonly protectedStateDigest: RuntimeDigest;
	readonly prefixDigest: RuntimeDigest;
	/** 原始 provider-facing 消息前缀长度；不是压缩后数组长度。 */
	readonly count: number;
	readonly previousId?: string;
	readonly artifact?: TraceArtifactRef;
	readonly usage: SummaryUsage;
	readonly beforeTokens: number;
	readonly afterTokens?: number;
	readonly code?: string;
}

const KEYS = ["requestModel", "replacementKind", "schema", "checkpoint", "revision", "requestId", "requestDigest", "commandId", "attemptId", "strategy", "model", "configDigest", "inputDigest", "protectedStateDigest", "prefixDigest", "count", "previousId", "artifact", "usage", "beforeTokens", "afterTokens", "code"];
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function integer(value: unknown, min = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= min; }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function artifact(value: unknown): value is TraceArtifactRef {
	return object(value) && exact(value, ["storage", "artifactId", "digest", "mediaType", "size"])
		&& value.storage === "artifact" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
		&& value.artifactId === `artifact_${value.digest}` && (value.mediaType === "text/plain" || value.mediaType === "application/vnd.runledger.openai-compaction+json") && integer(value.size, 1) && value.size <= 131_072;
}

export function decodeCompactionRecord(event: { readonly eventType: string; readonly payloadJson: string; readonly sessionId: string }): CompactionRecord {
	const value: unknown = JSON.parse(event.payloadJson);
	if (!object(value) || Object.keys(value).some((key) => !KEYS.includes(key)) || value.schema !== COMPACTION_RECORD_SCHEMA
		|| !isCompactionCheckpoint(value.checkpoint) || !isCompactionInvariantDigestValid(value.checkpoint)
		|| value.checkpoint.sessionId !== event.sessionId || event.eventType !== `compaction.${value.checkpoint.status}`
		|| !["started", "completed", "failed"].includes(value.checkpoint.status)
		|| (value.replacementKind !== "portable-summary" && value.replacementKind !== "openai-responses-compaction")
		|| !integer(value.revision) || typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/u.test(value.requestId)
		|| !isRuntimeId(value.commandId, "command") || !isRuntimeId(value.attemptId, "attempt")
		|| !isRuntimeDigest(value.requestDigest) || !isRuntimeDigest(value.configDigest) || !isRuntimeDigest(value.inputDigest)
		|| !isRuntimeDigest(value.protectedStateDigest) || !isRuntimeDigest(value.prefixDigest) || !integer(value.count, 1)
		|| !object(value.strategy) || !exact(value.strategy, ["id", "version"]) || typeof value.strategy.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.strategy.id) || !integer(value.strategy.version, 1)
		|| !object(value.model) || !exact(value.model, ["provider", "id"]) || typeof value.model.provider !== "string" || typeof value.model.id !== "string"
		|| value.model.provider.length < 1 || value.model.provider.length > 128 || value.model.id.length < 1 || value.model.id.length > 256
		|| !object(value.requestModel) || !exact(value.requestModel, ["provider", "id", "contextWindow"]) || typeof value.requestModel.provider !== "string" || typeof value.requestModel.id !== "string" || !integer(value.requestModel.contextWindow, 1)
		|| !object(value.usage) || !exact(value.usage, ["input", "output", "calls"]) || !integer(value.usage.input) || !integer(value.usage.output) || !integer(value.usage.calls)
		|| !integer(value.beforeTokens) || (value.previousId !== undefined && !isRuntimeId(value.previousId, "snapshot"))
		|| (value.afterTokens !== undefined && !integer(value.afterTokens))
		|| (value.code !== undefined && (typeof value.code !== "string" || !/^[a-z0-9_]{1,80}$/u.test(value.code)))
		|| (value.artifact !== undefined && !artifact(value.artifact))) throw new Error("compaction_record_corrupt");
	if (value.checkpoint.status === "completed") {
		if (!artifact(value.artifact) || value.artifact.mediaType !== (value.replacementKind === "portable-summary" ? "text/plain" : "application/vnd.runledger.openai-compaction+json") || !integer(value.afterTokens) || value.afterTokens >= value.beforeTokens
			|| value.artifact.digest !== value.checkpoint.replacementArtifactRef?.digest.digest
			|| value.artifact.size !== value.checkpoint.replacementArtifactRef?.size || value.code !== undefined) throw new Error("compaction_artifact_binding_corrupt");
	} else if (value.artifact !== undefined || value.afterTokens !== undefined || (value.checkpoint.status === "failed" && value.code === undefined)) throw new Error("compaction_record_status_corrupt");
	return value as unknown as CompactionRecord;
}

/** fork 只继承 replacement 及来源证据，不将 source attempt 变成 target authority。 */
export interface InheritedCompaction {
	readonly schema: "runledger.compaction-inheritance";
	readonly parentSessionId: string;
	readonly parentEventId: string;
	readonly record: CompactionRecord;
}
export function decodeInheritedCompaction(payloadJson: string): InheritedCompaction {
	const value: unknown = JSON.parse(payloadJson);
	if (!object(value) || !exact(value, ["schema", "parentSessionId", "parentEventId", "record"])
		|| value.schema !== "runledger.compaction-inheritance" || !isRuntimeId(value.parentSessionId, "session") || !isRuntimeId(value.parentEventId, "event")
		|| !object(value.record) || !object(value.record.checkpoint) || typeof value.record.checkpoint.sessionId !== "string") throw new Error("compaction_inheritance_corrupt");
	const record = decodeCompactionRecord({ eventType: "compaction.completed", sessionId: value.record.checkpoint.sessionId, payloadJson: JSON.stringify(value.record) });
	return { schema: value.schema, parentSessionId: value.parentSessionId, parentEventId: value.parentEventId, record };
}
