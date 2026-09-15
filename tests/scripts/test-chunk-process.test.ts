import { describe, expect, it } from "vitest";
import { runTestChunk } from "../../scripts/test-chunk-process.ts";

const options = { cwd: process.cwd(), env: process.env, watchdogMs: 5_000 };

describe("test chunk process evidence", () => {
	it("records successful execution and an ordinary failing exit separately", async () => {
		const passed = await runTestChunk(process.execPath, ["-e", "process.exit(0)"], options);
		const failed = await runTestChunk(process.execPath, ["-e", "process.exit(2)"], options);
		expect(passed).toMatchObject({ exitCode: 0, failureKind: null, timeoutKind: null, signal: null });
		expect(passed.durationMs).toBeGreaterThan(0);
		expect(failed).toMatchObject({ exitCode: 2, failureKind: "test_failure", timeoutKind: null });
	});

	it("records spawn errors without throwing or reporting a passing exit", async () => {
		const result = await runTestChunk("/nonexistent/runledger-test-executable", [], options);
		expect(result).toMatchObject({ exitCode: 1, failureKind: "spawn_error", errorCode: "ENOENT" });
	});

	it("distinguishes watchdog termination from an externally killed process", async () => {
		const timedOut = await runTestChunk(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { ...options, watchdogMs: 300 });
		expect(timedOut).toMatchObject({ exitCode: 1, failureKind: "timeout", timeoutKind: "watchdog" });
		expect(timedOut.durationMs).toBeLessThan(5_000);
		const killed = await runTestChunk(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], options);
		expect(killed).toMatchObject({ exitCode: 1, failureKind: "signal", signal: "SIGKILL", timeoutKind: null });
	});
});
