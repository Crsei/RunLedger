# RunLedger Plugin / MCP / Skill / Hooks 实施计划

> 文档状态:拟实施（单一权威计划）<br>
> 编写日期:2026-07-21;边界校准:2026-07-22<br>
> RunLedger 基线:`1658fe26fc675cc18498bb8c6a9f162b7a0b733f` (`feat/agent-loop-resurrect`)<br>
> Codex 参考基线:`0b175e6439a8608ba7726ee153fd8590619e8f34` (`main`)<br>
> grok-build 参考基线:`c68e39f60462f28d9be5e683d9cbe2c57b1a5027` (`main`)

## 0. 输入状态与使用方式

本计划的目标目录已经存在 `00-reference.md`，但在本次审阅时该文件为 **0 字节空文件**。该文件仍保留不动。2026-07-22 新增的 [`../runtime/00-reference.md`](../runtime/00-reference.md) 与 [`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md) 已成为本计划必须消费的上游 Runtime 约束；本文件继续结合 Codex、grok-build、RunLedger 当前实现和根目录 `AGENTS.md` 形成扩展侧唯一实施账本。

若后续向 `00-reference.md` 补入内容，实施前必须先做一次差异审阅：

1. 把新增约束映射到本计划的“固定决策、里程碑、验收矩阵、非目标”；
2. 如有冲突，先更新本文件，不在同目录新建第二份同主题实施计划；
3. 任何安全边界、配置格式或生命周期变更都必须先形成明确的兼容策略。

本文件是后续 Plugin / MCP / Skill / Hooks 工作的执行状态账本。实施时只在本文件的复选框上更新状态；专题设计可以作为附录增加，但不得另建平行的总计划。

### 0.1 与 Runtime 主计划的依赖和所有权

两份计划采用“Runtime 产出中立契约，Extension 实现具体能力”的单向依赖。Runtime 只定义 `src/runtime/resources/{types,schemas,ports,events}.ts`；本计划负责发现、配置、信任、进程、生命周期、审计投影和用户控制面，不在 `src/runtime/resources/` 中实现任何 extension manager/loader/client/runner。

Capability/approval/sandbox 的行为实现来自 [`../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](../worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)。本计划只生成资源 descriptor 与 raw invocation、消费 `ExecutionGateway`/受限 executor,不实现第二套 PermissionEngine、ApprovalCoordinator、Credential Broker 或平台 sandbox。

Runtime Phase 3/5 必须先冻结以下 public contract,本计划 M0 才能标记完成:

- `ResourceKind`、`ResourceIdentity`、`ResourceProvenance`、`ResourceManifestDigest`。
- `ResourceTrustState`、`ResourceActivationState`、`ResourceApprovalReceipt`。
- Phase 3 的 `CapabilityClaim` 与 Phase 5 的 `RuntimeToolDescriptor`、`RuntimeToolInvocation`、`RuntimeToolResult`。
- `RuntimeResourceSnapshot`、`ResourceLifecycleEvent` 及 TypeBox schemas。
- `RuntimeResourceCatalogPort`、`RuntimeResourceInvocationPort`、`RuntimeResourceEventSink`、`RuntimeResourceSnapshotProvider`。

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
| 串行 integration | 下表列出的 storage/runtime/CLI/TUI/shared package 文件 | 不与 Runtime 线并发修改 | Runtime handoff commit 已记录,逐路径集成并全量验证 |

具体规则:

1. M1–M5 期间只在 `src/extensions/**` 实现,所有 Runtime 接入先落在 `src/extensions/integration/**` adapter,不得复制 Runtime 类型作为临时双真源。
2. `src/runtime/{agent-loop,types,tool-registry,tool-authorization,interactive-session-controller}.ts` 是 Runtime、Worktree/Sandbox/Permission 与其他专项共用的串行集成面。本计划仅在获分配的 M6 集成窗口修改,开始前记录所有前置 contract/implementation/handoff commit。
3. `package.json`、`package-lock.json` 属于 M0 串行依赖面:Runtime 线先交出当前 dependency HEAD,Extension 线用一个独立提交加入 YAML/semver/MCP SDK 精确版本,随后双方都以该提交为基线。`src/storage/{paths,settings-manager}.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` 属于 M6 串行集成面。
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
| 项目层 `.runledger/` 与用户层 `~/.runledger/agent/` | `src/storage/paths.ts` | 扩展资源的两层根目录 |
| 项目 settings 清洗与 0600 写入 | `src/storage/settings-manager.ts` | 保留现有模型/session 配置；扩展配置使用独立文件 |
| 多 namespace 工具注册 | `src/runtime/tool-registry.ts` | 承载 stdlib、MCP catalog 工具及来源元数据 |
| tool 前置授权切点 | `src/runtime/tool-authorization.ts`、`agent-loop.ts` | 接入 PreToolUse + 授权策略组合链 |
| `beforeToolCall` / `afterToolCall` | `src/runtime/types.ts`、`agent-loop.ts` | Hooks 的第一批运行时挂点 |
| `ExecutionEnv` + `AbortSignal` | `src/runtime/execution-env.ts`、`tool-context.ts` | 复用取消语义；hook/MCP 实际 process/network 必须改走 Gateway 受限 executor |
| append-only JSONL ledger | `src/runtime/ledger/` | 扩展快照、hook/MCP/skill 运行审计 |
| CLI/TUI 统一 controller | `src/runtime/interactive-session-controller.ts` | 装配 ExtensionManager 和资源快照 |
| `/mcp` 占位与资源计数条 | `src/tui/interactive-mode.ts`、`components/mcp-server-selector.ts`、`loaded-resources.ts` | 后期控制面展示 |
| `Skill` 占位工具 | `src/runtime/tools/skill.ts` | 改造成真实 catalog 读取工具，不再使用 handler map |

### 2.2 必须先修正的结构性缺口

- `ProjectSettings` 会丢弃未知字段，不能直接承担完整扩展配置；
- `ToolRegistry` 当前跨 namespace 扁平化后仍可能出现同名工具，agent-loop 又按 `name` 首个匹配，不能静默承载 MCP 冲突；
- 生产 controller 明确排除了 `Skill`，系统提示中也没有 skill catalog；
- `/mcp` 只有空列表，没有连接管理器、状态机或关闭路径；
- 当前默认授权是 `AllowAllToolAuthorizationPolicy`，不存在用户确认、项目/插件信任或按工具来源审批；
- `beforeToolCall` 异常会被当作 block，但没有可配置 failure mode，也不能返回修改后的 tool input；
- ledger 的 `custom` entry 可承载扩展审计，但尚无 schema 名、脱敏规则、大小上限和回放规则；
- CLI 只有扁平 flags，尚无 `plugin` / `mcp` / `skill` / `hook` 子命令；
- 没有统一诊断对象，加载器若直接写 stderr，TUI、CLI JSON 输出和 ledger 将无法复用同一事实。

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
- reload 只在 agent idle 时交换 snapshot；运行中请求只标记 pending；
- 新 snapshot 构建失败时保留 last-known-good，失败以 diagnostics 暴露；
- 旧 MCP clients 只有在新 snapshot 成功生效后才关闭，避免半加载状态；
- session resume 重新按当前磁盘配置构造资源，不从旧 ledger 恢复可执行对象。

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
- ledger 永远写 raw identity + runtime name，不能只写经过截断的显示名。
- 所有 resolve/activate/invoke API 只接受 qualified identity 或从当前 immutable snapshot 返回的 opaque handle；模型生成的包名、仓库名、Skill 名或 Marketplace locator 不能触发猜测、安装或 fallback 搜索。

### 4.5 安全默认值

- manifest 和配置只允许声明式 JSON/YAML/Markdown，不执行解析期代码；
- plugin path、skill reference、hook command path 和 MCP cwd 都做 realpath containment 检查；
- hook 默认 direct spawn `command + args`，MVP 不接受隐式 shell string；
- 项目配置中的 secret 只能经 `${ENV_VAR}` / `bearerTokenEnvVar` 引用；
- secret 原值不得进入 diagnostic、ledger、TUI、错误文本或 tool result；
- MCP 和 hook 子进程必须继承 AbortSignal，timeout 后杀进程组并等待退出；实际 spawn/network 只能使用 Runtime Gateway 授予的受限 executor,不得直接持有全局 `process`/`fetch`/裸 `ExecutionEnv`；
- MCP tool、Hook handler、Skill script 仍经过统一 Capability Gateway，不能因来自受信任 plugin、正文已读或 hook failure mode 为 open 而绕过审批；
- Extension 只提交 raw input 和受信 descriptor。canonical arguments、path/host/process/credential 语义及最终 `CapabilityClaim[]` 由 Runtime 推导；updated hook input 必须重新 schema 校验、重新 canonicalize 并重新授权；
- Skill metadata catalog、完整 `SKILL.md`、assets/references 读取和 scripts 执行是四个独立能力层；“文档可读”永远不表示“脚本可执行”；
- 项目内 `.runledger/mcp.json`、Plugin/Hook/Skill 配置默认 untrusted；文件位于 Git 仓库、由同一用户拥有或曾在旧 snapshot 中可用都不能自动批准；
- PreToolUse 的默认失败策略为 `closed`，UserPromptSubmit 的默认失败策略为 `closed`，其他观察型事件默认 `open`；
- 使用者可在受信任的用户层配置中逐 hook 改 failure mode，项目/plugin 自身不能把 `closed` 降为 `open`；
- 所有文本/JSON 输入输出均有字节上限，超额正文 spill 到 session 私有目录，模型只收到有界预览和审计路径。

## 5. 文件布局与配置契约

### 5.1 资源位置

```text
<cwd 或祖先目录>/.runledger/
├── settings.json
├── mcp.json
├── hooks/
│   └── *.json
├── skills/
│   └── <skill-name>/SKILL.md
└── plugins/
    └── <plugin-name>/.runledger-plugin/plugin.json

~/.runledger/agent/
├── auth.json
├── settings.json                 # 后续补用户层 settings 合并
├── extensions-state.json         # 启用/禁用，不保存 secret
├── trust.json                    # 0600，canonical path + digest
├── mcp.json
├── hooks/*.json
├── skills/<skill-name>/SKILL.md
├── plugins/<plugin-name>/...
└── plugin-data/<encoded-plugin-id>/ # hook/plugin 可写数据，不写入插件安装目录
```

项目资源从 git root（或文件系统根前的安全停止点）扫描到 cwd，越深层优先级越高。扫描必须有最大祖先层数，且对每个实际目录去重。

### 5.2 层级与冲突

有效优先级从高到低：

1. 当前 session/CLI 显式资源；
2. cwd `.runledger/`；
3. cwd 到项目根之间的祖先 `.runledger/`（越深越高）；
4. 用户 `~/.runledger/agent/`；
5. 内置资源。

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

统一 stdin envelope 包含 event、eventId、timestamp、sessionId、cwd、snapshotId、source，以及事件专属 payload。tool input/result 超限时只传预览、hash、truncated 标记和 session spill 路径。

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
- runner 注入 `RUNLEDGER_HOOK_EVENT`、`RUNLEDGER_HOOK_ID`、`RUNLEDGER_SESSION_ID`、`RUNLEDGER_WORKSPACE_ROOT`；
- plugin hook 额外注入 `RUNLEDGER_PLUGIN_ROOT` 和 `RUNLEDGER_PLUGIN_DATA`，保留键不可被配置覆盖；
- 非 0、timeout、spawn error、非法 JSON 都形成 `HookRunOutcome`，再按 effective failure mode 决定是否阻断；
- MVP 不支持 HTTP、prompt、agent、async hook；它们在 command runner 稳定后单独评审。

### 5.6 MCP

项目/用户 `.runledger/mcp.json` 和 plugin `.mcp.json` 使用同一 schema：

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
- server 启动可并发但必须有并发上限，状态事件按 server 独立写 ledger；
- `required=true` 的 server 启动失败时禁止开始新 turn；optional server 失败只降级并显示 diagnostic；
- 每次 tool call 同时受 server timeout、per-tool timeout、session AbortSignal 约束；
- `enabledTools` 先过滤，`disabledTools` 后过滤；
- MCP tool annotations 映射为 `isReadOnly` / `isDestructive` / `isConcurrencySafe`，缺失时使用保守值；
- 默认只给模型暴露 `McpSearch` 与 `McpCall` 两个有界 meta-tools；用户显式 pin 的少量工具才作为直接 `AgentTool` 暴露；
- catalog search 返回 raw name、qualified name、description、input schema 摘要和来源，不能直接执行；
- `McpCall` 必须再次按稳定 server/tool identity 路由并经过 `ToolAuthorizationPolicy`；
- text/image/resource content 正确保留类型；未知 content 变成有界 JSON 文本，不使用 `any`；
- 单次结果复用 agent-loop 的 budget/spill 机制，并额外记录原始字节数、截断状态和内容 hash；
- client transport closed 时先移除旧 client identity，再决定受限重启；旧 client 的迟到事件不得关闭替代 client；
- SessionEnd 和 CLI 退出都调用 `closeAll()`，不得留下孤儿进程或后台重连任务。

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
| `src/storage/paths.ts` | 新增用户/项目 extension、trust、plugin-data、spill 路径；补祖先链解析 |
| `src/storage/settings-manager.ts` | 增用户层 settings 读取与明确合并；不把大块资源定义塞进 settings |
| `src/runtime/tool-registry.ts` | 仅通过冻结的 public API 注册 adapter tools；若 API 不足先走 Runtime contract 升级，不在集成提交塞入 extension 私有状态 |
| `src/runtime/types.ts` | `BeforeToolCallResult.updatedInput`、hook/authorization 组合结果 |
| `src/runtime/agent-loop.ts` | updated input 重校验、PostToolUse context、snapshotId 审计 |
| `src/runtime/tool-authorization.ts` | 把 extension descriptor/raw input 接到既有 Runtime Gateway；policy/claim 推导仍由 Runtime 拥有 |
| `src/runtime/interactive-session-controller.ts` | 持有 ExtensionManager，装配 skills/MCP/tools/hooks，idle reload |
| `src/runtime/tools/skill.ts` | 删除 handler 占位语义，桥接真实 SkillCatalog |
| `src/cli/args.ts`、`main.ts` | 增子命令路由、启动/关闭扩展生命周期、doctor/inspect JSON |
| `src/tui/interactive-mode.ts` | `/plugins`、`/skills`、`/mcp`、`/hooks`、reload 和 trust/enable 操作 |
| `src/tui/components/loaded-resources.ts` | 使用 snapshot 的 enabled/ready/error 计数，不只显示非零总数 |
| `src/index.ts`、`package.json` | M6 导出公共类型/必要子路径 exports；运行依赖版本由 M0 串行 dependency commit 先行落地 |

M1–M5 的实现必须通过 dependency injection 和 fake Runtime ports 独立测试。M6 开始前执行人需要在本文件记录 Runtime contract commit、当前共享文件 HEAD 和 Extension domain commit；任一共享文件在 handoff 后又发生变化时先 rebase/重审,不得靠自动冲突选择合并。

## 7. 审计模型

扩展事件使用 `LedgerEntry.type = "custom"` 时,payload 必须符合当前 exact schema。Runtime 可写路径启用后,同一语义必须经 `runtime-audit-adapter.ts` 投影为 Runtime `ResourceLifecycleEvent` 或对应的 typed event payload；durable truth 只允许由 Runtime event sink 持有,不得 dual-write 两套互不校验的真源。

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
- 原始 tool/hook payload 超限后写 session 私有 spill，ledger 只保存相对路径、hash、size、truncated；
- 每个 hook/MCP 调用都关联 sessionId、snapshotId、toolCallId/eventId；
- custom ledger append 失败沿用现有“不抛错”语义,但 UI/CLI 必须显示 `ledger.lastError`,且有效策略要求 durable audit 时阻断后续副作用；current event sink append/flush 失败则 session paused/failed；
- replay 只恢复消息和 runtime config；扩展审计用于展示，不重新触发 hook、skill 或 MCP；
- 后续若引入 hash chain，应升级 ledger schema，不在 extension payload 内自造第二条链。
- current event 必须携带 resource identity/digest、snapshot generation、receipt ref、session/workspace/toolCall/event correlation；领域 payload 不重复 authority/sequence/hash 逻辑。
- 不提供 custom audit fallback；session 的 durable truth 只能通过 Runtime event sink 写入。event sink 不可用或 receipt 校验失败时,新的 extension 副作用 fail closed,只读 inspect 可继续并显示 audit degraded。

## 8. 分阶段实施

每个里程碑单独提交；代码里程碑都必须通过 `npm run check`、`npm test` 和受影响的 build/CLI smoke。不得把后续里程碑的占位 API 混入当前提交。

### M0 — 契约、fixtures 与安全预算

- [ ] 记录 Runtime Phase 5 resource contract 与 Phase 3 capability/Gateway port 的 commit、export path,确认本计划不复制 Runtime/security 类型；
- [ ] 记录 dependency HEAD,以独立串行提交加入 YAML parser、semver、官方 MCP SDK 精确版本并审阅 lockfile；通知 Runtime 线随后基于该提交继续；
- [ ] 固定本文件中的 current manifest、skill frontmatter、hooks、MCP JSON schema；
- [ ] 建立 `tests/fixtures/extensions/`，包含 valid、invalid、path-escape、symlink、duplicate、oversize、secret-template 样例；
- [ ] 定义 `ExtensionDiagnostic`（code、severity、message、source、path、resourceId、cause?）；
- [ ] 定义所有扫描深度、文件数、单文件字节数、context 字符数、stdout/stderr 字节数常量；
- [ ] 为 JSON schema/TypeBox schema 加 contract test，非法未知字段和缺失必需字段必须失败；
- [ ] 为四个 Runtime resource ports 建 fake adapter 和 mapping golden fixtures,覆盖 exact identity、provenance、trust/activation、receipt、snapshot 与 lifecycle event；
- [ ] 固定 capability derivation 输入:manifest/config/command/assets digest、canonical args、filesystem/network/process/credential scope；调用方声明仅作请求,不能作为最终 claim；
- [ ] 记录依赖决策和许可证审阅结果：YAML parser、semver、官方 MCP SDK 均使用精确版本。

验收：所有 schema 在不启动进程、不访问网络的情况下可解析；同一 fixture 的 diagnostics 顺序稳定；ExtensionSnapshot/TrustRecord/调用 descriptor 可通过冻结的 Runtime resource/capability contract；缺任一 contract commit 时 M0 保持未完成。

### M1 — Extension 基础层、路径、状态与信任

- [ ] 新增 `src/extensions/{types,diagnostics,config-layers,snapshot}.ts`；
- [ ] 新增路径 API 和 cwd → project root 祖先链扫描，realpath 去重且有层数上限；
- [ ] 实现 `extensions-state.json` 的 0600 原子写入，启用状态与 trust 分文件；
- [ ] 实现 `TrustStore`，以 exact resource identity + canonical path + manifest/config/command/assets digest + capability digest 校验 trusted/stale/untrusted/revoked；
- [ ] TrustRecord 记录 principal、scope、issuedAt/expiresAt、revocation revision,并可无损投影为 `ResourceApprovalReceipt`；
- [ ] 实现目录/文件 digest，排序稳定、不跟随逃逸 symlink、不读取超额文件；
- [ ] 在 Extension catalog/Runtime resource adapter 中生成 tool source/id/runtimeName 与冲突诊断；真实 `ToolRegistry` 接线留到 M6；
- [ ] 实现 `ExtensionSnapshot` builder 和 last-known-good 原子交换；
- [ ] 实现 Runtime snapshot/catalog/event adapter,只输出有界 descriptor,不泄漏 handler/client/process 对象；
- [ ] audit adapter 生成 `extensions.snapshot` lifecycle 投影，敏感字段红线测试；真实 ledger/event sink 接线留到 M6。

验收：扫描不执行任何资源；路径或 symlink 逃逸 fail-closed；配置、命令、asset、capability 任一变化使 trust stale；同名/猜测 identity 不会 fallback；snapshot 构建失败不破坏当前可用快照。

### M2 — Skill 独立闭环

- [ ] 实现用户/项目 `SKILL.md` 发现、frontmatter 校验、qualified identity 和优先级；
- [ ] 扫描采用并发与深度上限，错误累计到 diagnostics，不因单个坏 skill 中断；
- [ ] 实现有界 catalog renderer，超预算时稳定截断描述而不是随机丢 skill；
- [ ] 生成有界 system-prompt catalog fragment；真实 controller 注入留到 M6,同一 session snapshot 内内容稳定；
- [ ] 在 `src/extensions/skills/skill-tool.ts` 实现 read-only catalog resolver，读取完整正文前复核 digest/trust；现有 Runtime `Skill` 占位桥接留到 M6；
- [ ] 将 metadata catalog、正文、references/assets 与 scripts 建模为独立 resource/capability；M2 只实现前三者只读路径,不执行 scripts；
- [ ] 实现 `$name`、`/skill name` 与 `/name` 的统一解析和含糊名错误；
- [ ] `allowed-tools` 只能做交集收窄，并覆盖“不能提升权限”的测试；
- [ ] audit adapter 生成 `skill.invocation` event payload，不把全文复制进 ledger；
- [ ] snapshot projection 提供 enabled/disabled/error skill 计数；真实 TUI resource bar 接线留到 M6。

验收：未命中的 skill 不注入正文；同名 skill 只能用 qualified identity 精确选择；untrusted/stale skill 不读取正文；系统提示始终受预算约束；正文已读不能产生 process/script grant。

### M3 — Hooks 独立闭环

- [ ] 实现 hook JSON parser、event 名校验、matcher 编译和稳定排序；
- [ ] 实现 direct-spawn command runner、stdin JSON、stdout parser、stderr 捕获、timeout 与进程组清理；
- [ ] command runner 只消费 Runtime Gateway 授予的 process/filesystem/credential executor；Extension 不直接调用全局 spawn 或裸 ExecutionEnv；
- [ ] 过滤/覆盖保留环境变量，禁止 hook 配置伪造 RunLedger 注入值；
- [ ] 实现 effective failure mode，项目/plugin 不得下调用户安全策略；
- [ ] 在 `src/extensions/integration/runtime-hook-adapter.ts` 准备 SessionStart、UserPromptSubmit、SessionEnd adapter；真实 controller 接线留到 M6；
- [ ] 在 adapter 中准备 PreToolUse、PostToolUse 组合链；真实 agent-loop 接线留到 M6；
- [ ] 定义 `updatedInput` adapter 结果；更新后必须重跑 TypeBox 校验、canonicalization、capability derivation 与 authorization；共享 Runtime 类型改动留到 M6；
- [ ] 固定顺序为 `prepare/schema -> PreToolUse -> authorization -> execute -> PostToolUse -> result budget`；
- [ ] 每个 handler 生成 `hook.run` event payload 和 deny/failure/timeout presentation model；真实 event sink/TUI 接线留到 M6；
- [ ] 用 fake scripts 覆盖 allow、deny、update、invalid JSON、nonzero、timeout、abort、oversize。

验收：显式 deny 一定阻断且产生 isError tool result；closed hook 故障阻断，open hook 故障继续；PostToolUse 不可篡改真实执行是否发生；Extension 无 Gateway grant 时不 spawn；退出后无 hook 子进程。

### M4 — MCP 工具闭环

- [ ] 使用 M0 已固定并审阅的官方 MCP SDK,不得在 M4 再改 lockfile；
- [ ] 实现 current config parser、层级合并、plugin-relative cwd 和 env template 解析；
- [ ] 实现 stdio 与 Streamable HTTP client factory；
- [ ] 实现 server 状态机、并发启动、required gate、startup/tool/per-tool timeout；
- [ ] 实现 tool list allow/deny 过滤、raw identity、runtimeName sanitization 与冲突检测；
- [ ] 实现 `McpToolCatalog`、`McpSearch`、`McpCall` 和显式 pinned direct tool；
- [ ] 把 MCP annotations 映射到统一 authorization metadata；
- [ ] 从受信 config、tool schema/annotations 和 canonical call input 推导 network/process/credential/filesystem claim 请求,交 Runtime Gateway 形成最终 decision；
- [ ] 实现 text/image/resource result normalization 和 budget/spill；
- [ ] 实现 AbortSignal、transport close、受限退避重启、替代 client identity 防竞态；
- [ ] 实现 `doctor()` 的结构化结果，不把 connectivity 检查混入普通 list；
- [ ] `closeAll()` adapter 覆盖 SessionEnd、TUI quit、SIGINT 和异常 finally；真实 composition root 接线留到 M6；
- [ ] 用仓库内 fake MCP stdio server 与本地 HTTP server 做集成测试，不依赖公网。

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

验收：fixture plugin 在 untrusted 时零代码执行；grant trust + enable + reload 后三类组件同时可用；disable + reload 后全部撤出且 client 被关闭。

### M6 — CLI、TUI 与热重载

- [ ] 在开始 M6 前记录 Runtime resource/capability contract commit、安全专项 ExecutionGateway implementation commit、Extension M1–M5 commit 和所有共享文件 HEAD；若 handoff 后已变化先重审再集成；
- [ ] 由本里程碑单一所有者把 `src/extensions/integration/**` 接入 Runtime shared files,禁止 Runtime 线同时修改这些路径；
- [ ] 将 `ExtensionSnapshot`/TrustRecord/tool invocation/lifecycle audit adapter 接到 Runtime Phase 5 ports,不直接 import Runtime 内部 store/reducer；
- [ ] 把 catalog fragment 与 extension Skill tool 接入 controller/现有 `src/runtime/tools/skill.ts`,把 snapshot tools 通过 public ToolRegistry API 注册；
- [ ] 把 SessionStart/UserPromptSubmit/SessionEnd 与 PreToolUse/PostToolUse adapters 接入 controller/agent-loop,落地 `updatedInput` 重校验和重新授权；
- [ ] 把 typed audit adapter 接入 Runtime event sink,确保 extension 不自建 durable truth 或 dual-write；
- [ ] 把 CLI parser 升级为兼容现有 flags 的判别式 subcommand parser；
- [ ] 实现 `runledger inspect [--json]`，输出 snapshot、来源、状态、diagnostics；
- [ ] 实现 `trust list|grant|revoke <resource-id>`，所有授权均显示将执行的资源身份和 digest；
- [ ] 实现 `plugin list|show|validate|enable|disable|trust|untrust`；
- [ ] 实现 `skill list|show|validate`；
- [ ] 实现 `hook list|validate|enable|disable`；
- [ ] 实现 `mcp list|doctor|enable|disable`；
- [ ] TUI 增 `/plugins`、`/skills`、`/hooks`，把现有 `/mcp` 从空 selector 接到真实状态；
- [ ] 统一 modal 显示 source、enabled、trust、ready/error、component count 和最近 diagnostic；
- [ ] reload 运行中只排队，idle 后原子生效；TUI 明示 pending/success/failure；
- [ ] Runtime Gateway/approval/event sink 不可用时,inspect/list 可只读降级,trust/activate/spawn/invoke 必须 fail closed；
- [ ] CLI JSON 输出使用 current contract fields，stderr 与 stdout 分离；
- [ ] CLI 操作都逐项写状态文件，不覆写用户未知字段或 secret。

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
- [ ] 扩展资源 metrics/OTel（不得替代 ledger 审计）。

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
- secret redaction 与 ledger payload size。

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
node bin/runledger.js --help
git diff --check
```

MCP/hook/plugin 里程碑还必须运行对应 fake-server E2E，并在测试 teardown 断言子进程和监听端口均已关闭。模型 catalog 未变更时不运行 `npm run generate-models`。

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
| open hook failure | 操作继续，但 TUI/ledger 必须可见失败 |
| reload 新快照失败 | 保留 last-known-good，不产生半激活资源 |
| current custom ledger append 失败 | 当前操作结果保持真实并显式暴露 audit degraded；若策略要求 durable audit,阻断后续副作用 |
| current event sink append/flush 失败 | session paused/failed,不得继续新的 extension 副作用 |
| shutdown 超时 | 强制结束受管进程，记录未优雅关闭；不得无限等待 |

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
| 7 | 在 Runtime handoff 后串行提供 CLI/TUI 控制面与 idle reload | 明确 shared files、integration/PTY tests |
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
8. disable plugin 后 skill/hook/MCP 全部撤出，client 与子进程关闭；
9. `runledger inspect --json` 与 TUI 显示同一 snapshot/diagnostics；
10. ledger/current event store 中存在 snapshot、skill invocation、hook run、MCP server/tool 和 plugin state 记录，且无 secret、不存在第二条 extension hash chain；
11. `npm run check`、`npm test`、`npm run build`、CLI smoke 全部通过；
12. 修改 plugin config/command/asset/capability 后旧 receipt 立即 stale,新调用在重新审批前被拒绝；
13. 读取 `SKILL.md` 后脚本仍不可执行,直到获得独立 script/process approval；
14. `AGENTS.md` 的“显式不实现”和目录/测试说明同步到真实状态。

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
- 把 secret、完整 hook/MCP 大输出或 skill 正文复制进 ledger；
- 在 agent 正执行 tool batch 时热替换 snapshot。

## 14. 主要参考文件

### RunLedger Runtime 上游契约

- `development-doc/runtime/00-reference.md`
- `development-doc/runtime/04-governed-agent-harness-runtime-plan.md` §0.1、Phase 3、Phase 5、Phase 10
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
- `src/runtime/ledger/`
- `src/cli/{args,main}.ts`
- `src/tui/interactive-mode.ts`
- `src/tui/components/{mcp-server-selector,loaded-resources}.ts`
