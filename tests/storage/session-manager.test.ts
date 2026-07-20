/**
 * SessionManager 单测 —— create / open / continueRecent / forkFrom / list。
 *
 * 用临时 cwd 与 sessionDir 隔离每个测试。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SessionManager, type SessionInfo } from "../../src/storage/session-manager.ts";
import type { LedgerHeader } from "../../src/runtime/ledger/types.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "rl-session-"));
}

function newlineCount(s: string): number {
  return s.split(/\r?\n/).length - 1;
}

function readFirstLine(path: string): LedgerHeader {
  const text = readFileSync(path, "utf8");
  const firstNewline = text.indexOf("\n");
  const first = firstNewline === -1 ? text : text.slice(0, firstNewline);
  return JSON.parse(first) as LedgerHeader;
}

describe("SessionManager.create", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("create 写文件并落地 LedgerHeader(含 metadata.cwd)", async () => {
    const mgr = await SessionManager.create({ cwd, sessionDir: cwd });
    const fp = mgr.filePath();
    expect(existsSync(fp)).toBe(true);
    const header = readFirstLine(fp);
    expect(header.type).toBe("ledger");
    expect(header.metadata?.cwd).toBe(cwd);
    expect(mgr.sessionDir()).toBe(cwd);
    await mgr.closeAll();
  });

  it("create 不指定 sessionDir 时落到 cwd 默认 .runledger/sessions/", async () => {
    const mgr = await SessionManager.create({ cwd });
    const fp = mgr.filePath();
    expect(fp).toContain(".runledger");
    expect(fp).toContain("sessions");
    await mgr.closeAll();
  });
});

describe("SessionManager.open", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("open 已存在文件,filePath / sessionDir 与源一致", async () => {
    // 先 create 一个会话,再 open
    const mgr1 = await SessionManager.create({ cwd, sessionDir: cwd });
    await mgr1.closeAll();
    const fp = mgr1.filePath();

    const mgr2 = await SessionManager.open(fp);
    expect(mgr2.filePath()).toBe(fp);
    expect(mgr2.sessionDir()).toBe(cwd);
    // 注:JsonlLedger 的 readonly sessionId 是构造时分配;open 文件已存在时,
    // _header.sessionId 会被 ensureInitialized 重写为文件 firstLine 的值,
    // 但 ensureInitialized 仅在 append/类似调用时触发。本期 SessionManager.open
    // 不预热 ledger(避免写入空 entry 污染源会话),hence mgr2.ledger().header()
    // 此时仍是构造态。后续用户 prompt() 时会触发 init,header 才正确。
    // 因此这里只断言 SessionManager 的 baggage,不查 ledger.header() 一致性。
    await mgr2.closeAll();
  });

  it("open 后第一次 append 确保 ledger 继承文件 header", async () => {
    const mgr1 = await SessionManager.create({ cwd, sessionDir: cwd });
    await mgr1.closeAll();
    const fp = mgr1.filePath();
    const expectedHeader = readFirstLine(fp);

    const mgr2 = await SessionManager.open(fp);
    // 触发 ensureInitialized —— append 会塞一条 entry 进文件
    await mgr2.ledger().append({
      id: "open-test",
      sessionId: "open-test",
      parentId: "open-test",
      timestamp: Date.now(),
      type: "custom",
      payload: { kind: "open-init-trigger" },
    });
    expect(mgr2.ledger().header().sessionId).toBe(expectedHeader.sessionId);
    await mgr2.closeAll();
  });

  it("open 不存在文件抛错", async () => {
    await expect(
      SessionManager.open(join(cwd, "does-not-exist.jsonl")),
    ).rejects.toThrow();
  });
});

describe("SessionManager.continueRecent", () => {
  let cwd: string;
  let sessionDir: string;

  beforeEach(() => {
    cwd = tmpDir();
    sessionDir = tmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("无任何会话时退化为新建", async () => {
    const mgr = await SessionManager.continueRecent(cwd, sessionDir);
    expect(existsSync(mgr.filePath())).toBe(true);
    await mgr.closeAll();
  });

  it("多个会话按 mtime 倒序取首条", async () => {
    // 假装有两个 session 文件,后一个 mtime 更新
    {
      const mgr = await SessionManager.create({ cwd, sessionDir });
      await mgr.closeAll();
    }
    // 稍稍 sleep 让 mtime 区分(Windows FAT/NTFS 精度未必 < 1ms,手动稍等)
    await new Promise<void>((r) => setTimeout(r, 30));
    let recentPath: string;
    {
      const mgr = await SessionManager.create({ cwd, sessionDir });
      recentPath = mgr.filePath();
      await mgr.closeAll();
    }

    const cont = await SessionManager.continueRecent(cwd, sessionDir);
    expect(cont.filePath()).toBe(recentPath);
    await cont.closeAll();
  });

  it("只取同 cwd 的会话,过滤掉其它 cwd 的", async () => {
    const otherCwd = tmpDir();
    try {
      const m1 = await SessionManager.create({ cwd, sessionDir });
      await m1.closeAll();
      // 把一个 fake header 写进同 dir,但 metadata.cwd 标记为 otherCwd
      const fakeHeader: LedgerHeader = {
        type: "ledger",
        version: 1,
        id: "fake-id",
        createdAt: Date.now() + 9999,
        sessionId: "fake-session",
        metadata: { cwd: otherCwd },
      };
      const fp = join(sessionDir, "fake-old.jsonl");
      writeFileSync(fp, JSON.stringify(fakeHeader) + "\n", "utf8");
      // 让 fake 的 mtime 比 m1 还新
      await new Promise<void>((r) => setTimeout(r, 30));

      const cont = await SessionManager.continueRecent(cwd, sessionDir);
      expect(cont.filePath()).not.toContain("fake-old.jsonl");
      await cont.closeAll();
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});

describe("SessionManager.forkFrom", () => {
  let cwd: string;
  let sessionDir: string;

  beforeEach(() => {
    cwd = tmpDir();
    sessionDir = tmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("forkFrom 复制全部内容,并在 metadata.parentSession 标记来源", async () => {
    const m1 = await SessionManager.create({ cwd, sessionDir });
    // 在源 ledger 写少量 entry
    const base = m1.ledger().header().id;
    await m1.ledger().append({
      id: "e1",
      sessionId: m1.sessionId(),
      parentId: base,
      timestamp: Date.now(),
      type: "custom",
      payload: { kind: "marker-before-fork" },
    });
    await m1.closeAll();
    const src = m1.filePath();

    const m2 = await SessionManager.forkFrom(src, cwd, sessionDir);
    const h = readFirstLine(m2.filePath());
    expect(h.metadata?.parentSession).toBe(src);
    expect(h.metadata?.cwd).toBe(cwd);
    // 至少 1 个 entry(因为 create 已经放了一个 placeholder,plus 1 主动 append)
    const text = readFileSync(m2.filePath(), "utf8");
    expect(newlineCount(text)).toBeGreaterThanOrEqual(2);
    await m2.closeAll();
  });

  it("forkFrom 源文件不存在抛错", async () => {
    await expect(
      SessionManager.forkFrom(join(cwd, "no.jsonl"), cwd, sessionDir),
    ).rejects.toThrow();
  });
});

describe("SessionManager.list", () => {
  let cwd: string;
  let sessionDir: string;

  beforeEach(() => {
    cwd = tmpDir();
    sessionDir = tmpDir();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("list 跳过损坏文件,正常文件入列出", async () => {
    const m = await SessionManager.create({ cwd, sessionDir });
    await m.closeAll();
    // 在同 dir 加损坏的 *.jsonl
    writeFileSync(join(sessionDir, "broken.jsonl"), "garbage-not-json", "utf8");
    const list = await SessionManager.list(cwd, sessionDir);
    expect(list.length).toBe(1);
    expect(list[0]!.filePath).toBe(m.filePath());
  });

  it("list 只列 header.metadata.cwd === cwd 的文件", async () => {
    const m = await SessionManager.create({ cwd, sessionDir });
    await m.closeAll();
    const otherCwd = tmpDir();
    try {
      // 旁路 create 不传 cwd 让别 dir;直接手写 fake header
      const fake: LedgerHeader = {
        type: "ledger",
        version: 1,
        id: "x",
        createdAt: Date.now(),
        sessionId: "x-sess",
        metadata: { cwd: otherCwd },
      };
      writeFileSync(
        join(sessionDir, "other.jsonl"),
        JSON.stringify(fake) + "\n",
        "utf8",
      );
      const list = await SessionManager.list(cwd, sessionDir);
      expect(list.length).toBe(1);
      expect(list[0]!.filePath).toBe(m.filePath());
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("list 目录不存在时返回空数组", async () => {
    const list = await SessionManager.list(cwd, join(sessionDir, "no-such"));
    expect(list).toEqual([] as SessionInfo[]);
  });
});
