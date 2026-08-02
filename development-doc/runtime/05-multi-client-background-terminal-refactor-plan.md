# Multi-client Runtime Host 与 Background Terminal 重构计划

> 状态：planned，仅完成旧实现审计与当前分支重构设计，不代表生产功能已实现。
>
> 当前目标分支：`rollback/pre-governed-agent-harness-runtime`，基线 `51642f8`。
>
> 旧实现参考：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-agent-loop-resurrect`，审计快照 `98e1449`；multi-client 主集成点 `0a09255`，background-terminal 主集成点 `b19ff61`，最终 Linux fault/PTY 验证点 `6597032`。
>
> 外部实现参考：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/opencode`，只读审计基线 `dev@1882c33827`。该实现只作为机制与反例证据，不作为 RunLedger 生产安全声明。
>
> 通用 Runtime 类型与保存位置 contract 仍以 [`04-governed-agent-harness-runtime-plan.md`](04-governed-agent-harness-runtime-plan.md) 为准；本文件只拥有 local Runtime Host、多客户端 Control Plane 与 managed process/background terminal 的行为实施状态。

## 0. 结论

旧分支已经证明两项能力可以组成一个闭环，opencode 进一步证明显式共享 server、同 session 进程内串行、PTY replay/cursor/ticket 和工具叶级 Permission 可以独立工作。但两者都不能被整包复制：旧分支绑定旧代际化 Runtime 前提，opencode 则保留 optional auth、process-local registry、无界订阅和 raw host authority。当前分支的正确重构顺序是：

```text
current single-process CLI
  -> exact Host/process contracts
  -> one local Runtime Host owns session writers
  -> multiple clients use bounded command/query/subscription transport
  -> one explicit session driver owns interactive mutations
  -> Host-owned managed process manager
  -> governed pipe/PTY backend + durable output/recovery
  -> OpenTUI process viewer and terminal input
```

最终不变量：

1. 同一 Runtime Host scope 只有一个 Host；所有 session ledger writer 和活跃 Agent 都由 Host 持有。
2. CLI/TUI 是轻客户端，不直接取得 session lock，不持有 `Agent`、工具执行权或后台进程句柄。
3. 同一 session 可有多个 observer，但同时最多一个 driver；driver mutation 受 Host generation、session generation 和 driver revision fencing。
4. Event delivery 是 bounded at-least-once，客户端按 cursor 恢复并按 event ID 去重；不宣称 exactly-once transport。
5. 后台进程由 Host-owned manager 创建、查询、输入、resize、stop、回收；工具和 TUI 不接触 raw PID、PTY handle、spool 路径或 `child_process`。
6. 当前 `src/runtime/tools/bash.ts` 的 raw detached `spawnBackground()` 必须删除；不得保留为 fallback、兼容路径或无治理降级。
7. Trace `recording.mode=off|events|events_and_artifacts` 只控制可观测性记录，不能控制 process lifecycle、输出 checkpoint、恢复或安全 receipt 是否持久化。
8. 生产 Host 缺少 channel-bound peer attestation 时不绑定 listener；生产 managed process 缺少 Permission/Approval/Sandbox/Gateway/containment adapter 时不 spawn。
9. 不引入 feature flag、rollout flag、环境变量开关或双生产路径。阶段未完成时显式 unsupported；完成后标准 CLI 只有 canonical Host 路径。
10. 生产对象和测试对象由完全分离的 composition 构造；测试 fake 不能进入生产 factory 或 production receipt。
11. 所有 replay/live、reverse request、PTY output、未激活 attachment pending 和 WebSocket/IPC outbox 都必须有界；任一消费者过慢只影响自身并得到 typed resync，不能拖垮 Host 或其他客户端。
12. 短期 ticket、socket mode、Basic Auth 或共享 secret 不能替代 channel-bound principal；PID、raw command/cwd/env、private output path 不能进入 public DTO、模型正文或普通 TUI event。

### 0.1 可观察实施效果

实现完成后，用户和运维必须能直接观察到以下行为，而不是只看到类型或 source-level stub：

| 场景 | 必须呈现的效果 |
|---|---|
| 首个标准 CLI 冷启动 | 原子完成 Host election、peer preflight、writer acquisition 与 handshake；失败时 typed fail closed，不启动第二 writer |
| 第二个 CLI 打开同一 session | 复用同一 Host/Agent/session writer；先恢复 cursor，再进入 live；历史与 live 不丢失、不重复执行 mutation |
| observer 尝试 prompt/approval/process mutation | 在进入 Agent、Permission waiter 或 backend 前由 driver fence 拒绝，`spawnCount=0`、writer 无新增 mutation |
| driver 断开或转移 | 正在运行的 turn/process 不被客户端生命周期终止；新 driver 以 expected revision 显式 claim 后继续 reverse request |
| 慢订阅者或 output flood | 只关闭/降级该订阅并返回 `resync_required` 或安全停止进程；fast client、Host writer 和其他 session 保持可用 |
| foreground 转 background 或显式 background | 返回同一种 safe `ExecutionHandleRef`；可通过 query/subscribe/TUI 继续观察、输入、resize、stop，不暴露 PID/path |
| Host crash/restart | 不按 PID 猜测 reattach，不重复 spawn；根据 durable intent、spawn/containment/output receipt 投影为 running recovery、terminal、lost 或 uncertain |
| Trace 三种 recording mode | canonical session/process truth、恢复和安全 receipt 完全一致；只改变 observability event/artifact 的记录范围 |
| TUI detach/quit | detach 只释放 attachment，`/quit` 只断开 client；除显式 stop/shutdown policy 外不终止 turn 或 process |

## 1. 审计输入与证据边界

### 1.1 旧 multi-client 实现

旧工作树的主要实现面：

| 能力 | 旧实现入口 | 已有证据 |
|---|---|---|
| connect-or-spawn | `src/cli/multi-client-host.ts`、`src/daemon/local-host-launcher.ts` | 两个标准 PATH CLI 复用同一 Host |
| scope/compatibility | `src/runtime/control-plane/local-host-contract.ts` | exact envelope、override 分类、typed conflict |
| endpoint/election | `src/daemon/local-host-{endpoint,election,lifecycle}.ts` | startup lock 与 writer fence 双层竞态测试 |
| multi-connection routing | `src/daemon/local-multi-connection-host.ts` | bounded queue、慢消费者隔离、resync |
| resident session owner | `src/daemon/resident-session-registry.ts` | 单 writer、idle/drain/recovery |
| remote client | `src/runtime/control-plane/{local-host-client,remote-interactive-session,interactive-facade}.ts` | command/query/subscription facade |
| session driver | `src/runtime/control-plane/session-driver.ts` | generation/revision fencing、observer 拒绝 mutation |
| peer attestation | `native/linux-peer-broker.c`、`src/daemon/linux-peer-broker.ts` | Linux `SO_PEERCRED`/channel binding；Windows 未实现 |
| acceptance | `scripts/verify-multi-client-host.ts` 与 `phase-10-multi-client-acceptance.json` | 12/12 Linux 场景通过 |

旧结果只证明旧分支在其代际化 Runtime 前提下通过，不是当前分支的实现证据。

### 1.2 旧 background-terminal 实现

| 能力 | 旧实现入口 | 已有证据 |
|---|---|---|
| process domain/state | `src/runtime/process/{types,state-machine,projector}.ts` | exact status/terminal mapping 与非法迁移测试 |
| Host manager | `src/runtime/process/manager.ts`、`src/daemon/session-process-manager.ts` | session/Host capacity、idempotent create、active-work |
| governed Bash | `src/runtime/process/governed-bash.ts`、`src/runtime/tools/bash.ts` | foreground/background 统一 manager 路径 |
| interactive mutation | `src/runtime/tools/{write-stdin,process-stop}.ts` | bounded stdin/EOF/stop |
| Control Plane | `src/runtime/control-plane/managed-process-*.ts` | query/mutation/subscription 与 driver fence |
| output durability | `src/storage/process/file-process-output-store.ts` | seq/checkpoint/seal、quota、recovery、retention |
| backend/containment | `src/storage/process/{node-process-backend,node-pty-backend,supervisor-*}.ts` | real PTY、resize、descendant-tree stop、Host SIGKILL containment |
| Artifact | `src/runtime/artifacts/managed-process-output.ts` | bounded materialization、digest/ref、失败恢复 |
| TUI | `src/tui/managed-process/**`、`managed-process-viewer.ts` | list/detail/output、driver mutation、宽度矩阵 |
| acceptance | `scripts/verify-managed-process-pty.ts` 与旧 fault-matrix 验收 artifact | Linux 41/41 自动场景通过；独立审计与人工终端验收仍未闭合 |

### 1.3 opencode 当前实现审计

审计基线为 `dev@1882c33827`，工作区干净。聚焦测试受该 checkout 未安装完整 workspace 依赖限制：PTY protocol 3/3 通过，其余 Core/HttpApi 测试分别因缺少 `effect` 与 `@opentui/solid/preload` 未启动，因此以下结论是 current source + existing tests 证据，不冒充完整 runtime acceptance。

| 领域 | opencode 当前机制 | 可采用部分 | 不能直接采用的边界 |
|---|---|---|---|
| client/server | 默认 TUI 使用随客户端退出的 Worker server；另有显式 `serve` + `attach` | typed remote client seam、内嵌 fetch/event seam | 不是标准 CLI connect-or-spawn，也没有 resident Host election/writer fence |
| session execution | `SessionRunCoordinator` 按 Session ID 合并 resume、聚合 wake、不同 session 并行 | same-session serialization/coalescing pure algorithm | 明确 process-local；无 driver/observer、Host/session generation 或 crash continuation identity |
| Event | `EventV2` 有 SQLite aggregate sequence/durable replay；HTTP SSE 使用 live `Queue.unbounded` | durable aggregate event 与 historical-to-live read 模式 | SSE 不消费 durable cursor，无 `Last-Event-ID`/ack/resync，event ID 仅在 JSON data 内 |
| PTY registry | Location-scoped `Map`、2 MiB retained buffer、25 个 exited session、多 attachment、cursor replay | `register -> snapshot replay/cursor -> activate live` 的无缝 attach 顺序；exited retention | registry/buffer/subscriber pending 都是内存状态；public info 暴露 PID/command/cwd |
| PTY ticket | 60 秒、单次消费、绑定 PTY/directory/workspace、Origin 检查 | bounded single-use ticket 与 scope binding | ticket 是应用层 bearer，不是 OS channel peer attestation；不能证明本机 principal |
| PTY transport | WebSocket 支持 input/output/resize/remove | protocol frame、replay chunk、attachment detach | outbound `Queue.unbounded`；PTY create 不经过 Permission/Approval/Sandbox；kill 无 tree settlement receipt |
| Bash | foreground-only、`PermissionV2.assert()`、timeout、1 MiB capture、POSIX process-group kill 尝试 | leaf enforcement、bounded preview、group-kill backend 原语 | 工具声明即使用 host user filesystem/process/network authority；无 Sandbox/Gateway/Approval receipt |
| BackgroundJob | start/extend/list/get/wait/promote/cancel 与 running-ID 进程内去重 | scoped async job API 与 stale settlement token 思路 | 源码明确 non-durable/process-local；不能充当 process lifecycle truth 或 restart recovery |
| Tool output | 超过 2,000 行或 50 KiB 写 XDG data 文件，7 天清理 | model-facing head/tail preview 与 retention scan | 非 CAS、无 digest/seal/pin/recovery，并把绝对 `outputPath` 写入模型可见 marker |
| TUI | 当前 OpenTUI 没有 governed process/terminal overlay | 无 | 不能用 HTTP PTY API 存在替代 R9 用户可见验收 |

由该审计新增的硬规则：

- RunLedger 可以复用 PTY attach 的 replay/live 激活算法，但 replay buffer、attachment pending 和 wire outbox 必须同时有界，并在截断时返回最早安全 cursor 或 `resync_required`；
- durable Event Store 能力不等于 transport 已可恢复；R2/R3 必须从标准 client 实测 cursor replay、ack loss 与 overflow；
- application ticket 只能作为已认证 channel 上的一次性 capability，不能使未 attested channel 获得 principal；
- Permission 必须位于所有真实 spawn 的最终 leaf，包括直接 PTY create、foreground、background 和恢复后的 mutation，不能只保护 model-facing Bash；
- process-local coordinator/registry 可以作为 routing cache，绝不能成为 session/process terminal truth；
- bounded preview 不是 Artifact；完整内容只有通过 digest/size/authorization/seal 校验后才能生成 ArtifactRef。

### 1.4 采用与拒绝

采用：

- 单 Host 持 writer、客户端只持 remote facade；
- startup election 不是最终 fence，writer/session lock 才是；
- compatibility handshake、bounded transport、cursor replay、event ID dedupe；
- 一个显式 driver，observer 只读，reverse request 单播；
- process intent-before-spawn、deterministic state machine、bounded output、process-tree containment；
- Host crash 不按 PID 猜测 reattach，只有 receipt 能形成 terminal/lost/uncertain；
- Artifact 只保存经过授权和清洗的 bounded content，public event 只保存 digest/ref；
- opencode 的 same-session coordinator、PTY replay/cursor/activate、single-use scoped ticket、exited retention 和 leaf Permission 作为局部算法参考；
- durable Event aggregate 与 live transport 分层验收，不以 Event Store 已持久化推导 client subscription 可恢复。

拒绝：

- 整包复制旧代际化 Runtime、旧 authority directory 和旧 compatibility reader；
- 旧 `managed_process_v1` feature advertisement/negotiation；功能完成后直接成为 current production contract；
- 旧 `sessionDir`、`--session-dir`、项目 `.runledger/` 或任意 state root authority；
- raw detached spawn、cwd 下 `tmp/bash-*.log`、对模型返回绝对 `logPath`；
- socket mode、PID 文件、客户端自报 UID/PID 充当 peer authentication；
- 以 `/tasks` 混合 Task、Agent 与 managed process；本重构使用独立 process/terminal surface；
- 用 TraceEvent 代替 durable process lifecycle，或让 recording mode 关闭恢复证据；
- 生产 factory 被测试 helper 调用，或 test attestor/backend 进入 production registry；
- 默认 TUI 自带、随 client 退出的临时 server 充当 resident Host；
- optional Basic Auth、application ticket、socket mode 或 shared secret 充当 peer attestation；
- `Queue.unbounded`、无界 subscriber pending、process-local BackgroundJob/PTY registry 进入生产路径；
- public DTO 或模型正文暴露 PID、raw command/cwd/env、absolute output/spool path；
- 直接 PTY/terminal create 绕过 Permission/Approval/Sandbox/Gateway barrier。

## 2. 当前分支事实与缺口

### 2.1 当前事实

- `src/cli/main.ts` 在 CLI 进程中创建/打开 `SessionManager`，取得整场 ledger lock，再构造 `InteractiveSessionController`、`Agent` 和 TUI。
- `Agent`、消息、steering/follow-up queue、AbortController 与工具执行均在单个客户端进程内；第二个进程不能安全复用这些状态。
- `SessionManager` 已固定到 canonical user home，session 只能写 `sessions/YYYY/MM/DD/`；这项 S0–S5 结果必须保留。
- `RunledgerLayout` 已有 `state`、`ipc`、`log`、`events`、`artifacts`、`projections` 和 `tmp`，但没有 Host/process scoped locator 与行为 backend。
- `src/runtime/tools/bash.ts` 的 foreground 通过 `ExecutionEnv.shell.exec()`，background 则绕过该抽象直接 `spawn(... detached:true)`，把日志写入 cwd 的 `tmp/`，没有 wait/stop/recovery/retention。
- 当前 Trace Event Store/Artifact Store 记录模型、上下文和工具调用；它们是 observability truth，不是 session/process mutation truth。
- OpenTUI 重构正在建立 renderer、overlay 和 focus seam；managed terminal UI 不应新增长期 pi-tui 组件。
- `04` 只冻结 contract 与 port，不实现 daemon、Control Plane、Permission、Approval、Sandbox 或真实 adapter。

### 2.2 缺口矩阵

| 领域 | 当前缺口 | 直接移植风险 |
|---|---|---|
| Host identity | production 尚未构造 authority/tenant/workspace/repository identity | 从 raw cwd 或 session path 派生会恢复旧路径 authority |
| writer ownership | CLI 持 session lock | 两客户端会竞争或各自持有分叉内存状态 |
| transport | 无 local endpoint/handshake/subscription | 无法证明 bounded、authenticated、recoverable |
| peer security | 无 channel-bound adapter | 仅靠 `0600` socket 会把本机用户误当可信 principal |
| process lifecycle | 只有 foreground result 与 raw detached child | 无 terminal truth、idempotency、stop、crash recovery |
| output | 内存字符串或 cwd log | 无 quota、digest、cursor、redaction、retention |
| execution security | Permission/Approval/Sandbox/Gateway 尚无真实 composition | 直接恢复后台 spawn 会绕过未来执行边界 |
| PTY | 无 neutral port/backend | TUI 容易直接持 raw PTY/PID |
| UI | OpenTUI P3/P5 尚未完成 | 先实现旧 renderer 会发生二次重写 |

## 3. 目标架构与所有权

```text
runledger client A ─┐
runledger client B ─┼─ authenticated local transport ─> RuntimeHost
runledger client N ─┘                                 ├─ SessionRegistry
                                                     │  └─ one Agent + one session writer
                                                     ├─ DriverCoordinator
                                                     ├─ Command/Query/Subscription Router
                                                     └─ ManagedProcessRegistry
                                                        └─ SecurityGateway
                                                           └─ pipe/PTY supervisor
                                                              ├─ bounded private output
                                                              └─ verified Artifact materialization

canonical session ledger      <- conversation/runtime config
canonical process event log   <- execution lifecycle/terminal/recovery
Trace Event Store             <- model/tool/context observability
Artifact CAS                  <- verified bounded content referenced by either domain
```

### 3.1 Client

Client 只负责：

- CLI 参数解析、Host discovery/connect-or-spawn；
- session select/create/fork 的 typed request；
- command/query/subscription；
- cursor/event ID 去重；
- editor、OpenTUI render、local view model；
- 申请/释放 driver，并携带 expected revision 发 mutation。

Client 禁止持有 session writer、`Agent`、canonical queue、approval waiter、managed process、raw output store 或 backend。

### 3.2 RuntimeHost

Host 负责：

- project/workspace scope 内唯一 startup/writer authority；
- `sessionId -> resident runtime` registry；
- 每个 session 唯一 `InteractiveSessionController`/`Agent`/ledger writer；
- connection/subscription/driver routing；
- managed process registry、resource budget、shutdown/recovery；
- Event/Artifact/Security adapter 的生产 composition；
- mutation close、drain、writer flush、最终 release 的固定顺序。

Host registry 是可丢弃 routing state，不是 durable truth。session/process 状态必须能从 canonical records 恢复。

### 3.3 Driver 与 observer

- observer 可 list/get/replay/subscribe；
- driver 才可 prompt、steer、interrupt、resolve reverse request、create/write/resize/stop process；
- claim/transfer 使用 `expectedDriverRevision`；
- mutation 同时绑定 Host generation、session generation、connection principal 和 driver revision；
- driver 断开不终止 turn/process；需要输入时进入 waiting，等待新 driver 显式 claim；
- 不自动把 last-active client 提升为 driver。

## 4. Current-format 合同

### 4.1 Host identity 与 compatibility

新增 `RuntimeHostScope`，必须绑定：

- canonical `authorityId/tenantId/workspaceId/repositoryId` 与 `workspaceStorageKey`；
- Runtime/control protocol schema version；
- Host binary/build digest；
- production composition digest；
- settings、model catalog、trace policy、安全 adapter、extension profile digest；
- peer attestor descriptor/generation；
- current-format session/storage contract version。

CLI override 只分两类：

1. versioned per-request：session selection/fork、provider/model/thinking；
2. Host-fixed：home/layout、安全 composition、diagnostics、extension/trace policy。

未知参数、旧 `sessionDir` 或 Host-fixed 冲突必须在连接前/handshake 中 typed reject，不能静默忽略。不存在 isolated writer fallback。

### 4.2 Transport

最小 wire surface：

```ts
type HostFrame =
  | InitializeRequest | InitializeResponse
  | CommandRequest | CommandResult
  | QueryRequest | QueryResult
  | SubscribeRequest | SubscriptionEvent
  | AckCursor | ResyncRequired
  | ReverseRequest | ReverseResponse;
```

约束：

- exact schema、bounded frame、bounded per-connection queue、bounded subscription buffer；
- command ID + request digest 幂等；同 ID 不同 body 拒绝；
- replay 在 session lock 内取得 head，replay 与 live 之间使用有界 buffer；采用 `register -> capture head/replay -> emit cursor -> activate live` 顺序消除切换窗口；
- overflow 返回 `resync_required` 与安全 cursor；
- transport ack 不等于 mutation durable；结果必须区分 accepted/durable/rejected/uncertain；
- principal 来自 channel attestation，不从 payload 自报；
- frame size、connection outbox、subscription replay、pre-activation pending、reverse-request waiter、ack window、每 principal/session subscription 数必须在 R1 冻结具体常量并进入 compatibility digest；
- queue 满时禁止无限等待 Host writer；query 可 typed reject，subscription 必须给出 last durable/safe cursor，reverse request 必须保持 Host-owned waiter 而不是转给任意 observer；
- subscription event ID 必须进入 wire envelope；不能只埋在 JSON 正文或依赖连接内序号；
- ticket 仅能在已 attested principal 上签发，绑定 Host/session generation、connection principal、用途与 expiry，并单次消费。

#### 4.2.1 Replay/live 原子切换

每个 subscription/PTY attachment 必须遵循同一状态机：

```text
requested
  -> registered_inactive
  -> replay_snapshot(headCursor, earliestCursor)
  -> replay_emitted
  -> cursor_emitted
  -> active_live
  -> detached | resync_required | closed
```

- 注册 inactive consumer 后才捕获 head，注册前事件由 durable replay 提供，注册后事件进入 bounded pending；
- `cursor_emitted` 前禁止向客户端交错 live frame；激活时按 event/output seq 排空 pending；
- request cursor 早于 retained earliest cursor、pending overflow 或 digest 不一致时，不返回伪造的空 replay，必须 `resync_required`；
- detach 幂等，只释放 attachment/queue/ticket，不 stop process、不释放 driver、不改变 durable cursor；
- focused test 必须在 replay snapshot、cursor emit、activate 三个边界注入并发 event，证明无 gap、无乱序、无重复 mutation。

### 4.3 Managed process

首版状态：

```text
queued -> starting -> running -> backgrounded
                    \-> completed | failed | timed_out | killed | lost | uncertain
```

核心 public DTO：

- `ExecutionHandleRef`：scope/session/generation/execution/attempt/revision/digest；
- `ManagedProcessRequest`：command descriptor ref、cwd workspace ref、pipe/pty、foreground/background、timeout/limits、correlation；
- `ManagedProcessSummary`：状态、terminal、output cursor/size、capability，不含 PID/path；
- `ManagedProcessOutputPage`：seq range、bounded UTF-8 text/ref、next cursor；
- `ManagedProcessMutationReceipt`：write/EOF/resize/detach/stop 的 previous/current revision 与 backend receipt digest；
- `ManagedTerminalEvidence`：exit/signal、termination policy、zero-member tree receipt、output evidence、settlement receipt。

内部 backend DTO 与 public DTO 必须物理分离：PID、process-group/job-object handle、raw command/env、PTY handle、spool locator 只存在于 private backend/recovery record。进程内 `Map` 只能缓存 hydrated projection；Host 重启后必须从 process event/output/recovery record 重建，不能把“registry 中不存在”解释为进程从未存在或已安全退出。

同一 command ID 的幂等边界覆盖 `execution_requested -> spawn claim -> backend spawn -> started receipt` 全窗口。任何响应丢失后的 retry 必须返回原 execution/attempt；不能像 process-local running-ID 去重那样在 terminal/restart 后重新 spawn。

首版命令：

- query：`process:list`、`process:get`、`process:output`、`process:capabilities`；
- mutation：`process:create`、`process:write`、`process:eof`、`process:resize`、`process:detach`、`process:stop`；
- model tools：`bash`、`process_output`、`write_stdin`、`process_stop`；
- TUI commands：`/processes`、`/terminal <executionId>`，不复用 `/tasks`。

### 4.4 Durable process events

至少包含：

- `process.execution_requested`；
- `process.execution_starting`；
- `process.execution_started`；
- `process.execution_backgrounded`；
- `process.output_checkpointed`；
- `process.termination_requested`；
- `process.execution_terminal`；
- `process.execution_lost`；
- `process.execution_uncertain`；
- `process.output_materialized` / `process.output_materialization_failed`；
- `process.execution_cleaned`。

必须 intent durable 后才能 spawn。started event 必须绑定 spawn/containment receipt；terminal/lost/uncertain 必须 immutable。每个 event 具有 aggregate-local sequence、event ID、previous revision 与 canonical digest；event append 与 projector advance 必须原子或可幂等重放。Trace recorder 可引用 execution/attempt ID 形成观测父子关系，但不能改写 process event。

## 5. 保存位置与 Artifact 边界

所有路径只从已解析的 `RunledgerLayout` 与 `workspaceStorageKey` 导出：

```text
<runledgerHome>/
├── ipc/hosts/<workspace-key>/          endpoint/startup metadata/local socket
├── state/hosts/<workspace-key>/        Host generation、writer/election receipts
├── state/processes/<workspace-key>/    private attempt/control/output checkpoint state
├── events/<UTC shard>/                 canonical current-format event streams
├── artifacts/sha256/<prefix>/<digest>  verified CAS content
├── artifact-metadata/                  bounded metadata
├── projections/                        rebuildable host/process query views
└── tmp/                                same-home atomic staging only
```

约束：

- 不向 cwd、项目 `.runledger/`、`~/.runledger/agent/` 或任意 `sessionDir` 写入；
- endpoint、state、spool 使用 no-follow、owner/mode、bounded size、atomic rename/fsync；
- public DTO/Event/TUI 不显示绝对路径、PID、raw command/env、credential 或 private spool locator；
- live ring、durable output、单页读取、总输出、input frame、session/Host process 数全部有硬上限；
- sealed output 只有在 digest/size/metadata 校验与读取授权通过后进入 Artifact CAS；
- `events` trace mode 仍可只保存 digest；managed process 的 private durable output/checkpoint 不因 trace mode 关闭而消失；
- Artifact materialization 失败必须保留 source/recovery receipt，不能伪造 ArtifactRef；
- retention 使用 plan/commit 与 expected revision，不删除仍被 pin、event、session 或 recovery 引用的数据；
- model/TUI preview、private durable output、Artifact CAS 是三个不同层次：preview 可截断，private output 支撑恢复，Artifact 是授权后的 immutable materialization；三者不得共用一个绝对路径 marker；
- output cursor 按 byte/record sequence 定义并说明 UTF-8 边界；截断、checkpoint、seal、page read 和 replay 都不得拆分 code point 或伪造连续 sequence；
- exited process retention 由 policy + durable reference/pin 决定，不能只依赖进程内“保留最近 N 个”计数。

## 6. 安全与生产门禁

### 6.1 多客户端门禁

生产 local listener 必须具有 channel-bound `PeerCredentialAttestorPort`：

- Unix 使用建立连接后的 peer credential 与 channel binding；
- Windows 必须有 named-pipe token/ACL/impersonation 等价证明；未实现时返回 unsupported；
- endpoint `0600`、PID、startup lock、共享 secret 文件都只是附加防护；
- attestor preflight/attest 失败时不发布 endpoint或立即关闭 channel；
- test attestor descriptor 永远不能进入 production composition；
- Basic Auth、Origin 检查和 single-use ticket 可作为应用层附加防护，但不能让缺少 OS channel attestation 的 listener 进入 production ready；
- attested principal 必须贯穿 initialize、driver claim、command、subscription、ticket issue/consume 和 audit receipt，连接 payload 不得覆盖它。

### 6.2 后台终端门禁

真实 spawn 前必须完成：

1. workspace/cwd containment 与 symlink/TOCTOU 校验；
2. `CapabilityGatewayPort` 决策；
3. 必要的 Approval terminal receipt；
4. `SandboxExecutionPort` 解析并产生可验证执行 plan/receipt；
5. Budget/resource reservation；
6. process-tree containment capability preflight；
7. output sink provision；
8. durable `process.execution_requested`；
9. spawn claim CAS；
10. backend spawn。

上述 barrier 适用于所有入口：model-facing Bash、CLI shell、直接 pipe/PTY create、foreground yield、explicit background、恢复后的 write/resize/stop。任何入口都不得直接调用 backend；Permission 必须在最终执行 leaf 再校验一次，catalog 可见性和上游预检不能替代该校验。

当前 Permission/Approval/Sandbox 没有生产行为实现，因此第 8 阶段之前只能完成中立合同、pure state、test-only backend 与负向门禁；不能把 raw local shell 当作生产 adapter。完成这些依赖后直接切换 canonical path，不增加 `managedProcessEnabled`、`--experimental-terminal` 等开关。

## 7. 目标文件与职责

```text
src/runtime/host/
  types.ts                       Host/connection/subscription/driver DTO
  contracts.ts                   exact schemas、compatibility、CLI override matrix
  client.ts                      typed remote facade、cursor/dedupe
  router.ts                      bounded command/query/subscription routing
  resident-sessions.ts           sessionId -> controller/writer owner
  driver.ts                      claim/transfer/generation/revision fencing
  lifecycle.ts                   connect-or-spawn、drain、recovery
src/runtime/process/
  types.ts                       neutral public DTO
  schemas.ts                     exact current-format schema
  state-machine.ts               pure transitions/terminal mapping
  events.ts                      process event payload/catalog
  projector.ts                   rebuildable projection
  manager.ts                     create/query/mutate/reconcile
  output.ts                      bounded ring/cursor/checkpoint contracts
  ports.ts                       security/backend/output/artifact ports
src/storage/host/
  endpoint-store.ts              safe endpoint metadata
  startup-election.ts            startup lock/stale decision
src/storage/process/
  output-store.ts                private bounded durable output
  process-backend.ts             pipe supervisor adapter
  pty-backend.ts                 platform capability adapter
  recovery-store.ts              attempt/spawn/containment receipts
src/cli/
  runtime-host-composition.ts     production-only Host client composition
  runtime-host-entry.ts           detached Host executable entry
src/runtime/tools/
  bash.ts                         foreground/background manager client
  process-output.ts               bounded read-only query
  write-stdin.ts                  bounded mutation
  process-stop.ts                 governed stop
src/tui/process/
  types.ts / reducer.ts / presentation.ts / controller-adapter.ts
src/tui/opentui/
  process-overlay.ts              list/detail/output/terminal input
tests/runtime/host/**
tests/runtime/process/**
tests/storage/{host,process}/**
tests/cli/multi-client/**
tests/tui/process/**
scripts/verify-multi-client-host.ts
scripts/verify-managed-process-pty.ts
```

`src/daemon/**` 不作为必需目录；当前分支将 Host 视为 Runtime composition，避免为了复刻旧树重新建立一套 daemon 领域。若后续还需远端 daemon，再由独立计划复用这里的 Host contracts。

## 8. 分阶段实施

每阶段遵循 RED -> GREEN -> refactor，并只提交该阶段明确路径。状态只有在当前目标分支具备 commit 和验证证据后才能从 `planned` 更新。

### R0：基线与 raw background closure

- RED：证明 `run_in_background` 直接导入 `child_process`、写 cwd `tmp/`、暴露 `logPath`、没有 stop/wait/recovery；
- 增加 structural checker，禁止 tool/TUI/CLI 直接导入 process/PTY backend；
- 删除 `spawnBackground()`；在 canonical manager 未接线期间对 background 明确返回 unsupported；
- 保持 foreground `ExecutionEnv.shell.exec()` 当前行为不变；
- 保存旧分支 acceptance manifest 的需求映射，不复制旧状态；
- checker 同时禁止新增“独立 PTY create API”、模型可见 PID/path 和 cwd/XDG 临时 full-output 文件作为替代后台路径。

验收：仓库中只有未来 backend allowlist 可导入 `node:child_process`；cwd 不产生新的 background log；background 请求返回 stable typed unsupported，且 process probe 证明没有 child 被创建。

### R1：Host/process exact contracts 与 pure state

- RED：Host compatibility、driver、process status/event/schema 模块不存在；
- 建立 branded IDs、bounds、canonical digest、exact schemas、error unions；
- 实现 driver pure coordinator、process state machine 与 deterministic projector；
- 扩展 `RunledgerLayout`/locator contract，加入 Host/process 固定相对 locator；
- production/test composition 类型分离；
- 冻结所有 frame/queue/replay/pending/output/page/input/process-count/retention bounds，并把 public DTO 与 backend/recovery DTO 分包。

验收：纯单测覆盖 unknown field、oversize、digest tamper、illegal transition、cross-scope/revision/generation 拒绝，以及 public schema 对 PID/path/raw command/env/private locator 的 unknown-field 拒绝。

### R2：In-memory Host 与多连接路由

- RED：第二客户端无法订阅同一 session；observer 可越权 mutation；慢消费者拖垮其他连接；
- 实现 test-only in-memory transport、Host router、resident session registry；
- Host 成为测试中的唯一 SessionManager lock/Agent owner；
- 实现 replay-then-live inactive registration、bounded pending/outbox、cursor/event ID dedupe、typed resync；
- 实现 explicit driver claim/transfer/release；
- 将 same-session coalescing coordinator 限定为 Host routing algorithm，session durable truth 仍来自 ledger/event records。

验收：两个 client 共享一个 Agent/session writer；同一 mutation 不执行两次；observer 只读；在 replay snapshot/cursor emit/activate 边界并发发布不丢不乱；慢 client overflow 后收到 safe cursor，fast client 与 writer 不阻塞。

### R3：Production endpoint、election 与 peer attestation

- RED：双启动竞态、stale endpoint、active writer/unreachable endpoint、伪造 peer；
- 实现 `ipc/hosts/<workspace-key>` endpoint 与 startup election；
- startup lock 只选 launcher，Host/session writer lock 保持最终 fence；
- 实现 Linux channel-bound peer adapter 与 production preflight；
- 非 Linux 未有等价 adapter 时 honest unsupported；
- endpoint owner/mode/no-follow/atomic publish 与 bounded stale cleanup；
- application ticket 只能在 attested connection 上签发并绑定 principal/generation/purpose；ticket-only、Basic-Auth-only 和 self-reported UID/PID 连接全部拒绝。

验收：并发 N 个 launcher 只出现一个 Host；active writer + endpoint 不可认证时 fail closed，不 force unlock；窃取 ticket、跨 scope replay ticket、伪造 payload principal 和无 attestor preflight 均不能到达 Host router。

### R4：标准 CLI 全量切换 Host

- RED：标准 `runledger` 仍在 client 进程中调用 `SessionManager.acquireLock()`；
- 把 create/open/continue/resume/fork、model selection、prompt/interrupt 全部改为 Host request；
- client 只接 remote facade；删除 production direct-controller composition；
- Host-fixed/per-request 参数 conflict typed 化；
- `/quit` 只断开 client，Host 按 residency policy drain/unload；显式 Host shutdown 另设管理命令；
- 禁止标准 TUI 临时启动一个随 client 退出的 Worker/server；内嵌 transport 只允许 test composition，生产始终走 canonical connect-or-spawn。

验收：两个标准 PATH TUI 连接同一 session；Host 是唯一 ledger lock owner；一个退出不终止另一个或正在运行的 turn；最后一个 client 退出后 Host residency/idle policy 可观测且不会静默降级为 direct writer。

### R5：Managed process domain、journal 与 manager

依赖 R2，可与 R3/R4 的 production transport 工作并行，但不得接入真实 spawn。

- RED：缺少 intent-before-spawn、idempotent create、terminal immutability、capacity；
- 实现 process event writer/projector、manager、resource budget、attempt journal；
- create 相同 command ID/body 返回同 execution/attempt，不同 body conflict；
- foreground yield 与 explicit background 返回同一种 `ExecutionHandleRef`；
- terminal/lost/uncertain 后 mutation 拒绝；
- 进程内 registry 只缓存 projection；清空 registry 后从 journal 重建必须得到相同 revision/status/capability。

验收：fake backend `spawnCount=1`；在 intent、claim、spawn、started response-loss 四个 crash gap 重试均不重复 spawn；active work 阻止 session unload；process-local running-ID 去重不能通过该阶段验收。

### R6：Security-owned backend 与 process-tree containment

硬依赖 Permission/Approval/Sandbox/Gateway 真实 adapter 与明确授权。

- RED：缺 port、approval denied、sandbox unavailable、containment unavailable 时仍能 spawn；
- 实现 capability/approval/sandbox/budget/output provision/intent/spawn 的固定 barrier；
- POSIX process group/supervisor 与 Linux PTY；
- timeout/abort/stop 杀完整 descendant tree，并取得 zero-member receipt；
- Host SIGKILL 后 supervisor containment，恢复只根据 receipt；
- Windows 只有 Job Object/ConPTY 等价 adapter 后才标记 supported。

验收：拒绝路径 `spawnCount=0`；真实 child/grandchild 全部回收；生产 factory 缺任一依赖时构造失败。

### R7：Durable output、Artifact 与恢复

- RED：output flood、ENOSPC/EIO、append/seal response loss、Host crash、digest tamper；
- 实现 bounded live ring、private output store、seq/checkpoint/seal；
- hard limit 触发安全 stop；
- terminal 后按授权 materialize 到现有 Artifact CAS；
- Trace tool node 只关联 execution/attempt/Artifact ref，不复制 process truth；
- 实现 retention plan/commit、pin 与 recovery marker。

验收：disconnect/reconnect 从 cursor 继续；Artifact digest/metadata 可验证；recording off 不破坏 process recovery。

### R8：Bash、process tools 与 Control Plane

- RED：background Bash 仍不经过 manager，observer 能 write/resize/stop；
- `bash` foreground/background 全部使用 Host process facade；
- 实现 `process_output`、`write_stdin`、`process_stop`；
- command/query/subscription 接入 driver fence、idempotency 与 bounded output page；
- client disconnect 仅 detach attachment，process 继续。

验收：工具返回 safe handle/summary，不含 PID/path；旧 raw spawn 和 logPath 文案彻底消失。

### R9：OpenTUI process/terminal 阅读与控制

依赖 OpenTUI 计划 P3 主 screen 与 P5 overlay/focus owner。

- RED：overlay input 穿透 editor、关闭后 draft/focus 丢失、resize frame 越界；
- 实现 `/processes` list/detail、`/terminal <id>` output/PTY overlay；
- observer 显示只读状态，driver 才显示 input/resize/stop action；
- output lazy page，不把完整日志常驻 view model；
- detach 只关闭 attachment，不发送 stop；
- 40x12、60x16、80x24、143x40 frame/input/focus 测试。

验收：真实 OpenTUI mockInput/frame、UTF-8、resize、driver transfer、关闭恢复 editor 全部通过。

### R10：Recovery、shutdown 与完整验收

- Host graceful shutdown：close admission -> drain turn/process -> seal/materialize -> terminal/settle -> flush writer -> release；
- Host crash、endpoint stale、driver disconnect、ack loss、slow subscriber、output failure、process tree uncertain fault matrix；
- 标准 PATH 双 client、same-session driver、Host restart、real PTY/tmux；
- Linux 自动矩阵通过后做独立只读审计；
- macOS/Windows 只按真实 capability 结论，不沿用 Linux 声明；
- 用户真实终端明确验收后才能标记 human-verified。

## 9. 阶段依赖

```text
R0 -> R1 -> R2 -> R3 -> R4
             \-> R5 -> R6 -> R7 -> R8
                              R4 + R8 + OpenTUI P3/P5 -> R9
                              R3 + R4 + R6 + R7 + R8 + R9 -> R10
```

允许并行：R5 pure domain 可在 R3/R4 期间推进。禁止并行：

- R4 不得绕过 R3 peer attestation；
- R6 不得在 Permission/Approval/Sandbox production adapter 前解冻；
- R8 不得保留 raw detached fallback；
- R9 不得在 OpenTUI overlay/focus authority 前建立旧 renderer 专用实现；
- R10 不得用 source-level fake、不同 home/scope 或手工删除 lock 代替标准 PATH 验收。

## 10. 验证矩阵

每阶段至少执行 focused tests、结构检查与：

```bash
npm run check
npm test
npm run build
git diff --check
```

最终新增命令建议：

```bash
npm run check:host-process-boundaries
npx vitest run tests/runtime/host tests/storage/host tests/cli/multi-client
npx vitest run tests/runtime/process tests/storage/process
bun test tests/tui/process/*.bun.test.ts
npm run verify:multi-client-host
npm run verify:managed-process-pty
```

最终 fault matrix 至少覆盖：

- 并发 startup、stale endpoint、active writer unreachable、peer forgery；
- same-session observer/driver、driver transfer、ack loss、cursor replay、slow subscriber；
- quick foreground、foreground yield、explicit background；
- stdin/EOF、PTY UTF-8/resize/detach、tree stop；
- output bounds/ENOSPC/EIO、Artifact tamper/materialization failure；
- Host SIGKILL、reconnect recovery、graceful shutdown deadline；
- no raw path/PID/credential/private reasoning leakage；
- recording off/events/events_and_artifacts 三种 Trace 模式下 process truth 一致。

## 11. 非目标

首版不实现：

- remote TCP/WebSocket、多用户 RBAC、跨机器 Host discovery；
- Kubernetes/container scheduler；
- 通过 PID/端口 reattach 未受管 orphan；
- 跨 Host live PTY migration；
- shell job-control 完整模拟；
- tmux/screen 作为生产 Runtime Host；
- browser terminal、binary upload、无限 timeout 或无限日志；
- 把 Task、Agent、LSP 与 process 合并成一个无领域边界 manager；
- 任何旧代际 Host protocol 兼容 reader 或双写；
- 未有真实 adapter 的 Windows/macOS 能力声明。

## 12. 完成定义

- [ ] 当前 raw detached `spawnBackground()` 和 cwd log 写入已删除；
- [ ] 标准 CLI 只有 authenticated connect-or-spawn Host 路径；
- [ ] Host 是唯一 session writer/Agent/process owner；
- [ ] 多 client replay/live、cursor/dedupe/resync 有 bounded tests；
- [ ] observer/driver 与 generation/revision fencing 覆盖所有 interactive mutation；
- [ ] production peer attestation 来自具体 channel；
- [ ] process intent-before-spawn、idempotency、terminal immutability 和 recovery 完整；
- [ ] Permission/Approval/Sandbox/Gateway/containment 任一缺失时 production spawn fail closed；
- [ ] foreground/background/pipe/PTY 统一由 manager 与 Host Control Plane 管理；
- [ ] output/cursor/quota/checkpoint/seal/Artifact/retention 全部有界且可恢复；
- [ ] recording mode 不影响 canonical process truth；
- [ ] TUI 不访问 Event/Artifact/spool/backend 文件，不暴露 PID/path/secret；
- [ ] production/test composition 完全分离，无 feature flag/fallback/legacy authority；
- [ ] focused、`npm run check`、`npm test`、`npm run build`、两套真实 runner 全绿；
- [ ] Linux 独立只读审计通过；
- [ ] 用户真实多终端与 PTY 验收后才标记 `human-verified`。
