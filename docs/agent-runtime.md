# RunLedger Agent Runtime：从“会调用工具的循环”到可治理执行系统

> 本文依据 [`development-doc/runtime/04-governed-agent-harness-runtime-plan.md`](../development-doc/runtime/04-governed-agent-harness-runtime-plan.md) 整理。
> 对应代码快照为 `feat/agent-loop-resurrect@678b046`，复核日期为 2026-07-24。
> 本文用于解释设计；实时完成状态仍以主计划 §0.0、各 Phase 文档及其 commit/test evidence 为准。

## 1. 一句话认识 RunLedger Agent Runtime

普通 Agent Runtime 常被理解成一个循环：

```text
把消息发给模型
  -> 模型返回文本或工具调用
  -> 执行工具
  -> 把结果再发给模型
  -> 直到模型说完成
```

RunLedger 保留了这条基础链路，但它要解决的是更难的问题：

> 当 Agent 会改代码、运行命令、访问网络、调用其他 Agent，并且进程可能随时崩溃时，系统怎样证明“谁在什么约束下做了什么、结果是否真正落盘、重启后能否安全继续、成功结论是否可信”？

因此，RunLedger 的 Agent Runtime 不是单纯的 LLM 调用器，而是一套面向可审计执行的治理内核。可以把它理解为以下系统的组合：

- Agent loop：负责模型、消息和工具调用的基础循环；
- 飞行记录器：用可校验事件记录每次状态变化；
- 调度器：决定下一步允许执行什么，而不是把控制权完全交给模型；
- 权限与隔离边界：副作用必须带可验证的 workspace、capability 和 sandbox 证据；
- 证据系统：产物、测试、审查、成本和完成结论都有结构化引用；
- 控制平面：CLI、TUI、daemon 或未来客户端通过同一协议观察和控制 Runtime；
- 恢复系统：崩溃、超时和“副作用是否发生不确定”都有明确终态。

项目的目标不是让 Agent 看起来更自主，而是让自主行为保持有界、可恢复、可解释。

### 1.1 先认识几个常用术语

| 术语 | 在本文中的含义 |
|---|---|
| Event | 一次已经发生或已经决定的状态变化，例如 tool started、permission denied、session stopped |
| Event Store | 按严格顺序保存 canonical event 的事实源 |
| Projection | 从事件重放得到的当前视图，例如 TUI 状态、活动列表或成本汇总；它可以重建，不是第二个事实源 |
| Receipt | 另一个组件对“某项检查或副作用确实发生”的结构化回执，通常绑定 identity、revision、digest 和 generation |
| Durable | 不只写入了进程缓冲区，而是到达协议要求的持久化边界 |
| Fencing | 让旧 writer、旧 runtime generation 或旧 handle 即使仍存活也不能继续提交 |
| Reconciliation | 当外部副作用结果不确定时，通过可验证证据确定最终状态，而不是猜测或直接重试 |
| Taint | 对不可信来源的持续标记；内容被摘要、转交或写成 Artifact 后也不能自动消失 |
| Attestation | 由可信 signer、平台或远端 executor 证明某项身份或执行环境，不等同于普通哈希校验 |
| EpisodeSeal | 对一次 Goal 执行证据集合的最终封存；它是进入 completed 的必要条件之一 |

## 2. 为什么基础 Agent Loop 不够

RunLedger 早期已经具备 `Agent`、`runAgentLoop`、provider 抽象、工具注册、JSONL ledger 和 TUI。这足以运行一个模型并完成工具调用，但不能自动得到“企业级可审计”。

下面这些问题都无法只靠一个循环可靠解决：

| 问题 | 只用普通循环时的风险 | RunLedger 的处理方向 |
|---|---|---|
| 进程在写文件后崩溃 | 不知道工具究竟有没有生效，重试可能重复修改 | 记录 intent、durable receipt 和 terminal event；不确定时暂停并对账 |
| 两个 Runtime 同时恢复同一会话 | 双写、重复工具调用、旧进程继续越权执行 | single writer、writer epoch、lease 和 fencing |
| 模型说“测试通过” | 自述被误当成可信结果 | 独立 Verification、Finding、EpisodeSeal |
| 子 Agent 继续派生子 Agent | 深度、数量、成本和权限无限扩张 | root budget、深度/数量上限、权限单调收窄 |
| CLI 和 TUI 各自保存状态 | 断线或重启后状态分叉 | Event Store 为事实源，所有界面只消费 projection |
| 插件或仓库配置声明自己可信 | 恶意内容借配置获得执行权限 | identity、digest、provenance、approval 与 capability 分离 |
| 日志能被修改 | 无法判断历史是否被篡改 | sequence、payload digest、hash chain 和可选签名锚点 |
| 某个安全组件不可用 | 系统悄悄退化到无隔离执行 | fail closed，能力不公布或返回 typed unsupported |

这就是主计划把 Runtime 从“工具循环”提升为 “Governed Agent Harness” 的原因。

## 3. 两层 Runtime：兼容执行层与治理层

RunLedger 没有一次性删除旧实现，而是保留两层：

### 3.1 v2/兼容执行层

这层包含：

- [`src/runtime/agent-loop.ts`](../src/runtime/agent-loop.ts)：模型和工具的双层循环；
- [`src/runtime/agent.ts`](../src/runtime/agent.ts)：有状态 Agent 包装；
- [`src/runtime/tool-registry.ts`](../src/runtime/tool-registry.ts)：工具注册和上下文投影；
- [`src/runtime/execution-env.ts`](../src/runtime/execution-env.ts)：文件系统与 shell 抽象；
- [`src/runtime/interactive-session-controller.ts`](../src/runtime/interactive-session-controller.ts)：现有交互会话；
- stdlib 工具、mock stream、旧 ledger/session 兼容入口。

它的价值是维持现有 CLI/TUI 和 provider 能力，也为 v3 迁移提供真实旧数据，而不是假设一个全新的世界。

### 3.2 v3/可治理执行层

治理层位于 [`src/runtime/protocol/v3/`](../src/runtime/protocol/v3/)、[`src/runtime/session/`](../src/runtime/session/)、[`src/runtime/orchestrator/`](../src/runtime/orchestrator/)、[`src/runtime/verification/`](../src/runtime/verification/) 等目录。

它不只是给旧消息多加几个字段，而是重新定义：

- 什么是一次合法的状态变化；
- 什么结果可以在崩溃后恢复；
- 什么副作用允许开始；
- 什么证据可以支撑“已完成”；
- 什么能力可以通过生产控制平面对外公布。

兼容策略是：

- v1 始终只读；
- v2 在 `sessionV3=off/opt_in` 时继续沿现有路径读写；
- v3 新治理语义只写入 v3；
- 当 rollout 进入 `default/required` 后，旧格式转为只读，通过显式 migrate 或 fork 进入 v3；
- 不会在旧日志上伪造不存在的哈希、工具参数、reasoning 或验证证据。

这样做比原地升级旧记录更保守，但能避免把“解析得出来”误判成“具有新版本的审计保证”。

必须特别注意：当前 [`DEFAULT_RUNTIME_FEATURES`](../src/runtime/runtime-features.ts) 全部为关闭状态。v3 治理保证需要显式 rollout，并通过 production composition/readiness 校验。旧 v2 兼容路径仍允许在没有 Session Kernel 时直接执行 legacy tool，它不自动继承本文后续列出的全部 Gateway、Sandbox、durability 和 Verification 保证。

### 3.3 参考已有 Agent 项目，但不直接照搬

主计划从多个项目取样：

- pi：Provider 与 Agent Core 解耦、stream 注入、工具循环和 harness 恢复思路；
- Codex：版本化控制平面、durable graph、订阅和 runtime residency；
- grok-build：task/subagent、worktree、预算和工具协议；
- claude-code-bun：服务分层、restore、cost、shutdown 和 verification 组织方式。

这些只是设计输入，不是 RunLedger 的运行时依赖，也不代表对上游当前行为的完整复刻。RunLedger 额外要求 authority/tenant correlation、严格 event chain、capability receipt、uncertain effect reconciliation、独立 Verification 和 fail-closed production composition。

计划中的参考 checkout 也只是特定时间的机制快照。真正迁移某项实现前，仍需重新核对上游版本、许可证、行为测试和 RunLedger 的 TypeScript 约束。

## 4. 总体架构

RunLedger 选择“模块化单体 Runtime + 可独立运行的 daemon”，没有立即拆成微服务。

```text
CLI / TUI / future IDE / CI client
                  |
                  v
          Runtime Control Plane
           |               |
           |               +---- Event subscription / projections
           v
    Deterministic Orchestrator
      |         |          |
      v         v          v
  Session     Model     Workspace refs
  Kernel      Router       |
      \         |          /
       +--- Capability Gateway ---+
                       |          |
                       v          v
                 Tool Runtime   Credential port
                       |
                       v
               Verification Pipeline

Canonical Event Store ---> Snapshot / Artifact CAS / Telemetry spool
```

### 4.1 为什么先做模块化单体

治理系统最难的是语义一致，不是网络拆分。若过早拆服务，会同时引入：

- 分布式事务；
- 网络重试和消息重复；
- 跨服务版本协商；
- 更多难以恢复的中间状态。

因此，当前实现先在一个 TypeScript 包中冻结事件、receipt、状态机和 adapter port。未来 Event Store、Artifact Store、Executor 或 Verification Runner 可以迁出进程，但必须继续通过同一套契约和故障测试。

### 4.2 “唯一事实源”不等于“所有数据塞进一个文件”

Event Store 是 Runtime 状态转换的唯一事实源，但以下对象仍有各自的权威存储：

- credential；
- 组织策略和 trust root；
- workspace lease；
- Artifact blob；
- 外部 forge、remote executor 或 SIEM 的终态。

事件只保存它们的 ID、digest、receipt、generation 和状态引用，不保存 secret 本文，也不复制外部系统的全部状态。

跨存储修改采用统一顺序：

```text
intent event
  -> 幂等的 durable object/CAS mutation
  -> committed event
  -> recovery 时对 orphan 或 uncertain effect 做 reconciliation
```

这条顺序解决了“文件已经写成，但成功事件没来得及落盘”一类典型崩溃问题。

### 4.3 Contract-first 的实现约束

治理语义不能只存在于 TypeScript 接口，因为外部输入、旧日志和跨进程消息在运行时仍可能不合法。v3 协议因此同时要求：

- 静态 TypeScript 类型和运行时 TypeBox schema；
- exact object，默认拒绝未知字段；
- branded runtime ID，并绑定 authority/tenant scope；
- event catalog、payload union、state transition 和 version fence 同步变更；
- 字符串、数组、payload 和日志记录都有明确 size bound；
- canonical JSON 规则固定，不能依赖偶然的 `JSON.stringify` 字段顺序；
- 协议修改同时更新 golden fixture、reducer 和 compatibility test。

仓库实现继续遵守严格、可擦除的 TypeScript 语法，不以 `any`、宽松 `Record<string, unknown>` 或领域私有 event 绕开公共协议。

## 5. 一次受治理执行如何发生

以“一次模型要求修改文件并完成任务”为例，启用 v3 governed session 且生产依赖齐备时的理想链路如下：

1. Control Plane 接收带 identity、expected revision 和 idempotency key 的命令。
2. Session Kernel 校验当前 writer、generation、事件头和 stop 状态。
3. Orchestrator 根据 Goal/Task 状态决定是否允许进入下一阶段。
4. Model Router 选择与当前上下文、工具和 reasoning 状态兼容的模型配置。
5. 模型请求先形成可关联事件，返回的工具调用不会直接执行。
6. Tool Runtime 要求有效的 Workspace Envelope，并把 capability 请求送入 Gateway。
7. Gateway、Approval、Sandbox 或 Credential 任一必需证据缺失，调用立即拒绝。
8. 工具开始、结束和失败均写入唯一 terminal event；terminal durable 前不会发下一次模型请求。
9. 工具输出进入 Artifact 或受限的 tool result projection，而不是被当成天然可信文本。
10. 构建、测试、Secret Scan、依赖检查和 Review 形成 Verification evidence。
11. Episode Manifest 汇总 event head、workspace、Artifact、permission、cost 和 verification 引用。
12. 只有无自引用、可验证的 EpisodeSeal 落盘后，Goal 才可能进入 completed。

这条链路有意让“模型生成下一段文本”和“系统承认任务完成”成为两件不同的事。

## 6. 关键特点及其设计原因

### 6.1 可校验的 Session Kernel

v3 session 使用严格、带哈希链的 canonical event log。核心属性包括：

- 每个 stream 内 sequence 连续；
- 每个 payload 有 canonical digest；
- event hash 绑定前一事件；
- accepted 与 durable receipt 分开；
- single writer 与 writer epoch；
- snapshot、fork、stop、migration 和 recovery 都由事件描述；
- 未知 schema、中间坏行、sequence 缺口或 hash 断链默认停止恢复。

为什么不简单地“跳过损坏行继续”？

因为在审计系统中，跳过一行可能正好跳过一次工具执行、权限决定或 stop 指令。RunLedger 宁可把会话标为 `corrupted/paused`，也不在证据不完整时自动续跑。

本地 canonical backend 当前固定为 strict hash-chained JSONL。SQLite 可以承担可重建 projection，但在通过同一 Event Store conformance/fault suite 前，不会成为第二个 canonical 真源。

### 6.2 副作用前置授权，而不是事后记日志

仅记录“工具执行过”不等于治理。RunLedger 要求副作用在开始前满足：

- 有效 Workspace Envelope；
- 当前 lease、owner 和 generation 可验证；
- capability decision 与调用内容精确绑定；
- `deny > ask > allow`，低优先级策略不能放宽 deny；
- 需要审批时有当前、未过期、未撤销的 receipt；
- sandbox/path guard/credential broker 等必需组件健康；
- request、decision、execution receipt 能用同一 correlation 串起来。

如果这些组件不可用，生产路径不会降级到 `AllowAll`、共享 workspace 或无 sandbox，而是返回明确错误。

Runtime 本身主要拥有中立协议、event 和 adapter port。真实 worktree、path broker、PermissionEngine、Gateway、Sandbox 和 credential 注入由 Worktree/Sandbox/Permission 专项实现。这种所有权分离避免 Runtime 目录里再长出一套较弱的“临时安全实现”。

### 6.3 确定性 Orchestrator

模型擅长提出候选动作，不适合担任最终状态机。RunLedger 的 Orchestrator 管理：

- Goal 状态转换；
- Plan/Task DAG；
- queue 和 safe point；
- retry、loop breaker 和 uncertain gate；
- build/test/review/remediation/reverification 顺序；
- terminal semantics。

“确定性”并不表示模型输出可预测，而是指：

- 同一组 durable events 重放后得到相同 projection；
- 模型、TUI 或普通 adapter 不能绕过状态机直接写 `completed`；
- crash/replay 不会改变当前 phase、队列归属或预算结算；
- retry 不会把一次不确定的外部副作用再执行一遍。

### 6.4 多维预算不是简单 token 上限

BudgetGuard 同时考虑：

- input/output token；
- USD；
- wall time；
- tool call；
- retries；
- network bytes；
- storage bytes；
- Artifact 数量；
- verification 次数；
- 同时活跃的 Agent 数量。

每个资源都走 reserve、commit、refund 或 reconcile。这样即使 provider 成本迟到，或者子 Agent 在中途失败，root Goal 仍能对账。

Agent graph 的深度、单节点 child 数和总 Agent 数由独立的 graph limits 约束，不和 BudgetGuard 的资源维度混为一谈。hard stop 后不得发起未预留的新副作用，子 Agent 也不能通过创建更多 child 绕过 root budget。

### 6.5 Artifact 是证据对象，不只是附件

大模型输出、工具输出、diff、测试报告和 review 不能全塞在消息历史里。Artifact 层提供：

- content-addressed storage；
- metadata 与 blob 分离；
- source digest 和 stored digest；
- redaction/transform receipt；
- session/workspace/capability 引用；
- TTL、pin、legal hold 和 retention；
- checkpoint、partial result、handoff 和 Episode evidence。

默认路径先脱敏再保存。forensic raw 内容需要显式授权、独立密钥和受限 retention。

“已入队”“已持久化”“内容校验通过”“外部系统已确认”是不同状态。只有 terminal receipt 才能被 Episode 或 cleanup 使用。

大体积工具输出也不应无限塞回模型上下文。Runtime 可以把完整内容保存成 Artifact，只向模型提供受限摘要和 `ArtifactRef`，既控制上下文体积，也保留可追查的原始证据。

### 6.6 独立 Verification，而不是让 Builder 自评

RunLedger 把自然语言成功声明视为不可信输入。可信完成需要：

- trusted baseline；
- 结构化 VerificationResult；
- Finding 生命周期；
- build/test/security/review evidence；
- Secret Scan 和 dependency admission；
- evidence 与目标 commit/diff/workspace 的关联；
- Episode Manifest 和 EpisodeSeal。

模型 reviewer 返回的普通文本、Markdown、伪 JSON、截断输出或跨 candidate 复用证据，只能形成 finding candidate 或 `inconclusive`，不能签发可信 pass。

Candidate 也不能修改自己的 verifier、gate 或评分器后再声称通过。高权限 Instruction、Draft PR 和 HumanGate 进一步要求 separation of duty。

### 6.7 动态资源采用“身份、信任、权限、激活”四分法

Plugin、MCP、Skill、Hook、Browser 工具等动态资源不能只凭名称运行。Runtime contract 区分：

- exact identity：kind、qualified ID、version、source；
- content/config digest；
- provenance 和 taint；
- publisher/signature/trust 状态；
- approval/revocation；
- capability claim；
- activation generation；
- invocation/result terminal。

路径 containment 只能说明“解析到了这个路径”，不能证明内容可信。Skill 文档可读也不代表其脚本获准执行。

具体 discovery、installer、trust store、runner 和 CLI/TUI 管理由 Plugin/MCP/Skill/Hooks 专项负责；Runtime 只消费其公开 snapshot 和 receipt。

### 6.8 Model、Context、Compaction 与 Memory 保持可追踪

模型切换不仅是换一个字符串。不同 provider 可能有私有 reasoning state、tool identity 和消息格式。RunLedger 要求：

- compatibility manifest；
- profile、route decision 和 conversion receipt；
- 不兼容模型切换通过 fork，而不是直接搬运私有状态；
- InputSourceRef、taint 和 declassification 在 context、summary、handoff 中继续传播；
- compaction 先持久化 replacement/invariant，再通过 expected revision 安装；
- derived/untrusted 内容不能自动进入长期 Memory；
- Memory 变更具有 proposal、diff、来源、审批、TTL、revoke/delete 记录。

相关行为主体属于 Plan/Context/Compaction/Memory 专项。Runtime 已冻结并消费公共契约，但不会在共享 Runtime 文件里另造一套简化实现。

### 6.9 Multi-Agent 是有界协作图

RunLedger 中的子 Agent 不是一个随手启动的后台 Promise。每个 child 至少绑定：

- 独立 Agent ID 和 Session ID；
- parent/child graph；
- objective、role、model/profile digest；
- 独立 workspace ref/lease；
- 父权限的严格子集；
- root 与 per-agent budget；
- activation authority 和 generation；
- partial Artifact、completion 和 cleanup receipt。

child 的 exact `allowedRequests` 必须同时落在父 grant 与 production policy 的交集内；nested spawn 还必须显式满足 `childSpawnAllowed=true`。未获准的 `credential`、`deploy`、`cross_workspace` 等 capability 一律拒绝。

child activation 采用 prepare/commit/activate 边界。冷恢复时 Runtime 根据 durable authority 判断：

- 尚未激活，可以安全取消或重建；
- 已知完成，只恢复 projection；
- effect 不确定，进入 `stop_uncertain` 或 operator reconciliation；
- 旧 generation 仍在运行，通过 fencing 阻止继续提交。

子结果通过 immutable Artifact handoff/merge 进入父任务。partial、failed 或 merge conflict 不会自动完成父 Goal。

### 6.10 Headless Control Plane 不复制业务状态

[`src/daemon/`](../src/daemon/) 提供版本化 Control Plane、stdio JSONL host、HTTP/SSE listener 组件、subscription、recovery 和 production composition。

当前 `runledger-daemon` 生产 CLI 只绑定继承的 stdin/stdout JSONL。HTTP/SSE 是可组合的 listener 组件；没有可信 peer credential attestor 时，不会被默认生产入口开放。

协议包含：

- handshake 和 schema negotiation；
- typed command/query/error；
- authority/tenant/principal correlation；
- expected revision；
- idempotency key；
- bounded input/backpressure；
- at-least-once cursor 与 durable consumer checkpoint；
- shutdown、replacement 和 stale-handle fencing。

Control Plane 不是新的状态数据库。CLI、TUI、daemon 和未来客户端都应该消费 canonical projection。

生产能力也不是由配置布尔值单独决定。`ProductionCompositionReceipt` 把 feature 与所需 adapter、健康探测、trust、generation、有效期和签名绑定。缺少任一必需 adapter 时，该 feature 不会 advertise，调用得到 `unsupported_feature` 或 deny。

### 6.11 生命周期、Telemetry 与企业/远程边界

Runtime 已为以下场景建立通用状态和恢复机制：

- startup integrity/receipt audit；
- shutdown 先关 mutation gate，再 bounded drain；
- runtime generation replacement；
- remote invocation 的 prepared/effect/terminal/uncertain；
- session/agent handoff；
- telemetry durable spool 与 sink acknowledgement；
- CostTraceV2 的迟到成本对账；
- reference-aware GC；
- ChangeProposal、Draft PR、HumanGate 的 durable effect。

v3 Runtime 的默认 telemetry projection/spool 采用闭合字段 allowlist，不保存完整 prompt、tool output、reasoning、secret 或环境变量。高敏 forensic trace 是独立、默认关闭的存储；这不表示项目中每一种普通诊断日志都已经经过同一 telemetry pipeline。

这些 Runtime seam 不等于真实企业系统已经接好。managed policy、credential、forge、organization gate、remote transport、平台 sandbox/egress 和 OS peer attestor 仍需要真实 adapter 和联合验收。

## 7. 必须遵守的硬约束

主计划列出的硬约束可以归纳为六组。

本节描述的是 v3 governed session 和 production path 的目标不变量。它不是对 legacy v2 compatibility path 的追溯性保证；未启用相应 feature、未通过 readiness 或缺少 production receipt 时，正确结果是保持旧路径语义或明确 unsupported，而不是宣称已经受到完整治理。

### 7.1 完整性与恢复

- sequence 缺口、hash 断链、未知 schema 默认禁止 resume；
- tool terminal durable 前不得进入下一次模型请求；
- stop tombstone 后不得因重启自动复活；
- accepted 不等于 durable；
- side effect 不确定时不得盲目重试；
- 旧 writer、handle 和 runtime generation 必须被 fencing。

### 7.2 Workspace 与副作用

- 没有 Workspace Envelope，不开始 Tool Call；
- 多个可写 Agent 不隐式共享主工作区；
- 删除 workspace 前先 checkpoint，并重新验证 canonical path 和 owner lease；
- sandbox、path guard、policy 或 credential broker 不可用时，副作用失败；
- issue、PR、comment、webhook 和 candidate workflow/config 都按 tainted input 处理。

### 7.3 权限与供应链

- `ask` 不得被 auto mode 降级为 allow；
- 模型猜出的包、MCP、Skill、Plugin 或工具 identity 不触发安装/执行；
- repo 内资源配置默认不可信，digest 变化需要重新审批；
- Skill 正文、资产和脚本分别授权；
- 修改高权限 Instruction 的主体不能自批。

### 7.4 模型、Context 与 Memory

- 不兼容模型切换只能 fork；
- provider 私有 reasoning state 不跨不兼容 adapter；
- taint 不得因摘要或模型重写消失；
- 不可信内容不能自动写入持久 Memory；
- compaction 失败保留旧投影并暂停。

### 7.5 Multi-Agent

- child 权限只允许等于或小于 parent grant；
- depth、children、总 Agent、成本和工具次数均有上限；
- 没有 root budget profile 不允许 spawn；
- child 必须使用显式 session/workspace ref；
- partial、failed 或 conflict 不会隐式提升父任务状态。

### 7.6 Verification 与完成

- Builder 的文字声明不能形成 pass；
- 单个测试输出不能形成 Goal Complete；
- Verification evidence 必须绑定可信 baseline 和 candidate；
- Goal Completion 必须消费 durable、可验证、无自引用的 EpisodeSeal；
- Draft PR、merge、deploy 与 HumanGate 分离，Agent 不自批。

### 7.7 完整性不等于不可抵赖

哈希链能够证明：从一个已知可信的 genesis/head 开始，后续记录没有发生未检测到的修改。它不能单独阻止拥有文件权限的攻击者重写整条日志和锚点。

因此 RunLedger 分开报告：

- `valid/partial/corrupted`：结构和哈希完整性；
- `attested/unattested`：是否有可信 signer、组织 authority、OS 身份或远端 executor 证明。

本地模式没有 signer 时，最多声明 `valid/unattested`。只有 managed 或 remote 部署中的 signer、tenant correlation 和 executor receipt 都验证通过，才能提升为 attested。

本地威胁模型覆盖崩溃、torn write、并发 writer、失控模型、tainted 输入、工具越权和常见路径 race。root/内核、Runtime 二进制、受信 helper 与签名密钥同时失陷，不是单机 Runtime 自身能够解决的范围。

## 8. 当前实现效果

截至本文对应快照，Agent Runtime 已经远超最小 scaffold，但完整 Governed Harness 产品里程碑仍未全部关闭。

当前 HEAD `678b046` 已合入 Phase 11 Runtime 实现。主计划顶部和部分 Wave 段落仍保留合入前的“候选 diff/等待提交”措辞；本文的实现分类以当前 Git 历史、主计划 §0.0 和 §12 的最新证据交叉判断。W5 跨平台门禁、W6-G 及完整 Runtime-M1–M4 产品里程碑仍然没有因此自动关闭。

阅读下表前，需要区分四种状态：

| 状态 | 准确含义 |
|---|---|
| Contract 已实现 | schema、event、projection 和 adapter port 已冻结，Runtime 能表达并校验这种能力 |
| Runtime-owned 已实现 | Runtime 自己负责的状态机、持久化、恢复、协调和 fail-closed 行为已有代码与测试 |
| 需外部生产适配器 | 真实 OS、Workspace、Sandbox、Browser、credential 或企业系统必须产生有效 receipt |
| Unsupported by design | 证据或 adapter 不足时明确拒绝；这是安全结果，不是自动降级成功 |

因此，“Runtime-owned completed”不等于整个产品里程碑 completed；contract test 通过也不等于真实平台已经实施强制隔离。

| 范围 | 当前效果 | 仍需明确保留的边界 |
|---|---|---|
| pi-ai/provider 基线 | provider、模型目录、认证和差异 manifest 可审计 | 上游漂移仍需重新审计，不能假设永久 parity |
| Protocol 与 Session | v3 exact schema、canonical JSON/hash、single-writer Event Store、queue、snapshot、stop、fork、migration、recovery 和 governed salvage adapter 已实现 | salvage 的真实授权策略、Workspace/Security 与 CAS 联合生产门禁仍是外部边界 |
| Workspace/Capability | 中立 contract、projection、receipt 校验和 Runtime consumer 已建立 | 真实 process tree、完整 Sandbox、OS actor identity、Approval 跨重启仍是外部缺口 |
| Artifact/Verification | CAS、redaction、retention、Finding、EpisodeSeal 和攻击测试已有实现 | 真实 Browser、forge、organization/human gate 联合接线未完成 |
| Orchestrator/Budget | durable control journal、Task DAG、全维预算、retry/uncertain gate 已完成 Runtime-owned 接线 | 冻结专项 readiness 不因 Runtime 测试通过自动提升 |
| Multi-Agent | durable graph、Supervisor、activation authority、cold recovery、budget reconcile、Artifact handoff、replacement/fencing 已完成 Runtime-owned 路径 | 缺真实 Gateway/Sandbox/process-tree authority 时保持 unsupported/quarantine |
| Control Plane | 协议、daemon、JSONL/HTTP-SSE 组件、bounded transport、subscription、recovery 和 production feature matrix 已实现 | 平台 peer credential 及未接 provider 继续 typed unsupported |
| Enterprise/Telemetry | remote/handoff 状态、telemetry spool、CostTraceV2、reference-aware GC、proposal/human-gate durable effect 已实现 | 真实 managed policy、credential、forge、remote transport、egress 仍是 frozen external gap |
| 跨平台 | Linux fault manifest 和 Harness Regression 有证据 | macOS/Windows 尚无实际 runner/preflight 结果 |

主计划在 2026-07-24 记录的合入前候选验证证据为：

- `npm run check` 和 `npm run build` 通过；
- `npm test`：287 files / 1823 tests 通过，另有 1 个显式 opt-in live test 默认跳过；
- Phase 11 定向测试：49 files / 290 tests；
- Harness Regression：12 files / 65 tests；
- pi-ai audit：164/164 source files 与 72 catalog files；
- Linux fault manifest：22 条记录，对应 21 条去重命令通过；
- macOS/Windows 跨平台门禁仍未完成。

这些数字是主计划保存的候选验证记录，不应被解释为本文编写时又对当前分支完整重跑了一次。本轮 fresh 验证只重新执行了 `npm run check`、Harness Regression 和 `tests/e2e`：前两项通过，E2E 为 9 files passed、1 live file skipped，53 tests passed、1 skipped；本轮没有重新执行完整 `npm test`、`npm run build`、pi-ai audit 或全部 fault command。无论采用哪一轮证据，它们都只覆盖对应的 Runtime-owned 行为和回归范围，不证明缺失的真实平台 adapter 已经存在。

## 9. 从故障场景理解实现效果

### 场景一：工具可能执行成功，但进程在确认前崩溃

Runtime 不会直接重试。该命令进入 `uncertain` 或 `reconciliation_required`，mutation gate 保持关闭，直到通过外部 receipt、Artifact 或 operator resolution 确认终态。

效果：避免重复写文件、重复创建 PR 或重复远程任务。

### 场景二：用户已经 stop，旧进程稍后恢复

stop 先形成 durable tombstone。恢复时旧进程即使还持有内存状态，也无法越过 writer generation 和 fencing。

效果：停止是持久语义，不是一次易丢失的进程信号。

### 场景三：模型说“任务完成，所有测试通过”

Orchestrator 不接受自然语言直接改 Goal。只有可信 verifier 生成的结构化证据、完整 Episode Manifest 和 EpisodeSeal 才能解锁 completed。

效果：模型的结论是候选信息，不是系统事实。

### 场景四：daemon 配置中启用了某项能力，但生产 adapter 缺失

Control Plane 根据 `ProductionCompositionReceipt` 计算 advertised features。缺 adapter、健康探测、trust 或 generation 绑定时，能力不会公布。

效果：配置不能绕过真实依赖，客户端得到明确的 unsupported，而不是运行到一半才静默降级。

### 场景五：子 Agent 崩溃或旧 generation 晚到

Supervisor 从 durable graph、authority 和 child session head 恢复。已知 terminal 只恢复 projection；未知 effect 进入 `stop_uncertain`；旧 generation 的迟到提交被 fencing。

效果：子 Agent 生命周期不依赖父进程内存，也不会因重启重复执行未知工作。

### 场景六：Event Store 中间一行损坏

Runtime 不跳过坏行继续。会话进入 corrupted/paused；forensic salvage 只能只读地产生报告，并把可恢复内容写入新 session。

效果：修复不会篡改原证据，也不会把部分历史冒充完整历史。

## 10. 代码地图

| 目录 | 主要职责 |
|---|---|
| [`src/runtime/protocol/v3/`](../src/runtime/protocol/v3/) | ID、event catalog、exact schema、canonical JSON/hash、状态转换 |
| [`src/runtime/session/`](../src/runtime/session/) | Event Store、writer、snapshot、fork、stop、migration、recovery |
| [`src/runtime/artifacts/`](../src/runtime/artifacts/) | Artifact CAS、metadata、redaction、retention、Episode |
| [`src/runtime/orchestrator/`](../src/runtime/orchestrator/) | Goal/Task、control journal、BudgetGuard、retry/uncertain |
| [`src/runtime/verification/`](../src/runtime/verification/) | Verification、Finding、EpisodeSeal、ChangeProposal |
| [`src/runtime/resources/`](../src/runtime/resources/) | Plugin/MCP/Skill/Hook 等动态资源的中立契约 |
| [`src/runtime/model-routing/`](../src/runtime/model-routing/) | compatibility manifest、route/profile 与转换证据 |
| [`src/runtime/context/`](../src/runtime/context/) | Context、compaction、Memory 的公共面与 Runtime adapter |
| [`src/runtime/agents/`](../src/runtime/agents/) | Agent graph、Supervisor、delegation、authority、child runtime |
| [`src/runtime/control-plane/`](../src/runtime/control-plane/) | command/query、idempotency、subscription、session registry |
| [`src/runtime/activity/`](../src/runtime/activity/) | RuntimeActivity projection |
| [`src/runtime/telemetry/`](../src/runtime/telemetry/) | Telemetry Manifest、spool、delivery receipt、CostTrace |
| [`src/runtime/lifecycle/`](../src/runtime/lifecycle/) | startup/shutdown、replacement、reference graph、GC |
| [`src/runtime/executors/`](../src/runtime/executors/) | remote invocation/handoff 的 Runtime 状态契约 |
| [`src/daemon/`](../src/daemon/) | daemon composition、stdio host、HTTP/SSE、production receipt、recovery |
| [`tests/runtime-v3/`](../tests/runtime-v3/) | 各领域 unit/contract/integration/fault/replay 测试 |
| [`tests/e2e/`](../tests/e2e/) | governed child、multi-agent isolation、daemon recovery 等端到端测试 |

各 Phase 的详细需求和证据索引见 [`development-doc/runtime/harness/README.md`](../development-doc/runtime/harness/README.md)。

## 11. 如何验证这些特点

基础门禁：

```bash
npm run check
npm test
npm run build
git diff --check
```

治理回归：

```bash
npm run test:harness-regression
```

Multi-Agent 与 daemon 的代表性 E2E：

```bash
npx vitest run \
  tests/e2e/governed-child-runtime.test.ts \
  tests/e2e/multi-agent-isolation.test.ts \
  tests/e2e/daemon-stdio.test.ts \
  --no-file-parallelism
```

真实 DeepSeek child lifecycle 是显式 opt-in：

```bash
RUNLEDGER_LIVE_E2E=1 \
  npx vitest run tests/e2e/live-deepseek-child-runtime.test.ts \
  --no-file-parallelism
```

live provider 测试只能证明真实模型调用进入了 governed child lifecycle，不能代替 fault、restart、security、sandbox 或跨平台门禁。

代表性 E2E 也需要按依赖强度解读：

- governed-child E2E 使用测试用 Gateway 和 Verification attestor；
- multi-agent isolation E2E 会创建真实临时 Git repository/worktree，但部分 Gateway、liveness 和 forensic port 仍是测试实现；
- live DeepSeek E2E 只把真实 provider 接入同一 child lifecycle，不证明真实 Gateway、Sandbox 或 Verification backend。

测试结果也按证据强度区分：

- unit/contract：证明 schema、reducer 和边界定义；
- fake adapter integration：证明 Runtime 会正确消费端口；
- fault/replay：证明崩溃和重放语义；
- scoped E2E：证明仓内若干真实组件能够联合工作；
- production/platform E2E：才可证明真实 OS、Sandbox、credential 或远端执行保证。

“有测试”与“产品能力已经生产可用”不是同一个结论。

## 12. 当前明确不应宣称的能力

在剩余联合门禁关闭前，不应把 RunLedger 描述成已经完整实现以下能力：

- 真实 OS 级、跨平台的进程树和网络隔离；
- 完整的 Approval 跨重启恢复与平台 actor identity；
- 所有 Plugin/MCP/Skill/Hook 的生产 supply-chain 信任；
- 完整 Plan UI、overflow-safe compaction 和 Memory 生命周期；
- 真实 Browser verification backend；
- 可直接使用的企业 managed policy、credential、forge 和 organization gate；
- 真实 remote/CI executor 与 egress enforcement；
- macOS/Windows 全故障矩阵；
- 任意 TUI/CLI 配置一开即可安全启用全部 Multi-Agent 能力。

当前最准确的说法是：

> RunLedger 已完成可审计单 Agent contract，以及 Multi-Agent、Headless Control Plane、Telemetry/Enterprise seam 的主要 Runtime-owned 实现；完整 Governed Harness 产品仍受真实安全、扩展、Plan/Memory、企业 adapter 和跨平台联合门禁约束。

## 13. 设计原则总结

RunLedger Agent Runtime 的核心取舍可以概括为：

1. 先保证可证明，再扩大自动化范围。
2. 把模型当作不可信决策候选源，而不是状态真源。
3. 把副作用授权放在执行前，而不是只做事后日志。
4. 把 accepted、durable、verified 和 externally acknowledged 分开。
5. 把不确定结果持久化并对账，而不是用重试掩盖。
6. 把多 Agent 设计成受预算、权限、workspace 和 generation 约束的 DAG。
7. 把 CLI、TUI、daemon 和未来客户端统一到一个 Control Plane。
8. 用 adapter port 隔离 Runtime 契约与平台实现，缺实现时明确 unsupported。
9. 保留旧版本只读和显式迁移，不伪造新版本保证。
10. 只有独立证据和 EpisodeSeal 能把 Goal 推到 completed。

这套设计会让实现比普通 Agent Loop 更复杂，但复杂度被用于解决真实的恢复、安全和审计问题，而不是隐藏在不可验证的“智能行为”里。

## 14. 延伸阅读

- [可治理 Agent Harness Runtime 主计划](../development-doc/runtime/04-governed-agent-harness-runtime-plan.md)
- [Phase 0–11 分阶段索引](../development-doc/runtime/harness/README.md)
- [外围专项冻结与所有权边界](../development-doc/runtime/06-specialty-implementation-freeze.md)
- [pi 架构与 Provider/Agent Core 关系](./pi-architecture.md)
- [Worktree/Sandbox/Permission 计划](../development-doc/worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)
- [Plugin/MCP/Skill/Hooks 计划](../development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md)
- [Plan/Context/Compaction/Memory 计划](../development-doc/plan-compact-memory/01-implementation-plan.md)
