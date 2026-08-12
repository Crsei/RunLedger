# RunLedger TUI 复刻计划 · 00 总览

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

> 本文的 pi-tui 内容保留为历史设计输入。当前 renderer 迁移只以 `17-opentui-refactor-plan.md` 为权威；被动数据合同占位以 `17-passive-data-contract-placeholder-plan.md` 为配套计划；迁移后的流式渲染、长会话性能与交互体验只以 `18-opentui-streaming-performance-ux-plan.md` 为权威；已提前建立的数据结构如何分批接入生产 TUI 只以 `19-passive-contract-integration-plan.md` 为权威；slash 命令输入、补全、派发与二级展示链路由 `20-codex-slash-command-adaptation-plan.md` 跟踪；主对话垂直滚动条的 OpenCode 行为适配、显隐 preference、内建 bar 投影与真实鼠标验收只以 `22-opencode-conversation-scrollbar-adaptation-plan.md` 为权威。

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
| `reference/00-opentui-component-index.md` | OpenTUI 官方 18 个组件的中文能力索引、API 形态与 RunLedger 适用场景 |
| `17-opentui-refactor-plan.md` | pi-tui → OpenTUI imperative core 实现、PTY/native frame 与全仓门禁证据 |
| `17-passive-data-contract-placeholder-plan.md` | framework-neutral 被动数据合同、Timeline/safe view、workflow envelope 与 current canonical session format 收窄占位；不接 renderer 或生产行为 |
| `18-opentui-streaming-performance-ux-plan.md` | OpenTUI 迁移后的增量 timeline、delta 合并、长会话窗口化、背压与响应式交互体验补充计划 |
| `19-passive-contract-integration-plan.md` | 将已完成的 `TuiState`、Timeline、safe presentation 与各领域 workflow 分批接入 reducer/projector/EffectRunner/controller adapter 和标准 `runledger`；不重写合同、renderer 或 Runtime authority |
| `20-codex-slash-command-adaptation-plan.md` | 对照 codex-rs 的 slash command registry、输入期 popup、统一派发、门控与 SelectionView 适配；区分工作树候选、HEAD 与标准 CLI 证据 |
| `21-mermaid-diagram-rendering-implementation-plan.md` | Mermaid fenced block 的受限 Unicode inline projection、OpenTUI 接缝、fallback、缓存/预算与 R1/R2 验收边界；当前 M0–M7 自动门禁完成，人工视觉验收与 license formal review 待确认 |
| `21-mermaid-diagram-rendering-license-manifest.md` | Mermaid R1 直接依赖、未引入的参考实现与 Apache/MIT attribution 边界；不授权 R2 engine/font/sidecar 引入 |
| `22-opencode-conversation-scrollbar-adaptation-plan.md` | 对照 OpenCode 主对话 `ScrollBoxRenderable` 的默认隐藏、显隐 preference、右侧留白、主题化轨道和内建拖拽行为；独立工作树候选已 agent-verified，标准全局链接和真实鼠标/视觉仍 pending |

阅读顺序:`00 → 01 → 02 → 03`(原 pi-tui 设计主路径)→ `04/05/06`(原渲染与定制)→ `07`(历史落地节奏)→ `08/09`(跨项目参照与远期设计)。`10` 是历史更新计划。OpenTUI renderer 重构先以 `17-opentui-refactor-plan.md` 为当前执行入口，并从 `reference/00-opentui-component-index.md` 查组件能力；被动数据合同另读 `17-passive-data-contract-placeholder-plan.md`，它不替换 renderer authority；renderer 计划 P8 获得证据后，再按 `18-opentui-streaming-performance-ux-plan.md` 执行性能与体验阶段；生产接入则从 `19-passive-contract-integration-plan.md` 的 B0 开始，逐域切换单一 state owner；slash 命令链路查 `20-codex-slash-command-adaptation-plan.md`；Mermaid terminal projection 查 `21-mermaid-diagram-rendering-implementation-plan.md` 及配套许可清单。主对话滚动条的当前候选实现与证据查 `22-opencode-conversation-scrollbar-adaptation-plan.md` §0.1/§5.0：它只补 presentation preference 与内建 bar，没有重写 ScrollBox；真实鼠标/视觉和标准全局链接仍不能冒充已验收。

### Mermaid terminal projection 当前状态

Plan 21 的 R1 已在独立工作树完成 M0–M7 的实现与自动门禁：五类受限 Mermaid parser/layout/render、OpenTUI native code-block 接缝、streaming/fallback/resize/theme/selection、bounded cache 与性能观测均已接入当前实现。`npm test`、`npm run check`、`npm run build` 和隔离 `RUNLEDGER_DIR` 的标准 PATH smoke 已有 fresh evidence。

当前仍不能把 R1 标记为最终完成：维护者的 license/NOTICE formal review、dark/light 人工视觉检查、鼠标选择/复制检查、真实终端 resize 视觉检查和五类图表逐类视觉确认尚未完成。R2 PNG/外部查看器仍是独立条件性专项，不因 R1 自动启用。

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
| 状态架构 | Zustand-style `useAppState` 外置 store | `Agent` 是唯一状态源,所有 InteractiveMode 字段读快照 | 采纳,见 `01-architecture.md` §6.1 |
| 特性裁剪 | `featureAdapters.ts` 编译期 no-op 替换 | `src/tui/feature-adapters.ts` 接入点为本期预留 | 接入点预留,见 `02-component-spec.md` §0 |
| 拆分有据 | `initReplBridge`/`replBridge` 因 bundle 膨胀拆,file header 注明拆分理由 | 未来 `interactive-mode.ts` 超 800 行按事件适配/status/overlay 拆,头注释说明 | 原则采纳,见 `02-component-spec.md` §1.1 |
| 双屏互斥 | `'prompt'\\|'transcript'` 早 return 分支隔离 | Overlay 选择器打开时由 pi-tui `showOverlay` 隔离;主对话屏 vs selector 互斥 | 原则已天然覆盖,见 `04-rendering.md` §3 |
| 失败护栏 | `MAX_CONSECUTIVE_INIT_FAILURES = 3`,失败不外抛 | InteractiveMode init 阶段连续失败上限 + 平静退出 | 采纳,见 `03-event-binding.md` §5 |
| 延迟与首屏权衡 | `useDeferredValue` 仅在流式期间生效 | pi-tui 16ms 节流 + turn 结束直渲防 jitter | 等价语义,见 `04-rendering.md` §5 |
| 远程控制 / 进程级 handle | `useReplBridge` + `replBridgeHandle` 单例 | 远期 `src/tui/runtime/repl-handle.ts` 进程级单例 | 远期预留,见 `09-remote-control-roadmap.md` |
| 渲染契约幂等 | React 组件 render 纯函数 | `render(width)` 幂等 + 不副作用 + 不触 mutation | 采纳,见 `04-rendering.md` §2 |

**不采纳**的项(框架不适配或超出本期范围):React/Ink 状态架构、`useInput` hook 模式、bridge WebSocket/SSE 协议、Zeit-style store。理由详见 `08-cross-project-lessons.md` 末节。
