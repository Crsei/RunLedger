import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(overrides: Record<string, unknown> = {}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-typecheck-coverage-"));
	roots.push(root);
	const files = {
		"tests/node.test.ts": "export {};",
		"tests/nested/view.bun.test.ts": "export {};",
		"tests/helpers/fixture.ts": "export {};",
		"scripts/generate.ts": "export {};",
		"examples/demo.ts": "export {};",
		"vitest.config.ts": "export {};",
		"tsconfig.tests.json": { compilerOptions: { types: ["node"] }, include: ["tests/**/*.ts"], exclude: ["tests/**/*.bun.test.ts"] },
		"tsconfig.bun-tests.json": { compilerOptions: { types: ["bun"] }, include: ["tests/**/*.bun.test.ts"] },
		"tsconfig.scripts.json": { compilerOptions: { types: ["node"] }, include: ["scripts/**/*.ts", "vitest.config.ts"] },
		"tsconfig.examples.json": { compilerOptions: { types: ["node"] }, include: ["examples/**/*.ts"] },
		...overrides,
	};
	for (const [path, value] of Object.entries(files)) {
		await mkdir(join(root, path, ".."), { recursive: true });
		await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
	}
	return root;
}

function check(root: string) {
	return spawnSync(process.execPath, ["--import", "tsx", "scripts/check-typecheck-coverage.ts", "--root", root], { encoding: "utf8", timeout: 20_000 });
}

describe("consumer typecheck ownership", () => {
	it("rejects a script omitted from its config even when the tests are covered", async () => {
		const root = await fixture({ "scripts/forgotten.ts": "export {};", "tsconfig.scripts.json": { include: ["scripts/generate.ts"] } });
		const result = check(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unowned_consumer: scripts/forgotten.ts");
	});
	it("requires Bun files to have one owner and the Bun ambient environment", async () => {
		const root = await fixture({ "tsconfig.tests.json": { include: ["tests/**/*.ts"] }, "tsconfig.bun-tests.json": { compilerOptions: { types: ["node"] }, include: ["tests/**/*.bun.test.ts"] } });
		const result = check(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("overlapping_consumer: tests/nested/view.bun.test.ts");
		expect(result.stderr).toContain("missing_bun_types: tsconfig.bun-tests.json");
	});
	it("rejects an unowned root Vitest config", async () => {
		const result = check(await fixture({ "tsconfig.scripts.json": { compilerOptions: { types: ["node"] }, include: ["scripts/**/*.ts"] } }));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unowned_consumer: vitest.config.ts");
	});
	it("owns nested tests, helpers, scripts and examples without sharing runner globals", async () => {
		const result = check(await fixture());
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("6 consumers, 0 diagnostics");
	});
});
