# RunLedger Plan Mode、Model/Context、Compaction 与 Memory 建设计划

> 状态:专项权威执行计划,尚未实施
> 基线日期:2026-07-22
> 适用范围:`src/runtime/`、`src/storage/`、`src/tui/`、`src/cli/`、`.runledger/` 与对应测试
> 参考取证:[`00-reference.md`](00-reference.md)
> 上位计划:[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)

## 0. 文档定位与执行规则

本文件是 Model Compatibility 行为、Plan Mode、ContextEngine、Compaction 和 Memory 的唯一详细执行账本。上位 Runtime 主计划 Phase 6 独占公共数据结构、TypeBox schema、v3 event payload、fixtures 和 contract tests;本文件只消费这些契约,负责具体 router/reducer/service/store/算法、文件边界、PR 顺序、行为测试和逐项完成证据。不得再创建同主题 sibling plan 分散状态。

执行规则:

- 每次只实施一个可独立验收的 PR 边界,完成后在对应复选框补 commit、验证命令和结果。
- 上位 Runtime Phase 6 contract allowlist 在本专项中是只读输入。不得在行为 PR 中顺手修改 `types.ts`、`schema.ts`、v3 event catalog 或 contract fixture,也不得重新定义同义类型。
- 没有 v3 durable event、Capability Gateway 或 Artifact Store 的阶段不得用 v2 临时旁路伪装完成;可以先落纯 reducer/pure planner 等行为函数,但用户可见功能必须等待前置门禁。
- v1/v2 session 只读兼容。Plan Mode、compaction checkpoint、memory approval 和 context receipt 只写入 v3。
- 不覆盖 raw ledger/history。Compaction 只改变 model-visible projection。
- 不把 prompt 约束当权限。所有副作用由 capability/effect gate 判定。
- 不把模型摘要当事实。Plan approval pin digest;compaction 校验 invariant;memory 先 proposal 后 approval。
- 实施前重新核对本文件列出的上游路径和 RunLedger 当前 HEAD,快照不是依赖锁。
- 每个代码 PR 必须运行完整 `npm run check` 与 `npm test`;涉及生成物、依赖或模型 catalog 时再执行仓库规定的额外命令。

## 1. 目标、成功标准与非目标

### 1.1 目标

构建一个可恢复、可审计、权限闭合的上下文体系:

1. 模型与 summarizer 只通过已验证 Compatibility Manifest/profile 路由,不兼容切换明确 fork 或 deny。
2. 用户或 Agent 可进入 Plan Mode,只读探索并维护一个受版本控制的计划工件。
3. 计划必须经过结构化审批才能进入实施;批准内容以 revision + digest 固定。
4. 上下文接近模型窗口时可手动或自动 compact,但原始审计记录保持完整。
5. resume、fork、rewind、model switch 和 overflow retry 都能从 compaction checkpoint 确定性恢复。
6. 长期 Memory 区分 user/workspace/session 来源,支持有界检索、来源、TTL、撤销和审批。
7. compaction 前可以抽取 memory proposal,compaction 后可以重新注入 approved memory 和当前 Plan Mode 状态。
8. TUI、CLI 和未来 daemon/API 只消费同一 runtime command/query/event 协议。

### 1.2 用户可见成功标准

- model/summarizer 路由都有 manifest/profile/digest/reason receipt;未知或不兼容切换不会静默复用 provider-private state。
- `/plan` 或 CLI mode 设置进入 Plan Mode;footer/status 明确显示 `mode:plan`。
- Plan Mode 下 read/grep/find/ls/glob 等只读工具可用;write/edit/multi-edit/bash、未知副作用 MCP 和写型子 Agent fail closed。
- 只有专用 plan writer 能修改当前计划工件;外部篡改后旧审批自动失效。
- `exit_plan_mode` 打开计划审批界面,支持批准实施、fresh-context 实施、请求修改和取消。
- `/compact` 能在稳定 turn 边界生成 checkpoint;重启和 fork 后 model context 与压缩前逻辑一致。
- auto compact 有阈值、预留和单次 overflow recovery;失败不会无限重试。
- `/memory` 可浏览 approved/proposed/revoked record;`/remember` 先预览再批准。
- memory search 返回 record ID、scope、source、line/snippet、score/search mode 和 staleness。
- 每次 mode transition、compaction、memory proposal/approval/injection 都能从 ledger 找到 receipt。

### 1.3 首版非目标

- 不实现跨租户共享 memory、组织级远程 memory service 或 RBAC 管理后台。
- 不默认启用 embedding/vector search;首版 lexical index 可用且可重建。
- 不实现 grok-build 的 two-pass/prefire compaction,先稳定 single-pass。
- 不让 compaction summary 形成 verification pass、goal complete 或用户批准。
- 不让模型自动发布、覆盖或删除长期 memory。
- 不在 Plan Mode 开放任意 shell,即便命令表面看似只读。
- 不从 v1/v2 历史伪造 tool args、reasoning signature、memory provenance 或 compaction checkpoint。

## 2. 前置依赖与落地顺序

本专项承接上位 Runtime 主计划 Phase 6 冻结的公共契约,并在独占文件中实现行为。硬依赖如下:

| 前置能力 | 来源 | 本专项依赖点 |
|---|---|---|
| v3 strict Event Store、writer、reducer、snapshot、recovery | Runtime Phase 1 | mode/checkpoint/approval/receipt 的唯一事实源 |
| Workspace identity 与 execution envelope | Runtime Phase 2 contract + Worktree/Sandbox/Permission 专项 | plan path、memory scope、artifact 引用不能跨 workspace |
| Capability Gateway 与 `deny > ask > allow` | Runtime Phase 3 contract + Worktree/Sandbox/Permission 专项 | Plan Mode 只读硬门禁 |
| Artifact CAS/metadata/retention/redaction | Runtime Phase 4 | plan revision、compaction input/output/diagnostic |
| Resource snapshot/effect contract | Runtime Phase 5 contract + Plugin/MCP/Skill/Hooks 专项 M2–M5 | memory/plan tool 可见性和 MCP 副作用分类 |
| Model/Plan/Context/Compaction/Memory 公共契约 | Runtime Phase 6 | 本专项全部 public type/schema/event/fixture 的唯一来源 |

允许提前落地的内容只有消费已冻结契约的纯 reducer、pure planner、adapter 和行为 fixture。用户可见 `/plan`、`/compact`、memory write 必须等待对应门禁真实可用。

### 2.1 并行开发与文件所有权

| 路径/产物 | 唯一写入者 | 本专项规则 |
|---|---|---|
| `src/runtime/model-routing/{types,schema}.ts` | Runtime Phase 6 | 只读 import,不复制 manifest/decision 类型 |
| `src/runtime/modes/plan/{types,schema}.ts` | Runtime Phase 6 | 只读 import,只实现 reducer/service/policy/tools |
| `src/runtime/context/{types,schema}.ts` | Runtime Phase 6 | 只读 import,只实现 engine/estimator/invariants/projection |
| `src/runtime/context/{compaction,memory}/{types,schema}.ts` | Runtime Phase 6 | 只读 import,只实现 planner/service/store/search/approval |
| `src/runtime/protocol/v3/{events,schemas}.ts` 对应 payload/catalog | Runtime Phase 6 | 只发射已注册 event,不新建临时 event |
| `tests/runtime-v3/contracts/**`、`tests/runtime-v3/fixtures/{model-routing,plan-mode,context,compaction,memory}/**` | Runtime Phase 6 | 只消费;behavior fixture 放专项目录 |
| router/reducer/service/store/index/tools/专用 TUI 组件 | 本专项 | Runtime Phase 6 不得回写实现 |
| `agent-loop.ts`、`interactive-session-controller.ts`、`models*.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` | 串行集成 PR 的当期单一所有者 | 先交付 adapter,再于 Runtime/Extension/Security contract handoff 后集成 |

并行窗口内的稳定分工:

1. Runtime 可继续实现 Phase 7+ 的独占模块,本专项在 behavior path 实现 Model Router、Plan、Context、Compaction 和 Memory;两边都不直接修改对方的独占路径。
2. 需要连接 Event Store、Gateway、Artifact、Extension snapshot 或 Orchestrator 时,本专项先增加内部 adapter 并用 fake port 验证;共享根文件留到阶段的串行 integration commit。
3. 串行集成前必须记录基线 commit、当期所有者和显式路径;handoff 期间其他计划不改同一文件。
4. 上位 Phase 6 完成只表示 contract 已冻结。本专项 Phase 10 完成后只向上位回写汇总状态和证据链接,不把实现 checklist 搬回 Runtime 计划。

### 2.2 Contract 变更与交接流程

1. 行为实现发现契约不足时,本专项先记录缺失场景、安全边界和所需兼容性,停止对该契约的本地扩展。
2. 在上位 Runtime Phase 6 中先升级 type/schema/event version 和 golden fixture,由独立 contract PR 完成 `npm run check`、`npm test` 与 contract tests。
3. 本专项基于新 contract commit 更新 adapter/behavior tests,不与 contract 变更混成同一提交。
4. 不兼容变更必须保留 old-schema read/version fence 或显式 migration;不得用 cast、可选字段泛滥或运行时猜测隐藏漂移。

## 3. 不可变约束

### 3.1 Model Compatibility

1. model/profile/alias 只由已验证 manifest 解析,不在 ContextEngine、CompactionService 或 Orchestrator 中硬编码模型名。
2. route decision 同时绑定 manifest digest、profile digest、request capability 和 session model state;任一变化重新计算。
3. 未知能力是 incompatible/deny,不是 optimistic allow。
4. provider-private reasoning/signature/cache state 只由原 adapter 持有,不通过公共 context 传给其他 provider。
5. session model switch 的 compatible/fork/deny 由 router 判定,但 fork 仍由 Session Kernel command 执行。
6. summarizer 使用独立 profile/budget/retry policy,不自动继承 builder 的 tools 或 credential。

### 3.2 Plan Mode

1. 当前 mode 是 durable runtime state,不能从最后一条 prompt 或 TUI 本地布尔值推断。
2. Agent 主动进入 Plan Mode 必须得到用户批准;用户显式 `/plan` 可直接 arm 下一 turn。
3. `active`/`awaiting_approval` 状态下,除当前 plan artifact 外所有 workspace mutation 默认拒绝。
4. 第一版 Plan Mode 禁止 Bash、写型 MCP、write-capable subagent、hook mutation 和未知 effect 工具。
5. plan writer 只接受 runtime 分配的 `planId/revision`,不能由模型提供任意路径。
6. 审批绑定 `planId + revision + contentDigest + workspaceId`。任一变化都使审批失效。
7. approval pending 在 client 断连、TUI 重建和进程恢复后保持可见。
8. mode instruction、工具面和 authorization policy 必须来自同一 mode snapshot。
9. compaction 不改变 mode;resume 不重放已经被撤销的 activation。
10. fresh-context implementation 必须创建受审计 fork,携带 approved plan reference,不能静默清空当前 session。

### 3.3 Context 与 Compaction

1. 原始 event/history 永不被 compaction 删除或覆盖。
2. model-visible context 只能由 `ContextEngine` 组装,调用点不得自行拼接隐藏 system fragment。
3. 每个 fragment 有 stable ID、source、scope、trust、taint、digest 和 hard budget。
4. tool call 与对应 tool result 不得被 cut point 分开;未完成 tool batch 不允许 commit compaction。
5. plan state、approved plan digest、pending approvals、workspace identity、active goal/task、changed files 和 verification baseline 不依赖摘要保存。
6. compaction summary 生成后必须通过结构、预算、pairing 和 invariant 校验,校验失败不得替换 live projection。
7. manual/auto/overflow/model-switch trigger 共用同一 service 和 checkpoint schema。
8. overflow compact-and-retry 每个 model request 最多一次,且只在无副作用重放风险的边界执行。
9. model switch 前先做 compatibility/preflight;不兼容时 fork,不能强塞 provider-private reasoning state。
10. resume/fork/rewind 必须按 checkpoint range 重建,不能仅寻找“最后一条 summary 文本”。

### 3.4 Memory

1. canonical Memory 是独立权威存储;event 记录 intent、digest、receipt 和引用,不复制 secret 内容。
2. 只有 `approved` 且未过期/撤销的 record 可进入 model context。
3. web、MCP、issue、PR、tool output、模型摘要和 repo 内指令默认 `untrusted`;派生摘要不自动升级 trust。
4. `/remember`、pre-compact flush、session-end extraction 和 dream/consolidation 都先创建 proposal。
5. 发布、更新、删除和 scope 变更必须展示 diff 并产生 approval receipt。
6. 外部编辑导致 digest 漂移时 record 进入 `changed_unreviewed`,停止自动注入。
7. search/read 有 max results、max chars/tokens、path scope 和 stable pagination;index 不可用时显式退化 lexical。
8. runtime 记录实际注入/读取的 record ID 与 digest;不依赖模型自报 citation。
9. TTL、staleness 和 revoked 状态在检索时执行,不能仅由 TUI 隐藏。
10. memory failure 不得破坏主 session;安全策略失败时跳过注入/写入并留下诊断。

## 4. 目标架构

```text
TUI / CLI / future API
        |
        v
InteractiveSessionController / Runtime Commands
        |
        +---------- ModelCompatibilityRouter ----------> Provider
        |
        +---------------- PlanModeService ----------------+
        |                     |                            |
        |                     v                            v
        |               PlanArtifactStore          Approval Service
        |                                                  |
        v                                                  v
ContextEngine <---- CompactionService <---- Capability Gateway
    |                    |                        |
    |                    v                        v
    |              Summarizer/Validator      Tool Runtime
    |                    |----> ModelCompatibilityRouter
    +---- MemoryService -+
             |           |
             v           v
       MemoryStore   SearchIndex

All state transitions ---> v3 Event Store ---> reducers/projections/TUI
Large bodies -----------> Artifact Store/CAS
```

职责边界:

- `ModelCompatibilityRouter` 只根据契约化 manifest/profile 产生 route/fork/deny decision,不直接变更 session 或 provider state。
- `PlanModeService` 只拥有 mode lifecycle、plan revision 和 approval coordination,不直接执行工具。
- `CapabilityGateway` 根据 mode snapshot + tool effect 做最终授权,不读取 TUI 状态。
- `ContextEngine` 只生成 model request context 和 receipt,不修改 canonical history。
- `CompactionService` 生成并提交新 context projection checkpoint,不删除 raw events。
- `MemoryService` 管 proposal/approval/search/injection,不决定 session mode。
- `InteractiveSessionController` 是 facade,不成为这些状态的事实源。

## 5. 目标代码与数据目录

### 5.1 TypeScript 模块

```text
src/runtime/
  model-routing/
    types.ts                   # Runtime Phase 6 contract,本专项只读
    schema.ts                  # Runtime Phase 6 contract,本专项只读
    manifest-loader.ts         # 加载/验证 compatibility manifest
    profiles.ts                # searcher/builder/reviewer/summarizer alias
    router.ts                  # 路由、兼容预检与 fork decision
    adapter-state.ts           # provider-private state 边界
  modes/
    plan/
      types.ts                 # Runtime Phase 6 contract,本专项只读
      schema.ts                # Runtime Phase 6 contract,本专项只读
      reducer.ts               # 纯事件归约
      service.ts               # 安全点转换、审批、resume
      policy.ts                # mode -> tool effect policy
      tools.ts                 # enter/exit/update plan runtime tools
      approval-coordinator.ts  # 复用 Runtime Approval contract
  context/
    types.ts                   # Runtime Phase 6 contract,本专项只读
    schema.ts                  # Runtime Phase 6 contract,本专项只读
    context-engine.ts          # 分层组装、stable ordering、预算
    token-estimator.ts         # provider receipt + conservative estimate
    invariants.ts              # compaction 前后关键状态 digest
    projection.ts              # raw history -> model-visible history
    runtime-adapter.ts         # 共享根文件集成前的单向 seam
    compaction/
      types.ts                 # Runtime Phase 6 contract,本专项只读
      schema.ts                # Runtime Phase 6 contract,本专项只读
      cut-planner.ts
      summarizer.ts
      validator.ts
      service.ts
      reducer.ts
    memory/
      types.ts                 # Runtime Phase 6 contract,本专项只读
      schema.ts                # Runtime Phase 6 contract,本专项只读
      service.ts
      approval-coordinator.ts
      search.ts
      context-fragment.ts
      extraction.ts
src/storage/
  plan-artifact-store.ts       # immutable revisions + mutable working pointer
  memory-store.ts              # canonical records/proposals
  memory-index.ts              # rebuildable lexical projection
  context-paths.ts             # scoped path resolution
src/runtime/tools/
  plan-write.ts                # 唯一 Plan Mode 写入口
  memory-search.ts
  memory-get.ts
  memory-propose.ts
src/tui/components/
  plan-approval.ts
  memory-approval.ts
  memory-browser.ts
  context-status.ts
tests/runtime-v3/
  plan-context-memory/
    contract-consumer.test.ts  # 只验证 public contract 可消费
  model-routing/
  modes/plan/
  context/
    compaction/
    memory/
tests/storage/
  plan-artifact-store.test.ts
  memory-store.test.ts
  memory-index.test.ts
tests/tui/
  plan-approval.test.ts
  memory-approval.test.ts
```

现有大文件接入原则:

- `src/runtime/agent-loop.ts` 已超过 1000 行,专项先在 `context/runtime-adapter.ts` 实现 seam;串行集成 PR 只增加调用,新逻辑必须放进上述模块。
- `src/tui/interactive-mode.ts` 已超过 1100 行,slash handler 和 approval view 先拆到独立 controller/component;只在串行集成 PR 连接,不继续堆状态机。
- `src/runtime/interactive-session-controller.ts` 只在串行集成 PR 暴露 command/query facade,不内嵌 router、compaction 或 memory 算法。
- `src/storage/session-codec.ts` 只保留 v1/v2 compatibility;v3 projection 走独立 reducer。

### 5.2 运行时数据布局

```text
<cwd>/.runledger/
  settings.json
  sessions/
    *.jsonl                         # legacy v1/v2 或 v3 event log
  artifacts/
    <session-id>/
      plans/
        <plan-id>/
          working.md                # 当前可编辑投影,非审批真值
          revisions/
            000001.md               # immutable revision body
            000001.json             # digest/source/author metadata
      compactions/
        <compaction-id>/
          input.json                # bounded/redacted input manifest
          summary.md
          diagnostic.json
  memory/
    MEMORY.md                       # approved workspace memory 的可读投影
    records/
      <memory-id>.json              # canonical approved/revoked metadata + content
    proposals/
      <proposal-id>.json
    index/
      lexical.jsonl                 # 可删除重建,不是事实源

~/.runledger/agent/
  memory/
    MEMORY.md                       # approved user-global 可读投影
    records/
    proposals/
    index/
```

安全要求:

- 目录默认 `0o700`,敏感 metadata/record 默认 `0o600`。
- 文件更新使用同目录 temp + fsync + rename;跨 event/artifact 使用 intent -> object -> committed event。
- plan/memory path 必须由 `workspaceId/sessionId/recordId` 解析,不接受模型输入绝对路径。
- `MEMORY.md` 是 approved record 的可重建人类可读投影;canonical truth 是 record + event receipt。
- index 可随时删除重建;index digest/mode 只作为 search receipt,不参与 record authority。

## 6. 本专项消费的核心契约草案

本节用于解释 behavior 对公共契约的预期,不授权本专项创建或修改这些类型。实际实施时以 Runtime Phase 6 已冻结的 public exports、TypeBox schema、event catalog 和 fixtures 为唯一真源;若与本节不一致,按 §2.2 先修订 Runtime contract,不在 behavior 中临时扩展。

契约实现使用可擦除 TypeScript 语法、显式 `import type` 和 TypeBox schema;不使用 `enum`、参数属性、`any` 或动态 import。

### 6.1 Model compatibility 与 route decision

```ts
export type ModelCapabilityAlias = "searcher" | "builder" | "reviewer" | "summarizer";

export interface ModelCompatibilityProfile {
  manifestDigest: string;
  profileDigest: string;
  modelIdentity: string;
  contextWindow: number;
  maxOutputTokens: number;
  apiProtocol: string;
  toolCallReplay: "supported" | "required" | "unsupported";
  reasoningHistory: "portable" | "adapter_private" | "unsupported";
  midSessionSwitch: "supported" | "fork_required" | "unsupported";
  compactionStrategy: string;
  verifiedAliases: ModelCapabilityAlias[];
  regressionSuite: { version: string; passed: boolean };
}

export interface ModelRouteRequest {
  requestId: string;
  alias: ModelCapabilityAlias;
  currentModelIdentity?: string;
  requiredContextWindow: number;
  requiredOutputTokens: number;
  requiresToolReplay: boolean;
  requiresReasoningReplay: boolean;
  checkpointStrategy?: string;
}

export type ModelRouteDecision =
  | { kind: "route"; profileDigest: string; modelIdentity: string; reason: string }
  | { kind: "fork"; profileDigest: string; modelIdentity: string; reason: string }
  | { kind: "deny"; reason: string; missingCapabilities: string[] };
```

Router 只产生 decision。`fork` 分支由 Session Kernel 执行,model adapter 只保存 provider-private state;profile/manifest/schema 的真正字段以 Runtime Phase 6 contract 为准。

### 6.2 Plan Mode

```ts
export type SessionMode = "default" | "plan";

export type PlanModeState =
  | { kind: "inactive"; revision: number }
  | { kind: "pending_activation"; revision: number; requestedBy: "user" | "agent" }
  | { kind: "active"; revision: number; planId: string; delivered: boolean }
  | {
      kind: "awaiting_approval";
      revision: number;
      planId: string;
      planRevision: number;
      contentDigest: string;
      approvalRequestId: string;
    }
  | {
      kind: "exit_pending";
      revision: number;
      planId: string;
      reason: "user_toggle" | "approved" | "cancelled";
    };

export interface ApprovedPlanRef {
  planId: string;
  revision: number;
  contentDigest: string;
  workspaceId: string;
  approvalReceiptId: string;
}
```

状态转换:

| 当前状态 | 命令/事件 | 下一状态 | 约束 |
|---|---|---|---|
| inactive | 用户 `/plan` | pending_activation | idle 可立即在下一 prompt 激活 |
| inactive | Agent `enter_plan_mode` | pending_activation 或 inactive | 必须经过 approval |
| pending_activation | first prompt/safe drain | active | 同时切 mode tools/policy/context |
| pending_activation | 用户取消 | inactive | 未送达模型时不注入 exit reminder |
| active | `plan_write` | active | revision 增长,旧审批失效 |
| active | `exit_plan_mode` | awaiting_approval | 从 store 读取并 pin digest |
| awaiting_approval | request changes | active | revision 保持,下一次写入再增长 |
| awaiting_approval | approve same session | exit_pending -> inactive | durable 切 default 后提交实施 turn |
| awaiting_approval | approve fresh context | inactive + fork | 新 session 引用 ApprovedPlanRef |
| awaiting_approval | cancel | inactive | 不触发实施 |
| active | mid-turn toggle off | exit_pending | turn terminal 后退出 |

restart 规则:

- `pending_activation` 若 reminder 尚未 durable-delivered,恢复为 `inactive`。
- `exit_pending` 若没有 terminal transition,恢复为 `inactive` 并在下一 turn 注入一次 mode-exit context diff。
- `awaiting_approval` 原样恢复并重新发布 query/UI projection。
- `active` 原样恢复;context engine 用 durable state 重新注入,不依赖旧 summary。

### 6.3 Tool effect 与 Plan policy

`ToolEffect` 和 `CapabilityDecision` 直接复用 Runtime Phase 3 公共契约,本专项不重新声明 effect union。Plan policy 只输出 mode-specific ceiling,最终决策由 Worktree/Sandbox/Permission 专项的 Gateway 与其他 policy source 合并。

```ts
export interface PlanModeCapabilityConstraint {
  ceiling: CapabilityDecision;
  reason: string;
  modeRevision: number;
  matchedEffects: ToolEffect[];
}
```

首版 Plan Mode policy:

| Effect | Plan Mode ceiling |
|---|---|
| `read_workspace` | 最宽 allow,仍受 workspace path guard 和更严策略 |
| `read_external` | 最宽 ask,可被上层收紧为 deny |
| `write_plan_artifact` | 最宽 allow,只限当前 planId |
| `network` | 最宽 ask,结果标 untrusted |
| `write_workspace` | deny |
| `execute_process` | deny |
| `credential` | deny |
| `spawn_agent` | deny;后续只允许继承只读 mode 的 explore child |
| `unknown` | deny |

### 6.4 Context fragment 与 receipt

```ts
export type ContextLayer =
  | "organization_policy"
  | "session_mode"
  | "workspace_knowledge"
  | "approved_memory"
  | "session_history"
  | "current_turn";

export type ContextTrust = "system" | "user_approved" | "untrusted";

export interface ContextFragment {
  id: string;
  layer: ContextLayer;
  sourceType: string;
  sourceId: string;
  digest: string;
  trust: ContextTrust;
  taint: string[];
  priority: number;
  maxTokens: number;
  content: string;
}

export interface ContextAssemblyReceipt {
  requestId: string;
  modelIdentity: string;
  contextWindow: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  included: Array<{ id: string; digest: string; estimatedTokens: number }>;
  omitted: Array<{ id: string; reason: string }>;
  projectionCheckpointId?: string;
}
```

固定组装顺序:

1. organization/system policy,不可被摘要覆盖。
2. current session mode 与 approved plan reference。
3. workspace instructions/resources 与 approved memory。
4. latest committed compaction summary + retained session history。
5. current user turn、steering/follow-up 和未完成合法 tool pairing。

预算策略:

- 先保留 output reserve、tool schema reserve 和 provider safety margin。
- 每个 fragment 先过自身 hard cap,再按 layer priority 放入总预算。
- 真实 provider usage 更新估算基线;缺失时使用保守 byte/token estimator。
- 大 tool result 先走现有 offload/artifact 机制,model context 只保留有 digest 的摘要/引用。
- 任何 fragment 超预算都记录 omitted receipt,不得静默截断关键 policy/plan invariant。

### 6.5 Compaction checkpoint

```ts
export type CompactionReason = "manual" | "auto" | "overflow" | "model_switch";

export interface CompactionCheckpoint {
  schemaVersion: 1;
  compactionId: string;
  sessionId: string;
  reason: CompactionReason;
  sourceFromSequence: number;
  sourceToSequence: number;
  retainedFromSequence: number;
  summaryArtifactId: string;
  summaryDigest: string;
  summarizerModel: string;
  preEstimatedTokens: number;
  postEstimatedTokens: number;
  invariantDigest: string;
  planModeRevision: number;
  approvedPlan?: ApprovedPlanRef;
  previousCheckpointId?: string;
  createdAt: string;
}
```

cut planner 必须输出:

- 可压缩的已完成 turn range。
- 完整保留的 recent tail。
- tool call/result pairing report。
- 需要 offload 的 oversized result 列表。
- pre/post budget estimate。
- 不可压缩原因,例如 active tool batch、pending approval、无安全 cut point。

summary 最低结构:

- 用户目标和明确约束。
- 已批准计划引用,只写 ID/digest,不复制为权威内容。
- 已完成工作和关键决策,带源 sequence/artifact reference。
- 已修改/读取的重要文件与当前状态。
- 未解决问题、pending task、pending approval。
- 最近验证命令与结果,明确其时间和可信边界。
- 需要从 raw transcript/artifact 精确恢复的引用。

validator 至少检查:

- summary 非空、在 max summary budget 内。
- 所有 tool call/result 配对仍完整。
- retained tail 与 source range 不重叠/不留洞。
- mode/plan/workspace/pending approval/goal/task/verification invariant digest 一致。
- summary 不包含 secret 或被 redaction policy 拒绝的内容。
- post-compaction context 在目标 model budget 内。
- checkpoint previous link 与 event sequence 连续。

### 6.6 Memory record 与 proposal

```ts
export type MemoryScope = "user" | "workspace";
export type MemoryStatus = "proposed" | "approved" | "changed_unreviewed" | "revoked" | "expired";

export interface MemorySourceRef {
  sourceType: "user" | "session" | "tool" | "web" | "mcp" | "import";
  sourceId: string;
  digest?: string;
  trust: ContextTrust;
}

export interface MemoryRecord {
  schemaVersion: 1;
  memoryId: string;
  scope: MemoryScope;
  workspaceId?: string;
  status: MemoryStatus;
  title: string;
  content: string;
  contentDigest: string;
  sourceRefs: MemorySourceRef[];
  approvalReceiptId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersedes?: string;
}

export interface MemorySearchReceipt {
  queryDigest: string;
  mode: "lexical" | "hybrid";
  indexDigest: string;
  results: Array<{
    memoryId: string;
    contentDigest: string;
    score: number;
    stale: boolean;
  }>;
}
```

首版 search:

- global + current workspace 两个 scope,不跨未授权 workspace。
- lexical token/phrase match + stable score + source/recency tie-break。
- `maxResults`、`maxSnippetChars`、`maxTotalTokens` 和 cursor 必须硬限制。
- index 损坏时从 canonical record 重建;重建失败返回无结果 + diagnostic,不能返回陈旧未知数据。
- vector/hybrid 作为后续 adapter,不改变 `MemorySearchReceipt` 外部契约。

### 6.7 v3 事件扩展

建议事件类型:

```text
mode.change_requested
mode.changed
mode.activation_delivered
plan.created
plan.revision_written
plan.approval_requested
plan.approval_decided
plan.approval_invalidated
context.assembled
compaction.requested
compaction.started
compaction.summary_generated
compaction.validated
compaction.committed
compaction.failed
memory.proposal_created
memory.approval_requested
memory.approval_decided
memory.publish_intent
memory.published
memory.revoked
memory.search_completed
memory.context_injected
```

事件只保存 bounded metadata。plan/summary/memory 大正文进入 Artifact/Memory Store,事件保存 artifact ID/digest。所有 command 带 `commandId`/expected revision,重复请求返回同一结果或 conflict,不得重复产生审批/写入。

## 7. 端到端流程

### 7.1 Plan Mode

```text
/plan or enter_plan_mode
  -> validate session idle/safe point
  -> append mode.change_requested
  -> if agent initiated: durable approval request
  -> append mode.changed(plan)
  -> ContextEngine injects mode fragment
  -> Gateway swaps to plan policy
  -> PlanStore creates planId revision 0
  -> model explores with read-only tools
  -> plan_write creates immutable revision + digest
  -> exit_plan_mode reads store, not model arguments
  -> append plan.approval_requested
  -> TUI preview pinned revision
      -> revise: active plan mode
      -> approve same session: mode default, submit implementation turn
      -> approve fresh context: fork with ApprovedPlanRef
      -> cancel: mode default, no implementation
```

关键并发规则:

- mid-turn enter/exit 先进入 pending state,只在 model/tool safe drain point 切换 tool surface。
- pending approval 时禁止 model 继续执行写型工具;用户评论作为下一 planning turn 输入。
- plan revision 写入和 approval request 使用 expected revision;晚到的批准不能批准新 revision。
- TUI 关闭不等于拒绝;只有显式 decision 才结束 awaiting state。

### 7.2 Manual/Auto Compaction

```text
trigger
  -> reserve compaction operation id
  -> wait for stable turn/tool boundary
  -> freeze ContextAssemblyReceipt + runtime invariant
  -> plan safe cut and retained tail
  -> optional memory extraction proposal (non-blocking to publication)
  -> build bounded summarizer input
  -> sample summary with tools disabled
  -> validate summary + pairing + invariant + post budget
  -> persist summary/diagnostic artifact
  -> append compaction.validated
  -> append compaction.committed(checkpoint)
  -> atomically switch model-history projection
  -> re-inject current mode/workspace/approved memory
  -> emit projection/query update to TUI
```

失败语义:

- transient sampler error:在 compaction 自己的 retry budget 内重试。
- context overflow:按 verbatim -> fitted -> lossy input ladder 最多降级两次;每次留 attempt receipt。
- deterministic schema/auth/size error:按 reason 设置 current-turn/sticky/until-success suppression。
- validation failure:保留 raw history,不 commit checkpoint,生成 diagnostic artifact。
- artifact 成功而 event commit 失败:artifact 保持 pending,由 recovery 按 intent 继续或回收。
- event committed 但 artifact digest 不可验证:session 标 corrupted/paused,不得继续 sampling。

### 7.3 Overflow 与 Model Switch

- 每次模型请求前用目标 model 的 context window 做 preflight。
- 若新 model 窗口更小或 compatibility manifest 的 compaction/reasoning profile 不兼容,先 compact 或 fork。
- provider 返回 context-length error 时,只有该 turn 尚未开始任何新副作用才允许 compact-and-retry。
- 同一 request 的 `overflowRecoveryCount` 最大为 1;第二次 overflow 直接失败并报告建议操作。
- model switch 和 overflow checkpoint 均保留旧 model identity;summary model 选择由 compatibility router 的 `summarizer` alias 决定。

### 7.4 Memory Proposal、Approval 与 Injection

```text
source(user / session extraction / pre-compact flush / import)
  -> redact + classify trust/taint
  -> dedup exact digest
  -> create proposal with source refs
  -> approval preview shows add/update/delete diff
      -> approve: publish intent -> atomic record -> published event
      -> reject: decision receipt, proposal retained by policy/TTL
      -> edit: new proposal revision, old approval invalidated
  -> rebuild MEMORY.md + lexical index projection
  -> first-turn/post-compact search approved records
  -> ContextEngine injects bounded fragments
  -> context.assembled + memory.context_injected receipts
```

pre-compaction flush:

- 在 auto threshold 前预留 headroom,同一 compaction cycle 最多一次。
- flush model 不开放工具,输入来自本 session trusted projection 与明确标记的 untrusted source。
- 输出为空/`NO_REPLY`/无结构/超限/重复时不创建可发布 record;仍记录中性 outcome。
- flush 失败不能阻止 compaction;只留下 diagnostic。

post-compaction recovery:

- query 由最新用户目标、approved plan title、workspace identity 和 pending task 的 bounded 文本组成。
- 只搜索 approved、未过期、digest valid 的 record。
- 结果作为独立 memory fragment 注入,不拼入 compaction summary。
- 相同 checkpoint resume 时优先复用持久 search receipt/fragment,避免重新排序造成 prompt cache 抖动。

## 8. 配置、CLI 与 TUI

### 8.1 Settings 草案

`ProjectSettings` 增加嵌套字段,用 TypeBox schema 严格清洗;未知字段继续丢弃并诊断。敏感的 managed policy 不放项目 settings。

```ts
export interface PlanModeSettings {
  defaultMode?: SessionMode;
  allowNetworkReads?: boolean;
  requireApprovalForAgentEntry?: boolean;
}

export interface CompactionSettings {
  enabled?: boolean;
  auto?: boolean;
  thresholdPercent?: number;
  reservedOutputTokens?: number;
  retainedTurns?: number;
  maxSummaryTokens?: number;
}

export interface MemorySettings {
  enabled?: boolean;
  initialInjection?: boolean;
  postCompactionRecovery?: boolean;
  maxResults?: number;
  maxSnippetChars?: number;
  defaultTtlDays?: number;
}
```

约束:

- `thresholdPercent` 必须给 output/tool/safety reserve 留空间,建议默认 80,允许范围 50–90。
- memory 默认关闭直到 approval UI 和 provenance 完成;启用也不意味着允许自动发布。
- CLI override 只影响当前 session,持久设置必须经过 settings command/文件变更。
- `RUNLEDGER_DIR`/`RUNLEDGER_SESSION_DIR` 继续影响根路径,但 memory scope 必须用 canonical workspace identity 防止路径别名。

### 8.2 CLI/command surface

计划新增:

- `--mode <default|plan>`:session 初始 mode。
- `/plan [description]`:arm Plan Mode,可直接提交描述。
- `/view-plan`:打开当前 pinned working revision。
- `/compact [focus]`:manual compact,focus 只作为非权威 summarizer hint。
- `/context`:显示 token budget、checkpoint、included/omitted fragment 摘要。
- `/memory`:打开 browser。
- `/remember <text>`:创建 user-authored proposal 并打开审批。
- `/forget <query>`:选择 record 后创建 revoke proposal,不直接删除。

未来 daemon/API command 与 TUI 使用相同 payload,不得为 TUI 另建私有状态转换。

### 8.3 TUI 投影

footer/status 至少显示:

```text
mode:plan  plan:r3/approved?  ctx:78%  compact:idle  mem:on
```

UI 组件:

- Plan approval:immutable revision preview、digest 短码、inline/freeform feedback、same-session/fresh-context/cancel。
- Memory approval:add/update/revoke diff、scope、source、trust、TTL、批准/拒绝/编辑。
- Context status:模型窗口、input estimate、output reserve、largest fragments、last checkpoint、suppression reason。
- Memory browser:approved/proposed/revoked 分组,只读 preview,source refs 和 staleness。

TUI 只保存滚动/焦点/临时输入。mode、approval、compaction、memory 状态来自 reducer projection。

## 9. 分阶段实施计划

### Phase 0:消费 Runtime 公共契约、fixture 与依赖门禁

目标:确认上位 Runtime Phase 6 contract 足以支撑行为实现,不重新定义协议,不改变用户行为。

只读输入:

- `src/runtime/model-routing/{types,schema}.ts`、`src/runtime/modes/plan/{types,schema}.ts`。
- `src/runtime/context/{types,schema}.ts`、`src/runtime/context/{compaction,memory}/{types,schema}.ts`。
- `src/runtime/protocol/v3/{events,schemas}.ts` 中的对应 catalog/payload。
- `tests/runtime-v3/contracts/**` 和 `tests/runtime-v3/fixtures/{model-routing,plan-mode,context,compaction,memory}/**`。

本专项计划文件:

- 新增 `tests/runtime-v3/plan-context-memory/contract-consumer.test.ts`。
- 新增后续 behavior 需要的 fake Event/Artifact/Capability/Resource ports,放在 `tests/runtime-v3/plan-context-memory/fakes/`,不修改 contract fixtures。

任务:

- [ ] 验证 model route、mode/plan ref、context receipt、checkpoint、memory record/proposal/search receipt 都可从 contract-owned public module export import,不要求本专项修改根 barrel。
- [ ] 验证 v3 event catalog 已包含本专项所有 lifecycle payload,每个大正文字段都使用 Artifact/Memory ref。
- [ ] 验证 mode policy 只消费 Runtime capability/effect contract,不按 tool name 创建第二套决策类型。
- [ ] 验证 command expected-revision/idempotency error、approval/artifact/workspace refs 与 Runtime Phase 0/2/3/4 contract 对齐。
- [ ] 跑上位 contract tests 与专项 consumer compile test,记录冻结 contract commit。
- [ ] 检查 behavior 目录不存在同义 `interface/type`、私有 event name 或复制 schema。
- [ ] 在 feature flags 下只注册 adapter factory,不暴露半成品命令。

完成门槛:

- consumer test 仅通过 public exports 编译,对 contract allowlist 的 diff 为空。
- fixture 可表达 incompatible route、approval resume、multi-compaction chain 和 memory revoke/expire。
- Event Store/Artifact/Capability/Resource 依赖通过 typed port/fake 注入,没有隐式全局单例。
- 若契约不足,已按 §2.2 停在 Runtime contract PR,未在本专项引入临时兼容层。

建议 commit:`test: verify plan context contract consumption`

### Phase 1:Model Compatibility Router 行为实现

前置:Phase 0;Runtime Phase 6 model-routing contract 已冻结。

目标:从已验证 manifest 稳定选择能力 profile,在模型切换前给出可审计的 compatible/fork/deny 决策。

任务:

- [ ] 实现 manifest loader 和 schema/version/digest 验证,未知模型或缺失能力 fail closed。
- [ ] 实现 searcher/builder/reviewer/summarizer 能力 alias 和 deterministic profile resolution,不在上层散落模型名。
- [ ] 实现 context/max output、API/tool replay、reasoning history、image/tool schema、compaction strategy 兼容预检。
- [ ] 实现 adapter-private state 边界,只输出 contract 允许的 transferable refs;不兼容 reasoning/signature 不进入新 provider。
- [ ] 产生带 manifest/profile/digest/reason 的 route decision 与 `model.routed` event;decision 本身不执行 fork。
- [ ] 仅在串行集成 PR 对接 `models.ts`/`models-store.ts` 和 session fork command,不修改 provider adapter 内部协议。

测试:

- [ ] verified/unknown/retired profile、alias 缺失、manifest digest 漂移和 regression-suite fence。
- [ ] 同能力可直接切换,不兼容 tool/reasoning/context window 给出稳定 fork/deny reason。
- [ ] summarizer alias 只选择满足 output/context/tool-off 约束的 profile。
- [ ] 路由决策 replay 与 live 一致,不依赖 Map 顺序或本地时钟。

完成门槛:

- 所有 model/summarizer 选择都经过 router,未知兼容性不默认 allow。
- provider-private state 不跨不兼容 adapter 传播,所有 fork/deny 有 typed diagnostic。

建议 commit:`model: route compatible profiles with audited decisions`

### Phase 2:ContextEngine 与 token accounting

前置:Phase 0–1;Runtime Phase 1 Event Store 可用。

目标:所有模型请求先经过统一、可审计的 context assembly。

任务:

- [ ] 实现 fragment registry、fixed layer order、stable ID/digest 和 per-fragment hard cap。
- [ ] 实现 conservative token estimator,接入 provider usage receipt 与模型 context window。
- [ ] 把现有 `systemPrompt/messages/tools` 转成首批 fragment/projection adapter。
- [ ] 先在 `context/runtime-adapter.ts` 实现 `assemble()` seam;串行集成 PR 才对 `agent-loop.ts` 增加唯一调用并删除调用点私自拼接的新增路径。
- [ ] 持久化 bounded `context.assembled` receipt,正文不进 event。
- [ ] 为 omitted fragment、oversized tool result、missing budget 输出结构化诊断。

测试:

- [ ] stable ordering/digest 不受 Map 遍历或 resume 影响。
- [ ] policy/mode fragment 永不被普通 history 挤出。
- [ ] image/tool/reasoning 估算不会发生整数溢出。
- [ ] provider usage 缺失/异常时保守 fallback。
- [ ] 同一 checkpoint resume 生成相同 request-context fixture。

完成门槛:

- 所有 production streamFn request 都有 ContextAssemblyReceipt。
- 超预算在 sampling 前可解释失败,不把超长请求盲送 provider。

建议 commit:`context: assemble bounded model requests from typed layers`

### Phase 3:Plan Mode reducer、store 与 durable lifecycle

前置:Phase 2;Runtime Phase 4 Artifact Store。

目标:模式和计划 revision 可持久恢复,尚不开放实施审批 UI。

任务:

- [ ] 实现纯 `PlanModeState` reducer 和合法 transition table。
- [ ] 实现 `PlanArtifactStore`,working pointer + immutable revision + digest。
- [ ] 实现 user/agent entry command、mid-turn pending activation、安全点 delivery。
- [ ] mode fragment 接入 ContextEngine,同 revision 不重复注入。
- [ ] resume 折叠 transient state,保持 active/awaiting 状态。
- [ ] plan 外部修改检测,digest 漂移触发 approval invalidation。

测试:

- [ ] 全状态转换 table/property test。
- [ ] mid-turn enter 后立即取消不会注入伪 exit。
- [ ] client crash/restart 恢复 active/awaiting 状态。
- [ ] revision 原子写、并发 expected revision conflict、torn temp recovery。
- [ ] workspace/session path 不可逃逸。

完成门槛:

- mode 不依赖 TUI boolean 或 prompt 解析。
- 任何批准都能唯一定位 immutable plan revision。

建议 commit:`plan: persist mode lifecycle and immutable revisions`

### Phase 4:Plan Mode Capability Gateway 与专用工具

前置:Runtime Phase 2/3/5 contract 与对应专项行为门禁;Phase 3。

目标:形成没有 shell/subagent/MCP 绕路的只读硬边界。

任务:

- [ ] 实现 `PlanModePolicy` adapter,把mode snapshot + Runtime `ToolEffect[]` 投影为 capability 约束;不复制 Gateway policy engine。
- [ ] 在串行 integration PR 补齐内建工具 manifest 的结构化 effect,不由本专项改写 Resource/Capability contract。
- [ ] 通过 Worktree/Sandbox/Permission 专项的 Gateway port 合并 organization/workspace/session/mode policy,验证 `deny > ask > allow`;本专项不实现 Gateway。
- [ ] 新增 `enter_plan_mode`、`plan_write`、`exit_plan_mode` 工具。
- [ ] plan writer 不接受 path,只接受 expected revision + full body/patch。
- [ ] Plan Mode 下隐藏或拒绝 write/edit/multi-edit/bash/notebook/todo 和未知副作用工具。
- [ ] MCP 未声明或无法验证 effect 时,Plan policy 输出 `unknown -> deny`,由 Gateway 强制执行。
- [ ] subagent 默认 deny;后续 explore child 必须继承 plan mode + capability 子集。
- [ ] authorization decision 和 tool event 持久化同一 mode revision。

攻击测试:

- [ ] write/edit/multi-edit 直接写 workspace 被拒绝。
- [ ] Bash redirection、`tee`、脚本、包管理器和 git mutation 被拒绝。
- [ ] symlink/`..`/绝对路径不能把 plan writer 指向 plan root 外。
- [ ] 名称伪装成 read 的 MCP/extension 不能绕过 unknown effect。
- [ ] always-approve 不能覆盖 Plan Mode deny。
- [ ] child agent 不能继承更宽 capability。

完成门槛:

- 红队 fixture 中没有可见 workspace mutation。
- denial 既返回模型友好错误,也有完整 policy receipt。

建议 commit:`plan: enforce read-only mode at the capability gateway`

### Phase 5:Plan approval、TUI 与实施交接

前置:Phase 3–4;统一 Approval Service。

目标:完成可恢复的人审闭环。

任务:

- [ ] 实现 plan approval request/decision/expiry/invalidation。
- [ ] `exit_plan_mode` 从 PlanStore 读取并 pin revision/digest。
- [ ] 实现独立 TUI approval component 支持 approve、fresh context、request changes、cancel;串行 integration PR 再接入 `interactive-mode.ts`。
- [ ] feedback 进入下一 planning turn,不直接改计划正文。
- [ ] same-session approval 先 durable 切 default mode,再提交实施 user turn。
- [ ] fresh-context approval 创建 fork + ApprovedPlanRef,旧 session 保持历史可查。
- [ ] approval pending 在 TUI reconnect/resume 后重新出现。
- [ ] status/footer 和 `/view-plan` 先经专用 controller 消费 runtime projection,再在串行 integration PR 接根视图。

测试:

- [ ] stale revision approval 返回 conflict。
- [ ] 外部改 plan 后旧 approval 自动失效。
- [ ] decision 落盘成功但 UI 断连不会重复实施。
- [ ] fresh fork 只携带 approved plan ref 和必要 context,不泄漏未批准 tail。
- [ ] plan approval view snapshot/窄终端/空计划/大计划。

完成门槛:

- 未批准计划无法触发写型实施 turn。
- approved plan digest 在实施请求 ContextAssemblyReceipt 中可追溯。

建议 commit:`plan: add resumable approval and audited implementation handoff`

### Phase 6:Manual single-pass Compaction

前置:Phase 1–2;Runtime Phase 4。

目标:先把最小 compaction 做正确,不启用 auto。

任务:

- [ ] 实现 cut planner,只选完整 stable turn/tool batch。
- [ ] 实现 transcript/artifact input builder 和 output reserve。
- [ ] 实现 summarizer adapter,工具关闭,单独 retry/timeout budget。
- [ ] 实现 summary validator、invariant digest 和 redaction scan。
- [ ] 实现 checkpoint intent/commit 与 model-history projection replacement。
- [ ] `/compact [focus]`、start/completed/failed event 和 TUI 状态接入。
- [ ] compaction 后重新注入当前 mode、workspace、approved plan 和 policy。

golden tests:

- [ ] 无 tool 的多 turn compact。
- [ ] tool call/result 配对和 parallel batch。
- [ ] reasoning/signature 不跨不兼容 provider 泄漏。
- [ ] 多次 compact checkpoint chain。
- [ ] Plan Mode 中 compact 后仍 active 且权限未放宽。
- [ ] pending approval 时 compact 不丢 request。
- [ ] summary validation failure 保持原 projection。
- [ ] crash 位于 artifact write、validated event、commit event 各边界的 recovery。

完成门槛:

- raw event 数和 digest chain 不因 compact 改变。
- resume 后 request fixture 与 compact 后 live request 一致。

建议 commit:`context: add invariant-checked manual compaction checkpoints`

### Phase 7:Auto/Overflow/Resume/Fork/Rewind/Model Switch

前置:Phase 6。

目标:覆盖真正会破坏连续性的边界条件。

任务:

- [ ] 实现 threshold、output/tool reserve 和 preflight trigger。
- [ ] 实现 manual/auto/overflow/model-switch 统一 reason 与 metrics。
- [ ] 实现 verbatim -> fitted -> lossy input ladder 和 attempt receipt。
- [ ] 实现 turn/sticky/until-success suppression,manual compact 可显式绕过 suppression。
- [ ] context-length error 的单次 compact-and-retry guard。
- [ ] resume 读取 latest valid checkpoint + tail。
- [ ] fork 继承 checkpoint/reference,分配新 session identity。
- [ ] rewind 跨 checkpoint 时丢弃未来 projection/checkpoint marker,保留 raw audit。
- [ ] model downshift/comp-hash/reasoning compatibility preflight;不兼容强制 fork。

测试:

- [ ] 阈值边界、配置 clamp、provider usage 漂移。
- [ ] auto compact failure 不每 turn 热循环。
- [ ] overflow 只重试一次且不重复工具副作用。
- [ ] resume/fork/rewind 跨一个和多个 checkpoint。
- [ ] 更小 context model 切换、未知模型、retired model fallback。
- [ ] steering/follow-up 在 compact 中排队且顺序稳定。

完成门槛:

- 任一 session 最终都能解释“为何 compact/为何未 compact/为何被抑制”。
- rollback/fork 不出现未来摘要或孤立 tool result。

建议 commit:`context: make compaction safe across overflow resume and forks`

### Phase 8:Memory Store、Search 与批准发布

前置:Phase 2;Runtime Phase 3/4 contract 与对应安全/Artifact 行为门禁;统一 Approval Service。

目标:构建默认关闭、可人工批准的长期 memory MVP。

任务:

- [ ] 实现 user/workspace scoped canonical store、proposal 和 atomic publish/revoke。
- [ ] 实现 workspace identity mapping,同 repo clone/worktree 可选共享 workspace scope。
- [ ] 生成 `MEMORY.md` 人类可读 projection,但不把它当唯一 metadata 真源。
- [ ] 实现 lexical index、watch/digest scan 和 rebuild。
- [ ] 实现 `memory_search`、`memory_get`、`memory_propose` bounded tools。
- [ ] 实现 `/remember` proposal 和 memory approval diff。
- [ ] 实现 TTL/staleness/revoked/changed_unreviewed 查询过滤。
- [ ] ContextEngine 首 turn 只注入 approved records,记录 search/injection receipt。

测试:

- [ ] global/workspace scope 隔离和 canonical path。
- [ ] proposal approve/edit/reject/revoke/expire 状态机。
- [ ] external edit digest drift 停止注入。
- [ ] index delete/corrupt/rebuild;lexical ordering 稳定。
- [ ] search max results/snippet/token/cursor hard cap。
- [ ] untrusted source 不能自行升级 approved。
- [ ] Memory Store failure 不阻断普通 turn。

完成门槛:

- 每个 injected record 有 approval receipt 和有效 digest。
- 删除 index 后可从 canonical records 完整重建同等 lexical 结果。

建议 commit:`memory: publish only approved scoped records with bounded search`

### Phase 9:Memory 与 Compaction 联动

前置:Phase 7–8。

目标:保存值得长期复用的知识,同时在 compact 后恢复已批准上下文。

任务:

- [ ] 实现 pre-compaction flush threshold/once-per-cycle/lock。
- [ ] flush output 通过 empty/NO_REPLY/header/length/redaction/exact dedup 检查。
- [ ] flush 只创建 proposal,失败不阻止 compact。
- [ ] 实现 post-compaction approved-memory search 和 bounded fragment。
- [ ] 相同 checkpoint resume 复用 search receipt,record 变更时显式 invalidation。
- [ ] session-end extraction 只生成 proposal;设置 eligibility/age/scan/concurrency/lease/backoff。
- [ ] 高级 consolidation 延后为可选后台 job,仍通过 approval 发布差异。

测试:

- [ ] flush 在 hard compact threshold 前触发且每 cycle 一次。
- [ ] `isFlushing` 抑制 auto compact,结束后正确释放。
- [ ] flush sampler error/timeout/duplicate/oversize 均不中断 compact。
- [ ] post-compact recovery 只返回 approved/non-stale/non-revoked record。
- [ ] Plan Mode compact 后 mode + approved plan + memory fragment 均恢复。
- [ ] 多进程 extraction lease 不重复处理同 session。

完成门槛:

- compaction 前后 memory proposal 和 injection receipt 均可从 event/artifact 复核。
- 未经批准的 flush/session summary 永不进入未来 session context。

建议 commit:`memory: bridge approved recall with compaction safely`

### Phase 10:可观测性、文档、兼容与发布门禁

前置:Phase 0–9。

目标:让功能可运维、可回滚、可证明。

任务:

- [ ] 增加 mode/approval/context/compaction/memory metrics,默认只记录 metadata/digest。
- [ ] TUI `/context`、`/memory`、footer/status 与 warning surface 完整接 projection。
- [ ] CLI help/settings schema/README/AGENTS.md/开发文档同步。
- [ ] v1/v2 resume 明确标 legacy;用户第一次 mutation 时 fork/migrate 到 v3。
- [ ] feature flags 支持独立关闭 plan/auto-compact/memory,manual compact 可单独保留。
- [ ] 加 recovery/chaos/large-session/Windows path/permission 测试。
- [ ] 建立 golden fixture 版本和上游行为差异记录。
- [ ] 在本文件补齐所有 commit/验证证据,再只向上位 Runtime Phase 6 回写“专项实现已验收”状态和本文件链接。

完成门槛:

- `npm run check` 与 `npm test` 全绿。
- 所有 failure mode 有用户可见错误、ledger diagnostic 和安全 fallback。
- 默认配置不自动发布 memory,不开放 Plan Mode 副作用逃逸。
- restart/resume/fork/rewind/model switch 测试矩阵全部通过。

建议 commit:`runtime: expose audited plan context and memory lifecycle`

## 10. 验证矩阵

| 维度 | 必测场景 |
|---|---|
| Contract ownership | public export 消费、allowlist 无 diff、无重复类型/私有 event、schema version handoff |
| Model routing | verified/unknown/retired profile、alias、summarizer、reasoning/tool/context compatibility、fork/deny receipt |
| Mode | user/agent entry、decline、mid-turn enter/exit、resume、compaction 后恢复 |
| Authorization | built-in/MCP/hook/subagent/bash/symlink/unknown effect/always-approve |
| Plan artifact | empty/large/concurrent revision/external edit/stale approval/fresh fork |
| Context | stable order、hard cap、omission receipt、tool schema reserve、多模态估算 |
| Compaction | manual/auto/overflow/model switch/multi-compact/validation fail/crash recovery |
| History | tool pairing、reasoning、steering/follow-up、resume/fork/rewind |
| Memory | scope、proposal、approval、TTL、revoke、digest drift、index rebuild、citation receipt |
| Integration | plan + compact、plan + memory、compact + memory、全部三者同时 active |
| Platform | Linux/macOS/Windows path、permission mode、line endings、atomic rename |
| Security | prompt injection、untrusted memory、secret redaction、TOCTOU、path traversal |

每个集成测试应断言完整对象或完整 event sequence,不要只断言单个字段。UI 变化使用稳定 snapshot/文本 fixture,同时验证输入路由,不能只看渲染。

## 11. 迁移与兼容策略

### 11.1 Legacy session

- v1/v2 继续由 `session-codec.ts` 安全文本/canonical message replay。
- legacy session 没有 durable mode 时恢复为 `inactive`,不得从文本猜测 Plan Mode。
- legacy session 没有 checkpoint 时使用完整 replay;首次 compact/plan approval/memory mutation 前创建 v3 fork。
- fork metadata 记录 source path/session ID/high-water mark 和迁移 warning。
- 不把 legacy summary 文本转换成 approved memory;只能成为带 `import/untrusted` 来源的 proposal。

### 11.2 配置

- 新字段缺失使用安全默认:Plan Mode 不默认开启,auto compact 先 feature flag,memory 默认关闭。
- 配置非法时返回结构化 diagnostic 并使用安全 fallback;threshold 不得被 clamp 到无 output reserve 的值。
- 项目 settings 不能放宽 managed/organization deny。

### 11.3 Rollback

- 关闭 feature flag 后保留 v3 events/artifacts,projection 忽略新 command,不删除数据。
- memory rollback 只停止注入/写入,index 可删除;canonical record 保留。
- auto compact rollback 后仍允许读取已有 valid checkpoint;不得强制展开并重写 raw history。
- plan UI rollback 时 awaiting approval 保持 pending,CLI/API 可显式 cancel,不能自动批准。

## 12. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| Plan Mode 只靠工具名 | Bash/MCP/subagent 绕过 | effect manifest + Gateway + unknown deny |
| plan file TOCTOU | 批准内容与实施内容不同 | immutable revision + digest + expected revision |
| summary 遗漏关键状态 | 实施偏离或越权 | state invariant 独立保存 + validator |
| compaction crash 半提交 | resume 使用损坏 projection | intent/object/commit + digest recovery |
| token estimate 偏低 | provider overflow | conservative margin + provider receipt + one retry |
| auto compact 热循环 | 成本/延迟失控 | typed suppression + bounded attempts |
| memory prompt injection | 跨 session 持久污染 | proposal/approval/trust/taint/diff |
| 外部 memory 编辑 | 未审内容被注入 | digest scan -> changed_unreviewed |
| index 漂移 | 错误/陈旧检索 | rebuildable projection + index digest receipt |
| TUI 成为事实源 | reconnect/resume 丢状态 | reducer projection,UI 只存临时交互 |
| Runtime contract 与 behavior 漂移 | 双真源、并行合并冲突 | contract allowlist 只读 + 独立 contract PR + consumer test |
| 多个主计划冲突 | 状态与顺序漂移 | 本文件唯一专项账本,上位计划只汇总,共享文件串行 handoff |

## 13. 总验收清单

- [ ] Runtime Phase 6 contract allowlist 在本专项 behavior commits 中无 diff。
- [ ] 本专项没有重复 public type/schema 或私有 v3 event payload。
- [ ] Model Router 是 model/summarizer 选择的唯一入口,未知/不兼容能力进入 fork/deny。
- [ ] Plan Mode 是 durable state,不是 prompt/TUI flag。
- [ ] Plan Mode deny 能覆盖 always-approve、Bash、MCP 和 subagent。
- [ ] plan approval 绑定 immutable revision/digest/workspace。
- [ ] same-session 与 fresh-context 实施都有 event evidence。
- [ ] 所有 model request 由 ContextEngine 组装并有 receipt。
- [ ] raw history 永不因 compaction 改写。
- [ ] checkpoint 校验 tool pairing、budget 和 runtime invariant。
- [ ] overflow compact-and-retry 每 request 最多一次。
- [ ] resume/fork/rewind/model switch 通过 golden tests。
- [ ] Memory 只有 approved record 能注入。
- [ ] memory proposal/approve/revoke/expire/digest drift 全可审计。
- [ ] pre-compact flush 只产 proposal,失败不阻止 compact。
- [ ] post-compact recovery 只读 approved、有效、scope 匹配的 record。
- [ ] TUI/CLI/未来 API 复用同一 command/query/event schema。
- [ ] v1/v2 保持只读兼容,不伪造新语义。
- [ ] `npm run check` 完整通过。
- [ ] `npm test` 完整通过。
- [ ] 本文件记录各阶段 commit、命令和结果。
- [ ] 共享根文件的每个修改都有基线 commit、当期单一所有者和串行 handoff 证据。
- [ ] 上位 Runtime 主计划 Phase 6 只同步了专项汇总状态和本计划证据链接,未复制 behavior checklist。
