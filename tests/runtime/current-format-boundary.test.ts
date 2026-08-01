import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanCurrentFormatMarkers } from "../../scripts/check-current-format.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("current format boundary", () => {
	it("provides a repository marker checker", () => {
		expect(existsSync(`${repoRoot}/scripts/check-current-format.ts`)).toBe(true);
	});

	it("finds no internal generation markers in first-party surfaces", () => {
		expect(scanCurrentFormatMarkers(repoRoot)).toEqual([]);
	});

	it("rejects glued internal generation identifiers", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "runledger-current-marker-"));
		try {
			const runtimeEventMarker = ["RuntimeEvent", "V" + 3].join("");
			const requirementsMarker = ["PRODUCTION_FEATURE_REQUIREMENTS", "V" + 1].join("_");
			await writeFile(
				join(fixtureRoot, "README.md"),
				`${runtimeEventMarker}\n${requirementsMarker}\n`,
				"utf8",
			);

			expect(scanCurrentFormatMarkers(fixtureRoot)).toEqual([
				{
					file: "README.md",
					line: 1,
					reason: "generation-specific identifier",
					text: runtimeEventMarker,
				},
				{
					file: "README.md",
					line: 2,
					reason: "generation-specific identifier",
					text: requirementsMarker,
				},
			]);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});
