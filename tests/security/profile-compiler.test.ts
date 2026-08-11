import { describe, expect, it } from "vitest";

describe("filesystem profile compiler", () => {
	it("materializes special paths and classifies deny-only globs", async () => {
		const compiler = await import("../../src/security/config/profile-compiler.ts").catch(() => undefined);
		const result = compiler?.compileFilesystemProfile({
			kind: "restricted",
			globScanMaxDepth: 3,
			entries: [
				{ path: ":root", access: "read" },
				{ path: ":workspace_roots/src", access: "write" },
				{ path: ":tmpdir", access: "write" },
				{ path: ":minimal", access: "read" },
				{ path: "/repo/**/.env", access: "deny" },
			],
		}, {
			platform: "linux",
			workspaceRoots: ["/repo", "/worktree"],
			tempRoot: "/var/tmp/runledger",
			minimalRoots: ["/home/user/.runledger", "/opt/node"],
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				policy: {
					kind: "restricted",
					globScanMaxDepth: 3,
					entries: expect.arrayContaining([
						{ path: { kind: "path", path: "/" }, access: "read" },
						{ path: { kind: "path", path: "/repo/src" }, access: "write" },
						{ path: { kind: "path", path: "/worktree/src" }, access: "write" },
						{ path: { kind: "path", path: "/var/tmp/runledger" }, access: "write" },
						{ path: { kind: "path", path: "/home/user/.runledger" }, access: "read" },
						{ path: { kind: "path", path: "/opt/node" }, access: "read" },
						{ path: { kind: "glob", pattern: "/repo/**/.env" }, access: "deny" },
					]),
				},
				warnings: [],
			},
		});
	});

	it("keeps unknown allow tokens forward-compatible but rejects unknown deny tokens", async () => {
		const { compileFilesystemProfile } = await import("../../src/security/config/profile-compiler.ts");
		const options = { platform: "linux" as const, workspaceRoots: ["/repo"], tempRoot: "/tmp", minimalRoots: ["/opt/node"] };
		const compatible = compileFilesystemProfile({
			kind: "restricted",
			entries: [{ path: ":future_runtime_root", access: "read" }],
		}, options);
		expect(compatible).toMatchObject({
			ok: true,
			value: { policy: { entries: [] }, warnings: [expect.stringContaining(":future_runtime_root")] },
		});
		expect(compileFilesystemProfile({
			kind: "restricted",
			entries: [{ path: ":future_runtime_root", access: "deny" }],
		}, options)).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});

	it("rejects unsafe scoped paths, unsupported allow globs, and invalid scan depths", async () => {
		const { compileFilesystemProfile } = await import("../../src/security/config/profile-compiler.ts");
		const options = { platform: "linux" as const, workspaceRoots: ["/repo"], tempRoot: "/tmp", minimalRoots: ["/opt/node"] };
		for (const source of [
			{ kind: "restricted" as const, entries: [{ path: ":workspace_roots/../escape", access: "write" as const }] },
			{ kind: "restricted" as const, entries: [{ path: "/repo/*/generated", access: "write" as const }] },
			{ kind: "restricted" as const, globScanMaxDepth: 0, entries: [] },
		]) {
			expect(compileFilesystemProfile(source, options)).toMatchObject({ ok: false, error: { code: "invalid_config" } });
		}
	});

	it("accepts trailing subtree notation for read/write and keeps slash tmp Linux-only", async () => {
		const { compileFilesystemProfile } = await import("../../src/security/config/profile-compiler.ts");
		const base = { workspaceRoots: ["/repo"], tempRoot: "/tmp/runledger", minimalRoots: ["/opt/node"] };
		expect(compileFilesystemProfile({
			kind: "restricted",
			entries: [{ path: "/repo/cache/**", access: "write" }],
		}, { ...base, platform: "linux" })).toMatchObject({
			ok: true,
			value: { policy: { entries: [{ path: { kind: "path", path: "/repo/cache" }, access: "write" }] } },
		});
		expect(compileFilesystemProfile({
			kind: "restricted",
			entries: [{ path: ":slash_tmp", access: "write" }],
		}, { ...base, platform: "macos" })).toMatchObject({ ok: false, error: { code: "invalid_config" } });
	});
});
