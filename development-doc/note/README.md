# Note 模块

本目录保存面向用户的只读检查与阅读模式方案，不承担 Runtime、Trace Store 或 TUI renderer 的通用 contract。

| 文档 | 状态 | 内容 |
|---|---|---|
| [`00-session-audit-reading-mode-plan.md`](00-session-audit-reading-mode-plan.md) | superseded | 历史 `/audit` 方案，由[运行轨迹专项](../trajectory/01-runtime-trajectory-implementation-plan.md)接替 |

当前实施入口是[运行轨迹专项](../trajectory/01-runtime-trajectory-implementation-plan.md)，不再单独实现 `/audit` 面板。状态必须以代码、测试和计划内验收证据更新，不能从本文推断功能已经实现。
