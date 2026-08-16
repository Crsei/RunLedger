import { DeltaCoalescer } from "../src/tui/opentui/delta-coalescer.ts";
import { admitStreamingDiff } from "../src/tui/opentui/streaming-diff-admission.ts";
import { SettledPartCache } from "../src/tui/opentui/settled-part-cache.ts";
import { freezeStreamPrefix } from "../src/tui/opentui/settled-prefix.ts";
import { splitClosedStreamingTable } from "../src/tui/opentui/streaming-table-split.ts";
import type { SafeDiffDocument } from "../src/tui/presentation/tools/types.ts";

export interface StreamingPrefixStressResult {
	readonly name: string;
	readonly inputEvents?: number;
	readonly inputBytes?: number;
	readonly projectedItems?: number;
	readonly textLossless?: boolean;
	readonly openFence?: boolean;
	readonly settledEnd?: number;
	readonly split?: boolean;
	readonly prefixStable?: boolean;
	readonly admittedLines?: number;
	readonly tailLines?: number;
	readonly fallback?: "none" | "budget";
	readonly bounded?: boolean;
	readonly entries?: number;
	readonly oldGenerationVisible?: boolean;
	readonly terminalEvents?: number;
}

export function runStreamingPrefixStressCases(): readonly StreamingPrefixStressResult[] {
	return [
		runDeltaCase("10000 x 1-char delta", Array.from({ length: 10_000 }, () => "a")),
		runDeltaCase("1 MiB message", ["b".repeat(1024 * 1024)]),
		runOpenFenceCase(),
		runGrowingTableCase(),
	runStreamingDiffCase(),
	runCacheCase(),
		runLineageCase(),
	];
}

function runDeltaCase(name: string, chunks: readonly string[]): StreamingPrefixStressResult {
	const coalescer = new DeltaCoalescer();
	for (const text of chunks) {
		coalescer.push({
			kind: "append-text",
			entryId: "stress:assistant",
			partId: "stress:markdown",
			generation: 1,
			text,
		});
	}
	const drained = coalescer.drain();
	const source = chunks.join("");
	const projected = drained
		.filter((delta): delta is Extract<typeof delta, { kind: "append-text" }> => delta.kind === "append-text")
		.map((delta) => delta.text)
		.join("");
	return {
		name,
		inputEvents: chunks.length,
		inputBytes: Buffer.byteLength(source, "utf8"),
		projectedItems: drained.length,
		textLossless: source === projected,
	};
}

function runOpenFenceCase(): StreamingPrefixStressResult {
	const source = `\`\`\`ts\n${"x".repeat(16 * 1024)}`;
	const settled = freezeStreamPrefix(source);
	return {
		name: "open fence",
		inputBytes: Buffer.byteLength(source, "utf8"),
		openFence: settled === undefined,
		settledEnd: settled?.end ?? 0,
	};
}

function runGrowingTableCase(): StreamingPrefixStressResult {
	const first = [
		"| key | value |",
		"| --- | --- |",
		"| 1 | short |",
		"",
		"tail",
	].join("\n");
	const second = `${first} grows wider`;
	const firstSplit = splitClosedStreamingTable(first);
	const secondSplit = splitClosedStreamingTable(second);
	return {
		name: "growing table",
		split: firstSplit !== undefined && secondSplit !== undefined,
		prefixStable: firstSplit?.prefixText === secondSplit?.prefixText,
	};
}

function runStreamingDiffCase(): StreamingPrefixStressResult {
	const result = admitStreamingDiff(stressDiff(), { streaming: true });
	return {
		name: "streaming diff",
		admittedLines: result.admitted.length,
		tailLines: result.tail.length,
		fallback: result.fallback,
	};
}

function runCacheCase(): StreamingPrefixStressResult {
	const cache = new SettledPartCache<string>({ maxEntries: 64, maxBytes: 1_024 });
	for (let index = 0; index < 1_024; index += 1) {
		cache.set({ partId: `part-${index}`, width: 80, contentGeneration: 1, themeGeneration: 1 }, "row", 3);
	}
	const snapshot = cache.snapshot();
	return {
		name: "settled cache bound",
		bounded: snapshot.entries <= 64 && snapshot.bytes <= 1_024,
		entries: snapshot.entries,
	};
}

function runLineageCase(): StreamingPrefixStressResult {
	const cache = new SettledPartCache<string>({ maxEntries: 8, maxBytes: 128 });
	cache.set({ partId: "session-part", width: 80, contentGeneration: 1, themeGeneration: 1 }, "old", 3);
	const coalescer = new DeltaCoalescer();
	coalescer.push({ kind: "append-text", entryId: "session", partId: "part", generation: 1, text: "old" });
	coalescer.push({ kind: "terminal", patch: { kind: "complete", entryId: "session", generation: 1, status: "abort" } });
	cache.clear();
	cache.set({ partId: "session-part", width: 80, contentGeneration: 1, themeGeneration: 1 }, "new", 3);
	coalescer.push({ kind: "append-text", entryId: "session", partId: "part", generation: 2, text: "new" });
	coalescer.push({ kind: "terminal", patch: { kind: "complete", entryId: "session", generation: 2, status: "error" } });
	const terminalEvents = coalescer.drain().filter((delta) => delta.kind === "terminal").length;
	return {
		name: "abort/error lineage",
		oldGenerationVisible: cache.get({ partId: "session-part", width: 80, contentGeneration: 1, themeGeneration: 1 }) === "old",
		terminalEvents,
	};
}

function stressDiff(): SafeDiffDocument {
	const bounded = (text: string) => ({
		text,
		truncated: false,
		byteLength: Buffer.byteLength(text, "utf8"),
	});
	return {
		kind: "document",
		path: bounded("src/stress.ts"),
		hunks: [{
			oldStart: 1,
			newStart: 1,
			lines: [
				{ kind: "context", oldLine: 1, newLine: 1, text: bounded("const closed = true;") },
				{ kind: "add", newLine: 2, text: bounded("const tail = true;") },
			],
		}],
		addedLines: { state: "known", value: 1 },
		removedLines: { state: "known", value: 0 },
		truncated: false,
	};
}
