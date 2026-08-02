# 17 · OpenTUI TUI 重构执行计划

> 状态：实现完成；全量门禁与真实 PTY 已通过
>
> 目标分支：`rollback/pre-governed-agent-harness-runtime`
>
> OpenTUI 基线：`@opentui/core@0.4.5`，参考源 `anomalyco/opentui@da5507e1b3d637b946a12b71fb47d112b5d38393`
>
> 本文是本次重构的唯一状态清单。`00`–`10` 保留原 pi-tui 设计与历史输入；其他分支已经存在 `11`–`16`，因此本计划使用跨分支不冲突的编号 `17`。

## 1. 结论先行

RunLedger 的生产 TUI 从 `@earendil-works/pi-tui` 迁移到 OpenTUI imperative core，不引入 React/Solid，不保留双 renderer fallback。Runtime、Session、Auth、Tool 和 ledger authority 均不迁入 UI；重构只替换终端 renderer、布局、输入、焦点、overlay 和 frame 测试层。

最终边界：

```text
InteractiveSessionController / AgentEvent
                  |
                  v
        TUI pure presentation state
                  |
                  v
     OpenTUI renderable projection/adapters
                  |
                  v
       @opentui/core CliRenderer (Bun)
```

OpenTUI 0.4.5 的 native renderer 在 Node.js 中要求 Node 26.4.0 和 experimental FFI。当前仓库环境是 Node 22.23.1 + Bun 1.3.14，因此生产 `runledger` shim 改由 Bun 启动；Node 继续负责 `tsc`、边界检查和无需 native renderer 的纯逻辑测试。

## 2. 当前基线

### 2.1 生产链

- `src/cli/main.ts` 直接构造 `InteractiveMode({ controller })`。
- `src/tui/interactive-mode.ts` 约 1124 行，兼管组件装配、renderer 生命周期、键位、overlay、Auth 交互、命令、历史回放和 AgentEvent 投影。
- `src/tui/index.ts` 大量 re-export `@earendil-works/pi-tui`，使框架类型扩散到业务组件和测试。
- `src/tui/components/*.ts` 多数实现 pi-tui 的 `Component.render(width): string[]`；`CustomEditor` 直接继承 pi-tui `Editor`。
- `src/tui/session-selector.ts` 独立创建第二个 pi-tui `TUI`。
- `bin/runledger.js` 当前使用 `#!/usr/bin/env node` 加载 `dist/cli/cli.js`。

### 2.2 依赖和测试

- 当前依赖：`@earendil-works/pi-tui@0.80.10`。
- `tests/tui/` 有 10 个 Vitest 文件，主要验证字符串 render、FakeTerminal 和控制流。
- 现有测试没有真实 renderer frame、OpenTUI focus、鼠标、resize 或 native cleanup 证据。
- `npm test` 当前全部由 Node + Vitest 执行。

### 2.3 不得被重构破坏的 authority

- `InteractiveSessionController` 继续拥有 prompt、provider/model、thinking、Auth、queue、interrupt 和 dispose。
- `AgentEvent` / `TuiEvent` 仍是 runtime 到 UI 的单向输入；UI 不直接改 ledger/runtime 状态。
- Ctrl+C：有 in-flight 时 interrupt；idle 且 editor 非空时清空；idle 空 editor 双击退出。
- Ctrl+D：仅 idle 且 editor 为空时退出。
- overlay 打开时全局退出/中断键不得越权穿透。
- model/thinking/provider/login/logout 继续走 controller；选择器 highlight 不等于配置已提交。
- 所有工具参数和结果在进入可选择组件前继续遵守现有脱敏/摘要边界。

### 2.4 2026-08-02 实现结果

第 2.1–2.2 节保留为迁移前基线。当前生产链已经切换为：

- `src/tui/primitives.ts` 持有 RunLedger 自有 pure component、输入和 lifecycle façade；
- `src/tui/opentui/component-runtime.ts` 持有唯一 production `CliRenderer`，使用 `BoxRenderable`、`ScrollBoxRenderable`、`TextRenderable`、`MarkdownRenderable`、`TextareaRenderable`、`SelectRenderable` 与 `InputRenderable`；
- `src/tui/opentui/ansi-styled-text.ts` 在 renderer 前把允许的 SGR 转为 `StyledText`，丢弃 OSC/APC/未知 CSI；
- `src/tui/theme/osc-detector.ts` 已删除，theme authority 改为 OpenTUI `theme_mode`；
- `@earendil-works/pi-tui` 已从 source、tests、package 与 lockfile 删除；
- `bin/runledger.js` 是检查 Bun 后 `exec bun dist/cli/cli.js` 的稳定 shim，缺少 Bun 时返回 exit 127 和可操作错误；
- `npm test` 已包含 Node/Vitest 与 Bun native frame 两层测试。

## 3. 目标结构

```text
src/tui/
  index.ts                       只导出 RunLedger TUI 公共 API，不再转售整个框架
  interactive-mode.ts            业务编排；不直接实现终端协议
  presentation.ts                framework-free text/markdown/select/input block
  primitives.ts                  RunLedger pure component/input/lifecycle façade
  opentui/
    runtime.ts                    可注入 renderer 的最小 screen 测试 owner
    component-runtime.ts          production CliRenderer、主 screen 与 presentation adapter
    ansi-styled-text.ts           受限 ANSI -> StyledText 转换
    syntax-style.ts               Markdown/Code/Diff 共用 SyntaxStyle
  components/                     保留业务 presentation state；逐步去框架继承
  keybindings/app-keys.ts         KeyEvent -> app action，生命周期 authority 不变
  session-selector.ts             使用 OpenTUI Select 的独立启动前选择器
tests/tui/
  *.test.ts                       Node/Vitest：纯状态、事件、宽度与 authority
  *.bun.test.ts                   Bun/OpenTUI：真实 frame、输入、focus、resize、cleanup
```

允许在迁移期保留一个窄的 presentation adapter，但最终禁止：

- 从 `src/tui/index.ts` re-export `@opentui/core` 全量 API；
- 生产代码继续 import `@earendil-works/pi-tui`；
- 同一进程按环境自动回退旧 renderer；
- 为测试向生产类增加 test-only 方法；
- 在 render hooks 中修改业务状态或布局树。

## 4. OpenTUI 组件映射

| 现有职责 | OpenTUI 目标 | 迁移说明 |
|---|---|---|
| TUI/ProcessTerminal | `CliRenderer` / `createCliRenderer()` | `screenMode: "alternate-screen"`，`exitOnCtrlC: false`，由 RunLedger 统一退出 |
| root `Container` | `BoxRenderable` | column + `width/height: "100%"` |
| ChatContainer | `ScrollBoxRenderable` | `stickyScroll: true`、`stickyStart: "bottom"`、`viewportCulling: true` |
| AssistantMessage | `MarkdownRenderable` | streaming true→false；不提升实验性 `_stableBlockCount` 为稳定契约 |
| User/Status/Footer/Tool summary | `TextRenderable` / `StyledText` | pure state 经 adapter 投影，默认可选择审计文本 |
| CustomEditor | `TextareaRenderable` | `plainText`、submit、selection、undo/redo、traits |
| SelectorModal/SearchableSelector | `SelectRenderable` + `InputRenderable` | highlight 与 Enter commit 分离，关闭后恢复 editor focus |
| DiffPreview | `DiffRenderable`（仅有 unified diff 时） | before/after 摘要先走 Text adapter；禁止伪造 patch |
| Box/Overlay | `BoxRenderable` absolute + zIndex | root 内单 overlay owner |
| OSC theme detector | `renderer.themeMode` / `theme_mode` | 删除第二套 OSC 探测 authority |
| FakeTerminal visual tests | `@opentui/core/testing` | Bun 下真实 native in-memory frame |

组件能力细节见 [`reference/00-opentui-component-index.md`](reference/00-opentui-component-index.md)。

## 5. 严格执行阶段

阶段顺序不可重排。每个阶段先写一个能证明目标行为缺失的 RED 测试，确认按预期失败后，才允许改生产代码。

### P0 · 基线与 runtime 决策

- [x] 核对当前分支、HEAD、工作树和任务外改动。
- [x] 核对其他本地分支的 `11`–`16` 计划编号，选择 `17`。
- [x] 盘点生产入口、框架 import、TUI 源文件和测试文件。
- [x] 验证 Node 22.23.1、Bun 1.3.14、OpenTUI 0.4.5 runtime envelope。
- [x] 固定 imperative core 方案，不引入 React/Solid reconciler。

验收：本文记录的事实与当前工作树一致。

### P1 · 依赖与可测试 runtime seam

- [x] 新增精确依赖 `@opentui/core@0.4.5`。
- [x] 新增 Bun native frame 测试入口，并从 Node Vitest include 中排除 `*.bun.test.ts`。
- [x] RED：真实 test renderer 能绘制 RunLedger 最小 screen 并在 destroy 后结束。
- [x] 实现 `src/tui/opentui/runtime.ts` 的 renderer factory/lifecycle port。
- [x] 明确 renderer 必须由 owner destroy；禁止依赖 `process.exit` 清理。

验收：`npm test` 同时执行 Node 单测和 Bun OpenTUI frame test；最小 screen frame 可观察。

### P2 · Pure presentation 与 ANSI/StyledText 边界

- [x] RED：现有 ANSI 256 色、粗体、重置和 CJK 文本可转换为等价 `StyledText`，未知/不允许序列不泄漏到 frame。
- [x] 建立最小 `ComponentSnapshot` / presentation adapter，不把 CliRenderer 传入领域状态对象。
- [x] 把宽度、截断和换行辅助从 pi-tui 移到 RunLedger 自有纯函数或 OpenTUI/string-width 公共 API。
- [x] 现有组件先保持纯状态与 snapshot 语义；mutation 后由 adapter 更新 renderable。

验收：Node 单测验证纯转换，Bun frame test 验证颜色/文本与 60/80/143 列宽。

### P3 · 主 screen 与消息 timeline

- [x] RED：固定宽高下 frame 包含 header/resources/chat/status/editor/footer/hints，并且 chat 占用剩余空间。
- [x] 用 `BoxRenderable` 建立 column root。
- [x] 用 `ScrollBoxRenderable` 建立 timeline，启用 bottom sticky 和 viewport culling。
- [x] User/Custom/Tool/Status/Footer 通过窄 adapter 映射为 `TextRenderable`。
- [x] Assistant 使用 `MarkdownRenderable`；流开始为 `streaming=true`，message_end 切为 false。
- [x] resize 后不保留旧 width cache，不输出超过 viewport 的裸行。

验收：60/80/143 列 frame、流式 Markdown 完成态、长工具输出和 resize 回归通过。

### P4 · Textarea、键位与退出 authority

- [x] RED：Enter submit、Alt+Enter follow-up、Alt+Up restore queue、Ctrl+C 三态、Ctrl+D 空闲退出。
- [x] `CustomEditor` 改为 `TextareaRenderable` wrapper/composition，不继承框架私有类。
- [x] 使用 OpenTUI `KeyEvent` 字段匹配，不再解析原始字符串猜测 modifier。
- [x] `exitOnCtrlC: false`；signal handler 与 renderer key handler 统一调用 `InteractiveMode` lifecycle。
- [x] editor traits 可影响 chrome，但不能覆盖 RunLedger 生命周期 authority。

验收：真实 mockInput 驱动 frame/state；overlay 打开时 Ctrl+C/Ctrl+D 不穿透。

### P5 · Overlay、搜索与启动前 Session selector

- [x] RED：Select 上下导航、Enter commit、Escape cancel、search filter、关闭后 editor focus 恢复。
- [x] 建立单一 overlay owner，absolute + zIndex，不允许叠加未释放 overlay。
- [x] `SelectorModal` 映射到 `SelectRenderable`；搜索框使用 `InputRenderable`。
- [x] Auth secret input 不把 secret 回显到 frame、日志或 snapshot。
- [x] `selectSessionInTui()` 改用同一 OpenTUI runtime factory，并保证取消不创建 ledger。

验收：model/provider/auth/session 选择器真实输入测试通过；focus owner 始终唯一。

### P6 · Theme、工具视图和框架去扩散

- [x] RED：theme_mode 切换会更新可见组件；工具 running/ok/error 状态稳定。
- [x] 用 `renderer.themeMode` 和 `theme_mode` 事件替代 `osc-detector.ts` 的第二套探测。
- [x] 为 Markdown/Code/Diff 建立共用 `SyntaxStyle`。
- [x] unified diff 存在时使用 `DiffRenderable`；仅 before/after 摘要时保留诚实的 Text projection（当前 `DiffPreviewComponent` 只有 before/after 摘要，不伪造 unified patch）。
- [x] `src/tui/index.ts` 只导出 RunLedger 公共类型和组件，不转售 OpenTUI。

验收：不存在业务层直接读取 terminal escape response 的第二 authority；框架 import 只在 `src/tui/opentui/` 和必要的 wrapper 内出现。

### P7 · 删除 pi-tui 与切换生产启动器

- [x] RED：静态检查发现任何 `@earendil-works/pi-tui` import 或依赖即失败。
- [x] 删除 `@earendil-works/pi-tui` 依赖并审阅 lockfile。
- [x] `bin/runledger.js` 改为 Bun shim；help/version 等早退路径仍可执行。
- [x] build 后从 `dist/` 启动，不依赖 `tsx` 或 `src/`。
- [x] 不提供 Node 22 renderer fallback；缺少 Bun 时由 shim 给出结构化、可操作错误。

验收：`rg '@earendil-works/pi-tui' src tests package*.json` 零命中；`runledger --help`、`--version` 和 TUI smoke 使用 Bun。

### P8 · 完整门禁、PTY 与文档回写

- [x] `npm run check` 完整通过。
- [x] `npm test` 完整通过，包括 Bun OpenTUI frame tests。
- [x] `npm run build` 完整通过。
- [x] `npm run demo:tui` 在真实 PTY 下启动、输入、退出，验证 60/80/143 列。
- [x] 验证 Ctrl+C、Ctrl+D、resize、selection、paste、overlay focus 和异常 cleanup。
- [x] 更新本文状态、`00-overview.md` 与 `development-doc/00-index.md`。
- [x] 明确记录未完成项；没有真实证据的项不得标 `[x]`。

### P8 证据（2026-08-02）

| 门禁 | 结果 |
|---|---|
| `npm run check` | 通过；current-format、storage、runtime、contract-consumer、execution boundary 与 `tsc --noEmit` 全绿 |
| `npm test` | 通过；Vitest 73 files / 401 tests，Bun OpenTUI 2 files / 3 tests / 36 assertions 全绿 |
| `npm run build` | 通过；`tsc -p tsconfig.json` |
| Bun shim | `./bin/runledger.js --help`、`--version` 通过；无 Bun PATH 返回 127 与 `[runledger] Bun >= 1.3.0 is required...` |
| production PTY | 隔离 `RUNLEDGER_DIR` 下 60/80/143 × 24 均看到 OpenTUI frame，Ctrl+D 后 tmux session 消失，临时目录送入 trash |
| `demo:tui` PTY | 无 `ANTHROPIC_API_KEY` 的 mock 路径在 60/80/143 × 24 均看到 frame，Ctrl+D cleanup 通过 |
| native behavior | `captureCharFrame`、`StyledText`、Markdown streaming、Select/Input、secret mask、theme_mode、resize、paste、mouse selection、focus restore、destroy 均有 Bun/Node 测试 |
| framework boundary | `rg '@earendil-works/pi-tui' src tests package.json package-lock.json` 零命中；`@opentui/core` production import 只在 `src/tui/opentui/` |

Plan 17 已满足完成定义。全历史 projection、overlay 常规 update 重建以及 streaming/长会话性能优化属于后续 Plan 18，不能视为本计划已经实现。

## 6. TDD 与验证命令

每个切片遵循：

```text
写一个行为测试 -> 运行并看到预期 RED -> 最小实现 -> focused GREEN
-> 同域测试 GREEN -> refactor -> 再次 GREEN
```

计划中的门禁命令：

```bash
npx vitest run tests/tui/<focused>.test.ts
bun test tests/tui/<focused>.bun.test.ts
npm run check
npm test
npm run build
npm run demo:tui
```

Native frame 测试使用 `@opentui/core/testing#createTestRenderer()`，断言 `captureCharFrame()` / `captureSpans()` 的真实结果；测试必须在 `finally` 中 destroy renderer。不得用“是否调用 mock render”代替可见 frame 断言。

## 7. 回滚与失败策略

- 每个阶段都应保持可构建；不允许把半迁移的 renderer 作为默认生产入口。
- 若 OpenTUI native test 在 Bun 1.3.14 无法稳定运行，当前阶段停止并保留 RED 证据；不得静默回退 pi-tui。
- package/lockfile、bin shim 和 runtime 切换属于同一最终边界；删除旧依赖前必须已有 OpenTUI production smoke。
- 回滚只回退本计划明确路径，不触碰当前工作树中的 Runtime Trace、Storage 或 Agent Harness 改动。

## 8. 非目标

- 不迁移或重写 `InteractiveSessionController`、Agent loop、ledger、AuthStorage 或 SessionManager。
- 不引入 React、Solid、JSX、OpenTUI plugins、audio、SSH、QR 或 Three.js。
- 不以本次 renderer 重构实现新的 MCP、Skill、Compaction、RBAC 或 remote-control 协议。
- 不把 OpenTUI 实验性 stable-block 字段变成 RunLedger 公共 API。
- 不在本次任务创建 commit 或 push，除非用户另行明确要求。

## 9. 完成定义

只有同时满足以下条件，计划才可标记完成：

1. 生产 CLI 在 Bun 上创建并销毁 OpenTUI native renderer；
2. `@earendil-works/pi-tui` 从生产、测试、package 和 lockfile 中完全移除；
3. 现有 controller/事件/命令/interrupt/queue/Auth 语义由测试守住；
4. OpenTUI frame、input、focus、resize 和 cleanup 有真实 Bun 测试；
5. `npm run check`、`npm test`、`npm run build` 与真实 PTY smoke 全部通过；
6. 本文证据表和导航已回写，没有把计划项冒充已实现能力。
