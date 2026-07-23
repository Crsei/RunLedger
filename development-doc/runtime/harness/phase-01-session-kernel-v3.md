# Phase 1:Session Kernel v3、哈希链与可恢复状态

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 0](phase-00-protocol-baseline.md) / [Phase 2](phase-02-workspace-contracts.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。
> 当前执行状态:W0-01 已由 `c4cd3e6` 完成;W0-02 候选证据矩阵、W0-03 execution ledger 与 W0-04 基线结果已准备但尚未形成目标分支 evidence commit。W0-G 仍 pending,因此 W1-A1 尚未打开代码写路径。

目标:用严格、可重放、可验证的事件内核替代“消息即 session”的假设。

前置:Phase 0。

并行边界:本阶段先完成并冻结对 session/storage/CLI 共享基线的修改,再开放 Worktree/Sandbox/Permission 专项的独占实现窗口;不得与该专项 Phase 5 串行集成并发。

计划文件:

- 新增 `src/runtime/session/{types,event-store,memory-event-store,jsonl-v3-store,event-writer,writer-lease,chain-verification,attestation,stop-tombstone,reducer,projections,snapshot,checkpoint,recovery,salvage}.ts`。
- 修改 `src/runtime/ledger/{types,jsonl-ledger,memory-ledger,lockfile}.ts`,保留 legacy adapter。
- 修改 `src/storage/{session-manager,session-codec,path-utils}.ts` 和 `src/cli/{args,main}.ts`。
- 修改 `src/runtime/{agent-loop,agent}.ts`,在 turn/model/tool/queue 边界写 durable event。
- 新增 `tests/runtime-v3/session/` 下 integrity、replay、crash、fork、rewind、stop 测试。
- 新增可复用的 Event Store conformance/fault fixture,让 memory、JSONL 以及未来 SQLite/remote backend 接受相同的 stream scope/id、sequence、durability、fencing、fork、cross-stream replay rejection 和 corruption 断言。

核心接口:

- `RuntimeEventStore.append/flushThrough/read/subscribe/verify`:所有方法显式接收/返回 branded stream ref;append 只在该 stream 分配并接受 cursor,只有 `flushThrough(streamRef, cursor)` 成功才返回同 stream 的 `DurableEventReceipt`。
- `SessionReducer.reduce(events) -> SessionProjection`。
- `SessionSnapshot` 记录 event sequence/hash、active leaf、initial goal/root agent、完整有序 queue payload/ref 和已知 budget projection;Phase 1 的 logical checkpoint 不包含物理 workspace/CAS。
- `RecoveryDecision = resume | pause_for_approval | reconciliation_required | stopped | corrupted`。

任务:

- [ ] 提供显式异步 `open/restore` factory:调用方先注册 model/tool/resource/provider 等不可序列化依赖,再读取并 reduce durable state、校验 snapshot 中的依赖 identity/generation、reconcile 未完成状态,最后才返回可变 session handle;构造器不得隐式执行异步恢复。
- [ ] 用单 writer queue 保证 sequence 分配和 append 顺序;append 只返回 assigned/accepted cursor,关键调用必须再取得覆盖该 cursor 的 `DurableEventReceipt`,不能把“写入进程缓冲区”称为 durable。
- [ ] 明确任何 stream completion、listener settlement、`EventStream.result()`、pending-write Promise、内存 queue/retry/phase 归零都不能签发 `DurableEventReceipt`;receipt 只能来自 Event Store 的已验证 flush/commit barrier。
- [ ] durable barrier 必须传播 file flush/sync 错误;新建、rename、tombstone/snapshot 切换还要按平台能力同步父目录或明确返回 unsupported/degraded,不能忽略 `sync_all/fsync` 失败后签发 receipt。
- [ ] 定义 `MutationEffect = none | committed | uncertain`:只有 durable receipt 可证明 committed;after-write/before-sync、sync/receipt 丢失或无法证明未落盘的错误一律为 uncertain。uncertain 必须保留 idempotency claim并立即关闭该 session 的 next-mutation gate,直到同进程 reconcile 或重启 recovery 得出唯一结果。
- [ ] 对每条事件校验 schema、stream scope/id、该流 sequence、previous hash、payload digest 和 current hash;session stream 额外校验 sessionId,authority stream 只把 subjectSessionId 当目标 ref 并验证其存在性/最终 head binding。
- [ ] 额外验证 event/turn/model/tool/queue ID 唯一性、parent/leaf 引用存在性和 reducer 图连通性;未知 event/payload 不得 cast 后继续。
- [ ] `session.created` 固定 `initialGoalId` 与 `rootAgentId`;open/resume/snapshot/fork 从 canonical event 恢复身份,不得在每次进程启动时重新生成 goal/agent lineage。
- [ ] session genesis/head receipt 使用可插拔 signer/anchor;没有 signer 时显式记录 unattested,不能伪造 attested 状态。
- [ ] 定义强制 flush 事件:permission decision、tool terminal、checkpoint、stop、verification terminal、session close。
- [ ] 保证 tool result terminal event flush 后才允许下一 model request。
- [ ] recovery 对未完成 tool call 默认写 interrupted/uncertain 并关闭 mutation gate;只有 manifest 明确声明 idempotent/retry-safe、稳定 request/toolCall identity 匹配且 side-effect reconcile 证明可重试时,才允许沿原 idempotency claim 自动重试。
- [ ] 建立 turn/model/tool/queue 的 started/finished/interrupted/failed 成对事件和 crash reducer。
- [ ] 冻结 `QueueItemV3` exact schema:queueItemId、sourceCommandId、`steer | follow_up` kind、enqueue/target turn revision、next-turn policy、content digest、bounded canonical message、status;Phase 4 前超出 inline 上限的 payload 必须拒绝,不得只持久化 digest 后丢弃正文。Phase 4 冻结 exact `ArtifactRef` 后再以独立 schema version 启用 ref variant。
- [ ] queue 状态至少覆盖 `enqueued -> claimed -> consumed | cancelled`;claim 必须按 queueItemId+kind 精确绑定 turn/modelRequestId,禁止按相同文本 digest 猜测。replay 恢复所有未终结 item 的正文/ref、kind 与顺序;payload 缺失或 claim 结果不确定时 pause/corrupted,不能投影为空队列继续。
- [ ] `queue.cancelled` durable 后才可从 projection/Agent queue 移除;批量 clear 也是逐 item/versioned cancellation,不能用返回空数组的 no-op 伪装成功。
- [ ] 写 durable stop tombstone;startup recovery 先读 tombstone,再判断是否可恢复。
- [ ] snapshot 只作为加速层;加载时从 snapshot cursor 继续重放并验证尾部链。
- [ ] logical checkpoint 只绑定 event cursor、reducer digest、active leaf 和 active plan digest;预留可选 composite checkpoint ref。
- [ ] fork 只允许 stable turn boundary;新链用 `session.forked` 引用父 session/cursor/hash,不复制伪造原 eventId。fork payload 必须显式选择 continue-existing-goal 或 create-child-goal,为新 session 创建 rootAgentId 并记录 parent root agent lineage,不能靠 open 时随机推断。
- [ ] session create 与 fork 以不可见 staging/intent 开始,只有 genesis、writer epoch、初始 sequence/projection 和 lineage 全部 durable 后才原子 publish 为 resumable;任一初始化或逐 entry/import 失败只能清理或留下 failed/tombstoned 目标,不得留下可被 `continueRecent` 识别为完整 session 的半成品。
- [ ] logical rewind 创建新 branch/leaf,不删除旧事件,但在 Phase 4 前不得声称已回退文件系统或开放生产 rewind 命令。
- [ ] 中间坏行、sequence 缺口、hash 断链全部返回 `corrupted`;禁止静默跳过。
- [ ] Phase 1 forensic salvage 只读生成有硬大小上限的 `SalvageReport` 和可选离线 report file+digest,不依赖尚未实现的 Artifact CAS;显式修复始终写新 session。Phase 4 再把该 report 适配为受授权的 Artifact,原始坏日志不原地修改。
- [ ] writer lock 以 stream scope/id 为键,增加 writer epoch/fencing token、ownerRuntimeId、heartbeat 与 stale-owner recovery;每次 append/flush 都校验当前 stream/token,session writer 与 authority lifecycle writer 不能共用未分域的锁或 receipt。
- [ ] CLI 严格执行 §6.1:v1 始终返回 legacy-read-only;v2 在 `off/opt_in` 保持当前 read/write,在 `default/required` 返回只读提示并提供 migrate/fork-to-v3;覆盖 version-fence/downgrade 测试。
- [ ] legacy migration 使用 `session.migration_started -> session.legacy_message_imported* -> session.migration_committed | session.migration_failed`;started 绑定完整 source digest/size/importer/schema/expected record count,每条 import 绑定 source index+digest 并幂等。committed durable 前新 v3 session 只能 inspect/pause,不得 resume 或对外返回迁移成功。
- [ ] crash 后只允许用同 source/manifest idempotently 续完 migration,或把不完整目标标 failed/tombstoned 后创建新目标;不得把部分导入历史当完整 session,也不得覆盖源文件。

迁移/回滚:

- 新 session 与既有 v2 的可写性严格按 §6.1:在 `opt_in` 可显式创建 v3 且 v2 仍走当前写路径;进入 `default/required` 后既有 v2 才由 legacy adapter 只读并要求 migrate/fork-to-v3。
- 迁移命令最后实现,先用 golden fixture 验证转换器;CLI 仅在 `session.migration_committed` durable 后返回新 session handle/path。
- v3 写入后若回滚代码,只允许 export,不得回到 v2 append。

故障注入:

- 在 header、event body、after-write/before-sync、durable receipt 返回、snapshot rename、checkpoint bind、stop tombstone 每个边界 kill 进程。
- 在 session/genesis/sequence/initial projection 初始化的每个边界以及 fork staging、lineage bind、逐 entry/import、publish 前后 kill 进程;半初始化 create/fork 永远不能被恢复为 completed/resumable。未来 SQLite backend 还必须在 sessions/sequence/materialized 三表初始化和 fork 中途注入 rollback 故障。
- 注入 torn tail、middle-line corruption、duplicate sequence、reordered event、wrong stream scope/id、wrong sessionId、跨 stream cursor/receipt replay、disk full 和 permission denied。
- Phase 1 先覆盖 checkpoint envelope/digest 与 checkpoint 前后普通坏 JSONL 行,全部停止恢复并进入 corrupted 或只读 forensic salvage。invalid window UUID/chain、损坏 world-state、patch-without-full、legacy missing replacement history 等领域 fixture 等 Phase 6 contract 与专项 behavior 就绪后执行,但必须复用同一 fail-closed recovery outcome,不能 warning 后继续。
- 分别并发启动两个同 session stream writer 和两个同 authority lifecycle stream writer,覆盖 stale epoch/fencing token、duplicate idempotency claim 与 takeover race;旧 writer 即使持有可写 fd/DB connection 也不能 append,一个 stream 的 receipt/token 不能用于另一个 stream。
- 覆盖 crash-after-intent-before-effect 与 crash-after-effect-before-committed-event:前者只有 reconcile 证明 `none` 后才可执行,后者保持 `uncertain` 直到按原 idempotency identity 证明 committed/compensated,禁止直接 retry。
- 重复 resume 不得重复 prompt、permission decision 或已开始的副作用工具;不确定副作用必须 pause。
- 在 `queue.enqueued/claimed/consumed/cancelled` 的每个边界 kill 进程;重启后 pending 顺序、kind、payload、goalId/rootAgentId 与 live projection 必须一致,相同文本的 steer/follow-up 不得错绑。
- 在 migration started、每条 legacy import、commit/failed receipt 前后 kill 进程;重复命令不重复消息,partial target 永远 pause/inspect-only。
- 构造 Git rewind 成功但 filesystem restore 失败、以及相反顺序的 partial receipt;Phase 1 不激活物理 rewind,Phase 4 联合恢复也必须保持原 leaf/workspace 可追溯。

完成门槛:

- 给定可信 genesis/head anchor 时,任意链内修改都可定位到首个坏 cursor;无 anchor 时只报告 locally-valid/unattested。
- stop 后重启永不自动继续。
- replay、snapshot replay 和 live projection 对同一日志产生相同 digest。
- durable queue 未消费时不得恢复成空队列;uncertain mutation 未 reconcile 前,同进程与重启后的所有新 mutation 都被拒绝。
- open/resume 前后 initialGoalId/rootAgentId 与所有既有 turn/tool lineage 保持连续。
- legacy migration 只有一个 durable terminal outcome;partial import 重启不被误判为可 resume,同 source 重试不产生重复 canonical message。
- stable logical fork、projection rewind 与 crash recovery E2E 全绿;物理 workspace rewind 的门槛归 Phase 4。

建议 PR:

1. `runtime: add strict hash-chained v3 event store`
2. `runtime: project session state and durable queues from events`
3. `runtime: add logical checkpoints fork projections and crash recovery`
4. `runtime: add explicit legacy-to-v3 migration tooling`
