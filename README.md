# RunLedger

企业级 **可审计** Agent Runtime 的最小可运行脚手架,本期已接入 pi-ai 全量移植层(provider 抽象 + 凭据 + OAuth 流 + 模型 catalog),并在其上**复活了 agent-loop + Agent + ledger + echo tool + mock-stream** 的最小可运行形态,经真实 LLM(deepseek-v4-pro)端到端验证。

> 名字来源:`Run` + `Ledger`,即"运行账本"。每次 agent 启动 → LLM 调用 → 工具执行 → 结束的全程事件,以 append-only JSONL 落盘,形成不可篡改的审计线索。

## 项目目标

1. **可审计**:全程事件入账,JSONL 单文件 append-only,易于排查、回放、合规;
2. **pi-ai 全量移植**:30 个 API 适配 + 36 个 builtin provider(35 份自动生成 catalog,1061 个模型)+ 完整 OAuth/pkce/凭据流;
3. **agent-loop 已复活**(`src/runtime/`):`runAgentLoop` + `Agent` + `MemoryLedger` + `echoTool` + `mockStreamFn`,
   `tests/agent-loop.test.ts` 2/2 通过;`examples/run.ts` 用 `asset/api-key.json` 中 deepseek-v4-pro
   走现有 pi-ai `openai-completions` adapter 跑通 turn-1 toolUse → turn-2 stop 全链路。

详细架构与对照(参考 `pi` 项目)见 [`docs/pi-architecture.md`](./docs/pi-architecture.md)。

## 快速开始

```bash
npm install
npm run check          # TypeScript 完整 typecheck(本期已通过)
npm run demo           # catalog 摘要 + mock loop demo + 真实 deepseek-v4-pro demo(需 asset/api-key.json)
npm run generate-models  # 重新生成 src/providers/data/*.json 与 src/models.generated.ts
npm run build          # 编译到 dist/
npm test               # vitest,264 测试全绿
npm link               # 注册 dist CLI 到 PATH(可 `npm unlink -g runledger` 撤销)
runledger --version    # 打印版本
runledger --help       # 看 CLI 旗标
ANTHROPIC_API_KEY=sk-ant-... runledger --provider anthropic --model claude-haiku-4-5
runledger                              # 无凭据进入 /provider、/login onboarding
runledger -c                          # continueRecent 续最近会话
runledger --resume                    # TUI 选择历史会话
runledger --session <path>.jsonl      # 直接打开已知 session 文件
runledger --fork <path>.jsonl         # fork 某 session 到本项目 .runledger/sessions/
```

项目层布局(`.runledger/`)在 AGENTS.md §1.2.x 详述;`settings.json` 写 `model/thinkingLevel/theme/sessionDir/enabledModels` 五字段。

## 架构(本期)

```
RunLedger
├── pi-ai 移植层(本期完成)
│   ├── src/api/        30 个 provider 适配实现
│   ├── src/auth/       凭据类型 + 8 个 OAuth 流
│   ├── src/providers/  36 个 builtin provider + 35 份 data/*.json catalog(1061 个模型)
│   ├── src/storage/    auth.json + lockfile + runtime override + 路径解析
│   ├── src/utils/      uuid / overflow / retry / diagnostics / event-stream / ... 21 个
│   ├── src/types.ts    中心类型
│   ├── src/models.ts   Provider/Models factory
│   ├── src/index.ts    pi-style barrel
│   └── scripts/generate-models.ts  模型 catalog 生成器
│
└── agent-loop 层(本期已复活,在 src/runtime/)
    ├── agent-loop.ts   runAgentLoop 双层循环(outer turn / inner stream)
    ├── agent.ts        Agent 类(subscribe / on / prompt)
    ├── types.ts        复用 pi-ai 类型并补 LlmContext / AgentEvent / AgentTool 等
    ├── ledger/         memory-ledger / jsonl-ledger(append-only,失败不抛错)
    ├── tools/echo.ts   echo 工具(回显 text,验证 tool 调用链路)
    └── providers/mock-stream.ts  mock provider(对齐 pi-ai AssistantMessageEvent 协议)
```

## 目录结构

```
RunLedger/
├── src/
│   ├── index.ts            # pi-style barrel
│   ├── types.ts            # 中心类型
│   ├── models.ts           # Provider / Models factory
│   ├── models-store.ts     # InMemoryModelsStore / 凭据入出
│   ├── models.generated.ts # 自动生成(1061 个模型)
│   ├── oauth.ts            # OAuth 入口
│   ├── bun-oauth.ts        # Bun runtime OAuth 桥
│   ├── bedrock-provider.ts
│   ├── session-resources.ts
│   ├── image-models.ts / image-models.generated.ts / images.ts / images-api-registry.ts / images-models.ts
│   ├── api/                # 30 个 provider 适配
│   ├── auth/               # 凭据 + 8 个 OAuth 流(github-copilot / openai-codex / anthropic / xai / radius / device-code / pkce / oauth-page)
│   ├── providers/          # 36 个 builtin provider + 35 份 data/*.json catalog
│   ├── storage/            # auth-storage / runtime-credentials / paths / resolve-config-value
│   ├── utils/             # 21 个工具文件
│   ├── compat/             # extension-oauth-types.ts
│   ├── runtime/            # 本期已复活:agent-loop / agent / ledger / tools / mock-stream
│   └── index.legacy.ts     # 旧 barrel 备份(不再被引用,等待后续清理)
├── scripts/
│   └── generate-models.ts  # 2420 行硬编码模型数据,跑 npm run generate-models 重新生成
├── examples/
│   └── run.ts              # demo:catalog 摘要 + mock loop + 真实 deepseek-v4-pro
├── tests/
│   └── agent-loop.test.ts  # vitest,2/2 通过
├── docs/
│   └── pi-architecture.md  # 参考架构说明
└── AGENTS.md              # 开发规则(范围 / 风格 / 工作流)
```

## 核心概念

### pi-ai 移植层

- **`Models`** 是 pi 的核心工厂(`src/models.ts:createModels()`),绑定 `credentialStore` + `modelsStore` + `provider factories`,提供 `getProvider` / `getAuth` / `stream` / `streamSimple` 接口。
- **`Provider<TApi>`** 是 provider 的统一抽象;生产 TUI 当前注册 36 个 builtin provider,其中 35 份 catalog 由 `*.models.ts` + `data/*.json` 自动生成。
- **`auth-storage.ts`** 用 `proper-lockfile` 加锁写 `~/.runledger/agent/auth.json`,mode 0600。
- **`runtime-credentials.ts`** overlay 模式,允许在不修改 auth.json 的情况下注入运行时 API key。
- **`oauth/*`** 8 个 provider 的 OAuth 流(anthropic / openai-codex / github-copilot / xai / radius / 通用 device-code / 通用 pkce / oauth-page)。

### 生成模型 catalog

```bash
npm run generate-models
# → 抓取 models.dev / OpenRouter / Vercel AI Gateway / NVIDIA NIM 等源
# → 生成 src/providers/data/*.json(35 个文件)+ src/providers/*.models.ts(35 个文件)+ src/models.generated.ts
```

## 模块路线图

### 已完成

- [x] pi-ai **全量移植**(api / auth / providers / storage / utils / catalog 生成器)
- [x] `tsconfig.base.json` 与 pi 对齐(NodeNext + allowImportingTsExtensions + rewriteRelativeImportExtensions + erasableSyntaxOnly)
- [x] `examples/run.ts` demo 跑 pi-ai 移植层(36 builtin providers / 1061 models 列表 + cost 解析)
- [x] agent-loop / Agent 类:在 `src/runtime/` 复活并对接 pi-ai `AssistantMessageEventStream`(本期)
- [x] Ledger:`src/runtime/ledger/{memory-ledger,jsonl-ledger}.ts` 复活并接入 typecheck
- [x] `tools/echo.ts` 重新实现并对接 pi-ai `AgentTool` 抽象(typebox `Type.Object` parameters)
- [x] `providers/mock-stream.ts` 复活并直接复用 pi-ai `createAssistantMessageEventStream`(放弃骨架自研 EventStream)
- [x] `tests/agent-loop.test.ts` 恢复(vitest **2/2 通过**)
- [x] `examples/run.ts` 真实 LLM 串通:用 `asset/api-key.json` 中 deepseek-v4-pro 走现有 pi-ai `openai-completions` adapter 完成 turn-1 toolUse → turn-2 stop 全链路
- [x] `npm run check` 通过
- [x] agent-runtime 底座(M8 §A-§G):ToolRegistry/ToolContext + ExecutionEnv(FileSystem/Shell) + git-bash 探测 + stdlib 工具集(read/write/edit/bash/grep/find/ls)+ createAnthropicAgent + stdlibStreamFn 桥接
- [x] **项目层 `.runledger/` 布局 + SessionManager / SettingsManager / CLI 入口**(M8 §0–§3, 2026-04-28):`src/storage/{paths,path-utils,settings-manager,session-manager}.ts` + `src/cli/{args,main,cli}.ts` + `bin/runledger.js`;`npm run build && npm link` 后终端 `runledger` 命令从 `dist/cli/cli.js` 起 TUI
- [x] **M2 stdlib 工具集升级**(glob + read cat -n 缓存 + edit replaceAll/findActualString + bash run_in_background + grep -A/-B/-U/-output_format):192 tests pass
- [x] **M3 V2 Task 系统 + lockfile + high-water mark**(2026-04-28):`src/runtime/tasks/{types,task-tools}.ts` `Task/TaskUpdate/TaskList` 三工具 + `src/runtime/ledger/lockfile.ts` `acquireLedgerLock`/`LedgerLockError` + `LedgerSink.highWaterMark()`;208 tests pass;`examples/m3-demo.ts` 可跑 `npx tsx examples/m3-demo.ts`
- [x] **M4 5 新占位工具**(2026-04-28):`MultiEdit` / `WebFetch` / `Skill` / `NotebookEdit` / `TodoWrite`;219 tests pass;`createStdlibTools()` 注册数 8 → 13
- [x] **M5 TUI 三态组件升级**(2026-04-28):`DiffPreviewComponent` 加 status 字段 + `BashExecutionComponent` 新组件(pending/running/ok/error + stdout/stderr tail + run_in_background + exitCode+duration);234 tests pass
- [x] **M6 examples + mock-stream phase + doc sync**(2026-04-28):`mockStreamFn` 加 phase 0/1/2 + `detectMockPhase` + `MAX_TOOL_TURNS_PER_SESSION=4` + `options.onPhase` 钩子;`AGENTS.md` 与 `development-doc/tui/02-component-spec.md` §10 同步 M3/M4/M5/M6 变更;237 tests pass
- [x] **M7 TUI 补强 + integration**(2026-04-28):`tests/tui/m7-components.test.ts` 9 用例覆盖 ToolResult/AbortButton/BackgroundTask/Footer/DiffPreview 边界;`tests/integration/m7-e2e.test.ts` e2e 串 mockStreamFn → BashExecution tail → ToolCall 三态
- [x] **生产 TUI client 收口**(2026-07-21):36 builtin provider + API key/OAuth、provider/model/thinking 持久化、多轮对话与 stdlib tool、steer/follow-up、Ctrl+C interrupt、空编辑器 Ctrl+D/`/quit` 退出、v2 resume/fork/整场锁;33 files / 264 tests 全绿

### 待填实(独立任务)

- [ ] `providers/mock-stream.ts` 与 pi `faux` provider 合并(消除重复);
- [ ] `// TODO(pi):` 真实 LLM 调用串通用 anthropic-messages stream(本期实测走 openai-completions adapter 已通);
- [ ] `// TODO(pi):` Session 树(分叉/重放);
- [ ] `// TODO(pi):` Compaction / 摘要;
- [ ] `// TODO(pi):` Skills / Prompt templates;
- [ ] `// TODO(pi):` AgentHarness;
- [ ] `// TODO(pi):` streamProxy (browser → backend);
- [ ] `// TODO(pi):` OpenTelemetry / metrics;
- [ ] `// TODO(pi):` RBAC / 多租户。

## License

MIT
