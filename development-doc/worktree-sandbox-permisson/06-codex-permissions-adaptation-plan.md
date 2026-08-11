# RunLedger 对 Codex permissions 体系的适配计划

> 文档属性：本主题唯一权威入口；与 [`00-worktree-sandbox-permission-plan.md`](00-worktree-sandbox-permission-plan.md) 属同一专项，本文只针对“从 codex checkout 提取的 permissions 语义”做适配路线，不替代 00 的 Worktree/Sandbox/Approval 主体计划。
>
> 建立日期：2026-08-11。
>
> 参考基线：本地 codex checkout `0b175e6439a8608ba7726ee153fd8590619e8f34`（2026-07-21，与 00 计划同一基线），主要读取：
>
> - `codex-rs/protocol/src/permissions.rs`（3218 行）—— `FileSystemSandboxPolicy` / `FileSystemPath` / `FileSystemAccessMode` / `FileSystemSpecialPath` / `ReadDenyMatcher` / `PROTECTED_METADATA_PATH_NAMES`；
> - `codex-rs/protocol/src/models.rs` —— `PermissionProfile`（`Managed` / `Disabled` / `External`）与 `ActivePermissionProfile`、内置 profile 构造器；
> - `codex-rs/protocol/src/approvals.rs` —— `ExecApprovalRequestEvent` / `NetworkApprovalContext` / `NetworkApprovalProtocol` / `NetworkPolicyAmendment` / `ExecPolicyAmendment` / `GuardianAssessmentEvent`；
> - `codex-rs/protocol/src/request_permissions.rs` —— `RequestPermissionsArgs` / `PermissionGrantScope` / `RequestPermissionProfile`；
> - `codex-rs/protocol/src/protocol.rs` —— `AskForApproval`（含 `Granular(GranularApprovalConfig)`）、`ReviewDecision`、`NetworkAccess`；
> - `codex-rs/protocol/src/network_policy.rs` —— `NetworkPolicyDecisionPayload`；
> - `codex-rs/config/src/permissions_toml.rs` —— `PermissionsToml` / `PermissionProfileToml` / `FilesystemPermissionToml`（Access/Scoped）/ `NetworkToml` / `WorkspaceRootsToml` 与 profile extends 继承合并；
> - `codex-rs/core/src/config/permissions.rs` —— TOML → runtime policy 编译（`compile_permission_profile`、glob 平台告警、`glob_scan_max_depth`）；
> - `codex-rs/core/src/config/mod.rs` —— `Permissions` 运行时聚合（approval_policy、permission_profile_state、workspace_roots、network、shell_environment_policy）；
> - `codex-rs/core/src/config/resolved_permission_profile.rs` —— `PermissionProfileSnapshot` / `BuiltInPermissionProfileId`（read-only / workspace / danger-full-access）；
> - `codex-rs/core/src/tools/approvals.rs` —— approval 决策路由（hook → guardian → user）与 `ApprovalAction`；
> - `codex-rs/core/src/tools/sandboxing.rs` —— `ApprovalStore`（session-scoped 缓存）、`ExecApprovalRequirement`、`default_exec_approval_requirement`、`Approvable` / `Sandboxable` / `ToolRuntime` trait、`SandboxAttempt`；
> - `codex-rs/core/src/tools/network_approval.rs` —— `NetworkApprovalService`（host-key 去重、session approved/denied 集合、allowlist miss → review 流）；
> - `codex-rs/tui/src/chatwidget/permission_popups.rs` / `permissions_menu.rs` —— TUI 权限模式选择与 approval popup 的 UX 行为；
> - `codex-rs/prompts/templates/permissions/` —— approval_policy（never / on_request / unless_trusted）与 sandbox_mode（danger_full_access / read_only / workspace_write）注入 system prompt 的文本。

参考仓库不是待复制的模板（沿用 00 计划第 0.2 节结论）：RunLedger 是 Node.js/TypeScript 单包，不移植 Rust crate 拆分、exec-server、guardian 自动评审、Landlock/Seatbelt/Windows Restricted Token 全套，也不移植 TOML 生态与 schema 生成。本计划提取的是**权限语义、状态机、决策顺序与测试方法**。

## 1. 目标

在保留 RunLedger 现有 `src/security/**`（config 分层 / PermissionEngine / ApprovalCoordinator / ExecutionGateway / PolicyFileSystem / PolicyNetworkClient / sandbox 冻结面）fail-closed 边界不变的前提下，对齐 Codex permissions 的以下能力语义：

1. **权限 profile 与 approval policy 的分离与组合**：`AskForApproval` 四态（untrusted / on-request / granular / never）与 `PermissionProfile` 三态（Managed / Disabled / External）各自独立约束；
2. **filesystem 权限条目的精确语义**：read / write / deny 三态、special path token（`:root` / `:minimal` / `:workspace_roots` / `:tmpdir` / `:slash_tmp`）、deny glob 与 `glob_scan_max_depth`、受保护元数据路径（`.git` / `.agents` / `.codex` 类比 RunLedger 的 `.git` / `.runledger`）、symlink 候选匹配与 TOCTOU 双校验；
3. **named permission profile 与 extends 继承**：用户可定义 `[permissions.<id>]`，extends 解析内置 profile，cycle/undefined 拒绝，保留 source；
4. **approval 决策序列与 session 级缓存**：hook → 规则 → 用户 prompt，`ApprovedForSession` / `ApprovedExecpolicyAmendment` / `NetworkPolicyAmendment` 三档持久化粒度（RunLedger 现只有 allow-once 一档）；
5. **网络策略域模型**：host + protocol（http/https/socks5-tcp/socks5-udp）+ port 的精确 key，allowlist miss → 可审批升级，session 级 host approve/deny 缓存，`NetworkPolicyAmendment` 持久规则；
6. **exec 前缀规则（execpolicy）**：`prefix_rule(..., decision="allow")` 语义 → RunLedger 的 shell 规则实现；
7. **granular approval 控制**：`GranularApprovalConfig` 对 sandbox_approval / rules / skill_approval / request_permissions / mcp_elicitations 的独立开关；
8. **request_permissions 工具**：agent 主动请求提升权限（session / turn / one_off 三种 grant scope）；
9. **模型提示注入**：approval policy 与 sandbox mode 文本注入 system prompt，指导模型何时用 `require_escalated` / `justification` / `prefix_rule`，以及 banned prefix_rule（heredoc、rm 等）。

显式不实现（与 00 计划一致，冻结面不触碰）：

- guardian 自动评审与 reviewer 路由（RunLedger 无 cloud/guardian 服务）；
- exec-server、unified_exec、network proxy MITM/注入头/钩子；
- Windows sandbox 细化、Linux landlock 后端新增；
- TOML 格式本身（RunLedger 继续用 JSON settings，但可接受等价的 schema 语义）；
- profile 的 `description` 元数据向模型展示的完整提示模板体系（只做最小等价文本）。

## 2. 与 RunLedger 现状的差异对照

### 2.1 概念映射

| Codex 概念 | RunLedger 现有 | 差距 |
|---|---|---|
| `AskForApproval`（untrusted/on-request/granular/never） | `ApprovalPolicyName = "on-request" \| "never"` | 缺 untrusted 与 granular 两态 |
| `PermissionProfile`（Managed/Disabled/External） | `PermissionProfileName = read-only/workspace-write/headless-workspace/danger-full-access/custom` + `SecurityProfile` | 有 profile 名但无 External 语义；headless-workspace 是 RunLedger 独有（保留） |
| `FileSystemSandboxEntry`（path+access，access∈read/write/deny） | `FilesystemPolicy.readRoots/writeRoots/denyRead/denyWrite/protectedPaths` 四数组 | 语义接近，但缺“同一路径上的 read 与 write 同条目竞争优先级”模型；RunLedger 的 protectedPaths 独立于 deny |
| `FileSystemSpecialPath`（:root/:minimal/:workspace_roots/:tmpdir/:slash_tmp） | `:workspace` / `:tmp` / `:runledger-temp` token | 需补 `:root` / `:minimal` / `:slash_tmp`；`:workspace_roots` 子路径 scoped 条目 |
| `FileSystemPath`（Path/GlobPattern/Special） | resolveToken 直接 resolve | deny glob 只匹配子树/通配符，无 GlobPattern 一等类型 |
| `ReadDenyMatcher`（精确候选 + glob matcher，fail-closed 坏模式） | `wildcardPathMatch`（policy-filesystem.ts 内联） | 有等价物但语义零散；需抽出独立模块与 fail-closed 规则 |
| `PermissionProfileToml.extends` 继承 | 无 profile 定义，只有扁平 document | 需新增 named profile 定义层 |
| `ApprovalStore`（session 缓存 ReviewDecision by Serializable key） | `MemoryApprovalStateStore`（receipt by approvalId，once scope） | 缺 session 级 approve 缓存；`ApprovalTicket.scope` 只有 `"once"` |
| `ReviewDecision` 七态 | `PermissionPromptResponse` 三态（allow-once/deny/cancel） | 需补 session 级与 amendment 态 |
| `NetworkApprovalContext`（host+protocol） | `AccessRequest.network{operation,host,port}` | 缺 protocol 维度与 port 默认值语义 |
| `NetworkApprovalService`（host key 去重 + session 缓存 + allowlist miss 升级） | `PolicyNetworkClient` 纯 allowlist/deny，无升级流 | 需在 ApprovalCoordinator 侧补网络升级路径 |
| `ExecPolicyAmendment`（prefix 规则） | `SecurityRule` shell 规则（pattern 通配） | 需补“批准时附带持久前缀规则”的原子性 |
| `GranularApprovalConfig` | 无 | 需新增 |
| `RequestPermissionsArgs` | 无 request_permissions 工具 | 需新增工具或等价 internal 端口 |
| protected metadata（.git/.agents/.codex） | `protectedPaths` 默认 `.git` / `.runledger` | 等价，保留 RunLedger 默认并允许配置扩展 |

### 2.2 决策顺序对照（关键差异）

Codex 的决策链（`default_exec_approval_requirement` + `resolve_tool_apporval` + `Approvable`）：

```text
AskForApproval::Never                       -> Skip(bypass_sandbox=false)
AskForApproval::OnRequest, policy Restricted -> NeedsApproval
AskForApproval::OnRequest, policy 非 Restricted -> Skip
AskForApproval::UnlessTrusted               -> 总是 NeedsApproval（除只读快路径）
Granular(g)                                 -> g.allows_sandbox_approval() 为 false 时 Forbidden，否则按 OnRequest
已批准 key（ApprovalStore）                 -> Skip（不再问）
```

关键语义差异：

1. Codex 的 approval 决策与 filesystem policy 是否 Restricted **联动**：`OnRequest` 在 Unrestricted 下不弹窗；RunLedger 的 engine 是 `deny > ask > allow` 全局聚合，profile 的 `filesystemMode=unrestricted` 只影响 root 边界，write 仍返回 ask（`engine.ts:36` builtin-write-approval）。这是**语义分歧点**，适配时必须决策：RunLedger 是否采用“unrestricted 时 OnRequest 不 ask”的 Codex 语义。建议采用（对齐 danger-full-access 的“无弹窗”直觉），但保留危险命令硬性 ask（`builtin-shell-dangerous`）作为 RunLedger 加固（Codex 依赖 sandbox 本身约束子进程，RunLedger sandbox 冻结，只能靠软件层兜底）。
2. Codex 的 filesystem 条目是“路径 → 单 access”查表（`resolve_access_with_cwd`），同路径 read/write 冲突按 `deny > write > read` 强度；RunLedger 的四数组模型对同路径同时出现在 readRoots 与 denyRead 时的结果等价（guard 先查 protected/deny 再查 roots），但无显式强度比较。适配时把规则编译成 entries 模型，统一强度语义。
3. Codex 的 `ApprovedForSession` 缓存 key 是序列化的精确请求（bash 的 command+cwd 等）；RunLedger 需要把 `ApprovalTicket.scope` 扩展为 `"once" | "session"`，并在 session 级缓存用“规范化请求 digest”做 key，杜绝 prefix 误匹配。

## 3. 总体设计

### 3.1 保留不动（现状冻结面）

- `src/security/execution-gateway.ts`、`policy-filesystem.ts`、`policy-network.ts`、`integration/**` 的 fail-closed 结构；
- `src/security/sandbox/**` 冻结（00 计划 4.7）；
- `src/worktree/**` 与 `src/workspace/**` 平台适配（01 计划）；
- Runtime 公共契约（`src/runtime/contracts/**`）—— 若需要新事件/新 scope 枚举，先回 Runtime contract 计划提交 schema，再在本计划消费。

### 3.2 新增/修改结构

```text
src/security/
  types.ts                        # 修改：ApprovalPolicyName 增 "untrusted"|"granular"；ApprovalTicket.scope 增 "session"；
                                  #      NetworkAccessProtocol；RequestPermissionGrantScope；ExecPrefixRule
  config/
    schema.ts                     # 修改：接受 profile 定义段（named profiles + extends）；granular 配置
    resolver.ts                   # 修改：编译 named profile 继承（extends 解析内置，cycle/undefined 拒绝）
    profile-compiler.ts           # 新增：TOML/JSON 条目 -> FileSystemPolicyEntry[] 编译，含 special token、glob 分类、强度校验
  permission/
    filesystem-entries.ts         # 新增：FileSystemPolicyEntry 模型 + resolve_access_with_cwd + deny>write>read 强度 + 候选拼写匹配
    read-deny-matcher.ts          # 新增：ReadDenyMatcher 等价（精确子树 + glob matcher + 坏模式 fail-closed）
    engine.ts                     # 修改：接 entries 模型；approval 决策与 profile 联动（unrestricted+on-request 语义）
    approval-coordinator.ts       # 修改：scope=session 的 ApproveForSession；Amendment 决策原子写入规则集；
                                  #      network approval 升级流；granular 开关；exec prefix 规则提交
    grants.ts                     # 新增：request_permissions 的 session/turn/one_off grant 状态
  network/
    network-approval.ts           # 新增：host+protocol+port key、session approved/denied 集合、allowlist miss 升级（NetworkApprovalService 等价）
  tools/
    request-permissions.ts        # 新增：AgentTool（或 internal port），把 grant 请求接入 ApprovalCoordinator
  integration/
    runtime-tool-authorization.ts # 修改：接新决策序列与 session 缓存
    runtime-security-events.ts    # 修改：permission.decided payload 携带 scope/amendment 摘要（schema 先回 contract 计划）
  prompts/
    permissions-prompt.ts         # 新增：把 approval policy + sandbox mode 文本拼入 systemPrompt（对应 codex prompts/templates/permissions）

tests/security/
  filesystem-entries.test.ts      # 强度/候选拼写/TOCTOU
  read-deny-matcher.test.ts       # 坏模式 fail-closed / glob 语义
  profile-inheritance.test.ts     # extends/cycle/undefined/named+buildin
  approval-session-scope.test.ts  # ApproveForSession 缓存 key / prefix 误匹配防护
  network-approval.test.ts        # host key / session 集合 / allowlist miss 升级
  granular-approval.test.ts       # 各开关拒绝路径
  request-permissions.test.ts     # grant scope 生命周期
  exec-prefix-rule.test.ts        # 前缀规则持久化原子性
  permissions-prompt.test.ts      # 提示文本注入与 banned prefix 指引
```

### 3.3 阶段划分（每阶段一个可独立审阅提交）

- **P1 语义冻结与单测先行**：新增 `filesystem-entries.ts` + `read-deny-matcher.ts` + `profile-compiler.ts`，只做纯函数编译/匹配，不改 engine；补全 special token 与 deny glob 语义；跑既有 `tests/security/**` 回归。
- **P2 engine 联动与 granular**：engine 接 entries；approval policy 增 untrusted/granular；OnRequest 与 unrestricted 联动（保留危险命令 ask）；granular 各开关。
- **P3 approval session scope 与 amendment**：`ApprovalTicket.scope="session"`；ApproveForSession 缓存；ApprovedExecpolicyAmendment / NetworkPolicyAmendment 原子提交到 rules 层（写时携带 source=session 与 policyDigest 重算）；revalidation 覆盖 scope。
- **P4 network approval 服务**：network-approval.ts + PolicyNetworkClient 升级路径（allowlist miss 不再直接 deny，改 ask）；session 集合持久化到 Event Store（先 memory，后接 contract schema）。
- **P5 request_permissions 与提示注入**：request-permissions 工具；grants 状态机；permissions-prompt.ts 接入 AgentContext systemPrompt。
- **P6 串行集成与 E2E**：runtime-tool-authorization 接全部新决策；CLI/TUI 的权限模式选择与 approval popup 展示 scope/amendment 选项；集成窗口规则遵循 00 计划 3.1。

### 3.4 验收门禁

- 每个阶段：`npm run check`（含 check-platform-boundaries）+ `npm test` 全绿 + `npm run build`；
- 行为等价抽查：`tests/security/current-boundary.test.ts` 与 `current-runtime-boundary.test.ts` 不得因适配放宽任何 fail-closed 断言；
- 门禁证据：本计划的 P1–P5 单测 + P6 E2E 与 00 计划既有 35+ 测试共同构成。

## 4. 核心契约草案

以下为实现侧草图，不要求逐字照抄；跨模块可见类型仍以 `src/security/types.ts` 与 Runtime 公共契约为准。

### 4.1 Filesystem entries（Codex FileSystemSandboxPolicy 等价）

```ts
export type FileSystemAccess = "read" | "write" | "deny";
export type FileSystemPathEntry =
  | { kind: "path"; path: string }                          // canonical absolute
  | { kind: "glob"; pattern: string }                       // deny-only
  | { kind: "special"; value: FileSystemSpecialPath };      // :root/:minimal/:workspace_roots(:sub)/:tmpdir/:slash_tmp
export interface FileSystemPolicyEntry { path: FileSystemPathEntry; access: FileSystemAccess }
export interface CompiledFilesystemPolicy {
  kind: "restricted" | "unrestricted";                      // External 由 sandbox 层表达
  globScanMaxDepth?: number;
  entries: FileSystemPolicyEntry[];
}
```

强度规则（与 Codex `has_same_target_write_override` 等价）：同目标冲突时 `deny > write > read`；**同级强度同目标**时按配置顺序后者胜出必须显式声明，默认“后写者覆盖”，但在 deny 与 read/write 冲突时一律 deny 优先。

### 4.2 Special path token

RunLedger 现有 `:workspace` / `:tmp`；补齐：

| token | 解析目标 |
|---|---|
| `:workspace` | 注入的 workspaceRoot（RunLedger 独有，保留） |
| `:root` | 文件系统根 `/`（Codex `:root`） |
| `:minimal` | 进程可执行与运行时最小依赖集（Node 可执行、npm 缓存等；RunLedger 第一版映射到 `<runledgerHome>` 与 node 安装根） |
| `:workspace_roots` / `:workspace_roots/<sub>` | 注入的 workspace roots 集合 + 可选子路径（映射 RunLedger 的 `:workspace`） |
| `:tmpdir` | `os.tmpdir()`（RunLedger 的 `:tmp`） |
| `:slash_tmp` | `/tmp`（仅 Linux） |

未知 `:token` 语义：**警告并忽略**（Codex forward-compatible 决定），但 RunLedger 的 fail-closed 配置解析保持“未知 token 在 deny/protected 上下文中拒绝启动”，因为 RunLedger 没有 sandbox 兜底。

### 4.3 Approval 决策状态（AskForApproval 等价）

```ts
export type ApprovalPolicyName = "on-request" | "never" | "untrusted" | "granular";
export interface GranularApprovalConfig {
  sandboxApproval: boolean;      // require_escalated / additional_permissions
  rules: boolean;                // execpolicy prompt 规则
  skillApproval: boolean;        // 技能脚本
  requestPermissions: boolean;   // request_permissions 工具
  mcpElicitations: boolean;      // MCP 表单/URL 请求
}
```

`untrusted` 语义：只读快路径之外全部 ask（对应 Codex `UnlessTrusted`）；`never` 语义保持“ask 转 deny”。

### 4.4 Approval 结果（ReviewDecision 等价）

```ts
export type ApprovalDecision =
  | { decision: "allow-once" }
  | { decision: "allow-session" }                       // ApprovedForSession
  | { decision: "allow-with-prefix-rule"; command: string[] } // ApprovedExecpolicyAmendment
  | { decision: "allow-with-network-rule"; host: string; action: "allow" | "deny" } // NetworkPolicyAmendment
  | { decision: "deny"; reason?: string }
  | { decision: "cancel" };
```

`ApprovalTicket.scope` 扩展：`"once" | "session"`；session 缓存的 key 为“规范化请求 digest”（同 toolCall 相关请求集合的稳定序列化），缓存命中仅当请求集合与缓存条目完全一致（不做 prefix 匹配，避免误批准）。

### 4.5 网络 approval（NetworkApprovalService 等价）

```ts
export interface NetworkApprovalKey {
  host: string;          // 规范化（小写、去尾点）
  protocol: "http" | "https" | "socks5-tcp" | "socks5-udp";
  port: number;          // 显式端口；缺省按协议默认（http 80 / https 443）
}
```

- `NetworkPolicy.mode` 增 `"review"`（allowlist miss → ask，等价 Codex 的 allowlist miss 升级流）；
- session 级 `approvedHosts` / `deniedHosts` 集合；
- `NetworkPolicyAmendment` 持久化为 `SecurityRule{kind:"network", pattern:host, action}` 并重算 policyDigest。

### 4.6 request_permissions

```ts
export type PermissionGrantScope = "one_off" | "turn" | "session";
export interface RequestPermissionProfile { filesystem?: FileSystemPolicyEntry[]; network?: ... }
```

第一版只实现 `session` 与 `one_off`；`turn` 依赖 turn 生命周期钩子（现 runAgentLoop 有 turn 边界，可接）。grant 必须绑定 profile/policyDigest，policy 重算后失效。

### 4.7 提示注入（codex prompts/templates 等价）

`src/security/prompts/permissions-prompt.ts` 输出拼接文本，按当前 `SecuritySnapshot.profile`：

- approval policy 文本（on_request / never / unless_trusted 的最小等价版）；
- sandbox mode 文本（danger_full_access / read_only / workspace_write）；
- `require_escalated` / `justification` / `prefix_rule` 的使用指引与 banned prefix_rule（heredoc、rm、危险命令禁止提 prefix_rule）。

## 5. 与现有计划的关系

- 00 计划（Worktree/Sandbox/Permission 主体）：本计划是它的 permissions 语义细化，不重复其 Worktree/Sandbox/Approval 生命周期内容；
- 01 计划（多平台 workspace/path）：filesystem entries 的 canonical path 解析与 symlink 候选拼写复用 01 的 platform adapter（`pathWithin` / compare key）；
- Runtime contract 计划：`permission.decided` 的 scope/amendment 字段与新的 `network.review` 事件必须先回 contract 提交 schema，本计划不私造公共类型；
- sandbox 冻结面（04/05 ADR）：本计划不改 sandbox backend；`External` profile 语义仅作为“sandbox 能力缺失时 fail closed 的显式声明”，不引入新 enforcement。

## 6. 风险与兜底

| 风险 | 兜底 |
|---|---|
| session 级 approve 缓存放大误批准面（与 RunLedger 的 allow-once 强化方向相反） | 缓存 key 用完整规范化请求 digest；危险命令与受保护路径永不进入 session 缓存；`approval-stale` CAS 语义保持 |
| `unrestricted + on-request` 联动使 write 免弹窗，绕过 00 计划“文件写需要 exact approval” | 危险命令（rm/chmod/chown/git push 等）与 protectedPaths 仍强制 ask；该联动只在 `danger-full-access` 类 profile 生效，且由 CLI 显式选择 |
| prefix rule 误匹配后续命令 | 前缀规则只按 token 序列匹配且必须显式批准时附带；heredoc/重定向/环境变量前缀一律拒绝（对应 Codex banned prefix_rule） |
| network review 流引入新弹窗面 | 默认 profile 的 network.mode 仍为 deny；`review` 只由显式配置启用 |
| grants 与 policy 重算竞争 | grant 绑定 policyDigest，snapshot 变化即失效并记录 permission.revoked |
| 既有测试语义漂移 | P1 起每阶段跑 `tests/security/current-*.test.ts` 回归，fail-closed 断言不得放宽 |
