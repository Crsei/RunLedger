# RunLedger Settings 验收矩阵

> 状态：`partial`。本文是 settings 计划 01–03 的逐组验收与缺口事实入口，不代表整个 settings 专项已经完成。
>
> 核对基线：`b23b900921f9`（2026-08-22）；目标分支为 `worktree/settings-runtime`。本地 settings/runtime candidate commits 尚未合并或接受。历史 candidate 的测试数字、oh-my-pi 测试或单纯 schema 变更都不能替代本文记录的当前 fresh evidence。

## 1. 读法与状态定义

计划 01–03 的键名只是差距分析和实施边界，不是 RunLedger 的实现证明。每一行分别回答：当前谁拥有 authority、是否有从 CLI/Host/Session 进入真实行为的 consumer、哪些部分仍只是 schema/projection、以及解封还缺什么。

| 状态 | 判定 |
|---|---|
| `consumer / partial` | 已有真实 consumer，但只有能力子集、跨模块矩阵不完整，或缺生产/人工验收；不能宣称该组完成。 |
| `schema/projection only` | 有 typed schema、resolver 或 policy projection，但没有足够的真实行为 consumer；不计入完成。 |
| `deferred` | 当前能力本体或 canonical settings consumer 不存在；保持未进入 schema，未知路径继续 fail closed。 |
| `blocked / pending acceptance` | 已有生产接缝和部分测试，但仍缺组合链、受控 transport、标准 CLI/TUI、跨平台或 human acceptance。 |
| `rejected / fail-closed` | 非法、未知或会扩大安全/资源边界的输入被拒绝、丢弃、降为安全默认或返回 deny；这是安全结果，不是能力完成。 |

本文所说的“生产 consumer”是从标准 CLI/Host/Session composition 进入实际请求、工具、持久域状态或 TUI 行为的代码。`settings-manager.ts` 白名单、JSON fixture、`SettingDefinition` 或 settings CLI 的 list 输出单独都不满足这个条件。

## 2. Authority、快照与当前边界

| 层级 | 当前 authority | 规则 |
|---|---|---|
| user | 注入 `RunledgerLayout` 的 `layout.settings` | 用户级设置、文件权限和既有 `recording`/credential authority 仍由 canonical layout 控制。 |
| workspace | 校验后的 `layout.projects/<workspaceKey>/settings.json` | 只能拥有 schema 允许的 workspace 字段；workspace 不能取得 user-only 的 shell、approval 或 credential authority。 |
| session / CLI | composition 传入的 ephemeral override | `CLI/session > workspace > user > schema default`；不回写成新的 user/workspace authority。 |
| runtime | `SettingsResolver.effectiveRuntimeSnapshot()` | 生成 immutable group policy、source layer、diagnostic 和 digest；consumer 不直接读取 raw JSON。 |

当前 candidate 的主要生产入口是 `src/cli/main.ts`、`src/cli/runtime-host-production.ts`、`src/runtime/session-runtime/domain.ts`、`src/runtime/interactive-session-controller.ts` 与 `src/tui/interactive-mode.ts`。设置服务入口是 `src/storage/settings-service.ts` 和 `src/cli/settings-command.ts`。

`SettingsRuntimeStore` 是当前 settings reload/subscription boundary：`SettingsService` 的 set/reset 经 store reload，已应用的 live display path 通知当前 TUI；startup path 仍保持 pending，不在当前 Session 中途切换，下一次启动/Session composition 才采用。每个 turn 仍捕获 immutable snapshot，settings reload 不原地改写已发出的 turn。

## 3. 计划 01：低难度 settings

| group / 范围 | 当前 production consumer | schema / projection-only 部分 | 状态 | 缺口与解封条件 |
|---|---|---|---|---|
| L0 settings contract、默认值、层级、digest | `SettingsResolver` 在 CLI/Host/Session composition 生成 effective snapshot；`SettingsService` 复用同一 schema 做 typed set/get/reset。 | `SETTINGS_SCHEMA`、scope/apply metadata、group policy projection 已存在，但并非每个键都有独立 feature acceptance。 | `consumer / partial` | 还需按 group 完成默认、合法覆盖、非法回退、层级优先级和 runtime/CLI override 的组合证据；不能用单一 resolver 单测替代所有 consumer。 |
| L1 `list/get/set/reset` | `runledger settings` 经 `src/cli/settings-command.ts` 调用 `SettingsService`；`InteractiveMode` 的 `/settings` 经 `SettingsEditorPort` 打开 `SettingsPanel`，写入仍通过 `SettingsRuntimeStore.editorPort()`；store 的 reload/subscription 通知当前 TUI。 | list 的 metadata、selector 分组和值选项仍是 schema/UI projection；panel 不直接接触 layout、文件或 raw JSON。 | `blocked / pending acceptance` | 需在隔离 `RUNLEDGER_DIR`、编译后的 `dist` 和标准 PATH 下重新确认 CLI/TUI、错误码、权限、脱敏、reset 和人工视觉语义；不能把 surface 或 subscription 单测当作整个 Runtime feature 完成。 |
| L2 status/display/TUI：`symbolPreset`、`colorBlindMode`、`statusLine.*`、`display.*`、`tui.renderMermaid` | `InteractiveMode` 冻结 display/startup snapshot；`projectStatusIndicator` 消费 symbol preset；theme loader 消费 color-blind mode；`Footer` 消费 status line、tool activity、token usage；Timeline/transcript 消费 `cacheMissMarker`；OpenTUI Markdown renderer 消费 `renderMermaid`；`smoothStreaming` 控制 streaming flush。 | 主题、shimmer、logo 等既有展示设置有各自旧入口；透明度、图片和终端能力仍未进入 canonical schema。 | `consumer / partial` | 仍需逐键确认默认/覆盖/非法回退和 80/143 列 TTY 视觉行为；必须证明只改 presentation，不改 transcript、ledger、prompt、provider request 或 security decision。 |
| L2 未接入的外观与终端能力：图片/inline image、`textSizing`、`hyperlinks`、`tight`、`scrollbackRebuild`、`imeSafeCursor`、`power.sleepPrevention`、`paste.largeMenuThreshold` | 当前没有这些键对应的完整 RunLedger settings consumer。已有 image registry、renderer 或终端能力不等于这些设置已生效。 | 未进入当前 canonical schema；不能以空字段或 capability 名称占位。 | `deferred` | 先分别完成 terminal capability、尺寸/数量上限、unsupported 行为、cleanup 和 TTY evidence，再决定是否进入 schema。 |
| L2 startup：`autoResume`、`startup.quiet`、`startup.showSplash` | `src/cli/main.ts` 消费 `autoResume`；`InteractiveMode` 消费 quiet/welcome/splash；CLI 显式 `--continue/--resume` 仍有优先语义。 | `setupWizard`、`checkUpdate`、`changelogMode`、`setupVersion` 没有对应完整 consumer，不能借 startup projection 宣称完成。 | `consumer / partial` | 需完成隔离 compiled CLI/TTY smoke，并记录显式 CLI、已有 session、无候选 session 和 warning suppression 的边界；更新/安装能力转 H4。 |
| L3 `shellPath`、`git.enabled` | `shellPath` 经 `localExecutionEnv`、Session process composition 和 managed process/PTY 使用；`git.enabled` 控制 workspace display metadata/status consumer。 | git/workspace identity、containment 和 Security 仍独立于 `git.enabled`；shell 选择不是任意 raw process authority。 | `consumer / partial` | shell 路径不可执行、跨平台或 process launch 失败必须 fail closed；`git.enabled=false` 不得绕过 workspace identity、Git containment、ExecutionGateway 或 audit。 |
| L3 `gc.*`、自动 retention | `storage prune-legacy` 和 session-store retention 具有显式迁移/计划边界，但没有 settings 驱动的自动 GC worker。 | `gc.blobs`、`gc.archive`、`gc.wal`、retention days/count 未进入 canonical schema。 | `deferred` | 先冻结删除范围、retention manifest、dry-run/stop/recovery、审计和隔离 user-home 证据；禁止启动时由 settings 隐式删除数据。 |

低难度结论：settings kernel、CLI、展示和启动已有 candidate consumer，但 L0–L3 仍是 partial；图片/终端扩展、更新和 GC 不因已有 renderer 或迁移命令而完成。

## 4. 计划 02：中难度 Runtime settings

| group / 范围 | 当前 production consumer | schema / projection-only 部分 | 状态 | 缺口与解封条件 |
|---|---|---|---|---|
| M0 immutable Runtime snapshot | CLI 为每个打开的 Session 解析 user/workspace settings，并把同一 snapshot 注入 Host model/context、Session controller、tool composition、TUI 和 child runtime。digest/source layer 会进入 runtime config；`SettingsRuntimeStore` 提供 reload/subscription boundary。 | `sessionPolicy`、`workspacePolicy` 等是统一 projection；reload 可更新 live display path，startup path 和已发出的 active turn 仍在边界内保持不变。 | `consumer / partial` | 需完成 create/open/continue、Session transition、per-turn boundary、digest/replay/recovery 的组合验收；新值只在允许的 live/turn/startup 边界生效，不能宣称所有 Runtime group 可随时热替换。 |
| M1 基础 retry：`retry.enabled/maxRetries/baseDelayMs/maxDelayMs` | `src/runtime/retry/policy.ts` 经 `simple-options.ts`、root/child Session stream seam 注入；caller options 优先。Codex adapter 有自己的 retry count、`Retry-After`、base delay 和 max delay。 | OpenAI/Anthropic/Azure 主要只能证明 SDK `maxRetries` 投影；统一 base/max delay 尚未由这些 wire 消费。 | `consumer / partial` | 必须逐 transport 记录 supported/unsupported、错误分类、Retry-After 上限、abort、caller precedence 和 terminal event；不能以一个 Codex adapter 宣称全 provider parity。 |
| M1 title/summarizer side request | `SessionTitleLifecycle` 与 production summarizer 都共享 Session 的 `RetryPolicy` 和 `ProviderRequestGate`；对应 focused tests 已验证 options 和 gate release。 | 这只证明 side request 使用共享 seam，不产生 model fallback、usage-aware fallback、fallback chain 或全 provider retry authority。 | `blocked / pending acceptance` | 需通过真实 compaction/title production chain、provider failure、并发、abort/recovery 和完整 provider matrix；不能回退到直接绕过 Session gate 的 `Models.completeSimple` 路径。 |
| Provider retry transport matrix | OpenAI、Anthropic、Azure、Codex 各有部分 adapter/request behavior。 | Google Generative AI、Google Vertex、Bedrock Converse、Mistral 当前没有统一 retry settings consumer 的证据；provider catalog/typecheck 不算接线。 | `rejected / fail-closed` | 未证明的 transport 保持 unsupported/原有安全错误语义；完成前不能宣称 `retry.*` 对全部 builtin provider 生效。 |
| M2 compaction：enabled、mid-turn、strategy、threshold、retain/min budget | `CompactionPolicy` 进入 `agent-loop`、cut planner、Host model/context domain 和 checkpoint/summarizer 路径；threshold/overflow/manual/model-switch 共享 policy；raw event、ledger 和 checkpoint invariant 保留。 | 当前只支持 `off|summary` 子集；remote/handoff、snapcompact、idle、supersede/drop 和 loop 不是当前 schema 的实现。 | `consumer / partial` | 需完成 overflow、threshold、manual、mid-turn、model-switch 的组合测试，以及 invalid/off/summarizer failure 的 live-context 保留；remote/handoff 和 loop 进入 H1 deferred。 |
| M3 local memory：`memory.backend=off|local` | Host model/context domain 根据 snapshot gate `memory.*` operation；`off` 不注入 memory context，local store 仍经 proposal/approval/revoke/search/persistence 和 Host domain tool。 | `hindsight`、`mnemopi`、autolearn、promotion、prewalk 等没有 schema/consumer；`memory.backend` 不代表外部 backend parity。 | `consumer / partial` | 需保留 canonical memory records，验证 off/local、owner/recovery、approved-only projection 和 failure behavior；外部 memory 进入 H2。 |
| M3 tool approval：`tools.approval`、`tools.approvalMode` | policy resolver 将 `always-ask/write/yolo` 映射为 RunLedger `granular/on-request/never` 语义的 projection；tool calls 仍经过既有 Security/ExecutionGateway。 | `approvalMode` 本身不拥有最终 Security authority；不能用 settings projection 覆盖 CLI/managed security policy，也不能把枚举直接 cast。 | `schema/projection only` | 要有明确 user/workspace/CLI authority、组合 approval deny/allow 和 reverse-request evidence；在此之前，最终 leaf 仍以 Security/ExecutionGateway decision 为准。 |
| M3 tool output：artifact spill/head/tail/lines/columns | `agent-loop` 消费 output policy；read/bash factory 消费 `read.defaultLimit`、`read.renderMarkdown`、bash timeout/output；read result details 经 tool projector 转为 Markdown 或 text body；overflow 仍受统一截断与 Artifact/CAS 边界约束。 | `tools.read.renderMarkdown` 的 consumer 只覆盖 read tool 的 TUI presentation projection；各 tool 的 format/eval/browser settings 不在本组。 | `consumer / partial` | 需验证 settings 只改变输出 projection，spill 关闭不能越过 cap、digest/ref、Trace 或 credential redaction；read markdown 已有链路但其他 tool 参数和完整 artifact policy 仍未闭合，保持 partial。 |
| M3 bounded task/agent：`task.maxConcurrency/maxRecursionDepth/maxRuntimeMs/softRequestBudget/disabledAgents` | `applyTaskPolicyNarrowing` 经 Session bounded multi-agent domain 消费；runtime owner、fence、attempt 和 recovery 管理 child。`maxRuntimeMs`、`softRequestBudget`、`disabledAgents` 只收窄 child runtime。 | `maxConcurrency`、`maxRecursionDepth` 不能扩大 M1 固定并发/depth；`agentIdleTtlMs`、`maxEffort` 已移出 canonical schema，未知路径 fail closed。 | `blocked / pending acceptance` | 需为每个字段完成 live consumer、组合测试、receipt/recovery evidence；不能用大于 hard ceiling 的输入证明可扩大能力。 |
| M3 async/IRC：`async.*`、`irc.timeoutMs` | 当前有 bounded owner/child lifecycle、fence、attempt 和 recovery，但没有 oh-my-pi async job pool 或 IRC settings consumer。 | 相关键未进入 canonical schema。 | `deferred` | 先有 durable job/communication capability、timeout、owner/abort/recovery contract，再接 settings。 |
| M4 provider filter/concurrency：`disabledProviders`、`providers.maxInFlightRequests` | `InteractiveSessionController` 在 model catalog/selection 过滤 disabled provider；root、child、title、summarizer 共用 Session-owned provider gate，按 provider limit 排队并可 abort。 | 这是 request admission/concurrency projection，不是 credential、transport 或 fallback authority；image order 没有 consumer。 | `consumer / partial` | 需完成跨 root/child/title/summarizer、provider failure、abort、Session transition 和完整 provider/transport acceptance；不能把 UI 隐藏当作 disabled。 |
| M4 `providers.imageOrder` | 当前没有图片生成模型选择或 request consumer。 | 已从 canonical schema/provider projection 移除。 | `deferred` / `rejected / fail-closed` | 不得重排普通 chat 默认模型；只有图片生成选择链、能力诊断和组合测试闭合后才能重新设计。 |
| M4 protocol/timeout：websocket、OpenRouter/Kimi/Fireworks、first/idle timeout 等 | 个别 adapter 可能有代码级 option，但没有统一 settings authority 和本组的跨 transport contract。 | 未证明同等 option 的键不进入 canonical schema；adapter 存在不等于 settings projection 生效。 | `deferred` | 逐 adapter 固定 option、abort、SSE terminal event、timeout/error classification 和 controlled transport evidence 后再接入。 |
| M5 `workspace.additionalDirectories` | `src/workspace/additional-roots.ts` 与 Session Security composition 将 roots 经 canonical path adapter/containment/identity 接入；public DTO 只暴露数量/digest。 | raw absolute path 不应进入 public envelope；workspace settings 不能扩大 Security roots 到越界/symlink/跨 root 输入。 | `consumer / partial` | 需保持 Linux/其它平台 evidence、symlink/越界/跨 root fail closed、cold resume/revalidation 和标准 Host/CLI acceptance。 |
| M5 Plan：`plan.enabled/defaultOnStartup` | Host model/context domain 和 Session domain 根据 snapshot 暴露/关闭 Plan operation、context fragment 和 capability；首次无 snapshot 的新 Session 才受 defaultOnStartup 影响，已有 durable state 不被覆盖。 | Goal、replan title、Todo delay 不是 Plan 的同义 projection；TUI 只读 domain projection。 | `blocked / pending acceptance` | 需完成 Plan create/open/resume/disabled/activation/recovery、Host/client authority 和 human acceptance；不能把 passive Plan DTO 或 default flag 单测写成完成。 |
| M5 Goal/title/Todo、branch summary、commit map-reduce | Goal/title/Todo 的部分 domain/projection 和 auto-title 能力存在，但本组新 settings consumer 不完整；branch summary/commit map-reduce capability 不存在。 | `goal.*`、`title.refreshOnReplan`、`tasks.todoClearDelay` 已移出 canonical schema；branch/commit keys 不占位。 | `deferred` | 每项先完成真实 Session/Host lifecycle、durability、recovery 和 side-effect authority，再重新定义 settings contract。 |

### 4.1 Provider retry 证据边界

| provider / route | 当前可确认 | 当前不能宣称 |
|---|---|---|
| OpenAI / Anthropic / Azure | 主要证明 SDK `maxRetries` 被 request options 消费。 | 不能宣称共享 `retry.baseDelayMs/maxDelayMs` 已覆盖其 wire 的所有重试语义。 |
| OpenAI Codex responses | 有独立 retry count、`Retry-After`、base delay 和 max delay。 | 不能把 Codex 的实现外推为其他 wire 的统一 settings consumer。 |
| Google Generative AI / Vertex / Bedrock Converse / Mistral | 当前没有统一 retry settings consumer 的证据。 | 不能以 catalog、provider registration、typecheck 或 shared type 代替真实 transport 接线。 |
| Root / child / title / summarizer | 在同一 Session composition 中共享 retry policy 和 provider gate。 | 不能把 Session 级共享 seam 说成跨 Session、全 provider、fallback 或 live reload。 |

## 5. 计划 03：高难度 capability settings

高难度项采用 capability-first 规则：没有 capability、owner、authority、受控 external/process evidence，就不加入 canonical schema。当前这些行的 production consumer 和 schema/projection 均为空；现有相邻能力不能替代未实现的 capability。

| group / 范围 | 当前 production consumer | schema / projection-only 部分 | 状态 | 解封条件 |
|---|---|---|---|---|
| H0 capability inventory | [`05-high-complexity-capability-inventory.md`](05-high-complexity-capability-inventory.md) 已逐 capability 记录 owner/consumer/authority/credential/network/process/durability/tests/deferred reason。 | inventory 明确区分 settings missing 与 capability missing；未为缺失能力加入 canonical schema 或空字段。 | `deferred` | H1–H5 仍需先完成 capability contract、唯一 owner、production consumer、durable recovery、security/redaction 和受控 external evidence；inventory 不等于实现。 |
| H1 model/usage fallback、fallback chain、Anthropic server fallback | 没有完整可审计 Model Router/credential cooldown/fallback chain production policy。 | `retry.modelFallback`、usage reserve、fallback chains、server-side fallback 未进入 canonical schema。 | `deferred` | 需要 manifest/auth 验证、usage source、cooldown/revert、fallback event、interactive/background 双路径和未知 usage fail-closed。 |
| H1 advanced compaction：idle/remote/handoff/snapcompact/loop | 只有本地 checkpoint/summarizer 基础路径；没有 remote/handoff 的 artifact、network、credential、stream cancellation、Host recovery contract。 | `compaction.idle*`、remote、handoff、snapcompact、`loop.mode` 未进入 canonical schema。 | `deferred` | 先完成 durable artifact、network/credential policy、abort/recovery 和 loop lifecycle，再接 settings。 |
| H2 external memory/learning：mnemopi、hindsight、autolearn、promotion、prewalk、memory model | 当前只有 local MemoryStore/Host domain；没有外部 memory backend 或 owner-fenced autonomous learning。 | `memory.backend` 不扩展到 hindsight/mnemopi；相关 credential、path、budget、debug keys 未进入 schema。 | `deferred` | local → mnemopi → hindsight 分开验收；必须有 proposal/approval/revoke/trust/scope/digest/TTL、budget、redaction、隔离 server 和主 Session failure isolation。 |
| H3 eval/interpreter/async execution | 没有 settings 驱动的 eval backend、interpreter 或 worker capability。 | `tools.format`、`eval.*`、`python.*`、`ruby.*`、`julia.*`、shell minimizer 未进入 canonical schema。 | `deferred` | 先接 Process/ExecutionGateway、cwd/env/output/timeout/abort/cleanup/recovery；settings 不能成为 sandbox bypass。 |
| H3 browser/computer/device/speech | 没有完整 computer/browser/STT/TTS/live voice capability、consent 或 managed lifecycle。 | `computer.*`、`browser.*`、`stt.*`、`tts.*`、`speech.*` 等未进入 schema。 | `deferred` | 需要 permission/consent、device/process boundary、credential/network policy、cleanup、timeout/abort、TUI presentation 和受控环境证据。 |
| H3 search/fetch/network services | 当前没有 oh-my-pi 等价的 web search provider、browser relay、vault、GitHub 或 ask/speech service settings consumer。 | `providers.webSearch*`、`exa.*`、`searxng.*`、fetch/vault/GitHub/security/ask keys 未进入 schema；forward proxy/gateway 不等于 search service。 | `deferred` | 先固定 governed network capability、host allowlist、timeout/output budget、credential redaction 和 controlled server smoke。 |
| H4 provider roles、auth broker、Codex resets | Provider catalog、Models/auth 和 forward proxy/gateway 已有，但没有 tiny/model role、credential broker 或 reset automation 的等价 capability。 | `providers.tinyModel`、`providers.memoryModel`、`auth.broker.*`、`codexResets.*` 未进入 schema。 | `deferred` | 每项需要 authenticated credential boundary、timeout/budget、failure/recovery、receipt/trace redaction 和真实 transport evidence。 |
| H4 collab/share：relay、web、share store/redact | 没有 authenticated collaboration relay 或 session share protocol。 | `collab.*`、`share.*` 未进入 schema；URL/token 不能当普通 listable setting。 | `deferred` | 先冻结 identity、owner/driver/observer、disconnect/recovery、publish-before-redaction 和 endpoint/store policy。 |
| H4 marketplace/update/notify/magic keywords | 没有 marketplace install/update、统一 notification 或 magic-keyword capability。 | `marketplace.*`、`completion/error/ask.notify`、`magicKeywords.*` 未进入 schema。 | `deferred` | 需要 consent、来源/签名、rollback/fail-closed、startup/input consumer 和隔离 external service tests。 |
| H5 secrets、autoqa、commit side effects | 没有统一 secrets manager、autoqa push consent 或 settings 驱动 commit/map-reduce side-effect policy。 | `secrets.*`、`dev.autoqa*`、commit map-reduce keys 未进入 schema。 | `deferred` | 先统一 credential/output/Trace/Artifact redaction，再做 consent、endpoint/token 隔离、Git side-effect gate；token 不进入 list、digest、trace、artifact、error 或 transcript。 |
| H5 automatic GC/retention | 只有显式 migration/prune 边界，没有自动 GC worker。 | `gc.*` 未进入 schema。 | `deferred` | 需要 retention manifest、停止/恢复规则、审计、故障演练和隔离 user-home 测试；不能由一个布尔开关隐式打开删除。 |

## 6. 明确的 fail-closed 与不可扩大边界

| 场景 | 当前结果 | 不能由 settings 改变的事实 |
|---|---|---|
| unknown/legacy path | schema loader 清洗未知字段；CLI service 返回 `unknown_path`；已移除的 `agentIdleTtlMs`、`maxEffort`、Goal/title/Todo 新键等不会获得 authority。 | 不能通过把字段写进 JSON 获得未实现能力。 |
| invalid/type/range/scope | resolver 收集 `invalid_value`、`out_of_range`、`scope_not_allowed`，使用安全默认或拒绝写入；workspace/user scope 按 schema 限制。 | 不能用非法值扩大资源、权限或 provider authority。 |
| approval | `tools.approvalMode` 只产生 typed projection。 | 最终 Security/Approval/ExecutionGateway deny、sandbox、network 和 credential policy 优先。 |
| provider disabled / unsupported | disabled provider 进入 typed deny；没有统一 retry consumer 的 provider 保持 unsupported/原有错误语义。 | 不自动切到未授权 provider/model，不用 UI 隐藏伪造禁用。 |
| provider concurrency | gate 只限制同一 Session 的 in-flight 请求并支持 abort/release。 | 不授予新的 provider、credential、网络或 fallback authority。 |
| task policy | task settings 仅以 `Math.min`/disabled role 等方式收窄 child runtime；M1 hard ceiling 仍由 bounded domain/owner/fence 持有。 | `maxConcurrency`、`maxRecursionDepth` 不能扩大并行、递归或 child authority。 |
| workspace roots | additional directories 先过 canonical path adapter、containment、symlink/root identity 校验；公共 DTO 只暴露 digest/count。 | raw path、越界路径、跨 root 或 symlink 不能直接进入模型/工具 authority。 |
| memory/Plan disabled | `memory.backend=off` 返回 `memory_backend_disabled` 且不注入 memory context；`plan.enabled=false` 关闭 Plan operation/context/capability。 | 不删除 canonical records，不由 TUI 绕过 Host domain。 |
| sensitive high-complexity settings | secrets、broker token、autoqa token、external memory credential 未进入普通 schema/list/digest。 | 没有 redaction/consent/credential boundary 前不开放字段。 |

## 7. Fresh validation 记录

本文档/README/index 更新后，必须在当前 worktree 重新执行以下 gates；结果只记录本次执行，不引用主 worktree 或历史 candidate 数字：

| gate | 本轮结果 | 备注 |
|---|---|---|
| `git diff --check` | PASS | 当前 worktree diff 无 whitespace error。 |
| `npm run check` | PASS | current-format、storage/runtime/execution/platform/session-owner/TUI boundary、Rust 12 tests 和 bash AST assets 均通过。 |
| settings/runtime focused tests | PASS | 本轮 targeted run 为 22 Vitest files、198 tests，覆盖 schema/policy/manager、RuntimeStore、CLI、retry/compaction/provider/tool/workspace、SettingsPanel、read Markdown projector、status symbols、theme accessibility 和 selector；全量 npm test 同时覆盖其余 settings/runtime candidate tests。 |
| `npm test` | PASS | Vitest 463 files passed、1 skipped；2877 tests passed、3 skipped；随后 Bun/OpenTUI 128 tests、1024 assertions 通过。 |
| `npm run test:tui-native` | PASS | 已由 `npm test` 的第二阶段执行；Bun OpenTUI 128 tests、1024 assertions 通过。 |
| `npm run build` | PASS | TypeScript、Linux helper、syntax highlighter、TUI assets 和 Host build manifest 均完成。 |
| isolated `RUNLEDGER_DIR` compiled CLI smoke | PASS | 全局 shim 指向当前 worktree；`--version`/`--help`、settings `list/get/set/reset`、`workspace capability` 通过，canonical settings 文件 mode 为 `0600`。 |
| isolated compiled CLI/TUI smoke | PARTIAL | 隔离 `RUNLEDGER_DIR` 下验证 symbol/color-blind settings get/set/reset、0600 权限和 tmux Welcome 启动 frame；当前自动探针的 Esc、Esc、Ctrl+D 未 clean exit，不能把随后终止新建 session 计为通过。 |
| standard PATH TUI / human acceptance | pending | 本轮未把自动 tmux frame 或自动测试冒充人工视觉/安全验收；自动测试与 human gate 仍分开。 |

## 8. 统一解封门与下一步

任一 group 进入 `implemented` 前，必须同时具备：typed schema/default/range/authority；immutable snapshot、source diagnostics 和 digest；真实 production consumer；默认/覆盖/非法/层级/CLI 测试；跨模块组合链；以及在涉及 provider/network/process/credential/TUI 时的受控 transport、abort、timeout、cleanup、redaction、recovery 和 human evidence。

本矩阵之后的顺序固定为：先完成 L0/M0 的 contract 与 snapshot acceptance，再按 M1 retry、M2 compaction、M3 tool/memory、M4 provider、M5 workspace/session 分片验收。H0 必须覆盖 fallback、remote compaction、external memory、browser/speech/search、collab/share/broker、secrets/autoqa/GC；这些 capability 未闭合前，不新增对应 schema 占位字段。
