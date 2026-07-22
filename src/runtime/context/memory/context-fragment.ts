import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, type ContextRequestId, type PrincipalId } from "../../protocol/v3/ids.ts";
import type { DeclassificationReceiptRef, InputSourceKind, InputSourceRef, TaintLabel } from "../../protocol/v3/taint.ts";
import type { ContextFragment, ContextTaint } from "../types.ts";
import type { MemoryInjectionReceipt, MemoryRecord, MemorySearchReceipt, MemorySourceRef } from "./types.ts";

function sourceKind(source: MemorySourceRef): InputSourceKind {
	if (source.sourceType === "user") return "user";
	if (source.sourceType === "web") return "web";
	if (source.sourceType === "mcp") return "mcp";
	if (source.sourceType === "import") return "repository";
	return "model";
}

function taintLabels(source: MemorySourceRef): readonly TaintLabel[] {
	const labels = new Set<TaintLabel>();
	const mapping: Readonly<Record<ContextTaint, TaintLabel>> = {
		external_input: "external_untrusted",
		tool_output: "model_derived",
		model_generated: "model_derived",
		mutable_source: "repository_controlled",
		unverified: "external_untrusted",
		secret_candidate: "secret_derived",
	};
	for (const item of source.taint) labels.add(mapping[item]);
	const kind = sourceKind(source);
	if (["issue", "pull_request", "comment", "webhook", "web", "mcp"].includes(kind)) labels.add("external_untrusted");
	if (kind === "repository") labels.add("repository_controlled");
	if (kind === "model") labels.add("model_derived");
	return [...labels].sort();
}

function toInputSource(source: MemorySourceRef): InputSourceRef {
	const kind = sourceKind(source);
	const labels = taintLabels(source);
	return {
		schemaVersion: 1,
		authorityId: source.authorityId,
		tenantId: source.tenantId,
		sourceId: createRuntimeId("inputSource", `memory-${canonicalDigest(source).slice(0, 48)}`),
		kind,
		sourceDigest: source.sourceDigest,
		trust: labels.length > 0 ? (source.trust === "derived" ? "derived" : "tainted") : "trusted",
		taintLabels: labels,
		observedAt: source.observedAt,
	};
}

export function createMemoryContextFragment(options: {
	receipt: MemorySearchReceipt;
	records: readonly MemoryRecord[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	maxChars: number;
	maxTokens: number;
}): ContextFragment | undefined {
	const recordsById = new Map(options.records.map((record) => [record.memoryId, record]));
	const selected = options.receipt.results.flatMap((result) => {
		const record = recordsById.get(result.memory.memoryId);
		return record !== undefined && record.status === "approved" && record.contentDigest === result.memory.contentDigest ? [record] : [];
	});
	if (selected.length === 0) return undefined;
	const content = selected.map((record) => `## ${record.title} [${record.memoryId}@${record.contentDigest}]\n${record.content}`).join("\n\n").slice(0, options.maxChars);
	const sources = selected.flatMap((record) => record.sourceRefs.map(toInputSource));
	const uniqueSources = sources.filter((source, index, all) => all.findIndex((item) => item.sourceId === source.sourceId && item.sourceDigest === source.sourceDigest) === index);
	const taintFromLabels: Readonly<Partial<Record<TaintLabel, ContextTaint>>> = {
		external_untrusted: "external_input",
		repository_controlled: "mutable_source",
		candidate_controlled: "unverified",
		model_derived: "model_generated",
		secret_derived: "secret_candidate",
		executable_instruction: "unverified",
	};
	const taint = [...new Set(uniqueSources.flatMap((source) =>
		source.taintLabels.flatMap((label) => taintFromLabels[label] === undefined ? [] : [taintFromLabels[label] as ContextTaint]),
	))].sort();
	const contentDigest = canonicalDigest(content);
	const first = selected[0];
	if (first === undefined) return undefined;
	const scope = first.scope.scope;
	return {
		schemaVersion: 1,
		authorityId: first.authorityId,
		tenantId: first.tenantId,
		fragmentId: createRuntimeId("resource", `memory-fragment-${options.receipt.receiptId.slice(-40)}`),
		layer: scope === "user" ? "user_memory" : scope === "workspace" ? "workspace_knowledge" : "session_memory",
		order: 0,
		contentDigest,
		trust: "user_approved",
		taint,
		inputSources: uniqueSources,
		declassificationReceipts: options.declassificationReceipts,
		priority: "high",
		maxTokens: options.maxTokens,
		maxChars: options.maxChars,
		provenance: {
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			kind: "memory",
			memoryId: first.memoryId,
			recordDigest: canonicalDigest(selected.map((record) => ({ memoryId: record.memoryId, contentDigest: record.contentDigest }))),
			sourceDigest: options.receipt.indexDigest,
			observedAt: options.receipt.searchedAt,
		},
		storage: "inline",
		content,
	};
}

export function createMemoryInjectionReceipt(options: {
	receipt: MemorySearchReceipt;
	records: readonly MemoryRecord[];
	contextRequestId: ContextRequestId;
	principalId: PrincipalId;
	injectedAt: string;
}): MemoryInjectionReceipt {
	const byId = new Map(options.records.map((record) => [record.memoryId, record]));
	const memories = options.receipt.results.flatMap((result) => {
		const record = byId.get(result.memory.memoryId);
		return record !== undefined && record.status === "approved" && record.contentDigest === result.memory.contentDigest ? [{
			schemaVersion: 1 as const,
			authorityId: record.authorityId,
			tenantId: record.tenantId,
			memoryId: record.memoryId,
			scope: record.scope,
			revision: record.revision,
			contentDigest: record.contentDigest,
			status: "approved" as const,
		}] : [];
	});
	const injectionDigest = canonicalDigest({ contextRequestId: options.contextRequestId, memories });
	return {
		schemaVersion: 1,
		authorityId: options.receipt.authorityId,
		tenantId: options.receipt.tenantId,
		principalId: options.principalId,
		receiptId: createRuntimeId("receipt", `memory-inject-${injectionDigest.slice(0, 40)}`),
		contextRequestId: options.contextRequestId,
		memories,
		injectionDigest,
		injectedAt: options.injectedAt,
	};
}
