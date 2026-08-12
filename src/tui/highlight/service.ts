import { createHash } from "node:crypto";
import type { HighlightColor, HighlightFallbackReason, HighlightResult } from "./contracts.ts";
import type { NativeSyntaxAddon } from "./native-loader.ts";
import type { TuiPerformanceObserver } from "../opentui/performance-observer.ts";

const MAX_HIGHLIGHT_BYTES = 512 * 1024;
const MAX_HIGHLIGHT_LINES = 10_000;

export interface SyntaxHighlightRequest {
	readonly key: string;
	readonly source: string;
	readonly language: string;
	readonly themeName: string;
	readonly themeRevision: number;
	readonly priority?: SyntaxHighlightPriority;
}

export type SyntaxHighlightPriority = "visible" | "overscan" | "background";

export interface SyntaxHighlightServiceOptions {
	readonly addon?: NativeSyntaxAddon;
	readonly maxConcurrency?: number;
	readonly maxQueuedJobs?: number;
	readonly maxQueuedBytes?: number;
	readonly maxCacheEntries?: number;
	readonly maxCacheBytes?: number;
	readonly maxCacheSpans?: number;
	readonly timeoutMs?: number;
	readonly performanceObserver?: TuiPerformanceObserver;
	readonly now?: () => number;
}

export interface SyntaxHighlightServiceSnapshot {
	readonly activeJobs: number;
	readonly queuedJobs: number;
	readonly queuedBytes: number;
	readonly cacheEntries: number;
	readonly cacheBytes: number;
	readonly cacheSpans: number;
	readonly cacheEvictions: number;
	readonly cacheHits: number;
	readonly cacheMisses: number;
}

interface PendingJob {
	readonly request: SyntaxHighlightRequest;
	readonly sourceBytes: number;
	readonly resolve: (result: HighlightResult) => void;
	readonly timing: HighlightTiming;
	readonly priority: SyntaxHighlightPriority;
	readonly sequence: number;
}

interface HighlightTiming {
	readonly requestedAt: number;
	nativeStartedAt?: number;
	nativeEndedAt?: number;
	adapterEndedAt?: number;
}

interface CacheEntry {
	readonly result: Extract<HighlightResult, { readonly ok: true }>;
	readonly bytes: number;
	readonly spans: number;
}

/** 有界 latest-wins scheduler；正文始终只存在于调用方 request，不进入持久状态。 */
export class SyntaxHighlightService {
	private readonly addon: NativeSyntaxAddon | undefined;
	private readonly maxConcurrency: number;
	private readonly maxQueuedJobs: number;
	private readonly maxQueuedBytes: number;
	private readonly maxCacheEntries: number;
	private readonly maxCacheBytes: number;
	private readonly maxCacheSpans: number;
	private readonly timeoutMs: number;
	private readonly performanceObserver: TuiPerformanceObserver | undefined;
	private readonly engineBuildId: string;
	private readonly now: () => number;
	private readonly activeKeys = new Set<string>();
	private readonly queue = new Map<string, PendingJob>();
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inFlightByCacheKey = new Map<string, Promise<HighlightResult>>();
	private activeJobs = 0;
	private queuedBytes = 0;
	private cacheBytes = 0;
	private cacheSpans = 0;
	private cacheEvictions = 0;
	private cacheHits = 0;
	private cacheMisses = 0;
	private destroyed = false;
	private nextSequence = 0;

	constructor(options: SyntaxHighlightServiceOptions = {}) {
		this.addon = options.addon;
		this.maxConcurrency = boundedInteger(options.maxConcurrency, 2);
		this.maxQueuedJobs = boundedInteger(options.maxQueuedJobs, 64);
		this.maxQueuedBytes = boundedInteger(options.maxQueuedBytes, 2 * 1024 * 1024);
		this.maxCacheEntries = boundedInteger(options.maxCacheEntries, 128);
		this.maxCacheBytes = boundedInteger(options.maxCacheBytes, 4 * 1024 * 1024);
		this.maxCacheSpans = boundedInteger(options.maxCacheSpans, 200_000);
		this.timeoutMs = boundedInteger(options.timeoutMs, 2_000);
		this.performanceObserver = options.performanceObserver;
		this.engineBuildId = options.addon?.engineInfo().engineBuildId ?? "native-unavailable";
		this.now = options.now ?? (() => performance.now());
	}

	highlight(request: SyntaxHighlightRequest): Promise<HighlightResult> {
		const startedAt = this.now();
		const timing: HighlightTiming = { requestedAt: startedAt };
		const guard = guardRequest(request.source);
		if (guard !== undefined) return this.observe(request, Promise.resolve({ ok: false, reason: guard }), timing, false);
		if (this.destroyed) return this.observe(request, Promise.resolve({ ok: false, reason: "stale_generation" }), timing, false);
		if (this.addon === undefined) return this.observe(request, Promise.resolve({ ok: false, reason: "native_unavailable" }), timing, false);

		const cacheKey = cacheKeyFor(this.engineBuildId, request);
		const cached = this.cache.get(cacheKey);
		if (cached !== undefined) {
			this.cacheHits += 1;
			this.cache.delete(cacheKey);
			this.cache.set(cacheKey, cached);
			return this.observe(request, Promise.resolve(cached.result), timing, true);
		}
		this.cacheMisses += 1;
		const existingWork = this.inFlightByCacheKey.get(cacheKey);
		if (existingWork !== undefined) return this.observe(request, existingWork, timing, false);

		const work = new Promise<HighlightResult>((resolve) => {
			const job: PendingJob = {
				request,
				sourceBytes: Buffer.byteLength(request.source, "utf8"),
				resolve,
				timing,
				priority: request.priority ?? "background",
				sequence: this.nextSequence++,
			};
			if (!this.activeKeys.has(request.key) && this.activeJobs < this.maxConcurrency) {
				this.start(job);
				return;
			}
			this.enqueue(job);
		});
		this.inFlightByCacheKey.set(cacheKey, work);
		void work.then(
			() => this.clearInFlight(cacheKey, work),
			() => this.clearInFlight(cacheKey, work),
		);
		return this.observe(request, work, timing, false);
	}

	cancel(key: string): boolean {
		const queued = this.queue.get(key);
		if (queued === undefined) return false;
		this.queue.delete(key);
		this.queuedBytes -= queued.sourceBytes;
		queued.resolve({ ok: false, reason: "stale_generation" });
		return true;
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		for (const job of this.queue.values()) job.resolve({ ok: false, reason: "stale_generation" });
		this.queue.clear();
		this.queuedBytes = 0;
		this.cache.clear();
		this.cacheBytes = 0;
		this.cacheSpans = 0;
	}

	snapshot(): SyntaxHighlightServiceSnapshot {
		return {
			activeJobs: this.activeJobs,
			queuedJobs: this.queue.size,
			queuedBytes: this.queuedBytes,
			cacheEntries: this.cache.size,
			cacheBytes: this.cacheBytes,
			cacheSpans: this.cacheSpans,
			cacheEvictions: this.cacheEvictions,
			cacheHits: this.cacheHits,
			cacheMisses: this.cacheMisses,
		};
	}

	foregroundForScopes(theme: string, scopes: readonly string[]): HighlightColor | undefined {
		return this.destroyed ? undefined : this.addon?.foregroundForScopes(theme, scopes);
	}

	diffScopeBackgrounds(theme: string): { readonly inserted?: HighlightColor; readonly deleted?: HighlightColor } | undefined {
		return this.destroyed ? undefined : this.addon?.diffScopeBackgrounds(theme);
	}

	private enqueue(job: PendingJob): void {
		const previous = this.queue.get(job.request.key);
		const projectedJobs = this.queue.size + (previous === undefined ? 1 : 0);
		const projectedBytes = this.queuedBytes - (previous?.sourceBytes ?? 0) + job.sourceBytes;
		if (projectedJobs > this.maxQueuedJobs || projectedBytes > this.maxQueuedBytes) {
			job.resolve({ ok: false, reason: "queue_pressure" });
			return;
		}
		if (previous !== undefined) {
			this.queue.delete(job.request.key);
			previous.resolve({ ok: false, reason: "stale_generation" });
		}
		this.queue.set(job.request.key, job);
		this.queuedBytes = projectedBytes;
	}

	private start(job: PendingJob): void {
		this.activeJobs += 1;
		this.activeKeys.add(job.request.key);
		job.timing.nativeStartedAt = this.now();
		const nativeSettled = this.execute(job);
		void nativeSettled.finally(() => {
			this.activeJobs -= 1;
			this.activeKeys.delete(job.request.key);
			this.drain();
		});
	}

	private async execute(job: PendingJob): Promise<void> {
		const addon = this.addon;
		if (addon === undefined) {
			job.resolve({ ok: false, reason: "native_unavailable" });
			return;
		}
		const nativeWork = addon.highlightAsync(job.request.source, job.request.language, job.request.themeName);
		const result = await withTimeout(nativeWork, this.timeoutMs);
		job.timing.nativeEndedAt = this.now();
		if (this.destroyed) {
			job.resolve({ ok: false, reason: "stale_generation" });
			await settleNative(nativeWork);
			return;
		}
		if (!result.ok) {
			job.timing.adapterEndedAt = this.now();
			job.resolve(result);
			if (result.reason === "timeout") await settleNative(nativeWork);
			return;
		}
		const projected: Extract<HighlightResult, { readonly ok: true }> = {
			...result,
			themeRevision: job.request.themeRevision,
		};
		this.setCache(cacheKeyFor(this.engineBuildId, job.request), projected);
		job.timing.adapterEndedAt = this.now();
		job.resolve(projected);
	}

	private drain(): void {
		if (this.destroyed) return;
		while (this.activeJobs < this.maxConcurrency) {
			const next = [...this.queue]
				.filter(([key]) => !this.activeKeys.has(key))
				.sort((left, right) => compareJobs(left[1], right[1]))[0];
			if (next === undefined) return;
			const [key, job] = next;
			this.queue.delete(key);
			this.queuedBytes -= job.sourceBytes;
			this.start(job);
		}
	}

	private setCache(key: string, result: Extract<HighlightResult, { readonly ok: true }>): void {
		const bytes = estimateResultBytes(result);
		const spans = countResultSpans(result);
		if (bytes > this.maxCacheBytes || spans > this.maxCacheSpans) return;
		const previous = this.cache.get(key);
		if (previous !== undefined) {
			this.cacheBytes -= previous.bytes;
			this.cacheSpans -= previous.spans;
		}
		this.cache.delete(key);
		this.cache.set(key, { result, bytes, spans });
		this.cacheBytes += bytes;
		this.cacheSpans += spans;
		while (this.cache.size > this.maxCacheEntries || this.cacheBytes > this.maxCacheBytes || this.cacheSpans > this.maxCacheSpans) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) return;
			const entry = this.cache.get(oldest);
			this.cache.delete(oldest);
			this.cacheBytes -= entry?.bytes ?? 0;
			this.cacheSpans -= entry?.spans ?? 0;
			this.cacheEvictions += 1;
		}
	}

	private async observe(
		request: SyntaxHighlightRequest,
		work: Promise<HighlightResult>,
		timing: HighlightTiming,
		cacheHit: boolean,
	): Promise<HighlightResult> {
		const result = await work;
		this.performanceObserver?.recordSyntaxHighlight({
			ok: result.ok,
			cacheHit,
			...(result.ok ? {} : { fallbackReason: result.reason }),
			durationMs: Math.max(0, this.now() - timing.requestedAt),
			queueWaitMs: elapsed(timing.requestedAt, timing.nativeStartedAt),
			nativeDurationMs: elapsed(timing.nativeStartedAt, timing.nativeEndedAt),
			adapterDurationMs: elapsed(timing.nativeEndedAt, timing.adapterEndedAt),
			inputBytes: Buffer.byteLength(request.source, "utf8"),
			inputLines: countSourceLines(request.source),
			activeJobs: this.activeJobs,
			queuedJobs: this.queue.size,
			queuedBytes: this.queuedBytes,
			cacheEntries: this.cache.size,
			cacheBytes: this.cacheBytes,
			cacheSpans: this.cacheSpans,
			cacheEvictions: this.cacheEvictions,
			themeRevision: request.themeRevision,
			engineBuildId: this.engineBuildId,
		});
		return result;
	}

	private clearInFlight(key: string, work: Promise<HighlightResult>): void {
		if (this.inFlightByCacheKey.get(key) === work) this.inFlightByCacheKey.delete(key);
	}
}

function compareJobs(left: PendingJob, right: PendingJob): number {
	return priorityRank(left.priority) - priorityRank(right.priority) || left.sequence - right.sequence;
}

function priorityRank(priority: SyntaxHighlightPriority): number {
	return priority === "visible" ? 0 : priority === "overscan" ? 1 : 2;
}

function guardRequest(source: string): HighlightFallbackReason | undefined {
	if (source.length === 0) return "empty";
	if (Buffer.byteLength(source, "utf8") > MAX_HIGHLIGHT_BYTES) return "oversize_bytes";
	let lines = 1;
	for (const character of source) {
		if (character !== "\n") continue;
		lines += 1;
		if (lines > MAX_HIGHLIGHT_LINES && !source.endsWith("\n")) return "oversize_lines";
	}
	const actualLines = source.endsWith("\n") ? lines - 1 : lines;
	return actualLines > MAX_HIGHLIGHT_LINES ? "oversize_lines" : undefined;
}

function cacheKeyFor(engineBuildId: string, request: SyntaxHighlightRequest): string {
	const digest = createHash("sha256").update(request.source, "utf8").digest("hex");
	return JSON.stringify([engineBuildId, digest, request.language, request.themeRevision]);
}

function estimateResultBytes(result: Extract<HighlightResult, { readonly ok: true }>): number {
	let bytes = 64;
	for (const line of result.lines) {
		bytes += 16;
		for (const span of line.spans) bytes += 48 + Buffer.byteLength(span.text, "utf8");
	}
	return bytes;
}

function countResultSpans(result: Extract<HighlightResult, { readonly ok: true }>): number {
	return result.lines.reduce((total, line) => total + line.spans.length, 0);
}

function countSourceLines(source: string): number {
	if (source.length === 0) return 0;
	let count = 1;
	for (const character of source) if (character === "\n") count += 1;
	return source.endsWith("\n") ? count - 1 : count;
}

function boundedInteger(value: number | undefined, fallback: number): number {
	return value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
}

function elapsed(startedAt: number | undefined, endedAt: number | undefined): number {
	return startedAt === undefined || endedAt === undefined ? 0 : Math.max(0, endedAt - startedAt);
}

async function withTimeout(work: Promise<HighlightResult>, timeoutMs: number): Promise<HighlightResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<HighlightResult>((resolve) => {
				timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
			}),
		]);
	} catch {
		return { ok: false, reason: "highlight_error" };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function settleNative(work: Promise<HighlightResult>): Promise<void> {
	try {
		await work;
	} catch {
		// addon rejection 已投影为 typed fallback；这里只维持真实 worker slot。
	}
}
