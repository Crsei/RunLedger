/**
 * args.ts 单测 —— parseArgs 全分支覆盖 + error 通道 + 未知旗兜底。
 */

import { describe, expect, it } from "vitest";

import { parseArgs, USAGE } from "../../src/cli/args.ts";

describe("parseArgs 帮助/版本", () => {
  it("-h / --help 都设 help=true", () => {
    expect(parseArgs(["-h"]).args.help).toBe(true);
    expect(parseArgs(["--help"]).args.help).toBe(true);
  });

  it("-v / --version 都设 version=true", () => {
    expect(parseArgs(["-v"]).args.version).toBe(true);
    expect(parseArgs(["--version"]).args.version).toBe(true);
  });

  it("USAGE 字符串包含 runledger 字面量与 --help", () => {
    expect(USAGE).toContain("runledger");
    expect(USAGE).toContain("--help");
  });

  it("USAGE 不再宣传 resident Host 运维命令(R7)", () => {
    expect(USAGE).not.toContain("runledger host ");
    expect(USAGE).not.toContain("--confirm-active");
  });
});

describe("parseArgs 会话操作旗", () => {
  it("-c / --continue 设 continueRecent=true", () => {
    expect(parseArgs(["-c"]).args.continueRecent).toBe(true);
    expect(parseArgs(["--continue"]).args.continueRecent).toBe(true);
  });

  it("-r / --resume 设 resume=true", () => {
    expect(parseArgs(["-r"]).args.resume).toBe(true);
    expect(parseArgs(["--resume"]).args.resume).toBe(true);
  });

  it("--session <path> 给出字符串", () => {
    expect(parseArgs(["--session", "/a/b.jsonl"]).args.session).toBe("/a/b.jsonl");
  });

  it("--session 缺值 error 不空", () => {
    const r = parseArgs(["--session"]);
    expect(r.error).toContain("--session");
    expect(r.args.session).toBeUndefined();
  });

  it("--session-id <id> 给出字符串", () => {
    expect(parseArgs(["--session-id", "abc12345"]).args.sessionId).toBe("abc12345");
  });

  it("--fork <path> 给出字符串", () => {
    expect(parseArgs(["--fork", "/x.jsonl"]).args.fork).toBe("/x.jsonl");
  });
});

describe("parseArgs model/thinking/session-dir", () => {
  it("-m / --model 给值", () => {
    expect(parseArgs(["-m", "claude-sonnet-4-5"]).args.model).toBe("claude-sonnet-4-5");
    expect(parseArgs(["--model", "claude-haiku-4-5"]).args.model).toBe("claude-haiku-4-5");
  });

  it("--model 缺值 error", () => {
    expect(parseArgs(["--model"]).error).toContain("--model");
  });

  it("--thinking 合法值被接受", () => {
    for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseArgs(["--thinking", lvl]).args.thinking).toBe(lvl);
    }
  });

  it("--thinking 不合法值 error 包含输入值", () => {
    const r = parseArgs(["--thinking", "bogus"]);
    expect(r.error).toContain("bogus");
    expect(r.args.thinking).toBeUndefined();
  });

  it("--thinking 缺值 error", () => {
    expect(parseArgs(["--thinking"]).error).toContain("--thinking");
  });

  it("--session-dir 明确 error，不进入 unknown 或 args authority", () => {
    const r = parseArgs(["--session-dir", "/tmp/s"]);
    expect(r.error).toContain("--session-dir");
    expect(r.error).toContain("RUNLEDGER_DIR");
    expect(Object.hasOwn(r.args, "sessionDir")).toBe(false);
  });
});

describe("parseArgs debug / unknown / positional", () => {
  it("--debug 设 debug=true", () => {
    expect(parseArgs(["--debug"]).args.debug).toBe(true);
  });

  it("-- 后内容当 positional", () => {
    const r = parseArgs(["--", "--not-a-flag", "pos1"]);
    expect(r.args.positional).toEqual(["--not-a-flag", "pos1"]);
    expect(r.args.unknown.size).toBe(0);
  });

  it("未知长 flag --foo=bar 进 unknown map", () => {
    const r = parseArgs(["--foo=bar", "--baz"]);
    expect(r.args.unknown.get("foo")).toBe("bar");
    expect(r.args.unknown.get("baz")).toBe(true);
  });

  it("未知短 flag -x 进 unknown(去掉前导 -)", () => {
    const r = parseArgs(["-x"]);
    expect(r.args.unknown.get("x")).toBe(true);
  });

  it("裸 positional 不带前导 - 进 positional", () => {
    const r = parseArgs(["file.txt", "another"]);
    expect(r.args.positional).toEqual(["file.txt", "another"]);
  });
});

describe("parseArgs 多 flag 组合", () => {
  it("顺序与组合:--continue --model X --thinking high 一次性解析", () => {
    const r = parseArgs(["--continue", "--model", "X", "--thinking", "high"]);
    expect(r.args.continueRecent).toBe(true);
    expect(r.args.model).toBe("X");
    expect(r.args.thinking).toBe("high");
  });

  it("组合 --session 与 --fork 时两者都保留(实际 main() 互斥决策)", () => {
    const r = parseArgs(["--session", "/a.jsonl", "--fork", "/b.jsonl"]);
    expect(r.args.session).toBe("/a.jsonl");
    expect(r.args.fork).toBe("/b.jsonl");
    expect(r.error).toBeUndefined();
  });

  it("已知 flag 与未知混合:已知照常,未知兜底", () => {
    const r = parseArgs(["-c", "--custom-flag=42", "pos"]);
    expect(r.args.continueRecent).toBe(true);
    expect(r.args.unknown.get("custom-flag")).toBe("42");
    expect(r.args.positional).toEqual(["pos"]);
  });
});

describe("parseArgs security / worktree flags", () => {
  it("--permission-profile 接受内置与 named profile id 并拒绝非法 id", () => {
    expect(parseArgs(["--permission-profile", "workspace-write"]).args.permissionProfile).toBe("workspace-write");
    expect(parseArgs(["--permission-profile", "read-only"]).args.permissionProfile).toBe("read-only");
    expect(parseArgs(["--permission-profile", "team.review-prod"]).args.permissionProfile).toBe("team.review-prod");
    const bad = parseArgs(["--permission-profile", "bad/profile"]);
    expect(bad.error).toContain("--permission-profile");
    expect(bad.args.permissionProfile).toBeUndefined();
  });

  it("--approval-policy 接受四种 Codex 语义", () => {
    expect(parseArgs(["--approval-policy", "on-request"]).args.approvalPolicy).toBe("on-request");
    expect(parseArgs(["--approval-policy", "never"]).args.approvalPolicy).toBe("never");
    expect(parseArgs(["--approval-policy", "untrusted"]).args.approvalPolicy).toBe("untrusted");
    expect(parseArgs(["--approval-policy", "granular"]).args.approvalPolicy).toBe("granular");
    expect(parseArgs(["--approval-policy", "allow-all"]).error).toContain("--approval-policy");
  });

  it("--sandbox 接受枚举并拒绝未知", () => {
    expect(parseArgs(["--sandbox", "strict"]).args.sandbox).toBe("strict");
    expect(parseArgs(["--sandbox", "off"]).args.sandbox).toBe("off");
    expect(parseArgs(["--sandbox", "jail"]).error).toContain("--sandbox");
  });

  it("--network 接受 deny|allow|allowlist|review 并校验 allowlist host", () => {
    expect(parseArgs(["--network", "deny"]).args.network).toBe("deny");
    expect(parseArgs(["--network", "allow"]).args.network).toBe("allow");
    expect(parseArgs(["--network", "allowlist"]).error).toContain("--network-host");
    const allowlist = parseArgs(["--network", "allowlist", "--network-host", "api.example", "--network-host", "cdn.example"]);
    expect(allowlist.args.network).toBe("allowlist");
    expect(allowlist.args.networkHosts).toEqual(["api.example", "cdn.example"]);
    expect(parseArgs(["--network", "review"]).args.network).toBe("review");
    expect(parseArgs(["--network", "proxy"]).error).toContain("--network");
    expect(parseArgs(["--network", "deny", "--network-host", "api.example"]).error).toContain("deny");
  });

  it("USAGE advertises the expanded permission selections", () => {
    expect(USAGE).toContain("untrusted");
    expect(USAGE).toContain("granular");
    expect(USAGE).toContain("allowlist");
    expect(USAGE).toContain("review");
    expect(USAGE).toContain("named-profile-id");
    expect(USAGE).toContain("--network-host");
  });

  it("--worktree 无 label 时为空字符串,有 label 时取 label", () => {
    expect(parseArgs(["--worktree"]).args.worktree).toBe("");
    expect(parseArgs(["--worktree", "task-1"]).args.worktree).toBe("task-1");
    expect(parseArgs(["--worktree", "--model", "X"]).args.worktree).toBe("");
    expect(parseArgs(["--worktree", "task-1", "--model", "X"]).args.model).toBe("X");
  });

  it("--worktree-ref / --worktree-branch 透传", () => {
    const r = parseArgs(["--worktree", "task", "--worktree-ref", "main", "--worktree-branch", "feature/x"]);
    expect(r.args.worktreeRef).toBe("main");
    expect(r.args.worktreeBranch).toBe("feature/x");
  });

  it("--no-worktree 与 --worktree 互斥", () => {
    expect(parseArgs(["--no-worktree"]).args.noWorktree).toBe(true);
    const conflict = parseArgs(["--worktree", "t", "--no-worktree"]);
    expect(conflict.error).toContain("互斥");
  });

  it("security flags 组合解析", () => {
    const r = parseArgs(["--permission-profile", "read-only", "--approval-policy", "on-request", "--sandbox", "read-only", "--network", "deny"]);
    expect(r.args.permissionProfile).toBe("read-only");
    expect(r.args.approvalPolicy).toBe("on-request");
    expect(r.args.sandbox).toBe("read-only");
    expect(r.args.network).toBe("deny");
    expect(r.error).toBeUndefined();
  });
});
