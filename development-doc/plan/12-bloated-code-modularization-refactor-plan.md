# RunLedger 臃肿代码模块化重构计划

> 文档状态：partial / blocked（S0–S5、S8、S9 implemented；S6/S7 真实 streaming/human 门禁未闭合；S10 受 Runtime 06 R9 阻塞）<br>
> 建立日期：2026-08-29<br>
> 审计快照：`rollback/before-composer-shape@d0e61db` 加当前未提交 TUI 修改<br>
> 文档职责：定义超大手写文件的拆分顺序、行为冻结方法、阶段门禁与 legacy Host 处置规则；不替代各领域权威计划

## 0. 结论与执行顺序

本计划不按文件行数从大到小机械拆分，而是按生产依赖从底层 authority 向上层 composition 推进。唯一执行顺序如下：

```text
S0  基线、行为表征与边界冻结
  -> S1  SessionStore
  -> S2  Session Security composition
  -> S3  Session Process composition
  -> S4  Agent loop
  -> S5  SessionRuntime
  -> S6  OpenTUI component runtime
  -> S7  InteractiveMode
  -> S8  Provider protocol adapters
  -> S9  Model generator
  -> S10 Legacy Host delete-first 处置与全仓收口
```

这条顺序有三个约束：

1. 标准 CLI 当前从 `src/cli/main.ts` 进入 embedded Session Owner Runtime，不再 import/call `runtime-host-*`；因此当前 Session 路径先拆，legacy Host 不抢占生产路径重构资源。
2. `InteractiveMode` 依赖 Session domain、事件协议和 OpenTUI runtime；必须等这些下层接缝稳定后再拆，避免用 UI adapter 掩盖领域边界问题。
3. provider adapter 与 model generator 虽然文件很大，但领域相对内聚且不阻塞 Session/TUI 模块化；排在核心 runtime 之后处理。

任何阶段都不得跨过前序阶段的退出门禁。若只准备执行某一独立阶段，必须先证明它不消费尚未稳定的前序内部合同，并在计划状态表记录原因；不能默认并行修改共享文件。

## 1. 文档权威与范围

### 1.1 上位事实入口

- Session Owner Runtime 替代与 legacy Host 删除门禁：[`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md)
- TUI 与 Session Runtime 全链路接线：[`01-tui-session-runtime-integration-repair-plan.md`](01-tui-session-runtime-integration-repair-plan.md)
- TUI 当前架构与导航：[`../tui/00-overview.md`](../tui/00-overview.md)
- Runtime 公共合同：[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)
- Session 执行可靠性：[`03-session-execution-reliability-repair-plan.md`](03-session-execution-reliability-repair-plan.md)
- 当前代码能力与开发规则：仓库根目录 `AGENTS.md`

本文只拥有“如何在不改变行为的前提下拆分超大文件”的执行编排。若拆分暴露功能缺陷，先以 RED 测试固化缺陷，再转入对应领域计划修复；不得把功能修复悄悄混入结构重构提交。

### 1.2 纳入范围

当前审计排除 `*.generated.ts` 与 `*.models.ts` 后，手写 `src` 共 703 个文件、约 128197 行：

- 11 个手写生产文件超过 1000 行；
- 14 个超过 800 行；
- 46 个超过 500 行。

本计划纳入以下文件：

| 文件 | 当前行数 | 主要臃肿信号 | 本计划处置 |
|---|---:|---|---|
| `src/tui/interactive-mode.ts` | 3160 | 2824 行类、69 imports、UI 与多领域 workflow 混合 | S7 拆分，保留薄 facade |
| `src/api/openai-codex-responses.ts` | 1586 | SSE、WebSocket、连接缓存、请求映射同文件 | S8.1 按 transport 拆分 |
| `src/api/openai-completions.ts` | 1361 | 331 行 stream、265 行消息转换、compat 探测混合 | S8.2 按 mapping/compat/stream 拆分 |
| `src/api/anthropic-messages.ts` | 1324 | SSE decoder、client、params、message conversion 混合 | S8.3 拆分 |
| `src/tui/opentui/component-runtime.ts` | 1322 | 715 行 factory，节点生命周期与 overlay/render/cache 混合 | S6 拆分，保留 runtime facade |
| `src/cli/runtime-host-service.ts` | 1285 | 951 行 legacy Host 类 | S10 delete-first，不先美化 |
| `src/runtime/agent-loop.ts` | 1256 | 464 行主循环，工具调用各阶段与预算混合 | S4 拆分，保留公共入口 |
| `src/runtime/session-runtime/session-runtime.ts` | 1197 | 1000 行类、261 行 command router | S5 拆为生命周期和 command/query 协作者 |
| `src/cli/runtime-host-model-context.ts` | 1119 | Plan/Context/Memory/Router/Persistence 混合，且属于 legacy Host | S10 delete-first |
| `src/api/bedrock-converse-stream.ts` | 1099 | stream、event mapping、message/request conversion 混合 | S8.4 拆分 |
| `src/storage/session-store/session-store.ts` | 1062 | catalog/event/attempt/checkpoint/projection/SQL mapping 混合 | S1 拆分，保留事务 facade |
| `src/security/session-composition.ts` | 974 | composition root 与 filesystem/network/shell leaf 混合 | S2 拆分 |
| `src/cli/runtime-host-security.ts` | 912 | legacy Host security 双轨实现 | S10 delete-first |
| `src/cli/runtime-host-process.ts` | 775 | legacy Host process 双轨实现 | S10 delete-first |
| `src/runtime/session-runtime/process-composition.ts` | 768 | query/mutation/foreground/output/trace/recovery 混合 | S3 拆分 |
| `scripts/generate-models.ts` | 2439 | 896 行数据加载和 591 行生成函数 | S9 拆分 CLI、source、metadata 与 emitter |

### 1.3 不纳入范围

- 自动生成的 `src/providers/*.models.ts`、`src/models.generated.ts`、`src/image-models.generated.ts`；它们只能通过生成器更新。
- `src/types.ts`、`src/runtime/contracts/inventory.ts` 等以声明为主、几乎没有控制流的文件；行数不是单独拆分理由。
- 新功能、协议字段、持久化格式、provider 行为、TUI 视觉设计或用户设置变更。
- R9 门禁关闭前对 legacy Host 做扩展、兼容 fallback 或大规模重新设计。
- 为达到行数目标而创建无领域边界的 `utils.ts`、`helpers.ts`、`common.ts` 杂物文件。

## 2. 重构不变量

所有阶段必须同时保持以下不变量：

1. 公共 export、npm export、CLI 参数、runtime event/schema、SessionStore schema 与 provider wire 行为不变。
2. 生产 composition 仍 fail closed；不得引入 AllowAll、raw I/O、sandbox fallback 或绕过 ExecutionGateway 的执行叶。
3. Session authority 仍为 `sessionId + owner generation + driver/domain revision`；拆分不能弱化 fence、attempt、receipt 或 recovery barrier。
4. `interactive-mode.ts` 与 API adapter 原有 import 路径继续可用；入口文件只做兼容 facade，不复制实现。
5. 不增加 `any`、`enum`、`namespace`、参数属性或内联 `await import()`；相对路径继续带 `.ts`。
6. 错误 taxonomy、错误 body、SSE terminal event、stop reason、abort 与 timeout 语义逐字节保持。
7. 重构阶段不得顺带格式化无关目录、重写生成物或修改真实用户级 `~/.runledger`。
8. 每个新协作者必须拥有明确输入/输出 port；不得通过导出可变对象或访问另一个类的私有状态完成“拆分”。

## 3. 规模与结构目标

行数只是诊断信号，不是唯一 DoD。对本计划触及的手写文件采用以下 guardrail：

- facade 或 composition root 目标不超过 300 行；
- 单个新实现文件目标不超过 400 行；
- 普通函数目标不超过 80 行；状态机或协议 parser 超过 120 行时必须在文档中说明不能继续拆分的状态一致性原因；
- 单个类不得同时拥有 lifecycle、transport、persistence、presentation 三类以上职责；
- 一个阶段完成后，不得出现“原文件缩短但新建一个同等规模上帝文件”的搬运式拆分。

若为保持原子状态机而合理超过 guardrail，必须记录：共享状态、不能拆分的事务边界、直接测试和后续观察点。不能只写“逻辑复杂”。

## 4. S0：基线、行为表征与边界冻结

### 4.1 任务

1. 记录开始实施时的 branch、HEAD、`git status --short` 与每个目标文件行数；当前文档快照不能替代实施时事实。
2. 当前 TUI 有未提交修改。执行 S6/S7 前必须由原任务完成、提交、转移或明确保留；禁止覆盖、stash 或跨分支切换覆盖这些路径。
3. 为每个目标建立 import/export inventory，确认真实生产入口、测试入口和 legacy-only 入口。
4. 为尚未直接覆盖的拆分边界先增加 characterization tests。测试必须先在旧实现上通过，证明它描述的是既有行为。
5. 将每个大测试文件按行为域列出拆分映射，但本阶段不机械移动测试。
6. 建立本计划专用 size audit 命令或脚本，只报告目标文件和新模块；它是趋势检查，不接管领域正确性。

### 4.2 必须冻结的行为

- SessionStore：事务、hash chain、owner fence、catalog revision、fork、attempt receipt、checkpoint replay。
- Security/Process：prepare/final-leaf/complete 顺序、approval settlement、output cursor、crash uncertainty、Trace terminal settlement。
- Agent loop：steering/follow-up、tool call 顺序、并行/串行选择、预算、abort、truncated tool call。
- TUI：相同 `TuiEvent` 输入产生相同 effect/timeline/frame；overlay focus、scroll、streaming prefix、syntax/mermaid fallback 不变。
- Provider：相同 fixture chunk 产生 byte-equivalent Agent events、usage、stop reason、error 与 terminal event。
- Generator：冻结 source 输入时，生成树 digest 不变。

### 4.3 退出门禁

- baseline inventory 完整；
- focused characterization tests 在旧实现上全绿；
- `npm run check`、`npm test`、`npm run build` 有 fresh 基线记录；
- 若基线已有无关失败，记录精确命令、失败文件和是否影响本计划，不得伪造通过。

## 5. S1：拆分 SessionStore

### 5.1 目标文件

- `src/storage/session-store/session-store.ts`
- 对应 `tests/storage/session-store/**`

### 5.2 目标结构

保留 `SessionStore` 作为唯一注入入口和短事务 owner，抽取纯函数或窄 repository：

```text
src/storage/session-store/
├── session-store.ts              # facade、数据库生命周期、事务编排
├── event-append.ts               # hash input、owner fence、append transaction
├── catalog-repository.ts         # title/create/fork/catalog revision
├── attempt-repository.ts         # intent、attempt、receipt 映射
├── checkpoint-repository.ts      # checkpoint put/get/replay cache
├── session-projection.ts         # title/status projection 与一致性检查
└── row-mappers.ts                # SQLite row -> typed record
```

具体文件名可在实施时调整，但事务边界不能散落到多个公开 service。被抽取模块只接收已打开的窄 transaction/database port，不自行打开第二连接或绕过 owner fence。

### 5.3 TDD 顺序

1. RED：补齐 append/fork/attempt/checkpoint 在 commit failure、stale fence、replay mismatch 下的边界测试。
2. GREEN：先抽纯 hash/projection/row mapper，再抽 repository，最后缩减 facade。
3. STABLE GREEN：原测试无改语义全绿，新增测试直接命中新模块；运行 event-loop latency 与多连接 title tests。

### 5.4 退出门禁

- schema、SQL transaction 次数和 durable event 顺序不变；
- `SessionStore` 仍是唯一对外写入口；
- focused storage tests、`npm run check`、`npm test`、`npm run build` 全绿。

## 6. S2：拆分 Session Security composition

### 6.1 目标文件

- `src/security/session-composition.ts`
- 对应 `tests/runtime/session-runtime/security-composition.test.ts`
- `tests/runtime/session-runtime/session-execution-environment.test.ts`
- `tests/security/**` 中直接覆盖 final leaf 的测试

### 6.2 目标结构

```text
src/security/composition/
├── session-security.ts           # composition root
├── managed-process-security.ts   # process prepare/complete lifecycle
├── permission-requester.ts       # prompt/grant request translation
├── governed-filesystem.ts        # filesystem leaf
├── governed-network.ts           # network leaf
├── governed-shell.ts             # shell + bash classification leaf
├── constraint-providers.ts       # execution/sandbox constraints
└── audit-settlement.ts           # gateway effect 与 classification audit 关联
```

`src/security/session-composition.ts` 保留稳定 re-export/factory facade。Security 配置加载、policy engine、sandbox backend 继续由现有领域模块拥有，不复制到 composition 目录。

### 6.3 硬边界

- governed leaf 必须在最终 I/O 前完成授权；不能因抽取而提前返回 raw execution env。
- `beginAttempt/settleAttempt`、gateway effect 与 approval receipt 的顺序保持。
- bash classification audit link 仍 fail closed；缺失 evidence 不能降级为允许。

### 6.4 退出门禁

- security composition、sandbox、bash AST、ExecutionGateway focused tests 全绿；
- boundary scripts 继续识别唯一生产 security composition；
- 不修改 legacy `runtime-host-security.ts`。

## 7. S3：拆分 Session Process composition

### 7.1 目标文件

- `src/runtime/session-runtime/process-composition.ts`
- 对应 process domain/composition、control-plane、output-store、Trace tests

### 7.2 目标结构

```text
src/runtime/session-runtime/process/
├── composition.ts                # Session-scoped facade
├── query-handler.ts              # list/output/wait/retention query
├── mutation-handler.ts           # spawn/write/eof/resize/stop
├── foreground-execution.ts       # stdlib foreground Bash bridge
├── output-materializer.ts        # bounded output/CAS/Trace materialization
├── completion-settlement.ts      # terminal truth、attempt settlement
├── recovery.ts                   # lost/uncertain recovery projection
└── composite-backend.ts          # pipe/PTY backend selection
```

不得把 `ProcessManager`、`ControlPlane` 或 `FileProcessOutputStore` 复制进新目录。新模块通过现有 port 组合，并保持每个 Session 独立 capacity、revision 与 fence。

### 7.3 TDD 顺序

1. RED：spawn 成功但 revision commit 失败、terminal settlement 重复、observer mutation、output cursor 边界、crash recovery uncertainty。
2. GREEN：先抽 composite backend 与 query，再抽 output/settlement，最后抽 mutation/foreground path。
3. STABLE GREEN：真实 pipe/PTY focused tests 和 Session Owner candidate process 场景通过。

### 7.4 退出门禁

- 不 reattach、respawn 或猜测 takeover 前的进程；
- process Trace terminal、approval settlement 和 recovery barrier 顺序不变；
- 不修改 legacy `runtime-host-process.ts`。

## 8. S4：拆分 Agent loop

### 8.1 目标文件

- `src/runtime/agent-loop.ts`
- `tests/agent-loop.test.ts` 及 tool execution/budget/reliability tests

### 8.2 目标结构

```text
src/runtime/agent-loop/
├── index.ts                       # runAgentLoop 稳定入口
├── loop-runner.ts                 # outer turn / inner stream 状态机
├── context-conversion.ts          # AgentMessage -> LLM Message
├── run-budget.ts                  # active duration/tool failure/budget summary
├── tool-call-preparation.ts       # schema、参数、execution mode
├── tool-call-execution.ts         # execute + abort + error normalization
├── tool-call-finalization.ts      # ledger/event/result/budget settlement
└── assistant-recovery.ts          # truncated/assumed assistant 收口
```

原 `src/runtime/agent-loop.ts` 可以保留为 re-export facade，避免一次性迁移所有 import。loop-runner 只能通过窄回调调用工具 pipeline，不能反向导入 Agent facade。

### 8.3 状态机约束

- outer turn 与 inner assistant stream 的事件顺序不变；
- steering/follow-up 在相同边界被消费；
- tool call preparation 成功后才允许执行；finalization 对每个 prepared call 至多一次；
- abort、budget termination 和 provider error 必须产生原有 stop reason 与 ledger/event 组合。

### 8.4 退出门禁

- agent-loop、tool registry、stdlib agent、reliability focused tests 全绿；
- mock 与 deterministic provider event sequence snapshot 不变；
- 不借重构修改 tool 并行策略或新增功能。

## 9. S5：拆分 SessionRuntime

### 9.1 目标文件

- `src/runtime/session-runtime/session-runtime.ts`
- 已有 `domain-router.ts`、`idle-recap.ts`、`checkpoint.ts`、`recovery-barrier.ts` 等协作者

### 9.2 目标结构

优先复用已有协作者，不新建平行实现：

```text
src/runtime/session-runtime/
├── session-runtime.ts            # lifecycle facade 与 collaborator wiring
├── lifecycle-controller.ts       # start/pause/fenced/orderly shutdown
├── event-persistence.ts          # normalized event、checkpoint boundary
├── attempt-controller.ts         # begin/settle/recovery assess/decide
├── command-handler.ts            # mutation operation router
├── query-handler.ts              # query operation router
└── idle-recap-controller.ts      # 对已有 idle-recap.ts 的 runtime adapter
```

`handleCommand()` 与 `handleQuery()` 必须转为表驱动或窄 handler dispatch；不能把 261 行 switch 原样复制到另一个文件。handler 只获得完成该 operation 所需的 domain port、fence 和 event sink。

### 9.3 TDD 顺序

1. RED：为每个 command/query operation 建立路由表完整性、driver fence、revision、typed unavailable/failed/recovery_required 测试。
2. GREEN：先抽 event/attempt，再抽 query，最后抽 command 与 lifecycle。
3. STABLE GREEN：`red-01` 至 `red-04`、recovery、checkpoint、idle recap、title、extension、multi-agent 与 process integration 全绿。

### 9.4 退出门禁

- SessionRuntime 仍只拥有一个 Session；不引入 machine-wide registry；
- fenced self-stop、attachment lifetime、checkpoint live head 和 recovery barrier 不变；
- embedded production composition 与 RuntimeServer 直接测试通过。

## 10. S6：拆分 OpenTUI component runtime

### 10.1 前置条件

- 当前涉及 `src/tui/opentui/component-runtime.ts` 的未提交修改已安全处理；
- S5 的 Session event/effect 输入合同稳定；
- native Bun 测试可执行。

### 10.2 目标结构

```text
src/tui/opentui/component-runtime/
├── index.ts                       # createOpenTuiComponentRuntime facade
├── frame-runtime.ts               # frame apply/schedule/dispose
├── transcript-runtime.ts          # block identity、diff、scroll、window
├── renderable-registry.ts         # keyed node create/update/dispose
├── overlay-runtime.ts             # text/input/command/select overlay
├── footer-editor-runtime.ts       # editor、footer、status indicator
├── highlight-admission.ts         # settled markdown/highlight budget
└── types.ts                       # private frame/node contracts
```

现有 `component-runtime.ts` 保留稳定 factory export。所有 OpenTUI node 的 create/update/dispose 必须由唯一 owner 管理，不能在多个模块各自缓存同一 node。

### 10.3 TDD 顺序

1. RED：补 overlay 切换/focus/mouse、错误类型 node disposal、sticky scroll、settled prefix、highlight admission 与 dispose 幂等测试。
2. GREEN：先抽纯 presentation helpers，再抽 overlay/registry，随后 transcript，最后缩减 factory。
3. STABLE GREEN：Vitest TUI tests 与全部 Bun OpenTUI tests 全绿。

### 10.4 真实运行门禁

本阶段进入 `dist/`，必须执行：

1. `npm run build`；
2. `which runledger`、`readlink -f "$(which runledger)"` 与 `npm ls -g --depth=0 runledger` 核对链接；
3. 使用隔离 `RUNLEDGER_DIR` 运行标准 PATH `runledger`；
4. tmux 捕获 80/143 列至少一组 transcript、overlay、streaming、退出帧；
5. 真实用户目录不得被测试读写。

自动化和 tmux 证据不能冒充真人 dark/light、真实鼠标、IME 或视觉验收。

## 11. S7：拆分 InteractiveMode

### 11.1 目标文件

- `src/tui/interactive-mode.ts`
- 对应 interactive controls、session workflows、extension/model/auth/process/approval tests

### 11.2 目标结构

```text
src/tui/interactive/
├── interactive-mode.ts           # lifecycle facade、依赖装配、公开查询
├── input-controller.ts           # submit/follow-up/Ctrl+C/Ctrl+D/slash popup
├── event-controller.ts           # TuiEvent -> state/effect/timeline
├── streaming-controller.ts       # delta queue、usage、flush/backpressure
├── session-workflow.ts            # new/resume/fork/rename/catalog
├── model-workflow.ts              # provider/model/thinking
├── auth-workflow.ts               # login/logout/credential reverse
├── extension-workflow.ts          # MCP/Skill/Hook/Plugin
├── approval-workflow.ts           # approval reverse/recovery interaction
├── process-workflow.ts            # process list/terminal
└── plan-workflow.ts               # plan/domain command adapter
```

根 `src/tui/interactive-mode.ts` 保留原 import 入口并转发至新 facade。workflow 不得直接持有 renderer；它返回 typed state/effect/result，由 InteractiveMode 统一展示。Domain request 的 correlation/effect/revision 由单一 request coordinator 生成，不能在各 workflow 各自维护计数器。

### 11.3 拆分顺序

1. 纯查询与 presentation helper；
2. streaming/usage controller；
3. session/model/auth/extension/process/plan workflows；
4. input/slash popup controller；
5. event controller；
6. 最后缩减 constructor、tree assembly 与 `run()` lifecycle。

### 11.4 退出门禁

- 同一输入序列得到相同 TuiEffect、Session request 和 frame；
- workflow 取消、AbortSignal、modal back navigation、session switch intent 和 clean exit 不变；
- S6 的 build、标准 PATH、隔离 home、tmux 门禁全部重跑；
- `interactive-mode.ts` facade 不再拥有 provider/auth/session/extension 的具体业务实现。

## 12. S8：拆分 Provider protocol adapters

Provider 拆分按共享风险从高到低串行执行，每个 adapter 一个独立提交，禁止四个 adapter 同批改动。

### S8.1 OpenAI Codex Responses

目标：`src/api/openai-codex-responses.ts`

```text
src/api/openai-codex-responses/
├── request.ts
├── headers.ts
├── errors.ts
├── sse-transport.ts
├── websocket-transport.ts
├── websocket-cache.ts
└── event-mapper.ts
```

重点冻结 WebSocket continuation cache、首事件输出、close/error mapping、SSE retry-after 与 abort。

### S8.2 OpenAI Completions

目标：`src/api/openai-completions.ts`

```text
src/api/openai-completions/
├── client.ts
├── params.ts
├── message-conversion.ts
├── tool-conversion.ts
├── compat-detection.ts
└── stream-mapper.ts
```

重点冻结 provider/model-specific compat、cache control、reasoning details、usage 与 stop reason。

### S8.3 Anthropic Messages

目标：`src/api/anthropic-messages.ts`

```text
src/api/anthropic-messages/
├── sse-decoder.ts
├── client.ts
├── params.ts
├── message-conversion.ts
├── tool-conversion.ts
└── event-mapper.ts
```

重点冻结跨 chunk SSE line、thinking/signature、cache control、tool result 与 error event。

### S8.4 Bedrock Converse Stream

目标：`src/api/bedrock-converse-stream.ts`

```text
src/api/bedrock-converse-stream/
├── client.ts
├── event-mapper.ts
├── message-conversion.ts
├── tool-conversion.ts
├── request-fields.ts
└── errors.ts
```

重点冻结 content block start/delta/stop、prompt caching、thinking、image block 与 AWS error mapping。

### S8 通用退出门禁

- 原顶层 adapter export 与 lazy adapter import 不变；
- fixture-based chunk/event/usage/error snapshot byte-equivalent；
- proxy injection 与 abort tests 全绿；
- `npm run check`、`npm test`、`npm run build` 全绿；
- 不以缺少真实凭据 E2E 为理由修改协议语义，也不把本次纯重构宣称为真实 provider 验收。

## 13. S9：拆分 model generator

### 13.1 目标文件

- `scripts/generate-models.ts`
- `scripts/ported-provider-catalog.ts`
- 生成物仅作为验证输出，不手工修改

### 13.2 目标结构

```text
scripts/model-generation/
├── options.ts
├── compat-metadata.ts
├── thinking-metadata.ts
├── models-dev-source.ts
├── remote-catalog-sources.ts
├── provider-normalization.ts
├── emit-provider-data.ts
└── emit-model-types.ts
```

`scripts/generate-models.ts` 只保留 CLI 参数解析、source orchestration 与最终退出码。冻结快照模式不得访问网络；remote source 获取必须继续显式受参数控制。

### 13.3 TDD 与生成门禁

1. 先为 `detectOpenAICompletionsCompat`、thinking metadata、models.dev normalization 与 emitter 增加纯 fixture tests。
2. 抽 source adapters，再抽 metadata，最后抽 emitter。
3. 运行 `npm run generate-models`。
4. 在冻结输入下，`src/providers/data/*.json`、`src/providers/*.models.ts` 与 `src/models.generated.ts` 应无非预期 diff；若有变化立即停止，不能把变化伪装成格式更新。
5. 审阅生成结果后运行 `npm run check`、`npm test`、`npm run build`。

## 14. S10：legacy Host delete-first 处置与收口

### 14.1 目标文件

- `src/cli/runtime-host-service.ts`
- `src/cli/runtime-host-model-context.ts`
- `src/cli/runtime-host-security.ts`
- `src/cli/runtime-host-process.ts`
- 以及 `runtime-host.ts`、Host transport/election/build/shutdown 等 R9 inventory 指定文件

### 14.2 硬停点

本阶段必须等待 [`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md) 的 R6.5、R8 与 human acceptance 门禁闭合并授权 R9。门禁未闭合时：

- 文件保持冻结；
- 不拆分、不扩展、不新增兼容调用；
- 只允许修复阻塞 R8/R9 验收的安全或可删除性问题；
- 本计划状态保持 `blocked_by_runtime_06_r9`，不能写成完成。

### 14.3 delete-first 决策

1. 从 `src/cli/main.ts`、bin、package scripts、build manifest、标准 PATH、测试和静态 boundary 脚本建立 reachability inventory。
2. 若只剩 legacy tests/fixtures/imports，先把仍有价值的领域测试迁移到 Session 路径，再按 Runtime 06 R9 整体删除 Host 文件。
3. 若存在经权威计划允许的非标准生产入口，先判断它应迁移到 Session Runtime 还是作为独立产品能力保留。
4. 只有得到“必须保留”的明确结论，才为剩余文件另立最小拆分清单；不能默认执行与 S1–S9 相同的美化重构。

### 14.4 最终退出门禁

- 标准 CLI、package/bin/build 不可达 legacy Host；
- R9 inventory 中授权删除的代码、tests、native helper 与文档同步清理；
- boundary scripts 更新为禁止重新引入 Host production path；
- `npm run check`、`npm test`、`npm run build`、标准 PATH CLI/TTY 与 Runtime 06 candidate/human gates 全部有 fresh evidence。

## 15. 测试文件拆分规则

大测试文件不与生产代码提前分离。每个阶段在生产 seam 稳定后，按行为域拆分对应测试：

| 当前大测试 | 行数级别 | 随阶段拆分为 |
|---|---:|---|
| `tests/tui/opentui-component-runtime.bun.test.ts` | 约 1499 | overlay、transcript、renderable lifecycle、footer/editor、dispose |
| `tests/cli/multi-client/runtime-host-service.test.ts` | 约 1117 | S10 删除或迁移到 Session server/domain tests |
| `tests/runtime/session-runtime/process-composition.test.ts` | 约 920 | query、mutation、foreground、output、recovery/settlement |
| `tests/runtime/session-runtime/security-composition.test.ts` | 约 917 | filesystem、network、shell、managed process、sandbox constraints |
| `tests/tui/interactive-controls.test.ts` | 约 908 | input/lifecycle、slash popup、interrupt/exit、workflow dispatch |

测试拆分必须保持原 assertion 总量与 fixture 语义。不得通过删除重复但语义不同的 fault case 来缩短文件；共享 fixture 只抽取构造数据，不隐藏关键断言。

## 16. 每阶段提交与验证协议

每个阶段使用独立小提交，提交内容只包含该阶段生产文件、直接测试和必要文档状态更新。用户未明确要求时不创建 commit；用户未明确要求时不 push。

每阶段至少执行：

```bash
git status --short
git diff --check
git diff -- <explicit-paths...>
npm run check
npm test
npm run build
```

额外门禁：

- S1：SessionStore multi-connection、latency、migration focused tests；
- S2：Security、sandbox、bash AST 与 ExecutionGateway focused tests；
- S3：真实 pipe/PTY/output 与 Session Owner process candidate；
- S4：agent-loop、tool execution、budget/reliability tests；
- S5：SessionRuntime RED suites、recovery、embedded production composition；
- S6/S7：全部 Bun OpenTUI tests、标准 PATH、隔离 home、tmux frame；
- S8：provider fixture/proxy/abort tests；
- S9：`npm run generate-models` 与生成树 diff；
- S10：Runtime 06 R9 全部门禁。

提交前必须逐路径暂存，不使用 `git add -A`、`git add .`、`git commit -a`、`--no-verify`、stash 或破坏性 reset。当前工作树的无关 TUI 修改始终保留。

## 17. 停止规则

出现以下任一情况立即停止当前阶段并记录 blocker：

1. 拆分需要改变公共 schema、wire、SQLite format、CLI/TUI 行为或 provider compat 才能继续。
2. 目标路径存在来源不明或其他任务的未提交修改，且无法通过显式路径避让。
3. characterization test 无法在旧实现上稳定通过。
4. 新旧实现必须双写、fallback 或复制状态才能保持测试通过。
5. Security/Process 拆分导致 final leaf、attempt、receipt、Trace 或 recovery 顺序不再可证明。
6. 生成器在冻结输入下产生非预期 catalog diff。
7. S10 的 Runtime 06 R9 准入或 human acceptance 未闭合。
8. focused tests 通过但完整 `check/test/build` 出现本阶段相关失败。

停止不等于回滚用户工作。保留已验证的独立小提交或未提交 diff，报告精确 blocker，再决定修复、缩小范围或另立行为变更计划。

## 18. 状态表

| 阶段 | 状态 | 前置条件 | 完成证据入口 |
|---|---|---|---|
| S0 基线与行为冻结 | implemented | 当前工作树审计 | 本文 S0 执行记录 |
| S1 SessionStore | implemented | S0 | storage focused + full gates |
| S2 Session Security | implemented | S1 | security focused + full gates |
| S3 Session Process | implemented | S2 | process/PTY/candidate + full gates |
| S4 Agent loop | implemented | S3 | agent/tool/reliability + full gates |
| S5 SessionRuntime | implemented | S1–S4 | Session Runtime RED/integration + full gates |
| S6 OpenTUI runtime | partial | S5、TUI dirty paths resolved | 代码与 automated 80/143 PATH/TTY 候选通过；真实 streaming 帧与 human visual/mouse/IME 未闭合 |
| S7 InteractiveMode | partial | S6 | workflow/TUI/build 与 automated 80/143 PATH/TTY 候选通过；继承 S6 的 streaming/human 缺口 |
| S8 Provider adapters | implemented | S0；默认排在 S7 后 | adapter fixture + full gates |
| S9 Model generator | implemented | S8 | generated-tree equivalence + full gates |
| S10 Legacy Host | blocked | Runtime 06 R6.5/R8/human acceptance/R9 authorization；blocker=`runtime_06_r9_not_authorized` | Runtime 06 R9 + full/CLI/TTY gates |

阶段状态只能使用 `planned`、`implementing`、`partial`、`blocked`、`implemented`、`accepted`。`implemented` 要求代码和自动门禁完成；`accepted` 还要求该阶段声明的真实运行或人工门禁闭合。历史测试结果不能作为 fresh evidence。

## 19. 最终 Definition of Done

本计划只有在以下条件全部成立时才可标记完成：

1. S1–S9 全部达到 `implemented`，S6/S7 的标准 PATH/TTY、真实 streaming 与本节要求的 human 门禁全部闭合；当前仅 automated Welcome/overlay/clean-exit 候选通过。
2. 目标生产 facade 和实现满足结构 guardrail，或有逐文件的状态机/事务例外说明。
3. 没有新增第二套 authority、双写、fallback、跨层私有状态访问或杂物 helper 文件。
4. 原公共 import、runtime/provider wire、SessionStore durable truth、TUI effect/frame 行为有直接回归证据。
5. legacy Host 按 Runtime 06 R9 被删除；若权威计划决定继续保留，则本文必须先修订范围和理由，不能带着 4 个未处置大文件宣称完成。
6. `npm run check`、`npm test`、`npm run build` 和所有阶段特定门禁提供 fresh 完整输出。
7. 文档状态、`development-doc/00-index.md`、Runtime 06/TUI 权威文档与当前代码事实一致。

## 20. 实施记录(worktree: refactor/modularization)

2026-08-29 的分阶段记录是当时快照；其中的测试数、行数和 PATH 描述不代表当前 fresh 证据。2026-08-30 review remediation 记录是本文当前实现事实的最新入口。

### S0 执行记录(2026-08-29)

- 实施 worktree:`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-refactor-modularization`,branch `refactor/modularization`,HEAD `643cadd`(主 checkout `rollback/before-composer-shape` 同 HEAD,含未提交 TUI 修改)。
- worktree `git status --short` 初始干净(仅复制本计划文档为 untracked);主 checkout 的 `src/tui/interactive-mode.ts`、`development-doc/00-index.md` 未提交修改保留在 S6/S7 前置条件中处理,本分支不触碰。
- fresh 基线(全部通过,无无关失败):
  - `npm test`:Vitest 444 files / 2738 passed + Bun OpenTUI 134 tests / 0 fail;
  - `npm run check`:全部边界脚本 + tsc 通过;
  - `npm run build`:native helper + syntax-highlighter + tsc + assets 通过。
- 目标文件行数(与 §1.2 快照一致,差异 ≤3 行为快照后提交所致):interactive-mode 3160、openai-codex-responses 1586、openai-completions 1361、anthropic-messages 1324、component-runtime 1324、runtime-host-service 1285、agent-loop 1256、session-runtime 1197、runtime-host-model-context 1119、bedrock-converse-stream 1099、session-store 1062、session-composition 974、runtime-host-security 912、runtime-host-process 775、process-composition 768、generate-models 2439。
- 工具:`scripts/check-modularization-size.ts`(S0 §4.1.6 size audit,tsx 运行,不进 check 链)。
- S1 inventory:session-store 唯一对外写入口为 `SessionStore`;内部直接消费者 `owner-store.ts`(appendEventInTransaction/SessionStoreError)、`jsonl-migration.ts`(sessionEventHash)、`projection-repair.ts`(projectSessionStatus/sessionEventHash/SessionStore),均经 facade 重导出保持原 import 路径。测试面已覆盖 append stale hash/fence、fork revision CAS、attempt intent 冲突、checkpoint fence、replay tamper;缺口为 append 事务中途失败回滚原子性、worktree locator stale fence、receipt origin mismatch、driver event stale fence(§5.3 RED 目标,已在旧实现上补 characterization tests)。
- 测试拆分映射(§15,随生产 seam 稳定后执行):session-store.test.ts 现 14 tests,后续按 catalog/event-append/attempt/checkpoint/projection 行为域拆分。

### S1 实施记录(2026-08-29)

- §5.2 结构偏差记录:status projection(`projectSessionStatus`/`releaseReason`)放入 `event-append.ts` 而非 `session-projection.ts`,因为 append 事务内需要计算 status 投影,而 session-projection 的 replay 校验需要 `sessionEventHash`;该归置避免 event-append ↔ session-projection 双向环。文件职责仍与 §5.2 一一对应,仅归置调整。

### S1 完成记录(2026-08-29,fresh gates)

- 最终结构:`session-store.ts` facade(公共类型 + SessionStore 类 + 重导出)+ `session-store-error.ts`(错误 taxonomy,新文件,避免协作者反向 import facade 运行时环)+ `event-append.ts`(hash/fence/append 事务/appendDriverEventInTransaction/status 投影)+ `row-mappers.ts`(rowToEvent/rowToCatalog/rowToAttemptReceipt/catalogSelectSql/boundedTitleRef)+ `session-projection.ts`(replay/rebuild/projectSession/title 投影/一致性检查)+ `catalog-repository.ts`(create/fork/title/reclaim/worktree locator/revision)+ `attempt-repository.ts`(intent/attempt/receipt)+ `checkpoint-repository.ts`(put/get/clear)。
- 行为冻结:admission 门禁仅保留在拆分前原有位置(listSessions/getSession/catalogRevision/reclaim/create/fork);事务内 `SELECT 1 ... admission = 'ready'` 无断言查询原样保留;checkpoint get/clear 与 replay/rebuild 无门禁的现状原样保留。
- RED characterization(旧实现先绿):append 事务中途失败整体回滚、worktree locator stale fence、receipt origin mismatch、driver event stale fence,共 4 个新测试;现总 18 tests 于 session-store.test.ts。
- fresh gates:storage focused 11 files / 72 tests 全绿;`npm run check` 全绿;`npm test` Vitest 444 files / 2742 passed + Bun OpenTUI 134 tests 全绿(2742 = 基线 2738 + 新增 4);`npm run build` 全绿。中途一次 R10 acceptance runner 失败为 worktree 无 `dist/`(gitignored 产物)所致,`npm run build` 后复跑全绿,非代码回归。
- 行数:facade session-store.ts 1062 → 264 行(含公共类型);新模块合计约 850 行,均低于 guardrail。
- 未提交:遵循“用户未明确要求不创建 commit”,全部改动保留在 worktree 工作区。

### S2 完成记录(2026-08-29,fresh gates)

- 最终结构:`src/security/session-composition.ts` 变纯 re-export facade(含 `resolveToolAccessRequestsWithBashAnalyzer` 重导出,维持 bash-ast-security-boundaries 对 composition 入口的静态检查语义);`src/security/composition/` 下 9 个文件:
  - `session-security.ts` root(createSessionSecurity + 选项/结果/identity 类型,约 260 行);
  - `snapshot-loader.ts`(新文件,§6.2 结构调整:loadSnapshot/jsonFileSource/isMissing/isRecord,配置加载域);
  - `permission-requester.ts`(request_permissions 翻译 + authorizationRequest + createAuthorizer,§6.2 结构调整:authorizer 与 request 翻译同域,避免 facade↔leaf 环);
  - `managed-process-security.ts`(prepare/validateFinalLeaf/complete 生命周期 + 请求/结果类型);
  - `governed-filesystem.ts` / `governed-network.ts` / `governed-shell.ts`(三个 governed leaf);
  - `constraint-providers.ts`(executionConstraintInput/createConstraintProviders/sandboxRequest/createWorkspaceEnvelope/ProcessBinding);
  - `audit-settlement.ts`(settleGatewayEffect/linkBashClassificationAudit/unwrapSecurityResult/unwrapSandboxResult)。
- 依赖图无环:leaf/root → permission-requester/constraint-providers → audit-settlement;类型经 `import type` 擦除。
- RED characterization(旧实现先绿,2 个新测试):gateway attempt 在 leaf effect 失败后必须 settle(同一 requestId 的第二次写可重放通过)、malformed managed-process 请求在任何 approval 前被拒。
- 边界:`check-execution-boundaries` 对 `src/security/composition/` 全量扫描通过(raw-fs/raw-process/raw-network 零命中);`bash-ast-security-boundaries` 通过(facade 重导出保持 includes 语义);`check:session-owner-boundaries` 通过。一处 source-text 测试(`production SessionDomain consumes governed env...`)改为断言 `composition/session-security.ts` 的 `await bashAnalyzer.initialize?.()`。
- fresh gates:`npm run check` 全绿;`npm test` Vitest 444 files / 2744 passed(2742 + S2 新增 2)+ Bun OpenTUI 134 tests;`npm run build` 全绿。

### S3 完成记录(2026-08-29,fresh gates)

- 最终结构:`src/runtime/session-runtime/process-composition.ts` 变纯 re-export facade;`process/` 下 8 个文件:
  - `composition.ts` facade(装配 + lifecycle + toolClient + 结果/载荷 helper,约 420 行,超出 400 guardrail 的类是组合根,记录为允许);
  - `query-handler.ts`(ProcessQueryHandler + ProcessResultShaping port 接口);
  - `mutation-handler.ts`(ProcessMutationHandler + ProcessMutationPort);
  - `foreground-execution.ts`(executeForegroundProcess + ForegroundExecutionPort;sameOutputCursor 随迁);
  - `output-materializer.ts`(SessionProcessOutputMaterializer:Trace recorder 映射、finishProcessTrace、readRecoveredOutput;processTraceTerminal 随迁);
  - `completion-settlement.ts`(ProcessCompletionSettlement:authorizationCompletions + processAttempts 映射);
  - `recovery.ts`(recoverUnattachedProcesses/hasProcessRecoveryUncertainty/isTerminalSummary);
  - `composite-backend.ts`(SessionCompositeProcessBackend 原样)。
- 依赖图无环:handlers 通过窄 port(manager/plane/journal/settlement/output/revision/result shaping closures)注入,不反向 import facade 值;facade 只从协作者 import。
- RED characterization(旧实现先绿,2 个新测试):output cursor 校验先于 executionId lookup;stale revision 的 stop 不生效且保留 currentRevision。
- fresh gates:`npm run check` 全绿;`npm test` Vitest 444 files / 2746 passed(2744 + S3 新增 2)+ Bun OpenTUI 134;`npm run build` 全绿;process focused 16 files / 102 tests 全绿。

### S4 完成记录(2026-08-29,fresh gates)

- 最终结构:`src/runtime/agent-loop.ts` 变纯 re-export facade;`agent-loop/` 下 7 个文件:
  - `index.ts`(runAgentLoop/runAgentLoopContinue/defaultConvertToLlm 稳定入口);
  - `loop-runner.ts`(outer turn / inner stream 状态机,约 490 行;双层循环 + fire 闭包共享状态,超 120 行状态机 guardrail 按 §3 例外记录);
  - `context-conversion.ts`(defaultConvertToLlm + serializeAssistant);
  - `run-budget.ts`(validateRunBudget/activeDurationExhausted/repeatedToolFailure/safeFailureDetails/appendBudgetTerminationSummary/isApprovalExpiration);
  - `tool-call-preparation.ts`(PreparedToolCall/resolveExecutionMode/prepareToolCall/prepareToolArguments + executeToolCalls 管线编排);
  - `tool-call-execution.ts`(executePreparedToolCall/codedError/AgentToolExecutedResult);
  - `tool-call-finalization.ts`(finalizeExecutedToolCall/applyToolResultBudget);
  - `assistant-recovery.ts`(failToolCallsFromTruncatedMessage/contextAssumedAssistant)。
- 依赖图无环:loop-runner → {run-budget, context-conversion, tool-call-preparation, assistant-recovery};preparation → execution → finalization → assistant-recovery。
- RED characterization(旧实现先绿,2 个新测试):model_turn_limit budget 终止(agent_end terminationReason + length summary)、steering 只在下一 turn 边界消费。
- fresh gates:`npm run check` 全绿;`npm test` Vitest 444 files / 2748 passed(2746 + S4 新增 2)+ Bun OpenTUI 134;`npm run build` 全绿;agent/overflow/interrupt/queue/stdlib-agent focused 5 files / 25 tests 全绿。

### S5 完成记录(2026-08-29,fresh gates)

- 最终结构:`src/runtime/session-runtime/session-runtime.ts` 保留公共类型 + SessionRuntime 装配类(约 480 行,低于 500;组合根记录为允许);同目录新增 6 个协作者:
  - `lifecycle-controller.ts`(SessionLifecycleController,runtime state 唯一 owner:start/pause/fenced/orderly shutdown + stopped promise;boundedWait 随迁);
  - `event-persistence.ts`(SessionEventPersistence:runTiming/stream coalescer 所有者,persist*/checkpointState/putCheckpoint/currentHeadSequence/persistAbortedRunIfNeeded/withHumanInputWait/runSummaries;checkpointBoundaryForAgentEvent 随迁);
  - `attempt-controller.ts`(SessionAttemptController:begin/settle/unresolved/recoveryAssess/recoveryDecide;isTerminalAttemptOutcome 随迁);
  - `command-handler.ts`(SessionCommandHandler:只保留统一 driver fence + typed table dispatch);`command-routes.ts` 组装 conversation/model/account/domain/recovery 五个窄路由组，`command-values.ts` 保留纯值转换;
  - `query-handler.ts`(SessionQueryHandler:handleQuery;从 command-handler import safeJson/objectValue);
  - `idle-recap-controller.ts`(SessionIdleRecapController:editorEmpty/epochReady/status 字段 + handleDomainAgentEvent/currentIdleRecapActivity/arm/notify/clear)。
- 依赖图:协作者经窄 port 注入(state getter/setter、emit、barrier、onFenced、persistence/idleRecap 实例引用);全部类型经 `import type` 擦除,无运行时环。
- RED/Green:2026-08-30 新增 `command-routing-structure.test.ts`，先因 `command-routes.ts` 不存在且巨型 switch 仍在而 RED；现锁定 19 个命令恰好注册一次、每组不超过 6 个且 facade 无 `switch(request.kind)`。driver fence、domain revision、recovery barrier 行为回归 44 tests 通过。
- fresh gates:`npm run check` 全绿;`npm test` Vitest 444 files / 2748 passed(与 S4 持平,无新增测试)+ Bun OpenTUI 134;`npm run build` 全绿;session-runtime focused 33 files / 216 tests 全绿。

### S6 历史实施记录(2026-08-29，已被 2026-08-30 review remediation 更新)

- 当时结构:`src/tui/opentui/component-runtime.ts` 变纯 re-export facade;`component-runtime/` 后续在 2026-08-30 继续拆分，以本文末 review remediation 为准:
  - `index.ts`(createOpenTuiComponentRuntime(FromRenderer) factory:节点装配 + 输入/resize/theme/frame 事件接线 + 销毁权;`let mermaidThemeMode` 供 render node 闭包);
  - `frame-runtime.ts`(OpenTuiFrameRuntime:body/overlay 注册表 + settled markdown + scroll/editor/footer/overlay 应用 + highlight admission);
  - `transcript-runtime.ts`(block 身份/diff/scroll/窗口纯函数);
  - `overlay-runtime.ts`(overlay 节点注册表);
  - `footer-editor-runtime.ts`(RunLedgerTextareaRenderable + styledFooter + statusIndicatorPlainText + promptStyledText);
  - `highlight-admission.ts`(settled markdown span + highlight admission);
  - `input-normalization.ts`(key → normalized input);
  - `types.ts`(公共 + 私有契约)。
- 重要事实:read 工具相对路径解析到主 checkout,而主 checkout 的 TUI 文件正被并行 TUI 任务修改,导致初版抽取混入主仓 dirty 版本(空 renderCursor stub、footer 无 marginTop、styledFooter 加 "  " 前缀)。已逐函数与 `git show HEAD` 比对修正;教训记录:本分支后续 TUI 读取一律用绝对路径或 git show。
- fresh gates:`npm run check` 全绿;`npm test` Vitest 444 files / 2748 passed;`npm run build` 全绿;Bun OpenTUI 134 tests 全绿(拆分前 134 → 拆分后 134,含 opentui-component-runtime 大套件)。
- 真实运行门禁(worktree 构建):链接核对 `which runledger` → `/home/nzq/.npm-global/bin/runledger` → 主 checkout(npm link 指向主仓,文档化);worktree 构建经生产执行路径 `bun dist/cli/cli.js` 验证(launcher 即 spawn bun,非裸 node——裸 node 无 node:ffi 属预期失败)。
  - 隔离 `RUNLEDGER_DIR=/tmp/rl-s6d-home`:Welcome/transcript 帧(branch refactor/modularization)、`/` 命令 overlay 帧(/clear /new /resume /fork /rename /provider /login)、Ctrl+D 干净退出帧全部捕获;
  - 隔离 home 仅含 auth.json/state.db/tmp(0600);真实用户目录零写入。

### S7 完成记录(2026-08-29,fresh gates)

- `src/tui/interactive-mode.ts` 3161 → 1328 行 facade;`src/tui/interactive/` 下 14 个文件(types/input-controller/event-controller/event-helpers/streaming-controller/session-workflow/model-workflow/auth-workflow/extension-workflow/plan-workflow/process-workflow/approval-workflow/input-helpers),依赖图无环。facade 保留:constructor 装配、assembleTree(只填充 refs 成员,port.refs 是同一对象)、run/quit/requestExit、命令注册表 dispatchCommand、FooterSnapshotProvider 查询、公开 selectors(session/model/extension/process/theme)、createEffect/waitForWorkflow/replayInitialHistory;具体 provider/auth/session/extension 业务实现全部移出。
- 协作者经 `InteractiveModePorts` 注入;可变成员(quitting/hostConnectionState/processOverlayComponent/controller/agent)用 getter 保持实时视图——初版按值捕获导致 `/processes` overlay 不打开与 `/plan` 查询 0 次,已修正并有测试锁定(interactive-controls / extension-selectors)。
- 行为回归:`handleEvent`/`dispatchTimeline`/`createEffect`/`requestQuit` 等经测试 cast 访问的成员以 public facade 委托保留;`getUsageSnapshot` 按原类在 constructor bind(this)。
- 源文本 characterization 按批次迁移协议更新:`interactive-mode-inventory.test.ts` 的流式字段断言指向 streaming-controller,`authority-map.test.ts` 的 approval 解析断言指向 approval-workflow;approval-workflow 用结构投影 `HostReverseFrame` 替代 legacy Host import,保持 check-session-owner-boundaries R0 豁免不变。
- fresh gates:`npm run check` 全绿(含 platform/tui/session-owner/bash-ast boundaries);`npm test` Vitest 444 files / 2749 passed(拆分前 2748,新增 inventory 断言);`npm run build` 全绿;Bun OpenTUI 134 tests 全绿(1029 assertions)。
- 真实运行门禁(worktree 构建 `bun dist/cli/cli.js`,隔离 `RUNLEDGER_DIR=/tmp/rl-s7-home`):Welcome 帧、`/` slash popup 帧(/clear /new /resume /fork /rename /provider /login 可见)、`/model` Select Model overlay 帧、Ctrl+D 干净退出全部捕获;隔离 home 仅 auth.json/state.db;真实用户目录零写入。
- guardrail 例外(§3.107 逐文件记录):`interactive-mode.ts` 1328 行 —— composition root:单一 port 对象喂给 14 个协作者,port 实现(createEffect/waitForWorkflow/nextCorrelationId/nextEffectId 计数)与命令注册表 dispatchCommand 是唯一 composition authority,拆出会引入第二套 effect/correlation 计数或第二命令路由;公开 FooterSnapshotProvider 与 InteractiveModeOptions 等公共契约必须留在根文件。直接测试:interactive-controls(29)/session-workflows(13)/slash-popup-interaction/extension-selectors/regression-fixes 全套 651 tests + Bun 134 + 真实 TUI 帧。

### S9 完成记录(2026-08-29,fresh gates)

- `scripts/generate-models.ts` 当前 120 行，只保留 direct-entry CLI 解析、source orchestration、emitter 调度与退出码;`scripts/model-generation/` 下 8 个文件(options/compat-metadata/thinking-metadata/models-dev-source/remote-catalog-sources/provider-normalization/emit-provider-data/emit-model-types),依赖图无环:
  - `options.ts` 参数解析;`compat-metadata.ts` compat 常量与探测/合并/应用;`thinking-metadata.ts` thinking level 映射与应用;`models-dev-source.ts` models.dev 接口 + 纯归一化 + loader;`remote-catalog-sources.ts` NVIDIA NIM/OpenRouter/AI Gateway fetch;`provider-normalization.ts` 全量归一化与去重;`emit-provider-data.ts` `src/providers/*.models.ts` + `data/*.json`;`emit-model-types.ts` `src/models.generated.ts` + JSON 目录 dump。
  - import 副作用消除:argv 解析移入 main-entry 守卫，宿主进程带无关 argv 时 import 不再抛错;`generateModels(options,deps)` 显式导出。`--source remote|frozen` + `--frozen-input` 是唯一 source authority，frozen 模式零 `fetch`;双运行生成 85 个文件逐字节等价。
- **生成树等价性(冻结输入)**:refactor 分支输出与 pristine HEAD 生成器同日同输入输出逐字节一致 —— `diff -rq src/providers` 0 差异、`src/models.generated.ts` identical。HEAD 提交树与 HEAD 生成器本身有 50 文件 drift(上游 models.dev/OpenRouter 数据移动,pristine HEAD 在 /tmp/rl-head-check worktree 复跑同样产生 50 文件 diff)→ 该 drift 是基线陈旧,非本阶段 artifact;已 `git checkout -- src/providers src/models.generated.ts` 还原,保持本阶段 diff 只含生成器代码。
- 纯 fixture tests(`tests/scripts/model-generation.test.ts`,26 tests,无网络):detectOpenAICompletionsCompat 9 例(zai/together/moonshot/deepseek/nvidia/ant-ling/openrouter anthropic 与非 anthropic)、applyThinkingLevelMetadata 9 例(deepseek-v4 直连与 openrouter、gpt-5.x responses、xai grok-4.5、anthropic adaptive thinking、opencode-go glm-5.2、gemini-3-pro)、normalizeModelsDevData 5 例(bedrock eu base + jamba/mistral 跳过、anthropic 无 tiers、github-copilot tiers、nvidia NIM 归一化、xiaomi token-plan 变体)、emitters 3 例(排序 catalog/data json/aggregator/jsonOutputDir dump)。
- fresh gates:`npm run check` 全绿(含 current-format 内部代际标记扫描,fixture id 避开数字代际标记误报);`npm test` Vitest 445 files / 2775 passed(基线 444/2748,新增 26 fixture tests);`npm run build` 全绿;Bun OpenTUI 134 tests 全绿。
- guardrail 例外(§3.107 逐文件记录):`models-dev-source.ts` 996 行 —— models.dev 归一化是对共享 `models` 累加器的单遍顺序映射(per-provider 块共享跳过/回退逻辑),拆分会散落累加器;`provider-normalization.ts` 533 行 —— 顺序 catalog 变换管线(覆盖 → 合成模型 → 去重 map),与 models-dev-source 同理;`compat-metadata.ts` 438 行 —— 数据密度高(常量 + 纯谓词),非逻辑密度。三者均有直接测试(models-dev-source/provider-normalization 由生成树等价性 + normalizeModelsDevData fixture 覆盖,compat-metadata 由 9 例 detect fixture 覆盖)。

### S8 实施记录(2026-08-29)

- 顺序调整记录(§0 例外规则):S8 在 S7 之前实施。S8 前置条件仅为 S0,且 provider adapter 不消费 S7 内部合同;S7 因 InteractiveMode 类 2824 行/60 字段的耦合度仍处于 implementing,按 §0 先执行不阻塞的独立阶段并在此记录原因。
- S8.1 OpenAI Codex Responses(implemented):`src/api/openai-codex-responses.ts` 1586 → 339 行 facade;`openai-codex-responses/` 当前 9 个实现文件，其中 WebSocket frame decode/terminal/error 状态机拆到 `websocket-frame-stream.ts`(140 行),`websocket-transport.ts` 降到 295 行。公共 export 与 lazy adapter 路径不变。

### S8 完成记录(2026-08-29,fresh gates;每个 adapter 独立实施)

- S8.2 OpenAI Completions(implemented):facade 1361 → 393 行(stream/streamSimple + convertMessages 重导出);`openai-completions/` 8 文件(client/params/chat-template/message-conversion/tool-conversion/compat-detection/stream-mapper/types),依赖图无环。
- S8.3 Anthropic Messages(implemented):facade 1324 → 371 行;`anthropic-messages/` 7 文件(sse-decoder/event-mapper/client/params/message-conversion/tool-conversion/types)。
- S8.4 Bedrock Converse Stream(implemented):facade 1099 → 330 行;`bedrock-converse-stream/` 7 文件(client/event-mapper/message-conversion/tool-conversion/request-fields/errors/types);`resolveBedrockProxyUrl` 经 facade 重导出(测试直接消费)。
- 2026-08-30 新增协议级 characterization:Bedrock content event/usage/terminal、Codex WebSocket completed/failed、Anthropic split-chunk SSE、OpenAI usage/stop/error 共 4 tests。其中 Anthropic CRLF 跨 chunk 先 RED（一个 event 被拆成两个），修复后与既有 proxy 用例共 10/10 通过。

### S10 状态复核与最终 DoD 审计(2026-08-29,fresh gates)

- S10 保持 `blocked`(blocker=`runtime_06_r9_not_authorized`),证据:
  - `src/cli/main.ts` 对 `runtime-host` 的直接 import 数为 0(仅保留注释说明标准入口不再调用 legacy Host);
  - Runtime 06 权威文档状态:R0–R6 implemented,R6.5 Linux candidate PASS but not accepted,R7 标准 CLI 已切换,R8 partial/not accepted,R9 not started(旧 Host 仅保留为安全窗口);
  - legacy Host 仍可达的路径仅为验证脚本(verify:multi-client-host / verify:host-build-replacement / verify:runtime-host-audit)与 legacy tests,不进入标准 PATH/CLI/build manifest。
- **范围权威修正(2026-08-30)**：取消“把 S10 移出 DoD”的日志式说法。S10 仍是本计划 §19 的闭环条件；Runtime 06 R9 未授权时必须保持 `blocked`，整体文档保持 `partial / blocked`，不得标记完成或 accepted。
- 当前 DoD 审计:
  1. S0–S5、S8、S9 代码与自动门禁 implemented；S6/S7 代码 implemented，但因真实 streaming 帧和 human visual/mouse/IME 未闭合，阶段状态保持 `partial`。
  2. `check-modularization-size.ts` 现以 Git HEAD 为基准，只报告 107 个真实新增/未跟踪模块；超过 400 行的仅 `models-dev-source.ts`、`provider-normalization.ts`、`loop-runner.ts`、`compat-metadata.ts` 四个已记录例外，其余真实新模块均在 guardrail 内。
  3. S5 巨型 switch 已消除；S6 `frame-runtime.ts` 163 行、`renderable-registry.ts` 220 行、`overlay-controller.ts` 136 行，body/overlay 各自只有一个 node lifecycle owner;Codex `websocket-transport.ts` 295 行。
  4. frozen source 双运行生成 85 文件逐字节相同且零网络；remote 仍是 `npm run generate-models` 的默认显式 source。
  5. controlled PATH shim 明确解析到本 worktree `bin/runledger.js`，隔离 `RUNLEDGER_DIR` 下 80/143 列 Welcome、slash overlay 与 Ctrl+D clean exit 候选通过；全局 npm link 未更改且仍指向主 checkout。该证据不等于 streaming 或 human acceptance。
  6. S10 仍 `blocked`(blocker=`runtime_06_r9_not_authorized`)，legacy Host 未删除。
- 2026-08-30 fresh automated gates:`npm run check` 全绿;`npm test` 全绿(含 Bun OpenTUI 134 tests / 1033 assertions);独立 Vitest 复跑为 451 files / 2787 passed / 3 skipped / 0 failed;`npm run build` 全绿;最终文档收口后的 `git diff --check` 与 current-format boundary 6 tests 均通过。
