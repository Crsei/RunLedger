# RunLedger Plan Mode、Model/Context、Compaction 与 Memory 建设计划

> 状态:专项权威执行计划;Memory 纯核心已有行为切片,但标准 Session Owner 生产入口仍为 `operation_unavailable`;Memory 交付按 Phase 8 的 M0–M8 推进
> 基线日期:2026-07-22;行为切片校准:2026-08-04;Session Owner 交付审计:2026-09-04
> 适用范围:`src/runtime/`、`src/storage/`、`src/tui/`、`src/cli/`、canonical `runledgerHome` 与对应测试
> 参考取证:[`00-reference.md`](00-reference.md)
> 上位计划:[`../runtime/04-governed-agent-harness-runtime-plan.md`](../runtime/04-governed-agent-harness-runtime-plan.md)
> 生产 Session Owner Runtime 权威:[`../runtime/06-session-owner-runtime-replacement-plan.md`](../runtime/06-session-owner-runtime-replacement-plan.md);旧 Host 仅作为迁移输入:[`../runtime/05-multi-client-background-terminal-refactor-plan.md`](../runtime/05-multi-client-background-terminal-refactor-plan.md)。新行为不得继续扩展 machine/workspace Host。

## 0. 文档定位与执行规则

本文件是 Model Compatibility 行为、Plan Mode、ContextEngine、Compaction 和 Memory 的唯一详细执行账本。上位 Runtime contract 计划独占公共数据结构、TypeBox schema、current event payload、fixtures 和 contract tests;本文件只消费这些契约,负责具体 router/reducer/service/store/算法、文件边界、PR 顺序、行为测试和逐项完成证据。不得再创建同主题 sibling plan 分散状态。

生产接线必须服从 Session Owner Runtime:标准 CLI/TUI 是轻客户端,每个 session 只有当前 owner 持有 `Agent`、canonical writer、Queue 与 mutation authority。本专项的 mode/model/compact/memory command、query、subscription、approval 和 reload 都通过 SessionRuntime domain;client 不直接调用 `InteractiveSessionController`、不持有 store/service,也不创建第二 writer。localhost transport、driver/observer、owner generation/driver revision fencing、durable command intent/attempt receipt 与 recovery 由 `runtime/06` 拥有,本文件只定义这些机制如何消费本领域 service。

### 2026-09-05 Plan Session Owner 接线

[Runtime 10](../runtime/10-agent-mode-entry-implementation-plan.md) 本次授权全部阶段，`plan@1` 在 `session-runtime/plan-domain.ts` 生产装配 Plan authority。沿用本专题 reducer/artifact store；计划正文与 revision 以 bounded、owner-fenced Session events 持久化并重放，mutation 经过 Attempt Gateway。工件没有任意文件路径，模型不能批准自身计划。

新会话自动进入 active；`plan.write` 后 `plan.request_approval` 绑定 artifact revision/digest，`plan.resolve_approval` 再绑定 approvalId 与 state revision。拒绝后可修改，取消结束流程，批准后 `plan.settle_exit` 结束。`/plan` 分页审阅固定正文，CLI 对称提供 inspect/write/request_approval/approve/reject/cancel/settle_exit。完成后需要新 Plan 会话才能重新发起流程。

Plan harness 的五工具为 read/glob/ls/plan_read/plan_write，禁用扩展与 child，不注册 process mutation；工具 admission 拒绝未知效果，仅 composition 注入的工件 writer 实例有例外，执行环境进一步拒绝 shell/network/工作区 mutation。审批或退出不改变 immutable profile；实施需 `/mode default` 新建会话。default/minimal 仍只有被动 Plan inspect，不隐式变为 Plan。Memory/Compaction 的既有交付状态不因这项接线改变。

自动化与真实 CLI/TUI 门禁以 Runtime 10 记录为准；不将 mock/PTY 结果写成人工或跨平台验收。

### 0.1 2026-08-04 当前实现切片证据

以下是当前分支已提交独占切片的局部行为证据，不代表本专项或对应产品阶段完成。复选框约定：`[x]` 表示当前切片有直接实现与测试，`[~]` 表示部分实现或仍缺生产接线，`[ ]` 表示尚未实现。

- `src/runtime/context/{context-engine,token-estimator,runtime-adapter,projection,invariants}.ts` 与 `cut-planner.ts` 已提供稳定 fragment 排序、预算/硬上限、digest 校验、tool batch 安全 cut 和结构化 omission/invariant 行为；Context 行为定向回归为 10 files / 39 tests（含 Plan Mode reducer/store）。
- `src/runtime/context/compaction/checkpoint-store.ts` 已提供内存 checkpoint port：`planned -> started -> completed/failed`、attempt 单调、幂等 replay、schema/invariant/session/source-range 校验、`get/list/latest`；`compaction-checkpoint-store.test.ts` 为 7 tests。
- `src/runtime/context/memory/{store,persistence}.ts` 已提供 proposal/approval/reject/revoke、scope 隔离、bounded lexical search、TTL/digest drift 过滤、注入式 exact snapshot persistence；approved proposal snapshot 现在额外绑定 record 的初始 digest，memory 定向测试为 2 files / 6 tests。
- `src/runtime/modes/plan/{reducer,artifact-store}.ts` 已提供 Plan Mode 合法 transition、immutable revision、working pointer、approval pin、外部 digest drift invalidation 与 exact snapshot restore；`reducer-store.test.ts` 为 6 tests。Approval receipt digest 计算不包含后置生成的 `receiptId`。
- 阶段提交证据：`68dab74`（`feat(plan-context): add bounded plan and memory behavior`），只包含上述 `src/runtime/context/**`、`src/runtime/modes/plan/**` 与对应测试路径；提交前 `git diff --cached --check` 通过。
- 本地验证证据：`npm run check`、`npm test`（Vitest 144 files / 746 tests，Bun TUI 5 files / 44 assertions）、`npm run build`、`git diff --check` 均通过；该提交已落在当前分支，尚未 push。

仍未实现或未接线：Model Compatibility Router、Plan Mode SessionRuntime durable command/Capability Gateway/approval UI、真实 summarizer 与 compaction intent/commit、auto overflow/resume/fork/rewind/model switch、canonical Memory SQLite records/可重建 index、SessionRuntime operation/receipt/event 与 CLI/TUI 闭环。故不得把当前切片标为 Phase 0–10 或专项完成。

### 0.2 2026-09-04 Memory 交付审计与接管结论

本节覆盖 0.1 中旧 Host 时代的 Memory 生产接线判断。纯函数和 legacy Host 测试只作为可复用输入,后续完成状态只由 Phase 8 的 M0–M8 与 Session Owner 证据更新。

当前生产调用链为:

```text
src/cli/main.ts
  -> src/cli/embedded-session-runtime.ts#createEmbeddedSessionRuntime
  -> src/runtime/session-runtime/domain.ts#assembleSessionDomain
  -> SessionRuntime domain operation manifest
```

审计结果:

- 标准 Session Owner composition 尚未注入 Memory repository/service、operation domain、Agent tools、settings 或 model-context source。
- 隔离 `RUNLEDGER_DIR` 实测 `runledger memory search release` 返回 `operation_unavailable`;文档宣称的 `runledger remember <text>` 被 parser 当作 action 并返回 `unsupported remember action`;显式 `runledger remember propose <text>` 最终仍为 `memory.propose operation_unavailable`。
- `src/runtime/context/memory/{store,persistence,projection}.ts` 已覆盖 proposal/approve/reject/revoke、TTL/digest 过滤、有界 lexical search、exact snapshot codec 与只读 projection;这些是纯核心证据,不是标准 CLI 交付证据。
- `src/cli/runtime-host-model-context.ts` 是 legacy Host 实现,不得再作为生产 authority。其已知缺口包括 Agent proposal digest 构造错误、TUI proposal 缺 provenance、自动注入没有 query、internal tool path 丢弃 domain event、`memory.search_recorded` 无 producer,以及 user scope 实际落在 workspace 分区。
- 2026-09-04 定向验证为 9 files / 58 tests passed,主要证明 contract、纯核心、legacy Host 与工具 wrapper;它不证明 Session Owner persistence、operation、restart/takeover、CLI/TUI 或真实 model-context 注入。

因此当前交付状态固定为:**core partial, production unavailable**。只有标准 CLI 经 Session Owner 完成 proposal -> approval -> restart -> search -> injection 全链路,且 response-loss/takeover 不重复 mutation 后,才能提升为 production partial;M8 全部门禁闭合后才能标记 implemented。

下文不再使用上位 Runtime 的旧阶段编号,统一采用以下稳定契约域名称:

- “Runtime Foundation 契约域”指 [`04` 的 current format 与协议基础](../runtime/04-governed-agent-harness-runtime-plan.md#contract-foundation);
- “Runtime Event 契约域”指 [`04` 的 event 与 durable record](../runtime/04-governed-agent-harness-runtime-plan.md#contract-events);
- “Runtime Workspace/Security 契约域”指 [`04` 的 workspace、capability、approval 与 sandbox contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-workspace-security);
- “Runtime Artifact/Evidence 契约域”指 [`04` 的 artifact、checkpoint、episode 与 verification contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-artifact-evidence);
- “Runtime Resource 契约域”指 [`04` 的动态资源 contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-resources);
- “Runtime Model/Context 契约域”指 [`04` 的 Model、Plan、Context、Compaction 与 Memory contract](../runtime/04-governed-agent-harness-runtime-plan.md#contract-model-context)。

执行规则:

- 每次只实施一个可独立验收的 PR 边界,完成后在对应复选框补 commit、验证命令和结果。
- 上位 Runtime Model/Context 契约域的 allowlist 在本专项中是只读输入。不得在行为 PR 中顺手修改 `types.ts`、`schema.ts`、current event catalog 或 contract fixture,也不得重新定义同义类型。
- 没有 current durable event、Capability Gateway 或 Artifact Store 的阶段不得用 current 临时旁路伪装完成;可以先落纯 reducer/pure planner 等行为函数,但用户可见功能必须等待前置门禁。
- 没有 authenticated Session Owner Runtime、driver fence 和 durable command/attempt receipt 的阶段不得把 client-local slash handler、TUI boolean 或直接 controller 调用作为生产闭环。
- Session 只接受当前 exact format。Plan Mode、compaction checkpoint、memory approval 和 context receipt 只写入当前唯一真源。
- 不覆盖 raw ledger/history。Compaction 只改变 model-visible projection。
- 不把 prompt 约束当权限。所有副作用由 capability/effect gate 判定。
- 不把模型摘要当事实。Plan approval pin digest;compaction 校验 invariant;memory 先 proposal 后 approval。
- 实施前重新核对本文件列出的上游路径和 RunLedger 当前 HEAD,快照不是依赖锁。
- 每个代码 PR 必须运行完整 `npm run check` 与 `npm test`;涉及生成物、依赖或模型 catalog 时再执行仓库规定的额外命令。

### 0.3 2026-09-06 标准 Session 的目录准入与请求时历史转换

本节覆盖下文早期计划中“所有模型必须先写入 verified manifest”“普通模型切换必须 fork”的生产入口要求。用户明确要求采用 oh-my-pi 的模型目录与请求侧转换方式；参考本地 oh-my-pi `9bafadd503` 的 `model-controls.ts`、`model-thinking.ts` 与 `transform-messages.ts`，按 RunLedger 既有 authority 和 adapter 边界实现。

- 标准 CLI 的 `session-model-router.ts` 注入当前 `Models` 目录；不再读取用户级 model compatibility manifest。缺失、损坏或只包含其他模型的旧清单不阻止目录中的模型启动。未知模型、无凭据/不在 enabledModels 中的交互选择和不足的请求预算仍有明确错误，不静默替换用户指定的模型。
- `model.routed` 有界 receipt 继续持久化；写入失败仍禁止 provider dispatch。现有 manifest loader / `ModelCompatibilityRouter` 作为旧调用方的独立实现保留，不是标准 Session 的必经准入入口，也不代表真实 provider 已认证。
- 同一 Session 在空闲时切换模型，保留对话和可支持的思考程度；请求准入或执行期间拒绝模型/thinking 修改。先完成目录/认证配置/选择策略检查，再 owner-fenced 写入 `runtime.config`，最后修改活跃 Agent。Session 写入失败保留原选择；用户默认配置保存失败不撤销已提交的 Session 选择，并在 warnings 中说明。
- 请求侧 adapter 对历史副本移除跨模型私有签名、将可见推理转为文本、规范化并去重工具 ID、将真实工具结果放回对应调用窗口，补齐明确标错的缺失结果。孤立结果仅作为低权限 user 文本保留。原始 Session 历史不改写；没有身份的旧记录保持 unknown，不用当前模型回填猜测。预算按转换后的历史估算，省略的图片不会按原始 base64 大小阻止文本模型请求。
- Session 的 assistant 消息保留其自身 provider/model/api；provider 未提供身份时使用本次请求模型。Trace model span 已有 provider/model/api，继续保留。TrajectoryRecord 新增可选 provider/model/api，并以 provider/model 命名；可重建轨迹 cache 更新格式后从 Session/Trace 重建，关闭 recording 不影响必要 Session 记录。

行为回归入口：`tests/api/model-switch-history.test.ts`、`tests/runtime/model-routing/catalog-router.test.ts`、`tests/runtime/model-switch.test.ts`。覆盖真实 adapter 到本地 HTTP 服务的跨 provider 请求、同一 Session 恢复和切回、凭据/目录/持久化失败、请求期间的切换拒绝，以及 Session/Trace/轨迹模型身份。2026-09-06 验证：`npm run check`、`npm run build`、5 个相关测试文件共 35 tests、`git diff --check` 通过。`npm test` 在既有暂存测试 `tests/runtime/session-runtime/model-selection-policy.test.ts` 失败：其期待把显式配置的被策略排除模型静默替换为另一模型；原始提交 `bbc578c` 加入同一测试后复现失败。本轮未改动该测试，随后通过标准 bucket runner 补跑其余 177 个测试文件，全部通过；不记为完整 `npm test` 通过。

构建后的真实 PATH `runledger` 在独立 tmux/隔离 `RUNLEDGER_DIR` 验证通过：无 manifest 的 DeepSeek Pro 启动；本地 HTTP fixture A 执行 governed bash 工具后，同一 Session 通过 `/model` 切换至 B，B 请求包含 A 的工具结果；SQLite 与 Trace 模型身份为 A、A、B，`/trajectory` 显示对应 provider/model，Ctrl+D 退出码 0 且无残留测试进程。测试进程使用假凭据并清除代理变量，首次继承代理的脚本未完成登录。未调用真实 DeepSeek/provider，未完成人工视觉/中文 IME 或 macOS/Windows 验收。

### 0.4 2026-09-07 请求投影加固

[Plan 14](../plan/14-agent-harness-reliability-hardening-plan.md#51-2026-09-07-实施与确定性验证) 在既有 domain assembler 入口修复请求选择：历史按完整工具调用/结果依赖组原子选择，以数值顺序优先保留最近工作；当前目标、纠正、required 与 protected policy 优先，必需部分超限时明确失败。估算包含目标模型转换后的历史、system、实际工具 schema、输出 reserve 和请求 envelope；原始 ledger 不变。

`tests/runtime/context/model-request-adapter.test.ts` 与 `tests/runtime/session-runtime/harness-hardening.test.ts` 分别核对选择 receipt 和真实 HTTP 请求语义、配对及预算；标准 Session Owner 接线与构建后 CLI 另有隔离 home 证据。精确窄窗口和多调用组边界由 adapter HTTP 测试验证；`tests/manual/harness-repair/context.py` 另在 built CLI 连续提交 16 轮长输入，核对实际请求保留近期 12 轮、原始 SQLite 保留全部 16 轮、正常退出 0 且无残留进程。前置测试修正 `f1aca0b` 纳入后，完整 check/test/build 通过，证据见 Plan 14 §5.1。

此切片不装配 summarizer、自动 compact、durable context receipt sink、Memory 或模型 Artifact 全量检索；这些能力的生产状态仍由本专题各阶段判定。

### 0.5 2026-09-15 多策略 Compact 实施

接口和 C0–C5 约束见 [§6.5.1](#compact-strategy-adapter)。标准 Session Owner 已装配 single-pass、hierarchical 和 OpenAI Responses native 三种策略；`/compact` / `runledger compact run` 执行受控 mutation，`compact list` 保留查询入口。原始 ledger 不变；每次请求只读取已提交 replacement。自动触发默认关闭，显式启用后在预算选择前尝试压缩；overflow 只允许在尚无 provider 内容和工具执行的请求边界重试一次。

当前实现入口：`runtime/context/compaction/{strategy,summary-strategies,budgeted-model,history,settings,record}.ts`、`runtime/session-runtime/compaction-{domain,model,native-model}.ts`、`api/openai-compaction-state.ts`。`ContextEngine` 将 portable summary 作为 required history，native 窗口以带 digest/预算的 required history fragment 纳入选择，再由 Responses adapter 完整回传，均不变成 policy。

- 用户级 `settings.json` 的 `compaction` 控制策略与预算，workspace 配置拒绝覆盖。默认 `enabled=true`、`strategy=single-pass`、`auto=false`、`threshold=0.85`、保留最近 1 个完成轮次、单摘要 4096 tokens / 32000 bytes、最多 16 次模型调用 / 1000000 输入 tokens / 65536 输出预留 tokens、5 层、120 秒。数值边界以 `settings.ts` 为准；无效配置失败，不静默换策略。可选 `summaryModel: {provider,id}` 只用于 portable 策略；native 必须匹配当前 Responses 模型。
- `--strategy=single-pass|hierarchical|openai-responses-native` 只覆盖本次 manual 操作；其余文字是 focus hint。摘要调用无工具，复用 Models 认证、model route receipt、Trace，并禁用 provider 隐式重试。预算 usage 记录保守预留，Trace 保留 provider 返回的实际 usage。
- Owner 先写 started，生成并校验候选，持久化并同步 artifact，然后在一个 SQLite 事务内写 completed/failed 与终态 attempt receipt。checkpoint 引用实际 receipt 的 digest；restore 同时验证 chain、源前缀、receipt 和 artifact。持久化错误保留旧投影；工件损坏明确报错，不自动付费重生成。
- 普通 fork 继承 replacement 及来源证据，不继承 source attempt/approval authority。`/fork --raw` 或 `--fork <id> --fork-raw` 显式保留原始历史并放弃摘要投影，供切换不兼容 provider 使用。`/fork --at=<sequence>` 或 `--fork <id> --fork-at <sequence>` 从已完成 assistant 轮次边界创建回退分支，源 Session 保持不变；仅继承边界前已提交的压缩记录，拒绝 user/tool 中间边界。这里的回退是 fork，不提供原地删除历史。
- 原生窗口绑定 provider、模型、endpoint digest 和格式；不兼容切换失败且保留原选择。完整 `output` 包含 retained items 与 opaque compaction item，禁止截取或解释 encrypted_content；未知输出类型/格式失败。当前 reader 接受 message、reasoning、function_call、function_call_output、compaction。reader 不依赖策略仍注册。

验证记录（2026-09-15）：本地 HTTP + 真实 embedded Owner 覆盖手动两种 portable 策略、二次链、重启、取消/迟到、自动阈值/失败抑制、overflow 一次重试、native 完整窗口/恢复/切换、fork/raw fork/跨 cut 回退、工件和事务故障；源历史与 attempt receipts 均从真实 SQLite 核对。

本任务隔离副本（`9057668` + 本次 scoped 改动）的完整 `npm run check` 通过，完整输出保存在 `/tmp/runledger-compact-isolated-check3.log`；主工作树的该入口被并行文档提交 `96b0e15` 中 upstream 版本标记触发的 current-format 规则拦截，详见 `/tmp/runledger-compact-current-format.log`，未修改或删除并行内容。`npm run build` 通过。

默认 local 全部分桶验证完成：`npm test` 在隔离副本通过 fast / singleton / runtime / security-storage（492 文件、3288 测试）；随后 integration 因该副本缺少 dist 中止。主工作树的同一构建产物已补入副本，主工作树 `npm run test:integration` 重跑全部集成测试通过（27 文件、144 测试），`npm run test:tui-native` 通过（24 文件、156 测试）；日志依次为 `/tmp/runledger-compact-full-test3.log`、`/tmp/runledger-compact-integration-final.log`、`/tmp/runledger-compact-tui-native-final.log`。之前 Owner 十进程竞争用例出现一次 15 秒超时，独立复验及最终全量运行均通过，未调整测试阈值。

`tests/manual/harness-repair/compaction.py` 用 PATH CLI、隔离 home、本地 HTTP 和独立 tmux 验证受控 bash 的完整 call/result 进入无工具摘要请求、hierarchical 选择、raw ledger 不变、下一请求使用摘要与 tail、重启恢复，两次退出均为 0；退出后独立 CLI 的 `compact list` 与 `compact run --strategy=single-pass` 通过，确认第二次 compact 共用同一提交链且 raw ledger 不变，无遗留自有进程；结果 `/tmp/runledger-compact-cli-r27fyf3j/result.json`。**真实 OpenAI provider 待验收**（用户明确保留）；本地 HTTP 不等于真实 provider，自动化 TUI 不等于人工视觉/中文 IME 或跨平台验收。

### 0.6 2026-09-15 oh-my-pi 压缩服务接入入口

把 oh-my-pi 的压缩机制（token 预算切点与比率校正、摘要格式 seam 与迭代 update、文件操作清单、投影级剪枝、handoff、provider 原生流式压缩、`stopReason === "length"` 有界恢复）接入上述适配器的**增量**方案，见 [compact/README.md](../compact/README.md)、[compact/00-oh-my-pi-compaction-services.md](../compact/00-oh-my-pi-compaction-services.md)、[compact/01-integration-plan.md](../compact/01-integration-plan.md)。该目录只承载 omp 侧取证与接入阶段 O0–O7，不重复记账：本文件仍是 Model/Plan/Context/Compaction/Memory 的唯一执行账本，C0–C5 阶段状态、公共契约与 authority 以本文件与 `runtime/04` 为准；两者冲突时先改本文件再改该目录。O0 已基于 `9ab7977` 冻结接入合同（含 §4.4 契约变更顺序），未改变本节任何实现状态。O1 的 token 切点、provider usage 地板及本地生产验收已完成，O2 的迭代摘要、格式 registry 和文件清单，以及 O3 的确定性投影剪枝、O4 的 handoff 策略、O5 的原生流式压缩与有界 length 恢复本地验收也已完成（真实 OpenAI provider 仍待验收）；增量证据仅记在 `compact/01` 对应小节。

### 0.7 2026-09-16 Plan Mode 完整度对齐入口

Plan Mode 的用户可见行为交付（会话内进入/退出、mode instruction 与计划正文注入、模型侧进入与请求审批、审批决策集与 review 界面、实施交接、产物导出与 reentry、端到端门禁）转入 [02-plan-mode-parity-implementation-plan.md](02-plan-mode-parity-implementation-plan.md)。该文件以 oh-my-pi `3b3a6dc9bb` 的完成度为目标口径，按 P0–P7 记录阶段、文件边界、验证矩阵与验收证据。

归属边界不变：本文件仍是 Plan Mode 的 reducer/artifact/公共契约设计账本，§3.2 的行为合同、§6.2/§6.3 的 policy ceiling 与 §6.7 的事件建议继续有效；公共类型、schema 与 event catalog 的落地仍归 `runtime/04` 的 contract work package。**Phase 3–5 的复选框状态自本节起以 02 为唯一来源**，本文件对应章节只保留设计叙述与门槛，不再作为完成状态的判断依据；02 与本节冲突时先改本节设计前提再改 02。

## 1. 目标、成功标准与非目标

### 1.1 目标

构建一个可恢复、可审计、权限闭合的上下文体系:

1. 标准 Session 的模型选择与请求路由按 §0.3 使用目录、预算和请求侧历史转换；summarizer/compaction 的额外能力约束由其专项验证，不以普通模型已可用推断已通过。
2. 用户或 Agent 可进入 Plan Mode,只读探索并维护一个受版本控制的计划工件。
3. 计划必须经过结构化审批才能进入实施;批准内容以 revision + digest 固定。
4. 上下文接近模型窗口时可手动或自动 compact,但原始审计记录保持完整。
5. resume、fork、rewind、model switch 和 overflow retry 都能从 compaction checkpoint 确定性恢复。
6. 长期 Memory 区分 user/workspace/session 来源,支持有界检索、来源、TTL、撤销和审批。
7. compaction 前可以抽取 memory proposal,compaction 后可以重新注入 approved memory 和当前 Plan Mode 状态。
8. TUI、CLI 和未来 daemon/API 只消费同一 runtime command/query/event 协议。

### 1.2 用户可见成功标准

- 模型路由保留能力 digest/reason receipt；切换不静默复用跨模型 provider-private state，标准请求由 adapter 转换历史。
- `/plan` 或 CLI mode 设置进入 Plan Mode;footer/status 明确显示 `mode:plan`。
- Plan Mode 下 read/grep/find/ls/glob 等只读工具可用;write/edit/multi-edit/bash、未知副作用 MCP 和写型子 Agent fail closed。
- 只有专用 plan writer 能修改当前计划工件;外部篡改后旧审批自动失效。
- `exit_plan_mode` 打开计划审批界面,支持批准实施、fresh-context 实施、请求修改和取消。
- `/compact` 能在稳定 turn 边界生成 checkpoint;重启和 fork 后 model context 与压缩前逻辑一致。
- auto compact 有阈值、预留和单次 overflow recovery;失败不会无限重试。
- `/memory` 可浏览 approved/proposed/revoked record;`/remember` 先预览再批准。
- memory search 返回 record ID、scope、source、line/snippet、score/search mode 和 staleness。
- 每次 mode transition、compaction、memory proposal/approval/injection 都能从 canonical session/runtime records 找到 receipt。

### 1.3 首版非目标

- 不实现跨租户共享 memory、组织级远程 memory service 或 RBAC 管理后台。
- 不默认启用 embedding/vector search;首版 lexical index 可用且可重建。
- 不实现 grok-build 的 two-pass/prefire compaction,先稳定 single-pass。
- 不让 compaction summary 形成 verification pass、goal complete 或用户批准。
- 不让模型自动发布、覆盖或删除长期 memory。
- 不在 Plan Mode 开放任意 shell,即便命令表面看似只读。
- 不从无法通过当前 exact contract 校验的历史数据伪造 tool args、reasoning signature、memory provenance 或 compaction checkpoint。

## 2. 前置依赖与落地顺序

本专项承接上位 Runtime Model/Context 契约域冻结的公共契约,并在独占文件中实现行为。硬依赖如下:

| 前置能力 | 来源 | 本专项依赖点 |
|---|---|---|
| current strict Event Store、writer、reducer、snapshot、recovery | Runtime Event 契约域 + 独立行为计划与验证证据 | mode/checkpoint/approval/receipt 的唯一事实源 |
| Workspace identity 与 execution envelope | Runtime Workspace/Security 契约域 + Worktree/Sandbox/Permission 专项 | plan path、memory scope、artifact 引用不能跨 workspace |
| Capability Gateway 与 `deny > ask > allow` | Runtime Workspace/Security 契约域 + Worktree/Sandbox/Permission 专项 | Plan Mode 只读硬门禁 |
| Artifact CAS/metadata/retention/redaction | Runtime Artifact/Evidence 契约域 + 独立行为计划与验证证据 | plan revision、compaction input/output/diagnostic |
| Resource snapshot/effect contract | Runtime Resource 契约域 + Plugin/MCP/Skill/Hooks 专项 M2–M5 | memory/plan tool 可见性和 MCP 副作用分类 |
| Model/Plan/Context/Compaction/Memory 公共契约 | Runtime Model/Context 契约域 | 本专项全部 public type/schema/event/fixture 的唯一来源 |
| Session Owner Runtime、driver fence、durable command/attempt receipt | `runtime/06` 当前实现与验收状态 | 所有生产 command/query、approval、model switch、compact/memory mutation 和多客户端恢复 |

允许提前落地的内容只有消费已冻结契约的纯 reducer、pure planner、adapter 和行为 fixture。用户可见 `/plan`、`/compact`、memory write 必须等待对应门禁真实可用。

### 2.1 并行开发与文件所有权

| 路径/产物 | 唯一写入者 | 本专项规则 |
|---|---|---|
| `src/runtime/model-routing/{types,schema}.ts` | Runtime Model/Context 契约域 | 只读 import,不复制 manifest/decision 类型 |
| `src/runtime/modes/plan/{types,schema}.ts` | Runtime Model/Context 契约域 | 只读 import,只实现 reducer/service/policy/tools |
| `src/runtime/context/{types,schema}.ts` | Runtime Model/Context 契约域 | 只读 import,只实现 engine/estimator/invariants/projection |
| `src/runtime/context/{compaction,memory}/{types,schema}.ts` | Runtime Model/Context 契约域 | 只读 import,只实现 planner/service/store/search/approval |
| `src/runtime/protocol/{events,schemas}.ts` 对应 payload/catalog | Runtime Model/Context 契约域 | 只发射已注册 event,不新建临时 event |
| `tests/runtime-contracts/contracts/**`、`tests/runtime-contracts/fixtures/{model-routing,plan-mode,context,compaction,memory}/**` | Runtime Model/Context 契约域 | 只消费;behavior fixture 放专项目录 |
| router/reducer/service/store/index/tools/专用 TUI 组件 | 本专项 | Runtime Model/Context 契约域不得回写实现 |
| `agent-loop.ts`、Session Owner composition、`models*.ts`、`src/cli/**`、`src/tui/**`、`src/index.ts` | 串行集成 PR 的当期单一所有者 | 先交付 adapter,再通过 SessionRuntime command/query/subscription 集成;禁止恢复 client-local controller authority |

并行窗口内的稳定分工:

1. 其他 Runtime 行为 owner 可继续修改自己的独占模块,本专项在 behavior path 实现 Model Router、Plan、Context、Compaction 和 Memory;双方都不直接修改对方的独占路径。
2. 需要连接 Event Store、Gateway、Artifact、Extension snapshot、Orchestrator 或 Session Owner 时,本专项先增加内部 adapter 并用 fake port 验证;共享根文件留到阶段的串行 integration commit。
3. 串行集成前必须记录基线 commit、当期所有者和显式路径;handoff 期间其他计划不改同一文件。
4. 上位 Runtime Model/Context 契约域完成只表示 contract 已冻结。本专项 Phase 10 完成后不向上位 contract 计划回写行为状态或复制实现 checklist;行为完成证据只保留在本文件。

### 2.2 Contract 变更与交接流程

1. 行为实现发现契约不足时,本专项先记录缺失场景、安全边界和所需契约变化,停止对该契约的本地扩展。
2. 在上位 Runtime Model/Context 契约域中先更新 type/schema/event contract 和 golden fixture,由独立 contract PR 完成 `npm run check`、`npm test` 与 contract tests。
3. 本专项基于新 contract commit 更新 adapter/behavior tests,不与 contract 变更混成同一提交。
4. 不兼容变更必须先更新当前 exact contract、所有 fixture 和消费者;不得保留 old-schema reader、迁移器、双写或运行时猜测来隐藏漂移。

## 3. 不可变约束

### 3.1 Model Compatibility

1. 标准 model 由当前 Models 目录解析；显式 manifest/profile/alias 使用者仍校验其文档。不在 ContextEngine、CompactionService 或 Orchestrator 中硬编码模型名。
2. route decision 同时绑定 manifest digest、profile digest、request capability 和 session model state;任一变化重新计算。
3. 未知能力是 incompatible/deny,不是 optimistic allow。
4. provider-private reasoning/signature/cache state 只由原 adapter 持有,不通过公共 context 传给其他 provider。
5. session model switch 的 compatible/fork/deny 由 router 判定,但 fork 仍由 Session Kernel command 执行。
6. summarizer 使用独立 profile/budget/retry policy,不自动继承 builder 的 tools 或 credential。

### 3.2 Plan Mode

1. 当前 mode 是 durable runtime state,不能从最后一条 prompt 或 TUI 本地布尔值推断。
2. Agent 主动进入 Plan Mode 必须得到用户批准;用户显式 `/plan` 可直接 arm 下一 turn。
3. `active`/`awaiting_approval` 状态下,除当前 plan artifact 外所有 workspace mutation 默认拒绝。
4. 第一版 Plan Mode 禁止 Bash、写型 MCP、write-capable subagent、hook mutation 和未知 effect 工具。
5. plan writer 只接受 runtime 分配的 `planId/revision`,不能由模型提供任意路径。
6. 审批绑定 `planId + revision + contentDigest + workspaceId`。任一变化都使审批失效。
7. approval pending 在 client 断连、TUI 重建和进程恢复后保持可见。
8. mode instruction、工具面和 authorization policy 必须来自同一 mode snapshot。
9. compaction 不改变 mode;resume 不重放已经被撤销的 activation。
10. fresh-context implementation 必须创建受审计 fork,携带 approved plan reference,不能静默清空当前 session。

### 3.3 Context 与 Compaction

1. 原始 event/history 永不被 compaction 删除或覆盖。
2. model-visible context 只能由 `ContextEngine` 组装,调用点不得自行拼接隐藏 system fragment。
3. 每个 fragment 有 stable ID、source、scope、trust、taint、digest 和 hard budget。
4. tool call 与对应 tool result 不得被 cut point 分开;未完成 tool batch 不允许 commit compaction。
5. plan state、approved plan digest、pending approvals、workspace identity、active goal/task、changed files 和 verification baseline 不依赖摘要保存。
6. compaction summary 生成后必须通过结构、预算、pairing 和 invariant 校验,校验失败不得替换 live projection。
7. manual/auto/overflow/model-switch trigger 共用同一 service 和 checkpoint schema。
8. overflow compact-and-retry 每个 model request 最多一次,且只在无副作用重放风险的边界执行。
9. model switch 前先做 compatibility/preflight;不兼容时 fork,不能强塞 provider-private reasoning state。
10. resume/fork/rewind 必须按 checkpoint range 重建,不能仅寻找“最后一条 summary 文本”。

### 3.4 Memory

1. canonical Memory 是独立权威存储;event 记录 intent、digest、receipt 和引用,不复制 secret 内容。
2. 只有 `approved` 且未过期/撤销的 record 可进入 model context。
3. web、MCP、issue、PR、tool output、模型摘要和 repo 内指令默认 `untrusted`;派生摘要不自动升级 trust。
4. `/remember`、pre-compact flush、session-end extraction 和 dream/consolidation 都先创建 proposal。
5. 发布、更新、删除和 scope 变更必须展示 diff 并产生 approval receipt。
6. 外部编辑导致 digest 漂移时 record 进入 `changed_unreviewed`,停止自动注入。
7. search/read 有 max results、max chars/tokens、path scope 和 stable pagination;index 不可用时显式退化 lexical。
8. runtime 记录实际注入/读取的 record ID 与 digest;不依赖模型自报 citation。
9. TTL、staleness 和 revoked 状态在检索时执行,不能仅由 TUI 隐藏。
10. memory failure 不得破坏主 session;安全策略失败时跳过注入/写入并留下诊断。

## 4. 目标架构

```text
TUI / CLI / future API clients
        |
        v
authenticated Session Owner command/query/subscription
        |
        v
ResidentSession / InteractiveSessionController / Runtime Commands
        |
        +---------- ModelCompatibilityRouter ----------> Provider
        |
        +---------------- PlanModeService ----------------+
        |                     |                            |
        |                     v                            v
        |               PlanArtifactStore          Approval Service
        |                                                  |
        v                                                  v
ContextEngine <---- CompactionService <---- Capability Gateway
    |                    |                        |
    |                    v                        v
    |              Summarizer/Validator      Tool Runtime
    |                    |----> ModelCompatibilityRouter
    +---- MemoryService -+
             |           |
             v           v
       MemoryStore   SearchIndex

All state transitions ---> current Event Store ---> reducers/projections/TUI
Large bodies -----------> Artifact Store/CAS
```

职责边界:

- `ModelCompatibilityRouter` 只根据契约化 manifest/profile 产生 route/fork/deny decision,不直接变更 session 或 provider state。
- `PlanModeService` 只拥有 mode lifecycle、plan revision 和 approval coordination,不直接执行工具。
- `CapabilityGateway` 根据 mode snapshot + tool effect 做最终授权,不读取 TUI 状态。
- `ContextEngine` 只生成 model request context 和 receipt,不修改 canonical history。
- `CompactionService` 生成并提交新 context projection checkpoint,不删除 raw events。
- `MemoryService` 管 proposal/approval/search/injection,不决定 session mode。
- Session-owned `InteractiveSessionController` 是 resident facade,不成为这些状态的事实源;client 只能消费 SessionRuntime facade。
- Session command 在执行副作用前写 durable intent,结果写 attempt receipt;同 command ID/同 digest 重放原 receipt,异体 conflict,只有 intent 无 receipt 时返回 `uncertain_outcome` 且不重执行。
- mode/model/plan/compaction/memory mutation 只允许当前 driver 携完整 owner generation、driver revision 与 expected domain revision 发起;observer 只可 query/subscribe。

## 5. 目标代码与数据目录

### 5.1 TypeScript 模块

```text
src/runtime/
  model-routing/
    types.ts                   # Runtime Model/Context 契约域,本专项只读
    schema.ts                  # Runtime Model/Context 契约域,本专项只读
    manifest-loader.ts         # 加载/验证 compatibility manifest
    profiles.ts                # searcher/builder/reviewer/summarizer alias
    router.ts                  # 路由、兼容预检与 fork decision
    adapter-state.ts           # provider-private state 边界
  modes/
    plan/
      types.ts                 # Runtime Model/Context 契约域,本专项只读
      schema.ts                # Runtime Model/Context 契约域,本专项只读
      reducer.ts               # 纯事件归约
      service.ts               # 安全点转换、审批、resume
      policy.ts                # mode -> tool effect policy
      tools.ts                 # enter/exit/update plan runtime tools
      approval-coordinator.ts  # 复用 Runtime Approval contract
  context/
    types.ts                   # Runtime Model/Context 契约域,本专项只读
    schema.ts                  # Runtime Model/Context 契约域,本专项只读
    context-engine.ts          # 分层组装、stable ordering、预算
    token-estimator.ts         # provider receipt + conservative estimate
    invariants.ts              # compaction 前后关键状态 digest
    projection.ts              # raw history -> model-visible history
    runtime-adapter.ts         # 共享根文件集成前的单向 seam
    compaction/
      types.ts                 # Runtime Model/Context 契约域,本专项只读
      schema.ts                # Runtime Model/Context 契约域,本专项只读
      cut-planner.ts
      summarizer.ts
      validator.ts
      service.ts
      reducer.ts
    memory/
      types.ts                 # Runtime Model/Context 契约域,本专项只读
      schema.ts                # Runtime Model/Context 契约域,本专项只读
      repository-port.ts       # SessionStore 的窄端口,不持有 SQLite 细节
      service.ts               # proposal/approval/search/injection 语义
      approval-coordinator.ts
      context-fragment.ts
      extraction.ts
src/storage/
  plan-artifact-store.ts       # immutable revisions + mutable working pointer
  context-paths.ts             # scoped path resolution
  session-store/
    memory-repository.ts       # state.db canonical records/proposals/content/revision
    memory-projection.ts       # rebuildable lexical projection
src/runtime/session-runtime/
  memory-composition.ts        # operation manifest、fence、attempt/event 接线
src/runtime/tools/
  plan-write.ts                # 唯一 Plan Mode 写入口
  plan-memory-tools.ts         # 既有 Memory tools,改为只调用 Session domain
src/tui/components/
  plan-approval.ts
  memory-approval.ts
  memory-browser.ts
  context-status.ts
tests/runtime-contracts/
  plan-context-memory/
    contract-consumer.test.ts  # 只验证 public contract 可消费
  model-routing/
  modes/plan/
  context/
    compaction/
    memory/
tests/storage/
  plan-artifact-store.test.ts
  session-store/memory-repository.test.ts
tests/runtime/session-runtime/
  memory-domain.test.ts
tests/cli/
  memory-session-owner.test.ts
tests/tui/
  plan-approval.test.ts
  memory-approval.test.ts
```

现有大文件接入原则:

- `src/runtime/agent-loop.ts` 已超过 1000 行,专项先在 `context/runtime-adapter.ts` 实现 seam;串行集成 PR 只增加调用,新逻辑必须放进上述模块。
- `src/tui/interactive-mode.ts` 已超过 1100 行,slash handler 和 approval view 先拆到独立 controller/component;只在串行集成 PR 连接,不继续堆状态机。
- `src/runtime/interactive-session-controller.ts` 只在串行集成 PR 暴露 command/query facade,不内嵌 router、compaction 或 memory 算法。
- `src/storage/session-codec.ts` 只解析当前 exact session format;current projection 走独立 reducer。

### 5.2 运行时数据布局

```text
<runledgerHome>/
  settings.json                     # 用户级设置 authority
  state.db                          # SessionStore + canonical Memory truth
  projects/<workspace-key>/
    settings.json                   # workspace 设置 authority
  sessions/YYYY/MM/DD/*.jsonl       # legacy/import source,不新增 Memory authority
  events/YYYY/MM/DD/*.jsonl         # Runtime Trace observability,非 mutation truth
  artifacts/sha256/...              # plan/summary/diagnostic 大正文 CAS
  artifact-metadata/sha256/...
  snapshots/plan-context-memory/... # 可重建 checkpoint/snapshot
  projections/
    plans/...                       # working.md/approval view 等可重建投影
    memory/...                      # MEMORY.md/浏览视图,非事实源
  state/plan-context-memory/
    plans/...                       # immutable revision metadata + ArtifactRef
  cache/memory-index/...            # 可删除重建 lexical index
  tmp/...                           # 根内同文件系统临时写入
```

安全要求:

- 目录默认 `0o700`,敏感 metadata/record 默认 `0o600`。
- Memory mutation 使用 owner-fenced SQLite transaction + command/attempt receipt;其他文件工件仍使用同目录 temp + fsync + rename。
- plan/memory path 必须由 `workspaceId/sessionId/recordId` 解析,不接受模型输入绝对路径。
- `runledgerHome` 只由 composition root 解析一次:`RUNLEDGER_DIR` 必须是既有绝对目录,否则使用默认用户级 `~/.runledger`;`RUNLEDGER_SESSION_DIR`、`--session-dir` 与 `settings.sessionDir` 一律 fail closed。
- 本专项不得向 `<cwd>/.runledger/`、`~/.runledger/agent/` 或其他根外目录写入;workspace path 只参与 identity/metadata,不形成 storage authority。
- `MEMORY.md` 是 approved record 的可重建人类可读投影;canonical truth 是 `state.db` 中的 typed record/content/revision 与绑定的 event/attempt receipt。
- index 可随时删除重建;index digest/mode 只作为 search receipt,不参与 record authority。
- public event、Artifact metadata、TUI/模型结果不得包含绝对 home/cwd、CAS 物理路径或 private locator。

## 6. 本专项消费的核心契约草案

本节用于解释 behavior 对公共契约的预期,不授权本专项创建或修改这些类型。实际实施时以 Runtime Model/Context 契约域已冻结的 public exports、TypeBox schema、event catalog 和 fixtures 为唯一真源;若与本节不一致,按 §2.2 先修订 Runtime contract,不在 behavior 中临时扩展。

契约实现使用可擦除 TypeScript 语法、显式 `import type` 和 TypeBox schema;不使用 `enum`、参数属性、`any` 或动态 import。

### 6.1 Model compatibility 与 route decision

```ts
export type ModelCapabilityAlias = "searcher" | "builder" | "reviewer" | "summarizer";

export interface ModelCompatibilityProfile {
  manifestDigest: string;
  profileDigest: string;
  modelIdentity: string;
  contextWindow: number;
  maxOutputTokens: number;
  apiProtocol: string;
  toolCallReplay: "supported" | "required" | "unsupported";
  reasoningHistory: "portable" | "adapter_private" | "unsupported";
  midSessionSwitch: "supported" | "fork_required" | "unsupported";
  compactionStrategy: string;
  verifiedAliases: ModelCapabilityAlias[];
  regressionSuite: { version: string; passed: boolean };
}

export interface ModelRouteRequest {
  requestId: string;
  alias: ModelCapabilityAlias;
  currentModelIdentity?: string;
  requiredContextWindow: number;
  requiredOutputTokens: number;
  requiresToolReplay: boolean;
  requiresReasoningReplay: boolean;
  checkpointStrategy?: string;
}

export type ModelRouteDecision =
  | { kind: "route"; profileDigest: string; modelIdentity: string; reason: string }
  | { kind: "fork"; profileDigest: string; modelIdentity: string; reason: string }
  | { kind: "deny"; reason: string; missingCapabilities: string[] };
```

Router 只产生 decision。`fork` 分支由 Session Kernel 执行,model adapter 只保存 provider-private state;profile/manifest/schema 的真正字段以 Runtime Model/Context 契约域为准。

### 6.2 Plan Mode

```ts
export type SessionMode = "default" | "plan";

export type PlanModeState =
  | { kind: "inactive"; revision: number }
  | { kind: "pending_activation"; revision: number; requestedBy: "user" | "agent" }
  | { kind: "active"; revision: number; planId: string; delivered: boolean }
  | {
      kind: "awaiting_approval";
      revision: number;
      planId: string;
      planRevision: number;
      contentDigest: string;
      approvalRequestId: string;
    }
  | {
      kind: "exit_pending";
      revision: number;
      planId: string;
      reason: "user_toggle" | "approved" | "cancelled";
    };

export interface ApprovedPlanRef {
  planId: string;
  revision: number;
  contentDigest: string;
  workspaceId: string;
  approvalReceiptId: string;
}
```

状态转换:

| 当前状态 | 命令/事件 | 下一状态 | 约束 |
|---|---|---|---|
| inactive | 用户 `/plan` | pending_activation | idle 可立即在下一 prompt 激活 |
| inactive | Agent `enter_plan_mode` | pending_activation 或 inactive | 必须经过 approval |
| pending_activation | first prompt/safe drain | active | 同时切 mode tools/policy/context |
| pending_activation | 用户取消 | inactive | 未送达模型时不注入 exit reminder |
| active | `plan_write` | active | revision 增长,旧审批失效 |
| active | `exit_plan_mode` | awaiting_approval | 从 store 读取并 pin digest |
| awaiting_approval | request changes | active | revision 保持,下一次写入再增长 |
| awaiting_approval | approve same session | exit_pending -> inactive | durable 切 default 后提交实施 turn |
| awaiting_approval | approve fresh context | inactive + fork | 新 session 引用 ApprovedPlanRef |
| awaiting_approval | cancel | inactive | 不触发实施 |
| active | mid-turn toggle off | exit_pending | turn terminal 后退出 |

restart 规则:

- `pending_activation` 若 reminder 尚未 durable-delivered,恢复为 `inactive`。
- `exit_pending` 若没有 terminal transition,恢复为 `inactive` 并在下一 turn 注入一次 mode-exit context diff。
- `awaiting_approval` 原样恢复并重新发布 query/UI projection。
- `active` 原样恢复;context engine 用 durable state 重新注入,不依赖旧 summary。

### 6.3 Tool effect 与 Plan policy

`ToolEffect` 和 `CapabilityDecision` 直接复用 Runtime Workspace/Security 契约域公共契约,本专项不重新声明 effect union。Plan policy 只输出 mode-specific ceiling,最终决策由 Worktree/Sandbox/Permission 专项的 Gateway 与其他 policy source 合并。

```ts
export interface PlanModeCapabilityConstraint {
  ceiling: CapabilityDecision;
  reason: string;
  modeRevision: number;
  matchedEffects: ToolEffect[];
}
```

首版 Plan Mode policy:

| Effect | Plan Mode ceiling |
|---|---|
| `read_workspace` | 最宽 allow,仍受 workspace path guard 和更严策略 |
| `read_external` | 最宽 ask,可被上层收紧为 deny |
| `write_plan_artifact` | 最宽 allow,只限当前 planId |
| `network` | 最宽 ask,结果标 untrusted |
| `write_workspace` | deny |
| `execute_process` | deny |
| `credential` | deny |
| `spawn_agent` | deny;后续只允许继承只读 mode 的 explore child |
| `unknown` | deny |

### 6.4 Context fragment 与 receipt

```ts
export type ContextLayer =
  | "organization_policy"
  | "session_mode"
  | "workspace_knowledge"
  | "approved_memory"
  | "session_history"
  | "current_turn";

export type ContextTrust = "system" | "user_approved" | "untrusted";

export interface ContextFragment {
  id: string;
  layer: ContextLayer;
  sourceType: string;
  sourceId: string;
  digest: string;
  trust: ContextTrust;
  taint: string[];
  priority: number;
  maxTokens: number;
  content: string;
}

export interface ContextAssemblyReceipt {
  requestId: string;
  modelIdentity: string;
  contextWindow: number;
  reservedOutputTokens: number;
  estimatedInputTokens: number;
  included: Array<{ id: string; digest: string; estimatedTokens: number }>;
  omitted: Array<{ id: string; reason: string }>;
  projectionCheckpointId?: string;
}
```

固定组装顺序:

1. organization/system policy,不可被摘要覆盖。
2. current session mode 与 approved plan reference。
3. workspace instructions/resources 与 approved memory。
4. latest committed compaction summary + retained session history。
5. current user turn、steering/follow-up 和未完成合法 tool pairing。

预算策略:

- 先保留 output reserve、tool schema reserve 和 provider safety margin。
- 每个 fragment 先过自身 hard cap,再按 layer priority 放入总预算。
- 真实 provider usage 更新估算基线;缺失时使用保守 byte/token estimator。
- 大 tool result 先走现有 offload/artifact 机制,model context 只保留有 digest 的摘要/引用。
- 任何 fragment 超预算都记录 omitted receipt,不得静默截断关键 policy/plan invariant。

### 6.5 Compaction checkpoint

```ts
export type CompactionReason = "manual" | "auto" | "overflow" | "incomplete" | "model_switch";

export interface CompactionCheckpoint {
  compactionId: string;
  sessionId: string;
  reason: CompactionReason;
  sourceFromSequence: number;
  sourceToSequence: number;
  retainedFromSequence: number;
  summaryArtifactId: string;
  summaryDigest: string;
  summarizerModel: string;
  preEstimatedTokens: number;
  postEstimatedTokens: number;
  invariantDigest: string;
  planModeRevision: number;
  approvedPlan?: ApprovedPlanRef;
  previousCheckpointId?: string;
  createdAt: string;
}
```

cut planner 必须输出:

- 可压缩的已完成 turn range。
- 完整保留的 recent tail。
- tool call/result pairing report。
- 需要 offload 的 oversized result 列表。
- pre/post budget estimate。
- 不可压缩原因,例如 active tool batch、pending approval、无安全 cut point。

summary 最低结构:

- 用户目标和明确约束。
- 已批准计划引用,只写 ID/digest,不复制为权威内容。
- 已完成工作和关键决策,带源 sequence/artifact reference。
- 已修改/读取的重要文件与当前状态。
- 未解决问题、pending task、pending approval。
- 最近验证命令与结果,明确其时间和可信边界。
- 需要从 raw transcript/artifact 精确恢复的引用。

validator 至少检查:

- summary 非空、在 max summary budget 内。
- 所有 tool call/result 配对仍完整。
- retained tail 与 source range 不重叠/不留洞。
- mode/plan/workspace/pending approval/goal/task/verification invariant digest 一致。
- summary 不包含 secret 或被 redaction policy 拒绝的内容。
- post-compaction context 在目标 model budget 内。
- checkpoint previous link 与 event sequence 连续。

<a id="compact-strategy-adapter"></a>

### 6.5.1 多策略 Compact 适配器设计与实施（2026-09-15）

本节细化 Phase 6–7，C0–C5 已按 §0.5 接入标准 Session Owner，验收边界亦以 §0.5 为准。策略包括 manual single-pass、分段归并和 OpenAI Responses 原生压缩。这里的“本地摘要策略”指 RunLedger 编排算法，生成摘要仍可能调用远程模型，并不意味着离线运行。

#### A. 当前接线与设计范围

当前标准 Session 在 `session-runtime/domain.ts` 注入 `assembleAgentModelContext`，由 `agent-loop/loop-runner.ts` 在每次模型请求前执行。`context/model-request-adapter.ts` 按预算选择完整依赖组，保留 required 和近期历史；SessionCompactionDomain 在预算选择前应用已提交摘要并处理自动触发。旧 `cli/runtime-host-summarizer.ts` 和 `runtime-host-model-context.ts` 有摘要调用与 checkpoint 切片，但不是标准 Session 的 compact 实现；不得恢复旧 Host 作为 fallback。

可复用 `cut-planner.ts` 的稳定 turn 切分与配对检查，以及 checkpoint 的 exact schema/lifecycle 校验。`context/invariants.ts` 当前计算的是 checkpoint 字段 digest，不能证明权限、计划、pending approval 或目标状态在压缩前后保持一致；新编排必须另外捕获并比较受保护状态。

本节保留设计约束与实施切片；当前实现与验证以 §0.5 为准。下文 TypeScript 解释 runtime-private adapter 边界；实际字段以 `compaction/{strategy,record,settings}.ts` 为准。公开 `CompactionCheckpoint` 仍使用 `compaction/{types,schema}.ts` exact contract，运行时恢复元数据由 `runledger.session-compaction` 和 `runledger.compaction-inheritance` exact reader 管理。

#### B. 分层与职责

```text
/compact 或自动触发策略
  → Session Owner 的 CompactionService
      → 捕获源范围、稳定边界、当前 projection 和受保护状态
      → CutPlanner / InputBuilder
      → CompactionStrategyRegistry.resolve(id, version)
          → single-pass@1
          → hierarchical@1（后续）
          → provider-native 策略（独立验收后）
      → 统一验证 + replacement 类型专用验证
      → 持久化工件 + owner-fenced 原子提交
      → 请求 projection 读取 committed replacement + retained tail
          → ContextEngine
          → provider 请求适配器
```

| 层 | 职责 | 约束 |
|---|---|---|
| TriggerPolicy | 判断 manual/auto/overflow/incomplete/model_switch 是否应发起压缩 | 不生成摘要、不提交状态；原因类型不等于策略类型 |
| CompactionService | 准入、捕获源版本、选择策略、取消/预算、校验、提交与恢复 | 唯一领域编排；由 Session Owner 持有 |
| CutPlanner / InputBuilder | 完整 turn/tool batch 边界、源 provenance、前一摘要和新增历史 | 不按任意字符长度切断原始 transcript |
| CompactionStrategy | 基于冻结输入生成候选 replacement | 不读取 SessionStore、不自行改历史、无工具/审批/任意文件访问 |
| SummaryModelPort | 执行受控模型调用，按模型身份选择认证与请求适配器 | 工具关闭；独立预算、超时、取消、路由与 trace；不直接继承 builder 的工具与私有凭据 |
| Validator / Committer | 检查预算、覆盖范围、配对、受保护状态、工件与原子提交 | 策略的成功返回不构成 commit 或验证通过 |
| Projection reader | 从 committed 工件和原始事件重建请求历史 | 与 registry 分离；恢复已有摘要不需要再次调用模型 |

现有预算裁剪继续属于 ContextEngine 的选择行为，不能作为成功摘要压缩报告。默认无策略间静默 fallback：选定策略不可用或失败，返回明确原因并保留当前 projection。将来若支持 fallback chain，必须显式配置顺序和累计预算，并记录每次尝试；第一版不提供。

#### C. 策略接口草案

拟放置于 `src/runtime/context/compaction/strategy.ts`。源内容只在进程内传递；正文不放入公开 query 或 bounded event。摘要文本作为低信任历史数据，不拼入 system/policy。

```ts
import type { RuntimeEventRangeRef } from "../../protocol/events.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../../protocol/foundation.ts";
import type { CompactionReason } from "./types.ts";

export interface CompactionStrategyKey {
  readonly id: string;
  readonly version: number;
}

export interface CompactionSourceUnit {
  readonly sourceRange: RuntimeEventRangeRef;
  readonly content: string;
  readonly estimatedTokens: number;
  // 一个 unit 包含完整稳定 turn 或跨 turn 的工具依赖闭包。
}

export interface CompactionStrategyInput {
  readonly reason: CompactionReason;
  readonly sourceRange: RuntimeEventRangeRef;
  readonly inputDigest: RuntimeDigest;
  readonly units: readonly CompactionSourceUnit[];
  readonly previousSummary?: {
    readonly artifactRef: RuntimeContentRef;
    readonly content: string;
  };
  readonly focus?: string;
  readonly limits: {
    readonly maxInputTokensPerCall: number;
    readonly maxSummaryTokens: number;
    readonly maxSummaryBytes: number;
    readonly maxModelCalls: number;
    readonly maxTotalInputTokens: number;
    readonly maxTotalOutputTokens: number;
    readonly deadlineMs: number;
  };
}

export interface CompactionSummaryCandidate {
  readonly kind: "portable-summary";
  readonly formatVersion: 1;
  readonly inputDigest: RuntimeDigest;
  readonly text: string;
}

export type CompactionStrategyResult =
  | { readonly ok: true; readonly candidate: CompactionSummaryCandidate }
  | {
      readonly ok: false;
      readonly code: "unsupported_input" | "input_too_large"
        | "budget_exhausted" | "cancelled" | "model_failed"
        | "invalid_output";
    };

export interface SummaryModelPort {
  // 受控 port 固定模型和输出合同；usage/调用次数由 port 记录。
  generate(input: {
    readonly content: string;
    readonly focus?: string;
    readonly maxOutputTokens: number;
    readonly signal: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly code: "budget_exhausted"
        | "cancelled" | "model_failed" | "invalid_output" }
  >;
}

export interface CompactionStrategy {
  readonly key: CompactionStrategyKey;
  readonly outputKind: "portable-summary";
  generate(
    input: CompactionStrategyInput,
    context: { readonly model: SummaryModelPort; readonly signal: AbortSignal },
  ): Promise<CompactionStrategyResult>;
}
```

接口边界约定：

- registry 由 composition 显式注册内置实例，拒绝重复 `id + version`，不动态加载任意路径/module。`resolve` 返回 selected 或 `strategy_unavailable`。generation 接口抛出的异常在 service 边界转换为失败，错误记录不复制模型原文或凭据。
- 策略版本和配置 digest 在操作准入时冻结；修改默认策略只影响新操作。冻结不要求把运行时配置塞入 Harness Profile，也不改变其权限 authority。
- `inputDigest` 由 service 计算，涵盖规范化 units、previous summary 引用、focus、目标模型与策略配置。候选中的 digest 只能校验绑定关系，不能证明摘要语义完整；覆盖范围以 service 的 cut/input builder 为准。
- `deadlineMs` 为绝对截止时间。受控 model port 统一执行单次、累计 token 和调用数上限，重试也计费计数；缺失 usage 时累计保守估算，不以零计。策略传入的上限不能扩大 service 预算。
- `AbortSignal` 传递到请求 transport，超时/取消后拒收迟到结果；不把 `Promise.race` 超时当成底层请求已取消。若 provider 不可取消，保持有界等待/记录结果未知，并禁止迟到提交或无界重试。
- candidate 格式第一版要求 §6.5 的摘要结构，运行时 exact 校验采用 C0 冻结的格式；不要求模型自行声明可信权限、任务完成或用户批准。

#### D. 多种策略如何接入

| 策略 | 处理流程 | 失败与适用边界 | 交付顺序 |
|---|---|---|---|
| `single-pass@1` | 前一份摘要 + 新的完整源 units → 一次摘要请求 | 输入放不下返回 `input_too_large`；输出超预算返回失败，不直接 `slice` | 首个 production 策略 |
| `hierarchical@1` | 完整 units 按预算分组 → 顺序生成分组摘要 → 有界逐层归并 | 单个 unit 放不下明确失败；每层必须减少估算量；限制层数、调用数、总 token 与 deadline | manual 闭环后第二策略 |
| provider 原生策略 | 将兼容的 provider 输入交给原生压缩接口，返回 provider 绑定 replacement | 需要专用输出合同、投影与恢复；未知能力显式 unavailable | 后续独立能力验证 |

`hierarchical@1` 每层保留原始来源映射，前一份摘要作为有 provenance 的输入，仅纳入一次；相邻依赖组不得拆开。分组摘要与归并使用同一个受控 model port，总预算覆盖所有阶段。若摘要无法继续缩小，在最大层数之前就以 `budget_exhausted` 终止，不无限归并。第一版顺序调用，不涉及产品内 child Agent 委派。

重复 compact 使用“前一个 committed summary + 上次 cut 之后新增的稳定历史”，记录 previous replacement 引用和新增 source range，保留完整 chain。恢复 reader 按确定的格式版本读取结果；策略被停用只阻止新的生成，不妨碍恢复已有 portable summary。

provider-native 的扩展契约单独演进：将候选结果改为 discriminated union，增加 `provider-state`，明确 provider/API、格式版本、模型兼容约束和 opaque payload 工件；并为该类型注册 validator 和 projection adapter。opaque 内容不能伪装成普通文本、不能跨不兼容 provider 重放，也不能通过 `Record<string, unknown>` 偷渡。只有目标 provider 的调用、持久化、恢复、模型切换和计费边界被实际验证后才允许注册策略。当前不新增空实现或假称支持具体 API。

#### E. Owner 编排、提交与失败语义

1. **准入**：`compact.run` 经标准 Session command/Attempt 路径进入；检查 driver、owner fence、recovery barrier、当前任务状态和策略可用性。首版仅允许 idle 且无未完成工具或 pending approval；不因压缩取消任何审批。manual 首版启用，auto/overflow 后续启用。
2. **捕获**：Owner 固定待压缩源范围、当前逻辑 projection revision、前一 checkpoint、策略/模型/config digest，以及独立的 protected-state digest。这里保护 mode、权限 revision、已批准计划引用、workspace identity、pending queue/approval 和已存在的结构化目标/验证状态，不凭摘要补造不存在的 authority。
3. **生成**：建立 operation identity，记录 started intent，在事务外执行策略。Owner 串行调度控制与 prompt 准入，后续输入可排队但不能悄悄并入本次 cut；其他请求不能与当前 projection mutation 并行提交。client detach 不取消 Owner 已接受的任务。
4. **验证**：检查候选 exact 格式、源绑定、非空、有界输出、redaction、完整 source/tail 划分、previous chain、类型兼容、受保护状态未变；通过 ContextEngine 试组装“摘要 + retained tail + 当前必需状态”，确保适配目标模型后的总预算可容纳且实际减少上下文。失败保留旧 projection，返回有界 reason。
5. **提交**：先将已验证正文写入可恢复的持久工件，核对 digest，再在 owner-fenced SQLite 事务中校验 projection revision/源 head/受保护状态，提交 checkpoint 引用、projection 指针、completion event 和 attempt receipt。不能在 LLM 请求期间持有数据库事务；审计事件使全局 head 自然推进，故源 head 指历史快照绑定，提交 CAS 使用明确的领域 revision，不误把自己的 started/trace 事件视为历史冲突。
6. **发布**：仅在事务成功后激活新 projection 并通知 CLI/TUI。任何异常都不能把内存中的候选摘要作为已提交结果交给下一模型请求；未知提交结果先按 operation identity 查询 authority。

摘要正文作为不可信 history replacement，由 ContextEngine 正常计入预算与 provenance；不提升为 required policy。已提交的 active summary 在请求选择中应作为必需历史内容保留，避免新裁剪再次静默丢失所有已压缩工作；若它与当前必需状态放不下，明确失败或进入已授权的下一次 compact，而不是丢弃摘要。原始消息/event 保留完整，不修改 TUI 原始 transcript。

取消、策略失败、输出校验失败或 CAS 冲突均不得切换 projection。相同 command identity 与相同 request digest 返回已有结果；相同 identity 不同 digest 拒绝。已有 started intent 在崩溃恢复时不得无条件重新发起付费模型请求，应先判断工件/commit/attempt 的实际状态，按现有 recovery barrier 协议处理未决结果。

工件已写但未提交时只能视为未引用工件，不能自动成为活跃摘要；提交成功但内存更新前崩溃，从 authority 恢复。被引用工件缺失或损坏要报明确完整性错误；除非有可验证的冗余副本，不静默从 raw history 重新生成一份不同摘要。Session checkpoint cache 不是唯一摘要存储，cache 删除不能丢失 committed replacement。现有 Artifact 能力若不足，由 C0 明确所需的最小存储补充后实施，不临时创建第二 authority。

#### F. 恢复、模型切换与配置

- **resume**：验证 committed replacement 工件、格式、源范围和 chain，再加 retained tail；不调用策略。只重建请求 projection，保持 raw ledger/TUI 历史。
- **fork**：绑定合法 source head，继承该边界以前的 replacement 引用与来源证明，分配新的 session identity；不让旧 session 的 fence/命令身份进入新 session。
- **rewind**：若目标位于一个 cut 内部，该摘要不能用于目标位置；选择更早可用 checkpoint 加 raw events 重建，不能携带未来信息。位于 cut 之后则使用对应 checkpoint + 截止目标的 tail。
- **model switch**：portable summary 按目标模型重新估算并转换；provider-state 必须经过专用兼容判断。不兼容时明确拒绝或由已授权 fork 流程处理，不能静默抛弃私有状态。
- **配置边界**：`compaction.enabled`、`strategy`（id/version）、`summaryModel`、`retainRecentTurns`、`maxSummaryTokens/Bytes`、`maxModelCalls`、累计 token 与 timeout；hierarchical 的层数/分组参数放在该策略配置中。auto threshold 单独放 TriggerPolicy，不混入 generate 参数。第一版默认关闭 auto，manual 使用显式已装配策略。
- 当前配置与默认值见 §0.5，实际 exact 校验见 `compaction/settings.ts`；沿用 canonical home、settings loader 和模型目录。无效或不兼容策略配置不得静默改选另一策略。

#### G. 实施顺序与验收

C0–C4 已实现，C5 已实现 OpenAI Responses adapter 并有本地 HTTP 协议证据，真实 provider 仍待验收。下表保留交付范围与验收要求，实际运行结果统一记录在 §0.5；未执行的人工和外部 provider 门禁不因此关闭。

| 阶段 | 文件边界与交付物 | 必须验证 |
|---|---|---|
| C0：冻结接口与持久化合同 | 本节、Runtime 04；核对 `compaction/{types,schema}.ts`、SessionStore event/receipt 与 Artifact port。确定 operation metadata、strategy/config/input digest、previous link、受保护状态及 reader 版本放入哪个受控工件；公共字段不足时同步 exact schema/fixture/version | 不重复发明 authority；记录 mutation 原子边界和 fault matrix；现有 checkpoint digest 与 protected state digest 分开 |
| C1：可插拔生成核心 | `context/compaction/strategy.ts`、registry、input builder、single-pass、validator；注入 SummaryModelPort | 注册冲突、未知策略、输入完整性、取消/迟到、累计预算、模型错误、输出空/超限、候选不能污染原输入；可注入两种测试策略验证选择隔离 |
| C2：manual 生产闭环 | `session-runtime` 的领域 service/command/Owner 装配、受控 model port、存储提交与恢复 reader；`model-request-adapter.ts` 消费 committed replacement；CLI/TUI 将 `/compact` 改为 mutation，另留 list/query | 真实 Owner + 本地确定性 HTTP：摘要调用无工具，下一请求确实包含摘要和 tail；原历史不变，重启请求内容一致，断连/重复命令/取消/CAS/fence/工件和事务失败均正确 |
| C3：第二种实际策略 | hierarchical 策略与配置解析；复用 C2 service/commit/reader | 同一生产入口选择两种策略；多层归并、单 unit 超限、归并不收敛、总预算耗尽、第二轮 compact chain；不增加单独的提交链 |
| C4：自动触发与连续性 | TriggerPolicy、Agent 请求边界、overflow guard、model switch/fork/rewind | 阈值边界和 suppression；overflow 每请求最多一次且不重放工具副作用；跨 cut rewind、fork 和模型缩窗；steering 顺序不丢 |
| C5：原生 provider 策略 | 经验证的 provider-specific port、candidate union、validator/projection/恢复 adapter | 对具体 provider 实际调用；opaque 工件恢复和兼容/不兼容切换；移除策略仍有 reader，未知格式失败 |

C2 提交前必须有崩溃注入覆盖：intent 后、模型返回后、工件持久化后、事务提交前后、内存 projection 发布前后。统一断言“旧 projection 或完整新 projection”，不得出现半提交，也不得通过恢复再次执行工具或暗中重新付费摘要。

实现阶段遵守根 AGENTS.md：代码改动执行完整 `npm run check` 和受影响测试；提交代码前执行 `npm test`；进入 dist 的改动执行 build，并用真实 PATH `runledger`、隔离 RUNLEDGER_DIR 和 TTY/tmux 验证策略选择、手动压缩、恢复与干净退出。本地 HTTP 证明协议与运行时接线；真实 provider、人工视觉/键盘/中文 IME、macOS/Windows 分列验收，不互相替代。

建议交付切片为 C0、C1、C2、C3、C4、C5 各自独立提交；C1 只能称“适配器核心可测试”，C2 才能称“manual compact 可用”，C3 才能称“多策略已生产接线”。C4–C5 不作为首个 manual single-pass 闭环的隐性前置。

### 6.6 Memory record 与 proposal

```ts
export type MemoryScope = "user" | "workspace" | "session";
export type MemoryTrust = "untrusted" | "proposed" | "approved" | "revoked" | "changed_unreviewed";

export interface MemoryProvenance {
  sourceKind: "user" | "agent" | "tool" | "import" | "compaction";
  sourceRef: RuntimeContentRef;
  sourceDigest: RuntimeDigest;
  createdAt: string;
}

export interface MemoryRecord {
  memoryId: MemoryId;
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
  sessionId?: SessionId;
  title: string;
  contentDigest: RuntimeDigest;
  contentRef: RuntimeContentRef;
  revision: number;
  trust: MemoryTrust;
  provenance: MemoryProvenance;
  approvedAt?: string;
  expiresAt?: string;
  revocationRevision: number;
}

export interface MemoryProposal {
  proposalId: ProposalId;
  memoryId: MemoryId;
  scope: MemoryScope;
  recordDigest: RuntimeDigest;
  status: "pending" | "approved" | "rejected" | "expired";
  approvalRef?: RuntimeContentRef;
  createdAt: string;
}

export interface MemorySearchReceipt {
  receiptId: ReceiptId;
  queryDigest: RuntimeDigest;
  scope: MemoryScope;
  workspaceId?: WorkspaceId;
  sessionId?: SessionId;
  mode: "lexical" | "vector" | "none";
  resultIds: readonly MemoryId[];
  indexDigest: RuntimeDigest;
  sourceHead: RuntimeStreamHead;
  createdAt: string;
}
```

当前 public contract 已有三种 scope,但 user scope 的稳定 authority key 仍须在 M0 冻结;若不能由 composition root 提供,不得在 behavior/storage 层自行用 workspace key 补位。

首版 search:

- user + current workspace + current session 三个 scope,不跨未授权 authority/workspace/session。
- lexical token/phrase match + stable score + source/recency tie-break。
- `maxResults`、`maxSnippetChars`、`maxTotalTokens` 和 cursor 必须硬限制。
- index 损坏时从 canonical record 重建;重建失败返回无结果 + diagnostic,不能返回陈旧未知数据。
- vector/hybrid 作为后续 adapter,不改变 `MemorySearchReceipt` 外部契约。

### 6.7 current 事件扩展

建议事件类型:

```text
mode.change_requested
mode.changed
mode.activation_delivered
plan.created
plan.revision_written
plan.approval_requested
plan.approval_decided
plan.approval_invalidated
context.assembled
compaction.requested
compaction.started
compaction.summary_generated
compaction.validated
compaction.committed
compaction.failed
memory.proposed
memory.approved
memory.revoked
memory.search_recorded
memory.context_injected
```

当前 catalog 已有 `memory.proposed/approved/revoked/search_recorded`;`memory.context_injected` 是 M0 必须冻结的缺口。proposal/approval 的大正文只存在 canonical Memory content,事件只带 ref/digest/receipt。

事件只保存 bounded metadata。plan/summary/memory 大正文进入 Artifact/Memory Store,事件保存 artifact ID/digest。所有 command 带 `commandId`/expected revision,重复请求返回同一结果或 conflict,不得重复产生审批/写入。

## 7. 端到端流程

### 7.1 Plan Mode

```text
/plan or enter_plan_mode
  -> validate session idle/safe point
  -> append mode.change_requested
  -> if agent initiated: durable approval request
  -> append mode.changed(plan)
  -> ContextEngine injects mode fragment
  -> Gateway swaps to plan policy
  -> PlanStore creates planId revision 0
  -> model explores with read-only tools
  -> plan_write creates immutable revision + digest
  -> exit_plan_mode reads store, not model arguments
  -> append plan.approval_requested
  -> TUI preview pinned revision
      -> revise: active plan mode
      -> approve same session: mode default, submit implementation turn
      -> approve fresh context: fork with ApprovedPlanRef
      -> cancel: mode default, no implementation
```

关键并发规则:

- mid-turn enter/exit 先进入 pending state,只在 model/tool safe drain point 切换 tool surface。
- pending approval 时禁止 model 继续执行写型工具;用户评论作为下一 planning turn 输入。
- plan revision 写入和 approval request 使用 expected revision;晚到的批准不能批准新 revision。
- TUI 关闭不等于拒绝;只有显式 decision 才结束 awaiting state。

### 7.2 Manual/Auto Compaction

```text
trigger
  -> reserve compaction operation id
  -> wait for stable turn/tool boundary
  -> freeze ContextAssemblyReceipt + runtime invariant
  -> plan safe cut and retained tail
  -> optional memory extraction proposal (non-blocking to publication)
  -> build bounded summarizer input
  -> sample summary with tools disabled
  -> validate summary + pairing + invariant + post budget
  -> persist summary/diagnostic artifact
  -> append compaction.validated
  -> append compaction.committed(checkpoint)
  -> atomically switch model-history projection
  -> re-inject current mode/workspace/approved memory
  -> emit projection/query update to TUI
```

失败语义:

- transient sampler error:在 compaction 自己的 retry budget 内重试。
- context overflow:按 verbatim -> fitted -> lossy input ladder 最多降级两次;每次留 attempt receipt。
- deterministic schema/auth/size error:按 reason 设置 current-turn/sticky/until-success suppression。
- validation failure:保留 raw history,不 commit checkpoint,生成 diagnostic artifact。
- artifact 成功而 event commit 失败:artifact 保持 pending,由 recovery 按 intent 继续或回收。
- event committed 但 artifact digest 不可验证:session 标 corrupted/paused,不得继续 sampling。

### 7.3 Overflow 与 Model Switch

- 每次模型请求前用目标 model 的 context window 做 preflight。
- 若新 model 窗口更小或 compatibility manifest 的 compaction/reasoning profile 不兼容,先 compact 或 fork。
- provider 返回 context-length error 时,只有该 turn 尚未开始任何新副作用才允许 compact-and-retry。
- 同一 request 的 `overflowRecoveryCount` 最大为 1;第二次 overflow 直接失败并报告建议操作。
- model switch 和 overflow checkpoint 均保留旧 model identity;summary model 选择由 compatibility router 的 `summarizer` alias 决定。

### 7.4 Memory Proposal、Approval 与 Injection

```text
source(user / session extraction / pre-compact flush / import)
  -> redact + classify trust/taint
  -> dedup exact digest
  -> create proposal with source refs
  -> approval preview shows add/update/delete diff
      -> approve: publish intent -> atomic record -> published event
      -> reject: decision receipt, proposal retained by policy/TTL
      -> edit: new proposal revision, old approval invalidated
  -> rebuild MEMORY.md + lexical index projection
  -> first-turn/post-compact search approved records
  -> ContextEngine injects bounded fragments
  -> context.assembled + memory.context_injected receipts
```

pre-compaction flush:

- 在 auto threshold 前预留 headroom,同一 compaction cycle 最多一次。
- flush model 不开放工具,输入来自本 session trusted projection 与明确标记的 untrusted source。
- 输出为空/`NO_REPLY`/无结构/超限/重复时不创建可发布 record;仍记录中性 outcome。
- flush 失败不能阻止 compaction;只留下 diagnostic。

post-compaction recovery:

- query 由最新用户目标、approved plan title、workspace identity 和 pending task 的 bounded 文本组成。
- 只搜索 approved、未过期、digest valid 的 record。
- 结果作为独立 memory fragment 注入,不拼入 compaction summary。
- 相同 checkpoint resume 时优先复用持久 search receipt/fragment,避免重新排序造成 prompt cache 抖动。

## 8. 配置、CLI 与 TUI

### 8.1 Settings 草案

设置写入沿用 canonical `RunledgerLayout`:用户默认值位于 `<runledgerHome>/settings.json`,workspace override 位于 `<runledgerHome>/projects/<workspace-key>/settings.json`。两者用 TypeBox schema 严格清洗;未知字段诊断且不得形成隐式 authority。repo 内 `.runledger/`、任意 project-local settings、额外环境变量和 session path 不拥有本专项配置 authority;敏感 managed policy 也不放 workspace settings。

```ts
export interface PlanModeSettings {
  defaultMode?: SessionMode;
  allowNetworkReads?: boolean;
  requireApprovalForAgentEntry?: boolean;
}

export interface CompactionSettings {
  enabled?: boolean;
  auto?: boolean;
  thresholdPercent?: number;
  reservedOutputTokens?: number;
  retainedTurns?: number;
  maxSummaryTokens?: number;
}

export interface MemorySettings {
  enabled?: boolean;
  initialInjection?: boolean;
  postCompactionRecovery?: boolean;
  maxResults?: number;
  maxSnippetChars?: number;
  defaultTtlDays?: number;
}
```

约束:

- `thresholdPercent` 必须给 output/tool/safety reserve 留空间,建议默认 80,允许范围 50–90。
- memory 默认关闭直到 approval UI 和 provenance 完成;启用也不意味着允许自动发布。
- CLI override 只作为 versioned per-request command 影响当前 session,必须由 Session Owner 校验 expected domain revision 并写 command/attempt receipt;持久设置必须经过 SessionRuntime settings operation 写入 canonical user/workspace settings。
- `RUNLEDGER_DIR` 只在 composition root 启动时解析一次;`RUNLEDGER_SESSION_DIR`、`--session-dir` 和 `settings.sessionDir` 均不受支持。memory scope 必须使用 canonical workspace identity,不能从物理路径或目录名恢复 authority。

### 8.2 CLI/command surface

计划新增:

- `--mode <default|plan>`:session 初始 mode。
- `/plan [description]`:arm Plan Mode,可直接提交描述。
- `/view-plan`:打开当前 pinned working revision。
- `/compact [focus]`:manual compact,focus 只作为非权威 summarizer hint。
- `/context`:显示 token budget、checkpoint、included/omitted fragment 摘要。
- `/memory`:打开 browser。
- `/remember <text>`:创建 user-authored proposal 并打开审批。
- `/forget <query>`:选择 record 后创建 revoke proposal,不直接删除。

SessionRuntime/未来 API command 与 TUI 使用相同 payload,不得为 TUI 另建私有状态转换。所有 mutation 带 command ID、request digest、owner generation、driver revision 与 expected domain revision;query/subscription 使用 bounded cursor,`resync_required` 后从 durable projection 重新读取。

### 8.3 TUI 投影

footer/status 至少显示:

```text
mode:plan  plan:r3/approved?  ctx:78%  compact:idle  mem:on
```

UI 组件:

- Plan approval:immutable revision preview、digest 短码、inline/freeform feedback、same-session/fresh-context/cancel。
- Memory approval:add/update/revoke diff、scope、source、trust、TTL、批准/拒绝/编辑。
- Context status:模型窗口、input estimate、output reserve、largest fragments、last checkpoint、suppression reason。
- Memory browser:approved/proposed/revoked 分组,只读 preview,source refs 和 staleness。

TUI 只保存滚动/焦点/临时输入。mode、approval、compaction、memory 状态来自 reducer projection。

## 9. 分阶段实施计划

### Phase 0:消费 Runtime 公共契约、fixture 与依赖门禁

目标:确认上位 Runtime Model/Context 契约域足以支撑行为实现,不重新定义协议,不改变用户行为。

只读输入:

- `src/runtime/model-routing/{types,schema}.ts`、`src/runtime/modes/plan/{types,schema}.ts`。
- `src/runtime/context/{types,schema}.ts`、`src/runtime/context/{compaction,memory}/{types,schema}.ts`。
- `src/runtime/protocol/{events,schemas}.ts` 中的对应 catalog/payload。
- `tests/runtime-contracts/contracts/**` 和 `tests/runtime-contracts/fixtures/{model-routing,plan-mode,context,compaction,memory}/**`。

本专项计划文件:

- 新增 `tests/runtime-contracts/plan-context-memory/contract-consumer.test.ts`。
- 新增后续 behavior 需要的 fake Event/Artifact/Capability/Resource ports,放在 `tests/runtime-contracts/plan-context-memory/fakes/`,不修改 contract fixtures。

任务:

- [ ] 验证 model route、mode/plan ref、context receipt、checkpoint、memory record/proposal/search receipt 都可从 contract-owned public module export import,不要求本专项修改根 barrel。
- [ ] 验证 current event catalog 已包含本专项所有 lifecycle payload,每个大正文字段都使用 Artifact/Memory ref。
- [ ] 验证 mode policy 只消费 Runtime capability/effect contract,不按 tool name 创建第二套决策类型。
- [ ] 验证 command expected-revision/idempotency error、approval/artifact/workspace refs 与 Runtime Foundation 契约域、Runtime Workspace/Security 契约域和 Runtime Artifact/Evidence 契约域对齐。
- [ ] 固定 `runtime/06` Session Owner handoff:本专项 command/query/subscription 名称、driver-only mutation、owner generation、driver/domain revision、durable intent/attempt receipt、cursor/resync 与 compatibility digest 输入。
- [ ] 跑上位 contract tests 与专项 consumer compile test,记录冻结 contract commit。
- [ ] 检查 behavior 目录不存在同义 `interface/type`、私有 event name 或复制 schema。
- [ ] capability 未完成时只注册 internal adapter factory并由 SessionRuntime 返回 typed unsupported,不暴露半成品命令或 client/direct 双生产路径。

完成门槛:

- consumer test 仅通过 public exports 编译,对 contract allowlist 的 diff 为空。
- fixture 可表达 incompatible route、approval resume、multi-compaction chain 和 memory revoke/expire。
- Event Store/Artifact/Capability/Resource/Session Owner 依赖通过 typed port/fake 注入,没有隐式全局单例或 client-local writer。
- 若契约不足,已按 §2.2 停在 Runtime contract PR,未在本专项引入临时兼容层。

建议 commit:`test: verify plan context contract consumption`

### Phase 1:Model Compatibility Router 行为实现

前置:Phase 0;Runtime Model/Context 契约域中的 model-routing contract 已冻结。

目标:从已验证 manifest 稳定选择能力 profile,在模型切换前给出可审计的 compatible/fork/deny 决策。

任务:

- [ ] 实现 manifest loader 和 schema/version/digest 验证,未知模型或缺失能力 fail closed。
- [ ] 实现 searcher/builder/reviewer/summarizer 能力 alias 和 deterministic profile resolution,不在上层散落模型名。
- [ ] 实现 context/max output、API/tool replay、reasoning history、image/tool schema、compaction strategy 兼容预检。
- [ ] 实现 adapter-private state 边界,只输出 contract 允许的 transferable refs;不兼容 reasoning/signature 不进入新 provider。
- [ ] 产生带 manifest/profile/digest/reason 的 route decision 与 `model.routed` event;decision 本身不执行 fork。
- [ ] 仅在串行集成 PR 对接 `models.ts`/`models-store.ts` 和 session fork command,不修改 provider adapter 内部协议。

测试:

- [ ] verified/unknown/retired profile、alias 缺失、manifest digest 漂移和 regression-suite fence。
- [ ] 同能力可直接切换,不兼容 tool/reasoning/context window 给出稳定 fork/deny reason。
- [ ] summarizer alias 只选择满足 output/context/tool-off 约束的 profile。
- [ ] 路由决策 replay 与 live 一致,不依赖 Map 顺序或本地时钟。

完成门槛:

- 所有 model/summarizer 选择都经过 router,未知兼容性不默认 allow。
- provider-private state 不跨不兼容 adapter 传播,所有 fork/deny 有 typed diagnostic。

建议 commit:`model: route compatible profiles with audited decisions`

### Phase 2:ContextEngine 与 token accounting

前置:Phase 0–1;Runtime Event 契约域已冻结,且独立行为证据证明 Event Store 可用。

目标:所有模型请求先经过统一、可审计的 context assembly。

任务:

- [x] 实现 fragment registry、fixed layer order、stable ID/digest 和 per-fragment hard cap。
- [x] 实现 conservative token estimator,接入 provider usage receipt 与模型 context window。
- [~] 把现有 `systemPrompt/messages/tools` 转成首批 fragment/projection adapter；当前仅完成注入式 runtime adapter。
- [~] 先在 `context/runtime-adapter.ts` 实现 `assemble()` seam;串行集成 PR 只把它接入 Session-owned resident Agent 的唯一 model-request 路径,并删除调用点私自拼接的新增路径。
- [ ] 持久化 bounded `context.assembled` receipt,正文不进 event。
- [x] 为 omitted fragment、oversized tool result、missing budget 输出结构化诊断。

测试:

- [x] stable ordering/digest 不受 Map 遍历或 resume 影响。
- [x] policy/mode fragment 永不被普通 history 挤出。
- [x] image/tool/reasoning 估算不会发生整数溢出。
- [x] provider usage 缺失/异常时保守 fallback。
- [~] 同一 checkpoint resume 生成相同 request-context fixture；当前有稳定 projection/checkpoint 行为，尚未接入 Session Owner resume。

完成门槛:

- 所有 production streamFn request 都有 ContextAssemblyReceipt。
- 超预算在 sampling 前可解释失败,不把超长请求盲送 provider。

建议 commit:`context: assemble bounded model requests from typed layers`

### Phase 3:Plan Mode reducer、store 与 durable lifecycle

> 状态入口:未完成项由 [02](02-plan-mode-parity-implementation-plan.md) P0–P1、P6 承接(§0.7);下方复选框保留为设计叙述。

前置:Phase 2;Runtime Artifact/Evidence 契约域已冻结,且独立行为证据证明 Artifact Store 可用。

目标:模式和计划 revision 可持久恢复,尚不开放实施审批 UI。

任务:

- [x] 实现纯 `PlanModeState` reducer 和合法 transition table。
- [x] 实现 `PlanArtifactStore`,working pointer + immutable revision + digest。
- [ ] 实现 user/agent entry command、mid-turn pending activation、安全点 delivery。
- [ ] mode/plan mutation 由 SessionRuntime durable command 调用 service;observer、stale owner/driver/domain revision 和异体 command replay 在进入 reducer/store 前拒绝。
- [ ] mode fragment 接入 ContextEngine,同 revision 不重复注入。
- [ ] resume 折叠 transient state,保持 active/awaiting 状态。
- [x] plan 外部修改检测,digest 漂移触发 approval invalidation。

测试:

- [~] 全状态转换 table/property test；当前已有 reducer transition、非法状态、stale revision 与 drift focused tests，尚未覆盖完整 property matrix。
- [ ] mid-turn enter 后立即取消不会注入伪 exit。
- [ ] client crash/restart 恢复 active/awaiting 状态。
- [~] revision expected conflict 与 exact snapshot restore 已覆盖；canonical atomic file write/torn temp recovery 尚未接线。
- [ ] workspace/session path 不可逃逸。

完成门槛:

- mode 不依赖 TUI boolean 或 prompt 解析。
- 任何批准都能唯一定位 immutable plan revision。

建议 commit:`plan: persist mode lifecycle and immutable revisions`

### Phase 4:Plan Mode Capability Gateway 与专用工具

> 状态入口:未完成项由 [02](02-plan-mode-parity-implementation-plan.md) P1、P3 承接(§0.7);下方复选框保留为设计叙述。

前置:Runtime Workspace/Security 契约域、Runtime Resource 契约域与对应专项行为门禁;Phase 3。

目标:形成没有 shell/subagent/MCP 绕路的只读硬边界。

任务:

- [ ] 实现 `PlanModePolicy` adapter,把mode snapshot + Runtime `ToolEffect[]` 投影为 capability 约束;不复制 Gateway policy engine。
- [ ] 在串行 integration PR 补齐内建工具 manifest 的结构化 effect,不由本专项改写 Resource/Capability contract。
- [ ] 通过 Worktree/Sandbox/Permission 专项的 Gateway port 合并 organization/workspace/session/mode policy,验证 `deny > ask > allow`;本专项不实现 Gateway。
- [ ] 新增 `enter_plan_mode`、`plan_write`、`exit_plan_mode` 工具。
- [ ] plan writer 不接受 path,只接受 expected revision + full body/patch。
- [ ] Plan Mode 下隐藏或拒绝 write/edit/multi-edit/bash/notebook/todo 和未知副作用工具。
- [ ] MCP 未声明或无法验证 effect 时,Plan policy 输出 `unknown -> deny`,由 Gateway 强制执行。
- [ ] subagent 默认 deny;后续 explore child 必须继承 plan mode + capability 子集。
- [ ] authorization decision 和 tool event 持久化同一 mode revision。

攻击测试:

- [ ] write/edit/multi-edit 直接写 workspace 被拒绝。
- [ ] Bash redirection、`tee`、脚本、包管理器和 git mutation 被拒绝。
- [ ] symlink/`..`/绝对路径不能把 plan writer 指向 plan root 外。
- [ ] 名称伪装成 read 的 MCP/extension 不能绕过 unknown effect。
- [ ] always-approve 不能覆盖 Plan Mode deny。
- [ ] child agent 不能继承更宽 capability。

完成门槛:

- 红队 fixture 中没有可见 workspace mutation。
- denial 既返回模型友好错误,也有完整 policy receipt。

建议 commit:`plan: enforce read-only mode at the capability gateway`

### Phase 5:Plan approval、TUI 与实施交接

> 状态入口:未完成项由 [02](02-plan-mode-parity-implementation-plan.md) P2、P4、P5 承接(§0.7);下方复选框保留为设计叙述。其中"fresh-context approval 创建 fork + ApprovedPlanRef"与 02 的 D7 冲突:fork 固化继承源 profile,plan@1 的 fork 仍是只读,故 fresh-context 实施改为新建 standard 会话加显式 handoff。

前置:Phase 3–4;统一 Approval Service。

目标:完成可恢复的人审闭环。

任务:

- [ ] 实现 plan approval request/decision/expiry/invalidation。
- [ ] `exit_plan_mode` 从 PlanStore 读取并 pin revision/digest。
- [ ] 实现独立 TUI approval component 支持 approve、fresh context、request changes、cancel;串行 integration PR 再接入 `interactive-mode.ts`。
- [ ] feedback 进入下一 planning turn,不直接改计划正文。
- [ ] same-session approval 先 durable 切 default mode,再提交实施 user turn。
- [ ] fresh-context approval 创建 fork + ApprovedPlanRef,旧 session 保持历史可查。
- [ ] approval pending 在 TUI reconnect/resume 后重新出现。
- [ ] status/footer 和 `/view-plan` 先经专用 controller 消费 runtime projection,再在串行 integration PR 接根视图。

测试:

- [ ] stale revision approval 返回 conflict。
- [ ] 外部改 plan 后旧 approval 自动失效。
- [ ] decision 落盘成功但 UI 断连不会重复实施。
- [ ] approval 作为 Session-owned reverse request 只允许 active driver resolve;driver disconnect 后 waiter 保留,新 driver 显式 claim 后继续,observer response 拒绝。
- [ ] fresh fork 只携带 approved plan ref 和必要 context,不泄漏未批准 tail。
- [ ] plan approval view snapshot/窄终端/空计划/大计划。

完成门槛:

- 未批准计划无法触发写型实施 turn。
- approved plan digest 在实施请求 ContextAssemblyReceipt 中可追溯。

建议 commit:`plan: add resumable approval and audited implementation handoff`

### Phase 6:Manual single-pass Compaction

接口与实施切片细化见 [§6.5.1 多策略 Compact 适配器设计](#compact-strategy-adapter) 的 C0–C2；第二策略在 C3 增加，auto/overflow 在 C4 增加，provider 原生扩展在 C5 独立验证。

前置:Phase 1–2;Runtime Artifact/Evidence 契约域已冻结,且 Artifact 行为门禁可用。

目标:先把最小 compaction 做正确,不启用 auto。

任务:

- [x] 实现 cut planner,只选完整 stable turn/tool batch。
- [ ] 实现 transcript/artifact input builder 和 output reserve。
- [ ] 实现 summarizer adapter,工具关闭,单独 retry/timeout budget。
- [~] 实现 summary validator、invariant digest 和 redaction scan；当前完成 invariant/checkpoint schema 校验，尚无真实 summarizer/redaction pipeline。
- [~] 实现 checkpoint intent/commit 与 model-history projection replacement；当前仅有注入式内存 checkpoint lifecycle，未接 canonical event/SessionRuntime commit。
- [ ] `/compact [focus]` 通过 SessionRuntime command 进入 resident session;start/completed/failed event 和 bounded query/subscription 状态接入,client detach 不取消已接受操作。
- [ ] compaction 后重新注入当前 mode、workspace、approved plan 和 policy。

golden tests:

- [ ] 无 tool 的多 turn compact。
- [x] tool call/result 配对和 parallel batch。
- [ ] reasoning/signature 不跨不兼容 provider 泄漏。
- [ ] 多次 compact checkpoint chain。
- [ ] Plan Mode 中 compact 后仍 active 且权限未放宽。
- [ ] pending approval 时 compact 不丢 request。
- [~] summary validation failure 保持原 projection；checkpoint store 已拒绝 invalid schema/invariant，尚无 live projection replacement。
- [ ] crash 位于 artifact write、validated event、commit event 各边界的 recovery。

完成门槛:

- raw event 数和 digest chain 不因 compact 改变。
- resume 后 request fixture 与 compact 后 live request 一致。

建议 commit:`context: add invariant-checked manual compaction checkpoints`

### Phase 7:Auto/Overflow/Resume/Fork/Rewind/Model Switch

前置:Phase 6。

目标:覆盖真正会破坏连续性的边界条件。

任务:

- [ ] 实现 threshold、output/tool reserve 和 preflight trigger。
- [ ] 实现 manual/auto/overflow/model-switch 统一 reason 与 metrics。
- [ ] 实现 verbatim -> fitted -> lossy input ladder 和 attempt receipt。
- [ ] 实现 turn/sticky/until-success suppression,manual compact 可显式绕过 suppression。
- [ ] context-length error 的单次 compact-and-retry guard。
- [ ] resume 读取 latest valid checkpoint + tail。
- [ ] fork 继承 checkpoint/reference,分配新 session identity。
- [ ] rewind 跨 checkpoint 时丢弃未来 projection/checkpoint marker,保留 raw audit。
- [ ] model downshift/comp-hash/reasoning compatibility preflight;不兼容强制 fork。

测试:

- [ ] 阈值边界、配置 clamp、provider usage 漂移。
- [ ] auto compact failure 不每 turn 热循环。
- [ ] overflow 只重试一次且不重复工具副作用。
- [ ] resume/fork/rewind 跨一个和多个 checkpoint。
- [ ] 更小 context model 切换、未知模型、retired model fallback。
- [ ] steering/follow-up 在 compact 中排队且顺序稳定。

完成门槛:

- 任一 session 最终都能解释“为何 compact/为何未 compact/为何被抑制”。
- rollback/fork 不出现未来摘要或孤立 tool result。

建议 commit:`context: make compaction safe across overflow resume and forks`

### Phase 8:Memory Session Owner 实现交付 M0–M8

本阶段替代旧 Phase 8–10 的 Memory checklist。M0–M8 是不可跳序的生产交付链;Phase 9 的 compaction 联动并入 M7,原 Phase 10 中与 Memory 有关的发布门禁并入 M8。Model/Plan/Context/Compaction 的其他未完成项仍由 Phase 0–7 管理,不得借 Memory 完成状态一并勾选。

#### 8.0 交付原则、状态口径与文件所有权

硬规则:

1. 唯一生产 authority 是 `createEmbeddedSessionRuntime()` 装配出的 Session Owner。不得给 `runtime-host-model-context.ts` 增加新 Memory 行为,也不得让 TUI/headless CLI 直接访问 `MemoryStore`。
2. canonical truth 写入 `SessionStore` 的 `state.db`;event 只保存 ID、scope、revision、digest、receipt 与诊断 metadata,不复制 Memory 正文。`MEMORY.md` 若后续需要,只能是可删除重建的只读 projection。
3. user scope 必须绑定 canonical user authority key,workspace scope 必须绑定 canonical workspace identity,session scope 绑定 `sessionId`;物理路径、workspace storage key 和当前 cwd 都不能代替 authority。
4. mutation 必须同时满足 owner fence、active driver、expected domain revision、Memory optimistic revision 与 attempt intent/receipt;同 command ID/同 digest replay 原结果,异体 conflict,不确定结果不得盲目重试。
5. `memory.enabled` 默认 `false`;关闭时不注册 Agent Memory tools、不做自动 recall/flush/extraction,但显式管理 query 的具体可见性由 M5 contract 固定。
6. ordinary turn 对 Memory 失败采取 typed non-blocking degradation;approval、scope、digest、fence 或 schema 安全失败仍 fail closed,且留下不含正文的诊断。
7. 每个 M 里程碑独立 RED -> GREEN -> full gate -> scoped commit。除非用户明确要求,只更新计划证据,不自动 commit/push。

共享文件串行窗口:

| 路径 | 里程碑 | 规则 |
|---|---|---|
| `src/storage/session-store/{schema,session-store}.ts` 与新 Memory repository | M1 | 先锁 schema version/offline migration,不得与其他 schema 任务交叉修改 |
| `src/runtime/session-runtime/{domain,session-runtime,query-handler,command-routes/domain}.ts` 与新 Memory composition | M3 | 只通过 operation manifest 接线,不向 core router 加 Memory 特判 |
| `src/runtime/tools/plan-memory-tools.ts`、Session production tool composition | M4 | 工具只调用 Session domain,不持有 repository/store |
| `src/storage/settings-manager.ts`、model context assembler | M5 | turn admission 时解析 immutable snapshot,唯一 assembler 注入 |
| `src/cli/control-commands.ts`、`src/tui/**` | M0/M6 | CLI/TUI 只做输入和 projection,不成为状态 authority |
| `src/cli/runtime-host-model-context.ts` | M8 | 只做冻结/删除/迁移收尾,此前禁止继续扩展 |

状态提升口径:

- **core partial**:只证明纯 `MemoryStore`/codec/projection。
- **production partial**:M0–M5 全绿,标准 Session Owner 可在默认关闭的 feature flag 下完成 durable proposal/search/injection。
- **user-visible partial**:M6 全绿,headless CLI 与真实 TUI 共用同一审批链。
- **implemented**:M0–M8 全部验收,含 restart/takeover/response-loss、compaction 与清理门禁;自动化结果与人工验收分开记录。

| 里程碑 | 交付物 | 当前状态 | 退出条件摘要 |
|---|---|---|---|
| M0 | authority freeze + production RED | audit done / RED not started | standard CLI/SessionRuntime 缺口被真实失败测试锁定 |
| M1 | `state.db` Memory repository | not started | offline migration、scope、transaction、rebuild/reopen 全绿 |
| M2 | Session-owned Memory service | not started | 纯规则与 SQLite golden vectors 一致,无双写 |
| M3 | SessionRuntime operation/event/receipt | not started | query/mutation 经 fence,replay/takeover 不重复副作用 |
| M4 | governed Agent tools | not started | search/get/propose 只经 domain,无 approve/revoke 越权 |
| M5 | settings + deterministic recall | not started | 默认关闭,唯一 Context assembler 可复现注入 receipt |
| M6 | headless CLI + TUI approval/browser | not started | 同一 reverse-request lifecycle,无 raw JSON UX |
| M7 | compaction/resume/session-end | not started | 自动路径只提 proposal,approved recall 可恢复 |
| M8 | cutover + release gates | not started | legacy 不可达,自动化与人工验收分别闭合 |

#### M0:冻结 Session Owner authority,建立生产 RED

目标:先用失败测试锁定标准入口当前缺口,避免 legacy Host/fake port 继续提供假绿色。

任务:

- [x] 记录 2026-09-04 当前调用链、命令结果与 9 files / 58 tests 的证据边界。
- [ ] 修正 `parseControlCommand()` 的 grammar,使文档中的 `runledger remember <text>` 直接映射 `memory.propose`;是否保留 `remember propose <text>` alias 必须由同一 parser contract 明确,不能两种解析互相歧义。
- [ ] 新增 Session Owner RED,证明 `memory.inspect/search/get/projection/propose/approve/reject/revoke` 在 production manifest 缺失时返回 `operation_unavailable`。
- [ ] 新增标准 `src/cli/main.ts`/embedded runtime RED,不得用 `runtime-host-model-context.ts` 或手工 fake domain 替代。
- [ ] 固定 event payload、Memory result/error、scope authority、approval reverse-request 和 settings contract 的缺口清单;公共 contract 不足时按 §2.2 单独冻结。

测试落点:

- `tests/cli/control-commands.test.ts`:documented remember grammar、空正文、action 歧义和 digest/provenance payload。
- 新增 `tests/runtime/session-runtime/memory-domain.test.ts`:生产 manifest、query/mutation unavailable baseline、driver/observer boundary。
- 新增 `tests/cli/memory-session-owner.test.ts`:隔离 `RUNLEDGER_DIR` 真正经过 standard CLI/embedded runtime。

完成门槛:RED 必须因 Session Owner 尚未装配 Memory 而失败;不能因 fixture 拼错、legacy Host 被调用或测试跳过而失败。计划中记录 RED 命令与失败摘要后才进入 M1。

建议 commit:`test(memory): pin session-owner delivery gaps`

#### M1:在 SessionStore 建立 canonical Memory persistence

目标:让 `state.db` 成为唯一可恢复、可迁移、可校验的 Memory 真源。

任务:

- [ ] 通过现有 offline migration 规则提升 schema version;活跃 owner 存在时 migration fail closed,不在线热改表。
- [ ] 新增规范化 `memory_records`、`memory_proposals`、`memory_contents`、`memory_revisions` 与可重建 `memory_lexical_projection`（最终表名在 RED 中冻结）。
- [ ] 每条 record/proposal 保存 scope kind + authority key、status、revision、content digest、source provenance、trust、TTL、created/updated/revoked metadata;正文只存 canonical content 表。
- [ ] user/workspace/session scope 分别使用 user authority、catalog 中 canonical workspace identity、`sessionId`;若 user authority 尚无稳定来源,停止 M1 并先补 contract,不得退化为 workspace key。
- [ ] 实现 owner-fenced repository,在同一 SQLite transaction 中校验 owner generation、expected Memory revision、写 content/state 并追加领域审计 metadata。
- [ ] lexical projection 支持确定性 rebuild;投影损坏/缺失不改 canonical records,可显式 rebuild 或 typed degrade。
- [ ] 数据库、目录和导出/诊断继续遵守 0600/0700 与正文不进日志要求。

测试:

- schema create/upgrade、活跃 owner 拒绝迁移、旧版本保持原文件、transaction rollback、双 connection revision conflict。
- 三种 scope 隔离、user scope 跨 workspace 可见、workspace clone/worktree identity 规则、session scope 不越界。
- TTL/revoke/digest/provenance exact round-trip、projection delete/corrupt/rebuild、SQLite reopen 后结果 byte-stable。

完成门槛:重启数据库后纯 snapshot 无损恢复;删除 lexical projection 后可从 canonical 表重建相同排序;仓库中没有新 JSON canonical store 或 silent dual-write。

建议 commit:`storage(memory): add fenced canonical sqlite repository`

#### M2:把纯 Memory 语义收敛为 Session-owned service

目标:复用现有正确语义,去除内存快照/legacy Host 对生产行为的 ownership。

任务:

- [ ] 在 `src/runtime/context/memory/` 增加 repository port/service,将 proposal/approve/reject/revoke/search/get/projection 连接 M1 repository。
- [ ] 保留 approved-only recall、provenance、trust、TTL、revoked、digest drift、bounded lexical ranking 与 stable pagination 语义。
- [ ] approve/update/revoke 都绑定 proposal/record revision 和 approval receipt;`memory_propose` 永远只创建 pending proposal。
- [ ] 将 persistence/index/repository 错误映射成 typed domain failure;自动 recall 失败可跳过,显式 mutation 失败不得假成功。
- [ ] 对现有 `MemoryStore` 选择“纯规则内核”或“test/reference implementation”单一定位,禁止它与 SQLite service 双写。

测试:对同一 golden vector 同时运行纯内核与 SQLite service,断言状态机、排序、过滤、digest 与 error code 一致;覆盖 duplicate proposal、stale revision、approval replay、revoke replay 和时钟边界。

完成门槛:生产 service 不读取 legacy JSON snapshot;所有 canonical mutation 可在 SQLite transaction/replay 后得到同一状态。

建议 commit:`memory: run approved-only semantics on session repository`

#### M3:注册 SessionRuntime operations、fencing 与 durable event

目标:让所有客户端只通过 Session domain 访问 Memory,并在 response-loss/takeover 下保持 exactly-once outcome。

operation manifest:

- query:`memory.inspect`、`memory.list`、`memory.search`、`memory.get`、`memory.projection`。
- mutation:`memory.propose`、`memory.approve`、`memory.reject`、`memory.revoke`。

任务:

- [ ] 新增 `src/runtime/session-runtime/memory-composition.ts`,由 `assembleSessionDomain()` 注入 SessionStore、owner fence、scope authority、clock 和 approval port。
- [ ] query 走 bounded projection;mutation 走 domain operation manifest、active-driver fence、expected domain/Memory revision 与 attempt gateway。
- [ ] append `memory.proposed`、`memory.approved`、`memory.revoked`、`memory.search_recorded` 和 `memory.context_injected` metadata event;若 current catalog 缺 event,先走独立 contract PR。
- [ ] query/recall receipt 记录 query digest、scope、result IDs/digests、index revision、limits 与 suppression reason,不记录 query/正文原文。
- [ ] command response 丢失后同 ID/同 digest 返回已提交 receipt;prepared/activation-uncertain/running/takeover 矩阵不得重复 mutation。
- [ ] observer 只可 query;stale owner、stale driver、stale domain revision、scope mismatch 和异体 replay fail closed。

测试:扩展 M0 RED 为 GREEN,并覆盖独立 SQLite connections 的 concurrent propose/approve、owner fencing、driver handoff、disconnect/reconnect、attempt recovery 和 event replay projection。

完成门槛:standard CLI 的 `memory.inspect/search` 不再是 `operation_unavailable`;一次 mutation 在 event、attempt receipt 和 Memory revision 中可关联,正文不出现在 event JSON。

建议 commit:`runtime(memory): expose fenced session-domain operations`

#### M4:接入 governed Agent Memory tools

目标:让 root Agent 使用最小、可治理、不会越权发布的 Memory 工具面。

任务:

- [ ] 注册 `memory_search`、`memory_get`、`memory_propose`;工具实现只调用 Session domain internal bridge,不得直接导入 repository/`MemoryStore`。
- [ ] `memory_search/get` 标记为只读 capability,强制 max results/snippet/token/scope;`memory_propose` 是 mutation,只能生成 pending proposal。
- [ ] proposal 的 `sourceRef/sourceDigest/contentDigest` 从 canonical bytes 构造,禁止用 raw content 充当 digest;来源含 session/turn/tool identity。
- [ ] internal bridge 必须保留 M3 的 receipt/event,不能重现 legacy Host 的“返回结果但丢事件”。
- [ ] child Agent 默认不获得 Memory mutation;若未来开放 search/get,必须由 bounded multi-agent policy 显式授予只读子集。

测试:生产 tool composition 可见性、feature-off 隐藏、schema hard cap、scope escape、malformed result、provenance/digest、internal event persistence、child capability 不升级。

完成门槛:真实 Session Owner Agent turn 能 search/get/propose;任一工具都不能直接 approve/revoke 或绕过 ExecutionGateway/attempt receipt。

建议 commit:`tools(memory): route governed recall and proposals through session domain`

#### M5:接入 settings、deterministic recall 与唯一 Context assembler

目标:以安全默认和 immutable turn snapshot 将 approved Memory 注入模型上下文。

任务:

- [ ] 在 canonical settings 增加 `memory.enabled`（默认 `false`）、`initialInjection`、`postCompactionRecovery`、`maxResults`、`maxSnippetChars`、`maxTokens` 与 TTL 上限;非法值 typed reject 或安全默认,workspace 层不得放宽 managed ceiling。
- [ ] composition root 只解析一次 user/workspace/managed precedence,turn admission 固定 immutable Memory settings/revision;运行中设置变化只影响后续 turn。
- [ ] 从 bounded 当前 user goal、approved plan/task 与本 turn user text 构造 deterministic query;空 query 显式 suppress,不得把全部 transcript 或 secret tool output送入检索。
- [ ] 只通过 `assembleAgentModelContext()` 的 Memory layer 注入 approved、未过期、未撤销、scope 匹配且 digest 有效的 fragments;调用点不得私拼 system prompt。
- [ ] 同一 turn/resume 复用 search/injection receipt;record/index/settings revision 变化必须产生显式 invalidation,不得静默换片段。
- [ ] recall/repository failure 不阻断 ordinary turn,但输出 typed diagnostic 与 `suppressed/degraded` receipt;正文不进入 trace/event。

测试:settings precedence/default/clamp、feature off 无工具无注入、deterministic query/order/budget、first turn、resume、record drift、TTL/revoke race、store failure degradation、ContextAssemblyReceipt 关联。

完成门槛:M0–M5 全绿后状态可提升为 **production partial**;标准 Session Owner 重启后能检索并在开启配置时复现同一 Memory fragment 与 receipt。

建议 commit:`context(memory): inject bounded approved recall from turn snapshots`

#### M6:交付 headless CLI、TUI browser 与 reverse-request approval

目标:让用户不用编写 JSON approval ref,在 headless 与真实 TUI 中完成同一 proposal/decision lifecycle。

任务:

- [ ] `runledger remember <text>` 先展示 scope/source/trust/TTL/diff preview,创建 proposal 后进入 Session Owner reverse-request approval;取消/断连保持 pending,不得自动批准。
- [ ] `runledger memory list|search|get|projection` 共用 M3 query;approve/reject/revoke 使用 bounded ID 选择和 expected revision,不要求用户粘贴 raw JSON arguments。
- [ ] `/memory` browser 按 proposed/approved/revoked 分组,展示来源、digest 短码、TTL/staleness 与 bounded preview。
- [ ] `/remember <text>`、approve/reject/revoke 经 `SessionInteractiveController` 同一 operation contract;TUI 只持 focus/input/scroll。
- [ ] active driver 才能 resolve approval;observer read-only,driver 断开后 reverse request 保留,新 driver claim 后恢复。
- [ ] `/forget` 仅在 revoke proposal + approval 语义冻结后加入,否则保持未实现,不做直接删除 alias。

测试:headless parser/stdio、real embedded runtime、TUI reconnect、driver handoff、narrow terminal、空/超长/多字节正文、approval response-loss、stale selection/revision、sensitive content 不进 notice/log。

完成门槛:M6 全绿后状态可提升为 **user-visible partial**;CLI 与 TUI 对同一 proposal 产生相同 domain transition/event sequence,且未经 approval 的内容不进入 search/context。

建议 commit:`ui(memory): add resumable proposal approval and browser`

#### M7:接入 compaction、resume 与 session-end proposal

目标:在压缩前提议长期知识,压缩后只恢复已批准 Memory,不让模型摘要自动成为事实。

任务:

- [ ] pre-compact flush 在 hard threshold 前、每 checkpoint cycle 最多一次;输出经 empty/NO_REPLY/header/length/redaction/exact-dedup 校验后只创建 proposal。
- [ ] flush timeout/error/oversize 不阻止 compaction;状态在 finally 释放,避免 `isFlushing` 与 auto-compact 互相热循环。
- [ ] post-compaction recovery 使用 M5 deterministic recall,只读 approved/nonexpired/nonrevoked/scope-matching records。
- [ ] 相同 checkpoint resume 复用 query/fragment receipt;Memory/index/settings revision 变化时写 invalidation 后重新检索。
- [ ] session-end extraction 只创建 proposal,具备 eligibility、age、lease、retry/backoff、concurrency 和 exact dedup;owner crash/takeover 不重复提案。
- [ ] MVP 不实现 background dream/consolidation、自动 publish 或跨 scope merge。

测试:once-per-cycle、flush/compact race、sampler timeout、duplicate proposal、multi-process lease、checkpoint resume、Plan Mode + approved plan + Memory recovery、response-loss/takeover。

完成门槛:每次 flush/search/injection 都能关联 checkpoint/turn receipt;任何自动路径最多生成 pending proposal,未批准摘要永不进入未来 session context。

建议 commit:`memory: bridge approved recall with compaction checkpoints`

#### M8:cutover、清理与发布验收

目标:删除双 authority,证明标准入口在故障、平台和人工交互下可交付。

任务:

- [ ] 冻结或删除 `runtime-host-model-context.ts` 中 Memory authority、duplicate JSON persistence 与不可达 command path;保留文件时必须有静态边界测试证明标准 CLI 不可达。
- [ ] 若决定支持 legacy Memory 数据,只提供显式、离线、digest 校验后的单向 import/migration;不 silent scan、不 dual-read/dual-write、不自动删除源。若不支持,返回 typed unsupported 并保持源不变。
- [ ] 同步 CLI help、TUI tips、settings schema、README/AGENTS 与本计划,删除尚未可用或语法错误的宣传。
- [ ] 增加静态检查:production composition 不导入 legacy Memory authority;TUI/CLI/tools 不直接导入 repository/`MemoryStore`;event/trace 不含正文。
- [ ] 补齐 Linux 自动化 candidate、macOS/Windows path/schema runner 证据或明确 gap;不得把 Linux-only 结果表述为跨平台通过。
- [ ] 在本节逐项记录 commit、完整命令、files/tests/assertions、日期和未完成项;历史 58-test 结果不得冒充 fresh release gate。

自动化发布门禁:

- [ ] `npm run check` 完整通过,无 error/warning/info 遗漏。
- [ ] `npm test`、`npm run build` 完整通过;涉及 TUI 时同时运行 Bun/OpenTUI suite。
- [ ] 隔离 `RUNLEDGER_DIR` 的 standard CLI 覆盖 propose -> approve -> process restart -> search -> model-context injection -> revoke。
- [ ] fault matrix 覆盖 response-loss、owner takeover、driver reconnect、SQLite busy/rollback、projection corruption/rebuild、expired/revoked/drift 与 store unavailable。
- [ ] `git diff --check`、schema compatibility、execution/platform boundary scripts 与 secret scan 通过。

独立人工验收（不能由单测代填）:

- [ ] 真实 TTY 中 `/memory`、`/remember`、approve/reject/revoke 的 dark/light、窄终端、键盘/IME、断线重连与 clean exit。
- [ ] 使用真实模型确认 injected fragment 有界、来源可读、未批准内容不可见,并核对 event/Trace/日志不含正文。
- [ ] reviewer 独立核对 scope 隔离、权限提示、默认关闭和 legacy 数据处理结论。

完成门槛:M0–M8 全部关闭,自动化与人工证据分别记录,legacy authority 不可达且无双写,方可把 Memory 标为 **implemented**。

建议 commit:`memory: cut over session-owner delivery and retire legacy authority`

## 10. 验证矩阵

| 维度 | 必测场景 |
|---|---|
| Contract ownership | public export 消费、allowlist 无 diff、无重复类型/私有 event、contract handoff |
| Model routing | verified/unknown/retired profile、alias、summarizer、reasoning/tool/context compatibility、fork/deny receipt |
| Mode | user/agent entry、decline、mid-turn enter/exit、resume、compaction 后恢复 |
| Authorization | built-in/MCP/hook/subagent/bash/symlink/unknown effect/always-approve |
| Plan artifact | empty/large/concurrent revision/external edit/stale approval/fresh fork |
| Context | stable order、hard cap、omission receipt、tool schema reserve、多模态估算 |
| Compaction | manual/auto/overflow/model switch/multi-compact/validation fail/crash recovery |
| History | tool pairing、reasoning、steering/follow-up、resume/fork/rewind |
| Memory | scope、proposal、approval、TTL、revoke、digest drift、index rebuild、citation receipt |
| Integration | plan + compact、plan + memory、compact + memory、全部三者同时 active |
| Platform | Linux/macOS/Windows path、permission mode、line endings、atomic rename |
| Security | prompt injection、untrusted memory、secret redaction、TOCTOU、path traversal |

每个集成测试应断言完整对象或完整 event sequence,不要只断言单个字段。UI 变化使用稳定 snapshot/文本 fixture,同时验证输入路由,不能只看渲染。

## 11. 当前格式与发布策略

### 11.1 Session

- `session-codec.ts` 只恢复通过当前 exact schema 的 canonical message、runtime config 和 audit entry。
- header、entry、payload 或事件无法验证时立即拒绝，保留源文件，不跳过坏行、不从文本猜测状态、不生成降级 replay。
- `fork` 只接受当前格式的源 session，并创建新的当前格式 session；它不是格式转换入口。
- 新的 Plan、compaction、approval 和 memory 语义只写入当前唯一 canonical session/runtime event 真源。

### 11.2 配置

- 新字段缺失使用安全默认:Plan Mode 不默认开启,auto compact 先 feature flag,memory 默认关闭。
- 配置非法时返回结构化 diagnostic 并使用安全 fallback;threshold 不得被 clamp 到无 output reserve 的值。
- 项目 settings 不能放宽 managed/organization deny。

### 11.3 Rollback

- 关闭 feature flag 后保留当前 events/artifacts,projection 忽略新 command,不删除数据。
- memory rollback 只停止注入/写入,index 可删除;canonical record 保留。
- auto compact rollback 后仍允许读取通过当前 exact schema 的 checkpoint;不得强制展开并重写 raw history。
- plan UI rollback 时 awaiting approval 保持 pending,CLI/API 可显式 cancel,不能自动批准。

## 12. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| Plan Mode 只靠工具名 | Bash/MCP/subagent 绕过 | effect manifest + Gateway + unknown deny |
| plan file TOCTOU | 批准内容与实施内容不同 | immutable revision + digest + expected revision |
| summary 遗漏关键状态 | 实施偏离或越权 | state invariant 独立保存 + validator |
| compaction crash 半提交 | resume 使用损坏 projection | intent/object/commit + digest recovery |
| token estimate 偏低 | provider overflow | conservative margin + provider receipt + one retry |
| auto compact 热循环 | 成本/延迟失控 | typed suppression + bounded attempts |
| memory prompt injection | 跨 session 持久污染 | proposal/approval/trust/taint/diff |
| 外部 memory 编辑 | 未审内容被注入 | digest scan -> changed_unreviewed |
| index 漂移 | 错误/陈旧检索 | rebuildable projection + index digest receipt |
| TUI 成为事实源 | reconnect/resume 丢状态 | reducer projection,UI 只存临时交互 |
| client 直接调用 controller/store | 多 client 分叉状态、绕过 writer/driver fence | 所有生产 mutation/query/subscription 经 authenticated Session Owner,client 只持 remote facade |
| command response-loss | 重复 compact、重复 memory publish 或重复 mode transition | durable intent/receipt + command/request digest + uncertain 不重执行 |
| storage root 漂移 | 项目目录和旧 agent home 形成双真源 | 单一 `runledgerHome` + canonical layout;旧路径与 sessionDir authority fail closed |
| Runtime contract 与 behavior 漂移 | 双真源、并行合并冲突 | contract allowlist 只读 + 独立 contract PR + consumer test |
| 多个主计划冲突 | 状态与顺序漂移 | 本文件唯一专项账本,上位计划只汇总,共享文件串行 handoff |

## 13. 总验收清单

- [ ] Runtime Model/Context 契约域 allowlist 在本专项 behavior commits 中无 diff。
- [ ] 本专项没有重复 public type/schema 或私有 current event payload。
- [ ] Model Router 是 model/summarizer 选择的唯一入口,未知/不兼容能力进入 fork/deny。
- [ ] Plan Mode 是 durable state,不是 prompt/TUI flag。
- [ ] Plan Mode deny 能覆盖 always-approve、Bash、MCP 和 subagent。
- [ ] plan approval 绑定 immutable revision/digest/workspace。
- [ ] same-session 与 fresh-context 实施都有 event evidence。
- [ ] 所有 model request 由 ContextEngine 组装并有 receipt。
- [ ] raw history 永不因 compaction 改写。
- [ ] checkpoint 校验 tool pairing、budget 和 runtime invariant。
- [ ] overflow compact-and-retry 每 request 最多一次。
- [ ] resume/fork/rewind/model switch 通过 golden tests。
- [ ] Memory 只有 approved record 能注入。
- [ ] memory proposal/approve/revoke/expire/digest drift 全可审计。
- [ ] pre-compact flush 只产 proposal,失败不阻止 compact。
- [ ] post-compact recovery 只读 approved、有效、scope 匹配的 record。
- [ ] TUI/CLI/未来 API 复用同一 command/query/event schema。
- [ ] 标准 CLI/TUI 只通过 authenticated Session Owner Runtime 访问本专项;owner 是 resident service/store/event writer authority,observer 无 mutation authority。
- [ ] 所有领域 mutation 绑定 owner generation、driver revision、expected domain revision 与 durable command/attempt receipt;response-loss 不重复副作用。
- [ ] 所有本地数据只写 canonical `runledgerHome` 子树,不写 `<cwd>/.runledger/`、`~/.runledger/agent/` 或任意 sessionDir。
- [ ] 所有 session 与 runtime 数据只遵循当前 exact format,不提供旧格式兼容、迁移、双写或隐式转换。
- [ ] `npm run check` 完整通过。
- [ ] `npm test` 完整通过。
- [ ] 本文件记录各阶段 commit、命令和结果。
- [ ] 共享根文件的每个修改都有基线 commit、当期单一所有者和串行 handoff 证据。
- [ ] 上位 Runtime contract 计划没有同步本专项行为状态或复制 behavior checklist;所有实现证据仍只保留在本文件。
