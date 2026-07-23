import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const consumerProject = fileURLToPath(new URL("./tsconfig.json", import.meta.url));

const PUBLIC_SUBPATHS = {
	"./runtime/orchestrator": "./dist/runtime/orchestrator/index",
	"./runtime/verification": "./dist/runtime/verification/index",
	"./runtime/agents": "./dist/runtime/agents/index",
	"./runtime/control-plane": "./dist/runtime/control-plane/index",
	"./runtime/telemetry": "./dist/runtime/telemetry/index",
	"./runtime/lifecycle": "./dist/runtime/lifecycle/index",
	"./runtime/identity/enterprise": "./dist/runtime/identity/enterprise",
	"./runtime/executors": "./dist/runtime/executors/index",
	"./daemon": "./dist/daemon/index",
	"./verification-runner": "./dist/verification-runner/index",
} as const;

interface PackageExportTarget {
	import: string;
	types: string;
}

interface PackageManifest {
	exports: Record<string, string | PackageExportTarget>;
}

describe("Phase 7-11 public package surface", () => {
	it("publishes explicit stable entrypoints instead of relying on the runtime wildcard", () => {
		const manifest = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8")) as PackageManifest;
		for (const [subpath, targetBase] of Object.entries(PUBLIC_SUBPATHS)) {
			const target = manifest.exports[subpath];
			expect(target, subpath).toEqual({
				import: `${targetBase}.js`,
				types: `${targetBase}.d.ts`,
			});
		}
	});

	it("type-checks a consumer through root namespaces and every stable subpath", () => {
		const result = spawnSync(
			process.execPath,
			[`${repoRoot}/node_modules/typescript/bin/tsc`, "--pretty", "false", "-p", consumerProject],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		expect(`${result.stdout}${result.stderr}`).toBe("");
		expect(result.status).toBe(0);
	});
});
