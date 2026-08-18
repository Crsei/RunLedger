export interface RenderCacheKey {
  readonly entryId: string;
  readonly partId: string;
  readonly width: number;
  readonly contentGeneration: number;
  readonly themeGeneration: number;
}

export interface RenderCacheOptions {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface RenderCacheSnapshot {
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly oversized: number;
}

interface CacheEntry<T> {
  readonly key: RenderCacheKey;
  readonly value: T;
  readonly bytes: number;
}

/**
 * 仅保存可重新生成的 UI 派生结果；原始 ledger/session 内容不进入此缓存。
 * Map 的迭代顺序作为简单 LRU，避免引入与 OpenTUI 绑定的缓存依赖。
 */
export class RenderCache<T> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private oversizedCount = 0;

  constructor(options: RenderCacheOptions) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes));
  }

  get(key: RenderCacheKey): T | undefined {
    const cacheKey = serializeKey(key);
    const entry = this.entries.get(cacheKey);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);
    return entry.value;
  }

  set(key: RenderCacheKey, value: T, bytes: number): void {
    const cacheKey = serializeKey(key);
    const normalizedBytes = Math.max(0, Math.floor(bytes));
    this.remove(cacheKey);
    if (normalizedBytes > this.maxBytes) {
      this.oversizedCount += 1;
      return;
    }
    this.entries.set(cacheKey, { key: { ...key }, value, bytes: normalizedBytes });
    this.totalBytes += normalizedBytes;
    this.evictToBudget();
  }

  invalidateEntry(entryId: string): number {
    return this.removeWhere((entry) => entry.key.entryId === entryId);
  }

  invalidateWidth(width: number): number {
    return this.removeWhere((entry) => entry.key.width === width);
  }

  invalidateGenerationBelow(contentGeneration: number): number {
    return this.removeWhere((entry) => entry.key.contentGeneration < contentGeneration);
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  snapshot(): RenderCacheSnapshot {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      oversized: this.oversizedCount,
    };
  }

  private evictToBudget(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) return;
      this.remove(oldestKey);
      this.evictionCount += 1;
    }
  }

  private remove(cacheKey: string): boolean {
    const entry = this.entries.get(cacheKey);
    if (!entry) return false;
    this.entries.delete(cacheKey);
    this.totalBytes -= entry.bytes;
    return true;
  }

  private removeWhere(predicate: (entry: CacheEntry<T>) => boolean): number {
    let removed = 0;
    for (const [cacheKey, entry] of this.entries) {
      if (!predicate(entry)) continue;
      this.remove(cacheKey);
      removed += 1;
    }
    return removed;
  }
}

function serializeKey(key: RenderCacheKey): string {
  return JSON.stringify([key.entryId, key.partId, key.width, key.contentGeneration, key.themeGeneration]);
}
