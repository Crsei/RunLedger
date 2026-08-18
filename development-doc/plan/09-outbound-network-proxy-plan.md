# RunLedger 出站网络代理（Outbound Network Proxy）计划

> 状态：`implemented (P0–P5，外部企业代理 smoke 未宣称)`。本文件记录已落地的 oh-my-pi 出站代理路由语义、RunLedger 传输接线矩阵、跨 Node/Bun 适配与本地真实出站证据；真实外部代理凭据/服务验收仍是部署侧门禁。
>
> 基线：RunLedger `session-owner-runtime`，2026-08-19；Plan 09 已分阶段落地（`63e02b6`、`831ddb3`、`4d2b64b`、`a9c7938`），本批收尾路径包含 Google SDK 的 provider-scoped fetch、Bedrock/Codex provider 解析和 Bun 回归。共享 `development-doc/00-index.md`、`docs/architecture.md` 及 Plan 10 文档不属于本计划提交边界。

## 0. 目标与结论

让 RunLedger 全部 10 条 wire transport（`src/api/*.ts`）的出站 HTTP(S)/WebSocket 请求都能走可配置代理，代理选择优先级对齐 oh-my-pi：

```text
RUNLEDGER_PROXY_<PROVIDER>  →  RUNLEDGER_PROXY  →  HTTPS_PROXY/https_proxy 或 HTTP_PROXY/http_proxy  →  ALL_PROXY/all_proxy
```

- `NO_PROXY`/`no_proxy` 在优先级链之前应用；
- 每个 provider 的代理解析按进程生命周期缓存（provider 归一化键 + 目标 URL 归一化键）；
- localhost/loopback 目标绕过代理（现有 `shouldProxyHostname` 已覆盖）；
- 仅支持 HTTP(S) 代理；SOCKS/PAC 继续显式拒绝，不静默降级。
- Node SDK fetch 使用 `node-fetch` + `HttpProxyAgent`/`HttpsProxyAgent`；Bun fetch 使用 `{ proxy }`；Google GenAI SDK 没有公开 fetch/agent 注入点，因此由 `AsyncLocalStorage` 路由 provider-scoped fetch。

非目标：

- SOCKS/PAC 代理、透明代理、每请求代理热切换、代理凭证自动轮换；
- 工具执行环境的代理（`src/security/toolchain.ts` 的 `DENIED_ENV` 已含 `PROXY` 规则，provider 出站代理与工具执行代理互不干扰，本轮不合并、不放开）；
- Browser/Chromium 代理（oh-my-pi `PUPPETEER_PROXY` 类能力）——RunLedger 无内置 browser tool，不复制。

## 1. 参考实现证据

实现阶段必须重新核对以下文件；本表记录当前源码的行为入口，不把行号当作永久 API：

| 行为 | oh-my-pi 参考实现 | RunLedger 现状 |
|---|---|---|
| 优先级链 | `environment-variables.md` §Outbound proxy routing：`PI_PROXY_<PROVIDER>`（provider ID 大写、非字母数字→`_`）→ `PI_PROXY` → `HTTPS_PROXY`/`https_proxy` 或 `HTTP_PROXY`/`http_proxy` → `ALL_PROXY`/`all_proxy`；`NO_PROXY` 先行 | `src/utils/node-http-proxy.ts` 的 `resolveProviderProxyUrl()` 已实现 `RUNLEDGER_PROXY_<PROVIDER>` → `RUNLEDGER_PROXY` → scheme proxy → `ALL_PROXY`，并保留 `ProviderEnv` 优先级 |
| 进程生命周期缓存 | 同上：“Provider proxy lookups are cached for the process lifetime” | `getCachedProviderProxyUrl()` 以 provider key + 归一化目标 URL 缓存命中、直连和解析失败；同一进程内 env 变化不刷新 |
| localhost 绕过 | 同上：“Localhost targets bypass the provider fetch wrapper” | `shouldProxyHostname()` 覆盖 loopback、`*`、`host:port` 和 `*.suffix`，并由 `tests/integration/proxy-integration.test.ts` 真实验证 |
| SDK client 构造点 | — | Anthropic/OpenAI/Azure/Mistral/OpenRouter image client 注入 `fetch`；Google GenAI/Vertex 通过 `provider-fetch-context.ts`；Bedrock 使用 Node HTTP agent；Codex WebSocket 和 REST 分别接入 provider resolver/fetch wrapper |
| 裸 fetch 接线 | — | `fetch-provider-proxy.ts` 接入 `pi-messages`、Codex SSE fallback 与上游 proxy provider 的 catalog/probe |
| ProviderEnv 覆盖 | `ProviderEnv` 是 provider 级 env 覆盖 | `types.ts` `StreamOptions.env` / `ProviderEnv` 与 `utils/provider-env.ts` 继续作为所有接线的 env 入口，含 Bun sandbox fallback |
| 无效代理 URL | 显式报错 | `resolveProviderProxyUrl()` 保留 `Invalid proxy URL ...`，代理构造前不静默直连 |
| 不支持的协议 | — | `UNSUPPORTED_PROXY_PROTOCOL_MESSAGE` 对 SOCKS/PAC 明确拒绝 |

## 2. RunLedger 当前基线与缺口

### 2.1 Dirty worktree 边界

本计划实施期间共享工作树还包含 `development-doc/00-index.md`、`docs/architecture.md` 和 Plan 10 文档等其他任务路径；Plan 09 只拥有本计划文档、代理接线源文件和对应测试。不得 reset、stash、覆盖或宽泛 staging；行号和提交历史仅作定位，行为以 live code 与测试为准。

### 2.2 已有可复用接缝

| 接缝 | 当前能力 | 计划中的复用方式 |
|---|---|---|
| `resolveHttpProxyUrlForTarget`（`utils/node-http-proxy.ts`） | protocol_proxy/all_proxy/no_proxy/ProviderEnv/URL 规范化/SOCKS·PAC 拒绝 | 保留为内部实现；在其上扩展 per-provider 与全局覆盖级 + 缓存 |
| `ProviderEnv` + `getProviderEnvValue` | provider 级 env 覆盖优先于 process.env，含 Bun sandbox fallback | 作为 `RUNLEDGER_PROXY_*` 的注入面；不另造第二个 env 字典 |
| SDK client 构造点 | 每传输集中构造 client | 在每个构造点注入 runtime-aware agent |
| Bun/Node 双运行时 | Codex WS 已用 `{ proxy }` 选项；AWS 用 Node http(s) agent | 新增 `createProxyAgent()` helper 按运行时返回 Node agent 或 Bun fetch `proxy` 选项 |
| `security/toolchain.ts` `DENIED_ENV` | 已含 `PROXY` 匹配 | 保持不变：工具执行 env 继续剥离代理变量 |

### 2.3 关键缺口

1. 计划范围内的 10 条 chat wire 与额外 OpenRouter image client 已接线；Bedrock、Codex WebSocket 的真实外部服务验收仍未宣称。
2. Google SDK 的 scoped fetch 需要一次性的进程级 global fetch router；`AsyncLocalStorage` 保证并发请求按 scope 隔离，但浏览器运行时不在支持范围内。
3. 本地记录型代理已证明真实 Node SDK 与裸 fetch 请求先到代理，未证明代理对真实公网 upstream 的 CONNECT/转发策略。
4. 当前环境没有已配置的 new-api/one-api endpoint、models.json 或可安全使用的外部凭据；不把本地 fixture 当作外部代理 parity。
5. `npm run check` 的 `check:current-format` 仍会把计划文档和网关要求的 `/v1/...` 路由报告为既有扫描器误报；不得通过改扫描器或改用户文档伪造闭合，其他门禁单独记录。

## 3. 冻结的产品与数据合同

### 3.1 代理解析纯函数（`utils/node-http-proxy.ts` 扩展）

```ts
/** 归一化 provider 键：大写、非字母数字→_（对齐 omp `PI_PROXY_<PROVIDER>`）。 */
export function normalizeProviderProxyKey(providerId: string): string; // "github-copilot" → "GITHUB_COPILOT"

/** 单次解析，不缓存。返回 "" 表示该目标不使用代理。 */
export function resolveProviderProxyUrl(
  providerId: string,
  targetUrl: string | URL,
  env?: ProviderEnv,
): string;

/** 进程生命周期缓存包装；键 = (normalizeProviderProxyKey(providerId), normalizedTargetUrl)。 */
export function getCachedProviderProxyUrl(
  providerId: string,
  targetUrl: string | URL,
  env?: ProviderEnv,
): URL | undefined;
```

优先级链（先经 `no_proxy` 判定）：

1. `RUNLEDGER_PROXY_<normalizedProviderId>`
2. `RUNLEDGER_PROXY`
3. `${protocol}_proxy`（https/wss 目标查 `https_proxy`/`HTTPS_PROXY`，http/ws 目标查 `http_proxy`/`HTTP_PROXY`）
4. `all_proxy` / `ALL_PROXY`

规则：

- 无 scheme 的代理值补 `${protocol}://`（复用现有逻辑）。
- 代理值 scheme 为 `socks*`/`pac` → 抛 `UNSUPPORTED_PROXY_PROTOCOL_MESSAGE`。
- 代理值不是合法 URL → 抛 `Invalid proxy URL ...`，不静默直连。
- 缓存语义：进程生命周期；同一 (provider, 目标) 首次解析后不再读 env；env 变化不刷新（对齐 omp 文档化行为）。
- `no_proxy` 语义与现有 `shouldProxyHostname` 完全一致（`*`、`host:port`、`*.suffix`、大小写不敏感）。

### 3.2 传输接线矩阵（已按 live code 回填）

| transport | 请求路径（现状） | 计划接线方式 |
|---|---|---|
| `anthropic-messages` | `new Anthropic` SDK | `createProxyFetchForUrl()` 注入 `fetch`；Node 生产路径使用 `node-fetch` + target-matched agent |
| `openai-completions` / `openai-responses` / `azure-openai-responses` | `new OpenAI` / `new AzureOpenAI` SDK | 同上；Azure 以解析后的 deployment URL 为目标 |
| `google-generative-ai` | `new GoogleGenAI` SDK，v1.52 无公开 fetch/agent option | `runWithProviderProxyFetch()` 在 `AsyncLocalStorage` scope 内路由 SDK 使用的 global fetch |
| `google-vertex` | `new GoogleGenAI` SDK，custom endpoint 或 location endpoint | 同上，target 使用 custom base URL 或 location-derived Vertex endpoint |
| `mistral-conversations` | `new Mistral` + `HTTPClient` | `HTTPClient({ fetcher })` 注入 scoped fetch |
| `openrouter-images` | `new OpenAI` image client | `fetch` 注入，作为 image API 的额外 client 覆盖 |
| `bedrock-converse-stream` | AWS `NodeHttpHandler` + `HttpProxyAgent`/`HttpsProxyAgent` | provider-scoped resolver；保留 HTTP/1.1 handler 分支 |
| `openai-codex-responses` | Bun WebSocket `{ proxy }` + REST SSE fallback | WebSocket resolver 按 provider；REST 使用 `fetchWithProviderProxy()` |
| `pi-messages` | 裸 fetch | `fetchWithProviderProxy()` 包装 |

`openai-codex-responses` 的 WebSocket 真实连接仍依赖运行时/凭据，当前 focused 证据覆盖 resolver 和 REST；不把 resolver 单测写成真实 WebSocket smoke。

### 3.3 约束

- 代理 URL 内嵌凭证（`user:pass@`）只用于 provider 出站请求；绝不写入工具执行 env、日志、trace 明文或 usage 展示。
- 代理解析失败必须让该请求失败并带明确错误，不能静默直连。
- 不改变认证、用量、重试、超时语义；代理只是传输层接线。
- 不新增配置项（settings/security config 不加 `proxy` 字段）：代理完全由环境变量控制，与 omp 一致。

## 4. 分阶段实施计划

### P0 — 冻结合同（已完成）

**目标**：先冻结优先级链、键归一化、缓存语义和 10 条传输的接线点，避免先写 helper 再返工。

**工作项**：

- 逐条核对 10 条传输的请求路径（SDK client 构造点 / 裸 fetch / WebSocket），把每条的实际接线点、SDK 支持的 agent/fetch 参数名记录回本计划 §3.2。
- 冻结优先级链、`normalizeProviderProxyKey`、缓存键与缓存语义、错误行为。
- 记录 dirty worktree 基线与计划范围；不吸收同目录其他 plan 的未提交改动。

**门禁**：contract review 能逐项回答“哪条传输在哪一行接线、走 agent 还是 fetch 包装、解析失败如何表现”。

**证据**：`63e02b6` 冻结 resolver/cache/error contract；当前 §3.2 对照 live source，Google 的 SDK 限制和 Bun router 边界已补充记录。

### P1 — 纯函数扩展与单测（已完成）

**目标**：把代理解析做成与传输无关的可测试纯函数。

**工作项**：

- 扩展 `src/utils/node-http-proxy.ts`：新增 `normalizeProviderProxyKey`、`resolveProviderProxyUrl`、`getCachedProviderProxyUrl`；现有 `resolveHttpProxyUrlForTarget` 改为调用新解析路径（行为不变）。
- 新增 `tests/utils/node-http-proxy.test.ts`，覆盖：优先级 1→4 全序、per-provider 覆盖全局、全局覆盖标准 env、大小写 env、`no_proxy` `*`/`host:port`/`*.suffix`、localhost 绕过、无 scheme 补全、socks/pac 拒绝、无效 URL 抛错、缓存命中且 env 变化不刷新。

**门禁**：focused Vitest 全绿；`npm run check` 不回归。

**证据**：`tests/utils/node-http-proxy.test.ts` 13 tests 通过；覆盖优先级、缓存、NO_PROXY、localhost、无效 URL 与不支持协议。

### P2 — SDK 传输 agent 注入（已完成，Google/Bun 有额外边界）

**目标**：让 SDK 类传输在 Node 与 Bun 运行时下都实际走代理。

**工作项**：

- 新增 `src/utils/proxy-agent.ts`：`createProxyAgentForUrl(targetUrl, proxyUrl)`，按 `process.versions.bun` 探测运行时——Node 返回 `http(s).Agent`（复用 `http-proxy-agent`/`https-proxy-agent` 依赖），Bun 返回 `{ proxy: proxyUrl }` fetch 选项形状；`baseFetch` 让 scoped Bun fetch 不递归进入 router。
- 在 `anthropic-messages.ts`、`openai-completions.ts`、`openai-responses.ts`、`azure-openai-responses.ts`、`google-generative-ai.ts`、`google-vertex.ts`、`mistral-conversations.ts`、`openrouter-images.ts` 的 client 构造点注入；每个传输从 `options.env` 取 per-provider 代理，走 `getCachedProviderProxyUrl(provider.id, baseUrl, options.env)`。
- 新增 `tests/api/<transport>-proxy.test.ts`（每个接线传输一个）：注入 `RUNLEDGER_PROXY` / `RUNLEDGER_PROXY_<PROVIDER>` / `no_proxy` fixture，验证构造出的 client 携带 agent/proxy 配置（不发起真实请求）。

**门禁**：focused Vitest 全绿；`npm run check`。

**证据**：`831ddb3` 加入 SDK 接线；当前 `tests/api/proxy-injection.test.ts` 6 tests、`tests/api/google-proxy-injection.test.ts` 2 tests、`tests/api/provider-proxy-scope.test.ts` 2 tests、`tests/utils/proxy-agent.test.ts` 4 tests、Node `provider-fetch-context.test.ts` 1 test 通过；`bun test --timeout 1000 tests/utils/provider-fetch-context.bun.test.ts` 1 test 通过。测试覆盖 Google GenAI/Vertex 本地代理真实响应、Node 并发 scope 隔离和 Bun scoped fetch 不递归。

### P3 — 裸 fetch 传输包装（已完成）

**目标**：让裸 fetch 传输统一走代理。

**工作项**：

- 新增 `src/utils/fetch-provider-proxy.ts`：`fetchWithProviderProxy(providerId, input, init, env)`，内部调用 `getCachedProviderProxyUrl`；Node 注入 agent，Bun 注入 `{ proxy }`。
- 接线 `pi-messages.ts` 及 P0 核对后确认的裸 fetch 模块（含 `openai-codex-responses` REST 部分）。
- 单测：mock fetch 验证代理目标注入与 `no_proxy` 直连。

**门禁**：focused 测试全绿；`npm run check`。

**证据**：`4d2b64b` 接入 `pi-messages` 与 Codex SSE；`tests/utils/fetch-provider-proxy.test.ts` 2 tests、`tests/api/fetch-proxy-injection.test.ts` 2 tests 通过；上游 proxy provider catalog/probe 复用同一 wrapper。

### P4 — 集成与本地真实代理 smoke（已完成；外部代理未宣称）

**目标**：证明实际出站请求经过代理，而不是 fixture-only 接线。

**工作项**：

- 用本地记录型 HTTP proxy server 验证一条 OpenAI SDK 请求和一条 `pi-messages` 裸 fetch 请求确实先到 proxy；`RUNLEDGER_PROXY` 与 `RUNLEDGER_PROXY_<PROVIDER>` 各验证一次。该 fixture 返回响应，不宣称公网 CONNECT/上游转发成功。
- 验证 `NO_PROXY=*` 直连与 localhost 直连。
- 运行既有 provider/api focused 测试确认无回归。

**门禁**：真实代理记录证据、focused + `npm test`、`npm run check`、`npm run build`、`git diff --check` 全部分开记录；任何既有无关 blocker 单独标识。

**证据**：`a9c7938` 的 `tests/integration/proxy-integration.test.ts` 4 tests 通过，另有 Google 2 tests 通过；本地 proxy 观察到目标绝对 URL、认证头和 NO_PROXY/localhost 直连。当前环境无可安全使用的 new-api/one-api 服务与凭据。

### P5 — 文档与收尾（本批完成）

**目标**：环境变量契约进入仓库文档，状态表闭合。

**工作项**：

- 在本计划记录环境变量表：`RUNLEDGER_PROXY_<PROVIDER>`、`RUNLEDGER_PROXY`、标准 `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY`、缓存与 localhost 语义；`streamProxy` 仍是浏览器→后端执行代理，未与本计划混用。
- `AGENTS.md` 的能力条目和共享索引变更保留为独立工作树路径；本计划不把其它任务的 dirty hunk 带入提交。

**门禁**：文档与实现一致；状态表更新为实际证据状态。

## 5. 测试与证据矩阵

| 层级 | 必须覆盖 |
|---|---|
| pure unit | 优先级全序、per-provider/global/标准 env 覆盖、大小写、no_proxy `*`/端口/后缀、localhost、无 scheme 补全、socks/pac 拒绝、无效 URL、缓存不刷新 |
| per-transport | 8 个 SDK/image client、裸 fetch、Bedrock/Codex resolver 接线；Google 另有 SDK 真实本地 proxy 响应 |
| integration | 本地记录型代理下真实出站经过代理；`NO_PROXY=*` 直连；localhost 直连 |
| regression | focused/full `npm test`、`npm run build`、`git diff --check`；`npm run check` 需单独标记 `check:current-format` 既有误报 |

禁止用以下证据替代真实链路：只 mock fetch 字符串、只验证 helper 返回值不验证传输接线、只用 SDK 默认直连跑集成测试、或把 env 缺失当作“无需代理”。

## 6. 文件范围与执行纪律

预期实现范围（以 P1–P4 开始前的 live code 为准）：

- Modify：`src/utils/node-http-proxy.ts`、`src/api/anthropic-messages.ts`、`src/api/openai-completions.ts`、`src/api/openai-responses.ts`、`src/api/azure-openai-responses.ts`、`src/api/google-generative-ai.ts`、`src/api/google-vertex.ts`、`src/api/mistral-conversations.ts`、`src/api/openrouter-images.ts`、`src/api/pi-messages.ts`、`src/api/openai-codex-responses.ts`、`src/api/bedrock-converse-stream.ts`、`src/utils/proxy-agent.ts`
- Create：`src/utils/fetch-provider-proxy.ts`、`src/utils/provider-fetch-context.ts`、`tests/utils/node-http-proxy.test.ts`、`tests/utils/provider-fetch-context.test.ts`、`tests/utils/provider-fetch-context.bun.test.ts`、`tests/api/*-proxy.test.ts`
- Docs：本计划；共享 `AGENTS.md`/`development-doc/00-index.md` 只作独立路径审阅，不在本批强行合并

纪律：

- 每个 P 阶段独立提交（`feat(proxy): ...`），不混入其他领域改动。
- 代理解析失败不降级为直连；测试必须显式断言失败路径。
- 不修改 `security/toolchain.ts` 的 `DENIED_ENV`；不新增 settings/security config 字段。
- 不因某个 SDK 不支持 agent 注入而放弃该传输——改用其支持的 fetch 注入点；都不可用则在 P0 记录为 blocked 并单独标识。

## 7. 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 合同冻结 | implemented | `63e02b6`；§3.2 已按 live code 回填 |
| P1 纯函数 | implemented | `tests/utils/node-http-proxy.test.ts`：13 passed |
| P2 SDK 注入 | implemented | SDK/Google focused 14 tests + Node scope 1 + Bun scoped-fetch 1 test passed |
| P3 fetch 包装 | implemented | fetch focused 4 tests passed |
| P4 集成 smoke | implemented (local) | `tests/integration/proxy-integration.test.ts` 4 tests + Google local proxy 2 tests passed；external new-api/one-api unavailable |
| P5 文档收尾 | implemented (plan-local) | 本文状态/evidence/caveats 已回填；共享 index/AGENTS dirty path 不在本批提交 |
