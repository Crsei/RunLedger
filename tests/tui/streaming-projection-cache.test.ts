import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import {
	makeTimelineProjectionBlocks,
	STREAMING_PROJECTION_BLOCK_COUNT,
} from "../../scripts/streaming-prefix-stability-fixtures.ts";

const WIDTH = 96;

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
});
