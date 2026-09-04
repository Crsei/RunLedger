import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import { projectToolStart } from "../../src/tui/presentation/tools/projector.ts";
import { timelineToBlocks } from "../../src/tui/timeline/selectors.ts";
import type { TimelineRow, TimelineState } from "../../src/tui/timeline/types.ts";
import {
	makeTimelineProjectionBlocks,
	STREAMING_PROJECTION_BLOCK_COUNT,
} from "../../scripts/streaming-prefix-stability-fixtures.ts";

const WIDTH = 96;
const STARTED_AT = "2026-09-04T00:00:00.000Z";

function committedHistoryRow(index: number): TimelineRow {
	const text = `history-${index}`;
	return {
		kind: "user",
		id: `user:${index}`,
		timestamp: STARTED_AT,
		displayOrder: index,
		status: "succeeded",
		generation: 1,
		text: { text, truncated: false, byteLength: text.length },
	};
}

function activeReadRow(index: number): TimelineRow {
	return {
		kind: "tool",
		id: `tool:read-${index}`,
		timestamp: STARTED_AT,
		displayOrder: 10_000 + index,
		status: "running",
		generation: index + 1,
		toolCallId: `read-${index}`,
		toolName: { text: "read", truncated: false, byteLength: 4 },
		presentation: { state: "known", value: projectToolStart("read", { path: `src/${index}.ts` }, STARTED_AT) },
	};
}

function timelineWithActiveReads(committedRows: readonly TimelineRow[], activeRows: readonly TimelineRow[]): TimelineState {
	return {
		generation: activeRows.length + 1,
		committedRows,
		activeRowsByCorrelationId: Object.fromEntries(activeRows.map((row) => [row.kind === "tool" ? row.toolCallId : row.id, row])),
		activeOrder: activeRows.map((row) => row.kind === "tool" ? row.toolCallId : row.id),
		cursor: { messageIndex: committedRows.length },
	};
}

describe("ChatContainer application-level streaming projection", () => {
	test("reuses 10,000 settled blocks when only the active tail changes", () => {
		const chat = new ChatContainer();
		const firstTimeline = makeTimelineProjectionBlocks("draft");

		const coldStartedAt = performance.now();
		chat.setTimelineBlocks(firstTimeline, 1);
		const cold = chat.present(WIDTH);
		const coldMs = performance.now() - coldStartedAt;
		const coldCache = chat.getPresentationCacheSnapshot();

		const warmStartedAt = performance.now();
		const warm = chat.present(WIDTH);
		const warmMs = performance.now() - warmStartedAt;

		const updateStartedAt = performance.now();
		chat.setTimelineBlocks(makeTimelineProjectionBlocks("draft grew"), 2);
		const updated = chat.present(WIDTH);
		const updateMs = performance.now() - updateStartedAt;
		const updateCache = chat.getPresentationCacheSnapshot();
		const projection = chat.getTimelineProjectionSnapshot();

		expect(cold).toHaveLength(STREAMING_PROJECTION_BLOCK_COUNT);
		expect(warm).toBe(cold);
		expect(updated).toHaveLength(STREAMING_PROJECTION_BLOCK_COUNT);
		expect(updated.slice(0, -1).every((block, index) => block === cold[index])).toBe(true);
		expect(updated.at(-1)).not.toBe(cold.at(-1));
		expect(coldCache.misses).toBe(STREAMING_PROJECTION_BLOCK_COUNT - 1);
		expect(updateCache.entries).toBeLessThanOrEqual(1024);
		expect(projection).toMatchObject({
			calls: 3,
			wholeTimelineHits: 1,
			settledBlockHits: STREAMING_PROJECTION_BLOCK_COUNT - 1,
			blockProjectionMisses: STREAMING_PROJECTION_BLOCK_COUNT + 1,
		});

		// Keep the measured values attached to the assertion so the benchmark cannot
		// silently stop exercising all three application-level paths.
		expect({ coldMs, warmMs, updateMs }).toEqual(expect.objectContaining({
			coldMs: expect.any(Number),
			warmMs: expect.any(Number),
			updateMs: expect.any(Number),
		}));
	});

	test("reuses 10,000 committed timeline blocks when an active exploration group grows", () => {
		const chat = new ChatContainer();
		const committedRows = Array.from({ length: 10_000 }, (_, index) => committedHistoryRow(index));
		const firstActive = activeReadRow(1);
		const firstBlocks = timelineToBlocks(timelineWithActiveReads(committedRows, [firstActive]));

		chat.setTimelineBlocks(firstBlocks, 1);
		const first = chat.present(WIDTH);

		const secondActive = activeReadRow(2);
		const updatedBlocks = timelineToBlocks(timelineWithActiveReads(committedRows, [firstActive, secondActive]));
		chat.setTimelineBlocks(updatedBlocks, 2);
		const updated = chat.present(WIDTH);

		expect(first).toHaveLength(10_001);
		expect(updated).toHaveLength(10_001);
		expect(updated.slice(0, 10_000).every((block, index) => block === first[index])).toBe(true);
		expect(updated.at(-1)).not.toBe(first.at(-1));
		expect(updated.at(-1)).toMatchObject({
			id: "exploration-tool:read-1",
			kind: "exploration",
			finalized: false,
			actions: [{ id: "read-1" }, { id: "read-2" }],
		});
		expect(chat.getTimelineProjectionSnapshot()).toMatchObject({
			settledBlockHits: 10_000,
			blockProjectionMisses: 10_002,
		});
	});
});
