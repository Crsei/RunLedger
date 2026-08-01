/**
 * Runtime 的稳定 ID 基础类型。
 *
 * TODO(runtime-phase-0): 完成 authority/tenant/principal 与所有业务 ID 的
 * 持久化格式、迁移规则和跨进程签名约束。本文件只提供可编译的前置合同，
 * 不负责存储、分配 lease 或验证权限。
 */

import { randomUUID } from "node:crypto";

export const RUNTIME_ID_KINDS = [
	"authority",
	"tenant",
	"principal",
	"session",
	"goal",
	"task",
	"workspace",
	"repository",
	"agent",
	"turn",
	"toolCall",
	"queueItem",
	"trace",
	"artifact",
	"approval",
	"event",
	"resource",
	"snapshot",
	"command",
	"receipt",
	"finding",
	"proposal",
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
export type TaskId = RuntimeId<"task">;
export type WorkspaceId = RuntimeId<"workspace">;
export type RepositoryId = RuntimeId<"repository">;
export type AgentId = RuntimeId<"agent">;
export type TurnId = RuntimeId<"turn">;
export type ToolCallId = RuntimeId<"toolCall">;
export type QueueItemId = RuntimeId<"queueItem">;
export type TraceId = RuntimeId<"trace">;
export type ArtifactId = RuntimeId<"artifact">;
export type ApprovalId = RuntimeId<"approval">;
export type EventId = RuntimeId<"event">;
export type ResourceId = RuntimeId<"resource">;
export type SnapshotId = RuntimeId<"snapshot">;
export type CommandId = RuntimeId<"command">;
export type ReceiptId = RuntimeId<"receipt">;
export type FindingId = RuntimeId<"finding">;
export type ProposalId = RuntimeId<"proposal">;

const RUNTIME_ID_PATTERN = /^([a-zA-Z][a-zA-Z0-9]*)_([A-Za-z0-9._~-]+)$/;
export const RUNTIME_ID_SEED_MAX_LENGTH = 128;

/** 创建带有 kind 前缀的本地 Runtime ID；真正的分配/幂等规则留给 Session Kernel。 */
export function createRuntimeId<K extends RuntimeIdKind>(kind: K, seed: string = randomUUID()): RuntimeId<K> {
	if (seed.length === 0 || seed.length > RUNTIME_ID_SEED_MAX_LENGTH) {
		throw new Error(`Runtime ID seed must contain 1-${RUNTIME_ID_SEED_MAX_LENGTH} characters`);
	}
	const safeSeed = seed.replace(/[^A-Za-z0-9._~-]/g, "_");
	return `${kind}_${safeSeed}` as RuntimeId<K>;
}

/** 把已持久化的字符串安全转换为指定 kind 的 branded ID。 */
export function parseRuntimeId<K extends RuntimeIdKind>(kind: K, value: string): RuntimeId<K> | undefined {
	const match = RUNTIME_ID_PATTERN.exec(value);
	if (!match || match[1] !== kind || match[2].length === 0 || match[2].length > RUNTIME_ID_SEED_MAX_LENGTH) {
		return undefined;
	}
	return value as RuntimeId<K>;
}

export function isRuntimeId(value: unknown, expectedKind?: RuntimeIdKind): value is RuntimeId {
	if (typeof value !== "string") {
		return false;
	}
	const match = RUNTIME_ID_PATTERN.exec(value);
	return Boolean(
		match &&
			(RUNTIME_ID_KINDS as readonly string[]).includes(match[1]) &&
			match[2].length <= RUNTIME_ID_SEED_MAX_LENGTH &&
			(!expectedKind || match[1] === expectedKind),
	);
}
