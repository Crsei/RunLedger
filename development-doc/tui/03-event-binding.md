# 03 · 事件绑定与状态机

> 本文档列出 `AgentEvent`(经由 `TuiEvent` 适配层)到 TUI 组件 mutation 的**完整映射**。每个分支应有唯一去路,不允许同一事件在多处产生副作用。

---

## 1. 事件总览

`AgentEvent` 来自 `src/runtime/types.ts`,共 5 个父类型、9 个具体事件:

| `AgentEvent.type` | 携带字段 | 语义 |
|-------------------|----------|------|
| `agent_start` | `timestamp` | 一轮 `agent.prompt()` 开始 |
| `agent_end` | `timestamp` | 一轮 `agent.prompt()` 结束(无论成功/失败) |
| `turn_start` | `timestamp, turn, stopReason?` | 一个 turn 开始 |
| `turn_end` | `timestamp, turn, stopReason?` | 一个 turn 结束 |
| `message_start` | `timestamp, role, stopReason?` | 一条新消息开始(user / assistant) |
| `message_end` | `timestamp, role, stopReason?` | 一条消息结束 |
| `message_update` | `timestamp, assistantMessageEvent` | 助手流式增量 token |
| `tool_execution_start` | `timestamp, toolCallId, toolName, isError?` | 工具开始执行 |
| `tool_execution_end` | `timestamp, toolCallId, toolName, isError?` | 工具执行完成 |

RunLedger 的事件流是**严格串联的**:

```
agent_start
  message_start(role=user)         ← (本期不发出,保留位)
  message_start(role=assistant)
    message_update × N
    message_update(toolCall)        ← 首次见某 toolCallId 时挂 ToolExecutionComponent
    tool_execution_start
    tool_execution_end
  message_end(role=assistant)
turn_end? (可多 turn)
agent_end
```

---

## 2. TuiEvent 与分支策略

适配函数 `adaptAgentEvent(ev: AgentEvent): TuiEvent` 只做改名。TUI 主控 `InteractiveMode.handleEvent(ev: TuiEvent)` 的 switch 设计原则:

1. **每分支只 mutate 一种组件类别**(挂载/更新/移除 三选一);
2. **完成 mutation 后统一调** `ui.requestRender()`,**不**在每个 mutation API 内部自调(避免一次事件多次合帧调度);
3. **错误事件不抛**,记日志(`debug ? process.stderr.write : noop`),仅 `agent_end` 时通过 footer 体现;
4. **流式 message_update 节流到位**:同一 frame 内的多个 update 合并,16ms 一刀(pi-tui 默认)。
5. **入口与异常不外溢**(对照 `claude-code-bun` 的"异常不外抛 + 失败护栏"思想):`handleEvent` 任何分支失败记 stderr,**不**向 `agent.subscribe` 调用方抛错;`agent_end` 紧随异常事件时,异常状态由 `agent_end` 分支的 status-error 兜底;init / 资源加载阶段连续失败次数达上限时,`InteractiveMode` 标 disabled 并 `ui.stop()` 平静退出,**不**进入无限重试死循环。

---

## 3. 完整映射表

下表第二列为分支的"入选条件",后两列给出 mutation 与目标组件。`*` 标记的字段在事件中可能不存在,需 defensive null check。

### 3.1 `agent_start`

- 入选:无条件
- mutation:
  - `clearStatusIndicator()`(若仍残留上一轮)
  - `ensureStatus({ kind: "working", message: "Starting..." })` 挂到 `statusContainer`
- 目标:`StatusIndicator`

### 3.2 `agent_end`

- 入选:无条件
- mutation:
  - `clearStatusIndicator()` 移除 `statusContainer` 全部子组件
  - `streamingComponent = undefined`,`streamingMessage = undefined`
  - `pendingTools.clear()`
  - `footer.invalidate()`
- 目标:`statusContainer`、`AssistantMessageComponent`、`ToolExecutionComponent`、`FooterComponent`

### 3.3 `turn_start`

- 入选:无条件
- mutation(本期最小):
  - `ensureStatus({ kind: "working", message: \`Turn #${ev.turn}\` })` 仅当 `statusContainer.children.length === 0` 时挂载
- 目标:`StatusIndicator`

### 3.4 `turn_end`

- 入选:无条件
- mutation:
  - `clearStatusIndicator()` 当 `agent_end` 紧随其后(常见情形)时由 `agent_end` 处理;此处只更新 status 文本为 `Idle`,**不**移除
- 目标:`StatusIndicator`

### 3.5 `message_start` (role === "assistant")

- 入选:`ev.role === "assistant"`
- mutation:
  - 若 `streamingComponent` 已存在则**保留**(防御性,pi 的连续 message_start 同一帧不会发生)
  - 否则 `new AssistantMessageComponent({ theme, initialContent: [], hideThinking: true, onToolCallAugment: (id) => this.attachToolExecution(id) })`,挂 `chatContainer.addChild(streamingComponent)`,记 `streamingMessage = { content: [] }`
  - `ensureStatus` 文本切到 `"Generating..."`,kind 仍为 `working`
- 目标:`AssistantMessageComponent`、`StatusIndicator`、`chatContainer`

### 3.6 `message_start` (role === "user")

- 入选:`ev.role === "user"`
- mutation(本期无,因为 user 消息由 InteractiveMode 在 `prompt(text)` 之前直接 `chatContainer.addChild(new UserMessageComponent(...))`,不靠事件通知)
- 目标:无

### 3.7 `message_end` (role === "assistant")

- 入选:`ev.role === "assistant"`
- mutation:
  - 在 `streamingComponent` 上调用 `updateContent({ content: streamingMessage.content, stopReason: ev.stopReason })`(确保最终 content 一致)
  - `streamingComponent = undefined`
  - `streamingMessage = undefined`
  - 若 `ev.stopReason === "error"`: `ensureStatus({ kind: "error", message: "Generation failed" })`
- 目标:`AssistantMessageComponent`、`StatusIndicator`

### 3.8 `message_update`

最高频事件,需最小心。`assistantMessageEvent` 的 union 类型(来自 `src/types.ts`,与 pi-ai 对齐):

| `assistantMessageEvent.type` | action |
|------------------------------|--------|
| `text` | 追加 text 到 `streamingMessage.content` |
| `thinking` | 追加 thinking block(本期折叠,不计入 messageContainer) |
| `toolCall` | 见 3.8.3 |

#### 3.8.1 `assistantMessageEvent.type === "text"`

mutation:
- `streamingMessage.content.push({ type: "text", text: event.text })`
- `streamingComponent?.updateContent(streamingMessage)` 触发 `messageContainer` 重建(由 pi-tui Container 渲染期间 diff 兜底)

#### 3.8.2 `assistantMessageEvent.type === "thinking"`

mutation:
- `streamingMessage.content.push({ type: "thinking", text: event.text })`
- 同上调 `updateContent`(因 `hideThinking` 默认 true,thinking 不入 messageContainer;但记录在 `currentContent` 以便切换 toggle 时可用)

#### 3.8.3 `assistantMessageEvent.type === "toolCall"`

mutation:
- 取 `event.toolCall.id`(若不存在,RunLedger 内部用 `pendingToolCalls` 查补)
- 在 `streamingMessage.content.push(toolCall)` 之前,先查 `pendingToolCalls.has(id)`:
  - 已知:更新 `argsText = toolCall.input`(由 `pendingTools.get(id).updateArgs(JSON.stringify(toolCall.input, null, 2))`)
  - 未知:**先**调 `attachToolExecution(toolCall)`:
    1. `pendingToolCalls.set(id, toolCall)`
    2. `pendingTools.set(id, new ToolExecutionComponent({ theme, toolName, toolCallId: id, shell: pickShell(toolName), expandable: false }))`
    3. `chatContainer.addChild(pendingTools.get(id))` —— **挂载点是紧随 streamingComponent 之后**(用 `chatContainer.insertAfter(streamingComponent, toolComp)` 而非 `addChild`;若 pi-tui 不提供 `insertAfter`,则改为 `addChild` 在末尾,本期接受末尾顺序)
    4. `pendingTools.get(id).updateArgs(JSON.stringify(toolCall.input, null, 2))`
- 之后**仍**把 toolCall push 到 `streamingMessage.content`,但 render 时只渲染 `· · ·` 占位;真正内容_docs 由 ToolExecutionComponent 渲染

`pickShell(toolName)` 规则:
- `toolName === "bash"` → `"selfRender"`(BashExecutionComponent 替代 ToolExecutionComponent,所以**重新**构造为子类,而非 build one then convert)
- 其它 → `"contentBox"`,默认 `expandable: false`

注:`attachToolExecution` 应在 spec 中也是 first-class mutation API(`attachToolExecution(toolCall: ToolCall): ToolExecutionComponent`),见 02 文档 §1。

### 3.9 `tool_execution_start`

- 入选:无条件
- mutation:
  - `const c = pendingTools.get(toolCallId)`,若**不存在**(可能 `toolCall` 事件丢失,边际场景)则 defensive 创建 `attachToolExecution({ id, name: toolName, input: {} })`
  - `c.markArgsComplete()`(LLM 已传完 args;后续是结果事件)
  - `ensureStatus` 文本: `<toolName> running...`,kind `working`
- 目标:`ToolExecutionComponent`、`StatusIndicator`

### 3.10 `tool_execution_end`

- 入选:无条件
- mutation:
  - `c = pendingTools.get(toolCallId)`
  - 从 ledger 或 Runtime 缓存中获取 `ToolResultContent`(本期 Runtime 通过 `afterToolCall` 不修改 result 时,直接读 ledger `findByType("tool_result")`,取最近一条 parentId 匹配的)
  - 文本化 result: `JSON.stringify(content, null, 2)`(单条 TextContent 取 `.text`)
  - `c.updateResult(textResult, false)`
  - `pendingTools.delete(toolCallId)`(组件保留在 chatContainer,但脱离 pending 索引)
  - 若 `isError`: `c.setExpanded(true)`(错误结果强制展开)
  - `ensureStatus` 切回 `Generating...`(下一轮 message_update 还会回 working)
- 目标:`ToolExecutionComponent`、`StatusIndicator`

---

## 4. 用户输入侧 mutation(独立于事件)

下列 mutation 由 `CustomEditor` / 顶层 KeyboardShortcut 触发,**不**经过 AgentEvent,但同样要 `requestRender`:

| 触发 | mutation |
|------|----------|
| `Ctrl+S` / `Enter`(non-multiline) | 提取 editor 文本 → `chatContainer.addChild(new UserMessageComponent({ theme, text }))` → `agent.prompt(text)`(异步 fire-and-forget)→ `editor.clear()` |
| `Esc`(`app.interrupt`) | 取消 `Agent` 当前 prompt:本期通过 `AbortController.abort()` 触发 `agent_end` 事件(Runtime 层会发出) |
| `Ctrl+D`(`app.exit`) | `ui.stop()` |
| `Ctrl+L`(`app.clearScreen`) | 用 `process.stdout.write("\x1b[2J\x1b[H")` 清屏,然后 `ui.requestRender()` 强制重绘 |
| `Ctrl+O`(`app.openSession`) | overlay `LedgerSessionSelector` |
| `Ctrl+T`(`app.toggleThinking`) | overlay `ThinkingSelector` |
| `↑` in editor(空文本) | 唤起 `user-message-selector`(本期未实现 → noop) |

---

## 5. 异常路径

| 场景 | 行为 |
|------|------|
| `agent_end` 时 `streamingComponent` 还在 | 在 `agent_end` 分支强制 discard + status = error |
| `tool_execution_end` 收到但 `pendingTools` 没记录 | 防御性 append 一个 CustomMessage 组件展示原始 result,不抛 |
| `message_update` 在 `streamingComponent === undefined` 时到 | 忽略并 `debug log`("orphan message_update") |
| `InteractiveMode` init 阶段连续失败 ≥ `MAX_CONSECUTIVE_INIT_FAILURES` 次 / 进入死循环 | 把 InteractiveMode 标 disabled,记 stderr,`ui.stop()` 平静退出,不抛(对应第 2 节"入口与异常不外溢") |
| 任何 catch 块 | 不外抛;`statusContainer.addChild(new StatusIndicator({ kind: "error", message }))`,最多 1 个 |

### 5.1 失败护栏常量

| 常量 | 值 | 含义 | 出处对照 |
|------|----|------|----------|
| `MAX_CONSECUTIVE_INIT_FAILURES` | `3` | InteractiveMode init 阶段连续失败次数上限 | 对照 `claude-code-bun` `MAX_CONSECUTIVE_INIT_FAILURES = 3`(Datadog 2026-03-08:某 stuck client 一天发 2879 次 401) |
| `INIT_FAILURE_BACKOFF_MS` | `10_000` | 连续失败后下一次重试的最短间隔 | 对照 `claude-code-bun` `BRIDGE_FAILURE_DISMISS_MS = 10_000` |

常量定义位置:`InteractiveMode` 私有静态字段(见 `02-component-spec.md` §1 持态字段表末尾)。常量值如有调整,需同时更新本表与 spec 文档。

---

## 6. 状态机视图

```
                          [user enter]
                                │
                                ▼
          ┌─── prompt(text) ──►│ Agent.prompt()
          │                     │
   [Idle] │                     ▼
   status: working 运行                [agent_start] ──► ensureStatus(working)
   chat:                                    │
   - UserMessage                  ┌─────────┴─────────┐
   - AssistantMessage(streaming)  │                     │
   - Tool * pending               ▼                     ▼
                          [message_start(asst)]   [message_update(text)]
                          new streamingComponent  append text
                                │
                                ▼
                          [message_update(toolCall)]
                          attachToolExecution → ToolExecution 加入 chat
                                │
                                ▼
                          [tool_execution_start]
                          toolComp.markArgsComplete()
                                │
                                ▼
                          [tool_execution_end]
                          toolComp.updateResult() → leave in chat
                                │
                                ▼
                          [message_end(asst)]
                          streamingComponent = undefined
                                │
                                ▼
                          [agent_end]
                          clearStatusIndicator
                                │
                                ▼
                            [Idle]
```
