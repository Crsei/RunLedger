/**
 * SessionStore 错误 taxonomy(单一领域概念,非杂物文件)。
 *
 * S1 拆分:错误类与错误码被 event-append / catalog / attempt / checkpoint /
 * projection 全部协作者使用;独立成模块避免协作者反向 import facade 造成
 * 运行时环。公共 API 仍由 session-store.ts 原路径重导出,import 不变。
 */

export const SESSION_STORE_ERROR_CODES = [
	"owner_fenced",
	"admission_blocked",
	"session_not_found",
	"session_conflict",
	"catalog_revision_conflict",
	"sequence_conflict",
	"previous_hash_mismatch",
	"command_intent_conflict",
	"receipt_origin_mismatch",
	"checkpoint_not_found",
	"fork_source_not_found",
	"fork_source_head_conflict",
	"title_conflict",
	"invalid_title",
	"projection_invalid",
	"invalid_input",
] as const;
export type SessionStoreErrorCode = (typeof SESSION_STORE_ERROR_CODES)[number];

export class SessionStoreError extends Error {
	public readonly code: SessionStoreErrorCode;
	public constructor(code: SessionStoreErrorCode, message: string) {
		super(message);
		this.name = "SessionStoreError";
		this.code = code;
	}
}
