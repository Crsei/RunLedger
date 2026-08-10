# RunLedger Slash Command 适配计划（对照 codex-rs TUI）

> **状态：** `implemented`（P0–P6 已落地、完成自动门禁并随本次提交进入 HEAD；未据此扩张为额外人工验收）
>
> **创建日期：** 2026-08-09
>
> **参考实现：** [`codex-rs/tui`](../../../codex/codex-rs/tui/)（2026-08-09 工作树快照）
>
> **权威边界：** 本计划只拥有“`/` 命令输入、补全、派发与二级展示”这一条链路。
> renderer / OpenTUI / focus / overlay 的既有权威由
> [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) 与
> [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md)
> 继续拥有；被动合同接入权威由 [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md)
> 继续拥有；各领域 workflow（session / model / recovery / extension …）的行为权威属于
> 各自域实现，本计划只改“命令如何进入这些 workflow”的入口形态，不重写域逻辑。

## 0. 执行结论

codex 的 `/` 命令不是“一个弹出框”，而是**三层结构**，三层必须一起迁才成立：

1. **命令注册表** —— 单一命令事实源（名字/别名/描述/内联参数支持/可用性门控/展示顺序）；
2. **输入期弹窗** —— 编辑器文本变化驱动、按光标位置实时过滤、Tab/Enter/`/`/Esc 键交互的补全 popup；
3. **派发与二级展示** —— 选中后进入的确认/选择/设置视图（codex 的 `SelectionViewParams` + 各 `*_popups`）。

RunLedger 现状：`handleSubmit`（`src/tui/interactive-mode.ts:1156`）里有一个**提交后**的
`switch` 派发（相当于第 3 层骨架），`openSlashCommands`（同文件 `:648`）是**静态**
`SelectorModal`（只有 `/commands`、`/help` 能打开，无输入期触发、无过滤、无补全、无注册表），
命令清单在两处**重复手写**。三个缺口分别是：无注册表（命令事实源分裂）、无输入期补全
（`Editor` primitive 无真实光标/文本变更事件）、无统一二级展示组件（各 workflow 手写
`SearchableSelectorModal`）。

适配顺序：**先建注册表（P0），再补 Editor 输入能力（P1），再迁输入期弹窗（P2–P3），
然后统一提交/派发（P4），最后统一二级展示与门控（P5–P6）。**

## 1. codex 实现剖析（参考定位）

### 1.1 命令注册表 —— `tui/src/slash_command.rs` + `tui/src/bottom_pane/slash_commands.rs`

- `SlashCommand` enum：`strum(serialize_all = "kebab-case")`，**enum 顺序即 popup 展示顺序**
  （高频命令在前，注释明确禁止字母排序）；别名经 `#[strum(serialize = "...")]` 表达
  （`clean`→`stop`、`pet`→`pets`、`btw`→`side`）；
- `description()` —— popup 中每行右侧的用户可见描述；
- 三个门控方法：
  - `supports_inline_args()` —— `/review ...` 这类可带行内参数的命令；
  - `available_in_side_conversation()` —— side 会话内仍可用的命令；
  - `available_during_task()` —— 任务运行中是否允许执行（不允许的报
    `"/<cmd> is disabled while a task is in progress."`）；
- `is_visible()` —— 平台/构建条件可见性（debug 命令、Windows-only 命令）；
- `built_in_slash_commands()` —— `iter().filter(is_visible)` 产出 `(name, cmd)` 对；
- `bottom_pane/slash_commands.rs`：
  - `BuiltinCommandFlags` —— 特性门控位（collaboration_modes / connectors / plugins /
    token_activity / service_tier / goal / personality / elevate_sandbox / side_conversation）；
  - `builtins_for_input(flags)` —— 门控后可见内建命令；
  - `commands_for_input(flags, service_tier)` —— 内建 + `/model` 之后插入的动态
    service-tier 命令（动态命令注入点）；
  - `find_slash_command` / `find_builtin_command` —— 名字/别名精确查找（含
    `goooooal` 的 fuzzy 特例）；
  - `has_slash_command_prefix` —— fuzzy 前缀匹配，用于“光标是否在命令名编辑态”。

### 1.2 输入期弹窗 —— `chat_composer/slash_input.rs` + `command_popup.rs` + `chat_composer.rs`

**触发（被动同步，非按键弹出）：**

- `ChatComposer::sync_popups()` 在**每次文本/光标变化后**被调用
  （`chat_composer.rs:3722`）；
- `sync_command_popup(allow)`（`:3832`）决定 popup 可见性：
  - 前提：光标在首行、`is_editing_command_name`（`command_under_cursor` 解析首行
    `/name` 片段 + fuzzy 前缀命中）、非 bash 模式、`@`/`#` 文件与 mention popup 无优先权；
  - `dismissed_command_token` 记忆：Esc 关闭后同一命令 token 不再弹，token 变化才恢复；
  - 过滤串 `command_popup_filter_text(first_line, cursor)` = `/` + 光标前的名字片段；
  - `CommandPopup::on_composer_text_change(filter)` 实时更新列表与选中。

**过滤与展示（`command_popup.rs`）：**

- `filtered()`：空过滤 → 全量列表（**别名命令隐藏**：`ALIAS_COMMANDS` 只隐藏
  `quit`/`btw`）；非空 → **exact 匹配在前，prefix 匹配在后**，每组附带
  `Option<Vec<usize>>` 高亮索引（渲染时 `+1` 偏移跳过 `/`）；
- 每行 = `GenericDisplayRow { name: "/cmd", match_indices, description }`，
  列宽自适应（`ColumnWidthConfig::AutoAllRows`）+ 动态高度
  （`calculate_required_height` 考虑折行描述）；`ScrollState` 管理选中/滚动/
  `ensure_visible`；无匹配渲染 `"no matches"`。

**键位（`slash_input.rs::handle_key_event_with_slash_popup`）：**

- Up/Down、`Ctrl+p`/`Ctrl+n` —— 移动选中（wrap）；
- **Tab** —— 补全：支持内联参数的命令**保留草稿尾**（`/re` + `view the diff` →
  `/review view the diff`），其余 → `/cmd `；`/skills` 直接派发；
- **`/`** —— 视作“接受高亮命令为文本补全”；
- **Enter** —— 有选中：内联参数命令先补全再带参派发，其余直接派发
  （`InputResult::Command`/`CommandWithArgs`）；无选中回退默认换行处理；
- **Esc** —— 只关 popup 不动草稿，记录 dismissed token。

**提交验证：** `validate_submission` —— 首行 `/name` 无法解析出命令 → `UnknownCommand` 错误；
`queued_input_action` —— 任务运行中输入 `/` 开头 → `QueuedInputAction::ParseSlash`（延迟解析）。

### 1.3 派发与二级展示 —— `chatwidget/slash_dispatch.rs` + 各 `*_popups`

- `dispatch_command(cmd)`：side 会话检查 → 任务运行检查 → `match` 分派；
- 分派目标分两类：
  - **直接动作**：`AppEvent`（`NewSession` / `ArchiveCurrentThread` …）；
  - **二级展示**：`show_selection_view(SelectionViewParams { title, subtitle, footer_hint,
    items: Vec<SelectionItem { name, description, actions, dismiss_on_select }> })` ——
    通用确认/列表视图（如 `/archive` 的“Yes archive and exit”确认）；
- 典型二级展示：`model_popups.rs`（`open_model_popup` 自动模型 preset → `/model` 全量
  模型列表 → reasoning effort popup → advanced reasoning）、`settings.rs`（权限/网络/
  sandbox/personality/theme）、`permissions_menu.rs`、`goal_menu.rs`；
- 行内参数命令走 `dispatch_command_with_args`：`prepared_args` 解析 rest + offset，
  `args_elements` 把全文本元素范围平移为参数范围；
- 历史：选中即 stage 到本地历史（Up 键 recall），派发后统一 record。

## 2. RunLedger 现状与差距

| 能力 | codex | RunLedger 现状 | 缺口 |
| --- | --- | --- | --- |
| 命令事实源 | `SlashCommand` enum + 描述/别名/门控 | 无；命令表在 `openSlashCommands` items 与 `handleSubmit` switch 两处手写 | **无注册表，双写漂移** |
| 输入期触发 | 文本变化 → `sync_popups` | 仅 `Ctrl` 后提交解析；`/commands` 手动弹静态框 | 无光标/文本变化驱动的弹窗 |
| 过滤 | exact→prefix + 高亮索引 + 别名隐藏 | `SelectList.setFilter` 只做 includes 子串过滤，无高亮 | 弱过滤 + 无高亮 + 无别名概念 |
| 补全键 | Tab / Enter / `/` / Esc（dismiss 记忆） | 无 | 无补全 |
| 动态命令 | service-tier 注入 `/model` 后 | 无 | 无动态命令点 |
| 门控 | 特性位 + during_task + side 检查 | `rejectConfigWhileRunning` 部分近似 during_task，但散落 | 无统一门控模型 |
| 二级展示 | `SelectionViewParams` 通用组件 + 各 popup | 各 workflow 手写 `SearchableSelectorModal` / `SelectorModal`（样式可），无通用 `SelectionItem.actions` | 无通用确认/动作视图 |
| 历史 recall | stage 后 Up recall | `Editor.addToHistory` 空实现 | 可选 |

`Editor` primitive（`src/tui/primitives.ts:170`）当前能力：`text` + `onChange`/`onSubmit`
回调、无真实光标（`getCursor()` 是计算值，`setText` 整串覆盖、`handleInput` 只处理
enter/backspace/ctrl+u/可打印字符）。OpenTUI 的 `EditorView`（`@opentui/core`）具备
真实光标（`getCursor` row/col、`setCursorByOffset`），但本仓库 `Editor` 是自研 text model，
**适配以自研 `Editor` 为边界**，不引入 OpenTUI EditorView 状态（renderer 投影是
17/18 计划的地盘）。

## 3. 适配计划

### P0 命令注册表（事实源）

**目标：** 建立唯一命令描述符集合，`openSlashCommands` 与 `handleSubmit` 全部改为读注册表。

**新增文件：**

- `src/tui/commands/registry.ts` —— `CommandDescriptor`（复用 `commands/types.ts` 现有
  `CommandDescriptor`：`canonicalName / aliases / description / category / order /
  argumentSchema / policy`）+ `builtinCommandDescriptors()` 全量注册表
  （对照 codex enum 顺序：高频在前）+ `findCommand(name)`（别名解析）+
  `commandsForContext(context)` 门控过滤；
- `src/tui/commands/registry.test.ts` —— 别名/顺序/门控/无重复 canonicalName 测试。

**改动：**

- `interactive-mode.ts`：`openSlashCommands` 与 `handleSubmit` 的清单改为
  `registry.commandsForContext(...)` 驱动，行为不变（本期只换数据源，双写收敛）。

**验收：** `npm run check` + 新增单测全绿；`/commands` 弹窗内容与 `handleSubmit` 分支
完全一致（同源）。

### P1 Editor 输入能力增强

**目标：** `Editor` 具备 popup 同步所需的“文本变化 + 光标 + 首行 token”能力。

**改动：**

- `src/tui/primitives.ts` `Editor`：`getCursor()` 改为追踪真实光标（默认文本尾部；
  `setCursor` 公开方法；`handleInput` 在可打印字符/backspace/粘贴路径上维护）；暴露
  `onTextChange`（与现有 `onChange` 同语义，或直接复用 `onChange`——**不改 OpenTUI
  渲染路径**，仅补内部状态）；
- `src/tui/components/custom-editor.ts`：`handleInput` 在每个变更后触发
  `this.onChange?.(this.getText())`（当前 `setText` 已触发，补光标追踪调用点）。

**验收：** 既有 TUI 行为不变（onSubmit 路径不动）；`getCursor` 在编辑后正确反映尾部位置。

### P2 SlashCommandPopup 组件

**目标：** 对照 `command_popup.rs` 的过滤/高亮/滚动/动态高度，产出纯展示组件。

**新增：**

- `src/tui/components/slash-command-popup.ts` —— `SlashCommandPopup`：
  - `setFilter(filter)`：空 → 全量（隐藏别名 `quit`/`btw`）；非空 → exact 优先、
    prefix 其次，带 `matchIndices`（供高亮）；
  - `moveUp/moveDown`（wrap）+ 可见窗口 + `selectedItem()`；
  - 行 = `/name` + 高亮匹配段 + `  description`（复用 `SelectListTheme` 或新增
    popup 主题字段）；
  - `render(width)` 自适应高度（description 折行计入，上限 `maxVisible`）；
- `src/tui/components/slash-command-popup.test.ts` —— 过滤优先级/别名隐藏/
  exact 首选/滚动 clamp/空匹配文案（对照 codex `command_popup.rs` 测试用例）。

**不接键位**（键位在 P3 集成层）。

### P3 输入期集成（触发 + 键位）

**目标：** 输入 `/` 后输入期弹窗出现并随键入过滤，Tab/Enter/`/`/Esc 交互成立。

**改动：**

- `src/tui/components/slash-command-selector.ts`：从 `SelectorModal` 子类改为承载
  P2 popup 的 overlay 容器（或新建 `SlashInputOverlay`），由 `InteractiveMode` 挂
  `showOverlayModal(..., { anchor: "bottom-left", nonCapturing })` 贴合编辑器上方；
- `src/tui/interactive-mode.ts`：
  - `CustomEditor.onChange` 挂 `syncSlashPopup()`：首行 `/` + 光标在命令名内 →
    显示/更新 popup（filter = `/`+光标前片段）；Esc 关闭记录 dismissedToken，token
    变化才恢复；离开首行命令名 → 隐藏；
  - `CustomEditor.handleInput` 拦截 popup 激活期键位：Up/Down/Ctrl+p/Ctrl+n 移动；
    Tab 补全（`/cmd ` 或 `/review <保留草稿尾>`，按 `supportsInlineArgs`）；Enter
    派发（走 P4 派发层）；`/` 补全当前高亮；Esc 关闭；
  - `@` mention / 文件补全 popup 优先级：若既有此类 popup 激活则 slash popup 不抢
    （对照 codex `sync_popups` 优先级排序）；
- `src/tui/interactive-mode.test.ts`（或新测试文件）：模拟 editor 文本序列
  `/` → `/m` → `/mo` → Enter 的 popup 状态机（对照 codex
  `slash_popup_model_first_for_mo_ui` 等测试意图）。

**验收：** `/commands`、`/help` 仍可用（迁移为注册表入口）；输入 `/` 即时弹窗、
键入过滤、Tab 补全、Esc 关闭且同一 token 不重弹。

### P4 提交验证与派发统一

**目标：** `handleSubmit` 的 switch 收敛为注册表派发，未知命令/任务中命令/内联参数
三路径与 codex 对齐。

**改动：**

- `interactive-mode.ts`：
  - `handleSubmit` 改为：`findCommand(name)` → 无命中 `showNotice("Unknown command: …")`
    走**原 default 分支行为不变**；命中 → `CommandPolicy`/`rejectConfigWhileRunning`
    检查 → 统一 `dispatchCommand(desc, args)`；
  - `dispatchCommand` 内部按 `category`/`actionType` 路由到既有各
    `openXxxSelector` / `runDomainCommand` / workflow（**域逻辑不动，只换入口**）；
  - `commands/types.ts` 现有 `CommandDescriptor.policy` 字段启用为门控模型
    （`draft/history/query/frozen` 对照 codex `available_during_task` 语义）；
- `src/tui/commands/dispatch.test.ts` —— 已知/未知/内联参数/任务中禁用四路径。

**验收：** 所有既有 `/xxx` 行为逐条对照 `docs/` 操作手册不回归（回归清单在 §4）。

### P5 二级展示统一组件

**目标：** 对照 codex `SelectionViewParams` 提供通用确认/选择视图，替换手写模态的
公共部分。

**新增：**

- `src/tui/components/selection-view.ts` —— `SelectionViewProps { title?, subtitle?,
  footerHint?, items: SelectionItem[] }`，`SelectionItem { name, description?,
  dismissOnSelect, action?: () => void }`；渲染 = 标题 + 副标题 + SelectList + footer
  提示（对照 codex 确认框如 `/archive`）；
- `interactive-mode.ts`：`/archive`、`/delete` 类确认路径迁移到 `SelectionView`
  （当前若为弹窗式确认则替换，否则新增入口）。

**验收：** 确认视图 Esc/Enter 行为正确；footer 提示渲染不溢出窄终端。

### P6 门控与打磨

- 注册表补 `availableDuringTask` / `availableInSideConversation` 位（对照 codex
  `available_during_task` 全集），`rejectConfigWhileRunning` 收敛进注册表；
- `/commands` 弹窗隐藏 debug 类命令（`debug*` 前缀，对照 codex `CommandPopup::new`
  过滤）；别名命令仅在前缀命中时显示；
- 动态命令点：model service-tier（若后续接入）在 `/model` 之后插入；
- `Editor.addToHistory` 接通：选中/提交的 `/cmd` 记录供 Up recall（可选，若本期
  不做则在 §5 标 `deferred`）。

## 4. 回归清单（P4 完成时逐条过）

- `/sessions`、`/new`、`/resume [id]`、`/fork`、`/provider`、`/login`、`/logout`
- `/model`、`/thinking`、`/recovery [status|assess|verify|resume]`
- `/processes`、`/terminal`、`/mcp`、`/plugins`、`/skills`、`/hooks`
- `/plan`、`/compact`、`/memory`、`/remember <text>`、`/prompt`
- `/commands`、`/help`、`/clear`、`/quit`
- 未知命令提示、任务运行中配置命令被拒、内联参数保留

## 5. 不做 / deferred

- **OpenTUI EditorView 光标复用**：17/18 计划边界内，本计划不碰 renderer 投影；
- **fuzzy 匹配（非前缀）**：codex 有 `fuzzy_match`，RunLedger 先用 exact→prefix，
  后续可加；`gooooal` 特例不做；
- **history recall（Up）**：`Editor.addToHistory` 接通列为 P6 可选；
- **service-tier 动态命令**：模型能力落地后接，本计划只留注入点；
- **`!` shell 模式**：codex `queued_input_action` 有 `RunShell`，RunLedger 无 bash
  模式，本期不做。

## 6. 门禁

- 每阶段：`npm run check`（完整输出）全绿；相关 `npm test` 全绿；
- P3/P4 合并节点：手测 `/` 输入、Tab 补全、Enter 派发、Esc 关闭各 1 次；
- 本计划文档只读边界：不修改 17/18/19 的 authority 文件结构。

## 7. 实现记录（2026-08-10）

### 落地清单

- **P0 命令注册表** —— `src/tui/commands/registry.ts`：
  `builtinCommandDescriptors()`（24 条,顺序即展示顺序）/ `findCommand(name)`（canonical + 别名,
  help↔commands、quit↔exit）/ `commandsForContext(context)`（debug 位 + `debug*` 前缀门控）/
  `isCommandVisibleForContext` / `popupCommandsForFilter`（空过滤隐藏 `hiddenInFullList` 别名）;
  每条命令携带显式 `actionType`;`openSlashCommands`、`handleSubmit` 与 `dispatchCommand`
  不再靠 canonicalName 隐式配对;
- **P1 Editor 输入能力** —— `src/tui/primitives.ts` `Editor`:
  `getCursor()` 改由真实光标投影(`setCursor(offset)` 公开,code point 计);
  `handleInput` 在可打印字符/backspace/粘贴路径维护光标;`setCursor` 触发 `onChange`
  (对照 codex 光标变化也 `sync_popups`);`TUI` 增加 `getOverlay()` / `hasCapturingOverlay()`,
  `nonCapturing` overlay 不再拦截输入(路由给焦点组件);left/right/home/end 更新模型光标,
  `editorCursorOffset` 同步到 OpenTUI native textarea;
- **P2 SlashCommandPopup** —— `src/tui/components/slash-command-popup.ts`:
  `setFilter`（空→全量隐藏别名;非空→exact 前 prefix 后 + matchIndices 高亮,渲染 +1 偏移跳过 `/`）/
  `moveUp/moveDown`(wrap) / `selectedItem` / `render`(描述折行计入,上限 maxVisible,无匹配 "no matches");
  canonical 与 alias 作为独立候选参与过滤和补全,描述只渲染一次;
  `SelectListTheme` 新增可选 `matchHighlight` 槽;`slash-command-selector.ts` 改为兼容出口(薄代理);
- **P3 输入期集成** —— `interactive-mode.ts`:
  `onChange → syncSlashPopup()`(首行 `/` + 光标在命令名内 → 显示/过滤;离开命令名 → 隐藏;
  Esc 记 `dismissedCommandToken`,token 变化才恢复);
  `CustomEditor.onSlashPopupKey` 拦截弹窗激活期键位(Up/Down/Ctrl+p/Ctrl+n 移动;Tab/`/` 补全
  —— 内联参数命令保留草稿尾,其余 `/cmd `;Enter 派发并清空 composer;Esc 关闭);
  alias Tab 保留用户选中的 alias 文本;nonCapturing overlay 贴合编辑器;
- **P4 派发统一** —— `handleSubmit` 改为 `findCommand` → `dispatchCommand(desc, args)`:
  未知命令走原 default 行为;`availableDuringTask=false` 的命令在派发层统一拦截
  (provider/login/logout/model/thinking 保留原 "Configuration commands…" 文案;
  其余命令的任务中检查仍在各自 workflow 内,保证 §4 回归清单行为不变);
- **P5 SelectionView** —— `src/tui/components/selection-view.ts`:
  `title/subtitle/footerHint/items(SelectionItem{name,description?,dismissOnSelect,action?})`,
  标题 + 副标题 + SelectList + footer 提示,窄终端逐行截断;`dismissOnSelect` 在 action 前关闭;
  `/commands` 已迁移为生产消费方,不再只存在组件测试;
- **P6 门控与打磨** —— `availableDuringTask` / `debug` 位 / `hiddenInFullList` 别名位全部入注册表;
  `debug*` 前缀约定并入 `isCommandVisibleForContext`;`commandsForContext.dynamicCommands`
  会把动态命令稳定插入 `/model` 后。

### 与计划偏差

- `@` mention / 文件补全 popup 优先级:RunLedger 当前无此类 popup,
  条件不成立故未实现抢占逻辑(计划 §3 P3 为"若既有此类 popup 激活则…")。
- RunLedger 无 `/archive` `/delete`;P5 以 `/commands` 作为当前生产 SelectionView 消费方,
  后续确认类命令可复用同一组件。
- `availableInSideConversation` 位未加(RunLedger 无 side conversation 概念)。
- `Editor.addToHistory`(Up recall)按 §5 标 deferred。

### 门禁证据(2026-08-10)

- 修复前基线:`npm run check` 全绿;Vitest 全量 1583 passed / 3 skipped(277 files);
  bun-native TUI 38 pass / 0 fail。
- TDD 聚焦回归:5 files / 48 tests 全绿;覆盖 registry/actionType、alias/Tab、popup 描述去重、
  inline Enter 清空 composer、`SelectionView.dismissOnSelect`、模型/native 光标、动态命令插入与
  native popup 多候选投影。
- 修复后最终 `npm run check` 完整通过;`npm test` 为 Vitest 276 files passed / 1 skipped、
  1590 tests passed / 3 skipped,以及 Bun/OpenTUI 40 pass / 0 fail(195 assertions)。
- `npm run build` 通过;标准 PATH 的 `/home/nzq/.npm-global/bin/runledger` 经 `readlink -f`
  解析为本仓库 `bin/runledger.js`。
- 隔离 `RUNLEDGER_DIR` 的真实 PTY smoke 通过:`/c` 同时渲染 `/commands`、`/clear`、
  `/compact` 三个 native select 候选且描述各出现一次;`/co` 按前缀收敛为 `/commands`、
  `/compact`;Tab 补全为带尾随空格的 `/commands `;Enter 清空 composer 并打开生产
  `/commands` `SelectionView`;Esc 返回后 `/quit` 以 exit 0 退出。
- 本实现随本次提交进入 HEAD;上述证据只关闭本计划的实现与自动门禁,不替代其他权威文档中的
  独立审计、跨平台或人工验收门禁。
