# RunLedger TUI Codex 探索摘要与工具输出有界展示实施计划

> 状态：**partial / implementation in dirty worktree / not accepted**
>
> 计划日期：2026-09-02
>
> RunLedger 基线：`rollback/before-composer-shape@4cdddfe1cdd95ecf2356d395916678fff331c8d1`
>
> Codex 固定参照：`main@0b175e643`
>
> 上游关系：承接 [`24-codex-session-display-replication-plan.md`](24-codex-session-display-replication-plan.md) D9 暂缓的 `Exploring` 分组；不改写 Plan 24 已验收的 exec、diff、状态行和 Ctrl+T 基础能力。
>
> 交付性质：S0–S5 范围的核心代码与自动化合同已落入当前脏工作树；S6 专项性能/重放门禁、带真实探索调用的标准 PATH TTY，以及 dark/light 人工视觉与复制验收尚未完成。因此本文不能标记为 `implemented` 或 `accepted`。

---

## 0. 权威边界与工作树事实

### 0.1 本计划拥有的范围

本文是下列能力的唯一实施入口：

- 将第一方只读发现工具 `read`、`grep`、`find`、`glob`、`ls` 分类为 `Read` / `Search` / `List` 探索动作；
- 主时间线只显示探索动作摘要，不内联成功结果正文；
- 在 presentation 层按相邻关系生成 Codex 风格 `Exploring` / `Explored` 分组，同时保留每个 `TimelineRow` 和 `toolCallId`；
- 主时间线与 Ctrl+T transcript 使用两个显式投影面：main 为摘要，transcript 为逐调用详情；
- 修复 read/search/list 的结果统计与截断元数据投影，区分 Runtime 截断与 TUI safety bound；
- 失败、取消和不可用状态的有界可见性，不因压缩成功正文而吞掉错误；
- live/replay、宽窄终端、选择复制、缓存失效和长会话性能回归；
- 标准 PATH `runledger` 的真实 TTY 与 dark/light 人工视觉验收。

本文不替换以下 authority：

| 专项 | 继续拥有的 authority | 本计划接缝 |
|---|---|---|
| [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | OpenTUI renderable 生命周期和 native renderer | 只新增一个 exploration block/renderable，不 fork OpenTUI |
| [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | stable ID、settled part、窗口化、背压 | 分组必须保持 Timeline identity，不能把多行合并为新 durable state |
| [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md) | Runtime → TUI adapter、Timeline/reducer authority | 不改变 Agent 工具结果、模型上下文或 Session authority |
| [`22-opencode-conversation-scrollbar-adaptation-plan.md`](22-opencode-conversation-scrollbar-adaptation-plan.md) | 主 ScrollBox、sticky 与滚动条 | exploration block 是普通 transcript child，不持有第二份滚动位置 |
| [`24-codex-session-display-replication-plan.md`](24-codex-session-display-replication-plan.md) | exec 5/50 行布局、Ctrl+T pager、status/diff/plan | 本文只完成其 D9，并复用既有 transcript overlay |
| `src/runtime/tools/tool-support.ts` | Agent 实际可读输出的 2,000 行 / 300,000 byte 上限 | main 隐藏正文不改变工具给 Agent 的结果；只规范 details 元数据 |

### 0.2 当前工作树边界

计划编写时当前分支为 `rollback/before-composer-shape`，仓库已有与本计划无关的修改：

- `src/cli/main.ts`、`src/cli/session-store-migrate.ts`、`src/cli/session-workspace-identity.ts`；
- `src/runtime/session-runtime/domain-router.ts`；
- `src/storage/session-store/catalog-repository.ts`、`jsonl-migration.ts` 及新增 `fork-projector.ts`；
- `src/workspace/session-identity.ts`；
- 对应 CLI、Runtime、Storage 测试及 `development-doc/note/review-note.md`。

本轮只允许新增本文并最小更新三个文档路由点：`tui/00-overview.md`、`development-doc/00-index.md` 和 Plan 24 D9。未来执行时仍须重新检查脏工作树并逐路径暂存；不得把上述并行改动纳入本专项。

### 0.3 证据口径

- RunLedger 现状以本计划日期对当前工作树源码和测试的只读检查为准；既有 Plan 24 的历史证据不能证明本专项已实现。
- Codex 行为以固定参照 `0b175e643` 的 `codex-rs/tui/src/exec_cell/`、`chatwidget/command_lifecycle.rs`、`pager_overlay.rs` 及 `codex-rs/core/src/unified_exec/` 为准。
- 单元测试证明纯投影合同；Bun native 测试证明 OpenTUI frame；tmux/PTY 证明标准入口；人工验收才证明 dark/light 可读性。四类证据不得互相替代。
- “压缩显示”只指 TUI presentation，不得被描述为 Context Compaction、LLM 输出压缩、ledger 压缩或 Runtime 丢弃结果。

### 0.4 当前实施与 fresh evidence（2026-09-02）

- 当前脏工作树已加入第一方精确分类、safe exploration metadata、main/transcript 双 surface、相邻分组、`ExplorationRenderable` 和 transcript 的 Runtime/TUI 双截断 marker；`Agent` tool result、Session schema、ledger、Trace 与 shell retention 未改。
- 成功 `read/grep/find/glob/ls` 的 main projection 不含 body；transcript 按 `toolCallId` 保留 safe bounded detail。失败 read 在 main 保留一行安全错误，在 transcript 保留完整 bounded error 一次。
- 归组保留原始 `TimelineRow`/`toolCallId`，group id 固定为首 row；每组至多 32 actions。新增 RED→GREEN 覆盖了 body 零泄漏、nested Runtime truncation、精确分类、相邻/跨 shell 分组、失败去重、1,000 条 read 有界分组，以及“单个超长动作不可被误报为省略 1 个动作”。
- 本轮 fresh automated gates：`npm run check`、`npm test`、`npm run build` 与 `git diff --check` 均通过；全量测试中的 Bun native 分桶包含 exploration renderable 和生产 history replay 摘要断言。
- 标准入口已确认 `/home/nzq/.npm-global/bin/runledger` 链接到本工作树；隔离 `RUNLEDGER_DIR` 的 tmux TTY 在 40×24、80×24、143×30 启动。40 列还验证 Ctrl+T 空 transcript 打开/关闭、PageUp 与 Ctrl+D 干净退出；80/143 列验证启动与 Ctrl+D 退出。
- 未闭合：S6 的专门 10,000-row/replay-cache/session-switch 性能证据；带真实模型的 read/search/list/failed-read 标准 PATH TTY；dark/light 人工视觉与鼠标选择复制。隔离 TTY 没有凭据，不能替代这些验证。

---

## 1. 问题定义与当前根因

### 1.1 用户可见问题

Agent 调用 `read` 读取项目文件后，RunLedger 主时间线会把文件正文直接展开。文件较长时，即使 Runtime 和 safe projector 已有字节上限，主面板仍可能被几十到上千行正文占满；这与 Codex 主面板只显示 `Explored → Read <path>` 摘要的行为不一致。

### 1.2 当前链路

```text
read.execute()
  └─ content[text]：最多 2,000 行 / 300,000 bytes，头部截断
       └─ tool_execution_end
            └─ projectToolEnd()
                 ├─ body += boundedToolText(resultText, 64 KiB)
                 └─ result.kind = "read"
                      └─ rowToBlocks()
                           └─ toolLines()
                                └─ presentation.body 全部拼入 main text block
```

对应事实：

1. `src/runtime/tools/tool-support.ts` 定义 `DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=300_000`；这是 Agent 工具结果上限，不是主时间线摘要策略。
2. `src/tui/presentation/tools/projector.ts#projectToolEnd` 对非 shell/plan 工具统一把结果放入 `presentation.body`，只施加 64 KiB safety cap。
3. `src/tui/timeline/selectors.ts#toolLines` 遍历所有 text body 并原样追加；`read` 虽有专用 renderer 名称，却没有专用显示分支。
4. `projectTranscriptOverlay()` 继续调用相同 `timelineToBlocks()` / `rowToBlocks()`；当前 main 与 Ctrl+T 没有 surface 语义，无法做到“主面板摘要、转写视图详情”。
5. Runtime `ReadToolDetails` 返回嵌套 `details.truncation`，TUI 却读取顶层 `details.lineCount` / `details.truncated`。因此 read 的统计和截断 chip 经常是 unknown/false。
6. `grep`、`find`、`ls` 同样主要返回 `details.truncation`；`glob` 已有 `matchCount`，但 TUI 仍把 `find`/`glob`/`ls` 当 generic renderer。

### 1.3 为什么现有 exec 截断没有解决

Plan 24 已实现的 5/50 屏幕行中段截断只作用于 `renderer === "shell"` 生成的 `exec` block。`read` 走 generic `text` block，因此不会进入 `ExecRenderable`、`outputMaxLines` 或 `truncateLinesMiddle()`。单纯调整 exec 常量对 read 无效。

---

## 2. Codex 固定参照与需要复制的语义

### 2.1 Codex 实现地图

| 能力 | Codex 文件/符号 | 固定事实 |
|---|---|---|
| 探索识别 | `tui/src/exec_cell/model.rs#is_exploring_call` | 非 `UserShell` 且 parsed actions 全为 `Read`、`ListFiles`、`Search` 才是探索调用；普通 Run/Unknown 不进入探索组 |
| 相邻归组 | `ExecCell::add_call` | 当前 cell 与新调用都为探索调用时追加到同一 cell；以稳定 `call_id` 路由 delta/end |
| 主面板 | `exec_cell/render.rs#exploring_display_lines` | 只显示 `Exploring` / `Explored` 和动作摘要；连续 Read 合并唯一文件名；不显示成功输出正文 |
| 普通命令截断 | `render.rs#command_display_lines` | Agent command 主面板上限 5 屏幕行，user shell 上限 50；先 wrap 后 head/tail 中段截断 |
| 详情视图 | `HistoryCell::transcript_lines` + `pager_overlay.rs` | Ctrl+T 用独立 transcript projection 显示命令及输出；main 与 transcript 不是同一组显示行 |
| live 防护 | `exec_cell/live_output.rs#LiveCommandOutput` | 1 MiB 前保持完整；超限后保留前 50、后 50 和当前 partial line，长单行独立 head/tail |
| Core 防护 | `core/src/unified_exec/head_tail_buffer.rs` | unified exec 最多保留 1 MiB，50/50 head/tail，显式插入 omitted bytes marker |

### 2.2 本计划采用与不采用的部分

采用：

- 明确的探索工具白名单；
- 主面板摘要和 transcript 详情分离；
- 相邻探索动作在 presentation 层归组；
- 连续 Read 的目标名合并；
- 稳定 toolCallId 路由，不按输出文本猜测归属；
- 所有省略都有可见 marker 和 Ctrl+T 入口。

适配而不照搬：

- Codex 以 shell parsed command 分类；RunLedger 已有第一方工具名和结构化 args，直接按受控工具名映射，不引入 bash parser。
- Codex `ExecCell` 自己持有多个调用；RunLedger 保留每个 `TimelineRow`，只在 selector 输出派生 group block，避免改变 durable/replay identity。
- RunLedger 不把 64 KiB TUI safety cap 扩到 1 MiB；Core/Agent 工具上限和 TUI presentation 上限继续分层。
- 失败探索调用必须在 main 显示失败状态和一行 bounded error summary；不因复制 Codex 的安静摘要而隐藏安全相关失败。

不采用：

- 不把 arbitrary MCP/plugin 工具仅凭名称含 `read` / `search` 自动归类；
- 不把 `bash`、`!`、`process_output` 或 unknown 工具伪装成探索动作；
- 不把 transcript 描述为“完整原文”，它只包含已经进入 safe presentation 的 bounded 内容；
- 不新增每个 tool cell 的交互展开状态，详情统一由既有只读 Ctrl+T pager 承担。

---

## 3. 目标行为

### 3.1 主时间线

运行中：

```text
• Exploring
  └ Read src/a.ts, src/b.ts
    Search "projectToolEnd" in src/tui
    List src/runtime/tools
```

完成后：

```text
• Explored
  └ Read src/a.ts, src/b.ts
    Search "projectToolEnd" in src/tui · 6 results
    List src/runtime/tools · 18 entries
```

主时间线不得出现 `src/a.ts` 的正文、grep 命中正文或目录条目清单。动作行在窄终端按显示宽度 wrap；整个 group 超过显示预算时保留 head/tail 动作并显示 `… +N actions (Ctrl+T for transcript)`。

失败示例：

```text
• Explored with errors
  └ Read missing.ts · failed
    Path not found: missing.ts
```

错误摘要只取已脱敏 `presentation.error` 的第一条非空逻辑行，重新受 label byte/display-width 上限约束；成功正文绝不借错误通道返回 main。

### 3.2 Ctrl+T transcript

Ctrl+T 按每个原始 tool call 展示，不按 main group 合并：

```text
Read src/a.ts
     1  import ...
     2  ...
… TUI preview truncated at 64 KiB
✓ · 120 lines

Search "projectToolEnd" in src/tui
src/tui/presentation/tools/projector.ts:239:...
✓ · 6 results
```

要求：

- 保留每个 `toolCallId` 的顺序和状态；
- 显示 `presentation.body` 中的 safe bounded text；
- `SafeBoundedText.truncated=true` 时追加 TUI preview marker；
- Runtime `details.truncation.truncated=true` 时另加 source marker，带 available 的 `outputLines/totalLines/maxLines/maxBytes`；
- 两类截断同时发生时两种 marker 都显示，不混成一个布尔值；
- 失败调用显示完整 bounded error detail，但不重复两遍相同正文；
- overlay 仍只读，关闭后主 ScrollBox 的 sticky/offset 不变。

### 3.3 不变行为

- Agent/LLM 收到的 `ToolResultAgentMessage` 内容不变；
- Session message、ledger、Trace 和模型 token accounting 不变；
- `read offset/limit`、grep/find/glob/ls 的 Runtime 执行和权限路径不变；
- shell 继续走 Plan 24 exec 5/50 行和 tail-100 retention；
- edit/write/plan/MCP/skill 等非白名单工具保持当前 renderer；
- `hideThinkingBlock`、selection、scrollbar 和 syntax highlight 行为不变。

---

## 4. 冻结设计决策

### D1：四层输出边界必须分开

| 层 | authority | 策略 |
|---|---|---|
| Agent tool result | Runtime tool | 当前 2,000 行 / 300,000 bytes 等工具级规则，正文继续返回模型 |
| Durable session/ledger | Runtime/Storage | 本计划不改变保存与 replay contract |
| Safe TUI presentation | `projectToolEnd` | 每个 text body 保持 64 KiB cap、SGR 清洗与脱敏字段隔离 |
| Main TUI display | selector/renderable | 探索成功结果只显示结构化摘要；正文只在 Ctrl+T bounded transcript 中出现 |

禁止通过修改 Runtime content 来实现“看起来压缩”；那会改变 Agent 后续推理输入。也禁止只在 OpenTUI render 函数末端截字符串；那会让 main/transcript、复制和缓存合同互相漂移。

### D2：探索分类只接受第一方精确工具名

新增纯函数 `explorationKindForTool(toolName)`：

| toolName | kind | 主摘要字段 |
|---|---|---|
| `read` | `read` | path、offset/limit（非默认时） |
| `grep` | `search` | pattern/query、path、match/result count |
| `find` | `search` | pattern、path、result count |
| `glob` | `list` | pattern、path、match count |
| `ls` | `list` | path、entry count |

大小写、别名或 namespace 不做模糊匹配。未来扩展必须显式加入映射和测试；MCP/plugin 工具缺安全 schema 时返回 generic。

### D3：main/transcript 是 selector 的显式 surface

扩展 selector options：

```ts
export type TimelineProjectionSurface = "main" | "transcript";

export interface TimelineToBlocksOptions {
  readonly includeActive?: boolean;
  readonly hideThinking?: boolean;
  readonly surface?: TimelineProjectionSurface; // default "main"
}
```

- `surface="main"`：探索 rows → `exploration` block，不投影成功 body；
- `surface="transcript"`：探索 rows 各自 → `tool-detail` block，保留 safe body；
- `projectTranscriptOverlay()` 必须显式传 `surface:"transcript"`，不能依赖默认值；
- generic `toolLines()` 只处理非探索工具，防止未来重构再次把 read body 泄漏到 main。

### D4：Timeline/reducer 不归组，presentation selector 才归组

- 每个 tool call 继续拥有独立 `TimelineRow.id`、`toolCallId`、status、presentation 和 replay 顺序；
- `timelineReducer` 不增加 exploration state，不修改 durable schema；
- `timelineToBlocks` 在 main surface 对已按 `displayOrder` 排列的相邻探索 rows 做单次线性扫描；
- 不跨 user/assistant/notice/run-boundary、shell、write/edit 或其他非探索 tool 分组；
- transcript surface 不分组。

### D5：group identity 与 settled cache 合同

- group block id 固定为 `exploration-${firstRow.id}`；成员新增时 id 不变；
- member IDs 作为 block 内部 `action.id=toolCallId`，不得只保留显示文本；
- 轮次仍 active 且 group 位于 Timeline 尾部时 `finalized=false`，允许新探索动作追加；遇到非探索 row 或 `run-boundary` 后才 final；
- `contentGeneration` 取组内最新 row generation；当前 reducer 在 row start 时写入 generation，后续 update/end 不递增该 row generation，因此活动组必须保持 `finalized=false` 并由 live content signature 感知成员状态/结果变化，不能仅依赖 generation 失效；
- 只有越过非探索 row 或 `run-boundary`、成员集合不再增长后，group 才可 `finalized=true` 并进入 settled cache；
- 若现有 settled-part 实现不能证明“先完成一条 read，随后追加下一条 read”仍会刷新，S2 必须停下，先补 identity/cache RED，不能通过强制全历史重建绕过。

### D6：连续 Read 合并只发生在显示层

- 相邻 `read` actions 在同一显示行合并唯一 path；重复 path 显示一次并可加 `×N`；
- `Search`/`List` 保留逐动作行，避免丢失 query/pattern；
- group 内原始 action 数、顺序、toolCallId 和 transcript detail 不变；
- main 分组最多接纳 32 个 actions；超过后开启下一个 group，防止单 block 无界增长；
- main 最多显示 5 个动作屏幕行，先 wrap 后 head/tail 截断，省略数以 action 为单位，不以 wrapped row 冒充 action 数。

### D7：结果元数据采用结构化 normalization，unknown 不归零

目标 safe metadata 至少表达：

```ts
export interface SafeExplorationResult {
  readonly kind: "exploration";
  readonly resultCount: SafeCount;
  readonly resultUnit: "lines" | "matches" | "files" | "entries";
  readonly sourceTruncated: boolean;
  readonly presentationTruncated: boolean;
  readonly outputLines: SafeCount;
  readonly totalLines: SafeCount;
}
```

- 新 live 事件优先读取各第一方工具的 canonical details；
- replay 兼容当前 `details.truncation`、`matchLimitReached`、`resultLimitReached`、`entryLimitReached`、`matchCount`、`limitReached`；
- 缺字段时保持 `{state:"unknown"|"unavailable"}`，不得从空输出推断 0，除非工具 details 明确报告；
- 是否修改 Runtime details 为 always-present canonical counts，必须在 S1 RED 后完成，并保留旧 replay fallback；不得为了 TUI 重写旧 Session 文件。

### D8：错误可见但正文不可回流

- success：main 永远不展示 body；
- failed/cancelled/aborted：main 展示状态和最多一行安全错误摘要；
- `presentation.error` 与 body 相同则 transcript 去重；
- 错误摘要不显示 raw args、credential、absolute native path 或未清洗 SGR；
- classification/presentation unavailable 时回退现有 generic tool row，不静默丢行。

### D9：不增加新的输出 retention authority

- `TOOL_TEXT_BOUND_BYTES=64 KiB` 保持；
- shell tail-100 保持；
- transcript `TRANSCRIPT_MAX_BLOCKS=10_000` 保持；
- 本专项只增加 marker 和 surface-specific projection，不创建临时文件、Artifact 自动读取或隐藏网络请求；
- 若产品要求 Ctrl+T 打开超过 64 KiB 的原始 tool result，必须另立 Artifact/权限计划，不得在此专项偷渡。

---

## 5. 目标数据结构与渲染链

### 5.1 Presentation block

```ts
export interface ExplorationActionView {
  readonly id: string; // toolCallId
  readonly kind: "read" | "search" | "list";
  readonly label: SafeBoundedText;
  readonly target: SafeBoundedText;
  readonly query?: SafeBoundedText;
  readonly status: TimelineStatus;
  readonly result?: SafeExplorationResult;
  readonly errorSummary?: SafeBoundedText;
}

export type ExplorationBlock = PresentationBlockMetadata & {
  readonly kind: "exploration";
  readonly state: "active" | "completed" | "completed-with-errors";
  readonly actions: readonly ExplorationActionView[];
  readonly omittedActions?: number;
};

export type ToolDetailBlock = PresentationBlockMetadata & {
  readonly kind: "tool-detail";
  readonly action: ExplorationActionView;
  readonly body: readonly SafeToolBodyBlock[];
};
```

`ExplorationBlock` 只服务 main。`ToolDetailBlock` 只服务 transcript；native main renderer 不应接受后者，避免详情误挂到主 ScrollBox。

### 5.2 目标链路

```text
AgentEvent / replay AgentMessage
  └─ TimelineEventProjector
       └─ TimelineRow(kind="tool", stable toolCallId, SafeToolPresentation)
            ├─ main surface
            │    └─ classify → coalesce adjacent rows → ExplorationBlock
            │         └─ ExplorationRenderable（摘要、wrap、5-row budget）
            └─ transcript surface
                 └─ ToolDetailBlock per call
                      └─ transcriptBlockLines（bounded body + two truncation markers）
```

### 5.3 OpenTUI 接线

- `component-runtime` 为 `exploration` 创建 keyed selectable `TextRenderable` 或独立轻量 renderable；
- `blockText`、`blockSignatureText`、`blockCharacterCount`、`presentationPart` 必须认识新 block；
- theme 只复用 Plan 24 已有成功/失败、cyan action label、dim secondary 文本，不新增 color authority；
- main summary 的输出必须是 selectable text；选择复制不得暗中包含隐藏正文；
- Ctrl+T transcript 的选择复制包含当前 bounded detail 和可见 marker。

---

## 6. 实施阶段（严格 RED → GREEN）

### S0 · 基线与失败用例冻结

- [ ] 在 `tests/tui/timeline/` 增加 RED：成功 read 的正文当前出现在 main block；目标断言 main 不含正文但 transcript 含正文。
- [ ] 增加 RED：Runtime `details.truncation` 未被 TUI 读取，source truncated 被错误投影为 false。
- [ ] 增加 read/grep/find/glob/ls、失败 read、相邻与非相邻工具、live/replay fixture。
- [ ] 固定 40/80/143 列快照，覆盖超长 path/query、CJK、emoji、单条超长行和 64 KiB presentation cap。
- [ ] 记录当前 `npm run check`、focused tests、Bun TUI 和 `npm run build` 基线；既有任务外失败单独报告。

**S0 门禁**：至少两条目标行为测试必须以预期原因 RED；不得先改 projector 再补同实现断言。

### S1 · 探索分类与元数据 normalization

- [ ] 新增 `explorationKindForTool()` 精确白名单及 input metadata：read path、grep/find query+path、glob pattern+path、ls path。
- [ ] 扩展 `SafeToolInputMetadata` 和 `SafeToolResultMetadata`，引入 `SafeExplorationResult`；unknown/unavailable 不归零。
- [ ] `projectToolResultMetadata()` 正确消费嵌套 `details.truncation` 和现有各工具 limit/count 字段。
- [ ] 如需 canonical Runtime details，为 read/grep/find/glob/ls 增加 always-present count/truncation 字段及 runtime tests；保留旧字段兼容。
- [ ] 保证 raw args、凭证、未授权 native path 不进入 presentation。

**S1 门禁**：五类工具的 live + legacy replay metadata matrix 全绿；非白名单 MCP/plugin 工具保持 generic。

### S2 · main/transcript 双 surface 与正文隔离

- [ ] 给 `timelineToBlocks` / `rowToBlocks` 增加 explicit surface，默认 main。
- [ ] main 的探索成功调用只生成 `ExplorationBlock`，不生成含 body 的 generic text block。
- [ ] transcript 每个调用生成 `ToolDetailBlock`，正文来自 safe presentation，不回读 Runtime、文件系统或 ledger。
- [ ] `projectTranscriptOverlay` 显式传 transcript surface；committed/live-tail cache key 包含 surface 语义。
- [ ] failed/cancelled/aborted main 显示一行 bounded error summary，并在 transcript 去重。

**S2 门禁**：同一 Timeline fixture 满足 `main !contains(fileBody)`、`transcript contains(fileBody)`；Agent ToolResult 与 TimelineRow 未被改写。

### S3 · 相邻探索归组与稳定 identity

- [ ] 对 main rows 做 O(n) 相邻扫描；严格按 `displayOrder`，不跨边界。
- [ ] 连续 Read 合并唯一 path；Search/List 保留动作行。
- [ ] group id 取首 row，action id 取 toolCallId；追加成员不更换 group id。
- [ ] 尾部 active group 保持 non-settled；遇到 assistant/non-exploration/run-boundary 后 final。
- [ ] 每组最多 32 actions，主显示最多 5 个动作屏幕行；省略 marker 数量正确。
- [ ] 覆盖“read1 完成 → read2 开始 → read2 完成 → assistant 开始”的增量帧，证明没有旧 cache 或重复 block。

**S3 门禁**：stable-ID/settled cache 测试证明追加只更新目标 group，不重建既有 committed 历史；replay 输出与最终 live 输出字节一致。

### S4 · ExplorationRenderable 与 native OpenTUI

- [ ] 新增 summary renderer：active/completed/error header、action label、prefix、wrap 和 head/tail marker。
- [ ] `component-runtime`、`transcript-runtime`、character budget、renderable map 和销毁路径支持新 block。
- [ ] 40/80/143 列 Bun native frame 覆盖 dark/light style token、CJK/emoji width 和选择复制。
- [ ] sticky bottom、向上阅读、新内容提示和 scrollbar 显隐不回归。
- [ ] hidden body 不创建 native child，不进入 `frameCharacterCount`，避免“视觉隐藏但仍付出完整布局成本”。

**S4 门禁**：native frame 中没有成功正文，Ctrl+T frame 中有 bounded 详情；renderer destroy 无泄漏/残留 child。

### S5 · Transcript 详情与截断 marker

- [ ] `transcriptBlockLines` 支持 `tool-detail`，逐调用显示 heading/body/status/count。
- [ ] 分别显示 source truncation 与 presentation truncation，不把 64 KiB preview 称为 full output。
- [ ] 详情按现有 pager width wrap，继续受 `TRANSCRIPT_MAX_BLOCKS` 和 settled line cache 控制。
- [ ] active tool 更新只失效 live tail；committed exploration details 不因后续调用重复投影。
- [ ] Ctrl+T/Esc/Ctrl+T close、PgUp/PgDn、j/k/g/G 和主 ScrollBox offset 保持。

**S5 门禁**：短输出、Runtime-only 截断、TUI-only 截断、双重截断、失败去重五组 fixture 全绿。

### S6 · Replay、生产接线与性能

- [ ] 从 canonical session messages 恢复 toolCall args 与 toolResult details，保证 path/query/正文能按相同 toolCallId 关联；不得产生重复 stable row id。
- [ ] 验证 Session Owner 标准 CLI composition 使用同一 selector 路径，无 legacy TUI 旁路。
- [ ] 10,000 个历史 rows + 1 个 active exploration action 压测：只更新 live group，committed transcript cache 命中。
- [ ] 1,000 次相邻 read 的 main projection 有界；不创建 1,000 个正文 native child。
- [ ] session switch、abort、destroy 清除 active group，不污染下一 Session。

**S6 门禁**：live/replay 等价、无 duplicate ID、无跨 Session 串组；性能预算和 before/after 数字写回本文。

### S7 · 全量门禁与真实 TTY 验收

- [ ] `npm run check`（完整输出，无 error/warning/info 遗漏）。
- [ ] focused Vitest：projector、selectors、timeline equivalence、transcript view、runtime tool details。
- [ ] `npm test` 全量。
- [ ] Bun OpenTUI native tests 全量。
- [ ] `npm run build`。
- [ ] `git diff --check`。
- [ ] `which runledger`、`readlink -f`、`npm ls -g --depth=0 runledger` 确认标准入口指向本工作树；否则先构建并按规则 `npm link`。
- [ ] 隔离 `RUNLEDGER_DIR` + 真实 tmux TTY：40/80/143 列，dark/light，连续 read/search/list、失败 read、Ctrl+T 打开/关闭、PageUp、选择复制、Ctrl+D 干净退出。
- [ ] 人工确认主面板不再出现文件正文，摘要无破版，详情 marker 可理解，错误没有被压掉。

**S7 门禁**：自动、标准 PATH PTY、人工验收分别记录；任一缺失时整体最多标记 `partial`，不得写 `implemented/accepted`。

---

## 7. 预计文件变更清单

### 7.1 新增

```text
src/tui/presentation/tools/exploration.ts
src/tui/opentui/exploration-renderable.ts
tests/tui/blocks/exploration-summary.test.ts
tests/tui/opentui-exploration-summary.bun.test.ts
```

实际命名可在 S0 后调整，但分类、归组和 renderable 必须保持独立模块，不能继续膨胀 `selectors.ts` 或 `component-runtime.ts`。

### 7.2 修改

| 文件 | 计划改动 |
|---|---|
| `src/tui/presentation/tools/types.ts` | exploration input/result/action safe contracts |
| `src/tui/presentation/tools/projector.ts` | 精确分类、结构化 args、nested truncation normalization、成功 body retention 与 main 隔离 |
| `src/tui/presentation.ts` | `exploration` / `tool-detail` block unions |
| `src/tui/timeline/selectors.ts` | explicit surface、main grouping、generic tool body 防回流 |
| `src/tui/transcript-view.ts` | transcript surface、tool detail lines、双截断 marker 与 cache key |
| `src/tui/opentui/component-runtime.ts` 或其已拆分模块 | exploration keyed renderable lifecycle |
| `src/tui/opentui/component-runtime/transcript-runtime.ts` | block text/signature/count/settled 支持 |
| `src/tui/index.ts` | 必需公共导出 |
| `src/runtime/tools/read.ts` | 仅在 S1 证明需要时增加 canonical count details |
| `src/runtime/tools/grep.ts` | 同上 |
| `src/runtime/tools/find.ts` | 同上 |
| `src/runtime/tools/glob.ts` | 同上 |
| `src/runtime/tools/ls.ts` | 同上 |
| 既有 projector/selectors/transcript/native/replay tests | RED→GREEN 和回归矩阵 |

不得修改 Agent loop、ExecutionGateway、Session Store schema、Trace recorder、模型上下文转换或 shell retention，除非出现新的独立授权。

---

## 8. 测试矩阵

| 场景 | main | Ctrl+T | 必须证明 |
|---|---|---|---|
| 单个短 read | `Explored → Read path` | heading + 全部 safe body | main 无正文 |
| 连续 read | 合并 paths | 每个 call 独立详情 | toolCallId/顺序不丢 |
| read → bash → read | 三个独立块 | 三个独立详情 | 不跨非探索工具归组 |
| grep/find/glob/ls | Search/List 摘要 + known count | safe result lines | 工具分类和单位正确 |
| failed read | failed + 一行 error | bounded error 一次 | 错误可见且不重复 |
| cancelled/aborted | 状态可见 | 已有 bounded body/状态 | 不伪装 succeeded |
| Runtime 截断 | source marker | source marker + safe body | nested details 生效 |
| 64 KiB TUI 截断 | summary不变 | presentation marker | 不宣称 full |
| 双重截断 | summary chips | 两个 marker | authority 不混淆 |
| 10k-char single line | 摘要不受正文影响 | width wrap 有界 | 无 viewport flood |
| 40 列 CJK/emoji path | wrap + marker | 可滚动可复制 | display width 正确 |
| replay session | 与 live 最终帧相同 | 详情可恢复 | 无 duplicate row id |
| active group append | 同 id 增量更新 | live tail 更新 | committed cache 不重建 |
| session switch | 新 Session 无旧 group | 新 transcript 无旧 tail | generation fence |

---

## 9. 提交切片与停止规则

建议按以下小提交执行，每个提交只暂存明确路径：

1. `test(tui): pin exploration output exposure`：S0 RED fixtures；
2. `tui: normalize exploration tool metadata`：S1；
3. `tui: separate exploration summary from transcript detail`：S2；
4. `tui: group adjacent exploration actions`：S3；
5. `tui: render bounded exploration summaries`：S4；
6. `tui: expose bounded exploration details in transcript`：S5；
7. `test(tui): close exploration replay and tty gates`：S6/S7 evidence 与文档状态更新。

停止规则：

- 如需修改 Runtime tool result content、Session schema 或 ledger，停止并请求范围确认；
- 如需读取未进入 safe presentation 的原始正文来填 transcript，停止并转 Artifact/权限专项；
- 如 grouping 导致 settled cache 必须全量重建，停止并先修 identity contract；
- 如 live/replay 无法按 toolCallId 关联 args/result，先修 correlation RED，不以 path 文本猜测；
- 如任务外脏改动与目标文件重叠，停止并报告具体冲突，不覆盖、不 stash；
- 未通过真实标准 PATH TTY 时不得把 helper/native test 写成产品验收。

---

## 10. 完成定义

本计划只有同时满足以下条件才能标记 `implemented/accepted`：

- [ ] 主时间线对 `read/grep/find/glob/ls` 成功结果只显示结构化摘要，正文零泄漏；
- [ ] Ctrl+T 按原始调用显示 safe bounded 详情，并正确区分 Runtime/TUI 两类截断；
- [ ] 相邻探索归组不改变 TimelineRow/toolCallId/durable state，live/replay 最终显示等价；
- [ ] error/cancel/abort 可见，unknown 不归零，generic/MCP/plugin 不被误分类；
- [ ] group/action/renderable/cache 全部有界，长会话无全历史重建；
- [ ] focused/full check/test/build/diff-check 全绿，任何任务外失败单独记录；
- [ ] 标准 PATH 隔离 TTY 覆盖 40/80/143 列和 Ctrl+T 生命周期；
- [ ] dark/light 人工视觉与选择复制完成；
- [ ] fresh evidence、commit、工作树边界和仍存缺口回写本文及两个索引。

在此之前，本专项状态始终是 `planned` 或 `partial`，不得因为 Plan 24 已 accepted 而继承其完成状态。
