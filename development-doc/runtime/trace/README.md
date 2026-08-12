# Runtime Trace / Opik

本目录是 RunLedger Agent Runtime 的调用记录与观测实现入口。它只描述和承接具体行为实现；通用 Runtime contract 仍以 [`../04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md) 为唯一契约入口。

## 当前目标

- Event Store：唯一可重放的模型、工具、上下文、Agent 生命周期事实源；
- Artifact Store：保存安全清洗后的完整业务上下文、模型请求/响应和工具输入/输出；
- Trace Tree：从 Event Store 重建 Trace → Agent → Turn → Model → Tool/Attempt/Child Agent 树；
- Opik：使用 `/opik/sdks/typescript` 的 `opik@2.2.13` 作为可选观测投影；
- 计量：记录 provider usage、估算/实际 Token、USD 费用、wall duration、TTFT 和 retry；
- 安全：凭据、auth header、完整环境变量、private reasoning 和无界正文不外发。

## 实施状态

历史目标基线为 `rollback/pre-governed-agent-harness-runtime`。Phase 01–03 已在当前 `session-owner-runtime` 工作树实现：本地 Store、runtime recorder、用户级配置和标准 CLI production composition 已接线；recorder 由 Session domain 强制绑定 `sessionId + ownerGeneration`。2026-08-12 reliability hardening 又把 Session-owned process 的 normal/failed/timed-out/killed/lost/uncertain/takeover 终态接入同一 recorder；output materialization 先完成，随后幂等 terminal settlement 并释放 recorder。Opik/outbox 顺延到 Phase 04，尚未开始且当前代码不联网。

| 文档 | 阶段 | 状态 |
|---|---|---|
| [`00-opik-agent-observability-plan.md`](00-opik-agent-observability-plan.md) | 总体方案、依赖与验收 | active |
| [`phase-01-event-store-artifact-store.md`](phase-01-event-store-artifact-store.md) | Event Store、Artifact Store、树 projection 基础 | completed |
| [`phase-02-runtime-recorder.md`](phase-02-runtime-recorder.md) | agent-loop/model/tool/context recorder | implemented in worktree |
| [`phase-03-local-store-configuration.md`](phase-03-local-store-configuration.md) | 用户级 recording 配置、失败策略、canonical composition | implemented in worktree |
| [`phase-04-opik-exporter-tree.md`](phase-04-opik-exporter-tree.md) | Opik adapter、durable outbox 与展示 | planned |

## 依赖边界

Storage S0–S5 的 canonical user home 已作为生产写入前置条件。标准 CLI 默认 `recording.mode=off`；用户可在 canonical settings 中显式开启 `events` 或 `events_and_artifacts`。当前不存在“本地 Artifact 正文必须等待 PermissionEngine、Approval、Sandbox”的需求，因此不设置预防性 capability gate；三者有明确策略与 receipt 后再由安全专项接线。Opik 不可用不得阻断 Event Store 或 Agent 执行。
