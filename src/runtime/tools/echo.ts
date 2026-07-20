/**
 * Echo 工具 —— Mock 一个最简工具,用于证明 agent loop 的 tool 调用链路通顺。
 *
 * 行为:把传入 args.text 原样回显到 `AgentToolResult.content`。
 *
 * 与 pi 工具契约一致:execute 内 throw 由 agent-loop 兜底转 isError。
 * 本工具不依赖 ToolContext(不需要 fs / shell),故签名不引用 ctx。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";

export const echoSchema = Type.Object({
  text: Type.String({ description: "需要被回显的文本" }),
});

export type EchoArgs = Static<typeof echoSchema>;

/** Echo 工具 details;仅记录 echo 调用是否被截断为 placeholder 兜底。 */
export interface EchoDetails {
  mode: "normal" | "fallback";
}

/** 类型断言工具:把 unknown 安全规整为 EchoArgs。fallback 时给占位文本。 */
function asEchoArgs(args: Record<string, unknown>): { text: string; mode: "normal" | "fallback" } {
  const candidate = args["text"];
  if (typeof candidate === "string") {
    return { text: candidate, mode: "normal" };
  }
  return { text: "[echo: invalid args]", mode: "fallback" };
}

/**
 * Echo tool —— 默认示例 AgentTool。一次性导出即可注册到 AgentContext.tools。
 */
export const echoTool: AgentTool<typeof echoSchema, EchoDetails> = {
  name: "echo",
  label: "Echo",
  description: "回显输入文本。用于验证 agent 与工具执行链路。",
  parameters: echoSchema,
  prepareArguments(args: unknown): EchoArgs {
    if (args && typeof args === "object" && typeof (args as Record<string, unknown>)["text"] === "string") {
      return { text: (args as Record<string, unknown>)["text"] as string };
    }
    return { text: "[echo: invalid args]" };
  },
  async execute(
    _toolCallId: string,
    params: EchoArgs,
  ): Promise<AgentToolResult<EchoDetails>> {
    const r = asEchoArgs(params as Record<string, unknown>);
    return {
      content: [{ type: "text", text: r.text }],
      details: { mode: r.mode },
    };
  },
};
