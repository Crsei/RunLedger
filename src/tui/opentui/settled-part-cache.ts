/**
 * settled presentation 的有界 LRU。
 *
 * 这里的值永远是可重建的 UI 派生数据；`partId` 与两类 generation 组成
 * presentation lineage，迟到的异步结果不能覆盖较新的 lineage。
 */

export interface SettledPartCacheKey {
	readonly partId: string;
	readonly width: number;
	readonly contentGeneration: number;
	readonly themeGeneration: number;
}

export interface SettledPartCacheOptions {
	readonly maxEntries: number;
	readonly maxBytes: number;
}

export interface SettledPartCacheSnapshot {
	readonly entries: number;
	readonly bytes: number;
	readonly hits: number;
	readonly misses: number;
	readonly evictions: number;
	readonly oversized: number;
	readonly staleReads: number;
	readonly staleWrites: number;
}

interface CacheEntry<T> {
	readonly key: SettledPartCacheKey;
	readonly value: T;
	readonly bytes: number;
}

interface GenerationFence {
	readonly contentGeneration: number;
	readonly themeGeneration: number;
}

export class SettledPartCache<T> {
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly entries = new Map<string, CacheEntry<T>>();
	private readonly fences = new Map<string, GenerationFence>();
	private totalBytes = 0;
	private hitCount = 0;
	private missCount = 0;
	private evictionCount = 0;
	private oversizedCount = 0;
	private staleReadCount = 0;
	private staleWriteCount = 0;
	private destroyed = false;

	constructor(options: SettledPartCacheOptions) {
		this.maxEntries = boundedPositiveInteger(options.maxEntries);
		this.maxBytes = boundedPositiveInteger(options.maxBytes);
	}

	get(key: SettledPartCacheKey): T | undefined {
		if (this.destroyed) {
			this.missCount += 1;
			return undefined;
		}
		const fence = this.fences.get(key.partId);
		if (fence !== undefined && isOlderThanFence(key, fence)) {
			this.staleReadCount += 1;
			this.missCount += 1;
			return undefined;
		}
		const cacheKey = serializeKey(key);
		const entry = this.entries.get(cacheKey);
		if (entry === undefined) {
			this.missCount += 1;
			return undefined;
		}
		this.hitCount += 1;
		this.entries.delete(cacheKey);
		this.entries.set(cacheKey, entry);
		return entry.value;
	}

	set(key: SettledPartCacheKey, value: T, bytes: number): void {
		if (this.destroyed) return;
		const normalizedBytes = Math.max(0, Math.floor(bytes));
		const currentFence = this.fences.get(key.partId);
		if (currentFence !== undefined && isOlderThanFence(key, currentFence)) {
			this.staleWriteCount += 1;
			return;
		}
		if (currentFence === undefined || isNewerThanFence(key, currentFence)) {
			this.fences.set(key.partId, {
				contentGeneration: key.contentGeneration,
				themeGeneration: key.themeGeneration,
			});
			this.removeWhere((entry) => entry.key.partId === key.partId && isOlderThanFence(entry.key, key));
		}
		const cacheKey = serializeKey(key);
		this.remove(cacheKey);
		if (normalizedBytes > this.maxBytes) {
			this.oversizedCount += 1;
			return;
		}
		this.entries.set(cacheKey, { key: { ...key }, value, bytes: normalizedBytes });
		this.totalBytes += normalizedBytes;
		this.evictToBudget();
	}

	invalidatePart(partId: string): number {
		this.fences.delete(partId);
		return this.removeWhere((entry) => entry.key.partId === partId);
	}

	invalidateGenerationBelow(contentGeneration: number): number {
		return this.removeWhere((entry) => entry.key.contentGeneration < contentGeneration);
	}

	invalidateThemeBelow(themeGeneration: number): number {
		return this.removeWhere((entry) => entry.key.themeGeneration < themeGeneration);
	}

	clear(): void {
		this.entries.clear();
		this.fences.clear();
		this.totalBytes = 0;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.clear();
	}

	snapshot(): SettledPartCacheSnapshot {
		return {
			entries: this.entries.size,
			bytes: this.totalBytes,
			hits: this.hitCount,
			misses: this.missCount,
			evictions: this.evictionCount,
			oversized: this.oversizedCount,
			staleReads: this.staleReadCount,
			staleWrites: this.staleWriteCount,
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
		if (entry === undefined) return false;
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

function serializeKey(key: SettledPartCacheKey): string {
	return JSON.stringify([key.partId, key.width, key.contentGeneration, key.themeGeneration]);
}

function isOlderThanFence(key: SettledPartCacheKey, fence: GenerationFence): boolean {
	return key.contentGeneration < fence.contentGeneration
		|| (key.contentGeneration === fence.contentGeneration && key.themeGeneration < fence.themeGeneration);
}

function isNewerThanFence(key: SettledPartCacheKey, fence: GenerationFence): boolean {
	return key.contentGeneration > fence.contentGeneration
		|| (key.contentGeneration === fence.contentGeneration && key.themeGeneration > fence.themeGeneration);
}

function boundedPositiveInteger(value: number): number {
	return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
