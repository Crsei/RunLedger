# Core Agent Runtime

Core Agent Runtime 拥有单个 Agent 的消息状态、模型请求循环、live event、steering/follow-up queue、run budget 和 tool-call continuation。它不拥有 Session owner、持久化 authority、provider credential 或实际 I/O 权限。

源码入口：[`src/runtime/agent.ts`](../../src/runtime/agent.ts)、[`src/runtime/agent-loop/`](../../src/runtime/agent-loop)、[`src/runtime/types.ts`](../../src/runtime/types.ts)、[`src/runtime/interactive-session-controller.ts`](../../src/runtime/interactive-session-controller.ts)。

## 运行主干

`InteractiveSessionController` 是 Session domain 面向 `SessionRuntime` 的 Agent facade。它恢复消息与模型选择，组装 `Agent`，把 provider/auth/model routing 收束为 `StreamFn`，把工具与 policy 注入 loop，并把 Agent events 转发给 Session persistence 和 TUI subscription。

`Agent` 是有状态运行句柄。它持有 `AgentState`、单一 active run、两类消息队列和订阅者；`runAgentLoop()` 是一次 run 的状态机。Agent 不查找 provider，也不打开存储或终端。

| 对象 | 拥有的状态 | 不拥有的状态 |
|---|---|---|
| `InteractiveSessionController` | 当前 model/thinking 选择、恢复消息、工具集合、hook/model-router adapter | owner generation、driver lease、SQLite 事务 |
| `Agent` | `AgentState`、active run、AbortController、steering/follow-up queue | credential、workspace lease、Security snapshot |
| `runAgentLoop()` | 本次 run 的 turn、stream、tool-call 与 budget 局部状态 | 跨 run 生命周期、Session attach |
| `AgentEventSink` | live observation 回调 | durable append 成功的证明 |

## 消息与模型边界

Agent 消息包括 user、assistant 和 tool-result 三类 runtime message。进入 provider 前，`defaultConvertToLlm()` 把它们转换成 provider-neutral `Message[]`；可选 `modelContextAssembler` 再加入受治理的 context sources 并产出 assembly receipt。

`StreamFn(model, context, options)` 是 Core 唯一的模型调用边界。生产 controller 用 Session model router 和 `Models.streamSimple()` 实现它；mock stream 只属于示例与测试组合。

## Run 与 turn

一次 `prompt()` 启动一个 run。run 先发出 `agent_start`，追加输入消息，然后重复以下流程：

```text
turn_start
  -> admit queued messages
  -> convert messages
  -> assemble model context
  -> open provider stream
  -> message_start / message_update* / message_end
  -> execute tool calls, if any
  -> append tool results
turn_end
  -> continue when tools or queued input are owed
  -> otherwise agent_end
```

这里的 `turn` 是一次模型请求循环，不等同于外层 Session ownership epoch。assistant 响应中存在 tool calls 时，工具执行完成后进入下一 turn；被截断的 tool call 不执行，而是合成错误 tool result，保证消息序列可继续解释。

## Queue、取消与并发

同一 Agent 同时只允许一个 active run。idle 时 `prompt()` 启动 run；in-flight 时 controller 把输入路由为 `steer()` 或 `followUp()`。两类 queue 均支持 `all` 或 `one-at-a-time` 消费模式，并且只在下一模型请求前进入正式消息历史。

`interrupt()` abort 当前 run；`waitForIdle()` 等待 active promise 收敛。订阅者异常被隔离，不能反向使已经产生的 Agent 状态失败。Extension turn admission、hook snapshot 和 Session cleanup 由上层 controller/domain 负责。

## Tool continuation

Loop 从 assistant content 中提取 `ToolCall`，按配置顺序准备、授权、执行并 finalize。生产 controller 固定使用 sequential tool execution；tool result 经可选 overflow store 处理后追加为消息，再触发下一模型 turn。

`beforeToolCall` 可以拒绝或替换输入，`afterToolCall` 可以把结果标记为错误。生产组合把这两个 hook 与 Extension `PreToolUse`/`PostToolUse` 和 `ToolAuthorizationPolicy` 串联；实际副作用仍由[工具与 Security](tools.md)的 governed leaf 决定。

## Budget 与终止

Run budget 可以限制模型 turn 数、工具调用数、active duration、连续相同失败和批准过期次数。命中限制时，loop 追加可解释的终止摘要并使用明确 termination reason；预算不通过扩大 timeout 或跳过 authorization 来恢复。

Provider `error`、`aborted`、`length` 与正常 `stop` 都被保留到 assistant message/agent_end。一次 run 的结束不自动关闭 SessionRuntime，也不释放 owner。

## 持久化关系

Core 先向 live listeners 发出事件，并通过注入的 `LedgerSink` 写入 message、turn、tool 与 agent entries。生产 `SqliteLedgerSink` 把这些 entry 编码为 owner-fenced Session events；Core 自己不能把 live emit 当作 durable commit。

模型上下文可以由系统提示、恢复消息、工具 schema 和 Extension context sources 组成。新增会影响审计或恢复的输入时，必须同时定义可验证的 receipt/event，而不能只在 `modelContextAssembler` 中临时拼接。

## 稳定边界

- `runAgentLoopContinue()` 没有独立 continuation 实现；跨 turn continuation 由 `runAgentLoop()` 内部和 Agent queue 完成。
- `InteractiveSessionController` 的 permissive 默认 policy 只用于低层兼容/测试；生产 Session domain 显式注入 governed policy 和 governed `ExecutionEnv`。
- Core 不提供跨 Session Agent registry、并行 root Agent 或 durable child continuation；有界 child execution 由[子 Agent 子系统](subagent.md)拥有。
