# Phase 4:Artifact CAS、脱敏、Retention 与 Episode 骨架

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 3](phase-03-capability-approval-sandbox-contracts.md) / [Phase 5](phase-05-resource-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:把大输出、diff、日志和验证证据从消息/tmp 文件升级为可寻址、可授权、可清理的 Artifact。

前置:Phase 2、Phase 3 的数据契约。涉及 workspace materialize/rewind/cleanup 或 Artifact 访问授权的行为验收,额外依赖 Worktree/Sandbox/Permission 专项计划对应实现阶段。

计划文件:

- 新增 `src/runtime/artifacts/{types,cas-store,metadata-store,access,key-provider,redaction,retention,episode-manifest}.ts`。
- 对 `src/runtime/tools/tool-support.ts`、stdlib tools 与 `src/storage/paths.ts` 的接线只由 §0.6 I2/WorkspaceSecurity-Phase5 owner 完成;Artifact 模块开发期间不并发修改这些共享文件。
- 新增 `tests/runtime-v3/artifacts/`。

任务:

- [ ] Blob 以 SHA-256 stored digest 分层存储,临时文件 write+sync+atomic rename,metadata 独立持久化。
- [ ] Artifact 写入遵循 intent event -> pending blob/metadata -> committed event -> visible reference;startup 回收或补记 orphan。
- [ ] external upload/export 状态至少区分 accepted/enqueued、durable、content-verified、externally acknowledged 与 failed;`Enqueued` 永远不能计入 fully uploaded、Episode evidence 或允许本地 cleanup 的 terminal 集合。
- [ ] metadata 记录 kind/media type/size/compression/source session/workspace/producer/references/expiry/redaction,并绑定完整 `InputSourceRef[]`、taint 上界和适用的 `DeclassificationReceiptRef[]`;缺失 lineage 的外部/candidate/model-derived Artifact 只能 quarantine,不能进入危险 sink 或 Verification pass。
- [ ] 同时记录 stored digest、受保护的 source receipt、redaction policy/version 和 transform receipt;transform/summary/merge 只能保留或提高 taint 上界,去污必须引用仍有效且 sink 匹配的 receipt。敏感低熵原文使用 keyed digest,避免普通 source hash 被离线猜测。
- [ ] 定义 ArtifactKeyProvider;本地版只接受 OS keyring-backed versioned key,支持 rotation/loss 状态,不允许 0600 明文 key fallback。Phase 11 仅替换为 KMS provider。
- [ ] tool result 在 prompt 中只保留 bounded summary + ArtifactRef。
- [ ] 写入前运行 secret/credential/path/prompt redaction;默认不保留 raw content。
- [ ] forensic raw 只能在显式授权后加密存储,单独 retention 和 access log。
- [ ] key provider 不可用时禁用 keyed source receipt 和 encrypted forensic raw,仍可保存已脱敏 stored blob,并在 metadata/manifest 明确降级状态。
- [ ] 将 Phase 1 的 bounded `SalvageReport`/offline digest 适配成只读、受授权、带 source digest 与 unattested 标记的 Artifact;CAS 不可用时 Phase 1 仍可完成报告,但最终 governed salvage 验收必须等待该适配。
- [ ] 在 `ArtifactRef` exact schema 冻结后版本化启用 `QueueItemV3` 的 Artifact-backed payload variant;旧 Phase 1 inline fixture 保持可读,缺失 blob/ref 的 queue item 只能 pause/corrupted。
- [ ] retention 支持 TTL、pin、reference count、legal hold placeholder 和 dry-run GC。
- [ ] 读取 Artifact 时把 session/workspace/capability refs 交给注入的 `CapabilityGatewayPort` 重新检查,Runtime Artifact 模块不实现权限规则。
- [ ] 初版 Episode Manifest 聚合 identity、event head、workspace/base、artifact refs、permission refs、cost/verification 占位。
- [ ] 兼容旧 `tmp/tool-output-*`:只读 import 时标为 legacy/unverified,不假装已有 digest 证据。
- [ ] 把 Phase 1 logical checkpoint、Phase 2 WorkspaceCheckpointDescriptor、diff/untracked Artifact 合成 CompositeCheckpoint。
- [ ] 定义版本化 WorkspaceSnapshotManifest 数据结构:HEAD/base、raw index/各 conflict stage、staged/unstaged 状态、tracked/untracked Artifact refs、file mode、symlink target、submodule/LFS/exclusion/size-limit 状态;具体 Git 采集与恢复由专项实现。
- [ ] checkpoint schema 对 ignored exclusion、dirty submodule、缺失 LFS object、超限或不可表示状态表达 `partial`;是否允许物理 rewind 由注入的 Workspace 服务判定。
- [ ] Runtime 只在 Workspace 服务返回可验证 rewind receipt 后激活新 leaf;失败保留原 workspace/leaf。
- [ ] cleanup 只提交 CompositeCheckpointRef、WorkspaceExecutionEnvelope 和预期 lease revision,由 Workspace 服务复核并执行;Runtime 记录返回的 pending-GC/terminal receipt。

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
