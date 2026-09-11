# standard 执行提示词与 Codex 行为缺口

日期：2026-09-11。状态：standard@2 提示词与版本接线已实现，本地自动化及构建后 CLI/TUI 验收通过；§5 的能力缺口与真实模型行为评测保持未完成。

## 1. 输入与范围

用户提供的 `codex.md` 是 848 行的会话导出样本，SHA-256 为 `0268130a4978d0014b2bd84c577b7aadb6978d4724d0508ff42257a65655fb3f`。其中 1–172 行是主要行为规则，174–246 行含动态 Skill、权限和开发助手协作配置，248 行起是用户消息，260 行起是工具定义。它不能整份作为 RunLedger system prompt。

本次实现 standard 模式的行为基座、AGENTS 来源标记及版本发布。§5 列出依赖其他产品能力的缺口，只给出条件和说明，不在本次顺带实现。OS sandbox、并行/可写 child、外部账号接入和付费模型调用均不属于本次实现。

比较依据是当前生产 Session Owner 路径，不以 legacy Host、存在的 DTO 或测试 fixture 推断生产能力。源码入口为 [domain](../../src/runtime/session-runtime/domain.ts)、[model-request-adapter](../../src/runtime/context/model-request-adapter.ts)、[工具表](../../src/runtime/tools/index.ts)。

## 2. 已落实的提示词行为

固定正文位于 [standard-prompt.ts](../../src/runtime/harness-profiles/standard-prompt.ts)，由 standard@2 descriptor 持有，正文参与 descriptor digest。以下是已写入的行为规则，不代表模型对每条规则的遵循率已经通过真实模型评测。

| Codex 输入位置 | RunLedger 采用的规则 | 本次适配 |
|---|---|---|
| 17–27：Autonomy and persistence | 将实现、修复、启动等请求执行至可验证结果；只读调查保持只读 | 明确实际完成或具体阻碍才能结束，不把计划或后台句柄当交付 |
| 5–15：Permission | 同一动作与范围不重复请求已有授权；先完成已授权准备再请求必要批准 | 对执行权限以 Session runtime 为准；可逆不自动等于允许，拒绝后不得换工具绕过 |
| 63–73：Working with the user | 常规选择自行决定；实质性歧义才提问；补充消息通常延续原任务 | 没有结构化提问工具时用普通文本，不伪装异步提问或把超时当批准 |
| 29–59、75–102：Communication | 跟随用户语言，报告有意义的进展，最终给出结果/验证/阻碍；review 先给发现 | 不写入模型品牌；不要求所有 provider 存在相同 channel；阻塞工具期间不承诺固定秒数发言 |
| 114–128：Getting work done | 有界搜索、适当验证、shell 正确引用、避免重复检查 | 工具名与参数以本次 schema 为准，不复制 functions.exec 的 JavaScript API |
| 130–172：Skills/Apps/Plugins | 相关时发现与加载 Skill；尊重来源、信任、权限与用户范围 | 使用 RunLedger Skill/MCP discovery；未接入的账号、图片、交互工件、记忆不宣称可用 |
| 71–73：Compaction continuity | 延续目标、已接受决定、未完事项与证据 | 只使用实际提供的历史/状态，不假定存在 Codex 的上下文恢复基础设施 |
| 工具区：process / collaboration | 观察后台进程至必要结果；未知副作用先检查再重试；委派服从当前能力 | 保留治理链与产品内 bounded child 限制，不引入四槽并行/可写共享 workspace |

另补充共享工作区保护：保留无关修改、暂存和进程；提交/推送服从用户和项目规则。通用基座不替所有仓库决定自动提交策略。

## 3. 装配与版本合同

- CLI 新建 `default`、`/mode default` 或显式新建 `--harness-profile standard` 选择 `standard@2`。已有会话内不带模式的 `/new` 继续继承源 profile；要从旧 standard 切到新版本，使用 `/mode default` 创建新会话。旧 `standard@1` descriptor digest 与 `buildSystemPrompt()` 字节合同保持不变；恢复、attach、takeover 和 fork 使用已存 ref，不自动切换版本。
- `standard@2` 使用 `prompt.mode="assembled"`，其中 `prompt.text` 是固定行为基座；环境、AGENTS 和动态权限仍需要装配。`complete` 模式的 text 继续代表完整提示词。standard@1 的 assembled descriptor 没有 text。
- `standard@2` descriptor SHA-256：`a75de0135aed387912ae6beeb76df4ad317a4aa829579b39c1194c1865aa9527`。改正文必须发布新 profile；不能使用同一个 ref 偷换行为。
- [standard-system-prompt.ts](../../src/runtime/session-runtime/standard-system-prompt.ts) 按固定基座、当前工作目录/profile、带来源及范围的用户/工作区 AGENTS 组装。AGENTS 正文保存在 JSON content 字符串中，来源和原文边界可解析；来源标记不构成权限或注入安全边界。
- 固定基座说明适用目录、用户明确要求与项目/Skill 建议之间的关系。当前自动读取范围仍是用户级 AGENTS 和 cwd/AGENTS.md；嵌套/父目录自动发现见 §5，不通过文案宣称已经实现。
- 新基座不硬编码有效权限值、外部账号、工具 schema、Skill 安装路径或模型身份。当前有效权限仍由 `session-effective-permissions` 每次请求注入，Skill catalog 仍按 Session extension source 注入，工具定义继续独立传给 provider。
- 私有 composition override 不得去掉 standard@2 固定基座；在创建有生命周期的资源前校验。standard@1 原 override 语义保持不变。
- `minimal@1`、`minimal@2` 与 `plan@1` 的固定正文、工具表和权限 authority 均保持原合同。

## 4. 存储升级与用户操作

SQLite schema 6 只增加 standard@2 exact ref 的插入/更新允许项；schema 5 的 exact SQL/digest 不改写。历史 Session profile、事件、checkpoint 和 fork lineage 不被转换。

新空库安装 schema 6。已有库的普通启动只检查版本，要求显式运行：

```sh
runledger migrate schema --confirm
```

该命令使用当前 canonical home，要求既有 state.db 和零 active owner；有 active Session 时拒绝，不主动关闭它们。没有确认参数时不会打开/创建库。迁移使用现有离线 admission gate、事务 DDL 和 format digest 校验。旧 binary 的 schema 上限会拒绝 schema 6。

升级存储不改变旧会话提示词。关闭旧进程后，显式迁移，再新建 default 会话，才能使用 standard@2；恢复旧会话继续使用旧 profile。本任务只对隔离目录执行迁移测试，不迁移真实用户数据库。

## 5. Codex 中提到但 RunLedger 缺失或仅部分具备的行为

下表中的“缺失”限定为当前标准 Session Owner 产品路径，不等于整个仓库没有相关代码。Codex 样本中定义了某项能力，也不代表该次会话允许调用它，例如样本同时禁止了自主多 Agent 委派。

| 行为与 Codex 对照 | RunLedger 当前状态及依据 | 实现的必要条件与说明 |
|---|---|---|
| **异步结构化提问并继续独立工作**：63–65，request_user_input_async | 无同等模型工具或通用问题域；现有审批 reverse request 只处理授权等特定交互。[approval-reverse-request](../../src/runtime/session-runtime/approval-reverse-request.ts)、[run-timing](../../src/runtime/session-runtime/run-timing.ts) | P1：定义问题/答案 ID、选项与文本上限、pending/answered/cancelled 状态；Owner 持有问题状态，TUI 提交答案，回接 steering；处理断连、driver 变化、重复回答、超时与取消。答案和权限审批必须分开；需要答案的依赖操作不可提前执行。 |
| **自动压缩后继续原任务**：71–73 | 已有上下文选择、预算、checkpoint 与 compaction 核心模块；标准路径没有完整 summarizer → compaction commit → 恢复工作状态闭环。[model-request-adapter](../../src/runtime/context/model-request-adapter.ts)、[Compaction/Memory 专题](../plan-compact-memory/01-implementation-plan.md) | P1：保留目标、约束、决策、未完工作、文件变化及证据引用的摘要合同；真实 summarizer、触发阈值、工具调用依赖完整性、事务提交和 replay/takeover 恢复。需要验证压缩前后任务语义，不能只测试截短历史。 |
| **更完整的目录指令发现与作用域执行**：项目/Skill 来源规则 | 本次加入来源标签与模型行为指引，自动读取仍仅 user AGENTS 与 cwd/AGENTS.md。[standard-system-prompt](../../src/runtime/session-runtime/standard-system-prompt.ts) | P1：确定项目边界、父级/嵌套优先级、路径与 symlink 规范化、重复去重、失效机制和预算；通过 workspace adapter 处理平台差异。需要实际按编辑目标选择来源，prompt 标签本身不能强制作用域。 |
| **统一区分过程更新和最终回答**：63、75–102 | 流式文字和事件已有；部分 Responses adapter 保留 phase，但不是所有 provider 都有同等语义。[openai-responses-shared](../../src/api/openai-responses-shared.ts)、[timeline](../../src/tui/timeline/event-projector.ts) | P2：定义 provider 中立消息阶段 DTO、事件/replay 和 TUI 投影；明确无 phase provider 的降级，不能仅按出现工具调用推断 final。固定间隔更新还需要调度器控制权，提示词不能在阻塞调用中凭空发言。 |
| **JS 编排单元、批量并行工具与 yield/wait**：114–118、functions.exec/functions.wait | 核心 `executeToolCalls` 有 parallel 分支，但生产 controller 固定 sequential；没有 Codex 等价的模型可执行 JS 单元。[tool-call-preparation](../../src/runtime/agent-loop/tool-call-preparation.ts)、[controller](../../src/runtime/interactive-session-controller.ts) | P2：先定义有界只读批次、每工具并发安全声明、最大并发、取消、结果顺序和逐工具 attempt/receipt。完整任意 JS 执行还需独立代码执行安全设计，不属于本次范围；不能给现有接口虚构 Promise.allSettled。 |
| **多 Agent 并行、邮箱、跟进和共享可写目录**：212–246、collaboration 工具 | 已有 gated spawn 与 bounded readonly child；每 root 最多一个 active child，无 Codex 等价完整并行协作面。[agents](../../src/runtime/agents/domain.ts)、[supervisor](../../src/runtime/agents/supervisor.ts) | 当前非目标：必须另行明确修改 Runtime 08 的产品边界，再设计 Agent 身份、邮箱顺序、状态机、独立预算、取消、故障恢复。可写 workspace 还需要变更归属和冲突整合，不能随提示词升级开启。 |
| **可中断的通用等待与异步恢复**：clock.sleep、functions.wait | managed process_wait 支持正超时与进程结果；steering/interrupt 已有，但没有任意 JS cell/timer 在新消息到达时统一唤醒的协议。[process-wait](../../src/runtime/tools/process-wait.ts)、[controller](../../src/runtime/interactive-session-controller.ts) | P2：Owner 的等待注册表、wake reason、取消 token、消息/完成竞态、失效句柄、重连恢复和等待计时；区分进程仍运行与单次 waiter 已结束。先改善已有 process/question 等待，不新增未经治理的常驻执行器。 |
| **目标预算与跨轮自动推进**：create_goal/get_goal/update_goal | 存在单次 Agent run 预算、Plan goal ID 与 TUI Goal DTO，但没有这组模型工具及持久目标调度闭环。[run-timing](../../src/runtime/session-runtime/run-timing.ts)、[Goal DTO](../../src/tui/task-goal/types.ts) | P2：durable goal 状态、预算累计、用户明确启动/停止、续跑唤醒条件、重复阻塞判定和重启恢复；严格防止自动续跑循环及重复副作用。Plan artifact、run budget 不能当作 persistent goal 已完成接线。 |
| **外部 Apps/账号连接和可发现服务工具**：154–172 | 通用 MCP catalog/search/call 与插件信任已有；没有 Codex Apps 的 app:// 入口、账号连接 UX 和同等 tool_search 服务目录。[extension-composition](../../src/runtime/session-runtime/extension-composition.ts) | P2：账号身份/凭据归属、OAuth scope、连接/撤销 UI、服务工具发现、网络授权、审计和显式外发消息授权。可基于 MCP 扩展，但已有 MCP 工具不代表已连接用户账号。 |
| **会话内交互可视化工件**：104–112 | TUI、文件输出和已有 artifact store 不提供同等浏览器交互渲染面。[TUI](../tui/00-overview.md) | P3：工件类型/资源引用、渲染协议、可访问 URL 或客户端视图、交互事件和持久化。若执行 HTML/JS，还需要独立安全设计；TUI 中输出 Markdown 或文件不等于交互工件已实现。 |
| **模型主动调用图片生成/编辑并展示结果**：image_gen.imagegen | image catalog、Images API/注册表和图片输入能力已有；标准工具表没有同等受治理 imagegen 工具。[image registry](../../src/images-api-registry.ts)、[image provider](../../src/providers/images/register-builtins.ts)、[工具表](../../src/runtime/tools/index.ts) | P3：明确模型选择与费用授权、受治理网络调用、输入图片引用、大小/类型上限、输出工件保存、取消和 UI 展示。先复用现有 Images API，不把底层 API 存在误报为 Agent 工具可用。 |
| **统一读取 filesystem / environment / orchestrator Skill 来源**：130–152 | filesystem Skill 扫描、trust/digest 校验和 Skill 加载已有；没有 Codex orchestrator 的 skills.list/read 协议等价物。[Skill resolver](../../src/extensions/skills/skill-tool.ts) | P3：按来源类型定义 loader/locator 与相对引用解析，统一 trust receipt、失效和 bounded read；只有实际配置的来源才暴露能力。不要求复制 Codex 专用命名。 |

已经具备、无需另建同名能力的部分：受治理读写和 shell/process、有效权限与审批、steering/follow-up/interrupt、Skill/MCP 基础发现、plan 模式、原始请求导出。与 Codex 的 UI/工具名称不同不自动构成缺口。外部原生剪贴板接收、真实模型遵循率和人机交互验收也不由 prompt 文本保证。

建议后续顺序：先做异步提问、压缩延续和目录指令作用域，再评估统一消息阶段、并发读取、目标调度和账号连接。多 Agent 可写并行与执行 HTML/JS 的能力需要各自独立范围授权。

## 6. 验收记录

- `npm run check`、全量 `npm test`、`npm run build` 均退出 0。check 完整输出保存在 `/tmp/runledger-standard-prompt-final-check.log`，全量测试及构建同前缀，退出码在 `/tmp/runledger-standard-prompt-validation.json`。补充文档的链接与 current-format 检查通过。
- 定向验证覆盖固定基座与 descriptor 摘要、旧 standard@1 字节、AGENTS 来源和正文边界、拒绝去掉固定基座的 override、默认模式新建、非法 exact ref、schema 5 → 6、active owner 拒绝、两代 profile 的 fork、迁移命令缺确认和普通启动不自动升级；另含旧 receipt/recovery 与 schema compatibility 回归。
- 构建后真实 PATH：`~/.npm-global/bin/runledger` 解析到本仓 `bin/runledger.js`，全局 npm link 已核对。独立 HOME/RUNLEDGER_DIR/XDG/workspace 与 tmux、本地 HTTP fixture 验证新建 Session 为 standard@2/schema 6，实际 system 包含固定执行规则、带来源的 AGENTS 和有效权限。请求 388,009 B、system 358,784 B；CLI stdout、TUI 文件、OSC 52 解码内容与捕获请求逐字节相等。TUI 无正文面板，正常 Ctrl+D 退出 0，独占 tmux 与本地 listener 已关闭。
- 新版请求证据：`/tmp/runledger-standard-prompt-smoke-x_ebrp0x/result.json`、`terminal.raw`、HTTP body 与 CLI/TUI 输出；驱动脚本 `/tmp/runledger-standard-prompt-smoke.py`。
- 构建后旧库验证：隔离 schema 5 的 standard@1 fixture 在未确认迁移和普通启动时保持 schema 5；显式迁移后为 schema 6，profile 仍为 standard@1。恢复后的 base 正文 225 B 与旧拼接规则逐字节相同，最终 active owner 为 0。该空 fixture 因没有用户消息按既有规则被回收；没有迁移或清理真实用户数据。证据 `/tmp/runledger-standard-legacy-smoke-j1azk03e/result.json`、`legacy-base.txt`，脚本 `/tmp/runledger-standard-legacy-smoke.py`。
- 临时证据可能被系统清理。自动化 fixture 只证明装配、权限/版本边界和数据一致性；未执行真实外部模型调用，不宣称模型行为遵循率已经提升，人工交互与跨平台门禁也未关闭。
