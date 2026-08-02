import { appendFile, mkdir, readFile } from "node:fs/promises";
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
	readonly #events: TraceEvent[] = [];
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
		let result: Promise<TraceEvent>;
		result = this.#tail.then(() => this.#appendOne(input));
		this.#tail = result.then(() => undefined, () => undefined);
		return result;
	}

	public async events(): Promise<readonly TraceEvent[]> {
		await this.#tail;
		await this.initialize();
		return this.#events.slice();
	}

	public async readSince(sequenceExclusive = 0): Promise<readonly TraceEvent[]> {
		const events = await this.events();
		return events.filter((event) => event.sequence > sequenceExclusive);
	}

	public async close(): Promise<void> {
		await this.#tail;
	}

	async #load(): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		let content: string;
		try {
			content = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
		let previousHash: string | null = null;
		for (let index = 0; index < lines.length; index += 1) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(lines[index]!);
			} catch {
				throw new TraceEventStoreCorruptionError(this.filePath, `line ${index + 1} is not valid JSON`);
			}
			const event = parseEvent(parsed, this.filePath, index + 1);
			if (event.traceId !== this.traceId || event.sequence !== index + 1 || event.previousEventHash !== previousHash) {
				throw new TraceEventStoreCorruptionError(this.filePath, `line ${index + 1} breaks sequence or trace continuity`);
			}
			if (this.#events.some((candidate) => candidate.eventId === event.eventId)) {
				throw new TraceEventStoreCorruptionError(this.filePath, `line ${index + 1} reuses an event id`);
			}
			this.#events.push(event);
			previousHash = event.eventHash;
		}
	}

	async #appendOne(input: TraceEventInput): Promise<TraceEvent> {
		await this.initialize();
		if (input.traceId !== this.traceId) throw new Error("trace id does not match event store");
		if (this.#events.some((event) => event.eventId === input.eventId)) throw new Error("event id already exists");
		const sequence = this.#events.length + 1;
		const previousEventHash = this.#events.at(-1)?.eventHash ?? null;
		const body = eventBody(input, sequence, previousEventHash);
		const event = { ...body, eventHash: canonicalDigest(body) } as TraceEvent;
		await appendFile(this.filePath, `${canonicalJson(event)}\n`, { encoding: "utf8", mode: 0o600 });
		this.#events.push(event);
		return event;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
