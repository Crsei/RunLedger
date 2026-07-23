# Phase 0:协议冻结、边界检查与测试骨架

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:无 / [Phase 1](phase-01-session-kernel-v3.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前执行状态:历史 contract/边界主体已由 `65f9054`、`004a252` 实现;2026-07-23 追溯审计发现统一 ID registry 漏列 Worktree,已由 `9a3d8c8` 补齐并验证。

目标:在修改行为前固定 v3 identity、schema、错误模型、模块依赖和兼容矩阵。

前置:无。

计划文件:

- 收敛现有 scaffold 并补全 `src/runtime/protocol/v3/{ids,event-catalog,event-payloads,events,schemas,errors,canonical-json,event-hash,state-transitions,coordination,taint,threat-model}.ts`。
- 补全 `src/runtime/identity/{types,local-principal}.ts`,提供可持久化的本地 authority/tenant/principal 基线。
- 补全 `src/runtime/runtime-features.ts`、`scripts/{check-runtime-boundaries,check-execution-boundaries}.ts`,并把两项边界检查接入 `npm run check`。
- 修改 `src/runtime/types.ts`、`src/storage/settings-manager.ts`、`src/index.ts`,仅暴露稳定入口。
- 补全 `tests/runtime-v3/{schema,canonical-json,module-boundaries,legacy-fixtures,phase-zero-contracts,reference-snapshots}.test.ts`、固定 canonical vectors 和真实 v1/v2 JSONL fixtures。

任务:

- [x] 定义所有公开实体的 branded ID、创建/解析与 scoped-key 规则,至少覆盖 Runtime/EventStream/Session/Goal/Turn/ModelRequest/QueueItem/Workspace/Repository/Worktree/Lease/Agent/ToolCall/Trace/Artifact/Approval/Event/Resource/Snapshot/Leaf/Plan/ContextRequest/MemoryProposal/InputSource/Declassification/Command/CompositionReceipt/RateLimit/EpisodeSeal/ChangeProposal/HumanGate。证据:E1、E2、E5、E7。
- [x] 从 Phase 0 起把 authorityId/tenantId 纳入所有主键/ref scope,把 principalId 纳入 actor-bearing event、签名和授权上下文;实现固定 local authority/tenant 与 OS-derived principal。证据:E1、E2、E5。此表述与主计划 §7 的“所有主键/ref 按 authority/tenant scope 组合”一致,不把可轮换 principal 错当 tenant 主键组成。
- [x] 定义 `InputSourceRef`、有界 `TaintLabel`、传播规则与 `DeclassificationReceiptRef`:Issue/PR/comment/webhook/web/MCP/repo instruction/candidate config 默认 tainted,去污必须绑定独立 policy/human decision、允许 sink、expiry 与 revision。证据:E2、E5。
- [x] 定义 RuntimeEventV3、typed error code、EventCursor、expected revision。证据:E1、E2、E5。
- [x] `RuntimeEventV3` 显式区分 `session` 与 `authority_tenant` stream scope,各自有独立 sequence/hash chain/cursor 和允许 event-type closed set;`EventCursor`、`DurableEventReceipt`、writer lease/epoch/fencing 全部绑定 branded streamId+scope。`subjectSessionId` 只允许作为 authority lifecycle payload/ref,不得替代 stream identity,也不得用全局 cursor 猜跨流顺序。证据:E2、E5。
- [x] 建立 Phase 0 基础事件的完整 catalog、逐事件 exact payload schema、允许状态转换和 unknown-event version fence,同时固定 event type -> allowed stream scope 映射;`session.handoff_*` 与 `session.deletion_*` 只允许 authority/tenant lifecycle stream。后续阶段增加领域事件时必须同 PR 扩展 catalog/schema/transition/fixture,正文使用的事件不得游离在 catalog 外。证据:E2、E5。
- [x] 写明本地/受管/远程三种 threat model,区分 chain integrity 与 signed attestation。证据:E2、E5。
- [x] 定义跨 Event Store/Lease/Artifact/Approval/Trust Store 的 intent-commit-reconcile 协议和 idempotency key。证据:E2、E5。
- [x] 为 schema 增加 unknown-field、unknown-version、oversized-payload fail-closed 测试。证据:E1、E2、E5。
- [x] 固定 canonical JSON 与 hash test vectors,包含 Unicode、key order、整数边界和换行。证据:E1、E2、E5。
- [x] 建立模块依赖规则:protocol 不依赖 storage/UI/provider;gateway 不依赖 TUI;projection 不反向写 canonical store。证据:E1、E2、E5。
- [x] 建立并测试 §6.1 的 feature-state × v1/v2/v3 × CLI action 矩阵和默认值,所有不允许组合返回稳定 typed diagnostic。证据:E2、E5。
- [x] 把四个外部参考仓库 snapshot 记录为计划证据,另记录 RunLedger 本地基线,不引入源码复制。证据:E2、E4、E5。
- [x] 对当前 HEAD 已存在的 v3/resource/model-plan-context/feature-flag scaffold 做追溯审计:记录引入 commit、实际路径、TODO/宽 guard、测试覆盖、未接入 `npm run check` 的脚本和相对本计划的缺口;这是 Phase 0 输入,不得倒推为历史 gate 已通过。证据:下方“追溯审计”与 E1–E5。
- [x] 在任何后续实现 PR 前,让 `runtime/00-reference.md`、本主计划、三份交叉专项 owner 计划与 `development-doc/00-index.md` 作为同一可追踪文档基线存在于目标分支;未跟踪文件或其他 worktree 中的副本不能作为已冻结 contract/owner 证据。证据:E4;目标分支当前 HEAD 可追溯到该 baseline。

## 追溯审计

| 范围 | 引入/收敛 commit | 当前实际路径 | guard/TODO 审计 | 当前测试与 gate |
|---|---|---|---|---|
| Phase 0 初始 contract | `65f9054` | `src/runtime/protocol/v3/{ids,events,schemas,errors,canonical-json}.ts`、`src/runtime/identity/**` | 当时仍是 scaffold;Worktree ID 留在 `workspace.ts`,未进入统一 registry | 初始 schema/canonical/legacy/boundary tests |
| 完整 v3 protocol baseline | `004a252` | `src/runtime/protocol/v3/{event-catalog,event-payloads,event-references,event-hash,state-transitions,coordination,taint,threat-model}.ts` | 当前无 `TODO`/`FIXME`;TypeBox `Check` 后的类型收窄 cast 和 `Object.fromEntries` catalog cast 由 exhaustiveness/exact-schema tests 约束 | `tests/runtime-v3/{schema,canonical-json,phase-zero-contracts}.test.ts` |
| Resource contract | `65f9054` 初始、`004a252` 收敛 | `src/runtime/resources/{types,schemas,ports,events,invocation-stream}.ts` | 当前无 `TODO`/`FIXME`;schema validator 中的 cast 均位于 exact `Check` 后 | `tests/runtime-v3/resource-contracts/**` |
| Model/Plan/Context/Memory contract | `65f9054` 初始、`004a252` 收敛 | `src/runtime/model-routing/**`、`src/runtime/modes/plan/**`、`src/runtime/context/**` | 当前无 `TODO`/`FIXME`;行为 owner 已按主计划冻结,Phase 0 只审计公共 contract | `tests/runtime-v3/contracts/**`、`tests/runtime-v3/plan-context-memory/**` |
| Feature/legacy matrix | `65f9054` 初始、`004a252` 收敛 | `src/runtime/runtime-features.ts`、`src/storage/settings-manager.ts`、`src/cli/v3-session-commands.ts` | 旧 boolean 明确映射 `default`;单调 highest-state 阻止回滚后重开旧写路径 | `tests/cli/session-feature-matrix.test.ts`、`tests/runtime-v3/legacy-fixtures.test.ts` |
| 静态边界 | `65f9054` 初始、`004a252` 收敛 | `scripts/{check-runtime-boundaries,check-execution-boundaries}.ts` | execution allowlist 精确到 legacy 文件;没有目录级豁免 | 两个脚本均由 `package.json` 的 `npm run check` 串行执行 |
| Worktree ID 漂移 | `9a3d8c8` | `src/runtime/protocol/v3/{ids,workspace}.ts` | 把 Worktree 收敛到统一 `RuntimeIdKind`；保持 `workspace.ts` 兼容导出与 `worktree_` 持久格式 | E5 定向测试已覆盖通用 ID/scoped-key、Workspace helper 与 public surface |

当前 HEAD 的 Phase 0 实现证据不能倒推为历史 I0–I7 串行 handoff 已完成;主计划 §0.0/§12 中相应最终验收仍保持开放。

## 证据账本

- E1:`65f905452195e034c99fa5ac560a7e23a822f052` (`runtime: freeze phase-zero contract boundaries`)。
- E2:`004a252` (`runtime: establish an auditable governed execution baseline`)。
- E3:`98ed74a` 当前目标分支 HEAD;后续事件扩展已留在同一 catalog/payload/schema/transition 体系内。
- E4:`60373d6` 把 `development-doc/00-index.md`、`runtime/00-reference.md`、本主计划和三份 owner 计划收敛到同一可追踪目标分支 baseline。
- E5:2026-07-23 当前工作区定向验证:`npm test -- tests/runtime-v3/schema.test.ts tests/runtime-v3/canonical-json.test.ts tests/runtime-v3/module-boundaries.test.ts tests/runtime-v3/legacy-fixtures.test.ts tests/runtime-v3/phase-zero-contracts.test.ts tests/runtime-v3/reference-snapshots.test.ts tests/cli/session-feature-matrix.test.ts tests/runtime-v3/workspace-contracts/contracts.test.ts tests/runtime-v3/public-surface/public-surface.test.ts` -> 9 files / 48 tests PASS;`git diff --check` PASS。
- E6:2026-07-23 当前工作区完整验证:`npm run check` PASS,两条 boundary script 均由项目入口执行;`npm test` -> 261 files / 1703 tests PASS,1 个 opt-in live test SKIP;`npm run build`、`git diff --check` PASS。
- E7:`9a3d8c8` (`runtime: prevent worktree identity contract drift`)。

迁移/回滚:本阶段不写 v3 数据;`sessionV3=off` 只按 §6.1 保留当前 v2 行为,不能据此续写已经产生的 v3 session,也不改变 v1 只读边界。

验证:

- `npm run check`
- `npm test -- tests/runtime-v3/schema.test.ts tests/runtime-v3/canonical-json.test.ts tests/runtime-v3/module-boundaries.test.ts tests/runtime-v3/legacy-fixtures.test.ts tests/runtime-v3/phase-zero-contracts.test.ts tests/runtime-v3/reference-snapshots.test.ts tests/cli/session-feature-matrix.test.ts`
- `git diff --check`

完成门槛:

- schema 与 hash vectors 在 Linux/Windows 路径样本上稳定。
- 未知版本或破坏性字段不会被宽松 cast。
- 现有 v1/v2 fixture 读取结果不变。

建议 PR:

1. `runtime: freeze governed v3 protocol contracts`
2. `runtime: add architecture and compatibility contract tests`
