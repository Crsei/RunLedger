import { describe, expect, test } from "vitest";
import {
	SettledPartCache,
	type SettledPartCacheKey,
} from "../../src/tui/opentui/settled-part-cache.ts";

const key = (partId: string, contentGeneration = 1, themeGeneration = 1, width = 80): SettledPartCacheKey => ({
	partId,
	width,
	contentGeneration,
	themeGeneration,
});

describe("SettledPartCache", () => {
	test("keys settled projections by part, width, content generation, and theme generation", () => {
		const cache = new SettledPartCache<string[]>({ maxEntries: 8, maxBytes: 1024 });
		const first = ["stable row"];

		cache.set(key("part-a"), first, 10);

		expect(cache.get(key("part-a"))).toBe(first);
		expect(cache.get(key("part-a", 1, 1, 100))).toBeUndefined();
		expect(cache.get(key("part-a", 2))).toBeUndefined();
		expect(cache.get(key("part-a", 1, 2))).toBeUndefined();
		expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 3, entries: 1, bytes: 10 });
	});

	test("rejects late writes and reads from an older content generation", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 8, maxBytes: 1024 });
		cache.set(key("part-a", 2), "new", 3);
		cache.set(key("part-a", 1), "late", 4);

		expect(cache.get(key("part-a", 2))).toBe("new");
		expect(cache.get(key("part-a", 1))).toBeUndefined();
		expect(cache.snapshot().staleWrites).toBe(1);
	});

	test("invalidates the previous theme generation for the same part", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 8, maxBytes: 1024 });
		cache.set(key("part-a", 1, 1), "dark", 4);
		cache.set(key("part-a", 1, 2), "light", 5);

		expect(cache.get(key("part-a", 1, 1))).toBeUndefined();
		expect(cache.get(key("part-a", 1, 2))).toBe("light");
	});

	test("evicts least recently used entries to keep both budgets bounded", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 2, maxBytes: 8 });
		cache.set(key("a"), "aaaa", 4);
		cache.set(key("b"), "bbbb", 4);
		expect(cache.get(key("a"))).toBe("aaaa");
		cache.set(key("c"), "cccc", 4);

		expect(cache.get(key("a"))).toBe("aaaa");
		expect(cache.get(key("b"))).toBeUndefined();
		expect(cache.get(key("c"))).toBe("cccc");
		expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 8, evictions: 1 });
	});

	test("does not retain an oversized value and clears on destroy", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 2, maxBytes: 4 });
		cache.set(key("large"), "too large", 5);
		expect(cache.get(key("large"))).toBeUndefined();
		expect(cache.snapshot().oversized).toBe(1);

		cache.set(key("ok"), "ok", 2);
		cache.destroy();
		expect(cache.get(key("ok"))).toBeUndefined();
		cache.set(key("after-destroy"), "nope", 2);
		expect(cache.snapshot().entries).toBe(0);
	});

	test("fences an older value even when the newer generation is too large to cache", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 2, maxBytes: 4 });
		cache.set(key("part-a", 1), "old", 3);
		cache.set(key("part-a", 2), "too large", 5);

		expect(cache.get(key("part-a", 1))).toBeUndefined();
		expect(cache.get(key("part-a", 2))).toBeUndefined();
	});

	test("clear resets the generation fence for a new session lineage", () => {
		const cache = new SettledPartCache<string>({ maxEntries: 2, maxBytes: 32 });
		cache.set(key("part-a", 4), "old session", 11);
		cache.clear();
		cache.set(key("part-a", 1), "new session", 11);

		expect(cache.get(key("part-a", 1))).toBe("new session");
	});
});
