/**
 * high-water mark 单测 —— LedgerSink.highWaterMark() 单调递增 + 跨重启继承。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import { JsonlLedger } from "../../src/runtime/ledger/jsonl-ledger.ts";
import { newId } from "../../src/runtime/ledger/types.ts";

describe("LedgerSink.highWaterMark", () => {
  it("MemoryLedger.highWaterMark 与 entries.length 单调增", async () => {
    const l = new MemoryLedger();
    expect(l.highWaterMark()).toBe(0);
    await l.append({
      id: newId(),
      sessionId: l.sessionId,
      parentId: "",
      timestamp: Date.now(),
      type: "message",
      payload: { text: "h" },
    });
    expect(l.highWaterMark()).toBe(1);
    await l.append({
      id: newId(),
      sessionId: l.sessionId,
      parentId: "",
      timestamp: Date.now(),
      type: "message",
      payload: { text: "i" },
    });
    expect(l.highWaterMark()).toBe(2);
  });

  it("JsonlLedger.highWaterMark 跨进程重启继承", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hwm-test-"));
    try {
      const fp = path.join(dir, `ledger-${newId()}.jsonl`);
      const l1 = new JsonlLedger({ filePath: fp, sessionId: "s1" });
      await l1.append({
        id: newId(),
        sessionId: "s1",
        parentId: "",
        timestamp: Date.now(),
        type: "message",
        payload: { text: "x" },
      });
      await l1.append({
        id: newId(),
        sessionId: "s1",
        parentId: "",
        timestamp: Date.now(),
        type: "message",
        payload: { text: "y" },
      });
      expect(l1.highWaterMark()).toBe(2);
      await l1.close();
      // 新进程在同一 file 上开 JsonlLedger
      const l2 = new JsonlLedger({ filePath: fp, sessionId: "s2" });
      // 触发 init → 加载已有 2 条
      await l2.append({
        id: newId(),
        sessionId: "s2",
        parentId: "",
        timestamp: Date.now(),
        type: "message",
        payload: { text: "z" },
      });
      // 2 已存(继承) + 1 新增 = 3
      expect(l2.highWaterMark()).toBe(3);
      await l2.close();
    } finally {
      // tmpdir cleanup
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("LedgerSink 接口里 highWaterMark 是可选的", () => {
    const l: import("../../src/runtime/ledger/types.ts").LedgerSink = new MemoryLedger();
    // 实现都已提供 highWaterMark(),但接口里 optional,下面调用的 optional chain 兜底。
    expect(l.highWaterMark?.() ?? 0).toBe(0);
  });
});
