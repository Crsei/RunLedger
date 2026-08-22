# H0 高复杂度 Capability Inventory

> 状态：deferred。核对基线：RunLedger b23b900（2026-08-22）；目标 worktree：worktree/settings-runtime。
>
> 本文是高复杂度 settings 的解封前盘点，不是实现清单；schema、mock、相邻能力或 candidate 接缝都不等于 production consumer。未知路径继续 fail closed。

## 1. 判定规则

本表把两个缺口分开：

- settings missing：没有 canonical schema、authority 或有效值解析，直接写 JSON 不能获得能力。
- capability missing：即使有相邻类型、工具或 provider，仍没有可审计的 production owner、consumer、生命周期和安全边界。

每一行都覆盖 settings、capability、owner/consumer、authority/credential、network/process effect、durability/recovery、tests/evidence 和 deferred reason。partial 只表示可复用接缝，不表示高复杂度 slice 已完成。

## 2. H1：fallback 与高级 compaction

| slice / candidate keys | settings 与 capability | owner / consumer、authority / effect | durability / recovery | tests / evidence | deferred reason / 解封条件 |
|---|---|---|---|---|---|
| Model/usage fallback：retry.modelFallback、retry.usageAwareFallback、retry.usageReservePct、retry.usageReservePolicy、retry.fallbackChains、retry.fallbackRevertPolicy | settings missing；capability missing。Models、provider catalog、CredentialStore、RetryPolicy 没有 fallback router、usage source、cooldown owner 或 fallback event consumer | 尚无 Model/credential authority；会产生额外 provider 请求、credential 轮换和模型切换 | 没有 primary/fallback decision、cooldown、revert、receipt 的 durable record；owner takeover 无法恢复 fallback 状态 | retry policy、provider gate、Codex transport 只证明重试接缝，不证明 fallback | 先完成已验证 manifest/auth 的 Router decision、usage unknown fail-closed、cooldown/revert、审计事件和 interactive/background 组合测试 |
| Anthropic server fallback：providers.anthropic.serverSideFallback | settings missing；capability missing。Anthropic wire 没有 RunLedger-owned beta/header/error semantics consumer | 需要 provider credential、header、网络请求和错误分类 authority | 需要 terminal event、abort、重连和恢复语义；无 server-fallback receipt | Anthropic/provider catalog 测试不是 server fallback evidence | 先完成受控 wire fixture、header/错误协议、credential redaction、abort 和 terminal event 验证 |
| Idle/remote/handoff compaction：compaction.idleEnabled、idleThresholdTokens、idleTimeoutSeconds、compaction.handoffSaveToDisk、remoteEnabled、remoteStreamingV2Enabled、supersedeReads、dropUseless | settings missing；local compaction 只有 partial 接缝，remote/handoff capability missing | CompactionPolicy、cut planner、checkpoint store 是相邻 owner；remote 还需要 network、credential、Artifact/CAS、stream cancellation 和 Host/Session authority；idle 需要 owner timer/fence | 当前只有本地 checkpoint/replay；没有 remote artifact、handoff lease、取消、crash takeover 和恢复协议 | compaction cut/checkpoint/agent-loop 测试只覆盖本地路径 | 先冻结 artifact/network/credential/owner contract，再做 deterministic remote server、abort、timeout、cleanup、recovery 和 CLI/TTY acceptance |
| Snapcompact/loop：snapcompact.systemPrompt、toolResults、shape、loop.mode | settings missing；capability missing。当前没有 snapcompact strategy family 或 prompt/compact/reset loop owner | 会改变 context、tool result 和继续执行语义；不能绕过 agent-loop、ledger 或 model request policy | 没有 loop state、supersede、terminal/replay 记录 | 当前 compaction tests 不覆盖这些 strategy/lifecycle | 先实现并审计 strategy/loop lifecycle，再定义 schema、默认值和恢复矩阵 |

## 3. H2：外部 memory 与 learning

| slice / candidate keys | settings 与 capability | owner / consumer、authority / effect | durability / recovery | tests / evidence | deferred reason / 解封条件 |
|---|---|---|---|---|---|
| Autolearn/promotion/prewalk：memories.enabled、autolearn.enabled、autolearn.autoContinue、contextPromotion.enabled、prewalk.enabled | settings missing；capability missing。local MemoryStore/Memory domain 没有 owner-fenced 自动学习、promotion 或 prewalk lifecycle | 会自动读取/提取上下文并影响 prompt；需要 approval、trust、scope、budget 和 Session Owner authority | 需要 proposal/approval/revoke、TTL、digest、owner fence、crash recovery；不能靠内存 timer | memory proposal/approval/search/persistence tests 只证明被动 local domain | 先完成 durable lifecycle 和 failure isolation；disabled 不得删除记录，未批准内容不得进入 prompt |
| mnemopi.*（dbPath、bank/scoping、embedding、LLM、credential、recall/retain/debug） | settings missing；capability missing。没有 Mnemopi adapter、store owner 或 production consumer | 涉及本地 DB path、embedding/LLM provider、credential、token/IO budget；路径不能成为 workspace bypass | 需要独立 store、锁、迁移、损坏恢复、scope/trust/digest 和主 Session 隔离 | 当前 local MemoryStore 及其测试不能替代 Mnemopi evidence | 按 local → mnemopi 完成 contract、隔离 DB、redaction、budget、recovery 和受控 provider/server 测试 |
| hindsight.*（apiUrl、apiToken、bankId、scoping、retainMode、recallBudget、mentalModel、timeout/debug） | settings missing；capability missing。没有 external memory network owner/consumer | apiUrl/credential 是 network authority；必须经过 host allowlist、timeout、output cap 和 credential redaction | 需要 approved-only projection、retry/abort、remote failure isolation、reconnect 和 durable audit | 没有受控 Hindsight server smoke；forward proxy/gateway 不等于 memory service | 先完成 network/security/credential port、proposal/approval/revoke、isolated server smoke 和主 session failure isolation |
| providers.memoryModel | settings missing；capability missing。title/summarizer model 路径不能作为 memory role consumer | 需要 model manifest、provider auth、budget 和 role-selection authority | 需要 role selection、failure/recovery 和 trace redaction；不能从 UI 临时值恢复 | model catalog/provider tests 不证明 memory role | 先完成 tiny/local/online role contract，再接 settings；未知 provider/model 必须拒绝 |

## 4. H3：新工具、解释器、设备和语音

| slice / candidate keys | settings 与 capability | owner / consumer、authority / effect | durability / recovery | tests / evidence | deferred reason / 解封条件 |
|---|---|---|---|---|---|
| Eval/interpreter：tools.format、eval.py/js/rb/jl、python.kernelMode/interpreter、ruby.interpreter、julia.interpreter、shellMinimizer.* | settings missing；capability missing。stdlib tools、ExecutionGateway 和 managed process 没有这些 interpreter/eval consumer | subprocess、cwd/env、output、timeout、可能的 network/credential；settings 不能成为 sandbox bypass | 需要 worker lifecycle、SIGTERM/abort、cleanup、output artifact 和 crash recovery | 当前 Bash/LSP/process tests 只证明已有 governed paths | 先定义 backend effect/cap、gateway/approval contract、隔离运行器和 recovery，再接 schema |
| Tool protocol/extended behavior：tools.intentTracing、abortOnFabricatedResult、maxTimeout、xdev、xdevDocs、xdevInlineDevices、checkpoint.enabled、fetch.enabled、vault.enabled、github.*、security.enabled、ask.* | settings missing；capability missing。现有 tool registry 没有完整 consumer | 可能涉及 network、credential、filesystem、user consent 和 tool-result trust | 需要 attempt/receipt、abort、timeout、cleanup、redaction 和 replay semantics | existing tool registry/security tests 只覆盖已注册工具 | 逐工具完成 contract、owner、Security/ExecutionGateway 接线和 controlled tests；unsupported 不回退 unrestricted local I/O |
| Browser/computer/device：computer.*、browser.* | settings missing；capability missing。没有 managed browser relay、CDP、computer/device owner 或 TUI consent consumer | device/process/network/credential effect；需要 permission/consent、workspace boundary 和 display limits | 需要 browser/process cleanup、disconnect、timeout、abort、recovery 和 client ownership | 没有 browser/computer controlled server/device evidence | 先完成 permission/managed lifecycle/isolated environment，再开放 capability settings |
| Speech/live voice：stt.*、ttsr.*、speech.*、live.voice、providers.tts、tts.localModel、tts.localVoice、speechgen.enabled | settings missing；capability missing。没有 STT/TTS/live voice provider、device lifecycle 或 TUI consumer | microphone/speaker/device、network、credential 和 persistent audio effect | 需要 stream cancellation、device release、timeout、redaction 和 reconnect recovery | 当前无受控 audio/device runner；普通 provider tests 不适用 | 先定义 consent、device/process/network boundary、cleanup 和 transcript/audio redaction，再做 controlled evidence |
| Network service tools：fetch、vault、GitHub、ask 的高复杂度部分 | settings missing；capability missing。forward proxy/gateway 不是这些 service consumer | external network、host allowlist、credential、redirect、output budget 和 user consent | 需要 request abort、retry classification、artifact redaction、durable audit 和 service failure isolation | auth-gateway/upstream proxy smoke 只证明 model proxy | 先完成 governed network capability 和 isolated server smoke，再决定逐 key schema |

## 5. H4：搜索、provider roles、协作与更新

| slice / candidate keys | settings 与 capability | owner / consumer、authority / effect | durability / recovery | tests / evidence | deferred reason / 解封条件 |
|---|---|---|---|---|---|
| Web search：providers.webSearchOrder、webSearchExclude、webSearchTimeoutSeconds、webSearchGeminiModel、exa.*、searxng.* | settings missing；capability missing。没有 web search provider registry、network tool 或 Session consumer | external network、API credential、host allowlist、redirect、result/output cap | 需要 timeout/abort、provider failure isolation、redacted audit 和 cache/recovery policy | provider catalog and auth-gateway tests 不证明 search service | 先完成 governed search capability、local controlled server、credential redaction 和 provider selection contract |
| Provider roles：providers.tinyModel、tinyModelDevice、tinyModelDtype、memoryModel、autoThinkingModel、autoThinkingMaxEffort、unexpectedStopModel | settings missing；capability missing。只有普通 model selection/title/summarizer seams，没有 role router | 需要 manifest/auth、role-specific budget、provider/network effect；不得把任意字符串送入 wire | 需要 role decision、fallback/error/recovery 和 trace redaction | model selection/provider tests 不能替代 role matrix | 先完成 role contract、catalog/auth validation、budget and failure evidence；附录 A 思考策略仍不在本 inventory 解封 |
| Auth broker/Codex reset：auth.broker.url、auth.broker.token、codexResets.* | settings missing；capability missing。auth-gateway 是 user-local forward proxy，不是 credential broker 或 reset automation owner | token/credential、external network、account mutation；token 不得出现在 list/digest/trace/error | 需要 broker lease、rotation、recovery、receipt 和 account-side rollback/stop rules | auth storage/OAuth/gateway tests 不证明 broker/reset | 先冻结 credential broker/reset authority、consent、redaction、rate limit 和 controlled endpoint evidence |
| Collaboration/share：collab.relayUrl、webUrl、displayName、share.serverUrl、store、redactSecrets | settings missing；capability missing。没有 authenticated relay/share protocol、driver/observer owner 或 publish consumer | external network、identity、session content、share redaction；URL/token 不是普通 display setting | 需要 disconnect/reconnect、owner fencing、publish-before-redaction、durable share receipt | multi-client Host tests 不等于 collaboration/share evidence | 先完成 identity/driver/observer/protocol/store/redaction/recovery，再接 endpoint settings |
| Marketplace/update/notify/magic：marketplace.autoUpdate、completion.notify、error.notify、ask.notify、magicKeywords.* | settings missing；capability missing。没有 signed marketplace/update、notification service 或 input keyword consumer | external install/update、source/signature、user consent、可能的 desktop/device effect | 需要 rollback/fail-closed、startup/input recovery 和 install receipt | startup/TUI tests 不证明 update/notification/magic capability | 先完成 source/signature/consent/rollback 和 isolated service tests；endpoint/token 不进入普通 list |
| Branch summary/commit map-reduce：branchSummary.enabled、commit.mapReduce.* | settings missing；capability missing。无 branch-summary 或 commit map-reduce production owner | Git/filesystem write side effect、possibly model/network/credential；需要 explicit user consent | 需要 plan/receipt、partial failure recovery、idempotence 和 Git rollback/stop boundary | workspace/Git porcelain tests 不证明 commit side effect | 先完成 read/write/commit authority、consent、recovery and controlled Git evidence |

## 6. H5：敏感数据与运维副作用

| slice / candidate keys | settings 与 capability | owner / consumer、authority / effect | durability / recovery | tests / evidence | deferred reason / 解封条件 |
|---|---|---|---|---|---|
| Secret management：secrets.enabled | settings missing；capability missing。CredentialStore、Trace/Artifact redaction 没有统一 secrets manager consumer | credential/secret authority 会影响日志、prompt、artifact、error 和 tool-output redaction | 需要 rotation、redaction policy version、recovery 和 no-leak audit | credential storage/redaction tests 不是统一 secrets manager evidence | 先统一 credential/output/Trace/Artifact redaction 和 owner policy；secret 不得进入 list/digest/transcript |
| AutoQA/report push：dev.autoqa、dev.autoqaPush.endpoint、dev.autoqaPush.token、dev.autoqaConsent | settings missing；capability missing。无 autoqa producer、consent flow 或 push owner | external network、Git/test artifact、credential token、user consent；可能产生外部发布 | 需要 consent receipt、retry/abort、redaction、deduplication、failure/recovery 和 endpoint allowlist | 本地 test/build gates 不证明外部上报；token 无受控 server evidence | 先完成 report schema、consent、redaction、isolated endpoint 和 push recovery；默认 disabled |
| Automatic GC/retention：gc.blobs、gc.archive、gc.wal、gc.coldArchiveAfterDays、gc.retainNewestGlobal、gc.retainNewestPerCwd | settings missing；capability missing。explicit storage migration/prune 不是 automatic GC worker | destructive filesystem/storage effect；需要 deletion authority、manifest、scope and stop rule | 需要 plan/verify/delete receipts、restart/recovery、partial failure 和 user-home isolation | prune/migration tests 只证明 explicit command semantics | 先冻结 retention manifest、dry-run/confirmation/stop/recovery 和 isolated user-home evidence；不得由启动 settings 隐式删除 |
| Git write-side-effect slice：git.enabled 的 commit/write 语义 | settings missing for this capability slice；现有 read/status 不是 capability consumer | capability missing。Git porcelain/status consumer 存在，但没有 settings-owned commit/write-side-effect owner | workspace/Git write authority、approval、possibly network push；不能绕过 workspace containment 或 ExecutionGateway | workspace adapter/status tests 不证明 write side effects | 保留现有 read/status 边界；write/commit capability、consent、receipt、rollback/recovery 独立验收后再接 settings |

## 7. 统一解封门

任何一行从 deferred 移出前，必须同时具备：

1. capability contract、唯一 owner、真实 consumer 和 authority boundary；
2. typed settings schema/default/range/scope，以及 immutable snapshot、source diagnostics 和 digest；
3. default/override/invalid/unknown/layer/CLI tests；
4. 涉及 provider/network/process/device/credential 时的受控 transport、timeout、abort、cleanup、redaction；
5. durable state、receipt、fence、recovery 和 duplicate/idempotence evidence；
6. 隔离 RUNLEDGER_DIR 的 compiled CLI/Host/TUI 验收，以及必要的 human security/visual evidence。

没有 capability 的行保持 settings missing + capability missing；不能先加空字段。已有 local Runtime、forward proxy、provider catalog、TUI 或 migration command 只能作为后续实现接缝，不能改变本表的 deferred 判定。

## 8. 本轮证据边界

本轮最新仓库门禁证明代码 candidate 没有破坏现有边界：npm run check、settings/controller/session focused tests、npm run build、全量 Vitest 和 Bun OpenTUI 均通过。它们不证明上述高复杂度 capability 存在，也不构成 external provider、browser/device、collab、secret、autoqa 或 automatic GC 的验收。
