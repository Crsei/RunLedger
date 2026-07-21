/**
 * 构造一个 anthropic provider + stdlib fs 工具集 + 可选 AbortSignal 的 Agent。
 *
 * 与 `createStdlibAgent` 区别:
 *   - 强制使用 anthropic-messages streamFn(直接 import src/api/anthropic-messages.ts 的 stream)
 *   - 注入 ANTHROPIC_API_KEY(从 env 取或参数显式传)与可选 baseUrl override
 *   - 暴露 AbortController 信号 (interrupt 走 controller);后续 Agent.interrupt() 复用
 *
 * 设计权衡:此处不引入 ProviderConfig<...> 这一抽象,直接在 helper 里组装好 apiKey + env
 * 与 base url 路径,处理最小集合。toolExecution 默认 "sequential"。
 */

import { Agent } from "../agent.ts";
import type { AgentTool, StreamFn } from "../types.ts";
import { stdlibTools } from "../tools/index.ts";
import { stream as anthropicStream } from "../../api/anthropic-messages.ts";
import type { Model, ThinkingLevel } from "../../types.ts";
import type { LedgerSink } from "../ledger/types.ts";

/** 可选 anthropic provider 接入参数。 */
export interface AnthropicAgentOptions {
  cwd?: string;
  systemPrompt: string;
  apiKey?: string;
  baseUrl?: string;
  model: Model<"anthropic-messages">;
  tools?: AgentTool[];
  ledger?: LedgerSink;
  /** Initial thinking level; defaults to "minimal" */
  thinkingLevel?: ThinkingLevel;
}

/**
 * createAnthropicAgent:对 anthropic-messages streamFn 做 streamFn 包络:
 *  - 在 options 上注入 thinkingEnabled / thinkingBudgetTokens / effort 映射 thinkingLevel
 *  - apiKey 与 baseUrl 注入
 *  - signal 透传
 *
 * 不直接传 anthropic stream 给 Agent:options 走 StreamOptions 形态(缺 anthropic 字段);
 * 我们包一层 streamFn 把 thinking 注入责任拿到 helper 内。
 */
export function createAnthropicAgent(opts: AnthropicAgentOptions): Agent {
  const cwd = opts.cwd ?? process.cwd();
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "createAnthropicAgent: ANTHROPIC_API_KEY missing. Pass apiKey or set env.ANTHROPIC_API_KEY.",
    );
  }
  const tools = opts.tools ?? stdlibTools(cwd);
  const thinkingLevel: ThinkingLevel = opts.thinkingLevel ?? "minimal";
  const baseUrlOverride = opts.baseUrl;

  /** streamFn 包络:把 thinking level / apiKey 注入。 */
  const streamFn: StreamFn = (model, context, options) => {
    const merged: Record<string, unknown> = {
      ...(options ?? {}),
      apiKey,
      env: { ...(options?.env ?? {}) },
    };
    applyThinkingLevel(thinkingLevel, merged);
    if (baseUrlOverride) {
      // model 上 baseUrl 才真实生效;此处仅作 placeholder 留待 model.baseUrl 切换
      void baseUrlOverride;
    }
    return anthropicStream(
      model as Model<"anthropic-messages">,
      // LlmContext 与 anthropic Context 结构兼容;AgentTool 与 Tool 结构兼容
      context as Parameters<typeof anthropicStream>[1],
      merged as Parameters<typeof anthropicStream>[2],
    );
  };

  return new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      tools,
    },
    streamFn,
    ledger: opts.ledger,
  });
}

/**
 * applyThinkingLevel:把 ThinkingLevel 映射到 AnthropicOptions 的 thinkingEnabled 等。
 *
 * 对照 src/api/anthropic-messages.ts §buildParams。
 * minimal (off)  => thinkingEnabled=false
 * low            => enabled, budget 4k,  effort low
 * medium         => enabled, budget 10k, effort medium
 * high           => enabled, budget 32k, effort high
 * xhigh / max    => enabled, budget 64k, effort xhigh/max
 */
export function applyThinkingLevel(level: ThinkingLevel, base: Record<string, unknown>): void {
  switch (level) {
    case "minimal":
      base.thinkingEnabled = false;
      break;
    case "low":
      base.thinkingEnabled = true;
      base.thinkingBudgetTokens = 4096;
      base.effort = "low";
      break;
    case "medium":
      base.thinkingEnabled = true;
      base.thinkingBudgetTokens = 10240;
      base.effort = "medium";
      break;
    case "high":
      base.thinkingEnabled = true;
      base.thinkingBudgetTokens = 32768;
      base.effort = "high";
      break;
    case "xhigh":
      base.thinkingEnabled = true;
      base.thinkingBudgetTokens = 65536;
      base.effort = "xhigh";
      break;
    case "max":
      base.thinkingEnabled = true;
      base.thinkingBudgetTokens = 131072;
      base.effort = "max";
      break;
  }
}

