import { describe, expect, test } from "vitest";
import {
  MermaidProjectionCache,
  makeMermaidCacheKey,
  mermaidSourceDigest,
  mermaidWidthBucket,
} from "../../../src/tui/mermaid/cache.ts";
import { MERMAID_LIMITS, MERMAID_RENDER_REVISION } from "../../../src/tui/mermaid/limits.ts";
import type { MermaidProjectionResult } from "../../../src/tui/mermaid/types.ts";

function projection(bytes: number): MermaidProjectionResult {
  return {
    ok: true,
    width: 80,
    height: 1,
    lines: [{ text: "diagram", spans: [] }],
    estimatedBytes: bytes,
  };
}

describe("bounded Mermaid projection cache", () => {
  test("uses a SHA-256 source digest and an eight-column width bucket", () => {
    expect(mermaidSourceDigest("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(mermaidWidthBucket(80)).toBe(80);
    expect(mermaidWidthBucket(87)).toBe(80);
    expect(mermaidWidthBucket(88)).toBe(88);

    const key = makeMermaidCacheKey("hello", 87);
    expect(key).toEqual({
      sourceDigest: mermaidSourceDigest("hello"),
      width: 80,
      renderRevision: MERMAID_RENDER_REVISION,
    });
  });

  test("tracks miss/hit and keeps theme out of the geometry key", () => {
    const cache = new MermaidProjectionCache();
    const key = makeMermaidCacheKey("flowchart TD\nA --> B", 80);
    const value = projection(128);

    expect(cache.get(key)).toBeUndefined();
    cache.set(key, value);
    expect(cache.get(key)).toBe(value);
    expect(cache.get({ ...key, renderRevision: key.renderRevision })).toBe(value);
    expect(cache.snapshot()).toMatchObject({ entries: 1, hits: 2, misses: 1 });
  });

  test("evicts least-recently-used entries at the entry and byte budgets", () => {
    const cache = new MermaidProjectionCache({ maxEntries: 2, maxBytes: 10 });
    const first = makeMermaidCacheKey("first", 80);
    const second = makeMermaidCacheKey("second", 80);
    const third = makeMermaidCacheKey("third", 80);
    cache.set(first, projection(5));
    cache.set(second, projection(5));
    expect(cache.get(first)).toBeDefined();
    cache.set(third, projection(5));
    expect(cache.get(second)).toBeUndefined();
    expect(cache.snapshot()).toMatchObject({ entries: 2, bytes: 10, evictions: 1, misses: 1 });

    const oversized = makeMermaidCacheKey("oversized", 80);
    cache.set(oversized, projection(11));
    expect(cache.get(oversized)).toBeUndefined();
    expect(cache.snapshot().oversized).toBe(1);
  });

  test("bounds a long session of 200 diagrams and never stores source text", () => {
    const cache = new MermaidProjectionCache();
    for (let index = 0; index < 200; index += 1) {
      const source = `flowchart TD\nA${index}[Node ${index}] --> B${index}[Done]`;
      cache.set(makeMermaidCacheKey(source, 80), projection(256));
    }
    const snapshot = cache.snapshot();
    expect(snapshot.entries).toBeLessThanOrEqual(MERMAID_LIMITS.cacheEntries);
    expect(snapshot.bytes).toBeLessThanOrEqual(MERMAID_LIMITS.cacheBytes);
    expect(JSON.stringify(cache)).not.toContain("flowchart TD");
  });

  test("source mutation and render revision cannot reuse an old projection", () => {
    const cache = new MermaidProjectionCache();
    const original = makeMermaidCacheKey("A --> B", 80);
    const mutated = makeMermaidCacheKey("A --> C", 80);
    const revised = { ...original, renderRevision: original.renderRevision + 1 };
    cache.set(original, projection(10));
    expect(cache.get(mutated)).toBeUndefined();
    expect(cache.get(revised)).toBeUndefined();
  });
});
