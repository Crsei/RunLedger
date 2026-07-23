# Phase 4:Artifact CAS、脱敏、Retention 与 Episode 骨架

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 3](phase-03-capability-approval-sandbox-contracts.md) / [Phase 5](phase-05-resource-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前验收状态:`Runtime Artifact behavior completed; external Workspace/Security behavior unavailable`。Runtime-M0 仍受 W1-B、W1-J 与 W1-G 门禁约束。
> 当前实施基线:2026-07-24T01:53:22+08:00,`worktree/governed-agent-harness-runtime@5cfaaa3b1b7ec55e12a956ad3aa3f51797b56489 + working tree`;Phase 4 汇总`20 files / 122 tests PASS`。

目标:把大输出、diff、日志和验证证据从消息/tmp 文件升级为可寻址、可授权、可清理的 Artifact。

前置:Phase 2、Phase 3 的数据契约。涉及 workspace materialize/rewind/cleanup 或 Artifact 访问授权的行为验收,额外依赖 Worktree/Sandbox/Permission 专项计划对应实现阶段。

计划文件:

- 新增 `src/runtime/artifacts/{types,cas-store,metadata-store,access,key-provider,redaction,retention,episode-manifest}.ts`。
- 对 `src/runtime/tools/tool-support.ts`、stdlib tools 与 `src/storage/paths.ts` 的接线只由 §0.6 I2/WorkspaceSecurity-Phase5 owner 完成;Artifact 模块开发期间不并发修改这些共享文件。
- 新增 `tests/runtime-v3/artifacts/`。

任务:

| 闭合任务 | 状态 | 最近更新 |
|---|---|---|
| P4-C1 CAS blob 与 metadata | completed | 2026-07-24T01:35:24+08:00 定向验证通过 |
| P4-C2 intent/commit/reconcile | completed | 2026-07-24T01:35:52+08:00 定向验证通过 |
| P4-C3 external delivery lifecycle | completed | 2026-07-24T01:36:24+08:00 定向验证通过 |
| P4-C4 metadata 与 lineage | completed | 2026-07-24T01:37:02+08:00 定向验证通过 |
| P4-C5 source/transform/taint receipt | completed | 2026-07-24T01:37:34+08:00 定向验证通过 |
| P4-C6 OS keyring ArtifactKeyProvider | completed | 2026-07-24T01:38:04+08:00 定向验证通过 |
| P4-C7 bounded tool result Artifact | completed | 2026-07-24T01:38:35+08:00 定向验证通过 |
| P4-C8 write-time redaction | completed | 2026-07-24T01:39:03+08:00 定向验证通过 |
| P4-C9 authorized encrypted forensic raw | completed | 2026-07-24T01:39:36+08:00 定向验证通过 |
| P4-C10 key unavailable degradation | completed | 2026-07-24T01:40:04+08:00 定向验证通过 |
| P4-C11 governed salvage Artifact | completed | 2026-07-24T01:34:27+08:00 committed-only adapter 与完整门禁通过 |
| P4-C12 Artifact-backed queue recovery | completed | 2026-07-24T01:45:26+08:00 startup fail-closed matrix 与完整门禁通过 |
| P4-C13 retention 与 dry-run GC | completed | 2026-07-24T01:46:14+08:00 定向验证通过 |
| P4-C14 Artifact access reauthorization | completed | 2026-07-24T01:46:49+08:00 定向验证通过 |
| P4-C15 Episode Manifest | completed | 2026-07-24T01:47:27+08:00 定向验证通过 |
| P4-C16 legacy tool-output import | completed | 2026-07-24T01:48:04+08:00 定向验证通过 |
| P4-C17 CompositeCheckpoint | completed | 2026-07-24T01:48:33+08:00 定向验证通过 |
| P4-C18 WorkspaceSnapshotManifest | completed | 2026-07-24T01:49:06+08:00 定向验证通过 |
| P4-C19 partial checkpoint semantics | completed | 2026-07-24T01:50:40+08:00 定向验证通过 |
| P4-C20 rewind receipt leaf activation | completed | 2026-07-24T01:51:15+08:00 定向验证通过 |
| P4-C21 cleanup fencing receipt | completed | 2026-07-24T01:51:44+08:00 定向验证通过 |

- [x] Blob 以 SHA-256 stored digest 分层存储,临时文件 write+sync+atomic rename,metadata 独立持久化。
- [x] Artifact 写入遵循 intent event -> pending blob/metadata -> committed event -> visible reference;startup 回收或补记 orphan。
- [x] external upload/export 状态至少区分 accepted/enqueued、durable、content-verified、externally acknowledged 与 failed;`Enqueued` 永远不能计入 fully uploaded、Episode evidence 或允许本地 cleanup 的 terminal 集合。
- [x] metadata 记录 kind/media type/size/compression/source session/workspace/producer/references/expiry/redaction,并绑定完整 `InputSourceRef[]`、taint 上界和适用的 `DeclassificationReceiptRef[]`;缺失 lineage 的外部/candidate/model-derived Artifact 只能 quarantine,不能进入危险 sink 或 Verification pass。
- [x] 同时记录 stored digest、受保护的 source receipt、redaction policy/version 和 transform receipt;transform/summary/merge 只能保留或提高 taint 上界,去污必须引用仍有效且 sink 匹配的 receipt。敏感低熵原文使用 keyed digest,避免普通 source hash 被离线猜测。
- [x] 定义 ArtifactKeyProvider;本地版只接受 OS keyring-backed versioned key,支持 rotation/loss 状态,不允许 0600 明文 key fallback。Phase 11 仅替换为 KMS provider。
- [x] tool result 在 prompt 中只保留 bounded summary + ArtifactRef。
- [x] 写入前运行 secret/credential/path/prompt redaction;默认不保留 raw content。
- [x] forensic raw 只能在显式授权后加密存储,单独 retention 和 access log。
- [x] key provider 不可用时禁用 keyed source receipt 和 encrypted forensic raw,仍可保存已脱敏 stored blob,并在 metadata/manifest 明确降级状态。
- [x] 将 Phase 1 的 bounded `SalvageReport`/offline digest 适配成只读、受授权、带 source digest 与 unattested 标记的 Artifact;CAS 不可用时 Phase 1 仍可完成报告,但最终 governed salvage 验收必须等待该适配。
- [x] 在 `ArtifactRef` exact schema 冻结后版本化启用 `QueueItemV3` 的 Artifact-backed payload variant;旧 Phase 1 inline fixture 保持可读,缺失 blob/ref 的 queue item 只能 pause/corrupted。
- [x] retention 支持 TTL、pin、reference count、legal hold placeholder 和 dry-run GC。
- [x] 读取 Artifact 时把 session/workspace/capability refs 交给注入的 `CapabilityGatewayPort` 重新检查,Runtime Artifact 模块不实现权限规则。
- [x] 初版 Episode Manifest 聚合 identity、event head、workspace/base、artifact refs、permission refs、cost/verification 占位。
- [x] 兼容旧 `tmp/tool-output-*`:只读 import 时标为 legacy/unverified,不假装已有 digest 证据。
- [x] 把 Phase 1 logical checkpoint、Phase 2 WorkspaceCheckpointDescriptor、diff/untracked Artifact 合成 CompositeCheckpoint。
- [x] 定义版本化 WorkspaceSnapshotManifest 数据结构:HEAD/base、raw index/各 conflict stage、staged/unstaged 状态、tracked/untracked Artifact refs、file mode、symlink target、submodule/LFS/exclusion/size-limit 状态;具体 Git 采集与恢复由专项实现。
- [x] checkpoint schema 对 ignored exclusion、dirty submodule、缺失 LFS object、超限或不可表示状态表达 `partial`;是否允许物理 rewind 由注入的 Workspace 服务判定。
- [x] Runtime 只在 Workspace 服务返回可验证 rewind receipt 后激活新 leaf;失败保留原 workspace/leaf。
- [x] cleanup 只提交 CompositeCheckpointRef、WorkspaceExecutionEnvelope 和预期 lease revision,由 Workspace 服务复核并执行;Runtime 记录返回的 pending-GC/terminal receipt。

本轮实现:

- `P4-C11`:新增 additive v1 `GovernedSalvageAuthorizationRequest/Decision/Receipt` exact schema、opaque authorization port 和 committed-only adapter。授权的`allow`必须携带 scope-correlated receipt;`ask/deny/unavailable`、跨 scope、CAS pending 或写入失败均不返回 ArtifactRef。Phase 1 离线报告接口保持不变,报告继续保留`sourceDigest`、`reportDigest`、`readOnly:true`与`attestation:"unattested"`;后续读取仍必须经`ArtifactAccessService`。
- `P4-C12`:新增不返回正文的`ArtifactQueueRecoveryValidator`,在 V3 startup Artifact reconciliation 后逐项复核 pending queue 的 committed metadata、完整`ArtifactRef`与 blob digest。缺失 metadata/blob、跳过或未完成 reconciliation 时稳定进入`reconciliation_required:pending_queue_artifact_unavailable`;reference/metadata/blob digest 已证实不一致时进入`corrupted`。`open`、手动 reconcile 与`refreshRecoveryDecision()`共用同一检查,旧 bounded-text queue 和现有 QueueItemV3 wire shape 不变;正文 adoption 仍等待注入的授权 resolver。
- golden fixture为`tests/runtime-v3/artifacts/fixtures/salvage-artifact-v1.json`,receipt body digest=`a25818819f9241dbc1234d1e079d44412dfbb30616c98a9b5dd00ddfa8d1c5d0`,fixture SHA-256=`06fea0111bec125391e9ad1dc543c68830dae5d0da6449df59bfd87d58685a12`。
- 最终验收:2026-07-24T01:53:22+08:00,Phase 4 汇总`20 files / 122 tests PASS`;冻结`tests/security tests/worktree`为`21 files / 119 tests PASS`;`npm run check`、`npm test`(`265 files / 1747 tests PASS`,另有`1 file / 1 opt-in test SKIP`)、`npm run build`与`git diff --check`均PASS。salvage/Workspace/Capability fixture SHA-256分别为`06fea0111bec125391e9ad1dc543c68830dae5d0da6449df59bfd87d58685a12`、`81bb3c69b56039492fbc5c2260b63e8358e097a0aae8a3f2fa44ef15359445d4`、`ebe846c2e64658fff82a9059c809931ad352f28f026cd6e702b646addc1ab2bc`。结论:`Runtime Artifact behavior completed; external Workspace/Security behavior unavailable`。

逐项闭合记录:

- `P4-C1`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/cas-store.test.ts`;结果`PASS,1 file / 10 tests`;fixture`N/A`;结论`Runtime CAS behavior completed; remote/enterprise storage unavailable`;验证时间`2026-07-24T01:35:24+08:00`。
- `P4-C2`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/cas-store.test.ts tests/runtime-v3/artifacts/session-journal.test.ts`;结果`PASS,2 files / 14 tests`;fixture`N/A`;结论`Runtime crash reconciliation completed; external durable backend unavailable`;验证时间`2026-07-24T01:35:52+08:00`。
- `P4-C3`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/external-delivery.test.ts`;结果`PASS,1 file / 3 tests`;fixture`N/A`;结论`delivery projection completed; real external uploader unavailable`;验证时间`2026-07-24T01:36:24+08:00`。
- `P4-C4`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/cas-store.test.ts tests/runtime-v3/artifacts/lineage.test.ts`;结果`PASS,2 files / 13 tests`;fixture`N/A`;结论`metadata/lineage behavior completed; external policy enforcement unavailable`;验证时间`2026-07-24T01:37:02+08:00`。
- `P4-C5`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/redaction.test.ts tests/runtime-v3/artifacts/lineage.test.ts`;结果`PASS,2 files / 8 tests`;fixture`N/A`;结论`source/transform/taint contract completed; policy authority unavailable`;验证时间`2026-07-24T01:37:34+08:00`。
- `P4-C6`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/linux-kernel-keyring.test.ts`;结果`PASS,1 file / 7 tests`;fixture`N/A`;结论`local OS-keyring adapter completed; KMS provider unavailable`;验证时间`2026-07-24T01:38:04+08:00`。
- `P4-C7`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/tool-result-sink.test.ts tests/runtime-v3/artifacts/governed-tool-result-budget.test.ts`;结果`PASS,2 files / 2 tests`;fixture`N/A`;结论`governed bounded result behavior completed; legacy tmp fallback unavailable by design`;验证时间`2026-07-24T01:38:35+08:00`。
- `P4-C8`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/redaction.test.ts`;结果`PASS,1 file / 5 tests`;fixture`N/A`;结论`write-time redaction completed; organization-specific detector policy unavailable`;验证时间`2026-07-24T01:39:03+08:00`。
- `P4-C9`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/redaction.test.ts tests/runtime-v3/artifacts/access.test.ts`;结果`PASS,2 files / 10 tests`;fixture`N/A`;结论`encrypted forensic behavior completed; production approval policy unavailable`;验证时间`2026-07-24T01:39:36+08:00`。
- `P4-C10`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/redaction.test.ts tests/runtime-v3/artifacts/manifests.test.ts tests/runtime-v3/artifacts/linux-kernel-keyring.test.ts`;结果`PASS,3 files / 17 tests`;fixture`N/A`;结论`degraded metadata/manifest behavior completed; enterprise key service unavailable`;验证时间`2026-07-24T01:40:04+08:00`。
- `P4-C11`:实现基线`5cfaaa3b1b7ec55e12a956ad3aa3f51797b56489 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/salvage-adapter.test.ts tests/runtime-v3/session/salvage.test.ts`;结果`PASS,2 files / 9 tests`;Phase 4 汇总`PASS,19 files / 116 tests`;`npm run check`、`npm test`、`npm run build`、冻结`tests/security tests/worktree`与`git diff --check`均PASS;fixture SHA-256=`06fea0111bec125391e9ad1dc543c68830dae5d0da6449df59bfd87d58685a12`;结论`Runtime behavior completed; production authorization policy unavailable`;验证时间`2026-07-24T01:34:27+08:00`。
- `P4-C12`:实现基线`5cfaaa3b1b7ec55e12a956ad3aa3f51797b56489 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/queue-recovery.test.ts tests/runtime-v3/session/snapshot.test.ts tests/runtime-v3/session/recovery.test.ts tests/runtime-v3/session/v3-session-manager.test.ts`;结果`PASS,4 files / 57 tests`;Phase 4 汇总`PASS,20 files / 122 tests`;`npm run check`、`npm test`(`265 files / 1747 tests PASS`,另有1 file / 1 opt-in test SKIP)、`npm run build`、冻结`tests/security tests/worktree`与`git diff --check`均PASS;既有 Workspace/Capability fixture digest不变;结论`startup integrity behavior completed; authorized content resolver unavailable`;验证时间`2026-07-24T01:45:26+08:00`。
- `P4-C13`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/retention.test.ts tests/runtime-v3/artifacts/external-delivery.test.ts tests/runtime-v3/lifecycle/gc.test.ts`;结果`PASS,3 files / 13 tests`;fixture`N/A`;结论`local/reference-aware GC behavior completed; enterprise retention backend unavailable`;验证时间`2026-07-24T01:46:14+08:00`。
- `P4-C14`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/access.test.ts tests/runtime-v3/artifacts/lineage.test.ts`;结果`PASS,2 files / 8 tests`;fixture`N/A`;结论`Runtime reauthorization behavior completed; production Gateway policy unavailable`;验证时间`2026-07-24T01:46:49+08:00`。
- `P4-C15`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/manifests.test.ts`;结果`PASS,1 file / 5 tests`;fixture`N/A`;结论`Episode Manifest contract completed; production evidence issuer unavailable`;验证时间`2026-07-24T01:47:27+08:00`。
- `P4-C16`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/legacy-import.test.ts`;结果`PASS,1 file / 2 tests`;fixture`N/A`;结论`legacy read-only import completed; legacy content remains unverified`;验证时间`2026-07-24T01:48:04+08:00`。
- `P4-C17`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/manifests.test.ts`;结果`PASS,1 file / 5 tests`;fixture`N/A`;结论`CompositeCheckpoint contract completed; physical capture/rewind unavailable in Runtime`;验证时间`2026-07-24T01:48:33+08:00`。
- `P4-C18`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/manifests.test.ts`;结果`PASS,1 file / 5 tests`;fixture`N/A`;结论`WorkspaceSnapshotManifest contract completed; Git capture/restore unavailable in Runtime`;验证时间`2026-07-24T01:49:06+08:00`。
- `P4-C19`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/manifests.test.ts`;结果`PASS,1 file / 5 tests`;fixture`N/A`;结论`partial checkpoint semantics completed; physical rewind policy unavailable in Runtime`;验证时间`2026-07-24T01:50:40+08:00`。
- `P4-C20`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/workspace-checkpoint.test.ts`;结果`PASS,1 file / 2 tests`;fixture`N/A`;结论`receipt-gated leaf activation completed; external Workspace rewind behavior unavailable`;验证时间`2026-07-24T01:51:15+08:00`。
- `P4-C21`:实现基线`004a252`、审计基线`5cfaaa3 + working tree`;命令`npx vitest run tests/runtime-v3/artifacts/workspace-checkpoint.test.ts`;结果`PASS,1 file / 2 tests`;fixture`N/A`;结论`cleanup fencing and receipt correlation completed; external Workspace cleanup/GC behavior unavailable`;验证时间`2026-07-24T01:51:44+08:00`。

故障注入:

- partial blob、metadata 写失败、rename 冲突、disk full、digest mismatch、GC 与并发 read 竞争。
- Workspace 服务返回 partial rewind、Git/FS 结果不一致或 owner/lease 改变时,不得激活新 leaf 或清理原 workspace。
- intent/commit 任一侧 crash、redaction transform 失败、workspace rewind 中断和 cleanup fencing 失效。

完成门槛:

- 相同内容去重且 metadata 引用隔离。
- digest mismatch 永远不返回内容。
- expired/unreferenced blob 可回收,pinned/active evidence 不被删。
- tool output 不再依赖进程相对 `tmp/`。
- Artifact metadata、transform receipt 与 Episode evidence 的 source/taint/declassification 可 round-trip;删除、伪造或跨 sink 复用 lineage 时读取、Gateway 消费和 Verification 都 fail closed。
- WorkspaceSnapshotManifest 的 schema 可无损表达 staged/unstaged/untracked/mode/symlink/conflict index refs;Runtime contract 不以此宣称已能恢复文件系统。
- composite checkpoint/replay contract 全绿;物理 rewind、释放和安全 GC 只在专项计划完成并通过联合 E2E 后对外宣称。

建议 PR:

1. `runtime: store large outputs in a workspace-scoped artifact CAS`
2. `runtime: add artifact redaction retention and access checks`
3. `runtime: bind composite checkpoints to artifact-backed workspace state`
4. `runtime: materialize the initial episode manifest`
