# 05 · 主题系统

RunLedger 使用用户级 `settings.json` 的 `uiTheme` 配置主体颜色；`theme` 与 `/theme` 保持代码语法高亮的既有含义。实施与验收见 [Plan 27](27-configurable-ui-theme-and-thinking-color-plan.md)。

## 配置

位置由 composition root 的 `RunledgerLayout.settings` 决定，默认 `~/.runledger/settings.json`；合法 `RUNLEDGER_DIR` 使用该目录的 settings。仅用户层生效，workspace 层忽略 `uiTheme`。修改后重启生效。

```json
{
  "uiTheme": {
    "preset": "default",
    "mode": "auto",
    "colors": {
      "common": { "accent": "#7dcfff" },
      "dark": { "thinkingText": "#777d88" },
      "light": { "thinkingText": "#6c6c6c" }
    }
  }
}
```

预设为 `default`、`neutral`、`high-contrast`，各含 dark/light。缺省 `default + auto`。`mode` 支持 auto、dark、light；auto 跟随 OpenTUI `theme_mode`，探测前使用 dark，固定模式不随终端事件改变。配置示例见 [examples/ui-themes](../../examples/ui-themes/README.md)。

优先级从低到高：内置预设 → `colors.common` → 当前模式的 `colors.dark/light` → `RUNLEDGER_THEME_<KEY>`。KEY 为字段名全大写，例如 `RUNLEDGER_THEME_THINKINGTEXT=#909090`。

仅接受 `#RRGGBB`。错误字段忽略并提示，保留其他合法值；不执行命令、不读取任意主题路径、不自动创建或覆盖用户配置。未配置字段继承预设。显式 `editorBackground` 优先于终端背景探测；未覆盖时沿用背景混色算法。无显式 `background` 时保留终端背景对输入区的自适应。

## 色槽与使用位置

| 色槽 | 使用范围 |
| --- | --- |
| `primary` | 一般原生文本、输入文字、overlay 普通文字；Footer 无 syntax 颜色的文字 |
| `assistantMessage` | 普通回答 Markdown 默认文字、transcript 回答 |
| `thinkingText` | 思考 Markdown 默认文字、稳定片段、transcript 思考 |
| `userMessage` | 用户消息文字、transcript 用户文字 |
| `secondary` | 选择列表描述、shimmer 中间色、传统组件次要文字 |
| `accent` | 输入提示、选择项前景、Markdown 行内代码、shimmer 高亮 |
| `muted` | 分隔文字、shimmer 低亮度、传统组件弱提示 |
| `hint` | 输入 placeholder、提示文字、shimmer 键位 |
| `info` | Markdown 标题、info notice 基础文字 |
| `warning`、`error` | 对应 notice 的基础文字；局部 syntax 状态标记仍可覆盖 |
| `success` | 传统 Markdown 工厂代码块的默认色；native 代码块由 syntax theme 控制 |
| `background` | 主界面和 overlay 表面、输入区混色的回退背景 |
| `surface` | 滚动轨道、overlay 输入表面 |
| `surfaceAlt` | overlay 选择项背景 |
| `border` | overlay 边框、输入主题边框 |
| `editorBackground` | 输入区和用户消息整行背景 |
| `toolCall`、`toolResult`、`toolError` | 运行中、成功、失败工具块基础文字及探索摘要；命令 syntax/输出 ANSI/状态标记保留局部颜色 |
| `status` | 非 shimmer 状态行基础色、Welcome 元数据 |
| `link` | Markdown 链接文字与 URL |

色槽控制对应基础文字；代码块、diff、Mermaid 与 Footer 的 syntax 语义色不被强制统一染色。思考默认只改变叙述文字颜色，保留 Markdown 局部高亮，不默认增加斜体。

## 实现接线

- `src/contracts/ui-theme.ts` 定义纯配置 DTO 与输入校验，storage 不依赖 TUI。
- `src/tui/theme/ui-theme.ts` 解析完整的不可变颜色快照，记录背景覆盖来源与展示 revision。
- `InteractiveMode` 将同一快照下发给 OpenTUI frame，原组件读取共享 Theme；UI 模式和 syntax theme 的真实终端模式分开。
- `rowToBlocks()` 将思考标记为 Markdown `variant: thinking`；registry 管理普通/思考样式，稳定前缀与主题切换均保留语义。
- OpenTUI `MarkdownRenderable` 的 `fg` 和 syntax default 同步更新。切换主题必须先 `refreshStyles()` 更新子节点，再恢复 finalized 状态并释放旧样式，避免已完成段落变空白。
- transcript 先按可见文字宽度换行，再使用 truecolor ANSI 着色；主题 generation 使历史行缓存失效。

自动化证据、构建后的 CLI 验证与人工/跨平台验收分别记录在 Plan 27；不得用自动字符捕获宣称人工视觉通过。
