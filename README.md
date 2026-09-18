# RunLedger

**在终端里完成开发任务，让每次 Agent 执行都有账可查。**

RunLedger 是面向可审计执行的 AI 编程 Agent 与运行时。你可以在终端中阅读代码、修改文件、运行命令、审阅计划，并继续或派生已有会话。模型调用、工具执行和会话状态由同一个 Session Runtime 管理，权限决策与执行回执为排查问题和恢复工作提供依据。

名字来自 **Run + Ledger（运行账本）**：既关注 Agent 如何完成任务，也关注它执行了什么、在什么权限下执行，以及中断后如何继续。

[快速开始](#快速开始) · [日常使用](#日常使用) · [Agent 模式](#agent-模式) · [文档](docs/README.md) · [架构](docs/architecture.md)

## 为什么使用 RunLedger

### 在终端中完成开发闭环

OpenTUI 界面支持流式回答、工具执行状态、代码与 Diff 展示，以及模型、思考等级和主题设置。会话历史可以恢复或分叉；运行中的任务可以中断，受管进程可通过 `/processes` 查看。

### 让工具执行受权限约束

文件、Shell 和外部工具调用经过统一的权限检查与执行治理。你可以通过 `/permissions` 查看和调整权限，处理需要批准的操作；执行尝试与回执关联到会话，便于定位失败和审阅副作用。

### 把会话作为持久工作单元

SQLite 保存会话目录、事件、执行回执和恢复状态。每个活跃会话由一个 Session Owner 管理；同一主机的多个客户端可以连接同一会话，由一个控制连接提交变更，其他连接观察。恢复时会核对工作区身份和执行状态，遇到未决执行可通过 `/recovery` 检查。

### 选择模型，按需接入扩展

统一的 Provider 层提供模型目录、流式请求、API key 与 OAuth 认证。标准模式可按配置与信任策略接入 Skills、声明式 Plugins、Hooks、MCP 和 LSP。实际可用模型取决于凭据、Provider 能力与兼容检查；扩展以当前会话暴露的能力为准。

### 追踪一次任务的运行过程

本地 Runtime Trace 关联 run、模型请求、工具调用、上下文及用量信息，支持事件记录和可选的正文工件。它补充 SQLite 中的会话事实，帮助分析一次任务的执行过程。事件哈希链提供完整性校验；这不等于存储无法被篡改。

## 快速开始

当前仓库按源码构建使用，`package.json` 标记为 `private`。

准备以下环境：

- Node.js **≥ 22.19.0**、npm 与 Bun **≥ 1.3.0**。
- Git、Rust/Cargo 工具链与本机链接器，用于源码获取及原生语法高亮构建；Linux 构建还需要 `cc`。
- 支持交互的终端。平台适配与验收情况见[平台证据与缺口](development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md)。

```sh
git clone https://github.com/Crsei/RunLedger.git
cd RunLedger
npm install
npm run build
npm link
runledger --version
runledger --help
```

`runledger` 通过 Bun 加载构建后的 `dist/cli/cli.js`。更新源码后需重新执行 `npm run build`。

然后在你要处理的项目目录中启动：

```sh
cd /path/to/your/project
runledger
```

首次使用可在 TUI 中通过 `/provider` 配置 Provider、`/login` 完成认证，再用 `/model` 选择模型。也可以使用对应 Provider 支持的环境凭据，并显式指定模型：

```sh
# 替换为实际的 Provider ID 与模型 ID；凭据需事先配置
runledger --provider <provider-id> --model <model-id>
```

进入界面后直接输入任务，例如“梳理这个仓库的启动流程，并标出关键入口文件”。认证方式和模型路由详见[模型与认证](docs/subsystems/models.md)。

## 单次非交互执行

`--prompt-file` 创建一个新 Session，通过同一生产 Session Owner 执行任务，
将消息、工具结果和运行边界写到 stdout JSONL，然后关闭运行时。诊断写到 stderr。
它不支持与恢复会话或 control 命令组合；错误和中断返回非零退出码。
无交互客户端不会自动批准权限请求，自动化任务应显式配置权限和审批策略。

```sh
trial_root=$(mktemp -d /tmp/runledger-task-XXXXXX)
mkdir -p "$trial_root/home" "$trial_root/workspace"
printf '%s\n' '创建 hello.txt，内容为 hello，然后检查内容。' > "$trial_root/task.txt"
cd "$trial_root/workspace"
# 先通过环境变量配置所选 provider 的凭据。
RUNLEDGER_DIR="$trial_root/home" runledger \
  --prompt-file "$trial_root/task.txt" \
  --provider opencode-go --model deepseek-v4.1-flash \
  --permission-profile workspace-write --approval-policy never \
  > "$trial_root/events.jsonl" 2> "$trial_root/stderr.log"
```

JSONL 保留完整消息和工具结果，不重复输出流式累积快照；成功结束含
`runledger_complete`，失败应结合退出码和 stderr 判断。执行有 30 分钟上限，
SIGINT/SIGTERM 会请求中断并清理 Session。事件可能包含任务文件内容，按任务数据保存。

## 日常使用

### 继续和派生会话

以下命令在原工作区内执行；`<session-id>` 为已有会话的 ID：

```sh
runledger --continue                       # 继续当前工作区最近的可恢复会话
runledger --session-id <session-id>         # 打开指定会话
runledger --fork <session-id>               # 从已有会话派生新会话
runledger --worktree my-task                # 在受管 Git worktree 中新建会话
```

TUI 中用 `/resume` 浏览历史会话、`/fork` 派生当前会话、`/rename` 修改标题。CLI 的 `--resume` 当前与 `--continue` 一样选择最近会话；`--fork` 接受会话 ID。旧 JSONL 文件需要[显式迁移](development-doc/storage-cli/02-user-home-migration-handoff.md)，不能通过 `--session <path>` 直接打开。

### 常用交互入口

| 入口 | 用途 |
|---|---|
| `/help` | 查看帮助 |
| `/provider`、`/login`、`/model` | 配置服务、认证与选择模型 |
| `/thinking`、`/hide-thinking` | 调整思考等级与思考内容展示 |
| `/mode` | 选择 Agent 模式 |
| `/permissions` | 查看和配置权限 |
| `/plan` | 查看计划及审阅工作流 |
| `/processes`、`/terminal <executionId>` | 查看受管进程及终端输出 |
| `/mcp`、`/skills`、`/plugins`、`/hooks` | 查看当前会话的扩展资源 |
| `/dump` | 查看组装后的系统提示词与工具描述 |
| `/theme` | 切换主题 |
| `/quit` | 退出 |

任务执行期间部分命令不可用，扩展入口也受当前模式与能力限制。`Ctrl+C` 可中断当前任务；先用 `Esc` 关闭弹窗，空输入框下用 `Ctrl+D` 退出。更多参数见 [CLI 文档](docs/cli.md)。

## Agent 模式

| 模式 | 适用场景 | 模型可用工具 |
|---|---|---|
| `default` | 日常代码阅读、修改与验证 | 标准工具集，按策略装配扩展 |
| `minimal` | 用 Shell 完成任务，保持精简工具入口 | 新会话为 `minimal@2`，仅 governed `bash` |
| `plan` | 先分析代码并整理可审阅的计划 | `read`、`glob`、`ls`、`plan_read`、`plan_write` |

```sh
runledger --mode default
runledger --mode minimal
runledger --mode plan
```

TUI 中可用 `/mode <name>` 切换，`/minimal` 是 minimal 的快捷入口。选择不同模式会新建空会话，保留当前模型与思考等级，原会话仍可恢复；有草稿或任务正在执行时不能切换。

模式不会授予额外权限。minimal 的 Shell 仍受权限检查；plan 只允许修改会话内的计划工件，禁止 Shell、网络与工作区写入。计划获批后不会自动开放写权限，实施时需用 `/mode default` 新建会话并提供任务上下文。

模式在会话创建时冻结，恢复和 fork 继承原有 Profile。旧 `minimal@1` 会话保留 `bash` / `edit`，不会自动升级。配置与兼容细节见 [Agent Mode 专题](development-doc/runtime/10-agent-mode-entry-implementation-plan.md)。

## 配置与数据

默认用户目录为 `~/.runledger`。设置 `RUNLEDGER_DIR` 可指定另一用户目录，值必须是**预先创建的绝对路径**。

| 位置（相对用户目录） | 内容 |
|---|---|
| `settings.json` | 用户设置，如默认模型、Agent 模式和 recording 策略 |
| `auth.json` | Provider 凭据 |
| `state.db` | SQLite 会话权威状态、事件与执行回执 |
| `projects/<workspace-key>/settings.json` | 按工作区保存的设置 |

项目下的 `.runledger/` 不是隐式配置或会话存储入口。详细布局与迁移见[持久化文档](docs/subsystems/persistence.md)。

例如，在用户级 `settings.json` 中合并以下配置可默认新建 minimal 会话，并关闭可选的本地 Trace：

```json
{
  "agentMode": "minimal",
  "recording": {
    "mode": "off"
  }
}
```

recording 默认是 `events + best_effort`；可选择 `events_and_artifacts` 保存经清洗的正文工件，或使用 `fail_closed` 在记录失败时阻止运行继续。关闭 Trace 不会关闭 SQLite 会话持久化。配置语义见 [Runtime Trace](docs/subsystems/trace.md)。

## 运行架构

```text
CLI / OpenTUI
      │ command · query · subscription
      ▼
Session Owner Runtime（每个会话独立）
      ├── Agent loop → Models / Provider
      ├── Tools → 权限与批准 → ExecutionGateway → 文件 / 进程 / 外部调用
      ├── Skills / Plugins / Hooks / MCP / LSP
      ├── SQLite Session Store → 事件 / 回执 / 恢复状态
      └── Local Runtime Trace → 观测事件 / 工件
```

TUI 通过本机协议消费会话状态。Session Owner 负责执行与生命周期，SQLite 中的所有权代次用于阻止过期 Owner 继续写入。详见[当前生产架构](docs/architecture.md)与[子系统索引](docs/subsystems/README.md)。

当前能力边界：

- 多客户端连接限于本机；同一时刻只有一个控制连接可提交变更。
- 有界子 Agent 为实验能力，默认关闭；仅支持根会话拥有的串行、只读、单层委派，同一根会话最多一个活跃 child。
- Runtime Trace 当前提供本地存储与投影，远程 Opik / OTLP exporter 尚未接通。
- 外部 Provider、人工交互与跨平台验收分别记录在对应专题中，不能由本地自动化结果替代。

## 开发与文档

```sh
npm run check             # 类型、架构边界与原生组件检查
npm test                  # 本地测试分桶入口
npm run build             # 构建原生组件、TypeScript 与 TUI 资源
npm run generate-models   # 更新模型 catalog；按需运行并审阅生成差异
```

开发前阅读 [AGENTS.md](AGENTS.md)。测试使用隔离的 `RUNLEDGER_DIR`，测试策略与真实 CLI/TUI 验证方法见[测试专题](development-doc/test/README.md)。

| 文档 | 内容 |
|---|---|
| [文档总览](docs/README.md) | 按使用场景查找文档 |
| [CLI 参数表](docs/cli.md) | 启动、控制命令、环境变量与限制 |
| [架构总览](docs/architecture.md) | 生产入口、运行流与模块协作 |
| [子系统参考](docs/subsystems/README.md) | 模型、会话、存储、工具、扩展与 Trace |
| [开发索引](development-doc/00-index.md) | 专项设计、实施与验收记录 |
| [审计入口](development-doc/audit/README.md) | 问题分析、修复与复验记录 |

RunLedger 的 Provider 与 Agent Core 包含来自 pi 生态的移植与适配，背景见 [pi 参考架构](docs/pi-architecture.md)与 [Provider 移植清单](development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md)。本 README 的介绍组织参考了 oh-my-pi；功能范围以 RunLedger 当前实现为准。

## License

MIT（见 `package.json` 的 license 声明）；引入组件的许可见相应源码与许可清单。
