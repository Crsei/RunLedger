/**
 * 分发安装的声明式插件，其 Skill 贡献在 **enable 之后**应当可见并可激活。
 *
 * 这个文件来自一次真实 TTY 复测的发现：`plugin trust` + `plugin enable` 返回成功、
 * `plugin list` 也显示 `activation:"ready"`，但随后 `skill list` 里找不到该插件贡献
 * 的 skill。这里把两段（同一组合内 / 跨组合重建）分开断言，以便定位是哪一段丢的。
 */

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

const principalId = createRuntimeId("principal", "skill-lifecycle-test");

async function environment() {
	const base = await mkdtemp(join(tmpdir(), "runledger-skill-life-"));
	roots.push(base);
	const home = join(base, "home");
	const source = join(base, "source");
	const stateRoot = join(home, "state", "extensions");
	await mkdir(join(source, ".runledger-plugin"), { recursive: true });
	await mkdir(join(source, "skills", "review"), { recursive: true });
	await writeFile(join(source, "package.json"), JSON.stringify({
		name: "alpha",
		version: "1.0.0",
		runledger: {
			name: "alpha", version: "1.0.0", description: "alpha with a skill",
			capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false },
			extensions: [], commands: [], skills: ["./skills/review"], hooks: [],
		},
	}), "utf8");
	await writeFile(join(source, ".runledger-plugin", "plugin.json"), JSON.stringify({
		name: "alpha", version: "1.0.0", description: "alpha with a skill", skills: ["./skills/review"],
	}), "utf8");
	await writeFile(join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: review things\n---\nbody\n", "utf8");

	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
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
	const install = await installer.install({
		packageId: "alpha@local",
		name: "alpha",
		source: { kind: "local", path: source, locator: "plugins/alpha" },
		scope: "user",
	});
	if (!install.ok) throw new Error(`fixture install failed: ${install.code} ${install.message}`);
	return { home, stateRoot, storage, registry, installer, install };
}

/** 构造一次「会话组合」：新的 storage/trust/state/manager，读同一批文件。 */
async function session(env: Awaited<ReturnType<typeof environment>>) {
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: env.home });
	const bridged = await distributionPluginRoots({ registry: env.registry, storageKey: "ws-1" });
	if (!bridged.ok) throw new Error(`discovery bridge failed: ${bridged.message}`);
	const manager = new PluginManager({
		storage,
		trustStore: new TrustStore(join(env.stateRoot, "trust.json"), storage),
		stateStore: new ExtensionStateStore(join(env.stateRoot, "extensions-state.json"), storage),
		scope: { authorityId: createRuntimeId("authority", "a"), tenantId: createRuntimeId("tenant", "t"), principalId },
		roots: bridged.roots,
	});
	return { manager };
}

describe("distribution plugin skill contribution lifecycle", () => {
	it("publishes the skill contribution once the plugin is trusted and enabled", async () => {
		const env = await environment();
		const first = await session(env);
		const discovered = await first.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		expect(id).toBeDefined();
		if (id === undefined) return;
		expect(discovered.skillContributions).toEqual([]);

		await first.manager.trust(id);
		const trusted = first.manager.last();
		expect(trusted?.plugins[0]?.trust.state).toBe("trusted");
		expect(trusted?.skillContributions).toEqual([]);

		await first.manager.setEnabled(id, true);
		const enabled = first.manager.last();
		expect(enabled?.plugins[0]?.descriptor.enabled).toBe(true);
		expect(enabled?.plugins[0]?.descriptor.ready).toBe(true);
		// 同一组合内：这一处在本轮 TTY 复测里是通过的。
		expect(enabled?.skillContributions).toHaveLength(1);
	});

	it("keeps the contribution after the composition is rebuilt (new session)", async () => {
		const env = await environment();
		const first = await session(env);
		const discovered = await first.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		if (id === undefined) throw new Error("plugin must be discovered");
		await first.manager.trust(id);
		await first.manager.setEnabled(id, true);

		// 新组合：这正是 TTY 复测里 `runledger skill list` 走的那条路径。
		const second = await session(env);
		const rebuilt = await second.manager.discover({ publish: true });
		const plugin = rebuilt.plugins[0];
		expect(plugin?.descriptor.enabled).toBe(true);
		expect(plugin?.trust.state).toBe("trusted");
		expect(rebuilt.skillContributions).toHaveLength(1);
	});
});
