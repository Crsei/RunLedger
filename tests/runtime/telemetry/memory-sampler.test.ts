import { once } from "node:events";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	LinuxProcessTreeSampler,
	ManagedProcessMemorySampler,
	parseProcStat,
	recordLogicalSessionState,
	recordManagedProcessMemory,
	RuntimeMemorySampler,
	sizeLogicalSessionState,
	unsupportedManagedProcessMemory,
	type MemoryScheduler,
} from "../../../src/runtime/telemetry/local/memory.ts";
import type { TelemetryObservation } from "../../../src/runtime/telemetry/local/types.ts";

function correlation() {
	return {
		sessionId: createRuntimeId("session", "memory-test"),
		traceId: createRuntimeId("trace", "memory-test"),
		ownerGeneration: 1,
	};
}

describe("local telemetry memory measurements", () => {
	test("samples light RSS every 2s, full Node memory every 10s, and force-samples boundaries", async () => {
		const observations: TelemetryObservation[] = [];
		const intervals: Array<{ callback: () => void; ms: number; unrefCalled: boolean; cleared: boolean }> = [];
		const scheduler: MemoryScheduler = {
			setInterval(callback, ms) {
				const entry = { callback, ms, unrefCalled: false, cleared: false };
				intervals.push(entry);
				return {
					unref: () => { entry.unrefCalled = true; },
					clear: () => { entry.cleared = true; },
				};
			},
		};
		const sampler = new RuntimeMemorySampler({
			correlation: correlation(),
			scheduler,
			now: () => 1_000,
			memoryUsage: () => ({ rss: 100, heapTotal: 200, heapUsed: 150, external: 30, arrayBuffers: 10 }),
			observe: async (observation) => { observations.push(observation); return { ok: true as const }; },
		});
		await sampler.start();
		expect(intervals.map((entry) => entry.ms)).toEqual([2_000, 10_000]);
		expect(intervals.every((entry) => entry.unrefCalled)).toBe(true);
		intervals[0]!.callback();
		intervals[1]!.callback();
		await sampler.forceSample("turn");
		expect(observations.filter((observation) => observation.kind === "runtime_memory")).toHaveLength(3);
		expect(observations[0]).toMatchObject({ kind: "runtime_memory", rssBytes: { value: 100 } });
		expect(observations[0]).toMatchObject({ heapTotalBytes: { availability: "unavailable" } });
		await sampler.close();
		expect(intervals.every((entry) => entry.cleared)).toBe(true);
		intervals[0]!.callback();
		expect(observations).toHaveLength(3);
	});

	test("surfaces fail-closed observation failures from a forced runtime sample", async () => {
		const failure = new Error("trace event store unavailable");
		const sampler = new RuntimeMemorySampler({
			correlation: correlation(),
			memoryUsage: () => ({ rss: 100, heapTotal: 200, heapUsed: 150, external: 30, arrayBuffers: 10 }),
			observe: async () => { throw failure; },
		});

		await expect(sampler.forceSample("turn")).rejects.toBe(failure);
		await sampler.close();
	});

	test("latches a scheduled runtime observation failure until the next governed boundary", async () => {
		const intervals: Array<() => void> = [];
		const failure = new Error("scheduled trace write failed");
		let failObservation = true;
		const sampler = new RuntimeMemorySampler({
			correlation: correlation(),
			scheduler: {
				setInterval(callback) {
					intervals.push(callback);
					return { clear: () => undefined };
				},
			},
			memoryUsage: () => ({ rss: 100, heapTotal: 200, heapUsed: 150, external: 30, arrayBuffers: 10 }),
			observe: async () => {
				if (failObservation) throw failure;
				return { ok: true as const };
			},
		});
		await sampler.start();
		intervals[0]?.();
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		failObservation = false;

		await expect(sampler.forceSample("turn")).rejects.toBe(failure);
		await sampler.close();
	});

	test("sizes each current-format logical session component using canonical UTF-8 bytes", () => {
		const result = sizeLogicalSessionState({
			messages: [{ role: "user", content: "😀" }],
			toolResults: [{ ok: true, text: "结果" }],
			planTask: { taskId: "task_1", acceptance: "pass" },
			checkpointDescriptor: { sequence: 4 },
			contextCurrentTokens: 37,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.components.messagesBytes).toBe(Buffer.byteLength('[{"content":"😀","role":"user"}]', "utf8"));
		expect(result.totalBytes).toBe(
			result.components.messagesBytes
			+ result.components.toolResultsBytes
			+ result.components.planTaskBytes
			+ result.components.checkpointDescriptorBytes,
		);
	});

	test("Linux process tree sums RSS/PSS/USS and rejects a reused root PID", async () => {
		const files = new Map<string, string>([
			["/proc/100/stat", statLine(100, 1, 111)],
			["/proc/200/stat", statLine(200, 100, 222)],
			["/proc/201/stat", statLine(201, 200, 333)],
			["/proc/100/status", "Name:\troot\nVmRSS:\t100 kB\n"],
			["/proc/200/status", "Name:\tchild\nVmRSS:\t50 kB\n"],
			["/proc/201/status", "Name:\tgrandchild\nVmRSS:\t25 kB\n"],
			["/proc/100/smaps_rollup", smaps(80, 40, 20)],
			["/proc/200/smaps_rollup", smaps(40, 20, 10)],
			["/proc/201/smaps_rollup", smaps(20, 10, 5)],
		]);
		const sampler = new LinuxProcessTreeSampler({
			root: { pid: 100, startTime: 111 },
			listDirectory: async () => ["100", "200", "201", "not-a-pid"],
			readFile: async (path) => {
				const value = files.get(path);
				if (value === undefined) throw new Error("missing");
				return value;
			},
		});
		const measured = await sampler.sample();
		expect(measured).toMatchObject({ ok: true, rssBytes: 175 * 1024, pssBytes: 70 * 1024, ussBytes: 35 * 1024, processCount: 3 });

		const reused = new LinuxProcessTreeSampler({
			root: { pid: 100, startTime: 999 },
			listDirectory: async () => ["100"],
			readFile: async (path) => files.get(path) ?? "",
		});
		expect(await reused.sample()).toMatchObject({ ok: false, reason: "sample_failed" });
	});

	test("treats a disappearing process as a sampling gap and preserves permission_denied", async () => {
		const files = new Map<string, string>([
			["/proc/100/stat", statLine(100, 1, 111)],
			["/proc/200/stat", statLine(200, 100, 222)],
			["/proc/100/status", "VmRSS:\t100 kB\n"],
			["/proc/100/smaps_rollup", smaps(80, 40, 20)],
		]);
		const disappeared = new LinuxProcessTreeSampler({
			root: { pid: 100, startTime: 111 },
			listDirectory: async () => ["100", "200"],
			readFile: async (path) => {
				const value = files.get(path);
				if (value === undefined) throw Object.assign(new Error("process disappeared"), { code: "ENOENT" });
				return value;
			},
		});
		expect(await disappeared.sample()).toMatchObject({ ok: false, reason: "sample_failed" });

		const denied = new LinuxProcessTreeSampler({
			root: { pid: 100, startTime: 111 },
			listDirectory: async () => ["100"],
			readFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
		});
		expect(await denied.sample()).toMatchObject({ ok: false, reason: "permission_denied" });
	});

	test("rejects a descendant whose PID start time changes during sampling", async () => {
		let childStatReads = 0;
		const sampler = new LinuxProcessTreeSampler({
			root: { pid: 100, startTime: 111 },
			listDirectory: async () => ["100", "200"],
			readFile: async (path) => {
				if (path === "/proc/100/stat") return statLine(100, 1, 111);
				if (path === "/proc/200/stat") {
					childStatReads += 1;
					return statLine(200, 100, childStatReads === 1 ? 222 : 999);
				}
				if (path === "/proc/100/status" || path === "/proc/200/status") return "VmRSS:\t1 kB\n";
				if (path === "/proc/100/smaps_rollup" || path === "/proc/200/smaps_rollup") return smaps(1, 1, 1);
				throw new Error(`unexpected path: ${path}`);
			},
		});

		expect(await sampler.sample()).toMatchObject({ ok: false, reason: "sample_failed" });
	});

	test("measures an isolated Linux child tree and reports a missing root after exit", async () => {
		if (process.platform !== "linux") return;
		const childScript = "setInterval(() => {}, 1000)";
		const rootScript = [
			"const { spawn } = require('node:child_process');",
			`const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
			"process.stdout.write(String(child.pid) + '\\n');",
			"process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });",
			"setInterval(() => {}, 1000);",
		].join(" ");
		const root = spawn(process.execPath, ["-e", rootScript], { stdio: ["ignore", "pipe", "ignore"] });
		let childPid: number | undefined;
		try {
			const childPidText = await new Promise<string>((resolve, reject) => {
				root.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8").trim()));
				root.once("error", reject);
			});
			childPid = Number(childPidText);
			if (!Number.isSafeInteger(root.pid) || !Number.isSafeInteger(childPid)) throw new Error("isolated process tree did not start");
			const rootStat = parseProcStat(await readFile(`/proc/${root.pid}/stat`, "utf8"));
			if (rootStat === undefined) throw new Error("root process stat is unavailable");
			const sampler = new LinuxProcessTreeSampler({
				root: { pid: root.pid, startTime: rootStat.startTime },
				listDirectory: async () => readdir("/proc"),
				readFile: async (path) => readFile(path, "utf8"),
			});

			const measured = await sampler.sample();
			expect(measured.ok).toBe(true);
			if (measured.ok) {
				expect(measured.processCount).toBeGreaterThanOrEqual(2);
				expect(measured.rssBytes).toBeGreaterThan(0);
				expect(measured.pssBytes).toBeGreaterThan(0);
				expect(measured.ussBytes).toBeGreaterThan(0);
			}

			root.kill("SIGTERM");
			await once(root, "exit");
			expect(await sampler.sample()).toMatchObject({ ok: false, reason: "sample_failed" });
		} finally {
			if (root.exitCode === null && root.signalCode === null) root.kill("SIGKILL");
			if (childPid !== undefined) {
				try { process.kill(childPid, "SIGKILL"); } catch { /* child may already have exited with the root */ }
			}
		}
	});

	test("records logical and managed-process samples with explicit unavailable quantities", async () => {
		const observations: TelemetryObservation[] = [];
		const port = { observe: async (observation: TelemetryObservation) => { observations.push(observation); return { ok: true as const }; } };
		await recordLogicalSessionState(port, {
			correlation: correlation(),
			state: { messages: [], toolResults: [], planTask: {}, checkpointDescriptor: {} },
		});
		await recordManagedProcessMemory(port, {
			correlation: { ...correlation(), executionId: createRuntimeId("execution", "memory-test") },
			sample: { ok: false, reason: "sample_failed" },
		});
		expect(observations[0]?.kind).toBe("logical_session_state");
		expect(observations[1]).toMatchObject({ kind: "managed_process_memory", pssBytes: { availability: "unavailable", reason: "sample_failed" } });
	});

	test("uses platform_unsupported only for an unsupported managed-process adapter", async () => {
		const observations: TelemetryObservation[] = [];
		const port = { observe: async (observation: TelemetryObservation) => { observations.push(observation); return { ok: true as const }; } };
		await recordManagedProcessMemory(port, {
			correlation: { ...correlation(), executionId: createRuntimeId("execution", "memory-unsupported") },
			sample: unsupportedManagedProcessMemory(),
		});
		await recordManagedProcessMemory(port, {
			correlation: { ...correlation(), executionId: createRuntimeId("execution", "memory-permission") },
			sample: { ok: false, reason: "permission_denied" },
		});

		expect(observations[0]).toMatchObject({ kind: "managed_process_memory", pssBytes: { availability: "unavailable", reason: "platform_unsupported" } });
		expect(observations[1]).toMatchObject({ kind: "managed_process_memory", pssBytes: { availability: "unavailable", reason: "permission_denied" } });
	});

	test("samples managed process memory on a 2s cadence, force-samples the boundary, and disposes cleanly", async () => {
		const observations: TelemetryObservation[] = [];
		const intervals: Array<{ callback: () => void; ms: number; unrefCalled: boolean; cleared: boolean }> = [];
		let now = 1_000;
		const scheduler: MemoryScheduler = {
			setInterval(callback, ms) {
				const entry = { callback, ms, unrefCalled: false, cleared: false };
				intervals.push(entry);
				return {
					unref: () => { entry.unrefCalled = true; },
					clear: () => { entry.cleared = true; },
				};
			},
		};
		const files = new Map<string, string>([
			["/proc/100/stat", statLine(100, 1, 111)],
			["/proc/100/status", "VmRSS:\t100 kB\n"],
			["/proc/100/smaps_rollup", smaps(80, 40, 20)],
		]);
		const sampler = new ManagedProcessMemorySampler({
			root: { pid: 100, startTime: 111 },
			correlation: { ...correlation(), executionId: createRuntimeId("execution", "memory-cadence") },
			 scheduler,
			now: () => now,
			listDirectory: async () => ["100"],
			readFile: async (path) => files.get(path) ?? "",
			observe: { observe: async (observation: TelemetryObservation) => { observations.push(observation); return { ok: true as const }; } },
		});

		await sampler.start();
		expect(intervals.map((entry) => entry.ms)).toEqual([2_000]);
		expect(intervals[0]?.unrefCalled).toBe(true);
		now = 3_000;
		intervals[0]!.callback();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(observations).toHaveLength(1);
		expect(observations[0]?.monotonicOffsetMs).toBe(2_000);

		now = 4_000;
		await sampler.forceSample();
		expect(observations).toHaveLength(2);
		await sampler.close();
		expect(intervals[0]?.cleared).toBe(true);
		intervals[0]!.callback();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(observations).toHaveLength(2);
	});
});

function statLine(pid: number, parentPid: number, startTime: number): string {
	const fields = ["S", String(parentPid), ...Array.from({ length: 17 }, () => "0"), String(startTime), "0", "0", "0"];
	return `${pid} (runledger) ${fields.join(" ")}`;
}

function smaps(rss: number, pss: number, privateBytes: number): string {
	return `Rss: ${rss} kB\nPss: ${pss} kB\nPrivate_Clean: ${privateBytes} kB\nPrivate_Dirty: 0 kB\n`;
}
