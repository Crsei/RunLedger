# 18 · OpenTUI 流式渲染、长会话性能与交互体验补充计划

> 状态：执行中（2026-08-05；S0–S4 已有局部 agent-verified 实现，S5–S8 仍开放）
>
> 依赖 renderer 迁移：[`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md)
>
> 被动数据合同配套：[`17-passive-data-contract-placeholder-plan.md`](17-passive-data-contract-placeholder-plan.md)。该配套计划只提供 framework-neutral 类型占位，不改变本文的性能/体验执行范围。
>
> OpenTUI 基线：`@opentui/core@0.4.5`
>
> 参考实现：Codex、OpenCode、grok-build 的当前本地源码快照；这些项目只提供设计证据，不是 RunLedger 的依赖或完成状态。

## 1. 权威边界与执行结论

[`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) 仍是 pi-tui → OpenTUI imperative core 迁移、renderer 替换、Bun 启动器和迁移状态的唯一权威清单。本文不复制、不改写 renderer Plan 17 的 P0–P8 checkbox，也不把被动数据合同配套计划扩展成 renderer 行为；本文只负责迁移后的流式性能、长会话渲染和交互体验。

执行边界：

- renderer Plan 17 P8 已在 2026-08-02 获得 agent-verified 证据；本轮已落地 S0 的 coalescer fixture/分层观测 seam、S1 的 keyed renderable、S2 的 delta 合并与帧调度，以及 S3/S4 的局部增量 Markdown、viewport/sticky 行为；这些不代表 S0–S4 整阶段闭合；
- S5 仍是开放计划项；S6–S8 已增加 resize/多宽度/降级 fixture 与 native 证据，但真实 PTY、Yoga/layout 独立成本、内存硬上限和 before/after 全链路预算证据仍缺；
- 后续必须按 S0 → S8 顺序执行，不得因前置门禁已解除而跳过 profiling、fixture 或性能预算校准；
- 若 `17-opentui-refactor-plan.md` 的 renderer 基线发生回归，先恢复其门禁证据，再继续本计划，禁止本计划或被动数据合同配套计划争夺 renderer 结构 authority；
- 继续使用 OpenTUI imperative core，不切换 React/Solid，不隐式更改 `alternate-screen`；
- UI 仍只消费 controller/runtime 事件，不接管 Session、Auth、Tool、ledger 或 lifecycle authority。
- 2026-08-12 Session Runtime 上游已把 durable `message_update` 改为 50 ms/4 KiB
  的 bounded delta + aggregate digest/size，移除 cumulative `partial`，并在
  message/tool/turn/run/shutdown 边界强制 flush；TUI 继续消费 lossless delta，
  最终 `message_end` 覆盖临时组装值。该 focused 证据只降低 SQLite 写放大，
  不替代本文 renderer queue、native frame、PTY、hard-memory 或 human UX 门禁。

本文的核心不是“把刷新间隔改成一个常数”，而是建立四层协同：

```text
AgentEvent transport
        │  lossless delta / supersedable status
        v
bounded coalescer + presentation reducer
        │  changed entry ids
        v
persistent keyed timeline renderables
        │  viewport + dirty regions
        v
OpenTUI frame scheduler + terminal cell diff
```

目标是让成本主要随“本帧新增内容”和“可见区域”增长，而不是随“整个会话长度 × token 数量”增长。

## 2. 当前实现基线：计划项不得冒充现有能力

当前 OpenTUI 迁移代码已经建立 native renderer seam，但仍是整帧字符串投影：

- `src/tui/primitives.ts` 的 `requestRender()` 同步调用 `renderFrame()`；每次事件都会遍历组件、重建全部 `body` / `footer` 数组并发送完整 frame；
- `src/tui/opentui/component-runtime.ts` 每次 update 都把 transcript join 成一个字符串，写入单个 `TextRenderable`；overlay 也会在每帧销毁重建；
- `src/tui/opentui/runtime.ts` 的 `mount()` 会销毁并重建整个 screen tree，因此 editor、scroll、selection、overlay identity 无法天然保持；
- transcript 只有一个巨型 child，`ScrollBoxRenderable.viewportCulling` 无法在消息或内容块粒度生效；
- `AssistantMessageComponent` 仍经过兼容 `Markdown` primitive 的 split/wrap 路径，尚未形成一个活动 part 对应一个持久 `MarkdownRenderable`；
- `InteractiveMode.handleEvent()` 已能收到 `text_delta`、`thinking_delta`、`toolcall_delta`，但当前仍从累计 `partial` 提取完整内容，并在事件末尾调用 `requestRender()`；
- OpenTUI 自身会做帧调度与终端 diff，但它不能消除 RunLedger 在进入 renderer 之前已经发生的全历史拼接、Markdown 解析、Yoga 布局或 renderable 重建。

因此，renderer Plan 17 中的 `streaming=true`、sticky scroll 和 viewport culling 是迁移目标，不代表本文的增量树、背压、窗口化和性能预算已经完成。

## 3. 对照实现提炼：补充原有观点

本轮只读对照使用以下固定源码快照，后续若重新测量必须记录新 revision，避免把漂移中的实现当作稳定 API：

| 项目 | 本地 revision | 主要证据入口 |
|---|---|---|
| Codex | `0b175e6439a8608ba7726ee153fd8590619e8f34` | `codex-rs/tui/src/streaming/`、`markdown_stream.rs`、`frame_requester.rs`、`custom_terminal.rs` |
| OpenCode | `1882c33827cf0ce5c948b69ab5a87ed8f6790cf8` | `packages/app/src/context/server-sdk.tsx`、`packages/session-ui/src/components/markdown*.tsx`、`message-timeline.tsx` |
| grok-build | `c68e39f60462f28d9be5e683d9cbe2c57b1a5027` | `xai-grok-pager/src/app/event_loop.rs`、`scrollback/state/layout.rs`、`xai-grok-markdown/src/streaming.rs` |

### 3.1 可复用结论

| 维度 | Codex | OpenCode | grok-build | RunLedger 应采纳的原则 |
|---|---|---|---|---|
| 流式状态 | token 追加到活动 cell，稳定前缀与可变尾部分离 | part delta 局部 append；Web 端先合并相邻 delta | 同一 `EntryId` 原位追加 agent/thinking block | 以稳定 entry/part id 定位，只 mutation 活动尾部 |
| 调度 | 积压感知批量 drain，终端层 cell diff | 16 ms event batch；积压后按字符数与标点自适应 pacing | 每轮最多 drain 32 条并优先让输入；draw cadence 通常约 16 ms | 分开“事件归并、状态提交、paint”，同时考虑帧、字符数、队列年龄和输入公平性 |
| Markdown | 换行提交稳定区，活动尾部可变 | 稳定 block/live tail/code block diff；普通 Markdown 仍可能累计全文 lexer | checkpoint 冻结稳定前缀，仅重算尾部 | 稳定历史不重解析；开放块只更新尾部；记录残余全量解析成本 |
| 代码高亮 | 活动区域受控，不让历史反复参与 | Shiki Worker 增量 tokenize；一个 active + 一个 latest queued | 开放 fence 保留 parser/highlighter 状态，并有局部缓存预算 | 高亮异步化/可取消/有界；压力下可降级纯文本，旧 generation 不得回写 |
| 长会话 | 主要依赖 scrollback/终端模型，没有完整虚拟列表 | Web 使用虚拟列表 + 动态测量 + 分页；TUI 主要硬裁剪 100 条 | `virtual_y` + 二分定位可见 slice，定期回收屏外重缓存 | 区分渲染窗口化、历史分页和缓存回收，三者不能互相冒充 |
| 背压 | 多条通路仍缺统一硬内存上限 | 多处 cache/buffer 有上限，但 Web event queue 无硬上限 | drain 有公平性，部分 channel 仍无界 | RunLedger 必须同时约束 event 数、字节数、异步任务和昂贵缓存 |

### 3.2 对原观点的修正与补充

1. “不要每个 token 全量渲染”要同时覆盖 reducer、Markdown lexer、高亮、wrap、布局和 renderable tree；仅依赖终端 cell diff 不够。
2. “100–300 ms 节流”只能作为低频/后台策略，不应固定为唯一答案。前台可见流建议从一帧窗口（约 16–33 ms）起步，并根据 backlog、字符数、最老事件年龄和终端速度自适应；固定 300 ms 容易造成可感知卡顿。
3. 语义正文 delta 必须 lossless；可以合并但不能丢。进度、spinner、重复 tool status 等可替代状态才允许 latest-wins。
4. 重型组件不必一律删除。优先持久化实例、缩小更新边界、异步/增量计算并设置预算；超过预算时才降级到轻量文本。
5. 虚拟滚动只限制本帧渲染节点；分页/裁剪限制历史数据，LRU/回收限制派生缓存，三者解决的问题不同。
6. 交互与渲染分离应具体化为稳定 ID 和单向数据流，使 copy/fold/approve/retry 不依赖临时 renderable 实例或行号。
7. 必须保证输入公平性：token burst、Markdown 工作和 deferred draw 不能饿死键盘、滚轮、Ctrl+C 或审批操作。

## 4. 目标架构与核心契约

### 4.1 持久 timeline

目标树使用稳定 identity，不再每帧销毁重建：

```text
RunLedgerScreen (persistent)
├── header/resources (persistent, replace content only)
├── timeline ScrollBox (persistent)
│   ├── entry:<id> user
│   ├── entry:<id> assistant
│   │   ├── part:<id> markdown (streaming tail)
│   │   └── part:<id> tool summary
│   └── entry:<id> status/error
├── compact activity/status
├── editor (persistent focus/draft/selection)
├── footer/hints
└── overlay:<id> (persistent until id/type changes)
```

至少建立以下内部契约；实际类型名可在 S1 RED 后微调：

```ts
type TimelineEntryId = string;
type TimelinePartId = string;

interface TimelinePatch {
  entryId: TimelineEntryId;
  partId?: TimelinePartId;
  kind: "append-text" | "replace-status" | "complete" | "insert" | "remove";
  text?: string;
  generation: number;
}

interface ProjectionResult {
  changedEntryIds: readonly TimelineEntryId[];
  overlayChanged: boolean;
  chromeChanged: boolean;
  forceFlush: boolean;
}
```

要求：

- domain/presentation state 不持有 OpenTUI renderable；adapter registry 负责 `entryId -> renderable`；
- terminal event（complete/error/abort）必须先清空属于本 generation 的 delta，再切换完成态；
- session 切换、replay 或 retry 增加 generation fence；过期的高亮、wrap 或摘要结果不得写回新会话；
- editor draft、selection、focus、overlay focus、scroll anchor 不从 transcript snapshot 重建。

### 4.2 增量与可替代事件分类

| 事件类别 | 合并策略 | 能否丢弃 | terminal flush |
|---|---|---:|---:|
| assistant text delta | 同 entry/part 顺序拼接 | 否 | 是 |
| thinking delta | 同 part 顺序拼接；UI 可投影为紧凑状态 | 否；若产品策略不展示全文，也需由明确策略处理 | 是 |
| tool argument/result delta | 同 tool call 顺序拼接，UI 默认只显示安全摘要/字节数 | 否 | 是 |
| progress/spinner/status | 同 key latest-wins | 是，仅丢 superseded 状态 | 是 |
| theme/resize | 同一窗口 latest-wins | 是 | 否 |
| approval/input/interrupt | 立即进入高优先级控制路径 | 否 | 不等待普通窗口 |

## 5. 初始性能预算与测量口径

以下是 S0 的起始门槛，不是当前已满足的事实。S0 必须在目标 CI/开发机上校准并记录环境、样本和 p50/p95/p99；若调整阈值，要在本文留下原因和对比证据。

| 指标 | 初始预算 | 测量口径 |
|---|---:|---|
| renderer cadence | `targetFps=30`，`maxFps=60` | 前台流式期间；不是每事件强制 paint |
| 可见文本延迟 | p95 < 100 ms | delta 入 coalescer 到字符出现在 frame |
| 输入延迟 | p95 < 50 ms | token burst 中按键/滚轮到状态生效 |
| application projection long task | 无单次 > 50 ms | 不含测试启动和 renderer 首次 native load |
| terminal completion flush | < 100 ms | end/error/abort 到最终完整 frame |
| resize 收敛 | < 150 ms | resize storm 最后一次事件到稳定布局 |
| steady stream queue age | p95 < 100 ms | coalescer 中最老 lossless delta |
| async highlight in-flight | 每活动块至多 1 active + 1 latest queued | 旧 queued 可替换，正文不可丢 |
| 历史规模基线 | 10,000 entries | 可滚动、可选择，不要求所有派生缓存驻留 |

同时记录：queued events/bytes、coalesced ratio、dirty entry count、projection time、native frame time、dropped supersedable count、cache bytes/hits/evictions、scroll-follow state 和 generation discard count。

## 6. 严格执行阶段

各阶段遵循 RED → 最小 GREEN → focused regression → 同域回归。复选框约定：`[x]` 表示当前切片有直接实现与测试，`[~]` 表示局部实现但仍缺生产接线、压力或验收证据，`[ ]` 表示尚未实现。一个阶段没有证据时不得标记完成。

### S0 · 基线、fixture 与预算校准

- [~] 固定 benchmark 环境：脚本记录 Node/平台/架构，Bun/OpenTUI、CPU、screen mode、theme 和真实终端尺寸仍待固定。
- [~] 建立 deterministic event fixtures：已有 10,000 × 1-char、8 KiB chunk、1 MiB single chunk、开放 code fence、表格与 abort/error；tool result fixture 仍待补齐。
- [x] 为当前“完整 frame projection”加测量 seam，记录 projection 次数、累计字符处理量、单次耗时和 native frame stats。
- [~] 建立 100 / 1,000 / 10,000 entries 与 64 KiB / 1 MiB 单消息基线：当前已有 10,000 native keyed history 与 1 MiB coalescer 数据，其余规模/层级仍待补齐。
- [~] 分别测“仅 reducer”“projection + layout”“native frame”：当前已有 coalescer 与 projection/native 分层计数，Yoga/layout 独立耗时与 PTY 仍待测。
- [ ] 校准第 5 节预算；当前 [`18-streaming-baseline-2026-08-05.json`](18-streaming-baseline-2026-08-05.json) 是 coalescer/pure-policy 初始 artifact，不是完整 before/after 预算证明。

验收：生成可复现的基线报告和 fixture；明确主要成本在事件、解析、布局还是 terminal paint。

### S1 · 持久 keyed render tree

- [x] RED：更新活动 assistant part 时，历史 entry renderable identity、editor identity、overlay identity 和 scroll position 保持不变。
- [x] 引入稳定 `TimelineEntryId` / `TimelinePartId`；`TimelineStore` 已提供 generation fence，Chat/OpenTUI adapter 已使用稳定 block key；replay/live/toolcall 的统一 identity 规则仍待收敛。
- [~] 建立 registry，由 adapter 创建/更新/删除单个 entry/part renderable：当前 component runtime 的 keyed maps 已实现，独立 `timeline-projection`/renderable registry 尚未拆出。
- [x] screen、timeline、editor、footer 保持持久；常规 update 不再销毁整屏，已有 Bun native identity tests。
- [x] overlay 仅在 id/type 变化或关闭时创建/销毁；内容变化只 mutation 子节点。
- [~] 把全量 snapshot mount 限定为 cold start、session replace 或测试 fixture：当前 mount/update 复用已接通，session replace 的 production path 仍待核验。

验收：单 entry delta 的 application dirty set 只含目标 entry；历史树、editor draft/selection/focus 与 overlay 不被重建。

### S2 · 有界 delta coalescer 与帧调度

- [x] RED：10,000 个 1-char delta 不触发 10,000 次 projection/paint，最终文本逐字节等于输入；已有 pure test、benchmark 和 shared frame test。
- [x] transport callback 只入队/更新轻量 reducer，不同步执行全历史 render；`InteractiveMode` 的 text/thinking delta 已接入 coalescer。
- [x] 合并相邻且同 entry/part/generation 的 text/thinking delta；保持严格顺序。
- [x] 对状态类事件提供 generation-aware latest-wins 与 superseded 计数；resize/spinner/progress 的 production producer 接线仍待补齐。
- [~] 前台窗口从一帧（16–33 ms）起步；scheduler 已按 queued event/bytes/oldest age 提前 flush，终端速度自适应仍待测。
- [~] 单轮 drain 有事件数上限且 input/interrupt 使用 force path；字符数/CPU time budget 与 approval fairness 仍待补齐。
- [x] complete/error/abort/session switch 的 terminal path 会先 drain；destroy/quit 前也会清空已接受的 delta。
- [~] `renderer.requestRender()` 已集中到 TUI scheduler，但 `InteractiveMode` 仍在每类事件结束处请求 dirty，完整 projection owner 边界仍待进一步收敛。

验收：burst 下正文无丢失、输入不饥饿、frame 数量受控，且低速输出没有人为 300 ms 级延迟。

### S3 · 原生增量 Markdown、代码与 diff

- [~] RED：活动 tail 更新已保持 keyed history identity，terminal 内容一致；OpenTUI Markdown 内部解析成本与稳定 block 计数尚未形成独立证据。
- [x] 每个活动 assistant Markdown part 使用一个持久 `MarkdownRenderable`，流开始 `streaming=true`，结束/error/abort 后 final flush 再设 `false`。
- [x] 直接追加本事件 delta；`AssistantMessageComponent` 不再从累计 `partial` 重建已投影正文。
- [~] 稳定历史 part 与活动 tail 已按 presentation block key 分离，ChatContainer 仍需遍历历史 child，完整 parse/wrap/layout 增量化仍待完成。
- [x] 不把 OpenTUI 实验性 `_stableBlockCount` 暴露为 RunLedger 类型、领域事件或长期兼容契约。
- [x] 对开放/超大 code fence 设置字符与行数预算；超限时使用可选择的、正文无损的 plain text projection，结束后恢复 Markdown；高亮耗时预算仍待真实 OpenTUI profiling。
- [ ] 若异步高亮存在，使用 generation fence、1 active + 1 latest queued 上限和可取消结果提交。
- [ ] 仅真实 unified diff 进入 `DiffRenderable`；before/after 摘要继续使用诚实 Text projection。

验收：开放 fence、长行、CJK、ANSI、表格和 1 MiB Markdown 不阻塞交互；稳定历史的 parse/wrap/highlight 计数不随活动 token 增长。

### S4 · 长会话窗口化、分页与缓存回收

Plan 05 的 settled-prefix 专项已提供独立的稳定性证据：[`../plan/05-streaming-prefix-stability-evidence-2026-08-15.json`](../plan/05-streaming-prefix-stability-evidence-2026-08-15.json)。其中 P3 settled 行缓存、P4 闭合表格拆分和 P5 streaming diff admission 已有直接实现与测试；该文件只作为 S3/S4 的补充 evidence，不改写本文现有阶段 checkbox，也不覆盖本文仍缺的完整 before/after 性能预算。

- [~] RED：已有 10,000 keyed native history 与滚动位置测试；尚未证明 frame 只访问 viewport + overscan。
- [x] transcript 已改为每 entry/part 独立 child，OpenTUI `viewportCulling=true` 在实际树上生效。
- [x] OpenTUI `stickyScroll` 已验证用户上滚后新 append 不抢回 `scrollTop`；已接入持久的“new content”提示，PageDown 回到底部后清除。
- [~] 已有 bounded `RenderCache`（entry/width/contentGeneration/themeGeneration key）和 `HeightIndex` pure layer；OpenTUI 高度/换行缓存尚未接入。
- [~] 已完成 10,000 entries native smoke 基线；Yoga/layout 独立成本仍待测，再决定是否启用真正窗口化。
- [ ] 窗口化必须保持稳定 row key、scroll anchor、selection/copy 和活动 streaming row pinning。
- [~] 已将“渲染窗口化”和派生缓存回收拆为独立 pure modules；历史数据分页/裁剪尚未实现。
- [~] `ChatContainer` 的 presentation cache 有条目/字节 LRU 上限；Markdown wrap/highlight 的屏外回收尚未接入。

验收：历史增长不导致每帧线性遍历/布局；用户读历史时不自动跳底；滚回已回收区域可按需重建且内容一致。

### S5 · 交互能力与渲染能力分离

- [ ] RED：entry renderable 被回收/重建后，copy/fold/approve/retry 仍按稳定 ID 操作正确对象。
- [ ] 固定 `transport → reducer/store → timeline projection → renderable adapter` 单向边界。
- [ ] renderer 不直接改 controller/ledger；交互发出 typed intent，由既有 authority 决定是否执行并回送状态。
- [ ] 审批、复制、折叠、重试、打开详情不依赖可见行号或 renderable object identity。
- [ ] toolcall receiving 默认展示状态、工具名与累计安全字节数，不逐 token 展示潜在敏感参数正文。
- [ ] thinking streaming 优先更新紧凑 activity/header；是否在稳定边界进入 transcript 由明确产品策略和脱敏边界决定。
- [ ] overlay、editor、timeline 各自拥有清晰 focus owner；全局 Ctrl+C/Ctrl+D authority 继续遵守 renderer Plan 17。

验收：窗口化、缓存回收或 resize 不破坏交互目标；安全摘要与原始参数/结果边界有测试。

### S6 · 响应式布局与前端效果

- [~] RED：Bun native 已覆盖 60 / 80 / 143 列、resize 后 editor identity/draft 与 resize storm 合帧；overlay focus、selection/scroll anchor 的真实 PTY 证据仍缺。
- [ ] 60 列采用 compact chrome：折叠次要 hints/metadata；80 列标准布局；143 列允许并列展示额外审计摘要，但不改变 authority。
- [ ] header/footer/status 的频繁状态变化只更新对应小节点，不触发 transcript layout。
- [x] resize 事件进入共享 16 ms scheduler，storm 期间 latest-wins；最后一帧再按当前宽度投影。
- [x] 用户阅读历史时禁用自动跟随；回到底部或显式触发后恢复 sticky-follow。
- [~] Bun native 已覆盖 selection/copy、paste、CJK/emoji 宽度、theme 更新与 overlay focus；reduced motion 和完整 PTY input 仍待补齐。
- [ ] spinner/活动提示遵守 frame budget；pressure 模式下降频或静态化，不用动画抢占正文与输入。

验收：三档宽度和交互状态有 PTY 证据；“更好看”落实为信息层级、稳定性、可读性和输入响应，而不是增加重型装饰。

### S7 · 背压、降级与内存预算

- [~] RED：coalescer pressure telemetry、lossless 正文合并、bounded presentation cache 与 native input fairness 已有 focused 证据；慢 renderer 的全链路 hard-memory 上限仍未证明。
- [ ] 同时限制 queued events、queued bytes、oldest age、async jobs 和昂贵 cache bytes；阈值必须可观测。
- [ ] 达到 soft limit 时扩大 lossless 合并窗口、降低 spinner/status 频率、暂停非关键高亮并进入 catch-up 模式。
- [x] 达到 streaming 字符/行/fence limit 时对开放大块切换 raw/plain text projection；正文不静默删除，并展示降级标记，终态可恢复 Markdown。
- [~] supersedable 事件的淘汰规则与 pressure telemetry 已有 pure coalescer；lossless 上游不可暂停时的硬字节上限/主动暂停仍待接入真实 producer。
- [x] 大单行、大表格与超长 code fence 已共享解析保护阈值和用户可见降级标记；超深列表与布局耗时仍待 profiling。
- [ ] session switch/abort/destroy 取消旧 generation 工作并释放 buffer/cache；验证无 renderer/timer/listener 泄漏。

验收：压力测试达到稳定上界，降级可恢复且不改变审计正文；所有 dropped 项都属于明确定义的可替代状态。

### S8 · 证据门禁与回写

- [~] Node 纯测试已覆盖 coalescer、generation fence、identity、backlog/缓存预算；降级策略和完整 reducer/projection 矩阵仍待补齐。
- [~] Bun native tests 已使用 `@opentui/core/testing` 的真实 renderer、`captureCharFrame()` / `captureSpans()` 与 native stats；`ManualClock`/`TestRecorder` 和更细的 native timing 仍待补齐。
- [~] 已覆盖 burst delta、1 MiB coalescer、10,000 entries、streaming 中向上滚动与 new-content 提示、60/80/143 宽度、resize storm、overlay + stream、abort/error final flush、开放 fence/大表格/超长单行的局部路径；PTY 场景仍待补齐。
- [~] 受控 POSIX PTY smoke 已验证 mock demo 在 60 / 80 / 143 列启动、出现 RunLedger frame、Ctrl+D 正常退出和 cleanup；selection/copy、paste、theme、focus、Ctrl+C 与详细预算仍待补齐，证据见 [`18-pty-smoke-2026-08-05.json`](18-pty-smoke-2026-08-05.json)。
- [x] 当前工作树 `npm run check`、`npm run build`、TUI focused tests、benchmark 与全量 `npm test` 均通过；这仍不替代完整 PTY 交互和 before/after budget 证据。
- [x] 已将当前 before/coalescer artifact、测试命令、环境和失败边界回写本文；完整 before/after 与 human verification 仍待补齐。

验收：性能结论有可复现实验，不以“看起来流畅”或 mock render 调用次数替代 native frame/PTY 证据。

## 7. 测试矩阵

| 场景 | 必须证明 | 主要层级 |
|---|---|---|
| 10,000 × 1-char burst | lossless、有限 projection、输入公平、final flush | pure + Bun |
| 低速 1 token/100 ms | 无额外明显延迟、无抖动 | ManualClock + PTY |
| 1 MiB assistant message | queue/cache 有界、可取消、可完成 | pure + Bun |
| 开放 code fence | 只更新 tail；超预算可降级；结束态一致 | Bun frame |
| 大表格/超长单行 | 无 >50 ms application task；UI 可操作 | benchmark + PTY |
| 10,000 history entries | viewport 访问有界、滚动/选区稳定 | Bun + PTY |
| streaming 时向上滚动 | 不抢回底部；新内容提示正确 | mockInput + PTY |
| resize storm | latest-wins、anchor/focus/draft 保持 | ManualClock + Bun |
| overlay + token burst | overlay identity/focus 保持，控制键不穿透 | Bun input |
| abort/error/session switch | 旧 generation 不回写，已接受正文 final flush | pure + Bun |
| theme switch | 只失效相关样式/cache，不重建领域状态 | Bun frame |
| destroy/restart | timer/listener/job/cache 全释放 | native stats |

测试必须区分：

- application projection 次数，不等于 terminal 实际绘制次数；
- frame cell diff 很小，不等于 Markdown/layout CPU 很小；
- viewport culling 已开启，不等于历史节点未参与 Yoga/layout；
- 峰值内存稳定，不等于审计历史被错误裁剪。

## 8. 建议的实现文件边界

文件名可随 S1 RED 微调，但职责不得重新合并到 `interactive-mode.ts`：

```text
src/tui/opentui/
  timeline-store.ts             pure entries/parts/generation reducer
  delta-coalescer.ts            lossless merge + latest-wins + limits
  frame-scheduler.ts            clock/frame/backlog/input fairness
  timeline-projection.ts        changed ids + stable registry
  timeline-renderables.ts       Markdown/Text/Tool/Diff adapters
  viewport-window.ts            optional S4 height index/windowing
  render-cache.ts               width/theme/generation budgets + eviction
  performance-observer.ts       counters/timing/native stats adapter
```

`InteractiveMode` 只负责订阅、把 typed event 交给 reducer、接收 typed intent 并调用既有 controller；它不拼接整段 transcript、不拥有 scheduler timer、不直接做 Markdown/highlight。

### 8.1 当前执行证据（2026-08-05）

本轮已落地到工作树的实现切片与 agent verification：

- `src/tui/opentui/timeline-store.ts`：entry/part 稳定 ID、generation fence、terminal flush 结果；
- `src/tui/opentui/delta-coalescer.ts`：正文 lossless 相邻合并、generation-aware status latest-wins、queued bytes/events/pressure telemetry；
- `src/tui/opentui/frame-scheduler.ts`：16 ms application frame window、force/input/terminal flush、backlog age/size 提前 flush、destroy 清理；
- `src/tui/opentui/render-cache.ts` 与 `viewport-window.ts`：有界派生缓存和纯高度/overscan/anchor 索引；
- `src/tui/opentui/performance-observer.ts`、component runtime 与 `InteractiveMode`：区分 queue/coalescing、projection 和 native frame 计数；
- keyed OpenTUI screen/timeline/overlay、direct ScrollBox children、assistant delta append、ChatContainer bounded presentation cache；
- `scripts/benchmark-tui-streaming.ts`、[`18-streaming-baseline-2026-08-05.json`](18-streaming-baseline-2026-08-05.json) 与 [`18-pty-smoke-2026-08-05.json`](18-pty-smoke-2026-08-05.json)：Node/Linux coalescer + pure Markdown fixture 与受控 PTY smoke artifact；不替代 native/layout/完整 PTY budget。

已通过的 focused gate：

- `npx vitest run tests/tui`：16 files / 113 tests passed；
- `npm run test:tui-native`：14 tests / 88 assertions passed，包含 10,000 keyed history、上滚 sticky-scroll、new-content 提示、PageUp/PageDown、60/80/143 宽度与 resize 后 identity；
- `npm run check`、`npm run build`、`git diff --check`：通过；
- `npm run benchmark:tui-streaming`：10,000 × 1-char 合并为 1 个 projection item，正文字节无损。
- 受控 `node-pty` mock demo smoke：60 / 80 / 143 列均出现 RunLedger frame，发送 Ctrl+D 后 exit code 0。

全量 `npm test` 当前结果为 147 files / 779 tests 与 native 14 tests / 88 assertions 全绿；它证明没有当前工作树回归，但仍不等于 Plan 18 的完整 PTY selection/theme/focus 或性能预算闭合。

## 9. 风险与回退策略

- OpenTUI 0.4.5 的 `MarkdownRenderable.streaming` 和 `CodeRenderable.streaming` 可以使用；实验性 `internalBlockMode` / `_stableBlockCount` 只允许封装在可替换 adapter 内评估，不进入 RunLedger 稳定契约。
- `ScrollBoxRenderable.viewportCulling` 先实测再决定是否自建窗口化；若已满足预算，不为了形式完整引入额外高度索引复杂度。
- `createScrollbackSurface()` 只适配 `split-footer`，不能在本文中借性能优化之名把 renderer Plan 17 的 `alternate-screen` 隐式切换掉。
- plain text 降级必须保留可选择、可复制的完整审计正文，并有明确 UI 标记；不能显示“已高亮/已渲染”但实际丢内容。
- 任何优化若改变 controller、event schema、ledger retention 或 Auth/Tool 脱敏 authority，立即停止并拆成独立计划。
- 回退以阶段/adapter 为单位；不得恢复“每 token 销毁整屏”作为无提示 fallback。

## 10. 非目标

- 不在本文完成 pi-tui → OpenTUI 迁移；该工作只属于 `17-opentui-refactor-plan.md`。
- 不引入 React、Solid、Web DOM、Shiki 或 grok-build/Codex/OpenCode 代码依赖。
- 不修改 LLM/provider 的语义事件协议，除非独立 contract 计划明确授权。
- 不用 UI 裁剪替代 ledger/session 数据保留策略。
- 不把完整 reasoning、tool args 或 tool results 暴露到 UI 来换取“流式效果”。
- 不把固定 16 ms、100 ms 或 300 ms 写成跨机器永远正确的 magic number；所有 cadence 服从预算与测量。

## 11. 完成定义

只有同时满足以下条件，本文才可标记完成：

1. 活动 delta 只更新目标 entry/part，稳定历史、editor、overlay 和 screen tree 不随 token 重建；
2. 事件合并、projection、paint 三层可观测，正文 lossless，终态强制 flush，输入不被 token burst 饿死；
3. Markdown/code/diff 有持久实例、稳定前缀和受控尾部，重型计算有界且可降级；
4. 10,000 entries 的可见渲染成本不随全部历史线性增长，sticky-follow 尊重用户阅读位置；
5. queue、异步任务和派生 cache 都有显式字节/数量预算、telemetry 和压力测试；
6. 60 / 80 / 143 列、resize、selection/copy、theme、overlay/focus、abort/error 有真实 Bun frame 与 PTY 证据；
7. 第 5 节预算由当前环境的 before/after artifact 证明，未达项如实保留，human/agent verification 不混写；
8. `17-opentui-refactor-plan.md` 继续保持 renderer 迁移 authority；本文没有把参考项目做法或计划 checkbox 冒充 RunLedger 已实现能力。
