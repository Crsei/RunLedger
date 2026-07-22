/** Runtime v3 稳定 ID、租户作用域主键与解析规则。 */

import { createHash, randomUUID } from "node:crypto";
import { RuntimeContractError } from "./errors.ts";

export const RUNTIME_ID_KINDS = [
	"authority",
	"tenant",
	"principal",
	"session",
	"goal",
	"workspace",
	"repository",
	"agent",
	"turn",
	"modelRequest",
	"queueItem",
	"toolCall",
	"trace",
	"artifact",
	"approval",
	"event",
	"eventStream",
	"resource",
	"snapshot",
	"runtime",
	"lease",
	"receipt",
	"checkpoint",
	"leaf",
	"plan",
	"contextRequest",
	"memoryProposal",
	"verification",
	"finding",
	"command",
	"memory",
	"compaction",
	"budgetReservation",
	"inputSource",
	"declassification",
	"compositionReceipt",
	"rateLimit",
	"episodeSeal",
	"changeProposal",
	"humanGate",
] as const;

export type RuntimeIdKind = (typeof RUNTIME_ID_KINDS)[number];

export type RuntimeId<K extends RuntimeIdKind = RuntimeIdKind> = string & {
	readonly __runtimeIdKind: K;
};

export type AuthorityId = RuntimeId<"authority">;
export type TenantId = RuntimeId<"tenant">;
export type PrincipalId = RuntimeId<"principal">;
export type SessionId = RuntimeId<"session">;
export type GoalId = RuntimeId<"goal">;
export type WorkspaceId = RuntimeId<"workspace">;
export type RepositoryId = RuntimeId<"repository">;
export type AgentId = RuntimeId<"agent">;
export type TurnId = RuntimeId<"turn">;
export type ModelRequestId = RuntimeId<"modelRequest">;
export type QueueItemId = RuntimeId<"queueItem">;
export type ToolCallId = RuntimeId<"toolCall">;
export type TraceId = RuntimeId<"trace">;
export type ArtifactId = RuntimeId<"artifact">;
export type ApprovalId = RuntimeId<"approval">;
export type EventId = RuntimeId<"event">;
export type EventStreamId = RuntimeId<"eventStream">;
export type ResourceId = RuntimeId<"resource">;
export type SnapshotId = RuntimeId<"snapshot">;
export type RuntimeInstanceId = RuntimeId<"runtime">;
export type LeaseId = RuntimeId<"lease">;
export type ReceiptId = RuntimeId<"receipt">;
export type CheckpointId = RuntimeId<"checkpoint">;
export type LeafId = RuntimeId<"leaf">;
export type PlanId = RuntimeId<"plan">;
export type ContextRequestId = RuntimeId<"contextRequest">;
export type MemoryProposalId = RuntimeId<"memoryProposal">;
export type VerificationId = RuntimeId<"verification">;
export type FindingId = RuntimeId<"finding">;
export type CommandId = RuntimeId<"command">;
export type MemoryId = RuntimeId<"memory">;
export type CompactionId = RuntimeId<"compaction">;
export type BudgetReservationId = RuntimeId<"budgetReservation">;
export type InputSourceId = RuntimeId<"inputSource">;
export type DeclassificationId = RuntimeId<"declassification">;
export type CompositionReceiptId = RuntimeId<"compositionReceipt">;
export type RateLimitId = RuntimeId<"rateLimit">;
export type EpisodeSealId = RuntimeId<"episodeSeal">;
export type ChangeProposalId = RuntimeId<"changeProposal">;
export type HumanGateId = RuntimeId<"humanGate">;

export const MAX_RUNTIME_ID_LENGTH = 128;
export const MAX_RUNTIME_ID_SEED_LENGTH = 96;
export const RUNTIME_ID_SEED_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

const KIND_SET: ReadonlySet<string> = new Set(RUNTIME_ID_KINDS);
const RUNTIME_ID_PATTERN = /^([a-zA-Z][a-zA-Z0-9]*)_([A-Za-z0-9][A-Za-z0-9._~-]*)$/;

/**
 * 创建带稳定 kind 前缀的 Runtime ID。
 *
 * seed 不做有损清洗，避免两个外部值被折叠成同一个持久化主键。
 */
export function createRuntimeId<K extends RuntimeIdKind>(kind: K, seed: string = randomUUID()): RuntimeId<K> {
	if (!KIND_SET.has(kind) || !RUNTIME_ID_SEED_PATTERN.test(seed) || seed.length > MAX_RUNTIME_ID_SEED_LENGTH) {
		throw new RuntimeContractError({
			code: "invalid_id",
			message: `invalid ${kind} id seed`,
			retryable: false,
		});
	}
	const value = `${kind}_${seed}`;
	if (value.length > MAX_RUNTIME_ID_LENGTH) {
		throw new RuntimeContractError({ code: "invalid_id", message: `${kind} id is too long`, retryable: false });
	}
	return value as RuntimeId<K>;
}

/** 把持久化字符串安全转换为指定 kind 的 branded ID。 */
export function parseRuntimeId<K extends RuntimeIdKind>(kind: K, value: string): RuntimeId<K> | undefined {
	if (value.length > MAX_RUNTIME_ID_LENGTH) return undefined;
	const match = RUNTIME_ID_PATTERN.exec(value);
	if (!match || match[1] !== kind || !KIND_SET.has(match[1])) return undefined;
	return value as RuntimeId<K>;
}

export function isRuntimeId(value: unknown, expectedKind?: RuntimeIdKind): value is RuntimeId {
	if (typeof value !== "string" || value.length > MAX_RUNTIME_ID_LENGTH) return false;
	const match = RUNTIME_ID_PATTERN.exec(value);
	return Boolean(match && KIND_SET.has(match[1]) && (!expectedKind || match[1] === expectedKind));
}

export interface RuntimeScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

/** stream ID 只由其持久 scope 派生，重启后不会重新生成另一条链。 */
export function createEventStreamId(scope: RuntimeScope, sessionId?: SessionId): EventStreamId {
	const seed = createHash("sha256")
		.update(`${scope.authorityId}\0${scope.tenantId}\0${sessionId ?? "authority_tenant"}`, "utf8")
		.digest("hex")
		.slice(0, 32);
	return createRuntimeId("eventStream", seed);
}

/** authority/tenant 是所有持久主键、签名输入和授权请求的强制命名空间。 */
export type ScopedRuntimeKey<K extends RuntimeIdKind = RuntimeIdKind> = string & {
	readonly __scopedRuntimeKeyKind: K;
};

export function createScopedRuntimeKey<K extends RuntimeIdKind>(
	scope: RuntimeScope,
	id: RuntimeId<K>,
): ScopedRuntimeKey<K> {
	if (!isRuntimeId(scope.authorityId, "authority") || !isRuntimeId(scope.tenantId, "tenant") || !isRuntimeId(id)) {
		throw new RuntimeContractError({ code: "invalid_id", message: "invalid scoped runtime key", retryable: false });
	}
	return `${scope.authorityId}/${scope.tenantId}/${id}` as ScopedRuntimeKey<K>;
}

export function parseScopedRuntimeKey<K extends RuntimeIdKind>(
	kind: K,
	value: string,
): { scope: RuntimeScope; id: RuntimeId<K> } | undefined {
	const parts = value.split("/");
	if (parts.length !== 3) return undefined;
	const authorityId = parseRuntimeId("authority", parts[0] ?? "");
	const tenantId = parseRuntimeId("tenant", parts[1] ?? "");
	const id = parseRuntimeId(kind, parts[2] ?? "");
	if (!authorityId || !tenantId || !id) return undefined;
	return { scope: { authorityId, tenantId }, id };
}
