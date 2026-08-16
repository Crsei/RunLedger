# oh-my-pi 新增 Provider 移植到 RunLedger：执行清单

> 状态：实施中；A 批次首个 provider `aiand` 已完成代码与自动化门禁，仍标记为 `partial`。
>
> 本文以 oh-my-pi 06aecdd51f07e689e970ceaa180abe2be0c14bbb（v17.2.15）为来源快照，以 RunLedger b5100b29624bfb04cf0ea5bcb48d80a9b3e39387（session-owner-runtime）为目标基线。来源或目标 HEAD 变化后，必须先重跑 P0 清单，不能直接复用本文的差集结论。

## 0. 当前基线与范围判定

- [x] 已确认 oh-my-pi 工作树干净，当前版本为 17.2.15。
- [x] 已确认 RunLedger 当前有 36 个 builtin provider factory、35 个 JSON catalog、1061 个模型条目。
- [x] 已确认 RunLedger 当前工作树已有与本任务无关的未提交修改：
  src/cli/main.ts、src/cli/workspace-display-label.ts、src/tui/components/footer.ts、src/tui/interactive-mode.ts、src/tui/types.ts 及两个对应测试文件。
- [x] 已确认 oh-my-pi 当前 CATALOG_PROVIDERS 有 68 个 chat/model provider，bundled catalog 有 64 个 provider、4214 个模型；这两个数字不等价，动态/特殊 provider 不能仅按 models.json 是否有条目判断是否支持。
- [x] 已固定来源 commit、包版本、目标分支和独立 worktree；不得在上述 dirty checkout 中清理、reset、rebase 或广泛 staging。

### 0.3 本轮实施证据（全批次，2026-08-16）

- 来源：oh-my-pi `06aecdd51f07e689e970ceaa180abe2be0c14bbb`（v17.2.15）；目标基线：RunLedger `b5100b29624bfb04cf0ea5bcb48d80a9b3e39387`；实现 worktree：`RunLedger-oh-my-pi-provider-port`，当前仍为 detached HEAD、未提交。
- 已实现：A 批次 16 个 + B 批次 14 个 + llama.cpp 共 31 个 factory（`src/providers/<id>.ts`）；kimi-code device-code OAuth 流（`src/auth/oauth/kimi-code.ts`）+ kilo device-auth login；模型数据 vendored 来源（`scripts/sources/oh-my-pi-provider-models-17.2.15.json`，2384 条 + 5 个 hand-seed，经 `scripts/ported-provider-catalog.ts` 归一化）；`builtinProviders()`/`KnownProvider`/`models.generated.ts`/`all.ts` 接线（68 个 provider，identity 唯一）；azure/moonshot/xai-oauth identity 映射（不新增 ID，xai catalog 并入 5 个 responses 模型）。
- 自动化证据（全部来自目标 worktree）：focused providers 34 files / 229 tests；`npm run check` 0 error；`npm test` 410 files / 2503 tests passed（3 skipped）+ Bun TUI 98/98；`npm run build` passed；隔离 RUNLEDGER_DIR 组合 smoke + 受控本地 server 真实 HTTP smoke + 编译产物 `cli.js --version` 全绿；`git diff --check` 0 告警。
- 生成器：新增 provider 每次运行逐字节复现（vendored 不依赖网络）；live models.dev 断网导致既有 provider 漂移按 §P7 恢复程序处理（既有 generator 网络依赖，未在本批修）。
- 当前未闭合：全部新 provider 无真实凭据/API E2E → 一律 partial（pending-real-provider）；C 批次 8 个特殊协议 deferred；动态 catalog 仍只声明进程内 refresh；Bun standalone binary 打包未实测。详见 §7 状态表。
### 0.1 本次 chat/model provider 差集

以下是按 provider ID 字面比较得到的 42 个差集。它是“待审计清单”，不是“全部都能直接复制”的文件列表：

    aiand, aimlapi, alibaba-coding-plan, alibaba-token-plan, azure,
    baseten, bedrock-mantle, coreweave, cursor, devin, firepass,
    gitlab-duo, gitlab-duo-agent, gmi-cloud, google-antigravity,
    google-gemini-cli, kilo, kimi-code, litellm, lm-studio, meta,
    minimax-code, minimax-code-cn, moonshot, nanogpt, novita, ollama,
    ollama-cloud, opencode-zen, qianfan, qwen-portal, sakana, siliconflow,
    siliconflow-cn, synthetic, umans, venice, vllm, wafer-serverless,
    xai-oauth, zenmux, zhipu-coding-plan

必须保留以下身份映射审计，不得把同一传输协议误判为同一个 provider：

- azure 使用 RunLedger 已有的 azure-openai-responses 传输能力，但是否保留旧 ID、增加兼容别名或迁移已持久化设置，必须单独决定。
- kimi-code 与 RunLedger 的 kimi-coding 不是简单改名：来源使用动态 OpenAI-compatible catalog 和 Kimi OAuth，目标当前 provider 使用 Anthropic messages 与 API key。
- moonshot 与 RunLedger 的 moonshotai / moonshotai-cn 有不同的 provider identity、base URL 和模型发现语义。
- minimax-code、minimax-code-cn、xai-oauth 与已有 API-key provider 分开保存凭据，不能把 OAuth token 写入已有 provider 的 credential slot。

### 0.2 registry 中但不属于同一批 chat catalog 的 provider

来源 registry 还包含 llama.cpp、zai-coding-plan、openai-codex-device、exa、kagi、parallel、perplexity、tavily 等 ID。实施时必须逐项标记：

- llama.cpp：可作为后续本地 OpenAI-compatible provider 批次；不能因“能连 /v1”而跳过本地无认证、base URL 和模型发现测试。
- zai-coding-plan、openai-codex-device：优先作为已有 provider 的 OAuth/auth 变体审计，不自动增加重复的模型 provider。
- exa、kagi、parallel、perplexity、tavily：属于搜索/工具或辅助认证范围，不在本清单的 chat provider DoD 内；若要移植，另建专项，不能用模型 provider 数量代替完成证据。

## 1. 目标架构边界与不变量

RunLedger 的目标链路保持为：

    src/providers/<id>.ts
      -> src/models.ts / createProvider()
      -> src/api/*.lazy.ts
      -> src/auth/{helpers,resolve}.ts + AuthStorage
      -> src/cli/{main,runtime-host}.ts
      -> InteractiveSessionController / Agent Loop

模型 catalog 仍由 src/providers/<id>.models.ts、src/providers/data/<id>.json、src/models.generated.ts 和 scripts/generate-models.ts 共同拥有。具体执行必须遵守：

- [x] 使用来源 provider 的行为和测试作为参考，但不复制 oh-my-pi 的全局 registry、import-time registration、catalog package、外部 installed/enabled 状态或模型名字 first-wins 逻辑。→ 全部 factory 走 createProvider()；catalog 经 vendored snapshot 归一化；无来源全局 registry 复制。
- [x] 每个 provider 保持稳定的 provider/model 身份；只有完成 settings/auth/session 兼容审计后才能增加 alias 或重命名。→ azure/moonshot/xai-oauth 三个 identity 映射结论见 §2.1；未新增任何 alias 或重命名。
- [x] 仅能把真正兼容的 wire protocol 映射到已有 API。RunLedger 当前已有 openai-completions、openai-responses、anthropic-messages、Google、Bedrock 等 API；cursor-agent、devin-agent、gitlab-duo-agent、google-gemini-cli、ollama-chat 等特殊 API 不能用 OpenAI adapter 伪装。→ A/B 批次全部映射到已有 adapter；C 批次特殊 API 全部 deferred（RED 测试 evidence）。
- [x] Provider auth 必须通过 ProviderAuth、AuthStorage、envApiKeyAuth 或 lazyOAuth 接线；生产路径没有凭据时返回未配置/可诊断错误，不回退到 faux、mock-stream、AllowAll 或 raw I/O fallback。→ P6 smoke：未配置 provider stream → stopReason=error "Provider is not configured"；本地 keyless provider 用来源 sentinel 约定，远程 provider 无凭据一律 fail closed。
- [x] 动态 provider 必须保留 last-known-good catalog，处理 abort、超时、坏 JSON、空结果和重复 refresh；未解决生产 ModelsStore 持久化前，不宣称跨进程离线恢复可用。→ 各 provider fetchModels throw 触发 createProvider 保留；测试覆盖空结果/HTTP 错误/坏 payload/dedup；持久化结论见 P0。
- [x] 不把 provider、network、credential、storage 或 UI 依赖引入 src/runtime/contracts 等被动 contract 层。→ 本批未触碰 src/runtime/contracts；check:contract-consumers 通过。
- [x] 不在日志、错误、测试 fixture 或文档中写入真实 API key、OAuth token、完整用户目录或 provider secret。→ 全批 fixture 均为 fake key/sentinel；无真实 secret。

## 2. Provider 映射矩阵（实施前逐行补齐）

每个 provider 在编码前必须有一行矩阵记录以下字段：

    id | 来源 registry 文件 | 来源 model-manager 文件/函数 | 目标 API
       | base URL/headers 来源 | auth 类型/env | 静态或动态 catalog
       | target factory/models/data/test 文件 | 当前状态 | 阻塞原因

来源证据入口：

- catalog / default model / dynamic manager：oh-my-pi/packages/catalog/src/provider-models/descriptors.ts、openai-compat.ts、google.ts、ollama.ts、special.ts。
- auth / env / OAuth / callback：oh-my-pi/packages/ai/src/registry/<id>.ts、packages/ai/src/registry/oauth/。
- wire behavior：oh-my-pi/packages/ai/src/providers/。
- 回归意图：oh-my-pi/packages/catalog/test/ 与 packages/ai/test/ 中对应 provider 测试。
### 2.1 矩阵行（2026-08-16 审计结论，来源快照 06aecdd5，目标基线 b5100b2）

实现决策：A 批次 16 个全部新增 factory；B 批次新增 13 个 factory（azure / moonshot / xai-oauth 为 identity 映射，不新增 ID）；C 批次 8 个 deferred；registry-only 见 §5。

| id | 来源 wire/api | 目标 api | auth/env | 默认 base URL | catalog | 决策 |
|---|---|---|---|---|---|---|
| aimlapi | openai-completions | 同 | api_key AIMLAPI_API_KEY | https://api.aimlapi.com/v1 | 动态 authoritative + vendored 静态 | 新增 factory |
| baseten | openai-completions | 同 | api_key BASETEN_API_KEY | https://inference.baseten.co/v1 | 动态 authoritative + vendored | 新增 factory |
| coreweave | openai-completions | 同 | api_key COREWEAVE_API_KEY/WANDB_API_KEY + `OpenAI-Project` header（COREWEAVE_PROJECT） | https://api.inference.wandb.ai/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| firepass | openai-completions | 同 | api_key FIREPASS_API_KEY | https://api.fireworks.ai/inference/v1 | 仅静态（fpk key 不能调 /models） | 新增 factory |
| gmi-cloud | openai-completions | 同 | api_key GMI_API_KEY | https://api.gmi-serving.com/v1 | 动态 authoritative + vendored | 新增 factory |
| litellm | openai-completions | 同 | optional key LITELLM_API_KEY；LITELLM_BASE_URL | http://localhost:4000/v1 | 动态（本地；无 bundled） | 新增 factory |
| lm-studio | openai-completions | 同 | optional key LM_STUDIO_API_KEY；LM_STUDIO_BASE_URL | http://127.0.0.1:1234/v1 | 动态（本地；无 bundled） | 新增 factory |
| nanogpt | openai-completions | 同 | api_key NANO_GPT_API_KEY | https://nano-gpt.com/api/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| novita | openai-completions | 同 | api_key NOVITA_API_KEY | https://api.novita.ai/openai/v1 | 动态 authoritative + vendored | 新增 factory |
| qianfan | openai-completions | 同 | api_key QIANFAN_API_KEY | https://qianfan.baidubce.com/v2 | 动态(非 authoritative) + vendored | 新增 factory |
| siliconflow | openai-completions | 同 | api_key SILICONFLOW_API_KEY | https://api.siliconflow.com/v1 | 动态 authoritative（故意无 bundled，hand-seed） | 新增 factory |
| siliconflow-cn | openai-completions | 同 | api_key SILICONFLOW_CN_API_KEY | https://api.siliconflow.cn/v1 | 动态 authoritative（hand-seed） | 新增 factory |
| synthetic | openai-completions | 同 | api_key SYNTHETIC_API_KEY | https://api.synthetic.new/openai/v1 | 动态 authoritative + vendored | 新增 factory |
| venice | openai-completions | 同 | api_key VENICE_API_KEY（allowUnauthenticated） | https://api.venice.ai/api/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| vllm | openai-completions | 同 | optional key VLLM_API_KEY；VLLM_BASE_URL | http://127.0.0.1:8000/v1 | 动态（本地；无 bundled） | 新增 factory |
| zhipu-coding-plan | openai-completions | 同 | api_key ZHIPU_API_KEY | https://open.bigmodel.cn/api/coding/paas/v4 | 动态 authoritative + vendored | 新增 factory |
| alibaba-coding-plan | openai-completions | 同 | api_key ALIBABA_CODING_PLAN_API_KEY；base Intl/CN/custom | Intl/CN 双 endpoint | 动态(非 authoritative) + vendored | 新增 factory |
| alibaba-token-plan | openai-completions | 同 | api_key ALIBABA_TOKEN_PLAN_API_KEY/BAILIAN_TOKEN_PLAN_API_KEY，credential 可为 JSON {token,cookie,baseUrl} | token-plan region URL | 动态 authoritative + vendored | 新增 factory |
| azure | azure-openai-responses | → 已有 azure-openai-responses | AZURE_OPENAI_API_KEY/AZURE_OPENAI_BASE_URL 目标 adapter 已支持 | — | — | identity 映射，不新增 ID |
| bedrock-mantle | openai-responses | 同 | aws_bearer：stored key 或 AWS_BEARER_TOKEN_BEDROCK；{region} 模板 | https://bedrock-mantle.{region}.api.aws/openai/v1 | 动态 authoritative + vendored | 新增 factory |
| kilo | openai-completions | 同 | optional key KILO_API_KEY + 自定义 device-auth login | https://api.kilo.ai/api/gateway | 动态(非 authoritative) + vendored | 新增 factory |
| kimi-code | openai-completions | 同 | device-code OAuth（新移植流）+ env fallback KIMI_API_KEY | https://api.kimi.com/coding/v1 | 动态(非 authoritative) + vendored | 新增 factory + OAuth 流 |
| meta | openai-responses | 同 | api_key MODEL_API_KEY/META_API_KEY | https://api.meta.ai/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| minimax-code | openai-completions | 同 | api_key MINIMAX_CODE_API_KEY | https://api.minimax.io/v1 | 仅静态 vendored | 新增 factory |
| minimax-code-cn | openai-completions | 同 | api_key MINIMAX_CODE_CN_API_KEY | https://api.minimaxi.com/v1 | 仅静态 vendored | 新增 factory |
| moonshot | openai-completions | → 已有 moonshotai | 加 KIMI_API_KEY fallback env | 同 api.moonshot.ai | — | identity 映射，auth-only 变更 |
| opencode-zen | 混合（completions/responses/anthropic/google） | 混合 | api_key OPENCODE_API_KEY | https://opencode.ai/zen/v1 | 动态 authoritative + vendored | 新增 factory |
| qwen-portal | openai-completions | 同 | api_key QWEN_OAUTH_TOKEN/QWEN_PORTAL_API_KEY | https://portal.qwen.ai/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| sakana | openai-responses | 同 | api_key SAKANA_API_KEY/FUGU_API_KEY | https://api.sakana.ai/v1 | 动态 authoritative + vendored | 新增 factory |
| umans | anthropic-messages | 同 | api_key UMANS_AI_CODING_PLAN_API_KEY | https://api.code.umans.ai | 动态 authoritative（/models/info）+ vendored | 新增 factory |
| wafer-serverless | openai-completions | 同 | api_key WAFER_SERVERLESS_API_KEY | https://pass.wafer.ai/v1 | 动态(非 authoritative) + vendored | 新增 factory |
| xai-oauth | openai-responses | → 已有 xai provider 的 OAuth 路径 | 已存在（loadXaiOAuth） | https://api.x.ai/v1 | vendored 8 个 responses 模型并入 xai catalog | identity 映射 + catalog 同步 |
| zenmux | 混合（anthropic/completions by 前缀） | 混合 | optional key ZENMUX_API_KEY | https://zenmux.ai/api/v1 + /api/anthropic | 动态(非 authoritative) + vendored | 新增 factory |
| cursor | cursor-agent | — | 无目标 transport | — | — | deferred（RED 证据） |
| devin | devin-agent | — | 无目标 transport | — | — | deferred（RED 证据） |
| gitlab-duo | catalog-only | — | 无目标 transport | — | — | deferred |
| gitlab-duo-agent | gitlab-duo-workflow | — | 无目标 transport | — | — | deferred |
| google-antigravity | special | — | 无目标 transport | — | — | deferred |
| google-gemini-cli | special | — | 无目标 transport | — | — | deferred |
| ollama | openai-responses@local + native /api/tags | — | 无 native transport，OpenAI-compat 单独不满足 P4 | http://127.0.0.1:11434 | — | deferred（RED 证据） |
| ollama-cloud | ollama-chat | — | 无 ollama-chat adapter | https://ollama.com | — | deferred（RED 证据） |

registry-only（§0.2）：llama.cpp → deferred（本地 OpenAI-compatible 后续批次，P5 单独评估记录）；zai-coding-plan → 已有 zai 的 auth 变体审计，不新增；openai-codex-device → 已有 openai-codex 的 device auth 变体审计，不新增；exa/kagi/parallel/perplexity/tavily → 搜索/工具范畴，不在本清单 DoD。

来源证据入口：
先按下列批次分组，矩阵确认后再拆成实际 commit：

| 批次 | Provider | 主要协议/风险 | 目标 |
|---|---|---|---|
| A：已有 adapter 可复用 | aiand、aimlapi、baseten、coreweave、firepass、gmi-cloud、litellm、lm-studio、nanogpt、novita、qianfan、siliconflow、siliconflow-cn、synthetic、venice、vllm、zhipu-coding-plan | 主要是 OpenAI completions；动态 /models、本地无 key、模型过滤和 provider-specific compat 不能省略 | 先完成静态/动态 catalog、API key/env、stream fixture 和 selector 可见性 |
| B：已有 ID/多协议/特殊 auth | alibaba-coding-plan、alibaba-token-plan、azure、bedrock-mantle、kilo、kimi-code、meta、minimax-code、minimax-code-cn、moonshot、opencode-zen、qwen-portal、sakana、umans、wafer-serverless、xai-oauth、zenmux | OAuth、区域/base URL、AWS bearer、Anthropic/OpenAI 混合、reasoning/headers；部分 provider 不能从静态 models.dev 数据还原 | 每个 provider 先有 credential identity、wire compat 和 discovery/cache 决策，再开放到 builtin list |
| C：特殊协议/原生流 | cursor、devin、gitlab-duo、gitlab-duo-agent、google-antigravity、google-gemini-cli、ollama、ollama-cloud | 来源有 Cursor/Devin/GitLab workflow/Cloud Code Assist/Ollama native transport；目标没有同等 API 的，不得标记为“兼容完成” | 单独 adapter 和 lifecycle 测试；若协议或依赖无法安全接入，保留 deferred 状态 |

## 3. 分阶段执行清单

### P0：冻结来源、目标和差集

- [x] 在独立 worktree 中记录 git rev-parse HEAD、git status --short --branch、package.json version/engines/dependencies。→ 实现 worktree `RunLedger-oh-my-pi-provider-port` detached HEAD @ b5100b29624bfb04cf0ea5bcb48d80a9b3e39387；来源 oh-my-pi @ 06aecdd51f07e689e970ceaa180abe2be0c14bbb（v17.2.15）；证据见 §0 与 §0.3。
- [x] 重新计算 catalog ID 差集、registry-only ID 差集、src/providers/data 差集和 API union 差集；结果写入本文件。→ §2.1 矩阵行（42 chat/model 差集 + 8 registry-only）；API union 差集为 cursor-agent / devin-agent / gitlab-duo-workflow / ollama-chat / 特殊 Google 流。
- [x] 逐项确认 provider 是“新 ID”“旧 ID 的兼容别名”“仅新增模型”“仅新增 auth 流”还是“特殊 wire provider”。只把第一类作为新增 factory。→ 结论：azure→已有 azure-openai-responses（identity 映射，不新增）；moonshot→已有 moonshotai + KIMI_API_KEY fallback（auth-only）；xai-oauth→已有 xai 的 OAuth 路径（identity 映射 + catalog 同步）；minimax-code/-cn、qwen-portal、wafer-serverless 来源标注 OAuth 实为 API-key paste 流（普通 api_key factory）；其余 30 个新增 factory。
- [x] 决定是否为动态 catalog 增加 production ModelsStore。若仍使用默认 InMemoryModelsStore，动态 provider 只能声明进程内 refresh，不得声称重启后恢复。→ 结论：保持 InMemoryModelsStore；所有动态 provider 只声明进程内 refresh + last-known-good（createProvider 的 store read/write 已按 provider 隔离）；不宣称跨进程离线恢复；见 §0.3 未闭合项。
- [x] 记录 RunLedger dirty 文件清单，并将 provider 改动限制在 provider/API/auth/models/generator/tests/docs 范围；任何跨到当前 TUI dirty slice 的冲突立即停止。→ 主工作树 dirty 清单见 §0；本批改动全部落在独立 worktree，不触碰主工作树（生成过程中误写入主工作树的 scripts/generate-models.ts 两行已当场还原，git diff 验证为空）。

P0 闭合条件：每个 ID 都有矩阵行、目标 API 已存在或明确列入 C 批次、auth identity 不冲突、动态持久化语义已有结论。

### P1：先补通用合同与测试夹具

- [x] 为 provider test 增加可注入 fetch、固定 SSE/JSON fixture、Abort/timeout fixture 和无 secret 的 credential interaction。→ 模板：tests/providers/aiand.test.ts（注入 fetch + Response fixture + SSE 回放 + InMemoryModelsStore scoped helper）；本批全部新 provider 测试沿用同一模式，测试无真实网络、无 secret。
- [x] 覆盖 createProvider() 的静态模型、动态 overlay、provider-scoped store、重复 refresh、坏结果保留旧 catalog 和未知 API fail-closed 行为；如发现这些是全局缺口，先单独修复并单独验证。→ 审计结论：createProvider.refreshModels 已提供 provider-scoped store read/write 与坏结果保留（fetchModels throw 时不替换 dynamicModels）；空结果/坏 JSON/HTTP 错误由各 provider fetchModels throw 触发保留；未知 API 由 dispatch 返回 stream error——均为既有全局行为，无缺口，无需单独修复。
- [x] 明确 provider-level baseUrl 与 model-level baseUrl 的优先级，区域/本地 endpoint 通过 ProviderEnv 或显式配置传入，不从 workspace 任意路径读取。→ 结论：model.baseUrl 为准（生成物内定），request 时 auth.baseUrl（credential/env 派生）覆盖；本地 provider（litellm/lm-studio/vllm）baseUrl 来自 factory options 或 `<ID>_BASE_URL` env；区域 provider（alibaba-coding-plan/alibaba-token-plan/bedrock-mantle）baseUrl 来自 credential.env 或对应 env var；不读取 workspace 路径。
- [x] 为生成物定义唯一来源：新增 provider 的模型数据要么进入 scripts/generate-models.ts 的可复现源，要么建立明确的 provider-specific source；不得手工编辑 models.generated.ts 作为长期方案。→ 结论：新增 provider 的静态模型唯一来源为 scripts/sources/oh-my-pi-provider-models-17.2.15.json（由 scripts/sources/extract-oh-my-pi-models.ts 从冻结快照提取），经 scripts/ported-provider-catalog.ts 归一化后由 generate-models.ts 消费；无 bundled 的 5 个 provider 用 hand-seed 占位并注明运行时动态发现为准；models.generated.ts / data/*.json / *.models.ts 全部生成，禁止手改。
- [x] 为 OAuth provider 定义 RunLedger credential shape、过期/刷新、并发锁、logout 和失败后不回退 env 的行为；先用假 callback/fetch 测试，不能一开始接真实账号。→ 结论：沿用 OAuthCredential（access/refresh/expires）；refresh 由 Models.resolveRefreshCredential 持锁；logout 走 CredentialStore.delete；kimi-code 的 env KIMI_API_KEY 是独立 apiKey auth 路径（先存凭证后 env，来源语义），不与 OAuth token 互写；测试用假 fetch。xai-oauth 复用既有 xai OAuth 流，不新增。
### P2：实现 A 批次（已有 adapter 的 provider）

对 A 批次逐 provider 重复以下清单，不允许一次复制整目录后统一“修到能编译”：

- [x] 新建 src/providers/<id>.ts，使用 createProvider() 和现有 lazy API；先搜索现有 helper，避免复制 auth/header/URL/stream 逻辑。→ A 批次 16 个 factory 全部落地（aimlapi/baseten/coreweave/firepass/gmi-cloud/litellm/lm-studio/nanogpt/novita/qianfan/siliconflow/siliconflow-cn/synthetic/venice/vllm/zhipu-coding-plan），复用 envApiKeyAuth/lazy API，无 auth/stream 逻辑复制。
- [x] 新建 provider model source 和测试；静态模型至少验证 id、provider、api、baseUrl、输入模态、reasoning/thinking、context/max tokens、compat。→ 静态来源为 scripts/sources/oh-my-pi-provider-models-17.2.15.json（2384 条）+ 5 个 hand-seed；各 provider 测试均验证 identity/api/baseUrl/compat。
- [x] 接入 src/providers/all.ts，确认 builtinProviders() 与 builtinModels() 的 provider identity 唯一。→ all.ts 68 个 factory，P6 smoke 断言 identity 唯一（无重复）。
- [x] 接入 auth/env；keyless local provider（LM Studio/vLLM 等）必须明确“无 key 可用”与“未配置 endpoint”的区别。→ litellm/lm-studio/vllm/llama.cpp 使用来源 sentinel key + 默认本地 endpoint；远程 provider 无凭据 fail closed。
- [x] 动态 provider 实现成功、空结果、HTTP 错误、超时、取消、坏 schema、重复 model id、旧 catalog 保留和 store scope 测试。→ 每 provider 测试覆盖（focused 229 tests 全绿）。
- [x] 将来源 provider test 中与 RunLedger 目标契约对应的回归逐项改写到 tests/providers/ 或 tests/auth/；不复制依赖 Oh My Pi session/global registry 的测试。→ 全部测试基于可注入 fetch + InMemoryModelsStore，无来源 session/registry 依赖。
- [x] 每完成一个小批次先运行 focused tests、npm run check 和 git diff --check，审阅生成文件变化后再进入下一批。→ 批次证据：A1 44、A2 50、A3 21、B1 38、B2 23、B3 21、B4 16、llama.cpp 5、RED 2、全量 focused 34 files / 229 tests；git diff --check 0 告警。

#### P2.1 aiand 当前状态

- [x] 使用 `createProvider()` + `openAICompletionsApi()`，没有复制 oh-my-pi 的全局 registry 或 catalog runtime。
- [x] 有静态模型 source、生成物和 `tests/providers/aiand.test.ts`；覆盖 factory/auth、builtin registry、动态 metadata 映射、空 catalog 保留旧列表和真实 OpenAI completions SSE fixture。
- [x] 动态发现使用 provider-scoped store，并在 provider 内保持 last-known-good；生成器可重建 ai& catalog。
- [x] focused / check / full Vitest + Bun TUI / build 门禁已留证，生成器产生的其他 provider 漂移已清理。
- [ ] 真实 ai& API credential、CLI/Host 选型和重启后的 durable catalog 恢复仍待单独验证，因此本 provider 只能标记 `partial`。

### P3：实现 B 批次（auth、区域和多协议）

- [x] Alibaba 两个 plan 分别验证国际/中国 endpoint、credential parsing、模型列表、region header 和 refresh 失败语义；不得把 token plan 当普通 API key provider。→ alibaba-coding-plan：login 选 Intl/CN/custom，custom endpoint 存 credential.env.codingPlanBaseUrl，resolve 产出 auth.baseUrl；alibaba-token-plan：credential key 支持 JSON {token,cookie,baseUrl} 解析，baseUrl 从 credential/env 派生，非普通 key 直传；两者测试覆盖 38 tests（含 discovery gated + 过滤）。
- [x] bedrock-mantle 验证 AWS bearer/region/base URL 与 openai-responses wire；保留现有 Bedrock credential chain 的 fail-closed 语义。→ stored key ?? AWS_BEARER_TOKEN_BEDROCK；{region} 模板由 AWS_REGION/AWS_DEFAULT_REGION/us-east-1 替换；discovery 走 /v1（去 /openai/v1）；无 bearer fail closed；7 tests。
- [x] kimi-code、minimax-code、minimax-code-cn、qwen-portal、kilo、xai-oauth 分别验证 OAuth storage key、refresh lock、过期 token、logout 和 model selector 的 provider/model 身份。→ 审计结论：minimax-code/-cn 与 qwen-portal 为 API-key/token paste 流（普通 api_key factory，独立 provider ID 存储）；kimi-code 为真实 device-code OAuth（src/auth/oauth/kimi-code.ts 移植 + 8 flow tests，refresh 由 Models 持锁，credential 存 kimi-code slot，env fallback 独立 apiKey 路径）；kilo 为自定义 device-auth（login 移植 + tests）；xai-oauth 复用已有 xai OAuth 流（identity 映射）。
- [x] opencode-zen、zenmux、umans 验证按 model API 分派：Anthropic 模型走 Anthropic adapter，OpenAI 模型走对应 OpenAI adapter；不以 provider-level 单一 API 覆盖混合模型。→ opencode-zen 4-api map + per-model resolution rules（8 tests）；zenmux anthropic/ 前缀 + owned_by 分派（6 tests）；umans 全量 anthropic-messages + /models/info discovery（5 tests）。
- [x] meta、sakana 验证 Responses payload、reasoning/tool call、流结束和错误映射；wafer-serverless 验证其模型 envelope、pricing/limits 和动态模型过滤。→ meta/sakana/bedrock-mantle 走 openAIResponsesApi（23 tests）；wafer-serverless envelope（context_length/capabilities/pricing cents×125/10000/maxTokens=min(ctx,65536)）6 tests。
- [x] azure 与旧 azure-openai-responses 的配置迁移/alias 决策必须有负向测试：旧配置不能静默丢失，新配置不能覆盖错误 provider。→ 决策：不新增 azure ID、不加 alias（identity 映射，见 §2.1）；目标 azure-openai-responses 保持既有 ID/env（AZURE_OPENAI_API_KEY/AZURE_OPENAI_BASE_URL/AZURE_OPENAI_RESOURCE_NAME），无迁移路径即无数据丢失面；负向断言由既有 azure-openai-responses 测试与 RED 测试（builtinProviders 不出现重复 azure 身份）覆盖。
### P4：实现 C 批次（特殊协议）

- [x] 先为每个特殊 provider 写“目标 API 是否支持”的 RED 测试；不能通过改写 Api union 或把 unknown API 强转成已有 API 来消除 RED。→ tests/providers/special-protocol-red.test.ts：断言 cursor-agent / devin-agent / ollama-chat 无目标 adapter 实现且 dispatch fail closed（stream error），builtinProviders() 不注册 C 批次 8 个 ID。
- [x] cursor、devin、gitlab-duo-agent、google-antigravity、google-gemini-cli 只有在 transport、取消、工具调用、错误和资源释放都有目标实现后，才加入 builtinProviders()。→ 目标无 cursor-agent / devin-agent / gitlab-duo-workflow / google-antigravity / google-gemini-cli 特殊流；保持 deferred，不加入 builtinProviders()。gitlab-duo 同理（来源 catalog-only + GITLAB_TOKEN 工作流 API）。
- [x] ollama / ollama-cloud 分别验证 OpenAI-compatible discovery 与 native /api/tags、/api/show、thinking、vision、output cap；不能把 cloud token 或本地无 key 语义混在一起。→ 目标无 ollama-chat 或 native /api/tags 传输；OpenAI-compatible 子集不能伪装成“兼容完成”，两个 ID 保持 deferred。
- [x] 若需要新增 SDK、protobuf、native binary 或 Bun-only module，先提交依赖/打包/许可证/Node-Bun 兼容审计；依赖审计未闭合时保持 deferred，不把 import 放进启动热路径。→ 本批无新增依赖；C 批次依赖审计不适用（deferred 前无 import 进入启动路径）。
- [x] 特殊 provider 的生产失败必须显示真实 provider error；不得回退到 deepseek、mock 或 faux model。→ RED 测试断言 dispatch 对未知 API 返回 stream error 而非回退；生产组合无回退路径（见 P6 smoke）。

### P5：registry-only provider 决策

- [x] llama.cpp 作为本地 OpenAI-compatible provider 单独评估 base URL、optional token、动态 models 和无网络启动。→ 结论：与 A 批次本地 provider（litellm/lm-studio/vllm）同构——env LLAMA_CPP_API_KEY（optional，sentinel "llama-cpp-local"）+ LLAMA_CPP_BASE_URL（默认 http://127.0.0.1:8080）+ 纯动态 /models、无静态 bundled；决定实现（src/providers/llama-cpp.ts，purely dynamic，无 catalog 条目，同 radius 先例）。
- [x] zai-coding-plan 与 openai-codex-device 作为已有 provider 的 auth/登录变体单独评估 credential storage key 和 OAuth callback，不重复注册模型 provider。→ 审计结论（来源 registry/zai.ts、registry/openai-codex-device.ts）：zai-coding-plan 是 zai 的 OAuth 登录变体（storeCredentialsAs: "zai"，callbackPort 54548 + paste-code fallback），openai-codex-device 是 openai-codex 的 device OAuth 变体（storeCredentialsAs: "openai-codex"）；两者共享模型 catalog，不新增 model provider ID。目标 zai 目前只有 API key auth、openai-codex 已有 OAuth 流；来源 OAuth 流的专项移植另建计划，不纳入本清单完成证据。
- [x] exa、kagi、parallel、perplexity、tavily 若需要移植，创建独立计划；本清单不得用 chat provider 的测试证明它们完成。→ 判定：搜索/工具/辅助认证范畴，不在 chat provider DoD 内；本清单不实现、不证明；如需移植另建专项。

### P6：生产组合与真实运行证据

- [x] 验证真实组合链：bin/runledger.js → src/cli/main.ts / runtime host → builtinModels() → AuthStorage → InteractiveSessionController → Agent Loop。→ 证据：npm run build 后 `RUNLEDGER_DIR=$(mktemp -d) node dist/cli/cli.js --version` 输出 runledger 0.0.1（编译产物含全部 68 provider）；tmp/smoke-provider-port.ts 走 builtinModels() + getAuth + stream 组合链全绿。
- [x] 在隔离的 RUNLEDGER_DIR 下验证 provider 列表、登录/登出、可用模型过滤、模型选择、provider/model 持久化和重新启动后的行为。→ provider 列表/identity 唯一性/未配置 fail-closed/env auth 由 tmp/smoke-provider-port.ts（隔离 RUNLEDGER_DIR）验证；登录/登出/过滤由 per-provider auth 测试与 kilo/kimi-code flow 测试覆盖；provider/model 持久化语义按 P0 结论（进程内）验证。
- [x] 至少选择一个代表性 API-key OpenAI provider、一个 Anthropic/mixed provider、一个 Responses provider、一个 dynamic provider 和一个 OAuth provider 做真实连接或受控本地 server smoke；没有安全凭据时明确记录 pending-real-provider，不伪造通过。→ 受控本地 server smoke（tmp/smoke-local-server.ts）：真实 TCP/HTTP 完成 vllm（dynamic + local）discovery + SSE stream，经 Models 生产组合 stopReason=stop；其余全部新 provider 无安全凭据 → 明确记录 pending-real-provider（不伪造）。
- [x] 真实 provider smoke 只验证目标 provider，不修改用户真实 ~/.runledger，不把 token 写入日志或 evidence。→ smoke 全部使用隔离 RUNLEDGER_DIR 与本地 mock server；无 token 落盘/日志。

### P7：生成物、文档与交付

- [x] 运行 npm run generate-models，审阅新增/删除 provider、模型数量、base URL、compat 和生成文件；确认 generator 不会在下一次运行中删除新 provider。→ 两次运行：新 30 个 provider 每次逐字节复现（vendored 来源不依赖网络）；live fetch 失败导致既有 provider 漂移是既有 generator 网络依赖，恢复程序：`cp -r src/providers/data /tmp/before` 先备份，跑 generator 后按 §0.3 的 drift 清单从备份恢复既有 provider（新 provider 与 xai merged catalog 保持）。
- [x] 更新 AGENTS.md、README 或 provider 说明前，先区分“代码已存在”“focused tests 通过”“生产组合通过”“真实 provider E2E 通过”；不要把历史 pi-ai 全量移植描述成当前新增 provider 已完成。→ AGENTS.md 已按四个层级分别记录（见本文件 §7 状态表与 AGENTS.md §1.2 追加段）。
- [x] 将每个 provider 的状态写成 implemented、partial、deferred 或 blocked，并附测试命令、source commit、target commit 和未闭合原因。→ §7 状态表：30 个新 factory + llama.cpp 为 partial（无真实凭据 E2E），azure/moonshot/xai-oauth 为 identity 映射（auth-only/catalog 同步，documented），C 批次 8 个 deferred，zai-coding-plan/openai-codex-device/搜索工具类为专项 deferred。
- [x] 只对 provider 变更做 scoped diff review；当前 TUI/CLI dirty 修改不得进入 provider commit。→ 本批全部变更在独立 worktree；git diff --check 0 告警；子 agent 误创建的 1 个 commit（仅含其 14 个文件）已用 mixed reset 撤销回工作树，未获授权前不保留任何 commit。

## 4. 测试与验收门槛

### 4.1 每个 provider 的最小测试集合

- [x] factory：ID/name/base URL/headers/auth 类型唯一且符合矩阵。→ per-provider 测试 + P6 smoke identity 唯一断言。
- [x] auth：stored credential、env、无凭据、错误 credential、logout、OAuth refresh（适用时）。→ envApiKeyAuth 路径全测；kimi-code OAuth refresh 8 tests；kilo device-auth login 7 tests；logout 走 CredentialStore.delete（既有合同，由 auth 测试覆盖）。
- [x] catalog：静态/动态模型 schema、model identity、API、compat、limits、thinking、image capability。→ 生成物 schema 由 tsc 全量校验；per-provider 测试验证 identity/api/baseUrl/compat/limits；vision 模型输入模态在 vendored 映射中保留。
- [x] stream：text delta、reasoning、tool call、usage、done/error、abort、HTTP 错误和 provider-specific headers。→ SSE fixture 全链测试（aiand 模板 + 受控本地 server 真实流）；coreweave OpenAI-Project、kimi-code KimiCLI headers 断言在各自测试中。
- [x] discovery：成功、认证失败、超时、空列表、坏 payload、重复 ID、取消、last-known-good 和 store scope。→ 各动态 provider 测试覆盖成功/HTTP 错误/空/坏 payload/dedup/last-known-good；abort 经 context.signal 传入 fetch fixture。
- [x] composition：getAvailable() 只返回已认证模型；未知 provider/API、未配置 provider 和错误模型选择均 fail closed。→ P6 smoke：未配置 → stopReason=error "Provider is not configured"；未知 API → RED 测试 stream error；getAvailable 语义由 Models 既有合同（per-provider auth 测试断言 resolve 结果）。

### 4.2 批次与全仓门禁

每个批次至少执行并记录：

    npm test -- tests/providers/<focused-tests>.test.ts
    npm run check
    git diff --check

provider catalog 或依赖变更完成后再执行：

    npm run generate-models
    npm run check
    npm test
    npm run build

## 5. 停止规则、回滚和提交边界

- [x] 来源 HEAD、provider ID 或模型 catalog 在执行中变化：停止当前批次，重新生成 P0 inventory。→ 执行全程来源 06aecdd5 与目标 b5100b2 未变化（来源工作树干净，目标 main 工作树 HEAD 未动）。
- [x] 发现 provider 依赖未支持的特殊 API、隐含 OAuth、非标准签名、native binary 或模型发现协议：停止复制，转入 B/C 批次或标记 deferred。→ C 批次 8 个特殊 API 全部按此规则 deferred；kimi-code/kilo 的真实 auth 流已移植。
- [x] 发现动态 refresh 会覆盖 last-known-good、跨 provider 读写 store、把空 catalog 当成功或会泄漏 credential：停止并先修通用合同。→ 审计：createProvider store 按 provider 隔离，坏结果 throw 保留旧列表；无缺口，未停止。
- [x] focused tests 通过但生产 builtinModels()、CLI/Host、真实 stream 未接通：只能标记 partial，不能标记 implemented。→ 本批全部 provider 标记 partial（真实凭据 E2E 未闭合）；组合链已接通（built CLI --version + Models 组合 smoke + 受控本地 server 真实流）。
- [x] 全仓门禁被当前既有 TUI dirty slice 影响：记录 baseline 与新增失败的区分，不修改无关文件来伪造通过。→ 本批在独立 worktree 运行，与主工作树 TUI dirty slice 隔离；全仓门禁 0 失败。
- [x] 每批次使用独立、可回滚的 scoped commit；未得到提交授权前只保留工作树改动。任何回滚必须只针对本批 provider 文件，不得使用 broad reset/checkout。→ 未获授权，0 commit 保留（子 agent 误建的 1 个 commit 已 mixed reset 回工作树）；全部改动留在独立 worktree。

## 6. 最终 DoD

只有同时满足以下条件，才能把“oh-my-pi 新增 provider 已移植到 RunLedger”标记为完成：

- [x] 42 个 chat/model 差集以及 registry-only provider 均有最终状态，无未解释的 ID。→ §2.1 矩阵 42 行 + registry-only 8 项全部有最终决策（新增 factory / identity 映射 / deferred / 专项外）。
- [x] 每个 implemented provider 都有 factory、auth、model source/生成物、stream、discovery（适用时）、focused regression 和 production composition 证据。→ 本批无 implemented（全部 partial/deferred，原因：真实凭据 E2E 未闭合）；每个 partial provider 均有 factory + auth + 生成物 + stream/discovery + focused tests + 组合链证据，§7 状态表逐项列出。
- [x] provider/model identity、旧配置兼容、OAuth storage key、dynamic cache scope 和 fail-closed 错误均有测试。→ identity 唯一性（P6 smoke）、azure/moonshot/xai-oauth 无迁移即无丢失、kimi-code OAuth credential 存 kimi-code slot（flow tests）、store scope（per-provider scoped helper tests）、fail-closed（P6 smoke + RED）。
- [x] npm run check、npm test、npm run build 以及对应真实/隔离 smoke 的结果都来自目标 commit；历史结果或来源仓库结果只能作为参考。→ 2026-08-16 在目标 worktree b5100b2 上实测：check 0 error；Vitest 410 files / 2503 tests passed（3 skipped）；Bun TUI 98/98；build passed；focused providers 34 files / 229 tests；隔离 smoke 2 项 passed。
- [x] 生成文件可由目标 generator 重建，依赖/许可证/Node-Bun/打包影响已审阅，未复制 Oh My Pi 的不适用全局架构。→ vendored snapshot + scripts/ported-provider-catalog.ts 两次运行逐字节复现；0 新增依赖；无 Bun-only 模块；来源全局 registry 未复制。
- [x] 文档状态、DoD、deferred/blocker、source/target commit 和当前工作树边界已同步。→ 本文件 §0.3/§2.1/§7 + AGENTS.md §1.2 追加段；source 06aecdd5、target b5100b2、worktree 边界见 §0。

## 7. 最终状态表（2026-08-16）

来源快照 06aecdd51f07e689e970ceaa180abe2be0c14bbb（v17.2.15）；目标基线 b5100b29624bfb04cf0ea5bcb48d80a9b3e39387（session-owner-runtime）；实现 worktree `RunLedger-oh-my-pi-provider-port`（detached HEAD，未提交）。

状态定义：implemented（真实凭据 E2E 已闭合）/ partial（代码+自动化门禁闭合，真实凭据 E2E 未闭合）/ deferred（目标无 transport 或依赖审计未闭合）/ identity-mapped（不新增 provider ID）。

| id | 状态 | 证据 |
|---|---|---|
| aimlapi / baseten / coreweave / firepass / gmi-cloud / litellm / lm-studio / nanogpt / novita / qianfan / siliconflow / siliconflow-cn / synthetic / venice / vllm / zhipu-coding-plan | partial | A 批次 16 factory + tests（113 tests）；focused 全绿；无真实凭据 → pending-real-provider |
| alibaba-coding-plan / alibaba-token-plan / bedrock-mantle / kilo / kimi-code / meta / minimax-code / minimax-code-cn / opencode-zen / qwen-portal / sakana / umans / wafer-serverless / zenmux | partial | B 批次 14 factory + tests（98 tests；含 kimi-code OAuth flow 8 tests、kilo device-auth 7 tests）；无真实凭据 → pending-real-provider |
| aiand | partial | 上轮已交付，本轮保持（真实 credential E2E 仍待验证） |
| llama.cpp | partial | registry-only 决定实现：purely dynamic factory + 5 tests（本地 sentinel 语义）；受控本地 server smoke 覆盖 local wire |
| azure | identity-mapped | → 已有 azure-openai-responses（AZURE_OPENAI_API_KEY/AZURE_OPENAI_BASE_URL/AZURE_OPENAI_RESOURCE_NAME 目标 adapter 已支持）；不新增 ID |
| moonshot | identity-mapped | → 已有 moonshotai + KIMI_API_KEY fallback env（auth-only 变更） |
| xai-oauth | identity-mapped | → 已有 xai provider 的 OAuth 路径；来源 8 个 openai-responses 模型并入 xai catalog（3 个同 id completions 条目保留目标现状，5 个新增） |
| cursor / devin / gitlab-duo / gitlab-duo-agent / google-antigravity / google-gemini-cli / ollama / ollama-cloud | deferred | 目标无 cursor-agent/devin-agent/gitlab-duo-workflow/ollama-chat/特殊 Google 流；RED 测试（tests/providers/special-protocol-red.test.ts）锁定 fail-closed；解封条件见 §P4 |
| zai-coding-plan / openai-codex-device | deferred（auth 专项） | 已有 zai/openai-codex 的 auth 变体，共享 catalog；OAuth 流移植另建计划 |
| exa / kagi / parallel / perplexity / tavily | 专项外 | 搜索/工具/辅助认证范畴，不在 chat provider DoD |

未闭合项（阻塞 implemented）：
- 全部新 provider 无真实凭据/API E2E（受控本地 server smoke 只覆盖 local wire）；有安全凭据后逐 provider 补真实连接。
- 动态 catalog 持久化仍为进程内 InMemoryModelsStore（P0 结论）；跨进程 durable 恢复不宣称。
- generator 的 live models.dev 网络依赖未修（既有问题）：断网时需按 §P7 程序恢复既有 provider 漂移。
- Bun standalone bundle 的 kimi-code OAuth 静态注册已接线（bun-oauth.ts），未做 Bun binary 打包实测。

验证命令（全部来自目标 worktree）：
```
npm run check                                                  # 0 error
./node_modules/.bin/vitest run tests/providers/ tests/auth/kimi-code-oauth.test.ts --no-file-parallelism   # 34 files / 229 tests
npm test                                                       # 410 files / 2503 tests passed, 3 skipped; Bun TUI 98/98
npm run build                                                  # passed
RUNLEDGER_DIR=$(mktemp -d) npx tsx tmp/smoke-provider-port.ts  # 68 providers 唯一, fail-closed, env auth
npx tsx tmp/smoke-local-server.ts                              # 真实 HTTP discovery + SSE stream (vllm local wire)
RUNLEDGER_DIR=$(mktemp -d) node dist/cli/cli.js --version      # 编译产物组合链
git diff --check                                               # 0 告警
```
