# 当前会话权限即时生效 TTY 回归

先运行 `npm run build`，确认标准 PATH 的 `runledger` 指向本仓库，再运行：

```bash
python3 tests/manual/active-permissions/run.py
```

脚本复用 `../harness-repair/run.py` 的 loopback provider、tmux 驱动和进程身份清理，仅发送本地确定性请求。测试目录创建在仓库父目录，隔离 HOME/RUNLEDGER_DIR；不读取真实凭据或用户配置。

覆盖同一 session 的审批等待中 `/` 进入权限页、Esc 返回、Full Access 确认、原操作只执行一次、后续 loop 免普通审批、切回 workspace-write 后拒绝不执行、重新打开权限页的 current。SQLite 验证两次审批、一次 superseded、revision 1→2→3；本地 provider 收到的后续 system 上下文也必须反映新版本，最后 Esc/Ctrl+D 正常退出并检查没有存活测试进程。

结果和捕帧保存在打印的 artifact root；`passed` 同时依赖行为、退出码和清理结果。该证据是 Linux 构建后 CLI/TUI + 本地 provider fixture，不代表真实外部模型、人工视觉/中文 IME 或跨平台验收。
