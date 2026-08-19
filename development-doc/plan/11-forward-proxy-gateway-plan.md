# RunLedger 自建正向代理（Forward Proxy Gateway）计划

> 状态：`implemented (P0–P5)`。本文件记录已落地的 oh-my-pi `auth-gateway` 前向代理语义、RunLedger 路由/编码/认证合同、实现边界与验收证据；auth-broker 等 P6 后续项仍未实现。
>
> 实施基线：RunLedger `session-owner-runtime` / `3fc4052`，2026-08-19；计划 11 的实现提交为 `f21ee1b`（server/auth/CLI shell）、`2678fb4`（wire codecs）、`3fc4052`（model dispatch），本次提交补齐 graceful close、真实 CLI HTTP smoke 与状态回填。工作树中 `development-doc/00-index.md`、计划 09/10、`docs/architecture.md` 的既有改动不属于本计划提交。

## 0. 目标与结论

新增 `runledger auth-gateway serve`：一个 HTTP 前向代理，接受 OpenAI Chat Completions、Anthropic Messages、OpenAI Responses 与 RunLedger 原生 wire 的流式请求，按 `model` 字段解析模型，经现有认证层解析凭证，走既有 `src/api/*` transport 派发，再把结果编码回入站 wire 格式（SSE）。客户端（容器化 runledger、llm-git 类工具、CI）永远看不到 access token。

```text
gateway 客户端
  POST /v1/chat/completions | /v1/messages | /v1/responses | /messages（原生）
        ↓  model 字段解析 → models collection 查模型
        ↓  resolveProviderAuth（本地 CredentialStore，含 OAuth 刷新）
        ↓  models.stream / streamSimple 派发
        ↓  编码回入站 wire（SSE）
api.anthropic.com / api.openai.com / …（上游）
```

- 无原始透传路径：所有路由都过 RunLedger provider 逻辑（对齐 omp：credential shaping、OAuth refresh-on-auth-error、provider quirks 集中在 `pi-ai` 侧）。
- 除 `/healthz` 外所有端点要求 bearer token（`<config-dir>/auth-gateway.token`，`0600`）；`--no-auth` 仅供 loopback。
- `idleTimeout` 255s，长 thinking 不被默认超时杀掉。
- 当前范围**不含** auth-broker：gateway 直接用本地 `CredentialStore`（与正常 session 相同的解析路径）；broker（远程凭证库 + 快照流）作为明确后续项。

非目标（当前版本）：

- auth-broker（远程 SQLite 凭证库、SSE 快照、账户池、用量聚合）；TLS 终止（交给 Tailscale/Wireguard/反代，与 omp 一致）；
- `/v1/pi/stream` 的 omp 兼容别名仅作路由别名保留，不实现 pi-native 之外的第二种原生 wire；
- 浏览器/IDE 插件生态、usage 报表 UI、多租户授权。

## 1. 参考实现证据

实现阶段必须重新核对以下文件；本表记录当前源码的行为入口，不把行号当作永久 API：

| 行为 | oh-my-pi 参考实现 | RunLedger 现状 |
|---|---|---|
| gateway 形态 | `auth-broker-gateway.md`：`omp auth-gateway serve` 是 forward-proxy，接受 OpenAI Chat Completions / Anthropic Messages / OpenAI Responses / pi-native stream；model id 读顶层 `model` 字段；解析入站 wire → Context → broker-backed 凭证 → `streamSimple()` 派发 → 重编码（SSE）；无 raw passthrough；`idleTimeout` 255s；除 `/healthz` 外 bearer | `src/auth-gateway/server.ts` 已提供 node:http 服务、鉴权、路由、模型派发、SSE 回编码、请求体上限和 shutdown abort；CLI 入口在 `src/cli/auth-gateway-cli.ts` |
| 原生 wire | pi-native：`POST {baseUrl}/v1/pi/stream`，`{ modelId, context, options, stream }` | RunLedger 原生是 `pi-messages`：`POST {baseUrl}/messages`，`{ model, context, options }`，SSE 返回 assistant-message 事件（`api/pi-messages.ts` 头注释） |
| 凭证解析 | broker-backed `AuthStorage` | `src/auth/resolve.ts` `resolveProviderAuth(provider, credentials, authContext, overrides)`：stored credential 拥有 provider、OAuth 双检锁刷新、api-key/env 解析；`CredentialStore` 接口 + `InMemoryCredentialStore`（`credential-store.ts`），持久化 store 由 app 注入 |
| 模型解析 | bundled `Model<Api>` 匹配 model id | `createModels`（`models.ts`）/ `getModel`；`ApiOptionsMap`（`types.ts`）列出 10 条 wire；`ProviderStreams`（`stream`/`streamSimple`）是统一派发形状 |
| HTTP server 先例 | — | `node:http` `createServer` 用于 OAuth callback；gateway 在 Node-only CLI 边界静态导入 `node:http`，Bun 主路径不导入 gateway CLI。`net.createServer` 用于 `runtime/session-server/owner-probe.ts`、`cli/runtime-host-transport.ts`。无 `Bun.serve` 先例 |
| CLI 先例 | `omp auth-gateway serve/token/status/check` | `src/cli/main.ts` / `cli.ts` / `control-commands.ts` 现有命令路由；`src/cli/runtime-host-*.ts` 是常驻服务先例 |
| 错误映射 | provider 错误 → wire 格式错误体 | `src/utils/error-body.ts`：SDK 错误对象携带 HTTP status 与 raw/parsed body；`ModelsError`（`auth/resolve.ts`）带 `code` |

## 2. RunLedger 当前基线与缺口

### 2.1 Dirty worktree 边界

实施开始时 HEAD 为 `3fc4052`，分支 `session-owner-runtime`。当前验证保留并隔离了 `development-doc/00-index.md`、计划 09/10 与 `docs/architecture.md` 的既有改动；计划 11 只提交网关实现、测试、AGENTS 能力记录和本计划状态回填。

### 2.2 已有可复用接缝

| 接缝 | 当前能力 | 计划中的复用方式 |
|---|---|---|
| `resolveProviderAuth`（`auth/resolve.ts`） | stored credential 拥有 provider；OAuth 双检锁刷新；env 解析 | gateway 逐请求调用，与正常 session 同一解析路径 |
| `CredentialStore` 接口 | `read/list/modify/delete`；`InMemoryCredentialStore` 默认，持久化注入 | gateway 构造时注入持久化 store；不新增第二套凭证存储 |
| `createModels` / `getModel` / `ProviderStreams` | 模型查找 + 统一 `stream`/`streamSimple` 派发 | 模型解析与派发直接复用；不做第二个派发器 |
| `pi-messages` transport | 原生 wire 已实现（`{model, context, options}` → SSE） | gateway 原生路由 `/messages` 直接转发给该 transport 的反向：解码入站 → 走 `models.stream` → 编码回同格式 |
| `node:http` server 边界 | OAuth callback server | gateway server 由 Node-only CLI 路径使用；遵守仓库禁止内联动态 `import()` 的代码规则，不进入 Bun 主路径 |
| `error-body.ts` / `ModelsError` | 状态码 + body 提取、错误 code | 映射到入站 wire 的错误体形状 |

### 2.3 实施后边界

- P1–P3 的 server、token、CLI、四类 codec、模型/凭证派发与 wire 错误映射已落地；P4 的真实 HTTP smoke 使用本地双 wire fixture，未把 fixture 当作外部 provider parity 证据。
- `check --strict` 会对每个已配置 provider 选择一个可用模型执行一次最小文本 completion；响应只返回 provider/model/成功状态，不返回凭证或上游错误正文。
- 当前版本固定请求体上限 4 MiB、HTTP idle timeout 255 秒；没有额外的应用层并发配额，连接背压和 provider stream abort 是当前资源边界，独立并发限流仍属后续工作。
- auth-broker、真实外部 provider 凭据、TLS 终止、多租户和 usage 报表仍按 §3.5/P6 排除。

## 3. 冻结的产品与数据合同

### 3.1 CLI 与进程

```
runledger auth-gateway serve   [--bind host:port] [--no-auth]
runledger auth-gateway token   [--regenerate] [--json]
runledger auth-gateway status  [--json]
runledger auth-gateway check   [--strict] [--json]
```

- `serve` 默认绑定 `127.0.0.1:4000`；启动时确保 `<config-dir>/auth-gateway.token`（`0600`）；`--no-auth` 跳过 bearer 检查（仅 loopback）。
- `token`/`status`/`check` 管理 bearer 与上游凭证健康；`check --strict` 对每个 credential 打 chat 端点，可能消耗少量配额。
- 进程生命周期：SIGINT/SIGTERM 优雅关闭在途流；`idleTimeout` 255s（对齐 omp）。
- 配置：当前版本无专用配置键；token 文件 + CLI flag 足够。`RUNLEDGER_AUTH_GATEWAY_BIND` 可作可选 env（P0 冻结）。

### 3.2 路由与 wire 映射

| 方法/路径 | wire | 解码目标 | 编码来源 |
|---|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions | → `Context` | `Context` → SSE chat.completion.chunk |
| `POST /v1/messages` | Anthropic Messages | → `Context` | `Context` → SSE `message_start`/`content_block_*`/`message_delta`/`message_stop` |
| `POST /v1/responses` | OpenAI Responses | → `Context` | `Context` → SSE response.* 事件 |
| `POST /messages` | RunLedger 原生（pi-messages wire） | → `Context` | `Context` → pi-messages SSE 事件 |
| `POST /v1/pi/stream` | omp 兼容别名 | 同 `/messages` | 同 `/messages`（路由别名，P0 冻结取舍） |
| `GET /healthz` | — | — | 无鉴权 liveness |
| `GET /v1/models` | — | — | catalog 过滤到有凭证的 provider |

- model 解析：入站 `model` 字段支持 `provider/model` 复合 id 与裸 id；未知模型 → wire 形状 4xx。
- 流式：全部 SSE；`Accept: text/event-stream` 缺失时按各 wire 的兼容规则（P0 冻结：一律 SSE 或按 wire 回退非流式）。
- 工具/thinking/usage：入站允许的字段按各 wire 现有 transport 能力；不支持的字段按“忽略未知 + 拒绝已知冲突”规则（P0 冻结）。

### 3.3 认证与安全

- 除 `/healthz` 外所有端点 `Authorization: Bearer <token>`；timing-safe 比较（`crypto.timingSafeEqual`）。
- `--no-auth` 只允许 `--bind 127.0.0.1`（P0 冻结：拒绝非 loopback + no-auth）。
- 凭证永不进入响应体/日志；`resolveProviderAuth` 返回的 `AuthResult` 只用于构造出站请求。
- 请求体大小上限固定为 4 MiB；HTTP idle timeout 固定为 255 秒；当前版本不增加独立应用层并发配额，abort 传播是已实现的资源边界。

### 3.4 错误映射

- `ModelsError.code` → HTTP 状态：`auth`/`oauth` → 401/502、`provider` → 502、`model_source`/`model_validation` → 400/404、`stream` → 502；每个 wire 用自己的错误体形状（Anthropic `{type, error:{type,message}}`、OpenAI `{error:{message,type,code}}`、pi-messages `{error}` 事件）。
- 入站解码失败 → 400 + wire 形状错误体；不 panic、不半写 SSE。

### 3.5 非目标（当前版本明确排除）

- auth-broker 远程凭证库、快照/SSE 同步、账户池、用量聚合、凭证上传/迁移；
- TLS 终止、多租户、RBAC、审计报表；
- 非 SSE 传输、WebSocket 网关。

## 4. 分阶段实施计划

### P0 — 冻结合同（RED 前置）

**目标**：先冻结路由/wire 映射、model 解析、认证、错误映射与当前版本边界。

**工作项**：

- 核对 `createModels`/`getModel` 的 model id 查找语义、`pi-messages.ts` 的完整 SSE 事件集（start/text_delta/thinking_delta/tool_call/done/error 等）、`error-body.ts` 的可用提取字段。
- 核对 gateway 与 session 共享本地 `CredentialStore` 的写锁语义（`modify` 串行化是否跨进程安全；不安全则当前版本只读 + 刷新，写入仍由 session CLI 完成）。
- 冻结 §3.1–§3.5 全部数值与规则；记录 dirty worktree 基线。

**门禁**：contract review 能逐项回答“每条 wire 的解码/编码入口、model 如何解析、未知模型返回什么、401/502/400 如何映射、与 session 凭证库的并发规则”。

### P1 — 服务器骨架 + 认证 + CLI

**目标**：先有可启动、可鉴权、可健康检查的网关外壳。

**工作项**：

- 新增 `src/auth-gateway/server.ts`：Node-only `node:http` server 边界、路由表、bearer 校验（timing-safe）、`/healthz`、`idleTimeout` 255s、优雅退出。
- 新增 `src/auth-gateway/token.ts`：token 文件读写（`0600`）、regenerate、timing-safe 比较。
- 新增 `src/cli/auth-gateway-cli.ts` 并在 `main.ts`/`cli.ts` 注册 `auth-gateway serve/token/status/check`。
- 单测：token 文件权限/regenerate、bearer 校验（合法/非法/大小写）、`--no-auth` 仅 loopback、未知路由 404、`/healthz` 无鉴权。

**门禁**：focused Vitest 全绿；`npm run check`；`npm run build`。

### P2 — 外键 wire 编解码（纯函数）

**目标**：把三条外键 wire 与原生 wire 的双向转换做成无 IO 的可测试函数。

**工作项**：

- 新增 `src/auth-gateway/codecs/chat-completions.ts`、`messages.ts`、`responses.ts`、`pi-messages.ts`：每份导出 `decodeRequest(body) → { model, context, options }` 与 `encodeStream(events) → SSE 行`。
- 复用 `api/*.ts` 已有的正向转换（`transform-messages.ts`、`openai-responses-shared.ts` 等）作为反向参考，不复制第二套 Context 形状。
- 单测：每份 codec 的请求解码（含 tool/thinking/usage 字段）、SSE 重编码（增量事件顺序、done/error 终止、Usage 传递）、未知字段忽略规则、非法请求抛错。

**门禁**：focused 测试全绿；`npm run check`。

### P3 — 派发集成与错误映射

**目标**：网关能查模型、解析凭证、走真实 transport 并回编码。

**工作项**：

- `server.ts` 接通：model 解析（`provider/model` + 裸 id）→ `models.getModel` → `resolveProviderAuth` → `models.stream`/`streamSimple` → codec 编码；`ModelsError` → 状态码 + wire 错误体。
- 凭证 store 注入：构造时传入与 session 相同的持久化 store；P0 冻结的并发规则落地（读 + OAuth 刷新走 `modify`）。
- 集成测试：fake provider streams（复用 `tests/fixtures/` 模式）下四类 wire 全链路；401/400/404/502 映射；abort 传播；未知模型。

**门禁**：集成测试全绿；`npm test`（focused + 相关套件）；`npm run build`。

### P4 — E2E 与真实 TTY/HTTP smoke

**目标**：证明网关是真实可用服务，而不是 fixture-only。

**工作项**：

- 起真实 CLI gateway 进程（测试使用 source CLI + tsx；标准 build/bin smoke 单独验证），用 fetch 依次打四条 wire；有真实凭证的 provider 跑一次真实流式会话，无则用本地 mock provider（显式标记）。
- 验证：bearer 401、未知模型 4xx、SSE 终止事件、`--no-auth` loopback、SIGINT 优雅退出、长 thinking（本地 mock 模拟 >255s 前的心跳）不被杀。
- 验证 gateway 与正常 session 同库并发（同时开一个 session 与 gateway，凭证刷新互不踩踏）。

**门禁**：真实 HTTP 证据（请求/响应记录）、`npm run check`、`npm test`、`npm run build`、`git diff --check`。

### P5 — 文档与收尾

**目标**：命令与 wire 契约进入仓库文档，状态表闭合。

**工作项**：

- 更新 `AGENTS.md`（新增 auth-gateway 能力条目；核对 `// TODO(pi):` 清单与 `streamProxy` 占位不误伤——`streamProxy` 是浏览器→后端执行代理，与本网关正交）。
- 记录 CLI 用法与 wire 表到文档；更新 `development-doc/00-index.md` 状态行。

**门禁**：文档与实现一致；状态表更新。

### P6 — 后续项（不属当前版本）

- auth-broker（远程 SQLite 凭证库、SSE 快照、账户池、用量聚合、`--via=user@host` 登录）；
- `/v1/usage` 与用量缓存（5min jitter + 15s single-flight）；
- 多租户/RBAC/TLS 终止集成示例。

## 5. 测试与证据矩阵

| 层级 | 必须覆盖 |
|---|---|
| pure unit | token 文件/比较、四类 codec 解码与 SSE 重编码、未知字段、非法请求 |
| server unit | 路由、鉴权 401、`--no-auth` loopback 约束、404、healthz、优雅退出 |
| integration | fake provider 全链路四 wire；错误映射 400/401/404/502；abort；未知模型 |
| E2E/HTTP | 真实 serve + curl 四 wire、SSE 终止、长 thinking 心跳、同库并发 |
| regression | `npm run check`、`npm test`、`npm run build`、`git diff --check` |

禁止用以下证据替代：只测 codec 不测 server、只 mock fetch 不跑真实 HTTP、或把 `InMemoryCredentialStore` 当持久化凭证库证据。

## 6. 文件范围与执行纪律

预期实现范围（以 P1–P4 开始前的 live code 为准）：

- Create：`src/auth-gateway/server.ts`、`src/auth-gateway/token.ts`、`src/auth-gateway/codecs/{chat-completions,messages,responses,pi-messages}.ts`、`src/cli/auth-gateway-cli.ts`、`tests/auth-gateway/*.test.ts`
- Modify：`src/cli/main.ts`、`src/cli/cli.ts`（命令注册）、`tests/fixtures/`（fake provider streams 复用）
- Docs：`AGENTS.md`、`development-doc/00-index.md`

纪律：

- 每个 P 阶段独立提交（`feat(auth-gateway): ...`）。
- 所有路由都过 `resolveProviderAuth` + `models.*` 派发；不新增 raw passthrough 路径。
- gateway 的 Node-only server 代码不进入 Bun 主路径；遵守仓库禁止内联动态 `import()` 的规则。
- 凭证永不写日志/响应体；token 文件 `0600`。
- broker 能力不得以“预留字段/半成品路由”形式提前进入当前版本代码。

## 7. 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 合同冻结 | implemented | live code review confirms `Models.getModel/getAuth/streamSimple` dispatch, `pi-messages` event contract, `AuthStorage` file lock; §3 freezes route, auth, error and 4 MiB/255 s values |
| P1 服务器骨架 | implemented | `f21ee1b`; token/server/CLI focused tests; `--no-auth` loopback guard and 0600 token test |
| P2 wire 编解码 | implemented | `2678fb4`; `tests/auth-gateway/codecs.test.ts` covers four decoders and SSE terminal/error encoding |
| P3 派发集成 | implemented | `3fc4052` plus `tests/auth-gateway/dispatch.test.ts`; model lookup, credential resolution, 400/401/404/502 mapping and client/gateway abort |
| P4 E2E smoke | implemented (local fixture) | `tests/auth-gateway/e2e.test.ts` starts a real CLI child and HTTP dual-wire upstream fixture; four input wires, bearer/no-auth, terminal SSE, concurrent auth-file access and SIGINT are covered; no external provider credential is claimed |
| P5 文档收尾 | implemented | this status table and AGENTS §1.2.vc; existing `development-doc/00-index.md` navigation is preserved and not widened into this commit |
| P6 后续项 | deferred | broker 等独立专项 |
