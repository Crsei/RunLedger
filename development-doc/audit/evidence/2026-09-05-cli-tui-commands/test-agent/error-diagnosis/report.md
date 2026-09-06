已确认一项当前功能缺陷：Provider 在发送 stream start 之前失败时，真实 TUI live 不显示 assistant 错误正文，只留下用户提问和失败 run/footer；错误已经持久化，replay 路径能够显示。

实际证据来自父任务以新 dist 启动的真实 CLI/TUI：`live-tui/mapped/question-1-result.txt` 没有 Connection error。只读查询同一隔离 `live-tui/mapped/state/state.db` 的 `session_events`：sequence 8 为 user message_start，9 为 user message_end，14 直接为 assistant message_end（stopReason=error、content=[]、errorMessage=Connection error.），没有 assistant message_start。完整非敏感 Agent 事件抽取见 `actual-agent-events.json`。

| 层 | 当前源码位置 | 行为与影响 |
| --- | --- | --- |
| Azure provider | src/api/azure-openai-responses.ts:114 | 先 await HTTP `responses.create(...).withResponse()`，成功后 :116 才 push start；连接或 HTTP 失败走 :130 catch，:138 仅 push error。 |
| Agent loop | src/runtime/agent-loop/loop-runner.ts:233 | 仅 provider start 才发 assistant message_start；:286 保存 error providerMessage；:322 判断 `messageOpen || providerMessage`，因此未 start 也会在 :326 发 assistant message_end。 |
| Live TUI body | src/tui/interactive/event-controller.ts:148 | staged helper 已正确得到 `Error: Connection error.`，:151 派发 message_update，但没有补建 row。 |
| Row identity | src/tui/timeline/event-projector.ts:75 | currentAssistantCorrelationId 返回 `assistant:${messageIndex - 1}`；:192 仅 message_start 创建 row，:227 message_end 只投影 usage/end。当前真实序列指向不存在的 assistant:0。 |
| Reducer | src/tui/timeline/reducer.ts:50 | :52 对不存在的 assistant row 丢弃 message_update，:79/:82 也忽略 orphan end，所以正确错误文本不进入 timeline。 |
| Footer | src/tui/interactive/event-controller.ts:89 | agent_end 独立提交 failed run-boundary，因而 footer 能显示 done:error。 |
| Replay | src/tui/interactive-mode.ts:1241 | canonical messages 逐个走 replay-message；src/tui/timeline/event-projector.ts:128 创建完整 assistant row 与 failed status，故 staged errorText fallback 在此有效。 |

只读小实验直接复用当前源码和已有 ContractController/ContractTerminal，exit 0，详见 `repro.mjs`、`experiment-result.json` 与 `experiment-invocation.json`：

1. 将真实 SQLite 事件逐个送进 InteractiveMode：只有 user:0 和 failed run-boundary，assistant 行数为 0。
2. 保持相同事件，仅在 assistant end 前补一个合成 assistant start 作为对照：得到 assistant:1、status=failed、text=`Error: Connection error.`。不修改源码。
3. 将同一事件中的 canonical message 交给 InteractiveMode 构造时 replay：得到相同 failed assistant 行和错误正文。此项是现有生产 projection 的自动化证明，实际 `--continue` TTY 验证由父任务完成。
4. 真实 runAgentLoop 接收只包含 error 的 deterministic stream：仍发出 assistant message_end 而没有 assistant message_start，再次验证缺失从上游生命周期产生。

已有 staged 回退修复为何不够：`tests/tui/interactive/event-helpers.test.ts:6` 只验证字符串提取；`tests/tui/timeline/event-projector.test.ts:85` 只验证 replay。它们不能证明 live error-only stream 能创建 row。本次不改任何测试或实现。

后续修复应保证 provider 早期失败仍有完整 assistant start/end 生命周期，或在 TUI 消费含 canonical assistant 的 orphan end 时有明确的 row 创建规则；再用 error-only provider → runAgentLoop → live TUI 集成回归覆盖。一般 orphan/duplicate/stale event 规则需要保留，不能简单把所有 orphan end 转成行。

本子任务仅读取隔离 DB，未读取 auth.json，未运行外部 provider 请求。临时实验的 HOME/TMPDIR 已删除；脚本、事件快照和结果留存于本目录。源码和暂存区均未修改。
