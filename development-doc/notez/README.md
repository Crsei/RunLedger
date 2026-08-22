# Notez 模块

本目录保存跨项目配置差集核对笔记，不承担 Runtime、Storage 或 TUI 的通用 contract。与 `note/`（Session Audit 阅读模式）不同，`notez/` 面向"对照其他实现盘点本仓库缺失能力/设置"的清单类文档。

| 文档 | 状态 | 内容 |
|---|---|---|
| [`00-settings-gap-vs-oh-my-pi.md`](00-settings-gap-vs-oh-my-pi.md) | 核对完成（2026-08-21） | 对照 oh-my-pi `SETTINGS_SCHEMA` 的 RunLedger 缺失设置清单：重试 → 运维；模型/采样为待核实项 |

核对基线：oh-my-pi `packages/coding-agent/src/config/settings-schema.ts`（HEAD，2026-08-21）与 RunLedger `b23b900921f9`。状态必须以代码证据更新，不能从本文推断 candidate 或功能已经实现；后续若基线变化，应新建差集快照或明确修订日期。
