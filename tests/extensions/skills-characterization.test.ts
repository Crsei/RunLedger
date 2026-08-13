/**
 * P0 characterization：冻结当前 PluginManager-owned Skill 生命周期、catalog
 * 渲染、loader 错误与 ExtensionManager turn snapshot 语义，作为 Discovery
 * Provider 重构的可失败基线。
 *
 * 目标：任何对 Skill 发现/激活/披露路径的重构（development-doc/
 * plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md
 * P2/P3）若改变以下行为，本文件必须失败。
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canCreateSymlink } from "../helpers/platform.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { PluginManager } from "../../src/extensions/plugins/manager.ts";
import { ExtensionManager } from "../../src/extensions/manager.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { createSkillRegistry } from "../../src/extensions/skills/registry.ts";
import type { SkillRegistrySnapshot } from "../../src/extensions/skills/registry.ts";
import { scanSkillsDirectory } from "../../src/extensions/skills/scanner.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../../src/extensions/diagnostics.ts";
import { SkillCatalog } from "../../src/extensions/skills/catalog.ts";
import { SkillToolResolver } from "../../src/extensions/skills/skill-tool.ts";
import { renderSkillCatalog, skillCatalogPromptFragment } from "../../src/extensions/skills/renderer.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot } from "../../src/extensions/types.ts";

const CAN_SYMLINK = canCreateSymlink();
const temporaryRoots: string[] = [];

function storageError(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT") return { ok: false, code: "missing", message: "path is missing" };
	if (code === "EACCES" || code === "EPERM") return { ok: false, code: "denied", message: "path access denied" };
	return { ok: false, code: "io", message: error instanceof Error ? error.message : "storage operation failed" };
}

class NodeTestExtensionStorage implements ExtensionStoragePort {
	public async realpath(path: string) {
		try { return { ok: true as const, value: await realpath(path) }; } catch (error) { return storageError(error); }
	}

	public async stat(path: string, options?: { followSymlinks?: boolean }) {
		try {
			const value = options?.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" as const : value.isDirectory() ? "directory" as const : value.isSymbolicLink() ? "symlink" as const : "other" as const;
			return { ok: true as const, value: { kind, size: value.size } };
		} catch (error) { return storageError(error); }
	}

	public async readDirectory(path: string) {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return { ok: true as const, value: entries.map((entry) => ({ name: entry.name, kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : entry.isSymbolicLink() ? "symlink" as const : "other" as const })) };
		} catch (error) { return storageError(error); }
	}

	public async readFile(path: string, maxBytes: number) {
		try {
			const value = await readFile(path);
			return value.byteLength > maxBytes
				? { ok: false as const, code: "oversize" as const, message: "file exceeds byte bound" }
				: { ok: true as const, value };
		} catch (error) { return storageError(error); }
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) {
		const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
		try {
			await mkdir(dirname(path), { recursive: true, mode: options.directoryMode });
			await writeFile(temporary, bytes, { mode: options.fileMode });
			await rename(temporary, path);
			return { ok: true as const, value: undefined };
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			return storageError(error);
		}
	}
}

const storage = new NodeTestExtensionStorage();
const scope: ExtensionRuntimeScope = {
	authorityId: createRuntimeId("authority", "skills-characterization"),
	tenantId: createRuntimeId("tenant", "skills-characterization"),
	principalId: createRuntimeId("principal", "skills-characterization"),
};

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-skill-char-${label}-`));
	temporaryRoots.push(path);
	return path;
}

async function writeSkill(root: string, directory: string, name: string, description = "Review a release safely", extraFrontmatter = ""): Promise<string> {
	const skillRoot = join(root, "skills", directory);
	await mkdir(skillRoot, { recursive: true });
	await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nuser-invocable: true\ndisable-model-invocation: false${extraFrontmatter}\n---\nBody of ${name}.\n`);
	return skillRoot;
}

async function writePlugin(root: string, name: string, skillDirectory: string, skillName: string, extraSkillFrontmatter = ""): Promise<void> {
	await mkdir(join(root, ".runledger-plugin"), { recursive: true });
	await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "Characterization fixture", skills: ["./skills"] }));
	await writeSkill(root, skillDirectory, skillName, "Build polished interfaces", extraSkillFrontmatter);
}

function root(rootPath: string, sourceKey: string, priority = 200, source: "user" | "project" | "session" = "project"): ExtensionSourceRoot {
	return { source, sourceKey, rootPath, priority };
}

async function trustedPluginManager(options: { readonly trustRoot: string; readonly pluginRoot: string; readonly sourceKey: string; readonly pluginName: string; readonly skillDirectory: string; readonly skillName: string }) {
	const trust = new TrustStore(join(options.trustRoot, "trust.json"), storage);
	const stateStore = new ExtensionStateStore(join(options.trustRoot, "state.json"), storage);
	const manager = new PluginManager({
		storage,
		trustStore: trust,
		stateStore,
		scope,
		roots: [root(options.pluginRoot, options.sourceKey, 100, "user")],
	});
	await manager.discover();
	const pluginId = manager.last()?.plugins[0]?.descriptor.identity.qualifiedId;
	if (pluginId === undefined) throw new Error("plugin identity missing");
	await manager.trust(pluginId);
	await manager.setEnabled(pluginId, true);
	return { trust, pluginId, manager, stateStore };
}

/** P2 后 PluginManager 只输出 contributions；characterization 经 SkillRegistry 读取 Skill。 */
async function pluginSkillSnapshot(input: { readonly manager: PluginManager; readonly trust: TrustStore; readonly stateStore: ExtensionStateStore }): Promise<SkillRegistrySnapshot> {
	const registry = createSkillRegistry({
		storage,
		trustStore: input.trust,
		stateStore: input.stateStore,
		scope,
		pluginContributions: () => input.manager.last()?.skillContributions ?? [],
	});
	return registry.load();
}

describe("P0 characterization: plugin-owned Skill identity and receipt inheritance", () => {
	it("freezes the exact qualified identity and parent provenance of a plugin-owned Skill", async () => {
		const parent = await temporary("identity");
		const extensionRoot = join(parent, "plugin");
		const pluginName = "fixture-plugin";
		await writePlugin(extensionRoot, pluginName, "frontend-design", "frontend-design");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const manager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await manager.discover();
		const pluginId = manager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await manager.trust(pluginId);
		await manager.setEnabled(pluginId, true);
		const plugin = manager.last()!.plugins.find((item) => item.descriptor.identity.qualifiedId === pluginId);
		const snapshot = await pluginSkillSnapshot({ manager, trust, stateStore });
		const skill = snapshot.active[0];
		expect(plugin).toBeDefined();
		expect(skill).toBeDefined();
		if (plugin === undefined || skill === undefined) return;

		expect(pluginId).toBe("plugin:user:fixture:fixture-plugin");
		expect(skill.descriptor.identity.qualifiedId).toBe("skill:plugin:user:fixture:fixture-plugin:frontend-design");
		expect(skill.descriptor.identity).toMatchObject({ kind: "skill", version: "1", source: "plugin" });
		expect(skill.descriptor.pluginId).toBe(pluginId);
		// 当前行为：trusted plugin Skill 的 provenance 不写 parentResourceId，
		// plugin 归属经 descriptor.pluginId 与 trustBinding.identity 表达。
		expect(skill.descriptor.provenance.sourceLocatorDigest).toBeDefined();
		expect(skill.descriptor.provenance.parentResourceId).toBeUndefined();
		expect(skill.descriptor).toMatchObject({ ready: true, trusted: true, trust: "trusted", activation: "ready" });
		expect(skill.trustBinding.identity.qualifiedId).toBe(pluginId);
		expect(skill.trustBinding.receiptId).toBe(plugin.descriptor.approvalReceiptId);
	});

	it("drops the inherited Skill from the active set when the Plugin is untrusted", async () => {
		const parent = await temporary("untrust");
		const extensionRoot = join(parent, "plugin");
		const pluginName = "fixture-plugin";
		await writePlugin(extensionRoot, pluginName, "frontend-design", "frontend-design");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const manager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await manager.discover();
		const pluginId = manager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await manager.trust(pluginId);
		await manager.setEnabled(pluginId, true);
		expect((await pluginSkillSnapshot({ manager, trust, stateStore })).active).toHaveLength(1);
		await manager.untrust(pluginId);
		expect((await pluginSkillSnapshot({ manager, trust, stateStore })).active).toHaveLength(0);
	});
});

describe("P0 characterization: catalog text and ContextEngine fragment", () => {
	it("renders a bounded stable catalog with name/qualifiedId rows and never the body", async () => {
		const parent = await temporary("catalog");
		const extensionRoot = join(parent, "plugin");
		const pluginName = "fixture-plugin";
		await writePlugin(extensionRoot, pluginName, "frontend-design", "frontend-design");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const manager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await manager.discover();
		const pluginId = manager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await manager.trust(pluginId);
		await manager.setEnabled(pluginId, true);
		const snapshot = await pluginSkillSnapshot({ manager, trust, stateStore });

		const rendered = renderSkillCatalog(snapshot.all, { maxChars: 240, modelContextChars: 20_000 });
		expect(rendered).toContain("Skills: pass exactly name or qualifiedId to Skill; never combine values.");
		expect(rendered).toContain("- name=frontend-design;qualifiedId=skill:plugin:user:fixture:fixture-plugin:frontend-design");
		expect(rendered).not.toContain("Body of frontend-design.");
		expect(rendered.length).toBeLessThanOrEqual(240);
		expect(renderSkillCatalog([...snapshot.all].reverse(), { maxChars: 240, modelContextChars: 20_000 })).toBe(rendered);
		expect(renderSkillCatalog(snapshot.all, { maxChars: 0, modelContextChars: 20_000 })).toBe("");
	});

	it("limits the ContextEngine fragment to 2% of model context and excludes blocked skills after the production ready-filter", async () => {
		const parent = await temporary("fragment");
		const extensionRoot = join(parent, "plugin");
		await writePlugin(extensionRoot, "fixture-plugin", "frontend-design", "frontend-design");
		await writeSkill(join(parent, "standalone"), "release-review", "release-review");

		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const manager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await manager.discover();
		const pluginId = manager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await manager.trust(pluginId);
		await manager.setEnabled(pluginId, true);
		const snapshot = await pluginSkillSnapshot({ manager, trust, stateStore });
		const untrusted = await scanSkillsDirectory(storage, {
			root: root(join(parent, "standalone"), "user:standalone", 300, "user"),
			skillsRoot: join(parent, "standalone", "skills"),
			scope,
			trustStore: new TrustStore(join(parent, "trust2.json"), storage),
			limits: DEFAULT_EXTENSION_LIMITS,
		});

		const blocked = untrusted.skills[0]!;
		expect(blocked.descriptor.activation).toBe("blocked");
		expect(blocked.descriptor.enabled).toBe(true);
		// 当前 renderer 只检查 enabled；production composition 在调用前过滤 ready。
		expect(renderSkillCatalog([...snapshot.all, blocked], { maxChars: 10_000, modelContextChars: 20_000 })).toContain("release-review");
		const productionView = skillCatalogPromptFragment([...snapshot.all, blocked].filter((skill) => skill.descriptor.activation === "ready"), 20_000);
		expect(productionView).toContain("frontend-design");
		expect(productionView).not.toContain("release-review");
		expect(productionView).not.toContain("Body of frontend-design.");

		expect(skillCatalogPromptFragment(snapshot.all, 1_000).length).toBeLessThanOrEqual(20);
	});
});

describe("P0 characterization: loader errors and invocation visibility", () => {
	it("returns typed not_found / ambiguous / blocked / stale results", async () => {
		const parent = await temporary("errors");
		const extensionRoot = join(parent, "plugin");
		await writePlugin(extensionRoot, "fixture-plugin", "frontend-design", "frontend-design");
		const { trust, manager, stateStore } = await trustedPluginManager({ trustRoot: parent, pluginRoot: extensionRoot, sourceKey: "user:fixture", pluginName: "fixture-plugin", skillDirectory: "frontend-design", skillName: "frontend-design" });
		const first = join(parent, "first");
		const second = join(parent, "second");
		await writeSkill(first, "one", "shared");
		await writeSkill(second, "two", "shared");
		const snapshot = await pluginSkillSnapshot({ manager, trust, stateStore });
		const resolver = new SkillToolResolver({ catalog: new SkillCatalog(snapshot.active), trustStore: trust, principalId: scope.principalId, storage, currentTools: () => ["read"] });
		const skillFile = join(extensionRoot, "skills", "frontend-design", "SKILL.md");

		expect(await resolver.load("missing")).toMatchObject({ ok: false, code: "not_found" });
		await writeFile(skillFile, "---\nname: frontend-design\ndescription: Changed\n---\nChanged body\n");
		expect(await resolver.load("$frontend-design")).toMatchObject({ ok: false, code: "stale" });

		const firstScan = await scanSkillsDirectory(storage, {
			root: root(first, "project:first", 100),
			skillsRoot: join(first, "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		const secondScan = await scanSkillsDirectory(storage, {
			root: root(second, "project:second", 200),
			skillsRoot: join(second, "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		const ambiguous = { skills: [...firstScan.skills, ...secondScan.skills], diagnostics: [] };
		const ambiguousCatalog = new SkillCatalog(ambiguous.skills);
		const resolved = ambiguousCatalog.resolve("/shared");
		expect(resolved).toMatchObject({ ok: false, code: "ambiguous" });
		if (!resolved.ok) expect(resolved.candidates).toHaveLength(2);

		const untrustedRoot = await writeSkill(join(parent, "standalone"), "release-review", "release-review");
		const untrusted = await scanSkillsDirectory(storage, {
			root: root(join(parent, "standalone"), "user:standalone", 300, "user"),
			skillsRoot: join(parent, "standalone", "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		expect(untrusted.skills).toHaveLength(1);
		expect(untrusted.skills[0]?.descriptor.identity.qualifiedId).toBe("skill:user:standalone:release-review");
		void untrustedRoot;
		const blocked = await new SkillToolResolver({ catalog: new SkillCatalog(untrusted.skills), trustStore: trust, principalId: scope.principalId, storage, currentTools: () => ["read"] }).load("$release-review");
		expect(blocked).toMatchObject({ ok: false, code: "blocked" });
	});

	it("blocks model-tool invocation for disable-model-invocation skills but keeps user triggers", async () => {
		const parent = await temporary("model-hidden");
		const skillRoot = join(parent, "skills", "secret-handbook");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(join(skillRoot, "SKILL.md"), "---\nname: secret-handbook\ndescription: Hidden from the model\ndisable-model-invocation: true\n---\nHidden body\n");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await scanSkillsDirectory(storage, {
			root: root(parent, "user:secret", 100, "user"),
			skillsRoot: join(parent, "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		const skill = result.skills[0]!;
		await trust.grant({ identity: skill.trustBinding.identity, canonicalPath: skill.trustBinding.canonicalPath, binding: skill.trustBinding.binding, principalId: scope.principalId, scope: "user" });
		const rediscovered = await scanSkillsDirectory(storage, {
			root: root(parent, "user:secret", 100, "user"),
			skillsRoot: join(parent, "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		const catalog = new SkillCatalog(rediscovered.skills);
		expect(catalog.resolve("secret-handbook")).toMatchObject({ ok: false, code: "blocked" });
		expect(catalog.resolve("$secret-handbook")).toMatchObject({ ok: true });
		expect(catalog.resolve("/secret-handbook")).toMatchObject({ ok: true });
		expect(catalog.resolve("/skill secret-handbook")).toMatchObject({ ok: true });
	});
});

describe("P0 characterization: discovery containment and turn snapshot", () => {
	it("silently skips a symlinked skill entry without a descriptor or escape diagnostic", { skip: !CAN_SYMLINK }, async () => {
		const parent = await temporary("symlink");
		const outside = await temporary("outside");
		await writeSkill(join(parent, "root"), "real", "real-skill");
		await writeSkill(join(outside, "target"), "escaped", "escaped-skill");
		await symlink(join(outside, "target"), join(parent, "root", "skills", "escaped"));
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await scanSkillsDirectory(storage, {
			root: root(join(parent, "root"), "project:symlink"),
			skillsRoot: join(parent, "root", "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		expect(result.skills.map((skill) => skill.descriptor.identity.qualifiedId)).toEqual(["skill:project:symlink:real-skill"]);
		expect(result.diagnostics.some((item) => item.code === "skill.path_escape")).toBe(false);
	});

	it("freezes the Skill catalog for the current turn and applies reloads only at the idle boundary", async () => {
		const parent = await temporary("turn");
		const extensionRoot = join(parent, "plugin");
		await writePlugin(extensionRoot, "fixture-plugin", "frontend-design", "frontend-design");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const pluginManager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await pluginManager.discover();
		const pluginId = pluginManager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await pluginManager.trust(pluginId);
		await pluginManager.setEnabled(pluginId, true);
		const skillRegistry = createSkillRegistry({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			pluginContributions: () => pluginManager.last()?.skillContributions ?? [],
		});
		const manager = new ExtensionManager({ pluginManager, skillRegistry });
		const loaded = await manager.load();
		expect(loaded.status).toBe("ready");
		expect(manager.current()?.generation).toBe(1);
		expect(manager.currentSkills()).toHaveLength(1);

		expect(manager.beginTurn()).toBe(manager.current());
		const pending = await manager.reload();
		expect(pending.status).toBe("pending");
		expect(manager.current()).toBe(pending.retained);
		expect(manager.current()?.generation).toBe(1);
		expect(manager.currentSkills()).toHaveLength(1);

		await manager.endTurn();
		expect(manager.current()?.generation).toBe(2);
		expect(manager.current()?.snapshotId).not.toBe(loaded.snapshot?.snapshotId);
		expect(manager.currentSkills()).toHaveLength(1);
	});

	it("invalidates the Plugin receipt when a file is added under the plugin root", async () => {
		const parent = await temporary("root-digest");
		const extensionRoot = join(parent, "plugin");
		await writePlugin(extensionRoot, "fixture-plugin", "frontend-design", "frontend-design");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "state.json"), storage);
		const pluginManager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore,
			scope,
			roots: [root(extensionRoot, "user:fixture", 100, "user")],
		});
		await pluginManager.discover();
		const pluginId = pluginManager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		await pluginManager.trust(pluginId);
		await pluginManager.setEnabled(pluginId, true);
		expect((await pluginSkillSnapshot({ manager: pluginManager, trust, stateStore })).all).toHaveLength(1);

		await writeSkill(extensionRoot, "release-review", "release-review");
		const rediscovered = await pluginManager.discover();
		expect(rediscovered.plugins[0]?.descriptor.trust).toBe("stale");
		expect(rediscovered.plugins[0]?.descriptor.activation).toBe("blocked");
		expect(rediscovered.skillContributions).toHaveLength(0);
	});
});

describe("P0 characterization: committed fixtures", () => {
	it("discovers the committed plugin and standalone Skill fixtures with stable identities", async () => {
		const parent = await temporary("fixtures");
		const fixtures = resolve(process.cwd(), "tests", "fixtures", "extensions", "skills");
		const trust = new TrustStore(join(parent, "trust.json"), storage);

		const standalone = await scanSkillsDirectory(storage, {
			root: root(join(fixtures, "standalone-skill"), "user:standalone", 100, "user"),
			skillsRoot: join(fixtures, "standalone-skill", "skills"),
			scope,
			trustStore: trust,
			limits: DEFAULT_EXTENSION_LIMITS,
		});
		expect(standalone.skills).toHaveLength(1);
		expect(standalone.skills[0]?.descriptor.identity.qualifiedId).toBe("skill:user:standalone:release-review");
		expect(standalone.skills[0]?.descriptor.activation).toBe("blocked");

		const pluginManager = new PluginManager({
			storage,
			trustStore: trust,
			stateStore: new ExtensionStateStore(join(parent, "state.json"), storage),
			scope,
			roots: [root(join(fixtures, "plugin-skill"), "user:fixture", 100, "user")],
		});
		await pluginManager.discover();
		const pluginId = pluginManager.last()!.plugins[0]!.descriptor.identity.qualifiedId;
		expect(pluginId).toBe("plugin:user:fixture:fixture-plugin");
		await pluginManager.trust(pluginId);
		await pluginManager.setEnabled(pluginId, true);
		const snapshot = await pluginSkillSnapshot({ manager: pluginManager, trust, stateStore: new ExtensionStateStore(join(parent, "state.json"), storage) });
		expect(snapshot.all[0]?.descriptor.identity.qualifiedId).toBe("skill:plugin:user:fixture:fixture-plugin:release-review");
		expect(snapshot.all[0]?.descriptor.activation).toBe("ready");
		const loaded = await new SkillToolResolver({
			catalog: new SkillCatalog(snapshot.active),
			trustStore: trust,
			principalId: scope.principalId,
			storage,
			currentTools: () => ["read"],
		}).load("$release-review");
		expect(loaded).toMatchObject({ ok: true, value: { body: "Follow the release checklist.\n" } });
	});
});
