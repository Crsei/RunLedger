# RunLedger TUI 结构完善实施计划

> 文档属性:当前权威实施计划。
>
> 基线日期:2026-07-24。
>
> RunLedger 规划快照:`feat/agent-loop-resurrect@2859346e9ead6b9d3d79c5f96835525a56988d2c`。
>
> 参考快照:
>
> - `codex/main@0b175e6439a8608ba7726ee153fd8590619e8f34`
> - `grok-build/main@c68e39f60462f28d9be5e683d9cbe2c57b1a5027`
> - `claude-code-bun/main@73338f21dc166ac13303d24f3fe671a52bac745d`
>
> 本文取代 `07-roadmap.md` 作为下一轮 TUI 实施入口。`07-roadmap.md` 记录已完成的 M0-M7
> 复刻过程,`01`-`06` 仍是历史规格与设计输入;事实冲突时以当前代码、测试、`AGENTS.md`
> 和本文的阶段门禁为准。

## 1. 目标

本轮不是重写 `@earendil-works/pi-tui`,而是完善 RunLedger 自有 TUI 的应用结构:

1. 把数据服务、动作协调、状态归约、展示组件拆成可独立验证的四层;
2. 让 command catalog、completion、执行与结果展示只有一个真源和一个执行漏斗;
3. 让 session 列表、详情、resume、fork 先经过可信 read-model 与受治理动作边界,
   组件不直接读写 JSONL、ledger 或 Control Plane;
4. 让 live event、startup replay、session preview 共用同一 transcript projection;
5. 把 loading、empty、error、disabled、stale-cache、discarded-stale-result、
   recovery-required 等状态/规则作为正式合同,不用空字符串或通用 `[note]` 假装成功;
6. 使用"P 架构门禁 + V 可见切片"双轨实施:P0-P3 先建立公共骨架,command 与只读
   session 轨随后按依赖交替推进;每个生产实现切片都必须能从正常 `runledger` 看到对应效果。

## 2. 当前事实与结构缺口

### 2.1 已有能力

- `src/tui/interactive-mode.ts` 已能装配 chat、status、editor、footer、overlay,消费
  `AgentEvent`,并展示 user/assistant/tool/queue 状态;
- `src/tui/components/` 已有消息、selector、tool call、bash、diff、status、资源条等组件;
- `src/tui/session-selector.ts` 已被 CLI `--resume` 用作启动前选择器;
- `SessionManager.list/open/continueRecent/forkFrom` 与 `V3SessionManager`、version fence、
  publication state、writer lease 已存在;
- Runtime v3 Control Plane 已有 `session:start/resume/fork/stop` command、`session:inspect`
  query、session handle、expected revision 与 recovery 语义;
- CLI 已能区分 legacy v1/v2 与 v3,legacy 在相应 rollout 状态下保持只读,显式
  migration/fork-to-v3 由独立命令处理。

### 2.2 已确认缺口

| 缺口 | 当前证据 | 影响 |
|---|---|---|
| `InteractiveMode` 同时承担装配、输入、command、provider/auth、session replay、event reducer 和渲染 mutation | `src/tui/interactive-mode.ts` 共 1336 行 | 新展示面继续堆入会扩大状态分叉与测试耦合 |
| command catalog 有静态数组,执行又有第二份 switch | `interactive-mode.ts:344-360` 与 `705-764` | 排序、描述、可用性和真实执行会漂移 |
| command 没有 typed invocation/result/lifecycle | 结果主要经 `showNotice()` 进入 `CustomMessageComponent` | 无法稳定表达 pending/running/succeeded/failed/cancelled/aborted 或审计 receipt |
| command completion 与执行边界未固定 | selector 选中后由分支直接开 overlay 或再次注入文本 | 难以保证 completion accept 不越权执行 |
| session 只有启动前 picker | `src/tui/session-selector.ts:25-60` | 主 TUI 没有统一 session 浏览、详情和动作入口 |
| session row 只显示 ID、mtime、cwd/path | `session-selector.ts:46-53` | 没有 format/version/lifecycle/compatibility/lineage/错误状态 |
| session 组件直接消费存储层 `SessionInfo` | `session-selector.ts:1` | 组件被 legacy/v3 存储细节绑死 |
| footer/resource bar 只重复 session ID | `components/footer.ts:32-55`、`components/loaded-resources.ts:52-68` | 不能表达 active/paused/read-only/recovery-required 等状态 |
| session 操作没有 TUI 应用级 coordinator | `InteractiveSessionControllerPort` 只代表当前 session;CLI 在启动前选择 manager | 不能安全完成 controller/subscription/writer lease 的替换 |
| command/session 测试只覆盖最小打开与选择 | `tests/tui/interactive-controls.test.ts:176-213,215-282` | 没有 registry 漂移、stale result、resume rollback、fork lineage、PTY replay 证明 |
| 历史规格与当前实现有漂移 | `02-component-spec.md` 仍描述组件自行扫描 `getAgentDir()` | 后续实现容易沿用已失效边界 |

结论:不能先继续画 command/session 组件。必须先建立领域合同、纯 reducer 和应用级
port,再让组件消费 projection。

## 3. 三个参考项目的可复用证据

下面只记录影响本计划顺序的证据。路径均相对各参考仓库。

### 3.1 Codex

Codex 的有效边界是:

```text
AppServerSession 数据服务
  -> AppEvent/App 动作协调
  -> ChatWidget 协议事件归约
  -> active cell/committed HistoryCell
  -> Tui 渲染
```

- `codex-rs/tui/src/app_server_session.rs:1-4` 隔离数据服务;
- `codex-rs/tui/src/app_event.rs:1-9` 定义内部 typed action 总线;
- `codex-rs/tui/src/app/event_dispatch.rs:1-5` 让中央 dispatcher 只路由,大动作下沉到专题模块;
- `codex-rs/tui/src/history_cell/mod.rs:191-256` 让同一 history cell 服务主界面、
  transcript 与高度计算;
- `codex-rs/tui/src/slash_command.rs:7-15,81-170,187-243` 在一个 catalog 中定义
  展示顺序、描述、inline args 与 active-task availability;
- `codex-rs/tui/src/bottom_pane/command_popup.rs:20-141` 让 popup 与 composer 共用过滤规则;
- `codex-rs/tui/src/resume_picker.rs:82-139` 只返回 typed selection,不在 picker 内执行;
- `codex-rs/tui/src/resume_picker.rs:640-727` 把分页、搜索 token、loading、preview、
  transcript overlay 建模为显式状态;
- `codex-rs/tui/src/app/session_lifecycle.rs:842-990` 由 App 协调运行中 resume;
- `codex-rs/tui/src/chatwidget/replay.rs:9-77,145-159` 让 replay 复用 live
  command/tool 展示路径;
- `codex-rs/tui/src/chatwidget/command_lifecycle.rs:54-73,242-448` 按 `call_id` 归约
  running/delta/completed,并处理 orphan 与最终结果覆盖。

RunLedger 采纳 typed intent、App 级 session replacement、active/committed 分区和
live/replay 同投影;不移植 app-server JSON-RPC、Ratatui/Crossterm 实现、账户/Desktop
与 Codex 专属多 agent UI。

### 3.2 Grok Build

Grok TUI 最有价值的是单向动作链:

```text
terminal/runtime event
  -> Action
  -> 纯 dispatch/reducer
  -> Effect
  -> TaskResult
  -> reducer
  -> render
```

- `crates/codegen/xai-grok-pager/src/app/actions.rs:32-38` 把 Action 定义为同步、无副作用意图;
- `crates/codegen/xai-grok-pager/src/app/dispatch/mod.rs:1-10` 明确 dispatch 不访问终端、
  网络或文件系统;
- `crates/codegen/xai-grok-pager/src/app/effects/mod.rs:1-7,34-41` 让异步 Effect 回流为
  TaskResult;
- `crates/codegen/xai-grok-pager/src/slash/registry.rs:16-51,78-98,166-201` 分开
  source、canonical name、
  alias、trigger、lookup 与 visibility;
- `crates/codegen/xai-grok-pager/src/slash/command.rs:31-77,92-124` 分开建议上下文、
  执行上下文和 typed result;
- `crates/codegen/xai-grok-pager/src/app/dispatch/prompt.rs:279-292,396-580` 让普通 Enter
  与 palette 共用
  唯一执行漏斗;
- `crates/codegen/xai-grok-pager/src/app/effects/mod.rs:689-739` 由 effect 获取 session list;
- `crates/codegen/xai-grok-pager/src/views/session_picker.rs:496-570` 基础行只显示 summary,
  展开后再显示 ID、
  CWD、model、时间和统计;
- `crates/codegen/xai-grok-pager/src/app/dispatch/session/load.rs:510-649,1191-1232` 用
  sequence 使关闭或新搜索后的旧结果失效;
- `crates/codegen/xai-grok-pager/src/app/dispatch/session/load.rs:114-221,868-996` 以
  placeholder -> replay -> finalize -> secondary hydration 顺序恢复 session;
- `crates/codegen/xai-grok-pager/src/app/dispatch/session/fork.rs:431-459,560-618` 明确
  fork 成功/失败终结,不留下悬挂 command;
- `crates/codegen/xai-grok-pager/src/acp/tracker.rs:983-1221` 覆盖 tool
  start/update/completed 和乱序 update。
- `crates/codegen/xai-grok-pager/src/acp/tracker.rs:3200-3248,3618-3758` 用测试覆盖
  update-before-start 与 streaming -> completed;
- `crates/codegen/xai-grok-pager/src/app/dispatch/tests/session/fork.rs:971-1068`
  覆盖 `ForkReady` 与失败收口。

RunLedger 采纳 Action/Effect/Result、sequence invalidation、typed tool block 和渐进 session
详情;不移植 ACP、foreign session 聚合、leader dashboard、voice/media/billing 与 Grok 的
多目录 session store。

### 3.3 Claude Code Bun

Claude Code Bun 最值得复用的是 command 输入漏斗与 session 渐进加载:

- `src/types/command.ts:16-218` 先定义 discriminated command result、availability 和
  展示 metadata;
- `src/utils/processUserInput/processUserInput.ts:432-565,590-603` 固定
  safety -> attachment -> bash -> slash -> prompt 的输入顺序;
- `src/utils/processUserInput/processSlashCommand.tsx:427-689,730-1039` 集中
  parse、validate、overlay/result projection;
- `src/utils/QueryGuard.ts:1-120` 建立
  `idle -> dispatching -> running -> idle` 生命周期;
- `src/utils/queueProcessor.ts:17-93` 隔离 slash/bash,只批同 mode prompt;
- `src/components/messages/UserCommandMessage.tsx:13-49` 与
  `UserLocalCommandOutputMessage.tsx:13-45` 把 invocation/output 放入统一 timeline;
- `src/utils/sessionStorage.ts:2947-3079,4043-4133,5102-5135` 使用
  lite -> enrich -> full transcript;
- `src/components/SessionPreview.tsx:18-102` 选中后才加载 transcript,并复用主消息渲染;
- `src/screens/ResumeConversation.tsx:109-397` 显式表达 chooser -> loading -> REPL;
- `src/utils/conversationRecovery.ts:471-625` 让 recovery service 负责解析与一致性检查;
- `src/screens/REPL.tsx:2098-2303` 把恢复资源、身份切换、file pointer、metadata、
  worktree、messages 和 overlay 清理按顺序收口;
- `src/commands/branch/branch.ts:63-175,224-285` 坚持 durable write 成功后才切入 fork。

RunLedger 采纳 typed result、QueryGuard、lite/enrich/full、单一 transition coordinator、
Control Plane authority replacement 与 durable-before-switch;不移植 React/Ink/custom
external-store 实现、约 6500 行 REPL、
Anthropic 私有 feature gate、XML tag、remote bridge/swarm 和 fork-subagent 语义。

## 4. 目标架构

### 4.1 四层边界

```text
Runtime / Storage / Control Plane
          │
          ▼
Data service ports
CommandRegistryPort / SessionCatalogPort / SessionControlPort / ActivityQueryPort
          │
          ▼
App coordinator
TuiAction/TuiResult -> reducer -> TuiEffect -> EffectRunner -> TuiResult -> reducer
          │
          ▼
Presentation
TimelineProjection / CommandView / SessionSummaryView / FooterSnapshot
          │
          ▼
pi-tui components
render(width) only; no fs, network, ledger, controller mutation
```

硬边界:

- data service 负责 IO、Control Plane、version fence、writer lease 和错误规范化;
- coordinator 的 canonical state machine 决定执行顺序、并发、取消、重试与 rollback;
- reducer 必须同步、纯函数、可重放;
- `EffectRunner` 是唯一 effect 执行者,只通过注入的 port 做 IO,不持有第二份应用状态;
- projection 只把 canonical state 变成可显示 view model;
- component 只处理布局、focus 和 typed intent 回调;
- `render(width)` 不读文件、不发请求、不改其它组件、不追加 ledger;
- transport/runtime event 先变成 `TuiAction`,禁止直接 mutation 组件;
- `InteractiveMode` 最终只保留 terminal 生命周期、root composition、input/event dispatch
  和 render scheduling。

唯一副作用闭环固定为:

```text
reduce(state, TuiAction | TuiResult)
 -> { state, effects }
EffectRunner.execute(effect, ports, signal)
 -> TuiResult
dispatch(TuiResult)
 -> reducer
```

`EffectRunner` 不得直接 mutation state/component,也不得自行推进 resume/fork 阶段。超时、取消、
重试结果和 effect certainty 都必须携带 correlation ID 回流 reducer,由 reducer 决定下一步。

### 4.2 屏幕固定结构

从上到下保持以下 slot 顺序:

1. `ContextHeader`:workspace、当前 session 标题/短 ID、format/lifecycle badge;
2. `Timeline`:user、assistant、command、tool、approval、task、notice 的统一滚动区;
3. `ActiveState`:active turn、tool progress、queue、approval/recovery-required;
4. `PromptInput`:文本、slash completion、history mode;
5. `Footer`:provider/model/thinking、context、键位提示;
6. `OverlayStack`:command palette、session picker/detail、confirm、auth 等互斥层。

`LoadedResourcesComponent` 不再重复 ledger ID。它只显示来自真实 registry/snapshot 的
tools/plugins/skills/hooks/MCP 数量;当前 session 信息归 `ContextHeader`。

### 4.3 展示真源

| 展示内容 | 唯一真源 | View model | 禁止来源 |
|---|---|---|---|
| slash command | `CommandRegistry` snapshot | `CommandSuggestionView` | `InteractiveMode` 内静态数组 |
| command 执行 | `CommandIntent` + `CommandDecision` + `CommandExecutionState` | `CommandTimelineRow` | 直接 `showNotice()` 字符串 |
| assistant/user | replay message + live `AgentEvent` | `TimelineRow` | component 私有猜测 |
| tool | `toolCallId` 关联的 start/update/end | `ToolTimelineRow` | 仅按 tool name 合并 |
| session list | `SessionCatalogPort` | `SessionSummaryView` | component 直接扫 JSONL |
| session detail | lazy `SessionCatalogPort.enrich/loadFullPreview` | `SessionDetailView` | 初载时解码全部 transcript |
| session action | `SessionControlPort`/Control Plane receipt | `SessionActionState` | selector 直接 `SessionManager.open/forkFrom` |
| queue | `queue:list` + canonical queue event | `QueueView` | editor 本地数组作为持久真源 |
| activity/footer | `activity:get`/controller selection | `FooterSnapshot` | `render()` 发异步请求 |
| extension resources | extension catalog generation | `ResourceSummaryView` | 手工常量或 placeholder 计数 |

### 4.4 QueryGuard 与输入所有权

同一时刻只能有一个需要 query lane 的输入 dispatch 获得同步 reservation:

```text
idle --reserve in same call stack--> dispatching --effect starts--> running
  ^                                                        |
  +-- success / error / cancelled / aborted, finally ------+
```

- reservation 必须在调度任何 effect 前同步完成,避免同一 event-loop tick 双重提交;
- `success/error/cancelled/aborted` 都通过 reducer 的 terminal result 在 `finally` 语义下释放;
- queue 仅在 guard 为 `idle` 且没有 modal/overlay 时 drain;
- slash、bash 与 ordinary prompt 使用隔离的 queue item kind,不得被批成同一 prompt;
- 每类 intent 显式声明 active-query policy:`immediate`、`queue` 或 `reject`;不得由组件猜测;
- `immediate` 只允许 effect-free、`historyPolicy = "ephemeral"` 的 UI-local decision;
  任何 runtime/storage/session IO 仍须 reserve query lane 或走显式 Control Plane control intent;
- overlay 关闭、session transition 冻结或 recovery-required 时不得偷偷 drain;
- guard 是 canonical application state 的一部分,不能以 editor 的本地 boolean 代替。

## 5. Command 合同与展示顺序

### 5.1 必须先定义的合同

```ts
export type CommandAvailability =
  | { state: "available" }
  | { state: "disabled"; reason: string }
  | { state: "hidden" };

export interface CommandIntent {
  commandInvocationId: string;
  canonicalName: string;
  normalizedArgs: readonly string[];
  catalogGeneration: number;
}

export type CommandDecision =
  | { state: "handled"; summary?: string }
  | { state: "message"; text: string }
  | { state: "action"; action: TuiAction }
  | { state: "effect"; effect: TuiEffect }
  | { state: "queued"; queueItemId: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "cancelled"; reason?: string }
  | { state: "aborted"; reason: string };

export type CommandExecutionState =
  | { state: "pending" }
  | { state: "running"; effectId?: string }
  | { state: "succeeded"; summary?: string }
  | { state: "failed"; message: string; retryable: boolean }
  | { state: "cancelled"; reason?: string }
  | { state: "aborted"; reason: string };
```

`CommandDefinition` 至少包含 canonical name、aliases、description、category、argument
schema、presentation order、availability resolver、draft consumption policy、
`historyPolicy: "ephemeral" | "session" | "audit"`、active-query policy 和 handler。
handler 只接收不可变快照并产生纯 `CommandDecision`,不得访问 controller、storage、terminal
或直接执行异步 IO。真正 IO 只能变成 `TuiEffect` 交给唯一 `EffectRunner`;异步完成统一以带
`commandInvocationId/effectId` 的 `TuiResult` 回流并更新 `CommandExecutionState`。
不得用 `enum`;实际实现使用 `as const` 与 discriminated union。

### 5.2 不可交换执行链

```text
explicit editor submit
 -> safety
 -> attachment
 -> bash
 -> slash
 -> ordinary prompt fallback
```

上述 route 顺序是 canonical input route,前一分支命中后不得继续下落。completion dropdown
accept 不是 submit,只能更新 draft;只有显式 Enter/submit 才能产生 intent。slash 分支内部
的不可交换执行链为:

```text
parse
 -> registry lookup and alias normalization
 -> argument validation
 -> create CommandIntent with catalog generation
 -> execution reducer resolves current catalog generation,availability,AppState and active-query policy
 -> active-query arbitration
```

active-query arbitration 的分支固定为:

```text
catalog stale/hidden/disabled
 -> correlated terminal failed;no handler/effect
guard running + queue
 -> enqueue correlated typed item/row only;no handler/effect
guard running + reject
 -> correlated terminal failed(reason=active_query);no handler/effect
guard running + immediate
 -> re-resolve current catalog generation,availability and AppState in the same reducer cycle
 -> stale/hidden/disabled fails closed;no handler
 -> invoke only an effect-free ephemeral UI-local handler
 -> reducer applies synchronous decision;no query-lane mutation/effect
guard idle
 -> synchronous QueryGuard reserve(dispatching)
 -> re-resolve current generation,availability and AppState
 -> invoke pure handler
 -> CommandDecision
 -> reducer maps handled/message/action/queued/failed/cancelled/aborted or Effect
```

reserve 成功后的 decision 闭环为:

```text
synchronous terminal decision
 -> update correlated timeline row
 -> release dispatching -> idle in the same reducer cycle
Effect decision
 -> running
 -> EffectRunner
 -> correlated TuiResult
 -> update timeline
 -> terminal reducer release running -> idle and restore focus
```

running 时的 queue/reject/immediate 分支都不得改写当前 query 的 guard ownership。`action`
decision 若经 reducer 产生 effect,必须转入 running/effect 路径;只有无 effect 的 action
才属于 synchronous terminal。

queued item 以后只有在 `guard = idle` 且无 modal/overlay/transition freeze 时 drain;drain
会生成新的 execution attempt,再次按当前 catalog generation 与 availability 完整验证。

约束:

- completion accept 只能更新 editor draft,不创建 `CommandIntent`、不调用 handler;
- 普通 Enter、palette 的显式 Run、带参数 command 必须进入同一 execution funnel;
- palette/suggestion 的 availability 只是展示快照;执行时必须按当前 `AppState` 重新检查
  catalog generation 与 availability,旧 generation、当前已 running 或 capability 已变化时
  fail closed,不得先调度 effect;
- active turn 中 command 的 available/disabled 状态来自 registry resolver,不在 handler
  内临时猜;
- immediate handler 若返回 `effect/queued` 或触发 IO,属于 contract violation 并 fail closed;
- invocation 与结果有稳定 `commandInvocationId`,异步结果不得写到另一条 command;
- 参数显示由 command-specific redaction projector 决定,secret/token 不进入 timeline;
- mutation command 必须显示 canonical receipt/ref 或明确 `recovery-required`,不能只显示
  "done";
- command catalog generation 变化时先替换 registry snapshot,再刷新 completion;
- `historyPolicy = "ephemeral"` 的 `/help`、`/commands`、`/clear` 等 UI 行为不写 session
  transcript;`session/audit` 只按各自策略持久化,不能把所有 command echo 一律追加 ledger。

### 5.3 第一批 RunLedger command

| Command | 行为 | 前置阶段 |
|---|---|---|
| `/help`、`/commands` | 打开 registry 驱动的 palette | P4-P5 |
| `/clear` | 清 viewport,不清 session/ledger | P4-P5 |
| `/provider`、`/login`、`/logout`、`/model`、`/thinking` | 复用现有 controller,统一 availability/result | P4-P5 |
| `/plugins`、`/skills`、`/hooks`、`/mcp`、`/reload-extensions` | 复用 extension snapshot/generation | P4-P5 |
| `/session` | 当前 session 详情 | P6-P9 |
| `/sessions`、`/resume [id]` | session browser/恢复 intent | P6-P9 |
| `/new` | 受治理创建新 session | P8-P9 |
| `/fork` | 从精确 durable cursor 分叉 | P10 |
| `/quit` | 走统一 lifecycle shutdown | P4-P5 |

`/rename`、`/delete` 不进入第一批。前者尚无 canonical metadata mutation,后者是破坏性动作
且需要独立 GC/reference 设计。

## 6. Session 合同、展示与动作顺序

### 6.1 Lite summary

Session picker 初次加载只允许读取有界 summary:

- stable session ID 与短 ID;
- display title:优先显式持久 title;只有 summary/index 已经持有首条 user prompt 的有界
  preview 时才可作为 fallback,不得为 lite list 扫描 transcript;两者都没有时显示
  `Untitled session`;preview 不能冒充持久 title;
- verified cwd/workspace;无法从 canonical metadata 得到时显示 `unknown`,不得把当前进程 cwd
  填成历史事实;
- created/modified timestamp;
- format/version:`v3` 或 `legacy v1/v2`;
- lifecycle:`active/paused/stopped/closed/corrupted/unknown`;
- compatibility:`resumable/read-only/migration-required/unsupported`;
- lineage:parent/fork 标记,仅在 canonical metadata/projection 存在时显示;
- loading/error 与 catalog generation。

加载端口固定分为三段,不得退化成 `lite -> full`:

```text
listLite(query, listRequestId)
 -> enrich(sessionId, enrichRequestId)
 -> loadFullPreview(sessionId, previewRequestId)
```

message/turn/tool count、model/provider、head cursor、lineage warning 属于选中后
`enrich`;recent transcript 属于 `loadFullPreview`;两者都不得阻塞基础列表。
三段使用独立 correlation lane/requestId。过期 response 必须丢弃,它不是可显示的 session
row 状态;若以后支持 stale cache,必须与 stale response 明确分开建模。

### 6.2 Picker 状态

```ts
export type SessionCatalogState =
  | { state: "idle" }
  | { state: "loading"; generation: number; listRequestId: string }
  | {
      state: "ready";
      generation: number;
      listRequestId: string;
      items: readonly SessionSummaryView[];
    }
  | { state: "empty"; generation: number; listRequestId: string }
  | {
      state: "failed";
      generation: number;
      listRequestId: string;
      message: string;
      retryable: boolean;
    };
```

- 在启动任何 list/enrich/preview effect 前,先建立 picker generation 和三条独立 request
  lane:`listRequestId/enrichRequestId/previewRequestId`;
- 打开/搜索/关闭先同步更新 picker generation 与 list lane;selection 变化只同步失效并替换
  enrich/preview 两条 lane;两种情况都必须先更新 guard 再发 effect;
- late result 只有 lane requestId、session ID 与当前 generation 全部一致时才归约;
- 基础列表先支持当前项目、modified-desc、ID/title filter;
- enrich/preview 仅对当前选中项加载,切换 selection 时分别取消或废弃旧结果;
- preview 复用 `Timeline`,禁止新建第二套 message renderer;
- row Enter 只产生 `SessionIntent`,不直接 open/resume/fork。

### 6.3 Resume 事务

RunLedger 不能机械照搬参考项目的"先关闭旧 session"。writer lease、version fence、
Control Plane handle 与 v3 publication authority 已由 `SessionRuntimeRegistry` replacement
saga 持有,TUI 不得自行 prepare/close manager、释放 writer lease 或打开 candidate runtime。
不可交换顺序为:

```text
SessionIntent::Resume
 -> read-only inspect format/version/publication/lifecycle and resolve exact target
 -> same-session no-op
 -> confirm active turn/queue policy
 -> reserve transition,freeze editor/overlay and capture draft
 -> revalidate picker generation,target capability,current turn/queue
 -> durable quiesce current turn and queue with their current handle/revision
 -> dispatch Control Plane session:resume with sessionHandle=null and expectedTurnId=null
 -> SessionRuntimeRegistry internally prepare/fence/activate/replace/drain
 -> consume returned SessionBootstrap
 -> applySessionBootstrap()
 -> replace UI controller/subscription and project authoritative replay exactly once
 -> update header/footer/resources and project correlated Control Plane receipt
 -> unfreeze input and restore eligible draft
```

失败规则:

- quiesce 的 interrupt/cancel 使用 current handle/revision 并等待 durable terminal result;
  `session:resume` 不得携带 current handle/turn,可选 `expectedSessionRevision` 只能绑定 exact
  target session;
- read-only preview/preflight 只可验证和有界预解码 replay source,不得创建 candidate
  controller、改变可见 Timeline 或被当作 authoritative replay;
- Control Plane 明确返回 pre-activation failure 且确认旧 runtime 仍 active 时,可解除冻结并恢复
  draft;TUI 不负责关闭 registry 内部 candidate;
- fencing/activation/authority outcome 不确定或返回 `recovery-required` 时保持冻结,不得自动
  retry mutation 或假装恢复旧 writer;
- authority 已切换后发生 UI attach/replay/header failure 时,新 target 仍是 authority;不得回滚
  到旧 writer,必须保持冻结并进入受治理 recovery;
- legacy v1/v2 不得静默进入可写态;显示 read-only 或 migration-required;
- replay 未结束前不得发送 initial prompt、加载次级 metadata 或允许 fork;
- 同一 session 已是 active 时只 focus/关闭 picker,不重复打开或重复 replay。

`applySessionBootstrap()` 是 UI 侧唯一 attach/replay 后半段。它消费 registry 返回的 bootstrap,
不发 Control Plane mutation;resume 与 fork 都复用它。

### 6.4 Fork 事务

P8 resume coordinator 未验收前禁止实现 P10 fork:

```text
SessionIntent::Fork
 -> inspect and capture exact parent session/revision/cursor
 -> confirm active turn/queue policy
 -> reserve transition,freeze editor/overlay and capture draft
 -> revalidate local picker generation,intent,capability,current parent/turn/queue
 -> durable quiesce current turn and queue with current handle/revision
 -> re-inspect and bind final stable parent expected revision/cursor
 -> dispatch Control Plane session:fork
 -> Control Plane adapter revalidates parent head,mutation gate and external receipts
 -> registry/factory create staged child identity and lineage
 -> append child genesis/fork event and required replay references
 -> publish child durably
 -> SessionRuntimeRegistry activate/replace authority
 -> consume returned child SessionBootstrap
 -> applySessionBootstrap() without another session:resume
 -> update header/footer/timeline and show correlated parent/child lineage receipt
 -> unfreeze input and restore eligible draft
```

- child publish 前禁止切换 header、session ID、controller 或 writer pointer;
- publish 前确定失败可清理 staging target;Control Plane 确认父 authority active 后,显示失败并
  解除冻结/恢复 eligible draft;
- publish 后但 authority 尚未切换时,child 已是 durable 可发现对象,不得删除;父 authority
  确认仍 active 时,结果必须给出 child ref 和可 resume 状态,随后才可解除冻结/恢复 draft;
- publish/authority outcome 不确定时保持冻结并进入 recovery-required,不得按 pre-authority
  确定失败处理;
- authority 已切换后 UI attach/replay 失败时,child 仍是当前 authority;保持冻结并进入
  recovery-required,不得尝试复活父 writer;
- fork 不创建第二套 UI attach/replay 逻辑,也不得在成功后再次发送 `session:resume`;
- legacy fork 只显示明确的 `fork-to-v3 required` 能力状态,不能调用旧 `forkFrom` 假装 v3 lineage。

## 7. P 架构门禁与 V 可见切片

P0-P12 保留为架构、authority 与故障安全门禁,但不再等同于 commit 单位。依赖图固定为:

```text
P0 -> P1 -> P2 -> P3
                    ├──> P4 -> P5 ──┐
                    └──> P6 -> P7 ──┴──> P8 -> P9 -> P10 -> P11 -> P12
```

- P0-P3 是所有后续切片的共同前置;
- P4-P5 建立 command 单一真源、执行漏斗和展示框架;
- P6-P7 建立只读 session catalog、picker、detail 与 preview;它们可在 P4-P5
  框架建立后与单命令迁移交替推进;
- P8 resume 必须同时等待 P5 command framework 与 P7 session read-only track 通过;
- P10 fork 仍必须等待 P8 全部门禁和 P9 real PTY resume;
- P11/P12 仍在 command/session 主骨架与 fork authority 稳定后开始。

真正的实现、验收、提交和回退单位是下文的 V0-V30。V0 与 P12 是验证门禁,可以没有新增
生产画面;V1-V30 每个切片必须从正常 `runledger` 看到真实增量。每个 V 切片先编写能暴露
缺口的 RED test 并记录预期失败,随后完成实现与 GREEN;不得提交失败测试。P4/P5 或 P6/P7
可在一个 V 切片内按既定子顺序连续关门,但不得倒置其内部合同。

### P0 基线冻结与合同测试

目标:把现有可观察行为冻结,防止结构拆分期间悄悄丢功能。

任务:

1. 为当前 command 清单、parse、idle/running gate 建 baseline tests;
2. 为目标 canonical input route 与 QueryGuard 缺口建立命名明确的 `it.todo`/受控 RED;
3. 为 CLI `--resume` picker 的 loading/select/cancel、legacy/v3 row 建 baseline tests;
4. 为 replay/live user、assistant、tool、queue 顺序建立 parity fixture;
5. 固定 60/80/143 列 render snapshot 与 Ctrl+C/Ctrl+D/overlay focus 行为;
6. 记录当前已知不正确行为,测试使用 `it.todo` 或显式 RED,不把错误固化为新合同;
7. 同步 `01`-`07` 中会误导实现的 pre-production 描述,标明历史属性。

退出门禁:

- baseline fixture 能同时驱动 replay 与 live;
- command/session 缺口有明确 RED 测试名;
- 不修改生产行为;
- `npm run check` 与 `npm test` 通过,预期 RED 用 `it.todo` 或单独受控命令证明。

### P1 Canonical TUI action/state/result

目标:建立不依赖 pi-tui 的领域与状态归约层。

预期文件:

- `src/tui/application/types.ts`
- `src/tui/application/reducer.ts`
- `src/tui/application/effects.ts`
- `src/tui/application/effect-runner.ts`
- `scripts/check-tui-boundaries.ts`
- `tests/tui/application-reducer.test.ts`
- `tests/tui/module-boundaries.test.ts`

任务:

1. 定义 `TuiAction/TuiEffect/TuiResult`;
2. 定义 `Loadable`、QueryGuard、query/command/session/tool lifecycle union;
3. 定义 stable row ID 与 correlation ID;
4. reducer 只返回 state/effect,不得调用 terminal、fs、controller;
5. 实现唯一 `EffectRunner`,只执行 effect 并返回 correlated `TuiResult`;
6. 对 duplicate、late、success/error/cancelled/aborted/stale result 与 QueryGuard
   `finally` release 写纯单测;
7. 增加 TUI dependency-boundary checker 并接入 `npm run check`:components 只能依赖
   presentation types/theme/pi-tui,reducer/projector 禁止 fs/network/terminal/controller,
   coordinator 只经 port 做 IO,adapter 不反向依赖 component,runtime/storage 不依赖 TUI。

退出门禁:

- reducer deterministic,同一 reducer input log(`TuiAction + TuiResult`)重放得到相同 state;
- effect completion 必须有 request/correlation ID;
- runner 不能直接 mutation state/component,重试和 transition 下一阶段只能由 reducer 发 effect;
- 同一 call stack 双 submit 只能有一个获得 `dispatching` reservation;
- `npm run check` 会执行 TUI dependency-boundary checker,禁止边界有独立合同测试;
- component 与 storage/runtime 类型尚未耦合。

### P2 统一 Timeline 与 tool reducer

目标:先统一消息和 tool 状态,为 command echo/result 与 session preview 提供共同落点。

预期文件:

- `src/tui/timeline/types.ts`
- `src/tui/timeline/projector.ts`
- `src/tui/timeline/tool-reducer.ts`
- `src/tui/components/timeline.ts`

严格子顺序:

1. 定义 `TimelineState = { committedRows, activeRowsByCorrelationId, activeOrder }`;
2. static replay 直接产生 deterministic `committedRows`;
3. live user/assistant start 创建 active row,delta 只更新同 correlation ID;
4. `toolCallId` start 建立 `pending -> running`,update 写入有界 partial;
5. terminal end 归约 `succeeded/failed/cancelled/aborted`,final aggregate 覆盖 partial 后才 commit;
6. update-before-start 只为同 ID 创建 placeholder active row;orphan end 创建独立 finalized
   row;随后同 ID late start 只能补全该 row 的 kind/title/base fields,不得新建第二行或把
   terminal row 复活为 running;duplicate final 幂等忽略,乱序 end 不得 flush/覆盖无关
   active row;
7. 使用增量 decoder 处理跨 chunk UTF-8,记录 unknown tool、exit code、signal、timeout;
8. 对 orphan 与长期 pending 建 byte/row/time budget,超限产生明确 terminal/cleanup 结果;
9. 才接现有 `ToolCallComponent/BashExecutionComponent/DiffPreviewComponent`;
10. 用静态 preview fixture 验证复用 projector;lazy IO、取消和 stale guard 留到 P7。

退出门禁:

- replay 与等价 live event 产生相同 row 序列;
- final output 不与 partial 重复;
- 大输出有 byte/line budget 和截断标记;
- tool name 相同但 ID 不同不会串行;
- duplicate final 不生成第二行,update-before-start 不覆盖其它 active row;
- terminal-before-start -> late-start 仍只有一条 terminal row;
- failed/cancelled/aborted、exit code/signal/timeout 与 UTF-8 split 有测试;
- orphan 或永久 pending 不会无限占用内存;
- `InteractiveMode.handleEvent` 不再直接维护 tool component map。

### P3 App shell、overlay 与输入所有权

目标:拆出 `InteractiveMode` 的协调边界,但不新增 command/session 功能。

预期文件:

- `src/tui/application/interactive-shell.ts`
- `src/tui/application/event-adapter.ts`
- `src/tui/application/overlay-controller.ts`

任务:

1. `InteractiveMode` 仅装配、订阅、dispatch、schedule render、shutdown;
2. overlay controller 唯一拥有 focus/close/cancel;
3. terminal key ownership 固定为 modal -> overlay -> completion -> editor -> app key;
4. 显式 submit 严格走 `safety -> attachment -> bash -> slash -> ordinary prompt`;
5. completion accept 仅改 draft;所有 query-producing route 在 effect 前使用 P1 QueryGuard,
   effect-free immediate UI decision 不冒充 query reservation;
6. terminal/runtime callback 只 dispatch action;
7. root slot 按 §4.2 固定。

退出门禁:

- 现有 UI parity tests 全绿;
- `InteractiveMode` 不含 tool-specific、command-specific、session-storage-specific switch;
- overlay 打开时 Ctrl+C/Esc 不泄漏到 active turn;
- guard 非 idle、overlay 打开或 transition freeze 时 queue 不 drain;
- slash/bash/ordinary prompt 隔离,active-query `immediate/queue/reject` 有 reducer 测试;
- render 路径无异步与副作用。

### P4 Command registry、parser 与执行漏斗

目标:在无新 UI 前先消除 command 双真源。

预期文件:

- `src/tui/commands/types.ts`
- `src/tui/commands/registry.ts`
- `src/tui/commands/parser.ts`
- `src/tui/commands/builtins.ts`
- `src/tui/commands/executor.ts`
- `src/tui/commands/compatibility-port.ts`

任务:

1. 把现有 command 迁入单一 registry;
2. catalog 同时提供 order、description、args、availability、history/active-query policy;
3. parser 输出 typed invocation,alias 归一为 canonical name;
4. executor 先按当前 generation/availability/AppState 完成 stale/idle/queue/reject/immediate
   arbitration;
5. handler 只返回纯 `CommandDecision`,reducer 映射 synchronous terminal 或 effect;
6. reserve 后在当前 `AppState` 上重新验证 catalog generation 与 availability;
7. IO 只由 P1 `EffectRunner` 经 port 执行,异步结果回流 `TuiResult`;
8. idle/running/side/unsupported 状态由 availability resolver 统一决定;
9. registry generation 更新先于 completion snapshot;
10. 为尚未完成独立 V 切片迁移的现有 command 建立受限 compatibility bridge:
    metadata、availability 与 invocation 仍只来自 canonical registry,handler 只产生带
    correlation ID 的 compatibility effect,具体旧行为由注入的 port 执行;
11. compatibility bridge 不得接入任何新 session mutation,不得在 `InteractiveMode`
    保留第二份 command 数组或 submit switch,并须在 V30 前清零。

退出门禁:

- `openSlashCommands()` 与 `handleSubmit()` 不再各有命令清单/switch;
- duplicate canonical name/alias 注册失败;
- unknown/invalid args/disabled reason 有单测;
- palette 旧 generation 或打开后 availability 变化时执行 fail closed;
- handler 直接访问 controller/storage/terminal 在类型和合同测试上不可行;
- compatibility command 也必须经 registry -> pure decision -> EffectRunner -> correlated
  result,不得成为第二执行漏斗;
- running+queue/reject 不调用 handler/effect;immediate 只能产生 effect-free ephemeral decision;
- immediate stale/hidden/disabled 时不调用 handler;
- synchronous decision 与 async terminal result 都能正确释放自己的 guard 状态;
- 普通 Enter 与程序注入调用同一 execution funnel。

### P5 Command palette、suggestion 与 timeline 闭环

目标:在 P4 真源上构建展示。

任务:

1. palette/filter/group 只消费 registry snapshot;
2. suggestion accept 只编辑 draft;再次 Enter 才执行;
3. command invocation 写入 typed timeline row;
4. lifecycle 显示 pending/running/succeeded/failed/cancelled/aborted;
5. async effect 通过 correlation ID 更新原 row;
6. secret args redaction、窄终端 wrapping、focus restore;
7. 按 `historyPolicy` 验证 ephemeral/session/audit replay 行为;
8. LoadedResources 的 slash count 从 registry 得到;
9. generic command row 能承接 compatibility result;每个后续单命令 V 切片必须把该命令
   从 compatibility bridge 迁到最终 port/decision/projector,并补齐自己的 lifecycle 证明。

退出门禁:

- command catalog、palette、parser、executor 数量一致;
- disabled command 可见时必须显示原因且不可执行;
- 已迁移 command 的 async result 不生成孤立通用 `[note]`;compatibility command 的既有
  notice 只能作为有界过渡,不得脱离 correlated command row;
- `session/audit` command echo/result 可按策略 replay,ephemeral UI command 不污染 transcript;
- 持有 reservation 的 success/error/cancelled/aborted 都释放 QueryGuard 并按门禁 drain queue;
- registry/palette/parser/executor 包含同一完整 command 集合,未迁移项只能以显式
  compatibility execution strategy 存在;
- 60/80/143 列 snapshot 通过。

### P6 Session catalog 与 normalized read-model

目标:先在 UI 外建立可信 session summary/detail 服务。

预期文件:

- `src/tui/sessions/types.ts`
- `src/tui/sessions/catalog.ts`
- `src/tui/sessions/local-catalog-adapter.ts`
- `src/tui/sessions/projector.ts`

任务:

1. 定义 `SessionCatalogPort.listLite/enrich/loadFullPreview`;
2. adapter 组合 `SessionManager.list`、version fence、v3 publication/lifecycle inspection;
3. legacy/v3 归一成 §6.1 summary,不抹平 compatibility;
4. `listLite` 不加载 transcript,也不为 title fallback 扫首条 prompt;
5. `enrich` 只补 selected detail,`loadFullPreview` 才有界解码 transcript;
6. list/enrich/preview 使用独立 correlation lane、并发上限、requestId/cancel;
7. 修正无法验证的 cwd/title/count,以 unknown/undefined 表达;
8. corrupted/staging/unpublished/lock conflict 有显式错误。

退出门禁:

- components 不 import `SessionManager`/`V3SessionManager`;
- 列表对 v1/v2/v3/corrupt/staging fixture 有合同测试;
- lite list 不读取所有 message 行;
- enrich 不解码 full transcript,preview 不复用 list/enrich requestId;
- stale response 被丢弃,不作为 session row 的 `stale` 状态显示;
- 此阶段没有 resume/fork mutation。

### P7 Session picker 与 lazy preview

目标:先实现只读 browser,再开放动作。

预期文件:

- `src/tui/components/session-picker.ts`
- `src/tui/components/session-detail.ts`
- `src/tui/sessions/picker-reducer.ts`

严格子顺序:

1. 先实现 picker reducer、generation 与 list/enrich/preview 三条 stale guard;
2. open -> loading;
3. loaded -> ready/empty/error/retry;
4. basic row + selection;
5. ID/title filter,新搜索先递增 generation 再发 `listLite`;
6. selected row `enrich`,使用独立 requestId;
7. selected row `loadFullPreview`,使用独立 requestId 并复用 Timeline;
8. close 先使三条 lane 全部失效,再取消 effect/销毁 overlay;
9. startup `--resume` 与主 TUI 只共用 read-model、component 与 typed selection。

退出门禁:

- picker Enter 只返回 `SessionIntent`;
- preview 失败不关闭 picker、不污染主 timeline;
- 初载性能与 session 数量近似线性于 summary,不线性于 transcript 总字节;
- 当前 session、legacy read-only、corrupted 状态可辨认;
- selection/search/close 后旧 list/enrich/preview result 都无法归约;
- startup selection 在此阶段不执行 controller/handle replacement,transition 留到 P8/P9;
- 尚未注册可执行 `/resume`、`/fork`。

### P8 Session host 与 resume coordinator

目标:在 picker 外完成受治理 session replacement。TUI coordinator 只推进 canonical
state/effect,不持有 writer authority。

预期文件:

- `src/tui/sessions/control-port.ts`
- `src/tui/sessions/session-host.ts`
- `src/tui/sessions/transition-coordinator.ts`
- `tests/tui/session-transition.test.ts`

任务:

1. 定义返回 `SessionBootstrap`、effect certainty、recovery 状态的 `SessionControlPort`;
2. CLI/application composition 持有 host,`InteractiveMode` 不持有 manager;
3. 按 §6.3 完成 inspect/confirm/freeze/revalidate/quiesce/Control Plane resume;
4. 每种 v3 mutation 遵守 operation-specific handle/revision 合同:quiesce 使用 current
   handle/revision;`session:resume` 的 handle/turn 必须为 null,可选 revision 只绑定 target;
5. registry 返回后只经 `applySessionBootstrap()` attach/replay/update/unfreeze;
6. legacy 明确 read-only/migration-required;
7. candidate/prepare/fencing/activation/authority swap/old-runtime drain/UI replay 失败分别测试
   rollback 或 recovery-required;
8. shutdown lifecycle 与 writer close 只执行一次,且只由 authority owner 执行。

退出门禁:

- 明确的 pre-activation failure 且旧 runtime 仍 active 时可恢复 prompt/draft;
- active turn 未确认时不 interrupt/切换;
- stale handle/revision fail closed;
- replay 只出现一次且结束前输入冻结;
- replacement 后旧 subscription 不再更新 UI;
- TUI 没有 manager prepare/close、writer release 或 candidate open 调用;
- uncertain、recovery-required、post-authority UI failure 不解除冻结或复活旧 writer;
- real lock/close fixture 无资源泄漏。

### P9 Session command 与动作展示

目标:只在 P8 事务稳定后开放用户入口。

任务:

1. 在 P4 registry 注册 `/session`、`/sessions`、`/resume`、`/new`;
2. command 与 picker action 只产生相同 `SessionIntent`;
3. capability 决定可用性与 disabled reason;
4. transition timeline row 显示 inspecting/confirming/frozen/quiescing/dispatching/replaying/
   succeeded/failed/recovery-required;
5. 成功后更新 header/footer/current-session badge;
6. 直接 ID、in-app picker 与 startup picker selection 共用 resolver/coordinator;
7. 增加 real PTY resume 证明,作为 P10 的硬前置。

退出门禁:

- command、picker、CLI startup 三入口使用同一 summary/intent/transition 合同;
- `/resume` 不能绕过 P8;
- legacy/corrupted/locked/active-turn 情况有明确结果;
- resume PTY 证明单次 replay、draft freeze/restore 与后续 prompt 写入 target;
- session ID/路径不在普通 row 过度泄露,完整路径只在详情中显示。

### P10 Fork lineage

目标:在 resume 稳定后实现受治理 fork。

任务:

1. 注册 `/fork`,参数只表达目标 goal mode/可选 prompt,不自行操作文件;
2. 仅在 P8 全部门禁与 P9 real PTY resume 通过后按 §6.4 dispatch `session:fork`;
3. 实现 confirm -> reserve/freeze -> revalidate -> quiesce -> final cursor/revision bind;
4. `session:fork` 携带 exact parent expected revision/cursor,且 `expectedTurnId = null`;
5. Control Plane 内完成 gate/receipt revalidation、staged child、durable publish 与 registry
   authority replacement;
6. 成功后直接消费 child bootstrap 并复用 `applySessionBootstrap()`,不得再发 resume;
7. 更新 UI/lineage receipt 后才 unfreeze/恢复 eligible draft;
8. publish 前、publish 后切换前、authority 切换后三类失败分别测试;
9. legacy 显示显式 fork-to-v3 指引。

退出门禁:

- parent cursor、child identity、lineage 可审计;
- publish 前 UI identity 不变;
- publish 前失败不损坏父 session;
- publish 后但未切 authority 的 child 仍可发现并可由后续 `/resume` 恢复;
- 只有 Control Plane 确认父 authority active 的确定失败才解除冻结;
- authority 切换后失败保持 child authority 与输入冻结,不复活父 writer;
- fork 成功 replay 一次,后续 prompt 写入 child;
- 不存在第二套 attach/replay 逻辑或第二次 `session:resume`。

### P11 其余展示面归一

目标:在 command/session 主骨架稳定后迁移其它内容。

严格顺序:

1. queue read-model 与 cancel receipt;
2. approval request/decision/recovery-required;
3. task/goal 状态;
4. extension resource generation;
5. activity/context/footer;
6. header/loaded-resources 去重;
7. 才做 grouping、collapse、search 与性能调优。

退出门禁:

- 每个展示面都有 canonical source、typed row、loading/error 状态;
- queue/approval mutation 经过 Control Plane;
- footer `render()` 只读同步 snapshot;
- 不再用通用 `CustomMessageComponent` 承担有状态业务对象。

### P12 PTY、故障矩阵与文档收口

任务:

1. unit:registry/reducer/projector/capability/transition;
2. integration:CLI host + controller + v2/v3 fixtures;
3. PTY:`/commands`、command error、`/sessions`、resume、fork、Ctrl+C、Ctrl+D;
4. replay:历史只出现一次,live 继续追加;
5. command/input fault:旧 catalog generation、availability drift、double submit、effect timeout、
   queue/reject 不调用 handler、immediate 无 effect、四类 terminal release 与 overlay 阻止
   queue drain;
6. tool fault:update-before-start、duplicate final、UTF-8 split、unknown tool、exit code/signal/
   timeout、orphan/pending bounded cleanup;
7. session fault:三条 stale lane、target lock、corrupt JSONL、pre-publish failure、post-publish
   pre-authority failure、post-authority UI replay failure、writer drain failure、terminal resize;
8. 60/80/143 列、CJK、长 ID、长 cwd、ANSI、超长 tool output;
9. 同步 `00`-`09` 与 `AGENTS.md` 的当前事实,保留历史计划属性;
10. 运行完整验证链。

退出门禁:

```text
npm run check
npm test
npm run build
npm link
runledger --version
runledger --help
real PTY: runledger -> /commands -> /sessions -> resume/fork smoke
```

### V0-V30 可见切片

V 切片固定为实际实现与提交顺序:

| V | 依赖/关闭门禁 | 正常 TUI 可见结果 |
|---|---|---|
| V0 | P0 | 刷新当前 HEAD baseline、fixture 与 RED 名称;不修改生产行为,是可见规则的唯一前置例外 |
| V1 | 关闭 P1 | 建立 canonical action/result/effect/reducer/runner;`ContextHeader` 显示真实 workspace、session identity 与 lifecycle snapshot |
| V2 | 关闭 P2 | live 与 startup replay 经同一 Timeline/tool reducer 展示,等价事件产生相同行序列 |
| V3 | 关闭 P3 | root shell、overlay 与输入所有权落地;`ActiveState` 显示 running、queue、freeze/recovery 状态 |
| V4 | 关闭 P4 与 P5 framework | `/help` 与 `/commands` 使用单一 registry/palette/executor;现有未迁移命令进入受限 compatibility bridge |
| V5 | 打开 P6/P7 read-only track | `/sessions` 显示 `listLite` loading/ready/empty/error、基础行、filter 与 selection,不执行 mutation |
| V6 | P5 command slice | `/clear` 完成最终 decision、history policy 与 correlated lifecycle 展示 |
| V7 | P6/P7 | `/sessions` 选中项经独立 lane `enrich`,显示 detail loading/error/metadata |
| V8 | P5 + P6 | `/session` 显示当前 session 的 canonical detail,不从 footer/component 猜测 |
| V9 | P7 | `/sessions` 选中项经第三条 lane `loadFullPreview`,复用主 Timeline |
| V10 | P5 command slice | `/provider` 完成最终 availability、selector/effect/result 与 timeline 展示 |
| V11 | 关闭 P6/P7 | session row/detail 显示 v1/v2/v3、lifecycle、compatibility、lineage、locked/corrupt/staging 状态 |
| V12 | P5 command slice | `/login` 完成 provider/auth flow、取消/失败/redaction 与 timeline 展示 |
| V13 | 打开 P8 | session action/transition row 显示真实 capability、inspect、confirm、frozen 与 recovery-required;尚不 dispatch resume |
| V14 | P5 command slice | `/logout` 完成 capability、credential removal result 与 timeline 展示 |
| V15 | 关闭 P8/P9 | `/resume` 完成 governed replacement、单次 bootstrap replay、draft freeze/restore 与 real PTY |
| V16 | P5 command slice | `/model` 完成 selector、availability、selection result 与 footer/header 同步 |
| V17 | P8/P9 | `/new` 通过受治理 session control intent 创建并 attach 新 session |
| V18 | P5 command slice | `/thinking` 完成 selector、availability、selection result 与 footer 同步 |
| V19 | 关闭 P10 | `/fork` 在 V15 PTY 通过后完成 durable child、authority replacement、lineage receipt 与单次 bootstrap replay |
| V20 | P11 command/resource slice | `/plugins` 使用 extension generation,显示 ready/blocked/error/disabled 与 typed result |
| V21 | P11 command/resource slice | `/skills` 使用同一 generation/read-model,显示 activation 与 diagnostic |
| V22 | P11 command/resource slice | `/hooks` 显示 source、enabled、trust、activation 与 diagnostic |
| V23 | P11 command/resource slice | `/mcp` 显示 server/tool/login 状态与 governed action result |
| V24 | P11 command/resource slice | `/reload-extensions` 显示 idle gate、generation replacement、失败或 stale receipt |
| V25 | P11 | queue read-model、隔离 item kind 与 cancel receipt 进入 `ActiveState`/Timeline |
| V26 | P11 | approval request/decision/recovery-required 使用 typed row,不再走通用 notice |
| V27 | P11 | task/goal lifecycle 使用 canonical projection,含 loading/empty/error |
| V28 | 关闭 P11 | extension counts、activity、context、Footer、Header 与 LoadedResources 去重并只读同步 snapshot |
| V29 | P5 command slice | `/prompt` 从 compatibility bridge 迁出,保持现有 prompt selector 能力与 typed result |
| V30 | P5 command slice | `/quit` 从 compatibility bridge 迁出,统一 shutdown;bridge 数量必须归零 |

`/help` 与 `/commands` 是唯一允许合并的 alias/同入口切片。其余 command 每个 V 切片只完成
一个 canonical command;session detail/preview/transition 等组件切片与 command 切片按上表交替。
V13 只开放真实 capability 与 transition projection,不是可点击的假 resume;V15 前任何
resume mutation 都必须 fail closed。新 `/sessions`、`/session`、`/resume`、`/new`、`/fork`
从创建起直接使用最终 port/decision,不得经过 compatibility bridge。

### 每个 V 切片的退出合同

V1-V30 必须同时满足:

1. 正常入口:运行构建后的 `runledger`,不使用 demo/debug/showcase 专用产品入口;自动 PTY
   可把 `RUNLEDGER_DIR`/session dir 指向临时 fixture,但启动的仍是标准 bin;
2. 真实纵向闭环:本切片同时包含所需 port、纯 reducer/decision、effect/result、projection
   与 component 接线,不存在只画 UI 或 component 直接 IO;
3. 可见结果:在文档记录精确按键/命令、前置 fixture、预期 loading/ready/error/disabled/
   recovery 画面;条件性不可用能力显示真实 disabled reason;
4. Agent 证明:目标 unit/contract test、TUI boundary check、`npm run check`、`npm test`、
   `npm run build` 与标准 bin PTY 通过,审查输出包含精确 `file:line` blocker;
5. 人工证明:人工打开正常 TUI,核对信息真源、操作顺序、focus、隐私以及适用的
   60/80/143 列布局;
6. 提交边界:一个 V 切片一个 commit,只暂存该切片显式路径;失败测试、未完成 bridge
   迁移或缺失人工/Agent 证据时不得进入下一个 V 切片。

每次实施在本文维护以下证据表;`状态` 只允许
`not-started/in-progress/agent-verified/human-verified/closed`:

| V | P 门禁 | 正常 TUI 入口与预期效果 | Agent 证据 | 人工证据 | 状态 |
|---|---|---|---|---|---|
| V0 | P0 | 待实施时填写 | 待填写 | 不适用 | not-started |
| V1-V30 | 见上表 | 各切片实施时逐行展开,不得整段批量标记 | 待填写 | 待填写 | not-started |

## 8. 预期目录边界

文件名可在实现时微调,但职责不可重新合并进 `InteractiveMode`:

```text
src/tui/
├── interactive-mode.ts
├── application/
│   ├── types.ts
│   ├── reducer.ts
│   ├── effects.ts
│   ├── effect-runner.ts
│   ├── event-adapter.ts
│   ├── interactive-shell.ts
│   └── overlay-controller.ts
├── commands/
│   ├── types.ts
│   ├── registry.ts
│   ├── parser.ts
│   ├── builtins.ts
│   ├── executor.ts
│   └── compatibility-port.ts
├── sessions/
│   ├── types.ts
│   ├── catalog.ts
│   ├── local-catalog-adapter.ts
│   ├── projector.ts
│   ├── picker-reducer.ts
│   ├── control-port.ts
│   ├── session-host.ts
│   └── transition-coordinator.ts
├── timeline/
│   ├── types.ts
│   ├── projector.ts
│   └── tool-reducer.ts
└── components/
    ├── context-header.ts
    ├── timeline.ts
    ├── active-state.ts
    ├── command-palette.ts
    ├── command-message.ts
    ├── session-picker.ts
    ├── session-detail.ts
    └── session-transition.ts
```

`scripts/check-tui-boundaries.ts` 与 `tests/tui/module-boundaries.test.ts` 固化上述依赖方向,
并由 `npm run check` 执行。

依赖方向固定:

```text
components -> presentation types
application -> command/session/timeline ports and reducers
adapters -> runtime/storage/control-plane
```

禁止反向依赖:

- `components -> SessionManager/V3SessionManager`;
- `components -> InteractiveSessionController`;
- `render -> application effect`;
- `commands -> concrete pi-tui component`;
- `storage/runtime -> src/tui`.

## 9. 硬性禁止倒置

1. 不得先画 command palette,再补 registry/availability/parser;
2. 不得让 completion accept 直接执行 command;
3. 不得保留 selector 数组与 handler switch 两份 command 真源;
4. 不得让 command handler、coordinator 或 component 绕过唯一 `EffectRunner` 做 IO;
5. 不得相信 palette 打开时的旧 generation/availability snapshot 执行 command;
6. 不得先画 session picker,再补 list/loading/error/cancel/stale 合同;
7. 不得让 session row 或 selector 直接调用 `SessionManager`;
8. 不得让 list/enrich/preview 共用 request lane 或把 stale response 显示成 row 状态;
9. 不得在 P8 全部门禁和 P9 resume PTY 通过前实现 P10 fork;
10. 不得由 TUI prepare/close manager、释放 writer lease 或打开 candidate runtime;
11. 不得在 child durable publish 前切换 session identity;
12. 不得删除已经 durable publish 的 child;
13. 不得在 `session:fork` 成功后再发送一次 `session:resume`;
14. 不得为 live、replay、preview 各建一套 message/tool renderer;
15. 不得让 transport event 直接 mutation 组件;
16. 不得把当前 cwd、当前 model 或未知 count 伪造成历史 session 事实;
17. 不得把 legacy session 静默升级为可写;
18. 不得把 read-only preview/preflight 当作 authoritative replay;
19. 不得在 core replay 完成前做次级 metadata 补水、发送 initial prompt 或允许 fork;
20. 不得在 mutation failure 后显示普通 success notice;
21. 不得在 TUI 第一轮完善中加入 delete、remote session、foreign session、动画、voice、
    media、billing、dashboard 或 subagent-fork 语义;
22. 不得把 demo/debug/showcase 画面当作 V 切片的正常 TUI 可见证明;
23. 不得只接 component 再把 port/reducer/effect 留到后续 V 切片;
24. 不得让新 session command 或 mutation 进入 compatibility bridge;
25. 不得在 V30 后保留 compatibility command、第二份 command switch 或旧 notice 漏斗。

## 10. 验收矩阵

| 维度 | 最小证明 |
|---|---|
| Command 真源 | catalog/palette/parser/executor 集合一致;alias/duplicate/disabled 测试 |
| Input/QueryGuard | safety→attachment→bash→slash→prompt;idle/queue/reject/immediate;同步 reserve;四类终态 release;受门禁 drain |
| Command lifecycle | pending/running/succeeded/failed/cancelled/aborted;旧 generation fail closed;late result 不串行 |
| Tool lifecycle | pending/running/succeeded/failed/cancelled/aborted;update-before-start/duplicate/out-of-order/UTF-8;final 覆盖 partial;有界 cleanup |
| Session list | v1/v2/v3/corrupt/staging/empty/error;`listLite` 不读 transcript |
| Detail/Preview | `enrich`/`loadFullPreview` 独立 lane、取消/stale、preview 复用 Timeline |
| Resume | active-turn confirm、registry replacement saga、certainty/recovery、`applySessionBootstrap()` 单次 replay |
| Fork | exact parent cursor、durable child publish、无二次 resume、三类失败;post-publish child 仍可发现/resume |
| Security | secret args redaction、普通 row 不显示完整敏感路径/credential |
| Resource | subscription、writer lease、target staging、terminal shutdown 无泄漏 |
| Rendering | 60/80/143 列,CJK/ANSI/long cwd/long ID/large output |
| Terminal | overlay focus、Esc/Ctrl+C/Ctrl+D、resize、IME draft 不丢 |
| Layer boundary | dependency checker 禁止 component→IO、reducer→副作用、adapter→component 与 runtime/storage→TUI |
| Visible slice | V1-V30 均有标准 `runledger` 操作路径、预期 frame、Agent 证明与人工证明 |
| Migration | 每个 command 独立 V 切片;compatibility bridge 只减不增并在 V30 归零 |
| Documentation | `00-overview.md` 与 `development-doc/00-index.md` 指向本文 |

## 11. 提交、回退与工作区边界

- P0-P12 是门禁而不是 commit 单位;V0-V30 每个切片独立 commit,commit 只覆盖该切片声明的
  显式路径;
- 每个 V 切片先在工作区运行 RED test 并记录预期失败,再实现到 GREEN 后提交;所有 commit 时
  `npm run check` 与 `npm test` 必须通过,不得提交失败测试;
- 除表中明确的纵向交替点外,一个 V 切片不得同时迁移两个 command;`/help` 与 `/commands`
  是唯一同入口例外;
- 不使用 `git add .`、无路径 `git add -A`、`git commit -a` 或 `--no-verify`;
- 回退单位是完整 V 切片;P4 command registry、P6 session catalog、P8 session transition
  均保留 feature seam,回退时恢复旧入口但不删除 durable session 数据;
- P8/P10 任何 uncertain outcome 一律进入 recovery-required,不得自动重试 mutation;
- 当前主工作区未跟踪的 `CLAUDE.md` 属于范围外文件,实施本计划时不得修改、暂存或删除。

## 12. 完成定义

本计划完成必须同时满足:

- `InteractiveMode` 不再持有 command catalog/dispatch、tool reducer 或 session storage 操作;
- reducer + 唯一 `EffectRunner` 形成完整副作用闭环,component/handler 不直接做 IO;
- canonical input route 与 QueryGuard 的 reserve/release/drain 门禁有测试;
- command metadata、completion、execution、timeline result 各有明确合同且共用唯一 registry;
- startup 与 in-app session picker 共用三段 `SessionCatalogPort`、projection、component 和
  typed selection;
- `/resume` 只通过 Control Plane/`SessionRuntimeRegistry`,然后消费 bootstrap 并调用
  `applySessionBootstrap()`;确定的 pre-activation failure 才可恢复旧输入;
- `/fork` 由 Control Plane 先 durable publish 并完成 authority replacement,随后只复用
  `applySessionBootstrap()`,不二次 resume;
- live、replay、preview 共用 Timeline;
- legacy/v3、loading/error/stale-cache/recovery-required 能真实显示,stale response 能确定丢弃;
- V1-V30 都有正常 `runledger` 可见增量、Agent 证明、人工证明与独立 commit;
- 每个 command 已按独立 V 切片完成,compatibility bridge、旧 command switch 与未关联
  notice 漏斗全部归零;
- 完整验证链与 PTY 证据通过;
- `00`-`09` 历史规格已与当前事实边界对齐。
