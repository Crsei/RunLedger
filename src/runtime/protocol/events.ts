/**
 * 当前 Runtime 事件目录与 envelope。
 *
 * TODO(runtime-phase-0): 把每个事件映射到独立的 payload schema，增加状态转换
 * 校验、hash-chain 计算和 unknown-event fence。当前 payload 仍是有界
 * Record，不能被当作最终的生产 event store 合同。
 */

import type {
	AuthorityId,
	EventId,
	PrincipalId,
	SessionId,
	TenantId,
	TraceId,
} from "./ids.ts";

export const RUNTIME_EVENT_TYPES = [
	"session.started",
	"session.stopped",
	"session.corrupted",
	"session.repair_reported",
	"goal.transitioned",
	"turn.started",
	"turn.finished",
	"turn.interrupted",
	"turn.failed",
	"model.routed",
	"model.requested",
	"model.finished",
	"model.failed",
	"tool.requested",
	"tool.authorized",
	"tool.started",
	"tool.finished",
	"tool.interrupted",
	"tool.failed",
	"permission.requested",
	"permission.decided",
	"permission.expired",
	"permission.revoked",
	"workspace.bound",
	"workspace.validation_recorded",
	"workspace.released",
	"sandbox.resolved",
	"sandbox.execution_recorded",
	"queue.enqueued",
	"queue.consumed",
	"checkpoint.created",
	"checkpoint.rewound",
	"artifact.intent_recorded",
	"artifact.created",
	"artifact.committed",
	"resource.snapshot",
	"resource.approved",
	"resource.revoked",
	"budget.reserved",
	"budget.committed",
	"budget.refunded",
	"budget.exhausted",
	"verification.started",
	"verification.finished",
	"finding.transitioned",
	"agent.spawned",
	"agent.finished",
	"agent.failed",
	"lease.acquired",
	"lease.taken_over",
	"lease.released",
	"context.assembled",
	"compaction.started",
	"compaction.completed",
	"compaction.failed",
	"memory.proposed",
	"memory.approved",
	"memory.revoked",
] as const;

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];

export interface RuntimeEventEnvelope<
	TType extends RuntimeEventType = RuntimeEventType,
	TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	eventId: EventId;
	sessionId: SessionId;
	sequence: number;
	timestamp: string;
	type: TType;
	previousEventHash: string | null;
	payloadDigest: string;
	currentEventHash: string;
	traceId: TraceId;
	payload: TPayload;
}

export type RuntimeEvent = RuntimeEventEnvelope;

export function isKnownRuntimeEventType(value: unknown): value is RuntimeEventType {
	return typeof value === "string" && (RUNTIME_EVENT_TYPES as readonly string[]).includes(value);
}
