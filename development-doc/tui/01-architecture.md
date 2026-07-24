# 01 · 整体架构与事件流

> 历史规格说明:本文记录已完成 M0-M7 阶段的设计输入,不再是当前实施权威。
> 当前结构、门禁与实施状态以 `11-tui-structure-completion-plan.md`、代码和测试为准。

> 本文档给出 RunLedger TUI 层的运行架构,以及 `Agent → AgentEvent → TuiEvent → 组件 mutation → 差分渲染` 的完整传递链。读完应可以默画出整棵组件树与所有事件分支的去向。

---

## 1. 与 pi 的对照

pi 的 TUI 层有两件事:**通用框架** 与 **business 组件**。

```
pi-tui (框架)            coding-agent/modes/interactive (业务)
─────────────────       ────────────────────────────────────────
TUI                     InteractiveMode
 - requestRender         - subscribeToAgent(session)
 - doRender 差分         - handleEvent switch
 - showOverlay           - addChild / updateContent / removeChild
Container                chatContainer / pendingMessagesContainer / ...
 - render(width) => lines
Component                user-message / assistant-message / tool-execution / ...
Markdown / Editor / Loader / ...
Terminal / Keys
```

RunLedger 把左侧 (框架) 换成 npm 依赖,只自研右侧 (业务)。同时右侧的事件总线从 pi 的 `AgentSession`(16 个事件类型,含 compaction / queue_update / session_info_changed 等)收敛到本仓库的 `AgentEvent`(5 个事件类型),不引入 pi 的扩展事件总线。

---

## 2. 顶层组件树

装配位置:`src/tui/interactive-mode.ts` 构造函数 + `init()`。

```
TUI (来自 pi-tui)
├── headerContainer            KeybindingHints         顶部键位提示/logo
├── loadedResourcesContainer   LoadedResources        启动资源条(@file、工具数)
├── chatContainer              Container               对话流(顺序追加)
│   ├── UserMessage / AssistantMessage / ToolExecution
│   └── PendingMessages(已入队未发送)
├── statusContainer            Container               占位区,跑动时挂 StatusIndicator
├── editorContainer            CustomEditor            用户多行输入框(依赖 pi-tui Editor)
└── footer                     FooterComponent        pwd / model / tokens / context% / thinking
```

与 pi 的差异:

- 去掉 `widgetContainerAbove` / `widgetContainerBelow`(RunLedger 不引入 extension 模式);
- `chatContainer` 与 `pendingMessagesContainer` 在 pi 中是两个并列容器,本计划合并:pending 消息作为 `PendingMessages` 单节点追加到 `chatContainer` 末尾,简化焦点管理;
- `headerContainer` 与 `loadedResourcesContainer` 在首期可合并为单容器,但分别保留是因为后续会加 logo 动画。

焦点默认在 `editor`,`ui.start()` 启动 TUI。

---

## 3. AgentEvent → TuiEvent 边界

`AgentEvent` 来自 `src/runtime/types.ts`,本计划**不改动**它,在 TUI 层做一层薄包装:

```ts
// src/tui/types.ts
import type { AgentEvent } from "../runtime/types.ts";

export type TuiEvent =
  | { kind: "agent_start" | "agent_end"; timestamp: number }
  | { kind: "turn_start" | "turn_end"; timestamp: number; turn: number; stopReason?: StopReason }
  | { kind: "message_start"; timestamp: number; role: "user" | "assistant" }
  | { kind: "message_end"; timestamp: number; role: "user" | "assistant" }
  | { kind: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { kind: "tool_start"; toolCallId: string; toolName: string }
  | { kind: "tool_end"; toolCallId: string; toolName: string; isError?: boolean };

export function adaptAgentEvent(ev: AgentEvent): TuiEvent;
```

适配规则:

| AgentEvent.type | TuiEvent.kind | 说明 |
|-----------------|--------------|------|
| `agent_start` | `agent_start` | 透传 |
| `agent_end` | `agent_end` | 透传 |
| `turn_start` | `turn_start` | 透传 |
| `turn_end` | `turn_end` | 透传 |
| `message_start` | `message_start` | 透传(只关心 role==="assistant") |
| `message_end` | `message_end` | 同上 |
| `message_update` | `message_update` | 透传 `assistantMessageEvent` |
| `tool_execution_start` | `tool_start` | 重命名,语义等价 |
| `tool_execution_end` | `tool_end` | 同上 |

事件适配层只做"重命名 + 字段对齐"两件小事,不做任何状态持有。它的存在是为了让 `InteractiveMode.handleEvent` 的 switch 不污染 `AgentEvent` 字面量,以便 Agent 端类型变更时不要求 TUI 大改。

---

## 4. 事件订阅与渲染调度

```ts
// src/tui/interactive-mode.ts(骨架伪码)
export class InteractiveMode {
  private readonly ui: TUI;
  private readonly agent: Agent;
  private readonly containerRefs = { /* 各 Container */ };
  private streamingComponent?: AssistantMessageComponent;
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private unsubscribe?: () => void;

  async run(): Promise<void> {
    this.assembleTree();          // 1. addChild 装配
    this.unsubscribe = this.agent.subscribe((ev) => this.handleEvent(adaptAgentEvent(ev)));
    await this.ui.start();        // 2. 阻塞,直到 Ctrl+C / app.exit
    this.unsubscribe?.();
  }

  private async handleEvent(ev: TuiEvent): Promise<void> {
    switch (ev.kind) {
      case "message_start": /* 见 03-event-binding.md 第 3 节 */
      case "message_update": /* */
      case "message_end": /* */
      case "tool_start": /* */
      case "tool_end": /* */
      // ...
    }
    this.footer.invalidate();
    this.ui.requestRender();   // 每个 ev 后强制 request,被 16ms 节流合帧
  }
}
```

调度语义与 pi 一致:`MIN_RENDER_INTERVAL_MS = 16`(pi-tui 默认),`process.nextTick` 合帧;Spinner 内部用 80ms 自驱动。

---

## 5. 数据流总览

```
            ┌──────────────── runtime ──────────────────┐
            │                                            │
   user ───►│  Agent.prompt(text)                        │
   types    │      │                                     │
   <ctrl>   │      ▼                                     │
   stdin    │  runAgentLoop                              │
   handleInput  │  └─► streamFn (mock / provider stream) │
            │      │                                     │
            │      ▼  emit AgentEvent                    │
            │   Agent.dispatch ────► subscribers ──┐     │
            │                                     │     │
            └─────────────────────────────────────┼─────┘
                                                  ▼
            ┌──────────────── tui ────────────────────┐
            │  InteractiveMode.handleEvent(TuiEvent)  │
            │      │                                  │
            │      ▼                                  │
            │  switch(ev.kind) {                      │
            │    message_start: new AssistantMessage  │
            │    message_update: updateContent        │
            │    tool_start:      new ToolExecution   │
            │    tool_end:        updateResult        │
            │  }                                     │
            │      │                                  │
            │      ▼                                  │
            │  ui.requestRender() ───► doRender diff  │
            │      │                                  │
            │      ▼                                  │
            │  process.stdout.write(ANSI)             │
            └─────────────────────────────────────────┘
```

---

## 6. 与 Runtime 层的依赖契约

TUI 层依赖:
- `Agent`(`src/runtime/agent.ts`)—— 唯一状态源,提供 `subscribe` / `prompt` / `state` / `setModel` 等接口;
- `AgentEvent` / `AssistantMessageEvent` / `ToolCall`(`src/runtime/types.ts`、`src/types.ts`)—— 事件与消息类型;
- `LedgerSink`(`src/runtime/ledger/types.ts`)—— 仅 footer/footer-data-provider 读取 `sessionId` / `header().metadata`;
- `models-store.ts` / `providers/*` —— 选择器阶段读取 model catalog(`pickModel(modelId)`);
- `paths.ts` / `getAgentDir()` —— footer 显示当前 cwd 与 ledger 路径。

TUI 层**不触碰**:
- `agent-loop.ts` 内部状态机;
- `convertToLlm` 翻码逻辑;
- pi-ai 的 provider 内部 API 调用细节(走 `streamFn` 抽象)。

---

## 6.1 单一状态源原则的工程化对应

`claude-code-bun` REPL 通过 Zustand-style `useAppState` 把状态外置 store,巨型 `REPL.tsx` 组件只读快照、突变只在专用回调路径发生。RunLedger 不引入 React,但同形原则同样适用:

- `src/runtime/agent.ts` 中的 `Agent` 是 TUI 层**唯一**状态源;`Agent.subscribe` 已提供同步派发;
- `InteractiveMode` 的所有持态字段(`streamingComponent` / `pendingTools` / `pendingToolCalls` / `activeStatus` 等)是对 `AgentEvent` 流的**派生缓存**,不是独立真值;
- 任何对 TUI 组件 mutation 必须从 `handleEvent` 路径触发,**禁止**在 `render(width)` / `FooterSnapshotProvider.getSnapshot()` / `KeybindingsManager` 回调里反向修改组件树;
- 一次 `handleEvent` 末尾**统一**调 `ui.requestRender()`,不在每个 mutation API 内部自调,避免一帧多次合帧调度。

这条原则是 03 文档"分支策略第 2 条"的工程化由来,也是 04 文档"渲染契约"对偶面:状态只有一处写口,渲染就只有一处合帧口。

---

## 7. 可独立测试性(本架构的额外红利)

每个组件都要可单独 new + 喂事件 + 断言 `render(width)` 输出。

```ts
// tests/tui/assistant-message.test.ts(假想)
const c = new AssistantMessageComponent({ theme });
c.updateContent({ content: [{ type: "text", text: "hello" }] } as any);
const lines = c.render(80);
assert(lines.join("").includes("hello"));
```

不依赖 TUI start、不依赖 stdin,跑在 vitest 默认环境。这条性质决定了每个组件必须依赖注入 `theme`,而不是访问全局单例。

---

## 8. 入口极薄与动态 import 懒加载

对照 `claude-code-bun` 的 `replLauncher.tsx`(28 行,只做 lazy import `App` 与 `REPL` 后 mount):RunLedger 的 CLI 入口同样保持极薄,组件树装配延迟到 `InteractiveMode.init()` 完成:

```
src/cli/main.ts (极薄入口,本期目标 < 80 行)
  └─ argv 解析(本期只认 -m/--model、--session、--debug)
  └─ 加载 .env(若有)与 RUNLEDGER_DIR 等环境
  └─ new InteractiveMode({...}).run()       // 完整装配在 InteractiveMode 内
        └─ assembleTree() (sync)             // Container 实例化
        └─ subscribe Agent                  // 事件钩子
        └─ await ui.start()                 // 阻塞至 Ctrl+D / app.exit
```

按需 import 边界:

| 模块 | 时机 | 理由 |
|------|------|------|
| `runtime/stream-mock.ts` / `runtime/stream-from-provider.ts` | 顶层 import | 启动路径直接选,无懒加载价值 |
| `theme/theme.ts` | 顶层 import | 每个组件依赖注入,必须即时可用 |
| `theme/theme-controller.ts`(OSC 11 监听) | InteractiveMode.init 后 lazy import | 仅在 InteractiveMode 实例化时需要,daemon 路径(`runledger remote send`)无需 |
| `selectors/*.ts`(M5) | 由 `InteractiveMode.openOverlay()` 按需 lazy import | 选择器只在用户触发瞬间加载,首屏冷启动 0 开销 |
| `runtime/repl-handle.ts` | (远期)由 InteractiveMode `run()` 入口注册 | 本期不创建此文件,见 §9 |

> 注:`AGENTS.md` §2 限制"不使用内联 `await import()` 动态导入,只用顶层 `import`"。本节所述"按需 import"指 **InteractiveMode 初始化阶段**(而非渲染或事件回调)加载某些运行时分支模块,**全部是顶层 import**,不违反约束。若未来确实需要延迟到用户操作之后再加载某模块(典型的如 OSC 11 探测),则用 env-flag 顶层 import,而非动态 `await import()`。

---

## 9. 进程级 singleton handle 预留(远期)

未来若引入 daemon、`runledger remote send` 子命令、外部 IDE 插件等需要**反向操作**当前运行的 InteractiveMode 的场景,RunLedger 将沿用 `claude-code-bun` 的 `replBridgeHandle.ts` 模式:进程级单例 handle,`getReplHandle()` 返回当前活跃 InteractiveMode 的对外接口,`setReplHandle(h)` 由 `InteractiveMode.run()` 入口注册、退出时清空。

**本期 M0–M7 不创建该文件**,只在以下位置预留:

- `src/tui/index.ts` barrel 不导出 handle 相关 API;
- `InteractiveMode` 不暴露 send / interrupt / setModel / setThinking 之外的任何 internnal;
- 任何 module 想"反向戳 TUI"时通过依赖注入(例如 `daemon` 模块由 main.ts 显式传入 InteractiveMode 引用),不通过全局单例。

远期接口契约、文件拆分、失败护栏预案详见 `09-remote-control-roadmap.md`。

---

## 10. 与第 1 节 pic 对照表的对偶增补

第 1 节对照了 pi 的框架与业务两层;第 6.1、§8、§9 三节是 RunLedger 在工程化层面相对 pi-ai 移植层的额外结构性约束,本期 TUI 复刻必须遵守。`08-cross-project-lessons.md` 给出与 `claude-code-bun` 的逐条对照速查。
