# Agent-Loop 填实计划(用 `asset/api-key.json` 跑通 deepseek 化名的完整循环)

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_c0cdba49-8144-49e6-a02c-0a8a20ccf7ed.md`。
> 本文聚焦 agent-loop、Agent、ledger、mock stream 与真实 LLM 验证;当前实现状态以仓库根目录 `AGENTS.md` §1.2 为准。

## 总目标
把 `src/_legacy/` 中暂存的 agent-loop 空骨架**原地复活**为正式代码,与 pi-ai 移植层对接,使 `examples/run.ts` 能用 deepseek 提供的 anthropic 兼容端点真实跑通一段 agent 对话(含 1-2 个工具调用),并让 `tests/agent-loop.test.ts` 通过。

## 已确认的三个关键决策(来自前面的 AskUserQuestion)
1. **原地复活** `_legacy/` 骨架(挪到正式路径,改名去掉 `.legacy.ts` 后缀),不另起 `src/runtime/`。
2. **测试目标 = deepseek 化名 + 自定义模型**:用 pi-ai 内置 `anthropic` provider 在运行时构造一个自定义 Model(`id="deepseek-v4-pro"`,`api="anthropic-messages"`,`baseUrl="https://api.deepseek.com/anthropic"`),`apiKey`/`baseUrl`/env 从 `asset/api-key.json` 读出后通过 `models.stream(model, ctx, { apiKey, env })` 字段传入。
3. **复活完整骨架**:agent-loop / agent / event-stream / ledger(memory + JSONL) / echo tool / mock-stream 全部到位。

---

## 一、文件移动与改名清单(`git mv`,保留历史)

| 原路径 | 目标路径 | 注意点 |
|---|---|---|
| `src/_legacy/types.ts`(待新建) | `src/runtime/types.ts` | 第一关:`_legacy/agent-loop.ts` 引用但实际不存在 |
| `src/_legacy/agent-loop.ts` | `src/runtime/agent-loop.ts` | 改 import 路径与 stream 消费逻辑 |
| `src/_legacy/agent.ts` | `src/runtime/agent.ts` | 改 import 路径 |
| `src/_legacy/event-stream.ts` | **删除**(被 `src/utils/event-stream.ts` 取代) | 骨架自研的 EventStream 适配改为基于 pi-ai `AssistantMessageEventStream`;不再有独立文件 |
| `src/_legacy/ledger/types.ts` | `src/runtime/ledger/types.ts` | 路径调整 |
| `src/_legacy/ledger/memory-ledger.ts` | `src/runtime/ledger/memory-ledger.ts` | 路径调整 |
| `src/_legacy/ledger/jsonl-ledger.ts` | `src/runtime/ledger/jsonl-ledger.ts` | 路径调整 |
| `src/tools/echo.legacy.ts` | `src/runtime/tools/echo.ts` | 路径调整,改 `import "../types.js"` |
| `src/providers/mock-stream.legacy.ts` | `src/runtime/providers/mock-stream.ts` | 路径调整,改用 pi-ai EventStream |

`git mv` 全部走。9 个文件挪完后,**`src/_legacy/` 整个目录删除**;`src/tools/`、`src/providers/` 下 `.legacy.ts` 备份清空(已 mv 至 runtime/)。

## 二、`src/runtime/types.ts`(新建 —— 第 1 关)

集中定义运行循环层所需类型,使其同时:
- 引用 pi-ai 移植层类型(`Message` / `Tool` / `StopReason` / `AssistantMessage` / `AssistantMessageEvent` / `AssistantMessageEventStream` / `Model<TApi>` / `StreamOptions` / `ToolCall` / `TextContent` 等);
- 保留骨架原 `AgentMessage` / `AgentEvent` / `AgentContext` / `AgentLoopConfig` / `AgentTool` / `AgentToolCall` 等对外语义。

**核心类型映射**(从骨架原 `agent-loop.ts` 中提取的需求 + pi-ai 对齐):

```ts
import type { Model, Api, Message, Tool, AssistantMessage,
                AssistantMessageEvent, AssistantMessageEventStream,
                StreamOptions, ToolCall, TextContent, StopReason } from "../types.ts";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Tool["parameters"];   // 复用 pi-ai 的 TSchema
  execute(id: string, input: Record<string, unknown>, signal?: AbortSignal):
      Promise<ToolResultContent>;
}

export type AgentMessage = UserAgentMessage | AssistantAgentMessage | ToolResultAgentMessage;
export interface UserAgentMessage { role: "user"; content: TextContent[]; }
export interface AssistantAgentMessage {
  role: "assistant";
  content: (TextContent | ToolCall)[];
  stopReason: StopReason;
  usage?: AssistantMessage["usage"];
}
export interface ToolResultAgentMessage {
  role: "toolResult"; content: ToolResultContent[];
}
export interface ToolResultContent {  // 与 pi-ai ToolResultMessage 单条化差异,在 convertToLlm 时展开
  type: "toolResult";
  toolCallId: string;
  content: TextContent[];
  isError?: boolean;
}

export type AgentEvent =
  | { type: "agent_start" | "agent_end"; timestamp: number }
  | { type: "turn_start" | "turn_end"; timestamp: number; turn: number; stopReason?: StopReason }
  | { type: "message_start" | "message_end"; timestamp: number;
       role: "user" | "assistant"; stopReason?: StopReason }
  | { type: "message_update"; timestamp: number; assistantMessageEvent: AssistantMessageEvent }
  | { type: "tool_execution_start" | "tool_execution_end";
       timestamp: number; toolCallId: string; toolName: string; isError?: boolean };

export type AgentEventSink = (ev: AgentEvent) => void | Promise<void>;
export interface AgentToolCall { id: string; name: string; input: Record<string, unknown>; }
export interface AgentContext { systemPrompt?: string; messages: AgentMessage[]; tools: AgentTool[]; }
export interface LlmContext  { systemPrompt?: string; messages: Message[]; tools: AgentTool[]; }   // 转换后的 LLM 视图

export interface StreamFn {  // 签名对齐 pi-ai StreamFunction
  (model: Model<Api>, ctx: LlmContext, options?: StreamOptions): AssistantMessageEventStream;
}

export interface AgentLoopConfig {
  model: Model<Api>;
  apiKey?: string;
  env?: Record<string, string>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  toolExecution?: "sequential" | "parallel";
  shouldStopAfterTurn?: (ctx: { messages: AgentMessage[]; turn: number }) =>
      boolean | Promise<boolean>;
  prepareNextTurn?: (ctx: { messages: AgentMessage[]; turn: number }) =>
      AgentLoopTurnUpdate | Promise<AgentLoopTurnUpdate>;
  beforeToolCall?: (input: { tool: AgentTool; toolCall: AgentToolCall; messages: AgentMessage[] },
                    signal?: AbortSignal) => Promise<{ block?: true; reason?: string } | void>;
  afterToolCall?: (input: { tool: AgentTool; toolCall: AgentToolCall;
                            messages: AgentMessage[]; result: ToolResultContent },
                   signal?: AbortSignal) => Promise<Partial<ToolResultContent> | void>;
}

export interface AgentState { systemPrompt?: string; messages: AgentMessage[];
                              tools: AgentTool[]; model: Model<Api>; }
export interface AgentLoopTurnUpdate { systemPrompt?: string; tools?: AgentTool[]; model?: Model<Api>; }

export type { StopReason, TextContent, ToolCall };   // re-export 便利
```

设计准则:
- **不**自己重新发明 `StopReason` / `TextContent` / `ToolCall` —— 直接复用 pi-ai 的;
- `AgentMessage` 与 pi-ai `Message` 的差异在 `convertToLlm` 边界转换(默认实现里把内嵌的 `toolResult` 摊平成 pi-ai 的多条 `ToolResultMessage`,带 `toolCallId` / `toolName` / `isError`)。

## 三、`src/runtime/agent-loop.ts`(复活)

骨架原文件 ~538 行已写得相当完整;主要修改集中在 4 处:

1. **改 import 路径** `./types.js` → `./types.ts`,`./ledger/types.js` → `./ledger/types.ts`。
2. **stream 消费改走 pi-ai 事件**:原骨架假定 stream emit `{type:"start"}` `{type:"text_delta"}` `{type:"toolcall_end"}` `{type:"stop"}` —— 这与 pi-ai 的 `AssistantMessageEvent` **不同**(pi-ai 是 `{type:"text_delta", contentIndex, delta, partial}` 等)。
   - `AssistantMessageEventStream implements AsyncIterable`(见 `src/utils/event-stream.ts:50`),改用 `for await (const ev of stream)` 直接迭代(pi-ai EventStream 已实现 `Symbol.asyncIterator`);
   - `ev.type==="start"` → emit `message_start("assistant")`;
   - `ev.type==="text_delta"` → 累进文本 + emit `message_update`;
   - `ev.type==="toolcall_end"` → 拿 `ev.toolCall` 写进 `assistantContent`;
   - `ev.type==="done"` → 拿 `ev.message` 终结,用其 `stopReason`/`usage`;
   - `ev.type==="error"` → 设 `stopReason="error"`,记下 `ev.error.errorMessage`。
3. **调用 `streamFn`** 改为 `await Promise.resolve(fn(loopModel, llmContext, { apiKey, signal, env }))`,把 `env` 透传给 `anthropic` provider 的 `ANTHROPIC_BASE_URL` override(pi-ai `StreamOptions.env` 字段会通过 `overlayEnvAuthContext` 注入到 authContext,使 `envApiKeyAuth("Anthropic API key", [...])` 中的 `ANTHROPIC_AUTH_TOKEN` 也能从该 env 读出)。
4. **`AgentLoopConfig` 中的 ledger 透传**沿用现有 spread-injection hack(`...({ ledger: this._ledger } as Record<string, unknown>)`),不去动类型契约。

## 四、`src/runtime/agent.ts`(复活)

骨架原文件 ~195 行已经够用,改造点:
- 改 import 路径;
- `streamFn` 类型用新 `StreamFn`;
- 删除 `void newId; void ({} as TextContent);` 防御性占位(verbal 模式下改后 imports 都真用);
- `convertToLlm` 类型签名改为 `(messages: AgentMessage[]) => Message[] | Promise<Message[]>`,与 `AgentLoopConfig` 一致。

## 五、`src/runtime/ledger/{types,memory-ledger,jsonl-ledger}.ts`(复活)

仅改 import 路径。代码本身已经基本可用(扁平 JSONL,append-only)。值得做的额外健全化:
- `MemoryLedger` 把 `lastError` 字段补上(原接口声明但未赋值);
- `JsonlLedger` 在 `append` 时把 fs 错误包到 `lastError` 上、**不**抛错(对齐 AGENTS.md §2 "异步工具方法不抛错"原则)。

## 六、`src/runtime/tools/echo.ts` 与 `src/runtime/providers/mock-stream.ts`(复活)

- `echo.ts`:走新 `AgentTool` 接口;参数 `Type.Object({ text: Type.String() })`,`execute` 返回 `{type:"toolResult", toolCallId, content:[{type:"text", text}], isError:false}`。
- `mock-stream.ts`:用 pi-ai `AssistantMessageEventStream` 重写。原骨架假定自定义事件协议,现改成 emit `AssistantMessageEvent`(`start` → `text_delta` × N → `done`),协议见 `src/utils/event-stream.ts:69-83` + `src/types.ts:464-477`。

## 七、`tests/agent-loop.test.ts`(改造 import)

唯一要改的是 import 路径(`../src/index.js` 仍然有效,因为下一节会从 `src/index.ts` 重导出)。断言逻辑本身不需要改。

## 八、`src/index.ts` barrel 扩展

新增 8 个 export:`runtime/types.ts`、`runtime/agent.ts`、`runtime/agent-loop.ts`、`runtime/ledger/{types,memory-ledger,jsonl-ledger}.ts`、`runtime/tools/echo.ts`、`runtime/providers/mock-stream.ts`。

类型与既有 pi-ai types 同名处(若有)需要用 `export type` 重命名或干脆不 re-export,等遇冲突见招拆招(`AgentMessage` / `AgentContext` 前缀已避免大多数冲突)。

## 九、`examples/run.ts` 接入真实 LLM

保留现有 catalog demo,新增一段真实 LLM 调用子流程:

1. **读取 asset 配置**:从 `asset/api-key.json` 读出 `env`(校验后得到 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` = `deepseek-v4-pro`)。读文件失败给清晰提示但不退出。
2. **构造自定义 model** 字面量:
   ```ts
   import type { Model } from "../src/types.ts";
   const deepseekViaAnthropic: Model<"anthropic-messages"> = {
     id: "deepseek-v4-pro",
     name: "DeepSeek V4 Pro (via Anthropic compat)",
     api: "anthropic-messages",
     provider: "anthropic",
     baseUrl: "https://api.deepseek.com/anthropic",
     reasoning: false,
     input: ["text"],
     cost: { input: 0.435, output: 0.87,
             cacheRead: 0.003625, cacheWrite: 0 },
     contextWindow: 1000000,
     maxTokens: 384000,
   };
   ```
   - `baseUrl` 直接走 anthropic stream(见 `src/api/anthropic-messages.ts:856` 用 `model.baseUrl`),deepseek 端点会被命中。
   - `// why any: 测试专用 minimal model 字面量,避免补满所有可选字段` —— 用 `as Model<"anthropic-messages">` 显式断言。
3. **用 builtinModels() 跑**:用 `models.stream(deepseekViaAnthropic, ctx, { apiKey, env: { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN }, cacheRetention: "none" })` 拿 stream,绕开 `Models` 的 OAuth/credential 解析路径(直接 `apiKey` override)。
4. **跑通 agent-loop**:构造 `Agent`,注入 `streamFn` = `(model, ctx, opts) => models.stream(model, ctx, { ...opts, apiKey, env, cacheRetention: "none" })`,`echo` 工具,`prompt("你好,请调用 echo 工具原样返回 'pong',然后告诉我你是什么模型")`,打印每个 turn 的 `assistant_message` content / stop reason / usage。
5. **错误兜底**:用 `try/catch` 包住网络调用段,失败时打印清晰 error(包含 deepseek token 前 4 位 / status / message),**demo 主流程仍输出 catalog 列表**;不抛异常退出。

## 十、`tsconfig.json` exclude 列表改造

把 `_legacy` / `index.legacy.ts` / `tools/echo.legacy.ts` / `providers/mock-stream.legacy.ts` 这几条 exclude 移除(`git mv` 走后这些路径已不再有文件)。

最终 `exclude` 列表只保留 `node_modules / dist / tests / examples / scripts`。

## 十一、AGENTS.md / README.md 文档同步

- AGENTS.md §1.1 把 `_legacy/` 段移除,新增 `src/runtime/` 已填实条目;
- AGENTS.md §1.2 "待填实"段移除 `agent-loop/agent/event-stream/ledger/tools/mock-stream`;
- AGENTS.md §1.3 中"// TODO(pi)" 留下来的不动,但 §1.2 已完成的从该列表清掉;
- AGENTS.md §4 目录约定:增加 `src/runtime/` 一截。
- README.md "目录结构"段同步。

## 十二、验证流程(按 AGENTS.md §3 顺序)

```bash
npm run check          # 必须无 error / warning / info
npm test               # tests/agent-loop.test.ts 通过
npm run demo           # catalog demo + 新增 deepseek 真实调用子命令
```

deepseek 端点若失败(token 失效/网络受限),demo 仍可跑通 catalog 部分,deepseek 调用段以 try/catch 给出明确 error 不阻塞退出。

## 十三、提交切分(7 个 commit)

1. `feat(runtime): 建立 src/runtime/ 目录,新建 types.ts 对齐 pi 类型` —— 新建 `src/runtime/types.ts`,typecheck 通过(无消费者)。
2. `feat(runtime): 复活 ledger(memory + JSONL)并接入 typecheck` —— 把 `ledger/{types,memory-ledger,jsonl-ledger}.ts` `git mv` 进 `src/runtime/ledger/`,改 import 路径,include 通过 typecheck。
3. `feat(runtime): 复活 mock-stream provider + echo tool` —— `git mv` + 重写 mock-stream 走 pi-ai EventStream,echo 走新 AgentTool 接口。
4. `feat(runtime): 复活 agent-loop + Agent 类,接入 pi-ai stream` —— `git mv` + 4 处 stream 消费改造(`§三`)。
5. `test: tests/agent-loop.test.ts 恢复通过 + src/index.ts barrel 重导出 runtime` —— 扩 `src/index.ts` 8 个 export,跑 `npm test` 绿。
6. `feat(examples): examples/run.ts 接入 deepseek 化名 LLM 真实调用` —— 主验证步骤。
7. `docs: 同步 AGENTS.md / README 关于 runtime/ 与 _legacy/ 的描述` —— 收尾。

每个 commit 跑 `npm run check`,等 error / warning / info 全清再进下一个;commit 描述写"为什么"不写"是什么"(AGENTS.md §3)。

## 风险与备选

- **风险 A**:自定义 model 字段类型与 `Model<"anthropic-messages">` 接口不完全契合(`cost.tiers` 可选但 `cost` 是必填具体子字段)。
  **备选**:在字面量上填默认值,`as Model<"anthropic-messages">` 显式断言 + `// why: 测试专用字面量` 注释(`noUncheckedIndexedAccess` 已关闭)。
- **风险 B**:DeepSeek 的 anthropic 兼容端点对 stop reason / tool_use 的语义可能与 anthropic 原生略有差异。
  **备选**:`reasoning: false` 不开 thinking;首次失败时打印 stream emit 的最后一条 raw event 以便人工诊断。
- **风险 C**:pi-ai `anthropic-messages` stream 默认带 `cache_control` 头部,deepseek 可能不认。
  **备选**:传 `cacheRetention: "none"`(`AnthropicOptions` 已支持,见 `src/types.ts:99`)。
- **风险 D**:asset 中 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 等额外字段我们用不上,但加载无害。
- **风险 E**:barrel `export *` 时若有同名导出冲突(`StopReason` 等)会触发 TS error。
  **备选**:runtime/types.ts 中相关 re-export 改成 `export type { StopReason } from "../types.ts";` 形式,或干脆不 re-export,让消费者直接 import pi-ai types。

## 完成判定

- [ ] `npm run check` 0 error / 0 warning / 0 info;
- [ ] `npm test` 通过(2 个 it);
- [ ] `npm run demo` 跑出 catalog 列表 + 用 `asset/api-key.json` env 真实调用 deepseek 端点拉一条响应(若 token 失效给出明确 error,不阻塞 demo);
- [ ] `src/_legacy/` 目录与全部 `*.legacy.ts` 文件已删除;
- [ ] `AGENTS.md` / `README.md` 描述同步,`src/runtime/` 与 `tests/agent-loop.test.ts` 状态从"待填实"升为"已完成"。
