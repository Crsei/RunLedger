import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { CompactionId } from "../../protocol/v3/ids.ts";
import type { MemoryRecord, MemorySearchReceipt } from "./types.ts";

const SECRET_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:sk|api)[-_][A-Za-z0-9_-]{20,}\b/,
];

export interface MemoryFlushSampler {
	sample(input: string, options: { tools: readonly []; timeoutMs: number; maxOutputTokens: number }): Promise<string>;
}

export interface MemoryFlushResult {
	outcome: "below_threshold" | "already_flushed" | "busy" | "empty" | "invalid" | "duplicate" | "proposed" | "failed";
	outputDigest?: string;
	errorDigest?: string;
}

export class PreCompactionMemoryFlush {
	readonly #completedCycles = new Set<string>();
	#flushing = false;

	public get isFlushing(): boolean {
		return this.#flushing;
	}

	public async run(options: {
		cycleId: CompactionId | string;
		estimatedTokens: number;
		flushThresholdTokens: number;
		trustedProjection: string;
		sampler: MemoryFlushSampler;
		timeoutMs: number;
		maxOutputTokens: number;
		maxOutputChars: number;
		existingContentDigests: readonly string[];
		propose(title: string, content: string): Promise<void>;
	}): Promise<MemoryFlushResult> {
		if (options.estimatedTokens < options.flushThresholdTokens) return { outcome: "below_threshold" };
		if (this.#completedCycles.has(options.cycleId)) return { outcome: "already_flushed" };
		if (this.#flushing) return { outcome: "busy" };
		this.#flushing = true;
		this.#completedCycles.add(options.cycleId);
		try {
			const output = await sampleWithTimeout(
				options.sampler.sample(options.trustedProjection, {
					tools: [], timeoutMs: options.timeoutMs, maxOutputTokens: options.maxOutputTokens,
				}),
				options.timeoutMs,
			);
			const normalized = output.trim();
			const outputDigest = canonicalDigest(normalized);
			if (normalized.length === 0 || normalized === "NO_REPLY") return { outcome: "empty", outputDigest };
			if (normalized.length > options.maxOutputChars || SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
				return { outcome: "invalid", outputDigest };
			}
			const lines = normalized.split(/\r?\n/);
			const heading = lines[0]?.match(/^#\s+(.{1,256})$/);
			const content = lines.slice(1).join("\n").trim();
			if (heading === null || heading === undefined || content.length === 0) return { outcome: "invalid", outputDigest };
			const contentDigest = canonicalDigest(content);
			if (options.existingContentDigests.includes(contentDigest)) return { outcome: "duplicate", outputDigest };
			await options.propose(heading[1] ?? "Memory", content);
			return { outcome: "proposed", outputDigest };
		} catch (error) {
			return { outcome: "failed", errorDigest: canonicalDigest({ error: error instanceof Error ? error.message : "unknown" }) };
		} finally {
			this.#flushing = false;
		}
	}
}

async function sampleWithTimeout(sample: Promise<string>, timeoutMs: number): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			sample,
			new Promise<string>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("memory flush sampler timed out")), Math.max(1, timeoutMs));
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface CachedRecall {
	receipt: MemorySearchReceipt;
	recordSetDigest: string;
}

export class PostCompactionRecallCache {
	readonly #cache = new Map<string, CachedRecall>();

	public get(checkpointId: string, records: readonly MemoryRecord[]): MemorySearchReceipt | undefined {
		const cached = this.#cache.get(checkpointId);
		if (cached === undefined) return undefined;
		return cached.recordSetDigest === recordSetDigest(records) ? cached.receipt : undefined;
	}

	public set(checkpointId: string, records: readonly MemoryRecord[], receipt: MemorySearchReceipt): void {
		this.#cache.set(checkpointId, { receipt, recordSetDigest: recordSetDigest(records) });
	}

	public invalidate(checkpointId: string): void {
		this.#cache.delete(checkpointId);
	}
}

function recordSetDigest(records: readonly MemoryRecord[]): string {
	return canonicalDigest(records.map((record) => ({ memoryId: record.memoryId, revision: record.revision, contentDigest: record.contentDigest, status: record.status })).sort((left, right) => left.memoryId.localeCompare(right.memoryId)));
}

export function sessionEligibleForExtraction(options: {
	endedAt: string;
	now: Date;
	minimumAgeMs: number;
	alreadyProcessed: boolean;
	terminal: boolean;
}): boolean {
	return options.terminal && !options.alreadyProcessed && Number.isFinite(Date.parse(options.endedAt)) &&
		options.now.getTime() - Date.parse(options.endedAt) >= Math.max(0, options.minimumAgeMs);
}
