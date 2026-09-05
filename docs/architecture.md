# RunLedger 架构

在修改 `src/runtime/`、`src/security/`、`src/storage/session-store/` 或标准 CLI 组合入口前阅读本文。本文只描述当前生产组合、跨子系统运行流和扩展落点；类型、失败语义与稳定能力边界由[子系统索引](subsystems/README.md)下的页面维护，历史方案与验收状态仍留在 `development-doc/`。

## 运行时组合

RunLedger 的生产运行单元是一个 **Session-scoped Runtime**。每个被本进程拥有的 Session 都有独立的 `SessionOwner`、`SessionRuntimeServer`、`SessionRuntime`、Agent/模型/工具域、Security 组合、进程能力、扩展快照和工作区绑定；它们不组成 machine-wide Agent registry，也不允许 TUI 绕过 RuntimeServer 直接驱动领域 controller。

标准 CLI 在 [`src/cli/main.ts`](../src/cli/main.ts) 中只解析一次 canonical RunLedger home，打开 SQLite Session Store，装配模型目录与工作区依赖，再通过 [`createEmbeddedSessionRuntime()`](../src/cli/embedded-session-runtime.ts)统一执行 attach 或 claim。claim 分支恢复并装配本地 Runtime；non-stale owner row 的 attach 分支通过实际握手验证 endpoint、identity 与 token，本进程不创建第二份 Agent 状态。

## 入口与装配

| 入口 | 组合入口 | 拥有的运行对象 |
|---|---|---|
| `runledger` 与会话控制命令 | [`src/cli/main.ts`](../src/cli/main.ts) | canonical home、SQLite 连接、Session view 生命周期、TUI |
| owned Session | [`src/cli/embedded-session-runtime.ts`](../src/cli/embedded-session-runtime.ts) | owner、localhost TCP server、SessionRuntime、domain 与清理顺序 |
| Session domain | [`src/runtime/session-runtime/domain.ts`](../src/runtime/session-runtime/domain.ts) | Agent、模型路由、工具、Security、进程、扩展、子 Agent 与 trace 注入 |
| `runledger auth-gateway` | [`src/cli/auth-gateway-cli.ts`](../src/cli/auth-gateway-cli.ts) | 独立的 Models/AuthStorage 与本地 HTTP forward proxy；不创建 SessionRuntime |
| `examples/run.ts` 与测试工厂 | [`examples/run.ts`](../examples/run.ts) | mock/示例组合；不定义标准 CLI 的生产 authority |

发布后的 `runledger` 由 [`bin/runledger.js`](../bin/runledger.js)加载 `dist/cli/cli.js`。检查真实入口时，应同时确认 `command -v runledger`、链接目标和当前 checkout 的 `dist`，不能从 `src` 的状态推断全局命令正在运行同一构建。

## 核心子系统

| 子系统 | 唯一拥有的职责 | 详细说明 |
|---|---|---|
| Core Agent Runtime | Agent 状态、模型请求循环、消息队列、tool-call continuation 与 live Agent events | [core.md](subsystems/core.md) |
| Models | Provider/Model 注册、认证解析、模型路由与统一 streaming adapter | [models.md](subsystems/models.md) |
| Session Runtime | owner、generation fence、driver、localhost 协议、command/query 与生命周期 | [session-runtime.md](subsystems/session-runtime.md) |
| Persistence | SQLite 权威状态、hash-chain events、attempt receipts、checkpoint cache 与 replay | [persistence.md](subsystems/persistence.md) |
| Tools and Security | model-visible tools、ExecutionEnv、权限/批准、ExecutionGateway 与最终 I/O leaf | [tools.md](subsystems/tools.md) |
| Bounded Subagents | root-owned、受预算限制的只读 child execution 与可重放 graph/report | [subagent.md](subsystems/subagent.md) |
| Workspace | 平台路径 identity、containment、worktree locator/lease 与 cold-resume 复验 | [workspace.md](subsystems/workspace.md) |
| Extensions | Plugin/Skill/Hook/MCP/LSP 的发现、信任、Session 私有快照与资源操作 | [extensions.md](subsystems/extensions.md) |
| Runtime Trace | 本地 trace event、artifact CAS、tree projection 与 recording policy | [trace.md](subsystems/trace.md) |

## 持久事实与活态控制

- **Session authority 事实**写入 `<runledgerHome>/state.db`。Session catalog、owner generation、按 sequence 排序的 hash-chain events、driver revision、command intents、attempt receipts 和 checkpoint descriptor 都由 `SessionStore`/`OwnerStore` 管理；settings、credential、extension state、process output 与 Trace artifact 仍有各自受限存储，不能混称为 Session Event Store。
- **活态控制**通过绑定单一 Session 的 localhost TCP 连接传输。握手协商 capability 与 operation manifest；command、query、subscription、ACK 和 reverse request 都受 frame 上限、连接身份与 owner generation 约束。
- **领域事件**由 `InteractiveSessionController` 发出，经 `SessionEventPersistence` 转成 owner-fenced 持久事件并广播。TUI 消费 snapshot 与 subscription projection，不拥有 ledger 写 authority。
- **Runtime Trace**是可选的本地观测存储，不决定 Session owner、恢复或执行授权；它不能替代 SQLite Session Event Store 与 attempt receipt。

## Session ownership 与生命周期

```text
resolve Session + workspace identity
  -> read owner row
     non-stale owner row ------------------------> attach + authenticated handshake
     unowned row -------------------------------> bind candidate -> claim
     stale owner + endpoint -> authenticated probes fail --+
     stale owner without endpoint --------------------------+-> exact-row CAS takeover -> new generation
  -> restore durable state
  -> revalidate workspace/worktree
  -> assemble Session domain
  -> publish running | recovery_required
  -> every local view and other same-host client uses the TCP facade
  -> driver connection admits mutations; observers remain read-only
  -> last attachment leaves
  -> stop admission -> interrupt/wait -> flush aborted state
  -> domain/process shutdown -> workspace release
  -> paused checkpoint -> owner release -> server close
```

候选 owner 必须先绑定 listener，再发布 endpoint。takeover 要求 heartbeat stale 和 SQLite 中 exact owner row 的 CAS 成功；若 row 有 endpoint，还要求连续 authenticated probe 全部失败，无 endpoint 时直接进入 exact-row CAS。旧 generation 的 heartbeat 或写入被 fence 后，Runtime 关闭 server、终止领域工作并断开客户端，不能把旧内存状态写回权威流。

已完成认证握手的 owner 允许多个 attachment，但同一时刻只有一个 connection-scoped driver 可以提交 mutation。最后一个 attachment 离开才触发 pause/checkpoint/release；仍有其他本机 attachment 时，本地 TUI 的退出不能销毁 owned Runtime。transport 只监听 loopback，不表示可以从远端主机直接连接。

## 模型 turn 与工具 attempt 流

在 Core Agent Runtime 中，一个 `run` 从一次 prompt 开始；一次循环 `turn` 对应一个模型请求以及该响应引出的工具处理。响应包含 tool calls 时，工具结果追加进 Agent 消息后进入下一次模型 turn，直到无待执行工具、达到预算、被中断或 provider 结束。

```text
driver command: session.prompt | steer | follow_up
  -> SessionRuntime command admission + recovery barrier
  -> extension turn admission / UserPromptSubmit hook
  -> Agent queue
  -> convert messages + assemble model context
  -> model router -> Models.streamSimple() -> provider stream
  -> assistant events + durable ledger projection
  -> zero or more tool calls
     -> PreToolUse hook
     -> ToolAuthorizationPolicy
     -> governed tool implementation
        -> capability-specific Security / ExecutionGateway / attempt protocol
        -> filesystem | network | process final leaf
        -> settle required receipt
     -> PostToolUse hook
     -> tool result + durable ledger projection
  -> next model turn or agent_end
```

`steer` 与 `follow_up` 只进入 Agent 自己的有界队列，并在下一次模型请求前成为消息；它们不改写已经在流式执行的请求。`interrupt` 通过 `AbortSignal` 终止当前 run。副作用开始后若进程崩溃而没有 settled receipt，takeover 进入 recovery barrier，必须显式 assess/verify/resume 才能重新放行 mutation。

## Session 状态、replay 与 projection

Session Event Store 是会话状态恢复的权威顺序。每次 append 在同一 SQLite 事务里校验 owner fence、expected previous hash 和下一 sequence；Session status 与 driver revision也在该事务语义下推进。

Checkpoint 是可删除的重放加速层。cache 校验只证明 descriptor/snapshot 自身的 digest、schema、boundary 与 source sequence 一致；当前只有 orderly pause 写出的 `replayReady=true` checkpoint 可以作为领域 replay seed，其他 boundary checkpoint 不可直接作为 seed。候选不可用时从 genesis events 重放；cache 不反向授权 mutation。`SqliteLedgerSink` 把 Agent ledger entries 放入同一 Session 事件流，`restoreSession()` 与领域 replay 再恢复消息、选择与审计视图。

TUI timeline、Session snapshot、catalog、process overlay 与子 Agent inspection 都是只读 projection。改变 projection 不等于改变持久事实；新增影响恢复的领域状态必须先定义其 owner-fenced event/receipt 与 replay 规则。

## Security 与执行路径

[`createSessionSecurity()`](../src/security/composition/session-security.ts)为每个 owned Session 冻结一次有效 Security snapshot，并装配 governed filesystem、network、shell、managed process、permission requester 与 `ExecutionGateway`。CLI override、managed constraints、workspace 和 user sources 按组合层解析；workspace 层不得扩大上层限制。

模型看到工具并不代表工具拥有 authority。工具调用先经过 hook 和 `ToolAuthorizationPolicy`，实际 filesystem/network/process 副作用还必须通过 `ExecutionGateway`、批准协调、约束 provider、sandbox backend 与 final-leaf adapter。标准 Session 组合始终注入 approval ports，并由当前 driver 的 reverse request 承担交互；没有 driver/handler 时请求被拒绝。拒绝型 headless prompter 是低层未注入 ports 的 fail-closed 构造，不是标准生产替代路径。

`ExecutionEnv` 是工具与 I/O 的注入边界。生产 domain 只接受 `requireExecutionEnv: true` 的 stdlib 工具组合；raw Node filesystem、直接 shell spawn 或绕过 gateway 的 network client 不是标准 Session 工具的替代路径。

## Provider 与能力适配器

`Models` 隔离 Agent 与具体 provider。Agent 只持有 `Model` 值和 `StreamFn`；Session model router 解析每次请求的 provider/model/credential 组合，再由 `Models.streamSimple()` 进入 `src/api/` 的 wire adapter。凭据通过 `CredentialStore`/`AuthStorage` 解析，OAuth refresh 保持在 provider/auth 层。

Workspace、filesystem、network、process、sandbox、trace 与 child runtime 也通过窄接口注入组合入口。替换实现时必须保留调用方依赖的不变量，例如 containment、owner generation、attempt settlement、取消传播和有界输出；测试 adapter 的存在不使它成为生产 authority。

## 新行为应放在哪里

| 目标 | 所属机制 |
|---|---|
| 新增模型 provider 或 wire adapter | `src/providers/`、`src/api/`、`src/auth/` 与模型生成链；不要修改 Agent loop |
| 改变模型选择或请求路由 | `src/runtime/model-routing/` 与 Session model router |
| 新增 model-facing tool | `src/runtime/tools/`，并在 production Session tools 中显式组合；副作用能力必须走 Security/ExecutionGateway |
| 新增可恢复的 Session 状态 | `src/runtime/protocol/` + `src/storage/session-store/` event/receipt + replay/projector |
| 新增 model context 来源 | `src/runtime/context/` 或 Extension context source，并记录足够的 assembly receipt 以便审计 |
| 新增批准或凭据交互 | Session reverse-request 协议与 TUI adapter；不得让领域对象直接读取终端 |
| 新增 filesystem/network/process/sandbox 行为 | `src/security/` 的 broker、policy、gateway 或 final leaf，并保持 attempt barrier |
| 新增 workspace/platform 行为 | `src/workspace/` adapter/factory；worktree 生命周期放在 `src/worktree/` |
| 新增 TUI 展示 | `src/tui/timeline/` projection 与 presentation/component；不在 renderer 写 durable state |
| 新增 Plugin/Skill/Hook/MCP 能力 | `src/extensions/`，并通过 Session extension composition 获得 lifecycle 与 authority |
| 新增本地 trace 字段或投影 | `src/runtime/trace/`；Session authority 事实仍属于 Session Store |
| 改变 turn/queue/tool continuation 语义 | `src/runtime/agent-loop/` 与 `src/runtime/agent.ts`，并同步更新本文和 [core.md](subsystems/core.md) |

## 延伸阅读

- [子系统索引](subsystems/README.md)
- [pi 参考架构](pi-architecture.md)
