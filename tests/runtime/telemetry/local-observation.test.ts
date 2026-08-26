import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/canonical-json.ts";
import { createRuntimeId, type TraceId } from "../../../src/runtime/protocol/ids.ts";
import { JsonlTraceEventStore, TraceEventStoreCorruptionError } from "../../../src/runtime/trace/event-store.ts";
import { TraceTreeProjection } from "../../../src/runtime/trace/tree.ts";
import {
	createLocalTelemetryPort,
	isSessionTelemetryReport,
	LocalTelemetryRecordingError,
	isTelemetryObservation,
	projectSessionTelemetryReport,
	type LocalTelemetryPort,
	type SessionTelemetryReport,
	type TelemetryObservation,
} from "../../../src/runtime/telemetry/local/index.ts";

const roots: string[] = [];

async function createFixture(): Promise<{ readonly root: string; readonly traceId: TraceId; readonly store: JsonlTraceEventStore }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-local-telemetry-"));
	roots.push(root);
	const traceId = createRuntimeId("trace", "local");
	return {
		root,
		traceId,
		store: new JsonlTraceEventStore({ filePath: join(root, "events.jsonl"), traceId }),
	};
}

function observation(traceId: TraceId): TelemetryObservation {
	return {
		format: "runledger.telemetry.observation",
		observationId: createRuntimeId("event", "observation-1"),
		observedAt: "2026-08-25T00:00:00.000Z",
		monotonicOffsetMs: 12,
		correlation: {
			sessionId: createRuntimeId("session", "local"),
			traceId,
			ownerGeneration: 1,
		},
		kind: "traffic",
		channel: "llm_http",
		direction: "tx",
		boundary: "request_body",
		bytes: {
			availability: "available",
			unit: "bytes",
			value: 12,
			accuracy: "exact",
			source: "runtime_meter",
		},
		transportAttempt: 1,
		terminal: "completed",
	};
}

async function openPort(store: JsonlTraceEventStore, traceId: TraceId, failurePolicy: "best_effort" | "fail_closed" = "fail_closed"): Promise<LocalTelemetryPort> {
	const port = createLocalTelemetryPort({
		eventStore: store,
		traceId,
		mode: "events",
		failurePolicy,
	});
	if (port === undefined) throw new Error("expected enabled local telemetry port");
	return port;
}

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local telemetry observations", () => {
	it("keeps recording-off composition free of port, timer, wrapper, memory and files", async () => {
		const fixture = await createFixture();
		const memoryUsage = vi.spyOn(process, "memoryUsage");

		expect(createLocalTelemetryPort({
			eventStore: fixture.store,
			traceId: fixture.traceId,
			mode: "off",
			failurePolicy: "best_effort",
		})).toBeUndefined();
		expect(memoryUsage).not.toHaveBeenCalled();
		expect(existsSync(join(fixture.root, "events.jsonl"))).toBe(false);
	});

	it("writes a typed observation leaf with explicit correlation and replays it", async () => {
		const fixture = await createFixture();
		await fixture.store.append({
			eventId: "event:root",
			traceId: fixture.traceId,
			nodeId: fixture.traceId,
			parentNodeId: null,
			kind: "trace",
			name: "agent.run",
			phase: "started",
			timestamp: "2026-08-25T00:00:00.000Z",
		});
		const port = await openPort(fixture.store, fixture.traceId);
		const value = observation(fixture.traceId);

		expect(isTelemetryObservation(value)).toBe(true);
		expect(await port.bind(value.correlation, async () => port.currentCorrelation())).toEqual(value.correlation);
		expect(await port.observe(value)).toEqual({ ok: true });

		const events = await fixture.store.events();
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({
			kind: "observation",
			phase: "finished",
			parentNodeId: fixture.traceId,
			observation: value,
		});
		const tree = new TraceTreeProjection();
		for (const event of events) tree.apply(event);
		expect(tree.tree(fixture.traceId)?.children[0]).toMatchObject({ kind: "observation", observation: value });

		const reopened = new JsonlTraceEventStore({ filePath: fixture.store.filePath, traceId: fixture.traceId });
		await reopened.initialize();
		expect((await reopened.events())[1]?.observation).toEqual(value);
		await port.close();
	});

	it("uses the same hash-chain observation contract when artifacts are enabled", async () => {
		const fixture = await createFixture();
		const port = createLocalTelemetryPort({
			eventStore: fixture.store,
			traceId: fixture.traceId,
			mode: "events_and_artifacts",
			failurePolicy: "fail_closed",
		});
		if (port === undefined) throw new Error("expected artifact-mode port");
		expect(await port.observe(observation(fixture.traceId))).toEqual({ ok: true });
		expect((await fixture.store.events())[0]?.observation).toEqual(observation(fixture.traceId));
	});

	it("attaches the runtime memory sampler only to an enabled Session recorder", async () => {
		const fixture = await createFixture();
		const port = createLocalTelemetryPort({
			eventStore: fixture.store,
			traceId: fixture.traceId,
			sessionId: createRuntimeId("session", "local"),
			ownerGeneration: 1,
			mode: "events",
			failurePolicy: "best_effort",
		});
		if (port === undefined) throw new Error("expected enabled port");
		await port.forceSample("turn");
		const events = await fixture.store.events();
		expect(events.some((event) => event.observation?.kind === "runtime_memory")).toBe(true);
		await port.close();
	});

	it("does not start periodic memory sampling before the first governed run boundary", async () => {
		vi.useFakeTimers();
		const fixture = await createFixture();
		const memoryUsage = vi.spyOn(process, "memoryUsage");
		const port = createLocalTelemetryPort({
			eventStore: fixture.store,
			traceId: fixture.traceId,
			sessionId: createRuntimeId("session", "deferred-sampler"),
			ownerGeneration: 1,
			mode: "events",
			failurePolicy: "fail_closed",
		});
		if (port === undefined) throw new Error("expected enabled port");

		await vi.advanceTimersByTimeAsync(2_200);
		expect(memoryUsage).not.toHaveBeenCalled();
		expect(await fixture.store.events()).toEqual([]);
		await port.forceSample("run");
		expect(memoryUsage).toHaveBeenCalledTimes(1);
		await port.close();
	});

	it("projects exact observed totals and keeps old traces explicitly unavailable", async () => {
		const fixture = await createFixture();
		const port = await openPort(fixture.store, fixture.traceId);
		await port.observe(observation(fixture.traceId));
		const observed = projectSessionTelemetryReport({
			sessionId: createRuntimeId("session", "local"),
			traceId: fixture.traceId,
			generatedAt: "2026-08-25T00:00:01.000Z",
			events: await fixture.store.events(),
		});
		if (!observed.ok) throw new Error(`projection failed: ${observed.code}`);
		expect(isSessionTelemetryReport(observed.report)).toBe(true);
		expect(observed.report.traffic.llmHttp.tx.sum).toMatchObject({ availability: "available", value: 12, unit: "bytes" });
		expect(observed.report.traffic.llmHttp.tx.sampleCount).toBe(1);
		expect(observed.report.coverage.find((entry) => entry.key === "traffic.llm_http")).toEqual({ key: "traffic.llm_http", state: "measured" });

		const old = await createFixture();
		const oldSessionId = createRuntimeId("session", "old");
		await old.store.append({
			eventId: "event:old",
			traceId: old.traceId,
			nodeId: old.traceId,
			parentNodeId: null,
			kind: "trace",
			name: "agent.run",
			phase: "finished",
			timestamp: "2026-08-25T00:00:00.000Z",
		});
		const oldReport = projectSessionTelemetryReport({
			sessionId: oldSessionId,
			traceId: old.traceId,
			events: await old.store.events(),
		});
		if (!oldReport.ok) throw new Error(`old projection failed: ${oldReport.code}`);
		const unavailable: SessionTelemetryReport = oldReport.report;
		expect(unavailable.traffic.llmHttp.tx.sum).toEqual({ availability: "unavailable", unit: "bytes", reason: "transport_not_instrumented" });
	});

	it("keeps valid full memory samples after light gaps and preserves sampled peak accuracy", async () => {
		const fixture = await createFixture();
		const sessionId = createRuntimeId("session", "local");
		const port = await openPort(fixture.store, fixture.traceId);
		const base = {
			format: "runledger.telemetry.observation" as const,
			observedAt: "2026-08-25T00:00:00.000Z",
			monotonicOffsetMs: 0,
			correlation: { sessionId, traceId: fixture.traceId, ownerGeneration: 3 },
			kind: "runtime_memory" as const,
		};
		const sampled = (value: number) => ({ availability: "available" as const, unit: "bytes" as const, value, accuracy: "sampled" as const, source: "runtime_meter" as const });
		const gap = { availability: "unavailable" as const, unit: "bytes" as const, reason: "sample_failed" as const };
		await port.observe({ ...base, observationId: createRuntimeId("event", "memory-light"), rssBytes: sampled(100), heapTotalBytes: gap, heapUsedBytes: gap, externalBytes: gap, arrayBuffersBytes: gap });
		await port.observe({ ...base, observationId: createRuntimeId("event", "memory-full"), rssBytes: sampled(120), heapTotalBytes: sampled(200), heapUsedBytes: sampled(150), externalBytes: sampled(30), arrayBuffersBytes: sampled(10) });

		const result = projectSessionTelemetryReport({ sessionId, traceId: fixture.traceId, events: await fixture.store.events() });
		if (!result.ok) throw new Error(`projection failed: ${result.code}`);
		expect(result.report.memory.runtimeRssBytes.sum).toMatchObject({ availability: "available", value: 220, accuracy: "sampled" });
		expect(result.report.memory.runtimeRssBytes.peak).toMatchObject({ availability: "available", value: 120, accuracy: "sampled" });
		expect(result.report.memory.runtimeHeapUsedBytes.peak).toMatchObject({ availability: "available", value: 150, accuracy: "sampled" });
	});

	it("counts distinct turn and model nodes instead of lifecycle events", async () => {
		const fixture = await createFixture();
		const timestamp = "2026-08-25T00:00:00.000Z";
		for (const [kind, nodeId] of [["turn", "turn:one"], ["model", "model:one"]] as const) {
			for (const phase of ["started", "finished"] as const) {
				await fixture.store.append({ eventId: `event:${kind}:${phase}`, traceId: fixture.traceId, nodeId, parentNodeId: fixture.traceId, kind, name: kind, phase, timestamp });
			}
		}
		const result = projectSessionTelemetryReport({ sessionId: createRuntimeId("session", "local"), traceId: fixture.traceId, events: await fixture.store.events() });
		if (!result.ok) throw new Error(`projection failed: ${result.code}`);
		expect(result.report.summary.turnCount).toBe(1);
		expect(result.report.summary.modelCallCount).toBe(1);
	});

	it("rejects unknown observation schema and single-byte tampering during replay", async () => {
		const fixture = await createFixture();
		const port = await openPort(fixture.store, fixture.traceId);
		await port.observe(observation(fixture.traceId));

		const original = JSON.parse(await readFile(fixture.store.filePath, "utf8")) as Record<string, unknown>;
		const body = { ...original, observation: { ...(original.observation as Record<string, unknown>), format: "runledger.telemetry.unknown" } };
		delete body.eventHash;
		await writeFile(fixture.store.filePath, `${canonicalJson({ ...body, eventHash: canonicalDigest(body) })}\n`, "utf8");

		const unknownSchema = new JsonlTraceEventStore({ filePath: fixture.store.filePath, traceId: fixture.traceId });
		await expect(unknownSchema.initialize()).rejects.toBeInstanceOf(TraceEventStoreCorruptionError);

		const tamperedBody = { ...original, observation: { ...(original.observation as Record<string, unknown>), bytes: { ...(original.observation as Record<string, unknown>).bytes as Record<string, unknown>, value: 13 } } };
		await writeFile(fixture.store.filePath, `${canonicalJson(tamperedBody)}\n`, "utf8");
		const tampered = new JsonlTraceEventStore({ filePath: fixture.store.filePath, traceId: fixture.traceId });
		await expect(tampered.initialize()).rejects.toBeInstanceOf(TraceEventStoreCorruptionError);
	});

	it("does not persist privacy fields that are outside the exact observation contract", async () => {
		const fixture = await createFixture();
		const port = await openPort(fixture.store, fixture.traceId);
		const unsafe = { ...observation(fixture.traceId), url: "https://secret.invalid", body: "authorization: Bearer secret" } as unknown as TelemetryObservation;

		expect(isTelemetryObservation(unsafe)).toBe(false);
		expect(await port.observe(unsafe)).toMatchObject({ ok: false, code: "invalid_observation" });
		expect(existsSync(fixture.store.filePath)).toBe(false);
	});

	it("keeps best-effort recording non-fatal and fail-closed recording typed", async () => {
		const fixture = await createFixture();
		const failingStore = {
			append: async (): Promise<never> => { throw new Error("fixture write failure"); },
			events: async () => [],
		};
		const bestEffort = createLocalTelemetryPort({
			eventStore: failingStore,
			traceId: fixture.traceId,
			mode: "events",
			failurePolicy: "best_effort",
		});
		if (bestEffort === undefined) throw new Error("expected best-effort port");
		expect(await bestEffort.observe(observation(fixture.traceId))).toEqual({ ok: false, code: "event_store_write_failed" });

		const failClosed = createLocalTelemetryPort({
			eventStore: failingStore,
			traceId: fixture.traceId,
			mode: "events",
			failurePolicy: "fail_closed",
		});
		if (failClosed === undefined) throw new Error("expected fail-closed port");
		await expect(failClosed.observe(observation(fixture.traceId))).rejects.toBeInstanceOf(LocalTelemetryRecordingError);
	});
});
