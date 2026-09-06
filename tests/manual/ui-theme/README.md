# UI 主题真实 CLI 验证

先执行 `npm run build`，再运行：

```sh
python3 tests/manual/ui-theme/run.py
```

默认解析 PATH 中的 `runledger`。独立工作树可用 `--executable /absolute/path/bin/runledger.js`；`--single` 只验证默认暗色 80 列，`--auto-only` 只验证自动切换。

完整矩阵覆盖三套预设 × dark/light × 80/143 列，以及一次 `thinkingText` 单槽覆盖和一次 auto 模式的实际终端主题通知，共 14 例。每例先建立全新的隔离 home/workspace，再通过实际 SessionStore 与 owner fence 写入合成用户、思考、回答事件；真实 CLI 恢复这些历史，通过 tmux 捕获主界面与 Ctrl+T transcript 的 ANSI 色值，并断言正常退出码。

测试输出 `/tmp/rl-theme-matrix-*/summary.json`，逐例保留 `main.ansi`、`transcript.ansi`、`result.json`。只清理自身的 tmux server，保留隔离证据目录。`seed.mjs` 拒绝已有 home，不能对真实用户目录执行。

此流程不请求外部模型、不复制真实凭据。模型兼容 manifest 与占位 API key 均为合成 UI 输入；通过只证明构建后的历史恢复与实际终端着色，不等同于真实 provider、人工视觉/IME 或其他平台验收。流式稳定前缀和主题切换另由 `ui-theme-rendering.bun.test.ts` 验证。
