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

## 稳定边界

- descriptor、enabled、trusted、loaded 和 model-visible 是不同状态。
- Extension resource operations 只通过 Session protocol 暴露；TUI 不直接持 manager/MCP client。
- child Agent 当前不继承 MCP/Hook/Skill/Plugin，只从 production tools 投影明确只读能力。
