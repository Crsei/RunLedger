# oh-my-pi monorepo（packages / crates / 非 TS 树）对照与缺口报告

> 基线日期：2026-09-18（调查时点）。
> 上游快照：`oh-my-pi` `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`（2026-09-17），workspace 版本 `18.2.4`。
> 目标快照：RunLedger 工作树，分支 `rollback/before-composer-shape`，HEAD `0b2c501b194e0a65d80741dfe650814ea9de42dc`（含未提交改动）。
> 本文是**对照事实记录**，不是实施计划，也不改变任何模块的 authority。阶段状态仍查各专题入口。

**这是第 2 轮。** 第 1 轮见 [`00-oh-my-pi-coding-agent-module-gap-report.md`](00-oh-my-pi-coding-agent-module-gap-report.md)，口径为 `oh-my-pi/packages/coding-agent/src` 单一包。本轮口径是 monorepo 的**其余部分**：`packages/*` 中除 `coding-agent` 外的 15 个包、`crates/*` 的 10 个 Rust crate、以及 `python/`、`nix/`、`bazel/`、`infra/`、`types/` 等非 TS 树。两轮不重叠，但 §7 给出合并视角。

---

## 0. 口径与引用约定

- 上游路径相对 `oh-my-pi/`，写作 `packages/<pkg>/<file>`、`crates/<crate>/<file>`、`python/<proj>/<file>`。
- 上游仓库位置（本机）：`../oh-my-pi`（与 `RunLedger` 同级）。
- RunLedger 路径相对 `RunLedger/`，写作 `src/<module>/<file>`、`packages/collab-web/<file>`、`native/<crate>/<file>`。
- **本口径内的「上游」是 monorepo 的全部 16 个包**，即第 1 轮的 `coding-agent` 也属于 monorepo；但本报告只在交叉引用时提及它，明细不重复（归 00）。
- 兄弟包不再作为「口径外」排除——这正是本轮存在的理由。凡 RunLedger 的对等物通过第三方 npm 依赖或平台能力满足的，一律显式标注依赖名，不记为 `absent`。
- 「文件数」为递归计数（含子目录、资源、测试、`research/` 等），由 §9 复现命令生成。

## 1. 方法与 `rl_mode` 定义

第 1 轮只有定性状态（`full` / `partial` / `absent`）。本轮增加一个正交维度 `rl_mode`，因为「缺口」在 monorepo 尺度上分两种完全不同的情况：

| `rl_mode` | 含义 | 处理方式 |
|---|---|---|
| `ported` | RunLedger 有自己的实现（列出文件） | 按 `status` 判定覆盖度 |
| `third-party` | RunLedger 不自己实现，改用等价 npm 依赖或平台能力（点名依赖） | **不是缺口**，但需比较语义等价性 |
| `absent` | 既无实现也无等价依赖，且无产品面 | 真缺口 |

判定步骤：

1. 读上游 `package.json`（name / description / `exports`）与 `src/` 目录，读入口文件的实际导出面。
2. 在 RunLedger 内检索对应符号与类型名、探测可能路径，并核对 `RunLedger/package.json` 依赖与 `RunLedger/packages/`。
3. 定 `rl_mode` 与 `status`。
4. **路径必须验证存在后才能写入。** 第 1 轮出现过编造子路径（`commands/index.ts`）与拼错目录（`pidiscovery`），本轮所有引用均经 §9 的校验脚本解析通过。

## 2. 仓库形态与规模对照

这是本轮最重要的结构性发现：**两侧不是同一种工程形态。**

| 维度 | oh-my-pi | RunLedger |
|---|---|---|
| workspace 声明 | `packages/*` + `python/robomp/web` | `packages/*`（实际只有 1 个成员） |
| TS 包数 | **16** | **1**（单一 private 包 `runledger`） |
| 包级依赖图 | 有向无环，`wire` / `omptype` / `natives` / `browser-relay` 是叶子 | 无包边界；`src/` 内部按目录分层 |
| Rust crate | **11 个目录**（10 crate + `vendor/`），466 个 `.rs` | **1 个**（`native/syntax-highlighter`），3 个 `.rs` |
| 其他语言 | `python/omp-rpc`、`python/robomp` | 无 |
| 构建体系 | Bun workspace + Cargo workspace + **Bazel** + **Nix** + `infra/` runner | npm scripts + 1 个 Cargo crate |
| 包外文件数 | coding-agent 3500 / 其余 15 包合计 2559 | `src/` 1115 + 其余树 |

上游包级依赖图（内部依赖，由各 `package.json` 提取）：

```text
utils ──► natives
wire  (无内部依赖)
omptype (无内部依赖)
catalog ──► omptype, utils
ai     ──► omptype, catalog, natives, utils, wire
agent  ──► ai, catalog, natives, utils, wire, snapcompact
snapcompact ──► ai, catalog, natives, utils, wire
mnemopi ──► ai, catalog, natives, utils
stats  ──► ai, catalog, utils
tui    ──► natives, utils
collab-web ──► utils, wire
metaharness ──► agent, ai, catalog, coding-agent, natives, utils, typescript-edit-benchmark
typescript-edit-benchmark ──► agent, ai, coding-agent, natives, tui, utils
coding-agent ──► (全部 11 个包)
browser-relay (无内部依赖，devDep puppeteer-core)
```

**含义**：上游的「包」是**发布与依赖边界**，RunLedger 把这些能力全部平铺进单一 `src/`。这本身是一个已被记录的缺口——`development-doc/plan/13-package-boundary-workspace-refactor-plan.md` 的目标正是「从单一 npm 包迁移到 contracts、AI、core、product-TUI 与 runledger app 的单向 workspace」，当前状态 `planned / staged`。因此 §3 中凡 RunLedger「有实现但无包边界」的条目，`status` 仍按能力覆盖度判，包边界差距在 §7 单独记一条。

## 3. 包级对照（`packages/*`，16 个）

`coding-agent` 见 00；下表为其余 15 个。

| # | 包 | 文件数 | 上游能力（`description`） | `rl_mode` | `status` | RunLedger 对等物 / 缺口 |
|---|---|---|---|---|---|---|
| 1 | `agent/`<br>`@oh-my-pi/pi-agent-core` | 98 | 通用 agent：传输抽象、状态管理、附件；`exports: ., ./compaction, ./compaction/*` | `ported` | `partial` | 对等物：`src/runtime/agent-loop/*`（含 `loop-runner.ts`）、`src/runtime/agent.ts`、`src/runtime/types.ts`、`src/runtime/execution-env.ts`、`src/runtime/context/compaction/*`、`src/runtime/context/context-engine.ts`、`src/runtime/session-runtime/compaction-domain.ts`。<br>**这是第 1 轮标记的 compaction 归属包。**已实现：切点/预算（`compaction/budget.ts`、`cut-planner.ts`）、迭代 update 与摘要格式校验（`summary-format.ts` 的 `headings@1`/`headings-update@1`/`handoff-document@1`）、文件清单（摘要的 `Files and tool outcomes` 段）、投影剪枝（`projection-prune.ts`）、handoff（`summary-strategies.ts`）、provider 原生 V2 + length-stop 有界恢复（`src/api/openai-responses.ts`、`loop-runner.ts` 的 `MAX_INCOMPLETE_RECOVERIES`）、durable checkpoint（`record.ts`、`checkpoint-store.ts`）。<br>缺失：`src/compaction/branch-summarization.ts`（分支摘要，**已判定拒绝**）、`src/compaction/shake.ts`（重块替换，O7 blocked）、snapcompact 归档（O6 deferred）、`append-only-context.ts`、`replay-policy.ts`、`pause.ts`（进程级暂停门）、`run-collector.ts` + `telemetry.ts`（run 级 span；`@opentelemetry/api` 在 `package.json` 中声明但 `src/` 无引用）。 |
| 2 | `ai/`<br>`@oh-my-pi/pi-ai` | 772 | 统一 LLM API：模型发现、provider 配置、auth、judgment、usage | `ported` | `partial` | 对等物：`src/api/*`（11 个协议族：`anthropic-messages`、`openai-responses`、`openai-completions`、`openai-codex-responses`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex`、`mistral-conversations`、`azure-openai-responses`、`pi-messages`）、`src/models.ts`、`src/models-store.ts`、`src/providers/all.ts`、`src/auth/*`、`src/auth-gateway/*`、`src/storage/auth-storage.ts`、`src/runtime/usage/index.ts`。<br>**语义差异**：上游约 50 个 provider 适配器多为手写 wire 实现（`anthropic.ts` 226KB、`openai-shared.ts` 160KB、`cursor.ts` 199KB）；RunLedger 的 11 个协议族是**薄层**，跑在官方 SDK 上（`@anthropic-ai/sdk`、`openai`、`@google/genai`、`@mistralai/mistralai`、`@aws-sdk/client-bedrock-runtime`）。<br>缺失子域（均为 `absent`）：<br>• `src/dialect/`（40 文件：harmony、glm、kimi、gemma、gemini、deepseek、qwen-xml/qwen3、hermes、minimax、`thinking.ts`、`rendering.ts`、`owned-stream.ts`、coercion/demotion/catalog/inventory + 每方言 `.md`）——全仓无 dialect 模块；残留仅是 `src/api/openai-completions/params.ts` 内联的 `thinkingFormat` 分支。<br>• `src/judgment/`（`text.ts`、`chat.ts`、`typesafe.ts` + LLM-as-judge 提示词）——`grep judgment` 0 命中，与 00 §3 #18 一致。<br>• `src/usage/`（`UsageWindow`/`UsageAmount`/`UsageStatus` 配额模型 + 约 20 个 provider 订阅额度探针：claude 34KB、google-antigravity 26KB、openai-codex 25KB、zai、kimi、github-copilot 等）——`src/runtime/usage/index.ts` 是**另一个关注点**（按请求的 token/cost/TTFT 投影），非配额窗口。<br>• `src/auth-broker/`（`remote-store.ts` 62KB、snapshot-cache、refresher、discover、wire-schemas）——`grep broker` 0 命中；跨进程凭据走 `src/auth-gateway/*` + `src/storage/auth-storage.ts` + `src/storage/runtime-credentials.ts`。<br>• 缺 provider 适配器：cursor、devin、gitlab-duo(+workflow)、ollama、kimi、google-gemini-cli、wire-protocol server 三件套、openai-reasoning-fallback。<br>• 缺 OAuth 流：perplexity、google-gemini-cli、google-antigravity、cursor、kilo、zai、xiaomi、muse-code、cloudflare-ai-gateway、coreweave、alibaba-*、gitlab-duo、native-scheme-callback、`callback-server.ts`。<br>部分覆盖：`src/error/`（16 文件约 120KB，含 41KB 错误标志分类表与 21KB rate-limit 解析）→ 仅 `src/utils/error-body.ts` + `src/utils/retry.ts` + `src/api/openai-codex-responses/errors.ts` + `src/api/bedrock-converse-stream/errors.ts`，**无集中 flag 分类、无 Retry-After/限流响应解析**；`src/registry/` → `src/providers/all.ts`（70+ provider）+ `src/auth/oauth/*`（10 文件）；`src/utils/`（thinking-loop 24KB、stream-markup-healing、tool-call-loop-guard、empty-completion-retry、harmony-leak、http-inspector、retry-after）→ 无对应。<br>另有 `src/api-registry.ts`、`provider-details.ts`、`provider-session-state.ts` 无对应（`src/index.ts` 自述 no api-registry）。 |
| 3 | `browser-relay/` | 11 | Chrome 扩展，让 omp browser 工具驱动用户已有标签页（relay server 在 coding-agent CLI） | `absent` | `absent` | 无对应。两次检索均 0 命中：`grep -iE 'puppeteer\|playwright\|chrom[ei]\|CDP\|devtools\|webdriver\|browser-relay'` 覆盖 `src/` + `tests/` + `package.json`；`grep -iE 'browser\|navigate\|screenshot\|tab'` 覆盖 `src/runtime/tools/` 只命中注释里的 tab 格式化。`glob **/manifest.json`、`**/background.ts` 只命中测试夹具。无 `puppeteer-core`/`playwright` 依赖。 |
| 4 | `catalog/`<br>`@oh-my-pi/pi-catalog` | 416 | 模型目录：内置模型库、provider 发现描述符、模型身份、分类与等价性 | `ported` | `partial` | 对等物：`src/providers/data/*.json`（约 160 个 provider 目录，最大 nanogpt 659KB、kilo 372KB、openrouter 310KB、aimlapi 218KB）、`src/providers/*.models.ts`、`src/models.generated.ts`、`src/model-catalog.ts`、`src/models.ts`、`src/models-store.ts`、`src/providers/updated-provider-discovery.ts`、`src/providers/proxy-discovery.ts`、`src/runtime/model-routing/*`、`src/cli/model-compatibility-manifest.ts`。<br>**打包方式不同**：上游是单个 10.4MB `src/models.json` + `src/provider-models/`（`openai-compat.ts` 266KB、descriptors、special、google、ollama、bundled-references、models-dev-policies、cline-pass）；RunLedger 是每 provider 一个 JSON + 类型派生，经 `flattenModelCatalog` 汇总。<br>缺失引擎：<br>• `src/identity/`（`id.ts`：裸模型 ID 命名空间剥离、family 前缀抽取、reseller 标签去括号；`reference.ts`、`priority.ts`、`bundled.ts`、`dialect.ts`、`metrics.ts`）——**无跨 provider 等价性、无规范身份解析、无 provider 优先级排序**。RunLedger 只有用户自填 alias（`model-routing/router.ts` 的 `ModelCompatibilityManifestDocument.aliases`）与 per-provider 的临时归一（`updated-provider-discovery.ts` 的 `cline-pass/` 前缀处理）。<br>• `src/compat/`（KDL `rules/` 树经 `scripts/compile-compat.ts` 编译成 275KB `rules.json` = `CompiledCompatRules`；`resolve.ts` 50KB、`collapse.ts` 52KB 跨 provider 元数据合并、axes/behavior/cascade/taxonomy/revision/context-window/delegation/provider-ids/auth-ids/apply）——RunLedger 是**手写启发式**：`src/api/openai-completions/compat-detection.ts`（约 140 行）、`src/api/anthropic-messages/types.ts` 的 `getAnthropicCompat`、`src/api/openai-responses.ts` 的 `getCompat`，加 per-model `compat` 字段。**无规则树、无编译脚本、无 collapse/等价合并**。<br>• `src/discovery/`（12 适配器，多个基于 protobuf/gRPC：`cursor-proto.ts` 322KB、`devin-proto.ts` 87KB、`protobuf.ts` 29KB、`gitlab-duo-workflow.ts` 28KB、antigravity、codex、gemini、gemini-cli、devin、cursor、openai-compatible）——RunLedger 的 `updated-provider-discovery.ts` 只覆盖 4 个 provider（abliteration、cline-pass、deepinfra、yolo-auto）；`grep protobuf\|grpc` 0 命中。<br>• 缺 `model-tokenizer.ts`——token 计数由 `src/runtime/context/token-estimator.ts` 做保守字节估算，**明确回避 provider tokenizer**。<br>部分覆盖：`model-manager`/`model-cache`/`model-thinking`/`pricing` → `src/models.ts` + `src/models-store.ts`；`wire/`（github-copilot、gemini-headers、codex 等）→ `src/api/github-copilot-headers.ts` + `src/api/cline-pass-headers.ts`，无 `image-fetchers`。 |
| 5 | `collab-web/` | 101 | 浏览器访客客户端 + 本地 relay 工具（collab 实时会话） | `ported` | `partial` | 对等物：`packages/collab-web/*`（本仓库自己的 workspace 包，含 `src/contracts/**`、`src/App.tsx`、`src/lib/{session-store,api,events,child-history,format}.ts`、`src/components/{Usage,Capabilities}.tsx`、`src/components/transcript/*`、`src/components/children/ChildDrawer.tsx`、`src/tool-render/*`）+ `src/web/*` 提供本地服务端。<br>**形态差异**：上游是**可交互的实时协作访客端**；RunLedger 是**只读本地可观测 SPA**（`src/App.tsx` 带 READ ONLY 标识）。`packages/collab-web/README.md` 与 `THIRD_PARTY_NOTICES.md` 逐文件记录了适配关系（源 commit `3b3a6dc9bb`）。<br>已移植：Transcript + Markdown（尾部锁定、gutter 行、thinking 折叠、HTML 转义）、tool-render 注册表/`ToolView` 折叠卡（基于有界文本 DTO）、有界历史窗口 + SSE 追赶 + 旧页游标（`lib/session-store.ts`、`lib/child-history.ts`）、Usage/Capabilities 面板、静态打包（`scripts/build.ts` → `dist/web/assets`）。<br>缺失（`README` 明示不迁移）：relay（上游 `scripts/local-relay.ts` + `lib/socket.ts`/`client.ts`）、room key / join link（`lib/link.ts`、`lib/codec.ts`）、pi-wire 数据模型（上游依赖 `@oh-my-pi/pi-wire`）、全部写/交互面（`Composer.tsx` 发送消息、`ConnectScreen`、`HeaderBar`、`Banners`、`Toasts`、`ThemeToggle`）、`components/agents/{AgentsPanel,AgentDrawer}` 的 kill/revive/chat（以只读 `ChildDrawer` 替代）、生成的 `tool-render/tools/**` 视图集与 `parts`/`element`/`standalone` 渲染器、katex 数学渲染。 |
| 6 | `metaharness/`<br>`@oh-my-pi/pi-metaharness` | 41 | 统一 benchmark runner + Harbor run 存储 + REST/SSE + 实时看板 | `absent` | `absent` | 上游已实现（private 包，`src/server.ts` 起常驻 Bun.serve，`ManagerServer` 提供 `GET/POST /api/experiments`、`/api/experiments/:id/arms`、`GET/POST /api/runs`、`/api/runs/:name/cancel\|resume`、`GET /api/events` SSE；`src/runner.ts` 61.6KB、`src/store.ts` 19.6KB、`src/web/app.tsx` 65.9KB、`src/tb/*`、`src/adapters/snapcompact.py`）。<br>RunLedger **仅文档**：`development-doc/bench/README.md` 状态表 P0–P6 全 `planned`、P7 `deferred`，并明写「当前无已完成的评测能力」；`grep bench-runs\|benchmark-runner\|task-pack\|TaskPack\|harbor\|metaharness` 覆盖 `src/` + `tests/` 0 命中。<br>注意：RunLedger 已有自己的参考文档 `development-doc/bench/00-oh-my-pi-metaharness-reference.md`，其中采纳/拒绝结论已冻结（采纳 experiment→run→trace 三阶段与 arm 语义、文件系统为真相源 + 只读规范化 store、按 arm 继承数据集、resume 复用已完成 trial、宿主侧凭据注入、增量成本、超时/预算/并发门、只读投影看板；拒绝 Docker/microVM 任务执行、第二常驻 HTTP 服务、Harbor/terminal-bench 数据集依赖、`bun pm pack` 跨平台分发、`danger-full-access` 作为无人值守默认、远程 trace exporter）。 |
| 7 | `mnemopi/`<br>`@oh-my-pi/pi-mnemopi` | 152 | 本地 SQLite 记忆引擎 | `ported` | `partial` | 对等物：`src/runtime/context/memory/{store,persistence,schema,types,projection}.ts`、`src/cli/runtime-host-model-context.ts`、`src/runtime/tools/plan-memory-tools.ts`、`src/runtime/session-owner/` 相关命令、`src/tui/commands/registry.ts`。<br>RunLedger 实现的是**治理导向、自有设计**的 MemoryStore（proposal → approve/reject/revoke、revision fence、精确 schema、规范事件 `memory.proposed/approved/revoked/search_recorded`、`MEMORY.md` 投影、Host domain 命令端口、`/memory` + `/remember` + 有界模型工具），**不是 mnemopi 的移植**。<br>缺失：<br>• **无 embedding / 向量检索**——检索是词法分词匹配（`store.ts` 的 `mode: "lexical"`），`schema.ts` 的 `MemorySearchReceipt.mode` 联合类型里有 `"vector"` 字面量但**无生产者**；无 `fastembed`/`onnxruntime` 依赖。<br>• **无 SQLite 记忆库**——持久化是单个 version-1 JSON 快照 `workspace-memory.json`（`atomicWrite`）；RunLedger 的 `node:sqlite` 只用于 session store 与 trajectory index。<br>• 无 `core/beam/*`（`store.ts` 38.2KB、`recall.ts` 41.3KB、`consolidate.ts` 36.8KB、`helpers.ts` 24KB）。<br>• 无 `migrations/`、无 `dr/recovery.ts`；无 `core/{extraction,episodic-graph,patterns,entities,vector-index,weibull,local-llm,orchestrator}.ts`。<br>• 无独立 `mnemopi` CLI（上游 `src/cli.ts` 13.9KB）；无 memory MCP server（上游 `mcp-server.ts` + `mcp-tools.ts` 32.1KB）——RunLedger 的 `src/extensions/mcp/*` 是 MCP **客户端**。<br>• `status: partial` 与项目自身判定一致：`development-doc/plan-compact-memory/01-implementation-plan.md` 固定为 `core partial / production unavailable`。 |
| 8 | `natives/`<br>`@oh-my-pi/pi-natives` | 46 | N-API 原生绑定：PDF 转换、音频、WebRTC、grep、剪贴板、图像处理、语法高亮、PTY、shell | `third-party` | `partial` | RunLedger 唯一自有原生件是 `native/syntax-highlighter`（`Cargo.toml`：cdylib + `napi` 3.12.1 + `syntect` 5.3.0 + `two-face` 0.5.1；经 `optionalDependencies` 的 `@runledger/syntax-highlighter-{linux,darwin,win32}-*` 分发，由 `src/tui/highlight/native-loader.ts` 与 `native-package.ts` 加载），加 `native/linux-peer-credential.c`（`SO_PEERCRED`，由 `scripts/build-linux-peer-credential-helper.ts` 构建）。<br>**上游约 15 个能力族中，只有语法高亮有自有原生实现**；PTY 与 bash AST 委托给第三方：<br>• PTY（`pty.rs`、`PtySession`）→ `node-pty@1.1.0`（`scripts/verify-managed-process-pty.ts`）。<br>• grep/glob/fd 加速器（`grep.rs` 93.3KB、`glob.rs`、`fd.rs`）→ 纯 TS `src/runtime/tools/{grep,glob,ls}.ts`，**无 ripgrep 依赖**。<br>• AST（`ast.rs` 46.7KB、`EditSession`/`EditStore`）→ `web-tree-sitter@0.25.10` + `tree-sitter-bash@0.25.1` + `web-tree-sitter-bash`（仅 bash；`scripts/check-bash-ast-assets.ts`）。<br>• diff/patch（`pi-diff`、`structuredPatchHunks`）→ 见 §4 `pi-diff`。<br>• shell（`shell.rs`、brush-core）→ node 子进程 + 受治进程层。<br>• VCS（`vcs.rs` 42.3KB）→ 见 §4 `pi-vcs`。<br>• 文件锁（`FileLock`）→ `proper-lockfile@4.1.2`。<br>**完全缺失且无替代**：PDF 转换（`pdf.rs`、`pdfToMarkdown`）、音频（`audio.rs`、`AudioCapture`/`AudioPlayback`）、WebRTC（`LiveWebRtcPeer`）、桌面自动化/可访问性（`desktop/`、`DesktopSession`、macOS 拼写检查）、剪贴板（`copyToClipboard`/`readImageFromClipboard`）、图像处理（`encodeSixel`/`decodeSixelToPng`、`rasterizeSvg`、`renderSnapcompactPng`、编译内嵌的 BDF/TTF 字体）、token 计数（`tokens.rs` + `utok` BPE，含 Claude/O200k/DeepSeek/Kimi/GLM 编码）、快照/COW（`pi-iso`、`isoStart`/`isoDiff`）、`devicecheck`、hashline 助手。<br>一致于 00 §3：`tts/`、`stt/`、`live/` 的缺失在原生层同样成立。 |
| 9 | `omptype/`<br>`@oh-my-pi/omptype` | 115 | ArkType 兼容的运行时 schema 校验，惰性 JIT | `third-party` | `partial` | RunLedger 用 **`typebox@1.1.38`**（112 个文件导入 `typebox` 的 `Type`/`Static`/`TSchema`/`Value`/`Compile`）。**确认无任何代码 import omptype / arktype / arkregex / `@ark/*`**（`grep` 0 命中）。<br>**语义不等价**：上游 omptype 是 ArkType 兼容的重实现（`type()`/`Type`、字符串内嵌定义、keyword 模块、递归 scope、morph/pipe、结构化错误路径、惰性 JIT 编译，核心 `type.ts` 147.4KB / `ir.ts` 60.5KB / `compile.ts` 39.9KB），并且**自带 TypeBox 互操作层**（`src/typebox.ts` 21.5KB）、zod 适配（`zod.ts` 18.7KB）、JSON-Schema 双向（`json-schema.ts`、`from-json-schema.ts`）。TypeBox 是 JSON-Schema 优先 + `Static<T>` 推导，**不用作 ArkType API**。<br>RunLedger 实际用法：`src/utils/typebox-helpers.ts`（`Type.Unsafe` 造 Google 兼容字符串枚举）、`src/utils/validation.ts`（`Value.Convert` 强转、`WeakMap` 缓存 `Compile` 校验器、非 TypeBox schema 的手写 JSON-Schema 回退、`TLocalizedValidationError` 路径格式化）、`src/contracts/extensions/*`、`src/runtime/protocol/*-schemas.ts`、`src/runtime/context/{context,compaction,memory}/schema.ts`、`src/extensions/host/bootstrap.ts`、`src/cli/runtime-host*.ts`、`packages/collab-web` 契约。<br>缺口性质：**API/错误消息兼容面**，非校验能力缺失（工具入参、扩展/契约、runtime 协议、settings 均有 schema）。无 ArkType 风格 fluent/字符串定义、无 morph/narrow 管道、无 keyword 模块/scope 递归 API、无 zod 兼容入口、无 `from-json-schema` 派生、惰性 JIT 行为不同（typebox `Compile` 生成检查函数并按 schema 缓存）。 |
| 10 | `snapcompact/`<br>`@oh-my-pi/snapcompact` | 119 | 面向 vision 模型的原位图帧上下文压缩 | `absent` | `absent` | 上游：`src/snapcompact.ts`（91KB）+ `src/prompts/{snapcompact-summary.md,file-operations.md}` + 36 个 `research/*.py` 实验脚本。<br>RunLedger：**`src/` 内 0 引用**；`grep -i snapcompact` 只命中 `development-doc/`（本报告、`compact/*`、`bench/00`）。原生侧 `crates/pi-natives/src/snapcompact.rs`（57.4KB）与 `renderSnapcompactPng` 亦无对应（见 §4 #8）。<br>**已决策延后**：`development-doc/compact/README.md` 的 O6 为 `deferred`，触发条件为「原生渲染 + 图像投影通道 + 媒体契约 + vision 计费」四项齐备。coding-agent 侧的 `session/snapcompact-inline.ts` 与 `snapcompact-savings-journal.ts` 同样缺失（00 §4 `session/`）。 |
| 11 | `stats/`<br>`@oh-my-pi/omp-stats` | 109 | 本地 AI 用量统计看板 | `ported` | `partial` | 上游：`bin omp-stats`，`src/db.ts` 74.1KB、`aggregator.ts`、`gain-aggregator.ts`、`usage-windows.ts`、`user-metrics.ts`、`trace.ts`、`parser.ts`、`sync-worker.ts`、`port-conflict.ts`、`embedded-client.ts`；`src/client/app/routes.ts` 定义 `DashboardSection = overview\|requests\|traces\|errors\|models\|providers\|tools\|costs\|behavior\|projects\|gain`，配 11 个 `*Route.tsx` 与 `client/traces/{TimelineCanvas,TraceView,SpanDrawer,Minimap,AggregatesPanel}.tsx`。<br>RunLedger 对等物：`src/web/usage.ts`（`WebUsageReader`：按项目按需分批 SQL + trace 扫描，5 批循环、200 事件页、100 trace 事件页、2s/30s 新鲜度、2 项目缓存、degraded/complete 标志）、`src/web/usage-projection.ts`（按 `sha256(originSessionId,callId)` 去重、provider/metered/estimated 来源、精确与估算分别求和、`missingCalls`、覆盖率 `complete\|partial`）、`src/web/server.ts` 路由表、`packages/collab-web/src/components/Usage.tsx`。<br>已覆盖：项目级时间窗用量汇总（input/output/cacheRead/cacheWrite/costUsd，各带 `{exact,estimated,missingCalls}`）、`uniqueCalls`、`asOfMs`、来源归因、覆盖率对账状态、只读 HTTP + SSE——即上游 Overview + Costs + Projects 的一个子集。<br>缺失：全部 11 个分析路由，尤其 `behavior` / `errors` / `gain`（`gain-aggregator.ts` + `GainTimeSeriesPoint`）/ `models` / `providers` / `tools` / `traces`（含时间线画布、minimap、span drawer、聚合面板）；`usage-windows.ts` 的 `DailyActivityPoint` 热力图窗口、`user-metrics.ts` 的 TTFT/时长/tokens-per-second/高级请求计数（`grep heatmap\|DailyActivity\|gain\|providerLatency` 0 命中）；**无聚合 SQLite 仓库**（`db.ts`/`aggregator.ts`/`sync-worker.ts` 的 sync 管线）——RunLedger 是惰性重扫描 + 仅缓存展示投影；无独立 `omp-stats` CLI（`-j`/`-s`/`--port`）、无端口冲突处理、无内嵌客户端 bundle 生成器。与 00 §4 `stats/` 的 activity-worker 协议缺失互为上下层。 |
| 12 | `tui/`<br>`@oh-my-pi/pi-tui` | 162 | TUI 库：差分渲染 | `third-party` | `partial` | **确认 RunLedger 无 pi-tui 依赖**（`package.json` 与 `package-lock.json` 中无 `@oh-my-pi/pi-tui`，也无 `@earendil-works/pi-tui`），改用 **`@opentui/core@0.4.5`**（原生预编译件 `@opentui/core-<platform>`）+ 自有 `src/tui/*`（179 个 ts，其中 `src/tui/opentui/` 38 文件）。<br>RunLedger 用**一个文件**重建了一个 pi-tui 形状但更小的底层面：`src/tui/primitives.ts`（876 行：`Component`/`Focusable`、`Container`、`Box`、`Spacer`、`SelectList`+`SelectItem`+`SelectListTheme`、`Editor`+`EditorTheme`、`Markdown`+`MarkdownTheme`、`TUI extends Container`、`ProcessTerminal`、overlay 类型/handle、`Key`/`matchesKey`/`parseKey`/`isNavigationKey`、`TUI_KEYBINDINGS`/`KeybindingsManager`、OSC-11 解析）与 `src/tui/text-layout.ts`（`visibleWidth`/`sliceByColumn`/`truncateToWidth`/`wrapTextWithAnsi`/`hyperlink`，基于 `string-width` + `strip-ansi`）；其余映射到 OpenTUI renderable（`BoxRenderable`、`TextRenderable`、`MarkdownRenderable`、`TextareaRenderable`、`InputRenderable`、`SelectRenderable`、`ScrollBoxRenderable`、`CodeRenderable`），见 `src/tui/opentui/component-runtime/{frame-runtime,overlay-runtime,renderable-registry}.ts`。<br>已覆盖族：box/container、spacer、text、select-list、editor（自有 `Editor` + `RunLedgerTextareaRenderable` 子类）、markdown（自有 + `MarkdownRenderable` + `markdown-budget`/`settled-prefix`/`streaming-table-split`）、scroll（`ScrollBoxRenderable` + 自有 `viewport-window.ts` 的 `HeightIndex` 虚拟窗口）、input、loader（自有 `opentui/shimmer.ts` + `shimmer-status-line.ts`）、keybindings、theme 色槽。<br>**缺失族（无等价物）**：`components/composer/*` 形状系统（band、field、rule、box、borderless、rail、pi、claude、registry——RunLedger 只有 `src/tui/footer/field-registry.ts` + `editor-height.ts`）、`tab-bar.ts`、`settings-list.ts`、`truncated-text.ts`、`image.ts` 与终端图像协议（`kitty-graphics.ts`、`terminal-capabilities.ts` 57.1KB、sixel 全族——RunLedger 只有 `src/tui/components/image-paste-overlay.ts` 插入路径）、`cancellable-loader.ts`、`autocomplete.ts`（43.8KB）+ `fuzzy.ts`（14.2KB；`grep fuzzy\|autocomplete` 0 命中，RunLedger 用静态过滤的 `slash-command-popup`/`searchable-selector-modal`）、`vim.ts`、`latex-to-unicode.ts` + `latex-block.ts` 数学渲染、`deccara.ts` SGR 矩形优化、`mouse.ts`（交由 OpenTUI）、`stdin-buffer.ts`/`bracketed-paste.ts`（自有 `src/tui/input/normalize-action.ts`）、`kill-ring.ts`、`debug-server.ts`、`loop-watchdog.ts`、`desktop-notify.ts`、`terminal-multiplexer.ts`/`tmux.ts`/`ttyid.ts`、`symbols.ts`、`terminal.ts` 的真实能力探测（RunLedger `ProcessTerminal` 硬编码 `kittyProtocolActive=true`）。 |
| 13 | `typescript-edit-benchmark/`<br>`@oh-my-pi/typescript-edit-benchmark` | 20 | 基于 TS 源码变异的编辑基准套件 | `absent` | `absent` | 上游：private 包，`scripts generate`/`edit-shapes`，依赖 `@babel/parser`、`@babel/traverse`、`prettier`、`regexp-tree`、`pi-agent-core`/`coding-agent`，`fixtures.tar.gz` 241KB；`src/tasks.ts` 定义夹具目录（`prompt.md` + `input/` + `expected/` + `metadata.json`，含 `mutation_type`/`mutation_category`/`difficulty`），另有 `src/generate.ts` 42KB、`src/mutations.ts` 51KB、`src/hunks.ts`、`src/verify.ts`、`src/edit-shape-stats.ts`、`src/in-process-client.ts`、`src/formatter.ts`、`src/prompts/{structural,identifier,mutation}-task.md`。<br>RunLedger：`grep edit-benchmark\|editBenchmark\|mutation.*bench\|fixtures\.tar\|edit-shape` 无源码命中（仅 `tsbuildinfo`）；`scripts/*bench*` 与 `src/**/*bench*` 只有性能微基准（`benchmark-tui-streaming.ts`、`benchmark-syntax-highlighter.ts`、`benchmark-trajectory.ts`、`benchmark-streaming-prefix-stability.ts`），测的是渲染/原生高亮吞吐，**不是 agent 编辑准确率**。无任何 `tests/` 或 `scripts/` 逻辑把编辑结果与期望树对比评分。 |
| 14 | `utils/`<br>`@oh-my-pi/pi-utils` | 389 | 跨包共享工具 | `absent`（无逐文件移植） | `partial` | **无 RunLedger 依赖，无任何代码 import**（`grep '@oh-my-pi\|pi-utils'` 只命中 `development-doc/` 正文）。`src/utils/*`（22 文件）是一套**独立小面**，非移植：`json-parse.ts`、`retry.ts`、`headers.ts`、`provider-env.ts`、`proxy-agent.ts`、`node-http-proxy.ts`、`fetch-provider-proxy.ts`、`provider-fetch-context.ts`、`shell.ts`、`overflow.ts`、`estimate.ts`、`validation.ts`、`typebox-helpers.ts`、`uuid.ts`、`hash.ts`、`text.ts`、`sanitize-unicode.ts`、`abort-signals.ts`、`deferred-tools.ts`、`event-stream.ts`、`error-body.ts`、`diagnostics.ts`。<br>**有部分重叠（非 1:1）的族**：增量 JSON（上游 `json-parse.ts` 16.4KB + `json-lexer.ts` 13.2KB + `incoming-json.ts` 27.4KB）≈ `src/utils/json-parse.ts` 2.7KB + `partial-json` 依赖；`fetch-retry.ts` 21.8KB ≈ `retry.ts`；`headers.ts` ≈ `headers.ts`；`ptree`/`which`/`executable` ≈ `shell.ts` + node `child_process`；`tls-fetch` ≈ `node-fetch` + 代理 agent；`file-lock.ts` ≈ `proper-lockfile`；`stream.ts` ≈ `event-stream.ts`；format/color ≈ `text.ts`/`overflow.ts` + `string-width`/`strip-ansi`；async/abortable ≈ `abort-signals.ts`/`deferred-tools.ts`；`sqlite.ts` ≈ `src/storage/session-store/database.ts`。<br>**完全无对应的族**：<br>• `logger/`（`logger.ts` 27.8KB + `logger/rotating-file.ts`）——`grep logger\|rotating` 在 `src/` **0 命中**，RunLedger 无日志基础设施，只有 `src/utils/diagnostics.ts` 的错误格式化。<br>• `ar/`（完整纯 TS 归档栈：zip/tar/rar4-5/7z/iso/cab/cpio/lzh/arj/deb/rpm/asar/ar + xz/bzip2/lzma/lzx/lzw/zstd 编解码）——无归档库、无依赖。<br>• `dom/`（`core.ts` 35.6KB + `selector.ts` + `parser.ts` 服务端 HTML DOM）。<br>• `marked/`（自有 markdown 词法/语法 `core.ts` 51.4KB）——RunLedger 只在浏览器侧 `packages/collab-web` 用 npm `marked`。<br>• `turndown/`（HTML→Markdown）、`readability/`、`docx/`（`converter.ts` 24.3KB）、`vendor/mermaid-ascii`（RunLedger 有自己的 `src/tui/mermaid/` 渲染器）。<br>• `vterm/`（终端模拟器 + query-responder）。<br>• `acp/`（Agent Client Protocol 传输/连接/协议/schema）——`grep acp\|vterm` 0 命中。<br>• `postmortem.ts`、`procmgr.ts`、`ptree.ts`、`peek-file.ts`、`dirs.ts` 44.4KB、`runtime-install.ts`、`prompt.ts` 18.3KB、`lru.ts`、`worker-host.ts`、`process-name.ts`、`module-timer.ts`、`stderr-guard.ts`、`timing-buffer.ts`、`fs-error.ts`、`mime.ts`、`frontmatter.ts`、`path-tree.ts`、`math-delimiters.ts`、`tab-spacing.ts`、`version.ts`、`xml.ts`、`dates.ts`、`template.ts`、`ring.ts`、`binary.ts`、`temp.ts`、`snowflake.ts`、`env.ts`、`chalk.ts`、`cli.ts`、`color.ts`、`lru.ts` 等。<br>与本轮其他结论的呼应：`docx`/`turndown`/`readability`/`ar/` 的缺失与 00 §3 #9（`markit/` 文档转换缺失）同源；`acp/` 缺失与 00 §4 `modes/` 的 ACP 缺失同源。 |
| 15 | `wire/`<br>`@oh-my-pi/pi-wire` | 8 | 跨包共享 wire 协议类型 | `ported` | `partial` | 上游 `src/index.ts`（444 行）：`TextContent`/`ImageContent`/`ThinkingContent`/`AssistantContent`、`WireMessage`、`SessionEntry`（含 `CompactionEntry`/`BranchSummaryEntry`）、`AgentEvent`、`WireModel`、`ContextUsage`、`SessionState`、`AgentSnapshot`/`AgentProgress`、`GuestFrame`/`HostFrame`/`WireFrame`、`COLLAB_PROTO=3`、`ENVELOPE_HEADER_LENGTH`/`ROOM_ID_BYTES`/`ROOM_KEY_BYTES`/`WRITE_TOKEN_BYTES`、`DEFAULT_RELAY_URL`、`ParsedCollabLink`、`RelayControlMessage`。<br>RunLedger **有自有的无依赖 wire 层**，不是 pi-wire 的移植：自有 TCP 帧协议（`src/runtime/session-server/protocol.ts` 的 `SESSION_PROTOCOL_VERSION=3`、`SESSION_FRAME_KINDS`、`SessionFrameEnvelope`、`SessionHandshakeRequest/Response`、`SESSION_PROTOCOL_BOUNDS` + TypeBox schema，配 `client-transport.ts`、`runtime-server.ts`、`subscription.ts`，登记在 `src/runtime/contracts/inventory.ts`）与自有只读浏览器 DTO 契约包（`packages/collab-web/src/contracts/*`：common/catalog/timeline/trajectory/usage/capabilities）。<br>未迁移：collab 实时会话数据模型——`GuestFrame`/`HostFrame`（hello/welcome/prompt/ui request/response）、`CollabUiRequest`、`COLLAB_PROTO` 协商、room-key AES-256-GCM 信封常量、`ParsedCollabLink`/relay 控制消息，以及 `SessionEntry` 联合中的 `CompactionEntry`/`BranchSummaryEntry`/`collab-prompt`。这与 §3 #5 的「不迁移 relay/room key/pi-wire」是同一决策的两面。 |

### 3.1 包级判定汇总

| `rl_mode` | 数量 | 包 |
|---|---|---|
| `ported` | 7 | `agent/`、`ai/`、`catalog/`、`collab-web/`、`mnemopi/`、`stats/`、`wire/`（均 `partial`）；无 `full` |
| `third-party` | 3 | `natives/`、`omptype/`、`tui/`（均 `partial`） |
| `absent`（纯缺失） | 4 | `browser-relay/`、`metaharness/`、`snapcompact/`、`typescript-edit-benchmark/` |
| `absent`（无移植但部分重叠） | 1 | `utils/` |

合计 15，与 `packages/*` 除 `coding-agent` 外的包数一致。

**没有一个包达到 `full`。** 原因是上游每个包的体积（772 / 416 / 389 / 162 / 152 / 119 / 115 / 109 / 101 / 98 / 46 文件）都远超 RunLedger 对应面，且上游普遍带实验分支、研究脚本、多 provider 特化与本地化数据。

## 4. Rust crates 对照（`crates/*`）

上游 crate 均为 workspace 成员（`version.workspace = true`），合计 466 个 `.rs` 文件。RunLedger 只有 `native/syntax-highlighter`（3 个 `.rs`：`src/lib.rs`、`src/bin/generate-acknowledgements.rs`、`build.rs`）加一个 C 文件 `native/linux-peer-credential.c`。

| # | crate | `.rs` | 上游职责（`lib.rs` 文档注释实际内容） | `rl_mode` | `status` | RunLedger 对等物 / 缺口 |
|---|---|---|---|---|---|---|
| 1 | `pi-edit` | 49 | 编辑引擎：各编辑模式的解析、匹配、内存应用与 diff 生成，外加流式 `session::Session`——把原始工具调用参数增量变成渐进预览并经 host 持有的 writer 原子落盘。`src/`：`engine.rs`、`modes/{apply_patch,patch,replace}.rs`、`notebook.rs`、`store.rs`、`session.rs`、`stream_json.rs`、`fuzzy.rs`、`diff_string.rs`、`path_policy.rs`、`text.rs`、`files.rs` | `ported` | `partial` | 对等物：`src/runtime/tools/edit.ts`（12.7KB）+ `src/runtime/tools/multi-edit.ts`。缺口（与 00 §4 `edit/` 一致）：**无多模式 schema**（`apply_patch`/`patch`/`replace` 三模式与 hashline 语法）、无 `auto-repair` 自愈重试、无 `EditSession`/`EditStore`、无 `fuzzy.rs` 模糊匹配、无 `stream_json.rs` 流式增量预览、无 `path_policy.rs`、无 notebook 专门引擎（RunLedger 的 `notebook-edit.ts` 是独立 TS 实现）。`development-doc/plan/16-omp-tool-parity-update-plan.md` §1.2/§5 将 hashline 默认模式列为非目标（依赖 native `EditSession`）。 |
| 2 | `pi-ast` | 7 | `block`、`language`、`ops`、`parse_cache`、`summary`、`SupportLang` | `third-party` | `partial` | 委托给 `web-tree-sitter@0.25.10` + `tree-sitter-bash@0.25.1` + `web-tree-sitter-bash`（资产由 `scripts/check-bash-ast-assets.ts` 校验）。**仅 bash**，无多语言 `SupportLang`、无原生 `parse_cache`、无 AST summary。与 00 §3 #24（`eval/` 缺失）与 §4 `tools/` 的 `ast-grep`/`ast-edit` 缺失同源。 |
| 3 | `pi-diff` | 1 | jsdiff 兼容的 diff 原语、无 FFI 依赖：Myers O(ND) 核心 + 行/词/结构化 patch 助手，保持 jsdiff v9 的默认 tie-breaking 与变更合并；UTF-16 入口按 JS code unit，UTF-8 行助手供原生侧 | `ported` | `partial` | 对等物只有 `src/runtime/tools/edit.ts:217` 的 `makeUnifiedDiff`——**简化 LCS、仅行级**，源文件注释自述「pi 用的 diff 库更复杂，本期只求审计可见即可」。缺失：Myers O(ND)、词级 diff、结构化 patch、hunk 合并/tie-breaking 兼容。`diff@9.0.0` **只在 lock 中作为 `@opentui/core` 的传递依赖存在，RunLedger `src/` 从不 import 它**。渲染侧 `src/tui/opentui/diff-renderable.ts` 是自有实现，但消费的是**预计算好的有界 DTO**（`src/tui/presentation/tools/projector.ts` 的 `projectDiffDocument`）。 |
| 4 | `pi-walker` | 6 | 可复用平台目录遍历原语：原生目录读取快路径，供 glob、grep 候选发现、AST 扫描与 shell builtins 使用；暴露纯 Rust 类型、visitor 接口与缓存 | `ported` | `partial` | 对等物：纯 TS `src/runtime/tools/{ls,grep,glob}.ts` + `src/runtime/tools/gitignore.ts`。无原生快路径、无共享 visitor/缓存层（grep 与 glob 各自遍历）。与 §3 #8 的 `natives/` grep/glob/fd 缺失同一件事。 |
| 5 | `pi-vcs` | 12 | 进程内版本控制：把 git 与 Jujutsu CLI 包装合并为一个 Rust 接口——git 主要跑在 gitoxide 上，git 二进制只处理凭据绑定的网络传输、reftable 仓库与整树操作 | `ported` | `partial` | 对等物：`src/workspace/git-porcelain.ts`（4.2KB）+ `src/worktree/git-operations.ts`（7.3KB）+ `src/extensions/plugins/marketplace/{fetcher,source-resolver}.ts`。**全部经 git 二进制/CLI，无 gitoxide、无 `jj` 支持**、无统一 `GitRepo`/`JjWorkspace` 抽象。 |
| 6 | `pi-shell` | 41 | `cancel`、`minimizer`、`output_decode`、`process`、`shell`、`windows`（另有 `pi-builtins` 说明其 minimizer 部分算法移植自 MIT 许可的 `rtk-ai/rtk`） | `ported` | `partial` | 对等物：`src/runtime/execution-env.ts`、`src/runtime/process/{manager,state-machine,wait-coordinator}.ts`、`src/runtime/session-runtime/process/*`、`src/storage/process/node-pty-adapter.ts`。缺口：无 `minimizer`（输出压缩/去噪——与 00 §4 `exec/` 的 brush-core minimizer 缺失同源）、无 `output_decode`、无自有 `cancel`/`process` 原语、无 Windows 专门路径。 |
| 7 | `pi-iso` | 10 | 跨平台隔离 PAL：给出只读 lower 树的可写 merged 视图而无需深拷贝；支持 COW 的 backend 还能在克隆 checkout 时按顶层条目选择性省略。macOS 使用 `clonefile` 等 | `absent` | `absent` | **无任何对等物**。这与 00 §6「子代理 worktree 隔离为明确非目标」、`development-doc/runtime/08-bounded-multi-agent-system-plan.md` 与根 `AGENTS.md` 的冻结边界一致：RunLedger 的 `src/worktree/` 是 session 级 workspace 租约，不是 COW 隔离层。⚠️ 注意 `pi-iso` **不是 OS sandbox**（不做 namespace/进程隔离），因此不受根 `AGENTS.md` §2 sandbox 冻结条款约束——它是一个独立的 COW 文件系统能力，本条按「未移植」记录而非「禁止做」。 |
| 8 | `pi-natives` | 102 | 经 N-API 导出的原生工具：剪贴板、grep、文件发现、ANSI 感知文本测量、语法高亮、HTML/PDF→Markdown、终端 SIXEL 编码等 | `third-party` | `partial` | 见 §3 #8 的完整能力族分解（约 15 族中仅语法高亮有自有原生实现）。此处补充 `src/` 目录级证据：`grep.rs` 93.3KB、`ast.rs` 46.7KB、`snapcompact.rs` 57.4KB、`pty.rs` 35.5KB、`shell.rs` 25.5KB、`vcs.rs` 42.3KB、`pdf.rs`、`audio.rs`、`sixel.rs`、`svg.rs`、`clipboard.rs`、`desktop/`、`fonts/`、`tokens.rs`、`utok/`、`iofs.rs`、`iso.rs`、`keys.rs`、`live.rs`、`spelling.rs`、`power.rs`、`prof.rs`、`crash_handler.rs`。 |
| 9 | `pi-builtins` | 126 | 嵌入 shell 安装的全部 builtin，分两层：POSIX/bash builtin（`cd`、`echo`、`test`、`printf`、`read`、`export`、`trap`、`wait`…，为 `brush-builtins` 的本地补丁分支）与进程内命令行工具 | `absent` | `absent` | 无自有实现，**但标准路径由系统 shell 满足**（RunLedger 经受治 managed process + `node-pty` 驱动真实 shell）。真正未满足的是**不依赖系统 shell 的嵌入 shell 场景**（上游用 `brush-core` fork，见 `crates/vendor/`）。00 §4 `exec/` 记录的 brush-core Shell 快照/minimizer 缺失与此同源。 |
| 10 | `pi-voice` | 8 | 原生语音引擎：麦克风采集、扬声器播放、WebRTC 实时对话对端；刻意不依赖 napi，由 `pi-natives` 薄封装，使 webrtc/opus 依赖图只编译进本 rlib | `absent` | `absent` | **无对等物**，与 00 §3 的 `tts/`（#1）、`stt/`（#2）、`live/`（#3）三项缺失同源——它们是同一语音能力栈的 TS 层与原生层。 |
| — | `vendor/` | 104 | 第三方 vendored 代码 | `absent` | `absent` | RunLedger 无 vendored Rust 依赖（其原生 crate 直接用 crates.io 的 `syntect`/`two-face`/`napi`）。 |

### 4.1 crate 级判定汇总

`ported` + `partial` 5 项（`pi-edit`、`pi-diff`、`pi-walker`、`pi-vcs`、`pi-shell`）、`third-party` + `partial` 2 项（`pi-ast`、`pi-natives`）、`absent` 4 项（`pi-iso`、`pi-builtins`、`pi-voice`、`vendor/`）。10 个具名 crate 中 `full` 为 0。

**结构性观察**：上游把性能关键路径下沉到 Rust（466 个 `.rs`，覆盖 diff、walk、edit、vcs、shell、ast、iso、voice、natives 九类），RunLedger 只下沉了一类（语法高亮）。这是**两种工程取舍**而非单纯的疏漏：RunLedger 用 `node-pty`/`web-tree-sitter`/`proper-lockfile`/纯 TS 换取更小的构建面与单 crate 构建（`npm run build:native` 只构建 syntax-highlighter）。代价是 §4 表中那些「无替代」项（PDF、音频、WebRTC、剪贴板、图像、token 计数、COW）确实无处落地。

## 5. 非 TS 树对照

| # | 上游路径 | 内容 | `rl_mode` | RunLedger 现状 |
|---|---|---|---|---|
| 1 | `python/omp-rpc/` | Python RPC 客户端：`src/omp_rpc/{__init__,protocol,host_tools,host_uris,client}.py` + `py.typed`，含 `tests/`（`test_client.py`、`test_host_uris.py`、`test_protocol.py`、`test_user_group.py`） | `absent` | 无 Python 代码。它是 coding-agent 的 `modes/rpc/*`（00 §4 记为缺失）的 Python 侧配对；RunLedger 的客户端协议是自有 TCP `session-server`（§3 #15），不是 stdio RPC JSON 面。 |
| 2 | `python/robomp/` | issue→PR 自动化 worker：`src/{worker,queue,github_events,issue_index,autoclose,cancellation,dashboard,proxy_client,host_tools,config,sandbox}.py`，含 `web/`（workspace 成员）、`docker-compose.yml`、`Dockerfile`、`pyproject.toml`、`docs/`、`tests/` | `absent` | 无对等物。注意其 `sandbox.py` 与 `docker-compose.yml` 属**容器隔离**范畴，与本轮其它条目无关且触及根 `AGENTS.md` §2 的冻结边界。 |
| 3 | `nix/` | `dev-shell.nix`、`home-manager.nix`、`bun.nix`、`nixos-module.nix`、`package.nix`、`flake.nix`、`flake.lock` | `absent` | 无 Nix 支持。RunLedger 的安装形态是 `npm install` + `npm run build` + `npm link`（见 README）。`development-doc/release/01-release-and-upgrade-infrastructure-plan.md` 的「安装形态识别」当前为 `planned`。 |
| 4 | `bazel/` + `MODULE.bazel` + `BUILD.bazel` + `.bazelrc` | Bazel 构建：`defs.bzl`、`toolchains/`、`platforms/`、`patches/`、`triples/`、`variants/`、`clippy.bazelrc`、`infra/bazel-remote/` | `absent` | 无 Bazel。RunLedger 用 npm scripts + 1 个 Cargo crate + `tsconfig.*.json` 多 project 校验（`check:contract-consumers`、`check:consumers` 等 13 个 check 脚本）。 |
| 5 | `infra/` | `runner.Dockerfile`、`reload-runner.sh`、`tune-kata-runtime.sh`、`docs/`、`bazel-remote/` | `absent` | 无 CI runner 基础设施；RunLedger 的 CI 归 `development-doc/test/01-test-strategy-and-runner-hardening-plan.md`。 |
| 6 | `types/assets/` | 类型资产 | `absent` | 无对等物。 |
| 7 | 其他根文件 | `Dockerfile`、`Dockerfile.robomp`、`deny.toml`、`rust-toolchain.toml`、`rustfmt.toml`、`rust-analyzer.toml`、`.oxlintrc.json`、`.oxfmtrc.json`、`about.toml`、`patches/` | `absent` | RunLedger 无 Dockerfile，无 Rust workspace 级 lint/format 配置（crate 内独立），无 `patches/`。格式化/检查用 `biome.json` + 13 个 `check:*` 脚本。 |

## 6. 依赖级能力清单对照

上游根 `catalog`（Bun workspace 依赖目录）暴露了一批能力依赖，RunLedger 是否具备可直接读出能力缺口：

| 依赖 | 用途 | RunLedger |
|---|---|---|
| `@opentelemetry/*`（api + logs + metrics + trace-base + sdk-* + exporter-{logs,metrics,trace}-otlp-proto + context-async-hooks + resources） | 遥测导出全栈 | 只有 `@opentelemetry/api`，**`src/` 无引用**；无 exporter/SDK。与 00 §3 #29/#30 一致 |
| `onnxruntime-node@1.26.0`、`fastembed@2.1.0`、`@huggingface/transformers@^4.2.0` | 本地向量/嵌入推理 | 无。与 §3 #7（mnemopi 无 embedding）、00 §3 #19 一致 |
| `puppeteer-core@25.3.0` | 浏览器驱动 | 无。与 §3 #3 一致 |
| `kitty-vt-wasm@^0.2.0` | 终端 VT 模拟 | 无（`utils/src/vterm` 亦无对等物，见 §3 #14） |
| `chart.js` + `react-chartjs-2` + `react` + `react-dom` | 统计看板图表 | 无（RunLedger 的 web 看板自绘，见 §3 #11） |
| `katex` | 数学渲染 | 无。与 §3 #12 的 `latex-to-unicode`/`latex-block` 缺失一致 |
| `tailwindcss` + `vite` + `vite-plugin-solid` + `solid-js` + `postcss` | 前端构建 | 无（`packages/collab-web` 用 `bun scripts/build.ts` + 手写 CSS） |
| `ts-morph` | TS 程序化改造（编辑基准用） | 无。与 §3 #13 一致 |
| `regexp-tree` | 正则 AST（编辑基准用） | 无 |
| `prettier`、`oxlint`、`oxfmt`、`lint-staged` | 格式与 lint | 无（用 `biome.json`） |
| `@babel/{parser,traverse,generator,types}` | 编辑基准变异用 | 无 |
| `diff@^9.0.0` | diff 原语 | 仅作为 `@opentui/core` 的传递依赖在 lock 中存在，`src/` 不使用（见 §4 #3） |

## 7. 两轮合并视角与新增结构性发现

### 7.1 两轮覆盖关系

| 域 | 第 1 轮（00） | 本轮（01） |
|---|---|---|
| `packages/coding-agent/src` | 全覆盖（77 个顶层模块） | 仅交叉引用 |
| `packages/*` 其余 15 包 | 仅当对等物落在兄弟包时在注释中提及 | 全覆盖（含 `rl_mode`） |
| `crates/*` | 未涉及 | 全覆盖 |
| `python/`、`nix/`、`bazel/`、`infra/`、`types/` | 未涉及 | 全覆盖 |

**本轮修正了 00 中三处口径性判断**：

1. 00 §5 把「上下文压缩/compaction」的对等物标为 `packages/agent`（兄弟包，口径外）。本轮正式纳入：`agent/` 判 `ported`/`partial`，并逐项列出缺失子能力（分支摘要、shake、append-only-context、replay-policy、pause、run-collector/telemetry）。
2. 00 §5 把「安全/权限网关」记为「本口径内无对应上游模块」，但行内仍写了 `src/sandbox/*`。本轮已确认 oh-my-pi 仓库内**不存在** `sandbox/` 目录或 bwrap/seatbelt 实现；本轮进一步明确：上游离该能力最近的是 `crates/pi-iso`（COW 文件系统隔离，**不是** OS sandbox）与 `python/robomp/src/sandbox.py`（容器），两者都不是 RunLedger `src/security/sandbox/*` 的上游对等物——即 RunLedger 的权限/沙箱面整体属**自建能力**。
3. 00 把 `web/`（RunLedger 的只读看板）与上游 `src/web/`（搜索+抓取）判为「同名不同物」。本轮补充了真正的同物：RunLedger `src/web/*` 的上游对等物是 `packages/stats/`（看板）与 `packages/collab-web/`（浏览器端），已在 §3 #11、#5 分别登记。

### 7.2 新增结构性发现

1. **包边界缺失**（§2）。上游 16 包的单向依赖 DAG 在 RunLedger 中不存在。这既是工程形态差异也是能力缺口：无包边界意味着无法单独发布/复用 AI 层、无法用依赖方向做架构约束。归 `development-doc/plan/13-package-boundary-workspace-refactor-plan.md`（`planned / staged`）。
2. **原生下沉深度差异**（§4.1）。上游 466 个 `.rs` 覆盖 9 类能力；RunLedger 3 个 `.rs` 覆盖 1 类。区分「换实现」（`third-party`，如 PTY→`node-pty`）与「无实现」（`absent`，如 PDF/音频/WebRTC/COW/token 计数）是关键。
3. **第三方库替代是主流模式，但有语义代价**（§3 #9）。RunLedger 用 `typebox` 替代 `omptype` 是合理取舍，代价是 ArkType 兼容 API 与错误消息面——上游 coding-agent 代码是**按 omptype 写的**，因此凡从上游直接移植的代码（工具 schema、契约）都需改写，这是后续移植的真实摩擦点。
4. **未移植的决策在本轮同样存在**（§8），且**与 `packages/collab-web` 的 README、`development-doc/bench/00` 的采纳/拒绝表、`development-doc/compact/README` 的 O6/O7 一致**——三份文档是权威来源，本报告只做登记。

## 8. 已决策不移植（本轮新增）

| 项目 | 上游位置 | 决策出处 |
|---|---|---|
| relay / room key / pi-wire 数据模型 / 写操作（协作） | `packages/wire/src/index.ts`、`packages/collab-web/src/lib/{socket,client,link,codec}.ts`、`packages/collab-web/src/components/shell/Composer.tsx` | `packages/collab-web/README.md`（差异段）+ `THIRD_PARTY_NOTICES.md`（逐文件适配表，明写 "The original relay, room keys, write APIs and Composer are not included."） |
| snapcompact 位图帧归档 | `packages/snapcompact/src/snapcompact.ts`、`crates/pi-natives/src/snapcompact.rs` | `development-doc/compact/README.md` O6 `deferred`（条件：原生渲染 + 图像投影通道 + 媒体契约 + vision 计费） |
| 分支摘要 | `packages/agent/src/compaction/branch-summarization.ts`、`packages/wire/src/index.ts` 的 `BranchSummaryEntry` | `development-doc/compact/README.md` 决策表（拒绝） |
| shake 重块替换 | `packages/agent/src/compaction/shake.ts` | `development-doc/compact/README.md` O7 `blocked` |
| 实验性 context 管理、推测压缩、idle 压缩、多候选 fallback、原生 tokenizer | `packages/agent/src/compaction/*`、`packages/catalog/src/model-tokenizer.ts` | 同上决策表（拒绝） |
| Docker/microVM 任务执行；第二常驻 HTTP 服务；Harbor/terminal-bench 数据集依赖；`bun pm pack` 跨平台分发；`danger-full-access` 作为无人值守默认；远程 trace exporter | `packages/metaharness/*`、`python/robomp/*`、`infra/runner.Dockerfile` | `development-doc/bench/00-oh-my-pi-metaharness-reference.md`（已冻结的采纳/拒绝表） |
| COW 子代理隔离 | `crates/pi-iso/*` | `development-doc/plan/16-omp-tool-parity-update-plan.md` §6、`development-doc/runtime/08-bounded-multi-agent-system-plan.md`、根 `AGENTS.md` |
| OS sandbox / 容器隔离 | `python/robomp/src/sandbox.py`、`python/robomp/docker-compose.yml` | 根 `AGENTS.md` §2（冻结；且注意 oh-my-pi 的 `crates/pi-iso` 不属此项） |

## 9. 复现命令

```sh
# 以下命令在同时包含两个 checkout 的父目录执行（即 oh-my-pi 与 RunLedger 同级处）
OMP=oh-my-pi
RL=RunLedger

# 快照
git -C $OMP log -1 --format='%H %cd'
git -C $RL log -1 --format='%H %cd'; git -C $RL branch --show-current

# 形态对照
find $OMP/packages -maxdepth 1 -mindepth 1 -type d | wc -l     # 16
find $OMP/crates   -maxdepth 1 -mindepth 1 -type d | wc -l     # 11
jq -r '.workspaces' $OMP/package.json
jq -r '.workspaces' $RL/package.json                            # 只有 packages/*
find $OMP/crates -name '*.rs' -not -path '*/target/*' | wc -l   # 466
find $RL/native  -name '*.rs' -not -path '*/target/*' | wc -l   # 3

# 逐包规模与描述
for d in $OMP/packages/*/; do
  printf '%-28s %s\n' "$(basename $d)" \
    "$(jq -r '.name + " | " + (.description // "-")' $d/package.json 2>/dev/null)"
done

# 内部依赖图
for d in $OMP/packages/*/; do
  printf '%-28s -> %s\n' "$(basename $d)" \
    "$(jq -r '((.dependencies//{})|keys[])' $d/package.json 2>/dev/null | grep '@oh-my-pi' | tr '\n' ' ')"
done

# 关键判定检索（示例）
grep -rl  '@oh-my-pi\|pi-utils\|omptype\|pi-tui' $RL/src          # 应为空
grep -rl  -iE 'puppeteer|playwright|CDP\b|browser-relay' $RL/src $RL/tests
grep -rl  -iE 'snapcompact|branchSummar|replay-policy|append-only-context' $RL/src
grep -rl  -iE 'UsageWindow|resetsAt|creditBalance' $RL/src        # 配额模型
grep -rl  -iE 'fastembed|onnxruntime|protobuf|grpc' $RL/src
jq -r '.dependencies,+ .optionalDependencies' $RL/package.json     # 替代依赖清单
grep -c '"node_modules/diff"' $RL/package-lock.json                # 仅传递依赖
```

## 10. 本轮建议优先级

按「缺口影响面 × 现有基础设施可承接度」。**不是排期**；实施仍需各专题立项。

| 优先级 | 项目 | 理由 |
|---|---|---|
| P0 | `packages/ai` 的 `error/` 分类与 rate-limit 解析、`dialect/` | 直接影响真实 provider 下的重试与限流行为；上游 41KB flag 表 + 21KB rate-limit 解析，RunLedger 只有局部启发式。`dialect/` 决定跨 provider 的 thinking/工具调用格式，是 11 个协议族薄层的正确性前提 |
| P0 | `packages/ai` 的 `usage/` 订阅配额模型 | 与 `packages/stats` 的 `usage-windows` 同源，是「额度是否耗尽」这一用户可见判断的唯一依据；RunLedger 的 `runtime/usage` 是不同关注点 |
| P1 | `crates/pi-diff` 的 Myers + 词级 + 结构化 patch | `edit.ts` 的简化 LCS 自述「只求审计可见」，一旦编辑 diff 需要人工比对或自动校验即成为瓶颈；纯 TS 可实现，无需原生 |
| P1 | `packages/catalog` 的 `identity/` + `compat/` 引擎 | 当前是手写启发式 + per-model 字段，随 provider 增多而不可维护；上游用规则树 + 编译器，RunLedger 已有 `scripts/generate-models.ts` 可承接生成侧 |
| P2 | `packages/agent` 的 `run-collector`/`telemetry` + OTel 接线 | `@opentelemetry/api` 已声明但无引用；与 00 §3 #29/#30 的 OTLP 缺失是同一件事，宜合并立项 |
| P2 | `crates/pi-natives` 的 token 计数 | 当前 `token-estimator.ts` 是保守字节估算，直接放大压缩切点误差 |
| P3 | `packages/stats` 的分析路由（behavior/errors/gain/models/providers/tools/traces） | 纯增量分析能力；RunLedger 已有 `src/web/*` 只读看板骨架与 `usage-projection` 对账模型 |
| P3 | `packages/metaharness` + `typescript-edit-benchmark` | 判分与任务包契约已在 `development-doc/bench/02` 冻结，等 P0–P6 排期 |
| 不做（已决策） | relay/room key/pi-wire、snapcompact、分支摘要、shake、COW 隔离、容器/microVM、Nix/Bazel | 见 §8，不要按缺口重新立项 |

## 11. 证据限制

1. 本文为**静态源码对照**：不表示上表任何 RunLedger 模块通过运行时验收，也不表示缺口项在真实 provider / TTY / 跨平台下可用。
2. 上游「文件数」是规模指标，不等于工作量；本轮计数**包含**测试、`research/` 实验脚本、资源与生成物（例如 `snapcompact/` 119 文件中 36 个是 `research/*.py`，`catalog/` 416 文件中含 10.4MB 数据）。
3. 「包」在本轮按目录计：`typescript-edit-benchmark/` 与 `browser-relay/` 是上游 private 包，不发布。
4. `status: partial` 的「缺口」只列本次检索确认的上游无对等物项；体积最大的 `ai/`、`catalog/`、`utils/` 三包不保证穷尽子文件。
5. `rl_mode: third-party` 的条目**不是缺口**，但其语义等价性需逐项评估（`omptype`↔`typebox` 已给出结论，`pi-tui`↔`@opentui/core` 与 `pi-natives`↔`node-pty`/`web-tree-sitter` 只给出覆盖面结论，未做行为等价验证）。
6. 未提交工作树包含他人改动，且调查期间上游/目标均可能继续前进；复核时请以 §9 命令在当前 checkout 重新生成事实。
7. Rust crate 的职责取自各 `src/lib.rs` 的文档注释与源文件清单，未阅读实现细节；`status` 反映的是「RunLedger 是否有对等能力」，不是「上游实现质量」。
