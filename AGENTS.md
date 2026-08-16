# RunLedger 开发规则

> RunLedger 是一个面向 企业级可审计 Agent Runtime 的最小可运行脚手架,参考 `pi` 项目 (`packages/agent` 与 `packages/ai`) 的架构。本期已完成 pi-ai 全量移植,以及 agent-loop / Agent / ledger / mock-stream / echo tool / stdlib 工具集 / ExecutionEnv / stdlibStreamFn 桥接的最小可运行复活(真实 LLM 已用 `asset/api-key.json` 中 deepseek-v4-pro 通过 `npm run demo` 验证,mock 模式仍保留为单测入口)。

## 1. 范围

### 1.1 已完成(`src/` 顶层 + `src/api/` + `src/auth/` + `src/providers/` + `src/storage/` + `src/utils/` + `src/compat/`)

从 pi `packages/ai/src` 移植的全量 LLM provider 抽象层与凭据/OAuth 流:

- `src/api/` 30 个 provider 适配实现(anthropic-messages / openai-responses / openai-codex / google-generative-ai / google-vertex / mistral / bedrock / cloudflare / openrouter / azure 等),含 lazy 版本;
- `src/auth/` 凭据类型、CredentialStore OAuth 流(`oauth/anthropic.ts` / `openai-codex.ts` / `github-copilot.ts` / `xai.ts` / `radius.ts` / `device-code.ts` / `pkce.ts` / `oauth-page.ts`);
- `src/providers/` 注册 36 个 builtin provider,其中 35 份 `data/*.json` 模型 catalog 自动生成(1061 个模型);
- `src/storage/` `auth-storage.ts`(auth.json + proper-lockfile)+ `runtime-credentials.ts` + `paths.ts` + `resolve-config-value.ts`;
- `src/utils/` 工具库(uuid / overflow / diagnostics / retry / validation / encode / decode / event-stream 等 21 个文件);
- 顶层 `models.ts` / `models-store.ts` / `models.generated.ts` / `images-models.ts` / `image-models.ts` / `image-models.generated.ts` / `images.ts` / `images-api-registry.ts` / `session-resources.ts` / `oauth.ts` / `bun-oauth.ts` / `bedrock-provider.ts`;
- `scripts/generate-models.ts` —— pi 自动模型 catalog 生成脚本(已迁移,跑 `npm run generate-models` 重新生成 `src/providers/data/*.json` 与 `src/models.generated.ts`)。

### 1.2 已复活(`src/runtime/`,纳入 typecheck + `npm test` + `npm run demo`)

`agent-loop` 核心循环与 ledger 在 RunLedger 自研骨架基础上对接 pi-ai `AssistantMessageEventStream` 与 `Model<Api>` 类型:

`src/runtime/` 下当前形态:

- `agent-loop.ts` —— `runAgentLoop` 双层循环(outer turn / inner assistant stream),支持 reasoning、toolCalls、steering/follow-up 队列与完整 assistant/tool 事件;
- `agent.ts` —— `Agent` 有状态包装类,`subscribe / on / prompt / steer / followUp / interrupt / waitForIdle`,严格限制同一时刻只有一个活跃 run;
- `types.ts` —— 复用 pi-ai `Message` / `Tool` / `ToolCall` / `StopReason` / `Model` / `StreamOptions` / `AssistantAgentMessage` 等,补 `LlmContext` / `AgentContext` / `AgentEvent` / `AgentEventSink` / `AgentLoopConfig` / `AgentTool` / `AgentToolCall` / `UserAgentMessage` / `ToolResultAgentMessage` / `StreamFn` 等运行循环层接口;
- `ledger/{types,memory-ledger,jsonl-ledger}.ts` —— 当前内存与 JSONL 审计账本(append-only,失败不抛错,以 `lastError` 字段保留报告路径);不读取旧格式;
- `tools/echo.ts` —— 最简 `AgentTool`(回显 text),用于验证 tool 调用链路;
- `tools/{tool-support,read,write,edit,bash,grep,find,ls,index}.ts` —— stdlib 工具集(8 个 AgentTool),fork pi `core/tools/*` 的简化版,共享 `truncateHead` / `resolveToCwd` / `pathExists` 路径截断原语;`createStdlibTools(cwd)` 一站式返回 `ToolRegistry`,namespace="stdlib";
- `tool-registry.ts` —— 多命名空间工具注册表,`register` / `unregister` / `has` / `get` / `toContext`,`toContext()` 输出 `AgentTool[]` 直接喂给 `AgentContext.tools`,
  `findConflict(tools)` 用于静态检测同 name 冲突,便于 prompt / schema 切换前的早 fail;
- `execution-env.ts` —— `ExecutionEnv` 抽象层(`FileSystem` + `Shell` 接口),`localExecutionEnv(cwd?)` 默认实现走 `node:fs/promises` + git-bash 启发 `defaultShell()`(优先 `findGitBash()` 在 win 找 git-bash,否则 `process.env.SHELL`),bash 工具与 grep / find 的 fallback 路径通过此抽象 spawn 进程;
- `utils/shell.ts` —— git-bash 探测与 shell 选择(`findGitBash()` / `defaultShell()`);
- `providers/mock-stream.ts` —— mock LLM provider:同步 `AssistantMessageEventStream`,按 user 文本生成一段文本 + 一个 echo `toolCall`,第二轮直接 `stopReason = "stop"` 收尾,支持 `AbortSignal` 中断;
- `stdlib-stream.ts` —— `createStdlibAgent(opts)` 便利桥接器:把 stdlib 工具集(mocks 或任意真实 streamFn)+ `Agent` 类 5 行内组装成可跑 Agent;`stdlibStreamFn === mockStreamFn` 别名,以桥接器名出现在示例代码中。

`tests/` 当前形态:

- `agent-loop.test.ts` —— runAgentLoop + mock + echo 完整循环(2 测试)
- `tool-registry.test.ts` —— 多 namespace 注册 / 冲突 / toContext(8 测试)
- `execution-env.test.ts` —— fs 基本 API + git-bash shell.exec echo/stdin/fail(6 测试)
- `stdlib-tools.test.ts` —— read/write/edit/bash/grep/find/ls 7 工具 + createStdlibTools 注册视图 与 mock shell fallback(14 测试)
- `stdlib-agent.test.ts` —— createStdlibAgent 默认构造、跑 turn、ledger 注入、stdlibStreamFn 别名(5 测试)

总计 35 测试全绿,`npm run check` 与 `npm test` 应同时通过再行 commit。`examples/run.ts` 已接入真实 deepseek-v4-pro(走现有 pi-ai `openai-completions` adapter)演示 deepseek 完成 turn1 toolUse → turn2 stop 全链路。
`src/_legacy/` 目录已清空,从 tsconfig exclude 中移除;旧 barrel 已删除,公共出口只保留当前实现。

#### 1.2.y Runtime Trace 本地 Store 与配置（2026-08-02）

- `src/runtime/trace/` 已实现 append-only hash-chain Event Store、SHA-256 CAS Artifact Store、Trace Tree projection、mode-aware `RuntimeTraceRecorder` 与 per-prompt `TraceRecorderFactory`；
- 用户级 `<runledgerHome>/settings.json#recording` 支持 `mode=off|events|events_and_artifacts` 与 `failurePolicy=best_effort|fail_closed`，默认 `off + best_effort`；workspace settings、项目 `.runledger/`、CLI flag 和额外环境变量不拥有 recording authority；
- Event Store 写入 `events/YYYY/MM/DD/<traceId>.jsonl`；Artifact 与 metadata 分别写入 `artifacts/sha256/...` 和 `artifact-metadata/sha256/...`；
- 标准 CLI 已接入本地 recorder factory；canonical user settings 显式选择 `events_and_artifacts` 时保存安全清洗后的正文，`events` 只记录 digest/size/media type；Permission/Approval/Sandbox 的正文授权策略与 receipt 等具体能力落实后再由安全专项接线，当前不作为本地记录前置条件；
- Opik SDK、网络 exporter 与 durable outbox 尚未实现，计划见 `development-doc/runtime/trace/phase-04-opik-exporter-tree.md`。

#### 1.2.x Storage/CLI canonical user home 与 CLI 入口（S0–S5，2026-08-02）

当前 Storage/CLI authority 已迁移到单一用户级 `RunledgerLayout`：`RUNLEDGER_DIR`（必须是既有绝对目录）或默认 `<用户主目录>/.runledger`，由 composition root 只解析一次。canonical settings/auth/AGENTS 位于 `layout.settings`、`layout.auth`、`layout.agents`；workspace settings 位于受校验的 `layout.projects/<workspace-key>/settings.json`；session 只写 `layout.sessions/YYYY/MM/DD/<session-id>.jsonl`，文件默认 `0600`、目录默认 `0700`。

`settings.sessionDir` 不会被保存，`RUNLEDGER_SESSION_DIR` 与 `--session-dir` fail closed；旧 `<cwd>/.runledger/`、`~/.runledger/agent/` 和根外 session 只可作为显式 `runledger migrate --source <path> --confirm-delete` 的 source。迁移先固定 digest source deletion manifest，目标 verify 后逐项删除；不提供只读 import、dry-run、fallback 或物理 rollback。S0–S5 证据、静态边界检查与最终门禁以 `development-doc/storage-cli/02-user-home-migration-handoff.md` 为准；本仓库未对真实用户目录执行迁移。

以下 M8 项目层布局说明保留为历史输入，不代表当前写入 authority：

新增 `src/storage/paths.ts` 项目层与 `src/storage/{settings-manager,session-manager,path-utils}.ts`,以及 `src/cli/{args,main,cli}.ts` 与 `bin/runledger.js`,让"终端运行 `runledger` 命令打开 tui"成立。布局对照 pi `~/.pi/agent/` 但默认在项目内,便于本项目带走完整 .runledger/ 子树:

```
<cwd>/
├── .runledger/
│   ├── settings.json          # ProjectSettings:provider/model/thinkingLevel/theme/sessionDir/enabledModels/queue modes
│   ├── sessions/              # 默认 sessionDir;每个文件 1 行 LedgerHeader + N 行 LedgerEntry
│   └── (后期)tfidf / extensions / commands / hooks / mcp / ...
└── AGENTS.md                   # 仓库惯例的 codex agent 提示,被注入 systemPrompt
~/.runledger/agent/             # 用户层
├── AGENTS.md                   # 全局 systemPrompt 拼接
├── auth.json                   # 已有 (auth-storage)
└── (后期)settings.json / mcp.json ...
```

`src/storage/` 当前形态:

- `paths.ts` —— 历史 project/agent source locator helper；canonical 代码不再调用 `resolveSessionDir` 或读取 `RUNLEDGER_SESSION_DIR`;
- `path-utils.ts` —— 纯函数 `encodeCwd / safeIso / buildSessionFileName`(便于单测,不引 fs);
- `settings-manager.ts` —— 注入 `RunledgerLayout` 的 user/workspace settings；`sessionDir` 输入结构化返回 `unsupported_setting`;
- `session-manager.ts` —— 只接受注入 layout，create/open/continueRecent/forkFrom/list/listAll/acquireLock 均验证 canonical containment；fork 的 parent locator 为 root-relative；CLI 持有整场独占锁直到退出。
- `session-codec.ts` —— 当前 canonical `AgentMessage` 与 runtime config 无损恢复;不猜测、不转换旧 session 内容。

`tests/storage/` 当前形态:

- `path-utils.test.ts` —— encodeCwd / safeIso / buildSessionFileName 跨平台(10 测试)
- `paths.test.ts` —— 历史 source locator helper(7 测试)
- `settings-manager.test.ts` —— canonical load/sync/save + recording authority/default/digest + legacy 字段拒绝 + 0o600 mode(15 测试)
- `session-manager.test.ts` —— create/open/continueRecent/forkFrom/list 跨场景(13 测试)

`src/cli/` 当前形态:

- `args.ts` —— 手写 argv parser；`--session-dir` 明确返回 `unsupported_cli_authority`，不进入 args/unknown authority；`migrate` 子命令由 `src/cli/migrate.ts` 处理;
- `main.ts` —— 装配 36 个 builtin provider + `AuthStorage` + 当前 session replay + `InteractiveSessionController`;生产 CLI 不回退 mock,无认证时进入 TUI onboarding;`InteractiveMode.run()` 持续到退出后才在 finally 释放整场 ledger lock;
- `cli.ts` —— bin 入口,仅 `main(process.argv.slice(2)).catch(exit 1)`;业务全留 main.ts 以便单测 spawnSync 跑。

`bin/runledger.js` —— npm bin shim,直接 import 编译后的 `dist/cli/cli.js`;运行时不依赖 tsx 或 src,重新链接前先跑 `npm run build`。

`tests/cli/` 当前形态:

- `args.test.ts` —— parseArgs 全旗 + error 通道 + 未知兜底(23 测试)
- `main.test.ts` / `migrate.test.ts` —— 早期退出、legacy authority 负向路径与 destructive migrate 通过 spawnSync 真跑 cli.ts；真 TUI 路径因 stdin 阻塞留 manual smoke test。
- `trace-config.test.ts` —— CLI 默认关闭本地记录，并在用户显式配置后启用工具正文 Artifact 模式。

当前 `npm test` 为 Vitest 73 files / 401 tests，加 Bun OpenTUI 2 files / 3 tests / 36 assertions 全绿。`npm run check`、`npm test` 与 `npm run build` 应同时通过再行 commit。

`npm link` 后 PATH 上的 `runledger` 命令可直接打开 TUI；旧根外 session path 不再直接 open/fork，迁移必须显式使用：
`runledger --help` / `runledger --version` / `runledger` / `runledger -c` / `runledger --resume` / `runledger migrate --source <path> --confirm-delete` / `runledger workspace capability`。

#### 1.2.z 多平台 workspace/path 适配（P0–P7，2026-08-06）

- `src/workspace/` —— 平台适配层：`types.ts`(root/volume/share identity、versioned locator、错误 taxonomy)、`path-adapter.ts`(纯 parse/compare/containment/locator)、`git-porcelain.ts`(纯 `git worktree list --porcelain` parser)、`process-capability.ts`(Shell/termination/cleanup 描述，verified/unverified 证据标记)、`locator-audit.ts`(只读旧记录分类，绝不改写)、`resume.ts`(cold resume 重验 platform/root/Git/lease/effective cwd，fail closed 不回退 source)、`capability.ts`(证据矩阵，不宣称 sandbox)、`runtime-platform.ts` + `factory.ts`(运行时平台单点分支)、`native/{linux,macos,windows,adapters,types}.ts`(P4 原生 adapter；macOS/Windows 无真实 runner 证据，factory 保持 typed `unverified_platform`)；
- 平台分支静态边界：`scripts/check-platform-boundaries.ts` 接入 `npm run check`；业务模块禁止新增 `process.platform`，新代码唯一分支点为 `src/workspace/{factory,runtime-platform}.ts`，既有 8 个文件的散落分支已在 P6 收敛到 `runtime-platform.ts`；
- `WorktreeManager` 与 `HostWorkspaceBindingService` 注入 `WorkspaceAdapters` 后 containment 与 Git 生命周期（create/remove/list/status/resolveCommit）全部经 adapter（compare-key + porcelain），Host rebind/resume 消费 `resumeWorktreeLocator`；生产组合 `runtime-host.ts` 经 `createWorkspaceAdaptersForCurrentPlatform` 注入（Linux verified，旧 GitOperations/node:path 仅测试接缝）；
- 公共 DTO 脱敏（ADR 02 D1/D5）：`WorkspaceExecutionEnvelope` 只投影 `worktreePathDigest`/`cwdDigest`，native path 只存在于 Host-private `HostWorkspaceExecutionContext`；`PersistedWorkspaceBinding` 嵌入 versioned `worktreeLocator`，legacy 记录 typed `binding_migration_required`；
- 真实 runner 证据：`tests/fixtures/platform-evidence/linux/`（digest manifest 不可变）；macOS/Windows 缺口见 `development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md`；OS sandbox 保持封存（04/05 ADR，P7 结论：解封条件未满足）。

#### 1.2.w Session Owner Runtime 替代（2026-08-07，复核修正）

`development-doc/runtime/06-session-owner-runtime-replacement-plan.md` 是唯一替代计划。当前工作树状态：R0–R5 implemented；R6 partial/blocked；R6.5 Linux automated candidate PASS but not accepted；R7 标准 CLI 已切换但验收随 R8 pending；R8 not accepted；R9 not started（先前删除尝试已 reverted，旧 Host 只保留为安全窗口且标准 CLI 不可达）。已修复并覆盖：

- P0-1 健康 owner 即时 attach（统一 open 不再无限 retry）、factory attached 分支 `runtime: undefined` 不再崩溃；
- P0-2 生产工具副作用经 `attempt-gateway.ts` 进入 recovery barrier（Write/Bash/WebFetch 各自 beginAttempt/settleAttempt；崩溃留下 unresolved started receipt，takeover assess() 不误判 clean）；
- P0-3 attachment count 决定 runtime lifetime（local UI detach 后 remote 保活，归零才 pause/checkpoint/release）；
- P0-4 生产 composition 已接 onFenced → 完整 self-stop（server 关闭 + 领域中断 + 客户端断开）；
- checkpoint live head、六个 boundary、replay-ready cache + durable tail、非 replay-ready genesis fallback；
- Session Security/Gateway production composition（CLI source 优先，filesystem/network/sandbox final leaf fail closed）；通用 security 类型不再以 Host 命名，legacy Host 只使用兼容 alias；
- RED 测试：`tests/runtime/session-runtime/red-01..04`、`security-composition.test.ts`、checkpoint/recovery suites；candidate runner 覆盖 keepalive、gate-crash、10 个独立子进程/SQLite connection 并发 claim 和内容 digest manifest。
- R6 blocking gaps：真实 managed process/PTY/output、MCP/Hook/Skill/Plugin、worktree cold-resume/revalidation、Trace production factory、approval/credential reverse-request UI。
- 遗留门禁：真实 model/MCP/PTY/worktree candidate、macOS/Windows runner、标准 PATH fault rehearsal、独立只读审计与 R8 human acceptance；`human-verified` 需真人填写，R9 只能在这些门禁闭合后开始。
- 2026-08-07 fresh 本地门禁：`npm run check`、Session Owner focused 34 files / 209 tests、Vitest 260 files / 1427 tests、Bun OpenTUI 4 files / 29 tests、`npm run build`、隔离 Linux candidate 全部通过；该证据不提升 R6/R6.5/R8 的未完成项。

#### 1.2.va 有界根级子 Agent 委托（M0–M5、M6 Task 9）

`development-doc/runtime/08-bounded-multi-agent-system-plan.md` 是本专项唯一状态入口。当前实现是默认关闭的 **root-owned sequential readonly delegation**：root depth=0，child 固定 depth=1；同一 root 同时最多一个 child；child 只从 Session Owner production composition 派生 `read`/`grep`/`find`/`glob`/`ls` 等治理后的只读能力，模型 schema 不出现 authority、provider、model 或幂等字段，最终 leaf 仍由 Security/ExecutionGateway fail closed。Session Domain 的 `agent.inspect` 是 query，`agent.spawn`/`agent.cancel` 是受 driver fence 保护的 mutation；graph、terminal report、attempt identity 和 owner takeover 可 replay。

M6 Task 9 fresh evidence：`tests/integration/multi-agent-bounded.test.ts` 与 `tests/integration/multi-agent-faults.test.ts` 共 7 tests，覆盖真实 SessionStore/SessionOwner/embedded production composition、真实 child Agent、deterministic keyless model、read/search/report、不可见 write leaf、duplicate byte-identical report、inspect JSON round-trip，以及 requested/prepared/activation-uncertain/running/terminal-ack/terminal-before-settle takeover 矩阵。`node scripts/check-execution-boundaries.ts` 已加入 `src/runtime/agents/**` 与精确 Session Domain 文件扫描，legacy `create-anthropic-agent.ts` 明确隔离，Session Domain 仅允许 `requireExecutionEnv: true` 的 governed stdlib factory。

以下仍是 M1 非目标：DAG、child 再委托、并行 spawn、可写工作区或独立 worktree、MCP/Hook/Skill/Plugin child 能力、外部 Codex/Claude/ACP provider、child transcript cold continuation、Artifact/CAS/handoff/merge、USD cost、TUI `/agents` 面板和跨进程热替换。不要以空字段、未使用状态或 `verified:false` placeholder 提前宣传这些能力。

#### 1.2.vb oh-my-pi 新增 Provider 移植（2026-08，partial/deferred 批次）

唯一状态入口：`development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md`（来源快照 oh-my-pi 06aecdd5 v17.2.15，目标基线 b5100b2）。当前 `src/providers/` 有 68 个 builtin provider（原 36/37 + 本批新增），实现于独立 worktree `RunLedger-oh-my-pi-provider-port`，未提交。

状态分层（不要混用）：

- **代码已存在 + focused tests 通过 + 组合链通过**：A 批次 16 个（aimlapi、baseten、coreweave、firepass、gmi-cloud、litellm、lm-studio、nanogpt、novita、qianfan、siliconflow、siliconflow-cn、synthetic、venice、vllm、zhipu-coding-plan）与 B 批次 14 个（alibaba-coding-plan、alibaba-token-plan、bedrock-mantle、kilo、kimi-code、meta、minimax-code、minimax-code-cn、opencode-zen、qwen-portal、sakana、umans、wafer-serverless、zenmux）+ llama.cpp。全部标记 **partial**——真实凭据 E2E 未闭合，不做 implemented 宣称。
- **identity 映射（不新增 ID）**：azure → azure-openai-responses；moonshot → moonshotai + KIMI_API_KEY fallback；xai-oauth → xai 的既有 OAuth 路径 + 5 个 responses 模型并入 xai catalog。
- **deferred**：cursor / devin / gitlab-duo / gitlab-duo-agent / google-antigravity / google-gemini-cli / ollama / ollama-cloud（目标无对应 transport，RED 测试锁定 fail-closed）；zai-coding-plan / openai-codex-device（已有 provider 的 auth 变体，OAuth 流另建专项）；exa / kagi / parallel / perplexity / tavily（搜索/工具范畴，不在 chat provider DoD）。
- 关键机制：模型数据唯一来源 `scripts/sources/oh-my-pi-provider-models-17.2.15.json`（extract 脚本从冻结快照生成）+ `scripts/ported-provider-catalog.ts` 归一化；动态 provider 只声明进程内 refresh + last-known-good（InMemoryModelsStore），不宣称跨进程恢复；kimi-code device-code OAuth 流在 `src/auth/oauth/kimi-code.ts`（load.ts/bun-oauth.ts 已接线）。


### 1.3 显式不实现(以 `// TODO(pi):` 注释占位)

- `transformContext` 上下文变换;
- `thinkingBudgets` / `temperature` / `maxTokens` / `transport` / `maxRetries`;
- Session 树分叉(JSONL ledger 是扁平的);
- `AgentHarness` 高级状态机;
- Compaction / branch summarization;
- Skills (`SKILL.md` 加载) / Prompt templates;
- `streamProxy` (browser → backend);
- OpenTelemetry / metrics / RBAC / 多租户;
- pi `compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / `cli.ts` 这些 coding-agent 产物层。

## 2. 代码风格

- TypeScript 严格模式(`tsconfig.base.json` 中已开启 `strict: true` 与 `verbatimModuleSyntax: true`);
- **只允许可擦除 TS 语法**(`erasableSyntaxOnly: true`):禁止 `enum`、`namespace`、`import =`、`export =`、参数属性。类显式声明字段并赋值;
- 显式 `import type { ... }`,因为 `verbatimModuleSyntax: true` 已开启;
- 相对路径导入 **必须包含 `.ts` 后缀**(因为 `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`,编译时 TS 自动重写为 `.js`):`import { Agent } from "./agent.ts"`;
- `module: NodeNext`,`moduleResolution: NodeNext`,以支持 `import values from "./data/x.json" with { type: "json" }` import attributes;
- 严禁 `any`(除非理由极其充分,且必须立即给出 `// why any` 注释);
- 异步工具方法 **不抛错**:错误以 `stopReason: "error"` 或 `{ ok: false }` 编码;
- 中文注释,简洁技术化,不堆形容词、不放 emoji;
- 不使用内联 `await import()` 动态导入,只用顶层 `import`。

## 3. 工作流

- 修改代码后必须运行 `npm run check`(完整输出,不得截断),修复所有 error / warning / info 再提交;
- 修改模型 catalog(增删 provider)后跑 `npm run generate-models`,把生成结果一并提交;
- 依赖固定版本(`package.json` 中已用 `^` 但锁定主版本),变更 `package-lock.json` 视为已审阅代码;
- Git:只暂存本任务明确涉及的路径;禁止宽泛的 `git add -A` / `git add .` / `git commit -a` / `--no-verify`;禁止 `git reset --hard` / `git checkout .` / `git stash`;
- 每个 PR/commit 关注一件小事,描述写"为什么",不写"是什么"(差异本身已说明是什么)。

### TUI/CLI 改动的 runledger 运行验证

`runledger` 全局链接指向本仓库(`which runledger` 应为 `~/.npm-global/bin/runledger`,指向本仓库),bin shim 直接 import 编译后的 `dist/cli/cli.js`,运行时不依赖 tsx 或 src。因此**每次修改 TUI/CLI(或任何进入 `dist/` 的代码)后,必须重建 dist 并用 runledger 实测**:

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
npm run build          # 重建 dist(tsc 编译 + host build manifest)
which runledger        # 确认全局链接指向本仓库;缺失时先 npm link
runledger              # 真实终端验证(需真实 TTY;可用 tmux 捕获帧做视觉验证)
```

- 链接校验:`npm ls -g --depth=0 | grep runledger` 应显示 `-> ./../../../../data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger`;链接不存在或指向他处时先 `npm link` 修复;
- 视觉验证可用 tmux:`tmux new-session -d -s check 'runledger'` → `tmux send-keys -t check '/model'` → `tmux send-keys -t check Enter` → `tmux capture-pane -t check -p`,结束后 `tmux kill-session -t check`(注意 TUI 需 Esc 逐级关闭弹窗后再 Ctrl+D 才能干净退出);
- 真实运行依赖用户级 `~/.runledger/`(settings/auth);测试永远使用隔离 `RUNLEDGER_DIR`,不得操作真实用户目录;

### Git 提交与推送

提交和推送是独立的状态变更。只有用户明确要求提交时才创建 commit；只有用户明确要求推送时才推送。工作区可能同时存在其他任务的改动，不能把 `git status` 中出现的全部文件视为本任务范围。

提交前先确认当前仓库、分支和改动边界，并审阅本任务实际改动：

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
git status --short
git branch --show-current
git diff --check
git diff -- <explicit-paths...>
```

代码、测试、生成物或依赖变更在提交前必须完成对应验证。通常依次执行 `npm run check` 与 `npm test`；模型 catalog 变更还必须先执行 `npm run generate-models` 并审阅生成结果。纯文档变更至少要通过 `git diff --check`，不因无关的既有失败伪造通过状态。

暂存必须逐路径进行。新增或修改文件使用 `git add --`，删除文件使用 `git add -u --`；拆分或重命名为“新增目录 + 删除旧文件”时，先暂存新目录，再单独暂存旧文件删除：

```bash
git add -- AGENTS.md src/runtime/new-module.ts tests/new-module.test.ts
git add -u -- src/runtime/old-module.ts
git diff --cached --name-status
git diff --cached --check
git diff --cached
git commit -m "<one concise purpose-oriented message>"
git status --short
git log -1 --oneline
```

- 不使用 `git add -A`、`git add .`、`git commit -a`、`--no-verify`，也不借用其他仓库的提交脚本。
- 新增目录模块时使用 `git add -- <new-directory>`；删除的旧文件单独使用 `git add -u -- <deleted-file>`，避免将共享工作区的无关删除带入提交。
- 提交前用 `git config --get user.name` 和 `git config --get user.email` 确认身份；身份缺失或不正确时先请求明确授权，不能从其他仓库复制身份配置。
- commit 只覆盖一件小事，消息写明目的或原因；未暂存的无关改动必须保留在工作区。

需要推送时，先核对远端和当前分支。本仓库当前预期的 `origin` 是 `https://github.com/Crsei/RunLedger.git`，但每次推送前仍以本地配置为准：

```bash
git remote get-url origin
git push origin "$(git branch --show-current)"
```

如认证不可交互，使用现有的受控凭据或临时 `GIT_ASKPASS` 帮助程序；关闭 shell xtrace、将帮助程序权限设为 `700`、设置 `GIT_TERMINAL_PROMPT=0`，并在命令结束后立即删除它。不得读取、打印、复制或暂存 token、密码或凭据文件。若只需要本地提交，省略推送步骤。

## 4. 目录约定

```
src/                pi-ai 移植层 + RunLedger 运行时实现
  index.ts          pi-style barrel,重导出 api/auth/types/models/storage/utils
  types.ts          中心类型(Message / AssistantMessage / Tool / Provider / Model / Api 等)
  models.ts         Provider / Models factory + 配置
  models-store.ts   InMemoryModelsStore / 凭据/model 入出
  models.generated.ts  自动生成,跑 npm run generate-models 重新生成
  image-models.{ts,generated.ts} / images{,-api-registry}.ts / images-models.ts  图像 catalog
  session-resources.ts  会话资源 cleanup 注册表
  oauth.ts / bun-oauth.ts / bedrock-provider.ts  顶层桥
  api/              30 个 provider 适配实现(stream / streamSimple)
  auth/             凭据 + OAuth 流(pkce / device-code / 各 provider)
  providers/        36 个 builtin provider + 35 份 data/*.json(自动生成 model catalog)
  storage/          auth-storage / runtime-credentials / paths / resolve-config-value
  utils/            uuid / overflow / diagnostics / retry / validation / event-stream / shell(git-bash 探测)/ ... 21+1 个文件
  compat/           extension-oauth-types.ts(OAuth 类型桥)
  runtime/          agent-loop / agent / ledger / tools (echo+stdlib 8 个) / tool-registry / execution-env / providers/mock-stream / stdlib-stream,本期已复活并纳入 typecheck + npm test
scripts/
  generate-models.ts  2420 行硬编码模型数据,跑生成 src/providers/data/*.json 与 src/models.generated.ts
examples/run.ts     命令行 demo —— catalog 摘要 + mock loop + 真实 deepseek-v4-pro 跑 agent-loop
tests/             vitest 单测(agent-loop / tool-registry / execution-env / stdlib-tools / stdlib-agent,35 测试 passed)
dist/              构建输出 tsc 编译产物(NodeNext 模式 + .d.ts 声明)
tmp/               运行时产物(JSONL ledger 等),已 gitignore
```

## 5. 与 pi 的差异

- 单包(非 monorepo);
- pi-ai 层**全量移植**(api / auth / providers / storage / utils / 类型 / catalog 全部到位),与 pi-ai 等价;
- **agent-loop 复活(`src/runtime/`)**,实跑能通过 pi-ai `openai-completions` adapter 调到真实 LLM(本期实测 deepseek-v4-pro),事件协议对齐 pi-ai `AssistantMessageEvent`(start / text_delta / toolcall_end / done / error),`StreamFn` 接口承接 model + LlmContext + options,默认 `convertToLlm` 把 AgentMessage[] 摊平为 pi-ai Message[];
  - **stdlib 工具集复活**:fork pi `core/tools/{read,write,edit,bash,grep,find,ls}.ts`,简化路径:不引 pi 的 ToolContext 闭包、render-prompt hooks、`wrapToolDefinition` 双层 ToolDefinition 包装,直接 cwd 闭包 + 可选 `operations` 注入 IO/shell;`grep`/`find` 在 rg/fd 不可用时自动回退到 grep/find,probe 后再 spawn 他命令;
  - **ExecutionEnv 复活**:`FileSystem` + `Shell` 抽象加入(`runtime/execution-env.ts`),`utils/shell.ts` 探测 win 下 git-bash;`storage/resolve-config-value.ts` 仍**不**引 `$(cmd)`,防止无量引入命令注入面;
  - **stdlibStreamFn 桥接**:提供 `createStdlibAgent(opts)` 一站式将 stdlib 工具集 + mock/真实 streamFn + Agent 类组合,便于示例与 review;`stdlibStreamFn` 本身就是 `mockStreamFn` 别名(非新协议);
  - **M3 Task 系列 + lockfile + high-water mark**(`src/runtime/tasks/`、`src/runtime/ledger/lockfile.ts`):
    - `tasks/{types,task-tools}.ts` 定义 `TaskSnapshot` / `TaskStatus` / `TaskPriority` 与 `Task`/`TaskUpdate`/`TaskList` 三个工具;任务作为 ledger `custom` entry 持久化(`kind: "task"` / `"task_update"`);
    - `replayTaskSnapshots(entries)` 单调重放产生最新快照;排他机制保证同一时刻只有一个 in_progress 任务(新 in_progress 自动把旧 in_progress 落 pending);
    - `lockfile.ts` 基于 `proper-lockfile` 提供 `acquireLedgerLock(ledger, opts)`:50×100ms 内 acquire 失败 throw `LedgerLockError`;`forceUnlock(fp)` 紧急干预;
    - `LedgerSink.highWaterMark?()` 默认实现 = 已 append 的 entry 数(跨重启在 JsonlLedger 加载时继承);
  - **M4 5 个新占位工具**(`src/runtime/tools/`):
    - `multi-edit.ts` 一次调用 N 处编辑同文件;先在内存里依次应用 edits,任一 oldString 不存在 → 整体 abort(不写文件);`replaceAll=true` 全替换;
    - `web-fetch.ts` 原生 fetch + 最 trivial HTML→平文;HTTP(n=localhost/.local 不升级)自动升级 HTTPS,跨 host redirect throw,响应超 maxBytes(默认 2MB)截断;
    - `skill.ts` 占位:在 `handlers[name]` 中查找 handler;不存在返回友好提示,命中则把 string/JSON 结果透传;
    - `notebook-edit.ts` 占位:后续能力,任何调用都返回 not-implemented 提示;
    - `todo-write.ts` 整盘覆写当前任务表,内部调用 Task 系列实现 `n written + n updated + n deleted` 语义;
  - **M5 TUI 三态组件升级**:
    - `ToolCallComponent` 已支持四态(pending ⏳ / running … / ok ✓ / error ✗)+ setError/finalize;
    - `DiffPreviewComponent` M5 升级加 status 字段,表头 icon 与 ToolCall 对齐;展开态追加 `  - before / + after / ! ERR:` 行;
    - 新增 `BashExecutionComponent` 实时执行块:status / appendStdout/appendStderr / runInBackground "(bg)" 标记 / finalize exitCode+duration;tail 默认 200 行(可配置),`maxTailLines / 2` 上限防长跑日志炸内存;
  - **M6 examples + mock-stream phase**:
    - `examples/m3-demo.ts` Task + lockfile + high-water + MultiEdit 6 阶段演示,跑 `npx tsx examples/m3-demo.ts` 全绿;
    - `mockStreamFn` 新增 phase 0(首轮)/phase 1(已有 ≤3 个 toolResult)/phase 2(≥4 个 toolResult final summary);`detectMockPhase(ctx)` 纯函数 + `options.onPhase(phase)` 钩子;新 `MAX_TOOL_TURNS_PER_SESSION = 4`;
  - 仍未实现:transformContext / AgentHarness / compaction(详见 §1.3);
- `storage/getAgentDir` 默认 `~/.runledger/agent`,可用环境变量 `RUNLEDGER_DIR` 覆盖(pi 中是 `PI_CODING_AGENT_DIR`);
- `storage/resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}` 模板,**不**支持 pi 的 `$(cmd)` shell 命令,
  以避免引入额外 shell 注入面与近距离依赖;
- 未引入 `compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / `cli.ts` 这些 coding-agent 产物;
- `tsconfig.base.json` 不开 `experimentalDecorators` / `emitDecoratorMetadata`(RunLedger 不用装饰器);
- `tsconfig.base.json` 不开 `noUncheckedIndexedAccess`(与 pi 一致,因为 pi-ai 自身代码在 noUncheckedIndexedAccess 下报 100+ 误警,关闭后通顺通过)。

更多参考见 `docs/pi-architecture.md`。
