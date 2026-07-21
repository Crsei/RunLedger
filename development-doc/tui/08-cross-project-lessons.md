# 08 · 跨项目 lessons 速查(对照 claude-code-bun REPL)

> 本文件是从 `claude-code-bun` 项目 REPL 实现分析中提取的、**与 TUI 框架无关**的设计原则集结;在 RunLedger TUI 复刻中**作为参照**,不是强制规约。被任何里程碑采纳的规则,在对应 M 文档中已点出落地点。

源项目位置:`F:\AIclassmanager\cc\claude-code-bun`(React + Ink 实现,基于 Zustand 外置 store)。

---

## 1. 提取过程

通过阅读以下文件提取:

| 文件 | 提取要点 |
|------|----------|
| `src/replLauncher.tsx` | 28 行入口极薄模式 + 动态 import 懒加载 |
| `src/screens/REPL.tsx` `onSubmit`(line 3443 起) | `'prompt' \\| 'transcript'` 双屏互斥早 return 分支 |
| `src/hooks/useReplBridge.tsx` | 进程级 singleton handle + bridge 状态机 |
| `src/bridge/initReplBridge.ts:1-13` | 文件头注释"拆分理由"工程化范式 |
| `src/screens/repl/featureAdapters.ts` | 编译期可选特性 no-op 替换,主组件树无 if 散落 |
| `MAX_CONSECUTIVE_INIT_FAILURES = 3`、`BRIDGE_FAILURE_DISMISS_MS = 10_000` | 失败护栏硬上限,防 stuck client 风暴 |

---

## 2. 9 条规则逐条对照

### 规则 1:入口极薄 + 动态 import 懒加载

- **原项目实现位置**:`src/replLauncher.tsx`(28 行),`launchRepl()` 内部 `await import("./components/App.js")` 懒加载;
- **适配 RunLedger 形态**:`src/cli/main.ts` 仅做 argv 解析 + env 加载 + `new InteractiveMode({...}).run()`;`theme/theme-controller.ts` / `selectors/*` 由 InteractiveMode init 阶段按需顶层 import;
- **落文档位置**:`01-architecture.md` §8;
- **本期采纳**:采纳;
- **AGENTS.md 约束**:不可用内联 `await import()` 动态导入,改用 init 阶段顶层 import。

### 规则 2:状态外置 + 唯一状态源

- **原项目实现位置**:`useAppState` / `useAppStateStore`(Zustand-style 外置 store),`REPL.tsx` 巨型组件只读 snapshot;
- **适配 RunLedger 形态**:RunLedger 不用 React;`src/runtime/agent.ts` 中的 `Agent` 是 TUI 层唯一状态源;`InteractiveMode` 字段是 `AgentEvent` 流的派生缓存;
- **落文档位置**:`01-architecture.md` §6.1"单一状态源原则的工程化对应";
- **本期采纳**:采纳;
- **不采纳部分**:不引入 Zustand-style store;pi-tui 命令式模型中"组件持态 + 单向流"已能表达同样原则。

### 规则 3:特性裁剪 featureAdapters

- **原项目实现位置**:`src/screens/repl/featureAdapters.ts`,每个可选特性在该文件导出两种实现二选一,主组件树 import 统一从此处取;
- **适配 RunLedger 形态**:`src/tui/feature-adapters.ts` 作为接入点;本期所有 adapter 返回 no-op,主组件树 import 该文件;新特性切换只改一处;
- **落文档位置**:`02-component-spec.md` §0.1;
- **本期采纳**:接入点**预留**,文件本期不创建,见 `07-roadmap.md` 独立任务对接清单。

### 规则 4:拆分有据(file-header 注释规范)

- **原项目实现位置**:`src/bridge/initReplBridge.ts:1-13`,文件头第一段注释以"拆分理由"开篇,具体说明 bundle 膨胀 + daemon 复用核心;
- **适配 RunLedger 形态**:`src/tui/interactive-mode.ts` 超 800 行 / 引入 pi-ai 子树导致 bundle 膨胀 / 有独立测试边界 三类信号触发拆分;拆出文件首段必须保留拆分理由注释;
- **落文档位置**:`02-component-spec.md` §1.1;
- **本期采纳**:采纳,判据常量化。

### 规则 5:双屏互斥(早 return 分支隔离)

- **原项目实现位置**:`REPL.tsx::onSubmit` 中 `'prompt'` 与 `'transcript'` 模式早 return,两路径互不污染;
- **适配 RunLedger 形态**:pi-tui `Overlay` 系统天然聚焦隔离;主对话屏 vs selector 互斥;`InteractiveMode.openOverlay()` 与 `handleEvent` 走不同控制流;
- **落文档位置**:`04-rendering.md` §3(Overlay 使用,原文已覆盖);本 lessons 文档显式标注对照说明;
- **本期采纳**:已被 pi-tui 框架天然覆盖,无新增实现。

### 规则 6:失败护栏(连续失败硬上限)

- **原项目实现位置**:`MAX_CONSECUTIVE_INIT_FAILURES = 3`、`BRIDGE_FAILURE_DISMISS_MS = 10_000`;Datadog 2026-03-08 数据:某 stuck client 一天 2879 次 401,占该路由 17% 401;
- **适配 RunLedger 形态**:`InteractiveMode.MAX_CONSECUTIVE_INIT_FAILURES = 3` + `INIT_FAILURE_BACKOFF_MS = 10_000`;init 阶段连续失败达上限后 `ui.stop()` 平静退出,不抛;
- **落文档位置**:`02-component-spec.md` §1 持态字段表末尾、`03-event-binding.md` §5 异常路径表 + §5.1 失败护栏常量;
- **本期采纳**:采纳,常量与异常路径 spec 已对齐。

### 规则 7:延迟与首屏权衡

- **原项目实现位置**:`useDeferredValue` 仅在流式期间生效,turn 结束后绕开 deferred 路径防 spinner 与 final content 之间出现 jitter gap;
- **适配 RunLedger 形态**:pi-tui 16 ms 节流 + 终结事件后直渲最终状态;不延迟 `setTimeout` 尾巴;
- **落文档位置**:`04-rendering.md` §5.1;
- **本期采纳**:语义对偶采纳,本期不写额外代码;`InteractiveMode.handleEvent` 已天然契合此原则。

### 规则 8:进程级 singleton handle(远期)

- **原项目实现位置**:`src/bridge/replBridgeHandle.ts` + `useReplBridge.tsx` 进程级单例;非 React 代码(SDK / daemon)经由 handle 反向操作 REPL;
- **适配 RunLedger 形态**:远期 `src/tui/runtime/repl-handle.ts` 进程级单例;本期不创建;`InteractiveMode.run()` 入口未来注册、退出清空;
- **落文档位置**:`01-architecture.md` §9 预留契约位,完整远期设计见 `09-remote-control-roadmap.md`;
- **本期采纳**:接入点预留,文件本期不创建。

### 规则 9:渲染契约幂等 + 不副作用

- **原项目实现位置**:React 组件 render 是纯函数;effect 与渲染严格隔离;hooks 强制副作用路径;
- **适配 RunLedger 形态**:pi-tui 没有 React 这层强制,在 spec 层用契约兜:`render(width)` 幂等、不副作用、不触发其它组件 mutation;
- **落文档位置**:`04-rendering.md` §2 渲染契约表后两行;
- **本期采纳**:采纳,显式写出"渲染→突变→再渲染"循环禁令。

---

## 3. 三栏对照速查表

每行状态 = 已落 / 待落(本期不实现)/ 不采纳。

| # | 规则 | `claude-code-bun` 实现 | RunLedger 形态 | 状态 |
|---|------|-----------------------|----------------|------|
| 1 | 入口极薄 | 28 行 launcher + lazy import | 极薄 main.ts + init 阶段顶层 import | 已落(`01` §8) |
| 2 | 状态外置 | `useAppState` Zustand | `Agent` 唯一状态源 + 组件派生缓存 | 已落(`01` §6.1) |
| 3 | 特性裁剪 | `featureAdapters.ts` no-op 替换 | 接入点预留,文件本期不创建 | 待落(`02` §0.1) |
| 4 | 拆分有据 | `initReplBridge` 文件头注明理由 | 文件 ≥ 800 行 / bundle / 测试边界三类判据 | 已落(`02` §1.1) |
| 5 | 双屏互斥 | `'prompt'\\|'transcript'` 早 return | pi-tui `Overlay` 天然聚焦隔离 | 已天然覆盖(`04` §3) |
| 6 | 失败护栏 | `MAX_CONSECUTIVE_INIT_FAILURES = 3` | 同名常量 + 平静退出 | 已落(`02` §1、`03` §5.1) |
| 7 | 延迟与首屏权衡 | `useDeferredValue` 流式期间生效 | pi-tui 16 ms 合帧 + 终结事件直渲 | 已天然覆盖(`04` §5.1) |
| 8 | 进程级 singleton handle | `replBridgeHandle` + `useReplBridge` | 接入点预留,文件本期不创建 | 待落(`01` §9、`09`) |
| 9 | 渲染契约幂等 | React component render 纯函数 | spec 层用契约兜(无 React 强制) | 已落(`04` §2) |

---

## 4. 不采纳条款

以下 `claude-code-bun` 实现**不**移植到 RunLedger,理由如下:

| 不采纳项 | 原项目位置 | 不采纳理由 |
|---------|-----------|-----------|
| React + Ink 状态架构 | `useAppState` / `REPL.tsx` 巨型组件 | RunLedger 选用 pi-tui 命令式 Container/Component 模型,框架不同;对照状态外置原则只保留"单一状态源"思想(规则 2),不引入 React 调度 |
| `useInput` hook 模式 | React hook 路径 | pi-tui 走 `handleInput(data)` dispatch,不通过 hooks;模式不同,迁移成本大于收益 |
| Bridge WebSocket / SSE 协议 | `useReplBridge.tsx` 远程控制桥 | 引入跨平台 web socket / 长轮询复杂度;远程控制需求本质在 RunLedger 中可经 stdin / IPC / 文件信号 多种方式,本期不锁死协议 |
| Zeit-style store | Zustand | 不引入新依赖;pi-tui 命令式模型中"组件持态 + 单向流"已能表达同原则 |
| `tengu_*` analytics 事件 | `REPL.tsx::onSubmit` 中 `logEvent('tengu_*')` | 商业埋点,与 RunLedger 开源策略不冲突但**不**自带;若需 telemetry 由后续 telemetry 任务独立设计 |
| 50+ 屏幕 / dialog launchers | `src/screens/` 下大量子屏 | 本期只 11 个业务组件,不抄整套生态 |
| `daemonBridge` 与 Agent SDK 入口 | `src/bridge/daemonBridge.ts`、`src/entrypoints/agentSdk*` | RunLedger 不引入 Agent SDK 商业分发路径;远程控制走 §09 单例 handle 即可 |

不采纳条款在后续若被重新评估,需在该表追加"重新评估理由 + 评估日期",并同步 `07-roadmap.md` 独立任务对接清单。

---

## 5. 维护方式

- 本文件每次新增 / 修改对照规则,**同步**在 `00-overview.md` §7 速查表中更新一行;
- `07-roadmap.md` 独立任务对接清单每加一项远期任务,如源自本文件某条规则,需在该任务条目末尾标注"(对应 `08-cross-project-lessons.md` §X)";
- `claude-code-bun` 项目本身若发生大改,本文件不自动同步;只在实际提取时更新。
