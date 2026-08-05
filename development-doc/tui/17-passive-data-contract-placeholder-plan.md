# RunLedger TUI 被动数据合同占位构建计划

> **状态:** `agent-verified`
>
> **编号与权威边界:** 目标仓库已有 `17-opentui-refactor-plan.md`，它继续拥有 pi-tui → OpenTUI renderer 迁移的唯一权威。本文件是迁移进来的被动数据合同配套计划，不替换 Plan 17；`18-opentui-streaming-performance-ux-plan.md` 继续只负责迁移后的流式性能、长会话与交互体验。
>
> **计划存放仓库:**
> `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger`
> `rollback/pre-governed-agent-harness-runtime@70b13299b96d6f4e9a1b977045e6149825196f0a`
>
> **迁移来源:**
> `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-agent-loop-resurrect/development-doc/tui/17-passive-data-contract-placeholder-plan.md`
> `feat/agent-loop-resurrect@98e1449`
>
> **创建日期:** 2026-08-05
>
> **范围:** 参考固定基线 `src/tui/` 已验证过的状态分层，为目标仓库建立
> framework-neutral、只含类型/只读视图/状态联合/request-result envelope 的
> 数据结构占位；不移植 reducer、EffectRunner、controller adapter、组件、IO、
> persistence 或生产接线。
>
> **权威状态表:** 本文 §12。本轮已按 P0 → P6 实际建立合同、测试和 type-only 出口；
> 状态表只记录本 checkout 的 agent-verified 证据，不把参考分支的完成状态复制过来。

## 0. 结论与实施原则

目标仓库当前已经有 OpenTUI 生产运行层、`AgentEvent -> TuiEvent` 适配、命令式
`InteractiveMode` 和 managed process overlay；它缺少的是一套可供后续 reducer、
projection 和组件共同消费的稳定数据边界。参考分支已经证明以下分层可行：

```text
Runtime / Storage canonical facts
              |
              v
bounded query/result envelope
              |
              v
framework-neutral TUI state + Timeline + safe presentation views
              |
              v
reducer / projector / EffectRunner / OpenTUI renderables
```

本计划只建立中间两层的“形”，不提前建立下两层的“行为”。实施必须遵守：

1. Runtime、Session、Security、Queue、Approval、Goal、Agent、Process 的事实仍由各自
   canonical Runtime contract 拥有；TUI 不另建 authority。
2. TUI 合同不 import `@opentui/core`、`@earendil-works/pi-tui`、Node IO、storage
   adapter、shell 或 network；它们必须可在无 terminal 环境中 typecheck。
3. 目标仓库只接受当前 canonical session format。参考分支中的旧代际 session format、legacy
   replay reader 和 compatibility bridge 不进入本计划。
4. 不新增任何 feature/rollout/compatibility flag。`available/unavailable` 只能表达某个
   注入 port 的当前事实，不能决定功能是否存在，也不能切回旧生产路径。
5. 缺少 Runtime authority 时必须显式表达 `unknown`/`unavailable`，不得用空数组、0、
   mock、allow-all 或本地猜测伪装为已加载事实。
6. 所有从 Runtime/tool details 进入 Timeline 的正文先变成已脱敏、已限界的 safe view；
   raw args、credential、环境变量、base64、完整 before/after 和未验证 patch 不进入
   `TuiState`。
7. 占位阶段不修改当前 `InteractiveMode` 的可见行为，不改变 CLI、session replay、
   renderer lifecycle 或现有 process overlay。

## 1. 固定基线事实

### 1.1 参考分支提供的结构

固定参考 `98e1449` 的 `src/tui/` 已形成以下数据结构族：

- `application/types.ts`：`Loadable`、`QueryGuard`、command execution、overlay、
  capability snapshot、聚合 `TuiState`、`TuiAction`、`TuiEffect`、`TuiResult`；
- `timeline/types.ts`：稳定 row id、display order、active/committed row、message/tool/
  notice/goal/queue/agent row 与 live event；
- `presentation/types.ts`：bootstrap/session strip/activity/footer/composer/welcome 的
  framework-neutral view；
- `presentation/tools/types.ts`：safe input/result/diff/media/shell/usage/presentation；
- `sessions`、`providers`、`auth`、`models`、`thinking`、`prompts`、`keymap`：选择器与
  workflow state；
- `queue`、`approval`、`task-goal`、`goal-plan`、`agents`、`managed-process`、
  `extensions`、`runtime-snapshot`、`security-mode`、`shutdown`：correlated request、
  result envelope、只读 snapshot 与 workflow state。

这些结构是设计输入，不是复制清单。参考分支仍使用 pi-tui，目标仓库生产 TUI 已迁移到
OpenTUI；数据合同必须与 terminal framework 解耦。

### 1.2 目标仓库当前事实（2026-08-05 live snapshot）

目标 checkout 当前为 `rollback/pre-governed-agent-harness-runtime@70b13299b96d6f4e9a1b977045e6149825196f0a`。
文档迁移开始时的 Runtime Host/Context assembly 改动已经在迁移期间由既有批次提交为
`5035b9a`；后续 Host/model-routing 批次已由既有 HEAD `70b1329` 承载。上述提交都不是
本计划的实现证据，也不属于本计划的显式 staging 范围。合同实施只在本计划边界内新增
`src/tui/application/`、presentation/timeline/domain type 文件、process passive type、
contract tests 和 type-only barrel；既有文档路由、Plan 18 与 Runtime/CLI 改动均保留。

当前 TUI 事实为：

- `src/tui/types.ts` 已拥有 `TuiEvent`、`adaptAgentEvent()`、`BaseComponentProps` 和
  `FooterSnapshotProvider`；
- `src/tui/presentation.ts` 仍是 text/markdown/select/input 四种 `PresentationBlock` 的
  framework-neutral 基础块；
- `src/tui/process/types.ts` 已拥有 OpenTUI managed-process overlay 的
  list/detail/terminal render state，并与现有 process adapter 配套；
- `src/tui/interactive-mode.ts` 仍是现有命令式交互编排入口，直接维护 streaming、tool
  component map、model、thinking、overlay 等可变运行字段；
- `src/tui/opentui/` 已包含 Plan 17 renderer/runtime 与 Plan 18 局部性能模块，包括
  timeline store、delta coalescer、frame scheduler、render cache、viewport window 和
  performance observer；这些是现有 renderer/performance 行为，不是本计划要复制或改写的
  passive contract；
- `src/tui/index.ts` 已有既存 runtime/component/process API 导出。本计划新增合同时只允许
  增加 `export type`，不得删改既存出口或借此扩大 package public API；
- `package.json` 当前使用 `@opentui/core@0.4.5`。参考分支的领域类型和行为文件仍只是设计
  输入，不能按文件数量整体搬运到当前 checkout。

后续实施每个 phase 仍必须重新核对工作区，不得把上述既有改动视为本计划的交付依赖，也
不得将其带入本计划的显式路径 staging。

### 1.3 OpenTUI 约束

本计划采用 OpenTUI 当前边界，而不是复刻 pi-tui 对象：

- renderer/root/focus/input/resize/destroy 属于 runtime owner，不进入可序列化状态；
- responsive layout 只消费 width/height/density projection，不把 Renderable 放进 state；
- keyboard event 先归一化为 TUI action，再进入状态层；raw terminal sequence 仅在有界
  keymap debug view 中短暂存在；
- 后续渲染测试使用 `@opentui/core/testing#createTestRenderer()`，并在 `finally` 中
  destroy renderer；本次纯数据结构阶段不新增 renderer 测试。

## 2. 数据分类与所有权

| 类别 | 代表数据 | 生命周期 | authority / persistence |
|---|---|---|---|
| Canonical 引用 | session/runtime/agent/tool/process id、event cursor、digest、revision | 跨请求 | 由 Runtime 类型拥有；TUI 只 import/type alias |
| Bounded snapshot | session summary、queue snapshot、approval item、runtime snapshot | 单次 query revision | Runtime/adapter 产生；TUI 只读 |
| Safe presentation | Timeline row、safe tool metadata、footer/session strip view | 可重建 | projector 产生；不得持久化为新事实 |
| Workflow state | idle/loading/ready/error、generation、correlation/effect id | overlay/workflow 生命周期 | TUI 内存态；退出即丢弃 |
| Interaction state | overlay、selection、search、composer、viewport、expanded | 当前 client 生命周期 | TUI 内存态；不写 ledger/session/settings |
| Runtime request/result | correlated request、typed result、uncertain/recovery-required | 一次 effect | port contract；adapter 后续实现 |
| Renderer object | renderer、renderable、focus owner、timer、AbortController | renderer 生命周期 | runtime owner；严禁进入上述合同 |

### 2.1 标识符规则

- 优先 import canonical opaque/branded id；不存在时先保留 `string` 字段并在字段名中编码
  语义，不在 TUI 内定义第二套 brand。
- 所有 mutation/query result 至少携带 `generation + correlationId + effectId`；需要
  compare-and-swap 的领域另带 authority/repository/queue/decision revision。
- digest 只能用于 identity、CAS 或审计关联；UI 默认显示有界 prefix，不显示完整
  credential-like value。
- 时间戳区分 wall-clock ISO 字符串与本地 animation monotonic number，不能混用。

### 2.2 状态联合规则

- 异步状态使用 discriminated union，不使用多个互相矛盾的 boolean。
- `error` 必须携带稳定 code/message/retryable；发生不确定 mutation 时另带
  `recoveryRequired: true`。
- `empty` 与 `unavailable` 分离：empty 是成功查询后的空结果，unavailable 是 authority
  或 port 不存在。
- `unknown` 与 0 分离：token、context window、tool count、agent count 未知时不能显示 0。
- stale result 由 generation/correlation/effect 三元组识别；占位合同先携带字段，丢弃
  逻辑留给后续 reducer。

## 3. 目标文件布局

占位实施沿用参考分支易于比对的领域路径，但不创建行为文件：

```text
src/tui/
├── types.ts                         # 保留现有 TuiEvent 适配，不塞入聚合状态
├── application/
│   ├── common.ts                    # Loadable、Result、correlation、terminal state
│   ├── state.ts                     # TuiState、capability/overlay/command record
│   ├── action.ts                    # 纯数据 action union
│   ├── effect.ts                    # 纯数据 effect union
│   ├── result.ts                    # 纯数据 result union
│   └── types.ts                     # type-only barrel
├── presentation/
│   ├── types.ts                     # bootstrap/session strip/activity/footer/composer
│   └── tools/types.ts               # safe tool/diff/media/shell/usage views
├── timeline/types.ts                # Timeline row/event/state/cursor
├── commands/types.ts                # intent/descriptor/decision metadata
├── sessions/types.ts                # current canonical session catalog/detail/preview/workflow state
├── providers/types.ts
├── auth/types.ts
├── models/types.ts
├── thinking/types.ts
├── prompts/types.ts
├── keymap/types.ts
├── queue/types.ts
├── approval/types.ts
├── task-goal/types.ts
├── goal-plan/types.ts
├── agents/types.ts
├── extensions/types.ts
├── runtime-snapshot/types.ts
├── security-mode/types.ts
├── shutdown/types.ts
├── workspace/types.ts
├── update/types.ts
└── process/types.ts                 # 扩展现有 overlay 类型，不建重复 managed-process 真源
```

明确不在本计划新建或重写：

```text
application/reducer.ts
application/effect-runner.ts
application/interactive-shell.ts
*/controller-adapter.ts
*/reducer.ts
*/projector.ts
commands/registry.ts
components/*
opentui/*                 # 已有 renderer/runtime 文件不改写
storage/*
runtime/*                 # 本计划不新增 TUI 行为 runtime；不影响现有 src/tui/runtime/ 出口
```

`src/tui/index.ts` 对本计划新增出口只允许 `export type`；既有 Plan 17/runtime/component
出口保持不变。不得因为占位而新增 runtime object factory、默认 adapter 或可执行 handler。

当前已有的 `src/tui/opentui/*`、`src/tui/process/*` 和其他 renderer/runtime 文件分别由
Plan 17/Plan 18 或现有 process authority 管理；本计划不在这些目录追加合同，也不通过重命名
或重构既有文件制造第二个 renderer/state authority。

## 4. Phase P0：合同清单与静态边界

### 4.1 任务

1. 在目标仓库重新记录 branch、HEAD、status、`package.json` 中 OpenTUI 版本和现有
   `src/tui/` 文件清单。
2. 生成一次参考到目标的领域映射，按“复用 / 改名 / 收窄 / 不移植”标记，不把文件数
   当作完成度。
3. 固定 forbidden import 边界：合同目录不得 import OpenTUI/pi-tui、Node builtin、
   `src/storage`、ExecutionEnv、controller adapter。
4. 固定 current canonical session format 收窄：不解释旧代际 session、ledger 或 patch，旧内容不由 TUI
   contract 解释。
5. 为每个高级领域记录 Runtime authority 是否真实存在。不存在时只规划
   `unavailable` view，不创建假 adapter。

### 4.2 产物

- 一份位于本计划实施记录区的 mapping table；
- `tests/tui/contracts/import-boundary.test.ts` 或等价静态检查入口；
- 后续各 phase 使用的 explicit-path 变更清单。

### 4.3 门禁

- mapping 覆盖 §3 全部目标文件；
- forbidden import 检查先 RED，加入最小规则后 GREEN；
- 未修改生产 `InteractiveMode`、OpenTUI runtime 和 CLI composition。

### 4.4 P0 implementation mapping

本轮只建立下列被动合同文件边界；`reuse` 表示只复用 canonical type 的语义，
`narrow` 表示在 TUI 中改成安全、有界、只读视图，`new` 表示只新增 type-only
合同，`do-not-port` 表示参考分支的行为文件不进入目标仓库。

| 目标目录 | 处理 | authority / 说明 |
|---|---|---|
| `application/` | new | TUI 聚合协议；不创建 reducer、runner 或 adapter |
| `presentation/` | narrow | 只读、安全展示；保留既有 `PresentationBlock` |
| `timeline/` | new | 稳定行/事件合同；不实现 projection 或 coalescer |
| `commands/` | new | descriptor/intent/decision metadata；不创建 registry/parser |
| `sessions/` | narrow | 只接受 current canonical session format；不读旧代际或绝对路径 |
| `providers/` | reuse | provider/model authority 只作 type reference；无 provider adapter |
| `auth/` | reuse | auth authority 只作 type reference；缺失 port 显式 unavailable |
| `models/` | reuse | 复用现有 model identity 语义；不复制 catalog |
| `thinking/` | reuse | 复用现有 thinking level 语义；不创建默认选择 |
| `prompts/` | new | template/submission envelope；不内建假 template |
| `keymap/` | new | normalized key/action metadata；不保存 renderer key event |
| `queue/` | narrow | durable queue snapshot/result；不回退 transient queue |
| `approval/` | narrow | ticket/decision receipt；不实现 allow-all |
| `task-goal/` | reuse | 只引用 canonical task/goal revision；不估算状态 |
| `goal-plan/` | new | verified plan reference/view；不读取文档或执行计划 |
| `agents/` | new | unavailable-capable activity snapshot；无 swarm adapter |
| `extensions/` | narrow | trust/resource snapshot；不扫描目录或启动 MCP |
| `runtime-snapshot/` | narrow | 字段级 unknown/unavailable；不组装 runtime snapshot |
| `security-mode/` | reuse | 复用 security authority type；mutation 只保留 port |
| `shutdown/` | reuse | 复用 shutdown trigger 语义；不调用 `process.exit` |
| `workspace/` | new | branch/detached/unavailable view；不 spawn git |
| `update/` | new | bounded update notice/status；不下载、不激活、不改变 channel |
| `process/` | narrow | 仅扩展既有 overlay type；不复制 managed-process 真源或 adapter |

所有 `new`/`narrow` 文件必须只导出类型；任何查询或 mutation 只保存
`generation/correlationId/effectId` 以及对应 authority revision，不在合同层执行 IO。

## 5. Phase P1：基础 envelope 与只读 presentation view

### 5.1 基础合同

在 `application/common.ts` 建立：

- `Loadable<T>`：`idle | loading | ready | empty | error`；
- `QueryGuard`：`idle | dispatching | running`；
- `CorrelatedRequestRef`：`generation/effectId/correlationId`；
- `TuiTerminalState`：`succeeded | failed | cancelled | aborted`；
- `TuiExecutionState`：`pending | running | terminal`；
- `PortAvailability`：`available | unavailable(reason)`，只表达装配事实。

AbortSignal 属于 effect 执行对象，不进入可序列化 state。请求 contract 可以在 port 层
接收 signal，但 state/action/result 只能保存 id 和 generation。

### 5.2 presentation view

在 `presentation/types.ts` 建立：

- `TuiBootstrapSnapshot`：workspace label、current canonical session identity/lifecycle；
- `SessionStripView`：workspace/session/authority/security/host/client connection 的安全标签；
- `ActiveStateView`：recovery/frozen/approval/running/queue/idle 优先级；
- `FooterView`：状态、context、selection、host 的可选只读标签；
- `CommandComposerView`、`CommandSuggestionView`、`CommandDraftProvenance`；
- `WelcomeView`：version/model/thinking/directory/branch 的已脱敏显示值。

这些 view 不保存 Theme、Renderable、callback 或 getter。`src/tui/presentation.ts` 现有
`PresentationBlock` 暂时保留；本 phase 只让它引用新的 type，不做组件迁移。

### 5.3 验证

- 用 `satisfies` 构建最小/完整 fixture，覆盖每个 discriminant；
- 确认 presentation view 可 `structuredClone`，且不含 function/class instance；
- `npm run check` 与 focused contract tests 通过。

## 6. Phase P2：统一 Timeline 与 safe tool view

### 6.1 Timeline 占位

`timeline/types.ts` 建立：

- `TimelineStatus = pending | running | succeeded | failed | cancelled | aborted`；
- `TimelineRowBase`：稳定 `id/timestamp/displayOrder/status`；
- row union：`user | assistant | tool | notice | goal | queue | agent`；
- `TimelineState`：`committedRows + activeRowsByCorrelationId + activeOrder`；
- event union：message/tool start-update-end、usage、notice、goal/agent lifecycle、cleanup；
- `TimelineProjectionCursor`：message index、active message、tool-step correlation。

占位只定义结构，不实现 `reduceTimeline()`、排序、orphan timeout、viewport culling 或
streaming coalescing。

### 6.2 safe tool 数据结构

`presentation/tools/types.ts` 至少包含：

- safe input：generic/edit/write/read/grep/shell 的有界元数据；
- safe result：generic/edit/read/grep/media/shell/goal；
- structured diff：document/hunk/context-delete-add line，不保存完整 before/after；
- media：mime、byte count、artifact ref/digest、truncated/diagnostic，不保存 base64；
- shell：stdout/stderr bounded chunk、exit code、duration、signal、background；
- usage：exact/estimated/unavailable/not-applicable、billable/estimated、request summary、
  non-billable context attribution；
- final presentation：renderer kind、title、chips、body、error、usage、timestamps。

### 6.3 安全边界

- tool title/path/command label 设定字符和 UTF-8 byte 上限；
- 控制序列、credential-like field、raw args 和未知 details 不进入 safe view；
- unknown schema 或 invalid diff 只能降级为 bounded summary；
- `exitCode` 与 tool lifecycle status 分离；不从自然语言 output 猜成功/失败；
- safe usage 的 unknown/unavailable 不归零。

### 6.4 验证

- exhaustive fixture 覆盖所有 row/tool union；
- negative fixture 证明 type/API 不提供 raw args/base64/before/after 字段；
- 当前 OpenTUI 渲染输出完全不变；不新增 frame/PTY 测试。

## 7. Phase P3：Command、Session 与本地交互状态

### 7.1 Command 数据合同

参考分支的 `CommandDefinition` 混合了 metadata 与 handler。本计划拆开：

- `CommandDescriptor` 只含 canonical name、alias、description、category、order、argument
  schema、draft/history/query/frozen policy；
- `CommandIntent` 携带 invocation id、display order、normalized args、catalog generation；
- `CommandDecision` 只定义 handled/message/action/effect/queued/failed/cancelled/aborted
  envelope；
- handler、registry、parser、executor 均留给后续行为 phase。

alias 初始只记录当前 canonical command authority 给出的值，不从参考分支自动复制。

### 7.2 Session 数据合同

只面向 current canonical session format：

- `SessionSummary`：id/title/safe locator/cwd label/timestamps/lifecycle/access/lineage/current；
- `SessionLineage`：root 或 fork(parent session + canonical parent cursor + goal mode)；
- `SessionDetail`：message/turn/tool count、selection、head cursor、lineage；
- `SessionPreview`：bounded messages + Timeline + truncation/source bytes；
- `SessionDiagnostic`：corrupt/oversize/staging/unpublished/symlink/changed；
- picker/detail/preview 的 idle/loading/ready/empty/error state；
- session transition 只保存 intent、expected revision、confirmation 和 recovery state。

不加入旧代际 compatibility reader、绝对路径开放、旧 session 自动转换或 TUI 自己 fork。

### 7.3 Interaction state

- overlay 使用 closed/command/session/provider/auth/model/thinking/prompt/extension/keymap/
  approval/process/transition discriminated union；
- search query、selected id、generation、request id 均在对应 workflow state 内；
- width/height/density 可以是 projection input，但 renderer/focus/component reference 不进入
  state；
- viewport clear revision、expanded、composer empty 属于 client-local state，不持久化。

## 8. Phase P4：Runtime workflow snapshot 占位

按真实 authority 逐域建立 `Snapshot + Result + WorkflowState + Port type`；port 只定义接口，
不提供默认实现。

| 领域 | 被动数据 | 必须保留的 authority 字段 | 无 authority 时 |
|---|---|---|---|
| Provider/Auth/Model/Thinking | provider status、model list、login interaction、selection | provider/model identity、generation | `unavailable(reason)` |
| Prompt | template id/label/bounded text、submission state | invocation/request id | 不内建假 template |
| Durable Queue | pending/claimed item、digest、queue revision、cancel receipt | session、authority generation、queue revision | 不回退 transient queue |
| Approval | pending item、ticket digest、decision revision、receipt digest | approval/request/session/revision | 不回退 allow-all |
| Task/Goal/Plan | goal/task snapshot、lifecycle、verified plan ref | repository/goal/plan revision、digest | 不估算 canonical 状态 |
| Agent/Swarm | agent activity、display phase/residency、estimated progress view | session/agent/parent/repository revision | snapshot unavailable |
| Extension | resource view、trust/activation/diagnostic、reload receipt | generation/digest/component identity | 不扫描目录、不启动 MCP |
| Runtime snapshot | session/activity/security/selection/context/queue/tool/extensions | authority generation + source revision | 字段级 unknown/error |
| Security mode | current mode、expected revision、transition receipt | session authority + mode revision | mutation unavailable |
| Shutdown | trigger、success/recovery-required/failure | correlation/generation | 不直接 process.exit |
| Workspace Git | branch/detached/unavailable | workspace identity + observed revision | 不在合同层 spawn git |
| Process | list/detail/output cursor/driver/mutation receipt | execution/attempt/host/driver revision | 只读 unavailable |
| Update | bounded notice/policy/status view | release/channel/receipt identity | 不在 TUI 下载/激活 |

### 8.1 Runtime 枚举复用

如果目标仓库已有 canonical 类型，TUI 必须 import type；如果尚不存在，实施顺序为：

1. 在本 phase 中把相应 snapshot 字段建模为 `unknown/unavailable`；
2. 在拥有该领域的 Runtime 专项中先落 canonical contract；
3. 后续窄改 TUI type import；
4. 再单独实现 adapter/projector。

不得为了让 TUI 类型“好看”而在 `src/tui/` 重定义 Runtime `AgentState`、
`SecurityOperatingMode`、process status、queue durable semantics 或 extension trust state。

## 9. Phase P5：聚合 TuiState 与 Action/Effect/Result 占位

### 9.1 文件拆分

参考分支把三套大 union 放在一个 1,000 行文件中。目标仓库按职责拆分：

- `application/state.ts`：聚合 state、capabilities、overlay、command record；
- `application/action.ts`：用户/Runtime/result 转换后的纯数据 intent；
- `application/effect.ts`：需要 port 执行的 command；
- `application/result.ts`：correlated completion/stale/uncertain result；
- `application/types.ts`：只做 type-only barrel。

### 9.2 `TuiState` 组成

聚合 state 至少包含：

- bootstrap、authority generation、port availability；
- query guard、command records/order、transient input queue；
- Timeline state；
- session/provider/auth/model/thinking/prompt/keymap workflow；
- queue/approval/task-goal/plan/agent/process/extension/runtime snapshot workflow；
- overlay、session transition、selection、local viewport/composer flags；
- active turn、queue/approval counts、transition frozen、recovery required。

不得包含：renderer、Renderable、Component、Theme instance、controller、storage manager、
AbortController、timer、Promise、callback、raw tool args 或 mutable Map。

### 9.3 Action/Effect/Result 最小语义

- action 表达“发生了什么/用户请求什么”，不执行 IO；
- effect 表达“哪个 port 以何种 expected revision 执行什么”；
- result 必须回带原 effect/correlation/generation；
- stale/aborted/uncertain 是显式结果，不通过 throw 或静默 ignore 表达；
- mutation result 对未知完成状态使用 `uncertain + recoveryRequired`；
- reducer、EffectRunner、AbortController registry 和 retry policy 均不在本计划实现。

### 9.4 与现有 `InteractiveMode` 的边界

P5 结束时现有 `InteractiveMode` 仍可不消费 `TuiState`。禁止为了证明占位“有用”而做半套
双写。未来迁移必须选择一个独立计划，按测试驱动把 mutable field 逐个移入 reducer；
在此之前，类型占位不得冒充生产 architecture 已切换。

## 10. Phase P6：出口、验证与后续接线门

### 10.1 出口

- `src/tui/index.ts` 仅 `export type` 新合同；
- 不从 package root 暴露内部 workflow state，除非已有 public API 需求；
- 不新增 production factory、默认 port、mock adapter、feature switch；
- 每个目录保留清晰单一 authority，禁止 `types-legacy.ts`、`legacy-types.ts` 或 sibling
  duplicate。

### 10.2 自动验证

每个有代码改动的 phase 必须按顺序运行：

```bash
npm run check
npm test
git diff --check
```

并增加 focused checks：

- contract import boundary；
- fixture 的 discriminant/exhaustiveness；
- no function/class/renderer in cloneable state；
- no raw args/base64/before-after/credential fields in safe presentation；
- current canonical session format 负向检查；
- no new `feature*`/flag/fallback/compatibility gate；
- existing OpenTUI component/runtime tests 保持 GREEN。

纯数据结构阶段不要求 PTY 或人工视觉验收，因为没有用户可见行为。未来开始 OpenTUI
组件接线后，最低门禁改为：

1. `createTestRenderer()` 的真实 frame/input/resize 测试；
2. owner renderer 在 `finally` 中 destroy；
3. full-frame 的 compact/regular/wide 尺寸；
4. standard PATH PTY；
5. 用户真实 terminal gate 只由用户批准，不由自动测试代签。

### 10.3 Git 边界

- 实施前重新检查目标仓库 dirty state；
- 只暂存本 phase 的显式路径，禁止 `git add .` / `git add -A` / `git commit -a`；
- 实施或提交前重新检查 branch、HEAD 和 `git status`；已有的 Runtime Host、Context
  assembly、CLI/test 或其他专项提交都只作为外部基线，不得因本计划而重新暂存或改写；
- 用户未要求 commit/push 时不创建 commit、不推送。

### 10.4 本轮实际实施记录（P0 → P6）

本轮按 P0 → P6 以 RED → 最小 GREEN → focused regression 顺序完成。以下是本 checkout
实际新增或修改的本计划文件与对应 focused contract test；这些文件只定义类型、联合和
安全视图，不提供执行实现：

| Phase | 实际文件 | focused test |
|---|---|---|
| P0 | 本文 §4.4 mapping；`tests/tui/contracts/import-boundary.test.ts` | `import-boundary.test.ts`，2 tests |
| P1 | `src/tui/application/common.ts`；`src/tui/presentation/types.ts` | `common-presentation.test.ts`，3 tests |
| P2 | `src/tui/timeline/types.ts`；`src/tui/presentation/tools/types.ts` | `timeline-safe-tools.test.ts`，4 tests |
| P3 | `src/tui/commands/types.ts`；`src/tui/sessions/types.ts`；`src/tui/application/state.ts` 的 interaction 合同 | `command-session-interaction.test.ts`，5 tests |
| P4 | `src/tui/providers/types.ts`、`auth/types.ts`、`models/types.ts`、`thinking/types.ts`、`prompts/types.ts`、`keymap/types.ts`、`queue/types.ts`、`approval/types.ts`、`task-goal/types.ts`、`goal-plan/types.ts`、`agents/types.ts`、`extensions/types.ts`、`runtime-snapshot/types.ts`、`security-mode/types.ts`、`shutdown/types.ts`、`workspace/types.ts`、`update/types.ts`；`src/tui/process/types.ts` passive 扩展 | `workflow-domains.test.ts`，4 tests |
| P5 | `src/tui/application/state.ts` aggregate；`src/tui/application/action.ts`；`effect.ts`；`result.ts`；`types.ts` | `application-protocol.test.ts`，5 tests |
| P6 | `src/tui/index.ts` type-only exports；本文 §12 与实施记录；`tests/tui/contracts/exports-status.test.ts` | `exports-status.test.ts`，3 tests；全套 focused contracts 共 26 tests |

P0–P6 的 focused tests 均使用 structured-cloneable fixture、unknown/unavailable 负向断言、
current canonical session format 约束和静态 import/safe-field 检查。最终门禁实际结果为：
`npm run check` 成功；`npm test` 的 Vitest 为 183 files / 887 tests 全绿，Bun native 为
14 tests / 88 assertions 全绿；focused contract tests 为 7 files / 26 tests；`git diff --check`
成功。OpenTUI production TUI 仍未接入这些 contracts：生产
`InteractiveMode`、`src/tui/opentui/`、CLI、storage、Runtime Host/Context assembly 和现有
process adapter 没有被本轮合同接入；reducer、EffectRunner、projector、controller adapter、
组件迁移、OpenTUI renderer 接线和双写仍未实现。

## 11. 推荐实施与提交切片

| 切片 | 内容 | 生产行为 | 推荐验证 |
|---|---|---|---|
| C0 | mapping + import boundary | 无变化 | static check + diff check |
| C1 | common + presentation view | 无变化 | focused fixtures + check/test |
| C2 | Timeline + safe tool view | 无变化 | safe view negative fixtures + check/test |
| C3 | command + current canonical session + interaction state | 无变化 | workflow fixture + check/test |
| C4 | Runtime workflow snapshot/port types | 无变化 | per-domain envelope tests + check/test |
| C5 | aggregate state + action/effect/result | 无变化 | exhaustiveness/correlation tests + check/test |
| C6 | type-only exports + docs/status sync | 无变化 | full check/test + diff check |

只有用户明确要求“每阶段 commit”时才按 C0-C6 创建独立 commit；否则这些只是审阅切片，
不是本计划对 Git 历史的授权。

## 12. 权威状态表

| Phase | 状态 | 完成定义 | 当前证据 |
|---|---|---|---|
| P0 合同清单与边界 | `agent-verified` | 固定映射、current canonical session format 与 forbidden imports | `import-boundary.test.ts` focused 2 tests；本轮最终全量门禁通过 |
| P1 基础/presentation | `agent-verified` | cloneable framework-neutral view 全部 typecheck | `common-presentation.test.ts` focused 3 tests；本轮最终全量门禁通过 |
| P2 Timeline/safe tool | `agent-verified` | row/event/tool safe unions 与负向边界测试 | `timeline-safe-tools.test.ts` focused 4 tests；本轮最终全量门禁通过 |
| P3 Command/Session/interaction | `agent-verified` | metadata/intent/current canonical session/client state 到位 | `command-session-interaction.test.ts` focused 5 tests；本轮最终全量门禁通过 |
| P4 Runtime workflows | `agent-verified` | 各领域 snapshot/result/state/port 占位且无假 authority | `workflow-domains.test.ts` focused 4 tests；本轮最终全量门禁通过 |
| P5 aggregate protocol | `agent-verified` | state/action/effect/result 组合且不接生产双写 | `application-protocol.test.ts` focused 5 tests；本轮最终全量门禁通过 |
| P6 出口与验证 | `agent-verified` | type-only exports、全门禁、文档状态同步 | `exports-status.test.ts` focused 3 tests；本轮最终全量门禁通过 |

状态只允许按 `planned -> implementing -> implemented -> agent-verified -> human-verified`
提升。类型文件存在最多证明 `implemented`；没有独立边界审阅不能标记
`agent-verified`，没有用户真实终端批准不能标记 `human-verified`。本轮只推进到
`agent-verified`；没有宣称 human terminal verification，也没有把合同占位当作生产 TUI
切换完成。

## 13. 完成判定

当且仅当以下条件全部成立，才可宣告“数据结构占位完成”：

1. §3 列出的 type-only 目标按实际 authority 落地，缺失 authority 明确 unavailable；
2. 参考分支的行为实现没有被整体复制，目标 OpenTUI production behavior 未改变；
3. current canonical session format only、无 feature/compatibility/fallback、无假 authority；
4. Timeline 和 safe presentation 不接收 raw args、credential、base64 或无界正文；
5. `TuiState` 不含 renderer/component/controller/IO/Promise/callback/mutable Map；
6. generation/correlation/effect/revision 字段足以支持后续 stale/uncertain 处理；
7. `npm run check`、`npm test`、focused boundary tests、`git diff --check` 全部通过；
8. 计划状态表和两级文档导航已同步，但未伪造 reducer、OpenTUI 接线、PTY 或人工验收。

后续若要把这些占位接入生产 TUI，必须另建“reducer/effect/projector/OpenTUI incremental
render”实施计划；它应把本计划作为合同前置，而不是在本文继续扩张为第二个 Runtime
实施总计划。
