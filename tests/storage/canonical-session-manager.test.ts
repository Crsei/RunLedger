import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CAN_ASSERT_FILE_MODE, canCreateSymlink } from "../helpers/platform.ts";
import { buildRunledgerLayout, isContainedRuntimePath, type RunledgerLayout } from "../../src/runtime/contracts/public.ts";
import { SessionManager } from "../../src/storage/session-manager.ts";

const CAN_SYMLINK = canCreateSymlink();

const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { cwd: string; layout: RunledgerLayout } {
	const cwd = mkdtempSync(join(tmpdir(), "runledger-canonical-session-"));
	cleanup.push(cwd);
	return { cwd, layout: buildRunledgerLayout(join(cwd, "home"), "posix") };
}

describe("canonical SessionManager", () => {
	it("create 只写入 home 内 UTC shard，文件权限为 0600", async () => {
		const { cwd, layout } = fixture();
		const manager = await SessionManager.create({ layout, cwd, sessionId: "session_fixture" });
		const filePath = manager.filePath();

		expect(relative(layout.sessions, filePath).replaceAll("\\", "/")).toMatch(/^\d{4}\/\d{2}\/\d{2}\/session_fixture\.jsonl$/u);
		expect(isContainedRuntimePath(layout.home, filePath, "posix")).toBe(true);
		expect(lstatSync(filePath).isSymbolicLink()).toBe(false);
		if (CAN_ASSERT_FILE_MODE) expect(statSync(filePath).mode & 0o777).toBe(0o600);
		await manager.closeAll();
	});

	it("拒绝根外 open，且不读取或修改 source", async () => {
		const { cwd, layout } = fixture();
		const outside = join(cwd, "outside.jsonl");
		const original = "legacy bytes\n";
		await writeFile(outside, original, "utf8");

		await expect(SessionManager.open(layout, outside)).rejects.toThrow(/outside|contained|canonical/u);
		expect(readFileSync(outside, "utf8")).toBe(original);
	});

	it("拒绝 home 内指向根外的 symlink session root", { skip: !CAN_SYMLINK }, async () => {
		const { cwd, layout } = fixture();
		const outside = join(cwd, "outside-sessions");
		const sessionsLink = layout.sessions;
		await mkdir(outside, { recursive: true });
		await mkdir(layout.home, { recursive: true });
		symlinkSync(outside, sessionsLink, "dir");

		await expect(SessionManager.create({ layout, cwd })).rejects.toThrow(/symlink|contained|canonical/u);
		expect(existsSync(join(outside, "2026"))).toBe(false);
	});

	it("list 与 continueRecent 只遍历 canonical sessions shard", async () => {
		const { cwd, layout } = fixture();
		const first = await SessionManager.create({ layout, cwd, sessionId: "session_first" });
		const firstPath = first.filePath();
		await first.closeAll();
		const recent = await SessionManager.continueRecent(layout, cwd);
		expect(recent.filePath()).toBe(firstPath);
		expect((await SessionManager.list(layout, cwd)).map((entry) => entry.filePath)).toContain(firstPath);
		await recent.closeAll();
	});
});
