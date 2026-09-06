# 运行轨迹

本专题维护 RunLedger 本地运行轨迹记录、查询和 TUI 展示的实施合同。

- [运行轨迹实施计划](01-runtime-trajectory-implementation-plan.md)：默认记录、配置关闭、Run/Step/Call 投影、历史分页、实时更新、`/trajectory` 面板与验收。
- [实施与验证记录](02-implementation-verification.md)：当前代码接线、资源测量、自动化/TTY 结果和 pending 门禁。
- [Runtime Trace](../runtime/trace/README.md)：既有记录器、Event Store、Artifact Store 和远程导出边界。
- [Session Owner Runtime](../runtime/06-session-owner-runtime-replacement-plan.md)：会话 authority、查询/订阅与恢复。
- [TUI](../tui/00-overview.md)：既有交互与渲染约束。

状态：本地 recording 默认 events、owner 轨迹查询与 `/trajectory` 已在工作树实现；完整验收按验证记录区分通过、既有阻碍与人工/平台 pending。
