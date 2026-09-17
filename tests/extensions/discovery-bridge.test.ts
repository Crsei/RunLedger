import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { ExtensionInstaller } from "../../src/extensions/plugins/installer.ts";
import type { ExtensionSourceMaterializer } from "../../src/extensions/plugins/installer.ts";
import { ExtensionDistributionRegistry, resolveExtensionDistributionPaths } from "../../src/extensions/plugins/marketplace/registry.ts";
import { distributionPluginRoots } from "../../src/extensions/plugins/discovery-bridge.ts";
import { PluginManager } from "../../src/extensions/plugins/manager.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function environment() {
	const base = await mkdtemp(join(tmpdir(), "runledger-bridge-"));
	roots.push(base);
	const home = join(base, "home");
	const source = join(base, "source");
	await mkdir(home, { recursive: true });
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	const stateRoot = join(home, "state", "extensions");
	const registry = new ExtensionDistributionRegistry({
		storage,
		paths: resolveExtensionDistributionPaths({ stateRoot, pluginsRoot: join(stateRoot, "plugins") }),
	});
	const materializer: ExtensionSourceMaterializer = { materialize: async () => ({ ok: false, code: "network_denied", message: "no network" }) };
	const installer = new ExtensionInstaller({
		storage, registry, materializer,
		pluginsRoot: join(stateRoot, "plugins"),
		scopeRoot: (scope) => scope === "user" ? join(stateRoot, "plugins", "user") : join(stateRoot, "plugins", "workspaces", "ws-1"),
	});
	/**
	 * 一个**纯声明式**分发包：`package.json#runledger` 是分发的权威 manifest
	 * （D12，声明 capability 与版本，不含 `extensions[]`），
	 * `.runledger-plugin/plugin.json` 是既有 PluginManager 的发现容器。
	 */
	await mkdir(join(source, ".runledger-plugin"), { recursive: true });
	await mkdir(join(source, "skills", "review"), { recursive: true });
	await writeFile(join(source, "package.json"), JSON.stringify({
		name: "declarative-plugin",
		version: "1.0.0",
		runledger: {
			name: "declarative-plugin",
			version: "1.0.0",
			description: "declarative only",
			capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false },
			extensions: [],
			commands: [],
			skills: ["./skills/review"],
			hooks: [],
		},
	}), "utf8");
	await writeFile(join(source, ".runledger-plugin", "plugin.json"), JSON.stringify({
		name: "declarative-plugin",
		version: "1.0.0",
		description: "declarative only",
		skills: ["./skills/review"],
	}), "utf8");
	await writeFile(join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: review things\n---\nbody\n", "utf8");
	return { base, home, stateRoot, source, storage, registry, installer };
}

describe("distribution discovery bridge", () => {
	it("projects the recorded installed version into a declarative discovery root", async () => {
		const env = await environment();
		const installed = await env.installer.install({
			packageId: "declarative-plugin@local",
			name: "declarative-plugin",
			source: { kind: "local", path: env.source, locator: "plugins/declarative-plugin" },
			scope: "user",
		});
		expect(installed.ok).toBe(true);
		if (!installed.ok) return;

		const bridged = await distributionPluginRoots({ registry: env.registry, storageKey: "ws-1" });
		expect(bridged.ok).toBe(true);
		if (!bridged.ok) return;
		expect(bridged.skipped).toEqual([]);
		expect(bridged.roots).toHaveLength(1);
		expect(bridged.roots[0]).toMatchObject({ source: "user", rootPath: installed.receipt.installPath, layout: "plugin-root" });
	});

	it("makes an installed declarative package visible to the existing PluginManager", async () => {
		const env = await environment();
		const installed = await env.installer.install({
			packageId: "declarative-plugin@local",
			name: "declarative-plugin",
			source: { kind: "local", path: env.source, locator: "plugins/declarative-plugin" },
			scope: "user",
		});
		expect(installed.ok).toBe(true);
		const bridged = await distributionPluginRoots({ registry: env.registry, storageKey: "ws-1" });
		expect(bridged.ok).toBe(true);
		if (!bridged.ok) return;

		const principalId = createRuntimeId("principal", "bridge-test");
		const manager = new PluginManager({
			storage: env.storage,
			trustStore: new TrustStore(join(env.stateRoot, "trust.json"), env.storage),
			stateStore: new ExtensionStateStore(join(env.stateRoot, "extensions-state.json"), env.storage),
			scope: { authorityId: createRuntimeId("authority", "a"), tenantId: createRuntimeId("tenant", "t"), principalId },
			roots: bridged.roots,
		});
		const discovery = await manager.discover({ publish: false });
		expect(discovery.plugins).toHaveLength(1);
		const plugin = discovery.plugins[0];
		expect(plugin?.manifest.name).toBe("declarative-plugin");
		// 安装不授予启用/信任：发现到了，但仍是 disabled + untrusted。
		expect(plugin?.descriptor.enabled).toBe(false);
		expect(plugin?.descriptor.trusted).toBe(false);
		expect(plugin?.descriptor.activation).toBe("disabled");
		expect(discovery.skillContributions).toEqual([]);
	});

	it("skips a record whose installed entry is missing instead of inventing a path", async () => {
		const env = await environment();
		const installed = await env.installer.install({
			packageId: "declarative-plugin@local",
			name: "declarative-plugin",
			source: { kind: "local", path: env.source, locator: "plugins/declarative-plugin" },
			scope: "user",
		});
		expect(installed.ok).toBe(true);
		// 擦掉 installed_plugins.json，模拟账本不一致。
		await writeFile(join(env.stateRoot, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }), "utf8");
		const bridged = await distributionPluginRoots({ registry: env.registry, storageKey: "ws-1" });
		expect(bridged.ok).toBe(true);
		if (!bridged.ok) return;
		expect(bridged.roots).toEqual([]);
		expect(bridged.skipped).toEqual([{ packageId: "declarative-plugin@local", reason: "installed_plugins.json has no entry for the recorded version" }]);
	});

	it("reports an unreadable registry as invalid rather than as an empty success", async () => {
		const env = await environment();
		await mkdir(join(env.stateRoot, "plugins"), { recursive: true });
		await writeFile(join(env.stateRoot, "plugins", "registry.json"), "{ broken", "utf8");
		await expect(distributionPluginRoots({ registry: env.registry, storageKey: "ws-1" })).resolves.toMatchObject({ ok: false, code: "registry_invalid" });
	});
});
