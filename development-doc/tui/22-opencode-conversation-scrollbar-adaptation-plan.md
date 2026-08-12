# 22 · OpenCode 对话区垂直滚动条适配执行计划

> 状态：**候选实现完成，agent-verified；标准全局链接与 human-verified 待完成**
>
> 记录日期：2026-08-12
>
> RunLedger 基线：`session-owner-runtime@0b608b1e871d59fd540cec339121415ba657bde6`
>
> 实施工作树：`RunLedger-tui-scrollbar` / `worktree/tui-conversation-scrollbar`
>
> 候选实现提交：`a9e2486`（本地；未 push）
>
> OpenCode 参考基线：`dev@1882c33827cf0ce5c948b69ab5a87ed8f6790cf8`
>
> OpenTUI 基线：`@opentui/core@0.4.5`
>
> 实施入口：先固定当前行为与 RED，再建立用户级 TUI preference authority，最后接
> renderer、命令、CLI 与真实 TTY；不得从重写滚动容器开始。

## 0. 执行结论

RunLedger 已经使用 `ScrollBoxRenderable` 承载对话记录，并已具备 sticky bottom、
viewport culling、PageUp/PageDown、输入区/底栏滚轮转发、阅读历史时保持位置和新内容提示。
本专项不是“新造滚动系统”，而是把现有实现收敛为 OpenCode 的垂直滚动条产品形态：

1. 对话 timeline 继续是唯一可滚动区域，输入区、提示、footer 不进入滚动内容；
2. 继续只使用 `ScrollBoxRenderable` 内建 `verticalScrollBar`，不创建独立
   `ScrollBarRenderable` 或第二份位置同步；
3. 默认隐藏滚动条，用户通过 `/scrollbar` 显示或隐藏；选择跨 Session、跨启动保留；
4. 显示时为滚动条保留右侧空间，滑块不覆盖正文、Markdown、diff 或全宽分隔线；
5. 滑块尺寸、位置、轨道点击、拖拽与 `scrollTop` 双向同步全部交给 OpenTUI；
6. sticky bottom、向上阅读、新内容提示、鼠标滚轮、PageUp/PageDown 与 selection 行为保持；
7. 只持久化“是否显示”，不持久化 `scrollTop`、thumb 几何或 Session 阅读位置；
8. preference 是本地 TUI presentation state，不进入 Session Runtime、ledger、Trace、
   Host compatibility digest 或 workspace settings。

目标不是像素级复制 OpenCode，而是复用它已经验证的单一滚动 owner、显隐偏好、右侧留白和
内建滚动条思路，并保持 RunLedger 已有的 Runtime/TUI authority 边界。

### 0.1 2026-08-12 实施结论

SB0–SB6 已按 RED → GREEN 落地，SB7 的自动门禁和隔离候选 bin PTY 已通过；真实鼠标、正文
视觉不覆盖和流式向上阅读仍保留为真人验收。当前实现：

- `ScrollBoxRenderable` 仍是唯一滚动位置 owner；未创建独立 `ScrollBarRenderable`，未把
  `scrollTop` 写入 state、preference、Session、ledger 或 Trace；
- 默认 hidden，`/scrollbar` 通过既有 registry/action/reducer 链路切换；显示时为内建 bar
  保留右侧正文空间，track/thumb 使用当前 `theme.surface` / `theme.border`；
- `<runledgerHome>/state/tui-preferences.json` 只保存 versioned visible/hidden，目录 `0700`、
  文件 `0600`，使用 same-directory atomic rename 与 `proper-lockfile`；损坏、错误版本和保存失败
  都以 bounded result 降级；
- CLI 只加载一次 preference，并向每个 Session view 注入同一个进程 snapshot/port；
  `src/tui/**` 不拥有 layout/path 或文件系统 I/O；
- native OpenTUI 测试覆盖 track click、thumb drag、wheel、PageUp/PageDown、selection、capturing
  overlay、主题刷新、60 → 143 → 40 resize、reader position 与 10k history；
- `/scrollbar` 放在 registry 末尾，不改变既有 slash popup 首屏容量和 `/resume` 可见性。

当前验证边界：

| 项目 | 2026-08-12 新鲜证据 | 状态 |
|---|---|---|
| focused native | `npx bun test tests/tui/opentui-component-runtime.bun.test.ts`：36 pass / 187 assertions | pass |
| 完整 test | `npm test`：Vitest 294 files passed / 1 skipped、1702 passed / 3 skipped；Bun 51 pass / 266 assertions | pass |
| 静态门禁 | `npm run check` | pass |
| build | `npm run build`，含 Linux peer helper、TypeScript dist 与 Host build manifest | pass |
| 候选 bin PTY | 隔离 `RUNLEDGER_DIR` 下 60/80/143 列；hidden → visible → relaunch visible → hidden → relaunch hidden；overlay Esc 恢复；Ctrl+D 干净退出 | agent-verified |
| 真实 home 隔离 | 验证前后 `~/.runledger` 目录 mtime 均为 `2026-08-12 14:48:31.922976534 +0800` | pass |
| 标准 PATH provenance | `which runledger` 为 `~/.npm-global/bin/runledger`，验证时仍链接主工作区 `RunLedger`，未改指候选工作树 | pending publication |
| 真实鼠标/视觉/流式阅读 | 自动测试和 tmux 不代签 | human-verified pending |

OpenTUI native suite 仍可能打印既有的 `TreeSitter client destroyed` highlighting fallback warning；本次
完整命令退出码为 0，该 warning 在本专项基线即存在，不作为滚动条回归。

---

## 1. 文档权威、基线与并发边界

### 1.1 专项权威

| 领域 | 唯一权威 | Plan 22 的边界 |
|---|---|---|
| OpenTUI renderer、focus、resize、destroy | [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | 只调整既有 transcript `ScrollBoxRenderable` 的 presentation options |
| 流式、viewport culling、窗口化、性能 | [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | 保留现有 keyed renderable、sticky/new-content 与 10k history 证据 |
| TUI state/action/reducer/effect/port | [`19-passive-contract-integration-plan.md`](19-passive-contract-integration-plan.md) | 显隐进入既有 interaction state；不创建第二 store |
| slash registry 与派发 | [`20-codex-slash-command-adaptation-plan.md`](20-codex-slash-command-adaptation-plan.md) | `/scrollbar` 必须进入现有 registry/actionType，不手写旁路解析 |
| Storage canonical home | [`../storage-cli/02-user-home-migration-handoff.md`](../storage-cli/02-user-home-migration-handoff.md) | preference 只能位于注入的 `RunledgerLayout.state` 下 |
| OpenTUI 滚动能力参考 | [`reference/04-scrolling.md`](reference/04-scrolling.md) | 继续使用 `ScrollBox` 内建 bar，不引入外部位置 authority |

本计划只拥有“主对话 transcript 垂直滚动条”。Session/模型/权限/overlay/terminal/diff 等其他
滚动区域不跟随本专项批量改造。

### 1.2 计划基线与当前候选快照

计划冻结时（历史基线）：

- 当前分支：`session-owner-runtime`；
- 当前 HEAD：`0b608b1e871d59fd540cec339121415ba657bde6`；
- `@opentui/core`：`0.4.5`；
- OpenCode checkout：`dev@1882c33827cf0ce5c948b69ab5a87ed8f6790cf8`，检查时工作树干净；
- RunLedger 工作树已有其他任务的大量未提交修改，其中包括
  `src/tui/interactive-mode.ts`、`src/cli/main.ts`、两份 TUI 索引和扩展接线文件；
- 本次只创建/更新文档，不修改生产代码或测试；
- 2026-08-12 新鲜运行：
  `npx bun test tests/tui/opentui-component-runtime.bun.test.ts` 为
  `29 pass / 0 fail / 143 assertions`；
- 未在本次计划任务运行 `npm run check`、完整 `npm test` 或 `npm run build`，不得把上述
  focused 结果写成完整仓库门禁通过。

实施候选从 `0b608b1e871d59fd540cec339121415ba657bde6` 建立，位于独立工作树
`RunLedger-tui-scrollbar` 的 `worktree/tui-conversation-scrollbar` 分支。生产代码和测试已形成
本地提交 `a9e2486`；主工作区的并发文件没有被 stash、reset、checkout 或覆盖。当前门禁改读
§0.1 的 2026-08-12 新鲜证据，不再沿用上面的计划期 focused baseline。

实施前必须重新执行：

```bash
git status --short
git branch --show-current
git rev-parse HEAD
git diff --check
git diff -- src/tui/interactive-mode.ts src/cli/main.ts development-doc/00-index.md development-doc/tui/00-overview.md
```

若 `interactive-mode.ts` 或 `main.ts` 的并发改动还未形成可审阅边界，先完成当前任务的
commit/reconcile，再开始 Plan 22；禁止 stash、checkout、reset 或覆盖他人修改。

### 1.3 当前生产链路

```text
bin/runledger.js
  -> src/cli/main.ts
  -> InteractiveMode
  -> TUI.renderFrame()
  -> OpenTuiComponentRuntime.update(frame)
  -> ScrollBoxRenderable(runledger-transcript)
  -> internal verticalScrollBar
```

当前实现证据：

| 已有能力 | 当前入口 | 状态 |
|---|---|---|
| transcript 是独立 flex 滚动区 | `component-runtime.ts:154-166` | 已实现 |
| 输入区/footer 位于 transcript 外 | `component-runtime.ts:174-213` | 已实现 |
| sticky bottom | `stickyScroll=true`、`stickyStart="bottom"` | 已实现 |
| viewport culling | `viewportCulling=true` | 已实现 |
| 内建垂直滚动条 | `verticalScrollbarOptions={ position:"absolute", right:0 }` | 已实现，但覆盖正文且不可由用户显隐 |
| PageUp/PageDown | renderer keypress -> `scrollBy(..., "viewport")` | 已实现 |
| 输入区/footer 滚轮转发 | `onMouseScroll -> transcript.scrollBy(...)` | 已实现 |
| 阅读历史时不抢回底部 | `wasFollowing` + sticky 状态 | 已有 native test |
| 新内容提示 | `pendingNewContent` + `isAtBottom()` | 已实现 |
| 显隐 preference | 无 | 缺失 |
| 主题化 track/thumb | 无 | 缺失 |
| 滑块几何/拖拽回归 | 无专项断言 | 缺失 |
| 标准 CLI 加载/保存显隐 | 无 | 缺失 |

因为当前 `verticalScrollbarOptions` 没有显式 `visible`，OpenTUI 0.4.5 会在
`scrollSize > viewportSize` 时自动显示；它当前不是 OpenCode 的“默认隐藏 + 用户切换”。

---

## 2. OpenCode 参考实现审计

### 2.1 真实实现链

OpenCode 主对话滚动条位于：

- `packages/tui/src/routes/session/index.tsx`：
  - `kv.signal("scrollbar_visible", false)` 持久化显隐；
  - `<scrollbox ref={...}>` 是消息区唯一滚动 owner；
  - `viewportOptions.paddingRight = visible ? 1 : 0`；
  - `verticalScrollbarOptions.visible = visible`；
  - track 使用背景色，thumb 使用 border 色；
  - `stickyScroll=true`、`stickyStart="bottom"`；
  - session change、数据同步与提交后按需滚到底部；
  - command registry 中提供 `session.toggle.scrollbar`；
- `packages/tui/src/context/kv.tsx`：把 `scrollbar_visible` 写入 TUI `kv.json`；
- `packages/tui/src/util/scroll.ts`：仅负责滚轮速度/加速度，不拥有位置；
- `packages/tui/src/config/keybind.ts`：滚动命令映射到同一个 ScrollBox；
- `packages/tui/src/app.tsx`：renderer 负责鼠标捕获。

### 2.2 可复用与不复制

| OpenCode 行为 | RunLedger 取舍 | 原因 |
|---|---|---|
| 一个 `<scrollbox>` 包住全部消息 | 直接复用现有 `runledger-transcript` | 已有相同 owner |
| 默认隐藏、用户切换 | 采用 | 目标体验 |
| KV 保存 presentation preference | 采用等价的 canonical-home TUI preferences store | 避免进入 Runtime settings digest |
| 右侧 padding + bar 左间距 | 采用 | 防止覆盖正文 |
| track=element background、thumb=border | 映射为 `theme.surface` / `theme.border` | RunLedger theme 槽不同 |
| sticky bottom | 保留现有实现 | 已有流式和历史阅读证据 |
| ScrollBox 自算 thumb/drag | 直接依赖 OpenTUI | 禁止复制 slider 算法 |
| `scroll_acceleration` / `scroll_speed` | 本计划不接 | 属于独立滚轮体验设置，不是滚动条完成条件 |
| Home/End 全局跳首尾 | 不复制 | RunLedger composer 已使用 Home/End 移动光标 |
| PageUp/Down 的具体步长 | 保留 RunLedger 当前 viewport 语义 | 避免无关行为变更 |

本专项只参考行为和 OpenTUI public API 组合，不复制 OpenCode 的 KV、router 或组件源码。

---

## 3. 目标、不变量与非目标

### 3.1 用户可见目标

1. 第一次启动时滚动条隐藏，消息仍可用滚轮和 PageUp/PageDown 滚动。
2. 输入 `/scrollbar` 后，右侧出现主题化垂直轨道和滑块；再次输入后隐藏。
3. 显示状态在同一 canonical RunLedger home 的下一次启动和 Session 切换后保留。
4. 显示时正文不被覆盖；Markdown、CJK、宽字符、diff、run separator 均在有效 viewport
   宽度内重排。
5. thumb 长度表示 viewport/content 比例，thumb 位置表示当前 `scrollTop`。
6. 点击轨道、拖动 thumb、滚轮和 PageUp/PageDown 更新同一滚动位置。
7. 用户向上阅读时，流式内容不抢回底部；返回底部后恢复 sticky follow。
8. 滚动条隐藏/显示不改变 editor 文本、光标、overlay、Session 或 Runtime 状态。

### 3.2 架构不变量

1. **唯一位置 owner：** `ScrollBoxRenderable.scrollTop`/internal vertical bar 是唯一运行时
   位置 authority；不把位置写入 reducer、settings、Session、ledger 或 Trace。
2. **唯一内容 owner：** canonical Timeline 继续拥有消息行；滚动条不缓存或复制正文。
3. **纯 state：** reducer 只持有 `transcriptScrollbarVisible: boolean`，不持 renderer instance、
   callback、颜色、尺寸或鼠标事件。
4. **I/O 反转：** `src/tui/**` 不 import `node:fs`、layout 或 storage；CLI 注入
   `TuiPreferencesPort`。
5. **本地 presentation：** preference 不进入 Session Owner、Host protocol、settingsDigest、
   model context、trace recorder 或 workspace config。
6. **内建 bar：** 不实例化第二个 `ScrollBarRenderable`，不做 `scrollTop <-> thumb` 手工双写。
7. **持久 identity：** 切换显隐只 mutation 现有 bar/viewport options，不销毁重建 transcript，
   不丢 keyed body renderable 或 selection。
8. **主题投影：** state 只保存 visible；track/thumb 色从当前 Theme 每帧/主题切换时投影。
9. **失败可降级：** preference 读取损坏时回退 hidden 并报告有界 diagnostic；保存失败时
   当前进程仍可切换，但明确提示“未持久化”，禁止崩溃或无限重试。
10. **测试隔离：** 所有 storage/CLI/PTY 测试使用隔离 `RUNLEDGER_DIR`，不读写真实
    `~/.runledger`。

### 3.3 非目标

- 不引入 React/Solid `<scrollbox>`；RunLedger 继续使用 core renderable API；
- 不 fork、patch 或 vendor `@opentui/core`；
- 不实现外部独立 scrollbar、minimap、消息刻度或未读消息导航；
- 不持久化每个 Session 的阅读位置；
- 不改变 timeline replay、streaming delta、viewport window 或 render cache authority；
- 不同时改 sidebar、selector、permission、terminal、diff viewer 的滚动条；
- 不把 `scroll_speed`、`scroll_acceleration`、mouse enable/disable 混入本计划；
- 不覆盖 Home/End、Up/Down 的 composer 编辑语义；
- 不借本专项清理 Legacy Host、扩展接线或其他工作树修改。

---

## 4. 目标架构

### 4.1 Authority 图

```text
<runledgerHome>/state/tui-preferences.json
       |  versioned local presentation preference
       v
TuiPreferencesPort (injected by CLI)
       |
       v
InitialTuiStateInput.preferences
       |
       v
TuiInteractionState.transcriptScrollbarVisible
       |  pure action/reducer
       v
TUI frame projection + current Theme
       |
       v
ScrollBoxRenderable.verticalScrollBar.visible/style
       |
       +---- internal onChange/drag/wheel/key ----+
       |                                         |
       +----------- ScrollBox.scrollTop <---------+
```

`scrollTop` 不越过 OpenTUI boundary。`TuiState` 只表达显示偏好，使 presentation 可预测，但
不会成为滚动几何 authority。

### 4.2 为什么不用 `settings.json`

本计划选择 `<runledgerHome>/state/tui-preferences.json`，而不是向 `ProjectSettings` 添加字段：

- 当前 Host compatibility 的 `settingsDigest` 会 digest 整个 `ProjectSettings`；
- 把纯 UI 显隐混入其中，会让切换滚动条无意义地改变 resident Host compatibility；
- OpenCode 同样把该选择放在 TUI KV，而不是 provider/model Runtime config；
- `RunledgerLayout.state` 已是 canonical user home 下的本地状态根；
- preference 可删除、可回退默认值，不是 session/runtime 行为 authority。

若 Storage 专项明确要求所有用户 preference 必须进入 `settings.json`，应先拆出
`runtimeSettingsDigest(settings)` 的 allowlist projection，再改本计划；禁止直接扩大现有 digest。

### 4.3 Preference 合同

建议合同：

```ts
export interface TuiPreferencesDocument {
  readonly version: 1;
  readonly transcript: {
    readonly scrollbar: "hidden" | "visible";
  };
}

export interface TuiPreferencesPort {
  load(): Promise<TuiPreferencesLoadResult>;
  save(next: TuiPreferencesDocument): Promise<TuiPreferencesSaveResult>;
}
```

约束：

- 缺文件 = `hidden` 默认，不视为 error；
- 非法 JSON、错误版本、非法 union = 默认值 + typed diagnostic；
- 未知字段丢弃，不原样传播；
- 目录 `0700`、文件 `0600`；
- 写入使用 same-directory 临时文件 + atomic rename；
- 多 client 写入使用 `proper-lockfile`，锁内 reload/merge/write；
- 只允许已知 presentation 字段，明确拒绝/丢弃 `scrollTop`、path、sessionId、credential；
- 保存失败返回 `{ ok:false, code }`，不把绝对路径或原始 JSON投影到 TUI；
- active client 不监听文件变化；每个 client 当前状态独立，下一次启动读最后一次成功写入。

### 4.4 TUI state/action

建议窄改既有合同：

```ts
export interface TuiInteractionState {
  // existing fields...
  readonly transcriptScrollbarVisible: boolean;
}

export type TuiAction =
  // existing actions...
  | {
      readonly type: "interaction.transcript-scrollbar-set";
      readonly visible: boolean;
    };
```

- `createInitialTuiState()` 从显式 preference input 初始化；缺省 false；
- reducer 相同值返回原 state，不增加 generation；变化时只更新 interaction + generation；
- action 不触发 storage、render、clock 或 controller；
- 不增加 `scrollTop`、`atBottom`、`thumbSize` 等字段。

### 4.5 Renderer frame

在现有 `OpenTuiComponentFrame` 增加纯 presentation：

```ts
export interface TranscriptScrollPresentation {
  readonly visible: boolean;
  readonly trackColor: string;
  readonly thumbColor: string;
}
```

frame 更新时对同一个 transcript 执行：

```text
visible=false:
  viewport.paddingRight = 0
  verticalScrollBar.visible = false

visible=true:
  viewport.paddingRight = 1
  verticalScrollBar.visible = true
  verticalScrollBar.paddingLeft = 1
  track.background = theme.surface
  thumb.foreground = theme.border
```

实现时移除当前 `position="absolute", right=0` 的覆盖布局。bar 继续由 ScrollBox 内建
`onChange` 修改 content translate 与 sticky state；不得自己计算比例。

主题切换调用既有 `maybeSwitchTheme()` 后，同时刷新 editor 与 transcript appearance。颜色不进入
preference 文件，也不进入 reducer。

### 4.6 命令与交互入口

在现有 registry 增加：

```text
canonicalName = scrollbar
actionType     = ui.scrollbar.toggle
category       = ui
policy         = readonly/local
during task    = allowed
```

派发顺序：

1. 读取 `store.getState().interaction.transcriptScrollbarVisible`；
2. dispatch `interaction.transcript-scrollbar-set`；
3. 立即 request render；
4. 通过注入 port 异步保存完整 preference；
5. 成功不插入 timeline；失败显示一条 bounded note，当前进程状态保持。

`/scrollbar` 是唯一新增入口。本计划不声明尚未接通的用户 keybinding 配置；若实施时 keymap
workflow 已真正支持 user binding，再另增 `tui.transcript.scrollbar.toggle`，否则保持无默认快捷键。

---

## 5. 分阶段执行（SB0–SB7）

### 5.0 当前阶段状态

| 阶段 | 状态 | 证据摘要 |
|---|---|---|
| SB0 | implemented | 保留 29-test native baseline；新增 RED 曾因 visible/state/registry/store 缺失按预期失败 |
| SB1 | implemented | versioned store、sanitize、lock、atomic write、0700/0600、damage/symlink/concurrency tests |
| SB2 | implemented | initial preference、pure set/no-op reducer、generation 与 structured-clone contract |
| SB3 | implemented | 原生内建 bar、right inset、主题刷新、identity/selection/reader position |
| SB4 | implemented | `/scrollbar`、CLI single-load process snapshot、save-failure bounded note |
| SB5 | implemented | native track/thumb/wheel/PageUp/selection/overlay tests；真人鼠标体验仍 pending |
| SB6 | implemented | 10k history、60 → 143 → 40 resize、keyed body identity 与现有 performance observer 无回归 |
| SB7 | partial | check/test/build、候选 bin 隔离 PTY 通过；全局 link 未切到候选工作树，human verification pending |

### SB0：冻结 baseline 与 RED

**目标：** 先区分已有能力与真正缺口，避免把现有 sticky/wheel 重写坏。

任务：

1. 重跑并保留当前 focused native test 输出；
2. 在 `tests/tui/opentui-component-runtime.bun.test.ts` 增加 RED：
   - frame `visible=false` 时 bar 不绘制且 viewport 使用完整宽度；
   - frame `visible=true` 时 bar 在最右侧、正文不覆盖；
   - visible 切换不重建 transcript/body/editor；
   - theme 切换更新 track/thumb；
3. 在 application tests 增加 RED：初值、set action、same-value no-op；
4. 在 registry tests 增加 `/scrollbar` RED；
5. 在 storage tests 增加缺文件默认、round-trip、损坏文件和禁止 `scrollTop` 的 RED；
6. characterization tests 保留当前 sticky、wheel、PageUp/PageDown、新内容提示与 10k history。

退出门：新功能断言必须 RED，已有行为断言必须保持 GREEN；禁止先改实现再补测试。

### SB1：建立本地 TUI preference authority

**建议新增：**

- `src/tui/preferences/types.ts`：versioned document、load/save result、port；
- `src/storage/tui-preferences.ts`：canonical path、sanitize、lock、atomic write；
- `tests/storage/tui-preferences.test.ts`；
- `tests/tui/preferences-contract.test.ts`：structured clone/import boundary/no renderer/no Node I/O。

任务：

1. 固定 `join(layout.state, "tui-preferences.json")`；
2. 实现 missing/invalid/version mismatch 的确定性 fallback；
3. 写入前 lock，锁内重新读取并只合并已知字段；
4. same-directory 临时文件，成功 rename 后确认 mode；
5. error 结构只含稳定 code，不含用户 home 或文件正文；
6. 验证 user/workspace/session settings 都不是该 preference writer。

退出门：并发两次 toggle 不产生截断 JSON；权限、fallback、unknown-field 和 path containment 测试
全绿；`src/tui/**` 无 filesystem import。

### SB2：接入纯 interaction state

**修改：**

- `src/tui/application/{state,action,initial-state,reducer}.ts`；
- 对应 application tests；
- 必要的 public type-only barrel。

任务：

1. 初态从显式 `InitialTuiStateInput.preferences` 获得 visible；
2. reducer 增加 set action；
3. `TUI_ACTION_TYPES` 同步登记；
4. state structured-clone test 继续通过；
5. 明确断言 state 中没有 `scrollTop`/renderer/Theme/callback。

退出门：reducer 是纯函数；旧 action exhaustive test 全绿；无第二 state owner。

### SB3：把 frame 投影到内建 scrollbar

**修改：**

- `src/tui/opentui/component-runtime.ts`；
- `src/tui/primitives.ts`；
- theme/presentation 窄 adapter（若需要）；
- `tests/tui/opentui-component-runtime.bun.test.ts`。

任务：

1. constructor 初始化 bar 为 manual hidden，移除 absolute overlay；
2. `TUI` 像 editor appearance 一样保存/下发 transcript scroll presentation；
3. frame mutation 同步 visible、viewport padding、bar padding、track/thumb 色；
4. visibility/theme 相同的帧不做多余 style mutation；
5. 切换时保留 transcript instance、children identity、scrollTop 与 selection；
6. resize 后由 OpenTUI 重算 `scrollSize/viewportSize/slider`；
7. 关闭滚动条后 wheel/PageUp/PageDown 仍可用。

退出门：SB0 native RED 全绿；不出现外部 `ScrollBarRenderable`；现有 29 项 focused baseline 无回归。

### SB4：命令、composition 与持久化接线

**修改：**

- `src/tui/commands/registry.ts`；
- `src/tui/interactive-mode.ts`；
- `src/cli/main.ts`；
- registry、slash interaction、CLI composition tests。

任务：

1. 增加 `ui.scrollbar.toggle` 与 `/scrollbar`；
2. `InteractiveModeOptions` 接受 initial preference 与注入 port，不接受 layout/path；
3. constructor 把 initial preference 交给 `createInitialTuiState()`；
4. store subscription/state projection 驱动 TUI frame visible；
5. `maybeSwitchTheme()` 同步刷新 scroll appearance；
6. CLI 在 `resolveRunledgerHome()` 后、创建第一个 view 前加载一次 preference；
7. 每个 Session view 使用同一进程内 preference snapshot/port；toggle 成功后更新 snapshot，
   后续 `/new`、`/resume`、`/fork` 立即继承；
8. persistence 不进入 Host scope、settingsDigest、SessionRuntime options；
9. save failure 显示 note，不退出 TUI、不回滚当前 client 的 visible。

退出门：isolated `RUNLEDGER_DIR` 下 toggle -> quit -> relaunch 仍显示；Host compatibility envelope
在只改变 preference 时保持相同 digest。

### SB5：鼠标、键盘、sticky 与 selection 闭合

任务与 native tests：

1. thumb drag：从顶部拖到中部/底部，`scrollTop` 单调变化并被 clamp；
2. track click：移动 viewport，bar 与内容保持同步；
3. wheel：在 transcript、editor row、new-content row、footer 上均滚同一 transcript；
4. hidden：wheel/PageUp/PageDown 行为与 visible 时一致；
5. sticky：底部收到新内容继续跟随；向上滚后不跟随；回到底部恢复；
6. new-content indicator：向上阅读时新增行显示，回到底部清除；
7. selection：拖动 thumb 不产生正文 selection/OSC52 copy；正文 selection 仍可复制；
8. editor：Home/End/Up/Down 继续属于编辑器；PageUp/PageDown 不改变 draft；
9. overlay：capturing/nonCapturing overlay 开启时，不让 transcript bar 抢占其输入；
10. narrow/standard/wide：40/60/80/143 列下无覆盖、越界或负宽度。

退出门：使用 `@opentui/core/testing#createTestRenderer()` 的真实 native buffer/mouse driver；每个
renderer owner 在 `finally` destroy；不得用复制算法的 fake scrollbar test 代替。

### SB6：长会话、resize 与性能门禁

任务：

1. 保留 10,000 keyed history + viewport culling test；
2. visible toggle 不触发所有 Markdown 重建或 reparse；
3. resize 60 -> 143 -> 40 时 thumb/viewport 重新计算，reader anchor 不意外跳底；
4. 100 次流式 frame 下 bar 样式不重复分配无界对象；
5. pending markdown finalization、theme mode 与 visible toggle 同帧不泄漏旧布局；
6. 用 native stats/现有 performance observer 比较 hidden/visible 两种模式，记录 cells updated 与
   frame duration；不另建滚动 telemetry authority；
7. preference storage 只在启动和用户 toggle 时触发，render/scroll/frame 路径不得 I/O。

退出门：Plan 18 现有预算不退化；若 visible bar 导致结构化 Markdown 全量重建，停止并修正
frame mutation，不用扩大预算掩盖。

### SB7：标准 CLI、真实 TTY 与状态回写

自动门禁：

```bash
npm run check
npm test
npm run build
git diff --check
which runledger
npm ls -g --depth=0 | grep runledger
```

真实运行必须使用隔离 home：

```bash
RUNLEDGER_SCROLL_TEST_HOME="$(mktemp -d)"
RUNLEDGER_DIR="$RUNLEDGER_SCROLL_TEST_HOME" runledger
```

PTY/tmux 验收至少覆盖：

1. 初启无 scrollbar；
2. `/scrollbar` 后出现右侧轨道，正文不被覆盖；
3. 滚轮和 PageUp/PageDown 移动历史；
4. 真实鼠标拖动 thumb；
5. 流式输出时向上阅读不跳底；
6. 再次 `/scrollbar` 隐藏；
7. 退出后重启，显隐选择保留；
8. 60/80/143 列 resize 后外观正确；
9. Esc 逐级关闭 overlay、Ctrl+D 干净退出；
10. isolated home 中只新增预期 state 文件，真实 `~/.runledger` mtime 不变。

真实鼠标拖拽和视觉不覆盖必须由真人标记 `human-verified`；自动 tmux capture 只能作为
`agent-verified` 候选，不能代签。

完成后回写：

- 本文状态与 SB0–SB7 evidence；
- [`00-overview.md`](00-overview.md) 当前实现状态；
- [`../00-index.md`](../00-index.md) 路由；
- 若实现改变 reference 能力说明，再窄改 [`reference/04-scrolling.md`](reference/04-scrolling.md)。

---

## 6. 测试矩阵

| 层 | 必测项 | 证据 |
|---|---|---|
| pure schema | version/default/sanitize/unknown/forbidden fields | Vitest |
| storage | 0600/0700、atomic rename、lock、并发、损坏回退 | Vitest + temp layout |
| reducer | initial/set/no-op/generation/structured clone | Vitest |
| registry | 唯一名字、actionType、可见性、during-task | Vitest |
| native layout | hidden/full width、visible/right inset、theme、resize | Bun OpenTUI |
| native mouse | wheel、track、thumb drag、selection conflict | Bun OpenTUI mockMouse |
| native keyboard | PageUp/Down、draft unchanged、overlay routing | Bun OpenTUI mockInput |
| sticky | bottom follow、reader hold、reengage、indicator | Bun OpenTUI |
| long history | 10k children、culling、identity、frame stats | Bun OpenTUI + observer |
| CLI composition | isolated load/save/relaunch/session switch | spawn/PTY tests |
| real binary | linked `runledger`、tmux frame、real mouse | build + manual TTY |

禁止以 pure `scrollTop` 数学单测代替 native bar geometry，也禁止只看终端截图而不检查
renderable 的 scrollSize/viewportSize/scrollPosition。

---

## 7. 提交、回滚与工作树边界

### 7.1 建议提交序列

每个 commit 只暂存明确路径：

1. `test(tui): define transcript scrollbar behavior`
   - SB0 RED/characterization；
2. `feat(storage): keep TUI presentation preferences local`
   - preference contract/store/tests；
3. `feat(tui): preserve transcript space for an optional scrollbar`
   - state/frame/native bar/theme/tests；
4. `feat(tui): retain the user's scrollbar choice`
   - registry/InteractiveMode/CLI/persistence/PTY tests；
5. `docs(tui): record transcript scrollbar evidence`
   - 只在全部门禁后回写状态和证据。

提交前逐路径执行 `git diff -- <paths...>`、`git diff --cached --check` 和
`git diff --cached`。用户未明确要求时不 commit；未明确要求推送时不 push。

### 7.2 回滚单位

- preference 文件是可删除 presentation state；删除后回到 hidden 默认；
- schema reader 必须容忍实现回滚后遗留的未知文件，不影响 CLI 启动；
- renderer 回滚只恢复当前 auto-visible absolute bar，不触及 Timeline/Session；
- command 回滚不删除 preference 文件；
- 不通过修改 Session database、ledger 或 Host state 回滚 UI preference。

### 7.3 立即停止条件

出现以下任一情况必须停止当前阶段并拆项：

1. 需要 fork/patch OpenTUI 才能控制 visible、拖拽或 sticky；
2. 需要手工计算 thumb 并与 `scrollTop` 双向同步；
3. preference 必须进入 Host protocol、settingsDigest 或 Session event 才能工作；
4. 实现要求持久化 scrollTop 或绝对 terminal geometry；
5. visible toggle 会销毁 transcript、重建全部 Markdown 或丢 selection；
6. 真实 TTY 鼠标拖拽与 native test 不一致，且原因无法归入终端 capability；
7. `interactive-mode.ts`/`main.ts` 并发任务无法无损合并；
8. 测试必须访问真实 `~/.runledger`；
9. 完整门禁有既有失败但无法独立复现/归因；
10. 用户要求改变默认值或持久化 authority，足以改变本计划核心取舍。

---

## 8. 完成定义

### 8.1 Agent-verified

当前候选除“标准 PATH 链接到候选工作树”外已满足本节自动化定义；候选 bin 是从本工作树最新
`dist/` 启动。全局 `runledger` 的 provenance 仍指主工作区，因此不能把全局 linked smoke 写成
候选实现的通过证据。

- SB0–SB7 自动测试全部通过；
- `ScrollBoxRenderable` 是唯一 position owner；
- 默认 hidden、`/scrollbar` toggle、持久化与主题投影成立；
- track/thumb native geometry、drag、wheel、PageUp/PageDown、sticky、selection、resize 有测试；
- 10k history、streaming、Markdown identity 与新内容提示无回归；
- preference 不进入 Runtime/Host/Session/ledger/Trace；
- `npm run check`、完整 `npm test`、`npm run build`、linked CLI smoke 全绿；
- 所有 evidence 标明 HEAD、工作树、命令、日期与隔离 home。

### 8.2 Human-verified

当前状态：**pending**。以下项目必须由真人在真实终端中确认，自动 native mouse driver 与 tmux
frame 只作为候选证据。

- 真实终端中 bar 轨道/thumb 可辨但不抢视觉；
- 60/80/143 列正文无覆盖；
- 真实鼠标可拖动 thumb，选择文本仍自然；
- 向上阅读流式对话时无跳底；
- 用户确认默认 hidden 与 `/scrollbar` 入口符合预期。

### 8.3 不算完成

- 只有 `visible` 属性单测，没有真实 native frame/drag；
- 只有截图，没有 scrollPosition/viewportSize 断言；
- toggle 只在当前 frame 生效，重启丢失；
- 把 preference 写进 `settingsDigest` 后要求重启 Host；
- 隐藏 bar 后滚轮/PageUp 不工作；
- 自动测试代签真实鼠标与视觉验收；
- focused test 通过但完整 check/test/build 未运行。

---

## 9. 实施前清单

- [x] 重新核对 HEAD、branch、dirty paths 与 OpenTUI 版本
- [x] 以独立工作树解决 `interactive-mode.ts` / `main.ts` 并发修改边界
- [x] 保留现有 29 项 native baseline 并先写新 RED
- [x] 确认 default hidden 与 local TUI preference 取舍未被上游 ADR 改写
- [x] 只使用 `RunledgerLayout.state` 注入路径
- [x] 不把 scrollTop 放入 state/schema/session
- [x] 不创建独立 ScrollBarRenderable
- [x] 不覆盖 composer Home/End/Up/Down
- [x] native renderer 每个测试都在 finally destroy
- [x] CLI/PTY 只使用隔离 RUNLEDGER_DIR
- [x] 完整运行 check/test/build 与候选工作树 bin PTY smoke
- [ ] publication 时让标准 PATH 明确指向已接纳的候选提交并重跑 smoke
- [ ] 真人完成 drag/视觉验收后再标记完成

## 10. 参考文件

RunLedger：

- `src/tui/opentui/component-runtime.ts`
- `src/tui/primitives.ts`
- `src/tui/interactive-mode.ts`
- `src/tui/application/{state,action,initial-state,reducer}.ts`
- `src/tui/commands/registry.ts`
- `src/tui/theme/theme.ts`
- `src/storage/settings-manager.ts`
- `src/runtime/contracts/storage-layout.ts`
- `src/cli/main.ts`
- `tests/tui/opentui-component-runtime.bun.test.ts`
- `development-doc/tui/reference/04-scrolling.md`

OpenCode：

- `packages/tui/src/routes/session/index.tsx`
- `packages/tui/src/context/kv.tsx`
- `packages/tui/src/util/scroll.ts`
- `packages/tui/src/config/keybind.ts`
- `packages/tui/src/app.tsx`

OpenTUI 0.4.5：

- `/docs/components/scrollbox`
- `/docs/components/scrollbar`
- `/docs/core-concepts/testing`
- `/docs/core-concepts/keyboard`
