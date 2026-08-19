# RunLedger Streaming Write 展示稳定性复刻实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 oh-my-pi TUI 的"流式输出稳定前缀"能力族移植进 RunLedger 的 OpenTUI 架构：part 级 settled 契约、冻结前缀判定与字节稳定契约测试、settled 行缓存（回看免重解析）、流式表格列宽锁定、流式 diff 行级高亮。目标与 oh-my-pi 相同：**流式写入时，用户已读过的行永不 reflow/重解析，滚动回看成本不随 token 增长**。

**Architecture:** 不重写 renderer、不改 OpenTUI 内部、不切 screen mode。全部能力落在 RunLedger 自有 presentation 层：`PresentationBlock` 投影之上建立 `settled(part)` 状态机与冻结前缀 pure 模块，缓存与锁定以 presentation block 为粒度。OpenTUI `MarkdownRenderable.streaming` 与内部 `ParseState` 增量解析继续负责渲染，本文只负责"哪些行可声明稳定、稳定后如何复用"。

**Tech Stack:** TypeScript（strict + erasableSyntaxOnly + NodeNext）、OpenTUI `@opentui/core`（0.4.5 基线）、Vitest（pure）+ Bun OpenTUI test renderer（`@opentui/core/testing`）、既有 `RenderCache`/`FrameScheduler`/highlight service。

**参考实现:** `oh-my-pi/packages/tui/src/components/markdown.ts`（`#lexTokens`/`#freezeStablePrefix`/`getLastRenderSettledRows`/`setNativeScrollbackCommittedRows`/`#renderStreamingContentLines`）、`oh-my-pi/packages/tui/src/tui.ts`（append-only commit ledger）、`oh-my-pi/packages/coding-agent/src/modes/components/transcript-container.ts`（`FinalizableBlock` seam）、`oh-my-pi/packages/tui/test/markdown-incremental-lex.test.ts`（字节等价契约门）。

## 现状核实（2026-08-14，evidence-grounded）

RunLedger 流式展示链路现状（全部来自当前源码，非推断）：

| 能力 | RunLedger 现状 | 证据 |
|---|---|---|
| delta 归并与帧调度 | 有：`FrameScheduler` 16–33ms 窗口 + backlog 上限，terminal/input force flush | `src/tui/opentui/frame-scheduler.ts`；plan 18 S2 |
| 持久 keyed renderable | 有：entry/part 级 keyed maps，streaming 中历史 identity 不变 | `src/tui/opentui/component-runtime.ts:460-571`；plan 18 S1 |
| 增量 markdown 渲染 | 部分：`MarkdownRenderable` 一律 `streaming=true` 创建，final 帧翻转 + `finalizeMarkdownChildren`；OpenTUI 内部 `ParseState`/`_stableBlockCount` 增量 | `component-runtime.ts:486-568`；`opentui/packages/core/src/renderables/Markdown.ts`（`streaming`、`_stableBlockCount`） |
| sticky scroll + culling | 有：`stickyScroll: true`、`viewportCulling: true`、new-content 提示 | `component-runtime.ts:230-240`；plan 18 S4 |
| 每 tick 全量签名比较 | **存在**：`bodySignature` 每 tick 对全 timeline 每个 block 算 `blockText(block)` 后 join 比较；streaming block 内容全量重设 `renderable.content = block.content` | `component-runtime.ts:460-464, 563-564` |
| settled 前缀契约 | **无**：RunLedger 层没有"哪些行已 byte-stable"的声明；`RenderCache` 键含 `contentGeneration`，streaming 期间每 tick bump → 活跃 entry 缓存必然 miss | `src/tui/opentui/render-cache.ts`；`src/tui/components/chat-container.ts:28-31` |
| 冻结前缀字节等价契约测试 | **无**：OpenTUI 内部增量解析无 RunLedger 独立契约证据（plan 18 S3 明示"OpenTUI Markdown 内部解析成本与稳定 block 计数尚未形成独立证据"） | plan 18 §6 S3 |
| 流式表格列宽锁定 | **无**：streaming 期间 part content 全量重设，OpenTUI 表格列宽每次 update 重算，已显示行可 reflow | `component-runtime.ts:563-564`；OpenTUI Markdown streaming 语义（"Tables render all rows produced by the markdown parser"） |
| 流式 diff 行级高亮 | **无**：`DiffRenderable` 是 block 级静态投影（`SafeDiffDocument` → `StyledText`），无逐行 admission | `src/tui/opentui/diff-renderable.ts` |
| settled 行缓存回看复用 | 部分：`transcript-view.ts:43` 已有 `committedProjectionCache`（Ctrl+T 转写视图），但主对话 ScrollBox culling rebuild 无 RunLedger 层缓存 | `src/tui/transcript-view.ts` |
| 原生 scrollback 中流提交 | **架构性缺失**：`screenMode: "alternate-screen"`，无 native scrollback；OpenTUI `ScrollbackSurface`/`writeToScrollback` 仅限 `split-footer` + captured-stdout，不适用于 transcript | `component-runtime.ts:1131-1135`；`opentui/packages/core/src/renderer.ts`（`createScrollbackSurface` 前置条件） |

**结论：** 流式展示的"出现"能力已有（coalescer + keyed renderable + OpenTUI streaming + sticky/culling），oh-my-pi 的"稳定前缀提交"能力族缺失。其中原生 scrollback 中流提交与 alternate-screen 互斥，属架构决策（见非目标），其余五项为本文移植对象。

## 权威边界

- [`tui/17-opentui-refactor-plan.md`](../tui/17-opentui-refactor-plan.md) 继续持有 renderer/PTY/native frame authority。本文不改 renderer、不改 screen mode、不引入 React/Solid。
- [`tui/18-opentui-streaming-performance-ux-plan.md`](../tui/18-opentui-streaming-performance-ux-plan.md) 继续持有流式性能与体验 authority。本文是其"稳定性/提交"维度补充：为其 S3/S4 的开放项（`[~]`）提供证据，不回写其 checkbox。
- [`tui/22-opencode-conversation-scrollbar-adaptation-plan.md`](../tui/22-opencode-conversation-scrollbar-adaptation-plan.md) 持有滚动条 authority。本文不改 ScrollBox 行为、不碰滚动位置。
- [`tui/23-codex-syntax-highlighting-replication-plan.md`](../tui/23-codex-syntax-highlighting-replication-plan.md) 持有高亮 engine authority。本文只消费 highlight service 的 generation fence 契约，不改 engine。
- [`tui/24-codex-session-display-replication-plan.md`](../tui/24-codex-session-display-replication-plan.md) 持有会话展示语义 authority。本文不改块级展示语义、不改 todo/exec/diff 布局。
- 与 plan 18 相同的红线：不把 OpenTUI 内部 `_stableBlockCount` 暴露为 RunLedger 类型、领域事件或长期契约；不修改 OpenTUI（上游 patch 仅在影响正确性且上游已确认时另立专项）。
- UI 仍只消费 controller/runtime 事件；settled 状态是 presentation 派生，不写回领域状态。

## 适配总览（pi → RunLedger）

| pi 机制 | RunLedger 适配 | 决策理由 |
|---|---|---|
| `NativeScrollbackLiveRegion` / `FinalizableBlock.getTranscriptBlockSettledRows()`（byte-stable 行声明） | presentation 层 `settled(part) = part.finalized`；part 内冻结前缀由 pure 模块判定，输出 `SettledSpan[]`（行区间） | 无 native scrollback 提交目标；settled 行的用途改为缓存复用、表格锁定、高亮 admission 门控 |
| `#freezeStablePrefix`（blank-line bounded + 列表续行闭合判定，append-only 单调） | 移植同一判定语义为 pure 模块 `freezeStreamPrefix(text)`；**不引入 marked 直接依赖**，用保守文本规则（fence 平衡 + 空行边界 + 列表 marker 续行） | OpenTUI 内部用 marked 但未导出 token 流；冻结前缀的消费者是"行字节稳定"而非"少 lex"，保守判定即可，误判只损失缓存命中率 |
| `markdown-incremental-lex.test.ts`（lex(prefix)++lex(tail) ≡ lex(full) 逐 step） | 等价契约测试改为对 OpenTUI 输出：逐步 append 下，冻结前缀渲染行**逐字节不变**（fence/列表/表格/引用/数学等 fixture） | RunLedger 渲染在 OpenTUI 内部，正确性契约必须落在最终输出行上，而不是中间 token 流 |
| `setNativeScrollbackCommittedRows`（表格列宽锁定） | presentation 层"闭合表格 block 拆分"：streaming part 内出现已闭合表格时，将其拆为 settled 子 renderable，前缀 content 不再变化 → 列宽自然冻结 | 不改 OpenTUI 内部；拆分后前缀实例 content 恒定，列宽不重算 |
| `#renderStreamingContentLines`（冻结前缀行缓存 + 仅重渲 tail） | settled part 投影行缓存（`RenderCache` 键改为 part 级）+ culling rebuild/转写视图复用 | OpenTUI culling 只过滤可见子集、renderable 常驻，重解析成本在 projector 与 content 重设路径 |
| `#renderingFrozenPrefix`（冻结 code block 照常高亮、tail 不高亮） | highlight admission 门控：settled 区域一次性高亮并缓存，活跃 tail 延迟/降级；消费既有 highlight service generation fence | plan 23 engine 不动；admission 策略是 presentation 决策 |
| `#lastRenderSettledRows`（hard-monotone lineage，rewind 重置） | `SettledSpan` 随 `contentGeneration` 单调，generation 回退（retry/session switch）整体作废 | 领域 replay/retry 已有 generation fence 概念（TimelineStore），presentation 复用同一 fence |
| 引擎 append-only ledger / 中流原生 scrollback 提交 | **不移植**（ADR，见非目标） | alternate-screen 与 native scrollback 互斥；改 screen mode = 重写 renderer 提交模型，违反 plan 17 authority |

## 显式非目标（当前版本）

- **不切换 normal-screen / 原生 scrollback**。ADR 记录：alternate-screen 下 transcript 历史在应用内（ScrollBox + culling rebuild），退出后不留在终端 scrollback；OpenTUI `ScrollbackSurface`（split-footer + capture-stdout）不适用于 transcript。若未来需要"退出后历史可回看"，另行 ADR + 专项。
- 不暴露、不依赖 OpenTUI `_stableBlockCount`；不 patch OpenTUI。
- 不重写 markdown 渲染、不引入新运行时依赖（marked 等）。
- 不做 part 内 token/字符级冻结（当前版本冻结粒度 = 闭合 block；单个超长未闭合段落整体保持可变，与 oh-my-pi 的 blank-line 冻结一致）。
- 不改领域状态、不改 session persistence、不接管 delta transport（上游 50ms/4KiB bounded delta 契约不变，plan 18 已有记录）。
- 不做"当时的快照"语义：回看 rebuild 用最终内容（RunLedger 语义优于 oh-my-pi 的 frozen snapshot，不存在 stale 行问题；表格锁定解决 reflow 例外）。

## 文件结构

```text
src/tui/opentui/
├── settled-prefix.ts            # P2: freezeStreamPrefix / SettledSpan / 保守闭合块判定（pure）
├── settled-part-cache.ts        # P3: settled part 投影行缓存（bounded LRU，partId/width/contentGeneration/themeGeneration 键）
├── streaming-table-split.ts     # P4: 闭合表格 block 检测与拆分投影（pure 检测 + runtime 拆分）
└── streaming-diff-admission.ts  # P5: diff hunk 行级投影 + 高亮 admission（消费 highlight service）
src/tui/opentui/component-runtime.ts
                                 # P1/P3/P4/P5 接入点（signature 增量化、part 级缓存键、表格拆分、admission）
src/tui/components/chat-container.ts
                                 # P1: presentationCache 键改 part 级
src/tui/timeline/                # P1: settled 派生与 generation fence（如 selector 层已有即复用）
tests/tui/
├── settled-prefix.test.ts       # P2: 冻结判定纯测试（单调、闭合、列表续行、fence、rewind）
├── streaming-prefix-stability.bun.test.ts  # P2: OpenTUI 输出字节稳定契约门（逐 step append、嵌套列表/长单行/cold-final）
├── settled-part-cache.test.ts   # P3: 缓存命中/失效/generation fence/上限
├── streaming-table-lock.test.ts # P4: 闭合表格拆分后前缀渲染不变 + 回看列宽不变
└── streaming-diff-admission.test.ts    # P5: 行级 admission/降级/abort
development-doc/plan/05-streaming-prefix-stability-plan.md   # 本文
development-doc/00-index.md      # 本计划完成登记（规划阶段已加行）
```

## 严格执行阶段

各阶段遵循 RED → 最小 GREEN → focused regression → 同域回归。复选框约定：`[x]` 当前切片有直接实现与测试，`[~]` 局部实现仍缺生产接线/压力/验收证据，`[ ]` 未实现。没有证据不标记完成。

### P0 · 现状证据基线

- [ ] RED：写复现 fixture 证明三个问题真实存在：① 10,000 entry timeline 上单 token delta 的 `bodySignature` 全量拼接比较成本可测；② streaming 表格 append 更宽 cell 后已显示行 reflow（Bun OpenTUI frame 断言）；③ 流式中向上滚动回看，culled 区 rebuild 触发 markdown 重解析（以 projector 调用计数/耗时为准）。
- [ ] 测量每 tick 成本分解：signature 比较、`renderable.content` 全量重设、OpenTUI 内部增量、projection、native frame；记录 p50/p95。
- [ ] 测量 streaming 期间 `RenderCache` 命中率（预期：活跃 entry 每 tick miss，历史 entry 命中）。
- [ ] 固定环境：Node/平台/架构、OpenTUI 版本、Bun 版本、终端尺寸、theme；结果落 `05-streaming-baseline-<date>.json`。

验收：三个问题的复现证据 + 每 tick 成本分解，明确优化优先级排序依据。

### P1 · part 级 settled 契约与增量签名

- [x] RED：streaming 期间，历史 finalized part 的 projection/renderable 不因活跃 part 的 delta 变化（identity + 内容不变）；活跃 part 的 dirty 集合只含自身。证据：`tests/tui/streaming-part-stability.test.ts` 与 `tests/tui/opentui-part-stability.bun.test.ts`。
- [x] 引入 `settled(part)`：`part.finalized === true` 且 `contentGeneration` 未变 ⇒ 整 part byte-stable。generation 回退（retry/session switch）整体作废（复用 TimelineStore generation fence 语义）。实现：`src/tui/timeline/part-stability.ts`。
- [x] `component-runtime.ts:460-464` 的 `bodySignature` 增量化：由 block 级 `contentGeneration` 与 finalized identity 驱动稳定 part，活跃 part 使用长度+短哈希并保留正文作为 contentKey fallback。实现：`src/tui/opentui/body-signature.ts`。
- [x] `chat-container.ts` presentationCache 键改为 `(entryId, partId, width, contentGeneration, themeGeneration)`；streaming 期间历史 part 继续命中。
- [x] `component-runtime.ts:563-564` 的 content 全量重设保留（OpenTUI 内部增量解析），但仅对 `contentKey` 实际变化的 block 执行；part 级 dirty 集合不再因活跃 delta 扩散到历史 part。

验收：当前切片已通过 focused Vitest 80 tests、native OpenTUI 103 tests/644 assertions、`tsc --noEmit`、`npm run build`、streaming benchmark，以及 linked `runledger` 在 60/80/143 列隔离 `RUNLEDGER_DIR` 下的真实 TTY smoke。仍待补齐 10,000 entry burst 的 application-level projection/cache-hit 对比与仓库级 `npm run check`；后者当前被任务外 `check:current-format` internal marker 扫描阻塞，因此 P1 保持 `partial`。

### P2 · 冻结前缀判定与字节稳定契约门

- [x] RED：写契约测试骨架，断言"逐步 append 下冻结前缀渲染行逐字节不变"，并用标题完成态 reflow fixture 驱动失败。
- [x] `freezeStreamPrefix(text)` pure 模块：保守判定最后一个"闭合 block 边界"——fence/数学块平衡闭合 + 空行边界 + 列表 marker 续行判定（移植 oh-my-pi `stableBlockBoundary`/`listMayContinueAt` 语义，文本规则版）。输出 `SettledSpan { prefixText, }`；append-only 下前缀单调不收缩，rewind 返回 undefined（重挣）。
- [x] 契约门 `streaming-prefix-stability.bun.test.ts`：对 OpenTUI `MarkdownRenderable`（`streaming=true`、`internalBlockMode: "top-level"`）逐步 append fixture（标题/段落/列表/开放 fence/表格/引用/数学），断言 settled renderable 行在每步 append 后逐字节不变；Bun OpenTUI test renderer 真实 frame 已补齐嵌套列表续行、长单行不因视觉换行冻结、cold-final 与 warm-final 收束对照。
- [x] 冻结前缀不进入缓存；当前切片把声明物化为同级 settled final 前缀 + streaming tail renderable，误判只损失缓存机会，不改变领域状态；P3 再接 settled 行缓存。

验收：契约门全绿；fixture 覆盖至少含"表格 append 更宽 cell"与"开放 fence 后追加列表项"两个 reflow 陷阱；前缀判定纯测试覆盖单调性与 rewind。

### P3 · settled 行缓存与回看复用

- [x] RED：`settled-part-cache.test.ts` 先验证 key、迟到 generation、theme 失效、LRU/字节上限和 destroy；`transcript-view.test.ts` 再验证 active tail 变化时 committed rows 不重新投影。
- [x] `settled-part-cache.ts`：settled part 的投影行缓存（bounded LRU：`maxEntries`/`maxBytes`，键 partId/width/contentGeneration/themeGeneration；themeGeneration 变化失效）。
- [x] 接入 `transcript-view.ts`：committed/settled segment 复用缓存行，active tail 保持原路径；主 ScrollBox 的 OpenTUI culling 保持持久 renderable，不另造第二个 renderer 生命周期。
- [x] 高亮/缓存 generation fence：缓存拒绝旧 content/theme generation；Markdown settled renderable 与 P5 diff admission 分离持有派生样式，abort/session switch 不写回旧 lineage。
- [x] 上限与回收：超限 LRU 淘汰，`clear()` 用于 revision/session 变化，`destroy()` 释放内容；`getSettledPartCacheSnapshot()` 提供可观测快照。

验收：回看期间 settled part 不重解析（计数/耗时断言）；abort/session switch 后无旧 generation 数据泄漏；缓存快照统计可观测。

### P4 · 流式表格列宽锁定

- [x] RED：`streaming-table-lock.test.ts` 先锁定 delimiter、闭合空行、未闭合表格三种行为；Bun frame fixture 再驱动前缀行不变断言。
- [x] `streaming-table-split.ts`：pure 检测 streaming part 内"已闭合表格 block"（表格行序列后随空行且下一行非表格分隔符行；保守判定，未闭合表格不拆）。
- [x] runtime 使用闭合表格拆分结果形成独立 settled Markdown renderable，后续 delta 只更新尾部 renderable；拆分点在 append-only lineage 内不回收旧 prefix identity。
- [x] Bun frame 逐 tick 断言前缀 renderable identity/行文本不变；final 帧恢复整段正文，行文本与未拆分内容一致。

验收：P0 复现 fixture 转绿；回看（culling rebuild）时表格列宽稳定；拆分不影响 selection/copy（行文本不变，仅布局冻结）；`npm run check` 清零。

### P5 · 流式 diff 行级高亮

- [x] RED：`opentui-diff-gutter.bun.test.ts` 证明 streaming 中最后一行不应进入 native highlight source，正文仍可见。
- [x] `streaming-diff-admission.ts`：按 hunk/行拆分 admission；hunk header 已到且非开放尾行的完整行进入 settled admission。
- [x] `DiffRenderable` 消费既有 `SyntaxHighlightService`：沿用 stable key 的 latest-wins/generation fence；超预算返回纯文本 fallback，不丢正文。
- [x] final 帧关闭 streaming 后重新 admission 全部 `SafeDiffDocument` 行，Bun 断言 source 与正文一致。

验收：流式中已完成 diff 行高亮与最终帧一致；abort 后无旧 generation 高亮回写；降级路径不丢正文。

### P6 · 压力、门禁与回写

- [x] 压力 fixture：`scripts/streaming-prefix-stability-fixtures.ts` 覆盖 10,000 × 1-char delta、1 MiB 单消息、开放 fence、生长表格、流式 diff、有界缓存、abort/error lineage；既有 Bun frame 覆盖 streaming 中滚动与 resize storm。
- [~] 背压验证：settled cache 的 entry/byte 上限与 cache snapshot 已通过；`tests/tui/streaming-projection-cache.test.ts` 与共享压力 fixture 已补齐 10,000 timeline block 的 cold projection、同 generation/width reuse、active-tail update 对比：9,999 个 settled block 保持 projection identity，整段缓存命中 1 次，bounded cache 保持 1,024 entries。
- [~] 门禁：`npm run build`、`tsc --noEmit`、focused Vitest、Bun OpenTUI、60/80/143 linked `runledger` PTY smoke 通过；`npm run check` 与全量 `npm test` 仍被既有 `check:current-format` internal-marker 扫描阻塞，详见 evidence JSON。
- [x] 回写：本计划状态表、独立压力证据 [`05-streaming-prefix-stability-evidence-2026-08-15.json`](05-streaming-prefix-stability-evidence-2026-08-15.json)、`tui/18` S3/S4 证据入口与 `00-index.md` 已更新。

验收：P0 基线 ↔ P6 对比有据（projection 成本、cache 命中率、reflow 消除）；全部门禁绿。

## 测试矩阵

| 场景 | 必须证明 | 主要层级 |
|---|---|---|
| 冻结前缀单调性 | append 下前缀不收缩；rewind 重置；列表续行/fence 边界正确 | pure（Vitest） |
| 字节稳定契约 | 逐步 append 下冻结前缀渲染行逐字节不变（含表格/开放 fence fixture） | Bun OpenTUI frame |
| settled 缓存 | 回看不重解析；generation fence；bounded LRU；theme 失效 | pure + Bun |
| 表格列宽锁定 | 闭合表格拆分后前缀渲染不变；最终帧与未拆分对照行一致 | Bun OpenTUI frame |
| diff 行级高亮 | 中间态行级 admission；final 一致性；abort 无回写；降级无损 | pure + Bun |
| 长会话 | 10,000 entry 单 delta 不触碰历史 part；signature 增量化 | benchmark + pure |
| abort/session switch | 旧 generation 缓存/高亮作废 | pure + Bun |

## 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 现状证据基线 | `planned` | — |
| P1 part 级 settled + 增量签名 | `partial` | `src/tui/timeline/part-stability.ts`、`src/tui/opentui/body-signature.ts`、`tests/tui/streaming-part-stability.test.ts`、`tests/tui/opentui-part-stability.bun.test.ts`、`tests/tui/streaming-projection-cache.test.ts`；focused Vitest 40 tests、native OpenTUI 104 tests/654 assertions、build、benchmark、60/80/143 linked TTY smoke 通过；10,000 entry application projection/cache-hit 证据已补齐，仓库级 check 仍受既有 marker 扫描阻塞 |
| P2 冻结前缀 + 契约门 | `implemented` | `src/tui/opentui/settled-prefix.ts`；`tests/tui/settled-prefix.test.ts`；`tests/tui/streaming-prefix-stability.bun.test.ts`（8 tests，含嵌套列表/长单行/cold-final）；P2 focused Vitest/Bun、native OpenTUI 108 tests/674 assertions + `tsc --noEmit` 通过 |
| P3 settled 行缓存 | `implemented` | `src/tui/opentui/settled-part-cache.ts`；`tests/tui/settled-part-cache.test.ts`；`tests/tui/blocks/transcript-view.test.ts`；focused 18 tests；cache snapshot/淘汰/generation/theme/revision-rewind evidence |
| P4 流式表格列宽锁定 | `implemented` | `src/tui/opentui/streaming-table-split.ts`；`tests/tui/streaming-table-lock.test.ts`；`tests/tui/streaming-prefix-stability.bun.test.ts`；Bun closed-table frame evidence |
| P5 流式 diff 行级高亮 | `implemented` | `src/tui/opentui/streaming-diff-admission.ts`；`tests/tui/streaming-diff-admission.test.ts`；`tests/tui/opentui-diff-gutter.bun.test.ts`；final/预算/generation fence evidence |
| P6 压力、门禁与回写 | `partial / blocked` | [`05-streaming-prefix-stability-evidence-2026-08-15.json`](05-streaming-prefix-stability-evidence-2026-08-15.json)；pressure fixture、新增 10,000 timeline application projection 对比、current native OpenTUI 108 tests/674 assertions、build、60/80/143 PTY 通过；check/full npm test 仍受任务外 current-format marker 阻塞，P1/P6 的 application projection/cache-hit 缺口已补齐 |

## 约束（本计划遵守）

- `tsconfig.base.json`：`strict`/`verbatimModuleSyntax`/`erasableSyntaxOnly`/`NodeNext`/`allowImportingTsExtensions`；相对 import 带 `.ts` 后缀；禁 `any`（必要时 `// why any`）；异步工具不抛错，错误以 `stopReason: "error"` 或 `{ ok: false }` 编码；中文注释；顶层 import only；`npm run check` 清零；`git add <path>` only。
