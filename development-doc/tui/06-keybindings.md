# 06 · 键位绑定

> 本文档定义 RunLedger TUI 的应用级键位(`AppKeybinding`)枚举、默认映射、热替换规则,以及与 pi-tui `KeybindingsManager` 的接入点。

---

## 1. 设计动机

pi-tui 的 `KeybindingsManager` 提供抽象动作名 + 物理 keypair 的解耦。RunLedger 在其上加一层 `AppKeybinding` 枚举,让 InteractiveMode 中所有"用户面语义动作"被收集在一处,便于:

- 用户通过 `RUNLEDGER_KEYBIND_<ACTION>` 环境变量覆盖;
- `KeybindingHints` 组件直接读这层抽象(不耦合物理键);
- `CustomEditor.handleInput` 通过 `kb.lookup(data)` 一行调度。

---

## 2. `AppKeybinding` 枚举

```ts
// src/tui/keybindings.ts
export type AppKeybinding =
  | "app.interrupt"        // 中断当前 prompt
  | "app.exit"             // 退出 TUI
  | "app.clearScreen"      // 清屏
  | "app.openSession"      // 打开 LedgerSessionSelector
  | "app.toggleThinking"   // 打开 ThinkingSelector
  | "app.openTrustDialog"  // 打开 TrustSelector(本期手动触发)
  | "app.expandLastTool"   // 折叠/展开最近一个 ToolExecutionComponent
  | "app.scrollChatUp"     // noop(本期保留,见 04 文档 §4)
  | "app.scrollChatDown";  // noop
```

共 **9 个**。本期仅前 7 个生效,后 2 个保留枚举值但不绑定 key。

---

## 3. 默认键位映射表

| `AppKeybinding` | 物理 key | pi-tui `Key` 字面量 | 作用区 |
|----------------|----------|---------------------|--------|
| `app.interrupt` | `Esc` | `"escape"` | Editor |
| `app.exit` | `Ctrl+D` | `"ctrl+d"` | Editor |
| `app.clearScreen` | `Ctrl+L` | `"ctrl+l"` | Editor |
| `app.openSession` | `Ctrl+O` | `"ctrl+o"` | Editor |
| `app.toggleThinking` | `Ctrl+T` | `"ctrl+t"` | Editor |
| `app.openTrustDialog` | (无默认,十字热键) | — | Editor |
| `app.expandLastTool` | `Ctrl+E` | `"ctrl+e"` | Editor |
| `app.scrollChatUp` | `Ctrl+Shift+Up` | (kitty protocol 序列,本期 noop) | Editor |
| `app.scrollChatDown` | `Ctrl+Shift+Down` | 同上,本期 noop | Editor |

`"app.openTrustDialog"` 没默认绑定,因本期只在首次进入非信任目录时自动弹出(由 InteractiveMode 启动时检测)。用户若想手动触发,用环境变量覆盖。

---

## 4. 接入 `KeybindingsManager`

```ts
// src/tui/keybindings.ts
import { KeybindingsManager, type KeybindingsConfig, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export const APP_KEYBINDINGS: KeybindingsConfig = {
  actions: {
    "app.interrupt": ["escape"],
    "app.exit": ["ctrl+d"],
    "app.clearScreen": ["ctrl+l"],
    "app.openSession": ["ctrl+o"],
    "app.toggleThinking": ["ctrl+t"],
    "app.expandLastTool": ["ctrl+e"],
    // 无默认的填空数组
    "app.openTrustDialog": [],
    "app.scrollChatUp": [],
    "app.scrollChatDown": [],
  },
};

export function createKeybindingsManager(): KeybindingsManager {
  const kb = new KeybindingsManager();
  kb.setKeybindings({ ...TUI_KEYBINDINGS, ...APP_KEYBINDINGS });
  applyEnvOverrides(kb);
  return kb;
}

function applyEnvOverrides(kb: KeybindingsManager): void {
  for (const action of Object.keys(APP_KEYBINDINGS.actions)) {
    const envKey = `RUNLEDGER_KEYBIND_${action.toUpperCase().replace(/\./g, "_")}`;
    const spec = process.env[envKey];
    if (!spec) continue;
    const keys = spec.split(",").map((s) => s.trim()).filter(Boolean);
    kb.setKeybinding(action, keys); // 假定 pi-tui 提供此 API;若不提供,本层做 shim
  }
}
```

环境变量示例:

```
RUNLEDGER_KEYBIND_APP_INTERRUPT=ctrl+c,escape  # 多键触发同一动作
```

---

## 5. `CustomEditor` 的 dispatch 路径

```ts
// src/tui/components/custom-editor.ts(伪码)
class CustomEditor extends Editor {
  handleInput(data: string): void {
    const action = this.kb.lookup(data);
    if (action && action.startsWith("app.")) {
      this.appActionHandlers.get(action as AppKeybinding)?.();
      return;                       // 不再传父 Editor
    }
    if (matchesKey("escape", parseKey(data)) && this.onEscape) {
      this.onEscape();
      return;
    }
    if (matchesKey("ctrl+d", parseKey(data)) && this.onCtrlD) {
      this.onCtrlD();
      return;
    }
    super.handleInput(data);      // 默认 Editor 文本编辑行为
  }
}
```

注意 `app.interrupt` 和 Esc 有 overlap:`kb.lookup(Esc => "app.interrupt")` 优先,而 `onEscape` 兜底由 InteractiveMode 在某些场景(例如 selector overlay 开启时把 Editor Esc 关掉)用。

---

## 6. `KeybindingHints` 渲染规则

读取 `KeybindingsManager` 当前生效的键位,生成:

```
RunLedger v0.0.1
Esc interrupt    Ctrl+D exit    Ctrl+L clear    Ctrl+T thinking    Ctrl+O sessions
```

未绑定的 `AppKeybinding`(`app.openTrustDialog` / `app.scrollChat*`)**不**渲染 hint 行。

`KeybindingHints.update(props)` 在以下时机调:

- 启动后第一次 render;
- `KeybindingsManager` 发生 setKeybinding 调用后(本期不实现热重载通知,只在启动时读一次)。

---

## 7. 与 pi 的对照

| 维度 | pi | RunLedger |
|------|----|-----------|
| 抽象动作 | 分散在 `core/keybindings.ts` + `tui/keybindings.ts`,~30 项 | 集中在 `tui/keybindings.ts` 一文件,9 项 |
| 物理键可覆盖 | `pi.json` | `RUNLEDGER_KEYBIND_<ACTION>` env |
| Hint 渲染 | `KeybindingHints` 复杂组合,带 logo | 同组件,简化版只渲染一行 key-hint 串 |
| Extension 自定义键 | 有 by extension | 无 |
| Selector overlay 的 Enter/Esc | 各自组件处理 | 同 pi,Render 不暴露到 AppKeybinding |

**对照说明**:`claude-code-bun` 通过 `RUNLEDGER_KEYBIND_*` 形态下的环境变量覆盖键位(同 RunLedger 的 env driven 模式),机制完全等价,本期无新增。React/Ink 的 `useInput` hook 模式与 pi-tui 的命令式 `handleInput(data)` 模型不同,**不**移植。

---

## 8. Hot Replace

部分场景的键位应当被热替换(见 02 文档 §11 `CustomEditor.setOnEscape(name, fn)`):

| 场景 | 替换 |
|------|------|
| Overlay selector 打开 | `setOnEscape(() => overlayHandle.unfocus())`,`app.interrupt` 同时被屏蔽(改成把焦点改回 editor) |
| `app.openTrustDialog` 自动弹 | `setOnEscape(() => trustSelectorHide())`, Esc 仅响应 trust 行为 |
| Bash 工具运行中 | `app.interrupt` 不再有 abort 信号(已 guard 在 loop 层),改为 noop + status indicator |

恢复策略:`InteractiveMode` 持有一个 stack of `{ onEscape, onCtrlD }`,在 overlay close / trust resolved 时 pop。

---

## 9. 验收标准

- `KeybindingHints` 渲染的串与 §3 一致;
- 按下 `Esc` 能中断当前 prompt(通过 AbortController);
- 按下 `Ctrl+D` 能退出 TUI;
- `RUNLEDGER_KEYBIND_APP_EXIT=ctrl+q` 启动后 Ctrl+Q 退出,Ctrl+D 不再退出;
- `KeybindingHints` 文本同步变化显示新键位。
