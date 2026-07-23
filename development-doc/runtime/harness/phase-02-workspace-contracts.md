# Phase 2:Workspace Envelope、Receipt 与投影数据结构

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 1](phase-01-session-kernel-v3.md) / [Phase 3](phase-03-capability-approval-sandbox-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前验收状态:`contract completed; behavior unavailable`。Runtime-M0 仍受 W1-B、W1-J 与 W1-G 门禁约束。
> 证据审计基线:2026-07-24T00:25:21+08:00,`worktree/governed-agent-harness-runtime@a6416e086457db6bb3f438d9a3cab24fd9e953d1`。

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

| 闭合任务 | 状态 | 最近更新 |
|---|---|---|
| P2-C1 Workspace identity 与 binding | completed | 2026-07-24T00:17:16+08:00 定向验证通过 |
| P2-C2 exact execution envelope | completed | 2026-07-24T00:18:27+08:00 定向验证通过 |
| P2-C3 validation receipt correlation | completed | 2026-07-24T00:19:13+08:00 定向验证通过 |
| P2-C4 checkpoint descriptor | completed | 2026-07-24T00:19:56+08:00 定向验证通过 |
| P2-C5 fail-closed projection | completed | 2026-07-24T00:20:58+08:00 定向验证通过 |
| P2-C6 opaque WorkspaceServicePort | completed | 2026-07-24T00:22:21+08:00 定向验证通过 |

- [x] 固定 Workspace/Repository/Worktree/Lease ID、binding kind、canonical/effective cwd、branch/base/head 引用和 owner runtime identity。
- [x] envelope 必须携带 session/agent/toolCall/trace、workspace/repository、cwd、lease revision 和 fencing token;序列化 schema 不接收缺失字段。
- [x] validation receipt 区分 `valid/invalid/unavailable`,并绑定 envelope digest、validator identity 和时间;它不自行声称阻止了 TOCTOU。
- [x] checkpoint descriptor 只表达 event cursor、base/head、status digest、snapshot Artifact ref 和 completeness,不实现 Git 采集、物化、rewind 或 cleanup。
- [x] reducer 对 stale/revoked lease、无效 validation、binding 替换和 unknown event version 产生确定投影,不调用外部实现。
- [x] 定义 `WorkspaceServicePort` 的 request/result 数据契约时只暴露 opaque adapter port,不在 Runtime 提供 manager、lease store、path guard 或 broker 实现。

逐项闭合记录:

- `P2-C1`:实现提交`65f905452195e034c99fa5ac560a7e23a822f052`、`004a252`、`9a3d8c8`;命令`npx vitest run tests/runtime-v3/phase-zero-contracts.test.ts tests/runtime-v3/workspace-contracts/contracts.test.ts -t "registered ID kind|unified Worktree ID|canonical/effective cwd"`;结果`PASS,2 files / 3 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`;验证时间`2026-07-24T00:17:16+08:00`。
- `P2-C2`:实现提交`004a252`;命令`npx vitest run tests/runtime-v3/workspace-contracts/contracts.test.ts -t "golden envelope|missing and unknown envelope fields"`;结果`PASS,1 file / 2 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`;验证时间`2026-07-24T00:18:27+08:00`。
- `P2-C3`:实现提交`004a252`;命令`npx vitest run tests/runtime-v3/workspace-contracts/contracts.test.ts tests/runtime-v3/workspace-contracts/projection.test.ts -t "validation outcomes|validation receipt|invalid validation digest"`;结果`PASS,2 files / 3 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`,不证明 TOCTOU 已被阻止;验证时间`2026-07-24T00:19:13+08:00`。
- `P2-C4`:实现提交`004a252`;命令`npx vitest run tests/runtime-v3/workspace-contracts/contracts.test.ts tests/runtime-v3/workspace-contracts/projection.test.ts tests/runtime-v3/workspace-contracts/architecture.test.ts -t "checkpoint completeness|release checkpoint|filesystem, Git"`;结果`PASS,3 files / 3 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`,未引入 Git 采集、物化、rewind 或 cleanup;验证时间`2026-07-24T00:19:56+08:00`。
- `P2-C5`:实现提交`004a252`;命令`npx vitest run tests/runtime-v3/workspace-contracts/projection.test.ts tests/runtime-v3/workspace-contracts/events.test.ts tests/runtime-v3/workspace-contracts/architecture.test.ts -t "stale and revoked|replaces a binding|invalid validation digest|future workspace event version|filesystem, Git"`;结果`PASS,3 files / 5 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`,reducer 保持纯函数且对`invalid/unavailable`validation fail closed;验证时间`2026-07-24T00:20:58+08:00`。
- `P2-C6`:实现提交`004a252`;命令`npx vitest run tests/runtime-v3/workspace-contracts/contracts.test.ts tests/runtime-v3/workspace-contracts/architecture.test.ts tests/runtime-v3/workspace-contracts/projection.test.ts -t "opaque exact request/result|opaque and behavior-free|fake adapter refs"`;结果`PASS,3 files / 3 tests`;fixture SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`;结论`contract completed; behavior unavailable`,未新增 manager、lease store、path guard 或 broker;验证时间`2026-07-24T00:22:21+08:00`。

### Phase 2 逐项闭合证据审计

实现提交:

- `65f905452195e034c99fa5ac560a7e23a822f052`:建立 Phase 0 Workspace/ID contract 边界。
- `004a252`:补全 Workspace exact schema、六类事件、纯 reducer/projection、fake port 与 4 个定向测试文件。
- `9a3d8c8`:把 Worktree ID 收敛到统一 Runtime ID registry,保持 `worktree_` 持久格式和兼容导出。

| 契约任务 | type/schema 证据 | event/reducer 证据 | test 证据 | 归属提交 |
|---|---|---|---|---|
| Workspace/Repository/Worktree/Lease identity、binding、cwd、branch/base/head、owner | `src/runtime/protocol/v3/{ids,workspace}.ts` | `workspace.bound`、`lease.acquired` | `contracts.test.ts` 的 golden round-trip 与 identity shape;`phase-zero-contracts.test.ts` 的统一 ID/scoped-key | `65f9054`、`004a252`、`9a3d8c8` |
| exact execution envelope | `WorkspaceExecutionEnvelopeSchema`要求 session/agent/toolCall/trace、workspace/repository、worktreePath/cwd、owner、lease revision 与 fencing token且拒绝额外字段 | `workspace.bound`只持久化 binding/lease refs与digest | `contracts.test.ts` missing/unknown-field、golden round-trip | `004a252` |
| validation receipt digest correlation | `WorkspaceValidationReceiptRefSchema`穷尽`valid/invalid/unavailable`;`isWorkspaceValidationReceiptForEnvelope`只校验scope与envelope digest | `workspace.validation_recorded`;reducer把invalid/unavailable/digest mismatch投影为不可用原因 | `contracts.test.ts`三种outcome与digest drift;`projection.test.ts` invalid/digest replay | `004a252` |
| checkpoint ref-only contract | `WorkspaceCheckpointDescriptorSchema`只含event cursor、base/head、status digest、可选Artifact ref与completeness | `workspace.bound/released`只记录descriptor;reducer只验证引用与保留checkpoint | `contracts.test.ts` completeness/Artifact exact schema;`projection.test.ts` release checkpoint | `004a252` |
| fail-closed deterministic projection | `SessionWorkspaceProjection`只保存binding/lease/validation/checkpoint refs与`unavailableReasons` | `workspace-reducer.ts`确定处理stale/revoked lease、binding replacement、invalid validation、unknown/future event | `events.test.ts` future version;`projection.test.ts` stale/revoked/replacement/unknown-version | `004a252` |
| opaque `WorkspaceServicePort` | `WorkspaceServiceRequest/ResultSchema`为versioned exact union;port只有`request(request, signal?)` | fake adapter结果经Phase 1 `MemoryEventStore`写入六类事件并重放projection | `architecture.test.ts`禁止filesystem/Git/security/worktree实现依赖;`contracts.test.ts` exact fake port;`projection.test.ts` fake adapter replay | `004a252` |

审计结论:

- 六类 canonical event 为`workspace.bound`、`workspace.validation_recorded`、`workspace.released`、`lease.acquired`、`lease.taken_over`、`lease.released`;catalog、payload schema与state transition共用统一 Runtime v3 registry。
- golden fixture为`tests/runtime-v3/workspace-contracts/fixtures/workspace-contract-v1.json`,SHA-256=`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`。
- contract只证明identity、schema、digest correlation、event replay与fail-closed projection。它不证明path isolation、lease enforcement、Git/worktree lifecycle、TOCTOU broker、rewind或安全cleanup。
- W1-A2、W1-A3 已完成;W1-B1、W1-B2、W1-J1、W1-J2 与 W1-G 仍为 pending。Phase 2 contract 的逐项闭合不改变这些状态,也不提前关闭 Runtime-M0。

验证记录:

| gate | 结果 |
|---|---|
| `sha256sum tests/runtime-v3/workspace-contracts/fixtures/workspace-contract-v1.json` | PASS;`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4` |
| `npx vitest run tests/runtime-v3/workspace-contracts tests/runtime-v3/phase-zero-contracts.test.ts` | PASS;5 files / 30 tests |
| `npx vitest run tests/runtime-v3/session/event-store.contract.test.ts tests/runtime-v3/session/reducer.test.ts tests/runtime-v3/session/snapshot.test.ts tests/runtime-v3/session/recovery.test.ts` | PASS;4 files / 31 tests |
| `npx vitest run tests/security tests/worktree` | PASS;21 files / 119 tests;冻结专项只读复跑 |
| `npm run check` | PASS;TypeScript、runtime boundary v1、execution boundary |
| `npm test` | PASS;263 files / 1737 tests,另有1 file / 1 opt-in live test默认SKIP;Phase 3 protocol revision 后重跑 |
| `npm run build` | PASS |
| `git diff --check` | PASS |

完成门槛:

- schema/type round-trip、golden fixture、unknown-version、missing-field、digest-binding 和 reducer replay 测试全绿。
- 架构测试证明 workspace contract 不 import Git、filesystem、`src/security/**` 或 `src/worktree/**`。
- fake adapter 能产生数据并驱动投影,但本阶段不宣称 path isolation、lease enforcement、worktree lifecycle 或安全 cleanup 已实现。

建议 PR:

1. `runtime: define workspace envelope and receipt contracts`
2. `runtime: project workspace references from v3 events`
