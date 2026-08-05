import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { scanStorageCliBoundaries } from "../../scripts/check-storage-boundaries.ts";

describe("canonical storage boundary checker", () => {
	it("does not classify extension path utilities as the historical storage locator", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		expect(scanStorageCliBoundaries(repoRoot)).toEqual([]);
	});
});
