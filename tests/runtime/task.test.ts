/**
 * V2 Task 系列单测 —— Task/TaskUpdate/TaskList 工具 + ledger 持久化重放。
 *
 * 覆盖:
 *   1. createTaskTool 写 ledger custom entry,返回带 taskId 的 text。
 *   2. TaskUpdate update 状态后,TaskList 重放出最新快照。
 *   3. TaskUpdate in_progress 排他机制:旧 in_progress 自动落 pending。
 *   4. TaskList 按 status / priority 过滤排序。
 *   5. TaskUpdate 参数都空 → throw。
 *   6. ledger 缺省(空 options)不抛,Task 提示创建,TaskList 报"无 ledger"。
 */

import { describe, expect, it } from "vitest";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import {
  createTaskTool,
  createTaskUpdateTool,
  createTaskListTool,
  replayTaskSnapshots,
} from "../../src/runtime/tasks/task-tools.ts";
import type { LedgerEntry } from "../../src/runtime/ledger/types.ts";

describe("V2 Task tools", () => {
  it("Task create 写 ledger custom entry,返回 taskId", async () => {
    const ledger = new MemoryLedger();
    const tool = createTaskTool({ ledger });
    const r = await tool.execute("tc", { content: "implement feature X", priority: "high" });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/Task created/);
    expect(text).toMatch(/priority: high/);
    expect(text).toMatch(/status: pending/);
    // taskId 形如 task-{8 字符}
    expect(r.details?.taskId).toMatch(/^task-/);
    // ledger 被写了一条 custom entry
    const entries = ledger.findByType("custom");
    expect(entries.length).toBe(1);
    const e = entries[0] as LedgerEntry;
    expect((e.payload as { kind: string }).kind).toBe("task");
    expect((e.payload as { content: string }).content).toBe("implement feature X");
  });

  it("TaskUpdate update 状态后,TaskList 重放最新状态", async () => {
    const ledger = new MemoryLedger();
    const taskTool = createTaskTool({ ledger });
    const upTool = createTaskUpdateTool({ ledger });
    const listTool = createTaskListTool({ ledger });
    const creation = await taskTool.execute("tc", { content: "do task A", priority: "medium" });
    const taskId = creation.details?.taskId as string;
    await upTool.execute("tc", { taskId, status: "in_progress" });
    await upTool.execute("tc", { taskId, status: "completed", content: "done A" });
    const r = await listTool.execute("tc", {});
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(taskId);
    expect(text).toContain("completed");
    expect(text).toContain("done A");
  });

  it("TaskUpdate in_progress 排他:旧 in_progress 自动落 pending", async () => {
    const ledger = new MemoryLedger();
    const taskTool = createTaskTool({ ledger });
    const upTool = createTaskUpdateTool({ ledger });
    const listTool = createTaskListTool({ ledger });
    const a = await taskTool.execute("tc", { content: "A", priority: "high" });
    const b = await taskTool.execute("tc", { content: "B", priority: "high" });
    await upTool.execute("tc", { taskId: a.details?.taskId as string, status: "in_progress" });
    await upTool.execute("tc", { taskId: b.details?.taskId as string, status: "in_progress" });
    const r = await listTool.execute("tc", { status: "in_progress" });
    const text = (r.content[0] as { text: string }).text;
    // B 是最新 in_progress;A 应该自动回退
    expect(text).toContain(b.details?.taskId as string);
    expect(text).not.toContain(a.details?.taskId as string);
    // 全量列表: A 现在是 pending
    const r2 = await listTool.execute("tc", {});
    const text2 = (r2.content[0] as { text: string }).text;
    expect(text2).toContain(a.details?.taskId as string);
    expect(text2).toMatch(/pending.*A|A.*pending/);
  });

  it("TaskList 按 priority 过滤", async () => {
    const ledger = new MemoryLedger();
    const taskTool = createTaskTool({ ledger });
    const listTool = createTaskListTool({ ledger });
    await taskTool.execute("tc", { content: "H", priority: "high" });
    await taskTool.execute("tc", { content: "M", priority: "medium" });
    await taskTool.execute("tc", { content: "L", priority: "low" });
    const r = await listTool.execute("tc", { priority: "high" });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("H");
    expect(text).not.toContain("M");
    expect(text).not.toContain("L");
  });

  it("TaskUpdate 全部参数空 → throw", async () => {
    const ledger = new MemoryLedger();
    const upTool = createTaskUpdateTool({ ledger });
    await expect(upTool.execute("tc", { taskId: "x" })).rejects.toThrow();
  });

  it("Task 无 ledger 也能 create(只不写盘)", async () => {
    const tool = createTaskTool();
    const r = await tool.execute("tc", { content: "orphan" });
    expect((r.content[0] as { text: string }).text).toMatch(/Task created/);
  });

  it("TaskList 无 ledger → 友好提示", async () => {
    const tool = createTaskListTool();
    const r = await tool.execute("tc", {});
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/无 ledger|无任务/);
  });

  it("replayTaskSnapshots 不识别 kind=non-task 的 entry", () => {
    const entries: LedgerEntry[] = [
      {
        id: "a",
        sessionId: "s",
        parentId: "",
        timestamp: 0,
        type: "custom",
        payload: { kind: "non-task" },
      },
    ];
    expect(replayTaskSnapshots(entries).length).toBe(0);
  });

  it("TaskUpdate 在 update 早于 create 的异常序下被丢弃", () => {
    const entries: LedgerEntry[] = [
      {
        id: "1",
        sessionId: "s",
        parentId: "",
        timestamp: 0,
        type: "custom",
        payload: { kind: "task_update", taskId: "X", status: "completed", updatedAt: 0 },
      },
    ];
    expect(replayTaskSnapshots(entries).length).toBe(0);
  });
});
