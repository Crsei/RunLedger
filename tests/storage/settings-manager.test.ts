/** SettingsManager 单测 —— canonical user home / workspace locator。 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadProjectSettings,
	loadProjectSettingsSync,
	recordingConfigDigest,
	resolveRecordingConfig,
	saveProjectSettings,
	SettingsStorageError,
} from "../../src/storage/settings-manager.ts";
import { buildRunledgerLayout, type RunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";

const IS_WIN = process.platform === "win32";

function tmpCwd(): string {
	return mkdtempSync(join(tmpdir(), "rl-settings-"));
}

function canonicalFixture(cwd: string): RunledgerLayout {
	return buildRunledgerLayout(join(cwd, "home"), "posix");
}

describe("loadProjectSettings", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	it("accepts a Codex syntax theme name and drops unsafe path-like theme values", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ theme: "catppuccin-mocha" }));
		expect(await loadProjectSettings({ layout })).toEqual({ theme: "catppuccin-mocha" });
		writeFileSync(layout.settings, JSON.stringify({ theme: "../outside" }));
		expect(await loadProjectSettings({ layout })).toEqual({});
		writeFileSync(layout.settings, JSON.stringify({ theme: "bad..name" }));
		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("round-trips a safe custom syntax theme name until composition validates its bytes", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ theme: "company-audit" }));
		expect(await loadProjectSettings({ layout })).toEqual({ theme: "company-audit" });
		await saveProjectSettings({ layout }, { theme: "company-audit" });
		expect(loadProjectSettingsSync({ layout })).toEqual({ theme: "company-audit" });
	});

	beforeEach(() => {
		cwd = tmpCwd();
		layout = canonicalFixture(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("canonical 文件不存在时返回空对象", async () => {
		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("加载合法 canonical settings 并清洗 legacy/未知字段", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(
			layout.settings,
			JSON.stringify({
				model: "claude-sonnet-4-5",
				thinkingLevel: "medium",
				theme: "dark",
				sessionDir: ".out/sessions",
				enabledModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
				unknownField: "should be dropped",
			}),
			"utf8",
		);

		expect(await loadProjectSettings({ layout })).toEqual({
			model: "claude-sonnet-4-5",
			thinkingLevel: "medium",
			theme: "dark",
			enabledModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
		});
	});

	it("加载用户级 recording 配置", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(
			layout.settings,
			JSON.stringify({
				recording: {
					mode: "events",
					failurePolicy: "fail_closed",
					unknownField: true,
				},
			}),
			"utf8",
		);

		expect(await loadProjectSettings({ layout })).toEqual({
			recording: { mode: "events", failurePolicy: "fail_closed" },
		});
	});

	it("recording 缺失或非法时解析为安全默认值", async () => {
		expect(resolveRecordingConfig({})).toEqual({
			mode: "off",
			failurePolicy: "best_effort",
		});
		expect(resolveRecordingConfig({
			recording: { mode: "invalid", failurePolicy: "invalid" },
		} as never)).toEqual({
			mode: "off",
			failurePolicy: "best_effort",
		});
	});

	it("加载非法 recording 时输出有界诊断且不回显原值", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({
			recording: { mode: "secret-invalid-mode", failurePolicy: "best_effort" },
		}), "utf8");
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		expect(await loadProjectSettings({ layout })).toEqual({});
		const diagnostic = write.mock.calls.map((call) => String(call[0])).join("");
		expect(diagnostic).toContain("invalid_recording_settings");
		expect(diagnostic).not.toContain("secret-invalid-mode");
		write.mockRestore();
	});

	it("为有效 recording 快照生成稳定 digest", () => {
		const config = resolveRecordingConfig({
			recording: { mode: "events", failurePolicy: "best_effort" },
		});
		expect(recordingConfigDigest(config)).toMatch(/^[a-f0-9]{64}$/u);
		expect(recordingConfigDigest(config)).toBe(recordingConfigDigest({ ...config }));
		expect(recordingConfigDigest(config)).not.toBe(recordingConfigDigest({
			mode: "off",
			failurePolicy: "best_effort",
		}));
	});

	it("损坏 JSON 回退空 settings,不抛错", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, "{ this is { not valid JSON", "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("JSON 是数组或字符串而非对象时回退空", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, "[1,2,3]", "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({});
	});
});

describe("loadProjectSettingsSync", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => {
		cwd = tmpCwd();
		layout = canonicalFixture(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("同步版读取 canonical 文件", () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ model: "m1", thinkingLevel: "high" }), "utf8");
		expect(loadProjectSettingsSync({ layout })).toEqual({ model: "m1", thinkingLevel: "high" });
	});

	it("同步版无文件时返回空对象", () => {
		expect(loadProjectSettingsSync({ layout })).toEqual({});
	});
});

describe("saveProjectSettings", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => {
		cwd = tmpCwd();
		layout = canonicalFixture(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("保存后从同一 canonical locator 重新加载字段一致", async () => {
		const input = {
			model: "claude-haiku-4-5",
			thinkingLevel: "minimal" as const,
			theme: "light" as const,
			enabledModels: ["claude-haiku-4-5"],
		};
		await saveProjectSettings({ layout }, input);
		expect(await loadProjectSettings({ layout })).toEqual(input);
	});

	it("写入 canonical settings 文件 mode 为 0o600(unix)", async () => {
		if (IS_WIN) return;
		await saveProjectSettings({ layout }, { model: "x" });
		const st = statSync(layout.settings);
		expect(st.mode & 0o777).toBe(0o600);
		expect(existsSync(join(cwd, ".runledger", "settings.json"))).toBe(false);
	});

	it("保存 workspace settings 时只创建固定 projects/<key> 子树", async () => {
		await saveProjectSettings({ layout, workspaceKey: "ws-fixture" }, { theme: "dark" });
		expect(existsSync(join(layout.projects, "ws-fixture", "settings.json"))).toBe(true);
		expect(existsSync(join(cwd, ".runledger"))).toBe(false);
	});

	it("拒绝在 workspace settings 保存 recording authority", async () => {
		await expect(saveProjectSettings(
			{ layout, workspaceKey: "ws-fixture" },
			{ recording: { mode: "events", failurePolicy: "best_effort" } },
		)).rejects.toMatchObject<Partial<SettingsStorageError>>({
			code: "unsupported_setting",
			field: "recording",
		});
		expect(existsSync(join(layout.projects, "ws-fixture", "settings.json"))).toBe(false);
	});

	it("拒绝保存非法用户级 recording 值", async () => {
		await expect(saveProjectSettings(
			{ layout },
			{ recording: { mode: "invalid", failurePolicy: "best_effort" } } as never,
		)).rejects.toMatchObject<Partial<SettingsStorageError>>({
			code: "unsupported_setting",
			field: "recording",
		});
		expect(existsSync(layout.settings)).toBe(false);
	});
});
