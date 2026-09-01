import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_TEST_DISCOVERY_RULES,
	inspectTestInventory,
	type TestDiscoveryRule,
} from "../../scripts/test-inventory.ts";

const fixtureRoots: string[] = [];

afterEach(async () => {
	await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(files: Readonly<Record<string, string>>): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "runledger-test-inventory-"));
	fixtureRoots.push(root);
	for (const [relativePath, contents] of Object.entries(files)) {
		const target = join(root, relativePath);
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, contents, "utf8");
	}
	return root;
}

function rulesWithoutCargo(): readonly TestDiscoveryRule[] {
	return DEFAULT_TEST_DISCOVERY_RULES.filter((rule) => rule.runner !== "cargo" && rule.id !== "vitest-built-cli-smoke");
}

describe("test inventory", () => {
	it("reports the current nested Bun orphan instead of silently dropping it", async () => {
		const root = await createFixture({
			"tests/tui/owned.bun.test.ts": "import { test } from 'bun:test';\ntest('owned', () => {});\n",
			"tests/utils/orphan.bun.test.ts": "import { test } from 'bun:test';\ntest('orphan', () => {});\n",
		});

		const report = await inspectTestInventory(root, { rules: rulesWithoutCargo() });

		expect(report.ok).toBe(true);
		expect(report.entries).toContainEqual({
			path: "tests/utils/orphan.bun.test.ts",
			runner: "bun",
			executionBucket: "tui-native",
			collected: null,
			defaultLocal: true,
			prCi: true,
			nightly: false,
		});
	});

	it("fails closed when a file is owned by both Vitest and Bun", async () => {
		const root = await createFixture({
			"tests/tui/overlap.bun.test.ts": "import { test } from 'bun:test';\ntest('overlap', () => {});\n",
		});
		const rules: readonly TestDiscoveryRule[] = [
			{
				id: "vitest-all",
				runner: "vitest",
				include: ["tests/**/*.test.ts"],
				executionBucket: "fast",
			},
			{
				id: "bun-all",
				runner: "bun",
				include: ["tests/**/*.bun.test.ts"],
				executionBucket: "tui-native",
			},
		];

		const report = await inspectTestInventory(root, { rules });

		expect(report.ok).toBe(false);
		expect(report.diagnostics).toContainEqual({
			code: "overlapping_runner_ownership",
			path: "tests/tui/overlap.bun.test.ts",
			rules: ["bun-all", "vitest-all"],
		});
	});

	it("fails closed when a configured test glob selects no files", async () => {
		const root = await createFixture({
			"tests/utils/owned.test.ts": "import { test } from 'vitest';\ntest('owned', () => {});\n",
		});
		const rules: readonly TestDiscoveryRule[] = [
			{
				id: "vitest",
				runner: "vitest",
				include: ["tests/**/*.test.ts"],
				exclude: ["tests/**/*.bun.test.ts"],
				executionBucket: "fast",
			},
			{
				id: "bun",
				runner: "bun",
				include: ["tests/missing/**/*.bun.test.ts"],
				executionBucket: "tui-native",
			},
		];

		const report = await inspectTestInventory(root, { rules });

		expect(report.ok).toBe(false);
		expect(report.diagnostics).toContainEqual({
			code: "empty_test_glob",
			path: "tests/missing/**/*.bun.test.ts",
			rules: ["bun"],
		});
	});

	it("retains an explicit zero collection count for passWithNoTests files", async () => {
		const root = await createFixture({
			"tests/utils/platform-only.test.ts": "import { describe } from 'vitest';\ndescribe.skip('platform', () => {});\n",
		});

		const report = await inspectTestInventory(root, {
			rules: rulesWithoutCargo(),
			collectedByFile: { "tests/utils/platform-only.test.ts": 0 },
		});

		expect(report.entries).toContainEqual({
			path: "tests/utils/platform-only.test.ts",
			runner: "vitest",
			executionBucket: "fast",
			collected: 0,
			defaultLocal: true,
			prCi: true,
			nightly: false,
		});
	});

	it("assigns exactly one explicit resource bucket to each default runner entry", async () => {
		const root = await createFixture({
			"tests/runtime/session-owner.test.ts": "import { test } from 'vitest';\ntest('runtime', () => {});\n",
			"tests/security/policy.test.ts": "import { test } from 'vitest';\ntest('security', () => {});\n",
			"tests/integration/socket-e2e.test.ts": "import { test } from 'vitest';\ntest('integration', () => {});\n",
			"tests/auth/kimi-code-oauth.test.ts": "import { test } from 'vitest';\ntest('singleton', () => {});\n",
		});

		const report = await inspectTestInventory(root, {
			rules: DEFAULT_TEST_DISCOVERY_RULES.filter((rule) => rule.runner !== "cargo"),
		});
		const buckets = new Map(report.entries.map((entry) => [entry.path, entry.executionBucket]));

		expect(buckets).toEqual(new Map([
			["tests/auth/kimi-code-oauth.test.ts", "singleton"],
			["tests/integration/socket-e2e.test.ts", "integration"],
			["tests/runtime/session-owner.test.ts", "runtime"],
			["tests/security/policy.test.ts", "security-storage"],
		]));
	});

	it("assigns the built CLI PTY smoke to its post-build bucket", async () => {
		const root = await createFixture({
			"tests/scripts/run-smoke-tests.test.ts": "import { test } from 'vitest';\ntest('smoke', () => {});\n",
		});

		const report = await inspectTestInventory(root, {
			rules: DEFAULT_TEST_DISCOVERY_RULES.filter((rule) => rule.runner !== "cargo"),
		});

		expect(report.entries).toContainEqual(expect.objectContaining({
			path: "tests/scripts/run-smoke-tests.test.ts",
			executionBucket: "smoke",
			defaultLocal: false,
		}));
	});
});
