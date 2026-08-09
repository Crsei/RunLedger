# RunLedger Plugin / MCP / Skill / Hooks 实施计划

> 文档状态: M1–M5 的多项行为实现与 Session-scoped Skill/Hook/MCP/Plugin production composition 已落地；各里程碑仍以本文逐项复选框为准，M6 的完整 CLI mutation surface、TUI 写操作、trust/reload 与最终联合验收仍是部分完成（单一权威计划）<br>
> 编写日期:2026-07-21;Runtime Host 适配校准:2026-08-04<br>
> RunLedger 基线:`1658fe26fc675cc18498bb8c6a9f162b7a0b733f` (`feat/agent-loop-resurrect`)<br>
> Codex 参考基线:`0b175e6439a8608ba7726ee153fd8590619e8f34` (`main`)<br>
> grok-build 参考基线:`c68e39f60462f28d9be5e683d9cbe2c57b1a5027` (`main`)

## 0. 输入状态与使用方式

本计划的目标目录已经存在 `00-reference.md`，但在本次审阅时该文件为 **0 字节空文件**。该文件仍保留不动。[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md) 是公共 contract 与 canonical `runledgerHome` 的权威入口；[`../runtime/05-multi-client-background-terminal-refactor-plan.md`](../runtime/05-multi-client-background-terminal-refactor-plan.md) 是当前已实现的 machine/workspace Host 基线，仅作为迁移输入；替代实施权威是 [`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md)，Extension/MCP/Hook/Skill 最终由每个 owned SessionRuntime 自己装配，无 shared broker。本文件继续结合 Codex、grok-build、RunLedger 当前实现和根目录 `AGENTS.md` 形成扩展侧唯一实施账本。

### 0.0.1 2026-08-04 历史实现切片证据

以下记录 2026-08-04 当时的独占目录切片；它不是 2026-08-06 当前状态。复选框约定：`[x]` 表示当前切片有直接实现与测试，`[~]` 表示部分实现或仍缺生产接线，`[ ]` 表示尚未实现；不把 adapter/fake port 测试误报为 Host 生产闭环：

- M1 foundation 已有 `src/extensions/{identity,paths,config-layers,state-store,storage-port,snapshot,diagnostics}.ts` 与 trust 目录，覆盖 canonical locator、bounded digest、0600 state/trust、trust stale/revocation 和 last-known-good snapshot；既有 Extension foundation/skills focused tests 通过。
- M2 Skill 已有 bounded discovery、frontmatter、qualified identity、catalog/renderer、digest/trust 复核和按需正文 resolver；正文读取不授予脚本执行权限。
- M3 新增 `src/extensions/hooks/{types,parser,matcher,pipeline}.ts`：五个当前事件、exact descriptor、matcher 稳定排序、open/closed failure mode、deny、`updatedInput` revalidation 标记、JSON stdout、输出上限、AbortSignal/timeout 与 digest diagnostics；使用注入式 fake runner，`tests/extensions/hooks.test.ts` 为 12 tests。
- M4 新增 `src/extensions/mcp/{types,connection-manager}.ts`：trusted gate、server state、工具 enabled/disabled 过滤、runtime name/annotation、bounded result normalization、authorization port、timeout/close；`tests/extensions/mcp.test.ts` 为 4 tests。
- 新增 `src/extensions/integration/{runtime-resource-adapter,runtime-audit-adapter,runtime-hook-adapter,runtime-mcp-adapter,runtime-skill-adapter}.ts`：统一 snapshot/identity/input digest revalidation、Runtime resource port gate、bounded result、digest-only audit 与 unknown effect/denial fail-closed；`tests/extensions/integration/adapters.test.ts` 为 4 tests。
- Extension 定向回归为 6 files / 34 tests；当前没有官方 MCP SDK、真实 stdio/HTTP client、PluginManager、Host event sink、Gateway production composition 或 CLI/TUI lifecycle，因此 M4 仅为 adapter slice，M5/M6 不能标完成。
- 阶段提交证据：`b2bf04e`（`feat(extensions): gate resource adapters before host execution`），只包含 `src/extensions/**` 与 `tests/extensions/**`；提交前 `git diff --cached --check` 通过。
- 本地验证证据：`npm run check`、`npm test`（Vitest 144 files / 746 tests，Bun TUI 5 files / 44 assertions）、`npm run build`、`git diff --check` 均通过；该提交已落在当前分支，尚未 push。

仍未实现或未接线：Host-managed hook runner/真实进程、MCP official SDK transport/client/doctor/restart、Plugin manifest/manager/组合闭环、canonical event sink、Host Control Plane、CLI/TUI inspect/reload/trust/enable 以及 plugin fixture E2E。故不得把当前局部行为标为 M0–M6 完成。

### 0.0.2 2026-08-06 当前状态校正

- Runtime Resource contract 初始冻结来自 `65f9054`，统一 adapter port 收口来自 `54bd16e`；当前 public export 为 `src/runtime/contracts/ports.ts`、`src/runtime/resources/ports.ts` 与 `src/runtime/contracts/public.ts`。
- Resource port 只有 `resource_catalog`、`resource_snapshot`、`resource_invocation` 三个；`tests/runtime-contracts/adapter-port-contracts.test.ts` 明确拒绝旧 `RuntimeResourceSnapshotProvider` 与 `RuntimeResourceEventSink`。
- Host baseline/hardening handoff 为 `1352bfc`；后续 `6fc2c9a`、`a7ace24`、`402ab9b`、`8930db5`、`c86d078`、`2c55881`、`5760cde`、`e12eb3e` 已分别接入受管 MCP/Hook、resident snapshot、Host Gateway、canonical event writer 与真实 Skill catalog。
- 官方 MCP SDK 已由 `3172336` 固定为 `@modelcontextprotocol/sdk@1.30.0`；`PluginManager`、`ExtensionHostManager`、`McpConnectionManager`、Host extension/MCP domain ports 与 `/mcp`、`/plugins`、`/skills`、`/hooks` 只读 TUI selector 均已存在。
- 仍不得宣称 M6 全部完成：完整 CLI inspect/trust/plugin/skill/hook/mcp 子命令矩阵、TUI trust/enable/reload 写操作与最终 fixture 联合验收尚未由本计划逐项关闭。

### 0.0.3 2026-08-09 Session composition 校正

- `src/runtime/session-runtime/extension-composition.ts` 已替代 resident Host 作为标准 CLI 的 production 组合根。每个 owned Session 独立创建 Extension/Plugin manager、Skill resolver、Hook turn lifecycle 与 MCP connections，并把只读 `extension.inspect`、`plugin.list`、`skill.list`、`hook.list`、`mcp.list|doctor` 加入该 Session 的冻结 operation manifest。
- required MCP startup failure 在 activate 前 fail closed 并释放 owner；optional failure 写 canonical Session audit 后允许启动。`mcp_call` 与 Hook managed process 在外部接触前经过 recovery barrier，Skill 读取重验 trust/digest/`allowedTools`；关闭顺序先 external lifecycle/cleanup，再 checkpoint/release。
- production tests 直接覆盖双 Session workspace MCP config/connection 隔离、required/optional 语义、transport cleanup、barrier denial 与 shutdown ordering。中立 manager 位于 `src/extensions/manager.ts`，`host-manager.ts` 只保留 R9 前兼容重导出。
- 这闭合 Runtime 06 R6 的 MCP/Hook/Skill/Plugin blocking gap，也使 M6 的 production Session composition 子集成立；不闭合本计划更宽的 CLI trust/enable/reload mutation、完整 Plugin fixture、OAuth、配置热更新、TUI 写操作或最终 E2E。因此 M6 与整份专项仍保持部分完成。

若后续向 `00-reference.md` 补入内容，实施前必须先做一次差异审阅：

1. 把新增约束映射到本计划的“固定决策、里程碑、验收矩阵、非目标”；
2. 如有冲突，先更新本文件，不在同目录新建第二份同主题实施计划；
3. 任何安全边界、配置格式或生命周期变更都必须先形成明确的兼容策略。

本文件是后续 Plugin / MCP / Skill / Hooks 工作的执行状态账本。实施时只在本文件的复选框上更新状态；专题设计可以作为附录增加，但不得另建平行的总计划。

### 0.1 与 Runtime contract 计划的依赖和所有权

两份计划采用“Runtime 产出中立契约，Extension 实现具体能力”的单向依赖。Runtime 只定义 `src/runtime/resources/{types,schemas,ports,events}.ts`；本计划负责发现、配置、信任、进程、生命周期、审计投影和用户控制面，不在 `src/runtime/resources/` 中实现任何 extension manager/loader/client/runner。

Capability/approval/sandbox 的行为实现来自 [`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)。本计划只生成资源 descriptor 与 raw invocation、消费 `ExecutionGateway`/受限 executor,不实现第二套 PermissionEngine、ApprovalCoordinator、Credential Broker 或平台 sandbox。

生产 owner 固定为 Runtime Host:Host 持有 `ExtensionManager`、不可变 snapshot、MCP/hook 受管进程、canonical event writer 和 reload/approval waiter;CLI/TUI 只通过 authenticated command/query/subscription 使用这些能力。任何 trust/enable/reload/invoke mutation 都必须带 Host/session generation、driver revision（如为 session mutation）、expected resource revision、command ID 与 request digest,并遵守 durable intent/receipt 与 `uncertain_outcome` 语义。不得在 client 中重新装配 manager、启动 MCP/hook 子进程或提供 direct-controller fallback。

下文“Runtime Capability 契约域”和“Runtime Resource 契约域”分别指 [`04` 的 Workspace/Security contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-workspace-security) 与 [Resource contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-resources)。两者必须先冻结以下 public contract,本计划 M0 才能标记完成:

- `ResourceKind`、`ResourceIdentity`、`ResourceProvenance`、`ResourceManifestDigest`。
- `ResourceTrustState`、`ResourceActivationState`、`ResourceApprovalReceipt`。
- Runtime Capability 契约域的 `CapabilityClaim` 与 Runtime Resource 契约域的 `RuntimeToolDescriptor`、`RuntimeToolInvocation`、`RuntimeToolResult`。
- `RuntimeResourceSnapshot`、`ResourceLifecycleEvent` 及 TypeBox schemas。
- `RuntimeResourceCatalogPort`、`RuntimeResourceSnapshotPort`、`RuntimeResourceInvocationPort`；对应 port name 严格为 `resource_catalog`、`resource_snapshot`、`resource_invocation`。

Extension 侧映射固定为:

| Extension 事实 | Runtime 投影 | 约束 |
|---|---|---|
| Plugin/Skill/Hook/MCP qualified identity 与来源 | `ResourceIdentity` + `ResourceProvenance` | display name 不得参与执行路由 |
| root/config/command/assets 联合 digest | `ResourceManifestDigest` | 任一内容变化生成新 identity binding |
| enable/trust/stale/revoked/ready/error | trust + activation state | enable 不能替代 trust,ready 不能替代 approval |
| `TrustRecord` | `ResourceApprovalReceipt` | 绑定 principal、scope、expiry、revocation revision、capability digest |
| `ExtensionSnapshot` | `RuntimeResourceSnapshot` | 仅描述符与 diagnostics,不得包含进程/client/函数 |
| MCP tool/Hook/Skill script 调用 | descriptor + raw invocation | 最终 claims 由 Runtime contract + 安全专项实现基于 canonical input 推导,Extension 不能少报或自批 |
| extension 领域审计 | `ResourceLifecycleEvent`/current event payload | 不自造第二条 hash chain,不在 replay 时重放副作用 |

### 0.2 平行开发不冲突规则

| 并行泳道 | 独占路径 | 禁止事项 | 交付门 |
|---|---|---|---|
| Runtime contract | `src/runtime/resources/**`、`tests/runtime-contracts/resource-contracts/**` | 不写 `src/extensions/**`,不实现具体资源 | contract version、exports、fixtures 冻结 |
| Extension domain | `src/extensions/**`、`tests/extensions/**`、`tests/fixtures/extensions/**` | 不修改 Runtime 内部类型/loop/registry | M1–M5 通过 adapter contract tests |
| 串行 integration | Host resident composition/Control Plane、storage/runtime/CLI/TUI/shared package 文件 | 不与 Runtime Host 线并发修改 | Runtime contract + Host handoff commit 已记录,逐路径集成并全量验证 |

具体规则:

1. M1–M5 期间只在 `src/extensions/**` 实现,所有 Runtime 接入先落在 `src/extensions/integration/**` adapter,不得复制 Runtime 类型作为临时双真源。
2. `src/runtime/{agent-loop,types,tool-registry,tool-authorization,interactive-session-controller}.ts` 以及 Host resident-session/composition/Control Plane 是 Runtime、Worktree/Sandbox/Permission 与其他专项共用的串行集成面。本计划仅在获分配的 M6 集成窗口修改,开始前记录所有前置 contract/Host/implementation/handoff commit。
3. `package.json`、`package-lock.json` 属于 M0 串行依赖面:Runtime 线先交出当前 dependency HEAD,Extension 线用一个独立提交加入 YAML/semver/MCP SDK 精确版本,随后双方都以该提交为基线。`src/storage/{paths,settings-manager}.ts`、Host composition、`src/cli/**`、`src/tui/**`、`src/index.ts` 属于 M6 串行集成面。
4. Runtime 契约不足时,Extension 线提交需求和 failing contract fixture,由 Runtime 线版本化升级契约;Extension 不直接改 `src/runtime/resources/**`。
5. Runtime 或其他专项后续要修改已集成的共享文件时,必须以 M6 集成 commit 为新基线。各线不得在长期分支分别重写同一 composition root。

## 1. 目标

在 RunLedger 中建立一套最小但可扩展的扩展运行时，使以下能力真正贯通：

- Skill:从用户、项目与已启用插件发现 `SKILL.md`，只把有界元数据放进模型上下文，按需加载完整指令；
- Hooks:在 session、prompt 和 tool 生命周期执行受信任的外部 hook，并把决定、耗时和失败完整写入 ledger；
- MCP:管理 stdio 与 Streamable HTTP 客户端，把远端工具安全映射为 `AgentTool`，支持超时、中断、审批、结果预算和进程清理；
- Plugin:以声明式 manifest 打包 Skill、Hooks 和 MCP 配置，不允许插件直接把任意 JavaScript 导入 RunLedger 进程；
- Control plane:提供统一的发现、诊断、启用、信任、重载、CLI/TUI 展示和审计快照。

最终用户路径应成立：

```text
发现资源
  -> 校验与来源归一化
  -> 启用状态过滤
  -> 信任门禁
  -> 构造不可变 ExtensionSnapshot
  -> 注入 Agent / ToolRegistry / TUI
  -> 每次调用写入 ledger
  -> idle 边界原子重载或退出时统一释放
```

## 2. 当前基线与缺口

### 2.1 已有可复用切点

| 当前能力 | 现有文件 | 本计划中的用途 |
|---|---|---|
| canonical `RunledgerLayout`、用户 settings 与 workspace-key settings | `src/storage/{runledger-home,settings-manager}.ts` 与 Runtime storage-layout contract | 所有 RunLedger 自有状态写入单一 `runledgerHome`;repo 内容只可作为外部、默认不可信 discovery input |
| 用户/workspace settings 清洗与 0600 写入 | `src/storage/settings-manager.ts` | 扩展启用配置使用 canonical user/workspace authority,不写项目 `.runledger/` |
| 多 namespace 工具注册 | `src/runtime/tool-registry.ts` | 承载 stdlib、MCP catalog 工具及来源元数据 |
| tool 前置授权切点 | `src/runtime/tool-authorization.ts`、`agent-loop.ts` | 接入 PreToolUse + 授权策略组合链 |
| `beforeToolCall` / `afterToolCall` | `src/runtime/types.ts`、`agent-loop.ts` | Hooks 的第一批运行时挂点 |
| Runtime Host managed process + `AbortSignal` | `src/runtime/{host,process}/**`、Host process facade | hook/MCP process 必须由 Host 创建、停止、恢复和审计,不得自持 raw child handle |
| canonical Runtime event sink | Runtime Event contract 与 Host-owned writer | 扩展快照、hook/MCP/skill 运行审计的唯一 durable truth |
| Host-owned resident controller + remote CLI/TUI facade | `src/runtime/host/**`、`src/cli/runtime-host-*.ts` | Host 装配 ExtensionManager 和资源快照,client 只 query/subscribe/command |
| `/mcp` 占位与资源计数条 | `src/tui/interactive-mode.ts`、`components/mcp-server-selector.ts`、`loaded-resources.ts` | 后期控制面展示 |
| `Skill` 占位工具 | `src/runtime/tools/skill.ts` | 改造成真实 catalog 读取工具，不再使用 handler map |

### 2.2 必须先修正的结构性缺口

- canonical settings 只接受已声明字段；扩展配置必须在 user/workspace authority 中拥有 exact schema,不能退回 repo `.runledger/` 或未知字段旁路；
- `ToolRegistry` 当前跨 namespace 扁平化后仍可能出现同名工具，agent-loop 又按 `name` 首个匹配，不能静默承载 MCP 冲突；
- 生产 controller 明确排除了 `Skill`，系统提示中也没有 skill catalog；
- `/mcp` 只有空列表，没有连接管理器、状态机或关闭路径；
- trust 只证明资源身份/内容,不能替代 Runtime Gateway 的逐调用 Permission/Approval/Sandbox/decision receipt；
- `beforeToolCall` 异常会被当作 block，但没有可配置 failure mode，也不能返回修改后的 tool input；
- Runtime contract 已要求 exact resource lifecycle payload、bounds 与 redaction；本计划不得再以 `custom` ledger 作为 fallback 或第二真源；
- CLI 只有扁平 flags，尚无 `plugin` / `mcp` / `skill` / `hook` 子命令；
- 没有统一诊断对象时,加载器若直接写 stderr，Host query、TUI、CLI JSON 输出和 canonical event projection 将无法复用同一事实。

## 3. 参考实现结论

### 3.1 对照表

| 主题 | Codex 当前实现 | grok-build 当前实现 | RunLedger 采用 |
|---|---|---|---|
| Plugin manifest | `.codex-plugin/plugin.json`，manifest 声明 skills/hooks/MCP/apps，路径必须留在插件根内 | 根 `plugin.json`，兼容 `.grok-plugin/` / `.claude-plugin/`，无 manifest 时支持约定目录 | 只认 `.runledger-plugin/plugin.json`；按当前 exact schema 解析；不做无 manifest 猜测 |
| Plugin 边界 | plugin 是资源包，资源由 skill/hook/MCP 子系统消费 | skills 可见与代码执行信任分离，hooks/MCP/LSP 受 trust gate | plugin 只打包声明式资源，不允许进程内 JS/TS 插件入口 |
| Plugin 安装 | marketplace、版本化 store、启用状态和策略独立 | 用户/项目/CLI 多 scope，install/update/uninstall 与 trust 分离 | MVP 先做本地发现/启停/信任；版本化安装和 marketplace 后置 |
| Skill 发现 | 分层 root、插件 namespace、扫描深度/条目/并发上限、错误与结果分离 | cwd 到 repo root、多供应商兼容、同名 qualified name、动态重载 | 用户 + 项目祖先链 + plugin；保留 qualified identity；扫描与上下文都设硬上限 |
| Skill 注入 | 元数据有预算，显式命中后读取完整 `SKILL.md`，支持 path 精确身份 | `/skill` 与自动匹配共存，插件 skill 保留来源 | system prompt 只放有界 catalog；真实 `Skill` 工具/斜杠命令按需读取完整正文 |
| MCP transport | stdio + Streamable HTTP、OAuth、required、startup/tool timeout、tool allow/deny | stdio + HTTP/SSE、per-tool timeout、doctor、热刷新与自动重启 | MVP stdio + Streamable HTTP；required、超时、allow/deny、取消、doctor；SSE/OAuth 后置 |
| MCP manager | 聚合 client、tool/resource/template、来源、启动事件与 required 失败 | server 状态、liveness、重启、工具结果 spill、`search_tool/use_tool` | 独立 ConnectionManager + Catalog；先用 `McpSearch`/`McpCall` 有界暴露，允许显式 pin 直连工具 |
| MCP 工具命名 | 可选前缀并保存 plugin provenance | `<server>__<tool>`，元工具延迟发现 | LLM 名固定 `mcp__<server>__<tool>`；raw server/tool 名单独保存，不以显示名做路由 |
| Hooks 事件 | 11 类事件、command runner、schema 化 stdin/stdout、输出 spill、持久 hook key | command/HTTP、按声明顺序串行、PreToolUse 显式 deny 才阻断、其他失败 fail-open | MVP 只做当前 runtime 可触发的 5 类；阻断事件 failure mode 默认 closed，观察事件默认 open |
| Hooks 信任 | 配置层规则 + handler hash/trust state | 项目/插件执行面显式 trust，用户级默认信任 | 中央信任库使用 canonical path + 内容摘要；内容变化使 trust 变 stale |
| 可观测性 | 启动 warning、hook/MCP status、结构化事件 | modal、scrollback annotation、doctor/inspect JSON | Diagnostic[] 是唯一事实源；CLI、TUI、ledger 都从同一 snapshot 投影 |

### 3.2 不直接照搬的部分

- 不移植 Rust crate 边界；RunLedger 使用 TypeScript 模块和显式接口实现同等职责；
- 不在 MVP 扫描 `.claude`、`.cursor`、`.agents`、`.grok` 等兼容目录，避免在协议稳定前扩大攻击面；
- 不支持插件内任意代码模块、agent 定义、LSP、apps 或动态 Node import；
- 不以路径被用户拥有作为永久信任依据；项目与插件执行面必须留下可审计 trust record；
- 不让 MCP 工具数量线性膨胀 system prompt；默认通过 catalog/meta-tool 渐进披露；
- 不把 hook 失败语义写死为全局 fail-open 或全局 fail-closed，而按事件类型和显式配置决定；
- 不在配置值中支持 `$(command)`；继续复用 `resolve-config-value.ts` 的 `${ENV_VAR}` 模板边界。

## 4. 固定架构决策

以下决策在实施开始后视为契约。改变其中任一项时，必须先更新本计划及对应 schema 测试。

### 4.1 一个控制面，四个独立数据面

新增 `ExtensionManager` 作为唯一装配入口，但 Plugin、Skill、Hooks、MCP 各自拥有解析器、catalog 和生命周期：

```text
ExtensionManager
├── TrustStore
├── PluginManager ──只解析/归一化资源贡献──┐
├── SkillCatalog <──────────────────────────┤
├── HookRegistry <──────────────────────────┤
└── McpConnectionManager <──────────────────┘
```

PluginManager 不直接启动 MCP、不执行 hook、不读取完整 skill 正文。它只输出带来源和 trust state 的资源描述符，由各子系统再次校验。

### 4.2 不可变快照与 idle 原子重载

每次启动或显式 reload 生成一个 `ExtensionSnapshot`：

```ts
interface ExtensionSnapshot {
  id: string;
  createdAt: number;
  digest: string;
  plugins: readonly PluginDescriptor[];
  skills: readonly SkillDescriptor[];
  hooks: readonly HookDescriptor[];
  mcpServers: readonly McpServerDescriptor[];
  diagnostics: readonly ExtensionDiagnostic[];
}
```

- 一个 turn 开始后固定使用同一 snapshot；
- reload 只由 Host command 接受,在 resident Agent idle 时交换 snapshot；运行中请求只标记 pending；
- 新 snapshot 构建失败时保留 last-known-good，失败以 diagnostics 暴露；
- 旧 MCP clients 只有在新 snapshot 成功生效后才关闭，避免半加载状态；
- session resume 由 Host 从 canonical config/state 重新构造资源，不从旧 event/ledger 恢复可执行对象；snapshot generation、config/profile digest 进入 Host compatibility 与 resource revision。

### 4.3 启用与信任严格分离

- `enabled=false`:发现但不进入运行时；
- `enabled=true, trust=untrusted/stale`:显示 metadata 和诊断，但不得读取完整 prompt、执行 hook 或启动 MCP；
- `enabled=true, trust=trusted`:按组件策略激活；
- 用户目录资源可以通过一次初始化策略授予 trust，但仍产生显式 trust record；
- 项目/插件执行面绝不因“位于当前 cwd”自动信任；
- trust key 至少包含 exact identity、canonical root、manifest/config/command/assets digest 与 capability digest，symlink 解析失败一律 untrusted；
- manifest、hook 文件、MCP command/url 或可执行脚本内容变化后，旧 trust 变为 `stale`。
- 每条 `TrustRecord` 必须可无损投影为 Runtime `ResourceApprovalReceipt`,并绑定 resource identity、manifest/config/command/assets digest、capability digest、principal、scope、expiry 与 revocation revision；缺失任一绑定字段时只能视为 untrusted。
- trust 只批准该精确资源身份和声明能力，不授予未来版本、同名资源、整个仓库或 publisher 的无限权限；实际调用仍逐次经过 Runtime Capability Gateway。

默认激活策略：

| 来源 | 初始 enabled | 初始 trust | 实际行为 |
|---|---:|---|---|
| 内置资源 | true | trusted | 直接按内置策略加载 |
| 用户层独立 Skill/Hook/MCP | true | 首次初始化生成显式 trust record | record 缺失/过期时只发现不执行 |
| 项目层独立 Skill/Hook/MCP | 服从资源配置，缺省 true | untrusted | 用户逐资源 grant 后激活 |
| 用户层 Plugin | false | untrusted | 必须分别 enable 与 trust |
| 项目层 Plugin | false | untrusted | 必须分别 enable 与 trust |

trust 粒度固定为资源级：Plugin 使用 plugin root digest；独立 Skill 使用 skill root digest；独立 Hook 使用配置与其引用命令的联合 digest；独立 MCP 使用归一化配置、解析后的 executable/URL 身份联合 digest。MVP 不提供“一次信任整个仓库全部未来代码”的宽泛开关。

### 4.4 名称、身份和来源不可混用

每项资源同时保存：

- `id`:稳定、可持久化的 qualified identity；
- `displayName`:TUI 展示；
- `runtimeName`:给模型/agent-loop 的无冲突名称；
- `source`:system/user/project/plugin/session；
- `sourcePath`、`pluginId?`、`digest`；
- `enabled`、`trustState`、`diagnostics`。

规则：

- 每个 discovery root 先生成稳定 `sourceKey = <scope>:<canonical-path-short-hash>`；
- Plugin ID:`plugin:<sourceKey>:<name>`；
- Skill ID:`skill:<sourceKey-or-plugin-id>:<name>`；同名时必须允许 qualified 选择；
- MCP server ID:`mcp-server:<sourceKey-or-plugin-id>:<name>`；
- MCP tool runtime name:`mcp__<sanitized-server>__<sanitized-tool>`；
- Hook ID:`hook:<source-id>:<event>:<declared-id-or-index>`；
- sanitization 发生冲突时不自动覆盖，相关项进入 error diagnostic；
- canonical Runtime event 永远写 raw identity + runtime name，不能只写经过截断的显示名。
- 所有 resolve/activate/invoke API 只接受 qualified identity 或从当前 immutable snapshot 返回的 opaque handle；模型生成的包名、仓库名、Skill 名或 Marketplace locator 不能触发猜测、安装或 fallback 搜索。

### 4.5 安全默认值

- manifest 和配置只允许声明式 JSON/YAML/Markdown，不执行解析期代码；
- plugin path、skill reference、hook command path 和 MCP cwd 都做 realpath containment 检查；
- hook 只声明 `command + args`，MVP 不接受隐式 shell string；实际执行提交给 Host-owned managed process facade,Extension runner 不直接 spawn；
- canonical user/workspace 配置中的 secret 只能经 `${ENV_VAR}` / `bearerTokenEnvVar` 引用；repo discovery input 不能成为 secret authority；
- secret 原值不得进入 diagnostic、canonical event、Artifact metadata、TUI、错误文本或 tool result；
- MCP 和 hook 子进程必须继承 AbortSignal；timeout/stop/shutdown 由 Host manager 按 wait -> SIGTERM -> wait -> SIGKILL -> final wait 和 global deadline 执行。实际 spawn/network 只能使用 Runtime Gateway decision/receipt 与 Host-owned facade,不得直接持有全局 `process`/`fetch`/裸 `ExecutionEnv`；
- MCP tool、Hook handler、Skill script 仍经过统一 Capability Gateway，不能因来自受信任 plugin、正文已读或 hook failure mode 为 open 而绕过审批；
- Extension 只提交 raw input 和受信 descriptor。canonical arguments、path/host/process/credential 语义及最终 `CapabilityClaim[]` 由 Runtime 推导；updated hook input 必须重新 schema 校验、重新 canonicalize 并重新授权；
- Skill metadata catalog、完整 `SKILL.md`、assets/references 读取和 scripts 执行是四个独立能力层；“文档可读”永远不表示“脚本可执行”；
- repo 内 `.runledger/mcp.json` 或其他 Plugin/Hook/Skill 文件只能作为外部 discovery input 且默认 untrusted,不得成为 RunLedger 自有配置/状态写入位置；文件位于 Git 仓库、由同一用户拥有或曾在旧 snapshot 中可用都不能自动批准；
- PreToolUse 的默认失败策略为 `closed`，UserPromptSubmit 的默认失败策略为 `closed`，其他观察型事件默认 `open`；
- 使用者可在受信任的用户层配置中逐 hook 改 failure mode，项目/plugin 自身不能把 `closed` 降为 `open`；
- 所有文本/JSON 输入输出均有字节上限；超额正文进入 Host private durable output 或经策略授权写 Artifact CAS,模型只收到有界预览/ref/digest,不得收到物理 spill 路径。

## 5. 文件布局与配置契约

### 5.1 资源位置

```text
<runledgerHome>/
├── settings.json
├── projects/<workspace-key>/settings.json
├── state/extensions/
│   ├── extensions-state.json       # 启用/禁用，不保存 secret
│   ├── trust.json                  # 0600，exact identity + digest
│   ├── user/
│   │   ├── mcp.json
│   │   ├── hooks/*.json
│   │   ├── skills/<skill-name>/SKILL.md
│   │   └── plugins/<plugin-name>/...
│   ├── workspaces/<workspace-key>/ # workspace canonical config/state
│   │   ├── mcp.json
│   │   ├── hooks/*.json
│   │   ├── skills/<skill-name>/SKILL.md
│   │   └── plugins/<plugin-name>/...
│   └── plugin-data/<encoded-plugin-id>/
├── projections/extensions/...     # 可重建 catalog/status/diagnostic
├── cache/extensions/...           # 可删除重建 discovery cache
└── tmp/...                        # 根内 staging/atomic temp

<workspace repo or explicitly selected external root>/
└── .runledger/...                 # 可选只读 discovery input,默认 untrusted,绝不写回
```

`runledgerHome` 只由 composition root 解析一次。RunLedger 自有 enable/trust/config/state/plugin-data/cache/staging 只能写入上述 canonical 子树；不得写 `<cwd>/.runledger/`、`~/.runledger/agent/` 或由 `sessionDir` 指定的目录。repo/祖先资源若继续支持,必须作为显式、只读、默认不可信 discovery source；扫描有最大祖先层数,按 realpath 去重,且不能因发现它们而创建目录或状态文件。

### 5.2 层级与冲突

有效优先级从高到低：

1. 当前 session/CLI 显式资源；
2. canonical workspace config:`<runledgerHome>/state/extensions/workspaces/<workspace-key>/`；
3. 显式允许的 repo/祖先只读 discovery input（越深越高,始终保留 untrusted provenance）；
4. canonical user config:`<runledgerHome>/state/extensions/user/`；
5. 内置资源。

session/CLI 显式资源只作用于 Host request,不能形成第二个持久化 root；持久 mutation 仍写 canonical user/workspace state。任何层级冲突都按 exact identity 与 provenance 处理,不得以目录近似或 display name 猜测覆盖。

同一层内：直接声明资源优先于 plugin contribution；plugin 间不互相覆盖。冲突资源全部保留 qualified identity，但不创建含糊的 unqualified alias。

### 5.3 Plugin manifest

唯一入口:`<plugin-root>/.runledger-plugin/plugin.json`。

```json
{
  "name": "team-tools",
  "version": "1.0.0",
  "description": "Audited team workflows",
  "author": { "name": "Platform Team" },
  "keywords": ["review", "release"],
  "skills": ["./skills"],
  "hooks": ["./hooks/hooks.json"],
  "mcpServers": "./.mcp.json"
}
```

约束：

- `name`、`version`、`description` 必填；
- `name` 为 1–64 个小写字母、数字、连字符，不允许首尾连字符；
- `version` 必须为严格 semver；
- 所有路径必须以 `./` 开头，并在 realpath 后仍位于 plugin root；
- 不接受 inline hooks 或 inline MCP，确保每个执行配置有独立文件、hash 和诊断位置；
- 未知字段、缺失必需字段或结构不符合当前 schema 时产生 error 并禁用整个 plugin；
- 单个组件失败只禁用该组件；manifest 身份或路径逃逸失败禁用整个 plugin；
- plugin root 只读，运行数据写入 `plugin-data/<plugin-id>/`。

### 5.4 Skill

```markdown
---
name: review-release
description: Review a release candidate and produce an auditable readiness report.
user-invocable: true
disable-model-invocation: false
allowed-tools:
  - Read
  - grep
metadata:
  owner: platform
---

# Release review

...
```

约束：

- YAML 使用成熟解析库，不手写模糊 frontmatter parser；
- `name` 与 plugin 同一字符约束，`description` 必填且最多 1024 字符；
- `SKILL.md` 正文、引用文件和目录扫描均设上限；
- `allowed-tools` 只能缩小当前授权范围，绝不能扩大权限；
- catalog 注入只含 name、description、qualified name、source locator；
- 默认 catalog 预算为 8000 字符，并进一步受模型上下文 2% 上限约束；
- 显式 `$name`、`/skill name`、`/name` 和模型调用 `Skill` 最终走同一 resolver；
- 读取完整 skill 时校验 snapshot digest，防止发现与执行之间被替换；
- `scripts/`、`references/`、`assets/` 只是可寻址资源，不在加载时自动执行或批量注入。

### 5.5 Hooks

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "id": "deny-dangerous-bash",
        "matcher": "^Bash$",
        "failureMode": "closed",
        "handlers": [
          {
            "type": "command",
            "command": "./bin/guard.sh",
            "args": [],
            "timeoutMs": 5000,
            "env": {}
          }
        ]
      }
    ]
  }
}
```

MVP 事件：

| 事件 | 挂点 | 是否可阻断 | 默认失败策略 |
|---|---|---:|---|
| `SessionStart` | snapshot 生效、MCP ready 后，首个 prompt 前 | 否 | open |
| `UserPromptSubmit` | controller 接受用户文本后、写入 agent 前 | 是 | closed |
| `PreToolUse` | 参数 prepare/schema 校验后、授权策略前 | 是，可返回 `updatedInput` | closed |
| `PostToolUse` | 工具执行完成、结果写回模型前 | 否；可追加 `additionalContext` | open |
| `SessionEnd` | agent idle、MCP shutdown 前 | 否 | open |

统一 stdin envelope 包含 event、eventId、timestamp、sessionId、`WorkspaceRef`、root-relative cwd、snapshotId、source，以及事件专属 payload。tool input/result 超限时只传预览、digest、size、truncated 与受控 `ArtifactRef`/private-output ref,不传绝对 cwd 或物理 spill 路径。

阻断型 stdout：

```json
{
  "decision": "allow",
  "reason": "optional",
  "updatedInput": null,
  "additionalContext": null
}
```

规则：

- handler 按层级、文件 canonical path、声明顺序稳定串行；
- 第一条显式 deny 立即短路；
- `updatedInput` 只在 allow 时有效，之后重新跑工具 schema 校验；
- command 为相对路径时按 hook 文件目录解析并做 containment；
- runner 可注入 `RUNLEDGER_HOOK_EVENT`、`RUNLEDGER_HOOK_ID`、`RUNLEDGER_SESSION_ID` 和 Host 解析的私有执行路径；这些值只存在于受限子进程环境,不得进入 public event/receipt/diagnostic；
- plugin hook 所需 plugin root/data path 由 Host private execution descriptor 提供,保留键不可被配置覆盖；
- 非 0、timeout、spawn error、非法 JSON 都形成 `HookRunOutcome`，再按 effective failure mode 决定是否阻断；
- MVP 不支持 HTTP、prompt、agent、async hook；它们在 command runner 稳定后单独评审。

### 5.6 MCP

canonical user/workspace `mcp.json`、显式 repo discovery input 和 plugin `.mcp.json` 使用同一 exact schema；只有前两类 canonical home 文件拥有持久配置 authority,repo input 始终带 untrusted external provenance：

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": ["./server.js"],
      "cwd": ".",
      "env": { "TOKEN": "${FILESYSTEM_TOKEN}" },
      "enabled": true,
      "required": false,
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 120000,
      "toolTimeouts": { "slow_scan": 300000 },
      "enabledTools": ["read_file", "list_files"],
      "disabledTools": [],
      "supportsParallelToolCalls": false
    },
    "issues": {
      "transport": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ISSUES_MCP_TOKEN}" },
      "enabled": true
    }
  }
}
```

运行时结构：

```text
McpConnectionManager
├── McpClientFactory(stdio / streamable-http)
├── server state machine
├── McpToolCatalog
├── McpToolAdapter -> AgentTool
├── McpResultNormalizer(text/image/resource)
└── closeAll / restart / doctor
```

server 状态固定为：

```text
disabled -> blocked-untrusted -> starting -> ready
                                  ├── auth-required
                                  ├── failed
                                  └── stopping -> stopped
```

规则：

- 使用官方 TypeScript MCP SDK，实施时固定精确版本并审阅 `package-lock.json`；
- stdio 与 Streamable HTTP 为 MVP transport；SSE 和 OAuth 另设里程碑；
- server 启动可并发但必须有并发上限，状态事件按 server 独立写 canonical Runtime event sink；
- `required=true` 的 server 启动失败时禁止开始新 turn；optional server 失败只降级并显示 diagnostic；
- 每次 tool call 同时受 server timeout、per-tool timeout、session AbortSignal 约束；
- `enabledTools` 先过滤，`disabledTools` 后过滤；
- MCP tool annotations 映射为 `isReadOnly` / `isDestructive` / `isConcurrencySafe`，缺失时使用保守值；
- 默认只给模型暴露 `McpSearch` 与 `McpCall` 两个有界 meta-tools；用户显式 pin 的少量工具才作为直接 `AgentTool` 暴露；
- catalog search 返回 raw name、qualified name、description、input schema 摘要和来源，不能直接执行；
- `McpCall` 必须再次按稳定 server/tool identity 路由并经过 Runtime Capability Gateway；
- text/image/resource content 正确保留类型；未知 content 变成有界 JSON 文本，不使用 `any`；
- 单次结果复用 Host/tool-result budget、private output 与 Artifact policy,并额外记录原始字节数、截断状态和 content digest；
- client transport closed 时先移除旧 client identity，再决定受限重启；旧 client 的迟到事件不得关闭替代 client；
- SessionEnd 只请求 Host 按 residency policy 释放 session-scoped connection；client/TUI 退出只 detach,不得调用 `closeAll()` 或终止 Host-owned MCP/hook 进程。显式 disable/Host shutdown 才按 Host lifecycle 与 global deadline 停止资源,不得留下孤儿进程或后台重连任务。

## 6. 代码结构

计划新增：

```text
src/extensions/
├── types.ts
├── diagnostics.ts
├── config-layers.ts
├── snapshot.ts
├── extension-manager.ts
├── integration/
│   ├── runtime-resource-adapter.ts
│   ├── runtime-hook-adapter.ts
│   ├── runtime-audit-adapter.ts
│   └── composition-contributions.ts
├── trust/
│   ├── types.ts
│   ├── digest.ts
│   └── trust-store.ts
├── plugins/
│   ├── types.ts
│   ├── manifest.ts
│   ├── discovery.ts
│   ├── state-store.ts
│   └── plugin-manager.ts
├── skills/
│   ├── types.ts
│   ├── frontmatter.ts
│   ├── discovery.ts
│   ├── catalog.ts
│   ├── renderer.ts
│   └── skill-tool.ts
├── hooks/
│   ├── types.ts
│   ├── config.ts
│   ├── discovery.ts
│   ├── matcher.ts
│   ├── runner.ts
│   ├── dispatcher.ts
│   └── audit.ts
└── mcp/
    ├── types.ts
    ├── config.ts
    ├── client-factory.ts
    ├── connection-manager.ts
    ├── tool-catalog.ts
    ├── tool-adapter.ts
    ├── result-normalizer.ts
    └── audit.ts
```

计划修改（全部属于 M6 串行集成面,M1–M5 不得提前修改）：

| 文件 | 改动 |
|---|---|
| `src/storage/runledger-home.ts` 与 Runtime storage-layout contract | 注入 canonical `RunledgerLayout`;新增路径前先扩展受约束 locator contract,不从 cwd/环境重复解析 root |
| `src/storage/settings-manager.ts`、`src/storage/extensions/**` | canonical user/workspace settings、extension state/trust/plugin-data；repo discovery input 只读,大正文不塞 settings |
| `src/runtime/tool-registry.ts` | 仅通过冻结的 public API 注册 adapter tools；若 API 不足先走 Runtime contract 升级，不在集成提交塞入 extension 私有状态 |
| `src/runtime/types.ts` | `BeforeToolCallResult.updatedInput`、hook/authorization 组合结果 |
| `src/runtime/agent-loop.ts` | updated input 重校验、PostToolUse context、snapshotId 审计 |
| `src/runtime/tool-authorization.ts` | 把 extension descriptor/raw input 接到既有 Runtime Gateway；policy/claim 推导仍由 Runtime 拥有 |
| Host resident-session/composition、`src/runtime/interactive-session-controller.ts` | Host 持有 ExtensionManager，装配 skills/MCP/tools/hooks，idle reload；client 不直接装配 |
| `src/runtime/tools/skill.ts` | 删除 handler 占位语义，桥接真实 SkillCatalog |
| Host Control Plane、`src/cli/args.ts`、`main.ts` | 增 typed command/query/subscription；CLI 不启动/关闭扩展生命周期,只连接 Host |
| `src/tui/interactive-mode.ts` | `/plugins`、`/skills`、`/mcp`、`/hooks`、reload 和 trust/enable 的 remote facade |
| `src/tui/components/loaded-resources.ts` | 使用 snapshot 的 enabled/ready/error 计数，不只显示非零总数 |
| `src/index.ts`、`package.json` | M6 导出公共类型/必要子路径 exports；运行依赖版本由 M0 串行 dependency commit 先行落地 |

M1–M5 的实现必须通过 dependency injection 和 fake Runtime ports 独立测试。M6 开始前执行人需要在本文件记录 Runtime contract commit、`runtime/05` Host handoff commit、当前共享文件 HEAD 和 Extension domain commit；任一共享文件在 handoff 后又发生变化时先 rebase/重审,不得靠自动冲突选择合并。

## 7. 审计模型

扩展审计只经 `runtime-audit-adapter.ts` 投影为 Runtime `ResourceLifecycleEvent` 或对应 exact typed event payload；durable truth 只允许由 Host-owned Runtime event sink 持有。禁止 `LedgerEntry.type = "custom"` fallback、Extension 私有 hash chain或 event/ledger dual-write。

| `payload.kind` | 写入时机 | 必需字段 |
|---|---|---|
| `extensions.snapshot` | 启动和成功 reload | snapshotId、digest、各类资源数量、diagnostic 摘要 |
| `plugin.state` | enable/disable/trust/stale | pluginId、source、oldState、newState、digest |
| `skill.invocation` | 完整正文被读取 | skillId、source、digest、trigger、argument 摘要 |
| `hook.run` | 每个 handler 结束 | hookId、eventId、decision、failureMode、durationMs、exit/timeout、输入输出 hash |
| `mcp.server` | server 状态变化 | serverId、transport、oldState、newState、reason、durationMs |
| `mcp.tool` | MCP 调用结束 | serverId、toolName、runtimeName、toolCallId、durationMs、resultSize、isError |

审计规则：

- 不写 auth header、token、完整进程 env 或 OAuth credential；
- 原始 tool/hook payload 超限后进入 Host private output 或受策略授权的 Artifact CAS,event 只保存 ref/digest/size/truncated；
- 每个 hook/MCP 调用都关联 sessionId、snapshotId、toolCallId/eventId；
- event sink append/flush 失败时 session paused/failed,新的 extension 副作用不得执行；只读 Host query 可显示 audit degraded；
- replay 恢复 typed passive state与 snapshot refs,但不重放 hook、skill 或 MCP 副作用/可执行对象；
- current event 必须携带 resource identity/digest、snapshot generation、receipt ref、session/workspace/toolCall/event correlation；领域 payload 不重复 authority/sequence/hash 逻辑。
- Host command mutation 还必须关联 command ID/request digest、Host/session generation、driver/resource revision 与 durable command receipt；event sink 或 receipt 校验失败时新的 extension 副作用 fail closed。

## 8. 分阶段实施

每个里程碑单独提交；代码里程碑都必须通过 `npm run check`、`npm test` 和受影响的 build/CLI smoke。不得把后续里程碑的占位 API 混入当前提交。

### M0 — 契约、fixtures 与安全预算

- [x] 记录 Runtime Resource/Capability 契约与 Gateway port：初始 contract `65f9054`、统一 adapter port `54bd16e`；public export 为 `src/runtime/contracts/{ports,public}.ts` 与 `src/runtime/resources/ports.ts`，Extension 只做单向 import；
- [x] 记录 `runtime/05` Host baseline/hardening handoff `1352bfc`；后续 resident extension 串行接线以 `402ab9b`/`8930db5` 为 snapshot/idle fence 证据，并保留 driver、generation/revision、durable intent/receipt、cursor/resync 与 compatibility digest 边界；
- [~] 记录 dependency HEAD：官方 MCP SDK `@modelcontextprotocol/sdk@1.30.0` 已锁精确版本并审阅 lockfile；YAML parser 与 semver 依赖**未**加入——SKILL.md frontmatter 用有界自写 parser（frontmatter.ts：禁止 tab、限制缩进、duplicate key 拒绝）替代，计划 §13 的“成熟解析库”约束留待后续依赖审阅窗口决策；
- [x] 固定本文件中的 current manifest、skill frontmatter、hooks、MCP JSON schema；
- [x] 建立 `tests/fixtures/extensions/`：当前四个文件为 `valid-manifest.json`、`path-escape.json`、`duplicate-identity.json`、`oversize-secret-template.json`；invalid manifest 与 symlink escape 由 `tests/extensions/{plugins,m1-foundation}.test.ts` 动态构造，不虚报不存在的 fixture 文件；
- [x] 定义 `ExtensionDiagnostic`（code、severity、message、source、path、resourceId、cause?）；
- [x] 定义所有扫描深度、文件数、单文件字节数、context 字符数、stdout/stderr 字节数常量；
- [x] 为 JSON schema/TypeBox schema 加 contract test，非法未知字段和缺失必需字段必须失败；
- [x] 为三个 Runtime resource ports（catalog/snapshot/invocation）建立 fake adapter 与 mapping tests，覆盖 exact identity、provenance、trust/activation、receipt、snapshot 与 lifecycle event；
- [x] 固定 capability derivation 输入:manifest/config/command/assets digest、canonical args、filesystem/network/process/credential scope；调用方声明仅作请求,不能作为最终 claim；
- [~] 记录依赖决策和许可证审阅结果：官方 MCP SDK 精确版本已锁；YAML parser、semver 依赖未加入（自写有界 parser 替代，见 M0 依赖 HEAD 条目）。

验收：所有 schema 在不启动进程、不访问网络的情况下可解析；同一 fixture 的 diagnostics 顺序稳定；ExtensionSnapshot/TrustRecord/调用 descriptor 可通过冻结的 Runtime resource/capability contract；缺任一 contract commit 时 M0 保持未完成。

### M1 — Extension 基础层、路径、状态与信任

- [x] 新增 `src/extensions/{types,diagnostics,config-layers,snapshot}.ts`；
- [x] 新增只消费注入 `RunledgerLayout` 的 canonical storage locator,并把 cwd → project root 祖先链扫描严格限定为只读、默认不可信 discovery；realpath 去重且有层数上限；
- [x] 实现 `extensions-state.json` 的 0600 原子写入，启用状态与 trust 分文件；
- [x] 实现 `TrustStore`，以 exact resource identity + canonical path + manifest/config/command/assets digest + capability digest 校验 trusted/stale/untrusted/revoked；
- [x] TrustRecord 记录 principal、scope、issuedAt/expiresAt、revocation revision,并可无损投影为 `ResourceApprovalReceipt`；
- [x] 实现目录/文件 digest，排序稳定、不跟随逃逸 symlink、不读取超额文件；
- [x] 在 Extension catalog/Runtime resource adapter 中生成 tool source/id/runtimeName 与冲突诊断；真实 `ToolRegistry` 接线留到 M6；
- [x] 实现 `ExtensionSnapshot` builder 和 last-known-good 原子交换；
- [x] 实现 Runtime snapshot/catalog/event adapter,只输出有界 descriptor,不泄漏 handler/client/process 对象；
- [~] audit adapter 生成 `extensions.snapshot` lifecycle 投影，敏感字段红线测试；真实 Host-owned event sink 接线留到 M6。

验收：扫描不执行任何资源；路径或 symlink 逃逸 fail-closed；配置、命令、asset、capability 任一变化使 trust stale；同名/猜测 identity 不会 fallback；snapshot 构建失败不破坏当前可用快照。

### M2 — Skill 独立闭环

- [x] 实现用户/项目 `SKILL.md` 发现、frontmatter 校验、qualified identity 和优先级；
- [x] 扫描采用并发与深度上限，错误累计到 diagnostics，不因单个坏 skill 中断；
- [x] 实现有界 catalog renderer，超预算时稳定截断描述而不是随机丢 skill；
- [~] 生成有界 system-prompt catalog fragment；真实 Host-owned resident controller 注入留到 M6,同一 session snapshot 内内容稳定；
- [x] 在 `src/extensions/skills/skill-tool.ts` 实现 read-only catalog resolver，读取完整正文前复核 digest/trust；现有 Runtime `Skill` 占位桥接留到 M6；
- [x] 将 metadata catalog、正文、references/assets 与 scripts 建模为独立 resource/capability；M2 只实现前三者只读路径,不执行 scripts；
- [x] 实现 `$name`、`/skill name` 与 `/name` 的统一解析和含糊名错误；
- [x] `allowed-tools` 只能做交集收窄，并覆盖“不能提升权限”的测试；
- [x] audit adapter 生成 `skill.invocation` event payload，不把全文复制进 ledger；
- [~] snapshot projection 提供 enabled/disabled/error skill 计数；真实 TUI resource bar 接线留到 M6。

验收：未命中的 skill 不注入正文；同名 skill 只能用 qualified identity 精确选择；untrusted/stale skill 不读取正文；系统提示始终受预算约束；正文已读不能产生 process/script grant。

### M3 — Hooks 独立闭环

- [x] 实现 hook JSON parser、event 名校验、matcher 编译和稳定排序；
- [~] 实现注入式 command runner adapter、stdin JSON、stdout parser、stderr 捕获与 timeout request；真实进程 stop/recovery/cleanup 复用 `runtime/05` manager 尚未接线；
- [~] command runner 只消费 Runtime resource/Gateway port 与 Host process facade；当前通过 fake port 验证，Extension 不直接调用全局 spawn、backend 或裸 ExecutionEnv；
- [ ] 过滤/覆盖保留环境变量，禁止 hook 配置伪造 RunLedger 注入值；
- [x] 实现 effective failure mode，项目/plugin 不得下调用户安全策略；
- [x] 在 `src/extensions/integration/runtime-hook-adapter.ts` 准备 SessionStart、UserPromptSubmit、SessionEnd adapter；真实 Host-owned resident controller 接线留到 M6；
- [~] 在 adapter 中准备 PreToolUse、PostToolUse 组合链；真实 agent-loop 接线留到 M6；
- [x] 定义 `updatedInput` adapter 结果；更新后必须重跑 TypeBox 校验、canonicalization、capability derivation 与 authorization；共享 Runtime 类型改动留到 M6；
- [x] 固定顺序为 `prepare/schema -> PreToolUse -> authorization -> execute -> PostToolUse -> result budget`；
- [x] 每个 handler 生成 `hook.run` event payload 和 deny/failure/timeout presentation model；真实 event sink/TUI 接线留到 M6；
- [x] 用 fake scripts 覆盖 allow、deny、update、invalid JSON、nonzero、timeout、abort、oversize。

验收：显式 deny 一定阻断且产生 isError tool result；closed hook 故障阻断，open hook 故障继续；PostToolUse 不可篡改真实执行是否发生；Extension 无 Gateway grant 时不 spawn；显式 disable/Host shutdown 后无 hook 子进程,普通 client detach 不终止资源。

### M4 — MCP 工具闭环

- [ ] 使用 M0 已固定并审阅的官方 MCP SDK,不得在 M4 再改 lockfile；
- [~] 实现 current manager/config 数据合同与层级状态；plugin-relative cwd 和 env template 解析尚未完成；
- [ ] 实现 Host-owned stdio managed-process adapter 与 Gateway-governed Streamable HTTP client factory；
- [x] 实现 server 状态机、并发启动、required gate、startup/tool/per-tool timeout；
- [x] 实现 tool list allow/deny 过滤、raw identity、runtimeName sanitization 与冲突检测；
- [~] 实现 bounded direct invocation adapter；`McpToolCatalog`、`McpSearch`、`McpCall` meta-tool 尚未接入；
- [x] 把 MCP annotations 映射到统一 authorization metadata；
- [~] 从受信 config、tool schema/annotations 和 canonical call input 交 Runtime resource/Gateway port 复核；最终 Host claim composition 尚未接线；
- [x] 实现 text/image/resource result normalization 和 budget/spill 边界；
- [x] 实现 AbortSignal、transport close 与 timeout；受管重启和替代 client identity 尚未完成；
- [ ] 实现 `doctor()` 的结构化结果，不把 connectivity 检查混入普通 list；
- [~] resource shutdown adapter 覆盖 explicit disable、Host session eviction 与 Host shutdown；当前只有 manager close/abort，真实 composition root 接线留到 M6；
- [~] 用注入式 fake MCP client 覆盖 manager/adapter，不依赖公网；真实 stdio/HTTP fake-server E2E 尚未完成。

验收：一个 session 内可通过 fake Runtime Gateway 发现并调用 fake MCP 工具；optional server 失败不阻断 stdlib，required server 失败阻断新 turn；无 grant/receipt stale 时不启动或调用；timeout/abort 后无 orphan；结果与状态完整写审计 adapter。

### M5 — Plugin 组合闭环

- [ ] 实现 `.runledger-plugin/plugin.json` parser、semver、unknown field 和 exact schema 诊断；
- [ ] 实现用户/项目 plugin discovery、qualified identity、enable state 和 trust gate；
- [ ] 所有 component path 做 realpath containment；
- [ ] PluginManager 只输出 Skill/Hook/MCP descriptors，不直接执行；
- [ ] plugin skill/hook/MCP 使用同一 pluginId、root digest 和 data root；
- [ ] untrusted plugin 只显示 manifest metadata 与被阻断的组件计数；
- [ ] Plugin trust 只批准精确 root digest；component descriptor 分别声明 Skill body/assets/script、Hook process 和 MCP process/network/credential claims,不因 parent plugin trusted 自动跳过逐调用授权；
- [ ] plugin 内容变化后旧 snapshot 可运行到 turn 结束，新 reload 标记 stale 并停止新执行；
- [ ] 组件局部失败只禁用局部，manifest 身份/路径错误禁用整个 plugin；
- [ ] 构建 fixture plugin：一个 skill、一个 PreToolUse hook、一个 fake MCP server；
- [ ] audit adapter 生成 plugin state 与 component provenance payload；真实 event sink 接线留到 M6。

验收：fixture plugin 在 untrusted 时零代码执行；grant trust + enable + reload 后三类组件同时可用；disable + reload 后全部撤出且 MCP client/Host-managed process 被关闭。

### M6 — CLI、TUI 与热重载

- [~] 旧 Runtime/Host handoff commit 已有历史记录；2026-08-09 Session composition 以 `session-owner-runtime@a7d272a` 加未提交 S5/S6 diff 为当前审阅边界，提交前仍须补最终共享文件 HEAD；
- [~] `src/extensions/integration/**` 已由 `extension-composition.ts` 接入单 SessionRuntime production composition；resident Host 只保留 R9 安全窗口，完整 CLI/Control Plane mutation surface 尚未迁移；
- [~] `ExtensionSnapshot`、tool/lifecycle audit 已写 owner-fenced Session event；TrustRecord 与全部 plugin provenance 的统一 Resource port/event 覆盖仍未逐项闭合；
- [~] Skill tool、MCP catalog/search/call 已接入该 Session 的 production ToolRegistry 输入；完整 catalog fragment、Plugin tool surface 与 reload 后原子 tool-set 切换仍未完成；
- [~] SessionStart/UserPromptSubmit/SessionEnd 与 PreToolUse/PostToolUse 已接入 Session turn lifecycle；本计划要求的全部 `updatedInput` 重校验/重新授权 fixture 仍未形成最终联合验收；
- [~] extension/skill/hook/MCP lifecycle audit 已进入 canonical Session event store，无 extension 自建 hash chain；完整 plugin state 与 trust mutation receipt 尚未覆盖；
- [ ] 把 CLI parser 升级为 current exact subcommand parser；所有操作映射 Host command/query,不得建立 client-local manager 或兼容 direct path；
- [ ] 实现 `runledger inspect [--json]`，输出 snapshot、来源、状态、diagnostics；
- [ ] 实现 `trust list|grant|revoke <resource-id>`，所有授权均显示将执行的资源身份和 digest；
- [ ] 实现 `plugin list|show|validate|enable|disable|trust|untrust`；
- [ ] 实现 `skill list|show|validate`；
- [ ] 实现 `hook list|validate|enable|disable`；
- [ ] 实现 `mcp list|doctor|enable|disable`；
- [~] TUI `/plugins`、`/skills`、`/hooks`、`/mcp` 已接真实只读 Session snapshot；trust/enable/reload 写操作仍 unavailable；
- [~] 只读 modal 已显示有界 resource 状态；完整 source/trust/component/diagnostic parity 仍待 fixture 验收；
- [~] Session turn lifecycle 已支持 idle reload 接缝；durable reload command、TUI pending/success/failure subscription 与断线 cursor 恢复尚未实现；
- [~] Gateway/attempt/event sink 不可用时 inspect/list 可只读，MCP/Hook 外部执行 fail closed；完整 trust/activate mutation matrix仍未关闭；
- [ ] CLI JSON 输出使用 current contract fields，stderr 与 stdout 分离；
- [ ] CLI 操作只提交 Host command；Host 逐项写 canonical state/receipt,不覆写用户未知字段或 secret。

验收：无 TTY 时四类资源可用 JSON 检查；TUI 能查看、启停、信任和重载；运行中重载不改变当前 turn 的工具集合；集成 diff 只触及本节声明的共享路径且基于已记录 handoff commit。

### M7 — 加固与第二阶段能力

- [ ] MCP OAuth credential store、login/logout、auth-required TUI；
- [ ] MCP resources / resource templates / prompts 的 list/read/get API；
- [ ] legacy SSE transport（仅在真实兼容需求成立时）；
- [ ] 配置文件 watcher 与 debounce，仍遵守 idle 原子交换；
- [ ] hook HTTP handler，增加 SSRF、DNS rebinding、redirect、敏感 payload 审批策略；
- [ ] plugin 版本化 store、install/update/uninstall/rollback 和 marketplace；
- [ ] 安装只接受 exact package/version/publisher/source locator,禁止模型猜测名称后 fallback 安装；
- [ ] 安装包 expected digest/signature、publisher trust root、来源 pin、大小上限、离线缓存与 revocation；“存在签名”不等于 publisher 已受信；
- [ ] 下载经 HTTPS 和 host policy,先进入 staging,再在临时最小权限沙箱做 bounded probe,成功后原子激活；
- [ ] 新版本支持冷却期、显式批准、revocation 和回滚到上一已验证版本；digest、publisher、command、asset 或 capability 变化全部使旧 receipt stale；
- [ ] execute/code-mode 资源默认 hidden,只有显式 profile + Runtime approval 才可激活；
- [ ] 可选 `.agents` / `.claude` / `.grok` 兼容导入器，默认关闭并显示来源；
- [ ] 扩展资源 metrics/OTel（不得替代 canonical Runtime event 审计）。

M7 不阻塞 M0–M6 的本地可运行闭环，且每一项都应独立设计/提交。

## 9. 测试矩阵

### 9.1 单元与契约测试

- manifest/hook/MCP JSON 和 skill YAML 的合法/非法/未知版本；
- canonical path、Windows/Unix 路径、`..`、symlink、case collision；
- config layer precedence、qualified name、重复名、稳定 diagnostics 顺序；
- digest 稳定性、内容变化、oversize、读取失败；
- trust grant/revoke/stale、0600 文件、损坏文件 fail-closed；
- Runtime receipt 映射、expiry/revocation revision、config/command/assets/capability digest 任一变化后的失配；
- Runtime resource ports 的 exact resolve、未知字段、含糊 display name 和调用方少报 capability；
- tool runtime name sanitization 和冲突；
- secret redaction 与 canonical event payload size。

### 9.2 运行时集成测试

- Skill:只注入 catalog、显式读取正文、含糊名、allowed-tools 收窄；
- Skill:正文读取与 assets/script capability 严格分离,读取正文后执行脚本仍需独立 approval；
- Hooks:五类事件顺序、deny/update/failure mode、abort、timeout、进程清理；
- Hooks:updatedInput 后重新 canonicalize/derive/authorize,无 Gateway executor 不 spawn；
- MCP:启动、tools/list、call、image/resource、timeout、cancel、required、restart、close；
- MCP:repo config 默认 untrusted、配置/command/url 变化重批、credential 只经 Broker、无 Gateway grant 不连接；
- Plugin:untrusted → trust → enable → reload → disable 全生命周期；
- snapshot:运行中 reload 排队，turn 间工具集合切换；
- session resume:只恢复消息，不重放历史 hook/MCP side effect。

### 9.3 CLI/TUI 测试

- 现有 `--help`、`--version`、session flags 不回归；
- 所有新子命令 human/JSON 输出和 exit code；
- `/mcp`、`/skills`、`/hooks`、`/plugins` 空态、加载态、错误态；
- resource bar 的 ready/blocked/error 计数；
- trust/enable/reload 的确认边界与运行中禁用行为；
- snapshot/PTY 覆盖所有新增用户可见文本。

### 9.4 每个代码提交的验证门

```bash
npm run check
npm test
npm run build
./bin/runledger.js --help
git diff --check
```

MCP/hook/plugin 里程碑还必须运行对应 fake-server E2E，并在显式 Host shutdown/test lifecycle teardown 后断言子进程和监听端口均已关闭；普通 client detach 测试应反向证明资源仍存活。模型 catalog 未变更时不运行 `npm run generate-models`。

## 10. 失败语义

| 场景 | 行为 |
|---|---|
| 单个 skill 解析失败 | 跳过该 skill，保留其他资源，产生 error diagnostic |
| Plugin manifest 身份/schema/path 逃逸失败 | 整个 plugin disabled，不加载任何 component |
| Plugin 内单个 hook/MCP/skill 文件失败 | 只禁用对应 component，plugin 显示 degraded |
| Untrusted/stale 执行资源 | 列出但不执行，不静默自动信任 |
| Runtime contract major version 不兼容 | 禁止激活/调用，inspect 显示 typed diagnostic，不复制或猜测兼容类型 |
| Gateway、approval store 或 current event sink 不可用 | inspect/list 可继续；新的 spawn/network/script/tool 副作用 fail closed |
| Optional MCP 启动失败 | session 继续，server failed，工具不暴露 |
| Required MCP 启动失败 | 阻断新 turn，允许用户修复/禁用/重试或退出 |
| MCP tool timeout/transport error | 返回 isError tool result，记录状态；满足重启策略时后台恢复 |
| PreToolUse/UserPrompt hook closed failure | 阻断对应操作，reason 明确指向 hook failure |
| open hook failure | 操作继续，但 Host query/TUI/canonical event projection 必须可见失败 |
| reload 新快照失败 | 保留 last-known-good，不产生半激活资源 |
| current event sink append/flush 失败 | session paused/failed,不得继续新的 extension 副作用 |
| command response-loss | 同 command ID/body 重放 durable receipt；异体 conflict；只有 intent 无 receipt 时返回 `uncertain_outcome` 且不重复 trust/reload/spawn/invoke |
| client disconnect/TUI quit | 只 detach；Host-owned resource/process 按 residency policy 继续,不得被 client finally 关闭 |
| Host shutdown 超时 | 共享 global deadline 并按 TERM→KILL drain；记录 `shutdown_incomplete`,外层 endpoint/lease 清理继续,不得无限等待 |

## 11. 提交拆分建议

| Commit | 目的 | 主要路径 |
|---|---|---|
| 0 | 串行固定扩展依赖，提供双方共同 dependency baseline | `package.json`、`package-lock.json` |
| 1 | 消费 Runtime resource contract，固定扩展 schema、映射与诊断契约 | `src/extensions/types.ts`、integration adapters、schemas、fixtures/tests |
| 2 | 建立有界配置层和 exact-identity 内容信任 | extension paths、config-layers、trust、snapshot |
| 3 | 让 Skill 成为真实渐进披露资源 | `src/extensions/skills/**`、adapter tests |
| 4 | 建立经 Gateway 执行、可阻断且可审计的 hook pipeline | `src/extensions/hooks/**`、adapter tests |
| 5 | 接通有界 MCP catalog 与受限工具调用 | `src/extensions/mcp/**`、fake servers、tests |
| 6 | 让 Plugin 安全组合三类资源 | plugins、ExtensionManager、fixtures/tests |
| 7 | 在 Runtime contract + Host handoff 后串行提供 Host Control Plane、CLI/TUI remote facade 与 idle reload | 明确 shared files、integration/PTY tests |
| 8 | 同步正式文档与完成状态 | `AGENTS.md`、`development-doc/00-index.md`、本计划 |

每个 commit 只暂存表中明确路径。共享工作区的既有 `development-doc/tui/03-event-binding.md`、`development-doc/runtime/00-reference.md` 等改动不属于本任务，不得带入提交。

## 12. MVP 完成定义

M0–M6 全部完成且满足以下 E2E，才可把本计划标为完成：

1. 在临时项目创建一个带 Skill、PreToolUse hook 和 stdio MCP server 的 plugin；
2. 首次启动时 plugin 被发现但处于 untrusted，确认没有 hook/MCP 子进程启动，skill 正文也未注入；repo 内 `.runledger/mcp.json` 同样不得自动受信；
3. 用户对 exact identity/digest/capability 显式 trust + enable + reload，snapshot digest 更新且三类 component 均带相同 plugin provenance 与有效 Runtime receipt；
4. `/skill` 能按需读取正文，未调用 skill 不进入上下文；
5. MCP fake tool 可按 exact identity 搜索、由 Runtime 推导 claims、审批、调用、返回结果并响应 abort/timeout；
6. PreToolUse hook 能 allow、deny、更新参数；更新后重新 schema/canonicalize/authorize,所有结果均写入 canonical audit sink；
7. 运行中修改 plugin 只产生 pending/stale，当前 turn 不换工具；idle reload 后原子切换；
8. disable plugin 后 skill/hook/MCP 全部撤出，Host manager 关闭对应受管进程；普通 client detach 不影响仍启用资源；
9. `runledger inspect --json` 与 TUI 显示同一 snapshot/diagnostics；
10. canonical Runtime event store 中存在 snapshot、skill invocation、hook run、MCP server/tool 和 plugin state 记录，且无 secret、不存在 custom ledger fallback 或第二条 extension hash chain；
11. `npm run check`、`npm test`、`npm run build`、CLI smoke 全部通过；
12. 修改 plugin config/command/asset/capability 后旧 receipt 立即 stale,新调用在重新审批前被拒绝；
13. 读取 `SKILL.md` 后脚本仍不可执行,直到获得独立 script/process approval；
14. `AGENTS.md` 的“显式不实现”和目录/测试说明同步到真实状态。
15. 两个 CLI/TUI client 复用同一 Host/ExtensionSnapshot；observer 不能 trust/enable/reload/invoke mutation,driver response-loss 不重复副作用。
16. 所有 RunLedger 自有 extension config/state/data 只位于 canonical `runledgerHome`;repo `.runledger` 若被发现只读且默认 untrusted,旧 `~/.runledger/agent` 与 sessionDir 不产生新写入。

## 13. 非目标

MVP 明确不做：

- 任意 JavaScript/TypeScript 进程内 plugin entrypoint；
- plugin 自定义 Node dependency 注入或自动执行 `npm install`；
- marketplace、Git clone/update、签名分发和自动升级；
- plugin agents、LSP、apps、browser extension；
- HTTP hooks、prompt hooks、agent hooks、async hooks；
- MCP OAuth、legacy SSE、elicitation、sampling、roots 协商；
- 自动扫描其他产品的配置目录；
- 无界全量 MCP tool schema 注入；
- 以 hook/plugin trust 替代逐工具授权；
- 把 secret、完整 hook/MCP 大输出或 skill 正文复制进 canonical event；
- 在 agent 正执行 tool batch 时热替换 snapshot。

## 14. 主要参考文件

### RunLedger Runtime 上游契约

- `development-doc/runtime/00-reference.md`
- `development-doc/runtime/04-governed-agent-harness-runtime-plan.md` 的 [Workspace/Security contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-workspace-security)、[Resource contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-resources) 与 [Control/Telemetry contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-control-telemetry)
- `development-doc/runtime/05-multi-client-background-terminal-refactor-plan.md` 的 Host ownership、driver fence、durable command/subscription、managed process 与 lifecycle contract（现行基线；替代权威 `development-doc/runtime/06-session-owner-runtime-replacement-plan.md`，R6 将扩展生命周期改绑 session-scoped SessionRuntime）
- 计划生成的 `src/runtime/resources/{types,schemas,ports,events}.ts`

### Codex

- `codex-rs/plugin/src/manifest.rs`
- `codex-rs/core-plugins/src/{manifest,loader,manager,store}.rs`
- `codex-rs/skills/src/assets/samples/plugin-creator/references/plugin-json-spec.md`
- `codex-rs/core-skills/src/{loader,model,render,injection,service}.rs`
- `codex-rs/config/src/{skills_config,hook_config,mcp_types}.rs`
- `codex-rs/hooks/src/{schema,registry,config_rules}.rs`
- `codex-rs/hooks/src/engine/{discovery,dispatcher,command_runner,output_parser}.rs`
- `codex-rs/codex-mcp/src/{connection_manager,catalog,runtime,plugin_config}.rs`
- `codex-rs/rmcp-client/src/`

### grok-build

- `crates/codegen/xai-grok-pager/docs/user-guide/{07-mcp-servers,08-skills,09-plugins,10-hooks}.md`
- `crates/codegen/xai-grok-pager/docs/{hooks-and-plugins,custom-hooks}.md`
- `crates/codegen/xai-grok-agent/src/plugins/{manifest,discovery,registry,trust,hooks_adapter}.rs`
- `crates/codegen/xai-grok-tools/src/implementations/skills/`
- `crates/codegen/xai-grok-hooks/src/{config,event,result,discovery,dispatcher,trust}.rs`
- `crates/codegen/xai-grok-hooks/src/runner/`
- `crates/codegen/xai-grok-config-types/src/mcp.rs`
- `crates/codegen/xai-grok-mcp/src/`
- `crates/codegen/xai-grok-shell/src/session/{mcp_servers,mcp_dispatcher,mcp_restart}.rs`

### RunLedger 当前接入点

- `src/storage/{paths,settings-manager,resolve-config-value}.ts`
- `src/runtime/{agent-loop,types,tool-registry,tool-authorization,interactive-session-controller}.ts`
- `src/runtime/tools/skill.ts`
- Host-owned Runtime event sink 与 projection adapters
- `src/cli/{args,main}.ts`
- `src/tui/interactive-mode.ts`
- `src/tui/components/{mcp-server-selector,loaded-resources}.ts`
