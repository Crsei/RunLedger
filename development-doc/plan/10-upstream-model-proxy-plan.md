# RunLedger 入上游模型代理（Upstream Model Proxy）计划

> 状态：`implemented (P0–P3；P4 unavailable；P5 plan-local)`。本文件记录已落地的 oh-my-pi `discovery.type: proxy` 语义、RunLedger 自定义 provider loader/factory、双 wire fixture 证据与真实代理缺口；不把 fixture parity 写成 new-api/one-api 真实证据。
>
> 基线：RunLedger `session-owner-runtime`，2026-08-19；P0/P1 已由 `059faf6` 落地，provider/config/fixture 集成由 `896b613` 落地。共享 `development-doc/00-index.md`、`docs/architecture.md` 和 Plan 09 文档不属于本计划提交边界。

## 0. 目标与结论

为 RunLedger 增加“通用上游模型代理”接入能力：一条配置指向同时暴露 Anthropic Messages 与 OpenAI Chat Completions 双 wire 的代理（new-api / one-api / 类似服务），按模型自动探测走哪条 wire，并对齐 oh-my-pi 的自定义 provider 字段（`authHeader`、`disableStrictTools`、`headers`、`apiKey`）。

```yaml
# 目标形态（models.json / 自定义 provider 配置，具体文件位置 P0 冻结）
providers:
  team-proxy:
    baseUrl: https://models.example.com/v1
    apiKey: TEAM_PROXY_API_KEY
    authHeader: true            # 发送 Authorization: Bearer <key>（替代 Anthropic 系 x-api-key）
    disableStrictTools: true    # 代理不支持 strict tool schema 时关闭
    discovery:
      type: proxy               # 双 wire 自动探测
      timeoutMs: 5000
```

- 单条 `baseUrl`（以 `/v1` 结尾）同时适配两条 wire：Anthropic SDK 会剥离末尾 `/v1` 再拼 `/v1/messages`，OpenAI 兼容路径直接用 `/v1/chat/completions`（对齐 omp models.md 语义）。
- provider 级 `api` 可省略：每条模型首次使用时自动探测 wire。
- 动态 catalog 通过现有 `ModelsStore` 恢复/写入；wire 探测结果由 `ProxyWireCache` 按 provider/model 在进程内缓存（成功 5 分钟、失败 10 秒），不宣称跨进程 wire 恢复。

非目标：

- 认证 broker / 凭证代理（见 `11-forward-proxy-gateway-plan.md`，独立专项）；
- 引入新的代理协议或 SDK：仅复用既有 `anthropic-messages` 与 `openai-completions` 两条 transport；
- 为每个上游代理手写 provider 文件：目标是通用配置，不再新增 `src/providers/<name>.ts` 内置文件（现有 68 个内置 provider 保持不动）。

## 1. 参考实现证据

实现阶段必须重新核对以下文件；本表记录当前源码的行为入口，不把行号当作永久 API：

| 行为 | oh-my-pi 参考实现 | RunLedger 现状 |
|---|---|---|
| proxy discovery | `models.md` §Proxy discovery：Anthropic+OpenAI-compatible 代理（new-api/one-api）同 baseUrl 暴露 `/v1/messages` 与 `/v1/chat/completions`；per-model wire 自动探测；provider 级 `api` 可选；单条 `baseUrl`（结尾 `/v1`）两条 wire 都能正确往返 | `src/providers/proxy-discovery.ts` + `proxy-provider.ts` 已按 Anthropic-first、失败再 OpenAI 的 A 规则探测；`api` 省略时由首用探测决定 |
| 自定义 provider 字段 | `providers.md` `team-proxy` 示例：`apiKey` + `authHeader: true` + `disableStrictTools: true` + `discovery.type: proxy` | `parseProxyProviderConfig()` 校验 `baseUrl`、apiKey/env 引用、headers、`authHeader`、`disableStrictTools` 和 timeout；Anthropic authHeader 通过 `AnthropicMessagesCompat`，OpenAI strict 通过 `supportsStrictMode: false` |
| models.json 自定义 provider | 配置驱动注册 | 实际 loader 是 `src/providers/configured-proxy.ts`：只读取用户级 `<RUNLEDGER_DIR>/models.json` 的 `providers` 对象，且当前只接受 `discovery.type: proxy`；CLI 与 resident Host 显式注册，冲突 fail closed；不是通用 models.json loader |
| 双 wire transport | — | 复用既有 `api/anthropic-messages.ts`、`api/openai-completions.ts`；OpenAI 侧既有 `tools: []` 兼容路径保持不变 |
| 动态 catalog 缓存 | — | `createProxyProvider()` 复用 `createProvider.refreshModels()`，通过 `ModelsStore` 恢复/写入 `/v1/models` catalog；wire cache 另为进程内 last-known-good |
| 每 provider 测试模式 | — | 新增 proxy discovery/provider/configured-loader focused tests 与 `tests/fixtures/dual-wire-proxy.ts`；fixture 不是真实 new-api/one-api |

## 2. RunLedger 当前基线与缺口

### 2.1 Dirty worktree 边界

本计划实施期间共享工作树还包含 Plan 09 的代理收尾路径、`development-doc/00-index.md` 和 `docs/architecture.md`；Plan 10 只拥有本计划文档，provider 实现已经在 `059faf6`/`896b613` 中提交。状态和行号以 live code、focused tests 与当前工作树为准。

### 2.2 已有可复用接缝

| 接缝 | 当前能力 | 计划中的复用方式 |
|---|---|---|
| `createProxyProvider`（`providers/proxy-provider.ts`） | 基于 `createProvider` 的通用双 wire 工厂；动态 catalog、auth、probe、dispatch 已接线 | 直接复用，不新增每个上游代理的内置 provider 文件 |
| `openai-completions.ts` | 已处理 Anthropic-via-proxy 的 `tools: []` 兼容（:625） | 作为双 wire 中 OpenAI 侧的行为基线，不动 |
| `anthropic-messages.ts` | Anthropic wire + SDK | 作为双 wire 中 Anthropic 侧；`authHeader` 通过 model compat 选择 Bearer auth |
| `ModelsStore` | 动态 catalog 持久化 | catalog 走 store；wire 选择保留在 `ProxyWireCache` 的进程内 last-known-good |
| `tests/providers/*` | 每 provider focused 测试 | 新 provider 测试沿用同模式；双 wire fixture 用本地 node:http 代理桩 |

### 2.3 关键缺口

计划中上述 5 项缺口已闭合：proxy discovery、authHeader、OpenAI-compatible strict 关闭、用户级 proxy-only models.json loader 与 Anthropic-first wire 探测均有实现和 focused/fixture 证据。剩余缺口是没有真实 new-api/one-api 服务/凭据，以及 wire cache 不跨进程恢复。

## 3. 冻结的产品与数据合同

### 3.1 配置形态（已按 loader 现状回填）

```ts
export interface ProxyDiscoveryConfig {
  readonly type: "proxy";
  /** 探测/首用超时；必须为正有限数。 */
  readonly timeoutMs?: number;
}

export interface UpstreamProxyProviderConfig {
  readonly id: string;
  readonly baseUrl: string;          // 结尾 /v1，两条 wire 共用
  readonly apiKey?: string;          // 字面量或环境变量名（对齐现有 apiKey 语义）
  readonly authHeader?: boolean;     // true → Authorization: Bearer <key>
  readonly disableStrictTools?: boolean;
  readonly headers?: ProviderHeaders;
  readonly discovery: ProxyDiscoveryConfig;
}
```

### 3.2 wire 自动探测合同

- 触发：模型首次被 `stream`/`streamSimple` 引用且未缓存 wire 时。
- 探测顺序与判定（已冻结为 A）：
  - **A（推荐，fail-closed）**：先试 `anthropic-messages`（`POST {baseUrl}/v1/messages` 形状请求），成功 → 锁定 anthropic；401/400 结构不符 → 试 `openai-completions`；两者都失败 → 报错并缓存失败（短 TTL，防每请求重试风暴）。
  - B：按模型 ID 前缀启发式（如 `claude-*` → anthropic），未命中再探测。
- 探测结果缓存：`ProxyWireCache` 是 provider/model 级进程内 Map；成功 TTL 默认 5 分钟、失败 TTL 默认 10 秒，wire 选择不写入 `ModelsStore`。`ModelsStore` 只持久化模型 catalog。
- 单条 `baseUrl` 往返约束：Anthropic SDK base URL 剥离末尾 `/v1` 后由 SDK 请求 `/v1/messages`；OpenAI base URL 保留 `/v1` 并请求 `/chat/completions`。`proxyWireBaseUrl()`/`proxyWireRequestUrl()` 已覆盖两种路径。
- `authHeader: true` 只影响 Anthropic 系 wire 的认证头；OpenAI 系本就 `Authorization: Bearer`，不受影响。
- `disableStrictTools: true` 时，OpenAI-compatible wire 的 tool function 不携带 `strict`；当前 Anthropic wire serializer 本身不发 OpenAI `strict` 字段，因此该开关通过 `OpenAICompletionsCompat.supportsStrictMode` 生效。
- 代理返回的模型列表按 `{baseUrl}/v1/models`（OpenAI 兼容）读取；只取有 `id` 的条目，其余字段按现有 `Model` 默认值合成。

### 3.3 约束

- 不新增内置 provider 文件；只新增通用工厂 + 配置驱动注册。
- 现有 68 个内置 provider 行为不变；`discovery.type: proxy` 是纯增量路径。
- 探测失败不得静默降级为另一条 wire 的“猜测直连”：必须显式报错或按冻结规则回退。
- 与 `09` 计划正交：出站代理（`RUNLEDGER_PROXY_*`）作用于上游代理的 baseUrl 同样有效，不冲突。
- `disableStrictTools`/`authHeader` 缺省 = 现有行为（不改变任何现有 provider）。

## 4. 分阶段实施计划

### P0 — 冻结合同（已完成）

**目标**：先冻结配置字段、wire 探测规则、baseUrl 往返规则与 models.json loader 现状。

**工作项**：

- 核对 models.json 自定义 provider 的加载入口与 schema（`registerProvider`/loader 在 `src/models.ts` 或 CLI/扩展层的实际位置），把现状记录回本计划。
- 核对 `anthropic-messages.ts` 的 tool schema 序列化出口（strict 开关点）与认证头构造点（`x-api-key` vs `Authorization`），确定 `disableStrictTools`/`authHeader` 的冻结修改点。
- 冻结 §3.2 的探测规则（默认 A）与探测缓存 TTL。
- 记录 dirty worktree 基线。

**门禁**：contract review 能逐项回答“配置在哪加载、探测先打哪条 wire、失败如何表现、strict/authHeader 在哪一行生效”。

**证据**：`configured-proxy.ts` 是实际 loader；Anthropic 的 `createClient()` 位于 `api/anthropic-messages.ts`，`authHeader` 由 `model.compat.authHeader` 选择；`openai-completions` 的 strict 出口复用 `supportsStrictMode`。

### P1 — 纯逻辑：wire 探测与配置解析（已完成）

**目标**：把探测判定做成与 transport/HTTP 无关的可测试纯函数。

**工作项**：

- 新增 `src/providers/proxy-discovery.ts`：配置解析（含 env 引用解析）、wire 判定函数 `detectWireForModel(modelId, candidates)`、探测结果缓存（内存 + 序列化形状）。
- 单测覆盖：A 规则全序、结果缓存、失败短 TTL、baseUrl 往返归一化（`/v1` 剥离/拼接）、env apiKey 解析、非法配置拒绝；未采纳 B 的模型 ID 前缀启发式。

**门禁**：focused Vitest 全绿；`npm run check`。

**证据**：`tests/providers/proxy-discovery.test.ts` 8 tests passed；`ProxyWireCache` 的 wire 结果为进程内缓存，不伪称持久化。

### P2 — provider 工厂与 models.json schema 扩展（已完成）

**目标**：让 `discovery.type: proxy` 成为可注册的 provider。

**工作项**：

- 新增 `createProxyProvider()`，复用 `createProvider` 的 catalog/auth/store 骨架，并接通 `authHeader`/`disableStrictTools`/`discovery`。
- 新增 proxy-only `models.json` loader；标准 CLI 与 resident Host 都从 canonical user home 注册，既有 built-in ID 冲突 fail closed。
- `fetchModels` 走 `{baseUrl}/v1/models`（OpenAI 兼容），结果经 `ModelsStore` 持久化。
- 单测：注册 fixture 代理 provider、模型列表读取、stored 恢复、`api` 省略时探测后 dispatch 到正确 transport。

**门禁**：focused 测试全绿；`npm run check`；既有 68 provider 测试不回归。

**证据**：`tests/providers/proxy-provider.test.ts` 5 tests、`tests/providers/configured-proxy.test.ts` 4 tests passed；实现提交为 `896b613`。CLI 初始化使用 `allowNetwork: false`，因此无 stored catalog 时不会在启动阶段擅自联网发现模型。

### P3 — 双 wire fixture 代理集成（已完成）

**目标**：证明对真实双 wire 代理形态的接入正确，而不是 mock-only。

**工作项**：

- 新增 `tests/fixtures/dual-wire-proxy.ts`：本地 `node:http` 桩同时实现 `POST /v1/chat/completions` 与 `POST /v1/messages`（SSE 返回最小 assistant 事件），并记录收到的认证头与请求形状。
- 集成测试：经该桩验证 Anthropic wire 收到 `x-api-key`（默认）与 `Authorization`（`authHeader: true`）；OpenAI wire 收到 `Authorization`；`disableStrictTools` 时 OpenAI tool function 无 strict schema；`tools: []` 兼容路径仍生效。
- 验证与 `RUNLEDGER_PROXY_<PROVIDER>` 叠加：上游代理 baseUrl 也走 09 计划出站代理。

**门禁**：fixture 集成测试全绿；`npm test`（focused + 相关套件）；`npm run build`；`git diff --check`。

**证据**：`tests/integration/upstream-proxy.test.ts` 5 tests passed，包含真实 local `node:http` 双 wire fixture、认证头、wire cache、strict/tools 兼容与 09 出站代理叠加；fixture 不代表外部服务 parity。

### P4 — 真实代理 smoke（unavailable，本环境不宣称）

**目标**：有机会时用真实 new-api/one-api 类服务验证。

**工作项**：

- 当前没有可核验的 new-api/one-api endpoint、用户级 `models.json` 或可安全使用的外部模型凭据；选定的本地监听端口无法归因于该服务，因此不发起猜测性请求。
- 明确记录：`no real proxy evidence`；仅保留 fixture 证据，不宣称 provider parity、真实 token 流或外部 wire 探测成功。

**门禁**：真实证据或显式 unavailable 标记；不伪造探测成功。

### P5 — 文档与收尾（plan-local）

**目标**：配置契约进入仓库文档，状态表闭合。

**工作项**：

- 本文已回填配置示例、loader 真实边界、实现提交、focused/fixture 证据与 P4 unavailable；`streamProxy` 占位与本专项保持正交。
- 共享 `AGENTS.md`/`development-doc/00-index.md` 仍是 dirty worktree 的独立路径，本计划提交不吸收其它任务的 hunk。

**门禁**：文档与实现一致；状态表更新。

## 5. 测试与证据矩阵

| 层级 | 必须覆盖 |
|---|---|
| pure unit | 配置解析/env 引用、wire 判定全序、缓存命中/失败 TTL、baseUrl 往返、非法配置 |
| provider factory | `discovery.type: proxy` 注册、`/v1/models` 读取、stored 恢复、`api` 省略 dispatch |
| fixture 集成 | 双 wire 桩下认证头（x-api-key vs Authorization）、strict schema 关闭、tools 兼容、出站代理叠加 |
| regression | 68 内置 provider 测试、`npm run check`、`npm test`、`npm run build`、`git diff --check` |
| 真实 smoke | new-api/one-api 类真实代理：当前 `unavailable`，无外部 endpoint/credential；不得把 fixture 当真实 parity |

禁止用以下证据替代：只 mock fetch 的判定、只验证配置解析不验证 dispatch、或把 fixture 桩当真实代理 parity。

## 6. 文件范围与执行纪律

预期实现范围（以 P1–P4 开始前的 live code 为准）：

- Create：`src/providers/proxy-discovery.ts`、`src/providers/proxy-provider.ts`、`src/providers/configured-proxy.ts`、`tests/providers/proxy-discovery.test.ts`、`tests/fixtures/dual-wire-proxy.ts`、`tests/providers/proxy-provider.test.ts`、`tests/providers/configured-proxy.test.ts`、`tests/integration/upstream-proxy.test.ts`
- Modify：`src/api/anthropic-messages.ts`、`src/cli/main.ts`、`src/cli/runtime-host.ts`、`src/types.ts`
- Docs：本计划；共享 `AGENTS.md`/`development-doc/00-index.md` 为独立 dirty paths

纪律：

- 每个 P 阶段独立提交（`feat(providers): ...`）。
- 不新增内置 provider 文件；不改动现有 68 个 provider 的行为。
- 探测失败显式报错/回退，不静默猜测。
- 与 09 计划（出站代理）在集成点（P3）会合，但两个专项独立提交、独立验收。

## 7. 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 合同冻结 | implemented | `configured-proxy.ts` loader、strict/authHeader 出口和失败规则已核对 |
| P1 纯逻辑 | implemented | `tests/providers/proxy-discovery.test.ts`：8 passed |
| P2 工厂/schema | implemented | provider 5 + configured loader 4 tests passed；`059faf6`/`896b613` |
| P3 fixture 集成 | implemented | `tests/integration/upstream-proxy.test.ts`：5 passed |
| P4 真实 smoke | unavailable | 当前无可核验 new-api/one-api endpoint/credential；fixture 不替代真实证据 |
| P5 文档收尾 | implemented (plan-local) | 本文已回填；共享 AGENTS/index 不在本计划提交 |
