# 跨领域执行计划

本目录保存跨领域实施编排；公共合同、生产 authority 与验收状态仍归各专题。完整历史计划导航见 [开发索引](../00-index.md)。

| 计划 | 范围与状态入口 |
|---|---|
| [Plan 18：oh-my-pi Web 能力移植（`web_search` 与站点抓取）](18-omp-web-capability-port-plan.md) | `implemented`；`src/websource/`（19 provider + 74 站点 handler + 三条 port）与 `web_search` 接线已落地，check/test/build 与 built CLI/TTY 证据见 §11。Tier C 的 5 个 LLM 介导 provider、youtube 抓取、markit 转换与浏览器兜底按裁定不纳入；真实外部检索服务未验证（本机无出网）。 |
| [Plan 17：oh-my-pi `/loop` 与 Goal Mode 适配](17-omp-loop-goal-mode-adaptation-plan.md) | in progress；主体已提交（`12d0552`），§14 的 goal 首轮、持久暂停、client reset、动态描述已补入工作树，并有定向与本地 CLI/TTY 证据。完整测试失败、条件子进程清理及其他 R5 验收缺口仍在，补充实现已提交；当前事实查 §14，§13 保留历史快照。 |
| [Plan 15：项目运行数据 Web 展示](15-project-runtime-web-observability-plan.md) | in progress；W01–W06 已接线，可启动本地只读 Web；浏览器侧已拆为 workspace 包 `packages/collab-web`（§9.5）；真实 CLI/浏览器与规模证据已记录，W07 全仓门禁受阻。 |
| [Plan 14：Agent Harness 既有执行闭环加固](14-agent-harness-reliability-hardening-plan.md) | H1–H5 已实现，完整 check/test/build 与确定性 HTTP/Owner、Built CLI/TTY 已通过；六例功能结果及人工/平台缺口单列，不新增产品功能。 |
| [Plan 03：Session 执行可靠性](03-session-execution-reliability-repair-plan.md) | 已有审批、中断、进程、预算及终态修复；状态和证据查该文 §1.2。 |
| [Plan 13：包边界 workspace 重构](13-package-boundary-workspace-refactor-plan.md) | 独立结构专项，不作为 Plan 14 的顺带重构内容；P4 已先行落地 `packages/collab-web`（§0）。 |

新增计划在本页与总索引登记，实施时原地维护阶段证据，不另建重复完成状态文件。
