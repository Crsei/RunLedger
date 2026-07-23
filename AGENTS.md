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
- `ledger/{types,memory-ledger,jsonl-ledger}.ts` —— v2 内存与 JSONL 审计账本(append-only,失败不抛错,以 `lastError` 字段保留报告路径),v1 文件只读兼容;
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

#### 1.2.x 项目层 .runledger/ 与 CLI 入口(M8 §0–§3,2026-04-28)

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

- `paths.ts` —— `getProjectDir / getProjectSessionsDir / getProjectSettingsPath / getProjectAgentsMd / getGlobalAgentsMd`(都受 cwd 与 env `RUNLEDGER_DIR` / `RUNLEDGER_SESSION_DIR` 影响),`resolveSessionDir(cwd, settingsSessionDir?)` 抽出 settings.sessionDir 与 env 的优先级关系;
- `path-utils.ts` —— 纯函数 `encodeCwd / safeIso / buildSessionFileName`(便于单测,不引 fs);
- `settings-manager.ts` —— `ProjectSettings` schema + 异步 `loadProjectSettings` / `loadProjectSettingsSync` / `saveProjectSettings`(0o600 文件 + 0o700 父目录),未知字段丢弃、解析失败回退空不抛错(只写 stderr);
- `session-manager.ts` —— `SessionManager` 在 `JsonlLedger` 上的薄包装,接口 `create / open / continueRecent / forkFrom / list / listAll / acquireLock`。`open` 显式初始化但不追加 placeholder;fork 生成新 sessionId 并保留 parentSession/parentSessionId;CLI 持有整场独占锁直到退出。
- `session-codec.ts` —— v2 canonical `AgentMessage` 与 runtime config 无损恢复;legacy v1 仅恢复安全文本并给出 warning,不伪造 tool args/thinking signature。

`tests/storage/` 当前形态:

- `path-utils.test.ts` —— encodeCwd / safeIso / buildSessionFileName 跨平台(10 测试)
- `paths.test.ts` —— getProjectDir / resolveSessionDir 优先级(16 测试)
- `settings-manager.test.ts` —— load/sync/save + 损坏 JSON 回退 + 0o600 mode(9 测试)
- `session-manager.test.ts` —— create/open/continueRecent/forkFrom/list 跨场景(13 测试)

`src/cli/` 当前形态:

- `args.ts` —— 手写 argv parser,支持 `-c/--continue / -r/--resume / --session <path> / --session-id <id> / --fork <path> / --provider <id> / -m/--model <id> / --thinking <level> / --session-dir <dir> / --debug / -v/--version / -h/--help`,未知 flag 兜到 `unknown: Map<name, string|true>` 不抛错;
- `main.ts` —— 装配 36 个 builtin provider + `AuthStorage` + v2 session replay + `InteractiveSessionController`;生产 CLI 不回退 mock,无认证时进入 TUI onboarding;`InteractiveMode.run()` 持续到退出后才在 finally 释放整场 ledger lock;
- `cli.ts` —— bin 入口,仅 `main(process.argv.slice(2)).catch(exit 1)`;业务全留 main.ts 以便单测 spawnSync 跑。

`bin/runledger.js` —— npm bin shim,直接 import 编译后的 `dist/cli/cli.js`;运行时不依赖 tsx 或 src,重新链接前先跑 `npm run build`。

`tests/cli/` 当前形态:

- `args.test.ts` —— parseArgs 全旗 + error 通道 + 未知兜底(23 测试)
- `main.test.ts` —— `--help / -h / --version / -v / --thinking bogus / --session 缺值` 通过 spawnSync `node --import tsx` 真跑 cli.ts 路径(7 测试)。真 TUI 路径因 stdin 阻塞留 manual smoke test。

总计 264 测试全绿。`npm run check` 与 `npm test` 应同时通过再行 commit。

`npm link` 后 PATH 上的 `runledger` 命令可直接打开 tui:
`runledger --help` / `runledger --version` / `runledger`(无凭据进入 provider onboarding)、`runledger -c`(continueRecent)、`runledger --resume`(TUI 选择历史会话)、`runledger --session <path>`、`runledger --fork <path>`。

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
- Git:只暂存本任务明确涉及的显式路径;新增或修改使用 `git add -A -- <paths...>`,删除使用 `git add -u -- <paths...>`;禁止不带路径的 `git add -A` / `git add .` / `git commit -a` / `--no-verify`;禁止 `git reset --hard` / `git checkout .` / `git stash`;
- 每个 PR/commit 关注一件小事,描述写"为什么",不写"是什么"(差异本身已说明是什么)。

### Git 提交与推送

提交本仓库时使用显式路径的手动流程,不要依赖仓库内脚本。提交和推送是独立的状态变更。只有用户明确要求提交时才创建 commit；只有用户明确要求推送时才推送。工作区可能同时存在其他任务的改动,不能把 `git status` 中出现的全部文件视为本任务范围。

提交前先确认当前仓库、分支和改动边界，并审阅本任务实际改动：

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
git status --short
git branch --show-current
git diff --check
git diff -- <explicit-paths...>
```

代码、测试、生成物或依赖变更在提交前必须完成对应验证。通常依次执行 `npm run check` 与 `npm test`；模型 catalog 变更还必须先执行 `npm run generate-models` 并审阅生成结果。纯文档变更至少要通过 `git diff --check`，不因无关的既有失败伪造通过状态。

提交身份与 `allthecodes` 仓库一致。RunLedger 的 linked worktree 共享仓库级 Git 配置,设置一次即可应用到所有工作树：

```bash
git config user.name "Crsei"
git config user.email "Crsei@protonmail.com"
git config --get user.name
git config --get user.email
```

暂存必须逐路径进行。新增或修改文件使用 `git add -A --`，删除文件使用 `git add -u --`；拆分或重命名为“新增目录 + 删除旧文件”时，先暂存新目录，再单独暂存旧文件删除：

```bash
git add -A -- AGENTS.md src/runtime/new-module.ts tests/new-module.test.ts
git add -u -- src/runtime/old-module.ts
git diff --cached --name-status
git diff --cached --check
git diff --cached
git commit -m "<short imperative purpose-oriented summary>"
git status --short
git log -1 --oneline
```

- 不使用不带显式路径的 `git add -A`、`git add .`、`git commit -a`、`--no-verify`,也不借用其他仓库的提交脚本。
- 新增目录模块时使用 `git add -A -- <new-directory>`；删除的旧文件单独使用 `git add -u -- <deleted-file>`,避免将共享工作区的无关删除带入提交。
- 提交前必须用 `git config --get user.name` 和 `git config --get user.email` 确认身份为 `Crsei` / `Crsei@protonmail.com`；不正确时按上述仓库级配置修正。
- commit 只覆盖一件小事，消息写明目的或原因；未暂存的无关改动必须保留在工作区。

需要推送时，先核对远端和当前分支。本仓库当前预期的 `origin` 是 `https://github.com/Crsei/RunLedger.git`，但每次推送前仍以本地配置为准：

```bash
git remote get-url origin
git push origin "$(git branch --show-current)"
```

如认证不可交互,可使用临时 `GIT_ASKPASS` 帮助程序读取 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/github_token.txt`；GitHub 用户名使用 `Crsei`。关闭 shell xtrace、将帮助程序权限设为 `700`、设置 `GIT_TERMINAL_PROMPT=0`,并在命令结束后立即删除它。不得读取、打印、复制或暂存 token、密码或凭据文件。若只需要本地提交,省略推送步骤。

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
  - **M3 V2 Task 系列 + lockfile + high-water mark**(`src/runtime/tasks/`、`src/runtime/ledger/lockfile.ts`):
    - `tasks/{types,task-tools}.ts` 定义 `TaskSnapshot` / `TaskStatus` / `TaskPriority` 与 `Task`/`TaskUpdate`/`TaskList` 三个 V2 工具;任务作为 ledger `custom` entry 持久化(`kind: "task"` / `"task_update"`);
    - `replayTaskSnapshots(entries)` 单调重放产生最新快照;V2 排他机制保证同一时刻只有一个 in_progress 任务(新 in_progress 自动把旧 in_progress 落 pending);
    - `lockfile.ts` 基于 `proper-lockfile` 提供 `acquireLedgerLock(ledger, opts)`:50×100ms 内 acquire 失败 throw `LedgerLockError`;`forceUnlock(fp)` 紧急干预;
    - `LedgerSink.highWaterMark?()` V2 新增,默认实现 = 已 append 的 entry 数(跨重启在 JsonlLedger 加载时继承);
  - **M4 5 个新占位工具**(`src/runtime/tools/`):
    - `multi-edit.ts` 一次调用 N 处编辑同文件;先在内存里依次应用 edits,任一 oldString 不存在 → 整体 abort(不写文件);`replaceAll=true` 全替换;
    - `web-fetch.ts` 原生 fetch + 最 trivial HTML→平文;HTTP(n=localhost/.local 不升级)自动升级 HTTPS,跨 host redirect throw,响应超 maxBytes(默认 2MB)截断;
    - `skill.ts` 占位:在 `handlers[name]` 中查找 handler;不存在返回友好提示,命中则把 string/JSON 结果透传;
    - `notebook-edit.ts` 占位:V2 future,任何调用都返回 not-implemented 提示;
    - `todo-write.ts` 整盘覆写当前任务表,内部调用 V2 Task 系列实现 `n written + n updated + n deleted` 语义;
  - **M5 TUI 三态组件升级**:
    - `ToolCallComponent` 已支持四态(pending ⏳ / running … / ok ✓ / error ✗)+ setError/finalize;
    - `DiffPreviewComponent` M5 升级加 status 字段,表头 icon 与 V2 ToolCall 对齐;展开态追加 `  - before / + after / ! ERR:` 行;
    - 新增 `BashExecutionComponent` 实时执行块:status / appendStdout/appendStderr / runInBackground "(bg)" 标记 / finalize exitCode+duration;tail 默认 200 行(可配置),`maxTailLines / 2` 上限防长跑日志炸内存;
  - **M6 examples + mock-stream phase**:
    - `examples/m3-demo.ts` V2 Task + lockfile + high-water + MultiEdit 6 阶段演示,跑 `npx tsx examples/m3-demo.ts` 全绿;
    - `mockStreamFn` 新增 phase 0(首轮)/phase 1(已有 ≤3 个 toolResult)/phase 2(≥4 个 toolResult final summary);`detectMockPhase(ctx)` 纯函数 + `options.onPhase(phase)` 钩子;新 `MAX_TOOL_TURNS_PER_SESSION = 4`;
  - 仍未实现:transformContext / AgentHarness / compaction(详见 §1.3);
- `storage/getAgentDir` 默认 `~/.runledger/agent`,可用环境变量 `RUNLEDGER_DIR` 覆盖(pi 中是 `PI_CODING_AGENT_DIR`);
- `storage/resolve-config-value.ts` 仅支持字面值与 `${ENV_VAR}` 模板,**不**支持 pi 的 `$(cmd)` shell 命令,
  以避免引入额外 shell 注入面与近距离依赖;
- 未引入 `compat.ts` / `legacy-api-aliases.ts` / `env-api-keys.ts` / `cli.ts` 这些 coding-agent 产物;
- `tsconfig.base.json` 不开 `experimentalDecorators` / `emitDecoratorMetadata`(RunLedger 不用装饰器);
- `tsconfig.base.json` 不开 `noUncheckedIndexedAccess`(与 pi 一致,因为 pi-ai 自身代码在 noUncheckedIndexedAccess 下报 100+ 误警,关闭后通顺通过)。

更多参考见 `docs/pi-architecture.md`。
