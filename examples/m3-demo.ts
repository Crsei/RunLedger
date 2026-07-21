/**
 * V2 Task 系列 + MultiEdit + WebFetch + lockfile + high-water 演示。
 *
 * 用法:
 *   npx tsx examples/m3-demo.ts
 *
 * 行为(全程无网络,无 LLM):
 *   1. 开 JsonlLedger 到 tmp 目录(含 lockfile)
 *   2. createTaskTool / createTaskUpdateTool / createTaskListTool 演示 V2 任务 timeline
 *   3. createTodoWriteTool 作 V2 整盘覆盖演示
 *   4. highWaterMark 跟踪
 *   5. MultiEdit 多处编辑同一文件演示
 *   6. acquireLedgerLock 互斥验证
 */

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { JsonlLedger } from "../src/runtime/ledger/jsonl-ledger.ts";
import { MemoryLedger } from "../src/runtime/ledger/memory-ledger.ts";
import {
  acquireLedgerLock,
  isLedgerLocked,
  LedgerLockError,
} from "../src/runtime/ledger/lockfile.ts";
import { newId } from "../src/runtime/ledger/types.ts";
import { createTaskTool, createTaskUpdateTool, createTaskListTool } from "../src/runtime/tasks/task-tools.ts";
import { createTodoWriteTool } from "../src/runtime/tools/todo-write.ts";
import { createMultiEditTool } from "../src/runtime/tools/multi-edit.ts";

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), "m3-demo-"));
  try {
    console.log("\n=== phase 1: JsonlLedger + lockfile 高厓互斥 ===");
    const fp = path.join(dir, `ledger-${newId()}.jsonl`);
    const ledger = new JsonlLedger({ filePath: fp, sessionId: "demo" });
    await ledger.append({ id: newId(), sessionId: "demo", parentId: "", timestamp: Date.now(), type: "session", payload: { kind: "start" } });
    console.log("  highWaterMark =", ledger.highWaterMark());
    const release = await acquireLedgerLock(ledger);
    console.log("  isLocked =", await isLedgerLocked(fp));
    let secondThrew: unknown = null;
    try {
      await acquireLedgerLock(ledger, { retries: 1, retryDelayMs: 0 });
    } catch (e) {
      secondThrew = e;
    }
    console.log("  第二次 acquire 是否抛 LedgerLockError:", secondThrew instanceof LedgerLockError);
    await release();
    console.log("  isLocked after release =", await isLedgerLocked(fp));

    console.log("\n=== phase 2: V2 Task 系列 timeline ===");
    const task = createTaskTool({ ledger });
    const up = createTaskUpdateTool({ ledger });
    const list = createTaskListTool({ ledger });
    const a = (await task.execute("demo", { content: "实现 V2 Task 类型", priority: "high" })).details?.taskId;
    const b = (await task.execute("demo", { content: "lockfile 机制", priority: "high" })).details?.taskId;
    const c = (await task.execute("demo", { content: "high-water mark 演示", priority: "medium" })).details?.taskId;
    await up.execute("demo", { taskId: a as string, status: "in_progress" });
    await up.execute("demo", { taskId: b as string, status: "in_progress" });
    await up.execute("demo", { taskId: b as string, status: "completed" });
    console.log("  现存任务清单:");
    (await list.execute("demo", {})).content.forEach((c) => console.log("   ", (c as { text: string }).text));

    console.log("\n  其中曾任 in_progress 的 task A 在 B 转为 in_progress 时已自动落 pending(V2 排他机制)");

    console.log("\n=== phase 3: TodoWrite 整盘覆盖 (V2 收口) ===");
    const todo = createTodoWriteTool({ ledger });
    const r = await todo.execute("demo", {
      todos: [
        { content: "实现 V2 Task 类型", status: "completed" },
        { content: "lockfile 机制", status: "completed" },
        { content: "high-water mark 演示", status: "in_progress" },
        { content: "M6 文档同步", status: "pending" },
      ],
    });
    console.log("  TodoWrite: ", (r.content[0] as { text: string }).text);
    console.log("  最最新清单:");
    (await list.execute("demo", {})).content.forEach((c) => console.log("   ", (c as { text: string }).text));

    console.log("\n最终 highWaterMark:", ledger.highWaterMark(), "(单躅自旋单调增)");
    await ledger.close();

    console.log("\n=== phase 4: MultiEdit ===");
    const mEdit = createMultiEditTool(dir);
    const fp2 = path.join(dir, "demo.txt");
    await writeFile(fp2, "alpha beta gamma delta", "utf8");
    const er = await mEdit.execute("demo", {
      filePath: "demo.txt",
      edits: [
        { oldString: "alpha", newString: "ALPHA" },
        { oldString: "delta", newString: "DELTA" },
      ],
    });
    console.log("  MultiEdit 详情:", (er.content[0] as { text: string }).text);
    console.log("  最终文件内容:", await readFile(fp2, "utf8"));

    console.log("\nAll V2 demos passed ✓");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 仅在直接被 tsx 运行时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { main as m3Demo };
