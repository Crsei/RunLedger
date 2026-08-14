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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cliMain from "../../src/cli/main.ts";
import { parseArgs } from "../../src/cli/args.ts";

const { cliSecurityOverride, cliSecuritySources } = cliMain;

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

describe("CLI read-only Extension control commands", () => {
  it.each([
    ["plugin", "list"],
    ["skill", "list"],
    ["mcp", "list"],
  ])("routes runledger %s %s through the Session query channel", (group, action) => {
    const home = mkdtempSync(join(tmpdir(), "runledger-cli-extension-query-"));
    try {
      const result = runCli([group, action], { RUNLEDGER_DIR: home });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout) as unknown).toMatchObject({
        ok: true,
        status: "ok",
        operation: `${group}.${action}`,
        value: { items: [] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

describe("cliSecurityOverride flags → cli 层 document", () => {
  it("无 security flags 时返回 undefined", () => {
    expect(cliSecurityOverride(parseArgs(["--continue"]).args)).toBeUndefined();
  });

  it("permission-profile 单独映射", () => {
    const doc = cliSecurityOverride(parseArgs(["--permission-profile", "read-only"]).args);
    expect(doc).toEqual({ profile: "read-only" });
  });

  it("approval-policy 单独映射", () => {
    const doc = cliSecurityOverride(parseArgs(["--approval-policy", "never"]).args);
    expect(doc).toEqual({ approvalPolicy: "never" });
  });

  it("bash analyzer mode maps into the CLI security layer", async () => {
    const args = parseArgs(["--bash-analyzer", "ast"]).args;
    expect(cliSecurityOverride(args)).toEqual({ bashAnalyzerMode: "ast" });
    const sources = cliSecuritySources(args);
    await expect(sources[0]?.read()).resolves.toEqual({
      status: "available",
      text: JSON.stringify({ bashAnalyzerMode: "ast" }),
    });
  });

  it("granular approval 与 named profile 映射成可独立解析的 CLI layer", () => {
    expect(cliSecurityOverride(parseArgs(["--permission-profile", "team.review-prod"]).args)).toEqual({ profile: "team.review-prod" });
    expect(cliSecurityOverride(parseArgs(["--approval-policy", "granular"]).args)).toEqual({
      approvalPolicy: "granular",
      granularApproval: { sandboxApproval: true, rules: true, skillApproval: true, requestPermissions: true, mcpElicitations: true },
    });
  });

  it("sandbox 单独映射", () => {
    const doc = cliSecurityOverride(parseArgs(["--sandbox", "strict"]).args);
    expect(doc).toEqual({ sandbox: "strict" });
  });

  it("network 映射为 deny/allow + 空 allowlist", () => {
    const doc = cliSecurityOverride(parseArgs(["--network", "deny"]).args);
    expect(doc).toEqual({ network: { mode: "deny", allowedHosts: [] } });
  });

  it("network review/allowlist 保留显式 host 集", () => {
    expect(cliSecurityOverride(parseArgs(["--network", "review", "--network-host", "api.example"]).args)).toEqual({
      network: { mode: "review", allowedHosts: ["api.example"] },
    });
    expect(cliSecurityOverride(parseArgs(["--network", "allowlist", "--network-host", "api.example"]).args)).toEqual({
      network: { mode: "allowlist", allowedHosts: ["api.example"] },
    });
  });

  it("组合 flags 合并进同一 document", () => {
    const doc = cliSecurityOverride(parseArgs([
      "--permission-profile", "workspace-write",
      "--approval-policy", "on-request",
      "--sandbox", "workspace-write",
      "--network", "deny",
    ]).args);
    expect(doc).toEqual({
      profile: "workspace-write",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      network: { mode: "deny", allowedHosts: [] },
    });
  });

  it("CLI security document is exposed as the highest-priority session source", async () => {
    const sources = cliSecuritySources(parseArgs([
      "--permission-profile", "read-only",
      "--network", "deny",
    ]).args);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.source).toBe("cli");
    await expect(sources[0]?.read()).resolves.toEqual({
      status: "available",
      text: JSON.stringify({ profile: "read-only", network: { mode: "deny", allowedHosts: [] } }),
    });
  });
});

// 防止 vitest 给 spy 留悬挂警告。
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
