# 三种权限预设与 TUI 设置实施计划

> 文档属性：`partial`。本计划是 [`00-worktree-sandbox-permission-plan.md`](00-worktree-sandbox-permission-plan.md) 的 UI/策略组合后续，消费 [`06-codex-permissions-adaptation-plan.md`](06-codex-permissions-adaptation-plan.md) 已落地的 config、PermissionEngine、ApprovalCoordinator 与 ExecutionGateway；不改变 00 中冻结的 OS sandbox 扩展范围。
>
> 建立日期：2026-09-02。
>
> 用户目标：在 TUI 中首先提供三个可理解、可审计的系统预设：**Ask for approval**、**Approve for me**、**Full Access**；完整的命名 profile、filesystem/network/rules/bash 设置随后才进入 Advanced。

## 实施状态（更新于 2026-09-04）

- 已落地（P1/P4/P5 的可验证切片）：三项 builtin preset、`approvalReviewer`、managed constraints、`SecuritySettingsPort` 的原子 CAS 保存、Session Owner 的 `security.settings.inspect/update`、workspace deny-only 收紧校验，以及唯一的 `/permissions` 三卡选择器和 Full Access 二次确认。
- Host inspection 会投影 reviewer、managed constraint digest、sandbox capability 与三项 preset availability；TUI 对 Host 标记 unavailable 的预设禁用选择。保存只作用于后续 Session，当前 immutable snapshot 不会被改写。
- 2026-09-04 复核修正已闭合六个安全缺口：启动 resolver 与 durable settings port 都禁止 workspace 扩大 user baseline；`headless-workspace`、`workspace-write`、`approve-for-me` 不再按相同粗粒度 rank 处理；切换系统预设会移除旧 `allow` rule；Approve for me 的 workspace 外写回落到精确 user approval；managed source 只以具体 constraints 限制候选值而不再冻结全部本地设置；deterministic reviewer 的 input/policy digest、generation、classification version、decision 与有界 reason 已写入 Session hash-chain event store。
- automated production evidence 已覆盖 canonical user/project settings 三预设、普通 workspace write、workspace 外 write 的 allow/deny/revoke、network review 拒绝不触达 raw broker、managed availability 与 auto-review durable audit。尚未完成：Advanced 的 Profile/Inheritance、Approvals/Granular、Filesystem、Network、Rules、Bash 与 Effective-policy 编辑页；`runledger security inspect`；人工跨平台验收。因此 P5（Advanced）与 P6 的 CLI/human 部分仍为 partial/pending，不能宣称计划整体完成。
- 2026-09-04 fresh evidence：security/session/TUI 宽集 42 files / 244 tests 通过（macOS-only 3 tests 按平台跳过）；完整 `npm run check`、`npm test`、`npm run build` 均 exit 0。全局链接解析到本仓库 `bin/runledger.js`；隔离 `RUNLEDGER_DIR` 的真实 tmux TTY 已捕帧验证三卡、Full Access confirm/cancel、Approve for me 保存与重新打开后的 current 状态，并以 Esc + Ctrl+D 干净退出。未读写真实用户配置。
- 后续修正（2026-09-02）：`/settings` 不再作为 permissions 的 alias；本分支的 `HEAD` 没有 SettingsWorkbench，完整历史实现位于分叉的 `session-owner-runtime@cb15812`，恢复它必须作为独立 settings-runtime 移植处理，不能用权限页替代。新增 `config-file-permission-presets.integration.test.ts` 在隔离 user/project `settings.json#security` 写入三个预设，并经 governed filesystem 实际写入目标文件；同时修复 `danger-full-access` 把正常 unrestricted write 错误变成 approval deny 的缺口。

## 0. 决策摘要

### 0.1 三张卡不是三个 approval 值

一个预设必须原子组合以下维度：

```text
profile / filesystem capability / network capability / sandbox target
    + approval policy / reviewer route / rules / protected paths
    -> immutable SecuritySnapshot(policyDigest)
    -> PermissionEngine -> ApprovalCoordinator -> ExecutionGateway -> final leaf
```

因此禁止把 TUI 的三张卡实现为只改 `approvalPolicy` 的快捷开关；也禁止把 oh-my-pi 的 `yolo` 解释成 `danger-full-access`。前者只是工具 tier 的 approval UX，不构成 filesystem、network 或 OS sandbox 边界。

### 0.2 系统预设及精确承诺

| TUI 文案 | stable preset id / resolved profile | 对用户的承诺 | 初始配置目标 |
|---|---|---|---|
| **Ask for approval** | `workspace-write` | 可在当前 workspace 读、编辑、运行已知安全命令；访问网络或编辑 workspace 外文件前询问。 | workspace read/write、network `review`（初始 hosts 为空）、sandbox `workspace-write`、`on-request` |
| **Approve for me** | `approve-for-me`（新增系统 profile） | 低风险且可验证的动作由本机 deterministic reviewer 代表用户批准；不确定、高风险、网络/路径越界仍询问。 | workspace read/write、network `review`、sandbox `workspace-write`、`on-request` + `approvalReviewer: auto-review` |
| **Full Access** | `danger-full-access` | 可编辑 workspace 外文件并访问网络，不显示常规 approval。 | unrestricted filesystem、network `allow`、sandbox `off`、`never` |

三者都不绕过以下边界：managed deny、硬性 shell deny、`protectedPaths`（至少 `.git`、`.runledger`）、canonical path/symlink 重验、ExecutionGateway 和 Host final leaf。`Full Access` 的“无 approval”含义是正常 `ask` 不再出现；它不是对这些不可提升 deny 的豁免。

### 0.3 用户面与内部 ID

- 首屏只显示上述三张卡；`read-only`、`headless-workspace`、命名 profile 与全部细项仅在 **Advanced / Custom** 中出现。
- `workspace-write` 和 `danger-full-access` 保留当前 stable ID；新增 `approve-for-me` 为内置 profile，不能被 settings 中同名定义覆盖。
- TUI 持久化选择的 profile ID，而非“第 1/2/3 项”的显示序号；显示文案可国际化，审计/恢复记录始终使用 stable ID。
- 运行中 session 永不改写其 snapshot。保存只影响下一次 create/resume；当前页显示“将在新会话生效”。

## 1. 当前基线与必须修复的语义差距

### 1.1 已有能力

- `src/security/config/schema.ts` 已接受 profiles、四种 approval policy、五项 granular 开关、五种 sandbox、network、filesystem、rules 和 bash analyzer；Host 从 managed、workspace canonical settings、user canonical settings 与 CLI 层加载 `settings.json#security`。
- `src/security/config/resolver.ts` 已有 `read-only`、`workspace-write`、`headless-workspace`、`danger-full-access`、`custom` 默认 profile，named profile 的 unknown parent/cycle fail closed，且生成带 `policyDigest` 的 snapshot。
- `src/security/permission/engine.ts`、`ApprovalCoordinator` 和 `ExecutionGateway` 已是生产工具的唯一授权链；`PolicyFileSystem` 会 canonicalize/revalidate path，`.git`/`.runledger` 默认受保护。
- 当前 TUI 有逐请求 approval 和只读 `session.security.inspect`，但没有完整 `/permissions` 管理页，也没有 session security mutation contract。

### 1.2 当前实现不能直接兑现三张卡文案

| 差距 | 现有行为 | 所需行为 |
|---|---|---|
| Ask for approval 的 workspace 编辑 | 普通 workspace write 产生 `ask`。 | 普通、已验证 workspace edit 自动 allow；危险/未知仍 ask。 |
| Ask for approval 的 workspace 外编辑 | root boundary 直接 `deny`；`request_permissions` 也不能提升 deny filesystem entry。 | 只有“普通 root boundary”可创建 **精确路径、精确 operation、一次性** 的 approval ticket；protected/managed/explicit deny 继续 deny。 |
| Approve for me | `untrusted` 当前把所有非 read 转为 ask；无 reviewer route。 | reviewer 只处理显式 eligible 的 ask；不可证明安全、失败、超时一律回到 user ask 或 deny。 |
| Full Access | 内置 profile 已接近目标。 | 保持 managed/protected/hardline deny；TUI 显示风险并要求二次确认。 |
| settings 落盘 | Host 能从 raw `security` section 读取；通用 `saveProjectSettings()` 会丢弃未知 `security` 字段。 | 单独的 Host-owned `SecuritySettingsPort` 做 schema 校验和原子 read-modify-write，TUI 不接触文件路径。 |
| named inheritance | 当前 resolver 会解析所有内置名为父级，包含 `danger-full-access`。 | 同 Codex profiles：允许继承 `read-only`、`workspace-write` 或命名 profile；禁止 `danger-full-access` 作为 parent，拒绝 unknown/cycle。 |

### 1.3 当前层级问题

managed source 不能只是一个可被 CLI 覆写的普通 config layer。实施时须把 managed policy 编译为 **constraints**：可选 profile 集、最小 sandbox、network deny、不可提升 deny 和最小 bash analyzer。CLI、user、workspace 只能在这些 constraints 内选择或进一步收紧。

最终优先级为：

```text
managed constraints (only restrict)
  > session/CLI one-shot request (can only restrict)
  > workspace canonical security (can only restrict user baseline)
  > user canonical security
  > builtin preset defaults
```

rules 不采用“后层 allow 覆盖前层 deny”：所有来源保留，针对同一 AccessRequest 的结果始终 `deny > ask > allow`。

## 2. 范围、非目标与不变量

### 2.1 本计划范围

1. 定义/解析/审计三个 immutable builtin permission presets。
2. 对齐第 0.2 节承诺所需的 approval/temporary escalation/reviewer 契约。
3. 把 `security` 的安全落盘、revision、snapshot 与 Host command 接通。
4. 实现 `/permissions` 三卡选择器与 Advanced read/edit flow。
5. 为每一预设建立 unit、Host integration、TUI interaction 与真实 TTY 验收。

### 2.2 明确非目标

- 不解冻 `04`/`05` ADR 中的跨平台 OS sandbox 扩展，不新增 Landlock、Seatbelt、Windows Restricted Token 或 raw shell fallback。
- 不把 LLM、外部 Guardian 服务或 provider 输出作为自动批准 authority；第一版 reviewer 是可审计、确定性的本机规则/分类器。
- 不允许 TUI client 直接读写 settings、创建 snapshot、发放 grant 或调用 raw `fs`/`spawn`/`fetch`。
- 不实现 profile 继承自 `danger-full-access`、持久“全局 allow all”、自动批准 protected path、自动批准 host allowlist miss。
- 不宣称 `strict`、`external` 在任何平台已经被 OS 强制执行；TUI 只展示 Host capability proof。

### 2.3 关键不变量

1. 所有生产工具副作用继续经 `ExecutionGateway`；预设不能创建旁路。
2. `never` 仍是“ask → deny”，不是“deny → allow”。
3. temporary escalation 永远不修改存储 profile；它是 request/policy/session generation 绑定的短期 grant，并在完成、取消、超时、takeover、snapshot 变更时失效。
4. `auto-review` 的不确定、异常、超时、重复响应、证据缺失结果均为 user ask；headless 时为 deny。
5. `Full Access` 选择必须被审计，且 managed policy 不允许时不可展示为可选。

## 3. 目标配置与契约

### 3.1 settings 形状

`<RUNLEDGER_DIR>/settings.json#security` 为 user baseline；`projects/<workspace-key>/settings.json#security` 只可收紧。示意：

```json
{
  "security": {
    "profile": "approve-for-me",
    "approvalReviewer": "auto-review",
    "profiles": {
      "project-edit": {
        "extends": "workspace-write",
        "network": { "mode": "allowlist", "allowedHosts": ["api.openai.com"] },
        "filesystem": {
          "denyRead": ["**/*.env"],
          "protectedPaths": [".git", ".runledger"]
        }
      }
    },
    "bashAnalyzerMode": "ast",
    "rules": [
      { "id": "deny-git-push", "action": "deny", "kind": "shell", "pattern": "git push*" }
    ]
  }
}
```

`approvalReviewer` 新类型：`"user" | "auto-review"`。它不是 approval policy 的第五种值；policy 决定 action 是否为 ask，reviewer 决定 eligible ask 先由谁处理。

### 3.2 系统 registry

新增只读 `BuiltinPermissionPresetRegistry`。每项至少包含：

```ts
interface BuiltinPermissionPreset {
  readonly id: "workspace-write" | "approve-for-me" | "danger-full-access";
  readonly label: "ask_for_approval" | "approve_for_me" | "full_access";
  readonly description: string;
  readonly profile: SecurityProfile;
  readonly reviewer: "user" | "auto-review";
  readonly requiresExplicitConfirmation: boolean;
  readonly availability: (constraints: ManagedSecurityConstraints, capability: SandboxCapability) => PresetAvailability;
}
```

registry 只描述默认组合；`SecurityConfigDocument` 仍是唯一用户可配置格式。resolver 将 registry + user/workspace config 编译为 snapshot，不能把 UI 文案或 TUI 状态写进 policy。

### 3.3 temporary filesystem escalation

对普通 workspace-root boundary（而非显式 deny）创建：

```ts
interface PendingFilesystemEscalation {
  readonly operation: "write" | "delete";
  readonly canonicalTarget: string;
  readonly requestedPath: string;
  readonly policyDigest: RuntimeDigest;
  readonly sessionGeneration: number;
  readonly scope: "once";
}
```

批准后只把 canonical target 的 exact entry 写入该 gateway invocation/launch plan；不扩大 `writeRoots`，不持久化 config，不使用 glob/prefix，不覆盖 protected/managed/explicit deny。完成后 receipt 与 grant 一起 settle/revoke。

### 3.4 auto-review 准入矩阵

只有由 PermissionEngine 标记为 `ask` 且同时满足下列条件的请求才可送 auto-review：workspace 内、canonical path 已重验、非 protected、非显式 deny、无 credential/read deny 命中、无 shell hardline、无 network host miss、无 worktree remove、policy/session generation 匹配。

第一版 auto-review 只可返回 `allow-once`、`ask-user`、`deny`；不产生 session grant、prefix rule、network amendment 或配置写入。它依据可版本化的 deterministic classification/risk evidence 决策，并把分类版本、输入 digest、结果和理由摘要写入 ledger。任何未覆盖 action 直接 `ask-user`。

## 4. 分阶段执行

每个阶段先写 RED 测试，再实现最小代码，完成 `npm run check`、相关测试和 `npm run build` 后才能进入下一阶段。每阶段单独提交；共享 Host/TUI 文件只在记录的串行集成窗口改动。

### P0 — 基线冻结与契约 RED

**目标**：使三张卡的 promise、当前差距和不可放宽边界变为可执行测试。

- 新增 `tests/security/permission-presets.contract.test.ts`：三项 registry 组合、受保护路径、managed deny、snapshot digest、不可继承 full access。
- 新增 current-behaviour RED：workspace `on-request` ordinary write、root-boundary external write、`untrusted` non-read ask、缺少 reviewer route，逐项锁定为待改差距。
- 记录当前 Host source ordering 与 `ManagedSecurityConstraints` 未接入处；先定义 constraints input，不在 P0 改行为。

**完成条件**：红测清晰表达第 1.2 节差距；不改生产语义。

### P1 — 内置预设 registry、继承与 managed constraints

**目标**：安全地解析三项预设，并让 managed policy 成为上限而非普通 override。

- 新增 registry/类型、`approve-for-me` builtin profile、`approvalReviewer` schema 和 snapshot 字段；未知值 fail closed。
- resolver 只允许 named profile extends `read-only`、`workspace-write`、另一个 named profile；拒绝 `danger-full-access` parent、unknown/cycle、builtin 名覆盖。
- Host loader 将 `/etc/runledger/security.json` 编译为 constraints；CLI/workspace/user 请求在 constraints 下求交集，不能提升。
- 在 `session.security.inspect` 中增加 profile ID、reviewer、policy digest、preset availability 的只读投影。

**测试**：registry、inheritance、constraints precedence、full-access 被禁、source digest/replay；原有 config/profile tests 全量回归。

### P2 — Ask for approval 的真实语义

**目标**：兑现“workspace 自动编辑；网络与外部文件询问”。

- 调整 PermissionEngine：在 `workspace-write + on-request` 下，已验证的普通 workspace mutation allow；未知/dangerous shell、worktree mutation、network review miss 仍 ask。
- 把 root-boundary 区分为 explicit deny/protected/managed deny（始终 deny）与 escalation-eligible boundary（ask）。
- ApprovalCoordinator/ExecutionGateway 实现 `PendingFilesystemEscalation`，并在 filesystem broker、managed process launch plan、final-leaf revalidation 同时消费 exact grant。
- 无 UI/headless/recovery-uncertain/receipt 无效时 escalation 为 deny；任何 path canonicalization 变化为 deny。

**测试**：workspace auto-write、protected/deny 不可升级、外部单文件 write approve/deny/cancel/timeout、symlink swap、session takeover、grant replay/settle。

### P3 — Approve for me reviewer

**目标**：让第二张卡有真实、可审计但保守的含义。

- 新增 Host-owned `AutoApprovalReviewerPort`、deterministic reviewer 实现与 `ApprovalReviewer` 解析；TUI 只显示状态，不拥有决策。
- 把 eligible `ask` 先交 reviewer；`allow-once` 继续经过 gateway，`ask-user` 走现有 reverse request，`deny` 直接拒绝。
- 失败、超时、unavailable、classification version/digest 不符均不自动放行；interactive → user ask，headless → deny。
- Advanced 可查看 reviewer 的分类版本、理由摘要和 receipt，但不显示原始敏感 command/file body。

**测试**：每一准入/排除项、timeouts、异常、重复 response、policy change、headless、审计脱敏与 idempotency。

### P4 — SecuritySettingsPort 与安全持久化

**目标**：使 TUI 可保存配置且不丢弃 `security`。

- 新增 Host command/query：`security.settings.inspect`、`security.settings.update`；update 包含 expected revision/source digest，返回 durable receipt。
- 实现专用 raw-section read/modify/write：只修改 `settings.json#security`，用 `parseSecurityConfigDocument` exact validate；不经过通用 `ProjectSettings` sanitizer。
- scope 规则：managed 只读；user 可选择三个预设/管理 named profiles；workspace 只能收紧 user baseline，Full Access 在受限 workspace 不能成为更宽松覆盖。
- 保存成功后提示“新 Session 生效”；当前 session snapshot 不变。新 session/resume 的 snapshot/ledger 记录 source digests。

**测试**：unknown field 不被误吞、invalid JSON fail closed、CAS conflict、并发 update、user/workspace 收紧、managed 冲突、保存后重启与旧 session 不变。

### P5 — TUI 三卡选择器与 Advanced

**目标**：可用、无 authority 泄漏的 permissions 设置界面。

- `/permissions` 首屏三卡，显示当前选择、约束摘要、availability 和 Full Access 风险提示。
- Full Access 需二次确认（清晰列出 workspace 外写、网络、无常规 approval），managed 禁止或 capability unavailable 时不可选择。
- Advanced 依次提供 Profile/Inheritance、Approvals/Granular、Filesystem、Network/hosts、Rules、Bash、Effective policy；每一页从 `security.settings.inspect` 投影，提交为 typed patch。
- Network allowlist 空、重复 rule ID、非法 profile parent、未知 token、`granular` 缺五项开关均在保存前展示明确错误。
- 保留现有 inline permission request；它是运行中单次请求界面，不能与 settings editor 混为一处。

**测试与人工验收**：OpenTUI keyboard navigation、焦点恢复、窄/宽终端、CJK 文案、Full Access confirm/cancel、unavailable 显示、无 layout/path 泄漏；真实 linked `runledger` TTY 捕帧验证。

### P6 — 生产组合、审计与最终验收

**目标**：确认三个预设在真实 Host/CLI/TUI 路径中不会绕过约束。

- 标准 CLI 启动、create/resume、Host takeover、worktree binding、managed process、governed filesystem/network 全部使用同一 SecuritySnapshot。
- CLI 一次性 flags 只能选择受允许 preset 或收紧字段；`--approval-policy granular` 不再默默假设五个开关，必须显式声明或拒绝。
- `runledger security inspect` 输出 redacted effective policy、preset、reviewer、capability proof、source/constraint digest，不输出 secrets/原始敏感规则值。
- 对三项预设完成 fresh end-to-end trace/receipt inspection；不以 Linux 回归当作跨平台 sandbox enforcement 声明。

**最终门禁**：

```text
npm run check
npm test
npm run build
git diff --check
which runledger
runledger security inspect
# 真实 TTY：三项选择、保存、重启新 session、一次 external-write/network ask、Full Access 二次确认
```

真人仍需确认：Full Access 的文字是否足够明确、自动 reviewer 的理由是否可理解、真实 IME/鼠标/窄终端行为，以及各目标平台的实际 sandbox capability。

## 5. 文件与提交边界

| 阶段 | 主要路径 | 不应触碰 |
|---|---|---|
| P0–P1 | `src/security/{types,config/**,permission/**}`、`tests/security/**` | sandbox backend、TUI renderer |
| P2 | permission/approval/gateway、Host security、focused integration tests | raw fallback、平台 sandbox 扩展 |
| P3 | approval reviewer port/adapter、audit、tests | provider/LLM authorization |
| P4 | storage security port、Host command/query、storage/security tests | TUI direct filesystem |
| P5 | `src/tui/**`、TUI tests、Host client adapter | policy decision ownership |
| P6 | CLI composition/help、integration/TTY evidence、docs | unrelated session/store migrations |

每个提交只包含一个阶段的 code/test/doc 路径；本计划本身只在阶段状态或明确的设计决策变化时更新。不得以已有历史 `check`/TTY/E2E 结果标记本计划通过。

## 6. 完成定义

只有以下条件同时成立，三种预设才可对用户宣称可用：

- 三张卡均由 registry、schema、resolver、immutable snapshot 和 policy digest 表达，且运行中无 client-local mutation；
- Ask for approval 能在 workspace 自动编辑，并且 workspace 外/网络实际走精确 approval 或安全拒绝；
- Approve for me 仅由确定性、可审计、fail-closed reviewer 自动批准 eligible action；
- Full Access 允许正常 workspace 外写/网络，但无法越过 managed/protected/hardline deny；
- settings 持久化不会丢失 `security`，workspace 不可扩大 user/managed 权限；
- 运行中 approval、CLI、TUI、managed process 和 final leaf 使用同一个 snapshot；
- P0–P6 的 fresh automated/TTY evidence 和人工验收均完成；未证实的平台 sandbox 状态继续显示为 unavailable/unverified。

## 7. 明确拒绝的捷径

- 只给三张 TUI 卡换文案，而不改变实际 profile/network/filesystem/gateway 行为；
- 把 `never`、`yolo` 或 `Full Access` 当作 ignore deny；
- 用普通 `saveProjectSettings()` 保存 security，导致未知字段静默丢失；
- 将 workspace-root boundary 的 deny 直接变成 unrestricted write，或批准一个目录/glob 来代替 exact one-shot path；
- 用 LLM、模型输出、prompt 文本或前端布尔值作为 auto-approval authority；
- 让 auto-review 对网络 host miss、credential/deny match、protected path、未知 shell、worktree remove 自动批准；
- 在 session 运行中静默替换 policy snapshot，或让 observer/TUI 自行更改它；
- 把 sandbox/backend unavailable 降级为 raw local I/O。
