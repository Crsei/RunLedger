# CLI 实际命令审计（2026-09-05）

本报告是重建 dist 后对当前 dirty working tree 的实际运行记录，不修改业务/测试源文件、暂存或提交。命令均经 `/home/nzq/.npm-global/bin/runledger` → Node launcher → Bun dist/cli/cli.js。

工作目录：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger`。隔离根：`/tmp/rlcli-teykrd9g`，独立 RUNLEDGER_DIR、HOME、XDG_CONFIG_HOME、XDG_DATA_HOME、XDG_CACHE_HOME、XDG_RUNTIME_DIR。子进程环境只允许 PATH、上述目录变量、TERM/LANG/NO_COLOR/SHELL，不继承 provider 凭据环境变量，不读取或复制真实用户凭据。

共执行 43 条命令。42 条在边界内自行结束；未知 flag 的一条 3 秒边界用进程组 SIGTERM 收口。后者仅记录为测试超时，不宣称应用性能/生命周期 bug。普通单条用 10–15 秒边界，追加命令用 12 秒。全部测试脚本已结束，所有 Popen 已 communicate/reap；本 agent 未启动长期服务。

## 已验证可用

`--help`、`--version`、`workspace --help`、`workspace capability`、`auth-gateway --help/status` 正常。`plugin list`、`skill list`、`skill provider list`、`hook list`、`mcp list`、`mcp doctor`、`plan inspect` 通过真实 Session Owner control composition 返回 ok:true。空 skills/MCP/plugin 列表是隔离环境预期。

`--thinking invalid`、`--model` 缺值、旧 `--session-dir`、非法 harness profile、workspace/control 未知 action、auth-gateway 非法 bind 均 exit 2 并输出明确错误。

## 确认问题

### CLI-01：security inspect 使用旧 operation 名称（P2）

`runledger security inspect` exit 0，返回 `{"ok":false,"status":"unavailable","code":"operation_unavailable","operation":"security.inspect"}`。`src/cli/control-commands.ts:235` 原样输出 security.inspect；`src/runtime/session-runtime/domain-router.ts:99` 和 `:150` 已提供的是 session.security.inspect。`src/cli/session-interactive-controller.ts:258` 因 manifest 不匹配直接拒绝。现有安全检查能力存在，但用户按帮助命令无法调用。

### CLI-02：skill provider enable/disable 在 CLI 丢失子操作名（P2）

`skill provider disable runledger-user`、`enable runledger-user` 和 `disable runledger-user --scope=workspace` 全 exit 0，返回 operation_unavailable，operation 为 `skill.provider`。`src/cli/control-commands.ts:235` 正确生成 skill.provider.enable/disable；`src/cli/main.ts:631` 在 mutation 分支重新拼成 group.action，丢失第三段。Session manifest 已声明 enable/disable（`src/runtime/session-runtime/extension-composition.ts:144-145`）。隔离设置未被修改。

### CLI-03：prune-legacy 帮助中的空格参数语法无法通过解析（P2）

帮助要求 `storage prune-legacy --manifest <digest> --confirm-delete`。实测给 64 位全零 digest 仍 exit 2 报 `--manifest 需要值`。改为 `--manifest=<digest>` 后才进入 archive 校验并报告 `source_read_failed: archive manifest not found or unreadable`（隔离目录无此 archive，属于正确拒绝，未删除任何数据）。定位 `src/cli/session-store-migrate.ts:28` 与 `:63-67`。

### CLI-04：remember 的公开帮助语法无法通过解析（P2）

帮助写 `runledger remember <text>`，实测 `remember audit-note` exit 2，报 `unsupported remember action: audit-note`。定位 `src/cli/control-commands.ts:106-108` 把正文当 action，及 `:293` 帮助。显式 `remember propose audit-note` 可以解析，但当前 memory.propose 本身不可用。这是语法和能力两层不同问题。

### CLI-05：控制操作/检查失败仍以成功退出码结束（P2）

所有 operation_unavailable 结果进程均 exit 0；`auth-gateway check --json` 与 `check --strict --json` 在空 home 明确返回 ok:false，进程也 exit 0。只检查 shell 退出码的脚本会误判通过。control 位于 `src/cli/main.ts:614`、`:624`、`:640`（仅打印返回值）；gateway 位于 `src/cli/auth-gateway-cli.ts:218-225`。报告逐项依据结构化 ok 字段判定，不按 exit 0 算成功。

## 已暴露但在当前 Session Owner 入口不可用的命令

实际 operation_unavailable：worktree list/inspect、compact list、context inspect、memory search、remember propose、plan enter、plugin inspect/reload、mcp inspect。这些与前述 security、skill 路由错误分开，属于当前用户可见命令面与生产 capability manifest 不一致；部分能力在项目计划中可能尚未迁移，不能概括成全部功能回归。

其中 `plugin reload` 的 CLI 发 plugin.reload，而当前 Session extension manifest 使用 extension.reload（`src/runtime/session-runtime/extension-composition.ts:137`）；plugin.inspect/mcp.inspect 未在该 manifest 公开。

## 非缺陷/覆盖限制

当前没有独立 `settings` 或 `telemetry` CLI 命令，main.ts 只解析 auth-gateway/migrate/workspace/storage/control groups。`settings --help` 与 `telemetry --help` 都输出全局帮助，不代表这些命令可用；本 agent 没有把它们作为已实现功能执行 set/reset。

普通未知 positional/flag 是源码显式 forward-compatible 语义。未知 positional 实测进入 TUI、输出 ANSI 欢迎屏，再因 stdin EOF 正常 exit 0；并未报 unknown command。未知 flag 在 3 秒边界被终止。此行为作为可用性观察保留，不当作现有明确契约的回归。

auth-gateway --strict 的 allowlisted 空环境仍枚举无凭据的本地 provider llama.cpp/litellm/lm-studio/vllm 并报无模型/连接失败；未做真实外部 provider E2E，也未启动、重启或调用被暂停的 Boost MCP 服务。

## 全部命令矩阵

完整 stdout/stderr 与 argv 在 results.json / extra-results.json 和逐命令文件；下表仅摘要。

| ID | 命令参数 | exit | 结果 |
| --- | --- | ---: | --- |
| help | `--help` | 0 | 已完成（详见输出） |
| version | `--version` | 0 | 已完成（详见输出） |
| workspace_help | `workspace --help` | 0 | 已完成（详见输出） |
| workspace_capability | `workspace capability` | 0 | 已完成（详见输出） |
| workspace_unknown | `workspace bogus` | 2 | 错误输出符合参数拒绝 |
| gateway_help | `auth-gateway --help` | 0 | 已完成（详见输出） |
| gateway_status | `auth-gateway status --json` | 0 | ok=True;  |
| gateway_check | `auth-gateway check --json` | 0 | ok=False;  |
| gateway_check_strict | `auth-gateway check --strict --json` | 0 | ok=False;  |
| gateway_invalid | `auth-gateway serve --bind bad` | 2 | 错误输出符合参数拒绝 |
| invalid_thinking | `--thinking invalid` | 2 | 错误输出符合参数拒绝 |
| missing_model | `--model` | 2 | 错误输出符合参数拒绝 |
| legacy_session_dir | `--session-dir /tmp/forbidden` | 2 | 错误输出符合参数拒绝 |
| invalid_harness | `--harness-profile bogus` | 2 | 错误输出符合参数拒绝 |
| invalid_control | `worktree bogus` | 2 | 错误输出符合参数拒绝 |
| prune_manifest_documented | `storage prune-legacy --manifest 0000000000000000000000000000000000000000000000000000000000000000 --confirm-delete` | 2 | 错误输出符合参数拒绝 |
| prune_manifest_equals | `storage prune-legacy --manifest=0000000000000000000000000000000000000000000000000000000000000000 --confirm-delete` | 2 | 错误输出符合参数拒绝 |
| security_inspect | `security inspect` | 0 | ok=False; operation_unavailable |
| worktree_list | `worktree list` | 0 | ok=False; operation_unavailable |
| plugin_list | `plugin list` | 0 | ok=True; ok |
| skill_list | `skill list` | 0 | ok=True; ok |
| skill_provider_list | `skill provider list` | 0 | ok=True; ok |
| hook_list | `hook list` | 0 | ok=True; ok |
| mcp_list | `mcp list` | 0 | ok=True; ok |
| plan_inspect | `plan inspect` | 0 | ok=True; ok |
| compact_list | `compact list` | 0 | ok=False; operation_unavailable |
| context_inspect | `context inspect` | 0 | ok=False; operation_unavailable |
| memory_search | `memory search audit-no-match` | 0 | ok=False; operation_unavailable |
| settings_help | `settings --help` | 0 | 已完成（详见输出） |
| telemetry_help | `telemetry --help` | 0 | 已完成（详见输出） |
| unknown_flag | `--not-a-real-runledger-flag` | -15 | 边界超时，已 SIGTERM 收口 |
| unknown_command | `not-a-real-runledger-command` | 0 | 已完成（详见输出） |
| skill_provider_disable | `skill provider disable runledger-user` | 0 | ok=False; operation_unavailable |
| skill_provider_enable | `skill provider enable runledger-user` | 0 | ok=False; operation_unavailable |
| skill_provider_disable_workspace | `skill provider disable runledger-user --scope=workspace` | 0 | ok=False; operation_unavailable |
| remember_documented | `remember audit-note` | 2 | 错误输出符合参数拒绝 |
| remember_explicit | `remember propose audit-note` | 0 | ok=False; operation_unavailable |
| plugin_inspect | `plugin inspect` | 0 | ok=False; operation_unavailable |
| plugin_reload | `plugin reload` | 0 | ok=False; operation_unavailable |
| mcp_doctor | `mcp doctor` | 0 | ok=True; ok |
| mcp_inspect | `mcp inspect` | 0 | ok=False; operation_unavailable |
| worktree_inspect | `worktree inspect` | 0 | ok=False; operation_unavailable |
| plan_enter | `plan enter` | 0 | ok=False; operation_unavailable |
