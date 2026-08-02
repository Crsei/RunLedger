# OpenTUI 组件参考 · 布局与视觉

本篇覆盖基础显示、容器和特殊视觉组件。返回[总索引](./00-opentui-component-index.md)。

## 1. `Text`

官方路由：`/docs/components/text`

### 能做什么

- 显示普通字符串或 `StyledText`。
- 设置前景色、背景色以及粗体、暗色、斜体、下划线、闪烁、反色、隐藏、删除线。
- 用 `t` 模板字面量和 `bold()`、`fg()`、`bg()` 等函数在同一段文字中混合样式。
- 支持相对/绝对定位。
- 默认支持鼠标文本选择，适合可复制输出。

### 关键入口

- Renderable：`TextRenderable`
- Construct：`Text`
- 主要属性：`content`、`fg`、`bg`、`attributes`、`selectable`、`position`

### RunLedger 用途

状态栏、footer、键位提示、用户消息、工具摘要和普通日志行都应优先使用 `Text`。纯装饰标签可设 `selectable: false`，审计文本则保持可复制。

## 2. `Box`

官方路由：`/docs/components/box`

### 能做什么

- 作为通用 Flex 容器组织子组件。
- 绘制 `single`、`double`、`rounded`、`heavy` 四类边框。
- 设置背景、内边距、间距、主轴和交叉轴对齐。
- 在上、下边框显示标题，并分别左/中/右对齐。
- 接收鼠标按下、移入和移出事件，可组合为按钮或可点击卡片。
- 支持绝对定位和常规 Renderable 布局属性。

### 关键入口

- Renderable：`BoxRenderable`
- Construct：`Box`
- 主要属性：`width`、`height`、`backgroundColor`、`border`、`borderStyle`、`title`、`bottomTitle`、`padding`、`gap`、`flexDirection`、`justifyContent`、`alignItems`

### RunLedger 用途

主屏、消息卡片、overlay、选择器、输入框边界和 footer 布局都应由 `Box` 组装。它负责结构，不应承载 Agent 或 Session 业务状态。

## 3. `ASCIIFont`

官方路由：`/docs/components/ascii-font`

### 能做什么

- 把字符串渲染为 ASCII art 大字。
- 提供 `tiny`、`block`、`shade`、`slick`、`huge`、`grid`、`pallet` 七种字体。
- 接收单色或颜色带，并可设置背景色和文本选择色。
- 动态更新 `text`，可用于计数器或状态大字。
- 通过多个绝对定位实例叠加出阴影等效果。

### 关键入口

- Renderable：`ASCIIFontRenderable`
- Construct：`ASCIIFont`
- 主要属性：`text`、`font`、`color`、`backgroundColor`、`selectable`、`selectionBg`、`selectionFg`

### RunLedger 用途

适合首次启动欢迎页、空状态或演示模式标题。不适合持续占据对话主屏，因为大字会显著压缩终端可用行数。

## 4. `FrameBuffer`

官方路由：`/docs/components/frame-buffer`

### 能做什么

- 提供二维 cell 缓冲区，直接写字符、前景色、背景色和文本属性。
- 用 `setCellWithAlphaBlending()` 绘制透明混合效果。
- 用 `drawText()` 绘制字符串，用 `fillRect()` 填充矩形。
- 用 `drawFrameBuffer()` 把另一个缓冲区的局部区域合成进当前缓冲区。
- 用 `colorMatrixUniform()` 或 `colorMatrix()` 对整个缓冲区或指定 cell 做 RGBA 矩阵变换。
- 支持自定义图表、动画、游戏画布、进度条和复杂视觉效果。

### 关键入口

- Renderable：`FrameBufferRenderable`
- Construct：`FrameBuffer`
- 主要属性：`width`、`height`、`respectAlpha`、`position`
- 绘制入口：实例的 `frameBuffer`

### 使用边界

- 应在一次 render 周期前批量完成更新。
- 循环中复用 `RGBA` 对象，避免频繁构造颜色。
- 复杂形状可用逐 cell 写入，大片单色区域再用 `fillRect()`。

### RunLedger 用途

可用于 token/context 占用图、长任务进度或调试可视化。普通消息、边框和表格仍应使用高层组件，以保留布局、选择和可访问交互语义。

## 5. `QRCode`

官方路由：`/docs/components/qr-code`

### 能做什么

- 把文本或 URL 渲染为终端内可扫描的 QR Code Model 2。
- 用半块字符保持终端 cell 几何下的正方形模块。
- 按 QR 版本、quiet zone 和 scale 自动测量尺寸。
- `fit: "contain"` 时可在父容器受限时缩小；`fit: "none"` 时坚持配置比例。
- 容器小到无法显示 scale-1 二维码时展示 fallback 文本。
- 配置纠错级别，提高受损或拍摄条件不佳时的恢复能力。

### 关键入口

- 独立依赖：`@opentui/qrcode`
- Core renderable：`QRCodeRenderable`
- React：先调用 `registerQRCode()`，再使用 `<qr-code>`
- Solid：先调用 `registerQRCode()`，再使用 `<qr_code>`
- 主要属性：`content`、`errorCorrectionLevel`、`quietZone`、`scale`、`fit`、前/背景色、fallback 内容

### 使用边界

标准 quiet zone 至少为 4 个模块。组件能验证矩阵与几何，但扫描成功率仍取决于终端字体、cell 宽高比、颜色对比度和摄像条件。

### RunLedger 用途

适合展示远程控制连接地址、审计报告链接或设备配对信息。引入它意味着新增独立包，不能把它视为 `@opentui/core` 零成本能力。

## 6. `TimeToFirstDraw`

官方路由：`/docs/components/time-to-first-draw`

### 能做什么

- 在第一次 `renderSelf()` 时保存 `performance.now()` 读数。
- 后续渲染持续显示同一个读数。
- `reset()` 后在下一次绘制重新捕获。
- 可定制标签、颜色、精度和布局。
- Core、React、Solid 都有公开组件入口。

### 关键入口

- Core：`TimeToFirstDrawRenderable`
- React/Solid：`TimeToFirstDraw`
- 运行时成员：`runtimeMs`、`fg`/`color`、`textLabel`、`decimals`、`reset()`

### 重要边界

它显示的是相对于运行时 performance time origin 的“首绘时间戳”，没有减去 renderer 创建时间或应用启动时间。因此它不能直接回答“RunLedger 启动花了多少毫秒”。要测启动耗时，业务层必须持有自己的起点并计算差值。

`precision` 最终传给 `toFixed()`；有效范围应控制在 0–100，超过 JavaScript 上限会在绘制时抛错。

### RunLedger 用途

适合开发诊断面板或首屏 smoke test，不应作为普通用户界面的永久状态项。
