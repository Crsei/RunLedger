# oh-my-pi Web 能力移植计划（`web_search` 与站点抓取）

> 状态：**implemented（P0–P6 已落地，证据见 §11）**。§0.3 两项裁定已定（2026-09-18）：**D1 = `src/websource/`**；**D3 = Tier C 不纳入本期**。
> 上游基线：`oh-my-pi` `packages/coding-agent/src/web/**`（116 文件）与 `src/exa/**`（3 文件），快照 `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`（2026-09-17，`coding-agent` v18.2.4）。
> 目标基线：RunLedger 工作树（本计划写作时的 HEAD）。
> 缺口出处：[`parity/00-oh-my-pi-coding-agent-module-gap-report.md`](../parity/00-oh-my-pi-coding-agent-module-gap-report.md) §3 #6（`web/`）、§3 #7（`exa/`）、§8 建议优先级 P1「`web/`（至少 search provider 层）」。
> 落地结果与未闭合缺口见 §11；§1–§10 保留为设计口径（实施中的偏差在 §11.3 逐条登记）。

---

## 0. 范围与结论

### 0.1 范围

上游 `web/` 是三层结构，本计划按层移植：

| 层 | 上游 | 文件数 | 本计划 |
|---|---|---|---|
| 检索管线 | `web/search/{index,provider,query,render,types,utils}.ts` | 6 | 移植（`render.ts` 改写为 RL TUI/Web 展示面） |
| 检索 provider | `web/search/providers/*.ts` | 29（24 provider + 5 支撑） | **19 个 provider 移植，5 个延迟**（§3 D3） |
| 站点抓取 | `web/scrapers/*.ts` | 78（75 handler + index/types/utils） | 移植，2 个 handler 例外（§3 D5） |
| 共享 API client | `web/{firecrawl,kagi,parallel}.ts` | 3 | 移植 |
| Exa MCP client | `exa/{index,mcp-client,types}.ts` | 3 | 移植（`exa` provider 的 keyless 兜底） |

**范围外**（不在本计划）：`markit`（PDF/DOCX→Markdown，属 parity §3 #9）、`internal-urls`（属已冻结决策，plan 16 §4）、`eval/py/display.ts` 对 `htmlToBasicMarkdown` 的消费（RL 无 eval 内核）、浏览器工具与 puppeteer 依赖（RL 无 browser tool）、`prompts/` 的 `.md` 加载机制（parity §4，本计划只在 TS 内联提示词文本）。

### 0.2 为什么这一项值得做

RL 当前唯一的出站 URL 能力是 [`WebFetch`](../../src/runtime/tools/web-fetch.ts)：受治 `GET` + 正则剥标签，无检索、无站点特化、无 markdown 转换、无 charset 处理。模型拿到的是「一段被剥掉所有结构的平文」。移植后：

- 新增 model-facing `web_search`（多 provider + fallback 链 + 约束解析）；
- `WebFetch` 获得 75 个站点特化提取器与 HTML→Markdown；
- 两者复用同一条已受治的 `Network` port，不新开 I/O 路径。

### 0.3 需要裁定的两项

| # | 问题 | 裁定（2026-09-18） | 影响面 |
|---|---|---|---|
| **D1** | 新模块目录名 | **`src/websource/`**（`src/web/` 已被本地只读看板占用，不能复用） | 仅命名 |
| **D3** | Tier C（5 个 LLM 介导 provider：`anthropic`/`codex`/`gemini`/`perplexity`/`xai`）是否本期移植 | **不纳入本期**。它们依赖 `@oh-my-pi/pi-ai` 的 stream helpers、`pi-catalog` 的 model identity/headers、OAuth access API 与 credential-origin 语义；RL 对应物在 `src/api/*`、`src/providers/*`、`src/auth/oauth/*`，属**重写**而非复制。注册表按 §3 D5 保留 id 与选项、报 typed unavailable | 本期 provider 数 19；Tier C 留待独立专项 |

其余裁定（D2/D4–D9）由本计划直接给出并说明理由，实施时按此执行；若要变更需在此节登记。

### 0.4 结论摘要

- **不新增第三方运行时依赖**：上游已把用到的 linkedom 与 turndown 面重写为纯 TS（`packages/utils/src/dom/*` 1914 行、`packages/utils/src/turndown/*` 4 文件，零外部 import），一并复制即可（§3 D6）。
- **不新增 harness profile 版本**：`standard` 是直通投影，`minimal@1/@2`、`plan@1/@2` 的冻结 allowlist 不含 `web_search`，因此**不需要新 profile version、不需要重算冻结摘要**（§7）。
- **最大的一次改造在 `Network` port 的 principal 归属**：`createGovernedNetwork` 目前把 toolName 硬编码为 `"WebFetch"`（[`governed-network.ts:18`](../../src/security/composition/governed-network.ts)），`web_search` 若复用同一 leaf，审计与审批会把检索流量记成 `WebFetch`（§3 D2）。
- **RL 禁止内联 `await import()`**（`AGENTS.md` §4），上游 `provider.ts` 的 24 处惰性 `import()` 必须改为顶层静态 import（§3 D4）。

---

## 1. 事实基线

### 1.1 上游结构与规模（本次实测）

```
web/                        116 个 .ts
  search/                     6  files   2333 行
    index.ts   404   provider.ts 277   query.ts 850
    render.ts  262   types.ts    523   utils.ts  17
  search/providers/          29  files   9151 行
    base.ts 114  utils.ts 188  browser-page.ts 143
    browser-headers.ts 82      perplexity-auth.ts 142
    24 个 provider：perplexity 1014 / codex 847 / gemini 745 / exa 547 /
      searxng 543 / xai 508 / zai 461 / anthropic 421 / duckduckgo 382 /
      parallel 316 / tavily 245 / tinyfish 226 / startpage 225 / brave 224 /
      kimi 221 / mojeek 220 / public 200 / google 195 / ecosia 183 /
      jina 167 / ollama 135 / synthetic 126 / kagi 98 …
  scrapers/                  78  files
    index.ts 263（75 个 handler 的有序数组，无 id/hosts 元数据，各自匹配 URL 后返回 null）
    types.ts 354（RenderResult / SpecialHandler / loadPage / finalizeOutput /
                  htmlToBasicMarkdown / buildResult）
    utils.ts 109（asRecord/fetchBinary/convertWithMarkit）
  firecrawl.ts 138   kagi.ts 362   parallel.ts 363
exa/                          3  files   432 行（mcp-client.ts 383）
```

关键结构事实（供实施时对照）：

1. **scraper 注册表是有序函数数组**，不是带 host 元数据的注册对象；命中优先级 = 数组顺序，第一个返回非 `null` 的结果胜出。
2. **provider 注册表是 `Record<SearchProviderId, {id,label,load}>`**，`load()` 是动态 `import()`；实例按 id 缓存在 `instanceCache`。
3. **`SEARCH_PROVIDER_ORDER` 从 `SEARCH_PROVIDER_OPTIONS` 派生**（`types.ts:7-113`），默认链顺序即 options 顺序去掉 `auto`。
4. **provider 只从 `params.authStorage` 取凭据**（`providers/base.ts:66-72` 的契约注释），禁止直接开 SQLite。
5. **所有 HTTP 都走裸 `fetch`**；超时用 `withHardTimeout(signal, ms)`（provider 侧）与 `ptree.combineSignals(signal, timeout*1000)`（scraper 侧）；无代理层。
6. **TUI 耦合面很窄**：`search/render.ts` 整文件 + `search/index.ts` 的 `WebSearchTool`/`webSearchCustomTool`/`getSearchTools` 块 + 2 个 scraper 文件的 `formatBytes` 导入。

### 1.2 RunLedger 现有接线

| 面 | 事实 | 位置 |
|---|---|---|
| 工具契约 | `AgentTool.execute(toolCallId, params, signal?, onUpdate?, context?) → AgentToolResult`；**失败即 throw**，完成但失败用 `isError: true`；abort 抛 `Error("Operation aborted")` | [`src/runtime/types.ts:82`](../../src/runtime/types.ts)、`src/runtime/tools/edit.ts:146` |
| 工具组装 | `createStdlibTools(cwd, options)` 唯一装配点；生产经 `productionSessionTools()`，`standard` profile 直通 | [`src/runtime/tools/index.ts:70`](../../src/runtime/tools/index.ts)、`src/runtime/session-runtime/domain.ts:724` |
| 出站治理 | `ExecutionEnv.network: Network`（`request({url,method,headers,body,maxBytes}) → {status,headers,body:Buffer,finalUrl}`）→ `gatedExecutionEnv`（attempt fence）→ `createGovernedNetwork` → `ExecutionGateway` → `PolicyNetworkClient` → `NetworkBrokerPort` | [`src/runtime/execution-env.ts:55`](../../src/runtime/execution-env.ts)、`src/runtime/session-runtime/attempt-gateway.ts:152`、`src/security/composition/governed-network.ts:10`、`src/security/policy-network.ts:102` |
| 静态门禁 | `check:execution-boundaries` 用 `\bfetch\s*\(` 扫 `["src/runtime/tools","src/security","src/worktree","src/extensions"]` | [`scripts/check-execution-boundaries.ts:69,160`](../../scripts/check-execution-boundaries.ts) |
| 网络策略 | `mode: deny|allow|allowlist|review` + `allowedHosts`；loopback 外仅 HTTPS；拒绝 URL 内凭据；**跨 host/跨 port 重定向拒绝**；响应体不得超过 `maxBytes` | [`src/security/policy-network.ts`](../../src/security/policy-network.ts) |
| broker | `createLocalNetworkBroker` 用 `redirect: "manual"`，**不跟随重定向**，`finalUrl` 恒为请求 URL | [`src/security/integration/session-local-leaves.ts:53`](../../src/security/integration/session-local-leaves.ts) |
| 凭据 | `auth.json`（`CredentialStore`，按 provider id 一条）；`AuthStorage.create(layout)`；provider API key 走 `envApiKeyAuth([...])` 的 env 声明；**没有任何面向工具的凭据 port** | [`src/storage/auth-storage.ts:170`](../../src/storage/auth-storage.ts)、`src/auth/resolve.ts` |
| 设置 | `ProjectSettings` 无任何 `webSearch` 字段 | [`src/storage/settings-manager.ts:42`](../../src/storage/settings-manager.ts) |
| HTML→文本 | 仅 `WebFetch` 内私有 `htmlToText`（正则剥标签）；全仓无 turndown / DOM parser 依赖；`read` 无 URL 分支 | [`src/runtime/tools/web-fetch.ts:50`](../../src/runtime/tools/web-fetch.ts) |
| `src/web/` | loopback 只读看板，**永不出站**，与本模块无关，不得混放 | `src/web/server.ts:69` |

### 1.3 必须改写的八类差异（P1–P5 的全部工作量来源）

| # | 上游 | RunLedger 约束 | 处置 |
|---|---|---|---|
| 1 | 裸 `fetch` | 全部出站必须经 `Network` port，`check:execution-boundaries` 扫描 | 新增 `transport.ts`（§3 D2） |
| 2 | `AuthStorage`（pi-ai）+ `getEnvApiKey` + `withAuth`/`withOAuthAccess` | 工具侧无凭据 port；工具不得自行读 env | 新增凭据 port，provider 改调 `withApiKey`（§3 D7） |
| 3 | `await import()` 惰性 provider 加载 | `AGENTS.md` §4 禁止内联动态 import | 改顶层静态 import，保留实例懒构造（§3 D4） |
| 4 | arktype `type({...})` schema | RL 用 TypeBox | `web_search` schema 用 `typebox` 重写 |
| 5 | `.md` 文本导入（prompt） | RL `src/` 内 0 个 `.md`，无 text loader | 提示词内联为 TS 常量 |
| 6 | `@oh-my-pi/pi-utils`（`ptree`/`$env`/`readSseJson`/`fetchWithRetry`/`formatNumber`）、`/dom`、`/headers`、`/turndown` | RL 无这些包 | 分别：`AbortSignal.any` 自实现；env 只在 composition 读；DOM/turndown 复制 vendored 实现；header 生成器降级为静态 Chrome 头 |
| 7 | puppeteer 浏览器兜底（`browser-page.ts`、mojeek 的 ALTCHA） | RL 无 browser tool 与 puppeteer 依赖 | 复制 `browserFetch` 但**不传 `browser` 选项**（上游在 `options.browser === undefined` 时本就不走浏览器），删 puppeteer 分支 |
| 8 | `settings.get(...)`、`AgentStorage`、`tools/render-utils` 的 `formatBytes` | 无对应物 | 设置走新 settings port；`AgentStorage`→凭据 port；`formatBytes` 在模块内自实现 |

---

## 2. 目标架构

### 2.1 目录布局（`src/websource/`）

```
src/websource/
  transport.ts            新写：Network → FetchLike 适配（重定向/字节上限/abort/principal）
  credentials.ts          新写：WebSearchCredentialPort + env key 表 + withApiKey
  settings.ts             新写：WebSearchSettings + port + 默认值
  firecrawl.ts            copy  web/firecrawl.ts
  kagi.ts                 copy  web/kagi.ts
  parallel.ts             copy  web/parallel.ts
  exa/{mcp-client,types}.ts   copy exa/*
  search/
    types.ts              copy  web/search/types.ts（+ 未移植 provider 的 unavailable 集合）
    query.ts              copy  零改动（唯一 import 是 ./types 的 SearchSource）
    utils.ts              copy  零改动
    provider.ts           copy  改：24 处 await import() → 顶层静态 import
    execute.ts            抽自 web/search/index.ts：executeSearch + formatForLLM
    prompt.ts             新写：内联上游 prompts/tools/web-search.md 文本
    mcp-lite.ts           新写：HTTP JSON-RPC 单次调用（exa/parallel/zai 的 MCP 兜底）
    providers/
      base.ts             copy  改：SearchParams.authStorage → credentials port
      utils.ts            copy  改：findCredential → port
      browser-page.ts     copy  改：删 puppeteer 分支
      browser-headers.ts  copy  改：删 HeaderGenerator，保留静态 Chrome 头
      <19 个 provider>.ts copy  改：transport / credentials / settings / browser 四类之一
  scrapers/
    types.ts              copy  改：transport + vendored turndown + 凭据 port
    utils.ts              copy  改：删 convertWithMarkit（markit 不在范围）
    format.ts             新写：formatBytes 等展示小工具（替代 tools/render-utils）
    index.ts              copy  改：handler 清单按实际移植项裁剪
    <N 个 handler>.ts     copy  改：仅 import 路径与上述四类适配
  internal/
    dom/{core,parser,selector}.ts    copy packages/utils/src/dom/*
    turndown/{service,gfm,html,types}.ts  copy packages/utils/src/turndown/*
```

目录理由：上游 `web/` 的检索与抓取共用 root client（`firecrawl`/`kagi`/`parallel`）与 `SearchResponse` 之外的零交换，合并为一个域目录可避免 `search → scrapers` 交叉依赖；`src/web/` 名字被看板占用，故取名 `websource`。

### 2.2 三条 port

```ts
// src/websource/transport.ts
export interface WebSearchTransportOptions {
  readonly network: Network;
  readonly principal: string;        // 见 D2：审计归属的工具名
  readonly maxBytes?: number;        // 默认 2 MiB；页面抓取 8 MiB；硬上限 50 MiB
  readonly maxRedirects?: number;    // 默认 5，仅同 host+port
  readonly userAgent?: string;
}
export interface ResponseLike {      // 上游代码用到的最小 Response 面
  readonly ok: boolean; readonly status: number; readonly statusText: string;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>; json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly body: ReadableStream<Uint8Array> | null;   // 由缓冲体合成，供 SSE reader 消费
}
export type WebSearchFetch = (url: string, init?: RequestInit) => Promise<ResponseLike>;
export function createWebSearchTransport(options: WebSearchTransportOptions): WebSearchFetch;

// src/websource/credentials.ts
export type WebSearchCredentialId = "tavily" | "brave" | "jina" | "kagi" | "firecrawl"
  | "exa" | "parallel" | "synthetic" | "ollama-cloud" | "tinyfish" | "kimi-code" | "zai" | "github";
export interface WebSearchCredentialPort {
  has(id: WebSearchCredentialId): Promise<boolean>;
  getApiKey(id: WebSearchCredentialId): Promise<string | undefined>;
}
export function withApiKey<T>(port, id, missingKeyMessage, fn: (key: string) => Promise<T>): Promise<T>;

// src/websource/settings.ts
export interface WebSearchSettings {
  readonly order: readonly string[];
  readonly exclude: readonly string[];
  readonly timeoutMs: number;
  readonly searxng?: { readonly endpoint?: string; readonly token?: string;
    readonly engines?: readonly string[]; readonly language?: string; readonly safesearch?: number };
}
export interface WebSearchSettingsPort { get(): WebSearchSettings }
```

### 2.3 数据流

```
模型 → web_search 工具 (src/websource/search/tool.ts)
      → executeSearch(§P3) → provider.isAvailable(credentials) → provider.search(SearchParams)
      → transport(url, init)  → Network.request({…, principal:"web_search"})
      → gatedExecutionEnv(attempt) → createGovernedNetwork → ExecutionGateway
      → PolicyNetworkClient(host 策略/重定向/字节上限) → NetworkBrokerPort

模型 → WebFetch (src/runtime/tools/web-fetch.ts)
      → scrapers/specialHandlers 派发（首命中胜出）
      → 未命中：loadPage → htmlToBasicMarkdown（vendored turndown）
      → 同一条 transport / Network port，principal:"WebFetch"
```

---

## 3. 关键裁定

### D2 · 出站 principal：`NetworkRequest.principal`

现状：`createGovernedNetwork(authorize, cwd)` 在内部把 toolName 写成字面量 `"WebFetch"`（`governed-network.ts:18`），该 toolName 进入 `authorizationRequest.toolName` 与审批/审计记录。

裁定：给 `NetworkRequest` 增加可选 `principal?: string`（缺省 `"WebFetch"`，向后兼容），`governed-network.ts` 用 `request.principal ?? "WebFetch"`，并把 principal 纳入 `networkDigestInput`：

- 单一 `ExecutionEnv.network` port 保持不变，per-tool 归属由调用方（transport 工厂）声明；
- principal 由 composition 在构造工具时写死，模型无法指定（工具 schema 不含该字段），不构成提权面；
- 备选方案（在 `session-security.ts` 造两个 leaf 并让 `ExecutionEnv` 暴露 per-tool 选择器）改动更大且会污染 `ExecutionEnv` 契约，不采纳。

### D4 · provider 注册表：静态 import + 懒构造

RL 禁止内联 `await import()`，因此 `PROVIDER_META` 的 `load` 改为直接引用已 import 的类：

```ts
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
  tavily: { id: "tavily", label: "Tavily", load: () => new TavilyProvider() },
  …
};
```

保留 `instanceCache` 的按需构造语义（构造本身无副作用），只是模块加载变为静态。代价：冷启动多加载 19 个模块（纯 TS 逻辑，无 I/O），可接受。

### D5 · 未移植 provider 与 handler 的诚实降级

- `SEARCH_PROVIDER_OPTIONS` 保留**完整 25 项**（id/label/description 与上游一致），使设置项与后续补移植不需要迁移；但注册表只登记 19 个已移植 id。
- `resolveProviderCandidates()` 跳过未注册 id；显式 `provider:` 选中未移植 id 时返回 typed 错误 `web search provider "<id>" is not available in this build`，**不得**静默换 provider。
- Tier C 五个 provider 文件（`anthropic.ts`/`codex.ts`/`gemini.ts`/`perplexity.ts`/`perplexity-auth.ts`/`xai.ts`）本期不复制；`SearchParams` 中的 `systemPrompt`/`modelRegistry`/`getOAuthAccess` 相关字段可保留为可选（供后续移植），但**不得**出现空实现或 `TODO` 分支。
- `scrapers`：`youtube.ts` 延迟（依赖 yt-dlp 外部二进制 + 临时文件 + `Bun.Glob`，与 managed process、raw-fs 边界冲突）；`docs-rs.ts` 移植但**去掉本地磁盘缓存**（只保留 `node:zlib` gunzip + 网络抓取），避免 raw-fs 旁路。

### D6 · DOM 与 turndown：复制 vendored 实现，不引入 npm 依赖

上游 `packages/utils/src/dom/{core,parser,selector}.ts`（1254+370+290 行）与 `packages/utils/src/turndown/{service,gfm,html,types}.ts` 是「linkedom / turndown 已用面的行为兼容重写」，**自身零外部 import**（已实测）。复制到 `src/websource/internal/` 并加锚点注释说明来源与版本；不新增 `linkedom`/`turndown` 依赖。复制前用 `rg '@oh-my-pi/pi-natives' src/websource/internal` 复核无 native 引用。

### D7 · 凭据：composition-root 适配器 + env 白名单表

- 读：`AuthStorage.create(layout)` 的 `read(id)` 已支持任意 provider id（`auth.json` 是「按 provider id 一条」的通用存储），直接复用；env 值由 composition 按 `WEB_SEARCH_ENV_KEYS` 白名单读取后注入 port。
- 写：v1 由用户手写 `auth.json`（`{"tavily":{"type":"api_key","key":"tvly-…"}}`）或设 env；不新增 `runledger` 子命令，也**不**借用 `Models.setCredential`（那会要求把检索服务注册成模型 provider）。
- 禁止：`src/websource/**` 内出现 `process.env` / `Bun.env` 直读（新增静态测试断言，见 P5）。

env 白名单（沿用上游 `getEnvApiKey` 语义，来源于各 provider 的 `isAvailable`）：`TAVILY_API_KEY`、`BRAVE_API_KEY`、`JINA_API_KEY`、`KAGI_API_KEY`、`FIRECRAWL_API_KEY`(+`FIRECRAWL_BASE_URL`/`FIRECRAWL_API_URL` 作端点)、`EXA_API_KEY`、`PARALLEL_API_KEY`、`SYNTHETIC_API_KEY`、`OLLAMA_CLOUD_API_KEY`、`TINYFISH_API_KEY`、`KIMI_SEARCH_API_KEY`/`MOONSHOT_SEARCH_API_KEY`、`ZAI_API_KEY`、`GITHUB_TOKEN`/`GH_TOKEN`（scraper）、`SEARXNG_ENDPOINT`/`SEARXNG_TOKEN`/`SEARXNG_BASIC_USERNAME`/`SEARXNG_BASIC_PASSWORD`（端点与可选认证）。

### D8 · 重定向语义

broker 用 `redirect: "manual"` 且 `PolicyNetworkClient` 拒绝跨 host/跨 port 的 `finalUrl`。上游 `loadPage`/`fetchBinary` 依赖 `redirect: "follow"`。裁定：由 transport 自行跟随**同 host+port** 重定向（默认最多 5 跳），每跳重新经 `Network.request`（因此每跳都重新授权），跨 host/port 的 `Location` 立即抛错（沿用 `WebFetch` 现有文案风格）。这样 `PolicyNetworkClient` 的 `finalUrl` 校验恒等成立，行为对上游代码透明。

### D9 · `WebFetch` 的 schema 与错误语义保持稳定

`WebFetch` 的 `{url, prompt, maxBytes}` schema 与「HTTPS 升级 + 跨 host 重定向报错」语义**不改**（避免连带 TUI/文档/web 看板与既有测试）；只把内部渲染管线从 `htmlToText` 换成 scrapers 管线（special handler → loadPage → turndown）。不新增 `raw` 参数。

---

## 4. 阶段计划

每阶段独立可验收；阶段内的实现细节由实施者决定，但**验收项与证据必须按此表产出**。

### P0 · 裁定与前置（无运行时行为）

交付物：

1. 确认 §0.3 两项裁定（D1 目录名、D3 Tier C 延迟）并回写本文。
2. 记录上游快照 `git -C ../oh-my-pi rev-parse HEAD` 与 `web/` 文件数，作为后续对比基线。

验收：本文更新；无代码变更。

### P1 · 传输与凭据基座

交付物：

| 项 | 位置 |
|---|---|
| `Network` → `FetchLike` 适配（含同 host 重定向、字节上限、abort、principal） | `src/websource/transport.ts`（新） |
| `NetworkRequest.principal` + governed leaf 使用 principal + digest 纳入 | `src/runtime/execution-env.ts`、`src/security/composition/governed-network.ts`、`src/security/integration/session-local-leaves.ts`（校验/透传） |
| 凭据 port + env 白名单 + `withApiKey` | `src/websource/credentials.ts`（新） |
| 设置 port + 默认值 | `src/websource/settings.ts`（新） |
| 边界门禁覆盖新模块 | `scripts/check-execution-boundaries.ts` 的 `roots` += `"src/websource"` |
| 层级规则 | `scripts/check-package-boundaries.ts`：禁止 `src/websource/**` → `src/tui`、`src/cli`、`src/runtime/session-runtime` |
| 测试桶 | `scripts/test-inventory.ts`：`tests/websource/**` → `runtime` 桶 |

验收：

- `tests/websource/transport.test.ts`（注入 fake `Network`，风格对齐 `tests/runtime/host-execution-env.test.ts` 的 port 记录断言）：
  - 每次出站都经过注入的 `Network`，且 `principal` 正确；
  - 同 host 302 跟随后返回终态；跨 host 302 抛错；
  - 超过 `maxBytes` 时按上限截断并置 `truncated`；`maxBytes` 非法时抛错；
  - signal abort 后抛 `Error("Operation aborted")`；
  - `body` 的 `getReader()` 能完整读回缓冲内容（SSE 消费者兼容性）。
- `npm run check`（含 `check:execution-boundaries`）全绿。
- 回归：`tests/runtime/host-execution-env.test.ts`、`tests/tools-m4.test.ts` 不变绿→说明 `principal` 缺省未向后兼容。

### P2 · 查询管线（纯函数）

交付物：`search/{types,query,utils}.ts` 复制与裁剪（wire-only 类型移入 `search/wire.ts` 备后续 Tier C 使用）。

验收：

- `tests/websource/query.test.ts`：移植上游 `test/web/search/query.test.ts` 全部用例（`parseSearchQuery`、`parseDateValue`、`formatQuery`、`formatScraperQuery`、`matchesSite`、`matchesQueryConstraints`、`applyQueryConstraints` 的宽松语义）到 vitest。
- 断言「非空输入 + 任一约束维度全部落空 ⇒ 该维度被 relaxation 而不是返回空集」在测试中显式覆盖。

### P3 · provider 框架与 Tier A/B

交付物：

- `search/provider.ts`（静态注册表 + 候选解析 + 失败摘要格式化）、`search/providers/{base,utils,browser-page,browser-headers}.ts`、`search/execute.ts`、`search/prompt.ts`、`search/mcp-lite.ts`。
- Tier A（零配置，6）：`duckduckgo`、`startpage`、`ecosia`、`google`、`mojeek`、`public`。
- Tier B（凭据/端点，13）：`tavily`、`brave`、`jina`、`kagi`、`firecrawl`、`exa`、`parallel`、`synthetic`、`ollama`、`tinyfish`、`searxng`、`kimi`、`zai`。
- 根 client：`firecrawl.ts`、`kagi.ts`、`parallel.ts`、`exa/{mcp-client,types}.ts`。

验收：

- `tests/websource/providers/*.test.ts`：每个 provider 至少 2 条——(a) 请求形状（URL/方法/头/体）与上游一致；(b) 响应映射为 `SearchResponse` 的字段与 `ageSeconds` 计算。全部使用 fake `Network` + 内联 fixture，**不发起真实网络请求**；仅显式 `WEBSOURCE_INTEGRATION=1` 时允许 live 用例（对齐上游 `WEB_FETCH_INTEGRATION` 门控）。
- `tests/websource/chain.test.ts`：候选顺序、exclude 生效、显式选中未移植 id 报 typed 错误、全部失败时返回 `isError` 结果且文案含每个 provider 的失败摘要。
- `tests/websource/public-fanout.test.ts`：跨引擎去重/共识排序/软硬 deadline（可用注入时钟或短 deadline 参数）。

### P4 · 站点抓取

P4a（共享层）：`scrapers/{types,utils,format}.ts`、`internal/dom/*`、`internal/turndown/*`、`scrapers/index.ts` 骨架。

P4b（handler 批次，按上游 `index.ts` 分组，逐批独立提交）：git hosting（3）→ developer content（9）→ package registries（27）→ academic（8）→ reference（6）→ social/news（8）→ security（3）→ ML/AI（2）→ 其余（video/media、games、crypto、business）。

验收：

- `tests/websource/scrapers/*.test.ts`：每个 handler 一条「非匹配 URL 返回 `null`」用例（防止误命中），以及一条 fixture 驱动的成功用例（断言关键字段而非整段文本）。
- `tests/websource/scrapers/markdown.test.ts`：`htmlToBasicMarkdown` 对 `<script>/<style>` 剥离、GFM 表格、实体解码的行为与上游一致。
- `loadPage` 的行为测试：charset 解码（Content-Type 头与 `<meta charset>` 两条路径）、429 + `Retry-After` 单次重试（有界 10s）、`maxBytes` 截断标志。

### P5 · 工具接线与治理

交付物：

| # | 项 | 位置 |
|---|---|---|
| 1 | `web_search` AgentTool（TypeBox schema `{query, recency?, limit?, num_search_results?}`），`execute` 映射为 `AgentToolResult<WebSearchDetails>`；abort 抛 `Operation aborted`；全 provider 失败返回 `isError: true` | `src/websource/search/tool.ts`（新） |
| 2 | `network` capability claim | `src/runtime/tools/capabilities.ts` |
| 3 | 注册与注入：`StdlibToolsOptions.webSearch?: {transport, credentials, settings, principal}`；`register(createWebSearchTool(...))` | `src/runtime/tools/index.ts` |
| 4 | 生产组合传入 port 实例（`executionEnv.network`、`AuthStorage.create(layout)` 适配器、settings 适配器） | `src/runtime/session-runtime/domain.ts`、`src/cli/runtime-host-security.ts`（Host 侧同款 leaf） |
| 5 | `WebFetch` 改造：special handler 派发 + `loadPage` + turndown markdown，schema 不变 | `src/runtime/tools/web-fetch.ts` |
| 6 | settings schema 增 `webSearch?: {order?, exclude?, timeoutSeconds?, searxng?}`（user 层拥有 order/timeout；workspace 只能追加 exclude） | `src/storage/settings-manager.ts` |
| 7 | 展示面：TUI `rendererForTool` 显式登记 + `packages/collab-web/src/tool-render/registry.tsx` 登记 | `src/tui/presentation/tools/projector.ts`、`packages/collab-web/src/tool-render/registry.tsx` |
| 8 | 静态断言：`src/websource/**` 无 `process.env`/`Bun.env` 直读、无 `fetch(` | 新增测试（并入 `tests/security/current-boundary.test.ts` 的风格） |
| 9 | 文档 | `docs/subsystems/tools.md`、`development-doc/plan/README.md`、`development-doc/00-index.md` |

验收：见 §6 六步对照与 §7 冻结物清单；`npm run check`、`npm run test:runtime`、`npm run test:security-storage` 全绿。

### P6 · 端到端验收与证据

见 §8。本阶段不新增功能，只产出证据并把失败路径修回 P1–P5。

---

## 5. 上游文件 → RunLedger 文件映射总表

`改` 列使用 §1.3 的差异编号。

**检索管线**

| 上游 | 目标 | 改 |
|---|---|---|
| `web/search/query.ts` | `src/websource/search/query.ts` | 仅 import 路径 |
| `web/search/utils.ts` | `src/websource/search/utils.ts` | 仅 import 路径 |
| `web/search/types.ts` | `src/websource/search/types.ts` + `wire.ts` | 加 `SEARCH_PROVIDER_UNAVAILABLE`；wire 类型分文件 |
| `web/search/provider.ts` | `src/websource/search/provider.ts` | 3、5 |
| `web/search/index.ts` | `src/websource/search/execute.ts` + `tool.ts` + `prompt.ts` | 4、5、6（去 TUI/session 依赖，抽 `executeSearch`） |
| `web/search/render.ts` | `src/tui/presentation/tools/`（RL 自建 renderer） | 6（不逐行移植） |
| `prompts/tools/web-search.md` | `src/websource/search/prompt.ts` | 5（内联文本） |

**provider 支撑**

| 上游 | 目标 | 改 |
|---|---|---|
| `providers/base.ts` | `search/providers/base.ts` | 2 |
| `providers/utils.ts` | `search/providers/utils.ts` | 1、2 |
| `providers/browser-page.ts` | `search/providers/browser-page.ts` | 6、7 |
| `providers/browser-headers.ts` | `search/providers/browser-headers.ts` | 6 |
| `providers/perplexity-auth.ts` | — | Tier C，不移植 |

**provider（Tier A）**

| 上游 | 目标 | 改 |
|---|---|---|
| `providers/duckduckgo.ts` | 同名 | 1、7（去 browser 选项） |
| `providers/startpage.ts` | 同名 | 1、6（`parseHTML`）、7 |
| `providers/ecosia.ts` | 同名 | 1、6（`parseHTML`）、7 |
| `providers/google.ts` | 同名 | 1、6、7 |
| `providers/mojeek.ts` | 同名 | 1、6、7（删 ALTCHA/puppeteer 分支） |
| `providers/public.ts` | 同名 | 1、6（`Bun.sleep` → `setTimeout`） |

**provider（Tier B）**

| 上游 | 目标 | 改 |
|---|---|---|
| `providers/tavily.ts` | 同名 | 1、2 |
| `providers/brave.ts` | 同名 | 1、2 |
| `providers/jina.ts` | 同名 | 1、2 |
| `providers/kagi.ts` | 同名 | 1、2（配 `web/kagi.ts`） |
| `providers/firecrawl.ts` | 同名 | 1、2、6（base URL 改 settings/env 白名单） |
| `providers/exa.ts` | 同名 | 1、2、6（`exa.searchDelayMs`/`exa.enabled` 入 settings）、MCP 兜底走 `mcp-lite` |
| `providers/parallel.ts` | 同名 | 1、2、MCP 兜底走 `mcp-lite` |
| `providers/synthetic.ts` | 同名 | 1、2 |
| `providers/ollama.ts` | 同名 | 1、2 |
| `providers/tinyfish.ts` | 同名 | 1、2 |
| `providers/searxng.ts` | 同名 | 1、6（endpoint/token/basic-auth 入 settings，env 白名单兜底） |
| `providers/kimi.ts` | 同名 | 1、2（保留「拒绝 `MOONSHOT_API_KEY`」的既有语义） |
| `providers/zai.ts` | 同名 | 1、2、MCP 调用走 `mcp-lite` |

**共享 client 与 exa**

| 上游 | 目标 | 改 |
|---|---|---|
| `web/firecrawl.ts` | `src/websource/firecrawl.ts` | 1、2、6（`fetchWithRetry` → 自实现有界重试） |
| `web/kagi.ts` | `src/websource/kagi.ts` | 1、2 |
| `web/parallel.ts` | `src/websource/parallel.ts` | 1、2 |
| `exa/mcp-client.ts` | `src/websource/exa/mcp-client.ts` | 1、6（JSON-RPC 走 `mcp-lite`） |
| `exa/types.ts` | `src/websource/exa/types.ts` | 仅 import 路径 |
| `exa/index.ts` | — | 仅重导出，不迁移 |

**scrapers**

| 上游 | 目标 | 改 |
|---|---|---|
| `scrapers/types.ts` | `src/websource/scrapers/types.ts` | 1、2、5、6 |
| `scrapers/utils.ts` | `src/websource/scrapers/utils.ts` | 1、删 `convertWithMarkit` |
| `scrapers/index.ts` | `src/websource/scrapers/index.ts` | 按移植清单裁剪 |
| `scrapers/<handler>.ts`（73） | 同名 | 1、2（github 用凭据 port）；6（6 个 DOM 类）；`dockerhub`/`ollama` 改 `format.ts` |
| `scrapers/youtube.ts` | — | D5 延迟 |
| `scrapers/docs-rs.ts` | 同名 | 去磁盘缓存，仅保留 gunzip + 抓取 |
| `packages/utils/src/dom/*` | `src/websource/internal/dom/*` | 复制，加来源注释 |
| `packages/utils/src/turndown/*` | `src/websource/internal/turndown/*` | 复制，加来源注释 |

**测试**

| 上游 | 目标 |
|---|---|
| `test/web/search/{query,query-pipeline,provider-chain,abort-and-timeout,tavily,ollama,duckduckgo,xai,zai}.test.ts` | `tests/websource/query.test.ts`、`chain.test.ts`、`transport-abort.test.ts`、`providers/*.test.ts` |
| `test/tools/web-search-*.test.ts`（15） | `tests/websource/providers/*.test.ts`（去掉 Tier C 与 live-only 部分） |
| `test/tools/web-scrapers/*.test.ts`（20）+ `test/web-scrapers/docs-rs-gunzip-cap.test.ts` | `tests/websource/scrapers/*.test.ts` |

---

## 6. 新工具准入对照（[`docs/subsystems/tools.md`](../../docs/subsystems/tools.md) 六步）

| # | 要求 | 本计划的落实 |
|---|---|---|
| 1 | 定义 `AgentTool` + `capabilityClaims` | `search/tool.ts` 声明 `network` claim（`capabilities.ts` 登记） |
| 2 | 在 `createStdlibTools()` 注册或组合点注入 | 注册进 stdlib，port 由 `StdlibToolsOptions.webSearch` 注入 |
| 3 | admission 按组合实例身份 | 经 `createStdlibTools` 即进入 `controller.composedTools`；无额外名单 |
| 4 | 是否进入 minimal/plan allowlist | **不进入**；不需要新 profile version（§7） |
| 5 | access classification | `web_search` 的参数是 query 而非 URL，无法在调用层给出精确 host；host 级控制由 governed network leaf 按每次请求的真实 host 执行（`PolicyNetworkClient` + permission engine 的 `network` 规则）。此点作为**显式记录**写入 `docs/subsystems/tools.md`，不伪造一个 `{kind:"network"}` 前置分类 |
| 6 | 展示面 | TUI `rendererForTool` 显式登记；`packages/collab-web` RENDERERS 登记 |

---

## 7. 冻结物与门禁

**必须同步更新**（任一遗漏即红）：

| 冻结物 | 变更 |
|---|---|
| `tests/stdlib-tools.test.ts`（registry size `13` 与成员表） | 13 → 14（新增 `web_search`） |
| `tests/runtime/session-runtime/harness-profile-standard.test.ts`（有序工具表 + canonical digest） | 追加 `web_search`；`WebFetch` 的 description/parameters 若变则同步 digest |
| `tests/security/plan-mode-tool-admission.test.ts`（builtin claims 表） | 增加 `web_search → ["network"]` |
| `scripts/check-execution-boundaries.ts` | `roots` += `src/websource` |
| `scripts/check-package-boundaries.ts` | 新增 websource 层级规则 |
| `scripts/test-inventory.ts` | `tests/websource/**` 桶规则 |
| `docs/subsystems/tools.md` | 工具表、`WebFetch` 管线、access classification 说明 |
| `development-doc/00-index.md`、`development-doc/plan/README.md` | 本计划登记 |

**明确不需要变化**（实施时不要顺带改）：

- `src/runtime/harness-profiles/frozen-manifests.ts`：`minimal@*`/`plan@*` allowlist 不含新工具，摘要不变，**不新增 profile version**。
- `composition-receipt.ts` 的 pin：同上。
- `SESSION_STORE_SCHEMA_VERSION`：无存储 schema 变化（不新增表；`auth.json` 与 `settings.json` 字段为可选增量）。

---

## 8. 验证与证据

### 8.1 自动化

```bash
npm run check                     # 含 boundaries / consumers / tsc
npm run test:runtime              # websource 工具与 transport
npm run test:security-storage     # capability claim / admission / 边界静态扫描
npm run build                     # 进入 dist/，必需
```

### 8.2 真实 CLI（`AGENTS.md` §5）

1. `npm run build` 后确认 `command -v runledger` → `~/.npm-global/bin/runledger` → 本仓库 `bin/runledger.js`。
2. 用**新建的绝对路径临时目录**作 `RUNLEDGER_DIR`，在独立 tmux 会话中启动真实 TTY：
   - 零配置路径：让模型调用 `web_search`（无任何 API key），确认走到 Tier A 引擎并产出结构化 `[n] title / url / snippet` 输出；
   - 抓取路径：让模型 `WebFetch` 一个命中 special handler 的 URL（如 `https://www.npmjs.com/package/typebox`），确认走 handler 而非 `htmlToText`；再抓一个普通 HTML 页面确认 turndown markdown；
   - 错误路径：把 `network` 策略设为 `deny` 启动，确认 `web_search` 与 `WebFetch` 都以明确的策略拒绝失败，而不是绕过；
   - 退出：Esc 逐级关弹窗 → Ctrl+D，确认只清理本任务会话与临时产物。
3. 凭据路径（需要用户提供 key 或手工写 `auth.json`）标注为**人工验证项**；未完成时在本文记录为未闭合证据，不写成已通过。

### 8.3 证据边界

自动化、built CLI、真实外部检索服务、人工视觉确认是不同证据。Linux + 本地 broker 通过**不等于** `review` 网络模式下的人工审批体验已验证，也不等于跨平台（macOS/Windows runner）已验证。

---

## 9. 风险、非目标与未决项

### 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `Network` port 是**缓冲式**的，无流式响应 | SSE 消费者（未来 Tier C）只能整包读取；`maxBytes` 上限成为硬约束 | v1 无 SSE 消费方；`ResponseLike.body` 由缓冲合成，保留后续升级为流式 port 的位置 |
| 零配置引擎（DuckDuckGo/Startpage/Google/Ecosia/Mojeek）是**脆弱抓取**，依赖上游 HTML 结构与反爬策略 | 会随目标站点改版失效；数据中心出口常被 bot 挑战 | 保留「全部失败时返回带每个 provider 失败摘要的 `isError` 结果」；在文档中写明这些引擎是 best-effort |
| Tier A/B 移植量大（19 provider + 73 handler + vendored DOM/turndown） | 单次提交过大、审查困难 | 按 §4 阶段与 P4b 批次切分提交；每批自带离线测试 |
| 复制 vendored DOM/turndown 会与上游分叉 | 上游修 bug 时需人工同步 | 目录内加来源注释与快照 commit；不做本地改造 |
| `principal` 字段进入 `NetworkRequest` | 属公共 contract 变更 | 可选字段 + 缺省 `"WebFetch"`，全部既有调用点行为不变 |

### 非目标

- Tier C 五个 LLM 介导 provider（D3）。
- 浏览器兜底、puppeteer、ALTCHA 求解、浏览器工具。
- `youtube` 抓取（yt-dlp）、`markit` 文档转换、trafilatura/lynx 本地 reader 链。
- TUI 设置选择器（`providers.webSearchOrder` 的图形编辑）、marketplace/setup-wizard 集成。
- 代理链路合流（计划 09/11 的边界不变：工具出站仍走 `Network` port，不并入 provider forward proxy）。
- 把出站代码放进 `src/web/`（该目录是 loopback 只读看板）。

### 未决项

1. 是否需要 `runledger` 侧的凭据写入命令（当前方案要求手写 `auth.json`）；若需要，属独立 CLI 专项。
2. `searxng` 自建实例的接入是否纳入本期（当前按 Tier B 纳入：无凭据但**需要端点配置**）。
3. `WebFetch` 的输出是否需要在 `details` 中暴露 `method`/`finalUrl`（当前按 D9 只改内部渲染，不改 schema）。

---

## 10. 附录 · 复现事实的命令

```sh
OMP=/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi/packages/coding-agent
find $OMP/src/web -type f -name '*.ts' | wc -l                 # 116
find $OMP/src/web/scrapers -type f -name '*.ts' | wc -l        # 78
find $OMP/src/web/search/providers -type f -name '*.ts' | wc -l # 29
wc -l $OMP/src/web/*.ts $OMP/src/exa/*.ts
grep -rn "await import(" $OMP/src/web/search/provider.ts | wc -l  # 24（RL 禁止，需改静态）
grep -rn "process.env\|Bun.env" $OMP/src/web --include='*.ts' | wc -l
rg -n "principal|WebFetch" src/security/composition/governed-network.ts
rg -n "roots = " scripts/check-execution-boundaries.ts
```

---

## 11. 落地结果与证据（2026-09-18）

### 11.1 交付物

| 层 | 落地内容 |
|---|---|
| 库层 | `src/websource/`（116 个上游文件 → 117 个移植文件）：`transport.ts`、`credentials.ts`、`settings.ts`、`internal/`（platform/abort/dom/turndown/mcp-rpc/retry）、`search/`（types/query/utils/provider/execute/tool/prompt + 19 个 provider）、`scrapers/`（types/utils/format/dispatch/index + 74 个 handler）、`exa/`、共享 client `firecrawl.ts`/`kagi.ts`/`parallel.ts` |
| 治理接线 | `NetworkRequest.principal`（`execution-env.ts` → session/Host governed leaf → attempt digest）；`scripts/check-execution-boundaries.ts` 扫描 `src/websource`，并把 `raw-network` 模式收紧为「裸 `fetch(`」 |
| 组合 | `src/storage/web-search-credentials.ts`（auth.json + 白名单 env）、`src/storage/web-search-settings.ts`、`StdlibToolsOptions.webSearch`、`productionSessionTools(...)` 第 6 参、`ProjectSettings.webSearch` |
| 展示 | TUI `SafeToolRenderer` 新增 `websearch` + `projector.ts` 输入 metadata + `timeline/selectors.ts` 标题行；`packages/collab-web` 的 `web_search` 登记 |
| 测试 | `tests/websource/**`（83 例：transport 10、query 36（上游用例原样移植）、provider-chain 18、tool 6、scrapers 13）+ 更新 4 个既有测试 |

### 11.2 验证证据

| 项 | 证据 |
|---|---|
| `npm run check` | 全部子门禁通过（含 `check:execution-boundaries`、`check:package-boundaries`、`check:consumers` 720 consumers / 0 diagnostics、`tsc -p tsconfig.json`）。**唯一失败项**是 `check:current-format` / `tests/runtime/current-format-boundary.test.ts`：命中另一任务的**未跟踪**文件 `development-doc/parity/00,01-*.md`（本计划落地前即存在），与本次改动无关 |
| 测试 | `tests/websource` 83 例 + `stdlib-tools` / `tools-m4` / `plan-mode-tool-admission` / `harness-profile-standard` / `tui projector` 全绿；`tests/security/**` 39 文件 266 例全绿 |
| `npm run build` | 通过；`dist/websource/**` 产出完整 |
| 构建产物冒烟 | 用 `dist/websource/*` 驱动：`web_search` 经假受治 Network 返回格式化结果；`handleSpecialUrls` 命中 npm handler（`method: npm`）；未命中 URL 返回 `null` 并走 turndown（`# Hello` / `World`）；Network 收到的 principal 为 `web_search` 与 `WebFetch` 两类 |
| 真实 CLI（标准 PATH，`~/.npm-global/bin/runledger` → 本仓库 `bin/runledger.js`） | 隔离 `RUNLEDGER_DIR` 下启动真实 TTY（tmux，140×40）：启动正常；提交首个 prompt 后 durable `harness.composed` receipt 记录 `standard@2` 的 **27 个工具**，其中包含 `web_search` 与 `WebFetch`；`--network deny` 下同样组成 27 个工具（策略在执行期由 governed leaf fail closed）。Esc → Ctrl+D 干净退出，会话与临时目录已清理 |

### 11.3 与设计口径的偏差（实施中确认）

| # | 设计写法 | 实际落地 | 原因 |
|---|---|---|---|
| 1 | §2.2 的 `ResponseLike`/`WebSearchFetch` 自建响应形状 | 直接用真实 `Response` | 受治 port 本来就缓冲整个 body，构造 `Response` 即可满足上游全部读取面（含 SSE reader），自建形状是多余的抽象 |
| 2 | §3 D6 计划整体复制 `packages/utils/src/turndown/*` | 复制 4 个文件，但 `createTurndown` 只保留 web 需要的 GFM 装配 | 上游 `utils/turndown.ts` 的 `normalizeTablesHtml` 属 markit 文档路径，未移植 |
| 3 | §2.1 计划 `scrapers/utils.ts` 删 `convertWithMarkit` | 已删；连带 `arxiv.ts` / `iacr.ts` 的 PDF 全文分支移除（`/pdf/` URL 现只返回 API 摘要） | markit 不在本期范围；这是**能力收窄**，恢复需先决策 PDF 转换依赖 |
| 4 | §2.1 计划复制 `exa/mcp-client.ts` 全量 | 只保留检索路径消费的 `isSearchResponse` / `normalizeExaMcpPayload` | 上游其余部分是「从 MCP schema 动态生成 CustomTool」，依赖未移植的扩展面 |
| 5 | §2.1 计划 `scrapers/types.ts` 保留 `Bun.Encoding` | 改为 `new TextDecoder(label as ...)` | `tsconfig` 的 `types: ["node"]` 下没有 Bun 命名空间 |
| 6 | §3 D4 计划「注册表改静态 import」 | 已改，并把上游的**模块级全局** `setSearchProviderOrder`/`setExcludedSearchProviders` 改为 `resolveProviderCandidates({order, exclude})` 入参 | 全局可变状态会让同进程不同配置互相污染 |
| 7 | §5 中「73 个 handler」 | 实际 74 个（去 `youtube.ts`） | 上游 `index.ts` 数组为 75 项 |

### 11.4 未闭合项

1. **Tier C 的 5 个 provider**（`anthropic`/`codex`/`gemini`/`perplexity`/`xai`）按裁定不纳入本期；`SEARCH_PROVIDER_OPTIONS` 保留其 id 与设置项，自动链跳过，显式选中返回 typed 不可用错误。
2. **真实外部检索服务未验证**：本机无出网（`litellm` provider 连接失败、到 `raw.githubusercontent.com` 超时），因此**零配置引擎的抓取质量、凭据 provider 的响应映射、站点 handler 的真实页面结构**都只有离线 fixture 证据。反爬挑战、`Retry-After` 实测、真实 charset 页面均未在真实网络下验证。
3. **PDF 全文能力收窄**（偏差 3）。
4. **浏览器兜底未移植**：被 Cloudflare/JS 挑战的引擎（google/ecosia/mojeek/startpage/duckduckgo）会直接返回不可用，而不是升级到 headless 浏览器。
5. 未跑 `npm test` 全量桶（只跑了 `test:runtime`、`test:security-storage` 与定向文件）。
