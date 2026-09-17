import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { findMarketplacePlugin, loadMarketplaceCatalog, resolveCatalogVersion, resolveMarketplacePluginSource } from "../../src/extensions/plugins/marketplace/catalog.ts";
import { applySettingDefaults, parseExtensionSettingValue, resolvePluginSettings, validatePluginSettings } from "../../src/extensions/plugins/settings-schema.ts";
import type { ExtensionSettingDescriptor } from "../../src/contracts/extensions/manifest.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function catalogFixture(files: Record<string, unknown>): Promise<{ readonly root: string; readonly storage: NodeExtensionDistributionStorage }> {
	const base = await mkdtemp(join(tmpdir(), "runledger-mkt-"));
	roots.push(base);
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: base });
	for (const [relative, document] of Object.entries(files)) {
		await mkdir(join(base, relative, ".."), { recursive: true });
		await writeFile(join(base, relative), JSON.stringify(document), "utf8");
	}
	return { root: base, storage };
}

const catalog = { name: "local", owner: { name: "owner" }, plugins: [{ name: "alpha", source: "./plugins/alpha", version: "2.0.0" }] };

describe("marketplace catalog", () => {
	it("prefers the RunLedger path and falls back to the Claude path", async () => {
		const runledger = await catalogFixture({ ".runledger-plugin/marketplace.json": catalog, ".claude-plugin/marketplace.json": { ...catalog, name: "claude" } });
		expect((await loadMarketplaceCatalog(runledger.storage, runledger.root)).ok && (await loadMarketplaceCatalog(runledger.storage, runledger.root))).toMatchObject({ catalogPath: `${runledger.root}/.runledger-plugin/marketplace.json` });

		const claudeOnly = await catalogFixture({ ".claude-plugin/marketplace.json": catalog });
		const loaded = await loadMarketplaceCatalog(claudeOnly.storage, claudeOnly.root);
		expect(loaded.ok).toBe(true);
		if (loaded.ok) expect(loaded.catalogPath.endsWith(".claude-plugin/marketplace.json")).toBe(true);
	});

	it("fails closed on a malformed catalog instead of skipping to the next candidate", async () => {
		const env = await catalogFixture({ ".runledger-plugin/marketplace.json": { name: "broken" }, ".claude-plugin/marketplace.json": catalog });
		const loaded = await loadMarketplaceCatalog(env.storage, env.root);
		expect(loaded.ok).toBe(false);
		if (!loaded.ok) expect(loaded.code).toBe("invalid");
	});

	it("reports a missing catalog explicitly", async () => {
		const env = await catalogFixture({});
		expect(await loadMarketplaceCatalog(env.storage, env.root)).toMatchObject({ ok: false, code: "missing" });
	});

	it("resolves entry sources through the pluginRoot prefix and containment", () => {
		const env = { name: "local", owner: { name: "o" }, metadata: { pluginRoot: "./plugins" }, plugins: [{ name: "alpha", source: "./alpha" }] };
		const resolved = resolveMarketplacePluginSource(env, env.plugins[0]!, "/mkt");
		expect(resolved.ok).toBe(true);
		if (resolved.ok && resolved.source.kind === "local") expect(resolved.source.path).toBe("/mkt/plugins/alpha");

		const escaping = resolveMarketplacePluginSource({ ...env, metadata: { pluginRoot: "./../../etc" } }, { name: "alpha", source: "./alpha" }, "/mkt");
		expect(escaping.ok).toBe(false);
	});

	it("looks up entries and resolves the catalog version first", () => {
		expect(findMarketplacePlugin(catalog, "alpha")?.version).toBe("2.0.0");
		expect(findMarketplacePlugin(catalog, "ghost")).toBeUndefined();
		expect(resolveCatalogVersion({ name: "alpha", source: "./x", version: "2.0.0" }, "1.0.0")).toBe("2.0.0");
		expect(resolveCatalogVersion({ name: "alpha", source: "./x" }, "1.0.0")).toBe("1.0.0");
		expect(resolveCatalogVersion({ name: "alpha", source: "./x" }, undefined)).toBe("0.0.0");
	});
});

describe("plugin settings schema", () => {
	const declared: Record<string, ExtensionSettingDescriptor> = {
		theme: { type: "string", description: "theme name" },
		retries: { type: "number", description: "retry count", default: 2 },
		strict: { type: "boolean", description: "strict mode", default: false },
		mode: { type: "enum", description: "mode", values: ["fast", "safe"], default: "safe" },
		token: { type: "string", description: "api token", secret: true },
	};

	it("parses each declared type and rejects mismatches", () => {
		expect(parseExtensionSettingValue(declared.theme!, "dark")).toEqual({ ok: true, value: "dark" });
		expect(parseExtensionSettingValue(declared.retries!, "3")).toEqual({ ok: true, value: 3 });
		expect(parseExtensionSettingValue(declared.strict!, "true")).toEqual({ ok: true, value: true });
		expect(parseExtensionSettingValue(declared.mode!, "fast")).toEqual({ ok: true, value: "fast" });
		expect(parseExtensionSettingValue(declared.mode!, "warp")).toMatchObject({ ok: false, code: "invalid_enum" });
		expect(parseExtensionSettingValue(declared.retries!, "abc")).toMatchObject({ ok: false, code: "invalid_type" });
		expect(parseExtensionSettingValue(declared.retries!, "1e12")).toMatchObject({ ok: false, code: "invalid_bounds" });
		expect(parseExtensionSettingValue(declared.theme!, "x".repeat(5_000))).toMatchObject({ ok: false, code: "invalid_bounds" });
	});

	it("applies user then workspace values and reports narrowing", () => {
		const resolved = resolvePluginSettings(declared, [
			{ scope: "user", values: { theme: "dark", strict: true, mode: "fast" } },
			{ scope: "workspace", values: { strict: false } },
		]);
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.values).toEqual({ theme: "dark", strict: false, mode: "fast" });
		expect(resolved.narrowed).toEqual(["strict"]);
	});

	it("keeps secret settings user-only and rejects undeclared keys", () => {
		expect(resolvePluginSettings(declared, [{ scope: "workspace", values: { token: "x" } }])).toMatchObject({ ok: false, code: "secret_scope_denied", key: "token" });
		expect(resolvePluginSettings(declared, [{ scope: "user", values: { ghost: 1 } }])).toMatchObject({ ok: false, code: "unknown_setting", key: "ghost" });
	});

	it("fills defaults and validates a config payload", () => {
		expect(applySettingDefaults(declared, { theme: "dark" })).toEqual({ theme: "dark", retries: 2, strict: false, mode: "safe" });
		expect(validatePluginSettings(declared, { mode: "fast", strict: "false" })).toEqual({ ok: true, accepted: ["mode", "strict"] });
		expect(validatePluginSettings(declared, { mode: "warp" })).toMatchObject({ ok: false, code: "invalid_enum", key: "mode" });
	});
});
