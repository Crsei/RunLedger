import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
	LEGACY_RUNTIME_TOOL_ALLOWLIST,
	scanExecutionBoundaries,
} from "../../scripts/check-execution-boundaries.ts";

describe("current execution boundary baseline", () => {
	it("records raw I/O debt only in an exact per-file allowlist", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanExecutionBoundaries(repoRoot)).toEqual([]);
		expect(LEGACY_RUNTIME_TOOL_ALLOWLIST["src/runtime/tools"]).toHaveLength(9);
		expect(LEGACY_RUNTIME_TOOL_ALLOWLIST["src/runtime/tools"]).not.toContain("*");
	});
});
