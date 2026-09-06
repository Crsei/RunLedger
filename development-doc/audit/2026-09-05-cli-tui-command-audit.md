# 2026-09-05 CLI / TUI 命令与提问实测

本文保留首次审计及后续修复两层证据。§1–5 是修复前的实际观察；[§6](#6-修复与复验) 记录用户随后要求修复后的实现与重新验证。首次审计由三个 Codex 子 Agent 和主 Agent 实测全局 `runledger`，确认基础交互可用，但发现命令路由、失败退出码、错误展示和退出生命周期问题。未暂存、提交或推送。

## 1. 测试边界与快照

- 仓库：`/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger`；分支 `rollback/before-composer-shape`；HEAD `bd8dc1c7093a68801820f8018448bd6c7db6972f`。
- 开始时已有 13 个暂存代码/测试路径，以及文档改动；记录在 [baseline-status.txt](evidence/2026-09-05-cli-tui-commands/baseline-status.txt)。这些改动属于测试输入，不属于本次修复。
- `command -v runledger` 为 `/home/nzq/.npm-global/bin/runledger`，真实目标为本仓库 `bin/runledger.js`。Node launcher 启动 Bun 加载 `dist/cli/cli.js`。本次先执行完整 `npm run build`。
- Linux；Node `v22.23.1`、Bun `1.3.14`、tmux `2.6`。真实 TTY 尺寸包括 120×38、100×30、80×24。
- 所有运行使用各自临时 `RUNLEDGER_DIR`、HOME、XDG 路径和独立 tmux socket；不读取、复制或修改真实 `~/.runledger/`。CLI/TUI 基础矩阵清除 provider 凭据；外部模型尝试仅继承现有进程环境中的 Azure 凭据，不写入证据。
- 测试期间另有 provider/API/catalog 并行改动出现，已保留；没有为追赶这些改动重建。运行证据归属于 [candidate-digests.json](evidence/2026-09-05-cli-tui-commands/candidate-digests.json) 标识的产物，check 与 focused tests 则归属于各自执行时源码，不能概括成后续工作树的全量验收。

## 2. 已完成的验证

| 层次 | 实际结果 | 证据 |
|---|---|---|
| 构建 | `npm run build` exit 0 | [完整输出](evidence/2026-09-05-cli-tui-commands/build.log) |
| 静态检查 | `npm run check` exit 0，含 Rust 12 tests | [完整输出](evidence/2026-09-05-cli-tui-commands/check.log) |
| 现有 focused 测试 | 39 files / 259 tests，exit 0；不是完整 `npm test` | [报告](evidence/2026-09-05-cli-tui-commands/test-agent/report.md)、[日志](evidence/2026-09-05-cli-tui-commands/test-agent/focused-tests.log) |
| 项目自身 subagent | 两个集成套件 7 tests 通过，包含真实 child Agent、governed read/grep、禁止 write、重复 report 与 takeover 断点 | 同上；模型为 deterministic keyless fixture |
| 真实 CLI | 43 条调用；42 条自行结束，未知 flag 一条到测试边界后终止；结构化失败没有算通过 | [完整命令矩阵](evidence/2026-09-05-cli-tui-commands/cli-agent/report.md) |
| 无模型真实 TUI | 16 个注册 slash 命令、1 个未知命令、2 次中文输入；无模型提问正确拒绝；无模型 `/quit` 与 Ctrl+D 均 exit 0 | [完整报告与帧索引](evidence/2026-09-05-cli-tui-commands/tui-agent/report.md) |
| 带模型 TUI | 本地 HTTP Responses 夹具完成多轮提问、真实 read/Bash 工具和错误后恢复；发现错误正文缺失与退出驻留 | 下文 §3、§4 |

CLI 已实测正常：help/version、workspace capability、plugin/skill/hook/MCP 列表、skill provider list、MCP doctor、plan inspect，以及主要非法参数拒绝。

TUI 已实测正常：`/help`、`/provider`、`/permissions`、`/sessions`、`/new standard`、`/new minimal`、中文 `/rename`、`/hide-thinking` 持久化、`/processes`、`/recovery` 和缺参数提示。UTF-8 文本由 tmux 输入，不代表真人中文 IME 验收。

## 3. 实际输入的问题

先尝试 Azure 外部模型 `azure-openai-responses/gpt-4.1-mini`。空用户目录没有 model compatibility manifest，显式指定模型时启动即 exit 2，提示 `model profile is not verified`；这是当前 fail-closed 准入行为。随后仅在另一临时用户目录写入明确标记 `audit-fixture-20260905` 的测试 manifest，并在测试子进程中将现有 `AZURE_OPENAI_ENDPOINT` 映射为当前 adapter 接受的 `AZURE_OPENAI_BASE_URL`，继续验证下游链路。该测试输入的 `status=verified` 不构成真实 provider 资格认证。

外部尝试提交了“请只回答数字：2 + 2 等于多少？”，得到持久化 `Connection error.`。无凭据网络探测同时观察到该 Azure 主机 DNS 解析失败、继承现有代理时 TLS EOF。**没有取得外部模型成功回答，不能宣称真实 LLM E2E 通过**；环境连接失败本身不直接归因为 RunLedger。

为覆盖下游，使用监听 `127.0.0.1` 的 HTTP Responses 夹具及虚拟 key，通过相同全局 CLI、真实 Session Owner、provider adapter 和 TUI 输入以下六轮。夹具按请求返回确定性内容，不检验模型推理质量，也不提供真实 token/cost 证据。

| 轮次 | 输入 | 观察 |
|---|---|---|
| 1 | 请只回答数字：2 + 2 等于多少？ | TUI 显示 `4`，`done:stop` |
| 2 | 上一轮回答是什么？请简短回答。 | 夹具收到 user/assistant/user 历史，显示“上一轮回答：4” |
| 3 | 请调用 read 读取当前项目 package.json 的前六行。 | 真实 governed read 成功；TUI 展示 `Read package.json` 与实际前六行；toolResult 回到下一次 HTTP 请求 |
| 4 | 请执行命令 printf audit-ok，并报告输出。 | 真实 Bash 执行；TUI 显示 `audit-ok`、`EXIT: 0`；toolResult 回到下一轮 |
| 5 | 触发错误，测试 provider 失败后的界面反馈。 | HTTP 503；账本有 `AUDIT_PROVIDER_UNAVAILABLE`，live TUI 只有 `done:error`，无错误正文 |
| 6 | 恢复后再问一次：2 + 2 等于多少？ | 继续接受输入，显示 `4`、`done:stop` |

证据：[HTTP 请求摘要](evidence/2026-09-05-cli-tui-commands/fixture-requests.jsonl)、[read](evidence/2026-09-05-cli-tui-commands/live-tui/fixture/question-3-result.txt)、[Bash](evidence/2026-09-05-cli-tui-commands/live-tui/fixture/question-4-result.txt)、[503](evidence/2026-09-05-cli-tui-commands/live-tui/fixture/question-5-error.txt)、[恢复](evidence/2026-09-05-cli-tui-commands/live-tui/fixture/question-6-recovered.txt)。

## 4. 问题清单

### P2-01：模型在 stream start 前失败，live TUI 丢失错误正文

外部连接错误和本地 HTTP 503 均复现：用户只看到 `done:error`，不知道失败原因。SQLite `session_events` 存有完整 assistant `message_end`、`stopReason=error` 和 `errorMessage`，但没有 assistant `message_start`。

`src/api/azure-openai-responses.ts:114-116` 在 HTTP 成功后才发 provider start，catch 只发 error；`src/runtime/agent-loop/loop-runner.ts:233` 依赖 start 创建 assistant 消息，第 322 行仍会发 end。`src/tui/interactive/event-controller.ts:148` 虽已生成错误文本，`src/tui/timeline/reducer.ts:52`、`:82` 对不存在行的 update/end 均忽略。因此当前暂存的错误正文兜底仍未覆盖这个真实事件序列。

独立实验将真实持久化事件送入现有 InteractiveMode：live 无 assistant 行；仅补一个 assistant start 的对照立即显示错误；同一 canonical message replay 也显示错误。实际 `--continue` 重放同样可见 503 正文，见 [重放帧](evidence/2026-09-05-cli-tui-commands/live-tui/fixture/resumed-after-stale-owner.txt)。[定位报告](evidence/2026-09-05-cli-tui-commands/test-agent/error-diagnosis/report.md)、[实验结果](evidence/2026-09-05-cli-tui-commands/test-agent/error-diagnosis/experiment-result.json)。

### P2-02：失败的控制命令仍返回 shell 成功退出码

多个 control 调用输出 `ok:false / operation_unavailable`，进程却 exit 0；空配置下 `auth-gateway check --json`、`check --strict --json` 也输出 `ok:false` 并 exit 0。只检查退出码的自动化会误判成功。

位置：`src/cli/main.ts:614,624,640` 只打印 control 结果；`src/cli/auth-gateway-cli.ts:218-225` 输出检查结果后未设置失败退出码。完整输出在 [CLI results](evidence/2026-09-05-cli-tui-commands/cli-agent/results.json)。

### P2-03：security inspect 仍调用旧 operation

`runledger security inspect` 返回 `operation_unavailable`。CLI 发 `security.inspect`，Session Owner 提供 `session.security.inspect`。对应 `src/cli/control-commands.ts:235` 与 `src/runtime/session-runtime/domain-router.ts:99,150`。能力已存在，但公开 CLI 名称没有正确映射。

### P2-04：skill provider enable/disable 丢失子操作

`runledger skill provider enable runledger-user`、`disable runledger-user` 均返回 `operation_unavailable`，没有改变隔离设置。`controlCommandRequest` 已生成 `skill.provider.enable/disable`，但 `src/cli/main.ts:631` 在 mutation 分支重新拼成 `skill.provider`。Session extension manifest 已声明正确操作。追加输出见 [extra-results.json](evidence/2026-09-05-cli-tui-commands/cli-agent/extra-results.json)。

### P2-05：storage prune-legacy 帮助参数格式不能执行

帮助给出 `storage prune-legacy --manifest <digest> --confirm-delete`，给定 64 位 digest 仍报 `--manifest 需要值`；只有 `--manifest=<digest>` 能进入 archive 校验。位置 `src/cli/session-store-migrate.ts:28,63-67`。测试使用隔离目录中不存在的 archive，未删除任何源数据。

### P2-06：remember CLI 将帮助中的正文误判为 action

帮助是 `runledger remember <text>`，实际 `remember audit-note` 报 `unsupported remember action: audit-note`。显式 `remember propose audit-note` 能解析，但随后因 memory capability 未接通而失败；语法错误与能力缺口应分别处理。位置 `src/cli/control-commands.ts:106-108,293`。

### P2-07：菜单/帮助暴露的命令尚未接通当前 Session Owner

真实 CLI 的 worktree list/inspect、compact list、context inspect、memory search、remember propose、plan enter、plugin inspect/reload、mcp inspect，以及 standard TUI 的 `/compact`、`/memory`、`/remember` 均返回 `operation_unavailable`。

TUI registry `src/tui/commands/registry.ts:255-277` 无条件展示命令，`src/tui/interactive-mode.ts:1128-1139` 发起 domain 操作，但当前 Session operation manifest 未提供对应能力。`plugin reload` 另有 `plugin.reload` 与 `extension.reload` 的名称差异。这里确认的是生产入口缺口，不把 legacy Host 的实现、计划中的 deferred 功能或单元测试视为已可使用。

### P2-08：完成模型请求后 /quit 清屏却没有结束进程

外部模型连接失败后的会话，以及全新隔离 home 中只完成一轮成功夹具问答的会话，都在 `/quit` 后清屏但继续驻留。后一对照不包含工具调用、历史恢复或此前强停；等待 20.014 秒仍 `pane_dead=0`，随后复查仍有 launcher、Bun runtime 和活跃 owner 心跳。无模型 TUI 的 `/quit`、Ctrl+D 对照均正常 exit 0。

证据：[fresh 退出观察](evidence/2026-09-05-cli-tui-commands/fresh-fixture-exit-observation.json)、[只读定位](evidence/2026-09-05-cli-tui-commands/cli-agent/exit-diagnosis.md)。活跃心跳说明当时尚未执行 last-attachment shutdown 的 `stopHeartbeat`，不能归因于已经进入 provider cleanup。`handle.close`、client transport 的 socket 关闭等待是待验证候选；没有调用栈证据，不宣称具体根因已确定。测试结束后定向终止这些隔离进程，不能把强制清理记为正常退出通过。

### P3-01：短终端首屏与 footer 裁切

真实 80×24 中，Welcome 从中段开始，标题和主要快捷键不在首屏；输入框仍可操作。footer 尾部只见 `think:`，缺少 `off`。见 [80×24 帧](evidence/2026-09-05-cli-tui-commands/tui-agent/37-narrow-startup.txt)。Welcome 仅按宽度布局，相关位置 `src/tui/components/welcome.ts:78-87,132-185`；footer 宽度分配相关位置 `src/tui/footer/field-registry.ts:276-327`。这是自动截帧观察，footer 精确根因尚未证实。

### P3-02：/plan 把已知 inactive 展示为 unknown

显示 `Plan mode · unknown · rev=0 · Plan mode is inactive.`。`src/tui/adapters/session-resources.ts:336-342` 将 inactive 映射为 unknown，summary 又使用 inactive。查询本身成功，属于状态展示不一致。见 [帧](evidence/2026-09-05-cli-tui-commands/tui-agent/30-standard-plan.txt)。

## 5. 排除项与剩余验证

- `settings`、`telemetry` 并非当前独立 CLI 命令；`/settings`、`/tasks`、`/telemetry`、`/session` 不在当前 builtin slash registry，不能把未注册入口当作功能回归。
- 空 home 下没有 model/credential/compatibility manifest 的拒绝是本次明确记录的前置条件；本次没有安装生产认证清单或改变准入策略。
- 未执行完整 `npm test`、真实外部模型成功问答、真人暗/亮主题和 IME、macOS/Windows runner；不提升相关领域计划的 human/cross-platform acceptance。
- 为检查重放，主 Agent 曾在第一轮夹具 `/quit` 尚未确认进程结束时关闭测试 tmux server，随即 `--continue` 得到 `owner_connect_failed`；这个结果受测试强停影响，不列为独立正常恢复缺陷。待 owner 过期后再继续可重放历史，显示 recovery-required，符合故障恢复情境。
- 完整临时工作证据位于 `/tmp/runledger-command-audit-20260905-7i4fzqru`；精选记录归档在本文 [evidence 目录](evidence/2026-09-05-cli-tui-commands/manifest.json)。归档不包含 credential 文件、用户数据库、环境密钥或生产模型资格宣称。
- 收尾时再次校验候选产物，摘要未变化；本次跟踪的 7 个主 Agent 测试进程经定向 SIGTERM 全部退出，无需 SIGKILL，独立 tmux servers 已移除。详见 [候选复核](evidence/2026-09-05-cli-tui-commands/candidate-final-verification.json) 和 [清理证据](evidence/2026-09-05-cli-tui-commands/cleanup.json)。这些清理动作不改变 P2-08 的正常退出失败结论。

## 6. 修复与复验

用户随后要求“开始修复以上问题”。修复继续在原脏工作树执行，三个子 Agent 分担 CLI、TUI 布局、命令可用性及独立复查；没有暂存、提交、推送，也没有修改 sandbox 实现。原有暂存 patch 与修复前逐字节一致；并行 provider/catalog 与拆包任务的改动保留。收尾时并行 provider 任务已将 HEAD 推进到 `0fcd88b80ba545bb7b9b07904c1d1af8204942fb`；这不是本修复提交。本轮 CLI/runtime/TUI 候选产物摘要经复核未因此变化。

### 6.1 原问题处理结果

| 原编号 | 实现结果 |
|---|---|
| P2-01 | Agent loop 对 provider 在 start 前直接返回 error/aborted 的情况补齐 assistant start/end 边界；live TUI 现在显示 HTTP 503 错误正文。未把失败伪装成已开始流式输出的计时。 |
| P2-02 | control query、前置 query、mutation 及 auth-gateway check 的结构化 `ok:false` 返回非零退出码，保留错误 JSON 与退出清理。 |
| P2-03 | `security inspect` 正确映射为 `session.security.inspect`。 |
| P2-04 | mutation 复用已解析 operation，保留 `skill.provider.enable/disable`；user policy 实际落盘。额外修正 `--scope user/workspace` 被全局 parser 丢弃的问题；不支持的 workspace scope 明确拒绝，不能静默修改 user policy。 |
| P2-05 | prune 同时接受 `--manifest <digest>` 和 `--manifest=<digest>`；两种形式都经过实际隔离 archive 迁移和删除验证。 |
| P2-06 | `remember <text>` 与 `remember propose <text>` 均正确解析并走 mutation；memory 后端当前仍不可用，返回明确非零错误。 |
| P2-07 | `plugin reload` 修正为现有 `extension.reload`；菜单与派发依据当前协商 operation 标注和拦截不可用命令，给出替代操作；帮助说明当前能力边界。未把 deferred 后端功能伪造成可用实现。 |
| P2-08 | 客户端只消费 `agent.event` 更新 Agent 状态，ledger 记录不能重新置忙；仅 agent_start/end 改变运行状态；服务端在 TCP EOF 时立即撤销 attachment 和 driver 并关闭 socket，避免 Bun 等待待发响应而无限保活。 |
| P3-01 | Welcome 读取实际 composer、footer、header 和资源行数分配高度；footer 投影预留原生缩进。在 80×24 保留 Harness、标题、快捷键和完整 thinking 值。 |
| P3-02 | PlanRenderView 保留合法 `inactive` 状态，`/plan` 不再显示 unknown。 |

P2-08 的两条根因分别由回归测试与真实 Bun 运行定位：一是 ledger/空闲 queue_update 把已完成 run 标为忙；二是 server socket 已收到 EOF、`writableEnded=true`，仍保留 162 bytes 待发内容，没有产生 close，导致 owner 心跳不停止。修复后正常完成 last-attachment shutdown，远端 attachment 存在时仍保持可用。[原始生命周期诊断](evidence/2026-09-05-cli-tui-repairs/exit-diagnostic.jsonl) 保留 EOF 与写队列状态；诊断脚本未加入生产源码。

### 6.2 复查发现并一并修复的相邻问题

- **追加问题正文丢失**：客户端原先根据调用参数而非最终 command kind 选择正文，运行中默认输入会发 `steer + promptText`，空闲显式 steer/followUp 会发 `prompt + text`；生产 route 因字段不符读到空串。现在按实际 kind 选择字段，六种组合均通过真实 conversation route 解码测试。
- **活跃会话 attach 的忙碌状态**：snapshot cursor 可能已经越过 agent_start，因此构造时从 `agentRuns.status=active` 初始化；completed/recovery_required 保持空闲，后续 agent_end 解锁 waitForIdle。避免修正 queue_update 后影响中途 attach。
- 原审计归档的 runner 原始元数据包含自身版本标签，与项目文档格式扫描冲突。将这份原始 JSON 按日志保存为 `focused-evidence.log`，正文不变，并更新引用与摘要；未放宽检查器规则。

### 6.3 验证证据

本轮模型问答仍使用 §3 的 loopback HTTP Responses 夹具、虚拟 key 和隔离测试 manifest；未写生产认证配置，未重试或宣称外部真实模型成功。

- **真实 PATH CLI：26/26，0 超时**。覆盖 security/reload、skill user 设置持久化、workspace 拒绝且不误改 user、失败退出码、两种 remember 语法及实际 archive 删除。负向用例的 PASS 只表示拒绝行为正确。[报告](evidence/2026-09-05-cli-tui-repairs/cli-live/report.md)、[完整结果](evidence/2026-09-05-cli-tui-repairs/cli-live/results.json)。
- **真实 PATH TUI：六轮问答通过**，包括多轮历史、governed read、真实 Bash、503 正文和错误后恢复；额外验证 Alt+Up 清理空队列后仍可正常提问。[逐轮结果](evidence/2026-09-05-cli-tui-repairs/questions-results.json)、[503 live 帧](evidence/2026-09-05-cli-tui-repairs/live-tui/fixture-final/question-5.txt)、[空闲队列后提问](evidence/2026-09-05-cli-tui-repairs/live-tui/fixture-final/idle-queue-question.txt)。
- **退出与恢复**：七轮完成后 `/quit` exit 0，立即 `--continue` 正常重放历史，无 owner_connect_failed 或 recovery-required 阻塞；再次 `/quit` exit 0。保留会话为 paused，owner 为 unowned，活跃 owner 数量为 0。[状态](evidence/2026-09-05-cli-tui-repairs/exit-state.json)、[重放帧](evidence/2026-09-05-cli-tui-repairs/live-tui/fixture-final/resumed.txt)。
- **TDD**：terminal-only error/abort 先 2 项失败；ledger/queue 空闲状态、active attach 各先出现预期失败；EOF 回归先观察到 driver 未释放及 attachment 数未减；CLI、布局与 capability 由子 Agent 分别 RED→GREEN。最终 controller/steering 2 files / 28 tests；生命周期相邻回归 5 files / 62 tests，包含真实远端窗口保活；CLI focused 5 files / 71 tests。[controller](evidence/2026-09-05-cli-tui-repairs/controller-final-green.log)、[生命周期](evidence/2026-09-05-cli-tui-repairs/runtime-focused.log)、[CLI 交接](evidence/2026-09-05-cli-tui-repairs/cli/repair-summary.md)。

- **最终构建与静态检查**：`npm run build`、`npm run check` 均 exit 0；完整 check 含 Rust 12 tests、576 个 consumer 的 typecheck 覆盖检查及所有边界检查。[构建](evidence/2026-09-05-cli-tui-repairs/build-final.log)、[完整 check](evidence/2026-09-05-cli-tui-repairs/check-final-layout.log)。
- **最终 80×24**：模型增加 context footer 行时仍显示 Harness、Welcome 标题、快捷键与 `think:off`；`/plan` 显示 inactive；不可用命令显示明确说明。最终重建仅改变本轮候选中的 `dist/tui/interactive-mode.js`，CLI/runtime 产物摘要保持一致。[首屏](evidence/2026-09-05-cli-tui-repairs/live-tui/fixture-narrow-final/startup.txt)、[最终产物摘要](evidence/2026-09-05-cli-tui-repairs/candidate-final-digests.json)、[布局交接与 RED/GREEN](evidence/2026-09-05-cli-tui-repairs/tui/handoff.md)。

- **完整默认测试**：`npm test` exit 0，Vitest 486 files / 3046 tests；Bun 21 files / 144 tests / 1065 assertions，全部通过。包含项目自身 multi-agent 两个集成套件 7 tests。测试清单建立后新增的 steering 套件及 active attach 三种状态由上面的最终 28 tests 补验，不重复计入此总数；默认 local 不包含独立 built-CLI smoke bucket，本轮另有真实 PATH CLI/TUI 矩阵。[完整日志](evidence/2026-09-05-cli-tui-repairs/test.log)、[数量与范围](evidence/2026-09-05-cli-tui-repairs/test-summary.json)。
- **收尾**：已停止本轮 loopback fixture 与全部独立 tmux server；原暂存 patch 保留，本任务没有创建 commit。[清理](evidence/2026-09-05-cli-tui-repairs/cleanup.json)、[Git 边界](evidence/2026-09-05-cli-tui-repairs/scope-verification.json)。

### 6.4 保留边界

- worktree、compaction、context、memory/remember、plan mutation，以及 CLI plugin.inspect/mcp.inspect 的当前 Session Owner 能力缺口仍然存在；这轮修复了错误路由、错误成功码及无说明入口，没有启动独立后端能力实现专项。
- 外部模型连通性/认证、真人暗亮主题、真实 IME、macOS/Windows 验收仍 pending。tmux 的 UTF-8 输入和原生自动渲染测试不等于人工验收。
- 本轮重放额外观察到 Bash 摘要卡片显示 `(no output)`，后续 assistant 工具结果正文仍有 `audit-ok / EXIT: 0`。这是工具卡片重放的独立展示问题，未作为退出或执行失败；本轮没有扩展到该投影专项，保留在 [重放帧](evidence/2026-09-05-cli-tui-repairs/live-tui/fixture-final/resumed.txt) 供后续定位。
