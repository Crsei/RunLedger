# RunLedger Welcome 页面实现计划

> 状态：`implemented`（当前工作树，2026-08-20，未提交）。LOGO、tips、响应式两栏 WelcomeComponent、recent sessions 静默刷新、模型标签刷新及 create-only CLI 装配均已完成；完整 Bun 原生套件 17 files / 126 tests passed，正式 build 与隔离 TTY fresh-create 验证通过。提交步骤保持未勾选，因为用户未授权创建 commit。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 RunLedger TUI 新增 welcome 页面：两栏盒式布局 + Tip 行（结构照抄 oh-my-pi `WelcomeComponent`），LOGO 采用 opencode 双段逐字符着色结构（`RUN` dim + `LEDGER` bold）。

**Architecture:** 新建三个纯渲染模块（`logo.ts` / `welcome-tips.ts` / `welcome.ts`），实现 RunLedger 的 `Component` 接口（`render(width): string[]`），主题通过 props 注入（RunLedger 既有组件惯例，见 `footer.ts`）。装配在 `InteractiveMode.assembleTree()` 中：把 `WelcomeComponent` 挂到 `header` Container 下，仅在全新启动（`sessionOpenMode(args) === "create"`）时显示；recent sessions 通过现有 `createEffect("session.list")` 工作流静默拉取，模型标签在 `/model` 选择后经 `setModel` 刷新。

**Tech Stack:** Bun（`bun:test`）、Node.js/tsx CLI、TypeScript、RunLedger pi-tui 原语（`primitives.ts`）、21 色槽 `Theme` + `theme/ansi.ts` SGR helpers。`tips.txt` 通过 `readFileSync(new URL(..., import.meta.url))` 加载，以同时兼容 Bun、源码 tsx 与编译后的 Node CLI。

## Global Constraints

- 目录：所有新文件都在 `RunLedger/src/tui/` 下，测试在 `RunLedger/tests/tui/` 下。
- 组件必须实现 `Component` 接口：`render(width: number): string[]`（`RunLedger/src/tui/primitives.ts:22`）。
- 主题一律经 props 注入的 `Theme`（21 个 hex 色槽）着色，经 `theme/ansi.ts` 的 `wrapFg / wrapBold / wrapDim / wrapItalic`；禁止硬编码 SGR 颜色字符串。
- 任何 `render()` 返回的行都不得超出请求宽度（内部用 `render-width.ts` 的 `fitToWidth` + `primitives.ts` 的 `truncateToWidth` 兜底）。
- 渲染结果按宽度缓存，返回稳定数组引用；数据变化经 setter + `invalidate()` 失效。
- tips 内容复用现有 `src/tui/components/tips.txt`（约 100 行中文 tip）；源码与 dist 均以 `readFileSync(new URL("./tips.txt", import.meta.url), "utf8")` 加载，构建通过 `build:tui-assets` 把资源复制到 `dist/tui/components/tips.txt`。
- 测试用 `bun:test`，文件名 `*.bun.test.ts`（`npm run test:tui-native` 的 `scripts/run-tui-bun-tests.mjs` 会拾取）；测试只调 `render()` 与纯函数，不启动 TUI。
- 每任务结束跑 `bun test <文件>` 并提交；全部完成后跑 `npm run check && npm test && npm run build`。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/tui/components/logo.ts` | opencode 风格双段 LOGO 数据 + 逐字符着色渲染（新增） |
| `src/tui/components/welcome-tips.ts` | tips.txt 加载/过滤/随机挑选 + Tip 行渲染（新增） |
| `src/tui/components/welcome.ts` | `WelcomeComponent`：两栏盒 + Tip 行（新增） |
| `src/tui/index.ts` | 导出新组件（修改） |
| `src/tui/interactive-mode.ts` | 装配 welcome 到 header、version/showWelcome 选项、recent sessions 静默刷新、setModel 钩子（修改） |
| `src/cli/main.ts` | 传 `version` 与 `showWelcome`（修改） |
| `scripts/copy-tui-assets.ts` / `package.json` | build 后复制 `tips.txt` 到 dist（新增/修改） |
| `tests/tui/logo.bun.test.ts` | LOGO 结构/着色测试（新增） |
| `tests/tui/welcome-tips.bun.test.ts` | tips 加载/挑选/渲染测试（新增） |
| `tests/tui/welcome.bun.test.ts` | WelcomeComponent 布局/缓存/溢出测试（新增） |

---

### Task 1: LOGO 模块

**Files:**
- Create: `RunLedger/src/tui/components/logo.ts`
- Test: `RunLedger/tests/tui/logo.bun.test.ts`

**Interfaces:**
- Produces: `logo`（`{ left: readonly string[]; right: readonly string[] }`）、`LOGO_GAP = 1`、`logoLineWidth(): number`、`renderLogo(theme: Theme): string[]`

- [x] **Step 1: 写失败测试**

`tests/tui/logo.bun.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { LOGO_GAP, logo, logoLineWidth, renderLogo } from "../../src/tui/components/logo.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

describe("RunLedger logo (opencode-style)", () => {
	test("left and right halves have equal non-zero row counts", () => {
		expect(logo.left.length).toBe(logo.right.length);
		expect(logo.left.length).toBeGreaterThan(0);
	});

	test("each row is non-empty and rows are equal width within each half", () => {
		const leftWidth = visibleWidth(logo.left[0] ?? "");
		for (const line of logo.left) {
			expect(visibleWidth(line)).toBe(leftWidth);
			expect(line.length).toBeGreaterThan(0);
		}
		const rightWidth = visibleWidth(logo.right[0] ?? "");
		for (const line of logo.right) {
			expect(visibleWidth(line)).toBe(rightWidth);
			expect(line.length).toBeGreaterThan(0);
		}
	});

	test("logoLineWidth is left + gap + right", () => {
		expect(logoLineWidth()).toBe(
			visibleWidth(logo.left[0] ?? "") + LOGO_GAP + visibleWidth(logo.right[0] ?? ""),
		);
	});

	test("renderLogo paints per-char colors and preserves row widths", () => {
		const lines = renderLogo(theme);
		expect(lines.length).toBe(logo.left.length);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(logoLineWidth());
			expect(line).toContain("\x1b[");
		}
	});
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/logo.bun.test.ts`
Expected: FAIL，`logo` / `renderLogo` 未定义（模块不存在）。

- [x] **Step 3: 实现 logo.ts**

`src/tui/components/logo.ts`：

```ts
import { visibleWidth } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapBold, wrapDim, wrapFg } from "../theme/ansi.ts";

/**
 * opencode 风格双段 LOGO（结构参考 opencode/packages/tui/src/logo.ts）：
 * left 段 "RUN"（dim 弱化）+ right 段 "LEDGER"（bold 强调），逐字符着色。
 * 字符集（█▀▄_^ 与空格）均为单列宽；两段行数一致，拼接时以 1 空格分隔。
 */
export const logo = {
	left: [
		"█▀▀█ █▀▀█ █▀▀█",
		"█▀▀▀ █__█ █^^█",
		"▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
	],
	right: [
		"█▀▀█ █▀▀▀ █▀▀▄ █▀▀▄ █▀▀▀ █▀▀█",
		"█▀▀▀ █▀▀▀ █__█ █▀▀█ █▀▀▀ █▀▀▀",
		"▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
	],
} as const;

/** left 与 right 之间的列间距。 */
export const LOGO_GAP = 1;

/** 拼接后的单行可见宽度（未着色）。 */
export function logoLineWidth(): number {
	const left = visibleWidth(logo.left[0] ?? "");
	const right = visibleWidth(logo.right[0] ?? "");
	return left + LOGO_GAP + right;
}

function paint(line: string, style: (text: string) => string): string {
	let out = "";
	for (const char of line) {
		out += char === " " ? char : style(char);
	}
	return out;
}

/**
 * 逐字符着色渲染：left 段 muted+dim，right 段 primary+bold（opencode 同款两段对比）。
 * 返回与 logo.left 等长的行数组。
 */
export function renderLogo(theme: Theme): string[] {
	const dim = (text: string) => wrapDim(wrapFg(theme.muted)(text));
	const bright = (text: string) => wrapBold(wrapFg(theme.primary)(text));
	return logo.left.map((line, index) => {
		const left = paint(line, dim);
		const right = paint(logo.right[index] ?? "", bright);
		return `${left}${" ".repeat(LOGO_GAP)}${right}`;
	});
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test tests/tui/logo.bun.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/logo.ts tests/tui/logo.bun.test.ts
git commit -m "feat(tui): add opencode-style two-part logo module"
```

---

### Task 2: Tips 模块

**Files:**
- Create: `RunLedger/src/tui/components/welcome-tips.ts`
- Test: `RunLedger/tests/tui/welcome-tips.bun.test.ts`

**Interfaces:**
- Consumes: `Theme`（`../theme/theme.ts`）、`wrapFg / wrapItalic`（`../theme/ansi.ts`）、`visibleWidth / wrapTextWithAnsi`（`../primitives.ts`）、`./tips.txt`（既有文件）
- Produces: `loadTips(text: string): string[]`、`TIPS: readonly string[]`、`pickTip(tips: readonly string[], r: number): string`、`renderWelcomeTip(tip: string, theme: Theme, boxWidth: number): string[]`

- [x] **Step 1: 写失败测试**

`tests/tui/welcome-tips.bun.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { loadTips, pickTip, renderWelcomeTip, TIPS } from "../../src/tui/components/welcome-tips.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

describe("welcome tips", () => {
	test("loadTips drops blank lines and the maintenance meta line", () => {
		const tips = loadTips("alpha\n\n  beta  \ntips.txt 这是写给编辑者的维护说明\n");
		expect(tips).toEqual(["alpha", "beta"]);
	});

	test("TIPS is non-empty, single-line, and free of meta lines", () => {
		expect(TIPS.length).toBeGreaterThan(10);
		for (const tip of TIPS) {
			expect(tip.includes("\n")).toBe(false);
			expect(tip.startsWith("tips.txt")).toBe(false);
		}
	});

	test("pickTip stays in bounds and is deterministic per sample", () => {
		const tips = ["a", "b", "c"];
		expect(pickTip(tips, 0)).toBe("a");
		expect(pickTip(tips, 0.99)).toBe("c");
		expect(pickTip([], 0.5)).toBe("");
	});

	test("renderWelcomeTip wraps within boxWidth and prefixes a Tip label", () => {
		const lines = renderWelcomeTip("按 /resume 打开历史会话选择器，按 Ctrl+D 安全退出。", theme, 60);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		}
		expect(lines[0] ?? "").toContain("Tip:");
	});

	test("renderWelcomeTip returns [] when the box is too narrow or tip is empty", () => {
		expect(renderWelcomeTip("任何内容", theme, 10)).toEqual([]);
		expect(renderWelcomeTip("", theme, 100)).toEqual([]);
	});
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/welcome-tips.bun.test.ts`
Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 welcome-tips.ts**

`src/tui/components/welcome-tips.ts`：

```ts
import { visibleWidth, wrapTextWithAnsi } from "../primitives.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapFg, wrapItalic } from "../theme/ansi.ts";
import { readFileSync } from "node:fs";

const tipsText = readFileSync(new URL("./tips.txt", import.meta.url), "utf8");

/**
 * 从 tips.txt 文本加载 tips：每行一条；丢弃空行与维护说明行
 * （以 "tips.txt" 开头、写给编辑者的行，例如文件末尾的维护约定）。
 */
export function loadTips(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("tips.txt"));
}

/** 构建期内嵌的 tips 列表。 */
export const TIPS: readonly string[] = loadTips(tipsText);

/** 均匀随机选一条 tip；空表返回 ""。r 为 [0,1) 均匀样本，导出便于测试。 */
export function pickTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const index = Math.min(tips.length - 1, Math.floor(r * tips.length));
	return tips[index] ?? "";
}

/**
 * 渲染 Tip 行（对照 oh-my-pi renderWelcomeTip）：
 * `Tip: ` 标签用 accent 着色，正文用 muted 着色，整行斜体；
 * 按 boxWidth 换行，续行缩进与标签等宽；空 tip 或宽度不足返回 []。
 */
export function renderWelcomeTip(tip: string, theme: Theme, boxWidth: number): string[] {
	if (tip.length === 0) return [];
	const label = "Tip: ";
	const labelWidth = visibleWidth(label);
	const bodyBudget = boxWidth - 1 - labelWidth; // 1 = 前导缩进
	if (bodyBudget < 8) return [];

	const wrappedBody = wrapTextWithAnsi(tip, bodyBudget);
	if (wrappedBody.length === 0) return [];

	const continuationIndent = " ".repeat(labelWidth);
	const styledLabel = wrapFg(theme.accent)(label);
	return wrappedBody.map((line, index) => {
		const styledBody = wrapFg(theme.muted)(line);
		const content = index === 0 ? `${styledLabel}${styledBody}` : `${continuationIndent}${styledBody}`;
		return ` ${wrapItalic(content)}`;
	});
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test tests/tui/welcome-tips.bun.test.ts`
Expected: PASS（5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/welcome-tips.ts tests/tui/welcome-tips.bun.test.ts
git commit -m "feat(tui): add welcome tip picker and renderer"
```

---

### Task 3: WelcomeComponent

**Files:**
- Create: `RunLedger/src/tui/components/welcome.ts`
- Test: `RunLedger/tests/tui/welcome.bun.test.ts`

**Interfaces:**
- Consumes: `logoLineWidth / renderLogo`（Task 1）、`pickTip / renderWelcomeTip / TIPS`（Task 2）、`Theme`、`wrapFg / wrapBold / wrapDim`、`visibleWidth / truncateToWidth`、`fitToWidth`（`./render-width.ts`）、`Component`（`../index.ts`）
- Produces: `WELCOME_SESSION_SLOTS = 4`、`interface RecentSession { readonly name: string; readonly timeAgo: string }`、`interface WelcomeComponentProps`、`class WelcomeComponent implements Component`（构造器 `(props: WelcomeComponentProps)`；方法 `tip` getter、`invalidate()`、`setModel(modelLabel, providerLabel)`、`setRecentSessions(sessions)`、`render(width): string[]`）

- [x] **Step 1: 写失败测试**

`tests/tui/welcome.bun.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
	WelcomeComponent,
	WELCOME_SESSION_SLOTS,
	type WelcomeComponentProps,
} from "../../src/tui/components/welcome.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";
import { visibleWidth } from "../../src/tui/primitives.ts";

const theme = loadTheme("dark");

function makeWelcome(overrides: Partial<WelcomeComponentProps> = {}): WelcomeComponent {
	return new WelcomeComponent({
		version: "0.0.1-test",
		theme,
		modelLabel: "claude-3.7",
		providerLabel: "anthropic",
		directoryLabel: "/repo",
		branchLabel: "main",
		recentSessions: [
			{ name: "fix auth", timeAgo: "2m ago" },
			{ name: "port lsp", timeAgo: "1h ago" },
		],
		...overrides,
	});
}

describe("WelcomeComponent", () => {
	test("renders box title with version and left-column content", () => {
		const joined = makeWelcome().render(100).join("\n");
		expect(joined).toContain("RunLedger v0.0.1-test");
		expect(joined).toContain("Welcome back!");
		expect(joined).toContain("claude-3.7");
		expect(joined).toContain("anthropic");
	});

	test("no line exceeds the requested width at any common width", () => {
		for (const width of [100, 80, 60, 40, 24]) {
			for (const line of makeWelcome().render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("right column renders when wide and collapses when narrow", () => {
		const wide = makeWelcome().render(100).join("\n");
		expect(wide).toContain("Quick keys");
		expect(wide).toContain("Recent sessions");
		const narrow = makeWelcome().render(40).join("\n");
		expect(narrow).not.toContain("Quick keys");
	});

	test("shows 'No recent sessions' placeholder when empty", () => {
		const joined = makeWelcome({ recentSessions: [] }).render(100).join("\n");
		expect(joined).toContain("No recent sessions");
	});

	test("lists at most WELCOME_SESSION_SLOTS recent sessions", () => {
		const welcome = makeWelcome({
			recentSessions: Array.from({ length: 8 }, (_, i) => ({ name: `session-${i}`, timeAgo: "1m ago" })),
		});
		const joined = welcome.render(100).join("\n");
		for (let i = 0; i < 8; i++) {
			expect(joined.includes(`session-${i}`)).toBe(i < WELCOME_SESSION_SLOTS);
		}
	});

	test("render returns the cached array for repeated same-width calls", () => {
		const welcome = makeWelcome();
		const first = welcome.render(80);
		expect(welcome.render(80)).toBe(first);
	});

	test("setRecentSessions invalidates the cache", () => {
		const welcome = makeWelcome();
		const first = welcome.render(80);
		welcome.setRecentSessions([{ name: "new session", timeAgo: "just now" }]);
		const second = welcome.render(80);
		expect(second).not.toBe(first);
		expect(second.join("\n")).toContain("new session");
	});

	test("renders a Tip row beneath the box", () => {
		expect(makeWelcome().render(100).join("\n")).toContain("Tip:");
	});

	test("returns [] below the minimum box width", () => {
		expect(makeWelcome().render(3)).toEqual([]);
	});
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test tests/tui/welcome.bun.test.ts`
Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 welcome.ts**

`src/tui/components/welcome.ts`：

```ts
import { truncateToWidth, visibleWidth } from "../primitives.ts";
import type { Component } from "../index.ts";
import type { Theme } from "../theme/theme.ts";
import { wrapBold, wrapDim, wrapFg } from "../theme/ansi.ts";
import { fitToWidth } from "./render-width.ts";
import { logoLineWidth, renderLogo } from "./logo.ts";
import { pickTip, renderWelcomeTip, TIPS } from "./welcome-tips.ts";

/** Recent session 行槽位数：固定盒高，加载前后不跳动（对照 oh-my-pi WELCOME_SESSION_SLOTS）。 */
export const WELCOME_SESSION_SLOTS = 4;

export interface RecentSession {
	readonly name: string;
	readonly timeAgo: string;
}

export interface WelcomeComponentProps {
	readonly version: string;
	readonly theme: Theme;
	readonly modelLabel?: string;
	readonly providerLabel?: string;
	readonly thinkingLabel?: string;
	readonly directoryLabel?: string;
	readonly branchLabel?: string;
	readonly recentSessions?: RecentSession[];
}

/**
 * welcome 页面（oh-my-pi 两栏盒式布局 + Tip 行；LOGO 采用 opencode 双段结构）：
 *   顶边框内嵌 "RunLedger v<version>"
 *   左栏：Welcome back! / LOGO / 模型 / 提供商（居中）
 *   右栏：Quick keys / Session / Recent sessions（窄终端整栏隐藏）
 *   盒下方：随机 Tip 行
 * 渲染结果按宽度缓存；数据变化经 setter + invalidate() 失效。
 */
export class WelcomeComponent implements Component {
	readonly version: string;
	readonly theme: Theme;
	modelLabel: string;
	providerLabel: string;
	thinkingLabel: string;
	directoryLabel: string;
	branchLabel: string;
	recentSessions: RecentSession[];
	#selectedTip: string | undefined;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(props: WelcomeComponentProps) {
		this.version = props.version;
		this.theme = props.theme;
		this.modelLabel = props.modelLabel ?? "unknown";
		this.providerLabel = props.providerLabel ?? "unknown";
		this.thinkingLabel = props.thinkingLabel ?? "unknown";
		this.directoryLabel = props.directoryLabel ?? "unknown";
		this.branchLabel = props.branchLabel ?? "unknown";
		this.recentSessions = props.recentSessions ?? [];
	}

	get tip(): string | undefined {
		if (this.#selectedTip === undefined) {
			this.#selectedTip = pickTip(TIPS, Math.random()) || undefined;
		}
		return this.#selectedTip;
	}

	/** 清空渲染缓存（数据或主题变化后调用）。 */
	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	setModel(modelLabel: string, providerLabel: string): void {
		this.modelLabel = modelLabel;
		this.providerLabel = providerLabel;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.#cachedLines !== undefined && this.#cachedWidth === width) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(width);
		this.#cachedLines = lines;
		this.#cachedWidth = width;
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		const theme = this.theme;
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) return [];

		// 两栏宽度分配（对照 oh-my-pi #renderLines）
		const dualContentWidth = boxWidth - 3; // │ + │ + │
		const preferredLeftCol = Math.min(logoLineWidth() + 2, 46);
		const minLeftCol = 12;
		const minRightCol = 20;
		const leftMinContentWidth = Math.max(
			minLeftCol,
			visibleWidth("Welcome back!"),
			visibleWidth(this.modelLabel),
			visibleWidth(this.providerLabel),
		);
		const desiredLeftCol = Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.4)));
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		const border = (text: string) => this.#dim(wrapFg(theme.border)(text));
		const hRun = (n: number) => border("─".repeat(Math.max(0, n)));

		// 顶边框内嵌标题
		const title = ` RunLedger v${this.version} `;
		const titlePrefixRaw = "───";
		const titleStyled = border(titlePrefixRaw) + wrapFg(theme.muted)(title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		const lines: string[] = [];
		if (titleVisLen >= titleSpace) {
			lines.push(border("┌") + truncateToWidth(titleStyled, titleSpace) + border("┐"));
		} else {
			lines.push(border("┌") + titleStyled + hRun(titleSpace - titleVisLen) + border("┐"));
		}

		// 左栏：居中内容
		const leftLines = [
			"",
			this.#centerText(wrapBold("Welcome back!"), leftCol),
			"",
			...renderLogo(theme).map((line) => this.#centerText(fitToWidth(line, leftCol), leftCol)),
			"",
			this.#centerText(wrapFg(theme.muted)(this.modelLabel), leftCol),
			this.#centerText(wrapFg(theme.secondary)(this.providerLabel), leftCol),
		];

		if (showRightColumn) {
			const separator = ` ${hRun(rightCol - 2)}`;
			const shortcutLines = [
				` ${wrapFg(theme.muted)("/")}${wrapFg(theme.hint)(" for commands")}`,
				` ${wrapFg(theme.muted)("Enter")}${wrapFg(theme.hint)(" to send")}`,
				` ${wrapFg(theme.muted)("Alt+Enter")}${wrapFg(theme.hint)(" to queue follow-up")}`,
				` ${wrapFg(theme.muted)("Ctrl+C")}${wrapFg(theme.hint)(" to interrupt")}`,
				` ${wrapFg(theme.muted)("Ctrl+D")}${wrapFg(theme.hint)(" to exit")}`,
			];
			const sessionLines = [
				this.#sessionLine("model", this.modelLabel, rightCol, theme),
				this.#sessionLine("provider", this.providerLabel, rightCol, theme),
				this.#sessionLine("thinking", this.thinkingLabel, rightCol, theme),
				this.#sessionLine("dir", this.directoryLabel, rightCol, theme),
				this.#sessionLine("branch", this.branchLabel, rightCol, theme),
			];
			const recentLines = this.#renderRecentLines(rightCol, theme);
			const rightLines = [
				` ${wrapBold(wrapFg(theme.accent)("Quick keys"))}`,
				...shortcutLines,
				separator,
				` ${wrapBold(wrapFg(theme.accent)("Session"))}`,
				...sessionLines,
				separator,
				` ${wrapBold(wrapFg(theme.accent)("Recent sessions"))}`,
				...recentLines,
				"",
			];
			const maxRows = Math.max(leftLines.length, rightLines.length);
			for (let i = 0; i < maxRows; i++) {
				const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(`${border("│")}${left}${border("│")}${right}${border("│")}`);
			}
			lines.push(`${border("└")}${hRun(leftCol)}${border("┴")}${hRun(rightCol)}${border("┘")}`);
		} else {
			for (const line of leftLines) {
				lines.push(`${border("│")}${this.#fitToWidth(line, leftCol)}${border("│")}`);
			}
			lines.push(`${border("└")}${hRun(leftCol)}${border("┘")}`);
		}

		// 盒下方随机 Tip 行
		lines.push(...renderWelcomeTip(this.tip ?? "", theme, boxWidth));
		return lines;
	}

	#dim(text: string): string {
		return wrapDim(text);
	}

	#sessionLine(label: string, value: string, rightCol: number, theme: Theme): string {
		return ` ${wrapFg(theme.muted)(label)}${wrapFg(theme.hint)(":")} ${wrapFg(theme.status)(fitToWidth(value, Math.max(0, rightCol - 12)))}`;
	}

	#renderRecentLines(rightCol: number, theme: Theme): string[] {
		const lines: string[] = [];
		if (this.recentSessions.length === 0) {
			lines.push(` ${this.#dim(wrapFg(theme.muted)("No recent sessions"))}`);
		} else {
			const bulletPrefix = " • ";
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const name = visibleWidth(session.name) > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				lines.push(
					` ${this.#dim(wrapFg(theme.muted)(bulletPrefix))}${wrapFg(theme.hint)(name)}${this.#dim(wrapFg(theme.muted)(timeSuffixRaw))}`,
				);
			}
		}
		while (lines.length < WELCOME_SESSION_SLOTS) {
			lines.push("");
		}
		return lines;
	}

	/** 居中文本；宽度不足时原样返回（行循环的 fitToWidth 兜底）。 */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) return text;
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return " ".repeat(leftPad) + text + " ".repeat(rightPad);
	}

	#fitToWidth(text: string, width: number): string {
		return fitToWidth(text, width);
	}
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test tests/tui/welcome.bun.test.ts`
Expected: PASS（9 个用例）。若 `render(100)` 下 "session-0..3" 被截断（右栏宽度不足以完整显示），检查 `nameBudget` 计算或把测试宽度提到 120；右栏宽度 = `min(100, termWidth-2) - 3 - 46`，`termWidth=100` 时右栏 ≈ 49，`session-0 (1m ago)` 共 16 列，不会截断。

- [ ] **Step 5: 提交**

```bash
git add src/tui/components/welcome.ts tests/tui/welcome.bun.test.ts
git commit -m "feat(tui): add two-column welcome component with tip row"
```

---

### Task 4: 导出与装配

**Files:**
- Modify: `RunLedger/src/tui/index.ts`
- Modify: `RunLedger/src/tui/interactive-mode.ts`
- Modify: `RunLedger/src/cli/main.ts`

**Interfaces:**
- Consumes: `WelcomeComponent / WelcomeComponentProps / RecentSession / WELCOME_SESSION_SLOTS`（Task 3）、`formatRelativeTime(ms, nowMs)`（`./components/session-picker-modal.ts`，已存在）、`SessionCatalogResult / SessionCatalogItem`（`./sessions/types.ts`，已存在）、`sessionOpenMode(args)`（`../cli/main.ts` 内已存在）、`VERSION`（`../cli/main.ts:73` 已存在）
- Produces: `InteractiveModeOptions.showWelcome?: boolean`、`InteractiveModeOptions.version?: string`；`ContainerRefs.welcome: WelcomeComponent | undefined`

- [x] **Step 1: 导出新组件（index.ts）**

在 `RunLedger/src/tui/index.ts` 的 "当前仍由 production composition 使用的业务组件" 导出区追加：

```ts
export { WelcomeComponent, WELCOME_SESSION_SLOTS, type WelcomeComponentProps, type RecentSession } from "./components/welcome.ts";
export { logo, LOGO_GAP, logoLineWidth, renderLogo } from "./components/logo.ts";
export { loadTips, pickTip, renderWelcomeTip, TIPS } from "./components/welcome-tips.ts";
```

- [x] **Step 2: 装配（interactive-mode.ts）**

2a. 追加 import（与既有 `./components/session-picker-modal.ts` import 合并 `formatRelativeTime`）：

```ts
import { SessionPickerModal, buildSessionPickerItems, formatRelativeTime } from "./components/session-picker-modal.ts";
import { WelcomeComponent, WELCOME_SESSION_SLOTS, type RecentSession } from "./components/welcome.ts";
```

2b. `InteractiveModeOptions`（第 116-140 行区间）追加两个字段：

```ts
	/** welcome 页面显示开关；resume/continue/session/fork 等带历史的启动不显示。 */
	showWelcome?: boolean;
	/** 显示在 welcome 顶边框的版本号；缺省 "unknown"。 */
	version?: string;
```

2c. 实例字段与构造器赋值（字段声明区与 `this.gitBranchLabel = opts.gitBranchLabel;` 附近）：

```ts
	private readonly showWelcome: boolean;
	private readonly version: string;
```

```ts
	this.showWelcome = opts.showWelcome ?? true;
	this.version = opts.version ?? "unknown";
```

2d. `ContainerRefs`（第 166 行）追加：

```ts
	welcome: WelcomeComponent | undefined;
```

2e. `assembleTree()`：在 `const header = new Container();` 后插入 welcome，并把它加入 header：

```ts
		const header = new Container();
		let welcome: WelcomeComponent | undefined;
		if (this.showWelcome) {
			welcome = new WelcomeComponent({
				version: this.version,
				theme: this.theme,
				modelLabel: this.modelPickSource?.currentModelId,
				providerLabel: this.modelPickSource?.currentProviderId,
				directoryLabel: this.workspaceDisplayAbsolutePath,
				branchLabel: this.gitBranchLabel,
				recentSessions: [],
			});
			header.addChild(new Spacer(1));
			header.addChild(welcome);
			header.addChild(new Spacer(1));
		}
```

`assembleTree()` 返回对象追加 `welcome`：

```ts
		return { header, welcome, loadedResources, chat, status, editor, footer };
```

2f. 新增静默 recent sessions 刷新方法（放在 `loadSessionCatalog()` 附近；复用其 `createEffect / store.dispatch / runner.dispatch / waitForWorkflow("sessionWorkflow", …)` 链路，但失败不弹 notice）：

```ts
	/**
	 * 静默拉取 recent sessions 供 welcome 右栏展示；失败/未就绪直接返回，
	 * 不弹 notice（后台刷新，不打断启动）。
	 */
	private async refreshWelcomeSessions(): Promise<void> {
		const welcome = this.refs.welcome;
		if (welcome === undefined) return;
		if (this.store.getState().capabilities.sessionCatalog.state !== "available") return;
		const effect = this.createEffect("session.list");
		this.store.dispatch({ type: "query.start", effect });
		this.runner.dispatch(effect);
		const workflow = await this.waitForWorkflow("sessionWorkflow", effect.correlationId);
		if (workflow.state !== "ready") return;
		const value = workflow.value as SessionCatalogResult;
		if (value.kind !== "catalog") return;
		const now = Date.now();
		welcome.setRecentSessions(
			value.items.slice(0, WELCOME_SESSION_SLOTS).map((item) => ({
				name: item.title ?? item.firstUserMessagePreview ?? item.sessionId,
				timeAgo: formatRelativeTime(item.updatedAtMs, now),
			})),
		);
		this.ui.requestRender();
	}
```

构造器末尾（`this.replayInitialHistory(...)` 之后）触发：

```ts
		void this.refreshWelcomeSessions();
```

2g. `/model` 选择后刷新模型标签：在 `this.modelPickSource = { … }` 赋值处（第 1270 行附近）之后追加：

```ts
		this.refs.welcome?.setModel(value.currentModelId, value.currentProviderId);
		this.ui.requestRender();
```

- [x] **Step 3: 装配（main.ts）**

在 `new InteractiveMode({ ... })` 调用（第 360 行附近）中追加两个字段；`args` 与 `VERSION` 在 `main()` 中均已存在（`const { args, error } = parseArgs(argv);` 第 109 行；`const VERSION = readVersionFromPackage();` 第 73 行）：

```ts
		showWelcome: sessionOpenMode(args) === "create",
		version: VERSION,
```

`sessionOpenMode` 已区分 `"create" | "open" | "continue_recent" | "resume" | "fork"`（第 491 行），`"create"` 即全新启动。

- [x] **Step 4: 编译与既有测试**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: PASS，无类型错误。

Run: `bun test tests/tui/welcome.bun.test.ts tests/tui/logo.bun.test.ts tests/tui/welcome-tips.bun.test.ts`
Expected: PASS（既有 TUI bun 测试不应受影响，可顺带跑 `npm run test:tui-native`）。

- [ ] **Step 5: 提交**

```bash
git add src/tui/index.ts src/tui/interactive-mode.ts src/cli/main.ts
git commit -m "feat(tui): wire welcome page into interactive mode startup"
```

---

### Task 5: 全量验证

**Files:**
- 无代码改动；只跑验证。

2026-08-20 fresh evidence：welcome 组件 18 tests passed；Node/tsx CLI 回归 9 files / 60 tests passed；完整 Bun 原生套件 17 files / 126 tests passed；其余 check 子门禁与 `npm run build` 全部通过，`dist/tui/components/tips.txt` 可由 Node 正常加载（99 tips）。隔离 `RUNLEDGER_DIR` 的真实 tmux TTY fresh create 展示 welcome，两栏内容、recent session 与 Tip 均可见。全量 check/Vitest 两项保留未勾选，仅因为本任务范围外未跟踪文件 `development-doc/tui/25-pi-working-loader-shimmer-replication-plan.md` 在 208/352/397 行触发 current-format boundary；未修改该文件。

- [ ] **Step 1: 全量 check**

Run: `npm run check`
Expected: PASS（boundary checks + `tsc --noEmit`）。若 `check:tui-boundaries` 因 `components/welcome.ts` 引用了 `primitives.ts` 之外的原语报错，按该脚本既有的组件依赖清单把 `logo.ts / welcome-tips.ts / welcome.ts` 允许的依赖加入白名单（先读 `scripts/` 下对应 check 脚本确认规则，再改白名单，不要绕过检查）。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: PASS（vitest + `npm run test:tui-native`）。

- [x] **Step 3: 构建**

Run: `npm run build`
Expected: PASS，生成 `dist/` 与 Host build manifest。

- [x] **Step 4: 冒烟（视觉验证）**

Run: `npm run demo:tui`
Expected: 终端出现两栏 welcome 盒：顶边框 `RunLedger v…`、左栏 LOGO（RUN dim + LEDGER bold）与 "Welcome back!"、右栏 Quick keys / Session / Recent sessions、盒下一条随机 Tip。手动缩小终端宽度验证右栏折叠、无行溢出、无乱码。
若 demo 入口不构造 `InteractiveMode`（独立示例），改用：

```bash
RUNLEDGER_DIR=$(mktemp -d) npm run cli
```

（`npm run cli` = `npm run build && ./bin/runledger.js`，fresh launch 走 `sessionOpenMode === "create"`，应显示 welcome；输入为空时用 Ctrl+D 干净退出。）

- [ ] **Step 5: 提交（如有验证期改动）**

```bash
# 按 AGENTS.md 审阅后只逐路径暂存本计划实际改动；本轮用户未授权提交。
```

---

## Self-Review

**Spec coverage：**
- 两栏盒式布局 → Task 3 `#renderLines`（左栏居中内容 + 右栏三节 + 顶边框标题 + 响应式折叠）。
- Tip 行 → Task 2 `renderWelcomeTip` + Task 3 盒下渲染。
- LOGO 参考 opencode → Task 1 双段逐字符着色（`{ left, right }` 结构同 `opencode/packages/tui/src/logo.ts`）。
- 计划落位 `development-doc/tuiz/` → 本文件 `02-welcome-page-plan.md`。
- 装配真实数据（version / model / directory / branch / recent sessions）→ Task 4。

**Placeholder 扫描：** 无 TBD/TODO；所有代码块完整；唯一提示性说明（`dim` 提升为私有方法）给出了两种具体做法并指明选择，非占位。

**Type consistency：** `WelcomeComponentProps`（Task 3 定义）与 Task 4 构造调用字段一致；`setModel(modelLabel, providerLabel)` 与 2g 调用一致；`setRecentSessions(RecentSession[])` 与 2f 的 `{ name, timeAgo }` 映射一致；`renderLogo(theme)` / `pickTip(tips, r)` / `renderWelcomeTip(tip, theme, boxWidth)` 签名跨任务一致；`logoLineWidth()` 在 Task 3 左栏宽度计算中被消费。
