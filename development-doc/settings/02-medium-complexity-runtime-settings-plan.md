# Settings 补全计划 02：中难度——已有 Runtime 的参数化

> 状态：partial（candidate effective snapshot 已进入 Session/Host/TUI 组合，retry/compaction/tool/provider/memory 有部分 consumer 与 focused tests；M slices 尚未整体验收）
>
> 本计划依赖计划 01 的 schema、effective resolver、统一 config write path 和测试 fixture。目标不是增加 oh-my-pi 的全部功能，而是让 RunLedger 已经存在的 compaction、memory、tool、provider、workspace/session 能力真正消费 settings。差距来源为 `notez/00-settings-gap-vs-oh-my-pi.md` 正文第 1–5、9 节。

## 1. 中难度判定

这些项目的能力在 RunLedger 中已经有代码或 contract，但当前参数仍硬编码、只在 CLI 传递、只在某一个 transport 生效，或需要 Host/Session/Tool/Provider 多个模块共同读取。因此不能只扩展 `ProjectSettings`，也不能只写 settings-manager 单测。

本计划不做：

- 需要新增外部服务、跨进程 worker、协作协议、远程 memory、browser/speech 等高难度能力；
- 附录 A 的模型/采样/思考/提示词/loop guard 核实项；
- 用 settings 绕过 Security/ExecutionGateway、Approval、Workspace containment 或 Session Owner authority。

## 2. oh-my-pi 对应实现链

| 能力 | oh-my-pi 的实际实现 | RunLedger 必须对应的实现形态 |
|---|---|---|
| retry 基础参数 | `config/settings-schema.ts` 定义 `retry.*`；`session/session-maintenance.ts` 用 `settings.getGroup("retry")` 计算 retry count/backoff；`session/settings-stream-fn.ts` 把 `retry.maxDelayMs` 作为 request option；`retry-fallback-chains.ts` 独立解析链 | 建立 `RetryPolicy` effective group，经 Host/Session 注入到每个支持的 provider request；wire adapter 不再各自读取 raw settings |
| compaction 基础参数 | schema 定义 `compaction.*`；`session/session-maintenance.ts` 在 threshold、overflow、manual、mid-turn 等路径重复读取同一 group；`snapcompact.shape` 单独交给 snapcompact resolver | `ContextEngine`/`CompactionService` 接受同一份 policy；manual/auto/overflow 不能各有一套默认值；原始 ledger/event 不被设置化 compaction 删除 |
| local memory backend | schema 的 `memory.backend`；`session/session-memory.ts` 解析后端；`tools/memory-recall.ts`、`memory-retain.ts`、`memory-reflect.ts`、`tools/index.ts` 按 backend gate 工具和 context 注入 | 只先接 `off|local` 到已有 `runtime/context/memory`；backend resolver 必须返回 capability/diagnostic，未知后端不 optimistic allow |
| 工具配置 | `tools/index.ts` 用设置决定工具是否出现在 model context；`tools/read.ts`、`write.ts`、`grep.ts`、`bash.ts`、`lsp/tool.ts` 读取各自 settings；`output-meta.ts` 集中处理 artifact spill/tail/head/column limits | 每个 RunLedger tool 读取 `ToolPolicy`，但最终 leaf 仍进 ExecutionGateway；输出上限、截断和 artifact ref 必须经过统一 overflow policy |
| task/async/IRC | `tools/hub/jobs.ts` 读取 `async.pollWaitDuration`；`tools/hub/messaging.ts` 读取 `task.maxRecursionDepth` 与 `irc.timeoutMs`；`eval/concurrency-bridge.ts` 读取 `task.maxConcurrency` | bounded multi-agent/task settings 进入现有 `src/runtime/agents` policy；异步 job/owner fence/timeout 使用同一 effective snapshot，不在 TUI 保存 mutable authority |
| provider settings | `settings-stream-fn.ts` 每次 request 读取 routing/timeout/in-flight；`config/provider-globals.ts` 读取 search/image order；`settings.ts` hook 调用 `configureProviderMaxInFlightRequests()` | 创建 RunLedger `createSettingsAwareStreamFn` 等价 seam；provider semaphore 与已证明支持的 retry/transport option 由 provider/model composition 消费，image order 需等待图片生成选择 consumer |
| workspace/session | `session/agent-session.ts` 读取 `workspace.additionalDirectories`、plan/goal/title/tasks 等；`modes/interactive-mode.ts` 读取 startup plan、goal、status/TUI settings | workspace/plan/goal/title 由 Session/Host snapshot 驱动；TUI 只发 command/query，不拥有状态事实源 |

这张表是本计划的实现对应关系：每个 gap group 都必须在 RunLedger 找到一个真实 consumer；只增加与 oh-my-pi 同名字段、但没有等价 consumer 的改动应被拒绝。

## 3. 键分组与目标范围

### M1：Retry 基础策略

纳入：

- `retry.maxRetries`；
- `retry.baseDelayMs`；
- `retry.maxDelayMs`。

当前 RunLedger 的 wire 层已经有 transport-specific retry 或 `maxRetries ?? 0`，但缺少统一 settings authority。目标是统一“是否重试、最多几次、指数退避 base/max、Retry-After 上限”的语义，同时保留每个 transport 的错误分类。

当前 candidate 的 transport 矩阵仍是 partial：`openai-completions`、`openai-responses`、`azure-openai-responses` 与 `anthropic-messages` 只证明 SDK `maxRetries`；`openai-codex-responses` 另有自有的 `maxRetries`、base delay 与 max delay；Google Generative AI、Google Vertex、Bedrock Converse 与 Mistral 没有等价的 request retry option，不能把 settings projection 当成已生效。title/summarizer 的直接 `Models.completeSimple` 也不在 Session stream seam 内。

不在 M1 假设实现 `retry.modelFallback`、usage-aware fallback 或 fallback chain；它们依赖高难度的 model/credential policy，放计划 03。

### M2：Compaction 基础策略

纳入：

- `compaction.enabled`、`compaction.midTurnEnabled`；
- `compaction.strategy` 的 RunLedger 已支持子集；
- `compaction.thresholdPercent`、`thresholdTokens`；
- 已有 checkpoint/summarizer 能力对应的阈值与保留预算，只在当前 service 能证明与正文缺口语义等价时加入。

`idleEnabled`、remote/handoff、`supersedeReads`、`dropUseless`、`snapcompact.*`、`loop.mode` 不在本阶段硬塞进现有 engine；若当前 capability audit 不能证明等价，则转计划 03 的 deferred/high slice。

### M3：已有 memory 与工具

纳入：

- `memory.backend` 的 `off|local` 选择；
- 已有本地 memory 能力需要的 `memories.enabled` 等总闸（只在 RunLedger 已有对应 lifecycle 时实现；否则标记 deferred）；
- `tools.approval`、`tools.approvalMode` 到 RunLedger approval enum 的显式映射；
- `tools.artifactSpillThreshold`、`artifactTailBytes`、`artifactHeadBytes`、`artifactTailLines`、`outputMaxColumns`；
- 已有 `read.defaultLimit`、`read.renderMarkdown`、`read.summarize.*`、`read.toolResultPreview`、`edit.*`、`grep.*`、`glob.enabled`、`astGrep.enabled`、`astEdit.enabled`、`bash.*`、`bashInterceptor.*`、`lsp.*`、`todo.*`、`async.*` 的可验证子集；
- 已有 bounded task 的 `task.maxConcurrency`、`maxRecursionDepth`、`maxRuntimeMs`、`agentIdleTtlMs`、`softRequestBudget`、`maxEffort`、`disabledAgents` 等 policy 字段；
- `irc.timeoutMs`，仅在现有 agent communication path 已经消费它时实现。

`tools.format`、shell minimizer、eval runtime、computer/browser/security/ask 等需要能力本体或独立安全审计的项转计划 03。

### M4：已有 Provider/服务设置

纳入：

- `disabledProviders`；
- `providers.maxInFlightRequests`；
- 已存在 wire/registry 能力可以真实消费的 provider protocol/timeout 开关，例如 `providers.openaiWebsockets`、`openrouterVariant`、`kimiApiFormat`、`streamFirstEventTimeoutSeconds`、`streamIdleTimeoutSeconds`、`providers.fireworksTier`。

`providers.imageOrder` 暂缓：当前 RunLedger 没有图片生成的模型选择/请求 consumer。它不能借用 chat 模型的 image-input 能力排序，否则会改变普通 chat 的默认选择并把 provider order 误当成输入模态偏好。

每个 protocol setting 必须先核对 RunLedger 当前 adapter 是否有同等 option。只有 schema 没有 wire consumer 的键不在 M4 标为 completed。

### M5：Workspace/Session/Project 设置

纳入：

- `workspace.additionalDirectories`：接到当前 workspace containment/identity，不允许模型输入任意绝对路径直接成为 root；
- `plan.enabled`、`plan.defaultOnStartup`：复用现有 plan reducer/composition；
- Goal、replan title 和 Todo delay 暂不纳入 schema：现有 passive event/projection 不足以提供完整 production consumer，转 deferred；
- `branchSummary.enabled` 仅在已有 branch summary consumer 先落地后接 settings。

`commit.mapReduce*` 如果当前没有 commit tool/worker 的等价能力，不在 M5 添加空 settings；转计划 03。

### Candidate wiring boundary（2026-08-22）

当前 candidate 已有以下跨模块接线，但仍按 slice 保持 `partial`：

- `SettingsResolver.effectiveRuntimeSnapshot()` 统一生成 digest、source layer、diagnostic 和 immutable `retry`/`compaction`/`toolPolicy`/`providerPolicy`/`sessionPolicy`；CLI composition 将同一 snapshot 注入 Session/Host、InteractiveSessionController 和 TUI。
- retry policy 已经通过 `src/runtime/retry/**` 与 `src/api/simple-options.ts` 的 seam 传入支持的 request/child runtime 路径；caller options 优先，focused tests 覆盖 policy、stream 和 provider option。
- compaction policy 已进入 cut planner、agent loop、Host model/context domain；manual/overflow/threshold 的 policy projection 与 checkpoint/raw event 保留有 focused/组合测试。
- tool output/approval、local memory backend 和 provider disabled/filter/in-flight projection 已进入 production tool/controller/provider composition；`providers.imageOrder` 保持 deferred，最终 Security/ExecutionGateway leaf 不由 settings 放宽。

仍未闭合的边界包括完整 provider/transport 矩阵、task policy 的完整生产语义、Plan 的整体 production/human acceptance、Goal/title/Todo deferred slice、所有 Runtime group 的统一热刷新语义，以及需要新能力的 fallback/remote memory/idle/loop slices。`SettingsRuntimeStore` 已提供受 apply mode 约束的 reload/subscription boundary，但不能把它写成任意中途替换或跨 Session durable reload。不要把这些 candidate projection 或 `verified:false` 诊断写成 implemented。

## 4. RunLedger 目标架构与实施步骤

### M0：有效配置快照接入 Runtime

1. 在计划 01 的 resolver 上增加 group typed snapshot：`retry`、`compaction`、`toolPolicy`、`providerPolicy`、`workspacePolicy`、`sessionPolicy`。
2. 在 composition root 生成 snapshot，并把其 digest、source layer 和 diagnostic 绑定到 session/Host runtime config；consumer 不重复读取 user/workspace 文件。
3. 支持 per-turn immutable snapshot：当前 turn 使用的 settings 在请求中途不被 TUI set 改写；下一 turn 或明确 command 才重新解析。
4. 对每个 group 输出 `configured/defaulted/invalid/unsupported` 诊断，未知 capability fail closed，但普通非安全显示项可安全回退默认。

### M1：Retry policy 与 settings-aware stream seam

1. 把 `retry.maxRetries/baseDelayMs/maxDelayMs/enabled` 解析成有限范围的 `RetryPolicy`，并扩展现有 `src/api/simple-options.ts`/transport option seam，而不是让每个 API 文件读取 settings。
2. 在所有支持 retry 的 transport 上复用同一 delay/error classification contract；对未支持的 transport 明确 `unsupported`，不能默默宣称全 provider 等价。
3. 实现 `createSettingsAwareStreamFn` 等价的 RunLedger adapter：caller-provided request options 优先，settings 只填空值；把 retry policy、provider timeout、in-flight limit 一次传入。
4. 把 `Retry-After` 与 configured max delay 的关系写入测试：超过上限 fail fast 或进入已有 fallback/error path，不让用户线程无限 sleep。

### M2：Compaction policy 接入 ContextEngine

1. 将 `src/runtime/context/compaction/cut-planner.ts`、`checkpoint-store.ts`、`context-engine.ts` 的阈值、保留预算、mid-turn 开关改为显式 policy 输入。
2. 所有触发器（overflow、threshold、manual/command、model switch）调用同一 `CompactionService`/planner；不要在 `agent-loop.ts` 和 TUI 各自推断阈值。
3. 保留当前 invariant digest、checkpoint lifecycle、raw event/ledger；设置只改变 projection policy，不删除或覆盖 canonical history。
4. `strategy=off`、invalid threshold、超范围预算和 summarizer failure 都必须有 deterministic fail-closed/keep-live-context 行为。

### M3：Tool/Memory policy 接入

1. 建立 `ToolPolicySnapshot`，把 tool visibility、output budget、approval mode、timeout、LSP write diagnostics、todo/task gate 统一传给 `runtime/tools`。
2. 把 `tools.approvalMode` 的 oh-my-pi 枚举（always-ask/write/yolo 等）显式映射到 RunLedger `on-request/never/untrusted/granular`；不做同名字符串直接 cast。
3. artifact spill/head/tail/column 只影响输出投影；完整正文进入现有 Artifact/CAS 规则时要保留 digest/size/ref，不能通过“关闭 spill”绕过上限。
4. `memory.backend=local` 只激活当前已有 local store/projection；backend=off 时不把 memory tools 放入 model context，也不删除 canonical records。
5. Task/async policy 只收窄已有 bounded runtime；最大并发、递归深度、运行时长和 idle TTL 经过 Session Owner/ExecutionGateway，不能成为模型自行设置的字段。

### M4：Provider/Workspace/Session 接线

1. 在 `src/models.ts`/provider composition 建立 provider semaphore 和 `disabledProviders` filter；过滤发生在 provider catalog/model selection，不在 UI 视觉层隐藏即可。
2. `providers.imageOrder` 等待图片生成选择链；protocol/timeout setting 才通过 provider registry/stream adapter 消费。无 capability 的 provider 返回结构化 unsupported，不回退到另一个未授权 provider。
3. `workspace.additionalDirectories` 先经 `src/workspace` path adapter 做 canonical containment/identity，再进入 prompt/tool workspace roots；不把 raw path 放到 public DTO。
4. `plan.enabled`/`plan.defaultOnStartup` 由 Host/Session snapshot 驱动；TUI 只展示 projection。`defaultOnStartup` 只决定无 Plan snapshot 的首次 activation，不篡改已有 durable plan state。Goal/title/Todo settings 等待对应 capability 完整后再重新进入 schema 设计。

## 5. oh-my-pi consumer 到 RunLedger 文件的追踪表

| RunLedger slice | oh-my-pi 参照 consumer | RunLedger 预计修改边界 |
|---|---|---|
| retry | `src/session/session-maintenance.ts`、`retry-fallback-chains.ts`、`settings-stream-fn.ts` | `src/runtime` retry policy、`src/api/simple-options.ts`、各 transport adapter、相关 tests；不在 TUI 组件中计算 backoff |
| compaction | `src/session/session-maintenance.ts`、`src/session/agent-session.ts`、`src/session/compact-modes.ts` | `src/runtime/context/**`、agent/session adapter、checkpoint/compaction tests；不改 raw session format |
| memory | `src/session/session-memory.ts`、`src/tools/memory-*.ts`、`src/tools/index.ts` | `src/runtime/context/memory/**`、memory composition、tool visibility/diagnostic；外部 backend 另见计划 03 |
| output/tools | `src/tools/output-meta.ts`、`read.ts`、`write.ts`、`grep.ts`、`bash.ts`、`lsp/tool.ts`、`tools/index.ts` | `src/runtime/tools/**`、`src/runtime/process/output*.ts`、`src/security/**`、LSP adapter；保留 ExecutionGateway final leaf |
| task/async | `src/tools/hub/jobs.ts`、`src/tools/hub/messaging.ts`、`src/eval/concurrency-bridge.ts` | `src/runtime/agents/**`、process/job owner/fence、task tools；只扩展已有 M1 bounded delegation |
| provider | `src/config/provider-globals.ts`、`src/session/settings-stream-fn.ts`、`src/config/settings.ts` hooks | `src/models.ts`、`src/models-store.ts`、`src/api/**` options seam、provider registry；不复制 oh-my-pi catalog 代码 |
| workspace/session | `src/session/agent-session.ts`、`src/modes/interactive-mode.ts`、`src/config/model-roles.ts`（仅作为 consumer 结构参考） | `src/runtime/host/**`、`src/runtime/session-owner/**`、`src/workspace/**`、现有 plan/goal/title/todo modules；不能恢复 client-local authority |

## 6. 测试与验收

### Focused tests

- `tests/storage/settings-manager.test.ts` / 新 resolver tests：group defaults、range、layer precedence、immutable snapshot、invalid diagnostic。
- `tests/runtime/context/compaction/**`：threshold/overflow/mid-turn/manual 共用 policy，checkpoint invariant 和 raw event 保留。
- `tests/runtime/retry/**` 或对应 API tests：retry count、指数退避、Retry-After、max delay、caller option precedence、transport unsupported。
- `tests/runtime/tools/**`、`tests/security/**`、`tests/lsp/**`：tool gate、output spill、approval mapping、LSP write diagnostics、ExecutionGateway 不被 settings bypass。
- `tests/providers/**` / `tests/api/**`：disabled provider、provider semaphore、timeout/protocol option；图片生成选择链建立后再覆盖 image order。
- `tests/runtime/agents/**`、`tests/tui/**`：task limits、workspace additional roots、Plan projection 和 Host/client authority；Goal/title/Todo 保持 deferred，不以 passive DTO 测试替代 consumer 证据。

### Gate

1. 每个 M slice 先通过 focused RED→GREEN，再合并到完整 `npm run check`、`npm test`、`npm run build`。
2. 运行一次真实 production composition：隔离 `RUNLEDGER_DIR`、编译 `dist`、session create/open/continue、settings override、provider request/mock wire、tool deny/approval 和 compaction recovery。
3. 需要 TTY 的 TUI setting 通过标准链接 provenance、真实 tmux/TTY 和指定宽度验证；source import 或 isolated unit-only 不算。
4. 每个 provider/transport 记录“支持 settings / 明确 unsupported / 尚未接线”矩阵；不得用全局通过替代逐 transport 证据。
5. `git diff --check` 和 scoped diff review 通过，保留不相关 dirty worktree。

### Historical candidate validation（2026-08-22；已由当前 fresh validation 取代）

- 早先 candidate run 记录了 `git diff --check`、`npm run check`、`npm run build` 与 `npm test` 通过；Vitest 456 files / 2827 passed / 3 skipped，Bun OpenTUI 128 passed / 1027 assertions。该数字是历史 candidate 证据，不是当前全量验收结论。
- 当前 fresh validation 以 [`README.md`](README.md) 与 [`04-settings-acceptance-matrix.md`](04-settings-acceptance-matrix.md) 为准：same-version Host executable-digest acceptance 在本轮全量 `npm test` 中通过；标准 PATH TTY/人工视觉验收仍单独 pending。
- 全局 `runledger` 链接确认指向当前 worktree；隔离 `RUNLEDGER_DIR` 下用当前编译产物验证 settings `set/get/reset`、`workspace capability` 与标准 PATH `runledger --version`，均通过。受控 POSIX `node-pty` Ctrl+D clean exit。tmux `send-keys C-d` 在本轮未观察到 clean exit，未作为通过证据。
- 这些是 candidate 的仓库级和 composition smoke 证据，不提升 M1–M5 的未完成项；每个 provider、workspace/security root、task/plan/goal/title 和动态 reload slice 仍需自己的组合门禁。

## 7. 交接到计划 03

只有当 M1–M5 已有真实 consumer、effective snapshot 和组合测试后，才可进入高难度计划。计划 03 依赖的接口包括：

- `RetryPolicy` 可扩展 fallback decision，但不隐含 provider/model authority；
- `CompactionPolicy` 可增加 idle/remote strategy，但不改变 raw event truth；
- `MemoryBackendResolver` 可报告 unsupported backend；
- `ToolPolicySnapshot` 与 ExecutionGateway/Approval 已分离；
- `ProviderPolicy` 有并发、超时、disabled filter 的确定性边界；
- Host/Session settings digest 可参与 replay/recovery diagnostics。
