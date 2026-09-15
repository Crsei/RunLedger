# oh-my-pi 压缩服务事实清单（RunLedger 接入取证）

> 状态：设计取证，不代表 RunLedger 已实现接入，也不代表这些 omp 能力在目标仓可用。
> 来源快照：oh-my-pi `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`（`@oh-my-pi/pi-agent-core` 18.1.17、`@oh-my-pi/snapcompact` 18.1.17，来源工作树干净、0 dirty 文件）。
> 目标基线：RunLedger `9057668f1ec6fff5603b89513da94a20ce3d07b0`（分支 `rollback/before-composer-shape`）；压缩适配器在飞未提交文件清单见 [01-integration-plan.md](01-integration-plan.md) §2。
> 下所有行号以来源快照为准；本文件只记录可在源码中验证的事实，不复述上游文档宣传语。文档与代码冲突处标注「以代码为准」。

## 0. 取证边界

本文件只回答四件事：

1. omp 有哪些上下文压缩服务，各自的入口、导出与数值。
2. 每个模块的耦合度（纯函数 / 仅类型面耦合 / host-coupled）。
3. 移植到 RunLedger 时的硬阻断点。
4. 与 RunLedger 现有 compact 适配器的能力对照与缺口。

不定义 RunLedger 公共契约（归 `development-doc/runtime/04-governed-agent-harness-runtime-plan.md`），不定义 authority 与生命周期（归 `development-doc/plan-compact-memory/01-implementation-plan.md`），不声称任何实现状态。

包名事实（文档常误写）：`Tokenizer` 不在 `@oh-my-pi/pi-ai`，在 `packages/agent/src/tokenizer.ts`，包名 `@oh-my-pi/pi-agent-core`；`packages/agent/package.json:3` 可验证。聚合入口 `packages/agent/src/compaction.ts:1` → `packages/agent/src/compaction/index.ts:5-15`（branch-summarization / compaction / entries / errors / message-cache / messages / openai / pruning / shake / transcript-tokens / utils），`compaction/openai.ts:60` 再 `export * from "./compaction-v2-streaming"`。

## 1. 服务分层

omp 把「缩小 model-visible context」拆成三条正交路径，加一层触发与一层编排：

```text
触发层  threshold / overflow / incomplete(stopReason=length) / idle / manual / mid-turn
  │
编排层  prepareCompaction(切点+文件操作+预算) → compact()（remote V2 → V1 → 本地摘要 → 文件清单 upsert）
  │
  ├─ 路径 A  pruning  就地清空 tool result 正文（不动 turn 结构、不删 entry）
  ├─ 路径 B  shake    就地替换 tool result 文本与 fenced/XML 重负载块
  └─ 路径 C  compaction / snapcompact  重建 context：summary 替换旧历史 + 保留 tail + preserveData 存档
```

三条路径共享四个边界旋钮：`keepBoundaryId`(=`firstKeptEntryId`)、`protectTokens`、`cacheWarmSuffixTokens`、`protectedTools` matcher。

## 2. 逐服务事实

### 2.1 阈值与预算（`compaction/compaction.ts`，纯函数、仅类型面依赖 `Usage`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:250` | `calculateContextTokens(usage)` | 优先 `usage.contextTokens`；否则 `totalTokens`／`input+output+cacheRead+cacheWrite` 再减去 `orchestration` 的 input/output/cacheRead 三项（编排 token 计费但不重放进 context 前缀） |
| `:262` | `calculatePromptTokens(usage)` | `contextTokens` → `input+cacheRead+cacheWrite`(>0) → 回退 `calculateContextTokens` |
| `:273` | `hasContextTokenUsage(usage)` | 是否存在可信 context 占用 |
| `:298` | `getLastAssistantUsage(entries)` | 从 journal 末尾向前取最近非 aborted/error 的 assistant usage |
| `:313` | `effectiveReserveTokens(window, settings)` | `max(floor(window*0.15), settings.reserveTokens ?? 16384)` |
| `:329` | `resolveBudgetReserveTokens(window, settings)` | **仅当 `reserveTokens` 未显式设置**且默认值对该窗口不可行（≥ `window-15%` 或 ≥ `window`）时改用 `max(1, floor(window*0.15))`；显式值即使等于默认也保留（用「未设置」而非「值等于默认」判别 provenance） |
| `:343` | `shouldCompact(tokens, window, settings)` | `!enabled \|\| strategy==="off" \|\| window<=0` → false；否则 `tokens > resolveThresholdTokens(...)` |
| `:364` | `compactionContextTokens(providerContextTokens, storedConversationEstimate)` | 两者各自 clamp(≥0) 后取 **max**：provider usage 是下界，本地估算做地板，防止 on-wire 压缩（Headroom 类扩展）压低上报值而让真实历史无界增长 |
| `:368` | `resolveThresholdTokens(window, settings)` | `thresholdTokens>0` 优先且 clamp `[1, window-1]`；否则 `thresholdPercent` clamp `[1,99]`；两者无效则 `max(0, min(window-1, window - resolveBudgetReserveTokens(...)))` |

默认值：`:197` `DEFAULT_RESERVE_TOKENS = 16384`；`:209` `MAX_SUMMARY_TOKENS = DEFAULT_RESERVE_TOKENS`；`:214` `DEFAULT_COMPACTION_SETTINGS`（`keepRecentTokens: 20000`、`midTurnEnabled: true`、`autoContinue: true`、`remoteEnabled: true`、`remoteStreamingV2Enabled: true`），**刻意不含 `reserveTokens`**——unset 即 provenance 信号。

### 2.2 切点与分区（`compaction/compaction.ts`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:405` | `findValidCutPoints`（**模块私有**） | 合法切点＝role 为 `user`/`assistant`/`bashExecution`/`hookMessage`/`branchSummary`/`compactionSummary` 的 message 条目，以及 `branch_summary`/`custom_message` 条目；**`toolResult` 永不作为切点** |
| `:447` | `findTurnStartIndex(entries, entryIndex, startIndex)` | 向前找 turn 起点（`user`、`bashExecution`、`branch_summary`、`custom_message`）；找不到返回 -1 |
| `:489` | `findCutPoint(entries, tokenizer, startIndex, endIndex, keepRecentTokens)` | 从新到旧累加 `tokenizer.countMessage()`，累计 ≥ `keepRecentTokens` 时取该位置**之后最近**的合法切点；再向左吞入非 message 条目（遇 `compaction` 或 message 即停）；返回 `{firstKeptEntryIndex, turnStartIndex, isSplitTurn}` |
| `:1306` | `prepareCompaction(pathEntries, settings, activeModel?, tokenizer?)` | 定位最近**可被当前模型读取**的 compaction（`findReadableCompactionIndex`），honor 更新的 `reset_boundary`，把 `firstKeptEntryId` 起的原始 entry 与之后 entry 摊平，按 `promptTokens/estimatedTokens` 比率校正 `keepRecentTokens`，然后切成 `messagesToSummarize` / `turnPrefixMessages` / `recentMessages` 三区并抽取文件操作 |
| `:1262` | `remotePreserveReusable(preserveData, activeModel, settings)` | provider 原生压缩载荷只有在 active model 与该载荷 provider 相同且 remote replay 仍启用时才可复用，否则视为不可读、必须重新展开本地摘要 |
| `:1287` | `findReadableCompactionIndex(pathEntries, settings, activeModel?)` | 返回最近可读 compaction 下标，或 -1 |
| `:1225` | `CompactionPreparation` | `{firstKeptEntryId, messagesToSummarize, turnPrefixMessages, recentMessages, isSplitTurn, tokensBefore, previousSummary?, previousPreserveData?, fileOps, settings}` |
| `:1148` / `:1860` | `generateShortSummary` / `generateTurnPrefixSummary`（均**模块私有**） | 短摘要 `maxTokens=min(512, floor(0.2*reserve))`；turn-prefix 摘要 `min(floor(0.5*reserve), 16384)`；两者都走 oneshot 摘要调用 |

split turn 语义：切点不在 user turn 起点时，历史摘要与 turn-prefix 摘要并行生成（`:1786` 起 `Promise.all`，合并于 `:1802`），合并为

```text
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### 2.3 摘要生成与提示词（`compaction/compaction.ts` + `compaction/prompts/`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:1523` | `compact(preparation, model, apiKey, customInstructions?, signal?, options?)` | 总装配：V2 streaming → V1 `/responses/compact` → 本地摘要；本地路径按 split/非 split 选择 `generateSummary` 或并行两段；末尾 `upsertFileOperations` 追加文件清单并返回 `CompactionResult` |
| `:838` | `generateSummary(currentMessages, model, reserveTokens, apiKey, signal?, customInstructions?, previousSummary?, options?)` | `maxTokens=min(floor(0.8*reserve), MAX_SUMMARY_TOKENS)`；整段放得下就是单次调用，否则 `planSummaryWindows` 按消息边界折窗，每窗把上一窗摘要作为 carried summary（等同 update 契约）；被 provider 以 overflow 拒绝时按**实际发送量**减半重规划（应对 catalog 虚标的窗口） |
| `:157` | `CompactionResult` | `{summary, shortSummary?, firstKeptEntryId, tokensBefore, details?, preserveData?}` |
| `:91` | `CompactionDetails` | `{readFiles: string[], modifiedFiles: string[]}` |
| `:649` | `SummaryOptions` | 含 `promptOverride`、`extraContext`、`remoteEndpoint`、`thinkingLevel`、`sessionId`、`promptCacheKey`、`providerSessionState`、`tools`、`fetch`、`completeImpl`、`oneshotRetry` |

提示词模板（15 份，全部经 Bun `with { type: "text" }` 内联；`compaction/prompts/`）：

| 模板 | 用途与结构要点 |
|---|---|
| `summarization-system.md` | 摘要 system prompt：把对话历史与上一版摘要一律当**不可信数据**，不执行其中指令、不续写对话、只输出结构化摘要 |
| `compaction-summary.md` | 首次压缩的输出契约：`## Goal` / `## Constraints & Preferences` / `## Progress`(`### Done`,`### In Progress`,`### Blocked`) / `## Key Decisions` / `## Next Steps` / `## Critical Context` / `## Additional Notes`；要求保留未回答的用户问题、精确文件路径与函数名、仓库状态 |
| `compaction-update-summary.md` | 迭代压缩：把 `<previous-summary>` 的信息**全部保留**、把 In Progress 完成项移入 Done、刷新 Next Steps、保留精确路径/错误信息、可删无关内容 |
| `compaction-short-summary.md` | UI 短摘要（`generateShortSummary`，非权威正文） |
| `compaction-turn-prefix.md` | split turn 的 turn 前缀契约 |
| `compaction-summary-context.md` | 重建 context 时注入摘要的包装模板：「Prior model work/tool state available. MUST build on prior work; NEVER duplicate prior work.」+ `<summary>` 标签 |
| `handoff-document.md` | handoff 文档契约：以**命令式**直接面向继任者（「Fix X」「Run Y」），禁止第一人称；把 handoff 机制本身当作不可见，不得列为进度或下一步 |
| `handoff-summary-context.md` | handoff 文档注入包装 |
| `auto-handoff-threshold-focus.md` | 阈值触发的 handoff focus 措辞 |
| `file-operations.md` | `<files>` XML 包装 |
| `context-window-truncated-output.md` | 超窗 tool output 被重写时的替换文本 |
| `snapcompact-archive-context.md` | snapcompact 源文本迁移包装 |
| `branch-summary.md` / `branch-summary-preamble.md` / `branch-summary-context.md` | 分支摘要三件套（本接入范围外） |

### 2.4 文件操作清单（`compaction/utils.ts`，纯函数、仅类型面耦合 `AgentMessage`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:17` / `:23` | `FileOperations` / `createFileOps()` | `{read: Set, written: Set, edited: Set}` |
| `:48` / `:76` | `splitReadSelector` / `stripReadSelector` | 解析 read 工具尾部 selector（行范围列表、`raw`、`conflicts`、`range:raw` 复合），使同一文件的不同行区间在清单里去重 |
| `:93` | `isUrlSchemePath(path)` | `scheme://` 一律排除出 `<files>` |
| `:100` | `extractFileOpsFromMessage(message, fileOps)` | 只认 assistant toolCall 的 `path`：`read`→read（去 selector）、`write`→written、`edit`→edited |
| `:137` | `computeFileLists(fileOps)` | 过滤 URL scheme，read-only 排除 modified，两边排序 |
| `:154` / `:165` / `:182` | `FILE_OPERATION_SUMMARY_LIMIT = 20` / `formatFileOperations(readFiles, modifiedFiles, readSet?)` / `upsertFileOperations(summary, ...)` | 渲染分组、前缀折叠的目录树，带 `(Read)`/`(Write)`/`(RW)` 标记，超 20 个文件追加 `[…N files elided…]`；upsert 先剥离旧 `<files>`/`<read-files>`/`<modified-files>` 再追加（旧摘要自愈） |
| `:200` / `:205` | `TOOL_RESULT_MAX_CHARS = 2000` / `truncateToolResultForSummary(text)` | 摘要输入里的 tool result 上限 2000 字符，超出追加 `[... N more characters truncated]` |
| `:214` | `escapeSummaryBoundaryTags(text)` | 把 `</?conversation>`、`</?previous-summary>` 转义成 `&lt;…`，防止摘要输入伪造 harness 边界标签 |
| `:221` / `:231` | `serializeConversationForSummary` / `serializeConversation` | 序列化为纯文本；anthropic dialect 丢弃 thinking；无 dialect 走 `[User]/[Think]/[Assistant]/[Tool Call]/[Tool Result]` 旧格式；丢弃被标记 `useless` 的非错误结果及其配对 call |
| `:350` | `SUMMARIZATION_SYSTEM_PROMPT` | 由 `prompts/summarization-system.md` 渲染 |

### 2.5 工具输出剪枝 `pruning`（`compaction/pruning.ts`，440 行，纯函数 + `Tokenizer` + 宿主 entry 类型）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:18` / `:54` | `PruneConfig` / `DEFAULT_PRUNE_CONFIG` | 默认 `protectTokens: 40_000`、`minimumSavings: 20_000`、`protectedTools: ["skill", isSkillReadToolResult]`、`pruneUseless: true` |
| `:67` / `:70` | `SUPERSEDED_NOTICE` / `USELESS_NOTICE` | `"[Superseded by a newer read of this file]"` / `"[Uneventful result elided]"` |
| `:81` | `SupersedePruneConfig` | 另有 `DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000`(`:108`)、`DEFAULT_IDLE_FLUSH_MS = 30*60000`(`:109`)、`MIN_PRUNE_TOKENS = 50`(`:123`) |
| `:252` | `pruneSupersededToolResults(entries, tokenizer, config)` | 消隐被同路径更新读取代的 read 结果，以及工具自报 `useless` 的结果；仅当候选之后的**后缀** ≤ `suffixTokenLimit`，或会话 idle 超过 flush 阈值时才动手（避免反复翻转 prompt cache） |
| `:312` | `pruneToolOutputs(entries, tokenizer, config)` | 年龄型批量剪枝：保护最近 `protectTokens`，总节省不足 `minimumSavings` 时返回 `{0,0}` 且**不改写**；替换为 `[Output truncated - N tokens]` |
| `:433` | `readToolSupersedeKey(toolName, args)` | `read` 专用 supersede key（含 selector 时 `base\u0000sel`） |
| `:123` | `MIN_PRUNE_TOKENS = 50` | 小于该值不清：占位符本身约 8 token，无净收益还会翻转 cache |

剪枝统一动作：`message.content = [{type:"text", text: notice}]`、写 `prunedAt`、`invalidateMessageCache(message)`。

### 2.6 机械瘦身 `shake`（`compaction/shake.ts`，475 行，纯函数 + `Tokenizer`）

| 位置 | 导出 | 数值/语义 |
|---|---|---|
| `:27` | `ShakeConfig` | `{protectTokens, minSavings, protectedTools, fenceMinTokens, keepBoundaryId?}` |
| `:47` | `DEFAULT_SHAKE_CONFIG` | 自动 shake：`protectTokens 16_000`、`minSavings 4_000`、`fenceMinTokens 400`，额外保护 artifact 恢复结果 |
| `:60` | `AGGRESSIVE_SHAKE_CONFIG` | 手动 `/shake`：`protectTokens 4_000`、`minSavings 0` |
| `:68` | `RESCUE_SHAKE_CONFIG` | 压缩死路救援：`protectTokens 0`、`minSavings 0` |
| `:316` | `collectShakeRegions(entries, tokenizer, config)` | 纯检测：定位可替换的 tool result 文本与 fenced code block / 顶层 XML 元素跨度；倒序累计保护窗口；`sum(max(0, tokens-16)) < minSavings` 时返回空 |
| `:436` / `:468` | `applyShakeRegion` / `applyShakeRegions` | 纯变更：就地替换；block region 按 start **降序**应用以免偏移错位 |
| `:78` | `PLACEHOLDER_TOKEN_ESTIMATE = 16`（私有） | 占位符自身 token 估算，仅用于收益门 |

### 2.7 位图归档 `snapcompact`（`packages/snapcompact/src/snapcompact.ts`，2185 行）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:2037` | `compact(preparation, options?)` | 无需模型/网络的本地归档：序列化 → normalize → 分页/分帧 → **原生 PNG 渲染** → 文件清单 → `preserveData` |
| `:1703` / `:1740` / `:1749` | `getPreservedArchive` / `stripPreservedArchive` / `archiveSourceText` | `PRESERVE_KEY="snapcompact"`(`:533`) 下的 archive 读写与源文本回读（`text` 优先，否则 `textHead + NEWLINE_GLYPH + textTail`） |
| `:1832` / `:1820` / `:1772` / `:496` | `historyBlocks` / `images` / `HistoryBlockOptions` / `frameDataBytes` | 重建 context 时按老→新还原 image blocks（含省略帧提示文本）与字节预算 |
| `:563` / `:540` | `Archive` / `Frame` | `Archive{frames, totalChars, truncatedChars, text?, textHead?, textTail?}`；`Frame{data, mimeType, cols, rows, chars, font?, variant?, ...}` |
| `:757` / `:737-748` | `SerializeOptions` / 序列化常量 | `TOOL_RESULT_MAX_CHARS 2000`、`TOOL_ARG_MAX_CHARS 500`、`TOOL_CALL_MAX_CHARS 2000`、`TRUNCATE_HEAD_RATIO 0.6`、`DIM_ON/DIM_OFF` 灰墨标记 |
| `:455` / `:464` / `:469` / `:475` / `:481` / `:488` | 帧预算常量 | `FRAME_SIZE 2576`、`MAX_FRAMES_DEFAULT 80`、`HQ_EDGE_FRAMES 3`、`FRAME_TOKEN_ESTIMATE 5024`、`FRAME_DATA_BYTES_ESTIMATE 170_000`、`FRAME_DATA_BYTES_BUDGET 3_000_000` |
| `:61` / `:107` / `:198` / `:259` / `:280` / `:366` / `:404` / `:437` | `Shape` / `SHAPE_VARIANTS`(19 个) / `SHAPE_VARIANT_NAMES` / `isShapeVariantName` / `SHAPES` / `isShape` / `idealShapeVariant(modelId)` / `resolveShape` / `resolveShapeForText` | 形状表按 model id / provider family 解析；`SHAPES` 是 eval 优胜形状（anthropic/google/openai/unknown） |
| `:1618` / `:1654` / `:1689` | `render` / `renderMany` / `frames` | 唯一原生渲染入口（`render`），只算帧数不渲染（`frames`） |
| `:1345` / `:1353` / `:1390` / `:1512` / `:1568` | `normalize` / `scanRenderability` / `dimStopwords` / `wrap` / `geometry` | 渲染前处理，纯 JS |

运行时依赖（决定可移植性）：`:50` `import { renderSnapcompactPng, snapcompactSupportedChars } from "@oh-my-pi/pi-natives"`（N-API Rust addon，绑定见 `packages/natives/native/index.js:105`、`:109`），字体**编译进原生插件**（`crates/pi-natives/src/fonts/{5x8.bdf,6x12.bdf,8x13.bdf,unscii-8.hex,Silver.ttf}`），JS 侧只有 `Shape.font` 字符串选择；除 `:1251` `Bun.stripANSI`（可替换为纯 JS）外，包内**无** `node:*`、无 `fetch`、无 DOM。

### 2.8 provider 原生 remote（`compaction/compaction-v2-streaming.ts` + `openai.ts`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:115` / `:97` | `shouldUseCompactionV2Streaming(model)` / `getCompactionV2Endpoint(model)` | 门：`model.remoteCompaction.v2StreamingEnabled === true` 且 API ∈ {`openai-responses`,`azure-openai-responses`,`openai-codex-responses`} |
| `:42` / `:45` / `:48` | `V2_RETAINED_MESSAGE_TOKEN_BUDGET 64_000` / `V2_COMPACTION_MAX_RETRIES 2` / `V2_COMPACTION_TIMEOUT_MS 300_000` | 保留消息预算与重试/超时 |
| `:192` / `:228` | `buildCompactionV2Request` / `buildCompactionV2RequestFromBody` | 组装 Responses body（stream、store、reasoning、include、`prompt_cache_key`、tools）；尾部追加 `compaction_trigger` input item |
| `:259` | `requestCompactionV2Streaming(model, apiKey, request, signal?, options?)` | HTTP 注入点 `options.fetch ?? globalThis.fetch`；等待注入 `retryWait ?? Bun.sleep`；要求恰好一个 streamed `compaction` output item |
| `:668` | `buildCompactionV2ReplacementHistory(input, compactionItem, retainedMessageBudget)` | 纯数据：组装 provider 侧替换历史 |
| `:816` / `:830` | `storeCompactionV2PreserveData` / `getCompactionV2PreserveData` | 写/读 `openaiRemoteCompaction.{version:"v2",provider,replacementHistory,usedTokens}` |
| `openai.ts:289` / `:365` / `:388` | `shouldUseOpenAiRemoteCompaction` / `getPreservedOpenAiRemoteCompactionData` / `withOpenAiRemoteCompactionPreserveData` | V1 门与 preserve 读写 |
| `openai.ts:504` | `buildOpenAiNativeHistory(messages, model, previousReplacementHistory?, supportsImageDetailOriginal?)` | 纯转换：把对话编成 Responses input items（用 `Bun.hash` 生成 `msg_…` id） |
| `openai.ts:190` | `trimRemoteCompactionInputToContextWindow(input, tokenizer, window, instructions, tools?)` | 只重写超窗的尾部 tool output，保持 call/result 配对 |
| `openai.ts:760` / `:925` | `requestOpenAiRemoteCompaction` / `requestRemoteCompaction` | V1 `/responses/compact`；后者是通用 chat-completions / 自定义 endpoint 形态（`{systemPrompt, prompt, maxTokens}` 或 OpenAI 兼容 `/chat/completions`） |
| `:66` / `:76` | `OPENAI_REMOTE_COMPACTION_PRESERVE_KEY` / `REMOTE_COMPACTION_TIMEOUT_MS 300_000` | preserve key 与硬超时 |

宿主侧接线（`compaction.ts:1594-1769`）：V2 门 = `remoteEnabled !== false && remoteStreamingV2Enabled !== false && shouldUseCompactionV2Streaming(model)`（`:1594-1595`）；V2 失败写入 `nativeCompactionError`（`:1706`）后尝试 V1（门在 `:1716`）；两次都失败后在 `:1769` 抛 `NativeCompactionError`（`errors.ts:27`），`signal.aborted` 时直接 rethrow 而非吞错。

length-stop 恢复（宿主侧，`packages/coding-agent/src/session/session-maintenance.ts`）：`:2375` 判定 `assistantMessage.stopReason === "length"`，与 overflow 同类但输入可用，故允许 handoff；连续无进展的次数由 `INCOMPLETE_RECOVERY_MAX_RETRIES = 3`（`:132`）上限约束，超限即丢弃该死回合（`:2409-2412`），新用户 prompt 时清零。

### 2.9 handoff（`compaction/compaction.ts`）

| 位置 | 导出 | 语义要点 |
|---|---|---|
| `:1036` | `renderHandoffPrompt(customInstructions?)` | 渲染 `prompts/handoff-document.md` |
| `:1079` | `generateHandoffFromContext(context, model, options)` | 复用活动 system prompt、工具表与**真实消息历史**（保住 live prompt cache 前缀），尾部追加一条 agent 归属的 user prompt；强制 `toolChoice:"none"`，遇 400/tool_choice 不支持时以 `"auto"` 重试一次 |
| `:1114` | `generateHandoff(messages, model, apiKey, options, signal?)` | 由消息数组构造后转调上者 |
| `:566` | `AUTO_HANDOFF_THRESHOLD_FOCUS` | 阈值触发时的 focus 措辞：保留关键实现状态与立即下一步 |

handoff 结果不另立类型：作为普通 `CompactionEntry.summary` 提交，`firstKeptEntryId` 仍来自 `prepareCompaction`（即保留近期历史）。

### 2.10 本接入范围外的服务

| 服务 | 位置 | 语义 |
|---|---|---|
| 分支摘要 | `compaction/branch-summarization.ts`（382 行） | 树导航放弃分支时生成 `BranchSummaryEntry`；依赖 `ReadonlySessionManager.getBranch/getEntry` |
| 实验性 context 管理 | `docs/compaction.md` §Experimental + `context_notes`/`new_context`/`history://current/full` 工具面 | 本地窗口滚动 + 持久 notebook + 原始历史回读 |
| 推测（异步）压缩 | `SessionMaintenance`（coding-agent 包） | 阈值前带内后台 arm，越线即时提交 |
| 多候选模型 fallback / idle 维护 / auto-continue | `SessionMaintenance` | 摘要模型多候选重试、空闲压缩、压缩后自动续跑 |
| journal 条目模型 | `compaction/entries.ts`、`messages.ts` | `CompactionEntry`/`BranchSummaryEntry` 判别联合与 `convertToLlm` 核心转换（含 `declare module` 类型合并） |

### 2.11 Tokenizer（`packages/agent/src/tokenizer.ts`，315 行）

| 位置 | 成员 | 语义 |
|---|---|---|
| `:131` / `:148` | `class Tokenizer` / `constructor(model?)` | 构造时按 catalog 的 `model.tokenizer` 固定编码（`NATIVE_ENCODING` 映射 `:16-24`：claude-v3/v47/v5/v5-sonnet、qwen3、deepseek-v3、kimi-k2、glm5） |
| `:152` / `:170` | `countTokens(text, mode)` / `checkTokenBudget(text, budget)` | `mode ∈ {strict, approximate, upperbound}`；budget 检查先比 UTF-8 字节上界，未过再精确计数，返回 `{fits, tokens, exact}` |
| `:185` / `:203` | `countMessage` / `countMessages` | 按 message memo（`WeakMap`，仅 settled assistant 可缓存）；图像块固定 `IMAGE_TOKEN_ESTIMATE = 1200`(`:107`)，compactionSummary 内每帧计 `FRAME_TOKEN_ESTIMATE` |
| `:76` | `natives.countTokens(text, encoding)` | 精确计数的原生实现；失败降级为字节估算（`:59` `(bytes+3)>>2`） |

## 3. 耦合度判定

| 模块 | 判定 | 依据 |
|---|---|---|
| `utils.ts` | **pure**（仅 `extractFileOpsFromMessage` 的 `AgentMessage` 类型面） | 无 I/O、无 Model、无 Tokenizer；唯一外部面是 prompt 渲染 |
| `pruning.ts` / `shake.ts` | **pure + Tokenizer + 宿主 entry 形状** | 需要 `SessionEntry` 的 `id/parentId/type/message` 与 `message.content` 就地改写契约 |
| `tool-protection.ts` / `message-cache.ts` | **pure** | 只读 tool 名/参数；Symbol 版本戳 + `WeakMap`，宿主必须成对调用失效函数 |
| `compaction.ts` 阈值/切点段（`:197-566`） | **pure + 类型面** | 需要 `Usage`、`SessionEntry`；`findCutPoint` 另需 `Tokenizer` |
| `compaction.ts` 摘要段（`:838` 起） | **host-coupled** | 依赖 telemetry oneshot、`ThinkingLevel`、`Tokenizer`、`withAuth` |
| `compaction.ts` `prepareCompaction`/`compact` | **host-coupled** | 依赖 `./openai`、V2 模块、snapcompact、`preserveData`、`reset_boundary` 条目语义 |
| `openai.ts` / `compaction-v2-streaming.ts` | **host-coupled（网络 + provider 协议）** | 需 `fetch`/`withAuth`/`$env`/`Bun.hash`，只能经注入点替换；其中 `buildCompactionV2Request*`、`buildCompactionV2ReplacementHistory`、`store|getCompactionV2PreserveData`、`buildOpenAiNativeHistory`、`trimRemoteCompactionInputToContextWindow` 是**纯数据子集**，可单独搬 |
| `snapcompact.ts` | **纯数据/字符串为主 + 一个原生渲染硬依赖** | 除 `render()`(N-API) 与 `Bun.stripANSI` 外全纯 |
| `tokenizer.ts` | **host-coupled（原生 addon + Bun/Node 全局）** | `Bun.env.NODE_ENV`、`process.env`、`Buffer`、`pi_natives` |
| `messages.ts` / `entries.ts` | **host-coupled（类型体系）** | `declare module "../types"` 合并与 journal 形状 |
| `branch-summarization.ts` | **host-coupled（session manager 抽象）** | 直接吃 `ReadonlySessionManager` |

## 4. 移植阻断点

1. **Bun text import**：所有 prompt 都以 `with { type: "text" }` 导入（`compaction.ts:66-72`、`utils.ts:10-11`、`messages.ts:11-13`、`branch-summarization.ts:22-23`、`openai.ts:58`、`snapcompact.ts:53-54`）。RunLedger 侧必须改为 TS 字符串常量或既有 prompt 资源机制；且 `src/runtime/context/**` 受 `scripts/check-runtime-boundaries.ts:16-21` 约束，**不能**读文件。
2. **Bun 全局**：`Bun.hash`（`openai.ts:448,475,627`）、`Bun.sleep`（`compaction-v2-streaming.ts:279`）、`Bun.stripANSI`（`snapcompact.ts:1251`）、`Bun.env.NODE_ENV`（`tokenizer.ts:7`）。
3. **原生 addon**：`pi_natives` 提供 `countTokens`、`renderSnapcompactPng`、`snapcompactSupportedChars`（`packages/natives/native/index.js:49/105/109`），字体内嵌于 Rust crate。这意味着 **精确 tokenizer 与 snapcompact 渲染都不是纯 JS 可搬运件**，需要一个 Rust/native 交付链（RunLedger 已有 `native/syntax-highlighter` + `build:native` 先例，但仍是独立专项）。
4. **网络面**：仅 `openai.ts:945` 与 `compaction-v2-streaming.ts:278` 真正发请求，均可经 `options.fetch` 覆盖；默认落到 `globalThis.fetch`。
5. **未导出的内部件**：`findValidCutPoints`、`generateTurnPrefixSummary`、`generateShortSummary`、`summarizeConversationWindow` 都是模块私有，需要时只能自行实现或改造导出。

## 5. 与 RunLedger 现有适配器的能力对照

RunLedger 侧事实全部来自当前工作树（含在飞未提交文件，见 [01](01-integration-plan.md) §2）。

| 能力 | RunLedger 现状 | omp 对应 | 判定 |
|---|---|---|---|
| 阈值与 reserve 预算 | `settings.threshold`(0.1–0.95) + `contextTokens(projected)` 纯本地估算（`session-runtime/compaction-domain.ts` `contextTokens()`） | `resolveThresholdTokens` / `effectiveReserveTokens` / `compactionContextTokens` | 部分缺口：缺「provider usage 与本地估算取 max」的地板语义与 reserve 表达式 |
| 测量 token | `conservativeTokenEstimate` 上界 + `TokenEstimator.observe`（已定义但**无生产调用点**） | `Tokenizer.countMessage(s)`（原生精确） | 缺口：无精确 tokenizer，且观测校准未接线 |
| 切点 | `planHistoryCut(messages, retainRecentTurns, previousCount)`（按 turn 计数保留最近 N 轮，unit=完整稳定 turn 的 JSON） | `findCutPoint`（按 `keepRecentTokens` 倒走）+ 比率校正 | 缺口：保留量不看 token；omp 的比率校正与 token 预算可移植 |
| 第二切点实现 | `context/compaction/cut-planner.ts` 的 `planCompactionCut`/`CompactionTurn` **仅被自身测试引用** | — | 需收敛：要么接线，要么删除，不能长期并存 |
| 摘要策略 | `single-pass@1` / `hierarchical@1` / `openai-responses-native@1`（`summary-strategies.ts`） | `compact()`（含折窗、迭代 update 摘要） | 部分缺口：迭代只把前摘当普通输入；无 out-of-window 折窗 |
| 摘要输出契约 | 硬编码 6 个标题校验（在 `compaction-domain.run`）+ `COMPACTION_SYSTEM_PROMPT`（`compaction-model.ts`） | 结构化 handoff 契约（`compaction-summary.md`/`-update-summary.md`）+ 不可信数据 system prompt | 缺口：契约绑死在 domain 层，无法按策略换格式（handoff 文档结构不同） |
| 文件操作清单 | 无 | `utils.ts` 全套 + `<files>` upsert | 缺口，纯函数可直接移植 |
| 工具结果剪枝 | 无投影级裁剪 | `pruning.ts`（supersede / useless / age-based） | 缺口，但需新的投影稳定性与恢复语义 |
| 机械瘦身 | 无 | `shake.ts`（三套预设） | 缺口，且需要可恢复读取通路 |
| provider 原生压缩 | `openai-responses-native@1` → `api/openai-responses.ts` 的 `compactOpenAIResponses`（V1 `/responses/compact`）+ `openai-compaction-state.ts` | V1 同形；V2 streaming 额外存在 | 缺口只在 V2 与能力门 |
| handoff | 无独立策略 | `generateHandoff*` | 缺口，可用同一 model port 实现，格式需独立校验 |
| 位图归档 | 无 | `snapcompact` | 条件缺口：需原生渲染 + 图像投影通道 + 媒体类型契约 |
| 自动触发 | `assemble()` 内联 auto（阈值+抑制）、`recoverOverflow()`、`preflightModel()`（model_switch） | 六条触发（含 mid-turn、idle、length-stop 恢复） | 缺口：`stopReason==="length"` 的 incomplete 恢复与 mid-turn 语义未接 |
| 分支摘要 / 实验模式 / 推测压缩 | 无（fork 继承 committed compaction + raw ledger） | 有 | 明确不在接入范围，理由见 [01](01-integration-plan.md) §8 |
| 权威与提交 | Owner-fenced Attempt + CAS + 工件 + 精确 record schema（`record.ts`、`compaction-domain.ts`） | omp 无对应物（journal append + preserveData） | RunLedger 侧强于来源，**不得**用 omp 编排替换 |

## 6. 术语与语义对齐

| omp | RunLedger | 对齐结论 |
|---|---|---|
| `SessionEntry`（journal 条目，含 header/settings/label 等非消息条目） | `SessionEventRecord`（事件流）+ `Message[]`（请求投影） | 不是同一抽象；omp 的 entry 级切点必须落成 RunLedger 的 message 级切点 |
| `keepRecentTokens = 20000` | `retainRecentTurns = 1` | 语义不同：前者按 token，后者按 turn 数量；接入需改名而非复用字段 |
| `CompactionEntry.summary/shortSummary/firstKeptEntryId/preserveData` | `CompactionRecord.checkpoint/artifact/count/previousId` | RunLedger 以**工件 digest + 前缀 digest**绑定替换，omp 以 entry id 绑定；`preserveData` 对应 RunLedger 的 candidate 类型化载荷 |
| `CompactionResult.details.{readFiles,modifiedFiles}` | 无对应字段 | 可放入工件正文（summary 内的 `<files>`），不进 record schema |
| split turn（切点落在 turn 中部） | 只切完整稳定 turn（`planHistoryCut` 拒绝未配对 batch） | **omp 的 split-turn 与 turn-prefix 摘要不适用**，不移植 |
| 摘要结构（omp 的 `## Goal` / `## Progress`…） | 6 个固定标题（Goal and constraints / Decisions and completed work / Files and tool outcomes / Unresolved tasks / Verification evidence / Source references） | 两边标题不同；接入必须引入按格式校验，不能把 omp 模板直接塞进现有校验 |
| `purgeData`/`prunedAt` 就地改写 entry | raw ledger 不可变，投影可重建 | 剪枝只能作用于**投影**，且必须是消息数组的纯函数（可重放） |
| 图像块与 `FRAME_TOKEN_ESTIMATE` | `Message.content` 支持 `ImageContent`（`src/types.ts:383`），`Model.input` 含 `"image"`（`:788`）；但投影把历史组 `JSON.stringify` 进字符串 fragment（`model-request-adapter.ts`），只有 `context.compaction` 是独立载荷通道 | 图像型 candidate 需要新的独立投影通道与 record 媒体类型，不能靠字符串 fragment |
