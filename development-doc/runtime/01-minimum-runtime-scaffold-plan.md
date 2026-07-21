# RunLedger 最小可运行 Agent Runtime 脚手架

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_24180b7c-5c31-4150-9064-a92df5c2e579.md`。
> 本文记录项目最初的最小骨架设计,后续演进见同目录的 agent-loop 与工具系统计划;当前实现状态以仓库根目录 `AGENTS.md` 为准。

## 目标
以 `pi` 项目 (`packages/agent`) 为参考,在 `F:\AIclassmanager\my_workspace\RunLedger` 搭建一个**单包 TypeScript** 项目,实现最小可运行的 agent runtime + 审计 ledger 骨架。所有非核心特性以 `// TODO:` 标注占位,不实现。

## 范围对比(pi vs RunLedger)
| 特性 | pi | RunLedger(本次) |
|------|----|------|
| 包结构 | monorepo(3 packages) | 单包(`src/` 子目录) |
| LLM 驱动 | `@earendil-works/pi-ai` 真实多 provider | Mock `streamFn`,可一行替换为真 OpenAI |
| Session 持久化 | JSONL session 树 | JSONL append-only ledger(单文件,扁平) |
| Tool 执行 | Node fs+shell 完整 `ExecutionEnv` | 注册式 `Tool.execute`,Mock 一个 echo 工具 |
| Compaction | 完整实现 | 占位 `// TODO` |
| Skills / Templates / Proxy / Harness | 完整实现 | 占位 `// TODO` |
| Demo | 编码 agent CLI | `examples/run.ts` CLI demo,跑通一次 start→message→tool→end |

## 目录结构(最终产出)
```
RunLedger/
├── .gitignore
├── .npmrc
├── AGENTS.md                      # 简化版开发规则(中文)
├── README.md                      # 项目介绍 + 快速开始(中文)
├── package.json                   # type: module, scripts, devDeps: typescript, tsx, vitest, @types/node
├── tsconfig.json                  # extends tsconfig.base.json
├── tsconfig.base.json             # Node16 / strict / verbatimModuleSyntax / 只允许可擦除 TS 语法
├── biome.json                     # 格式化配置(可选,默认值)
├── src/
│   ├── index.ts                   # 公共出口 barrel
│   ├── types.ts                   # 核心类型:AgentMessage / AgentTool / AgentEvent / AgentContext / AgentLoopConfig / StreamFn
│   ├── event-stream.ts            # 最简 EventStream<TEvent, TResult>(push-based)
│   ├── agent-loop.ts              # runAgentLoop 核心:外层 follow-up / 内层 tool 轮;每轮 transformContext → convertToLlm → streamFn → executeToolCalls → prepareNextTurn → shouldStopAfterTurn
│   ├── agent.ts                   # Agent 类:封装 stateful 调用,subscribe 事件
│   ├── ledger/
│   │   ├── types.ts               # LedgerEntry / LedgerHeader / LedgerSink
│   │   ├── memory-ledger.ts       # 内存实现(默认)
│   │   └── jsonl-ledger.ts        # JSONL append-only 文件实现
│   ├── tools/
│   │   └── echo.ts                # Mock echo 工具(回显 args),证明 tool 路径走通
│   └── providers/
│       └── mock-stream.ts         # Mock streamFn:把 prompts 拼成一段文本 + 一个 echo toolCall
├── examples/
│   └── run.ts                     # CLI demo:`npx tsx examples/run.ts`,跑通一次完整流程并把 ledger 写到 ./tmp/demo.jsonl
└── tests/
    └── agent-loop.test.ts         # vitest:跑一次 mock 循环,断言事件序列 + ledger 落盘 6 条记录
```

## 关键设计摘要

### 1. 类型 (src/types.ts)
- `AgentMessage`:`user` / `assistant` / `toolResult` 三种角色;扩展点用 `CustomAgentMessages` 接口声明合并(占位 `// TODO 扩展`)
- `AgentTool`:`{ name, description, parameters: TSchema, execute: (toolCallId, args, signal, onUpdate) => Promise<{content; details?}> | throwing }`
- `AgentEvent`:`agent_start` / `turn_start` / `message_start` / `message_update` / `message_end` / `tool_execution_start` / `tool_execution_end` / `turn_end` / `agent_end`
- `AgentContext`:`{ systemPrompt; messages: AgentMessage[]; tools: Tool[] }`
- `AgentLoopConfig`:`{ model; apiKey?; convertToLlm; tools?; toolExecution?; beforeToolCall?; afterToolCall?; prepareNextTurn?; shouldStopAfterTurn?; ledger?: LedgerSink }`,其余字段(e.g. `transformContext` / `thinkingBudgets` / `transport` / `getSteeringMessages` / `getFollowUpMessages` / `thinking` / `temperature` / `maxTokens` / `maxRetries` 等)全部以 `// TODO` 注释列出但不实现
- `StreamFn`:`(model, context, options) => AssistantMessageEventStream | Promise<...>`,契约:不抛错,错误以 `stopReason: "error"` 的 final message 编码

### 2. EventStream (src/event-stream.ts)
- 参考 pi 的最简实现:`EventStream<TEvent, TResult>` 提供 `iterate()` async generator、`emit(event)`、`resolve(result)`、`throw(err)`。`AssistantMessageEventStream` 是 `EventStream<AssistantMessageEvent, AssistantMessage>` 的别名。

### 3. Agent Loop (src/agent-loop.ts)
仅实现核心路径(其他分支 `// TODO`):
```
export async function runAgentLoop(prompts, context, config, emit, signal?, streamFn?):
  emit agent_start
  for each prompt: emit message_start/message_end (作为 user 消息入 context)
  while not stopped:
    emit turn_start
    llmMessages = config.convertToLlm(context.messages)   // 边界
    stream = streamFn(config.model, {systemPrompt, messages: llmMessages, tools}, {apiKey, signal, ...})
    for await ev of stream.iterate(): emit message_update(message_start 首次, message_end 完成)
    取出 assistant.content 中的 toolCall 块
    if assistant.stopReason === "length": 把所有 toolCall 标 isError
    else: executeToolCalls(parallel 或 sequential) → 每个 tool 一次 tool_execution_start/end → 把 toolResult 消息 push 进 context
    emit turn_end
    if config.shouldStopAfterTurn?.(): emit agent_end; return
    if no toolCall: break                  // 内层循环退出条件
  emit agent_end
  返回 context.messages
```
- `executeToolCalls` 实现 sequential / parallel 两种,parallel 默认(参考 pi)
- 所有 emit 之前/之后调用 `config.ledger?.append(entry)` 写一条对应 `LedgerEntry`(type=`event_*`),`agent_start` / `turn_start` / `tool_call` / `tool_result` / `turn_end` / `agent_end` 均落盘
- 未实现的 `prepareNextTurn`、`getSteeringMessages`、`getFollowUpMessages`、`transformContext`:在函数签名中以 `?:` 标出,实现处写 `// TODO(pi): 未实现` 并跳过

### 4. Agent 类 (src/agent.ts)
- `new Agent({ initialState, streamFn, ledger, convertToLlm })`
- `state`:`{ systemPrompt, messages, tools, model }`,setter 做数组浅拷贝(参考 pi)
- `subscribe(listener)` / `on(type, handler)`
- `prompt(text)` → 调用 `runAgentLoop`,内部把事件转发给 subscribers
- `convertToLlm` 默认:把 `AgentMessage` 一比一映射成最简 `Message`(user/assistant/toolResult),不做任何过滤(`// TODO(pi): loadSkills / system prompt 编排 / 摘要`)

### 5. Ledger (src/ledger/)
- `LedgerHeader`:`{ type: "ledger", version: 1, id, createdAt, sessionId }`
- `LedgerEntry`:
  ```
  { id, sessionId, parentId, timestamp, type, payload }
  type ∈ { session, message, tool_call, tool_result, turn, agent_event, custom }
  ```
- `MemoryLedger` / `JsonlLedger`:`append(entry)`、`entries()`、`get(id)`、`findByType(type)`、`close()`
- `JsonlLedger` 文件布局:第 1 行 header,后续每行一个 entry;append 时 fs.appendFile,占位换行
- ID:`uuidv7` 的 8 位 tail(参考 pi),无 v7 依赖时退化为 `crypto.randomUUID().slice(0, 8)`

### 6. Mock streamFn (src/providers/mock-stream.ts)
- 接收 `AgentContext`(简化版),返回一个 `AssistantMessageEventStream`
- 行为:第一次收到 user prompt 时,emit `text_delta` 透露"我会调用 echo 工具";然后 emit 一个 `toolCall` block(name="echo", args={"text": <user 输入>});`stopReason: "tool_use"`
- 第二次被调用(当 toolResult 已在 context 里),emit 一段总结文本 + `stopReason: "stop"`
- 完全在内存里完成,不发起任何网络请求 → demo 不需要 API key

### 7. Echo Tool (src/tools/echo.ts)
- `name: "echo"`,`description: "回显输入参数"`,`parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }`(用 `JSONSchema` 简单定义,不引 typebox)
- `execute(toolCallId, args, signal, onUpdate)`:返回 `{ content: [{ type: "text", text: args.text }] }`

### 8. examples/run.ts(CLI demo)
- 用 tsx 直接跑;新建 ledger 文件 `./tmp/demo.jsonl`(若不存在);构造 Agent,挂载 echo 工具、mock streamFn、JsonlLedger;调用 `agent.prompt("Hello, RunLedger!")`;订阅事件,把 text 实时打印到 stdout;最后打印 ledger 落盘的条目数和路径,证明可审计

### 9. tests/agent-loop.test.ts(vitest)
- 用 MemoryLedger 跑一次 mock 循环,断言:
  - 事件序列 = `[agent_start, message_start, message_end, turn_start, message_start, message_update*, message_end, tool_execution_start, tool_execution_end, turn_end, turn_start, message_start, message_update*, message_end, turn_end, agent_end]`
  - ledger 落盘条目数 >= 10(包含 session header + 各事件)
  - 最终 messages 数组 last = assistant 摘要消息

## 技术选型明细
- TS 配置直接复制 pi 的 `tsconfig.base.json`(`module/moduleResolution: Node16`、`strict`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、只允许可擦除 TS 语法)
- 包:`type: "module"`、`main: ./dist/index.js`、`exports`
- 运行时依赖:无(`EventStream` 自实现,Ledger 用 node:fs/path/crypto)
- 开发依赖:`typescript` `tsx` `vitest` `@types/node`
- npm 脚本:`build`(tsc -p .)`dev`(tsx watch 占位 `// TODO` 不实现)`test`(vitest run)`demo`(tsx examples/run.ts)`check`(tsc --noEmit + 占位 `// TODO: biome`)
- 中文文档:README.md、AGENTS.md、所有 src 注释为中文

## 不实现的内容(代码中用 `// TODO(pi): …` 占位)
- `transformContext` 上下文变换
- `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages` 队列与下一轮准备
- `thinkingBudgets` / `temperature` / `maxTokens` / `transport` / `maxRetries`
- 真实 LLM provider(仅 mock)
- Session 树(JSONL ledger 是扁平的,不分叉)
- `AgentHarness` 高级驱动器
- Compaction / branch summarization
- Skills(`/SKILL.md` 加载)/ Prompt templates
- `streamProxy`(browser → backend)
- `ExecutionEnv`(FileSystem + Shell)抽象;Node fs 与 child_process 仅在 `JsonlLedger` 与未来工具中直接用
- `AsiaToolCalls` 之外的 tool execution mode(只支持 sequential / parallel)
- OpenTelemetry / metrics / RBAC / 多租户

## 验收标准
成功标准:
1. `npm install` 通过(无运行时依赖)
2. `npm run build` 成功,`dist/` 产物齐全
3. `npm test` 通过:vitest 单测全绿
4. `npm run demo` 运行后:`./tmp/demo.jsonl` 至少 10 行,内容包含 `agent_start` / `tool_call` / `tool_end` / `agent_end`,stdout 看到 mock 的 echo 回显和总结文本

## 实施顺序(我会按此逐步执行)
1. 写根配置:`.gitignore`、`.npmrc`、`package.json`、`tsconfig.base.json`、`tsconfig.json`、`biome.json`、`AGENTS.md`、`README.md`
2. 写 `src/types.ts` + `src/event-stream.ts`
3. 写 `src/ledger/{types,memory-ledger,jsonl-ledger}.ts`
4. 写 `src/providers/mock-stream.ts` + `src/tools/echo.ts`
5. 写 `src/agent-loop.ts`
6. 写 `src/agent.ts` + `src/index.ts`
7. 写 `examples/run.ts` 和 `tests/agent-loop.test.ts`
8. `npm install` → `npm run build` → `npm test` → `npm run demo`,逐一验证
9. 提交初始 commit(等用户确认后再做)
