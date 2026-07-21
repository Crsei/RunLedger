# 07 · 路线图与子任务拆解

> 本文档把 TUI 复刻切为 8 个里程碑(M0–M7),每个里程碑列出**子任务**、**变更文件**、**验证标准**、**估时**(参考,非承诺)、**风险**。

> 估时单位为"理想半天"(约 4h 集中编码 + 跑通 `npm run check`)。

---

## M0 引入 pi-tui 依赖与 barrel **0.5d**

### 目标
让 `import { TUI, Container, ... } from "@earendil-works/pi-tui"` 在 RunLedger 中可被 typecheck,准备安装骨架。

### 子任务
1. `package.json` 加入 `"@earendil-works/pi-tui": "^0.80.10"`(版本与 pi `packages/tui` 一致);
2. `npm install` → 锁 `package-lock.json`;
3. 新建 `src/tui/index.ts` 空 barrel(`export {} from "@earendil-works/pi-tui"` 起步);
4. `tsconfig.json` 的 `include` 已包含 `src/**/*.ts`,确认无需修改 `exclude`;
5. RUN `npm run check` 通过,无新警告。

### 验证
- `npm run check` 0 error;
- `node -e "import('@earendil-works/pi-tui').then(m => console.log(Object.keys(m).length))"` 输出 ≥ 30;
- `git status`:`package.json` / `package-lock.json` / `src/tui/index.ts` 三变动。

### 风险
- pi-tui 还未发布到 npm 公共 registry;
  - 备选 1:使用 `pnpm pack` 把 `pi/packages/tui` 打 tgz,本地 `file:../pi/packages/tui` 依赖;
  - 备选 2:把 `packages/tui/dist` 拷贝到 `RunLedger/vendor/pi-tui/`(本期更稳,但维护代价最高);
  - **推荐**:先试公共 registry,不行就退到 `file:` 链接复制。
- 若 pi-tui 包发布带 `feature()` 编译期开关(`bun:bundle` 风格),`feature-adapters.ts`(见 `02-component-spec.md` §0.1)可用编译期消除死分支,tree-shaking 后零成本;若不带,则退化为顶层 `process.env` 分支 + tree-shaking 兼容写法,本期接受该退化形态,**不**改用运行期 `await import()` 切换以遵守 AGENTS.md §2。

---

## M1 InteractiveMode 空骨架 **1d**

### 目标
跑起 TUI,只显示 `KeybindingHints` 顶 + `FooterComponent` 底 + 空 `editor`,可输入回车进入 `agent.prompt(text)`。

### 子任务
1. `src/tui/types.ts`:`BaseComponentProps`、`FooterSnapshotProvider`、`TuiEvent` + `adaptAgentEvent`;
2. `src/tui/theme/theme.ts`:`Theme` / `loadTheme("dark")`,加载 `dark.json`(本期可硬编码色槽在 .ts);
3. `src/tui/components/keybinding-hints.ts`:纯展示;
4. `src/tui/components/footer.ts`:`FooterSnapshotProvider` 初版返回 `{ cwd: process.cwd(), gitBranch: undefined, modelLabel: "mock", thinking: "off" }`;
5. `src/tui/components/custom-editor.ts`:`extends Editor`,装配 app.* 用空 handler;
6. `src/tui/interactive-mode.ts`:`assembleTree()` + `run()` + `quit()`,挂载 6 个容器;
7. `examples/tui-demo.ts`:用 `runtime/tools/echo.ts` + `runtime/providers/mock-stream.ts` 起 mock Agent,跑 InteractiveMode;
8. `src/index.ts` barrel 加入 `export * from "./tui/index.ts"`。

### 验证
- `npm run check` 通过;
- `tsx examples/tui-demo.ts` 看到三行 UI(顶 / 空 / 底),输入文字回车 → 无异常;(本期不接事件回显)
- Ctrl+D/Ctrl+C 可退出。

### 风险
- pi-tui `TUI` 构造函数签名变更(版本同步风险)→ 在 M0 锁版本时通过 `package-lock` 消除。

---

## M2 用户/助手消息渲染 **1.5d**

### 目标
mock-stream 单回 `text` 事件时,能在 chatContainer 看到 UserMessage + AssistantMessage,带流式 token 显示。

### 子任务
1. `src/tui/components/user-message.ts`:渲染 OSC133 wrap + theme.bg;
2. `src/tui/components/assistant-message.ts`:`updateContent` 全量替换、马克down 渲染、hideThinking 默认 true;
3. InteractiveMode `handleEvent`:`agent_start` / `message_start(asst)` / `message_update(text)` / `message_end(asst)` / `agent_end` 5 个分支;
4. CustomEditor 的回车回 callback:`onSend(text) → InteractiveMode.send(text)`;
5. InteractiveMode.send:`chatContainer.addChild(new UserMessageComponent({ theme, text }))` + `agent.prompt(text)` fire-and-forget;
6. `tests/tui/assistant-message.test.ts`:单测 `updateContent` 后 render 输出含 text;
7. `tests/tui/user-message.test.ts`:单测 OSC133 wrap 存在。

### 验证
- `npm run check` + `npm test` 通过;
- `tsx examples/tui-demo.ts` 输入"hello" → 助手回 "echo: hello"(mock-stream 默认行为);
- 差分渲染视觉验证:token 流式时只底部行变化,顶部 user 块稳定;
- 单测 ≥ 2 个通过。

### 风险
- pi-tui `Markdown` 渲染对中文 super-wide 处理坑(此项由 pi-tui 兜底,但 RunLedger 测试需覆盖一个中文流式场景);
- OSC 133 在某些终端无视觉反馈(正常)。

---

## M3 工具调用渲染 **1.5d**

### 目标
mock-stream 含 `toolCall.echo` 时,ToolExecutionComponent 接住,显示 `args` → 收 result → 折叠。

### 子任务
1. `src/tui/components/tool-execution.ts`:基类 + contentBox shell;
2. `src/tui/components/bash-execution.ts`:DynamicBorder shell,本期不接真 Bash,只做静态 mock 提示(防 demo 镶嵌真实 bash 风险);
3. InteractiveMode:`message_update(toolCall)` / `tool_execution_start` / `tool_execution_end` 三分支(见 03 文档 §3.8.3 §3.9 §3.10);
4. `attachToolExecution` 工厂:依据 `toolName === "bash"` 选 bash 子类;
5. `pendingTools` / `pendingToolCalls` Map 管理;
6. `tests/tui/tool-execution.test.ts`:测 updateArgs → markArgsComplete → updateResult → setExpanded 状态序列;
7. `examples/tui-demo.ts` 增 mock-stream 一个含 `echo` + `bash` 双工具的 prompt demo。

### 验证
- mock 流回报含工具结果,显示边框 + 完成对勾;
- 'Ctrl+E' 折叠/展开最近一个工具(M5 之后真接 `app.expandLastTool`,本期先 noop 也可);
- 单测 ≥ 1 个通过。

### 风险
- `ToolCall.input` 累积增量的格式:`ArgumentsAccumulator` 由 mock-stream 提供增量文本,RunLedger 把它每次 `JSON.parse` 防 partial JSON 报错(用 try/catch + 上次成功 args 兜底)。

---

## M4 状态指示器与资源条 **1d**

### 目标
StatusIndicator 在 working/error/idle 三态可显,LoadedResources 启动信息持久展示。

### 子任务
1. `src/tui/components/status-indicator.ts`:`extends Loader`;
2. `src/tui/components/loaded-resources.ts`:读 `agent.state.tools.length` 与 ledger path;
3. InteractiveMode `ensureStatus` / `clearStatusIndicator` helper;
4. `toggleThinking` 模式 placeholder(显示在 footer);
5. `tests/tui/status-indicator.test.ts`:kind 切换 + message 更新。

### 验证
- 看到工作状态 spinner;
- 工具失败 → status 切 error 1 秒后清;
- 启动时 LoadedResources 显示工具数与 ledger 路径。

### 风险
- Loader 在 startContainer 为空时不渲染:确保至少留一空行避免布局抖动。

---

## M5 选择器与模态 **1d**

### 目标
3 个 selector 都能开 → 选 → 关,选中后触发对应行为。

### 子任务
1. `src/tui/selectors/ledger-session-selector.ts`:扫描 `getAgentDir()` 目录列 `.jsonl` 文件,选中后**只**显示新 sessionId,本期不替换 Agent(防误操作断 ledger);
2. `src/tui/selectors/thinking-selector.ts`:off/low/medium/high;
3. `src/tui/selectors/trust-selector.ts`:trust once / always / abort;
4. `InteractiveMode` 桥方法:`openOverlay(name)`,`closeOverlay()`;
5. CustomEditor hot-replace `onEscape` 的 stack 管理;
6. 测 `tests/tui/selectors.test.ts`(基础覆盖)。

### 验证
- `Ctrl+O` 打开 LedgerSessionSelector,Esc 关闭;
- `Ctrl+T` 打开 ThinkingSelector,4 项可选;
- TrustSelector 启动时若 cwd 未注册,自动弹出。

### 风险
- pi-tui `SelectList` 在高 overlay 行数超出 maxHeight 时滚动行为需校验;
- Esc 焦点恢复后 editor 文本不应被清。

---

## M6 主题与键位 **1d**

### 目标
20 色槽主题 doc 落 code、dark.json/light.json 双套到位、OSC 11 自动跟随。

### 子任务
1. `src/tui/theme/theme.ts`:JSON load + `fg` / `bg` API + 默认值;
2. `src/tui/theme/dark.json` + `light.json`;
3. `src/tui/theme/theme-controller.ts`:`InteractiveThemeController` 接 pi-tui Terminal OSC;
4. `src/tui/theme/theme-schema.json`:JSON Schema(本期静态文件,不消费);
5. `src/tui/keybindings.ts`:`AppKeybinding` 枚举 + `createKeybindingsManager` + env 覆盖;
6. `KeybindingHints` 接 live keybindings;
7. `tests/tui/theme.test.ts`:20 槽存在 + `#RRGGBB` 合法;
8. `tests/tui/keybindings.test.ts`:env 覆盖功能。

### 验证
- 启动后切终端 OSC 11 → 自动切色调;
- `RUNLEDGER_THEME_ACCENT=#ff00aa tsx examples/tui-demo.ts` logo 强调色变化;
- `RUNLEDGER_KEYBIND_APP_EXIT=ctrl+q` 后 Ctrl+Q 退出、Ctrl+D 不退出。

### 风险
- pi-tui 是否提供 `setKeybinding` 单个批量覆盖 API 若无,需写小桥 shim 做 patched config。

---

## M7 打磨与测试 **1d**

### 目标
节流闪烁清理、IME 测试、各 examples 跑通、单测覆盖率 ≥ 60%。

### 子任务
1. `RUNLEDGER_DEBUG=1` 的 stderr 日志体系接入(InteractiveMode 包装一层);
2. 在 Windows Terminal / iTerm2 / kitty 三种实测:
   - Windows Terminal:Git Bash stdin 模式 + Winpty 兼容;
   - iTerm2:OSC 11 + IME 输入法;
   - kitty:Kitty 键盘协议 + 同步输出;
3. `examples/tui-demo.ts` 加注释说明每个场景对应 M0–M6 的何阶段;
4. 完整 `tests/tui/` 单测跑过,补 ≥ 5 个新单测保证 renderer snapshot;
5. README 摘要章节(`docs/tui.md` 或 `README.md` 段落) 说明启动命令;
6. `npm run check` 全绿,`npm test` 全绿;
7. PR 描述写到 `development-doc/tui/00-overview.md` 链接,提交前自审。

### 验证(整机)
- 在 `pi/packages/tui` dist 已发布的版本下,**本地无任何修改** 即可跑 `tsx examples/tui-demo.ts`;
- 输入中文连续 10 字符 IME 候选窗跟随光标(关键 KPI);
- 单测覆盖 ≥ 60%(用 `vitest --coverage`);
- Windows / macOS 双平台跑通(对等的实测样本,同等 demo)。

### 风险
- IME 在 Git Bash 下偶尔丢候选序号(pi-tui 已兜底,但 RunLedger 在 ZERO 修改时仍需验证)。

---

## 总投入与节奏

| 里程碑 | 估时 |
|--------|------|
| M0 | 0.5d |
| M1 | 1d |
| M2 | 1.5d |
| M3 | 1.5d |
| M4 | 1d |
| M5 | 1d |
| M6 | 1d |
| M7 | 1d |
| **合计** | **8.5d** (理想半天) |

折合实际投入按 0.6 利用率,约 14 个工作日 / 3 周。

---

## 提交规范(每个里程碑公用的 PR shape)

- 每个里程碑一个 PR;
- 每个 PR **只**新增 `src/tui/...`、`tests/tui/...`、`examples/tui-demo.ts` 或 `package.json` 等该里程碑声明的文件;
- 永远不在同一 PR 跨 milestones 提交(防止 review 负担陡增);
- PR title:`feat(tui): <milestone summary>`,以"为什么"作为 body(具体见 AGENTS.md §3);
- 任何文件若引用了 pi 类型,行内注释 `// 对照 pi/packages/.../<file>.ts:<line>`(本期允许但不强求)。

---

## 回退与暂停

- 若 M0 pi-tui 无法安装 → 转"拷贝 dist 到 vendor/pi-tui"路线,本期前面 8 文档不修改;
- 若 M2 单测失败于 pi-tui `Markdown` 渲染细节 → 跳过对应单测,只做 examples 视觉验证,在 PR 中说明跳过原因;
- 若 M7 双终端 IME 验收不能在任何 1 个终端通过 → PR 上清楚标注"已知不通过",作为 M8 跨平台补丁任务入口。

---

## 独立任务对接清单(本期**不**做,但要预留路径)

| 任务 | 接口预留 |
|------|----------|
| agent-loop 填实(接管 `tests/agent-loop.test.ts`) | `Agent.prompt` 行为不变,TUI 只依赖事件,无影响 |
| LLM provider 接 real model | 替换 streamFn,UI 不动 |
| Trust 持久化 | `LedgerSessionSelector` 现已知 cwd 字段,持久化机制加在 `getAgentDir()` 同侧 |
| Compaction / Steering / Follow-up queue | `InteractiveMode.handleEvent` 留 case `compaction_*` / `queue_update` 占位 noop |
| Skills / Prompt templates | 不在 TUI 层做引入;若 pi 文档要求 UI 显 skill 状态,加 `LoadedResources.kind="skill"` 项即可 |
| Extension 窗口/widget | 不在 M7 前做;若做,加 `widgetContainerAbove/Below`,本期组件树第 2 / 第 7 位之间预留空位 |
| featureAdapters 接入点 | 在 `src/tui/feature-adapters.ts` 中切请新特性(voice / proactive / IDE 集成等)从 no-op 到真实实现;主组件树已约定**不**散落 `if (process.env.X)`,契约详见 `02-component-spec.md` §0.1 |
| 进程级 singleton handle / 远程控制桥 | 远期任务,接口契约详见 `09-remote-control-roadmap.md`,M0–M7 不实现;本期不创建 `src/tui/runtime/repl-handle.ts`,主组件树通过依赖注入交互 |

---

## 完成 checklist(填到 README 或验收报告)

- [ ] M0 pi-tui 装好
- [ ] M1 空骨架跑 UI
- [ ] M2 消息气泡 + 流式
- [ ] M3 工具调用
- [ ] M4 状态 + 资源条
- [ ] M5 selectors
- [ ] M6 theme + keybindings
- [ ] M7 跨平台 + 单测
- [ ] `npm run check` 绿
- [ ] `npm test` 绿
- [ ] vision/docs 与代码无 drift
