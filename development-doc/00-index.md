# RunLedger 开发计划索引

本目录按开发模块保存 RunLedger 的设计、实施计划与现状说明。原 `.zcode/plans/` 中以 session ID 命名的六份计划已归档到对应模块,并改为可直接识别主题的文件名。

## 文档使用约定

- `*-plan.md` 是历史实施计划,用于说明当时的目标、决策、依赖、实施顺序与验收边界,不作为当前完成状态的唯一事实源。
- Runtime 例外:`runtime/04-governed-agent-harness-runtime-plan.md` 是当前权威执行入口;`runtime/00-reference.md` 只作为设计输入,`01`–`03` 保留为历史计划。
- 当前代码能力、测试数量和显式非目标以仓库根目录 `AGENTS.md` 为准。
- 已有专题文档继续作为模块的现状说明或详细设计;计划与现状不混写。
- 后续新增计划应直接放入对应模块目录,使用语义化文件名,不再使用 session ID 作为文档名。

## 模块导航

| 开发模块 | 计划与设计文档 | 关注范围 | 当前事实入口 |
|---|---|---|---|
| Runtime | [`runtime/04-governed-agent-harness-runtime-plan.md`](runtime/04-governed-agent-harness-runtime-plan.md) | 当前权威计划:Session v3、Workspace、Capability、Artifact、Orchestrator、Verification、Multi-Agent、Daemon | 计划内阶段验收证据 + `AGENTS.md` |
| Runtime / Workflow | [`loop-goal-workflow/00-reference.md`](loop-goal-workflow/00-reference.md)、[`01-implementation-plan.md`](loop-goal-workflow/01-implementation-plan.md)、[`02-implementation-checklist.md`](loop-goal-workflow/02-implementation-checklist.md) | `coding-goal/v1`、durable wake/attempt、确定性 Task 调度、内部 continuation、恢复与 rollout | `02` 阶段证据 + [`runtime/04`](runtime/04-governed-agent-harness-runtime-plan.md) + [`runtime/06`](runtime/06-specialty-implementation-freeze.md) |
| Runtime | [`runtime/00-reference.md`](runtime/00-reference.md) | 可治理 Agent Harness Runtime 的设计输入与问题域 | `runtime/04-governed-agent-harness-runtime-plan.md` |
| Runtime | [`runtime/01-minimum-runtime-scaffold-plan.md`](runtime/01-minimum-runtime-scaffold-plan.md) | 最小 Agent Runtime、事件流、ledger、mock stream、echo tool | `AGENTS.md` §1.2 |
| Runtime | [`runtime/02-agent-loop-resurrection-plan.md`](runtime/02-agent-loop-resurrection-plan.md) | agent-loop、Agent、ledger、真实 LLM 完整循环 | `AGENTS.md` §1.2、§5 |
| Runtime | [`runtime/03-tool-system-plan.md`](runtime/03-tool-system-plan.md) | ToolRegistry、ExecutionEnv、stdlib 工具、stream 桥接 | `AGENTS.md` §1.2、§5 |
| Provider | [`providers/01-pi-ai-migration-plan.md`](providers/01-pi-ai-migration-plan.md) | API、OAuth、provider、model catalog、凭据存储 | `AGENTS.md` §1.1 |
| Storage / CLI | [`storage-cli/01-project-layout-cli-plan.md`](storage-cli/01-project-layout-cli-plan.md) | `.runledger/`、settings、session、CLI、TUI 装配 | [`project-cli-layout.md`](project-cli-layout.md) |
| TUI | [`tui/11-tui-structure-completion-plan.md`](tui/11-tui-structure-completion-plan.md) | 当前权威计划:command/session、统一 Timeline、应用协调层与严格实施顺序 | [`tui/00-overview.md`](tui/00-overview.md)、`AGENTS.md` §1.2.x、§5 |
| TUI | [`tui/00-overview.md`](tui/00-overview.md) | TUI 总体设计与 `01`–`11` 专题导航 | `AGENTS.md` §1.2.x、§5 |
| TUI | [`tui/10-documentation-update-plan.md`](tui/10-documentation-update-plan.md) | 跨项目 lessons 与远程控制路线文档更新记录 | [`tui/08-cross-project-lessons.md`](tui/08-cross-project-lessons.md)、[`tui/09-remote-control-roadmap.md`](tui/09-remote-control-roadmap.md) |
| Extension | [`plugin-mcp-skill-hooks/01-implementation-plan.md`](plugin-mcp-skill-hooks/01-implementation-plan.md) | Plugin、Skill、Hooks、MCP、OAuth、控制面与签名 marketplace 的 M0–M7 权威状态账本 | 计划 §0.3、§8.1 与 `AGENTS.md` §1.2.y |

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
├── loop-goal-workflow/
│   ├── 00-reference.md
│   ├── 01-implementation-plan.md
│   └── 02-implementation-checklist.md
├── project-cli-layout.md
├── providers/
│   └── 01-pi-ai-migration-plan.md
├── plugin-mcp-skill-hooks/
│   ├── 00-reference.md
│   ├── 01-implementation-plan.md
│   └── dependency-review.md
├── runtime/
│   ├── 00-reference.md
│   ├── 01-minimum-runtime-scaffold-plan.md
│   ├── 02-agent-loop-resurrection-plan.md
│   ├── 03-tool-system-plan.md
│   ├── 04-governed-agent-harness-runtime-plan.md
│   ├── 05-remaining-stuff.md
│   └── 06-specialty-implementation-freeze.md
├── storage-cli/
│   └── 01-project-layout-cli-plan.md
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
    └── 11-tui-structure-completion-plan.md
```
