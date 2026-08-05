/**
 * runtime-host-skills 桥接测试 —— 验证 createHostSkillLoader 真实路径：
 * trust → digest → body 加载 → catalog 动态刷新时行为正确。
 */

import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { discoverSkills } from "../../src/extensions/skills/discovery.ts";
import { createHostSkillLoader } from "../../src/cli/runtime-host-skills.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot } from "../../src/extensions/types.ts";
import type { SkillDescriptor } from "../../src/extensions/skills/types.ts";
import type { PrincipalId } from "../../src/runtime/protocol/ids.ts";

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

	public async stat(path: string, options?: { readonly followSymlinks?: boolean }) {
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

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { readonly fileMode: 0o600; readonly directoryMode: 0o700 }) {
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
	authorityId: createRuntimeId("authority", "host-skill-test"),
	tenantId: createRuntimeId("tenant", "host-skill-test"),
	principalId: createRuntimeId("principal", "host-skill-test") as PrincipalId,
};

function root(rootPath: string, sourceKey: string, priority = 200): ExtensionSourceRoot {
	return { source: "project", sourceKey, rootPath, priority };
}

async function temporary(tag: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `runledger-host-skill-${tag}-`));
}

async function writeSkill(root: string, directory: string, name = "release-review"): Promise<string> {
	const skillRoot = join(root, "skills", directory);
	await mkdir(join(skillRoot, "references"), { recursive: true });
	await mkdir(join(skillRoot, "assets"), { recursive: true });
	await mkdir(join(skillRoot, "scripts"), { recursive: true });
	await writeFile(join(skillRoot, "references", "checklist.md"), "# Checklist\n");
	await writeFile(join(skillRoot, "assets", "fixture.txt"), "asset\n");
	await writeFile(join(skillRoot, "scripts", "unsafe.mjs"), "throw new Error('must not execute');\n");
	await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: Host skill loader test\nallowed-tools:\n  - read\n  - bash\n---\nFollow the ${name} checklist\n`, "utf8");
	return skillRoot;
}

async function discoverAndTrust(parent: string): Promise<{ readonly skills: readonly SkillDescriptor[] }> {
	const extensionRoot = join(parent, ".runledger");
	const trust = new TrustStore(join(parent, "trust.json"), storage);
	await writeSkill(extensionRoot, "release-review");
	const untrusted = await discoverSkills({ roots: [root(extensionRoot, "project:host-skill")], scope, trustStore: trust, storage });
	const binding = untrusted.skills[0]?.trustBinding;
	expect(binding).toBeDefined();
	if (!binding) return { skills: [] };
	await trust.grant({ identity: binding.identity, canonicalPath: binding.canonicalPath, binding: binding.binding, principalId: scope.principalId, scope: "project" });
	const trusted = await discoverSkills({ roots: [root(extensionRoot, "project:host-skill")], scope, trustStore: trust, storage });
	expect(trusted.skills[0]?.descriptor.activation).toBe("ready");
	return { skills: trusted.skills };
}

describe("createHostSkillLoader", () => {
	it("loads the body of a trusted skill with digest and trust verification", async () => {
		const parent = await temporary("body-load");
		try {
			const trust = new TrustStore(join(parent, "trust.json"), storage);
			const { skills } = await discoverAndTrust(parent);
			const loader = createHostSkillLoader({
				skills: () => skills,
				trustStore: trust,
				principalId: scope.principalId,
				storage,
				currentTools: () => ["read", "write", "bash"],
			});
			const result = await loader("$release-review");
			expect(result).toMatchObject({ ok: true });
			if (!result.ok) return;
			expect(result.body).toContain("Follow the release-review checklist");
			expect(result.allowedTools).toEqual(["read", "bash"]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("returns blocked when the skill is not trusted", async () => {
		const parent = await temporary("untrusted-load");
		try {
			const trust = new TrustStore(join(parent, "trust.json"), storage);
			const extensionRoot = join(parent, ".runledger");
			await writeSkill(extensionRoot, "release-review");
			const untrusted = await discoverSkills({ roots: [root(extensionRoot, "project:host-untrusted")], scope, trustStore: trust, storage });
			const loader = createHostSkillLoader({
				skills: () => untrusted.skills,
				trustStore: trust,
				principalId: scope.principalId,
				storage,
				currentTools: () => ["read", "bash"],
			});
			const result = await loader("release-review");
			expect(result).toMatchObject({ ok: false, code: "blocked" });
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("detects post-snapshot body changes as stale", async () => {
		const parent = await temporary("stale-body");
		try {
			const trust = new TrustStore(join(parent, "trust.json"), storage);
			const { skills } = await discoverAndTrust(parent);
			const extensionRoot = join(parent, ".runledger");
			const loader = createHostSkillLoader({
				skills: () => skills,
				trustStore: trust,
				principalId: scope.principalId,
				storage,
				currentTools: () => ["read", "bash"],
			});
			expect(await loader("release-review")).toMatchObject({ ok: true });
			await writeFile(join(extensionRoot, "skills", "release-review", "SKILL.md"), "---\nname: release-review\ndescription: Changed\n---\nChanged\n", "utf8");
			expect(await loader("release-review")).toMatchObject({ ok: false, code: "stale" });
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	it("reflects catalog updates on the next invocation (hot reload safe)", async () => {
		const parent = await temporary("hot-reload");
		try {
			const trust = new TrustStore(join(parent, "trust.json"), storage);
			const { skills: initialSkills } = await discoverAndTrust(parent);
			let currentSkills = initialSkills;
			const loader = createHostSkillLoader({
				skills: () => currentSkills,
				trustStore: trust,
				principalId: scope.principalId,
				storage,
				currentTools: () => ["read", "bash"],
			});
			expect(await loader("$release-review")).toMatchObject({ ok: true });
			currentSkills = [];
			expect(await loader("release-review")).toMatchObject({ ok: false, code: "not_found" });
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
});
