# Tools、Security 与 Process

本子系统拥有 model-facing tool 定义与注册、`ExecutionEnv`、生产 tool composition、权限/批准决策、`ExecutionGateway`、managed process/PTY 以及最终 I/O leaf。工具可见性、调用授权和副作用执行是三个独立层次。

源码入口：[`src/runtime/tool-registry.ts`](../../src/runtime/tool-registry.ts)、[`src/runtime/execution-env.ts`](../../src/runtime/execution-env.ts)、[`src/runtime/tools/`](../../src/runtime/tools)、[`src/security/`](../../src/security)、[`src/runtime/process/`](../../src/runtime/process)、[`src/runtime/session-runtime/process/`](../../src/runtime/session-runtime/process)。

## AgentTool 与 registry

`AgentTool` 把 model-facing name/description/parameters 与 host-side `execute()`、只读声明、capability claims 和展示 metadata 绑定。模型只接收工具 schema；执行函数、Security object、cwd native path 和 receipt identity 不进入模型输入。

`ToolRegistry` 以 namespace + name 注册工具，并输出 `AgentContext.tools`。同 namespace 同名注册是 first-wins，被拒的那次记入 `listConflicts()`；不允许静默丢弃的组合点改用 `registerStrict()` 直接抛错。registry 管理发现与选择，不授予执行权限；工具在 prompt 中可见后仍要经过 hook、authorization 和最终 leaf 检查。

工具名别名（`src/runtime/tool-name-aliases.ts`）只在**调用解析**时生效：模型发出的 `toolCall.name` 先按别名表解析（如历史 `find` → `glob`），再匹配规范名。别名不会新增注册条目，也不改变 provider 看到的工具表；admission 按工具实例身份判定，因此别名调用与规范名调用的授权结果一致。

## Production tool composition

`createStdlibTools()` 可以构造 read/write/edit/multi-edit/bash/grep/glob/ls/web-fetch/todo、可选 permission/process tools 以及兼容工具；`todo` 经注入的 `ledger` 选项持久化。标准 Session domain 强制传入 `requireExecutionEnv: true`，再显式排除 demo/placeholder 工具，并叠加 LSP、Extension Skill、MCP 和可选 bounded-subagent tool。

生产工具集由 [`productionSessionTools()`](../../src/runtime/session-runtime/domain.ts)与 Session extension composition 共同决定。新增工具文件但不在这里组合，不会让标准 CLI 自动获得该能力。

工具可见 schema 是**版本化**的：`tools.mode === "allowlist"` 的 Harness Profile（`minimal`、`plan`）把被投影工具的 name/description/parameters 摘要冻结在 [`frozen-manifests.ts`](../../src/runtime/harness-profiles/frozen-manifests.ts)，投影与 receipt 重放都按它 fail closed。因此任一被投影工具的描述或 schema 变化都必须**新增 profile version**，而不是改写既有版本的摘要；旧版本条目继续为已存在 Session 的重放服务。`standard` 是直通投影，工具表增长不需要新版本。

## ExecutionEnv

`ExecutionEnv` 聚合 cwd-bound `FileSystem`、`Network` 与 `Shell` port。低层测试可以使用 `localExecutionEnv()`；生产 Session 使用 Security composition 返回的 governed implementation。

Read/grep/glob/ls 经 governed filesystem/shell 读取（`glob` 的 `.gitignore` 读取也走同一 governed fs port）；write/edit/multi-edit 经 governed filesystem 修改；WebFetch 经 governed network；Bash 与 process tools 经 governed shell/managed process；`todo` 写入注入的 `LedgerSink`。工具不得在 execute 内另开 raw filesystem、fetch 或 child process 作为 fallback。

`read` 接受内联行选择器（`file:A-B`、`file:-N`、多段、`:raw` 复合）。**未实现的模式**（`:conflicts`、`:img`）与非法选择器一律报错，而不是静默放宽成整文件读取。

## 新增 model-facing tool 的准入清单

1. 在 `src/runtime/tools/<name>.ts` 定义 `AgentTool`，并声明 `capabilityClaims`（缺 claim ⇒ Plan Mode 一律 `plan_mode_unknown_effect` 拒绝）。
2. 在 `createStdlibTools()` 注册，或在组合点显式注入（`Session domain` 的 base/governed 工具表，或 `controller.addTools`）。工具不得只在 `ToolRegistry.register` 里出现却不进组合。
3. admission 门禁按 Session 组合出的工具实例身份判定；组合点必须把该实例纳入注入的工具集，否则调用会被拒。
4. 判定是否进入 `minimal`/`plan` allowlist；若进入，按上文新增 profile version 并同步冻结摘要。
5. 判定 access classification（`src/security/permission/access-resolver.ts`），否则该工具落进不透明的 `{kind:"tool"}` 分支，filesystem/network 规则不再适用。
6. 补展示：TUI `rendererForTool` 的显式登记（`tests/tui/presentation/tools/projector.test.ts` 的登记表会因未登记而失败）与 Web `RENDERERS`。
7. 更新 golden/digest 测试（`tests/runtime/session-runtime/harness-profile-standard.test.ts`、`tests/stdlib-tools.test.ts`）与本页。

## 调用流水线

```text
assistant ToolCall
  -> schema/input preparation
  -> Extension PreToolUse hook
  -> ToolAuthorizationPolicy
  -> AgentTool.execute()
     -> capability-specific governed port
     -> capability-specific authorization and receipt protocol
     -> final-leaf effect
  -> overflow/artifact handling
  -> Extension PostToolUse hook
  -> ToolResult message
```

filesystem/network 的副作用端口先创建稳定 attempt，再由 `ExecutionGateway` 完成 permission/approval/constraint resolution、final-leaf revalidation、effect 与 settlement。managed process spawn 则先执行 Security prepare（含 Bash AST、sandbox/constraint 与 gateway authorization），再 begin attempt、创建 process，并在 spawn 前做 final-leaf revalidation；两条路径不能被压成一个虚假的固定顺序。

Read-only 调用仍受 workspace containment 和 policy 约束；会改变外部状态的调用按各自合同保留 attempt 或 control-plane receipt。PreToolUse 改写参数时必须重新授权，PostToolUse 不能把未执行的 effect 伪装为 committed。

## Security snapshot

每个 owned Session 由 `createSessionSecurity()` 解析一次 effective snapshot。snapshot 包括 permission profile、approval policy/reviewer、filesystem/network/sandbox mode、managed constraints、Bash analyzer 与 policy digest。

`PermissionEngine` 判断 access request，`ApprovalCoordinator` 处理一次性批准和 grant，constraint providers 解析 filesystem/network/process/sandbox 限制，`ExecutionGateway` 汇合这些结果。workspace 层只能收窄上层约束；未知、冲突、过期或 unavailable capability 均 fail closed。

## Approval 与 permission request

需要用户决定时，生产 prompter 通过 Session reverse request 把安全投影发给当前 driver。批准结果写入 Session-owned state/audit；断连、超时、fence 或非 driver 回答都不能产生授权。

`request_permissions` 是模型请求能力的显式工具，它仍受 profile ceiling 与 managed constraints 限制。缺少生产 approval ports 的组合使用拒绝型 headless prompter，而不是 AllowAll。

## Bash analyzer 与 sandbox

Bash command 先经 analyzer 分类，再由 gateway 解析执行约束。限制性 sandbox backend 必须先通过 capability probe；请求限制性 sandbox 而 backend unavailable 时拒绝执行，不降级到 raw shell。

Linux 使用可探测的 bubblewrap backend，macOS 使用可探测的 Seatbelt backend，Windows 明确返回 sandbox unavailable。平台标签与 backend existence 不等于 enforcement 已发生，最终 receipt 必须保留实际 resolution。

## Managed process 与 PTY

Session process composition 拥有 process journal、前台/后台执行、bounded output、wait/stop/write/resize、completion delivery 和 takeover recovery。process spawn 使用 side-effect attempt barrier；stdin/eof/resize/stop 使用 control-plane receipt 与 domain revision，而不另开普通 tool attempt。process handle/output cursor 有独立的 Session domain API。

PTY backend 在 Linux/macOS 的生产 composition 中显式接入 `node-pty`，Windows 不提供。该 adapter 的 descendant-tree containment capability 是 `none`，因此请求强 containment 时必须拒绝；当前只有 Linux standard path 有真实 runner 准入，不能把 macOS 源码接线写成已验证。缺少 backend 或 command resolver 时返回 unavailable。输出 ring/page、并发 process 数、stdin frame、wait 和 completion batch 都有协议上限，调用方必须分页或 resync，不能要求无限保留。

owner crash 后不能仅凭 PID 或 PTY handle 宣称安全 reattach。journal/receipt/liveness 证据不足时 outcome 标记 uncertain，并由 recovery flow 处理。

## 稳定边界

- 工具 schema 不是 authority；tool registry 不是 sandbox。
- permissive `AllowAllToolAuthorizationPolicy` 只保留给低层测试/兼容构造，标准 Session domain 注入 governed policy。
- restrictive sandbox unavailable 时不 fallback；sandbox off 是用户/策略明确选择的不同状态。
- TUI 只渲染 tool/process projection 并发出协议命令，不持有 raw process handle。
