import { createHash } from "node:crypto";
import {
  RenderCache,
  type RenderCacheKey,
  type RenderCacheOptions,
  type RenderCacheSnapshot,
} from "../opentui/render-cache.ts";
import { MERMAID_LIMITS, MERMAID_RENDER_REVISION } from "./limits.ts";
import type { MermaidProjectionResult } from "./types.ts";

export interface MermaidRenderCacheKey {
  readonly sourceDigest: string;
  readonly width: number;
  readonly renderRevision: number;
}

export interface MermaidProjectionCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export type MermaidProjectionCacheSnapshot = RenderCacheSnapshot;

export function mermaidSourceDigest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function mermaidWidthBucket(width: number): number {
  const normalizedWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  return Math.max(1, Math.floor(normalizedWidth / MERMAID_LIMITS.widthBucket) * MERMAID_LIMITS.widthBucket);
}

export function makeMermaidCacheKey(
  source: string,
  width: number,
  renderRevision = MERMAID_RENDER_REVISION,
): MermaidRenderCacheKey {
  return makeMermaidCacheKeyFromDigest(mermaidSourceDigest(source), width, renderRevision);
}

export function makeMermaidCacheKeyFromDigest(
  sourceDigest: string,
  width: number,
  renderRevision = MERMAID_RENDER_REVISION,
): MermaidRenderCacheKey {
  return {
    sourceDigest,
    width: mermaidWidthBucket(width),
    renderRevision,
  };
}

/**
 * Mermaid projection 的有界 wrapper。只接受 digest key，不持有 source，底层 LRU
 * 复用 OpenTUI 的 RenderCache，确保长会话不会按 diagram 数量无界增长。
 */
export class MermaidProjectionCache {
  private readonly cache: RenderCache<MermaidProjectionResult>;

  constructor(options: MermaidProjectionCacheOptions = {}) {
    const cacheOptions: RenderCacheOptions = {
      maxEntries: options.maxEntries ?? MERMAID_LIMITS.cacheEntries,
      maxBytes: options.maxBytes ?? MERMAID_LIMITS.cacheBytes,
    };
    this.cache = new RenderCache<MermaidProjectionResult>(cacheOptions);
  }

  get(key: MermaidRenderCacheKey): MermaidProjectionResult | undefined {
    return this.cache.get(toRenderCacheKey(key));
  }

  set(key: MermaidRenderCacheKey, value: MermaidProjectionResult): void {
    this.cache.set(toRenderCacheKey(key), value, projectionBytes(value));
  }

  snapshot(): MermaidProjectionCacheSnapshot {
    return this.cache.snapshot();
  }

  clear(): void {
    this.cache.clear();
  }
}

function toRenderCacheKey(key: MermaidRenderCacheKey): RenderCacheKey {
  return {
    entryId: key.sourceDigest,
    partId: "mermaid",
    width: key.width,
    contentGeneration: key.renderRevision,
    themeGeneration: 0,
  };
}

function projectionBytes(value: MermaidProjectionResult): number {
  if (!value.ok) return 64;
  return Math.max(1, value.estimatedBytes);
}
