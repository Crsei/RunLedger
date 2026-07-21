# 05 · 主题系统

> 本文档定义 RunLedger TUI 的 20 色槽主题 schema、dark/light 占位值、`theme.fg/bg` API,以及 OSC 11 跟随切换的接入路径。

---

## 1. 设计动机

pi 主题有 ~70 个色槽,服务于彩蛋 / 扩展 / 各种细化状态。RunLedger 只复刻 11 个业务组件,把色槽收敛到 **20 个**,达成:

- 每个槽都有明确使用场景(无"孤儿槽");
- dark/light 两套默认值落地即可演示;
- 未来如果要扩展,新增槽即可,不破坏 decode。

---

## 2. 色槽 schema

```ts
// src/tui/theme/theme.ts
export interface ThemeColors {
  // ── 基础文字 ──────────────────────────────────────
  text: string;        // 主文本,默认前景色
  dim: string;         // 次要文本(注释 / 时间戳 / placeholder)
  accent: string;      // 强调(logo / 当前项 marker / 加粗 token)
  secondary: string;   // 次强调(sidebar 状语 / 工具名)
  error: string;       // 错误文本 + error 状态边框
  success: string;      // 成功结果(✓ / done 状态)
  border: string;      // 通用边框

  // ── 消息气泡 ──────────────────────────────────────
  userMessageBg: string;       // 用户消息背景色
  assistantMessageBg: string;  // 助手消息背景色(暗,pod 0 透明感)
  thinkingFg: string;          // thinking 块文本色(展开后)

  // ── 工具 ──────────────────────────────────────────
  toolPendingBg: string;       // 工具运行中边框色
  toolBorder: string;          // 工具默认 / 完成边框色
  toolErrorBg: string;         // 工具错误边框色 + 错误结果背景
  bashCommand: string;         // bash 命令文本色
  bashStdout: string;          // bash 输出文本色
  bashStderr: string;          // bash 错误文本色

  // ── 状态 / 提示 ───────────────────────────────────
  statusWorking: string;       // spinner working 颜色
  statusError: string;         // spinner error 颜色
  pendingBlocked: string;      // PendingMessages 阻塞着色
  footerBg: string;            // footer 背景色

  // ── markdown code ────────────────────────────────
  mdCodeBlock: string;         // ``` 块边框 + 背景
}
```

**总数 = 20**。可以做到"少 1 项无法运行,多 1 项可被精简"。每个槽与组件的对应见第 4 节。

---

## 3. Theme API

```ts
// src/tui/theme/theme.ts
export interface Theme {
  readonly scheme: "dark" | "light";
  readonly colors: Readonly<ThemeColors>;
  /** 用色槽包裹文本作为前景色(自动 reset) */
  fg(key: ColorKey, text: string): string;
  /** 用色槽作为背景色包裹 */
  bg(key: BgColorKey, text: string): string;
}

export type ColorKey = keyof ThemeColors;
export type BgColorKey =
  | "userMessageBg"
  | "assistantMessageBg"
  | "toolPendingBg"
  | "toolErrorBg"
  | "footerBg"
  | "mdCodeBlock";

export function loadTheme(scheme: "dark" | "light", overrides?: Partial<ThemeColors>): Theme;
```

`fg` / `bg` 内部用 ANSI 24-bit truecolor `\x1b[38;2;R;G;Bm...\x1b[39m` / `\x1b[48;2;R;G;Bm...\x1b[49m`,自动 reset。

color 解析: `#RRGGBB` / `rgb(r,g,b)` / 命名色(可选,本期不实现,只 16 进制)。

---

## 4. 色槽到组件映射表

| 色槽 | 使用组件 | 使用场景 |
|------|----------|----------|
| `text` | 所有 leaf 组件 | 默认前景 |
| `dim` | `KeybindingHints` 提示、`FooterComponent` 标签、时间戳 | 次要信息 |
| `accent` | `KeybindingHints` logo、`SelectList` 高亮、`DynamicBorder` running 状态 | 焦点区 |
| `secondary` | `ToolExecutionComponent` `toolName`、`FooterComponent` model label | 标签类 |
| `error` | `ToolExecutionComponent` error 边框、`StatusIndicator` error spinner、错误 tool_result | 错误展示 |
| `success` | `ToolExecutionComponent` done 状态、✓ 标记 | 成功 |
| `border` | `CustomMessageComponent` 框线、`LoadedResources` 分隔 | 通用 |
| `userMessageBg` | `UserMessageComponent` 背景 | 整区块 |
| `assistantMessageBg` | `AssistantMessageComponent` 背景(可选) | 整区块 |
| `thinkingFg` | thinking 块文本(展开时) | 折叠展开 |
| `toolPendingBg` | `ToolExecutionComponent` 边框 running | 工具状态 |
| `toolBorder` | `ToolExecutionComponent` 边框 done | 同上 |
| `toolErrorBg` | `ToolExecutionComponent` 边框 error / result | 同上 |
| `bashCommand` | `BashExecutionComponent.commandText` | shell 高亮 |
| `bashStdout` | `BashExecutionComponent.appendOutput` | stdout 色 |
| `bashStderr` | `BashExecutionComponent.appendError` | stderr 色 |
| `statusWorking` | `StatusIndicator.kind="working"` | spinner 主体 |
| `statusError` | `StatusIndicator.kind="error"` | 错误 spinner |
| `pendingBlocked` | `PendingMessages.state="blocked"` | 着色警示 |
| `footerBg` | `FooterComponent` 整行背景 | 状态栏 |
| `mdCodeBlock` | `Markdown` 渲染 ``` ` ``` 块 | 代码块 |

每个色槽只对应上表中的 1 种用途(单一职责)。

---

## 5. dark.json(占位值)

```json
{
  "$schema": "./theme-schema.json",
  "scheme": "dark",
  "colors": {
    "text": "#e6e6e6",
    "dim": "#808080",
    "accent": "#7aa2f7",
    "secondary": "#bb9af7",
    "error": "#f7768e",
    "success": "#9ece6a",
    "border": "#3b3f50",
    "userMessageBg": "#1f2430",
    "assistantMessageBg": "#16181e",
    "thinkingFg": "#9d7cd8",
    "toolPendingBg": "#1a1b26",
    "toolBorder": "#414868",
    "toolErrorBg": "#34162a",
    "bashCommand": "#7dcfff",
    "bashStdout": "#c0caf5",
    "bashStderr": "#f7768e",
    "statusWorking": "#7aa2f7",
    "statusError": "#f7768e",
    "pendingBlocked": "#e0af68",
    "footerBg": "#16181e",
    "mdCodeBlock": "#1a1b26"
  }
}
```

色调参考 Tokyo Night(M 网络),warm-cool 平衡,对 Windows Terminal / iTerm2 / Kitty 默认配色都兼容。

---

## 6. light.json(占位值)

```json
{
  "$schema": "./theme-schema.json",
  "scheme": "light",
  "colors": {
    "text": "#343b58",
    "dim": "#9699a3",
    "accent": "#34548a",
    "secondary": "#8c4ab8",
    "error": "#8c4351",
    "success": "#485e30",
    "border": "#d5d3d1",
    "userMessageBg": "#e9e8e6",
    "assistantMessageBg": "#f5f5f5",
    "thinkingFg": "#8c4ab8",
    "toolPendingBg": "#e3e3e3",
    "toolBorder": "#9aa5ce",
    "toolErrorBg": "#f0d4dc",
    "bashCommand": "#34548a",
    "bashStdout": "#343b58",
    "bashStderr": "#8c4351",
    "statusWorking": "#34548a",
    "statusError": "#8c4351",
    "pendingBlocked": "#915c00",
    "footerBg": "#e9e8e6",
    "mdCodeBlock": "#f0f0f0"
  }
}
```

色调参考 Tokyo Night Light / Day,亮主题下保留 accents 反差。

---

## 7. `theme-schema.json`(JSON Schema)

为了让 M5 选择器可视化,需要写出 schema。本期仅需校验"color 字段是合法 #RRGGBB"。schema 摘要:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["scheme", "colors"],
  "properties": {
    "scheme": { "enum": ["dark", "light"] },
    "colors": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "text": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" }
        // ...(20 个槽同上)
      }
    }
  }
}
```

完整 schema 在 M6 写实现时落地(M6 写 schema 与 dark/light 双 json + controller),本期 schema 只列规格。

---

## 8. 资源覆盖加载

```ts
// 启动顺序
const theme = loadTheme(process.env.RUNLEDGER_THEME_SCHEME === "light" ? "light" : "dark", {
  // 允许 RUNLEDGER_THEME_<KEY> 覆盖单个色槽
  ...(process.env.RUNLEDGER_THEME_ACCENT && { accent: process.env.RUNLEDGER_THEME_ACCENT }),
});
```

这样开头即可点对点覆盖:

```
RUNLEDGER_THEME_ACCENT=#ff00aa tsx examples/tui-demo.ts
```

---

## 9. 主题切换控制器

`InteractiveThemeController`(spec 见 02 文档 §16)的接入步骤:

1. 启动时由 pi-tui `ProcessTerminal` 触发 OSC 11 探测;
2. 收到响应 → 解析为 `dark` / `light`;
3. 若与当前不同,调用 `loadTheme(newScheme)` → 把新 Theme 引用传给 InteractiveMode;
4. InteractiveMode **不**主动遍历组件重渲,直接 `ui.requestRender()` 全量重渲一次,后续组件 render 调 `theme.get()` 自动拿新值;
5. 编辑器边框颜色(`EditorTheme.borderColor`)由 controller 同步 update(`setEditorThemeBorder(color)`)。

---

## 10. 与 pi 的差异点

| 维度 | pi | RunLedger |
|------|----|-----------|
| 槽数 | ~70 | 20 |
| 槽分配粒度 | 多个 nested variant(如 `accentBright`, `accentDim`) | 单 `accent` + 字符变体(`Bold`, `Italic`) 通过 ANSI 修饰 |
| 主题文件命名 | `theme/theme.ts` + `dark.json` | `theme/theme.ts` + `dark.json`(同名同结构,本期能浅表对照) |
| OSC 11 | 通过 `theme-controller.ts` 自动切 | System 层不动,接入路径相同 |
| 用户自定义 | pi 支持 `pi.json` 全量覆盖 | 仅支持 `RUNLEDGER_THEME_<KEY>` env |
| env 覆盖形态 | (不适用,pi 走配置文件) | 与 `claude-code-bun` 同形态 env-driven(`RUNLEDGER_THEME_ACCENT` 等),机制完全等价,无新增 |

`claude-code-bun` 主题机制虽然基于 React/Ink,但**用 env 覆盖单个色槽**的形态与 RunLedger 一致,RunLedger 采纳此形态作本期唯一自定义入口,不引入 `~/.runledger/theme.json` 等额外配置文件。

---

## 11. 验收标准

- `npm run check` 通过;
- `tsx examples/tui-demo.ts` 切终端 OSC 11 颜色后,RunLedger 1 秒内自动切到对应 dark/light;
- `RUNLEDGER_THEME_ACCENT=#ff00aa tsx examples/tui-demo.ts` 看到 logo 强调色变化;
- 单测:`theme.test.ts` 验证 20 槽全部存在且 `#RRGGBB` 合法。
