import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { propagateInputSources, type DeclassificationReceiptRef, type InputSourceRef } from "../../protocol/v3/taint.ts";
import type { CompactionSourceEntry } from "./cut-planner.ts";

export type CompactionInputMode = "verbatim" | "fitted" | "lossy";

export interface CompactionSummaryAttempt {
	mode: CompactionInputMode;
	inputDigest: string;
	inputChars: number;
	outcome: "completed" | "failed";
	errorDigest?: string;
}

export interface CompactionSummaryResult {
	summary: string;
	summaryDigest: string;
	inputSources: readonly InputSourceRef[];
	declassificationReceipts: readonly DeclassificationReceiptRef[];
	attempts: readonly CompactionSummaryAttempt[];
}

export interface CompactionSummarySampler {
	sample(input: string, options: { tools: readonly []; maxOutputTokens: number; timeoutMs: number }): Promise<string>;
}

function buildInput(entries: readonly CompactionSourceEntry[], mode: CompactionInputMode, maxInputChars: number): string {
	if (mode === "lossy") {
		return entries.map((entry) => JSON.stringify({
			sequence: entry.sequence,
			turnId: entry.turnId,
			kind: entry.kind,
			contentDigest: entry.contentDigest,
			artifactId: entry.artifact?.artifactId,
		})).join("\n");
	}
	const perEntry = mode === "verbatim" ? maxInputChars : Math.max(256, Math.floor(maxInputChars / Math.max(1, entries.length)));
	return entries.map((entry) => JSON.stringify({
		sequence: entry.sequence,
		turnId: entry.turnId,
		kind: entry.kind,
		content: entry.content.slice(0, perEntry),
		contentDigest: entry.contentDigest,
		artifactId: entry.artifact?.artifactId,
		inputSourceIds: entry.inputSources.map((source) => source.sourceId),
	})).join("\n").slice(0, maxInputChars);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("compaction summarizer timeout")), timeoutMs);
		operation.then(
			(value) => { clearTimeout(timer); resolve(value); },
			(error: unknown) => { clearTimeout(timer); reject(error); },
		);
	});
}

export async function summarizeCompactionEntries(options: {
	entries: readonly CompactionSourceEntry[];
	sampler: CompactionSummarySampler;
	maxInputChars: number;
	maxSummaryTokens: number;
	timeoutMs: number;
}): Promise<CompactionSummaryResult> {
	const sources = propagateInputSources(...options.entries.map((entry) => entry.inputSources));
	if (sources === undefined) throw new Error("compaction input source lineage is invalid or conflicting");
	const receipts = options.entries
		.flatMap((entry) => entry.declassificationReceipts)
		.filter((receipt, index, all) => all.findIndex((item) => item.receiptId === receipt.receiptId && item.receiptDigest === receipt.receiptDigest) === index)
		.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
	const attempts: CompactionSummaryAttempt[] = [];
	let lastError: unknown;
	for (const mode of ["verbatim", "fitted", "lossy"] as const) {
		const input = buildInput(options.entries, mode, options.maxInputChars);
		try {
			const summary = await withTimeout(
				options.sampler.sample(input, { tools: [], maxOutputTokens: options.maxSummaryTokens, timeoutMs: options.timeoutMs }),
				options.timeoutMs,
			);
			attempts.push({ mode, inputDigest: canonicalDigest(input), inputChars: input.length, outcome: "completed" });
			return { summary, summaryDigest: canonicalDigest(summary), inputSources: sources, declassificationReceipts: receipts, attempts };
		} catch (error) {
			lastError = error;
			attempts.push({
				mode,
				inputDigest: canonicalDigest(input),
				inputChars: input.length,
				outcome: "failed",
				errorDigest: canonicalDigest({ error: error instanceof Error ? error.message : "unknown" }),
			});
		}
	}
	throw new Error(`compaction summarizer exhausted bounded attempts: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}
