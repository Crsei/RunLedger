/**
 * Extension invocation 的纯审计投影。
 *
 * 该模块只返回 bounded DTO；它不接收 writer、不追加 event，也不保留调用
 * 正文。正文、secret 和完整 MCP/Hook 输出只由调用方在 request lifetime 内
 * 使用，审计面永远只保存 digest、size、状态和 exact identity。
 */

import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { CommandId, SnapshotId, TraceId } from "../../runtime/protocol/ids.ts";
import type { ResourceIdentity } from "../../runtime/resources/types.ts";
import type { ExtensionAdapterErrorCode } from "./runtime-resource-adapter.ts";

export type ExtensionInvocationAuditKind = "hook.run" | "mcp.tool" | "skill.invocation";
export type ExtensionInvocationAuditOutcome = "ok" | "denied" | "error" | "cancelled" | "unsupported";

export interface ExtensionInvocationAudit {
	readonly kind: ExtensionInvocationAuditKind;
	readonly requestId: CommandId;
	readonly correlationId: TraceId;
	readonly snapshotId: SnapshotId;
	readonly resource: ResourceIdentity;
	readonly outcome: ExtensionInvocationAuditOutcome;
	readonly inputDigest: ReturnType<typeof runtimeDigest>;
	readonly outputDigest: ReturnType<typeof runtimeDigest>;
	readonly metadataDigest: ReturnType<typeof runtimeDigest>;
	readonly portDigest?: ReturnType<typeof runtimeDigest>;
	readonly bodyDigest?: ReturnType<typeof runtimeDigest>;
	readonly originalBytes: number;
	readonly resultBytes: number;
	readonly truncated: boolean;
	readonly durationMs: number;
	readonly errorCode?: ExtensionAdapterErrorCode;
}

export function createInvocationAudit(args: {
	readonly kind: ExtensionInvocationAuditKind;
	readonly requestId: CommandId;
	readonly correlationId: TraceId;
	readonly snapshotId: SnapshotId;
	readonly resource: ResourceIdentity;
	readonly outcome: ExtensionInvocationAuditOutcome;
	readonly inputDigest: ReturnType<typeof runtimeDigest>;
	readonly outputDigest: ReturnType<typeof runtimeDigest>;
	readonly metadata?: unknown;
	readonly portDigest?: ReturnType<typeof runtimeDigest>;
	readonly bodyDigest?: ReturnType<typeof runtimeDigest>;
	readonly originalBytes: number;
	readonly resultBytes: number;
	readonly truncated?: boolean;
	readonly durationMs: number;
	readonly errorCode?: ExtensionAdapterErrorCode;
}): { readonly audit: ExtensionInvocationAudit; readonly auditDigest: ReturnType<typeof runtimeDigest> } {
	const audit: ExtensionInvocationAudit = {
		kind: args.kind,
		requestId: args.requestId,
		correlationId: args.correlationId,
		snapshotId: args.snapshotId,
		resource: args.resource,
		outcome: args.outcome,
		inputDigest: args.inputDigest,
		outputDigest: args.outputDigest,
		metadataDigest: runtimeDigest(args.metadata ?? null),
		...(args.portDigest ? { portDigest: args.portDigest } : {}),
		...(args.bodyDigest ? { bodyDigest: args.bodyDigest } : {}),
		originalBytes: boundedNonNegative(args.originalBytes),
		resultBytes: boundedNonNegative(args.resultBytes),
		truncated: args.truncated === true,
		durationMs: boundedNonNegative(args.durationMs),
		...(args.errorCode ? { errorCode: args.errorCode } : {}),
	};
	return { audit, auditDigest: runtimeDigest(audit) };
}

function boundedNonNegative(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) return 0;
	return Math.min(value, Number.MAX_SAFE_INTEGER);
}
