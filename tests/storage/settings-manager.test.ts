/**
 * SettingsManager 单测 —— 加载 / 落盘 / 损坏文件回退。
 *
 * 用临时目录隔离每个测试,不污染项目自有 .runledger。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadProjectSettings,
  loadProjectSettingsSync,
  saveProjectSettings,
} from "../../src/storage/settings-manager.ts";

// Windows 上 chmod 不生效,mode 校验跳过即可。
const IS_WIN = process.platform === "win32";

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), "rl-settings-"));
}

function makeSettings(cwd: string, raw: Record<string, unknown>): void {
  mkdirSync(join(cwd, ".runledger"), { recursive: true });
  writeFileSync(
    join(cwd, ".runledger", "settings.json"),
    JSON.stringify(raw),
    "utf8",
  );
}

describe("loadProjectSettings", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpCwd();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("文件不存在时返回空对象", async () => {
    const out = await loadProjectSettings(cwd);
    expect(out).toEqual({});
  });

  it("加载合法 settings.json 并清洗为 ProjectSettings", async () => {
    const raw = {
      model: "claude-sonnet-4-5",
      thinkingLevel: "medium",
      theme: "dark",
      sessionDir: ".out/sessions",
      enabledModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
      // 未知字段应被丢弃
      unknownField: "should be dropped",
      // 类型不符的字段应被忽略
      theme2: "dark-blue",
    };
    makeSettings(cwd, raw);

    const out = await loadProjectSettings(cwd);
    expect(out).toEqual({
      model: "claude-sonnet-4-5",
      thinkingLevel: "medium",
      theme: "dark",
      sessionDir: ".out/sessions",
      enabledModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    });
  });

  it("损坏 JSON 回退空 settings,不抛错(只写 stderr)", async () => {
    mkdirSync(join(cwd, ".runledger"), { recursive: true });
    writeFileSync(
      join(cwd, ".runledger", "settings.json"),
      "{ this is { not valid JSON",
      "utf8",
    );
    const out = await loadProjectSettings(cwd);
    expect(out).toEqual({});
  });

  it("JSON 是数组或字符串而非对象时回退空", async () => {
    mkdirSync(join(cwd, ".runledger"), { recursive: true });
    writeFileSync(
      join(cwd, ".runledger", "settings.json"),
      "[1,2,3]",
      "utf8",
    );
    expect(await loadProjectSettings(cwd)).toEqual({});
  });
});

describe("loadProjectSettingsSync", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpCwd();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("同步版与异步版行为一致:文件存在 return parsed", () => {
    makeSettings(cwd, { model: "m1", thinkingLevel: "high" });
    const out = loadProjectSettingsSync(cwd);
    expect(out).toEqual({ model: "m1", thinkingLevel: "high" });
  });

  it("同步版无文件时返回空对象", () => {
    expect(loadProjectSettingsSync(cwd)).toEqual({});
  });
});

describe("saveProjectSettings", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = tmpCwd();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("保存后重新加载字段一致", async () => {
    const input = {
      model: "claude-haiku-4-5",
      thinkingLevel: "minimal" as const,
      theme: "light" as const,
      sessionDir: ".sessions",
      enabledModels: ["claude-haiku-4-5"],
    };
    await saveProjectSettings(cwd, input);
    const out = await loadProjectSettings(cwd);
    expect(out).toEqual(input);
  });

  it("写入文件 mode 为 0o600(unix)", async () => {
    if (IS_WIN) return; // win chmod 无效
    await saveProjectSettings(cwd, { model: "x" });
    expect(existsSync(join(cwd, ".runledger", "settings.json"))).toBe(true);
    const st = statSync(join(cwd, ".runledger", "settings.json"));
    const permissionBits = st.mode & 0o777;
    expect(permissionBits).toBe(0o600);
  });

  it("保存后 .runledger 目录创建", async () => {
    expect(existsSync(join(cwd, ".runledger"))).toBe(false);
    await saveProjectSettings(cwd, { theme: "dark" });
    expect(existsSync(join(cwd, ".runledger"))).toBe(true);
    expect(existsSync(join(cwd, ".runledger", "settings.json"))).toBe(true);
  });
});
