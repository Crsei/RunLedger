/** Host-owned canonical Runtime event writer for security/workspace receipts. */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	canonicalJson,
	createRuntimeId,
	isContainedRuntimePath,
	isRuntimeId,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	runtimeDigest,
	validateRuntimeEvent,
	type AuthorityId,
	type DurableEventReceipt,
	type PrincipalId,
	type RunledgerLayout,
	type RuntimeEvent,
	type RuntimeEventPayload,
	type RuntimeEventType,
	type SessionId,
	type TenantId,
	type TraceId,
} from "../../runtime/contracts/public.ts";

export interface RuntimeEventAppendInput {
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly principalId: PrincipalId;
	readonly sessionId: SessionId;
	readonly traceId: TraceId;
	readonly type: RuntimeEventType;
	readonly payload: RuntimeEventPayload;
}

export interface RuntimeEventAppendResult {
	readonly event: RuntimeEvent;
	readonly receipt: DurableEventReceipt;
}

export interface JsonlRuntimeEventStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

export class JsonlRuntimeEventStore {
	readonly #root: string;
	readonly #tails = new Map<string, Promise<void>>();

	public constructor(options: JsonlRuntimeEventStoreOptions) {
		if (!/^ws-[a-f0-9]{64}$/u.test(options.workspaceStorageKey)) throw new Error("invalid runtime event workspace storage key");
		const home = resolve(options.layout.home);
		const root = resolve(join(options.layout.state, "hosts", options.workspaceStorageKey, "runtime-events"));
		if (!isContainedRuntimePath(home, root, "posix")) throw new Error("runtime event store must remain under the injected runledgerHome");
		this.#root = root;
	}

	public append(input: RuntimeEventAppendInput): Promise<RuntimeEventAppendResult> {
		return this.#serial(input.sessionId, async () => {
			const events = await this.#load(input.sessionId);
			const prior = events.find((event) =>
				event.type === input.type &&
				event.payload.subject.id === input.payload.subject.id &&
				event.payload.idempotencyKey !== undefined &&
				event.payload.idempotencyKey === input.payload.idempotencyKey,
			);
			if (prior) {
				if (runtimeDigest(prior.payload).digest !== runtimeDigest(input.payload).digest) throw new Error("runtime event idempotency conflict");
				return { event: prior, receipt: this.#receipt(prior) };
			}
			const sequence = events.length + 1;
			const stream = { scope: "session" as const, streamId: input.sessionId, sessionId: input.sessionId };
			const previousEventHash = events.at(-1)?.currentEventHash ?? null;
			const payloadDigest = runtimeDigest(input.payload);
			const eventId = createRuntimeId("event", runtimeDigest({ stream, sequence, type: input.type, payloadDigest }).digest.slice(0, 48));
			const candidate = {
				authorityId: input.authorityId,
				tenantId: input.tenantId,
				principalId: input.principalId,
				eventId,
				stream,
				sequence,
				timestamp: new Date().toISOString(),
				type: input.type,
				previousEventHash,
				payloadDigest,
				traceId: input.traceId,
				payload: input.payload,
			};
			const event: RuntimeEvent = {
				...candidate,
				currentEventHash: runtimeDigest({
					authorityId: candidate.authorityId,
					tenantId: candidate.tenantId,
					principalId: candidate.principalId,
					eventId: candidate.eventId,
					stream: candidate.stream,
					sequence: candidate.sequence,
					timestamp: candidate.timestamp,
					type: candidate.type,
					previousEventHash: candidate.previousEventHash,
					payloadDigest: candidate.payloadDigest,
					traceId: candidate.traceId,
				}),
			} as RuntimeEvent;
			const validation = validateRuntimeEvent(event);
			if (!validation.ok) throw new Error(`runtime event rejected: ${validation.message}`);
			await mkdir(this.#root, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
			await appendFile(this.#path(input.sessionId), `${canonicalJson(event)}\n`, { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
			return { event, receipt: this.#receipt(event) };
		});
	}

	public read(sessionId: SessionId): Promise<readonly RuntimeEvent[]> {
		return this.#serial(sessionId, () => this.#load(sessionId));
	}

	#receipt(event: RuntimeEvent): DurableEventReceipt {
		return {
			receiptId: createRuntimeId("receipt", runtimeDigest({ eventId: event.eventId, sequence: event.sequence, eventHash: event.currentEventHash }).digest.slice(0, 48)),
			stream: event.stream,
			cursor: `${event.stream.streamId}:${event.sequence}`,
			sequence: event.sequence,
			eventHash: event.currentEventHash,
			writerEpoch: 1,
			durableAt: event.timestamp,
		};
	}

	async #load(sessionId: SessionId): Promise<RuntimeEvent[]> {
		let content: string;
		try {
			content = await readFile(this.#path(sessionId), "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const events: RuntimeEvent[] = [];
		for (const line of content.split(/\r?\n/u).filter((value) => value.length > 0)) {
			let value: unknown;
			try {
				value = JSON.parse(line) as unknown;
			} catch {
				throw new Error("runtime event journal is invalid JSON");
			}
			const validation = validateRuntimeEvent(value);
			if (!validation.ok) throw new Error(`runtime event journal is invalid: ${validation.message}`);
			const event = validation.value;
			const previous = events.at(-1);
			if (event.sequence !== events.length + 1 || (previous === undefined ? event.previousEventHash !== null : event.previousEventHash?.digest !== previous.currentEventHash.digest)) throw new Error("runtime event journal hash chain is invalid");
			if (event.stream.scope !== "session" || event.stream.sessionId !== sessionId) throw new Error("runtime event journal stream is invalid");
			events.push(event);
		}
		return events;
	}

	#path(sessionId: SessionId): string {
		if (!isRuntimeId(sessionId, "session")) throw new Error("runtime event session id is invalid");
		return join(this.#root, `${sessionId}.jsonl`);
	}

	async #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((resolveNext) => { release = resolveNext; });
		this.#tails.set(key, previous.then(() => next));
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
