import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runManagedProcessPtyVerification } from "../../../scripts/verify-managed-process-pty.ts";

const execFileAsync = promisify(execFile);

describe("R10 executable acceptance runners", () => {
	it("verifies two real local Host clients over one authenticated socket", async () => {
		const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/verify-multi-client-host.ts"], {
			cwd: process.cwd(),
			maxBuffer: 64 * 1024,
		});
		const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "") as {
			readonly passed: boolean;
			readonly checks: readonly string[];
		};
		expect(result.passed).toBe(true);
		expect(result.checks).toEqual(expect.arrayContaining([
			"two_clients_one_host",
			"same_session_owner",
			"driver_fence",
			"command_idempotency",
			"standard_path_connect_or_spawn",
		]));
	});

	it("verifies governed PTY output, resize, stop fence, recovery, and Queue dedupe", async () => {
		const result = await runManagedProcessPtyVerification();
		expect(result.passed).toBe(true);
		expect(result.checks).toEqual(expect.arrayContaining([
			"production_host_facade",
			"client_detach",
			"pty_utf8",
			"driver_fence",
			"queue_dedupe",
			"output_recovery",
		]));
	});
});
