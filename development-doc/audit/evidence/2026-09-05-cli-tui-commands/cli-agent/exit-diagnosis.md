# TUI /quit 不退出：只读定位（2026-09-05）

观察对象：root 的映射 Azure fixture 会话，launcher Node PID 26715，Bun PID 26873；隔离 state.db 位于 `/tmp/runledger-command-audit-20260905-7i4fzqru/live-tui/mapped/state/state.db`。未 kill、attach debugger、发送协议命令、读取 auth_token、读取真实用户配置或凭据。本报告只含 `/proc`、源码和只读 SQLite 指定列。

## 当前可以确认的事实

1. root 报告 /quit 已清屏且数分钟未退出。11:35 左右 `ps` 显示两进程已运行 4:21，Node 与 Bun 主线程 wchan 都为 ep_poll。
2. Bun 保留 state.db / WAL / SHM fd，以及唯一 socket fd 16（inode 566602677）。`/proc/26873/net/tcp` 对应 `127.0.0.1:46811`，状态 0A（LISTEN）。采样时无本地已连接 client socket，也无外部 provider socket fd。Node 只保留 TTY、pipe、eventfd/eventpoll。
3. owner row 一直是 runtime_owner-46811 / generation 1 / state running。**本 agent 实时采样的 heartbeat 持续更新**，并非停止：

| UTC 采样 | heartbeat_at_ms |
| --- | ---: |
| 03:36:03.483 | 1788579361081 |
| 03:36:31.943 | 1788579391106 |
| 03:37:02.973 | 1788579421121 |
| 03:37:33.942 | 1788579451138 |

最终相邻采样与完整 fd 在 `exit-proc-snapshots.json`；单次 owner 快照在 `mapped-owner-live.json`。和 root 较早的“heartbeat 已停止”判断有冲突，应以同一 PID/row 的连续实时采样为准。

## 退出链路与判断

源码退出序列：

- `src/tui/interactive-mode.ts:879` requestExit：cancel effects；若 in-flight，则 interrupt 并无限等待 waitForIdle；之后清订阅，`:917` ui.stop，随后 resolveExit。
- `src/cli/session-transition-loop.ts:37` 等 run 返回后 await detach。
- `src/cli/main.ts:355` detach：dispose controller → await handle.close → pauseIfLastAttachment(false)。
- `src/runtime/session-server/client-transport.ts:111-117` handle.close 只用 socket.end(callback) 完成 Promise，没有 close/error/timeout 收口；signalClosed 虽清理 pending，不会直接 resolve 这个 close Promise。
- `src/cli/main.ts:444` pauseIfLastAttachment：等待 10ms，connections>0 则返回并保留 owner，否则调用 shutdownAfterLastAttachment。
- `src/runtime/session-runtime/lifecycle-controller.ts:91-93` orderly shutdown 一开始就设 stopping 并停止 heartbeat。
- orderly shutdown 再等待 controller idle（最多 3s）、flush/aborted receipt、`:115` **无总时限**等待 lifecycleCleanup，然后 checkpoint → owner.release → server.close。

由连续 heartbeat 可判断：本次 mapped 进程采样时尚未进入 orderly shutdown 的 stopHeartbeat 阶段。因此当前证据不支持“卡在 provider cleanup 或 lifecycleCleanup 内”的根因结论。

优先候选是 renderer 退出到 owner shutdown 之间的本地 detach/transport close/attachment 通知链。`SessionClientTransport.close` 的 end callback 无其他完成路径，以及 socket fd 已消失却 owner 仍 LISTEN+heartbeat，是值得直接加边界日志复验的组合；但尚无 JS 调用栈，不能声称已证明卡在 end callback。另一候选是 UI.run 尚未返回，尽管 requestExit 已清屏；run 的启动阶段还会 await syncThinkingWorkflow，不过 thinking.inspect 是本地同步快照，此处作为低优先候选。

`SessionRuntimeServer.onDisconnect` 在 close 事件中移除 connection、releaseDriver、清 reverse requests，最后在 attachment count=0 时调用 shutdown。原生 fd 已无连接不能独立证明 JavaScript close 事件和 attachment callback 已完成。

## 如果新的 fresh 会话确实停止 heartbeat 却不 release

那是不同阶段，应看 lifecycleCleanup 的逐段收口：

1. embedded-session-runtime.ts:265 domain.shutdown。
2. domain.ts:369-379：titleLifecycle.dispose（同步）→ extension shutdown → scoped LSP shutdownAll → security.close。
3. extension-composition.ts:193-200：MCP close → hooks close → plugins close → cleanup → audit，串行无总时限。
4. security.close 只等待 ownedBashAnalyzer.close（session-security.ts:228）；不是通用 provider cleanup。
5. embedded-session-runtime.ts:266 process.shutdown；process/composition.ts:266-285 对活跃 handle 做 TERM/5s/KILL/5s，再 waitForTerminalTasks。
6. embedded-session-runtime.ts:267 workspace.release。
7. 然后 lifecycle-controller.ts:116-118 才 checkpoint/release/server close。

通用 `cleanupSessionResources` 注册表只看到 OpenAI Codex websocket cache 注册，未发现标准 Session Owner 退出调用它；mapped 会话没有外部 socket fd，所以当前 Azure 实例不支持归因 websocket cache。也未发现从该 cleanup 注册表导致当前 shutdown 等待的调用链。

## 最小后续验证建议（未实施）

在隔离复验中标记 ui.run resolve、detach before/after handle.close、server onDisconnect/count、shutdown start、domain/extension/LSP/security/process/workspace cleanup 各段完成。同时每 3 秒采样 owner 指定列，记录本地/远端 socket 数量。先定位卡住的 await，再决定回归测试和修复；现有无模型 /quit 成功不能替代有模型 turn 后的 built CLI 退出验证。

root 早前对原 fixture /quit 后过早 kill tmux、随后 continue 的 owner_connect_failed，属于受强停影响的样本，本报告不将其作为正常退出/恢复缺陷。

## root 独立 fresh 复验补充

root 随后以全新隔离 fixture-exit home、一轮成功纯文本回答 `4`、无工具、无历史复验：/quit 清屏后 20.014 秒 `pane_dead=0`，数分钟后 Node PID 29473 仍在。root 记录 observedAtMs=1788579513382，heartbeat_at_ms=1788579512448，owner state=running、port=36341。此对照排除了“旧 fixture 强停/恢复状态是发生条件”；也与 mapped 连续活跃 heartbeat 一致，问题优先落在 shutdown 开始之前的退出/detach 链。精确卡住的 await 仍未证实。本 agent 已结束排查，目标进程由 root 定向收口。
