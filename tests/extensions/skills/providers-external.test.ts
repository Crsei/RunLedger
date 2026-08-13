/**
 * P4：Codex/Agents compatibility providers——默认 off、零 I/O、缺目录
 * unavailable、fake home/repo 下同名不 first-wins、exact trust 后 active、
 * provider 不调用 homedir/cwd（D6）。
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createSkillRegistry } from "../../../src/extensions/skills/registry.ts";
import { ExtensionStateStore } from "../../../src/extensions/state-store.ts";
import { TrustStore } from "../../../src/extensions/trust/trust-store.ts";
import { SkillToolResolver } from "../../../src/extensions/skills/skill-tool.ts";
import { SkillCatalog } from "../../../src/extensions/skills/catalog.ts";
import { findProviderExecutionPortViolations } from "../../../scripts/check-execution-boundaries.ts";
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

class TracingStorage implements ExtensionStoragePort {
	public readonly probeCalls: string[] = [];
	public constructor(public readonly inner: ExtensionStoragePort) {}

	public async realpath(path: string) { this.probeCalls.push(`realpath:${path}`); return this.inner.realpath(path); }
	public async stat(path: string, options?: { followSymlinks?: boolean }) { this.probeCalls.push(`stat:${path}`); return this.inner.stat(path, options); }
	public async readDirectory(path: string) { this.probeCalls.push(`readDirectory:${path}`); return this.inner.readDirectory(path); }
	public async readFile(path: string, maxBytes: number) { this.probeCalls.push(`readFile:${path}`); return this.inner.readFile(path, maxBytes); }
	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) { return this.inner.writeFileAtomic(path, bytes, options); }
}

const storage = new NodeTestExtensionStorage();
const scope: ExtensionRuntimeScope = {
	authorityId: createRuntimeId("authority", "providers-external-test"),
	tenantId: createRuntimeId("tenant", "providers-external-test"),
	principalId: createRuntimeId("principal", "providers-external-test"),
};

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-ext-provider-${label}-`));
	temporaryRoots.push(path);
	return path;
}

async function writeSkill(skillsRoot: string, name: string, body = "Body."): Promise<string> {
	const skillRoot = join(skillsRoot, name);
	await mkdir(skillRoot, { recursive: true });
	await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`);
	return skillRoot;
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

describe("P4 Codex/Agents compatibility providers", () => {
	it("stays disabled with zero I/O when no policy enables it (default off)", async () => {
		const parent = await temporary("off");
		const fakeHome = join(parent, "home");
		await writeSkill(join(fakeHome, ".codex", "skills"), "codex-skill");
		const tracing = new TracingStorage(storage);
		const registry = createSkillRegistry(registryOptions(parent, { codexUserHome: fakeHome, agentsUserHome: fakeHome, storage: tracing }));
		const result = await registry.load();
		expect(result.all).toHaveLength(0);
		for (const id of ["codex-user", "agents-user"]) {
			expect(result.providers.find((provider) => provider.providerId === id)).toMatchObject({ state: "disabled", effectiveEnabled: false });
		}
		expect(tracing.probeCalls.some((call) => call.includes(".codex") || call.includes(".agents") || call.includes(".agent"))).toBe(false);
	});

	it("discovers an untrusted Codex user Skill after explicit enable and activates it through exact trust", async () => {
		const parent = await temporary("codex-user");
		const fakeHome = join(parent, "home");
		await writeSkill(join(fakeHome, ".codex", "skills"), "release-review");
		const registry = createSkillRegistry(registryOptions(parent, { codexUserHome: fakeHome }));
		const before = await registry.load({ providerEnabled: new Map([["codex-user", true]]) });
		expect(before.providers.find((provider) => provider.providerId === "codex-user")).toMatchObject({ state: "loaded", candidateCount: 1, activeCount: 0 });
		expect(before.all[0]?.descriptor.activation).toBe("blocked");
		const qualifiedId = before.all[0]!.descriptor.identity.qualifiedId;
		expect(qualifiedId).toContain("skill:user:");
		await registry.trust(qualifiedId);
		const after = await registry.load({ providerEnabled: new Map([["codex-user", true]]) });
		expect(after.active.map((skill) => skill.descriptor.identity.qualifiedId)).toEqual([qualifiedId]);
		const loaded = await new SkillToolResolver({ catalog: new SkillCatalog(after.active), trustStore: new TrustStore(join(parent, "trust.json"), storage), principalId: scope.principalId, storage, currentTools: () => ["read"] }).load("release-review");
		expect(loaded).toMatchObject({ ok: true, value: { body: "Body.\n" } });
	});

	it("keeps same-named Skills across Codex and Agents as distinct identities (ambiguous, no first-wins)", async () => {
		const parent = await temporary("same-name");
		const fakeHome = join(parent, "home");
		await writeSkill(join(fakeHome, ".codex", "skills"), "shared", "codex body");
		await writeSkill(join(fakeHome, ".agents", "skills"), "shared", "agents body");
		const registry = createSkillRegistry(registryOptions(parent, { codexUserHome: fakeHome, agentsUserHome: fakeHome }));
		const result = await registry.load({ providerEnabled: new Map([["codex-user", true], ["agents-user", true]]) });
		expect(result.all).toHaveLength(2);
		const identities = result.all.map((skill) => skill.descriptor.identity.qualifiedId).sort();
		expect(new Set(identities).size).toBe(2);
		expect(result.diagnostics.some((item) => item.code === "skill.identity_conflict")).toBe(false);
		const catalog = new SkillCatalog(result.all);
		expect(catalog.resolve("shared")).toMatchObject({ ok: false, code: "ambiguous" });
		const resolved = catalog.resolve("shared");
		if (!resolved.ok && resolved.candidates) expect(resolved.candidates).toHaveLength(2);
		for (const skill of result.all) await registry.trust(skill.descriptor.identity.qualifiedId);
		const after = await registry.load({ providerEnabled: new Map([["codex-user", true], ["agents-user", true]]) });
		const bodyByQualifiedId = new Map(after.active.map((skill) => [skill.descriptor.identity.qualifiedId, skill.bodyDigest]));
		expect(bodyByQualifiedId.size).toBe(2);
	});

	it("treats .agents and .agent directories as separate observations without name overriding", async () => {
		const parent = await temporary("dual-dirs");
		const fakeHome = join(parent, "home");
		await writeSkill(join(fakeHome, ".agents", "skills"), "agents-skill", "agents body");
		await writeSkill(join(fakeHome, ".agent", "skills"), "agent-skill", "agent body");
		const registry = createSkillRegistry(registryOptions(parent, { agentsUserHome: fakeHome }));
		const result = await registry.load({ providerEnabled: new Map([["agents-user", true]]) });
		expect(result.providers.find((provider) => provider.providerId === "agents-user")).toMatchObject({ state: "loaded", candidateCount: 2 });
		expect(result.all.map((skill) => skill.frontmatter.name).sort()).toEqual(["agent-skill", "agents-skill"]);
	});

	it("marks an external root unavailable when the directory is missing", async () => {
		const parent = await temporary("missing");
		const registry = createSkillRegistry(registryOptions(parent, { codexUserHome: join(parent, "no-home") }));
		const result = await registry.load({ providerEnabled: new Map([["codex-user", true]]) });
		expect(result.providers.find((provider) => provider.providerId === "codex-user")).toMatchObject({ state: "unavailable", observationCount: 0 });
		expect(result.all).toHaveLength(0);
	});

	it("scans a Codex project root at the injected repo boundary", async () => {
		const parent = await temporary("codex-project");
		const repoBoundary = join(parent, "repo");
		await writeSkill(join(repoBoundary, ".codex", "skills"), "project-skill");
		const registry = createSkillRegistry(registryOptions(parent, { codexProjectBoundary: repoBoundary }));
		const result = await registry.load({ providerEnabled: new Map([["codex-project", true]]) });
		expect(result.all[0]?.descriptor.identity.qualifiedId).toContain("skill:project:");
		expect(result.all[0]?.frontmatter.name).toBe("project-skill");
	});

	it("keeps case-colliding skill directories as distinct entries without first-wins", async () => {
		const parent = await temporary("case");
		const fakeHome = join(parent, "home");
		await writeSkill(join(fakeHome, ".codex", "skills"), "Review");
		await writeSkill(join(fakeHome, ".codex", "skills"), "review");
		const registry = createSkillRegistry(registryOptions(parent, { codexUserHome: fakeHome }));
		const result = await registry.load({ providerEnabled: new Map([["codex-user", true]]) });
		// frontmatter name 只接受小写：混合大小写目录被 schema 拒绝（独立条目，不合并、不 first-wins）。
		expect(result.all.map((skill) => skill.frontmatter.name)).toEqual(["review"]);
		expect(result.diagnostics.some((item) => item.code === "skill.schema_invalid")).toBe(true);
		expect(result.diagnostics.some((item) => item.code === "skill.identity_conflict")).toBe(false);
	});

	it("never calls homedir/cwd/env/Bun.Glob from any provider implementation", () => {
		for (const file of ["providers/shared.ts", "providers/codex.ts", "providers/agents.ts", "providers/runledger.ts", "providers/plugin-contributions.ts"]) {
			const source = readFileSync(join(process.cwd(), "src", "extensions", "skills", file), "utf8");
			expect(findProviderExecutionPortViolations(`src/extensions/skills/${file}`, source)).toEqual([]);
		}
	});
});
