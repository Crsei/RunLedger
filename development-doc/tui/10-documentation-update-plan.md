# TUI 文档更新计划:跨项目 lessons 增量补充

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_ddb2fbdb-6d15-4a10-8ded-24719b8bde31.md`。
> 本文记录 TUI 文档的跨项目经验补充任务;当前设计入口为本目录 `00-overview.md`,细化内容见 `01`–`09` 系列文档。

## 范围与原则

**目标**:把从 `claude-code-bun` REPL 分析中提取的、与框架无关的设计原则,以"原地增量补充"的方式整合进 `development-doc/tui/` 七份既有文档,并新增两份独立篇章沉淀跨项目规则与远期远程控制设计。

**不改变**:
- pi-tui 框架选型与命令式 Container/Component 渲染模型保持不变;
- 既有 M0–M7 里程碑结构与估时不动;
- 11 个业务组件规格不动;
- AGENTS.md 工作流约束(中文注释、erasableSyntaxOnly、相对路径 import 带 `.ts` 后缀等)在所有新增文本里严格遵守。

**采纳的跨项目原则**(用户已勾选):
- 入口极薄 + 动态 import 懒加载
- 拆分有据(只在 bundle/职责边界触发,文件头注释说明)
- 失败护栏(连续失败硬上限,避免事件风暴)
- 双屏互斥(早 return 分支隔离)
- 渲染契约幂等 + 不副作用
- 进程级 singleton handle 让非 TUI 代码反向戳 TUI(留接口,本期不实现)
- `featureAdapters` 在文档中预留接入点(本期不实现)
- 远程控制桥作为独立远期篇章

## 文件改动清单(9 份文档)

### 既有文档变更(7 份)

#### `00-overview.md`
- §4 文档导航表加两行:`08-cross-project-lessons.md`(跨项目设计规则沉淀,与 claude-code-bun REPL 对照)与 `09-remote-control-roadmap.md`(进程级 singleton handle + 远程控制桥远期设计);
- §6 与 pi 的对照一眼看表后新增 §7 "与 claude-code-bun REPL 对照一眼看表":列出 9 个原则维度(入口厚度/状态架构/特性裁剪/拆分有据/双屏/失败护栏/延迟渲染/远程控制/渲染契约),pi / claude-code-bun / RunLedger 三栏对照;
- 阅读顺序更新为 `00 → 01 → 02 → 03 → 04/05/06 → 07 → 08/09(参考性远期)`。

#### `01-architecture.md`
- §6 与 Runtime 层的依赖契约后,新增 §6.1 "单一状态源原则的工程化对应"(对应 claude-code-bun 的 useAppState 外置 store):重申 RunLedger 中 `Agent` 是唯一状态源,所有 InteractiveMode 字段只读快照,突变只在 handleEvent 末尾 `requestRender`;
- 新增 §8 "入口极薄与动态 import 懒加载":说明 `src/cli/main.ts` 入口只解析 argv → 调 `InteractiveMode.run()`,不持有 TUI 组件;`runtime/stream-from-provider.ts` 与 `runtime/stream-mock.ts` 通过顶层 import,但 `theme/theme-controller.ts` / `selectors/*` 由 InteractiveMode 在 init 阶段按需 import,避免 bootstrap 包膨胀;
- 新增 §9 "进程级 singleton handle 预留(远期)":指出未来若有 daemon / `runledger remote` CLI 子命令需要反向操作当前 InteractiveMode,经 `src/tui/runtime/repl-handle.ts` 单例 getter/setter 拿到 handle,远期设计详见 `09-remote-control-roadmap.md`;本期**不实现**该文件,只在 `01-architecture.md` 文字中留契约位。

#### `02-component-spec.md`
- §0 公共类型约定末尾加一节"feature adapters 预留接入点":定义 `src/tui/feature-adapters.ts` 草拟接口(每个 adapter 是 no-op/lib 真实实现二选一,编译期由 env 决定),本期所有 adapter 返回 no-op,主组件树 import 时统一从该文件取;
- §1 InteractiveMode 持态字段表末尾加 `private consecutiveInitFailures = 0;`、`private static readonly MAX_CONSECUTIVE_INIT_FAILURES = 3;` 两字段;
- §1 不可变契约列表新增三条:
  - "不在 `handleEvent` 里 `await` REPL 外异步副作用"(原文已有强化语,补一条对照解释);
  - "构造/init 阶段任何 `import` 失败连续 ≥3 次时停止重试,记日志不入死循环";
  - "feature-adapters 接入点为唯一拓展口,新特性不绕过此文件直接在组件树加 `if (process.env.X)`";
- §1 后新增 §1.1 "拆分有据"小节:以伪 file-header 注释格式给出未来如果 `interactive-mode.ts` 文件超 800 行的拆分判据(事件适配层 / status 管理 / overlay 桥 各自拆出),文件头首行必须写明拆分理由(bundle / 职责边界 / 测试边界 三类之一)。

#### `03-event-binding.md`
- §2 分支策略加第 5 条:"入口与异常不外溢"——`handleEvent` 任何分支失败记 stderr,不向 `agent.subscribe` 调用方抛;`agent_end` 紧随异常事件时,异常状态被 status error 兜底(对照 claude-code-bun `MAX_CONSECUTIVE_INIT_FAILURES` 思想);
- §5 异常路径表新增一行:"`InteractiveMode` init 阶段连续失败 ≥3 次 / 进入死循环" → "把 InteractiveMode 标 disabled,记 stderr,`ui.stop()` 平静退出,不抛";
- §5 末尾新增"失败护栏常量"小节:列出 `MAX_CONSECUTIVE_INIT_FAILUREURES = 3`、`INIT_FAILURE_BACKOFF_MS = 10000` 两个常量,源约定。

#### `04-rendering.md`
- §2 渲染契约表追加两行:
  - "`render(width)` 在被多次调用期间不得累积任何外部可观测副作用(IO、网络、订阅注册)";
  - "`render(width)` 不得触发对其它组件 mutation API 调用(组件突变必须从 `handleEvent` 路径触发,避免双向耦合)";
- §5 节流与合帧新增"延迟与首屏权衡"小段:对应 claude-code-bun `useDeferredValue` 思想落到 pi-tui 的等价物——`message_update` 高频流式期间,InteractiveMode 用 `nextTick` 合帧 + 16ms 节流;turn 结束后**不**走 deferred 路径,直渲 final content 防 spinner 与 final 之间出现 jitter gap。本期不需写代码,只在文档明确该语义优先级;
- §6 ANSI 协议保留项加一句"`?2026h` 同步输出协议禁止 RunLedger 自行覆写"对应该规则的强化,原文已写"不覆写",补充一个理由注释:"半帧渲染在快速切屏中会撕裂 multiline 工具结果,pi-tui doRender 已包,RunLedger 在任何路径不得绕过"。

#### `05-theme.md`
- §10 与 pi 的差异点表末尾补一行:"用户自定义 \[env 覆盖 RUNLEDGER_THEME_<KEY>\]" 三栏对照(本期已支持 env 覆盖,补 claude-code-bun 也是 env-driven 的对照说明,文字一行,不动 schema)。

#### `06-keybindings.md`
- §7 与 pi 的对照末尾加一句"对照说明":claude-code-bun 通过 `RUNLEDGER_KEYBIND_*` 同形态 env 覆盖,RunLedger 采纳同形态,机制完全等价,无新增。

#### `07-roadmap.md`
- "独立任务对接清单"表新增两行:
  1. "featureAdapters 接入点" → 在 `src/tui/feature-adapters.ts` 中切请新特性从 no-op 到真实实现;契约详见 `02-component-spec.md` §0 末;
  2. "进程级 singleton handle / 远程控制桥" → 远期任务,接口契约详见 `09-remote-control-roadmap.md`,M0–M7 不实现;
- M0 末尾"风险"小节新增一行:"若 pi-tui 包发布带 `feature` 编译期开关则 featureAdapters 可省;若不带则 feature-adapters.ts 退化为运行时 if + lazy import,本期接受该退化形态"。

### 新建文档(2 份)

#### `08-cross-project-lessons.md`(新)
集中沉淀跨项目提取规则。结构:
1. 引言:本文件是从 `claude-code-bun` REPL 实现分析的、与 TUI 框架无关的设计原则集结;在 RunLedger TUI 复刻中,**作为参照,** 不作为强制规约。被任何里程碑采纳的规则在对应 M 文档中已**点出**。
2. 9 条规则逐条说明:
   - 规则名 / 原项目实现位置(file:line) / 适配 RunLedger 的形态 / 落文档位置 / 本期采纳与否;
   - 9 条覆盖:入口极薄、状态外置、特性裁剪、拆分有据、双屏互斥、失败护栏、延迟与首屏权衡、singleton handle、渲染契约幂等。
3. 三栏对照速查表(规则 × 原项目 vs RunLedger):列出每条规则在本仓库已落 / 待落 / 不采纳 的状态。
4. 末尾"不采纳条款":明确不会移植的项(React/Ink 状态架构、`useInput` hook 模式、bridge WebSocket 协议、Zeit-style store),并说明理由(框架不同 / 引入跨平台风险 / 超出本期范围)。

#### `09-remote-control-roadmap.md`(新)
独立远期篇章,设计进程级 singleton handle + 远程控制桥。结构:
1. 范围:本文件描述 RunLedger 未来如何让非 TUI 代码(`runledger remote send`、daemon、其他终端)反向操作当前运行的 InteractiveMode。本期 M0–M7 不实现。
2. 触发场景:3 个用例(daemon 内存清理通知、CLI 远程命令切换 session、外部 IDE 触发 prompt)。
3. 接口契约(草案):
   - `src/tui/runtime/repl-handle.ts`(本期不创建,先约定形状):`getReplHandle(): ReplHandle | null` / `setReplHandle(h | null)` 返回当前活跃 InteractiveMode handle;
   - `ReplHandle` 接口:`sendText(text: string): void` / `interrupt(): void` / `setModel(modelId: string): { ok: true } | { ok: false; error: string }` / `setThinking(mode): { ok } | { ok: false; error }` / `dispose(): void`;
   - 单例注册时机:`InteractiveMode.run()` 入口 `setReplHandle(this)`,退出时 `setReplHandle(null)`。
4. 边界:handle 不持有 React tree / pi-tui 子组件引用,只暴露事件式 API;调用方在 handle 路径上**不**触发 mutation,而是把请求转 `EventTarget` 风格事件,InteractiveMode 在 `handleEvent` 路径同步消费。这一条对应 claude-code-bun `replBridgeHandle.ts` 的进程级 singleton 思想与 `initBridgeCore`/`replBridge.ts` 拆分有据的工程分割。
5. 拆分有据应用:远程控制桥若最终落地,文件拆分预拟(对照 claude-code-bun):
   - `runtime/repl-handle.ts`(36 行级,纯 singleton);
   - `runtime/init-bridge.ts`(薄壳,读 bootstrap state);
   - `runtime/bridge-core.ts`(无 bootstrap 依赖核心);
   - `runtime/bridge-transport.ts`(transports);
   每个文件头注释必须写明拆分理由(bundle / 职责 / 测试边界)。
6. 失败护栏预案:`MAX_CONSECUTIVE_BRIDGE_INIT_FAILURES = 3`,`BRIDGE_FAILURE_DISMISS_MS = 10_000`。
7. 与 M0–M7 的非冲突性确认:本期所有组件树装配不读取 `repl-handle`,文件如不创建则 `getReplHandle()` 返回 null 不影响 typecheck;M8 任务开始时新建文件即可。

## 验证标准

- 9 份 TUI 文档全部通过 `npm run check` 不适用(纯 md 文件),但**至少**:
  - 所有新增的代码示例与 type 声明遵守 AGENTS.md §2 (erasableSyntaxOnly、`import type`、相对路径带 `.ts` 后缀、无 `enum`);
  - 中文注释风格与现有文档一致(简洁技术化,无 emoji,不堆形容词);
  - 08 / 09 新文档中**只引用真实存在**的 RunLedger 路径(`src/runtime/types.ts` / `src/runtime/agent.ts` 等),不杜撰;
  - 09 远期文档中提到的 `src/tui/runtime/repl-handle.ts` 等**未来文件**必须以"本期不存在,远期创建"明确标注,避免误导读者以为是已有文件。
- 7 份既有文档变更**只新增不删改**:不动现有任何章节大标题、不重排编号,只在各文件末尾或指定小节末追加新内容。

## 提交拆分

预计 1 个 PR:工作量纯文档,无代码改动,无 `npm run check` 触发;合并入 `feat/agent-loop-resurrect` 分支前由 reviewer 一并审阅。

## 不做的事

- 不创建任何 `src/tui/` 下的真实代码文件(本期复刻尚未开始 M0);
- 不修改任何已存在的 src/ 代码或测试;
- 不引入新依赖;
- 不改变 `package.json` / `tsconfig.json`;
- 不动 `AGENTS.md`。
