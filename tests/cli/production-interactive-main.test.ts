import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
	RUNTIME_FEATURE_NAMES,
	type RuntimeFeatureFlags,
} from "../../src/runtime/runtime-features.ts";
import { saveProjectSettings } from "../../src/storage/settings-manager.ts";
import { V3SessionManager } from "../../src/storage/v3-session-manager.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const roots: string[] = [];
const managers: V3SessionManager[] = [];

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function allFeatures(): RuntimeFeatureFlags {
	return Object.fromEntries(RUNTIME_FEATURE_NAMES.map((feature) => [feature, true])) as RuntimeFeatureFlags;
}

describe("production interactive CLI startup", () => {
	it("fails closed without a production adapter provider and releases the V3 writer lease", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "runledger-production-main-"));
		roots.push(cwd);
		const features = allFeatures();
		await saveProjectSettings(cwd, {
			sessionV3FeatureState: "default",
			runtimeFeatures: features,
		});

		const result = spawnSync(process.execPath, ["--import", TSX_LOADER, CLI_PATH], {
			cwd,
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("production interactive runtime adapters are unavailable");

		const sessionDir = join(cwd, ".runledger", "sessions");
		const sessionFiles = (await readdir(sessionDir))
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(sessionDir, file));
		expect(sessionFiles).toHaveLength(1);
		const reopened = await V3SessionManager.open(sessionFiles[0]!, features);
		managers.push(reopened);
		expect(reopened.isClosed()).toBe(false);
	});
});
