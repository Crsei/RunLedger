# RunLedger 开发计划索引

本目录按开发模块保存 RunLedger 的设计、实施计划与现状说明。原 `.zcode/plans/` 中以 session ID 命名的六份计划已归档到对应模块,并改为可直接识别主题的文件名。

## 文档使用约定

- `*-plan.md` 是历史实施计划,用于说明当时的目标、决策、依赖、实施顺序与验收边界,不作为当前完成状态的唯一事实源。
- Runtime contract 例外:`runtime/04-governed-agent-harness-runtime-plan.md` 是通用协议、数据结构、schema、event payload、adapter port、被动保存信息与用户级 `~/.runledger` 保存位置的当前权威入口;它不承担 Runtime 行为实现或旧数据迁移状态。`runtime/00-reference.md` 只作为设计输入,`01`–`03` 保留为历史计划。
- 当前代码能力、测试数量和显式非目标以仓库根目录 `AGENTS.md` 为准。
- 已有专题文档继续作为模块的现状说明或详细设计;计划与现状不混写。
- 后续新增计划应直接放入对应模块目录,使用语义化文件名,不再使用 session ID 作为文档名。

## 模块导航

| 开发模块 | 计划与设计文档 | 关注范围 | 当前事实入口 |
|---|---|---|---|
| Runtime Contract | [`runtime/04-governed-agent-harness-runtime-plan.md`](runtime/04-governed-agent-harness-runtime-plan.md) | 当前权威 contract:公共类型/schema、event payload、adapter port、ref/receipt/snapshot/projection、逻辑保存分类与 `RUNLEDGER_DIR`/默认 `~/.runledger` 单一用户级布局 | contract work package 证据;行为和迁移状态查对应专项、当前代码/tests 与 `AGENTS.md` |
| Runtime | [`runtime/00-reference.md`](runtime/00-reference.md) | 可治理 Agent Harness Runtime 的设计输入与问题域 | `runtime/04-governed-agent-harness-runtime-plan.md` |
| Runtime | [`runtime/01-minimum-runtime-scaffold-plan.md`](runtime/01-minimum-runtime-scaffold-plan.md) | 最小 Agent Runtime、事件流、ledger、mock stream、echo tool | `AGENTS.md` §1.2 |
| Runtime | [`runtime/02-agent-loop-resurrection-plan.md`](runtime/02-agent-loop-resurrection-plan.md) | agent-loop、Agent、ledger、真实 LLM 完整循环 | `AGENTS.md` §1.2、§5 |
| Runtime | [`runtime/03-tool-system-plan.md`](runtime/03-tool-system-plan.md) | ToolRegistry、ExecutionEnv、stdlib 工具、stream 桥接 | `AGENTS.md` §1.2、§5 |
| Bounded Multi-Agent Runtime | [`runtime/08-bounded-multi-agent-system-plan.md`](runtime/08-bounded-multi-agent-system-plan.md) | 默认关闭、root-owned sequential、depth=1、生产治理只读工具、durable graph/replay/recovery；不包含 DAG/并行/写入/MCP/外部 provider/cost/merge/child continuation | 当前 M0–M5 与 Task 9 evidence 查本文档及当前代码/tests；最终门禁状态以计划文档为准 |
| Session Owner Runtime / Terminal | [`runtime/06-session-owner-runtime-replacement-plan.md`](runtime/06-session-owner-runtime-replacement-plan.md) | 用 session-scoped embedded runtime、SQLite ownership/durable state 与 localhost TCP 替代 machine/workspace Host；offline migration、recovery barrier、attachment lifetime、connection-scoped driver 与 checkpoint cache 已冻结；R0–R2 已完成（R0 contract freeze：`session-owner/{types,schemas}.ts`、`session-server/protocol.ts`、`check:session-owner-boundaries`、[consumer/delete inventory](runtime/06-session-owner-inventory.md)；R1 SQLite foundation：`storage/session-store/` database/schema/schema-compatibility/platform-capability；R2 SessionStore API + JSONL 显式迁移：session-store/jsonl-migration + `migrate session-store`/`storage prune-legacy`） | 当前实现仍查 `runtime/05`、当前代码/tests；替代实施与完成状态查 `runtime/06` |
| Runtime Host / Terminal（current baseline） | [`runtime/05-multi-client-background-terminal-refactor-plan.md`](runtime/05-multi-client-background-terminal-refactor-plan.md) | 当前已实现的 resident Host、平台 IPC 与 Host lifecycle；只作为迁移输入，不再授权扩展 | 当前代码/tests；目标架构查 `runtime/06` |
| Plan / Context / Compaction / Memory | [`plan-compact-memory/01-implementation-plan.md`](plan-compact-memory/01-implementation-plan.md) | Model Router、Plan Mode、ContextEngine、Compaction、Memory 行为；生产接线消费 Runtime Contract 与 session command/query/subscription | 本专项阶段证据、当前代码/tests、`runtime/04`、目标 `runtime/06` 与现行基线 `runtime/05` |
| Plugin / MCP / Skill / Hooks | [`plugin-mcp-skill-hooks/01-implementation-plan.md`](plugin-mcp-skill-hooks/01-implementation-plan.md)、[`plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md`](plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md) | 扩展 discovery/trust/snapshot、Skill、Hook、MCP、Plugin；目标为 SessionRuntime-owned lifecycle 与 managed process 接线 | 本专项里程碑证据、当前代码/tests、`runtime/04`、目标 `runtime/06` 与现行基线 `runtime/05` |
| Worktree / Sandbox / Permission | [`worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md`](worktree-sandbox-permisson/00-worktree-sandbox-permission-plan.md)、[`01-multiplatform-workspace-path-adaptation-plan.md`](worktree-sandbox-permisson/01-multiplatform-workspace-path-adaptation-plan.md) | Workspace/Worktree、Permission/Approval、ExecutionGateway；OS sandbox 扩展已冻结，当前先解决多平台 path/Git/Shell/process/cleanup 适配 | `00` 总入口、`01` 当前适配状态、当前代码/tests、`runtime/04`、目标 `runtime/06` 与现行基线 `runtime/05` |
| Runtime Trace / Opik | [`runtime/trace/README.md`](runtime/trace/README.md) | Event Store、Artifact Store、模型/工具/上下文/耗时/Token/费用记录、Opik 投影与父子树 | `runtime/trace/00-opik-agent-observability-plan.md`、当前代码/tests |
| Session Audit Note | [`note/README.md`](note/README.md) | 当前打开 session 的 `/audit` 只读调用树、计量与 Artifact 阅读模式 | [`note/00-session-audit-reading-mode-plan.md`](note/00-session-audit-reading-mode-plan.md)、Runtime Trace 当前代码/tests |
| Provider | [`providers/01-pi-ai-migration-plan.md`](providers/01-pi-ai-migration-plan.md) | API、OAuth、provider、model catalog、凭据存储 | `AGENTS.md` §1.1 |
| Storage / CLI | [`storage-cli/02-user-home-migration-handoff.md`](storage-cli/02-user-home-migration-handoff.md)、[`storage-cli/01-project-layout-cli-plan.md`](storage-cli/01-project-layout-cli-plan.md) | 用户级单一 home 破坏性迁移 handoff（S0–S5 已完成）;旧项目级 `.runledger/`、settings、session 与 CLI 计划仅作为 superseded 迁移输入 | 迁移状态与最终证据查 `02`;旧布局历史见 [`project-cli-layout.md`](project-cli-layout.md) |
| TUI | [`tui/00-overview.md`](tui/00-overview.md) | TUI 总体设计与 `01`–`09` 专题导航 | `AGENTS.md` §1.2.x、§5 |
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
| TUI / Session Runtime Integration Repair | [`plan/01-tui-session-runtime-integration-repair-plan.md`](plan/01-tui-session-runtime-integration-repair-plan.md) | 编排 TUI、Session Owner、CLI、Process/PTY、Approval、Worktree、Trace 与扩展的真实接线、等价清理和 R8/R9 门禁 | 状态分别回写 `runtime/06`、`tui/19` 及 Plugin/MCP、Worktree/Security、Trace 权威文档 |
| Session Execution Reliability | [`plan/03-session-execution-reliability-repair-plan.md`](plan/03-session-execution-reliability-repair-plan.md) | 事故驱动的 governed toolchain、人工等待计时、run budget、lifecycle projection、process Trace 与 durable streaming 修复 | P0、P2–P6 implemented；P1 off-plan implemented、restrictive sandbox blocked；P7/R8/human acceptance pending |
| LSP Server Adapter | [`plan/04-lsp-server-adaptation-plan.md`](plan/04-lsp-server-adaptation-plan.md) | defaults/config 自动探测、stdio JSON-RPC、LspClient、AgentTool、WorkspaceEdit、managed LinterClient 与 SessionRuntime governed 接线 | P0–P6 review 修复已通过 fresh check/test/build 与隔离 CLI/TTY；P7 修复后 Session-managed 真实语言服务器/TUI smoke pending，状态查本文 §状态表 |
| Streaming Write 展示稳定性 | [`plan/05-streaming-prefix-stability-plan.md`](plan/05-streaming-prefix-stability-plan.md) | oh-my-pi 稳定前缀能力族移植：part 级 settled 契约、冻结前缀判定与字节稳定契约门、settled 行缓存、流式表格列宽锁定、流式 diff 行级高亮；不改 renderer/screen mode/OpenTUI 内部 | 本文 §现状核实与 §状态表；P2 `partial`、P3–P5 `implemented`、P6 `partial / blocked`；压力证据见 [`plan/05-streaming-prefix-stability-evidence-2026-08-15.json`](plan/05-streaming-prefix-stability-evidence-2026-08-15.json)，全量 check/test 的既有 TUI boundary blocker 不伪装为本任务通过 |
| Idle Recap | [`plan/07-idle-recap-replication-plan.md`](plan/07-idle-recap-replication-plan.md) | oh-my-pi 空闲 recap 的 ephemeral side-channel、当前模型复用、工具调用丢弃、owner/activity fencing、可配置 idle delay 与 fail-closed 接线 | 本文 §0 配置结论、§2 RunLedger 基线、§11 状态表 |
| Plugin / Tree-sitter Bash AST | [`plugin/01-tree-sitter-bash-ast-port-plan.md`](plugin/01-tree-sitter-bash-ast-port-plan.md) | Tree-sitter Bash AST 安全分类移植：WASM worker、allowlist walker、语义规则、fail-closed 授权与 rollout | B0–B4 `implemented`；B5 `planned`，Node/Bun、pack、PTY、审计与 human gate 仍按计划闭合 |

## 2026-08-04 当前实现批次

三个专项已在当前分支完成独占目录的可测试行为切片，已按领域形成可追溯本地提交；尚未完成 Host/CLI/TUI 串行生产接线，也未推送：

- Plan/Context/Compaction/Memory：Context assembly、cut/checkpoint lifecycle、Memory proposal/approval/search/persistence 及 Plan Mode reducer/artifact store；定向 10 files / 39 tests；提交 `68dab74`。
- Plugin/MCP/Skill/Hooks：extension foundation、Skill/Hook/MCP bounded behavior 与 Runtime resource/audit adapters；定向 6 files / 34 tests；提交 `b2bf04e`。
- Worktree/Sandbox/Permission：2026-08-04 切片曾交付 permission/config/worktree/sandbox 行为、ExecutionGateway、PolicyNetworkClient 和 final-leaf receipt adapter，定向 18 files / 88 tests，提交 `dde60ac`。自 2026-08-06 起 OS sandbox 跨平台扩展冻结；既有 Linux 证据只保留为回归，多平台 workspace/path 适配 P0 文档冻结已完成，P1 尚未授权。
- 全仓门禁：Vitest 144 files / 746 tests、Bun 5 files / 44 assertions、`npm run check`、`npm run build`、`git diff --check` 均通过。

下一阶段必须从各专项当前入口继续。Worktree/Sandbox/Permission 不得再从旧 Sandbox Phase 4 继续，而应按 `01-multiplatform-workspace-path-adaptation-plan.md` 从真实平台证据开始；OS sandbox 只有在 P0–P6 和新的解封 ADR 后才能重新规划。不能以本节的历史 focused tests 宣称当前专项或多平台能力完成。

### Plan 24 当前验收状态

Plan 24（Codex Session Display）当前状态为 `implemented/accepted`。2026-08-14 fresh evidence：`npm run check`、Vitest 342 files / 2015 passed / 3 skipped、Bun OpenTUI 89 passed / 443 assertions、`npm run build`，以及标准 PATH 隔离 `runledger` 的 80/143 列 dark/light 真实 TTY 和隔离 SQLite session fixture 验收；逐项记录见 [`tui/24-codex-session-display-replication-plan.md`](tui/24-codex-session-display-replication-plan.md) §S7。

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
│   └── 07-idle-recap-replication-plan.md
├── note/
│   ├── README.md
│   └── 00-session-audit-reading-mode-plan.md
├── plugin/
│   └── 01-tree-sitter-bash-ast-port-plan.md
├── providers/
│   └── 01-pi-ai-migration-plan.md
├── plugin-mcp-skill-hooks/
│   ├── 01-implementation-plan.md
│   └── 02-skill-registry-discovery-provider-refactor-plan.md
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
│   └── archive/
│       └── 00-os-sandbox-cross-platform-expansion-archived.md
├── storage-cli/
│   ├── 01-project-layout-cli-plan.md
│   └── 02-user-home-migration-handoff.md
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
    └── reference/
        └── 00-opentui-component-index.md
```
