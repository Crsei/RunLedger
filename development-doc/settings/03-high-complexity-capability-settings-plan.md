# Settings 补全计划 03：高难度——新能力、外部服务与安全边界

> 状态：planned / deferred（本 worktree 不提前加入高难度 schema 或 capability）
>
> 本计划只定义高难度 settings 的解封顺序和实现边界，不允许通过先加 schema 字段来宣称能力完成。它对应 `notez/00-settings-gap-vs-oh-my-pi.md` 正文中标为缺失、或需要新增外部/跨进程/安全能力的项目。附录 A/B 仍全部延期。

## 1. 高难度判定

高难度项目至少满足一项：

- RunLedger 当前没有对应 capability，settings 不能独立产生行为；
- 需要真实 provider、search、browser、speech、collab 或远程服务；
- 需要 credential、token、secret redaction 或用户 consent；
- 需要 subprocess/worker、跨进程并发、durable state、恢复和 owner fencing；
- 影响 ExecutionGateway、Approval、Workspace isolation、model context trust 或外部数据流。

每个高难度 slice 的完成顺序固定为：capability contract → local deterministic implementation → settings schema/resolver → production composition → external/TTY/human acceptance。只有 schema、mock 或 UI 不得进入 `implemented`。

## 2. oh-my-pi 对应实现方式

| 高难度域 | oh-my-pi 实际入口/消费者 | RunLedger 对应要求 |
|---|---|---|
| model/usage fallback | `config/settings-schema.ts` 的 retry fallback keys；`session/retry-fallback-chains.ts` 解析 role/model/provider wildcard；`session/agent-session.ts`、`config/model-registry.ts`、`config/api-key-resolver.ts` 参与候选模型、credential rotation、cooldown | 先由 Model Router/credential policy 产生可审计 decision，再让 `RetryPolicy` 消费；settings 不得直接指定未经 manifest/auth 验证的 provider/model |
| advanced compaction | `session/session-maintenance.ts` 读取 idle/remote/snapcompact/loop settings，并统一安排 compaction/retry/autoContinue | 扩展现有 `ContextEngine`/CompactionService；remote/handoff 需要 Artifact/Host/credential/stream contract，不能只加 bool |
| memory/learning | `session/session-memory.ts`、`tools/memory-recall.ts`、`memory-retain.ts`、`memory-reflect.ts`、`tools/learn.ts`、`tools/index.ts` 依据 backend/autolearn settings gate 工具、提取和注入 | 使用现有 Runtime Memory contract 的 proposal/approval/revoke/trust/TTL；外部 backend 失败不能破坏主 session，未批准 memory 不能进入 prompt |
| eval/interpreter/async | `tools/eval.ts`、`eval-backends.ts`、`eval/{py,rb,jl}/**`、`tools/hub/jobs.ts`；settings 同时控制 backend、interpreter、timeout、concurrency | 每个 interpreter/worker 经过 Process/ExecutionGateway，限制 cwd、环境、超时、输出和生命周期；settings 不能成为 sandbox 绕过 |
| browser/computer/speech | `tools/browser.ts`、`tools/computer.ts`、`tools/ask.ts`、`stt/**`、`tts/**`、`tools/tts.ts`、`live/**`；schema 只决定 capability 是否暴露和 provider/model 选择 | 先有 permission/consent、managed process/device boundary、credential policy 和 TUI presentation，再接 settings |
| web search/fetch/services | `web/search/index.ts`、`web/search/providers/exa.ts`、`searxng.ts`、`cli/web-search.ts`、`tools/fetch.ts`、`config/provider-globals.ts` | 新增受治理的 network capability、host allowlist、timeout/output budget、credential redaction；真实受控 server smoke 后再开放外部 provider |
| collab/share/broker | `collab/**`、`session/irc-bridge.ts`、`commands/share.ts`、`session/auth-broker-config.ts` | 设计 authenticated protocol、owner/driver/observer、secret boundary、redaction 和 recovery；settings 只能选择已验证 endpoint/store |
| marketplace/updates/notify | `extensibility/plugins/marketplace/**`、`cli/update-cli.ts`、`modes/interactive-mode.ts` 的 notification/startup consumers | 更新/安装是外部副作用，必须有 consent、签名/来源、rollback 或 fail-closed policy；不把 URL/token 当普通显示 settings |
| secrets/autoqa/commit | `config/settings.ts` 的 `secrets.enabled` hook、`tools/report-tool-issue.ts` consent flow、`commands/commit.ts` 及 commit helpers | credential redaction、用户授权、artifact/trace 脱敏和 Git side-effect policy 先于 settings；无能力则 deferred |

## 3. 高难度设置清单

### H1：Retry fallback 与高级 compaction

纳入候选：

- `retry.modelFallback`；
- `retry.usageAwareFallback`、`retry.usageReservePct`、`retry.usageReservePolicy`；
- `retry.fallbackChains`、`retry.fallbackRevertPolicy`；
- `providers.anthropic.serverSideFallback`（只有 Anthropic wire beta/header/error semantics 在 RunLedger 中真实可验证时）；
- `compaction.idleEnabled`、`idleThresholdTokens`、`idleTimeoutSeconds`；
- `compaction.handoffSaveToDisk`、`remoteEnabled`、`remoteStreamingV2Enabled`；
- `compaction.supersedeReads`、`dropUseless`；
- `snapcompact.systemPrompt`、`toolResults`、`shape`；
- `loop.mode`。

实现要求：

1. fallback selector 只能引用已验证 model manifest/provider catalog；`provider/*`、role selector 和 model selector 的匹配规则要有 parser/normalizer，不接受任意字符串直通 wire。
2. usage-aware fallback 只能使用已验证 usage/credential source；unknown usage 不得自动切换或消费 reserve；`confirm|auto|fail-closed` 必须在 interactive/background 两种 context 分开测试。
3. fallback state、cooldown、revert policy 和实际 model switch 写入可审计 runtime event；恢复后不能从 UI 的临时布尔值猜测当前 primary/fallback。
4. remote/handoff compaction 先固定 artifact、network、credential、stream cancellation 和 host recovery contract；没有这些 contract 时只保留 `deferred`。
5. snapcompact/loop settings 只有在 RunLedger 实际支持对应 strategy/loop lifecycle 后才加入 schema；没有 consumer 不加字段。

### H2：Memory backend、autolearn 与上下文提升

纳入候选：

- `memories.enabled`；若后续需要 rollout/lease/scan/token budget，先更新差距分析正文并重新划定范围；
- `autolearn.enabled`、`autolearn.autoContinue`；
- `contextPromotion.enabled`、`prewalk.enabled`（若已有 prewalk lifecycle）；
- `mnemopi.*`：dbPath、bank/scoping、embedding、LLM、credential、recall/retain/debug；
- `hindsight.*`：apiUrl/apiToken、bank/scoping、retain/recall budget、mental model、timeout/debug；
- `providers.memoryModel`，只在 tiny/local/online model role contract 先完成后接入。

oh-my-pi 的对应行为是 backend resolver 决定工具和自动注入，`session-memory.ts` 管 session lifecycle，memory tools 负责 recall/retain/reflect/learn，settings panel 根据 `memory.backend` 条件显示 mnemopi/hindsight group。RunLedger 不能只复制这些 keys：

1. local/mnemopi/hindsight 各自定义 capability、存储、失败和 credential port；
2. canonical memory 记录、proposal、approval、revoke、scope/trust/digest 必须属于 Runtime memory authority，`MEMORY.md`/index 只能是 projection；
3. `enabled=false` 或 backend=off 必须使工具和自动注入不可见/不执行，但不得删除已有记录；
4. 预扫描、autolearn、autoContinue 需要 idle/owner/session fence，不能在 TUI timer 中实现；
5. 外部 Hindsight 调用必须有 timeout、budget、redaction、network policy 和 isolated server test；credential 不进入 settings list/trace。

### H3：新工具与执行后端

纳入候选：

- `tools.format`；
- `tools.intentTracing`、`abortOnFabricatedResult`、`maxTimeout`、`xdev`、`xdevDocs`、`xdevInlineDevices`；
- `shellMinimizer.*`；
- `eval.py/js/rb/jl`、`python.kernelMode/interpreter`、`ruby.interpreter`、`julia.interpreter`；
- `computer.*`；
- `checkpoint.enabled`、`fetch.enabled`、`vault.enabled`、`github.*`、`security.enabled`、`ask.*`、`browser.*`、`speechgen.enabled`；
- `stt.*`、`ttsr.*`、`speech.*`、`live.voice`、`providers.tts`、`tts.localModel`、`tts.localVoice`。

oh-my-pi 的实现是“tool registry gate + concrete tool reads settings + shared timeout/output/process helpers”，例如 `tools/index.ts` 决定工具是否进入 schema，`tools/computer.ts` 读取 display/size，`tools/bash.ts` 读取 interceptor/async/direnv，`tools/eval-backends.ts` 选择 interpreter，`tools/browser.ts` 管 relay/CDP/headless，`tools/ask.ts` 管 notify/timeout/speech。

RunLedger 的解封顺序：

1. 先为每个工具定义 effect、input/output cap、credential、process/network/sandbox capability；
2. 将工具注册、ExecutionGateway、Approval 和 Session Owner lifecycle 接好；
3. 以 settings snapshot gate tool availability 和 option projection；
4. 为 interpreter/browser/device/voice 添加真实 cleanup、timeout、abort/recovery；
5. 受控环境验证后才开放默认值，能力缺失时 settings 应显示 unsupported，而不是静默回退到 unrestricted local I/O。

### H4：Provider/网络/协作/分享

纳入候选：

- `providers.webSearchOrder`、`webSearchExclude`、`webSearchTimeoutSeconds`、`webSearchGeminiModel`；
- `exa.*`、`searxng.*`；
- `providers.tinyModel`、`providers.tinyModelDevice`、`providers.tinyModelDtype`、`providers.memoryModel`、`providers.autoThinkingModel`、`providers.autoThinkingMaxEffort`、`providers.unexpectedStopModel`（不触碰附录 A 的思考策略，只实现已经确认的 tiny/model provider role）；
- `auth.broker.url`、`auth.broker.token`；
- `codexResets.*`；
- `collab.relayUrl`、`webUrl`、`displayName`；
- `share.serverUrl`、`store`、`redactSecrets`；
- `marketplace.autoUpdate`；
- `completion.notify`、`error.notify`、`ask.notify`；
- `magicKeywords.*`；
- `branchSummary.enabled`、`commit.mapReduce*` 的新增能力部分。

对应 oh-my-pi 的关键事实：

- web search 不是普通 provider catalog；它由 `web/search/index.ts` 根据 order/exclude 和 provider-specific settings 选择，并通过 `exa.ts`/`searxng.ts` 发请求；
- auth broker 是 `session/auth-broker-config.ts` 和 broker command 的凭证代理通道，token 不能作为普通 setting list 输出；
- collab/IRC 由 `collab/**`、`session/irc-bridge.ts`、task hub messaging 消费，必须有 timeout、identity 和 owner semantics；
- share 由 `commands/share.ts`/share tests 消费，`redactSecrets` 必须发生在发布前，不是 UI 开关；
- marketplace/update/notify/magic keyword 都有独立 startup/extension/input consumer，不能只依赖 schema metadata。

### H5：运维和敏感副作用

纳入候选：

- `secrets.enabled`；
- `dev.autoqa`、`dev.autoqaPush.endpoint`、`dev.autoqaPush.token`、`dev.autoqaConsent`；
- `gc.*` 中若要新增自动 GC/retention worker 的部分；
- `git.enabled` 中若要改变 commit/write side effect 的部分。

oh-my-pi 用 `SETTING_HOOKS` 把 `secrets.enabled` 连接到 `configureCredentialRedaction()`，用 `tools/report-tool-issue.ts` 管 consent/endpoint/token。RunLedger 只有在 Trace/Artifact/Provider/Tool output 的 redaction boundary 统一后，才能新增同等开关；不能把 token 写进普通 settings snapshot、digest、session event 或错误输出。

## 4. 分阶段执行

### H0：Capability inventory 与解封清单

对每个 H key 建立表格：schema type/default、capability owner、consumer、authority、credential、network/process effect、durability、tests、deferred reason。先把“settings missing”与“capability missing”分开；能力缺失的行不能标作 partial implementation。

### H1：高级 retry/compaction

在计划 02 的 policy seam 上增加 Router decision、usage/credential port、cooldown state、remote compaction adapter 和 recovery event。优先本地 deterministic fake provider/server，最后做真实 provider/remote evidence。

### H2：Memory/learning

按 `local → mnemopi → hindsight` 分开提交。每个 backend 先通过 store/search/approval/failure tests，再接 `memory.backend` 和 conditional settings UI。autolearn/contextPromotion/prewalk 必须在 Session Owner lifecycle 中实现，不能由 settings timer 直接启动。

### H3：Tools/exec/device/network

按 capability 分批：eval/interpreter、computer/browser、speech/STT/TTS、web search/fetch、security/vault/GitHub。每批先完成 gateway/process/permission contract，再接 schema；所有外部请求和进程都有 timeout、output cap、abort、cleanup、redaction。

### H4：Collab/share/broker/update/ops

先冻结 identity/relay/share/broker/update contracts，再把 endpoint/store/notify/consent settings 连接到 Host/Session/CLI。跨客户端操作要验证 observer/driver、disconnect、retry、recovery 和 secret redaction。

### H5：高难度统一验收

生成正文第 1–10 节的 key-to-consumer matrix，检查每个键都有真实实现或明确 deferred；运行全套自动门、受控外部 server、隔离 `RUNLEDGER_DIR`、真实 CLI/TUI/Host composition 和人工安全/视觉验收。

## 5. 测试与验收门

### 必备自动证据

- schema/resolver：default、layer precedence、invalid/unknown、credential redaction、settings digest；
- security：ExecutionGateway/Approval deny remains deny，settings 不能扩大 capability；
- runtime：owner fence、abort、timeout、crash/recovery、duplicate command/receipt、durable state；
- provider/network：本地受控 server、redirect/host allowlist、Retry-After、stream terminal event、credential failure；
- memory：proposal/approval/revoke/TTL/trust、external backend unavailable 时主 session 继续；
- process/device：interpreter/browser/voice 的 cleanup、output cap、SIGTERM/abort 和 isolated environment；
- CLI/TUI：隔离 user/workspace settings、redacted list/export、真实编译产物和 TTY；
- 全仓：`npm run check`、focused tests、`npm test`、`npm run build`、`git diff --check`。

### 不满足即停止

- 只有 schema/default 或 settings panel，没有 production consumer；
- 只有 mock external provider，没有受控 server/真实 transport evidence；
- credential/token 出现在 settings list、digest、trace、artifact、错误或 session transcript；
- external capability 在权限/网络/进程失败时回退到 unrestricted local implementation；
- memory 自动注入没有 approved/trust/scope/digest；
- collab/share/broker 没有 authenticated identity、owner/driver 语义或断线恢复；
- 高难度项的行为测试依赖 real home、真实 credential 或未隔离的用户目录。

## 6. 明确不在高难度解封范围的内容

本计划不会实现附录 A 的模型/采样/思考/提示词/loop guard 项，也不会把附录 B 的约束转成新的 schema 或迁移行为。需要这些能力时，应基于新的 RunLedger 模型/采样现状重新核实，另建独立计划，并重新冻结 oh-my-pi source baseline。
