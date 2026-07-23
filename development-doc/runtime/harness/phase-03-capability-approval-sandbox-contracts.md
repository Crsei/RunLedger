# Phase 3:Capability、Approval 与 Sandbox 契约数据结构

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 2](phase-02-workspace-contracts.md) / [Phase 4](phase-04-artifact-episode.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:只固定 Runtime 记录和交换 permission/capability/approval/sandbox 状态的数据,不评估策略、询问用户、注入凭据或执行工具。

前置:Phase 2。

计划文件:

- 补全现有 `src/runtime/protocol/v3/capability.ts`,新增 `security-events.ts`,并按统一协议变更 allowlist 扩展 `event-catalog.ts`、`event-payloads.ts`、`events.ts`、`schemas.ts`、`state-transitions.ts` 与 fixture。
- 在 `src/runtime/session/` 中只增加 approval/sandbox projection 数据。
- 新增 `tests/runtime-v3/security-contracts/`。
- 不新增 policy engine、approval store/coordinator、shell classifier、credential broker、gateway 或 sandbox backend,不修改 Tool/CLI/TUI 行为。

最小数据结构:

- `CapabilityName`、`CapabilityClaim`、`CapabilityRequestRef`、`CapabilityDecision`、`RateLimitReceiptRef`、`ToolInvocationRequest`。
- `ApprovalTicket`、`ApprovalReceiptRef`、`CredentialGrantRef`、`SandboxProfileRef`、`SandboxExecutionReceiptRef`。
- `permission.requested/decided/expired/revoked`、`capability.rate_limit_recorded`、`sandbox.resolved/execution_recorded`、`tool.authorized` 的穷尽 payload schema。
- `SessionSecurityProjection`,只保存 pending approval、最终 decision、policy/sandbox/receipt refs 与 degraded/unavailable 原因。

契约任务:

- [ ] 固定 capability 命名、request/arguments/workspace/policy digest 绑定和 `allow | ask | deny` 表达;不在 Runtime contract 内实现 `deny > ask > allow` 合并算法。
- [ ] closed resource taxonomy 至少区分 filesystem/network/process/credential/workspace/native tool/browser tool/instruction;Browser claim 的 constraints 必须分别表达 navigate、DOM read、script、download、upload、cookie/credential 与 network egress,未知 kind/operation fail closed。
- [ ] Capability request 绑定 authority/tenant/principal、nonce、issuedAt/expiry、key revision 与 authenticated channel/signature;本地同进程至少绑定受信 channel+event cursor,managed/remote 必须验证签名。receipt/reducer 可确定拒绝 replay、过期、撤销 key 和跨 tenant 请求。
- [ ] 定义独立于 BudgetGuard 的 Gateway rate-limit request/receipt,至少按 principal、capability、resource/host 与时间窗做 reserve/commit/refund/reject;具体原子 limiter 和策略由 Worktree/Sandbox/Permission 专项实现。
- [ ] ticket/receipt 表达 principal、scope、expiry、decision revision、revocation 和 receipt digest;不定义存储 CAS 或 prompt 生命周期。
- [ ] policy deny、user reject、cancel、follow-up replacement、channel failure 分别具有穷尽 terminal outcome 和状态转换;follow-up 只能创建新的 bounded input/queue item,不能把原 approval 标成 allowed,也不能把 channel failure 投影为普通 user deny。
- [ ] approval correlation 使用 authority/tenant/session/runtime generation/turn/toolCall/approval/request digest/decision revision 的复合绑定;只按 approvalId 查 waiter 不足以接受响应,stale、duplicate、cross-turn、replacement-generation response 必须有稳定 typed rejection。
- [ ] approval/自动预审 request 明确携带 bounded summary、original digest/ref 与 `evidenceComplete`/truncation 状态;证据被截断、缺失或 Artifact 不可解析时,terminal outcome 只能是 deny、cancel 或 transfer-to-human,不得产生 allow receipt。
- [ ] sandbox 数据明确分开 requested profile、resolved policy digest、backend identity、effective enforcement 和 degraded reason。
- [ ] event payload 只保存脱敏 request summary、digest 和 receipt ref,禁止 credential、env value、authorization header 或完整 secret-bearing command。
- [ ] `CapabilityGatewayPort` 的 request 必须携带输入 source/taint refs、目标 sink 与可选 declassification receipt;Gateway adapter 对 filesystem/shell/network/credential/publication sink 强制检查,Runtime 不能用摘要、模型改写或低优先级配置自动清除 taint。
- [ ] reducer 处理 duplicate decision、expiry、revoke、crash 后 pending 和 sandbox unavailable,不因 replay 重新执行决策或副作用。
- [ ] 定义 `CapabilityGatewayPort`、`ApprovalCoordinatorPort`、`SandboxExecutorPort` 的 opaque request/result/cancel 契约,但所有行为实现归专项计划。

完成门槛:

- schema/type round-trip、decision lifecycle、nonce/signature/channel binding、anti-replay、rate-limit receipt、expiry/revoke、truncated-evidence、redaction、unknown-version 和 replay projection 测试全绿。
- 架构测试证明 contract 不 import TUI、storage、process/fs/network 或任何具体 security backend。
- fake ports 可验证 Runtime 消费路径;本阶段完成不等于 least-privilege 默认、approval 可交互恢复、Gateway 无旁路、sandbox enforcement 或 credential isolation 已交付。

建议 PR:

1. `runtime: define capability approval and sandbox contracts`
2. `runtime: project security receipts from v3 events`
