# 有界根级子 Agent 系统实施计划

> 状态：**implemented**。M0–M4 已闭合；M5 Task 8、M6 Task 9 已实现并完成 focused/组合验证；最终全量门禁已通过。M1 仍严格保持 root-owned sequential readonly delegation 的非目标边界。
> 建立日期：2026-08-14
> 重写日期：2026-08-15
> 目标分支：`worktree/bounded-multi-agent-system`
> 审查基线：`c83ef05c4c9ea5cd13fc4f2f36b952d890f77671`
> 上位计划：`04-governed-agent-harness-runtime-plan.md` Phase 9。
> 历史实现只作为语义证据：使用 `git show` 检查 `bb533d3`、`e741c88`、`ac54e38`、`81556ac`；不得把其他分支的代码或测试结果计入本分支完成度。

### Current implementation evidence (2026-08-15)

- M0 Task 1 已提交为 `fd9d346`：bounded agent contracts、hard limits、policy/request/UTF-8 validation。
- M0 Task 2 已提交为 `9f8947f`：user/workspace layered settings、invalid block diagnostics、policy receipt、默认关闭 feature flag。
- M1 Task 3 已提交为 `fd32942`：原子 `beginCommandAttempt`、稳定 command identity、replay/conflict/recovery、`agent_spawn` recovery barrier。
- M2 Task 4 已实现 `graph-events.ts`、`graph-projection.ts`、`graph-store.ts`，并将 `agent.root_registered`、`agent.activated`、`agent.reconciliation_required` 接入 current Runtime event vocabulary；graph revision 与普通 Session event head 分离。
- M3 Task 5 已实现 `capability-subset.ts`、`child-model-runtime.ts`，并由 `assembleSessionDomain()` 登记 production tool source、同一 model/router factory；child capability 只读投影不缩减 parent 工具集。
- M3 Task 6 已实现 `child-runtime.ts`：prepare/activate barrier、Session authorization、Agent budget、实际 loop event usage、abort/cancel/dispose、activation certain/uncertain 分类和 UTF-8 bounded report。
- M4 Task 7 已实现 `supervisor.ts`：root-owned sequential spawn/cancel/inspect、durable lifecycle replay、active/lifetime slot enforcement、terminal first-wins、attempt settlement seam，以及 previous-owner dead/unknown takeover reconciliation。
- M2 focused gate：`npx vitest run tests/runtime/multi-agent/graph-projection.test.ts tests/runtime/multi-agent/graph-store.test.ts tests/runtime-contracts/event-contracts.test.ts tests/runtime-contracts/schema.test.ts --no-file-parallelism`，18 tests passed；`npx tsc --noEmit -p tsconfig.json` passed；`git diff --check` passed。
- M3 closure：`npm run build` passed。
- M4 Task 7 fresh focused gate：`npx vitest run tests/runtime/multi-agent --no-file-parallelism`，7 files / 53 tests passed；`npx vitest run tests/runtime-contracts/event-contracts.test.ts tests/runtime-contracts/schema.test.ts --no-file-parallelism`，2 files / 8 tests passed；activation uncertainty、requested/prepared/running duplicate、terminal append acknowledgement loss、terminal-before-settle 和 cancel/completion 双向竞态均有定向证据；`npx tsc --noEmit -p tsconfig.json` 与 `git diff --check` passed。
- Task 8 predecessor gate（历史基线）：`npm run check` 的前置 boundaries 通过，但当时被既有无关文件 `src/tui/opentui/exec-renderable.ts` 的 forbidden ANSI foreground 检查阻断；该文件不属于当时的 Task 8 修改范围。此前完整 `npm test` 的 Vitest 阶段为 361 个文件通过、1 个跳过、1 个失败（2164 tests passed、3 skipped），仅作 Task 8 基线，不覆盖 Task 9 新增测试；当前最终门禁见下文。
- M5 Task 8 已实现：async `MultiAgentDomainPort` 接入 SessionRuntime flat operation routing，`agent.inspect` query、`agent.spawn`/`agent.cancel` mutation 保留 observer/driver fence 与 recovery barrier；`spawn_agent` 只从 trusted `ToolContext` 派生 identity，和 domain command 复用 replay identity；CLI `--experimental-multi-agent` 默认关闭，user/workspace layered policy 仍为必要 gate；crash takeover 在 Runtime ready 前自动 recovery。
- Task 8 的生产组合修正冻结了 `SessionProductionToolSource.tools` 快照，避免 root 注册 `spawn_agent` 后污染 child source；domain envelope 现在只接受普通 JSON record，malformed async payload 不会被转换成 `{}` 继续执行。
- Task 8 focused gate：`npx vitest run tests/runtime/multi-agent tests/runtime/session-runtime/multi-agent-composition.test.ts tests/runtime/session-runtime/multi-agent-domain.test.ts tests/storage/multi-agent-attempts.test.ts tests/storage/multi-agent-settings.test.ts tests/cli/args.test.ts --no-file-parallelism`，12 files / 109 tests passed；真实 embedded production composition 覆盖 enabled settings 下 durable root registration、root-only `spawn_agent`、governed child read/search/list projection，以及 runtime gate closed。
- Task 8 broader gate（历史基线）：`npx vitest run tests/runtime/session-runtime tests/cli --no-file-parallelism`，68 files / 432 tests passed；`npm run build` passed；`git diff --check` passed。`npm run check` 的 storage/runtime/contract/execution/platform 前置边界通过，完整 gate 当时仍被上述既有 TUI ANSI boundary failure 阻断；当前最终门禁见下文。
- Task 9 bounded integration：新增 `tests/integration/multi-agent-bounded.test.ts`，使用真实 `SessionStore`、`SessionOwner`、`assembleSessionDomain`/embedded composition、production governed tool source、deterministic keyless model provider 与真实 child `Agent`，覆盖 read/search/report、schema authority 缺失、不可见 write leaf、duplicate byte-identical report 和 inspect JSON round-trip；新增 `multiAgentChildRuntimeProvider` 受控 composition seam，provider 仍只接收 governed `ChildPrepareSpec`。
- Task 9 fault integration：新增 `tests/integration/multi-agent-faults.test.ts`，真实 owner takeover 后覆盖 after requested、after prepare、activation acknowledgement loss、after activated、terminal append acknowledgement loss、terminal-before-attempt-settle；focused integration + existing multi-agent/domain/security boundary 共 12 files / 71 tests passed；`npx tsc --noEmit -p tsconfig.json` passed。
- Task 9 static boundary：`check-execution-boundaries.ts` 现在扫描 `src/runtime/agents/**` 与精确的 `src/runtime/session-runtime/domain.ts`（显式隔离 legacy `create-anthropic-agent.ts`）；拒绝 legacy helper import、`localExecutionEnv`、`AllowAllToolAuthorizationPolicy` 和未治理 stdlib factory，`domain.ts` 仅允许带 `requireExecutionEnv: true` 的 governed factory；synthetic RED/GREEN test 与 `node scripts/check-execution-boundaries.ts` passed。
- 2026-08-15 review remediation：production crash takeover 现在把已验证的 dead-owner evidence 传给 Supervisor，并在 `SessionRuntime` 绑定 attempt port 后、server ready 前恢复；无 graph request 的 `agent_spawn` started attempt 会安全拒绝，已有 durable terminal 的 attempt 会按 terminal evidence 收口，未知 owner/nonterminal 仍保持 uncertainty。child active-duration 使用独立 deadline controller 和 bounded completion race；activation event 发布失败会 cancel + dispose live handle。完整 `MultiAgentPolicyReceipt` 在 root/tool 之前以 deterministic `policy.effective_recorded` 落库；command/child/attempt identity 均排除 consumer source 与 owner generation。
- Review remediation focused gate：`npx vitest run tests/runtime/multi-agent tests/runtime/session-runtime/multi-agent-composition.test.ts tests/runtime/session-runtime/multi-agent-domain.test.ts tests/storage/multi-agent-attempts.test.ts tests/storage/multi-agent-settings.test.ts tests/integration/multi-agent-bounded.test.ts tests/integration/multi-agent-faults.test.ts --no-file-parallelism`，13 files / 89 tests passed；随后 `npm run check`、完整 `npm test`、`npm run build` 与 `git diff --check` passed。
- 2026-08-15 final gate：`npm run check`、`npm test`、`npm run build`、`npx tsc --noEmit -p tsconfig.json` 与 `git diff --check` 全部通过；`npm test` 的 Vitest 与 Bun/OpenTUI 阶段均通过，Bun 为 11 files / 91 tests / 449 assertions。此前阻断 `exec-renderable.ts` 的 ANSI foreground 已由独立 TUI 修复提交收口。

## Goal

在当前 Session Owner Runtime 上实现一个默认关闭、可恢复审计、根节点拥有的顺序子 Agent 委托能力：父 Agent 可通过模型工具启动一个进程内只读子 Agent；子 Agent 使用生产治理后的只读工具、独立 Agent 实例和有界运行预算；最终以有界结构化报告返回父 Agent；图状态和控制面 identity 经当前 SessionStore 持久化。

M1 的准确产品语义是 **root-owned bounded sequential delegation**，不是 DAG：只有根 Agent 能委托，子 Agent 不能再次委托，同一根 Agent 同时最多运行一个 child。真正的 DAG、并行、外部 Codex/Claude provider、可写工作区、Artifact/merge 和成本计量均属于后续阶段。

## Architecture

实现分为五个角色，避免把模型工具、Supervisor、运行时和持久化揉成一个对象：

1. `MultiAgentPolicyResolver`：解析 Runtime gate、user settings、workspace settings，生成冻结的 effective policy 和可持久化 receipt。
2. `AgentGraphStore`：把稳定 command identity 投影为 `agent.*` SessionStore 事件；负责进程内串行提交、事件链 head 冲突重试和 replay。
3. `InProcessChildRuntimeProvider`：只负责 prepare/activate/cancel/dispose 子运行时，不拥有图状态或 settings。
4. `AgentSupervisor`：负责委托校验、状态机、预算、终态竞争和 crash takeover reconciliation。
5. Consumers：模型侧 `spawn_agent` 工具，以及 Session Domain 的 query/command facade；两者共享同一个 service 和 attempt/recovery gate。

M1 只注册一个 `providerId: "in_process"` 的 provider。provider 由 Host 选择，模型不能选择 provider、模型 ID、父 Agent identity 或幂等 key。durable descriptor 记录 provider/model/profile/tool manifest digest，但不记录 credential、AbortController、Promise 或进程 handle。

## Global Constraints

- 依赖闭包：`package.json` / `package-lock.json` 零新增依赖。
- 只修改当前 Session Owner Runtime；不得把旧 agent-loop-resurrect 分支或旧代际 runtime 当作当前生产入口。
- 所有跨模块 ID 使用 `src/runtime/protocol/ids.ts` 的 branded ID；不得以裸 `string` 代替 Agent/Session/Command/Attempt/Event ID。
- `parentAgentId`、`sessionId`、`ownerGeneration`、`effectId`、`toolCallId`、`commandId` 和幂等 identity 来自 Host/runtime context，不进入模型参数 schema。
- 子 Agent 只能复用 `assembleSessionDomain()` 已构造的 governed `ExecutionEnv`、Security policy 和生产工具实例；不得重新调用无 `requireExecutionEnv` 的 `createStdlibTools(cwd)`。
- `src/runtime/agents/create-anthropic-agent.ts` 是旧 helper；M1 生产代码不得 import。实现阶段应删除、迁移到 demo，或由静态边界测试明确隔离。
- denied 工具不出现在 child 的模型 schema；即使绕过可见性过滤，最终 ExecutionGateway/authorization 仍必须拒绝。
- 所有外部 effect 在执行前有 durable command intent + started attempt；不以“重试 32 次”代替 exactly-once identity 和 uncertain recovery。
- child 的 objective、system prompt、runtime descriptor 和最终报告都必须受字节上限约束；最终报告需 durable，才能在重复 tool call 时重放。
- M1 child transcript 仍为进程内状态，不提供 cold continuation；计划和产品文案不得把 graph replay 描述为 child 会话恢复。
- 每个任务先写精确 RED 测试，再实现；禁止 `as never` fixture、注释式断言、测试数量硬编码和“按实际字段调整”式占位说明。
- 每任务运行 focused tests、`npm run check` 和 `git diff --check`；`npm run build` 与完整 `npm test` 在里程碑关闭时运行，不为每个局部 commit 重复全仓测试。
- 每任务独立 commit，显式路径 staging；不触碰或提交当前工作区其他无关修改。

---

## 0. 当前事实与依赖

1. `SessionRuntime` 是当前 Session Owner；`handleCommand()` 已将 `domain_command` 视为 mutation，observer 会在 Router 前被拒绝。
2. `SessionDomainRouter` 使用扁平 `operation` 名称，不使用 `{ domain, op }` 嵌套协议；`query()` / `mutate()` 当前为同步返回。
3. `SessionStore.appendEvent()` 在一个事务内检查 owner fence 和 session event-chain head，但不检查 Agent graph revision。
4. `commands` 与 `command_attempt_receipts` 已存在；`recordCommandIntent()` 和 `appendAttemptReceipt()` 当前是两个事务，`AttemptPort.beginAttempt()` 由 Runtime 自行生成 command ID，尚不能消费稳定的 tool-call identity。
5. `ToolContext` 已提供可信 `sessionId` 和 `toolCallId`；Agent 工具的第一个 execute 参数也是 tool call ID。
6. `AgentLoopConfig.runBudget` 已有 `maxModelTurns`、`maxToolTurns`、active duration、重复失败和 approval expiry 限制；M1 不再建立第二套 model-turn state machine。
7. `assembleSessionDomain()` 已构造 session-scoped Security、governed `ExecutionEnv`、managed process 和 production tool instances。
8. 当前 user settings 由 CLI/Host 加载；workspace settings 的存储入口存在，但尚未作为 Session Domain 的独立 policy layer 注入。
9. `RuntimeFeatureFlags` 目前没有进入 `SessionDomainCompositionOptions`，也没有真实 CLI 开启来源。
10. 当前分支没有 provider usage/cost authority；Trace `FileArtifactStore` 只在 recording/process 路径按条件装配，不是通用 child ArtifactStore。
11. `src/runtime/protocol/events.ts` 已含部分 `agent.*` vocabulary。M1 的 SessionStore payload codec 必须与这些 action 的语义一致，不能建立同名但含义冲突的第二套协议。
12. Plan Mode 当前只有 session-scoped inactive projection。M1 root identity 从 session 派生，不依赖 active Goal；可选 `goalId` 只能作为关联信息，不能成为启动前置条件。

---

## 1. M1 外部合同

### 1.1 模型可见输入

模型工具只接受以下内容：

```ts
export const SUBAGENT_ROLES = ["research", "review", "qa", "summarize"] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

export const SUBAGENT_CAPABILITIES = [
  "workspace.read",
  "workspace.search",
  "workspace.list",
] as const;

export interface SpawnSubagentInput {
  readonly role: SubagentRole;
  readonly objective: string;
  readonly requestedCapabilities?: readonly SubagentCapability[];
  /** 请求只能进一步收窄 effective per-agent ceiling。 */
  readonly budget?: {
    readonly maxModelTurns?: number;
    readonly maxToolCalls?: number;
    readonly maxActiveDurationMs?: number;
  };
  readonly output?: {
    readonly kind: "report";
    readonly maxBytes?: number;
  };
}
```

禁止出现在模型 schema 中：`parentAgentId`、`childAgentId`、`sessionId`、`goalId`、`providerId`、`modelId`、`idempotencyKey`、路径形式的 `expectedArtifact`、USD cost。

### 1.2 Host 注入调用上下文

```ts
export interface SubagentInvocationContext {
  readonly sessionId: SessionId;
  readonly ownerGeneration: number;
  readonly rootAgentId: AgentId;
  readonly parentAgentId: AgentId;
  readonly source: "model_tool" | "domain_command";
  /** 模型工具由 Host 从 toolCallId 派生；domain command 使用已校验 envelope effectId。 */
  readonly effectId: string;
  readonly toolCallId?: ToolCallId;
  readonly signal: AbortSignal;
}
```

`parentAgentId` 在 M1 必须等于 root；其他值 fail closed。`commandId`、`childAgentId`、event ID 和 attempt identity 从 `sessionId + rootAgentId + parentAgentId + effectId` 的 canonical digest 派生；`source` 与 owner generation 都不进入 identity，因此模型工具与 Domain command 可共享 replay，crash takeover 后也仍命中原 command。origin/settled generation 只进入 attempt receipt 和 fence。相同 identity + 不同 request digest 返回 `idempotency_conflict`。

### 1.3 模型可见输出

```ts
export interface ChildReport {
  readonly agentId: AgentId;
  readonly outcome: "completed" | "failed" | "stopped";
  readonly report: string;
  readonly reportDigest: RuntimeDigest;
  readonly reportBytes: number;
  readonly usage: {
    readonly modelTurns: number;
    readonly toolCalls: number;
    readonly activeDurationMs: number;
  };
  readonly reasonCode?: ChildTerminalReason;
}
```

- `spawn_agent` tool 阻塞到 child terminal，并返回 `ChildReport`，而不是整个 graph projection。
- 报告从 child 最终 assistant text 生成，按 UTF-8 byte 上限验证；不得按 JavaScript 字符数截断。
- 完成结果先写 durable terminal event，再返回给父工具调用。
- 重复 tool call 命中同 command identity 时，从 terminal event 重放完全相同的报告，不再启动 child。
- graph inspect 只返回 report digest/size/outcome，不默认返回完整 objective/report。

### 1.4 固定计数语义

- root depth = 0；所有 M1 child depth = 1；`maxDepth` 是固定协议不变量，不作为 settings 字段。
- `maxTotalAgents` 包含 root。
- `maxChildrenPerRoot` 和 `maxTotalAgents` 按 session 生命周期累计；failed/not-started child 一旦存在 durable `spawn_requested` 即消耗一个 slot。
- 同一 root 同时最多一个非终态 child；这是 M1 的 `maxActiveChildren = 1` 固定不变量。
- cancelled、failed、stopped child 不释放生命周期 slot，避免通过失败循环绕过限制。
- blocked/denied tool call 已进入 child loop 时计入 `maxToolCalls`；未知工具调用同样计数。

### 1.5 输入上限

- objective：1..16 KiB UTF-8，拒绝空白-only。
- requested capabilities：最多 8 项、去重后仍保持请求顺序；未知值拒绝。
- terminal reason：枚举 code；自由文本 diagnostic 最多 1 KiB，不进入 identity digest。
- report：effective `maxReportBytes`，默认不允许通过 truncation 把超限内容伪装成完整成功；超限进入 `failed/report_limit_exceeded`。如果未来需要截断，必须新增显式 `partial` outcome，而不是静默裁切。
- inspect：最多返回 policy hard ceiling 允许的全部节点；使用排序数组 DTO，禁止直接 JSON 序列化 `ReadonlyMap`。

---

## 2. Policy 与限制层

### 2.1 M1 硬上界

```ts
export interface MultiAgentLimits {
  readonly maxChildrenPerRoot: number;
  /** 包含 root，且为 session 生命周期累计值。 */
  readonly maxTotalAgents: number;
  readonly maxModelTurnsPerAgent: number;
  readonly maxToolCallsPerAgent: number;
  readonly maxActiveDurationMsPerAgent: number;
  readonly maxReportBytes: number;
}

export const MULTI_AGENT_HARD_LIMITS = Object.freeze({
  maxChildrenPerRoot: 3,
  maxTotalAgents: 4,
  maxModelTurnsPerAgent: 12,
  maxToolCallsPerAgent: 32,
  maxActiveDurationMsPerAgent: 300_000,
  maxReportBytes: 65_536,
} satisfies MultiAgentLimits);
```

交叉约束：`maxTotalAgents >= 2` 且 `maxChildrenPerRoot <= maxTotalAgents - 1`。M1 不包含 `maxTotalCostUsd`、`maxCostUsd` 或 `reservedMaxCostUsd`。

### 2.2 三层解析

```text
Runtime deployment gate
  ∩ user settings.multiAgent
  ∩ workspace settings.multiAgent
  ∩ per-request narrowing
```

规则：

1. Runtime gate 默认 false；M5 之前只有测试 composition 能注入 true。M5 增加显式 `--experimental-multi-agent`，标准 CLI 缺省仍为 false。
2. user `enabled` 缺省 false；workspace `enabled:true` 不能开启 user 已关闭的能力；workspace `enabled:false` 可关闭。
3. 数值字段必须是正安全整数。超过 hard ceiling、workspace 大于 user effective value、交叉约束不成立都属于无效 policy，不做 clamp。
4. settings 文件本身可继续供单 Agent 使用，但只要 `multiAgent` 显式存在且无效，multi-agent capability 必须保持 unavailable，并返回结构化 diagnostic；不得静默丢弃后再当作“未配置”。
5. 未知 `multiAgent` 字段拒绝整个 multi-agent block；不能保留其中的 `enabled:true`。
6. 请求级 budget 只能取 effective policy 的更小值；超限请求返回 `limit_exceeded`，不自动 clamp。
7. 解析生成 `MultiAgentPolicyReceipt`：包含 runtime gate、user/workspace source digests、effective limits、diagnostics、resolver version 和 receipt digest。
8. effective receipt 必须在 root registration 和 spawn tool 注册前写入 SessionStore；相同 source digests 重放视为 duplicate，不重复事件。

### 2.3 settings 装配

新增 `loadLayeredProjectSettings({ layout, workspaceKey })`，分别保留 user/workspace 原始层和 diagnostics。`workspaceKey` 来自 canonical workspace identity，不得来自 cwd 文本或模型输入。

`main.ts` / embedded Session Owner composition 在 session catalog identity 可用后加载 workspace 层，并向 `SessionDomainCompositionOptions` 注入：

```ts
interface SessionMultiAgentPolicySources {
  readonly runtimeEnabled: boolean;
  readonly user: MultiAgentSettingsSource;
  readonly workspace: MultiAgentSettingsSource;
}
```

不得把已合并的单个 `ProjectSettings` 再伪装成 user/workspace 两层。

---

## 3. Durable graph 与状态机

### 3.1 状态

```ts
export const AGENT_STATES = [
  "requested",
  "prepared",
  "running",
  "completed",
  "failed",
  "stopped",
  "recovery_required",
] as const;
```

M1 不声明 `paused`、`partial`、`handoff`、`merge` 或 resumable child。

### 3.2 唯一转移表

| Event | From | To | 外部 effect 规则 |
|---|---|---|---|
| `agent.root_registered` | absent | root `running` | 无 child effect |
| `agent.spawn_requested` | absent | `requested` | 必须先于 prepare |
| `agent.spawned` | `requested` | `prepared` | prepare 已返回可 cancel handle，但模型/工具尚未运行 |
| `agent.activated` | `prepared` | `running` | activate 已返回相关 receipt |
| `agent.finished` | `running` | `completed` | 含完整 bounded report terminal record |
| `agent.failed` | `requested/prepared/running` | `failed` | 含 stage + reason code；不得伪装完成 |
| `agent.stopped` | `requested/prepared/running/recovery_required` | `stopped` | cancel 或已证明 previous owner dead |
| `agent.reconciliation_required` | `prepared/running` | `recovery_required` | activation/terminal/cleanup outcome 无法证明 |

规则：

- terminal 为 `completed/failed/stopped`；`recovery_required` 不是 terminal，阻止新 spawn 和 session clean shutdown。
- terminal event 必须携带 `AgentSemanticTerminalRecord`，其中包含 spawn request digest、runtime descriptor digest、完整 bounded report、report digest/bytes、usage、reason code、terminal digest。
- terminal 后任何状态变更都拒绝；同 command ID + 同 digest 返回 duplicate。
- `agent.spawned` 明确定义为 **prepared and controllable**，不是 running。
- `agent.activated` 才表示模型/工具可能开始运行。
- policy receipt 使用已有 `policy.effective_recorded` vocabulary；Agent graph payload codec 与 generic RuntimeEvent projection 的 action/transition 语义必须有合同测试。

### 3.3 Graph projection 与 inspect DTO

内部 projection 可使用 `ReadonlyMap<AgentId, AgentNode>`；跨 JSON/domain 边界必须转换为：

```ts
export interface AgentGraphInspection {
  readonly revision: number;
  readonly rootAgentId: AgentId;
  readonly policyReceiptDigest: RuntimeDigest;
  readonly counts: {
    readonly totalAgents: number;
    readonly nonTerminalChildren: number;
    readonly remainingLifetimeSlots: number;
  };
  readonly nodes: readonly AgentNodeInspection[];
}
```

nodes 按 `createdSequence`、`agentId` 稳定排序；只暴露 objective/report digest、状态、角色、预算使用和 reason code。

### 3.4 Store 提交语义

`AgentGraphStore` 暴露：

```ts
interface AgentGraphStorePort {
  load(): Promise<MultiAgentResult<AgentGraphHead>>;
  commit(command: AgentGraphCommand): Promise<MultiAgentResult<AgentGraphCommitOutcome>>;
  findByCommand(commandId: CommandId): Promise<MultiAgentResult<AgentGraphCommandRecord | undefined>>;
}
```

实现要求：

- 同一 owner 内所有短 graph commit 进入一条内部 queue；不得把整个 child completion Promise 放进 queue。
- commit 前 replay 当前 graph，验证 expected graph revision；append 使用最新 session event-chain hash。
- 非 Agent session event 导致 head hash 漂移时，重新 load 后最多重试 8 次；超过后返回 retryable `store_conflict`，不启动或重启 child。
- graph revision 只随 M1 graph event 增长；不得把全部 session event 数当 graph revision。
- event ID 和 command ID 确定性派生；append ack 丢失后先按 identity 查 durable event，再决定 retry。
- `SessionStore` 增加原子的 `beginCommandAttempt()`：同一事务完成 immutable command intent + started receipt。不得继续使用两个事务拼接新 side effect。
- `AttemptPort` 增加稳定 command identity 输入和 replay outcome；相同 command/digest 的 committed terminal 返回 replay，相同 command/different digest 返回 conflict，started/uncertain 返回 recovery required。
- terminal event 先 durable，再 settle attempt。若 crash 位于两者之间，recovery 从 terminal event 补 verified/committed receipt，不重放 child。

---

## 4. Child runtime 与能力隔离

### 4.1 生产派生的只读工具

M1 capability 到工具的允许映射：

| Capability | 可见工具 |
|---|---|
| `workspace.read` | `read` |
| `workspace.search` | `grep`, `find`, `glob` |
| `workspace.list` | `ls` |

构建 child registry 时同时验证：

1. 工具来自 `assembleSessionDomain()` 已构造的 production tool instances。
2. `tool.isReadOnly?.() === true`；缺失 metadata fail closed。
3. `capabilityClaims` 满足当前 Security policy；只按名字命中不足以授权。
4. 工具使用同一个 governed `ExecutionEnv`；不得退回 `localExecutionEnv()`。
5. `write/edit/multi-edit/bash/web-fetch/process-*/request_permissions/Skill/MCP/LSP/todo` 不进入 M1 child schema。
6. child 的 `beforeToolCall` 继续走 authorization policy；最终 leaf gateway 仍校验 workspace/session/toolCall context。

### 4.2 Model runtime factory

从 `InteractiveSessionController.ensureAgent()` 提取可复用的 session-owned model stream/router factory，或新增等价的私有 port：

```ts
interface ChildModelRuntimeFactoryPort {
  prepare(input: ChildModelPrepareInput): Promise<MultiAgentResult<PreparedChildModelRuntime>>;
}
```

要求：

- 使用父 Session 当前 effective provider/model/thinking selection，但模型不能覆写。
- 复用 `Models.streamSimple`、model compatibility router 和 authorization policy。
- durable descriptor 只记录 provider/model/profile/prompt/tool manifest digest，不记录 credential 或模型对象。
- selection 不可用时在 prepare 前 fail，不能先发布 `agent.spawned`。
- 旧 `createAnthropicAgent` helper 不参与此路径。

### 4.3 prepare / activate 接口

```ts
interface ChildRuntimeProviderPort {
  readonly providerId: "in_process";
  prepare(spec: ChildPrepareSpec): Promise<MultiAgentResult<PreparedChildHandle>>;
}

interface PreparedChildHandle {
  readonly descriptor: ChildRuntimeDescriptor;
  activate(): Promise<MultiAgentResult<ActiveChildHandle>>;
  cancel(reason: ChildStopReason): Promise<MultiAgentResult<void>>;
  dispose(): Promise<MultiAgentResult<void>>;
}

interface ActiveChildHandle {
  readonly activationReceipt: ChildActivationReceipt;
  readonly completion: Promise<MultiAgentResult<ChildRuntimeCompletion>>;
}
```

prepare 不得发 model request、调用工具或写父 workspace。`agent.spawned` durable 后才可 activate。activation throw/timeout/abort 若不能证明未开始，进入 `recovery_required`，不得直接记 `failed`。

### 4.4 Budget

- `maxModelTurnsPerAgent` 映射到现有 `AgentRunBudget.maxModelTurns`。
- active duration 映射到 `maxActiveDurationMs` 和 child-scoped `AgentRunBudgetUsage`。
- 保留现有 `maxToolTurns` hard safety；另用 `beforeToolCall` 精确累计 tool call 数。
- 重复失败和 approval expiry 使用现有 AgentRunBudget 默认值或更窄值，不另建状态机。
- budget exhaustion 产生 `stopped/budget_exhausted`，不是 generic failed。
- usage 以 child loop 的实际事件计数；Supervisor 不接受调用方上报的 used 值。

---

## 5. 目标数据流

```text
父 Agent tool call: spawn_agent(model input, trusted ToolContext)
  │ derive effectId from toolCallId
  │ derive generation-independent commandId/childAgentId/requestDigest
  │ resolve effective policy + request narrowing
  │ beginCommandAttempt(effectClass=agent_spawn)
  ▼
durable agent.spawn_requested
  ▼
ChildRuntimeProvider.prepare                 # 无 model/tool effect
  ▼
durable agent.spawned(state=prepared, descriptor digest)
  ▼
PreparedChildHandle.activate
  ├─ certain reject before activation → agent.failed
  ├─ uncertain outcome → agent.reconciliation_required
  └─ activation receipt
       ▼
durable agent.activated(state=running)
       ▼
await child completion                       # 不持有 graph commit queue
       ├─ cancel wins → durable agent.stopped
       ├─ budget exhausted → durable agent.stopped
       ├─ runtime failure → durable agent.failed
       └─ completed report → durable agent.finished
              ▼
settle command attempt + dispose handle
              ▼
return bounded ChildReport to parent tool result
```

父 Agent 不执行 merge：M1 child 只读，输出是报告。

---

## 6. 文件结构

新增：

```text
src/runtime/agents/
  types.ts                  # branded contracts、状态、输入/输出 DTO、错误码
  limits.ts                 # hard limits、user/workspace/request resolver
  graph-events.ts           # exact SessionStore payload codecs + event factories
  graph-projection.ts       # pure reducer + transition table
  graph-store.ts            # replay、短提交 queue、identity lookup
  capability-subset.ts      # governed production tool filtering
  child-model-runtime.ts    # session-owned model/router factory seam
  child-runtime.ts          # in-process prepare/activate/cancel/dispose
  supervisor.ts             # spawn/cancel/inspect/recovery orchestration
  domain.ts                 # async MultiAgentDomainPort + operation manifest
  spawn-tool.ts             # model-visible spawn_agent Consumer
  index.ts                  # public barrel

tests/runtime/multi-agent/
  limits.test.ts
  graph-projection.test.ts
  graph-store.test.ts
  capability-subset.test.ts
  child-runtime.test.ts
  supervisor.test.ts
  recovery.test.ts

tests/storage/
  multi-agent-settings.test.ts
  multi-agent-attempts.test.ts

tests/runtime/session-runtime/
  multi-agent-domain.test.ts
  multi-agent-composition.test.ts

tests/integration/
  multi-agent-bounded.test.ts
  multi-agent-faults.test.ts
```

修改：

- `src/storage/settings-manager.ts`：保留 `multiAgent` presence/diagnostics；user/workspace 分层 loader。
- `src/storage/session-store/session-store.ts`：原子 `beginCommandAttempt` 与稳定 command replay 查询。
- `src/runtime/session-owner/types.ts` / `schemas.ts`：新增 `agent_spawn` effect class 及 exact validation。
- `src/runtime/runtime-features.ts`：增加默认 false 的 `multiAgent`。
- `src/runtime/protocol/events.ts` / `schemas.ts`：对齐新增 `agent.root_registered`、`agent.activated`、`agent.reconciliation_required` 的 projection vocabulary；不得改变既有 event 的 action 含义。
- `src/runtime/interactive-session-controller.ts`：提取 child 可复用的 model stream/router seam，不暴露 private Agent。
- `src/runtime/session-runtime/domain.ts`：注入 policy sources、governed child factory、Supervisor 和 async domain port。
- `src/runtime/session-runtime/domain-router.ts`：只注册/验证 operation manifest；inspect 仍走 query。
- `src/runtime/session-runtime/session-runtime.ts`：路由 async multi-agent command，保留 driver/recovery fence。
- `src/cli/embedded-session-runtime.ts`：crash takeover 时在 Runtime ready 前运行 multi-agent recovery。
- `src/cli/args.ts` / `main.ts`：M5 增加显式 experimental gate 并注入 policy layers。
- `development-doc/00-index.md`、`AGENTS.md`：实现完成后记录准确 M1 边界。

---

## 7. 里程碑与任务

### M0：冻结合同与 policy

#### Task 1：合同、硬上界和解析器

**Files**

- Create: `src/runtime/agents/types.ts`
- Create: `src/runtime/agents/limits.ts`
- Create: `src/runtime/agents/index.ts`
- Test: `tests/runtime/multi-agent/limits.test.ts`

- [x] RED：精确覆盖默认关闭、workspace 关闭、workspace 不能开启、所有数值边界、超 hard ceiling、workspace widening、交叉约束、请求级 narrowing、UTF-8 objective/report byte bounds。
- [x] GREEN：实现本计划 §1/§2 合同；所有输出冻结或 readonly。
- [x] 验证错误码至少区分 `invalid_policy`、`invalid_request`、`limit_exceeded`、`idempotency_conflict`、`unsupported_feature`、`recovery_required`、`store_conflict`、`runtime_unavailable`。
- [x] Run: `npx vitest run tests/runtime/multi-agent/limits.test.ts`（7 tests passed）。
- [x] Run: `npm run check && git diff --check`（2026-08-15 final gate passed）。
- [x] Commit: `feat(agents): define bounded root delegation contracts`

#### Task 2：user/workspace settings 与 policy receipt

**Files**

- Modify: `src/storage/settings-manager.ts`
- Create: `tests/storage/multi-agent-settings.test.ts`
- Modify: `src/runtime/runtime-features.ts`

- [x] RED：公开 loader 返回 user/workspace 独立来源；合法 block 保留；显式非法/未知字段产生 diagnostic 且 capability unavailable；workspace widening 拒绝；普通 settings 仍可加载。
- [x] RED：`saveProjectSettings` 使用真实 `RunledgerLayout` fixture 类型，不使用 `as never`。
- [x] GREEN：新增 layered loader 和 `MultiAgentPolicyReceipt` builder；storage parse 不静默抹掉 `multiAgent` presence。
- [x] RED/GREEN：Runtime feature 缺省 false，source 无效时 fail closed。
- [x] Run: `npx vitest run tests/storage/multi-agent-settings.test.ts tests/storage/settings-manager.test.ts`（相关测试通过）。
- [x] Run: `npm run check` 前置 boundaries 通过；历史完整 gate 曾被既有 TUI ANSI boundary failure 阻断，当前最终 gate 已通过；`git diff --check` 通过。
- [x] Commit: `9f8947f feat(settings): resolve layered multi-agent policy`

**M0 closure**

- [x] Run: `npm run build`（随当前 M3 closure 延后执行并于 2026-08-15 passed）。
- [x] 记录实际命令和结果；不得记录历史测试数量。

### M1：稳定 command identity 与 attempt recovery

#### Task 3：原子 begin、稳定 identity 和 replay

**Files**

- Modify: `src/storage/session-store/session-store.ts`
- Modify: `src/runtime/session-owner/types.ts`
- Modify: `src/runtime/session-owner/schemas.ts`
- Modify: `src/runtime/session-runtime/attempt-gateway.ts`
- Modify: `src/runtime/session-runtime/recovery-barrier.ts`
- Modify: `src/runtime/session-runtime/session-runtime.ts`
- Create: `tests/storage/multi-agent-attempts.test.ts`

- [x] RED：command intent + started receipt 中途故障不得产生只有 intent 的半写。
- [x] RED：同 command/same digest 返回 started/committed replay；same command/different digest 冲突。
- [x] RED：`agent_spawn` 在 recovery barrier open 时拒绝；readonly inspect 仍允许。
- [x] GREEN：`beginCommandAttempt({ commandId, effectClass, requestDigest })` 在一个 immediate transaction 内提交 intent + started receipt。
- [x] GREEN：扩展 AttemptPort 返回 `started | replay_committed | recovery_required | conflict`，不再为 subagent 自行生成 command ID。
- [x] Run: `npx vitest run tests/storage/multi-agent-attempts.test.ts tests/runtime/session-runtime/recovery.test.ts tests/runtime/session-runtime/recovery-barrier.test.ts`（相关测试通过）。
- [x] Run: `npm run check` 前置 boundaries 通过；历史完整 gate 曾被既有 TUI ANSI boundary failure 阻断，当前最终 gate 已通过；`git diff --check` 通过。
- [x] Commit: `fd32942 feat(runtime): add idempotent agent spawn attempts`

### M2：durable graph

#### Task 4：事件 codec、纯投影和 store

**Files**

- Create: `src/runtime/agents/graph-events.ts`
- Create: `src/runtime/agents/graph-projection.ts`
- Create: `src/runtime/agents/graph-store.ts`
- Modify: `src/runtime/protocol/events.ts`
- Modify: `src/runtime/protocol/schemas.ts`
- Test: `tests/runtime/multi-agent/graph-projection.test.ts`
- Test: `tests/runtime/multi-agent/graph-store.test.ts`

- [x] RED：逐条覆盖 §3.2 每一条合法和非法 transition；unknown key/event、terminal 缺 record、terminal 后变更全部拒绝。
- [x] RED：graph revision 只随 graph event 增长；其他 Session event 插入不会改变 graph revision。
- [x] RED：重复 event/command replay、不同行为 digest 冲突、append ack loss、session head conflict 重试上限。
- [x] RED：inspect DTO 为稳定排序数组，JSON round-trip 不丢节点。
- [x] GREEN：实现 exact payload decoder，拒绝未知字段；objective/report 使用 UTF-8 bytes 验证，runtime descriptor 以 bounded digest 持久化。
- [x] GREEN：实现短 mutation queue；graph commit 不等待 child completion Promise。
- [x] GREEN：补 RuntimeEvent projection vocabulary 合同测试，证明同名 `agent.*` action/transition/ref 语义一致，且不改变既有 command action 语义。
- [x] Run: `npx vitest run tests/runtime/multi-agent/graph-projection.test.ts tests/runtime/multi-agent/graph-store.test.ts tests/runtime-contracts/event-contracts.test.ts tests/runtime-contracts/schema.test.ts --no-file-parallelism`（18 tests passed）。
- [x] Run: `npm run check` 前置 boundaries 通过；完整 gate 被既有 TUI ANSI boundary failure 阻断；`git diff --check` 通过。
- [x] Commit: `feat(agents): persist the bounded child graph`

**M2 closure**

- [x] Run: `npm run build`（Task 4 commit 前执行并通过）。

### M3：governed child runtime

#### Task 5：生产工具子集和 model runtime seam

**Files**

- Create: `src/runtime/agents/capability-subset.ts`
- Create: `src/runtime/agents/child-model-runtime.ts`
- Modify: `src/runtime/interactive-session-controller.ts`
- Modify: `src/runtime/session-runtime/domain.ts`
- Test: `tests/runtime/multi-agent/capability-subset.test.ts`

- [x] RED：只允许 §4.1 映射；unknown/write/network/process/MCP/Skill/LSP/todo 全部不出现在 schema。
- [x] RED：允许名但 `isReadOnly` 缺失、claims 不符、tool instance 非 production composition 来源时 fail closed。
- [x] RED：恶意直接调用隐藏 write/bash 时最终 authorization/ExecutionGateway 拒绝，workspace 不变。
- [x] RED：child 与 parent 共享 model compatibility router；模型选择不可用时 prepare 前失败。
- [x] GREEN：从已治理 tool instances 过滤并构建新 registry；不复制 raw executor，不调用 legacy Anthropic helper。
- [x] GREEN：提取最小 session-owned model runtime factory；graph 只记录 descriptor，不记录 credential。
- [x] Run: `npx vitest run tests/runtime/multi-agent/capability-subset.test.ts tests/runtime/session-runtime/security-composition.test.ts --no-file-parallelism`（21 tests passed）；`npx tsc --noEmit -p tsconfig.json` passed；`git diff --check` passed。
- [x] Run: `npm run check` 前置 boundaries 通过；历史完整 gate 曾被既有 TUI ANSI boundary failure 阻断，当前最终 gate 已通过。
- [x] Commit: `feat(agents): derive governed child runtime capabilities`

#### Task 6：prepare/activate/cancel/dispose 与预算

**Files**

- Create: `src/runtime/agents/child-runtime.ts`
- Test: `tests/runtime/multi-agent/child-runtime.test.ts`

- [x] RED：prepare 零 model/tool 调用；activate 后才允许第一轮。
- [x] RED：max model turns、max tool calls、active duration、abort before activation、abort during model、abort during tool、report byte overflow。
- [x] RED：activation certain rejection 与 uncertain throw 返回不同结果。
- [x] RED：completion 统计来自实际 loop events，不接受外部伪造 usage。
- [x] GREEN：复用 `Agent` + `runAgentLoop` 现有 budget；只为精确 tool-call count 增加 child hook。
- [x] GREEN：报告先 canonical digest/byte validation，再生成 completion；dispose 可幂等调用。
- [x] Run: `npx vitest run tests/runtime/multi-agent/child-runtime.test.ts tests/agent-loop.test.ts tests/runtime/agent-loop-overflow.test.ts --no-file-parallelism`（18 tests passed，含 child authorization/dispose 回归）。
- [x] Run: `npm run check` 前置 boundaries、contract consumers、tsc 通过；历史完整 gate 曾被 TUI ANSI foreground 检查阻断，当前最终 gate 已通过；`git diff --check` passed。
- [x] Commit: `feat(agents): add prepared in-process child runtime`

**M3 closure**

- [x] Run: `npm run build`（2026-08-15，passed）。

### M4：Supervisor 与 crash takeover

#### Task 7：spawn/cancel/inspect/recovery

**Files**

- Create: `src/runtime/agents/supervisor.ts`
- Test: `tests/runtime/multi-agent/supervisor.test.ts`
- Test: `tests/runtime/multi-agent/recovery.test.ts`

- [x] RED：完整 `requested → prepared → running → completed`，并通过 append hook 断言 `spawned/activated` 先于真实 model start、terminal 随后追加。
- [x] RED：children/total lifetime limits、一个 active child、failed spawn 消耗 slot、child 再委托拒绝。
- [x] RED：duplicate tool call 在 requested/prepared/running/terminal 各阶段的 replay/recovery 行为。
- [x] RED：cancel/completion race 两种顺序；durable terminal first-wins，晚到结果不能覆写。
- [x] RED：crash after requested、after prepare、activation ack loss、after activated、terminal append ack loss、terminal-before-attempt-settle。
- [x] RED：已证明 previous owner process dead时自动 stopped；证明不足时 recovery_required，禁止新 spawn。
- [x] GREEN：每个 child 使用短临界区状态锁；spawn 等 completion 时 cancel/inspect 仍可运行。
- [x] GREEN：registerRoot 为内部 composition 操作；root ID 从 session canonical 派生，goalId 仅可选关联。
- [x] Run: `npx vitest run tests/runtime/multi-agent --no-file-parallelism`（7 files / 53 tests passed）；runtime contract 2 files / 8 tests passed；`npx tsc --noEmit -p tsconfig.json` 与 `git diff --check` passed。
- [x] Run: `npm run check`（2026-08-15 final gate passed）；`git diff --check` passed。
- [x] Commit: `feat(agents): orchestrate bounded child lifecycle recovery`。

### M5：Session Domain 与模型工具接线

#### Task 8：async domain、双闸门和 spawn_agent Consumer

**Files**

- Create: `src/runtime/agents/domain.ts`
- Create: `src/runtime/agents/spawn-tool.ts`
- Modify: `src/runtime/session-runtime/domain.ts`
- Modify: `src/runtime/session-runtime/domain-router.ts`
- Modify: `src/runtime/agents/capability-subset.ts`（冻结 production source 工具快照，防止 root-only tool 反向进入 child source）
- Modify: `src/runtime/session-runtime/session-runtime.ts`
- Modify: `src/cli/embedded-session-runtime.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/cli/main.ts`
- Test: `tests/runtime/session-runtime/multi-agent-domain.test.ts`
- Test: `tests/runtime/session-runtime/multi-agent-composition.test.ts`
- Test: `tests/cli/args.test.ts`

- [x] RED：Runtime flag false、user disabled、workspace disabled、invalid policy 时工具不注册，commands 返回 unavailable/invalid-policy 的 fail-closed 结果。
- [x] RED：`domain_query operation="agent.inspect"` observer 可读；`domain_command operation="agent.spawn|agent.cancel"` observer 被现有 driver fence 拒绝。
- [x] RED：recovery barrier open 时 spawn 拒绝、inspect 可读；不公开普通 `agent.reconcile` 命令。
- [x] RED：spawn tool 参数 schema 不含 authority/idempotency/provider/model 字段，execute 使用 ToolContext 派生 identity。
- [x] RED：spawn tool 和 domain command 对同一 command identity 共享 replay，不产生两个 child。
- [x] RED：`--experimental-multi-agent` 默认 false；显式开启仍需 settings gate；无效 CLI 值 fail closed。
- [x] RED：真实 production source 与父 controller 共享可变工具数组时，root-only `spawn_agent` 会污染 child source；malformed async payload 会被错误地作为空对象路由。
- [x] GREEN：增加 async `MultiAgentDomainPort`，沿用 flat operation manifest；不得把 inspect 塞进 `domain_command`。
- [x] GREEN：policy receipt/root registration durable 后才把 tool 添加到父 Agent 工具集；production source 使用冻结工具快照。
- [x] GREEN：`embedded-session-runtime` 在 crash takeover、Runtime ready 前调用 automatic recovery。
- [x] GREEN：domain envelope 只接受普通 JSON record，拒绝非 record payload。
- [x] Run: focused multi-agent/storage/CLI gate，12 files / 109 tests passed；真实 embedded production composition included。
- [x] Run: full Session Runtime + CLI gate，68 files / 432 tests passed。
- [x] Run: `npm run check`（2026-08-15 final gate passed）；`git diff --check` passed。
- [x] Run: `npm run build` passed。
- [x] Commit: `feat(runtime): wire bounded child delegation into session owner`

**M5 closure**

- [x] Run: `npm run build`

### M6：真实组合、故障矩阵与文档

#### Task 9：keyless integration、边界 gate 和状态文档

**Files**

- Create: `tests/integration/multi-agent-bounded.test.ts`
- Create: `tests/integration/multi-agent-faults.test.ts`
- Modify: `scripts/check-execution-boundaries.ts`
- Modify: `development-doc/00-index.md`
- Modify: `AGENTS.md`

- [x] RED/GREEN：使用真实 SessionStore、owner fence、`assembleSessionDomain`、真实 `Agent`、生产派生只读工具和 deterministic mock model，完成 spawn→read/search→report→parent tool result。
- [x] RED/GREEN：断言 child 尝试 write/bash/MCP 时 schema 不可见且最终 leaf 不执行。
- [x] RED/GREEN：按 Task 7 的每个 crash point 注入故障，并重新创建 Session Owner 验证 replay/recovery。
- [x] RED/GREEN：重复 tool call 返回 byte-identical report；inspect JSON 可由 client round-trip。
- [x] Static gate：生产 multi-agent 文件不得 import `create-anthropic-agent.ts`、`localExecutionEnv`、`AllowAllToolAuthorizationPolicy` 或未经治理的 stdlib factory。
- [x] 更新 `development-doc/00-index.md` 和 `AGENTS.md`：只声明 M1 root-owned sequential readonly delegation；列出全部非目标。
- [x] Run: `npx vitest run tests/integration/multi-agent-bounded.test.ts tests/integration/multi-agent-faults.test.ts`（7 tests passed）；相关 multi-agent/domain/security boundary 共 12 files / 71 tests passed。
- [x] Run: `node scripts/check-execution-boundaries.ts`
- [x] Run: `npm run check`（2026-08-15 final gate passed）
- [x] Run: `npm run build`
- [x] Run: `npm test`（Vitest 与 Bun/OpenTUI 全部通过；Bun 11 files / 91 tests / 449 assertions）
- [x] Run: `git diff --check`
- [x] Commit: `docs(runtime): record bounded child delegation evidence`

---

## 8. 验收矩阵

| # | 验收项 | 必需证据 |
|---|---|---|
| 1 | M1 范围诚实 | child 无 spawn tool；所有 depth=1；无 DAG/merge/cost 文案 |
| 2 | policy 可配置且只收窄 | user/workspace/request 解析矩阵；无效 block capability unavailable；receipt durable |
| 3 | 可信 identity | 模型 schema 无 authority 字段；toolCall 派生稳定 command；different digest conflict |
| 4 | attempt 原子性 | command intent + started receipt 单事务；crash/replay 不重复 child effect |
| 5 | graph 状态机 | 唯一转移表、exact payload、terminal discipline、JSON inspect DTO |
| 6 | prepare/activate barrier | durable `spawned` 前零 model/tool；`activated` 后才开始执行 |
| 7 | governed capability subset | 只读工具来自 production composition；denied schema 隐藏；final gateway 仍拒绝 |
| 8 | 有界运行 | model turns、tool calls、active duration、report bytes 均有边界和精确终态 |
| 9 | cancel/terminal race | durable first-wins；late completion 不覆写；dispose 幂等 |
| 10 | owner takeover | dead-owner 自动 stopped；证据不足 recovery_required；不冷恢复 transcript |
| 11 | 双闸门与命令面 | experimental flag + settings；query/command、observer/driver、barrier 语义正确 |
| 12 | 父模型收到结果 | spawn tool 返回 bounded ChildReport；duplicate byte-identical replay |
| 13 | 真实组合 | Session Owner + SessionStore + governed tools + deterministic model keyless E2E |
| 14 | 静态边界 | 不依赖 raw stdlib/local env/legacy Anthropic helper |

任何一项缺失时，M1 不得标记完成或 advertise 为 production multi-agent。

---

## 9. 显式非目标与后续入口

| 非目标 | M1 不实现的原因 | 后续入口 |
|---|---|---|
| DAG / child 再委托 | M1 child 没有 spawn Consumer | 新增 child-scoped delegation authority 后把固定 depth=1 改为 policy depth |
| 并行 spawn | M1 固定一个 active child | async pool、fair scheduling、aggregate budget 与多 child cancel |
| 外部 Codex/Claude/ACP provider | M1 只有 in-process provider | provider registry + provider-specific continuation descriptor；Host 选择 provider |
| child transcript cold continuation | M1 Agent state 在内存 | durable child session/ledger、provider/model/prompt replay 和 continuation token |
| 可写 child / 独立 worktree | 当前 R6 worktree cold-resume 仍有依赖 | `AgentWorkspacePort` + lease/fence + cleanup receipt |
| Artifact/CAS/handoff/merge | readonly M1 只返回报告 | 通用 ArtifactStore port、verified ref、apply/merge transaction |
| USD 成本限制 | 当前无 provider usage/cost authority | usage event、late reconciliation、root reservation/settlement |
| TUI `/agents` 面板 | 先稳定 query DTO 和 lifecycle | 基于 `agent.inspect` 的只读 UI |
| 热替换/跨进程恢复 | M1 handle 只在 owner 进程内 | durable activation descriptor、writer fence、standby/replacement protocol |

这些非目标不得以空字段、`verified:false` placeholder、无效 `maxCostUsd` 或未使用的状态枚举提前进入 M1 public contract。

---

## 10. Commit 与完成纪律

建议 commit 顺序：

1. `feat(agents): define bounded root delegation contracts`
2. `feat(settings): resolve layered multi-agent policy`
3. `feat(runtime): add idempotent agent spawn attempts`
4. `feat(agents): persist the bounded child graph`
5. `feat(agents): derive governed child runtime capabilities`
6. `feat(agents): add prepared in-process child runtime`
7. `feat(agents): orchestrate bounded child lifecycle recovery`
8. `feat(runtime): wire bounded child delegation into session owner`
9. `docs(runtime): record bounded child delegation evidence`

每个 commit 只包含任务声明的路径和必要的直接依赖。若实现发现当前生产 authority 不足，先保留 RED 测试和更新本计划的 blocked evidence，不得用 fake adapter、AllowAll、raw filesystem/shell 或历史分支测试结果替代生产闭环。

## 11. 自审结论

- M1 名称、实现和验收均为 root-owned sequential readonly delegation，不再声称 DAG。
- cost、Artifact、merge、child continuation 已从 M1 合同和验收移除。
- spawn tool 的模型输入、Host authority、stable command identity 已分离。
- `spawned` 与 `activated` 有明确 durability barrier；completion Promise 不再承担 publication 语义。
- settings invalid/widening 行为、workspace layer 来源和 feature enable path 已明确。
- capability visibility 与最终 Gateway enforcement 已分层。
- graph revision、session event head、command attempt、append ack loss 的职责已区分。
- observer inspect 使用 query；spawn/cancel 使用 command；recovery 为 owner lifecycle，不是普通手工命令。
- 所有测试任务均要求精确可执行断言，无占位 fixture、注释断言或历史测试数量。
