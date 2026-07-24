# RunLedger TUI 复刻计划 · 00 总览

> 当前实施入口:截至 2026-07-24,M0-M7 复刻已经完成;下一轮 command/session 与
> 整体应用结构完善以 `11-tui-structure-completion-plan.md` 为权威计划。该计划使用
> P 架构/安全门禁与 V0-V30 正常 TUI 可见切片双轨推进,实际实现、验收和提交以 V 切片为单位。

> 本目录是 RunLedger 复刻 pi TUI 的开发计划。pi 的 TUI 由两部分组成:
>
> 1. `@earendil-works/pi-tui`(`pi/packages/tui/`)—— 通用 TUI 框架,差分渲染 + Kitty 键盘协议 + Overlay 系统,依赖极轻(仅 `marked` / `get-east-asian-width` / `chalk`);
> 2. `pi/packages/coding-agent/src/modes/interactive/`—— 在 `pi-tui` 上构建的 `InteractiveMode` 命令式组件树 + AgentSession 事件订阅。
>
> RunLedger 不重新发明 TUI 框架,**直接复用 `@earendil-works/pi-tui` 作为外部依赖**,只移植"事件 → 组件 mutation → requestRender"三段式架构本身。本计划的对象是第 (2) 部分,框架层只在"边界契约"章节出现。

---

## 1. 目标与非目标

### 1.1 目标

- 在 `src/tui/` 下建立 RunLedger 自有的 InteractiveMode 与业务组件;
- 用 TUI 形式消费 `src/runtime/agent.ts` 中的 `Agent` 与 `AgentEvent`,实现最小可用的"账本审计对话" UX;
- 复用 pi-tui 后,只对 RunLedger 自身组件负责单元测试,pi-tui 行为不重测;
- 主题、键位、Overlay 模式选择器全部就位,构成可演示的最小工业品 CLI。

### 1.2 非目标(本期)

- 不重写差分渲染引擎、不重写 Kitty 键盘协议、不重写 `Markdown`/`Editor`/`Loader` 这些纯底层组件(pi-tui 已就位);
- 不引入 pi 的 `extension`/`skill`/`prompt-template`/`first-time-setup`/`oauth-selector`/`branch-summary` 等彩蛋与扩展体系;
- 不实现 Compaction、branch summarization 与 Context usage;Steering / Follow-up 队列已由 runtime 接入;
- 不做 Windows 原生修饰键 N-API 桥(`pi-tui` 已自带 `native-modifiers.ts`,无需我们重做);
- `tests/` 中 `agent-loop.test.ts` 仍由 agent-loop 填实独立任务接管,与本计划无关。

---

## 2. 目录结构(本计划落地后的样子)

```
src/
  tui/                          RunLedger TUI 层
    index.ts                    barrel,导出 InteractiveMode / runInteractive / 组件
    interactive-mode.ts         InteractiveMode 主类:装配组件树 + 订阅 AgentEvent
    types.ts                    本地 TUI 类型:TuiEvent 适配层、组件 props、键位 enum
    components/
      user-message.ts           用户消息气泡(带 OSC133 Prompt 区)
      assistant-message.ts      助手消息气泡(支持 updateContent 增量重渲)
      tool-execution.ts         工具调用展示(三 shell 之一渲染 + updateArgs/updateResult)
      bash-execution.ts         Bash 工具专用(DynamicBorder + 防爆 truncate)
      custom-message.ts         兜底自定义消息节点
      status-indicator.ts       Working / Idle / Error / Compaction 状态指示器
      footer.ts                 pwd / model / tokens / context% / thinking 模式
      keybinding-hints.ts       顶部 logo + 键位提示条
      loaded-resources.ts       启动资源条(@file / 工具声明计数)
      pending-messages.ts       已排队未发送的 follow-up 消息
    selectors/
      ledger-session-selector.ts   选择历史 ledger session
      thinking-selector.ts         thinking 模式(low/medium/high/off)
      trust-selector.ts           信任目录确认
    theme/
      theme.ts                  20 色槽 theme API + fg/bg helper
      dark.json                 暗色主题
      light.json                亮色主题
      theme-controller.ts       OSC 11 跟随切换 + invalidate
    keybindings.ts              AppKeybinding 枚举 + KeybindingsManager 适配
    runtime/
      stream-mock.ts            走 mock-stream 驱动的 streamFn(开发期 demo)
      stream-from-provider.ts   用 src/api/* 的 provider 拼出 streamFn(生产)
  cli/
    main.ts                     入口:解析 args → 选 mode →InteractiveMode.run()
    args.ts                     argv 解析(本期只支持 -m/--model、--session)
  index.ts                      顶层 barrel,新增 export * from "./tui/index.ts"
examples/
  tui-demo.ts                   最小 demo:mock-stream + InteractiveMode
tests/
  tui/                          TUI 单测(仅自身组件的 updateContent/updateArgs 逻辑)
development-doc/tui/            本计划所在目录
```

---

## 3. 阶段切片(详见 `07-roadmap.md`)

- **M0 引入 pi-tui 依赖与 barrel** —— 1 文件改动 + package.json
- **M1 InteractiveMode 空骨架** —— 顶层组件树跑起来,只显示 header + footer
- **M2 事件订阅与消息渲染** —— UserMessage / AssistantMessage 接住 mock-stream 的事件流
- **M3 工具调用渲染** —— ToolExecution / BashExecution 接住 tool_execution_*
- **M4 状态指示器与资源条** —— StatusIndicator、KeybindingHints、LoadedResources
- **M5 选择器与模态** —— Overlay 承载的 3 个 selector 跑通
- **M6 主题与键位** —— 20 色槽主题 + KeybindingsManager 适配
- **M7 打磨与测试** —— 节流闪烁、IME 跟随、单测、examples/tui-demo.ts

每阶段结束的标准都包含 `npm run check` 全绿 + 至少运行一次 `tsx examples/tui-demo.ts` 跑通。

---

## 4. 文档导航

| 文档 | 内容 |
|------|------|
| `00-overview.md` | 本文:目标、目录、阶段、阅读顺序 |
| `01-architecture.md` | 与 pi 的对照、事件流、组件树根、`Agent → AgentEvent → TuiEvent` 边界 |
| `02-component-spec.md` | 每个组件的**唯一准确表达**(props / 状态 / render 契约 / 输入契约) |
| `03-event-binding.md` | `AgentEvent.type` × 组件 mutation 的完整映射表 |
| `04-rendering.md` | 差分渲染、Overlay 栈、滚动、ANSI 同步、节流参数 |
| `05-theme.md` | 20 色槽 schema、dark/light 占位值、`theme.fg/bg` API |
| `06-keybindings.md` | AppKeybinding 枚举 + 默认键位映射 + 重载机制 |
| `07-roadmap.md` | 8 个里程碑的子任务拆解、验证标准、风险点 |
| `08-cross-project-lessons.md` | 从 `claude-code-bun` REPL 提取的、与 TUI 框架无关的设计原则集结,作参照用 |
| `09-remote-control-roadmap.md` | 进程级 singleton handle + 远程控制桥的远期设计,本期 M0–M7 不实现 |
| `10-documentation-update-plan.md` | `08` / `09` 两份文档的历史更新计划与验收边界 |
| `11-tui-structure-completion-plan.md` | 当前权威实施计划:command/session、统一 Timeline、P 门禁 + V0-V30 正常 TUI 可见切片 |

阅读顺序:`00 → 11`(当前实施主路径)→ `01/02/03`(历史架构与组件细节)→
`04/05/06`(渲染与定制)→ `07/10`(历史计划)→ `08/09`(跨项目参照与远期设计)。

---

## 5. 既有约束(本计划遵守)

- `tsconfig.base.json` 锁定 `strict: true` / `verbatimModuleSyntax: true` / `erasableSyntaxOnly: true` / `module: NodeNext` / `allowImportingTsExtensions: true`;
- 相对路径 import **必须带 `.ts` 后缀**,编译时 TS 自动重写为 `.js`;
- 禁止 `any`(必要时立即给 `// why any` 注释);
- 异步工具方法不抛错,错误以 `stopReason: "error"` 或 `{ ok: false }` 编码;
- 中文注释,简洁技术化;
- 顶层 `import` only,禁止内联 `await import()`;
- 修改后跑 `npm run check`,所有 error/warning/info 清零再提交;
- `git add <path>` only,禁止 `-A` / `--no-verify`。

---

## 6. 与 pi 的对照一眼看表

| 维度 | pi | RunLedger 本计划 |
|------|----|----|
| 框架 | `pi/packages/tui`(自研) | `@earendil-works/pi-tui`(npm 依赖) |
| 主类 | `InteractiveMode` 7 文件连环 | `InteractiveMode` 单文件 + selectors/ |
| 组件数 | ~45 个业务组件 | 11 个业务组件 (M0–M6 累计) |
| 主题色槽 | 70 个 | 20 个 |
| 选择器 | 12+ 个 | 3 个 |
| 事件总线 | `AgentSession.subscribe` 自有 16 个事件 | 直接接 `Agent.subscribe(AgentEvent)`,5 个事件 |
| Compaction / Steering | 有 | Steering/Follow-up 已完成;Compaction 未实现 |
| Extension / Skill / Prompt template | 有 | 无 |
| 彩蛋/公告 | 3 个 | 无 |
| 工具执行展示 | Bash/Edit/Grep/Read/... 等 | Bash 一类(Demo)+ 通用 Tool 兜底 |

---

## 7. 与 claude-code-bun REPL 的对照(跨项目 lessons)

`claude-code-bun` 的 REPL 实现见 `F:\AIclassmanager\cc\claude-code-bun`,采用 React + Ink,与 RunLedger 选用的 pi-tui(命令式差分渲染)属不同框架。从该项目提取的**与框架无关**的设计原则集中沉淀在 `08-cross-project-lessons.md`,本节给出速查对照:

| 设计维度 | `claude-code-bun` 实现 | RunLedger 适配形态 | 是否采纳 |
|----------|-----------------------|---------------------|----------|
| 入口厚度 | `replLauncher.tsx` 28 行 + 动态 import 懒加载 | `src/cli/main.ts` 极薄入口,theme/selectors 由 InteractiveMode init 阶段按需 import | 采纳,见 `01-architecture.md` §8 |
| 状态架构 | 自定义 external store + `useSyncExternalStore`/`useAppState` facade | `Agent` 是唯一状态源,所有 InteractiveMode 字段读快照 | 采纳,见 `01-architecture.md` §6.1 |
| 特性裁剪 | `featureAdapters.ts` 编译期 no-op 替换 | `src/tui/feature-adapters.ts` 接入点为本期预留 | 接入点预留,见 `02-component-spec.md` §0 |
| 拆分有据 | `initReplBridge`/`replBridge` 因 bundle 膨胀拆,file header 注明拆分理由 | 未来 `interactive-mode.ts` 超 800 行按事件适配/status/overlay 拆,头注释说明 | 原则采纳,见 `02-component-spec.md` §1.1 |
| 双屏互斥 | `'prompt'\\|'transcript'` 早 return 分支隔离 | Overlay 选择器打开时由 pi-tui `showOverlay` 隔离;主对话屏 vs selector 互斥 | 原则已天然覆盖,见 `04-rendering.md` §3 |
| 失败护栏 | `MAX_CONSECUTIVE_INIT_FAILURES = 3`,失败不外抛 | InteractiveMode init 阶段连续失败上限 + 平静退出 | 采纳,见 `03-event-binding.md` §5 |
| 延迟与首屏权衡 | `useDeferredValue` 仅在流式期间生效 | pi-tui 16ms 节流 + turn 结束直渲防 jitter | 等价语义,见 `04-rendering.md` §5 |
| 远程控制 / 进程级 handle | `useReplBridge` + `replBridgeHandle` 单例 | 远期 `src/tui/runtime/repl-handle.ts` 进程级单例 | 远期预留,见 `09-remote-control-roadmap.md` |
| 渲染契约幂等 | React 组件 render 纯函数 | `render(width)` 幂等 + 不副作用 + 不触 mutation | 采纳,见 `04-rendering.md` §2 |

**不采纳**的项(框架不适配或超出本期范围):React/Ink 状态架构、`useInput` hook 模式、bridge WebSocket/SSE 协议、Zeit-style store。理由详见 `08-cross-project-lessons.md` 末节。
