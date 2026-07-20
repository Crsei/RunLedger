/**
 * RunLedger CLI 主入口 —— 装配 SessionManager / SettingsManager / Agent /
 * InteractiveMode 后启动 TUI。
 *
 * 行为按 §3 计划文档:
 *   1. parseArgs → handle -h/-v
 *   2. compute cwd / 设置 RUNLEDGER_DEBUG
 *   3. loadProjectSettings(cwd)
 *   4. 决定 sessionDir:--session-dir > settings.sessionDir > 默认(.runledger/sessions/)
 *   5. 选择 session 操作:create / continueRecent / open(--session) / forkFrom
 *   6. 解析 model + buildRuntime(anthropic key 存在走真路径,否则 mock 回退)
 *   7. 构造 systemPrompt(合并 cwd/AGENTS.md 与全局 ~/.runledger/agent/AGENTS.md)
 *   8. 实例化 Agent + InteractiveMode + run
 *   9. finally closeAll ledger
 *
 * 本期不实现:
 *   - --resume 弹 Overlay(placeholder:列出最大 mtime 一条,实际走 continueRecent)
 *   - thinkingLevel 真生效切换(M8 polish 已标记)
 *   - trust-manager / extensions / skills / themes 加载
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../runtime/agent.ts";
import { echoTool } from "../runtime/tools/echo.ts";
import { mockStreamFn, mockModel } from "../runtime/providers/mock-stream.ts";
import { createAnthropicAgent } from "../runtime/agents/create-anthropic-agent.ts";
import { InteractiveMode, type ModelSwitchEntry } from "../tui/interactive-mode.ts";
import type { LedgerSink } from "../runtime/ledger/types.ts";
import type { Model, ThinkingLevel } from "../types.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveSessionDir, getGlobalAgentsMd } from "../storage/paths.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { parseArgs, USAGE } from "./args.ts";

const VERSION = readVersionFromPackage();

const DEFAULT_SYSTEM_PROMPT =
  "You are RunLedger's interactive coding agent inside a TUI. " +
  "Use Read/Write/Edit/Bash/grep/find/ls tools to inspect and modify files. " +
  "Keep replies concise and ask before destructive operations.";

interface RuntimePlan {
  agent: Agent;
  modelRegistry: ModelSwitchEntry[];
  initialThinkingLevel: ThinkingLevel;
  onThinkingChange: (level: ThinkingLevel) => void;
  isMock: boolean;
}

interface BuildRuntimeOpts {
  modelIdOverride?: string;
  thinkingLevel: ThinkingLevel;
  ledger: LedgerSink;
  systemPrompt: string;
}

export async function main(argv: readonly string[]): Promise<void> {
  const { args, error } = parseArgs(argv);
  if (error) {
    process.stderr.write(`[runledger] ${error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.version) {
    process.stdout.write(`runledger ${VERSION}\n`);
    return;
  }
  if (args.debug) {
    process.env.RUNLEDGER_DEBUG = "1";
  }

  const cwd = process.cwd();
  const settings = await loadProjectSettings(cwd);

  const sessionDir =
    args.sessionDir ?? resolveSessionDir(cwd, settings.sessionDir);

  let mgr: SessionManager;
  if (args.session) {
    mgr = await SessionManager.open(args.session);
  } else if (args.fork) {
    mgr = await SessionManager.forkFrom(args.fork, cwd, sessionDir);
  } else if (args.continueRecent || args.resume) {
    mgr = await SessionManager.continueRecent(cwd, sessionDir);
  } else {
    mgr = await SessionManager.create({
      cwd,
      sessionDir,
      metadata: { cwd },
    });
  }

  const ledger: LedgerSink = mgr.ledger();
  const thinkingLevel: ThinkingLevel =
    args.thinking ?? settings.thinkingLevel ?? "minimal";
  const modelIdOverride = args.model ?? settings.model;

  const systemPrompt = buildSystemPrompt(cwd);

  const plan = buildRuntime({
    modelIdOverride,
    thinkingLevel,
    ledger,
    systemPrompt,
  });

  const interactive = new InteractiveMode({
    agent: plan.agent,
    modelRegistry: plan.modelRegistry,
    initialThinkingLevel: plan.initialThinkingLevel,
    onThinkingChange: plan.onThinkingChange,
  });

  let sigintFired = false;
  const onSigint = (): void => {
    if (sigintFired) return;
    sigintFired = true;
    if (plan.agent.inFlight) {
      plan.agent.interrupt();
    } else {
      interactive.quit();
    }
  };
  process.on("SIGINT", onSigint);

  try {
    await interactive.run();
  } finally {
    process.off("SIGINT", onSigint);
    await mgr.closeAll().catch(() => {
      // close 失败不阻断退出
    });
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(
        `[runledger] exit. mockProvider=${plan.isMock} session=${mgr.filePath()}\n`,
      );
    }
  }
}

/**
 * buildRuntime —— 决定 model / streamFn / tools / modelRegistry,并实例化 Agent。
 *
 * 与 examples/tui-demo.ts 的 planRuntime 等价;但 ledger 与 systemPrompt 由 caller 注入。
 *
 * enabledModels(settings.json)用于过滤 /model 选择器可见候选;
 * 本期简化:暂不传 enabledModels 到此处,候选默认全部 known。
 */
function buildRuntime(opts: BuildRuntimeOpts): RuntimePlan {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (anthropicKey) {
    const sonnet = {
      id: "claude-sonnet-4-5-20250929",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: true,
    } as unknown as Model<"anthropic-messages">;
    const haiku = {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: false,
    } as unknown as Model<"anthropic-messages">;
    const opus = {
      id: "claude-opus-4-1-20250805",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      reasoning: true,
    } as unknown as Model<"anthropic-messages">;

    const modelMap: Record<string, Model<"anthropic-messages">> = {
      "claude-sonnet-4-5": sonnet,
      "claude-haiku-4-5": haiku,
      "claude-opus-4-1": opus,
    };
    const initialModel =
      (opts.modelIdOverride && modelMap[opts.modelIdOverride]) || sonnet;

    const thinkingRef: { level: ThinkingLevel } = { level: opts.thinkingLevel };

    const agent = createAnthropicAgent({
      systemPrompt: opts.systemPrompt,
      model: initialModel,
      thinkingLevel: thinkingRef.level,
      ledger: opts.ledger,
    });

    const modelRegistry: ModelSwitchEntry[] = [
      { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5", description: "1.5x output / reasoning", model: sonnet },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5", description: "fastest, no thinking", model: haiku },
      { id: "claude-opus-4-1", label: "claude-opus-4-1", description: "strongest reasoning", model: opus },
    ];

    const onThinkingChange = (level: ThinkingLevel): void => {
      thinkingRef.level = level;
      // TODO(pi): M8e polish — 真生效需重建 streamFn;此处仅 Footer 显示。
      process.stderr.write(`[runledger] thinking -> ${level} (生效需重启)\n`);
    };

    return {
      agent,
      modelRegistry,
      initialThinkingLevel: thinkingRef.level,
      onThinkingChange,
      isMock: false,
    };
  }

  // 回退 mock
  process.stderr.write(
    "[runledger] WARNING: ANTHROPIC_API_KEY missing; 回退 mock provider.\n" +
      "  LLM 输出固定 echo toolCall,真的对话改文件不可用;仅流程演示.\n",
  );
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.systemPrompt + "\n(mock provider;echo 工具回复)",
      model: mockModel,
      tools: [echoTool],
    },
    streamFn: mockStreamFn,
    ledger: opts.ledger,
  });
  const mockModel2 = { ...mockModel, id: "mock-2" } as unknown as typeof mockModel;
  const modelRegistry: ModelSwitchEntry[] = [
    { id: "mock-1", label: "mock-1 (default)", description: "echo tool chained", model: mockModel },
    { id: "mock-2", label: "mock-2", description: "alt mock descriptor", model: mockModel2 },
  ];
  let currentThinking: ThinkingLevel = opts.thinkingLevel;
  const onThinkingChange = (level: ThinkingLevel): void => {
    currentThinking = level;
    process.stderr.write(
      `[runledger] mock thinking -> ${currentThinking} (mock 不消费)\n`,
    );
  };
  return {
    agent,
    modelRegistry,
    initialThinkingLevel: currentThinking,
    onThinkingChange,
    isMock: true,
  };
}

/**
 * 构造系统提示:DEFAULT + cwd 下 AGENTS.md(若存在) + 全局 ~/.runledger/agent/AGENTS.md(若存在)。
 *
 * 本期不向上扫祖先链(pi 也是按 ancestor chain,本期仅在 cwd 与 global 两点
 * 读 AGENTS.md;TODO(pi):祖先链扫描加 M8 后续 PR)。
 */
function buildSystemPrompt(cwd: string): string {
  const parts: string[] = [DEFAULT_SYSTEM_PROMPT];
  const localAg = getProjectAgentsMd(cwd);
  if (localAg && existsSync(localAg)) {
    try {
      parts.push(readFileSync(localAg, "utf8"));
    } catch {
      // 读失败静默
    }
  }
  const globalAg = getGlobalAgentsMd();
  if (globalAg && existsSync(globalAg)) {
    try {
      parts.push(readFileSync(globalAg, "utf8"));
    } catch {
      // 读失败静默
    }
  }
  return parts.join("\n\n---\n\n");
}

/**
 * 本仓库存在 `<cwd>/AGENTS.md`(本期属项目说明,被纳入 systemPrompt 推动 agent),
 * 与 `.runledger/` 子树区别:这是 codex 仓库惯例的 AGENTS.md。
 */
function getProjectAgentsMd(cwd: string = process.cwd()): string {
  return join(cwd, "AGENTS.md");
}

/** 版本号从 package.json 读取;失败兜底 0.0.0-unknown */
function readVersionFromPackage(): string {
  try {
    const here = new URL(".", import.meta.url);
    const pkgUrl = new URL("../../package.json", here);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}
