import { appendFile, mkdir, open } from "node:fs/promises";
import * as path from "node:path";
import { canonicalDigest, canonicalJson } from "../protocol/canonical-json.ts";
import type { TraceEvent, TraceEventInput } from "./types.ts";

export class TraceEventStoreCorruptionError extends Error {
	public readonly filePath: string;

	public constructor(filePath: string, message: string) {
		super(`trace event store is corrupt: ${message}`);
		this.name = "TraceEventStoreCorruptionError";
		this.filePath = filePath;
	}
}

export interface JsonlTraceEventStoreOptions {
	readonly filePath: string;
	readonly traceId: string;
}

function eventBody(input: TraceEventInput, sequence: number, previousEventHash: string | null): Record<string, unknown> {
	const candidate: Record<string, unknown> = {
		...input,
		sequence,
		previousEventHash,
	};
	return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined));
}

function parseEvent(value: unknown, filePath: string, lineNumber: number): TraceEvent {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TraceEventStoreCorruptionError(filePath, `line ${lineNumber} is not an object`);
	}
	const event = value as Partial<TraceEvent>;
	if (
		typeof event.eventId !== "string" ||
		typeof event.traceId !== "string" ||
		typeof event.nodeId !== "string" ||
		(event.parentNodeId !== null && typeof event.parentNodeId !== "string") ||
		typeof event.kind !== "string" ||
		typeof event.name !== "string" ||
		typeof event.phase !== "string" ||
		typeof event.timestamp !== "string" ||
		typeof event.sequence !== "number" ||
		!Number.isSafeInteger(event.sequence) ||
		event.sequence < 1 ||
		(event.previousEventHash !== null && typeof event.previousEventHash !== "string") ||
		typeof event.eventHash !== "string"
	) {
		throw new TraceEventStoreCorruptionError(filePath, `line ${lineNumber} has an invalid event shape`);
	}
	const body = { ...event } as Record<string, unknown>;
	delete body.eventHash;
	if (canonicalDigest(body) !== event.eventHash) {
		throw new TraceEventStoreCorruptionError(filePath, `line ${lineNumber} has an invalid event hash`);
	}
	return event as TraceEvent;
}

export class JsonlTraceEventStore {
	public readonly filePath: string;
	public readonly traceId: string;
	#sequence = 0;
	#bytes = 0;
	#previousHash: string | null = null;
	readonly #eventIds = new Set<string>();
	#pending = 0;
	#writeFailed = false;
	#initialized = false;
	#initializing: Promise<void> | undefined;
	#tail: Promise<void> = Promise.resolve();

	public constructor(options: JsonlTraceEventStoreOptions) {
		this.filePath = options.filePath;
		this.traceId = options.traceId;
	}

	public async initialize(): Promise<void> {
		if (this.#initialized) return;
		if (this.#initializing) return this.#initializing;
		this.#initializing = this.#load();
		try {
			await this.#initializing;
			this.#initialized = true;
		} finally {
			this.#initializing = undefined;
		}
	}

	public append(input: TraceEventInput): Promise<TraceEvent> {
		if (this.#pending >= 256) return Promise.reject(new Error("trace event queue full"));
		if (Buffer.byteLength(canonicalJson(input)) > 64 * 1024) return Promise.reject(new Error("trace event exceeds byte limit"));
		this.#pending += 1;
		let result: Promise<TraceEvent>;
		result = this.#tail.then(() => this.#withDeadline(() => this.#appendOne(input))).finally(() => { this.#pending -= 1; });
		this.#tail = result.then(() => undefined, () => undefined);
		return result;
	}

	public async events(): Promise<readonly TraceEvent[]> {
		await this.#tail;
		await this.initialize();
		const events: TraceEvent[] = [];
		for await (const event of this.#readEvents()) events.push(event);
		return events;
	}

	public async readSince(sequenceExclusive = 0): Promise<readonly TraceEvent[]> {
		const events = await this.events();
		return events.filter((event) => event.sequence > sequenceExclusive);
	}

	public async close(): Promise<void> {
		await this.#tail;
	}

  async #withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.#writeFailed = true; reject(new Error("trace write deadline exceeded")); }, 5_000);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

	async #load(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		this.#eventIds.clear(); this.#sequence = 0; this.#bytes = 0; this.#previousHash = null;
		for await (const event of this.#readEvents()) {
			if (this.#eventIds.has(event.eventId)) throw new TraceEventStoreCorruptionError(this.filePath, "reuses an event id");
			if (this.#eventIds.size >= 100_000) throw new Error("trace event count limit exceeded");
			this.#eventIds.add(event.eventId);
			this.#bytes += Buffer.byteLength(`${canonicalJson(event)}\n`);
			if (this.#bytes > 128 * 1024 * 1024) throw new Error("trace byte count limit exceeded");
			this.#sequence = event.sequence; this.#previousHash = event.eventHash;
		}
	}

	async *#readEvents(): AsyncGenerator<TraceEvent> {
		let file;
		try { file = await open(this.filePath, "r"); }
		catch (error) { if (isNotFound(error)) return; throw error; }
		let remainder = Buffer.alloc(0), position = 0, sequence = 0;
		let previous: string | null = null;
		const chunk = Buffer.alloc(64 * 1024);
		try {
			while (true) {
				const read = await file.read(chunk, 0, chunk.length, position);
				if (read.bytesRead === 0) break;
				position += read.bytesRead;
				remainder = Buffer.concat([remainder, chunk.subarray(0, read.bytesRead)]);
				let end: number;
				while ((end = remainder.indexOf(10)) >= 0) {
					if (end > 66 * 1024) throw new TraceEventStoreCorruptionError(this.filePath, "event exceeds byte limit");
					const raw = remainder.subarray(0, end).toString("utf8");
					remainder = remainder.subarray(end + 1);
					if (!raw.trim()) continue;
					let parsed: unknown;
					try { parsed = JSON.parse(raw); } catch { throw new TraceEventStoreCorruptionError(this.filePath, "invalid JSON"); }
					const event = parseEvent(parsed, this.filePath, ++sequence);
					if (event.traceId !== this.traceId || event.sequence !== sequence || event.previousEventHash !== previous) throw new TraceEventStoreCorruptionError(this.filePath, "breaks sequence or trace continuity");
					previous = event.eventHash;
					yield event;
				}
				if (remainder.length > 66 * 1024) throw new TraceEventStoreCorruptionError(this.filePath, "event exceeds byte limit");
			}
			if (remainder.length) throw new TraceEventStoreCorruptionError(this.filePath, "incomplete tail");
		} finally { await file.close(); }
	}

	async #appendOne(input: TraceEventInput): Promise<TraceEvent> {
		if (this.#writeFailed) throw new Error("trace write previously failed");
		await this.initialize();
		if (this.#writeFailed) throw new Error("trace write previously failed");
		if (input.traceId !== this.traceId) throw new Error("trace id does not match event store");
		if (this.#eventIds.has(input.eventId)) throw new Error("event id already exists");
		if (this.#sequence >= 100_000) throw new Error("trace event count limit exceeded");
		const sequence = this.#sequence + 1;
		const previousEventHash = this.#previousHash;
		const body = eventBody(input, sequence, previousEventHash);
		const event = { ...body, eventHash: canonicalDigest(body) } as TraceEvent;
		const line = `${canonicalJson(event)}\n`;
		const bytes = Buffer.byteLength(line);
		if (this.#bytes + bytes > 128 * 1024 * 1024) throw new Error("trace byte count limit exceeded");
		try { await appendFile(this.filePath, line, { encoding: "utf8", mode: 0o600, flush: true }); }
		catch (error) { this.#writeFailed = true; throw error; }
		this.#bytes += bytes;
		this.#sequence = sequence;
		this.#previousHash = event.eventHash;
		this.#eventIds.add(event.eventId);
		return event;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
