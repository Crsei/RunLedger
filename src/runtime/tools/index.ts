/**
 * 内置标准工具集 —— stdlib namespace。
 *
 * pi 的对应文件是 `core/tools/index.ts`。RunLedger 保留 cwd 闭包供 legacy 直接
 * 调用；受治理执行必须通过 execute 的 ToolContext 注入 ExecutionEnv 与 cwd。
 *
 * 工具集(对齐 pi):
 *   - read  : 读文件,行/字节截断 + cat -n 行号 + mtime 去重缓存
 *   - write : 写文件,递归建目录
 *   - edit  : 多块 oldText → newText + replaceAll + findActualString
 *   - bash  : shell 执行,stdout/stderr 截断 + run_in_background + stdin + output_format
 *   - grep  : ripgrep / grep 查找 + afterContext + beforeContext + multiline + outputFormat
 *   - find  : fd / find glob
 *   - glob  : 第一方手写 ** 递归(无外部依赖)
 *   - ls    : 列目录
 *
 * 兼容:echo.ts 中 demo echo tool 也归入 stdlib namespace,但走自己的
 * `name: "echo"`,不与上面冲突。
 */

import type { AgentTool } from "../types.ts";
import { createToolRegistry, type ToolRegistry } from "../tool-registry.ts";
import { echoTool } from "./echo.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";
import { createEditTool } from "./edit.ts";
import { createMultiEditTool } from "./multi-edit.ts";
import { createBashTool } from "./bash.ts";
import { createGrepTool } from "./grep.ts";
import { createFindTool } from "./find.ts";
import { createGlobTool } from "./glob.ts";
import { createLsTool } from "./ls.ts";
import { createTodoWriteTool } from "./todo-write.ts";
import { createWebFetchTool } from "./web-fetch.ts";
import { createNotebookEditTool } from "./notebook-edit.ts";

/**
 * 一站式构造标准库工具集。返回 ToolRegistry,namespace="stdlib"。
 *
 * 已迁移的 I/O 工具必须声明 governedExecution="tool-context"；其余工具在迁移
 * 前保持未声明，Gateway 会 fail closed，不能被误当成受治理实现。
 */
export function createStdlibTools(cwd: string = process.cwd()): ToolRegistry {
  const r = createToolRegistry([], { namespace: "stdlib" });
  const registerGoverned = (tool: AgentTool): void => {
    if (tool.governedExecution !== "tool-context") {
      throw new Error(`stdlib tool ${tool.name} is missing ToolContext governance metadata`);
    }
    r.register(tool, { namespace: "stdlib" });
  };
  registerGoverned(createReadTool(cwd));
  registerGoverned(createWriteTool(cwd));
  registerGoverned(createEditTool(cwd));
  registerGoverned(createMultiEditTool(cwd));
  registerGoverned(createBashTool(cwd));
  registerGoverned(createGrepTool(cwd));
  registerGoverned(createFindTool(cwd));
  r.register(createGlobTool(cwd), { namespace: "stdlib" });
  registerGoverned(createLsTool(cwd));
  r.register(createWebFetchTool(), { namespace: "stdlib" });
  // Skill 仅由 governed Extension snapshot 动态注册；旧 handler-map 兼容构造器
  // 仍可显式 import，但不得进入生产 stdlib registry。
  r.register(createNotebookEditTool(), { namespace: "stdlib" });
  r.register(echoTool, { namespace: "stdlib" });
  return r;
}

/**
 * 创建带 ledger 注入的扩展工具集(stdlib + V2 Task 系列 + TodoWrite)。
 * legacy 扩展集保留 TodoWrite；Skill 由 governed Extension snapshot 注册。
 */
export function createExtendedTools(cwd: string = process.cwd(), taskOptions: { ledger?: import("../ledger/types.ts").LedgerSink } = {}): ToolRegistry {
  const r = createStdlibTools(cwd);
  r.register(createTodoWriteTool(taskOptions), { namespace: "stdlib" });
  return r;
}

/** AgentTool[] 视图,与 AgentContext.tools 直接相容。 */
export function stdlibTools(cwd: string = process.cwd()): AgentTool[] {
  return createStdlibTools(cwd).toContext();
}

export { createSkillTool } from "./skill.ts";
export { createReadTool, createWriteTool, createEditTool, createMultiEditTool, createBashTool, createGrepTool, createFindTool, createGlobTool, createLsTool, createWebFetchTool, createNotebookEditTool, createTodoWriteTool };
export { echoTool };
