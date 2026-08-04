/** Durable Host subscription events used for cursor replay after reconnect/restart. */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import type { AgentEvent } from "../../runtime/types.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export interface StoredHostEvent {
	readonly sessionId: string;
	readonly eventId: string;
	readonly sequence: number;
	readonly eventType: string;
	readonly event: AgentEvent;
}

export type HostEventReplayResult =
	| { readonly ok: true; readonly head: number; readonly events: readonly StoredHostEvent[] }
	| { readonly ok: false; readonly code: "resync_required"; readonly safeCursor: number };

export interface HostEventStore {
	append(sessionId: string, event: AgentEvent): Promise<StoredHostEvent>;
	head(sessionId: string): Promise<number>;
	readAfter(
		sessionId: string,
		cursor: number,
		bounds?: { readonly maxItems?: number; readonly maxBytes?: number },
	): Promise<HostEventReplayResult>;
}

export interface JsonlHostEventStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

export class JsonlHostEventStore implements HostEventStore {
	private readonly root: string;
	private readonly tails = new Map<string, Promise<void>>();

	public constructor(options: JsonlHostEventStoreOptions) {
		this.root = join(options.layout.state, "hosts", options.workspaceStorageKey, "events");
	}

	public append(sessionId: string, event: AgentEvent): Promise<StoredHostEvent> {
		return this.serial(sessionId, async () => {
			const records = await this.load(sessionId);
			const sequence = (records.at(-1)?.sequence ?? 0) + 1;
			const digest = runtimeDigest({ sessionId, sequence, event });
			const record: StoredHostEvent = {
				sessionId,
				eventId: `event_${digest.digest}`,
				sequence,
				eventType: event.type,
				event,
			};
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			await appendFile(this.path(sessionId), `${canonicalJson(record)}\n`, { encoding: "utf8", mode: 0o600 });
			return record;
		});
	}

	public head(sessionId: string): Promise<number> {
		return this.serial(sessionId, async () => (await this.load(sessionId)).at(-1)?.sequence ?? 0);
	}

	public readAfter(
		sessionId: string,
		cursor: number,
		bounds: { readonly maxItems?: number; readonly maxBytes?: number } = {},
	): Promise<HostEventReplayResult> {
		return this.serial(sessionId, async () => {
			const maxItems = bounds.maxItems ?? RUNTIME_HOST_BOUNDS.maxConnectionOutbox;
			const maxBytes = bounds.maxBytes ?? Math.floor(RUNTIME_HOST_BOUNDS.maxFrameBytes / 2);
			if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
				throw new Error("Host event replay bounds are invalid");
			}
			const records = await this.load(sessionId);
			const head = records.at(-1)?.sequence ?? 0;
			if (cursor > head) return { ok: false, code: "resync_required", safeCursor: head };
			const events = records.filter((record) => record.sequence > cursor);
			if (events.length > maxItems || Buffer.byteLength(canonicalJson(events), "utf8") > maxBytes) {
				return { ok: false, code: "resync_required", safeCursor: head };
			}
			return { ok: true, head, events };
		});
	}

	private async load(sessionId: string): Promise<StoredHostEvent[]> {
		let content: string;
		try {
			content = await readFile(this.path(sessionId), "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const records: StoredHostEvent[] = [];
		for (const line of content.split(/\r?\n/u).filter((value) => value.length > 0)) {
			const record = JSON.parse(line) as StoredHostEvent;
			if (record.sessionId !== sessionId || record.sequence !== records.length + 1 || typeof record.eventId !== "string" || typeof record.eventType !== "string") {
				throw new Error("Host event journal is invalid");
			}
			records.push(record);
		}
		return records;
	}

	private path(sessionId: string): string {
		if (!/^[A-Za-z0-9._~-]{1,160}$/u.test(sessionId)) throw new Error("Host event session id is invalid");
		return join(this.root, `${sessionId}.jsonl`);
	}

	private async serial<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(sessionId) ?? Promise.resolve();
		let release: (() => void) | undefined;
		const next = new Promise<void>((resolve) => { release = resolve; });
		this.tails.set(sessionId, previous.then(() => next));
		await previous;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
