# RunLedger Worktree、Sandbox 与 Permission 架构实施计划

> 文档属性：本主题唯一权威计划与执行状态账本。
>
> 状态：独占行为切片已实现；ExecutionGateway 到 Host/生产工具的接线与真实 enforced E2E 仍未完成，领域状态仍只按本文件证据更新。
>
> 建立日期：2026-07-21；Runtime Host 适配校准：2026-08-04。
>
> 目标目录沿用需求中的 worktree-sandbox-permisson 拼写；代码、类型和正文统一使用 permission。
>
>
> 本文同时记录当前独占行为实现证据；Host/CLI/TUI/ExecutionGateway 生产接线仍按后续阶段执行，不因本地 adapter 测试而提前宣称生产隔离。
>
> Runtime 公共契约来源：[`../runtime/00-reference.md`](../runtime/00-reference.md) 与 [`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)。
>
> 生产 Host/managed process 行为来源：[`../runtime/05-multi-client-background-terminal-refactor-plan.md`](../runtime/05-multi-client-background-terminal-refactor-plan.md)。

## 0. 参考基线与结论边界

本计划基于以下本地 checkout 的当前源码，而不是仅参考产品文档：

### 0.0.1 2026-08-04 当前实现切片证据

以下为当前分支已提交独占目录切片的局部证据；复选框约定：`[x]` 表示当前切片有直接实现与测试，`[~]` 表示部分实现或仍缺生产接线，`[ ]` 表示尚未实现；不把 deterministic launch plan 当作真实 OS enforcement：

- Permission/Approval/config/path 线已有 `src/security/{config,permission,integration,policy-filesystem}.ts` 与对应测试，覆盖 exact config、`deny > ask > allow`、approval、shell analyzer、canonical path boundary 和 runtime authorization adapter。
- 新增 `src/security/execution-gateway.ts`、`policy-network.ts` 与 `integration/runtime-gateway-adapter.ts`：在授权、approval receipt、workspace/policy/constraint digest 和 sandbox final-leaf 条件全部通过后才暴露受限 fs/network port；缺失或过期决策 fail closed，仍不拥有 process 生命周期。
- Worktree 线已有 `src/worktree/{git-operations,paths,manager,registry,lease,ports}.ts`：受控 Git args、managed-root containment、append-only replay、JSONL canonical store、proper-lockfile、lease revision/fencing、create/list/remove 约束；security/worktree 定向为 18 files / 88 tests。
- Sandbox 线新增 `src/security/sandbox/`：Linux bwrap、macOS Seatbelt、Windows/unknown unavailable factory、policy resolver、denial classifier、capability probe、deterministic launch plan 与 final-leaf request/plan digest receipt；对应 sandbox 测试为 4 files / 10 tests。该线不 spawn、不保存 PID/PTY/output/recovery，也未声称生产 enforcement。
- 阶段提交证据：`dde60ac`（`feat(workspace-security): bind execution to verified constraints`），只包含 `src/security/**`、`src/worktree/**` 与对应测试路径；提交前 `git diff --cached --check` 通过。
- 本地验证证据：`npm run check`、`npm test`（Vitest 144 files / 746 tests，Bun TUI 5 files / 44 assertions）、`npm run build`、`git diff --check` 均通过；该提交已落在当前分支，尚未 push。

仍未实现或未接线：ExecutionGateway 到生产工具的唯一执行面接线、所有 builtin tools 迁移、Host final-leaf/process facade 的真实调用、真实 Linux/macOS enforced E2E、CLI/TUI/approval reverse request、resume/worktree Runtime adapter、durable security/workspace events、persistent grants/GC/apply 与企业/远程能力。故不得把当前切片标为 M0–M6 或专项完成。

| 项目 | 基线 | 本计划主要读取的实现 |
|---|---|---|
| Codex | 0b175e6439a8608ba7726ee153fd8590619e8f34，2026-07-21 | codex-rs/protocol/src/permissions.rs、protocol.rs、approvals.rs；codex-rs/core/src/config/permissions.rs、resolved_permission_profile.rs；codex-rs/core/src/tools/approvals.rs、sandboxing.rs、orchestrator.rs；codex-rs/sandboxing/src/manager.rs、spawn.rs、denial.rs |
| grok-build | c68e39f60462f28d9be5e683d9cbe2c57b1a5027，2026-07-16 | xai-grok-workspace/src/worktree、permission；xai-fast-worktree；xai-grok-sandbox；xai-grok-shell/src/session/worktree.rs、worktree_pool.rs；pager user guide 18/22 |
| RunLedger | 1658fe26fc675cc18498bb8c6a9f162b7a0b733f，2026-07-21 | src/runtime/execution-env.ts、tool-authorization.ts、agent-loop.ts、tool-context.ts、interactive-session-controller.ts、tools；src/storage；src/cli；runtime/ledger |

参考仓库不是待复制的模板。RunLedger 是 Node.js/TypeScript 单包，第一版不移植 Rust crate 拆分、Btrfs/overlay 快照、worktree pool、Landlock/Windows restricted token 全套实现，也不引入 LLM 权限分类器。计划提取的是安全边界、状态机、协议和测试方法。

RunLedger Runtime 新增文档的使用方式固定如下：

- `runtime/00-reference.md` 是治理目标、术语和上游证据输入，不直接分配实现文件。
- `runtime/04-governed-agent-harness-runtime-plan.md` 独占 Runtime 公共 ID、envelope/ref/receipt、event payload schema、projection 与 adapter port。
- `runtime/05-multi-client-background-terminal-refactor-plan.md` 独占 production Host、client/driver/observer、durable command/subscription、managed process、pipe/PTY、private output 与 shutdown/recovery 行为。
- 本计划消费上述契约并独占具体行为；发现契约缺口时先回到 Runtime 计划提交 exact schema/fixture，再继续实现，不在 `src/security/**` 或 `src/worktree/**` 复制公共类型。

下文“Runtime Workspace/Security 契约域”指 [`04` 的 workspace、capability、approval 与 sandbox contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-workspace-security),“Runtime Control/Telemetry 契约域”指 [`04` 的 control plane、policy、telemetry 与 remote metadata contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-control-telemetry)。

### 0.1 从 Codex 提取的结构

1. Approval policy、filesystem/network permission profile 与 sandbox backend 是不同概念，不能由一个 allowAll 布尔值代替。
2. 权限先解析为稳定、可审计的 runtime profile，再交给工具编排器与 sandbox manager；执行器不应自行猜配置。
3. 文件权限需要 read/write/deny、特殊工作区根、路径规范化、symlink 候选检查和受保护元数据目录。
4. 工具调用需要 exact approval；批准的是规范化后的具体命令、cwd、目标路径与附加权限，而不是模糊的“允许 bash”。
5. Sandbox 是否应该启用、当前平台能否实施、最终采用哪个 backend 是三件不同的事。
6. Sandbox 拒绝必须被识别为结构化失败，不能与普通命令 exit code 混为一谈。
7. Permission profile 可在 session/turn 边界快照，resume 时必须恢复或明确重新解析，不能静默漂移。

### 0.2 从 grok-build 提取的结构

1. Worktree 的纯 Git/文件生命周期放在 workspace 层，session 恢复和 UI 装配留在 shell/session 层。
2. Worktree create 先 prepare，再 claim，同一 session 的并发创建必须幂等；失败或取消要清理半成品与 Git registration。
3. Worktree 默认放在用户状态目录下按 repo slug 分组，而不是递归塞进源仓库。
4. Worktree registry 要保存 source repo、session、label、last accessed、状态等，GC 依赖最后使用时间而非只看创建时间。
5. Permission 以 AccessKind 分类；policy 采用 deny > ask > allow，ask 不能被 auto/yolo 降级。
6. Shell 要按链式片段评估；无法可靠拆解的 command substitution、heredoc、background/control-flow 必须保守升级为 ask。
7. 内建“安全命令”必须有词边界，rg --pre、tee、危险命令和 wrapper 都需要单独处理。
8. Sandbox profile 负责 workspace/read-only/strict/off 等能力组合；deny path 的解析、平台别名、失败关闭和 child network 是独立实现点。

### 0.3 与 Runtime contract 计划的实现边界

本计划是 Worktree/Sandbox/Permission 行为的唯一实现账本。Runtime contract 计划定义“传什么、记什么、如何校验”,本计划定义“如何判断、如何执行、何时发事件、如何 replay 以及如何证明强制生效”。

生产组合中,本计划拥有 Permission/Approval/Workspace/Sandbox/Gateway 的决策、策略、受限 filesystem/network adapter 与 enforcement receipt；`runtime/05` 的 Host/process domain 拥有 session writer、driver fencing、process intent/spawn claim、pipe/PTY backend、output/recovery 和 lifecycle。二者在最终执行叶通过不可变 execution-constraint snapshot/receipt 交接,不得各自实现第二个 process manager、PTY backend、output store 或 client-local controller。

```text
src/runtime/protocol contracts
              ↓
src/security + src/worktree implementations
              ↓ decision/receipt/workspace adapters
Runtime Host resident composition + managed process final leaf
              ↓
authenticated CLI/TUI remote facade
```

权威映射：

| Runtime 公共契约 | 本计划的实现责任 |
|---|---|
| `WorkspaceExecutionEnvelope` | Worktree/session binding 负责填充；Workspace validator 在每次副作用前验证并签发 validation receipt |
| `WorkspaceBindingRef`、`WorkspaceLeaseRef` | WorktreeManager/Registry/Lease 实现创建、CAS、fencing、恢复与外部持久状态 |
| `WorkspaceCheckpointDescriptor` | Workspace 实现采集 Git/worktree 状态并调用 Artifact 接口；rewind/cleanup 返回 terminal receipt |
| `CapabilityRequestRef`、`CapabilityDecision` | Access resolver 与 PermissionEngine 推导请求并执行 `deny > ask > allow` |
| `ApprovalTicket`、`ApprovalReceiptRef` | ApprovalCoordinator/Store 实现 prompt、CAS、expiry、revoke、crash reconciliation |
| `CredentialGrantRef` | Credential Broker 解析真实 store、注入最小短期 secret，并只把脱敏 grant/receipt ref 返回 Runtime |
| `SandboxProfileRef`、`SandboxExecutionReceiptRef` | Sandbox resolver/backend probe、launch-plan prepare、final-leaf validation、denial detection 生成真实 enforcement receipt；实际 process lifecycle 归 Host |
| workspace/permission/sandbox current events | Runtime 拥有 event name/payload schema；本计划拥有 emission timing、intent/commit 顺序和 receipt 真实性 |
| Workspace/Gateway/Approval/Sandbox ports | 本计划提供 adapter 实现；Runtime consumers 只能通过 port 使用，不 import 本计划内部 store/backend |
| Runtime Host command/process constraint handoff | 本计划提供真实限制性 decision/receipt 与 executor adapter；Host 绑定 execution/attempt 并在 final leaf 重校验,本计划不 spawn/reattach/管理 PTY |

Runtime contract 完成不代表隔离已生效；本计划实现完成但尚未接入 Runtime 也不代表生产路径无旁路。只有独占实现、串行接线和联合 E2E 三者均通过后，才能对外声明 workspace isolation、permission approval 或 sandbox enforcement。

## 1. RunLedger 基线与当前差距

### 1.1 2026-07-21 原始可复用基础

- AgentLoopConfig 已有 cwd、executionEnv、beforeToolCall、afterToolCall 和 ledger。
- ToolContext 已携带 ExecutionEnv、sessionId、toolCallId 与 ledger。
- AgentTool 已有 isReadOnly、isDestructive、isConcurrencySafe 元数据。
- InteractiveSessionController 已支持注入 ToolAuthorizationPolicy。
- JsonlLedger、SessionManager、proper-lockfile 与 current replay 已提供审计和恢复底座。
- stdlib 工具、TUI tool state、CLI/session 入口已经可运行。

### 1.2 仍需由本专项关闭的结构性缺口

| 当前状态 | 风险 | 计划落点 |
|---|---|---|
| Runtime Host baseline 已有 builtin-none execution constraint provider,限制性 Permission/Approval/Sandbox/Gateway 尚未由本专项接入 | explicit none 可审计运行,但选择强约束时只能 unsupported | PermissionEngine + ApprovalCoordinator + Sandbox/Gateway adapter；由 Host composition 选择 profile |
| ToolAuthorizationDecision 只有 allow/deny | 无 ask、来源、规则、scope、批准内容和审计证据 | 新增 policy decision 与 final authorization result |
| tool_call 在 schema/permission 之前记账，deny 只变成普通 isError | 无法重建“谁基于什么策略批准/拒绝” | 接入 Runtime `permission.requested/decided` payload 与 attemptId |
| read/write/edit 等工具直接使用 node:fs；WebFetch 直接 fetch | executionEnv/sandbox 可被内置工具绕过 | 全部内置工具改经 ToolContext/ExecutionGateway |
| `runtime/05` 已删除 raw background 并建立 Host-owned managed process/private output baseline | 本专项若再建 `ManagedProcessRegistry` 或 raw spawn 会形成第二执行面 | 只提供 execution constraint decision/receipt 与受限 executor,交 Host process final leaf |
| resolveToCwd 接受任意绝对路径，write/edit 不验证 workspace 边界 | 可直接写工作区外；symlink 可逃逸 | CanonicalPathResolver + FileAccessGuard |
| Host pipe/PTY baseline 支持 builtin-none,restrictive profile 尚无真实 OS enforcement adapter | 软件 allowlist 无法约束任意子进程 | SandboxBackend 生成真实 launch plan/receipt 交 Host final leaf,缺 backend 时 fail closed |
| WebFetch 没有 host permission/network policy | 网络访问不可审批、不可限制 | NetworkAccessRequest + NetworkClient |
| canonical user/workspace settings 已固定到 `runledgerHome` | repo `.runledger/security.json`、旧 agent home 或 client override 若成为 authority 会恢复双根/fail-open | 独立 SecurityConfigLoader 从注入 layout 解析；非法/冲突配置阻止所选安全模式启动 |
| 没有 worktree manager/registry/session binding | cwd、repo、session、sandbox root 无稳定身份 | WorktreeManager + WorktreeRegistry + PersistedWorkspaceBinding，并投影 Runtime refs |
| ledger 没有 sandbox/worktree 事件 | 无法审计隔离边界是否实际生效 | 发射 Runtime workspace/sandbox events、policy digest 与 enforcement receipts |

结论：不能先加几个 CLI flag 就宣称支持 sandbox。第一优先级是提供真实限制性决策/enforcement adapter,接入现有 Host final-leaf barrier,并关闭 filesystem/network/worktree 旁路；不得回退到旧 client/controller 或再造 process backend。

### 1.3 2026-08-04 Runtime Host handoff

- `runtime/05` 的已提交 baseline 已使 Host 成为唯一 session/Agent/process writer,CLI/TUI 是 remote client；本专项 Phase 5 必须接 Host resident composition,不能按旧计划让 CLI 先创建 controller。
- Host process facade 已拥有 durable intent/spawn claim、pipe/PTY、bounded private output、recovery、completion Queue 与 shutdown lifecycle。本专项只提供真实 restrictive Permission/Approval/Sandbox/Gateway/containment decision/receipt 和 executor adapter。
- 五个 execution-constraint 维度允许显式 builtin `none`;这只表示“本维度明确未请求强约束”,不是 sandbox enforced。用户选择 restrictive profile 而 adapter unavailable 时必须在 spawn 前返回 typed unsupported/denied。
- 所有 approval/worktree/security mutation 通过 Host durable command,绑定 principal、Host/session generation、driver revision、expected domain revision 与 request digest；observer 只读,client disconnect 不释放 Host waiter或 writer。
- canonical state、registry、grants、settings 与 staging 只能写入单一 `runledgerHome`;workspace path 是 identity/enforcement root,不是 RunLedger storage root。

## 2. 总体设计

### 2.1 五个概念必须独立

| 概念 | 回答的问题 | 不负责 |
|---|---|---|
| Worktree | 这次 session 在哪份代码副本中工作 | 不决定能读写什么 |
| Permission policy | 某个具体 capability 请求是 allow、ask 还是 deny | 不提供 OS 隔离 |
| Approval policy | 遇到 ask 时能否、如何询问用户 | 不扩大 sandbox 能力 |
| Sandbox | 子进程和直接 IO 在操作系统层实际能访问什么 | 不替用户表达授权 |
| Ledger | 当时解析了什么策略、请求了什么、实际发生了什么 | 不参与隐式放行 |

危险全访问的含义固定为：

- approvalPolicy = never；
- sandbox profile = off；
- 仍执行显式 managed deny、受保护控制面路径检查和审计；
- 必须由 CLI 或安全配置显式选择，不能因为 backend 缺失自动降级得到。

approvalPolicy = never 的含义固定为“不弹窗，原本需要 ask 的请求直接 deny”，绝不等于自动批准。

### 2.2 调用链

~~~mermaid
flowchart TD
    C[Authenticated driver command or resident Agent toolCall] --> V[Schema validate and normalize]
    V --> A[ToolAccessResolver]
    A --> P[PermissionEngine]
    P -->|deny| D[Structured denial]
    P -->|ask| Q[ApprovalCoordinator]
    Q -->|deny/cancel/timeout| D
    Q -->|allow once| G[ExecutionGateway]
    P -->|allow| G
    G --> F[PolicyFileSystem]
    G --> N[PolicyNetworkClient]
    G --> X[Execution constraint snapshot and receipts]
    X --> H[Runtime Host managed process facade]
    H --> B[Platform SandboxBackend at final leaf]
    F --> R[Tool result]
    B --> R
    N --> R
    D --> R
    R --> L[Host-owned canonical event writer]
~~~

### 2.3 默认 profiles

| Profile | Approval | Filesystem | Network | 用途 |
|---|---|---|---|---|
| read-only | on-request | 工作区及依赖只读；控制面路径 deny | deny | 审阅、检索 |
| workspace-write | on-request | 工作区写；工作区外只读或 deny；控制面路径 deny | deny | 默认交互式编码 |
| headless-workspace | never | 与 workspace-write 相同 | deny | CI/非交互；所有 ask 直接拒绝 |
| danger-full-access | never | unrestricted，仍保护 RunLedger 控制面 | allow | 明确信任环境 |
| custom | on-request 或 never | 由规则和 sandbox config 解析 | deny/allow | 企业定制 |

第一版不实现 unless-trusted；RunLedger 当前没有可信 project store，伪造这个模式会产生错误安全感。

## 3. 目标代码结构

~~~text
src/
  security/
    types.ts                    # AccessRequest、rule、decision、profile、audit 类型
    config/
      schema.ts                 # SecurityConfig 的运行时清洗
      loader.ts                 # managed/user/project/CLI 分层加载，安全配置失败关闭
      resolver.ts               # 解析 profile、workspace roots、policy digest
    permission/
      access-resolver.ts        # toolName + normalized args -> AccessRequest[]
      rule-matcher.ts           # deny > ask > allow；path/host/tool/command 匹配
      shell-analyzer.ts         # 保守拆链、wrapper 识别、unknown 语义升级 ask
      engine.ts                 # 纯函数/无 UI 的 policy decision
      approval-coordinator.ts   # ask -> prompt；timeout/cancel/requester gone
      grants.ts                 # session-scoped allow-once；后期持久 grant
    sandbox/
      types.ts                  # profile、backend capability、enforcement status
      policy-resolver.ts        # symbolic roots -> canonical roots
      backend.ts                # SandboxBackend 接口
      probe.ts                  # 平台/命令可用性探测
      linux-bwrap.ts            # Linux bwrap backend
      macos-seatbelt.ts         # macOS sandbox-exec/Seatbelt backend
      windows-external.ts       # 第一版仅 external/unavailable，禁止伪装 enforced
      denial.ts                 # 结构化识别 sandbox denial
    execution-gateway.ts        # 唯一安全决策/受限 IO 入口；process 生命周期交 Host facade
    policy-filesystem.ts        # read/write/stat/readdir/mkdir/rm 路径 gate
    policy-network.ts           # fetch/host/network gate
    redaction.ts                # audit secret/env/credential 脱敏

  worktree/
    types.ts                    # WorktreeRecord、request/result、state
    paths.ts                    # managed base、repo slug、collision-safe label
    git-operations.ts           # 受控参数数组调用 git，不暴露任意 shell
    registry.ts                 # append-only JSONL registry + lock + replay
    manager.ts                  # create/list/show/touch/remove/apply preview
    session-binding.ts          # source cwd subdir offset、resume 校验、effective cwd

  runtime/
    protocol/**               # Runtime 计划独占；本计划只 import，不修改
    host/**                      # runtime/05 独占；本计划只提供 composition adapter
    process/**                   # runtime/05 独占 process state/backend/output/recovery
    execution-env.ts            # legacy/foreground seam；不得扩成第二 ManagedProcessRegistry
    tool-authorization.ts       # 适配 PermissionEngine/ApprovalCoordinator
    tool-context.ts             # 加 workspace、resolved profile、attemptId
    agent-loop.ts               # 记录 request/decision/sandbox/result 顺序
    interactive-session-controller.ts
    tools/*.ts                  # 全部改经 context.env / ExecutionGateway
    security-event-adapter.ts   # 发射 Runtime-owned exact event,不扩展 legacy ledger kind

  storage/
    runledger-home.ts           # composition root 注入 canonical layout,本计划不重复解析
    paths.ts                    # 历史 locator；不作为新 security/worktree storage authority
    security/                   # layout-relative config/grant locator 与 store
    worktree/                   # layout-relative registry locator 与 store
    security-config.ts          # 严格安全配置加载入口
    session-codec.ts            # PersistedWorkspaceBinding/SecuritySnapshot 恢复并投影 Runtime refs

  tui/
    permission-prompt.ts        # allow once / deny / cancel
    security-status.ts          # profile、backend、worktree、degraded 状态

  cli/
    args.ts
    main.ts
    worktree-command.ts

tests/
  security/
    config.test.ts
    rule-matcher.test.ts
    shell-analyzer.test.ts
    path-boundary.test.ts
    approval-coordinator.test.ts
    execution-gateway.test.ts
    sandbox-linux.test.ts
    sandbox-macos.test.ts
  worktree/
    paths.test.ts
    registry.test.ts
    manager.test.ts
    session-binding.test.ts
  integration/
    worktree-sandbox-permission-e2e.test.ts
~~~

目录职责约束：

- src/security 不依赖 TUI；prompt 通过接口注入。
- src/worktree 不依赖 Agent 或模型；session-binding 只处理持久化身份。
- 平台 sandbox backend 不做 permission 决策，只执行已解析 policy。
- 工具不能直接 import node:fs、node:child_process 或调用 global fetch；可信控制面模块例外，但必须通过静态边界检查名单。
- WorktreeManager 是可信控制面，不把任意 shell 文本交给模型。

### 3.1 文件所有权与并行修改矩阵

| 文件/目录 | 所有者 | 并行规则 |
|---|---|---|
| `src/runtime/protocol/**`、`tests/runtime-contracts/{workspace-contracts,security-contracts}/**` | Runtime contract 计划 | 本计划只消费已冻结 public exports；不得直接修改 |
| `src/security/**`、`tests/security/**` | 本计划 | 可与 Runtime 其他独占目录并行 |
| `src/worktree/**`、`tests/worktree/**` | 本计划 | 可与 Runtime 其他独占目录并行 |
| `src/runtime/agent-loop.ts`、Host resident composition/Control Plane、`execution-env.ts`、`tool-context.ts`、`tool-authorization.ts`、`interactive-session-controller.ts` | 串行集成面 | 仅 Phase 5 集成窗口修改；窗口内 Runtime Host/其他专项不得并发编辑 |
| `src/runtime/{host,process}/**`、`src/storage/{host,process}/**` | `runtime/05` | 本计划不复制 manager/backend/output/recovery；仅经既有 port/composition handoff |
| Runtime event-sink/Host composition、`src/storage/{runledger-home,session-codec,session-manager}.ts` | 串行集成面 | Runtime contract、Host handoff 与独占实现完成后逐文件接线；不扩展 legacy ledger kind |
| `src/runtime/tools/**` | 串行集成面 | ExecutionGateway adapter 稳定后一次迁移；Runtime Workspace/Security 契约域不得并行修改行为文件 |
| `src/cli/**`、`src/tui/**`、`src/index.ts`、`package*.json` | 串行产品集成面 | 与 Plugin/Context 等专项集成窗口排队，不并发修改 |
| `tests/integration/**`、`tests/e2e/**` | 联合验证 | 只在双方独占测试通过后补充，按单一集成提交修改 |

共享文件不是任何并行阶段的“顺手修改”范围。若实现需要新增接缝，先在 `src/security/integration/**` 或 `src/worktree/integration/**` 完成 adapter，并用 fake Runtime ports 测试；到 Phase 5 再以逐文件、可回滚的提交接入。

## 4. 核心契约

以下为实现侧计划接口，不要求逐字照抄；实现时必须保留等价的行为边界，并遵守 erasableSyntaxOnly。跨模块可见的 ID、`WorkspaceExecutionEnvelope`、capability decision、approval/sandbox receipt 和 current event payload 必须直接 import `src/runtime/protocol/**`,不得在本节重新导出同名类型。下列 snippet 只描述 `src/security/**`、`src/worktree/**` 的内部请求、配置和状态。

### 4.1 权限请求

~~~ts
export type AccessRequest =
  | { kind: "filesystem"; operation: "read" | "write" | "delete"; path: string }
  | { kind: "shell"; command: string; cwd: string; analysis: "known" | "unknown" }
  | { kind: "network"; operation: "connect" | "fetch"; host: string; port?: number }
  | { kind: "worktree"; operation: "create" | "remove" | "apply" | "gc"; target: string }
  | { kind: "tool"; toolName: string; provider?: string };

export interface PolicyDecision {
  action: CapabilityDecision;
  reason: string;
  matchedRuleIds: string[];
  source: "managed" | "project" | "user" | "session" | "builtin" | "fallback";
}

export interface AuthorizationResult {
  outcome: "allow" | "deny";
  decisionSource: string;
  requests: AccessRequest[];
  policyDigest: string;
  approval?: ApprovalReceiptRef;
  reason: string;
}
~~~

Runtime authorization adapter 最终把 exact decision/receipt 交给 Host-owned resident agent/process final leaf,但它内部必须完成：

1. 由 tool 的 normalized args 解析 AccessRequest；
2. 对所有请求执行 rule evaluation；
3. 任一 deny 则整个 tool call deny；
4. 无 deny 但任一 ask，则一次 prompt 展示整组 exact request；
5. prompt 的 args/cwd/policyDigest 与实际执行前再比较一次；
6. 不一致则作废审批并重新决策；
7. 返回带 audit metadata 的 final result。

未知工具、未知 capability 或解析失败默认 ask；approvalPolicy=never 时转 deny。

### 4.2 规则与配置

安全配置必须位于 canonical `runledgerHome` authority,不能继续使用旧 agent home 或 repo `.runledger` 作为 RunLedger 自有状态：

~~~text
用户默认：<runledgerHome>/settings.json#security
workspace：<runledgerHome>/projects/<workspace-key>/settings.json#security
企业托管：Linux/macOS /etc/runledger/security.json
repo policy：可选只读、默认不可信的收紧 proposal,不能授予或覆盖 canonical/managed deny
CLI 覆写：Host request 只允许选择 profile/收紧策略；是否允许放宽受 managed constraints 控制
~~~

`SecurityConfigLoader` 对上述 canonical settings 中的 `security` section 做独立 exact/fail-closed 校验,不能沿用“未知安全字段丢弃后继续”的容错路径。grant、approval 和 policy snapshot state 可写 `<runledgerHome>/state/security/**`,但不能另建配置 authority。`runledgerHome` 只由 composition root 解析一次并注入 loader；`RUNLEDGER_SESSION_DIR`、`--session-dir`、`settings.sessionDir`、`<cwd>/.runledger/` 与 `~/.runledger/agent/` 不拥有 security authority。CLI/Host-fixed 配置冲突必须在 handshake/command 前 typed reject,不得让不同 client 形成不同 effective policy。

建议 schema：

~~~json
{
  "profile": "workspace-write",
  "approvalPolicy": "on-request",
  "filesystem": {
    "read": [":workspace", ":tmp"],
    "write": [":workspace", ":runledger-temp"],
    "denyRead": ["**/.env", "**/id_*"],
    "denyWrite": [":workspace/.git", ":workspace/.runledger"]
  },
  "network": {
    "mode": "deny",
    "allowedHosts": []
  },
  "rules": [
    { "id": "deny-git-push", "action": "deny", "kind": "shell", "pattern": "git push*" },
    { "id": "ask-worktree-remove", "action": "ask", "kind": "worktree", "pattern": "remove:*" }
  ]
}
~~~

合并规则：

1. 所有 source 的规则保留来源，不用后层对象覆盖前层对象。
2. evaluation 全局采用 deny > ask > allow，与配置顺序无关。
3. managed constraints 可限制 profile 和 approvalPolicy 的可选集合。
4. 项目 allow 不能覆盖用户/managed deny。
5. security.json 不存在可使用内建安全默认值；存在但解析失败、字段非法或路径 token 未识别时阻止安全模式启动。
6. 每次 session 启动生成 canonical SecuritySnapshot 与 SHA-256 policyDigest。
7. resume 默认使用已记录 snapshot；如果当前 managed policy 更严格，则取交集/更严格结果并记录 policy_changed。

### 4.3 Path boundary

CanonicalPathResolver 的固定步骤：

1. 以 Host 从 PersistedWorkspaceBinding hydrated 的 private effective cwd 解析相对路径，并与 Runtime WorkspaceExecutionEnvelope 交叉校验；
2. path.normalize 得到 lexical path；
3. 对已存在路径 realpath；
4. 对待创建路径 realpath 最近存在父目录，再拼回剩余 segments；
5. 同时保留 requestedPath、lexicalPath、canonicalPath 用于审计；
6. 对 read/write/delete 分别匹配 allow roots 与 deny paths；
7. 对 symlink target 再匹配一次；
8. 执行前重复关键校验，缩小审批至执行之间的 TOCTOU 窗口；
9. restrictive profile 中默认保护 .git、.runledger、RunLedger worktree registry 与 credential storage；
10. OS sandbox 是最终边界，软件 path check 不能被描述为强隔离。

### 4.4 Shell 分析

第一版不追求完整 Bash 解释器，而采用保守模型：

- 安全拆分 &&、||、;、管道和换行；
- 去除前置环境赋值并识别 env、timeout、nice、ionice、stdbuf 等有限 wrapper；
- deny/ask 对 whole script 和每个 segment 都检查；
- allow 必须覆盖每个 segment，不能只匹配第一段；
- 对 command substitution、backticks、heredoc、单 &、函数、循环、条件、重定向目标不确定等返回 analysis=unknown；
- unknown 在交互模式 ask，在 never 模式 deny；
- rg --pre、tee、sudo、xargs、nohup 不进入内建只读快路径；
- rm/chmod/chown/chgrp/kill/pkill/git push 等危险命令不得被 session prefix grant 静默批准；
- 即使命令被批准，仍必须在 SandboxBackend 中执行。

后续若引入 tree-sitter-bash 或 native parser，必须先做依赖和跨平台构建审阅；不能为了“解析成功率”牺牲 fail-closed。

### 4.5 Approval

~~~ts
export interface PermissionPrompt {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  requests: AccessRequest[];
  policyDigest: string;
  createdAt: number;
}

export type PermissionPromptResponse =
  | { decision: "allow-once" }
  | { decision: "deny"; reason?: string }
  | { decision: "cancel" };

export interface PermissionPrompter {
  request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse>;
}
~~~

第一纵切只做 allow-once/deny/cancel：

- 不持久化 allow always；
- 同一 toolCall 只有一个 pending prompt；
- prompt 支持 AbortSignal；
- TUI 退出、requester 消失、session interrupt 或 timeout 都返回 deny/cancel；
- 并行工具先串行完成权限决策，再按现有 executionMode 决定是否并行执行；
- 记录 prompt waitMs，但不把 credential、完整环境变量或 API key 写入 ledger。

持久 grant 在后续阶段引入，必须绑定 project identity、canonical prefix/host/path、profile 和 policy digest。

### 4.6 ExecutionGateway 与 Runtime Host 唯一执行链

本专项不再把 `ExecutionEnv` 扩成第二个 process registry。受限 filesystem/network 与 execution-constraint handoff 分开：

~~~ts
export interface RestrictedExecutionAdapters {
  fs: PolicyFileSystem;
  network: PolicyNetworkClient;
  processDecision: ExecutionConstraintDecisionProvider;
  sandboxDecision: SandboxDecisionProvider;
}
~~~

实施约束：

- read/write/edit/multi-edit/ls/grep/find 全部消费 Host composition 注入的 `PolicyFileSystem`；必要 shell helper 也必须走 Host process facade。
- WebFetch 使用 `PolicyNetworkClient`,不调用 global fetch。
- bash foreground/background、hook/MCP stdio、CLI shell 与 PTY 全部使用 `runtime/05` Host process facade；本专项只提供绑定 execution/attempt 的 decision/receipt 和 sandbox launch adapter。
- tool result 大正文进入 Host private output 或策略授权的 Artifact CAS；不得自行把物理路径返回模型/TUI。
- 工具 factory 中的 operations 只保留测试注入用途；生产构造必须来自 Host + ExecutionGateway composition。
- `localExecutionEnv` 只保留为低层或 test adapter,不得由生产工具自行创建,也不得成为 Host unavailable 时的 fallback。
- 新增边界检查脚本，禁止 src/runtime/tools 下出现 node:fs、node:child_process 和裸 fetch，白名单必须逐文件列出。

### 4.7 Sandbox

Runtime 公共层的 `SandboxProfileRef` 与 `SandboxExecutionReceiptRef` 直接 import；实现层只额外定义 backend 行为：

~~~ts
export interface SandboxBackend {
  probe(): Promise<SandboxBackendCapability>;
  prepare(request: SandboxPrepareRequest): Promise<SandboxLaunchPlan>;
  validateFinalLeaf(plan: SandboxLaunchPlan, requestDigest: string): Promise<SandboxDecisionReceipt>;
}
~~~

`SandboxBackend` 不直接拥有 durable process identity、PID、PTY、output 或 recovery。它生成并验证受约束 launch plan/receipt,由 Host-owned process backend 在 intent/spawn claim 后执行；final leaf 必须重新绑定 execution/attempt/request digest。只有 platform adapter 内部且由 Host 调用的最小 spawn seam 可以接触 wrapper/native handle。

平台路线：

| 平台 | 第一版 backend | 边界 |
|---|---|---|
| Linux | bwrap feature probe；根只读绑定、显式 writable roots、deny read bind-over、可选 unshare network | bwrap 不存在时 restrictive shell unavailable，不能退回 raw bash |
| macOS | sandbox-exec/Seatbelt profile 生成与 feature probe | sandbox-exec 不可用时 fail closed；记录 deprecated/availability 状态 |
| Windows | external 或 unavailable | 第一版不宣称 native enforced；后续单独 native helper/Restricted Token 计划 |
| 已在外部容器 | external | 调用者声明外部边界；RunLedger 仍做软件 permission/path gate |

必须区分：

- requested profile；
- resolved policy；
- backend capability；
- effective enforcement；
- degraded reason。

read-only/workspace-write/strict 请求在 backend unavailable 时：

1. PolicyFileSystem 的软件拒绝仍然生效，但它不能把该 profile 标记为可用或 enforced；
2. 任意 shell、后台进程和可能衍生子进程的工具拒绝执行；
3. Host 可继续提供不需要该强约束的只读 query,但所有请求 restrictive sandbox 的 process 在 spawn 前 typed unsupported；TUI/诊断面显示 unavailable；
4. 只有用户通过受策略约束的 Host command 显式切换 builtin `none`/external 才能继续,并记录新 policy revision/receipt；不接受静默 fallback。

Network 第一纵切只支持 deny/allow：

- deny 由 bwrap network namespace 或 Seatbelt network rule实施；
- WebFetch 同时经 host policy；
- shell 内按域 allowlist 需要受控 proxy，列为后续阶段；
- 未有 proxy 前，custom allowedHosts 不能被标记为 shell 层 enforced。

### 4.8 Worktree

默认路径：

~~~text
<runledgerHome>/state/worktrees/
  managed/
    <repo-slug>-<canonical-root-hash>/
      <worktree-id-or-label>/
  registry.jsonl
  registry.jsonl.lock
~~~

`RUNLEDGER_DIR`/默认 `~/.runledger` 只在 composition root 解析一次；WorktreeManager 只接收注入的 `RunledgerLayout`。repo slug 由非敏感 display hint + canonical repo identity digest 组成，避免同名仓库碰撞；public event/receipt 不保存绝对 source/worktree/home path。

第一版 WorktreeRecord：

~~~ts
export type WorktreeState =
  | "creating"
  | "ready"
  | "active"
  | "retained"
  | "removing"
  | "removed"
  | "failed";

export interface WorktreeRecord {
  id: string;
  sessionId: string;
  sourceRepositoryRef: RepositoryRef;
  sourceSubdir: string;
  worktreeLocator: string;
  effectiveSubdir: string;
  baseRef: string;
  baseCommit: string;
  branch?: string;
  label: string;
  state: WorktreeState;
  createdAt: number;
  lastAccessedAt: number;
  error?: string;
}
~~~

生命周期约束：

1. 第一版只实现 Git 原生 clean worktree，不复制 dirty/untracked/ignored 文件。
2. create 默认使用 git worktree add --detach <dest> <baseRef>；可显式创建任务 branch。
3. Git 命令以 program + args 执行，禁止字符串拼接后 bash -c。
4. prepare 验证 source repo、base ref、dest 所属 managed base 和 collision。
5. 以 sessionId/id 持锁 claim；重复 create 返回 creating/exists，不重复创建。
6. 创建失败或取消时清理部分目录与 Git registration，并追加 failed event。
7. source 位于 repo 子目录时保存 root-relative subdir offset；private effective cwd = worktree root + validated offset。
8. list/show 以 git worktree list --porcelain 与 registry 双源校验；registry 不是单独真相。
9. remove 默认 dry-run/拒绝 dirty worktree；force 必须 exact approval。
10. remove 前验证 canonical target 位于 managed worktree base、record owner 一致、不是 source repo/root/home。
11. 不允许对任意用户传入路径调用递归删除。
12. apply 第一版只生成 status/diff/commit/冲突预览，不自动改 source；实际 apply/merge 作为独立审批操作。
13. GC 只处理 registry 标记 removed/failed 或超过 TTL 且 clean、非 active 的 managed worktree。

绝对 source/worktree path 只存在于 Host/WorktreeManager 的进程内解析状态或受保护 private locator store；canonical event、receipt、Artifact metadata、模型和普通 TUI 只使用 `RepositoryRef`、`WorkspaceRef`、root-relative locator 与 digest。

不在第一版实现：

- grok-build 的 Btrfs/overlay/CoW fast worktree；
- worktree pool 和跨进程预热；
- dirty source 自动复制；
- 自动 stash；
- 自动 merge、push 或删除 branch；
- jj workspace。

这些能力依赖基础生命周期与审计稳定后再单独评估。

### 4.9 Session、resume 与 ledger

新增实现侧 `PersistedWorkspaceBinding`；它必须可无损投影为 Runtime 的 `WorkspaceBindingRef`,但不是第二份公共契约：

~~~ts
export interface PersistedWorkspaceBinding {
  kind: "source" | "worktree";
  sourceRepositoryRef: RepositoryRef;
  sourceSubdir: string;
  effectiveSubdir: string;
  worktreeId?: string;
  baseCommit: string;
}
~~~

Session 启动顺序固定为：

1. composition root 解析一次 `RunledgerLayout`,完成 Host scope/compatibility/peer preflight；
2. client 通过 authenticated Host command 请求 create/resume/attach,不得直接获取 session lock；
3. Host 解析 canonical user/workspace security config 与 source repo/workspace identity；
4. Host 创建或恢复 PersistedWorkspaceBinding，并投影 Runtime WorkspaceBindingRef；
5. 以 private effective cwd 物化 sandbox workspace roots,生成 SecuritySnapshot/policyDigest；
6. Host 构建 ExecutionGateway、restrictive decision adapters、工具与 resident Agent；
7. client 取得 remote facade、driver/observer role 与 subscription cursor后进入 TUI。

resume 必须校验：

- worktree record 存在；
- path 存在且仍是预期 Git worktree；
- source repo identity 与 base commit 可解析；
- subdir offset 没有逃出 worktree root；
- 当前 managed policy 是否比 snapshot 更严格；
- backend capability 是否发生变化。

缺失 worktree 时不得静默把 cwd 切回 source repo。Host 应发 durable reverse request,由 active driver 选择“重新创建 / 以 source 只读恢复 / 取消”；observer 不能 resolve。重新创建必须基于记录的 baseCommit,使用 idempotent Host command 并保留新的 worktree event/receipt。

不得扩展一套下划线命名的 `LedgerEntryKind`。集成层直接发射 Runtime 已冻结的事件：

~~~text
workspace.bound
workspace.validation_recorded
workspace.released
lease.acquired / lease.taken_over / lease.released
permission.requested / permission.decided / permission.expired / permission.revoked
sandbox.resolved / sandbox.execution_recorded
~~~

所有 payload 必须通过 Runtime TypeBox schema，并按事件类型携带 sessionId、attemptId、toolCallId（如适用）、timestamp、policyDigest 与 receipt refs。发射顺序由本计划实现：

~~~text
tool.requested
permission.requested
permission.decided
sandbox.resolved
sandbox.execution_recorded
tool.started
tool.finished / tool.failed / tool.interrupted
~~~

Host/process final leaf 还会保存 `process.execution_requested/started/terminal|lost|uncertain`。Security event 证明 policy/approval/sandbox decision,process event 证明 intent/spawn/output/terminal；两者以 execution/attempt 和 constraint snapshot digest 关联,不得互相冒充或双写同一事实。

审计 payload 只保存必要字段：

- command/URL/path 按安全审计策略保存并限制长度；
- env 只保存 key 列表，不保存 value；
- credentials、API key、authorization header、cookie 必须脱敏；
- policy 保存 digest + source 列表，完整配置由 session security snapshot 保留受控副本；
- sandbox unavailable/degraded 必须是可查询字段，不能只写 stderr。

## 5. CLI 与 TUI 目标

### 5.1 CLI

在 current argv parser 上分阶段加入 typed Host request：

~~~text
--permission-profile <read-only|workspace-write|danger-full-access|custom>
--approval-policy <on-request|never>
--sandbox <off|read-only|workspace-write|strict|external>
--network <deny|allow>
--worktree [label]
--worktree-ref <ref>
--worktree-branch <name>
--no-worktree
~~~

管理命令在主链稳定后加入：

~~~text
runledger worktree list
runledger worktree show <id-or-path>
runledger worktree remove <id-or-path> [--dry-run] [--force]
runledger worktree apply <id-or-path> --preview
runledger worktree gc --dry-run
~~~

规则：

- CLI 可以在 handshake/command 中显式收紧策略,但 client 不自行解析 effective policy或创建 controller。
- CLI 放宽是否有效受 managed constraints 限制。
- `--sandbox workspace-write` 但 backend unavailable 时,Host 对相关 session/process 返回 typed unsupported 并给出可操作诊断,不得启动 client-local fallback。
- --approval-policy never 不开启 full access。
- --worktree 与 --no-worktree 互斥。
- help 输出清楚区分 worktree、permission、approval、sandbox。

### 5.2 TUI

新增最小交互面：

- 底部状态：workspace/source、worktree label、permission profile、sandbox backend/enforcement、network。
- Permission overlay 展示 tool、workspace-relative cwd、脱敏 paths/host/command 摘要、原因与 policy source。
- 选项仅 Allow once、Deny、Cancel turn。
- tool component 在 pending 与 running 之间增加 awaiting approval 状态。
- permission overlay 出现时不丢 steering/follow-up，不允许相同 toolCall 重复 prompt。
- session interrupt 关闭 prompt 并产生 cancelled decision。
- 宽度与 snapshot 测试覆盖窄终端。
- overlay 来自 Host reverse request；只有 active driver 可提交 decision,observer 只读。driver detach 不丢 waiter,新 driver 携 expected revision claim 后继续。
- TUI 不读取 security/worktree registry、Event Store、process output 或 sandbox backend 文件；只使用 bounded Host query/subscription DTO,绝对路径按 public redaction policy 隐藏。

## 6. 分阶段实施

每个阶段是一个可独立审阅的 commit/PR 边界。没有完成前一阶段验收，不进入后续阶段。

### 并行交付顺序

1. **契约冻结**：Runtime contract 计划先完成 Foundation、Event、Workspace/Security 与 Adapter Port work packages,冻结 workspace/security schema、events、projections、ports 与 fixtures;contract 工作不得修改 session/storage/CLI 行为基线。
2. **独占目录并行**：本计划在 `src/security/**`、`src/worktree/**` 完成行为实现；其他 owner 可同时推进不触碰共享文件的 contract 或行为工作。
3. **Host handoff**：以 `runtime/05` 已提交 baseline 和当时最新 hardening commit 为基线,冻结 constraint snapshot/final-leaf、durable command、driver/reverse-request 与 subscription 交接；本计划不得修改 Host/process 内部状态机来迁就 adapter。
4. **串行集成**：双方独占测试通过后，预约单一集成窗口，由本计划 Phase 5 逐文件修改 Host resident composition/runtime/session/storage/CLI/TUI；Plugin、Context 等其他专项不得同时修改这些文件。
5. **联合门禁**：最后运行 bypass、real Git、real Host process/sandbox、双 client driver/observer、resume/restart 与 current replay E2E。Runtime contract、Host runner 或本计划内部单测均不能单独替代该门禁。

若 Runtime contract 尚未冻结，本计划只能编写不依赖未决字段的内部纯实现与测试，不能在实现目录临时创造公共 envelope/receipt/event 类型。

### Phase 0：冻结契约与安全回归基线

目标：消费已冻结 Runtime contract，用测试固定当前绕过点和期望的 fail-closed 语义。

涉及：

- 新建 src/security/types.ts、src/worktree/types.ts，仅放实现内部 rule/config/backend/record 类型，并 import Runtime 公共契约。
- 新建 tests/security/current-runtime-boundary.test.ts，不修改既有 Runtime 测试文件。
- 新建 tests/security/current-boundary.test.ts。
- 新建 scripts/check-execution-boundaries.ts。
- package.json 接入 `npm run check` 延后到 Phase 5 串行集成；Phase 0 直接执行脚本。

步骤：

1. 记录 builtin-none baseline、restrictive profile unavailable、deny 转 isError、Host/process 与 security event 关联顺序的现状测试。
2. 增加“工具不得直接 raw fs/spawn/fetch”的静态扫描，但先用显式 legacy allowlist 标记现有债务。
3. 对 Runtime workspace/security schema 建 adapter conformance tests；固定实现内部术语，不重复导出公共 type-only API。
4. 在文档与 test name 中区分 requested/enforced。

验收：

- npm run check 全输出无 error/warning/info；另直接运行边界脚本。
- npm test 全绿。
- legacy allowlist 精确到文件，不使用整个目录豁免。
- 架构测试证明 src/security 与 src/worktree 没有重定义 Runtime envelope/decision/receipt/event union。

建议 commit：test(security): freeze execution-boundary contracts before isolation work

### Phase 1：PermissionEngine 与 ApprovalCoordinator

目标：实现可替代 production builtin-none policy 的确定性规则与审批协调器，同时不引入 OS sandbox；实际切换 Host composition 延后到 Phase 5。

涉及：

- src/security/config/*
- src/security/permission/*
- src/security/redaction.ts
- src/security/integration/runtime-authorization-adapter.ts
- 安全配置的独占 loader/store；storage/runtime 接线延后到 Phase 5
- tests/security/config.test.ts、rule-matcher.test.ts、shell-analyzer.test.ts、approval-coordinator.test.ts

步骤：

1. 实现 AccessRequest、rule、policy digest 和 strict config loader。
2. 实现 deny > ask > allow；unknown -> ask。
3. 实现 conservative shell analyzer。
4. 实现 PermissionPrompter 接口与 headless deny prompter。
5. runtime authorization adapter 在 ask 时等待 coordinator，返回符合 Runtime port 的 final decision/receipt；本阶段不改 agent-loop。
6. 先为 stdlib 内建工具建立 centralized access resolver。
7. 解析默认 workspace-write + on-request；Host composition 切换和 builtin-none 仅显式选择的边界测试延后到 Phase 5。

验收：

- project allow 不能覆盖 managed/user deny。
- chained command 中任一 deny 拒绝整个 call。
- unparseable command 在 never 下拒绝。
- prompt cancel/abort/requester gone 不执行工具。
- args 在 prompt 后变化会使审批失效。

建议 commit：feat(security): require deterministic authorization before tool execution

### Phase 2：构建 ExecutionGateway 唯一执行面

目标：完成可供所有内置工具消费的唯一安全决策/受限 filesystem/network 面及 broker；process 生命周期继续由 Host facade 独占。生产工具无旁路的结论延后到 Phase 5 接线后验收。

涉及：

- src/security/execution-gateway.ts
- src/security/policy-filesystem.ts
- src/security/policy-network.ts
- src/security/integration/runtime-gateway-adapter.ts
- tests/security/path-boundary.test.ts、execution-gateway.test.ts
- fake Runtime tool/env contract tests；现有 stdlib/tools 迁移延后到 Phase 5

步骤：

1. 在 security 内部 broker port 增加 realpath/lstat/rename 等安全实现需要的最小 API，不先扩张 Runtime ExecutionEnv。
2. 引入 CanonicalPathResolver 与受保护元数据规则。
3. 用 fake consumers 证明 Runtime Gateway port 只能返回受限 executor；生产工具切换延后到 Phase 5。
4. 实现 PolicyNetworkClient 与 WebFetch adapter，不在本阶段修改 WebFetch。
5. 实现 Host process decision/sandbox adapter,用 fake final-leaf consumer 验证 execution/attempt/request digest 绑定；不实现 `ManagedProcessRegistry`、PTY 或 output store。
6. tool output 大正文只返回 private-output/Artifact policy intent,不自行创建根外 spill。
7. 保留 Phase 0 legacy allowlist，直到 Phase 5 完成每个生产工具迁移后逐项清空。

验收：

- ../、绝对路径、symlink 三类 workspace escape 被拒绝。
- .git/.runledger 默认不可由 agent 写。
- fake Runtime ports 能证明 gateway 对 fs/network 无旁路,并证明 process 缺 decision/receipt 或 stale digest 时 Host final leaf `spawnCount=0`。
- security/worktree 独占目录静态扫描无未经声明的 raw fs/spawn/fetch。
- 此阶段不声称现有生产工具已完成迁移；该验收只在 Phase 5 判定。

建议 commit：feat(security): build the only policy-aware tool I/O gateway

### Phase 3：Git Worktree 最小生命周期

目标：建立 clean native Git worktree、registry 与 session identity。

涉及：

- src/worktree/*
- src/worktree/integration/runtime-workspace-adapter.ts
- tests/worktree/*

步骤：

1. 实现 managed base/repo slug/label collision。
2. 实现受控 GitOperations，命令一律 args 数组。
3. 实现 append-only WorktreeRegistry + proper-lockfile + replay。
4. create 采用 prepare/claim/create/finalize，失败清理半成品。
5. 实现 list/show/touch/remove dry-run。
6. 保存 source subdir offset 与 root-relative PersistedWorkspaceBinding，并投影 Runtime WorkspaceBindingRef/WorkspaceExecutionEnvelope；绝对 locator 留在 private store。
7. adapter 生成符合 Runtime schema 的 workspace/lease event payload；真正 append 接线延后到 Phase 5。

验收：

- 临时 Git repo E2E 覆盖 source root 与 source subdir。
- 同 session 并发 create 最终只有一个 worktree。
- label collision 确定性解决。
- create 中断后无 dangling dest/registration。
- dirty worktree 默认不能 remove。
- 任意 managed base 外路径不能成为 remove target。
- registry 与 git worktree list 不一致时报告 stale，不盲目删除。

建议 commit：feat(worktree): bind sessions to auditable clean git worktrees

### Phase 4：平台 SandboxBackend

目标：为 shell/child process 提供真实平台边界，并诚实报告能力。

涉及：

- src/security/sandbox/*
- src/security/execution-gateway.ts
- src/security/integration/runtime-sandbox-adapter.ts
- tests/security/sandbox-linux.test.ts、sandbox-macos.test.ts、denial.test.ts

步骤：

1. 定义 probe/prepare/final-leaf-validation/status 接口,实际 spawn 继续走 Host process backend。
2. 实现 Linux bwrap backend 与 deny network。
3. 实现 macOS Seatbelt backend。
4. Windows 第一版只返回 external/unavailable。
5. 从 Runtime WorkspaceExecutionEnvelope 消费 effective workspace root，并物化为 sandbox write root。
6. 将 .git/.runledger/credential/registry 作为 deny/protected paths。
7. 识别 sandbox denial，并生成符合 Runtime SandboxExecutionReceiptRef/event payload schema 的结构化结果。
8. backend unavailable 时 restrictive shell fail closed。
9. 只向 Host process facade交付 launch plan/decision receipt；不得直接 spawn、返回 PID/handle 或保存 output/recovery。

验收：

- Linux/macOS 平台测试分别证明 workspace 内允许、外部写拒绝、deny-read 拒绝、network deny。
- backend 缺失测试证明没有 raw shell fallback。
- requested、resolved、effective、enforcement 四层状态可审计。
- sandbox failure 不被误报为普通工具 bug。

建议 commit：feat(sandbox): enforce resolved workspace boundaries for child processes

### Phase 5：Runtime Host、CLI/TUI、resume 与审计闭环

目标：在唯一串行集成窗口把已验收的 security/worktree adapters 接入 production Runtime Host resident composition,使 remote client 可选择/看见/批准，并能无损恢复隔离状态。

涉及：

- src/cli/args.ts、main.ts、worktree-command.ts
- src/tui/permission-prompt.ts、security-status.ts 及相关 component
- Host resident-session/composition/Control Plane、src/runtime/interactive-session-controller.ts、agent-loop.ts
- src/storage/session-codec.ts
- Runtime event-sink/Host command-store composition
- tests/cli、tests/tui、tests/integration

步骤：

1. 先记录集成窗口，确认 Runtime Host/Plugin/Context 等其他计划没有并发修改共享文件；逐文件审阅基线和 Host handoff commit。
2. Host composition 从 canonical user/workspace settings 解析 security/worktree,选择 restrictive adapter；CLI 只提交 typed request并连接 remote facade,不得创建 controller。
3. TUI 实现 Host reverse-request 的 allow-once/deny/cancel；只有 active driver 可提交带 generation/revision 的 Runtime approval command/result。
4. tool-context/stdlib tools 一次迁移到 ExecutionGateway + Host process facade；迁移一项清理一项 legacy allowlist,不改 Host backend内部状态机。
5. Host-owned event sink 按 Runtime schema 追加 workspace/permission/sandbox 事件、attemptId 与 receipt refs；agent-loop 只调用 adapter,不扩展第二套 LedgerEntryKind。
6. Host cold replay 恢复 PersistedWorkspaceBinding/SecuritySnapshot，并投影 Runtime refs；client reconnect 只恢复 cursor/view state。
7. resume 验证 worktree/backend/policy 漂移，不能静默切 source。
8. footer/status 显示 degraded/unavailable；worktree 管理命令先实现 list/show/remove dry-run。
9. 每个共享文件单独 diff/test；不得把 Runtime Host 未提交 hardening或 Plugin/Context 等其他专项改动混入同一提交。
10. security/worktree command 使用 durable intent/receipt；同 command/body 跨重启重放 receipt,异体 conflict,只有 intent 无 receipt 时 `uncertain_outcome` 且不重复 create/remove/approve。

验收：

- 真实 CLI smoke：两个 client 复用一个 Host,安全 profile、approval、deny、interrupt、resume；observer mutation `spawnCount=0`。
- TUI snapshot 覆盖窄宽度与长命令。
- ask 在非交互路径确定性 deny，不阻塞 stdin。
- resume 后工具 private cwd 来自 validated effective workspace binding,不是 client cwd 或 source fallback。
- current events 可重放出每次批准、sandbox backend 与 worktree identity；Runtime projection digest 与 live state 一致。
- src/runtime/tools 静态扫描无 raw fs/spawn/fetch，Phase 0 legacy allowlist 清空。
- Host process/backend/output/recovery 仍只有 `runtime/05` 一套 owner,security/worktree 没有第二 registry/PTY/output store。

建议 commit：feat(cli): expose and persist the effective security boundary

### Phase 6：Worktree handoff、持久 grants 与 GC

目标：在基础安全闭环稳定后增加便利能力，不提前扩大权限面。

涉及：

- Worktree apply preview/explicit apply。
- session/project-scoped grants。
- worktree touch/TTL/GC。
- 可选 network allowlist proxy。

前置条件：

- Phase 0–5 全部完成。
- 进行独立安全 review。
- 已有针对 symlink、shell chain、prompt replay、stale registry 的回归测试。

约束：

- allow always 必须显示精确 scope 和持久位置。
- policy digest 或 project identity 变化时 grant 失效。
- apply 必须先 preview；冲突不自动解决。
- GC 默认 dry-run；active/dirty/unknown worktree 永不自动删。
- network host allowlist 在 shell 层只有受控 proxy 到位后才标记 enforced。

建议拆为至少三个独立 commit/PR，不合并成一个大变更。

### Phase 7：Runtime 下游端口与联合语义

目标：为 Artifact、Verification、Multi-Agent 和 Control Plane 提供真实 Workspace/Security port 实现，不让这些 Runtime 模块重新实现 worktree、permission 或 sandbox。

涉及：

- `src/security/integration/**`、`src/worktree/integration/**`。
- Runtime Artifact checkpoint/rewind/cleanup、Verification invocation、Agent workspace/capability subset、Control Plane approval 的 adapter conformance tests。
- 共享 Runtime consumer 文件仍按 §3.1 分批预约串行窗口，不与其他专项并发。

步骤：

1. `WorkspaceServicePort` 实现 create/attach/validate/checkpoint/rewind/release，并为每次结果签发 Runtime receipt。
2. `CapabilityGatewayPort`、`ApprovalCoordinatorPort`、`SandboxExecutorPort` 实现 request/result/cancel 与 intent/commit/reconcile。
3. Artifact 只提交 WorkspaceCheckpointDescriptor/Artifact refs；实际 Git 采集、恢复与清理由 Workspace adapter 完成。
4. Verification 只提交 typed invocation 与 trusted-base request；adapter 创建只读/隔离 checkout 并经 Gateway 执行。
5. Multi-Agent 只提交 workspace strategy、parent grant ref 与 child requested refs；adapter 判定 capability 子集、分配 lease 并返回 receipt。
6. Host `approval:resolve` command 只转发到 ApprovalCoordinator；Host 验证 active driver/generation/revision并 durable 记录 command intent/receipt,policy evaluation、decision CAS 与 expiry/revoke 保持本计划单一实现。

验收：

- Runtime fake-port contract fixtures 与真实 adapter 对同一输入产生 schema-compatible 结果。
- Artifact/Verification/Multi-Agent/Control Plane 不 import security/worktree 内部 store 或 backend。
- adapter/Host command 重放不会重复 worktree、approval、spawn、rewind 或 cleanup 副作用；只有 intent 无 receipt 时返回 uncertain 且不重执行。
- 每项真实行为都能回溯到 Runtime event cursor、Workspace Envelope 与 enforcement receipt。

### Phase 8：企业策略、Credential 与远程/CI 安全实现

目标：承接 Runtime Control/Telemetry 契约域只定义的数据契约，为 managed policy、identity/tenant、credential 和远程执行提供具体安全实现。

前置条件：Phase 0–7 完成；Runtime enterprise/remote schemas 与 ports 已冻结；独立安全 review 通过。

步骤：

1. 实现 Native MDM > organization managed > file managed > workspace > user local 的 policy source 加载、合并与 effective-policy receipt。
2. 实现 service/user/local-peer/remote-workload identity provider、tenant namespace 与 RBAC/ABAC；高风险 approval 支持 separation of duty。
3. Credential Broker 对接 KMS/keyring bootstrap、rotation、revocation、backup、crypto erase；只向 executor 注入最小短期 grant。
4. CI/SSH/relay executor 验证 Workspace Envelope、lease、attestation、gate 与 egress policy；任何验证失败不得回退本地共享执行。
5. startup/GC 处理外部 lease、approval 与 remote handoff，并向 Runtime 返回 correlation/terminal receipts；orphan process/recovery 仍由 `runtime/05` Host process lifecycle处理,本计划只参与 constraint/grant reconciliation。

验收：

- managed deny 不能被 workspace/user 覆盖，跨 tenant 默认拒绝。
- 请求者不能自批高风险操作，旧 approval/key/token/lease 重放均失败。
- credential 不进入 Runtime event、Artifact、stderr、telemetry 或无关子进程环境。
- 远程/CI 联合 E2E 可证明 workspace、gate、artifact、event、principal 与 sandbox identity。

本阶段属于企业/远程后置能力，不阻塞第一版本地 M1–M5，但未完成时 Runtime 不得对外声明 Enterprise Runtime。

## 7. 测试矩阵

### 7.1 Permission

- deny > ask > allow，与 source/order 无关。
- exact tool/path/host/command 匹配。
- chained shell 每段检查。
- wrapper、leading env、whitespace、word boundary。
- dangerous command、rg --pre、tee、command substitution。
- unknown tool/capability。
- on-request/never。
- prompt abort/timeout/duplicate/requester gone。
- args/cwd/policy digest 变更后审批失效。

### 7.2 Path 与 filesystem

- relative、absolute、..、Windows drive/UNC。
- existing symlink 与待创建路径的 symlink parent。
- workspace root prefix 碰撞，例如 /repo 与 /repo-other。
- .git、.runledger、credential、registry。
- read/write/delete 不同 access。
- temp spill 只能进入 session temp root。

### 7.3 Sandbox

- probe success/failure。
- restrictive backend unavailable 不 fallback。
- workspace write / outside write / deny read。
- child process 继承边界。
- background process 继承边界并可回收。
- Host final leaf 对 stale/missing decision receipt、observer mutation 和 restrictive backend unavailable 均为 `spawnCount=0`。
- network deny。
- structured denial detection。
- external/off 状态不伪装 enforced。

### 7.4 Worktree

- clean create、explicit ref、branch。
- source subdirectory offset。
- concurrent claim、collision、cancel cleanup。
- list/registry reconciliation。
- dirty remove deny、force exact approval。
- malicious target path、symlinked base、source repo self-delete 防护。
- session resume、missing/stale worktree。
- lastAccessed/GC dry-run。

### 7.5 集成

至少一个端到端场景：

1. 临时 Git repo 建初始 commit；
2. 创建 RunLedger session worktree；
3. 解析 workspace-write + network deny；
4. read 自动允许；
5. write 触发 exact approval 并写入 worktree；
6. source repo 保持不变；
7. workspace 外写被 permission 或 sandbox 拒绝；
8. shell network 被拒绝；
9. Runtime event replay 得到 binding、decision、backend、receipt 与 result projection；
10. resume 后继续在同一 worktree；
11. dirty worktree remove 默认拒绝；
12. preview/handoff 后显式清理。
13. 第二 client 以 observer 连接同一 Host,不能 approve/worktree/process mutation；driver detach/reclaim 后 pending approval仍可恢复。
14. Host 在 worktree create/approval intent 后崩溃时,重启只 replay receipt 或返回 uncertain,不重复 Git mutation/授权。

## 8. 验证门禁

每个代码阶段至少执行：

~~~bash
npm run check
npm test
npm run build
git diff --check
~~~

按阶段增加 targeted 验证：

~~~bash
npx vitest run tests/security
npx vitest run tests/worktree
npx vitest run tests/integration/worktree-sandbox-permission-e2e.test.ts
./bin/runledger.js --help
~~~

平台 sandbox 测试要求：

- 先 probe 并打印 backend capability。
- 环境确实不支持时允许明确 skip，但测试报告必须写 unavailable 原因。
- 不能把 backend 缺失当通过。
- CI 至少有 Linux enforced job；macOS/Windows 分别验证其承诺的 capability。

任何阶段修改后仍遵循仓库规则：npm run check 与 npm test 同时通过才可提交；只暂存本阶段明确文件。

## 9. 里程碑与交付定义

### M0：Runtime 契约可消费

- [~] Runtime Workspace/Security 契约域的 schema、events、projections 与 ports 已冻结；当前 adapter 可消费既有 public contract，但 handoff 证据仍待串行集成。
- [x] 本计划 adapters 通过同一 contract imports/fixtures，没有重复 envelope/decision/receipt/event 类型。
- [x] 文件所有权检查证明独占实现阶段未修改串行集成面。

### M1：可审计 permission

- [ ] production 默认选择真实 restrictive profile；builtin-none 只能显式选择并如实记录 not enforced。
- [x] deny/ask/allow 确定性解析。
- [x] allow-once/headless decision 与 cancellation/timeout 语义已由 coordinator 覆盖；TUI reverse request 尚未接线。
- [ ] `permission.requested/decided/expired/revoked` 按 Runtime schema进入 Host-owned canonical event writer。

### M2：唯一执行面

- [ ] 所有内置工具经 ExecutionGateway。
- [x] path canonicalization 与 metadata protection。
- [~] fetch 经 PolicyNetworkClient、final-leaf decision/receipt 已实现；background process、private output/Artifact 仍由 Host 串行接线负责。
- [x] security/worktree 不存在第二 ManagedProcessRegistry、PTY/backend output/recovery store。

### M3：session worktree

- [x] clean Git worktree create/list/show/remove dry-run 的受控 manager 行为。
- [x] registry + lock + replay。
- [~] PersistedWorkspaceBinding 的独立 Runtime adapter 与 resume 尚未完成；当前已覆盖 root-relative worktree record/lease。
- [x] source repo 默认不被 agent 修改的 Git args/managed-root 边界。

### M4：真实 sandbox

- [~] Linux bwrap launch plan/final-leaf validation 已实现；真实 enforced process E2E 尚未通过。
- [x] macOS Seatbelt capability 明确。
- [x] Windows external/unavailable 诚实报告。
- [x] restrictive backend 缺失 fail closed。

### M5：产品闭环

- [ ] Host Control Plane + CLI flags/help,client 无 direct controller fallback。
- [ ] TUI remote prompt/status/snapshot,driver/observer/reconnect fencing 完整。
- [ ] security/worktree/session 全链路 E2E。
- [ ] Runtime live/replay projection 与真实 adapter receipts 一致。
- [ ] durable Host command intent/receipt、response-loss、uncertain 与 subscription resync 有联合证据。
- [ ] 文档、AGENTS.md、README 与实际状态同步。

### M6：下游与企业扩展

- [ ] Artifact/Verification/Multi-Agent/Control Plane 只通过本计划实现的 ports 使用 workspace/security 能力。
- [ ] managed policy、tenant/RBAC、credential 与 remote/CI executor 只有在 Phase 8 联合 E2E 后才标记可用。

## 10. 完成标准

只有同时满足以下条件，才能把本计划标记 completed：

- [ ] M0–M6 均有对应 commit、测试和联合门禁证据；只完成本地 M1–M5 时只能标记 local baseline complete。
- [ ] Worktree、permission、approval、sandbox 在类型、配置、UI 和文档中没有混用。
- [ ] 模型可调用的生产工具不存在 raw fs/spawn/fetch 旁路。
- [ ] process/PTY/output/recovery 生命周期只由 Runtime Host 拥有,本计划只提供真实 restrictive decision/receipt 与受限 adapters。
- [ ] 默认配置在交互编码中是 workspace-write + on-request + network deny。
- [ ] approvalPolicy=never 不会扩大权限。
- [ ] restrictive sandbox unavailable 时不静默降级。
- [ ] session 的 RepositoryRef/sourceSubdir/WorkspaceRef/worktreeId/baseCommit 可审计并可恢复；绝对 locator 只在 private store/进程内。
- [ ] worktree 删除只作用于验证过的 managed target，dirty/active 默认拒绝。
- [ ] workspace/permission/sandbox 事件符合 Runtime schema，并可从 Host-owned canonical records 顺序重放为一致 projection。
- [ ] 标准 CLI/TUI 只通过 authenticated Host；observer 不能 mutation,所有 mutation 绑定 Host/session generation、driver revision、expected domain revision 与 durable command receipt。
- [ ] security/worktree/settings/registry/grants/staging 只写 canonical `runledgerHome`,不写 `<cwd>/.runledger/`、`~/.runledger/agent/` 或任意 sessionDir。
- [ ] Runtime contract 与本计划实现之间只有单向 import 和 port adapter，没有重复公共类型或反向依赖。
- [ ] 共享 runtime/session/storage/CLI/TUI 文件只在记录过的串行集成窗口修改。
- [ ] 安全配置解析失败不会回退到空配置、builtin-none 或 client-local policy。
- [ ] Linux 强隔离 E2E 通过；其他平台只声明真实验证过的能力。
- [ ] npm run check、npm test、npm run build、git diff --check 全绿。
- [ ] README、AGENTS.md、CLI help 与实现一致。

## 11. 明确不接受的捷径

- 只在 TUI 弹一个确认框，但工具仍能绕过 ExecutionGateway/Host final leaf。
- 用 isDestructive 单布尔值代替 capability resolution。
- 把 worktree 当 sandbox，或把 sandbox 当用户授权。
- 在 bwrap/sandbox-exec 不可用时自动改用 raw bash。
- 只用 startsWith 检查路径，不处理 canonical path 与 symlink。
- 只检查 shell 第一段，允许 ls && rm 一类链式绕过。
- 把 approvalPolicy=never 解释为 allow all。
- 安全 JSON 损坏时沿用 settings-manager 的“回退空对象继续”逻辑。
- 把 .git、.runledger、credential/registry 暴露为普通 workspace write。
- 让 CLI/TUI client 自己创建 controller、持 session lock、解析不同 security config 或管理 process。
- 在 security/worktree 内复制 Runtime Host process manager、PTY、private output、recovery 或 shutdown lifecycle。
- 把 repo `.runledger`、旧 `~/.runledger/agent`、`RUNLEDGER_SESSION_DIR` 或 `--session-dir` 恢复为安全状态写入 authority。
- 对任意用户路径执行 rm -rf 或 git worktree remove --force。
- 第一版就引入 fast-worktree/pool/auto classifier，掩盖基本安全闭环未完成。

## 12. 执行起点

后续用户明确要求“开始实现”时，先复核 Phase 0 已有 contract/boundary evidence 与 `runtime/05` 最新 Host handoff,不直接跳到 CLI/TUI 或平台 backend。若 Phase 0 证据仍适用于当前 HEAD,从首个未完成行为阶段继续；不得重建已经冻结的公共 contract。

1. 确认 Runtime Workspace/Security 契约域的 contract commit、exact schema 与 fixtures；
2. 仅在 `src/security/**` 与 `src/worktree/**` 定义实现内部类型和 adapter conformance tests；
3. 当前边界与 fail-closed 回归测试；
4. 精确 legacy bypass allowlist以及“禁止第二 process owner/client direct controller”的 Host 边界检查；
5. npm run check 静态边界与“禁止重复 Runtime 公共类型”门禁。

Phase 0 复核通过后,进入首个未完成的 Permission/Sandbox/Workspace 行为阶段。Phase 1–4 只推进独占目录；完成后才预约 Phase 5 Host 串行集成窗口。这样每一阶段都有可执行门禁,也能在不破坏现有 Host/CLI、不给并行计划制造文件冲突的前提下把 builtin-none profile替换为可选择且真实生效的 restrictive adapters。
