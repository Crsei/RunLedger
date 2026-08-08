# Credential Reverse-Request UI 接线计划（R6 阻塞缺口之一）

> 状态：**implemented（2026-08-08 全量 check/test 通过）**。credential onboarding 已接线（Session `login` 命令 + driver 连接 reverse-request + TUI 渲染 + auth.json 落库）；approval reverse-request 复用同一传输机制，另文/同文附录排期。
> 建立日期：2026-08-07
> 目标分支：`session-owner-runtime`
> 上位计划：[`06-session-owner-runtime-replacement-plan.md`](06-session-owner-runtime-replacement-plan.md) 第 6 节 R6 blocking gaps 的 `approval/credential onboarding 的 reverse-request UI 通道 + durable decision receipt`（未勾选项）。
> 触发问题：`/login` 报 `Login failed: Error: credential onboarding requires a reverse-request UI channel`——`SessionInteractiveController.login()`（`src/cli/session-interactive-controller.ts:148`）是显式 stub。

## 0. 现状事实（已验证）

1. **TUI login 流程**：`InteractiveMode.startLogin()` → `authAdapter`（`src/tui/adapters/interactive-session.ts`）的 `auth.login` effect → `controller.login(providerId, type, interaction)`。
   - `interaction` 是 TUI **本地**注入的 `AuthInteraction`，其 `prompt()` 走 `InteractiveMode.promptAuth()`（`interactive-mode.ts:1330`）渲染 secret/select modal —— **渲染能力已经存在**。
   - 但 `SessionInteractiveController.login()` 是 stub，直接 throw，从不把 login 发给 runtime。
2. **Session 协议已有 reverse-request 基础设施**（未接线到 login）：
   - `SessionRuntimeServer.requestToConnection(connectionId, { kind, body }, timeoutMs)`（`runtime-server.ts:538`）—— 向某连接发 `reverse_request` 帧并等待 `reverse_response`，含 `maxReverseRequestWaiters` 上限与超时。
   - `SessionClientTransport` 构造可选 `reverseRequestHandler(frame, signal)`（`client-transport.ts:15,139-197`）—— 收到 `reverse_request` 调 handler，用返回值回 `reverse_response`。
   - 但 `SessionClientTransport.connect(endpoint.port)`（`session-client.ts:132`）**没有传** `reverseRequestHandler`，所以当前任何 reverse_request 都被回 `{ ok:false, code:"reverse_request_unhandled" }`。
3. **SessionRuntime.handleCommand 没有 `login` 命令**（`session-runtime.ts:408-…`）：只有 prompt/steer/follow_up/clear_queues/provider_status/models/select_model/set_thinking/logout/domain_query/domain_command/recovery_explain。`login` 只能走“客户端直接 throw”。
4. **Server 侧 domain**：`assembleSessionDomain` 创建 `InteractiveSessionController`（`domain.ts:74`），其 `login(providerId, type, interaction)` 调 `models.login(providerId, type, interaction)` + `models.refresh`（`interactive-session-controller.ts:297`）。它接受 `AuthInteraction`，但没有 reverse-request 实现的 interaction 可注入。
5. **凭据持久化**：login 成功后 credential 写入 `AuthStorage`（`~/.runledger/auth.json`），`provider_status` 立即反映 `checkAuth`。credential 本身就是 durable receipt。
6. **驱动连接**：`handleCommand` 已 gate `meta.isDriver`（非 driver 返回 `observer_mutation_forbidden`），且提供 `meta.connectionId`——reverse request 应只发给 driver 连接。

## 1. 目标

让 `/login`（api-key secret 输入、OAuth select、auth_url/info 事件展示）经 Session 协议 reverse-request 在 driver 连接上弹出真实 TUI，完成 credential onboarding 并持久化到 `auth.json`；headless/无 UI 客户端 fail closed。

## 2. 目标数据流

```text
TUI InteractiveMode
  │ /login → startLogin() → authAdapter.auth.login effect
  ▼
SessionInteractiveController.login(providerId, type)      // 替换 stub：发 login 命令
  ▼  (Session protocol: command_request { kind: "login" })
SessionRuntime.handleCommand("login", meta.connectionId)  // 仅 driver
  ▼
domain.controller.login(providerId, type, reverseRequestInteraction)
  │   models.login(...) → interaction.prompt(AuthPrompt) / notify(AuthEvent)
  ▼
SessionRuntimeServer.requestToConnection(driverConnId, { kind: "credential_prompt", body })
  ▼  (reverse_request 帧)
SessionClientTransport.onFrame("reverse_request") → reverseRequestHandler(frame, signal)
  ▼
InteractiveMode.handleCredentialReverseRequest(frame)     // 复用 promptAuth 的 modal
  │  用户输入 / 取消
  ▼  (reverse_response 帧)
requestToConnection 的 Promise resolve → models.login 继续
  ▼
Credential 写入 auth.json → login 命令返回 { ok: true } → TUI “Authenticated …” → 选模型
```

headless 客户端（未注入 handler）：`reverseRequestHandler` 缺省 → `{ ok:false, code:"reverse_request_unhandled" }` → login 返回明确失败，不落库。

## 3. 改动清单

### 3.1 协议层（新增 `login` 命令 + credential reverse-request 载荷）

- **`src/runtime/session-runtime/session-runtime.ts`**：`handleCommand` 新增 `case "login"`：
  - 校验 `meta.isDriver`（沿用现有 gate）、`body.providerId`/`body.authType`（`"api_key" | "oauth"`）。
  - 构造 reverse-request-backed `AuthInteraction`（见 3.2），调 `this.domain.controller.login(providerId, type, interaction)`。
  - 成功返回 `{ ok:true, kind:"login", result: { providers: await controller.getProviderStatuses() } }`（让 TUI 一次拿到新状态）。
  - 失败返回 `{ ok:false, code: <typed>, detail }`（复用现有 `domain_prompt_failed` 的 detail 透传模式）。
- **命令种类**：`login` 是 mutating（写 auth.json），加入 driver-only 集合（`isMutatingKind` / `SESSION_MUTATING_COMMAND_KINDS` 对应位置）。
- **reverse-request 载荷 schema**（新增 `src/runtime/session-server/protocol.ts` 或 `credentials.ts`，用 typebox 定义 + 编解码，风格对齐 `parseApprovalReverseRequest`）：
  - 请求 `reverse_request.body`：`{ kind: "credential_prompt" | "credential_event", body: {...} }`
    - `credential_prompt`：`{ promptType: "secret" | "select", message, placeholder?, options?: {id,label,description?}[] }`（字段对齐 `AuthPrompt`）。
    - `credential_event`：`{ eventType: "info" | "auth_url", message, url? }`（对齐 `AuthEvent`，fire-and-forget）。
  - 响应 `reverse_response.body`：`{ ok:true, value: string }` 或 `{ ok:false, code: "aborted" | "timeout" }`。

### 3.2 Server/domain 层（reverse-request-backed AuthInteraction）

- 新增 `createReverseRequestAuthInteraction(server, connectionId)`（新文件 `src/runtime/session-runtime/credential-reverse-request.ts`）：
  - `prompt(p: AuthPrompt)`：`requestToConnection(connectionId, { kind:"credential_prompt", body: encodePrompt(p) })`；`reverse_response` 解出 `value`（`ok:false` 时 reject 对应 error，供 `classifyLoginError` 出 typed code）。
  - `notify(e: AuthEvent)`：`requestToConnection(connectionId, { kind:"credential_event", body: encodeEvent(e) })`，不等待（catch 忽略）。
  - `signal`：login 整体取消时对未决 prompt reject（`credential_aborted`）。
- **`session-runtime.ts` 的 `login` case** 内创建该 interaction（拿到 `meta.connectionId`），生命周期只覆盖本次 login；不落入 domain 构造（domain 不持有 connection 概念）。

### 3.3 Client 层（下发 reverseRequestHandler + 替换 login stub）

- **`src/runtime/session-server/client-transport.ts`**：`connect(port, options)` 已接受 `SessionClientTransportOptions` 并含 `reverseRequestHandler`（已确认，无需改 transport）。仅需 `session-client.ts` 把 handler 传进来。
- **`src/cli/session-client.ts`**：`SessionClient` 增加可选 `reverseRequestHandler` 选项，`openSession`/`attachDiscovered` → `SessionClientTransport.connect(port, { reverseRequestHandler })`。
- **`src/cli/main.ts`**：`createEmbeddedSessionRuntime(...)` 返回的 handle 已带 transport；在 `new SessionInteractiveController(...)` 前把 InteractiveMode 的 credential handler 通过 `SessionClient` 选项下传（或让 handle 持有带 handler 的 transport）。
- **`src/cli/session-interactive-controller.ts`**：`login(providerId, type, _interaction)` 替换 stub —— 忽略本地 interaction，直接 `this.command("login", { providerId, authType: type })`，返回 `{ type, key }` 形态的 Credential（或按 `provider_status` 反推）。

### 3.4 TUI 层（渲染 reverse-request）

- **`src/tui/interactive-mode.ts`**：新增 `handleCredentialReverseRequest(frame: SessionFrameEnvelope, signal: AbortSignal)`：
  - 解析 `credential_prompt` → 构造 `AuthPrompt` → 复用现有 `promptAuth(prompt, owner)` 渲染 secret/select modal；
  - 用户提交 → 返回 `{ ok:true, value }`；取消 → `{ ok:false, code:"aborted" }`（并 abort 整体 signal）；
  - `credential_event`（info/auth_url）→ `showAuthEvent` / `showNotice`，返回 `{}`。
- **`src/tui/adapters/interactive-session.ts`**：`auth.login` port 从“注入本地 interaction → controller.login”改为“只发 login 命令”（`controller.login(providerId, type)`，interaction 由 server 侧 reverse-request 承担）；移除/弃用 `setAuthInteraction` 本地槽位（reverse-request 取代）。`promptAuth`/`showAuthEvent`/`selectAuthType`/`providerAuthKind` 保留（reverse handler 复用）。

## 4. 边界与 fail-closed

| 场景 | 行为 |
|---|---|
| 无 `reverseRequestHandler`（headless/API client） | login 返回 `{ ok:false, code:"reverse_request_unhandled" }`，不写 auth.json |
| 非 driver 连接发 `login` | `observer_mutation_forbidden`（沿用现有 gate） |
| 用户取消 prompt | `reverse_response { ok:false, code:"aborted" }` → `credential_aborted`，不落库 |
| 单连接 reverse waiter 超上限 / 超时 | 复用 `maxReverseRequestWaiters` / `maxWaitMs`，login 失败且不落库 |
| provider 无交互 login 流（纯 env） | 保持现有 `providerAuthKind` 检测：`${providerId} has no interactive login flow; configure ambient credentials.` |
| login 中途 runtime 状态变化（recovery） | 沿用 `recovery_barrier_active` gate |

## 5. 测试计划

- **协议**：`session-runtime` 新增 `login` 命令单测（注入 stub reverse 端口：prompt 返回固定 value；断言 auth.json 写入 + `provider_status` 更新；无端口/超时/取消/非 driver 的 typed 失败）。
- **client**：`SessionInteractiveController.login` 经 stub transport 验证发送 `login` 命令并透传结果（复用 `tests/cli/session-interactive-controller.test.ts` 的 stub 模式）。
- **TUI reverse handler**：`handleCredentialReverseRequest` 对 secret/select/info/auth_url 帧的解析与返回（纯函数可单测；modal 渲染沿用 `promptAuth`，不需重复覆盖）。
- **集成**：真实 loopback TCP（复用 `tests/runtime/session-server/harness.ts` / `tests/fixtures/session-owner` 组合），TUI 侧 handler 自动应答 → deepseek `models.login` 完成 → `auth.json` 写入 → `provider_status` 显示已配置。
- **负向**：headless 无 handler、非 driver、取消、超时。

## 6. 验收（Acceptance）

- [x] `runledger` → `/login deepseek` 输入 api key → `auth.json` 出现 `deepseek` 凭据 → `provider_status` 显示已配置（真实 TCP 集成测试 `tests/runtime/session-runtime/login-integration.test.ts` 覆盖 wire 全链路 + 落库）。
- [x] 无 UI 客户端调用 `login` 返回明确 fail-closed，不写 auth.json（`credential-reverse-request.test.ts` 覆盖 `reverse_request_unhandled`）。
- [x] `npm run check` 全绿；`npm test` 全绿（含新增测试）。
- [ ] 可选 `deepseek-v4-pro` 并成功发起真实 turn（需真实 API key 与网络，不纳入自动化门禁）。

## 7. 非目标（本计划不包含）

- approval reverse-request 的 decision receipt（同一传输机制，另排期）。
- OAuth 完整浏览器流（auth_url 展示已覆盖；浏览器自动打开/回调监听不在本期）。
- 远程/多客户端 credential onboarding 的并发仲裁（一个 session 同时只有一个 driver）。
