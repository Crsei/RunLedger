/** 纯 porcelain parser 测试：真实 Linux runner fixture + 三平台合成 fixture（P3，不调用真实 Git）。 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorktreePorcelain, unquoteCStyle } from "../../src/workspace/git-porcelain.ts";

const evidenceRaw = resolve("tests/fixtures/platform-evidence/linux/raw");
const syntheticRaw = resolve("tests/fixtures/workspace/git-porcelain");

function fixtureContent(file: string): string {
	return readFileSync(join(evidenceRaw, file), "utf8").replace(/\r\n/g, "\n");
}

function syntheticContent(file: string): string {
	return readFileSync(join(syntheticRaw, file), "utf8").replace(/\r\n/g, "\n");
}

describe("parseWorktreePorcelain against the real Linux runner fixture (P1 evidence)", () => {
	it("parses create/list porcelain with detached entry without losing paths", () => {
		const entries = parseWorktreePorcelain(fixtureContent("git-worktree-list-porcelain.txt"));
		expect(entries).toHaveLength(2);
		const [main, detached] = entries as [typeof entries[number], typeof entries[number]];
		expect(main.path.startsWith("/tmp/runledger-platform-evidence-")).toBe(true);
		expect(main.branch).toBe("master");
		expect(main.detached).toBe(false);
		expect(detached.path.endsWith("managed/repo-slug/task")).toBe(true);
		expect(detached.detached).toBe(true);
		expect(detached.head).toMatch(/^[a-f0-9]{40}$/u);
	});

	it("parses the bare marker from a real bare-repo porcelain listing", () => {
		const entries = parseWorktreePorcelain(fixtureContent("git-bare-worktree-list-porcelain.txt"));
		expect(entries).toHaveLength(1);
		expect(entries[0]?.bare).toBe(true);
		expect(entries[0]?.path.endsWith("bare.git")).toBe(true);
	});

	it("parses the locked marker from the real locked listing", () => {
		const text = fixtureContent("git-worktree-locked-remove.txt");
		const listing = text.slice(text.indexOf("--- list ---") + "--- list ---".length);
		const entries = parseWorktreePorcelain(listing);
		const locked = entries.find((entry) => entry.path.includes("task-locked"));
		expect(locked).toBeDefined();
		expect(locked?.locked).toBe(true);
		expect(locked?.detached).toBe(true);
	});
});

describe("parseWorktreePorcelain: synthetic cross-platform fixtures", () => {
	it("parses a Windows drive path preserving case", () => {
		const entries = parseWorktreePorcelain(syntheticContent("synthetic-windows-drive.txt"));
		expect(entries[0]).toMatchObject({ path: "C:\\runledger-state\\managed\\repo-one\\task-workspace-one", branch: "feature/x" });
	});

	it("parses an UNC path containing spaces verbatim", () => {
		const entries = parseWorktreePorcelain(syntheticContent("synthetic-unc-spaces.txt"));
		expect(entries[0]).toMatchObject({ path: "\\\\server\\share\\managed root\\repo\\task", detached: true });
	});

	it("unquotes C-style quoted paths and keeps the locked marker", () => {
		const entries = parseWorktreePorcelain(syntheticContent("synthetic-quoted.txt"));
		expect(entries[0]).toMatchObject({ path: "/tmp/managed root/repo/task with space", locked: true });
	});

	it("parses a bare-only record", () => {
		const entries = parseWorktreePorcelain(syntheticContent("synthetic-bare.txt"));
		expect(entries[0]).toMatchObject({ path: "C:\\repos\\bare.git", bare: true });
	});

	it("decodes git's octal UTF-8 escapes for non-ASCII paths", () => {
		const entries = parseWorktreePorcelain(syntheticContent("synthetic-octal-utf8.txt"));
		expect(entries[0]).toMatchObject({ path: "/tmp/runledger-试验/task 测试", detached: true });
	});
});

describe("unquoteCStyle", () => {
	it("leaves plain paths untouched", () => {
		expect(unquoteCStyle("/repo/task")).toBe("/repo/task");
	});

	it("decodes common C escapes", () => {
		expect(unquoteCStyle("\"/tmp/a b\"")).toBe("/tmp/a b");
		expect(unquoteCStyle("\"a\\tb\"")).toBe("a\tb");
		expect(unquoteCStyle("\"a\\\"b\"")).toBe("a\"b");
		expect(unquoteCStyle("\"a\\\\b\"")).toBe("a\\b");
	});

	it("decodes git octal UTF-8 escapes byte-wise", () => {
		expect(unquoteCStyle("\"/tmp/runledger-\\350\\257\\225\\351\\252\\214\"")).toBe("/tmp/runledger-试验");
		expect(unquoteCStyle("\"\\346\\265\\213\\350\\257\\225\"")).toBe("测试");
		expect(unquoteCStyle("\"a\\0b\"")).toBe("a\u0000b");
	});
});
