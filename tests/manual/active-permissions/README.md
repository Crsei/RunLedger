# 当前会话权限即时生效 TTY 回归

先运行 `npm run build`，确认标准 PATH 的 `runledger` 指向本仓库，再运行：

```bash
python3 tests/manual/active-permissions/run.py
python3 tests/manual/active-permissions/cross-session.py
```

两份脚本复用 `../harness-repair/run.py` 的 loopback provider、tmux 驱动和进程身份清理，仅发送本地确定性请求，隔离 HOME/RUNLEDGER_DIR，不读取真实凭据或用户配置。`run.py` 在仓库父目录创建测试目录。

覆盖同一 session 的审批等待中 `/` 进入权限页、Esc 返回、Full Access 确认、原操作只执行一次、后续 loop 免普通审批、切回 workspace-write 后拒绝不执行、重新打开权限页的 current。SQLite 验证两次审批、一次 superseded、revision 1→2→3；本地 provider 收到的后续 system 上下文也必须反映新版本，最后 Esc/Ctrl+D 正常退出并检查没有存活测试进程。

`cross-session.py` 在 `/tmp` 创建隔离目录，在同一个用户库中先后启动两个新 Session，重复相同的权限操作。验证两个会话均能从 workspace-write 切到 Full Access、后续 loop 各执行一次且无普通审批；两个会话使用相同的 updateId，但 prepared/applied 共四个全局 eventId 均不同。两个进程均正常退出，无存活 owner 或测试进程。

结果和捕帧保存在打印的 artifact root；`passed` 同时依赖行为、退出码和清理结果。该证据是 Linux 构建后 CLI/TUI + 本地 provider fixture，不代表真实外部模型、人工视觉/中文 IME 或跨平台验收。
