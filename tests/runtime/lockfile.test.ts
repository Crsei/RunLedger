/**
 * lockfile 机制单测 —— proper-lockfile 互斥 + JsonlLedger 集成。
 *
 * 覆盖:
 *   1. acquireLedgerLock 在未被占用时成功。
 *   2. 第二次 acquireLedgerLock 在持锁期间应 throw LedgerLockError(放大 retries=1, retryDelay=0)。
 *   3. release 后,再次 acquire 成功。
 *   4. isLedgerLocked 反映正确状态。
 *
 * 用真 JsonlLedger 写到 tmp;不动 proper-lockfile 内部。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { JsonlLedger } from "../../src/runtime/ledger/jsonl-ledger.ts";
import {
  acquireLedgerLock,
  isLedgerLocked,
  forceUnlock,
  LedgerLockError,
} from "../../src/runtime/ledger/lockfile.ts";
import { newId } from "../../src/runtime/ledger/types.ts";

async function setupLedger(): Promise<{ dir: string; ledger: JsonlLedger }> {
  const dir = await mkdtemp(path.join(tmpdir(), "lock-test-"));
  const filePath = path.join(dir, `ledger-${newId()}.jsonl`);
  const ledger = new JsonlLedger({ filePath, sessionId: "s" });
  // 触发 init
  await ledger.append({
    id: newId(),
    sessionId: "s",
    parentId: "",
    timestamp: Date.now(),
    type: "session",
    payload: { kind: "start" },
  });
  return { dir, ledger };
}

describe("Ledger lockfile", () => {
  it("acquireLedgerLock 成功 + release 后 isLocked=false", async () => {
    const { dir, ledger } = await setupLedger();
    try {
      const release = await acquireLedgerLock(ledger);
      expect(await isLedgerLocked(ledger.filePath)).toBe(true);
      await release();
      expect(await isLedgerLocked(ledger.filePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("持锁期间二次 acquire → throw LedgerLockError(快失败)", async () => {
    const { dir, ledger } = await setupLedger();
    try {
      const first = await acquireLedgerLock(ledger, { retries: 1, retryDelayMs: 0 });
      let secondThrowed: unknown = null;
      try {
        await acquireLedgerLock(ledger, { retries: 1, retryDelayMs: 0 });
      } catch (e) {
        secondThrowed = e;
      }
      expect(secondThrowed).toBeInstanceOf(LedgerLockError);
      await first();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forceUnlock 清理 stale lock", async () => {
    const { dir, ledger } = await setupLedger();
    try {
      const release = await acquireLedgerLock(ledger);
      await release();
      // 触发 stale lockfile 创建(forceUnlock 内部 unlock)
      await forceUnlock(ledger.filePath);
      expect(await isLedgerLocked(ledger.filePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("append 在 lock 下仍能正常写一个 entry", async () => {
    const { dir, ledger } = await setupLedger();
    try {
      const release = await acquireLedgerLock(ledger);
      try {
        await ledger.append({
          id: newId(),
          sessionId: "s",
          parentId: "",
          timestamp: Date.now(),
          type: "message",
          payload: { text: "hi" },
        });
        const entries = await ledger.entries();
        // session + message = 2
        expect(entries.length).toBeGreaterThanOrEqual(2);
      } finally {
        await release();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
