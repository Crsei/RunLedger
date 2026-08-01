# Plan Mode、Compaction 与 Memory 参考基线

> 状态:设计取证,不代表已实现
> 基线日期:2026-07-22
> RunLedger:`feat/agent-loop-resurrect@1658fe26fc675cc18498bb8c6a9f162b7a0b733f`
> Codex:`main@0b175e6439a8608ba7726ee153fd8590619e8f34`
> grok-build:`main@c68e39f60462f28d9be5e683d9cbe2c57b1a5027`
> 上位 Runtime 计划:[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)
> 下游计划:[`01-implementation-plan.md`](01-implementation-plan.md)

## 0. 取证边界

本文件只回答四件事:

1. `plan mode`、`compaction`、`memory` 在参考实现中分别由谁持有状态。
2. 三者在 turn、session、resume、fork、model switch 和 TUI 上如何衔接。
3. 哪些机制适合 RunLedger,哪些缺口不能照搬。
4. RunLedger 当前代码已经提供哪些接入点。

文档职责与代码所有权不由本取证文件定义:公共数据结构、schema、current event payload 和 contract fixture 归上位 Runtime Phase 6;具体 Model Router、Plan Mode、ContextEngine、Compaction、Memory 行为和集成归下游专项计划。实施时以两份计划的 allowlist 与串行 handoff 规则为准。

Model Compatibility Router 的取证不在本文件重复,直接消费 [`../runtime/00-reference.md`](../runtime/00-reference.md) 中“Model Router 不能只比较价格与 Benchmark”及其 Compatibility Manifest/能力别名/不兼容 fork 结论。

三个术语必须分开:

- **Plan Mode** 是运行模式和权限状态,不是 `Task` 工具,也不是一段 system prompt。
- **Compaction** 是当前 session 的有损 model-context 投影,不是删除审计历史。
- **Memory** 是跨 turn 或跨 session 的持久知识,不是 compaction summary 的别名。

计划文件、compaction summary 和 memory record 可以互相引用,但必须拥有独立生命周期、审批状态和来源证明。

## 1. Codex 参考

### 1.1 Plan Mode

关键路径:

- `codex-rs/protocol/src/config_types.rs`
- `codex-rs/collaboration-mode-templates/templates/plan.md`
- `codex-rs/models-manager/src/collaboration_mode_presets.rs`
- `codex-rs/core/src/context/world_state/collaboration_mode.rs`
- `codex-rs/tui/src/chatwidget/plan_implementation.rs`
- `codex-rs/tui/src/chatwidget/tests/plan_mode.rs`

可复用机制:

- `ModeKind` 和 `CollaborationMode` 是结构化 turn/session 设置,不靠解析自然语言判断当前模式。
- mode mask 可同时覆写 model、reasoning effort 与 developer instructions,但 mode identity 独立存在。
- mode instructions 作为有标记的 world-state fragment 注入;同一模式不重复注入,模式改变时生成 context diff。
- `request_user_input` 只在 Plan Mode 开放,模式本身参与工具可见性决策。
- 计划完成后的实施入口是显式用户选择。Codex 同时提供“保留当前上下文实施”和“把批准计划带到 fresh context 实施”两条路径。
- TUI 测试覆盖模式切换、model/reasoning override、计划实施确认和 context-clear 路径。

需要补强的边界:

- Codex 的 Plan Mode 主要是协作模式与 prompt/tool surface 组合,不能单独证明所有副作用被 runtime 拒绝。
- RunLedger 不能把“模型收到只读提示”当成权限边界;写文件、shell、MCP、hook 和子 Agent 都必须经过同一 capability gate。

### 1.2 Compaction

关键路径:

- `codex-rs/core/src/compact.rs`
- `codex-rs/core/src/compact_token_budget.rs`
- `codex-rs/core/src/state/auto_compact_window.rs`
- `codex-rs/core/src/context_manager/{mod,history}.rs`
- `codex-rs/protocol/src/compacted_item.rs`
- `codex-rs/core/tests/suite/{compact,compact_resume_fork,compact_remote}.rs`
- `codex-rs/app-server/tests/suite/current/compaction.rs`

可复用机制:

- manual、auto、pre-turn/model-switch 与 mid-turn compaction 都进入统一 task/service,并产生明确的 start/completed item。
- 原始 rollout 保持 append-only;live model history 由 compacted replacement history 替换,两者不是同一份数据。
- replacement history 与 compaction metadata 一起持久化,resume/fork 从 checkpoint 重建 model-visible history。
- compaction 后重新注入当前初始上下文/world state,避免把旧 AGENTS、mode 或配置固化进摘要。
- pre-turn/manual 与 mid-turn 对初始上下文的放置不同;后者必须保持最后一个真实 user message 的相对位置。
- token budget 同时考虑 context window、输出预留、tool definition、function output 和多模态估算。
- 测试覆盖多次压缩、resume/fork、rollback 跨越压缩点、model 切换到更小窗口、tool call/result 历史裁剪、context-window error retry 和压缩事件顺序。

需要补强的边界:

- 摘要由模型生成,本身不可信;必须校验关键状态 invariant,不能只检查摘要非空。
- RunLedger 必须保留 compaction 前后的来源范围、摘要 digest、model identity、token receipt 和批准/触发原因。
- 不能把压缩后的 history 覆盖写回 canonical ledger;压缩结果只能进入当前 event/projection,无法验证的数据必须拒绝。

### 1.3 Memory

关键路径:

- `codex-rs/memories/README.md`
- `codex-rs/memories/write/src/{phase1,phase2,storage,workspace}.rs`
- `codex-rs/memories/read/src/{lib,citations,usage}.rs`
- `codex-rs/ext/memories/src/{backend,local,tools}.rs`
- `codex-rs/state/memory_migrations/0001_memories.sql`
- `codex-rs/protocol/src/memory_citation.rs`

可复用机制:

- 写路径拆成两阶段。Phase 1 对每个近期 rollout 做有界抽取;Phase 2 取得全局 lease 后串行整合共享 memory workspace。
- Phase 1 有 eligibility、scan/claim limit、并发上限、lease、retry backoff 和 `succeeded_no_output`,不会每次启动无界重扫。
- Phase 2 用稳定排序、输入 watermark、workspace diff 和 git baseline 判断真实变更,并清理过期派生资源。
- read/write 分 crate 和 backend interface;list/read/search 均有分页、行数、token 和路径约束。
- 模型回答中的 memory citation 被解析成结构化 metadata;usage 反向回写到被引用的来源。
- 外部上下文和某些 MCP/tool output 会把当前 thread 标为 memory-polluted,避免受污染 session 自动进入后续 memory generation。

需要补强的边界:

- Codex 的后台 consolidation agent 会直接更新 memory workspace。RunLedger 第一版必须把模型输出视为 proposal,由用户或管理策略批准后才能发布为长期 memory。
- 文件级 git baseline 有助于 diff,但不是企业审计真源;RunLedger 还需要 ledger intent/commit、content digest 和 approval receipt。
- citations 不能只依赖模型在文本里正确输出;RunLedger 应在 context assembly 时记录实际注入/读取的 memory record ID。

## 2. grok-build 参考

### 2.1 Plan Mode

关键路径:

- `crates/codegen/xai-grok-pager/docs/user-guide/19-plan-mode.md`
- `crates/codegen/xai-grok-shell/src/session/plan_mode.rs`
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/{enter_plan_mode,exit_plan_mode}/`
- `crates/codegen/xai-grok-shell/src/session/acp_session_tests/{plan_mode_edit_gate_tests,plan_mode_midturn_tests,plan_approval_resume_tests}.rs`
- `crates/codegen/xai-grok-pager/src/app/acp_handler/tests/plan_mode.rs`

可复用机制:

- `Inactive -> Pending -> Active -> ExitPending` 是独立纯状态机,session actor 只负责在安全点驱动转换。
- `plan_mode.json` 保存稳定 snapshot;依赖 in-flight turn 的 `Pending`/`ExitPending` 在 restart 时折叠到安全状态。
- `awaiting_plan_approval` 独立持久化,client 断连或进程恢复后能重新显示审批界面。
- 计划正文只从 session 的 `plan.md` 读取,不接受模型在 `exit_plan_mode` 参数中再传一份可能漂移的内容。
- Plan Mode 激活时只允许计划文件写入;即使底层 permission 是 always-approve,其它 edit tool 仍被拒绝。
- mid-turn activation 使用缓冲 reminder,在安全 drain point 才交给模型;未送达前撤销不会伪造一次 enter/exit。
- compaction 后重置 reminder 计数并重新注入 plan-mode 状态。

明确拒绝照搬:

- grok-build 文档承认 Bash 写入未被 Plan Mode edit gate 检查,子 Agent 也不继承父 Plan Mode。RunLedger 不允许保留这两个逃逸口。
- 仅限制已知 edit tool name 不足以形成硬边界;必须按 capability/effect 分类,未知副作用默认拒绝。
- `plan.md` 可变文件适合编辑,但审批必须 pin 内容 digest 和 revision,否则批准后外部修改会发生 TOCTOU。

### 2.2 Compaction

关键路径:

- `crates/codegen/xai-grok-shell/src/session/compaction.rs`
- `crates/codegen/xai-grok-shell/src/session/compaction_config.rs`
- `crates/codegen/xai-grok-shell/src/session/helpers/{session_compact,full_replace_compaction,compaction_context}.rs`
- `crates/codegen/xai-chat-state/src/{compaction_mode,compaction_transcript,compaction_utils}.rs`
- `crates/common/xai-grok-compaction/src/`
- `crates/codegen/xai-grok-shell/src/session/acp_session_tests/{inline_auto_compact_flow_tests,rewind_cross_compaction_tests}.rs`

可复用机制:

- full-replace engine 把 sampling、retry、degenerate summary、deterministic/transient error 分类与 observer 分开。
- 输入有 verbatim -> fitted -> lossy ladder;context overflow 可以降级输入,其它确定性错误不热循环。
- auto-compaction failure 有 turn/sticky/until-success 三类抑制状态,避免每轮重复触发同一失败。
- two-pass compaction 可在阈值前后台预生成 prefix note,并用 prefix fingerprint 与 model slug 防止使用过期 cache。
- `Summary`、`Transcript`、`Segments` 把“模型默认只看摘要”和“必要时按引用恢复原文”分开。
- rewind 跨越 compaction point 时清除失效 summary/checkpoint marker,不会让压缩后的未来内容泄漏回旧分支。
- Plan Mode 状态和 reminder 在 compaction 后单独恢复,不依赖 summary 记住模式。

RunLedger 首版取舍:

- 先实现可审计 single-pass full-replace 和明确 retained tail,再考虑 two-pass/prefire。
- 首版保留 raw ledger + artifact reference,等价于安全的 `Transcript` 能力;不急于生成 segment store。
- retry 总数必须有界;overflow compact-and-retry 最多一次,与普通网络 retry 分开记账。

### 2.3 Memory

关键路径:

- `crates/codegen/xai-grok-pager/docs/user-guide/13-memory.md`
- `crates/codegen/xai-grok-memory/src/{backend,storage,index,search,dream,watcher}.rs`
- `crates/codegen/xai-grok-shell/src/session/{memory_state,memory}.rs`
- `crates/codegen/xai-grok-shell/src/session/helpers/{memory_context,memory_flush}.rs`
- `crates/codegen/xai-grok-tools/src/implementations/memory/`

可复用机制:

- global、workspace、session 三种来源分开存放;workspace identity 优先基于 Git remote,避免同仓库 clone/worktree 记忆割裂。
- Markdown 是可读事实面,SQLite FTS/vector index 是可重建 projection。
- search 支持 source weight、temporal decay、MMR、多路打分和 staleness 提示。
- first-turn injection 与 post-compaction recovery 都是有标记、单条结果有长度上限的 context fragment。
- 已持久化的 memory-context block 会原样复用,避免每次 resume 重新排序导致 prompt prefix/cache 抖动。
- pre-compaction flush 提前于 hard threshold,有 once-per-cycle guard、输出长度/Markdown 结构检查、exact/semantic dedup。
- session-end save、显式 `/flush`、`/remember`、`/dream` 分成不同质量和延迟层级。

需要补强的边界:

- first-turn 自动搜索不能绕过 trust/approval。RunLedger 只注入 `approved` 且未过期的 record。
- embedding 不可用时可以退化为 lexical search,但必须把实际 search mode 与 score 写入 receipt。
- watcher 和外部直接编辑会改变 memory;RunLedger 必须检测 digest 漂移并重新走导入/批准,不能默认为可信。
- flush/dream 只能创建 proposal,不能直接发布为长期 memory。

## 3. RunLedger 当前基线

### 3.1 可复用接入点

- `src/runtime/agent-loop.ts` 已在每次模型请求前统一执行 `convertToLlm`,并有 `prepareNextTurn`、tool hooks、turn/message/tool 事件和 ledger append 点。
- `src/runtime/agent.ts` 已持有 session state、单活跃 run、interrupt、steering/follow-up queue 和 `waitForIdle`。
- `src/runtime/interactive-session-controller.ts` 已统一 model/thinking/settings/session replay/TUI 装配,适合成为 mode、compact 和 memory command 的 facade。
- `src/runtime/tool-authorization.ts` 与 `beforeToolCall` 已有工具授权入口,但当前 allow/deny 粒度还不足以证明 Plan Mode 只读。
- `src/runtime/ledger/` 已有 append-only current、lock 和 high-water mark;可作为现有实现基线,不能直接承载尚未实现的完整性声明。
- `src/storage/session-codec.ts` 已无损恢复 current canonical AgentMessage。
- `src/storage/session-manager.ts` 已有 create/open/continue/fork/list 与整场独占 lock。
- `src/tui/interactive-mode.ts` 已有 slash command、status/footer、model/thinking selector 和 AgentEvent adapter,但业务状态仍由 TUI 局部持有。

### 3.2 当前硬缺口

| 领域 | 当前状态 | 实施前必须补齐 |
|---|---|---|
| Plan Mode identity | 无 session mode 类型或持久状态 | durable discriminated state + revision/digest |
| Plan edit boundary | 通用 write/edit/bash 可运行 | capability/effect gate + 专用 plan writer |
| Plan approval | 无审批 protocol/UI | request/decision receipt + reconnect/resume |
| Context assembly | `systemPrompt + messages` 直接送模型 | typed layered fragments + stable digest |
| Token accounting | 主要展示 provider usage | preflight estimator + output/tool reserve |
| Compaction | 未实现 | safe cut + summary + validation + projection checkpoint |
| Resume/fork | 重放全部 canonical message | compaction-aware projection + branch invalidation |
| Memory store | 未实现 | scoped records/proposals + provenance + approval |
| Memory search | 未实现 | bounded backend interface + citations/receipts |
| TUI | 无 mode/compact/memory surface | projection-driven commands/status/approval views |

## 4. 综合采用原则

| 机制 | 采用来源 | RunLedger 决策 |
|---|---|---|
| mode 结构化 identity/context diff | Codex | 采用,mode 不由 prompt 猜测 |
| four-state lifecycle/mid-turn buffer | grok-build | 采用并改成不可表达非法组合的联合类型 |
| plan file + approval preview | grok-build/Codex | 采用,审批 pin revision + digest |
| fresh-context implementation | Codex | 采用,实现为受审计 fork |
| edit-tool-only gate | grok-build | 拒绝,改为 capability/effect gate |
| append-only raw history + replacement projection | Codex | 采用 |
| retry/suppression/input ladder | grok-build | 采用有界子集 |
| two-pass/prefire | grok-build | 延后到 single-pass golden tests 稳定后 |
| two-phase memory extraction/consolidation | Codex | 采用 pipeline 形状,发布前增加审批 |
| Markdown + rebuildable search index | grok-build | 采用,canonical record 与 projection 分开 |
| automatic durable memory writes | 两者均有 | 首版拒绝,只生成 proposal |
| pre-compact flush/post-compact recovery | grok-build | 采用,flush 只产 proposal,recovery 只读 approved memory |
| memory citations | Codex | 采用 runtime-tracked record references,不信任模型自报 |

## 5. 最终设计结论

1. Plan Mode、Compaction 和 Memory 共用 `ContextEngine`,但不共用状态机或存储记录。
2. raw event/ledger 永不因 compaction 改写;model-visible history 是可重建 projection。
3. Plan Mode 只读边界由 Runtime capability gate 实施;第一版在 plan mode 直接禁用 Bash、未知 MCP 副作用和子 Agent 写能力。
4. plan approval、memory approval 与 tool approval 使用同一种 durable request/decision receipt,但保留各自 payload schema。
5. memory 自动抽取和 compaction flush 只生成候选;长期 record 必须批准后发布。
6. mode、当前批准计划、pending approval、workspace identity、未完成 tool pairing 和 verification baseline 都属于 compaction invariant,不能仅存在摘要文本里。
7. 上游代码只作行为参考;实施每一阶段前仍需重新核对上游版本、许可证、当前 RunLedger worktree 和父计划依赖。
