# 02 · 组件规格(唯一准确表达)

> 本文档对每个 TUI 组件给出**唯一准确表达**:
>
> - **角色定位**:一句话说明它解决什么 UI 问题
> - **继承关系**:extends `Container` / `Component` / pi-tui 哪个底层
> - **构造 props**:`constructor(opts)` 的字段表
> - **持态字段**:实例私有字段及其语义
> - **render 契约**:`render(width) => string[]` 如何分行、宽度如何分配
> - **输入契约**:若 `Focusable`,接收什么键、产生什么副作用
> - **公开 mutation API**:`updateContent` / `markDone` / `setExpanded` 等命令式入口
> - **不可变契约**:列出该组件**禁止**的行为(防止未来重构时漂移)
>
> 写在前面:pi-tui 不在本规格内,它由 `@earendil-works/pi-tui` 包提供。本规格只覆盖 RunLedger 自有组件,共 **11 个业务组件 + 3 个 selector + 1 个 theme controller + 1 个 InteractiveMode = 16 个对象**。

---

## 0. 公共类型与约定

```ts
// src/tui/types.ts
import type { AssistantMessage, ToolCall, TextContent, StopReason, AssistantMessageEvent } from "../types.ts";
import type { AgentMessage } from "../runtime/types.ts";

/** 所有组件 props 的公共基类。 */
export interface BaseComponentProps {
  /** 主题句柄,通过依赖注入穿透到所有叶子组件。禁止组件自行读全局单例。 */
  theme: Theme;
}

/** 工具调用渲染外壳策略。 */
export type ToolShell = "contentBox" | "selfRender" | "contentText";

/** Pending 消息状态(已入队但尚未送达 Agent)。 */
export type PendingState = "queued" | "streaming" | "blocked";

/** Footer 数据来源(只读快照)。每次 render 同步读取。 */
export interface FooterSnapshotProvider {
  getSnapshot(): {
    cwd: string;
    gitBranch: string | undefined;
    modelLabel: string;
    sessionTokenUsage: { input: number; output: number } | undefined;
    context: { used: number; total: number } | undefined;
    thinking: "off" | "low" | "medium" | "high";
    ledgerPath: string | undefined;
  };
}
```

pi-tui 的 `Component` / `Container` / `Focusable` 接口摘要:

```ts
interface Component { render(width: number): string[]; }
class Container { addChild(c: Component): void; removeChild(c: Component): void; children: Component[]; }
interface Focusable { handleInput(data: string): void; focus(): void; blur(): void; }
```

---

## 0.1 feature adapters 预留接入点

对照 `claude-code-bun` 的 `src/screens/repl/featureAdapters.ts`:每个可选特性(voice / proactive / 跨 IDE 通知等)在该文件中导出两种实现二选一,主组件树 import 时统一从此处取,组件树本身**不**散落 `if (process.env.X)` 判支,任何特性的开启/关闭只改一处。

RunLedger 本期 M0–M7 不实现任何可选特性,但**预留**该接入点为未来扩展口:

```ts
// src/tui/feature-adapters.ts(本期不创建,接入点约定)
// 对照 claude-code-bun src/screens/repl/featureAdapters.ts:1-87

import type { Tool } from "../runtime/types.ts";

/**
 * 本期内置实现全部为 no-op。任何新特性从 no-op 移到真实实现时:
 * 1. 在此文件新增 export,命名 <FeatureName>Adapter;
 * 2. 由 env flag(本期)/ 编译期 `feature()`(若 pi-tui 提供)/ 构造期判断三选一切换;
 * 3. 主组件树 import 必须从此文件取,组件内不写 if (process.env.X)。
 *
 * 切换形态优先采用顶层 const 表达式(+ tree-shaking),保留 erasableSyntaxOnly 约束。
 */
export interface VoiceAdapter {
  handleKeyEvent(_data: string): void;
  stripTrailing(): number;
  resetAnchor(): void;
}

export const VoiceAdapter: VoiceAdapter = {
  // 本期 no-op:不引入 voice 模块
  handleKeyEvent: () => {},
  stripTrailing: () => 0,
  resetAnchor: () => {},
};

export const PROACTIVE_NO_OP_SUBSCRIBE = (_cb: () => void): (() => void) => () => {};
export const PROACTIVE_FALSE = (): boolean => false;
export const PROACTIVE_NULL = (): number | null => null;

// 此处可追加未来扩展;在改动时同步更新 07-roadmap.md 的独立任务对接清单。
```

**接入原则**:

1. 任何新特性必须经过 `feature-adapters.ts` 中转,**禁止**直接在 `interactive-mode.ts` / 各组件里写 `if (process.env.RUNLEDGER_VOICE) { ... }`;
2. 编译期 vs 运行期切换由当时约束决定;若 pi-tui 包发布提供 `feature()` 编译期宏(M0 风险项见 `07-roadmap.md`),则用编译期,否则用顶层 env 分支;
3. 主组件树引用 adapter 而非实现 (`import { VoiceAdapter } from "./feature-adapters.ts"`),**禁止**在组件内 `import` 真实特性模块。

本节为契约位,**本期不创建该文件**;一旦落实需在 `07-roadmap.md` 的"独立任务对接清单"中追加条目。

---

## 1. `InteractiveMode`

**角色**:TUI 主控,装配组件树,把 `Agent` 事件翻译为组件 mutation,驱动 `ui.requestRender()`。

**继承**:普通 class,不 extends pi-tui(它"持有"`TUI`,不是"is-a")。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent` | `Agent` | 唯一状态源 |
| `theme` | `Theme` | 初始主题 |
| `keybindings` | `KeybindingsManager` | 应用级键位管理 |
| `mode` | `"interactive"` | 多模式预留,本期固定 |

**持态字段**:

```ts
private readonly ui: TUI;                              // pi-tui
private readonly agent: Agent;
private readonly theme: InteractiveThemeController;
private readonly kb: KeybindingsManager;
private readonly containerRefs = {
  header: Container,
  loadedResources: Container,
  chat: Container,
  status: Container,
  editor: CustomEditor,            // 见 §10
  footer: FooterComponent,
};
private streamingComponent?: AssistantMessageComponent;
private streamingMessage?: AssistantMessage;
private readonly pendingTools = new Map<string, ToolExecutionComponent>();
private readonly pendingToolCalls = new Map<string, ToolCall>();
private activeStatus?: StatusIndicator;
private unsubscribe?: () => void;
// 失败护栏:对照 claude-code-bun MAX_CONSECUTIVE_INIT_FAILURES = 3 思想,
// 防止 init 阶段反覆重试不可恢复的错误(如 OSC 11 探测在 Windows 某些版本永远 401)。
private consecutiveInitFailures = 0;
private static readonly MAX_CONSECUTIVE_INIT_FAILURES = 3;
private static readonly INIT_FAILURE_BACKOFF_MS = 10_000;
```

**render 契约**:`InteractiveMode` 自身**不实现 render**,只组装 `TUI` 子树,渲染由 `TUI.doRender` 完成。

**输入契约**:`CustomEditor` 收 stdin;`agent.subscribe` 走事件驱动。无其它键接。

**公开 API**:

| 方法 | 行为 |
|------|------|
| `async run()` | 装配组件树 → 订阅 Agent → `await ui.start()`(阻塞到退出)→ unsubscribe |
| `quit()` | 调 `ui.stop()` |
| `replaceKeybinding(action, handler)` | 热替换可绑动作 handler(本期仅 `app.interrupt` / `app.exit`) |

**不可变契约**:

- 不直接修改 `Agent` 状态,只通过 `prompt(text)` 调用;
- 不在 `handleEvent` 里 `await` REPL 外异步副作用(对应 `claude-code-bun` 的同步派发契约);mutation 全部同步完成,`agent.subscribe` 已是同步派发;
- 不在 TUI 层访问 `agent._state.messages`,只用 `event` 中的 `assistantMessageEvent`;
- 构造/init 阶段任何一层 `import` / 资源加载失败连续 ≥ `MAX_CONSECUTIVE_INIT_FAILURES` 次时**停止重试**,记 stderr,通过 `ui.stop()` 平静退出,不抛(`03-event-binding.md` §5 异常路径同条);
- 新特性必须经 `feature-adapters.ts`(见 §0.1)接入,**禁止**在组件树内散落 `if (process.env.X)`;feature adapters 接入点是 TUI 层唯一的扩展口。

---

## 1.1 拆分有据(file-header 注释规范)

对照 `claude-code-bun` 的 `src/bridge/initReplBridge.ts:1-13`,该文件在文件头第一段注释中以"为什么从 replBridge.ts 拆出来"开篇(bundle 膨胀 + daemon 复用核心),RunLedger 沿用此规范。

判据:当 `src/tui/interactive-mode.ts` 出现以下任一信号时,必须考虑拆分:

| 信号 | 拆分目标 | 拆分理由类别 |
|------|----------|--------------|
| 文件超 800 行 | 事件适配层 / status 管理 / overlay 桥 各拆 | 职责边界 |
| 某段代码引入了 `pi-ai` 子树(`api/*` / `providers/*`),导致 cli bundle 膨胀 | 抽出 `runtime/stream-from-provider.ts`,InteractiveMode 通过 lazy import 装载 | bundle 边界 |
| 某段代码有独立单测覆盖需求(例如 OSC 11 探测、PromptInput mode 切换),留在主文件中被 mock 影响其它测试 | 拆出独立文件,主文件 import | 测试边界 |

拆出文件**必须**在文件首段保留以下格式的注释:

```ts
/**
 * <file 做什么,一句话>
 *
 * 拆分理由:<bundle 边界 | 职责边界 | 测试边界>
 *
 * 从 <原文件路径> 移出,原因:<具体说明>。
 */
```

如果不满足上述任一判据,**保留**单文件优先;拆分有据的"据"必须可追溯。

---

## 2. `UserMessageComponent`

**角色**:渲染一条用户消息文本(单条 `UserAgentMessage`,`role==="user"`)。

**继承**:`extends Container`(pi-tui)。

**构造 props**(`UserMessageProps extends BaseComponentProps`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | 必填 |
| `text` | `string` | 用户原文(已展开 `@file` 等) |
| `attachments?` | `string[]` | 附带文件路径列表,在标题行展示 |

**持态字段**:
```ts
private readonly markdown: Markdown;     // pi-tui
private readonly attachments: string[];
```

**render 契约**:

```
Line 0:  \x1b]133;1;A\x1b\\            (OSC 133 Prompt 集成区开始)
Line 1:  <theme.bg("userMessageBg", "▌ " + attachments...)>
Line 2..N: <theme.bg("userMessageBg", markdown.render(width))>
Line N+1: \x1b]133;1;B\x1b\\           (OSC 133 Prompt 集成区结束)
```

宽度 = `width`,首行 `▌` 占 1 列,后跟 attachments(逗号分隔),空格 1 个,后续 markdown 自适应换行(由 pi-tui `Markdown` 完成)。

**输入契约**:非 Focusable。

**公开 mutation API**:**无**(用户消息一旦构造不可变)。

**不可变契约**:

- 不支持流式更新(用户消息是完整文本一次性提交);
- 不显示标题"User"(由 OSC133 提示 + 缩进符号表达);
- 文本不二次格式化,保持原样(`@file` 已在 runtime 层展开)。

---

## 3. `AssistantMessageComponent`

**角色**:渲染一条助手消息。流式增量,可包含 `text` / `thinking` / `toolCall` 三种内容。

**继承**:`extends Container`。

**构造 props**(`AssistantMessageProps extends BaseComponentProps`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | 必填 |
| `initialContent` | `(TextContent | ToolCall)[]` | `[]` 起步 |
| `hideThinking` | `boolean` | 默认 `true`(thinking 块默认折叠) |
| `onToolCallAugment?` | `(id: string) => void` | 首次见到某 toolCall.id 时回调,用于让 InteractiveMode 创建 ToolExecution |

**持态字段**:
```ts
private readonly contentContainer = new Container();
private readonly thinkingContainer = new Container();
private readonly messageContainer = new Container();   // 不含 thinking
private currentContent: (TextContent | ToolCall)[];
private readonly toolCallIds: Set<string>;
```

**render 契约**:

- 顶层 `Container.render(width)` 返回 `contentContainer.render(width)`;
- `contentContainer.children = hideThinking ? [messageContainer] : [thinkingContainer, messageContainer]`;
- 每个 `TextContent` 用 pi-tui `Markdown` 渲染;每个 `ToolCall` 不直接渲染,只渲染一个 4 字符占位链 `· · · `(真实渲染交给 `ToolExecutionComponent` 由 InteractiveMode 同步插入到 `chatContainer` 紧随 assistant message 之后)。

**输入契约**:非 Focusable。

**公开 mutation API**:

| 方法 | 行为 |
|------|------|
| `updateContent(message: { content: (TextContent | ToolCall)[]; stopReason?: StopReason })` | 全量替换 `currentContent`,重建 `messageContainer` 子节点;同时检测新增 toolCallId,逐个调 `onToolCallAugment(id)`,最后 `requestRender()` 由调用方负责 |

**不可变契约**:

- `updateContent` **替换**而非增量 diff;差异计算由 pi-tui `Container.render` 的输出阶段 + `TUI.doRender` 的行级差分兜底;
- thinking 块要么整块渲染要么不渲染,不弹出滚动条;
- 不在组件内调 `requestRender`,由 `InteractiveMode.handleEvent` 统一触发。

---

## 4. `ToolExecutionComponent`

**角色**:渲染一次工具调用的 args 流入 + result 流出,整个生命周期跨多次 `tool_execution_update` 事件。

**继承**:`extends Container`。

**构造 props**(`ToolExecutionProps extends BaseComponentProps`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | 必填 |
| `toolName` | `string` | LLM 调的工具名(对应 `AgentTool.name`) |
| `toolCallId` | `string` | 用于和 AgentEvent 关联 |
| `shell` | `ToolShell` | `contentBox`(普通 / 通用兜底) / `selfRender`(Bash 等需要自定义) / `contentText`(单行结果) |
| `expandable` | `boolean` | 默认 `false`,工具完成前不可展开 |

**持态字段**:
```ts
private readonly shell: ToolShell;
private readonly customContainer?: Container;     // shell==="selfRender" 由子类提供
private argsText: string;                         // LLM 传入的 input JSON 字符串
private resultText: string;                        // tool_execution_end 完整 result
private isArgsComplete = false;
private isResultComplete = false;
private isExpanded = false;
private readonly loader: Loader;                   // running 时显示
```

**render 契约**(默认 `contentBox` shell):

```
Line 0:  ┌─ <toolName> ────────────────────┐
Line 1..N:  <argsText 渲染为 markdown>
Line N+1:  ── loader or ✓ ──────────────
Line N+2:  <resultText>(isArgsComplete && isResultComplete) 或空
Line N+3:  └────────────────────────────────┘
```

边框颜色:`theme.fg(expanded ? "toolPendingBg" : "toolBorder")`。

**输入契约**:非 Focusable。`setExpanded(true)` 仅由 InteractiveMode 在工具完成后 `chatContainer` 的全局 `expand tool` 键位触发,不在组件内处理键位。

**公开 mutation API**:

| 方法 | 行为 |
|------|------|
| `updateArgs(text: string)` | 增量覆盖 argsText(每次 `message_update` 中 `content.type==="toolCall"` 增量到来);触发重渲 |
| `markArgsComplete()` | `isArgsComplete = true`,loader 继续显示直至 `updateResult` 到来 |
| `updateResult(text: string, isPartial?: boolean)` | 工具执行结果增量 / 全量写入;isPartial=false 时 `isResultComplete=true` |
| `setExpanded(state: boolean)` | 折叠/展开 resultText,完成前调用无效 |

**不可变契约**:

- 单组件生命周期内 `toolCallId` 不可变;
- `shell === "selfRender"` 时由 RunLedger 子类(如 `BashExecutionComponent`)重写 `customContainer` 提供内容,本基类只挂载;
- 不在组件内部启动 Bash subprocess;所有执行由 `AgentTool.execute` 完成;
- 不读 stdin、不订阅全局事件。

---

## 5. `BashExecutionComponent`

**角色**:`ToolExecutionComponent` 的 Bash 专用扩展(`toolName === "bash"`),用 `DynamicBorder`(pi-tui)+ 滚动尾部预览,避免长输出炸屏。

**继承**:`extends ToolExecutionComponent`,`shell = "selfRender"`。

**构造 props**:同 `ToolExecutionProps`,但 `shell` 固定为 `"selfRender"`。

**额外持态字段**:
```ts
private readonly dynamicBorder: DynamicBorder;  // pi-tui
private readonly commandText: string;            // LLM 传入 args.command
private stdoutBuffer: string = "";
private stderrBuffer: string = "";
private exitCode?: number;
```

**render 契约**(覆盖父类):

```
Line 0:  <DynamicBorder 顶边 · state=running/done/error>
Line 1:  $ <commandText>                         (theme.fg("bashCommand"))
Line 2:  ── stdout/stderr 滚动尾部预览 ──
Line N:  <exitCode 数字>
Line N+1: <DynamicBorder 底边>
```

`DynamicBorder` 颜色由 `state` 决定(running=accent、done=success、error=error)。

**mutation API**(父类基础 + 新增):

| 方法 | 行为 |
|------|------|
| `appendOutput(text: string)` | 末尾追加 stdout,做尾部 N 行截断(`MAX_PREVIEW_LINES = 12`) |
| `appendError(text: string)` | 同上,写 stderr |
| `setExitCode(code: number)` | 完成,触发 `markArgsComplete` + `updateResult("...")` |

**不可变契约**:

- 不实现真正 Bash 执行;
- 不显示用户输出超 12 行(M5 可调);
- 不允许多次 `appendOutput` 后修改 `commandText`。

---

## 6. `CustomMessageComponent`

**角色**:兜底自定义消息节点,渲染 RunLedger 自定义 entry(如 ledger `// custom` payload)。本期最小可用,用于占位。

**继承**:`extends Container`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `kind` | `string` | entry type 字面量 |
| `payload` | `Record<string, unknown>` | 透传 |

**持态字段**:`private readonly markdown: Markdown`。

**render 契约**:

```
Line 0:  ┌─ <kind> ─┐
Line 1..N: Markdown(JSON.stringify(payload, null, 2))
Line N+1: └───────┘
```

**mutation API**:**无**(一次性构件)。

**不可变契约**:

- 不解释 payload,纯展示;
- 子类负责重写 `markdown` 挂接点即可扩展具体 kind。

---

## 7. `StatusIndicator`

**角色**:在 `statusContainer` 中插入一条"当前正在做什么"的指示行,跑动时显示 spinner,完成后由 InteractiveMode 移除。

**继承**:`extends Loader`(pi-tui)。

**构造 props**(`StatusIndicatorProps extends BaseComponentProps`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `kind` | `"working" \| "retry" \| "compaction" \| "idle" \| "error"` | 5 种状态 |
| `message` | `string` | 状态文本 |
| `countdownMs?` | `number` | retry 时显示倒计时 |

**持态字段**:
```ts
private readonly kind: string;
private message: string;
private countdownEndsAt?: number;  // retry
```

**render 契约**:`Loader.render(width) => ["spinner + 状态文本"]`(单行)。带 `countdownMs` 时附加 `[<剩余秒>s]`。

**输入契约**:非 Focusable。

**公开 API**:

| 方法 | 行为 |
|------|------|
| `setMessage(text: string)` | 更新状态文本 |
| `extend(durationMs: number)` | retry 场景延长倒计时 |

**不可变契约**:

- `kind` 一经构造不变;
- 完成后由 InteractiveMode `chatContainer.removeChild`,不自杀。

---

## 8. `KeybindingHints`(顶部)

**角色**:显示 logo + 当前可用键位提示行(如 "Press Esc to interrupt, Ctrl+S to send")。

**继承**:`extends Container`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `appName` | `string` | "RunLedger" |
| `version` | `string` | package.json version |
| `keybindings` | `Keybindings` | 当前生效 |

**持态字段**:无(纯展示,每次 render 读 props)。

**render 契约**:

```
Line 0:  RunLedger v0.0.1
Line 1:  Esc interrupt    Ctrl+S send    Ctrl+L clear    ↑↓ scrollback
```

**mutation API**:`update(props)` 全量替换。

**不可变契约**:不在内部维护 keybindings,只读快照。

---

## 9. `LoadedResources`

**角色**:启动时加载的资源条,展示 `@file` 列表、注册的工具数、ledger 路径。

**继承**:`extends Container`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `files` | `string[]` | @file 列表 |
| `toolCount` | `number` | Agent.tools.length |
| `ledgerPath` | `string \| undefined` | |

**render 契约**:

```
Line 0:  ⏵ @file: ./src/runtime/agent.ts, ./README.md  (前 2 个 + "+ N more")
Line 1:  ⏵ tools: 3   ⏵ ledger: ~/.runledger/agent/abc.jsonl
```

无内容时不渲染任何行(`render` 返回 `[]`)。

**mutation API**:`update(props)`。

**不可变契约**:不可在 render 后修改。

---

## 10. `PendingMessages`

**角色**:展示已入队(*未送达 Agent*)的 follow-up 文本。本期最小可用,只要不损焦点。

**继承**:`extends Container`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `state` | `PendingState` | queued/streaming/blocked |
| `items` | `string[]` | 队列文本 |

**持态字段**:无(每次 render 读 props)。

**render 契约**:

```
Line 0..N:  ⌛ <text item>
```

`state==="blocked"` 时整组前置 `theme.fg("pendingBlocked")` 着色。

**mutation API**:`setState(state)` / `setItems(items)`。

**不可变契约**:**不在队列入队时执行副作用**,只更新展示。

---

## 11. `CustomEditor`

**角色**:`pi-tui` 的 `Editor` 在 RunLedger 的自定义子类,挂接应用级键位(`app.interrupt` / `app.exit`),提供移交出去的可热替换 `onEscape` / `onCtrlD` / `onExtensionShortcut` handler。

**继承**:`extends Editor`(pi-tui)。

**构造 props**(`CustomEditorOptions extends EditorOptions`):

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `EditorTheme` | pi-tui EditorTheme |
| `keybindings` | `KeybindingsManager` | 应用级 |
| `getInterruptSignal` | `() => AbortSignal` | Esc 时拿到 agent 持有的 signal |
| `on punt` | etc | 见下 |

**持态字段**:
```ts
private onEscape?: () => void;
private onCtrlD?: () => void;
private extensionShortcutHandlers = new Map<string, () => void>();
```

**输入契约**(`handleInput(data)`):

1. 先尝试匹配 `keybindings.lookup(data)`,有 handler 则调 handler 而不传父 Editor;
2. 否则若 data 是 Esc / Ctrl+D:若有 `onEscape` / `onCtrlD` 调之,不传父;
3. 否则走父 `Editor.handleInput`(默认光标移动 / 文本编辑)。

**公开 API**:

| 方法 | 行为 |
|------|------|
| `setOnEscape(fn)` | 热替换 Esc handler |
| `setOnCtrlD(fn)` | 同上 |
| `setExtensionShortcut(name, fn)` | 注册扩展快捷键(本期仅用于"切 thinking 模式"等) |

**render 契约**:继承 `Editor.render(width)`,不变。

> 2026-08-09(计划 02)输入区复刻同步:
> - `EditorTheme` 扩为 5 函数:`borderColor` / `backgroundColor` / `placeholderColor` / `prompt` / `selectList`;
> - `Editor.render` 前缀由 `> ` 改为 `› `(prompt 用 bold accent),空输入渲染 dim 占位符,
>   背景铺满整行;折行宽度 = width - 2(左 gutter)- 1(右留白);
> - `Editor` 新增 `desiredHeight(width)`(word-wrap 行数 + 上下留白,最小 3),OpenTUI 原生路径再用
>   `measureForDimensions(width - 3)`校正真实折行;
> - 原生路径:输入区 = prompt 2 列 + Textarea + 右留白 1 列(editorRow 上下留白各 1),背景/占位符色随
>   `editorAppearance` 帧下发;高度达到 viewport 上限后 textarea 内部滚动,始终保留 footer 与至少
>   1 行 transcript(详见 `../plan/02-codex-input-area-replica-plan.md`)。

**不可变契约**:

- 不直接订阅 `agent.subscribe`,只暴露 handler 给 InteractiveMode 装配;
- 不持久化文本(失焦不清空);
- 不读 `clipboard` 剪贴板(本期无);

---

## 12. `FooterComponent`

**角色**:底部状态栏,实时读 `FooterSnapshotProvider`,展示 cwd / git / model / tokens / context% / thinking 模式 / ledger 路径。

**继承**:`extends Container`(直接 `render(width)` 不挂子组件)。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `provider` | `FooterSnapshotProvider` | 数据源 |
| `rightWidgets` | `Component[]` | 右侧附加组件(本期空数组) |

**公开 mutation API**:`invalidate()` —— 不立即渲染,只是把"我脏了"标记置位,下次 TUI.doRender 会重新调 `render`。

**render 契约**(单行,宽度 = `width`):

```
<pwd 短路径> <git branch> | <model label> | ⏵ <tokens used/total> <context%> | <thinking>
```

无数据时仅渲染 `<mode>` placeholder。整行用 `theme.fg("footerBg")` 背景色。

**输入契约**:非 Focusable。

**不可变契约**:`render` 内**只读** provider,不触发任何副作用。

---

## 13. `LedgerSessionSelector`(M5)

**角色**:Overlay 选择历史 ledger session(`~/.runledger/agent/*.jsonl`),选中后 new Agent(从该 ledger 重放)。

**继承**:`extends SelectList`(pi-tui)。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `sessions` | `LedgerSessionView[]` | 列表 |
| `onPick(s)` | callback | 选中后调 |
| `onCancel()` | callback | Esc |

**`LedgerSessionView` 类型**:

```ts
export interface LedgerSessionView {
  sessionId: string;
  path: string;
  createdAt: number;
  messageCount: number;
  cwd?: string;
}
```

**render 契约**:覆写 `SelectList.render`,每行渲染为:`<sessionId>  <createdAt(strftime)>  <messageCount>mes  <cwd?>`。

**输入契约**:`↑↓` 移动光标,`Enter` 选中,`Esc` 取消。其它键位由 `SelectList` 默认消费。

**不可变契约**:

- 不直接读文件系统,只读构造时传入的 `sessions`;
- 不负责 ledger 重放,通过 `onPick` 回调让 InteractiveMode 处理 Runtime 层操作。

---

## 14. `ThinkingSelector`

**角色**:Overlay 选择 thinking 模式:off / low / medium / high。

**继承**:`extends SelectList`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `current` | `"off" \| "low" \| "medium" \| "high"` | 当前 |
| `onPick(mode)` | callback | |
| `onCancel()` | callback | |

**render 契约**:4 行,每行 `● <模式>`,当前项前置 ✓。

**输入契约**:同 §13。

**不可变契约**:仅展示 4 个固定项,不扩展(自定义 thinking budget 由 agent-loop 任务负责)。

---

## 15. `TrustSelector`

**角色**:首次进入非信任目录时 Overlay 弹出,要求用户确认信任该 cwd 一次或永久信任。

**继承**:`extends SelectList`。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `theme` | `Theme` | |
| `cwd` | `string` | 当前目录 |
| `onPick("once" \| "always" \| "abort")` | callback | |
| `alreadyTrusted` | `boolean` | 若已信任则直接 dismiss |

**render 契约**:3 行,`Trust once` / `Trust always` / `Abort`。

**输入契约**:同 §13。

**不可变契约**:本期不持久化信任目录(仅 session 级),持久化交给 RunLedger 后续任务。

---

## 16. `InteractiveThemeController`

**角色**:监听 pi-tui 终端的 OSC 11 / color scheme 报告,在切换时把 `theme.dark.json` / `theme/light.json` swap,并 `ui.invalidate() + requestRender()`。

**继承**:不 extends(pi-tui 的 OSC 解析通过订阅 `Terminal` 接口拿到,本类只是 binding)。

**构造 props**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `ui` | `TUI` | 用于 `requestRender` |
| `terminal` | `Terminal` | 用于注册 OSC listener |

**持态字段**:
```ts
private currentScheme: "dark" | "light" | "unknown";
private readonly dark: Theme;
private readonly light: Theme;
private current: Theme;
```

**公开 API**:

| 方法 | 行为 |
|------|------|
| `get(): Theme` | 取当前 |
| `set(scheme: "dark" | "light"): void` | 手动切换 |
| `dispose()` | 取消终端监听 |

**不可变契约**:

- 不修改 dark.json / light.json 文件本身;
- 不向已订阅组件主动 push,而是让组件每次 `render` 调 `theme.get()`。

---

## 17. 与 Runtime 层的契约对齐点

| 组件 | 读到的 Runtime 类型 | 时机 |
|------|---------------------|------|
| UserMessageComponent | `UserAgentMessage.content[].text` | prompt(text) 之前 |
| AssistantMessageComponent | `AssistantMessageEvent` 的 deltas | `message_update` |
| ToolExecutionComponent | `ToolCall.id/name/arguments` | `message_update(content.type==="toolCall")` |
| BashExecutionComponent | `AgentTool.execute()` 的 `ToolResultContent.content[].text` | `tool_end` |
| FooterComponent | `LedgerSink.entries()` / `header()` | 每次 render |
| LedgerSessionSelector | `getAgentDir()` 列目录 | 选择子打开时 |
| LoadedResources | `AgentState.tools.length` / `getAgentDir()` | 启动时 |
| PendingMessages | (无 Runtime 端实现,本期只在 TUI 内) | 用户多次回车未等结果 |

---

## 18. 组件依赖图(简化)

```
InteractiveMode
  ├── TUI (pi-tui)
  │     ├── headerContainer → KeybindingHints
  │     ├── loadedResourcesContainer → LoadedResources
  │     ├── chatContainer
  │     │     ├── UserMessageComponent
  │     │     ├── AssistantMessageComponent
  │     │     │     └── Markdown (pi-tui) × N
  │     │     ├── ToolExecutionComponent
  │     │     │     └── Loader (pi-tui)
  │     │     ├── BashExecutionComponent extends ToolExecutionComponent
  │     │     │     └── DynamicBorder (pi-tui)
  │     │     ├── CustomMessageComponent
  │     │     └── PendingMessages
  │     ├── statusContainer → StatusIndicator extends Loader
  │     ├── editorContainer → CustomEditor extends Editor
  │     │     └── Editor/SelectList (pi-tui)
  │     └── footer → FooterComponent
  ├── Agent (runtime)
  ├── InteractiveThemeController (theme/controller)
  │     ├── theme/dark.json
  │     └── theme/light.json
  └── KeybindingsManager (pi-tui via @earendil-works/pi-tui)
```

## §10 M5 三态组件扩展

M5 实现把 `ToolCallComponent` / `DiffPreviewComponent` / `BashExecutionComponent` 统一成同一份四态图标 + 行协议:
- 状态枚举:`pending` (⏳) / `running` (…) / `ok` (✓) / `error` (✗);图标遵循 05 §2 色盲安全,**不**依赖颜色。
- 折叠态单行 + 状态图标前缀;展开态在末尾追加 `! ERR: <msg>` 行表示 error 时附带错误摘要(非折叠态隐藏)。

### 10.1 `DiffPreviewComponent` 升级

| 字段 | 类型 | M5 行为 |
| --- | --- | --- |
| `verb` | `"read"\|"write"\|"edit"\|"bash"` | 表头 verb |
| `path` | string | 表头 path |
| `before` / `after` | string \| undefined | 展开态追加 `  - <before>` / `  + <after>` 行(raw,无真 LCS diff;M3+ polish 阶段) |
| `expanded` | boolean | 折叠/展开 |
| `initialStatus` | `DiffStatus` | 新增;默认 `pending` |
| `errorMessage` | string \| undefined | 新增;`setError(msg)` 同步设 `error` 态 |
| `setStatus` | (s) => void | 新增 setter |
| `setError` | (msg) => void | 新增;同设 status=error |

折叠态示例行:`⏳ ▸ edit src/index.ts` / `✓ ▸ write README.md` / `✗ ▸ edit src/x.ts`(后者展开加 `  ! ERR: <msg>`)

### 10.2 `BashExecutionComponent`(新增)

| 字段 | 类型 | 行为 |
| --- | --- | --- |
| `command` | string | 表头 `$ <cmd>` |
| `runInBackground` | boolean | 表头追加 `(bg) ` 前缀 |
| `maxTailLines` | number | 默认 200;`appendStdout/appendStderr` 超 tail 的部分丢弃 |
| `appendStdout(line)` | (s) => void | 多行追加,自动截尾 |
| `appendStderr(line)` | (s) => void | 同上 |
| `appendOutput(chunk, stream)` | (s, "stdout"\|"stderr") => void | 拆分换行追加 |
| `setStatus(s)` | `BashExecStatus` => void | 改状态图标 |
| `finalize(exitCode, durationMs, isError?, msg?)` | number + number + boolean + string | 同步 set ok/error,记录 exit + 时长 |
| `toggle()` | 折叠/展开 | 折叠态只表头;展开看 stdout/stderr tail + exit + duration + error |

折叠态示例:
- 短命令:`$ npm run build  …`
- 长 background:`$ (bg) long-running-task-id  ⏳`

展开态(multi-line):
```
$ npm run build  ⏳
  stdout:
    hello world
  exit=0  1200ms
```

### 10.3 `ToolCallComponent` 三态对照

| 状态 | icon | 描述 |
| --- | --- | --- |
| pending | ⏳ | toolCall 已入队,等待执行 |
| running | … | `runAgentLoop` 已 dispatch,等齐 `tool_run` 事件 |
| ok | ✓ | `toolResult.isError=false` |
| error | ✗ | `toolResult.isError=true`(setter 同步 errorMessage) |

- `setStatus / setPartialResult / setError / finalize(result, isError)` 同 SetF/exist API;
- 折叠态单行:`icon [toolName <firstLineOfResult>]`,其中 result summary 仅在 ok/error 态显示,running/pending 态隐藏;
- error 态追加 `| ERR: <message>` 至同一行末尾(非折叠时不打断布局)。
