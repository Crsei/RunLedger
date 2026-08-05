/** 纯 WorkspacePathAdapter 测试：三平台 path parsing/compare/containment/locator（P3 RED fixtures）。 */

import { describe, expect, it } from "vitest";
import { ancestorCandidates, containmentCheck, decodePrivateLocator, encodePrivateLocator, identityFromLocator, parsePath, parseRoot, validateLocatorForPlatform } from "../../src/workspace/path-adapter.ts";

describe("parseRoot: root/volume/share identity (ADR D3)", () => {
	it.each(["linux", "macos"] as const)("classifies POSIX absolute paths on %s", (platform) => {
		expect(parseRoot("/repo/app", platform)).toEqual({ ok: true, value: { kind: "posix", display: "/", key: "/", remainder: "repo/app" } });
		expect(parseRoot("/", platform)).toEqual({ ok: true, value: { kind: "posix", display: "/", key: "/", remainder: "" } });
	});

	it("rejects relative and non-absolute POSIX input", () => {
		expect(parseRoot("repo/app", "linux")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
		expect(parseRoot("../repo", "linux")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});

	it("classifies Windows drive and UNC roots case-preserved", () => {
		expect(parseRoot("C:\\repo\\app", "windows")).toEqual({ ok: true, value: { kind: "drive", display: "C:", key: "c:", remainder: "repo\\app" } });
		expect(parseRoot("c:\\REPO", "windows")).toEqual({ ok: true, value: { kind: "drive", display: "c:", key: "c:", remainder: "REPO" } });
		expect(parseRoot("\\\\server\\share\\x", "windows")).toEqual({ ok: true, value: { kind: "unc", display: "\\\\server\\share", key: "\\\\server\\share", remainder: "x" } });
		expect(parseRoot("\\\\SERVER\\Share\\x", "windows")).toEqual({ ok: true, value: { kind: "unc", display: "\\\\SERVER\\Share", key: "\\\\server\\share", remainder: "x" } });
	});

	it("accepts forward slashes as Windows separators", () => {
		expect(parseRoot("C:/repo/app", "windows")).toEqual({ ok: true, value: { kind: "drive", display: "C:", key: "c:", remainder: "repo\\app" } });
	});

	it("classifies device/long-path namespaces as unsupported_root", () => {
		expect(parseRoot("\\\\?\\C:\\device", "windows")).toMatchObject({ ok: false, error: { code: "unsupported_root" } });
		expect(parseRoot("\\\\.\\pipe\\x", "windows")).toMatchObject({ ok: false, error: { code: "unsupported_root" } });
	});

	it("rejects root-relative and drive-relative Windows input", () => {
		expect(parseRoot("\\repo", "windows")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
		expect(parseRoot("C:repo", "windows")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
		expect(parseRoot("\\\\server", "windows")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});
});

describe("parsePath: display path preserves case, compare key normalizes (ADR D1)", () => {
	it("keeps POSIX display and compare identical", () => {
		const parsed = parsePath("/repo/App/Dir", "linux");
		expect(parsed).toEqual({ ok: true, value: { root: { kind: "posix", display: "/", key: "/" }, displayPath: "/repo/App/Dir", compareKey: "/repo/App/Dir", absolute: true } });
	});

	it("keeps Windows display case but folds the compare key", () => {
		const parsed = parsePath("C:\\Repo\\App\\Dir", "windows");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.displayPath).toBe("C:\\Repo\\App\\Dir");
		expect(parsed.value.compareKey).toBe("c:\\repo\\app\\dir");
	});

	it("lexically normalizes dot segments without realpath", () => {
		const parsed = parsePath("/repo/a/../b", "linux");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value.displayPath).toBe("/repo/b");
	});
});

describe("containment: structured segment compare (ADR D3, no string startsWith)", () => {
	it.each(["linux", "macos"] as const)("contains child under parent on %s", (platform) => {
		const parent = parsePath("/repo", platform);
		const child = parsePath("/repo/app/main.ts", platform);
		const root = parsePath("/", platform);
		expect(parent.ok && child.ok && root.ok).toBe(true);
		if (!parent.ok || !child.ok || !root.ok) return;
		expect(containmentCheck(parent.value, child.value, platform)).toEqual({ ok: true, value: "inside" });
		expect(containmentCheck(root.value, child.value, platform)).toEqual({ ok: true, value: "inside" });
		expect(containmentCheck(parent.value, parent.value, platform)).toEqual({ ok: true, value: "inside" });
	});

	it("rejects prefix confusion like /repo vs /repo-other", () => {
		const parent = parsePath("/repo", "linux");
		const sibling = parsePath("/repo-other/app", "linux");
		expect(parent.ok && sibling.ok).toBe(true);
		if (!parent.ok || !sibling.ok) return;
		expect(containmentCheck(parent.value, sibling.value, "linux")).toEqual({ ok: true, value: "outside" });
	});

	it("rejects child shorter than parent and non-prefix segments", () => {
		const parent = parsePath("/repo/app", "linux");
		const child = parsePath("/repo", "linux");
		const other = parsePath("/repo/app-other", "linux");
		expect(parent.ok && child.ok && other.ok).toBe(true);
		if (!parent.ok || !child.ok || !other.ok) return;
		expect(containmentCheck(parent.value, child.value, "linux")).toEqual({ ok: true, value: "outside" });
		expect(containmentCheck(parent.value, other.value, "linux")).toEqual({ ok: true, value: "outside" });
	});

	it("folds Windows segment case in containment", () => {
		const parent = parsePath("C:\\Repo", "windows");
		const child = parsePath("C:\\repo\\App\\main.ts", "windows");
		expect(parent.ok && child.ok).toBe(true);
		if (!parent.ok || !child.ok) return;
		expect(containmentCheck(parent.value, child.value, "windows")).toEqual({ ok: true, value: "inside" });
	});

	it("reports cross_root for different drive letters and UNC shares", () => {
		const a = parsePath("C:\\repo", "windows");
		const b = parsePath("D:\\repo", "windows");
		const uncA = parsePath("\\\\srv1\\share\\repo", "windows");
		const uncB = parsePath("\\\\srv1\\other\\repo", "windows");
		expect(a.ok && b.ok && uncA.ok && uncB.ok).toBe(true);
		if (!a.ok || !b.ok || !uncA.ok || !uncB.ok) return;
		expect(containmentCheck(a.value, b.value, "windows")).toEqual({ ok: true, value: "cross_root" });
		expect(containmentCheck(uncA.value, uncB.value, "windows")).toEqual({ ok: true, value: "cross_root" });
	});

	it("matches UNC share identity case-insensitively", () => {
		const parent = parsePath("\\\\SERVER\\Share\\repo", "windows");
		const child = parsePath("\\\\server\\share\\repo\\app", "windows");
		expect(parent.ok && child.ok).toBe(true);
		if (!parent.ok || !child.ok) return;
		expect(containmentCheck(parent.value, child.value, "windows")).toEqual({ ok: true, value: "inside" });
	});

	it("rejects POSIX-vs-drive cross comparison", () => {
		const posix = parsePath("/repo", "linux");
		const drive = parsePath("C:\\repo", "windows");
		expect(posix.ok && drive.ok).toBe(true);
		if (!posix.ok || !drive.ok) return;
		expect(containmentCheck(posix.value, drive.value, "linux")).toEqual({ ok: true, value: "cross_root" });
	});
});

describe("locator: versioned private locator (ADR D4)", () => {
	it("round-trips encode/decode and restores the same identity", () => {
		const parsed = parsePath("/repo/app", "linux");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const locator = encodePrivateLocator(parsed.value, "linux");
		expect(locator).toEqual({ version: 1, platform: "linux", kind: "posix", path: "/repo/app" });
		const decoded = decodePrivateLocator(JSON.stringify(locator));
		expect(decoded).toEqual({ ok: true, value: locator });
		const restored = decoded.ok ? identityFromLocator(decoded.value) : decoded;
		expect(restored).toEqual(parsed);
	});

	it("rejects unversioned or unsupported-version records as migration_required", () => {
		expect(decodePrivateLocator('{"platform":"linux","kind":"posix","path":"/x"}')).toMatchObject({ ok: false, error: { code: "migration_required" } });
		expect(decodePrivateLocator('{"version":2,"platform":"linux","kind":"posix","path":"/x"}')).toMatchObject({ ok: false, error: { code: "migration_required" } });
		expect(decodePrivateLocator("not json")).toMatchObject({ ok: false, error: { code: "migration_required" } });
		expect(decodePrivateLocator('{"version":1,"platform":"freebsd","kind":"posix","path":"/x"}')).toMatchObject({ ok: false, error: { code: "migration_required" } });
	});

	it("fails closed on platform mismatch without guessing conversion", () => {
		const parsed = parsePath("/repo", "linux");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const locator = encodePrivateLocator(parsed.value, "linux");
		expect(validateLocatorForPlatform(locator, "windows")).toMatchObject({ ok: false, error: { code: "platform_mismatch" } });
		expect(validateLocatorForPlatform(locator, "linux")).toEqual({ ok: true, value: locator });
	});

	it("rejects kind/platform inconsistency", () => {
		expect(validateLocatorForPlatform({ version: 1, platform: "windows", kind: "posix", path: "/x" }, "windows")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
		expect(validateLocatorForPlatform({ version: 1, platform: "linux", kind: "drive", path: "C:\\x" }, "linux")).toMatchObject({ ok: false, error: { code: "invalid_path" } });
	});
});

describe("ancestorCandidates: ordered nearest-to-farthest ancestors for candidate paths", () => {
	it("walks POSIX ancestors down to the root", () => {
		const parsed = parsePath("/repo/app/main.ts", "linux");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(ancestorCandidates(parsed.value, "linux")).toEqual(["/repo/app", "/repo", "/"]);
	});

	it("walks Windows ancestors preserving display case", () => {
		const parsed = parsePath("C:\\Repo\\App\\Dir", "windows");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(ancestorCandidates(parsed.value, "windows")).toEqual(["C:\\Repo\\App", "C:\\Repo", "C:"]);
	});

	it("walks UNC ancestors down to the share root", () => {
		const parsed = parsePath("\\\\server\\share\\a\\b", "windows");
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(ancestorCandidates(parsed.value, "windows")).toEqual(["\\\\server\\share\\a", "\\\\server\\share"]);
	});
});
