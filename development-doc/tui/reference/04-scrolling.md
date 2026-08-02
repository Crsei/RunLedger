# OpenTUI 组件参考 · 滚动

本篇覆盖可滚动容器和独立滚动条。返回[总索引](./00-opentui-component-index.md)。

## 1. `ScrollBox`

官方路由：`/docs/components/scrollbox`

### 能做什么

- 为任意子组件提供纵向和/或横向滚动 viewport。
- 用 sticky scroll 把视图保持在 top/bottom/left/right 边缘。
- 用户离开 sticky 边缘后暂停自动跟随，回到边缘时恢复。
- 用 viewport culling 跳过不可见 child 的绘制，改善长列表性能。
- 统一或分别配置横向、纵向滚动条。
- 分别配置 root、wrapper、viewport、content 四层内部容器。
- 相对滚动、绝对滚动，或把指定 child 以最小移动距离带入视口。
- 焦点状态下响应方向键、Page Up/Down、Home/End。
- 暴露当前滚动位置和总滚动尺寸。

### 关键入口

- Renderable：`ScrollBoxRenderable`
- Construct：`ScrollBox`
- 关键属性：`scrollX`、`scrollY`、`stickyScroll`、`stickyStart`、`viewportCulling`、`scrollAcceleration`、各内部层 options、滚动条 options
- 运行时属性：`scrollTop`、`scrollLeft`、`scrollWidth`、`scrollHeight`
- 内部实例：`wrapper`、`viewport`、`content`、`horizontalScrollBar`、`verticalScrollBar`

### 控制方法

| 方法 | 用途 |
|---|---|
| `scrollBy(value, mode?)` | 相对移动；可按 line 或 viewport 页移动 |
| `scrollTo(value)` | 跳到绝对位置 |
| `scrollChildIntoView(id)` | 以 nearest 语义把嵌套 child 带入可见区 |

### Sticky scroll

对话和日志通常使用：

```text
stickyScroll = true
stickyStart = "bottom"
```

这不会粗暴地永久锁底：用户主动向上浏览历史后，自动跟随会暂停；只有回到底部边缘才恢复。

### Viewport culling 边界

启用后，不可见 child 的 `renderBefore` 和 `renderAfter` 都不会运行。因此：

- 布局和业务状态不能依赖 render hooks 的副作用。
- 若每个 child 都必须运行 hook，应关闭 `viewportCulling`。
- culling 是渲染优化，不是数据虚拟化或数据卸载机制。

### RunLedger 用途

对话 timeline、工具长输出、后台任务日志和大列表都应优先使用 `ScrollBox`。主对话宜粘底；Session/模型列表通常不粘底，而是在选择变化时调用 `scrollChildIntoView()`。

## 2. `ScrollBar`

官方路由：`/docs/components/scrollbar`

### 能做什么

- 作为独立横向或纵向滚动条显示当前位置。
- 可显示两端箭头。
- 接受鼠标拖动 thumb。
- 获得焦点后支持逐步、分页和首尾键盘导航。
- 用 `onChange` 把新位置回传给外部内容区域。

### 默认键位

| 方向 | 键 |
|---|---|
| 纵向逐步 | `Up` / `Down` 或 `k` / `j` |
| 横向逐步 | `Left` / `Right` 或 `h` / `l` |
| 分页 | `PageUp` / `PageDown` |
| 首尾 | `Home` / `End` |

### 关键入口

- Renderable：`ScrollBarRenderable`
- Construct：当前不可用
- 数据契约：`scrollSize`、`viewportSize`、`scrollPosition`
- 行为属性：`orientation`、`showArrows`、`scrollStep`、`onChange`
- 样式入口：`arrowOptions`、`trackOptions`

### RunLedger 用途

当业务拥有自定义 viewport 或独立的滚动状态时使用。普通内容容器通常直接采用 `ScrollBox` 的内建滚动条，避免同时维护两份位置 authority。

## 3. 两者如何选择

| 场景 | 选择 |
|---|---|
| 需要容纳并滚动真实子组件 | `ScrollBox` |
| 对话新增消息时自动跟随底部 | `ScrollBox` + sticky bottom |
| 大量 child 需要跳过不可见绘制 | `ScrollBox` + viewport culling |
| 自己实现了 viewport，只缺位置控件 | `ScrollBar` |
| 需要独立控制某个 canvas/code surface 的滚动值 | `ScrollBar` 并显式同步 |

不要给同一滚动区域同时保留 `ScrollBox` 内建 authority 和外部 `ScrollBar` authority；若必须使用外部滚动条，应明确单向数据流并防止 `onChange` 回写循环。
