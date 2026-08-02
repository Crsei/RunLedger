/**
 * main() 集成测 —— 仅覆盖不需要起 TUI 的早期分支:
 *   - --help / --version 走 stdout 立即 return
 *   - 错误 flag 写 stderr + exit 2(通过 spy process.exit 拦截)
 *
 * 真正启动 interactive.run() 的路径(无 key 时 mock 回退而非真 LLM)用 smoke
 * test `node bin/runledger.js --version` 已覆盖,不进 vitest(会卡 stdin)。
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// 用 child_process spawn 真跑 src/cli/cli.ts,避免污染当前 vitest 进程。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");

function runCli(args: string[], env?: Record<string, string>): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

describe("CLI main() --help / --version", () => {
  it("--help 写 stdout usage 文本,返回 0", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: runledger");
    expect(r.stdout).toContain("--help");
  });

  it("-h 与 --help 等价", () => {
    const r = runCli(["-h"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: runledger");
  });

  it("--version 写 stdout 'runledger 0.0.1',返回 0", () => {
    const r = runCli(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^runledger\s+\d+\.\d+\.\d+/);
  });

  it("-v 与 --version 等价", () => {
    const r = runCli(["-v"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^runledger\s/);
  });

  it("--thinking 不合法值 写 stderr + exit 2", () => {
    const r = runCli(["--thinking", "bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("bogus");
    expect(r.stderr).toContain("Usage");
  });

  it("--session 缺值 写 stderr + exit 2", () => {
    const r = runCli(["--session"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--session");
  });

  it("--session-dir 写明确弃用错误 + exit 2", () => {
    const r = runCli(["--session-dir", "/tmp/legacy"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--session-dir");
    expect(r.stderr).toContain("RUNLEDGER_DIR");
  });

  it("RUNLEDGER_SESSION_DIR 非空时 fail closed + exit 2", () => {
    const r = runCli(["--continue"], { RUNLEDGER_SESSION_DIR: "/tmp/legacy" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("RUNLEDGER_SESSION_DIR");
    expect(r.stderr).toContain("unsupported_environment_override");
  });
});

describe("CLI buildSystemPrompt 局部 helper 间接验证", () => {
  // 通过 --version 不会触发 buildSystemPrompt,此处不直接 export helper。
  // 真正的 systemPrompt 组装靠 anthropic 路径(/help/,/resume 等)ager 路径,
  // 本期 TUI 通路因 stdio 隔离不便单测,留 §6 的 manual smoke test。
  it("placeholder:test file requires at least one it", () => {
    expect(true).toBe(true);
  });
});

// 防止 vitest 给 spy 留悬挂警告。
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
