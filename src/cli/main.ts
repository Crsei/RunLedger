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
 *   6. 装配全部 builtin providers + AuthStorage;无认证时进入 TUI onboarding
 *   7. 构造 systemPrompt(合并 cwd/AGENTS.md 与全局 ~/.runledger/agent/AGENTS.md)
 *   8. 实例化 Agent + InteractiveMode + run
 *   9. finally closeAll ledger
 *
 * 本期不实现 trust-manager / extensions / skills / themes 加载。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InteractiveMode } from "../tui/interactive-mode.ts";
import { selectSessionInTui } from "../tui/session-selector.ts";
import { loadProjectSettings } from "../storage/settings-manager.ts";
import { resolveSessionDir, getGlobalAgentsMd } from "../storage/paths.ts";
import { SessionManager } from "../storage/session-manager.ts";
import { replaySession } from "../storage/session-codec.ts";
import { AuthStorage } from "../storage/auth-storage.ts";
import { builtinModels } from "../providers/all.ts";
import { InteractiveSessionController } from "../runtime/interactive-session-controller.ts";
import { parseArgs, USAGE } from "./args.ts";

const VERSION = readVersionFromPackage();

const DEFAULT_SYSTEM_PROMPT =
  "You are RunLedger's interactive coding agent inside a TUI. " +
  "Use Read/Write/Edit/Bash/grep/find/ls tools to inspect and modify files. " +
  "Keep replies concise and ask before destructive operations.";

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
  } else if (args.sessionId) {
    const match = (await SessionManager.list(cwd, sessionDir))
      .find((session) => session.id === args.sessionId);
    if (!match) throw new Error(`session id not found: ${args.sessionId}`);
    mgr = await SessionManager.open(match.filePath);
  } else if (args.fork) {
    mgr = await SessionManager.forkFrom(args.fork, cwd, sessionDir);
  } else if (args.resume) {
    const sessions = await SessionManager.list(cwd, sessionDir);
    if (sessions.length === 0) {
      process.stderr.write("[runledger] no sessions available to resume\n");
      return;
    }
    const selected = process.stdin.isTTY
      ? await selectSessionInTui(sessions)
      : sessions[0];
    if (!selected) return;
    mgr = await SessionManager.open(selected.filePath);
  } else if (args.continueRecent) {
    mgr = await SessionManager.continueRecent(cwd, sessionDir);
  } else {
    mgr = await SessionManager.create({
      cwd,
      sessionDir,
      metadata: { cwd },
    });
  }
  let removeSigint: (() => void) | undefined;
  let removeStdinEnd: (() => void) | undefined;
  try {
    await mgr.acquireLock();
    const models = builtinModels({ credentials: AuthStorage.create() });
    await models.refresh({ allowNetwork: false });
    const replay = await replaySession(mgr.ledger());
    const controller = await InteractiveSessionController.create({
      cwd,
      systemPrompt: buildSystemPrompt(cwd),
      models,
      settings,
      replay,
      ledger: mgr.ledger(),
      overrides: {
        provider: args.provider,
        model: args.model,
        thinkingLevel: args.thinking,
      },
    });
    const interactive = new InteractiveMode({ controller });
    const onSigint = (): void => {
      if (controller.inFlight) controller.interrupt();
      else interactive.quit();
    };
    process.on("SIGINT", onSigint);
    removeSigint = () => process.off("SIGINT", onSigint);
    const onStdinEnd = (): void => interactive.quit();
    process.stdin.once("end", onStdinEnd);
    removeStdinEnd = () => process.stdin.off("end", onStdinEnd);
    if (process.stdin.readableEnded) queueMicrotask(onStdinEnd);
    await interactive.run();
  } finally {
    removeSigint?.();
    removeStdinEnd?.();
    await mgr.closeAll().catch(() => {
      // close 失败不阻断退出
    });
    if (process.env.RUNLEDGER_DEBUG === "1") {
      process.stderr.write(
        `[runledger] exit. session=${mgr.filePath()}\n`,
      );
    }
  }
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
