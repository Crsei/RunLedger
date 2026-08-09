# 02 · Codex 输入区复刻计划（颜色 / 尺寸 / 布局）

> 文档状态：implemented（S0–S4 complete；2026-08-09）<br>
> 记录日期：2026-08-09<br>
> 基线：`npm run check` + `npm test` + Bun OpenTUI 测试全绿<br>
> 文档职责：把 codex chat composer 输入区的颜色、长宽、布局配置以最小可运行方式复刻进 RunLedger TUI；不重做 codex 的编辑器状态机（vim / mentions / attachments 非本期目标）

## 1. 目标与范围

### 1.1 目标

把 codex `codex-rs/tui` 底部输入区（bottom pane chat composer）的可观察配置复刻到 RunLedger TUI：

1. **颜色**：输入区背景 = 终端背景按暗/亮模式 alpha 混合；左侧 prompt `›`；占位符 dim。
2. **尺寸**：输入区宽度 = 终端全宽（左 gutter 2 列、右 1 列、上下各 1 行）；高度 = 文本折行行数 + 上下留白 + footer 行，随内容动态增长，最小 3 行。
3. **布局**：transcript 占剩余空间（flex 1），输入区 + footer 占自适高度（flex 0）。
4. **footer 状态行**：输入区下方一行，左侧快捷键 hint、右侧模式指示（codex footer 语义的简化版）。

### 1.2 非目标（后续独立专项）

- vim 编辑模式、mentions `@` 高亮、图片/远端附件区（codex 的 `AttachedImage` / remote images）。
- effort tier 彩色 prompt（`›` 换 `!` 之外的多级颜色）。
- 代码块/选区等 OpenTUI 原生能力回归。

## 2. 权威参考（codex 侧实现）

| 配置 | codex 位置 | 行为 |
|------|-----------|------|
| 输入区背景色 | `codex/codex-rs/tui/src/style.rs:80-87` | `user_message_bg_rgb`：暗背景 `blend(white, bg, 0.12)`，亮背景 `blend(black, bg, 0.04)` |
| 终端背景探测 | `codex/codex-rs/tui/src/terminal_palette.rs:100-106` | crossterm `query_background_color`；`default_bg()` 取 RGB |
| 色深降级 | `codex/codex-rs/tui/src/terminal_palette.rs:72-84` | TrueColor 直出；Ansi256 用 CIE76 最近色；Ansi16 回退默认 |
| blend / is_light | `codex/codex-rs/tui/src/color.rs:1-12` | `is_light` 亮度阈值 128；`blend` alpha 线性混合 |
| 布局 insets | `codex/codex-rs/tui/src/bottom_pane/chat_composer.rs:890-940` | textarea 区域 = composer 区域 `inset(top=1, left=LIVE_PREFIX_COLS, bottom=1, right=1)` |
| 左侧 gutter 常量 | `codex/codex-rs/tui/src/ui_consts.rs:10` | `LIVE_PREFIX_COLS = 2` |
| 高度计算 | `codex/codex-rs/tui/src/bottom_pane/chat_composer.rs:4365-4397` | `textarea.desired_height(width)`（= `wrapped_lines(width).len()`）+ 附件行 + 2（上下留白）+ footer 高度 |
| 背景块渲染 | `codex/codex-rs/tui/src/bottom_pane/chat_composer.rs:4686-4687` | 无边框 `Block` + `user_message_style()` 铺背景 |
| prompt / 占位符 | `chat_composer.rs:4694-4715, 4752-4766` | `›` bold；bash 模式 `!` light red bold；禁用/空输入时占位符 dim |
| footer | `codex/codex-rs/tui/src/bottom_pane/footer.rs:220-` | `footer_height()` 一行：快捷键 hint / 队列 hint / 模式指示 |
| 整体 flex 布局 | `codex/codex-rs/tui/src/chatwidget/rendering.rs:26-58` | transcript flex 1，bottom pane flex 0（高度 = desired_height） |

## 3. RunLedger 现状基线

| 项 | 位置 | 现状 |
|----|------|------|
| 输入模型 | `src/tui/primitives.ts:150-199` | `Editor`：`> ` 前缀 + `paddingX`，折行渲染，`void this.theme`（未用色），无高度模型 |
| 编辑器子类 | `src/tui/components/custom-editor.ts` | `CustomEditor` 挂 onSubmit/onFollowUp/onDequeue；`makeEditorTheme.borderColor = identity` |
| 原生渲染 | `src/tui/opentui/component-runtime.ts:139-146` | `TextareaRenderable` **固定 `height: 3`**，`placeholder: "Message RunLedger…"`，`wrapMode: "word"` |
| footer | `component-runtime.ts:147-152` | `TextRenderable`，高度 = footer 行数（动态） |
| 主题 | `src/tui/theme/theme.ts` | 20 色槽（background/surface/surfaceAlt/border + 语义槽），`loadTheme` dark/light 硬编码 |
| 主题工厂 | `src/tui/theme/factories.ts:61-66` | `makeEditorTheme`：`borderColor = wrapFg(theme.border)` |
| 终端探测 | `src/tui/primitives.ts:512-517` | 已有 `parseOsc11BackgroundColor`（OSC 11 解析），未接线 |
| 终端模式 | `component-runtime.ts:197-207` | OpenTUI `theme_mode` 事件已接入（dark/light），仅刷 markdown syntaxStyle |

**核心差距**：输入区高度固定 3 行（codex 随内容增长）；无背景铺色（codex 有 blend 背景）；无 prompt/占位符配色；EditorTheme 未消费。

## 4. 复刻设计

### 4.1 颜色映射

新增 1 个色槽 `editorBackground`（把 05-theme.md §2 的 20 槽扩为 21 槽，单一职责原则，不与 surface/border 混用）：

```ts
// src/tui/theme/theme.ts
editorBackground: string;   // 暗: #e6e6e6 12% 混入 #0b0e14 ≈ 由 computeEditorBackground 生成
```

纯函数（对照 codex style.rs / color.rs）：

```ts
// src/tui/theme/editor-background.ts
export function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb;
export function isLight(rgb: Rgb): boolean;               // 0.299r+0.587g+0.114b > 128
export function computeEditorBackground(bg: Rgb): Rgb;     // isLight ? blend(black,bg,0.04) : blend(white,bg,0.12)
export function resolveTerminalBackground(theme: Theme, osc11: Rgb | undefined): Rgb; // OSC 11 优先,缺失回退 theme.background 的 16 进制解析
```

接线点：

- `theme/factories.ts` `makeEditorTheme`：`borderColor` 改 `wrapFg(theme.border)`（保留），新增 `backgroundColor` / `placeholderColor` 字段；`EditorTheme` 接口在 `primitives.ts:148` 扩展。
- `opentui/component-runtime.ts`：`TextareaRenderable` 加 `border: false` + `backgroundColor`，`placeholderColor` 用 dim（`wrapFg(theme.hint)`）。
- `theme_mode` 事件回调里同时重算 editor 背景（暗/亮切换即时生效）。

### 4.2 尺寸与布局

对照 codex `ui_consts.rs` 与 `chat_composer.rs`：

| 常量 | codex | RunLedger 落地 |
|------|-------|----------------|
| 左 gutter | `LIVE_PREFIX_COLS = 2` | `EDITOR_LEFT_PAD = 2`（prompt 列 + 1 空列） |
| 右留白 | 1 列 | `EDITOR_RIGHT_PAD = 1` |
| 上下留白 | 各 1 行 | `EDITOR_VERTICAL_PAD = 1` |
| 最小高度 | 3 | `EDITOR_MIN_HEIGHT = 3` |

高度模型：

```ts
// src/tui/editor-height.ts
export function editorHeight(text: string, width: number): number {
  const innerWidth = Math.max(1, width - EDITOR_LEFT_PAD - EDITOR_RIGHT_PAD);
  const lines = wrapCount(text, innerWidth);            // 纯组件按单词边界折行
  return Math.max(EDITOR_MIN_HEIGHT, lines + EDITOR_VERTICAL_PAD * 2);
}
```

接线点：

- `opentui/component-runtime.ts`：帧高度进入原生层后，再以 `TextareaRenderable.editorView.measureForDimensions(width - 3)` 校正真实 word-wrap 行数；editorRow 显式 `paddingRight=1`，高度上限为 viewport 扣除 footer 与至少 1 行 transcript 后的剩余空间，达到上限后 textarea 内部滚动。
- `TUI.renderFrame`（`primitives.ts:370-395`）把编辑器高度交给 focused component 的 `desiredHeight`（Editor 新增 `desiredHeight(width)`），`OpenTuiComponentFrame` 增加 `editorHeight` 字段。

### 4.3 prompt 与占位符

- `Editor.render`（`primitives.ts:175-181`）：前缀 `> ` 改为 `› `，prompt 用 `EditorTheme.prompt`（bold + accent）；空文本渲染占位符（`placeholder` 属性，dim 色），替代当前纯空行。
- 纯组件与原生组件一致：OpenTUI `TextareaRenderable.placeholder` 保留，但颜色用 hint 槽。
- 非目标内的 bash 模式 prompt（`!` light red）留接口：`EditorTheme.promptFor(text)` 由未来 bash 模式消费。

### 4.4 footer 状态行（codex footer 语义简化版）

现 `Footer`（status/session/model）保留为信息行；新增 codex 风格的 hint 行挂在编辑器下方：

- 左侧：快捷键 hint（submit / followUp / interrupt / quit，来自 `KeybindingsManager.getResolvedBindings()`）。
- 右侧：当前模式指示（idle / working / waiting，复用 `FooterSnapshotProvider.getRunTiming()`）。
- 宽度不足时左侧优先截断（对照 codex `single_line_footer_layout` 的左右压缩规则）。
- 只在输入区聚焦时显示，与 codex `ComposerEmpty` 语义对齐（任务运行中显示队列 hint 为后续）。

## 5. 分阶段实施

### S0 · 色槽与背景计算（纯函数 + 主题）

- [x] `src/tui/theme/theme.ts`：新增 `editorBackground` 槽（dark/light 各一真值）。
- [x] `src/tui/theme/editor-background.ts`：`blend` / `isLight` / `computeEditorBackground` / `resolveTerminalBackground`。
- [x] `src/tui/theme/factories.ts` + `primitives.ts:148`：`EditorTheme` 扩展 `backgroundColor` / `placeholderColor`。
- [x] `tests/tui/factories.test.ts`：blend 边界（alpha 0/1）、isLight 阈值、computeEditorBackground 暗/亮两分支。

验收：`npm run check` + `npm test` 通过；纯函数单测覆盖 codex style.rs 同值样例（如 bg `#0b0e14` → 12% 白混入 ≈ `#26292f`）。

> 实施注：codex Rust `as u8` 为截断语义,精确值为 `#282a30`(非四舍五入的 `#26292f`);单测按截断值断言。
> 暗背景保底：codex 在纯黑终端(bg=#000000,如 tmux 默认)下产出 `#1e1e1e`,肉眼不可辨;
> RunLedger 将暗分支结果保底到主题静态回退值 `#282a30`(computeEditorBackground 内实现)。

### S1 · 动态高度与 insets

- [x] `src/tui/editor-height.ts`：常量 + word-wrap `editorHeight` 计算。
- [x] `primitives.ts` Editor：新增 `desiredHeight(width)`；`render` 用左 pad 2 / 右 pad 1 折行。
- [x] `component-runtime.ts`：`OpenTuiComponentFrame.editorHeight`，原生 word-wrap 实测校正，右侧 1 列 inset，viewport 高度上限；`TextareaRenderable` 加 `backgroundColor`。
- [x] `tests/tui/opentui-component-runtime.bun.test.ts`：空文本 3 行、多行增长、单词折行完整可见、左右 inset、长输入仍保留 transcript/footer。
- [x] `tests/tui/editor-height.test.ts`：折行计数与 min-height。

验收：`npm run test:tui-native` 通过；多行输入时输入区随内容增长；达到 viewport 上限后 textarea 内部滚动，transcript 至少保留 1 行且 footer 始终可见。

> 实施注：原生侧把输入区改为 row 布局(editorRow = prompt 2 列 + textarea + 右 padding 1,上下 padding 各 1),
> 对应 codex composer inset(top=1, left=2, bottom=1, right=1);TextareaRenderable 无 border 选项,
> 现实现本就不渲染边框,"border: false" 语义天然满足。

### S2 · prompt / 占位符配色

- [x] `EditorTheme.prompt`（bold + accent）、`placeholderColor` 消费；`Editor.render` 改 `›` 前缀。
- [x] OpenTUI 侧 placeholder 颜色接 hint 槽。
- [x] 快照断言：空输入显示 dim 占位符、非空输入 `›` bold accent。

验收：交互 smoke 目测暗/亮模式均清晰；占位符与 codex 同为 dim。

> 实施注：原生 prompt 用 24-bit 精确色(`38;2`),不经过 16 色降级,与主题 hex 严格一致;
> 顺带修复 `theme/ansi.ts` 16 色回退的两处既有 bug(立方解码缺 `-16`、亮色 SGR off-by-8)。

### S3 · footer hint 行

- [x] 新增 `src/tui/components/editor-hint.ts`：左侧 keybindings hint、右端对齐模式指示，左右压缩规则。
- [x] `InteractiveMode` 装配：Editor 下方插入 hint 行，仅 editor 聚焦、terminal focused 且无 overlay 时显示；focus boundary 触发重绘。
- [x] `tests/tui/editor-hint.test.ts` + `tests/tui/interactive-controls.test.ts`：右端列、窄宽度截断、blur/focus 可见性与重绘。

验收：运行中显示 queue/working 指示，空闲显示快捷键 hint。

### S4 · 终端跟随（OSC 11 + theme_mode）

- [x] `primitives.ts`：接入 `parseOsc11BackgroundColor`（TUI 启动时探测，失败回退 theme.background）。
- [x] `theme_mode` 回调重算 `editorBackground` 并刷 editor 渲染。
- [x] `tests/tui/opentui-component-runtime.bun.test.ts`：真实 renderer 的 theme_mode callback 更新 editor row backgroundColor，并覆盖 OSC 11 转发。
- [x] `tests/tui/interactive-controls.test.ts`：`InteractiveMode` 的 theme_mode / OSC 11 输入重算 production editor appearance。

验收：切换终端暗/亮模式输入区背景即时跟随；无 OSC 11 终端回退静态主题不白屏。

> 实施注：OSC 11 探测复用 OpenTUI 自身的终端颜色查询——runtime 经 `renderer.subscribeOsc`
> 转发原始序列(`onOsc`),TUI 在 `start()` 中解析并广播;无回复时 `resolveTerminalBackground`
> 回退 `theme.background` 解析,主题槽保持一致。
> 接线回归：InteractiveMode 曾把 `resolveTerminalBackground` 的原值(终端背景)直接当输入区
> 背景,导致无 OSC 时输入区与 transcript 同色(`#0b0e14`,肉眼为黑);已改为
> `editorBackgroundFromTerminal`(resolve → computeEditorBackground → hex)并由单测钉住。
> OSC 11 回复同时兼容 `rgb:rr/gg/bb` 与 `#rrggbb` 两种格式(与 OpenTUI 解析器对齐)。

## 6. 验收标准

1. `npm run check`、`npm test`、`npm run test:tui-native`（Bun OpenTUI 测试）全绿；`npm run build` 通过。
2. 输入区视觉与 codex 对齐：背景 = 终端背景 blend；`›` prompt；dim 占位符；无边框。
3. 输入区高度随内容增长、常规 viewport 下最小 3 行；正文宽度 = 终端全宽减 3 列；长输入不把 transcript/footer 推出 viewport。
4. 暗/亮主题切换即时生效；OSC 11 可用时跟随真实终端背景。
5. 无回归：现有 opentui-boundary / streaming / passive-contract 测试保持绿。

## 7. 相关文档

- 主题 schema：[`../tui/05-theme.md`](../tui/05-theme.md)（S0 需同步 21 槽位表与验收标准）
- 渲染契约：[`../tui/04-rendering.md`](../tui/04-rendering.md)
- 组件规格：[`../tui/02-component-spec.md`](../tui/02-component-spec.md)（§11 CustomEditor 需同步）
- codex 参考：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/codex/codex-rs/tui/src/`（§2 列表）
