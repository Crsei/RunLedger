/**
 * ToolContext —— 工具执行时拿到的上下文。
 *
 * 对齐 pi 的 `ExtensionContext`(运行时工具视角),但去掉 UI 字段
 * (ui / mode / setStatus / setWidget / confirm / input ……),只保留审计
 * 与执行链必需项:
 *   - cwd:工具相对路径的基准目录
 *   - fs / shell:ExecutionEnv 暴露的文件系统与 shell 操作面(详见 execution-env.ts)
 *   - ledger:工具主动记账通道;确权事件 / 大文件读 / 命令执行等可主动补一条 entry
 *   - env:透传的环境变量覆盖
 *   - signal / sessionId / toolCallId:跨工具共享的运行时凭证
 *
 * 设计取舍:ToolContext 这个对象本身是"快照式"的,每次工具调用构造一份新
 * 的;ToolContext 实例不缓存跨调用的状态,所有共享状态走 AgentContext 或 ledger。
 *
 * 与 pi 不同点:
 *   - 不暴露 `compact()` / `getContextUsage()` —— RunLedger 暂不支持 compaction
 *   - 不暴露 `sessionManager` —— 工具不持有跨 session 句柄
 *   - 不暴露 `modelRegistry` / `model` / `getSystemPrompt()` —— 工具不查模型
 */

import type { LedgerSink } from "./ledger/types.ts";

/**
 * Forward decl:FileSystem / Shell 接口在 `execution-env.ts` 中具体实现;
 * 本文件只 hold 类型引用以避免循环依赖。
 *
 * 真正实现 Commit 3 会落 `execution-env.ts`,本期 ToolContext 引用其类型。
 */
import type { ExecutionEnv } from "./execution-env.ts";

/** ToolContext 与单次 toolCall 一一对应。 */
export interface ToolContext {
  /** 当前工作目录(规范化绝对路径) */
  cwd: string;
  /** 执行环境 —— fs + shell 操作面 */
  env: ExecutionEnv;
  /** 可选 ledger;工具可主动记账(默认 agent-loop 也会落 tool_call/tool_result) */
  ledger?: LedgerSink;
  /** 透传环境变量覆盖 */
  envVars: Record<string, string>;
  /** 取消信号 */
  signal: AbortSignal;
  /** 当前 session id */
  sessionId: string;
  /** 当前 toolCall id(便于工具内 ledger 记账关联) */
  toolCallId: string;
}

/**
 * 默认 ToolContext 工厂。
 * 工具内常需要把 cwd / signal / sessionId / toolCallId 拼出 context;
 * 提供 helper 让 agent-loop 调用点不重复构造。
 */
export function makeToolContext(args: {
  cwd: string;
  env: ExecutionEnv;
  ledger?: LedgerSink;
  envVars?: Record<string, string>;
  signal: AbortSignal;
  sessionId: string;
  toolCallId: string;
}): ToolContext {
  return {
    cwd: args.cwd,
    env: args.env,
    ledger: args.ledger,
    envVars: args.envVars ?? {},
    signal: args.signal,
    sessionId: args.sessionId,
    toolCallId: args.toolCallId,
  };
}
