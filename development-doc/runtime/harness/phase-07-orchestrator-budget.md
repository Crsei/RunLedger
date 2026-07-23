# Phase 7:确定性 Orchestrator、Task DAG 与 BudgetGuard

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 6](phase-06-model-plan-context-contracts.md) / [Phase 8](phase-08-verification.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:让模型负责提出内容,让 Runtime 决定阶段、门禁、重试、预算和完成。

前置:Phase 1–5 和 Phase 6 公共契约。当前只继续 Orchestrator reducer/budget 与 Runtime adapter,消费`06`冻结的现有专项公开面;不再并行开发专项行为。冻结readiness不满足时相关feature保持unsupported,Runtime-M1发布承诺继续未关闭。

计划文件:

- 新增 `src/runtime/orchestrator/{types,goal-state-machine,turn-orchestrator,save-point,task-dag,budget-guard,retry-policy,loop-breaker}.ts`。
- 修改 `src/runtime/tasks/` 作为 DAG projection/兼容 adapter。
- 修改 `src/runtime/agent.ts`;对 `interactive-session-controller.ts` 的接线排入已预约的 Runtime 串行集成窗口,不得与安全、扩展或 Context 专项集成并发。
- 新增 `tests/runtime-v3/orchestrator/`。

核心状态:

```ts
export type GoalPhase =
  | "planning"
  | "awaiting_plan_approval"
  | "implementation"
  | "build"
  | "test"
  | "security_review"
  | "independent_review"
  | "remediation"
  | "reverification"
  | "awaiting_verification"
  | "awaiting_human"
  | "completed"
  | "failed"
  | "stopped";
```

Canonical event/reducer 闭环:

- Task DAG 只由 `task.created`、`task.definition_revised`、`task.transitioned`、`task.output_bound` 重建;dependency/owner/expected Artifact/revision 全在 exact payload 中,不存在只写 tasks sidecar 的旁路。
- Goal、queue、budget 分别复用 `goal.transitioned`、`queue.*`、`budget.*`;`OrchestratorProjection` 以 `(event head, reducer version)` 产生 goal/task/queue/budget/save-point digest,live 与 replay 必须一致。
- 任一 task/goal transition 必须在同一 writer critical section 校验 expected revision 和 required evidence refs 后 append;模型输出、`TaskSnapshot` cache 或 TUI action 不能直接修改 projection。

任务:

- [ ] transition table 明确 allowed transition、required evidence、actor 和 terminal semantics。
- [ ] Plan approval、build、test、security、review、PR/complete 都是系统 gate,模型不能跳过。
- [ ] 在 pi provider-request snapshot/`prepareNextTurn` 模型上强化 save-point:已发出的 provider request 固定 model/tools/resources/config,只有 durable turn 安全点后才对下一次 provider request 应用变更;若定义跨多个 request 的不可变 operation,必须有独立 operationId、开始/终结事件和清晰的本地 divergence 说明。
- [ ] subscriber/hook 必须 awaited settlement;loop terminal、subscriber settled、externally idle、next-mutation-allowed 分成独立状态,任一 listener 不能仅凭 phase=idle 提前驱动下一副作用。
- [ ] durable queue 的 enqueue/claim/consume/cancel 都有 event idempotency;runtime 只按 queueItemId+kind 接受 durable receipt,不按内容 digest 反查。claim 与 `model.requested` 必须在外呼前 durable 绑定同一 modelRequestId,外呼结果不确定时 pause,不得重发旧 prompt。
- [ ] queue item 的 durable accepted、Agent 已开始执行和 turn terminal 是三个独立状态;turn 收尾与本地 `inFlight` 切换期间到达的 item 必须由 canonical projection 在当前或下一 turn 精确消费,不能因最后一次内存轮询已结束而静默丢失。
- [ ] retry policy 区分 network、rate limit、context overflow、tool uncertain outcome;副作用不确定默认 pause。
- [ ] tool retry 还必须同时满足 manifest 的 idempotent/retry-safe 声明、原 request/toolCall/idempotency identity、当前 workspace/capability/resource generation 和 Phase 1 reconcile receipt;任一不匹配只能保持 paused 或要求人工 reconciliation,不能创建新 ID 自动重放。
- [ ] Task DAG 验证无环、依赖、owner、expected artifact 以及 workspace/capability ref 的存在性和版本;具体 workspace 可用性与 capability 子集判定调用注入端口。
- [ ] Budget 覆盖 input/output token、USD、wall time、tool calls、retries、network bytes、storage bytes、artifact count、verification 和 active agents。
- [ ] 每项工作先原子 reserve,执行后 commit 实际用量并 refund 余额;并发 worker 共享 root ledger,不得先执行后抢额度。
- [ ] 对 provider 延迟上报的 token/USD 定义估算上界、允许误差和 reconciliation event;不能承诺物理上的绝对零超支。
- [ ] soft threshold 只产生一次 reminder event;hard threshold 原子停止新工作并保留 partial result。
- [ ] loop breaker 识别重复 tool signature、重复失败、无进展 diff 和 remediation 上限。
- [ ] 工具批次默认 sequential;只有每个调用的 capability claim、workspace target、credential/network/process side effect 均被证明相互独立时才允许 parallel。parallel 模式必须先完成全批 preflight,并分别记录 completion-order terminal event 与 source-order model result projection,crash/replay 后两种顺序都确定。
- [ ] Phase 7 的生产 transition 最远只能到 `awaiting_verification`;`completed` 保持禁用,直到 Phase 8 注册受信 verifier issuer/schema。
- [ ] 状态机单测可使用带 `test-only` issuer 的 Verification fixture,该 issuer 在生产 composition root 必须无法注册。

完成门槛:

- 对所有 phase 转移做 table-driven tests,非法跳转均拒绝。
- crash/replay 后 phase、queue、budget 与 live state 一致。
- hard budget 后无未预留的新副作用;任何 provider/stream 误差都被记录并立即阻止后续工作。
- Agent/TUI 均不能直接写 completed 状态。
- Phase 8 前任何生产 Goal 都无法进入 completed,只能停在 awaiting_verification/awaiting_human/failed/stopped。

建议 PR:

1. `runtime: drive goals with a deterministic state machine`
2. `runtime: add durable save points queues and retry semantics`
3. `runtime: enforce DAG and multidimensional budgets`
