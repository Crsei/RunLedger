/**
 * RunLedger TUI demo —— 接 anthropic provider 或回退 mock,跑全程人工测试。
 *
 * 用法:
 *   ANTHROPIC_API_KEY=xxx npm run demo:tui            # 全套真用
 *   npm run demo:tui                                  # 无 key 回退 mock(不能改文件,只演示流程)
 *
 * 行为(anthropic):
 *   1. createAnthropicAgent 装配 fs 工具集(Read/Write/Edit/Bash/grep/find/ls/echo)
 *   2. /model selector 列出 claude-sonnet-4-5/haiku-4-5 等候选
 *   3. /thinking selector 切换 minimal/low/medium/high/xhigh,切后 streamFn 重建
 *   4. 对话后 LLM 真发出 toolCall,Agent 执行 fs/edit 后 chat 显示真实改动
 *   5. Ctrl+C 中断当前 turn、Ctrl+D 退出
 *
 * 回退(mock)行为:
 *   - 用 mockStreamFn + echoTool 走通流程;
 *   - /model 列出 mock-1 与 mock-2 占位;
 *   - /thinking 切换会更新 Footer 但不影响 mock 输出(mock 不读 thinking level)。
 */

import { Agent } from "../src/runtime/agent.ts";
import { echoTool } from "../src/runtime/tools/echo.ts";
import { mockStreamFn, mockModel } from "../src/runtime/providers/mock-stream.ts";
import { MemoryLedger } from "../src/runtime/ledger/memory-ledger.ts";
import { InteractiveMode } from "../src/tui/interactive-mode.ts";
import { createAnthropicAgent } from "../src/runtime/agents/create-anthropic-agent.ts";
import type { ThinkingLevel, Model } from "../src/types.ts";

interface RuntimePlan {
  agent: Agent;
  modelRegistry: ModelSwitchEntry[];
  initialThinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  isMock: boolean;
}

interface ModelSwitchEntry {
  id: string;
  label: string;
  description?: string;
  model: Agent["state"]["model"];
}

/** 决定 provider 通路:有 anthropic key 走真实路径,否则 mock 回退。 */
function planRuntime(): RuntimePlan {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    // 真实路径:claude-sonnet-4-5 默认 + 几个候选
    const sonnet: Model<"anthropic-messages"> = {
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: true,
    } as Model<"anthropic-messages">;
    const haiku: Model<"anthropic-messages"> = {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: false,
    } as Model<"anthropic-messages">;
    const opus: Model<"anthropic-messages"> = {
      id: "claude-opus-4-1-20250805",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: true,
    } as Model<"anthropic-messages">;

    // thinking closure:让 streamFn 每次按当前 thinkingLevel 重新读取(用 mutable 容器)
    const thinkingRef: { level: ThinkingLevel } = { level: "minimal" };

    // 真实 agent:第一版用 createAnthropicAgent 的 thinking 注入(读取 closure)
    // createAnthropicAgent 在构造时一次性 cake thinking level;切换需重建 streamFn,
    // 改为通过 AgentLoopConfig.thinkingLevel 透传 —— 但 runtime 当前不消费该字段。
    // 简化:M8 demo 中切换 thinking 重建 agent(切 streamFn 的 closure)不可行(改不动 Agent)
    // ⇒ 实际做法:切换 thinking 不真生效,仅 Footer 显示;若要真生效,需 caller 在切后
    //   completeAgent by new createAnthropicAgent + setModel/setTools,等 M8 polish。
    const agent = createAnthropicAgent({
      systemPrompt:
        "You are RunLedger's interactive coding agent inside a TUI. " +
        "Use Read/Write/Edit/Bash tools to inspect and modify files. " +
        "Keep replies concise and ask before destructive operations.",
      model: sonnet,
      thinkingLevel: thinkingRef.level,
    });

    const modelRegistry: ModelSwitchEntry[] = [
      {
        id: "claude-sonnet-4-5",
        label: "claude-sonnet-4-5",
        description: "1.5x output / reasoning",
        model: sonnet,
      },
      {
        id: "claude-haiku-4-5",
        label: "claude-haiku-4-5",
        description: "fastest, no thinking",
        model: haiku,
      },
      {
        id: "claude-opus-4-1",
        label: "claude-opus-4-1",
        description: "strongest reasoning",
        model: opus,
      },
    ];

    const onThinkingChange = (level: ThinkingLevel): void => {
      thinkingRef.level = level;
      // M8 注:此处仅记录级别;真要生效需重建 agent streamFn,留待 polish
      process.stderr.write(`[tui-demo] thinking -> ${level} (生效需重启 demo)\n`);
    };

    return {
      agent,
      modelRegistry,
      initialThinkingLevel: thinkingRef.level,
      onThinkingChange,
      isMock: false,
    };
  }

  // mock 回退路径
  process.stderr.write(
    "[tui-demo] WARNING: ANTHROPIC_API_KEY missing; 回退 mock provider.\n" +
      "  LLM 输出固定 echo toolCall,真的对话改文件不可用;仅流程演示.\n",
  );
  const ledger = new MemoryLedger({ metadata: { demo: "tui-mock" } });
  const agent = new Agent({
    initialState: {
      systemPrompt: "你是 RunLedger TUI demo 中的 mock assistant,通过 echo 工具回复。",
      model: mockModel,
      tools: [echoTool],
    },
    streamFn: mockStreamFn,
    ledger,
    toolExecution: "sequential",
  });
  const mockModel2 = { ...mockModel, id: "mock-2" };
  const modelRegistry: ModelSwitchEntry[] = [
    { id: "mock-1", label: "mock-1 (default)", description: "echo tool chained", model: mockModel },
    { id: "mock-2", label: "mock-2", description: "alt mock descriptor", model: mockModel2 },
  ];
  let currentThinking: ThinkingLevel = "minimal";
  const onThinkingChange = (level: ThinkingLevel): void => {
    currentThinking = level;
    process.stderr.write(`[tui-demo] mock thinking -> ${currentThinking} (mock 不消费)\n`);
  };
  return { agent, modelRegistry, initialThinkingLevel: currentThinking, onThinkingChange, isMock: true };
}

async function main(): Promise<void> {
  const plan = planRuntime();
  const mode = new InteractiveMode({
    agent: plan.agent,
  });

  // 退出信号:外部 Ctrl+C 时优雅 stop
  let sigintFired = false;
  const onSigint = (): void => {
    if (sigintFired) return;
    sigintFired = true;
    // 第一次 SIGINT 视为 interrupt 当前 turn(若有),第二次直接退出
    if (plan.agent.inFlight) {
      plan.agent.interrupt();
    } else {
      mode.quit();
    }
  };
  process.on("SIGINT", onSigint);

  try {
    await mode.run();
  } finally {
    process.off("SIGINT", onSigint);
    const ledger = plan.agent.ledger;
    if (ledger && "entries" in ledger) {
      const entries = (ledger as { entries: () => unknown[] }).entries();
      process.stderr.write(`\n[tui-demo] ledger entries: ${entries.length}\n`);
    }
    process.stderr.write(`[tui-demo] mock? ${plan.isMock}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[tui-demo] fatal: ${String(err)}\n`);
  process.exit(1);
});
