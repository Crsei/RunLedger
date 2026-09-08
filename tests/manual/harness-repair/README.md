# Harness 执行可靠性回归

先在当前 checkout 执行 `npm ci`、`npm run check`、`npm run build`，然后：

```sh
python3 tests/manual/harness-repair/run.py
# 单独验证超过请求预算的长历史投影：
python3 tests/manual/harness-repair/context.py
# 连续 32 次工具调用，验证状态动画不会随历史增长拖慢收尾：
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/harness-repair/latency.py --width 143
PYTHONDONTWRITEBYTECODE=1 python3 tests/manual/harness-repair/latency.py --width 80
```

依赖 Linux `/proc`、Python 3、tmux、Bun 和仓库构建产物。脚本为每次运行创建独立 tmux server、workspace、HOME 与绝对路径 RUNLEDGER_DIR，通过临时 PATH 链接执行本 checkout 的 `bin/runledger.js` → `dist`；不会重链全局 CLI，也不读取真实用户配置或凭据。

本地 HTTP fixture 经 LiteLLM adapter 返回确定性工具调用，模型由当前 provider 目录路由，不写旧兼容性 manifest。它验证真实 CLI、TCP、Session Owner、Security、受治理进程与 TUI 路径，不证明外部模型能力。

覆盖：

- `y` 批准执行并核对文件内容。
- 审批期间 Ctrl+C：run 以 aborted 结束，禁止文件不存在。
- 运行中 Ctrl+C：已启动标记存在，后续写入不发生。
- 审批超时：工具结果保留 approval_expired，命令没有执行。
- 审批期间杀死本测试 CLI，等待既有 20 秒心跳 stale 门禁后继续同一 Session：旧行显示 Outcome unknown，评估后 Footer 清除 Recovery required，并能完成新请求。
- 流在完整工具参数后报错：不出现写入、未执行结果保留。
- 大输出：最终 provider 请求保留末尾失败摘要且默认文本不超过 32,000 字符；近 300 KB 的原始输出不使单结果事件超出 TCP 帧上限。
- 相同命令连续失败三次：以 repeated_tool_failure 终止，说明任务未完成。
- 已配置模型不在目录：保持未选择状态，提交请求明确报错，没有替换模型请求。
- 正常退出码为 0；清理后无本测试仍存活的进程。

结果打印并保留在 `/tmp/runledger-harness-repair-*`，包括 `result.json`、TTY 文本帧、SQLite 和成功路径的 `events.json`。结果包含完整 dist 文件 SHA-256 映射；失败保留现场并返回非零。临时目录由使用者按需删除。该流程不由 `npm test` 自动发现。

`context.py` 复用同一 Probe/HTTP fixture，在 minimal 模式连续提交 16 轮较长输入，令历史超过目录模型的请求预算。断言最终实际 HTTP 请求保留最近输入、省略最早输入，而 SQLite 仍保留全部原始输入，并核对干净退出。输出位于 `/tmp/runledger-harness-context-*`，额外保存 `wire-requests.json`。它不经动态模型登录/切换，不修改模型目录容量；required 超限和多调用依赖组的精确边界另由 Context/HTTP 回归验证。

Linux TTY 自动化不替代人工视觉、中文 IME、macOS/Windows 或真实 DeepSeek 验收。原六个开发案例的生成代码质量应另行复测，不能从此回归推导得分提升。

`latency.py` 默认使用 PATH 中的真实 `runledger`，复用隔离 HOME、工作区与本地 HTTP fixture；recording 开启为 `events`。32 次受治理命令只读取隔离输出文件，累积中文和 emoji 历史，并从 SQLite 核对每次进程终态到工具结果的间隔。末五次中位数必须低于 1.5 秒、相对首五次增长低于 1 秒，单次不得超过 5 秒；同时核对 32 次成功、最终输出、退出码和进程清理。证据保存在 `/tmp/runledger-harness-latency-*`，该入口不调用外部模型，不由 `npm test` 自动运行。
