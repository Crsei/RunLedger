/** Memory contract 的 exact TypeBox schema 与 trust/scope/approval/TTL 约束。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema, ApprovalReceiptRefSchema, isApprovalReceiptRef } from "../../protocol/v3/capability.ts";
import { CONTEXT_TAINTS, CONTEXT_TRUST_LEVELS } from "../types.ts";
import {
	MEMORY_CONTRACT_VERSION,
	MEMORY_STATUSES,
	type MemoryDiff,
	type MemoryFieldDiff,
	type MemoryInjectionReceipt,
	type MemoryProposal,
	type MemoryRecord,
	type MemoryRef,
	type MemoryScopeRef,
	type MemorySearchReceipt,
	type MemorySearchRequest,
	type MemorySearchResult,
	type MemorySourceRef,
} from "./types.ts";

export const MEMORY_SCHEMA_VERSION = MEMORY_CONTRACT_VERSION;
export const MAX_MEMORY_CONTENT_CHARS = 65_536;
export const MAX_MEMORY_SOURCES = 64;
export const MAX_MEMORY_SEARCH_RESULTS = 100;
export const MAX_MEMORY_SNIPPET_CHARS = 4_096;
export const MAX_MEMORY_SEARCH_TOKENS = 32_768;

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const id = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const token = Type.String({ minLength: 1, maxLength: 256 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const literals = <T extends readonly string[]>(values: T) =>
	Type.Union(values.map((value) => Type.Literal(value)));

export const MemoryScopeRefSchema = Type.Unsafe<MemoryScopeRef>(Type.Union([
	exact({ scope: Type.Literal("user"), ownerPrincipalId: id("principal") }),
	exact({ scope: Type.Literal("workspace"), workspaceId: id("workspace") }),
	exact({ scope: Type.Literal("session"), sessionId: id("session") }),
]));

const sourceBase = {
	authorityId: id("authority"),
	tenantId: id("tenant"),
	sourceDigest: digest,
	trust: literals(CONTEXT_TRUST_LEVELS),
	taint: Type.Array(literals(CONTEXT_TAINTS), { maxItems: CONTEXT_TAINTS.length, uniqueItems: true }),
	observedAt: timestamp,
} as const;

export const MemorySourceRefSchema = Type.Unsafe<MemorySourceRef>(Type.Union([
	exact({ ...sourceBase, sourceType: Type.Literal("user"), principalId: id("principal") }),
	exact({
		...sourceBase,
		sourceType: Type.Literal("session"),
		sessionId: id("session"),
		fromSequence: count,
		toSequence: count,
	}),
	exact({ ...sourceBase, sourceType: Type.Literal("agent"), agentId: id("agent"), sessionId: id("session") }),
	exact({ ...sourceBase, sourceType: Type.Literal("tool"), toolCallId: id("toolCall"), artifact: ArtifactRefSchema }),
	exact({ ...sourceBase, sourceType: literals(["web", "mcp", "import"] as const), artifact: ArtifactRefSchema }),
	exact({ ...sourceBase, sourceType: Type.Literal("compaction"), compactionId: id("compaction"), artifact: ArtifactRefSchema }),
]));

export const MemoryRefSchema = Type.Unsafe<MemoryRef>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	memoryId: id("memory"),
	scope: MemoryScopeRefSchema,
	revision: count,
	contentDigest: digest,
	status: literals(MEMORY_STATUSES),
}));

export const MemoryRecordSchema = Type.Unsafe<MemoryRecord>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	memoryId: id("memory"),
	scope: MemoryScopeRefSchema,
	revision: count,
	status: literals(MEMORY_STATUSES),
	title: Type.String({ minLength: 1, maxLength: 256 }),
	content: Type.String({ maxLength: MAX_MEMORY_CONTENT_CHARS }),
	contentDigest: digest,
	sourceRefs: Type.Array(MemorySourceRefSchema, { minItems: 1, maxItems: MAX_MEMORY_SOURCES }),
	approvalReceipt: Type.Optional(ApprovalReceiptRefSchema),
	createdByPrincipalId: id("principal"),
	createdAt: timestamp,
	updatedAt: timestamp,
	expiresAt: Type.Optional(timestamp),
	revokedAt: Type.Optional(timestamp),
	revokedByPrincipalId: Type.Optional(id("principal")),
	revocationRevision: count,
	supersedes: Type.Optional(MemoryRefSchema),
}));

export const MemoryFieldDiffSchema = Type.Unsafe<MemoryFieldDiff>(exact({
	field: literals(["title", "content", "scope", "sources", "expiresAt", "status"] as const),
	beforeDigest: Type.Optional(digest),
	afterDigest: Type.Optional(digest),
}));

export const MemoryDiffSchema = Type.Unsafe<MemoryDiff>(exact({
	kind: literals(["create", "update", "delete", "scope_change"] as const),
	before: Type.Optional(MemoryRefSchema),
	after: Type.Optional(MemoryRefSchema),
	changes: Type.Array(MemoryFieldDiffSchema, { minItems: 1, maxItems: 16 }),
	diffArtifact: ArtifactRefSchema,
	diffDigest: digest,
}));

export const MemoryProposalSchema = Type.Unsafe<MemoryProposal>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	proposalId: id("memoryProposal"),
	memory: MemoryRefSchema,
	diff: MemoryDiffSchema,
	status: literals(["pending", "approved", "rejected", "expired", "revoked"] as const),
	approvalId: id("approval"),
	approvalReceipt: Type.Optional(ApprovalReceiptRefSchema),
	proposedByPrincipalId: id("principal"),
	createdAt: timestamp,
	expiresAt: Type.Optional(timestamp),
}));

export const MemorySearchRequestSchema = Type.Unsafe<MemorySearchRequest>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("command"),
	query: Type.String({ minLength: 1, maxLength: 4_096 }),
	queryDigest: digest,
	scopes: Type.Array(MemoryScopeRefSchema, { minItems: 1, maxItems: 3 }),
	maxResults: Type.Integer({ minimum: 1, maximum: MAX_MEMORY_SEARCH_RESULTS }),
	maxSnippetChars: Type.Integer({ minimum: 1, maximum: MAX_MEMORY_SNIPPET_CHARS }),
	maxTotalTokens: Type.Integer({ minimum: 1, maximum: MAX_MEMORY_SEARCH_TOKENS }),
	cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	includeStale: Type.Boolean(),
}));

export const MemorySearchResultSchema = Type.Unsafe<MemorySearchResult>(exact({
	memory: MemoryRefSchema,
	score: Type.Number({ minimum: 0, maximum: 1 }),
	stale: Type.Boolean(),
	snippet: Type.String({ maxLength: MAX_MEMORY_SNIPPET_CHARS }),
	lineStart: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	lineEnd: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	sourceDigest: digest,
}));

export const MemorySearchReceiptSchema = Type.Unsafe<MemorySearchReceipt>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	requestId: id("command"),
	receiptId: id("receipt"),
	queryDigest: digest,
	mode: literals(["lexical", "vector", "hybrid", "none"] as const),
	indexDigest: digest,
	results: Type.Array(MemorySearchResultSchema, { maxItems: MAX_MEMORY_SEARCH_RESULTS }),
	nextCursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	diagnostics: Type.Array(token, { maxItems: 32 }),
	searchedAt: timestamp,
}));

export const MemoryInjectionReceiptSchema = Type.Unsafe<MemoryInjectionReceipt>(exact({
	schemaVersion: Type.Literal(MEMORY_SCHEMA_VERSION),
	authorityId: id("authority"),
	tenantId: id("tenant"),
	principalId: id("principal"),
	receiptId: id("receipt"),
	contextRequestId: id("contextRequest"),
	memories: Type.Array(MemoryRefSchema, { maxItems: MAX_MEMORY_SEARCH_RESULTS }),
	injectionDigest: digest,
	injectedAt: timestamp,
}));

function sameScope(
	value: { authorityId: string; tenantId: string },
	child: { authorityId: string; tenantId: string },
): boolean {
	return value.authorityId === child.authorityId && value.tenantId === child.tenantId;
}

function sourceSafeForApproval(source: MemorySourceRef): boolean {
	return source.trust === "system" || source.trust === "user_approved" || source.trust === "derived";
}

export function isMemoryScopeRef(value: unknown): value is MemoryScopeRef {
	return Check(MemoryScopeRefSchema, value);
}

export function isMemorySourceRef(value: unknown): value is MemorySourceRef {
	if (!Check(MemorySourceRefSchema, value)) return false;
	if (value.sourceType === "session" && value.fromSequence > value.toSequence) return false;
	if ("artifact" in value && !sameScope(value, value.artifact)) return false;
	if ((value.sourceType === "web" || value.sourceType === "mcp" || value.sourceType === "tool") && value.trust !== "untrusted") {
		return false;
	}
	return value.trust !== "system" || value.taint.length === 0;
}

export function isMemoryRef(value: unknown): value is MemoryRef {
	return Check(MemoryRefSchema, value);
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
	if (!Check(MemoryRecordSchema, value)) return false;
	if (!value.sourceRefs.every((source) => sameScope(value, source) && isMemorySourceRef(source))) return false;
	if (value.supersedes !== undefined && (!sameScope(value, value.supersedes) || value.supersedes.memoryId !== value.memoryId)) return false;
	if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) return false;
	if (value.status === "approved") {
		if (value.approvalReceipt === undefined || !isApprovalReceiptRef(value.approvalReceipt)) return false;
		if (!sameScope(value, value.approvalReceipt) || value.approvalReceipt.decision !== "allowed") return false;
		if (!value.sourceRefs.every(sourceSafeForApproval)) return false;
	}
	if (value.status === "revoked") {
		return value.revokedAt !== undefined && value.revokedByPrincipalId !== undefined && value.revocationRevision > 0;
	}
	if (value.status === "expired") return value.expiresAt !== undefined;
	return value.revokedAt === undefined && value.revokedByPrincipalId === undefined;
}

export function isMemoryDiff(value: unknown): value is MemoryDiff {
	if (!Check(MemoryDiffSchema, value)) return false;
	if (value.before !== undefined && value.after !== undefined) {
		if (!sameScope(value.before, value.after) || value.before.memoryId !== value.after.memoryId) return false;
	}
	if (value.kind === "create" && (value.before !== undefined || value.after === undefined)) return false;
	if (value.kind === "delete" && (value.before === undefined || value.after !== undefined)) return false;
	if ((value.kind === "update" || value.kind === "scope_change") && (value.before === undefined || value.after === undefined)) return false;
	const anchor = value.after ?? value.before;
	return anchor !== undefined && sameScope(anchor, value.diffArtifact);
}

export function isMemoryProposal(value: unknown): value is MemoryProposal {
	if (!Check(MemoryProposalSchema, value) || !sameScope(value, value.memory) || !isMemoryDiff(value.diff)) return false;
	const changed = value.diff.after ?? value.diff.before;
	if (changed === undefined || changed.memoryId !== value.memory.memoryId || changed.contentDigest !== value.memory.contentDigest) return false;
	if (value.status === "pending") return value.approvalReceipt === undefined;
	if (value.approvalReceipt === undefined || !isApprovalReceiptRef(value.approvalReceipt) || !sameScope(value, value.approvalReceipt)) {
		return false;
	}
	if (value.approvalReceipt.approvalId !== value.approvalId) return false;
	const decisions = { approved: "allowed", rejected: "denied", expired: "expired", revoked: "revoked" } as const;
	return value.approvalReceipt.decision === decisions[value.status];
}

export function isMemorySearchRequest(value: unknown): value is MemorySearchRequest {
	if (!Check(MemorySearchRequestSchema, value)) return false;
	return new Set(value.scopes.map((scope) => JSON.stringify(scope))).size === value.scopes.length;
}

export function isMemorySearchResult(value: unknown): value is MemorySearchResult {
	return Check(MemorySearchResultSchema, value) && value.lineStart <= value.lineEnd;
}

export function isMemorySearchReceipt(value: unknown): value is MemorySearchReceipt {
	return (
		Check(MemorySearchReceiptSchema, value) &&
		value.results.every((result) => sameScope(value, result.memory) && isMemorySearchResult(result)) &&
		new Set(value.results.map((result) => result.memory.memoryId)).size === value.results.length &&
		(value.mode !== "none" || value.results.length === 0)
	);
}

export function isMemoryInjectionReceipt(value: unknown): value is MemoryInjectionReceipt {
	return (
		Check(MemoryInjectionReceiptSchema, value) &&
		value.memories.every((memory) => sameScope(value, memory) && memory.status === "approved") &&
		new Set(value.memories.map((memory) => memory.memoryId)).size === value.memories.length
	);
}
