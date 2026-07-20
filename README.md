# RunLedger

企业级 **可审计** Agent Runtime 的最小可运行脚手架,本期已接入 pi-ai 全量移植层(provider 抽象 + 凭据 + OAuth 流 + 模型 catalog)。

> 名字来源:`Run` + `Ledger`,即"运行账本"。每次 agent 启动 → LLM 调用 → 工具执行 → 结束的全程事件,以 append-only JSONL 落盘,形成不可篡改的审计线索。

## 项目目标

1. **可审计**:全程事件入账,JSONL 单文件 append-only,易于排查、回放、合规;
2. **pi-ai 全量移植**:30 个 provider 适配 + 35 个 provider 工厂 + 1061 个模型 catalog + 完整 OAuth/pkce/凭据流;
3. **agent-loop 待填实**:运行循环、Agent 类、Ledger、echo 工具仍是空骨架,暂存 `src/_legacy/`,
   等待独立任务"agent-loop 填实"补齐(本期不实现)。

详细架构与对照(参考 `pi` 项目)见 [`docs/pi-architecture.md`](./docs/pi-architecture.md)。

## 快速开始

```bash
npm install
npm run check          # TypeScript 完整 typecheck(本期已通过)
npm run demo           # 列出 providers / models catalog + 报告 ~/.runledger/agent 目录
npm run generate-models  # 重新生成 src/providers/data/*.json 与 src/models.generated.ts
npm run build          # 编译到 dist/
# npm test             # tests/agent-loop.test.ts 等待 agent-loop 填实后再跑
```

## 架构(本期)

```
RunLedger
├── pi-ai 移植层(本期完成)
│   ├── src/api/        30 个 provider 适配实现
│   ├── src/auth/       凭据类型 + 8 个 OAuth 流
│   ├── src/providers/  35 个 provider 工厂 + data/*.json(1061 个模型)
│   ├── src/storage/    auth.json + lockfile + runtime override + 路径解析
│   ├── src/utils/      uuid / overflow / retry / diagnostics / event-stream / ... 21 个
│   ├── src/types.ts    中心类型
│   ├── src/models.ts   Provider/Models factory
│   ├── src/index.ts    pi-style barrel
│   └── scripts/generate-models.ts  模型 catalog 生成器
│
└── agent-loop 层(本期空骨架,暂存 src/_legacy/)
    ├── agent-loop.ts   runAgentLoop 核心循环(待填实)
    ├── agent.ts        Agent 类(待填实)
    ├── event-stream.ts push-based EventStream(待与 pi utils/event-stream.ts 对齐)
    ├── ledger/         memory-ledger / jsonl-ledger(待填实)
    ├── tools/echo.ts   echo 工具(待填实)
    └── providers/mock-stream.ts  mock streamFn(待与 faux provider 对齐)
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
│   ├── providers/          # 35 个 provider 工厂 + data/*.json
│   ├── storage/            # auth-storage / runtime-credentials / paths / resolve-config-value
│   ├── utils/             # 21 个工具文件
│   ├── compat/             # extension-oauth-types.ts
│   ├── _legacy/            # agent-loop / agent / event-stream / ledger 空骨架
│   ├── index.legacy.ts     # 旧 barrel 备份
│   ├── tools/echo.legacy.ts  # 旧 echo 工具备份
│   └── providers/mock-stream.legacy.ts  # 旧 mock provider 备份
├── scripts/
│   └── generate-models.ts  # 2420 行硬编码模型数据,跑 npm run generate-models 重新生成
├── examples/
│   └── run.ts              # demo:列出 providers / models + 报告 agent 目录
├── tests/
│   └── agent-loop.test.ts  # 等待 agent-loop 填实后再跑
├── docs/
│   └── pi-architecture.md  # 参考架构说明
└── AGENTS.md              # 开发规则(范围 / 风格 / 工作流)
```

## 核心概念

### pi-ai 移植层

- **`Models`** 是 pi 的核心工厂(`src/models.ts:createModels()`),绑定 `credentialStore` + `modelsStore` + `provider factories`,提供 `getProvider` / `getAuth` / `stream` / `streamSimple` 接口。
- **`Provider<TApi>`** 是 35 个 provider 的统一抽象,每个 provider 有自己的 `*.models.ts`(自动生成)+ `*.ts`(实现 stream 入口)。
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
- [x] `examples/run.ts` demo 跑 pi-ai 移植层(35 providers / 1061 models 列表 + cost 解析)
- [x] `npm run check` 通过

### 待填实(独立任务)

- [ ] agent-loop / Agent 类:与 pi types 对齐,把 `src/_legacy/{agent-loop,agent,event-stream}.ts` 与 `pi/utils/event-stream.ts` 对齐后重纳入 typecheck;
- [ ] Ledger:`src/_legacy/ledger/{memory-ledger,jsonl-ledger}.ts` 填实;
- [ ] `tests/agent-loop.test.ts` 在 agent-loop 填实后恢复;
- [ ] `tools/echo.ts` 重新实现并对接 pi-tool 抽象;
- [ ] `providers/mock-stream.ts` 与 pi `faux` provider 合并(消除重复);
- [ ] `// TODO(pi):` 真实 LLM 调用串通(用 anthropic-messages stream);
- [ ] `// TODO(pi):` Session 树(分叉/重放);
- [ ] `// TODO(pi):` Compaction / 摘要;
- [ ] `// TODO(pi):` Skills / Prompt templates;
- [ ] `// TODO(pi):` AgentHarness;
- [ ] `// TODO(pi):` streamProxy (browser → backend);
- [ ] `// TODO(pi):` ExecutionEnv 抽象;
- [ ] `// TODO(pi):` OpenTelemetry / metrics;
- [ ] `// TODO(pi):` RBAC / 多租户。

## License

MIT
