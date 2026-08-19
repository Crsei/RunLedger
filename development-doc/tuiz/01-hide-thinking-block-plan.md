# RunLedger 隐藏思考块（hideThinkingBlock）设置与快捷键计划

> 状态：`implemented`（当前工作树，2026-08-20，未提交）。RunLedger 已增加持久设置（settings.json `hideThinkingBlock`）、单次运行 CLI 标志（`--hide-thinking`）、会话内快捷键（`alt+t`）和 `/hide-thinking` 持久化命令。语义保持 **display only**——仅隐藏展示，思考数据与 token 消耗不变；切回即恢复。
>
> 实施基线：RunLedger 当前工作树（`src/tui/interactive-mode.ts` 3047 行、`src/storage/settings-manager.ts` 481 行版本）。本计划未登记 `development-doc/00-index.md`（目录 `tuiz/` 为用户指定新目录）。

## 0. 目标与结论

给 RunLedger TUI 增加三入口的思考块隐藏能力，覆盖两条渲染通道（主对话 timeline 与 transcript overlay），数据层零改动：

| 入口 | 形态 | 作用域 | 持久性 |
|---|---|---|---|
| 设置 | `~/.runledger/settings.json` 键 `hideThinkingBlock: boolean` | 全局默认 | 持久 |
| CLI | `runledger --hide-thinking` | 单次运行 | 不落盘 |
| 快捷键 | `alt+t`（`tui.thinking.toggle`） | 当前会话 | 不落盘（display only） |
| slash 命令 | `/hide-thinking`（可选 P4） | 写入设置 | 持久 |

核心决策：

- **过滤点选展示层 `rowToBlocks`**（`src/tui/timeline/selectors.ts`），不选数据层。`TimelineRow.thinking`、`message_update` 事件、回放路径全部不动——与 oh-my-pi `hideThinkingBlock` "display only" 语义一致，且切换即时可逆。
- **隐藏状态作为纯函数参数贯穿**投影链（`projectInteractivePresentation` / `projectTranscriptOverlay` → `timelineToBlocks` → `rowToBlocks`），不做模块级可变状态，保持 selector 可单测。
- **快捷键用 `alt+t` 而非 oh-my-pi 的 `ctrl+t`**：RunLedger 的 `ctrl+t` 已被 transcript overlay 占用（`interactive-mode.ts` `handleTranscriptInput`）。`matchesKey` 不支持 `ctrl+shift+t`（终端无法区分 ctrl+t / ctrl+shift+t，均发送 `0x14`），`alt+t` 是 `\x1bt` 序列，无协议依赖。
- **运行时状态由 `InteractiveMode` 持有**，初始值 = `CLI 标志 ?? settings.hideThinkingBlock ?? false`，不进 runtime/agent 层（display-only 特性无需跨进程）。

## 1. 参考实现证据（oh-my-pi）

| 行为 | oh-my-pi 参考 | RunLedger 现状 |
|---|---|---|
| 持久设置 | settings schema 键 `hideThinkingBlock: boolean`，默认 `false`，"Hide thinking blocks in output"；`omp config set hideThinkingBlock true` | 无此键；`ProjectSettings` 已有 `thinkingLevel` 先例 |
| CLI 标志 | `--hide-thinking` 设置运行时覆盖（"display only"），不落盘 | `--thinking <level>` 先例存在（`src/cli/args.ts`） |
| 快捷键 | `app.thinking.toggle` = `Ctrl+T`：Toggle thinking-block visibility（会话内） | `ctrl+t` 已被 transcript overlay 占用；`KeybindingsManager` + `TUI_KEYBINDINGS` 机制存在 |
| 语义 | display only：模型仍思考、token 照常消耗 | 计划对齐：数据层不丢 thinking |

注：oh-my-pi 的 `defaultThinkingLevel: auto` + `Ctrl+T` 循环强度不在本计划范围（RunLedger 已有 `/thinking` 选择器与 `--thinking`）。

## 2. RunLedger 当前基线与缺口

### 2.1 思考块数据流（已确认，实施前重新核对）

```text
provider stream → thinking_start/delta/end
  → src/tui/interactive-mode.ts handleEvent:
       case "thinking_delta" → queueAssistantDelta({ channel: "thinking", partId: `thinking:${contentIndex}` })
  → flushStreamingDeltas() → dispatchTimeline({ type: "message_update", thinking: { text, byteLength } })
  → src/tui/timeline/reducer.ts: message_update.thinking → TimelineRow.thinking
  → src/tui/timeline/selectors.ts rowToBlocks():
       row.thinking.text.length > 0 → PresentationBlock { id: `${baseId}/thinking`, kind: "markdown", streaming }
  → 消费端（两处）:
       src/tui/presentation/projectors.ts projectInteractivePresentation → timelineToBlocks(state.timeline)   [主对话]
       src/tui/transcript-view.ts projectTranscriptOverlay → timelineToBlocks(state, { includeActive: false }) [Ctrl+T overlay]
  → src/tui/components/chat-container.ts setTimelineBlocks(blocks, generation) + RenderCache/partGenerationFence
```

回放路径同样投影 thinking：`src/tui/timeline/event-projector.ts` `projectReplayMessage` / `makeAssistantRow` 从 `message.content[].type === "thinking"` 提取。

### 2.2 已有可复用接缝

| 接缝 | 当前能力 | 计划中的复用方式 |
|---|---|---|
| `ProjectSettings` / `sanitizeProjectSettings`（`storage/settings-manager.ts`） | 白名单清洗；`thinkingLevel` 已按 `isThinkingLevel` 清洗 | 加 `hideThinkingBlock?: boolean` + 布尔清洗一行 |
| `--thinking`（`cli/args.ts` + `cli/main.ts` overrides） | flag 解析 → `overrides.thinkingLevel` | 同模式加 `--hide-thinking`（无值 boolean） |
| `TUI_KEYBINDINGS` / `KeybindingsManager` / `matchesKey`（`tui/primitives.ts`） | 默认绑定 + user bindings + `matchesKey(data, "alt+x")` 已支持 `\x1b` 前缀 | 加 `tui.thinking.toggle` 定义 |
| `handleTranscriptInput`（`interactive-mode.ts`，`addInputListener`） | `matchesKey(data, "ctrl+t")` → transcript overlay；input listener 先于 editor 消费 | 并列加 `alt+t` 分支 → toggle |
| `syntax-theme-settings.ts`（`cli/`） | `loadProjectSettings` + `saveProjectSettings` 持久化 theme | `/hide-thinking` 命令持久化同模式 |
| slash 注册表（`tui/commands/registry.ts` + `dispatchCommand`） | `SlashCommandActionType` + `case "config.thinking"` | 加 `config.hide-thinking`（可选 P4） |
| `tests/tui/timeline/selectors.test.ts` | `rowToBlocks` / `timelineToBlocks` 单测 | 加 hideThinking 参数用例 |

### 2.3 缺口

1. **设置与 CLI 无 hideThinking 概念**——schema、清洗、解析、传递全缺。
2. **`rowToBlocks` / `timelineToBlocks` 无隐藏选项**；两个消费端（projectors.ts、transcript-view.ts）签名无状态可传。
3. **运行时切换无重投影入口**：`interactive-mode.ts` store subscribe 仅在 `next.timeline.generation` 变化时重投影（366 行）；toggle 不改 store → 需显式强制重投影路径。
4. **快捷键冲突**：`ctrl+t` 已被占用；`matchesKey` 无 `ctrl+shift+t` 支持。
5. **ChatContainer 缓存**：`presentCache` 以 `timelineGeneration + width + themeGeneration` 为键（`chat-container.ts` 175-180 行），toggle 后 generation 不变时可能命中旧 blocks——必须纳入 revision 或清缓存。

## 3. 冻结的产品与数据合同

### 3.1 设置 schema（`~/.runledger/settings.json`）

```jsonc
{
  // …既有字段不变…
  "thinkingLevel": "high",
  "hideThinkingBlock": true   // 新增；boolean；缺省 false
}
```

- `ProjectSettings.hideThinkingBlock?: boolean`。
- `sanitizeProjectSettings`：`if (typeof raw.hideThinkingBlock === "boolean") out.hideThinkingBlock = raw.hideThinkingBlock;`——未知/非布尔整体丢弃（与 `autoTitle` 同规则）。
- 无 workspace 层限制（非 `recording` 类 authority 字段；workspace settings 同样可写，与 `thinkingLevel` 一致）。

### 3.2 CLI

```
runledger [--hide-thinking] [--thinking <level>] …
```

- `--hide-thinking`：无值 boolean flag；解析进 `ParsedArgs.hideThinking?: boolean`。
- 优先级：`--hide-thinking`（显式 true/false）> `settings.hideThinkingBlock` > `false`。仅在 CLI 显式给出时覆盖设置。
- **不进 runtime/agent 层**：不加入 `HostSessionOpenRequest` / `overrides`，只在 `main.ts` 合成后注入 TUI 构造参数（display-only）。

### 3.3 快捷键

| 绑定名 | 默认键 | 动作 |
|---|---|---|
| `tui.thinking.toggle`（新增） | `alt+t` | 会话内切换思考块可见性（display only） |
| `tui.transcript.toggle`（现状） | `ctrl+t` | 保持不动 |

- 键位经 `KeybindingsManager` 解析（`this.kb.matches(data, "tui.thinking.toggle")`），未来 M6 user bindings 可重绑。
- `alt+t` 在 `\x1bt` 与 `t`（可能来自部分终端 meta 序列差异）两种形态均可被 `matchesKey` 匹配：`data === "\x1bt"` 命中 alt 分支；裸 `t` 是普通字符输入，编辑器正常消费——无冲突。
- overlay 打开（transcript/selector/permission）时 `alt+t` 不生效（input listener 中 overlay 优先分支已存在）。

### 3.4 隐藏语义（冻结）

- **display only**：`TimelineRow.thinking`、`message_update` 事件、`TimelineState` 完全不变；仅 `rowToBlocks` 不产出 thinking block。
- 主对话与 transcript overlay（`Ctrl+T`）**同步隐藏**——两个消费端都过 `timelineToBlocks`，同一参数贯穿。
- 流式中：thinking delta 仍累积进 `pendingMessageBuffers`/`TimelineRow`；隐藏开启时该轮 thinking 直接不投影，打开后历史行 thinking 立即恢复显示（因数据未丢）。
- 复制 transcript（`transcriptBlockLines`）随显示隐藏——thinking 文本不可复制；如需"复制含思考"为后续项，不在本计划。

### 3.5 状态流

```text
启动: main.ts 读 settings → effective = args.hideThinking ?? settings.hideThinkingBlock ?? false
      → InteractiveMode 构造参数 opts.hideThinkingBlock
会话内: alt+t → toggleThinkingVisibility():
          翻转 this.hideThinkingBlock
          强制重投影（见 §4.3 缓存处理）
          this.ui.requestRender()
持久化: /hide-thinking on|off（P4）→ saveProjectSettings({ layout }, { ...current, hideThinkingBlock })
```

## 4. 分阶段实施

### P0 — 设置层（`src/storage/settings-manager.ts`）

1. `ProjectSettings` 接口加 `hideThinkingBlock?: boolean`。
2. `sanitizeProjectSettings` 加布尔清洗（`typeof raw.hideThinkingBlock === "boolean"`）。
3. 单测：`tests/storage/settings-manager.test.ts`（若文件不存在则新建；现有测试位于 `tests/storage/`）：
   - `hideThinkingBlock: true` 保留；`"yes"`/`1`/缺失 → 丢弃。
   - `saveProjectSettings` 往返：写入 `{ hideThinkingBlock: true }` 后 `loadProjectSettings` 读回 `true`。

### P1 — CLI 标志（`src/cli/args.ts` + `src/cli/main.ts`）

1. `args.ts`：`ParsedArgs.hideThinking?: boolean`；解析 `--hide-thinking`（无值，置 `true`）；usage 文案加一行。
2. `main.ts`：合成 `effectiveHideThinking`：
   ```ts
   const hideThinkingBlock = args.hideThinking ?? settings.hideThinkingBlock ?? false;
   ```
   传入 `new InteractiveMode({ … hideThinkingBlock })`（构造参数扩展见 P3）。
3. 不做 `--hide-thinking=false` 反向覆盖（与 omp 一致，flag 存在即开）。

### P2 — 投影过滤（`src/tui/timeline/selectors.ts` + 两个消费端）

1. `TimelineToBlocksOptions` 加 `readonly hideThinking?: boolean`（缺省 `false`，既有调用零改动）。
2. `rowToBlocks(row, options)`：thinking block 生成条件改为 `!options.hideThinking && row.thinking.text.length > 0`；`timelineToBlocks` 透传 options。
3. `src/tui/presentation/projectors.ts`：`projectInteractivePresentation(state, options?: { hideThinking?: boolean })` → `timelineToBlocks(state.timeline, options)`。
4. `src/tui/transcript-view.ts`：`projectTranscriptOverlay(state, revision, options?: { hideThinking?: boolean })` → `timelineToBlocks(state, { includeActive: false, ...options })`。
5. 单测（`tests/tui/timeline/selectors.test.ts`）：
   - `hideThinking: true` 时 assistant 行只产 text block，无 `${id}/thinking` block；`false`/缺省保持现状。
   - 行 id / text block 的稳定 id 不受 hideThinking 影响（缓存稳定性）。

### P3 — 运行时切换（`src/tui/interactive-mode.ts` + `src/tui/primitives.ts` + `src/tui/components/chat-container.ts`）

1. `primitives.ts`：`TUI_KEYBINDINGS` 加
   ```ts
   "tui.thinking.toggle": { defaultKeys: "alt+t", description: "Toggle thinking-block visibility (display only)" },
   ```
2. `interactive-mode.ts`：
   - 构造参数 `opts.hideThinkingBlock?: boolean` → 私有 `hideThinkingBlock`。
   - `handleTranscriptInput`（现有 input listener）在 `ctrl+t` 分支前并列：
     ```ts
     if (this.kb.matches(data, "tui.thinking.toggle")) { this.toggleThinkingVisibility(); return { consume: true }; }
     ```
     （overlay 打开时该 listener 已先行 return，天然不生效。）
   - `toggleThinkingVisibility()`：
     ```ts
     this.hideThinkingBlock = !this.hideThinkingBlock;
     this.presentationRevision += 1;               // 见下
     this.showNotice(this.hideThinkingBlock ? "Thinking hidden" : "Thinking visible");
     this.ui.requestRender();
     ```
   - store subscribe 回调重投影条件扩展：`next.timeline.generation !== this.lastTimelineGeneration || this.presentationRevision !== this.lastPresentationRevision`；投影调用传 `{ hideThinking: this.hideThinkingBlock }`，`setTimelineBlocks` 的 generation 传 `next.timeline.generation`（结合下一条缓存处理）。
3. `chat-container.ts` 缓存处理（二选一，实施时取改动最小者）：
   - **A（推荐）**：`setTimelineBlocks` 增加可选 `revision` 参数并入 `presentCache` 键判定（`presentCache.generation === this.timelineGeneration && presentCache.revision === this.timelineRevision`），toggle 时 `presentationRevision` 变化即自然失效；或
   - **B**：toggle 时直接 `this.refs.chat.clear()`（`presentationCache.clear()` + `partGenerationFence.reset()`）后重投影。
   - 无论哪种，必须保证：toggle 后重投影不返回旧缓存 blocks；后续 streaming 的 settled-block 命中率不受影响。
4. 单测（`tests/tui/interactive-controls.test.ts` 或 `tests/tui/baseline/interactive-mode-inventory.test.ts`）：
   - `alt+t` 输入 → `hideThinkingBlock` 翻转 → 重投影 blocks 中无 thinking block；再按 → 恢复。
   - 设置 `hideThinkingBlock: true` 构造 → 首帧即隐藏。
   - transcript overlay 打开时 `alt+t` 不切换（overlay 优先）。

### P4 — `/hide-thinking` slash 命令（持久化）

1. `src/tui/commands/registry.ts`：`SlashCommandActionType` 加 `"config.hide-thinking"`；`builtinCommandDescriptors()` 加
   ```ts
   command("hide-thinking", "Toggle hiding thinking blocks (persists to settings)", 12, {
     actionType: "config.hide-thinking", category: "config",
     policy: READONLY_POLICY, availableDuringTask: false,
   }),
   ```
   （`policy` 参照 `config.thinking` 条目的既有常量。）
2. `interactive-mode.ts` `dispatchCommand` 加 `case "config.hide-thinking"` → 调 toggle + 持久化（模式照抄 `syntax-theme-settings.ts`：`loadProjectSettings` → `saveProjectSettings({ layout }, { ...current, hideThinkingBlock: next })`）；无 `layout` 引用的路径用现有 `preferencesPort`/设置端口先例，实施时按 `interactive-mode.ts` 已注入的 port 选型。
3. 单测：`tests/tui/commands/registry.test.ts` 注册断言。

### P5 — 文档与收尾

- `AGENTS.md` 能力清单补 hideThinkingBlock 记录（若该文件维护能力表）。
- 本计划状态回填为 `implemented`（含实现提交 id）。
- 可选：`development-doc/00-index.md` 登记（用户指定目录 `tuiz/`，索引登记需用户确认后再做）。

## 5. 验收

实施结果：设置/CLI/selector/主 timeline/transcript overlay/快捷键/slash persistence 已接线；toggle 通过显式重投影调用 `ChatContainer.setTimelineBlocks`，该 setter 在相同 timeline generation 下也会失效 whole-timeline cache 并按稳定 block id 复用 settled blocks，因此无需扩展 cache key。

2026-08-20 fresh evidence：9 个相关 Vitest 文件共 153 tests passed；Node/tsx CLI 回归 9 files / 60 tests passed；完整 Bun 原生套件 17 files / 126 tests passed；`npm run build` 通过；隔离 `RUNLEDGER_DIR` 的真实 tmux TTY 已验证 `alt+t`、`ctrl+t` 与 `/hide-thinking` 持久化。`npm run check` 和完整 Vitest 仅被本任务范围外未跟踪文件 `development-doc/tui/25-pi-working-loader-shimmer-replication-plan.md` 的 current-format markers（208/352/397 行）阻断；其余 check 子门禁全部通过。

| # | 场景 | 操作 | 预期 |
|---|---|---|---|
| 1 | 设置持久隐藏 | `settings.json` 写 `"hideThinkingBlock": true` 后启动 | 主对话无 thinking block；模型仍思考（token 计费不变） |
| 2 | CLI 单次隐藏 | `runledger --hide-thinking` | 本次运行隐藏；settings 文件不变 |
| 3 | 快捷键切换 | 运行中按 `alt+t` | thinking 块消失；再按恢复；`Ctrl+T` transcript 不受影响 |
| 4 | 流式隐藏 | 隐藏态发起新 turn | 流式期间无 thinking 渲染；切回后该轮 thinking 立即显示（数据未丢） |
| 5 | transcript 一致 | 隐藏态按 `ctrl+t` | overlay 同样无 thinking 块 |
| 6 | 持久化命令 | `/hide-thinking` | settings.json 写入 `hideThinkingBlock: true` |
| 7 | 回归 | 未设任何隐藏项 | 渲染与现状逐字节一致（thinking block 稳定 id 不变） |

## 6. 风险与边界

1. **键位冲突（已决策）**：`ctrl+t` 被 transcript overlay 占用，不改动；`alt+t` 无终端协议依赖。若未来需要贴近 oh-my-pi，需先给 transcript 换键再让出 `ctrl+t`——本计划不做。
2. **缓存正确性**：toggle 后若命中 `presentCache` 旧 blocks 会显示错乱——P3 的 revision/clear 是必须项，非可选。
3. **display-only 边界**：隐藏不省 token；`defaultThinkingLevel` 与 `/thinking` 选择器不受影响。向用户说明"隐藏 ≠ 关闭思考"。
4. **transcript 复制**：隐藏态复制 transcript 不含 thinking 文本（显示一致）；含思考的导出为后续项。
5. **workspace settings**：`hideThinkingBlock` 在 workspace 层同样生效（与 `thinkingLevel` 一致，无 recording 式 authority 限制）。
6. **`matchesKey` 扩展**：不引入 `ctrl+shift+t`，避免终端 ctrl/shift 不可分导致的误触发。
