# Codex 提示词模板

这里保存适合 RunLedger 开发协作的可复制提示词。按用户指定使用 `notez/`；已有 `note/` 继续承载 Session Audit 专题。

入口：[完整模板集](01-codex-prompt-templates.md)。

| 需要做什么 | 模板 |
|---|---|
| 创建任务、先形成实施计划 | [01 创建任务](01-codex-prompt-templates.md#task-create) |
| 执行已有计划或直接实现需求 | [02 执行任务](01-codex-prompt-templates.md#task-execute) |
| 排查故障，暂不修改 | [03 Debug 只读诊断](01-codex-prompt-templates.md#debug-readonly) |
| 复现并完成根因修复 | [04 Debug 修复](01-codex-prompt-templates.md#debug-fix) |
| 整理模块、保持行为 | [05 重构代码](01-codex-prompt-templates.md#refactor) |
| 编写或更新权威文档 | [06 构建文档](01-codex-prompt-templates.md#documentation) |
| 验证终端真实交互 | [07 CLI 和 TUI](01-codex-prompt-templates.md#cli-tui) |
| 审查代码、架构或安全问题 | [08 只读 Review](01-codex-prompt-templates.md#review) |
| 调研其他仓库，判断可迁移部分 | [09 跨仓库比较](01-codex-prompt-templates.md#comparison) |
| 并行使用开发子 Agent | [10 并行协作](01-codex-prompt-templates.md#delegation) |
| 继续任务、补充要求或交接 | [11 续接和中途调整](01-codex-prompt-templates.md#continuation) |
| 提交已有的指定改动 | [12 整理提交](01-codex-prompt-templates.md#commit) |
| 小任务或临时补充约束 | [短提示词](01-codex-prompt-templates.md#short-prompts) |

使用时替换 `【占位内容】`，删除不适用的行。通常选一个主模板，必要时加一条补充提示即可。日常不需要把所有模板一起发送。

这些代码块是供用户选择的示例，阅读本文不构成执行其中任务的授权。工程、验证和提交规则以根目录 [AGENTS.md](../../AGENTS.md) 为准；专题入口见 [开发索引](../00-index.md)。
