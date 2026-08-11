import { describe, expect, it } from "vitest";

describe("filesystem permission entries", () => {
	it("uses the most specific entry and deny wins an equal-target conflict", async () => {
		const filesystemEntries = await import("../../src/security/permission/filesystem-entries.ts").catch(() => undefined);
		const policy = {
			kind: "restricted" as const,
			entries: [
				{ path: { kind: "path" as const, path: "/repo" }, access: "write" as const },
				{ path: { kind: "path" as const, path: "/repo/docs" }, access: "read" as const },
				{ path: { kind: "path" as const, path: "/repo/docs/private" }, access: "write" as const },
				{ path: { kind: "path" as const, path: "/repo/docs/private" }, access: "deny" as const },
			],
		};

		expect(filesystemEntries?.resolveFilesystemAccess(policy, {
			path: "/repo/docs/private/file.txt",
			cwd: "/repo",
			platform: "linux",
		})).toBe("deny");
		expect(filesystemEntries?.resolveFilesystemAccess(policy, {
			path: "/repo/docs/guide.md",
			cwd: "/repo",
			platform: "linux",
		})).toBe("read");
		expect(filesystemEntries?.resolveFilesystemAccess(policy, {
			path: "/repo/src/index.ts",
			cwd: "/repo",
			platform: "linux",
		})).toBe("write");
	});

	it("fails closed when a compiled deny path is not absolute", async () => {
		const { resolveFilesystemAccess } = await import("../../src/security/permission/filesystem-entries.ts");
		const policy = {
			kind: "restricted" as const,
			entries: [
				{ path: { kind: "path" as const, path: "/repo" }, access: "write" as const },
				{ path: { kind: "path" as const, path: "private" }, access: "deny" as const },
			],
		};

		expect(resolveFilesystemAccess(policy, { path: "/repo/private/secret", cwd: "/repo", platform: "linux" })).toBe("deny");
	});
});
