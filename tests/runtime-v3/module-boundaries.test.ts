import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { scanRuntimeBoundaries } from "../../scripts/check-runtime-boundaries.ts";

describe("Runtime contract module boundary", () => {
	it("does not import storage, UI, provider, or raw I/O modules", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanRuntimeBoundaries(repoRoot)).toEqual([]);
	});
});
