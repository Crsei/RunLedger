# RunLedger 开发规则

> RunLedger 是一个面向 企业级可审计 Agent Runtime 的最小可运行脚手架,参考 `pi` 项目 (`packages/agent` 与 `packages/ai`) 的架构。本期已完成 pi-ai 全量移植,以及 agent-loop / Agent / ledger / mock-stream / echo tool / stdlib 工具集 / ExecutionEnv / stdlibStreamFn 桥接的最小可运行复活(真实 LLM 已用 `asset/api-key.json` 中 deepseek-v4-pro 通过 `npm run demo` 验证,mock 模式仍保留为单测入口)。

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

### 1.2 已复活(`src/runtime/`,纳入 typecheck + `npm test` + `npm run demo`)

`agent-loop` 核心循环与 ledger 在 RunLedger 自研骨架基础上对接 pi-ai `AssistantMessageEventStream` 与 `Model<Api>` 类型:

`src/runtime/` 下当前形态:

- `agent-loop.ts` —— `runAgentLoop` 双层循环(outer turn / inner assistant stream),`done.message.stopReason === "toolUse"` 时执行 toolCalls 并进入下一 turn;
- `agent.ts` —— `Agent` 有状态包装类,`subscribe / on / prompt`,内置 ledger 透传;
- `types.ts` —— 复用 pi-ai `Message` / `Tool` / `ToolCall` / `StopReason` / `Model` / `StreamOptions` / `AssistantAgentMessage` 等,补 `LlmContext` / `AgentContext` / `AgentEvent` / `AgentEventSink` / `AgentLoopConfig` / `AgentTool` / `AgentToolCall` / `UserAgentMessage` / `ToolResultAgentMessage` / `StreamFn` 等运行循环层接口;
- `ledger/{types,memory-ledger,jsonl-ledger}.ts` —— 内存与 JSONL 审计账本(append-only,失败不抛错,以 `lastError` 字段保留报告路径);
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
`src/_legacy/` 目录已清空,从 tsconfig exclude 中移除;早期的 `index.legacy.ts` 仍存在但不再被引用,作为防御性占位等待后续清理。

### 1.3 显式不实现(以 `// TODO(pi):` 注释占位)

- `transformContext` 上下文变换;
- `prepareNextTurn` / `getSteeringMessages` / `getFollowUpMessages` 队列;
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
  utils/            uuid / overflow / diagnostics / retry / validation / event-stream / shell(git-bash 探测)/ ... 21+1 个文件
  compat/           extension-oauth-types.ts(OAuth 类型桥)
  runtime/          agent-loop / agent / ledger / tools (echo+stdlib 8 个) / tool-registry / execution-env / providers/mock-stream / stdlib-stream,本期已复活并纳入 typecheck + npm test
  index.legacy.ts   旧 barrel 备份(不再被引用,等待后续清理)
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
  - 仍未实现:transformContext / 队列 / AgentHarness / compaction(详见 §1.3);
- `storage/getAgentDir` 默认 `~/.runledger/agent`,可用环境变量 `RUNLEDGER_DIR` 覆盖(pi 中是 `PI_CODING_AGENT_DIR`);
- `storage/resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}` 模板,**不**支持 pi 的 `$(cmd)` shell 命令,
  以避免引入额外 shell 注入面与近距离依赖;
- 未引入 `compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / `cli.ts` 这些 coding-agent 产物;
- `tsconfig.base.json` 不开 `experimentalDecorators` / `emitDecoratorMetadata`(RunLedger 不用装饰器);
- `tsconfig.base.json` 不开 `noUncheckedIndexedAccess`(与 pi 一致,因为 pi-ai 自身代码在 noUncheckedIndexedAccess 下报 100+ 误警,关闭后通顺通过)。

更多参考见 `docs/pi-architecture.md`。
