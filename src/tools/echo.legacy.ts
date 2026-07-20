/**
 * Echo 工具 —— Mock 一个最简工具,用于证明 agent loop 的 tool 调用链路通顺。
 *
 * 行为:把传入 args.text 原样回显到 ToolResultContent。
 *
 * `// TODO(pi):` 真实工具集应该参考 pi 的 ExecutionEnv + bash / fs tools 完整实现,
 * 本期仅为骨架示范。
 */

import type { AgentTool, ToolResultContent } from "../types.js";

export interface EchoArgs {
  text: string;
}

/** 类型断言工具:把 unknown 强制转换为 EchoArgs(仅在 mock 演示场景使用) */
function asEchoArgs(args: unknown): EchoArgs {
  if (typeof args === "object" && args !== null && "text" in args) {
    const a = args as { text: unknown };
    if (typeof a.text === "string") {
      return { text: a.text };
    }
  }
  return { text: "[echo: invalid args]" };
}

export const echoTool: AgentTool = {
  name: "echo",
  description: "回显输入文本。用于验证 agent 与工具执行链路。",
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "需要被回显的文本",
      },
    },
    required: ["text"],
  },
  executionMode: "sequential",
  async execute(
    _toolCallId: string,
    args: unknown,
  ): Promise<ToolResultContent> {
    const a = asEchoArgs(args);
    return {
      type: "toolResult",
      toolCallId: _toolCallId,
      content: [{ type: "text", text: a.text }],
    };
  },
};
