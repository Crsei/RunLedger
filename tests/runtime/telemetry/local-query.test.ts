import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { canonicalJson } from "../../../src/runtime/protocol/canonical-json.ts";
import { createRuntimeId, type SessionId, type TraceId } from "../../../src/runtime/protocol/ids.ts";
import { JsonlTraceEventStore } from "../../../src/runtime/trace/event-store.ts";
import {
	createLocalTelemetryQuery,
	type TelemetrySessionCatalogEntry,
} from "../../../src/runtime/telemetry/local/query.ts";
import type { TelemetryObservation } from "../../../src/runtime/telemetry/local/types.ts";

const roots: string[] = [];

function sessionId(value: string): SessionId {
	return createRuntimeId("session", value);
}

function traceId(value: string): TraceId {
	return createRuntimeId("trace", value);
}

function traffic(trace: TraceId, session: SessionId, observationId: string, bytes: number): TelemetryObservation {
	return {
		format: "runledger.telemetry.observation",
		observationId: createRuntimeId("event", observationId),
		observedAt: "2026-08-25T00:00:00.000Z",
		monotonicOffsetMs: bytes,
		correlation: { sessionId: session, traceId: trace, ownerGeneration: 1 },
		kind: "traffic",
		channel: "llm_http",
		direction: "tx",
		boundary: "request_body",
		bytes: { availability: "available", unit: "bytes", value: bytes, accuracy: "exact", source: "runtime_meter" },
		transportAttempt: 1,
		terminal: "completed",
	};
}

async function appendTrace(root: string, session: SessionId, trace: TraceId, bytes: number, timestamp = "2026-08-25T00:00:00.000Z"): Promise<string> {
	const filePath = join(root, "events", "2026", "08", "25", `${trace}.jsonl`);
	await mkdir(join(root, "events", "2026", "08", "25"), { recursive: true });
	const store = new JsonlTraceEventStore({ filePath, traceId: trace });
	await store.append({
		eventId: `event:root:${trace}`,
		traceId: trace,
		nodeId: trace,
		parentNodeId: null,
		kind: "trace",
		name: "agent.run",
		phase: "finished",
		timestamp,
		metadata: { sessionId: session },
	});
	await store.append({
		eventId: `event:observation:${trace}`,
		traceId: trace,
		nodeId: `observation:${trace}`,
		parentNodeId: trace,
		kind: "observation",
		name: "observation:traffic",
		phase: "finished",
		timestamp,
		observation: traffic(trace, session, `observation:${trace}`, bytes),
	});
	return filePath;
}

function catalog(entries: readonly TelemetrySessionCatalogEntry[]) {
	return { list: async () => entries };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local telemetry query projection", () => {
	test("aggregates multiple traces for one Session and latest follows canonical catalog timestamps", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("query-session");
		const first = traceId("query-trace-1");
		const second = traceId("query-trace-2");
		await appendTrace(root, session, first, 7);
		await appendTrace(root, session, second, 11);
		const entries: TelemetrySessionCatalogEntry[] = [
			{ sessionId: sessionId("older"), createdAtMs: 2_000, updatedAtMs: 3_000 },
			{ sessionId: session, createdAtMs: 1_000, updatedAtMs: 9_000 },
		];
		const query = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "best_effort" },
			sessionCatalog: catalog(entries),
		});

		const direct = await query.report({ sessionId: session });
		if (!direct.ok) throw new Error(`report failed: ${direct.code}`);
		const latest = await query.report({ latest: true });
		if (!latest.ok) throw new Error(`latest report failed: ${latest.code}`);

		expect(direct.report.traceIds).toEqual([first, second]);
		expect(direct.report.summary.traceCount).toBe(2);
		expect(direct.report.traffic.llmHttp.tx.sum).toMatchObject({ availability: "available", value: 18 });
		expect(direct.report.traffic.llmHttp.tx.sampleCount).toBe(2);
		expect(latest.report.sessionId).toBe(session);
	});

	test("reports recording-off and missing traces as typed coverage instead of zero totals", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("off-session");
		const entries = [{ sessionId: session, createdAtMs: 1, updatedAtMs: 1 }];

		const off = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "off", failurePolicy: "best_effort" },
			sessionCatalog: catalog(entries),
		});
		const offResult = await off.report({ sessionId: session });
		if (!offResult.ok) throw new Error(`off report failed: ${offResult.code}`);
		expect(offResult.report.source.trace.state).toBe("recording_off");
		expect(offResult.report.coverage.find((entry) => entry.key === "trace")?.state).toBe("recording_off");
		expect(offResult.report.traffic.llmHttp.tx.sum).toMatchObject({ availability: "unavailable" });

		const missing = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "best_effort" },
			sessionCatalog: catalog(entries),
		});
		const missingResult = await missing.report({ sessionId: session });
		if (!missingResult.ok) throw new Error(`missing report failed: ${missingResult.code}`);
		expect(missingResult.report.source.trace.state).toBe("missing");
		expect(missingResult.report.coverage.find((entry) => entry.key === "trace")?.reason).toBe("trace_missing");
	});

	test("fails closed to tampered coverage and does not expose the canonical path", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("tampered-session");
		const trace = traceId("tampered-trace");
		const filePath = await appendTrace(root, session, trace, 19);
		const lines = (await readFile(filePath, "utf8")).trim().split("\n");
		const original = JSON.parse(lines[1]!) as Record<string, unknown>;
		const body = { ...original, name: "observation:tampered" };
		lines[1] = canonicalJson(body);
		await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");

		const query = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "best_effort" },
			sessionCatalog: catalog([{ sessionId: session, createdAtMs: 1, updatedAtMs: 1 }]),
		});
		const result = await query.report({ sessionId: session });
		if (!result.ok) throw new Error(`tampered report failed: ${result.code}`);
		expect(result.report.source.trace.state).toBe("tampered");
		expect(result.report.traceIds).toEqual([trace]);
		expect(result.report.source.trace.traceIds).toEqual([trace]);
		expect(result.report.coverage.find((entry) => entry.key === "trace")?.reason).toBe("trace_tampered");
		expect(result.report.traffic.llmHttp.tx.sum).toMatchObject({ availability: "unavailable" });

		const status = await query.status();
		expect(JSON.stringify(status)).not.toContain(root);
		expect(status.recording.mode).toBe("events");
	});

	test("fails closed when the first trace line is no longer parseable", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("tampered-first-line-session");
		const trace = traceId("tampered-first-line-trace");
		const filePath = await appendTrace(root, session, trace, 23);
		const contents = await readFile(filePath, "utf8");
		await writeFile(filePath, `!${contents.slice(1)}`, "utf8");
		const query = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "fail_closed" },
			sessionCatalog: catalog([{ sessionId: session, createdAtMs: 1, updatedAtMs: 1 }]),
		});

		const result = await query.report({ sessionId: session });
		if (!result.ok) throw new Error(`tampered report failed: ${result.code}`);
		expect(result.report.source.trace.state).toBe("tampered");
		expect(result.report.traceIds).toEqual([trace]);
		expect(result.report.coverage.find((entry) => entry.key === "trace")?.reason).toBe("trace_tampered");
	});

	test("uses the derived Session trace index instead of replaying unrelated history", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("indexed-session");
		const trace = traceId("indexed-trace");
		await appendTrace(root, session, trace, 29);
		for (let index = 0; index < 4; index += 1) {
			await appendTrace(root, sessionId(`unrelated-session-${index}`), traceId(`unrelated-trace-${index}`), index + 1);
		}
		const indexDirectory = join(root, "projections", "telemetry", "session-traces", session);
		await mkdir(indexDirectory, { recursive: true });
		await writeFile(join(indexDirectory, `${trace}.json`), canonicalJson({
			format: "runledger.telemetry.session-trace-index",
			version: 1,
			sessionId: session,
			traceId: trace,
			eventRelativeLocator: `events/2026/08/25/${trace}.jsonl`,
		}), "utf8");
		const eventsSpy = vi.spyOn(JsonlTraceEventStore.prototype, "events");
		const query = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "best_effort" },
			sessionCatalog: catalog([{ sessionId: session, createdAtMs: 1, updatedAtMs: 1 }]),
		});

		const result = await query.report({ sessionId: session });
		if (!result.ok) throw new Error(`indexed report failed: ${result.code}`);
		expect(result.report.traceIds).toEqual([trace]);
		expect(eventsSpy).toHaveBeenCalledTimes(1);
	});

	test("uses the Session-wide earliest and latest event for aggregate duration", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-telemetry-query-"));
		roots.push(root);
		const session = sessionId("duration-session");
		const first = traceId("duration-trace-1");
		const second = traceId("duration-trace-2");
		await appendTrace(root, session, first, 3, "2026-08-25T00:00:00.000Z");
		await appendTrace(root, session, second, 5, "2026-08-25T00:00:10.000Z");
		const query = createLocalTelemetryQuery({
			layout: buildRunledgerLayout(root, "posix"),
			recording: { mode: "events", failurePolicy: "best_effort" },
			sessionCatalog: catalog([{ sessionId: session, createdAtMs: 1, updatedAtMs: 1 }]),
		});

		const result = await query.report({ sessionId: session });
		if (!result.ok) throw new Error(`duration report failed: ${result.code}`);
		expect(result.report.summary.durationMs).toBe(10_000);
	});
});
