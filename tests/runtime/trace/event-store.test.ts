import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlTraceEventStore, TraceEventStoreCorruptionError } from "../../../src/runtime/trace/event-store.ts";
import type { TraceEventInput } from "../../../src/runtime/trace/types.ts";

const roots: string[] = [];

async function createStore() {
	const root = await mkdtemp(join(tmpdir(), "runledger-trace-event-store-"));
	roots.push(root);
	return new JsonlTraceEventStore({ filePath: join(root, "events.jsonl"), traceId: "trace_demo" });
}

function input(overrides: Partial<TraceEventInput> = {}): TraceEventInput {
	return {
		eventId: "event_1",
		traceId: "trace_demo",
		nodeId: "trace_demo",
		parentNodeId: null,
		kind: "trace",
		name: "agent.run",
		phase: "started",
		timestamp: "2026-08-02T00:00:00.000Z",
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("JsonlTraceEventStore", () => {
	it("serializes concurrent appends into a durable hash chain", async () => {
		const store = await createStore();
		const appended = await Promise.all([
			store.append(input()),
			store.append(input({ eventId: "event_2", nodeId: "turn_1", parentNodeId: "trace_demo", kind: "turn", name: "turn", phase: "started" })),
		]);

		expect(appended.map((event) => event.sequence)).toEqual([1, 2]);
		expect(appended[1]?.previousEventHash).toBe(appended[0]?.eventHash);
		expect(await store.events()).toHaveLength(2);

		const file = await readFile(store.filePath, "utf8");
		expect(file.trim().split("\n")).toHaveLength(2);
	});

	it("replays persisted events and rejects a tampered hash chain", async () => {
		const store = await createStore();
		await store.append(input());
		await store.append(input({ eventId: "event_2", phase: "finished", durationMs: 12 }));

		const reopened = new JsonlTraceEventStore({ filePath: store.filePath, traceId: "trace_demo" });
		await reopened.initialize();
		expect((await reopened.events()).map((event) => event.sequence)).toEqual([1, 2]);

		const tampered = (await readFile(store.filePath, "utf8")).replace('"durationMs":12', '"durationMs":13');
		await rm(store.filePath);
		await writeFile(store.filePath, tampered, "utf8");

		const corrupted = new JsonlTraceEventStore({ filePath: store.filePath, traceId: "trace_demo" });
		await expect(corrupted.initialize()).rejects.toBeInstanceOf(TraceEventStoreCorruptionError);
	});

	it("does not accept an event from another trace", async () => {
		const store = await createStore();
		await expect(store.append(input({ traceId: "trace_other" }))).rejects.toThrow("trace id");
	});

	it("supports read-only replay without creating missing parent directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-trace-readonly-"));
		roots.push(root);
		const parent = join(root, "not-created");
		const store = new JsonlTraceEventStore({
			filePath: join(parent, "events.jsonl"),
			traceId: "trace_demo",
			createDirectories: false,
		});

		await expect(store.events()).resolves.toEqual([]);
		expect(existsSync(parent)).toBe(false);
	});
});
