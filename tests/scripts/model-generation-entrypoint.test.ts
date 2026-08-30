import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateModels } from "../../scripts/generate-models.ts";
import { readGeneratorOptions } from "../../scripts/model-generation/options.ts";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const frozenInput = fileURLToPath(new URL("../fixtures/model-generation/frozen-sources.json", import.meta.url));

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("model generator entrypoint", () => {
	it("is import-safe even when the host process has unrelated argv", () => {
		const result = spawnSync(process.execPath, [
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			'process.argv.push("placeholder", "--unrelated-flag"); await import("./scripts/generate-models.ts")',
		], { cwd: repoRoot, encoding: "utf8" });

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("generates from an explicit frozen source without making any network request", async () => {
		const outputRoot = await mkdtemp(join(tmpdir(), "runledger-model-generator-frozen-"));
		const fetchSpy = vi.fn(() => {
			throw new Error("frozen mode attempted network access");
		});
		vi.stubGlobal("fetch", fetchSpy);
		try {
			const options = readGeneratorOptions([
				"--source", "frozen",
				"--frozen-input", frozenInput,
				"--json-only",
				"--json-output", join(outputRoot, "catalog"),
			]);
			const result = await generateModels(options, { packageRoot: outputRoot, log: () => undefined });

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(result.source).toBe("frozen");
			expect(result.sourceModelCount).toBe(3);
			expect(existsSync(join(outputRoot, "catalog/models.json"))).toBe(true);
			expect(existsSync(join(outputRoot, "src/models.generated.ts"))).toBe(false);
			const generated = JSON.parse(readFileSync(join(outputRoot, "catalog/providers/fixture-primary.json"), "utf8"));
			expect(generated["fixture-primary"]).toMatchObject({ provider: "fixture-primary", id: "fixture-primary" });
		} finally {
			await rm(outputRoot, { recursive: true, force: true });
		}
	});

	it("requires an explicit frozen input path and rejects ambiguous source flags", () => {
		expect(() => readGeneratorOptions(["--source", "frozen"])).toThrow("--source frozen requires --frozen-input");
		expect(() => readGeneratorOptions(["--source", "remote", "--frozen-input", frozenInput])).toThrow("--frozen-input requires --source frozen");
	});
});
