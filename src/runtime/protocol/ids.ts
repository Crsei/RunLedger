/**
 * Runtime 的稳定 ID 基础类型。
 *
 * TODO(runtime-phase-0): 完成 authority/tenant/principal 与所有业务 ID 的
 * 持久化格式、迁移规则和跨进程签名约束。本文件只提供可编译的前置合同，
 * 不负责存储、分配 lease 或验证权限。
 */

import { randomUUID } from "node:crypto";

export type RuntimeIdKind =
	| "authority"
	| "tenant"
	| "principal"
	| "session"
	| "goal"
	| "workspace"
	| "repository"
	| "agent"
	| "toolCall"
	| "trace"
	| "artifact"
	| "approval"
	| "event"
	| "resource"
	| "snapshot";

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
export type ToolCallId = RuntimeId<"toolCall">;
export type TraceId = RuntimeId<"trace">;
export type ArtifactId = RuntimeId<"artifact">;
export type ApprovalId = RuntimeId<"approval">;
export type EventId = RuntimeId<"event">;
export type ResourceId = RuntimeId<"resource">;
export type SnapshotId = RuntimeId<"snapshot">;

const RUNTIME_ID_PATTERN = /^([a-zA-Z][a-zA-Z0-9]*)_([A-Za-z0-9._~-]+)$/;

/** 创建带有 kind 前缀的本地 Runtime ID；真正的分配/幂等规则留给 Session Kernel。 */
export function createRuntimeId<K extends RuntimeIdKind>(kind: K, seed: string = randomUUID()): RuntimeId<K> {
	const safeSeed = seed.replace(/[^A-Za-z0-9._~-]/g, "_");
	return `${kind}_${safeSeed}` as RuntimeId<K>;
}

/** 把已持久化的字符串安全转换为指定 kind 的 branded ID。 */
export function parseRuntimeId<K extends RuntimeIdKind>(kind: K, value: string): RuntimeId<K> | undefined {
	const match = RUNTIME_ID_PATTERN.exec(value);
	if (!match || match[1] !== kind || match[2].length === 0) {
		return undefined;
	}
	return value as RuntimeId<K>;
}

export function isRuntimeId(value: unknown, expectedKind?: RuntimeIdKind): value is RuntimeId {
	if (typeof value !== "string") {
		return false;
	}
	const match = RUNTIME_ID_PATTERN.exec(value);
	return Boolean(match && (!expectedKind || match[1] === expectedKind));
}
