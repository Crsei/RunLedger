/**
 * R5:safe checkpoint cache(06 §7.2)。
 *
 * - 首版只支持六个 boundary:before_model / after_model / before_tool /
 *   after_tool / turn_completed / paused;
 * - snapshot 绑定 sessionId + ownerGeneration + sourceSequence + snapshotDigest;
 * - cache 可删除/损坏/旧版,不保存 live JS object/socket/PTY/child/secret;
 *   唯一事实必须能从 Event + Receipt 重建;
 * - 校验:digest 重算、cache schema 版本、boundary/sourceSequence 一致性;
 *   任一项失败 → cache 丢弃,回退 full authority replay。
 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type SnapshotId } from "../protocol/ids.ts";
import type { SessionStore, CheckpointCacheEntry } from "../../storage/session-store/session-store.ts";
import type { AgentMessage } from "../types.ts";
import { isCurrentLedgerEntry, type LedgerEntry } from "../ledger/types.ts";
import { projectSessionReplay, type SessionReplay } from "../../storage/session-codec.ts";
import {
	SESSION_CHECKPOINT_BOUNDARIES,
	type OwnerFence,
	type SessionCheckpointBoundary,
	type SessionCheckpointDescriptor,
} from "../session-owner/types.ts";

/** cache-only snapshot 的版本化格式;结构变更时递增,旧版 cache 直接丢弃回退 replay。 */
export const SESSION_CHECKPOINT_CACHE_SCHEMA = 1 as const;

export interface CheckpointSnapshot {
	readonly cacheSchema: typeof SESSION_CHECKPOINT_CACHE_SCHEMA;
	readonly boundary: SessionCheckpointBoundary;
	readonly sourceSequence: number;
	/** current-format projection:model-visible context、pending queue、approval state 等。 */
	readonly state: Record<string, unknown>;
}

export type CheckpointValidation =
	| { readonly ok: true; readonly snapshot: CheckpointSnapshot }
	| { readonly ok: false; readonly code: "digest_mismatch" | "schema_unsupported" | "boundary_mismatch" | "sequence_mismatch" | "malformed" };

/** 序列化 checkpoint snapshot 并计算 digest(descriptor 与 cache entry 共用)。 */
export function serializeCheckpointSnapshot(snapshot: CheckpointSnapshot): { readonly snapshotJson: string; readonly digest: RuntimeDigest } {
	const snapshotJson = JSON.stringify(snapshot);
	return { snapshotJson, digest: runtimeDigest(snapshotJson) };
}

/** §7.2 创建并持久化一个 checkpoint cache(owner-fenced)。 */
export function putSessionCheckpoint(
	store: SessionStore,
	fence: OwnerFence,
	boundary: SessionCheckpointBoundary,
	sourceSequence: number,
	state: Record<string, unknown>,
): SessionCheckpointDescriptor {
	if (!(SESSION_CHECKPOINT_BOUNDARIES as readonly string[]).includes(boundary)) {
		throw new Error(`unsupported checkpoint boundary: ${boundary}`);
	}
	const snapshot: CheckpointSnapshot = {
		cacheSchema: SESSION_CHECKPOINT_CACHE_SCHEMA,
		boundary,
		sourceSequence,
		state,
	};
	const { snapshotJson, digest } = serializeCheckpointSnapshot(snapshot);
	const descriptor: SessionCheckpointDescriptor = {
		checkpointId: createRuntimeId("snapshot", `ck-${fence.sessionId.slice(-12)}-${sourceSequence}-${boundary}`),
		sessionId: fence.sessionId,
		ownerGeneration: fence.generation,
		boundary,
		sourceSequence,
		snapshotDigest: digest,
		createdAtMs: Date.now(),
	};
	store.putCheckpoint(fence, descriptor, snapshotJson);
	return descriptor;
}

/**
 * §7.2 校验 cache:digest 重算 + schema 版本 + boundary/sourceSequence 一致性。
 * 任何失败都不改变事实,只是丢弃 acceleration cache。
 */
export function validateCheckpointCache(entry: CheckpointCacheEntry, expectedBoundary?: SessionCheckpointBoundary): CheckpointValidation {
	if (canonicalDigest(entry.snapshotJson) !== entry.snapshotDigest.digest) {
		return { ok: false, code: "digest_mismatch" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(entry.snapshotJson) as unknown;
	} catch {
		return { ok: false, code: "malformed" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, code: "malformed" };
	}
	const snapshot = parsed as Record<string, unknown>;
	if (snapshot.cacheSchema !== SESSION_CHECKPOINT_CACHE_SCHEMA) {
		return { ok: false, code: "schema_unsupported" };
	}
	if (snapshot.boundary !== entry.boundary) {
		return { ok: false, code: "boundary_mismatch" };
	}
	if (snapshot.sourceSequence !== entry.sourceSequence) {
		return { ok: false, code: "sequence_mismatch" };
	}
	if (expectedBoundary !== undefined && entry.boundary !== expectedBoundary) {
		return { ok: false, code: "boundary_mismatch" };
	}
	const state = snapshot.state;
	if (typeof state !== "object" || state === null || Array.isArray(state)) {
		return { ok: false, code: "malformed" };
	}
	return {
		ok: true,
		snapshot: {
			cacheSchema: SESSION_CHECKPOINT_CACHE_SCHEMA,
			boundary: entry.boundary,
			sourceSequence: entry.sourceSequence,
			state: state as Record<string, unknown>,
		},
	};
}

/** checkpoint cache 的 snapshotDigest(与 descriptor 一致,供测试断言)。 */
export function checkpointDigest(snapshot: CheckpointSnapshot): RuntimeDigest {
	return serializeCheckpointSnapshot(snapshot).digest;
}

/**
 * 仅 replayReady checkpoint 可作为 acceleration seed；结构不完整时返回
 * undefined，调用方必须退回 genesis replay。tail 始终来自 durable events。
 */
export function restoreCheckpointReplay(
	snapshot: CheckpointSnapshot,
	tail: readonly LedgerEntry[],
): SessionReplay | undefined {
	const state = snapshot.state;
	if (state.replayReady !== true || !Array.isArray(state.messages) || !state.messages.every(isAgentMessage)) return undefined;
	if (!Array.isArray(state.warnings) || !state.warnings.every((value) => typeof value === "string")) return undefined;
	if (!Array.isArray(state.auditEntries) || !state.auditEntries.every(isCurrentLedgerEntry)) return undefined;
	if (!isRecord(state.selection)) return undefined;
	const config: SessionReplay["config"] = {};
	if (typeof state.selection.provider === "string") config.provider = state.selection.provider;
	if (isRecord(state.selection.model) && typeof state.selection.model.id === "string") config.model = state.selection.model.id;
	if (isThinkingLevel(state.selection.thinkingLevel)) config.thinkingLevel = state.selection.thinkingLevel;
	return projectSessionReplay(tail, {
		messages: state.messages,
		config,
		auditEntries: state.auditEntries,
		warnings: state.warnings,
	});
}

function isAgentMessage(value: unknown): value is AgentMessage {
	if (!isRecord(value) || !Array.isArray(value.content)) return false;
	if (value.role === "user" || value.role === "toolResult") return true;
	return value.role === "assistant" && typeof value.stopReason === "string";
}

function isThinkingLevel(value: unknown): value is NonNullable<SessionReplay["config"]["thinkingLevel"]> {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { CheckpointCacheEntry };
export type { SnapshotId };
