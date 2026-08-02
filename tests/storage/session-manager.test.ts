/** SessionManager 单测 —— canonical layout / create / open / continue / fork / list。 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/public.ts";
import type { LedgerHeader } from "../../src/runtime/ledger/types.ts";
import { SessionManager, type SessionInfo } from "../../src/storage/session-manager.ts";

function tmpDir(): string {
	return mkdtempSync(join(tmpdir(), "rl-session-"));
}

function readFirstLine(filePath: string): LedgerHeader {
	const text = readFileSync(filePath, "utf8");
	const firstNewline = text.indexOf("\n");
	return JSON.parse(firstNewline === -1 ? text : text.slice(0, firstNewline)) as LedgerHeader;
}

function fixture(): { cwd: string; layout: RunledgerLayout } {
	const cwd = tmpDir();
	return { cwd, layout: buildRunledgerLayout(join(cwd, "home"), "posix") };
}

describe("SessionManager.create", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => ({ cwd, layout } = fixture()));
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("create 写 canonical UTC shard 与 LedgerHeader(metadata.cwd)", async () => {
		const manager = await SessionManager.create({ layout, cwd, sessionId: "session_fixture" });
		const filePath = manager.filePath();
		expect(relative(layout.sessions, filePath)).toMatch(/^\d{4}\/\d{2}\/\d{2}\/session_fixture\.jsonl$/u);
		expect(existsSync(filePath)).toBe(true);
		expect(readFirstLine(filePath).metadata?.cwd).toBe(cwd);
		expect(manager.sessionDir()).toBe(layout.sessions);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		await manager.closeAll();
	});

	it("create 不依赖 cwd 下 .runledger", async () => {
		const manager = await SessionManager.create({ layout, cwd });
		expect(manager.filePath()).toContain("/home/sessions/");
		expect(existsSync(join(cwd, ".runledger"))).toBe(false);
		await manager.closeAll();
	});
});

describe("SessionManager.open", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => ({ cwd, layout } = fixture()));
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("open 已存在 canonical file,filePath / sessionDir 与 layout 一致", async () => {
		const first = await SessionManager.create({ layout, cwd });
		await first.closeAll();
		const reopened = await SessionManager.open(layout, first.filePath());
		expect(reopened.filePath()).toBe(first.filePath());
		expect(reopened.sessionDir()).toBe(layout.sessions);
		await reopened.closeAll();
	});

	it("open 后 append 继承源 header", async () => {
		const first = await SessionManager.create({ layout, cwd });
		await first.closeAll();
		const expectedHeader = readFirstLine(first.filePath());
		const reopened = await SessionManager.open(layout, first.filePath());
		await reopened.ledger().append({
			id: "open-test",
			sessionId: "open-test",
			parentId: "open-test",
			timestamp: Date.now(),
			type: "custom",
			payload: { kind: "open-init-trigger" },
		});
		expect(reopened.ledger().header().sessionId).toBe(expectedHeader.sessionId);
		await reopened.closeAll();
	});

	it("open 根外文件抛 canonical boundary error", async () => {
		const outside = join(cwd, "outside.jsonl");
		writeFileSync(outside, "legacy bytes\n", "utf8");
		await expect(SessionManager.open(layout, outside)).rejects.toThrow(/outside|contained|canonical/u);
	});
});

describe("SessionManager.continueRecent", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => ({ cwd, layout } = fixture()));
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("无任何会话时在 canonical root 新建", async () => {
		const manager = await SessionManager.continueRecent(layout, cwd);
		expect(manager.filePath()).toContain("/home/sessions/");
		await manager.closeAll();
	});

	it("多个 canonical sessions 按 mtime 取最近", async () => {
		const first = await SessionManager.create({ layout, cwd, sessionId: "session_first" });
		await first.closeAll();
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
		const second = await SessionManager.create({ layout, cwd, sessionId: "session_second" });
		await second.closeAll();

		const recent = await SessionManager.continueRecent(layout, cwd);
		expect(recent.filePath()).toBe(second.filePath());
		await recent.closeAll();
	});

	it("只取 metadata.cwd 匹配的 canonical session", async () => {
		const manager = await SessionManager.create({ layout, cwd, sessionId: "session_current" });
		await manager.closeAll();
		const shardDir = join(layout.sessions, "2026", "08", "02");
		mkdirSync(shardDir, { recursive: true });
		const fake: LedgerHeader = {
			type: "ledger",
			id: "fake-id",
			createdAt: Date.now() + 9999,
			sessionId: "fake-session",
			metadata: { cwd: join(cwd, "other") },
		};
		writeFileSync(join(shardDir, "fake-old.jsonl"), JSON.stringify(fake) + "\n", "utf8");

		const recent = await SessionManager.continueRecent(layout, cwd);
		expect(recent.filePath()).toBe(manager.filePath());
		await recent.closeAll();
	});
});

describe("SessionManager.forkFrom", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => ({ cwd, layout } = fixture()));
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("fork 生成新 ID，保留 parent session locator 且不写绝对源路径", async () => {
		const source = await SessionManager.create({ layout, cwd, sessionId: "session_source" });
		await source.ledger().append({
			id: "source-entry",
			sessionId: source.sessionId(),
			parentId: source.ledger().header().id,
			timestamp: Date.now(),
			type: "custom",
			payload: { kind: "fixture" },
		});
		const sourceId = source.sessionId();
		const sourcePath = source.filePath();
		await source.closeAll();

		const fork = await SessionManager.forkFrom(layout, sourcePath, cwd);
		const header = readFirstLine(fork.filePath());
		expect(fork.sessionId()).not.toBe(sourceId);
		expect(header.metadata).toMatchObject({
			parentSession: relative(layout.home, sourcePath).replaceAll("\\", "/"),
			parentSessionId: sourceId,
			cwd,
		});
		expect(String(header.metadata?.parentSession)).not.toBe(sourcePath);
		await fork.closeAll();
	});

	it("fork 源不存在抛错", async () => {
		await expect(SessionManager.forkFrom(layout, join(layout.sessions, "missing.jsonl"), cwd)).rejects.toThrow();
	});
});

describe("SessionManager.list", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => ({ cwd, layout } = fixture()));
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));

	it("list 跳过损坏文件", async () => {
		const manager = await SessionManager.create({ layout, cwd, sessionId: "session_valid" });
		await manager.closeAll();
		writeFileSync(join(layout.sessions, "2026", "08", "02", "broken.jsonl"), "garbage-not-json", "utf8");
		const list = await SessionManager.list(layout, cwd);
		expect(list.length).toBe(1);
		expect(list[0]!.filePath).toBe(manager.filePath());
	});

	it("list 只列 header.metadata.cwd 匹配的文件", async () => {
		const manager = await SessionManager.create({ layout, cwd, sessionId: "session_current" });
		await manager.closeAll();
		const shard = join(layout.sessions, "2026", "08", "02");
		mkdirSync(shard, { recursive: true });
		writeFileSync(
			join(shard, "other.jsonl"),
			JSON.stringify({ type: "ledger", id: "x", createdAt: Date.now(), sessionId: "x-sess", metadata: { cwd: join(cwd, "other") } }) + "\n",
			"utf8",
		);
		const list = await SessionManager.list(layout, cwd);
		expect(list.length).toBe(1);
		expect(list[0]!.filePath).toBe(manager.filePath());
	});

	it("canonical sessions 目录不存在时返回空数组", async () => {
		expect(await SessionManager.list(layout, cwd)).toEqual([] as SessionInfo[]);
	});
});
