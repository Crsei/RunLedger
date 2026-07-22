# Governed Agent Harness Runtime 剩余事项与取证问题

> 文档状态:open issues / handoff ledger,不是第二份实施计划或完成状态真源
> 取证时间:2026-07-22；收敛复核:2026-07-23T01:01:02+08:00；governed startup 复核:2026-07-23T02:12:47+08:00；durability hardening 复核:2026-07-23T03:27:40+08:00；continuous mutation 复核:2026-07-23T04:31:28+08:00；Approval active dependency 复核:2026-07-23T06:32:57+08:00
> 目标 worktree:`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-governed-runtime`
> 分支:`worktree/governed-agent-harness-runtime`
> 基线 commit:`65f905452195e034c99fa5ac560a7e23a822f052`
> 本轮实现检查点 commit:`004a2521934be745e8887f40f2b2631c392829dd`
> governed startup 切片 commit:`830a7232c0aec570917fc55c69145cce45fa31ab`
> production durability hardening commit:`2ca6f30b834410023ee77831c79d98714b11c103`
> continuous Workspace mutation gate commit:`ac524f42ea2033ac3aa1b8fd95aac654e372e68c`
> Approval active dependency commit:`f3e2ba6da4feb9af40889dab2e58ca7e1d604b01`
> 权威计划:[`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md)

本文件只记录本轮参考审查、计划审计和实现 worktree 检查中遇到的问题、未完成项与恢复顺序。任何条目都不能因为“已有文件”“定向测试曾通过”或“代码量较大”而视为完成。完成状态必须回写到同步后的 `04`，并附目标分支 commit、定向测试、完整门禁和专项联合证据。

## 1. 当前快照与验证结论

### 1.1 权威计划已去分叉

2026-07-22 发现的 1605 行旧版与 2124 行新版分叉已经收敛。在 `60373d6` 文档基线，目标 worktree 与主 checkout 的 `04` 均为 2124 行，SHA-256 都是 `192ba4b187e1321511db297deeaf9bad10bb7077489c6471e39d0fcd8b2b5ccd`，内容逐字相同。此后目标分支按 `830a723`、`2ca6f30`、`ac524f4` 的真实实现追加 scoped evidence，主 checkout 仍停留在 2124 行基线且保持干净；这是未合并分支上的可追踪证据增量，不是重新出现两份互相竞争的计划。

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

### 1.8 本轮查找与验证过程中的问题

- 一次范围过宽的 `/tmp` 只读搜索从旧的、与当前仓库无关的临时日志中把一条 credential 显示到了工具输出。该值没有被复述、使用、写入仓库或提交；当时实现检查点涉及的 20 条代码/测试路径已用只输出文件名的私钥、AWS key、`sk-*` 模式复检，无命中。由于轮换凭据和清理旧临时日志属于额外外部/破坏性状态变更，本轮没有擅自执行；相关 credential 应尽快轮换，并单独清理或收紧旧日志权限。
- live smoke 首次预检误把实际 `AuthCheck = { type, source? }` 当成含 `configured` 字段，因此在网络请求前主动失败。按真实契约改为检查返回值是否存在后重跑成功；没有为这个 one-off runner 修改仓库代码。
- 本阶段 live smoke 的第一次 runner 选择了 Node 原生 `--experimental-strip-types`，因该 loader 不解析 `src/runtime/ledger/memory-ledger.ts` 中现有 `.js` 相对导入而在网络请求前以 `ERR_MODULE_NOT_FOUND` 退出；随后改用项目已安装的 `tsx`，同一 auth/provider/Agent/tool 路径成功。失败尝试未读取或输出凭据，也没有修改仓库。
- 两次成功 live smoke 都使用内联 runner，当前没有可持久复跑的脚本、durable session、governed state-root 或真实 mutation-gate audit；所以证据只记录 provider/Agent/tool/ledger 连通性，不能提升任何 governed startup、Verification 或 Phase 11 复选框。

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
- [ ] 仍缺 candidate-untrusted collector/config/lockfile-source 的真实生产 E2E；dependency cooling/admission 与 Secret Scan 还没有成为独立的 Harness Regression/CI 必选命令。

### 3.3 RuntimeActivity 与 daemon mutation effect

- [x] RuntimeActivity 统一为 canonical v2；legacy v1 只读识别，telemetry、daemon、Control Plane query 和 replay 共用 projector/digest fixture。
- [x] 修复 terminal status 缩窄；Activity/Cost 4/4、Control Plane Activity/effect 5/5 通过。
- [x] daemon query failure 的 `MutationEffect` 显式映射为 `committed|none -> none`、`uncertain|absent -> uncertain`，原始 effect 留在 `details.storeEffect`；没有扩宽联合掩盖语义。

### 3.4 Control Plane command restart

- [x] 全部 13 类 mutation 的 `command.applied`/`command.rejected` 持久化 bounded typed result/error，并与 command type、request digest、idempotency claim、revision/cursor 绑定。
- [x] `authority-command-idempotency.test.ts` 57/57 覆盖 success、typed rejection、uncertain reconcile、重复 commandId 与 changed digest restart；resolver/cache 不能遮蔽 canonical terminal truth。
- [x] fork 使用 child cursor、session bootstrap 非空 head、interrupt mandatory durable cursor 已有回归；Control Plane/daemon/core attack 联合 25 files / 173 tests 通过。

## 4. 当前明确未完成的功能边界

### P0:Production state root、Workspace/Approval 持续门禁已接线，child/replacement 与 durable cleanup 仍未闭合

`830a723` 已关闭此前“既有 V3 CLI/daemon 直接 open 后只看本地 recoveryDecision”的已知旁路；`2ca6f30` 继续关闭 production state-root 组合、durable-store 联合 E2E、Approval terminal projection 和 governed open/CLI/factory cleanup failure 丢失；`ac524f4` 关闭 Workspace lease 的持续 mutation gate；`f3e2ba6` 再关闭 production Tool Gateway 的 interactive Approval active dependency 与 durable start fence。但 production child spawn、replacement/idle、pending prompt 重启恢复、extension hook journal 与 durable cleanup 仍不闭合。

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
- [ ] Approval 全局可操作性仍未闭合：pending prompt/waiter 不能跨重启恢复，system/interactive actor 尚无 authority/deployment 与 channel-bound identity proof，自动 Gateway admission deny 缺独立 canonical 审计事件，extension hook 缺 production start journal，公开 revoke 命令与真实活跃期 corruption/kill/TOCTOU 矩阵仍缺失。不能把 Tool Gateway 窄切片写成 Approval 系统整体完成。
- [ ] `SessionMutationKind` 已包含 `child_spawn`，但 `ProductionChildSessionLauncher` 尚未接线；child launch 前外部 receipt 复检和零调用 fault assertion 仍缺失。
- [ ] idle unload/reload 与 same-session hot replacement 尚未接入同一 governed gate；replacement 仍缺 standby candidate、fencing promotion、commit-before-old-drain 和 commit 后失败终态的 fault E2E。
- [ ] injected-auditor tests 已覆盖 timeout/throw/partial/abort，真实 file-store startup E2E 已覆盖 exact/stale/revoked/expired/missing，持续 gate deterministic tests 已覆盖 Workspace/Approval mutation 与 latch；仍缺真实 file-store 活跃期文件损坏、root/store TOCTOU、进程 kill 与 restart reconciliation 的 CLI/daemon 联合矩阵，以及 production child 的零调用断言。
- [x] `src/cli/main.ts`、governed open 与 factory start/resume/fork 不再吞掉已知 close/discard failure；多资源 cleanup 会等待并展开全部错误，durable start/fork ownership transfer 前失败会返回不可重试 uncertain effect 与 session correlation，fork parent close 失败不会遗留 active child runtime。
- [ ] 全仓 cleanup 尚未闭合：`src/daemon/local-v3-daemon.ts` 在 runtime-generation/shutdown-protocol 早期失败时仍吞 `authorityRuntime.close()` 错误，`src/storage/authority-runtime-manager.ts` open 失败仍吞 event-store close 错误。后续必须保留 primary + cleanup failure，并增加故障注入。
- [ ] cleanup failure 目前对调用方可见，但尚未形成独立 canonical terminal cleanup event/receipt，也没有覆盖 kill-after-side-effect、process restart 后 orphan writer/lease/child 的自动 reconciliation；因此仍不能宣称所有资源均有 durable terminal cleanup outcome。

### P0:Verification/Compaction 只有模块，不是生产生命周期

现有 production interactive composition 可在 verifier ports 全部返回 `evidence_unavailable/not invoked by composition` 时仍构造成功；这只证明服务模块可组装，不证明真实 prompt 生命周期会驱动 gate。

- [ ] 增加真实 `prompt -> goal -> approved plan -> build -> test -> security/review -> reverification -> EpisodeSeal -> terminal` E2E。
- [ ] 增加 overflow -> safe-point compaction -> invariant validation -> durable replacement -> CAS install E2E；任一 crash/validation failure 保留旧投影并 paused。
- [ ] Builder/test-generator/reviewer/security-reviewer 的 workspace、context、capability 和 issuer 真正隔离；模型输出只能形成 candidate/inconclusive。
- [ ] 生产 composition 缺 trusted verifier、Browser backend、Workspace/Gateway/Sandbox/Artifact receipt 时不 advertise completion capability。

### P1:Draft PR 与 Human Gate

- [ ] 实现 durable `ChangeProposalService`/projection、真实 forge provider adapter 和只创建 Draft PR 的命令路径。
- [ ] 实现持久 HumanGate coordinator，绑定独立 principal、organization policy、EpisodeSeal、proposal revision 与 separation-of-duty receipt。
- [ ] 已有 opaque audience-bound grant、expiry/stale/cross-tenant、revoke replay、server/resource/command scope、nonce/revoked-key tests；仍缺它们与真实 forge、HumanGate、organization gate 的 production composition 联合 E2E。
- [ ] merge/deploy 在任何缺少 human/organization terminal receipt 的路径上保持不可达。

### P1:Control Plane transport 与本地身份

- [ ] HTTP/SSE listener 仍未完成生产闭环；必须复用同一 command/query/event schema，而非第二套状态机。
- [ ] Unix socket/Windows pipe 的 peer credential/channel binding 与 principal 映射未完成；socket 路径权限或 bearer 自报不能替代身份。
- [ ] bounded input queue、slow consumer、disconnect/resync、durable consumer checkpoint 和 overload typed error 需要完整 E2E。
- [ ] 默认 local daemon 因 production adapter matrix 不齐可能不 advertise shutdown/其他 mutation；需要明确 feature row 与真实 adapter receipt，而不是占位启用。

### P1:Agent Supervisor、Budget 与远程终态

- [ ] Production `AgentSupervisor` 和 root/per-agent budget 默认值、spawn fail-closed、residency eviction 条件尚未形成完整 production composition。
- [ ] remote executor/agent handoff 的 terminal idempotency、attestation、uncertain side-effect reconciliation 和 restart replay 尚未闭合。
- [ ] same-session hot replacement 缺 standby candidate、lease/fencing promotion、commit-before-old-drain 和 commit 后失败终态的完整实现/故障注入。
- [ ] multi-agent partial Artifact、merge conflict、child workspace/capability subset 与 root cost reconciliation 仍需联合 E2E。

### P1:跨域故障注入矩阵

feature-state/session-version/CLI action、legacy migration terminal、以及 Session/Artifact GC 引用图/dry-run/tombstone/tenant/crash replay 已有各自测试。当前缺的是跨专项统一取证表:

- [ ] 把 approval timeout、replacement init failure、daemon side-effect restart、signal/EOF/uncaught/upgrade、remote uncertain、GC crash 映射为“注入点 -> 预期 event/receipt -> recovery -> owner -> test command”，并由对应专项联合门禁消费。

## 5. 建议恢复顺序

1. 将同一 gate 接入 `ProductionChildSessionLauncher.child_spawn`，明确拒绝/throw/abort 后 launcher workspace validation、launch claim、child genesis 和 snapshot 全部零调用；同时记录当前尚无真实 production launcher composition 的边界。
2. 接 idle unload/reload 与 same-session replacement；replacement 必须具备 standby candidate、writer fencing promotion、commit-before-old-drain 和 post-commit failure terminal。
3. 清除 daemon/authority 剩余吞错 close，为 cleanup 增加 canonical terminal receipt、kill/restart orphan reconciliation，并补活跃期 store corruption 与 root/store TOCTOU 联合 E2E。
4. 补 pending Approval prompt 重建、authority/channel-bound actor、独立 Gateway denial audit、public revoke command 和 extension hook canonical start journal；不得把这些事件伪装成既有 interactive request lifecycle。
5. 接通真实 Verification/Compaction prompt 生命周期和 required production composition matrix。
6. 推进 Draft PR/HumanGate、HTTP/SSE 与 OS peer identity、Production AgentSupervisor、remote/handoff/hot replacement。
7. 补齐跨域故障注入矩阵；每个切片先跑定向/fault/security tests，再跑完整五项门禁，只有目标分支证据可回写 `04`。

## 6. 禁止用来“完成”本计划的捷径

- 不用 `as unknown as`、宽 `Record<string, unknown>`、optional/default 字段或删除 discriminant 来掩盖 canonical event/schema 不一致。
- 不把 fake adapter、module constructor、局部 24/24 tests 或历史通过记录写成 production composition 已完成。
- 不把 append accepted、stream done、queue empty、process exit、`Enqueued` 或 exporter attempted 写成 durable/verified/acknowledged。
- 不在 Gateway、sandbox、managed policy、credential、startup auditor 不可用时回退 `AllowAll`、unsandboxed、shared cwd 或低优先级本地配置。
- 不让模型 review、Builder stdout、candidate package script 或 candidate-owned test config签发 trusted pass。
- 不调用、重启或探测已暂停的 Boost MCP；继续使用普通 shell/filesystem 工具。
- 不在未经逐文件许可证确认的情况下复制 `claude-code-bun` 或其他参考仓库源码。

本文件的最终关闭条件是:所有剩余条目已迁入 `04` 唯一状态账本并附可复现目标分支证据，startup/Verification/Compaction/Draft PR/HumanGate/transport/remote 等上列边界全部闭合，完整门禁持续全绿，且不存在未解释的共享文件 owner 或未跟踪权威文档。本轮门禁全绿只关闭已列出的发现期阻断，不等于达到这一最终条件。
