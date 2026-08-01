/** Memory exact schemas 与 runtime guards。 */

import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	CanonicalUtcTimestampSchema,
	RuntimeContentRefSchema,
	RuntimeDigestSchema,
	RuntimeIdSchema,
	RuntimeStreamHeadSchema,
	isCanonicalUtcTimestamp,
} from "../../protocol/foundation-schemas.ts";
import { isRuntimeId } from "../../protocol/ids.ts";
import type { MemoryProposal, MemoryRecord, MemorySearchReceipt, MemoryScope } from "./types.ts";

const MemoryScopeSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("workspace"),
	Type.Literal("session"),
]);
const MemoryProvenanceSchema = Type.Object(
	{
		sourceKind: Type.Union([
			Type.Literal("user"),
			Type.Literal("agent"),
			Type.Literal("tool"),
			Type.Literal("import"),
			Type.Literal("compaction"),
		]),
		sourceRef: RuntimeContentRefSchema,
		sourceDigest: RuntimeDigestSchema,
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const MemoryRecordSchema = Type.Object(
	{
		memoryId: RuntimeIdSchema,
		scope: MemoryScopeSchema,
		workspaceId: Type.Optional(RuntimeIdSchema),
		sessionId: Type.Optional(RuntimeIdSchema),
		title: Type.String({ minLength: 1, maxLength: 256 }),
		contentDigest: RuntimeDigestSchema,
		contentRef: RuntimeContentRefSchema,
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		trust: Type.Union([
			Type.Literal("untrusted"),
			Type.Literal("proposed"),
			Type.Literal("approved"),
			Type.Literal("revoked"),
			Type.Literal("changed_unreviewed"),
		]),
		provenance: MemoryProvenanceSchema,
		approvedAt: Type.Optional(CanonicalUtcTimestampSchema),
		expiresAt: Type.Optional(CanonicalUtcTimestampSchema),
		revocationRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
	},
	{ additionalProperties: false },
);

export const MemoryProposalSchema = Type.Object(
	{
		proposalId: RuntimeIdSchema,
		memoryId: RuntimeIdSchema,
		scope: MemoryScopeSchema,
		recordDigest: RuntimeDigestSchema,
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("approved"),
			Type.Literal("rejected"),
			Type.Literal("expired"),
		]),
		approvalRef: Type.Optional(RuntimeContentRefSchema),
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

export const MemorySearchReceiptSchema = Type.Object(
	{
		receiptId: RuntimeIdSchema,
		queryDigest: RuntimeDigestSchema,
		scope: MemoryScopeSchema,
		workspaceId: Type.Optional(RuntimeIdSchema),
		sessionId: Type.Optional(RuntimeIdSchema),
		mode: Type.Union([Type.Literal("lexical"), Type.Literal("vector"), Type.Literal("none")]),
		resultIds: Type.Array(RuntimeIdSchema, { maxItems: 256 }),
		indexDigest: RuntimeDigestSchema,
		sourceHead: RuntimeStreamHeadSchema,
		createdAt: CanonicalUtcTimestampSchema,
	},
	{ additionalProperties: false },
);

function hasExactScopeIdentity(scope: MemoryScope, workspaceId: unknown, sessionId: unknown): boolean {
	if (scope === "workspace") return isRuntimeId(workspaceId, "workspace") && sessionId === undefined;
	if (scope === "session") return isRuntimeId(sessionId, "session") && workspaceId === undefined;
	return workspaceId === undefined && sessionId === undefined;
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
	if (!Value.Check(MemoryRecordSchema, value)) return false;
	return (
		isRuntimeId(value.memoryId, "memory") &&
		hasExactScopeIdentity(value.scope, value.workspaceId, value.sessionId) &&
		isCanonicalUtcTimestamp(value.provenance.createdAt) &&
		(value.approvedAt === undefined || isCanonicalUtcTimestamp(value.approvedAt)) &&
		(value.expiresAt === undefined || isCanonicalUtcTimestamp(value.expiresAt))
	);
}

export function isMemoryProposal(value: unknown): value is MemoryProposal {
	if (!Value.Check(MemoryProposalSchema, value)) return false;
	if (!isRuntimeId(value.proposalId, "proposal") || !isRuntimeId(value.memoryId, "memory") || !isCanonicalUtcTimestamp(value.createdAt)) return false;
	return value.status === "approved" ? value.approvalRef !== undefined : true;
}

export function isMemorySearchReceipt(value: unknown): value is MemorySearchReceipt {
	if (!Value.Check(MemorySearchReceiptSchema, value)) return false;
	return (
		isRuntimeId(value.receiptId, "receipt") &&
		hasExactScopeIdentity(value.scope, value.workspaceId, value.sessionId) &&
		value.resultIds.every((id) => isRuntimeId(id, "memory")) &&
		isCanonicalUtcTimestamp(value.createdAt)
	);
}
