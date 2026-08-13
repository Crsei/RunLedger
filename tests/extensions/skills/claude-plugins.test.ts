/**
 * P5：Claude roots + installed_plugins.json 有界兼容 parser 与 claude-plugins
 * provider 语义（02 计划 §6.2）。全部默认 off、只读、enabled:false 抑制、
 * true/缺失不授 trust、installPath containment/escape → blocked、
 * 同名副本不 first-wins。
 */

import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createSkillRegistry } from "../../../src/extensions/skills/registry.ts";
import { ExtensionStateStore } from "../../../src/extensions/state-store.ts";
import { TrustStore } from "../../../src/extensions/trust/trust-store.ts";
import { SkillToolResolver } from "../../../src/extensions/skills/skill-tool.ts";
import { SkillCatalog } from "../../../src/extensions/skills/catalog.ts";
import { parseInstalledPluginsRegistry } from "../../../src/extensions/skills/providers/claude-plugins.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../../src/extensions/storage-port.ts";
import type { ExtensionRuntimeScope } from "../../../src/extensions/types.ts";

const temporaryRoots: string[] = [];

function storageError(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT") return { ok: false, code: "missing", message: "path is missing" };
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
	authorityId: createRuntimeId("authority", "claude-plugins-test"),
	tenantId: createRuntimeId("tenant", "claude-plugins-test"),
	principalId: createRuntimeId("principal", "claude-plugins-test"),
};

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-claude-${label}-`));
	temporaryRoots.push(path);
	return path;
}

function registryOptions(parent: string, extra: Partial<Parameters<typeof createSkillRegistry>[0]> = {}) {
	return {
		storage,
		trustStore: new TrustStore(join(parent, "trust.json"), storage),
		stateStore: new ExtensionStateStore(join(parent, "state.json"), storage),
		scope,
		pluginContributions: () => [],
		...extra,
	};
}

const FIXTURES = resolve(process.cwd(), "tests", "fixtures", "extensions", "skills", "claude-plugins", "plugins");

describe("P5 claude-plugins registry parser", () => {
	it("parses bounded identity/version/installPath/enabled and ignores unknown fields", () => {
		const result = parseInstalledPluginsRegistry({
			"superpowers": { version: "1.0.0", installPath: "/home/u/.claude/plugins/superpowers", enabled: true, extra: "ignored" },
			"legacy": { version: "0.1.0", installPath: "/home/u/.claude/plugins/legacy" },
		}, "/registry.json");
		expect(result.entries).toEqual([
			{ entryId: "legacy", version: "0.1.0", installPath: "/home/u/.claude/plugins/legacy" },
			{ entryId: "superpowers", version: "1.0.0", installPath: "/home/u/.claude/plugins/superpowers", declaredEnabled: true },
		]);
		expect(result.diagnostics).toEqual([]);
	});

	it("rejects non-absolute install paths, non-boolean enabled, and oversized registries", () => {
		const relative = parseInstalledPluginsRegistry({ "x": { version: "1.0.0", installPath: "relative/path" } }, "/r.json");
		expect(relative.entries).toHaveLength(0);
		expect(relative.diagnostics.some((item) => item.code === "claude_plugins.entry_path_invalid")).toBe(true);

		const badEnabled = parseInstalledPluginsRegistry({ "x": { version: "1.0.0", installPath: "/a/b", enabled: "yes" } }, "/r.json");
		expect(badEnabled.entries).toHaveLength(0);
		expect(badEnabled.diagnostics.some((item) => item.code === "claude_plugins.entry_enabled_invalid")).toBe(true);

		const oversized = { "a": { version: "1.0.0", installPath: "/a/b" } };
		for (let index = 1; index < 130; index += 1) oversized[`entry-${index}`] = { version: "1.0.0", installPath: "/a/b" };
		const bound = parseInstalledPluginsRegistry(oversized, "/r.json");
		expect(bound.entries).toHaveLength(0);
		expect(bound.diagnostics.some((item) => item.code === "claude_plugins.registry_bound")).toBe(true);
	});
});

describe("P5 claude-plugins provider semantics", () => {
	async function writeRegistry(parent: string, entries: Record<string, unknown>): Promise<string> {
		const registryPath = join(parent, ".claude", "plugins", "installed_plugins.json");
		await mkdir(dirname(registryPath), { recursive: true });
		await writeFile(registryPath, JSON.stringify(entries, null, 2));
		return registryPath;
	}

	/** 把 committed fixture 插件复制进 tmp plugin cache root（installPath 必须在 cache root 内）。 */
	async function installPlugins(parent: string, names: readonly string[]): Promise<void> {
		for (const name of names) {
			await mkdir(join(parent, ".claude", "plugins", name), { recursive: true });
			await cp(join(FIXTURES, name, "skills"), join(parent, ".claude", "plugins", name, "skills"), { recursive: true });
		}
	}

	function installPath(parent: string, name: string): string {
		return join(parent, ".claude", "plugins", name);
	}

	it("stays disabled with zero I/O by default", async () => {
		const parent = await temporary("off");
		await installPlugins(parent, ["superpowers"]);
		await writeRegistry(parent, { superpowers: { version: "1.0.0", installPath: installPath(parent, "superpowers"), enabled: true } });
		const before = await readFile(join(parent, ".claude", "plugins", "installed_plugins.json"), "utf8");
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const result = await registry.load();
		expect(result.all).toHaveLength(0);
		expect(result.providers.find((provider) => provider.providerId === "claude-plugins")).toMatchObject({ state: "disabled" });
		expect(await readFile(join(parent, ".claude", "plugins", "installed_plugins.json"), "utf8")).toBe(before);
	});

	it("keeps an enabled entry untrusted until exact trust, then loads the body", async () => {
		const parent = await temporary("trust");
		await installPlugins(parent, ["superpowers"]);
		await writeRegistry(parent, { superpowers: { version: "1.0.0", installPath: installPath(parent, "superpowers"), enabled: true } });
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const before = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(before.providers.find((provider) => provider.providerId === "claude-plugins")).toMatchObject({ state: "loaded", candidateCount: 1, activeCount: 0 });
		expect(before.all[0]?.descriptor.activation).toBe("blocked");
		const qualifiedId = before.all[0]!.descriptor.identity.qualifiedId;
		await registry.trust(qualifiedId);
		const after = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(after.active.map((skill) => skill.descriptor.identity.qualifiedId)).toEqual([qualifiedId]);
		const loaded = await new SkillToolResolver({ catalog: new SkillCatalog(after.active), trustStore: new TrustStore(join(parent, "trust.json"), storage), principalId: scope.principalId, storage, currentTools: () => ["read"] }).load("release-review");
		expect(loaded).toMatchObject({ ok: true, value: { body: "Superpowers-style release review body.\n" } });
	});

	it("suppresses enabled:false entries and never grants trust from declared enabled:true", async () => {
		const parent = await temporary("suppress");
		await installPlugins(parent, ["superpowers", "disabled"]);
		await writeRegistry(parent, {
			superpowers: { version: "1.0.0", installPath: installPath(parent, "superpowers"), enabled: true },
			disabled: { version: "1.0.0", installPath: installPath(parent, "disabled"), enabled: false },
		});
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const result = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(result.all).toHaveLength(1);
		// declared enabled:true 不等于 RunLedger trust（候选 blocked，仅 inspect 可见）。
		expect(result.all[0]?.descriptor.activation).toBe("blocked");
	});

	it("keeps same-named plugin Skills as distinct identities (ambiguous, no first-wins)", async () => {
		const parent = await temporary("same-name");
		await installPlugins(parent, ["superpowers", "oh-my-mermaid"]);
		await writeRegistry(parent, {
			superpowers: { version: "1.0.0", installPath: installPath(parent, "superpowers"), enabled: true },
			"oh-my-mermaid": { version: "2.0.0", installPath: installPath(parent, "oh-my-mermaid"), enabled: true },
		});
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const result = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(result.all).toHaveLength(2);
		expect(new Set(result.all.map((skill) => skill.descriptor.identity.qualifiedId)).size).toBe(2);
		expect(result.diagnostics.some((item) => item.code === "skill.identity_conflict")).toBe(false);
		const catalog = new SkillCatalog(result.all);
		expect(catalog.resolve("release-review")).toMatchObject({ ok: false, code: "ambiguous" });
	});

	it("reports installPath escape as a blocked diagnostic without observations", async () => {
		const parent = await temporary("escape");
		await writeRegistry(parent, { evil: { version: "1.0.0", installPath: resolve(parent, "outside"), enabled: true } });
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const result = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(result.all).toHaveLength(0);
		expect(result.diagnostics.some((item) => item.code === "claude_plugins.path_escape")).toBe(true);
	});

	it("skips dangling install paths and never modifies the external registry", async () => {
		const parent = await temporary("dangling");
		await writeRegistry(parent, { ghost: { version: "1.0.0", installPath: join(parent, ".claude", "plugins", "ghost"), enabled: true } });
		const registryPath = join(parent, ".claude", "plugins", "installed_plugins.json");
		const before = await readFile(registryPath, "utf8");
		const registry = createSkillRegistry(registryOptions(parent, { claudePluginsHome: parent }));
		const result = await registry.load({ providerEnabled: new Map([["claude-plugins", true]]) });
		expect(result.all).toHaveLength(0);
		// dangling installPath 无法 realpath/containment，产生 blocked diagnostic（不授 trust）。
		expect(result.diagnostics.some((item) => item.code === "claude_plugins.path_escape")).toBe(true);
		expect(await readFile(registryPath, "utf8")).toBe(before);
	});

	it("scans claude user and project roots when enabled", async () => {
		const parent = await temporary("roots");
		const fakeHome = join(parent, "home");
		const repoBoundary = join(parent, "repo");
		for (const root of [join(fakeHome, ".claude", "skills"), join(repoBoundary, ".claude", "skills")]) {
			const skillRoot = join(root, "claude-skill");
			await mkdir(skillRoot, { recursive: true });
			await writeFile(join(skillRoot, "SKILL.md"), "---\nname: claude-skill\ndescription: d\n---\nb\n");
		}
		const registry = createSkillRegistry(registryOptions(parent, { claudeUserHome: fakeHome, claudeProjectBoundary: repoBoundary }));
		const result = await registry.load({ providerEnabled: new Map([["claude-user", true], ["claude-project", true]]) });
		expect(result.providers.find((provider) => provider.providerId === "claude-user")).toMatchObject({ state: "loaded", candidateCount: 1 });
		expect(result.providers.find((provider) => provider.providerId === "claude-project")).toMatchObject({ state: "loaded", candidateCount: 1 });
		expect(result.all).toHaveLength(2);
	});
});
