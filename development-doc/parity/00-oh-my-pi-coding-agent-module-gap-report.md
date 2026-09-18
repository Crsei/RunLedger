# oh-my-pi `coding-agent/src` 模块对照与缺口报告

> 基线日期：2026-09-18（调查时点）。
> 上游快照：`oh-my-pi` `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`（2026-09-17），`packages/coding-agent` 版本 `18.2.4`。
> 目标快照：RunLedger 工作树，分支 `rollback/before-composer-shape`，HEAD `0b2c501b194e0a65d80741dfe650814ea9de42dc`（含未提交改动）。
> 本文是**对照事实记录**，不是实施计划，也不改变任何模块的 authority。阶段状态仍查各专题入口。
>
> **快照推进（2026-09-18 补记）**：本文全部结论固定在目标快照 `0b2c501b`。此后工作树已前进，其中 `30fd103`（`feat(websource): port oh-my-pi web module with web_search tool`）落地 `src/websource/`（131 文件），**关闭 §3 #6（`web/`）与 §3 #7（`exa/`）**；`a8e9951` 落地 web 看板，`69ac184` 落地 goal 首轮与持久暂停。§3 的编号保持稳定（外部文档按编号引用），关闭项在行内标注而不删除。复核当前状态请按 §7 命令重新生成事实，**不要在本文结论上增量推测**。

本报告回答一个问题：**以 oh-my-pi 的 `packages/coding-agent/src` 为口径，RunLedger 缺哪些模块。**

---

## 0. 引用约定

- 上游路径统一相对 `oh-my-pi/packages/coding-agent/src/`，写作 `src/<module>/<file>`。
- 上游仓库位置（本机）：`../oh-my-pi`（与 `RunLedger` 同级）。
- RunLedger 路径统一相对 `RunLedger/`，写作 `src/<module>/<file>`。
- 上游同名兄弟包（`packages/agent`、`packages/ai`、`packages/tui`、`packages/catalog`、`packages/stats`、`packages/mnemopi`、`packages/metaharness` 等）**不在本次口径内**；凡是 RunLedger 的对等物实际对应兄弟包的地方，已在正文标注，避免误判为缺口。
- 「文件数」均为递归计数（含子目录与资源文件），由 §7 复现命令生成。

## 1. 方法与证据规则

1. **不做目录名对照。** 两侧布局不同构：上游是 62 个平铺能力目录 + 15 个根文件；RunLedger 按领域收敛为 `runtime/`、`tui/`、`extensions/`、`storage/`、`security/`、`web/` 等 18 个顶层目录。同名文件仅 16 个，路径相等率不足以支撑结论。
2. 每个模块按「读上游入口导出 → 在 RunLedger 内检索对应符号/路径 → 定位实现文件」三步判定。
3. 状态闭集：`full`（核心面已具备）/ `partial`（有对等物但缺口明确）/ `absent`（`src/` 内无任何实现）。
4. `absent` 需对至少两个可能命名做过检索；文档提及、计划条目、类型占位**不算实现**，一律在备注中区分。
5. 全仓检索命中一律人工核对语义，剔除同名噪声（例：RunLedger 的 `security/` 是权限/沙箱面，不是上游 `src/security/` 的安全审查平台；`web/` 两侧同名不同物）。

## 2. 规模总览

| 指标 | 上游 | RunLedger |
|---|---|---|
| 顶层条目 | 77（62 目录 + 15 根文件） | 33 |
| `src/` 文件总数 | 1762 | 1115 |
| `.md` 资源（提示词/规则） | 244 | 0 |
| 同名同路径文件 | — | 16 |

判定分布（按目标快照 `0b2c501b`）：`full` 6 项、`partial` 39 项、`absent` 33 项（详见 §3–§5）。其中 §3 #6、#7 已在后续提交 `30fd103` 关闭，见文首快照推进说明。

## 3. 完全缺失（`absent`）

下表每一项都在 RunLedger `src/` 内做过符号与路径双向检索且 0 命中。`omp 位置` 列出该模块的入口与代表性文件，便于直接复核。

| # | 模块 | 文件数 | omp 位置（相对 `src/`） | 上游能力 | RunLedger 现状 |
|---|---|---|---|---|---|
| 1 | `tts/` | 12 | `tts/index.ts`、`tts/tts-client.ts`、`tts/tts-worker.ts`、`tts/vocalizer.ts`、`tts/speakable.ts`、`tts/streaming-player.ts`、`tts/speech-enhancer.ts`、`tts/downloader.ts`、`tts/models.ts`、`tts/wav.ts` | 语音合成：worker 子进程、本地模型下载、可朗读流分段、音频播放 | 无。仅 provider catalog 把 tts/audio 模型排除出 chat 列表（如 `src/providers/nanogpt.ts`、`src/providers/siliconflow.ts`），不是实现 |
| 2 | `stt/` | 10 | `stt/index.ts`、`stt/stt-controller.ts`、`stt/asr-client.ts`、`stt/asr-worker.ts`、`stt/endpointer.ts`、`stt/sherpa-runtime.ts`、`stt/submit-trigger.ts`、`stt/models.ts`、`stt/downloader.ts`、`stt/asr-protocol.ts` | 语音输入：ASR worker、断点检测、麦克风采集、提交触发 | 无。命中仅为模型名过滤（`src/providers/alibaba-token-plan.ts` 的 `fun-asr` 前缀） |
| 3 | `live/` | 8 | `live/controller.ts`、`live/transport.ts`、`live/protocol.ts`、`live/voices.ts`、`live/visualizer.ts`、`live/attestation.ts`、`live/prompts/live-instructions.md`、`live/prompts/agent-final-message.md` | 实时语音会话：双向传输、音色目录、音频可视化 | 无。`src/web/live-trajectory.ts` 是只读看板投影，同名不同物 |
| 4 | `collab/` | 9 | `collab/host.ts`、`collab/guest.ts`、`collab/relay-client.ts`、`collab/registry.ts`、`collab/controller.ts`、`collab/crypto.ts`、`collab/protocol.ts`、`collab/replication-shrink.ts`、`collab/display-name.ts` | 多人共享会话：relay、host/guest 握手、room key、能力注册、guest 提示注入 | 无。`packages/collab-web/README.md` 明确记载只取浏览器 UI、不迁移 relay/room key/pi-wire 写模型；`src/runtime/session-server/` 是单机 owner-fenced 多客户端，不是多人协作 |
| 5 | `irc/` | 1 | `irc/bus.ts` | 进程级 agent 邮箱：`IrcMessage`、投递回执（injected/woken/revived）、parked agent 复活、`replyTo` 关联 | 无。`src/runtime/agents/spawn-tool.ts` 是一次性 spawn→report，无邮箱/寻址/唤醒 |
| 6 | `web/` | 116 | `web/search/index.ts`、`web/search/provider.ts`、`web/search/query.ts`、`web/search/render.ts`、`web/search/providers/*.ts`（27 家）、`web/scrapers/*.ts`（76 个站点）、`web/firecrawl.ts`、`web/kagi.ts`、`web/parallel.ts` | 统一 `web_search` 工具：多 provider 检索 + 结构化站点 scraper | 无 web 检索。`src/runtime/tools/web-fetch.ts` 只是受治裸 GET + 正则去标签。<br>🔵 **已关闭（2026-09-18，`30fd103`）**：`src/websource/`（131 文件）已移植检索管线 + 19 个 provider + 74 个 scraper handler + 共享 client + `internal/{dom,turndown}`，并注册 `web_search` 工具。缺口出处与落地事实见 [`plan/18`](../plan/18-omp-web-capability-port-plan.md)（其 §11.4 记录 Tier C 5 个 provider、真实外部检索、PDF 全文、浏览器兜底仍未闭合）。 |
| 7 | `exa/` | 3 | `exa/index.ts`、`exa/mcp-client.ts`、`exa/types.ts` | Exa MCP 客户端与动态工具包装、websets | 无。通用 MCP host 可挂用户自备 Exa server，但不含集成代码。<br>🔵 **已关闭（2026-09-18，`30fd103`）**：`src/websource/exa/` 已移植，作为 `exa` provider 的 keyless 兜底；按 [`plan/18`](../plan/18-omp-web-capability-port-plan.md) §11.3 偏差 4，只保留检索路径消费的 `isSearchResponse`/`normalizeExaMcpPayload`，未移植「从 MCP schema 动态生成 CustomTool」部分。 |
| 8 | `blob-broker/` | 26 | `blob-broker/service.ts`、`blob-broker/store.ts`、`blob-broker/broker.ts`、`blob-broker/daemon.ts`、`blob-broker/exposure.ts`、`blob-broker/destinations.ts`、`blob-broker/uploaders*.ts`（7）、`blob-broker/provider-files-*.ts`、`blob-broker/savings.ts`、`blob-broker/context-images.ts`、`blob-broker/publication.ts` | 图片/blob 托管：URL 铸造、出口隧道、上传目的地、provider 文件上传、内联→URL 兜底 | 无。`src/images.ts` 只做图片**生成** API 分发 |
| 9 | `markit/` | 9 | `markit/registry.ts`、`markit/converters/pdf/index.ts`、`markit/converters/docx.ts`、`markit/converters/pptx.ts`、`markit/converters/xlsx.ts`、`markit/converters/epub.ts`、`markit/types.ts`、`markit/NOTICE` | PDF/DOCX/PPTX/XLSX/EPUB → Markdown 转换 | 🟡 **部分关闭（2026-09-18）**：`read-office.ts` 通过受治理 `read` 接入 DOCX/PPTX/XLSX/EPUB 的 Buffer → Markdown 路径，复用受限 ZIP/XML 和既有 Turndown，不写图片或 raw fs；不是独立 markit API。PDF 仍依赖 native `pdf-inspector`，按 Plan 19/20 保持非目标。 |
| 10 | `commit/` | 65 | `commit/pipeline.ts`、`commit/execute.ts`、`commit/conventional/*`、`commit/agentic/*`（含 `commit/agentic/tools/*`、`commit/agentic/prompts/*`）、`commit/changelog/*`、`commit/git/diff.ts`、`commit/analysis/*`、`commit/prompts/*`、`commit/cli.ts` | 提交信息生成：conventional 归一/校验、map-reduce diff 摘要、agentic 流程、changelog | 无。CLI 帮助与 `src/tui/commands/registry.ts` 均无 `commit` |
| 11 | `export/` | 13 | `export/share.ts`、`export/custom-share.ts`、`export/html/index.ts`、`export/html/template.*`、`export/html/vendor/*`、`export/html/web-palette.ts`、`export/ttsr.ts` | 会话分享（AES-256-GCM 密封上传）、独立 HTML 查看器导出、TTSR 流规则 | 无。`/dump` 是请求快照调试产物，不是导出；web 看板仅本地只读 |
| 12 | `if-bench/` | 8 | `if-bench/index.ts`、`if-bench/runner.ts`、`if-bench/board.ts`、`if-bench/actions.ts`、`if-bench/protocol.ts`、`if-bench/prompts/*.md` | 指令遵循/工作记忆基准（`nya{1,N}` 指令轮换） | 无。`development-doc/bench/` 是**另一件事**（任务级评测中台，全部 `planned`），不覆盖模型级 bench |
| 13 | `autoresearch/` | 15 | `autoresearch/index.ts`、`autoresearch/storage.ts`、`autoresearch/git.ts`、`autoresearch/state.ts`、`autoresearch/dashboard.ts`、`autoresearch/tools/*.ts`、`autoresearch/prompt*.md` | 实验/优化模式：SQLite 记录、`autoresearch/*` 基线分支、指标日志、看板 | 无。`/loop` 只是同 prompt 重复执行 |
| 14 | `cleanse/` | 11 | `cleanse/index.ts`、`cleanse/checkers.ts`、`cleanse/parsers.ts`、`cleanse/loop.ts`、`cleanse/board.ts`、`cleanse/agent.ts`、`cleanse/balance.ts`、`cleanse/prompts/*.md` | 诊断发现 → 有界批量修复 → 验证 | 无。`runtime/agents` 是通用 child 委派，不是 detect→repair→verify 循环 |
| 15 | `advisor/` | 10 | `advisor/index.ts`、`advisor/runtime.ts`、`advisor/config.ts`、`advisor/watchdog.ts`、`advisor/advise-tool.ts`、`advisor/emission-guard.ts`、`advisor/loop-guard.ts`、`advisor/transcript-recorder.ts`、`advisor/delta-split.ts`、`advisor/message-fingerprint.ts` | 顾问团：`WATCHDOG.yml` 声明、并行观察主 transcript、建议工具、发话预算与循环护栏 | 无。全仓 `advisor|watchdog.yml` 仅 1 处无关命中 |
| 16 | `autolearn/` | 2 | `autolearn/controller.ts`、`autolearn/managed-skills.ts` | 自动学习：托管 skills 目录/provider、回合后合成捕获 turn、`learn`/`manage_skill` | 无。`src/extensions/skills/` 只做人工创作 skill 的发现/信任/来源 |
| 17 | `auto-thinking/` | 1 | `auto-thinking/classifier.ts` | `auto` 思考等级的 per-prompt 难度分类 | 无。`src/types.ts` 的 `ThinkingLevel` 无 `auto` 成员 |
| 18 | `judgment/` | 1 | `judgment/index.ts` | 统一 `Judge`：TypeSafe / 本地 tiny / online 三档后端 | 无。全仓 `typesafe` 0 命中；它也是 17 的上游前置 |
| 19 | `mnemopi/` | 7 | `mnemopi/index.ts`、`mnemopi/backend.ts`、`mnemopi/state.ts`、`mnemopi/config.ts`、`mnemopi/embed-client.ts`、`mnemopi/embed-worker.ts`、`mnemopi/embed-protocol.ts` | 向量/embedding 记忆后端 | 无。检索为纯词法（`src/runtime/context/memory/store.ts` 的 `mode: "lexical"`），schema 里的 `vector` 字面量无生产者。同级 `packages/mnemopi` 亦未接入 |
| 20 | `hindsight/` | 10 | `hindsight/index.ts`、`hindsight/backend.ts`、`hindsight/client.ts`、`hindsight/bank.ts`、`hindsight/mental-models.ts`、`hindsight/content.ts`、`hindsight/transcript.ts`、`hindsight/config.ts`、`hindsight/state.ts`、`hindsight/seeds.json` | 外部记忆服务（bank、mental models、transcript 摄取） | 无。`hindsight|mentalModel` 0 命中 |
| 21 | `security/` | 20 | `security/index.ts`、`security/coordinator.ts`、`security/preflight.ts`、`security/publication.ts`、`security/provenance.ts`、`security/remediation.ts`、`security/comparison.ts`、`security/sarif.ts`、`security/store.ts`、`security/cloud.ts`、`security/auth.ts`、`security/contracts/*.ts`、`security/importers/*.ts`、`security/resource-output.ts` | **安全审查平台**：扫描计划/目标、findings/severity schema、SARIF 导入导出、cloud producer、codex-security 导入、修复与发布 | 无。⚠️ RunLedger `src/security/` 是权限/沙箱/ExecutionGateway，对应上游的 permission/sandbox 面，**不是**本项。全仓 `sarif|remediation|provenance-scan` 均无实现命中 |
| 22 | `compress/` | 7 | `compress/index.ts`、`compress/session.ts`、`compress/protocol.ts`、`compress/types.ts`、`compress/prompts/{request,review,system}.md` | `omp compress`：把文本文件改写为稠密 prompt register 的 CLI（rewrite/approve 双工具协议） | 无。⚠️ 这不是上下文压缩；压缩对等物见 §5 |
| 23 | `speculation/` | 1 | `speculation/host.ts` | 推测执行 host：读快照、提交/丢弃授权、证据摘要 | 无。`Speculative*` 0 命中；副作用仍全走 ExecutionGateway + owner fence |
| 24 | `eval/` | 52 | `eval/index.ts`、`eval/kernel-base.ts`、`eval/executor-base.ts`、`eval/kernel-session-registry.ts`、`eval/preludes.ts`、`eval/completion-bridge.ts`、`eval/judgment-bridge.ts`、`eval/handle-bridge.ts`、`eval/budget-bridge.ts`、`eval/agent-bridge.ts`、`eval/py/*`（`kernel.ts`、`executor.ts`、`runner.py`、`prelude.py`）、`eval/js/*`（`worker-core.ts`、`context-manager.ts`、`speculation.ts`）、`eval/speculation/*` | 模型侧 Python/JS 代码执行内核与桥接 | 无。无 pyodide/jupyter/node:vm 痕迹；`src/runtime/tools/notebook-edit.ts` 编辑 notebook 但不执行模型代码 |
| 25 | `dap/` | 6 | `dap/index.ts`、`dap/client.ts`、`dap/session.ts`、`dap/config.ts`、`dap/defaults.json`、`dap/types.ts` | Debug Adapter Protocol 客户端与会话、断点/栈帧/线程 | 无。`DebugAdapter|SetBreakpoints|debugpy` 0 命中 |
| 26 | `ssh/` | 5 | `ssh/connection-manager.ts`、`ssh/sshfs-mount.ts`、`ssh/file-transfer.ts`、`ssh/config-writer.ts`、`ssh/utils.ts` | SSH 连接复用、sshfs 挂载生命周期、scp/sftp 传输 | 无。全仓 ssh 0 命中；`runtime/contracts/ports.ts` 只有 `RemoteExecutorPort` 声明名，无传输实现 |
| 27 | `internal-urls/` | 22 | `internal-urls/index.ts`、`internal-urls/router.ts`、`internal-urls/parse.ts`、`internal-urls/registry-helpers.ts`、`internal-urls/types.ts`，以及 `memory-protocol.ts`、`mcp-protocol.ts`、`history-protocol.ts`、`xd-protocol.ts`、`vault-protocol.ts`、`rule-protocol.ts`、`local-protocol.ts`、`issue-pr-protocol.ts`、`agent-protocol.ts`、`artifact-protocol.ts`、`ssh-protocol.ts`、`skill-protocol.ts`、`security-protocol.ts`、`omp-protocol.ts`、`docs-index.ts`、`filesystem-resource.ts`、`json-query.ts` | 内部 URL 路由与各 scheme 处理器 | 无。11 个 scheme 在 `src/` 内全部 0 命中；plan 产物走专用 `src/runtime/modes/plan/artifact-store.ts` 而非 URI 命名空间 |
| 28 | `debug/` | 11 | `debug/index.ts`、`debug/profiler.ts`、`debug/log-viewer.ts`、`debug/log-formatting.ts`、`debug/report-bundle.ts`、`debug/raw-sse.ts`、`debug/raw-sse-buffer.ts`、`debug/remote-debugger.ts`、`debug/protocol-probe.ts`、`debug/system-info.ts`、`debug/terminal-info.ts` | 调试菜单、CPU profile、日志查看、原始 SSE、远程调试、报告打包 | 无 `src/debug/`。只有 `--debug`/`RUNLEDGER_DEBUG=1` stderr 与 `/dump` 请求快照 |
| 29 | `telemetry-export.ts` | 1 | `telemetry-export.ts` | OTEL 引导：`OTEL_*` 解析、provider 注册、flush | 无实现。仅 `src/runtime/contracts/ports.ts` 的 `TelemetryExporterPort` 被动类型；`docs/subsystems/trace.md` 明确不含 OTLP |
| 30 | `telemetry-export-otlp.ts` | 1 | `telemetry-export-otlp.ts` | OTLP trace/log/metric provider 实现 | 无。`development-doc/runtime/trace/phase-04-opik-exporter-tree.md` 标 `planned` |
| 31 | `cursor.ts` + `cursor-bridge-tools.ts` | 2 | `cursor.ts`、`cursor-bridge-tools.ts` | Cursor agent 协议 exec 桥、MCP 资源/调用帧、todo 快照同步、参数归一 | 无。命中均为无关标识符（`eventCursor`、`outputCursor`、`safeCursor`） |
| 32 | `workspace-tree.ts` | 1 | `workspace-tree.ts` | 层级工作区树 + AGENTS.md 收集，注入系统提示 | 无。`src/runtime/tools/ls.ts` 是平铺 `readdir`；系统提示只带 cwd JSON 与 AGENTS.md 文本 |
| 33 | `priority.json` + `startup-splash.ts` | 2 | `priority.json`、`startup-splash.ts` | smol/slow 模型别名优先级表；启动 splash 门控 | 无。模型默认由 settings 的 `provider`/`model`/`enabledModels` 决定；启动 UX 是无条件 `src/tui/components/welcome.ts` |

## 4. 部分缺失（`partial`）

`omp 位置` 列同上；`RL 对等物` 是 RunLedger 内的实际实现文件；`缺口` 只列**上游有、RunLedger 无**的部分。

| 模块 | 文件数 | omp 位置（入口/代表） | RL 对等物 | 缺口 |
|---|---|---|---|---|
| `session/` | 84 | `session/agent-session.ts`、`session/session-manager.ts`、`session/session-maintenance.ts`、`session/turn-recovery.ts`、`session/streaming-output.ts`、`session/session-tools.ts`、`session/session-stats.ts`、`session/ttsr-coordinator.ts`、`session/session-advisors.ts` | `src/runtime/session-runtime/*`（60 文件）、`src/runtime/session-server/*`、`src/runtime/session-owner/*`、`src/storage/session-store/*` | 无 `turn-recovery` 重放编排（只有 `recovery-barrier.ts`/`attempt-controller.ts` 屏障半套）、`session-maintenance`（length-stop 恢复、snapcompact）、`session-tools` 工具面装配、`session-pins`、`btw-history`、`ttsr-coordinator`、`session-advisors`、`redis-session-storage`、`foreign-session-*`（claude/codex 导入）、`acp-permission-gate`、`exit-diagnostics`、`yield-queue`/`tool-choice-queue`/`queued-messages`/`prewalk` |
| `registry/` | 3 | `registry/agent-registry.ts`、`registry/agent-lifecycle.ts`、`registry/persisted-agents.ts` | `src/runtime/agents/graph-store.ts`、`src/runtime/agents/supervisor.ts`、`src/runtime/agents/graph-projection.ts` | 无进程级 id 寻址名册：无 `MAIN_AGENT_ID`、无 running/idle/parked/aborted 状态、无 tombstone、无 `persisted-agents` 复活名册 |
| `async/` | 3 | `async/index.ts`、`async/job-manager.ts`、`async/auto-background.ts` | `src/runtime/process/manager.ts`、`src/runtime/process/wait-coordinator.ts`、`src/storage/process/completion-queue.ts` | 无 `AsyncJobManager`（job 行/并发配额/保留窗口/结果消费驱逐/dead-letter 重试）、无自动转后台策略（60s 阈值 + 结算竞态）、无 wait ladder |
| `launch/` | 11 | `launch/broker.ts`、`launch/client.ts`、`launch/protocol.ts`、`launch/ensure.ts`、`launch/presence.ts`、`launch/paths.ts`、`launch/terminal-output-worker.ts` | `src/runtime/host/*`、`src/storage/host/*`、`src/runtime/session-server/*`、`src/cli/runtime-host-production.ts` | 无通用 daemon broker：无 `DaemonSpec` 协议、presence/meta 文件、per-daemon 空闲宽限与重启退避、terminal-output worker、共享单例（Chromium/browser relay/LSP mux）的 ensure/adopt |
| `subprocess/` | 2 | `subprocess/worker-client.ts`、`subprocess/worker-runtime.ts` | 仅 `src/security/permission/bash-ast/parser.ts` + `worker.ts`（node:worker_threads 池） | 无通用 `WorkerHandle`/`spawnWorkerOrUnavailable`/`createUnavailableWorker`/`workerEnvFromParent`/smokeTest 探针/worker-runtime 子侧引导 |
| `activity/` | 1 | `activity/index.ts` | `src/runtime/agents/graph-projection.ts`、`src/tui/agents/types.ts`、`src/tui/interactive/agent-workflow.ts` | 无 `AgentActivityRow` 索引：无 response/tool/irc/lifecycle 行、无跨 agent feed、无 byte-offset transcript tail、无 live 进度行、无 search/before 游标查询 |
| `stats/` | 3 | `stats/activity-protocol.ts`、`stats/activity-client.ts`、`stats/activity-worker.ts` | `src/runtime/usage/index.ts`、`src/web/usage.ts`、`src/web/usage-projection.ts` | 无 `DailyActivityPoint` 热力图管线与一次性 stats 子进程协议/client/worker；RunLedger 是进程内增量扫描 |
| `tools/` | 159 | `tools/index.ts`、`tools/read.ts`、`tools/write.ts`、`tools/todo.ts`、`tools/yield.ts`、`tools/xdev.ts`、`tools/ast-grep.ts`、`tools/ast-edit.ts`、`tools/ask.ts`、`tools/eval.ts`、`tools/debug.ts`、`tools/gh.ts`、`tools/image-gen.ts`、`tools/run-code.ts`、`tools/security-scan.ts`、`tools/checkpoint.ts`、`tools/think.ts`、`tools/review.ts`、`tools/computer.ts`、`tools/browser.ts`、`tools/sqlite-reader.ts`、`tools/read-pdf.ts`、`tools/read-archive.ts`、`tools/memory-recall.ts`、`tools/browser/*`、`tools/computer/*`、`tools/eval-format/*`、`tools/hub/*`、`tools/puppeteer/*` | 基线：`src/runtime/tools/*`（26 文件）、`src/lsp/tool.ts`。当前含 `checkpoint.ts`、`rewind.ts`、`ask.ts`、`github.ts` 与 `manage-skill.ts`；其中 `read-sqlite.ts`、`read-archive.ts` 是 `read` 的类型分支 helper | 基线的「约 80」只适用于 `0b2c501b`，不是当前精确计数。已关闭 `ask`、`checkpoint`/`rewind`、`manage_skill` 及 `read` sqlite/archive 分支；`web_search` 与 GitHub 只读查询均由受治理 network 条件注册。仍无对等物的代表项包括写 GitHub、`browser`/`computer`、`eval`/`run-code`、memory 四件套、`learn`、`report-tool-issue` 与 `vibe`。`read-summary`、`shell-tokenize`、`tool-timeouts`、`render-utils` 是支撑实现，不应按独立模型工具计数。 |
| `task/` | 31 | `task/executor.ts`、`task/isolation-runner.ts`、`task/isolation-ownership.ts`、`task/worktree.ts`、`task/structured-subagent.ts`、`task/persisted-revive.ts`、`task/output-manager.ts`、`task/result-summary.ts`、`task/render.ts`、`task/workpool.ts`、`task/parallel.ts`、`task/spawn-policy.ts` | `src/runtime/tasks/types.ts`、`src/runtime/agents/*`（12 文件） | 无 `executor.ts` 等价、无 worktree 子代理隔离与 merge、无 `workpool`/`parallel` 批处理、无 `structured-subagent`/`result-summary`/`persisted-revive`/`output-manager`/`render` |
| `exec/` | 4 | `exec/bash-executor.ts`、`exec/direnv.ts`、`exec/non-interactive-env.ts`、`exec/exec.ts` | `src/runtime/tools/bash.ts`、`src/runtime/execution-env.ts`、`src/runtime/process/manager.ts`、`src/storage/process/node-pty-adapter.ts` | 无 `direnv` 环境加载、无 `non-interactive-env` 构造（CI 环境剥离）、无原生化 brush-core Shell 快照/minimizer |
| `edit/` | 10 | `edit/index.ts`、`edit/auto-repair.ts`、`edit/renderer.ts`、`edit/normalize.ts`、`edit/schemas.ts`、`edit/store.ts`、`edit/blackbox.ts`、`edit/hashline-compact.md` | `src/runtime/tools/edit.ts`、`src/runtime/tools/multi-edit.ts` | 无 `auto-repair` 自愈重试、无多模式 schema（hashline/patch）、无 `normalize`/`blackbox`/`store`/`renderer` |
| `lsp/` | 25 | `lsp/client.ts`、`lsp/tool.ts`、`lsp/writethrough.ts`、`lsp/servers.ts`、`lsp/diagnostics.ts`、`lsp/workspace-diagnostics.ts`、`lsp/deferred-diagnostics.ts`、`lsp/diagnostics-ledger.ts`、`lsp/format-options.ts`、`lsp/render.ts`、`lsp/startup-events.ts`、`lsp/lspmux.ts`、`lsp/mux/{protocol,server,daemon}.ts`、`lsp/defaults.json`、`lsp/clients/*` | `src/lsp/*`（11 文件，含 `src/lsp/client.ts`、`src/lsp/tool.ts`、`src/lsp/config.ts`、`src/lsp/transport.ts`、`src/lsp/edits.ts`、`src/lsp/clients/*`） | 无 `writethrough`（写穿格式化）、无 `lsp/mux/` 共享传输与 `lspmux`、无 `servers` 动态注册、无 workspace/glob 诊断与诊断账本、无 `format-options`/`render`/`startup-events` |
| `mcp/` | 26 | `mcp/manager.ts`、`mcp/tool-bridge.ts`、`mcp/oauth-flow.ts`、`mcp/oauth-discovery.ts`、`mcp/oauth-credentials.ts`、`mcp/smithery-*.ts`、`mcp/config-writer.ts`、`mcp/tool-cache.ts`、`mcp/timeout.ts`、`mcp/json-rpc.ts`、`mcp/errors.ts`、`mcp/request-id.ts`、`mcp/render.ts`、`mcp/startup-events.ts`、`mcp/transports/*` | `src/extensions/mcp/{sdk-factory,connection-manager,config,types}.ts`、`src/extensions/integration/runtime-mcp-adapter.ts`、`src/cli/runtime-host-mcp.ts` | 无 MCP 专用 OAuth+DCR、无 Smithery 三件套、无 `config-writer`（`config.ts` 只读）、无 tool-cache/errors 分类/request-id/render/startup-events；transports 由官方 SDK 取代（合理） |
| `discovery/` | 55 | `discovery/index.ts`、`discovery/builtin.ts`、`discovery/agent-plugin-format.ts`、`discovery/claude-plugins.ts`、`discovery/opencode.ts`、`discovery/windsurf.ts`、`discovery/omp-plugins.ts`、`discovery/cursor.ts`、`discovery/cline.ts`、`discovery/gemini.ts`、`discovery/vscode.ts`、`discovery/github.ts`、`discovery/mcp-json.ts`、`discovery/at-imports.ts`、`discovery/agents-md.ts`、`discovery/claude-md.ts`、`discovery/builtin-rules/*` | `src/extensions/skills/providers/*`（15 个 provider）、`src/extensions/paths.ts`、`src/extensions/plugins/manager.ts`、`src/extensions/plugins/marketplace/*` | 只有 skills/plugins/marketplace 的 provider。缺 `cursor`/`cline`/`windsurf`/`opencode`/`gemini`/`vscode`/`github` 适配器、`.mcp.json` 导入、`at-imports`、`builtin-rules/` 规则包、`agent-plugin-format`、`claude-md`/`agents-md` 上下文文件 provider、`ssh`。AGENTS.md 目前是硬编码两文件读取 |
| `extensibility/` | 57 | `extensibility/extensions/{loader,runner,wrapper,managed-timers,types}.ts`、`extensibility/extensions/index.ts`、`extensibility/plugins/*`、`extensibility/custom-tools/*`、`extensibility/custom-commands/*`、`extensibility/hooks/*`、`extensibility/skills.ts`、`extensibility/slash-commands.ts`、`extensibility/tool-proxy.ts`、`extensibility/legacy-pi-*.ts` | `src/extensions/*`（plugins/skills/hooks/actions/tools/host/capabilities）、`src/contracts/extensions/*` | 无**进程内** TS/JS 扩展模块加载（RL 只有 out-of-process host）、无 legacy-pi 兼容 shim、无 `extensibility/custom-tools/`+`extensibility/custom-commands/` 一等目录、无 `tool-proxy`/`shared-events`；Hook 事件仅 5 个（上游约 40） |
| `capability/` | 18 | `capability/index.ts`、`capability/rule.ts`、`capability/rule-buckets.ts`、`capability/prompt.ts`、`capability/instruction.ts`、`capability/context-file.ts`、`capability/fs.ts`、`capability/ssh.ts`、`capability/system-prompt.ts`、`capability/tool.ts`、`capability/skill.ts`、`capability/hook.ts`、`capability/extension.ts`、`capability/extension-module.ts`、`capability/settings.ts`、`capability/slash-command.ts`、`capability/mcp.ts` | `src/extensions/capabilities/{registry,types}.ts`、`src/extensions/skills/registry.ts`、`src/runtime/resources/types.ts` | 无类型化 capability 分类：缺 `rule`/`rule-buckets`、`prompt`、`instruction`、`context-file`、`fs`、`ssh`、`system-prompt`、`extension-module`。RL 的 `ResourceKind` 只到 plugin/skill/hook/mcp-server/mcp-tool，且通用 registry 仍是 passive |
| `modes/` | 320 | `modes/acp/*`（6）、`modes/rpc/*`（10）、`modes/setup-wizard/*`（14）、`modes/components/*`（112）、`modes/controllers/*`（18）、`modes/theme/*`（11）、`modes/print-mode.ts`、`modes/composer.ts`、`modes/ultrathink.ts`、`modes/turn-budget.ts`、`modes/magic-keywords.ts`、`modes/macos-spelling.ts` | `src/tui/*`（179 ts）、`src/tui/components/*`（28）、`src/tui/theme/*`（5）、`src/tui/interactive/*`（16）、`src/runtime/modes/*` | 无 ACP server mode（全仓 acp 0 命中）、无 RPC mode、无 `modes/setup-wizard/`+启动 splash、无 `print-mode`（由 `src/cli/headless.ts` 部分替代）、无 `ultrathink`/`turn-budget`/`magic-keywords`/`macos-spelling`；组件 28 vs 112；无 composer/attachments、各类 autocomplete、gradient-highlight |
| `cli/` | 78 | `cli/worktree-cli.ts`、`cli/usage-cli.ts`、`cli/update-cli.ts`、`cli/plugin-cli.ts`、`cli/models-cli.ts`、`cli/git-tui/*`、`cli/read-cli.ts`、`cli/gc-cli.ts`、`cli/config-cli.ts`、`cli/render-cli.ts`、`cli/images-cli.ts`、`cli/stats-cli.ts`、`cli/ps-cli.ts`、`cli/ttsr-cli.ts`、`cli/ssh-cli.ts`、`cli/collab-cli.ts`、`cli/setup-cli.ts`、`cli/worker-selectors.ts`、`cli/profile-bootstrap.ts`、`cli/startup-cwd.ts`、`cli/completion-gen.ts` | `src/cli/*`（53 文件：`args.ts`、`main.ts`、`control-commands.ts`、`headless.ts`、`embedded-session-runtime.ts`、`runtime-host*.ts` 等） | 缺上列约 30 个入口。已具备的是会话启动/owner 接线子集 |
| `commands/` | 43 | `commands/launch.ts`、`commands/acp.ts`、`commands/bench.ts`、`commands/cleanse.ts`、`commands/collab.ts`、`commands/commit.ts`、`commands/compress.ts`、`commands/config.ts`、`commands/gc.ts`、`commands/git.ts`、`commands/images.ts`、`commands/models.ts`、`commands/plugin.ts`、`commands/ps.ts`、`commands/say.ts`、`commands/share.ts`、`commands/shell.ts`、`commands/ssh.ts`、`commands/stats.ts`、`commands/ttsr.ts`、`commands/update.ts`、`commands/usage.ts`、`commands/web-search.ts`、`commands/worktree.ts` | `src/cli/control-commands.ts`（13 个控制组）、`src/cli/main.ts`、`src/cli/{web,auth-gateway,migrate,workspace}-*.ts` | 上游约 44 个处理器，RL 有 5 个子命令 + 13 个控制组；其余处理器无对等物 |
| `slash-commands/` | 27 | `slash-commands/builtin-registry.ts`、`slash-commands/builtin-session.ts`、`slash-commands/builtin-modes.ts`、`slash-commands/builtin-marketplace.ts`、`slash-commands/builtin-collaboration.ts`、`slash-commands/builtin-lifecycle.ts`、`slash-commands/builtin-completions.ts`、`slash-commands/available-commands.ts`、`slash-commands/acp-builtins.ts`、`slash-commands/helpers/*` | `src/tui/commands/registry.ts`、`src/tui/commands/types.ts`、`src/tui/components/slash-command-popup.ts` | 无文件式/自定义 TS slash command、无 ACP 命令广播、无参数补全 builder、无 collab guest allowlist |
| `prompts/` | 186 | `prompts/system/*`、`prompts/tools/*`、`prompts/agents/{task,scout,reviewer,security-reviewer}.md`、`prompts/advisor/*`、`prompts/memories/*`、`prompts/bench/*`、`prompts/skills/*`、`prompts/steering/*`、`prompts/security/*`、`prompts/session/*`、`prompts/goals/*`、`prompts/system/personalities/*` | `src/runtime/harness-profiles/standard-prompt.ts`、`src/runtime/modes/{goal,plan}/prompt.ts`、`src/security/prompts/permissions-prompt.ts` | 上游 186 个 .md，RL `src/` 内 **0 个 .md**（提示词全部内联 TS）。缺 per-tool 提示词、agent 创建提示词、advisor/记忆抽取/bench/技能/steering/security 提示词、personalities、`.md` 加载与用户/项目覆盖机制 |
| `system-prompt.ts` | 1 | `system-prompt.ts` | `src/runtime/harness-profiles/standard-prompt.ts`、`src/runtime/session-runtime/standard-system-prompt.ts` | 缺模板装配、工具元数据投影、workspace tree 注入、skills/context-files/personality 块、多段 `systemPrompt: string[]`、`USER_APPEND_HEADING`、deadline racing |
| `config/` + `config.ts` | 24 | `config.ts`、`config/settings.ts`、`config/settings-schema.ts`、`config/model-registry.ts`、`config/model-resolver.ts`、`config/model-roles.ts`、`config/model-discovery.ts`、`config/model-patch.ts`、`config/custom-models.ts`、`config/service-tier.ts`、`config/prompt-templates.ts`、`config/config-file.ts`、`config/claude-paths.ts` | `src/storage/settings-manager.ts`、`src/models.ts`、`src/models-store.ts`、`src/model-catalog.ts`、`src/runtime/model-routing/*`、`src/providers/configured-proxy.ts` | 缺多厂商配置目录发现与走读（`~/.omp`/`~/.claude`/`~/.codex`/`~/.gemini` 及项目级；RL 只有单一 canonical home）、typed SettingPath 的 settings schema、`model-resolver` 角色别名（smol/slow）、`custom-models` 编辑 API、`model-patch`、serviceTier→family 映射 |
| `sdk.ts` | 1 | `sdk.ts` | `src/index.ts`、`src/extensions/api.ts`、`src/runtime/contracts/public.ts`、`src/cli/embedded-session-runtime.ts`、`src/cli/runtime-host-session.ts` | 无统一 `createAgentSession(options)`；缺 `discoverAuthStorage`/`discoverExtensions`/`discoverSkills`/`discoverContextFiles`/`discoverPromptTemplates`/`discoverSlashCommands`/`discoverMCPServers`、`buildSystemPrompt`、`customToolToDefinition` |
| `thinking.ts` | 1 | `thinking.ts` | `src/models.ts`、`src/cli/thinking-levels.ts`、`src/cli/args.ts`、`src/tui/thinking/types.ts`、`src/tui/interactive/model-workflow.ts` | 无 `inherit` 等级、无 label/description 元数据表（选择器只渲染通用文案）、无缩写解析（xhi/med）、无 Effort↔selector 映射 |
| `secrets/` | 8 | `secrets/index.ts`、`secrets/placeholder.ts`、`secrets/placeholder-scan.ts`、`secrets/message-transform.ts`、`secrets/obfuscator.ts`、`secrets/patterns.ts`、`secrets/regex.ts`、`secrets/replacement.ts` | `src/extensions/diagnostics.ts`、`src/auth-gateway/server.ts`、`src/runtime/context/compaction/history.ts`、`src/runtime/process/command-display.ts`、`src/runtime/trace/recorder.ts` | 只有 sink 局部正则脱敏。缺 per-install HMAC placeholder 铸造、provider 消息流改写与工具输出反混淆、`placeholder-scan`、`replacement`/`regex` 编译保护。**后果：粘进对话的密钥仍会发往 provider** |
| `memories/` | 2 | `memories/index.ts`、`memories/storage.ts` | `src/runtime/context/memory/{store,persistence,projection,types,schema}.ts`、`src/runtime/tools/plan-memory-tools.ts` | 有治理式 MemoryStore（proposal→approve→revoke + 词法检索），缺两阶段 rollout 抽取（stage1 认领/租约/退避）、全局 phase2 合并（watermark/lease/heartbeat）、SQLite memory DB 与 thread、citation 回填、污染防护、`/memory clear\|stats\|diagnose\|queue`、pre-compaction flush |
| `memory-backend/` | 9 | `memory-backend/index.ts`、`memory-backend/types.ts`、`memory-backend/resolve.ts`、`memory-backend/local-backend.ts`、`memory-backend/off-backend.ts`、`memory-backend/runtime.ts`、`memory-backend/redact.ts`、`memory-backend/messages.ts`、`memory-backend/tool-names.ts` | `src/runtime/context/memory/{store,types}.ts` | 无 `resolveMemoryBackend` 与 off/local/hindsight/mnemopi/sharpshooter 互斥选择、无 per-session `start`/`clear`/`enqueue` 生命周期、无 `buildDeveloperInstructions` 注入、无 `stats`/`diagnose`/`queuePreview`、无 `beforeAgentStartPrompt`/`preCompactionContext`、无记忆写入脱敏。`development-doc/plan-compact-memory/01-implementation-plan.md` §0.2 记为 `core partial / production unavailable` |
| `sharpshooter/` | 8 | `sharpshooter/index.ts`、`sharpshooter/extract.ts`、`sharpshooter/consolidate.ts`、`sharpshooter/queue.ts`、`sharpshooter/scheduler.ts`、`sharpshooter/backend.ts`、`sharpshooter/paths.ts`、`sharpshooter/types.ts` | `src/runtime/context/memory/store.ts`、`src/runtime/tools/plan-memory-tools.ts`、`src/tui/commands/registry.ts` | 缺 per-prompt delta 抽取、typed decision kinds、friction gating、per-session queue、5 分钟合并、项目决策 markdown 文件 |
| `jsonrpc/` | 1 | `jsonrpc/message-framing.ts` | `src/lsp/client.ts`（内联 Content-Length 解析） | 无共享 `MessageFramer`：无分块 O(n) 解码与余量移交、无体积上限、无第二个消费者（RL 无 `dap/`） |
| `lib/` | 1 | `lib/xai-http.ts` | `src/providers/xai.ts`、`src/auth/oauth/xai.ts` | 有 xai provider（chat + OAuth），但缺 HTTP tool 传输解析：`XAI_BASE_URL`、`xai-oauth.baseUrl`、`XAI_OAUTH_TOKEN` 门控 |
| `utils/` | 50 | `utils/clipboard.ts`、`utils/sixel.ts`、`utils/terminal-graphics.ts`、`utils/image-resize.ts`、`utils/image-loading.ts`、`utils/video.ts`、`utils/qrcode.ts`、`utils/github.ts`、`utils/external-editor.ts`、`utils/file-mentions.ts`、`utils/title-generator.ts`、`utils/token-rate.ts`、`utils/usage-display.ts`、`utils/tool-schema.ts`、`utils/shell-snapshot.ts`、`utils/markit.ts`、`utils/markit-cache.ts`、`utils/turndown.ts`、`utils/block-context.ts`、`utils/session-color.ts`、`utils/enhanced-paste.ts`、`utils/thinking-display.ts`、`utils/tools-manager.ts`、`utils/commit-message-generator.ts`、`utils/event-bus.ts` | `src/utils/*`（22 文件） | 50 → 22。缺上列各项；RL 侧的 `src/utils/` 主要是网络/解析/哈希类工具 |
| `index.ts` | 1 | `index.ts` | `src/index.ts` | 库入口只导出 core + runtime 原语；缺 session 栈、`storage/session-store`、TUI、extensions manager、modes 与 SDK 的再导出（RL 真实入口是 CLI，故此项按 SDK 需求计） |
| `cli.ts` | 1 | `cli.ts` | `src/cli/cli.ts`、`src/cli/main.ts` | 缺 worker-selector 子进程引导、`runSmokeTest` 分发探针、`PREPAINT_SAFE_FLAGS` 首帧快路径、profile bootstrap 与代理安装、编译态入口探测 |
| `cli-commands.ts` | 1 | `cli-commands.ts` | `src/cli/main.ts`、`src/cli/control-commands.ts` | 无 `CommandEntry` 懒加载注册表、无 per-command 懒加载帮助、无保留顶层词守卫（未注册动词会被当 prompt 而非报错提示） |
| `main.ts` | 1 | `main.ts` | `src/cli/main.ts` | 启动路径（argv→settings→session→runtime）已实现，但缺：启动期模型/角色解析、扩展 flag 应用与插件根预载、交互式会话选择器、文件/图片参数处理、未识别 flag 上报、ACP/RPC/print 模式分支、marketplace 自动更新调度 |
| `goals/` + `plan-mode/` | 11 | `goals/index.ts`、`goals/runtime.ts`、`goals/state.ts`、`goals/tools/goal-tool.ts`、`plan-mode/plan-autosave.ts`、`plan-mode/plan-files.ts`、`plan-mode/plan-handoff.ts`、`plan-mode/plan-protection.ts`、`plan-mode/approved-plan.ts`、`plan-mode/model-transition.ts`、`plan-mode/state.ts` | `src/runtime/modes/{goal,plan}/*`、`src/runtime/session-runtime/{goal,plan}-domain.ts`、`{goal,plan}-tools.ts`、`{goal,plan}-composition.ts`、`src/tui/interactive/{goal-loop,plan}-workflow.ts` | 两侧都已真实实现，但 RL 侧 `development-doc/plan/17-omp-loop-goal-mode-adaptation-plan.md` §14 记录行为与验收未闭合；上游文件式 plan 产物（autosave/plan-files/handoff/protection/approved-plan/model-transition）在 RL 由事件溯源的 plan artifact-store 与 `plan.approve` 取代 |
| `tui/` | 10 | `tui/index.ts`、`tui/output-block.ts`、`tui/code-cell.ts`、`tui/tree-list.ts`、`tui/file-list.ts`、`tui/width-aware-text.ts`、`tui/status-line.ts`、`tui/hyperlink.ts` | `src/tui/primitives.ts`、`src/tui/text-layout.ts`、`src/tui/index.ts` | OSC 8 超链接已有对等物；缺 `sixel`/terminal-graphics、`code-cell`、`output-block`、`width-aware-text`、`tree-list`、`file-list`、`status-line` 等共享渲染助手（RL 自建 primitives 覆盖部分场景） |
| `tiny/` | 14 | `tiny/title-client.ts`、`tiny/worker.ts`、`tiny/worker-server.ts`、`tiny/title-protocol.ts`、`tiny/models.ts`、`tiny/device.ts`、`tiny/mlx-runtime.ts`、`tiny/mlx-server.py`、`tiny/online-candidates.ts`、`tiny/completion-prompt.ts`、`tiny/message-preproc.ts`、`tiny/jsonl-socket.ts` | `src/runtime/session-runtime/title-generator.ts`、`src/runtime/session-runtime/title-lifecycle.ts`、`src/runtime/session-owner/title.ts` | 标题生成已具备，但走当前会话模型；缺本地 ONNX tiny worker（per-model 进程 + socket 协议）、device/EP 选择、mlx 运行时、online 候选、worker 空闲退出 |

### 4.1 `tools/` 快照推进与剩余候选（2026-09-18）

本节在当前 HEAD `aa9683e` 复核，而不是从 `0b2c501b` 的目录数推测。`src/runtime/tools/` 从基线的 26 增至 29 个 TS 文件，但文件数**不是**模型工具数：两个新增 `read-*` 文件是 `read` 的内部类型分支，只有 `ask` 新增了模型可调用工具。下表的「可立项」表示现有权威边界可以承接，不代表已获实施授权或可跳过专题设计。

| 分类 | 项目 | 当前事实与必要边界 |
|---|---|---|
| 已完成 | `read` 的 sqlite/archive 分支 | `1108c7d` 在 `splitPathAndSel` 前识别 `db.sqlite:table` 与 `archive.zip:member`，经受治理 FS 读取字节、magic 嗅探失败则回落文本；sqlite 使用只读/`query_only`。这不是新增 `sqlite_reader` 或 `read_archive` 工具。已知限制是读取不到 SQLite `-wal`/`-shm` 侧车。 |
| 已完成 | `ask` | `aa9683e` 新增 schema、reverse-request `AskPort`、TUI selector 分派，并由 embedded Session Runtime 注入生产 Session Domain。未接 UI 的客户端得到立即 typed failure，不轮询或伪造回答。 |
| 已完成（相邻模块） | `web_search` | `30fd103` 的 `src/websource/search/tool.ts` 已通过 governed network 条件注册；它关闭的是上游 `web/`、`exa/` 模块缺口，而非完整移植 `tools/` 目录。 |
| 已实现，待真实 TTY evidence | `checkpoint` / `rewind` | `named-checkpoint.ts` 从 durable events 投影 stable boundary，`session.rewind` 在一个 owner-fenced SQLite transaction 内创建目标 fork、注入 report、追加源端 `checkpoint.rewound` 审计；标准 profile 经一次性 reverse request/TUI switch 接入，headless 立即 typed failure。它仍不是原会话回退，也不使用可删除的 `session_checkpoints` cache；真实 provider 的 TTY tool-call evidence 尚待补齐。 |
| 已实现，限 `read` 分支 | DOCX/PPTX/XLSX/EPUB 文档转换 | `src/runtime/tools/read-office.ts` 在 archive/sqlite 之后、文本 decode 之前接收 governed fs 字节；8 MiB 输入、ZIP/XML/输出限额，DTD/custom entity 和坏 ZIP 失败不回落正文，图像仅 Markdown 占位。PDF/native `pdf-inspector` 不随此项引入；实现与验收见 [Plan 20 §4](../plan/20-omp-implementable-tools-port-plan.md#4-阶段-ii非-pdf-文档转换-read-branch)。 |
| 已实现，待真实 provider evidence | `image_gen` | `src/runtime/tools/{image-gen,image-generation-port}.ts` 在 standard Session Owner 中以 Host image catalog 与 canonical `AuthStorage` 解析模型/凭据；OpenRouter SDK 只能收到注入的 `ExecutionEnv.network` fetch（固定 `image_gen` principal），输出受 text/image/byte cap 和 digest 投影保护。Plan/minimal 不注册，provider body/credential 不回灌。真实受控凭据调用仍待补；见 [Plan 20 §5](../plan/20-omp-implementable-tools-port-plan.md#5-阶段-iii受治理-image_gen)。 |
| 已实现，限只读子集（本批次） | GitHub 查询/上下文工具 | `src/websource/github-read.ts` 和 `src/runtime/tools/github.ts` 已通过 `createWebSearchFetch({ principal: "github" })` 接入 `repo_view`、`file_read` 与五类 search；endpoint 固定、token 仅经 credential port、结果有界。PR 创建/checkout/push、任意 URL 与 `run_watch` 仍明确不做。实现与验收门槛见 [Plan 20 §6](../plan/20-omp-implementable-tools-port-plan.md#6-阶段-ivgithub-只读查询)。 |
| 已实现，受扩展治理（本批次） | 手动 `manage_skill` | `src/extensions/skills/managed-store.ts` 只写 canonical user root，带 provenance marker、atomic write/only-managed delete；standard Session 通过 attempt fence 注册，active turn 只标记 pending reload，且不自动 trust。`learn`/自动托管 skills 仍依赖 Memory backend，不随此项实现。实现与验收门槛见 [Plan 20 §7](../plan/20-omp-implementable-tools-port-plan.md#7-阶段-vcanonical-user-manage_skill)。 |

下列项目前**不应作为低成本工具移植**：

- `ast_grep` / `ast_edit` 受 Plan 16 已裁定的 native 依赖非目标约束；不引入 grammar/addon 脚手架。
- PDF `read`、`browser` / `computer`、`eval` / `run-code` 分别需要 native PDF、browser/desktop worker、或模型代码执行内核，均没有可直接复用的生产运行时。
- `memory_retain` / `memory_reflect` / `memory_edit` / `memory_recall` 和 `learn` 需先完成 Memory 的 Session Owner authority；当前专题状态是 `core partial, production unavailable`。
- `yield` 与 `tools/hub` 分别依赖 async job manager 与可寻址/可复活 agent registry/IRC；`read-summary`、`shell-tokenize`、`tool-timeouts`、`render-utils` 则是 helper，不该先作为独立模型工具注册。

## 5. 已实质对等（`full`）

| 能力 | 上游位置 | RunLedger 位置 | 说明 |
|---|---|---|---|
| 上下文压缩 / compaction | `packages/agent/src/compaction/*`（**兄弟包，非本口径**）；本口径内相关的是 `src/session/session-maintenance.ts` 的 length-stop 半套 | `src/runtime/context/compaction/*`（14 文件）、`src/runtime/session-runtime/compaction-domain.ts` | `development-doc/compact/` 已记录 O0–O5 本地验收；`session-maintenance` 的完整面仍按 §4 `session/` 计入缺口 |
| AI provider 与模型 catalog | `packages/ai/*`、`packages/catalog/*`（**兄弟包**） | `src/api/*`（37 文件）、`src/providers/*`（150+ provider 模块 + `src/providers/data/`） | 协议适配器与 provider catalog 均自建 |
| 安全/权限网关 | ⚠️ **本口径内无对应上游模块**：omp 的权限/审批策略内联在 `src/session/*` 与 `src/modes/components/*`，仓库内无 `sandbox/` 目录 | `src/security/permission/*`（24）、`src/security/sandbox/*`（10）、`src/security/composition/*`（10）、`src/security/execution-gateway.ts` | RunLedger 为自建实现，属**能力对等**而非移植对等物；注意与上游 `src/security/`（安全审查平台，§3 #21）**不是同一件事** |
| 扩展 host 与 marketplace | `extensibility/plugins/*`、`discovery/plugin-dir-roots.ts` | `src/extensions/plugins/*`（17）、`src/extensions/host/*`（9）、`src/contracts/extensions/*`（8） | 采用 out-of-process 声明式 host，与上游进程内加载模型不同（差异见 §4 `extensibility/`） |
| Session Owner / 多客户端会话服务 | `src/session/*`、`src/launch/*` | `src/runtime/session-server/*`（6）、`src/runtime/session-owner/*`（5）、`src/storage/host/*`（13） | 单机 owner-fenced 模型，非上游 daemon broker |
| 只读本地 Web 看板 | `packages/collab-web/*`（**兄弟包**） | `src/web/*`（14 文件）、`packages/collab-web/*` | 上游 `src/collab/`（多人协作）仍是 §3 #4 的缺口 |

## 6. 上游有、RunLedger 明确决定不移植

以下不是遗漏，而是已有决策，复核时不要按缺口重新立项。引用 RunLedger 侧决策文档。

| 项目 | omp 位置 | 决策出处 |
|---|---|---|
| 内部 URL 命名空间（`artifact://`、`history://`、`skill://` 等） | `src/internal-urls/*`（22 文件） | `development-doc/plan/16-omp-tool-parity-update-plan.md` §4；`development-doc/compact/01-integration-plan.md` |
| 推测执行（speculative read/commit） | `src/speculation/host.ts` | plan 16 §5 |
| edit hashline 多模式 / 自愈重试 | `src/edit/{schemas,hashline-compact.md,auto-repair}.ts` | plan 16 §1.2/§5（native EditSession 依赖） |
| 模型侧代码执行内核 `eval` | `src/eval/*`（52 文件） | plan 16 §1.2/§5 |
| 子代理 worktree 隔离、workpool/DAG 批处理 | `src/task/{isolation-runner,isolation-ownership,worktree,workpool,parallel}.ts` | plan 16 §6；`development-doc/runtime/08-bounded-multi-agent-system-plan.md`；根 `AGENTS.md` 冻结边界 |
| 进程内 TS/JS 扩展模块加载、legacy-pi 兼容 shim、虚拟模块与 SQLite 解析缓存 | `src/extensibility/{extensions/loader,runner,wrapper,managed-timers}.ts`、`src/extensibility/legacy-pi-*.ts` | `development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md` §13、`03` §Disposition |
| OS sandbox 跨平台扩展 | ⚠️ **无对应上游模块**（oh-my-pi 仓库内不存在 `sandbox/` 目录或 bwrap/seatbelt 实现）；本条指 RunLedger **自身** `src/security/sandbox/*` | 根 `AGENTS.md` §2（冻结；现有 Linux bwrap 仅作既有实现保留） |
| LSP mux daemon / lspmux / workspace 级诊断 | `src/lsp/{lspmux.ts,mux/*,workspace-diagnostics.ts}` | `development-doc/plan/04-lsp-server-adaptation-plan.md`（v1 非目标） |

## 7. 复现命令

```sh
# 以下命令在同时包含两个 checkout 的父目录执行（即 oh-my-pi 与 RunLedger 同级处）
OMP=oh-my-pi/packages/coding-agent/src
RL=RunLedger/src

# 上游快照与规模
git -C oh-my-pi log -1 --format='%H %cd'
jq -r '.name + " " + .version' oh-my-pi/packages/coding-agent/package.json
find $OMP -type f | wc -l

# 顶层条目与文件数对照
find $OMP -maxdepth 1 -mindepth 1 -printf '%y %f\n' | sort

# 目录级差异（注意：路径相等率低，仅作辅证）
comm -23 <(find $OMP -mindepth 1 -type d | sort) \
         <(find $RL -mindepth 1 -type d | sort)

# 逐模块符号检索（示例：判定 security 平台与 secrets 改写是否缺失）
grep -rl -iE 'sarif|remediation' $RL
grep -rl -iE 'SecretObfuscator|placeholder-scan|obfuscateToolArguments' $RL
grep -rl -iE 'web_search|tavily|searxng' $RL
grep -rl -iE 'KernelBase|ExecutorBase' $RL
grep -rl -iE 'DebugAdapter|SetBreakpoints' $RL
grep -rl -iE 'AgentRegistry|MAIN_AGENT_ID' $RL
```

## 8. 建议优先级

按「缺口影响面 × 现有基础设施可承接度」排序；**本表不是排期，实施仍需各专题立项**。

| 优先级 | 项目 | 理由 |
|---|---|---|
| P0 | `secrets/` 出站消息改写 | 唯一有直接安全后果的缺口：当前只做 sink 局部脱敏，粘进对话的密钥仍会发往 provider |
| 已完成 / 已裁定不做 | ~~`tools/` 中低成本项：`ast-grep`/`ast-edit`、`read-pdf`/`read-archive`/`sqlite-reader`、`ask`、`checkpoint`/`rewind`~~ | `read` 的 sqlite/archive 分支、`ask`、命名 `checkpoint`/新会话 `rewind` 已实现；前两项是 `read` helper 而非工具。`ast-*` 与 PDF 已有明确非目标裁定。 |
| 已完成，待真实 TTY evidence | `checkpoint` / `rewind`（新会话 fork 语义） | durable 命名标记、driver handoff、Session Domain 与 TUI 同一协议均已落地，且不改变 append-only 事件链；剩余是可用 provider 下的 built CLI/TTY 实际调用验收。 |
| P1 | `src/subprocess/*` + `src/async/job-manager.ts` | 是 `stats/`、`activity/`、`tts`/`stt`、`blob-broker` 的共同前置；不补则后续各项各自造轮子 |
| P1 | ~~`web/`（至少 search provider 层）~~ **已完成**（`30fd103`，见 [plan/18](../plan/18-omp-web-capability-port-plan.md)） | 原有理由：已有受治网络策略与 `web-fetch` 骨架。剩余未闭合项见 plan/18 §11.4 |
| P1 | `session/` 的 `turn-recovery` 重放与 `session-maintenance` length-stop | plan 14 已显式列为 out of scope，属已知欠账 |
| P2 | `registry/` + `irc/` + `tools/hub` | 三者耦合；若要让 agent 可寻址/可续跑需一起做。当前 `runtime/agents` 只支持一次性 child |
| P2 | `modes/acp/`、`dap/`、`eval/` | 独立能力面，依赖外部协议或运行时，可独立立项 |
| P3 | `advisor/`、`autolearn/`、`auto-thinking/`、`judgment/` | 依赖 `judgment`（auto-thinking 的上游前置）与 advisor 架构，宜整体评估后再决定是否移植 |
| P3 | `commit/`、`export/`、完整 `markit`（PDF/独立 API）、`blob-broker/`、`tts`/`stt`/`live`/`collab` | DOCX/PPTX/XLSX/EPUB `read` 已关闭；剩余产品面增强项与可审计执行主链无耦合 |

## 9. 证据限制

1. 本文为**静态源码对照**：不表示上表任何 RunLedger 模块通过运行时验收，也不表示缺口项在真实 provider / TTY / 跨平台下可用。
2. 上游 「文件数」是规模指标，不等于工作量；部分文件是资源、fixture 或类型。
3. `partial` 判定的「缺口」列只列本次检索确认的上游无对等物项；两侧命名差异大的模块（`modes/`、`session/`、`tools/`）不保证穷尽。
4. 未提交工作树包含他人改动，且调查期间上游/目标均可能继续前进；复核时请以 §7 命令在当前 checkout 重新生成事实。
5. 兄弟包（`packages/agent`、`packages/ai`、`packages/tui`、`packages/catalog`、`packages/stats`、`packages/mnemopi`、`packages/metaharness`、`packages/utils`、`packages/wire` 等）未逐文件对照；凡 RunLedger 对等物实际落在兄弟包的能力，本文只在注释中标注，不据此判 `absent`。
