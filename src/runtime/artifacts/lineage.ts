/** Artifact 的输入来源、taint 上界与 sink 去污判定。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	inputSourcesAllowedAtSink,
	isDeclassificationReceiptRef,
	isInputSourceRef,
	propagateInputSources,
	type DeclassificationReceiptRef,
	type TaintLabel,
	type TaintSink,
} from "../protocol/v3/taint.ts";
import type {
	ArtifactLineage,
	ArtifactLineageInput,
	ArtifactResult,
	ArtifactScope,
} from "./types.ts";

const TAINT_ORDER: readonly TaintLabel[] = [
	"external_untrusted",
	"repository_controlled",
	"candidate_controlled",
	"model_derived",
	"secret_derived",
	"executable_instruction",
];

function failure(message: string): ArtifactResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function lineageBody(lineage: ArtifactLineage): Omit<ArtifactLineage, "lineageDigest"> {
	const { lineageDigest: _lineageDigest, ...body } = lineage;
	return body;
}

function scopeMatches(scope: ArtifactScope, value: ArtifactScope): boolean {
	return scope.authorityId === value.authorityId && scope.tenantId === value.tenantId;
}

function uniqueReceipts(
	receipts: readonly DeclassificationReceiptRef[],
): readonly DeclassificationReceiptRef[] | undefined {
	const byIdentity = new Map<string, DeclassificationReceiptRef>();
	for (const receipt of receipts) {
		if (!isDeclassificationReceiptRef(receipt)) return undefined;
		const key = `${receipt.receiptId}/${receipt.receiptDigest}`;
		if (byIdentity.has(key)) return undefined;
		byIdentity.set(key, receipt);
	}
	return [...byIdentity.values()].sort((left, right) =>
		`${left.receiptId}/${left.receiptDigest}`.localeCompare(`${right.receiptId}/${right.receiptDigest}`),
	);
}

function taintUpperBound(sources: NonNullable<ReturnType<typeof propagateInputSources>>): readonly TaintLabel[] {
	const labels = new Set(sources.flatMap((source) => source.taintLabels));
	return TAINT_ORDER.filter((label) => labels.has(label));
}

function finalizeLineage(body: Omit<ArtifactLineage, "lineageDigest">): ArtifactLineage {
	return { ...body, lineageDigest: canonicalDigest(body) };
}

export function createArtifactLineage(
	scope: ArtifactScope,
	input: ArtifactLineageInput | undefined,
	legacy = false,
): ArtifactResult<ArtifactLineage> {
	if (legacy) {
		const body: Omit<ArtifactLineage, "lineageDigest"> = {
			origin: "legacy",
			status: "legacy_unverified",
			inputSources: [],
			taintUpperBound: ["external_untrusted"],
			declassificationReceipts: [],
		};
		return { ok: true, value: finalizeLineage(body) };
	}
	if (!input) {
		const body: Omit<ArtifactLineage, "lineageDigest"> = {
			origin: "external",
			status: "quarantined",
			inputSources: [],
			taintUpperBound: ["external_untrusted"],
			declassificationReceipts: [],
		};
		return { ok: true, value: finalizeLineage(body) };
	}
	const sources = propagateInputSources(input.inputSources);
	const receipts = uniqueReceipts(input.declassificationReceipts);
	if (!sources || !receipts || sources.length > 256 || receipts.length > 256) {
		return failure("Artifact lineage contains invalid, duplicate, or oversized sources/receipts");
	}
	if (
		sources.some((source) => !scopeMatches(scope, source)) ||
		receipts.some((receipt) =>
			!scopeMatches(scope, receipt) ||
			!sources.some(
				(source) => source.sourceId === receipt.sourceId && source.sourceDigest === receipt.sourceDigest,
			),
		)
	) return failure("Artifact lineage crosses authority/tenant or contains an unrelated declassification receipt");
	const requiresSource = input.origin === "external" || input.origin === "candidate" || input.origin === "model_derived";
	const status = requiresSource && sources.length === 0 ? "quarantined" as const : "verified" as const;
	const body: Omit<ArtifactLineage, "lineageDigest"> = {
		origin: input.origin,
		status,
		inputSources: sources,
		taintUpperBound: taintUpperBound(sources),
		declassificationReceipts: receipts,
	};
	return { ok: true, value: finalizeLineage(body) };
}

export function isArtifactLineage(value: ArtifactLineage, scope?: ArtifactScope): boolean {
	try {
		if (
			!["internal", "user", "external", "candidate", "model_derived", "legacy"].includes(value.origin) ||
			!["verified", "quarantined", "legacy_unverified"].includes(value.status) ||
			!value.inputSources.every(isInputSourceRef) ||
			!value.declassificationReceipts.every(isDeclassificationReceiptRef)
		) return false;
		const propagated = propagateInputSources(value.inputSources);
		const receipts = uniqueReceipts(value.declassificationReceipts);
		if (!propagated || propagated.length !== value.inputSources.length || !receipts) return false;
		if (
			scope &&
			(propagated.some((source) => !scopeMatches(scope, source)) ||
				receipts.some((receipt) => !scopeMatches(scope, receipt)))
		) return false;
		if (
			value.origin === "legacy" && value.status !== "legacy_unverified" ||
			value.origin !== "legacy" && value.status === "legacy_unverified" ||
			canonicalDigest(value.taintUpperBound) !== canonicalDigest(taintUpperBound(propagated)) &&
				!(value.status !== "verified" && value.taintUpperBound.includes("external_untrusted"))
		) return false;
		return value.lineageDigest === canonicalDigest(lineageBody(value));
	} catch {
		return false;
	}
}

export function artifactLineageAllowsSink(
	lineage: ArtifactLineage,
	sink: TaintSink,
	additionalReceipts: readonly DeclassificationReceiptRef[],
	at: Date,
): boolean {
	if (lineage.lineageDigest !== canonicalDigest(lineageBody(lineage))) return false;
	if (sink === "context") return true;
	if (lineage.status !== "verified") return false;
	const receipts = uniqueReceipts([...lineage.declassificationReceipts, ...additionalReceipts]);
	return receipts !== undefined && inputSourcesAllowedAtSink(lineage.inputSources, sink, receipts, at);
}

/** 派生/摘要/merge 只能合并 lineage；任何 quarantine/legacy 状态都会向下游传播。 */
export function mergeArtifactLineage(
	scope: ArtifactScope,
	origin: Exclude<ArtifactLineage["origin"], "legacy">,
	inputs: readonly ArtifactLineage[],
): ArtifactResult<ArtifactLineage> {
	if (inputs.length === 0) return createArtifactLineage(scope, { origin, inputSources: [], declassificationReceipts: [] });
	if (inputs.some((lineage) => lineage.lineageDigest !== canonicalDigest(lineageBody(lineage)))) {
		return failure("cannot merge invalid Artifact lineage");
	}
	const merged = createArtifactLineage(scope, {
		origin,
		inputSources: inputs.flatMap((lineage) => lineage.inputSources),
		declassificationReceipts: inputs.flatMap((lineage) => lineage.declassificationReceipts),
	});
	if (!merged.ok) return merged;
	if (inputs.some((lineage) => lineage.status !== "verified")) {
		const body: Omit<ArtifactLineage, "lineageDigest"> = {
			...lineageBody(merged.value),
			status: "quarantined",
			taintUpperBound: TAINT_ORDER.filter((label) =>
				inputs.some((lineage) => lineage.taintUpperBound.includes(label)) || merged.value.taintUpperBound.includes(label),
			),
		};
		return { ok: true, value: finalizeLineage(body) };
	}
	return merged;
}
