import { performance } from "node:perf_hooks";
import { ChatContainer } from "../src/tui/components/chat-container.ts";
import { DeltaCoalescer } from "../src/tui/opentui/delta-coalescer.ts";
import { admitStreamingDiff } from "../src/tui/opentui/streaming-diff-admission.ts";
import { SettledPartCache } from "../src/tui/opentui/settled-part-cache.ts";
import { freezeStreamPrefix } from "../src/tui/opentui/settled-prefix.ts";
import { splitClosedStreamingTable } from "../src/tui/opentui/streaming-table-split.ts";
import type { PresentationBlock } from "../src/tui/presentation.ts";
import type { SafeDiffDocument } from "../src/tui/presentation/tools/types.ts";

export const STREAMING_PROJECTION_BLOCK_COUNT = 10_000;
export const STREAMING_PROJECTION_WIDTH = 96;

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
	readonly coldMs?: number;
	readonly warmMs?: number;
	readonly updateMs?: number;
	readonly warmReused?: boolean;
	readonly activeTailReplaced?: boolean;
	readonly stableSettledBlocks?: number;
	readonly wholeTimelineHits?: number;
	readonly settledBlockHits?: number;
	readonly blockProjectionMisses?: number;
	readonly cacheEntries?: number;
	readonly cacheHits?: number;
	readonly cacheMisses?: number;
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
		runTimelineProjectionCase(),
	];
}

export function makeTimelineProjectionBlocks(activeText: string): PresentationBlock[] {
	const blocks: PresentationBlock[] = [];
	for (let index = 0; index < STREAMING_PROJECTION_BLOCK_COUNT - 1; index += 1) {
		blocks.push({
			id: `timeline:history-${index}`,
			entryId: `timeline:history-${index}`,
			partId: `timeline:history-${index}/text`,
			contentGeneration: 1,
			finalized: true,
			kind: "text",
			content: `history ${index}`,
		});
	}
	blocks.push({
		id: "timeline:active",
		entryId: "timeline:active",
		partId: "timeline:active/text",
		contentGeneration: 2,
		finalized: false,
		kind: "markdown",
		content: activeText,
		streaming: true,
	});
	return blocks;
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

function runTimelineProjectionCase(): StreamingPrefixStressResult {
	const chat = new ChatContainer();
	const coldStartedAt = performance.now();
	chat.setTimelineBlocks(makeTimelineProjectionBlocks("draft"), 1);
	const cold = chat.present(STREAMING_PROJECTION_WIDTH);
	const coldMs = performance.now() - coldStartedAt;
	const coldCache = chat.getPresentationCacheSnapshot();

	const warmStartedAt = performance.now();
	const warm = chat.present(STREAMING_PROJECTION_WIDTH);
	const warmMs = performance.now() - warmStartedAt;

	const updateStartedAt = performance.now();
	chat.setTimelineBlocks(makeTimelineProjectionBlocks("draft grew"), 2);
	const updated = chat.present(STREAMING_PROJECTION_WIDTH);
	const updateMs = performance.now() - updateStartedAt;
	const updateCache = chat.getPresentationCacheSnapshot();
	const projection = chat.getTimelineProjectionSnapshot();
	const updatedTail = updated.at(-1);
	const stableSettledBlocks = updated.reduce(
		(total, block, index) => total + (index < cold.length - 1 && block === cold[index] ? 1 : 0),
		0,
	);

	return {
		name: "10000 timeline application projection",
		inputEvents: STREAMING_PROJECTION_BLOCK_COUNT,
		projectedItems: cold.length,
		textLossless: updated.length === STREAMING_PROJECTION_BLOCK_COUNT
			&& updatedTail?.kind === "markdown"
			&& updatedTail.content === "draft grew",
		coldMs: roundMilliseconds(coldMs),
		warmMs: roundMilliseconds(warmMs),
		updateMs: roundMilliseconds(updateMs),
		warmReused: warm === cold,
		activeTailReplaced: updatedTail !== cold.at(-1),
		stableSettledBlocks,
		wholeTimelineHits: projection.wholeTimelineHits,
		settledBlockHits: projection.settledBlockHits,
		blockProjectionMisses: projection.blockProjectionMisses,
		cacheEntries: updateCache.entries,
		cacheHits: updateCache.hits,
		cacheMisses: updateCache.misses - coldCache.misses,
		bounded: updateCache.entries <= 1_024 && updateCache.bytes <= 4 * 1024 * 1024,
	};
}

function roundMilliseconds(value: number): number {
	return Math.round(value * 1000) / 1000;
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
