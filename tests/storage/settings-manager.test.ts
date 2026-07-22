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
  DEFAULT_RUNTIME_FEATURES,
  resolveSessionCompatibilityDecision,
  sessionCompatibilityDecision,
  type SessionCompatibilityOperation,
  type SessionFormatVersion,
} from "../../src/runtime/runtime-features.ts";
import {
  loadMergedSettings,
  loadMergedSettingsSync,
  loadProjectSettings,
  loadProjectSettingsSync,
  loadUserSettings,
  loadUserSettingsSync,
  mergeUserAndProjectSettings,
  saveProjectSettings,
  saveUserSettings,
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

  it("只保留 runtimeFeatures 中已知且为 boolean 的字段", async () => {
    makeSettings(cwd, {
      runtimeFeatures: {
        sessionV3: true,
        workspaceContracts: false,
        artifactCas: "enabled",
        unknownFeature: true,
      },
    });

    expect(await loadProjectSettings(cwd)).toEqual({
      runtimeFeatures: {
        sessionV3: true,
        workspaceContracts: false,
      },
    });
  });

  it("保留合法 sessionV3 feature-state 与单调历史字段", async () => {
    makeSettings(cwd, {
      sessionV3FeatureState: "opt_in",
      sessionV3HighestActivatedState: "default",
    });
    expect(await loadProjectSettings(cwd)).toEqual({
      sessionV3FeatureState: "opt_in",
      sessionV3HighestActivatedState: "default",
    });

    makeSettings(cwd, {
      sessionV3FeatureState: "enabled",
      sessionV3HighestActivatedState: 3,
    });
    expect(await loadProjectSettings(cwd)).toEqual({});
  });
});

describe("runtime session compatibility rollout", () => {
  const versions: readonly SessionFormatVersion[] = [1, 2, 3];
  const operations: readonly SessionCompatibilityOperation[] = [
    "read",
    "append",
    "migrate_to_v3",
    "fork_to_v3",
    "downgrade",
  ];

  it("sessionV3 关闭时保留 v2 append 且禁止创建或迁移 v3", () => {
    expect(resolveSessionCompatibilityDecision(DEFAULT_RUNTIME_FEATURES, 2, "append")).toBe("allow");
    expect(resolveSessionCompatibilityDecision(DEFAULT_RUNTIME_FEATURES, 2, "migrate_to_v3")).toBe("deny");
    expect(resolveSessionCompatibilityDecision(DEFAULT_RUNTIME_FEATURES, 2, "fork_to_v3")).toBe("deny");
    expect(resolveSessionCompatibilityDecision(DEFAULT_RUNTIME_FEATURES, 3, "append")).toBe("deny");
    expect(resolveSessionCompatibilityDecision(DEFAULT_RUNTIME_FEATURES, 3, "read")).toBe("legacy_read_only");
  });

  it("sessionV3 开启时完整使用目标兼容矩阵", () => {
    const enabled = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
    for (const version of versions) {
      for (const operation of operations) {
        expect(resolveSessionCompatibilityDecision(enabled, version, operation)).toBe(
          sessionCompatibilityDecision(version, operation),
        );
      }
    }
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

describe("user and merged settings", () => {
  let cwd: string;
  let agentDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    cwd = tmpCwd();
    agentDir = tmpCwd();
    originalAgentDir = process.env.RUNLEDGER_DIR;
    process.env.RUNLEDGER_DIR = agentDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) delete process.env.RUNLEDGER_DIR;
    else process.env.RUNLEDGER_DIR = originalAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("loads and saves the bounded user schema without extension declarations", async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      provider: "user-provider",
      theme: "dark",
      plugins: ["must-not-live-in-settings"],
      skills: ["must-not-live-in-settings"],
      mcpServers: { unsafe: true },
      unknownField: "drop",
    }));

    expect(await loadUserSettings()).toEqual({ provider: "user-provider", theme: "dark" });
    expect(loadUserSettingsSync()).toEqual({ provider: "user-provider", theme: "dark" });

    await saveUserSettings({ model: "user-model", runtimeFeatures: { sessionV3: true } });
    expect(await loadUserSettings()).toEqual({ model: "user-model", runtimeFeatures: { sessionV3: true } });
    if (!IS_WIN) expect(statSync(join(agentDir, "settings.json")).mode & 0o777).toBe(0o600);
  });

  it("merges user defaults with project overrides and nested runtime feature keys", async () => {
    await saveUserSettings({
      provider: "user-provider",
      model: "user-model",
      theme: "dark",
      enabledModels: ["user-model"],
      runtimeFeatures: { sessionV3: true, workspaceContracts: false },
    });
    await saveProjectSettings(cwd, {
      model: "project-model",
      theme: "light",
      enabledModels: ["project-model"],
      runtimeFeatures: { workspaceContracts: true },
    });

    const expected = {
      provider: "user-provider",
      model: "project-model",
      theme: "light",
      enabledModels: ["project-model"],
      runtimeFeatures: { sessionV3: true, workspaceContracts: true },
    };
    expect(await loadMergedSettings(cwd)).toEqual(expected);
    expect(loadMergedSettingsSync(cwd)).toEqual(expected);
    expect(mergeUserAndProjectSettings(
      { provider: "user-provider", runtimeFeatures: { sessionV3: true } },
      { model: "project-model", runtimeFeatures: { artifactCas: true } },
    )).toEqual({
      provider: "user-provider",
      model: "project-model",
      runtimeFeatures: { sessionV3: true, artifactCas: true },
    });
  });
});
