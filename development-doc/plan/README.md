# 跨领域执行计划

本目录保存跨领域实施编排；公共合同、生产 authority 与验收状态仍归各专题。完整历史计划导航见 [开发索引](../00-index.md)。

| 计划 | 范围与状态入口 |
|---|---|
| [Plan 17：oh-my-pi `/loop` 与 Goal Mode 适配](17-omp-loop-goal-mode-adaptation-plan.md) | in progress；P0（契约：`UserAgentMessage.origin`、goal/loop 事件、`GoalProjection` 扩展）、P1（goal authority）、P2（`goal` 工具与准入）、P3（mode fragment + 预算记账）、P4（loop limit/controller 与审计）、P6（`/goal`、`/loop` 命令、footer 徽标、timeline 生命周期行）已实现；P5 已按 D10(a) 实现条件求值，运行时端口已接到本 Session 的 governed shell。P0.5 独立缺陷修复已落地。阶段证据见 §13。 |
| [Plan 15：项目运行数据 Web 展示](15-project-runtime-web-observability-plan.md) | planned；参考 collab-web，规划本地只读项目/Session 看板、历史与实时桥接、轨迹及用量。 |
| [Plan 14：Agent Harness 既有执行闭环加固](14-agent-harness-reliability-hardening-plan.md) | H1–H5 已实现，完整 check/test/build 与确定性 HTTP/Owner、Built CLI/TTY 已通过；六例功能结果及人工/平台缺口单列，不新增产品功能。 |
| [Plan 03：Session 执行可靠性](03-session-execution-reliability-repair-plan.md) | 已有审批、中断、进程、预算及终态修复；状态和证据查该文 §1.2。 |
| [Plan 13：包边界 workspace 重构](13-package-boundary-workspace-refactor-plan.md) | 独立结构专项，不作为 Plan 14 的顺带重构内容。 |

新增计划在本页与总索引登记，实施时原地维护阶段证据，不另建重复完成状态文件。
