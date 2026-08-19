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

	it("does not classify Mermaid stateDiagram-v2 syntax as an internal generation marker", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "runledger-current-mermaid-marker-"));
		try {
			await writeFile(join(fixtureRoot, "README.md"), `${["stateDiagram", "v" + "2"].join("-")}\n`, "utf8");

			expect(scanCurrentFormatMarkers(fixtureRoot)).toEqual([]);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("does not classify an external API route version as an internal generation marker", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "runledger-current-api-route-marker-"));
		try {
			await writeFile(join(fixtureRoot, "README.md"), "POST /v1/chat/completions\n", "utf8");

			expect(scanCurrentFormatMarkers(fixtureRoot)).toEqual([]);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("continues to reject an unrelated hyphenated generation marker", async () => {
		const fixtureRoot = await mkdtemp(join(tmpdir(), "runledger-current-hyphenated-marker-"));
		try {
			const marker = ["feature", "v" + "2"].join("-");
			await writeFile(join(fixtureRoot, "README.md"), `${marker}\n`, "utf8");

			expect(scanCurrentFormatMarkers(fixtureRoot)).toEqual([{
				file: "README.md",
				line: 1,
				reason: "internal generation marker",
				text: marker,
			}]);
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
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
