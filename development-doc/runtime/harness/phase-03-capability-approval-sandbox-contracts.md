# Phase 3:Capability、Approval 与 Sandbox 契约数据结构

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 2](phase-02-workspace-contracts.md) / [Phase 4](phase-04-artifact-episode.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前验收状态:`contract completed; behavior unavailable`。Runtime-M0 仍受 W1-B、W1-J 与 W1-G 门禁约束。
> 当前实施基线:2026-07-24T00:40:37+08:00,`worktree/governed-agent-harness-runtime@a6416e086457db6bb3f438d9a3cab24fd9e953d1`。

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

| 闭合任务 | 状态 | 证据/缺口 |
|---|---|---|
| P3-C1 capability 与 decision | completed | exact schema + ask/allow/deny contract |
| P3-C2 resource taxonomy 与 Browser constraints | completed | closed kind/operation schema |
| P3-C3 authenticated request | completed | 2026-07-24T01:11:34+08:00 strict v2 + exact local current-head binding 定向与全量门禁通过 |
| P3-C4 Gateway rate limit | completed | reserve/commit/refund/reject request/receipt |
| P3-C5 ticket/receipt lifecycle | completed | scope/expiry/revision/revocation/digest binding |
| P3-C6 terminal outcomes | completed | deny/cancel/follow-up/channel failure 分离 |
| P3-C7 approval composite correlation | completed | 2026-07-24T00:40:37+08:00 补齐 reducer fail-closed 校验 |
| P3-C8 bounded approval evidence | completed | redacted bounded summary + original digest/Artifact ref |
| P3-C9 sandbox requested/resolved/effective | completed | degraded/unavailable reason 必填 |
| P3-C10 redacted event payload | completed | secret-bearing unknown fields fail closed |
| P3-C11 taint-aware Gateway port | completed | source/sink/declassification exact refs |
| P3-C12 deterministic reducer | completed | pending/duplicate/expiry/revoke/unavailable replay |
| P3-C13 opaque security ports | completed | Gateway/Approval/Sandbox request/result/cancel |

- [x] 固定 capability 命名、request/arguments/workspace/policy digest 绑定和 `allow | ask | deny` 表达;不在 Runtime contract 内实现 `deny > ask > allow` 合并算法。
- [x] closed resource taxonomy 至少区分 filesystem/network/process/credential/workspace/native tool/browser tool/instruction;Browser claim 的 constraints 必须分别表达 navigate、DOM read、script、download、upload、cookie/credential 与 network egress,未知 kind/operation fail closed。
- [x] Capability request 绑定 authority/tenant/principal、nonce、issuedAt/expiry、key revision 与 authenticated channel/signature;本地同进程至少绑定受信 channel+event cursor,managed/remote 必须验证签名。receipt/reducer 可确定拒绝 replay、过期、撤销 key 和跨 tenant 请求。
- [x] 定义独立于 BudgetGuard 的 Gateway rate-limit request/receipt,至少按 principal、capability、resource/host 与时间窗做 reserve/commit/refund/reject;具体原子 limiter 和策略由 Worktree/Sandbox/Permission 专项实现。
- [x] ticket/receipt 表达 principal、scope、expiry、decision revision、revocation 和 receipt digest;不定义存储 CAS 或 prompt 生命周期。
- [x] policy deny、user reject、cancel、follow-up replacement、channel failure 分别具有穷尽 terminal outcome 和状态转换;follow-up 只能创建新的 bounded input/queue item,不能把原 approval 标成 allowed,也不能把 channel failure 投影为普通 user deny。
- [x] approval correlation 使用 authority/tenant/session/runtime generation/turn/toolCall/approval/request digest/decision revision 的复合绑定;只按 approvalId 查 waiter 不足以接受响应,stale、duplicate、cross-turn、replacement-generation response 必须有稳定 typed rejection。
- [x] approval/自动预审 request 明确携带 bounded summary、original digest/ref 与 `evidenceComplete`/truncation 状态;证据被截断、缺失或 Artifact 不可解析时,terminal outcome 只能是 deny、cancel 或 transfer-to-human,不得产生 allow receipt。
- [x] sandbox 数据明确分开 requested profile、resolved policy digest、backend identity、effective enforcement 和 degraded reason。
- [x] event payload 只保存脱敏 request summary、digest 和 receipt ref,禁止 credential、env value、authorization header 或完整 secret-bearing command。
- [x] `CapabilityGatewayPort` 的 request 必须携带输入 source/taint refs、目标 sink 与可选 declassification receipt;Gateway adapter 对 filesystem/shell/network/credential/publication sink 强制检查,Runtime 不能用摘要、模型改写或低优先级配置自动清除 taint。
- [x] reducer 处理 duplicate decision、expiry、revoke、crash 后 pending 和 sandbox unavailable,不因 replay 重新执行决策或副作用。
- [x] 定义 `CapabilityGatewayPort`、`ApprovalCoordinatorPort`、`SandboxExecutorPort` 的 opaque request/result/cancel 契约,但所有行为实现归专项计划。

本轮实现:

- `P3-C7`:在`SessionSecurityProjection`持久化 request runtime identity/generation、turn 与 toolCall correlation;`SessionSecurityReducer`在所有 decided/expired/revoked terminal event 上复核 session/runtime generation/turn/toolCall,并在跨 turn 或 replacement-generation 响应上稳定返回`invalid_event`。相同 terminal receipt 的 duplicate replay 仍保持幂等。
- `P3-C3`:Capability Gateway request 升级为 exact `schemaVersion: 2`;unversioned、v1、future version、unknown field 均 fail closed。`local_process/local_socket`强制携带 session-scoped `EventCursor`,`signed_remote`保持 signing key/signature exact variant且不接受 local cursor。
- `CapabilityAuthenticationAdapter`通过受信`CapabilityEventCursorAuthorityPort`复核 local request 的 stream、sequence、eventId、eventHash 与当前 writer head 完全相等;stale/future/tampered/cross-session/empty-head均拒绝,authority异常返回`unavailable`。签名远端仍只调用`SignedCapabilityVerifierPort`。
- tool execution、interactive runtime、Verification runner 与 Browser provider 的生产 request factory 均从各自 composition root 的 session writer 取得同一 current head;scope 不匹配、head 未初始化或 authority 不可用时不生成可授权请求。
- golden fixture为`tests/runtime-v3/security-contracts/fixtures/capability-gateway-v2.json`;body digest=`97f405ad4472e65c7a9bad67592ec533a82e7e5143c30a7cd71cea4d9a7355f4`,fixture SHA-256=`ebe846c2e64658fff82a9059c809931ad352f28f026cd6e702b646addc1ab2bc`。

逐项闭合记录:

- `P3-C3`:实现基线`a6416e086457db6bb3f438d9a3cab24fd9e953d1` + 包含本文件的交付提交;命令`npx vitest run tests/runtime-v3/security-contracts tests/runtime-v3/phase-zero-contracts.test.ts tests/security/runtime-gateway.test.ts tests/runtime-v3/integration/production-tool-gateway.test.ts tests/runtime-v3/verification/runner-ports.test.ts tests/runtime-v3/verification/browser-provider.test.ts tests/e2e/governed-tool-execution.test.ts tests/e2e/browser-verification-federation.test.ts tests/runtime-v3/harness-regression/enterprise-boundary-attacks.test.ts`;结果`PASS,12 files / 101 tests`;fixture SHA-256=`ebe846c2e64658fff82a9059c809931ad352f28f026cd6e702b646addc1ab2bc`;Workspace fixture保持`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`;验证时间`2026-07-24T01:11:34+08:00`。

验证记录:

| gate | 结果 |
|---|---|
| `sha256sum tests/runtime-v3/security-contracts/fixtures/capability-gateway-v2.json tests/runtime-v3/workspace-contracts/fixtures/workspace-contract-v1.json` | PASS;Capability=`ebe846c2e64658fff82a9059c809931ad352f28f026cd6e702b646addc1ab2bc`;Workspace=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4` |
| `npx vitest run tests/runtime-v3/security-contracts tests/runtime-v3/phase-zero-contracts.test.ts` | PASS;5 files / 38 tests |
| P3-C3 expanded targeted gate | PASS;12 files / 101 tests |
| `npx vitest run tests/runtime-v3/session/event-store.contract.test.ts tests/runtime-v3/session/reducer.test.ts tests/runtime-v3/session/snapshot.test.ts tests/runtime-v3/session/recovery.test.ts` | PASS;4 files / 31 tests |
| `npx vitest run tests/security tests/worktree` | PASS;21 files / 119 tests;冻结专项只读复跑 |
| `npm run check` | PASS;TypeScript、runtime boundary v1、execution boundary |
| `npm test` | PASS;263 files / 1737 tests,另有1 file / 1 opt-in live test默认SKIP |
| `npm run build` | PASS |
| `git diff --check` | PASS |

完成门槛:

- schema/type round-trip、decision lifecycle、nonce/signature/channel binding、anti-replay、rate-limit receipt、expiry/revoke、truncated-evidence、redaction、unknown-version 和 replay projection 测试全绿。
- 架构测试证明 contract 不 import TUI、storage、process/fs/network 或任何具体 security backend。
- fake ports 可验证 Runtime 消费路径;本阶段完成不等于 least-privilege 默认、approval 可交互恢复、Gateway 无旁路、sandbox enforcement 或 credential isolation 已交付。

建议 PR:

1. `runtime: define capability approval and sandbox contracts`
2. `runtime: project security receipts from v3 events`
