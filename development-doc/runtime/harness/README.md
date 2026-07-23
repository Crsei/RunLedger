# Governed Agent Harness Runtime 分阶段索引

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 外围专项冻结说明:[`06-specialty-implementation-freeze.md`](../06-specialty-implementation-freeze.md)

本目录承载主计划原 §7 的 Phase 0–11 完整内容。当前实现状态仍只在主计划 §0.0 汇总,阶段依赖与发布里程碑仍在主计划 §8,最终验收仍在主计划 §11,严格执行顺序、并行 lane 与 join gate 仍只在主计划 §12 定义。本目录不得形成第二套优先级或状态真源。

## 统一协议变更 allowlist

统一协议变更 allowlist:Phase 1–11 只要新增或修改 canonical v3 event,同一 PR 必须同步修改 `src/runtime/protocol/v3/{event-catalog,event-payloads,events,schemas,state-transitions}.ts`、对应领域 schema/type、golden fixture、size bound 与 version fence。该 allowlist 是各阶段“计划文件”的窄例外,不授权顺手修改 ID、canonical JSON/hash 或其他阶段行为;若这些基础规则也需变更,先提交独立 Phase 0 protocol revision。任何阶段只改 `events.ts`/`schemas.ts` 或只新增领域私有 event 都不能完成。

## Phase 文档

| 顺序 | Phase | 独立文档 |
|---:|---|---|
| 0 | 协议冻结、边界检查与测试骨架 | [详情](phase-00-protocol-baseline.md) |
| 1 | Session Kernel v3、哈希链与可恢复状态 | [详情](phase-01-session-kernel-v3.md) |
| 2 | Workspace Envelope、Receipt 与投影数据结构 | [详情](phase-02-workspace-contracts.md) |
| 3 | Capability、Approval 与 Sandbox 契约数据结构 | [详情](phase-03-capability-approval-sandbox-contracts.md) |
| 4 | Artifact CAS、脱敏、Retention 与 Episode 骨架 | [详情](phase-04-artifact-episode.md) |
| 5 | 动态资源 Runtime 协议与数据结构 | [详情](phase-05-resource-contracts.md) |
| 6 | Model、Plan、Context、Compaction 与 Memory 公共契约 | [详情](phase-06-model-plan-context-contracts.md) |
| 7 | 确定性 Orchestrator、Task DAG 与 BudgetGuard | [详情](phase-07-orchestrator-budget.md) |
| 8 | 独立 Verification Pipeline、Finding 生命周期与可信基线 | [详情](phase-08-verification.md) |
| 9 | 有界 Multi-Agent、权限与 Workspace 引用 | [详情](phase-09-multi-agent.md) |
| 10 | Headless Daemon、版本化 Control Plane 与轻客户端 | [详情](phase-10-control-plane.md) |
| 11 | Telemetry、企业/远程契约与生命周期加固 | [详情](phase-11-enterprise-telemetry-lifecycle.md) |

执行时必须先阅读主计划 §12,再按其中当前 Wave 打开相应 Phase 文档;不得按本表自行跳过前置、提前 advertise feature 或越过冻结专项边界。
