import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
	CANONICAL_STORAGE_ADAPTER_ALLOWLIST,
	EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST,
	MANAGED_PROCESS_BACKEND_ALLOWLIST,
	scanExecutionBoundaries,
} from "../../scripts/check-execution-boundaries.ts";

describe("current execution boundary baseline", () => {
	it("has no raw I/O debt in production runtime tools", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanExecutionBoundaries(repoRoot)).toEqual([]);
		expect(CANONICAL_STORAGE_ADAPTER_ALLOWLIST).toEqual([]);
		expect(EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST).toEqual([
			"src/security/integration/session-local-leaves.ts",
		]);
		expect(MANAGED_PROCESS_BACKEND_ALLOWLIST).toEqual([
			"src/cli/linux-peer-attestor.ts",
			"src/cli/runtime-host-production.ts",
			"src/storage/process/node-pty-adapter.ts",
			"src/storage/process/process-backend.ts",
			"src/storage/process/supervisor-runner.ts",
		]);
	});
});
