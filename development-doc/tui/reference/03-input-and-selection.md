# OpenTUI 组件参考 · 输入与选择

本篇覆盖表单、主编辑器、列表、标签页和数值滑块。返回[总索引](./00-opentui-component-index.md)。

## 1. `Input`

官方路由：`/docs/components/input`

### 能做什么

- 编辑单行字符串，显示 cursor 和 placeholder。
- 为普通状态与 focus 状态配置不同背景色。
- 配置文字、cursor 颜色和长度上下限。
- 读写 `value`，并在程序侧动态赋值。
- 通过 focus/blur 决定是否接收键盘输入。

### 事件语义

| 事件 | 触发时机 |
|---|---|
| `INPUT` | 插入、删除或赋予不同 `value` 后，返回当前值 |
| `CHANGE` | blur 或 Enter 时触发，但仅限自获得焦点后值发生变化 |
| `ENTER` | Enter/Return 提交成功时；低于 `minLength` 不触发 |

长度约束按 JavaScript UTF-16 code unit 计数，不等同于用户感知字符数或终端显示宽度。

### 关键入口

- Renderable：`InputRenderable`
- Construct：`Input`
- 事件集合：`InputRenderableEvents`
- 关键属性：`width`、`value`、`placeholder`、`minLength`、`maxLength`、普通/焦点背景色、`textColor`、`cursorColor`

### RunLedger 用途

用于 Session 搜索、模型过滤、重命名、路径或短配置输入。Agent prompt 通常包含多行，应使用 `Textarea`。

## 2. `Textarea`

官方路由：`/docs/components/textarea`

### 能做什么

- 多行文本编辑、word/char/none 换行、placeholder 和焦点样式。
- 配置提交键，并通过 `onSubmit` 获取提交动作。
- 监听内容和 cursor 变化。
- 暴露 plain text、逻辑 cursor、换行后的视觉 cursor 和 buffer offset。
- 程序化移动 cursor：字符、单词、逻辑行、视觉行、buffer 首尾。
- 支持半开区间/闭区间选择、全选、清除选择和删除选择。
- 插入字符/文本，执行前删、后删、删词、删到行首/尾、删行和换行。
- 内建 undo/redo。
- 自定义 key bindings 和 key alias。
- 用 `EditorTraits` 告知宿主它想捕获哪些键、是否希望暂时弱化周边 chrome，以及 footer 状态文案。

### 关键入口

- Renderable：`TextareaRenderable`
- Construct：当前不可用
- 关键回调：`onSubmit`、`onContentChange`、`onCursorChange`
- 关键属性：`initialValue`、`placeholder`、颜色、`wrapMode`、selection、cursor、`keyBindings`、`traits`

### Editor traits

| 字段 | 能力 |
|---|---|
| `capture` | 请求优先消费 `escape`、`navigate`、`submit`、`tab` 等键 |
| `suspend` | 提示宿主弱化边框、隐藏 hints 等环境 UI |
| `status` | 提供 footer 可显示的短编辑模式标签 |

traits 变化会发出 `traits-changed`；Renderable 销毁时重置为空对象。

### RunLedger 用途

这是主 prompt editor 的首选。宿主键位系统必须先解析 editor traits，再决定是否执行全局快捷键；Ctrl+C、Ctrl+D 等生命周期键仍应遵守 RunLedger 的统一 authority，不能仅因编辑器请求 capture 就改变退出语义。

## 3. `Select`

官方路由：`/docs/components/select`

### 能做什么

- 以垂直列表展示 `{ name, description, value? }` 选项。
- 显示/隐藏描述、选择 indicator 和滚动 indicator。
- 为普通、焦点、当前选择及描述配置不同颜色。
- 支持边界停止或循环选择。
- 配置 item 间距和快速滚动步长。
- 在 highlight 变化时驱动右侧 preview；Enter 时提交当前项。
- 程序化读取/设置选中项、移动、触发提交和替换 options。

### 默认键位

| 键 | 动作 |
|---|---|
| `Up` / `k` | 上移一项 |
| `Down` / `j` | 下移一项 |
| `Shift+Up` / `Shift+Down` | 默认跨 5 项快速移动 |
| `Enter` | 提交当前项 |

### 事件

- `SELECTION_CHANGED`：highlight 改变，适合更新预览。
- `ITEM_SELECTED`：用户按 Enter，适合执行选择结果。

### 关键入口

- Renderable：`SelectRenderable`
- Construct：`Select`
- 事件集合：`SelectRenderableEvents`
- 控制方法：`getSelectedIndex()`、`getSelectedOption()`、`setSelectedIndex()`、`moveUp()`、`moveDown()`、`selectCurrent()`

### RunLedger 用途

模型、Session、Thinking level、命令面板和信任选项都适用。必须区分“当前高亮”与“已经提交”，避免导航时直接改变持久化设置。

## 4. `TabSelect`

官方路由：`/docs/components/tab-select`

### 能做什么

- 横向排列多个 tab，每项可带描述。
- 为普通、焦点和选中 tab 分别着色。
- 显示选中下划线和横向滚动箭头。
- tab 数量超出宽度时自动随键盘导航横向滚动。
- 支持循环选择、自定义键位和 key alias。
- 分离 highlight 变化与 Enter 提交。
- 通过程序 API 获取/设置当前 tab 或整体替换 options。

### 默认键位

| 键 | 动作 |
|---|---|
| `Left` / `[` | 前一个 tab |
| `Right` / `]` | 后一个 tab |
| `Enter` | 提交当前 tab |

### 关键入口

- Renderable：`TabSelectRenderable`
- Construct：`TabSelect`
- 事件集合：`TabSelectRenderableEvents`
- 关键属性：`options`、`tabWidth`、颜色、`showScrollArrows`、`showDescription`、`showUnderline`、`wrapSelection`、`keyBindings`

### RunLedger 用途

适合 overlay 内切换“会话/模型/工具”等类别，或在审计视图切换 summary/events/artifacts。它只负责 tab 选择，内容 panel 的移除和添加仍由宿主处理。

## 5. `Slider`

官方路由：`/docs/components/slider`

### 能做什么

- 表示 `min` 到 `max` 之间的连续数值。
- 横向或纵向显示。
- 鼠标拖动 thumb，并在值变化时调用 `onChange`。
- 用 `viewPortSize` 参与 thumb 尺寸计算。
- 分别设置 track 背景和 thumb 前景色。

### 关键入口

- Renderable：`SliderRenderable`
- Construct：当前不可用
- 关键属性：`orientation`、`value`、`min`、`max`、`viewPortSize`、`backgroundColor`、`foregroundColor`、`onChange`

### RunLedger 用途

可用于百分比阈值、透明度、日志 tail 大小或其他连续配置。Thinking level、权限模式、provider 等离散值应使用 `Select`，避免滑块值和领域枚举之间产生隐式转换。
