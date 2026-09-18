# RunLedger 配置参数总表

本文汇总 RunLedger 当前**全部可配置参数**，按功能分类：环境变量、CLI 启动参数、用户级与 workspace 级 `settings.json`、TUI 偏好、扩展配置（MCP / Hooks / LSP / Plugin 声明）、Provider 凭据。

命令语法与子命令参数另见 [CLI 参数表](cli.md)；本文只描述「可写什么、写在哪、默认值、边界」。核对日期 **2026-09-18**，依据当前工作树源码；已安装版本可能不同。

约定：`<值>` 必填，`[值]` 可选，`枚举` 用 `|` 分隔。标「**仅 user 层**」的字段写在 workspace 层会被拒绝或忽略（见第 6 节）。

---

## 1. 配置来源与优先级

| 来源 | 载体 | 说明 |
|---|---|---|
| CLI 参数 | argv | 单次进程生效，不写盘；最高优先级用户选择 |
| Session 冻结快照 | `state.db` | Session 创建时冻结，fork 继承，运行中不可改 |
| workspace settings | `<home>/projects/<wsKey>/settings.json` | 只能**收窄** user 层，不能放宽 |
| user settings | `<home>/settings.json` | 用户级 authority；持有 recording / compaction / marketplace 等独占字段 |
| managed / organization | 部署注入 | 只声明 ceiling 与收紧条件，不能被 CLI 或 project 覆盖 |
| 默认值 | 源码 | 各节表格「默认」列 |

安全配置的层顺序为 `managed → organization → project → user → session → cli`，后者优先但始终受 managed ceiling 约束（`src/security/config/resolver.ts`）。非安全设置按 user → workspace 两层合并（`src/storage/settings-manager.ts`）。

canonical home 由 composition root 解析一次：`RUNLEDGER_DIR` 必须是**已存在的绝对目录**，否则默认 `~/.runledger`。项目内 `.runledger/` 不是隐式 authority。

### canonical 目录布局

| 路径 | 内容 |
|---|---|
| `<home>/settings.json` | user 级 settings（含 `security`、`recording`、`compaction`） |
| `<home>/auth.json` | Provider 凭据与 OAuth |
| `<home>/AGENTS.md` | 全局指令（与 `<cwd>/AGENTS.md` 一起注入系统提示） |
| `<home>/state.db` | Session Owner SQLite authority |
| `<home>/projects/<wsKey>/settings.json` | workspace 级 settings（`wsKey` = `ws-<sha256>`） |
| `<home>/models.json` | 自定义 Provider / 上游模型代理（见 15.5） |
| `<home>/state/tui-preferences.json` | 本地 TUI 展示偏好 |
| `<home>/state/extensions/user/mcp.json` | user 级 MCP 配置 |
| `<home>/state/extensions/workspaces/<wsKey>/mcp.json` | workspace 级 MCP 配置 |
| `<home>/state/extensions/{user,workspaces/<wsKey>}/skills/` | Skill 根目录 |
| `<home>/events/`、`<home>/artifacts/` | Trace 事件与 artifact |
| `<home>/worktrees/`、`<home>/plans/` | worktree 与已批准计划投影 |
| `<home>/migration-backup/` | 迁移 verified archive |

目录权限 `0700`，文件权限 `0600`（`src/runtime/contracts/storage-layout.ts`）。

### 配置格式：仅 JSON，不支持 YAML

**当前所有配置载体都是 JSON，项目没有任何 YAML 配置入口。** 仓库未引入 YAML 解析依赖（`package.json` 中无 `yaml` / `js-yaml`；lockfile 里的 `yaml@^2.4.2` 只是 vite 的**可选 peer 依赖**，且未安装），运行时也没有 `.yml` / `.yaml` 配置文件候选名。

唯一的 YAML 语法出现位置是 `SKILL.md` 的 frontmatter，由 `src/extensions/skills/frontmatter.ts` 的**有界子集 parser** 解析（自写、无依赖）：只接受标量、`[a, b]` 行内列表、缩进列表与字符串映射，明确拒绝 tab、顶层缩进、重复 key、alias（`*`/`&`）与 tag（`!`）。它不构成通用 YAML 支持，也不能用于本文其他配置项。

同理，`src/websource/internal/platform.ts` 的 `parseFrontmatter()` 只是 choosealicense 抓取所需的极窄子集解析，不是通用 YAML 解析器。`docs/` 与 `development-doc/` 中出现的 YAML 代码块均为文档示例，其中 Plan 10 的 YAML 形态最终以 JSON 落地为 `<home>/models.json`。

---

## 2. 环境变量

### 2.1 RunLedger 自身

| 变量 | 默认 | 说明 |
|---|---|---|
| `RUNLEDGER_DIR` | `~/.runledger` | 覆盖 canonical home；必须是**已存在的绝对目录**，否则启动失败 |
| `RUNLEDGER_DEBUG` | 未设置 | `1` 时把诊断写入 stderr；`--debug` 等价于为本进程设置该值 |
| `RUNLEDGER_GIT_BASH` | 自动探测 | Windows 上显式指定 git-bash 可执行文件路径 |
| `RUNLEDGER_SESSION_DIR` | 已拒绝 | 不能改变 canonical session root |

### 2.2 Host 内部变量（由 client 在 spawn 时写入，不建议手工设置）

| 变量 | 说明 |
|---|---|
| `RUNLEDGER_HOST_HOME` | resident Host 的 canonical home |
| `RUNLEDGER_HOST_SCOPE` | Host 的 workspace scope 与 build digest |
| `RUNLEDGER_HOST_CWD` | Host 工作目录 |
| `RUNLEDGER_HOST_GENERATION` | Host generation fence |
| `RUNLEDGER_HOST_SECURITY_OVERRIDE` | CLI 显式安全覆盖层（最高优先级，仍受 managed ceiling） |
| `RUNLEDGER_HOST_PEER_CREDENTIAL_HELPER` | Linux 本地对端凭据校验 helper 路径 |

### 2.3 环境信息（读取但非 RunLedger 配置）

`PATH`、`PATHEXT`、`COMSPEC`、`SystemRoot`、`LOCALAPPDATA`、`COLORTERM`（truecolor 探测）。这些由运行环境决定，RunLedger 只读取。

### 2.4 Provider 端点覆盖

多数 Provider 支持 `<PROVIDER>_BASE_URL` 覆盖默认端点（自建网关 / 区域端点）：

`AIAND_BASE_URL`、`AIMLAPI_BASE_URL`、`ALIBABA_CODING_PLAN_BASE_URL`、`ALIBABA_TOKEN_PLAN_BASE_URL`、`BASETEN_BASE_URL`、`COREWEAVE_BASE_URL`、`FIREPASS_BASE_URL`、`GMI_BASE_URL`、`KIMI_CODE_BASE_URL`、`LITELLM_BASE_URL`、`LLAMA_CPP_BASE_URL`、`LM_STUDIO_BASE_URL`、`NANOGPT_BASE_URL`、`NOVITA_BASE_URL`、`QIANFAN_BASE_URL`、`SAKANA_BASE_URL`（回退 `FUGU_BASE_URL`）、`SILICONFLOW_BASE_URL`、`SILICONFLOW_CN_BASE_URL`、`SYNTHETIC_BASE_URL`、`VENICE_BASE_URL`、`VLLM_BASE_URL`、`ZHIPU_BASE_URL`。

区域 / OAuth 端点：`AWS_REGION`、`AWS_DEFAULT_REGION`（Bedrock）、`KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST`。

### 2.5 Provider 凭据

凭据来源之一；另一来源是 TUI `/login` 与 `<home>/auth.json`。**不存在可机械替换的通用 `<PROVIDER>_API_KEY` 协议**，各 Provider 名称不同：

`ABLITERATION_API_KEY`/`ABLIT_KEY`、`AIAND_API_KEY`、`AIMLAPI_API_KEY`、`AI_GATEWAY_API_KEY`、`ALIBABA_CODING_PLAN_API_KEY`、`ALIBABA_TOKEN_PLAN_API_KEY`、`ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`、`ANT_LING_API_KEY`、`AWS_SECRET_ACCESS_KEY`、`AZURE_OPENAI_API_KEY`、`BAILIAN_TOKEN_PLAN_API_KEY`、`BASETEN_API_KEY`、`CEREBRAS_API_KEY`、`CLINE_API_KEY`、`CLOUDFLARE_API_KEY`、`COPILOT_GITHUB_TOKEN`、`COREWEAVE_API_KEY`、`DEEPINFRA_API_KEY`、`DEEPSEEK_API_KEY`、`FIREPASS_API_KEY`、`FIREWORKS_API_KEY`、`FUGU_API_KEY`、`GEMINI_API_KEY`、`GMI_API_KEY`、`GOOGLE_CLOUD_API_KEY`、`GROQ_API_KEY`、`HF_TOKEN`、`KILO_API_KEY`、`KIMI_API_KEY`、`LITELLM_API_KEY`、`LLAMA_CPP_API_KEY`、`LM_STUDIO_API_KEY`、`META_API_KEY`、`MINIMAX_API_KEY`、`MINIMAX_CN_API_KEY`、`MINIMAX_CODE_API_KEY`、`MINIMAX_CODE_CN_API_KEY`、`MISTRAL_API_KEY`、`MODEL_API_KEY`、`MOONSHOT_API_KEY`、`NANO_GPT_API_KEY`、`NOVITA_API_KEY`、`NVIDIA_API_KEY`、`OPENAI_API_KEY`、`OPENCODE_API_KEY`、`OPENROUTER_API_KEY`、`QIANFAN_API_KEY`、`QWEN_OAUTH_TOKEN`、`QWEN_PORTAL_API_KEY`、`RADIUS_API_KEY`、`SAKANA_API_KEY`、`SILICONFLOW_API_KEY`、`SILICONFLOW_CN_API_KEY`、`SYNTHETIC_API_KEY`、`TOGETHER_API_KEY`、`UMANS_AI_CODING_PLAN_API_KEY`、`VENICE_API_KEY`、`VLLM_API_KEY`。

> MCP 配置中的 `${ENV_VAR}` 模板可以引用上述变量，但**拒绝 `RUNLEDGER_` 前缀**（保留命名空间），见第 8 节。

---

## 3. CLI 启动参数

完整语义、限制与示例见 [CLI 参数表](cli.md)。此处按功能分类列出全部参数，便于对照。

### 3.1 通用

| 参数 | 简写 | 值 | 说明 |
|---|---|---|---|
| `--help` | `-h` | 无值 | 输出帮助并退出 |
| `--version` | `-v` | 无值 | 输出版本并退出 |
| `--debug` | — | 无值 | 设置 `RUNLEDGER_DEBUG=1` |

### 3.2 模型与推理

| 参数 | 值 | 默认 | 说明 |
|---|---|---|---|
| `--provider <id>` | provider ID | 沿用选择流程 | 覆盖 `settings.provider` |
| `--model <id>` | `-m <id>`，模型 ID | 沿用选择流程 | 覆盖 `settings.model` |
| `--thinking <level>` | `off\|minimal\|low\|medium\|high\|xhigh\|max` | 沿用恢复状态 / settings | 仍受模型能力约束 |
| `--hide-thinking` | 无值 | 沿用展示设置 | 仅本次隐藏，不写 settings |

### 3.3 会话选择与 Profile

| 参数 | 值 | 说明 |
|---|---|---|
| `--continue` / `-c` | 无值 | 当前 workspace 内 `updatedAtMs` 最新的可继续 Session |
| `--resume` / `-r` | 无值 | 当前与 `--continue` 同一选择逻辑 |
| `--session-id <id>` | 精确 session ID | 从 canonical SQLite 打开并校验 workspace 绑定 |
| `--session <path>` | legacy 文件路径 | 解析器保留，标准 Runtime 拒绝直接打开 JSONL |
| `--fork <sessionId>` | 精确源 session ID | 派生新 Session，继承 Harness Profile |
| `--fork-raw` | 无值 | 配合 `--fork`，使用原始历史，不继承 compact 投影 |
| `--fork-at <sequence>` | 正整数事件序号 | 配合 `--fork`，回退到已完成 assistant 轮次的事件边界 |
| `--harness-profile <p>` | `standard\|minimal` | 仅新建；不能与打开 / 继续 / fork 搭配 |
| `--mode <mode>` | `default\|minimal\|plan` | 新建 Session 的用户模式（映射到内置 Harness Profile） |
| `--session-dir <dir>` | — | **已拒绝**；使用预创建的 `RUNLEDGER_DIR` |

### 3.4 非交互执行

| 参数 | 值 | 说明 |
|---|---|---|
| `--prompt-file <path>` | 文件路径 | 新建非交互 Session，读取任务文件，输出 JSONL 后退出；不能与恢复或 control 命令组合 |

### 3.5 权限、网络与 Bash 分析

这些参数进入 Session Security 的 `cli` 层，仍受 managed constraints 与运行时能力检查限制。

| 参数 | 值 | 说明 |
|---|---|---|
| `--permission-profile <name>` | `read-only\|workspace-write\|danger-full-access` 或 named profile ID | 选择权限预设 |
| `--approval-policy <policy>` | `on-request\|never\|untrusted\|granular` | 批准策略；`granular` 覆盖同时启用五类批准开关 |
| `--bash-analyzer <mode>` | `legacy\|shadow\|ast` | Bash 安全分析模式 |
| `--sandbox <profile>` | `off\|read-only\|workspace-write\|strict\|external` | 既有 sandbox profile；实际生效取决于 backend |
| `--network <mode>` | `deny\|allow\|allowlist\|review` | 网络策略；managed 强制禁网仍有效 |
| `--network-host <host>` | 可重复，1–512 字符 | allowlist / review 的 host；转小写、去尾点、去重 |

约束：`--network allowlist` 至少一个 host；提供 host 时必须显式 `--network allow|allowlist|review`；`deny` 不接受 host；host 不能含 scheme、`/`、`@`、NUL。

### 3.6 Worktree 与有界多 Agent

| 参数 | 值 | 默认 | 说明 |
|---|---|---|---|
| `--worktree [label]` | label 可省略 | 不创建 | 请求创建 / 复用 Session managed worktree |
| `--worktree-ref <ref>` | git ref | — | 创建基线 ref；本身不启用 worktree |
| `--worktree-branch <name>` | 分支名 | — | 创建分支；本身不启用 worktree |
| `--no-worktree` | 无值 | `false` | 与 `--worktree` 互斥 |
| `--experimental-multi-agent` | 也可 `=true` / `=false` | `false` | 打开 runtime gate；仍需 user settings 启用、workspace 未禁用、Profile 允许 |

---

## 4. 用户级 `settings.json` — 模型与推理

文件：`<home>/settings.json`。未声明字段在加载时被丢弃；`compaction`、`goal`、`loop`、`recording` 的**未知键会导致整段丢弃或报错**，不接受拼错键静默生效。

| 字段 | 类型 / 取值 | 默认 | 说明 |
|---|---|---|---|
| `provider` | string（非空） | 由选择流程决定 | 默认 provider ID，与 `model` 共同组成稳定模型身份 |
| `model` | string（非空） | 由选择流程决定 | 默认模型 ID；`--model` 优先级更高 |
| `thinkingLevel` | `off\|minimal\|low\|medium\|high\|xhigh\|max` | 由模型能力决定 | `--thinking` 优先级更高 |
| `enabledModels` | string[] | 无白名单 | `/model` 选择器可见模型白名单；空数组视为无白名单 |
| `autoTitle` | boolean | `true` | 首个合格用户输入触发异步 Session 自动标题 |
| `hideThinkingBlock` | boolean | `false` | 仅 TUI 展示层隐藏 thinking blocks；不改变模型请求 |
| `agentMode` | `default\|minimal\|plan` | 由新建流程决定 | 新建 Session 默认模式；**仅 user 层**，恢复与 fork 继承 durable profile |

## 5. 用户级 `settings.json` — 界面与交互

| 字段 | 类型 / 取值 | 默认 | 说明 |
|---|---|---|---|
| `theme` | syntax theme 名，见下方列表 | 内建默认 | 代码高亮主题；`dark` / `light` 是兼容输入，映射为自适应 pair |
| `logo` | `/^[A-Za-z]{1,32}$/`，自动转小写 | `runledger` | Welcome 页 Logo 字母 |
| `uiTheme.preset` | `default\|neutral\|high-contrast` | `default` | TUI 配色预设 |
| `uiTheme.mode` | `auto\|dark\|light` | `auto`（跟随终端） | 明暗模式 |
| `uiTheme.colors.common` | `#RRGGBB` 映射 | 无 | 两种模式共用的颜色覆盖 |
| `uiTheme.colors.dark` / `.light` | `#RRGGBB` 映射 | 无 | 指定模式的颜色覆盖；优先级高于 `common` |
| `steeringMode` | `one-at-a-time\|all` | `one-at-a-time` | 运行中输入（steering）的排队方式 |
| `followUpMode` | `one-at-a-time\|all` | `one-at-a-time` | 运行后追加消息的排队方式 |

`uiTheme.colors` 可用的 22 个键：`primary`、`secondary`、`accent`、`muted`、`success`、`warning`、`error`、`info`、`background`、`surface`、`surfaceAlt`、`border`、`editorBackground`、`userMessage`、`assistantMessage`、`thinkingText`、`toolCall`、`toolResult`、`toolError`、`status`、`hint`、`link`。未知键与非 `#RRGGBB` 值会被记录为诊断并丢弃。

内建 syntax theme（32 个）：`1337`、`ansi`、`base16`、`base16-256`、`base16-eighties-dark`、`base16-mocha-dark`、`base16-ocean-dark`、`base16-ocean-light`、`catppuccin-frappe`、`catppuccin-latte`、`catppuccin-macchiato`、`catppuccin-mocha`、`coldark-cold`、`coldark-dark`、`dark-neon`、`dracula`、`github`、`gruvbox-dark`、`gruvbox-light`、`inspired-github`、`monokai-extended`、`monokai-extended-bright`、`monokai-extended-light`、`monokai-extended-origin`、`nord`、`one-half-dark`、`one-half-light`、`solarized-dark`、`solarized-light`、`sublime-snazzy`、`two-dark`、`zenburn`。

## 6. 用户级 `settings.json` — 会话自动化

| 字段 | 类型 | 默认 | 边界 | 说明 |
|---|---|---|---|---|
| `recap.enabled` | boolean | `true` | — | 空闲 recap 总闸 |
| `recap.idleSeconds` | number | `240` | 1–3600 | 触发 recap 的空闲秒数 |
| `goal.enabled` | boolean | `true` | — | Goal Mode 总闸 |
| `goal.autoContinuation` | boolean | `true` | — | 目标未完成时自动续跑 |
| `goal.continuationDelaySeconds` | number | `30` | 1–3600 | 续跑前的空闲窗口 |
| `goal.maxContinuations` | number | `20` | 0–1000 | 最大自动续跑次数 |
| `loop.enabled` | boolean | `true` | — | Loop 总闸 |
| `loop.maxIterations` | number | `50` | 1–1000 | 无显式 limit 时的硬上限 |
| `loop.conditionEnabled` | boolean | `false` | — | 是否允许条件谓词终止 |

越界值会被夹到区间内（不是报错）。`goal` / `loop` 的未知键导致整段丢弃。

## 7. 用户级 `settings.json` — 上下文压缩

`compaction` 为部分覆盖，与默认值合并。**仅 user 层**；workspace 层写入会直接报错。

| 字段 | 类型 / 取值 | 默认 | 边界 |
|---|---|---|---|
| `enabled` | boolean | `true` | — |
| `nativeMode` | `standalone\|streaming` | `standalone` | — |
| `pruneSuperseded` | boolean | `true` | — |
| `dropUseless` | boolean | `false` | — |
| `strategy` | `single-pass\|hierarchical\|handoff\|openai-responses-native` | `single-pass` | — |
| `retainRecentTokens` | number | `20000` | 1–1,000,000 |
| `maxSummaryTokens` | number | `4096` | 32–32,768 |
| `maxSummaryBytes` | number | `32000` | 128–131,072 |
| `maxModelCalls` | number | `16` | 1–64 |
| `maxTotalInputTokens` | number | `1000000` | 128–4,000,000 |
| `maxTotalOutputTokens` | number | `65536` | 32–262,144 |
| `maxLevels` | number | `5` | 1–8 |
| `timeoutMs` | number | `120000` | 1,000–600,000 |
| `auto` | boolean | `false` | — |
| `threshold` | number | `0.85` | 0.1–0.95 |
| `thresholdTokens` | number | 未设置 | 1–4,000,000 |
| `reserveTokens` | number | 未设置 | 1–4,000,000 |
| `summaryModel` | `{ provider: string, id: string }` | 未设置 | provider ≤128、id ≤256 字符 |

`retainRecentTurns` 已被移除，写入会报错，需改用 `retainRecentTokens`。

## 8. 用户级 `settings.json` — 记录与追踪

`recording` **仅 user 层**授权，workspace 层写入被拒绝。

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `mode` | `off\|events\|events_and_artifacts` | `events` | `off` 关闭本地 Trace；`events_and_artifacts` 额外落 artifact |
| `failurePolicy` | `best_effort\|fail_closed` | `best_effort` | 记录失败时是否让操作失败 |

`recording` 为「存在即解析」：出现非法值或非法键时整段失效并回退为 `{ mode: "off" }`，同时向 stderr 写诊断。该字段只控制**本地** Trace，不配置远程 exporter / OTLP / Opik。

## 9. 用户级 `settings.json` — 有界多 Agent

`multiAgent` user 与 workspace 两层都可用；workspace 只能**收窄**。硬上限不可被任何层放宽。

| 字段 | 默认（=硬上限） | 说明 |
|---|---|---|
| `enabled` | `false` | 总闸；还需 `--experimental-multi-agent` 与 Profile 允许 |
| `maxChildrenPerRoot` | `3` | 单个 root 的子 Agent 上限 |
| `maxTotalAgents` | `4` | 含 root 的总 Agent 数 |
| `maxModelTurnsPerAgent` | `12` | 单 Agent 模型轮次上限 |
| `maxToolCallsPerAgent` | `32` | 单 Agent 工具调用上限 |
| `maxActiveDurationMsPerAgent` | `300000` | 单 Agent 活跃时长上限（毫秒） |
| `maxReportBytes` | `65536` | 子 Agent 报告字节上限 |

交叉约束：`maxTotalAgents ≥ 2` 且 `maxChildrenPerRoot ≤ maxTotalAgents − 1`；workspace 层写入大于 user 有效值的上限会产生 diagnostic 并被忽略；workspace 不能在 user 关闭时启用。

> 配置值 ≠ 当前运行时能力。当前产品内 child 委派为 root-owned、depth=1、只读、**同一 root 最多一个 active child**，配置不能开启并行或可写 child。

## 10. 用户级 `settings.json` — Skills、Plugins、Marketplace

### 10.1 `skills`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总闸；user `false` 后 workspace / Session 只能进一步关闭 |
| `providers` | `{ [providerId]: boolean }` | 见下 | 已知 provider exact ID 开关；未知 ID 只产生 diagnostic |

已知 provider ID：`runledger-builtin`、`runledger-user`、`runledger-workspace`、`runledger-repo`、`runledger-session`、`runledger-plugin`、`omp-user`、`omp-project`、`codex-user`、`codex-project`、`agents-user`、`agents-project`、`claude-user`、`claude-project`、`claude-plugins`。

键名规则 `/^[a-z0-9][a-z0-9-]{0,63}$/`，最多 32 条；任一条非法导致整段 `skills` 丢弃。

### 10.2 `plugins`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `values` | `{ [packageId]: { [key]: string \| number \| boolean } }` | 无 | plugin settings 的**值层**；声明式 schema 在分发包的 `package.json#runledger` |
| `watch` | boolean | `false` | 观察已安装 plugin root，在 **idle 边界**请求交换 snapshot；in-session 变更需重开会话生效 |

`packageId` ≤128 字符，键 ≤64 字符；非法条目**逐条丢弃**（不是整段失效）。secret 键只能在 user 层设置，workspace 层取值返回 `secret_scope_denied`。

### 10.3 `marketplace`

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `autoUpdate` | `off\|notify\|auto` | `off` | **仅 user 层**；`notify` 通过 `discover` 的 `pendingUpdates` 与 TUI notice 提示，`auto` 只刷新 catalog，不代替用户安装 / 启用 / 信任 |

## 11. 用户级 `settings.json` — Web 检索

`webSearch` 声明在 `ProjectSettings` 中，字段如下。**user 层拥有 `order` / `timeoutSeconds` / `searxng` 的 authority**；workspace 层只能追加 `exclude` 收窄（见第 13 节）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `order` | string[] | 内建顺序 | 优先 provider 列表；未识别的 id 在解析时丢弃。**仅 user 层** |
| `exclude` | string[] | 无 | 永不使用的 provider；只做排除。user 与 workspace 均可写，两层取并集 |
| `timeoutSeconds` | number | `60` | 单次 provider 传输硬超时；上限 300。**仅 user 层** |
| `searxng.endpoint` | string | 无 | SearXNG 端点。**仅 user 层** |
| `searxng.token` | string | 无 | SearXNG token。**仅 user 层** |
| `searxng.basicUsername` / `basicPassword` | string | 无 | Basic 认证。**仅 user 层** |
| `searxng.engines` / `categories` | string[] | 无 | 引擎与分类过滤。**仅 user 层** |
| `searxng.language` | string | 无 | 语言。**仅 user 层** |
| `searxng.safesearch` | number | 无 | 安全搜索等级。**仅 user 层** |

provider id 列表在清洗时去重并保持首次出现顺序；未识别的 id 由 `storage/web-search-settings.ts` 在消费时过滤，不会因拼写错误改变 fallback 顺序。

## 12. 用户级 `settings.json` — 权限与安全（`security` 段）

`security` 段写在同一个 `settings.json` 里，由 `SecuritySettingsPort` 以 compare-and-swap 方式维护。**CLI 与 TUI 不提供任意 JSON 写入口**，实际编辑请用 `runledger security inspect` 与 TUI 权限预设。

### 12.1 顶层字段

| 字段 | 取值 | 说明 |
|---|---|---|
| `profile` | profile ID（`/^[A-Za-z0-9][A-Za-z0-9._~-]*$/`，≤128） | 选中的命名 profile |
| `profiles` | `{ [profileId]: PermissionProfile }` | 自定义 profile 定义，见 12.2 |
| `approvalPolicy` | `on-request\|never\|untrusted\|granular` | 批准策略；`granular` 必须同时给 `granularApproval` |
| `approvalReviewer` | `user\|auto-review` | 批准审查者 |
| `granularApproval` | object，见 12.3 | 细粒度批准开关 |
| `sandbox` | `off\|read-only\|workspace-write\|strict\|external` | sandbox profile |
| `network` | `{ mode, allowedHosts }` | 网络策略，见 12.4 |
| `filesystem` | object，见 12.5 | 文件系统边界 |
| `rules` | 数组，见 12.6 | allow / ask / deny 规则，最多 1024 条 |
| `bashAnalyzerMode` | `legacy\|shadow\|ast` | Bash 分析模式 |
| `managedConstraints` | object，见 12.7 | **只允许出现在 managed / organization 来源** |

`additionalProperties: false` —— 任何未知字段使整段安全配置失效（fail closed）。

### 12.2 `profiles.<id>`（PermissionProfile）

| 字段 | 取值 |
|---|---|
| `extends` | profile ID |
| `approvalPolicy` | 同 12.1 |
| `approvalReviewer` | `user\|auto-review` |
| `granularApproval` | 同 12.3 |
| `filesystemMode` | `read-only\|workspace-write\|unrestricted` |
| `sandbox` | 同 12.1 |
| `network` | 同 12.4 |
| `filesystem` | 同 12.5 |

### 12.3 `granularApproval`

`sandboxApproval`、`rules`、`skillApproval`、`requestPermissions`、`mcpElicitations` —— 五个 boolean，全部必填，无额外字段。

### 12.4 `network`

| 字段 | 取值 | 约束 |
|---|---|---|
| `mode` | `deny\|allow\|allowlist\|review` | `deny` 不能带 host；`allowlist` 至少一个 host |
| `allowedHosts` | string[]，最多 256，去重 | 每项 1–512 字符，不能含 `://`、`/`、`@`、NUL；`*` 是唯一合法的通配形式 |

### 12.5 `filesystem`

| 字段 | 类型 | 说明 |
|---|---|---|
| `readRoots` | string[]（≤4096 字符/项，≤256 项） | 允许读取的根 |
| `writeRoots` | 同上 | 允许写入的根 |
| `denyRead` | 同上 | 拒绝读取 |
| `denyWrite` | 同上 | 拒绝写入 |
| `protectedPaths` | 同上 | 受保护路径 |

### 12.6 `rules[]`

| 字段 | 取值 |
|---|---|
| `id` | `/^[A-Za-z0-9][A-Za-z0-9._~-]*$/`，≤128，**不可重复** |
| `action` | `allow\|ask\|deny` |
| `kind` | `filesystem\|shell\|network\|worktree\|tool` |
| `pattern` | 1–512 字符 |

### 12.7 `managedConstraints`

| 字段 | 取值 | 说明 |
|---|---|---|
| `allowedProfiles` | profile ID[]，1–256，去重 | 允许的 profile 白名单 |
| `allowedApprovalPolicies` | 批准策略[]，1–4，去重 | 允许的批准策略 |
| `minimumSandbox` | sandbox profile | sandbox 强度下限 |
| `forceNetworkDeny` | boolean | 强制禁网 |
| `minimumBashAnalyzerMode` | `legacy\|shadow\|ast` | Bash 分析模式下限 |

managed / organization 来源**只能收紧**：不得声明 `profile`、`profiles`、`approvalPolicy`、`approvalReviewer`、`granularApproval`、`sandbox`、`network`；不得声明 `filesystem.readRoots` / `writeRoots`；规则不得含 `allow`。

### 12.8 内置权限预设

| 预设 ID | 标签 | approvalPolicy | filesystemMode | network | sandbox | 需显式确认 |
|---|---|---|---|---|---|---|
| `workspace-write` | `ask_for_approval` | `on-request` | `workspace-write` | `review` | `workspace-write` | 否 |
| `approve-for-me` | `approve_for_me` | `on-request` | `workspace-write` | `review` | `workspace-write` | 否 |
| `danger-full-access` | `full_access` | `never` | `unrestricted` | `allow` | `off` | **是** |

另有两个非预设内置 profile：`read-only`（`on-request` / `read-only` / `deny` / `read-only`）、`headless-workspace`（`never` / `workspace-write` / `deny` / `workspace-write`），以及 `custom`（等同 `workspace-write` 但名称不同）。

sandbox 强度序：`off < external < workspace-write < read-only < strict`。sandbox 非 `off` 时需要平台 capability 支持文件系统与子进程隔离，否则预设标记为不可用。

---

## 13. Workspace 级 `settings.json`

文件：`<home>/projects/<wsKey>/settings.json`（`wsKey` = `ws-` + 64 位十六进制 sha256）。

| 字段 | workspace 层行为 |
|---|---|
| `compaction` | **拒绝**：加载即报 `compaction is only allowed in user settings` |
| `agentMode` | **拒绝**：加载即报 `agentMode must be default\|minimal\|plan in user settings` |
| `recording` | 加载时忽略；写入时报 `unsupported_setting` |
| `marketplace` | 加载时忽略 |
| `uiTheme` | 加载时忽略 |
| `multiAgent` | 可写，但只能收窄 user 有效值 |
| `skills` | 可写，但只能收窄（user `false` 不可被反转） |
| `webSearch` | 可写，但只保留 `exclude`；`order` / `timeoutSeconds` / `searxng` 被丢弃 |
| 其余（`provider`、`model`、`thinkingLevel`、`autoTitle`、`recap`、`goal`、`loop`、`theme`、`logo`、`enabledModels`、`steeringMode`、`followUpMode`、`hideThinkingBlock`、`plugins`） | 可写 |

`sessionDir` 在任何层都被结构化拒绝，且不会被持久化。

---

## 14. TUI 偏好（`state/tui-preferences.json`）

本地展示偏好，不属于 Session 状态。版本固定为 `2`，版本不符时回退默认值并产生诊断。

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `version` | `2` | `2` | 固定版本号 |
| `trajectory.duration` | boolean | 未设置 | 轨迹是否显示耗时 |
| `trajectory.turnsCollapsed` | boolean | 未设置 | 轮次默认折叠 |
| `trajectory.callsCollapsed` | boolean | 未设置 | 工具调用默认折叠 |
| `transcript.scrollbar` | `hidden\|visible` | `hidden` | 对话区滚动条 |
| `display.shimmer` | `classic\|kitt\|disabled` | `classic` | 流式输出动效 |

---

## 15. 扩展配置

### 15.1 MCP（`mcp.json`）

位置：`<home>/state/extensions/user/mcp.json`（user）、`<home>/state/extensions/workspaces/<wsKey>/mcp.json`（workspace）。文档根只接受 `mcpServers`，最多 128 个 server；server 名 `/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/`。

| 字段 | 取值 / 默认 | 说明 |
|---|---|---|
| `transport` | `stdio\|streamable-http` | 必填 |
| `command` | string ≤1024 | `stdio` 必填；`streamable-http` 禁止 |
| `args` | string[]，≤128 项，≤4096 字符/项 | `stdio` |
| `env` | `{ [K]: string }`，≤128 项，≤8192 字符/值 | 键需匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`；支持 `${ENV_VAR}` 模板 |
| `cwd` | string ≤4096 | 必须包含在配置根内；支持 `${ENV_VAR}` |
| `url` | string ≤4096 | `streamable-http` 必填，仅 `http:` / `https:`；`stdio` 禁止 |
| `headers` | `{ [K]: string }`，≤64 项 | 仅 `streamable-http`；支持 `${ENV_VAR}` |
| `enabled` | boolean，默认 `false` | 是否启用 |
| `required` | boolean，默认 `false` | 启动失败是否阻断 |
| `startupTimeoutMs` | 正整数，默认 `30000`，上限 1,800,000 | 启动超时 |
| `toolTimeoutMs` | 正整数，默认 `120000`，上限 1,800,000 | 工具调用超时 |
| `toolTimeouts` | `{ [toolName]: ms }`，≤512 项 | 按工具覆盖超时 |
| `enabledTools` / `disabledTools` | string[]，≤512 项，≤256 字符/项 | 工具过滤 |
| `maxResultBytes` | 正整数，上限 16,777,216 | 结果字节上限 |
| `supportsParallelToolCalls` | boolean | 是否支持并行工具调用 |

`${ENV_VAR}` 模板**拒绝 `RUNLEDGER_` 前缀**。配置中的错误会使该 server 被丢弃；若文档解析出 error，则同名的已声明 server 全部被屏蔽。

### 15.2 Hooks（`hooks.json`）

| 字段 | 取值 | 说明 |
|---|---|---|
| `hooks[].id` | `/^[A-Za-z][A-Za-z0-9._-]{0,127}$/` | 必填 |
| `hooks[].matcher` | matcher 表达式 | 决定命中的工具 / 事件 |
| `hooks[].failureMode` | failure mode 枚举 | handler 失败时的行为 |
| `hooks[].handlers[]` | 数组 | 每项含 `type`（必填）、`command`、`args`、`timeoutMs`、`env` |

根只接受 `hooks` 键；hook 只接受 `id`、`matcher`、`failureMode`、`handlers`；handler 只接受 `type`、`command`、`args`、`timeoutMs`、`env`。

### 15.3 LSP（`lsp.json` / `.lsp.json`）

只读 `<cwd>/lsp.json` 与 `<cwd>/.lsp.json`（仅 JSON，无 YAML / 用户级 / 插件级）。文档可以是 `{ "servers": { ... } }` 或直接以服务名为键。

| 字段 | 取值 | 说明 |
|---|---|---|
| `command` | 非空 string | 必填；先按路径解析，再按本地 `node_modules/.bin`、`.venv/bin`、`venv/bin`、`bin`，最后查 `PATH` |
| `args` | string[] | 启动参数 |
| `fileTypes` | string[] | 必填（可与内建服务合并后补齐） |
| `rootMarkers` | string[] | 必填；支持 `*.ext` 通配 |
| `languageId` | string | LSP language id |
| `initOptions` | object | 整体替换，不深合并 |
| `settings` | object | 整体替换，不深合并 |
| `disabled` | boolean | 禁用该服务 |
| `warmupTimeoutMs` | number | 预热超时 |
| `workspaceReadyTimings` | `{ timeoutMs, pollMs, settleMs, statusRequestTimeoutMs }` | workspace 就绪判定 |
| `capabilities` | `{ flycheck, ssr, expandMacro, runnables, relatedTests }`（boolean） | 能力开关 |
| `isLinter` | boolean | 是否作为 linter |

覆盖为**浅合并**：同名服务的高层字段整体替换。

### 15.4 Plugin 声明式 settings（`package.json#runledger`）

插件在 manifest 里**声明** schema，值存放在 `settings.json#plugins.values`。

| 字段 | 取值 | 说明 |
|---|---|---|
| 键名 | `/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/`，≤64 字符，最多 64 个 | settings key |
| `type` | `string\|number\|boolean\|enum` | 值类型 |
| `values` | string[]，≤64 项，≤256 字符/项 | 仅 `enum` 使用，必须非空去重 |
| `default` | string ≤1024 / number / boolean | 未显式设置时补齐 |
| `secret` | boolean | 为 `true` 时只能在 user 层设置 |

值域：string ≤4096 字符；number 为 `[-1e9, 1e9]` 内的有限数；boolean 接受 `true` / `false` 与字符串 `"true"` / `"false"`。

### 15.5 自定义 Provider / 上游模型代理（`models.json`）

位置：`<home>/models.json`（JSON，`src/providers/configured-proxy.ts`）。用于接入同时暴露 Anthropic Messages 与 OpenAI Chat Completions 双 wire 的代理（new-api / one-api / 同类服务）。文档根只接受 `providers` 对象；配置的 provider ID **不能与内建 provider 冲突**（冲突直接报错），`name` 可选且必须是非空字符串。

| 字段 | 取值 / 默认 | 说明 |
|---|---|---|
| `baseUrl` | 非空 string，必填 | 代理端点，规范化为以 `/v1` 结尾 |
| `apiKey` | string | 可选；也可走环境变量 |
| `authHeader` | boolean，默认 `false` | `true` 时发送 `Authorization: Bearer <key>`（替代 Anthropic 系 `x-api-key`） |
| `disableStrictTools` | boolean，默认 `false` | 代理不支持 strict tool schema 时关闭 |
| `headers` | `{ [K]: string }` | 附加请求头 |
| `discovery.type` | `"proxy"`，必填 | 双 wire 自动探测 |
| `discovery.timeoutMs` | 正整数，默认 `5000` | 探测超时 |

wire 探测按 Anthropic → OpenAI 的固定顺序进行，结果由进程内缓存持有（成功 5 分钟 / 失败 10 秒），不宣称跨进程恢复。

### 15.6 扩展配置层优先级

`builtin(0) < user(10) < project(20) < session(30) < cli(40) < managed(100)`，同层按 source 名与 digest 排序后深合并。

---

## 16. 已拒绝与保留参数

| 参数 | 状态 |
|---|---|
| `--session-dir <dir>`、`--session-dir=...` | 已拒绝，报 `unsupported_cli_authority` |
| `RUNLEDGER_SESSION_DIR` | 已拒绝 |
| `settings.sessionDir`（任意层） | 已拒绝，且不会被持久化 |
| `compaction.retainRecentTurns` | 已移除，写入报错 |
| 顶层 `--flag=value`（除 `--mode=`、`--experimental-multi-agent=`、子命令明确支持者） | 归入未知参数，不应用覆盖 |
| 未知 flag | 被收集但不报错，**拼写错误可能被静默忽略** |

---

## 17. 已知差异（文档与实现）

以下为本次核对中发现的、与既有文档或接口声明不一致之处，按源码事实记录：

1. **`recording` 默认值**：实现为 `{ mode: "events", failurePolicy: "best_effort" }`（`src/storage/settings-manager.ts`）。[CLI 参数表](cli.md) 第 5 节写作「默认 `off + best_effort`」，与实现不符。
2. **`webSearch` 曾是未接线字段（已修复）**：`ProjectSettings` 声明了 `webSearch`，`src/runtime/session-runtime/domain.ts` 也消费 `options.settings.webSearch`，但此前 `sanitizeProjectSettings()` 未保留该键，写进 `settings.json` 会被整体丢弃。已在 `f15ccf2` 修复：user 层全量保留，workspace 层只保留 `exclude`，CLI `openView()` 用 `mergeWebSearchSettings()` 把 workspace 的 exclude 收窄合并到 user 有效值上。
3. **`docs/cli.md` 未覆盖的启动参数**：`--mode`、`--fork-raw`、`--fork-at`、`--prompt-file` 已在 `src/cli/args.ts` 中解析并消费，但 CLI 参数表仍称「当前没有顶层 `--prompt`、`--print`」。
4. **workspace 层非法字段会抛错**：`compaction` 与 `agentMode` 出现在 workspace `settings.json` 时，`loadProjectSettings()` 抛异常而非返回诊断，该 workspace 的 settings 加载会整体失败。
5. **`multiAgent` 配置上限 ≠ 运行时能力**：配置允许 `maxChildrenPerRoot: 3`、`maxTotalAgents: 4`，但当前产品内 child 委派仍是同一 root 最多一个 active child。

---

## 18. 维护约定

- 新增或修改配置字段时，同步更新本文对应表格与 `src` 链接；新增配置文件类型时更新第 1 节布局表与 [docs 总览](README.md)。
- 参数语义、解析规则与限制以 `src/cli/args.ts`、`src/storage/settings-manager.ts`、`src/security/config/schema.ts`、`src/extensions/mcp/config.ts` 为准。
- 「解析器接受」不等于「生产能力已接通」；`--sandbox`、`--network` 等受 backend 与 managed constraints 限制，不能仅凭参数证明 OS 隔离已生效。
