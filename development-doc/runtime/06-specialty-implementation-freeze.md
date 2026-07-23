# Runtime 外围专项实现冻结说明

> 文档属性:Runtime 实施边界说明,不是新的实施计划或专项完成声明
> 冻结时间:2026-07-23T21:49:44+08:00
> 冻结基线:`worktree/governed-agent-harness-runtime@81556acb16e2d4ba39e8fffeb0f4c5bdeccf40c7`
> Runtime 权威执行顺序:[`04-governed-agent-harness-runtime-plan.md` §12](04-governed-agent-harness-runtime-plan.md#12-最终严格执行计划)
> 问题与取证台账:[`05-remaining-stuff.md`](05-remaining-stuff.md)

## 1. 决策

### 1.1 Phase 5 合同窄解冻窗口

自`worktree/governed-agent-harness-runtime@72767ff`起,仅为 Resource Contract v2 协议迁移临时解冻 Phase 5 文档登记的精确 allowlist。owner 为`Codex /root`;RED commit为`cb83538`。本窗口已完成GREEN门禁并在当前refreeze commit重新冻结。实施只迁移`src/runtime/resources/**`及其现有 Extension 直接消费者,未新增 Extension CLI、TUI、installer、runner、store 或领域状态机。

新冻结基线:`cb83538 + 当前 Phase 5 GREEN/refreeze commit`;Resource v2 contract已完成,Extension specialty行为状态继续使用`implemented-frozen/partial-frozen/deferred-frozen`。Phase 6未显式解冻前,Plan/Model/Context/Compaction/Memory路径继续只读。

### 1.2 Phase 6 合同窄解冻窗口

自`worktree/governed-agent-harness-runtime@600ca84`起,仅为 Model Routing v2、Compaction recovery assessment和Plan/Context/Memory v1交叉证据临时解冻Phase 6文档登记的精确allowlist。owner为`Codex /root`;RED commit为`140b775`。本窗口已完成GREEN门禁并在当前refreeze commit重新冻结,未新增Plan/Context/Compaction/Memory用户行为、trigger、UI、store、provider或catalog数据。

新冻结基线:`140b775 + 当前 Phase 6 GREEN/refreeze commit`;状态为`Model Routing v2 + Compaction recovery contract completed; Plan/Context/Memory v1 frozen; specialty behavior frozen/unavailable`。Runtime-M1、W1-B、W1-J、W1-G与Runtime-M0继续保持未关闭。

从本冻结基线开始,以下三个专项域停止继续实现:

1. Plan / Model / Context / Compaction / Memory;
2. Plugin / MCP / Skill / Hooks;
3. Worktree / Sandbox / Permission,包括 Approval、Execution Gateway 和 enterprise security foundation。

“冻结”只表示当前代码、公开契约和已知缺口在本轮 Runtime 实施期间保持只读,不表示专项已经完成。未实现、部分实现和只在 fake/test seam 中成立的任务同样冻结;Runtime 不接管这些任务,不在其他目录复制替代实现,也不通过缩小验收语义把它们改写为完成。

后续只实施 `04` 中明确归 Runtime 所有的 Session、Artifact、Orchestrator、Verification、Agent/Supervisor、Control Plane、daemon、Activity/Telemetry、lifecycle 和 composition 工作。Runtime 可以消费冻结专项的公开类型、schema、port、adapter 和 receipt;冻结依赖不能满足 production gate 时,对应 feature 必须保持 `unsupported`、`deny` 或不 advertise。

## 2. 状态分类

本说明使用四种状态:

- `implemented-frozen`:当前目标分支已有行为与定向测试证据,但结论只覆盖表中写明的窄边界;
- `partial-frozen`:已有模块或 production seam,完整生命周期、恢复、用户面或真实后端仍未闭合;
- `deferred-frozen`:当前只有 contract/foundation 或尚无实现,本轮明确不继续;
- `runtime-integration-dependency`:专项不再实现,Runtime 只允许在自己的 adapter/composition 路径消费现有公开面。

### 2.1 Plan / Model / Context / Compaction / Memory

| 分类 | 冻结内容 | 当前证据与边界 |
|---|---|---|
| `implemented-frozen` | Model Routing v2 manifest/router/profile/adapter-state/conversion receipt;ContextEngine、token estimator、固定层序与 receipt;Plan reducer、immutable artifact store、state store和 service 核心;Compaction cut/summarizer/validator/recovery assessor/reducer/transaction 核心;Memory store/index/search/proposal/approval/extraction/promotion 核心 | `src/runtime/{model-routing,modes/plan,context}/**`及对应 storage 已存在;本轮 16 files / 95 tests PASS |
| `partial-frozen` | production model request、Plan/Memory fragment、durable Plan projection、Compaction Artifact/projection recovery 和 production session composition | 已有 Runtime integration tests,但不等于 Plan approval/TUI、overflow safe-point、fork/rewind/model-switch 与完整 prompt lifecycle 已闭合 |
| `deferred-frozen` | Plan approval 用户面与 fresh-context handoff;`/compact`、auto/overflow compact、跨 checkpoint fork/rewind;独立 feature flags、完整 metrics/CLI/TUI;Memory 完整批准/revoke/外部漂移用户生命周期 | 保持专项计划中的未完成状态;Runtime 不补写第二套 planner、compactor 或 memory service |
| `runtime-integration-dependency` | catalog model adapter、governed request、production context provider/session runtime、controller/CLI/TUI 和内建 Plan/Memory 工具注册 | 只允许调用冻结的公开 API、校验 receipt并在不可用时 fail closed;不得修改冻结行为来迁就 Runtime |

### 2.2 Plugin / MCP / Skill / Hooks

| 分类 | 冻结内容 | 当前证据与边界 |
|---|---|---|
| `implemented-frozen` | M1 identity/path/digest/trust/state/snapshot;M3 Hook parser/runner/dispatcher及prepare->PreToolUse->reauthorize->execute->PostToolUse顺序核心;M4 MCP config/client/catalog/call/result normalization;M5 Plugin discovery/manifest/manager;公开 `runledger/extensions` surface | `src/extensions/**`和`tests/extensions/**`;本轮 12 files / 52 tests PASS |
| `partial-frozen` | M0 contract handoff/fixture账本;M2 Skill discovery/catalog/body resolver;M6 production factory/runtime、audit/resource/hook adapters与control-plane/TUI投影;watcher、MCP OAuth/resource/prompt、HTTP hook与部分 M7 能力 | Skill扫描仍缺计划要求的有界并发/明确深度上限;完整CLI管理面、canonical hook-start journal及M7 supply-chain验收未完成;模块存在不能提升为Extension-M2/M6/M7 complete |
| `deferred-frozen` | 完整 trust/plugin/skill/hook/mcp CLI;publisher/signature/revocation root;marketplace install/update/rollback;下载 staging/sandbox probe;完整 credential/login/logout 和生产 TUI 管理面 | 当前未完成项保持冻结,Runtime 不实现 extension manager、installer、client、runner 或 trust store |
| `runtime-integration-dependency` | Runtime resource ports、ToolRegistry、agent-loop/controller hooks、production composition、CLI/TUI projection | Runtime 只能消费当前 snapshot/catalog/lifecycle API;缺 Gateway、audit sink或 hook start journal时必须保持 blocked/deny |

### 2.3 Worktree / Sandbox / Permission

| 分类 | 冻结内容 | 当前证据与边界 |
|---|---|---|
| `implemented-frozen` | strict security config与 pure permission resolution;path/shell/policy/redaction核心;managed Worktree registry/lease/create/checkpoint/release/handoff/preview/GC窄行为;Runtime workspace/security contracts | `src/security/**`、`src/worktree/**`及定向测试;本轮 21 files / 119 tests PASS |
| `partial-frozen` | durable Approval terminal/CAS、Tool Gateway production seam、Sandbox backend plan、production Workspace binding/release、Worktree handoff/GC | pending prompt/waiter与 session grant仍有进程内状态;9个 legacy Runtime tool raw-I/O allowlist仍存在;Linux/macOS测试没有证明真实隔离子进程,Windows native sandbox未实现 |
| `deferred-frozen` | authority/channel-bound actor、public revoke、真实 process-tree authority、network proxy、Windows Job Object、持久 grants、managed identity/policy/credential、真实 remote/CI transport | enterprise 文件目前主要是注入式 port/foundation;不得由 Runtime agents、daemon或tools复制安全实现 |
| `runtime-integration-dependency` | Runtime Workspace/Gateway/Sandbox adapters、production state/composition、Agent/Verification/Control Plane consumers和CLI/TUI状态投影 | Runtime 只验证 identity/generation/receipt/no-bypass;专项能力不足时保持 feature unsupported,不能回退 AllowAll、shared cwd 或 unsandboxed |

## 3. 冻结路径

以下路径在 Runtime 剩余实施期间为只读。测试可以运行,不得为让 Runtime gate 通过而修改断言、fixture或实现:

### 3.1 Plan / Context / Compaction / Memory

- `src/runtime/model-routing/**`
- `src/runtime/modes/plan/**`
- `src/runtime/context/**`
- `src/runtime/tools/{plan-write,memory-search,memory-get,memory-propose}.ts`
- `src/storage/{context-paths,plan-artifact-store,plan-mode-state-store,compaction-projection-store,memory-store,memory-index,memory-extraction-lease}.ts`
- `tests/runtime-v3/{model-routing,modes/plan,context,plan-context-memory}/**`
- `tests/runtime-v3/contracts/{model-routing,plan-mode,context,compaction,memory}.test.ts`
- `tests/storage/{plan-mode-state-store,compaction-projection-store}.test.ts`

### 3.2 Plugin / MCP / Skill / Hooks

- `src/extensions/**`
- `src/storage/extension-node-storage.ts`
- `tests/extensions/**`
- `tests/fixtures/extensions/**`
- `package.json` 中 `./extensions` public export 的现有语义

### 3.3 Worktree / Sandbox / Permission

- `src/security/**`
- `src/worktree/**`
- `src/storage/{approval-event-reconciler,production-tool-gateway,security-runtime-state,worktree-node-adapter,worktree-production,worktree-state-adapter}.ts`
- `tests/security/**`
- `tests/worktree/**`
- `tests/storage/{approval-event-reconciler,approval-state-store.contract}.test.ts`

`src/runtime/protocol/v3/**` 中被三个专项消费的既有 schema/event/port 以本 commit 的版本和 fixture 固定。Runtime 可以在独立 L0 窗口新增与专项无关的 versioned contract,但不得在不解冻专项的情况下改变上述既有字段语义、放宽 guard或删除 failure discriminant。

### 3.4 共享 Runtime 接线面

以下文件不是专项独占冻结路径,因为后续 Runtime Wave 仍需修改;但其中已经存在的专项调用顺序、公开 port 和 fail-closed 语义按本基线固定:

- `src/runtime/{agent-loop,interactive-session-controller}.ts`
- `src/runtime/integration/**`
- `src/storage/production-interactive-runtime.ts`
- `src/cli/production-interactive-options.ts`
- `src/tui/interactive-mode.ts`
- Runtime/daemon composition roots

这些文件只在`04`的串行 join task中打开。修改必须保留 Hook 的 prepare/schema -> PreToolUse -> updatedInput重校验/重新授权 -> execute -> PostToolUse -> result budget 顺序,以及 Plan/Context/Memory、Extension snapshot和Workspace/Security receipt的identity/generation约束;同时复跑相应冻结专项测试。若需要改变专项语义,必须先解冻,不能把变化藏在共享接线文件中。

## 4. Runtime 允许与禁止的工作

### 4.1 允许

- 在 `src/runtime/session/**`、`artifacts/**`、`orchestrator/**`、`verification/**`、`agents/**`、`control-plane/**`、`activity/**`、`lifecycle/**` 修复 Runtime 自有状态机、durability、replay、budget和failure semantics;
- 在 `src/runtime/integration/**`、Runtime-owned storage/composition、`src/cli/**`、`src/tui/**`、`src/daemon/**` 连接冻结 port,前提是不改变专项语义;
- 新增 Runtime-owned adapter、projection、receipt validation、feature readiness和 `unsupported` 路径;
- 在 `tests/runtime-v3/**`、`tests/e2e/**` 增加消费方 contract/integration/fault tests;
- 只读运行冻结专项测试,把失败记录为外部依赖问题。

### 4.2 禁止

- 修改 §3 冻结路径或在 Runtime 目录复制等价 policy engine、trust store、extension manager、worktree registry、sandbox backend、planner、compactor或memory store;
- 为通过 Runtime E2E 而放宽专项 schema、删掉 deny/unsupported、注入 fake production receipt或修改专项测试预期;
- 完成专项计划中仍未勾选的 CLI/TUI、marketplace、publisher、approval recovery、真实 Sandbox、enterprise credential/remote、overflow/plan/memory lifecycle任务;
- 把“Runtime adapter能够调用”写成“专项能力已完成”,或把 test-injected/fake seam advertise为 production feature。

## 5. Runtime 执行时的依赖处理

每个 Runtime Wave 先生成冻结依赖 readiness 表:

| 检查 | ready 条件 | 不满足时 |
|---|---|---|
| API | 当前 commit 的公开 export、schemaVersion、fixture和adapter identity一致 | Runtime task保持blocked或实现显式unsupported;不改专项 |
| Receipt | authority/tenant/session/workspace/resource/generation可关联且durable | 拒绝激活;不得制造缺失receipt |
| Enforcement | Gateway/Sandbox/Worktree/Extension port返回可验证的真实结果 | production feature不advertise;不得回退 |
| Recovery | restart后能从专项公开存储/port读回唯一结果 | 标记external dependency;Runtime只保留quarantine/reconcile入口 |
| Test | 冻结专项定向测试仍通过 | 停止相关join,记录首次失败commit和命令 |

专项缺口不会阻止无关 Runtime lane继续,但会阻止依赖它的 production capability和 Runtime-M1–M4产品声明。`04` 的 Runtime-only Wave可以在 fail-closed/unsupported 语义下完成;完整里程碑仍保持未关闭。

## 6. 冻结验证基线

本轮实际执行:

```bash
npx vitest run tests/runtime-v3/contracts/model-routing.test.ts tests/runtime-v3/contracts/plan-mode.test.ts tests/runtime-v3/contracts/context.test.ts tests/runtime-v3/contracts/compaction.test.ts tests/runtime-v3/contracts/memory.test.ts tests/runtime-v3/model-routing tests/runtime-v3/modes/plan tests/runtime-v3/context tests/runtime-v3/integration/governed-model-request.test.ts tests/runtime-v3/integration/production-session-runtime.test.ts tests/runtime-v3/integration/production-interactive-runtime.test.ts tests/storage/plan-mode-state-store.test.ts tests/storage/compaction-projection-store.test.ts
# PASS:16 files / 95 tests

npx vitest run tests/extensions
# PASS:12 files / 52 tests

npx vitest run tests/security tests/worktree
# PASS:21 files / 119 tests
```

这些结果证明冻结基线在上述范围内可执行,不证明专项计划整体完成。当前完整仓库基线为`npm run check`、`npm run build`、`git diff --check` PASS;`npm test`为272 files / 1766 tests PASS,另有1个opt-in live test默认跳过;pi-ai audit为164/164 source、72 catalog PASS。

## 7. 解冻流程

只有用户明确要求恢复某个专项时才能解冻。解冻必须按以下顺序执行:

1. 暂停所有消费该 contract 的 Runtime lane;
2. 在对应专项权威计划中列出要恢复的精确任务、owner、worktree和允许路径;
3. 以新的独立 commit修改专项实现、versioned contract、fixture和专项测试;
4. 复跑专项门禁与所有 Runtime consumer tests;
5. 在本文件追加新的冻结 commit、状态差异和兼容说明;
6. 所有 Runtime lane统一 rebase 后才能恢复 join。

没有完成以上流程时,任何专项路径改动都视为越界,不得进入 Runtime implementation commit。

## 8. Phase 7/8 Runtime-owned join 复核（2026-07-24）

本轮只在 Runtime-owned Orchestrator、Verification、integration、additive control-journal schema和对应consumer tests中实现。§3 三个专项实现路径零diff;专项门禁仍为:

- Plan/Context/Memory:16 files / 95 tests PASS;
- Extension:12 files / 52 tests PASS;
- Security/Worktree:21 files / 119 tests PASS。

Runtime composition现在生成 `RuntimeDependencyReadinessReceipt`;它不会把本文件中的`partial-frozen/deferred-frozen`改成ready:

| scope | 当前production状态 | completion影响 |
|---|---|---|
| Plan/Context/Memory | `external_gap` | 不advertise |
| Resources/Extensions | `external_gap` | 不advertise |
| Workspace/Security | `external_gap` | 不advertise |
| Verification core | `ready`（真实production Artifact/admission/keyring composition时） | 仍受其他required scope约束 |
| Browser backend | `external_gap`（无真实production backend） | Browser gate与completion不advertise |
| Episode seal | `ready`（durable resolver + trusted OS-keyring issuer时） | 仍受其他required scope约束 |

因此 W2-G 可按“Runtime-owned integration完成且fail closed”关闭,但Runtime-M1和完整Phase 8产品声明继续被真实Browser与三个冻结专项readiness阻塞。该段记录的是W2检查点；后续Phase 11候选diff已增加Runtime-owned ChangeProposal/HumanGate durability与adapter seam,但在真实credential/forge/organization adapters缺失时production feature仍为`behavior unavailable`且不advertise。

## 9. Phase 11 Runtime-owned W4与W5 Linux复核（2026-07-24）

Phase 11候选diff基于`worktree/governed-agent-harness-runtime@7865763`,commit为`pending user authorization`。本轮没有解冻或修改§3列出的专项行为路径,也没有修改`package-lock.json`:

- Plan/Context/Memory:16 files / 95 tests PASS;
- Extension:12 files / 52 tests PASS;
- Security/Worktree:21 files / 119 tests PASS;
- `git diff -- src/security src/extensions package-lock.json`为空；PCM冻结行为allowlist也为零diff。

Runtime新增的remote authority/handoff、telemetry spool/CostTraceV2、reference graph/GC journal和ChangeProposal/HumanGate repository只消费专项公开port与receipt。composition保持以下边界:

| scope | Runtime-owned状态 | 冻结依赖状态 |
|---|---|---|
| Remote executor/handoff | durable request/effect/terminal/reconciliation和target/source fencing completed | CI/SSH/relay transport、credential、attestor、Sandbox/egress为`external_gap`;不advertise、不本地fallback |
| Telemetry/export | durable spool、sink receipt correlation、event-ack repair和health failure completed | managed policy、真实sink identity/organization deployment由外部adapter提供 |
| ChangeProposal/Draft PR | repository/projection、Draft-only effect journal与Control Plane adapter completed | credential broker和forge provider为`external_gap`;缺失时不advertise |
| HumanGate | durable request/decision/reconciliation与separation validation completed | organization/managed-policy coordinator为`external_gap`;Runtime不执行merge/deploy |
| GC external cleanup | canonical reference graph与Runtime GC journal completed | Workspace/Approval/process cleanup只接受专项真实receipt,不由Runtime伪造 |

唯一fault manifest包含22条记录；Linux按21条去重`exactCommand`逐项PASS,Harness Regression为12 files / 65 tests。由于darwin/win32没有runner或production preflight结果,W5-J2、W5-G、W6-G保持pending。上述Runtime完成状态不提升任何`partial-frozen/deferred-frozen`专项,也不关闭完整Runtime-M4产品声明。
