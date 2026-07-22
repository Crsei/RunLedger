import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import {
	computeRuntimeEventHash,
	computeRuntimeEventPayloadDigest,
} from "../../../src/runtime/protocol/v3/event-hash.ts";
import type { RuntimeEventHashInput } from "../../../src/runtime/protocol/v3/event-hash.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import {
	createSessionEventStreamRef,
	type ExpectedRevision,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	JsonlV3EventStore,
	scanJsonlV3EventLog,
} from "../../../src/runtime/session/jsonl-v3-store.ts";
import type {
	JsonlV3EventLogScope,
	JsonlV3EventStoreOptions,
} from "../../../src/runtime/session/jsonl-v3-store.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AUTHORITY_ID = createRuntimeId("authority", "jsonl-fixture");
const TENANT_ID = createRuntimeId("tenant", "jsonl-fixture");
const SESSION_ID = createRuntimeId("session", "jsonl-fixture");
const SCOPE: JsonlV3EventLogScope = {
	authorityId: AUTHORITY_ID,
	tenantId: TENANT_ID,
	stream: createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID),
};
const PRINCIPAL_ID = createRuntimeId("principal", "jsonl-fixture");
const RUNTIME_ID = createRuntimeId("runtime", "jsonl-fixture");
const FENCE: WriterFence = {
	...SCOPE,
	leaseId: createRuntimeId("lease", "jsonl-fixture"),
	ownerRuntimeId: RUNTIME_ID,
	writerEpoch: 7,
	fencingToken: "A".repeat(43),
};

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function temporaryFile(nested = false): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-jsonl-v3-"));
	temporaryRoots.push(root);
	return nested ? join(root, "private", "events.jsonl") : join(root, "events.jsonl");
}

function resultValue<T>(result: SessionResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function resultError<T>(result: SessionResult<T>) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected SessionResult failure");
	return result.error;
}

function storeOptions(
	filePath: string,
	validateFence: JsonlV3EventStoreOptions["validateFence"] = () => true,
	scope: JsonlV3EventLogScope = SCOPE,
): JsonlV3EventStoreOptions {
	return { filePath, ...scope, validateFence };
}

function createEvent(
	sequence = 0,
	previousEventHash: string | null = null,
	seed = `event-${sequence}`,
	scope: JsonlV3EventLogScope = SCOPE,
): RuntimeEventEnvelopeV3<"session.created"> {
	const payload = {
		origin: "test",
		runtimeId: RUNTIME_ID,
		featureDigest: DIGEST,
		initialGoalId: createRuntimeId("goal", "jsonl-fixture"),
		rootAgentId: createRuntimeId("agent", "jsonl-fixture"),
	};
	const hashInput: RuntimeEventHashInput = {
		schemaVersion: 3,
		...scope,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", seed),
		sequence,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created",
		previousEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(payload),
		traceId: createRuntimeId("trace", seed),
	};
	return {
		...hashInput,
		currentEventHash: computeRuntimeEventHash(hashInput),
		payload,
	};
}

function nextEvent(
	previous: RuntimeEventV3,
	seed = `event-${previous.sequence + 1}`,
): RuntimeEventEnvelopeV3<"conversation.message_recorded"> {
	const messageJson = JSON.stringify({ role: "user", content: [{ type: "text", text: seed }] });
	const payload = { role: "user" as const, messageJson, contentDigest: canonicalDigest(messageJson) };
	const hashInput: RuntimeEventHashInput = {
		schemaVersion: 3,
		...SCOPE,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", seed),
		sequence: previous.sequence + 1,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "conversation.message_recorded",
		previousEventHash: previous.currentEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(payload),
		traceId: createRuntimeId("trace", seed),
	};
	return { ...hashInput, currentEventHash: computeRuntimeEventHash(hashInput), payload };
}

function semanticEvent<TType extends RuntimeEventType>(
	previous: RuntimeEventV3,
	type: TType,
	payload: RuntimeEventPayloadMap[TType],
	seed: string,
): RuntimeEventEnvelopeV3<TType> {
	const hashInput: RuntimeEventHashInput = {
		schemaVersion: 3,
		...SCOPE,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", seed),
		sequence: previous.sequence + 1,
		timestamp: "2026-07-22T00:00:00.000Z",
		type,
		previousEventHash: previous.currentEventHash,
		payloadDigest: computeRuntimeEventPayloadDigest(payload),
		traceId: createRuntimeId("trace", seed),
	};
	return { ...hashInput, currentEventHash: computeRuntimeEventHash(hashInput), payload };
}

function expectedRevision(event: RuntimeEventV3): ExpectedRevision {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventHash: event.currentEventHash,
	};
}

function jsonl(...values: readonly unknown[]): string {
	return `${values.map((value) => canonicalJson(value)).join("\n")}\n`;
}

describe("JsonlV3EventStore durable JSONL", () => {
	it("creates private storage, fsyncs canonical LF records, and strictly reopens them", async () => {
		const filePath = await temporaryFile(true);
		const store = resultValue(await JsonlV3EventStore.create(storeOptions(filePath)));

		expect((await stat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);

		const event = createEvent();
		const cursor = resultValue(await store.append(SCOPE.stream, event, null, FENCE));
		expect(cursor).toMatchObject({ sequence: 0, eventHash: event.currentEventHash, writerEpoch: 7 });
		expect(await readFile(filePath, "utf8")).toBe(`${canonicalJson(event)}\n`);
		expect(resultValue(await store.flushThrough(SCOPE.stream, cursor, FENCE))).toMatchObject({
			cursor: { sequence: cursor.sequence, eventId: cursor.eventId, eventHash: cursor.eventHash },
		});
		expect(resultValue(await store.close())).toBeUndefined();

		const reopened = resultValue(await JsonlV3EventStore.open(storeOptions(filePath)));
		expect(await reopened.verify(SCOPE.stream)).toMatchObject({
			ok: true,
			value: { integrity: "valid", attestation: "unattested", eventCount: 1, head: { sequence: 0 } },
		});
		expect(await reopened.readPage(SCOPE.stream, { limit: 10 })).toMatchObject({
			ok: true,
			value: { events: [{ eventId: event.eventId }], hasMore: false },
		});
		expect(resultValue(await reopened.close())).toBeUndefined();
	});

	it("fails closed when the new-file directory sync cannot confirm creation", async () => {
		const filePath = await temporaryFile(true);
		const created = await JsonlV3EventStore.create({
			...storeOptions(filePath),
			onWritePhase: (phase) => {
				if (phase === "before_create_sync") {
					throw Object.assign(new Error("permission denied"), { code: "EACCES" });
				}
			},
		});
		expect(created).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed", retryable: false },
		});

		// 创建结果无法确认时不删除可能已经持久化的 inode；后续只能严格 reopen/reconcile。
		expect((await stat(filePath)).isFile()).toBe(true);
		const reopened = resultValue(await JsonlV3EventStore.open(storeOptions(filePath)));
		expect(resultValue(await reopened.close())).toBeUndefined();
	});

	it("keeps an event-write permission failure terminal without changing the log", async () => {
		const filePath = await temporaryFile();
		const store = resultValue(
			await JsonlV3EventStore.create({
				...storeOptions(filePath),
				onWritePhase: (phase) => {
					if (phase === "before_event_write") {
						throw Object.assign(new Error("permission denied"), { code: "EACCES" });
					}
				},
			}),
		);
		const first = createEvent();
		expect(await store.append(SCOPE.stream, first, null, FENCE)).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed", retryable: false },
		});
		expect((await readFile(filePath)).byteLength).toBe(0);
		expect(resultError(await store.append(SCOPE.stream, first, null, FENCE)).code).toBe("durable_write_failed");
		expect(resultError(await store.close()).code).toBe("durable_write_failed");
	});

	it("reports an event-sync disk-full boundary as an uncertain durable append", async () => {
		const filePath = await temporaryFile();
		const store = resultValue(
			await JsonlV3EventStore.create({
				...storeOptions(filePath),
				onWritePhase: (phase) => {
					if (phase === "before_event_sync") {
						throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
					}
				},
			}),
		);
		const first = createEvent();
		const cursor = resultValue(await store.append(SCOPE.stream, first, null, FENCE));
		expect(await store.flushThrough(SCOPE.stream, cursor, FENCE)).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed", retryable: false },
		});
		expect(await readFile(filePath, "utf8")).toBe(`${canonicalJson(first)}\n`);
		expect(resultError(await store.close()).code).toBe("durable_write_failed");

		// 失败调用方不得猜测是否提交；重启后由严格日志验证恢复实际 durable 状态。
		const reopened = resultValue(await JsonlV3EventStore.open(storeOptions(filePath)));
		expect(await reopened.verify(SCOPE.stream)).toMatchObject({
			ok: true,
			value: { integrity: "valid", eventCount: 1, head: { eventId: first.eventId } },
		});
		expect(resultValue(await reopened.close())).toBeUndefined();
	});

	it("makes an explicit flush failure terminal after a durable append", async () => {
		const filePath = await temporaryFile();
		const store = resultValue(
			await JsonlV3EventStore.create({
				...storeOptions(filePath),
				onWritePhase: (phase) => {
					if (phase === "before_flush_sync") {
						throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
					}
				},
			}),
		);
		const first = createEvent();
		const cursor = resultValue(await store.append(SCOPE.stream, first, null, FENCE));
		expect(await store.flushThrough(SCOPE.stream, cursor, FENCE)).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed", retryable: false },
		});
		expect(resultError(await store.append(SCOPE.stream, nextEvent(first), expectedRevision(first), FENCE)).code).toBe(
			"durable_write_failed",
		);
		expect(resultError(await store.close()).code).toBe("durable_write_failed");
	});

	it("checks fence and expected revision before changing a byte", async () => {
		const filePath = await temporaryFile();
		let fenceIsValid = true;
		const store = resultValue(
			await JsonlV3EventStore.create(
				storeOptions(filePath, (candidate) => fenceIsValid && candidate.fencingToken === FENCE.fencingToken),
			),
		);
		const first = createEvent();
		const wrongScopeFence: WriterFence = {
			...FENCE,
			tenantId: createRuntimeId("tenant", "wrong"),
		};

		expect(resultError(await store.append(SCOPE.stream, first, null, wrongScopeFence)).code).toBe("writer_fenced");
		expect((await readFile(filePath)).byteLength).toBe(0);
		expect(resultError(await store.append(SCOPE.stream, first, expectedRevision(first), FENCE)).code).toBe("sequence_conflict");
		expect((await readFile(filePath)).byteLength).toBe(0);

		resultValue(await store.append(SCOPE.stream, first, null, FENCE));
		const second = nextEvent(first);
		const durableBytes = await readFile(filePath);
		expect(
			resultError(
					await store.append(SCOPE.stream, second, { ...expectedRevision(first), eventHash: "f".repeat(64) }, FENCE),
			).code,
		).toBe("sequence_conflict");
		expect(await readFile(filePath)).toEqual(durableBytes);

		fenceIsValid = false;
		expect(resultError(await store.append(SCOPE.stream, second, expectedRevision(first), FENCE)).code).toBe("writer_fenced");
		expect(await readFile(filePath)).toEqual(durableBytes);
		resultValue(await store.close());
	});

	it("paginates replay, publishes only durable live events, and closes subscribers", async () => {
		const filePath = await temporaryFile();
		const store = resultValue(await JsonlV3EventStore.create(storeOptions(filePath)));
		const first = createEvent();
		const second = nextEvent(first);
		const third = nextEvent(second);
		const firstCursor = resultValue(await store.append(SCOPE.stream, first, null, FENCE));
		resultValue(await store.flushThrough(SCOPE.stream, firstCursor, FENCE));

		const replayAndLive = store.subscribe(SCOPE.stream)[Symbol.asyncIterator]();
		expect((await replayAndLive.next()).value?.eventId).toBe(first.eventId);
		const live = replayAndLive.next();
		const secondCursor = resultValue(await store.append(SCOPE.stream, second, expectedRevision(first), FENCE));
		resultValue(await store.flushThrough(SCOPE.stream, secondCursor, FENCE));
		expect((await live).value?.eventId).toBe(second.eventId);
		const thirdCursor = resultValue(await store.append(SCOPE.stream, third, expectedRevision(second), FENCE));
		resultValue(await store.flushThrough(SCOPE.stream, thirdCursor, FENCE));

		expect(await store.readPage(SCOPE.stream, { limit: 1 })).toMatchObject({
			ok: true,
			value: { events: [{ sequence: 0 }], hasMore: true, nextCursor: { sequence: 0 } },
		});
		expect(await store.readPage(SCOPE.stream, { afterSequence: 0, limit: 2 })).toMatchObject({
			ok: true,
			value: { events: [{ sequence: 1 }, { sequence: 2 }], hasMore: false, nextCursor: { sequence: 2 } },
		});
		await replayAndLive.return?.();

		const waiting = store.subscribe(SCOPE.stream, 2)[Symbol.asyncIterator]().next();
		expect(resultValue(await store.close())).toBeUndefined();
		expect((await waiting).done).toBe(true);
		expect(resultError(await store.append(SCOPE.stream, third, expectedRevision(second), FENCE)).code).toBe("store_closed");
		expect(resultError(await store.flushThrough(SCOPE.stream, thirdCursor, FENCE)).code).toBe("store_closed");
		expect(resultError(await store.readPage(SCOPE.stream, { limit: 1 })).code).toBe("store_closed");
		expect(resultError(await store.verify(SCOPE.stream)).code).toBe("store_closed");
		expect((await store.subscribe(SCOPE.stream)[Symbol.asyncIterator]().next()).done).toBe(true);
		expect(resultValue(await store.close())).toBeUndefined();
	});

	it("reports external tampering and refuses to append over it", async () => {
		const filePath = await temporaryFile();
		const store = resultValue(await JsonlV3EventStore.create(storeOptions(filePath)));
		const first = createEvent();
		resultValue(await store.append(SCOPE.stream, first, null, FENCE));
		const tampered = {
			...first,
			payload: { ...first.payload, featureDigest: "f".repeat(64) },
		};
		await writeFile(filePath, jsonl(tampered));
		const corruptedBytes = await readFile(filePath);

		expect(await store.verify(SCOPE.stream)).toMatchObject({
			ok: true,
			value: { integrity: "corrupted", firstBadSequence: 0, error: { code: "hash_mismatch" } },
		});
		expect(resultError(await store.readPage(SCOPE.stream, { limit: 1 })).code).toBe("hash_mismatch");
		expect(
			resultError(await store.append(SCOPE.stream, nextEvent(first), expectedRevision(first), FENCE)).code,
		).toBe("hash_mismatch");
		expect(await readFile(filePath)).toEqual(corruptedBytes);
		resultValue(await store.close());
	});

	it("never overwrites an existing path or creates one while opening", async () => {
		const existingPath = await temporaryFile();
		await writeFile(existingPath, "sentinel", { mode: 0o600 });
		const before = await readFile(existingPath);
		expect(resultError(await JsonlV3EventStore.create(storeOptions(existingPath))).code).toBe(
			"durable_write_failed",
		);
		expect(await readFile(existingPath)).toEqual(before);

		const missingPath = await temporaryFile();
		expect(resultError(await JsonlV3EventStore.open(storeOptions(missingPath))).code).toBe(
			"durable_write_failed",
		);
		await expect(stat(missingPath)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("strict JSONL integrity failures", () => {
	const first = createEvent();
	const second = nextEvent(first);
	const duplicate = createEvent(0, first.currentEventHash, "duplicate");
	const gap = createEvent(2, first.currentEventHash, "gap");
	const wrongScope = createEvent(0, null, "wrong-scope", {
		authorityId: SCOPE.authorityId,
		tenantId: SCOPE.tenantId,
		stream: createSessionEventStreamRef(
			{ authorityId: SCOPE.authorityId, tenantId: SCOPE.tenantId },
			createRuntimeId("session", "wrong"),
		),
	});
	const payloadTampered = {
		...first,
		payload: { ...first.payload, featureDigest: "f".repeat(64) },
	};
	const hashTampered = { ...first, currentEventHash: "f".repeat(64) };
	const extraField = { ...first, unexpected: true };

	const cases: ReadonlyArray<{
		name: string;
		bytes: string | Uint8Array;
		code: string;
	}> = [
		{ name: "middle empty line", bytes: `${jsonl(first)}\n`, code: "corrupted_log" },
		{ name: "malformed JSON", bytes: `${jsonl(first)}{"broken":\n`, code: "corrupted_log" },
		{ name: "invalid UTF-8", bytes: Uint8Array.from([0xff, 0x0a]), code: "corrupted_log" },
		{ name: "CRLF framing", bytes: `${canonicalJson(first)}\r\n`, code: "corrupted_log" },
		{ name: "torn tail", bytes: canonicalJson(first), code: "torn_tail" },
		{ name: "duplicate sequence", bytes: jsonl(first, duplicate), code: "sequence_conflict" },
		{ name: "sequence gap", bytes: jsonl(first, gap), code: "sequence_conflict" },
		{ name: "reordered events", bytes: jsonl(second, first), code: "sequence_conflict" },
		{ name: "wrong identity scope", bytes: jsonl(wrongScope), code: "identity_mismatch" },
		{ name: "payload tamper", bytes: jsonl(payloadTampered), code: "hash_mismatch" },
		{ name: "event hash tamper", bytes: jsonl(hashTampered), code: "hash_mismatch" },
		{ name: "extra schema field", bytes: jsonl(extraField), code: "invalid_event" },
	];

	it.each(cases)("rejects $name without changing the bytes", async ({ bytes, code }) => {
		const filePath = await temporaryFile();
		await writeFile(filePath, bytes, { mode: 0o600 });
		const before = await readFile(filePath);
		const opened = await JsonlV3EventStore.open(storeOptions(filePath));
		expect(resultError(opened).code).toBe(code);
		expect(await readFile(filePath)).toEqual(before);
	});

	it("rejects a hash-valid but disconnected event graph at open", async () => {
		const filePath = await temporaryFile();
		const first = createEvent();
		const orphan = semanticEvent(first, "queue.consumed", {
			queueItemId: createRuntimeId("queueItem", "orphan"),
			sourceCommandId: createRuntimeId("command", "orphan"),
			kind: "steer",
			turnId: createRuntimeId("turn", "orphan"),
			modelRequestId: createRuntimeId("modelRequest", "orphan"),
			contentDigest: DIGEST,
		}, "semantic-orphan");
		await writeFile(filePath, jsonl(first, orphan), { mode: 0o600 });
		const before = await readFile(filePath);
		expect(resultError(await JsonlV3EventStore.open(storeOptions(filePath))).code).toBe("invalid_event");
		expect(await readFile(filePath)).toEqual(before);
	});
});

describe("scanJsonlV3EventLog", () => {
	it("returns a trusted prefix and the exact first invalid UTF-8 location", () => {
		const first = createEvent();
		const prefix = Buffer.from(jsonl(first));
		const bytes = Buffer.concat([prefix, Buffer.from([0xff, 0x0a])]);
		const scan = scanJsonlV3EventLog(bytes, SCOPE);

		expect(scan.events.map((event) => event.eventId)).toEqual([first.eventId]);
		expect(scan.tornTail).toBe(false);
		expect(scan.firstError).toEqual({
			code: "corrupted_log",
			message: "event log is not valid UTF-8",
			line: 1,
			byteOffset: prefix.byteLength,
		});
	});

	it("preserves complete events while identifying an unterminated tail", () => {
		const first = createEvent();
		const prefix = Buffer.from(jsonl(first));
		const scan = scanJsonlV3EventLog(Buffer.concat([prefix, Buffer.from('{"partial"')]), SCOPE);

		expect(scan.events).toHaveLength(1);
		expect(scan.tornTail).toBe(true);
		expect(scan.firstError).toMatchObject({
			code: "torn_tail",
			line: 1,
			byteOffset: prefix.byteLength,
		});
	});

	it("reports the byte start of the first discontinuous event", () => {
		const first = createEvent();
		const gap = createEvent(2, first.currentEventHash, "scanner-gap");
		const firstLine = Buffer.from(jsonl(first));
		const scan = scanJsonlV3EventLog(Buffer.from(jsonl(first, gap)), SCOPE);

		expect(scan.events).toHaveLength(1);
		expect(scan.firstError).toMatchObject({
			code: "sequence_conflict",
			line: 1,
			byteOffset: firstLine.byteLength,
		});
	});
});
