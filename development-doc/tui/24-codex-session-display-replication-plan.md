# RunLedger TUI Codex 会话展示区完整复刻计划

> 状态：**S0–S7 已实现并通过 fresh evidence；状态：implemented/accepted**
>
> 计划日期：2026-08-14
>
> RunLedger 基线：`session-owner-runtime@dd760d6`（`fix(tui): stop denied turns and align wide-cell cursors`）
>
> Codex 固定参照：`main@0b175e6439a8608ba7726ee153fd8590619e8f34`
>
> 交付性质：本文冻结会话展示区（transcript 区域）的展示块语义、布局契约、实施阶段与验收；状态指示行与 Ctrl+T 转写视图已落地，最终人工验收已随 S7 完成。

---

## 0. 权威边界与工作树事实

### 0.1 本计划拥有的范围

本文是以下能力的唯一实施入口：

- 会话展示区的**块级分段语义**：plan-update（todo）、exec、diff、separator、notice 五类块的 Codex 等价布局；
- `PresentationBlock` 层的块合同扩展与 `timeline → block` 投影规则补全；
- 任务运行中状态指示行（spinner / elapsed / interrupt hint / inline message）；
- Ctrl+T 全量转写视图（transcript overlay）；
- status line 缺失段（progress / usage / limit / thread）的发射接线；
- 块级截断、前缀缩进、glyph、duration 格式等布局常量与纯函数。

本文不替换以下既有权威：

| 专项 | 继续拥有的 authority | 本计划的接缝 |
|---|---|---|
| [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | OpenTUI renderer、renderable 生命周期、滚动、输入与 overlay 框架 | 只新增块 renderable 与帧段，不改 `component-runtime` 的 keyed/diff 机制 |
| [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | 流式合并、持久 keyed identity、背压、长会话预算 | 所有流式块沿用既有 `TimelineRow` identity 与 coalescer，本文不建第二流式通道 |
| [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md) | Timeline、safe presentation、reducer/effect/adapter 生产接线 | plan/todo 数据源与投影边界由本文冻结合同，接线归属 19 |
| [`20-codex-slash-command-adaptation-plan.md`](20-codex-slash-command-adaptation-plan.md) | `/plan`、`/todo` 等命令注册与派发 | 本文只消费派发结果，不改命令链路 |
| [`22-opencode-conversation-scrollbar-adaptation-plan.md`](22-opencode-conversation-scrollbar-adaptation-plan.md) | transcript 滚动、sticky、new-content 指示 | 转写视图是独立 overlay，不动主对话滚动 authority |
| [`23-codex-syntax-highlighting-replication-plan.md`](23-codex-syntax-highlighting-replication-plan.md) | 语法高亮、syntax theme、diff scope 背景、status scope | 本文只组合 23 的 `SyntaxHighlightService` 输出，不引入新颜色引擎 |
| [`../plan/02-codex-input-area-replica-plan.md`](../plan/02-codex-input-area-replica-plan.md) | composer、footer hint 行、editor 高度模型 | 状态指示行位于 transcript 与 editor 之间，是独立帧段 |
| [`runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md) | Session owner、cwd 隐私、approval 正文授权 | TUI 只消费安全展示标签，不放宽任何 DTO 边界 |

### 0.2 当前工作树边界

计划编写时仓库存在与本专项无关的未提交改动（`git status --short` 快照）：

- `AGENTS.md`；
- `development-doc/00-index.md`；
- `development-doc/tui/00-overview.md`；
- `development-doc/worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`；
- `src/tui/opentui/component-runtime.ts`；
- 未跟踪：`development-doc/tui/23-codex-syntax-highlighting-replication-plan.md`。

本轮文档只新增本文，并在 `development-doc/00-index.md` 与 `development-doc/tui/00-overview.md` 两个索引中追加最小导航。未来执行本文时必须逐路径审阅和暂存，不得把共享工作树中的其他修改归入本专项。

### 0.3 证据口径

- `HEAD` 只说明已提交基线，不包含当前工作树候选；
- 本文的 RunLedger 现状来自 2026-08-14 对 `src/tui/` 源文件、测试与 `development-doc/tui/` 计划文档的只读检查；
- Codex 行为以固定参照 commit 的源码为准（`codex-rs/tui/src/`），不以描述性总结代替；
- 自动测试、标准 PATH PTY 与人工视觉验收必须分开记录；
- 任一阶段只在 fresh evidence 完成后更新状态。

---

## 1. 目标、等价定义与非目标

### 1.1 最终目标

在不 fork OpenTUI、不改变 Session/ledger 正文 authority、不重复 17/18/22/23 已冻结能力的前提下，让 RunLedger TUI 的会话展示区复现 Codex 的块级展示语义：

1. 计划更新以 checkbox todo 列表展示（✔ / □ 字形、状态色、`  └ ` 前缀缩进）；
2. 命令执行块按 Codex ExecCell 布局渲染（活动 bullet、标题、bash 高亮首行、`  │ ` 续行前缀、`  └ ` 输出前缀、中段截断、duration/exit glyph）；
3. diff 块补全行号 gutter 与 delete DIM 叠加，其余样式复用 23 的 scope 背景；
4. 轮次分隔只在有实际工作的轮次出现，并携带 worked-for 与运行时指标；
5. 任务运行中在 editor 上方渲染单行状态指示（动画 indicator、紧凑计时、中断提示、可选 inline message）；
6. Ctrl+T 打开全量转写视图：committed rows + 活跃尾部，exec 以 `$` 前缀完整形式呈现；
7. status line 补全 progress / usage / limit / thread 段，颜色经 23 的 scope 解析。

### 1.2 “完整复刻”的判定

完整复刻不是“字形近似”，而是同时满足：

- 同一布局常量（前缀字符串、缩进列数、截断上限、gutter 宽度规则）；
- 同一状态 glyph 语义（✔/✗/•/⏳ 与成功/失败/运行中的映射）；
- 同一截断策略（先 wrap 后按屏幕行截断、中段省略、省略提示保留转写视图入口）；
- 同一前缀缩进体系（`  │ ` 续行、`  └ ` 块首、4 空格续行对齐）；
- 显示文本与可选择/可复制文本一致（样式只叠加，不改文本）；
- RunLedger 特有的 OpenTUI、Session privacy、safe projection bounds 与流式调度边界闭合。

若只能靠拼接 ANSI 字符串做近似排版，应标记为“非等价方案”，不得命名为 Codex 复刻完成。

### 1.3 非目标

- 不复制 Codex 的 ratatui widget、Markdown parser 或完整 TUI；
- 不重写 renderable 生命周期、滚动、culling 或 keyed diff（17/18 权威）；
- 不新建语法高亮、theme 或颜色转换（23 权威）；
- 不改变 shell 输出 retention（`SHELL_TAIL_LINES_PER_CHANNEL=100` 不变，转写视图只显示 bounded tail 并标记 truncated）；
- 不实现 Codex 的终端 scrollback 直写与 raw-lines 复制语义（RunLedger 的选择/复制由 OpenTUI `selectable` 承担）；
- 不实现 exploring 分组（Read/List/Search/Run 归组），见 D9；
- 不把 plan/todo 或转写视图变成 Runtime durable state 或 ledger 正文；
- 不放宽 `WorkspaceExecutionEnvelope` 的 native path 脱敏规则。

---

## 2. 固定参照源码与 RunLedger 当前差距

### 2.1 Codex 源码地图

| 能力 | 固定参照路径 | 核心事实 |
|---|---|---|
| 块分段模型 | `codex-rs/tui/src/history_cell/mod.rs` | `HistoryCell` trait：`display_lines(width)` / `raw_lines()` / `transcript_lines(width)` / `desired_height(width)`；cell 是会话内容唯一渲染单元 |
| plan update（todo） | `codex-rs/tui/src/history_cell/plans.rs` | `PlanUpdateCell`：标题 `• Updated Plan` bold；`✔` crossed-out+dim（Completed）、`□` cyan+bold（InProgress）、`□` dim（Pending）；说明 dim italic；`"  └ "` 前缀 + 4 空格续行；宽度 `width-4` wrap |
| plan 状态映射 | `codex-rs/tui/src/chatwidget/protocol.rs` | `TurnPlanStepStatus::{Pending,InProgress,Completed}` → `UpdatePlanItemStatus` |
| exec 布局 | `codex-rs/tui/src/exec_cell/render.rs` | `EXEC_DISPLAY_LAYOUT`：续行块 `"  │ "`（max 2 行）、输出块 `"  └ "`（max 5 行）；`TOOL_CALL_MAX_LINES=5`、`USER_SHELL_TOOL_CALL_MAX_LINES=50`；活动 marker 动画 bullet；先 wrap 再 `truncate_lines_middle`，省略 `… +N lines (Ctrl+T for transcript)`；`transcript_lines` 用 `$ ` magenta + 完整输出 + `✓/✗ (code) • duration` |
| 命令高亮 | `codex-rs/tui/src/render/highlight.rs` | `highlight_bash_to_lines`；RunLedger 对应 23 的 `SyntaxHighlightService.highlight({language:"bash"})` |
| diff | `codex-rs/tui/src/diff_render.rs` | 每行三段：右对齐行号 gutter（`line_number_width(max_line_number)`）+ `+`/`-`/空格 sign + 内容；整行背景 `RtLine::style`；Update 按 hunk 整体高亮、Delete 叠加 DIM；`wrap_styled_spans` 按显示宽度切分且保留样式；tab 替换 4 空格 |
| patch 摘要 | `codex-rs/tui/src/history_cell/patches.rs` | `PatchHistoryCell` → `create_diff_summary` → `render_change` |
| 轮次分隔 | `codex-rs/tui/src/history_cell/separators.rs` | `FinalMessageSeparator`：只在 `had_work_activity` 的轮次出现；`worked for X` + `runtime_metrics_label` |
| 通知 | `codex-rs/tui/src/history_cell/notices.rs` | `PrefixedWrappedHistoryCell`：`⚠ ` yellow 前缀 + 2 空格续行 |
| 状态指示行 | `codex-rs/tui/src/status_indicator_widget.rs` | 单行：spinner + header shimmer + `(12s • ^C to interrupt)` + inline message；details 行 `  └ ` 前缀 max 3；32ms 帧调度 |
| 转写视图 | `codex-rs/tui/src/pager_overlay.rs`、`thread_transcript.rs` | Ctrl+T 全量 cells + 活跃 cell 缓存尾部；`ActiveCellTranscriptKey` 缓存失效；`transcript_animation_tick` |
| status line 项 | `codex-rs/tui/src/chatwidget/status_surfaces.rs` | 可配置 items（model-with-reasoning / current-dir / git-branch / context-window / plan progress / rate-limit windows）；plan 进度 `(n/m)` |

### 2.2 RunLedger 当前链路

| 维度 | 当前实现 | 差距 |
|---|---|---|
| 块协议 | `src/tui/presentation.ts` `PresentationBlock`：text / markdown / command / exec / diff / status-line / separator / select / input | 无 plan-update 块；exec/diff/separator 无布局字段（前缀、截断上限、行号） |
| timeline → block | `src/tui/timeline/selectors.ts` `rowToBlocks`：user→text、assistant→markdown、shell tool→exec、notice→前缀文本、run-boundary→separator | 无 plan 行；separator 只有 run-boundary，无 per-turn 与 worked-for 过滤；notice 是纯文本拼接 |
| todo | `src/tui/task-goal/types.ts`、`src/tui/goal-plan/types.ts` 只有类型；`taskGoal` port 从未接线（`session-resources.ts` `createAvailableResourcePorts` 不含它）；`/plan` 只输出一行 notice（`interactive-mode.ts` 1096-1103） | 无任何 checkbox/todo 渲染器，无 plan-step 数据投影 |
| exec 块 | `src/tui/opentui/exec-renderable.ts`：plaintext-first `$ {command}  {✓|✗|status} · {ms}`，bash 异步高亮，输出 DIM | 无续行前缀 `  │ `、无输出前缀 `  └ `、无 5/50 行分档截断、无中段省略 + 转写提示、无 `(no output)`、无 exploring 分组 |
| diff 块 | `src/tui/opentui/diff-renderable.ts`：header `diff {path} (+N -M)`、`+/-/ ` 前缀、add/delete 前景 + `backgrounds.inserted/deleted` 背景 | 无行号 gutter（`SafeDiffLine.oldLine/newLine` 已解析但未用）、无 per-line/hunk 语法高亮、无 delete DIM 叠加 |
| 分隔/通知 | run-boundary separator 已有（`{stopReason} · Worked for {duration}`）；notice 行按 severity 前缀文本 | 无 per-turn 分隔、无 worked-for 过滤、无 runtime metrics；notice 无独立样式块 |
| 状态指示 | footer 只显示文本状态（`Working 12s` / `...`）；`status.ts` 是 legacy 纯文本 `turn:N stop:X tok:…`；`AbortButtonComponent` 是占位（“本期占位,不做实际中断”） | 无 spinner 动画、无 elapsed 紧凑格式、无中断提示、无 inline message；全仓无动画 tick 基础设施 |
| 转写视图 | 无 Ctrl+T；overlay 机制存在（`component-runtime.ts` 绝对定位 BoxRenderable + select/input 块） | 缺全量 transcript 投影、pager 交互与活跃尾部缓存 |
| status line 段 | `status-style.ts` 已定义 `StatusLineAccent` 含 usage/limit/thread/progress 与 scope 映射；`footer.ts` `OPTIONAL_DROP_ORDER` 已含这些段 | 从未发射 progress/usage/limit/thread 段；plan 进度 `(n/m)`、context window 百分比无数据源接线 |
| 调度 | `FrameScheduler` 16ms 窗口 + backlog 强制 flush；`startRunTicker` 1s 轮询 | 无时间驱动动画帧（spinner 需要） |

### 2.3 不采用的替代路线

| 方案 | 可取之处 | 不作为 canonical 复刻的理由 |
|---|---|---|
| 在 legacy `Component.render(width)` 层拼 ANSI 字符串块 | 改动最小 | 生产路径已走 `PresentationBlock → OpenTUI`，双轨排版会漂移；违反“显示=可复制文本”的 StyledText 要求 |
| 给 `TimelineRow` 增加 plan/exec/diff 行种类 | 行种类与块一一对应 | exec/diff 已是 tool 行的投影产物；加行种类会迫使 19 改 reducer 与 replay 协议，收益为零 |
| 状态指示用 `setInterval` 独立驱动 | 简单 | 与 16ms 帧窗口脱钩会引入第二时钟源与合帧竞争；违反 D5 |
| 转写视图复用主 ScrollBox 做第二内容源 | 少一个 overlay | 破坏 22 的滚动 authority 与 sticky 语义 |
| 放大 `SHELL_TAIL_LINES_PER_CHANNEL` 以支持完整转写 | 转写视图最接近 Codex | 改变安全投影 retention 是 19 的决策；本文不改 retention |

---

## 3. 冻结决策与停止条件

### D1：块合同扩展只发生在 `PresentationBlock` 层

新增 `plan-update` 块，扩展 exec/diff/separator 块的布局字段。不新增 timeline 行种类；plan/todo 的展示数据由 tool 行（`SafeToolPresentation` 新 renderer `plan`）或既有 workflow 状态投影而来。`timeline → block` 的投影规则只改 `timeline/selectors.ts` 与 `presentation/tools/projector.ts`，reducer 与 replay 协议不动。

### D2：显示截断是投影职责，完整语义留在 source

所有块级截断（exec 5/50 行、diff 400 行、todo 步骤数）发生在投影/渲染层，原文（`SafeBoundedText` / `SafeToolPresentation` / timeline 行）保持 authority。省略提示必须携带转写视图入口（`Ctrl+T`）。任何块不得以截断为由丢失已进入 safe presentation 的文本。

### D3：转写视图是只读 overlay，复用既有 overlay 机制

Ctrl+T 打开独立 overlay（绝对定位 BoxRenderable + 文本块），内容 = 全量 committed rows 的 transcript 投影 + 活跃 cell 尾部缓存。只读：无审批、无编辑、无第二交互 authority；Esc/Ctrl+C 关闭，关闭后主对话 sticky 与滚动状态不变。

### D4：布局常量集中命名并与 Codex 对齐

所有前缀、缩进、截断上限放入单一模块（`src/tui/opentui/block-layout.ts` 或同类路径），命名与 Codex 常量一一对应（见 §5.7）。禁止在 renderable 内散落魔法字符串。

### D5：动画 tick 走共享帧调度

状态指示行的 spinner 需要时间驱动重绘。tick 复用 `FrameScheduler` 的窗口调度（新增最低限度的 `scheduleFrameIn(ms)` 语义或等价物），不引入 `setInterval` / 私有时钟。调度扩展在 S5 RED 前与 17/18 的执行边界核对；若被否决，降级为 1s run ticker 驱动的静态指示（明确标记非等价）。

### D6：颜色与高亮只消费 23 的 `SyntaxHighlightService`

exec 命令高亮、diff scope 背景、status scope 全部走 23 的服务。本文只做布局叠加（前缀、缩进、gutter、DIM）。任何新颜色需求先在 23 立项，不在本文实现。

### D7：所有文本经 safe projector bounds，不绕过脱敏

plan 步骤、todo 文本、exec 输出、diff 行、separator 标签都必须来自既有 safe presentation（`SafeBoundedText`、`SafeDiffDocument`、`SafeToolPresentation`），沿用 `TOOL_TEXT_BOUND_BYTES=64KiB`、`LABEL_BOUND_BYTES=120` 等边界。不因展示需要恢复 raw args、凭证或 native path。

### D8：显示文本 = 可选择/可复制文本

所有新 renderable 基于 `selectable` 的 StyledText；样式（颜色、DIM、粗体）只叠加不改变文本内容。glyph 前缀（`✔ `、`  │ `）属于显示层，复制时是否包含由 OpenTUI selection 语义决定，不额外维护第二份 raw 文本。

### D9：exploring 分组暂缓

Codex 的 `Exploring` / `Read·List·Search·Run` 归组依赖对 read/grep 类工具的相邻归并，RunLedger 当前每个 tool call 是独立行。归并会改变行 identity（与 18 的 keyed identity 冲突），默认关闭。开启条件：先有 read/grep 的结构化行展示，再由独立计划评估归并，本文不实现。

---

## 4. 目标架构

```text
AgentEvent / workflow state
   │
   ▼
TimelineRow (user/assistant/tool/notice/goal/queue/agent/run-boundary)   ← 19 权威, 不动
   │  rowToBlocks (timeline/selectors.ts)
   ▼
PresentationBlock[]   ← 本文扩展: plan-update / exec 布局字段 / diff 行号字段
   │  ChatContainer.present → OpenTuiComponentFrame.body
   ▼
component-runtime.ts body map (keyed renderable diff)  ← 17 权威, 只加映射
   ├─ PlanUpdateRenderable      (新增)
   ├─ ExecRenderable            (升级: 前缀/截断/transcript 形式)
   ├─ DiffRenderable            (升级: 行号 gutter / hunk 高亮 / DIM)
   ├─ TextRenderable            (separator/notice 样式块)
   └─ Markdown/Syntect/Mermaid  (不动)

状态指示行:  ActiveRunState + FrameScheduler tick
   │  projectStatusIndicator(state, keymap, elapsed)
   ▼
OpenTuiComponentFrame.statusIndicator (新增帧段, transcript 与 editor 之间)

转写视图:  Ctrl+T → projectTranscriptOverlay(timeline, activeTail)
   │  全量 committed rows + active cell 尾部, transcriptForm
   ▼
overlay BoxRenderable + TranscriptPagerState (新增, 只读)
```

---

## 5. 精确合同

### 5.1 PlanUpdateBlock（todo）

```ts
// src/tui/presentation.ts 扩展
export type PlanStepStatus = "pending" | "in-progress" | "completed";

export interface PlanStepView {
  /** 步骤文本, 已经 safe projector bounds 的 SafeBoundedText */
  readonly text: SafeBoundedText;
  readonly status: PlanStepStatus;
}

export type PlanUpdateBlock = {
  readonly id?: string;
  readonly kind: "plan-update";
  /** 说明性注释, 可选 */
  readonly explanation?: SafeBoundedText;
  readonly steps: readonly PlanStepView[];
};
```

投影规则：

- `TurnPlanStepStatus::{Pending,InProgress,Completed}` → `PlanStepStatus`（与 Codex `protocol.rs` 映射一致）；
- 空 steps + 无 explanation 的 update 不产生块（不显示 `(no steps provided)` 空壳，除非 explanation 存在）。

### 5.2 ExecBlock 布局字段

```ts
// src/tui/presentation.ts exec 块扩展
{
  kind: "exec";
  command: string;                    // 已存在
  status: /* 已存在 */;
  output: /* 已存在 */;
  exitCode?: number;                  // 已存在
  durationMs?: number;                // 已存在
  background?: boolean;               // 已存在
  // --- 本文新增 ---
  /** 命令续行前缀, 默认 "  │ ", 空串关闭续行块 */
  continuationPrefix?: string;
  /** 命令续行最多显示的屏幕行数, 默认 2 */
  continuationMaxLines?: number;
  /** 输出块首行前缀, 默认 "  └ " */
  outputPrefix?: string;
  /** 输出块最多显示的屏幕行数: tool=5, 用户 shell=50 */
  outputMaxLines?: number;
  /** 转写视图形式: "dollar" = $ 前缀 + 完整输出; 默认 "dollar" */
  transcriptForm?: "dollar";
}
```

省略提示文本：`… +N lines (Ctrl+T for transcript)`，`N` = 被截断的屏幕行数。

### 5.3 DiffBlock 行号字段

```ts
// src/tui/presentation.ts diff 块扩展
{
  kind: "diff";
  document: SafeDiffDocument;   // 已存在, SafeDiffLine 已含 oldLine/newLine
  // --- 本文新增 ---
  /** 显示行号 gutter, 默认 true; false 时与现行为一致 */
  showLineNumbers?: boolean;
  /** 行号列宽, 由 lineNumberWidth(maxLineNumber) 计算, 渲染层不自行推断 */
  lineNumberWidth?: number;
  /** 是否允许 hunk 级语法高亮, 默认 true; 高亮仍受 23 的 guardrails */
  syntaxHighlight?: boolean;
}
```

### 5.4 Separator 与 notice

- `separator` 块已有；新增可选字段 `metrics?: readonly string[]`（runtime metrics 标签，DIM 显示）。
- per-turn 分隔的产生条件：turn 内存在 tool 行或 plan-update 块（`had_work_activity` 语义），由 selector 决定；标签 `Worked for {duration}` 复用既有 `formatActiveDuration`。
- notice 块保持 text 前缀形式（`error:` / `warning:` / `note:`），升级为独立样式块：`⚠ ` yellow 前缀 + 2 空格续行（`PrefixedWrappedHistoryCell` 语义），仅样式层改动。

### 5.5 StatusIndicatorRow（帧段）

```ts
// src/tui/presentation.ts 新增
export interface StatusIndicatorView {
  /** 头部文本, 如 "Working"; 空串只显示 indicator + elapsed */
  readonly header: string;
  /** 可选 inline message (后台进程摘要等) */
  readonly inlineMessage?: string;
  /** 中断按键显示文本, 如 "^C"; 存在时渲染 "(12s • ^C to interrupt)" */
  readonly interruptKey?: string;
  /** 详情行, max 3, "  └ " 前缀 */
  readonly details?: readonly SafeBoundedText[];
}
```

- 位置：`OpenTuiComponentFrame.statusIndicator`，渲染于 transcript 与 editor-row 之间，高度 = 1 + details 行数。
- 驱动：`ActiveRunState.state === "working"` 或 `"waiting"` 时可见；elapsed 来自 run 的 startedAt；interruptKey 来自 keymap。
- tick：见 D5。

### 5.6 TranscriptOverlay（Ctrl+T）

```ts
export interface TranscriptOverlayView {
  readonly rows: readonly PresentationBlock[];  // committed rows 的 transcript 投影
  readonly liveTail?: readonly PresentationBlock[]; // active cell 尾部缓存
}
```

- exec 块以 `transcriptForm: "dollar"` 投影：`$ ` magenta + bash 高亮命令 + bounded 输出 + `✓/✗ (code) • duration`；
- plan-update 以 raw 形式（`Completed: step`）投影；
- 交互：j/k 上下、g/G 首尾、PgUp/PgDn、Esc/Ctrl+C 关闭；无编辑能力。

### 5.7 布局常量对照表

| Codex 常量 | 值 | RunLedger 常量（建议名） |
|---|---|---|
| `PrefixedBlock command_continuation` | `"  │ "` / `"  │ "`，max 2 | `EXEC_CONTINUATION_PREFIX`、`EXEC_CONTINUATION_MAX_LINES=2` |
| `PrefixedBlock output_block` | `"  └ "` / `"    "`，max 5 | `EXEC_OUTPUT_PREFIX`、`EXEC_OUTPUT_MAX_LINES=5` |
| `TOOL_CALL_MAX_LINES` / `USER_SHELL_TOOL_CALL_MAX_LINES` | 5 / 50 | `EXEC_OUTPUT_MAX_LINES_TOOL=5`、`EXEC_OUTPUT_MAX_LINES_USER_SHELL=50` |
| `MAX_INTERACTION_PREVIEW_CHARS` | 80 | `EXEC_INTERACTION_PREVIEW_CHARS=80`（交互预览时） |
| plan update 前缀 | `"  └ "` dim + 4 空格 | `PLAN_STEP_PREFIX`、`PLAN_STEP_CONTINUATION_INDENT` |
| plan wrap 宽度 | `width - 4` | `planWrapWidth(width) = max(1, width-4)` |
| diff 行号宽度 | `line_number_width(max_line_number)` | `diffLineNumberWidth(maxLineNumber)` |
| diff tab | 4 空格 | `DIFF_TAB_REPLACEMENT="    "` |
| status details | `"  └ "`，max 3 | `STATUS_DETAILS_PREFIX`、`STATUS_DETAILS_MAX_LINES=3` |
| notice 前缀 | `"⚠ "` yellow + `"  "` | `NOTICE_WARN_PREFIX`、`NOTICE_CONTINUATION_INDENT` |
| `fmt_elapsed_compact` | `0s / 59s / 1m 00s / 1h 00m 00s` | `formatElapsedCompact(secs)`（新纯函数，不动 `formatActiveDuration`） |
| 省略提示 | `… +N lines (Ctrl+T for transcript)` | `EXEC_TRUNCATION_HINT` |

---

## 6. 各展示面目标行为

### 6.1 plan-update（todo）

```
• Updated Plan                     ← bold
  └ (explanation)                  ← dim italic
  └ ✔  已完成步骤                    ← 绿 + 删除线 + dim
  └ □  进行中步骤                    ← cyan + bold
  └ □  待处理步骤                    ← dim
```

- 前缀 `"  └ "` dim；续行缩进与首行内容对齐（4 空格）；
- 步骤文本按 `width-4` wrap；
- 空 steps 且无 explanation → 不渲染块；
- raw/转写形式：`Completed: {step}` / `InProgress: {step}` / `Pending: {step}`；
- 计划进度 `(n/m)` 同步进入 status line `progress` 段（§6.7）。

### 6.2 exec

```
◌ Running npm install foo          ← 动画 bullet + "Running" bold + 首行命令(bash 高亮)
  │ --save                          ← 续行前缀 dim, max 2 屏幕行
  └ added 3 packages in 2s          ← 输出前缀 dim, max 5(工具)/50(用户 shell) 屏幕行
    … +12 lines (Ctrl+T for transcript)   ← 中段截断提示 dim
✓ Ran grep -r foo src/              ← 完成后: 绿• + "Ran", ✓ • 1.2s 或 ✗ (exit) • 1.2s
```

- bullet 三态：运行中 = tick 动画；成功 = 绿 `•`；失败 = 红 `•`；
- 输出先 wrap 后截断（截断针对屏幕行而非逻辑行）；
- 空输出显示 `(no output)` dim；
- `background` 工具追加 `(bg)` 标记；
- 转写形式：每条命令 `$ ` magenta + bash 高亮 + bounded 完整输出 + `✓/✗ (code) • duration`；
- 命令高亮失败时降级 plaintext（23 护栏），布局不受影响。

### 6.3 diff

```
diff src/foo.rs (+3 -1)            ← bold header, 已存在
  42 │   fn bar() {
  43 │ +   let x = 1;              ← add: 绿前景 + inserted 背景
  44 │ -   let y = 2;              ← delete: 红前景 + deleted 背景 + DIM(语法高亮时)
```

- 行号 gutter 右对齐，宽度 = `diffLineNumberWidth(maxLineNumber)`，来自 `SafeDiffLine.oldLine/newLine`；
- `showLineNumbers=false` 时与现行为完全一致（回归门槛）；
- hunk 级语法高亮：整 hunk 一次性送入 23 的 service（保留跨行解析状态），Delete 行结果叠加 DIM；
- 高亮触发遵守 23 的 guardrails 与 HighlightAdmission（visible/overscan 才调度）；
- 长行 wrap 保持样式跨行（复用 23 的 span 输出，不自行切分）；
- 背景优先级：theme scope（23 `diffScopeBackgrounds`）→ 现有 fallback 调色板。

### 6.4 separator / notice

- run-boundary 分隔保留（`{stopReason} · Worked for {duration}`）；
- 新增 per-turn 分隔：仅当该 turn 有 tool 行或 plan-update 块；标签 `Worked for {duration}`，可选 metrics 追加 DIM `• {metrics}`；
- notice：`⚠ ` yellow 前缀 + 2 空格续行；error/note 语义色沿用 23 的 status scope 解析。

### 6.5 状态指示行

- 单行：`{indicator} {header} ({elapsed} • ^C to interrupt) · {inlineMessage}`，超宽省略号截断；
- elapsed 用 `formatElapsedCompact`；
- details 最多 3 行，`  └ ` 前缀；
- 任务结束即隐藏；waiting（approval/credential）时 header 换 `Waiting`，interruptKey 隐藏；
- 打开模态/overlay 时不抢焦点，行仍可见（Codex 语义）。

### 6.6 转写视图（Ctrl+T）

- 打开：全屏 overlay，内容 = 全量 committed rows 投影 + active cell 尾部；
- exec → `$` 形式；plan → raw 形式；notice/separator → 原样；
- 缓存 key：timeline generation + active-cell revision（对应 Codex `ActiveCellTranscriptKey`），变化时重建尾部；
- 关闭恢复主对话，不改变 sticky/滚动位置；
- 键位：j/k/g/G/PgUp/PgDn/Esc/Ctrl+C。

### 6.7 status line 段补全

- `progress`：plan 进度 `plan (n/m)`，数据源 = plan workflow 状态（19 接线）；
- `usage` / `limit`：context window 百分比与 token 数，数据源 = session usage（若 capability 可用；不可用则不发射，不伪造 0）；
- `thread`：会话标题/编号；
- 颜色一律经 23 的 `foregroundForScopes`（`status-style.ts` 已有 accent→scope 映射）；
- 宽度不足时沿用 `fitStatusLineSegments` 与 `OPTIONAL_DROP_ORDER`。

---

## 7. 流式、调度、缓存与失败模型

### 7.1 终态块与流式块

- plan-update、diff 是终态块：tool end / 投影完成时一次性进入 `PresentationBlock[]`，无流式形态；
- exec 是流式块：输出经既有 `projectShellChunk` tail-100 与 18 的 keyed renderable 更新，布局字段只影响渲染不改变 identity；
- 转写视图的活跃尾部随 timeline generation 更新，不逐 token 重建。

### 7.2 tick 与合帧

- 状态指示行的动画重绘通过共享帧调度触发（D5），每帧只重算 indicator 行，不触碰 transcript 布局；
- 合帧窗口、backlog 强制 flush 语义不变（17/18 权威）；
- 无动画时（任务结束、`animations` 关闭）零额外帧。

### 7.3 缓存

- plan-update/diff/exec 的投影结果进入 `ChatContainer.present` 的既有 `RenderCache`（1024 entries / 4MiB），key 含 timeline generation 与 width；
- 转写视图 overlay 内容独立缓存：key = timeline generation + active revision + width；全量行数超预算（建议 10_000 块）时截断并显示 `(truncated)`，绝不丢 committed 语义（只丢视图）；
- 高亮结果缓存只属于 23 的 service。

### 7.4 失败模型与降级

| 失败 | 行为 |
|---|---|
| bash 高亮失败/超限 | exec 命令降级 plaintext，布局不变（23 既有语义） |
| diff 语法高亮失败 | 回退现有前景+背景渲染（无 DIM 叠加），行号 gutter 仍渲染 |
| plan 数据源未接线（capability unavailable） | 不渲染 plan-update 块，`/plan` 维持 notice 行为 |
| 转写视图行数超预算 | 截断 + `(truncated)` 标记，不影响主对话 |
| 动画 tick 不可用（D5 被否决） | 静态指示 `(12s • ^C to interrupt)`，标记非等价 |
| overlay 打开失败 | 保持主对话，输出 error notice，不崩溃 |

---

## 8. 实施阶段（严格 RED → GREEN）

复选框约定：`[ ]` 未开始，`[~]` 部分实现，`[x]` 完成且有 fresh evidence。每阶段先写 RED（失败测试/契约断言），再最小 GREEN，然后 focused regression。

### S0 · 基线、fixture 与布局常量

**RED**
- [x] 冻结 `block-layout.ts` 全部常量（§5.7）并断言与 Codex 参照逐字一致；
- [x] 建立展示 fixture：plan update（3 态步骤 + 空步骤）、exec（短/超长输出/多行命令/失败退出码）、diff（context/add/delete/跨 hunk）、separator（worked-for ± metrics）；
- [x] 记录基准快照：当前 exec/diff/separator 的 snapshot，作为回归锚点。

**GREEN**
- [x] 常量模块 + 纯函数（`planWrapWidth`、`diffLineNumberWidth`、`formatElapsedCompact`）单测全绿。

### S1 · plan-update 块与 todo 渲染

**RED**
- [x] `rowToBlocks` 对 plan renderer 的 tool 行产出 `plan-update` 块（steps 三态映射正确）；
- [x] `PlanUpdateRenderable` 渲染断言：✔ 绿删除线、□ cyan bold、□ dim、`  └ ` 前缀、4 空格续行、`width-4` wrap；
- [x] 空 steps 无 explanation → 无块；raw 形式 `Completed: …`。

**GREEN**
- [x] `SafeToolPresentation` 新增 `renderer: "plan"` 与 `projectPlanUpdate`（经 safe bounds）；
- [x] `component-runtime.ts` body map 挂接 `PlanUpdateRenderable`（keyed，identity 规则同 exec）；
- [x] `/plan` 数据源接线（19 协作）：progress `(n/m)` 进 status line，update 进 timeline tool 行。

**门禁**：`tests/tui` 新套件全绿 + `npm run check` + 快照对比。

### S2 · exec 块布局升级

**RED**
- [x] 多行命令渲染续行前缀 `  │ ` dim，max 2 屏幕行；
- [x] 输出块前缀 `  └ `，tool 5 行 / 用户 shell 50 行，中段截断 + `… +N lines (Ctrl+T for transcript)`；
- [x] 空输出 `(no output)`；失败 `✗ (exit)` + duration；`(bg)` 标记；
- [x] 先 wrap 后截断：超长单行不突破上限。

**GREEN**
- [x] `ExecRenderable` 消费 §5.2 字段；`presentation/tools/projector.ts` 按 renderer 分档填充 `outputMaxLines`（shell=5，用户 `!` shell=50）；
- [x] 回归：`showLineNumbers=false` / 前缀关闭时的快照与 S0 基准一致。

**门禁**：真实 PTY smoke（tmux capture）+ 快照测试。

### S3 · diff 行号 gutter 与 hunk 高亮

**RED**
- [x] 行号 gutter 右对齐、宽度 = `diffLineNumberWidth(maxLineNumber)`；
- [x] hunk 级语法高亮：多行字符串跨行不串色；Delete 行叠加 DIM；
- [x] 高亮超限（512KB/10k 行）回退现有渲染，gutter 仍在。

**GREEN**
- [x] `DiffRenderable` 消费 `showLineNumbers/lineNumberWidth/syntaxHighlight`；hunk 批量送 23 service；
- [x] HighlightAdmission 集成：offscreen 不调度高亮。

**门禁**：`projectDiffDocument` 既有 400 行上限不变；快照 + service 交互测试。

### S4 · separator / notice / status line 段

**RED**
- [x] per-turn 分隔只在有 tool/plan 的 turn 出现；标签与 metrics 正确；
- [x] notice 升级为 `⚠ ` 前缀块，续行 2 空格，样式与 23 scope 一致；
- [x] status line 发射 `progress`（`plan (n/m)`）与 `usage/limit`（capability 可用时），不可用时不发射。

**GREEN**
- [x] `timeline/selectors.ts` 补 per-turn 分隔逻辑（不引入新行种类）；`footer.ts` 段接线。

**门禁**：`status-and-layout` 类测试扩展 + snapshot。

### S5 · 状态指示行 + 动画 tick

**RED**
- [x] working 时 editor 上方出现单行指示：indicator + header + `(12s • ^C to interrupt)`；waiting 时 header 变化且无 interruptKey；
- [x] elapsed 用 `formatElapsedCompact`；details max 3 行 `  └ ` 前缀；
- [x] 任务结束行消失。

**GREEN**
- [x] `OpenTuiComponentFrame.statusIndicator` 帧段 + `projectStatusIndicator`；
- [x] 帧调度动画 tick（D5）：与 17/18 核对后实现 `scheduleFrameIn` 或等价物；spinner 帧由共享调度触发。

**门禁**：tick 期间 transcript 布局零重建（帧 diff 测试）与标准 PATH 隔离 tmux 视觉 smoke 已通过；完整人工视觉验收仍随 S7 进行。

### S6 · 转写视图（Ctrl+T）

**RED**
- [x] Ctrl+T 打开只读 overlay：全量 committed rows + 活跃尾部；exec `$` 形式、plan raw 形式；
- [x] 尾部缓存随 timeline generation / active revision 失效；
- [x] Esc/Ctrl+C 关闭，主对话 sticky 与滚动不变。

**GREEN**
- [x] `TranscriptOverlayView` 投影 + pager 键位（j/k/g/G/PgUp/PgDn）；
- [x] 行数超预算截断 + `(truncated)` 标记。

**门禁**：Vitest transcript/InteractiveMode 生命周期测试、Bun OpenTUI 全屏 surface/滚动保持测试、隔离 `RUNLEDGER_DIR` 标准 PATH PTY 的 Ctrl+T → Esc → Ctrl+D smoke 已通过；完整 dark/light 逐项人工验收仍随 S7 进行。

### S7 · 完整门禁与人工验收

- [x] `npm run check`、`npm test`（含新增套件）、`npm run build` 全绿；
- [x] 标准 PATH `runledger` 真实 TTY：todo、exec（成功/失败/长输出）、diff、分隔、状态行、Ctrl+T 逐项视觉验收（dark/light 双主题）；
- [x] 80 / 143 列宽下前缀与截断不破版；
- [x] 回写两个索引（00-overview / 00-index）与本文状态。

#### S7 fresh evidence（2026-08-14）

- 当前分支为 `session-owner-runtime`，验收时 `HEAD=085ce37`（`feat(tui): add read-only transcript overlay`）。
- 自动门禁：`npm run check` 通过；`npm test` 中 Vitest 为 342 files / 2015 passed / 3 skipped，Bun OpenTUI 为 89 passed / 443 assertions；`npm run build` 通过。
- 标准 PATH：`which runledger` 为 `/home/nzq/.npm-global/bin/runledger`，实际 shim 为本仓库的 `bin/runledger.js`。
- 真实 TTY 视觉验收覆盖 dark/light 两主题的 80、143 列；light 主题通过真实 OSC 10/11 响应触发。两主题均完成 `Ctrl+T → Esc → Ctrl+D` 生命周期。
- 使用标准 `runledger`、隔离 `RUNLEDGER_DIR` 与隔离 SQLite session fixture 的 80 列真实 TTY 验证覆盖：todo 三态（含 `✔` / `□` 映射）、exec 成功/失败/长输出、`$` transcript 前缀、`  └ ` 输出前缀、失败 exit code 与 duration、Edit diff 行号 gutter、`+/-` 行、delete DIM 与背景色，以及 PageUp 回看 plan 和早期内容。
- 80 / 143 列均未发现前缀或截断破版；转写视图为只读，验收过程中未改变主对话滚动或 sticky 状态。

---

## 9. 预计文件变更清单

### 9.1 新增

```text
src/tui/opentui/block-layout.ts               布局常量 + 纯函数 (§5.7)
src/tui/opentui/plan-update-renderable.ts     PlanUpdateRenderable
src/tui/transcript-view.ts                    TranscriptOverlayView 投影 + pager 状态
tests/tui/blocks/plan-update.test.ts
tests/tui/blocks/exec-layout.test.ts
tests/tui/blocks/diff-gutter.test.ts
tests/tui/blocks/separator-notice.test.ts
tests/tui/blocks/status-indicator.test.ts
tests/tui/blocks/transcript-view.test.ts
```

### 9.2 修改

| 路径 | 目的 |
|---|---|
| `src/tui/presentation.ts` | 新增 `PlanUpdateBlock`、`StatusIndicatorView`、`TranscriptOverlayView`；exec/diff/separator 字段扩展 |
| `src/tui/presentation/tools/projector.ts` | `renderer: "plan"` 投影；exec 输出行数分档；diff 行号元数据 |
| `src/tui/presentation/tools/types.ts` | `SafeToolRenderer` 增 `plan`；`PlanStepView` 相关 safe 类型 |
| `src/tui/timeline/selectors.ts` | plan 块、per-turn 分隔、notice 块样式化 |
| `src/tui/opentui/exec-renderable.ts` | 前缀/截断/transcript 形式 |
| `src/tui/opentui/diff-renderable.ts` | gutter、hunk 高亮、DIM |
| `src/tui/opentui/component-runtime.ts` | body map 挂接 plan renderable；`statusIndicator` 帧段；Ctrl+T overlay 挂接 |
| `src/tui/opentui/frame-scheduler.ts` | 最小动画 tick 语义（D5 核对后） |
| `src/tui/components/footer.ts` | progress/usage/limit/thread 段发射 |
| `src/tui/interactive-mode.ts` | Ctrl+T 键位、状态指示投影接线、plan 数据订阅 |
| `src/tui/index.ts` | 新公开类型与 renderable 导出 |

---

## 10. 测试矩阵

| 场景 | 必须证明 | 层级 |
|---|---|---|
| plan 三态映射 | Pending/InProgress/Completed → 字形/颜色/删除线；空 steps 不产块 | 纯投影 + renderable 快照 |
| plan wrap | `width-4` 换行与续行缩进对齐；超长步骤不破版 | 快照（60/80/143 列） |
| exec 前缀 | 续行 `  │ ` max 2；输出 `  └ ` max 5/50；中段截断行数正确 | 纯函数 + 快照 |
| exec 截断先 wrap | 单条 10k 字符输出行截断按屏幕行计 | 快照 |
| exec 降级 | 高亮失败/超限时布局不变、文本可复制 | service 交互测试 |
| diff gutter | 行号右对齐、宽度随 maxLineNumber 变化、`showLineNumbers=false` 回归 | 快照 |
| diff hunk 高亮 | 多行字符串不串色；Delete DIM；超限回退 | service 交互 + 快照 |
| per-turn 分隔 | 仅 work turn 出现；metrics 渲染；run-boundary 不受影响 | reducer/selector 单测 |
| notice 块 | `⚠ ` 前缀、2 空格续行、severity 颜色 | 快照 |
| status 行 | working/waiting 切换、elapsed 格式、details max 3、超宽省略 | 纯投影 + 快照 |
| tick | 动画帧不重建 transcript 布局；任务结束零额外帧 | 帧 diff 测试 |
| transcript overlay | 全量投影、尾部缓存失效、Esc 关闭后 sticky 不变 | overlay 生命周期 + PTY |
| status line 段 | progress/usage/limit/thread 发射与 capability 门控；无数据不伪造 | 单测 + snapshot |
| 安全 | 所有新块文本来自 safe presentation；无 raw path/args 泄漏 | 契约测试（对照 19 的 governed mutations 风格） |

---

## 11. 安全、隐私与运维

- 所有新块输入长度先经既有 `SafeBoundedText` / `SafeDiffDocument` / `SafeToolPresentation` 边界，不在渲染层做第二次截断来源；
- plan/todo 文本与步骤数受 `TOOL_TEXT_BOUND_BYTES=64KiB` 与步骤数上限（建议 256）约束，防止超长 todo 拖垮布局；
- 转写视图不绕过 shell 输出 retention（`SHELL_TAIL_LINES_PER_CHANNEL=100`），截断必须带 `(truncated)` 标记；
- status line 的 `thread`/`progress`/`usage` 段只发射 capability 可用的数据，不显示 native path 或脱敏字段；
- 转写视图打开期间不暂停、不改变任何 Session/Runtime authority；
- 新帧段（statusIndicator）为 0 高度时可完全忽略（旧客户端/测试路径无感）。

---

## 12. 完成定义

| DoD | 完成条件 |
|---|---|
| 合同冻结 | §5 全部类型与常量落地，且有对照 Codex 参照的逐字断言测试 |
| todo | plan-update 三态、前缀、wrap、raw 形式与 S1 门禁全绿 |
| exec | 前缀/分档截断/省略提示/transcript 形式与 S2 门禁全绿，快照回归通过 |
| diff | 行号 gutter、hunk 高亮、DIM、回退路径与 S3 门禁全绿 |
| 分隔/通知 | per-turn 分隔与 notice 样式与 S4 门禁全绿 |
| 状态行 | spinner/elapsed/interrupt/details 与 S5 门禁全绿，帧 diff 证明零 transcript 重建 |
| 转写视图 | Ctrl+T 全量投影、尾部缓存、关闭恢复与 S6 门禁全绿 |
| 调度 | 动画 tick 经共享帧调度，D5 未违反；若被否决则明确标记非等价 |
| 隐私 | 全部新块无 raw path/args/credentials；retention 与 bounds 未放宽 |
| 证据 | `npm run check`、`npm test`、`npm run build`、标准 PATH 真实 TTY（dark/light）逐项验收记录完整 |
| 索引 | `00-overview.md` 与 `00-index.md` 导航更新，本文状态更新为 implemented |

只有全部 DoD 满足，才能把状态从 `planned` 更新为 `implemented/accepted`。单块截图、TypeScript typecheck 或旧测试结果都不足以宣称“完整复刻 Codex 会话展示区”完成。
