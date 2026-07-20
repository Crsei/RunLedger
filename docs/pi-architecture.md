# pi 项目架构：API OAuth → Provider → Agent Core

> 源仓库：`F:\AIclassmanager\my_workspace\pi`
> 文档生成日期：2026-07-20
> 适用版本：commit `35f12c8c`（main 分支）

整个项目把抽象拆成三层，分别由三个包承担：

| 层 | 包 | 职责 |
|---|---|---|
| **OAuth / Auth** | `packages/ai` | 走 RFC 8628 设备码 / PKCE 浏览器授权码流，落地到 `auth.json`（mode 0600），过期时双检锁刷新 |
| **Provider** | `packages/ai`（`packages/agent` / `packages/coding-agent` 仅消费） | `Provider` 接口 + 30 多个具体供应商工厂；`Models` 注册表 + `applyAuth` 把 OAuth/apiKey 落到请求上 |
| **Agent Core** | `packages/agent`（运行时）+ `packages/coding-agent`（宿主） | `Agent` 类 + `runAgentLoop`；通过 `StreamFn` 把"调 LLM"这件事完全反向注入，Agent 自己不知道 Provider 是谁 |

> 配套数据流图见同目录 `pi-architecture-diagram.mmd`。

---

## 一、OAuth 层（`packages/ai/src/auth/`）

### 1.1 类型契约

`packages/ai/src/auth/types.ts`

- `OAuthCredentials`（24-29）：`{ refresh, access, expires, [key]: unknown }` —— 各供应商可塞私货（Copilot 的 `availableModelIds` / `enterpriseUrl`、Codex 的 `accountId`、Radius 的 `scope` 等）
- `CredentialStore`（60-88）：唯一写入口是 `modify(id, fn)`，串行化 read-modify-write，避免并发请求同时 refresh 同一个 token
- `OAuthAuth`（189-210）：`login(interaction)` / `refresh(cred, signal)` / `toAuth(cred): ModelAuth`，其中 `ModelAuth = { apiKey?, headers?, baseUrl? }` —— 这就是 OAuth → Provider 的桥

### 1.2 五个 OAuth 流实现

`packages/ai/src/auth/oauth/`

| 文件 | 流类型 | 端口/备注 |
|---|---|---|
| `anthropic.ts` | PKCE + 本地 callback | `127.0.0.1:53692/callback`；OAuth token 形如 `sk-ant-oat-*` |
| `openai-codex.ts` | 浏览器 PKCE **或** RFC 8628 设备码 | `127.0.0.1:1455/auth/callback` |
| `github-copilot.ts` | 设备码 + Copilot 内部 token exchange | 解出 proxy endpoint 写进 `baseUrl` |
| `xai.ts` | 纯设备码 | `https://auth.x.ai/oauth2/...` |
| `radius.ts` | 唯一服务发现：`GET /v1/oauth` 拿 `authorizationEndpoint`/`tokenEndpoint`/`clientId`/`scope`/`deviceAuthorizationEndpoint` | `127.0.0.1:1456/oauth/callback` |

公共件：
- `pkce.ts` —— SHA-256+base64url
- `device-code.ts` —— 处理 `pending`/`slow_down`/`expired_token`/WSL 时钟漂移
- `oauth-page.ts` —— 回调成功/失败 HTML

### 1.3 关键点：为什么是 lazy

`packages/ai/src/auth/helpers.ts:34-47` 的 `lazyOAuth(...)` 把动态 `import("./anthropic.ts")` 包起来 —— 这样浏览器 / Vite bundle 不会拽进 `node:http`/`node:crypto`。

Bun standalone 用 `packages/ai/src/bun-oauth.ts` 的 `registerBundledOAuthFlowLoaders` 把动态引用替换为直接引用。

### 1.4 token → 请求 header

`OAuthAuth.toAuth(cred)` 一般直接返回 `{ apiKey: cred.access }`，由 API 实现层判定：

- **Anthropic SDK**：`packages/ai/src/api/anthropic-messages.ts:828-894`，token 含 `sk-ant-oat` 即改走 `Authorization: Bearer <token>` + beta 头 `oauth-2025-04-20` / `claude-code-20250219`
- **Codex**：`packages/ai/src/api/openai-codex-responses.ts:1496-1558`，解码 JWT 取 `chatgpt_account_id` 写 `chatgpt-account-id` header
- **Copilot**：`auth/oauth/github-copilot.ts:372-378`，从 token 解出 proxy endpoint 写 `baseUrl`

### 1.5 刷新策略（双检锁）

`packages/ai/src/auth/resolve.ts:84-118` `resolveStoredOAuth`：

1. 无锁先看一眼是否过期
2. 拿 `credentials.modify` 锁
3. 锁内再读一次（别的请求可能刚 rotate 完）
4. 确实过期才 `oauth.refresh(current, signal)`

`ModelsError` 用 code `"oauth"` 区分刷新失败 vs `"auth"` 存储失败。

### 1.6 持久化

- `InMemoryCredentialStore`（`packages/ai/src/auth/credential-store.ts:8`）—— 测试用
- `AuthStorage`（`packages/coding-agent/src/core/auth-storage.ts:171`）—— `~/.config/.../auth.json`，`proper-lockfile` 文件锁
  - `FileAuthStorageBackend.withLockAsync`（97-145）：stale 检测 + 重试
  - `InMemoryAuthStorageBackend`（148-166）：测试用

---

## 二、Provider 层

### 2.1 `Provider` 接口

`packages/ai/src/models.ts:75-120`

```ts
interface Provider<TApi extends Api = Api> {
  readonly id, name, baseUrl?, headers?;
  readonly auth: ProviderAuth;           // apiKey 和/或 oauth，至少一个
  getModels(): readonly Model<TApi>[];
  refreshModels?(ctx): Promise<void>;
  filterModels?(models, credential): readonly Model<TApi>[];
  stream<T extends TApi>(model, ctx, options?): AssistantMessageEventStream;
  streamSimple(model, ctx, options?): AssistantMessageEventStream;
}
```

没有 `capabilities` 字段 —— 能力差异由 `Model.compat`（`packages/ai/src/types.ts:723-730`，如 `supportsToolSearch` / `thinkingFormat`）在模型粒度描述。

### 2.2 注册：两层

- **工厂级**：`packages/ai/src/providers/all.ts:78-117` `builtinProviders()` 返回 30+ 个 `createProvider({...})` 构造的实例
- **运行时级**：`MutableModels`（`models.ts:189-247`）是 `Map` 注册表；`createModels()`（529-531）建空壳，`builtinModels()`（120-126）塞入 `builtinProviders()`

`createProvider(options)`（`models.ts:533-623`）做两件事：

1. 把 `auth`（`envApiKeyAuth` / `lazyOAuth`）和 `models` / `fetchModels` 拼成一个 `Provider`
2. 处理"一个 provider 多 API"的分发（如 GitHub Copilot 走 anthropic-messages 或 openai-responses）

### 2.3 主要 provider 实现

`packages/ai/src/providers/`

| Provider 文件 | 备注 |
|---|---|
| `anthropic.ts:7-20` | OAuth + API key |
| `openai.ts:6-15` | API key |
| `google.ts:6-15` / `google-vertex.ts` | Vertex 用 ADC，非 OAuth |
| `amazon-bedrock.ts` | 动态 `fetchModels` |
| `kimi-coding.ts:6-15` | API key |
| `openrouter.ts:6-15` | API key |
| `github-copilot.ts:9-34` | **唯一** apiKey + lazyOAuth 双 auth + `filterModels` 收窄 |
| `azure-openai-responses.ts` / `openai-codex.ts` | OAuth 流见 §1.2 |
| `xai.ts` / `groq.ts` / `cerebras.ts` / `deepseek.ts` 等 | OpenAI 兼容 |
| `radius.ts` | 服务发现型 OAuth |
| `faux.ts` | 测试用 mock |

### 2.4 provider 怎么拿到凭据

两条路，都在 `auth: ProviderAuth`（`auth/types.ts:217-220`）里：

- **API key**：`envApiKeyAuth(name, envVars)`（`auth/helpers.ts:9-25`）—— `resolve({ ctx, credential })` 优先取存储的 `credential.key`，否则遍历 env var，否则 `undefined`
- **OAuth**：`lazyOAuth(...)` —— 见 §1.3

GitHub Copilot 是唯一两者都用：env `COPILOT_GITHUB_TOKEN` + OAuth，`filterModels` 用 `credential.availableModelIds` 收窄模型列表（`providers/github-copilot.ts:19-27`）。

### 2.5 请求时拼装 auth

`Models.stream(...)` → `ModelsImpl.applyAuth`（`models.ts:463-487`）：

1. `resolveProviderAuth` —— 存储凭据优先，env 兜底（只在没有存储时）
2. 合并 `auth.headers` 进 `request.headers`
3. 可选覆盖 `baseUrl`
4. 把 resolved `apiKey` 放进 `StreamOptions.apiKey`，由 per-API 实现模块（`packages/ai/src/api/*`）读

### 2.6 **关键边界**：`packages/agent` 完全不引用 `Provider`

`grep "Provider"` 在 `packages/agent/src` 只在 `AgentHarness` 的事件名里出现 —— agent 层只知道 `Models` 这个集合，不知道具体 provider 工厂是什么。一切 auth / model list / streaming 都封装在 `Models` 接口里。

---

## 三、Agent Core 层

### 3.1 `Agent` 类

`packages/agent/src/agent.ts:171`

构造时注入的不是 `Provider`，是一个函数：

```ts
type StreamFn = (model, context, options) => Promise<AssistantMessageStream>
```

`packages/coding-agent/src/core/sdk.ts:289` 的构造（精简）：

```ts
agent = new Agent({
  streamFn: async (model, ctx, opts) => modelRuntime.streamSimple(model, ctx, {
    transformHeaders: ...,
    timeoutMs, websocketConnectTimeoutMs, ...
  }),
  convertToLlm, onPayload, onResponse,
  transformContext,         // 每个 turn 前可改写消息流
  steeringMode, followUpMode,
  ...
})
```

也就是 **"Provider" 概念在 Agent 这里被消解成 `streamFn` + `model`（一个值）** —— `model.provider` / `model.id` 的具体含义只有 `streamFn` 知道。这让 agent core 可以不做修改就接入任何 provider。

### 3.2 主循环 `runAgentLoop`

`packages/agent/src/agent-loop.ts`，伪代码：

```
loop iteration:
  convertToLlm(messages) -> LLM messages
  optional transformContext(messages)
  streamFn(model, context, options)             # <-- 唯一调 provider 的地方
    for event in stream:
      emit message_start / message_update / message_end
  if assistant.tool_calls:
    for each call:
      beforeToolCall({toolCall, args})          # hook 可 block
      tool.execute(args, ctx)                   # AgentTool 接口
      afterToolCall({toolCall, args, result})   # hook 可改写结果
    append toolResult messages
    continue next iteration
  else if queues empty:
    emit agent_end; break
prepareNextTurnWithContext()                     # 刷新系统提示/tools/model/thinking
drain steering/followUp queues
```

入口：

- `agent.prompt(messages)` —— 起新轮
- `agent.continue()` —— 续排队消息
- `agent.steer(msg)` / `agent.followUp(msg)` —— 中途插队
- `steeringMode` / `followUpMode` = `"all"` 或 `"one-at-a-time"`

### 3.3 工具系统

- **类型**：`AgentTool`（`packages/agent/src/types.ts:372`）
  ```ts
  { name, description, inputSchema,
    execute(args, ctx) => ToolResult | AsyncIterator<ToolUpdate> }
  ```
- 调用前 hook：`beforeToolCall` → `{block:true, reason}` 可拦截
- 调用后 hook：`afterToolCall` → `{content?, details?, isError?, terminate?}` 可改写结果

两路注册（在 coding-agent）：

- **内置工具**：`core/tools/{read,bash,edit,write,grep,find,ls}.ts`，`createAllToolDefinitions()`（`tools/index.ts:156`）返回全部七个。每个工具有两件套：`AgentTool` 工厂 + `ToolDefinition` 工厂（后者多 `promptSnippet` / `promptGuidelines` / `sourceInfo`）
- **扩展工具**：`ToolDefinition` 走 extension API（`core/extensions/types.ts:439`）

合并点：`AgentSession._buildRuntime`（`agent-session.ts:2518`）

1. 建内置 + 扩展工具 Map
2. 用 `wrapRegisteredTools(tools, runner)`（`core/extensions/wrapper.ts`）把每个 `AgentTool.execute` 包一层 —— 让 `tool_call` / `tool_result` 扩展钩子能拦住
3. 结果存进 `this._toolRegistry` (`Map<string, AgentTool>`) 和 `this._toolDefinitions` (`Map<string, ToolDefinitionEntry>`)

激活工具：`setActiveToolsByName(names)`（`agent-session.ts:905-920`）——
从 `_toolRegistry` 塞进 `agent.state.tools`，并 `_rebuildSystemPrompt(...)` 把工具说明 + 系统 prompt + skills + context files 重新拼。

钩子挂载：`AgentSession._installAgentToolHooks`（`agent-session.ts:449-497`）——
把 `agent.beforeToolCall` / `afterToolCall` 接到 `extensionRunner.emitToolCall` / `emitToolResult`。

### 3.4 `AgentHarness` vs `AgentSession` —— 两条平行实现

| 维度 | `AgentHarness` | `AgentSession` |
|---|---|---|
| 位置 | `packages/agent/src/harness/agent-harness.ts:164` | `packages/coding-agent/src/core/agent-session.ts:284` |
| 厚度 | 薄"自带电池"参考宿主 | 完整应用外壳 |
| 主循环调用 | `executeTurn`（538-613）**直接调** `runAgentLoop` | 通过 `Agent.prompt` / `Agent.continue` |
| StreamFn | `createStreamFn`（366-392）→ `this.models.streamSimple`，发 `before_provider_request` / `before_provider_payload` / `after_provider_response` 钩子 | 注入 `Agent` 构造时（`sdk.ts:289`）→ `modelRuntime.streamSimple` |
| 适用 | 纯编程场景，不要 AppState/extensions | CLI / SDK 应用场景 |

两条都操作 `Agent` 实例，区别在它们各自造 prompt / 钩子 / 工具的方式不同。

### 3.5 SDK 入口

`packages/coding-agent/src/core/sdk.ts:164` `createAgentSession(options)`：

1. 建服务（`createAgentSessionServices` 给 cwd 绑定的 `ModelRuntime` / `SettingsManager` / `ResourceLoader`）
2. `new Agent({ streamFn: modelRuntime.streamSimple.bind(...), ... })`（289）
3. `new AgentSession({ agent, modelRuntime, sessionManager, extensionRunner, ... })`（371）
4. 返回 `{ session, extensionsResult, modelFallbackMessage }`

`AgentSession.prompt(text, options)`（1093）→ `_runAgentPrompt`（1040）→ `await agent.prompt(...)`，循环 `await agent.continue()` 直到 `_handlePostAgentRun()` 返回 false（处理 retry / 自动压缩 / 排队消息）。

---

## 四、完整数据流（一次 `/login anthropic` 之后的 prompt）

```
TUI /login
  └─> interactive-mode.ts:5223 loginProvider
        └─> modelRuntime.login("anthropic", "oauth", interaction)        [coding-agent]
              └─> Models.login(...)                                       [pi-ai]
                    └─> provider.auth.oauth (lazyOAuth) load -> OAuthAuth
                          └─> OAuthAuth.login
                          │     └─> Anthropic PKCE callback server (127.0.0.1:53692)
                          └─> credentials.modify("anthropic", cred)       [写 auth.json + lockfile]

后续 agent.prompt("hello"):
  AgentSession.prompt -> agent.prompt -> runAgentLoop
    └─> streamFn(model, ctx, opts)
          └─> ModelRuntime.streamSimple -> Models.streamSimple -> Models.stream
                └─> applyAuth -> resolveProviderAuth -> resolveStoredOAuth
                      ├─ 未过期 -> 直接 oauth.toAuth(cred) -> { apiKey }
                      └─ 过期 -> credentials.modify lock -> refresh -> toAuth
                └─> Provider.stream(model, ctx, StreamOptions{apiKey, headers, ...})
                      └─> api/anthropic-messages.ts
                            -> isOAuthToken? Bearer + oauth beta : x-api-key
                            -> SSE 流回 AssistantMessageEventStream
  runAgentLoop 收到流 -> 发 message_* 事件
  有 tool_calls -> tools[name].execute -> afterToolCall hook -> append toolResult -> 下一轮
  无 tool_calls 且队列空 -> agent_end
  AgentSession._handlePostAgentRun -> 视情况再 agent.continue()
```

---

## 五、值得借鉴的设计点

1. **凭据存储唯一写口是 `store.modify(id, fn)`**，所有刷新在锁里完成 —— 避免并发请求争抢同一 token 的刷新
2. **OAuth 用 `lazyOAuth` 动态 import**，把 `node:http` / `node:crypto` 排除出浏览器 / Bun bundle
3. **Agent 不依赖 Provider，只依赖 `StreamFn` + `model` 这个值** —— provider 概念在 agent core 完全消失，使 agent 可脱离 pi-ai 单测
4. **`AgentHarness` 与 `AgentSession` 分立** —— 一个随时可换的薄参考实现 + 一个完整应用外壳，共享同一个 `Agent` 内核
5. **auth 默认优先级**：存储凭据 > env —— env 只在没存储时兜底；删除存储凭据即切回 env
6. **`Model.compat` 表达能力差异**，不在 Provider 上加 `capabilities` —— 每个模型粒度，同 provider 不同 model 可不同

---

## 六、关键 file:line 速查

### OAuth
- `packages/ai/src/auth/types.ts:24-29, 60-88, 189-210` —— `OAuthCredentials` / `CredentialStore` / `OAuthAuth`
- `packages/ai/src/auth/helpers.ts:9-25, 34-47` —— `envApiKeyAuth` / `lazyOAuth`
- `packages/ai/src/auth/resolve.ts:37, 84-118` —— `resolveProviderAuth` / `resolveStoredOAuth`
- `packages/ai/src/auth/oauth/anthropic.ts` —— Anthropic PKCE + 53692 callback
- `packages/ai/src/auth/oauth/openai-codex.ts` —— Codex PKCE 或设备码
- `packages/ai/src/auth/oauth/github-copilot.ts:372-378` —— Copilot token exchange + basesurl
- `packages/ai/src/auth/oauth/xai.ts` —— xAI 设备码
- `packages/ai/src/auth/oauth/radius.ts:54-66, 147-221, 308-353` —— Radius 服务发现 + 双流
- `packages/ai/src/auth/oauth/device-code.ts` —— 通用 RFC 8628 poller
- `packages/ai/src/auth/oauth/pkce.ts` —— PKCE helpers
- `packages/ai/src/bun-oauth.ts:9` —— Bun standalone 注册器
- `packages/coding-agent/src/core/auth-storage.ts:171` —— `AuthStorage` 文件持久化

### Provider
- `packages/ai/src/models.ts:75-120` —— `Provider` 接口
- `packages/ai/src/models.ts:189-247` —— `MutableModels` + Map 注册表
- `packages/ai/src/models.ts:330-354` —— `resolveRefreshCredential`
- `packages/ai/src/models.ts:364-386` —— `checkProviderAuth`
- `packages/ai/src/models.ts:411-453` —— `getAuth` / `login` / `logout`
- `packages/ai/src/models.ts:463-487` —— `applyAuth`
- `packages/ai/src/models.ts:489-527` —— `stream` / `complete` / `streamSimple`
- `packages/ai/src/models.ts:529-623` —— `createModels` / `createProvider`
- `packages/ai/src/auth/types.ts:217-220` —— `ProviderAuth`
- `packages/ai/src/types.ts:34-71, 113-191, 227-230, 450-454, 706-731` —— `KnownProvider` / `StreamOptions` / `ProviderStreams` / `Context` / `Model`
- `packages/ai/src/providers/all.ts:78-126` —— `builtinProviders` / `builtinModels`
- `packages/ai/src/providers/anthropic.ts:7-20`
- `packages/ai/src/providers/openai.ts:6-15`
- `packages/ai/src/providers/google.ts:6-15`
- `packages/ai/src/providers/github-copilot.ts:9-34` —— 双 auth + filterModels
- `packages/ai/src/api/anthropic-messages.ts:828-894` —— Bearer + OAuth beta header
- `packages/ai/src/api/openai-codex-responses.ts:1496-1558` —— JWT accountId
- `packages/ai/src/index.ts:1-7` —— 注意 provider 工厂不导出根，仅在 `providers/*` 子路径

### Agent Core
- `packages/agent/src/agent.ts:171` —— `Agent` 类
- `packages/agent/src/agent-loop.ts` —— `runAgentLoop`
- `packages/agent/src/types.ts:372, 450, 808-812` —— `AgentTool` / `StreamFn` / `AgentHarnessOptions`
- `packages/agent/src/harness/agent-harness.ts:164, 366-392, 406-455, 538-613, 615-679` —— `AgentHarness` 全貌
- `packages/coding-agent/src/core/sdk.ts:164, 289, 371` —— `createAgentSession`
- `packages/coding-agent/src/core/agent-session.ts:284, 449-497, 499-520, 905-920, 1000-1052, 2476-2518` —— `AgentSession` 关键方法
- `packages/coding-agent/src/core/agent-session-runtime.ts:74, 411, 431-438` —— `AgentSessionRuntime` / `createAgentSessionServices`
- `packages/coding-agent/src/core/model-runtime.ts:92, 360, 493` —— `ModelRuntime` / `isUsingOAuth` / `login`
- `packages/coding-agent/src/core/tools/index.ts:138, 156` —— `createCodingToolDefinitions` / `createAllToolDefinitions`
- `packages/coding-agent/src/core/extensions/wrapper.ts` —— `wrapRegisteredTools`
- `packages/coding-agent/src/modes/interactive/components/login-dialog.ts:11-118` —— `LoginDialogComponent`
