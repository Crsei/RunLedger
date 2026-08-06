# Multi-client Runtime Host 与 Background Terminal 重构计划

> 状态：implemented，verification open；R0–R10 的 production Host/background-terminal 基线已在 `26d3c07` 提交，后续 hardening 已进入当前分支。本次收口补齐真实构建内容 identity、Host 运维命令、durable generation/shutdown intent、build mismatch fence 与 TUI/headless 自动重连。自动化证据、agent 操作的真实 tmux smoke、独立只读审计与 human acceptance 分开记录；只有真实操作者可填写 `human-verified`。
>
> 当前目标分支：`rollback/pre-governed-agent-harness-runtime`；初始设计基线 `51642f8`，补充审计基线 `cec1b7d447cb`，production Host 基线 `26d3c0791424`，本次生命周期收口基线 `8086e1b`。当前实现与测试仍不能替代 Linux 独立只读审计或人工验收。
>
> 旧实现参考：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger-agent-loop-resurrect`，审计快照 `98e1449`；multi-client 主集成点 `0a09255`，background-terminal 主集成点 `b19ff61`，最终 Linux fault/PTY 验证点 `6597032`。
>
> 外部实现参考：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/opencode`，只读审计基线 `dev@1882c33827`；`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/codex`，只读审计基线 `main@0b175e6439a8`；`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/grok-build`，只读审计基线 `main@c68e39f60462`。用户给出的 `codexh`、`grok-buildz` 路径在审计时不存在，因此分别解析到同级实际仓库 `codex`、`grok-build`；三者都只作为机制与反例证据，不作为 RunLedger 生产安全声明。
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
7. Trace `recording.mode=off|events|events_and_artifacts` 只控制可观测性记录：只有 `events_and_artifacts` 才把经授权和清洗的输出物化到 Artifact CAS 并产生 `ArtifactRef`；三种模式都必须保存 process lifecycle、private output checkpoint、恢复和执行约束 decision/receipt。
8. 生产 Host 缺少 channel-bound peer attestation 时不绑定 listener；生产 managed process 只硬依赖 Runtime-owned 审计决策接口与完整 receipt，不硬依赖限制性 Permission/Approval/Sandbox/Gateway/containment 实现。每个维度都允许显式 `none`，但 adapter/字段缺失、receipt 不完整或所选强约束不可用时不得 spawn。
9. 不引入 feature flag、rollout flag、环境变量开关或双生产路径。阶段未完成时显式 unsupported；完成后标准 CLI 只有 canonical Host 路径。
10. 生产对象和测试对象由完全分离的 composition 构造；测试 fake 不能进入生产 factory 或 production receipt。
11. 所有 replay/live、reverse request、PTY output、未激活 attachment pending 和 WebSocket/IPC outbox 都必须有界；任一消费者过慢只影响自身并得到 typed resync，不能拖垮 Host 或其他客户端。
12. 短期 ticket、socket mode、Basic Auth 或共享 secret 不能替代 channel-bound principal；PID、raw command/cwd/env、private output path 不能进入 public DTO、模型正文或普通 TUI event。
13. Agent 对后台执行的观测分为 non-blocking `process_output`、bounded `process_wait` 与 Host-owned completion follow-up；terminal 先成为 canonical process truth，后续通知按 execution/attempt/terminal sequence 幂等排入 durable Queue，不能靠进程内 watcher 直接启动第二个模型 turn。
14. 明确等待已向模型交付 terminal result、显式 stop 已交付同一 terminal result、自动 completion follow-up 三条路径共享一个 delivery key；最多一条路径取得 delivered 状态，timeout、取消、响应丢失或重复通知不能吞掉完成结果，也不能造成重复 Agent turn。

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
| Agent 非阻塞读取 | `process_output(ref,cursor)` 只返回 bounded preview/page、next cursor 与当前 summary；不等待、不忙轮询、不把 full output 塞入模型上下文 |
| Agent 显式等待 | `process_wait(ref,timeout)` 在固定上限内等待 terminal 或返回仍在运行的 typed snapshot；terminal result 成功交付后不会再生成重复自动 follow-up |
| 后台任务在 Agent idle 时完成 | terminal event durable 后生成至多一个 bounded completion follow-up；多个完成可批量，用户已排队输入优先，session paused/stopped/closed 时只记录 suppressed receipt |
| 后台任务在 turn 中完成 | 不打断当前 model stream/tool batch；在安全边界持久化 follow-up，当前 turn 收尾后再按 Queue revision 消费 |
| Host crash/restart | 不按 PID 猜测 reattach，不重复 spawn；根据 durable intent、spawn/containment/output receipt 投影为 running recovery、terminal、lost 或 uncertain |
| Trace 三种 recording mode | canonical session/process truth、private durable output、恢复和执行约束 receipt 完全一致；`off` 不写 Trace，`events` 只写 Trace Event，`events_and_artifacts` 才额外写 Artifact CAS/ArtifactRef |
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

证据入口：

- client/server：`packages/opencode/src/cli/cmd/{tui,serve,attach}.ts`；
- session coordinator：`packages/core/src/session/{execution/local,run-coordinator}.ts` 与根 `AGENTS.md` 的代际化 Session Core 约束；
- Event：`packages/core/src/event{,/sql}.ts`、`packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`；
- PTY/ticket：`packages/core/src/pty.ts`、`packages/core/src/pty/{ticket,protocol,pty.node,pty.bun}.ts`、HttpApi `handlers/pty.ts`；
- Bash/process：`packages/core/src/tool/bash.ts`、`packages/core/src/{process,cross-spawn-spawner}.ts`；
- BackgroundJob/output：`packages/core/src/{background-job,tool-output-store,global}.ts`；
- focused tests：`packages/core/test/{pty,tool-bash.test.ts,tool-output-store.test.ts,background-job.test.ts,session-run-coordinator.test.ts}` 与 `packages/opencode/test/server/` 下的 PTY/Event HttpApi tests。

由该审计新增的硬规则：

- RunLedger 可以复用 PTY attach 的 replay/live 激活算法，但 replay buffer、attachment pending 和 wire outbox 必须同时有界，并在截断时返回最早安全 cursor 或 `resync_required`；
- durable Event Store 能力不等于 transport 已可恢复；R2/R3 必须从标准 client 实测 cursor replay、ack loss 与 overflow；
- application ticket 只能作为已认证 channel 上的一次性 capability，不能使未 attested channel 获得 principal；
- Permission 维度的最终 decision 必须位于所有真实 spawn 的最终 leaf，包括直接 PTY create、foreground、background 和恢复后的 mutation；decision 可以是带 receipt 的 `none/allow`，但不能只依赖 model-facing Bash 的 catalog 可见性或上游预检；
- process-local coordinator/registry 可以作为 routing cache，绝不能成为 session/process terminal truth；
- bounded preview 不是 Artifact；只有 `recording.mode=events_and_artifacts` 且完整内容通过 digest/size/authorization/seal 校验后才能生成 ArtifactRef。

### 1.4 Codex 与 grok-build 后台观测审计

审计只读取当前 checkout，没有执行外部仓库测试，也不把 source/tests 存在等同于 RunLedger acceptance。Codex checkout 有一个与本次证据入口无关的 untracked `codex-rs/WEBSOCKET_PROXY_ISSUES.md`，未读取也未纳入结论；grok-build checkout 干净。两个实现的关键差别是：Codex 完成了稳定进程 ID、bounded yield/poll 和 UI exit event，但模型仍需显式 `write_stdin` 轮询；grok-build 进一步实现 completion notification -> synthetic prompt/idle drain，让 Agent 能在任务结束后继续推理。

| 领域 | Codex `main@0b175e6439a8` | grok-build `main@c68e39f60462` | RunLedger 结论 |
|---|---|---|---|
| 启动/交接 | `exec_command` 等待 250–30,000 ms；仍运行则返回 numeric process ID | `is_background=true` 立即返回 UUID task ID；foreground 也可在 block budget 后转 background | 采用“短等待后返回稳定 handle”，但 public 只返回 `ExecutionHandleRef`，不返回 PID/裸 ID |
| 进程所有权 | `UnifiedExecProcessManager` 的进程内 `HashMap`，上限 64；session 清理会 terminate all | `LocalTerminalActor` 的进程内 `HashMap` + completion waiters + session-lifetime tombstone | 只采用 actor/interaction serialization；registry 是 cache，truth 来自 process journal/output/recovery receipt |
| 输出 | 1 MiB retained buffer、10k token 默认、UTF-8 delta、head/tail tool result | 内存 preview + session `terminal/*.log`，有 file cap，但向模型返回 `output_file` | 采用 bounded preview/delta；拒绝绝对路径 marker，full output 只进 private durable output，CAS 仍只在 `events_and_artifacts` 物化 |
| 主动观测 | `write_stdin(chars="")` 同时承担 poll/wait，空 poll 可等待 5s–5min；同一 process interaction 串行 | `get_terminal_command_output`：timeout 省略/0 为 snapshot，正数为 capped wait，支持多 ID wait-all | 分离 `process_output` 与 `process_wait`；waiter 可丢，terminal truth/command idempotency 不可丢；首版不做 wait-all |
| 完成事件 | exit watcher 排空 trailing output 后发一次 `ExecCommandEnd` 给 session/client；不会自动产生模型 turn | `TaskCompleted` 可立即生成 synthetic prompt，或进入 idle-gated notification batch；`block_waited`/`explicitly_killed` 抑制重复 wake | 采用 typed completion、idle gate、用户输入优先、batch 与 delivery dedupe；必须先 durable terminal，再通过 canonical Queue 排 follow-up |
| 去重/竞态 | poll 观察 terminal 后移除 in-memory entry；没有 durable delivery key | `AutoWakeDeliveredIds`、reported set、`block_waited` 协调 wait/reminder/auto-wake，并有 cancel/queued-user PTY 测试 | delivery key 固定为 execution/attempt/terminal sequence/policy digest；状态以 Queue event/receipt 持久化，不用内存 set 充当 truth |
| UI/传输 | async output/end event 与 background terminal list；list 公开 process ID/command/cwd | completion/background notifications 持久化后 replay 给 pager，但内部通道大量使用 unbounded sender | client subscription 与 Agent follow-up 分开；public DTO 禁 PID/command/cwd/path；所有 pending/outbox/notification queue 有固定 bound |
| 执行约束 | unified exec 在 process manager 前编排 approval、sandbox、permission profile/network approval | local terminal 有 process group/cgroup/sandbox integration，但存在 `--yolo`/直接 backend 与无 RunLedger receipt 的路径 | Codex 的“policy/sandbox before manager”可作为顺序参考；RunLedger 只要求 final-leaf 形成完整约束快照与 receipt，允许每个维度显式 `none`，不能把 adapter 缺失或直接 backend 调用伪装成 `none` |
| 恢复 | process/output registry 非 durable，不能跨核心进程重建 managed process truth | completion UI notification可 replay，但 process/tombstone/output locator 主要是 session 进程内/普通文件 | 只采用 UI replay 机制；Host crash 后必须从 RunLedger canonical records 投影 terminal/lost/uncertain，不按外部 registry 语义恢复 |

Codex 证据入口：

- `codex-rs/core/src/tools/handlers/shell_spec.rs`：`exec_command`/`write_stdin` 的 yield、poll 与 token bound；
- `codex-rs/core/src/unified_exec/{mod,process_manager,async_watcher}.rs`：in-memory store、interaction lock、streaming output、exit watcher、prune/terminate；
- `codex-rs/core/src/tools/runtimes/unified_exec.rs`：approval/sandbox orchestration；
- `codex-rs/core/src/codex_thread.rs`、`codex-rs/app-server/README.md`：background terminal list/API 及其 PID/command/cwd 暴露边界；
- `codex-rs/core/tests/suite/unified_exec.rs`：初次 yield、空 poll、stdin、exit metadata 与 output clamp 行为测试。

grok-build 证据入口：

- `crates/codegen/xai-grok-tools/src/implementations/grok_build/bash/mod.rs`：explicit/auto background、task handle、completion 提示；
- `crates/codegen/xai-grok-tools/src/computer/{types,local/terminal}.rs`：actor、process registry、completion waiter、process scope、file output 与 tombstone；
- `crates/codegen/xai-grok-tools/src/implementations/grok_build/task_output/{mod,terminal_command}.rs`：snapshot 与 bounded wait；
- `crates/common/xai-tool-runtime/src/notification.rs`：typed `TaskCompleted`/background/output notifications；
- `crates/codegen/xai-grok-shell/src/tools/notification_bridge.rs` 与 `session/acp_session_impl/notification_drain.rs`：auto-wake、idle gate、batch、dedupe、persistence；
- `crates/codegen/xai-grok-shell/src/session/acp_session_tests/auto_wake_suppression_tests.rs` 与 `xai-grok-pager/tests/pty_e2e/auto_wake_cancel_preserves_queued_user_prompt.rs`：重复抑制、synthetic turn 取消与用户排队消息存活。

由该审计新增的硬规则：

- `process_output` 是立即 snapshot/page，`process_wait` 才能阻塞；禁止用高频空 poll 或 sleep-wait 消耗 model/tool turn；
- wait timeout 只结束 waiter，不改变 process 状态，不取得 delivered；wait cancel/Host crash 后 terminal completion 仍可生成 follow-up；
- Agent completion follow-up 不是 client subscription event 的别名；必须由 Host scheduler 在 terminal durable 后写 `queue.enqueued`，再由 exact `queue.claimed`、`queue.consumed`、`queue.cancelled` receipt 驱动；
- completion follow-up 只含 execution ref、terminal summary、bounded preview、output cursor 与获取工具提示；禁止 raw command/env/cwd/PID/private locator/full output；
- 用户输入优先于 synthetic completion；多个同时完成合并为一个 bounded follow-up；当前 turn 不被异步完成打断；
- explicit wait/stop 已交付 terminal、auto follow-up 已排队/消费、suppressed completion 之间必须原子或可幂等 reconcile，任何 crash gap 最多产生一次模型可见 completion；
- synthetic completion turn 必须带 origin/delivery key/budget/policy digest，进入正常 Agent 单飞、Queue revision、usage/trace 与 interrupt 语义；不能从 watcher 直接调用 `Agent.prompt()`；
- notification queue、completion batch、waiter、preview 与 injected context 都有固定常量；超限合并为 digest/count/cursor 或 typed resync，不使用 unbounded channel；
- completion 自动恢复与 recording mode 无关；`off` 仍可恢复/通知，`events` 只增加 Trace Event，只有 `events_and_artifacts` 才调用 Artifact Store。

### 1.5 采用与拒绝

采用：

- 单 Host 持 writer、客户端只持 remote facade；
- startup election 不是最终 fence，writer/session lock 才是；
- compatibility handshake、bounded transport、cursor replay、event ID dedupe；
- 一个显式 driver，observer 只读，reverse request 单播；
- process intent-before-spawn、deterministic state machine、bounded output、显式 containment mode 与可审计 settlement；
- Host crash 不按 PID 猜测 reattach，只有 receipt 能形成 terminal/lost/uncertain；
- Artifact 只保存经过授权和清洗的 bounded content，public event 只保存 digest/ref；
- opencode 的 same-session coordinator、PTY replay/cursor/activate、single-use scoped ticket、exited retention 和 leaf Permission 作为局部算法参考；
- Codex 的 initial bounded yield、per-process interaction serialization、UTF-8 output delta、exit watcher 与 policy/sandbox-before-manager 顺序作为局部算法参考；
- grok-build 的 snapshot/positive-timeout wait、typed completion、idle-gated batch、用户输入优先和 delivered 去重作为 Agent completion bridge 参考；
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
- 直接 PTY/terminal create 绕过 Runtime-owned execution-decision/audit barrier。
- Codex/grok-build 的 process-local registry、session-lifetime tombstone、numeric PID/process ID 或普通 output file 成为 RunLedger recovery truth；
- watcher/notification bridge 直接启动 Agent turn、unbounded session command channel、内存 delivered set 或 feature flag 成为 completion authority；
- 把 client/TUI 已收到 terminal event 误判为模型已经读取完成结果，或把自动 follow-up 与显式 wait 同时交付给模型。

## 2. 当前分支事实与缺口

### 2.1 当前事实

- `src/cli/main.ts` 只解析 canonical layout/settings，通过 authenticated `connectProductionRuntimeHost()` 连接或启动 resident Host；session lock、`InteractiveSessionController`、`Agent`、工具和 process facade 都留在 Host。
- `Agent`、消息、steering/follow-up queue、AbortController 与工具执行由 Host 持有；第二个 client 通过同一 Host session 复用状态，并受 driver/revision fence 约束。
- Host-owned completion Queue、terminal watcher/reconciler 与 `Agent` completion bridge 已接线；`04` 的 queue contract 仍是被动状态 authority，CLI/TUI event 或 RPC response 不作为 durable delivery 证据。
- `SessionManager` 已固定到 canonical user home，session 只能写 `sessions/YYYY/MM/DD/`；这项 S0–S5 结果必须保留。
- `RunledgerLayout` 已有 `state`、`ipc`、`log`、`events`、`artifacts`、`projections` 和 `tmp`；Host/process scoped locator、endpoint/election、writer lease、recovery marker 与 durable stores 已接入 production composition。
- `src/runtime/tools/bash.ts` 的 raw detached `spawnBackground()` 已删除；foreground/background 均通过 Host-owned process facade，CLI/TUI 不再保留 raw spawn 或独立 PTY fallback。
- `src/runtime/host/**`、`src/runtime/process/**` 与 `src/storage/{host,process}/**` 的 production baseline 已提交于 `26d3c07`；后续 hardening 与本次 Host 生命周期收口均在当前分支实现。它们不能替代独立审计或人工验收。
- 当前 Trace Event Store/Artifact Store 记录模型、上下文和工具调用；它们是 observability truth，不是 session/process mutation truth。
- OpenTUI process overlay 已接入 `InteractiveMode` 的 `/processes` 与 `/terminal <executionId>`，通过 production Host safe facade 做 lazy output 与 driver-fenced mutation；真实多终端 TUI 仍需人工验收。
- `04` 只冻结 contract 与 port，不实现 daemon、Control Plane、Permission、Approval、Sandbox 或真实 adapter。

### 2.2 缺口矩阵

| 领域 | 当前缺口 | 直接移植风险 |
|---|---|---|
| Host identity | production 已构造 exact authority/tenant/workspace/repository scope 与 compatibility digest | 跨平台 adapter 与独立审计仍未闭合 |
| writer ownership | resident Host 已是唯一 session/ledger/process writer，client 只持 remote facade | 真实双终端仍需人工确认单 writer 与 detach 行为 |
| transport | production Unix listener、handshake、bounded pre-attestation/frame/outbox、durable replay、cursor ACK 与 connect-or-spawn 已接线 | Windows named-pipe adapter 未实现；ack loss/slow subscriber 仍需 fault/human evidence |
| peer identity | Linux channel-bound `SO_PEERCRED` helper/attestor 已接入 production Host | Windows named-pipe 等价 adapter 未实现；跨平台结论必须按 capability 返回 unsupported |
| process lifecycle | durable journal/recovery、真实 pipe、Host-owned node-pty、mutation/settlement adapter 与 deadline-bounded lifecycle 已接入 production composition | 真实 Host crash/recovery 已有 runner 与 tmux smoke；用户环境验收仍待人工闭合 |
| output | private durable output、UTF-8 cursor/checkpoint/seal/retention、mode-aware Artifact materialization 已接入 Host process facade | Artifact/Trace fault audit 与独立审计仍未闭合 |
| Agent observation | `process_output/process_wait/write_stdin/process_stop/process_resize`、durable Queue reconciler 与 explicit suppression 已通过 Host-owned Agent composition 接线 | response-loss/reconcile fault matrix 与人工多终端验收仍需完成 |
| execution decision | 五维 snapshot、builtin-none、receipt barrier 与独立 Host-owned decision context 已传到 backend final leaf，并再次绑定 request/handle | 限制性 Permission/Approval/Sandbox/Gateway adapter 仍未实现，选择这些 profile 时 fail closed |
| PTY | production Host 私有 node-pty、UTF-8/resize/detach/control、第二 client cursor recovery 与 runner 已通过 | runner 是 POSIX automated acceptance，不是生产 tmux Host 或跨平台 PTY 声明 |
| UI | safe process overlay 已接入 `InteractiveMode` 与 production Host facade，lazy page、observer read-only、focus restore 有 focused/Bun evidence | 真实双终端 TUI 与 human acceptance 仍缺 |

### 2.3 Host 生命周期、构建替换与客户端恢复

当前 production 语义固定为：`/quit` 只 detach client，最后一个 client 退出也不关闭 resident Host；活跃 turn 与 managed process 继续由 Host 持有。当前 session actor 尚未实现“工作态驻留、空闲态卸载”，已加载 session 会继续留在 Host 内存；这项资源回收属于后续专项，不能借关闭最后一个 client 偷换语义。

构建与 endpoint identity：

- `npm run build` 在 TypeScript/native helper 完成后生成并校验 `dist/host-build-manifest.json`；content digest 覆盖 CLI/Host bundle、Runtime、contract/security、catalog 与实际发布的 native helper，不再只绑定 package semver 或 protocol version；
- endpoint 绑定 Host PID、Linux boot/process-start/UID/executable identity digest、build digest、Host generation、发布时间、management protocol 与完整 metadata digest；篡改、旧格式、构建内容不一致均 fail closed；
- 同版本重新编译只要产物内容变化就得到不同 digest。新 client 遇到旧 build 返回结构化 `host_build_mismatch`，不会静默复用旧 Host，也不会自行 SIGTERM 正在执行的 Host；
- durable Host generation 位于 canonical `state/hosts/<workspace-key>/`，endpoint 删除或 crash 后仍单调递增；generation 和 shutdown intent store 都逐祖先拒绝 symlink/越界，并在原子替换前复验 containment。

运维面：

- `runledger host list [--json]` 枚举 canonical home 中的 Host；`status [--workspace-key ...] [--json]` 显示 endpoint、lease、build/protocol、client/session、active turn 与 managed process 计数；
- `stop|restart` 通过独立 management connection 调用现有 `host.shutdown`。Host 有 active turn/process 时返回 `host_busy`，只有显式 `--confirm-active` 才进入既有完整 drain；
- `restart` 写入 `maintenance_restart + targetBuildDigest` intent，等待 endpoint/lease 释放后再走正常 connect-or-spawn。后续 election 的 candidate generation 必须更高且 build digest 必须命中 target，防止旧二进制抢回 leadership；
- `--force` 只用于 management socket 不可连接时：Linux 上重复核验 socket owner PID 与 endpoint process-start identity 后发送一次 `SIGTERM`，绝不自动升级为 `SIGKILL`。跨平台没有等价证据时返回 `force_stop_unsupported`；
- `auto_update` 仍明确返回 `updater_unavailable`，不伪造下载、发布、drain 或 relaunch 已完成。

稳定客户端桥：

- connection close 统一再次调用 production `connect-or-spawn`；TUI 使用上限为 1 秒的指数退避并无限重试，headless 最多尝试 5 次；
- 每次连接激活递增 client-local connection generation，旧代 response/event 不能跨代写入当前状态；恢复失败的新连接在下一次尝试前显式关闭；
- mutation 重试保留原 frame、command ID 与 body，依赖 Host durable command journal 幂等重放；`uncertain_outcome` 不盲目重试，转入 `recovery_required`；
- 重连后按 `session.open -> session.claim_driver -> session.subscribe(cursor)` 恢复，subscription event 继续按 event ID/sequence 去重；`resync_required` 时读取 authoritative snapshot，并从 safe cursor 重建；
- TUI 状态是 `ready|reconnecting|stopped|build_mismatch|recovery_required`。重连期间保留 transcript，但拒绝新的 mutation 并返回 `host_reconnecting`；
- identity-matched `manual_stop|external_signal` shutdown intent 使原 client 停在 `stopped`，不把明确手动关闭误判为 crash；`maintenance_restart` 与无 intent crash 则透明恢复。

### 2.4 当前候选验证证据

2026-08-07 的当前候选必须以以下 fresh gates 为准：

```bash
npm run check
npm test
npm run build
npm run verify:multi-client-host
npm run verify:managed-process-pty
npm run verify:host-build-replacement
git diff --check
```

`verify:host-build-replacement` 使用两个 package version 相同、内容不同的真实 `dist`，验证 `same_version_different_content`、`host_build_mismatch`、`maintenance_target_fence` 与 `replacement_generation_advanced`。本轮另以隔离 `RUNLEDGER_DIR` 做过 agent 操作的真实 tmux smoke：generation 1 Host 被 `SIGKILL` 后，存活 TUI 通过同一 connect-or-spawn 路径拉起 generation 2 并恢复原 session；`host restart` 前进到 generation 3；`host stop` 后 client 显示 stopped，等待后 `host status` 仍为 `host_not_found`。这项 smoke 证明真实进程组合，不等于 10.3 的 `human-verified` 签字。

## 3. 目标架构与所有权

```text
runledger client A ─┐
runledger client B ─┼─ authenticated local transport ─> RuntimeHost
runledger client N ─┘                                 ├─ SessionRegistry
                                                     │  └─ one Agent + one session writer
                                                     ├─ DriverCoordinator
                                                     ├─ Command/Query/Subscription Router
                                                     └─ ManagedProcessRegistry
                                                        └─ AuditedExecutionFacade
                                                           └─ pipe/PTY supervisor
                                                              ├─ bounded private output
                                                              └─ verified Artifact materialization
                                                                 (events_and_artifacts only)

canonical session ledger      <- conversation/runtime config
canonical process event log   <- execution lifecycle/terminal/recovery
Trace Event Store             <- model/tool/context observability
Artifact CAS                  <- events_and_artifacts 下验证后的 bounded content
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
- Event/Artifact/execution-decision provider 的生产 composition；
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
- settings、model catalog、trace policy、执行约束 profile/provider、extension profile digest；
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
- `ManagedProcessWaitRequest`：execution ref、expected revision、positive timeout、command/delivery correlation；
- `ManagedProcessWaitResult`：`terminal|running|timed_out|cancelled|uncertain`、summary、bounded preview/next cursor、terminal evidence ref；
- `ProcessCompletionEnvelope`：delivery key、origin、execution/attempt/terminal sequence、bounded summary/preview/cursor、policy/budget digest；
- `ManagedProcessMutationReceipt`：write/EOF/resize/detach/stop 的 previous/current revision 与 backend receipt digest；
- `ManagedTerminalEvidence`：exit/signal、termination policy、containment mode、tree settlement outcome、output evidence、settlement receipt；只有实际启用并验证 tree containment 时才能声明 `zero_members`。

内部 backend DTO 与 public DTO 必须物理分离：PID、process-group/job-object handle、raw command/env、PTY handle、spool locator 只存在于 private backend/recovery record。进程内 `Map` 只能缓存 hydrated projection；Host 重启后必须从 process event/output/recovery record 重建，不能把“registry 中不存在”解释为进程从未存在或已安全退出。

同一 command ID 的幂等边界覆盖 `execution_requested -> spawn claim -> backend spawn -> started receipt` 全窗口。任何响应丢失后的 retry 必须返回原 execution/attempt；不能像 process-local running-ID 去重那样在 terminal/restart 后重新 spawn。

首版命令：

- query：`process:list`、`process:get`、`process:output`、`process:capabilities`；
- wait：`process:wait`，只接受 positive timeout 并受 compatibility 常量上限约束；
- mutation：`process:create`、`process:write`、`process:eof`、`process:resize`、`process:detach`、`process:stop`；
- model tools：`bash`、`process_output`、`process_wait`、`write_stdin`、`process_stop`；
- TUI commands：`/processes`、`/terminal <executionId>`，不复用 `/tasks`。

命名固定为 Control Plane `process:wait`、model-facing `process_wait`；二者共享 `ManagedProcessWaitRequest/Result` 语义，但 tool adapter 只能返回进一步收窄和清洗后的模型可见结果。

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
- `process.execution_cleaned`。

只有 `recording.mode=events_and_artifacts` 才允许 Trace recorder 记录 bounded Artifact materialization 成功/失败观测；具体 Trace event name 由 trace 专项计划与当前 Trace schema 拥有，本文不新增第二套 exact catalog。这类观测不是 process projector、terminal 判定或 recovery 的输入。

必须 intent durable 后才能 spawn。started event 必须绑定 execution constraint snapshot、spawn receipt 与实际 containment decision/receipt；`containment=none` 也必须有显式 decision，不能省略字段。terminal/lost/uncertain 必须 immutable。每个 event 具有 aggregate-local sequence、event ID、previous revision 与 canonical digest；event append 与 projector advance 必须原子或可幂等重放。Trace recorder 可引用 execution/attempt ID 形成观测父子关系，但不能改写 process event。

### 4.5 Agent observation、wait 与 completion follow-up

三条观测路径共享 canonical process projection，但职责严格分开：

```text
process_output(ref, cursor) ──> immediate bounded page/snapshot
process_wait(ref, timeout)  ──> ephemeral waiter ──> terminal or typed timeout
process.execution_terminal  ──> completion reconciler ──> durable Queue follow-up
```

`process_output` 不等待；`process_wait` 不读取无界正文。waiter 只是 Host 内等待优化，不是 durable truth：terminal 早于 register 时直接读 projection，register 后 terminal 由 aggregate sequence 唤醒；timeout/cancel 只释放 waiter。Host 在 wait 中崩溃时，恢复后的同 command ID 重试读取同一 terminal projection，不重新 spawn，也不把 unknown 当 completed。

completion delivery key 固定覆盖 `authority/session/agent/execution/attempt/terminalSequence/deliveryPolicyDigest`。以下名称是由 process terminal、tool result 和 `04` exact Queue events 投影出的 delivery 状态，不是新的 durable event family：

- `pending`：terminal durable，但尚未向模型交付；
- `explicit_delivery_committed`：显式 wait/stop 的 terminal tool result 已 durable 绑定 terminal evidence，并进入可恢复的 Agent 输入范围；
- `follow_up_enqueued`：已写 `queue.enqueued`，等待正常 Agent 单飞消费；
- `follow_up_claimed`：已写 `queue.claimed`，但还没有模型可见 delivery；claim 丢失或 interrupt 后仍可按 Queue revision 恢复或取消；
- `follow_up_consumed`：已写 `queue.consumed`，且目标 turn input range 已绑定该 Queue item；
- `suppressed`：session paused/stopped/closed、terminal 已由其他路径交付，或 policy 明确禁止自动恢复；
- `uncertain`：跨 writer/flush 响应丢失，只允许从 event/queue head reconcile，不能盲目再 enqueue。

“模型可见 delivery”只以 durable Agent input range 为准：TUI/client 收到 terminal event、tool RPC 返回网络响应、Queue claim 或 watcher 内存标记都不算 delivered。若 tool result 已 durable 但下一次 provider 调用尚未开始，恢复必须沿原 turn/input range 继续，不能再生成 synthetic follow-up；若 durable 状态不确定，则先按 event ID、tool call ID、Queue item ID 和 revision 对账。

固定行为：

- terminal event durable 前禁止发 completion；client/TUI event、Trace Event、Artifact materialization 都不能触发模型继续；
- 当前 turn 活跃时不 interrupt model stream/tool batch，只在安全边界 enqueue；idle 时也必须先写 durable Queue，不能 watcher 直接调用 `Agent.prompt()`；
- pending user prompt/steering 高于 completion follow-up；多个 completion 在固定时间窗/数量/bytes 内按 terminal sequence 批量，超限只给 count/digest/cursor；
- batch 中每个 completion 保留自己的 delivery key；一个 Queue item 保存排序后的 member key 列表与 batch digest，claim/consume/cancel 对全部 member 做同 revision 投影，禁止同一 member 同时进入第二个 batch；
- synthetic follow-up 使用独立 origin，正文只含 safe execution ref、terminal status、duration/exit category、bounded redacted preview、next cursor 和 `process_output` 提示；
- explicit wait/stop 返回 terminal 并完成 tool-result durability 后，必须以同一 delivery key 对尚未消费的 Queue item 写 `queue.cancelled` 或投影为 suppressed；来自 TUI/observer 的 stop receipt 本身不代表模型已读取 terminal。wait timeout/cancel 不取得该权利；
- follow-up claim 后被 interrupt 必须按 Queue revision 回到可恢复状态或得到明确 cancelled receipt，不能悄悄标记 delivered；
- 自动 follow-up 仍经过 Agent 单飞、turn budget、context bound、usage/trace 和 session stop；它不是高优先级隐藏控制通道；
- completion delivery 不依赖 `recording.mode`，也不以 ArtifactRef 是否生成决定是否通知。

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
- 只有 `recording.mode=events_and_artifacts` 时，sealed private output 才在 digest/size/metadata 校验与读取授权通过后进入 Artifact CAS；`off` 和 `events` 不调用 Artifact Store；
- `events` trace mode 仍可只保存 digest；managed process 的 private durable output/checkpoint 不因 trace mode 关闭而消失；
- `events_and_artifacts` 下 Artifact materialization 失败必须记录失败 receipt，不能伪造 ArtifactRef，也不能改变已经成立的 process terminal/recovery truth；
- retention 使用 plan/commit 与 expected revision，不删除仍被 pin、event、session 或 recovery 引用的数据；
- model/TUI preview、private durable output、Artifact CAS 是三个不同层次：preview 可截断，private output 支撑恢复，Artifact 是授权后的 immutable materialization；三者不得共用一个绝对路径 marker；
- output cursor 按 byte/record sequence 定义并说明 UTF-8 边界；截断、checkpoint、seal、page read 和 replay 都不得拆分 code point 或伪造连续 sequence；
- exited process retention 由 policy + durable reference/pin 决定，不能只依赖进程内“保留最近 N 个”计数。

## 6. 身份、审计决策与生产门禁

### 6.1 多客户端门禁

生产 local listener 必须具有 channel-bound `PeerCredentialAttestorPort`：

- Unix 使用建立连接后的 peer credential 与 channel binding；
- Windows 必须有 named-pipe token/ACL/impersonation 等价证明；未实现时返回 unsupported；
- endpoint `0600`、PID、startup lock、共享 secret 文件都只是附加防护；
- attestor preflight/attest 失败时不发布 endpoint或立即关闭 channel；
- test attestor descriptor 永远不能进入 production composition；
- Basic Auth、Origin 检查和 single-use ticket 可作为应用层附加防护，但不能让缺少 OS channel attestation 的 listener 进入 production ready；
- attested principal 必须贯穿 initialize、driver claim、command、subscription、ticket issue/consume 和 audit receipt，连接 payload 不得覆盖它。

### 6.2 Runtime-owned 执行决策门禁

RunLedger 的首要目标是审计真实执行，不是强制所有环境启用同一种安全机制。真实进程只服从当前 Runtime/Agent 冻结的 execution constraint snapshot；Permission、Approval、Sandbox、Gateway 和 process-tree containment 是五个可独立选择的约束维度，不是 backend 能否存在的先验条件。

`none` 是一等、可审计的生产决策，不是缺省值。当前格式固定表达为：

| 维度 | 显式无约束结果 | 约束模式结果 |
|---|---|---|
| Permission | snapshot `mode=none`，`CapabilityDecisionReceipt.decision=allow`，provider 标识 builtin-none policy | `mode=policy`，返回 `allow|ask|deny` 与 policy revision |
| Approval | snapshot `mode=none`，process execution constraint receipt 记录 `not_required`，不伪造人工 approver 或 `ApprovalReceiptRef` | `mode=required`，必须取得 terminal `ApprovalReceiptRef` |
| Sandbox | snapshot `mode=none`，映射现有 `requested=off`、`effective=off`、`enforcement=off` | `mode=profile`，必须取得所选 profile 的 execution receipt |
| Gateway | snapshot `mode=none`，route 记录 `direct_local` | `mode=mediated`，必须取得目标 gateway receipt |
| containment | snapshot `mode=none`，tree settlement 记录 `not_requested`；只对被跟踪根进程的实际状态负责 | `mode=process_group|supervisor`，按平台能力记录 `zero_members|unknown` |

所有 `none` provider 都是 production composition 中的 Runtime-owned builtin adapter，只负责生成稳定、可验证的 decision/receipt；它们不是 test fake，也不得把自身报告为 enforced。每份 constraint snapshot/receipt 至少绑定 principal、authority/tenant/workspace、command/request digest、execution/attempt、policy/provider revision、decision 时间和 canonical digest。adapter 或字段缺失、receipt digest 不匹配、把异常吞成 `none`，仍然 fail closed；选择了强约束模式但对应能力 unavailable 时也必须在 spawn 前返回 typed unsupported/denied。

真实 spawn 前必须完成：

1. command、workspace/cwd identity 与 canonical digest 解析；workspace/path 限制可以选择 `none`，但不能省略被执行位置的审计身份；
2. 冻结 Permission/Approval/Sandbox/Gateway/containment execution constraint snapshot；
3. 对每个维度取得 decision/receipt；显式 `none` 走 builtin provider，强约束模式走对应 adapter；
4. Budget/resource reservation；
5. 所选 containment mode 的 capability preflight；`none` 直接记录 `not_requested`；
6. output sink provision；
7. durable `process.execution_requested`，绑定 constraint snapshot digest；
8. spawn claim CAS；
9. backend spawn；
10. durable started/failed/uncertain receipt。

上述 barrier 适用于所有入口：model-facing Bash、CLI shell、直接 pipe/PTY create、foreground yield、explicit background、恢复后的 write/resize/stop。任何入口都不得直接调用 backend；最终 leaf 必须重新校验或消费绑定当前 execution/attempt 的不可变 constraint snapshot。catalog 可见性、上游预检和“本机默认允许”都不能替代该审计决策。

当前 Permission/Approval/Sandbox 的限制性生产行为尚未完成，不再阻塞真实 process backend：先实现五个 Runtime-owned builtin-none provider 和统一 receipt barrier，即可在明确无约束 profile 下进入 canonical backend。用户选择限制性 profile 时，未实现能力必须如实返回 unsupported，不能静默降级为 `none`。切换后标准 CLI 仍只有 canonical path，不增加 `managedProcessEnabled`、`--experimental-terminal` 等双路径开关。

## 7. 目标文件与职责

```text
src/runtime/host/
  types.ts                       Host/connection/subscription/driver DTO
  contracts.ts                   exact schemas、compatibility、CLI override matrix
  client.ts                      typed remote facade、cursor/dedupe
  router.ts                      bounded command/query/subscription routing
  resident-sessions.ts           sessionId -> controller/writer owner
  driver.ts                      claim/transfer/generation/revision fencing
  process-completion.ts          terminal -> durable Queue follow-up/reconcile
  lifecycle.ts                   connect-or-spawn、drain、recovery
src/runtime/process/
  types.ts                       neutral public DTO
  schemas.ts                     exact current-format schema
  state-machine.ts               pure transitions/terminal mapping
  events.ts                      process event payload/catalog
  projector.ts                   rebuildable projection
  manager.ts                     create/query/mutate/reconcile
  execution-decision.ts          constraint snapshot、builtin-none provider、receipt barrier
  completion-delivery.ts         delivery key/outcome pure state
  output.ts                      bounded ring/cursor/checkpoint contracts
  ports.ts                       decision/backend/output/artifact ports
src/storage/host/
  endpoint-store.ts              safe endpoint metadata
  startup-election.ts            startup lock/stale decision
src/storage/process/
  output-store.ts                private bounded durable output
  process-backend.ts             pipe process adapter
  pty-backend.ts                 platform capability adapter
  recovery-store.ts              attempt/constraint/spawn/containment receipts
src/cli/
  runtime-host-composition.ts     production-only Host client composition
  runtime-host-entry.ts           detached Host executable entry
src/runtime/tools/
  bash.ts                         foreground/background manager client
  process-output.ts               bounded read-only query
  process-wait.ts                 bounded terminal wait
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

当前状态边界：

| 阶段 | 当前状态 | 已有证据与未闭合边界 |
|---|---|---|
| R0–R2 | committed at `26d3c07` | raw detached background 已关闭；exact contract、pure state、bounded router 与 observer/driver 基线已建立 |
| R3 | implemented in current lineage | endpoint/election、Unix listener、Linux channel attestation、pre-attestation byte bound、durable event replay、cursor ACK/ack-window resync 已接入；新增 endpoint process/build identity 与 durable generation |
| R4 | implemented in current lineage | 标准 CLI 使用 authenticated connect-or-spawn；remote cursor/fence tracker、稳定重连桥与所有 mutation 显式 fence 已接入；真实 PATH 双终端仍待人工验收 |
| R5 | implemented in current lineage | process journal/manager、Host command durable intent-before-execute、receipt replay、conflict 与 `uncertain_outcome` 已接入 |
| R6 | implemented in current lineage | governed pipe/PTY、五维 barrier、独立 decision context、request/handle leaf binding、managed-process SIGTERM→SIGKILL 与 split-byte UTF-8 已接入；Host `--force` 仍严格只有一次 SIGTERM |
| R7 | implemented in current lineage | durable output/retention/Artifact/recovery 与跨重启 bounded Host subscription replay 已接入 |
| R8 | committed at `26d3c07` | process tools、Host Control Plane、terminal watcher 与 durable completion Queue 已接线；真实模型 completion follow-up 仍待 human evidence |
| R9 | committed at `26d3c07` | `/processes`/`/terminal` safe overlay、observer read-only、lazy output 与 focus restore 已有自动化证据；真实双终端交互仍待人工验收 |
| R10 | implemented, external verification open | recovery marker、global shutdown deadline、managed-process TERM→KILL drain、driver-only shutdown、Host lifecycle command、build replacement 与 reconnect runner 已接入；独立审计/human acceptance 未闭合 |

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
- 冻结所有 frame/queue/replay/pending/output/page/input/process-count/retention/wait/completion-batch bounds，并把 public DTO 与 backend/recovery DTO 分包。

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

依赖 R2，可与 R3/R4 的 production transport 工作并行，但不得接入真实 spawn。这里仅实现 pure delivery projector；Queue writer/scheduler 接线归 R8。

- RED：缺少 intent-before-spawn、idempotent create、terminal immutability、capacity、completion delivery key；
- 实现 process event writer/projector、manager、resource budget、attempt journal；
- create 相同 command ID/body 返回同 execution/attempt，不同 body conflict；
- foreground yield 与 explicit background 返回同一种 `ExecutionHandleRef`；
- 实现 wait register/terminal race 的 pure coordinator，以及 pending/explicit-delivery-committed/follow-up-enqueued/claimed/consumed/suppressed/uncertain delivery projector；
- terminal/lost/uncertain 后 mutation 拒绝；
- 进程内 registry 只缓存 projection；清空 registry 后从 journal 重建必须得到相同 revision/status/capability。

验收：fake backend `spawnCount=1`；在 intent、claim、spawn、started response-loss 四个 crash gap 重试均不重复 spawn；terminal-before-wait-register 与 terminal-after-register 结果一致；active work 阻止 session unload；process-local running-ID/in-memory delivered set 去重不能通过该阶段验收。

### R6：Runtime-owned audited backend 与 optional process-tree containment

硬依赖是完整的 execution constraint snapshot/receipt、durable intent、spawn claim、output sink 与 backend receipt；不硬依赖限制性 Permission/Approval/Sandbox/Gateway 或强 process-tree containment。五个维度均可由 production builtin provider 明确返回 `none`。

- RED：五个维度全部显式 `none` 时仍被拒绝 spawn；adapter/字段缺失或 receipt 不完整时却能 spawn；explicit deny、required approval 未完成、所选 sandbox/gateway/containment unavailable 时仍能 spawn；`containment=none` 却产生 `zero_members` 声明；
- 实现 Permission/Approval/Sandbox/Gateway/containment constraint snapshot、builtin-none provider 与 budget/output provision/intent/spawn 固定 barrier；
- 实现真实 pipe backend 与平台 PTY capability；POSIX process group/supervisor、Linux PTY 是可选择的增强能力，不是 `none` profile 的启动前提；
- `containment=process_group|supervisor` 时，timeout/abort/stop 必须处理完整 descendant tree，并取得真实 `zero_members|unknown` receipt；`containment=none` 时只记录根进程 stop/exit 事实，tree settlement 固定为 `not_requested`，不得声称后代已回收；
- Host SIGKILL 后只有 supervisor mode 可以声明 containment 延续；`none` mode 恢复时根据 intent/spawn/root/output receipt 投影为 terminal、lost 或 uncertain；
- Windows pipe backend 可在显式 `none` profile 下独立标记 supported；PTY 只有 ConPTY adapter 后标记 supported，supervisor containment 只有 Job Object 等价 adapter 后标记 supported，不能把单项缺失扩张成整个平台不可执行；
- Bash、CLI shell、pipe、PTY、foreground/background 和 recovery mutation 全部通过同一 Runtime-owned audited facade，backend package 不导出给 tool/TUI/CLI；
- 最终 spawn/mutation leaf 重新校验 execution/attempt-bound snapshot；`none`、allow/deny、not_required、off/direct_local 与实际 containment outcome 全部进入 canonical receipt。

验收：五维 builtin-none production composition 的真实 spawn `spawnCount=1`；缺 decision provider、字段或 receipt、explicit deny，以及所选强约束 unavailable 的每一种入口均为 `spawnCount=0`；`containment=none` 的 child 可运行且 receipt 不含 `zero_members`，启用 process-group/supervisor 的 child/grandchild 回收测试才要求真实 `zero_members`；不存在直接 PTY create 绕过 audit barrier 的 HTTP/CLI/TUI seam。

### R7：Durable output、Artifact 与恢复

- RED：output flood、ENOSPC/EIO、append/seal response loss、Host crash、digest tamper；
- 实现 bounded live ring、private output store、seq/checkpoint/seal；
- hard limit 触发 policy-defined stop 并记录实际 settlement；`containment=none` 时不能把根进程 stop 伪装成 descendant tree 已清空；
- terminal 后仅在 `recording.mode=events_and_artifacts` 时按授权 materialize 到现有 Artifact CAS；`off`/`events` 路径不得调用 Artifact Store；
- Trace tool node 始终只引用 execution/attempt；仅在 `events_and_artifacts` materialization 成功后追加 ArtifactRef，不复制 process truth/private output；
- 实现 retention plan/commit、pin 与 recovery marker；
- 分离 bounded preview、private durable output 与 immutable Artifact CAS；任何面向模型/TUI 的 marker 只含 safe ref/digest，不含绝对路径；
- replay cursor 定义覆盖 UTF-8 边界、earliest retained cursor、checkpoint head 与 seal digest。

验收：disconnect/reconnect 从 cursor 继续；旧 cursor 被 retention 截断时 typed resync 而不是空输出；ENOSPC/EIO 不伪造 terminal/Artifact；`off`/`events` 的 Artifact Store 调用次数为 0，`events_and_artifacts` 才产生可验证 digest/metadata/ArtifactRef；三种模式的 process projection/recovery 结果完全一致。

### R8：Bash、process tools 与 Control Plane

硬依赖 R4 的 Host-owned Agent/Queue composition 与 R7 的 durable terminal/output；在此之前只能以 test composition 验证 adapter 和 reconciler。

- RED：background Bash 仍不经过 manager，observer 能 write/resize/stop，Agent 只能 busy-poll，terminal 同时触发 wait result 与重复 follow-up；
- `bash` foreground/background 全部使用 Host process facade；
- 实现 non-blocking `process_output`、positive-timeout `process_wait`、`write_stdin`、`process_stop`；
- 实现 terminal -> completion delivery reconciler -> durable Queue follow-up；禁止 watcher 直接调用 `Agent.prompt/followUp`；
- explicit wait/stop terminal delivery 与 auto follow-up 使用同一 delivery key；response-loss 从 durable tool result、Agent input range、process event 与 Queue head/revision reconcile，TUI event 或 RPC success 不作为交付证据；
- completion 在 active turn 后排队、idle 时触发正常单飞；用户 pending input 优先，多 completion 有界 batch；
- command/query/subscription 接入 driver fence、idempotency 与 bounded output page；
- client disconnect 仅 detach attachment，process 继续；
- PTY attachment 使用 R2 同一 inactive-register/replay/cursor/activate 协议；pre-activation pending 和 wire outbox overflow 返回 typed resync；
- foreground timeout/abort 与 explicit stop 都走 manager，禁止保留 ExecutionEnv/raw spawn/独立 PTY fallback。

验收：工具返回 safe handle/summary，不含 PID/path/raw command/env；旧 raw spawn、logPath、独立 PTY create 和 process-local background 文案彻底消失；observer 的 write/resize/stop 在 backend 前拒绝；wait terminal、wait timeout/cancel、idle completion、active-turn completion、user-queued-before-completion、multi-completion batch 均最多生成一个模型可见 delivery。

### R9：OpenTUI process/terminal 阅读与控制

依赖 OpenTUI 计划 P3 主 screen 与 P5 overlay/focus owner。

- RED：overlay input 穿透 editor、关闭后 draft/focus 丢失、resize frame 越界；
- 实现 `/processes` list/detail、`/terminal <id>` output/PTY overlay；
- observer 显示只读状态，driver 才显示 input/resize/stop action；
- output lazy page，不把完整日志常驻 view model；
- detach 只关闭 attachment，不发送 stop；
- 40x12、60x16、80x24、143x40 frame/input/focus 测试；
- UI 只消费 Host facade 的 safe DTO/page/event，不因 backend 有 HTTP/WebSocket PTY API 就直接连接 raw PTY endpoint。

验收：真实 OpenTUI mockInput/frame、UTF-8、resize、driver transfer、关闭恢复 editor 全部通过；observer/driver action 可见性正确；关闭 overlay 和退出 client 后 process 仍可由第二客户端从 cursor 继续查看。

### R10：Recovery、shutdown 与完整验收

- Host graceful shutdown：close admission -> drain turn/process -> checkpoint/seal private output -> terminal/settle -> conditional `events_and_artifacts` materialize -> flush writer -> release；
- 所有 shutdown phase 共享一个 global deadline；process drain 必须 wait -> SIGTERM -> wait -> SIGKILL -> final wait，deadline 后返回 `shutdown_incomplete`，endpoint/lease 外层清理仍继续；
- Host command 必须 durable intent-before-execute；同 principal/command/body 跨重启 replay receipt，异体 conflict，只有 intent 无 receipt 时返回 `uncertain_outcome` 且绝不重执行；
- subscription event/cursor 跨 Host 重启 durable replay；client ACK 不占 request waiter，非法 ACK 或超过 ack window 返回 `resync_required`；
- Host crash、endpoint stale、driver disconnect、ack loss、slow subscriber、output failure、process tree uncertain fault matrix；
- 标准 PATH 双 client、same-session driver、Host restart、real PTY/tmux；
- 在 replay snapshot、cursor emit、live activate、spawn receipt、output checkpoint、seal response、terminal-before-follow-up、follow-up-before-consume 八个边界注入 crash/response loss；
- 验证最后一个 client 退出不等于 Host shutdown，Host shutdown 不等于无 receipt 的 process kill；两条 lifecycle 分别验收；
- Linux 自动矩阵通过后做独立只读审计；
- macOS/Windows 只按真实 capability 结论，不沿用 Linux 声明；
- 用户真实终端明确验收后才能标记 human-verified。

## 9. 阶段依赖

```text
R0 -> R1 -> R2 -> R3 -> R4
             \-> R5 -> R6 -> R7
                         R4 + R7 -> R8
                         R8 + OpenTUI P3/P5 -> R9
                         R3 + R4 + R6 + R7 + R8 + R9 -> R10
```

允许并行：R5 pure domain 可在 R3/R4 期间推进。禁止并行：

- R4 不得绕过 R3 peer attestation；
- R6 不得在五维 execution constraint snapshot、production builtin-none provider 与 canonical receipt barrier 前解冻；限制性 Permission/Approval/Sandbox/Gateway/containment adapter 可在对应 profile 启用前独立完成；
- R8 不得保留 raw detached fallback；
- R8 completion bridge 不得绕过 `04` 的 Queue contract，也不得在 R4 Host-owned Agent/Queue composition、R5 delivery projector、R7 durable terminal-output 前接 watcher；
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

最终自动化命令：

```bash
npx vitest run tests/runtime/host tests/storage/host tests/cli/multi-client tests/runtime/process tests/storage/process
bun test tests/tui/process-overlay.bun.test.ts tests/tui/process/process-overlay.bun.test.ts
npm run verify:multi-client-host
npm run verify:managed-process-pty
npm run verify:host-build-replacement
mkdir -p /tmp/runledger-runtime-host-audit-evidence
npm run verify:runtime-host-audit -- --output /tmp/runledger-runtime-host-audit-evidence
```

`verify:runtime-host-audit` 固定顺序执行 focused Host/process、focused TUI、`check`、`test`、`build`、两套 production runner 与 `git diff --check`。它不替代独立审计或人工验收。

最终 fault matrix 至少覆盖：

- 并发 startup、stale endpoint、active writer unreachable、peer forgery；
- same-session observer/driver、driver transfer、ack loss、cursor replay、slow subscriber；
- replay snapshot/cursor emit/live activate 三边界并发、pre-activation pending overflow、outbox overflow、old cursor resync；
- ticket theft/replay/cross-scope、Basic-Auth-only、payload principal forgery、attestor preflight failure；
- quick foreground、foreground yield、explicit background；
- process_output non-blocking、process_wait positive-timeout/timeout/cancel，以及 terminal-before/after-wait-register；
- explicit-delivery-committed/auto-follow-up 同 key 竞争，TUI stop 不误抑制、terminal-before-follow-up 与 follow-up-before-consume crash/response-loss；
- multi-completion batch member key/digest/revision，claim 后 interrupt、cancel 与重复 batch reconcile；
- active-turn completion 不 interrupt、idle completion 自动单飞、pending user input 优先、multi-completion bounded batch、synthetic turn cancel 后 Queue 可恢复；
- Bash/CLI/direct PTY/recovery mutation 的 explicit deny 与缺失 receipt，五维 builtin-none 真实 spawn，stdin/EOF、PTY UTF-8/resize/detach，以及 `containment=none`/process-group/supervisor 分级 settlement；
- output bounds/ENOSPC/EIO，以及仅在 `events_and_artifacts` 启用的 Artifact tamper/materialization failure；
- intent/claim/spawn/started response loss、Host SIGKILL、connection generation、同 frame/command 重放、session cursor resume、reconnect recovery、graceful shutdown deadline；
- 同 semver 不同 content digest、`host_build_mismatch`、maintenance target fence、generation 单调前进、manual stop 不重连；
- no raw path/PID/credential/private reasoning leakage；
- recording off/events/events_and_artifacts 三种 Trace 模式下 process truth/private output 一致，且 Artifact Store 调用次数分别为 0/0/启用。

### 10.1 自动化证据 manifest

审计命令只接受既有、绝对且位于仓库外的 `--output` 目录；Linux 通过退出 `0`，验证失败退出 `1`，非 Linux 明确 `unsupported` 并退出 `2`。`runtime-host-audit-manifest.json` 使用严格 current format `runtime-host-audit`，包含：

- `HEAD`、branch、tracked binary diff SHA-256、按 repo-relative path 排序的 untracked content SHA-256，以及它们组合出的 `candidateDigest`；
- 平台、架构、Node/npm/Bun 版本；
- 每个 gate 的静态 command、exit code、duration、stdout/stderr SHA-256，以及两套 runner 的 `outcome`/scenario IDs；
- gate 前后重新计算的 candidate digest；不一致时固定返回 `candidate_changed`，不得生成 PASS。

manifest 不保存 raw stdout/stderr、PID、绝对 repository/cwd、output path、credential/auth、raw command content 或 transcript。可执行文件只保留 basename；内联脚本、绝对路径、换行和 credential-like 参数固定写为 `<redacted-argument>`。runner 的 `outcome=unsupported` 不能被聚合为 PASS。

### 10.2 Linux 独立只读审计

独立审计必须由非实现者针对同一 `candidateDigest` 执行，不修改实现、测试或证据。审计者至少检查：

1. Host 是唯一 session writer、Agent/process owner，client/TUI 没有 raw backend 绕行；
2. durable intent、command receipt、event replay/ACK 与 terminal truth 可重放且不可静默改写；
3. Host/session/driver fence 覆盖所有 mutation、driver transfer 与 shutdown；
4. 五维 execution decision 完整绑定，显式 `none` 可审计，缺失/tampered receipt fail closed；
5. public DTO/TUI 无 PID、raw command/cwd/env、absolute path、credential 或 private reasoning；
6. detach、最后一个 client 退出、Host shutdown、SIGKILL recovery 与 process settlement 生命周期互不混淆；
7. `RUNTIME_HOST_BOUNDS` 在 transport/store/backend 边界真实执行，Linux capability 与 macOS/Windows `unsupported` 声明一致。

报告固定记录 `PASS|FAIL`、candidate digest、auditor、date UTC，以及每个 finding 的 ID、severity、source line、违反的不变量和证据引用。任何未解决的功能或审计性 finding 都阻止 PASS；自动化作者不得自行填写独立审计通过。

### 10.3 Human-verified 操作与签字

`human-verified` 只能由真实操作者在真实终端完成；自动化 agent、CI 或本文件作者不得代填 PASS。当前状态固定为 **PENDING HUMAN VERIFICATION**。

前置条件：Linux、仓库当前工作树、可用的真实模型凭据、两个独立终端或 tmux、PATH 上解析到本仓库的 `runledger`。使用一次性绝对 `RUNLEDGER_DIR`，不得复用真实用户 home：

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
export RL_HUMAN_ROOT="$(mktemp -d /tmp/runledger-human-XXXXXX)"
mkdir -p "$RL_HUMAN_ROOT/home" "$RL_HUMAN_ROOT/workspace" "$RL_HUMAN_ROOT/evidence"
export RUNLEDGER_DIR="$RL_HUMAN_ROOT/home"
npm run verify:runtime-host-audit -- --output "$RL_HUMAN_ROOT/evidence"
npm link
command -v runledger | tee "$RL_HUMAN_ROOT/evidence/runledger-path.txt"
readlink -f "$(command -v runledger)" | tee -a "$RL_HUMAN_ROOT/evidence/runledger-path.txt"
```

按以下顺序执行并保存每个真实终端的 transcript：

1. 终端 A 在 `"$RL_HUMAN_ROOT/workspace"` 执行 `runledger`；终端 B 在同一目录执行 `runledger -c`。读取 `"$RUNLEDGER_DIR"/ipc/hosts/*/endpoint.json`，确认两端显示同一 session，endpoint 只有一个 `hostRuntimeId`；用 `lsof -t -- "$RUNLEDGER_DIR"/ipc/hosts/*/host.sock` 确认只有一个 Host PID。两个 client 同时输入时只能 driver 成功 mutation，observer prompt 与 terminal write/resize/stop 必须显示 `observer_mutation_forbidden` 或 read-only，ledger 不出现 observer mutation。
2. 由 driver 要求 Agent 使用 `bash(run_in_background=true)` 启动一个持续至少 10 秒、每秒输出一行的命令；在终端 A detach/退出。终端 B 必须仍能通过 `/processes` 与 `/terminal <executionId>` 观察该进程。随后启动终端 C：`runledger -c`；C 必须以当前 generation/revision 显式 claim 成为新 driver，B 保持 observer。
3. 执行 `npm run verify:managed-process-pty | tee "$RL_HUMAN_ROOT/evidence/pty-runner.txt"`。JSON 必须 `passed=true`，且包含 `pty_utf8`、`pty_resize`、`pty_stdin`、`client_detach`、`client_reconnect_output_cursor` 与 `terminal_wait_idempotency`。这一步使用真实 node-pty，不以 pipe 或 source-level fake 代替。
4. 在 C detach 后等待后台命令继续完成，确认 client disconnect 没有使 Host 或 process 退出；重新运行 `runledger -c`，从先前 cursor 继续读取，无重复 output page 或重复 mutation。
5. Host crash 场景：让 background command 仅在启动时向 workspace 的 `spawn-count.txt` 追加一行，然后保持运行；保持 TUI 打开，用 endpoint socket 的 `lsof -t` 精确取得 Host PID 并执行 `kill -KILL <host-pid>`。确认现有 TUI 进入 `reconnecting`，由 connect-or-spawn 拉起更高 generation 后恢复同一 session；`spawn-count.txt` 仍只有一行、原 running projection 变为 `lost` 或 `uncertain`、可恢复的 output cursor 仍可读取。禁止按 PID reattach 或再次 spawn。
6. 人工见证 backpressure/ACK fault：运行 `npx vitest run tests/runtime/host/router.test.ts tests/cli/multi-client/runtime-host-transport.test.ts tests/cli/multi-client/runtime-host-service.test.ts tests/runtime/host/remote-session.test.ts | tee "$RL_HUMAN_ROOT/evidence/subscription-faults.txt"`。确认 slow subscriber 隔离、ACK notify、ack-window overflow/invalid cursor `resync_required` 与 fast client 继续工作均 PASS。
7. 真实模型 completion：启动 `sleep 2` 后输出唯一 marker 的 background command，不调用 `process_wait`，不继续输入；确认 terminal durable 后最多触发一次 completion follow-up/模型 turn。再分别用显式 wait 与 stop 重复，确认同一 delivery key 不会产生第二次 follow-up。保存脱敏 session transcript 与 ledger 中对应 delivery marker/digest。
8. 执行 `npm run verify:multi-client-host | tee "$RL_HUMAN_ROOT/evidence/multi-client-runner.txt"`。确认 `production_api_connect_or_spawn`、`two_clients_one_host`、`stale_fence_rejected`、`explicit_driver_transfer`、`command_idempotency`、`host_sigkill_no_duplicate_spawn`、`lost_or_uncertain_projection` 与 `driver_only_explicit_host_shutdown` 全部存在；runner 中 observer shutdown 必须先失败，只有 active driver 携完整 fence 的 shutdown 成功。

通过标准：上述 8 项全部 PASS；无第二 writer、重复 spawn、observer mutation、无界等待、乱码、cursor 静默丢失或重复 completion。保存 command transcript、两个 runner JSON、脱敏 endpoint/recovery marker、ledger/event/output seal digest；不得保存 token、auth 文件、raw secret、private cwd 或未脱敏绝对用户路径。建议把证据目录压缩后记录 SHA-256，而不是把原始私有内容提交到仓库。

签字格式：

```text
human-verified: PASS|FAIL
date_utc: <YYYY-MM-DDTHH:mm:ssZ>
operator: <name-or-team>
platform: <distro/kernel/arch>
commit: <manifest candidate.head>
candidate_digest: <manifest candidate.candidateDigest>
scenarios: 1=PASS 2=PASS 3=PASS 4=PASS 5=PASS 6=PASS 7=PASS 8=PASS
evidence_archive_sha256: <sha256>
notes: <redacted observations or failure references>
```

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
- 自动下载/发布二进制 updater；`auto_update` 在 updater 专项完成前固定 unsupported；
- session actor idle eviction；当前只保证 client detach 后工作继续与 session 可恢复，不宣称空闲内存卸载；
- 未有实际 backend/capability evidence 的 Windows/macOS pipe、PTY 或强 containment 能力声明；builtin-none constraint provider 的存在不能替代平台执行证据。

## 12. 完成定义

- [x] 当前 raw detached `spawnBackground()` 和 cwd log 写入已删除；
- [x] 标准 CLI 只有 authenticated connect-or-spawn Host 路径；
- [x] Host 是唯一 session writer/Agent/process owner；
- [x] 多 client replay/live、cursor/dedupe/resync 有 bounded tests；
- [x] replay、pre-activation pending、wire outbox、reverse waiter、ACK window、output ring/page/input 与 process capacity 均有固定上限和 overflow 语义；
- [x] observer/driver 与 generation/revision fencing 覆盖所有 interactive mutation 和 Host shutdown；
- [x] production peer attestation 来自具体 channel；
- [x] production 不以 ticket 建立身份；未来若签发 ticket，只能位于 attested channel 并绑定 principal/generation/purpose；
- [x] process/Host command intent-before-execute、idempotency、terminal immutability、receipt replay 与 uncertain recovery 完整；
- [x] `process_output` immediate、`process_wait` bounded，timeout/cancel 不改变 process truth；
- [x] terminal -> durable Queue follow-up 有 stable delivery key，explicit wait/stop/auto follow-up 最多一个模型可见 delivery；
- [x] completion 不打断 active turn，用户输入优先，多 completion 有界 batch，Host crash/response-loss 后可幂等 reconcile；
- [x] Permission/Approval/Sandbox/Gateway/containment 五维均有明确 decision/receipt；显式 `none` 可以 production spawn，接口/字段/receipt 缺失或所选强约束不可用时 fail closed；
- [x] containment mode 与 settlement truth 分离：`none` 不阻止 spawn 且不伪造 `zero_members`，强 containment 只按实际平台证据声明；
- [x] Bash、CLI shell、pipe、PTY 与 recovery mutation 均经过同一 Runtime-owned audited leaf barrier，并由独立 Host decision context 再绑定 request/handle；
- [x] foreground/background/pipe/PTY 统一由 manager 与 Host Control Plane 管理；
- [x] output/cursor/quota/checkpoint/seal/Artifact/retention 全部有界且可恢复；
- [x] preview/private output/Artifact 三层分离，public schema/model/TUI 无 PID/raw command/cwd/env/absolute path；
- [x] `off`/`events` 不经过 Artifact Store，只有 `events_and_artifacts` 产生 ArtifactRef；
- [x] recording mode 不影响 canonical process truth、private durable output 或 recovery；
- [x] TUI 不访问 Event/Artifact/spool/backend 文件，不暴露 PID/path/secret；
- [x] production/test composition 完全分离，无 feature flag/fallback/legacy authority；
- [x] focused、`npm run check`、`npm test`、`npm run build` 与三套真实 runner 全绿；
- [x] build manifest 绑定真实发布内容，同版本不同内容可区分且 tamper fail closed；
- [x] `host list|status|stop|restart` 使用 management protocol，busy confirmation、maintenance target fence 与 validated SIGTERM force 路径有测试；
- [x] durable Host generation/shutdown intent、build mismatch 与 restart replacement 已通过真实双构建 runner；
- [x] TUI/headless 重连具备 connection generation、幂等 command replay、cursor resume/resync、shutdown reason 分流与失败连接释放；
- [x] `verify:runtime-host-audit` 绑定 tracked/untracked candidate、脱敏 gate digest、机器可读 runner outcome，并在 candidate drift 时 fail closed；
- [ ] Linux 独立只读审计通过；
- [ ] 用户真实多终端与 PTY 验收后才标记 `human-verified`。
