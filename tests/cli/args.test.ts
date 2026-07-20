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

  it("--session-dir <dir> 给字符串", () => {
    expect(parseArgs(["--session-dir", "/tmp/s"]).args.sessionDir).toBe("/tmp/s");
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
