# Harness 执行可靠性回归

先在当前 checkout 执行 `npm ci`、`npm run check`、`npm run build`，然后：

```sh
python3 tests/manual/harness-repair/run.py
```

依赖 Linux `/proc`、Python 3、tmux、Bun 和仓库构建产物。脚本为每次运行创建独立 tmux server、workspace、HOME 与绝对路径 RUNLEDGER_DIR，通过临时 PATH 链接执行本 checkout 的 `bin/runledger.js` → `dist`；不会重链全局 CLI，也不读取真实用户配置或凭据。

本地 HTTP fixture 经 LiteLLM adapter 返回确定性工具调用，模型 manifest 明确标记 synthetic。它验证真实 CLI、TCP、Session Owner、Security、受治理进程与 TUI 路径，不证明外部模型能力。

覆盖：

- `y` 批准执行并核对文件内容。
- 审批期间 Ctrl+C：run 以 aborted 结束，禁止文件不存在。
- 运行中 Ctrl+C：已启动标记存在，后续写入不发生。
- 审批超时：工具结果保留 approval_expired，命令没有执行。
- 审批期间杀死本测试 CLI，等待既有 20 秒心跳 stale 门禁后继续同一 Session：旧行显示 Outcome unknown，评估后 Footer 清除 Recovery required，并能完成新请求。
- 已配置模型未准入：启动明确失败，没有替换模型请求。
- 正常退出码为 0；清理后无本测试仍存活的进程。

结果打印并保留在 `/tmp/runledger-harness-repair-*`，包括 `result.json`、TTY 文本帧、SQLite 和成功路径的 `events.json`。结果包含完整 dist 文件 SHA-256 映射；失败保留现场并返回非零。临时目录由使用者按需删除。该流程不由 `npm test` 自动发现。

Linux TTY 自动化不替代人工视觉、中文 IME、macOS/Windows 或真实 DeepSeek 验收。原六个开发案例的生成代码质量应另行复测，不能从此回归推导得分提升。
