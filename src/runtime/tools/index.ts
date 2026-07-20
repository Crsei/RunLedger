/**
 * 内置标准工具集 —— stdlib namespace。
 *
 * pi 的对应文件是 `core/tools/index.ts`。RunLedger 简化:不接收 ToolContext
 * 闭包(因为 our 工具直接 cwd 闭包即可),只暴露一组工厂 createXxxTool +
 * 一个 `createStdlibTools(cwd)` 一站式构造器返回 AgentTool[] / ToolRegistry。
 *
 * 工具集(对齐 pi):
 *   - read  : 读文件,行/字节截断
 *   - write : 写文件,递归建目录
 *   - edit  : 多块 oldText → newText
 *   - bash  : shell 执行,stdout/stderr 截断
 *   - grep  : ripgrep / grep 查找
 *   - find  : fd / find glob
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
import { createBashTool } from "./bash.ts";
import { createGrepTool } from "./grep.ts";
import { createFindTool } from "./find.ts";
import { createLsTool } from "./ls.ts";

/**
 * 一站式构造标准库工具集。返回 ToolRegistry,namespace="stdlib"。
 *
 * 与 pi 的差异:不接收 ToolContext 闭包;cwd 直接进工厂。
 * 若工具需要 ToolContext(fs / shell 注入 ledger 等),在调用 AgentLoop 前
 * 自行 prepareContext 时把 ExecutionEnv 通过 ops 注入。
 */
export function createStdlibTools(cwd: string = process.cwd()): ToolRegistry {
  const r = createToolRegistry([], { namespace: "stdlib" });
  r.register(createReadTool(cwd), { namespace: "stdlib" });
  r.register(createWriteTool(cwd), { namespace: "stdlib" });
  r.register(createEditTool(cwd), { namespace: "stdlib" });
  r.register(createBashTool(cwd), { namespace: "stdlib" });
  r.register(createGrepTool(cwd), { namespace: "stdlib" });
  r.register(createFindTool(cwd), { namespace: "stdlib" });
  r.register(createLsTool(cwd), { namespace: "stdlib" });
  r.register(echoTool, { namespace: "stdlib" });
  return r;
}

/** AgentTool[] 视图,与 AgentContext.tools 直接相容。 */
export function stdlibTools(cwd: string = process.cwd()): AgentTool[] {
  return createStdlibTools(cwd).toContext();
}

export { createReadTool, createWriteTool, createEditTool, createBashTool, createGrepTool, createFindTool, createLsTool };
export { echoTool };
