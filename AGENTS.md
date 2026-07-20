# RunLedger 开发规则

> RunLedger 是一个面向 企业级可审计 Agent Runtime 的最小可运行脚手架,参考 `pi` 项目 (`packages/agent` 与 `packages/ai`) 的架构。本期已完成 pi-ai 全量移植,agent-loop 层保留为空骨架,等待后续填实。

## 1. 范围

### 1.1 已完成(`src/` 顶层 + `src/api/` + `src/auth/` + `src/providers/` + `src/storage/` + `src/utils/` + `src/compat/`)

从 pi `packages/ai/src` 移植的全量 LLM provider 抽象层与凭据/OAuth 流:

- `src/api/` 30 个 provider 适配实现(anthropic-messages / openai-responses / openai-codex / google-generative-ai / google-vertex / mistral / bedrock / cloudflare / openrouter / azure 等),含 lazy 版本;
- `src/auth/` 凭据类型、CredentialStore OAuth 流(`oauth/anthropic.ts` / `openai-codex.ts` / `github-copilot.ts` / `xai.ts` / `radius.ts` / `device-code.ts` / `pkce.ts` / `oauth-page.ts`);
- `src/providers/` 35 个 provider 文件 + 自动生成的 `data/*.json` 模型 catalog(1061 个模型);
- `src/storage/` `auth-storage.ts`(auth.json + proper-lockfile)+ `runtime-credentials.ts` + `paths.ts` + `resolve-config-value.ts`;
- `src/utils/` 工具库(uuid / overflow / diagnostics / retry / validation / encode / decode / event-stream 等 21 个文件);
- 顶层 `models.ts` / `models-store.ts` / `models.generated.ts` / `images-models.ts` / `image-models.ts` / `image-models.generated.ts` / `images.ts` / `images-api-registry.ts` / `session-resources.ts` / `oauth.ts` / `bun-oauth.ts` / `bedrock-provider.ts`;
- `scripts/generate-models.ts` —— pi 自动模型 catalog 生成脚本(已迁移,跑 `npm run generate-models` 重新生成 `src/providers/data/*.json` 与 `src/models.generated.ts`)。

### 1.2 待填实(暂存于 `src/_legacy/`,`tsconfig.json` 已暂排除)

`agent-loop` 核心循环与 ledger 骨架原本是 RunLedger 自有空骨架,引用了一组 pi `packages/agent-core` 抽象(`AgentContext` / `AgentEvent` / `AgentLoopConfig` / `AgentEventSink` / `LlmContext` / `AgentTool` / `AgentToolCall` / `UserAgentMessage` / `AssistantAgentMessage` / `ToolResultAgentMessage` / `AgentMessage` / `StreamFn` / `AssistantMessageEventStream` / `StreamOptions` 等)。本期只移植 pi-ai 层,不引入 pi-agent-core 与 pi-coding-agent 层。

`src/_legacy/` 下保留:

- `agent-loop.ts`、`agent.ts`、`event-stream.ts` —— RunLedger 自研空骨架;
- `ledger/{memory-ledger,jsonl-ledger,types}.ts` —— 内存/JSONL 审计账本空骨架;
- `src/index.legacy.ts`、`src/tools/echo.legacy.ts`、`src/providers/mock-stream.legacy.ts` —— 旧 barrel / 工具 / mock provider。

`tests/agent-loop.test.ts` 引用上述空骨架,在 agent-loop 填实前会失败。修这 2 个 test 属于"agent-loop 填实"独立任务,**不在 pi-ai 移植范围内**。

### 1.3 显式不实现(以 `// TODO(pi):` 注释占位)

- `transformContext` 上下文变换;
- `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages` 队列;
- `thinkingBudgets` / `temperature` / `maxTokens` / `transport` / `maxRetries`;
- Session 树分叉(JSONL ledger 是扁平的);
- `AgentHarness` 高级状态机;
- Compaction / branch summarization;
- Skills (`SKILL.md` 加载) / Prompt templates;
- `streamProxy` (browser → backend);
- `ExecutionEnv` (FileSystem + Shell) 抽象层;
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
- Git:只 `git add <path1> <path2>` 修改的文件;禁止 `git add -A` / `-a` / `--no-verify`;禁止 `git reset --hard` / `git checkout .` / `git stash`;
- 每个 PR/commit 关注一件小事,描述写"为什么",不写"是什么"(差异本身已说明是什么)。

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
  providers/        35 个 provider 工厂 + data/*.json(自动生成 model catalog)
  storage/          auth-storage / runtime-credentials / paths / resolve-config-value
  utils/            uuid / overflow / diagnostics / retry / validation / event-stream / ... 21 个文件
  compat/           extension-oauth-types.ts(OAuth 类型桥)
  _legacy/          空 agent-loop / agent / event-stream / ledger,TypeScript 暂 exclude
  index.legacy.ts / tools/echo.legacy.ts / providers/mock-stream.legacy.ts  旧空骨架备份
scripts/
  generate-models.ts  2420 行硬编码模型数据,跑生成 src/providers/data/*.json 与 src/models.generated.ts
examples/run.ts     命令行 demo —— 列出 providers / models catalog + 报告 agent 目录
tests/             vitest 单测(agent-loop.test.ts 等待 agent-loop 填实)
dist/              构建输出 tsc 编译产物(NodeNext 模式 + .d.ts 声明)
tmp/               运行时产物(JSONL ledger 等),已 gitignore
```

## 5. 与 pi 的差异

- 单包(非 monorepo);
- pi-ai 层**全量移植**(api / auth / providers / storage / utils / 类型 / catalog 全部到位),与 pi-ai 等价;
- agent-loop / agent / ledger / tools / mock-stream 仍是 RunLedger 自研空骨架(暂存 `src/_legacy/`),
  在 agent-loop 填实独立任务到来前,这些不参与 typecheck;
- `storage/getAgentDir` 默认 `~/.runledger/agent`,可用环境变量 `RUNLEDGER_DIR` 覆盖(pi 中是 `PI_CODING_AGENT_DIR`);
- `storage/resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}` 模板,**不**支持 pi 的 `$(cmd)` shell 命令,
  以避免引入 `utils/shell.ts`(git-bash 检测)这条重链;
- 未引入 `compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / `cli.ts` 这些 coding-agent 产物;
- `tsconfig.base.json` 不开 `experimentalDecorators` / `emitDecoratorMetadata`(RunLedger 不用装饰器);
- `tsconfig.base.json` 不开 `noUncheckedIndexedAccess`(与 pi 一致,因为 pi-ai 自身代码在 noUncheckedIndexedAccess 下报 100+ 误警,关闭后通顺通过)。

更多参考见 `docs/pi-architecture.md`。
