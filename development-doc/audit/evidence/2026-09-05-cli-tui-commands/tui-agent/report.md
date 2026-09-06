# TUI 命令实跑记录（2026-09-05）

本次在真实 tmux TTY 中运行全局 `/home/nzq/.npm-global/bin/runledger`，解析到当前仓库 `bin/runledger.js`，由 Node launcher 启动 Bun 加载 freshly built `dist/cli/cli.js`。测试覆盖 100×30 和 80×24；两个 launcher 最终都正常 exit 0。没有修改仓库源码、测试、配置，也没有访问或复制真实用户凭据。

## 环境与证据

- cwd：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger`
- 独立 socket：`rl-tui-audit-20260905-7i4fzqru`；tmux 2.6。
- 独立 `RUNLEDGER_DIR`：本目录 `state/runledger`；HOME 与 XDG 路径也在 `state/`。
- 环境使用白名单（PATH、TERM、LANG、SHELL、隔离 HOME/XDG/RUNLEDGER_DIR），不继承 provider key、auth token、代理或其他 RUNLEDGER 变量。
- `drive.py` 保留启动/输入/截帧驱动；`actions.jsonl` 保留时间、参数、pane PID、退出码与真实尺寸；数字前缀 `.txt` 是完整帧。
- 100×30 launcher PID 54758，`36-quit.txt` 为 `pane_dead=1 / exit=0`；80×24 launcher PID 15603，`43-narrow-ctrl-d.txt` 为 `pane_dead=1 / exit=0`。随后移除本测试 tmux server。
- `launch.json` 最后记录的是第二次 80×24 启动，第一次启动尺寸/PID 保存在 actions 与各帧。

## 实际执行结果

| 操作 | 结果 | 证据 |
| --- | --- | --- |
| fresh `runledger` | Welcome、输入区、footer 可见；没有 model/provider | 01-startup.txt |
| `你好，请计算 2 + 3。` | 明确拒绝：`No model selected. Use /provider or /model.`，TUI 仍可操作 | 02-question-1.txt |
| `/help` | `/commands` 面板打开，Esc 正常关闭 | 03-help.txt、04-help-close.txt |
| `/model` | `No available models. Use /provider or /login first.` | 05-model.txt |
| `/provider` | builtin provider 列表打开，Esc 正常关闭；未选择或登录 | 06-provider.txt、07-provider-close.txt |
| `/permissions` | 三档权限面板打开，Esc 关闭；未修改权限 | 08-permissions.txt、09-permissions-close.txt |
| `/sessions` | alias 正确打开 `/resume`；显示当前 Session 和 Harness | 10-sessions.txt、15-sessions-minimal.txt |
| `/new minimal` | 新会话 header 显示 `minimal@1`，旧 Welcome 不重复显示 | 12-new-minimal.txt |
| `/hide-thinking` | `Thinking blocks hidden (display only).`，隔离 settings 持久化 `hideThinkingBlock: true` | 13-hide-thinking.txt |
| `/rename TUI smoke 最小会话` | 重命名成功，catalog 显示完整中文标题 | 14-rename.txt、15-sessions-minimal.txt |
| `/processes` | `Processes · driver / No managed processes` 面板可关闭 | 17-processes.txt、18-processes-close.txt |
| `/plan` | 成功返回 inactive 状态说明，同时标题状态显示 `unknown` | 19-plan.txt、30-standard-plan.txt |
| `/compact` | **失败：operation_unavailable**，minimal 与 standard 均复现 | 20-compact.txt、29-standard-compact-repeat.txt |
| `/memory` | **失败：operation_unavailable**，minimal 与 standard 均复现 | 21-memory.txt、28-standard-memory.txt |
| `/recovery` | `state=ready barrier=closed unresolved=0` | 22-recovery.txt |
| `/terminal`（无参数） | 友好显示 `/terminal <executionId>` 用法 | 23-terminal.txt |
| `/settings`（非注册命令） | 明确拒绝 `Unknown command: /settings` | 24-unknown.txt |
| `请列出当前项目的主要目录。` | 与第一题相同，明确提示没有 model；未假装回答 | 25-question-2.txt |
| `/new standard` | 切换到 `standard@1`，TUI 继续可用 | 26-new-standard.txt、27-standard-compact.txt |
| `/remember 本次审计只验证命令链路。` | **失败：operation_unavailable** | 31-standard-remember.txt |
| `/quit` | 正常 exit 0 | 36-quit.txt |
| 80×24 fresh start + `/help` + `/sessions` | 两个面板可开关；存在下面列出的首屏裁切 | 37/38/40 对应帧 |
| 80×24 `/hide-thinking` | 跨进程读取此前 true，切换为 visible，证明设置持久化生效 | 42-narrow-toggle.txt |
| 80×24 Esc 后 Ctrl+D | 正常 exit 0 | 43-narrow-ctrl-d.txt |

共覆盖 16 个已注册 slash 命令名、1 个未知命令、2 次中文提问以及两条退出路径。两次中文输入是 tmux send-keys 的 UTF-8 文本，不代表真人中文 IME 验收。

## 问题收集

### P2：已展示的 `/compact`、`/memory`、`/remember` 在标准 CLI 中不可用

复现：隔离 home 启动全局 runledger，待输入区 ready 后依次输入 `/compact`、`/memory`、`/remember <text>`。在 `standard@1` 下三条都显示 `failed: operation_unavailable`；前两条在 minimal 下也相同。不是等待 model 响应或 credential 授权：命令作为 domain query/mutation 直接失败。

源码：`src/tui/commands/registry.ts:255-277` 无条件注册并展示三条命令；`src/tui/interactive-mode.ts:1128-1139` 路由到 `compaction.list`、`memory.inspect`、`memory.propose`。`src/runtime/session-runtime/domain-router.ts:91-104` 基础 manifest 未声明这三项；query 最终在 `:169-174` 返回 unavailable，mutation 在 `:436` 返回 unavailable；`src/runtime/session-runtime/query-handler.ts:36-74` 的附加转发路径只处理真实已注册的 multiAgent/process/resources 操作。TUI 最终在 `src/tui/interactive/plan-workflow.ts:67-69` 直接显示错误码。该证据能确认当前生产入口缺口，不表示 legacy Host 没有相关实现。

建议后续明确为 Session Owner 接线，或依据实际协商 capability 在菜单中标明不可用；本次仅记录未修复。

### P3：80×24 的 Welcome 首屏裁掉标题和主要快捷键

实际 80×24 startup 帧从左栏 `<no-model>` 和右栏 `Ctrl+D to exit` 开始，RunLedger 标题、Welcome、`/ for commands`、`Enter to send` 均不在首屏；输入区仍正常。证据 `37-narrow-startup.txt`。`src/tui/components/welcome.ts:78-87` 的布局输入只有 width；`:132-155` 在满足横向宽度时生成固定两栏内容，`:170-185` 预留四条 recent slots，没有可用高度预算。该结构与短终端中的首屏裁切一致。此项为自动截帧观察，非人工视觉验收。

### P3：80×24 footer 将 thinking 的值裁掉

80×24 多个帧的最后一行均终止于 `· think:`，没有 `off`；100×30 可见 `think:off`。证据 `37-narrow-startup.txt`、`40-narrow-sessions.txt`、`42-narrow-toggle.txt`。相关代码位置 `src/tui/footer/field-registry.ts:276-277` 生成 model+thinking 文本，`:301-327` 分配行宽；`src/tui/components/footer.ts:48-55` 传递行宽。具体应修正哪层宽度预算需进一步定位，不能仅凭截帧认定根因。

### P3：`/plan` 对已知 inactive 状态显示 `unknown`

`/plan` 返回 `Plan mode · unknown · rev=0 · Plan mode is inactive.`。这是显示映射问题，不是 runtime 查询失败；`src/tui/adapters/session-resources.ts:336-342` 明确将 inactive 映射为 unknown，`:355` 又正确输出 inactive summary，`src/tui/interactive/plan-workflow.ts:31-34` 把二者同时展示。证据 `30-standard-plan.txt`。

## 边界及排除项

- 没有真实 provider 凭据，因此本报告不宣称 LLM 问答、模型工具调用、Agent 子委托或网络端到端通过。未配置 model 时的错误是预期负向行为。
- `/settings`、`/tasks`、`/telemetry`、`/session` 不在本次当前 builtin registry；只对 `/settings` 实际输入并确认 unknown，其余仅静态核对。不要把未注册命令误报成回归。
- 没有 durable user message 的会话在正常退出/切换后被回收，导致 catalog 只保留当前一项；源码 `src/storage/session-store/catalog-repository.ts:131-168` 明确如此。两次无 model 提问未被接受为 durable user message。此次即使重命名但未有 user message 的 minimal 会话也被回收；按当前实现记录，不单独认定缺陷。
- 初次 `/new standard` 后 1 秒抓到了过渡空帧，随后的第一个 `/compact` 输入发生在 replacement 尚未 ready 时，因此不作为该命令证据；待 ready 后重复 `/compact` 才作为失败复现。
- tmux 2.6 不支持 `resize-window`，这属于测试驱动兼容问题。没有用未成功的 resize 声称窄屏已验证；后续销毁原 server 并真实启动 80×24，再进行窄屏测试。
- 尚未覆盖 dark/light 对比、人工键盘/IME、真实 process terminal 交互及 macOS/Windows。
