# RunLedger 开发计划索引

本目录按开发模块保存 RunLedger 的设计、实施计划与现状说明。原 `.zcode/plans/` 中以 session ID 命名的六份计划已归档到对应模块,并改为可直接识别主题的文件名。

## 文档使用约定

- `*-plan.md` 是历史实施计划,用于说明当时的目标、决策、依赖、实施顺序与验收边界,不作为当前完成状态的唯一事实源。
- Runtime contract 例外:`runtime/04-governed-agent-harness-runtime-plan.md` 是通用协议、数据结构、schema、event payload、adapter port、被动保存信息与用户级 `~/.runledger` 保存位置的当前权威入口;它不承担 Runtime 行为实现或旧数据迁移状态。`runtime/00-reference.md` 只作为设计输入,`01`–`03` 保留为历史计划。
- 开发约束与显式非目标查根 `AGENTS.md`；当前实现与验收查下方各专题唯一入口，测试数量只引用注明日期的 fresh 运行记录。
- 已有专题文档继续作为模块的现状说明或详细设计;计划与现状不混写。
- 后续新增计划应直接放入对应模块目录,使用语义化文件名,不再使用 session ID 作为文档名。

## 模块导航

当前会话权限即时生效修复（2026-09-09）：见 [权限专题 §0](worktree-sandbox-permisson/07-three-permission-presets-and-tui-settings-plan.md)。`/permissions` 已接入当前 Owner 的显式 apply，在同一对话更新后续执行及待审批请求；查询区分有效状态与保存默认值。验证状态以专题交付记录为准。

跨领域执行编排见 [`plan/README.md`](plan/README.md)。

本地交互测试方法：[`Python + tmux 模式入口测试`](../tests/manual/native-mode/README.md)。
真实开发任务试跑：[`六类开发案例与证据`](../tests/manual/development-cases/README.md)。

| 开发模块 | 计划与设计文档 | 关注范围 | 当前事实入口 |
|---|---|---|---|
| 项目运行数据 Web 展示 | [Plan 15](plan/15-project-runtime-web-observability-plan.md) | collab-web 参考、本地只读看板、项目/Session 历史与实时、轨迹和用量 | in progress；只读 Web 已接线，浏览器侧已拆为 workspace 包 `packages/collab-web`，真实 CLI/浏览器与规模证据见 §9；W07 全仓门禁受阻 |
| Agent Harness 既有执行闭环加固 | [`Plan 14`](plan/14-agent-harness-reliability-hardening-plan.md) | 失败响应执行边界、工具输出、上下文选择、重复失败与中断恢复回归；不新增产品功能 | H1–H5 已实现；完整 check/test/build、确定性 HTTP/Owner 与 Built CLI/TTY 已通过；六例结果与人工/平台验收缺口见本文 |
| Prompt / standard 行为基座 | [`prompt/README.md`](prompt/README.md) | standard@2 固定执行规则、AGENTS 来源标记、显式 schema 迁移与 Codex 行为缺口 | [`实现与缺口说明`](prompt/01-standard-execution-and-behavior-gaps.md)；行为遵循率与基础设施能力分开验收 |
| Codex 提示词模板 | [`notez/README.md`](notez/README.md) | 创建任务、执行、debug、重构、文档和协作提示词 | 可复制模板，不作为项目实现状态或自动执行指令 |
| 项目运行与结构审计 | [`audit/README.md`](audit/README.md)、[`2026-09-05 审计与修复记录`](audit/2026-09-05-runtime-and-structure.md)、[`CLI/TUI 命令与提问实测`](audit/2026-09-05-cli-tui-command-audit.md) | 运行缺陷修复、过度防御清理、依赖边界及 check/build/test/真实 CLI 复验 | 原始审计、命令修复与重新实测证据分开；剩余领域能力、拆包及外部/人工/平台验收见清单，不替代领域计划 |
| Runtime Contract | [`runtime/04-governed-agent-harness-runtime-plan.md`](runtime/04-governed-agent-harness-runtime-plan.md) | 当前权威 contract:公共类型/schema、event payload、adapter port、ref/receipt/snapshot/projection、逻辑保存分类与 `RUNLEDGER_DIR`/默认 `~/.runledger` 单一用户级布局 | contract work package 证据;行为和迁移状态查对应专项、当前代码/tests 与 `AGENTS.md` |
| Runtime | [`runtime/00-reference.md`](runtime/00-reference.md) | 可治理 Agent Harness Runtime 的设计输入与问题域 | `runtime/04-governed-agent-harness-runtime-plan.md` |
| Runtime | [`runtime/01-minimum-runtime-scaffold-plan.md`](runtime/01-minimum-runtime-scaffold-plan.md) | 最小 Agent Runtime、事件流、ledger、mock stream、echo tool | `runtime/06-session-owner-runtime-replacement-plan.md` 与当前代码/测试 |
| Runtime | [`runtime/02-agent-loop-resurrection-plan.md`](runtime/02-agent-loop-resurrection-plan.md) | agent-loop、Agent、ledger、真实 LLM 完整循环 | `runtime/06-session-owner-runtime-replacement-plan.md` 与当前代码/测试 |
| Runtime | [`runtime/03-tool-system-plan.md`](runtime/03-tool-system-plan.md) | ToolRegistry、ExecutionEnv、stdlib 工具、stream 桥接 | `runtime/06-session-owner-runtime-replacement-plan.md` 与当前代码/测试 |
| Bounded Multi-Agent Runtime | [`runtime/08-bounded-multi-agent-system-plan.md`](runtime/08-bounded-multi-agent-system-plan.md) | 默认关闭、root-owned sequential、depth=1、生产治理只读工具、durable graph/replay/recovery；不包含 DAG/并行/写入/MCP/外部 provider/cost/merge/child continuation | 当前 M0–M5 与 Task 9 evidence 查本文档及当前代码/tests；最终门禁状态以计划文档为准 |
| Minimal Harness Profile | [`runtime/09-minimal-harness-profile-implementation-plan.md`](runtime/09-minimal-harness-profile-implementation-plan.md) | 会话级 immutable profile 历史合同；`minimal@1` 保留 `bash`/`edit`，新建 minimal@2 与 plan@1 见 Runtime 10，不改变 Permission/Sandbox authority | P0–P5 implemented，Linux automated/built-CLI acceptance complete；dark/light、80/143、真实键盘/中文 IME 与 macOS/Windows runner 保持 pending |
| Agent Mode 入口 | [`runtime/README.md`](runtime/README.md)、[`runtime/10-agent-mode-entry-implementation-plan.md`](runtime/10-agent-mode-entry-implementation-plan.md) | `/mode`、CLI/config/Footer 与 profile 兼容；minimal@2/plan@1 | `implemented`；M0–M6 与 Linux 自动化/built CLI/TUI 完成，外部 provider、人工及跨平台门禁见 Runtime 10 |
| Session Owner Runtime / Terminal（当前生产入口） | [`runtime/06-session-owner-runtime-replacement-plan.md`](runtime/06-session-owner-runtime-replacement-plan.md) | session-scoped embedded runtime、SQLite ownership/durable state 与 localhost TCP；标准 CLI 已切换，R0–R6 implemented | 实现及 R6.5/R8/R9 验收状态只查 Runtime 06；不得把 automated PASS 视为 human acceptance |
| Runtime Host / Terminal（legacy 安全窗口） | [`runtime/05-multi-client-background-terminal-refactor-plan.md`](runtime/05-multi-client-background-terminal-refactor-plan.md) | 仅保留旧 Host 实现及历史证据，标准 CLI 不可达 | 不再是 production authority；删除须满足 Runtime 06 的 R8/R9 门禁 |
| Plan / Context / Compaction / Memory | [`plan-compact-memory/01-implementation-plan.md`](plan-compact-memory/01-implementation-plan.md) | Model Router、Plan Mode、ContextEngine、Compaction、Memory 行为；Memory 当前为 core partial / Session Owner production unavailable，按 M0–M8 交付 | Memory 状态与实施顺序以主计划 §0.2、Phase 8 为准；生产 authority 为 `runtime/06`，`runtime/05` 仅作 legacy 输入 |
| Plan Mode 完整度对齐 | [`plan-compact-memory/02-plan-mode-parity-implementation-plan.md`](plan-compact-memory/02-plan-mode-parity-implementation-plan.md) | 以 oh-my-pi `3b3a6dc9bb` 完成度为口径的 Plan Mode 行为交付：会话内进入/退出、mode 片段注入、模型侧进入与请求审批、审批决策集与三路实施交接、产物导出与 plan.list | P0–P6 已实现（证据与偏差见 02 §5.9）；P7 端到端与全量门禁已执行，人工/真实 provider/跨平台 pending；状态入口以 02 为唯一来源（01 §0.7） |
| `/loop` 与 Goal Mode 适配 | [`plan/17-omp-loop-goal-mode-adaptation-plan.md`](plan/17-omp-loop-goal-mode-adaptation-plan.md) | goal canonical state、预算、模型工具、Owner 续跑、loop 条件与迭代、TUI；继承 02 的 D1–D5 范式 | `in progress`；主体已提交（`12d0552`），§14 R1–R4 已补入工作树并有本地 CLI/TTY 证据；完整测试及条件清理等 R5 门禁未关闭 |
| 多策略 Compact 适配器 | [接口与 C0–C5 实施方案](plan-compact-memory/01-implementation-plan.md#compact-strategy-adapter) | 策略 registry、single-pass / hierarchical、Owner 提交与恢复、provider 原生扩展边界 | 2026-09-15 已接 Session Owner 的 manual/auto/overflow、fork 回退与 Responses native；实现与本地验收见主计划 §0.5，真实 OpenAI provider 待验收 |
| Compact × oh-my-pi 压缩服务接入 | [`compact/README.md`](compact/README.md)、[`00 omp 服务事实`](compact/00-oh-my-pi-compaction-services.md)、[`01 接入计划`](compact/01-integration-plan.md) | omp 压缩机制接入现有 compact 适配器的增量方案：token 预算切点、摘要格式 seam 与迭代 update、文件清单、投影剪枝、handoff、provider 原生流式压缩 与 length-stop 恢复 | 2026-09-15 O0 合同冻结、O1–O5 本地验收完成；真实 OpenAI provider 待验收、O6 deferred、O7 blocked，公共契约与 C 阶段状态仍查 `plan-compact-memory/01` |
| Plugin / MCP / Skill / Hooks | [`plugin-mcp-skill-hooks/01-implementation-plan.md`](plugin-mcp-skill-hooks/01-implementation-plan.md)、[`plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md`](plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md) | 扩展 discovery/trust/snapshot、Skill、Hook、MCP、Plugin；目标为 SessionRuntime-owned lifecycle 与 managed process 接线 | 本专项里程碑证据、当前代码/tests、`runtime/04`、目标 `runtime/06` 与现行基线 `runtime/05` |
| Extensions 运行时 / Plugin 分发与 Marketplace | [`plugin-mcp-skill-hooks/03-extensions-runtime-and-plugin-marketplace-replication-plan.md`](plugin-mcp-skill-hooks/03-extensions-runtime-and-plugin-marketplace-replication-plan.md) | oh-my-pi `3b3a6dc9bb` 的可执行扩展运行时(ExtensionAPI/事件桥/工具准入)与插件安装、scope、Claude 兼容 marketplace 的复刻设计与阶段 | **P0–P7 done(附未关闭的 TUI TTY 证据缺口)**：分发型运行时(host 装配、工具准入、事件桥、动作命令面)、分发/marketplace/doctor/settings 键空间、CLI 词表与真实闭环、`plugin features` 三态选择、TUI 信任确认边界与 `pendingUpdates` 通知落点、失败与预算矩阵、真实 TTY 九步闭环、可选文件 watcher、descriptor 命名修正均已交付；`marketplace.autoUpdate`(user 层 settings 键 + CLI 四模式)与 TUI 的 `/plugins install|upgrade|config` 入口及统一确认边界亦已交付；未关闭的是证据类别缺口与后续专项：TUI 的 TTY/human 按键证据、TUI 的 marketplace add/remove 入口；阶段证据见该文 §15，总状态仍归 `01` |
| Worktree / Sandbox / Permission | [`worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)、[`01-multiplatform-workspace-path-adaptation-plan.md`](worktree-sandbox-permisson/01-multiplatform-workspace-path-adaptation-plan.md)、[`07-three-permission-presets-and-tui-settings-plan.md`](worktree-sandbox-permisson/07-three-permission-presets-and-tui-settings-plan.md) | Workspace/Worktree、Permission/Approval、ExecutionGateway；OS sandbox 扩展已冻结；三种权限预设与 TUI 设置从 `07` 分阶段推进 | `00` 总入口、`01` 当前适配状态、`07` 预设/TUI 状态、当前代码/tests、`runtime/04`、目标 `runtime/06` 与现行基线 `runtime/05` |
| 运行轨迹 / Trajectory | [`trajectory/README.md`](trajectory/README.md)、[实施计划](trajectory/01-runtime-trajectory-implementation-plan.md) | 默认本地记录、配置关闭、Run/Step/Call 查询与 `/trajectory` 面板 | 本地实现已接线；[验证与缺口](trajectory/02-implementation-verification.md)单列自动化/TTY/平台证据 |
| Runtime Trace / Opik | [`runtime/trace/README.md`](runtime/trace/README.md) | Event Store、Artifact Store、模型/工具/上下文/耗时/Token/费用记录、Opik 投影与父子树 | `runtime/trace/00-opik-agent-observability-plan.md`、当前代码/tests |
| Session Audit Note | [`note/README.md`](note/README.md) | 历史 `/audit` 阅读计划；已由 Trajectory 专项接替 | [`note/00-session-audit-reading-mode-plan.md`](note/00-session-audit-reading-mode-plan.md)、Runtime Trace 当前代码/tests |
| Test Strategy / Runner | [`test/README.md`](test/README.md)、[`test/01-test-strategy-and-runner-hardening-plan.md`](test/01-test-strategy-and-runner-hardening-plan.md) | 测试 inventory、唯一 runner 归属、资源分桶、PR CI、构建/CLI/PTY smoke、确定性、跨平台与人工/live 证据边界 | 当前 runner/config/tests；异步方法见 [`test/async-state-machine.md`](test/async-state-machine.md) |
| 评测中台 / Bench | [`bench/README.md`](bench/README.md)、[`bench/01-bench-platform-implementation-plan.md`](bench/01-bench-platform-implementation-plan.md) | agent 任务级评测：任务包、驱动层（TTY/headless）、只读采集、宿主侧独立验收、bench ledger、hermetic/live 两条证据通道；不新增常驻服务、不做 sandbox/容器隔离 | 阶段状态与证据查 `bench/01`；数据与判定契约查 [`bench/02`](bench/02-task-pack-and-scoring-contract.md)；参考输入查 [`bench/00`](bench/00-oh-my-pi-metaharness-reference.md) |
| Provider | [`providers/01-pi-ai-migration-plan.md`](providers/01-pi-ai-migration-plan.md)、[`providers/02-oh-my-pi-provider-port-execution-checklist.md`](providers/02-oh-my-pi-provider-port-execution-checklist.md) | 历史 pi-ai 全量移植；oh-my-pi 18.1.9 增量：4 个新 provider、55 份已有 catalog 更新；特殊协议、动态 catalog、认证和生产验收边界 | 早期移植设计查 `providers/01`；当前增量实现与验收状态查 `providers/02` |
| Storage / CLI | [`专题入口与数据库结构图`](storage-cli/README.md)、[`storage-cli/02-user-home-migration-handoff.md`](storage-cli/02-user-home-migration-handoff.md)、[`storage-cli/01-project-layout-cli-plan.md`](storage-cli/01-project-layout-cli-plan.md) | 用户级单一 home 破坏性迁移 handoff（S0–S5 已完成）;旧项目级 `.runledger/`、settings、session 与 CLI 计划仅作为 superseded 迁移输入 | 迁移状态与最终证据查 `02`;旧布局历史见 [`project-cli-layout.md`](project-cli-layout.md) |
| 界面框架术语 | [`frame/README.md`](frame/README.md) | TUI、工具展示、输入/参数区域、Composer 上方统一二级选择界面、审批与安全配置的名称和层级 | [`frame/00-tui-and-security-terminology.md`](frame/00-tui-and-security-terminology.md)、当前代码 |
| TUI | [`tui/00-overview.md`](tui/00-overview.md) | TUI 总体设计与 `01`–`09` 专题导航 | `tui/19-passive-contract-integration-plan.md` 与当前 CLI/TUI 代码/测试 |
| TUI | [`tui/10-documentation-update-plan.md`](tui/10-documentation-update-plan.md) | 跨项目 lessons 与远程控制路线文档更新记录 | [`tui/08-cross-project-lessons.md`](tui/08-cross-project-lessons.md)、[`tui/09-remote-control-roadmap.md`](tui/09-remote-control-roadmap.md) |
| TUI / OpenTUI | [`tui/17-opentui-refactor-plan.md`](tui/17-opentui-refactor-plan.md) | pi-tui → OpenTUI imperative core 实现、PTY/native frame 与全仓门禁证据 | [`tui/reference/00-opentui-component-index.md`](tui/reference/00-opentui-component-index.md) |
| TUI / Passive Data Contract | [`tui/17-passive-data-contract-placeholder-plan.md`](tui/17-passive-data-contract-placeholder-plan.md) | framework-neutral 被动数据合同、Timeline/safe presentation、workflow envelope 与 current canonical session format only 边界；不接 renderer/IO/生产行为 | Passive Plan 17 §12、当前 TUI/runtime authority 与 focused contract evidence |
| TUI / OpenTUI Performance | [`tui/18-opentui-streaming-performance-ux-plan.md`](tui/18-opentui-streaming-performance-ux-plan.md) | 迁移后的增量 timeline、流式合并、长会话窗口化、背压与响应式交互体验 | `17-opentui-refactor-plan.md` P8 证据、当前代码/tests 与本文 before/after artifact |
| TUI / Passive Contract Integration | [`tui/19-passive-contract-integration-plan.md`](tui/19-passive-contract-integration-plan.md) | 将已提前建立的 TUI application/Timeline/presentation/workflow 数据结构分批接入 reducer、projector、EffectRunner、typed adapter 与标准 `runledger` | Passive Plan 17 的 P0–P6 合同证据、当前生产 TUI/Host authority、本文 B0–B8 状态表 |
| TUI / Slash Command Adaptation | [`tui/20-codex-slash-command-adaptation-plan.md`](tui/20-codex-slash-command-adaptation-plan.md) | `/` 命令 registry、输入期 popup、别名/参数补全、统一派发、门控与 SelectionView | 当前 HEAD、未提交工作树、聚焦/全量测试、build 与标准 PATH PTY 证据分开核对 |
| TUI / Mermaid Rendering | [`tui/21-mermaid-diagram-rendering-implementation-plan.md`](tui/21-mermaid-diagram-rendering-implementation-plan.md)、[`tui/21-mermaid-diagram-rendering-license-manifest.md`](tui/21-mermaid-diagram-rendering-license-manifest.md) | 受限 Mermaid Unicode inline projection、OpenTUI 接缝、完整源码 fallback、缓存/预算与 R1/R2 安全边界 | M0–M7 自动门禁与标准 PATH smoke 已完成；人工视觉验收、license formal review 与 R2 仍未完成，状态查 Plan 21 |
| TUI / Conversation Scrollbar | [`tui/22-opencode-conversation-scrollbar-adaptation-plan.md`](tui/22-opencode-conversation-scrollbar-adaptation-plan.md) | 默认隐藏、`/scrollbar`、canonical-home preference、右侧留白与主题化内建 bar 的独立工作树候选已实现；单一 OpenTUI ScrollBox 继续持有位置、sticky 与拖拽 | Plan 22 §0.1/§5.0：agent gates 与隔离候选 bin PTY 已通过；标准全局链接、真实鼠标/视觉 human verification pending |
| TUI / Codex Syntax Highlighting | [`tui/23-codex-syntax-highlighting-replication-plan.md`](tui/23-codex-syntax-highlighting-replication-plan.md)、[`tui/23-codex-syntax-highlighting-license-manifest.md`](tui/23-codex-syntax-highlighting-license-manifest.md) | Codex 风格代码块语法高亮复制、主题映射、语言识别、流式与长会话性能边界 | Plan 23 状态表、focused/full gates、标准 PATH TTY 与 license manifest |
| TUI / Codex Session Display | [`tui/24-codex-session-display-replication-plan.md`](tui/24-codex-session-display-replication-plan.md) | Codex 风格 session header、消息分组、工具调用与状态展示复制 | Plan 24 §S7 fresh gates、标准 PATH 隔离 TTY 与 session fixture 验收 |
| TUI / Working Loader Shimmer | [`tui/25-pi-working-loader-shimmer-replication-plan.md`](tui/25-pi-working-loader-shimmer-replication-plan.md) | oh-my-pi working loader 渐变（classic/KITT shimmer）、esc bracket 字形与 `display.shimmer` 设置已实现 | Plan 25 S0–S4 accepted；full gates、标准 PATH 隔离 TTY 80/143 列三模式与零宽不变式测试 |
| TUI / Codex Exploration Output | [`tui/26-codex-exploration-output-summary-plan.md`](tui/26-codex-exploration-output-summary-plan.md) | `read/grep/find/glob/ls` 主时间线摘要、相邻 Exploring 分组、Ctrl+T bounded 详情及双层截断元数据 | `partial`：核心实现、check/test/build 和隔离 PATH TTY smoke 已完成；S6 专项性能/重放、真实探索调用及 dark/light/复制人工验收仍 pending |
| TUI / 可配置主体色槽 | [`tui/27-configurable-ui-theme-and-thinking-color-plan.md`](tui/27-configurable-ui-theme-and-thinking-color-plan.md) | 用户级 `uiTheme`、三套 dark/light 预设、色槽覆盖与思考灰色、统一渲染接线 | `implemented`：配置与渲染已接通；Linux 自动化及真实 TTY 证据见 Plan 27 §8，人工与跨平台 pending |
| TUI / System Prompt Dump | [`tui/28-system-prompt-dump-plan.md`](tui/28-system-prompt-dump-plan.md) | `/dump [request\|system\|assembled\|base]`、provider 输入观测、`session.request.inspect` 固定快照分页、原文文件/剪贴板与 headless 导出 | 当前原始请求导出合同与 fresh 验证见 Plan 28 当前合同/§9；旧 P0–P6 证据见 §8 |
| TUI / Session Runtime Integration Repair | [`plan/01-tui-session-runtime-integration-repair-plan.md`](plan/01-tui-session-runtime-integration-repair-plan.md) | 编排 TUI、Session Owner、CLI、Process/PTY、Approval、Worktree、Trace 与扩展的真实接线、等价清理和 R8/R9 门禁 | 状态分别回写 `runtime/06`、`tui/19` 及 Plugin/MCP、Worktree/Security、Trace 权威文档 |
| Cross-cutting Modularization | [`plan/12-bloated-code-modularization-refactor-plan.md`](plan/12-bloated-code-modularization-refactor-plan.md) | SessionStore、Security、Process、AgentLoop、SessionRuntime、OpenTUI、InteractiveMode、provider adapters 与 model generator 的行为保持拆分 | S0–S5/S8/S9 implemented；S6/S7 automated PATH 候选已通过但 streaming/human 门禁未闭合；S10 受 Runtime 06 R9 阻塞，整体 `partial / blocked` |
| Package Boundary / Workspace Refactor | [`plan/13-package-boundary-workspace-refactor-plan.md`](plan/13-package-boundary-workspace-refactor-plan.md) | 从单一 npm 包迁移到 contracts、AI、core、product-TUI 与 runledger app 的单向 workspace；先消除跨域环，再物理拆包 | `planned / staged`；P0–P4 可执行，legacy Host 最终收口 P5 受 Runtime 06 R8/R9 阻塞 |
| Session Execution Reliability | [`plan/03-session-execution-reliability-repair-plan.md`](plan/03-session-execution-reliability-repair-plan.md) | 事故驱动的 governed toolchain、人工等待计时、run budget、lifecycle projection、process Trace 与 durable streaming 修复 | P0、P2–P6 implemented；P1 off-plan implemented、restrictive sandbox blocked；P7/R8/human acceptance pending |
| LSP Server Adapter | [`plan/04-lsp-server-adaptation-plan.md`](plan/04-lsp-server-adaptation-plan.md) | defaults/config 自动探测、stdio JSON-RPC、LspClient、AgentTool、WorkspaceEdit、managed LinterClient 与 SessionRuntime governed 接线 | P0–P6 review 修复已通过 fresh check/test/build 与隔离 CLI/TTY；P7 修复后 Session-managed 真实语言服务器/TUI smoke pending，状态查本文 §状态表 |
| Streaming Write 展示稳定性 | [`plan/05-streaming-prefix-stability-plan.md`](plan/05-streaming-prefix-stability-plan.md) | oh-my-pi 稳定前缀能力族移植：part 级 settled 契约、冻结前缀判定与字节稳定契约门、settled 行缓存、流式表格列宽锁定、流式 diff 行级高亮；不改 renderer/screen mode/OpenTUI 内部 | 本文 §现状核实与 §状态表；P2 `partial`、P3–P5 `implemented`、P6 `partial / blocked`；压力证据见 [`plan/05-streaming-prefix-stability-evidence-2026-08-15.json`](plan/05-streaming-prefix-stability-evidence-2026-08-15.json)，全量 check/test 的既有 TUI boundary blocker 不伪装为本任务通过 |
| Session Naming / Auto Title | [`plan/06-session-naming-and-auto-title-plan.md`](plan/06-session-naming-and-auto-title-plan.md) | Session Owner 内的 durable display title、oh-my-pi 语义适配、`/rename`、首个合格输入异步命名；默认复用当前 coding session active `provider/model`，不使用独立 tiny/smol | 本文 §Current implementation state and fresh evidence、§Status table |
| Idle Recap | [`plan/07-idle-recap-replication-plan.md`](plan/07-idle-recap-replication-plan.md) | oh-my-pi 空闲 recap 的 ephemeral side-channel、当前模型复用、工具调用丢弃、owner/activity fencing、可配置 idle delay 与 fail-closed 接线 | 本文 §0 配置结论、§2 RunLedger 基线、§11 状态表 |
| Usage Status Line | [`plan/08-usage-status-line-replication-plan.md`](plan/08-usage-status-line-replication-plan.md) | 参考 oh-my-pi 在输入框下方展示累计 input/output/cache/cost、cache hit、output tok/s 与 context usage；复用 RunLedger 多行结构化 OpenTUI footer | 本文 §0 目标与结论、§3 冻结合同、§7 状态表 |
| Plugin / Tree-sitter Bash AST | [`plugin/01-tree-sitter-bash-ast-port-plan.md`](plugin/01-tree-sitter-bash-ast-port-plan.md) | Tree-sitter Bash AST 安全分类移植：WASM worker、allowlist walker、语义规则、fail-closed 授权与 rollout | B0–B4 `implemented`；B5 `planned`，Node/Bun、pack、PTY、审计与 human gate 仍按计划闭合 |
| 版本升级与发布设施 | [`release/README.md`](release/README.md)、[`release/01 实施计划`](release/01-release-and-upgrade-infrastructure-plan.md) | 版本真相与发布单元、清洁构建与打包边界、发布产物与完整性、安装形态识别、`runledger update` 委托升级、启动升级提示 | `planned`；现状实测基线与阻塞项见 [`release/00`](release/00-release-baseline.md)，阶段状态以 `release/01` §8 为唯一来源 |
| Web 检索与站点抓取（omp `web/` 移植） | [`plan/18 omp web 能力移植计划`](plan/18-omp-web-capability-port-plan.md) | 从 oh-my-pi `packages/coding-agent/src/web` 移植检索管线、19 个 provider、站点 handler、共享 API client 与 vendored DOM/turndown 到 `src/websource/`；新增 transport / 凭据 / settings 三条注入式 port 与 `NetworkRequest.principal` | `implemented`；落地结果、验证证据与未闭合缺口（Tier C、外部真实检索、PDF 全文、浏览器兜底）见该文 §11 |
| 工具面扩展与呈现层 | [`plan/19 omp 工具面扩展计划`](plan/19-omp-tool-surface-expansion-plan.md)、[`plan/20 omp 可实现工具移植`](plan/20-omp-implementable-tools-port-plan.md) | Plan 19 记录基准、archive/sqlite/ask 与呈现层门槛；Plan 20 依次落地命名 checkpoint/新会话 rewind、DOCX/PPTX/XLSX/EPUB `read`、受治理 `image_gen`、只读 `github` 与 canonical user `manage_skill` | `in progress`；Plan 20 的阶段状态、生产 authority、文件清单与验收门槛为当前实现入口；ast/PDF/browser/eval/Memory/yield-hub 仍不在范围 |
| computer use 复刻 | [`plan/21 omp computer use 能力复刻`](plan/21-omp-computer-use-port-plan.md) | 把 oh-my-pi 的 host desktop 控制（显示器/窗口发现、截图、native 指针与键盘输入、AX 树读写、剪贴板）复刻为 RunLedger 的受治理 registry 工具，而不是上游的 eval prelude；含 `host_desktop` capability、`desktop` AccessRequest kind、独立 Rust addon 与 Windows-first 后端顺序 | `not started`；阶段 A 合同/端口 → B Windows native → C 工具面 → D settings/CLI/TUI → E 提示词 → F 非 Windows。`eval`/`run-code` 内核、`browser`、PDF、provider 原生 computer tool 不在范围，且不触碰 `src/security/sandbox/` |
| 配置格式 YAML 与 settings 参数扩展 | [`plan/22 配置格式 YAML 支持与 settings 参数扩展`](plan/22-config-yaml-and-settings-parameter-plan.md) | 以 oh-my-pi `settings-schema.ts` 的 459 项为口径做参数映射判定（`MAPPED`/`EXPOSABLE`/`NEW-CAPABILITY`/`BLOCKED`/`OUT-OF-SCOPE`），并为 8 类 JSON 配置载体设计 YAML 双格式入口；不改任何 authority 与 fail-closed 语义 | `planned`；Y1 动手前需先关闭该文 §8 的 D1（解析器选型）–D3（扩展范围）裁定；§7 R1 的 `webSearch` 未接线为既有缺陷，建议先单独修复 |
| 上游模块对照（parity） | [`parity/README.md`](parity/README.md)、[`00 omp coding-agent 模块对照与缺口报告`](parity/00-oh-my-pi-coding-agent-module-gap-report.md)、[`01 omp monorepo 包与 crate 对照报告`](parity/01-oh-my-pi-monorepo-package-and-crate-gap-report.md)、[`02 omp 工具注册与呈现机制`](parity/02-oh-my-pi-tool-registration-and-presentation.md) | 以 oh-my-pi 指定快照为口径：00 覆盖 `packages/coding-agent/src` 的模块缺口，01 覆盖其余 15 个包、`crates/*` 与非 TS 树并区分「换实现 / 真缺失」，02 说明上游工具如何注册、发现与呈现（capability registry → `createTools` → `loadMode`/`xd://`） | 静态源码对照与机制说明；不代表运行时验收，也不改变任何领域 authority |

## 2026-08-04 当前实现批次

三个专项已在当前分支完成独占目录的可测试行为切片，已按领域形成可追溯本地提交；尚未完成 Host/CLI/TUI 串行生产接线，也未推送：

- Plan/Context/Compaction/Memory：2026-08-04 切片已覆盖 Context assembly、cut/checkpoint lifecycle、Memory 纯 proposal/approval/search/persistence 及 Plan Mode reducer/artifact store，定向 10 files / 39 tests，提交 `68dab74`；2026-09-04 复核确认标准 Session Owner 尚未装配 Memory，production operations 仍为 `operation_unavailable`，后续以主计划 M0–M8 为唯一交付链。
- Plugin/MCP/Skill/Hooks：extension foundation、Skill/Hook/MCP bounded behavior 与 Runtime resource/audit adapters；定向 6 files / 34 tests；提交 `b2bf04e`。
- Worktree/Sandbox/Permission：2026-08-04 切片曾交付 permission/config/worktree/sandbox 行为、ExecutionGateway、PolicyNetworkClient 和 final-leaf receipt adapter，定向 18 files / 88 tests，提交 `dde60ac`。自 2026-08-06 起 OS sandbox 跨平台扩展冻结；既有 Linux 证据只保留为回归，多平台 workspace/path 适配 P0 文档冻结已完成，P1 尚未授权。
- 全仓门禁：Vitest 144 files / 746 tests、Bun 5 files / 44 assertions、`npm run check`、`npm run build`、`git diff --check` 均通过。

下一阶段必须从各专项当前入口继续。Worktree/Sandbox/Permission 不得再从旧 Sandbox Phase 4 继续，而应按 `01-multiplatform-workspace-path-adaptation-plan.md` 从真实平台证据开始；OS sandbox 只有在 P0–P6 和新的解封 ADR 后才能重新规划。不能以本节的历史 focused tests 宣称当前专项或多平台能力完成。

### Plan 24 当前验收状态

Plan 24（Codex Session Display）当前状态为 `implemented/accepted`。2026-08-14 fresh evidence：`npm run check`、Vitest 342 files / 2015 passed / 3 skipped、Bun OpenTUI 89 passed / 443 assertions、`npm run build`，以及标准 PATH 隔离 `runledger` 的 80/143 列 dark/light 真实 TTY 和隔离 SQLite session fixture 验收；逐项记录见 [`tui/24-codex-session-display-replication-plan.md`](tui/24-codex-session-display-replication-plan.md) §S7。

### Plan 28 当前状态

Plan 28（`/dump` 请求快照与原始内容导出）当前合同及 2026-09-11 修复证据见 [`tui/28-system-prompt-dump-plan.md`](tui/28-system-prompt-dump-plan.md) 当前合同/§9；原 assembler 报告式导出的历史证据保留在 §8。该计划不改变 20/24/26/17/18/27 的任何 authority。

## 原始计划迁移映射

| 原 `.zcode/plans/` 文件 | 归档位置 |
|---|---|
| `plan-sess_24180b7c-5c31-4150-9064-a92df5c2e579.md` | `runtime/01-minimum-runtime-scaffold-plan.md` |
| `plan-sess_c0cdba49-8144-49e6-a02c-0a8a20ccf7ed.md` | `runtime/02-agent-loop-resurrection-plan.md` |
| `plan-sess_a0969a3b-1c6e-4abc-b39b-2b816e0477b3.md` | `runtime/03-tool-system-plan.md` |
| `plan-sess_e1ab868c-3d81-45c4-aeaa-2cf789ec1030.md` | `providers/01-pi-ai-migration-plan.md` |
| `plan-sess_43a5be3a-b430-4147-a81c-490636aafd5b.md` | `storage-cli/01-project-layout-cli-plan.md` |
| `plan-sess_ddb2fbdb-6d15-4a10-8ded-24719b8bde31.md` | `tui/10-documentation-update-plan.md` |

## 目录结构

```text
development-doc/
├── 00-index.md
├── project-cli-layout.md
├── plan/
│   ├── 01-tui-session-runtime-integration-repair-plan.md
│   ├── 02-codex-input-area-replica-plan.md
│   ├── 03-session-execution-reliability-repair-plan.md
│   ├── 04-lsp-server-adaptation-plan.md
│   ├── 05-streaming-prefix-stability-plan.md
│   ├── 06-session-naming-and-auto-title-plan.md
│   ├── 07-idle-recap-replication-plan.md
│   ├── 08-usage-status-line-replication-plan.md
│   ├── 09-outbound-network-proxy-plan.md
│   ├── 10-upstream-model-proxy-plan.md
│   ├── 11-forward-proxy-gateway-plan.md
│   ├── 12-bloated-code-modularization-refactor-plan.md
│   └── 13-package-boundary-workspace-refactor-plan.md
├── note/
│   ├── README.md
│   └── 00-session-audit-reading-mode-plan.md
├── frame/
│   ├── README.md
│   └── 00-tui-and-security-terminology.md
├── plugin/
│   └── 01-tree-sitter-bash-ast-port-plan.md
├── providers/
│   ├── 01-pi-ai-migration-plan.md
│   └── 02-oh-my-pi-provider-port-execution-checklist.md
├── plugin-mcp-skill-hooks/
│   ├── 01-implementation-plan.md
│   ├── 02-skill-registry-discovery-provider-refactor-plan.md
│   └── 03-extensions-runtime-and-plugin-marketplace-replication-plan.md
├── plan-compact-memory/
│   ├── 00-reference.md
│   └── 01-implementation-plan.md
├── compact/
│   ├── README.md
│   ├── 00-oh-my-pi-compaction-services.md
│   └── 01-integration-plan.md
├── runtime/
│   ├── 00-reference.md
│   ├── 01-minimum-runtime-scaffold-plan.md
│   ├── 02-agent-loop-resurrection-plan.md
│   ├── 03-tool-system-plan.md
│   ├── 04-governed-agent-harness-runtime-plan.md
│   ├── 05-multi-client-background-terminal-refactor-plan.md
│   ├── 06-session-owner-runtime-replacement-plan.md
│   └── trace/
│       ├── README.md
│       ├── 00-opik-agent-observability-plan.md
│       ├── phase-01-event-store-artifact-store.md
│       ├── phase-02-runtime-recorder.md
│       ├── phase-03-local-store-configuration.md
│       └── phase-04-opik-exporter-tree.md
├── worktree-sandbox-permisson/
│   ├── 00-worktree-sandbox-permission-plan.md
│   ├── 01-multiplatform-workspace-path-adaptation-plan.md
│   ├── 07-three-permission-presets-and-tui-settings-plan.md
│   └── archive/
│       └── 00-os-sandbox-cross-platform-expansion-archived.md
├── storage-cli/
│   ├── 01-project-layout-cli-plan.md
│   └── 02-user-home-migration-handoff.md
├── test/
│   ├── README.md
│   ├── 01-test-strategy-and-runner-hardening-plan.md
│   └── async-state-machine.md
├── bench/
│   ├── README.md
│   ├── 00-oh-my-pi-metaharness-reference.md
│   ├── 01-bench-platform-implementation-plan.md
│   └── 02-task-pack-and-scoring-contract.md
├── release/
│   ├── README.md
│   ├── 00-release-baseline.md
│   └── 01-release-and-upgrade-infrastructure-plan.md
├── parity/
│   ├── README.md
│   ├── 00-oh-my-pi-coding-agent-module-gap-report.md
│   ├── 01-oh-my-pi-monorepo-package-and-crate-gap-report.md
│   └── 02-oh-my-pi-tool-registration-and-presentation.md
└── tui/
    ├── 00-overview.md
    ├── 01-architecture.md
    ├── 02-component-spec.md
    ├── 03-event-binding.md
    ├── 04-rendering.md
    ├── 05-theme.md
    ├── 06-keybindings.md
    ├── 07-roadmap.md
    ├── 08-cross-project-lessons.md
    ├── 09-remote-control-roadmap.md
    ├── 10-documentation-update-plan.md
    ├── 17-opentui-refactor-plan.md
    ├── 17-passive-data-contract-placeholder-plan.md
    ├── 18-opentui-streaming-performance-ux-plan.md
    ├── 19-passive-contract-integration-plan.md
    ├── 20-codex-slash-command-adaptation-plan.md
    ├── 21-mermaid-diagram-rendering-implementation-plan.md
    ├── 21-mermaid-diagram-rendering-license-manifest.md
    ├── 22-opencode-conversation-scrollbar-adaptation-plan.md
    ├── 23-codex-syntax-highlighting-replication-plan.md
    ├── 23-codex-syntax-highlighting-license-manifest.md
    ├── 24-codex-session-display-replication-plan.md
    ├── 25-pi-working-loader-shimmer-replication-plan.md
    ├── 26-codex-exploration-output-summary-plan.md
    ├── 27-configurable-ui-theme-and-thinking-color-plan.md
    ├── 28-system-prompt-dump-plan.md
    └── reference/
        └── 00-opentui-component-index.md
```
