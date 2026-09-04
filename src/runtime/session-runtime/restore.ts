/**
 * R5:authority replay + checkpoint cache 恢复(06 §7.2)。
 *
 * 恢复顺序固定为:
 *   1. 校验 authority event/receipt(replaySessionEvents fail closed on tamper);
 *   2. 尝试校验 checkpoint digest/source sequence/cache schema;
 *   3. 命中 → 从 checkpoint 后 replay;miss/corrupt/旧版 → 丢弃 cache 从 genesis
 *      replay;
 * 只有 event/receipt hash、sequence、schema 或外部 locator authority 损坏才返回
 * typed corruption/migration error;checkpoint 自身损坏不能阻止可验证的 full replay。
 */

import type { SessionStore, SessionEventRecord } from "../../storage/session-store/session-store.ts";
import { validateCheckpointCache, type CheckpointSnapshot } from "./checkpoint.ts";
import type { SessionCheckpointDescriptor } from "../session-owner/types.ts";
import {
	auditHarnessCompositionReceipts,
	type HarnessCompositionDiagnostic,
} from "../harness-profiles/index.ts";

export type RestoreOutcome =
	| {
			readonly ok: true;
			readonly events: readonly SessionEventRecord[];
			/** 调用方必须实际 replay 的 authority 段；checkpoint hit 时仅含 tail。 */
			readonly replayEvents: readonly SessionEventRecord[];
			readonly headSequence: number;
			readonly checkpoint?: { readonly descriptor: SessionCheckpointDescriptor; readonly snapshot: CheckpointSnapshot };
			/** false = cache miss/corrupt/旧版,本次为 genesis full replay。 */
			readonly usedCheckpoint: boolean;
	  }
	| {
		readonly ok: false;
		readonly code: "corruption" | "session_not_found" | "harness_profile_corruption" | "harness_composition_corruption";
		readonly detail: string;
		readonly diagnostic?: HarnessCompositionDiagnostic;
	};

export interface RestoreSessionOptions {
	/** 指定 checkpoint(可选);缺省用 sessions.current_checkpoint_id。 */
	readonly checkpointId?: string;
}

/**
 * §7.2/§R5 authority-first restore:
 * - replaySessionEvents 已做 hash 链校验,tamper 直接 typed corruption;
 * - checkpoint 校验失败(含删除/损坏/旧版 schema)只丢弃 cache,回退 full replay;
 * - checkpoint 命中时仍从 source_sequence 之后重放,保证 checkpoint 快照与
 *   durable authority 尾部连续。
 */
export function restoreSession(store: SessionStore, sessionId: string, options: RestoreSessionOptions = {}): RestoreOutcome {
	let record;
	try {
		record = store.getSession(sessionId);
	} catch (error) {
		return { ok: false, code: "harness_profile_corruption", detail: error instanceof Error ? error.message : String(error) };
	}
	if (record === undefined) {
		return { ok: false, code: "session_not_found", detail: `session not found: ${sessionId}` };
	}
	let events: readonly SessionEventRecord[];
	try {
		events = store.replaySessionEvents(sessionId);
	} catch (error) {
		return { ok: false, code: "corruption", detail: error instanceof Error ? error.message : String(error) };
	}
	const compositionAudit = auditHarnessCompositionReceipts({
		sessionId,
		profile: record.harnessProfile,
		events,
	});
	if (!compositionAudit.ok) {
		return {
			ok: false,
			code: "harness_composition_corruption",
			detail: compositionAudit.detail,
			diagnostic: compositionAudit.diagnostic,
		};
	}
	const checkpointId = options.checkpointId ?? record.currentCheckpointId;
	if (checkpointId !== undefined) {
		const entry = store.getCheckpoint(checkpointId);
		if (entry !== undefined && entry.sessionId === sessionId) {
			const validation = validateCheckpointCache(entry);
			if (validation.ok) {
				const { snapshot } = validation;
				const tail = events.filter((event) => event.sequence > snapshot.sourceSequence);
				return {
					ok: true,
					events,
					replayEvents: tail,
					headSequence: events.length,
					checkpoint: { descriptor: entry, snapshot },
					usedCheckpoint: true,
				};
			}
			// cache 损坏/旧版:丢弃 cache,走 full replay(cache 不改变事实)。
		}
	}
	return { ok: true, events, replayEvents: events, headSequence: events.length, usedCheckpoint: false };
}
