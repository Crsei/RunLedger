# OpenTUI 组件参考 · 总索引

> 本参考基于 OpenTUI 官方组件文档生成，源快照为 `anomalyco/opentui@da5507e1b3d637b946a12b71fb47d112b5d38393`，整理日期为 2026-08-02。
>
> “全部组件”在本文中指该快照 `packages/web/src/content/docs/components/` 下有独立官方文档的 18 个组件。Renderer、布局引擎、键盘系统、插件和 React/Solid hooks 属于框架能力，不混入组件清单。

## 1. 快速选择

| 想实现的能力 | 首选组件 | 说明 |
|---|---|---|
| 普通文字、状态栏、富文本片段 | `Text` | 支持颜色、文本属性、行内混合样式和复制选择 |
| 面板、卡片、边框和 Flex 布局 | `Box` | OpenTUI 组件树的通用容器 |
| 欢迎页大字标题 | `ASCIIFont` | 7 种 ASCII 字体，可动态更新和多色渲染 |
| 自定义终端图形、进度条、游戏画布 | `FrameBuffer` | 逐 cell 绘制、透明混合、矩形和缓冲区合成 |
| 显示可扫描链接 | `QRCode` | 独立 `@opentui/qrcode` 包，支持自适应和纠错级别 |
| 显示首次绘制时间戳 | `TimeToFirstDraw` | 用于诊断首绘时刻，不等同于启动耗时 |
| 语法高亮源码 | `Code` | Tree-sitter 高亮、流式更新、选择、conceal |
| 流式渲染助手 Markdown | `Markdown` | Markdown、代码块、表格、稳定块前缀、自定义节点 |
| 展示工具修改内容 | `Diff` | unified/split diff、语法高亮、行号、双栏同步滚动 |
| 给源码或编辑器增加行号槽 | `LineNumber` | 行号、行标记、逐行颜色、行号重映射 |
| 状态表、任务表、会话表 | `TextTable` | 样式化单元格、宽度分配、换行、边框、表格选择 |
| 单行搜索、命名和配置输入 | `Input` | placeholder、焦点样式、长度约束、输入/提交事件 |
| 主提示词编辑器 | `Textarea` | 多行编辑、选择、撤销/重做、可配置键位和编辑器 traits |
| 垂直选项列表 | `Select` | 描述、键盘导航、预览联动和程序化选择 |
| 水平标签页 | `TabSelect` | 描述、横向滚动、键位定制和面板切换 |
| 连续数值控制 | `Slider` | 水平/垂直滑块、范围和值变化回调 |
| 对话记录、日志、长列表 | `ScrollBox` | 双向滚动、粘底、视口裁剪、自定义滚动条 |
| 独立滚动位置控制 | `ScrollBar` | 横/竖滚动条、箭头、键盘与拖动控制 |

## 2. 文档导航

| 文档 | 组件 |
|---|---|
| [01-layout-and-visual.md](./01-layout-and-visual.md) | `Text`、`Box`、`ASCIIFont`、`FrameBuffer`、`QRCode`、`TimeToFirstDraw` |
| [02-content-and-code.md](./02-content-and-code.md) | `Code`、`Markdown`、`Diff`、`LineNumber`、`TextTable` |
| [03-input-and-selection.md](./03-input-and-selection.md) | `Input`、`Textarea`、`Select`、`TabSelect`、`Slider` |
| [04-scrolling.md](./04-scrolling.md) | `ScrollBox`、`ScrollBar` |

## 3. API 形态速查

OpenTUI 文档中的 API 形态含义如下：

- Renderable API：`new XxxRenderable(renderer, options)`，适合需要持有实例、监听事件和持续 mutation 的命令式代码。
- Construct API：`Xxx(options, ...children)`，是简化的命令式构造函数。
- React/Solid：由对应 binding 映射为 JSX；是否有独立包装组件以各组件文档为准。

| 组件 | Renderable | Construct | 官方文档中的额外绑定说明 |
|---|---:|---:|---|
| `Text` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `Box` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `ASCIIFont` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `FrameBuffer` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `Code` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `Input` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `Select` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `TabSelect` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `ScrollBox` | 是 | 是 | 组件页未单列 React/Solid 专项说明 |
| `Markdown` | 是 | 否 | 当前应直接使用 `MarkdownRenderable` |
| `Diff` | 是 | 否 | 当前应直接使用 `DiffRenderable` |
| `LineNumber` | 是 | 否 | 当前应直接使用 `LineNumberRenderable` |
| `Textarea` | 是 | 否 | 当前应直接使用 `TextareaRenderable` |
| `Slider` | 是 | 否 | 当前应直接使用 `SliderRenderable` |
| `ScrollBar` | 是 | 否 | 当前应直接使用 `ScrollBarRenderable` |
| `TextTable` | 是 | 否 | 仅命令式 API；未注册为内建 React/Solid 组件 |
| `QRCode` | 是 | 不适用 | `@opentui/qrcode`；React/Solid 需分别注册 |
| `TimeToFirstDraw` | 是 | 不适用 | Core、React、Solid 均有公开入口 |

未单列 binding 说明的组件，具体 JSX 名称和行为应继续查 React/Solid binding 文档，不能从 Construct API 名称直接推断。

## 4. 对 RunLedger 最有价值的组合

### 4.1 对话主屏

```text
Box
└── ScrollBox(stickyScroll="bottom")
    ├── Markdown(streaming=true)       助手增量内容
    ├── Code(streaming=true)           代码工具或代码块
    ├── Diff                           编辑结果
    └── Text / TextTable               状态、任务和结构化结果
```

底部输入区适合 `Textarea`，外层由 `Box` 提供边框和布局。流式 Markdown 结束时必须把 `streaming` 切回 `false`，让尾部未闭合块完成解析。

### 4.2 选择器和设置面板

- `Select`：模型、Session、Thinking level、命令面板等垂直选项。
- `TabSelect`：同一 overlay 内的类别切换或多面板导航。
- `Input`：搜索词、名称、路径等单行值。
- `Slider`：温度、比例、阈值等连续数值；不适合离散枚举。

### 4.3 工具与审计视图

- `Diff`：`edit` / `multi-edit` 的 patch 展示。
- `Code + LineNumber`：`read`、错误定位、源码预览。
- `TextTable`：Task、Session、工具调用统计和审计摘要。
- `ScrollBox`：长日志或工具输出；粘底只应在用户仍位于底部时生效。

## 5. 共同约束

- 尺寸由 OpenTUI 布局系统控制，常见值为字符数、`"auto"` 或百分比字符串。
- 获得焦点的交互组件才消费键盘输入；宿主必须维护明确的 focus owner。
- `Text`、`Code`、`TextTable` 等默认可选择内容，展示密钥、token 或完整工具参数时仍须在数据进入组件前完成脱敏。
- `Code`、`Markdown`、`Diff` 的高亮依赖语法样式和 Tree-sitter 能力；组件不会替代业务层的内容分类。
- `FrameBuffer` 是低层绘制面，不应替代普通布局组件。
- `TimeToFirstDraw` 捕获的是 `performance.now()` 的首次绘制读数，不是从应用启动点计算的 duration。

## 6. 官方路由

各组件的稳定官方路由均为 `/docs/components/<slug>`，例如：

- `/docs/components/text`
- `/docs/components/markdown`
- `/docs/components/diff`
- `/docs/components/textarea`
- `/docs/components/scrollbox`

本目录是面向 RunLedger 的中文能力索引；属性的最终类型、默认值和版本差异以同一 OpenTUI 快照的官方文档与类型声明为准。
