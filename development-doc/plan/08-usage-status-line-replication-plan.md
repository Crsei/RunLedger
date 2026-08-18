# RunLedger 输入区 Usage Status Line 复刻计划

> 状态：`partial`。P1–P4 已实现并有 focused/runtime/native 证据；P5 真实 provider/TTY 与 P6 人工验收仍未完成。本文件继续作为 usage status line 的唯一状态入口。
>
> 基线：RunLedger `session-owner-runtime` / `4eecd499e715f3d588388fdbde937ec4699d9ab0`，2026-08-17；oh-my-pi `main` / `06aecdd51f07e689e970ceaa180abe2be0c14bbb`，工作树干净。

## 0. 目标与结论

在 RunLedger 输入框下方的现有 OpenTUI footer 区增加一条与 oh-my-pi usage status line 对齐的结构化展示行，至少展示：

```text
input · output · cache read · cache write · cache hit % · output tok/s · cost · context usage
```

展示语义不是把数值直接拼到 UI：

- `input/output/cache read/cache write/cost` 是当前 canonical session 的累计值；
- `output tok/s` 是最近一个有效 assistant request 的输出吞吐率，streaming 时可使用当前有效值，完成后保留最后一次有效值；
- `cache hit %` 是累计 prompt cache 命中率；
- `context usage` 是当前上下文的已用 token / context window，不是累计 token；
- provider 没有报告的字段必须隐藏或显示明确的 unavailable，不得伪造为 `0`；
- `cacheRead` 不计入 token total，避免每轮重复读取缓存上下文导致累计量虚高；
- 当前范围只展示 output tok/s，不实现 cache tok/s、字符估算 tok/s 或独立 worker 吞吐相加。

推荐的实际行形态如下，具体图标和颜色沿用 RunLedger 现有 theme/status-line 语义：

```text
in 12.3k · out 1.4k · cache-read 8.0k · cache-write 512 · hit 93.9% · 42.5 tok/s · $0.03 · ctx 18.2k/128k (14.2%)
```

本计划只复刻 oh-my-pi 的 usage 能力族，不复制其完整 status line、Nerd Font、SQLite `stats.db`、JSONL 文件格式或可配置 segment 布局。

## 1. 参考实现证据

实现阶段必须重新核对以下文件；本表记录当前源码的行为入口，不把行号当作永久 API：

| 行为 | oh-my-pi 参考实现 |
|---|---|
| tok/s 纯计算 | `packages/coding-agent/src/utils/token-rate.ts`：`MIN_DURATION_MS = 100`；优先使用 assistant `duration`，streaming 且没有 duration 时使用 `now - assistant.timestamp`；无 assistant、无 output、无效 duration 返回 `null`；公式为 `output * 1000 / durationMs` |
| usage segments | `packages/coding-agent/src/modes/components/status-line/segments.ts`：`token_in`、`token_out`、`token_total`、`token_rate`、`cost`、`context_pct`、`context_total`、`cache_read`、`cache_write`、`cache_hit` |
| token total 语义 | 同上 `token_total`：`input + output + cacheWrite`，明确排除 `cacheRead`；当前 oh-my-pi 还排除 orchestration cache read，RunLedger 当前范围没有 orchestration 字段 |
| cache hit 语义 | 同上 `cache_hit`：`cacheRead / (cacheRead + cacheWrite + input) * 100`；无 `cacheRead` 时隐藏 |
| full/nerd 展示组合 | `packages/coding-agent/src/modes/components/status-line/presets.ts` 的 `full` / `nerd`：包含输入、输出、cache、tok/s、cost、context 和 active time；这是本计划 usage 行的内容参考 |
| 主 session rate 与 sticky | `packages/coding-agent/src/modes/components/status-line/component.ts`：主 session 读取最新 assistant，保留按 assistant timestamp 关联的最后一次有效 rate，避免 stream 结束短暂空白时闪烁 |
| 多 worker rate | 同文件和 `packages/coding-agent/src/vibe/runtime.ts`：只对正在 streaming 的 vibe worker 计算并相加；RunLedger 当前范围不复制此行为，除非未来建立明确的 child/worker usage authority |
| 累计 usage | `StatusLineComponent.#buildSegmentContext()` 从 `session.sessionManager.getUsageStatistics()` 获取 input/output/cache/cost 累计值；它与最新 request tok/s、当前 context 是三种不同范围 |
| timing 持久化 | `packages/coding-agent/src/session/agent-session.ts` 完成 assistant 后调用 `recordModelPerf`；`agent-storage.ts` 的 `model_perf` 保存 output tokens、总 duration、可选 TTFT，并按 `output_tokens * 1000 / gen_ms` 计算 TPS |
| 历史 stats | `packages/stats/src/parser.ts` 读取 assistant usage/duration/ttft；`packages/stats/src/db.ts` 的 `messages` 表保存 input/output/cache/cost/timing，并用 SQL 聚合平均 tok/s；RunLedger 当前范围不引入这套独立统计库 |
| provider timing 类型 | `packages/ai/src/types.ts` 的 `AssistantMessage` 有可选 `duration`、`ttft`；RunLedger 当前自己的 `src/types.ts` 尚未保留这两个字段，这是 P1 缺口 |

### 1.1 oh-my-pi 三种数据范围

```text
session.sessionManager.getUsageStatistics()
  ├─ input/output/cacheRead/cacheWrite/cost  → 累计 usage segments
  └─ 不决定 tok/s

latest assistant message + duration/timestamp
  └─ output * 1000 / durationMs               → 最近 request output tok/s

session.getContextUsage() + model.contextWindow
  └─ used/contextWindow                        → 当前 context usage
```

不能用一个 `totalTokens` 字段同时驱动三者，也不能把累计 output 当作当前 request output 来计算 tok/s。

## 2. RunLedger 当前基线与缺口

### 2.1 Dirty worktree 边界

开始本计划时工作树有 80 个已修改/新增路径，包含 Session Owner、Runtime、TUI、Provider 和既有计划文档改动。本任务只新增本计划并在 `development-doc/00-index.md` 追加导航；不得 reset、stash、覆盖、宽泛 staging 或把现有 dirty 改动当成本任务实现证据。

现有相关 dirty 代码必须按当前 live state 重新核对，尤其是 `src/runtime/agent-loop.ts`、`src/tui/interactive-mode.ts`、`src/tui/components/footer.ts`、`src/tui/types.ts`、`src/tui/timeline/*` 和 `src/runtime/trace/*`。本计划不会因为这些文件已经有未提交改动就宣称 P1–P4 已完成。

### 2.2 已有可复用接缝

| 接缝 | 当前能力 | 计划中的复用方式 |
|---|---|---|
| provider Usage | `src/types.ts` 的 `Usage` 已有 input/output/cacheRead/cacheWrite/totalTokens/cost | 保留字段并增加 provider-reported/availability 与 timing 的明确传递；不另造第二套 token 类型 |
| agent loop | `src/runtime/agent-loop.ts` 在 `done/error` 取得 provider message 的 usage，并生成 `message_end` | 在同一边界保留 `duration/ttft` 和 usage provenance；不从 UI 重新猜 provider 结果 |
| trace | `src/runtime/trace/recorder.ts` 已记录 provider usage/cost，并测量 model span duration | 继续作为审计/诊断证据；TUI 不直接读取 trace store，也不把 trace duration 当作未经定义的 request timing |
| TUI snapshot | `FooterSnapshotProvider` 已由 `InteractiveMode` 实现，已有 run timing、plan 和 context usage | 扩展为一个只读、safe、不可变的 `UsageSnapshot` 查询，不让 Footer 读取 Agent、SQLite 或 provider |
| timeline | `TimelineRow.assistant.usage` 和 `TimelineEvent.usage` 当前只保留 input/output | 扩展为可安全回放的 cache、cost、total、duration/ttft/provenance，或由 canonical runtime snapshot 提供同等字段；不能只在 Footer 私有累加 |
| footer | `src/tui/components/footer.ts` 已输出结构化 `status-line`，支持语义 accent、宽度适配和 unknown 隐藏 | 增加独立 usage 行，沿用 `StatusLineSegment`、`styledFooter()` 和现有 theme，不新建 ANSI 拼接 renderer |
| OpenTUI | `OpenTuiComponentFrame.footer` 是多行数组；`component-runtime.ts` 依据 `footer.length` 计算 editor 高度并逐行保留结构化颜色 | usage 行进入同一 footer frame，和 editor hint、identity/status 行共同参与高度计算 |

### 2.3 关键缺口

1. RunLedger 自有 `AssistantMessage` / `AssistantAgentMessage` 没有 `duration` / `ttft`，provider 的 timing 在 agent loop 后丢失。
2. `TimelineRow` 的 usage 只有 input/output；`InteractiveMode` 的 `message_end` 也只投影 input/output，cache/cost 不能回放或累计。
3. 当前 `getContextUsage()` 在缺少 runtime snapshot 时会用最新 assistant 的 `input + output` 回退；这不能等同于 oh-my-pi 的 current context usage，尤其会混淆 output 和 cache。
4. 当前 Footer 的 `usage` accent 主要显示 `usage <context total>`，不是 oh-my-pi 的累计 input/output/cache/cost 行。
5. provider usage 的“字段缺失”和“字段值为 0”尚未形成清晰的 provenance contract；实现不能通过 `value === 0` 推断 unavailable。
6. 当前 OpenTUI renderer 接缝已支持多行，但生产 projection、legacy component tree 和 native tests 需要一起验证，不能只增加一个单元测试字符串。

## 3. 冻结的产品与数据合同

### 3.1 UsageSnapshot

实现时在 TUI/runtime 共用的纯合同中增加等价于以下形状的结构；具体文件位置以当前 Runtime Contract 为准：

```ts
type UsageQuantity =
  | { readonly state: "exact" | "estimated"; readonly value: number; readonly source: "provider" | "replayed" | "metered" | "estimated" }
  | { readonly state: "unknown" | "unavailable" | "not-applicable"; readonly reason: string };

interface UsageSnapshot {
  readonly cumulative: {
    readonly input: UsageQuantity;
    readonly output: UsageQuantity;
    readonly cacheRead: UsageQuantity;
    readonly cacheWrite: UsageQuantity;
    readonly tokenTotal: UsageQuantity;
    readonly cost: UsageQuantity;
  };
  readonly latestRequest?: {
    readonly input: UsageQuantity;
    readonly output: UsageQuantity;
    readonly cacheRead: UsageQuantity;
    readonly cacheWrite: UsageQuantity;
    readonly durationMs: UsageQuantity;
    readonly ttftMs: UsageQuantity;
    readonly outputTokensPerSecond: UsageQuantity;
  };
  readonly context?: {
    readonly usedTokens: UsageQuantity;
    readonly contextWindow: UsageQuantity;
    readonly percent: UsageQuantity;
  };
  readonly status: "idle" | "streaming" | "waiting" | "error" | "unavailable";
}
```

约束：

- `0` 是合法的 exact 值；只有字段缺失、来源不可信或 provider 没有报告时才是 unknown/unavailable。
- 累计字段按 usage field 分别相加；一个 assistant turn 只能计入一次，重放/重复订阅不能重复计数。
- `tokenTotal = input + output + cacheWrite`；不加 `cacheRead`。如果未来出现 orchestration token，必须单独扩展合同和显示规则。
- `cacheHitPercent = cacheRead / (cacheRead + cacheWrite + input) * 100`；分母为 0、输入不完整或 cacheRead 不可用时隐藏 hit。
- `outputTokensPerSecond` 只使用 output tokens；优先 provider `durationMs`，其次是明确标记的本地 stream duration；不减去 TTFT，不用 `activeDurationMs`，不从字符数估算。
- 所有 token/cost 数必须是 finite、非负、安全范围；异常值转为 unavailable 并留下可测试的 reason。
- cost 只在 provider pricing/cost provenance 可确认时展示；非计费模型的真实 `$0` 可以显示为 exact 0，也可以按设计隐藏，但不能把 unknown 映射成 `$0.00`。
- context 的 used token 必须来自 runtime context snapshot 或明确标记的 provider prompt usage；不能用累计 usage 代替。

### 3.2 数据来源优先级

```text
provider AssistantMessage usage + duration/ttft
        ↓
AgentMessage / message_end / canonical session event
        ↓
session usage reducer + current context snapshot
        ↓
safe UsageSnapshot（TUI 只读查询）
        ↓
Footer status-line segments
        ↓
OpenTUI frame.footer（输入框下方）
```

重放必须走同一个 reducer；Footer 不得从 ledger 文件、SQLite、trace CAS 或 provider 对象自行读取。若当前 canonical event 只保存摘要，则先扩展 event/codec 的无损可回放字段，再接 UI。

### 3.3 Footer 行布局

保留现有 footer 的责任和顺序，新增 usage row，不改变输入编辑器行为：

```text
editor
  └─ editor hint（快捷键 + idle/working/waiting）
  └─ identity/status footer（session/model/workspace/path 等既有字段）
  └─ usage footer（本计划新增，多行 footer 中的独立 status-line）
```

规则：

- 没有任何可展示 usage 字段时不生成空白 usage 行；已有 footer 仍正常显示。
- usage row 使用结构化 segments，不把 ANSI 字符串交给 `styledFooter()`；每个 segment 继续获得 semantic color。
- 宽屏显示完整的 required/available 字段；窄屏优先保留 `out`、`tok/s`、`ctx` 的核心数字，再依次隐藏 cost、cache hit、cache read/write、input、可选 total，具体顺序在 P0 视觉契约中固定并测试。
- 行内字段必须有稳定 label，不能只用两个无法区分的 cache 图标；`cache-read` 与 `cache-write` 必须能被纯文本 fallback 区分。
- overlay 打开、输入失焦、waiting/recovery/error 时不改变快照 provenance；可以隐藏实时 usage row 或冻结最后一帧，但不得清空成 0 或继续显示已失效的 streaming rate。
- footer 行数变化必须参与 OpenTUI editor height 计算；至少保留现有 editor 可编辑、footer 可见和 transcript 一行的约束。
- dark/light theme 都使用现有 `usage` / `limit` / `state` 等语义色；不新增只在 ANSI 颜色下可读的含义。

## 4. 分阶段实施计划

### P0 — 基线、命名和视觉契约（RED 前置）

**目标**：冻结“累计、最新 request、context”三种范围和 footer 行布局，避免先写 renderer 再返工数据语义。

**工作项**：

- 重新核对 oh-my-pi 当前 `full/nerd` preset、token-rate、cache-hit、sticky rate 和 stats persistence；把当前行号、示例输出和边界记录回本计划。
- 为 RunLedger 定义 `UsageSnapshot`、`UsageQuantity`、字段 provenance、unknown/zero、token total 和 cache hit 规则。
- 冻结 usage row 的 segment 顺序、label、窄屏 drop order、无数据行为、streaming/idle/error 状态和颜色映射。
- 记录当前 dirty worktree 的基线和计划范围；不把同目录其他 plan 的未提交代码吸收进来。

**门禁**：contract review 能逐项回答“数值来自哪一层、是累计还是最新、缺失如何表达、重放如何一致”。

### P1 — provider timing/usage 无损保留

**目标**：让 provider 的 usage、duration、ttft 从 stream 完成边界进入 Agent、事件和 canonical replay。

**工作项**：

- 在 RunLedger 的 assistant message/runtime 类型中补充可选 `durationMs` / `ttftMs`（或与 pi-ai 对齐的 `duration` / `ttft`），并保持 `verbatimModuleSyntax`、erasable-only 和 `.ts` import 规则。
- `agent-loop.ts` 在 `done` 和 `error` 路径保留 provider message 的 usage/timing/provenance；tool-use 多轮只按 assistant message 次数计数。
- `defaultConvertToLlm`、session codec、ledger/session event schema、projection/replay 和 trace adapter 同步保留字段；不得只在 `InteractiveMode` 私有字段中缓存。
- 为 provider 没有 usage/timing、usage 为合法 0、abort/error、stream 中途断开分别定义结果；错误不生成伪造吞吐率。
- 如果必须使用本地 duration 兜底，只记录 provider duration 缺失且 stream 起止明确的 measured source；禁止使用包含 approval/credential wait 的 active run duration。

**门禁**：agent-loop、session replay 和 provider fixture 都能证明完整字段无损；同一 message 重放不会双计。

### P2 — 纯函数聚合、速率与格式化

**目标**：把 oh-my-pi 的算术和显示规则做成与 renderer 无关的可测试函数。

**工作项**：

- 实现累计 usage reducer：input/output/cacheRead/cacheWrite/cost 分列相加，token total 排除 cacheRead。
- 实现 `calculateOutputTokensPerSecond()`：最小有效 duration 100ms、优先 provider duration、stream fallback、finite/non-negative 校验；返回 `null`/unknown 而不是 0。
- 实现 cache hit 率：按 oh-my-pi 分母计算，累计值和字段 availability 缺失时隐藏。
- 实现 token/cost/context 格式化：`1.2k/1.2m`、固定一位 tok/s、百分比精度和 UTF-8/显示宽度安全；所有文本经过现有 sanitize。
- 把 `latestRequest`、sticky last-valid rate、cumulative snapshot、context snapshot 的边界写成纯测试 fixture。

**门禁**：纯函数测试覆盖 0、缺失、负数、NaN、<100ms、streaming、cache-only、cache miss、context window 0 和 cost unavailable。

### P3 — Runtime/TUI usage snapshot 接线

**目标**：让 Footer 从 canonical session/runtime snapshot 读取数据，不直接消费 provider/存储。

**工作项**：

- 在 `FooterSnapshotProvider` 增加 `getUsageSnapshot()` 或等价的单一安全查询；不要添加八个互相独立、可能跨 revision 的 getter。
- `InteractiveMode.handleEvent()` 在 message update/end、agent end、session resume/switch/fork 和 owner recovery 时刷新 usage projection；streaming usage 没有 provider 数值时保持 unknown。
- 累计 usage 优先由 canonical replay/reducer 派生；context usage 优先使用 runtime snapshot，删除或明确标记当前 `input + output` fallback 的近似语义。
- session switch、fork、recovery 和 stale generation 必须清除/替换旧 snapshot；旧 run 的异步更新不能污染新 session。
- 保证 UI render 是 pull-only：snapshot 是 bounded immutable data，不能把 `Agent`, `Model`, `SessionStore`, absolute path 或 credential 暴露给 presentation。

**门禁**：runtime integration test 覆盖正常 turn、tool-use 第二轮、abort/error、resume、fork、session switch、owner takeover 和重复 event。

### P4 — Footer/OpenTUI usage row

**目标**：在输入框下面显示同样内容，并保持现有输入、颜色、宽度和多行布局契约。

**工作项**：

- 在 `Footer.present()` 或相邻的纯 `UsageFooter` component 中输出第二个结构化 `status-line`；复用 `OpenTuiComponentFrame.footer`，不创建独立 renderer。
- 保持顺序 `editor hint → identity/status → usage`，无 usage 时不占额外行；把 usage segments 与现有 identity segments 分开拟合，避免窄屏删除整个既有 footer。
- 增加 required fields 的语义 accents：token/cost 走 usage，context percentage/limit 走 limit，streaming/error 状态保留 state；暗色/亮色都验证。
- 将 usage 行纳入 `footerHeight`、`maxEditorHeight`、bottom-left overlay anchor 和 transcript viewport 计算；不让输入草稿、光标或 overlay 因 footer 多一行而消失。
- 纯终端 fallback 也输出可读 label；禁止只在 OpenTUI native path 正确而普通 terminal path 丢字段。

**门禁**：component 单测验证 segments/行顺序/隐藏/窄屏；OpenTUI native 测试验证多行 frame、结构化颜色、editor 高度和 resize。

### P5 — 集成、真实 TTY 和可回放验收

**目标**：证明显示的是实际 provider/runtime 数据，而不是 fixture-only UI。

**工作项**：

- 使用隔离 `RUNLEDGER_DIR`、隔离 workspace 和标准全局 `runledger` 链接，先 `npm run build` 再进行真实 TTY/tmux smoke。
- 至少验证一个带 input/output/cacheRead/cacheWrite/cost/duration 的真实 provider 响应；再验证 provider 不返回 cache/cost/timing 时 usage 行不显示伪造 0/NaN。
- 发送普通 prompt、tool-use 多轮、interrupt、session resume/fork；比较 live footer 与 replay 后 footer 的累计值，确认每个 assistant response 只计一次。
- 在 40、80、120 列以及 CJK/emoji editor 草稿下检查 footer、输入框、transcript、overlay 不重叠；检查 dark/light theme 颜色仍有语义。
- 如当前没有真实 provider cache/timing 证据，单独标记 unavailable，不以 faux provider 或字符估算冒充 provider parity。

**门禁**：focused Vitest、Bun OpenTUI native、`npm run check`、`npm test`、`npm run build`、`git diff --check` 和真实 TTY 证据全部分别记录；任何既有无关 blocker 必须单独标识。

### P6 — 发布边界、回滚与后续项

**完成定义**：P0–P5 的合同、代码、测试和真实显示证据闭合后，才把计划状态改为 `implemented`；否则保留 `partial` 并列出缺口。

**回滚形态**：

- usage row 可以由 feature gate/默认关闭路径隐藏，但不能回退到读 provider 或 UI 私有计数器；关闭只影响 presentation，不删除已持久化 usage。
- 如果 provider timing 字段在某一适配器不稳定，保留 usage 行的可用字段并将速率置 unavailable；不能用错误的全 run duration 继续展示高可信 tok/s。
- native OpenTUI 多行有问题时，先保留单行纯文本 fallback 和 editor height 保护，再修 renderer；不得删除现有 editor/footer contract。

**明确后续项**：

- cache tok/s、TTFT 独立展示、provider/model recency TPS、独立 `stats.db`、可配置 segment preset；
- vibe/child worker rate 聚合；必须先冻结 child usage ownership 和是否按并行总吞吐展示；
- 跨 session 全局统计和成本报表；不由本计划偷偷新增 SQLite 统计库。

## 5. 测试与证据矩阵

| 层级 | 必须覆盖 |
|---|---|
| pure unit | rate 公式/100ms 下限/stream fallback/sticky；cache hit 分母；token total 排除 cacheRead；format/width/unknown/provenance |
| runtime | provider `done/error` usage/timing 保留；partial usage；tool-use 多轮；abort；duplicate event；session resume/fork/switch；owner generation fence |
| timeline/replay | cache/cost/timing 不丢；累计一次；冷恢复与 live snapshot 一致；unknown 不被 schema/default 变成 0 |
| Footer component | segment 顺序、label、缺失字段隐藏、窄屏 drop order、dark/light semantic accent、无 usage 不占空行 |
| OpenTUI Bun | 两/三行 footer 可见；结构化颜色逐行保留；editor 高度随 footer 变化；resize、CJK、长草稿、overlay 和 transcript 保持可用 |
| integration/TTY | 隔离 home + real `runledger`；真实 provider usage；cache/cost/timing unavailable；resume/fork；40/80/120 列；普通 terminal fallback |

禁止用以下证据替代真实链路：只构造 `Footer` fixture、只检查 `render(width)` 字符串、只读取 trace/SQLite、只运行 faux stream、或只在 128 列验证。

## 6. 文件范围与执行纪律

预期实现范围（以 P1–P4 开始前的 live code 为准）：

- runtime/type/event/codec：`src/types.ts`、`src/runtime/types.ts`、`src/runtime/agent-loop.ts`、`src/runtime/ledger/*`、`src/storage/session-store/*`；
- usage reducer/format：建议放在 `src/runtime/usage/` 或现有纯函数模块，不放在 OpenTUI renderer 内；
- TUI contract/projection：`src/tui/types.ts`、`src/tui/interactive-mode.ts`、`src/tui/timeline/*`、`src/tui/components/footer.ts`；
- native接缝/测试：`src/tui/primitives.ts`、`src/tui/opentui/component-runtime.ts`、`tests/tui/*`；
- runtime/provider/trace tests：`tests/agent-loop.test.ts`、`tests/runtime/*`、`tests/storage/*`、新增最小 focused tests。

执行纪律：

- 先写 RED，再实现 P1–P4；每个阶段只暂存明确路径；不使用 `git add -A`、`git add .`、`git commit -a`、`--no-verify`、reset、stash。
- TUI/CLI 或 dist 相关修改每次都必须重建 `dist`，确认 `which runledger` 指向本仓库，并用真实 TTY 验证。
- 提交前按仓库规则运行完整 `npm run check`、`npm test`、必要时 `npm run build`；纯文档本轮只运行 `git diff --check`。
- 本计划不授权 commit 或 push；实现完成后的提交仍需用户明确要求。

## 7. 状态表

截至 2026-08-19，以下实现证据来自当前 `session-owner-runtime` 工作树；它们不是 commit、真实 provider 或真实 TTY 验收声明：

- P1：assistant message、AgentEvent、ledger payload、session replay 和 `defaultConvertToLlm` 保留 usage、`durationMs`、`ttftMs`、timing source；没有 provider duration 的成功 stream 只使用明确标记的 measured stream duration；AgentEvent 的 message/turn/tool 事件带同一 `runId`，TUI 会拒绝旧 run 事件。
- P2：`src/runtime/usage/index.ts` 提供字段级 provenance、去重替换、累计 reducer、cache hit、token total、sticky output tok/s 和格式化；`cacheRead` 不进入 total，unknown 不被渲染为零。
- P3：`InteractiveMode` 从 canonical initial messages seed；partial/final usage 共享 request id；owner recovery 状态切换从 controller messages 重新 seed；resume/fork/new view 的构造路径按目标 controller messages seed；context usage 优先 runtime snapshot，旧 `input + output` 只保留为 legacy approximate getter fallback。
- P4：Footer usage 是独立结构化 status row，identity/usage 分开拟合；窄屏保留 `out`、`tok/s`、`ctx` 优先级；OpenTUI 多行颜色、editor height、resize 和 timeline usage round-trip 有 focused/native tests。

| 阶段 | 状态 | 完成证据 |
|---|---|---|
| P0 基线/合同/视觉 | `documented` | 本计划冻结数据范围、unknown/zero、segment/drop 顺序与安全边界 |
| P1 provider timing/usage 保留 | `implemented` | `tests/runtime/usage-retention.test.ts`、agent loop、replay 与 conversion 证据 |
| P2 聚合/速率/格式化 | `implemented` | `tests/runtime/usage.test.ts` 覆盖 reducer、去重、rate、cache hit、format/provenance |
| P3 runtime/TUI snapshot | `implemented` | streaming partial replacement、stale run fence、recovery re-seed、resume/fork/new seed tests |
| P4 footer/OpenTUI | `implemented` | Footer focused tests、OpenTUI native layout/color/resize tests、timeline reducer round-trip |
| P5 real TTY/provider | `pending` | 隔离标准 PATH、`runledger --help`、tmux `/model` 与干净 `Ctrl+D` 退出已验证；真实 provider usage/cache/cost/timing 与 live/replay 对比仍缺失 |
| P6 acceptance | `pending` | 尚未完成全量门禁记录与 human acceptance；不因 P1–P4 focused evidence 提前闭合 |

### 7.1 Fresh validation（2026-08-19）

- focused Vitest：usage/runtime/TUI 相关 8 files / 96 tests 通过；Bun OpenTUI 102 tests / 638 assertions 通过；`npx tsc --noEmit -p tsconfig.json`、`npm run build`、`git diff --check` 通过。
- 其余静态门禁逐项通过：storage/runtime/contract-consumers/execution/platform/TUI/session-owner、syntax-highlighter、bash-ast-assets；`which runledger` 为 `/home/nzq/.npm-global/bin/runledger`，全局链接指向当前仓库。
- 排除既有 `tests/runtime/current-format-boundary.test.ts` 后的完整 Vitest 为 438 files passed / 1 skipped、2664 tests passed / 3 skipped；native Bun 已单独通过。完整 `npm test` 与 `npm run check` 仍在 `check:current-format` 首个既有 internal generation marker 扫描处失败；未修改扫描器或文档规避。
- 隔离 `RUNLEDGER_DIR` 的标准 `runledger` 已完成 `--help` 与 tmux TTY `/model` smoke；usage row 在无累计 provider usage 时只显示 `ctx window 200.0k`，未伪造 token/cost 为零；逐级 Esc 后 Ctrl+D 使 tmux pane/session 退出。
- P5 仍不闭合：没有真实 provider 的 input/output/cacheRead/cacheWrite/cost/duration 证据，也没有真实 prompt/tool-use/resume/fork 的 live 与 replay usage 对比；P6 human acceptance 同样 pending。

## 8. 不实现清单

- 不把 `cacheRead` 计入累计 total，不显示不存在的 cache tok/s。
- 不从 output 字符数、字节数或 faux delay 推算 provider token。
- 不把 latest request、cumulative session、current context 三种数值混为一个字段。
- 不把 `ttft` 冒充 output tok/s 的分母；TTFT 先保留为 timing evidence，是否显示另立计划。
- 不新增 oh-my-pi `stats.db`、`agent.db model_perf` 或独立 usage authority。
- 不让 TUI 直接访问 provider、Agent、SessionStore、trace store、SQLite 或 credential。
- 不将 usage snapshot 放入 public/remote DTO，除非另有脱敏、能力门控和版本化合同；当前计划只面向本地输入区 footer。
- 不因某个 provider 不支持 cache/cost/timing 而让整条 usage 行失败；按字段显示 known/unavailable。
