# RunLedger Loop / Goal / Dynamic Workflow 实施计划

> 文档状态:待实施,架构与阶段边界已冻结<br>
> 编写日期:2026-07-24<br>
> RunLedger 规划基线:`feat/agent-loop-resurrect@678b046b3cd11632c5e5bfc7ef5dd210e8f23ec3`<br>
> Runtime 权威总计划:[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)<br>
> 外围专项冻结:[`../runtime/06-specialty-implementation-freeze.md`](../runtime/06-specialty-implementation-freeze.md)<br>
> 参考研究:[`00-reference.md`](00-reference.md)<br>
> RED-first 清单:[`02-implementation-checklist.md`](02-implementation-checklist.md)

## 0. 文档定位、权威关系与执行规则

### 0.1 文档定位

本文件是 Runtime 主计划下的 loop/goal/workflow 专项设计与实施账本,不替换 Runtime `04`,也不改变 `GoalPhase`、Task DAG、BudgetGuard、Verification 或 Session v3 的 canonical truth。

权威顺序固定为:

1. `runtime/04-governed-agent-harness-runtime-plan.md`:Runtime 总体范围、Phase/Wave、产品 readiness 与最终串行集成顺序;
2. `runtime/06-specialty-implementation-freeze.md`:冻结路径、允许/禁止行为与解冻流程;
3. 本文件:workflow 子域合同、里程碑、文件边界与专项验收;
4. `02-implementation-checklist.md`:每个阶段的 RED/GREEN/REFACTOR 与证据记录。

发生冲突时以上游文档为准。若实施改变 `04` 的状态结论,必须在同一阶段显式同步 `04`/`05`,不能只修改本专项复选框。

本计划不会自动重开 `04` 已关闭的 Runtime-owned Wave。M0 RED 开始前必须先在 `04` 的严格执行顺序中登记一个新的 workflow lane/Wave,明确:

- 这是对已完成 Orchestrator/Agent/Control Plane seam 的 additive extension,还是需要重开某个 product gate;
- owner、worktree/base、exact allowlist、join locks 与 handoff顺序;
- M4-M7 何时可以重新打开 L2/L3/L4 shared surfaces;
- 哪些已完成结论保持不变,哪些 readiness 因新 scope重新变为pending。

未完成该 docs-only prerequisite 时,本专项只能停留在文档设计,不能创建 RED tests/fixtures或修改 production source。

按 `04` 当前“W0 -> ... -> W6”严格顺序,本专项建议登记为两个 post-W6 Wave:`W7 Workflow Core` 与 `W8 Workflow Product Join`。当前 `W6-G` 仍因 darwin/win32 证据缺失保持 pending,因此在 `04` 接受新登记前只能做文档规划。若用户要求在 W6-G 前开始实现,必须先显式修订 `04` 的调度规则并说明为何 additive W7/W8 不会污染 W6 候选证据,不能由本专项自行绕过。每个 Wave 仍只有一个 L4 `-J`,建议登记映射:

| Runtime lane | 本计划阶段 | 共享锁/边界 |
|---|---|---|
| `W7-P0` | M0 docs/public RED contract | docs与非schema public RED tests;登记 owner/base/allowlist/已关闭 gate 是否重开 |
| `W7-L0` | M1-L0 workflow event contract | L0 Protocol + schema/reference fixtures;独立 handoff,所有后续 lane rebase |
| `W7-R1` | M1-L1、M2、M3 | 新 workflow 子目录与 Runtime-owned session consumer;不打开 L2/L3/L4 |
| `W7-J` | M4、M5 | 本Wave唯一L2/L3/L4 join;Agent/controller、最小resource gate与single-agent production一起串行关闭 |
| `W7-G` | M5 single-agent gate | 资源门未绿时只允许off/shadow;不advertise multi-agent workflow |
| `W8-L0` | M6-L0 command/query contract | 新Wave首个L0 revision;独立 handoff |
| `W8-R1` | M6-R control/activity/transport core | 独占Control Plane/Activity路径;CLI/TUI/daemon production composition留给W8-J |
| `W8-R2` | M7 child/resource core | 独占Agent/workflow路径;production composition留给W8-J |
| `W8-J` | M6-R user/daemon wiring + M7 production join | 本Wave唯一L3/L4 join;统一接入CLI/TUI/daemon与multi-agent |
| `W8-G` | M8 fault/rollout/acceptance | full gate、rollback、Runtime 04/05与专项账本同步 |

W7/W8 默认 `L1 Dependency=closed/no-write`;不得修改 `package.json`/`package-lock.json`。若实现证明必须新增依赖,先在 `04` 另开独立 L1 task完成license、lockfile、build审阅,再恢复对应Wave。

### 0.2 冻结边界

`06-specialty-implementation-freeze.md:23-31` 冻结以下专项:

- Plan / Model / Context / Compaction / Memory;
- Plugin / MCP / Skill / Hooks;
- Worktree / Sandbox / Permission。

本计划只实施 Runtime-owned workflow orchestration。允许新增/修改的主要范围:

- `src/runtime/orchestrator/workflow/**`;
- additive `src/runtime/protocol/v3/**` workflow contract,仅在独立 L0 contract window;
- `src/runtime/session/**` 的 workflow event/replay consumer;
- `src/runtime/integration/**` 的 runtime-owned adapter/composition;
- `src/runtime/control-plane/**`、`src/runtime/activity/**`、`src/runtime/lifecycle/**`;
- `src/runtime/agents/**` 的既有 public receipt consumer;
- 串行窗口内的 `src/runtime/{agent-loop,agent,types,interactive-session-controller}.ts`;
- 串行窗口内的 `src/storage/production-interactive-runtime.ts`、`src/cli/**`、`src/tui/**`、`src/daemon/**`;
- 对应 `tests/runtime-v3/**`、`tests/e2e/**` 与文档。

禁止:

- 修改 `src/runtime/model-routing/**`、`modes/plan/**`、`context/**`;
- 修改 `src/extensions/**`、`src/security/**`、`src/worktree/**`;
- 复制 planner、ContextEngine、Memory、ExtensionManager、PermissionEngine、Gateway、Sandbox 或 Worktree manager;
- 为让 workflow E2E 通过而放宽 receipt/schema、回退 AllowAll/shared cwd/unsandboxed;
- 把 test fake 或 process-local seam advertise 成 production feature。

`agent-loop.ts`、`interactive-session-controller.ts`、integration roots、`production-interactive-runtime.ts`、CLI、TUI和daemon composition是 serialized join surfaces。M0-M3 不得提前打开这些文件;只有基础合同、projection、kernel、driver recovery 全部通过后,M4-M7 才按上述每Wave唯一join、单一owner与显式路径集合串行修改。

### 0.3 执行规则

- 每阶段先取得 RED tests,再实现最小 GREEN;没有 failing evidence 不开始行为实现。按根 `AGENTS.md`,RED 只保存预期失败证据,不能在默认 `npm test` 仍失败时形成独立 commit;只有所属 GREEN gate 完整回归通过且用户授权时才提交。
- 每个 `tick()`、wake claim、attempt、Task transition 和 Goal transition 都要有 idempotency/revision/generation 约束。
- 状态真源只来自 Session v3 Event Store 和既有 canonical repository;内存对象、TUI state、timer、PID、JSON snapshot 只可作 cache。
- 任何未知副作用、writer/generation drift、receipt 缺失或 replay divergence 都进入 `reconciling`/paused,不能自动继续。
- 每阶段只在获得用户 commit 授权后创建 commit;本规划任务本身不提交、不推送。
- 阶段状态只能在 `02` 中附命令、结果、commit 状态与剩余 gap 后勾选;未获提交授权时 commit 状态写 `not authorized`,不伪造 commit hash。

## 1. 目标与非目标

### 1.1 目标

建立一套最小、封闭、可恢复的 `coding-goal/v1` workflow runtime,使以下路径成立:

```text
用户创建/恢复 Goal
  -> durable immutable workflow definition
  -> approved Plan 导入 canonical Task DAG
  -> deterministic scheduler 选择 existing ready Task
  -> durable workflow attempt
  -> governed internal Agent continuation
  -> Task output/evidence/Verification
  -> durable wait/wake/retry/reconcile
  -> trusted EpisodeSeal
  -> existing DurableGoalStateMachine 完成 Goal
```

最终应提供:

- immutable/versioned workflow definition;
- orthogonal workflow execution projection;
- pure exhaustive `WorkflowDecisionKernel`;
- deterministic canonical Task scheduler;
- durable bounded `GoalWorkflowDriver.tick()`;
- workflow run 与 attempt 分离;
- durable wake/wait/cancellation/driver generation;
- typed internal Agent continuation 与 typed loop outcome;
- restart/replay/fencing/at-least-once delivery;
- Control Plane、CLI、TUI、Activity projection;
- multi-agent child completion 与 immutable resource snapshot consumer;
- default-off staged rollout 和可逆 rollback。

### 1.2 非目标

V1 明确不实现:

- 第二套 Goal、Task、Budget、retry、Verification 或 Event Store;
- 任意 YAML/JSON 可执行 workflow、用户自定义 transition DSL、动态代码节点;
- Plugin 提供的 workflow type 或 workflow executor;
- 新 planner、classifier、strategist、summarizer、ContextEngine 或 Memory;
- 从 transcript 猜测 objective、Plan、Task 或完成 evidence;
- cron 产品、通用定时自动化平台或无限 proactive agent;
- recurring schedule/cron occurrence/cursor projection;V1 时间等待只使用 one-shot `notBefore` wake;
- exactly-once wake/外部副作用承诺;
- 绕过 Gateway/Sandbox/Approval/Workspace receipt 的执行;
- verifier fail-open completion;
- UI 直接修改 runtime 私有状态;
- 默认无人值守恢复所有 active Goal;
- fork 自动继承/恢复 active workflow run、attempt、wake、budget或driver generation。

## 2. 强制不变量

### 2.1 canonical truth

1. `DurableGoalStateMachine` 是 Goal phase 唯一 writer。
2. `SessionTaskRepository` 是 Task definition/status/output 唯一 writer。
3. `BudgetGuard` 是预算 reservation/settlement/hard-stop 唯一 writer。
4. durable retry/controller 与 `LoopBreaker` 是 retry/stall protection 的既有真源。
5. Session v3 Event Store 是 workflow definition/run/attempt/wake/wait/projection 的唯一真源。
6. Verification/EpisodeSeal 是 Goal completion 的唯一受信证据。
7. workflow projection 可以引用以上状态,不能复制一份可独立漂移的生命周期。
8. workflow event payload 禁止携带 Goal phase、Task definition/status/output 副本;canonical effect 完成后只保存可校验的 receipt/event cursor 与 digest。

### 2.2 scheduling 与 continuation

1. `WorkflowDecisionKernel` 是纯函数,不得读文件、时钟、环境变量、模型或网络。
2. 所有时间输入显式传入 `observedAt`/`now`,相同输入必须产生相同 decision digest。
3. scheduler 只选择 existing canonical Task;不创建 Task、不改 approved Plan。
4. 每次 driver `tick()` 至多提交一个 effect boundary;不得递归调用自己。
5. `tick()` 只能 claim 一个 mandatory-flushed durable wake 后执行;任何请求 driver decision/effect 的 operator command、canonical terminal consumer、timer 与 recovery 都必须先 append deduplicated wake,不能直接调用driver effect。definition/query等非driver操作继续走各自canonical command/repository合同。
6. stop/interrupt、用户输入、busy、Plan/review/approval gate 只作为 admission/preemption 条件,绝不包装成 workflow wake。
7. scheduler fire 只 append one-shot wake,不能直接调用模型。
8. 自动 continuation 必须低于 stop/interrupt 和用户/client input。
9. claim internal wake 前后都要复检 user mailbox、active turn、Goal revision、runtime generation 与 writer authority。
10. internal continuation 不是 `UserAgentMessage`,不能进入用户 steer/follow-up queue。
11. 同一 session 同时只有一个 logical driver generation。

### 2.3 durability 与 failure

1. wake delivery 语义为 at-least-once + idempotent consumer。
2. wake、attempt、Task/Goal effect 都必须携带稳定 idempotency key。
3. driver generation 绑定现有 session writer lease/fence 和 runtime generation;不建立平行 owner lock。
4. process timer/PID 不能证明 ownership 或 due consumption。
5. one-shot wake enqueue 未 mandatory-flush 时不得宣称 retry/sleep/wait timeout 已登记;V1 不存在第二个 due/occurrence cursor。
6. admission deferral 与 delivery failure 分开计数;user pending、busy、Plan/review、paused 等正常延期不消耗 failure/dead-letter budget。
7. attempt 必须 claim-before-execute,并在所有 exit path finally-finalize。
8. effect 已开始而 terminal receipt 不确定时进入 `reconciling`;不得重试潜在非幂等副作用。
9. restart 默认 paused/reconciling;只有 policy 明确允许且 replay 证明 safe 才 auto-resume。
10. stale goal/run/attempt/generation callback 不得污染当前 projection。

### 2.4 completion、budget 与安全

1. model output、assistant stop、Task completed、planner/classifier claim 都不等于 Goal completed。
2. verifier unavailable/disabled/error 只能形成 waiting/paused/reconciling 或 typed external-gap outcome,永不产生 completion。
3. 只有 `GoalEvidence(kind="verification", outcome="pass", trusted EpisodeSeal)` 能驱动现有 Goal completion。
4. soft budget 允许当前已开始 turn settle,然后阻止后续 continuation;hard stop 继续由 BudgetGuard 决定。
5. root/child usage 只结算一次;workflow 不新增 token/cost counter。
6. 依赖 frozen Gateway/Sandbox/Workspace/Extension 不能满足 production gate 时保持 `unsupported/deny/not advertised`。

## 3. 目标架构

### 3.1 分层

```text
Control Plane / canonical terminal consumers / timer / recovery
                |
                v
 mandatory-flushed WorkflowWake inbox
                |
                v
      GoalWorkflowDriver.tick()
 replay -> user/stop/busy admission -> claim one wake
        -> pure decision -> durable intent
                |
       +--------+---------+
       |                  |
       v                  v
existing Goal/Task/   AgentContinuationPort
Budget/Verification       |
repositories              v
                    Agent internal run
                    runAgentLoopContinue
                           |
                           v
                    typed loop outcome
                           |
                           v
                 attempt finalize + next wake
```

### 3.2 模块职责

| 模块 | 职责 | 明确不拥有 |
|---|---|---|
| `definition.ts` | 校验封闭 `coding-goal/v1` definition、digest 与 version | Plan parser、任意 workflow DSL |
| `types.ts` | workflow/run/attempt/wake/wait/decision 类型 | Goal/Task 状态复制 |
| `events.ts` | event payload helpers、identity/digest guard | Event Store 实现 |
| `projection.ts` | 从 canonical events 重放 workflow state | 外部副作用 |
| `repository.ts` | expected-revision/idempotency append、definition/run/attempt/wake/wait mutation | 第二条存储或直接写 projection |
| `decision-kernel.ts` | 纯 decision | I/O、模型、计时器 |
| `task-scheduler.ts` | existing Task readiness 与稳定选择 | Task create/revise |
| `wake-inbox.ts` | enqueue/claim/defer/consume 的 event-backed port | user message queue |
| `driver-generation.ts` | writer/runtime generation binding 与 stale rejection | 第二套 lease |
| `driver.ts` | bounded tick、effect sequencing、finally-finalize | 无限 loop |
| `ports.ts` | Agent/lifecycle/verification/clock/admission 端口 | concrete Plan/Security 实现 |
| `outcomes.ts` | exhaustive driver/Agent outcome mapping | Goal completion authority |
| `index.ts` | public Runtime-owned workflow surface | private adapter handles |

## 4. 领域模型

### 4.1 封闭 workflow definition

V1 只接受:

```ts
export interface CodingGoalWorkflowDefinition {
  schemaVersion: 1;
  workflowKind: "coding-goal/v1";
  definitionId: WorkflowDefinitionId;
  goalId: GoalId;
  definitionRevision: number;
  objective: {
    artifact: ArtifactRef;
    objectiveDigest: string;
  };
  successCriteria: {
    artifact: ArtifactRef;
    criteriaDigest: string;
  };
  provenance: {
    inputSources: readonly InputSourceRef[];
    declassificationReceipts: readonly DeclassificationReceiptRef[];
    provenanceDigest: string;
  };
  policy: CodingGoalWorkflowPolicy;
  definitionDigest: string;
  createdAt: string;
}
```

`CodingGoalWorkflowPolicy` 只允许有界 declarative 参数:

- `autonomy: "manual" | "bounded"`;
- `restart: "pause" | "resume_if_safe"`,默认 `pause`;
- `maxConcurrentAttempts`,V1 production 默认固定 `1`;
- `maxWakeDeliveryAttempts`;
- `maxVerificationAttempts`;
- `maxContinuationTurns`;
- `maxAttemptWallTimeMs`;
- existing BudgetGuard limit set 的 digest/reference;
- existing `LoopBreakerPolicy` 的 digest/reference;
- allowed trigger origins 的封闭 allowlist。

definition 是 content-addressed immutable record:

- 任一字段变化生成新的 `definitionId/revision/digest`;
- 只有 Goal workflow paused 且无 active attempt 时允许 bind 新版本;
- 新版本启动新的 workflow run,旧 definition/run 保留为 replay evidence;
- 不允许在 running attempt 中热改 policy/criteria/objective;
- 不把 approved Plan 或 Task DAG 内联进 definition;它们继续由现有 Plan/Task 真源版本化。

definition 必须由显式用户/Control Plane operation 绑定到 session genesis 已有的 `goalId`:

- objective/success criteria 先进入现有 Artifact CAS,workflow event只保存 ref/digest;
- bind 前通过现有 Artifact access/reference port 校验scope、digest、media type与可读性;unavailable保持external gap;
- 创建 operation 必须携带 input provenance、expected Goal/workflow revision 与 idempotency key;
- 没有 definition 的 legacy/current session 保持 manual/unsupported;
- 不从 transcript、最后一条 user message、assistant summary 或 Task 名猜测 definition;
- bind 后由独立 `workflow:start` 创建 initial run;后续 `goal:resume` 只恢复既有 paused run,definition record本身不自动启动模型。

### 4.2 Goal phase 与 workflow disposition 正交

现有 `GoalPhase` 不变。新增:

```ts
export const WORKFLOW_DISPOSITIONS = [
  "ready",
  "running",
  "waiting",
  "paused",
  "sleeping",
  "reconciling",
] as const;
```

含义:

- `ready`:有确定的下一 decision,尚未 claim attempt;
- `running`:一个有界 attempt/effect 活跃;
- `waiting`:等待外部 durable event或人类决定;
- `paused`:需要显式 resume 或 policy change;
- `sleeping`:等待 `notBefore/deadline` 到期;
- `reconciling`:存在 unknown effect、stale generation、orphan attempt 或 receipt gap。

Goal terminal 不新增 workflow `completed/failed` 真源。Goal 进入 `completed/failed/stopped` 后,projection 只把 run 标记 closed 并禁止新 tick;terminal 原因仍引用 Goal state。

### 4.3 run 与 attempt

`WorkflowRun` 表示同一 immutable definition 的一次受治理执行区间:

- initial start 形成 run;
- pause 保留同一 open run并改变 disposition,resume 继续该 run;
- cancel、definition replacement或Goal terminal关闭run;
- run 不替代 Goal lifecycle。

`WorkflowAttempt` 表示一个 bounded effect:

- `mark_task_ready`;
- `start_task_turn`;
- `advance_lifecycle`;
- `request_verification`;
- `settle_child_completion`;
- `reconcile_unknown_effect`。

每个 attempt 至少绑定:

- `attemptId/runId/definitionId/goalId`;
- expected Goal revision、Task repository revision、workflow projection revision;
- runtime generation、driver generation、writer fence digest;
- source wake/dedup key;
- decision/input digest;
- Task/turn/child/verification correlation;
- immutable resource snapshot digest;
- canonical effect receipt cursor/digest;不复制 Goal/Task 业务状态;
- started/terminal cursor。

### 4.4 wake、wait 与 trigger

`WorkflowWake` 至少包含:

```text
wakeId
goalId / definitionId / runId
origin
sourceId / dedupKey
expectedGoalRevision
expectedWorkflowRevision
expectedRuntimeGeneration
expectedDriverGeneration (number | null)
notBefore?
admissionDeferralCount
deliveryFailureCount
recoveryOfWakeId / sourceDeadLetterCursor?
authorizationReceiptId / authorizationReceiptDigest?
payloadDigest / artifactRef?
createdAt
```

封闭 origin:

- `operator_start`;
- `operator_pause`;
- `operator_resume`;
- `operator_cancel`;
- `operator_dead_letter_recovery`;
- `session_idle`;
- `user_turn_settled`;
- `task_terminal`;
- `child_terminal`;
- `approval_resolved`;
- `human_decision`;
- `verification_terminal`;
- `retry_due`;
- `wait_timeout`;
- `reconciliation_terminal`。

`user_turn_settled` 指 canonical user turn terminal consumer,不是把用户输入包装成 wake。所有 origin producer 都先走 repository dedup + mandatory flush;没有 durable wake 就不能调用 `tick()` effect。
`reconciliation_terminal`只允许Runtime内部从verified canonical reconciliation terminal产生,禁止携带`recoveryOfWakeId`;它不是operator dead-letter恢复入口。

计数语义分离:

- `admissionDeferralCount`:记录 pending user、busy、Plan/review、paused、writer handoff 等正常延期,只用于诊断与 stall visibility,不消耗 delivery failure cap;
- `deliveryFailureCount`:只在 wake malformed/unprocessable、实际投递失败或可重试 adapter failure 时增长;只有该计数到 policy 上限才可 dead-letter;
- generation replacement 后,旧 generation 已 claim 且尚无 effect intent 的 wake 使用 `wake_reclaimed`,不伪造新的 enqueue。

dead-letter 永久 terminal,不存在 reopen/requeue-old-wake event。operator recovery只接受同一open run中仍为dead-letter、完整`EventCursor(stream/sequence/eventId/eventHash)` exact匹配且没有effect intent/unknown side effect的source。recovery identity固定为`canonicalDigest({ schemaVersion: 1, kind: "workflow_dead_letter_recovery", authorityId, tenantId, sessionId, sourceWakeId, sourceDeadLetterCursor })`;它唯一派生fresh `wakeId/dedupKey`。成功时mandatory-flush `origin=operator_dead_letter_recovery`、`sourceId=operator commandId`、`recoveryOfWakeId=sourceWakeId`、durable authorization receipt refs 的due-now wake;authorization receipt不进入recovery identity,但replay必须校验其scope/request/policy/digest。`expectedDriverGeneration`必须是exact number或`null`(CAS确认当前没有active driver),counts从零开始,不复制或覆盖旧payload/Artifact/Goal/Task/instruction,只要求kernel基于当前canonical projections重新求值,也不隐式resume或直接tick。同一source terminal identity最多一个recovery child;不同command再请求同一source固定返回typed `recovery_already_exists`并引用既有child、零新增事件。child再次dead-letter后只能以child为新source。

`WorkflowWait` 保存:

- reason kind;
- exact correlation identity;
- registered cursor/revision;
- satisfying event predicate 的结构化字段;
- optional deadline/notBefore;
- timeout policy;
- cancellation identity。

等待外部 event 用 `waiting`;只等待时间用 `sleeping`;需要明确人类/运维恢复用 `paused`;未知副作用用 `reconciling`。

V1 时间语义固定为 one-shot:

- `workflow.wake_enqueued.notBefore` 本身就是 canonical due record;
- daemon 只在时钟到期后请求一次 `tick()`,driver claim 已存在的 wake,不生成第二个 schedule occurrence;
- 注册带 deadline 的 wait 时,同时以 `wait-timeout:<waitId>` dedup key enqueue one-shot timeout wake;
- wait 被外部 event提前满足时,durable cancel对应timeout wake;
- recurring cron、missed-run cursor、timezone/calendar与通用 scheduler projection不属于V1。

## 5. Event 与 projection 设计

### 5.1 additive v3 event family

在独立 L0 contract window 添加下列事件。不得修改既有 Goal/Task/Turn payload 语义来偷渡 workflow 字段。

| 分类 | 事件 | durable barrier |
|---|---|---|
| definition | `workflow.definition_recorded`、`workflow.definition_bound` | mandatory |
| driver | `workflow.driver_activated`、`workflow.driver_replaced`、`workflow.driver_deactivated` | mandatory |
| run | `workflow.run_started`、`workflow.run_pause_requested`、`workflow.run_paused`、`workflow.run_resumed`、`workflow.run_cancel_requested`、`workflow.run_cancelled`、`workflow.run_closed` | mandatory |
| decision | `workflow.decision_recorded` | mandatory before effect |
| wake | `workflow.wake_enqueued`、`workflow.wake_claimed`、`workflow.wake_reclaimed`、`workflow.wake_deferred`、`workflow.wake_cancelled`、`workflow.wake_consumed`、`workflow.wake_dead_lettered` | mandatory |
| wait | `workflow.wait_registered`、`workflow.wait_satisfied`、`workflow.wait_cancelled` | mandatory |
| attempt | `workflow.attempt_claimed`、`workflow.attempt_turn_bound`、`workflow.attempt_finished`、`workflow.attempt_failed`、`workflow.attempt_cancel_requested`、`workflow.attempt_cancelled`、`workflow.attempt_reconciliation_required` | mandatory |

事件数量可以在 M0 schema review 中合并,但不能牺牲以下区别:

- claim 与 consume;
- normal claim、generation-fenced reclaim 与 explicit cancel;
- cancel requested 与 cancelled;
- effect failed-certain 与 reconciliation-required;
- wait registered 与 satisfied;
- driver replacement 与普通 activation;
- pause requested 与 paused terminal receipt;
- run terminal evidence 与 Goal terminal authority。

### 5.2 schema 约束

每个 payload:

- `additionalProperties: false`;
- exact typed IDs;
- digest 使用 64 个小写十六进制字符(SHA-256/256-bit);
- timestamp 使用 canonical ISO;
- array/string/Artifact 数量和大小有硬上限;
- 不内联 objective、prompt、model output、tool args/output、secret 或 private reasoning;
- 不携带 Goal phase、Task definition/status/output、Budget counter、Verification outcome 的第二份副本;
- 必须绑定 authority/tenant/session identity 通过 event envelope;
- mutation payload 携带 expected revision/generation;
- decision payload 保存 input digests 与 output discriminant,不保存完整敏感 context;
- canonical Goal/Task/Budget/Verification effect 只以相同 decision idempotency key 对应的 event/receipt cursor 与 digest回写 workflow result。

需要同步:

- `event-catalog.ts`;
- `event-payloads.ts`;
- `schemas.ts`;
- `event-references.ts`/`ids.ts` 的 additive IDs;
- `event-writer.ts` mandatory flush set;
- reference snapshot/fixtures/public contract tests。

### 5.3 projections

从完整 verified session stream 重建:

1. `WorkflowDefinitionProjection`;
2. `WorkflowRunProjection`;
3. `WorkflowAttemptProjection`;
4. `WorkflowWakeInboxProjection`;
5. `WorkflowWaitProjection`;
6. 汇总 `GoalWorkflowProjection`。

projection 必须拒绝:

- definition digest/revision drift;
- 同 generation 多 active driver;
- wake 未 enqueue 就 claim;
- consumed wake 再 claim;
- 没有 durable driver replacement 或已有 effect intent 时 reclaim claimed wake;
- claimed/deferred/cancelled/reclaimed/consumed/dead-letter transition 不合法;
- attempt 未 claim 就 bind turn;
- stale generation terminal;
- terminal attempt 再 terminal;
- run 当前 paused 且尚无 durable `workflow.run_resumed`、或已 cancelled 后新 attempt;
- Goal terminal 后新 wake/attempt;
- expected Goal/Task/workflow revision mismatch;
- impossible wait transition;
- replay 次序与 online reducer divergence。

snapshot/cache 可以保存 projection digest 与 event cursor,但删除后必须能从 Event Store 完整重建。

## 6. Pure decision kernel 与 Task scheduler

### 6.1 kernel 输入

`WorkflowDecisionKernelInput` 只包含 immutable snapshot:

- workflow definition/run/wake/wait projection;
- existing `GoalState`;
- existing `TaskRepositoryProjection`;
- approved Plan ref + Task DAG digest;
- BudgetGuard snapshot;
- durable retry state + LoopBreaker state/ref;
- Verification/Finding/EpisodeSeal refs;
- active turn/approval/child/resource/runtime readiness;
- current runtime/driver generation;
- explicit `now`。

所有引用在进入 kernel 前完成 scope/digest/revision validation。unavailable 不转换为空值,而是结构化 readiness failure。

### 6.2 exhaustive decision

V1 decision union:

```text
no_op
mark_task_ready
start_task_attempt
advance_goal_lifecycle
request_verification
register_wait
schedule_wake
pause_workflow
reconcile_effect
close_run_from_goal_terminal
```

每个 decision 都包含:

- discriminant;
- reason code;
- exact input digest set;
- required expected revisions;
- effect port name;
- idempotency/dedup material;
- optional Task/turn/verification correlation。

未穷举 decision 必须在 TypeScript `never` check 和 fixture tests 中失败。

### 6.3 deterministic Task scheduler

算法固定:

1. Task projection 的 `goalId` 必须与 Goal 一致;
2. 使用 approved DAG 已验证的 stable topological order;
3. 对 `pending` Task,依赖全部 `completed` 时产生一个 `mark_task_ready` decision;
4. `ready` Task 按 topological position、再按 `taskId` lexical order 排序;
5. 选择第一个 owner/capability/workspace/resource/budget 均 ready 的 Task;
6. V1 root workflow 同时最多一个 active attempt;多 Agent child 并发只由既有 Agent/Supervisor admission 决定;
7. `running` Task 必须有 exact active attempt/turn/child correlation,否则 `reconciling`;
8. dependency failed/cancelled 或 Task blocked 不自动改 Plan,只形成 wait/pause/remediation lifecycle decision;
9. Task completed 仍必须由 repository 检查 expected outputs 已绑定;
10. scheduler 不根据模型文本、mtime、Map insertion order 或 process timing 破坏确定性。

### 6.4 progress、stall 与 verification

- progress fingerprint 只由 Task status/output、Artifact、Finding、Verification receipt、diff/check/test evidence digest 组成;
- 相同 delivery 使用稳定 observation ID,不重复推进 existing LoopBreaker或verification attempt projection;
- stall/no-progress 只读取 durable `LoopBreakerState` 与其 policy;workflow 不保存第二份 `stallStreak`;
- existing `LoopBreakerPolicy.maxNoProgress` 到达并trip时 pause,不能 complete;
- verification attempt 到达上限时 pause `verification_exhausted`;
- verifier unavailable/error -> `waiting_external` 或 `reconciling`;
- only trusted EpisodeSeal -> existing Goal completion transition;
- LoopBreaker observation 继续写 existing durable control journal,workflow 只引用其 result/receipt。

## 7. Durable `GoalWorkflowDriver.tick()`

### 7.1 有界控制流

每次 tick 固定执行:

```text
1. verify writer authority + runtime/driver generation
2. replay verified Goal/Task/Budget/Verification/workflow projections
3. reject terminal Goal or stale definition/run
4. inspect stop/user/busy/Plan/review/approval admission and preemption state
5. claim one eligible wake, or record no-op
6. recheck user mailbox/busy/Plan/review/approval/generation
7. evaluate pure kernel
8. append decision + attempt/effect intent, mandatory flush
9. recheck user mailbox/busy/generation after intent and before effect
10. execute exactly one existing repository/port effect
11. replay the canonical effect event/receipt by the same decision idempotency key
12. append only its cursor/digest plus exact workflow result, wait, deferral or reconciliation
13. consume/defer the wake only after step 8-12 is durable
14. finally finalize attempt and release process-local resources
15. return typed tick outcome; never call tick recursively
```

若 step 8 前失败,wake 保持 pending/claim 可恢复。step 9 发现高优先级用户输入时写 durable deferral并终结未执行attempt,但不增加 delivery failure。若 effect 未开始且 append 失败,可安全 retry。`intent -> canonical event` 与 `canonical event -> workflow receipt reference` 两个 crash window必须分别恢复:前者按 effect certainty决定 retry/reconcile,后者从 canonical repository/event replay并补记 cursor/digest,绝不重写 Goal/Task effect。若 effect 已开始而 terminal receipt未确认,写 `attempt_reconciliation_required` 或由 restart reducer推导 reconciling。

### 7.2 wake origin 与 admission/preemption priority

workflow effect 的唯一触发物是 durable wake。effectful producer 从高到低 append/claim:

1. operator `workflow:cancel`、`workflow:pause`、`goal:pause`;
2. active turn/attempt reconciliation receipt;
3. child/verification/task/approval/human canonical terminal consumer;
4. operator start/resume;
5. retry due 与 wait-timeout one-shot wake;
6. user turn settled/session idle internal continuation。

以下不是 wake,而是每次 claim 前、intent 后、effect 前都检查的 admission/preemption gate:

1. session shutdown/stop/turn interrupt;
2. explicit user prompt/steer/follow-up;
3. active turn/busy;
4. Plan/review/approval gate;
5. writer/runtime generation replacement。

规则:

- 高优先级 gate 到达后,低优先级 claimed wake 必须 durable defer/release;
- 不取消已经开始的外部副作用来“抢占”;先进入 governed interrupt/reconciliation;
- 用户输入不能被包装成 workflow wake;
- internal wake 不能占用 user queue FIFO;
- pending user/busy/Plan/review/paused 导致的 deferral 不消耗 delivery failure cap,不能把正常 idle 等待 dead-letter;
- 一个 tick 只 claim/consume 一个 wake。

### 7.3 driver generation 与 writer authority

不新建独立 lockfile。`WorkflowDriverGeneration` 必须绑定:

- session writer lease ID/epoch/fencing token digest;
- runtime instance ID + runtime generation;
- session/goal/definition identity;
- activated event cursor。

规则:

- manager 未持有 active writer authority 时不能 activate driver;
- runtime replacement 先 durable replace generation,旧 generation 的 claim/result 全拒绝;
- 新 generation 只有在 replay证明旧 claimed wake尚未产生effect intent时才能写 `workflow.wake_reclaimed`;已有intent则先reconcile attempt;
- driver heartbeat 只是 health signal,不是 ownership 真源;
- takeover 后旧 process callback 即使到达也只能形成 stale diagnostic;
- daemon/interactive runtime 不能同时拥有不同 driver。

### 7.4 wait、sleep、resume 与 recovery

- wait satisfaction 来自 canonical event correlation,不来自 polling callback;
- time-based due 由 daemon扫描已存在的one-shot `notBefore` wake并请求tick;扫描本身不写第二个wake或schedule cursor;
- retry/wait timeout在进入sleeping前先durable enqueue one-shot wake;enqueue失败就不能宣称sleep已登记;
- restart replay active attempt:
  - effect 明确未开始 -> 重建为 pending work;`restart="pause"` 时 run 仍不可投递,必须先 durable `workflow.run_resumed`;
  - effect 明确未开始且 `resume_if_safe` 全部门禁通过 -> 写 `run_resumed` 后才允许重新交付;
  - effect terminal receipt 已存在 -> finalize projection;
  - effect 可能开始但无 terminal receipt -> reconciling;
- `restart="pause"` 形成 durable paused state;
- `resume_if_safe` 只有无 active/unknown effect、budget/receipt/resource 都 ready 时才能写 resume+wake;
- old session 无 workflow definition 时保持 manual/unsupported,不从 transcript 自动推断。
- V1 fork 只沿用现有 conversation/session fork语义,不复制 definition binding、open run、attempt、wake、wait、driver generation或workflow budget correlation;fork target保持 manual/unsupported且不auto-start。

### 7.5 cancellation

`workflow:pause` 只暂停 workflow disposition,不迁移 Goal phase。`goal:pause` 是跨 canonical Goal 与 workflow 的可恢复 saga,不是原子内存操作:

```text
canonical command claim
  -> workflow.run_pause_requested
  -> existing Goal state-machine transition with decision-derived idempotency
  -> request active turn/attempt interrupt and cancel future wakes
  -> collect canonical Goal/turn/wake receipt cursors
  -> workflow.run_paused
  -> canonical command result
```

每个箭头都是故障注入点。restart 必须从 command claim、pause intent和canonical receipt重放后继续或进入reconciling;workflow event只保存receipt ID/cursor/digest,不复制 Goal phase。Goal已处于无需迁移的合法 phase时,`workflow:pause`/policy pause可以只暂停open run。

cancel 治理顺序:

```text
workflow.run_cancel_requested
  -> cancel pending/sleeping wakes
  -> request active Agent/child/verification cancellation
  -> await or reconcile terminal receipt
  -> task/attempt terminal update
  -> workflow.run_cancelled
```

TUI/CLI 只发 versioned command,不能先本地改 UI 再补 runtime。

## 8. Typed Agent continuation 与 loop outcome

### 8.1 内部 continuation envelope

新增 internal-only 类型:

```ts
export interface WorkflowContinuationEnvelope {
  origin: "goal_workflow";
  goalId: GoalId;
  definitionId: WorkflowDefinitionId;
  runId: WorkflowRunId;
  attemptId: WorkflowAttemptId;
  taskId?: string;
  expectedGoalRevision: number;
  expectedTaskRevision: number;
  runtimeGeneration: number;
  driverGeneration: number;
  resourceSnapshotDigest: string;
  instructionArtifact: ArtifactRef;
  continuationDigest: string;
}
```

它不属于 `AgentMessage`,也不能经过 `normalizePrompts()`。生产入口建议为 internal `AgentContinuationPort`/controller method:

```text
continueWorkflow(envelope, durableAttemptReceipt) -> AgentRunOutcome
```

底层可以复用 `runAgentLoopContinue(context, ...)`,但 instruction 通过 Runtime-owned `WorkflowContinuationContextProvider` 作为有 provenance 的 turn-context fragment进入现有 governed model preparation。该 provider 只消费冻结 Context public contract,不修改 ContextEngine/Plan/Memory 行为。

replay/resume 必须保持以下 provenance 不变量:

- `origin="goal_workflow"` 始终保留为 internal union discriminant,不能重建为 `AgentMessage`/`UserAgentMessage`;
- 永不产生 user `queue.enqueued`,也不改变 prompt/steer/follow-up 的 FIFO、actor identity或receipt归属;
- instruction Artifact先做scope/digest/media type读取校验,内容按结构化 context fragment转义,不能用字符串拼接突破system/user边界;
- resume只从durable attempt/turn binding恢复 correlation,不能从assistant transcript猜测 internal source。

### 8.2 typed loop outcome

保留现有 `runAgentLoop()`/`Agent.prompt()` 兼容返回值。新增 workflow internal 路径返回:

```text
settled
interrupted
waiting_permission
budget_limited
external_gap
provider_failed
tool_failed_certain
effect_uncertain
reconciliation_required
```

outcome 至少包含:

- turn ID/cursor;
- stop/error reason code;
- Task/attempt correlation;
- provider/tool/approval/budget receipt refs;
- partial Artifact refs;
- outcome certainty;
- usage settlement ref。

assistant text 不参与 outcome discriminant。每个 outcome 到 Task/wait/retry/reconcile 的映射必须 exhaustive test。

### 8.3 turn binding

为避免修改既有 `turn.started` exact payload语义:

- workflow attempt 先 claim;
- Agent begin-turn 产生 canonical `turn.started`;
- `workflow.attempt_turn_bound` 立即 mandatory-flush绑定 attempt/turn/queue-less internal origin;
- crash window由 active turn + unbound claimed attempt replay进入 reconciliation;
- 不把 workflow origin 塞进 user `queue.enqueued`。

若后续选择预分配 turn ID,也必须在 M4 contract test 中证明 queue/user路径兼容,不得静默改变既有 Turn event。

### 8.4 immutable resources

attempt 开始时绑定:

- tool snapshot digest;
- extension/resource snapshot digest;
- model route/profile digest;
- workspace/capability receipt revisions。

M4/M5 必须先闭合最小 resource admission slice:

1. 在 attempt intent mandatory flush 前,通过 frozen public ports取得并校验 tool/resource/model/workspace/capability/security snapshot scope、generation、receipt与digest;
2. attempt intent绑定该 immutable snapshot;
3. 启动 Agent/effect前再次检查 revocation/unavailable与runtime generation;
4. stale/revoked/unavailable只能 wait、deny或external gap,不能启动Agent、回退旧安全receipt或假造ready。

reload 只在 idle/turn boundary publish。running attempt 保持旧 snapshot;新 attempt 使用新版本。M7只补 child correlation、last-known-good reload与高级re-evaluation,不能把最小准入门留到 effectful M5之后。

## 9. Production lifecycle 与 composition

### 9.1 runtime ports

新增最小 ports:

- `WorkflowAgentContinuationPort`;
- `WorkflowLifecyclePort`,只包装 existing `PromptGoalCoordinator`;
- `WorkflowVerificationPort`;
- `WorkflowAdmissionPort`;
- `WorkflowRuntimeGenerationPort`;
- `WorkflowResourceSnapshotPort`;
- `WorkflowChildReceiptPort`;
- `WorkflowWakeSchedulerPort`;
- `WorkflowClock`。

ports 返回 typed result/receipt,throw 统一转换为 external gap 或 uncertain。不能用空 adapter返回成功。

### 9.2 `production-session-runtime`

M5 后 composition 应:

1. 从同一 manager/EventWriter 构造 workflow repository/projection/driver;
2. 强制 LoopBreaker 从 durable control journal replay;
3. 使用 existing Goal、Task、Budget、Verification instances;
4. feature `off` 时不 activate driver、不产生 workflow effects;
5. feature `shadow` 时只计算/记录 shadow decision,不改 Goal/Task、不启动 Agent;
6. feature effectful 且必需 port缺失时返回 `external_gap`,不回退 mock;
7. close/unload/replacement 前 durable pause/deactivate driver;
8. resume 先 replay session/queue/workflow projection,再允许 wake delivery。

M5 只有在 M4 最小 resource admission/revocation gate GREEN 后才允许 single-agent `opt_in` 从 approved Plan 启动 first Task attempt。这里的证据限定为 launch entry以下、注入已解析配置的 direct production composition/E2E;真实 `src/cli/main.ts` 与 `src/daemon/stdio-cli.ts` 配置加载、user/project precedence及产品入口 capability advertisement 留给唯一 `W8-J`。否则 M5 的生产接线只允许 `off/shadow`;effectful `opt_in` 延后,不得用 M7 future tests为当前 readiness背书。multi-agent workflow在 `W8` 唯一 `W8-J` 完成前一律不advertise。

当前 optional lifecycle port默认 unsupported 的行为在 `off/shadow` 保留;只有 opt-in/default/required session 才把真实 lifecycle ports变为 admission 前件。

### 9.3 interactive/daemon

- interactive runtime 与 daemon 必须共享同一 driver owner规则;
- `onIdle` 只请求一次 tick,不 while-loop;
- busy Agent 不启动 internal continuation;
- daemon 不依赖 TUI 存活;
- unload 前无 active attempt/unknown effect;否则 fail closed;
- replacement generation 使旧 driver全部 fenced;
- 外部scheduler若要触发V1 workflow,只能通过public port append一个one-shot wake,不能直接启动模型;通用recurring cursor仍在本计划外。

## 10. Control Plane、Activity、CLI 与 TUI

### 10.1 Control Plane

M6 先执行新Wave首个 `W8-L0/M6-L0` protocol revision,再进入行为接线:

- additive 扩展 `src/runtime/protocol/v3/coordination.ts` 的 canonical command union与相关 exact schema;
- 升级 Control Plane schema/minor negotiation,旧schema client保持可协商且不能发送新命令;
- 同步 command journal/event payload/reference fixtures,不放宽既有command discriminant;
- protocol handoff后,interactive client、light client、JSONL/SSE transport、daemon server/composition全部rebase同一revision。

新增 versioned commands:

- `workflow:define`;
- `workflow:start`;
- `workflow:pause`;
- `goal:pause`;
- `goal:resume`;
- `workflow:cancel`;
- operator-only `workflow:recoverDeadLetterWake`;
- 可选 operator-only `workflow:retryReconciliation`。

新增 queries:

- `goal:inspect`;
- `workflow:inspect`;
- `workflow:wakes`;

每个 command 绑定 session handle、expected session revision、expected Goal/workflow revision、runtime generation、idempotency key。`workflow:define`只接受已持久化并完成 provenance/taint 校验的 objective/criteria Artifact refs;`workflow:start`只启动已绑定 definition。没有 `goal:complete` 用户命令;完成仍只能来自 EpisodeSeal。

`workflow:recoverDeadLetterWake` 是唯一 dead-letter 恢复入口。payload 额外绑定同一 open run 的 `sourceWakeId`、完整`sourceDeadLetterCursor`、`expectedDriverGeneration: number | null`与bounded reason digest;result只返回source/fresh wake identity、fresh wake cursor/dedup key与authorization receipt refs。它绝不 reopen、reclaim或修改旧 wake,语义遵守§4的fresh-wake identity。

该命令的production owner固定为`src/runtime/control-plane/workflow-control.ts`,从authenticated request context取得canonical principal并调用现有`EnterpriseAuthorizationPort`。`AuthorizationRequest`固定`action=approve`、`resourceKind=workflow_dead_letter_recovery`、`risk=high`、`requestId=commandId`;`resourceDigest`绑定source terminal cursor、expected session/Goal/workflow/runtime/driver revisions/generations与reason digest,principal不能来自payload。只有scope/request/policy exact匹配的durable allow receipt可继续;其receipt ID/digest必须先写入canonical command journal并flush,再进入fresh wake refs。若现有public action/resource contract不足,必须停止并另开Security L0解冻审阅,不能在本Wave修改`src/security/**`或私造authority。authorizer缺失或`deny/ask/unavailable`、receipt drift、source有effect intent/unknown side effect均fail closed且零wake;production daemon不得advertise未真实绑定production authorizer的该命令。

相同 command idempotency key + request digest跨restart返回同一新 wake/result;复用key但payload变化返回`idempotency_conflict`,不同command针对同一source固定返回`recovery_already_exists`且零新增事件。fresh wake flush后、command result前crash时从确定性identity补写同一result,不再次enqueue。`workflow:retryReconciliation`只重评 unknown-effect reconciliation evidence,不得承担或旁路该合同。

`workflow:pause` 只治理open run。`goal:pause` 是 §7.5 的 durable saga:先记录 pause intent,再通过现有 `DurableGoalStateMachine` 的合法 transition治理 Goal gate,随后治理 active turn/attempt与future wakes;它不能直接写 `GoalState.phase`。`goal:resume` 在 Goal 位于 `awaiting_human` 时走现有合法返回 transition,在 restart/policy 只暂停 workflow而Goal phase未变化时只恢复open run。任一步不确定都停在 paused/reconciling,不部分伪造成功。

新命令不能只在 local facade成立。M6-R 必须贯通 canonical command bus/projection、interactive/light clients、JSONL/SSE transport、daemon adapter/composition/server/stdio host,并用 real-process restart/idempotency/stale-revision E2E证明 wire 行为。

### 10.2 Activity v3

保留 v2 只读兼容,新增 `RuntimeActivityProjectionV3` 或等价 versioned shape:

- `workflowDisposition`;
- current run/attempt/task IDs;
- waiting/pause/reconciliation reason code;
- next wake time;
- driver/runtime generation;
- pending wake count。

Activity 仍是 metadata-only:

- 不含 objective/prompt/tool args/output;
- nonterminal Goal 不再一律显示 active;
- paused/waiting/sleeping/reconciling 与 waiting_permission 分开;
- projection 只从 verified Event Store replay。

### 10.3 CLI/TUI

CLI/TUI 最小用户面:

- inspect Goal phase + workflow disposition;
- 通过显式 objective/criteria Artifact refs define/start workflow;
- inspect current Task/attempt/wait/wake/budget/verification;
- pause/resume/cancel;
- 显示 external gap、stale generation、dead-letter wake 与 reconciliation;
- 显示 feature mode和 readiness;
- 不提供强制 completed;
- 不直接调用 Agent private method。

建议命令形态在 M6 contract review 冻结,例如:

```text
runledger goal inspect
runledger workflow define
runledger workflow start
runledger workflow pause
runledger goal pause
runledger goal resume
runledger workflow inspect
runledger workflow cancel
runledger workflow recover-dead-letter --wake-id <id> --reason-digest <sha256>
```

`recover-dead-letter` 只在operator surface显示,CLI以`workflow:wakes`查询完整cursor/revisions/generations后组装Control Plane request,不接受operator手工注入这些CAS字段。普通interactive user/TUI只能inspect其证据。若现有 CLI 架构不支持 subcommand,先通过 Control Plane operator API提供,不要为本专项重写 CLI parser。

## 11. Multi-Agent 与 resource integration

### 11.1 child completion

child Task 只能通过 existing Agent/Supervisor public receipt推进:

```text
child terminal
  -> activation/completion/cleanup receipt validation
  -> Artifact handoff
  -> root BudgetGuard settlement
  -> Task transition/output binding
  -> durable parent wake
```

要求:

- parent goal/task/run/attempt exact correlation;
- repeated child receipt只消费一次;
- unknown child terminal/cleanup进入 reconciliation;
- child usage in-flight/finished/high-water防双计;
- process callback不能单独推进 parent;
- security/workspace/sandbox真实 receipt不足时 feature不advertise。

### 11.2 resource snapshot

workflow 只消费 frozen Extension/Context/Workspace/Security public ports:

- definition 不嵌入可执行 resource;
- attempt 绑定 immutable snapshot digest;
- resource change只触发下一 idle-boundary wake/re-evaluation;
- revoked/stale resource使下一 attempt wait/deny;
- running attempt的安全撤销继续由既有 Gateway/interrupt authority处理;
- 不修改 `src/extensions/**` 或创建第二套 resource manager。

## 12. 里程碑

### M0:合同与 RED 基线

目标:

- 先在 Runtime `04/05` docs-only登记 proposed W7/W8、owner/base/allowlist/join locks、`L1=closed/no-write` 与gate reopen结论;
- 固定 ownership/freeze/feature matrix;
- 从现有 public barrel/catalog/schema validator只写下一阶段 M1-L0 可关闭的 protocol/export/event-family runtime assertion RED,禁止 static import尚不存在的模块;projection/kernel/scheduler/driver RED留在各所属阶段;
- 冻结 IDs、event family、decision/outcome discriminants;
- 记录当前 baseline 与 reference snapshots。

退出门:

- RED tests 因缺实现失败,不是 fixture/依赖/类型错误;
- frozen paths 零 diff;
- `npm run check` 的既有失败与新增预期失败分离记录。
- M0 RED只保存证据且不独立commit;进入M1-L0 handoff前由所属详细测试接管,完整默认suite必须恢复全绿。

### M1-L0:additive workflow protocol contract

目标:

- additive v3 workflow events/schema/mandatory flush;
- IDs/catalog/payload/schema/reference fixtures exact一致;
- 所有既有 protocol consumer 与三组冻结门禁在同一handoff上通过。

退出门:

- L0 schema/version/fixture/mandatory flush tests全绿;
- 既有专项消费字段语义零漂移;
- L0形成独立handoff;如获commit授权,不能与L1行为实现同commit。

### M1-L1:definition、repository 与 projections

目标:

- 实现 `coding-goal/v1` immutable definition;
- replayable definition/run/attempt/wake/wait projection;
- corruption/stale/impossible transition fail closed。

退出门:

- online/replay projection等价;
- snapshot删除后完整重建;
- reference schema tests全绿;
- no Goal/Task duplicate state。

### M2:pure kernel 与 deterministic Task scheduler

目标:

- exhaustive `WorkflowDecisionKernel`;
- stable ready Task selection;
- Goal/Task/Budget/Verification/LoopBreaker snapshot输入;
- progress/stall/verification attempt guard。

退出门:

- property/table tests证明determinism;
- Map/input order变化不改变decision;
- model text/verifier error不能完成Goal;
- scheduler不创建或修改Task definition。

### M3:durable driver、generation、wait/wake 与 recovery

目标:

- bounded `tick()`;
- driver generation绑定writer authority;
- wake claim/defer/consume/dead-letter;
- admission deferral与delivery failure分账、driver replacement reclaim、timeout wake cancel;
- dead-letter终态不可重开,operator recovery只能创建带lineage的fresh one-shot wake;
- wait/sleep/cancel/restart/reconcile;
- at-least-once idempotent delivery。

退出门:

- kill/restart和duplicate delivery tests全绿;
- stale owner result被fence;
- enqueue失败不宣称one-shot due已登记;
- default-pause在durable run_resumed前不交付pending work;
- effect unknown不重复执行。

### M4:Agent/controller continuation seam 与 loop outcome

目标:

- internal `WorkflowContinuationEnvelope`;
- typed `AgentRunOutcome`;
- `runAgentLoopContinue` governed入口;
- attempt-turn binding;
- user priority双检;
- internal provenance replay;
- 最小 immutable resource snapshot acquisition/admission/revocation。

退出门:

- internal continuation不产生user queue/message;
- stale/revoked/unavailable resource在effect前fail closed;
- existing `Agent.prompt/steer/followUp` compatibility tests全绿;
- interrupt/pause无ghost continuation;
- shared join文件只在本阶段单owner修改。

### M5:production lifecycle ports 与 composition

目标:

- real `PromptGoalCoordinator` lifecycle port;
- launch entry以下的 production session/interactive/daemon composition与driver wiring;
- durable LoopBreaker restore;
- unload/resume/replacement lifecycle;
- external gaps fail closed。

退出门:

- 生产源码存在真实 lifecycle run/resume caller;
- missing port不回退mock;
- off模式零effect;
- resource gate未绿时只允许off/shadow;
- resource gate全绿时注入已解析配置的direct composition从approved Plan到first Task attempt闭环;
- 不把真实CLI/stdio-daemon user/project precedence或产品入口advertisement算作M5证据,这些只在W8-J关闭。

### M6-L0:Control Plane protocol revision

目标:

- versioned workflow/goal command/query union,包含operator-only `workflow:recoverDeadLetterWake`;
- coordination/canonical command journal/schema negotiation/reference fixtures;
- 旧client兼容与新command拒绝矩阵。

退出门:

- 独立L0 handoff通过;
- schema/catalog/transport contract tests全绿;
- 如获commit授权,不能与M6-R行为接线同commit。

### M6-R:Control Plane、CLI、TUI、daemon 与 Activity

目标:

- goal/workflow commands/queries,含dead-letter fresh-wake operator recovery;
- Activity v3;
- inspect/pause/resume/cancel user surface;
- interactive/light client、JSONL/SSE与daemon route;
- diagnostics/metrics。

`W8-R1`只关闭Control Plane/Activity/transport core checkpoint;CLI/TUI/daemon production wiring留到W8-R2完成后的唯一`W8-J`,因此M6-R不能在R1提前标记完成。

退出门:

- commands跨restart幂等;
- dead-letter recovery不重开旧wake、不重复enqueue且普通用户无authority;
- CLI/TUI只走Control Plane;
- real-process daemon transport/restart/stale revision E2E通过;
- metadata projection无敏感内容;
- no force-complete path。

### M7:multi-agent 与 advanced resource snapshot hardening

目标:

- child terminal -> Artifact/budget/Task/parent wake;
- duplicate child result suppression;
- child resource correlation、idle-boundary reload与last-known-good hardening;
- root/child budget一致性。

`W8-R2`只关闭Agent/workflow core checkpoint;M6-R与M7共享的production composition、CLI/TUI/daemon及E2E由唯一`W8-J`一次完成。

退出门:

- repeated/out-of-order child receipt只结算一次;
- stale generation/receipt被拒;
- frozen Extension/Security/Worktree路径零diff;
- external dependency不ready时不advertise;
- `W8`唯一`W8-J`完成前multi-agent workflow不advertise。

### M8:fault injection、live E2E 与 staged rollout

目标:

- crash/replay/fencing/delivery/cancellation全矩阵;
- deterministic mock E2E;
- opt-in live provider E2E;
- off -> shadow -> opt_in -> default -> required rollout;
- rollback演练与production readiness evidence。

退出门:

- full `npm run check`、`npm test`、`npm run build`;
- harness regression、boundary scripts、冻结专项门禁;
- CLI real command/TUI smoke;
- kill/restart E2E;
- live test不输出credential;
- readiness和rollback记录完整。

## 13. 验证策略

### 13.1 测试层级

1. contract/schema/reference fixture;
2. pure reducer/kernel/table/property tests;
3. repository/driver in-memory Event Store tests;
4. JSONL kill/restart/fault injection;
5. Agent/controller integration;
6. production composition/control plane/activity;
7. deterministic E2E;
8. opt-in live provider E2E;
9. full repository regression。

### 13.2 必测故障

- wake duplicate/out-of-order/partial append;
- operator/canonical/timer producer未先durable enqueue wake;
- admission deferral与delivery failure计数混淆;
- claim后进程退出;
- driver replacement后的safe reclaim与已有intent拒绝reclaim;
- effect前/中/后writer failure;
- intent到canonical effect event、canonical event到workflow receipt reference两个crash window;
- old generation delayed callback;
- user input与internal wake竞态;
- workflow pause、Goal pause saga、interrupt/cancel每个receipt边界竞态;
- provider/tool/approval/budget failure;
- verifier disabled/unavailable/error;
- Task/Goal revision conflict;
- child terminal重复/缺receipt/usage drift;
- resource snapshot stale/revoked;
- Event Store corrupted tail;
- runtime replacement/unload/reload;
- sleep due enqueue失败;
- wait提前满足后的timeout wake取消;
- recurring cron/schedule projection被拒;
- dead-letter fresh-wake operator recovery与reconciliation retry严格分离。

### 13.3 每阶段基本命令

按风险逐步执行:

```bash
npx vitest run <stage-targets> --no-file-parallelism
npm run check
npm test
npm run build
npm run test:harness-regression
node scripts/check-runtime-boundaries.ts
node scripts/check-execution-boundaries.ts
git diff --check
```

定向测试、consumer gate与冻结专项门禁都不能替代完整 `npm test`。任一 GREEN/可提交 checkpoint 必须显式通过 `npm run check`、完整 `npm test`、`npm run build`、`npm run test:harness-regression`、两个 boundary scripts 与 `git diff --check`,并保存完整输出和 file/test count。RED checkpoint只保存预期失败证据,不得在默认suite仍失败时独立commit。

具体阶段路径与证据模板见 `02-implementation-checklist.md`。

## 14. Feature rollout 与 rollback

### 14.1 feature modes

```text
off -> shadow -> opt_in -> default -> required
```

| mode | 行为 |
|---|---|
| `off` | 不activate driver,不产生workflow effect;旧手动路径保持 |
| `shadow` | replay并计算decision/diagnostic,不改Goal/Task、不启动Agent |
| `opt_in` | 只有显式session/project opt-in启用effect |
| `default` | 新session默认启用,可显式关闭;legacy session不自动迁移 |
| `required` | production coding-goal必须有valid definition/ports/readiness,否则拒绝启动 |

canonical persistence 与优先级固定为:

- `src/runtime/runtime-features.ts` 唯一拥有 `GoalWorkflowFeatureState`、rank、dependency validation与resolver,不在workflow projection再造配置真源;
- `src/storage/settings-manager.ts` 持久化 `goalWorkflowFeatureState` 与 `goalWorkflowHighestActivatedState`;缺字段的旧配置迁移为 `off`,unknown value fail closed并给diagnostic;
- user settings提供默认,project settings逐字段覆盖user;不存在环境变量或一次性CLI参数静默抬高权限;
- `opt_in` 仍要求显式 `workflow:start`;session command只能在配置允许的上限内选择,不能高于project policy/readiness;
- `workflow.run_started`/driver activation只记录 resolved mode、config digest与source refs,不复制settings;每个tick重新验证当前配置只允许降权;
- 配置下调立即阻止新effect并走pause/deactivate;配置上调必须显式start/resume,不能因restart自动放大权限;
- `highestActivatedState`只用于迁移/审计/防旧进程倒退,不强制重新启用已rollback的mode;
- restart发现 recorded config digest 与当前resolver结果漂移时默认paused,经显式resume与readiness重验后才能继续。

M5只冻结并测试显式 user/project/session layers 的纯resolver、storage和injected-composition合同。唯一 `W8-J` 必须让 `src/cli/main.ts` 与 `src/daemon/stdio-cli.ts` 都消费同一 layered resolver,同时保留原始project layer供history writeback;禁止把merged user defaults整盘写回project settings。定向/real-process测试至少覆盖两个入口的user/project precedence、source refs/config digest一致、session ceiling、missing/unknown migration、highest-activated、restart digest drift、history writeback不污染user/project provenance、roll-forward/rollback和legacy session manual行为。

每次晋级都需要:

- feature evidence;
- error/latency/wake backlog/stale generation/reconciliation metrics;
- fault matrix;
- rollback演练;
- frozen dependency readiness;
- user surface与运维runbook。

### 14.2 rollback

rollback 不删除事件、不降级schema、不重写Goal/Task:

1. 切换 feature mode到前一阶段;
2. effectful driver先写 pause/deactivate,取消future wakes;
3. active/unknown effect先settle或进入reconciling;
4. existing workflow events保持可读/replay;
5. old manual user path恢复;
6. legacy session不反向伪造user prompts;
7. required -> default/opt_in降级必须保留Control Plane inspect/recovery。

紧急进程终止后,restart reducer因generation失效默认paused/reconciling,不会幽灵续跑。

## 15. Production readiness gates

完整 capability 只有同时满足以下门禁才能 advertise:

| Gate | ready 条件 |
|---|---|
| Canonical | workflow全状态可从verified Event Store重放 |
| Ownership | 单driver generation绑定active writer authority |
| Determinism | 相同snapshot产生相同decision digest |
| Priority | user/client trigger稳定抢占internal wake |
| Durability | wake/attempt/wait/cancel/recovery fault matrix通过 |
| Agent | typed internal continuation,无fake user message |
| Budget | root/child reservation/settlement exact once |
| Verification | only trusted EpisodeSeal completes |
| Security | Gateway/Sandbox/Workspace/Approval真实receipt ready |
| Resource | immutable snapshot/revocation/reload边界ready |
| Multi-agent | child completion/artifact/usage/cold recovery ready |
| Control | pause/resume/cancel/inspect跨restart幂等 |
| Activity | waiting/sleeping/paused/reconciling可观测且metadata-only |
| Rollout | off/shadow/opt-in evidence和rollback演练完成 |
| Platform | Linux及目标darwin/win32 matrix有真实runner证据 |

任一 required gate 不满足时:

- Runtime-only模块可以标记 implemented;
- 产品 capability仍为 blocked/external_gap;
- 不advertise、不默认启用、不通过测试fake提升状态。

## 16. 目标文件结构

```text
development-doc/loop-goal-workflow/
├── 00-reference.md
├── 01-implementation-plan.md
└── 02-implementation-checklist.md

src/runtime/orchestrator/workflow/
├── child-receipts.ts
├── definition.ts
├── decision-kernel.ts
├── driver-generation.ts
├── driver.ts
├── events.ts
├── index.ts
├── outcomes.ts
├── ports.ts
├── projection.ts
├── repository.ts
├── resource-snapshot.ts
├── task-scheduler.ts
├── types.ts
└── wake-inbox.ts

tests/runtime-v3/orchestrator/workflow/
├── definition.test.ts
├── projection.test.ts
├── repository.test.ts
├── decision-kernel.test.ts
├── task-scheduler.test.ts
├── wake-inbox.test.ts
├── driver.test.ts
├── recovery.test.ts
└── cancellation.test.ts
```

M4-M8 的 integration/control-plane/activity/agents/CLI/TUI 文件按清单逐阶段添加,不提前创建空壳或跨阶段占位。
