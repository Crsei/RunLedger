import { describe, expect, it } from "vitest";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runManagedProcessPtyVerification } from "../../../scripts/verify-managed-process-pty.ts";
import { runMultiClientHostVerification } from "../../../scripts/verify-multi-client-host.ts";
import { runHostBuildReplacementVerification } from "../../../scripts/verify-host-build-replacement.ts";

const execFileAsync = promisify(execFile);

describe.skipIf(IS_WINDOWS)("R10 executable acceptance runners", () => {
	it("verifies two real local Host clients over one authenticated socket", async () => {
		const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/verify-multi-client-host.ts"], {
			cwd: process.cwd(),
			maxBuffer: 64 * 1024,
		});
		const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "") as {
			readonly passed: boolean;
			readonly outcome: string;
			readonly checks: readonly string[];
		};
		expect(result.passed).toBe(true);
		expect(result.outcome).toBe("pass");
		expect(result.checks).toEqual(expect.arrayContaining([
			"two_clients_one_host",
			"same_session_owner",
			"driver_fence",
			"stale_fence_rejected",
			"explicit_driver_transfer",
			"command_idempotency",
			"production_api_connect_or_spawn",
			"host_sigkill_no_duplicate_spawn",
			"lost_or_uncertain_projection",
		]));
	}, 30_000);

	it("verifies governed PTY output, resize, stop fence, reconnect cursor, and terminal wait idempotency", async () => {
		const result = await runManagedProcessPtyVerification();
		expect(result.passed).toBe(true);
		expect(result.outcome).toBe("pass");
		expect(result.checks).toEqual(expect.arrayContaining([
			"production_host_facade",
			"client_detach",
			"pty_utf8",
			"pty_stdin",
			"driver_fence",
			"terminal_wait_idempotency",
			"client_reconnect_output_cursor",
		]));
	});

	it("reports macOS and Windows as unsupported instead of a failed production capability", async () => {
		const host = await runMultiClientHostVerification({ platform: "darwin" });
		const pty = await runManagedProcessPtyVerification({ platform: "win32" });
		expect(host).toMatchObject({ passed: false, outcome: "unsupported", checks: [] });
		expect(pty).toMatchObject({ passed: false, outcome: "unsupported", checks: [] });
	});

	it("replaces a same-version Host only when the executable content digest matches the target", async () => {
		const result = await runHostBuildReplacementVerification();
		expect(result).toMatchObject({ passed: true, outcome: "pass" });
		expect(result.checks).toEqual(expect.arrayContaining([
			"same_version_different_content",
			"host_build_mismatch",
			"maintenance_target_fence",
			"replacement_generation_advanced",
		]));
	}, 30_000);
});
