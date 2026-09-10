# RunLedger 文档总览

RunLedger 是面向可审计 Agent 执行的运行时。标准 CLI 通过 Session Owner Runtime 管理会话，以用户级 SQLite 保存会话权威状态，TUI 通过命令、查询与订阅参与交互。

本页是 `docs/` 的总入口，汇总命令使用、当前架构、子系统说明与历史参考。安装和项目启动见[项目 README](../README.md)，实施计划与验收记录见[开发文档总索引](../development-doc/00-index.md)。

## 从哪里开始

| 你要做什么 | 优先阅读 | 后续入口 |
|---|---|---|
| 启动 CLI、选择模型、继续或派生会话 | [CLI 参数表](cli.md) | [模型与认证](subsystems/models.md)、[会话运行时](subsystems/session-runtime.md) |
| 理解项目如何运行、模块如何协作 | [架构总览](architecture.md) | [子系统索引](subsystems/README.md) |
| 排查会话恢复、数据位置或迁移问题 | [持久化](subsystems/persistence.md) | [会话运行时](subsystems/session-runtime.md)、[存储迁移 handoff](../development-doc/storage-cli/02-user-home-migration-handoff.md) |
| 理解工具权限、批准或进程执行 | [工具与安全](subsystems/tools.md) | [工作区与 Worktree](subsystems/workspace.md) |
| 接入 Provider、MCP、Skill 或 Plugin | [模型与认证](subsystems/models.md)、[扩展系统](subsystems/extensions.md) | [架构中的扩展落点](architecture.md#新行为应放在哪里) |
| 查看本地运行记录与审计数据 | [Runtime Trace](subsystems/trace.md) | [持久化](subsystems/persistence.md) |
| 确认某项功能的实施与验收状态 | [开发文档总索引](../development-doc/00-index.md) | [审计入口](../development-doc/audit/README.md)及对应专题 |

初次了解项目可按“CLI 参数表 → 架构总览 → 相关子系统”阅读；修改实现前，另行阅读[工程约定](../AGENTS.md)和对应开发专题。

## 使用与架构

| 文档 | 内容 |
|---|---|
| [CLI 参数表](cli.md) | 启动参数、会话选择、模型与权限设置、控制子命令、网关、迁移、环境变量、示例及当前限制 |
| [架构总览](architecture.md) | 生产入口、Session Owner 组合、跨子系统数据流、生命周期、执行治理与新增行为的归属 |
| [真实 session 上下文快照](system-prompts.md) | 本项目真实 CLI/TUI 捕获的最终提示词、用户消息及完整工具 schema；AGENTS 正文刻意省略；附 JSON |
| [子系统索引](subsystems/README.md) | 各子系统职责与详细参考入口 |

## 子系统参考

子系统页面说明各自拥有的状态、数据流、生命周期、授权与失败语义，以及生产组合位置。按问题选择对应页面，跨模块流程先查架构总览。

| 子系统 | 文档 | 主要回答的问题 |
|---|---|---|
| Core Agent Runtime | [core.md](subsystems/core.md) | 模型请求循环、工具调用、消息队列、预算和中断如何协作？ |
| Models、Provider 与 Auth | [models.md](subsystems/models.md) | 模型如何注册与选择，凭据如何解析，流式请求如何路由？ |
| Session Runtime | [session-runtime.md](subsystems/session-runtime.md) | 谁拥有会话，客户端如何连接，命令如何受 driver 与 generation fence 约束？ |
| Persistence | [persistence.md](subsystems/persistence.md) | 数据保存在哪里，SQLite、事件、回执、checkpoint 与恢复如何关联？ |
| Tools、Security 与 Process | [tools.md](subsystems/tools.md) | 工具如何获得执行能力，副作用如何经过权限、批准和 ExecutionGateway？ |
| Bounded Subagents | [subagent.md](subsystems/subagent.md) | 有界 child 如何启用、委派、记录与恢复，当前有哪些能力限制？ |
| Workspace 与 Worktree | [workspace.md](subsystems/workspace.md) | 工作区身份、路径边界、Git worktree、lease 与冷恢复如何处理？ |
| Extensions、MCP、Hooks 与 Skills | [extensions.md](subsystems/extensions.md) | 扩展如何发现、信任、启用、注入和关闭，LSP 如何接入？ |
| Runtime Trace | [trace.md](subsystems/trace.md) | 如何记录本地事件、artifact、用量与费用，记录失败如何处理？ |

## 开发与验收入口

`development-doc/` 保存详细协议、专项计划、实施记录与验证证据；本页仅提供导航，不复制专项状态。

| 入口 | 用途 |
|---|---|
| [开发文档总索引](../development-doc/00-index.md) | 查找全部领域专题及其当前事实入口 |
| [Runtime Contract](../development-doc/runtime/04-governed-agent-harness-runtime-plan.md) | 公共 contract、schema、DTO、事件和存储布局 |
| [Session Owner Runtime](../development-doc/runtime/06-session-owner-runtime-replacement-plan.md) | 生产替换、运行时接线与验收门禁 |
| [存储迁移 handoff](../development-doc/storage-cli/02-user-home-migration-handoff.md) | canonical 用户 home、旧数据迁移和存储边界 |
| [TUI 专题](../development-doc/tui/00-overview.md) | 交互界面、展示与相关实施专题 |
| [测试专题](../development-doc/test/README.md) | 测试策略、runner 与证据边界 |
| [审计入口](../development-doc/audit/README.md) | 已记录问题、修复状态与复验记录 |

## 历史参考

| 文档 | 定位 |
|---|---|
| [pi 参考架构](pi-architecture.md) | pi 的 API、OAuth、Provider 与 Agent Core 结构，供理解早期移植背景 |
| [pi 参考架构图](pi-architecture-diagram.mmd) | 上述参考架构的 Mermaid 源图，可用支持 Mermaid 的工具查看 |

这些参考描述的是 pi，不代表 RunLedger 当前生产结构。判断 RunLedger 行为时，以当前组合代码、架构与子系统说明为依据。

## 文档维护约定

- 命令语法与实际消费行为维护在 CLI 参数表；跨子系统运行流维护在架构总览；领域细节维护在对应子系统页面。
- 新增或移动 `docs/` 页面时更新本总览；子系统页面同时更新子系统索引。新增开发专题时更新所属目录入口与开发文档总索引。
- 行为说明附相应源码入口；帮助文本、解析器与生产实现有差异时明确标注，不把“可解析”写成“可用”。
- 文档应区分计划、已实现与已验证。测试、构建、真实 CLI、外部 provider、人工交互和跨平台验证是不同证据，专项完成状态以对应记录为准。
- 示例、历史测试数量与旧实现说明不自动成为当前事实；实现变化后同步核对相关说明和链接。
