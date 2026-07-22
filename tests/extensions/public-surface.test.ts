import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	NodePolicyExtensionStorage,
	ProductionExtensionRuntime,
	getExtensionSpillDir,
	getExtensionsStatePath,
	getPluginDataDir,
	getProjectExtensionRoot,
	getTrustStorePath,
	getUserExtensionRoot,
	getUserSettingsPath,
	loadMergedSettings,
	loadProjectSettings,
	loadUserSettings,
	mergeUserAndProjectSettings,
	saveProjectSettings,
	saveUserSettings,
} from "../../src/extensions/index.ts";

interface PackageManifest {
	exports: Record<string, { import: string; types: string } | string>;
}

describe("Extension public surface", () => {
	it("publishes the stable package subpath", () => {
		const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as PackageManifest;
		expect(manifest.exports["./extensions"]).toEqual({
			import: "./dist/extensions/index.js",
			types: "./dist/extensions/index.d.ts",
		});
	});

	it("exports the production adapter and composition settings/path contracts", () => {
		expect(NodePolicyExtensionStorage).toBeTypeOf("function");
		expect(ProductionExtensionRuntime).toBeTypeOf("function");
		for (const api of [
			getExtensionSpillDir,
			getExtensionsStatePath,
			getPluginDataDir,
			getProjectExtensionRoot,
			getTrustStorePath,
			getUserExtensionRoot,
			getUserSettingsPath,
			loadMergedSettings,
			loadProjectSettings,
			loadUserSettings,
			mergeUserAndProjectSettings,
			saveProjectSettings,
			saveUserSettings,
		]) expect(api).toBeTypeOf("function");
	});
});
