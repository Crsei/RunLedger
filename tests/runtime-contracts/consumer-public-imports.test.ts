import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTRACT_INVENTORY } from "../../src/runtime/contracts/inventory.ts";

const consumersDirectory = fileURLToPath(new URL("./consumers/", import.meta.url));
const consumerFiles = readdirSync(consumersDirectory)
	.filter((file) => file.endsWith(".consumer.ts"))
	.sort();

describe("Governed Runtime public contract consumers", () => {
	it("imports every contract only through the audited public barrel", () => {
		expect(consumerFiles).toEqual([
			"plan-context-memory.consumer.ts",
			"plugin-resource.consumer.ts",
			"security-worktree.consumer.ts",
		]);

		for (const file of consumerFiles) {
			const source = readFileSync(`${consumersDirectory}/${file}`, "utf8");
			const importSpecifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
			expect(importSpecifiers, file).toEqual([
				"../../../src/runtime/contracts/public.ts",
				"../../../src/runtime/contracts/public.ts",
			]);
		}
	});

	it("registers the public surface and consumer compile fixtures in the inventory", () => {
		const publicSurface = CONTRACT_INVENTORY.find((entry) => entry.id === "public-surface");
		expect(publicSurface?.modules).toEqual(["src/runtime/contracts/public.ts"]);
		expect(publicSurface?.fixtures).toEqual([
			"tests/runtime-contracts/public-surface.test.ts",
			"tests/runtime-contracts/consumer-public-imports.test.ts",
			"tests/runtime-contracts/consumers/plugin-resource.consumer.ts",
			"tests/runtime-contracts/consumers/security-worktree.consumer.ts",
			"tests/runtime-contracts/consumers/plan-context-memory.consumer.ts",
		]);
		expect(publicSurface?.gaps).toEqual([]);
	});

	it("wires the dedicated consumer compiler into the complete check gate", () => {
		const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
		const packageJson = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8")) as {
			scripts?: Record<string, string>;
		};
		expect(packageJson.scripts?.["check:contract-consumers"]).toBe(
			"tsc --noEmit -p tsconfig.contract-consumers.json",
		);
		expect(packageJson.scripts?.check).toContain("npm run check:contract-consumers");
	});
});
