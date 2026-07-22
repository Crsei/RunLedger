# Governed Agent Harness Runtime 剩余事项与取证问题

> 文档状态:open issues / handoff ledger,不是第二份实施计划或完成状态真源
> 取证时间:2026-07-22；收敛复核:2026-07-23T01:01:02+08:00；governed startup 复核:2026-07-23T02:12:47+08:00
> 目标 worktree:`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-governed-runtime`
> 分支:`worktree/governed-agent-harness-runtime`
> 基线 commit:`65f905452195e034c99fa5ac560a7e23a822f052`
> 本轮实现检查点 commit:`004a2521934be745e8887f40f2b2631c392829dd`
> governed startup 切片 commit:`830a7232c0aec570917fc55c69145cce45fa31ab`
> 权威计划:[`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md)

本文件只记录本轮参考审查、计划审计和实现 worktree 检查中遇到的问题、未完成项与恢复顺序。任何条目都不能因为“已有文件”“定向测试曾通过”或“代码量较大”而视为完成。完成状态必须回写到同步后的 `04`，并附目标分支 commit、定向测试、完整门禁和专项联合证据。

## 1. 当前快照与验证结论

### 1.1 权威计划已去分叉

2026-07-22 发现的 1605 行旧版与 2124 行新版分叉已经收敛。在 `60373d6` 文档基线，当前 worktree 与主 checkout 的 `04` 均为 2124 行，SHA-256 都是 `192ba4b187e1321511db297deeaf9bad10bb7077489c6471e39d0fcd8b2b5ccd`，内容逐字相同。本轮只在目标 worktree 追加 `830a723` 的 scoped evidence；主 checkout 保持干净且未被旁路修改，待该分支正常合并后再同步。

- [x] 以 2124 行版本作为唯一 canonical 文件，保留新增证据规则、I0-I7 串行账本、兼容矩阵和 13 类 mutation restart 要求。
- [x] 没有迁移旧版 147 个无完整证据的勾选；当前 `04` 有 343 个真实未勾选任务，唯一 `[x]` 位于 §9.2 模板示例，不是完成声明。
- [x] `00-reference.md`、`04`、三份专项 owner 计划与 `development-doc/00-index.md` 由本文件所在文档提交落入当前目标分支；实现证据固定到 `004a2521934be745e8887f40f2b2631c392829dd`。

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

### P0:Governed startup 已有入口门禁，但生产状态根与持续执行门禁仍未闭合

`830a723` 已关闭此前“既有 V3 CLI/daemon 直接 open 后只看本地 recoveryDecision”的已知旁路，但只构成 startup/admission 切片，不等于整个 session 生命周期持续受外部 receipt 约束。

- [x] 既有 V3 CLI open/fork、factory resume/fork、daemon cold recovery 与 partial migration resume 统一先经过 `GovernedV3SessionRuntime`；审计未通过时不会进入 controller/model/tool、candidate authority、agent binding 或 child creation。
- [x] Workspace lease 与 Approval receipt 的 exact digest/revision/expiry/state、partial/unknown completeness、missing/store throw/timeout/abort/畸形 receipt 均 fail closed；非 `allowed` Approval 即使被 adapter 伪报 valid 也只能 paused。
- [x] 单调用 timeout 与整次 scan deadline 有界；adapter 忽略 `AbortSignal` 时，首个 timeout/abort 后停止启动后续 audits，不会按 10,000-item 上限继续制造悬挂调用。
- [x] 缺 auditor 的默认 sentinel 对含 external refs 的 session fail closed；确无 external refs 的 clean/new session 不需要伪造 Workspace/Approval receipt。
- [ ] 标准 CLI/daemon 目前只有可选 auditor 注入，尚未从 deployment-owned canonical state root 自动组合 `FileWorkspaceLeaseMutationPort`、`FileApprovalStateStore` 与 `DurableStartupExternalReceiptAuditor`；缺少“同一 scope/root 的真实 file stores -> auditor -> CLI/daemon”联合 E2E。
- [ ] admission callback 只在入口复检 Approval `validThrough`，随后 CLI/factory 仍持有裸 `V3SessionManager`；尚无 model/tool/child 每次 mutation 的持续 expiry/revocation 复检，Workspace lease 在 admission 后被撤销也不会自动关闭 mutation gate。
- [ ] idle unload/reload 与 same-session hot replacement 尚未接入同一 governed gate；replacement 仍缺 standby candidate、fencing promotion、commit-before-old-drain 和 commit 后失败终态的 fault E2E。
- [ ] 当前 CLI invalid-lease 与 daemon cold-recovery E2E 只证明代表性入口；仍需对 stale/revoked/unavailable Workspace、Approval、timeout/throw/partial 分别跑 durable-store 联合 E2E，并精确断言 model/tool/child instrumentation 全程为零。
- [ ] 资源清理仍有非 CLI-command 漏洞：`src/cli/main.ts` 最终 `closeSessionRuntime()` 继续吞掉 close/lease-release 错误；`src/storage/v3-runtime-adapter.ts` 的 open 失败 close，以及 `src/daemon/v3-session-adapters.ts` 的 resume/start/fork cleanup 仍有 `catch(() => undefined)`。这阻止宣称“所有 writer/lease 都有可见 terminal cleanup outcome”。

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

1. 从 deployment-owned state root 组合真实 lease/approval stores 与 durable auditor，并补 CLI/daemon durable-store 联合 E2E。
2. 把外部 receipt 的持续 expiry/revocation 复检接到 model/tool/child mutation、idle reload 与 replacement；同时让所有 close/lease-release failure 形成可见 terminal outcome。
3. 接通真实 Verification/Compaction prompt 生命周期和 required production composition matrix。
4. 推进 Draft PR/HumanGate、HTTP/SSE 与 OS peer identity、Production AgentSupervisor、remote/handoff/hot replacement。
5. 补齐跨域故障注入矩阵；每个切片先跑定向/fault/security tests，再跑完整五项门禁，只有目标分支证据可回写 `04`。

## 6. 禁止用来“完成”本计划的捷径

- 不用 `as unknown as`、宽 `Record<string, unknown>`、optional/default 字段或删除 discriminant 来掩盖 canonical event/schema 不一致。
- 不把 fake adapter、module constructor、局部 24/24 tests 或历史通过记录写成 production composition 已完成。
- 不把 append accepted、stream done、queue empty、process exit、`Enqueued` 或 exporter attempted 写成 durable/verified/acknowledged。
- 不在 Gateway、sandbox、managed policy、credential、startup auditor 不可用时回退 `AllowAll`、unsandboxed、shared cwd 或低优先级本地配置。
- 不让模型 review、Builder stdout、candidate package script 或 candidate-owned test config签发 trusted pass。
- 不调用、重启或探测已暂停的 Boost MCP；继续使用普通 shell/filesystem 工具。
- 不在未经逐文件许可证确认的情况下复制 `claude-code-bun` 或其他参考仓库源码。

本文件的最终关闭条件是:所有剩余条目已迁入 `04` 唯一状态账本并附可复现目标分支证据，startup/Verification/Compaction/Draft PR/HumanGate/transport/remote 等上列边界全部闭合，完整门禁持续全绿，且不存在未解释的共享文件 owner 或未跟踪权威文档。本轮门禁全绿只关闭已列出的发现期阻断，不等于达到这一最终条件。
