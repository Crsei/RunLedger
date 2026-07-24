# 04 · 渲染与终端协议细节

> 历史规格说明:本文记录已完成 M0-M7 阶段的渲染设计输入,不再是当前实施权威。
> 当前结构、门禁与实施状态以 `11-tui-structure-completion-plan.md`、代码和测试为准。

> 本文档描述 RunLedger TUI 复用 pi-tui 时的渲染层细节、Overlay 用法、滚动策略、ANSI 同步、节流参数,以及 RunLedger 必须保留 / 必须明确放弃的 pi 行为。

---

## 1. 渲染流程概览(由 pi-tui 负责)

```
ui.requestRender() ──► scheduled in nextTick ──► doRender()
                                                       │
                                                       ▼
                                          render all containers
                                                       │
                                                       ▼
                                          compositeOverlays()
                                                       │
                                                       ▼
                                          diff with prevLines
                                                       │
                          ┌─ firstChanged ≥ prevTop? ─► 定位 ANSI + 行内覆写
                          │   firstChanged < prevTop?  ─► 全屏重绘(拽回 scrollback)
                          ▼
                          │
                          ▼
                  stdout.write(\x1b[?2026h + diff + \x1b[?2026l)
                                                       │
                                                       ▼
                              update prevLines / kitty image GC
```

RunLedger 这层零代码改动,**只需**确保组件自身的 `render(width)` 实现是**幂等且可重入**(同一 props 多次调用结果一致)。

---

## 2. RunLedger 必须遵守的渲染契约

| 契约 | 原因 |
|------|------|
| `render(width)` **不得**修改自身状态 | doRender 会重渲染 dirty 的子集,带状态污染必崩 |
| `render(width)` 不得访问 `process.stdout` | 与差分渲染对冲,会破坏光标定位 |
| `render(width)` 不得发出 ANSI `?2026h/l`、`\x1b[2J` | 同上,与框架协议冲突 |
| `render(width)` 内的字符串宽度计算必须用 `visibleWidth`(pi-tui),不能用 `.length` |  East-Asian width / emoji / 双宽 |
| 涉及换行必须 LF(`\n`),禁止 CR(`\r`) | pi-tui 内部统一,差分行计算基于 `\n` 分隔 |
| `render(width)` 在多次调用期间**不得累积任何外部可观测副作用**(IO、网络、订阅注册) | 多次重渲是常态而非边缘;副作用累积会导致同一 props 下行为漂移(pi-tui doRender 不会去重 render 调用) |
| `render(width)` **不得**触发对其它组件 mutation API 调用 | 组件突变必须从 `handleEvent` 路径触发(见 `03-event-binding.md` §2 第 2 条);render 内反向 mutate 会形成"渲染→突变→再次渲染"的双向耦合,触发循环重渲 |

后两条是 `claude-code-bun` React 组件"render 纯函数"原则在 pi-tui 命令式模型下的对偶表达:React 通过 hooks 让副作用与渲染严格隔离,pi-tui 没有这层强制,RunLedger 在 spec 层用契约兜住。

---

## 3. Overlay 使用

pi-tui 提供 `TUI.showOverlay(component, opts): OverlayHandle`,opts 关键字段:

```ts
interface OverlayOptions {
  row?: number | "${n}%";      // 行定位(绝对 or 百分比)
  col?: number | "${n}%;
  anchor?: "center" | "top-left" | "bottom-center" | ...;
  maxHeight?: number | "${n}%;
  margin?: OverlayMargin;
  visible?: () => boolean;
  unfocusable?: boolean;
}
interface OverlayHandle { hide(); focus(); unfocus(); setHidden(b); }
```

RunLedger 三个 selector 全部使用同一模板:

```ts
// 通用 OverlayHelper
function showSelectorOverlay<T>(ui: TUI, list: SelectList): OverlayHandle {
  return ui.showOverlay(list, {
    row: "20%",                 // 顶部留 20% 给 chat
    col: "10%",
    anchor: "top-left",
    maxHeight: "60%",
    margin: { top: 1, bottom: 1, left: 2, right: 2 },
  });
}
```

三个 selector 的差异只在 `SelectList` 的 items 与 theme:

| selector | row | maxHeight | 备注 |
|----------|-----|-----------|------|
| `LedgerSessionSelector` | `"20%"` | `"60%"` | 列表可能长,用 60% |
| `ThinkingSelector` | `"40%"` | 5 行(固定 4 项) | 居中显眼 |
| `TrustSelector` | `"60%"` | 4 行 | 屏幕下方更显眼 |

Overlay 自带焦点,被 hide 后焦点恢复到 editor,**不需要** RunLedger 手写 setFocus。

---

## 4. 滚动策略

- **整体 log 滚动** 由 pi-tui `doRender` 处理: 新行溢出 viewport 底部时通过 `"\r\n".repeat(scroll)` 滚屏,`firstChanged < prevViewportTop` 触发全屏重绘。
- **编辑器内部滚动**: pi-tui `Editor.scrollOffset` 已有,RunLedger 不重做。
- **chatContainer 历史滚动**: 本期**不实现** RunLedger 自有的 message-list scroll(依赖终端 scrollback)。即用户向上滚需用终端自带快捷键(Windows Terminal `Ctrl+Shift+PgUp`、iTerm `Cmd+↑`),RunLedger 不拦截这些键。

> 之所以本期不实现 Up/Down 历史滚动,是因为 pi 也没实现,而是依赖终端原生 scrollback(参考 03 文档 §4 键位预留为 noop)。如未来要实现,需在 chatContainer 上做"虚拟滚动 + 仅渲染 viewport 行 + overlay 历史行",工程量与 pi-tui 改动耦合,放后续任务。

---

## 5. 节流与合帧

- pi-tui `MIN_RENDER_INTERVAL_MS = 16`(60Hz 上限);
- 高频 `message_update` 在 streamFn 输出 200 token/s 的常用场景下,每 token 触发 1 次 `requestRender`,被节流到 16 ms 一帧,约 30fps;
- `Loader` 的 spinner 自驱动 80ms,**独立于** requestRender 发起,通过 `TUI.invalidate` 触发局部;
- **RunLedger 不得在 handleEvent 内调 `setTimeout(_, 0)`、`process.nextTick(_)`** 试图"扩散" mutation,统一在 handleEvent 末尾 `ui.requestRender()`,依赖 pi-tui 节流即可。

### 5.1 延迟与首屏权衡

对照 `claude-code-bun` 中 `useDeferredValue` 仅在流式期间生效、turn 结束后绕开 deferred 路径防 jitter 的思路,RunLedger 在 pi-tui 命令式模型下用同形语义:

| 阶段 | 节流策略 | 依据 |
|------|----------|------|
| `message_update` 高频流式期间 | 16 ms 合帧,延迟至下一帧渲染 | 防止每 token 一帧的最坏 200 fps 刷屏 |
| `tool_execution_end` 单次突变 | 16 ms 节流(不绕过) | 单次突变即下一帧出结果,符合用户直觉 |
| `message_end` / `agent_end` 等终结事件 | **不走 deferred 路径**,直接在下个 tick 渲染最终状态 | 防 spinner 已撤但 final content 未渲的"白屏 gap"(对偶 React 的 jitter 现象) |
| `Ctrl+L` 清屏 / 主题切换 | 立刻 `requestRender` + `process.stdout.write("\x1b[2J\x1b[H")` | 用户直接反馈,等节流反而违和 |

本期不需写代码,**只需**在 `InteractiveMode.handleEvent` 中保证:

1. 高频事件(`message_update`)末尾调 `ui.requestRender()` 一次即可,不 expend 额外合帧调度;
2. 终结事件后**不**额外延迟 `setTimeout(_, 80)` 之类尾巴(对偶"不绕过 deferred 立即出最终状态");
3. 视觉验证时观察 spinner 收起与 final message 首帧之间无空行或半行。

---

## 6. ANSI 与终端协议保留项

以下 pi-tui 行为对中文 / 多终端体验关键,RunLedger **必须**保留(即不在 RunLedger 层覆写):

| 协议 | 用途 | RunLedger 行为 |
|------|------|----------------|
| `\x1b[?2026h` / `\x1b[?2026l` 同步输出 | 防半帧渲染 | 不覆写,pi-tui doRender 已包;半帧渲染在快速切屏中会撕裂 multiline 工具结果,RunLedger 在任何路径(包括 `Ctrl+L` 清屏)不得绕过此协议 |
| Kitty 键盘协议 flag 7 | 修饰键 / 组合键区分 | 不覆写,pi-tui `keys.ts` 已探 |
| OSC 11 背景色探测 | light/dark 自动切 | 由 `InteractiveThemeController` 接管,不主动禁用 |
| OSC 133 集成区 | 终端识别"用户输入块",AT 提示 | `UserMessageComponent` 强制 wrap |
| `CURSOR_MARKER` | IME 候选窗跟随光标 | 不动 pi-tui Editor 的 marker 实现 |
| OSC 9;4 进度条 | statusContainer 显示工作进度 | 本期可用作"信息提示",默认 off,可加 `RUNLEDGER_PROGRESS_BAR=1` 开启 |

---

## 7. Windows 终端特殊处理

pi-tui 的 `native-modifiers.ts` 通过 N-API 检测原生修饰键,Windows 系统跑 RunLedger 时无需我们做额外适配。但仍有以下细节需要注意:

| 现象 | RunLedger 应对 |
|------|----------------|
| Windows Terminal `clearOnShrink=false` | 不做改动,沿用 pi-tui 默认 |
| Git Bash (`winpty`) stdin 模式 | pi-tui 已处理,不要在 RunLedger 二次包装 stdin |
| `Ctrl+C` 在 Git Bash 下行为 | 通过 pi-tui `SIGINT` 监听 → `ui.stop()` → `agent.abort`(由 InteractiveMode 装配) |

---

## 8. 调试可观察物

当 `RUNLEDGER_DEBUG=1` 时,需在 stderr 输出:

- 每次事件: `[tui] <TuiEvent.kind> <ts>`
- 每次 doRender 耗时: `[tui] doRender <ms>ms <changed lines>`
- 每个 mutation API 调用: `[tui] <ComponentName>.<method>`

实现路径:`InteractiveMode` 包装 `handleEvent` 时根据环境变量决定是否写到 `process.stderr`。这部分**不**作为 PR 的一部分。可作为本地开发期辅助。

---

## 9. 性能与监工

| 指标 | 目标 | 测量 |
|------|------|------|
| `message_update` 处理 P99 延迟 | < 5ms | 一次 `runPrompt(1000 tokens)` 测 `handleEvent` 平均 ms |
| `doRender` P99 行数 | < 全屏重绘 | 通过 stderr 调试输出统计 |
| 60Hz 节流效果 | 0 丢帧 | 视觉检查 spinner 可见且不混入 token 颜色闪烁 |

本期不写整套 benchmark,只完成本地视觉验证。性能 校准留给 M7。
