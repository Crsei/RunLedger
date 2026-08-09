# RunLedger TUI 被动数据结构分批接入计划

> **状态：** `implementing`
>
> **创建日期：** 2026-08-06
>
> **计划基线：** `rollback/pre-governed-agent-harness-runtime@92d9b3a`
>
> **当前修复基线：** `rollback/pre-governed-agent-harness-runtime@a09a408`（2026-08-06；
> 后续未提交修复以工作区 diff 为准）
>
> **Session 接线基线：** `session-owner-runtime@c608c77`（2026-08-09；S1/S2 未提交实现以工作区 diff 为准）
>
> **前置合同：** [`17-passive-data-contract-placeholder-plan.md`](17-passive-data-contract-placeholder-plan.md)
> 的 P0–P6 已 `agent-verified`；本计划不重新设计或复制这些合同，只负责把它们分批接入
> 当前生产 `InteractiveMode`、OpenTUI presentation 与 Host/controller port。
>
> **owner 路由：** 生产 Host 是现行基线（[`runtime/05`](../runtime/05-multi-client-background-terminal-refactor-plan.md)）；
> 替代实施权威是 [`runtime/06`](../runtime/06-session-owner-runtime-replacement-plan.md)。R0 起 TUI 只消费
> session owner 合同与 public barrel，禁止新增 Host 消费；R7 后接入统一 attach/claim TCP facade。
>
> **owner 路由：** 生产 Host 是现行基线（[`runtime/05`](../runtime/05-multi-client-background-terminal-refactor-plan.md)）；
> 替代实施权威是 [`runtime/06`](../runtime/06-session-owner-runtime-replacement-plan.md)。R0 起 TUI 只消费
> session owner 合同与 public barrel，禁止新增 Host 消费；R7 后接入统一 attach/claim TCP facade。
>
> **权威边界：** [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) 继续拥有
> renderer、Bun 启动器、focus、resize、destroy 与 native frame 迁移；
> [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md)
> 继续拥有 delta 合并、帧调度、长会话窗口化、背压与性能预算。本计划只拥有“被动合同到
> 生产 TUI 行为”的 reducer/projector/effect/adapter 接入过程。

## 0. 执行结论

当前缺口不是“再造一套 TUI 类型”，而是已经提前写好的
`TuiState / TuiAction / TuiEffect / TuiResult / TimelineState / safe presentation / 各领域 workflow`
仍未成为生产 TUI 的状态和交互边界。接入采用以下顺序：

```text
Runtime / Host / Storage canonical authority
                    |
                    v
        typed query / mutation adapters
                    |
                    v
              EffectRunner
                    |
          correlated TuiResult
                    |
                    v
      pure reducer + Timeline projector
                    |
                 TuiState
                    |
                    v
        read-only presentation selectors
                    |
                    v
       existing component snapshots / OpenTUI
```

先接只读投影，再接 Timeline，再接 input/action/reducer，然后接 query effect，最后接 mutation。
每一批只迁移一个明确状态 owner：切换后的字段不再由 `InteractiveMode` 同时维护。不得先建立
长期双写，再用“以后清理”作为完成条件。

本计划完成后应达到：

1. 标准 `runledger` 生产入口以 `TuiState` 为唯一 TUI 交互状态源；
2. Runtime、Host、Storage、Session、Security、Queue、Approval、Process 仍是事实 authority；
3. OpenTUI renderer 只消费 presentation frame，不直接修改 Runtime 或 canonical state；
4. query/mutation 都有 generation、effectId、correlationId 和需要的 authority revision fence；
5. safe Timeline 不保存 raw args、credential、base64、无界 stdout/stderr 或完整 before/after；
6. 现有 Plan 18 coalescer、frame scheduler、keyed renderable、viewport 和 cache 被复用，不另建一套。

## 1. 当前实现基线

### 1.1 已完成的数据合同

`17-passive-data-contract-placeholder-plan.md` 已完成以下 framework-neutral 合同，且 focused
contract tests 已覆盖 import boundary、structured clone、current canonical session format、
safe tool 字段和 type-only exports：

| 合同族 | 当前文件 | 本计划用途 |
|---|---|---|
| Application protocol | `src/tui/application/{common,state,action,effect,result,types}.ts` | 状态、intent、effect 与相关结果的唯一 TUI 协议 |
| Timeline | `src/tui/timeline/types.ts` | 历史、流式消息、工具、notice、goal、queue、agent 的统一行模型 |
| Presentation | `src/tui/presentation/types.ts` | bootstrap、session strip、active state、footer、composer、welcome 的只读 view |
| Safe tool view | `src/tui/presentation/tools/types.ts` | 工具输入/结果/diff/media/shell/usage 的有界安全投影 |
| 基础 workflow | `sessions/providers/auth/models/thinking/prompts/keymap` | selector、加载态、选择态与 current-format session workflow |
| 治理 workflow | `queue/approval/security-mode/shutdown/workspace/update` | revision-fenced mutation 与 recovery-required 表达 |
| 高级 workflow | `task-goal/goal-plan/agents/extensions/runtime-snapshot/process` | 只读 snapshot、port availability 与高级 overlay 状态 |

这些类型存在只证明合同已经可消费，不证明 reducer、EffectRunner、生产 adapter 或 renderer
接线已经完成。

### 1.2 当前生产行为

当前生产链路仍是：

```text
InteractiveSessionControllerPort / Agent
                 |
              AgentEvent
                 |
          adaptAgentEvent()
                 |
       InteractiveMode.handleEvent()
                 |
    component mutation + requestRender()
                 |
         TUI.renderFrame()
                 |
   OpenTuiComponentRuntime.update(frame)
```

当前明确的接入缺口：

- `src/tui/interactive-mode.ts` 直接维护 `streaming`、`stopReason`、
  `streamingGeneration`、tool component map、model/thinking、overlay 与退出状态；
- `replayInitialHistory()` 和 live `handleEvent()` 使用两套投影入口；
- provider/model/auth/extension/domain query 在 `InteractiveMode` 内直接发请求并解析
  `Record<string, unknown>`；
- `TuiAction`、`TuiEffect`、`TuiResult` 仍是被动 union，没有 reducer 或 runner；
- `TimelineState` 和 safe tool presentation 尚未驱动生产 chat；
- `TuiState` 尚未进入 CLI composition，标准 `runledger` 不消费聚合合同；
- process overlay 已有 `process/reducer.ts`、`controller-adapter.ts` 和 native 测试，接入时应复用，
  不能另造 process manager 或第二 reducer authority。

### 1.3 OpenTUI 接入约束

依据当前 OpenTUI runtime 与测试方式：

- renderer/root/focus/input/resize/destroy 仍由 `src/tui/opentui/` owner 管理，不进入 `TuiState`；
- `KeyEvent`/paste 只在 renderer 边界归一化，reducer 不接 raw terminal bytes；
- presentation 变化通过持久 renderable mutation 更新，不为每个 action 重建 renderer tree；
- native 测试使用 `@opentui/core/testing#createTestRenderer()`，并在 `finally` 中 destroy owner；
- resize 只更新 viewport/layout input，不改 canonical workflow 事实；
- 60/80/143 列布局与滚动、focus、selection、theme、背压预算仍由 Plan 17/18 的门禁约束。

## 2. 权威边界与停止规则

### 2.1 计划之间的单一 owner

| 事项 | 唯一 owner | 本计划允许的动作 |
|---|---|---|
| OpenTUI renderer 生命周期、Bun 启动、focus、resize、native frame | Plan 17 | 只消费既有 runtime port；不得重写 renderer |
| delta coalescer、frame scheduler、viewport、render cache、长会话预算 | Plan 18 | 复用并补接 state generation/key；不得另建 queue/cache |
| framework-neutral passive contract | Passive Plan 17 | 必要时原地窄改 canonical type，并先补 contract RED test |
| TUI reducer/projector/effect/adapter 接线 | 本计划 | 分批建立行为并迁移 `InteractiveMode` |
| Session/Runtime/Host/Security/Queue/Approval/Process 事实 | 对应 Runtime/Host 专项 | 只通过 typed port 查询或提交 intent |
| settings/session/ledger 持久化 | Storage/Runtime | TUI 不新增 writer、cache file 或 migration |

### 2.2 必须立即停止并拆项的情况

出现以下任一情况，不得用 TUI 本地实现补洞：

1. 需要在 `src/tui/` 重定义 canonical Runtime id、revision、security mode、queue 或 process 状态；
2. 需要 TUI 直接读写 session JSONL、settings、auth、ledger、workspace 文件或 Git；
3. Host 没有真实 query/mutation authority，却准备返回 mock、空数组、0 或 allow-all；
4. mutation 结果无法区分 completed、stale、aborted、uncertain；
5. adapter 只能返回原始 `Record<string, unknown>` 且没有 schema/typed validator；
6. 接入要求绕过 driver fence、approval receipt、queue revision 或 security revision；
7. 需要改变 OpenTUI renderer tree、native package 或性能预算才能让领域状态工作；
8. 新路径与旧 `InteractiveMode` 字段必须无限期双写才能通过测试；
9. 标准 `runledger` 可执行文件无法确认指向当前 checkout；
10. 真实终端验收需要用户判断时，自动化结果不得代签 `human-verified`。

## 3. 数据结构到生产行为的映射

| 数据结构族 | canonical 输入 | 行为接入点 | 生产消费者 | 批次 |
|---|---|---|---|---|
| `TuiBootstrapSnapshot`、`SessionStripView`、`ActiveStateView`、`FooterView`、`WelcomeView` | controller/session/layout 的安全标签 | bootstrap projector | header/status/footer/welcome/composer | B1 |
| `TimelineState`、`TimelineEvent` | replay message + `TuiEvent` + safe tool receipt | timeline event projector + pure reducer | `ChatContainer` presentation blocks | B2 |
| `TuiAction`、`TuiState`、`TuiOverlayState` | normalized key/paste/resize/component intent | application store + reducer | overlay/composer/selection/viewport | B3 |
| provider/auth/model/thinking/prompt/keymap/session workflow | controller typed methods + Host query | query EffectRunner + typed adapters | selector overlays | B4–B5 |
| queue/approval/security/shutdown/workspace/update workflow | Host command/query + receipt/revision | governed mutation runner | status/confirm/recovery overlay | B6 |
| task/goal/plan/agents/extensions/runtime snapshot | Host-owned bounded snapshots | domain query adapters + selectors | advanced read-only overlays/timeline rows | B7 |
| process passive workflow | 现有 process controller/reducer/Host facade | bridge/selectors，复用现有实现 | process list/detail/terminal overlay | B7 |

## 4. 目标代码布局

以下是计划中的行为文件，不是本轮文档任务已经实现的文件：

```text
src/tui/
├── application/
│   ├── initial-state.ts           # 从显式 bootstrap/capability input 构造完整 TuiState
│   ├── reducer.ts                 # 纯 reducer；不做 IO、render 或 timer
│   ├── selectors.ts               # state -> presentation view
│   ├── store.ts                   # dispatch/getState/subscribe；无领域 authority
│   ├── effect-runner.ts           # effect dispatch、AbortController registry、stale fence
│   └── ports.ts                   # 聚合既有领域 port，不复制领域协议
├── timeline/
│   ├── event-projector.ts         # Agent/Tui/replay input -> TimelineEvent
│   ├── reducer.ts                 # TimelineEvent -> TimelineState
│   └── selectors.ts               # TimelineRow -> existing PresentationBlock
├── presentation/
│   ├── projectors.ts              # bootstrap/status/footer/composer/welcome projector
│   └── tools/projector.ts         # runtime receipt -> SafeToolPresentation
├── input/
│   └── normalize-action.ts        # normalized app input -> TuiAction；不接 raw bytes
├── adapters/
│   ├── interactive-session.ts     # controller method -> typed workflow result
│   ├── session-domain.ts          # Session Router -> SQLite workflow typed projection
│   └── session-resources.ts       # 已协商的 Session resource bounded projection
├── sessions/
│   └── port.ts                    # catalog/create/resume/fork 的单一 TUI authority port
└── interactive-mode.ts            # 逐批缩减为 composition/lifecycle/presentation adapter

tests/tui/
├── application/
├── timeline/
├── adapters/
└── passive-contract-integration.bun.test.ts
```

文件名可在 RED 阶段根据当前目录惯例窄调，但不得创建带代际后缀或兼容语义的副本、
第二个 `TuiState`、第二个 process reducer 或第二个 renderer runtime。

### 4.1 逐域单写规则

每批迁移一个字段族时按以下顺序执行：

1. 为当前旧行为写 characterization test；
2. 为新 reducer/projector 写 RED test；
3. 新状态先在 test composition 独立跑通；
4. production composition 一次切换该字段族；
5. 同一提交删除旧字段/旧 mutation 路径；
6. 用 native frame/CLI smoke 证明可见行为没有丢失；
7. 若无法在同一批删除旧 owner，回滚该字段族，不保留长期双写。

允许短暂存在的 compatibility bridge 只能是纯转换函数，例如
`TimelineRow -> PresentationBlock`；它不能写两套 state，不能拥有 timer/IO，也不能持久化。

### 4.2 合同缺口处理

接入中发现现有 union 缺少 action/effect/result 时：

1. 先在 `tests/tui/contracts/` 增加失败用例；
2. 只在 Passive Plan 17 的 canonical 文件原地增加最小 discriminant/字段；
3. 保持 structured-cloneable、framework-neutral 和 current-format-only；
4. 不借机重命名整套合同；
5. 合同修订与消费实现放在同一批，但在 diff 中分区审阅。

## 5. 批次总表

| 批次 | 状态 | 主题 | 用户可见结果 | 主要切换 owner |
|---|---|---|---|---|
| B0 | `implemented` | baseline、authority map、测试支架 | 标准 `runledger` 行为保持不变，有可复现 frame/PTY baseline | 无 |
| B1 | `implemented` | 只读 application/presentation 投影 | welcome/session strip/status/footer 明确显示 known/unknown/unavailable | bootstrap/status/footer |
| B2 | `implemented` | Timeline 与 safe tool 接入 | 历史、流式消息、工具结果走统一稳定行并保持增量显示 | chat/timeline/tool view |
| B3 | `implemented` | normalized input、Action、纯 reducer | composer、overlay、selection、viewport 由 action/state 驱动 | local interaction state |
| B4 | `implemented` | query EffectRunner 与只读 adapter | session/provider/model/prompt/keymap 等 selector 有 typed loading/error/empty | query workflow |
| B5 | `implemented` | session/config/auth 选择工作流 | model/thinking/auth/session 操作显示 authoritative completion/stale/error | config workflow |
| B6 | `implementing` | governed mutation | 已移除伪造 Queue/Approval authority；真实 durable receipt/revision 接线仍待 Host contract | governed workflow |
| B7 | `implementing` | 高级领域与 process 复用 | plan/extension/worktree/security/process 有真实通道；task/goal/agent/runtime/update 保持 unavailable | advanced workflow |
| B8 | `implementing` | 旧状态退休与性能闭合 | state owner、取消/cleanup 已加固；须等待 B6/B7 authority 缺口闭合后完成 | `InteractiveMode` 瘦身 |

状态只能按 `planned -> implementing -> implemented -> agent-verified -> human-verified` 推进。
没有真实 terminal 用户确认不得标记 `human-verified`。

## 6. B0：固定 baseline、authority map 与支架

### 6.1 RED 与任务

1. 记录 branch、HEAD、dirty state、`command -v runledger` 和解析后的真实路径；
2. 固定 `InteractiveMode` mutable field、直接 controller 调用、Host raw response 解析和组件 mutation 清单；
3. 固定被动合同每个 workflow 的真实 authority：local controller、remote Host、unavailable；
4. 为标准启动、历史 replay、一次流式回复、一次工具调用、overlay、Ctrl+C/Ctrl+D 建立 baseline；
5. 新增 focused integration harness，但不改变 production state；
6. PTY 场景使用隔离 `RUNLEDGER_DIR`，不得读取或迁移真实用户目录。

### 6.2 产物

- 本文 §3 mapping 根据 live code 更新；
- characterization tests；
- 一个可复用的 contract-integration native test fixture；
- 如当前仓库没有可复用 PTY runner，只新增本计划场景 runner，不复制 Plan 17/18 renderer benchmark。

### 6.3 验收与回滚

- 可见结果：当前标准 `runledger` 的 60/80/143 列基线被记录，行为无变化；
- `InteractiveMode`、CLI composition、renderer 没有生产改动；
- 若标准 PATH 不指向当前 checkout，停止 PTY，不自动把其他工作树冒充本分支；
- 回滚只删除新增测试/fixture，不影响现有生产代码。

### 6.4 B0 执行证据（2026-08-06）

- baseline：branch `rollback/pre-governed-agent-harness-runtime` @ `b284e51`（dirty：仅
  development-doc 三个文件 + 本计划新增）；`command -v runledger` → `/home/nzq/.npm-global/bin/runledger`
  → `readlink -f` 解析到本 checkout 的 `bin/runledger.js`（与 `readlink -f ./bin/runledger.js` 一致）；
- authority map：`tests/tui/baseline/authority-map.test.ts` 固定 13 行 workflow→channel 映射
  （local / remote / facade / none），并断言 effect union 每个 discriminant 都有记录行；
- InteractiveMode inventory：`tests/tui/baseline/interactive-mode-inventory.test.ts` 固定
  mutable 字段（streaming / stopReason / streamingGeneration / streamingDeltas /
  pendingAssistantPartials / toolCallComponents / modelRegistry / thinkingLevel /
  lastIdleCtrlC / quitting / processOverlayComponent / consecutiveInitFailures）、直接
  controller 调用、Host raw response 解析与组件 mutation 清单；
- 可复用 harness：`tests/tui/fixtures/contract-integration.ts`（ContractTerminal 60/80/143
  可配列宽 + ContractController 事件源 + 隔离 RUNLEDGER_DIR 的 createContractHarness，
  dispose 在 finally 清理并还原环境）；
- native baseline：`tests/tui/passive-contract-integration.bun.test.ts` 7 个场景（启动帧、
  历史 replay 顺序、流式回复+工具调用、overlay+Ctrl+C/Ctrl+D、RUNLEDGER_DIR 隔离）全绿；
- characterization 发现：fake-terminal render 路径把 `present()` 组件投影为
  `[object Object]`，属既有基线缺陷（OpenTUI runtime 按结构化 block 消费），chat 内容断言
  走 `ChatContainer.present()` 结构化投影；renderer 本体属 Plan 17/18 owner，本计划不修。

## 7. B1：只读 Application 与 Presentation 投影

### 7.1 RED

- 完整 `TuiState` initial fixture 能区分 known、unknown、unavailable、empty；
- bootstrap projector 不接 renderer、Theme、controller instance 或 callback；
- 60/80/143 列 frame 中 welcome/session/status/footer 使用同一 bootstrap generation；
- 缺 Host authority 时显示 unavailable，不显示 0、空列表或伪 connected；
- session label、workspace label、provider/model label 均经过有界和终端安全处理。

### 7.2 实现

1. 实现 `application/initial-state.ts`，所有 workflow 都有显式初态；
2. 实现 `presentation/projectors.ts`，产出既有 presentation/component 可消费的 view；
3. 在 `InteractiveMode` 只接入 bootstrap、session strip、active status、footer、welcome；
4. 此批不接 effect，不触发 query，不改变 prompt/tool/overlay 行为；
5. 切换后删除对应旧 getter/拼接字段，保留 renderer lifecycle。

### 7.3 可见结果与门禁

- 标准 `runledger` 首屏、状态行和 footer 来自同一 `TuiState` snapshot；
- disconnected/unavailable/recovery-required 不再被空字符串掩盖；
- native frame 覆盖 compact/standard/wide 与 theme mode；
- 回滚单位：整组 bootstrap/status/footer projector，不影响 Timeline。

### 7.4 B1 执行证据（2026-08-06）

- `src/tui/application/initial-state.ts`：`createInitialTuiState(bootstrap, capabilities?)` 产出
  完整 `TuiState`；capability 缺失 → workflow 显式 `unavailable(reason)`，available → `idle(0)`；
  `defaultCapabilities()` 20 个端口全 unavailable；计数类字段一律 `unknown(not-yet-queried)`，
  不出现 0/空列表/伪 connected；
- `src/tui/presentation/projectors.ts`：`projectSessionStrip / projectActiveState / projectFooter /
  projectWelcome / projectComposer / sanitizeLabel / boundedField / availabilityReason` 全纯函数，
  不 import OpenTUI/Theme/controller；`sanitizeLabel` strip ANSI + trim + UTF-8 字节有界截断；
  缺 Host authority → `{ state: "unavailable", reason: "host-authority-not-connected" }`；
- `InteractiveMode` 接线：新增 `initialBootstrap?` option，构造时 `state = createInitialTuiState(...)`
  （composition root 未传时由 controller/agent 派生）；`getSessionId()` 改读
  `state.bootstrap.session.id`（旧 `<no-ledger>` 回退串删除）；新增只读 `getTuiState()`；
  renderer/CLI composition/prompt/tool/overlay 行为零改动；
- 测试：`tests/tui/application/initial-state.test.ts`（5）+ `tests/tui/presentation/projectors.test.ts`
  （5）+ bun `passive-contract-integration.bun.test.ts` 新增 B1 case（footer/session strip 同一
  bootstrap generation），全绿；
- 门禁：`npm run check` + `npm test`（208 files/1102 tests + bun 22）全绿。

## 8. B2：统一 Timeline 与 Safe Tool 投影

### 8.1 RED

- replay 与 live event 对同一 canonical message 生成相同稳定 row id；
- message/tool start-update-end 能从 active row 单调进入 committed row；
- stale generation、orphan end、重复 end、abort/error 有确定结果；
- tool args/details 只经 safe projector 进入 state；raw args、credential、base64、完整文件正文失败；
- shell exit code 与 lifecycle status 分离；unknown usage 不归零；
- 10,000 history 与 delta burst 继续通过 Plan 18 的 keyed/viewport/coalescer 门禁。

### 8.2 实现

1. 实现 `timeline/event-projector.ts`，让 replay 和 live input 共用入口；
2. 实现纯 `timeline/reducer.ts`；
3. 实现 `presentation/tools/projector.ts`，只接 Runtime 已提供的安全 receipt/details；
4. 实现 `timeline/selectors.ts`，把 row 转成现有 `PresentationBlock`/组件 snapshot；
5. `ChatContainer` 改为消费 Timeline projection；
6. 删除 `toolCallComponents` 作为业务状态 owner；OpenTUI keyed renderable map 仍保留为 renderer cache；
7. `DeltaCoalescer` 继续只负责 lossless append/帧前 drain，不成为第二 Timeline store。

### 8.3 可见结果与门禁

- 标准 TUI 的历史、用户、assistant、thinking、tool running/update/result/abort/error 均可见；
- session replay 与 live transcript 顺序一致；
- 向上滚动时不抢回底部，new-content indicator 行为不变；
- 回滚单位：Timeline projection 全链，不允许留下旧 chat mutation + 新 Timeline 双写。

### 8.4 B2 执行证据（2026-08-06）

- 合同窄改（§4.2 流程，先 RED）：`timeline/types.ts` assistant 行增 `thinking?`、`usage?`，
  `message_update` 增 `thinking?`；`tests/tui/contracts/timeline-safe-tools.test.ts` 补
  structured-clone 用例；
- `timeline/reducer.ts`：纯 reducer，start-update-end 单调 commit；stale generation /
  orphan end / duplicate end / orphan update 均 no-op 不 throw；cleanup 按 correlationId
  落 aborted/cancelled；committed assistant 行 streaming 置 false；
- `timeline/event-projector.ts`：`TimelineEventProjector`（显式 seed 的有状态类），
  replay / TuiEvent / notice / cleanup 共用 `project()` 单入口；稳定 row id
  `user:${index}` / `assistant:${index}` / `tool:${toolCallId}`；replay 后
  `setMessageIndex()` 对齐 live 计数；user 行立即 start+end 完成；
  shell chunk 与 active tool presentation 有快照可复现；
- `presentation/tools/projector.ts`：safe tool 投影（renderer 按工具名、输入 metadata
  只有界路径/命令、body 只有界文本、exit code 与 lifecycle 分离、unknown usage 不归零、
  raw args/base64/credential 不进 presentation）；
- `timeline/selectors.ts`：`timelineToBlocks()` 纯转换，row id -> 稳定 block id
  （`timeline-${row.id}`），assistant 拆 thinking/text 两个 markdown block；
- `ChatContainer`：新增 `setTimelineBlocks(blocks, generation)` 生产路径
  （generation+width 缓存，Plan 18 cache 复用）；`push()` 保留为组件级测试路径；
- `InteractiveMode`：删除 `toolCallComponents` map 与 `pendingAssistantPartials`
  （inventory 测试同步删除对应断言并新增 retired 断言）；`handleEvent` 的
  message/tool 分支全部经 projector→reducer→`dispatchTimeline()`；`showNotice` 走
  notice 行；`/clear` 重置 timeline（projector.resetRows 保 messageIndex 不复用 id）；
  `flushStreamingDeltas` 仍由 DeltaCoalescer lossless append、帧前 drain，但发
  完整快照 `message_update`（单调累积，message_end 清 buffer）；`getTuiState()`
  读透实时 timeline；
- 测试：reducer 8 / event-projector 7 / tools projector 6 / selectors 5 + bun B2 case
  （replay+streaming+tool 稳定 committed timeline，id 不重复）全绿；
- 门禁：`npm run check` + `npm test`（212 files/1129 tests + bun 23）+ `npm run build` 全绿。

## 9. B3：Normalized Input、Action、Store 与纯 Reducer

### 9.1 RED

- OpenTUI `KeyEvent`、paste、component callback 先归一化，再产生 `TuiAction`；
- reducer 不 import OpenTUI、Node IO、controller、timer 或 storage；
- overlay open/close、composer change、selection、search、viewport clear、session replace 都是纯状态转换；
- key repeat/release、Kitty alias、paste UTF-8、overlay focus 有确定路由；
- reducer 对非法 transition 返回稳定 unchanged/error state，不 throw。

### 9.2 实现

1. 实现 `input/normalize-action.ts`；raw bytes 留在 OpenTUI boundary；
2. 实现 `application/store.ts` 和 `application/reducer.ts`；
3. `InteractiveMode` 变为 dispatch + presentation subscription owner；
4. composer/overlay/selection/viewport 从旧字段迁到 `TuiState.interaction`；
5. Ctrl+C/Ctrl+D lifecycle authority 仍由 Plan 17/`InteractiveMode.requestQuit()` 持有，reducer 只产生 intent；
6. renderer focus 是 view side effect，不写进 state；state 只保存期望 overlay/interaction 状态。

### 9.3 可见结果与门禁

- slash palette、selector 打开/关闭、paste、composer draft、PageUp/PageDown 行为可见且 frame 稳定；
- overlay 关闭后 editor focus 恢复；
- native test 使用 mockInput/mock paste/resize，owner 在 `finally` destroy；
- 回滚单位：local interaction state，不触及 Host query/mutation。

### 9.4 B3 执行证据（2026-08-06）

- 合同窄改（§4.2，先 RED）：`TuiInteractionState` 增 `composerDraft: SafeBoundedText`；
  `TuiAction` 增 `interaction.select / interaction.search-changed / interaction.viewport-clear`；
- `application/reducer.ts`：纯 reducer（无 OpenTUI/Node/controller/timer/storage import）；
  overlay open/close、composer change（composerEmpty 派生、identical 快照 unchanged）、
  selection/search/viewport-clear、session.replace（空 id / 同 id 拒绝）、command.submit
  （记录 cap 512）、timeline.event 委托 timelineReducer；未知 action 默认分支返回 unchanged，
  `safeReduce` 兜底不 throw；`TUI_ACTION_TYPES` 穷举登记；
- `application/store.ts`：dispatch/getState/subscribe；unchanged action 不通知订阅者；
  AbortController 不进 state；
- `input/normalize-action.ts`：`NormalizedAppInput`（submit / composer-changed / paste /
  overlay-close / select / viewport-clear / interrupt / request-exit）→ `TuiAction[]`；
  interrupt/request-exit 只产生 intent（lifecycle 仍由 InteractiveMode/Plan 17 持有）；
  paste/composer 有界（256 KiB 截断）；
- `InteractiveMode`：`state` 字段删除，`createTuiStore` 为唯一 owner；`dispatchTimeline` 打
  递增 generation 戳（修复 timeline.generation 不推进导致订阅跳过的 RED 发现）；
  store 订阅只在 timeline.generation 变化时 `chat.setTimelineBlocks`（Plan 18 cache 语义）；
  `showOverlayModal/closeOverlay` 把 overlay 意图写入 store（process→"process"、
  approval→"approval"、其余→"command"），组件/焦点仍由 renderer 管理；
  `requestQuit` 清理 store 订阅；
- 测试：reducer 8 / store 4 / normalize-action 4 + bun B3 case（overlay open/close、
  composerEmpty 经 store 流转）全绿；
- 门禁：`npm run check` + `npm test`（215 files/1145 tests + bun 24）全绿。

## 10. B4：Query EffectRunner 与只读 Controller/Host Adapter

### 10.1 RED

- effect dispatch 生成唯一 generation/effectId/correlationId；
- stale、aborted 和乱序 result 不得覆盖新 generation；
- runner 拥有 AbortController registry，但 `AbortController` 不进入 `TuiState`；
- provider/model/session/prompt/keymap/extension/runtime/process query 的 empty/error/unavailable 可区分；
- Host `Record<string, unknown>` 必须经 schema/typed validator 后才进入 workflow；
- observer 与 driver 的 capability 不被混同。

### 10.2 实现

1. 实现 `application/ports.ts` 聚合已存在的领域 port；
2. 实现 `application/effect-runner.ts`，只执行 effect 和回送 `TuiResult`；
3. 实现 `adapters/interactive-session.ts` 与 `adapters/host-domain.ts`；
4. query 打开时 reducer 先进入 loading/running，再接 completed/failed/stale/aborted；
5. 将 session/provider/model/prompt/keymap 的只读 selector 改为 workflow selector；
6. capability unavailable 时不发 effect，直接展示明确原因。

### 10.3 可见结果与门禁

- 标准 TUI selector 有 loading、ready、empty、error、unavailable 五类可见状态；
- 慢 query 后切换 overlay/session 不会回写旧结果；
- 本批不执行 model/auth/session mutation；
- 回滚单位：query runner + adapters，B1–B3 纯状态路径仍可运行。

### 10.4 B4 执行证据（2026-08-06）

- 合同窄改（§4.2，先 RED）：`TuiAction` 增 `query.start` / `query.result`；
- `application/ports.ts`：`TuiDomainPorts` 聚合 18 个既有领域 port（缺失 = unavailable）；
  `capabilitiesFromPorts()` 由端口表派生 capability snapshot；
- `application/effect-runner.ts`：`createEffectRunner` —— effect 执行、AbortController
  registry、stale fence（generation 落后判 stale）、aborted 判定、uncertain→recoveryRequired、
  capability 缺失 → failed(capability_unavailable)；AbortController 不进入 TuiState/result；
- `adapters/interactive-session.ts`：controller → typed 有界投影（provider catalog /
  model catalog / thinking / auth inspect；unknown usage/context 不归零；controller 错误
  编码 failed 不抛）；B5 mutation 显式 `not_implemented_b5`；
- `adapters/host-domain.ts`：Host `Record<string, unknown>` 全部经 typed validator
  （extension / runtime-snapshot / process / task-goal / plan / agents / security-mode /
  workspace-git / update）；invalid descriptor 丢弃；结构化字段保形 unknown；
- reducer：`query.start` → 对应 workflow loading（requestId=correlationId）；
  `query.result` 按 correlationId 匹配 loading workflow，completed→ready/empty
  （空集合落 empty）、failed→error、uncertain→recoveryRequired+error、stale/aborted 不落地；
- `InteractiveMode`：构造时聚合 ports + runner（onResult → store dispatch）；
  `/mcp`、`/plugins`、`/skills`、`/hooks` 改走 extension.inspect workflow（删除
  `result.servers`/`result.descriptors`/`server.serverId`/`descriptor.identity` raw parsing，
  inventory retired 断言同步更新）；`createEffect`（唯一 effectId/correlationId）+
  `waitForWorkflow`（store 订阅等待终态）；
- 测试：effect-runner 9 / adapters 10（interactive-session 5 + host-domain 5）+
  extension-selectors 重写 5（构造时注入 stub controller，断言 extension.inspect
  单入口，不再调用 per-kind raw operations）+ bun B4 case（workflow ready + overlay）；
  harness dispose 加固（overlay 打开时先 Escape 再 Ctrl+D）；
- 门禁：`npm run check` + `npm test`（217 files/1167 tests + bun 25）+ `npm run build` 全绿。

## 11. B5：Session、Provider/Auth、Model、Thinking 与 Prompt 工作流

### 11.1 RED

- model/thinking selection 携带 expected selection/authority generation；
- current canonical session 选择、resume/fork/transition 不接受旧格式或根外 locator；
- auth prompt、device code、URL 与 cancel/abort 有明确 state；secret 不进入 `TuiState` 或 frame snapshot；
- mutation completion 只在 correlation/revision 匹配时提交；
- failed/stale 保留原 selection；uncertain 进入 recovery-required，不 optimistic commit；
- running turn 时的配置修改遵守现有拒绝策略。

### 11.2 实现

1. 扩充必要的 canonical `TuiAction/TuiEffect/TuiResult` discriminant；
2. session/provider/auth/model/thinking/prompt workflow 接 EffectRunner；
3. secret input 只存在于短生命周期 auth interaction owner，不进入 cloneable state；
4. controller/Host 返回 authoritative selection 后再更新 view；
5. 删除 `InteractiveMode` 中对应 direct async selector 和 `thinkingLevel/modelRegistry` state owner；
6. local demo 缺 authority 时显示 unavailable，不回退假 registry 或内建 prompt template。

### 11.3 可见结果与门禁

- `/provider`、`/login`、`/logout`、`/model`、`/thinking`、`/prompt`、session selector
  通过统一 workflow 展示进度和结果；
- cancel/abort 后 secret、overlay、pending effect 均清理；
- standard CLI + remote Host 和 local supported path 分别验证；
- 回滚单位：每个领域独立切换，禁止一次提交重写全部 selector。

### 11.4 B5 执行证据（2026-08-06）

- 合同窄改（§4.2，先 RED）：`TuiEffect` 增 `auth.login / auth.logout / model.select /
  thinking.select / prompt.submit`（均带 CorrelatedRequestRef）；
- `adapters/interactive-session.ts` 改 `createInteractiveSessionAdapter`：
  返回 `{ ports, setAuthInteraction }`——auth interaction（secret/URL 提示）是短生命周期
  owner，login 前注入、完成后清空，AbortController 由 runner 提供不进 state；
  `model.select` 先查 model 再 `selectModel`，返回 controller authoritative selection
  （`model_not_found` 失败编码）；`thinking.select` 返回 `setThinkingLevel` 结果；
  `auth.logout` 走 effect；envelope 支持 produce 内失败透传；
- `effect-runner`：request 继承 effect payload 字段（修复 providerId 等参数丢失的 RED）；
- reducer：`query.start/query.result` 覆盖 auth/model/thinking workflow（loading→
  ready/empty/error，correlation 不匹配不提交，stale/aborted 不落地，uncertain →
  recoveryRequired）；
- `InteractiveMode`：删除 `modelRegistry`/`thinkingLevel` state owner（inventory retired
  断言改为 pattern 检查）；`/provider`、`/model`、`/login`、`/logout`、`/thinking` 全部走
  workflow（loading→ready/empty/error/unavailable 五态）；`/prompt` 无 authority 时
  显示 unavailable，删除内建假模板；`getThinkingLevel()` 从 thinking workflow 读取
  （ready→level，否则 off）；`rejectConfigWhileRunning` 保留（running turn 拒绝配置修改）；
- 测试：reducer B5 5 例 / adapter mutation 2 例 / inventory retired 断言更新 + bun B5 case
  （/model、/thinking workflow ready、/prompt unavailable）全绿；
- 门禁：`npm run check` + `npm test`（217 files/1173 tests + bun 26）+ `npm run build` 全绿。

## 12. B6：Queue、Approval、Security、Workspace、Shutdown 与 Update 治理操作

### 12.1 RED

- queue cancel 使用 expected queue revision，并显示 durable receipt；
- reverse approval request、用户 decision、Host receipt、AbortSignal 形成一条相关链；
- approval 不存在 allow-all 或 UI 自行执行工具的路径；
- security mode mutation 使用 expected revision，失败不改变 visible authority fact；
- workspace 只读 capability/Git snapshot 来自 platform/Host adapter，TUI 不 spawn git；
- shutdown 只提交 intent，renderer cleanup 与 Host shutdown receipt 可分别观察；
- uncertain mutation 必须 `recoveryRequired: true`，冻结冲突操作并先 re-query；
- update 只展示 policy/status/receipt，不在 TUI 下载或激活。

### 12.2 实现

1. 为 queue/approval/security/workspace/shutdown/update effect 实现 typed adapter；
2. 将 `handleReverseRequest()` 拆成 inbound action、overlay decision、Host effect/result；
3. 保留 Host driver fence 和 durable receipt authority；
4. reducer 对 uncertain 设置 recovery-required，并触发只读 reconciliation effect；
5. shutdown 完成顺序固定为：停止新 intent -> 处理 active effect -> Host receipt -> renderer destroy；
6. 删除 `InteractiveMode` 中对应 direct mutation/Promise workflow owner。

### 12.3 可见结果与门禁

- 标准 TUI 明确显示 approval pending/allowed/denied/cancelled、queue revision、security mode、
  workspace capability、shutdown/update 状态；
- observer 不出现 mutation control；driver 丢失时 mutation fail closed；
- transport 断开时可见 recovery-required，重连/re-query 后才能解除；
- 回滚单位按 queue、approval、security、shutdown 分领域提交。

### 12.4 B6 执行证据（2026-08-06）

- 合同窄改（§4.2，先 RED）：`TuiEffect` 增 `security-mode.set`（target + expectedRevision）；
- `effect-runner` 补 `security-mode.set` 映射（RED：capability_unavailable 误报）；
  request 继承 effect payload（B5 修复）；
- `handleReverseRequest`：决策经 timeline notice 记录（`approval ${decision} for ${tool}`）；
  reverse response 只返回用户决策，不再由 UI 构造 `decisionRevision: 0`、`reverse` digest 或
  completed workflow。Host durable receipt 尚无生产回传通道，因此 approval workflow 明确
  unavailable；
- 测试 `tests/tui/governed-mutations.test.ts`（8 例）：queue cancel 携带 expected revision +
  durable receipt、revision conflict 失败、approval resolve 相关链、security mode 失败不改
  visible authority fact（无乐观提交）、shutdown 只提交 intent、uncertain receipt 带
  recoveryRequired、update 只展示 policy/receipt、observer mutation fail closed —— 这些是
  runner/port 合同验收，不代表生产 Host 已提供相应 mutation；
- 本地 controller 只有 `clearAllQueues()`，没有单项取消、queue revision 或 durable receipt；
  `interactive-session` 不再暴露 queue port，避免单项取消误清 steering/follow-up 全队列；
- security 只映射真实 `security.inspect`，mutation 明确 unsupported；shutdown 仍只是本地
  intent，update 无 Host operation，均不得据此宣称 B6 完成；
- 当前结论：B6 保持 `implementing`，直至 Queue/Approval/Security/Shutdown 的 Host-owned
  revision/receipt contract 落地并有生产组合测试。

### 12.5 P1/P2 修复记录（2026-08-06，review 跟进）

- P1-1 异步结果 fence：`setWorkflowLoading` 保存 effectId；结果按 correlationId + effectId +
  generation 三重匹配（`applyQueryResultByRef`）；stale/aborted 匹配当前 loading 时退出到
  idle（`resetLoadingIfFenced`），`waitForWorkflow` 不再永久等待；16 个 workflow 的 loading
  变体合同窄增 `effectId: string`；
- P1-2 shell 流式累积：`tool_execution_update` 把含新 chunk 的 presentation 存回
  `activeToolPresentation`（不再从初始 presentation 重建）；`tool_execution_end` 后删除
  `shellChunks` 与 `activeToolPresentation`（内存释放）；
- P1-3 B6 authority 修正：删除用 `clearAllQueues()` 冒充 durable 单项取消的 queue port；
  reverse approval 只收集并返回决策，不伪造 completed workflow/revision/receipt；approval 与
  queue capability 在缺真实 port 时均为 unavailable；security-mode.set 继续返回
  `host_operation_unsupported`；
- P1-4 B7 真实通道：Host adapter 只暴露真实支持的 `extension.inspect`、`plan.inspect`、
  `security.inspect`、`worktree.inspect`；task-goal/agent/runtime/update 不再创建假 available
  port；process bridge 由 composition root 注入真实 `processOverlayClient`（`main.ts` 传
  `createProductionProcessOverlayClient`），output/mutate 不再恒 unavailable；
- P1-5 退出清理：`requestQuit` 先 `runner.cancelAll()` 再 lifecycle cleanup，并 dispatch
  `cleanup(destroy)` 全局清 active timeline rows；
- P1-6 Session capability negotiation（2026-08-09）：生产 `SessionInteractiveController`
  从 version 3 握手 handle 暴露 `supports(operation)` 与 `session.run-timing`；`InteractiveMode` 不再以 controller presence
  推断 session catalog/mutation，domain adapter 逐 operation 构造 port；未协商 operation 不发
  frame；无真实 lifecycle operation 时删除 adapter 内伪 accepted shutdown port；
- P1-7 Session Domain Router 与转场（2026-08-09）：`session-domain.ts` + `sessions/port.ts`
  接通 SQLite catalog/create/resume/fork，只投影真实 catalog 字段；production controller 改为
  `querySessionDomain`/`commandSessionDomain`，generation/correlation/effect/revision、driver、attempt
  receipt、recovery barrier 与 fork source-head fence 均在 Router/Client/Server 边界校验；
  `InteractiveMode.run()` 返回 typed `quit|switch` intent，CLI 严格 detach-before-attach，失败只经
  canonical open 恢复原 Session，remote attachment 存在时旧 Runtime 保持 headless。该项闭合
  新集成计划 S1/S2，但不提升本计划 B6–B8、Runtime R6/R6.5/R7/R8 或 human acceptance；
- P1-8 Session approval/security 接线（2026-08-09）：`handleSessionReverseRequest()` 统一分派
  credential 与 `approval_prompt`，approval modal 仍只返回 decision；durable request/decision/revoke
  receipt authority 位于 owner Runtime 的 Session Event Store。资源 adapter 只在握手精确协商
  `session.security.inspect` 时构造只读 security port，mutation 本地 unavailable 且不发 frame；无
  domain Runtime 不虚报 approval/security capability。该项闭合新集成计划 S3 的 TUI 接缝，不代表
  B6 全部 governed workflow 或 B7 process/extension 已完成；
- P2-1 generation/typed fence：stale/aborted reset 同样核对 generation；plan/extension 等
  已接通投影继续做枚举与结构校验，未有真实 Host operation 的领域直接 unavailable；
- P2-2 全局 cleanup：`TimelineEvent.cleanup.correlationId` 改 optional，projector 不传时
  reducer 清全部 active rows；`requestQuit` 触发 destroy cleanup；replay tool start/end 不再
  留存 `activeToolPresentation`；
- EffectRunner：`cancel/cancelAll` 同步发出且仅发出一次 aborted result，即使 port 忽略
  AbortSignal 并永不 settle，workflow waiter 也不会永久 loading；重复 `prompt.list` case
  已删除，Vite warning 消失；
- 修复 RED/GREEN：5 个聚焦文件从 10 个预期失败转为 55 tests 全绿；随后
  `npm run check`、全部 Vitest TUI（41 files / 273 tests）、`npm test`（Vitest 220 files /
  1202 tests + Bun native 26 tests / 147 assertions）与 `npm run build` 通过；最终
  `git diff --check` 通过。

## 13. B7：Task/Goal/Plan、Agents、Extensions、Runtime Snapshot 与 Process
### 13.1 RED

- goal/task/plan 只展示 canonical revision/digest，不根据文本估算完成度；
- agent activity 缺 authority 时 unavailable，不构造假 swarm；
- extension identity 使用 qualified id/version/source/digest，display name 不参与路由；
- MCP/plugin/skill/hook snapshot 经过 bounded validator，不扫描目录、不启动 server；
- runtime snapshot 每字段保留 known/unknown/unavailable；
- process list/detail/output cursor/driver revision 复用现有 process controller/reducer；
- observer 的 process terminal 永远没有 writable input。

### 13.2 实现

1. 接入 task-goal、goal-plan、agents、extensions、runtime-snapshot 的只读 query workflow；
2. Timeline 可投影 goal/agent lifecycle row，但不写 canonical state；
3. 将当前 `openMcpServerSelector()`、extension/domain command 的 raw parsing 移入 typed adapter；
4. process passive workflow 与现有 `ProcessOverlayState` 建立纯 bridge/selector；
5. 保留现有 `process/reducer.ts`、`controller-adapter.ts`、output bounds 与 driver/observer 规则；
6. advanced mutation 若没有 Host contract，保持 unavailable，另开 Runtime 专项。

### 13.3 可见结果与门禁

- `/plan`、task/goal、agents、`/mcp`、`/plugins`、`/skills`、`/hooks`、runtime snapshot、
  `/processes` 与 `/terminal` 使用 typed bounded view；
- process output cursor resync、retention 和 observer read-only 回归通过；
- extension/plan/process 不能把 raw Host response 直接拼进 notice；
- 回滚不删除既有 process 专项实现，只移除本批 bridge。



### 13.4 B7 执行证据（2026-08-06）

- `src/tui/process/passive-bridge.ts`：既有 `ProcessOverlayController`/Host client →
  `ProcessPassivePort`（复用现有 reducer/controller-adapter，无第二 manager）；
  observer terminal 无 writable input（`observer_mutation_forbidden`）；output cursor
  有界分页；`InteractiveMode` 构造时注入 bridge 端口；
- `/plan` 迁移到 `plan.inspect` workflow（typed adapter 投影，`openPlanWorkflow`）；
  `compactDomainResult` 保留给 compact/memory（无 passive workflow）；
  inventory retired 断言更新；
- Host adapter 仅为真实 operation 建 port：`plan.inspect`、`extension.inspect`、
  `security.inspect`、`worktree.inspect`；worktree binding 的 head commit/lease revision 投影为
  bounded workspace view；
- task-goal、agents、runtime-snapshot、update 没有生产 Host operation，当前明确
  unavailable，不再到调用阶段才返回 unsupported；
- 测试 `tests/tui/process/passive-bridge.test.ts`（4 例）全绿；
- 当前结论：process/plan/extension/worktree/security 子集有真实通道，B7 整体仍为
  `implementing`；task/goal/agent/runtime/update 需先由对应 Host 专项提供合同。

## 14. B8：退休旧状态、接通性能 fence 与闭合生产入口
### 14.1 RED

- 静态检查阻止 `InteractiveMode` 新增领域 mutable state、直接 Host response parser 和 direct component business mutation；
- `InteractiveMode` 只保留 renderer/lifecycle owner、store/runner composition 与短生命周期 auth secret owner；
- standard `runledger`、remote Host、历史 resume、streaming、tool、overlay、process、shutdown 全链路通过；
- Plan 18 的 burst、1 MiB、10,000 row、scroll anchor、resize storm、frame/projection/native 指标无回归；
- renderer destroy 后无 active effect、subscription、timer、renderer 或 terminal owner 泄漏。

### 14.2 实现

1. 删除已迁移的旧字段、getter、direct query/mutation 和 component map；
2. 增加 TUI application boundary 静态检查；
3. CLI composition root 一次装配 controller/Host ports、store、runner、projectors 和 renderer；
4. effect cancellation 与 session generation/lifecycle cleanup 统一；
5. 复用 Plan 18 frame scheduler/coalescer/cache/viewport，并补 generation invalidation；
6. 回写本计划状态、overview、总索引和实际 evidence artifact。

### 14.3 可见结果与门禁

- 标准 `runledger` 只运行一套 TUI state owner；
- 60/80/143 列、resize、paste、selection、theme、overlay focus、Ctrl+C/Ctrl+D、abort/error
  有 native frame 与受控 PTY 证据；
- 真实 terminal 主观验收仍由用户决定；
- 若性能超出 Plan 18 budget，先定位 projection/reducer/renderer 层，不通过丢语义事件“优化”。

### 14.4 B8 执行证据（2026-08-06）

- `scripts/check-tui-boundaries.ts` 接入 `npm run check`：阻止 InteractiveMode 新增领域
  mutable state（retired owner 字段名 + `Map<` 字段）、非白名单直接 controller/agent
  领域调用、raw Host response 解析（result.servers/result.descriptors 等）；
- `InteractiveMode` 现为 composition/lifecycle/presentation adapter + store/runner 装配点：
  mutable 字段仅剩 streaming/stopReason/streamingGeneration/streamingDeltas/
  pendingMessageBuffers/lastIdleCtrlC/quitting/processOverlayComponent/
  consecutiveInitFailures（inventory characterization 固定）；
- EffectRunner cancel/cancelAll 对不合作 port 同步 settle，后到 Promise 结果按 controller
  identity 丢弃；reducer stale/aborted reset 使用 generation/correlationId/effectId 三重 fence；
- Timeline replay tool cycle 与 live tool end 均释放内部 presentation/chunk 缓存；
- 全链路门禁：`npm run check`（含 tui-boundaries）+ `npm test`（219 files/1185 tests +
  bun 26）+ `npm run build` 全绿；`command -v runledger` 仍指向本 checkout 的
  `bin/runledger.js`。
- 当前结论：本批代码加固已完成，但 B6/B7 authority 缺口仍会使生产能力保持
  unavailable，因此 B8 在依赖批次闭合前保持 `implementing`。

## 15. 每批统一验证门禁

### 15.1 RED -> GREEN 顺序

每批必须按以下顺序保留证据：

1. focused RED test，记录失败原因；
2. 最小实现 GREEN；
3. passive contract boundary tests；
4. pure reducer/projector/adapter focused tests；
5. OpenTUI native frame/input/resize test（有可见行为时）；
6. 标准 CLI/PTY smoke（有生产接线时）；
7. 全仓门禁。

### 15.2 命令门禁

```bash
npm run check
npm test
npm run build
git diff --check
```

执行 native/PTY 前另做：

```bash
command -v runledger
readlink -f "$(command -v runledger)"
readlink -f ./bin/runledger.js
```

只有前两者确认指向当前 checkout 的 `bin/runledger.js`，才把标准 PATH 的结果算作本批证据。
不得用 sibling worktree 或旧全局 link 的输出冒充当前实现。

### 15.3 测试矩阵

| 层 | 必测内容 |
|---|---|
| Contract | import boundary、structured clone、safe fields、current format、exhaustive union |
| Reducer | deterministic、stale fence、uncertain/recovery、illegal transition、cleanup |
| Projector | stable id、bounded text、safe tool、known/unknown/unavailable、responsive view |
| EffectRunner | correlation、AbortController cleanup、乱序、timeout、driver/observer capability |
| Adapter | typed validation、schema mismatch、Host disconnect、revision conflict、bounded payload |
| OpenTUI native | frame、input、paste、focus、resize、theme、destroy；`finally` cleanup |
| Streaming/performance | coalescing lossless、frame fairness、10,000 rows、scroll anchor、cache generation |
| Production | standard `runledger`、local/remote authority、resume、tool、approval、process、shutdown |

## 16. Commit 与回滚边界

本计划不授权当前文档任务创建 commit 或 push。未来执行时建议每批至少一个独立 commit；
B5–B7 按领域拆成更小 commit，不能把所有 selector/mutation 合并成一次大改。

每次提交前：

```bash
git status --short
git branch --show-current
git diff --check
git diff -- <explicit-paths...>
git config --get user.name
git config --get user.email
```

只按显式路径暂存。每个批次的回滚必须能恢复到上一批仍可运行的标准 `runledger`：

- B1 回滚 presentation owner；
- B2 回滚完整 Timeline chain，不保留双写；
- B3 回滚 local interaction store；
- B4 回滚 query runner/adapters；
- B5–B7 按单领域回滚；
- B8 若 closure 失败，回到 B7 的 store/runner 生产状态，不恢复已删除的第二 authority。

## 17. 完成定义

当且仅当以下条件全部满足，才可把本计划标记为 `agent-verified`：

1. B0–B8 状态表和实际 evidence 已回写；
2. 已提前实现的 passive contracts 成为生产 TUI 的真实输入，不再只是 type-only placeholder；
3. `TuiState` 是 client-local interaction/presentation 的唯一 state owner；
4. Runtime/Host/Storage 仍拥有 canonical facts、IO、persistence 与 mutation receipt；
5. replay/live、message/tool/usage、query/mutation 都经过 typed projector/reducer/effect/result；
6. 所有 mutation 有 generation/correlation/effect/revision fence，uncertain 必须 recovery-required；
7. safe presentation 不含 raw args、secret、base64、无界正文或未验证 patch；
8. process overlay 复用现有 reducer/controller，没有第二 process manager；
9. `InteractiveMode` 不再直接维护已迁移领域状态或解析 raw Host response；
10. Plan 17 renderer authority 和 Plan 18 performance authority 未被复制或改写；
11. `npm run check`、`npm test`、`npm run build`、`git diff --check` 全绿；
12. standard `runledger` 的 native frame/PTY 证据绑定到当前 checkout。

`human-verified` 还必须由用户在真实终端确认交互、视觉、输入延迟、滚动和退出行为；自动化
不能代替该步骤。
