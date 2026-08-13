/**
 * P2 SkillRegistry：canonical providers 装配、零 I/O、合并/冲突、trust 与
 * snapshot 确定性。production 装配（user/workspace/plugin 进标准 Session）由
 * extensions-domain.test.ts 的 acceptance 测试覆盖。
 */

import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createSkillRegistry } from "../../../src/extensions/skills/registry.ts";
import type { SkillDiscoveryObservation } from "../../../src/extensions/skills/registry.ts";
import type { DiscoveryProvider } from "../../../src/extensions/capabilities/types.ts";
import { ExtensionStateStore } from "../../../src/extensions/state-store.ts";
import { TrustStore } from "../../../src/extensions/trust/trust-store.ts";
import { SkillToolResolver } from "../../../src/extensions/skills/skill-tool.ts";
import { SkillCatalog } from "../../../src/extensions/skills/catalog.ts";
import { skillCatalogPromptFragment } from "../../../src/extensions/skills/renderer.ts";
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

	public async realpath(path: string) {
		this.probeCalls.push(`realpath:${path}`);
		return this.inner.realpath(path);
	}

	public async stat(path: string, options?: { followSymlinks?: boolean }) {
		this.probeCalls.push(`stat:${path}`);
		return this.inner.stat(path, options);
	}

	public async readDirectory(path: string) {
		this.probeCalls.push(`readDirectory:${path}`);
		return this.inner.readDirectory(path);
	}

	public async readFile(path: string, maxBytes: number) {
		this.probeCalls.push(`readFile:${path}`);
		return this.inner.readFile(path, maxBytes);
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) {
		return this.inner.writeFileAtomic(path, bytes, options);
	}
}

const storage = new NodeTestExtensionStorage();
const scope: ExtensionRuntimeScope = {
	authorityId: createRuntimeId("authority", "skill-registry-test"),
	tenantId: createRuntimeId("tenant", "skill-registry-test"),
	principalId: createRuntimeId("principal", "skill-registry-test"),
};

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-skill-registry-${label}-`));
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

describe("P2 SkillRegistry canonical providers", () => {
	it("discovers an untrusted canonical user Skill (inspect) and activates it through exact trust", async () => {
		const parent = await temporary("user");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));
		const before = await registry.load();
		expect(before.all).toHaveLength(1);
		expect(before.all[0]?.descriptor.activation).toBe("blocked");
		expect(before.active).toHaveLength(0);
		expect(before.modelDiscoverable).toHaveLength(0);
		expect(before.all[0]?.descriptor.identity.qualifiedId).toContain("skill:user:");
		expect(before.providers.find((item) => item.providerId === "runledger-user")).toMatchObject({ state: "loaded", candidateCount: 1, activeCount: 0 });

		const qualifiedId = before.all[0]!.descriptor.identity.qualifiedId;
		await registry.trust(qualifiedId);
		const after = await registry.load();
		expect(after.active.map((skill) => skill.descriptor.identity.qualifiedId)).toEqual([qualifiedId]);
		expect(after.providers.find((item) => item.providerId === "runledger-user")).toMatchObject({ state: "loaded", activeCount: 1 });
		const loaded = await new SkillToolResolver({ catalog: new SkillCatalog(after.active), trustStore: new TrustStore(join(parent, "trust.json"), storage), principalId: scope.principalId, storage, currentTools: () => ["read"] }).load("release-review");
		expect(loaded).toMatchObject({ ok: true, value: { body: "Body.\n" } });

		await registry.untrust(qualifiedId);
		const revoked = await registry.load();
		expect(revoked.active).toHaveLength(0);
	});

	it("never touches a disabled provider root (zero I/O)", async () => {
		const parent = await temporary("disabled-io");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const tracing = new TracingStorage(storage);
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot, storage: tracing }));
		const result = await registry.load({ providerEnabled: new Map([["runledger-user", false]]) });
		expect(result.all).toHaveLength(0);
		expect(result.providers.find((item) => item.providerId === "runledger-user")).toMatchObject({ state: "disabled", effectiveEnabled: false });
		expect(tracing.probeCalls.some((call) => call.includes("user") && call.includes("skills"))).toBe(false);
	});

	it("marks a missing canonical root unavailable without resources", async () => {
		const parent = await temporary("missing");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: join(parent, "user", "skills") }));
		const result = await registry.load();
		expect(result.providers.find((item) => item.providerId === "runledger-user")).toMatchObject({ state: "unavailable", observationCount: 0 });
		expect(result.all).toHaveLength(0);
	});

	it("scans a workspace skill with project-scoped identity", async () => {
		const parent = await temporary("workspace");
		const workspaceRoot = join(parent, "workspaces", "ws-key", "skills");
		await writeSkill(workspaceRoot, "release-review");
		const registry = createSkillRegistry(registryOptions(parent, { workspaceSkillRoot: workspaceRoot }));
		const result = await registry.load();
		expect(result.all[0]?.descriptor.identity.qualifiedId).toContain("skill:project:");
		expect(result.all[0]?.descriptor.identity.source).toBe("project");
		expect(result.providers.find((item) => item.providerId === "runledger-workspace")).toMatchObject({ state: "loaded", candidateCount: 1 });
	});

	it("merges identical observations from two providers into one descriptor with both providerIds", async () => {
		const parent = await temporary("merge");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const observationFor = (providerId: string): SkillDiscoveryObservation => ({
			providerId,
			source: "user",
			level: "user",
			canonicalRoot: userRoot,
			scanKind: "skills-directory",
			priority: 100,
		});
		const probeA: DiscoveryProvider<SkillDiscoveryObservation> = { id: "probe-a", displayName: "probe a", capabilityId: "skills", rank: 90, defaultEnabled: true, load: async () => ({ ok: true, providerId: "probe-a", observations: [observationFor("probe-a")] }) };
		const probeB: DiscoveryProvider<SkillDiscoveryObservation> = { id: "probe-b", displayName: "probe b", capabilityId: "skills", rank: 91, defaultEnabled: true, load: async () => ({ ok: true, providerId: "probe-b", observations: [observationFor("probe-b")] }) };
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot, providers: [probeA, probeB] }));
		const result = await registry.load();
		expect(result.all).toHaveLength(1);
		expect(result.all[0]?.providerIds).toEqual(["probe-a", "probe-b", "runledger-user"]);
		expect(result.providers.find((item) => item.providerId === "probe-a")).toMatchObject({ candidateCount: 1 });
		expect(result.providers.find((item) => item.providerId === "probe-b")).toMatchObject({ candidateCount: 1 });
	});

	it("fails closed on same identity with different content and emits skill.identity_conflict", async () => {
		const parent = await temporary("conflict");
		const firstRoot = join(parent, "first", "skills");
		const secondRoot = join(parent, "second", "skills");
		await writeSkill(firstRoot, "shared", "first body");
		await writeSkill(secondRoot, "shared", "second body");
		const contributions = () => [
			{ pluginId: "plugin:user:fixture:same", source: "user" as const, sourceKey: "user:fixture", priority: 100, skillRoot: firstRoot },
			{ pluginId: "plugin:user:fixture:same", source: "user" as const, sourceKey: "user:fixture", priority: 100, skillRoot: secondRoot },
		];
		const registry = createSkillRegistry(registryOptions(parent, { pluginContributions: contributions }));
		const result = await registry.load();
		expect(result.all).toHaveLength(0);
		expect(result.diagnostics.some((item) => item.code === "skill.identity_conflict")).toBe(true);
	});

	it("produces a deterministic digest across loads and increments generation", async () => {
		const parent = await temporary("deterministic");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));
		const first = await registry.load();
		const second = await registry.load();
		expect(first.digest).toBe(second.digest);
		expect(first.generation).toBe(1);
		expect(second.generation).toBe(2);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.all)).toBe(true);
	});

	it("retains the last-known-good snapshot when canonical extension state is corrupt", async () => {
		const parent = await temporary("corrupt-state");
		const statePath = join(parent, "state.json");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const stateStore = new ExtensionStateStore(statePath, storage);
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot, stateStore }));
		const discovered = await registry.load();
		const qualifiedId = discovered.all[0]!.descriptor.identity.qualifiedId;
		await registry.trust(qualifiedId);
		await stateStore.setEnabled(qualifiedId, false);
		const disabled = await registry.load();
		expect(disabled.all[0]?.descriptor.activation).toBe("disabled");

		await writeFile(statePath, "{ invalid json");
		await expect(registry.load()).rejects.toThrow("extensions-state.json is invalid JSON");
		expect(registry.current()).toBe(disabled);
		expect(registry.current()?.all[0]?.descriptor.activation).toBe("disabled");
	});
});

describe("P3 four-view visibility matrix", () => {
	async function writeSkillWithFrontmatter(skillsRoot: string, name: string, extra: string): Promise<string> {
		const skillRoot = join(skillsRoot, name);
		await mkdir(skillRoot, { recursive: true });
		await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n${extra}---\nBody of ${name}.\n`);
		return skillRoot;
	}

	it("projects active into modelDiscoverable/userInvocable views after exact trust", async () => {
		const parent = await temporary("views");
		const userRoot = join(parent, "user", "skills");
		await writeSkillWithFrontmatter(userRoot, "model-only", "user-invocable: false\n");
		await writeSkillWithFrontmatter(userRoot, "user-only", "disable-model-invocation: true\n");
		await writeSkillWithFrontmatter(userRoot, "hidden", "disable-model-invocation: true\nuser-invocable: false\n");
		await writeSkillWithFrontmatter(userRoot, "plain", "");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));

		const before = await registry.load();
		expect(before.all.map((skill) => skill.frontmatter.name)).toEqual(["hidden", "model-only", "plain", "user-only"]);
		expect(before.active).toHaveLength(0);

		for (const skill of before.all) await registry.trust(skill.descriptor.identity.qualifiedId);
		const after = await registry.load();
		expect(after.active.map((skill) => skill.frontmatter.name)).toEqual(["hidden", "model-only", "plain", "user-only"]);
		expect(after.modelDiscoverable.map((skill) => skill.frontmatter.name)).toEqual(["model-only", "plain"]);
		expect(after.userInvocable.map((skill) => skill.frontmatter.name)).toEqual(["plain", "user-only"]);
	});

	it("keeps model-hidden and user-non-invocable skills out of the rendered catalog but reachable per trigger", async () => {
		const parent = await temporary("triggers");
		const userRoot = join(parent, "user", "skills");
		await writeSkillWithFrontmatter(userRoot, "model-only", "user-invocable: false\n");
		await writeSkillWithFrontmatter(userRoot, "user-only", "disable-model-invocation: true\n");
		await writeSkillWithFrontmatter(userRoot, "plain", "");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));
		const before = await registry.load();
		for (const skill of before.all) await registry.trust(skill.descriptor.identity.qualifiedId);
		const snapshot = await registry.load();
		const catalog = new SkillCatalog(snapshot.active);
		const trust = new TrustStore(join(parent, "trust.json"), storage);

		expect(snapshot.modelDiscoverable.map((skill) => skill.frontmatter.name)).toEqual(["model-only", "plain"]);
		// 模型路径：user-only 被 disable-model-invocation 挡；model-only/plain 可达。
		expect(catalog.resolve("user-only")).toMatchObject({ ok: false, code: "blocked" });
		expect(catalog.resolve("model-only")).toMatchObject({ ok: true });
		expect(catalog.resolve("plain")).toMatchObject({ ok: true });
		// 用户路径：model-only 被 user-invocable: false 挡；user-only/plain 可达。
		expect(catalog.resolve("$model-only")).toMatchObject({ ok: false, code: "blocked" });
		expect(catalog.resolve("$user-only")).toMatchObject({ ok: true });
		expect(catalog.resolve("$plain")).toMatchObject({ ok: true });

		const rendered = skillCatalogPromptFragment(snapshot.active, 20_000);
		expect(rendered).toContain("model-only");
		expect(rendered).toContain("plain");
		expect(rendered).not.toContain("user-only");
		expect(rendered).not.toContain("hidden");
	});

	it("masterEnabled=false disables every provider and yields zero skills", async () => {
		const parent = await temporary("master-off");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const tracing = new TracingStorage(storage);
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot, storage: tracing }));
		const result = await registry.load({ masterEnabled: false });
		expect(result.all).toHaveLength(0);
		expect(result.providers.every((provider) => provider.state === "disabled")).toBe(true);
		expect(tracing.probeCalls.some((call) => call.includes("skills"))).toBe(false);
	});

	it("exposes provider status counts in the snapshot", async () => {
		const parent = await temporary("counts");
		const userRoot = join(parent, "user", "skills");
		await writeSkill(userRoot, "release-review");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));
		const before = await registry.load();
		expect(before.providers.find((provider) => provider.providerId === "runledger-user")).toMatchObject({ candidateCount: 1, activeCount: 0, failedCount: 0 });
		await registry.trust(before.all[0]!.descriptor.identity.qualifiedId);
		const after = await registry.load();
		expect(after.providers.find((provider) => provider.providerId === "runledger-user")).toMatchObject({ candidateCount: 1, activeCount: 1, failedCount: 0 });
	});
});

describe("P7 unified catalog progressive disclosure", () => {
	it("routes model and user triggers through the same resolver with per-trigger visibility", async () => {
		const parent = await temporary("unified");
		const userRoot = join(parent, "user", "skills");
		const userOnlyRoot = join(userRoot, "user-only");
		await mkdir(userOnlyRoot, { recursive: true });
		await writeFile(join(userOnlyRoot, "SKILL.md"), "---\nname: user-only\ndescription: d\ndisable-model-invocation: true\n---\nUser-only body.\n");
		const registry = createSkillRegistry(registryOptions(parent, { userSkillRoot: userRoot }));
		const before = await registry.load();
		await registry.trust(before.all[0]!.descriptor.identity.qualifiedId);
		const snapshot = await registry.load();
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const resolver = new SkillToolResolver({ catalog: new SkillCatalog(snapshot.active), trustStore: trust, principalId: scope.principalId, storage, currentTools: () => ["read"] });
		// 同一 catalog：模型触发被挡（不在 modelDiscoverable），用户触发可读正文。
		expect(await resolver.load("user-only")).toMatchObject({ ok: false, code: "blocked" });
		expect(await resolver.load("$user-only")).toMatchObject({ ok: true, value: { body: "User-only body.\n", trigger: "dollar" } });
	});
});
