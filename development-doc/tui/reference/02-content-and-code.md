# OpenTUI 组件参考 · 内容、代码与差异

本篇覆盖 Agent 输出、源码、diff、行号和表格。返回[总索引](./00-opentui-component-index.md)。

## 1. `Code`

官方路由：`/docs/components/code`

### 能做什么

- 使用 Tree-sitter 对源码做语法高亮。
- 通过 `SyntaxStyle.fromStyles()` 为 keyword、string、comment、function、type 等 token 分配前景/背景色和文字属性。
- 支持 TypeScript/JavaScript、Markdown、Zig，以及有 Tree-sitter grammar 的其他语言。
- `streaming: true` 时适配 LLM 或工具的增量源码输出。
- 默认允许文本选择，并可自定义选区颜色。
- `conceal` 可隐藏 Markdown 等语法中的格式标记。
- 可与 `LineNumberRenderable`、`ScrollBoxRenderable` 组合成带行号的滚动源码视图。
- 暴露行数、横纵滚动位置、滚动尺寸、高亮状态和最终 plain text。

### 关键入口

- Renderable：`CodeRenderable`
- Construct：`Code`
- 关键属性：`content`、`filetype`、`syntaxStyle`、`streaming`、`conceal`、`drawUnstyledText`、`treeSitterClient`
- 继承属性：`fg`、`bg`、`selectable`、选区颜色、`wrapMode`、`tabIndicator`

### 流式行为

每次高亮仍处理完整的当前 `content`。当 `streaming` 为真且 `drawUnstyledText` 为假时，新的 one-shot 高亮完成前会保留旧缓冲区，减少增量输出闪烁；这不是增量解析完整源码的承诺。

### RunLedger 用途

用于 `read` 工具结果、代码块、错误位置上下文和流式生成的源码。filetype 必须由工具结果或 fence 信息明确提供，不能盲猜。

## 2. `Markdown`

官方路由：`/docs/components/markdown`

### 能做什么

- 渲染标题、段落、列表、引用、行内样式、代码块和表格。
- 用 `SyntaxStyle` 控制 Markdown token 以及 fenced code 的语法样式。
- 把 `tsx`、`.jsx`、带标题的 fence info、`Dockerfile` 等归一化为 Tree-sitter filetype，并允许扩展映射。
- 分别控制普通 Markdown 标记和 fenced code 标记的 conceal。
- 支持增量更新；结束流式阶段后再完成尾部块解析。
- 在实验性 `internalBlockMode: "top-level"` 下暴露 `_stableBlockCount`，让宿主把稳定的头部块提交到 scrollback。
- 内建 Markdown 表格，可控制 grid/columns 风格、宽度分配、换行、边框、padding 和选择。
- 用 `renderNode` 替换指定 token 的渲染，也能为自定义 fenced language 构造专用组件。

### 关键入口

- Renderable：`MarkdownRenderable`
- Construct：当前不可用
- 关键属性：`content`、`syntaxStyle`、`fg`、`bg`、`conceal`、`concealCode`、`streaming`、`tableOptions`、`internalBlockMode`、`treeSitterClient`、`renderNode`

### 流式行为

```text
开始 assistant 输出 -> streaming = true
持续追加 content    -> 未完成尾块允许变化
收到完成事件         -> streaming = false
最终化尾部段落/表格/代码块
```

`top-level` block 模式是实验能力；普通非流式渲染应保留默认的 `coalesced`。

### RunLedger 用途

这是 AssistantMessage 主体的首选组件。若接入稳定块 scrollback，必须把 `_stableBlockCount` 当作特定 OpenTUI 快照的实验契约，不提升为 RunLedger 稳定领域接口。

## 3. `Diff`

官方路由：`/docs/components/diff`

### 能做什么

- 解析并显示 unified diff 字符串。
- 在 `unified` 单栏和 `split` 双栏间切换。
- 对 diff 内代码按 filetype 和 `SyntaxStyle` 高亮。
- 显示行号并单独定制新增/删除行号区域。
- 分别设置新增、删除、上下文行以及其内容区域的背景色。
- 自定义 `+`/`-` 标记颜色、选区颜色、换行和 conceal。
- 在 split 模式启用 `syncScroll`，让左右栏垂直滚动联动。

### 关键入口

- Renderable：`DiffRenderable`
- Construct：当前不可用
- 关键属性：`diff`、`view`、`syncScroll`、`filetype`、`syntaxStyle`、`wrapMode`、`showLineNumbers`、各类行号/内容/符号颜色

### 使用边界

- 输入必须是 unified diff 文本，不是任意 before/after 字符串。
- `syncScroll` 在 unified 视图中无效果。
- 组件负责展示，不负责生成 patch、验证 patch 或批准文件写入。

### RunLedger 用途

适合承接 `edit`、`multi-edit` 和审计 patch 预览。现有 RunLedger `DiffPreviewComponent` 若迁移到 OpenTUI，应保留业务层的 pending/running/ok/error 状态和脱敏策略，只替换内容渲染层。

## 4. `LineNumber`

官方路由：`/docs/components/line-number`

### 能做什么

- 给实现 `LineInfoProvider` 的目标 Renderable 增加行号 gutter。
- 设置 gutter 前景/背景色、最小宽度和右侧 padding。
- 给单行设置 gutter/content 背景色。
- 在行号前后放置 sign，可独立着色。
- 隐藏指定行的行号、批量重写显示行号或添加整体 offset。
- 在运行时启用/关闭行号显示。

### 关键入口

- Renderable：`LineNumberRenderable`
- Construct：当前不可用
- 目标：`CodeRenderable` 或其他 `Renderable & LineInfoProvider`
- 方法：`setLineColor()`、`clearLineColor()`、`setLineSign()`、`clearLineSign()`、`setLineNumbers()`、`setHideLineNumbers()`

### RunLedger 用途

用于源码预览中的错误行、搜索命中、当前执行点或 diff 上下文。行号组件是目标内容的装饰器，不自行持有源码。

## 5. `TextTable`

官方路由：`/docs/components/text-table`

### 能做什么

- 渲染二维 `TextChunk` 单元格数组，每个 cell 可有独立富文本样式。
- 接受不等长行；缺失、`null`、`undefined` cell 显示为空。
- 用 `full` 模式填满约束宽度，或用 `content` 保持固有宽度。
- 宽度不足时按 word/char 换行，用 proportional/balanced 两种算法分配列宽。
- 独立控制内部网格和外边框；支持四种边框风格、边框显隐和列间距。
- 控制 cell 的横纵 padding。
- 支持 cell 内局部选择、单列选择和跨 cell 网格选择。
- `getSelectedText()` 以 tab 拼接同一行 cell，以换行拼接多行，不包含边框字符。
- 可通过 `content` setter 动态替换整张表。

### 关键入口

- 仅命令式：`TextTableRenderable`
- 当前未注册为内建 React/Solid 组件
- 内容类型：`TextTableContent = TextTableCellContent[][]`
- 关键属性：`content`、`wrapMode`、`columnWidthMode`、`columnFitter`、padding、gap、border、颜色和 selection 配置

### 重要边界

- 第一行没有特殊 header 语义；把它加粗只是一种显示约定。
- `showBorders: false` 只是不绘制 glyph，已启用边框预留的空间仍存在。
- 该组件始终使用 buffered surface。

### RunLedger 用途

适合 Session catalog、TaskList、模型列表、工具统计和 trace 摘要。若数据需要行级激活/命令操作，应在表格外建立 selection/action 状态，不把 `TextTable` 误当成 `Select`。
