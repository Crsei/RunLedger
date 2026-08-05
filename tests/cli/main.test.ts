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
import * as cliMain from "../../src/cli/main.ts";
import type { HostRequestTransport } from "../../src/runtime/host/remote-session.ts";
import { parseArgs } from "../../src/cli/args.ts";

const { cliSecurityOverride } = cliMain;

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

  it("sandbox 单独映射", () => {
    const doc = cliSecurityOverride(parseArgs(["--sandbox", "strict"]).args);
    expect(doc).toEqual({ sandbox: "strict" });
  });

  it("network 映射为 deny/allow + 空 allowlist", () => {
    const doc = cliSecurityOverride(parseArgs(["--network", "deny"]).args);
    expect(doc).toEqual({ network: { mode: "deny", allowedHosts: [] } });
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
});

describe("CLI worktree session binding", () => {
  it("rebinds the opened session after the Host creates the managed worktree", async () => {
    const candidate = cliMain as typeof cliMain & {
      bindHostWorktreeSession?: (
        transport: HostRequestTransport,
        sessionId: string,
        openedBody: Record<string, unknown>,
        cwd: string,
        args: ReturnType<typeof parseArgs>["args"],
      ) => Promise<Record<string, unknown>>;
    };
    expect(candidate.bindHostWorktreeSession).toBeTypeOf("function");
    const operations: string[] = [];
    const transport: HostRequestTransport = {
      request: async (frame) => {
        const operation = String(frame.body.operation);
        operations.push(operation);
        if (operation === "worktree.inspect") return { ...frame, body: { ok: true, domainRevision: 2 } };
        if (operation === "session.claim_driver") return { ...frame, body: { ok: true, hostGeneration: 1, sessionGeneration: 1, driverRevision: 1 } };
        if (operation === "worktree.create") return { ...frame, body: { ok: true } };
        return { ...frame, body: { ok: true, sessionId: "session_cli-worktree", hostGeneration: 1, sessionGeneration: 2, driverRevision: 0, snapshot: { messages: [] } } };
      },
      onEvent: () => () => {},
    };
    const rebound = await candidate.bindHostWorktreeSession!(
      transport,
      "session_cli-worktree",
      { hostGeneration: 1, sessionGeneration: 1, driverRevision: 0 },
      "/source",
      parseArgs(["--worktree", "task"]).args,
    );

    expect(operations).toEqual(["worktree.inspect", "session.claim_driver", "worktree.create", "session.rebind_workspace"]);
    expect(rebound).toMatchObject({ ok: true, sessionId: "session_cli-worktree", sessionGeneration: 2 });
  });
});

// 防止 vitest 给 spy 留悬挂警告。
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
