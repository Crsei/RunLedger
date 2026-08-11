import { describe, expect, it } from "vitest";

describe("read deny matcher", () => {
	it("denies exact subtrees through lexical and canonical candidate spellings", async () => {
		const readDeny = await import("../../src/security/permission/read-deny-matcher.ts").catch(() => undefined);
		const policy = {
			kind: "restricted" as const,
			entries: [
				{ path: { kind: "path" as const, path: "/repo/private" }, access: "deny" as const },
			],
		};
		const matcher = readDeny?.createReadDenyMatcher(policy, { platform: "linux" });

		expect(matcher?.isReadDenied({ path: "/repo/public/link", cwd: "/repo", candidatePaths: ["/repo/private/secret.txt"] })).toBe(true);
		expect(matcher?.isReadDenied({ path: "/repo/private-notes.txt", cwd: "/repo" })).toBe(false);
	});

	it("matches deny globs at runtime and fails closed when a pattern is malformed", async () => {
		const readDeny = await import("../../src/security/permission/read-deny-matcher.ts");
		const globPolicy = {
			kind: "restricted" as const,
			entries: [
				{ path: { kind: "glob" as const, pattern: "/repo/**/.env" }, access: "deny" as const },
			],
		};
		const globMatcher = readDeny.createReadDenyMatcher(globPolicy, { platform: "linux" });
		expect(globMatcher?.isReadDenied({ path: "/repo/apps/api/.env", cwd: "/repo" })).toBe(true);
		expect(globMatcher?.isReadDenied({ path: "/repo/apps/api/.env.example", cwd: "/repo" })).toBe(false);

		const invalidPolicy = {
			kind: "restricted" as const,
			entries: [
				{ path: { kind: "glob" as const, pattern: "/repo/[z-a].env" }, access: "deny" as const },
			],
		};
		const failClosed = readDeny.createReadDenyMatcher(invalidPolicy, { platform: "linux" });
		expect(failClosed?.isReadDenied({ path: "/repo/public.txt", cwd: "/repo" })).toBe(true);
		expect(readDeny.tryCreateReadDenyMatcher?.(invalidPolicy, { platform: "linux" })).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});

	it("fails closed when an exact deny root is not absolute", async () => {
		const readDeny = await import("../../src/security/permission/read-deny-matcher.ts");
		const invalidPolicy = {
			kind: "restricted" as const,
			entries: [{ path: { kind: "path" as const, path: "private" }, access: "deny" as const }],
		};

		expect(readDeny.createReadDenyMatcher(invalidPolicy, { platform: "linux" })?.isReadDenied({ path: "/repo/public", cwd: "/repo" })).toBe(true);
		expect(readDeny.tryCreateReadDenyMatcher(invalidPolicy, { platform: "linux" })).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});
});
