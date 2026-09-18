/** SettingsManager 单测 —— canonical user home / workspace locator。 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadProjectSettings,
	loadProjectSettingsSync,
	mergeWebSearchSettings,
	recordingConfigDigest,
	resolveRecapSettings,
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

	it("round-trips user agentMode and rejects invalid or workspace defaults", async () => {
		await saveProjectSettings({ layout }, { agentMode: "minimal" });
		expect(await loadProjectSettings({ layout })).toMatchObject({ agentMode: "minimal" });
		await expect(saveProjectSettings({ layout, workspaceKey: "mode-workspace" }, { agentMode: "plan" })).rejects.toThrow("agentMode");
		writeFileSync(layout.settings, JSON.stringify({ agentMode: "unknown" }));
		await expect(loadProjectSettings({ layout })).rejects.toThrow("agentMode");
	});

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

	it("preserves user UI theme through other settings writes and drops workspace UI theme", async () => {
    const uiTheme = { preset: "neutral" as const, mode: "auto" as const, colors: { dark: { thinkingText: "#778899" } } };
    await saveProjectSettings({ layout }, { uiTheme, theme: "catppuccin-mocha" });
    const current = await loadProjectSettings({ layout });
    await saveProjectSettings({ layout }, { ...current, hideThinkingBlock: true });
    expect(loadProjectSettingsSync({ layout })).toMatchObject({ uiTheme, theme: "catppuccin-mocha", hideThinkingBlock: true });
    await saveProjectSettings({ layout, workspaceKey: "theme-test" }, { uiTheme });
    expect(await loadProjectSettings({ layout, workspaceKey: "theme-test" })).toEqual({});
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

	it("保留 canonical autoTitle 布尔开关并丢弃非法值", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ autoTitle: false, unknownAutoTitle: "off" }), "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({ autoTitle: false });

		writeFileSync(layout.settings, JSON.stringify({ autoTitle: "false" }), "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("保留 hideThinkingBlock 布尔开关并丢弃非法值", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ hideThinkingBlock: true }), "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({ hideThinkingBlock: true });

		for (const invalid of ["yes", 1, null]) {
			writeFileSync(layout.settings, JSON.stringify({ hideThinkingBlock: invalid }), "utf8");
			expect(await loadProjectSettings({ layout })).toEqual({});
		}
	});

	it("加载 Logo 字母配置并归一化大小写，丢弃非法值", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, JSON.stringify({ logo: "RUNLEDGER" }), "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({ logo: "runledger" });

		for (const invalid of ["run ledger", "runledger1", "", 1, null]) {
			writeFileSync(layout.settings, JSON.stringify({ logo: invalid }), "utf8");
			expect(await loadProjectSettings({ layout })).toEqual({});
		}
	});

	it("加载 canonical recap 配置并保留合法 enabled/idleSeconds", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(
			layout.settings,
			JSON.stringify({ recap: { enabled: false, idleSeconds: 600 }, unknownRecap: true }),
			"utf8",
		);

		expect(await loadProjectSettings({ layout })).toEqual({
			recap: { enabled: false, idleSeconds: 600 },
		});
	});

	it("保存 recap 配置到用户级 canonical settings", async () => {
		await saveProjectSettings(
			{ layout },
			{ recap: { enabled: true, idleSeconds: 120 } } as never,
		);

		expect(await loadProjectSettings({ layout })).toEqual({
			recap: { enabled: true, idleSeconds: 120 },
		});
	});

	it("将 recap 延迟解析为有限整数秒并限制到安全范围", () => {
		expect(resolveRecapSettings({})).toEqual({ enabled: true, idleSeconds: 240 });
		expect(resolveRecapSettings({ recap: { enabled: false, idleSeconds: 120.9 } })).toEqual({
			enabled: false,
		idleSeconds: 120,
	});
		expect(resolveRecapSettings({ recap: { idleSeconds: 0 } })).toEqual({ enabled: true, idleSeconds: 1 });
		expect(resolveRecapSettings({ recap: { idleSeconds: 99999 } })).toEqual({ enabled: true, idleSeconds: 3600 });
	});

	it("recording 含未知字段时关闭记录", async () => {
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
			recording: { mode: "off", failurePolicy: "best_effort" },
		});
	});

	it("recording 缺省开启而非法配置关闭", async () => {
		expect(resolveRecordingConfig({})).toEqual({
			mode: "events",
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

		expect(await loadProjectSettings({ layout })).toMatchObject({ recording: { mode: "off" } });
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

	it("损坏 JSON 关闭 recording,不抛错", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, "{ this is { not valid JSON", "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({ recording: { mode: "off" } });
	});

	it("JSON 是数组或字符串而非对象时关闭 recording", async () => {
		mkdirSync(layout.home, { recursive: true });
		writeFileSync(layout.settings, "[1,2,3]", "utf8");
		expect(await loadProjectSettings({ layout })).toEqual({ recording: { mode: "off" } });
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

	it("往返保存 hideThinkingBlock 到 canonical settings", async () => {
		await saveProjectSettings({ layout }, { hideThinkingBlock: true });
		expect(await loadProjectSettings({ layout })).toEqual({ hideThinkingBlock: true });
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
		)).rejects.toMatchObject({
			code: "unsupported_setting",
			field: "recording",
		});
		expect(existsSync(join(layout.projects, "ws-fixture", "settings.json"))).toBe(false);
	});

	it("拒绝保存非法用户级 recording 值", async () => {
		await expect(saveProjectSettings(
			{ layout },
			{ recording: { mode: "invalid", failurePolicy: "best_effort" } } as never,
		)).rejects.toMatchObject({
			code: "unsupported_setting",
			field: "recording",
		});
		expect(existsSync(layout.settings)).toBe(false);
	});
});

describe("skills provider policy settings", () => {
	let cwd: string;
	let layout: RunledgerLayout;

	beforeEach(() => {
		cwd = tmpCwd();
		layout = canonicalFixture(cwd);
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	it("加载并持久化 versioned skills policy", async () => {
		const settings = { skills: { enabled: true, providers: { "runledger-user": true, "runledger-workspace": false } } };
		await saveProjectSettings({ layout }, settings);
		expect(await loadProjectSettings({ layout })).toEqual(settings);
	});

	it("丢弃非法 skills 结构而不拒绝整个 settings", async () => {
		await saveProjectSettings({ layout }, { model: "x" });
		writeFileSync(layout.settings, JSON.stringify({ model: "y", skills: { providers: { "bad id!": true } } }), { mode: 0o600 });
		const loaded = await loadProjectSettings({ layout });
		expect(loaded.model).toBe("y");
		expect(loaded.skills).toBeUndefined();
	});

	it("接受空 skills 节点并解析为空对象", async () => {
		await saveProjectSettings({ layout }, {});
		writeFileSync(layout.settings, JSON.stringify({ skills: {} }), { mode: 0o600 });
		expect(await loadProjectSettings({ layout })).toEqual({});
	});

	it("skills policy 可在 workspace settings 保存与加载", async () => {
		const workspace = { workspaceKey: "ws-fixture" };
		const settings = { skills: { providers: { "runledger-workspace": false } } };
		await saveProjectSettings({ layout, ...workspace }, settings);
		expect(await loadProjectSettings({ layout, ...workspace })).toEqual(settings);
		expect(await loadProjectSettings({ layout })).toEqual({});
	});
});

describe("plugin settings value layer", () => {
	it("round-trips declared plugin setting values", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			await saveProjectSettings({ layout }, {
				plugins: { values: { "alpha@local": { theme: "dark", retries: 3, strict: true } } },
			});
			const loaded = await loadProjectSettings({ layout });
			expect(loaded.plugins?.values?.["alpha@local"]).toEqual({ theme: "dark", retries: 3, strict: true });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("drops only the invalid entries instead of the whole value layer", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			// 手写 settings：一条合法、一条含非法类型、一条整体不是对象。
			writeFileSync(layout.settings, JSON.stringify({
				plugins: { values: {
					"alpha@local": { theme: "dark", bogus: { nested: true } },
					"beta@local": "not-an-object",
					"gamma@local": { flag: false, count: 2 },
				} },
			}), "utf8");
			const loaded = await loadProjectSettings({ layout });
			expect(loaded.plugins?.values?.["alpha@local"]).toEqual({ theme: "dark" });
			expect(loaded.plugins?.values?.["beta@local"]).toBeUndefined();
			expect(loaded.plugins?.values?.["gamma@local"]).toEqual({ flag: false, count: 2 });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the key absent when nothing usable is stored", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			await saveProjectSettings({ layout }, { plugins: { values: {} } });
			const loaded = await loadProjectSettings({ layout });
			expect(loaded.plugins).toBeUndefined();
			// 仍有其它键可写：空值层不应让整个 settings 写入失败。
			await saveProjectSettings({ layout }, { plugins: { values: { "alpha@local": { theme: "light" } } } });
			expect((await loadProjectSettings({ layout })).plugins?.values?.["alpha@local"]).toEqual({ theme: "light" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("plugin watch setting", () => {
	it("is absent by default and round-trips when set", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			expect((await loadProjectSettings({ layout })).plugins).toBeUndefined();
			await saveProjectSettings({ layout }, { plugins: { watch: true } });
			expect((await loadProjectSettings({ layout })).plugins?.watch).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the watch flag when it is the only declared key and drops a non-boolean", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			writeFileSync(layout.settings, JSON.stringify({ plugins: { watch: "yes" } }), "utf8");
			expect((await loadProjectSettings({ layout })).plugins).toBeUndefined();
			writeFileSync(layout.settings, JSON.stringify({ plugins: { watch: false, values: { "alpha@local": { theme: "dark" } } } }), "utf8");
			const loaded = await loadProjectSettings({ layout });
			expect(loaded.plugins?.watch).toBe(false);
			expect(loaded.plugins?.values?.["alpha@local"]).toEqual({ theme: "dark" });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("marketplace autoUpdate setting", () => {
	it("round-trips the mode and defaults to absent (off) when unset", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			expect((await loadProjectSettings({ layout })).marketplace).toBeUndefined();
			await saveProjectSettings({ layout }, { marketplace: { autoUpdate: "notify" } });
			expect((await loadProjectSettings({ layout })).marketplace?.autoUpdate).toBe("notify");
			await saveProjectSettings({ layout }, { marketplace: { autoUpdate: "auto" } });
			expect((await loadProjectSettings({ layout })).marketplace?.autoUpdate).toBe("auto");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects an unknown mode loudly and ignores unknown sibling keys", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			// 非法枚举与 agentMode/compaction 一样 fail loud，而不是静默降级成 off。
			writeFileSync(layout.settings, JSON.stringify({ marketplace: { autoUpdate: "sometimes" } }), "utf8");
			await expect(loadProjectSettings({ layout })).rejects.toThrow(/off\|notify\|auto/u);
			await expect(saveProjectSettings({ layout }, { marketplace: { autoUpdate: "sometimes" as "off" } })).rejects.toThrow(/off\|notify\|auto/u);
			writeFileSync(layout.settings, JSON.stringify({ marketplace: { autoUpdate: "notify", unknown: 1 } }), "utf8");
			expect((await loadProjectSettings({ layout })).marketplace?.autoUpdate).toBe("notify");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("webSearch settings", () => {
	it("preserves user-layer order/exclude/timeout/searxng through a save+load round-trip", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			// 回归：webSearch 曾被 sanitizer 整体丢弃，导致 domain.ts 的
			// `options.settings.webSearch` 永远为 undefined，配置静默失效。
			await saveProjectSettings({ layout }, {
				webSearch: {
					order: ["exa", "brave"],
					exclude: ["searxng"],
					timeoutSeconds: 12,
					searxng: { endpoint: "https://searx.example/", language: "zh", safesearch: 1 },
				},
			});
			expect((await loadProjectSettings({ layout })).webSearch).toEqual({
				order: ["exa", "brave"],
				exclude: ["searxng"],
				timeoutSeconds: 12,
				searxng: { endpoint: "https://searx.example/", language: "zh", safesearch: 1 },
			});
			expect(loadProjectSettingsSync({ layout }).webSearch?.timeoutSeconds).toBe(12);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("dedupes provider ids, keeps first-seen order and drops malformed sub-keys", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			writeFileSync(
				layout.settings,
				JSON.stringify({ webSearch: { order: ["exa", "exa", "", 7, "brave"], exclude: "searxng", timeoutSeconds: 0 } }),
				"utf8",
			);
			// exclude 不是数组、timeoutSeconds 非正数 -> 子键丢弃；order 去重后保留。
			expect((await loadProjectSettings({ layout })).webSearch).toEqual({ order: ["exa", "brave"] });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("keeps the key absent when nothing usable survives sanitizing", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			writeFileSync(layout.settings, JSON.stringify({ webSearch: { order: [], timeoutSeconds: -1, searxng: { endpoint: "" } } }), "utf8");
			expect((await loadProjectSettings({ layout })).webSearch).toBeUndefined();
			writeFileSync(layout.settings, JSON.stringify({ webSearch: "exa" }), "utf8");
			expect((await loadProjectSettings({ layout })).webSearch).toBeUndefined();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("lets the workspace layer narrow with exclude only and drops user-authority sub-keys", async () => {
		const cwd = tmpCwd();
		try {
			const layout = canonicalFixture(cwd);
			mkdirSync(layout.home, { recursive: true, mode: 0o700 });
			await saveProjectSettings({ layout, workspaceKey: "ws-websearch" }, {
				webSearch: {
					order: ["exa"],
					exclude: ["brave"],
					timeoutSeconds: 30,
					searxng: { endpoint: "https://searx.example/" },
				},
			});
			expect((await loadProjectSettings({ layout, workspaceKey: "ws-websearch" })).webSearch).toEqual({ exclude: ["brave"] });
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("mergeWebSearchSettings", () => {
	it("returns the user value untouched when the workspace has no exclude", () => {
		const user = Object.freeze({ order: Object.freeze(["exa"]), timeoutSeconds: 5 });
		expect(mergeWebSearchSettings(user, undefined)).toBe(user);
		expect(mergeWebSearchSettings(user, Object.freeze({}))).toBe(user);
		expect(mergeWebSearchSettings(user, Object.freeze({ exclude: Object.freeze([]) }))).toBe(user);
	});

	it("unions the workspace exclude without dropping user authority", () => {
		expect(
			mergeWebSearchSettings(
				{ order: ["exa", "brave"], exclude: ["searxng"], timeoutSeconds: 8 },
				{ exclude: ["brave", "duckduckgo"] },
			),
		).toEqual({ order: ["exa", "brave"], exclude: ["searxng", "brave", "duckduckgo"], timeoutSeconds: 8 });
	});

	it("produces an exclude-only value when only the workspace declares one", () => {
		expect(mergeWebSearchSettings(undefined, { exclude: ["brave"] })).toEqual({ exclude: ["brave"] });
		expect(mergeWebSearchSettings(undefined, undefined)).toBeUndefined();
	});
});
