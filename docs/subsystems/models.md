# Models、Provider 与 Auth

Models 子系统拥有 provider/model catalog、API wire adapter、credential/OAuth 解析和统一 streaming 入口。Core Agent 只消费 `Model` 与 `StreamFn`，不依赖具体 provider 实现。

源码入口：[`src/models.ts`](../../src/models.ts)、[`src/models-store.ts`](../../src/models-store.ts)、[`src/providers/`](../../src/providers)、[`src/api/`](../../src/api)、[`src/auth/`](../../src/auth)、[`src/storage/auth-storage.ts`](../../src/storage/auth-storage.ts)、[`src/runtime/model-routing/`](../../src/runtime/model-routing)。

## Provider 与 Models registry

`Provider<TApi>` 绑定 provider identity、认证方式、模型集合以及 `stream`/`streamSimple`。一个 provider 可以固定返回生成 catalog，也可以在显式 refresh 时更新进程内 models store。

`Models` 是消费面：列出 provider/model、检查认证、登录/登出、解析有效 credential、refresh catalog 并发起 stream。`MutableModels` 额外拥有 provider 注册与移除；标准 CLI 使用 `builtinModels()` 并加载 canonical home 中配置的 proxy provider。

## 请求路径

```text
Agent StreamFn
  -> Session model request router
  -> selected Model(provider + api + compat)
  -> Models.getAuth()/applyAuth
  -> Provider.streamSimple()
  -> src/api/<wire adapter>
  -> AssistantMessageEventStream
```

API adapter 负责供应商 wire format、SSE/stream 解码、tool/thinking block 转换与 usage/error 归一化。Provider 负责把模型 catalog、认证和 adapter 组合起来；Agent loop 不解释 API-specific response。

## 模型选择与路由

初始选择按显式 CLI override、Session replay、用户 settings 的顺序解析，并先从完整 catalog 取回 `Model`。只有 model id 而没有 provider 时，必须得到唯一匹配；显式 CLI 选择未知或 compatibility policy 拒绝的模型会失败。非显式的 stale replay/settings 选择不可用时，controller 可以从已认证且通过 compatibility preflight 的 `getAvailable()` 结果中选择 fallback。

Session model router 在每个主 Agent 或 child Agent 请求前重新确认请求 identity 与 compatibility profile，并写入 routing receipt。credential 不由 router 验证；随后 `Models.streamSimple()` 在 provider dispatch 前通过 `applyAuth()`/`getAuth()` 解析。模型列表可见不代表当前 credential 已配置；`getAvailable()`、`checkAuth()` 与真实 stream 是不同观察面。

## Credential 与 OAuth

`AuthStorage` 实现 `CredentialStore`，在 canonical `<runledgerHome>/auth.json` 上使用文件锁和限制性权限。credential 值只在 provider 请求时解析；TUI、Session event 和公共 provider status 只接收安全投影，不应记录 token。

OAuth provider 通过 `login()` 完成交互，在过期时经 `CredentialStore.modify()` 串行 refresh。认证来源的固定优先级是受支持的 request API-key override、stored credential、ambient environment；已有 stored credential 但类型不匹配或 OAuth refresh 失败时不会静默回退环境变量。provider auth implementation 只负责被选 API-key 路径内的具体解析，Agent 不自行拼 header。

批准 reverse request 与 credential reverse request 是两个不同协议。前者授权工具副作用，后者承载登录输入；两者都由当前 Session driver 的 TUI adapter 回答，但 credential 不进入 ExecutionGateway receipt。

## Catalog 与生成边界

静态模型资料由 `scripts/generate-models.ts` 及其 source/normalization 模块生成到 provider data 与 `models.generated.ts`。每个 provider 的模型清单只存在于生成的 `src/providers/data/<id>.json`(按 `api` 分组);`src/providers/<id>.models.ts` 只是导入该 JSON 并调用 `src/model-catalog.ts` 的 `flattenModelCatalog` 做类型派生的 shard,不再逐模型枚举 id/api。

动态目录有两种落地语义(见 `createProvider` 的 `dynamicModelsAuthoritative`):provider 端点给出完整目录时启用权威语义,一次成功刷新即替换该 provider 的可见清单,静态基线中被 provider 下线的模型随之消失;端点为精选/部分列表时保持 overlay,刷新结果只增改同 id 条目。刷新失败或空结果都保留上次成功清单。修改 provider 或 catalog 时，应运行 `npm run generate-models` 并审阅生成差异；手改生成文件不能成为新的 source of truth。

动态 catalog 的 last-known-good 状态只在当前 `InMemoryModelsStore` 进程内有效。除非另有明确存储实现，refresh 成功不能宣称跨进程持久化。

## 错误与取消

无 credential、OAuth refresh 失败、未知/歧义模型、router denial、provider timeout、malformed stream 和 caller abort 保留为不同失败来源。router 或 auth 失败发生在 wire request 前；provider stream 中止后由 Agent loop 形成 terminal assistant/agent event。

模型 stream 与遵守该 streaming contract 的 provider request 接收 caller `AbortSignal`。Auth Gateway 客户端断开和 Session interrupt 都应沿各自 streaming path 传播取消，但二者属于不同 composition，不共享 Session owner 或 ledger；这不表示所有 OAuth 或辅助认证请求都绑定同一个 caller signal。

## 稳定边界

- `src/providers/` 的存在不证明真实 credential E2E；provider 可注册、可认证和外部服务当前可用是三项独立事实。
- Model catalog 是发现信息，不是授权信息；Security policy 也不能通过修改 Model object 来表达。
- Auth Gateway 复用 Models/AuthStorage，但它不经过 Agent loop、SessionRuntime 或 Session Store。
