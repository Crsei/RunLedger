import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	TraceStorageSecurityError,
	createLocalTraceRecorderFactory,
} from "../../../src/runtime/trace/composition.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-trace-composition-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local trace composition", () => {
	it("off mode creates no recorder or trace directory", async () => {
		const root = await fixtureRoot();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "off", failurePolicy: "best_effort" },
		});

		expect(await factory.create({ sessionId: createRuntimeId("session", "off") })).toBeUndefined();
		expect(existsSync(layout.events)).toBe(false);
	});

	it("events mode writes one canonical UTC-sharded trace file", async () => {
		const root = await fixtureRoot();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "events", failurePolicy: "fail_closed" },
			now: () => new Date("2026-08-02T10:20:30.000Z"),
			createTraceId: () => createRuntimeId("trace", "composition"),
		});

		const recorder = await factory.create({
			sessionId: createRuntimeId("session", "events"),
			ownerGeneration: 7,
		});
		expect(recorder?.traceId).toBe("trace_composition");
		await recorder?.startRun();
		const eventPath = join(layout.events, "2026", "08", "02", "trace_composition.jsonl");
		expect(existsSync(eventPath)).toBe(true);
		const started = JSON.parse((await readFile(eventPath, "utf8")).split("\n")[0]!) as {
			metadata?: Record<string, unknown>;
		};
		expect(started.metadata).toMatchObject({
			sessionId: "session_events",
			ownerGeneration: 7,
			recordingMode: "events",
			failurePolicy: "fail_closed",
			recordingConfigDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
		});
		const indexPath = join(layout.projections, "telemetry", "session-traces", "session_events", "trace_composition.json");
		const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
		expect(index).toEqual({
			format: "runledger.telemetry.session-trace-index",
			version: 1,
			sessionId: "session_events",
			traceId: "trace_composition",
			eventRelativeLocator: "events/2026/08/02/trace_composition.jsonl",
		});
		expect(existsSync(layout.artifacts)).toBe(false);
	});

	it("allows tool body artifacts when recording is explicitly configured", async () => {
		const root = await fixtureRoot();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "events_and_artifacts", failurePolicy: "best_effort" },
		});
		const recorder = await factory.create({ sessionId: createRuntimeId("session", "artifacts") });
		const handle = await recorder?.startModel({
			turn: 1,
			model: mockModel,
			context: { systemPrompt: "safe", messages: [], tools: [] },
		});

		expect(handle?.inputContent.storage).toBe("artifact");
		expect(existsSync(layout.artifacts)).toBe(true);
	});

	it("rejects an events directory symlink that escapes the canonical home", async () => {
		if (process.platform === "win32") return;
		const root = await fixtureRoot();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const outside = join(root, "outside");
		await mkdir(layout.home, { recursive: true });
		await mkdir(outside, { recursive: true });
		await symlink(outside, layout.events, "dir");
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "events", failurePolicy: "best_effort" },
		});

		await expect(factory.create({ sessionId: createRuntimeId("session", "symlink") }))
			.rejects.toBeInstanceOf(TraceStorageSecurityError);
		expect(await readdir(outside)).toEqual([]);
	});

	it("does not materialize derived trace-index directories through a projections symlink", async () => {
		if (process.platform === "win32") return;
		const root = await fixtureRoot();
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const outside = join(root, "outside-projections");
		await mkdir(layout.home, { recursive: true });
		await mkdir(outside, { recursive: true });
		await symlink(outside, layout.projections, "dir");
		const diagnostics: string[] = [];
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "events", failurePolicy: "fail_closed" },
			onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
		});

		expect(await factory.create({ sessionId: createRuntimeId("session", "index-symlink") })).toBeDefined();
		expect(diagnostics).toEqual(["trace_index_write_failed"]);
		expect(await readdir(outside)).toEqual([]);
	});
});
