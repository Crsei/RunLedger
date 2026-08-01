# RunLedger Runtime 通用协议、被动状态与用户级保存契约计划

> 文档状态:当前 Runtime contract 权威入口;不承担 Runtime 行为实现状态
> 基线复核:2026-08-01
> 适用范围:`src/runtime/` 中的公共 protocol、types、schema、event payload、adapter port、用户级保存位置,以及对应 contract tests
> 设计输入:[`00-reference.md`](00-reference.md)
> 历史实现计划:[`01-minimum-runtime-scaffold-plan.md`](01-minimum-runtime-scaffold-plan.md)、[`02-agent-loop-resurrection-plan.md`](02-agent-loop-resurrection-plan.md)、[`03-tool-system-plan.md`](03-tool-system-plan.md)
> 行为专项:[Plugin/MCP/Skill/Hooks](../plugin-mcp-skill-hooks/01-implementation-plan.md)、[Plan/Context/Compaction/Memory](../plan-compact-memory/01-implementation-plan.md)、[Worktree/Sandbox/Permission](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)、[Storage/CLI 用户级迁移](../storage-cli/02-user-home-migration-handoff.md)

## 0. 文档职责

本文件只回答五类问题:

1. Runtime 各参与方交换什么结构化数据;
2. 哪些结构必须有 exact runtime schema;
3. 哪些事实允许保存、只保存引用、可重建或禁止保存;
4. 行为实现通过什么 adapter port 消费或产生这些数据;
5. RunLedger 自有本地数据必须保存在哪个用户级根目录及固定子目录。

本文件不实现也不跟踪 manager、service、reducer、store backend、loader、runner、daemon、CLI/TUI、真实 adapter、进程生命周期、旧数据迁移或产品接线。它只冻结本地保存位置,不实现创建目录、原子写入、索引、归档、迁移或清理行为。contract 的存在不证明行为已经实现,contract tests 通过也不证明真实安全强制、持久化或远端执行可用。

### 0.1 权威边界

Runtime contract 独占以下公共面:

- branded ID、identity scope、canonical JSON/digest 与结构化错误;
- TypeScript 数据结构及对应 exact runtime schema;
- event catalog、每个 event 的独立 payload schema、event envelope 与 durable receipt;
- ref、receipt、snapshot、projection、manifest、descriptor 等被动记录;
- backend-neutral adapter port 及其 request/result/error DTO;
- 单一用户级 RunLedger home 的解析规则、固定目录拓扑、权限下限与路径归属;
- schema fixture、round-trip、bounds、redaction、ownership 与 public-surface contract tests。

以下内容不属于本计划:

- 值如何发现、计算、批准、执行或发射;
- event append、flush、replay、reducer、snapshot 构建和 recovery 的实现;
- Workspace、Permission、Approval、Sandbox、Credential、Artifact 或 Event Store backend 的行为实现;
- 模型路由、Plan Mode、Context、Compaction、Memory、Orchestrator、Verification、Multi-Agent、Control Plane 或 Telemetry 的行为;
- 旧 `<cwd>/.runledger/`、`~/.runledger/agent/` 或任意外部 session 目录的迁移器、兼容 reader、双写或后台服务。

### 0.2 “被动状态”的定义

本计划中的被动状态是可序列化、可校验、没有 I/O 或业务决策的 DTO。它可以描述事实、请求、结果、引用或投影,但不能自行执行动作。

| 包含 | 不包含 |
|---|---|
| ID、ref、receipt、descriptor、manifest | 文件句柄、socket、子进程、锁对象 |
| exact request/result/error DTO | retry、timeout、queue worker、supervisor |
| event payload、stream head、event range | append/replay/reconcile/reducer 实现 |
| snapshot/projection 的结构和 source head | snapshot 生成、projection 更新算法 |
| adapter port interface | adapter、manager、service、backend |

`AbortSignal` 等进程内控制对象可以是 port 方法参数,但不是可持久化协议字段。任何含闭包、可执行对象、class instance 或平台句柄的结构都不能进入 contract。

### 0.3 状态与证据规则

- 本文件只跟踪 contract work package;行为状态以对应专项计划、当前代码和验证证据为准。
- 某类型或文件已经存在只表示有 baseline,不表示 exact schema、payload、bounds、public export 和 fixture 已闭合。
- 每个完成项必须附目标分支上的 commit、定向 contract tests 和 `npm run check` 结果;未合并 worktree、未提交 diff 或口头结论不能勾选。
- contract 变更和行为适配分开提交:先冻结公共结构、schema、fixture,再由行为 owner 更新 consumer。
- 本计划不得因某个 consumer 实现方便而复制同义类型、放宽 unknown fields 或引入领域私有 event。

## 1. 当前 baseline 与缺口

以下是当前工作区可见的 contract surface。状态只说明“存在/缺口”,不推导完成度。

| 范围 | 当前 baseline | contract 缺口 |
|---|---|---|
| Protocol 基础 | `src/runtime/protocol/{ids,canonical-json,errors}.ts` | 统一字段 bounds、identity scope 和 fixture matrix 尚未作为完整 contract 闭合 |
| Event | `src/runtime/protocol/{events,schemas}.ts` | payload 仍是宽泛 record;缺每事件独立 schema、大小限制、状态相关字段和 durable receipt |
| Workspace/Security ref | `src/runtime/protocol/{workspace,capability}.ts` | 只有部分 ref/guard;缺完整 request/result/receipt correlation 与 port 合同 |
| Resource | `src/runtime/resources/{types,schemas,events,ports}.ts` | 已有中立 DTO/port;仍需 exact schema、bounded content、错误联合和 fixture |
| Model/Plan/Context | `src/runtime/{model-routing,modes/plan,context}/**/{types,schema}.ts` | consumer DTO 已存在;event payload、public ownership 与完整 fixture 仍需统一 |
| Session ledger | `src/runtime/ledger/types.ts` 与 storage/session tests | 这是现行产品 persistence surface;不自动等同于本计划的 canonical Event Store |
| 本地保存位置 | `src/storage/paths.ts` 当前同时使用 `<cwd>/.runledger/` 与 `~/.runledger/agent/`,并允许 `sessionDir`、`RUNLEDGER_SESSION_DIR`、`--session-dir` 改写 session 位置 | 尚未收敛为 `RUNLEDGER_DIR` 或默认 `~/.runledger` 的单一用户级根目录;现状是明确实现差距 |
| 边界检查 | `scripts/check-current-format.ts`、`scripts/check-runtime-boundaries.ts` | 需要随新增 contract 目录和 public surface 同步维护 |
| Contract tests | `tests/runtime-contracts/**` | 已覆盖部分 schema、canonical JSON、resource 和 ownership;缺全量 payload/port/保存分类矩阵 |

本计划实施时先做 inventory,不把现有 `LedgerEntry.payload: Record<string, unknown>` 或 `RuntimeEventEnvelope.payload: Record<string, unknown>` 宣称为最终 exact contract。

## 2. 全局 contract 规则

### 2.1 唯一 current exact format

- 第一方 Runtime contract 只有一个 current shape,不在名称、目录或记录中保留内部代际标记。
- 不增加数字 schema 字段、session 格式 feature flag、兼容 reader、隐式转换、双写或猜测式恢复。
- 新增、删除或改变字段时,同一 contract 提交必须同步所有类型、schema、event catalog、fixture、consumer compile test 和静态边界检查。
- unknown field、unknown event、缺失必需字段、非法 discriminant、越界数值、超限 payload 和不受支持的 JSON value 一律拒绝。
- current contract 无法验证时返回结构化失败;不得删字段、降级成文本或继续执行。

### 2.2 Schema 与 TypeScript 约束

持久化、wire 或跨模块公共结构必须同时提供:

1. 可擦除 TypeScript 类型;
2. TypeBox exact schema 或等价的单一 schema source;
3. schema 派生或逐字段等价的 runtime guard;
4. valid、missing、unknown、wrong-discriminant、boundary 与 oversize fixture;
5. public export 和 consumer compile test。

统一约束:

- object schema 关闭额外字段;
- union 必须有稳定 discriminant,不得靠字段猜测分支;
- sequence/revision/size 使用非负 safe integer;
- timestamp 使用规范 UTC 字符串;duration 单独使用整数毫秒;
- digest 明确算法和编码,禁止把任意 string 当 digest;
- ID 使用对应 branded type,不能用裸 string 互换 session、agent、tool call 或 artifact;
- canonical payload 中不得出现 `undefined`、`NaN`、无穷值、function、symbol、class instance 或循环引用;
- `unknown` 只允许作为未验证的 port ingress;进入 event、receipt、snapshot 或 projection 前必须转换为 exact DTO、bounded JSON 或 Artifact ref。

### 2.3 Identity、correlation 与 revision

所有可能影响恢复、授权或审计的结构必须显式绑定:

- authority、tenant、principal;
- session、goal、agent、turn、tool call 等适用 subject;
- trace/correlation ID;
- adapter identity/generation 或 producer identity;
- expected revision、source head 或 event range;
- payload/config/policy/resource digest;
- outcome、发生时间及适用的 expiry/revocation revision。

同名字段在不同 contract 中必须复用同一语义和 branded type。外部系统自报的 identity、scope、capability 或 success 只作为 annotation,必须由对应 receipt/attestation ref 关联,不能直接成为 Runtime 授权事实。

### 2.4 大内容、敏感信息与引用

- event、receipt、snapshot 和 projection 只保存 bounded metadata;大正文使用 `ArtifactRef`、`ContentRef` 或等价 digest ref。
- secret、token、password、private key、cookie、完整环境变量和 credential material 永不进入 canonical payload。
- prompt、tool output、model private reasoning、完整 diff、日志、截图和网络 trace 默认不内联;只记录大小、media type、redaction classification、digest 和受控 artifact ref。
- credential 只保存 audience/scope/expiry/revision/digest 绑定的 grant ref,不能保存可用 credential。
- redaction 前 source digest、redaction/transform policy digest、stored digest 必须分开表达,不能用一个 digest 混淆原始内容与保存内容。

## 3. 公共契约域

<a id="contract-foundation"></a>

### 3.1 Current exact format 与协议基础

必须冻结的基础类型:

| Contract | 必需信息 | 验证要求 |
|---|---|---|
| Runtime IDs | authority、tenant、principal、session、goal、workspace、repository、agent、turn、tool call、trace、artifact、approval、event、resource、snapshot、command、receipt | kind 前缀/格式、不可互换、parse/create round-trip |
| `IdentityContext` | authorityId、tenantId、principalId、principal kind、authentication/attestation ref | local/service/remote 分支 exact,不含 credential |
| `RuntimeContractError` | code、message、retryable、details ref、correlationId | 穷尽 error code;unknown code 拒绝 |
| Canonical JSON | UTF-8、object key order、array order、数字和字符串规则 | 跨平台 golden digest;不支持值 fail closed |
| Digest/ref | algorithm、digest、mediaType/subject kind、size 可选项 | 算法与编码 exact;错误长度/字符拒绝 |
| Revision/head | stream/ref ID、sequence/revision、eventHash | 非负、单调语义由 consumer 实现,结构由 contract 校验 |

本契约域不实现 ID registry、signer、key store、writer 或 hash-chain append。

<a id="contract-events"></a>

### 3.2 Event envelope、payload 与 durable record

`RuntimeEventEnvelope<TType, TPayload>` 必须是按 `type` 区分的穷尽联合。公共 envelope 固定包含:

- `authorityId`、`tenantId`、`principalId`、`eventId`;
- `stream`:`session` 或 `authority_tenant` scope、streamId,session scope 还必须含 sessionId;
- `sequence`、`timestamp`、`type`、`traceId`;
- `previousEventHash`、`payloadDigest`、`currentEventHash`;
- 与 `type` 一一对应的 exact `payload`。

哈希输入覆盖 identity、stream、sequence、timestamp、type、previous hash 与 payload digest。contract 只定义输入和输出结构;哈希计算、append、flush、fencing、replay 和 corruption handling 属于行为实现。

`DurableEventReceipt` 至少包含 stream ref、cursor、sequence、eventHash、writerEpoch 与 durableAt。append accepted 不能冒充 durable;port result 必须能区分 `accepted`、`durable`、`rejected` 和 `uncertain`。

每个 event payload schema 必须登记:

| 项目 | 要求 |
|---|---|
| Subject | 明确 session/goal/agent/turn/tool/resource 等 subject ID |
| Correlation | request/command/trace/idempotency/parent event 适用字段 |
| Transition evidence | previous/next status、expected revision、reason code、receipt refs |
| Effect | `none`、`committed` 或 `uncertain`;只用于描述结果,不替代外部 receipt |
| Content | bounded metadata 或 artifact/content ref,禁止无界正文 |
| Bounds | payload bytes、数组数量、字符串长度与 diagnostics 上限 |
| Secret policy | 字段级允许、digest-only、redacted 或 forbidden 分类 |
| Fixture | valid、invalid、oversize、tamper 与 canonical digest 样本 |

<a id="contract-session"></a>

### 3.3 Session、Goal、Task、Turn、Tool、Queue 与 Agent 被动状态

| Event family | Exact event names | Payload/被动结构必须表达 |
|---|---|---|
| Session | `session.created`、`session.forked`、`session.stop_requested`、`session.stopped`、`session.closed`、`session.corrupted`、`session.repair_reported` | root goal/agent、parent/cut、expected head、stop/corruption reason、terminal effect、repair report ref |
| Session lifecycle | `session.handoff_requested`、`session.handoff_committed`、`session.handoff_failed`、`session.deletion_planned`、`session.deletion_tombstoned`、`session.deletion_committed`、`session.deletion_failed` | source/target authority、final head、reference-graph digest、lease/legal-hold receipt、tombstone |
| Input | `input.source_recorded`、`input.declassification_decided` | source kind/digest/trust/taint、allowed sink、policy/approver/expiry ref |
| Goal | `goal.transitioned` | goal revision、previous/next status、completion/verification ref、reason |
| Task | `task.created`、`task.definition_revised`、`task.transitioned`、`task.output_bound` | task definition digest、dependency IDs、priority/status revision、output artifact refs |
| Turn | `turn.started`、`turn.finished`、`turn.interrupted`、`turn.failed` | turn ID、model route ref、input/event range、terminal reason、usage/cost ref |
| Model | `model.routed`、`model.requested`、`model.finished`、`model.failed` | provider/model/profile、compatibility decision、request/response digest、usage/adapter-state ref |
| Tool | `tool.requested`、`tool.authorized`、`tool.started`、`tool.finished`、`tool.interrupted`、`tool.failed` | descriptor/snapshot、canonical input digest、workspace/capability/sandbox refs、bounded result/artifact refs、唯一 terminal |
| Queue | `queue.enqueued`、`queue.claimed`、`queue.consumed`、`queue.cancelled` | queue item ID、steer/follow-up kind、order/revision、target turn、inline-bounded 或 artifact payload、claim/cancel correlation |
| Agent | `agent.spawn_requested`、`agent.spawned`、`agent.paused`、`agent.stopped`、`agent.partial_committed`、`agent.handoff_requested`、`agent.handoff_committed`、`agent.handoff_failed`、`agent.merge_requested`、`agent.merge_committed`、`agent.merge_failed`、`agent.finished`、`agent.failed` | parent/child edge、delegation digest、budget/workspace/capability subset refs、residency annotation、partial/merge artifact refs、terminal effect |

被动 projection 至少定义 `SessionProjection`、`GoalProjection`、`TaskProjection`、`QueueProjection` 和 `AgentGraphProjection` 的字段、source head 与 projection digest。reducer、状态机、调度、budget settlement 和恢复不属于本计划。

<a id="contract-workspace-security"></a>

### 3.4 Workspace、Capability、Approval、Sandbox 与外部权威引用

Runtime 只保存可验证的 envelope/ref/receipt,不复制 Workspace、Approval、Policy、Credential 或 Sandbox backend 的权威 store。

| Contract | 最小绑定 |
|---|---|
| `WorkspaceExecutionEnvelope` | authority/tenant/principal、session/workspace/repository、agent/tool call/trace、cwd/branch/base、owner runtime、lease revision、fencing token digest |
| `WorkspaceBindingRef` | workspace/repository、binding kind、effective cwd、base/head、worktree ref |
| `WorkspaceLeaseRef` | workspace、owner、revision、fencing digest、state、expiry |
| `WorkspaceValidationReceiptRef` | envelope digest、validator identity/generation、outcome、validatedAt、source head |
| `WorkspaceCheckpointDescriptor` | workspace、event head、base/head commit、status digest、artifact ref、completeness |
| `CapabilityClaim` | capability、resource kind/digest、constraints digest、scope |
| `CapabilityRequest` | identity context、subject correlation、arguments/envelope/policy digest、nonce、issued/expiry、channel/signature proof ref |
| `CapabilityDecisionReceipt` | allow/ask/deny、decision revision、matched rules/policy digest、approver/gateway identity、expiry/revocation |
| `ApprovalTicket/ReceiptRef` | approval ID、request digest、scope、decision、revision、principal、expiry |
| `RateLimitReceiptRef` | principal/capability/resource/window、reservation、outcome、revision |
| `CredentialGrantRef` | grant ID、kind、audience/scope digest、expiry/revocation、broker receipt;不含 credential |
| `SandboxProfileRef` | requested/effective profile、policy digest、backend requirement |
| `SandboxExecutionReceiptRef` | profile/backend、invocation digest、enforcement outcome、platform attestation ref |

Exact event:

- `workspace.bound`、`workspace.validation_recorded`、`workspace.released`;
- `permission.requested`、`permission.decided`、`permission.expired`、`permission.revoked`;
- `capability.rate_limit_recorded`;
- `sandbox.resolved`、`sandbox.execution_recorded`;
- `lease.acquired`、`lease.taken_over`、`lease.released`。

path canonicalization、symlink/TOCTOU、policy merge、approval UI/store、credential injection、sandbox enforcement 与 lease CAS 全部归行为 owner。

<a id="contract-artifact-evidence"></a>

### 3.5 Artifact、Checkpoint、Episode 与 Verification

| Contract | 必需信息 |
|---|---|
| `ArtifactRef` | authority/tenant、stored digest、kind、media type、original/stored size、redaction class、transform receipt ref |
| `ArtifactIntent` | request/subject、source digest、target kind、retention/access policy digest、idempotency key |
| `ArtifactCommitReceipt` | intent、stored digest、content verification、key/access ref、durable outcome |
| `ProjectionCheckpoint` | source event head/range、projection kind/digest、artifact ref、completeness |
| `CompositeCheckpoint` | event head、workspace checkpoint、artifact set、dirty/untracked/conflict summary、completeness |
| `EpisodeManifestBody` | event heads、workspace/artifact/permission/cost/verification refs、retention graph;无自引用 seal |
| `EpisodeSeal` | manifest digest、terminal event ref、signer/attestation、verification outcome |
| `VerificationRequest/Result` | candidate/baseline digest、gate manifest、runner identity、evidence refs、pass/fail/error/unsupported |
| `FindingRecord` | stable finding ID、severity/status/revision、location/evidence refs、resolution ref |
| `ChangeProposal` | base/candidate refs、diff/artifact、verification summary、requested human/forge action |

Exact event:

- `checkpoint.created`、`checkpoint.rewound`;
- `artifact.intent_recorded`、`artifact.created`、`artifact.committed`;
- `episode.manifest_committed`、`episode.seal_recorded`;
- `verification.started`、`verification.finished`、`finding.transitioned`;
- `change_proposal.created`、`draft_pr.requested`、`draft_pr.created`、`draft_pr.failed`、`human_gate.requested`、`human_gate.decided`。

CAS、encryption、redaction pipeline、retention、GC、checkpoint creation、verifier runner、browser、forge 和 human gate service 均不属于本计划。

<a id="contract-resources"></a>

### 3.6 Plugin、MCP、Skill、Hook 与 Tool Resource

Runtime 只拥有领域中立资源合同:

- `ResourceIdentity`、`ResourceProvenance`、trust/activation/exposure state;
- `ResourceApprovalReceipt` 与 revocation binding;
- `RuntimeToolDescriptor`、`RuntimeToolInvocation`、`RuntimeToolResult`;
- bounded `ResourceContent`、diagnostic、snapshot 与 lifecycle payload;
- capability claim、workspace envelope、snapshot generation 和 correlation refs。

Exact event:

- `resource.approved`、`resource.revoked`、`resource.snapshot_acquired`;
- `resource.activated`、`resource.deactivated`、`resource.failed`。

manifest、frontmatter、配置文件、发现优先级、trust store、installer、loader、MCP client/server、Hook runner、Skill 资产和用户控制面归 [Plugin/MCP/Skill/Hooks 专项](../plugin-mcp-skill-hooks/01-implementation-plan.md)。Runtime resource contract 不保存 handler、client、process 或可执行闭包。

<a id="contract-model-context"></a>

### 3.7 Model、Plan、Context、Compaction 与 Memory

| Contract | 被动信息 |
|---|---|
| Model compatibility | provider/model/profile identity、tool/reasoning/media/context capability、conversion/adapter-state ref、compatible/fork/deny decision |
| Model route | operation、source/target profile、context/plan/resource digest、decision diagnostics |
| Plan Mode | mode status、revision、plan artifact/ref、approval ref、policy ceiling |
| Context | ordered fragment descriptors、source/trust/taint、token estimate、omission/assembly receipt、projection digest |
| Compaction | reason/status、source event range、replacement artifact、invariant digest、attempt/terminal receipt |
| Memory | scope、provenance/trust/revision、content digest/ref、proposal/approval/revocation/search receipt |

对应 event payload 至少覆盖 `model.routed`、context assembly、plan lifecycle、compaction lifecycle 和 memory proposal/approval/revocation。event 的实际名称必须在 catalog 中一次性冻结,不得由专项行为实现私建。

router、manifest loader、Plan reducer/service、ContextEngine、token estimator、compaction planner/summarizer/store、Memory store/index/search/tools 和 UI/CLI 归 [Plan/Context/Compaction/Memory 专项](../plan-compact-memory/01-implementation-plan.md)。

<a id="contract-control-telemetry"></a>

### 3.8 Control Plane、Composition、Policy、Cost、Telemetry 与 Remote metadata

| Contract | 被动信息 |
|---|---|
| Command | command ID、principal/session/generation、expected revision、idempotency key、exact action payload |
| Command result | applied/rejected/reconciliation-required、effect、new revision、event receipt、structured error |
| Query/subscription | query kind/filter、bounded page、cursor、event range/head、consumer checkpoint |
| `RuntimeActivity` | session/turn/tool/agent refs、state、source head、last durable progress、optional cost/exporter health summary |
| `ProductionCompositionReceipt` | runtime generation、feature requirements、adapter identity/generation/config/trust/health refs、effective feature set、digest/expiry |
| Managed policy ref | sources、winner/loser attribution、deny union、normalization reason、effective digest/receipt |
| Cost record | provider/model/operation、root/child attribution、input/output/cache/tool units、currency/estimate/final/reconciliation refs |
| `TelemetryManifest` | allowed fields/sinks、sampling、redaction policy、retention、tenant scope、exporter identity/generation |
| Remote invocation | authority/tenant/workload、workspace/capability/credential refs、request digest、executor attestation、result receipt |
| Lifecycle ref | handoff/deletion/retention subject、authority stream head、legal hold/reference graph/tombstone refs |

Exact event:

- `command.claimed`、`command.applied`、`command.rejected`、`command.reconciliation_required`;
- `runtime.replacement_prepared`、`runtime.generation_activated`、`runtime.replacement_failed`;
- `policy.effective_recorded`、`policy.normalization_recorded`;
- `cost.recorded`、`cost.reconciled`、`telemetry.delivery_recorded`。

daemon、transport、subscription worker、composition root、policy resolver、cost aggregator、exporter spool、remote executor、handoff/GC service 都不属于本计划。

<a id="contract-ports"></a>

## 4. Adapter port contract

### 4.1 Port catalog

| Port | Exact request/result DTO | 行为 owner |
|---|---|---|
| `RuntimeEventStorePort` | append request、accepted/durable/rejected/uncertain result、stream head/range query | 后续 Event Store 行为计划 |
| `RuntimeEventSubscriptionPort` | bounded filter/cursor/page、event batch、consumer checkpoint | 后续 Control Plane 行为计划 |
| `WorkspaceServicePort` | bind/validate/checkpoint/release request 与 receipt ref | Worktree/Sandbox/Permission |
| `CapabilityGatewayPort` | capability request、decision/approval/rate-limit receipt | Worktree/Sandbox/Permission |
| `ApprovalCoordinatorPort` | ticket create/query/cancel 与 terminal receipt | Worktree/Sandbox/Permission |
| `SandboxExecutionPort` | profile resolve、invocation descriptor、execution receipt | Worktree/Sandbox/Permission |
| `ArtifactStorePort` | intent/put/get metadata/ref/commit receipt;正文为 bounded bytes/stream ingress,不进入 event | 后续 Artifact 行为计划 |
| `RuntimeResourceCatalogPort` | exact resolve、bounded search、descriptor result | Plugin/MCP/Skill/Hooks |
| `RuntimeResourceSnapshotPort` | acquire/release snapshot、generation/digest | Plugin/MCP/Skill/Hooks |
| `RuntimeResourceInvocationPort` | invocation/cancel、bounded result/error | Plugin/MCP/Skill/Hooks |
| `ModelStreamPort` | model/context/tool descriptor request、stream/result/usage refs | Provider/Runtime 行为集成 |
| `VerificationRunnerPort` | verification request、progress annotation、terminal result/evidence refs | 后续 Verification 行为计划 |
| `ManagedPolicyPort` | policy source query、effective/normalization receipt | Worktree/Sandbox/Permission 企业安全实现 |
| `CredentialBrokerPort` | audience-bound grant request、grant/revoke receipt ref | Worktree/Sandbox/Permission 企业安全实现 |
| `ForgeProviderPort` | change proposal、draft-only result receipt | 后续 Forge 行为计划 |
| `HumanGatePort` | gate request、principal/organization decision receipt | 后续 Human Gate 行为计划 |
| `RemoteExecutorPort` | attested invocation/cancel/result receipt | Worktree/Sandbox/Permission 远端安全实现 |
| `TelemetryExporterPort` | manifest-bound event range、delivery state/ack receipt | 后续 Telemetry 行为计划 |

### 4.2 所有 port 的统一语义

- request 必须携带 identity context、correlation/idempotency key、适用的 expected revision、deadline 和输入 digest/ref。
- result 使用 discriminated union,至少区分 `ok`、`unsupported`、`denied`、`conflict`、`unavailable`、`cancelled`、`uncertain`。
- 业务失败通过 result 编码;编程错误可抛出,但不能被转换成成功或可重试授权。
- adapter identity、generation、config digest 和适用 trust/health receipt 必须出现在结果或 composition receipt 中。
- cancel 只表达请求,terminal receipt 才能证明取消完成。
- progress 是有界、可丢弃 annotation,不能形成 durable terminal 或授权事实。
- port 不规定 retry、timeout、backoff、queue、worker 或 fallback;这些属于行为 composition。
- port 不暴露 manager/backend 内部类型,不允许 consumer import adapter 私有状态。
- fake port 只能用于 contract/integration tests,不能作为 production capability receipt。

<a id="contract-persistence"></a>

## 5. 保存位置与逻辑保存信息合同

本计划同时定义“保存什么”和“RunLedger 自有本地数据保存到哪里”。逻辑 contract 仍保持 backend-neutral;凡是 RunLedger 在本机创建或持有的配置、凭据文件、session、event、receipt、artifact、snapshot、projection、索引、日志、缓存、IPC 状态和临时写入文件,都必须位于同一个已解析的用户级 RunLedger home 下。远端权威服务和操作系统 keyring 可以位于该目录之外,但 RunLedger 为它们保存的本地 ref、receipt 或缓存仍必须位于该根目录下。

### 5.1 RunLedger home 解析

启动时只解析一次 `runledgerHome`,优先级与失败语义固定为:

1. `RUNLEDGER_DIR` 非空时,它是唯一 override。值必须是已存在的绝对目录;解析真实路径并规范化后作为 `runledgerHome`。不存在、不是目录、不是绝对路径或无法规范化时启动失败,不得回退 cwd、默认目录或另一个环境变量。
2. 未设置 `RUNLEDGER_DIR` 时,`runledgerHome = <用户主目录>/.runledger`。默认目录可以按 `0700` 创建;无法确定用户主目录或无法安全创建时启动失败,不得回退到 `<cwd>/.runledger/`。
3. 所有下游组件接收同一个已解析的绝对 `runledgerHome`;不得各自读取环境变量、根据 cwd 重新解析或拼出第二个根目录。

这沿用 Codex 的单一用户目录模式:一个用户级 home 统一承载本地配置、认证、session、日志和缓存,workspace 只作为记录的 identity/metadata,不再充当保存根目录。

### 5.2 固定物理布局

```text
<runledgerHome>/
├── settings.json
├── auth.json
├── AGENTS.md
├── sessions/
│   └── YYYY/MM/DD/*.jsonl
├── archived_sessions/
│   └── YYYY/MM/DD/*.jsonl
├── session_index.jsonl
├── projects/
│   └── <workspace-key>/settings.json
├── artifacts/
│   └── sha256/<prefix>/<digest>
├── artifact-metadata/
├── snapshots/
├── projections/
├── state/
├── log/
├── cache/
├── ipc/
└── tmp/
```

布局语义:

- `settings.json`、`auth.json` 和 `AGENTS.md` 是用户级入口;workspace 特定设置只放在 `projects/<workspace-key>/settings.json`。
- `<workspace-key>` 必须由 canonical `WorkspaceRef` 的非敏感、path-safe digest key 派生;精确算法与 golden fixture 在 C3 冻结。原始 cwd 只写入受约束 metadata,不得直接编码成另一个目录根或依赖目录名恢复 workspace identity。
- active session 按创建时间的 UTC `YYYY/MM/DD` 分片。日期分片只用于查找和文件数量控制;session identity 来自 canonical `sessionId`,移动到 `archived_sessions/` 不得改变 identity 或内容语义。
- `archived_sessions/` 保存耐久归档,不是 deletion tombstone;删除、retention decision 和 external acknowledgement 仍按 §5.6 的独立 contract 表达。
- `session_index.jsonl`、`snapshots/`、`projections/` 和 `cache/` 可以从 canonical durable records 重建,不得成为唯一历史、权限真源或完成证明。
- `artifacts/sha256/<prefix>/<digest>` 是内容寻址路径;metadata、授权、redaction、retention 和 external receipt 分离保存在受 schema 约束的记录中,不能从文件存在推导授权或完成。
- `runledgerHome` 的绝对路径和最终文件系统路径只属于进程内解析状态,不得复制到 canonical event、receipt、Artifact metadata 或 telemetry。可持久化结构只记录 object kind、branded ID、digest、UTC shard 等可重建 locator 信息;diagnostic 至多暴露经过脱敏的根内相对路径。
- 原子写入、锁、socket、spill 和临时文件只能放在 `state/`、`ipc/` 或 `tmp/` 等根内子目录;需要 rename 的临时文件必须留在目标文件所在文件系统内。
- 新建目录默认权限为 `0700`;配置、认证、session、receipt、artifact 与其他可能含用户数据的文件默认不宽于 `0600`。adapter 不得通过更宽松默认权限绕过该下限。

### 5.3 单一根目录与路径禁止项

- conforming implementation 不得再向 `<cwd>/.runledger/` 或 `~/.runledger/agent/` 创建新文件;这两个位置只属于待迁移的历史实现。
- `settings.sessionDir`、`RUNLEDGER_SESSION_DIR` 和 `--session-dir` 不再是持久化位置 authority。后续实现必须移除或对新写入拒绝这些任意目录 override;具体 CLI/storage 兼容与弃用步骤由独立迁移计划承担。
- `--session <path>`、`--fork <path>` 或未来 import 可以把根目录外文件当作只读输入,但不能原地追加、锁定、归档或把该外部路径登记为 canonical storage;导入结果必须写回 `<runledgerHome>`。
- 任何用户输入、workspace path、session metadata、adapter 返回值或 symlink traversal 都不得令 RunLedger 自有写入逃逸 `runledgerHome`。最终目标路径必须在打开或 rename 前验证仍位于规范化根目录内。
- 本 contract 不自动扫描、搬移、复制或删除已有项目级/agent 子目录数据,也不授权双写。旧数据盘点、冲突处理、显式 import、回滚和删除必须另立迁移计划并由用户触发。

### 5.4 逻辑保存分类

| 分类 | 可以保存 | 不能被误用为 |
|---|---|---|
| Canonical durable | exact event envelope/payload、durable receipt、terminal outcome、tombstone、外部 receipt ref | 原始 secret、大正文、backend 内部状态 |
| External authority ref | lease/approval/credential/policy/trust/sandbox/artifact/attestation 的 ID、digest、revision、expiry、receipt | 外部权威数据副本、可用 credential、执行成功证明本身 |
| Reconstructible passive | projection、snapshot、activity、cost summary、search/index、pagination cache | 权限真源、唯一历史、完成 gate |
| Ephemeral | stream delta、progress、heartbeat、UI selection、process handle、in-flight buffer | restart 恢复依据、durable progress |
| Forbidden | token/password/private key/cookie、完整 env、未授权 prompt/tool output/private reasoning | 任何 Runtime contract 字段 |

### 5.5 Canonical 与 projection 关联

- 每个 snapshot/projection 必须带 source stream head 或 event range、projection kind、projection digest、builtAt 和 completeness。
- projection 可以缓存,但不能反向修改 canonical event 或外部 authority。
- projection 不得独立授予 capability、恢复 writer ownership、确认 terminal effect 或批准删除。
- 跨 stream 只通过显式 head/ref 关联,不伪造全局 sequence。
- 外部 object 成功而 event/receipt 未确认时只能表达 pending/uncertain;contract 不定义 reconcile 行为。

### 5.6 Retention 与删除信息

- ref、receipt、manifest 必须携带足够信息供行为实现建立 session/fork/handoff/checkpoint/artifact/verification/legal-hold 引用图。
- deletion tombstone、retention decision 和 external acknowledgement 必须是不同结构,不能用文件消失推导删除成功。
- exporter accepted/enqueued、local durable、sink acknowledged 与 retention applied 必须是不同 outcome。
- forensic raw content 即使单独授权保存,也不能成为 Runtime 恢复或完成所需真源。

<a id="contract-work-packages"></a>

## 6. Contract work packages

### C0:Inventory 与所有权冻结

- [ ] 生成 public contract inventory,逐项列出 type、schema、event、port、fixture、owner 和保存分类。
- [ ] 标记现有宽泛 record、重复 type、私有 event 和越界 import,不在 inventory 阶段修改行为。
- [ ] 固定 contract directory allowlist 与禁止依赖,让 `npm run check` 实际执行边界检查。
- [ ] 为每个行为专项记录只读 contract handoff 路径;没有 owner 的行为明确保持 unavailable。

完成证据:inventory review、boundary test、current-format check、consumer 路由链接。

### C1:基础类型与 exact schema

- [ ] 冻结 Runtime ID、identity context、digest/ref、revision/head 和 structured error 的唯一 public 定义。
- [ ] 为每个 public persisted/wire DTO 建立 exact schema、runtime guard、bounds 和 fixtures。
- [ ] 冻结 canonical JSON/digest golden fixtures,覆盖跨平台、Unicode、数字和非法值。
- [ ] 清除 contract 目录内 raw I/O、storage/UI/provider 反向依赖和同义类型。

完成证据:foundation contract tests、public consumer compile test、module-boundary test。

### C2:Event catalog 与 payload closure

- [ ] 将 `RuntimeEvent` 收敛为按 type 区分的穷尽 payload union,移除 canonical ingress 的宽泛 payload。
- [ ] 为 §3 每个 exact event 建立 payload schema、bounds、secret policy、canonical digest fixture 和 unknown-event fence。
- [ ] 冻结 stream ref、event envelope、event range/head、durable receipt 与 append outcome DTO。
- [ ] 建立 event name 唯一性、payload/type 对应、oversize、tamper 和 terminal-correlation contract tests。

完成证据:event catalog/payload fixtures、schema round-trip、hash/tamper tests。

### C3:被动状态、用户级布局与保存分类

- [ ] 冻结 §3 的 ref、receipt、descriptor、manifest、snapshot 和 projection 结构。
- [ ] 冻结 `RUNLEDGER_DIR`/默认 `~/.runledger` 的唯一 root 解析、规范化、失败语义与固定子目录拓扑,并建立跨平台 path fixture。
- [ ] 冻结 `<workspace-key>`、UTC session 分片、archive 与 content-addressed artifact 的 path-safe 规则;证明 cwd/metadata/外部输入不能形成第二个 root 或路径逃逸。
- [ ] 冻结 location-bearing passive DTO 的最小字段:只保存 object kind、branded ID、digest、shard 或根内相对 locator,拒绝绝对 home/cwd、`..` 与平台句柄进入 durable schema。
- [ ] 每个结构登记 canonical/external-ref/reconstructible/ephemeral/forbidden 分类和 retention/redaction 规则。
- [ ] 大正文统一改为 bounded inline 或 Artifact/Content ref;secret-bearing fixture 必须拒绝。
- [ ] snapshot/projection 统一携带 source head/range、digest、completeness,且不能表达独立授权。

完成证据:root/layout golden fixtures、path containment/permission tests、保存分类矩阵、redaction/oversize fixtures、projection source-head tests。

### C4:Adapter port closure

- [ ] 冻结 §4 port 的 exact request/result/error DTO、correlation、idempotency、cancel 和 receipt 语义。
- [ ] 为每个 port 提供最小 fake consumer/conformance test,不实现真实 I/O。
- [ ] 阻止 port 暴露 manager/backend 私有类型、可执行闭包、credential material 或无界 result。
- [ ] 生成 production composition 所需的 adapter identity/generation/config/trust/health 被动合同。

完成证据:fake-port conformance、ownership/import tests、unsupported/denied/uncertain fixtures。

### C5:Public surface、consumer handoff 与文档闭合

- [ ] 只导出审核过的 contract types/schemas/ports,不从根 barrel 导出 adapter implementation。
- [ ] Plugin、Security/Worktree、Plan/Context/Memory consumer 只通过 public exports 编译,没有复制 payload 或 ref。
- [ ] 更新开发索引和下游计划中的旧阶段引用,统一指向本文件稳定契约域锚点。
- [ ] 为 Storage/CLI 建立独立迁移 handoff,覆盖停止项目级写入、移除任意 sessionDir authority、显式旧数据 import 与 rollback;本 contract 提交不搬移或删除用户数据。
- [ ] 记录 contract commit、定向测试、`npm run check`、`npm test` 和 `npm run build` 证据后再逐项勾选。

完成证据:public-surface test、consumer compile tests、Markdown link check、完整 gates。

<a id="contract-owner-routing"></a>

## 7. 行为 owner 与路由

| 行为 | 唯一 owner/入口 | 本计划只提供 |
|---|---|---|
| Plugin/MCP/Skill/Hook discovery、trust、process、control | [`plugin-mcp-skill-hooks/01-implementation-plan.md`](../plugin-mcp-skill-hooks/01-implementation-plan.md) | resource DTO/schema/event/ports |
| Workspace/worktree、Permission、Approval、Credential、Gateway、Sandbox | [`worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md) | envelope/ref/receipt/event/ports |
| Model Router、Plan、Context、Compaction、Memory | [`plan-compact-memory/01-implementation-plan.md`](../plan-compact-memory/01-implementation-plan.md) | public DTO/schema/event payload |
| Provider/API/Auth/catalog 行为 | [`providers/01-pi-ai-migration-plan.md`](../providers/01-pi-ai-migration-plan.md) 与当前代码/tests | model stream/compatibility bridge contract |
| 现行 agent-loop、Agent、ledger、stdlib tools | `01`–`03` 历史计划、`AGENTS.md` 与当前代码/tests | 不由本计划改写其行为状态 |
| 用户级 home 创建、旧目录 import、CLI 参数弃用 | [`storage-cli/02-user-home-migration-handoff.md`](../storage-cli/02-user-home-migration-handoff.md);现行旧行为见 [`storage-cli/01-project-layout-cli-plan.md`](../storage-cli/01-project-layout-cli-plan.md) | root/layout/permission/path-containment contract |
| Event Store writer/replay/reducer/recovery | 当前无本计划授权;实现前必须建立独立行为计划 | event/receipt/query ports |
| Artifact CAS/redaction/retention/GC | 当前无本计划授权;实现前必须建立独立行为计划 | artifact/ref/intent/receipt ports |
| Orchestrator/Verification/Multi-Agent | 当前无本计划授权;实现前必须建立独立行为计划 | goal/task/agent/evidence 被动合同 |
| Daemon/Control Plane/Forge/Human Gate | 当前无本计划授权;实现前必须建立独立行为计划 | command/query/composition/proposal ports |
| Telemetry exporter/remote executor/lifecycle service | 当前无本计划授权;安全执行部分仍受专项约束 | manifest/delivery/attestation/lifecycle refs |
| TUI/CLI/IDE/CI client | 各产品专项或未来独立计划 | 只消费相同 public contract |

“当前无本计划授权”表示不得根据本文件直接开始行为实现;必须先建立具体 owner、威胁模型、文件边界、测试与 rollout 计划。本文件也不保存这些未来行为的完成状态。

## 8. 验证矩阵

| 层级 | 必测内容 |
|---|---|
| Type/schema | static type 与 runtime schema 等价、unknown/missing/wrong-discriminant 拒绝 |
| Bounds | 字符串、数组、payload、diagnostic、inline content 的边界值和 oversize 拒绝 |
| Canonical | JSON/digest golden、Unicode/number、tamper、跨平台一致性 |
| Event | catalog 唯一、payload/type 匹配、stream/head/ref correlation、terminal outcome |
| Secret | credential/raw env/prompt/tool output/private reasoning fixture 不进入 canonical record |
| Passive state | snapshot/projection source head、digest、completeness 与保存分类 |
| Storage location | `RUNLEDGER_DIR`/默认 home 解析、固定布局、UTC 分片、workspace key、path containment、权限下限、根外写入拒绝 |
| Port | fake conformance、error union、cancel、idempotency、unsupported/uncertain |
| Ownership | contract 目录无 raw I/O/behavior import,专项无重复 public type/event |
| Public surface | consumer 只从 public exports 编译,实现类不被 contract barrel 导出 |
| Documentation | 所有入站链接有效,没有旧阶段引用或行为完成声明 |

定向验证目标:

```bash
npm run check:current-format
npm run check:runtime-boundaries
npm test -- tests/runtime-contracts
npm run check
npm test
npm run build
git diff --check
```

contract-only 提交至少运行定向 contract tests、`npm run check` 和 `git diff --check`;涉及 public export 或 consumer 的提交再运行对应 consumer tests。完整 contract milestone 必须运行全部命令。

<a id="contract-acceptance"></a>

## 9. 最终验收

- [ ] `04` 是 Runtime 通用 contract 唯一权威入口,没有第二份 phase/status 真源。
- [ ] 文档只拥有 protocol、数据结构、exact schema、event payload、adapter port、被动保存信息和用户级保存位置 contract。
- [ ] manager/service/reducer/backend/daemon/UI/真实 adapter 均路由到明确 owner或标记为无执行授权。
- [ ] 所有 persisted/wire 类型都有单一 public type、exact schema、bounds、fixture 和 consumer。
- [ ] `RuntimeEvent` 是穷尽 payload union,不存在 canonical 宽泛 payload 或领域私有 event。
- [ ] canonical、external ref、reconstructible、ephemeral、forbidden 五类信息没有混淆。
- [ ] event/receipt/projection 不保存 secret 或无界正文,大内容只通过受控 ref 关联。
- [ ] port request/result/error、correlation、idempotency、cancel、generation 和 receipt 语义完整。
- [ ] 所有 RunLedger 自有本地数据只有一个已解析 root:`RUNLEDGER_DIR` 或默认 `~/.runledger`;workspace/cwd 不形成第二个保存根。
- [ ] 固定目录树、UTC session/archive 分片、workspace key、artifact CAS、权限和 path-containment 规则均有 golden/negative fixture。
- [ ] conforming implementation 不向 `<cwd>/.runledger/`、`~/.runledger/agent/` 或任意 sessionDir 新写数据;外部路径至多作为只读 import source。
- [ ] 本计划未实现兼容 reader、迁移器或双写;旧数据迁移由独立计划显式授权,未发生隐式搬移或删除。
- [ ] 下游计划全部指向稳定契约域锚点,不再引用本文件旧阶段编号或把它当行为状态账本。
- [ ] 定向 contract tests、完整 gates、Markdown links 与 `git diff --check` 全绿并附证据。

只有以上 contract 验收完成后,才能对外描述为“Runtime 通用契约与用户级保存位置已冻结”。这不等于目录迁移、任何行为实现、生产 adapter、安全强制、持久化 backend 或客户端已经交付。
