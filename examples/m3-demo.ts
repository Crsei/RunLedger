/**
 * todo(op 模型)+ MultiEdit + lockfile + high-water 演示。
 *
 * 用法:
 *   npx tsx examples/m3-demo.ts
 *
 * 行为(全程无网络,无 LLM):
 *   1. 开 JsonlLedger 到 tmp 目录(含 lockfile)
 *   2. createTodoTool 演示相位任务表的 op 增量更新
 *   3. highWaterMark 跟踪
 *   4. MultiEdit 多处编辑同一文件演示
 *   5. acquireLedgerLock 互斥验证
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
import { createTodoTool } from "../src/runtime/tools/todo.ts";
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

    console.log("\n=== phase 2: todo op 模型 ===");
    const todo = createTodoTool({ ledger });
    const init = await todo.execute("demo", {
      op: "init",
      list: [
        { phase: "Task 系列", items: ["实现任务表", "lockfile 机制"] },
        { phase: "演示", items: ["high-water mark 演示", "M6 文档同步"] },
      ],
    });
    console.log("  todo init:");
    console.log((init.content[0] as { text: string }).text);
    const started = await todo.execute("demo", { op: "start", task: "lockfile 机制" });
    console.log("  todo start(指针移到 lockfile,原 in_progress 落回 pending):");
    console.log((started.content[0] as { text: string }).text);
    const done = await todo.execute("demo", { op: "done" });
    console.log("  todo done(未给 task/phase 时目标是全部任务,与参考实现一致):");
    console.log((done.content[0] as { text: string }).text);

    console.log("\n最终 highWaterMark:", ledger.highWaterMark(), "(单躅自旋单调增)");
    await ledger.close();

    console.log("\n=== phase 4: MultiEdit ===");
    const mEdit = createMultiEditTool(dir);
    const fp2 = path.join(dir, "demo.txt");
    await writeFile(fp2, "alpha beta gamma delta", "utf8");
    // 直接调 execute 需给规范字段;agent-loop 路径会先过 prepareArguments,
    // 因此 oldString/newString/replace_all 等外部命名同样可用。
    const er = await mEdit.execute("demo", {
      filePath: "demo.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "delta", newText: "DELTA" },
      ],
    });
    console.log("  MultiEdit 详情:", (er.content[0] as { text: string }).text);
    console.log("  最终文件内容:", await readFile(fp2, "utf8"));

    console.log("\nAll current-format demos passed ✓");
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
