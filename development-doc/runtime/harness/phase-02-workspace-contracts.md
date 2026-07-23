# Phase 2:Workspace Envelope、Receipt 与投影数据结构

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 1](phase-01-session-kernel-v3.md) / [Phase 3](phase-03-capability-approval-sandbox-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:只固定 Runtime 表达“哪个 runtime/agent 正在哪个 repository/worktree/base 上操作”所需的数据,不创建、验证或清理任何 workspace/worktree。

前置:Phase 0 可先冻结纯 Workspace contract;event/reducer/projection slice 必须等待 Phase 1 Event Store fixture,因此 Phase 2 整体完成以 Phase 1 为前置。

计划文件:

- 补全现有 `src/runtime/protocol/v3/workspace.ts`,新增 `workspace-events.ts`,并按统一协议变更 allowlist 扩展 `event-catalog.ts`、`event-payloads.ts`、`events.ts`、`schemas.ts`、`state-transitions.ts` 与 fixture。
- 在 `src/runtime/session/` 中只增加 workspace event reducer/projection 数据,不引入 manager 或 filesystem/Git 依赖。
- 新增 `tests/runtime-v3/workspace-contracts/`。
- 不修改 `execution-env.ts`、`tool-context.ts`、stdlib tools、storage、CLI 或 TUI。

最小数据结构:

- `WorkspaceExecutionEnvelope`、`WorkspaceBindingRef`、`WorkspaceLeaseRef`。
- `WorkspaceValidationReceiptRef`、`WorkspaceCheckpointDescriptor`。
- `workspace.bound`、`workspace.validation_recorded`、`workspace.released`、`lease.*` 的穷尽 payload schema。
- `SessionWorkspaceProjection`,只保存当前 binding/lease/validation/checkpoint refs 与不可用原因。

契约任务:

- [ ] 固定 Workspace/Repository/Worktree/Lease ID、binding kind、canonical/effective cwd、branch/base/head 引用和 owner runtime identity。
- [ ] envelope 必须携带 session/agent/toolCall/trace、workspace/repository、cwd、lease revision 和 fencing token;序列化 schema 不接收缺失字段。
- [ ] validation receipt 区分 `valid/invalid/unavailable`,并绑定 envelope digest、validator identity 和时间;它不自行声称阻止了 TOCTOU。
- [ ] checkpoint descriptor 只表达 event cursor、base/head、status digest、snapshot Artifact ref 和 completeness,不实现 Git 采集、物化、rewind 或 cleanup。
- [ ] reducer 对 stale/revoked lease、无效 validation、binding 替换和 unknown event version 产生确定投影,不调用外部实现。
- [ ] 定义 `WorkspaceServicePort` 的 request/result 数据契约时只暴露 opaque adapter port,不在 Runtime 提供 manager、lease store、path guard 或 broker 实现。

完成门槛:

- schema/type round-trip、golden fixture、unknown-version、missing-field、digest-binding 和 reducer replay 测试全绿。
- 架构测试证明 workspace contract 不 import Git、filesystem、`src/security/**` 或 `src/worktree/**`。
- fake adapter 能产生数据并驱动投影,但本阶段不宣称 path isolation、lease enforcement、worktree lifecycle 或安全 cleanup 已实现。

建议 PR:

1. `runtime: define workspace envelope and receipt contracts`
2. `runtime: project workspace references from v3 events`
