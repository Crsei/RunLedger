# 全量移植 pi-ai 层（API / OAuth / Provider）到 RunLedger

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_e1ab868c-3d81-45c4-aeaa-2cf789ec1030.md`。
> 本文覆盖 API、OAuth、provider、model catalog 与凭据持久化迁移;当前实现状态以仓库根目录 `AGENTS.md` §1.1 为准。

## 0. 背景与决策

用户在 `docs/pi-architecture.md` 看到 pi 项目的 OAuth → Provider → Agent 三层架构，要把 pi 的 **API / OAuth / Provider** 层先复制过来，再按本项目情况修改。pi 源码在 `F:/AIclassmanager/my_workspace/pi/`（`@earendil-works/pi-ai` 包）。

四个范围决定已与用户确认：
1. **Provider 范围**：全量 36 个 provider 工厂（含 `*.models.ts` + `data/*.json`）。
2. **OAuth 流范围**：5 个 OAuth 流（anthropic / openai-codex / github-copilot / xai / radius）+ pkce + device-code + oauth-page + load 公共件。
3. **凭证持久化**：带 `FileAuthStorage` + `proper-lockfile`，路径改为 `~/.runledger/agent/auth.json`。
4. **AGENTS.md §1 同步修订**：原本"显式不实现真实 LLM provider / OAuth"的两条移除，改为"已实现"。

## 1. 工程量与目录对象

迁移后 `src/` 增加的子目录与文件：
```
src/
  types.ts                # pi 的 types.ts (739 行，剥离 images 部分)
  models.ts               # pi 的 models.ts (706 行)
  models-store.ts         # pi 的 models-store.ts (38 行)
  models.generated.ts    # pi 的 models.generated.ts (76 行)
  index.ts                # 现有 barrel，扩展导出
  agent.ts / agent-loop.ts / event-stream.ts   # 保留现有空骨架，按需补
  ledger/ tools/          # 保留
  auth/
    types.ts helpers.ts credential-store.ts resolve.ts context.ts
    oauth/{anthropic,openai-codex,github-copilot,xai,radius,device-code,pkce,oauth-page,load}.ts
  providers/
    all.ts
    <36 个 provider>.ts
    <对应每个的 *.models.ts>
    data/<30 个 .json>
    radius-config.ts
  api/
    lazy.ts
    <11 个 *.lazy.ts>      # anthropic-messages / openai-responses / openai-completions / openai-codex-responses /
                           # azure-openai-responses / bedrock-converse-stream / google-generative-ai /
                           # google-vertex / mistral-conversations / pi-messages / openrouter-images
    <11 个 impl *.ts>
    simple-options.ts transform-messages.ts openai-responses-shared.ts openai-prompt-cache.ts
    github-copilot-headers.ts cloudflare.ts google-shared.ts
  utils/
    provider-env.ts event-stream.ts json-parse.ts diagnostics.ts headers.ts
    sanitize-unicode.ts error-body.ts deferred-tools.ts uuid.ts abort-signals.ts
    node-http-proxy.ts typebox-helpers.ts overflow.ts retry.ts contentText.ts
    validation.ts uuidv7.ts
  storage/                # 来自 coding-agent
    auth-storage.ts        # FileAuthStorage + InMemoryAuthStorageBackend + readStoredCredential
    resolve-config-value.ts
    runtime-credentials.ts
    paths.ts               # getAgentDir() -> ~/.runledger/agent/
  bun-oauth.ts             # Bun standalone glue（可选）
  images-models.ts         # ProviderImages 部分（最小骨架）
```
预计：TS 代码 ~8k 行 + 30 个 JSON 资产。

## 2. 实施步骤（按依赖顺序，每步可独立校验 `npm run check`）

### 步骤 A：依赖与脚本
1. `package.json` 添加 `dependencies`：`openai`、`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@smithy/node-http-handler`、`@google/genai`、`@mistralai/mistralai`、`http-proxy-agent`、`https-proxy-agent`、`partial-json`、`typebox`、`@opentelemetry/api`、`proper-lockfile`。
2. 添加 `devDependencies`：`@types/proper-lockfile`。
3. `engines.node` 由 `>=20.0.0` 提升到 `>=22.19.0`（与 pi 一致，Web Crypto `crypto.subtle.subtle` 在 Node 22 稳定；openai 6.x 也要求 ≥20，但 pi 全量用了 22.19 特性）。
4. `package.json` 增加 `imports` 子路径导出：`./providers/*`、`./api/*`、`./compat`、`./auth/*`、`./bun-oauth`（pi-ai 的导出 subpath 模式照搬）。
5. 验证：`npm install` 不报错；`npm run check` 仍 0 错。

### 步骤 B：utils 与基础类型层（无依赖以下）
1. 复制 `pi/packages/ai/src/utils/*.ts` 中下列文件到 `src/utils/`：`provider-env.ts`、`event-stream.ts`、`json-parse.ts`、`diagnostics.ts`、`headers.ts`、`sanitize-unicode.ts`、`error-body.ts`、`deferred-tools.ts`、`uuid.ts`、`abort-signals.ts`、`node-http-proxy.ts`、`typebox-helpers.ts`、`overflow.ts`、`retry.ts`、`contentText.ts`、`validation.ts`、`uuidv7.ts`。
2. 复制 `pi/packages/ai/src/types.ts` 到 `src/types.ts`。**修改点**：
   - 现有 `src/types.ts` 是空文件占位 — 直接覆盖。但保留原 AGENTS.md 中文注释风格约定（顶端加文件注释）。
   - 暂不剥离 images 部分（步骤 I 中决定）。
3. 复制 `pi/packages/ai/src/models-store.ts` 到 `src/models-store.ts`（无改动）。
4. 复制 `pi/packages/ai/src/models.generated.ts` 到 `src/models.generated.ts`。
5. 校验：跑一次 `npm run check`，应当只有"未使用 import"或"找不到 models.ts"等本地错误，符合预期。

### 步骤 C：auth 层
1. 复制 `pi/packages/ai/src/auth/types.ts` → `src/auth/types.ts`（无修改，类型契约层）。
2. 复制 `auth/helpers.ts`、`auth/credential-store.ts`、`auth/resolve.ts`、`auth/context.ts`（无修改）。
3. 复制 `auth/oauth/pkce.ts`、`auth/oauth/oauth-page.ts`、`auth/oauth/device-code.ts`（无修改，无 `node:*` 依赖）。
4. 复制 `auth/oauth/anthropic.ts`、`openai-codex.ts`、`github-copilot.ts`、`xai.ts`、`radius.ts`、`load.ts`（按 §1 现有相对路径不变，因为目标目录结构同 pi）。
5. 校验：`npm run check`。

### 步骤 D：api 层
1. 复制 `pi/packages/ai/src/api/lazy.ts` → `src/api/lazy.ts`。
2. 复制 11 个 `*.lazy.ts` wrappers：`anthropic-messages.lazy.ts`、`openai-responses.lazy.ts`、`openai-completions.lazy.ts`、`openai-codex-responses.lazy.ts`、`azure-openai-responses.lazy.ts`、`bedrock-converse-stream.lazy.ts`、`google-generative-ai.lazy.ts`、`google-vertex.lazy.ts`、`mistral-conversations.lazy.ts`、`pi-messages.lazy.ts`、`openrouter-images.lazy.ts`。
3. 复制 11 个实现模块 `*.ts`（非 lazy）：`anthropic-messages.ts`(1313)、`openai-responses.ts`(318)、`openai-completions.ts`(1355)、`openai-codex-responses.ts`(?)、`azure-openai-responses.ts`(?)、`bedrock-converse-stream.ts`(?)、`google-generative-ai.ts`、`google-vertex.ts`、`mistral-conversations.ts`、`pi-messages.ts`、`openrouter-images.ts`。
4. 复制共享 helper：`simple-options.ts`、`transform-messages.ts`、`openai-responses-shared.ts`、`openai-prompt-cache.ts`、`github-copilot-headers.ts`、`cloudflare.ts`、`google-shared.ts`。
5. 校验：`npm run check` 应当报**外部依赖未安装**——这正是步骤 A 的依赖加入后才清掉。

### 步骤 E：models.ts（核心注册表）
1. 复制 `pi/packages/ai/src/models.ts` → `src/models.ts`（707 行）。**无改动**：它的导入路径 `./auth/context.ts`、`./auth/credential-store.ts`、`./auth/resolve.ts`、`./auth/types.ts`、`./models-store.ts`、`./types.ts`、`./api/lazy.ts` 在新位置都对得上。
2. 校验：`npm run check`。

### 步骤 F：providers 层（36 个 + 资产）
1. 复制整个 `pi/packages/ai/src/providers/` 目录到 `src/providers/`，包括：
   - 36 个 `<name>.ts` provider 工厂文件
   - 30 个 `<name>.models.ts` 模型清单文件
   - `data/` 子目录下的 30 个 JSON 资产
   - `radius-config.ts`、`cloudflare-auth.ts`、`cloudflare-stream.ts`、`openrouter-images.ts`、`images/` 子目录
2. **修改点**：
   - `providers/all.ts`：原本 36 个 import 路径，迁移后保持相对路径不变，可直接用。
   - 如果 ` développement ` 后 biome 格式化需要：跑 `npx @biomejs/biome format --write src/`。
3. 校验：`npm run check`。

### 步骤 G：images-models.ts（ProviderImages 平行体系）
1. 复制 `pi/packages/ai/src/images-models.ts` → `src/images-models.ts`。
2. 复制相关 `images/` 子目录或确定它依赖的 providers。
3. 校验：`npm run check`。

### 步骤 H：凭证持久化（来自 coding-agent）
1. `src/storage/paths.ts` 新建：实现 `getAgentDir(): string`，返回 `join(homedir(), ".runledger", "agent")`，并支持环境变量 `RUNLEDGER_DIR` 覆盖（同 pi 的 `PI_CODING_AGENT_DIR`）。
2. 复制 `pi/packages/coding-agent/src/core/resolve-config-value.ts` → `src/storage/resolve-config-value.ts`（无改动）。
3. 复制 `pi/packages/coding-agent/src/core/auth-storage.ts` → `src/storage/auth-storage.ts`。**修改点**：
   - `import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai"` → 改为 `from "../auth/types.ts"`。
   - `import lockfile from "proper-lockfile"` 保留（新增 dep）。
   - `getAgentDir` import 从 `../config.ts` 改为 `./paths.ts`。
   - `normalizePath` 从 `../utils/paths.ts` 改为本地 `./paths.ts` 中导出（或新建一个等价 utility）。
4. 复制 `pi/packages/coding-agent/src/core/runtime-credentials.ts` → `src/storage/runtime-credentials.ts`（无改动，再调整 import 路径）。
5. 校验：`npm run check`。

### 步骤 I：bun-oauth（可选 Bun standalone glue）
1. 复制 `pi/packages/ai/src/bun-oauth.ts` → `src/bun-oauth.ts`（17 行）。**无改动**。
2. 加 `package.json` 的 `exports` 子路径 `./bun-oauth`。

### 步骤 J：index.ts barrel 整理
1. 把现有 `src/index.ts`（空）扩成 pi 的 `packages/ai/src/index.ts` 等价物：
   - 重导出 `auth/*`、`models.ts`、`models-store.ts`、`types.ts`、`api/lazy.ts`、`providers/faux.ts`、`utils/*`、`storage/*` 的核心类型与函数。
   - provider 工厂不导出根（保持 pi 风格：通过 `./providers/*` 子路径访问），但加 `exports` 子路径。
2. 校验：`npm run check`、`npm run build`。

### 步骤 K：compat 子路径（agent-loop 真依赖）
- pi 是通过 `@earendil-works/pi-ai/compat` 暴露 `streamSimple` / `convertToLlm` / `EventStream` / `validateToolArguments`。
- **决策**（最小代价）：保持 RunLedger 现有"扁平单包不引 compat"模式，由 RunLedger 的 `agent.ts`/`agent-loop.ts` 现有空骨架直接从 `./index.ts` 或 `./types.ts` 导入 `Models.streamSimple` 作 `StreamFn`。这一步**不复制 compat 包**。
- 如果未来要 100% 兼容 pi-agent 行为，再单独 step 引入 compat。

### 步骤 L：现有空骨架填实
- `src/agent.ts`、`src/agent-loop.ts`、`src/event-stream.ts`、`src/tools/echo.ts`、`src/ledger/*`、`examples/run.ts`、`tests/agent-loop.test.ts` 等空文件——**本次不强行填**。本次专注于「按 pi-architecture.md 计划构建 API/OAuth/Provider」这一用户明确要求。填实 agent-loop 是 `// TODO(pi):` 中的另一项独立任务。
- 只做：在 `examples/run.ts` 中**追加**一段最小演示，使用 `builtinModels()` 构造 `Models`，注入到一个 in-process `Provider<"faux">` 或模拟 `streamFn`，跑通 `models.login("faux", "api_key", interaction)` 这条简短链路，证明 port 后 OAuth/Provider 链路编译通过、类型不破。

### 步骤 M：AGENTS.md §1 + README 同步
1. `AGENTS.md` §1「范围」：把「仅实现核心运行循环」改成「核心运行循环 + 完整 OAuth/Provider/API 层（移植自 pi-ai）」。「显式不实现」列表里**删掉**：
   - `transformContext` 上下文变换（保留——这一项不是 provider/OAuth 范围，仍是 TODO）
   - 真实 LLM provider（**移除**——已实现）
   - 真实 LLM provider（仅 mock streamFn）（**改为**：mock streamFn 仅作为 fallback）
   - 删掉「`ExecutionEnv`」「OpenTelemetry」「RBAC」原本就不属于本范围，保持现状。
2. README 路线图：把 `[ ] // TODO(pi): 真实 LLM provider (OpenAI 兼容)` 改成 `[x] 已实现（移植 pi-ai）`；其余 TODO 保持。
3. 加一句在 README：「`packages/ai`、`packages/coding-agent` 中与 auth/provider 相关的实现已整体移植到 `src/auth`、`src/providers`、`src/api`、`src/storage`、`src/utils`；保留 pi 的 lazy-import + lockfile 设计」。
