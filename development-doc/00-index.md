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
| Runtime Host / Terminal | [`runtime/05-multi-client-background-terminal-refactor-plan.md`](runtime/05-multi-client-background-terminal-refactor-plan.md) | 单 Host 多客户端、driver fencing、受治理后台进程、PTY、恢复与 OpenTUI 阅读控制 | 旧实现 `08`/`10` 审计、当前代码/tests 与 Runtime Contract |
| Runtime Trace / Opik | [`runtime/trace/README.md`](runtime/trace/README.md) | Event Store、Artifact Store、模型/工具/上下文/耗时/Token/费用记录、Opik 投影与父子树 | `runtime/trace/00-opik-agent-observability-plan.md`、当前代码/tests |
| Session Audit Note | [`note/README.md`](note/README.md) | 当前打开 session 的 `/audit` 只读调用树、计量与 Artifact 阅读模式 | [`note/00-session-audit-reading-mode-plan.md`](note/00-session-audit-reading-mode-plan.md)、Runtime Trace 当前代码/tests |
| Provider | [`providers/01-pi-ai-migration-plan.md`](providers/01-pi-ai-migration-plan.md) | API、OAuth、provider、model catalog、凭据存储 | `AGENTS.md` §1.1 |
| Storage / CLI | [`storage-cli/02-user-home-migration-handoff.md`](storage-cli/02-user-home-migration-handoff.md)、[`storage-cli/01-project-layout-cli-plan.md`](storage-cli/01-project-layout-cli-plan.md) | 用户级单一 home 破坏性迁移 handoff（S0–S5 已完成）;旧项目级 `.runledger/`、settings、session 与 CLI 计划仅作为 superseded 迁移输入 | 迁移状态与最终证据查 `02`;旧布局历史见 [`project-cli-layout.md`](project-cli-layout.md) |
| TUI | [`tui/00-overview.md`](tui/00-overview.md) | TUI 总体设计与 `01`–`09` 专题导航 | `AGENTS.md` §1.2.x、§5 |
| TUI | [`tui/10-documentation-update-plan.md`](tui/10-documentation-update-plan.md) | 跨项目 lessons 与远程控制路线文档更新记录 | [`tui/08-cross-project-lessons.md`](tui/08-cross-project-lessons.md)、[`tui/09-remote-control-roadmap.md`](tui/09-remote-control-roadmap.md) |
| TUI / OpenTUI | [`tui/17-opentui-refactor-plan.md`](tui/17-opentui-refactor-plan.md) | pi-tui → OpenTUI imperative core 实现、PTY/native frame 与全仓门禁证据 | [`tui/reference/00-opentui-component-index.md`](tui/reference/00-opentui-component-index.md) |
| TUI / OpenTUI Performance | [`tui/18-opentui-streaming-performance-ux-plan.md`](tui/18-opentui-streaming-performance-ux-plan.md) | 迁移后的增量 timeline、流式合并、长会话窗口化、背压与响应式交互体验 | Plan 17 P8 证据、当前代码/tests 与本文 before/after artifact |

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
├── note/
│   ├── README.md
│   └── 00-session-audit-reading-mode-plan.md
├── providers/
│   └── 01-pi-ai-migration-plan.md
├── runtime/
│   ├── 00-reference.md
│   ├── 01-minimum-runtime-scaffold-plan.md
│   ├── 02-agent-loop-resurrection-plan.md
│   ├── 03-tool-system-plan.md
│   ├── 04-governed-agent-harness-runtime-plan.md
│   ├── 05-multi-client-background-terminal-refactor-plan.md
│   └── trace/
│       ├── README.md
│       ├── 00-opik-agent-observability-plan.md
│       ├── phase-01-event-store-artifact-store.md
│       ├── phase-02-runtime-recorder.md
│       ├── phase-03-local-store-configuration.md
│       └── phase-04-opik-exporter-tree.md
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
    ├── 18-opentui-streaming-performance-ux-plan.md
    └── reference/
        └── 00-opentui-component-index.md
```
