# Phase 10:Headless Daemon、版本化 Control Plane 与轻客户端

> 权威总入口:[`04-governed-agent-harness-runtime-plan.md`](../04-governed-agent-harness-runtime-plan.md)
> 分阶段索引:[`README.md`](README.md)
> 导航:[Phase 9](phase-09-multi-agent.md) / [Phase 11](phase-11-enterprise-telemetry-lifecycle.md)
> 状态规则:当前实现状态以主计划 §0.0 为唯一汇总真源;严格开发顺序、并行 lane 与 join gate 以主计划 §12 为准。本文件只承载本 Phase 的完整需求、门槛、故障注入与历史证据。

目标:Runtime 成为唯一状态所有者,TUI/CLI 通过协议连接,并冻结供后续 IDE/CI adapter 消费的同一版本化协议;本阶段不交付 IDE/CI client。

边界:本阶段只提供 session/turn/approval/artifact/event/activity 等 Runtime 通用协议。Plugin/MCP/Skill/Hooks 的 list/trust/enable/reload/doctor 命令、query 和界面由扩展计划 Extension-M6 在 adapter 上实现;不得在本阶段复制一套 extension control plane。

前置:Phase 1、Phase 7。session inspect/health/shutdown 可先按已完成能力开放;任何 turn/queue/approval mutation、Artifact 内容读取/写入或副作用能力的生产启用除 Phase 8 外,还必须满足该 feature 的 closed required-adapter matrix 并取得全部真实 receipt。未满足时 daemon 不 advertise 对应 feature,调用只能返回 `unsupported_feature`/deny,不得回退本地 `AllowAll` 或生成占位 receipt。

2026-07-24 W3-P0合同基线:

- Control Plane protocol冻结为`1.1`,current schema为v2,server同时协商`[1,2]`;schema v1客户端继续协商minor 0且永远看不到`multi_agent`。
- schema v2冻结`agent:spawn/cancel/resume/handoff`、`agent:inspect`、`expectedAgentGraphRevision`、session generation及有界effect/summary合同;13类v1 mutation wire shape未修改。
- production minimum matrix新增`agent_supervisor`、`child_runtime_factory`与可选`peer_identity_attestor`证据;W3-J前`multi_agent`不advertise。

2026-07-24 W3-M3/W3-J交付状态:`Runtime-owned completed`。

- `0c6d1a1`交付真实loopback HTTP command与SSE event listener lifecycle,复用typed command/query schema、at-least-once cursor与bounded subscription;listener只有在production `PeerCredentialAttestorPort`完成preflight/channel binding时才绑定和advertise。
- bounded request body/input queue/per-client buffer、slow-consumer disconnect、overload、disconnect/resync与durable consumer checkpoint已有故障回归。Unix peer credential和Windows pipe ACL仍由外部production adapter提供;缺attestor时HTTP/SSE不绑定,stdio production路径保持可用。
- durable runtime generation replacement遵守prepare/replay/reconcile/health完成后再activate;commit前失败保留旧runtime,commit后失败只允许新generation进入paused/stopped recovery。idle unload/resume与subscription lifecycle共用锁并受old-handle fencing。
- schema-negotiated轻客户端同时提供`[1,2]`;v1客户端看不到`multi_agent`,v2 Agent mutation/query只接受Control Plane projection。未接入的turn/approval/artifact/queue provider继续`unsupported_feature`,不生成占位receipt。
- `ac54e38`完成W3-J:四类Agent mutation在任何Supervisor/provider/tool副作用前durable claim,unknown effect保持`in_flight/recovery_required`,exact duplicate从canonical terminal恢复原bounded effect;production adapter必须与daemon共享command journal、shutdown gate及runtime generation。
- ChangeProposal/HumanGate本轮只保留versioned contract、durable command correlation和转发port;repository、forge、credential与organization gate仍归W4。OS peer attestor与这些外部依赖未ready时Runtime-M3产品声明保持blocked/external_gap。

本阶段下列复选框继续表达完整产品语义。平台peer identity、真实外部adapter和W4能力不会因Runtime-owned W3-M3/W3-J关闭而机械勾选;当前执行状态以主计划§12.7为准。

计划文件:

- 新增 `src/runtime/control-plane/{types,errors,handshake,composition-requirements,command-bus,query-service,subscriptions,idempotency,jsonl-transport,sse-transport}.ts`。
- 新增 `src/runtime/activity/{types,projection}.ts`,在本阶段冻结完整 `RuntimeActivity` schema 并提供单 Agent projection;Phase 11 只做 nested-agent/cost/telemetry enrichment。
- 新增 `src/runtime/change-proposals/{service,human-gate-coordinator}.ts` 与 `src/integrations/forge/{types,github-provider}.ts`;provider 只能创建 Draft PR,凭据只经 Credential Broker/Gateway port 获取。
- 新增 `src/daemon/{main,server,composition-root}.ts` 和 bin 入口。
- 在独占 control-plane/daemon 模块完成后,按 §0.6 I6 窗口修改 `src/cli/main.ts`、`src/runtime/interactive-session-controller.ts` 和 TUI 装配为 client/facade;不得与 WorkspaceSecurity-Phase5、Extension-M6 或 Plan/Context 集成窗口并发。
- 新增 `tests/runtime-v3/control-plane/`、`tests/e2e/daemon-recovery.test.ts`。

最小 API:

- session:start/resume/fork/stop/inspect
- turn:start/steer/followUp/interrupt
- queue:list/cancel（批量 clear 只是带 expected queue revision 的 cancel 集合）
- approval:resolve（只定义 command/result schema）
- changeProposal:inspect/requestDraftPr、humanGate:resolve（只定义 schema/correlation,实际 provider/decision 走注入端口）
- artifact:read/metadata
- events:subscribe/fromCursor
- activity:get、health、shutdown

Legacy migrate/export、forensic salvage/repair 首版是 daemon 停止后的独占离线管理命令:必须取得目标 session 的 writer/admin lease,写审计报告或新 session,且不得原地修补 canonical log。daemon 活跃时这些 CLI 明确拒绝而不是并发旁路“唯一状态所有者”。若后续需要在线管理,必须先增加版本化 admin handshake/API、独立高权限 capability、expected revision、idempotency、审计 Artifact 与 crash recovery,不能复用普通 session mutation command。

Canonical event/reducer 闭环:

- mutation lifecycle 使用 `command.claimed`、`command.applied`、`command.rejected`、`command.reconciliation_required`;claim payload 固定 commandId/request digest/idempotency key/principal/generation/domain expected revision。`command.applied` 固定 bounded typed effect、effect digest、applied cursor/revision,`command.rejected` 固定 bounded typed error、error digest与稳定 retryability,`command.reconciliation_required` 固定 reconcile ref;三种 terminal 都必须绑定原 claim/request digest并可独立重放。
- runtime replacement 使用 `runtime.replacement_prepared`、`runtime.generation_activated`、`runtime.replacement_failed`;只有 `runtime.generation_activated` durable 才切换 authoritative generation/fencing,prepared 不是新 authority。
- `ControlPlaneProjection` 与 `RuntimeGenerationProjection` 只从 canonical events 重建 command outcome、queue/activity cursor 与 active generation;idempotency cache、connection waiter 和 process handle 均为可丢弃 runtime state。

任务:

- [ ] handshake 协商 protocol/schema/features,不兼容版本返回 typed error。
- [ ] daemon handshake 和任一 tool/resource adapter handshake 都绑定 authenticated session、runtime/adapter generation 与 sequence domain;peer 自报 feature/capability/scope 只影响 discovery proposal,production feature advertisement 与授权仍只来自 `ProductionCompositionReceipt` 和 Gateway receipt。
- [ ] mutation command 带 commandId、request digest、idempotency key 和领域 precondition;重复 commandId 携带不同 payload 必须拒绝。
- [ ] 为 `session:start/resume/fork/stop`、`turn:start/steer/followUp/interrupt`、`queue:cancel`、`approval:resolve`、`changeProposal:requestDraftPr`、`humanGate:resolve` 与 `shutdown` 共 13 类 mutation 建立 closed command -> effect/error mapping。进程重启后只读取 canonical claim+terminal events即可逐字段恢复原成功 effect 或 typed rejection;进程缓存、injected resolver 和外部 waiter 只能加速,不得成为恢复真源。terminal 缺失、digest/cursor/ref 不匹配或 effect 超界只能进入 reconciliation/corrupted,不能返回空对象或重新执行命令。
- [ ] expected session/turn/queue revision 必须在 authoritative 单 writer 的“command claim + compare + append”临界区原子复核,client preflight 只作提示。steer/followUp/interrupt 绑定 expectedTurnId+turnRevision,queue cancel 绑定 queueRevision;响应返回 applied cursor/revision,边界已跨越时返回 stale-turn/revision-conflict,禁止自动改绑到当前或下一 turn。
- [ ] `approval:resolve` 只校验 command schema、expected revision 与 correlation,随后转发到注入的 ApprovalCoordinator;Control Plane 不实现 policy evaluation、approval storage 或 receipt 签发。
- [ ] ChangeProposalService 只接受已验证的 ChangeProposalRef/EpisodeSeal 和 expected revision,持久化 requested/created/failed projection;GitHub provider 通过 Gateway + audience-bound Credential Broker grant 创建 Draft PR,不持有长期 forge credential且没有 merge/deploy API。缺真实 provider/credential receipt 时 `requestDraftPr` 不 advertise。
- [ ] HumanGateCoordinator 把 request/decision 绑定独立 principal/organization policy、EpisodeSeal、proposal revision 与 separation-of-duty receipt;Control Plane 只转发和投影 durable decision,模型、Builder 或 proposal issuer 不能作为 human principal。真实 organization/credential 联合 E2E 等 WorkspaceSecurity-Phase8 与 Phase 11。
- [ ] prompt 只有 server-side precondition 与 `queue.enqueued` durable 后才返回 accepted;accepted 只代表“已持久待处理”,不代表 Agent 已开始。Agent 必须从 canonical projection 领取,不能同时维护另一份不可恢复的 queue 真源。
- [ ] queue:list/cancel 读取并修改同一 projection;只有 `queue.cancelled` durable 后才返回成功。Ctrl-C、dequeue、历史恢复失败或 uncertain 都必须显式显示,不得用空数组/no-op 假装已清队列。
- [ ] 任何 mutation 在 after-write/before-sync 等边界返回 uncertain 时保留 durable command claim并立刻关闭同一进程的 session mutation gate;reconcile 确认 committed/none 前,新 command 不得以新 idempotency key 绕过。
- [ ] event subscription 明确为 at-least-once,带稳定 eventId/sequence cursor;重连不漏事件,客户端按 eventId 去重,不得宣称 transport exactly-once。
- [ ] `RuntimeActivity` schema 覆盖 session/goal/task/tool、waiting permission、nested-agent 列表、last durable cursor 与 heartbeat freshness;Phase 10 单 Agent projection 对 nested-agent 输出空集合而不是省略字段,`activity:get` 与 event replay 产生同一 digest。
- [ ] 需要 exactly-once projection 的内置消费者使用 durable consumer checkpoint,把 projection apply 与 offset commit 放入同一事务/CAS;普通客户端不共享该承诺。
- [ ] per-client bounded buffer、backpressure、slow-consumer disconnect 和 replay recovery。
- [ ] local JSONL/stdio transport 严格 LF framing,支持 CRLF 和 final line,malformed frame 返回 typed error而不是 cast。
- [ ] HTTP/SSE adapter 复用同一 command/query schema;首版只绑定 loopback/local socket。
- [ ] local socket/pipe 权限和 peer identity;远程 auth/tenant 在 Phase 11 前默认关闭。
- [ ] bounded transport input queue 返回 typed overload,不会以断开或静默丢帧伪装 accepted;UDS stale path/startup lock/file mode 只用于本地启动安全,仍必须取得 OS peer credential/channel binding 并映射 principal,不能只信 socket 路径所有权。
- [ ] 在 `composition-requirements.ts` 冻结 versioned `PRODUCTION_FEATURE_REQUIREMENTS_V1` 和 canonical digest,作为协议最低矩阵;至少覆盖 Event Store、model provider、Workspace、Gateway、Approval、Sandbox、Artifact/key provider、resource catalog/invoker、verifier registry,Phase 11 预留 managed policy、credential、forge/human gate、remote executor 与 telemetry exporter。managed policy 只能删除 feature、增加 required adapter/约束或缩短 expiry,不得放宽协议最低矩阵。
- [ ] composition root 生成可校验 `ProductionCompositionReceipt`,绑定 authority/tenant、runtime generation、feature matrix version、protocol-minimum digest、effective requirements digest、managed policy ref、每个 adapter identity/generation/config digest/health/trust receipt 与 signer/attestation;任一 adapter generation/health/trust、协议矩阵或 effective digest 变化即失效。feature advertisement 只能由同时满足 protocol minimum 与更严格 effective row 的 receipt 计算,测试 fixture issuer/policy 不得进入生产 registry。
- [ ] composition schema 拒绝 unknown/duplicate feature 或 adapter、同一 feature 多个 requirements row、enabled feature 缺 row/缺 required receipt、receipt adapter 不在当前 generation;requirements 和 adapter kind 按 canonical order 参与 composition digest。
- [ ] downgrade fixtures 覆盖旧/未知 matrix version、伪造 protocol-minimum digest、issuer 删除 minimum adapter、managed policy 放宽 requirements、stale policy ref 与只更新自报 featureRequirements;全部拒绝 startup/advertisement。
- [ ] session replacement 先在关闭 mutation 的候选 generation 中 prepare/validate:注册不可序列化依赖、验证 composition receipt、replay/reconcile durable state 并完成 health probe;在候选未 ready 前,旧 runtime 仍是唯一 authority 且保持可用,不得先 teardown。
- [ ] 候选 ready 后写 durable replacement transition,在同一 lifecycle critical section 原子切换 generation/fencing authority,再 bounded drain/teardown old runtime;commit 后旧 handle 永久失效。factory/open/prepare 在 commit 前失败时保留旧 runtime并记录失败诊断,commit 后才失败则旧 runtime 不得复活,新 generation 必须形成明确 paused/stopped terminal 与 recovery path。
- [ ] idle unload 只针对无 subscriber 且 inactive 的 session,先关闭 mutation gate、取消/持久化 pending request 并 bounded shutdown;subscribe/resume 与 unload 在同一 lifecycle lock 串行,恢复后按 durable cursor 重建 pending 状态。增加 subscribe/resume-vs-unload、pending approval cancel、flush/fencing 与 daemon restart 竞态测试。
- [ ] 每个 session/client handle 绑定 runtime generation 与 fencing token;replacement 后旧 generation 的 command 即使 sessionId 相同也必须拒绝。
- [ ] replacement fault test 覆盖 dependency registration、replay、reconcile、health probe、durable transition、authority swap 与 old-runtime drain 的每个边界;断言 commit 前失败旧 session 仍可用,commit 后失败只有新 generation 的 durable paused/stopped terminal,不存在双 writer、双 authority 或“假装回滚”。
- [ ] shutdown 先关闭 RPC gate拒绝新 mutation,再 bounded drain writer/handler/tool/child,超时项保留 recovery state。
- [ ] TUI 只保留 editor/render/临时动画;queue/retry/compaction/tool/session 状态来自 projection。
- [ ] daemon crash/restart 从 v3 events 恢复,不会重放已完成副作用。

完成门槛:

- 重复 commandId 不重复副作用。
- 同一 commandId 不同 request digest 被拒绝;uncertain command 在同进程和重启后都形成 reconciliation gate,不会继续接受 mutation。
- 断线/慢消费者/daemon restart 下 at-least-once cursor 语义稳定;重复投递不会造成重复副作用。
- pending queue 可在重启后按原 itemId/kind/order 恢复或取消;turn 尾、interrupt 与 queue cancel 竞态均不会吞消息或把消息移交错误 turn。
- 未满足 feature -> required adapters matrix 时,feature discovery 与实际命令都 fail closed,ledger 中不存在伪造的 authorization/workspace/sandbox/resource/artifact/verification 或 composition receipt。
- `activity:get` 在不依赖 Phase 11 exporter 的情况下可由 canonical projection 回放;heartbeat stale 与 daemon unavailable 明确区分。
- ChangeProposal/human-gate service 的 durable correlation/replay tests 全绿;缺 WorkspaceSecurity-Phase8 credential/organization adapter 时 Draft PR/human gate production feature 保持 unsupported,不能阻塞核心 Runtime-M3 control plane,但最终 Runtime-M4 验收仍必须通过真实联合 E2E。
- old session handle 不能影响 replacement session。
- replacement candidate factory/open 失败时旧 session 仍可接受符合原 revision/fencing 的命令;一旦 replacement commit durable,旧 generation 在同进程与重启后都不可复活。
- TUI 关闭不等于 Runtime 状态丢失,daemon stop 也能正确恢复终端客户端。

建议 PR:

1. `runtime: expose versioned idempotent control-plane contracts`
2. `runtime: run the governed runtime in a headless daemon`
3. `tui: consume runtime projections as a lightweight client`
