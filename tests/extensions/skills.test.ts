import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { discoverSkills } from "../../src/extensions/skills/discovery.ts";
import { parseSkillDocument } from "../../src/extensions/skills/frontmatter.ts";
import { SkillCatalog } from "../../src/extensions/skills/catalog.ts";
import { renderSkillCatalog } from "../../src/extensions/skills/renderer.ts";
import { SkillToolResolver } from "../../src/extensions/skills/skill-tool.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot } from "../../src/extensions/types.ts";

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
	authorityId: createRuntimeId("authority", "skills-test"),
	tenantId: createRuntimeId("tenant", "skills-test"),
	principalId: createRuntimeId("principal", "skills-test"),
};

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-skill-${label}-`));
	temporaryRoots.push(path);
	return path;
}

async function writeSkill(root: string, directory: string, name = "release-review", description = "Review a release safely"): Promise<string> {
	const skillRoot = join(root, "skills", directory);
	await mkdir(join(skillRoot, "references"), { recursive: true });
	await mkdir(join(skillRoot, "assets"), { recursive: true });
	await mkdir(join(skillRoot, "scripts"), { recursive: true });
	await writeFile(join(skillRoot, "references", "checklist.md"), "# Checklist\n");
	await writeFile(join(skillRoot, "assets", "fixture.txt"), "asset\n");
	await writeFile(join(skillRoot, "scripts", "unsafe.mjs"), "throw new Error('must not execute');\n");
	await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nuser-invocable: true\ndisable-model-invocation: false\nallowed-tools:\n  - read\n  - bash\nmetadata:\n  owner: release\n---\nFollow the release checklist.\n`);
	return skillRoot;
}

function root(rootPath: string, sourceKey: string, priority = 200): ExtensionSourceRoot {
	return { source: "project", sourceKey, rootPath, priority };
}

describe("M2 Skill discovery and on-demand loading", () => {
	it("parses a bounded frontmatter subset and reports unknown fields without executing content", () => {
		const parsed = parseSkillDocument("---\nname: fixture\ndescription: Fixture skill\nunknown: ignored\n---\nBody\n", "/fixture/SKILL.md");
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.frontmatter).toMatchObject({ name: "fixture", userInvocable: true, disableModelInvocation: false });
			expect(parsed.body).toBe("Body\n");
			expect(parsed.diagnostics.map((item) => item.code)).toContain("skill.unknown_field");
		}
		expect(parseSkillDocument("name: fixture", "/fixture/SKILL.md").ok).toBe(false);
		expect(parseSkillDocument("---\nname: fixture\ndescription: x\nallowed-tools: [read, bash]\n---\nBody\n", "/fixture/SKILL.md")).toMatchObject({ ok: true });
		expect(parseSkillDocument("---\nname: fixture\ndescription: x\nmetadata:\n  owner: release\n  owner: duplicate\n---\nBody\n", "/fixture/SKILL.md").ok).toBe(false);
	});

	it("discovers bounded metadata facets, keeps untrusted bodies blocked, and never executes scripts", async () => {
		const parent = await temporary("discovery");
		const extensionRoot = join(parent, ".runledger");
		const skillRoot = await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope, trustStore: trust, storage });
		expect(result.skills).toHaveLength(1);
		const discovered = result.skills[0];
		expect(discovered?.descriptor.activation).toBe("blocked");
		expect(discovered?.trustBinding.canonicalPath).toBe(skillRoot);
		expect(discovered?.resourceSet).toMatchObject({ metadata: { role: "metadata" }, body: { role: "body" }, references: { role: "references" }, assets: { role: "assets" }, script: { role: "script" } });
		expect(await readdir(join(skillRoot, "scripts"))).toEqual(["unsafe.mjs"]);
		const blocked = await new SkillToolResolver({ catalog: new SkillCatalog(result.skills), trustStore: trust, principalId: scope.principalId, storage, currentTools: () => ["read", "write", "bash"] }).load("$release-review");
		expect(blocked).toMatchObject({ ok: false, code: "blocked" });
	});

	it("keeps plugin-owned skills typed and labeled as plugin resources", async () => {
		const parent = await temporary("plugin-source");
		const extensionRoot = join(parent, ".runledger");
		await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await discoverSkills({
			roots: [{ ...root(extensionRoot, "project:plugin"), pluginId: "plugin:fixture" }],
			scope,
			trustStore: trust,
			storage,
		});

		expect(result.skills[0]?.descriptor).toMatchObject({
			pluginId: "plugin:fixture",
			identity: { source: "plugin" },
			resource: { source: "plugin" },
			provenance: { source: "plugin" },
		});
	});

	it("loads an exact trusted body, intersects allowed tools, and rejects post-snapshot changes", async () => {
		const parent = await temporary("load");
		const extensionRoot = join(parent, ".runledger");
		const skillRoot = await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const untrusted = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope, trustStore: trust, storage });
		const binding = untrusted.skills[0]?.trustBinding;
		expect(binding).toBeDefined();
		if (!binding) return;
		await trust.grant({ identity: binding.identity, canonicalPath: binding.canonicalPath, binding: binding.binding, principalId: scope.principalId, scope: "project" });
		const trusted = await discoverSkills({ roots: [root(extensionRoot, "project:fixture")], scope, trustStore: trust, storage });
		expect(trusted.skills[0]?.descriptor.activation).toBe("ready");
		const resolver = new SkillToolResolver({ catalog: new SkillCatalog(trusted.skills), trustStore: trust, principalId: scope.principalId, storage, currentTools: () => ["read", "write", "bash"] });
		const loaded = await resolver.load("$release-review deploy production");
		expect(loaded).toMatchObject({ ok: true, value: { trigger: "dollar", argument: "deploy production", allowedTools: ["read", "bash"] } });
		if (loaded.ok) expect(loaded.value.body).toContain("Follow the release checklist");
		await writeFile(join(skillRoot, "SKILL.md"), "---\nname: release-review\ndescription: Changed\n---\nChanged body\n");
		expect(await resolver.load("release-review")).toMatchObject({ ok: false, code: "stale" });
	});

	it("does not use a trust grant from a different scope", async () => {
		const parent = await temporary("scope");
		const extensionRoot = join(parent, ".runledger");
		await writeSkill(extensionRoot, "release-review");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const untrusted = await discoverSkills({ roots: [root(extensionRoot, "project:scope")], scope, trustStore: trust, storage });
		const binding = untrusted.skills[0]?.trustBinding;
		expect(binding).toBeDefined();
		if (!binding) return;
		await trust.grant({ identity: binding.identity, canonicalPath: binding.canonicalPath, binding: binding.binding, principalId: scope.principalId, scope: "user" });
		const rediscovered = await discoverSkills({ roots: [root(extensionRoot, "project:scope")], scope, trustStore: trust, storage });
		expect(rediscovered.skills[0]?.descriptor.activation).toBe("blocked");
	});

	it("requires qualified identity for ambiguous names and renders a deterministic bounded catalog", async () => {
		const parent = await temporary("ambiguous");
		const first = join(parent, "first");
		const second = join(parent, "second");
		await writeSkill(first, "one", "shared", "A".repeat(300));
		await writeSkill(second, "two", "shared", "B".repeat(300));
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const result = await discoverSkills({ roots: [root(first, "project:first", 100), root(second, "project:second", 200)], scope, trustStore: trust, storage });
		const catalog = new SkillCatalog(result.skills);
		const ambiguous = catalog.resolve("/shared");
		expect(ambiguous).toMatchObject({ ok: false, code: "ambiguous" });
		if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2);
		const rendered = renderSkillCatalog(result.skills, { maxChars: 180, modelContextChars: 20_000 });
		expect(rendered.length).toBeLessThanOrEqual(180);
		expect(rendered).toContain("skill:project:first:shared");
		expect(rendered).toContain("skill:project:second:shared");
		expect(renderSkillCatalog([...result.skills].reverse(), { maxChars: 180, modelContextChars: 20_000 })).toBe(rendered);
	});
});
