# Extensions、MCP、Hooks 与 Skills

Extensions 子系统拥有扩展发现、digest/trust、启用状态、Session 私有 snapshot、声明式 Plugin/Skill/Hook/MCP 资源、model tool/context 注入和有序 teardown。生产 adapter 由 Session domain 注入 governed filesystem/network/process 能力。

源码入口：[`src/extensions/`](../../src/extensions)、[`src/runtime/session-runtime/extension-composition.ts`](../../src/runtime/session-runtime/extension-composition.ts)、[`src/lsp/`](../../src/lsp)、[`src/storage/extensions/`](../../src/storage/extensions)。

## Descriptor、trust 与 snapshot

发现层把 user/project/session source 解析为 descriptor，并计算文件或目录内容 digest；workspace-keyed 存储在 extension provenance 中属于 project source。Trust record 绑定 identity、source scope 与 digest；内容改变后旧 trust 不自动覆盖新内容。

`ExtensionManager` 结合 descriptor、enabled state、trust policy 和 diagnostics 生成不可变 public snapshot。Session 在 turn admission 时固定 snapshot identity；reload 只影响后续 admission，不把已经运行的 turn 切换到另一组 hooks/tools。

Extension snapshot load 失败、canonical/plugin MCP config 无效或 required MCP 启动失败会阻止 Session extension start。普通 invalid/disabled/untrusted descriptor 多数进入 diagnostic 并保留可查询 snapshot。manager 可以保留 last-known-good snapshot，但不能把 failed refresh 宣称为新 generation。

## Plugin

Plugin 当前是声明式 `.runledger-plugin/plugin.json` 容器，只贡献受 containment 校验的 Skill 路径、Hook 定义和 MCP 配置。`PluginManager` 不加载可执行 plugin code，也不允许 plugin 注册任意 runtime tool、context source 或 cleanup callback；manager 在发布贡献前同时校验 state、trust 和内容 digest。

Plugin enable/disable/trust/untrust 是 Session resource mutation，经 expected revision 和 attempt barrier 执行。插件贡献跟随 Session snapshot 生命周期；当前没有独立 plugin 进程或 executable-plugin cleanup authority，也不建立跨 Session 的隐式全局 registry。

可执行扩展有独立的 host 子进程与分发面，见下文「Plugin 分发与 marketplace」与「Extension host」两节。上面的约束只描述**声明式容器本身**：`PluginManager` 仍然不加载可执行代码、不注册任意 runtime tool。

## Skills

Skill registry 聚合受支持 provider 的发现结果，catalog 暴露安全 summary，`SkillToolResolver` 在实际加载时再次检查 policy/trust/digest。模型只有通过 `Skill` tool 才得到被选 skill 的正文；catalog presence 不会把所有 skill 内容预先注入 prompt。

Session domain 从 Extension context sources 组装必要的 catalog/prompt fragment。policy 类型和 resolver 支持 user/workspace 两层且 workspace 只能收窄；当前标准 Session 组合只加载并持久化 user-level provider policy，workspace-scoped provider mutation 明确返回失败，不能把 schema 支持当成已接通的生产写路径。

## Hooks

`RuntimeHookAdapter` 与 `ExtensionTurnLifecycle` 把 UserPromptSubmit、PreToolUse、PostToolUse 等 lifecycle 事件路由到当前 snapshot。Hook 可以 deny 或返回修改后的输入；修改工具输入时 Core 必须再次走 authorization。pipeline 也能解析并审计 `additionalContext`，但当前 `InteractiveSessionController` 尚未把它注入生产模型上下文。

Hook runner 使用 governed managed process，并继承取消与输出上限。abort 始终阻断；timeout、协议错误、非零退出或 oversized output 按 effective `failureMode` 处理：`closed` 拒绝，`open` 记录 bounded diagnostic 后继续。turn cancel 与 Session shutdown 会终止仍在运行的 hook invocation。

## MCP

`McpConnectionManager` 从 canonical config 启动 Session 私有 server connections，并投影 server/tool catalog。Agent 只注册固定的 `mcp_catalog`、`mcp_search` 和 `mcp_call` gateway tools；外部 MCP tool 不直接进入 Agent registry，而是通过 `mcp_call(serverId, toolName, input)` 间接执行。required server 启动失败会阻止 Session extension start；optional server 失败保持可诊断状态。

MCP transport 使用 Session 注入的 execution/network adapter。`mcp.restart` 是受 attempt barrier 保护的 mutation；list/doctor 是 query。`mcp_call` 仍经过 Agent hook、`ToolAuthorizationPolicy` 和独立 `external_mutation` attempt，不能因目标来自外部 server 而变成未记录的直连调用。

## LSP

LSP 是独立的 model-facing tool，但其 process spawn 与写操作由 Session process client 和 governed filesystem 提供。client cache 以 Session scope 隔离，在 domain shutdown 时清理；LSP server existence 不产生跨 Session authority。

## 启动与关闭顺序

```text
load extension snapshot
  -> start MCP connections
  -> expose tools/hooks/context sources
  -> admit turns against a fixed snapshot
  -> stop admission
  -> close MCP
  -> close hooks
  -> release declarative plugin snapshot
  -> run remaining cleanup
```

shutdown 是幂等 promise。fenced Runtime 也执行资源终止，但不能在清理过程中以旧 generation 提交新的 durable mutation。

## Plugin 分发与 marketplace

分发面与上面的声明式 Plugin 容器是**两层**，不是一个系统：

- **分发账本**：`<home>/state/extensions/plugins/` 下的 `registry.json`（RunLedger 自有）、`marketplaces.json`（Claude 兼容字段，登记版本 1）与 `installed_plugins.json`（登记版本 2）。内容按 `<scope>/packages/<packageId>/<version>/` 版本化落盘，未知顶层键读写时保留，损坏文件 fail closed 而不是重置用户数据。
- **安装**：`staging → digest → 同设备原子激活`，任一步失败清 staging。不运行包管理器，也不执行任何 lifecycle script——声明了 `preinstall`/`install`/`postinstall`/`prepare`/`publish` 的包在安装期直接拒绝。`git`/`url` 源经该会话的受治 managed process 执行 clone/fetch，网络策略默认拒绝；`git-subdir` 用 containment 校验的存储适配器落位。
- **安装、启用、信任三者分离**：安装只落盘 + 记 digest；启用只改账本位；host 只在 `enabled + 当前内容的 trust receipt + 有 entrypoint + host 未 failed` 全满足时才启动。内容变化会让旧 receipt 变 stale，缺失/stale/revoked 分别有独立诊断码。
- **回灌**：已安装的**声明式**包会被投影为既有 `PluginManager` 的发现根，因此安装后 `plugin.list` 立刻可见，但仍是 `disabled` + `untrusted`，直到用户显式信任并启用。分发包的权威 manifest 是 `package.json#runledger`；`.runledger-plugin/plugin.json` 只是发现容器。
- **自动更新模式**：user 层 settings 的 `marketplace.autoUpdate`（`off`/`notify`/`auto`，缺省 `off`）决定行为。`notify` 需要一个真实可见出口，这里有两个：`marketplace discover` 返回的 `pendingUpdates`，以及 TUI 打开 `/plugins` 时的 notice；`auto` 只刷新 catalog 与可见信号，**绝不**代替用户安装、启用或信任（D7/D10）。非法模式与 `agentMode`/`compaction` 一样 fail loud，不静默降级。
- **TUI 侧边界**：TUI 里所有会落盘/改账本的动作都先经过确认视图，确认后才下发 mutation。`t`（信任/取消信任，独立 Skill 用 `skill.trust`/`untrust`）在取消后回到同一个 toggle 视图；`/plugins install|upgrade <spec>` 与 `/plugins config <plugin-id> <key> <value>` 同样先确认，取消不触碰端口。打开 `/plugins` 时会把 `marketplace.discover` 的待更新项转成一条 notice。安装/升级仍然不启用、不信任，且在同一 session 内不改写声明式视图（新 session 生效）。
- **feature 选择域**：`package.json#runledger.features[]` 声明 `{name, description?, default?}`（上限 64），是 plugin 内部可选能力的**选择域**，不是权限来源。`enabledFeatures: null` 表示只启用 `default: true` 的声明，`[]` 表示全关，非空数组是精确集合；安装语法 `name[a,b]`/`name[*]`/`name[]` 与 `plugin features set` 写的是同一个字段。切换 feature 只改账本这一处，既不启用也不信任 plugin；选择未声明的名字返回 `feature_unknown` 而不是静默裁剪。

## Extension host

可执行扩展在 **session 私有的 host 子进程**内运行，由既有 governed managed process 创建；模块工厂在该进程内求值，注册结果经版本化 JSONL 协议（每帧带 `protocolVersion` 与 `generation`）序列化回 owner。owner 侧不做任何进程内 fallback：host 退出、协议违规或超预算只让该 generation `failed`，session 继续。

- 扩展工具经准入投影为带 provenance 的 `AgentTool`；未在 `capabilities.tools` 声明、与 stdlib 保留名冲突、与其它扩展冲突、runtime name 非法或参数 schema 超界（含 `$ref`/`$defs`/`pattern`）的注册一律拒绝，不自动改名、不静默遮蔽。准入后的工具在 host 握手完成后经既有 Session-owned 工具通道追加，authorization policy 动态读取当前工具集，因此新工具不会被静默拒绝。
- 工具 handler 只存在于 host 进程内，经 `tool:<runtimeName>` 请求调用；未注册/抛错/超时各自返回明确失败码，host 不因单次工具失败退出。
- 事件是 canonical event 的**投影**：按事件白名单裁剪载荷，凭据形状键额外硬拒绝，超限整条拒绝而不截断。`PreToolUse` 的 `updatedInput` 只在该事件合法且强制要求重新授权。
- 运行时动作（`sendMessage`/`setModel`/`setActiveTools`/`exec` 等）在 owner 侧按 `(generation, action, requestId)` 记回执：同 ID 同体重放命中回执、异体是 conflict、结果不确定记 `uncertain_outcome` 且不重试。生产组合经晚绑定的 actor 持有者接通了 `sendMessage`（以 `origin:"runtime"` 入 follow-up 队列，不冒充真实用户输入）、`setModel`（按 provider/model 精确匹配可用模型）与 `setThinkingLevel`；`setActiveTools`/`setSessionName`/`exec`/`appendEntry` 仍**各自带原因**返回 `session_command_unavailable`，`intent` 只记审计。

## 稳定边界

- descriptor、enabled、trusted、loaded 和 model-visible 是不同状态。
- Extension resource operations 只通过 Session protocol 暴露；TUI 不直接持 manager/MCP client。
- 安装不授予执行；分发账本不替代 trust receipt。
- 扩展只能提交 intent，不能直接影响 presentation，也没有 UI context。
- 扩展拿不到 store/settings/trust 句柄，动作只能经 owner 的帧协议请求。
- child Agent 当前不继承 MCP/Hook/Skill/Plugin，只从 production tools 投影明确只读能力。
