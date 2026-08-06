/**
 * Session Owner 唯一 public owner contract(R0 冻结,06 §0/§3/§5)。
 *
 * 冻结对象:SessionOwnerRecord / OwnerFence / OwnerEndpoint、claim/heartbeat/
 * takeover CAS、owner/driver/recovery 事件、command intent + attempt receipt、
 * checkpoint cache descriptor、typed error codes 与 store schema 版本边界。
 *
 * 本模块是纯契约:禁止 raw I/O、storage/UI/provider import、machine leader、
 * daemon、UDS/Named Pipe 语义。authToken 永不出现在 record/DTO/event 中,
 * 只存在 DB owner row(受保护 blob)与当前进程内存(06 §4.6)。
 */

import type { RuntimeDigest } from "../protocol/foundation.ts";
import type {
	AttemptId,
	CommandId,
	ConnectionId,
	EventId,
	PrincipalId,
	ReceiptId,
	RuntimeInstanceId,
	SessionId,
	SnapshotId,
} from "../protocol/ids.ts";

export const SESSION_OWNER_PROTOCOL_VERSION = 1 as const;

/** §4.3 session_owners.state CHECK 的精确枚举。 */
export const SESSION_OWNER_STATES = [
	"unowned",
	"starting",
	"recovery_required",
	"running",
	"stopping",
] as const;
export type SessionOwnerState = (typeof SESSION_OWNER_STATES)[number];

/**
 * §4.2/§6.2 typed fail-closed error code 注册表。调用方不得把未知 code
 * 降级成成功;protocol negotiation 不能覆盖 storage incompatibility。
 */
export const SESSION_OWNER_ERROR_CODES = [
	"store_schema_too_new",
	"store_schema_too_old",
	"store_schema_incompatible",
	"upgrade_requires_sessions_closed",
	"owner_store_busy",
	"owner_claim_lost",
	"owner_takeover_conditions_unmet",
	"owner_fenced",
	"owner_stopping",
	"owner_starting",
	"session_owner_incompatible",
	"legacy_host_active",
	"handshake_token_mismatch",
	"handshake_identity_mismatch",
	"protocol_incompatible",
	"frame_oversized",
	"frame_malformed",
	"recovery_barrier_active",
	"driver_revision_conflict",
	"observer_mutation_forbidden",
] as const;
export type SessionOwnerErrorCode = (typeof SESSION_OWNER_ERROR_CODES)[number];

/** §4.6:每个 generation 的随机 auth token 固定 32 bytes,hex 编码 64 字符。 */
export const SESSION_OWNER_AUTH_TOKEN_BYTES = 32 as const;

/** §5.3 冻结的 heartbeat/健康探测参数。 */
export const SESSION_OWNER_HEARTBEAT_PARAMS = Object.freeze({
	heartbeatIntervalMs: 3_000,
	staleThresholdMs: 20_000,
	connectTimeoutMs: 1_000,
	startupGraceMs: 20_000,
	takeoverProbes: 3,
	probeSpacingMinMs: 250,
	retryBackoffBaseMs: 100,
	retryBackoffMaxMs: 2_000,
} as const);

/** §6.1/§6.2:只绑定 IPv4 loopback,端口由 OS 分配后回写。 */
export interface OwnerEndpoint {
	readonly host: "127.0.0.1";
	readonly port: number;
}

/**
 * §4.3 session_owners row 的 wire projection。authToken 是 row 的 BLOB 列,
 * 永不进入本 record(§4.6);heartbeatAtMs 缺失表示从未 heartbeat。
 */
export interface SessionOwnerRecord {
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly state: SessionOwnerState;
	readonly endpoint?: OwnerEndpoint;
	readonly heartbeatAtMs?: number;
	readonly ownerStartedAtMs: number;
	readonly updatedAtMs: number;
}

/** §4.5:所有 durable mutation 必须消费的写 fence。 */
export interface OwnerFence {
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
}

/** §5.2 takeover CAS:claim transaction 内 row 必须与 probe 前读取的 exact 值一致。 */
export interface OwnerClaimTarget {
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly heartbeatAtMs?: number;
	readonly state: SessionOwnerState;
}

export type OwnerClaimAttempt =
	| { readonly mode: "fresh"; readonly sessionId: SessionId }
	| { readonly mode: "takeover"; readonly sessionId: SessionId; readonly expected: OwnerClaimTarget };

/**
 * §5.2 claim 结果。claimed 必须先绑定 candidate listener 再 publish endpoint;
 * attached 表示输掉竞争后应重新读取 winner 并 attach。
 */
export type OwnerClaimResult =
	| { readonly ok: true; readonly outcome: "claimed"; readonly fence: OwnerFence; readonly endpoint: OwnerEndpoint }
	| { readonly ok: true; readonly outcome: "attached"; readonly record: SessionOwnerRecord }
	| { readonly ok: false; readonly code: SessionOwnerErrorCode; readonly retryable: boolean };

export interface OwnerHeartbeatRequest {
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly heartbeatAtMs: number;
}

/** §5.4:UPDATE changes=0 等价于 owner 已被 fence。 */
export type OwnerHeartbeatResult =
	| { readonly ok: true; readonly heartbeatAtMs: number }
	| { readonly ok: false; readonly code: "owner_fenced" };

/**
 * §6.3/§4.3 owner/driver/recovery 事件目录。driver 是 connection-scoped,
 * disconnect/takeover 强制 NONE + revision 事件;recovery.* 是 barrier 收口证据。
 */
export const SESSION_OWNER_EVENT_TYPES = [
	"owner.claimed",
	"owner.taken_over",
	"owner.released",
	"owner.fenced",
	"driver.claimed",
	"driver.released",
	"driver.reset_on_takeover",
	"recovery.verified_clean",
	"recovery.verify",
	"recovery.abort",
	"recovery.resume_despite_uncertainty",
] as const;
export type SessionOwnerEventType = (typeof SESSION_OWNER_EVENT_TYPES)[number];

export const OWNER_RELEASE_REASONS = ["paused", "detached", "error", "fenced"] as const;
export type OwnerReleaseReason = (typeof OWNER_RELEASE_REASONS)[number];

/** §7.3 crash recovery decision 的 outcome 集合。 */
export const RECOVERY_DECISION_OUTCOMES = ["verified_clean", "settled", "aborted", "resumed_despite_uncertainty"] as const;
export type RecoveryDecisionOutcome = (typeof RECOVERY_DECISION_OUTCOMES)[number];

export interface OwnerClaimedPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly port: number;
	readonly ownerStartedAtMs: number;
}

export interface OwnerTakenOverPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly priorGeneration: number;
	readonly generation: number;
	readonly port: number;
}

export interface OwnerReleasedPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly reason: OwnerReleaseReason;
}

export interface OwnerFencedPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
}

export interface DriverClaimedPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly connectionId: ConnectionId;
	readonly driverRevision: number;
}

export interface DriverReleasedPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly connectionId: ConnectionId;
	readonly driverRevision: number;
}

export interface DriverResetOnTakeoverPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly driverRevision: number;
}

export interface RecoveryVerifiedCleanPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly evidenceDigest: RuntimeDigest;
}

export interface RecoveryVerifyPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly attemptId: AttemptId;
	readonly outcome: "settled" | "verified_clean";
	readonly settledGeneration: number;
	readonly evidenceDigest?: RuntimeDigest;
}

export interface RecoveryAbortPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly reasonCode: string;
}

export interface RecoveryResumeDespiteUncertaintyPayload {
	readonly eventId: EventId;
	readonly sessionId: SessionId;
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly principalId: PrincipalId;
	readonly reasonCode: string;
	readonly originGeneration: number;
	readonly settledGeneration: number;
	readonly evidenceDigest: RuntimeDigest;
}

export type SessionOwnerEventPayload =
	| OwnerClaimedPayload
	| OwnerTakenOverPayload
	| OwnerReleasedPayload
	| OwnerFencedPayload
	| DriverClaimedPayload
	| DriverReleasedPayload
	| DriverResetOnTakeoverPayload
	| RecoveryVerifiedCleanPayload
	| RecoveryVerifyPayload
	| RecoveryAbortPayload
	| RecoveryResumeDespiteUncertaintyPayload;

/** §4.3 command_attempt_receipts.outcome CHECK 的精确枚举。 */
export const COMMAND_ATTEMPT_OUTCOMES = [
	"started",
	"committed",
	"rejected",
	"interrupted",
	"uncertain",
	"verified",
] as const;
export type CommandAttemptOutcome = (typeof COMMAND_ATTEMPT_OUTCOMES)[number];

/** §7.3 crash boundary 恢复决策使用的 canonical effect classification。 */
export const COMMAND_EFFECT_CLASSES = [
	"readonly",
	"workspace_mutation",
	"process_spawn",
	"external_mutation",
] as const;
export type CommandEffectClass = (typeof COMMAND_EFFECT_CLASSES)[number];

/**
 * §4.3 commands:immutable intent。origin_generation 表示 intent 最初由哪个
 * owner generation 创建;新 generation 不得改写 origin。
 */
export interface CommandIntent {
	readonly sessionId: SessionId;
	readonly commandId: CommandId;
	readonly requestDigest: RuntimeDigest;
	readonly originGeneration: number;
	readonly createdAtMs: number;
}

/**
 * §4.3 command_attempt_receipts:只 append,不原地改写旧 outcome。
 * settled_generation 表示哪个 generation 最终核验或收口;generation 8 可以
 * 验证 generation 7 的 uncertain attempt,但不得改写它的 origin 或旧 receipt。
 */
export interface CommandAttemptReceipt {
	readonly receiptId: ReceiptId;
	readonly sessionId: SessionId;
	readonly commandId: CommandId;
	readonly attemptId: AttemptId;
	readonly originGeneration: number;
	readonly settledGeneration?: number;
	readonly effectClass: CommandEffectClass;
	readonly outcome: CommandAttemptOutcome;
	readonly resultDigest?: RuntimeDigest;
	readonly evidenceDigest?: RuntimeDigest;
	readonly createdAtMs: number;
}

/** §7.2 首版只支持的六个 safe checkpoint boundary。 */
export const SESSION_CHECKPOINT_BOUNDARIES = [
	"before_model",
	"after_model",
	"before_tool",
	"after_tool",
	"turn_completed",
	"paused",
] as const;
export type SessionCheckpointBoundary = (typeof SESSION_CHECKPOINT_BOUNDARIES)[number];

/**
 * §7.2 checkpoint cache 的 wire descriptor。snapshot_json 是 cache-only,
 * 不进入 wire/event;所有唯一事实必须能从 Event + Receipt 重建(§4.4)。
 */
export interface SessionCheckpointDescriptor {
	readonly checkpointId: SnapshotId;
	readonly sessionId: SessionId;
	readonly ownerGeneration: number;
	readonly boundary: SessionCheckpointBoundary;
	readonly sourceSequence: number;
	readonly snapshotDigest: RuntimeDigest;
	readonly createdAtMs: number;
}

/**
 * §4.2:每个 binary 编译时固定的 store schema 兼容窗口。首版 structural core
 * 冻结后优先扩展 versioned payload,不随意 DDL;高于 MAX 返回
 * store_schema_too_new,低于 MIN 且无对应 migration 返回 store_schema_too_old。
 */
export const SESSION_STORE_SCHEMA_MIN = 1 as const;
export const SESSION_STORE_SCHEMA_MAX = 1 as const;
export const SESSION_STORE_SCHEMA_CURRENT = 1 as const;
