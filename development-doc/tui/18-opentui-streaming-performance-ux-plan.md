# 18 · OpenTUI 流式渲染、长会话性能与交互体验补充计划

> 状态：待执行（Plan 17 P8 已通过，可从 S0 严格执行）
>
> 依赖：[`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md)
>
> OpenTUI 基线：`@opentui/core@0.4.5`
>
> 参考实现：Codex、OpenCode、grok-build 的当前本地源码快照；这些项目只提供设计证据，不是 RunLedger 的依赖或完成状态。

## 1. 权威边界与执行结论

[`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) 仍是 pi-tui → OpenTUI imperative core 迁移、renderer 替换、Bun 启动器和迁移状态的唯一权威清单。本文不复制、不改写 Plan 17 的 P0–P8 checkbox，只负责迁移后的流式性能、长会话渲染和交互体验。

执行边界：

- Plan 17 P8 已在 2026-08-02 获得 agent-verified 证据，S0–S8 已解除前置门禁，但仍全部是未实现计划项；
- 后续必须按 S0 → S8 顺序执行，不得因前置门禁已解除而跳过 profiling、fixture 或性能预算校准；
- 若 Plan 17 的 renderer 基线发生回归，先恢复其门禁证据，再继续本计划，禁止两份计划并行争夺 renderer 结构 authority；
- 继续使用 OpenTUI imperative core，不切换 React/Solid，不隐式更改 `alternate-screen`；
- UI 仍只消费 controller/runtime 事件，不接管 Session、Auth、Tool、ledger 或 lifecycle authority。

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

因此，Plan 17 中的 `streaming=true`、sticky scroll 和 viewport culling 是迁移目标，不代表本文的增量树、背压、窗口化和性能预算已经完成。

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

各阶段遵循 RED → 最小 GREEN → focused regression → 同域回归。一个阶段没有证据时不得标记完成。

### S0 · 基线、fixture 与预算校准

- [ ] 固定 benchmark 环境：CPU、终端尺寸、Bun/Node/OpenTUI 版本、screen mode 和 theme。
- [ ] 建立 deterministic event fixtures：1 字符碎片、自然 token、8 KiB burst、开放 code fence、表格、tool result、abort/error。
- [ ] 为当前“完整 frame projection”加测量 seam，记录 projection 次数、累计字符处理量、单次耗时和 native frame stats。
- [ ] 建立 100 / 1,000 / 10,000 entries 与 64 KiB / 1 MiB 单消息基线。
- [ ] 分别测“仅 reducer”“projection + layout”“native frame”，禁止只用端到端总时长掩盖瓶颈。
- [ ] 校准第 5 节预算；保留 before artifact，不把优化后数据回填成基线。

验收：生成可复现的基线报告和 fixture；明确主要成本在事件、解析、布局还是 terminal paint。

### S1 · 持久 keyed render tree

- [ ] RED：更新活动 assistant part 时，历史 entry renderable identity、editor identity、overlay identity 和 scroll position 保持不变。
- [ ] 引入稳定 `TimelineEntryId` / `TimelinePartId`，replay、live event、toolcall 使用同一 identity 规则。
- [ ] 建立 registry，由 adapter 创建/更新/删除单个 entry/part renderable。
- [ ] screen、timeline、editor、footer 保持持久；禁止常规 update 调用 `destroyRecursively()` 重建整屏。
- [ ] overlay 仅在 id/type 变化或关闭时创建/销毁；内容变化只 mutation 子节点。
- [ ] 把全量 snapshot mount 限定为 cold start、session replace 或测试 fixture，普通 delta 不走该路径。

验收：单 entry delta 的 application dirty set 只含目标 entry；历史树、editor draft/selection/focus 与 overlay 不被重建。

### S2 · 有界 delta coalescer 与帧调度

- [ ] RED：10,000 个 1-char delta 不触发 10,000 次 projection/paint，最终文本逐字节等于输入。
- [ ] transport callback 只入队/更新轻量 reducer，不同步执行全历史 render。
- [ ] 合并相邻且同 entry/part/generation 的 text、thinking、tool delta；保持严格顺序。
- [ ] 对 resize、spinner、progress 等 supersedable 事件执行 latest-wins，并计数。
- [ ] 前台窗口从一帧（16–33 ms）起步；结合 queued event count、queued chars 和 oldest age 提前/延后 flush。
- [ ] 单轮 drain 设置事件数/字符数/CPU time budget；每轮显式给 input、scroll、interrupt 与 approval 让路。
- [ ] complete/error/abort/session switch 强制 final flush；destroy 前不遗失已接受的语义 delta。
- [ ] `renderer.requestRender()` 只由 scheduler/projection owner 调用，避免 reducer、组件和事件 handler 多头调度。

验收：burst 下正文无丢失、输入不饥饿、frame 数量受控，且低速输出没有人为 300 ms 级延迟。

### S3 · 原生增量 Markdown、代码与 diff

- [ ] RED：活动 tail 增长时稳定历史 part 不重新解析、不重建；terminal event 后完成态内容一致。
- [ ] 每个活动 assistant Markdown part 使用一个持久 `MarkdownRenderable`，流开始 `streaming=true`，结束/error/abort 后 final flush 再设 `false`。
- [ ] 直接追加本事件 delta，不再从累计 `partial` 提取全文覆盖活动 part。
- [ ] 稳定历史 part 与活动 tail 分离；活动尾部更新不得让整个 transcript 重新 join/ANSI 转换。
- [ ] 不把 OpenTUI 实验性 `_stableBlockCount` 暴露为 RunLedger 类型、领域事件或长期兼容契约。
- [ ] 对开放/超大 code fence 设置字符、行数与高亮耗时预算；超限时使用可选择的 plain text/延迟高亮，结束后可在空闲预算内升级。
- [ ] 若异步高亮存在，使用 generation fence、1 active + 1 latest queued 上限和可取消结果提交。
- [ ] 仅真实 unified diff 进入 `DiffRenderable`；before/after 摘要继续使用诚实 Text projection。

验收：开放 fence、长行、CJK、ANSI、表格和 1 MiB Markdown 不阻塞交互；稳定历史的 parse/wrap/highlight 计数不随活动 token 增长。

### S4 · 长会话窗口化、分页与缓存回收

- [ ] RED：10,000 entries 时可见 frame 只访问 viewport + overscan 范围，滚动位置和选区稳定。
- [ ] transcript 改为每 entry/part 独立 child，使 OpenTUI viewport culling 在实际粒度生效。
- [ ] sticky-follow 只在用户处于底部时启用；用户向上阅读后，新 delta 不抢回视口，并显示可操作的“新内容”提示。
- [ ] 建立 `(entryId, width, contentGeneration, themeGeneration)` 高度/换行缓存；resize 只失效受 width 影响的缓存。
- [ ] 先基准验证 Yoga + viewport culling；若 10,000 entries 仍超预算，再实现真正窗口化：高度前缀/索引、可见区定位、overscan、top/bottom spacer。
- [ ] 窗口化必须保持稳定 row key、scroll anchor、selection/copy 和活动 streaming row pinning。
- [ ] 将“渲染窗口化”“历史数据分页/裁剪”“派生缓存回收”设计和指标分开。
- [ ] 回收远离 viewport 的 Markdown render output、wrap、highlight 等昂贵缓存；原始审计文本的留存由 Session/ledger authority 决定，UI 不擅自删除。

验收：历史增长不导致每帧线性遍历/布局；用户读历史时不自动跳底；滚回已回收区域可按需重建且内容一致。

### S5 · 交互能力与渲染能力分离

- [ ] RED：entry renderable 被回收/重建后，copy/fold/approve/retry 仍按稳定 ID 操作正确对象。
- [ ] 固定 `transport → reducer/store → timeline projection → renderable adapter` 单向边界。
- [ ] renderer 不直接改 controller/ledger；交互发出 typed intent，由既有 authority 决定是否执行并回送状态。
- [ ] 审批、复制、折叠、重试、打开详情不依赖可见行号或 renderable object identity。
- [ ] toolcall receiving 默认展示状态、工具名与累计安全字节数，不逐 token 展示潜在敏感参数正文。
- [ ] thinking streaming 优先更新紧凑 activity/header；是否在稳定边界进入 transcript 由明确产品策略和脱敏边界决定。
- [ ] overlay、editor、timeline 各自拥有清晰 focus owner；全局 Ctrl+C/Ctrl+D authority 继续遵守 Plan 17。

验收：窗口化、缓存回收或 resize 不破坏交互目标；安全摘要与原始参数/结果边界有测试。

### S6 · 响应式布局与前端效果

- [ ] RED：60 / 80 / 143 列和 resize storm 下，重要信息不重叠、不越界，editor/overlay focus 与 scroll anchor 保持。
- [ ] 60 列采用 compact chrome：折叠次要 hints/metadata；80 列标准布局；143 列允许并列展示额外审计摘要，但不改变 authority。
- [ ] header/footer/status 的频繁状态变化只更新对应小节点，不触发 transcript layout。
- [ ] resize 事件合并为 latest-wins；最后一次 resize 后统一重算 width-keyed layout。
- [ ] 用户阅读历史时禁用自动跟随；回到底部或显式触发后恢复 sticky-follow。
- [ ] selection/copy、paste、CJK/emoji 宽度、reduced motion、theme 更新和 overlay focus 纳入真实 frame/input 测试。
- [ ] spinner/活动提示遵守 frame budget；pressure 模式下降频或静态化，不用动画抢占正文与输入。

验收：三档宽度和交互状态有 PTY 证据；“更好看”落实为信息层级、稳定性、可读性和输入响应，而不是增加重型装饰。

### S7 · 背压、降级与内存预算

- [ ] RED：慢 renderer + 快 producer 下 queue/cache 不无限增长，正文最终完整，控制输入仍可响应。
- [ ] 同时限制 queued events、queued bytes、oldest age、async jobs 和昂贵 cache bytes；阈值必须可观测。
- [ ] 达到 soft limit 时扩大 lossless 合并窗口、降低 spinner/status 频率、暂停非关键高亮并进入 catch-up 模式。
- [ ] 达到 hard limit 前对开放大块切换 raw/plain text projection；不得静默删除 assistant/tool 语义正文。
- [ ] supersedable 事件的淘汰规则显式化；lossless 事件若上游不可暂停，必须压缩为 chunk buffer，并发出 pressure telemetry。
- [ ] 大单行、大表格、超深列表、超长 code fence 设置解析/布局保护阈值和用户可见降级标记。
- [ ] session switch/abort/destroy 取消旧 generation 工作并释放 buffer/cache；验证无 renderer/timer/listener 泄漏。

验收：压力测试达到稳定上界，降级可恢复且不改变审计正文；所有 dropped 项都属于明确定义的可替代状态。

### S8 · 证据门禁与回写

- [ ] Node 纯测试覆盖 coalescer、reducer、generation fence、identity、预算和降级策略。
- [ ] Bun native tests 使用 `@opentui/core/testing` 的真实 renderer、`ManualClock`、`TestRecorder`、`captureCharFrame()` / `captureSpans()` 与 native stats。
- [ ] 覆盖 burst delta、1 MiB message、开放 fence、大表格、10,000 entries、streaming 中向上滚动、resize storm、overlay + stream、abort/error final flush。
- [ ] PTY 验证 60 / 80 / 143 列、selection/copy、paste、theme、focus、Ctrl+C/Ctrl+D 和 cleanup。
- [ ] 运行 `npm run check`、`npm test`、`npm run build`、`npm run demo:tui`。
- [ ] 将 before/after 数据、测试命令、环境、失败项和降级行为回写本文；human verification 与 agent verification 分列。

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

## 9. 风险与回退策略

- OpenTUI 0.4.5 的 `MarkdownRenderable.streaming` 和 `CodeRenderable.streaming` 可以使用；实验性 `internalBlockMode` / `_stableBlockCount` 只允许封装在可替换 adapter 内评估，不进入 RunLedger 稳定契约。
- `ScrollBoxRenderable.viewportCulling` 先实测再决定是否自建窗口化；若已满足预算，不为了形式完整引入额外高度索引复杂度。
- `createScrollbackSurface()` 只适配 `split-footer`，不能在本文中借性能优化之名把 Plan 17 的 `alternate-screen` 隐式切换掉。
- plain text 降级必须保留可选择、可复制的完整审计正文，并有明确 UI 标记；不能显示“已高亮/已渲染”但实际丢内容。
- 任何优化若改变 controller、event schema、ledger retention 或 Auth/Tool 脱敏 authority，立即停止并拆成独立计划。
- 回退以阶段/adapter 为单位；不得恢复“每 token 销毁整屏”作为无提示 fallback。

## 10. 非目标

- 不在本文完成 pi-tui → OpenTUI 迁移；该工作只属于 Plan 17。
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
8. Plan 17 继续保持迁移 authority，本文没有把参考项目做法或计划 checkbox 冒充 RunLedger 已实现能力。
