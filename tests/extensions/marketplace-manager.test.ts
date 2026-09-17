import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { ExtensionInstaller } from "../../src/extensions/plugins/installer.ts";
import type { ExtensionSourceMaterializer } from "../../src/extensions/plugins/installer.ts";
import { ExtensionDistributionRegistry, resolveExtensionDistributionPaths } from "../../src/extensions/plugins/marketplace/registry.ts";
import { MarketplaceFetcher } from "../../src/extensions/plugins/marketplace/fetcher.ts";
import { MarketplaceManager, compareVersions, resolveAutoUpdateMode } from "../../src/extensions/plugins/marketplace/manager.ts";
import { cacheSegment } from "../../src/extensions/plugins/marketplace/cache.ts";
import { runExtensionDoctor } from "../../src/extensions/plugins/doctor.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const runledgerManifest = (version: string) => ({ name: "alpha", version, description: "alpha plugin", capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false }, extensions: ["./src/index.ts"], commands: [], skills: [], hooks: [] });

async function environment() {
	const base = await mkdtemp(join(tmpdir(), "runledger-mkt-mgr-"));
	roots.push(base);
	const home = join(base, "home");
	const marketplaceRoot = join(base, "marketplace");
	const pluginSource = join(marketplaceRoot, "plugins", "alpha");
	await mkdir(join(pluginSource, "src"), { recursive: true });
	await writeFile(join(pluginSource, "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0", runledger: runledgerManifest("1.0.0") }), "utf8");
	await writeFile(join(pluginSource, "src", "index.ts"), "export default () => undefined;\n", "utf8");
	await mkdir(join(marketplaceRoot, ".runledger-plugin"), { recursive: true });
	const catalog = { name: "local", owner: { name: "owner" }, plugins: [{ name: "alpha", source: "./plugins/alpha", version: "1.0.0" }] };
	await writeFile(join(marketplaceRoot, ".runledger-plugin", "marketplace.json"), JSON.stringify(catalog), "utf8");

	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	const registry = new ExtensionDistributionRegistry({ storage, paths: resolveExtensionDistributionPaths({ stateRoot: join(home, "state"), pluginsRoot: join(home, "plugins") }) });
	const materializer: ExtensionSourceMaterializer = { materialize: async () => ({ ok: false, code: "network_denied", message: "no network in tests" }) };
	const installer = new ExtensionInstaller({
		storage, registry, materializer,
		pluginsRoot: join(home, "plugins"),
		scopeRoot: (scope) => scope === "user" ? join(home, "plugins", "user") : join(home, "plugins", "workspaces", "ws-1"),
	});
	const fetcher = new MarketplaceFetcher({ storage, cache: { marketplacesRoot: join(home, "plugins", "cache", "marketplaces"), pluginsRoot: join(home, "plugins", "cache", "plugins") }, materializer });
	const manager = new MarketplaceManager({ registry, fetcher, installer, scope: () => "user" });
	return { base, home, marketplaceRoot, pluginSource, catalog, storage, registry, installer, fetcher, manager };
}

describe("marketplace manager", () => {
	it("registers a local marketplace, installs from it, and lists the result", async () => {
		const env = await environment();
		const added = await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		expect(added.ok).toBe(true);
		expect(await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot })).toMatchObject({ ok: false, code: "marketplace_exists" });

		const installed = await env.manager.installPlugin({ spec: "alpha@local" });
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		expect(installed.value.receipt.version).toBe("1.0.0");
		expect(installed.value.receipt.marketplace).toBe("local");

		const list = await env.manager.listInstalled();
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		expect(list.value).toHaveLength(1);
		expect(list.value[0]).toMatchObject({ packageId: "alpha@local", version: "1.0.0", scope: "user", enabled: false, shadowed: false });
	});

	it("reports no provider for an unknown plugin and refuses an unknown spec", async () => {
		const env = await environment();
		await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		expect(await env.manager.installPlugin({ spec: "ghost@local" })).toMatchObject({ ok: false, code: "plugin_not_found" });
		expect(await env.manager.installPlugin({ spec: "NotAName" })).toMatchObject({ ok: false, code: "plugin_not_found" });
		expect(await env.manager.installPlugin({ spec: "alpha@ghost" })).toMatchObject({ ok: false, code: "marketplace_missing" });
	});

	it("detects pending updates from a bumped catalog version without installing them", async () => {
		const env = await environment();
		await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		await env.manager.installPlugin({ spec: "alpha@local" });
		expect(await env.manager.pendingUpdates()).toMatchObject({ ok: true, value: [] });

		await writeFile(join(env.marketplaceRoot, ".runledger-plugin", "marketplace.json"), JSON.stringify({ ...env.catalog, plugins: [{ name: "alpha", source: "./plugins/alpha", version: "2.0.0" }] }), "utf8");
		const pending = await env.manager.pendingUpdates();
		expect(pending.ok).toBe(true);
		if (!pending.ok) return;
		expect(pending.value).toEqual([{ packageId: "alpha@local", name: "alpha", installedVersion: "1.0.0", availableVersion: "2.0.0", marketplace: "local" }]);

		// notify 没有可见出口时降级为 off，而不是“配置项说谎”。
		expect(resolveAutoUpdateMode({ configured: "notify", hasVisibleChannel: false, pendingUpdates: 1 })).toMatchObject({ effective: "off", degraded: true });
		expect(resolveAutoUpdateMode({ configured: "notify", hasVisibleChannel: true, pendingUpdates: 1 })).toMatchObject({ effective: "notify", degraded: false });
		// auto 只刷新 catalog，不代替用户安装/启用。
		const plan = await env.manager.autoUpdatePlan("auto", { hasVisibleChannel: true });
		expect(plan.effective).toBe("auto");
		expect(plan.updates).toHaveLength(1);
		const list = await env.manager.listInstalled();
		if (list.ok) expect(list.value[0]?.version).toBe("1.0.0");
	});

	it("removes a marketplace but keeps already installed plugins", async () => {
		const env = await environment();
		await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		await env.manager.installPlugin({ spec: "alpha@local" });
		const removed = await env.manager.removeMarketplace("local");
		expect(removed).toEqual({ ok: true, value: { removed: "local", installedOnMarketplace: 1 } });
		const list = await env.manager.listInstalled();
		if (list.ok) expect(list.value).toHaveLength(1);
		expect(await env.manager.removeMarketplace("local")).toMatchObject({ ok: false, code: "marketplace_missing" });
	});

	it("requires a network-capable materializer for a git marketplace", async () => {
		const env = await environment();
		const added = await env.manager.addMarketplace({ name: "remote", sourceType: "github", sourceUri: "https://github.com/owner/repo.git" });
		expect(added).toMatchObject({ ok: false, code: "marketplace_invalid" });
	});

	it("compares versions including prereleases", () => {
		expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
		expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
		expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
		expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
	});

	it("makes cache segments collision-safe", () => {
		expect(cacheSegment("Alpha")).not.toBe(cacheSegment("alpha"));
		expect(cacheSegment("a/b")).not.toBe(cacheSegment("a-b"));
		expect(cacheSegment("")).toMatch(/^item-/u);
	});
});

describe("plugin doctor", () => {
	it("reports a consistent install as ok and a missing trust receipt as a warning", async () => {
		const env = await environment();
		await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		await env.manager.installPlugin({ spec: "alpha@local" });
		const report = await runExtensionDoctor({
			storage: env.storage,
			registry: env.registry,
			trustDigest: () => undefined,
			scopeRoot: (scope) => scope === "user" ? join(env.home, "plugins", "user") : join(env.home, "plugins", "workspaces", "ws-1"),
		});
		expect(report.counts.error).toBe(0);
		expect(report.findings.map((finding) => finding.code)).toContain("trust.missing");
		expect(report.findings.map((finding) => finding.code)).toContain("registry.readable");
		expect(report.findings.map((finding) => finding.code)).toContain("doctor.completed");
	});

	it("detects a digest mismatch and an orphan package directory", async () => {
		const env = await environment();
		await env.manager.addMarketplace({ name: "local", sourceType: "local", sourceUri: env.marketplaceRoot });
		const installed = await env.manager.installPlugin({ spec: "alpha@local" });
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;
		// 篡改已安装内容：manifest 仍然合法，但内容 digest 不再匹配。
		await writeFile(join(installed.value.receipt.installPath, "src", "index.ts"), "export default () => 'tampered';\n", "utf8");
		// 制造一个账本外的孤立版本目录。
		await mkdir(join(env.home, "plugins", "user", "packages", "orphan@local", "9.9.9"), { recursive: true });
		const report = await runExtensionDoctor({
			storage: env.storage,
			registry: env.registry,
			trustDigest: (packageId) => packageId === "alpha@local" ? "0".repeat(64) : undefined,
			scopeRoot: (scope) => scope === "user" ? join(env.home, "plugins", "user") : join(env.home, "plugins", "workspaces", "ws-1"),
		});
		const codes = report.findings.map((finding) => finding.code);
		expect(codes).toContain("install.digest_mismatch");
		expect(codes).toContain("install.orphan_directory");
		expect(codes).toContain("trust.stale");
		expect(report.counts.error).toBeGreaterThan(0);
	});
});
