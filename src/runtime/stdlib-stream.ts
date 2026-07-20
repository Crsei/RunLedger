/**
 * Agent 便利构造器 —— 把 stdlib 工具集与任意 streamFn 桥接成一个可用 Agent。
 *
 * 用途: 让调用者在 5 行以内构造可跑的 Agent:
 *
 * ```ts
 * const agent = createStdlibAgent({
 *   cwd: process.cwd(),
 *   systemPrompt: "You are RunLedger agent.",
 *   model: pickModel("anthropic", "claude-3-5-sonnet"),
 *   streamFn: anthropicStreamFn, // 任意 pi-ai streamFn
 * });
 * const ctrl = agent.prompt("列出当前目录");
 * for await (const event of ctrl.events) console.log(event);
 * ```
 *
 * 与 pi `coding-agent` 的 `StdlibAgent` 不同,RunLedger 此处只暴露最小组合,
 * 不带 prompts/RBAC/proxy/harness,因为本期 runtime 还没到那一步。
 *
 * 名称注:本文件命名 `stdlib-stream.ts` 是历史称谓,实际它桥接的不是 stream
 * 而是工具集 + streamFn;改名 risk 高(影响 barrel 导出),保留。
 */

import type { AgentTool, StreamFn } from "./types.ts";
import { Agent } from "./agent.ts";
import { mockStreamFn } from "./providers/mock-stream.ts";
import { mockModel } from "./providers/mock-stream.ts";
import { createStdlibTools, stdlibTools } from "./tools/index.ts";
import type { LedgerSink } from "./ledger/types.ts";

export interface StdlibAgentOptions {
  cwd?: string;
  systemPrompt: string;
  /** LLM 模型;缺省 mockModel(便于 demo / 测试) */
  model?: Parameters<typeof Agent.prototype.setModel>[0];
  /** streamFn;缺省 mockStreamFn */
  streamFn?: StreamFn;
  /** 注入工具数量;默认 stdlib 全集(8个) */
  tools?: AgentTool[];
  /** ledger 缺省则不落盘 */
  ledger?: LedgerSink;
}

/**
 * 构造一个 stdlib 工具集 + 任意 streamFn 的 Agent。
 *
 * 与直接 `new Agent({...})` 区别:
 *   - 自动注入 createStdlibTools() 8 个工具集(若 tools 未显式传)
 *   - 默认 model/streamFn 为 mock,便于无 API key 下 demo
 *   - 不暴露未稳定 loopConfig 字段
 */
export function createStdlibAgent(opts: StdlibAgentOptions): Agent {
  const cwd = opts.cwd ?? process.cwd();
  const streamFn = opts.streamFn ?? mockStreamFn;
  const model = opts.model ?? mockModel;
  const tools = opts.tools ?? stdlibTools(cwd);
  return new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools,
    },
    streamFn,
    ledger: opts.ledger,
  });
}

/**
 * stdlibStreamFn —— RunLedger repo 内"streamFn + stdlib 工具集"的便利别名。
 *
 * 它**不是**一个新的 stream 协议,它就是 mockStreamFn / 真实 provider streamFn
 * 等的统一别名,便于在示例代码或文档中以"stdlib 默认 LLM stream 入口"提及。
 */
export const stdlibStreamFn: StreamFn = mockStreamFn;

/** 仅返回 stdlib 工具集 schema 视图;供 AgentLoop 用 schemaOnlyView 直接消费 */
export function stdlibToolSchemas(cwd: string = process.cwd()): AgentTool[] {
  return stdlibTools(cwd);
}

/** 用 createStdlibTools 生成 ToolRegistry 后取 .toContext() 注入 Agent */
export function stdlibRegistry(cwd: string = process.cwd()) {
  return createStdlibTools(cwd);
}
