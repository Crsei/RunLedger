# RunLedger 子系统

本目录为 RunLedger 的当前子系统参考：每页说明一个子系统拥有的状态与能力、它移动的数据、生命周期、授权/失败语义以及生产组合位置。它补充[架构总览](../architecture.md)；架构总览描述跨子系统行为，本目录保存下钻细节。

| 页面 | 唯一负责内容 |
|---|---|
| [core.md](core.md) | `Agent`、`runAgentLoop`、消息/事件、`StreamFn`、queue、budget、interrupt 与 tool-call continuation |
| [models.md](models.md) | Model/API/Provider 注册、credential/OAuth、统一 streaming 与 Session model routing |
| [session-runtime.md](session-runtime.md) | Session Owner、attachment/driver、generation fence、localhost 协议、command/query 与 Runtime lifecycle |
| [persistence.md](persistence.md) | canonical home、SQLite Session Store、hash-chain events、attempt receipts、checkpoint、restore 与 JSONL 边界 |
| [tools.md](tools.md) | `AgentTool`、ToolRegistry、ExecutionEnv、stdlib/process tools、权限/批准、ExecutionGateway 与最终 I/O leaf |
| [subagent.md](subagent.md) | 默认关闭的有界 root-owned child execution、policy、只读 capability subset、graph、report 与 takeover replay |
| [workspace.md](workspace.md) | workspace identity、path/locator、containment、worktree lease/lifecycle 与 cold-resume revalidation |
| [extensions.md](extensions.md) | Plugin/Skill/Hook/MCP/LSP 的发现、信任、Session 私有快照、工具/context 注入和关闭顺序 |
| [trace.md](trace.md) | 本地 Runtime Trace event/artifact store、tree projection、recording authority、redaction 与失败策略 |

这些页面不复制源码类型声明，也不使用参考仓库的生成区标记。RunLedger 目前没有将文档声明与 TypeScript symbol 自动比对的 manifest；这里以源码链接、行为语义和 ownership 为准，避免维护一份无法自动防漂移的类型副本。
