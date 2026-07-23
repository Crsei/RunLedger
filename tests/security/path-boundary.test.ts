import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, readdir, rename, rm, stat, lstat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	CanonicalPathResolver,
	FileAccessGuard,
	PolicyFileSystem,
	pathWithin,
	type FileSystemBrokerPort,
} from "../../src/security/policy-filesystem.ts";
import type { SecuritySnapshot } from "../../src/security/types.ts";

const roots: string[] = [];

const broker: FileSystemBrokerPort = {
	readFile,
	writeFile,
	stat: async (path) => { const value = await stat(path); return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() }; },
	lstat: async (path) => { const value = await lstat(path); return { size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() }; },
	realpath,
	readdir,
	mkdir,
	rm,
	rename,
};

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function snapshot(root: string): SecuritySnapshot {
	return {
		profile: { name: "workspace-write", approvalPolicy: "on-request", filesystemMode: "workspace-write", network: { mode: "deny", allowedHosts: [] }, sandbox: "workspace-write" },
		filesystem: { readRoots: [root], writeRoots: [root], denyRead: [], denyWrite: [], protectedPaths: [join(root, ".git"), join(root, ".runledger")] },
		rules: [], sources: ["builtin"], workspaceRoot: root, tempRoot: join(root, ".tmp"), policyDigest: "e".repeat(64), createdAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("filesystem path boundary", () => {
	it("does not confuse a root with a lexical prefix sibling", () => {
		expect(pathWithin("/repo", "/repo/file.ts")).toBe(true);
		expect(pathWithin("/repo", "/repo-other/file.ts")).toBe(false);
	});

	it("resolves a missing target through its nearest canonical parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-")); roots.push(root);
		const resolver = new CanonicalPathResolver(broker, root);
		const result = await resolver.resolve("a/b/file.ts");
		expect(result).toMatchObject({ ok: true, value: { existing: false, canonicalPath: join(root, "a/b/file.ts") } });
	});

	it("detects a symlink-parent escape before creating a file", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-")); roots.push(root);
		const outside = await mkdtemp(join(tmpdir(), "runledger-outside-")); roots.push(outside);
		await symlink(outside, join(root, "escape"));
		const fs = new PolicyFileSystem(broker, root, snapshot(root));
		const result = await fs.writeFile("escape/secret.txt", "blocked");
		expect(result).toMatchObject({ ok: false, error: { code: "path_escape" } });
	});

	it("protects .git and .runledger even inside the write root", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-")); roots.push(root);
		await mkdir(join(root, ".git"));
		const resolver = new CanonicalPathResolver(broker, root);
		const target = await resolver.resolve(".git/config");
		expect(target.ok).toBe(true);
		if (!target.ok) return;
		expect(new FileAccessGuard(snapshot(root)).check("write", target.value)).toMatchObject({ ok: false, error: { code: "protected_path" } });
	});

	it("reads and writes through the broker without exposing raw handles", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-path-")); roots.push(root);
		const fs = new PolicyFileSystem(broker, root, snapshot(root));
		expect(await fs.writeFile("file.txt", "ok")).toEqual({ ok: true, value: undefined });
		const loaded = await fs.readFile("file.txt");
		expect(loaded.ok && loaded.value.toString("utf8")).toBe("ok");
	});
});
