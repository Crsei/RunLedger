# Governed Agent Harness Runtime 剩余事项与取证问题

> 文档状态:open issues / handoff ledger,不是第二份实施计划或完成状态真源
> 取证时间:2026-07-22；收敛复核:2026-07-23T01:01:02+08:00；governed startup 复核:2026-07-23T02:12:47+08:00；durability hardening 复核:2026-07-23T03:27:40+08:00；continuous mutation 复核:2026-07-23T04:31:28+08:00；Approval active dependency 复核:2026-07-23T06:32:57+08:00；child launcher gate 复核:2026-07-23T07:09:46+08:00；active-parent composition 复核:2026-07-23T07:58:47+08:00；child terminal cleanup 复核:2026-07-23T10:23:15+08:00；cancel evidence 复核:2026-07-23T11:18:41+08:00；durable Workspace release 复核:2026-07-23T12:55:47+08:00；child runtime authority sidecar 复核:2026-07-23T14:07:08+08:00；pre-resident authority integration 复核:2026-07-23T18:47:00+08:00；post-graph child execution 复核:2026-07-23T20:12:26+08:00
> current-HEAD 实现复核:2026-07-23T20:55:13+08:00；`81556acb16e2d4ba39e8fffeb0f4c5bdeccf40c7`
> 目标 worktree:`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-governed-runtime`
> 分支:`worktree/governed-agent-harness-runtime`
> 基线 commit:`65f905452195e034c99fa5ac560a7e23a822f052`
> 本轮实现检查点 commit:`004a2521934be745e8887f40f2b2631c392829dd`
> governed startup 切片 commit:`830a7232c0aec570917fc55c69145cce45fa31ab`
> production durability hardening commit:`2ca6f30b834410023ee77831c79d98714b11c103`
> continuous Workspace mutation gate commit:`ac524f42ea2033ac3aa1b8fd95aac654e372e68c`
> Approval active dependency commit:`f3e2ba6da4feb9af40889dab2e58ca7e1d604b01`
> child-spawn launcher gate commit:`7e6f7714bd145fdbd88beb9df91511e65f1d9e73`
> active-parent Agent composition commit:`b175b84d92c3647954257379cce792d303a16967`
> child terminal cleanup saga commit:`33b58ed434333e0d00b0132f8265da14f03719c4`
> cancel reason evidence commit:`c0ade82bdce42427303dc38d9c11f384710cd39e`
> durable Workspace release authority commit:`10f29082e7057698747757fedf287cc3db3ca269`
> child runtime authority sidecar commit:`eea7b67b58da05d9687c9d5cf4e3a2da688c5793`
> child runtime authority integration commit:`93d9226d817b4a24873252c542944aebeaa9b1a7`
> child operation budget commit:`754b9033a96d48d2cfa2b627cc89411b7638092b`
> headless child prepare/activate commit:`bb533d32aed1eeaf491b6b0f4763bb11a6c14070`
> post-graph child execution/E2E commit:`e741c884cc19a7eac2dc70747b06004db1540888`
> 权威计划:[`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md)
> 外围专项冻结说明:[`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md)

本文件只记录本轮参考审查、计划审计和实现 worktree 检查中遇到的问题、未完成项与恢复顺序。任何条目都不能因为“已有文件”“定向测试曾通过”或“代码量较大”而视为完成。完成状态必须回写到同步后的 `04`，并附目标分支 commit、定向测试、完整门禁和专项联合证据。三个外围专项从`81556ac`起冻结;其未完成项保留为external gap,不再进入Runtime实现队列。

## 1. 当前快照与验证结论

### 1.1 权威计划已去分叉

2026-07-22 发现的 1605 行旧版与 2124 行新版分叉已经收敛。在 `60373d6` 文档基线，目标 worktree 与主 checkout 的 `04` 均为 2124 行，SHA-256 都是 `192ba4b187e1321511db297deeaf9bad10bb7077489c6471e39d0fcd8b2b5ccd`，内容逐字相同。此后目标分支按 `830a723`、`2ca6f30`、`ac524f4`、`f3e2ba6`、`7e6f771`、`b175b84`、`33b58ed`、`c0ade82`、`10f2908`、`eea7b67`、`93d9226`、`754b903`、`bb533d3`、`e741c88` 的真实实现追加 scoped evidence，主 checkout 仍停留在 2124 行基线且保持干净；这是未合并分支上的可追踪证据增量，不是重新出现两份互相竞争的计划。

- [x] 以 2124 行版本作为唯一 canonical 文件，保留新增证据规则、I0-I7 串行账本、兼容矩阵和 13 类 mutation restart 要求。
- [x] 没有迁移旧版 147 个无完整证据的勾选；当前 `04` 有 343 个真实未勾选任务，唯一 `[x]` 位于 §9.2 模板示例，不是完成声明。
- [x] `00-reference.md`、`04`、三份专项 owner 计划与 `development-doc/00-index.md` 由本文件所在文档提交落入当前目标分支；实现证据固定到 `004a2521934be745e8887f40f2b2631c392829dd`。
- [x] `00-reference.md` 的双 hash 已解释：主 checkout 原始文件为 22810 bytes、838 个 LF、末尾无 LF，目标 worktree 只补终止 LF而成为 839 个 LF；原始字节范围逐字相同，不是设计内容漂移。

### 1.2 本轮整体检查点的边界

用户已明确要求提交当前所有更新，因此本轮会在完整验证、显式路径审阅和凭据扫描后形成一个整体实现检查点；这不等于把 `04` 的 I0-I7 owner/handoff 历史补齐，也不允许机械勾选 343 个任务。

- pre-stage `git status --porcelain` 有 290 条记录，覆盖 Runtime、Workspace/Security、Extension、Plan/Context/Memory、Verification、Control Plane、Daemon、Telemetry、Provider parity 及对应测试/文档。
- 最大未跟踪文件约 224 KiB，没有异常二进制或大体积运行产物；私钥/API token 模式只命中三个明确的 redaction/invalid-input 测试假值。
- legacy `v1-basic.json`/`v2-basic.json` 删除并替换为真实 `.jsonl` fixture 是预期迁移，`tests/runtime-v3/session` 17 files / 125 tests 已证明生产 reader、只读兼容和 canonical stream 行为。
- 提交仍禁止 `git add -A`、`git add .`、`git commit -a`、stash、hard reset；删除路径单独 `git add -u`，源码、测试和文档按显式路径组暂存。

### 1.3 当前验证状态

2026-07-23 收敛后实跑结果:

| 命令 | 结果 | 说明 |
|---|---|---|
| implementation checkpoint | PASS | `004a2521934be745e8887f40f2b2631c392829dd`；638 files，144196 insertions / 1339 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary 和 execution boundary 全部通过 |
| `npm test` | PASS | 231 files，1299/1299 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，52/52 tests passed；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 当前 diff 无 whitespace error |
| pi-ai focused + snapshot audit | PASS | provider tests 2 files / 14 tests；固定 `pi@3f1762c...` 审计 164/164 source files、72 catalog files |

修复前的 `/tmp/runledger-governed-vitest-current.json` 曾记录 1286/1299、13 个失败，只是故障暴露快照，不再代表当前状态。最后五个失败文件均已定向关闭：Control Plane/daemon/core attack 联合 25 files / 173 tests、orchestrator session journal 6/6、enterprise boundary 4/4。

### 1.4 Governed startup 切片验证

`830a7232c0aec570917fc55c69145cce45fa31ab` 已作为独立实现提交落入目标分支；它不替换 §1.3 的整体检查点，也不关闭 Phase 11。

| 命令 | 结果 | 说明 |
|---|---|---|
| governed startup targeted | PASS | 8 files，65/65 tests；覆盖 lifecycle、durable auditor、CLI、factory、daemon 与 cleanup |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 237 files，1351/1351 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，52/52 tests；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 实现提交前 diff 与提交后文档 diff 均无 whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |

### 1.5 Production durability hardening 验证

`2ca6f30b834410023ee77831c79d98714b11c103` 已作为独立代码/测试提交落入目标分支，关闭标准入口 state-root 接线、canonical Approval projection 和 governed open/CLI/factory cleanup failure 丢失；Phase 11 与最终验收仍保持未完成。

| 命令 | 结果 | 说明 |
|---|---|---|
| durability targeted | PASS | 14 files，96/96 tests；覆盖 CLI/daemon durable root、exact、stale/revoked Workspace、expired Approval、missing Workspace、root identity、Approval projection 与 cleanup faults |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 243 files，1391/1391 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，52/52 tests；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 代码提交前与当前文档 diff 均无 whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |
| live DeepSeek smoke | PASS | one-off `deepseek-v4-pro` tool loop：4 messages、59 events、12 ledger entries、1 tool call、1 tool result；不是 governed/Verification 全生命周期 E2E |

### 1.6 Continuous Workspace mutation gate 验证

`ac524f42ea2033ac3aa1b8fd95aac654e372e68c` 已作为独立代码/测试提交落入目标分支，完整门禁也已按本切片重新执行；这里只关闭 Workspace 持续复检边界，不提升 Phase 11、Approval 或最终验收状态。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| production Workspace red test | RED | `production-interactive-runtime.test.ts` 初次 4 tests 中 2 failed：canonical `workspace.bound=[]`、`workspace.released=[]` |
| mutation gate red test | RED | `continuous-mutation-gate.test.ts` 与 `mutation-gate-adapters.test.ts` 初次因 `src/runtime/lifecycle/mutation-gate.ts` 不存在而 0 tests collected |
| continuous mutation targeted | PASS | 8 files，75/75 tests；覆盖 gate 核心、model/tool adapters、production bind/release/rebind、CLI provider ownership、factory start/resume/fork、daemon runtime 与 model request correlation |
| code commit | PASS | `ac524f42ea2033ac3aa1b8fd95aac654e372e68c`；20 条显式代码/测试路径，2266 insertions / 93 deletions |
| full gate | PASS | `npm run check`；`npm test` 245 files / 1424 tests；`npm run build`；Harness Regression 11 files / 52 tests；pi audit 164/164 upstream files + 72 catalog files；`git diff --check` |
| live DeepSeek recheck | PASS | 正常 `AuthStorage`/provider 路径的 one-off `deepseek-v4-pro` tool loop：4 messages、56 events、12 ledger entries、1 tool call、1 tool result、2 turn ends；不经过 governed state-root/mutation gate |

定向命令:

```bash
npx vitest run tests/runtime-v3/lifecycle/continuous-mutation-gate.test.ts tests/runtime-v3/lifecycle/mutation-gate-adapters.test.ts tests/runtime-v3/integration/production-interactive-runtime.test.ts tests/cli/production-interactive-options.test.ts tests/runtime-v3/control-plane/v3-session-adapters.test.ts tests/runtime-v3/control-plane/v3-session-startup-gate.test.ts tests/runtime-v3/orchestrator/daemon-agent-runtime.test.ts tests/runtime-v3/session/agent-loop-events.test.ts
```

### 1.7 Approval active dependency 与 durable start 验证

`f3e2ba6da4feb9af40889dab2e58ca7e1d604b01` 已作为独立代码/测试提交落入目标分支。本检查点只关闭 production Tool Gateway 的 interactive Approval active dependency、current-receipt fence、revision CAS、启动 reconciliation 和三阶段 durable tool start；它不把 pending prompt 恢复、所有 Gateway denial 审计、extension hook journal、child/idle/replacement、cleanup 或 Phase 11 标成完成。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| Approval/Gateway targeted | PASS | 16 files，176/176 tests；覆盖 request/terminal event、Memory/File CAS、revoke/expire、half-commit reconcile、authorize cache、start fence、attempt claim、wrapper close/callback 与真实 durable store 接线 |
| code commit | PASS | `f3e2ba6da4feb9af40889dab2e58ca7e1d604b01`；49 条显式源码/测试路径，4501 insertions / 349 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 249 files，1500/1500 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 提交前 staged diff 与提交后工作区均无 whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |
| live DeepSeek smoke | PASS | `AuthStorage -> builtinModels -> deepseek-v4-pro -> Agent -> echo -> MemoryLedger`：4 messages、65 events、12 ledger entries、1 tool call、1 tool result、2 turn ends；不是 governed/Verification 全生命周期 E2E |

已闭合的窄边界:

- interactive ask 在 prompt 前 mandatory-flush `permission.requested`，terminal store commit 后 mandatory-flush `permission.decided/expired/revoked`；receipt 绑定 subject 与独立 `decidedBy`、ticket/request/original input、revision、expiry 和 canonical digest。显式 cancel 以真实 caller actor 做 CAS；timeout、通道失败、revalidation drift、headless deny 和 startup expiry 使用稳定 system actor。
- `MemoryApprovalStateStore` 与 `FileApprovalStateStore` 共用 expected-revision CAS 规则并以 approval identity lock 串行 commit/current-grant operation；只允许 `allowed -> revoked | expired`，duplicate exact commit 幂等，binding/evidence/revision drift fail closed。
- production interactive composition 不再允许 provider 注入第二份 Approval store；startup auditor、reconciler 和 Tool Gateway 统一使用 canonical `<stateRoot>/tool-gateway/approvals` 真源。
- authorize cache、environment prepare 与 start 都复检 exact current allowed receipt；grant、`tool.authorized` 和 start identity 绑定 Approval receipt ID/digest/revision。`authorize -> start -> execute` 三阶段中，`start` 在同一 Approval fence 内完成 `sandbox.resolved/tool.authorized/tool.started` mandatory flush 与 attempt claim，`execute` 只消费 exact 一次性 start lease。
- startup reconciler 可补写 store-only terminal、拒绝 event-only/漂移状态，并把已到期 allowed receipt 以 revision CAS 转为 expired。真实 `tool.execute` 调用前的 attempt claim/read、callback、identity 与 no-start failure 全部 fail closed 为 uncertain 或 unavailable，工具副作用保持零调用；调用已经开始后的 settlement、terminal commit 或 completed read-back failure 返回不可继续的 uncertain，但工具副作用可能已经发生。

仍未闭合的 Approval/Gateway 边界:

- pending approval 的 prompt、revalidation closure 和 waiter 仍只存在进程内 `PendingApprovalRegistry`；重启能 reconcile 已有 store terminal，但不能重建并继续未决交互。
- `SYSTEM_APPROVAL_PRINCIPAL_ID` 仍是全局硬编码常量，未绑定 authority/deployment；交互 `PermissionPrompter.decidedBy` 依赖可信 adapter，自身没有 channel-bound identity proof。
- auth/replay/rate-limit/manifest/policy admission 自动拒绝发生在 interactive ticket 生命周期之前，不应伪造 `permission.requested/decided`；若要求 durable 审计，仍需独立 canonical capability/Gateway denial event 或 attempt receipt。
- extension hook 只有注入受信 `HookToolStartJournalPort` 才能走三阶段 Gateway；默认 production factory 当前 fail closed，尚无 session-owned canonical hook start journal 接线。
- Approval store/event 与 `tool.started`/attempt claim 是可 reconcile 的顺序写，不是跨存储原子事务；claim 后失败会永久 uncertain，尚无自动证明/补偿协议。
- 真实 file-store 活跃期 corruption、root/store TOCTOU、kill/restart 矩阵仍未覆盖；公开的 durable revoke 管理命令/Control Plane 也尚未接线。

### 1.8 child-spawn launcher gate 验证

`7e6f7714bd145fdbd88beb9df91511e65f1d9e73` 已作为独立代码/测试提交落入目标分支。本检查点只关闭 `ProductionChildSessionLauncher` production class seam：parent gate 在本地 request/delegation 校验后、cache/max-active/Workspace validation/claim/V3 create 前执行；它不建立真实 CLI/daemon/factory `AgentSupervisor` composition，也不把 Phase 9/11 或 Runtime-M2 标成完成。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| child gate targeted | PASS | 3 files，37/37 tests；launcher fault 10、continuous gate 26、production isolation E2E 1 |
| code commit | PASS | `7e6f7714bd145fdbd88beb9df91511e65f1d9e73`；3 files，569 insertions / 3 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 250 files，1510/1510 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 提交前 staged diff 与提交后工作区均无 whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |
| live DeepSeek smoke | PASS | `AuthStorage -> builtinModels -> deepseek-v4-pro -> Agent -> echo -> MemoryLedger`：4 messages、74 events、12 ledger entries、1 tool call、1 tool result、2 turn ends；不是 governed child/Verification E2E |

已闭合的 launcher seam:

- gate `!ok`、throw、pre-abort 与 gate 内 abort 统一为不可重试 `reference_unavailable`；invalid request/delegation 不访问 gate；idempotent cached launch 也不能绕过当前 parent receipt 复检。
- gate 拒绝时 launcher Workspace validation、launch claim、`V3SessionManager.create`、snapshot 与 launch/residency receipt 全部零调用/零产出。
- Workspace validation 期间 abort 不创建 claim；claim 创建进行中 abort 会在 V3 create 前尝试删除 claim，删除失败返回 typed cleanup uncertainty。
- durable create 期间 abort/close 不会把 child 注册回 launcher：实现尝试关闭新 manager并删除 claim，snapshot/launch receipt 不产生；两项 cleanup 都成功才返回显式 recovery，任一失败返回 cleanup uncertain。已落盘 JSONL genesis 保留，未被伪装成零 durable side effect。
- production isolation E2E 已验证 exact `child_spawn` correlation，但其 allow gate 是测试注入，不是 active parent runtime 的真实 continuous gate。

仍未闭合的 child/multi-agent 边界:

- 全仓 `ProductionChildSessionLauncher` 构造点仍只有两个测试 fixture；`src/**` 没有 production `AgentSupervisor`/launcher composition，也未证明 active parent runtime 持有的同一 canonical gate 被注入 child launcher。
- supervisor 在 launcher 之前已可能 durable 写 `agent.spawn_requested`、分配 Workspace、reserve budget，拒绝后还会记录失败、退款和 release；launcher fault 的“零调用”不能扩大成整个 supervisor spawn 零副作用。
- durable create 已开始后留下的、可能已关闭或 cleanup uncertain 的 child genesis 尚无自动 orphan reconciliation/terminal cleanup receipt；pre-create claim cleanup failure 也尚无 fault injection。child resume、isolated command、idle unload/reload 与 same-session replacement 仍未纳入同一生命周期。

### 1.9 Active-parent production Agent composition 验证

`b175b84d92c3647954257379cce792d303a16967` 已作为独立代码/测试提交落入目标分支。本检查点关闭 production interactive runtime 的 active-parent composition seam、root Workspace adoption/revalidation 和 child runtime owner correlation；它不激活 CLI/daemon/factory multi-agent，不建立真实 child Agent loop，也不把 Phase 9/11 或 Runtime-M2 标成完成。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| composition/agent targeted | PASS | 9 files，55/55 tests；覆盖 root register/revalidate/replay、source+readonly root、child gate/runtime owner、startup/close fault、production isolation 与 interactive composition |
| code commit | PASS | `b175b84d92c3647954257379cce792d303a16967`；18 条显式源码/测试路径，1062 insertions / 97 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 251 files，1520/1520 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest 再次完整执行 `npm run check` |
| `git diff --check` | PASS | 提交前 staged diff 与提交后工作区均无 whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |

已闭合的 composition 窄边界:

- `createProductionInteractiveRuntime({ agents })` 从 active parent 的同一个 manager、`options.mutationGate`、已验证 root Workspace、Artifact access 与 root BudgetGuard 构造 graph store、launcher 和 supervisor；caller 不能替换这三项内部 owner。
- root adoption exact join `WorktreeCreateResult` 的 record/binding/runtime binding/lease/fencing-token digest/receipt ID，并再次走 `WorktreeManager.validate()`；source、managed、readonly strategy/status 不再混淆。raw token/path 不进入 Agent graph 或公开 composition snapshot。
- canonical `agent.root_revalidated` 只允许同 scope、同 lease ID、严格递增 revision 与 exact grant 的 active/readonly root；stale、terminal、scope drift、digest mismatch fail closed，close/reopen 后 projection 可重放。
- child manager 的 `runtimeId` 与 Workspace `ownerRuntimeId` exact 相同；launcher close 不再在 close 成功前清空 registry，失败 child 可以重试。registration primary failure 与 launcher cleanup failure会同时保留，parent manager 不由低层 composition 关闭。
- interactive runtime 的返回面只保留 supervisor 与脱敏 child snapshots，不暴露 canonical gate、launcher 或 graph writer；feature evidence 继续不包含 `multi-agent`。

仍未闭合的 production multi-agent 边界:

- child launcher 仍只创建空的 durable `V3SessionManager`，没有 child controller、真实 model/tool governed runtime、Tool Gateway 或完整 Sandbox 执行链。现有 E2E 手工写 child worktree并构造 Artifact，不是 child Agent loop E2E。
- 此检查点当时存在的“semantic terminal 后仍 resident、cancel 只有裸 receipt”缺口，已由后续 `33b58ed434333e0d00b0132f8265da14f03719c4` 的进程驻留 cleanup saga关闭，详见 §1.10；该修正不包含 external success 后 crash cold replay、真实 child loop或跨进程 reconciler。
- `.launch-claim` 只有 schema/session，不能作为 authority-owned cold recovery claim；进程退出后的 child resume、orphan/quarantine reconciliation、terminal-only cleanup 与 kill/restart recovery 均缺失。
- CLI option provider、local daemon、factory 与 Control Plane 没有激活该 composition，也没有 machine-verifiable multi-agent feature/required-adapter row；因此 production multi-agent 仍必须保持 unsupported。
- resume/isolated command、idle unload/reload、same-session replacement 和 handoff/merge 的整个活跃期仍需连续 parent gate 与故障矩阵。`33b58ed` 已为 cancel 与 tracked isolated command/release race增加窄门禁，但 stop/close/cold outcome不确定时仍不得提前释放 Workspace或声称 cleanup complete。

### 1.10 Child terminal cleanup saga 验证

`33b58ed434333e0d00b0132f8265da14f03719c4` 已作为独立代码/测试提交落入目标分支。本检查点关闭 started child 在同一 active production composition 内从 semantic terminal 到 runtime/Workspace/Budget aggregate cleanup 的有序 seam，并修复 composition shutdown、V3 close lease 与 isolated-command/release 竞态；它不建立 authority-owned cold reconciler、真实 child Agent loop 或可 advertise 的 production multi-agent。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| cleanup/agent targeted | PASS | `npx vitest run tests/runtime-v3/agents tests/e2e/multi-agent-isolation.test.ts tests/runtime-v3/session/v3-session-manager.test.ts tests/runtime-v3/schema.test.ts tests/runtime-v3/reference-snapshots.test.ts tests/e2e/daemon-recovery.test.ts tests/runtime-v3/integration/production-interactive-runtime.test.ts`；19 files，139/139 tests |
| code commit | PASS | `33b58ed434333e0d00b0132f8265da14f03719c4`；31 条显式源码/测试路径，5333 insertions / 262 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 254 files，1570/1570 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest 再次执行完整 `npm run check` |
| `git diff --check` / credential-pattern scan | PASS | 代码提交前 diff 无 whitespace error；实现路径扫描只输出匹配文件名且无命中，未读取或输出 credential 正文 |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |

已闭合的 process-resident cleanup 窄边界:

- semantic terminal 与 cleanup aggregate 分离：`agent.stopped` 携带 exact terminal；`agent.cleanup_requested -> agent.runtime_released -> agent.workspace_released -> agent.budget_settled -> agent.cleanup_completed` 与 `agent.cleanup_reconciliation_required` 全部是 exact、mandatory-flush v3 event，可由 JSONL 重放。reducer 强制 terminal/request/receipt correlation与固定阶段顺序，不能在缺 receipt 或 uncertain marker 仍存在时伪造 completion。
- started child 的 `finish()` 与 terminal `interrupt()` 在任何 semantic/residency state mutation 前要求 exact usage；缺 usage时 graph、runtime、Workspace、Budget 零变化。`RootBudgetGuardAdapter` 对 started settlement同样 fail closed并返回 typed receipt。
- runtime-release receipt exact 绑定 launch receipt、当前 residency、runtime instance、writer-fence receipt、必填 final child session cursor及更高 revision 的 `nonresident` receipt。runtime release未确认时不调用 Workspace/Budget，Workspace release未确认时不调用 Budget。
- `cancel()` 不再走旧裸 `launcher.cancel()`，而是 durable `agent.stopped` 后进入同一 saga；terminal interrupt 使用刚持久化的 unavailable residency作为 release前件。
- 相同 request 的并发调用共享 operation promise；parent graph 在 external success 后一次 append失败时，同一进程可由 launcher/Workspace cache复用 exact receipt。fault tests覆盖 cleanup intent、runtime receipt、Workspace receipt、budget receipt四个 append点，最终外部执行各一次。
- composition `close()` 先 reconcile terminal child；仍有 active child时拒绝关闭，不伪造 usage、不直接关闭 resident manager，只有 launcher idle才关闭，父 manager不由子 composition接管。close失败可由 composition调用方重试。
- `V3SessionManager` 在 slow writer close 期间继续 heartbeat；writer close未确认前不 release lease。partial close或lease release失败后停止 heartbeat，TTL内阻止竞争 writer，30秒到期后由新 runtime以递增 writer epoch cold takeover；失败的原 manager不会自称 closed。
- isolated command在 operation注册、Workspace validation、TMPDIR建立和spawn前持续复检 release quarantine；release先 abort/drain tracked invocation再 stop/close。POSIX 使用独立 process group，Windows缺 Job Object时在构造和执行层均 fail closed。production supervisor ports 已改为 native `#ports`，不再能通过普通属性反射取得 adapter handles。
- 本阶段 `deepseek-v4-pro` 真实网络 smoke结果为 `messages=4 events=65 ledger=12 toolCalls=1 toolResults=1 turnEnds=2 finalRole=assistant`。链路只证明 `AuthStorage -> builtinModels -> models.streamSimple -> Agent -> echo -> MemoryLedger` 单 Agent连通性；没有 durable child session、governed mutation gate或 child controller，不是 multi-agent E2E。

仍未闭合的边界:

- process-local exact retry不等于完整 child crash recovery：`ProductionChildSessionLauncher` 的 runtime release operation/attempt/tombstone仍在内存，runtime close成功但parent graph相应event append/flush前进程退出时，restart无法重建exact runtime receipt。`ProductionAgentWorkspaceAdapter`/`WorktreeManager`的Workspace release缺口已由后续`10f2908`的durable journal、authority receipt与cold read-back关闭，详见§1.12；不能把该窄修正扩大成整个child cleanup exactly-once。
- `.launch-claim` 仍只有 `{ schemaVersion, sessionId }`，未绑定 authority/tenant/principal、parent graph、agent、launch request/receipt、runtime instance、Workspace/capability refs、revision/owner/expiry。没有 startup claim scan、takeover、orphan quarantine、terminal-only release reconciler，它不是 authority-owned cold claim。
- 本检查点时`launch_rejected`且无launch/residency的child仍被`reconcilePendingCleanups()`跳过；该缺口已由后续`10f2908`的`not_started` discriminated aggregate、Workspace/Budget ordered receipt与JSONL replay关闭，详见§1.12。
- composition close对 running child只会 fail closed；目前没有由 operator/shutdown coordinator提供 exact usage并创建 semantic terminal的协议。因此“不会裸关 active child”已闭合，“可治理 graceful shutdown active child”仍未完成。
- launcher在 `requestStop()` 前先把 attempt置为进程内 `stop_uncertain`；stop抛错或 final cursor不可得后，同一进程的 exact retry会持续返回 uncertain。没有 durable stop probe、cursor read-back、operator resolution或安全清除协议；进程退出又会同时丢失 latch与 resident registry。
- 本检查点时`agent.workspace_released`尚未绑定真实Worktree release receipt、released lease/retained record和release time；该缺口已由后续`10f2908`的`WorkspaceReleaseReceiptRef -> AgentWorkspaceReleaseReceiptRef -> agent.workspace_released`三层typed evidence关闭，详见§1.12。
- V3 TTL takeover只解决 writer fencing availability，不是 child cleanup reconciler。原 manager的 rejected close promise不重试，新 owner也不会自动关联 parent cleanup aggregate、child stop cursor、runtime-release/Workspace-release stage。
- launcher仍只创建空的 child `V3SessionManager`，没有 child controller、model/tool loop、Tool Gateway、完整 Sandbox与真实 usage collector；现有 E2E手工修改 child worktree并构造 Artifact。CLI/daemon/factory与 feature requirements matrix没有激活 multi-agent，production必须继续 `unsupported`。
- POSIX `detached` process group不能阻止 descendant通过 `setsid`/double-fork脱离 PGID；完整进程树约束需要真实 Sandbox、cgroup/PID namespace，Windows则需要 Job Object。当前 group-kill 对全部错误都回退 direct child PID，尚未区分 `ESRCH` 与权限/其他非 `ESRCH` failure；后一类应保持 uncertain/quarantine，现状不能作为完整 tree-isolation authority evidence。

### 1.11 Cancel reason evidence 持久绑定验证

`c0ade82bdce42427303dc38d9c11f384710cd39e` 已作为独立代码/测试提交落入目标分支。本检查点只关闭 parent `AgentSupervisor.cancel()` 丢弃 caller reason evidence 的窄缺口：digest进入 semantic terminal canonical identity并由JSONL restart恢复，cleanup通过同一个`terminalDigest`关联；它不把所有cancelled terminal改成必填evidence，也不关闭cold cleanup或真实child runtime。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| cancel evidence RED | RED | 先加入`cleanup-saga.test.ts`与`session-graph-store.test.ts`，旧实现21 tests中3 failed：terminal缺evidence、changed digest被当成相同请求、restart丢evidence |
| cancel evidence targeted | PASS | `npx vitest run tests/runtime-v3/agents/cleanup-saga.test.ts tests/runtime-v3/agents/graph-store.test.ts tests/runtime-v3/agents/session-graph-store.test.ts tests/runtime-v3/schema.test.ts tests/runtime-v3/agents/supervisor.test.ts`；5 files，60/60 tests |
| code commit | PASS | `c0ade82bdce42427303dc38d9c11f384710cd39e`；8条显式源码/测试路径，251 insertions / 13 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary全部通过 |
| `npm test` first run | RED | 新增session replay test与既有`multi-agent-isolation` test分别命中默认5秒timeout；不是全绿证据 |
| timeout recheck / `npm test` | PASS | 只为新增session test设置15秒显式timeout；相关2-file定向复核通过，完整复跑254 files，1574/1574 tests passed |
| `npm run build` | PASS | NodeNext production build成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest再次执行完整`npm run check` |
| pi-ai fixed snapshot audit | PASS | 首次漏必填参数exit 2；随后固定`pi@3f1762c...`重跑，164/164 source files、72 catalog files |
| credential filename-only scan | PASS | 无匹配；首次复杂regex因shell quoting失败，随后使用简化、只输出文件名的安全模式，未读取或输出credential正文 |

已闭合的窄边界:

- `AgentSupervisor.cancel()` 要求合法`reasonEvidenceDigest`，并将其写入terminal request body、`requestDigest`、`terminalDigest`和exact `agent.stopped.terminal`；cleanup aggregate通过exact `terminalDigest`间接绑定同一evidence。
- 相同command/idempotency key/evidence retry保持幂等；changed evidence返回`idempotency_conflict`，不会覆盖durable terminal或重跑runtime/Workspace/Budget release。
- v3 exact schema、graph reducer与`SessionAgentGraphStore` close/reopen保留同一evidence和cleanup terminal correlation，不再依赖进程内参数。

仍未闭合的边界:

- shared `AgentTerminalRequest`与event schema为读取既有事件继续允许optional evidence；直接`finish({ outcome: "stopped", reason: "cancelled" })`、terminal `interrupt("cancelled")`与legacy terminal不由本切片强制提供独立reason evidence。因此本检查点不能写成“全部cancelled terminal已绑定理由”。
- digest只是opaque bounded ref，不证明raw reason、caller/actor authority、issuer/signature、证据存储或外部可解析性。
- `launch_rejected` aggregate与真实Workspace release evidence已由后续`10f2908`关闭；`stop_uncertain` durable resolution、authority-owned child launch claim/reconciler、runtime release cold read-back、child controller/model/tool loop与production multi-agent activation继续未完成。
- 本检查点没有运行或虚构governed DeepSeek child E2E；§1.10已有smoke只证明单Agent`AuthStorage -> builtinModels -> Agent -> echo -> MemoryLedger`连通性。

### 1.12 Durable Workspace release authority 与 launch-rejected aggregate 验证

`10f29082e7057698747757fedf287cc3db3ca269`已作为独立代码/测试提交落入目标分支。本检查点只关闭Worktree/Agent Workspace release的durable authority evidence与`launch_rejected`的`not_started` aggregate；它不关闭child runtime release cold read-back、authority-owned launch claim/reconciler、真实child runtime、Phase 9/11或production multi-agent。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| cleanup aggregate RED | RED | `cleanup-saga.test.ts`旧实现初次27 tests中7 failed；原not-started compensation没有canonical aggregate、ordered failure recovery或restart replay |
| cleanup/release targeted | PASS | 变更涉及的9个test files，85/85 tests；覆盖graph/schema/JSONL、Agent Workspace adapter、manager journal/lease/registry race、production composition/removal |
| code commit | PASS | `10f29082e7057698747757fedf287cc3db3ca269`；29条显式源码/测试路径，4068 insertions / 274 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary全部通过 |
| `npm test` | PASS | 254 files，1598/1598 tests passed |
| `npm run build` | PASS | NodeNext production build成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest再次执行完整`npm run check` |
| `git diff --check` | PASS | 当前HEAD无whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |

已闭合的窄边界:

- production `<stateRoot>/workspace-release-journal.json`在lease CAS前持久化exact intent；operation identity、request/caller digest、authority/tenant/principal/session/agent、Workspace/repository/envelope、expected lease ID/revision、released lease与retained record digest全部进入canonical journal/receipt。receipt有self digest，journal corruption或scope drift fail closed。
- `WorktreeManager`以revision+当前secret digest做exact lease CAS，并用conditional registry append避免旧projection覆盖新状态；新manager可cold replay completed receipt，也可在lease已released而registry/receipt acknowledgement中断后补全。retryable failure允许同请求重入，但requestId digest claim不会释放给changed input或另一个operation。
- `ProductionAgentWorkspaceAdapter`返回完整`AgentWorkspaceReleaseReceiptRef`：外层绑定previous Agent Workspace receipt/binding/lease，中层包含released Workspace ref，内层保留manager authority receipt。fresh adapter可通过manager journal恢复exact receipt，graph reducer逐层复核digest、scope、lease与时间。
- `AgentCleanupRecord`成为`started | not_started` exact discriminated union。not-started路径固定为`workspace_release(spawn_aborted) -> budget_settlement(not_started) -> cleanup_completed(not_started)`，类型、schema和event均不含runtime release；wrong-kind、v0、status-only或hybrid receipt fail closed。
- Workspace/Budget任一stage不确定时写canonical reconciliation marker并停止；JSONL close/open后`reconcilePendingCleanups()`继续缺失stage。completed not-started aggregate可完整replay，started路径仍必须提供runtime/Workspace/Budget三类evidence。
- delayed release-vs-resume、validation-vs-handoff、resume-vs-remove与same-revision stale lease transition均有确定性race回归；旧release projection不能覆盖更高revision、handoff或removed tombstone。

仍未闭合的边界:

- `.launch-claim`仍不是authority-owned cold claim，没有startup scan/takeover/orphan quarantine或terminal-only child reconciler；child runtime release仍依赖launcher进程内attempt/tombstone，external success后parent event前crash没有cold receipt read-back。
- `stop_uncertain`仍缺durable probe、final cursor read-back和operator resolution；running child graceful shutdown也仍缺由authority提供exact usage并形成semantic terminal的协议。
- launcher仍没有真实child controller/model/tool loop、Tool Gateway、完整Sandbox和usage collector；CLI/daemon/factory未激活multi-agent composition，feature必须继续unsupported。
- release journal尚缺leaf symlink替换/重开专项回归；现有remove竞态覆盖registry projection，但还没有在真实Git物理remove暂停点并发resume/handoff/validate的确定性测试。完整process-tree authority、idle/replacement与kill-after-effect restart矩阵继续未完成。
- 本检查点没有运行或虚构governed DeepSeek child E2E；既有`deepseek-v4-pro`证据仍只属于单Agent provider smoke。

### 1.13 Child runtime authority sidecar foundation 验证

`eea7b67b58da05d9687c9d5cf4e3a2da688c5793`已作为独立代码/测试提交落入目标分支。本检查点只建立authority-owned child runtime sidecar合同、私有File/Memory store与released-only cold classification；launcher/supervisor/composition尚未消费该store，因此它不关闭runtime cold cleanup integration、Phase 9/11、Runtime-M2或production multi-agent。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| domain foundation RED | RED | domain模块尚不存在时，authority store测试1 failed suite / 0 collected |
| 第一轮security RED | RED | 10 tests中6 failed；双writer-fence、foreign/扩展stream、错误CAS replay、torn first write、oversize pre-read与unsafe opened handle |
| 第二轮security RED | RED | 14 tests中4 failed；interrupted hard-link publish、release observed/released time、concurrent-growth bounded read与malformed UTF-8 |
| authority store targeted | PASS | 1 file，14/14 tests；额外覆盖多个同inode publish temp fail closed |
| agents targeted | PASS | 14 files，130/130 tests |
| code commit | PASS | `eea7b67b58da05d9687c9d5cf4e3a2da688c5793`；4条显式源码/测试路径，2468 insertions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary全部通过 |
| `npm test` | PASS | 255 files，1612/1612 tests passed |
| `npm run build` | PASS | NodeNext production build成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest再次执行完整`npm run check` |
| `git diff --check` | PASS | 代码提交前与文档回写后均无whitespace error |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 source files、72 catalog files |
| final read-only review | PASS | 上一轮3个P1/3个P2与第二轮2个P1/2个可直接修复P2均由RED关闭；最终无P0/P1提交阻断 |

已闭合的foundation边界:

- 状态机固定为`claimed -> resident -> release_pending -> released`，任一非终态可进入不可逆`quarantined`。record self digest、exact keys、immutable identity、单调revision、previous record digest、transition与terminal均fail closed。
- `claimed`绑定authority/tenant/principal、parent graph/cursor/node、parent runtime/writer fence、child Agent/session/Workspace/runtime、launch request以及delegation/Workspace/Budget/Artifact digests；resident/pending/released逐步绑定child genesis/session file、launch/residency、同一child writer fence、release request、final cursor、nonresident receipt与writer-lease released evidence。
- canonical session stream必须由authority/tenant/session派生，stream子对象拒绝未知字段；released的pre-stop/child fence必须exact相同，nonresident `observedAt`必须等于`releasedAt`，避免sidecar可回放而parent graph必拒绝的receipt。
- Memory/File store均以revision+recordDigest CAS；candidate必须声明exact previous tuple，正确retry可replay，错误/过期expectation、changed input、skip和terminal advance均conflict或throw。
- File store使用0700 root、0600 canonical record、Agent ID哈希文件名、per-Agent跨进程lock、file/directory fsync与同目录replacement rename。首次claim先写/sync随机temp再hard-link publish；link后crash只在唯一UUID temp与final的dev/ino/mode/size/nlink完全一致时恢复，多个候选、foreign hardlink、symlink、宽权限、corruption均fail closed。
- open后复核regular file、dev/ino/mode/size/nlink，读取总请求最多8 MiB+1；fatal UTF-8与canonical byte equality拒绝replacement decoding。静态超限与打开后并发增长均在解析前拒绝。
- `classifyChildRuntimeColdRecord()`只对完整`released`返回exact runtime release receipt；claimed/resident/release_pending/quarantined均只返回`takeoverAllowed=false`的quarantine，不会因TTL或猜测自动接管。

仍未闭合的边界:

- `ProductionChildSessionLauncher`尚未读写该store；旧`.launch-claim`和进程内children/release operation/attempt/tombstone仍是实际路径。没有claim-before-create接线、resident/pending/released CAS接线、startup scan、orphan quarantine或terminal-only reconciler。
- fresh launcher仍不能在runtime external success后、parent `agent.runtime_released` append/flush前crash时读取并提交exact receipt；sidecar released classification尚未进入canonical parent event/reducer恢复链。因此不得勾选runtime release cold read-back或整个child cleanup exactly-once。
- `stop_uncertain`仍缺durable probe、final cursor read-back与operator resolution；active/running/release_pending sidecar全部fail closed quarantine，不做writer takeover。
- root/leaf验证与后续open/link/rename仍是分离的pathname操作；ancestor/root/closed-temp swap需要dirfd/逐ancestor验证及`openat`/`linkat`/`renameat`或等价机制。当前opened-handle identity证明不能外推为该TOCTOU已关闭。
- 真实child controller/model/tool loop、Tool Gateway、Sandbox、usage collector与CLI/daemon/factory activation仍未接通。本检查点没有运行或虚构governed DeepSeek child E2E；现有auth中的`deepseek-v4-pro`只在这些真实路径接通后使用，且不得读取、打印、复制或提交API key。

### 1.14 Pre-resident authority linearization 与 released-only cold replay 验证

`93d9226d817b4a24873252c542944aebeaa9b1a7` 已作为独立代码/测试提交落入目标分支。该检查点把 sidecar 从 foundation 接入 `ProductionChildSessionLauncher`、production parent resolver、Supervisor cleanup 与 startup audit，建立 `claimed -> creating -> provisional -> resident -> release_pending -> released` 的 durable effect 顺序，并只允许完整 `released` authority 冷重放；它不建立真实 child Agent loop、active/partial takeover、完整 Sandbox 或可 advertise 的 production multi-agent。

本节替代§1.8–§1.13中“`.launch-claim`仍是实际路径”“launcher尚未消费sidecar”“released receipt不能fresh-process replay”等当时检查点的当前态断言；旧段落保留为对应commit的历史证据，不应用来覆盖`93d9226`后的状态。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| integration RED | RED | schema 先扩展为 `creating/provisional` 后，旧 launcher 出现 2 个 TypeScript error；4 个 authority/launcher/reconciler/composition 文件 74 tests 中 31 failed，证明旧路径仍是 create/genesis 后直接 resident |
| parent authority RED | RED | 新 exact launch/resume success fixture 初次 6 tests 中 2 failed；根因是 `InMemoryAgentGraphStore` fixture 没有 production `SessionAgentGraphStore` 必有的 durable cursor，修 fixture 而未放宽 resolver |
| activation targeted | PASS | 12 files，161/161 tests；覆盖 authority store、launcher、reconciler、parent resolver、composition、resume、Supervisor、session manager、writer lease、runtime generation 与 multi-agent isolation |
| code commit | PASS | `93d9226d817b4a24873252c542944aebeaa9b1a7`；20 条显式源码/测试路径，6896 insertions / 509 deletions |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary 全部通过 |
| `npm test` | PASS | 257 files，1677/1677 tests passed |
| `npm run build` | PASS | NodeNext production build 成功 |
| `npm run test:harness-regression` | PASS | 11 files，63/63 tests；pretest 再次执行完整 `npm run check` |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 upstream files、72 catalog files |
| `git diff --check` / final review | PASS | staged 与提交后 diff 无 whitespace error；最终只读审查无已证实提交阻断 |

已闭合的窄边界:

- launch 预计算 exact absolute child session path，以随机 `claimAttemptId` 区分同一 request 的并发 creator；`begin` 无论 applied/replay/ack-loss 都必须 exact read-back token + record digest 后才能进入 create。
- pre-resident effect 顺序固定为 `claimed -> creating -> V3SessionManager.create(writeGenesis:false) -> provisional(receipts + child fence) -> genesis durable barrier/exact sequence-0 replay -> resident`。create、receipt、provisional、genesis 或 resident CAS 任一失败均保留已取得的 path/fence/receipt/genesis evidence并 fail closed quarantine；manager close 或 quarantine 任一不确定都返回 retryable。
- launch 与 resume activation 分开封口。latest activation durable 绑定 current parent graph revision/cursor/node、delegation/Workspace/Budget digest和parent writer fence；resume 只允许 `paused | partial` current graph、严格前进 cursor/revision、相同 request exact replay、changed digest conflict和并发 CAS 单赢家。
- production parent resolver要求 running parent、current unexpired grant、child state与current delegation/Workspace/Budget/input/declassification exact匹配；launch另绑定 role/objective/Artifact contract。测试 fixture缺cursor时继续 fail closed。
- `V3SessionManager` 提供 explicit file path、deferred genesis、durable head flush与current writer-fence receipt；heartbeat刷新 fence 后 release 允许同一 lease identity/epoch/token 的单调 expiry更新，真实 launcher heartbeat -> release 回归通过。
- fresh launcher可从完整 `released` sidecar exact重放 runtime release receipt，并在parent `agent.runtime_released` append失败或flush acknowledgement loss后继续 canonical cleanup；`claimed/creating/provisional/resident/release_pending/quarantined` 六类 cold partial authority全部阻止 Workspace/Budget 后续effect和自动takeover。
- parent writer fence在claim或create authorization时已过期会被拒绝；resident构造失败保留exact genesis，manager close与quarantine fault均有retryable回归。Supervisor对可能已经create的retryable launcher failure不执行not-started Workspace/Budget cleanup。

仍未闭合的边界:

- resume仍有 resolve/sidecar CAS 间的 freshness 窄窗：record只证明parent fence在latest `launchReceipt.launchedAt`有效，尚未证明CAS提交瞬间仍active。需要在resume CAS前后形成可持久化的第二次current-fence revalidation或等价authority protocol。
- `V3SessionManager.create()` composition与cleanup同时失败时只抛 `AggregateError`；launcher只能把`creating` authority quarantine，无法持久化create内部可能已取得的child fence或writer-lease release evidence。需要结构化partial-create outcome，而不是从异常文本猜测。
- manager close与quarantine都成功后的部分非retryable返回，会允许Supervisor执行not-started Workspace/Budget cleanup；“本地close成功是否足以替代durable `released` authority”尚未形成正式策略。策略明确前，任何不确定分支继续保持retryable并阻止下游cleanup。
- cold partial authority仍只fail closed，不做writer takeover、stop probe、final cursor恢复或operator resolution；`stop_uncertain`、runtime kill-after-effect、active orphan与same-session replacement仍未闭合。
- authority File store的ancestor/root/closed-temp pathname swap仍缺dirfd/逐ancestor identity及`openat`/`linkat`/`renameat`或等价证明。
- 真实child controller/model/tool loop、child Gateway、完整Sandbox、usage collector、Artifact/handoff/merge、CLI/daemon/factory feature activation仍未接通。本检查点没有运行或虚构governed DeepSeek child E2E；现有AuthStorage中的`deepseek-v4-pro`只在这些真实路径接通后使用，且不得读取、打印、复制或提交API key。

### 1.15 本轮查找与验证过程中的问题

- 本阶段第一次 targeted 收集在 `tests/e2e/daemon-recovery.test.ts` 失败：fixture 手工追加新版 `agent.finished` 时仍沿用旧 payload，缺 `AgentSemanticTerminalRecord`。fixture 改为用 canonical constructor生成 terminal后通过；这说明 schema升级后的历史/daemon fixture必须显式迁移，不能靠 optional/default吞掉 terminal correlation。
- 本阶段 DeepSeek smoke 首次用 `tsx -e` 顶层 `await`，因 eval走 CJS输出模式在网络请求前失败；改为 async IIFE后，同一 auth/model/Agent/echo/ledger链路成功。失败与成功尝试都没有读取或输出 credential正文，也没有修改仓库。
- pi-ai audit第一次调用遗漏必填 `--upstream`，只返回命令用法、没有形成审计证据；补 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/pi` 与固定 commit后重跑，才取得164/164 source files和72 catalog files PASS。文档只采用后一次结果。
- 第一轮 cleanup reviewer围绕 terminal cursor、exact usage、receipt correlation、external success后的exact retry、composition close和V3 partial-close lease逐项反审：必填 final child cursor、started child mutation前usage、typed runtime/budget receipt、ordered stage、同进程receipt replay、active-child close拒绝与TTL cold takeover均通过新增红测修复。仍未解决的是process-local cache crash gap、`stop_uncertain`和真实 Workspace release evidence，已保留在§1.10。
- 第二轮 reviewer又发现 isolated command可在早期检查后与release并发、release receipt可能先于process drain，以及shell后台descendant可逃过direct PID kill。实现增加同步release quarantine、逐await复检、tracked abort/drain、POSIX process-group kill和Windows Job Object缺失时fail closed；随后review确认当前bounded seam无提交阻断。`setsid`/double-fork逃逸与非`ESRCH` group-kill错误的uncertain处理仍未完成，不能把本次修正写成Sandbox或完整process-tree authority。
- 一次范围过宽的 `/tmp` 只读搜索从旧的、与当前仓库无关的临时日志中把一条 credential 显示到了工具输出。该值没有被复述、使用、写入仓库或提交；当时实现检查点涉及的 20 条代码/测试路径已用只输出文件名的私钥、AWS key、`sk-*` 模式复检，无命中。由于轮换凭据和清理旧临时日志属于额外外部/破坏性状态变更，本轮没有擅自执行；相关 credential 应尽快轮换，并单独清理或收紧旧日志权限。
- live smoke 首次预检误把实际 `AuthCheck = { type, source? }` 当成含 `configured` 字段，因此在网络请求前主动失败。按真实契约改为检查返回值是否存在后重跑成功；没有为这个 one-off runner 修改仓库代码。
- 本阶段 live smoke 的第一次 runner 选择了 Node 原生 `--experimental-strip-types`，因该 loader 不解析 `src/runtime/ledger/memory-ledger.ts` 中现有 `.js` 相对导入而在网络请求前以 `ERR_MODULE_NOT_FOUND` 退出；随后改用项目已安装的 `tsx`，同一 auth/provider/Agent/tool 路径成功。失败尝试未读取或输出凭据，也没有修改仓库。
- 两次成功 live smoke 都使用内联 runner，当前没有可持久复跑的脚本、durable session、governed state-root 或真实 mutation-gate audit；所以证据只记录 provider/Agent/tool/ledger 连通性，不能提升任何 governed startup、Verification 或 Phase 11 复选框。
- child gate 的第一次审查发现 gate 返回后到 Workspace callback/claim 之间仍有 abort 窗口；第二次审查又发现 `V3SessionManager.create()` in-flight 时 `close()` 已返回但 child 仍可能被注册。两处已用确定性竞态测试关闭，但也证明“abort 后全部零副作用”只能用于 durable create 之前；create 已开始后必须保留 genesis 并进入显式 recovery，自动 reconciliation 仍是未完成项。
- `b175b84` 前搜索全仓曾确认 `src/**` 没有 `ProductionChildSessionLauncher` 构造点；当前该事实已被 production interactive composition seam 取代，但 CLI/daemon/factory 默认入口仍未激活它。没有 machine-verifiable feature row 与完整 child lifecycle 前，能力继续保持 unsupported。
- composition 审查先后发现五个不能靠“测试已绿”掩盖的问题：完整 composition 暴露 gate/launcher/writer、source/readonly root 被误标 managed active、child runtime ID 未绑定 Workspace owner、同 digest grant 字段漂移被当成幂等，以及 launcher close 在 close 成功前清空 registry。均已用红测修正；后续 `33b58ed` 又关闭进程驻留 semantic terminal/cleanup 分离与 active-child裸 close，但 cold claim/reconciler、真实 child Agent loop及跨进程外部effect证明仍未完成，不在本提交中虚构完成。
- cancel evidence首轮完整`npm test`不是PASS：新增session replay test和既有multi-agent E2E在并发全量运行时分别命中5秒timeout。新增session test加15秒显式预算后，先跑相关2-file定向再跑完整suite均通过；没有借timeout失败删除restart断言，也没有把一次失败隐藏在最终计数之外。
- cancel evidence的pi-ai audit第一次漏必填`--upstream`/`--commit`并exit 2；credential scan第一次复杂regex又因shell quoting失败。两者都未被记为成功证据；前者按固定upstream/commit重跑，后者改用简化filename-only安全模式且无匹配。
- 文档最终行号检索第一次把含backtick的pattern放进双引号，shell尝试执行其中的`AgentSupervisor.cancel()`并返回command not found；该命令没有写文件或读取credential。随后改用无命令替换风险的单引号pattern完成定位，`git diff --check`保持通过。
- Workspace cleanup新红测第一次运行`cleanup-saga.test.ts`为27 tests / 7 failed；失败集中证明旧`launch_rejected`补偿没有durable aggregate、失败stage恢复和restart replay。实现后同文件扩展到33 tests并与其余release/schema/production测试组成9 files / 85 tests全绿；没有把初始失败记成通过证据。
- 查找manager release路径时确认原返回值只有旧receipt identity/status投影，且release结果只能靠进程内adapter cache重放；这促成intent-before-CAS journal和三层typed receipt。修复过程中又暴露same-revision只按revision CAS、delayed registry append覆盖新projection、retryable错误永久占住result cache以及requestId被changed input接管等问题，均由exact secret digest、conditional append、retryable re-entry和永久digest claim回归关闭。
- 当前file journal验证覆盖scope/digest/permission/corruption与production reopen，但没有独立把`workspace-release-journal.json` leaf替换为symlink后再执行verify/read/write的专项fixture；因此不能把state-root目录约束外推成该leaf竞态已证明。
- 当前remove竞态在registry append处暂停，并确认delayed resume不能复活已删除worktree；尚未在真实Git `removeWorktree`物理调用前后设置可控暂停并并发resume/handoff/validate。该未完成项继续保留，不能用现有in-memory/registry race测试宣称完整物理remove serialization。
- `10f2908`最终门禁刷新时第一次无参数运行`npm run audit:pi-ai`因缺必填`--upstream`/`--commit`以exit 2结束，不构成审计证据；随后固定pi路径与`3f1762c...`重跑，才取得164/164 source files与72 catalog files PASS。
- authority sidecar第一轮安全审查发现3个P1和3个P2：released可拼接不同writer fence、首次begin会留下torn final、stream不做canonical/exact验证、错误CAS expectation可replay、8 MiB检查晚于readFile、opened handle identity未复核。6项RED初次为10 tests / 6 failed；第一版修复后还剩2 failed，分别暴露“skip transition被过早降成conflict”与oversize在opened-handle检查前被泛化错误拒绝。最终保留合法exact retry replay、invalid transition throw，并把size检查放到opened handle stat后。
- 第二轮只读审查继续发现hard-link publish在link后/temp unlink前crash会形成nlink=2冷启动死锁，以及sidecar允许graph reducer必拒绝的`nonresident.observedAt != releasedAt`；同时指出并发增长仍可让无界`readFile()`突破上限、非法UTF-8 replacement decoding可绕过string-level canonical compare。新增4项RED为14 tests / 4 failed，最终以唯一同inode temp恢复、ambiguous fail closed、MAX+1显式read、fatal decode与canonical byte compare关闭；最终复审无P0/P1。
- opened leaf的dev/ino/mode/size/nlink复核不等于pathname链已安全：authority root verify、temp close与后续open/link/rename之间仍存在ancestor/root/closed-temp swap窗口。完整修复需要dirfd/逐ancestor约束及`openat`/`linkat`/`renameat`或等价平台机制；本提交只记录该边界，没有用`O_NOFOLLOW`或0700目录虚构TOCTOU已闭合。
- pre-resident schema先加入`creating/provisional`后，launcher尚未迁移导致2个TypeScript error和31个定向失败；按`claimed -> creating -> create(no genesis) -> provisional -> durable genesis -> resident`接线后关闭。没有通过放宽schema恢复旧的create后直达resident路径。
- production parent resolver的新success测试初次2项`invalid_graph`不是resolver过严，而是`InMemoryAgentGraphStore` fixture没有production session graph必有的durable cursor；补与parent session/writer fence同流cursor后launch、paused resume、partial resume均通过，exact current graph条件保持不变。
- 最终审查确认当前checkpoint无已证实提交阻断，同时留下三个不能隐藏的策略/协议缺口：resume resolve-to-CAS fence freshness、manager composition+cleanup双失败的structured partial evidence、以及local close+quarantine后not-started cleanup的正式授权条件。它们已写入§1.14和§5第一顺位。
- 本轮没有因为用户确认auth已有`deepseek-v4-pro`就提前运行governed child E2E：真实child controller/model/tool/Gateway/Sandbox仍未接通。后续接通后可通过正常`AuthStorage`路径使用现有credential，但不得读取、打印、复制或提交API key。

### 1.16 Post-graph process-resident child execution 与 DeepSeek E2E 验证

`754b9033a96d48d2cfa2b627cc89411b7638092b`、`bb533d32aed1eeaf491b6b0f4763bb11a6c14070`和`e741c884cc19a7eac2dc70747b06004db1540888`已落入目标分支。本节替代§1.14/§1.15中“没有真实child loop”“没有运行governed DeepSeek E2E”的当前态断言；旧段落仍保留为各自checkpoint的历史证据。它只关闭 internal/test-injected 进程驻留 executable seam与happy-path E2E:相关 runtime factory/host 仍由测试从源码深导入,未进入稳定 package public surface,不关闭production入口、cold activation truth、真实Gateway/Sandbox/Verification或Runtime-M2。

| 命令/阶段 | 结果 | 说明 |
|---|---|---|
| child operation budget | PASS | `754b903`；1 file / 8 tests，child provider/tool operation exact usage聚合，父reservation不下沉双计 |
| headless runtime host | PASS | `bb533d3`；1 file / 6 tests，prepare无provider/tool side effect，activate后才prompt，completion/usage/cursor不确定时fail closed |
| post-graph targeted | PASS | 5 files / 80 tests；post-commit ordering、running commit failure零activation、exact/changed/transient retry、completion uncertain、release/drain race与composition接线 |
| deterministic governed E2E | PASS | `tests/e2e/governed-child-runtime.test.ts`，1/1；V3 parent/child、production Workspace/composition、File authority、2 turns、1 tool、1 Artifact、test attestation、exact cursor/usage/terminal/cleanup/replay |
| live DeepSeek E2E | PASS | `RUNLEDGER_LIVE_E2E=1 npx vitest run tests/e2e/live-deepseek-child-runtime.test.ts --no-file-parallelism`，1 file / 1 test；test 5.789s、总11.02s，`deepseek/deepseek-v4-pro`、256 max tokens、2 provider dispatch、1 tool、1 Artifact、1 test verification、completed与三阶段cleanup |
| `npm run check` | PASS | TypeScript、runtime boundary、execution boundary全部通过 |
| `npm test` | PASS | 261 files / 1701 tests passed；live 1 test默认skip，因此总发现262 files / 1702 tests |
| `npm run build` | PASS | NodeNext production build成功 |
| `npm run test:harness-regression` | PASS | 11 files / 63 tests；pretest再次完整执行`npm run check` |
| pi-ai fixed snapshot audit | PASS | `pi@3f1762c...`，164/164 upstream files、72 catalog files |
| `git diff --check` | PASS | code staged/commit后与文档回写均无whitespace error |

已闭合的窄边界:

- `ChildOperationBudget`对每个provider/tool operation做reserve/commit/refund并聚合exact usage；Supervisor只在semantic terminal后结算父child reservation一次。
- `runtimeFactory.prepare()`只构造未激活host；launcher完成durable genesis、resident authority和本地注册后返回，Supervisor再等parent graph的`launch_recorded`与`running`都durable，读取exact graph revision/cursor/node digest后activate。running commit失败时provider/tool为零调用。
- activation request/receipt绑定launch/residency、parent graph revision/cursor、child node digest；同进程exact retry去重、changed evidence冲突、transient adapter failure可重试。
- completion只接受exact usage、唯一terminal turn IDs与匹配durable replay的final cursor，顺序固定为`turn_recorded* -> cursor_advanced -> semantic terminal -> runtime -> Workspace -> Budget`；completion uncertain不调用`finish()`或任何cleanup adapter。
- release先interrupt/drain host，再停止isolated commands与manager；forced close同样先drain，避免completion coordinator与release互相等待。
- deterministic E2E通过child Artifact sink保存真实tool output；测试attestor在第二轮放行前显式`reportArtifact`并补记verification usage。live测试只通过`AuthStorage.create() -> builtinModels -> deepseek-v4-pro`内部解析credential；测试代码没有直接读取、复制、透传或输出API key，也没有输出回复正文、headers、credential或raw provider cause。

查找、实现与验证中遇到的问题:

- `e741c88`的最终targeted/full/live证据完整，但当前continuation没有保留可信的原始RED console transcript；因此文档没有补造RED数量。`754b903`与`bb533d3`只记录其各自最终8/8与6/6。
- post-commit activation首次审查发现Supervisor会永久缓存一次retryable activation failure，导致相同durable head无法恢复；新增transient failure回归并只在success时保留cache后，`post-commit-child-activation.test.ts`为5/5。
- E2E最初helper暴露`apiKey/env`透传入口，虽然未读取credential，仍扩大了live测试误用面；最终删除该入口，live StreamFn只调用`Models.streamSimple()`，credential留在`Models/AuthStorage`内部。
- E2E初稿只靠模型自然在第二轮停止，预算仍允许4 turns/8 tools；最终同时把child budget收窄为2 turns/1 tool，并加`shouldStopAfterTurn(({ turn }) => turn >= 2)`、110s abort、115s wait与120s Vitest timeout。
- 成功`completed`必须满足非空Artifact contract；当前production host没有Artifact report/Verification port。测试用child-scoped Artifact sink保存tool output，再由明确标注的test attestor手工report并记verification usage。该替身只证明lifecycle协调，不代表production Artifact/Verification已闭合。
- 最终credential-pattern scan的第一次复杂shell regex因引号嵌套在执行前语法失败，没有形成安全证据；改为两个固定、只输出命中文件名的模式后重跑，12条code/test路径无命中。失败命令没有读取credential文件或修改工作树。

仍未闭合的边界:

- activation receipt与completion Promise仍只在进程内；parent graph和authority sidecar没有durable activation truth，running后crash不能判断provider/tool是否已经开始。
- child provider/model选择、objective/prompt和pending run没有持久化，无法cold reconstruct或跨重启继续。
- `requestedCapabilities`已绑定launch request不等于`resourceId/manifest -> tool registry`实际enforcement；child-scoped continuous mutation gate、真实Capability Gateway、Sandbox、Verification和process-tree isolation没有闭合。
- process-resident final cursor已精确取得，但cold partial仍不能恢复active orphan/writer/stop/final cursor；resume freshness、structured partial-create、local-close policy、`stop_uncertain`、kill-after-effect、idle/replacement继续未完成。
- Artifact reporting/test attestation不是production Artifact/Verification；partial Artifact、handoff/merge、root cost迟到对账仍缺。
- CLI/daemon/factory没有默认注入production runtime factory，也没有machine-verifiable multi-agent feature/required-adapter row；production multi-agent继续unsupported。
- Phase 9、Runtime-M2、全维BudgetGuard、完整Multi-Agent限制和Harness Regression最终项均保持未完成。

### 1.17 Current-HEAD 实现状态复核

本次复核以`ac54e38`为准。此前以`81556ac`为准的“只有process-resident seam”“没有HTTP/SSE listener/feature row”“CLI/daemon/factory完全未激活”等断言已被W3实现取代;§1.1–§1.16继续作为历史checkpoint保留,不能覆盖本节当前真值。

| 复核项 | 当前结果 |
|---|---|
| `npm run check` | PASS；TypeScript、runtime boundary、execution boundary全部通过 |
| `npm test` | PASS；277 files / 1790 tests，另1个live test默认skip |
| `npm run build` | PASS |
| `npm run test:harness-regression` | PASS；11 files / 63 tests |
| public-surface/ownership | PASS；3 files / 7 tests，稳定agents/control-plane子路径可消费 |
| pi-ai fixed snapshot audit | PASS；164/164 upstream files、72 catalog files |
| 三组冻结门禁 | PASS；PCM 16/95、Extension 12/52、Security/Worktree 21/119 |
| `git diff --check` | PASS |
| live DeepSeek | 本轮未联网重跑；仅保留`e741c88`的opt-in PASS,默认suite仍明确skip |

当前实现边界:

- W3-M2由`203fde6`完成authority v2、durable activation/completion/cold recovery、`stop_uncertain`、public child factory/admission、budget reconcile、Artifact handoff/merge及idle/replacement/fencing;`d545918`已汇入。
- W3-M3由`0c6d1a1`完成HTTP/SSE listener lifecycle、peer attestor port、bounded transport/subscription、durable generation replacement与轻客户端;`2448385`已汇入。
- W3-J由`ac54e38`完成schema v2 Agent spawn/cancel/resume/handoff/inspect、canonical claim/terminal replay、production adapter identity与同一Supervisor/graph/authority接线。W3-G只在Runtime-owned范围标记completed。
- `multi_agent`只有`agent_supervisor`、`child_runtime_factory`及完整production required-adapter evidence全部ready才advertise。默认daemon在真实Gateway/Sandbox/Artifact/resource/verification/Budget或平台peer attestor不齐时继续fail closed,不能用test-only adapter解锁production。
- Unix peer credential/Windows pipe ACL、真实Gateway/Sandbox/process-tree authority、pending Approval交互恢复、organization/forge/credential及remote/CI仍是external gap;因此Runtime-M2/M3产品声明保持blocked。
- Draft PR/HumanGate本轮只有versioned contract、durable command correlation和转发port;repository与真实provider仍归W4。Verification/Compaction外围专项缺口也不因W3关闭。

### 1.18 外围专项冻结

冻结状态和精确路径统一见[`06-specialty-implementation-freeze.md`](06-specialty-implementation-freeze.md)。本节只记录对剩余事项的影响:

| 专项 | 已有窄证据 | 冻结缺口 | Runtime 后续处理 |
|---|---|---|---|
| Plan/Model/Context/Compaction/Memory | Router、ContextEngine、Plan core、Compaction transaction、Memory core及16 files / 94 tests PASS | Plan/Memory用户面、`/compact`/overflow、fork/rewind/model switch与完整生产生命周期 | W2只做Runtime request/session/composition消费;缺口保持unsupported |
| Plugin/MCP/Skill/Hooks | M1/M4/M5主体、M2/M3/M6/M7部分实现及12 files / 52 tests PASS | 完整CLI/TUI管理面、canonical hook-start journal、publisher/signature/marketplace | W2只消费snapshot/catalog/hook/resource public ports;不得改`src/extensions/**` |
| Worktree/Sandbox/Permission | permission/worktree core和production窄seam及21 files / 119 tests PASS | pending Approval恢复、真实Sandbox/process-tree、持久grants、enterprise credential/remote | W2/W3/W4只校验既有receipt;缺真实enforcement时不advertise |

冻结不改变本文件当前42个`[x]`与28个`[ ]`的取证语义。属于专项的`[ ]`不会被Runtime关闭;属于Runtime自有的事项继续按04 §12严格顺序执行。

## 2. 四个参考仓库审查中遇到的边界问题

四个本地 checkout 与计划记录的 commit 一致；本轮没有 fetch/pull，因此这些结论只针对固定快照，不代表远端最新状态。每次真正移植前仍需重新核验 commit、许可证、NOTICE、行为测试和 RunLedger 本地约束。

### 2.1 codex

可采用的方向包括 permission/sandbox/tool routing 分层、single-writer/close-drain、分页历史与 fork lineage、compaction replacement、bounded transport、managed config 归因和 Agent graph。

不能直接照搬的问题:

- rollout/history 的坏行处理、append/flush 语义和记录结构不能证明 RunLedger v3 所需的 strict schema、完整 hash chain 或 fsync durability。
- `expected_turn_id` 目前主要约束 steer，不是所有 mutation 的通用 expected-revision CAS。
- `comp_hash_changed()` 在任一 compatibility hash 缺失时返回未变化；RunLedger 必须把缺失/unknown 证明视为 incompatible。
- duplicate tool、sandbox backend unavailable、synthetic active-turn fork、resident eviction 等路径存在 RunLedger 不接受的降级边界。
- MCP/Skill/Plugin metadata、cache fingerprint、annotation 或 remembered approval 不是 publisher/signature/digest/capability trust receipt。
- raw rollout trace/部分 telemetry 可包含 prompt、tool input/output 和 reasoning；不能进入默认 OTel/SIEM。

### 2.2 pi

可采用的方向包括 `AgentHarness` save point、`prepareNextTurn`、session v3/tree、compaction cut/suffix、SQLite WAL/FULL 与事务 fixture、parallel tool ordering 和本地 RPC 形状。

不能直接照搬的问题:

- await append、`EventStream.result()`、`pendingSessionWrites` 和 phase idle 都是进程内 settlement，不能签发 durable receipt。
- harness JSONL 仍有空行过滤、payload cast 和跨 entry invariant 缺口；legacy coding-agent 还会跳过坏行。
- SQLite `create`/fork 并未覆盖 RunLedger 需要的完整原子 genesis、lineage、writer fencing、effect intent/commit 和 durable receipt。
- Node ExecutionEnv 允许任意绝对路径；extension 通过 `jiti` 在主进程加载，缺 workspace identity、Gateway、sandbox 和供应链信任。
- coding-agent 的 runtime replacement 是 teardown-first；新 runtime 构造失败时没有保持旧 authority 的事务性语义。
- RPC 缺协议 handshake、cursor replay、auth、通用 idempotency/expected revision 和 durable acceptance。
- pi 明确不内建完整 MCP、sub-agent、permission popup、Plan Mode 等能力，不能把 seam 当作 parity。

### 2.3 grok-build

可采用的方向包括 actor 串行化、worktree/checkpoint 结构、shell policy、child capability 粗粒度偏序、Tool Protocol handshake/generation/sequence、`Progress* + exactly one Terminal` 和 metadata-only telemetry。

不能直接照搬的问题:

- JSONL reader 会跳过坏行；部分 fsync/parent-dir sync 错误被 warning/吞掉，不能形成调用方可见的 durability failure。
- Goal orchestration 仍由模型调用 `update_goal` 驱动，不能成为 deterministic build/test/review/completion gate。
- signed-policy trust root 默认空而处于 dark capability；local/dev folder trust 和部分 sandbox/worktree 路径会降级。
- tool preflight 是逐项而非整批 all-or-none，path lock 依赖参数启发，不能证明 parallel batch 独立。
- expired GC、checkpoint rewind、共享 workspace fallback 与 partial text result 缺 durable owner/lease/Artifact/integrity 证明。
- upload manifest 会把 `Enqueued` 计入 `fully_uploaded`；RunLedger 必须区分 enqueued、durable、content-verified 和 externally acknowledged。
- agent/leader server 主要依赖进程内 residency/unbounded channel，不能证明 daemon restart 后的 durable recovery。

### 2.4 claude-code-bun

可采用的方向包括 worktree slug/root 检查、session restore/memory 服务分层、permission/sandbox adapter、Agent fork/resume、cost tracking 和 graceful-shutdown 流程形状。

不能直接照搬的问题:

- 当前 checkout 无根许可证，且仓库自述 reverse-engineered/decompiled，部分模块是 stub 或默认关闭；只可作行为研究，未确认授权前不得复制源码或宣称官方契约。
- stale worktree cleanup 使用 `git status --porcelain -uno`，会忽略 untracked 文件；worktree 缺失时 resume 还可能回退 parent cwd。
- child/resume 会继承或默认 `acceptEdits`，MCP tool filtering 也可能绕过严格 parent-capability subset。
- `allowUnsandboxedCommands` 默认 true，sandbox/remote managed settings 存在 fail-open 路径。
- Linux secure storage 可回退到 0600 明文；telemetry tracing 可包含 prompt/tool/model 内容。
- session write queue 达到 1000 后存在丢弃旧项路径，不能作为 canonical audit log。
- verification agent 仍依赖模型判断，server/remote state 多处是 stub、普通 JSON 或 in-memory map。
- skill learning/team memory 多为 feature-gated，且自动晋升链缺独立回归与人工批准，不能成为全局治理策略。

## 3. 本轮发现并已收敛的阻断

以下问题曾真实阻断类型检查、restart replay 或完整测试。它们已由实现检查点 `004a2521934be745e8887f40f2b2631c392829dd` 和定向测试关闭；不据此推导 `04` 的整个阶段完成。

### 3.1 Canonical Goal/Task/Budget truth

- [x] 修复 event discriminant 缩窄、branded Artifact 引用和 budget catalog/helper 不一致。
- [x] `tests/runtime-v3/orchestrator/canonical-truth.test.ts` 使用同一 event vector 证明 Goal/Task/Budget live、replay 与 JSONL restart projection 一致。
- [x] `tests/runtime-v3/orchestrator/session-journal.test.ts` 迁移 canonical stream/genesis/flush barrier，6/6 通过；相关 journal 消费者 7 files / 38 tests 通过。

### 3.2 Dependency Admission / Secret Scan

- [x] 修复 `Partial<...Policy>` 到 exact policy 的类型/校验边界。
- [x] admission tests 已覆盖 lifecycle script、collector/scanner identity、tracked-only coverage、truncation 与 secret scopes，9/9 通过。
- [ ] `runtime-gap + frozen-external-gap`:candidate-untrusted collector/config/lockfile-source 的真实生产 E2E仍缺；Phase 11 fault manifest已映射并在Linux运行`admission-gates.test.ts`,但dependency cooling/admission与Secret Scan尚未成为独立的Harness Regression/CI必选命令。

### 3.3 RuntimeActivity 与 daemon mutation effect

- [x] RuntimeActivity 统一为 canonical v2；legacy v1 只读识别，telemetry、daemon、Control Plane query 和 replay 共用 projector/digest fixture。
- [x] 修复 terminal status 缩窄；Activity/Cost 4/4、Control Plane Activity/effect 5/5 通过。
- [x] daemon query failure 的 `MutationEffect` 显式映射为 `committed|none -> none`、`uncertain|absent -> uncertain`，原始 effect 留在 `details.storeEffect`；没有扩宽联合掩盖语义。

### 3.4 Control Plane command restart

- [x] 全部 13 类 mutation 的 `command.applied`/`command.rejected` 持久化 bounded typed result/error，并与 command type、request digest、idempotency claim、revision/cursor 绑定。
- [x] `authority-command-idempotency.test.ts` 57/57 覆盖 success、typed rejection、uncertain reconcile、重复 commandId 与 changed digest restart；resolver/cache 不能遮蔽 canonical terminal truth。
- [x] fork 使用 child cursor、session bootstrap 非空 head、interrupt mandatory durable cursor 已有回归；Control Plane/daemon/core attack 联合 25 files / 173 tests 通过。

## 4. 当前明确未完成的功能边界

本节同时包含 Runtime 自有缺口和已冻结专项缺口。Runtime 自有项按04 §12实施;Plan/Context/Compaction/Memory、Extension、Worktree/Sandbox/Permission及其Security/enterprise实现项只在本节保留取证,不得进入Runtime代码lane。归属以06为准。2026-07-24状态收敛后,未完成项显式标记为`runtime-gap`、`frozen-external-gap`或`cross-platform-pending`;已被W2/W3/W4权威证据覆盖的旧断言改为完成,不再保留互相矛盾的复选框。当前共13项:4项纯`runtime-gap`、5项纯`frozen-external-gap`、3项Runtime与冻结专项联合缺口、1项`cross-platform-pending`。

### P0:Production state root、持续门禁与进程驻留 child execution seam 已接线，cold reconciliation/真实安全适配/入口 activation 仍未闭合

`830a723` 已关闭此前“既有 V3 CLI/daemon 直接 open 后只看本地 recoveryDecision”的已知旁路；`2ca6f30` 继续关闭 production state-root 组合、durable-store 联合 E2E、Approval terminal projection 和 governed open/CLI/factory cleanup failure 丢失；`ac524f4` 关闭 Workspace lease 的持续 mutation gate；`f3e2ba6` 再关闭 production Tool Gateway 的 interactive Approval active dependency 与 durable start fence；`7e6f771` 关闭 `ProductionChildSessionLauncher` class seam 的 `child_spawn` gate；`b175b84` 接通 active-parent production interactive `AgentSupervisor` composition、root adoption/revalidation 与 child owner correlation；`33b58ed` 接通同一进程内 semantic terminal到runtime/Workspace/Budget aggregate cleanup，并加固active-child close、writer lease和isolated-command/release race；`c0ade82` 只把parent `AgentSupervisor.cancel()`的reason evidence绑定到durable terminal identity与restart replay；`10f2908`进一步关闭Workspace release authority evidence/cold read-back与`launch_rejected` not-started aggregate；`eea7b67`建立child runtime authority sidecar foundation；`93d9226`把该store接入launcher，完成pre-resident linearization、released-only cold replay和cold partial fail-closed；`754b903`、`bb533d3`与`e741c88`再闭合process-resident child operation usage、prepare/activate分相、post-graph completion coordinator与deterministic/live happy-path E2E；W3的`203fde6`/`0c6d1a1`及唯一join继续关闭cold writer/stop/final-cursor recovery、`stop_uncertain`、idle unload/reload、standby replacement、generation fencing、稳定public factory/admission和machine-verifiable composition row。当前仍缺的是下列窄authority/filesystem/cleanup边界及真实Gateway/Sandbox/peer/Approval等冻结专项能力,而不是W3已经完成的状态机。

- [x] 既有 V3 CLI open/fork、factory resume/fork、daemon cold recovery 与 partial migration resume 统一先经过 `GovernedV3SessionRuntime`；审计未通过时不会进入 controller/model/tool、candidate authority、agent binding 或 child creation。
- [x] Workspace lease 与 Approval receipt 的 exact digest/revision/expiry/state、partial/unknown completeness、missing/store throw/timeout/abort/畸形 receipt 均 fail closed；非 `allowed` Approval 即使被 adapter 伪报 valid 也只能 paused。
- [x] 单调用 timeout 与整次 scan deadline 有界；adapter 忽略 `AbortSignal` 时，首个 timeout/abort 后停止启动后续 audits，不会按 10,000-item 上限继续制造悬挂调用。
- [x] 缺 auditor 的默认 sentinel 对含 external refs 的 session fail closed；确无 external refs 的 clean/new session 不需要伪造 Workspace/Approval receipt。
- [x] 标准 CLI `--state-root` 与 daemon `--state-root`/startup option 会从同一 deployment-owned canonical root 组合 `FileWorkspaceLeaseMutationPort`、`FileApprovalStateStore` 与 `DurableStartupExternalReceiptAuditor`；root 必须预先存在、私有、非 symlink、realpath 精确一致并在子 store 创建前后保持 dev/inode。raw auditor 冲突、CLI/dependency/provider root 不一致均在 open 前拒绝。
- [x] CLI 与 daemon 的真实 file-store 联合 E2E 覆盖 exact、stale Workspace、revoked Workspace、expired Approval、missing Workspace；CLI 无效状态在 TUI/controller/model/tool composition 前失败，provider-admitted root 也必须在 session open 前参与审计。
- [x] canonical Approval projector 只接收完整 principal/session/runtime/generation/turn/toolCall 与 request/ticket/receipt binding；decided/expired/revoked exact projection、完全重复幂等和 evidence/binding drift fail-closed 均有回归。
- [x] Workspace 持续 gate 窄边界：session-scoped gate 在 production `model_request`、`tool_authorize`、`tool_execute` 和 factory `session_fork` 前重新读取 canonical external refs，复检 active Workspace lease 的 exact digest/revision/audit receipt 与稳定 event head；CLI/daemon/factory 传递同一 gate，拒绝时 model/tool/fork delegate 或 fork child genesis 为零调用。timeout/throw/abort/corruption/mismatch 会永久 latch。证据固定到 `ac524f4`、8 files / 75 targeted tests 与 §1.6 独立完整门禁。
- [x] production Workspace bind/release 已进入 canonical session truth：`workspace.bound -> lease.acquired -> flush`，release 成功后 `workspace.released -> flush`；resume 新 lease/revision 会重新 bound/acquired，projector 不保留已 terminal 的旧 lease。
- [x] production Tool Gateway 的 interactive Approval active dependency 已闭合到当前窄边界：canonical request/terminal mandatory flush、Memory/File revision CAS、allowed revoke/expire、store/event startup reconcile、authorize cache/current grant 复检、Approval identity fence、三阶段 durable start/attempt claim 和 no-start/late-callback fail-closed 均有联合回归；证据固定到 `f3e2ba6`、16 files / 176 targeted tests 与 §1.7 独立完整门禁。
- [ ] `frozen-external-gap`:Approval全局可操作性仍未闭合：pending prompt/waiter不能跨重启恢复，system/interactive actor尚无authority/deployment与channel-bound identity proof，自动Gateway admission deny缺独立canonical审计事件，extension hook缺production start journal，公开revoke命令与真实活跃期corruption/kill/TOCTOU矩阵仍缺失。不能把Tool Gateway窄切片写成Approval系统整体完成。
- [x] `ProductionChildSessionLauncher` 的 `child_spawn` admission seam 已闭合：parent gate 位于 cache/Workspace validation/authority claim/V3 create 前，deny/throw/abort 与 cache bypass fault 均 fail closed。`7e6f771`证明最初的class seam；当前 durable effect/cleanup真值以`93d9226`的authority sidecar `claimed -> creating -> provisional -> resident | quarantined`路径为准,不能再概括为简单“删除 claim”。证据见§1.8与§1.14。
- [x] active-parent production interactive composition seam 已闭合：同一 parent manager/gate、root Workspace/Artifact/Budget adapters、private graph store/launcher、source/managed/readonly root revalidation 与 child runtime owner correlation均有 production integration/E2E；证据固定到 `b175b84`、9 files / 55 targeted tests 与 §1.9。该勾选不包含 child Agent loop或CLI/daemon activation；进程驻留 terminal cleanup由下一项独立记账。
- [x] internal/test-injected process-resident executable child seam已闭合：`ChildOperationBudget`、headless prepare/activate、durable running后的activation与completion coordinator、deterministic两轮/单tool/Artifact/terminal/cleanup E2E均有证据；opt-in DeepSeek通过正常AuthStorage路径实跑。相关factory/host尚未稳定公开导出,证据固定到`754b903`、`bb533d3`、`e741c88`与§1.16/§1.17；该勾选不包含真实安全adapter或production入口。
- [x] Runtime-owned production入口契约与fail-closed composition已闭合：稳定public child factory/admission、`multi_agent`/`agent_supervisor`/`child_runtime_factory` required-adapter row、共享command journal/runtime generation/shutdown gate均有machine-verifiable evidence。默认CLI/daemon在真实Gateway/Sandbox/process-tree/peer adapters不齐时不注入可advertise的production runtime factory；这是预期的`frozen-external-gap`,不是Runtime row缺失。
- [x] post-graph completion窄边界已闭合：exact turn IDs/final cursor/usage按`turn -> cursor -> terminal -> runtime -> Workspace -> Budget`推进，completion uncertain时不调用`finish()`或cleanup；activation transient retry不被永久缓存。
- [x] deterministic governed-lifecycle E2E已覆盖真实child Agent/tool result/ArtifactRef/terminal/cleanup与parent/child replay；Echo Gateway与attestor是测试替身，不外推为production Gateway/Sandbox/Verification。
- [x] opt-in DeepSeek E2E已通过`AuthStorage -> builtinModels -> deepseek-v4-pro`，最多2 turns/1 tool/256 max tokens；它只是一条live provider/process-resident lifecycle证据，不替代fault/security/restart测试。
- [x] process-resident semantic/cleanup terminal seam已闭合：`finish()`/terminal interrupt/cancel durable写semantic terminal与cleanup intent，按runtime release -> Workspace release -> budget settlement提交typed receipt和aggregate `cleanup_completed`；前一阶段不确定时后续adapter零调用。exact schema/replay、missing usage、append fault、active-child close、V3 TTL takeover与process drain证据固定到`33b58ed`、19 files / 139 targeted tests及§1.10。该勾选不包含process crash后的external-effect证明。
- [x] child runtime authority sidecar store foundation已具备exact`claimed -> creating -> provisional -> resident -> release_pending -> released | quarantined`状态、self digest、immutable identity、revision+recordDigest CAS、private atomic File store与released-only cold classification；foundation证据固定到`eea7b67`与§1.13，后续schema/launcher集成以`93d9226`为当前真值。
- [x] authority store已接入launcher与parent cleanup窄边界：random creator token、exact claim read-back、create前`creating`、genesis前`provisional`、exact durable sequence-0 genesis、resident/release CAS、released fresh-launcher replay、parent append/flush ack-loss恢复与六类cold partial阻断均有回归；证据固定到`93d9226`、12 files / 161 targeted tests与§1.14。该勾选不包含partial takeover、`stop_uncertain`、真实child loop、完整Sandbox或production feature activation。
- [ ] `runtime-gap`:authority recovery仍有三个窄缺口：resume fence在resolve与sidecar CAS之间的freshness窗口、manager create+cleanup双失败的结构化partial evidence、local close+quarantine能否授权not-started Workspace/Budget compensation的正式策略。cold writer/stop/final-cursor recovery、typed operator resolution和`stop_uncertain`本身已由W3-M2.2关闭,不再列为本项缺口。
- [ ] `runtime-gap`:child runtime authority File store尚未关闭ancestor/root/closed-temp pathname swap：需dirfd/逐ancestor identity与`openat`/`linkat`/`renameat`或等价机制；当前leaf open后的dev/ino/mode/size/nlink复核、0700/0600与`O_NOFOLLOW`不能替代该证明。
- [x] `launch_rejected` 的not-started Budget/Workspace compensation已进入独立`not_started` cleanup aggregate，按Workspace(`spawn_aborted`) -> Budget(`not_started`)完成，类型/schema/event禁止runtime release，JSONL replay/reconcile与uncertain stage均有回归。证据固定到`10f2908`、9 files / 85 targeted tests与§1.12；该勾选不包含authority-owned launch claim或runtime cold reconciliation。
- [x] parent `AgentSupervisor.cancel()` 的`reasonEvidenceDigest`已进入semantic terminal request/terminal digest、exact event与restart replay，cleanup通过terminal digest关联；same evidence幂等、changed evidence冲突。证据固定到`c0ade82`、5 files / 60 targeted tests与§1.11。该勾选不包含direct finish、terminal interrupt、legacy optional terminal或reason evidence authority/provenance。
- [x] `stop_uncertain`已有durable probe/cursor read-back、typed operator resolution与cold replay；W3-M2.2及`203fde6`关闭该Runtime-owned边界。真实process authority或Sandbox缺失时仍保持unsupported/quarantine,不反向撤销本项完成状态。
- [x] Agent Workspace release已携带`WorktreeManager.release()`的真实authority receipt、released lease/retained record digest和release time，并通过durable intent-before-CAS journal支持fresh manager/adapter cold replay与ack-loss reconciliation。证据固定到`10f2908`与§1.12；后续`93d9226`已接入child authority sidecar,本勾选仍不包含active/partial authority takeover、durable stop probe/operator resolution、release-journal leaf-symlink专项回归或完整物理remove并发证明。
- [ ] `frozen-external-gap`:isolated process seam仍不是完整Sandbox：POSIX process group可被`setsid`/double-fork逃逸，非`ESRCH` group-kill failure当前仍回退direct PID；完整生产边界需Sandbox/cgroup/PID namespace，Windows需Job Object。在此之前不能用本阶段E2E宣称process-tree isolation authority。
- [x] idle unload/reload与same-session hot replacement已接入governed authority/generation gate；standby candidate、fencing promotion、commit-before-old-drain、旧handle失效及commit前后fault E2E已由W3-M2.7/W3-M3.4和`203fde6`/`0c6d1a1`关闭。
- [ ] `runtime-gap + frozen-external-gap`:injected-auditor tests已覆盖timeout/throw/partial/abort，真实file-store startup E2E已覆盖exact/stale/revoked/expired/missing，持续gate deterministic tests已覆盖Workspace/Approval mutation与latch；仍缺真实file-store活跃期文件损坏、root/store TOCTOU、进程kill与restart reconciliation的CLI/daemon联合矩阵，以及child controller/model/tool/cleanup消费同一真实专项gate的故障断言。
- [x] `src/cli/main.ts`、governed open 与 factory start/resume/fork 不再吞掉已知 close/discard failure；多资源 cleanup 会等待并展开全部错误，durable start/fork ownership transfer 前失败会返回不可重试 uncertain effect 与 session correlation，fork parent close 失败不会遗留 active child runtime。
- [ ] `runtime-gap`:全仓cleanup尚未闭合：`src/daemon/local-v3-daemon.ts`在runtime-generation/shutdown-protocol早期失败时仍吞`authorityRuntime.close()`错误，`src/storage/authority-runtime-manager.ts` open失败仍吞Event Store close错误。后续必须保留primary+cleanup failure并增加故障注入。
- [ ] `runtime-gap`:child activation/completion authority、Workspace cold read-back、not-started aggregate和process-resident host drain已闭合；仍缺全仓cleanup owner统一，以及runtime kill-after-external-side-effect、process restart后orphan writer/lease/child自动reconciliation的联合证明，因此不能宣称所有资源均有cold durable terminal cleanup outcome。

### P0:Verification/Compaction 只有模块，不是生产生命周期

现有 production interactive composition 可在 verifier ports 全部返回 `evidence_unavailable/not invoked by composition` 时仍构造成功；这只证明服务模块可组装，不证明真实 prompt 生命周期会驱动 gate。

- [x] Runtime-owned `prompt -> goal -> approved plan/task DAG -> build/test/security/review -> reverification -> EpisodeSeal -> terminal`协调与canonical projection路径已由W2-V/W2-J关闭；真实专项runner/Workspace/Sandbox联合强制仍由下列external-gap条目约束。
- [ ] `frozen-external-gap`:overflow -> safe-point compaction -> invariant validation -> durable replacement -> CAS install生产E2E仍缺；任一crash/validation failure保留旧投影并paused的完整行为归冻结PCM专项。
- [ ] `runtime-gap + frozen-external-gap`:Builder/test-generator/reviewer/security-reviewer的Workspace、context、capability和issuer真实隔离仍缺联合production E2E；模型输出只能形成candidate/inconclusive,不能签发trusted pass。
- [x] production composition在缺trusted verifier、Browser backend、Workspace/Gateway/Sandbox/Artifact receipt时将`completion`标成`external_gap`且不advertise；`dependency-readiness.test.ts`与production Verification composition已有回归。真实adapter readiness仍保持`frozen-external-gap`。

### P1:Draft PR 与 Human Gate

- [x] Runtime-owned durable ChangeProposal repository/projection、`change_proposal.recorded`、expected revision/idempotent replay和只创建Draft PR的effect service/Control Plane adapter已闭合；真实forge/credential provider仍为`frozen-external-gap`,缺adapter时不advertise。证据位于未提交Phase 11候选diff（base`7865763`,commit pending user authorization）。
- [x] Runtime-owned HumanGate request/decision repository、organization receipt correlation、requestedBy/decidedBy separation、unknown outcome reconciliation和Control Plane adapter已闭合；真实organization/managed-policy coordinator仍为`frozen-external-gap`,本勾选不宣称企业policy enforcement已实现。
- [ ] `frozen-external-gap`:已有opaque audience-bound grant、expiry/stale/cross-tenant、revoke replay、server/resource/command scope、nonce/revoked-key tests；仍缺它们与真实forge、HumanGate、organization gate的production composition联合E2E。
- [x] Runtime只记录Draft PR和HumanGate terminal receipt,没有实现merge/deploy；缺真实credential/forge/organization terminal receipt的默认daemon不advertise相关feature,也不生成占位receipt。

### P1:Control Plane transport 与本地身份

- [x] Runtime-owned HTTP/SSE listener lifecycle已由`0c6d1a1`闭合；复用同一command/query/event schema、bounded body/input/client buffer、SSE cursor/resync与durable consumer checkpoint。
- [ ] `frozen-external-gap`:Unix socket/Windows pipe的peer credential/channel binding与principal映射未完成；socket路径权限或bearer自报不能替代身份。
- [x] bounded input queue、slow-consumer disconnect、disconnect/resync、durable consumer checkpoint与overload typed error已有listener/daemon E2E；缺production attestor时listener不绑定。
- [x] production feature matrix已有`agent_supervisor`、`child_runtime_factory`与可选`peer_identity_attestor` evidence row；默认local daemon在真实adapter不齐时明确不advertise,不会占位启用。

### P1:Agent Supervisor、Budget 与远程终态

- [x] 本地 production interactive `AgentSupervisor` composition seam 已存在，并复用 root BudgetGuard、Workspace/capability/denial/merge adapters 与同一 parent gate；该窄边界证据固定到 `b175b84`。
- [x] started child 的process-resident terminal cleanup saga已按runtime -> Workspace -> Budget顺序提交typed receipt和aggregate completion，cancel/terminal interrupt/active-child close/process drain均走同一fail-closed边界；证据固定到`33b58ed`与§1.10。
- [x] `launch_rejected` not-started aggregate与Workspace authority receipt/cold replay已按`10f2908`及§1.12闭合；该窄勾选不激活任何production feature。
- [x] 本地process-resident child loop、provider/tool operation usage聚合与父reservation单次结算已按`754b903`、`bb533d3`、`e741c88`及§1.16闭合；deterministic/live happy path均通过。
- [x] Runtime-owned authority v2、root/per-agent budget与late usage reconciliation、cold partial decision、`stop_uncertain`、residency unload/reload和standby replacement已由`203fde6`闭合；真实Gateway/Sandbox/process-tree receipt缺失时仍不可advertise。
- [x] Runtime-owned remote execution authority和session handoff已闭合terminal idempotency、完整invocation/generation绑定、uncertain-effect reconciliation、File restart replay、target-commit-before-source-fence、cross-tenant与old-generation拒绝；真实CI/SSH/relay transport、credential、attestor、Sandbox/egress仍为`frozen-external-gap`,所以production remote能力不advertise且不回退本地执行。
- [x] same-session replacement已有standby candidate、fencing promotion、commit-before-old-drain、旧handle失效及commit前后故障矩阵；证据固定到`203fde6`/`0c6d1a1`。
- [x] Runtime-owned partial/final Artifact、handoff、deterministic merge/conflict与root cost reconciliation已有联合E2E；POSIX process group与Windows fail-closed fixture仍不能替代真实Sandbox/cgroup/PID namespace/Job Object联合证明。

### P1:跨域故障注入矩阵

feature-state/session-version/CLI action、legacy migration terminal、以及 Session/Artifact GC 引用图/dry-run/tombstone/tenant/crash replay 已有各自测试。Phase 11现已建立跨专项统一取证表,但跨平台结论尚未完成:

- [x] `harness/phase-11-fault-manifest.json`以固定字段把A–E的22个fault映射到注入点、预期event/receipt、recovery、owner、exact command、platform和test file；Harness Regression审计映射完整性。Linux的21条去重命令已逐项PASS。
- [ ] `cross-platform-pending`:darwin/win32没有实际runner或production preflight receipt；在两平台得到pass或明确`unsupported/deny`前,W5-J2、W5-G和W6-G保持pending。

## 5. 唯一恢复顺序引用

本文件不再维护第二套可执行顺序。最终串行波次、并行泳道、共享路径锁、join gate、命令和evidence格式统一以[`04-governed-agent-harness-runtime-plan.md` §12](04-governed-agent-harness-runtime-plan.md#12-最终严格执行计划)为准。任何实现先更新04中的task状态,再在本文件对应问题下补取证结论;两者冲突时以04的目标分支evidence为准,同时修正本文件。

现有剩余问题映射:

| 本文件问题 | 04最终执行单元 |
|---|---|
| Session/Artifact contract与salvage剩余边界 | W1-A、W1-B、W1-J |
| Workspace/Approval/Gateway专项加固 | `06`冻结external gap；Runtime消费与fail-closed接线为W2-D、W2-R3、W2-J |
| Extension resource enforcement与管理面 | `06`冻结external gap；Runtime消费snapshot/catalog/hook为W2-D、W2-R2、W2-J |
| Model/Plan/Context/Compaction/Memory专项生命周期 | `06`冻结external gap；Runtime request/session adapter为W2-D、W2-R1、W2-J |
| Verification/Orchestrator/Runtime-M1闭环 | W2-V、W2-J |
| child activation/cold recovery/partial merge | W3-M2 Runtime-owned completed；Gateway/Sandbox专项缺口保持`06`冻结 |
| HTTP/SSE、peer identity、queue、replacement与轻客户端 | W3-M3 Runtime-owned completed；OS peer adapter保持external gap |
| production multi-agent/daemon feature activation | W3-J Runtime-owned completed；缺required-adapter evidence时不advertise |
| managed policy、credential、真实remote/forge/supply-chain | `06`冻结external gap |
| Runtime remote/handoff、ChangeProposal/HumanGate repository、telemetry、GC | W4 Runtime-owned completed；真实transport/forge/organization/credential继续external gap |
| Runtime跨域故障注入与Harness Regression | W5 Linux evidence completed；W5-J2/W5-G等待darwin/win32 |
| Runtime-only验收、文档收敛与发布准备 | W6 Linux验收完成、commit待授权；W6-G等待跨平台结果 |

恢复实施时必须从04中第一个非`completed`的Wave开始。不得直接从本文件某个P0/P1条目跳过前置Wave,也不得把本文件的历史checkpoint当作当前task completion evidence。需要修改冻结专项时必须先按06 §7显式解冻,不能把该工作混入Runtime Wave。

## 6. 禁止用来“完成”本计划的捷径

- 不用 `as unknown as`、宽 `Record<string, unknown>`、optional/default 字段或删除 discriminant 来掩盖 canonical event/schema 不一致。
- 不把 fake adapter、module constructor、局部 24/24 tests 或历史通过记录写成 production composition 已完成。
- 不把 append accepted、stream done、queue empty、process exit、`Enqueued` 或 exporter attempted 写成 durable/verified/acknowledged。
- 不在 Gateway、sandbox、managed policy、credential、startup auditor 不可用时回退 `AllowAll`、unsandboxed、shared cwd 或低优先级本地配置。
- 不让模型 review、Builder stdout、candidate package script 或 candidate-owned test config签发 trusted pass。
- 不调用、重启或探测已暂停的 Boost MCP；继续使用普通 shell/filesystem 工具。
- 不在未经逐文件许可证确认的情况下复制 `claude-code-bun` 或其他参考仓库源码。

本文件的最终关闭条件是:所有剩余条目已迁入 `04` 唯一状态账本并附可复现目标分支证据，startup/Verification/Compaction/Draft PR/HumanGate/transport/remote 等上列边界全部闭合，完整门禁持续全绿，且不存在未解释的共享文件 owner 或未跟踪权威文档。本轮门禁全绿只关闭已列出的发现期阻断，不等于达到这一最终条件。
