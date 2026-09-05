# RunLedger CLI 参数表

本文面向终端用户，说明启动参数、控制子命令、环境变量及当前限制。依据 [架构总览](architecture.md)、[子系统文档](subsystems/README.md)与当前 CLI 实现整理，核对日期为 **2026-09-05**。实现依据包括当前工作树的未提交修复；已安装版本可能不同。本文是源码核对结果，不代表本轮已完成真实 provider 或 TUI 验收。

## 1. 调用方式与解析规则

```text
runledger [启动参数]
runledger [会话选择参数] <控制命令> [命令参数]
runledger auth-gateway <serve|token|status|check> [网关参数]
runledger workspace capability
runledger migrate --source <path> --confirm-delete
runledger migrate session-store --confirm-archive
runledger storage prune-legacy --manifest <digest> --confirm-delete
```

`<值>` 表示必填值，`[值]` 表示可选值，表内枚举用逗号分隔。无参数启动会新建 Session 并进入 TUI。标准可执行入口是 [`bin/runledger.js`](../bin/runledger.js)，实际加载构建后的 `dist/cli/cli.js`。

- 普通启动参数使用空格传值，例如 `--model <id>`。**不要使用 `--model=<id>` 等一般化的等号写法**：顶层解析器会将其归入未知参数，不应用该覆盖。下文明确注明的等号形式除外。
- 顶层未知 flag 当前被收集，但 `main()` 不消费，也不统一报错；参数拼写错误可能被忽略。未识别为控制命令的位置文本也不会自动提交为 prompt；请进入 TUI 输入问题。当前没有顶层 `--prompt`、`--print` 或通用 `--json` 模式。
- `--` 结束顶层 flag 解析，之后均为位置参数；这不会启用一次性提问模式。不要组合短参数为 `-cm`。
- 标量参数重复时通常以后一次为准；`--network-host` 可重复并去重。
- `auth-gateway`、`workspace`、`migrate`、`storage` 必须位于第一个 argv，进入各自独立解析器；不要在它们前后混入普通启动参数。

源码：[`args.ts`](../src/cli/args.ts)、[`main.ts`](../src/cli/main.ts)。

## 2. 启动参数

### 通用与模型

| 参数 | 简写 | 值 / 未指定时 | 作用与限制 |
|---|---|---|---|
| `--help` | `-h` | 无值 | 输出顶层帮助并退出 |
| `--version` | `-v` | 无值 | 输出版本并退出 |
| `--debug` | — | 默认不开启此覆盖 | 设置 `RUNLEDGER_DEBUG=1`，诊断写入 stderr |
| `--provider <id>` | — | 沿用模型选择流程 | 显式指定 provider；需与 model 匹配 |
| `--model <id>` | `-m <id>` | 沿用模型选择流程 | 显式指定模型；只有 model ID 时需在 catalog 中唯一匹配 |
| `--thinking <level>` | — | 沿用恢复状态 / settings | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`；仍受模型能力与兼容策略约束 |
| `--hide-thinking` | — | 沿用展示设置 | 仅本次隐藏 thinking blocks，不改变模型请求、不写 settings |

初始模型选择按显式 CLI、Session 恢复状态、用户 settings 解析；未知或不兼容的显式模型选择失败。未显式指定时，不可用的旧选择可以回退到已认证且通过兼容预检的模型。凭据仍须单独配置，参数本身不完成登录。详见 [Models、Provider 与 Auth](subsystems/models.md)。

### 会话与 Harness Profile

| 参数 | 简写 | 值 / 默认 | 当前行为 |
|---|---|---|---|
| `--continue` | `-c` | 无值 | 在当前 workspace 绑定内选择 `updatedAtMs` 最新的可继续 Session |
| `--resume` | `-r` | 无值 | 当前 CLI 与 `--continue` 使用同一最近会话选择逻辑；不会因该参数直接弹出历史选择器 |
| `--session-id <id>` | — | 精确 session ID | 从 canonical SQLite catalog 打开，校验当前 workspace 绑定 |
| `--fork <sessionId>` | — | 精确源 session ID | 从同 workspace 的已有 Session 派生新 Session，继承 Harness Profile |
| `--harness-profile <profile>` | — | `standard` | 仅新建支持 `standard`、`minimal`；不能与打开、继续、恢复或 fork 模式搭配 |
| `--session <path>` | — | legacy 文件路径 | 解析器保留，但标准 Runtime 拒绝直接打开 JSONL，提示显式迁移 |
| `--session-dir <dir>` | — | 不支持 | 空格及 `--session-dir=...` 形式均拒绝；使用预创建的 `RUNLEDGER_DIR` |

最近会话仅包含 `active`、`paused`、`recovery_required` 状态；没有匹配项时报错，不自动新建。后者仍受 recovery barrier 约束，并不表示立即可执行工具。

会话选择参数应只选一种。当前实现的优先级是：`--session-id` / `--session` → `--fork` → `--resume` → `--continue` → 新建；同时指定两种 open 参数时 `--session-id` 优先。这是解析行为，不是推荐组合。

`minimal` 对应冻结的 `minimal@1`，模型只看到 governed `bash` / `edit`，不装配模型侧扩展或 child；它不改变权限 authority。既有 Session 的 Profile 不可通过启动参数切换。详见 [Minimal Harness Profile](../development-doc/runtime/09-minimal-harness-profile-implementation-plan.md)。

### 权限、网络与现有 Sandbox 参数

下列参数进入 Session Security 的 CLI 配置层。未指定时由有效配置及所选 profile 决定，不能将某台机器的 settings 当作统一默认值。CLI 覆盖仍受 managed constraints 和运行时能力检查限制；连接已运行的 owner 不代表重新创建其冻结的 Security snapshot。

| 参数 | 可选值 | 作用与限制 |
|---|---|---|
| `--permission-profile <name>` | `read-only`, `workspace-write`, `danger-full-access` 或 named profile ID | 选择权限预设；名称可通过语法解析不代表配置中存在该 profile |
| `--approval-policy <policy>` | `on-request`, `never`, `untrusted`, `granular` | 设置批准策略；`never` 不等于所有操作自动获准；当前 CLI 的 `granular` 覆盖同时启用五类批准开关 |
| `--bash-analyzer <mode>` | `legacy`, `shadow`, `ast` | 选择 Bash 安全分析模式 |
| `--sandbox <profile>` | `off`, `read-only`, `workspace-write`, `strict`, `external` | 选择既有 sandbox profile；实际生效取决于 backend 与策略，不能仅凭参数证明 OS 隔离 |
| `--network <mode>` | `deny`, `allow`, `allowlist`, `review` | 设置网络策略；managed 强制禁网仍有效 |
| `--network-host <host>` | 可重复的 host 条目 | 显式网络策略的 host 列表；转为小写、移除末尾点并去重 |

`--network allowlist` 至少需要一个 `--network-host`。提供 host 时必须显式指定 `--network allow`、`allowlist` 或 `review`；`deny` 不接受 host。host 不能包含 URL scheme、`/`、`@` 或 NUL，长度为 1–512；应传主机名而不是完整 URL。

这些是既有参数的参考，不扩展 sandbox 能力或平台验收。详见 [Tools、Security 与 Process](subsystems/tools.md)。

### Worktree 与有界多 Agent

| 参数 | 值 / 默认 | 作用与限制 |
|---|---|---|
| `--worktree [label]` | label 可省略，使用 session ID | 请求创建 Session managed worktree；已有持久化绑定会复验并恢复 |
| `--worktree-ref <ref>` | 由 worktree 创建逻辑决定 | 指定创建基线 ref；本参数本身不启用 worktree |
| `--worktree-branch <name>` | 由 worktree 创建逻辑决定 | 指定创建分支；本参数本身不启用 worktree |
| `--no-worktree` | 默认 false | 与 `--worktree` 互斥，不能绕过已有 Session 的持久化 worktree 绑定 |
| `--experimental-multi-agent` | 默认 false | 打开 runtime gate；也接受 `--experimental-multi-agent=true` / `false`，仍需用户 settings 启用、workspace 未禁用、Profile 允许 |

`--worktree` 会把紧随其后的非 `-` 开头 token 作为 label。默认未请求 worktree 且无历史绑定时使用 source workspace。当前有界 child 为 root-owned、depth=1、只读、同一 root 最多一个 active child；该参数不启用并行或可写 child。详见 [Workspace](subsystems/workspace.md)、[Bounded Subagents](subsystems/subagent.md)。

## 3. Session 控制命令

控制命令通过同一套会话选择参数定位 Session。例如：

```sh
runledger --session-id <session-id> security inspect
runledger --session-id <session-id> plugin list
runledger --session-id <session-id> mcp doctor
```

省略会话选择参数会走新建流程，不会自动操作最近会话。输出是 JSON 结果；领域操作返回 `ok: false` 时退出码为 1，解析错误通常为 2。能力以认证握手协商结果为准；表内“未接通”表示标准 Session 当前未暴露该操作，不是语法错误。

| 命令（均加 `runledger [会话选择参数]` 前缀） | 参数与默认动作 | 标准 Session 状态 |
|---|---|---|
| `security [inspect]` | 默认 `inspect` | 查询有效安全设置 |
| `worktree list / inspect / create / resume / release` | 默认 `list`；`create <source-cwd> <label>`；`release confirm [reason]` | 控制命令未接通；启动 `--worktree` 的组合路径另行存在 |
| `plugin list / inspect / reload / enable / disable / trust / untrust` | 默认 `list`；enable/disable/trust/untrust 需要 `<plugin-id>` | `inspect` 未接通，其他操作取决于当前扩展能力 |
| `skill [list]` | 默认 `list` | 查询 Skill catalog |
| `skill trust / untrust <skill-id>` | ID 必填 | 修改 Skill trust，仍受领域校验 |
| `skill provider list` | 显式 `provider list` | 查询 Skill provider |
| `skill provider enable / disable <provider-id> [--scope <scope>]` | 默认 user；实际写法为 `--scope user` 或 `--scope workspace`，也支持等号形式 | user scope 接通；workspace scope 当前返回失败 |
| `hook [list]` | 默认 `list` | 查询 Hook catalog |
| `mcp list / inspect / doctor / restart` | 默认 `list`；`restart [server-id]` | `inspect` 未接通；使用 list/doctor 查询，restart 受 mutation 校验 |
| `plan [inspect]` | 默认 `inspect` | 查询计划状态 |
| `plan enter / activate / write / approve / cancel` | `activate [text]`；`write <text>`；`approve <approval-id>` | plan mutation 当前未接通 |
| `compact list / run` | 默认 `run`；`run '<source-range-json>' <transcript>` | 未接通；source range 必须符合 `RuntimeEventRangeRef` |
| `context inspect / assemble` | 默认 `inspect`；`assemble '<request-json>' '<sources-json-array>'` | 未接通 |
| `memory search / get / projection / approve / reject / revoke` | 默认 `search` 且需 query；`get <memory-id>`；`approve <proposal-id> '<approval-ref-json>'`；`reject <proposal-id>`；`revoke <memory-id>` | Memory 未接通 |
| `remember [propose] <text>` | text 必填 | Memory proposal 未接通 |

上述 `/` 仅用于表格分隔动作，实际调用一次只选一个动作。多词文本及 JSON 应使用 shell 引号包围。TUI `/model`、`/login` 等斜杠命令不是 CLI flag，详见 [TUI 专题](../development-doc/tui/00-overview.md)。

源码：[`control-commands.ts`](../src/cli/control-commands.ts)、[`Session domain`](../src/runtime/session-runtime/domain.ts)。

## 4. 独立子命令参数

### Auth Gateway

网关复用 Models/AuthStorage，不创建 Session Runtime。

| 命令 | 参数 / 默认 | 行为 |
|---|---|---|
| `auth-gateway --help` | 也支持 `-h` | 显示网关帮助 |
| `auth-gateway serve` | `--bind <host:port>`，默认 `127.0.0.1:4000`；支持 `--bind=...` | 启动前向代理并等待关闭信号 |
| `auth-gateway serve --no-auth` | 默认 false | 关闭网关 bearer 认证，仅允许 loopback bind |
| `auth-gateway token` | `--regenerate`、`--json`，均默认 false | 默认获取或创建并输出 token；regenerate 重新生成，JSON 包含 token 和路径 |
| `auth-gateway status` | `--json`，默认 false | 展示 token 配置状态，不探测网关监听进程或真实上游可用性 |
| `auth-gateway check` | `--strict`、`--json`，均默认 false | 默认检查 token；strict 向已配置 provider 发起真实模型请求，可能产生用量；失败退出码 1 |

`--json` 在这里控制紧凑 JSON 输出；非 token 命令的默认结果仍可为格式化 JSON。token 命令输出凭据，应按凭据处理。strict 成功要求 token 已配置、至少一个已配置 provider，且所有被检查 provider 均成功。源码：[`auth-gateway-cli.ts`](../src/cli/auth-gateway-cli.ts)。

### Workspace 与迁移

| 命令 | 必需参数 / 限制 | 行为 |
|---|---|---|
| `workspace capability` | 无必需 flag | 只读展示各平台 path/Git/process/cleanup 证据矩阵，不证明 sandbox enforcement |
| `workspace --help` | 也支持 `-h`；单独 `workspace` 也显示帮助 | 展示 workspace 子命令帮助 |
| `migrate --source <path> --confirm-delete` | 两项必填；支持 `--source=...` | 外部 legacy source 迁入 canonical JSONL 布局，验证后按 manifest 删除源内容 |
| `migrate session-store --confirm-archive` | 显式确认必填 | canonical JSONL 导入 SQLite，并将源文件归档；不直接导入任意外部路径 |
| `storage prune-legacy --manifest <digest> --confirm-delete` | 两项必填；支持 `--manifest=...` | 删除对应已验证归档，属于显式删除操作 |

迁移不支持 `--dry-run`、`--read-only` 或 `--fallback`。session-store 迁移不接受 `--workspace-id` / `--repository-id` 手动覆盖；workspace identity 由当前路径与 Git 证据推导。外部旧数据与 SQLite 导入是两个不同流程，使用前阅读 [迁移 handoff](../development-doc/storage-cli/02-user-home-migration-handoff.md)和 [Persistence](subsystems/persistence.md)。

源码：[`workspace-command.ts`](../src/cli/workspace-command.ts)、[`migrate.ts`](../src/cli/migrate.ts)、[`session-store-migrate.ts`](../src/cli/session-store-migrate.ts)。

## 5. 环境变量与配置边界

| 环境变量 | 默认 / 格式 | 说明 |
|---|---|---|
| `RUNLEDGER_DIR` | 未设置时为 `~/.runledger` | 覆盖值必须是预先存在的绝对目录；默认目录可首启创建 |
| `RUNLEDGER_DEBUG` | `1` 开启 | stderr 调试输出；`--debug` 会设置本进程该值 |
| provider 专用凭据变量 | 如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`，按 provider 实现 | 环境凭据来源之一；不是通用、可机械替换的 `<PROVIDER>_API_KEY` 协议；OAuth / 云身份等见 provider 配置 |
| `RUNLEDGER_SESSION_DIR` | 已拒绝 | 不能改变 canonical Session root |

`settings.sessionDir` 同样拒绝。`RUNLEDGER_DIR` 控制整个用户级布局，包含 settings、认证、SQLite、扩展和 trace；项目 `.runledger/` 不是隐式 authority。Recording 仅通过用户 settings 授权，默认 `off + best_effort`，当前没有对应 CLI recording flag；见 [Runtime Trace](subsystems/trace.md)。

## 6. 常用示例

以下占位符需替换为本机实际 ID；均在目标 workspace 内执行。

```sh
# 新建交互会话
runledger

# 继续当前 workspace 最近会话
runledger --continue

# 打开 / 派生已有 SQLite 会话
runledger --session-id <session-id>
runledger --fork <source-session-id>

# 新建 minimal profile 会话
runledger --harness-profile minimal

# 显式模型与思考等级
runledger --provider <provider-id> --model <model-id> --thinking high

# 新建 worktree 会话
runledger --worktree cli-docs --worktree-ref HEAD

# 网络 allowlist
runledger --network allowlist --network-host example.com

# 独立的只读能力查询
runledger workspace capability
```

使用隔离 home 时，先创建目录，再指定环境变量（新目录没有原 home 的凭据和历史）：

```sh
runledger_docs_home=$(mktemp -d)
RUNLEDGER_DIR="$runledger_docs_home" runledger --help
```

## 7. 帮助文本差异与维护

当前顶层帮助仍把 `--session` 描述为直接打开文件、`--fork` 描述为文件路径、`--resume` 描述为弹出选择器，并有旧 Host 用语。标准 Session Owner 实际行为以本文第 2 节和 `resolveSessionId()` 为准；本文没有修改这些代码。

更新 CLI 时，同步核对 `args.ts` 的解析分支、`main.ts` 的实际消费、各独立子命令解析器及 Session operation manifest，再更新本表。仅帮助文本存在或 parser 接受，不等于生产能力已接通。
