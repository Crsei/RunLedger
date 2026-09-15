# RunLedger × oh-my-pi 压缩服务接入实施计划

> 状态：**in_progress**。O0 合同冻结完成，O1–O5 待实施；O6 `deferred`，O7 `blocked`。本次文档更新不关闭运行时能力门禁。
> 目标基线：RunLedger `9ab79772e512935da2d98fd2239693ec451b415f`（分支 `rollback/before-composer-shape`）。
> 来源快照：oh-my-pi `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`；事实清单见 [00-oh-my-pi-compaction-services.md](00-oh-my-pi-compaction-services.md)。
> 检索入口见 [README.md](README.md)。

## 0. 文档定位与执行规则

1. **权责划分**：`development-doc/plan-compact-memory/01-implementation-plan.md` 仍是 Model/Plan/Context/Compaction/Memory 的**唯一执行账本**（其 §0 明文禁止创建同主题 sibling plan 分散状态）。本目录只承载两件它没有的东西：(a) oh-my-pi 侧的压缩服务取证（`00`），(b) omp 服务接入 RunLedger compact 适配器的**增量**实施切片 O0–O7（本文件）。权威、生命周期、公共契约仍以上位两处为准；本文件与它们冲突时以它们为准，并按 §2.2 流程先改上位。
2. **不重复记账**：C0–C5 的阶段状态只记在 `plan-compact-memory/01` §6.5.1；本文件的 O 阶段只记 omp 接入增量，并在完成后回填一行指针，不复制 C 阶段结论。
3. **状态词汇**：阶段状态用 `planned` / `in_progress` / `done`；完成后的能力状态沿用 `development-doc/providers/02-oh-my-pi-provider-port-execution-checklist.md` §7 的四档（`implemented` / `partial` / `deferred` / `blocked`），证据不足时只能标 `partial`。
4. **证据分层**：代码已存在 ≠ focused tests 通过 ≠ 生产组合通过 ≠ 真实 provider E2E 通过。四层不得互相替代，结论必须来自目标 commit 的 fresh 运行（对齐 providers/02 §6）。
5. **不改 authority**：本计划不新增第二个摘要权威、不让模型自报权限/批准/完成、不引入策略间静默 fallback、不改 raw ledger 与 TUI 原始 transcript。

## 1. 目标、成功标准与非目标

### 1.1 目标

把 oh-my-pi 已在生产使用的压缩**机制**（切点/预算数学、迭代摘要与提示词契约、文件操作清单、投影级瘦身、handoff、provider 原生压缩）接入 RunLedger 现有 compact 适配器，使：

- 切点与保留量由 **token 预算**决定，而不是仅按 turn 计数；
- 自动压缩的触发阈值以 **provider usage 与本地估算的上界**为准，不再只信一端；
- 摘要输出契约可按策略区分格式，从而能容纳 omp 的 handoff / update 契约而不削平现有 6 标题校验；
- 可压缩的还包括**投影内的陈旧工具输出**，且所有瘦身都是消息数组的纯函数（可重放、可审计）；
- provider 原生压缩覆盖 V2 streaming 形态，并补上 `stopReason === "length"` 的有界恢复。

### 1.2 用户可见成功标准

| 编号 | 标准 | 可观察证据 |
|---|---|---|
| S1 | `/compact` 仍只走 Owner 命令路径；`compaction.list`、`compact.run` 的返回结构、idempotency、CAS 冲突语义不变 | 现有 `tests/runtime/session-runtime/compaction-domain.test.ts` 全绿且新增用例只增不改语义 |
| S2 | 同一历史在相同配置下重复投影得到**逐字节一致**的请求；重启后一致 | 投影 digest 断言 + 重启恢复用例 |
| S3 | 两次连续 compact 的第二次摘要保留第一次的信息（迭代契约），文件清单合并且不重复堆叠 | focused 用例断言保留关键事实与 `<files>` 唯一性 |
| S4 | 自动压缩在本地估算远高于真实占用时不会因阈值抖动反复触发；provider usage 与本地估算取上界后行为有界 | 阈值边界与抑制语义用例 |
| S5 | 使用 V2 原生压缩的会话在重启后能恢复同一 provider 窗口；不兼容 provider/模型切换被明确拒绝而不是静默降级 | 原生恢复 + 不兼容换模用例 |
| S6 | `stopReason === "length"` 的回合有界恢复（最多 N 次）且不重放工具副作用 | 恢复计数与副作用断言 |

### 1.3 非目标

- 不移植 omp 的 journal/entry 模型、`SessionManager`、telemetry oneshot、`withAuth` 与多候选模型 fallback。
- 不移植分支摘要、实验性 context 管理（`context_notes`/`new_context`/`history://`）、推测（异步）压缩、idle 维护与 auto-continue 提示（理由见 §8）。
- 不引入原生 tokenizer，也不在 O1–O5 引入任何 native 依赖（理由见 §8）。
- 不让 omp 的编排（`compact()` 三级回退）替换 RunLedger 的 Owner 编排。
- 不恢复旧 Host（`cli/runtime-host-summarizer.ts`、`runtime-host-model-context.ts`）作为任何 fallback。

## 2. 当前接线基线

### 2.1 事实入口

- 设计账本：`development-doc/plan-compact-memory/01-implementation-plan.md` §0.5、§6.5.1（C0–C5）、Phase 6–7。
- 契约目录清单：`src/runtime/contracts/inventory.ts`（`compaction` 条目 owner 指向上述账本），断言在 `tests/runtime-contracts/inventory.test.ts`。
- 现有测试：`tests/runtime/context/compaction-strategies.test.ts`、`compaction-cut-planner.test.ts`、`compaction-checkpoint-store.test.ts`、`tests/runtime/session-runtime/compaction-domain.test.ts`。

### 2.2 接入点（已提交目标基线）

适配器核心（已提交，O 阶段全部在其上增量）：

| 文件 | 职责 |
|---|---|
| `src/runtime/context/compaction/strategy.ts` | registry、`CompactionStrategy`、`CompactionStrategyInput{inputDigest,units,previousSummary?,focus?,limits}`、`SummaryModelPort`、`NativeCompactionPort`、candidate 联合（`portable-summary` \| `openai-responses-compaction`）、`validSummary` |
| `src/runtime/context/compaction/summary-strategies.ts` | `single-pass@1`、`hierarchical@1`、`openai-responses-native@1` |
| `src/runtime/context/compaction/budgeted-model.ts` | 累计调用/token/deadline 预算包装（预扣输出预算、单飞、迟到结果拒收） |
| `src/runtime/context/compaction/settings.ts` | 用户级配置 schema 与边界（`strategy` 为三值字面量联合） |
| `src/runtime/context/compaction/history.ts` | `planHistoryCut`（按 turn 计数）、`historyDigest`、`redactSummaryInput`、`hasSummarySecret` |
| `src/runtime/context/compaction/record.ts` | `CompactionRecord` 精确 schema、媒体类型与尺寸 allowlist、fork 继承解码 |
| `src/runtime/context/compaction/{cut-planner,schema,types,checkpoint-store}.ts`、`context/invariants.ts` | checkpoint 契约、配对原语 `isCompleteToolBatch`、`planCompactionCut`（**当前仅测试引用**）、invariant digest |
| `src/runtime/session-runtime/compaction-domain.ts` | Owner 编排：准入、Attempt、策略选择、工件、CAS 提交、`project()`、`assemble()` 内联 auto、`recoverOverflow()`、`preflightModel()`、6 标题校验、redaction 校验 |
| `src/runtime/session-runtime/compaction-model.ts` | `createSessionSummaryModel`：固定模型、工具关闭、router + trace、`COMPACTION_SYSTEM_PROMPT`（6 标题）、`SUMMARY_ENVELOPE_RESERVE = 256` |
| `src/runtime/session-runtime/compaction-native-model.ts` | V1 原生 port（单飞、预算、脱敏、`onUsage`） |
| `src/api/openai-responses.ts`、`src/api/openai-compaction-state.ts` | `compactOpenAIResponses`（`/responses/compact`）与 `OpenAICompactionState` 精确校验 |

投影与预算（已提交）：

| 文件 | 事实 |
|---|---|
| `src/runtime/context/model-request-adapter.ts` | 历史组以 `JSON.stringify` 落入字符串 fragment；`context.compaction` 是唯一独立载荷通道；`requiredHistoryPrefixCount` 保留已提交摘要 |
| `src/runtime/context/context-engine.ts`、`runtime-adapter.ts` | 片段预算选择；每次组装新建 `TokenEstimator`，`contentEstimate = max(fragment.estimatedTokens, estimator.estimate(content))` |
| `src/runtime/context/token-estimator.ts` | `conservativeTokenEstimate`（UTF-8 上界）；`TokenEstimator.observe()` **已定义但 src 内无调用点** |
| `src/runtime/agent-loop/loop-runner.ts` | 每次 provider 请求前 `modelContextAssembler`；overflow 时 `modelContextOverflowRecovery`；`modelSelectionPreflight` |
| `src/storage/settings-manager.ts:392-396` | `compaction` 只允许用户级设置 |
| `src/tui/interactive/plan-workflow.ts:23-36`、`src/cli/control-commands.ts:137-139,222-224,310` | `/compact` 与 `compact run` 的 `--strategy=` 三值白名单 |

### 2.3 门禁（决定代码落点）

- `src/runtime/context/**`（含 `context/compaction/`）：受 `scripts/check-runtime-boundaries.ts` 约束——**禁止** `node:fs|child_process|net|http|https`、`node:os`、`storage|tui|providers` 依赖、字面 `fetch(`。该目录只能放纯逻辑。
- `src/runtime/session-runtime/**`：受 `scripts/check-session-owner-boundaries.ts` 约束（legacy Host 消费、daemon/IPC、TUI 依赖、direct controller、fence-free write 等）。
- 新增测试文件必须落在 `tsconfig.tests.json`（或对应 tsconfig）覆盖范围内，否则 `check:consumers` 失败。
- 通用门禁：`npm run check`、`npm test`、`npm run build`（进 `dist` 时）、`git diff --check`；真实 CLI/TUI 用隔离 `RUNLEDGER_DIR` 与真实 PATH 的 `runledger`。

## 3. 服务 → 落点映射与决策

| omp 服务 | 目标落点 | 决策 | 理由（要点） |
|---|---|---|---|
| 阈值/预算纯函数（`compaction.ts:250-368`） | `context/compaction/history.ts` 新增预算模块 + `compaction-domain.assemble()` 的阈值判定 | **采用（O1）** | 补「provider usage 与本地估算取上界」的地板语义；reserve 表达式可移植且是纯函数 |
| 切点 `findCutPoint`（`:489`）与比率校正（`:1306`） | `history.ts` `planHistoryCut`（**替换**，不并存） | **采用（O1）** | 保留量应由 token 预算决定；turn 边界与配对不变量（RunLedger 现有约束）保留 |
| `cut-planner.ts` 的 `planCompactionCut` | 同上 | **收敛（O1）** | 当前**仅测试引用**的第二切点实现；O1 必须二选一并删除另一份，不能长期并存 |
| 文件操作清单（`utils.ts:17-182`） | 新 `context/compaction/summary-context.ts`（纯）+ summary 正文 | **采用（O2）** | 纯函数、无 I/O，可整段移植并标注来源 |
| 序列化/截断/边界转义（`utils.ts:200-231`） | 同上 | **采用（O2）** | `escapeSummaryBoundaryTags` 与 tool result 截断直接提升摘要输入质量与注入防护 |
| 摘要提示词契约（`compaction-summary.md`、`-update-summary.md`） | 新 `context/compaction/summary-format.ts` + `session-runtime/compaction-model.ts` 提示词常量 | **采用（O2，需改造）** | RunLedger 现有 6 标题校验硬编码在 domain 层；必须引入按格式校验才能容纳 omp 契约，并保住「无工具、不可信数据」不变量 |
| 工具输出剪枝（`pruning.ts`，supersede/useless） | 新 `context/compaction/projection-prune.ts`（纯）+ `compaction-domain.project()` | **采用（O3，需改造）** | 只作用于**投影**且必须是消息数组纯函数；丢弃 omp 的 wall-clock idle 分支以保证可重放 |
| 年龄型批量剪枝 `pruneToolOutputs` | 同上 | **延后（O3 之后）** | 需要更强的 prompt-cache 与收益门证据；先做无争议的 supersede/useless |
| handoff（`:1036-1146`） | 新策略 `handoff@1` + 格式 `handoff-document@1` | **采用（O4）** | 同一 model port 可承载；差异只在提示词与输出校验，不需要新 authority |
| provider 原生 V2（`compaction-v2-streaming.ts`） | `api/openai-responses.ts` 新增 V2 请求 + `compaction-native-model.ts` 模式选择 | **采用（O5）** | RunLedger 已有 V1 与 Responses client；V2 只需 `compaction_trigger` 与「恰好一个 compaction item」契约 |
| `stopReason === "length"` 恢复 | `loop-runner.ts` 恢复钩子 + `compaction-domain` 入口 | **采用（O5）** | RunLedger 当前无该路径；必须有界（上限计数）且不重放工具副作用 |
| snapcompact（`snapcompact.ts`） | 新 candidate kind + 图像投影通道 + 媒体类型契约 | **延后（O6，条件）** | 依赖原生 PNG 渲染 + 图像载荷通道 + 媒体/尺寸 allowlist 变更，是独立能力而非增量 |
| shake 重型块替换（`shake.ts`） | 待定（需恢复通路） | **延后（O7，条件）** | 替换后内容唯一，必须先把「模型可恢复读取」的通路定义进契约域，否则是有损删除 |
| 推测压缩 / idle / auto-continue / 多候选 fallback / 分支摘要 / 实验性 context 管理 | — | **拒绝** | 见 §8 |

## 4. 接口与文件级变更清单

### 4.1 `src/runtime/context/compaction/`（纯逻辑，禁 I/O）

1. **`history.ts` 改造（O1）**
   - `planHistoryCut` 输入从 `retainRecentTurns` 改为 `retainRecentTokens`；保留「只切完整稳定 turn、未配对 batch 一律不切」不变量与 unit 构造（unit 仍是可 JSON 化的完整 turn 数组）。
   - 新增比率校正：以最近一次 provider usage 的 prompt tokens 与本地估算之比校正保留量；比率缺失或不合理（≤1、非有限）时不校正。
   - 新增预算表达式：`resolveThresholdTokens(window, settings)`、`effectiveReserveTokens(window, settings)`、`compactionContextTokens(providerTokens, localEstimate)`，数值语义与来源一致（`DEFAULT_RESERVE_TOKENS = 16384`、`max(15%, reserve)`、未显式设置 reserve 时的小窗口回落）。
   - `planCompactionCut`/`CompactionTurn`/`CompactionCutPlanningError`：O1 决定保留（改造成唯一实现）或删除（若 `planHistoryCut` 已覆盖其全部行为），测试同步更新。
2. **`summary-format.ts`（新，O2）**：`SummaryFormatId`（至少 `headings@1`、`headings-update@1`、`handoff-document@1`）、每格式的结构校验函数、`formatRegistry`。校验仍是**纯函数 + 有界**；redaction 与 authority 校验留在 domain。
3. **`summary-context.ts`（新，O2）**：移植 `utils.ts` 的文件操作追踪（`extractFileOpsFromMessage` 的 RunLedger 版：从 `toolCall` 的 `read`/`write`/`edit` 与 `path` 参数提取）、`computeFileLists`、`formatFileOperations`、`upsertFileOperations`、read selector 处理、URL scheme 排除、`truncateToolResultForSummary`、`escapeSummaryBoundaryTags`。全部纯函数，文件头标注来源（`来源 oh-my-pi <commit> packages/agent/src/compaction/utils.ts`，对齐既有标注习惯）。
4. **`projection-prune.ts`（新，O3）**：`planProjectionPrune(messages, config)` 返回替换清单 + 收益估算，纯函数、**不使用时钟**；`supersede`（同路径更新读存在时消隐旧 read 结果）与 `useless`（结果自报 useless）两类；保护名单（skill 读取、活跃 plan 引用、已提交摘要前缀）沿用 RunLedger 既有保护语义。
5. **`strategy.ts` 扩展（O2/O4）**
   - `SummaryModelPort.generate` 输入增加 `format: SummaryFormatId` 与可选 `previousSummary`（迭代契约从「当普通输入拼接」升级为独立通道）。
   - `CompactionStrategy` 增加 `formatId`；registry 在 `generate` 后用 `summary-format.ts` 校验候选（替换目前只能在 domain 做的标题检查）。
   - candidate 联合暂不扩展；O6 若启动，按 `plan-compact-memory/01` §6.5.1 D 的既有约定升级为 discriminated union 并登记 validator/projection adapter。
6. **`settings.ts`（O1/O2/O3）**：`retainRecentTurns` → `retainRecentTokens`（边界重设）；`strategy` 联合增加 `handoff`；新增 `pruneSuperseded` / `dropUseless` 布尔；`summaryModel` 与阈值字段不变。`settings-manager.ts` 的「仅用户级」约束不变。
7. **`record.ts`（O2/O4）**：`strategy.id` 允许新 id（正则已支持 `[a-z][a-z0-9-]{0,63}`）；若摘要格式影响恢复语义，把 `formatId` 纳入 `strategy` 或 record 的新增字段并同步精确 schema、`decodeCompactionRecord`、`tests/runtime-contracts/inventory.test.ts` 与 `contracts/inventory.ts` 的 owner 指针。

### 4.2 `src/runtime/session-runtime/`（编排）

1. **`compaction-model.ts`（O2）**：提示词常量按格式拆分；保留「工具关闭、内容是不可信数据、不得编造批准/权限/验证」与 `SUMMARY_ENVELOPE_RESERVE`；system prompt 与 user prompt 的边界规则沿用 `escapeSummaryBoundaryTags` 语义。
2. **`compaction-domain.ts`（O1/O2/O3/O4）**
   - `assemble()` 阈值判定改为 `compactionContextTokens(providerUsage, localEstimate) >= resolveThresholdTokens(...)`；provider usage 缺失时退回本地估算。
   - `run()`：把硬编码 6 标题校验替换为格式校验；在 cut 之前对**保留尾部**应用投影剪枝（不得触碰 `[0, count)` 前缀，否则 `prefixDigest` 失效）；`focus`/`strategy` 校验列表同步扩展。
   - `project()`：投影剪枝必须与 `prefixDigest`、`protectedStateDigest`、`projectionDigest` 的现有校验兼容，且**幂等**（对同一输入重复投影结果一致）。
3. **`compaction-native-model.ts` + `api/openai-responses.ts`（O5）**：新增 V2 请求构造（`compaction_trigger` 尾部 item、`prompt_cache_key`、session 路由头）与响应解析（**恰好**一个 `compaction` output item）；沿用现有 `OpenAICompactionState` 与端点 digest 校验；V2 门只依据本地可判定条件（provider/api/端点），不假设 catalog 提供 `remoteCompaction` 元数据（RunLedger 当前无该字段）。
4. **`src/runtime/agent-loop/loop-runner.ts`（O5）**：`stopReason === "length"` 的有界恢复入口（新 config 钩子，形如 `modelIncompleteOutputRecovery`），上限计数、超限即正常结束；恢复不得重放已完成工具副作用。上限数值按 RunLedger 自身预算设定（来源语义为连续无进展 3 次，见 `00` §2.8），不复用来源常量。

### 4.3 会话面

`src/tui/interactive/plan-workflow.ts`、`src/cli/control-commands.ts`、`src/tui/commands/registry.ts` 的 `--strategy=` 白名单与 usage 文本同步新增策略；`/compact` 仍只做 manual mutation，不新增旁路入口。

### 4.4 契约变更顺序（O0 冻结）

- O1 修改纯切点与用户设置，不改 Owner 命令/record schema；删除未接线的第二切点实现，保留配对原语。旧 `retainRecentTurns` 明确拒绝，不隐式换算。
- O2 的格式与 `previousSummary` 属内部 model port；格式 ID 使用现有 `@1` 命名。仅当恢复需要新增持久字段时，先更新 Runtime 04、精确 decoder 与 inventory，再实现写入；否则保持既有 record 格式。
- O3 只生成派生请求消息，不修改 ledger、已提交前缀、工件或持久事件形状。
- O4 先在 Runtime 04 登记策略扩展，再改 registry 与 CLI/TUI 枚举；沿用 portable 工件格式。
- O5 的 loop recovery hook 为内部端口；原生状态继续沿用现有精确格式。若实际协议要求新增持久字段，先登记 Runtime 04 再修改 decoder，禁止静默迁移。
- O6/O7 的公共载荷、图像与模型恢复 authority 尚无前置证据，本轮不启动。

## 5. 阶段

阶段与 `plan-compact-memory/01` 的 C 阶段是**增量**关系（O1 建立在 C1–C2 之上，O5 扩展 C5），不重排、不重记 C 阶段状态。

### O0：冻结接入合同（文档）

状态：`done`（2026-09-15）。核对已提交基线、上游固定快照、相对链接与账本权责；`git diff --check` 通过。这里只交付接入合同，不作为运行时代码或 provider 验收证据。

前置：无。
文件边界：本目录三份文档；`plan-compact-memory/01` 仅加指针；`00-index.md` 登记。
交付物：本文件 + `00` 事实清单 + `README.md`；契约变更清单（§4 的逐条 delta，标注哪些需要 Runtime 04 先动）。
必须验证：文档链接可达、与账本无冲突表述、`git diff --check` 无告警。
不得声称：任何能力已实现。

### O1：切点与预算（token 预算 + provider usage 地板）

前置：O0；C1–C2 的适配器核心可用。
文件边界：`context/compaction/history.ts`、`settings.ts`、`cut-planner.ts`（收敛决定）、`session-runtime/compaction-domain.ts`（阈值与剪枝调用点预留）、对应测试。
交付物：token 预算切点、比率校正、预算/阈值纯函数、观测校准接线（`TokenEstimator.observe` 的生产调用点）。
必须验证：
- 切点用例：完整 turn 边界、未配对 batch 拒绝、token 预算边界（恰好等于/略超）、比率缺失回退；
- 阈值用例：本地估算高于/低于 provider usage 两种地板行为、reserve 未设置与显式设置的小窗口差异；
- 现有 `compaction-domain.test.ts` 全绿（行为语义不得回归，尤其是自动压缩与抑制）。
不得声称：精确 token 计数（仍是上界估算）。

### O2：摘要格式 seam + 迭代更新 + 文件清单

前置：O1。
文件边界：`summary-format.ts`、`summary-context.ts`（新）、`strategy.ts`、`summary-strategies.ts`、`session-runtime/compaction-model.ts`、`compaction-domain.ts`（校验替换）、`record.ts`（若格式入 schema）、相关测试与 `tests/runtime-contracts/inventory.test.ts`。
交付物：按格式校验的 registry；`single-pass@1` 支持独立 `previousSummary` 通道与 update 契约；`<files>` 清单生成与 upsert；工具结果截断与边界转义；RunLedger 6 标题格式保留为 `headings@1`。
必须验证：第二次 compact 保留前次关键事实并刷新进度段；`<files>` 不重复堆叠且上限生效；非法/超限/含 secret 输出被拒；格式与策略不匹配时明确失败（不静默换策略）。

### O3：投影剪枝（supersede / useless）

前置：O1。
文件边界：`projection-prune.ts`（新）、`compaction-domain.ts` 的 `project()`/`run()`、`settings.ts`、测试。
交付物：确定性、无时钟的投影瘦身；只作用于保留尾部；`pruneSuperseded` / `dropUseless` 开关（默认按来源语义开启 supersede、保守处理 useless）。
必须验证：同一历史重复投影逐字节一致（S2）；`[0, count)` 前缀与 `prefixDigest` 不受影响；配对完整性不被破坏；被消隐内容仍可从 raw ledger 恢复（人工/运维路径，不需要模型侧通路）；小结果不消隐（无净收益）。
不得声称：可恢复的模型侧读取通路（O7 才涉及）。

### O4：handoff 策略

前置：O2。
文件边界：`summary-strategies.ts`、`summary-format.ts`、`settings.ts`、`compaction-domain.ts`（策略白名单）、TUI/CLI 白名单、测试。
交付物：`handoff@1` + `handoff-document@1` 格式校验；文档正文作为工件正文提交；恢复与 fork 语义与其他 portable 策略一致。
必须验证：doc 结构校验（缺段/超限/含 secret 被拒）；重启后投影一致；fork 继承与 rewind 两侧行为不变；手工切换策略只影响新操作。

### O5：provider 原生 V2 + length-stop 恢复

前置：O2；V1 路径已有证据。
文件边界：`api/openai-responses.ts`、`api/openai-compaction-state.ts`（如需）、`session-runtime/compaction-native-model.ts`、`compaction-domain.ts`、`agent-loop/loop-runner.ts`、`runtime/types.ts`（新钩子类型）、测试。
交付物：V2 streaming 压缩请求/响应与状态恢复；端点与 provider 兼容校验；不兼容时**明确失败**（不静默降级为本地摘要）；`stopReason === "length"` 的有界恢复。
必须验证：本地确定性 HTTP server 上的 V2 请求形状（尾部 `compaction_trigger`、恰好一个 compaction item、缺 item 或多项即失败）；重启恢复同一 provider 窗口；provider/模型切换拒绝；length 恢复计数上限与「不重放工具副作用」断言；overflow 路径不回归。
不得声称：真实外部 provider E2E（需真实凭据与对应 provider 证据）。

### O6（条件）：snapcompact 图像归档通道

前置：契约域先关闭四项门禁——(a) candidate 联合升级为含图像载荷的 discriminated union；(b) 投影新增独立图像通道（不能塞进字符串 fragment）；(c) `record.ts` 的媒体类型与尺寸 allowlist 扩展且有界；(d) 模型 vision 能力与计费边界（`requiresImages` 路由、帧 token 估算）。渲染实现需在**非契约目录**（native 或 `session-runtime` 之外）落地，纯 JS 替代或复用 native 交付链，二者都必须先有独立专项结论。
go/no-go 依据：目标 provider 的真实 vision 计费与召回评测证据（对齐 omp 在 `packages/snapcompact` 的 eval 结论），无证据则保持 `deferred`。
必须验证：帧载荷字节上限、图像块在重启/fork/rewind 后的恢复、含 secret 文本在渲染前已被脱敏、vision 不可用模型上的明确拒绝。

### O7（条件）：重型块 shake 与恢复通路

前置：契约域先定义「模型可见的压缩内容恢复读取」通路（当前 RunLedger 无 `artifact://` / `history://` 类内部路由，也没有 offload 机制；不得先用有损替换再补通路）。
交付物：仅在通路存在且被授权时，移植 `collectShakeRegions`/`applyShakeRegions`（纯函数）与保守预设；否则本阶段保持 `blocked`。
不得声称：把「内容仍可被运维从 ledger 读出」当成模型侧可恢复。

## 6. 验证矩阵

| 维度 | 必测场景 |
|---|---|
| 切点与预算 | token 预算边界、比率校正缺失/异常、未配对 batch、非 turn 起点不切 |
| 阈值 | provider usage 与本地估算的上界地板、reserve 未设置/显式、小窗口回落、自动压缩抑制 |
| 格式 | 每格式的缺失段/超长/含 secret/空输出；策略与格式不匹配 |
| 迭代 | 二次 compact 保留前次事实、进度段迁移、`<files>` 合一 |
| 剪枝 | 幂等与逐字节一致、前缀不变、配对完整、最小收益门 |
| 原生 | V1 不回归、V2 请求/响应形状、恰好一个 compaction item、恢复与不兼容拒绝 |
| 恢复 | 重启投影一致、fork 继承、cut 两侧 rewind、length 恢复上限 |
| 故障注入 | intent 后、模型返回后、工件写入后、事务提交前后、内存发布前后的原子性（沿用 C2 的崩溃注入要求） |
| 门禁 | `npm run check`、`npm test`、`npm run build`、`git diff --check`；进 `dist` 时以隔离 `RUNLEDGER_DIR` 走真实 `runledger` 的 `/compact`、重启恢复与干净退出 |

## 7. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| 本地估算远高于真实占用 | 阈值提前触发，压缩频繁、成本上升 | O1 引入比率校正与 provider usage 取上界；阈值用例锁定抖动边界 |
| 投影剪枝破坏缓存/可重放 | 同一历史两次请求不同、prompt cache 反复失效 | 只做消息数组纯函数、禁用时钟分支、投影 digest 断言 |
| 格式校验成为新 authority | 弱化「不得编造批准/验证」等不变量 | 格式校验只管结构与长度；authority/redaction/预算校验仍留在 domain |
| 接入改动扩散到旧 Host | 双 authority 复活 | O 阶段不动 `cli/runtime-host-*`；门禁 `check-session-owner-boundaries` 兜底 |
| V2 假设了 catalog 不存在的元数据 | 门失效或误开 | 只依据本地可判定条件；不确定时保持 V1 |
| 在飞未提交改动与他方工作冲突 | 覆盖他人进度 | 动手前复核 `git status`，只改本阶段文件；必要文件先与账本对齐 |
| 两套切点实现长期并存 | 语义漂移 | O1 强制收敛（接线或删除） |

## 8. 拒绝项与重新评估触发条件

| 拒绝项 | 理由 | 重新评估触发 |
|---|---|---|
| 分支摘要（`branch-summarization.ts`） | RunLedger 的分叉由 fork 继承 committed compaction + raw ledger 承担；引入「被放弃分支摘要」会造第二历史权威 | 出现真实树导航需求且权限模型已定义 |
| 实验性 context 管理（`context_notes`/`new_context`/`history://`） | 需要模型可写的持久笔记与原始历史回读，等于把 authority 交给模型；与 ledger 权威重叠 | 产品明确要求且先改契约域 |
| 推测（异步）压缩 | 后台付费摘要仍是一次外部 mutation，必须有 Attempt/fence；收益（隐藏延迟）不抵治理成本 | 交互延迟证据显示必要，且 Attempt 语义获授权 |
| idle 维护 / auto-continue 提示 | RunLedger 无 idle 语义；自动续跑属于产品行为，不在压缩接入范围 | 产品需求明确 |
| 多候选模型 fallback | 与「固定 summaryModel、无静默 fallback」冲突 | 不作重新评估 |
| 原生 tokenizer（`pi_natives.countTokens`） | 引入 native addon 交付链；当前上界估算 + 观测校准已满足 fail-closed 预算 | 独立 native 专项，且有精确计数的收益证据 |
| omp journal/entry 模型与 `preserveData` | 与 RunLedger 事件流 + 工件权威重复 | 不作重新评估 |

## 9. 文档与索引同步

1. `development-doc/00-index.md`：模块导航表新增本专题行；目录结构树补 `compact/` 条目（该树当前还缺 `plan-compact-memory/`，本次一并补齐，属同一处文档一致性修复）。
2. `development-doc/plan-compact-memory/01-implementation-plan.md`：在 §0.5 之后加一条指向本目录的指针（不改 C 阶段结论与复选框）；§6.5.1 的 C 表格不复制本文件的 O 阶段。
3. 契约模块若有变更（`inventory.ts` 登记的文件），同步其 owner 指针与 `tests/runtime-contracts/inventory.test.ts`。
4. 代码内移植出处按 `providers/02` 的既有写法就近标注（`来源 oh-my-pi <commit> <上游路径>`）。

## 10. 证据规则与提交边界

- 每阶段完成时的证据必须来自目标 commit 的 fresh 运行：focused 测试命令 + `npm run check` 输出 + （进 `dist` 时）build 与真实 CLI/TUI 路径；历史结果只能作参考（对齐 providers/02 §6）。
- 阶段独立提交，commit message 说明问题、改动目的与验证；不把 `git status` 中他人改动混入。
- 未达到「生产组合通过」的阶段只能标 `partial`；真实 provider、人工视觉/键盘/中文 IME、macOS/Windows 是相互不可替代的证据层，缺失时明确记为 pending，不伪造通过。
