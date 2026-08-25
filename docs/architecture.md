# RunLedger 架构

修改 `src/` 下任何代码前先读本文。它描述当前实现的组合方式、核心模块、运行时分层与扩展点;不承担行为细节——每节链接到持有细节的权威文档。开发流程与门禁见根 [`AGENTS.md`](../AGENTS.md),各模块的实施计划与设计输入见 [`development-doc/00-index.md`](../development-doc/00-index.md)。架构的 pi 参考输入见 [`pi-architecture.md`](pi-architecture.md)。

## 概览

RunLedger 是单包(非 monorepo)的 TypeScript Agent Runtime,架构分三层:

| 层 | 目录 | 职责 |
|---|---|---|
| pi-ai 移植层 | `src/` 顶层 + `src/api/` + `src/auth/` + `src/providers/` + `src/utils/` + `src/compat/` | provider 抽象、凭据与 OAuth 流、模型 catalog |
| 运行时层 | `src/runtime/` | agent-loop、ledger、工具、Session Owner Runtime、进程/PTY、上下文、trace、契约 |
| 应用层 | `src/tui/` + `src/cli/` + `src/security/` + `src/storage/` + `src/workspace/` + `src/worktree/` + `src/extensions/` + `src/lsp/` | 终端 UI、CLI 入口、安全组合、存储布局、平台适配、扩展宿主 |

**审计主线**:每次 agent 启动 → LLM 调用 → 工具执行 → 结束的全程事件,以 append-only ledger 落盘(`src/runtime/ledger/`),并以 trace recorder 记录 Event/Artifact(`src/runtime/trace/`)。会话、工具副作用与运行时状态都在这一主线上可重放、可审计。

## 组合根(`src/cli/main.ts`)

标准 CLI 是唯一生产装配点,`main(argv)` 按子命令分流后进入主流程:

1. **子命令**:`migrate`、`workspace`、`storage prune-legacy` 各自独立执行;其余走主流程。
2. **环境与参数**:`parseArgs` 校验旗标;`validateLegacyCliEnvironment` 拒绝旧环境变量与 `--session-dir`(fail closed)。
3. **布局解析**:`resolveRunledgerHome()` 解析 `RUNLEDGER_DIR`(必须是既有绝对目录)或默认 `<用户主目录>/.runledger`,得 `RunledgerLayout`;默认 home 首启创建(mode 0700)。
4. **会话库**:`openSessionDatabase` 打开 SQLite `state.db`,只读冻结 schema header——too-new/too-old 全部 fail closed;首次安装 schema、schema version 1→schema version 2 显式迁移、`admission !== "ready"` 拒绝启动。`SessionStore`(会话 catalog)与 `OwnerStore`(owner 状态)在此构造。
5. **会话解析**:`resolveSessionId` 从 catalog 按 create/open/continue_recent/resume/fork 解析目标 session。
6. **服务装配**:`builtinModels` + `AuthStorage`、`createCliSessionModelRequestRouterFactory`(model routing)、worktree registry + `createWorkspaceAdaptersForCurrentPlatform`、`createEmbeddedSessionRuntime`(Session Owner 路径)、settings/syntaxThemes/tuiPreferences/traceRecorderFactory。
7. **视图打开**:`openView` 经 `createEmbeddedSessionRuntime` 拉起 SessionRuntime,`claimDriver` 决定本地连接是 driver 还是 observer,经 TCP facade 拉取 TUI 初始投影。

装配细节见 [`development-doc/runtime/06-session-owner-runtime-replacement-plan.md`](../development-doc/runtime/06-session-owner-runtime-replacement-plan.md) 与 `src/cli/main.ts`。

## 核心模块

| 模块 | 拥有 | 权威参考 |
|---|---|---|
| `src/runtime/agent-loop.ts` | `runAgentLoop` 双层循环(outer turn / inner assistant stream)、reasoning、steering/follow-up 队列、工具三段式执行 | `src/runtime/agent-loop.ts` 头部注释 |
| `src/runtime/agent.ts` | `Agent` 有状态包装:subscribe/on/prompt/steer/followUp/interrupt/waitForIdle,同一时刻仅一个活跃 run | — |
| `src/runtime/ledger/` | append-only 账本:memory-ledger / jsonl-ledger / sqlite-ledger、lockfile(proper-lockfile)、high-water mark;`LedgerEntry` 经 `sessionId` 关联 | — |
| `src/runtime/session-owner/` | owner-fenced 会话状态、fence、schemas | `runtime/06` 计划、`src/runtime/contracts/` |
| `src/runtime/session-runtime/` | SessionRuntime:authority replay + checkpoint cache、RecoveryBarrier、attempt/receipt 生命周期、heartbeat、self-stop;crash takeover 无条件先入 RECOVERY_REQUIRED | `src/runtime/session-runtime/session-runtime.ts` 头部注释 |
| `src/runtime/session-server/` | RuntimeServer TCP facade、protocol、subscription、driver、owner-probe;所有 `session.*` 操作走同一 facade | — |
| `src/runtime/process/` | managed process/PTY:state-machine、wait-coordinator、completion-reconciler、execution-decision、output-artifact | — |
| `src/runtime/context/` | context-engine、model-request-adapter、memory、compaction、token-estimator、projection | — |
| `src/runtime/trace/` | Event Store(hash-chain)+ Artifact Store(SHA-256 CAS)+ Trace Tree projection + mode-aware recorder | `development-doc/runtime/trace/README.md` |
| `src/runtime/contracts/` | Governed Runtime 唯一审核公共面:`public.ts` 只导出纯 DTO/schema/guard/catalog/ports | `src/runtime/contracts/public.ts` |
| `src/runtime/protocol/` | ids、foundation、events、schemas、workspace、capability、canonical-json、当前 canonical protocol | — |
| `src/runtime/agents/` | 有界子 agent 委托:supervisor、child-runtime、graph-store/graph-projection/graph-events、capability-subset(只读治理) | `development-doc/runtime/08-bounded-multi-agent-system-plan.md` |
| `src/runtime/tasks/` | Task 快照/状态/优先级,以 ledger `custom` entry 持久化(`kind: "task"`) | — |
| `src/runtime/tools/` + `src/runtime/tool-registry.ts` | stdlib 工具集与多命名空间注册表;`createStdlibTools(cwd)` 一站式返回 `ToolRegistry`,namespace="stdlib" | — |
| `src/security/` | session-scoped Security/ExecutionGateway 组合、permission engine/approval、bash-ast 分类、sandbox、network/filesystem policy | `src/security/session-composition.ts` 头部注释 |
| `src/storage/` | settings-manager、session-store(SQLite)、runledger-home、session-codec、migration、trace 落盘 | `development-doc/storage-cli/02-user-home-migration-handoff.md` |
| `src/workspace/` + `src/worktree/` | 平台适配(parse/compare/containment/locator、git porcelain、process capability、resume、capability 证据矩阵)+ WorktreeManager/HostWorkspaceBindingService | `development-doc/worktree-sandbox-permisson/01-multiplatform-workspace-path-adaptation-plan.md` |
| `src/extensions/` | skills/plugins/mcp/hooks/capabilities 的 discovery、manager、snapshot、state-store、turn-lifecycle | `development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md` |
| `src/tui/` | OpenTUI 命令式组件树:interactive-mode、components、presentation、commands、application、adapters;事件 → 组件 mutation → requestRender | `development-doc/tui/00-overview.md`、`17-opentui-refactor-plan.md` |
| `src/lsp/` | LspClient、config 自动探测、stdio JSON-RPC transport、AgentTool、WorkspaceEdit、managed LinterClient | `development-doc/plan/04-lsp-server-adaptation-plan.md` |
| `src/api/` | 30+ provider 适配实现(anthropic-messages / openai-responses / openai-codex / google-* / mistral / bedrock / cloudflare / openrouter / azure 等),含 lazy 变体 | — |
| `src/auth/` | 凭据类型、CredentialStore OAuth 流(pkce / device-code / oauth-page / 各 provider) | — |
| `src/providers/` | builtin provider 注册;模型 catalog 由 `scripts/generate-models.ts` + `scripts/ported-provider-catalog.ts` 生成 | `development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md` |

## 运行时分层

### 主循环(agent-loop)

`runAgentLoop` 是领域执行的核心。伪代码(来自 `src/runtime/agent-loop.ts` 头部):

```text
emit agent_start
把 prompts 作为 user 消息入 context
loop:
  emit turn_start
  llm_messages = config.convertToLlm(context.messages)
  stream = streamFn(model, { systemPrompt, messages, tools }, { apiKey, env, signal })
  for ev of stream:
    首次 start → emit message_start("assistant")
    text_delta / toolcall_* → 累积 content + emit message_update
    done → 取 stopReason / usage
    error → stopReason = "error"
  把助理消息 push 到 context
  取出 toolCall 块
  if stopReason === "length": 全部 toolCall 标 isError,不执行
  else: executeToolCalls(parallel | sequential),emit tool_execution_start/end,
        把 toolResult 消息 push 到 context
  emit turn_end
  if prepareNextTurn: apply update(model / tools / systemPrompt)
  if shouldStopAfterTurn: break
  if no toolCall: break
emit agent_end
```

事件协议直接消费 pi-ai `AssistantMessageEvent`(start / text_delta / toolcall_end / done / error)。工具执行三段式对齐 pi:`prepare`(工具路由 + 参数校验 + beforeToolCall hook)→ `execute`(try/catch 兜底 isError)→ `finalize`(afterToolCall hook 字段级浅合并)。

`fire()` 是 emit + ledger 联合写入辅助:`await emit(ev)` 后追加 `LedgerEntry`,再交 trace recorder——审计与展示同源,不出现"只展示未落账"的事件。

### Session Owner Runtime(R7 现行)

一个 `SessionRuntime` 只装配一个 session 的 controller 面(`src/runtime/session-runtime/session-runtime.ts`):

- **权威与恢复**:restore 走 authority replay + checkpoint cache;crash takeover 无条件先进入 `recovery_required`(barrier open),只允许 attach/subscribe/只读 query/recovery decision,副作用在 admission 层被拒。
- **领域执行**:`SessionDomainPort` 由 composition 注入真实 `InteractiveSessionController`(Agent/model/tool/ledger 全在 SessionRuntime 进程内);SessionRuntime 本身只负责 authority/barrier/facade。
- **外部面**:经 `RuntimeServer` TCP facade 暴露,所有 `session.*` 操作走同一 facade;本地连接经 `claimDriver` 分 driver/observer,driver 是 connection-scoped authority。
- **副作用恢复**:生产工具副作用经 `attempt-gateway.ts` 进入 recovery barrier(Write/Bash/WebFetch 各自 beginAttempt/settleAttempt);崩溃留下 unresolved started receipt,takeover 的 assess() 不误判 clean。
- **生命周期**:attachment 计数决定 runtime lifetime——本地 UI detach 后 remote 保活,归零才 pause/checkpoint/release。

legacy `src/runtime/host/` 保留为 R9 删除前的生产回退窗口,标准 CLI 不可达;新行为禁止消费(R0-frozen allowlist,`scripts/check-session-owner-boundaries.ts`)。

### 领域事件与持久化

- 领域事件(AgentEvent)以 owner-fenced durable event 落库并广播,checkpoint replay 可从权威流重建。
- 恢复不迁移 token stream/socket/PTY/MCP client/child handle——这些以 fresh 状态重建。
- session 文件只写 `sessions/YYYY/MM/DD/<session-id>.jsonl`,默认 0600/0700;`session-codec.ts` 是当前 canonical `AgentMessage` 与 runtime config 的无损恢复,不猜测、不转换旧格式。

## 契约与事件

`src/runtime/contracts/public.ts` 是 Governed Runtime 唯一审核公共面:只导出纯 DTO、schema、guard、catalog 与 ports(协议、身份、资源、model-routing、plan mode、context/compaction/memory、session-owner、session-server protocol、legacy host、process)。新跨模块数据必须落在这里的 schema 家族,而不是在模块间传递未审核的私有形状。

协议层(`src/runtime/protocol/`)提供:运行时 ID 体系(`createRuntimeId`/`parseRuntimeId`)、canonical JSON 摘要、事件 schema、workspace/capability 清单、错误 taxonomy。`inventory.ts` 持有可导出能力的盘点。

权威 contract 文档:[`development-doc/runtime/04-governed-agent-harness-runtime-plan.md`](../development-doc/runtime/04-governed-agent-harness-runtime-plan.md)——公共类型/schema、event payload、adapter port、ref/receipt/snapshot/projection、逻辑保存分类与单一用户级布局的当前权威入口。

## 安全与执行

`src/security/session-composition.ts` 为每个 owned session 构造 session-scoped workspace fence(`sessionId + runtimeId + generation`):

- **最终叶**:文件、网络与进程最终叶均由 policy-aware port 提供(`createLocalFileSystemBroker` / `createLocalNetworkBroker` / `createLocalSessionProcessLeaf` / toolchain probe);限制性 sandbox 只执行已校验的 launch plan,不回退执行原始 shell command。
- **网关**:`ExecutionGateway` 统一放行/拒绝,生产工具副作用经 attempt-gateway 进入 recovery barrier。
- **授权**:`PermissionEngine` + `ApprovalCoordinator` + `BashSecurityAnalyzer`(tree-sitter Bash AST 安全分类)+ `MemoryPermissionGrantStore`;`GovernedToolAuthorizationPolicy` 把工具调用收进同一策略面。
- **配置分层**:SecurityConfigSource 分层加载,CLI 旗标是最高优先级层;`cliSecurityOverride` 无旗标时为 undefined,其余层(layout/settings/workspace)按序合并。
- **子 agent**:child 只从 Session Owner production composition 派生治理后的只读能力(read/grep/find/glob/ls),模型 schema 不出现 authority/provider/model,最终叶仍由 Security/ExecutionGateway fail closed。

## 存储布局

单一用户级 home 由 `RunledgerLayout` 定义(`src/runtime/contracts/storage-layout.ts`):

```text
RUNLEDGER_DIR(须为既有绝对目录)或 ~/.runledger/
├── settings.json            # canonical user settings;recording mode / failurePolicy 等
├── auth.json                # 凭据,proper-lockfile 加锁,mode 0600
├── AGENTS.md                # 全局 systemPrompt 拼接
├── state.db                 # SQLite:SessionStore catalog + OwnerStore
├── sessions/YYYY/MM/DD/     # session JSONL(mode 0600)
├── projects/<workspace-key>/settings.json   # 受校验的 workspace settings
├── worktrees/               # 会话 worktree 托管根
├── events/YYYY/MM/DD/       # Trace Event Store(<traceId>.jsonl)
├── artifacts/sha256/xx/     # SHA-256 CAS Artifact Store
└── artifact-metadata/       # Artifact metadata(sha256/…)
```

- settings 的 `sessionDir` 不会被保存;`RUNLEDGER_SESSION_DIR` 与 `--session-dir` fail closed。
- 旧项目级 `.runledger/`、`~/.runledger/agent/` 与根外 session 只可作为显式 `runledger migrate --source <path> --confirm-delete` 的 source;迁移先固定 digest source deletion manifest,目标 verify 后逐项删除;不提供只读 import、dry-run、fallback 或物理 rollback。
- `trace` 的 recording 权威只在用户级 settings:`mode=off|events|events_and_artifacts`、`failurePolicy=best_effort|fail_closed`,默认 `off + best_effort`;workspace/CLI flag/环境变量不拥有 recording authority。

## 扩展点

- **工具**:`ToolRegistry` 多命名空间注册(register/unregister/has/get/toContext),`findConflict` 静态检测同名冲突;`createStdlibTools(cwd)` 组装 stdlib 命名空间;`AgentTool` 接口承载 schema 与 execute。
- **扩展宿主**:`src/extensions/` 提供 skills/plugins/mcp/hooks/capabilities 的 discovery、快照与 turn-lifecycle 接线;MCP/Hook/Skill/Plugin 的目标生命周期由 SessionRuntime-owned managed process 承担(见 [`development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md`](../development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md))。
- **模型 provider**:注册 `src/providers/`,凭据走 `src/auth/`,适配实现放 `src/api/`;catalog 由生成器产出,不手写。
- **平台能力**:workspace/worktree 的跨平台分支唯一收敛在 `src/workspace/{factory,runtime-platform}.ts`,业务模块禁止新增 `process.platform`(静态边界:`scripts/check-platform-boundaries.ts`)。
- **语言服务**:`src/lsp/` 提供 defaults/config 自动探测、stdio JSON-RPC 与 `AgentTool` 包装,经 `lsp-composition` 进入 SessionRuntime。

## 新行为放哪里

| 目标 | 机制 |
|---|---|
| 新增模型 provider | 注册 `src/providers/`,适配实现放 `src/api/`,catalog 走生成器 |
| 新增工具 | 实现 `AgentTool` 并注册到 `ToolRegistry`(stdlib 或扩展命名空间) |
| 新增扩展能力 | 走 `src/extensions/` 的 skills/plugins/mcp/hooks/capabilities 宿主 |
| 跨平台路径/Git/进程行为 | 走 `src/workspace/` 适配层,分支点限 `factory.ts`/`runtime-platform.ts` |
| 会话生命周期/权威/恢复 | 扩展 SessionRuntime/SessionOwner 面,遵守 checkpoint 与 barrier 契约 |
| 工具副作用与恢复 | 经 `attempt-gateway` beginAttempt/settleAttempt,接 recovery barrier |
| 新跨模块数据结构 | 落 `src/runtime/contracts/` schema 家族,经 `public.ts` 审核出口 |
| 安全策略 | 接 `src/security/` 的 ExecutionGateway/PermissionEngine/policy-aware leaf |
| TUI 展示 | 在 `src/tui/` 组件树内消费领域事件;展示与审计同源(ledger + trace) |
| 持久化新事实 | 扩展 session 事件/ledger entry;model-visible 输入必须可从日志重建 |

## 参考

- [`development-doc/00-index.md`](../development-doc/00-index.md)——所有开发模块的计划、设计输入与当前事实入口导航。
- [`development-doc/runtime/04-governed-agent-harness-runtime-plan.md`](../development-doc/runtime/04-governed-agent-harness-runtime-plan.md)——运行时契约权威。
- [`development-doc/tui/00-overview.md`](../development-doc/tui/00-overview.md)——TUI 架构与组件规范导航。
- [`pi-architecture.md`](pi-architecture.md)——pi 项目三层架构参考(API OAuth → Provider → Agent Core),RunLedger 移植与复活的来源对照。
- [`AGENTS.md`](../AGENTS.md)——开发规则:范围、代码风格、工作流、门禁。
