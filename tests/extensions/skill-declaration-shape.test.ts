/**
 * 分发包的 `skills` 声明形状：**声明的是 skills root，不是 skill 目录本身**。
 *
 * 本文件来自一次真实 TTY 复测的缺口定位。`skills-directory` 的扫描语义是
 * 「枚举声明路径的 immediate-child 目录，每个子目录是一个 skill root」；因此
 * `skills: ["./skills/review"]`（指向含 SKILL.md 的目录本身）会得到 **0 个 skill**，
 * 而 `skills: ["./skills"]` 才产出 `review`。
 *
 * 同时固定两个视图的分工：`skill.list` 读的是**声明式 descriptor**，
 * PluginManager 在 plugin trusted+enabled 之后改推 **skillContribution**，
 * 因此 descriptor 视图里会少一条、真正的 skill 只出现在 SkillRegistry catalog 里。
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
import { createSkillRegistry } from "../../src/extensions/skills/registry.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const principalId = createRuntimeId("principal", "skill-shape-test");

async function environment(skillsDeclaration: string) {
	const base = await mkdtemp(join(tmpdir(), "runledger-skill-shape-"));
	roots.push(base);
	const home = join(base, "home");
	const source = join(base, "source");
	const stateRoot = join(home, "state", "extensions");
	await mkdir(join(source, ".runledger-plugin"), { recursive: true });
	await mkdir(join(source, "skills", "review"), { recursive: true });
	const declaration = [skillsDeclaration];
	await writeFile(join(source, "package.json"), JSON.stringify({
		name: "alpha",
		version: "1.0.0",
		runledger: {
			name: "alpha", version: "1.0.0", description: "alpha with a skill",
			capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false },
			extensions: [], commands: [], skills: declaration, hooks: [],
		},
	}), "utf8");
	await writeFile(join(source, ".runledger-plugin", "plugin.json"), JSON.stringify({
		name: "alpha", version: "1.0.0", description: "alpha with a skill", skills: declaration,
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

	const bridged = await distributionPluginRoots({ registry, storageKey: "ws-1" });
	if (!bridged.ok) throw new Error(`discovery bridge failed: ${bridged.message}`);
	const trustStore = new TrustStore(join(stateRoot, "trust.json"), storage);
	const stateStore = new ExtensionStateStore(join(stateRoot, "extensions-state.json"), storage);
	const manager = new PluginManager({
		storage,
		trustStore,
		stateStore,
		scope: { authorityId: createRuntimeId("authority", "a"), tenantId: createRuntimeId("tenant", "t"), principalId },
		roots: bridged.roots,
	});
	const skills = createSkillRegistry({
		storage,
		trustStore,
		stateStore,
		scope: { authorityId: createRuntimeId("authority", "a"), tenantId: createRuntimeId("tenant", "t"), principalId },
		pluginContributions: () => manager.last()?.skillContributions ?? [],
		userSkillRoot: join(stateRoot, "user", "skills"),
		workspaceSkillRoot: join(stateRoot, "workspaces", "ws-1", "skills"),
	});
	return { manager, skills, stateRoot };
}

describe("distribution plugin skills declaration shape", () => {
	it("produces a skill when the declaration points at a skills root", async () => {
		const env = await environment("./skills");
		const discovered = await env.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		if (id === undefined) throw new Error("plugin must be discovered");
		// enable 之前：只有声明式 descriptor，且是 blocked。
		expect(discovered.descriptors.filter((descriptor) => descriptor.kind === "skill")).toHaveLength(1);
		expect(discovered.skillContributions).toEqual([]);

		await env.manager.trust(id);
		await env.manager.setEnabled(id, true);
		expect(env.manager.last()?.skillContributions).toHaveLength(1);
		// 启用后 descriptor 视图不再有这条 skill：它转成了 contribution。
		expect(env.manager.last()?.descriptors.filter((descriptor) => descriptor.kind === "skill")).toEqual([]);

		const snapshot = await env.skills.load();
		const mine = snapshot.all.filter((skill) => skill.descriptor.pluginId?.includes("distribution"));
		expect(mine).toHaveLength(1);
		expect(mine[0]?.descriptor.displayName).toBe("review");
		// trusted+enabled 的插件贡献应当是可激活/可被模型发现的。
		expect(mine[0]?.descriptor.activation).toBe("ready");
		expect(snapshot.modelDiscoverable.some((skill) => skill.descriptor.pluginId?.includes("distribution"))).toBe(true);
	});

	it("produces no skill when the declaration points at the skill directory itself", async () => {
		const env = await environment("./skills/review");
		const discovered = await env.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		if (id === undefined) throw new Error("plugin must be discovered");
		await env.manager.trust(id);
		await env.manager.setEnabled(id, true);
		// 声明形状错了：贡献存在（plugin 侧不知道扫描语义），但 registry 扫不到任何 skill。
		expect(env.manager.last()?.skillContributions).toHaveLength(1);
		const snapshot = await env.skills.load();
		expect(snapshot.all.filter((skill) => skill.descriptor.pluginId?.includes("distribution"))).toEqual([]);
	});
});

describe("skills root declaration diagnostics", () => {
	it("warns explicitly when a declared root yields no skill directory", async () => {
		const env = await environment("./skills/review");
		const discovered = await env.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		if (id === undefined) throw new Error("plugin must be discovered");
		await env.manager.trust(id);
		await env.manager.setEnabled(id, true);
		const snapshot = await env.skills.load();
		const warning = snapshot.diagnostics.find((diagnostic) => diagnostic.code === "skill.skills_root_empty");
		expect(warning, "a silently empty skills root must be reported").toBeDefined();
		expect(warning?.message).toContain("declare the parent directory");
	});

	it("does not warn when the declared root contains a skill directory", async () => {
		const env = await environment("./skills");
		const discovered = await env.manager.discover({ publish: true });
		const id = discovered.plugins[0]?.descriptor.identity.qualifiedId;
		if (id === undefined) throw new Error("plugin must be discovered");
		await env.manager.trust(id);
		await env.manager.setEnabled(id, true);
		const snapshot = await env.skills.load();
		expect(snapshot.diagnostics.filter((diagnostic) => diagnostic.code === "skill.skills_root_empty")).toEqual([]);
	});
});
