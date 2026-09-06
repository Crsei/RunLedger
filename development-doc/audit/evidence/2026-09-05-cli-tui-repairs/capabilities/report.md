P2-07 的 TUI 能力展示与派发已修复，未补建未实现的 backend。

`/` 输入补全与 `/commands` 菜单现在读取当前 Session 协商的精确 operation。缺少能力的命令保留可发现性，描述显示 `Unavailable in this session`；直接输入、补全 Enter 和菜单选择走同一 guard，给出 `operation_unavailable` 与简洁替代操作。`/compact` 提示开启新会话并携带摘要，`/memory` 与 `/remember` 提示使用普通消息提供上下文或 `/resume` 打开已保存会话。扩展命令缺少能力时提示 `/new standard`。服务端在本地已协商后仍返回 unavailable 时也使用同样说明。

入口映射遵照现有真实调用：`/plugins`、`/skills`、`/hooks` 实际查询 `extension.inspect`，所以不按名称误判 `plugin.list`；`/mcp` 使用 `mcp.list`，`/skillsproviders` 使用 `skill.provider.list`。计划、压缩与 memory 分别对应其真实操作。支持的命令保留既有描述并继续真实派发。

RED：先添加 registry 与真实 InteractiveMode fixture 回归，2 个文件中 8 个断言失败，均因旧菜单未标记或旧提示只有裸 operation_unavailable；随后实现最小修改，GREEN 2 files / 24 tests。相邻 slash、extension、interactive-control、session-domain 回归为 8 files / 105 tests 全通过。TUI boundary 与 diff --check 通过。完整命令、退出状态、日志与 runner cleanup 见本目录 invocation/evidence/json。

修改范围见 `summary.json`。interactive-mode.ts 仅动 registry import、openSlashCommands 的 context、dispatchCommand 开头 guard，与 tui agent 的 Welcome 构造改动互不覆盖。plan-workflow.ts 仅修改通用 runDomainCommand 的错误提示，不修改 plan state 映射。

未 stage、commit、push 或独立 build。统一 npm run check、build 和新 dist 真实 TUI smoke 由 root 完成。CLI inspect/reload/帮助映射由 cli agent 承接。当前 memory/compaction 等实际 backend 缺口保持明确不可用，不做伪成功。
