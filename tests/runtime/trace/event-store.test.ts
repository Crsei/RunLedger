import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  it("bounds pending writes and rejects oversized input before writing", async () => {
    const store = await createStore();
    const results = await Promise.allSettled(Array.from({ length: 257 }, (_, i) => store.append(input({ eventId: `bounded_${i}` }))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(256);
    expect(results[256]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "trace event queue full" }) });
    await expect(store.append(input({ name: "x".repeat(65 * 1024) }))).rejects.toThrow("byte limit");
    expect(await store.events()).toHaveLength(256);
  });
  it("rejects an incomplete tail without appending a new chain onto it", async () => {
    const store = await createStore();
    await store.append(input());
    const content = await readFile(store.filePath, "utf8");
    await writeFile(store.filePath, content + '{"partial":');
    const reopened = new JsonlTraceEventStore({ filePath: store.filePath, traceId: store.traceId });
    await expect(reopened.append(input({ eventId: "next" }))).rejects.toThrow("incomplete tail");
    expect(await readFile(store.filePath, "utf8")).toBe(content + '{"partial":');
  });

  it("stops subsequent writes after an I/O failure even if the path becomes writable", async () => {
    const store = await createStore();
    await store.append(input());
    const saved = await readFile(store.filePath, "utf8");
    await rm(store.filePath); await mkdir(store.filePath);
    await expect(store.append(input({ eventId: "failed" }))).rejects.toThrow();
    await rm(store.filePath, { recursive: true }); await writeFile(store.filePath, saved);
    await expect(store.append(input({ eventId: "later" }))).rejects.toThrow("previously failed");
    expect(await readFile(store.filePath, "utf8")).toBe(saved);
    await store.close();
  });

});
