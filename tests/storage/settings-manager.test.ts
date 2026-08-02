/** SettingsManager 单测 —— canonical user home / workspace locator。 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadProjectSettings,
	loadProjectSettingsSync,
	saveProjectSettings,
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
});
