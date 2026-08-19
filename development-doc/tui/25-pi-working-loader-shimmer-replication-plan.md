# RunLedger TUI oh-my-pi Working Loader（渐变 shimmer + esc 提示）复刻计划

> 状态：**实施中（S0–S3 implemented；S4 pending）**
>
> 计划日期：2026-08-20
>
> RunLedger 基线：`7af31b9`（`tui: close streaming prefix contract coverage`）
>
> oh-my-pi 固定参照：`main@06aecdd51f`（shimmer/loader 相关文件最近提交 `a6aa462a60 fix(tui): bounded WSL idle animation CPU`）
>
> 交付性质：本文冻结「运行中编辑器上方状态指示行」的渐变（shimmer）复刻语义、渲染管线接缝、实施阶段与验收。**不动** spinner 帧、elapsed 格式、details 行、FrameScheduler、status line 段与语法高亮——这些分别由 Plan 24、17、18、23 继续持有 authority。

---

## 0. 权威边界与工作树事实

### 0.1 本计划拥有的范围

本文是以下能力的唯一实施入口：

- **shimmer 渐变引擎**（纯函数）：classic 余弦波 / KITT 扫描灯两种强度曲线、三档色（low/mid/high）、ANSI run 合并、按 (theme, 色阶) 的 SGR 编译缓存、`Date.now()` 驱动的相位；
- **状态指示行渐变渲染**：working 时 header（+可选 inlineMessage）以 shimmer 渐变流动，纯文本宽度不变；
- **esc 提示字形**：`interruptKey` 以 bracket 字形渲染（`⸢esc⸣` / `⸢^C⸣`），键源仍是 keymap；
- **设置项** `display.shimmer`（`classic` / `kitt` / `disabled`）进 `TuiPreferencesDocument`；
- 相应单测、文档索引追加。

本文不替换以下既有 authority：

| 专项 | 继续拥有的 authority | 本计划的接缝 |
|---|---|---|
| [`24-codex-session-display-replication-plan.md`](24-codex-session-display-replication-plan.md) | `StatusIndicatorView` 字段语义、spinner 帧、elapsed、details 行、行位置（transcript 与 editor 之间）、32ms 帧调度接线 | 只扩展 header/inlineMessage 的**着色**与 interruptKey 的**字形**，不新增帧段、不改行布局 |
| [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | FrameScheduler、TextRenderable、renderable 生命周期 | 复用 `scheduleFrameIn` / `animationFrame`，不引入第二时钟 |
| [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | 流式合并、背压、长会话预算 | 渐变只作用于单行状态指示，不触碰 transcript |
| [`23-codex-syntax-highlighting-replication-plan.md`](23-codex-syntax-highlighting-replication-plan.md) | 语法高亮、scope 颜色解析 | 渐变调色板直接映射 RunLedger 21 色槽，不经 syntax scope |
| [`../plan/02-codex-input-area-replica-plan.md`](../plan/02-codex-input-area-replica-plan.md) | composer、editor 高度模型 | 渐变着色不改变 editor 高度计算输入（高度仍按纯文本行数） |

### 0.2 当前工作树边界

计划编写时仓库存在与本专项无关的未提交改动（`git status --short` 快照，2026-08-20）：

- `development-doc/00-index.md`、`development-doc/plan/09-outbound-network-proxy-plan.md`、`development-doc/plan/11-forward-proxy-gateway-plan.md`、`scripts/check-current-format.ts`；
- `src/auth-gateway/…`、`src/providers/proxy-provider.ts`、`src/storage/settings-manager.ts` 等非 TUI 文件。

本轮文档只新增本文，并在 `development-doc/00-index.md` 与 `development-doc/tui/00-overview.md` 两个索引中追加最小导航。未来执行本文时必须逐路径审阅和暂存，不得把共享工作树中的其他修改归入本专项。

### 0.3 证据口径

- `HEAD` 只说明已提交基线，不包含当前工作树候选；
- 本文的 RunLedger 现状来自 2026-08-20 对 `src/tui/` 源文件、测试与 `development-doc/tui/` 计划文档的只读检查；
- oh-my-pi 行为以固定参照 commit 的源码为准（`shimmer.ts` / `loader.ts` / `interactive-mode.ts` / `shared.ts`），不以描述性总结代替；
- 自动测试、标准 PATH PTY 与人工视觉验收必须分开记录；
- 任一阶段只在 fresh evidence 完成后更新状态。

---

## 1. 目标、等价定义与非目标

### 1.1 最终目标

在不 fork OpenTUI、不改变 `StatusIndicatorView` 帧段布局、不重复 17/18/23/24 已冻结能力的前提下，让 RunLedger 状态指示行复现 oh-my-pi working loader 的**渐变运行态**：

1. working 时 header 文本以 shimmer 渐变流动（classic 余弦波扫过三档色，或 KITT 亮点往返），颜色来自 RunLedger 21 色槽；
2. 渐变是**零宽注入**：只加 SGR 转义，可见文本与宽度不变，截断/换行/高度计算全部按纯文本进行；
3. `interruptKey` 以 bracket 字形渲染（`⸢esc⸣`），与 oh-my-pi `interruptHint()` 视觉等价，键源仍来自 keymap（可配置为 esc 或 ^C）；
4. `display.shimmer = disabled` 时静态渲染 mid 档色，不启动动画重绘；
5. 引擎为纯函数模块，classic / kitt 强度曲线、三档色映射、ANSI run 合并全部可单测。

### 1.2 “完整复刻”的判定

完整复刻不是“字形近似”，而是同时满足：

- **相位正确**：渐变位置由 `Date.now()` 驱动，`SHIMMER_SPEED_CELLS_PER_S = 30` 恒速，长消息不跳变；classic 与 kitt 曲线分别与 oh-my-pi `classicIntensity` / `kittIntensity` 数值一致（±1 格舍入）；
- **零宽不变式**：`Bun.stripANSI(shimmer(plain)) === plain`，`displayWidth(shimmer(plain)) === displayWidth(plain)`；
- **run 合并**：同档连续字符只发一个 open/close 对，单帧 escape 数 ≪ 字符数（性能形状对齐 oh-my-pi）；
- **缓存**：按 (theme, 色阶) Symbol-keyed 编译缓存，动画帧间不重解析 ANSI；
- **降级**：disabled 模式输出 mid 档单色，不重绘；非 truecolor 终端走 256 色回退（复用 `theme/ansi.ts` 映射）；
- **esc 字形**：`interruptKey === "esc"` 渲染 `⸢esc⸣`，`^C` 渲染 `⸢^C⸣`；无 interruptKey 时不渲染括号段。

### 1.3 非目标

- 不复刻 oh-my-pi 的 magic-keyword 逐字符 hue 渐变（`gradient-highlight.ts` / `ultrathink` 等）——那是编辑器输入关键字高亮，与本计划无关；
- 不引入 oh-my-pi 的 session accent（按会话名哈希取色）；RunLedger 无此概念，渐变统一用主题 accent/muted/secondary 槽；
- 不复刻 `Loader` 组件本身（spinner 帧 + messageColorFn + 30fps 自调度）；RunLedger 用 TextRenderable + 共享 FrameScheduler，动画 tick 已由 24 的 32ms 调度提供；
- 不改 `statusIndicatorPlainText` 的纯文本截断语义；渐变着色只发生在截断**之后**；
- 不做 waiting 态渐变（waiting 保持现有 `⏸ Waiting` 静态，oh-my-pi 同）。

---

## 2. 固定参照源码与 RunLedger 当前差距

### 2.1 oh-my-pi 源码地图（固定参照 `06aecdd51f`）

| 文件 | 关键符号 | 本计划移植什么 |
|---|---|---|
| `packages/coding-agent/src/modes/theme/shimmer.ts` | `shimmerSegments` / `shimmerText`、`ShimmerPalette`、`classicIntensity`、`kittIntensity`、`tierFor`、`activeBand`、`compile`（Symbol 缓存）、`SHIMMER_SPEED_CELLS_PER_S=30`、`CLASSIC_PADDING=10`、`CLASSIC_BAND_HALF_WIDTH=6`、`KITT_HEAD_HALF=0.6`、`KITT_TRAIL_LEN=7`、`TIER_HIGH=0.65`、`TIER_MID=0.22` | 引擎全部：强度曲线、三档判定、run 合并、编译缓存、disabled 静态路径 |
| `packages/coding-agent/src/modes/interactive-mode.ts` | `renderWorkingMessage`（L266，header + hint 双段调色板）、`HINT_SHIMMER_PALETTE`（L228，dim/muted/borderAccent）、`ensureLoadingAnimation`（L4467，Loader 装配到 statusContainer） | 双段着色思路：正文用主题 accent 渐变，esc 提示用独立调色板 |
| `packages/coding-agent/src/modes/shared.ts` | `interruptHint()`（L45）→ ` ⸢esc⸣`（`theme.format.bracketLeft/Right`） | esc bracket 字形语义 |
| `packages/tui/src/components/loader.ts` | `Loader`（spinner 帧 + messageColorFn，`animated` 时 30fps 重绘） | 不移植组件，只借鉴「着色函数按帧重算」的接线形态 |

### 2.2 RunLedger 当前链路

| 层 | 文件 | 现状 |
|---|---|---|
| 投影 | `src/tui/presentation/projectors.ts` `projectStatusIndicator`（L54） | 已有：indicator 帧、header、elapsed、interruptKey（`^C` 纯文本）、inlineMessage、details；**无任何 ANSI 着色** |
| 类型 | `src/tui/presentation.ts` `StatusIndicatorView` | `indicator/header/elapsed/inlineMessage/interruptKey/details`，全部纯文本字段 |
| 渲染 | `src/tui/opentui/component-runtime.ts` `statusIndicatorPlainText`（L953） | 纯文本 → `truncateDisplayWidth` → `ansiToStyledText` → TextRenderable content；**管线已支持 ANSI（38;5 与 38;2 均解析）** |
| 帧调度 | `src/tui/opentui/block-layout.ts` `STATUS_INDICATOR_FRAME_MS=32`；`src/tui/interactive-mode.ts` `scheduleStatusIndicatorFrame` / `refreshStatusIndicator`（L2775/2780） | 已有 32ms 动画 tick，`animationFrame = floor(nowMs / 32)` 传入投影器；**可复用为 shimmer 相位驱动** |
| 颜色 | `src/tui/theme/ansi.ts`（hex→256→16 回退）；`src/tui/theme/theme.ts`（21 色槽） | 已有 `rgbToAnsi256` / `ansi256ToAnsi16` / `wrapFg`；缺 truecolor SGR 直出（可加 `wrapFgTruecolor`） |
| 设置 | `src/tui/preferences/types.ts` `TuiPreferencesDocument`（version 1，`transcript.scrollbar`） | 需扩 `display.shimmer` 字段，version 1 → 2，兼容旧文件 |

**核心差距**：状态指示行是静态单色纯文本；无渐变引擎、无 esc bracket 字形、无按帧相位重算的着色层。

### 2.3 不采用的替代路线

| 替代路线 | 否决理由 |
|---|---|
| 移植 `Loader` 组件 + 自调度 30fps | 引入第二时钟源与合帧竞争，违反 Plan 24 D5（动画 tick 走共享帧调度）；TextRenderable 已有 32ms 帧路径 |
| 在 `projectStatusIndicator` 阶段输出 ANSI | 投影器输出被 `statusIndicatorPlainText` 的 `truncateDisplayWidth`/`wrapDisplayWidth` 消费，ANSI 会污染 grapheme 宽度计算；必须截断后着色 |
| 复用 syntax scope 解析颜色（23） | 渐变是三档强度而非语义 scope；直接映射 21 色槽更简单、无 scope 依赖 |
| 逐字符 hue 渐变（oh-my-pi magic-keyword 风格） | 与 oh-my-pi working loader 不符：working loader 是「一档亮色 band 扫过」而非彩虹；且每字符 SGR 破坏 run 合并性能 |
| 会话名哈希 accent（oh-my-pi session accent） | RunLedger 无 session accent 概念，本期不引入；统一主题 accent 即可 |

---

## 3. 冻结决策与停止条件

### D1：渐变引擎是独立纯函数模块，输出 ANSI SGR 字符串

新增 `src/tui/opentui/shimmer.ts`，导出：

```ts
export type ShimmerMode = "classic" | "kitt" | "disabled";
export interface ShimmerPaletteTier { readonly ansi: string }   // 已编译 SGR 开序列，如 "\x1b[38;2;124;207;255m"
export interface ShimmerPalette { low: ShimmerPaletteTier; mid: ShimmerPaletteTier; high: ShimmerPaletteTier; bold?: boolean }
export interface ShimmerSegment { text: string; palette: ShimmerPalette }
export function shimmerSegments(segments: readonly ShimmerSegment[], mode: ShimmerMode, nowMs: number): string;
export function shimmerText(text: string, palette: ShimmerPalette, mode: ShimmerMode, nowMs: number): string;
```

- 引擎不读终端状态、不碰 Theme 实例；色阶由调用方编译好传入（D5）；
- 内部实现逐条对齐 oh-my-pi：`classicIntensity` / `kittIntensity` / `tierFor` / `activeBand` 快路径 / 同档 run 合并 / 代理对按码点计位；
- `disabled` 直接输出 mid 档整段，不做逐字符循环。

### D2：着色发生在纯文本截断之后、`ansiToStyledText` 之前

渲染链：`statusIndicatorPlainText(view, width)`（保持纯文本 + 截断不变）→ **新着色层** `shimmerStatusLine(plain, view, mode, nowMs)` → `ansiToStyledText` → TextRenderable。

着色层只处理第一行（header 行）内的 `header` 与 `inlineMessage` 两个 span；details 行不渐变。span 边界由纯文本定位（`plain` 与 `view` 字段的偏移映射，含截断省略号的情况按「截断后字符串内子串定位」实现）。

### D3：渐变只作用于 working 态，waiting/recovery 不渐变

`projectStatusIndicator` 的现有分支不变；着色层按 `view.header === "Working"` 决定是否启用 band 动画。waiting 的 `⏸ Waiting` 与 details 保持现状。

### D4：动画相位复用既有 32ms 帧调度，不新增时钟

- `refreshStatusIndicator` 已把 `nowMs` 传入投影器；着色层直接用 `nowMs` 计算相位（`shimmerSegments` 内部 `Date.now()` 换成传入 `nowMs`，保持纯函数可测）；
- 动画启停沿用现有 `scheduleStatusIndicatorFrame`（working 时排 32ms 帧，end 后停），**不新增** `setInterval`/自调度；
- `animationFrame` 字段继续由 24 的帧逻辑使用，本计划不接管。

### D5：调色板直接映射 RunLedger 21 色槽，编译期决定 truecolor/256

- 默认 working 调色板：`low = muted`、`mid = secondary`、`high = accent`、`bold = true`（对照 oh-my-pi `DEFAULT_SHIMMER_PALETTE` low=dim/mid=muted/high=accent/bold 的档位关系，映射到 RunLedger 槽名）；
- esc 提示段独立调色板：`low = muted`、`mid = muted`、`high = hint`（对照 oh-my-pi `HINT_SHIMMER_PALETTE` dim/muted/borderAccent 的相对关系）；
- 编译：终端支持 24-bit 时 `\x1b[38;2;r;g;bm`（新增 `wrapFgTruecolor` 纯函数于 `theme/ansi.ts`），否则复用 `rgbToAnsi256` 走 `\x1b[38;5;nm`；16 色回退沿用 `ansi256ToAnsi16`；
- 调色板按 (theme, 槽映射) 缓存 SGR 开序列（模块级 WeakMap 或闭包缓存，参照 oh-my-pi Symbol-keyed 思路）。

### D6：`interruptKey` 渲染 bracket 字形，键源仍是 keymap

- `statusIndicatorPlainText` 中 `• {key} to interrupt` 的纯文本形态保留（供无着色/降级路径与测试快照），着色层把该 span 替换为 `• ⸢{key}⸣`（用 `\x1b[38;2/38;5` hint 色）——即 `⸢esc⸣` 来自 `{bracketLeft}{key}{bracketRight}`，字形常量 `"⸢"`/`"⸣"`（不做符号预设系统）；
- keymap 不改：用户把 `tui.input.interrupt` 绑到 escape 即显示 `⸢esc⸣`；默认 ctrl+c 显示 `⸢^C⸣`。

### D7：设置项 `display.shimmer` 进 `TuiPreferencesDocument`

- `TuiPreferencesDocument` version 1 → 2，新增 `display: { shimmer: "classic" | "kitt" | "disabled" }`；
- 读取旧 version 1 文件：缺省 `display` 字段 → 回退 `classic`；`sanitizePreferences` 对非法值回退 `classic`，不报错；
- 运行时取值走 `loadTuiPreferences` 注入（composition root 不变），TUI 不直接碰文件。

### D8：性能护栏

- 单帧着色只处理 header 行（≤ 终端宽），details 行零开销；
- run 合并保证每帧 SGR 对数量级 = 档位切换次数（≤ 3 × span 数），不做逐字符分配；
- `display.shimmer = disabled` 时不排动画帧（现有 `scheduleStatusIndicatorFrame` 只在 working 排帧，着色层静态后自然停绘）。

**停止条件**：以上任一决策在实现阶段被推翻，必须先更新本文再继续；D4 被否决（帧调度不可用）时降级为静态 mid 色渲染并在验收中明确标记非等价。

---

## 4. 目标架构

```
interactive-mode.refreshStatusIndicator()
  ├─ store.getState().timeline.activeRun            （24 现有）
  ├─ projectStatusIndicator(activeRun, { nowMs, animationFrame, interruptKey })
  │     └─ StatusIndicatorView（纯文本字段，不变）
  └─ ui.setStatusIndicator(view)                     （24 现有）

component-runtime 帧准备（render 前）
  ├─ statusIndicatorPlainText(view, width)           （24 现有：纯文本 + 截断）
  ├─ shimmerStatusLine(plain, view, mode, nowMs)     ★ 新增着色层（D2）
  │     ├─ 定位 header + inlineMessage + interrupt 括号 span
  │     ├─ shimmerText(headerSpan, mainPalette, mode, nowMs)
  │     ├─ shimmerText(hintSpan, hintPalette, mode, nowMs)
  │     └─ 拼接非渐变段（indicator、elapsed、details 原样保留）
  ├─ ansiToStyledText(shimmered)                      （既有）
  └─ statusIndicator.content / height                 （24 现有；height 仍按纯文本行数）

tui-preferences（composition root）
  └─ TuiPreferencesDocument { version: 2, transcript.scrollbar, display.shimmer }
       └─ interactive-mode 读 shimmer 模式 → 传给着色层
```

新增/修改文件见 §9。模块依赖方向：`opentui/shimmer.ts` ← `theme/ansi.ts`（纯函数，无 renderer/Theme 依赖）；着色层放 `opentui/component-runtime.ts` 同级纯函数（或 `opentui/shimmer-status-line.ts`），`statusIndicatorPlainText` 不动。

---

## 5. 精确合同

### 5.1 引擎（`opentui/shimmer.ts`）

```ts
// 强度曲线（对照 oh-my-pi，数值必须一致）
classicIntensity(nowMs, index, length): number   // 余弦 bump，SHIMMER_SPEED_CELLS_PER_S=30，CLASSIC_PADDING=10，CLASSIC_BAND_HALF_WIDTH=6
kittIntensity(nowMs, index, length): number      // KITT 亮点 + 二次衰减尾迹，KITT_HEAD_HALF=0.6，KITT_TRAIL_LEN=7
tierFor(intensity): "low" | "mid" | "high"       // 阈值 0.65 / 0.22
activeBand(mode, nowMs, total): { lo, hi }       // 带外跳过强度计算的快路径

// 输出不变式
// 1) stripANSI(shimmerSegments(...)) === 各段 text 拼接
// 2) displayWidth(shimmerSegments(...)) === displayWidth(各段 text 拼接)
// 3) 同档连续 run 只产生一个 open/close 对
// 4) disabled: 输出每段 mid 档整段单色，无逐字符循环
```

### 5.2 着色层（`opentui/shimmer-status-line.ts`）

```ts
export interface ShimmerStatusLineOptions {
  readonly mode: ShimmerMode;              // 来自 TuiPreferencesDocument.display.shimmer
  readonly nowMs: number;                  // 与 24 帧调度同源
  readonly theme: Theme;                   // 编译调色板用（D5）
  readonly truecolor: boolean;             // 终端能力；false 走 256 回退
}
export function shimmerStatusLine(plain: string, view: StatusIndicatorView, opts: ShimmerStatusLineOptions): string;
```

- 输入 `plain` 是 `statusIndicatorPlainText` 的**截断后**输出；输出为注入 SGR 的等价字符串；
- span 定位：header 行 = 第一行；header 文本 = 去掉 `␣` 前缀与 ` (elapsed• interrupt)` 后缀后的前缀 span；inlineMessage 紧跟其后；interrupt 括号段 = `• ⸢key⸣`；
- 定位失败（截断吞掉 span）时该 span 原样保留（不渐变），不抛错；
- `header !== "Working"`（waiting/recovery 残余）或 `mode === "disabled"` 时原样返回 `plain`（零开销路径）。

### 5.3 `StatusIndicatorView` 与投影器

**不改** `StatusIndicatorView` 字段（保持纯文本契约，24 的测试与快照不动）。投影器只新增一个导出纯函数 `workingShimmerPalette(theme)` / `workingHintPalette(theme)`（供着色层编译），不改变 `projectStatusIndicator` 输出。

### 5.4 设置（`tui/preferences/types.ts`）

```ts
export interface TuiPreferencesDocument {
  readonly version: 2;
  readonly transcript: { readonly scrollbar: "hidden" | "visible" };
  readonly display: { readonly shimmer: "classic" | "kitt" | "disabled" };
}
```

- `createDefaultTuiPreferences()` 返回 version 2 + `shimmer: "classic"`；
- `sanitizePreferences` 接受 version 1（补 `display` 默认）与 version 2；非法 shimmer 值回退 `classic`；
- `src/storage/tui-preferences.ts` 的读写/加锁逻辑不变，只跟随类型。

### 5.5 常量表（对照 oh-my-pi → RunLedger）

| oh-my-pi | 值 | RunLedger 常量（建议名，`block-layout.ts` 或 shimmer.ts 内） |
|---|---|---|
| `SHIMMER_SPEED_CELLS_PER_S` | 30 | `SHIMMER_SPEED_CELLS_PER_S = 30` |
| `CLASSIC_PADDING` / `CLASSIC_BAND_HALF_WIDTH` | 10 / 6 | 同名 |
| `KITT_HEAD_HALF` / `KITT_TRAIL_LEN` | 0.6 / 7 | 同名 |
| `TIER_HIGH` / `TIER_MID` | 0.65 / 0.22 | 同名 |
| `interruptHint()` 括号 | `⸢ ⸣` | `SHIMMER_BRACKET_LEFT = "⸢"`、`SHIMMER_BRACKET_RIGHT = "⸣"` |
| `DEFAULT_SHIMMER_PALETTE` 档位 | dim/muted/accent+bold | `muted/secondary/accent+bold`（槽名映射） |
| `HINT_SHIMMER_PALETTE` 档位 | dim/muted/borderAccent | `muted/muted/hint`（槽名映射） |
| 帧周期 | 30fps（Loader） | 复用 `STATUS_INDICATOR_FRAME_MS = 32`（≈31fps，视觉等价） |

---

## 6. 各展示面目标行为

| 场景 | 目标行为 |
|---|---|
| working，classic 模式 | `⠋ Working` 以余弦 band 从左到右扫过 accent 三档色，`(12s • ⸢esc⸣)` 括号段用 hint 色微光；elapsed 每秒更新 |
| working，kitt 模式 | 单亮点 + 尾迹在 header 文本上往返（`display.shimmer = kitt`） |
| working，disabled | 整行 mid 档单色，无动画；不排额外帧 |
| waiting | `⏸ Waiting` 静态，无渐变（同 oh-my-pi） |
| 超长 header | 截断后渐变只作用于可见 span，省略号不渐变；宽度计算不变 |
| 窄终端（<40 列） | 渐变照常，run 合并限制 SGR 量；details 行不受影响 |
| interruptKey 未配置 | 无 `• ⸢key⸣` 段，其余照常 |
| 非 truecolor 终端 | 256 色回退（`rgbToAnsi256`），视觉降级但不破坏 run 合并 |
| 转写视图 / transcript | 不受影响（渐变仅状态指示行第一行） |

---

## 7. 流式、调度、缓存与失败模型

### 7.1 tick 与合帧

- working 时 `refreshStatusIndicator` 每 32ms 投影一次（24 现有），着色层在该次投影的渲染路径内以同源 `nowMs` 重算相位——**同一帧窗口内只重算指示行，不触碰 transcript 布局**（延续 24 §6.5）；
- 无独立动画时钟。

### 7.2 缓存

- 调色板 SGR 编译缓存：key = (theme 引用, 槽名三元组, truecolor 布尔)，缓存 `{ low, mid, high, bold }` 的开/闭序列；
- 引擎 run 合并不缓存帧结果（相位每帧变），只缓存编译产物（每帧一次查表）。

### 7.3 失败模型

| 失败 | 行为 |
|---|---|
| 设置文件损坏 / 版本非法 | `loadTuiPreferences` 返回默认（`classic`），有 diagnostic 码；TUI 照常启动 |
| 主题槽缺失 | 调色板编译回退：缺槽用 `primary` 代替，不抛错 |
| span 定位失败（截断吞 header/inline/interrupt） | 该 span 原样保留，不渐变 |
| `ansiToStyledText` 遇到未知 CSI | 既有解析丢弃（`ansi-styled-text.ts` 已处理），不新增路径 |

---

## 8. 实施阶段（严格 RED → GREEN）

> 每阶段：先写测试（RED），再实现（GREEN），再跑门禁。跳过验证会污染阶段状态，禁止。

### S0 · 基线、常量与引擎纯函数

- [x]（计划期）确认 oh-my-pi 固定参照与 RunLedger 现状（§2）；
- [x] `shimmer.ts` 内落常量：`SHIMMER_SPEED_CELLS_PER_S`、`CLASSIC_*`、`KITT_*`、`TIER_*`、`SHIMMER_BRACKET_*`；
- [x] 新增 `src/tui/opentui/shimmer.ts`：`classicIntensity` / `kittIntensity` / `tierFor` / `activeBand` / `shimmerText` / `shimmerSegments`（含 disabled 路径）；
- [x] `theme/ansi.ts` 新增 `wrapFgTruecolor(hex)`（`\x1b[38;2;r;g;bm…\x1b[39m`），与既有 256/16 映射并存；
- **门禁**：`tests/tui/opentui/shimmer.test.ts`（或 `.bun.test.ts`）覆盖——强度曲线数值（对照 oh-my-pi 手工向量）、tier 阈值边界、零宽不变式、run 合并（同档连续字符只产生一对 open/close）、代理对按码点计位、disabled 单色路径、`activeBand` 带外跳过等价性。

### S1 · 着色层 + 渲染接线

- [x] 新增 `src/tui/opentui/shimmer-status-line.ts`：`shimmerStatusLine(plain, view, opts)`，span 定位 + 双段着色 + 非渐变段原样拼接；
- [x] `component-runtime.ts` 状态指示行渲染路径：`statusIndicatorPlainText` 输出 → `shimmerStatusLine` → `ansiToStyledText`（保持 height 按纯文本行数）；
- [x] 接线 `mode` / `nowMs` / `truecolor`：`interactive-mode.ts` 以 S1 默认 `classic` 把 `nowMs` 与终端色彩能力传给 UI；preferences authority 留给 S3；
- **门禁**：`tests/tui/blocks/status-indicator-shimmer.test.ts`——Bun OpenTUI 渲染含 SGR 的 `⠋ Working (12s • ⸢esc⸣)`、宽度不变、`header !== "Working"` 时原样、截断吞 span 时不抛错；既有 `status-indicator.test.ts` / `opentui-status-indicator.bun.test.ts` 全绿（纯文本路径未变）。

### S2 · esc bracket 字形

- [x] 着色层把 interrupt 段渲染为 `• ⸢{key}⸣`（hint 色）；
- [x] `statusIndicatorPlainText` 的纯文本 `• ^C to interrupt` 保留（降级/快照路径）；
- **门禁**：测试——`interruptKey: "esc"` → 帧含 `⸢esc⸣`；`"^C"` → `⸢^C⸣`；未配置 → 无括号段；纯文本快照不回归。

### S3 · 设置项 `display.shimmer`

- [x] `tui/preferences/types.ts`：version 2 + `display.shimmer`，`createDefaultTuiPreferences` / `sanitizePreferences` 兼容 version 1；
- [x] `storage/tui-preferences.ts` 跟随类型；`interactive-mode` 读取并注入着色层；
- **门禁**：preferences 单测——旧格式（`version` 字段为 1）读为 `classic`、非法值回退 `classic`、round-trip 保存时 `version` 字段写 2；TUI 冒烟：三模式切换后帧内容差异可见。

### S4 · 完整门禁与人工验收

- [ ] `npm run check`（zero error/warning/info）、`npm test`、Bun OpenTUI 测试、`npm run build`；
- [ ] 标准 PATH 隔离 `runledger`：80/143 列 dark/light 真实 TTY 人工目检——classic 扫过流畅、kitt 往返、disabled 静态、esc 提示可见、窄终端不抖动；
- [ ] `git diff --check`；按 §0.2 只暂存本文相关文件；
- **门禁**：全部通过后本文状态置 `implemented/accepted`，`00-index.md` / `00-overview.md` 状态行更新。

---

## 9. 预计文件变更清单

### 9.1 新增

- `src/tui/opentui/shimmer.ts`——引擎纯函数（S0）；
- `src/tui/opentui/shimmer-status-line.ts`——着色层（S1）；
- `tests/tui/opentui/shimmer.test.ts` 或 `.bun.test.ts`——引擎单测（S0）；
- `tests/tui/blocks/status-indicator-shimmer.test.ts`——渲染接线测试（S1/S2）；
- （可选）`tests/tui/preferences-shimmer.test.ts`——设置项测试（S3）。

### 9.2 修改

- `src/tui/theme/ansi.ts`——新增 `wrapFgTruecolor`（S0）；
- `src/tui/opentui/component-runtime.ts`——状态指示行渲染路径插着色层（S1）；`setStatusIndicator`/frame 类型扩展（若选新 setter 方案）；
- `src/tui/interactive-mode.ts`——读 `display.shimmer`、传 `nowMs`/模式（S1/S3）；
- `src/tui/preferences/types.ts`、`src/storage/tui-preferences.ts`——version 2 + `display.shimmer`（S3）；
- `development-doc/00-index.md`、`development-doc/tui/00-overview.md`——最小导航追加（S4）；
- 本文状态表随阶段推进更新。

---

## 10. 测试矩阵

| 面 | 测试 | 断言（防回归点） |
|---|---|---|
| 引擎曲线 | `classicIntensity` / `kittIntensity` 数值向量 | 与 oh-my-pi 参照实现一致；速度恒 30 cells/s，长消息不跳变 |
| tier 边界 | `tierFor` 在 0.22 / 0.65 邻域 | 阈值含端点语义与 oh-my-pi 相同 |
| 零宽 | `stripANSI(shimmer(...))` / `displayWidth` | 可见文本与宽度不变（核心不变式） |
| run 合并 | 同档连续 run | SGR 对数量 ≤ 3×span，无逐字符转义 |
| disabled | `shimmerText(..., "disabled", ...)` | 单段 mid 色，无逐字符循环 |
| span 定位 | 截断吞 header/inline/interrupt | 原样保留，不抛错，帧仍渲染 |
| esc 字形 | `esc` / `^C` / 未配置 | `⸢esc⸣` / `⸢^C⸣` / 无括号段 |
| 渲染接线 | Bun OpenTUI 帧捕获 | 含 SGR 的指示行、height 按纯文本、位置在 editor 上方 |
| 回归 | 24 既有 `status-indicator*` 测试 | 纯文本路径零变化 |
| 设置 | 旧格式兼容 / 非法值 / round-trip | `classic` 回退、`version` 字段写 2 |
| 性能 | 长消息 + classic | 单帧 SGR 对数受 run 合并限制（快照/计数断言） |

---

## 11. 安全、隐私与运维

- 渐变只作用于**展示**，`StatusIndicatorView` 仍是 safe projector 产物，不新增数据通道；inlineMessage 继续走 `sanitizeLabel`；
- 不写终端以外的文件；preferences 读写继续经 composition root 注入的端口（不新增路径权限）；
- 无新依赖；引擎为纯函数，不引入网络/进程能力；
- 性能护栏见 D8；`disabled` 模式是全局逃生口（低端终端/远程会话）。

---

## 12. 完成定义

「Done」= 同时满足：

1. S0–S4 全部 GREEN，本文状态 `implemented/accepted`；
2. 引擎数值与 oh-my-pi 固定参照一致（曲线向量测试通过）；
3. 零宽不变式在引擎与着色层两层都有自动化断言；
4. `display.shimmer` 三模式在真实 TTY 目检可见差异，`disabled` 零动画；
5. 24 的既有状态指示测试与快照零回归；`npm run check` / `npm test` / Bun OpenTUI / `npm run build` 全绿；
6. 按 §0.2 只暂存本专项文件，未提交工作树中其他改动不被卷入；
7. 索引（`00-index.md`、`00-overview.md`）已追加本文导航与状态行。

---

## 附录 A · 状态表

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| S0 | 引擎纯函数 + 常量 + truecolor 辅助 | implemented | `tests/tui/opentui/shimmer.test.ts` + `tests/tui/ansi.test.ts`：27 passed；`tsc --noEmit`、current-format 通过 |
| S1 | 着色层 + 渲染接线 | implemented | 纯函数 5 tests、状态指示回归 4 tests、Bun OpenTUI 4 tests、`tsc --noEmit` 通过 |
| S2 | esc bracket 字形 | implemented | shimmer status 8 tests、纯文本回归 4 tests、Bun OpenTUI 4 tests、`tsc --noEmit` 通过 |
| S3 | `display.shimmer` 设置项 | implemented | RED 7 failures；GREEN 5 files / 65 tests；`tsc --noEmit` 通过 |
| S4 | 完整门禁 + 人工验收 | pending | — |
