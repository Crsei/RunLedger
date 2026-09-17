import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { ExtensionDistributionRegistry, resolveExtensionDistributionPaths } from "../../src/extensions/plugins/marketplace/registry.ts";
import {
	applyPluginFeatureSelection,
	describePluginFeatures,
	parseFeatureSelection,
	readDeclaredFeatures,
} from "../../src/extensions/plugins/features.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const capabilities = { events: [], tools: [], filesystem: "none", process: false, network: false };

function manifestWithFeatures(features: unknown): Record<string, unknown> {
	return {
		name: "alpha",
		version: "1.0.0",
		capabilities,
		extensions: [],
		commands: [],
		skills: [],
		hooks: [],
		features,
	};
}

async function registryFixture(): Promise<{ readonly home: string; readonly registryPath: string; readonly storage: NodeExtensionDistributionStorage; readonly registry: ExtensionDistributionRegistry }> {
	const base = await mkdtemp(join(tmpdir(), "runledger-plugin-features-"));
	roots.push(base);
	const home = join(base, "home");
	await mkdir(home, { recursive: true });
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	const registry = new ExtensionDistributionRegistry({
		storage,
		paths: resolveExtensionDistributionPaths({ stateRoot: join(home, "state", "extensions"), pluginsRoot: join(home, "plugins") }),
	});
	return { home, registryPath: join(home, "plugins", "registry.json"), storage, registry };
}

const declared = [
	{ name: "bundle", default: true, description: "bundled commands" },
	{ name: "audit", default: false },
];

describe("plugin feature declarations", () => {
	it("reads valid declarations and reports duplicates instead of silently merging them", () => {
		const read = readDeclaredFeatures({ features: [...declared, { name: "bundle", default: false }, { name: "Bad Name" }, 7] });
		expect(read.declarations.map((feature) => feature.name)).toEqual(["bundle", "audit"]);
		expect(read.invalid).toEqual(["features[2] duplicates bundle", "features[3]", "features[4]"]);
	});

	it("treats a missing or non-array features key as no declaration", () => {
		expect(readDeclaredFeatures({})).toEqual({ declarations: [], invalid: [] });
		expect(readDeclaredFeatures({ features: "bundle" })).toEqual({ declarations: [], invalid: [] });
		expect(readDeclaredFeatures(null)).toEqual({ declarations: [], invalid: [] });
	});

	it("resolves the three selection modes against the declared set", () => {
		const defaults = describePluginFeatures({ packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: null });
		expect(defaults.enabled).toEqual(["bundle"]);
		expect(defaults.unknown).toEqual([]);

		const allOff = describePluginFeatures({ packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: [] });
		expect(allOff.enabled).toEqual([]);

		const exact = describePluginFeatures({ packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: ["audit"] });
		expect(exact.enabled).toEqual(["audit"]);

		const undeclared = describePluginFeatures({ packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: ["audit", "ghost"] });
		expect(undeclared.enabled).toEqual(["audit"]);
		expect(undeclared.unknown).toEqual(["ghost"]);
	});

	it("parses the CLI selection vocabulary with * and none reserved", () => {
		expect(parseFeatureSelection("*")).toEqual({ ok: true, selection: null });
		expect(parseFeatureSelection("none")).toEqual({ ok: true, selection: [] });
		expect(parseFeatureSelection("b,a,b")).toEqual({ ok: true, selection: ["a", "b"] });
		expect(parseFeatureSelection(" ").ok).toBe(false);
		expect(parseFeatureSelection("A").ok).toBe(false);
	});
});

describe("plugin feature selection persistence", () => {
	async function seed(): Promise<{ readonly storage: NodeExtensionDistributionStorage; readonly registry: ExtensionDistributionRegistry }> {
		const env = await registryFixture();
		await env.registry.saveRunledgerRegistry({
			version: 1,
			plugins: {
				"alpha@local": {
					name: "alpha",
					version: "1.0.0",
					digest: "a".repeat(64),
					scope: "user",
					enabled: false,
					enabledFeatures: null,
					installedAt: "2026-09-17T00:00:00.000Z",
					lastUpdated: "2026-09-17T00:00:00.000Z",
				},
			},
			settings: {},
		});
		return env;
	}

	it("writes only enabledFeatures and preserves enable/trust-adjacent state", async () => {
		const env = await seed();
		const manifest = manifestWithFeatures(declared);
		const applied = await applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest, selection: ["audit"] });
		expect(applied.ok).toBe(true);
		if (applied.ok) {
			expect(applied.value.enabled).toEqual(["audit"]);
			expect(applied.value.selection).toEqual(["audit"]);
		}
		const reloaded = await env.registry.loadRunledgerRegistry();
		expect(reloaded.ok).toBe(true);
		if (!reloaded.ok) return;
		const record = reloaded.document.plugins["alpha@local"];
		expect(record?.enabledFeatures).toEqual(["audit"]);
		// 切换 feature 不改变 enable 位：安装 ≠ 启用 ≠ 信任 ≠ feature 选择。
		expect(record?.enabled).toBe(false);
		expect(record?.digest).toBe("a".repeat(64));
	});

	it("round-trips the default and all-off selections as distinct values", async () => {
		const env = await seed();
		const manifest = manifestWithFeatures(declared);
		await applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest, selection: [] });
		let reloaded = await env.registry.loadRunledgerRegistry();
		if (!reloaded.ok) throw new Error(reloaded.message);
		expect(reloaded.document.plugins["alpha@local"]?.enabledFeatures).toEqual([]);

		await applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest, selection: null });
		reloaded = await env.registry.loadRunledgerRegistry();
		if (!reloaded.ok) throw new Error(reloaded.message);
		expect(reloaded.document.plugins["alpha@local"]?.enabledFeatures).toBeNull();
	});

	it("fails closed on undeclared features, undeclared plugins and packages without features", async () => {
		const env = await seed();
		const unknown = await applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: ["ghost"] });
		expect(unknown).toMatchObject({ ok: false, code: "feature_unknown" });

		const missing = await applyPluginFeatureSelection({ registry: env.registry, packageId: "beta@local", manifest: manifestWithFeatures(declared), selection: null });
		expect(missing).toMatchObject({ ok: false, code: "plugin_not_installed" });

		const none = await applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest: manifestWithFeatures([]), selection: [] });
		expect(none).toMatchObject({ ok: false, code: "no_declared_features" });

		// 失败的写入不落盘：账本保持原值。
		const reloaded = await env.registry.loadRunledgerRegistry();
		if (!reloaded.ok) throw new Error(reloaded.message);
		expect(reloaded.document.plugins["alpha@local"]?.enabledFeatures).toBeNull();
	});

	it("fails closed on a corrupt registry instead of resetting it", async () => {
		const env = await registryFixture();
		await mkdir(join(env.home, "plugins"), { recursive: true });
		await writeFile(env.registryPath, "{ not json", "utf8");
		await expect(applyPluginFeatureSelection({ registry: env.registry, packageId: "alpha@local", manifest: manifestWithFeatures(declared), selection: null }))
			.resolves.toMatchObject({ ok: false, code: "invalid" });
		expect(await readFile(env.registryPath, "utf8")).toBe("{ not json");
	});
});
