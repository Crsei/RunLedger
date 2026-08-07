/**
 * ExecutionEnv 单测 —— 验证 localExecutionEnv 的 fs 基本 API 与 shell
 * `echo` 命令在当前平台可执行。
 *
 * 跨平台约定:echo 在 Windows git-bash 与 Linux/macOS bash/sh 都可用,
 * 因此 shell.exec("echo hello") 应稳定输出 `hello\n`。
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { localExecutionEnv } from "../src/runtime/execution-env.ts";

describe("localExecutionEnv", () => {
  it("fs.writeFile / fs.stat / fs.readFile 往返一致", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-"));
    try {
      const env = localExecutionEnv(dir);
      const p = path.join(dir, "hello.txt");
      await env.fs.writeFile(p, "hello world");
      const s = await env.fs.stat(p);
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.size).toBe("hello world".length);
      const buf = await env.fs.readFile(p);
      expect(buf.toString("utf8")).toBe("hello world");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fs.mkdir recursive + readdir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-mkdir-"));
    try {
      const env = localExecutionEnv(dir);
      const sub = path.join(dir, "a", "b", "c");
      await env.fs.mkdir(sub, { recursive: true });
      const listing = await env.fs.readdir(path.join(dir, "a"));
      expect(listing).toContain("b");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shell.exec echo 输出 stdin 文本", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-shell-"));
    try {
      const env = localExecutionEnv(dir);
      const r = await env.shell.exec("echo hello", { timeoutMs: 5000 });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shell.exec stdin 注入", { skip: process.platform === "win32" }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-stdin-"));
    try {
      const env = localExecutionEnv(dir);
      const r = await env.shell.exec("cat", { stdin: "ping", timeoutMs: 5000 });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe("ping");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shell.exec 失败命令 exitCode 非 0", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-fail-"));
    try {
      const env = localExecutionEnv(dir);
      const r = await env.shell.exec("false", { timeoutMs: 5000 });
      expect(r.exitCode).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shell.exec 与 fs 联动:写文件 → ls 读回", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runledger-env-integ-"));
    try {
      const env = localExecutionEnv(dir);
      const file = path.join(dir, "via-shell.txt");
      await env.shell.exec(`echo constant > ${JSON.stringify(file).replace(/"/g, "")}`, { timeoutMs: 5000 });
      // 直接通过 fs.readFile 验证
      const buf = await readFile(file);
      expect(buf.toString("utf8").trim()).toBe("constant");
      // 与 fs 写文件读出的 stat 比对
      const s = await stat(file);
      expect(s.isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
