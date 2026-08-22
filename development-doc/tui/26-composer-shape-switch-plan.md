# RunLedger TUI Composer Shape 切换实施计划

> 状态：`P0 source-backed / passed；P1–P4 source-aligned presentation adaptation；P5 partial / pending-human；P6 bounded trusted seam implemented；P7 single-scene setup wizard implemented`
>
> 计划日期：2026-08-22
>
> RunLedger 基线：`session-owner-runtime`，HEAD `b23b900`（`docs(tui): close shimmer acceptance evidence`）。
>
> oh-my-pi feature-bearing source audit：临时只读 checkout
> `/tmp/runledger-omp-audit.mGXVLu`，commit
> `81974fae4f1babf0a051f4ac9fb38645bdf7e450`，`@oh-my-pi/pi-tui` / coding-agent `17.4.1`，clean。
>
> 本文把该 feature-bearing source 的 Composer Shape 分层作为参考合同；RunLedger 的实现是
> source-aligned presentation adaptation，不复制 pi-tui 的继承关系或私有 editor API。
> §§8.1–8.7 保留旧 `v17.2.15` checkout 的历史 evidence，不能覆盖本次 source audit 的结论。

## 0. 执行结论与权威边界

本专项只负责输入区（composer）的 presentation shape：7 个内置 shape、选择/预览、用户级
持久化、运行时即时切换，以及 OpenTUI 下的窄宽度、光标、IME、滚动与 resize 行为。

最终用户路径为：

```text
/shape
  -> ComposerShapeSelector
  -> ComposerShapePreview（浏览时预览，不写 settings）
  -> Enter
  -> user settings: composer.shape
  -> InteractiveMode.syncComposerShape()
  -> TUI.setComposerShape()
  -> OpenTUI native composer adapter
```

本计划拥有以下 authority：

- `ComposerStyle` 的 framework-neutral 契约和 `ComposerChromeFrame` 行/区域模型；
- `box / claude / pi / borderless / rule / field / rail` 的内置实现与带回退 registry；
- `composer.shape` 的用户级设置 schema、选择器和运行时同步；
- 生产 composer 与选择器预览共用同一 `ComposerStyle` 对象和同一纯投影器。

本计划不拥有以下 authority：

- Session、ledger、Runtime replay、Host DTO、Trace、model context 或权限/执行语义；
- transcript 内容、Timeline、status indicator 的字段和动画调度；
- OpenTUI 的 renderer、Textarea 内部编辑模型、ScrollBox 的滚动位置 authority；
- 通用 `/settings` 框架、首次启动 setup wizard 和第三方 extension 的信任/加载策略。

既有文档继续持有其边界：

| 领域 | 继续有效的权威文档 | 本计划的接缝 |
|---|---|---|
| OpenTUI 核心与 renderer 生命周期 | [`17-opentui-refactor-plan.md`](17-opentui-refactor-plan.md) | 只增加 composer native adapter，不 fork 或 patch OpenTUI |
| 流式/resize/frame 调度 | [`18-opentui-streaming-performance-ux-plan.md`](18-opentui-streaming-performance-ux-plan.md) | shape 变化必须复用现有 frame/requestRender |
| slash command 输入与派发 | [`20-codex-slash-command-adaptation-plan.md`](20-codex-slash-command-adaptation-plan.md) | 增加 `/shape` descriptor，不重写 command registry |
| session display/status indicator | [`24-codex-session-display-replication-plan.md`](24-codex-session-display-replication-plan.md) | 保持 working/waiting indicator 的字段和行位置 |
| shimmer/status footer 颜色 | [`25-pi-working-loader-shimmer-replication-plan.md`](25-pi-working-loader-shimmer-replication-plan.md) | 复用结构化 footer/status 投影，不复制其动画引擎 |
| TUI 本地 presentation preference | [`22-opencode-conversation-scrollbar-adaptation-plan.md`](22-opencode-conversation-scrollbar-adaptation-plan.md) | `tui-preferences.json` 不成为 shape 的第二 authority |

### 0.1 当前事实与来源差距

截至本计划编写时，RunLedger 的生产链是：

```text
bin/runledger.js
  -> src/cli/main.ts
  -> InteractiveMode
  -> src/tui/primitives.ts (TUI frame facade)
  -> src/tui/opentui/component-runtime.ts (唯一生产 OpenTUI renderer)
```

当前 composer 是 `editorRow + editorPrompt + TextareaRenderable + footer`：

- `component-runtime.ts` 创建 `BoxRenderable` 的 `editorRow`，固定 prompt gutter、上下留白和
  `TextareaRenderable`，再创建独立 `footer`；
- `primitives.ts` 以 `OpenTuiComponentFrame` 投影 `editorText`、光标 offset、editor height、
  editor appearance 和结构化 footer；
- `interactive-mode.ts` 通过 `TUI` 和 `CustomEditor` 装配输入、提交、overlay、滚动与 footer；
- `settings-manager.ts` 的 canonical 用户配置是 `layout.settings`，当前为 JSON schema；
- `tui-preferences.json` 位于 `layout.state`，当前承载 transcript scrollbar 与 shimmer，且不应
  混入 Session/Runtime authority。

最新 source audit 在 `/tmp/runledger-omp-audit.mGXVLu` 的
`81974fae4f1babf0a051f4ac9fb38645bdf7e450` 中确认：

- `packages/tui/src/components/composer/` 包含 `types.ts`、registry 和 `box`、`claude`、`pi`、
  `borderless`、`rule`、`field`、`rail` 七个 builtin style；
- `packages/coding-agent/src/modes/components/composer-shape-registry.ts`、
  `composer-shape-preview.ts`、`settings-selector.ts` 和 `status-line/component.ts` 提供
  registry、共享 preview、selector 特判和 status-line 接缝；
- `packages/coding-agent/src/config/settings-schema.ts` 定义 `composer.shape`，
  `modes/interactive-mode.ts` 消费 style，`modes/setup-wizard/scenes/composer.ts` 提供
  `composer-shape` scene；
- source checkout 的 `packages/tui` 与 `packages/coding-agent` 版本均为 `17.4.1`，工作树 clean，
  origin 为 `https://github.com/can1357/oh-my-pi.git`。

因此 P0 已达到 `source-backed / passed`。P1–P4 的 RunLedger 代码按上述真实 source
语义做 presentation adaptation；它不等同于复制 source package，也不解除 P5–P7 的独立门禁。

### 0.2 当前 dirty worktree 边界

计划编写时 RunLedger 有与本专项无关的修改，必须保留：

```text
development-doc/00-index.md
development-doc/tuiz/02-welcome-page-plan.md
src/cli/main.ts
src/storage/settings-manager.ts
src/tui/components/logo.ts
src/tui/components/welcome.ts
src/tui/index.ts
src/tui/interactive-mode.ts
tests/storage/settings-manager.test.ts
tests/tui/logo.bun.test.ts
tests/tui/welcome.bun.test.ts
docs/architecture.md
```

本专项文档只允许新增本文和两个导航索引的最小 hunk。未来实现若与上述文件重叠，必须先读
working diff，再用 hunk-level staging；禁止 reset、stash、宽泛 `git add -A` 或把并行修改纳入
shape commit。

## 1. 目标、等价定义与非目标

### 1.1 最终目标

用户可以在运行中的 RunLedger TUI 中浏览并切换 composer shape：

- 默认 shape 是 `box`；
- 可选 `box / claude / pi / borderless / rule / field / rail`；
- `/shape` 的上下键浏览立即更新选择器底部预览，Esc 取消且不写配置；
- Enter 才提交到用户级 `layout.settings` 的 `composer.shape`，提交成功后当前 composer
  立即切换；
- 下一次启动、Session 切换和 renderer resize 后仍使用同一个有效 shape；
- 配置缺失、非法、扩展不可用或 registry lookup 失败时安全回退 `box`，不阻断 TUI 启动；
- 生产输入区和预览区都从同一个 `ComposerStyle` 对象生成，不允许两套布局算法漂移。

RunLedger 的 canonical JSON 形态冻结为：

```json
{
  "composer": {
    "shape": "box"
  }
}
```

设置路径在 TUI/command 层仍称为 `composer.shape`；不直接复制 oh-my-pi 的
`~/.omp/agent/config.yml` 路径或 YAML 格式。

### 1.2 非目标

- 不把 `ComposerStyle` 放进 Session event、ledger row、replay payload、Runtime/Host DTO、
  settings digest、model prompt 或 Trace；shape 是本地 TUI presentation；
- 不复制 pi-tui 类继承、私有 editor state、`Editor` 的原生布局实现或 OpenTUI 私有 API；
- 不新增第二个 editor、第二个 cursor/scrollbar owner、第二套 status line 数据源；
- 不为了 shape 重写 Timeline、ScrollBox、Textarea 编辑语义、slash popup 或 permission view；
- 不让 workspace settings 覆盖用户级 shape；不把 shape 写进现有 `tui-preferences.json`；
- 当前版本不实现第三方 extension shape 的动态加载、未受信任模块执行、远程 shape 描述或热卸载；
- 当前版本不实现 oh-my-pi 的完整通用 settings selector、settings schema UI 或 setup wizard；
- 不因本计划顺带修复当前 dirty worktree 的无关 check、视觉或 provider 问题。

## 2. 参考架构到 RunLedger 的映射

```text
ProjectSettings.composer.shape (string, default "box", user authority)
        |
        v
src/tui/composer/registry.ts
  getComposerShapeOptions() = BUILTIN +（未来受信任 extension）
        |
        +--> ComposerShapeSelector (/shape)
        |      onSelectionChange -> ComposerShapePreview
        |      onSelect -> ComposerShapeSettingsPort.save()
        |
        +--> InteractiveMode.syncComposerShape()
                  |
                  v
             TUI.setComposerShape(style/frame)
                  |
                  v
             ComposerFrameProjector(style, theme, state, width)
                  |
                  v
             component-runtime native adapter
               -> BoxRenderable / TextRenderable / TextareaRenderable
```

用户描述的 12 层在 RunLedger 中对应如下：

| 参考层 | RunLedger 落点 | 当前版本处理 |
|---|---|---|
| 渲染契约 | `src/tui/composer/types.ts` | 新增纯 `ComposerStyle`、`ComposerChromeContext`、`ComposerChromeFrame` |
| 7 个内置样式 | `src/tui/composer/styles/*.ts` | 新增 7 个纯样式对象，不能依赖 OpenTUI instance |
| 注册表/回退 | `src/tui/composer/registry.ts` | 内置立即实现；extension disposer 留 P6 |
| 编辑器消费 | `src/tui/opentui/component-runtime.ts`、`src/tui/primitives.ts` | 增加唯一 native adapter，保留 Textarea identity |
| 设置定义 | `src/storage/settings-manager.ts` | `ProjectSettings.composer.shape`，只允许用户级 authority |
| 运行时 options | `src/tui/composer/registry.ts` | 选项与 style 同源，保持注册顺序 |
| 生效同步 | `src/tui/interactive-mode.ts` | `syncComposerShape()` 只改 presentation |
| 设置选择器 | `src/tui/composer/selector.ts` | 复用现有 selector/overlay/focus 体系，入口为 `/shape` |
| 预览 | `src/tui/composer/preview.ts` | 与生产使用同一个 style 和纯 projector |
| setup wizard | `src/tui/setup-wizard/composer.ts` | 已接入单一 `composer-shape` scene；不宣称通用 provider/auth wizard |
| extension API | `src/tui/composer/extension-lifecycle.ts` + CLI composition seam | 已实现 TUI-local trusted lifecycle；第三方/Runtime/Host contribution 仍 deferred |
| 持久化 | `src/cli/composer-shape-settings.ts` + settings manager | `layout.settings` JSON；保存失败不改变当前/旧配置 |

### 2.1 oh-my-pi 参考源码地图（P0 已复核）

以下路径来自已固定的 feature-bearing commit `81974fae4f1babf0a051f4ac9fb38645bdf7e450`，
可作为 source evidence；旧 `06aecdd51f` checkout 的缺失项只保留在 §8.1–§8.7 的历史记录中。

| source 路径 | 关键职责 | RunLedger 对应策略 |
|---|---|---|
| `packages/tui/src/components/composer/types.ts` | `ComposerStyle`、`ComposerChromeContext`、side borders、vertical chrome、status attachment、bottom bar 和 render hooks | framework-neutral contract，改名/加字段必须先更新 frame signature |
| `packages/tui/src/components/composer/{box,claude,pi,borderless,rule,field,rail}.ts` | 7 个内置 style 的 glyph、padding、cursor tail、scrollbar 和底栏细节 | 逐个移植为 `src/tui/composer/styles/*.ts` 的纯 style，不复制 pi-tui inheritance |
| `packages/tui/src/components/composer/registry.ts` | builtin/extension lookup、重复保护、未知 id 回退 box | 对应 RunLedger registry；fallback 是启动安全边界 |
| `packages/tui/src/components/editor.ts` | `effectiveStyle()`、border visible、padding/gutter、cursor overflow 和 top-border provider | 不直接移植；由 OpenTUI `ComposerChromeFrame` adapter 投影 |
| `packages/coding-agent/src/config/settings-schema.ts` | `composer.shape` 默认值与 7 项 label/description/options | 对应 `ProjectSettings.composer.shape` 和 registry options |
| `packages/coding-agent/src/modes/components/composer-shape-registry.ts` | 一次安装 style + selector option，按 disposer 撤销 | RunLedger 只实现 bounded trusted TUI-local lifecycle，不接 Runtime/Host snapshot |
| `packages/coding-agent/src/modes/interactive-mode.ts` | 读取设置、切 editor border、按 attachment 配置 top border、更新 status line style | 对应 `InteractiveMode.syncComposerShape()`；top-border/top-rule-chip/none 语义必须保留 |
| `packages/coding-agent/src/modes/components/settings-selector.ts` | `composer.shape` 特判、runtime options、浏览预览、提交 settings | RunLedger 当前版本收窄为 `/shape` selector，不复制通用 settings framework |
| `packages/coding-agent/src/modes/components/composer-shape-preview.ts` | 用真实 style/theme/status 构造预览，不另写布局 | 对应 `ComposerShapePreview`，与生产共用纯 projector |
| `packages/coding-agent/src/modes/setup-wizard/scenes/composer.ts` | setup wizard 的 `composer-shape` scene | RunLedger 收窄为 `src/tui/setup-wizard/composer.ts` 单 scene，不复制完整 wizard |
| `packages/coding-agent/src/extensibility/extensions/{types,loader}.ts` 与 `modes/controllers/extension-ui-controller.ts` | definition 校验、注册、卸载 disposer | 先确认 RunLedger 的可信 authority，再决定是否启用 P6 |
| `SettingsManager` / `~/.omp/agent/config.yml` | 通用持久化 | RunLedger 只复用“用户级 settings”语义，落到 `layout.settings` JSON |

在 P0 中还要单独核对 `statusLine.setComposerStyle(style)` 的实际消费者：RunLedger 不得让
`FooterSnapshotProvider`、`StatusComponent` 和 composer style 各自产生一份 status 数据。

## 3. 冻结的设计决策

### D1：样式是纯 contract，不能直接创建 OpenTUI node

`ComposerStyle` 至少保留用户提供的这些字段和语义：

```ts
type ComposerShapeId = string;
type ComposerStatusAttachment = "top-border" | "top-rule-chip" | "none";
type ComposerBottomBar = "none" | "left" | "full";

interface ComposerStyle {
  readonly id: ComposerShapeId;
  readonly label: string;
  readonly description?: string;
  readonly sideBorders: boolean;
  readonly verticalChrome: 0 | 1 | 2;
  readonly statusAttachment: ComposerStatusAttachment;
  readonly bottomBar: ComposerBottomBar;
  readonly bottomBarGap: number;
  readonly defaultPromptGutter: number;
  defaultPaddingX(context: ComposerMeasureContext): number;
  sideChromeWidth(context: ComposerMeasureContext): number;
  renderTop(context: ComposerChromeContext): ComposerChromeRow | undefined;
  renderRow(context: ComposerChromeContext, row: ComposerInputRow): ComposerChromeRow;
  renderBottom(context: ComposerChromeContext): ComposerChromeRow | undefined;
  renderBottomBar(context: ComposerChromeContext): ComposerChromeRow | undefined;
}
```

实际实现可以细化签名，但必须保持以下不变量：

- `sideBorders` 决定左右 chrome 的保留列，并影响 prompt、IME、输入文本和 scrollbar 的有效宽度；
- `verticalChrome` 进入高度预算，不得通过事后裁剪隐藏边角；
- `statusAttachment` 决定现有 composer status 的 top-border / top-rule-chip / none 位置；
- `bottomBar` 和 `bottomBarGap` 决定编辑器下方的独立 status/usage bar 形态；
- `defaultPromptGutter`、`defaultPaddingX()`、`sideChromeWidth()` 必须按 terminal cell width 测量；
- `renderTop/renderRow/renderBottom/renderBottomBar` 只产生纯行模型，不读取 Agent、Session 或文件。

`ComposerChromeContext` 至少包含：可用宽度、当前输入行/占位文本、光标与 selection 信息、
scrollbar 状态、当前 status 内容、`borderColor`、`accentColor`、`surfaceColor`、box glyph
集合、top-border 状态内容和 terminal capability。`ComposerChromeRow` 采用可测量的 text/style
runs，不用包含 `BoxRenderable`、`TextRenderable` 或 `TextareaRenderable`。

### D2：先生成纯 frame，再由一个 native adapter 投影

新增的 `ComposerChromeFrame` 是 preview 与 production 的共同中间产物，至少表达：

- top/bottom chrome 行及其 display width；
- input content rectangle、prompt gutter、left/right chrome 宽度；
- cursor rectangle/overflow 压缩结果；
- scrollbar 轨道/滑块替换位置；
- status attachment、bottom bar 和 gap 的最终行预算。

预览使用 `renderComposerShapePreview(style, context)` 把 frame 转成纯文本/ANSI 行；生产使用
同一个 projector 的 frame 交给 `component-runtime.ts` 的 native adapter。禁止在 preview 中
重新实现 box、cursor、scrollbar 或 padding 计算。

### D3：RunLedger 的 status source 仍只有现有 Footer projection

当前 `Footer.present(width)` 产生 identity status line 和可选 usage status line；计划把它们
作为 `ComposerChromeContext` 的结构化 status 输入。`statusIndicator`（Working/Waiting/
Recovery required）仍按 Plan 24 位于 transcript 与 composer 之间，不因 shape 复制或重排。

`statusAttachment` 只改变 composer status 的位置和边框表达：

- `top-border`：status 进入顶部边框内容；
- `top-rule-chip`：status 进入带 chip 的顶部 rule；
- `none`：composer 不附着 top status；
- `bottomBar=left/full`：使用同一 Footer projection 形成编辑器下方的 left/full bar；
- `bottomBar=none`：不渲染独立 bottom bar，但不得产生第二个隐藏的 status data source。

每个内置 style 的 status 丢弃/保留规则必须在纯 contract test 中列出；窄屏优先保留
state/session/model 等既有 identity 字段，沿用 Footer 的结构化 fit 语义。

### D4：shape authority 是用户级 canonical settings

RunLedger 不采用 oh-my-pi 的 `~/.omp/agent/config.yml`，而采用现有 `RunledgerLayout`：

- user `layout.settings` 是唯一 `composer.shape` 写入点；
- workspace settings 即使出现 `composer` 也不能覆盖 user shape，最好在 storage 层给出有界
  `unsupported_setting`/diagnostic 并忽略；
- `tui-preferences.json` 继续只存版本化本地 presentation preferences，不增加 shape；
- shape 不进入 Session Owner、Runtime event、Host protocol、replay 或 settings digest；
- CLI composition 读取一次 user settings，向 `InteractiveMode` 注入初值和只写 user 的 port；
- TUI 不 import `node:fs`、`RunledgerLayout` 或 settings manager。

### D5：选择器的最小入口是 `/shape`

RunLedger 没有 oh-my-pi 的通用 settings selector 和 setup wizard，因此当前版本新增一个
`config.composer-shape` action type 与 `/shape` command descriptor：

- 命令清单、selector 选项、registry style 三者均来自同一 `getComposerShapeOptions()`；
- selector 使用现有 overlay/focus/cancel 约定和 `ListSelectionModal` 的导航语义；
- 需要预览 footer 时新增 `ComposerShapeSelector`，不要给每个 style 写一份 preview；
- `onSelectionChange` 只更新未提交的 `previewValue` 和 `ComposerShapePreview`；
- `onSelect` 先调用 settings port，成功后 commit 当前 id、关闭 overlay、调用 sync；
- Esc、Ctrl+C、保存失败均保留原已提交 shape；保存失败显示有界 notice，不抛出或重试。

以后若建立通用 `/settings`，它只能消费本 registry，不得复制一份 shape options。

### D6：registry 的 fallback 必须 fail safe

```ts
return extensionStyles.get(id) ?? BUILTIN_COMPOSER_STYLES[id] ?? boxComposerStyle;
```

registry 必须：

- 拒绝空 id、trim 后为空 id、重复扩展 id；
- 拒绝扩展覆盖 7 个 builtin id；
- `getComposerStyle(unknown)` 返回 `box`，同时产生可观测但不泄露配置原文的 diagnostic；
- `getComposerShapeOptions()` 保持 builtin 固定顺序，扩展按注册顺序追加；
- disposer 幂等，卸载后 options 和 lookup 都不再暴露已撤销 style。

配置非法、扩展被卸载、preview style 缺失时，不能让启动或当前会话进入无 composer 状态。

### D7：生产和 preview 的行为等价以 frame signature 验证

每个 preview frame 和 production frame 必须可导出不含颜色/renderer identity 的稳定 signature：

```text
shape id + terminal width + logical rows + chrome rows
  + input rect + prompt gutter + side chrome + cursor rect + scrollbar rect
  + status attachment + bottom bar + total height
```

preview 可以有自己的标题/提示包装，但 composer 预览本体不能与生产采用另一套 padding、
wrap、corner、cursor 或 scrollbar 算法。

## 4. 分阶段实施顺序（RED-first）

每个阶段都先提交能表达缺口的 RED 测试，再写最小实现；阶段之间按 P0 → P7 顺序，不允许
先把 7 个视觉样式散落进 native renderer 再补 registry 或持久化。

### P0：参考来源冻结、现状 inventory 与边界 RED

**目标：** 让后续执行可重复，明确用户描述的 source 是否真实存在，并锁定 RunLedger 当前
composer、settings、footer、OpenTUI 和 dirty worktree。

**任务：**

1. 重新记录 oh-my-pi source `git rev-parse HEAD`、tag/package version、clean status；搜索
   `ComposerStyle`、`composer.shape`、style files、registry、preview、loader extension hooks；
2. 若当前 source 不含功能，定位 feature-bearing commit/branch，记录其完整 hash 和相邻依赖；
3. 对 RunLedger 重新检查 `src/tui/primitives.ts`、`src/tui/opentui/component-runtime.ts`、
   `src/tui/interactive-mode.ts`、`src/storage/settings-manager.ts`、`src/cli/main.ts`、现有
   selector/command registry 与 native Bun tests；
4. 先添加失败的 contract placeholder tests：未知 style fallback、preview/production frame
   signature 缺失、非法 settings 不应被接受、当前 editor identity 应保持；
5. 把 source/target evidence 和新增测试文件列入本计划执行记录，不改任何 Runtime/Host 文件。

**P0 gate：** source commit 可重现或明确 `blocked-by-reference`；RunLedger inventory 与
`git status --short` 有快照；RED 测试确实因缺少 composer contract/adapter 而失败。若 source
仍不可固定，停止 P1–P7 的行为复制。

### P1：纯 ComposerStyle contract、frame model 与 7 个 builtin

**目标：** 在没有 OpenTUI import 的情况下建立可测试的样式层。

**新增/修改：**

- `src/tui/composer/types.ts`：shape id、style、measure/context、row/run、frame、status attachment；
- `src/tui/composer/styles/box.ts`、`claude.ts`、`pi.ts`、`borderless.ts`、`rule.ts`、
  `field.ts`、`rail.ts`；
- `src/tui/composer/registry.ts`：builtin map、options、lookup、validation、disposer seam；
- `tests/tui/composer/style-contract.test.ts`、`tests/tui/composer/registry.test.ts`。

**样式 DoD：**

- `box` 实现圆角框、top status attachment、底部边界合并、IME-safe cursor tail 和 scrollbar
  右侧替换语义；
- `claude` 实现 top rule + right status chip 的语义；
- `pi`、`borderless`、`rule`、`field`、`rail` 各自固定 glyph、side chrome、padding、bottom
  bar 与 status attachment，不以 box 的条件分支伪装成 7 个 id；
- 所有 style 在宽度不足时返回有界 frame，不产生负宽度、NaN、高度负数或未关闭 style run；
- 单元测试覆盖空输入、占位符、多行、CJK/emoji、滚动条开关、cursor at end、cursor middle、
  超长 prompt、width 1/2/3/20/40/80/143 和未知 id fallback；
- registry 选项顺序稳定，builtin id 不可被 extension 替换，disposer 幂等。

**禁止：** P1 不创建 Box/Text/Textarea，不触碰 settings、Session 或 production renderer。

### P2：OpenTUI native composer adapter

**目标：** 把当前固定 `editorRow` 布局收口为一个样式驱动 adapter，同时保留现有编辑器
identity、输入事件和滚动 owner。

**任务：**

1. 在 `src/tui/opentui/component-runtime.ts` 增加 composer host/adapter：输入纯
   `ComposerChromeFrame`，投影到现有 `BoxRenderable`、prompt `TextRenderable`、
   `TextareaRenderable`、footer/status `TextRenderable`；
2. 在 `OpenTuiComponentFrame`/`TUI` facade 增加最小的 `composerShape` 或 `composerFrame`
   presentation 字段，不让 `InteractiveMode` 直接操作 native nodes；
3. 按 style 的 `defaultPaddingX`、gutter、side chrome、vertical chrome 和 bottom bar 计算
   height/width；纯文本 editor height 仍由现有 `editor-height.ts`/native measurement 共同约束；
4. shape 切换只 mutate 现有 renderables 的 geometry/content/style，不能销毁/重建 Textarea，
   不能丢 draft、UTF-16 cursor、selection、focus、undo/redo 或 scrollTop；
5. 保留 `editorRow`、footer、new-content、status-indicator 的 mouse wheel forwarding，
   不把 transcript scroll position 放进 `ComposerChromeFrame` 的 durable state；
6. 以 display-cell width 处理 CJK、emoji、combining mark 和 ANSI，cursor overflow 的压缩顺序
   必须先减 padding，再减可压缩 rule，永不丢失必要角/竖线；
7. `statusAttachment=top-border` 使用 native adapter 的 top row/provider 等价物；
   `top-rule-chip` 使用独立 rule + chip row；`none` 清空 top attachment；不得把这三条分支
   退化为“始终渲染 box 顶边”；
8. resize 时重新测量同一个 style/frame，不改变 logical editor text 或 cursor offset。

**P2 RED/GREEN：** `tests/tui/opentui-composer.bun.test.ts` 使用
`createTestRenderer()`，每个测试在 `finally` destroy runtime/renderer；先证明当前固定布局不
满足 7 style 的 frame/geometry 断言，再实现 adapter。覆盖 identity、input event、cursor、
selection/OSC52、scrollbar、resize、overlay focus 和 shape 切换。

### P3：settings schema、CLI composition 与运行时同步

**目标：** 建立唯一持久化 authority，并让当前 TUI 能读取、保存、即时生效。

**任务：**

- `src/storage/settings-manager.ts` 的 `ProjectSettings` 增加 `composer.shape` 合同；
  `sanitizeProjectSettings` 只接受非空安全 shape id，非法值按 `box`/空 setting 规则处理；
- user settings 允许保存 `composer.shape`；workspace 层不得拥有 shape authority，增加 focused
  negative test，避免 workspace 值覆盖 user 值；
- 保留既有 provider/model/theme/logo/recap 等字段，save 采用现有 read-modify-write 端口，
  不覆盖并行 settings 字段；
- 新增 `src/cli/composer-shape-settings.ts`，提供只写 user `layout.settings` 的
  `ComposerShapeSettingsPort`，提交前验证 registry option；
- `src/cli/main.ts` 注入初始有效 shape、registry、settings port；TUI 层不接触 layout/path；
- `InteractiveModeOptions` 增加初始 shape/registry/port；实现 `syncComposerShape()`：读取有效
  id → registry lookup → 生成 frame → `ui.setComposerShape` → requestRender；
- unknown/invalid lookup 始终 box，并发一个不回显原始配置值的有界 notice/diagnostic；
- 保存失败时 selector 保持旧 committed shape，当前 native composer 不切换；保存成功后再 commit
  并同步，避免“看起来切换了但下一次启动回退”的假成功。

**P3 settings gate：** 缺失配置默认 box；非法 shape 不抛错；用户 settings round-trip；workspace
shape negative case；保存失败不污染文件、不泄露值；Session/ledger/replay snapshot 无 shape 字段。

### P4：`/shape` selector 与共享 preview

**目标：** 提供 RunLedger 当前版本的切换入口，完整复用 registry 和纯 frame projector。

**任务：**

1. 在 `src/tui/commands/registry.ts` 增加 `shape` descriptor，action type 为
   `config.composer-shape`，遵守现有 config command 的 idle/frozen policy；
2. 新增 `src/tui/components/composer-shape-preview.ts`，导出纯
   `renderComposerShapePreview` 和轻量 `ComposerShapePreview` component；预览只接 style、theme、
   固定 placeholder、示例 status、示例 cursor/scrollbar 和 width；
3. 新增 `src/tui/components/composer-shape-selector.ts`，复用现有 ListSelection 的键盘/取消/
   focus 约定，组合 shape list + preview footer；不复制 ListSelectionModal 的 wrap/navigation
   算法；
4. 上下键/PageUp/PageDown 浏览时仅改变 preview id，preview 本体由同一 `ComposerStyle` 和
   projector 生成；Enter 调 settings port，成功后关闭并调用 `syncComposerShape()`；Esc/取消
   恢复原 preview/current shape；
5. selector overlay 宽度/高度随 terminal resize 更新，窄终端先保证 shape preview、选中项和
   footer hint 可读，再截断描述；不会抢占 permission/credential/transcript capturing overlay；
6. `/commands`、直接输入 `/shape` 和未来通用 settings selector 必须从同一 command/option source
   读取，不允许第三处手写 7 项数组。

**P4 tests：** selector selection-change state machine、preview 不落盘、Enter 只保存合法值、
Esc 不保存、save failure restore、unknown registry fallback、resize 和 capturing overlay focus。

### P5：7 个 style 的 native/PTY 完整交互验收

**目标：** 不只证明纯文本像样，而是证明真实 OpenTUI composer 可用。

**自动 native cases：**

- 20、30、40、60、80、120、143 列下逐一渲染 7 个 shape；frame 总高度、左右边界、top/bottom
  row 和 textarea bounds 与 contract signature 一致；
- 空输入 placeholder、单行、多行、word wrap、硬换行、长 CJK、emoji、combining mark；
- cursor 在行首、行中、行尾、换行处、宽字符后；输入、退格、Enter、粘贴、提交和 draft 保持；
- Textarea 内滚动、composer 外 transcript wheel、OpenTUI scrollbar visible/hidden、滑块与
  side border 不重叠；
- status attachment 的 top-border/top-rule-chip/none、bottomBar none/left/full、gap 和
  status/usage 两行 fit；
- streaming/status indicator 更新时 composer 不重建、不失焦，shape 切换不改变 Timeline；
- resize 前后 editor text、cursor UTF-16 offset、selection、overlay state、scroll sticky
  语义保持；
- renderer destroy 后无 timer/listener/异步更新残留。

**真实 PTY/人工 cases：**

- 标准 `runledger` PATH 和隔离 `RUNLEDGER_DIR` 启动，确认 user settings round-trip；
- 真实 80/143 列 dark/light TTY 浏览 `/shape`，逐项确认边框 glyph、chip、底栏、placeholder；
- 真实终端 resize、鼠标滚轮、选区 Ctrl+C/OSC52、中文/emoji 输入；
- IME composition（至少在可用平台记录真实输入结果；无法提供真实 IME 环境时标为 pending，
  不用普通 ASCII 测试冒充 IME 验收）；
- 狭窄终端不崩溃、不出现负坐标、边框断裂、光标落在屏外或 footer 覆盖输入区。

自动 native/PTY 和人工视觉/IME 证据必须分栏记录，不能把 unit test 或一次 PTY smoke 写成
human-verified。

### P6：受信任 extension registration seam（bounded trusted seam implemented；third-party deferred）

**目标：** 仅在 RunLedger 现有 extension loader/UI controller 已提供可信生命周期后接入，
否则保持 builtin-only，不制造伪扩展能力。

计划中的 API 形态对齐用户提供的合同：

```ts
interface ComposerShapeDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly style: ComposerStyle;
}

installExtensionComposerShape(def): () => void;
```

必须校验 id 非空/trim、label 非空、style id 与 definition id 一致、拒绝覆盖 builtin、拒绝
重复注册；loader 安装时收集 disposer，extension 卸载时按注册顺序/逆序明确撤销。

P6 不允许：

- 在 import time 注册全局状态；
- 让不受信任 extension 直接执行 native renderer 或提供任意文件/网络能力；
- 把 extension shape 写入 Runtime/Host 或跨进程传播；
- 在没有真实 loader lifecycle 的情况下声称扩展选项已经可用。

P6 的 RED 先锁定 duplicate/builtin replacement/disposer/option ordering；若现有 extension
authority 不满足，测试保留为 deferred contract，生产只显示 7 个 builtin。

当前实现已提供 `TrustedComposerShapeSource`、`load/reload/dispose` 和真实 CLI/TUI composition
call site；source 只能由 first-party composition code 显式提供，当前生产 source 列表为空，故
仍只暴露 7 个 builtin。Runtime/Host ExtensionManager、用户 plugin manifest 和跨进程传播不在
本阶段 authority 内。

### P7：single-scene composer setup wizard（implemented；full wizard deferred）

当前生产入口是一个只负责 composer shape 的 `composer-shape` scene：

- options 必须直接来自 `getComposerShapeOptions()`；
- preview 必须调用同一 `ComposerShapePreview`；
- commit 必须复用 `ComposerShapeSettingsPort` 和 `syncComposerShape()`；
- wizard 不得另存 `tui-preferences`、workspace settings 或 session field；它不负责 provider/auth/
  credential onboarding。

完整通用 setup wizard 仍 deferred，但该单 scene 已由 `/setup` idle-only command 装配到真实
`InteractiveMode` overlay，并与 `/shape` 共享 registry、preview、settings port 和 sync path。

## 5. 测试矩阵与证据格式

### 5.1 测试文件建议

| 层 | 测试 | 主要断言 |
|---|---|---|
| contract | `tests/tui/composer/style-contract.test.ts` | 7 style frame、cell width、height、cursor、fallback |
| registry | `tests/tui/composer/registry.test.ts` | id 校验、builtin protection、重复/卸载、顺序 |
| settings | `tests/storage/settings-manager.test.ts`、新增 composer settings test | default、round-trip、非法、workspace 不覆盖、权限/损坏降级 |
| CLI port | `tests/cli/composer-shape-settings.test.ts` | read-modify-write、save failure、只写 user path |
| selector | `tests/tui/composer/selector.red.test.ts` | preview/commit/cancel/resize/focus/unknown |
| pure preview | `tests/tui/composer/preview.red.test.ts` | preview frame 与 production frame signature 等价 |
| native | `tests/tui/opentui-composer-shape-red.bun.test.ts`、`*-p5.red.bun.test.ts` | `createTestRenderer`、geometry、cursor、scrollbar、resize、identity |
| interaction | `tests/tui/composer/interactive-mode.red.test.ts` | `/shape`/`/setup` command、sync、save failure、overlay policy |
| PTY | `tests/cli/composer-shape-pty.test.ts` 或现有 TTY harness | 隔离 home、真实 CLI、settings round-trip、退出清理 |

### 5.2 RED-first 规则

每个实现阶段的第一条测试必须先在当前 HEAD 失败，并记录失败原因：

- 失败是缺少目标 contract/行为，而不是 import typo、fixture 路径错误或未清理 renderer；
- 不用 `toBeTruthy()`、截图存在或“没有抛错”替代几何/状态断言；
- native 测试都在 `finally` 销毁 renderer/runtime；
- 测试使用隔离 `RUNLEDGER_DIR`，不读写真实用户目录；
- 任何 broad gate 的既有失败必须单独记录，不能归因给 shape slice 或用修 unrelated code
  制造绿色。

### 5.3 运行门禁

实现完成后按风险逐级运行并记录 exact command、commit、环境和结果：

1. focused Vitest contract/registry/settings/selector；
2. focused Bun OpenTUI composer tests；
3. `npm run check`；
4. `npm test`；
5. `npm run build`；
6. `git diff --check`；
7. 隔离 `RUNLEDGER_DIR` 的标准 PATH CLI/PTY smoke；
8. 真实 terminal resize、mouse、Unicode、IME 与人工视觉 acceptance。

“自动测试通过”与“human visual/IME verified”必须使用不同状态。Bun/OpenTUI 退出时若发生
segmentation fault，应记为 runtime failure，不能计入 native pass。

## 6. 完成定义（DoD）

只有同时满足以下条件，才能把本专项标为 `implemented/accepted`：

- 参考 source commit、RunLedger target commit、工作树边界和实现 commit 可追溯；
- 7 个 builtin 都是独立 registry entry，都能被 selector 选择并在 preview/production 使用；
- preview 和 production 的 frame signature 对所有验收宽度一致，颜色差异不影响结构等价；
- 默认缺失、非法 id、未知/卸载 extension 都回退 box；启动和切换不崩溃；
- `composer.shape` 只在 user `layout.settings` round-trip，workspace、tui-preferences、Session、
  Runtime/Host/ledger/replay 均无 shape authority 或字段；
- Enter 保存成功后即时切换；Esc/save failure 不改变旧 committed shape；并发/无效 settings 不
  覆盖其他 settings 字段；
- composer shape 切换不丢 editor draft、cursor、selection、IME composing state、focus、
  transcript scroll 或 overlay；
- 窄宽度、CJK/emoji、长文本、scrollbar、status attachment、bottom bar、resize、dark/light
  和真实 PTY 均有相应 evidence；
- focused tests、Bun native、check、full test、build、diff check 和隔离 CLI smoke 状态已分开
  记录；人工视觉/IME 没有被自动门禁替代；
- 文档索引已更新，且实现没有顺带修改无关 dirty 文件。

## 7. 回滚、停止规则与提交边界

### 7.1 必须停止并回写本文的情况

- source feature commit 无法固定，或参考行为与用户提供的 12 层合同发生实质冲突；
- 需要 fork/patch OpenTUI 私有 API、复制 Textarea 内部编辑器或增加第二个 cursor/scroll owner；
- preview 只能通过另一套 layout 代码实现，无法共用 style/frame projector；
- shape 被写入 workspace、Session、Runtime event、Host DTO、Trace 或 settings digest；
- native resize/IME/cursor/scrollbar regression 无法在当前 renderer 公共 API 内收敛；
- extension loader 没有可信卸载生命周期却要求把 extension options 暴露给用户。

停止时保留 RED evidence 和 diagnostic，不通过降级为“静态 box 但标记完成”。

### 7.2 交付/commit 边界

建议每个实现阶段一个可回滚本地 commit，顺序为：

```text
P0 docs/tests baseline
P1 contract + builtin + registry
P2 OpenTUI adapter
P3 settings + CLI + sync
P4 /shape selector + preview
P5 native/PTY hardening
P6 extension seam（若获授权）
P7 docs/evidence closure
```

每次 commit 只 stage 本阶段明确路径；同文件有并行 dirty 修改时用 hunk staging。默认不 push。
计划初始编写时只创建计划和导航；后续实现请求应先在隔离工作树完成 P0，并按阶段单独提交。

## 8. 计划后的首个执行提示

> 历史 evidence scope：§8.1–§8.7 均基于旧 oh-my-pi `v17.2.15` checkout
> (`06aecdd51f07e689e970ceaa180abe2be0c14bbb`)。其中的 `P0 blocked-by-reference` 只描述
> 当时的 source inventory，不是当前 feature-bearing source audit 的状态；以下段落不删除，供审计
> 追溯旧结论和当时的 RunLedger 自动证据。

## 8.1 P0 执行记录（2026-08-21）

本次从 `session-owner-runtime@b23b900921f93a4755f0b7ac237855a39ea409b7` 建立隔离工作树：

```text
path: ../RunLedger-composer-shape
branch: worktree/composer-shape-switch
```

P0 参考来源检查结果：

- oh-my-pi source 为 `06aecdd51f07e689e970ceaa180abe2be0c14bbb`，tag `v17.2.15`，`git status`
  clean；`packages/tui/src/components/editor.ts`、`packages/coding-agent/src/config/settings-schema.ts`
  和现有 settings selector 存在，但 `ComposerStyle`、`composer.shape`、7 个 style 文件、registry
  和 `ComposerShapePreview` 不存在；`git log --all -G` 与 `git rev-list --all --objects` 也没有找到
  该 feature-bearing source commit 或路径。
- RunLedger target 当前使用 `@opentui/core@0.4.5`，生产 composer 仍是
  `editorRow + editorPrompt + TextareaRenderable + footer`；用户级 canonical settings 会清洗掉
  未知 `composer` 字段；当前 native runtime 没有 shape mutation seam。
- P0 RED 已保留在工作树：
  `tests/storage/composer-shape-settings.red.test.ts`、
  `tests/tui/composer/registry.test.ts`、
  `tests/tui/composer/frame-signature.test.ts`、
  `tests/tui/opentui-composer-shape-red.bun.test.ts`。
  设置 RED 的失败为当前返回 `{}`；registry/frame RED 的失败为目标 contract 缺失；Bun RED 的失败为
  `setComposerShape` 缺失。依赖仅通过工作树未跟踪 `node_modules` 链接复用，未修改 lockfile。

因此 P0 gate 当前为 `blocked-by-reference`，P1–P7 行为移植暂停；不得以 RunLedger 计划合同或相似
Editor API 冒充 oh-my-pi feature-bearing source。继续 P1 前必须提供/定位包含该功能的完整 source
commit（或明确授权改为独立合同实现并解除本计划的参考来源停止规则）。

开始实现时，执行者应先完成以下可复制的 P0 检查：

```text
1. 在 oh-my-pi 中固定 feature-bearing commit；若不存在，停止并记录 blocked-by-reference。
2. 在 RunLedger 中重新检查 git status、HEAD、OpenTUI 版本、settings authority 和 native test harness。
3. 先写并运行 composer contract/registry/settings 的 RED tests。
4. 只在 RED 证明目标缺口后创建 src/tui/composer/，不要先改 component-runtime.ts。
5. 每个阶段完成后只报告该阶段的 focused、native/PTY、full gate 和 human gate 状态。
```
## 8.2 本次独立合同实现记录（2026-08-22）

P0 参考来源复核结果保持不变：oh-my-pi 的 06aecdd51f07e689e970ceaa180abe2be0c14bbb
（v17.2.15）工作树干净，但该 checkout 及其可达历史仍没有
ComposerStyle、composer.shape、7 个 style 文件、registry 或
ComposerShapePreview。因此本节记录的是 RunLedger 自己的 presentation contract
实现，不是 oh-my-pi 行为移植或等价证明；P0 状态仍为 blocked-by-reference。

在该边界下，本次隔离 worktree worktree/composer-shape-switch（HEAD
b23b900）完成了以下独立合同切片：

- P1：7 个 framework-neutral composer style、纯 frame projector、preview/production
  signature、registry fallback 和 extension definition 校验；
- P2：唯一 OpenTUI native adapter，shape 切换复用同一个 Textarea，保留 draft、cursor、
  selection、focus 和滚动 owner；
- P3：用户级 layout.settings 的 composer.shape schema、CLI
  read-modify-write port、初始读取和运行时同步；workspace、Session、Host、
  Runtime、ledger/replay 和 settingsDigest 不拥有 shape；
- P4：/shape command、7 项 selector、共享 preview、Enter 提交、Esc 取消和保存失败
  回滚；未知或非法 id 安全回退 box，不回显原始配置值。

上述 P1–P4 只能标记为当前 worktree 的独立合同实现，不能提升 P0，也不能标记本专项为
implemented/accepted。P5 的完整 native/PTY/Unicode/resize/IME/人工视觉矩阵、
P6 的真实受信任 extension loader 生命周期和 P7 的 setup wizard 仍未闭合。

## 8.3 本次 fresh evidence（2026-08-22）

以下证据均来自当前 worktree，不能替代参考来源或人工验收：

- composer focused：12 个 Vitest 文件 / 54 个测试，加上 1 个 dedicated native composer
  文件 / 8 个测试；合计 13 个文件 / 62 个测试全绿；
- npm run check：完整通过；
- npm test：Vitest 454 files passed / 1 skipped、2764 tests passed / 3 skipped；
  其内 native phase 135 passed / 0 failed；退出码 0；
- npm run test:tui-native：135 passed / 0 failed，18 个文件；
- npm run build：退出码 0；
- git diff --check：通过；
- 全局链接仍指向当前 worktree 的 dist bin。隔离 RUNLEDGER_DIR 下 runledger --version、
  --help 成功；真实 tmux TTY 打开 /shape 后显示 7 个选项和 Preview: Box，选择 Claude
  并 Enter 后，隔离 settings.json 持久化为 {"composer":{"shape":"claude"}}，随后通过
  Ctrl+D 干净退出。

尚未完成或不得宣称完成：

- 没有找到可固定的 oh-my-pi feature-bearing source commit，P0 继续
  blocked-by-reference；
- P5 的全宽度/全 shape 真实 PTY、resize、鼠标、Unicode、IME、dark/light 和人工视觉
  验收仍 pending；本次 TTY smoke 只证明入口、选择、持久化和退出链；
- extension loader、setup wizard 仍是 deferred；
- 不把 focused/full/native 自动测试或上述 smoke 写成 human-verified，也不标记
  implemented/accepted。

本次文档更新不创建 commit、不推送；代码 dirty worktree 中的其他路径保持原样。

## 8.4 本次 P5/P6/P7 续审证据（2026-08-22）

8.3 是本轮之前的 evidence snapshot；以下记录本次继续执行后的增量，不提升 P0 的参考来源
状态，也不替代人工验收。

### P5：native/PTY 自动证据增加，但仍未接受

新增 `tests/tui/opentui-composer-shape-p5.red.bun.test.ts` 的 native matrix 现在为 6 tests、
1,639 assertions 全绿，覆盖：

- 7 个 builtin 在 20、30、40、60、80、120、143 列的 frame/native bounds、Unicode、emoji、
  combining mark、硬换行和宽度上限；
- 同一个 native Textarea 的输入、paste、resize、shape 切换、draft/cursor/focus 保持；
- streaming body 与结构化 status 更新不重建 editor，shape 切换后 overlay 打开/关闭仍恢复
  editor focus；
- composer scrollbar visible/hidden 切换、borderless 输入宽度、right rail 与 textarea 的
  不重叠边界，以及 composer 区 wheel 到 transcript 的路由；
- cursor 行首、行中、换行处、宽字符后、native 内部滚动、Enter 输入事件、capturing overlay
  focus 和 runtime destroy 后 renderer 销毁。

新增 `tests/cli/composer-shape-pty.test.ts` 的标准 PATH PTY 证据通过：隔离
`RUNLEDGER_DIR`，80/143 列各按当前选中项环形浏览 7 个 shape，最终 settings 为
`{"composer":{"shape":"rail"}}`，并以 Ctrl+D 退出。测试在发送 `/shape`/导航键前建立输出监听，
等待 selector 的当前 preview 完整绘制，并等待 resize/异步保存收敛；这是为适配 OpenTUI 的
差分 ANSI redraw，避免把“光标定位分片尚未合并”误报为产品失败。

P5 仍保持 `partial / pending-human`：尚无 dark/light 的逐项人工视觉记录、真实鼠标/选区
PTY 记录、真实 IME composition 记录；自动 native/PTY 不能填写 `human-verified`。

### P6/P7 审计结论

只读审计确认：

- `src/tui/composer/registry.ts` 已有 builtin protection、duplicate protection、稳定 option
  ordering 和幂等 disposer 合同，`tests/tui/composer/registry.test.ts` 覆盖这些合同；
- `src/extensions/manager.ts` 当前只管理 Plugin/Hook/MCP 与 Skill discovery snapshot、trust、
  reload 和 turn lifetime；仓库中没有把 `installExtensionComposerShape()` 接入该 loader 的
  production call site，也没有 composer-shape extension definition/module loader；
- 当前 `src/tui/` 没有 `setup-wizard/` 目录或生产 wizard scene。故 P6 的真实受信任 extension
  lifecycle 与 P7 的 setup-wizard scene 继续 deferred，不用 registry 的 passive seam 冒充
  生产扩展能力。

当前专项最终状态为：P0 `source-backed / passed`；P1–P4 为 RunLedger 独立 presentation
contract；P5 `partial / pending-human`；P6 `bounded trusted seam implemented / third-party
contribution deferred`；P7 `single-scene composer setup wizard implemented`。由于 P5 仍缺少
人工验收，本专项整体不标记 `implemented/accepted`。

## 8.5 本次 fresh source/native/PTY evidence（2026-08-22）

本次再次固定并审计参考 source：

- `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi` 的 `HEAD` 仍为
  `06aecdd51f07e689e970ceaa180abe2be0c14bbb`，exact tag 为 `v17.2.15`；
  `packages/tui/package.json` 与 `packages/coding-agent/package.json` 都是 `17.2.15`，工作树
  clean，origin 仍为 `https://github.com/can1357/oh-my-pi.git`；
- 当前 checkout、全部本地 refs、远端 heads、`git log -S/-G` 和 object path inventory
  仍找不到 `ComposerStyle`、`composer.shape`、7 个 style 文件、registry、
  `ComposerShapePreview` 或 composer-shape extension loader；没有可固定的 feature-bearing
  source commit，P0 继续 `blocked-by-reference`。

当前 target worktree 仍为 `worktree/composer-shape-switch`、HEAD `b23b900`；既有 dirty 边界
未被清理、提交或推送。本轮没有修改代码，也没有把 source audit 结果当作 oh-my-pi 等价证明。

fresh gate 结果沿用本次继续执行后的完整输出：

- `npm run build`、`npm run check`、`git diff --check`：通过；
- `npm test`：Vitest 455 files passed / 1 skipped、2765 tests passed / 3 skipped；其中 Bun
  native phase 141 passed / 0 failed、2740 assertions；
- 标准 PATH、隔离 `RUNLEDGER_DIR` 的 PTY：80/143 列均完成 7 个 shape 的环形浏览，最终
  `rail` 写入隔离 `settings.json`，Ctrl+D 退出码为 0；selector 回归已等待目标 shape 文本和
  启动/异步保存收敛，以适配 OpenTUI 的差分 ANSI redraw。

P5 仍为 `partial / pending-human`：没有 dark/light 逐项人工视觉记录、真实鼠标/选区 PTY
记录或真实 IME composition 记录。已有自动测试覆盖 native selection/OSC52、主题事件、
wheel、cursor、scrollbar、resize、Unicode、Textarea identity 和 overlay focus，但这些不能
填写 `human-verified`。P6 的可信 extension loader 与 P7 的 setup wizard 仍不存在真实生产
authority，继续 `deferred`；专项状态保持 P0 `blocked-by-reference`、P1–P4 独立合同、P5
`partial / pending-human`、P6/P7 `deferred`，不标记 `implemented/accepted`。

## 8.6 本次 composer chrome hardening fresh evidence（2026-08-22）

本节记录 8.5 之后的增量；它仍不改变参考来源、生产扩展 authority 或人工验收状态。

- `src/tui/opentui/component-runtime.ts` 已补齐 composer host、上下 chrome surface、bottom
  bar 与 right rail 的 transcript wheel forwarding，并在 theme 事件中同步重绘 composer host
  和 chrome surface 背景。RED 先证明 chrome wheel 不再改变 transcript reader position，以及
  theme repaint 不应回落到默认黑色背景，随后才保留最小修复。
- `tests/tui/opentui-composer-shape-p5.red.bun.test.ts` 现为 9 tests、1,655 assertions 全绿，
  覆盖 chrome wheel、dark/light repaint、draft/native conversation selection/OSC52、
  Textarea identity、resize、streaming、scrollbar、cursor、Enter 与 overlay focus。
- 完整门禁重新通过：`npm run check` 退出码 0；`npm test` 为 Vitest 455 files passed / 1
  skipped、2,767 tests passed / 3 skipped，随后 Bun native 为 144 pass / 0 fail、2,752
  expect() calls，整体退出码 0；`npm run build` 退出码 0；`git diff --check` 通过。
- 标准 PATH 的 `runledger` 链接确认指向当前 worktree 的 `bin/runledger.js`。在隔离
  `RUNLEDGER_DIR` 下再次运行 `tests/cli/composer-shape-pty.test.ts`，80 与 143 列均完成 7
  个 shape 的环形浏览，最终 `settings.json` 保存 `composer.shape=rail`，Ctrl+D 退出码为 0。

P5 仍为 `partial / pending-human`：本次增加的是自动 native/PTY 证据，仍没有 dark/light
逐项人工视觉记录、真实鼠标/选区 PTY 记录或真实 IME composition 记录，因此不能填写
`human-verified`。P0 继续 `blocked-by-reference`；P1–P4 继续是 RunLedger 独立
presentation contract；P6 的可信 extension loader 和 P7 的 setup wizard 继续
`deferred`，不标记 `implemented/accepted`。

## 8.7 本次 P6 fail-safe 与 PTY resume fresh evidence（2026-08-22）

本节记录 8.6 之后的增量；它仍不解除 P0 source blocker，也不把自动证据写成真人验收。

- P6 registry RED 先复现 malformed runtime definition 直接抛出 `TypeError` 的缺口；最小
  修复后，`installExtensionComposerShape()` 对 null、非字符串 id/label、缺失或 malformed
  style、非法 description 均返回 bounded `invalid_registration`，不改变 builtin/options，且
  通过完整 style contract 校验后才保存 immutable definition。`tests/tui/composer/registry.test.ts`
  现为 8 tests 全绿。
- 标准 PATH PTY 测试扩展为重启恢复断言：同一隔离 `RUNLEDGER_DIR` 第一次完成 80/143 列的
  7-shape 环形浏览并保存 `rail`；第二次真实启动后打开 `/shape`，selector 首屏显示
  `Preview: Rail`，随后 Ctrl+D 退出码为 0。测试等待 startup/redraw 收敛后再发送命令，以
  避免 OpenTUI 差分 ANSI 输出的时序误报。
- focused composer gate：Vitest 11 files / 31 tests 全绿；Bun focused 17 tests / 1,732
  assertions 全绿。
- 完整门禁：`npm run check` 退出码 0；`npm test` 为 Vitest 455 files passed / 1 skipped、
  2,768 tests passed / 3 skipped，Bun native 144 pass / 0 fail、2,757 `expect()` calls，
  整体退出码 0；`npm run build` 退出码 0；tracked 与 untracked 文件的 whitespace check
  均通过。

当前状态仍为：P0 `blocked-by-reference`；P1–P4 为 RunLedger 独立 presentation contract；
P5 `partial / pending-human`（仍缺逐项 dark/light 人工视觉、真实鼠标/选区 PTY 与 IME
composition 记录）；P6 registry 只有被动安全合同，可信生产 extension loader 未接入；P7
setup wizard 仍无生产入口，二者继续 `deferred`，不标记 `implemented/accepted`。

## 8.8 本次 feature-bearing source audit（2026-08-22）

本节更新并取代旧 source inventory 的当前结论；§§8.1–8.7 的旧 `v17.2.15` evidence 仍保留，
但不再作为当前 P0 状态依据。

### P0：source-backed / passed

在 clean 的临时只读 checkout `/tmp/runledger-omp-audit.mGXVLu` 中固定到：

- origin：`https://github.com/can1357/oh-my-pi.git`；
- commit：`81974fae4f1babf0a051f4ac9fb38645bdf7e450`；
- `@oh-my-pi/pi-tui` 与 coding-agent：`17.4.1`；
- `packages/tui/src/components/composer/`：contract、registry 以及 `box`、`claude`、`pi`、
  `borderless`、`rule`、`field`、`rail` 七个 builtin style；
- coding-agent：`composer-shape-registry.ts`、`composer-shape-preview.ts`、
  `settings-selector.ts`、`status-line/component.ts`、`interactive-mode.ts`、
  `settings-schema.ts` 与 `setup-wizard/scenes/composer.ts`。

该 inventory 证明真实 source 存在，不证明 RunLedger 已具备 oh-my-pi 的全部 coding-agent
runtime。P0 因此为 `source-backed / passed`，后续状态按 capability 分层。

### P1–P4：source-aligned presentation adaptation

当前 RunLedger worktree 的 7 个 style、纯 frame projector、共享 selector preview、用户级
`composer.shape`、`/shape` runtime sync 与唯一 OpenTUI native adapter，均按上述 source 的
style metadata/chrome topology 和 shared-preview 语义对齐。RunLedger 保留自己的
`layout.settings` JSON、OpenTUI 公共 API 和安全回退边界，不复制 pi-tui inheritance、私有
Textarea state 或通用 settings framework；因此状态写为 `source-aligned presentation adaptation`，
不是 “oh-my-pi 完整移植”。

### P5–P7：尚未完成项

- P5：`partial / pending-human`。自动 native/PTY 证据可以证明 geometry、resize、Unicode、
  cursor、scrollbar、Textarea identity、overlay focus、主题重绘和隔离 settings round-trip；
  仍缺逐项 dark/light 人工视觉、真实鼠标/选区 PTY 与 IME composition 记录，不能写成
  `human-verified`。
- P6：`deferred`。RunLedger `src/extensions/manager.ts` 目前只有受治理的 Plugin/Hook/MCP/
  Skill snapshot、trust、reload 与 turn-lifetime 管理，没有 composer-shape module loader 或
  production registration/disposer call site；`src/tui/composer/registry.ts` 的 passive seam
  不代表 extension capability。
- P7：`deferred`。RunLedger 当前没有生产 `src/tui/setup-wizard/` 或 setup-wizard scene；不能
  以 `/shape` selector 代替 `composer-shape` wizard scene。

本次 source audit 不创建 commit、不推送，也不改变上述旧 evidence 的历史内容；当前专项仍不
标记 `implemented/accepted`。

## 8.9 本次 current gate evidence（2026-08-22）

source audit 之后在同一 worktree 重跑的门禁如下：

- focused Vitest：12 files / 47 tests 全绿，包含 registry、frame signature、settings、selector、
  composition、PTY 与 slash popup；
- focused Bun composer native：2 files / 17 tests / 1,732 assertions 全绿；
- `npm run check`：退出码 0；
- `npm test`：Vitest 455 files passed / 1 skipped、2,771 tests passed / 3 skipped；Bun 144
  passed / 0 failed、2,752 assertions，整体退出码 0；
- `npm run build`：退出码 0；
- `git diff --check`：通过；
- 标准 PATH、隔离 `RUNLEDGER_DIR` 的 `tests/cli/composer-shape-pty.test.ts`：80/143 列均完成
  7 个 shape 的环形浏览，最终写入 `composer.shape=rail`，重启后恢复 `Accent Rail`，两次
  Ctrl+D 退出码均为 0。箭头阶段只等待非空差分 redraw，完整 preview label 和最终持久化值仍
  分别由 selector frame 与 settings 断言覆盖。

这些自动证据不等同于真人验收：P5 仍为 `partial / pending-human`，P6/P7 仍为 `deferred`，
本专项不标记 `implemented/accepted`。本次不创建 commit、不推送。

## 8.10 本次 P5 native capture hardening fresh evidence（2026-08-22）

本节记录 8.9 之后针对 native capture 与纯 `ComposerChromeFrame` 不一致的增量；它不改变
人工验收、P6/P7 或 source-aligned presentation adaptation 的状态。

- 先在 `tests/tui/opentui-composer-shape-p5.red.bun.test.ts` 增加真实
  `captureCharFrame()` 与 pure frame 行逐 cell 等值的 RED 回归；宽度 40、隐藏 scrollbar 下，
  原实现实际暴露了 box 的 `─/›/╯` 缺失或错位、claude/borderless/rule 的 `❯` 被 `›` 替换、
  field 的 `▌` 尾 cap 丢失，以及 rail 右侧重复 rail glyph。
- 最小修复把 `inputRect` 明确为 native 文本矩形，box 为跨 visual row 的 prompt/border 前缀
  预留真实 cell 宽度；native adapter 以独立 prefix、输入区 underlay 和 suffix chrome 投影
  pure frame，Textarea 仍是唯一的 draft/cursor/selection/focus owner。side-border scrollbar
  最后一行也按 frame 的 thumb/track 状态替换右边界；borderless 才保留独立 right rail。
- P5 focused native：10 tests / 1,669 assertions 全绿；与既有 OpenTUI composer/runtime
  合并 focused：58 tests / 1,950 assertions 全绿。
- 最终全量门禁：`npm run check` 与 `npm run build` 均退出码 0；`npm test` 中 Vitest
  为 455 files passed / 1 skipped、2,771 tests passed / 3 skipped，Bun native 为
  145 passed / 0 failed、2,769 assertions；`git diff --check` 退出码 0，新增未跟踪文档
  另以 `git diff --no-index --check` 复核且无 whitespace diagnostics。
- 标准 PATH PTY 在隔离 `RUNLEDGER_DIR` 下独立重跑并由全量 Vitest 再次覆盖：80/143 列均完成
  7 个 shape 环形浏览，保存并重启恢复最终 `rail`，两次退出码均为 0；并行压力下 3 次
  独立 PTY 重跑也全部通过。

P5 仍为 `partial / pending-human`：本次只增加自动 native capture 与 PTY 证据，仍没有逐项
dark/light 人工视觉、真实鼠标/选区 PTY 或真实 IME composition 记录，不能填写
`human-verified`。P0 继续 `source-backed / passed`；P1–P4 继续是 source-aligned 独立
presentation contract；P6/P7 继续 `deferred`。本次不创建 commit、不推送。

## 8.11 本次标准 PATH Unicode/resize PTY fresh evidence（2026-08-22）

本节只增加自动交互证据，不改变人工验收或 P6/P7 的 authority 结论。

- `tests/cli/composer-shape-pty.test.ts` 新增标准 PATH、隔离 `RUNLEDGER_DIR` 的真实 PTY 回归：
  输入中文、emoji 与 combining mark，80 列 resize 到 40 列后 draft 仍可见，再通过 Ctrl+U
  清空并恢复 `Message RunLedger` placeholder；空 draft 以 Ctrl+D 退出且退出码为 0。
- focused Vitest：该 PTY 文件 2 tests 全绿；Unicode/resize/clear 用例 3.597 秒，既有 7-shape
  浏览、保存与重启恢复用例 20.741 秒，总耗时 25.13 秒。
- 本轮完整门禁随后通过：`npm run check`、`npm run build`、tracked `git diff --check` 均退出码
  0；`npm test` 为 Vitest 455 files、2,772 passed / 3 skipped，Bun native 145 passed / 0
  failed、2,766 assertions。
- worktree 仍保留既有重叠 dirty 修改；本轮只新增该 PTY 回归和本节记录，不暂存、不创建
  commit、不推送。

该证据仍不是真实 IME composition、鼠标选区或逐项 dark/light 人工视觉验收；P5 继续为
`partial / pending-human`。P6 仍因没有 composer-shape module loader 与 production
registration/disposer call site 保持 `deferred`，P7 仍因没有 production setup-wizard scene
保持 `deferred`。本次只修改自动测试与本计划，不创建 commit、不推送。

## 8.12 本次 P6 trusted lifecycle seam fresh evidence（2026-08-22）

本节 supersede §8.11 对 P6 的旧 deferred 结论；它只实现受限的 TUI-local seam，不改变
Runtime/Host extension authority，也不宣称第三方插件 shape 已可用。

- RED 先新增 `tests/tui/composer/extension-lifecycle.red.test.ts`，证明目标 lifecycle 模块
  缺失；随后实现 `src/tui/composer/extension-lifecycle.ts`。`TrustedComposerShapeSource`
  只能由当前 CLI composition root 显式提供 first-party、framework-neutral
  `ComposerShapeDefinition`；不读取插件目录、不 dynamic import、不接收 OpenTUI/native
  handle，也不把 Runtime/Host snapshot 转换为 renderer code。
- lifecycle 的 `load/reload/dispose` 具备 bounded source 校验、重复 source identity 拒绝、按
  source/definition 注册顺序安装、失败时 reverse disposer、reload 失败恢复上一份有效
  definitions，以及幂等卸载。registry 继续拥有 builtin replacement、duplicate definition、
  malformed style 和 `box` fallback 的最终校验权。
- `src/cli/composer-shape-composition.ts` 是真实 CLI/TUI composition 接缝，`src/cli/main.ts`
  对同一个 registry 执行 `load()`，并在正常 CLI 生命周期结束时 `dispose()`；当前生产 source
  列表为空，因此标准用户仍只看到 7 个 builtin，不能通过 user plugin manifest 注入可执行
  renderer。`tests/cli/composer-shape-composition.red.test.ts` 覆盖该 composition call site。
- P6 focused evidence：lifecycle + CLI composition 共 5 tests 全绿；`npm run check` 全部通过。

P6 当前状态为 **bounded trusted seam implemented / third-party contribution deferred**：真实
Runtime/Host ExtensionManager 仍不拥有 composer shape，故没有跨进程 shape 传播或不受信任代码
执行面。

## 8.13 本次 P7 setup wizard fresh evidence（2026-08-22）

- RED 先新增 `tests/tui/setup-wizard/composer.test.ts` 与
  `tests/tui/setup-wizard/production-entry.red.test.ts`；随后新增
  `src/tui/setup-wizard/composer.ts`，包含 `ComposerSetupWizardScene(sceneId=
  composer-shape)` 与 overlay runner `ComposerSetupWizard`。
- scene 的 options 直接从注入的 `ComposerShapeRegistry.getComposerShapeOptions()` 读取；
  preview 直接调用既有 `renderComposerShapePreview()`，不重写 frame/padding/cursor/scrollbar
  算法；Enter 复用 `ComposerShapeSettingsPort`，只有保存成功后的 `onCommitted` 才由
  `InteractiveMode.syncComposerShape()` 改变 native presentation；Esc 和 save failure 保留
  旧 committed shape，failure 保持 wizard overlay 打开。
- `src/tui/commands/registry.ts` 新增 idle-only `/setup` → `config.setup-wizard`；
  `src/tui/interactive-mode.ts` 将其装配到真实 overlay 槽，未引入 workspace settings、
  `tui-preferences`、Session 或 Runtime 字段。`tests/tui/composer/interactive-mode.red.test.ts`
  覆盖真实 InteractiveMode dispatch/commit，`tests/cli/composer-shape-pty.test.ts` 的标准
  PATH PTY 用隔离 `RUNLEDGER_DIR` 覆盖真实 `/setup` 打开、Box→Claude 保存与退出。

P7 当前状态为 **single-scene composer setup wizard implemented**；它不是 oh-my-pi 全量通用
setup wizard，也不负责 provider/auth/credential onboarding。P5 仍为 `partial /
pending-human`：dark/light 逐项人工视觉、真实鼠标/选区 PTY 和 IME composition 仍未验证；
因此整个专项仍不能标记 `implemented/accepted`。

## 8.14 本次并发 settings 与真实 PTY selection fresh evidence（2026-08-22）

- 先新增 RED：`InteractiveSessionController` 在 model/thinking 持久化时不能覆盖用户刚保存的
  `composer.shape`；`updateProjectSettings()` 的并发更新测试也先因缺少锁内更新 API 失败。
  最小实现把 canonical settings 的直接写入和 read-modify-write 收口到同一
  `proper-lockfile` 锁，composer、hide-thinking、syntax theme、model selection 和 skills
  provider mutation 均使用锁内 updater。相关 focused tests 全绿，shape 在 model selection 后仍
  保持 `rail`，并发 updater 同时保留 `composer.shape` 与 `theme`。
- `tests/cli/composer-shape-pty.test.ts` 新增标准 PATH、隔离 `RUNLEDGER_DIR` 的真实 SGR mouse
  press/drag/release + Ctrl+C 场景；PTY 实际收到 OSC52 selection payload，随后 Ctrl+D 退出码
  为 0。该证据补齐自动 real-PTY selection，不把 native mock selection 当成 PTY 证据。
- `npm test`（Vitest + Bun native）完整命令退出码 0；本轮之后重新执行的
  `npm run check`、`npm run build`、tracked/untracked whitespace check 均通过。
- 当前环境只有 `ibus` 可执行文件，没有 `DISPLAY`、`WAYLAND_DISPLAY` 或 `XMODIFIERS`，无法
  提供可重复的真实 IME composition session；因此 IME 继续标记 pending，不用 Unicode/粘贴测试
  替代。逐项 dark/light 人工视觉也仍未由真人确认。

P5 当前仍为 **partial / pending-human**：自动 native、80/143 列 PTY、Unicode/resize、真实
mouse/OSC52、settings round-trip 和并发保存均有证据，但 dark/light 逐项人工视觉、真实 IME
composition 仍缺少可接受记录。P6 为 **bounded trusted seam implemented / third-party
contribution deferred**，P7 为 **single-scene composer setup wizard implemented**；整个专项
仍不标记 `implemented/accepted`，本轮不创建 commit、不推送。

## 8.15 最终 fresh gate evidence（2026-08-22）

- 在最后一次代码合并优先级修正后重新执行 `npm run check`，退出码 0；全部 storage/runtime/
  execution/platform/TUI/session-owner 边界检查、TypeScript、Rust syntax-highlighter 12 项
  测试和 Bash AST 资源检查均通过。
- 重新执行 `npm run build`，退出码 0；Linux peer credential helper、syntax-highlighter、
  TypeScript 编译、TUI assets 和 Host build manifest 均完成。
- 严格命令 `npm test` 的最新未重定向执行退出码 0：Vitest `458` files passed、`1` skipped，
  `2784` tests passed、`3` skipped；Bun OpenTUI `145 pass / 0 fail`。
- 中间一次将 `npm test` 输出重定向到 `/dev/null` 的尝试返回 1，但因输出被丢弃无法归因；
  随后连续两次保留输出的严格 `npm test` 均以上述汇总退出码 0。若该瞬时异常再次出现，
  必须保留完整输出再归因，不能把它静默视为通过或失败。
- `tests/cli/composer-shape-pty.test.ts` 的 4 个标准 PATH PTY case、并发 settings focused
  tests、P6 lifecycle/CLI composition 和 P7 setup wizard tests 均在上述全量门禁中通过。
- P5 仍为 **partial / pending-human**：dark/light 逐项人工视觉确认与真实 IME composition
  仍缺少可接受记录；P6 仍是 **bounded trusted seam implemented / third-party contribution
  deferred**，P7 仍是 **single-scene composer setup wizard implemented**。专项不标记
  `implemented/accepted`，本轮仍不创建 commit、不推送。

## 8.16 本次真实终端 final-cell 残留修复 evidence（2026-08-22）

- 新增 `tests/cli/composer-shape-pty.test.ts` 的 tmux final-cell 回归前，真实标准 PATH
  终端在打开 `/shape` 后可观察到旧帧字符残留：`pressiEnterfto save`、`StatusDline...`；
  原有 node-pty 测试只检查原始输出片段，未覆盖终端 emulator 最终 cell 状态，因此该缺口
  先以 RED 复现。
- 最小修复位于 `src/tui/opentui/component-runtime.ts`：普通捕获型 modal 与 bottom-left
  modal 现在先铺当前 dark/light theme surface，覆盖短于上一帧的 TextRenderable 行；compact
  non-capturing popup 继续保持透明语义。新增回归确认 `/shape` 初始帧、Down 后帧均保留完整
  `Preview the input frame, then press Enter to save.`，且不再出现旧字符拼接。
- focused `tests/cli/composer-shape-pty.test.ts` 为 5/5；其中包含真实 tmux final-cell case；
  `npm run test:tui-native` 为 Bun `145 pass / 0 fail`；`npm run check`、`npm run build` 和
  严格 `npm test` 均通过，Vitest 为 `458` files passed、`1` skipped，`2785` tests passed、
  `3` skipped。
- 该 tmux case 是自动真实终端 evidence，不等同于真人视觉验收。P5 仍为 **partial /
  pending-human**：dark/light 逐项人工确认和真实 IME composition 仍缺；P6/P7 状态不变，
  专项仍不标记 `implemented/accepted`，本轮不创建 commit、不推送。

## 8.17 当前环境对真人验收的可验证边界（2026-08-22）

- 当前进程环境的 `DISPLAY`、`WAYLAND_DISPLAY`、`XMODIFIERS` 均为空；`Xvfb`、Wayland
  compositor 和可直接承载 IME 的虚拟 terminal emulator 不可用。`ibus list-engine` 返回
  `Can't connect to IBus`，只有 `/usr/bin/ibus` 与 `/usr/bin/ibus-daemon` 二进制存在。
- 只读探测 `/usr/lib/xorg/Xorg :99` 也未建立可用 display：Xorg wrapper 拒绝非 console
  用户，直接二进制则以 `parse_vt_settings: Cannot open /dev/tty0 (Permission denied)`
  终止。没有安装软件、改变系统 display 权限或把普通 Unicode/粘贴输入冒充 IME。
- 因此当前剩余 DoD 明确收窄为外部真人 gate：真实 dark/light 80/143 列逐项视觉确认和
  真实 IME composition session；自动 native、tmux final-cell、Unicode/resize、mouse/OSC52
  证据均不能替代它们。P5 保持 **partial / pending-human**，P6/P7 状态不变，专项不标记
  `implemented/accepted`。

## 8.18 本次 tmux shape preview matrix fresh evidence（2026-08-22）

- 复核发现原标准 PATH PTY 的 Down 阶段只等待任意差分输出，不能证明每次导航后的 preview
  label 已更新；因此新增 tmux 最终 cell 回归，使用同一隔离 `RUNLEDGER_DIR` 和标准 PATH
  `runledger`，在 80、143 列分别打开 `/shape`，对七个 shape 的每一次环形 Down 都读取
  `capture-pane` 的最终 screen，并断言当前 `Preview: <shape>`，Enter 后最终 settings 仍为
  `composer.shape=rail`。
- `npx vitest run tests/cli/composer-shape-pty.test.ts`：7/7 passed；新增矩阵 case
  8.485s，完整文件 43.023s。该测试使用 tmux 的真实 terminal cell 状态，比原始 node-pty
  ANSI 差分输出提供更强的自动交互证据。
- 追加门禁：`npm run check`、`npm run build`、tracked/untracked `git diff --check` 均通过；
  严格 `npm test` 为 Vitest `458` files passed、`1` skipped，`2787` tests passed、`3` skipped，
  Bun native `145 pass / 0 fail`、`2764` assertions。
- 同一 PTY 文件再增加标准 PATH provenance 断言，确认 `which runledger` 的 realpath 是当前
  worktree 的 `bin/runledger.js`；该 focused 文件现为 `7/7 passed`。这只强化证据来源，不改变
  生产运行时或设置 authority。
- 该矩阵仍是自动终端 evidence，不是真人视觉验收；P5 仍为 **partial / pending-human**，
  dark/light 逐项人工确认和真实 IME composition 仍需外部 display/IME 环境。P6/P7 状态不变，
  专项不标记 `implemented/accepted`。

## 8.19 本次 implementation review remediation fresh evidence（2026-08-22）

本节闭合 implementation review 发现的六个自动可修复缺口；每项均先增加会失败的回归，再做
最小实现，不把本节证据提升为真人验收：

- viewport budget：24×8、16 行 draft 的 production-sized frame 先复现 absolute chrome 仍为
  16 行而 Textarea 已压到 5 行、footer cell 被覆盖；native adapter 现在按 Textarea viewport
  高度和 `scrollY` 裁剪 left/underlay/right chrome，composer host、至少一行 transcript 和未消费
  footer 均保持在 renderer 高度内；
- status routing：Composer frame 先从既有结构化 Footer 读取 identity/usage，再由共享
  `composerStatusConsumption()` 按 `statusAttachment` 与 `bottomBar` 消费相应 group；pure terminal
  和 native runtime 都只渲染未消费的 footer 行，Box 不再同时显示 top status 与重复 footer；
- selector race：`ComposerShapeSelector` 增加与 setup scene 相同的 in-flight guard；保存期间 Esc、
  navigation 和重复 Enter 均不再取消、改变 preview 或发起第二次保存，失败后才恢复输入；
- theme runs：`ComposerChromeContext` 增加 `borderColor`、`accentColor`、`surfaceColor`，frame 保留
  多个 `ComposerTextRun` 的 foreground/background/bold 语义；Box border/status chip、Field caps、
  Accent Rail 和 scrollbar 不再被 `fitRow()` 压成单一 role，native adapter 投影为 OpenTUI
  `StyledText` chunks；
- composer scrollbar：production facade 不再固定 `visible:false`。可见性和归一化 thumb position
  由唯一 native `TextareaRenderable` 的 virtual rows、viewport height 和 `scrollY` 回报，TUI 只保存
  当前帧 presentation 并重投影，不新增 Session、Runtime 或 durable scroll authority；
- Field metadata：`field.bottomBarGap` 从 `0` 修正为 oh-my-pi 17.4.1 合同的 `1`，style metadata 与
  gap row 回归同步更新。

fresh 自动证据：composer/setup/interaction focused Vitest 为 11 files / 64 tests；两个 composer
native 文件为 21 tests / 1,758 assertions，其中 P5 matrix 为 13 tests / 1,681 assertions；完整
Vitest 为 2,790 passed / 3 skipped；严格 `npm test` 整体退出码 0，Bun OpenTUI 为
148 pass / 0 fail、2,779 assertions；`npm run check`、`npm run build`、`git diff --check` 均
通过。标准 PATH 使用当前 worktree 临时
symlink、隔离 `RUNLEDGER_DIR` 的 `tests/cli/composer-shape-pty.test.ts` 为 7/7 passed；没有修改
全局 npm link。

P5 继续为 **partial / pending-human**：本次闭合的是 viewport、status、async input、theme runs、
scrollbar production reachability 和 source metadata 的自动缺口；真实 dark/light 逐项人工确认与
真实 IME composition 仍缺。P6/P7 状态不变，专项仍不标记 `implemented/accepted`，本轮不创建
commit、不推送。

## 8.20 分批提交闭环（2026-08-22）

在用户明确要求“分批提交已经完成的内容”后，本专项按可审阅边界创建以下本地提交：

- `8042142 feat(tui): keep composer shapes renderer-neutral`：纯 contract、7 个 builtin、共享
  frame/preview、registry 与 bounded trusted lifecycle；
- `be34940 fix(tui): keep composer chrome inside native bounds`：唯一 OpenTUI adapter、Textarea
  identity、viewport/status/theme/scrollbar 修复与 native 回归；
- `fb74e36 fix(storage): preserve concurrent presentation settings`：用户级 shape authority、
  settings 锁内原子更新与 Host digest 排除；
- `1d8733c feat(tui): make composer shape changes durable`：`/shape`、单场景 `/setup`、CLI
  composition、即时同步与标准 PATH PTY 回归。

本文与 `development-doc/00-index.md` 作为独立文档批次提交；未执行 push。提交边界不改变验收
状态：P5 仍为 **partial / pending-human**，真实 dark/light 逐项人工确认和 IME composition 仍待
外部人工环境完成。
