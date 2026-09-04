# RunLedger TUI 与安全交互术语记录

> 用途：统一产品文案、设计讨论、测试标题与源码注释中的界面名称。本文是术语/定位索引，不宣称某个计划已经完成；状态仍以当前代码、测试和专项文档为准。
>
> 源码快照：2026-09-04 当前工作树。`路径:行号`指向本次盘点时的定义或主要装配点；行号会随代码演进而移动。

## 1. 使用规则与结构总览

### 1.1 命名规则

| 规则 | 约定 |
|---|---|
| “块” | 只指 `PresentationBlock` 或它的具体变体；不要把所有有边框的终端区域都叫“块”。 |
| “组件” | `src/tui/components/` 的框架无关 `Component`；OpenTUI 原生对象叫“渲染节点（Renderable）”。 |
| “主时间线” | 正常聊天滚动区；与 `Ctrl+T` 打开的“只读转写层”区分。 |
| “工具调用块” | 规范名为“工具调用行”或“工具展示块”，应同时说明它是 Timeline 行、safe presentation，还是最终的 `exec`/`diff`/文本块。 |
| “参数展示区域” | 规范名为“参数 Footer（状态栏字段区）”；工具的调用参数则叫“工具输入元数据”。 |
| “权限设置” | 指安全配置层中的 profile/policy/rule；一次执行前的询问叫“审批请求”，不是设置界面。 |
| “二级选择界面” | 用户提交命令或 Runtime 发起反向请求后，临时捕获输入的标题/详情/选项/footer 界面；标准结构为 `SecondarySelectionView`。 |

### 1.2 当前投影链路

```text
TuiState / TimelineState
  ├─ timelineToBlocks() ──> PresentationBlock[]（主时间线）
  │     └─ ChatContainer ──> TUI.renderFrame() ──> OpenTuiComponentFrame
  │                                                  └─ OpenTUI screen / transcript / composer / footer
  └─ projectTranscriptOverlay() ──> 只读转写层（Ctrl+T）

SecurityConfigLayer[] ──> SecuritySnapshot ──> PermissionEngine
  └─ ask ──> ApprovalCoordinator ──> Host reverse request
       └─ ApprovalWorkflow ──> PermissionRequestView
                                      └─ SecondarySelectionView ──> Composer 上方 Overlay
```

主要连接点：`src/tui/timeline/selectors.ts:29`、`src/tui/primitives.ts:589`、`src/tui/opentui/component-runtime/types.ts:40`、`src/security/config/resolver.ts:149`、`src/tui/interactive/approval-workflow.ts:56`。

常驻组件树由 `InteractiveMode` 按 `header → loaded resources → chat → editor → status → footer` 装配；`TUI.renderFrame()` 把焦点前的组件投到正文、焦点后的组件投到 Footer。位置：`src/tui/interactive-mode.ts:558`、`src/tui/primitives.ts:589`。真实 `ProcessTerminal` 会创建 OpenTUI runtime（`src/tui/primitives.ts:494`），因此原生 runtime 不是旁路或仅测试代码。

### 1.3 状态标记

- **当前实现**：源码已有实际投影/装配路径。
- **合同或只读**：类型、读取口或展示字段存在，但不等于用户可修改它。
- **工作树候选**：当前工作树存在代码；探索摘要专项当前为 `partial / implementation in dirty worktree / not accepted`，不得在产品文案中去掉该限定。

## 2. `src/tui/presentation.ts`：跨渲染器展示合同

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 展示块（Presentation Block） | `PresentationBlock` 为主界面/overlay 的联合类型；每块可带稳定 `id` 和 `PresentationBlockMetadata`。 | `src/tui/presentation.ts:44`, `src/tui/presentation.ts:78` | **当前实现**；是“块”一词的基准。 |
| 文本块 / Markdown 块 | `kind: "text"` 与 `kind: "markdown"`；Markdown 有 `streaming`，供流式渲染。 | `src/tui/presentation.ts:79` | **当前实现**。 |
| 执行展示块 | `kind: "exec"`，结构是命令、生命周期状态、stdout/stderr 输出、exit code、时长与截断布局元数据。 | `src/tui/presentation.ts:83` | **当前实现**；用于 shell 工具，不等同于所有工具调用。 |
| 差异展示块 | `kind: "diff"`，持有安全 diff 文档、行号 gutter、流式与语法高亮开关。 | `src/tui/presentation.ts:97` | **当前实现**。 |
| 计划更新块 | `kind: "plan-update"`，由说明和带状态的步骤构成。 | `src/tui/presentation.ts:9`, `src/tui/presentation.ts:17` | **当前实现**。 |
| 通知块 | `kind: "notice"`，有 `info`、`warning`、`error` 三种严重度。 | `src/tui/presentation.ts:34` | **当前实现**；运行提示不要误称工具结果。 |
| 状态栏行 | `kind: "status-line"`，是一串带 accent 的 `segments`。 | `src/tui/presentation.ts:114` | **当前实现**；它属于 Footer 输出，不是编辑器上方的状态指示行。 |
| 选择块 / 输入块 | overlay 的 `select` / `input` 块；分别有选项/选中索引，或标题/消息/值/placeholder。 | `src/tui/presentation.ts:120` | **当前实现**；由 overlay controller 生成原生 Select/Input 节点。 |

## 3. `src/tui/timeline/`：会话时间线与消息块

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 时间线（Timeline） | `TimelineState = committedRows + activeRowsByCorrelationId + activeOrder + activeRun`；它是展示投影输入，不是 renderer 自有状态。 | `src/tui/timeline/types.ts:104` | **当前实现**。 |
| 时间线行（Timeline Row） | `TimelineRow` 的联合；公共字段含稳定 ID、时间、显示顺序、状态、generation 与 correlation ID。 | `src/tui/timeline/types.ts:30`, `src/tui/timeline/types.ts:39` | **当前实现**；“消息”“工具调用”都先是行。 |
| 用户消息行 | `kind: "user"`，持有安全有界文本。 | `src/tui/timeline/types.ts:40` | **当前实现**；投影为文本块。 |
| 助手消息行 | `kind: "assistant"`，包含正文、`streaming`、可选 `thinking` 与 usage。 | `src/tui/timeline/types.ts:41` | **当前实现**；正文与思考会拆成不同展示块。 |
| 思考块（Thinking Block） | assistant 行的 `thinking` 被投影成 ID 为 `timeline-<row>/thinking` 的 Markdown 块；正文块为 `/text`。 | `src/tui/timeline/selectors.ts:79`, `src/tui/timeline/selectors.ts:85` | **当前实现**；应使用“思考块”，不要与模型的 `thinking level` 混用。 |
| 思考块可见性开关 | `hideThinking` 使 projector 不产生 thinking block；Timeline 原始数据不变，主时间线和转写层都会重投影。 | `src/tui/timeline/selectors.ts:20`, `src/tui/timeline/selectors.ts:87`; `src/tui/interactive-mode.ts:682` | **当前实现**，仅展示层。它不是“逐块折叠”。 |
| “折叠思考块” | **不作为当前实现术语。**当前没有每条思考的 `expanded/collapsed` 状态、展开按钮或逐块交互；仅有上述全局隐藏/显示。 | `src/tui/timeline/selectors.ts:87`; `src/tui/interactive-mode.ts:671` | 历史设计文档中的“折叠”不能替代当前实现名称。 |
| 工具调用行 | `kind: "tool"`，包含 `toolCallId`、`toolName` 与 `TuiField<SafeToolPresentation>`。 | `src/tui/timeline/types.ts:49` | **当前实现**；这是“工具调用块”最准确的时间线层名称。 |
| 运行中状态（Active Run） | `working`、`waiting`、`recovery_required` 以及等待原因为 approval/credential。 | `src/tui/timeline/types.ts:87` | **当前实现**；供状态指示行和 Footer 读取。 |
| 回合分隔线（Run Boundary） | `kind: "run-boundary"`；只在该回合有工具活动时投影为 separator，并附工具数/token 指标。 | `src/tui/timeline/types.ts:79`, `src/tui/timeline/selectors.ts:49` | **当前实现**；不是一条普通消息。 |
| 只读转写层 | 对 committed rows 缓存、对 active rows 拼 live tail 的完整时间线阅读视图。 | `src/tui/transcript-view.ts:52` | **当前实现**；`Ctrl+T` 打开且不改变主 ScrollBox。 |

## 4. `src/tui/presentation/tools/`：工具调用的安全展示模型

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 工具展示（Safe Tool Presentation） | `SafeToolPresentation` = renderer、标题、输入元数据、chips、正文、结果、错误、usage、时间戳。 | `src/tui/presentation/tools/types.ts:143` | **当前实现**；禁止把 raw args、凭据、base64 或完整文件正文直接放进此层。 |
| 工具输入元数据 | `SafeToolInputMetadata`：edit/write/read/grep/find/glob/ls/shell 各有允许展示的 path/query/count/命令标签。 | `src/tui/presentation/tools/types.ts:25` | **当前实现**；这是“工具参数展示”的规范名，不要与 Footer 混称。 |
| 工具正文 | `SafeToolBodyBlock` 仅允许有界文本或安全 diff。 | `src/tui/presentation/tools/types.ts:123` | **当前实现**。 |
| 工具状态标签（chips） | 带 label 和 tone 的 `SafeToolChip[]`。 | `src/tui/presentation/tools/types.ts:118` | **当前实现**；是工具块内的状态摘要。 |
| 工具结果元数据 | `SafeToolResultMetadata` 按 read/grep/find/glob/ls/shell/edit 等结果种类建模。 | `src/tui/presentation/tools/types.ts:106` | **当前实现**；未知值不能由空正文推断成 0。 |
| 工具展示块 | selector 按 renderer 选择 `plan-update`、`exec`、文本与 `diff` 块；shell 展示 stdout/stderr、退出码、时长和 background。 | `src/tui/timeline/selectors.ts:123`, `src/tui/timeline/selectors.ts:134`, `src/tui/timeline/selectors.ts:155` | **当前实现**；说“工具调用块”时应补充这个具体变体。 |
| 探索摘要块（Exploration Block） | `read/search/list` 动作集合及 `active/completed/completed-with-errors` 状态；主面不含成功正文。 | `src/tui/presentation.ts:49`, `src/tui/presentation.ts:61` | **工作树候选**；专项当前是 dirty-worktree `partial`，不能宣称已验收。 |
| 工具详情块 | `kind: "tool-detail"`：单个探索动作加受限正文，供转写面阅读。 | `src/tui/presentation.ts:70`; `src/tui/timeline/selectors.ts:105` | **工作树候选**；与主面的探索摘要成对，不是第二份 canonical 工具结果。 |
| 探索结果双截断 | `sourceTruncated` 表示 Runtime 源结果截断，`presentationTruncated` 表示 TUI 展示预算截断。 | `src/tui/presentation/tools/types.ts:92` | **工作树候选**；两者不可合并为一个泛称“截断”。 |

## 5. `src/tui/components/` 与 `src/tui/footer/`：用户可见的框架无关组件

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 欢迎页（Welcome） | 新建会话首次视图的双栏欢迎组件：LOGO、版本/模型/思考等级/目录/分支、最近会话和 tip。 | `src/tui/components/welcome.ts:1`; 装配：`src/tui/interactive-mode.ts:558` | **当前实现**；resume/continue/fork 不重复显示。 |
| 资源条（Loaded Resources） | 顶部 MCP、skills、hooks、slash 的已加载计数。 | `src/tui/components/loaded-resources.ts:2`, `src/tui/components/loaded-resources.ts:16` | **当前实现**；只展示资源计数，不是权限状态。 |
| 聊天容器（Chat Container） | 顺序持有展示组件，生产路径接收稳定 ID 的 Timeline blocks；保留临时 replacement 能力。 | `src/tui/components/chat-container.ts:40`, `src/tui/components/chat-container.ts:72`, `src/tui/components/chat-container.ts:113` | **当前实现**；权限请求已不再替换主聊天内容。 |
| 输入框 / Composer | `CustomEditor` 是输入模型；支持提交、Alt+Enter follow-up、Alt+Up 恢复队列和 slash popup 键拦截。 | `src/tui/components/custom-editor.ts:2`, `src/tui/components/custom-editor.ts:56` | **当前实现**；产品文案优先称“输入框”或“Composer”，避免称底层 Textarea。 |
| 状态消息 | `StatusComponent` 专门显示 transient idle recap，不进入 transcript。 | `src/tui/components/status.ts:2`, `src/tui/components/status.ts:27` | **当前实现**；不是“状态指示行”。 |
| 参数 Footer（状态栏字段区） | `Footer` 把 registry 投影成 0–N 条 `status-line`；它不订阅业务事件。 | `src/tui/components/footer.ts:2`, `src/tui/components/footer.ts:42` | **当前实现**；“参数展示区域”统一指此处。 |
| Footer 字段注册表 | `FooterFieldRegistry` 以 `activity → identity → usage` 三行、字段顺序和窄屏 drop priority 管理显示。 | `src/tui/footer/field-registry.ts:9`, `src/tui/footer/field-registry.ts:74`, `src/tui/footer/field-registry.ts:76` | **当前实现**；不是一个可由模型随意写入的区域。 |
| 内建 Footer 字段 | activity queue；identity 的状态/路径/分支/模型/计划/context/thread；usage 的 input/output/cache/hit/rate/cost/context。 | `src/tui/footer/field-registry.ts:206` | **当前实现**；引用字段时用其稳定 ID，如 `identity.model`、`usage.cost`。 |
| Slash 命令补全弹窗 | 输入 `/` 时的非捕获式候选列表，负责过滤、选择和展示，不自行执行业务命令。 | `src/tui/components/slash-command-popup.ts:2`, `src/tui/interactive/input-controller.ts:179` | **当前实现**；称“slash popup”，不要泛称设置面板。 |
| 统一二级选择视图 | `SecondarySelectionView` = 标题/副标题/详情/编号选项/footer hint 的标准结构；`ListSelectionModal` 是兼容旧名。 | `src/tui/components/list-selection-modal.ts:21`, `src/tui/components/list-selection-modal.ts:52` | **当前实现**；`/model`、`/thinking`、`/permissions`、Full Access 确认及权限请求共用。 |
| 通用选择视图兼容层 | `SelectionView` 继承 `SecondarySelectionView`，保留 `action` / `dismissOnSelect` 适配。 | `src/tui/components/selection-view.ts:39` | **当前实现**；不再自己拥有第二份列表导航状态。 |

## 6. `src/tui/primitives.ts` 与 `src/tui/opentui/`：原生终端布局与渲染节点

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| TUI facade | `TUI` 管理焦点、输入监听、overlay、FrameScheduler，并把 Component 的 `present()` 收集成 frame。 | `src/tui/primitives.ts:379`, `src/tui/primitives.ts:589` | **当前实现**；它不是业务状态的唯一 owner。 |
| 界面帧（OpenTui Component Frame） | `body`、`footer`、`overlay`、编辑器文本/外观/高度、状态指示行和滚动条展示的一次快照。 | `src/tui/opentui/component-runtime/types.ts:40` | **当前实现**；这里的 frame 是渲染帧数据，不是会话或网络帧。 |
| 主时间线滚动区（Transcript ScrollBox） | 原生 `ScrollBoxRenderable`，sticky bottom、viewport culling；可显示内建垂直滚动条。 | `src/tui/opentui/component-runtime/index.ts:38` | **当前实现**；用户可通过 `/scrollbar` 切换可见性。 |
| 新内容提示 | `runledger-new-content`，用户不在底部且有新块时显示“PageDown to follow”。 | `src/tui/opentui/component-runtime/index.ts:53`; `src/tui/opentui/component-runtime/frame-runtime.ts:158` | **当前实现**。 |
| 运行状态指示行 | 编辑器上方的 spinner/Waiting/elapsed/interrupt/details；可按 shimmer 选项着色。 | `src/tui/presentation.ts:24`; `src/tui/opentui/component-runtime/footer-editor-runtime.ts:43` | **当前实现**；与 Footer、idle recap 三者不同。 |
| 原生 Composer 行 | `runledger-editor-row` 包含 prompt glyph `›` 和 `RunLedgerTextareaRenderable`；默认 placeholder 为 `Message RunLedger…`。 | `src/tui/opentui/component-runtime/index.ts:67`, `src/tui/opentui/component-runtime/index.ts:79`, `src/tui/opentui/component-runtime/index.ts:86` | **当前实现**；这是 CustomEditor 的 OpenTUI 投影。 |
| 原生 Footer | `runledger-footer` 承载 `status-line` 的 StyledText，位于 Composer 后。 | `src/tui/opentui/component-runtime/index.ts:96`; `src/tui/opentui/component-runtime/footer-editor-runtime.ts:80` | **当前实现**。 |
| 渲染节点注册表 | `RenderableRegistry` 按稳定 key 创建、复用、更新和销毁正文的 Markdown/Text/Exec/Diff/Plan/Notice/Exploration 节点。 | `src/tui/opentui/component-runtime/renderable-registry.ts:1`, `src/tui/opentui/component-runtime/renderable-registry.ts:27` | **当前实现**；是性能/生命周期概念，不是用户界面名称。 |
| Overlay（浮层） | 绝对定位的高层容器；根据 `select`、`input`、`command`、文本块创建节点并管理焦点。 | `src/tui/opentui/component-runtime/overlay-controller.ts:1`, `src/tui/opentui/component-runtime/overlay-controller.ts:20` | **当前实现**；命令/选择/认证等采用此路径。 |
| Composer 上方二级界面 | 捕获输入的二级选择使用 `overlayAnchor: "bottom-left"`；底部偏移 = Footer 高度 + Composer 高度 + 运行状态行高度 + 1。 | `src/tui/opentui/component-runtime/overlay-controller.ts:20`, `src/tui/opentui/component-runtime/overlay-controller.ts:32`, `src/tui/opentui/component-runtime/frame-runtime.ts:85` | **当前实现**；会按剩余终端高度压缩 Select，不得跨过边框或覆盖 Composer。 |
| 转写全屏浮层 | `overlayVariant: "transcript"` 占满屏幕、无普通 modal 边框，显示只读转写。 | `src/tui/opentui/component-runtime/overlay-controller.ts:27`, `src/tui/interactive-mode.ts:654` | **当前实现**；是阅读面，不是主时间线的第二份状态。 |

## 7. `src/tui/commands/` 与 `src/tui/interactive/`：配置与输入术语

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| Slash 命令注册表 | 每个命令有 canonical name、动作类型、空闲门控、可见性与参数 schema。 | `src/tui/commands/registry.ts:26`, `src/tui/commands/registry.ts:56` | **当前实现**；UI 按 `actionType` 路由，而非按显示文案猜测。 |
| 模型设置 / 思考等级设置 | `/model`、`/thinking` 属于 config 命令；思考等级是模型请求等级。 | `src/tui/commands/registry.ts:184`, `src/tui/commands/registry.ts:191` | **当前实现**；与思考块可见性是两个概念。 |
| 思考块可见性设置 | `/hide-thinking` 切换并经 port 保存 `hideThinkingBlock`；CLI `--hide-thinking` 仅覆盖本次运行。 | `src/tui/commands/registry.ts:198`; `src/tui/interactive/input-controller.ts:119`; `src/cli/hide-thinking-settings.ts:5` | **当前实现**，仅影响展示。 |
| 会话偏好 | `/scrollbar` 保存 transcript scrollbar 与 shimmer 相关的 presentation preference。 | `src/tui/commands/registry.ts:265`; `src/tui/interactive/input-controller.ts:104` | **当前实现**；这是显示偏好，不是安全策略。 |
| 输入分派 | 输入以 `/` 开头时查命令注册表，否则作为 prompt 或 follow-up 发给 controller/agent。 | `src/tui/interactive/input-controller.ts:29` | **当前实现**。 |

## 8. `src/tui/approval*` 与 `src/security/`：审批和权限配置

### 8.1 一次执行的审批交互

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 审批反向请求视图 | `ApprovalReverseRequestView` 只接受有界 toolName/summary/cwd/expiry/access requests。 | `src/tui/approval.ts:5`, `src/tui/approval.ts:25` | **当前实现**；来自 Host/session 的安全 DTO，不接受任意 UI payload。 |
| 审批选项 | allow-once、deny、allow-session，可安全生成命令前缀规则或网络 endpoint 规则，另有 cancel。 | `src/tui/approval.ts:13`, `src/tui/approval.ts:45` | **当前实现**；不要把 allow-once 叫永久授权。 |
| 审批工作流 | `ApprovalWorkflow` 校验请求、处理过期/abort/busy、返回 reverse response，并在完成后恢复 editor 焦点。 | `src/tui/interactive/approval-workflow.ts:26`, `src/tui/interactive/approval-workflow.ts:56` | **当前实现**。 |
| 权限请求视图 | `PermissionRequestView` 继承 `SecondarySelectionView`，显示 reason、访问请求/命令与三项 Codex 风格选项。 | `src/tui/components/permission-request-view.ts:25`, `src/tui/interactive/approval-workflow.ts:109` | **当前实现**；以 Composer 上方的捕获式 Overlay 呈现，主聊天内容保留。 |
| Full Access 确认视图 | `/permissions` 选中 `danger-full-access` 后用 `SecondarySelectionView` 显示二次确认。 | `src/tui/permissions/workflow.ts:108` | **当前实现**；与权限请求使用同一结构和位置契约，不因 Full Access 改回居中模态。 |
| 审批 receipt | 由 `ApprovalCoordinator` 将 prompt 决定固化成带 request digest、scope、revision、expiry 的 receipt。 | `src/security/permission/approval-coordinator.ts:212`, `src/security/permission/approval-coordinator.ts:234` | **当前实现**；它是授权可审计凭据，不是界面上的选项文字。 |

### 8.2 安全配置（不是 TUI 设置面板）

| 规范术语 | 代码结构 | 所在位置 | 状态与边界 |
|---|---|---|---|
| 权限预设（Permission Profile） | 内建 `read-only`、`workspace-write`、`headless-workspace`、`danger-full-access`、`custom`，或命名 profile。 | `src/security/types.ts:36`; 默认定义：`src/security/config/resolver.ts:41` | **当前实现**；是启动时的安全配置，不是一次审批的选择项。 |
| 审批策略（Approval Policy） | `on-request`、`never`、`untrusted`、`granular`；granular 还带细分开关。 | `src/security/types.ts:44`, `src/security/types.ts:49` | **当前实现**；由 PermissionEngine 把 ask/allow/deny 规则归并。 |
| 安全配置层 | `managed/organization/project/user/session/cli/builtin/fallback` 来源按优先级解析成 snapshot。 | `src/security/types.ts:24`; `src/security/config/resolver.ts:149` | **当前实现**；术语应写“配置层”，不要笼统说“设置”。 |
| 安全快照（Security Snapshot） | 已解析 profile、filesystem、rules、来源、workspace/temp root、policy digest 与时间。 | `src/security/types.ts:140` | **当前实现**；是本次授权判断的输入。 |
| CLI 安全覆盖 | `--permission-profile` 与 `--approval-policy` 等 flag 形成最高优先级的 `cli` 配置层。 | `src/cli/args.ts:101`; `src/cli/main.ts:620` | **当前实现**；是启动参数，不等于持久化的 TUI 设置。 |
| 权限引擎 | `PermissionEngine` 先按文件/命令/网络/worktree/tool 决定 allow/ask/deny，再应用审批策略；未知和越界 fail closed。 | `src/security/permission/engine.ts:24`, `src/security/permission/engine.ts:140` | **当前实现**；是策略裁决器，不渲染界面。 |
| 执行网关 | `ExecutionGateway` 绑定 authorization、request/constraint digest 和最终 effect；负责安全开通而非展示。 | `src/security/execution-gateway.ts:44`, `src/security/execution-gateway.ts:171`, `src/security/execution-gateway.ts:255` | **当前实现**；不要称为“权限弹窗”。 |
| 安全模式（Security Mode） | TUI 合同可读取 `guarded/unrestricted`、revision，并声明 `set` 的未来 port。 | `src/tui/security-mode/types.ts:4`, `src/tui/security-mode/types.ts:28` | **合同或只读**；当前 session adapter 只实现 inspect，`set` 显式返回 unsupported：`src/tui/adapters/session-resources.ts:134`。因此当前没有可编辑的“安全模式/权限设置面板”。 |

`ProjectSettings`、`TuiPreferencesDocument` 与 `SecurityConfigDocument` 不是同一个 schema：前者持有模型、主题和 `hideThinkingBlock` 等项目设置（`src/storage/settings-manager.ts:38`），偏好只保存滚动条/shimmer（`src/tui/preferences/types.ts:3`），而安全配置层由 snapshot loader 从 user/workspace JSON 的 `security` section 读取（`src/security/composition/snapshot-loader.ts:20`）。讨论“保存权限设置”时必须先指明这三者中的哪一个，不能把一次 CLI 覆盖或审批选择说成普通项目设置。

## 9. 容易混淆的名称对照

| 不推荐的模糊说法 | 应使用的术语 | 原因 |
|---|---|---|
| 折叠思考块 | 思考块可见性开关 | 当前是全局隐藏，不是逐块折叠。 |
| 工具调用块 | 工具调用行 / 工具展示块（exec、diff、计划更新等） | 前者是 Timeline 层，后者是 PresentationBlock 层。 |
| 参数区域 | 参数 Footer / 工具输入元数据 | 前者在 Composer 下，后者在工具调用内。 |
| 状态栏 | 运行状态指示行 / 参数 Footer / idle recap | 三者位置、数据源和生命周期不同。 |
| 权限设置 | 权限预设、审批策略或审批请求 | 先说明是启动配置还是一次执行前的用户决定。 |
| 权限弹窗 | 权限请求视图 / 审批请求 | 它是统一二级选择界面的安全业务变体，位于 Composer 上方。 |
| 安全模式切换 | 安全模式只读快照 | 类型预留 set port，但当前 session adapter 不支持 mutation。 |

## 10. 维护清单

新增或修改以下任一项时，应同步更新本文的术语、结构和定位：

1. `PresentationBlock` / `TimelineRow` 新增 kind，或工具展示安全字段变更；
2. Composer、Footer、状态指示行、转写层、overlay 的用户可见层级变更；
3. 思考显示从全局开关变成逐块展开，或工具折叠/详情交互真正落地；
4. 审批请求的呈现位置、选项、receipt scope 或 reverse-request 协议变更；
5. 真正加入可编辑的权限/安全模式 TUI 后，删除“只读/不支持 mutation”的限定，并附相应命令、port 与验收证据。
