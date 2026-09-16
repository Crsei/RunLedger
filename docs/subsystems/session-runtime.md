# Session Runtime

Session Runtime 子系统拥有单个 Session 的 owner election、generation fence、authenticated localhost transport、connection-scoped driver、command/query routing、recovery barrier 和关闭顺序。它是标准 CLI 的 Session authority facade，不拥有跨 Session scheduler。

源码入口：[`src/runtime/session-owner/`](../../src/runtime/session-owner)、[`src/runtime/session-server/`](../../src/runtime/session-server)、[`src/runtime/session-runtime/`](../../src/runtime/session-runtime)、[`src/cli/embedded-session-runtime.ts`](../../src/cli/embedded-session-runtime.ts)、[`src/cli/session-client.ts`](../../src/cli/session-client.ts)。

## 运行对象与 ownership

| 对象 | 职责 |
|---|---|
| `SessionOwner` | bind-before-publish、claim/attach/takeover、heartbeat 与 release |
| `OwnerStore` | owner row、generation CAS、认证 secret 与 owner audit event 的事务写入 |
| `SessionRuntimeServer` | 单 Session TCP listener、握手、driver/attachment、command/query/subscription/reverse request |
| `SessionRuntime` | lifecycle、recovery barrier、domain router、event persistence、attempt 与 checkpoint facade |
| `SessionDomainPort` | Agent/model/tool/process/resource 的 Session 私有实现 |
| `SessionClient` | 发现 owner、认证连接并暴露 transport handle；不持有 controller |

一个 owned Runtime 只绑定一个 `sessionId` 和一个 owner generation。本地 TUI 与其他本机 attachment 使用相同 loopback transport；claimed 分支也必须把本地 view 接回 TCP facade，不存在 direct-controller fast path。

## Open、attach 与 takeover

`SessionOwner.open()` 读取 owner row。`unowned` 进入 fresh claim；heartbeat 未 stale 的 row 立即返回 attach candidate，并由后续客户端握手验证 endpoint、identity 与 token。stale row 有 endpoint 时先做连续 authenticated probe，全部失败后才以 exact row 为条件执行 takeover CAS；缺少 endpoint 时跳过 probe，直接尝试 exact-row CAS。

claim 前先绑定 `127.0.0.1` 的候选 listener，claim 失败则关闭候选。takeover 成功递增 generation，并把 fencing/takeover 事实与 owner row 变更置于同一事务语义。endpoint 可连接但认证不匹配不能被当作可 attach owner。

## Restore 与启动

claimed 分支按以下顺序启动：

```text
claim owner fence
  -> restore Session events/checkpoint
  -> revalidate workspace or worktree
  -> create approval/attempt late-bound ports
  -> assemble Session domain
  -> construct SessionRuntime and bind late ports
  -> start domain-owned resources
  -> publish running | recovery_required
  -> activate server
  -> attach local client through server
```

domain 在 `SessionRuntime` 构造前装配，因此 attempt、human-wait 与 run-timing 使用 late-bound port 解除循环依赖；任何真实工具执行发生在绑定之后。启动所需的 toolchain、Security、required MCP 或 workspace 复验失败时，Runtime 不发布为可用。

## Protocol manifest

握手只针对当前 Session、runtime id 和 generation，首帧之外的未认证输入被拒绝。服务端返回冻结的 capability 与 operation manifest，客户端只能按 manifest 构造对应端口。

Core operations 包括 snapshot/timeline/receipts、event subscription、driver claim/release、provider/model/thinking、auth、prompt/steer/follow-up/interrupt、queue clear 和 recovery。Process、extensions、security settings、plan、goal、loop 与 multi-agent 由 domain 在真实组合存在时追加 operation descriptors；类型声明中存在 capability 名称不等于当前握手已提供该 operation。

## Goal mode 与 loop

`goal` 是会话级 canonical 状态（`SessionGoalDomain`，事件 schema `runledger.session-goal.current`），只在 `standard` 组合出现：`minimal`/`plan` 是冻结 allowlist，既没有 `goal` 工具也没有 `session.goal` capability。状态转移经 reducer（`src/runtime/modes/goal/reducer.ts`）执行，模型只能 `request_complete`（登记请求），结算由用户 `settle_complete` 完成；预算耗尽只在用量完整度为 `complete` 时成立，`partial` 下 `tokensUsed` 是已观测下界，不得据此停止。

`SessionGoalContinuationController` 在 `agent_end` 之后按 `goal.continuationDelaySeconds` 的 idle 窗口判定自动续跑：driver 在位、owner ready、编辑器为空、队列为空、上轮有工具调用、未超 `maxContinuations`、且 run budget 未终止。任一 run budget 终止即不再续跑。续跑消息以 `origin:"runtime"` 提交，进 history 但不作为用户输入（不触发自动标题，TUI 折叠为 `[runtime]` 行）。

loop 是 ephemeral 的 owner 侧迭代驱动（`SessionLoopController`）：不进 canonical reducer，重启后不自动继续；每次迭代写 durable 审计事件（`loop.started`/`iteration_submitted`/`iteration_settled`/`stopped`）。无显式 limit 时由 `loop.maxIterations` 兜底。`--while`/`--until` 条件走本 Session 的 governed `ExecutionEnv`；退出码权威（0/1 按极性映射，>1 判为条件损坏并停止），超时与用户取消分别判定。`reset` 动作 runtime 只回 `loop_reset_requires_client`，由 client 换新 session 执行。

## Driver、attachment 与 reverse request

多个认证客户端可以 attachment 到一个 Session；mutation 只接受当前 driver connection。driver claim/release 会推进 driver revision，旧 connection 不能继续写。takeover 事务本身当前不追加 `driver.reset_on_takeover`；新 server 从无 driver 状态启动，后续 connection claim/release 才推进 revision。

Approval 与 credential login 使用 server 发出的 `reverse_request`，并只交给当前 driver 的 handler。Runtime 对 waiter 数量、等待时长和 frame 大小设上限；断连或 fence 会终止等待。observer 可以读取 snapshot/subscription，但不能代替 driver 回答 mutation 所需交互。

Runtime lifetime 由 attachment count 决定。本地 renderer detach 后若还有其他本机 attachment，owned Runtime 继续运行。归零后依次停止 admission、中断并有界等待 Agent、flush/补 aborted event、关闭 domain/process、释放 workspace、写 `paused` checkpoint、释放 owner、关闭 server，再释放 listeners/controller。

## Recovery barrier 与 fencing

fresh claim 和 clean release 后的 resume 可以进入 `ready`；crash takeover 进入 `recovery_required`。未 settle 的 command attempt 是恢复不确定性的证据，Runtime 在 assess/verify/resume 决策完成前拒绝新的 mutation side effect。

heartbeat 更新返回 fenced 或连续存储失败达到 fail-closed 条件时，旧 Runtime 停止 heartbeat，关闭 listener，终止领域工作并断开连接。被 fence 的 generation 不再写 checkpoint、event 或 receipt。

## 查询与 projection

`SessionRuntime` 把同步 core command/query 与异步 domain resource operation 统一路由。mutation 先受 operation manifest 与当前 driver connection 限制；需要 optimistic concurrency 的领域 mutation再校验各自 expected revision，prompt/side-effect 路径还受 Runtime state 与 recovery barrier 限制。不存在一个对所有 mutation 无差别执行全部检查的全局步骤；query 也不获得隐式 mutation authority。

snapshot 是 Session domain 当前消息/选择/工具数与 provider 状态的投影；timeline 和 receipts 来自 durable store。subscription 使用 cursor/ACK 和有界 replay，outbox 溢出时要求 resync，而不是无限缓存事件。

## 稳定边界

- transport 当前是 IPv4 loopback TCP，不是 Unix socket、Named Pipe、HTTP、SSE 或 WebSocket。
- legacy resident Host 源码仍保留为兼容与迁移安全窗口，但标准 CLI 不 import/call 它，也没有 feature-flag fallback。
- SessionRuntime 不跨 Session 调度进程或 Agent；每个 Session 拥有自己的 process/resource domain。
