# Phase 9:有界 Multi-Agent、权限与 Workspace 引用

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 8](phase-08-verification.md) / [Phase 10](phase-10-control-plane.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:在单 Agent 可靠性和验证闭环成立后,增加有界 DAG 并行,不引入自由递归。

前置:Phase 7、Phase 8。

2026-07-24 W3-P0合同基线:

- `runledger/runtime/agents` 已稳定导出 headless child factory/host、child runtime descriptor v2、cold recovery decision、replacement receipt与统一 `ChildGovernedOperationAdmissionPort`;旧 `integration/*` 深路径保留兼容但不再是公开合同。
- child execution v2 状态冻结为 `prepared -> activation_pending -> active -> completion_pending -> completed/stop_uncertain/stopped`,另有 fail-closed `quarantined`;本节点只冻结合同,不声称 cold recovery/replacement 已实现。
- `runtimeFeatures.multiAgent` 默认关闭,且 `daemon` rollout不依赖它;完整 production advertisement 仍等待W3-M2与W3-J。

2026-07-24 W3-M2交付状态:`Runtime-owned completed`。

- `203fde6`把child authority升级为v2 execution record,持久化activation/completion receipts、immutable runtime descriptor、final cursor与reconciliation evidence;v1 released只读重放,v1 active/partial及不完整writer/stop/final-cursor记录fail closed quarantine。
- cold recovery只在identity与receipt完整时按原descriptor恢复;provider/tool outcome unknown进入`stop_uncertain`,不自动重发。idle unload/reload、standby replacement和fencing promotion均先durable commit新authority再drain旧host。
- `runledger/runtime/agents`稳定导出factory、descriptor、recovery snapshot与`ChildGovernedOperationAdmissionPort`;provider、tool、isolated command、resume、cancel共用child-scoped Workspace/capability/resource/manifest/receipt校验,每次操作先经root BudgetGuard。
- partial/final结果只接受immutable `ArtifactRef`;handoff/merge由父Workspace deterministic apply,冲突保留双方Artifact与可重试状态。late provider usage进入reconcile,超差后停止新工作。
- `d545918`把lane汇入当前分支,`ac54e38`再把同一Supervisor/graph/authority接入schema v2 Control Plane。Runtime-owned完成不代表真实Gateway/Sandbox/process-tree authority ready;这些冻结/平台缺口继续返回`unsupported`、`quarantined`或`external_gap`,Runtime-M2产品声明保持blocked。

本阶段下列复选框继续表达完整产品语义。由真实Gateway/Sandbox、平台process-tree或冻结专项拥有的条目不会因Runtime-owned W3-M2关闭而机械勾选;当前执行状态以主计划§12.7为准。

计划文件:

- 新增 `src/runtime/agents/{types,graph-store,delegation,supervisor,residency,handoff,merge}.ts`。
- 扩展 `src/runtime/orchestrator/task-dag.ts`、`budget-guard.ts`。
- 新增 `tests/runtime-v3/agents/` 和 `tests/e2e/multi-agent-isolation.test.ts`。

Canonical event/reducer 闭环:

- Spawn/semantic lifecycle 使用 `agent.spawn_requested`、`agent.spawned`、`agent.paused`、`agent.stopped`、`agent.partial_committed`、`agent.finished`、`agent.failed`;handoff/merge 使用 `agent.handoff_requested`、`agent.handoff_committed`、`agent.handoff_failed`、`agent.merge_requested`、`agent.merge_committed`、`agent.merge_failed`。
- child resource cleanup 与 semantic terminal 分离,只使用 `agent.cleanup_requested`、`agent.runtime_released`、`agent.workspace_released`、`agent.budget_settled`、`agent.cleanup_reconciliation_required`、`agent.cleanup_completed`;固定顺序为 runtime release -> Workspace release -> budget settlement -> aggregate completion,任何不确定阶段不得越过。
- `AgentGraphProjection` 只从上述 Agent events、parent Task/Goal refs、child event head、workspace/capability/budget receipts 与 Artifact refs 重建 node terminal 与 cleanup aggregate;residency table、launcher registry、in-flight/release cache 都是可丢弃进程状态,不能成为 paused/partial/terminal/cleanup 真源。
- spawn、handoff、merge 与 cleanup stage 均使用 expected graph revision;intent 后 crash 由 stable request id/receipt reconcile,没有 semantic terminal 的 child 不得被父 projection 猜成 finished,没有 exact `cleanup_completed` 的 child 不得被猜成资源已释放。
- parent `AgentSupervisor.cancel()` 必须接收合法的 bounded `reasonEvidenceDigest`;该 digest 进入 semantic terminal 的 request body、`requestDigest` 与 `terminalDigest`,并由 exact `agent.stopped` payload、JSONL codec 和 projection/replay 保留。cleanup stage 通过 exact `terminalDigest` 间接绑定同一取消证据,不能把它描述为每个 cleanup event 都直接复制 reason 字段;相同 request/idempotency key/digest 才能幂等,changed digest 必须在重复外部 release 前冲突。

任务:

- [ ] Spawn 请求必须声明 parent/role/objective/expected Artifact/depth/turn/cost/capability/workspace strategy。
- [ ] 默认 limits:max depth 2、每节点 children 3、total agents 8、root max total cost USD 5、每 Agent max tool calls 40;每次 Spawn 还必须给出 maxTurns/maxCostUsd。实际值只能被更高优先级 policy 收窄;缺少可执行 budget profile 时 fail closed,不得解释为无限额。
- [ ] child 请求只记录 parent grant ref 与 requested capability refs;是否为子集、默认删除哪些能力由注入的 CapabilitySubsetEvaluator 判定并返回 receipt。
- [ ] 每个 builder child 申请独立 session/workspace strategy ref;worktree/lease/readonly checkout 的分配与验证由注入的 Workspace 服务完成。
- [ ] durable Agent graph 记录 parent/child edge、state、cursor、workspace/capability receipt refs、budget 与 artifact contract,不复制外部实现状态。
- [ ] cancellation、timeout、crash、residency eviction 后进入明确 paused/failed/stopped/partial,不能丢失或标 completed。
- [ ] residency eviction 只允许卸载已有 durable terminal/paused snapshot 或可从 child event head 重建的 Agent;interrupted resident 不可重载时必须先持久化 partial/failed 结果并阻止自动恢复,不能永久丢失后仍从 graph 移除。
- [ ] partial result 必须以 ArtifactRef 返回,并标 integrity/verification 状态。
- [ ] merge 只接受声明 Artifact,由父 workspace 的注入服务执行 deterministic apply 并返回 conflict/receipt event;child 不直接写父 worktree。
- [ ] 总并发、总 token/USD/time/tool/network/storage 由 root BudgetGuard 统一扣减。
- [ ] child 默认不能继续 spawn;Runtime 只检查有效 delegation receipt,具体 capability 决策由专项实现。
- [ ] MCP/custom/unknown-kind tool 也必须进入 parent-grant subset evaluation;resume 必须重新校验 delegation/denied-agent/workspace receipts,不能继承 acceptEdits/bypass 或因原 worktree 缺失回退 parent cwd。
- [ ] delegation、child context、partial Artifact、handoff 与 merge 保留所有 InputSourceRef/TaintLabel/declassification refs;父子 Agent 均不得把“模型已阅读/总结”当作去污,合并到危险 sink 前重新经过 Gateway。
- [ ] Runtime contracts 不携带共享 temp、env value、credential 或可写 cwd handle;侧信道隔离由专项实现和联合 E2E 验证。

完成门槛:

- Runtime 单测阻止缺失/过期 receipt、共享 workspace ID、孤儿 Agent 和无限 spawn;capability escalation 与真实共享写隔离依赖专项实现联合测试。
- root crash/replay 后 Agent graph 与每个 child session 一致。
- partial/failed child 不会使父 Goal 自动完成。
- merge conflict 保留双方 Artifact 和可重试状态。

建议 PR:

1. `runtime: persist a bounded delegated agent graph`
2. `runtime: bind child agents to capability and workspace receipts`
3. `runtime: merge only declared verified artifacts`
