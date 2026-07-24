# RunLedger Loop / Goal / Dynamic Workflow 参考研究

> 文档属性:只读参考研究,不是实施状态真源<br>
> 编写日期:2026-07-24<br>
> RunLedger 固定基线:`feat/agent-loop-resurrect@678b046b3cd11632c5e5bfc7ef5dd210e8f23ec3`<br>
> Codex 固定基线:`main@0b175e6439a8608ba7726ee153fd8590619e8f34`<br>
> grok-build 固定基线:`main@c68e39f60462f28d9be5e683d9cbe2c57b1a5027`<br>
> claude-code-bun 固定基线:`main@73338f21dc166ac13303d24f3fe671a52bac745d`<br>
> 下游计划:[`01-implementation-plan.md`](01-implementation-plan.md)<br>
> 执行清单:[`02-implementation-checklist.md`](02-implementation-checklist.md)

## 0. 结论摘要

RunLedger 已经拥有 Goal phase、canonical Task DAG、BudgetGuard、retry/loop breaker、Session v3 Event Store、Verification/EpisodeSeal、Agent loop、Control Plane、Activity 与多 Agent 合同。当前缺口不是再增加一套 Goal 或 Task 状态机,而是建立一个可恢复、可限界、可观测的 workflow driver,把这些既有真源连接成完整闭环:

```text
durable trigger / wake
  -> replay existing Goal / Task / Budget / Verification truth
  -> pure workflow decision
  -> one bounded durable effect
  -> typed Agent continuation or existing lifecycle operation
  -> attempt terminal evidence
  -> next durable wait / wake
```

三份参考实现共同证明了以下原则:

1. sampling/tool loop 与跨 turn Goal continuation 必须分层,不能把自动续跑塞进一个无限 `agent-loop`;
2. Goal 业务阶段、workflow 运行处置、等待/暂停原因必须正交;
3. 自动 continuation 必须有结构化 provenance,不能伪造成普通用户消息;
4. scheduler 只产生 durable wake,不直接执行模型 turn;
5. workflow definition、workflow run、attempt 必须分离;
6. restart、重复投递、抢占、取消和未知副作用必须通过 replay、幂等与 fencing 处理;
7. 模型自述、planner/classifier 文本或 verifier 基础设施失败都不能完成 Goal;
8. RunLedger 的 Goal completion 仍只能由受信 `EpisodeSeal` 驱动。

## 1. 调研方法与证据边界

### 1.1 方法

本研究由三个只读 subagent 分别审阅 Codex、grok-build 与 claude-code-bun,主线程同时审阅 RunLedger 当前实现。每条结论分为:

- `采用`:可直接转化为 RunLedger 自有合同或状态机不变量;
- `调整`:保留行为目标,但基于 RunLedger Event Store、Task DAG、BudgetGuard 和 Verification 重新设计;
- `拒绝`:与 RunLedger 的 canonical truth、fail-closed 或许可证边界冲突。

所有 reference commit 已固定。后续上游变化只有在重新固定 commit 并补充差异审阅后才能影响本计划。

### 1.2 不把参考实现当作 RunLedger 真源

- 参考仓库的状态名、文件布局、prompt、UI 和持久化格式都不是 RunLedger 公共合同;
- 文档中的 line reference 只用于解释本次固定 commit 的观察结果;
- RunLedger 实现必须从自己的 TypeScript 类型、v3 event schema 和独立 RED tests 出发;
- 参考项目中“看似 durable”的注释或进程内 actor 行为,不能替代 RunLedger 的 crash/replay 证据。

## 2. RunLedger 当前基线

### 2.1 已有 canonical truth

| 能力 | 当前证据 | 本计划中的定位 |
|---|---|---|
| Goal 生命周期 | `src/runtime/orchestrator/types.ts:19-89`、`goal-state-machine.ts:193-280,329-403` | 唯一 Goal phase 真源,不复制 |
| Goal completion trust | `goal-state-machine.ts:215-219,250-260` | 模型不能迁移 Goal;只有受信 `EpisodeSeal` 可完成 |
| approved Plan -> Task DAG | `prompt-goal-coordinator.ts:180-257` | 继续消费冻结 Plan 的公开 evidence,不新增 planner |
| phase gate coordinator | `prompt-goal-coordinator.ts:268-405` | 继续负责 Goal phase/evidence gate |
| canonical Task repository | `task-repository.ts:23-125,340-445,455-570` | 唯一 Task 状态与输出绑定真源 |
| deterministic DAG order | `task-dag.ts:55-149` | workflow scheduler 的稳定排序基础 |
| BudgetGuard | `budget-guard.ts`、`agent-loop-budget.ts`、`turn-operation-budget.ts` | 唯一预算 reservation/settlement 真源 |
| retry 与 loop breaker | `durable-retry-controller.ts`、`loop-breaker.ts:105-143` | workflow 只消费与驱动,不造第二套 retry/loop counter |
| Session v3 Event Store | `session/event-writer.ts:1-24,145-260` | workflow event、wake、attempt 与 projection 的 canonical log |
| Verification/EpisodeSeal | `verification/**` | completion 的唯一受信 terminal evidence |
| Agent loop continuation primitive | `agent-loop.ts:1949-1956` | 可作为内部 continuation 底层,但当前缺少治理入口 |
| Agent user queue | `agent.ts:240-319,350-436` | 用户 steer/follow-up 真源;workflow 不混入该队列 |
| Control Plane | `control-plane/types.ts:156-244` | 后续增加 goal/workflow 命令与查询 |
| Activity projection | `activity/types.ts:25-68`、`activity/projection.ts:56-84,170-218` | 后续投影 waiting/sleeping/paused/reconciling |
| multi-agent contracts | `src/runtime/agents/**` | child completion 与 root budget 的既有权威路径 |

### 2.2 已确认的结构缺口

1. `GoalState` 只有 phase、revision、evidence、partial result 与 `pausedFrom`,没有 durable objective/workflow definition、workflow disposition 或 continuation policy。
2. `PromptGoalCoordinator` 能验证 approved Plan、导入 Task DAG 并推进 evidence gate,但不会选择 ready Task、启动 Agent、等待 child 或调度下一 turn。
3. `SessionTaskRepository` 已定义 `pending -> ready -> running -> terminal` 迁移与 dependency gate,但没有 ready-task scheduler。
4. `createProductionSessionRuntime()` 的 lifecycle ports 是可选项;缺省走 `unsupported/external_gap`。`production-interactive-runtime.ts:1255-1267` 当前没有传入真实 lifecycle ports。
5. 生产源码没有调用 `lifecycle.run()` 或 `lifecycle.resume()` 的持续 driver;现有调用集中在测试。
6. `runAgentLoopContinue()` 已存在,但 `Agent` 的公开入口仍是 `prompt/steer/followUp`;没有带 runtime provenance、revision 与 generation fence 的 governed internal continuation。
7. durable user queue 只有 `steer | follow_up`;把 scheduler/Goal wake 塞进去会混淆用户身份、优先级与取消语义。
8. `LoopBreaker` 支持 replay,但生产 composition 注入实例时没有强制证明它来自当前 durable control journal 的重放结果。
9. Activity 把所有 nonterminal Goal/Task 都算作 active,无法区分 waiting、sleeping、paused、blocked 与 reconciling。
10. Control Plane 缺少 `goal:pause/resume`、`workflow:cancel/inspect` 等 versioned command/query。
11. restart、driver takeover、重复 wake、cancel-requested 与 unknown side effect 尚无 workflow-level event/projection。

### 2.3 当前定向基线

本次规划前已执行:

```bash
npx vitest run \
  tests/runtime-v3/orchestrator/goal-state-machine.test.ts \
  tests/runtime-v3/orchestrator/prompt-goal-coordinator.test.ts \
  tests/runtime-v3/orchestrator/agent-loop-wiring.test.ts \
  tests/runtime-v3/orchestrator/retry-loop-breaker.test.ts \
  tests/runtime-v3/integration/production-session-runtime.test.ts \
  tests/runtime-v3/control-plane/phase11-production-binding.test.ts \
  --no-file-parallelism
```

结果:`6 test files passed / 22 tests passed`。该结果证明现有 seam 可执行,不证明 loop/goal/workflow 已闭环。

## 3. Codex 参考

### 3.1 loop 分层与 idle continuation

Codex 把 client operation、session mailbox、turn task、sampling/tool loop 和 idle continuation 分开:

```text
client operation
  -> session mailbox
  -> RegularTask
  -> run_turn sampling/tool loop
  -> turn terminal
  -> clear active turn
  -> thread idle hook
  -> Goal continuation through the same idle gate
```

证据:

- `codex-rs/core/src/session/handlers.rs:695-852`:统一 submission mailbox;
- `codex-rs/core/src/tasks/regular.rs:71-88`:同一显式 turn 的 pending input 外层;
- `codex-rs/core/src/session/turn.rs:130-151,293-435`:sampling/tool 内层;
- `codex-rs/core/src/tasks/mod.rs:771-827`:先 terminal、再清 active turn、再触发 idle;
- `codex-rs/core/src/session/inject.rs:38-129`:统一 `try_start_turn_if_idle`,预留前后两次检查 user mailbox、busy、Plan/review 状态;
- `codex-rs/core/src/codex_thread.rs:87-125`:结构化拒绝原因;
- `codex-rs/ext/goal/src/extension.rs:154-166`:Goal 只在 thread idle 尝试续跑;
- `codex-rs/ext/goal/src/runtime.rs:359-425`:Goal state permit、fork deferral、live thread 与 active state gate;
- `codex-rs/ext/goal/src/steering.rs:1-74`:continuation 带 internal source,不是普通 user message。
- `codex-rs/core/src/session/tests.rs:9732-9928`:idle continuation、pending user input 与重复 idle hook 的竞态回归;
- `codex-rs/ext/goal/tests/goal_extension_backend.rs:247,298,361,437,577,686,723,1010`:Goal continuation、pause、budget 与 stale hook 的行为回归;
- `codex-rs/app-server/tests/suite/v2/thread_resume.rs:1607,2023,2221`:resume 后 pending replay 与 idle continuation 顺序;
- `codex-rs/app-server/tests/suite/v2/thread_fork.rs:383-612`:fork 后 Goal/deferral 的参考行为边界。

RunLedger 采用:

- turn clear 后才允许 workflow continuation;
- 所有自动启动都经过唯一 idle admission gate;
- 用户输入在 claim 前和 claim 后都能抢占内部 continuation;
- 拒绝/延期写结构化原因,不轮询、不丢 wake。

### 3.2 Goal persistence、stale hook 与 accounting

证据:

- `codex-rs/state/src/model/thread_goal.rs:12-71`:Goal status 与 token/time usage;
- `codex-rs/state/goals_migrations/0001_thread_goals.sql:1-18`:per-thread goal state;
- `codex-rs/state/goals_migrations/0002_thread_goal_continuation_deferrals.sql:1-3`:fork continuation deferral;
- `codex-rs/state/src/runtime/goals.rs:80-153,271-418,499-630`:snapshot、deferral 与 `expected_goal_id` CAS;
- `codex-rs/ext/goal/src/runtime.rs:126-156,243-425`:mutation/continuation serialization;
- `codex-rs/ext/goal/src/accounting.rs:66-150,202-229,285-336`:turn baseline、parallel tool-finish 去重、token accounting;
- `codex-rs/ext/goal/src/extension.rs:364-411`:soft budget 达限后让当前 turn 收尾,只阻止后续 continuation。

RunLedger 调整:

- 不复制 SQLite state + rollout secondary event 双真源;
- 使用 Session v3 append-only events + replayable projection;
- stale check 至少绑定 `goalId + goalRevision + workflowRunId + attemptId + runtimeGeneration`;
- 预算继续由 `BudgetGuard` reservation/settlement 控制,workflow 只记录关联与决策。

### 3.3 interrupt、resume、fork 与 immutable resource boundary

证据:

- `codex-rs/tui/src/chatwidget/interaction.rs:356-417,477-495`:TUI interrupt 后补 Goal pause,暴露了 UI/runtime 原子性问题;
- `codex-rs/ext/goal/src/runtime.rs:335-357`:resume accounting rehydrate;
- `codex-rs/app-server/src/request_processors/thread_lifecycle.rs:696-748`:snapshot/pending replay 完成后才触发 idle continuation;
- `codex-rs/app-server/src/request_processors/thread_fork_goal.rs:5-27`:fork 复制 Goal;
- `codex-rs/state/src/runtime/goals.rs:80-153`:fork durable deferral;
- `codex-rs/core/src/session/mcp.rs:407-484,490-525,614-649`:新 runtime 构造成功后原子 publish;
- `codex-rs/core/src/session/tests.rs:7640-7704`:in-flight step 保留旧 snapshot,新 step 使用新 snapshot;
- `codex-rs/core/src/tools/spec_plan.rs:430-492,906-925`:direct/deferred tool exposure;
- `codex-rs/core/src/tools/handlers/tool_search.rs:25-180`:deferred resource discovery。

RunLedger 采用:

- `pause goal + interrupt turn + cancel future wake` 应实现为有 durable intent、receipt 与 reconciliation 的 governed saga,不能依赖 TUI 补写;
- resume 先恢复投影与通知,再按 policy 决定是否允许 auto-start;
- RunLedger V1 的 session fork 不复制 workflow run/attempt/wake/budget,也不自动 continuation;fork 后保持 manual/unsupported,未来必须另立 identity、usage inheritance 与 first-turn durable deferral 合同;
- workflow attempt 在 turn 边界绑定 immutable resource snapshot digest;
- in-flight attempt 不原地热换 tools/skills/hooks/MCP。

### 3.4 Codex 明确不足

- blocker 连续次数与完成审计主要依赖 prompt/tool description,没有完整 requirements verifier;
- runtime error 与 business blocked 的边界不够细;
- token budget 是 soft transition,不能被误述为 provider 调用硬上限;
- rollout 并不是 Goal canonical truth。

RunLedger 不把这些行为直接照搬。

## 4. grok-build 参考

### 4.1 phase、runtime status 与 pause reason 分离

证据:

- `crates/codegen/xai-grok-shell/src/session/goal_tracker.rs:37-44`:Goal phase;
- `goal_tracker.rs:46-86`:Active/UserPaused/BackOffPaused/NoProgressPaused/InfraPaused/Blocked/BudgetLimited/Complete status;
- `goal_tracker.rs:131-177`:pause reason 输入映射到 paused status;
- `goal_tracker.rs:427-479`:objective、budget、usage、history 与 pause message;
- `goal_tracker.rs:710-776`:restart 把 Planning/Executing 复位到 Idle,并把原 Active 转为 UserPaused;
- `goal_tracker.rs:943-1000`、`acp_session_impl/goal.rs:899-920`:新 Goal 与 phase 接线现状。

该固定提交并没有把 pause reason 作为完整独立持久化轴,`Planning` phase 的生产驱动也不完整。RunLedger 采用的是三轴分离的领域建模原则,不是宣称 grok-build 已完整实现。

RunLedger 采用其建模原则,但不替换现有 `GoalPhase`:

```text
GoalPhase                  = 业务阶段,现有 DurableGoalStateMachine 唯一拥有
WorkflowDisposition        = ready/running/waiting/paused/sleeping/reconciling
WorkflowWait/PauseReason   = 具体等待、暂停或恢复原因
```

### 4.2 typed origin、scheduler notification 与 child completion

证据:

- `crates/codegen/xai-grok-shell/src/session/mod.rs:55-153`:typed prompt origin、stable prefix 与 synthetic/completion policy;
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs:751-792`:同一 prompt 内 Goal round continuation;
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs:1929-2085,2115-2222`:completion claim、verifier、budget、gap/strategy/next-step 与双重 dedup;
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/run_loop.rs:205-221`:completion、infra pause、turn end、queued task、notification drain、idle 的顺序;
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/scheduler/types.rs:14-107`:schedule/interval/actor command contract;
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/scheduler/actor.rs:28-267`:due fire、restore re-announce、create/delete/list actor;
- `crates/codegen/xai-grok-shell/src/tools/notification_bridge.rs:609-652,762-800`:scheduler inject/fired 与持久化边界;
- `crates/codegen/xai-grok-pager/src/app/acp_handler/prompt_origin.rs:24-37`:实际 auto-wake origin;
- `crates/codegen/xai-grok-shell/src/tools/notification_bridge.rs:326-449,702-727`、`tools/tool_context.rs:55-110`:child completion suppression与delivery去重;
- `crates/codegen/xai-chat-state/src/commands.rs:63-84`、`usage.rs:1-26,31-90,100-147,163-194`、`actor/mutations.rs:325-370`:main/child/session usage归属;
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/updates.rs:14-52`、`goal_support.rs:1347-1424`、`session/goal_orchestrator.rs:137-195,407-425`:parent prompt pin、goal child high-water与防双计;
- `crates/codegen/xai-grok-shell/src/leader/server.rs:441-452,1750-1762,4846-4879`、`crates/codegen/xai-grok-pager/src/app/acp_handler/background.rs:410-475`:notification依赖唯一live driver/pager回环。

RunLedger 采用:

- user、goal continuation、scheduler、retry、child completion、verification completion 使用 typed origin;
- scheduler 先写 durable wake,不直接执行模型;
- child terminal receipt 转为 durable parent wake;
- child usage 只通过现有 root `BudgetGuard` 结算一次;
- restart 默认不静默恢复无人值守执行,只有显式 policy + safe replay 才能续跑。

### 4.3 角色分离的适用边界

grok-build 把 planner、classifier/verifier、strategist、summarizer、next-step 与 stop-detector 分开,有利于限制模型角色越权。

RunLedger V1 只采用“typed port 与 evidence 分离”的原则:

- 不在本专项实现第二套 planner、summarizer、context engine 或 memory;
- approved Plan 继续来自冻结 Plan domain;
- verified gap 只从现有 Finding/Verification/Artifact evidence 投影;
- strategist/classifier 的模型文本只能形成 claim,不能迁移 Goal 或 Task;
- 真正的 task selection 由纯 deterministic kernel 完成。

### 4.4 grok-build 必须拒绝的行为

`goal_classifier.rs:158-165,197-202,644-672,724-743` 明确定义 verifier infrastructure failure -> `FailOpenAchieved`;`acp_session_impl/goal.rs:805-829` 最终把它写为 `Achieved` 并调用 `tracker.complete()`。classifier disabled 在 `goal.rs:301-316` 甚至可直接完成。RunLedger 必须反向固定不变量:

```text
verifier unavailable / errored
  -> waiting(reason=verification_external_gap)
     | paused(reason=verification_failed_or_exhausted)
     | reconciling
  -> never completed
```

其他拒绝项:

- 普通 JSON snapshot 不能作为 canonical workflow truth;
- scheduler 注释中的 durable 不能替代 kill/restart/replay 证据;
- UI/pager/gateway 回环不能是唯一 driver;
- scheduler fire 不能直接成为 prompt;
- planner/classifier 结论不能直接写 Goal terminal state。

固定提交还存在两条 durability 断链证据:

- `session/persistence.rs:350,1634-1638` 有 `GoalModeState` variant/consumer,但生产源码未发现 producer;
- scheduler `types.rs:81-88` 注释声称只序列化 durable task,而 `xai-grok-tools/src/persistence.rs:11-20,57-100,135-203` 实际覆盖写整个 Resources snapshot,actor 内 last-fired/delete 也没有形成完整 canonical event 链。

## 5. claude-code-bun 参考

该 checkout 的定向测试在加载阶段缺少 `@ant/model-provider`、`proper-lockfile`、`lodash-es`、`react`、`zod/v4` 等依赖,结果不能作为实现通过或失败证据。本研究只使用固定 commit 的只读源码/测试结构观察,未安装依赖、未修改参考仓库。

### 5.1 typed loop transition

证据:

- `src/query/transitions.ts:1-20`:穷举 `Terminal | Continue`;
- `src/query.ts:210-389,1283-1615,1635-1889,2017-2041`:terminal mapping、主循环、recovery、tools、queue 与 next turn;
- `src/query.ts:458-473`:外层 finalization;
- `src/query/tokenBudget.ts:3-92`:90% 阈值、continuation count、diminishing-return guard;
- `src/query/stopHooks.ts:186-467`:typed allow/retry/prevent hook outcomes。

RunLedger 采用 exhaustive decision/outcome union 与 finally-finalize,但不会复制 query 主循环或 prompt policy。

### 5.2 flow/run/attempt、claim 与 two-phase scheduler

证据:

- `src/utils/autonomyFlows.ts:18-103,458-1009`:flow/step/goal/wait/cancel;
- `src/utils/autonomyRuns.ts:38-116,282-810`:run、source dedup、heartbeat、terminal;
- `src/utils/autonomyQueueLifecycle.ts:80-261`:queued -> running claim 与 finally finalization;
- `src/utils/autonomyAuthority.ts:175-573`:due prepare/commit 两阶段;
- `src/utils/messageQueueManager.ts:41-55,128-192`:queue;
- `src/types/textInputTypes.ts:294-371`:`QueuedCommand.autonomy` 的 agent/run/flow/step correlation metadata;
- `packages/@ant/model-provider/src/types/message.ts:96`、`autonomyRuns.ts:583-605,1026-1049`:message origin 实际仍是 string 并通过 cast 注入,不构成 typed origin union;
- `src/utils/cronScheduler.ts:40-530`:scheduler lock、jitter、in-flight 与 source dedup。

该实现提供了 flow/step、per-step run、active source/flow dedup 与 claim/finalize 的观察输入,但没有独立 immutable definition/attempt 真源。`AutonomyFlowRecord` 可在 terminal 后以同一 flow ID 增 revision重建;source dedup 也不能被扩写成 goal/run exactly-once。

RunLedger 的独立增强与反向纠正:

- 把 flow/step 与 per-step run 的分离提升为 immutable definition、workflow run、attempt 三层;
- 保留 claim-before-consume 与 finally-finalize;
- 不沿用 cron 的消费顺序:`onFire` 后 `next/lastFired/delete` 可能早于异步 queue/run durable 成功;RunLedger V1 必须先 mandatory-flush one-shot wake,且不另建 occurrence/cursor projection;
- 使用 exact goal/definition/run/attempt identity 与 idempotency key,而不是把 active source/flow dedup当成 durable exactly-once;
- 使用真正的 typed internal origin union,不复用 string cast;
- provider/API error 不推进 task/flow;
- cancellation request、executor abort 与 terminal cancellation 分开;
- 每次 driver tick 有界,下一次执行必须经 durable wake。

### 5.3 child resume 与 result ordering

证据:

- `src/utils/processUserInput/processSlashCommand.tsx:145-293`:后台 child、独立 cancellation、result 与下一 step ordering;
- `packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts:43-265`:从 transcript/metadata/worktree 恢复 child;
- `packages/builtin-tools/src/tools/SendMessageTool/SendMessageTool.ts:909-984`:running/stopped child 消息与恢复。

RunLedger 只采用抽象顺序:

```text
child terminal receipt
  -> artifact handoff and root budget settlement
  -> durable parent wake
  -> parent task/attempt decision
```

具体 child authority、Workspace、Sandbox、cleanup 与 budget 行为继续由现有 `src/runtime/agents/**` 和冻结安全专项拥有。

### 5.4 明确拒绝

- 不复制弱 `WorkflowTool`;它依赖模型主动 `advance`,没有完整 executor、lease、wait/retry 与 failure semantics;
- 不复制覆盖写 JSON snapshot;
- 不用 PID liveness 替代 writer lease/runtime generation/fencing;
- 不使用无界 queue 或 active-record 永不清理策略;
- 不复制 prompt DSL、宽松 YAML-like parser、React/Bun runtime coupling;
- 不把 `/loop` prompt skill 当作 runtime loop;
- 不保留没有 reducer transition 的 `blocked/lost` 等不可达状态。

## 6. 采用 / 调整 / 拒绝矩阵

| 主题 | 采用 | RunLedger 调整 | 拒绝 |
|---|---|---|---|
| loop boundary | turn terminal 后由 idle hook续跑 | durable wake + bounded driver tick | agent-loop 内无限自循环 |
| Goal model | phase 与 runtime disposition 分离 | 保留现有 `GoalPhase`;新增 workflow projection | 第二套 Goal lifecycle |
| workflow definition | immutable/versioned | 封闭 `coding-goal/v1` TypeScript schema | executable YAML、任意 plugin workflow |
| execution state | flow/run/attempt 分层 | run/attempt event projection绑定 existing Goal/Task | JSON snapshot 真源 |
| decision | exhaustive typed union | pure `WorkflowDecisionKernel` | 模型文本直接决定状态 |
| task scheduling | deterministic ready selection | 消费 canonical Task repository 与 stable DAG order | 新 Task store/DAG |
| continuation | typed internal provenance | controller/Agent 内部入口 + context provider | 伪造 user message |
| priority | user/client trigger 优先 | claim 前后双检 mailbox/generation | polling 或内部 wake 抢占用户 |
| schedule | prepare/commit + source dedup | mandatory-flushed one-shot durable wake,at-least-once + idempotent consumer | recurring cursor、scheduler 直接调用模型、宣称 exactly-once |
| waiting | explicit wait/resume | durable wait reason/deadline/correlation | 进程 timer/PID 作真源 |
| cancellation | request/abort/terminal 分层 | pause intent + Goal transition + interrupt/cancel receipt 的可恢复 saga | 伪原子操作、TUI 补写 pause、只记 timestamp |
| retry/loop | bounded retry、stall guard | 消费现有 retry/LoopBreaker/verified evidence | 第二套 retry counter |
| budget | soft threshold 后停止下一 continuation | existing BudgetGuard 统一 reservation/settlement | token soft threshold 宣称硬上限 |
| verification |独立 verifier与 gap | only trusted EpisodeSeal completes | fail-open achieved |
| child completion | durable parent notification | existing Agent/Supervisor receipt + root budget | process callback 单独推进 |
| resources | boundary snapshot publication | consume frozen immutable snapshot | in-flight hot swap |
| recovery | replay、fence、safe pause | existing writer authority + driver generation | PID stale ownership |
| UI/control | projection only | versioned Control Plane/Activity | UI 直接写 runtime private state |

## 7. 许可证与来源隔离

| 参考仓库 | 本次固定基线的许可证观察 | RunLedger 使用边界 |
|---|---|---|
| Codex | 根 `LICENSE:1` 为 Apache License 2.0;`LICENSE:189-197` 含适用声明;根 `NOTICE:1-6` 含 OpenAI/第三方归属 | 架构参考可独立实现;逐行复用必须保留许可证、NOTICE、适用版权/专利声明并标注修改;`vendor/`、`third_party/`、sample assets 逐项复核 |
| grok-build | 根 `LICENSE:1-8` 标识 Apache-2.0,`:92-125` 规定再分发/修改与 NOTICE,`:181-204` 为附录;`THIRD-PARTY-NOTICES:1-18` 和 `third_party/NOTICE:1-63` 列出第三方与单独许可边界 | 独立实现优先;任何源码、测试、prompt、UI 或名称复用都先逐文件核对 provenance、适用 NOTICE 与第三方许可 |
| claude-code-bun | 固定 checkout 没有仓库级 LICENSE/COPYING/NOTICE;`README_EN.md:12`、`package.json:4`、`AGENTS.md:7` 明示 reverse-engineered/decompiled;README 仅有学习研究表述 | 只作抽象行为研究;禁止复制或改写代码、prompt、测试、注释、UI、专有命名、反编译结构或重建产物 |

对 claude-code-bun 的准确表述是“受许可证隔离约束的独立重新设计”,不是“clean-room implementation”,因为规划人员已经阅读参考源码。本段是保守工程边界,不构成法律意见。

## 8. 固定架构结论

下列结论进入实施计划后视为默认冻结决策:

1. 不新增第二套 Goal/Task/Budget/Verification canonical state。
2. 新子域固定为 `src/runtime/orchestrator/workflow/`。
3. V1 workflow kind 固定为封闭的 `coding-goal/v1`。
4. workflow definition immutable;替换 definition 只能在 paused 状态形成新版本和新 run。
5. execution disposition 固定为 `ready | running | waiting | paused | sleeping | reconciling`,Goal terminal 仍只由 `GoalPhase` 表达。
6. scheduler 只选 existing canonical Tasks,不创建或重写 Plan/Task DAG。
7. driver 每次 `tick()` 最多提交一个 decision/effect boundary,不得递归自唤醒。
8. wake 是 at-least-once delivery;消费者必须幂等,不得宣称 exactly-once。
9. 一个 session 同时只有一个绑定现有 EventWriter authority 的 logical driver generation。
10. 用户输入始终高于 internal/scheduled continuation。
11. internal continuation 必须是 typed runtime input,不能伪造 user message。
12. verifier unavailable/error 永不完成 Goal。
13. 只有受信 `EpisodeSeal` 能驱动 `GoalPhase=completed`。
14. restart 默认进入 paused/reconciling;只有显式 policy、无 unknown side effect、generation/writer fence 有效时才能自动续跑。
15. frozen Plan/Context/Memory、Extension、Worktree/Sandbox/Permission 只通过公开 port 消费;依赖不足时保持 `unsupported/deny/not advertised`。
16. V1 fork 不继承 active workflow execution state,不自动启动 continuation。
