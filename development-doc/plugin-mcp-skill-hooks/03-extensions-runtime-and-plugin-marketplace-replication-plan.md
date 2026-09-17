# Extensions 运行时与 Plugin 分发/Marketplace 完整复刻计划

> 状态:**P0 完成,进入 P1**。P0 已交付 §5.2 契约、§8 事件增量、Q1–Q4 裁定;P1–P7 未开始。
> 基线日期:2026-09-17;RunLedger 基线为当前工作树 `rollback/before-composer-shape`(`git status` 含并发未提交改动,HEAD `2b046ef`;实施前必须重新核对)。
> 参考基线:oh-my-pi `3b3a6dc9bbd85102ce19d0b1c11bf6870915f6ec`(`packages/coding-agent` v18.1.17,本机 `/data2-HDD-SATA-20T/Digital_avatar/haoweiyao/oh-my-pi`,工作树干净 0 dirty);下文 omp 行号以该工作树为准,仅为机制参考,不是 RunLedger 完成证据。
> 适用范围:`src/extensions/**`、`src/runtime/{session-runtime,harness-profiles,protocol,contracts,tools,agent-loop}/**`、`src/security/**`、`src/storage/**`、`src/cli/**`、`src/tui/**`、`src/contracts/**` 与对应 `tests/**`。
> 上位计划:Runtime 04(公共类型/schema/event catalog、Resource contract)、Runtime 06(Session Owner、owner fence、command/query/subscription)、[`01-implementation-plan.md`](01-implementation-plan.md)(Plugin/MCP/Skill/Hooks 总状态账本)、[`02-skill-registry-discovery-provider-refactor-plan.md`](02-skill-registry-discovery-provider-refactor-plan.md)(Skill Registry/Provider 设计与阶段证据)。
> 姊妹计划:[`../plan/16-omp-tool-parity-update-plan.md`](../plan/16-omp-tool-parity-update-plan.md)(新工具准入 checklist)、[`../plan/17-omp-loop-goal-mode-adaptation-plan.md`](../plan/17-omp-loop-goal-mode-adaptation-plan.md)(omp 行为移植范式 D1–D15)、[`../plan/13-package-boundary-workspace-refactor-plan.md`](../plan/13-package-boundary-workspace-refactor-plan.md)(Extension host 若独立成包时的边界先例)。
> 修订记录:2026-09-17 初版。依据三路只读侦察(omp Extensions runtime 接口面、omp Plugin/Marketplace 磁盘与 CLI 契约、RunLedger `src/extensions/**` 现状与缺口)撰写。
> 修订记录:2026-09-17 P0 收口。Q1–Q4 按推荐项裁定;§5.2 契约落 `src/contracts/extensions/**`;§8 事件增量落 `src/runtime/protocol/events.ts`;`01` §13/M7 同步。

## 0. 文档定位与执行规则

### 0.1 与既有计划的关系

- [`01`](01-implementation-plan.md) 继续拥有 **Plugin / MCP / Skill / Hooks 总状态**。本文件只拥有“可执行扩展运行时 + Plugin 分发/Marketplace”这一子专题的**设计、决策与阶段证据**,不建立第二份总账;本文件的阶段勾选必须回写到 `01` 的复选框或状态表。
- `01` §13 非目标明确排除“任意 JavaScript/TypeScript 进程内 plugin entrypoint”与“marketplace、Git clone/update、签名分发和自动升级”;`01` §8 M7 还把 marketplace 列为**第二阶段能力**。本计划**正面接管这两条被显式排除的能力**,因此 §4 D1 是一次**架构边界变更**,必须先经 §12 裁定,再动代码。裁定通过后必须同步修订 `01` §13 与 M7,不得两份文档并存两种口径。
- `02` 已确立 Skill 侧的范式:被动 registry、provider 只产出 observation、discovery/enable/trust/invocation 四层分离、provider rank 不拥有覆盖权(`02` §3 D1–D8)。本计划**完整继承**该范式,把 Plugin 从“私有 Skill 容器”提升为“扩展分发包”时不得回退这些性质。
- Runtime 04 拥有公共类型/schema/event catalog。本计划 §8 的契约增量属于 Runtime 04 的 work package,行为 PR 不得顺带改写 event allowlist。
- 本文档不修改 `docs/subsystems/extensions.md` 的“当前事实”地位;该页在阶段落地后按实际行为更新。

### 0.2 不变边界(来自根 `AGENTS.md`,本文不申请放宽)

- 不新增、扩展、移植或重构 OS sandbox、文件系统/网络 namespace、进程隔离实现。
- 工具副作用继续经 Security/ExecutionGateway、Attempt Gateway 与 owner fence;保持 fail closed,不用 raw I/O、`AllowAll` 或未记录直连让测试通过。
- 标准 CLI/TUI 只经 Session Owner 的 command/query/subscription;client 不持有 store、不直接调用 controller、不创建第二 writer。
- 单一 canonical `runledgerHome`(`RUNLEDGER_DIR` 必须是既有绝对目录,否则 `~/.runledger`);不恢复项目 `.runledger/`、旧 `~/.runledger/agent/` 或任意 session 路径作为隐式 authority;`settings.sessionDir`、`RUNLEDGER_SESSION_DIR`、`--session-dir` 继续拒绝。
- Harness Profile 在 Session 创建时冻结、fork 继承;`minimal@1`/`minimal@2`/`plan@1` 不装配扩展;Profile 不改变权限 authority。
- 产品内 child 委派保持默认关闭、root-owned sequential readonly、depth=1;扩展不得放开 child 能力。
- `resolve-config-value.ts` 只支持字面值与 `${ENV_VAR}`,**不引入 `$(cmd)` 执行**。直接约束 §5 的 marketplace source 与 MCP/hook 配置模板。
- 测试始终使用隔离 `RUNLEDGER_DIR`,不得操作真实用户目录或复制真实凭据到测试目录。
- 平台差异经 `src/workspace/` adapter;业务模块不新增 `process.platform` 分支。

### 0.3 执行规则

- 一次只实施一个可独立验收的 PR 边界;**契约 PR(P0)与行为 PR 分离**;P0 不产生任何运行时行为变化。
- 每个代码 PR 运行完整 `npm run check` 与受影响测试桶;进入 `dist/` 的代码另做 `npm run build` 与真实 `runledger` 验证(§9)。
- 用户可见功能必须有 owner-fenced durable command 与 canonical event 证据,**不得用 client-local 状态或 TUI 布尔值伪装完成**。
- **不得把 adapter/fake-port 测试当作生产闭环**;每个阶段完成时在 §15 补齐 commit、命令与逐条结果。
- 本计划引入的独立缺陷不与功能 PR 混提;发现既有缺陷时单独记录、单独验收。
- 与 `01`/`02` 的冲突以 `01` 总状态与 Runtime 04 契约为准;本文件的 D 编号是增量,沿用 `17` 的 D 范式。

## 1. 当前基线

### 1.1 RunLedger 已有:声明式扩展面,无扩展运行时、无分发

`src/extensions/**` 共 50 文件 / 约 7,411 行,是**被动、digest/trust 门禁的声明式扩展面**,由 Session Owner 组合根每次 owned Session 装配一次。

| 现有关键物 | 位置 | 性质 |
|---|---|---|
| `PluginManager` | `src/extensions/plugins/manager.ts:193` | 只做发现/校验/启用/信任;读 `.runledger-plugin/plugin.json`,做 `./` 路径 containment、hook 文档解析、被动 skill contribution;`skillContributions()` 无调用方(`:376`) |
| Plugin manifest | `src/extensions/plugins/manager.ts:28` `MANIFEST_KEYS = [name, version, description, author, keywords, skills, hooks, mcpServers]` | 只有当前 exact shape;**未知字段是 error**(`:74`);无 `commands`/`agents`/`settings`/`lspServers` |
| `ExtensionManager` | `src/extensions/manager.ts:98` | 唯一控制面:发现合并、快照 generation++、idle-only swap、enable/trust/untrust |
| `ExtensionSnapshotStore` | `src/extensions/snapshot.ts:120` | `beginTurn`/`endTurn`/`requestReload`/`swap`;`swap()` 在 `#activeTurns > 0` 时拒绝并要求 generation 严格递增(`:143-152`) |
| 生产能力 | `src/runtime/session-runtime/extension-composition.ts:129-152` | session 私有 operation manifest:`extension.inspect`、`plugin.list`、`skill.*`、`hook.list`、`mcp.*`(read/mutate 分离) |
| 生产构造 | `src/runtime/session-runtime/extension-composition.ts:361` | 单次装配 storage/trust/state/PluginManager/SkillRegistry/ExtensionManager/MCP/Hook/TurnLifecycle |
| Profile 门控 | `src/runtime/harness-profiles/builtins.ts:17-22`、`:44-49` | `standard@2` 四项全开;`minimal@1`/`minimal@2`/`plan@1` 全关;门控字段 `extensions.{tools,context,hooks,lifecycle}`(`types.ts:30-35`) |
| CLI 控制命令 | `src/cli/control-commands.ts:83` | plugin 只有 `list|inspect|reload|enable|disable|trust|untrust` |
| TUI | `src/tui/interactive/extension-workflow.ts`、`src/tui/components/extension-toggle-modal.ts` | `t` 切换 trust,只读列表 |
| Trust | `src/extensions/trust/{trust-store,digest,types}.ts` | exact identity+canonicalPath+binding digest receipt、revocation、损坏文件 fail-closed 到 untrusted |
| 契约文档 | `docs/subsystems/extensions.md:17-21` | 明写 “`PluginManager` 不加载可执行 plugin code,也不允许 plugin 注册任意 runtime tool、context source 或 cleanup callback” |

结论:**RunLedger 已有“声明式扩展包的发现与治理”,完全没有“可执行扩展运行时”,也完全没有“分发/安装”**。全仓检索 `marketplace|plugin install|plugin link|installed_plugins` 只命中两处非本意使用:Claude 注册表的**只读** skill 解析(`src/extensions/skills/providers/claude-plugins.ts`)与文档中的历史非目标声明。

### 1.2 缺口清单(以 omp 能力为口径)

图例:**(a)** 完全缺失 · **(b)** 有类型/槽位但未接线 · **(c)** 有但语义分歧。

| # | omp 能力 | 位置(omp) | RunLedger |
|---|---|---|---|
| 1 | 进程内 TS/JS 扩展模块加载(工厂函数 + `?mtime` cache-bust + `onLoad` 图重写) | `extensions/loader.ts:382,451`、`plugins/legacy-pi-compat.ts:2794-2812` | **(a)** 且被 `01` §13 显式排除 |
| 2 | `ExtensionAPI` 注册面(工具/命令/快捷键/flag/renderer/provider/file-fallback) | `extensions/types.ts:1220-1548` | **(a)** |
| 3 | 动作面(`sendMessage`/`sendUserMessage`/`appendEntry`/`exec`/`setActiveTools`/`setModel`/thinking/service-tier/session name) | `extensions/types.ts:1440-1495` | **(a)** |
| 4 | ~40 事件 catalog(含 `before_provider_request` 替换、`tool_call` block/rewrite、`session_before_*` cancel、`resources_discover`) | `extensions/types.ts:1076-1114` | **(a)**;现有只有 5 类 hook 事件(`src/extensions/hooks/types.ts:7-13`) |
| 5 | 工具调用拦截包装(`tool_call`/`tool_result`,approval 按重写后输入重解析) | `extensions/wrapper.ts:159-417` | **(c)** 有 PreToolUse hook + `updatedInput` 强制重新授权,但无扩展级工具包装 |
| 6 | Handler 隔离:顺序派发、单 handler 超时(30s / shutdown 2s / tool_call 可配)、错误经 `onError` 上报且不影响其它 handler | `extensions/runner.ts:86,110,1262-1408` | **(b)** hook pipeline 有 failure mode/timeout/abort,但无扩展 handler 概念 |
| 7 | 进程内无隔离导致的进程级致命性(裸 timer 抛错 → `uncaughtException` → 整个 session 被拆) | `extensions/managed-timers.ts:1-25`、omp docs 限制 #2 | **(a)**(RunLedger 无此风险,因为无扩展运行时) |
| 8 | Plugin 分发:`PluginManager.install/uninstall/link/doctor/features/config`(bun install、git spec、feature 括号语法、lockfile、rollback) | `plugins/manager.ts:439,654,771,932`、`plugins/parser.ts:36-58` | **(a)** |
| 9 | Marketplace catalog/registry/cache/source resolver | `plugins/marketplace/{manager,fetcher,cache,registry,source-resolver}.ts` | **(a)**;`01` §8 M7 列为后置 |
| 10 | Claude 兼容磁盘契约:`installed_plugins.json`(登记版本 2)、`marketplaces.json`(登记版本 1)、`.omp-plugin|.claude-plugin/marketplace.json` | `marketplace/types.ts:137-180`、`fetcher.ts:196-200` | **(a)** |
| 11 | 安装后回灌运行时面(node_modules symlink + lockfile)与 project/user scope 遮蔽 | `marketplace/manager.ts:806-847`、`plugins/loader.ts:197-241` | **(a)** |
| 12 | 约定目录 provider(`omp-plugins` 90、`claude-plugins` 70、`agent-plugins` 75) | `discovery/omp-plugins.ts:47`、`claude-plugins.ts:34`、`agent-plugins.ts:42` | **(c)** Skill 侧已有等价 provider 分层(`src/extensions/skills/registry.ts`);Plugin 侧只有单一 manifest 容器 |
| 13 | Marketplace auto-update(`off|notify|auto`) | `plugins/marketplace-auto-update.ts:19-49` | **(a)** |
| 14 | Plugin settings schema + `plugin config get/set/delete/validate` | `plugins/types.ts:56-99`、`cli/plugin-cli.ts:773-955` | **(a)** |
| 15 | Extension 包 sibling 能力目录(skills/hooks/tools/commands/rules/prompts/.mcp.json) | `docs/skills/authoring-extensions.md:98-99` | **(c)** 现有 Plugin 只声明 skills/hooks/mcpServers |
| 16 | Extension UI(`ExtensionUIContext`:selector/widget/editor/composer shape) | `extensions/types.ts:256-371` | **不复刻**(见 D9;TUI 是被动 client) |

### 1.3 RunLedger 必须保留的既有优势

这些是 omp 没有、复刻过程中**不得被稀释**的能力:exact identity+path+digest trust receipt 与 revocation(`src/extensions/trust/trust-store.ts`);digest-only invocation audit(`src/extensions/integration/runtime-audit-adapter.ts`);canonical tool event projection(`.../runtime-events.ts`);recovery-barrier 门禁的扩展 mutation(`extension-composition.ts:256`);required-MCP fail-closed 启动与 owner 释放;hook `updatedInput` 强制重新授权;全面 bounded(扫描/诊断/输出上限,`src/extensions/diagnostics.ts:47-64`)。

## 2. 参考基线:oh-my-pi 的实现

### 2.1 Extensions 运行时(两阶段:LOAD → BIND)

```text
发现路径集合(4 段,按序去重)
   │
   ▼
import 模块(并发) + 运行 factory(顺序)   ← 注册只写内存记录;动作方法抛 ExtensionRuntimeNotInitializedError
   │
   ▼
ExtensionRunner.initialize(actions, contextActions, commandContextActions?, uiContext?, mode)
   │
   ├─ 事件派发给 handlers(顺序、逐 handler 超时、错误隔离)
   ├─ 每次工具执行被 ExtensionToolWrapper 包装(tool_call / tool_result)
   └─ 暴露运行时动作(sendMessage / setActiveTools / setModel / …)
```

- 工厂契约:`type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`(`extensions/types.ts:1623`);模块可 default export 工厂,也可自身是函数(`loader.ts:60-63`)。
- 注册期/运行期分离:所有 `register*`/`on` 写进 `Extension` 记录;所有动作方法在 `initialize` 前抛错(`loader.ts:65-152`)。
- 发现顺序(`loader.ts:648-748`):native `.omp/extensions` 扫描 → hook 工厂(`.ts/.js`)→ 已启用插件的 `omp.extensions`/`pi.extensions` manifest 条目 → 显式配置路径;按 `path.resolve` 去重,首个胜出(`:659-665`)。
- 自动扫描只认 `.ts`/`.js`(`loader.ts:511-513`);manifest 条目接受 `.ts/.js/.mjs/.cjs`(`plugins/loader.ts:246-252`)。
- 事件派发顺序保证:扩展加载顺序 → `pi.on` 注册顺序;**唯一并行事件是 `session_shutdown`**(`runner.ts:1359-1372`)。
- 超时:`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`(`runner.ts:86`)、shutdown `2_000`(`:110`)、`tool_call` 由 settings 覆盖(`:1472-1474`)。
- 重复名优先级:工具/命令/flag 反向扫描 → **最后加载的扩展胜出**(`runner.ts:901-909`);message renderer 首个胜出。
- 工具包装(`wrapper.ts:159-417`):先按原始输入解析 approval(`deny` 在任何扩展事件之前短路)→ `tool_call`(可 block / 可重写 input)→ **按重写后输入重新解析 approval** → 在 scoped 上下文中执行 → `tool_result`(中间件式累积替换 content/details/isError)。
- 热重载:`ctx.reload()` 只是 `switchSession(sessionFile)`,**不重新 import 模块、不重建 runner**(`runner.ts` 相关注释与 omp docs 限制 #18);源码改动只在下一次 import(新进程/子会话)生效。
- 已知缺陷(本计划**不复制**,见 §3.2):进程内无隔离 → 裸 timer 抛错拆整个 session;`setLabel` 两参形式未实现;`resources_discover` 已实现但无生产调用方;`.d.ts` 条目永不解析;`?mtime` cache-bust 在 Windows 无效。

### 2.2 Plugin 分发与 Marketplace

| 关注点 | omp 实现 |
|---|---|
| 用户插件根 | `$XDG_DATA_HOME/omp/plugins`(默认 `~/.omp/plugins`):`package.json` + `node_modules/` + `omp-plugins.lock.json` + `installed_plugins.json` + `cache/{marketplaces,plugins}`(`packages/utils/src/dirs.ts:606-626`、`marketplace/registry.ts:28-39`) |
| 项目 scope | `<anchor>/.omp/plugins/` 同构四件套;anchor = 最近含 `.omp/` 的祖先,否则最近 `.git/`,不含 `$HOME`(`discovery/helpers.ts:1022-1076`) |
| manifest | `package.json#omp`(或 legacy `#pi`),`{name?,version,description?,tools?,hooks?,extensions?,commands?,features?,settings?}`;`version` 总被 package version 覆盖;`omp || pi || {version}`(`plugins/types.ts:30-53`) |
| feature 语义 | `enabledFeatures: null` = 只启用 `default: true`;`[]` = 全关;`[a,b]` = 精确;安装语法 `pkg[a,b]` / `pkg[*]` / `pkg[]`(`plugins/parser.ts:36-58`) |
| lockfile | `{plugins:{name:{version,enabledFeatures,enabled}}, settings:{name:{k:v}}}`;整文件重写、无 version 字段(`plugins/types.ts:127-135`) |
| 安装 | `bun install <spec>`;git spec 支持 `github:`/`gitlab:`/`bitbucket:`/`codeberg:`/`sourcehut:` 简写与完整 URL,`#ref` pin;失败时回滚 `package.json`/`bun.lock`/`node_modules/<name>` 快照(`plugins/manager.ts:439-651`) |
| link | symlink 本地包到 `<plugins>/node_modules/<name>`;**不写 `dependencies`**;**无 cwd containment 校验**(`plugins/manager.ts:771`,`omp docs` 明确登记该缺口) |
| 运行时枚举 | `getEnabledPlugins(cwd)` 记忆化;user 根 + 项目根;每根取 `dependencies` ∪ lockfile `plugins`;要求真实 `package.json` 且有 `omp`/`pi`;全局或项目 disabled 直接丢弃;项目按 name 遮蔽 user(`plugins/loader.ts:197-241,77-193`) |
| catalog | `.omp-plugin/marketplace.json` 优先,`.claude-plugin/marketplace.json` 回退(`marketplace/fetcher.ts:196-200`);`name`+`owner.name`+`plugins[]` 必需,条目 `source` 为 `./path` 或 `{source:"github"|"url"|"git-subdir"|"npm"}` |
| source 解析 | 相对路径必须 `./` 且经 `pathIsWithin` containment;git 系走 clone;`npm` variant **直接抛错未支持**(`marketplace/source-resolver.ts:37-152`) |
| 安装落盘 | 版本解析顺序 catalog `version` → `.claude-plugin/plugin.json` → `plugin.json` → `package.json#version` → `sha[:7]` → `0.0.0`;缓存至 `cache/plugins/<mkt>___<plugin>___<version>`(staging + rename);写 `installed_plugins.json`(登记版本 2);把缓存 symlink 进 scope 的 `node_modules` 并回写 lockfile(`marketplace/manager.ts:241-368,806-847`) |
| 更新 | 无独立 npm 更新动作,靠重装驱动;`omp update -l` 只升级 marketplace 插件;`marketplace.autoUpdate` = `off|notify|auto`,`notify` 只写 debug 日志(`marketplace-auto-update.ts:19-49`) |
| CLI | `omp plugin install|uninstall|list|link|doctor|features|config|enable|disable|marketplace|discover|upgrade`(`cli/plugin-cli.ts:27-34`);`omp install` 把本地路径分流到 `link`、其余到 `install`(`cli/classify-install-target.ts:55-79`、`commands/install.ts:34-88`) |
| 已知缺陷(不复制) | `link` 无 containment;`-l/--local` 解析后无人消费;`installer.ts`/`doctor.ts` 死模块;enable 写 lockfile 缺失时静默跳过;无跨进程锁;marketplace `notify` 模式对用户静默;npm source 解析但拒绝;URL 源不支持相对 source;`.d.ts` 条目永不解析 |

## 3. 逐项复刻对照表

### 3.1 处置语义

- **复刻**:语义与 omp 对齐,实现落在 RunLedger 既有治理框架内。
- **改造**:能力面对齐,承载方式因 RunLedger 的 owner/session/authority 模型而不同。
- **不复刻**:omp 侧缺陷、与 RunLedger 不变边界冲突、或属 omp 专属宿主形态;必须给出替代或显式非目标。

### 3.2 核心交付表

| omp 能力 | 处置 | RunLedger 承载 |
|---|---|---|
| 扩展模块工厂契约(default export 或函数;可 async) | **复刻** | 同一契约;但模块在 **session 私有 extension host 进程**内求值(D1),不在 Session Owner 进程 |
| 注册期/运行期分离(`ExtensionRuntimeNotInitializedError`) | **复刻** | host 进程内同语义:加载期只收集注册,绑定后才接受动作调用 |
| `ExtensionAPI` 注册面:工具/命令/flag/事件 | **复刻** | 工具→`ToolRegistry` 带 provenance 与 approval class(D3);命令→TUI 命令 registry + control command;flag→CLI flag;renderer/快捷键/composer shape **不复刻** |
| 动作面:`sendMessage`/`sendUserMessage`/`appendEntry`/`setActiveTools`/`setModel`/thinking/session name | **改造** | 全部经 Session Owner command protocol + attempt barrier + receipt(D4);`exec` 改经 governed managed process;**service-tier 不复刻** |
| ~40 事件 catalog | **改造** | 定义**扩展事件投影层**:扩展只订阅 RunLedger canonical event 的稳定投影子集(D5);新增事件类型仍走 Runtime 04 |
| `tool_call` block/rewrite + `tool_result` 替换 | **改造** | 复用现有 PreToolUse pipeline 的语义(`updatedInput` 强制重新授权),扩展 handler 只是另一个 handler 来源 |
| 逐 handler 超时/错误隔离/顺序派发 | **复刻** | 同一纪律;新增 per-extension 预算(D14) |
| 裸 timer 致进程级致命 | **不复刻** | host 进程崩溃 = 该 generation failed,D2 保证不影响 session |
| Plugin `install/link/uninstall/upgrade/doctor/features/config` | **改造** | 复刻命令面与语义;fetch/解包经 governed process + network policy,不用 `bun install`、无 lifecycle script(D7) |
| Marketplace catalog/registry/cache/source resolver | **复刻** | 磁盘格式与 Claude 兼容;全部落 canonical `runledgerHome`(D7) |
| 源类型 `./path` / git / github / git-subdir | **复刻** | sha/ref pin 与 containment 校验保留 |
| 源类型 `npm` | **不复刻** | omp 自己也拒绝;显式非目标,给出明确错误 |
| project/user scope 与遮蔽 | **改造** | 保留 user/workspace 两 scope + 遮蔽语义;root 用 RunLedger workspace-key(D6) |
| auto-update `off|notify|auto` | **改造** | `notify` 必须有真实用户可见通道(D10),否则退化为 `off` |
| Extension UI context | **不复刻** | TUI 是被动 client;扩展只能提交可投影的 intent/status(D9) |
| legacy-pi 兼容 shim / 虚拟模块 / SQLite 解析缓存 | **不复刻** | 无 legacy 生态诉求;扩展只 import RunLedger 自身 API 包 |
| `.omp`/`.claude` 声明式目录兼容(技能/命令/规则/MCP) | **复刻(只读)** | Skill 侧已有 provider;本计划补齐 Plugin 侧 sibling 目录只读发现 |

## 4. 固定架构决策

以下决策在 P0 完成后视为契约。改变任一项必须先更新本文件与对应 schema/测试。

### D1 — 扩展代码在 session 私有的 **extension host 子进程**中执行,不在 Session Owner 进程内

omp 把扩展模块 import 进主进程,其代价是文档化的:裸 timer/detached promise 抛错会触发进程级 `uncaughtException`,整个 session 被拆(`extensions/managed-timers.ts:1-25`,omp docs 限制 #2)。RunLedger 的核心不变式是 owner fence、durable receipt 与 fail-closed:任何可与 owner 共享地址空间的可执行扩展都等价于**把 owner 的完整性交出去**。

因此:每个 owned Session 拥有 0..1 个 extension host 进程,由既有 governed managed process 能力创建(与 MCP/hook 同一套 process port),工厂函数在该进程内求值,注册结果序列化回 owner。

- 作者体验保留:工厂仍可同步、注册仍同步;只有动作与事件回执是异步 RPC。
- 崩溃语义:host 退出 ⇒ 该 generation `failed`、扩展整体撤出、session 继续(与 omp 相反,见 D2)。
- 代价:跨进程调用延迟、handler 内无法直接触达 owner 内存对象、需要协议版本化。
- 与 `01` §13 的关系:该项是 §0.1 说明的边界变更,由 §12 Q1 裁定。

### D2 — Extension host 崩溃不得影响 Session 存活

host 退出、协议违规、超预算:标记当前 extension generation `failed`,回退 last-known-good snapshot,写 canonical audit;**新 turn 不再装配扩展**,已完成的 turn 与 session 事实不变。禁止任何形式的“主进程内 fallback 执行”。

### D3 — 扩展注册的工具与声明式资源一律经既有 admission 路径

扩展工具不进入“第二套工具表”。注册时必须提供:tool name(runtime name 需 sanitize 且全局唯一)、参数 schema、approval class、声明 capability;owner 将其投影为 `AgentTool` 并带 provenance `extension:<pluginId>@<version>#<digest>`。每次执行仍走 `ToolRegistry` → authorization → attempt barrier → ExecutionGateway。声明式贡献(skills/hooks/mcp)继续走既有 Plugin/Skill/Hook/MCP 四层。

### D4 — 所有扩展副作用都是 owner-fenced、可审计的 mutation

`sendMessage`/`setActiveTools`/`setModel`/plugin enable 等统一为 Session protocol 上的 `mutate` 操作,带 command ID、expected revision、request digest 与 durable receipt;response-loss 语义沿用 `01` §10(同 ID 重放 receipt、异体 conflict、只有 intent 时 `uncertain_outcome`)。**扩展不得直接写 SQLite、settings 或 trust 文件。**

### D5 — 扩展事件是 canonical event 的**投影**,不是第二事实源

定义 `ExtensionEventProjection`:由 Runtime 04 的 canonical event 投影到稳定、有界的扩展事件命名空间。约束:

- 扩展 handler 的可见载荷按事件白名单裁剪,secret/凭据/完整大输出不进入扩展载荷。
- 有返回值的“中间件”事件(`tool_call`、`tool_result`、`context`、`before_provider_request`、`session_stop`、`session_before_*`)在 owner 侧合成,结果必须再次通过既有 canonicalize/authorize;`before_provider_request` 的替换体有硬大小上限并禁止注入未声明字段。
- 新增 canonical 事件类型仍由 Runtime 04 拥有;扩展层不得自行扩 catalog。

### D6 — Scope 与 authority 沿用 RunLedger 的 workspace 模型

扩展包根、enable/trust 状态、marketplace registry 全部以 canonical home + workspace-key 组织,与 `createProductionSessionExtensionComposition` 现有做法一致(`extension-composition.ts:361-393,633`);不引入 omp 的项目内 `.omp/` anchor 解析。**不恢复项目 `.runledger/`。**

### D7 — 分发只用受治理的 fetch/解包,不用包管理器

- source 只有:本地目录、git(含 github 简写、git-subdir)、catalog URL;`npm` variant 显式不支持。
- clone/fetch 经 governed managed process 与 network policy(默认 deny;真实网络需显式 `--network allow` 等价授权);**不执行任何 install script、不运行 `bun install`/`npm install`**。
- 先落 staging 目录,校验 containment/大小/条目数上限,记录 digest,再原子 rename 激活。
- 安装、启用、信任三者严格分离:安装只落盘 + 记 digest;首次启用必须显式 trust(与 `01` §4.3 一致)。

### D8 — 升级/变更使旧 receipt stale

catalog/命令/资产/capability 任一 digest 变化 ⇒ 旧 trust receipt 变 stale,新 generation 在重新批准前不得启动 extension host。回滚到上一已验证版本是一个显式 command,不自动发生。

### D9 — 无 Extension UI context;扩展通过 intent 影响呈现

TUI 是 passive client(`docs/subsystems/extensions.md` 稳定边界)。扩展不得注册 renderer/组件/composer shape,也不得直接调用 `ui.*`。替代:`ExtensionIntent`(状态行文本、通知、需用户决策的 prompt)作为 Session protocol 的 read/mutate 投影,由 TUI 按现有 presentation 契约渲染;需要用户输入时走既有审批 UI,而不是扩展自定义对话框。

### D10 — 自动化必须有用户可见出口

marketplace `autoUpdate` 的 `notify` 模式必须产生真实可见信号(TUI 通知 + CLI 可查询的 pending update 列表);无法保证可见时该模式**降级为 `off`**,不允许“配置项说谎”。

### D11 — 热重载 = 新 generation 的 host 进程

`extension.reload`(已有 mutation)在 idle 边界执行:停旧 host → 校验 digest/trust → 起新 host → 交换注册表。运行中的 turn 继续使用旧 generation 直到 `endTurn`。不移植 `?mtime`/`onLoad` 图重写;进程重启天然获得新代码。文件 watcher 只在 P7 可选项内,且仍遵守 idle 原子交换。

### D12 — 扩展 API 包是 RunLedger 自有契约

扩展 import 的 API 面(`runledger/extensions` 或等价子路径)由 RunLedger 发布与版本化。**不实现** `@oh-my-pi/*` / legacy `pi` specifier 兼容;扩展 manifest 用 RunLedger 自有键(建议 `package.json#runledger.extensions`),omp `#omp`/`#pi` manifest 只作为**只读声明式导入**(skills/hooks/mcp 路径),不触发可执行加载。

### D13 — 配置面只收窄、不新增旁路 authority

新增 settings 键只在 user 层授权、workspace 层只能收窄(沿用 `src/extensions/skills/policy.ts` 的 master/narrow 语义);运行态仍在 `extensions-state.json` 与 `trust.json`。不新增 env var;不把扩展 enable/trust 塞进 settings。

### D14 — 全面 bounded

每个扩展 host:注册项数量上限、事件载荷上限、handler 超时(默认沿用 30s / shutdown 2s / tool_call 可配)、输出上限、并发 handler 上限、进程内存与生命周期预算。超限按 effective failure mode 处理并产生 diagnostic,不静默截断。

### D15 — Profile 门控不变

扩展运行时只在 `extensions.{tools,context,hooks,lifecycle}` 为真的 Profile 下装配;`minimal@1`/`minimal@2`/`plan@1` 继续全关。扩展**不能**在会话内自行放开 Profile 门控。

## 5. 目标数据流与契约草案

### 5.1 会话内数据流

```text
canonical runledgerHome / workspace-key
  ├─ extensions/state/extensions-state.json   enable 状态
  ├─ extensions/state/trust.json              exact identity+path+digest receipt
  ├─ plugins/{user,workspaces/<key>}/packages 已安装扩展包(staging → 原子激活)
  ├─ plugins/registry.json                    RunLedger 自有安装注册表(登记版本 1)
  ├─ marketplaces.json                        catalog 注册表(登记版本 1,Claude 兼容字段)
  └─ cache/{marketplaces,plugins}/            只读缓存

Session Owner(每 owned Session)
  ├─ ExtensionManager            发现/合并/enable/trust/snapshot
  ├─ ExtensionHostSupervisor     启停 extension host、协议校验、崩溃恢复
  ├─ ExtensionRegistrySnapshot   不可变:工具/命令/flag/事件订阅/host generation
  ├─ ExtensionEventBridge        canonical event → 投影 → host → 结果合成
  └─ 既有 Hook/MCP/Skill/Plugin 四层(不清空、不重写)
```

### 5.2 计划合同草案(P0 冻结)

| 契约 | 形状(摘要) | 归属 |
|---|---|---|
| `ExtensionPackageManifest` | `{ name, version, description, capabilities[], extensions[], commands[], skills[], hooks[], mcpServers?, settings? }`;未知字段 error(沿用现有严格性) | `src/contracts/` + `src/extensions/plugins/manager.ts` |
| `ExtensionCapability` | `events[]`、`tools[]`、`filesystem: none|read|write`、`process: false|governed`、`network: false|governed` | 同上 |
| `ExtensionHostProtocol` 协议版本 1 | 双向 JSONL/结构化 RPC:`hello`、`registry`、`event`、`action`、`result`、`error`、`shutdown`;每帧有 `protocolVersion` + `generation` | Runtime 04 contracts |
| `ExtensionRegistrySnapshot` | `{ generation, hostPid, packageId, digest, tools[], commands[], flags[], subscriptions[], limits }` | `src/extensions/` |
| `ExtensionEventProjection` | `{ name, payload(裁剪后), cancelable, resultKind }` | Runtime 04 event catalog 增量 |
| `MarketplaceCatalog` / `MarketplacesRegistry` / `InstalledPluginsRegistry` | 与 Claude 兼容字段(`version:1` / `version:2`),额外字段前缀 `runledger` | `src/extensions/plugins/marketplace/` |
| `ExtensionIntent` | `{ kind: "status"|"notify"|"decision-request", payload(有界) }` | Session protocol |

## 6. 文件与所有权规划

### 6.1 新增

| 路径 | 内容 |
|---|---|
| `src/extensions/host/supervisor.ts` | ExtensionHostSupervisor:启停、协议握手、generation、崩溃恢复、预算 |
| `src/extensions/host/protocol.ts` | host 协议帧编解码、版本校验、载荷上限 |
| `src/extensions/host/client.ts` | owner 侧请求/回执、超时、abort 传播 |
| `src/extensions/host/runtime-api.ts` | 扩展侧 `ExtensionAPI` 实现(注册记录 + 动作 RPC 桩) |
| `src/extensions/host/registration.ts` | 注册表序列化/校验/去重/上限 |
| `src/extensions/events/projection.ts` | canonical event → `ExtensionEventProjection` |
| `src/extensions/events/bridge.ts` | 派发、结果合成、重新授权 |
| `src/extensions/tools/admission.ts` | 扩展工具 → `AgentTool` 准入(provenance/approval/limits) |
| `src/extensions/plugins/marketplace/{manager,registry,cache,fetcher,source-resolver,types}.ts` | 复刻 omp 的 catalog/registry/cache/resolver,受治理 fetch |
| `src/extensions/plugins/installer.ts` | staging/校验/原子激活/卸载/回滚(与 omp `installer.ts` 无关,自研) |
| `src/extensions/plugins/settings-schema.ts` | plugin settings 校验(`validateSetting`/`parseSettingValue` 等价物) |
| `src/extensions/plugins/doctor.ts` | doctor 检查项 |
| `src/contracts/extensions/*` | 上述契约的 schema 与 consumer 测试入口 |
| `tests/extensions/host/**`、`tests/extensions/marketplace/**`、`tests/runtime/session-runtime/extension-host-domain.test.ts` | 见 §10 |

### 6.2 修改

| 路径 | 改动 |
|---|---|
| `src/extensions/plugins/manager.ts` | manifest 扩展(capabilities/extensions/commands/settings),保持未知字段 error |
| `src/extensions/manager.ts` / `snapshot.ts` | registry generation 与 host generation 绑定;失败回退 last-known-good |
| `src/runtime/session-runtime/extension-composition.ts` | 装配 supervisor/bridge/admission;operation manifest 增量 |
| `src/runtime/harness-profiles/types.ts` | 不新增字段;确认扩展运行时映射到既有 `extensions.*` 门控 |
| `src/cli/control-commands.ts` | plugin 动作扩展(install/uninstall/link/upgrade/doctor/features/config/marketplace/discover) |
| `src/cli/{args,main}.ts` | 新子命令与 source 解析;`--network` 等价授权衔接 |
| `src/tui/interactive/extension-workflow.ts` + modal | 安装/升级/配置/信任的确认边界 |
| `src/storage/settings-manager.ts` | 新增 extensions 相关 settings 键(user 授权、workspace 收窄) |
| `src/contracts/index.ts` | 导出扩展契约 |
| `docs/subsystems/extensions.md`、`docs/cli.md` | 行为与命令面同步 |
| `development-doc/plugin-mcp-skill-hooks/01-implementation-plan.md` | §13 非目标与 M7 条目按本计划修订 |
| `development-doc/00-index.md` | 模块导航增加本文档 |

### 6.3 串行窗口

`src/runtime/session-runtime/**`、`src/runtime/protocol/**`、`src/contracts/**`、`package.json`/`package-lock.json`、`src/cli/main.ts` 与其他专项共用。修改前记录前置 contract/实现 commit,按路径串行提交,不长期并行改写同一 composition root。

## 7. 分阶段实施

### P0 — 契约冻结与裁定(无行为变化)——**已完成**

- RED:契约 consumer 测试失败(`ExtensionHostProtocol`/`ExtensionPackageManifest`/`ExtensionEventProjection` 尚不存在)。
- DoD:`src/contracts/extensions/**` 落地 schema 与 export;Runtime 04 的 event catalog 增量已登记;§12 Q1–Q4 完成裁定并回写本文件;`01` §13/M7 同步。
- 交付物:`src/contracts/extensions/{common,manifest,events,registry,host-protocol,intent,marketplace,index}.ts`;`src/runtime/protocol/events.ts` 新增 12 个 canonical event 与对应 payload requirement;`tests/runtime-contracts/extensions-contracts.test.ts`;`src/contracts/index.ts` 导出。
- 行为影响:无。本阶段不装配 supervisor、不改 operation manifest、不改 Profile 门控。
- 顺带修复的既有缺陷(单独说明):本文件初版引入的内部 generational 措辞(`v` + 数字)触发 `npm run check:current-format` 的 internal generation marker 检查;P0 改写为“登记版本 N / 协议版本 1”。

### P1 — Extension host 进程与协议骨架

- RED:构造一个 factory 抛错的扩展包,断言 **session 存活**、generation `failed`、audit 有记录;再构造一个裸 `setInterval` 抛错扩展,断言同样不影响 session(与 omp 相反的行为必须被测试固定)。
- DoD:supervisor 能起停 host、握手校验、序列化空注册表、超时与崩溃恢复;endTurn/idle 交换语义与既有 snapshot 一致;进程由 governed managed process 创建并可断言已回收。

### P2 — 注册面与工具准入

- RED:扩展注册同名工具(与 stdlib 冲突、与另一扩展冲突)与非法 runtime name;断言准入拒绝或确定性遮蔽,并在 manifest 未声明 `tools` capability 时拒绝。
- DoD:工具/命令/flag 注册经 `ToolRegistry` 准入并带 provenance;`setActiveTools` 语义由 owner 决定;`ExtensionRegistrySnapshot` 可投影到协议查询。

### P3 — 事件桥

- RED:顺序/超时/abort 三个 handler 组合用例;`tool_call` block 与 input 重写后**必须重新授权**;载荷超限与未声明订阅被拒绝。
- DoD:投影层覆盖 P3 定义的事件子集;`session_shutdown` 并行 + 短预算;handler 异常只产生 diagnostic。

### P4 — 运行时动作

- RED:动作在绑定前调用被拒绝;`setModel` 无凭据时返回失败而非改变状态;response-loss 重放不产生重复副作用。
- DoD:全部动作经 Session protocol + attempt barrier + receipt;扩展无法直接写 store/settings/trust。

### P5 — 分发:安装、scope、激活

- RED:安装含 install script 的包必须失败;`./` 逃逸与超限包必须失败;切换 enable 而 trust 缺失时 host 不得启动;digest 变化后旧 receipt 变 stale。
- DoD:`plugin install|uninstall|link|upgrade|doctor|features|config` 可用;staging→digest→原子激活;user/workspace scope 与遮蔽;`marketplaces.json`/install registry 磁盘契约与 Claude 兼容字段一致。

### P6 — CLI/TUI 与 Marketplace

- RED:`--json` 输出与退出码用例;`notify` 模式必须产生可见信号(D10)。
- DoD:`marketplace add|remove|update|list`、`discover`、`upgrade`、`autoUpdate` 接线;TUI 安装/升级/信任确认边界;运行中 mutation 的 pending 语义与 `01` §10 一致。

### P7 — 加固与真实 smoke

- DoD:预算与上限全覆盖;失败语义矩阵逐条有测试;真实 `runledger` + 隔离 `RUNLEDGER_DIR` + 真实 TTY 的安装→信任→启用→调用→禁用→卸载闭环;可选文件 watcher(仍遵守 idle 原子交换);`docs/subsystems/extensions.md`/`docs/cli.md` 同步。

## 8. 事件与契约增量

- **canonical event**:新增 `extension.host.started|failed|stopped`、`extension.registry.activated`、`extension.action.committed|rejected`、`plugin.installed|uninstalled|upgraded`、`marketplace.added|removed|updated`(命名与 payload 以 Runtime 04 最终裁定为准)。
- **扩展可见事件投影**:只暴露白名单子集;`tool_call`/`tool_result`/`context`/`before_provider_request`/`session_stop`/`session_before_*` 的结果必须经 owner 合成与重新授权。
- **operation manifest 增量**:`extension.host.inspect`(read)、`plugin.install|uninstall|link|upgrade`(mutate)、`plugin.config.read|write`(read/mutate)、`marketplace.add|remove|update|discover|upgrade`。
- 所有 mutate 必须带 command ID、expected revision、request digest 与 durable receipt。

## 9. 冻结物与门禁

冻结(变更需先改本文件):D1–D15、§5.2 契约表、§8 事件与 operation 增量、§13 非目标。

每个代码 PR:

```bash
npm run check
npm test            # 或按 test:fast/test:runtime/test:integration 分桶
npm run build       # 进入 dist/ 的改动
git diff --check
```

进入 `dist/` 的改动另需真实 `runledger` 验证(`bin/runledger.js` 加载 `dist/cli/cli.js`,不直接运行 `src`):先 `npm run build`,再用 `command -v runledger`、`readlink -f`、`npm ls -g --depth=0` 确认入口,使用新建绝对路径临时目录作为 `RUNLEDGER_DIR`,通过真实 TTY 或独立命名 tmux 会话验证。

## 10. 验证矩阵

### 10.1 单元/契约

- manifest:合法/非法/未知字段/路径逃逸/超限/name 与 semver 边界;
- 协议:版本不匹配、帧超限、重复帧、乱序、半包、非法 JSON;
- registry:重复 identity、runtime name 冲突、上限截断、确定性排序与 digest 稳定;
- 投影:白名单裁剪、secret 不出现在扩展载荷、超限拒绝;
- 分发:source 解析(相对/git/github/git-subdir/URL/npm 拒绝)、containment、staging 清理、digest 计算稳定、registry 原子写;
- trust:install/upgrade 后 stale、revocation、损坏文件 fail-closed。

### 10.2 运行时集成

- host 生命周期:启动/握手/正常停止/崩溃恢复/超预算/owner fence 丢失;
- 事件:顺序与并行语义、handler 超时、abort 传播、`tool_call` block 与重写后重新授权、`tool_result` 中间件累积;
- 动作:全部经 barrier 与 receipt;response-loss 重放;扩展越权写 store/settings 必须失败;
- snapshot:运行中 reload 排队、turn 间切换、失败保留 last-known-good;
- 分发闭环:安装(untrusted,无 host 启动)→ trust → enable → 工具可调用 → disable → 卸载后无残留进程/文件;
- session resume:只恢复消息,不重放历史扩展副作用。

### 10.3 CLI/TUI

- 新子命令 human/JSON 输出与退出码;`--network` 缺失时网络 source 明确失败;
- TUI 安装/升级/信任/配置的确认边界与运行中禁用行为;
- `notify` 模式的可见信号;
- PTY snapshot 覆盖新增用户可见文本。

### 10.4 证据类别

自动化 ≠ built CLI ≠ 真实 TTY ≠ human/visual ≠ 跨平台。Linux/mock/PTY/tmux 捕获通过不等于 human-verified 或 cross-platform verified;每类证据在 §15 分列,不得互相顶替。

## 11. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| D1 裁定不通过(要求进程内) | 计划回退到 omp 语义,进程级致命性被引入 | §12 Q1 先裁定;若选进程内,必须同时接受 omp docs 限制 #2 并写入 `01` §10 失败语义 |
| 协议面过早膨胀 | 维护成本与攻击面双增 | P0 冻结协议版本 1 最小帧集;新增事件走 Runtime 04 |
| 扩展工具与 stdlib 命名冲突 | 静默遮蔽 | 准入期强制 runtime name 唯一 + provenance;冲突即拒绝,不自动改名 |
| 分发引入网络与归档解析 | SSRF/zip-slip/资源耗尽 | 只允许受治理 fetch;staging + containment + 大小/条目上限;不支持 npm 与 install script |
| trust 与 enable 混淆 | 未审计代码被执行 | 安装不授予执行;host 启动前必须 trusted(沿用现有四层分离) |
| 既有声明式面被重写 | 回归 | §1.3 优势清单作为回归测试的固定断言 |
| 与 `01` 状态口径分裂 | 文档失真 | 本文件只做子专题证据;总状态回写 `01` |

回滚:每阶段独立 PR;P1 起新增能力由 Profile 门控与 settings 开关控制,关闭后回到当前声明式行为,不涉及数据迁移。已安装包与 registry 可在卸载路径清空;trust/state 文件保持向后兼容读取(未知键 passthrough)。

## 12. 裁定结果(P0 已收口)

下表在 P0 完成时裁定并冻结。选项按原提案记录,裁定理由与后续约束一并写明;改变任一项必须先更新本文件与对应 schema/测试。

| # | 问题 | 选项 | 裁定 | 理由与约束 |
|---|---|---|---|---|
| Q1 | 扩展执行宿主 | (A) 子进程 host(**推荐**,D1) / (B) 进程内 import(omp 语义,性能好但进程级致命) / (C) 两者都做 | **(A)** | 进程内 import 等价于把 owner 完整性交出去,与 owner fence / durable receipt / fail-closed 三项核心不变式冲突;D2 的“host 崩溃不影响 session”只有子进程能成立。代价(跨进程延迟、协议版本化、handler 内不能直接触达 owner 内存对象)在 D1/§5.2 已计入 P1 工作量。`01` §13 的“任意 JavaScript/TypeScript 进程内 plugin entrypoint”仍是非目标——本计划不放开进程内执行,而是以 host 子进程承载。 |
| Q2 | 扩展 API 的对外形态 | (A) 独立发布 `runledger/extensions` 子路径 / (B) 仅进程内契约、不对外承诺 | **(A)** | 扩展作者需要稳定 specifier 与版本;D12 已要求 API 面由 RunLedger 发布与版本化。落地方式:`package.json#exports` 增加 `./extensions` 子路径,指向 `dist/contracts/extensions/**` 的扩展作者面;**不**兼容 `@oh-my-pi/*` 或 legacy `pi` specifier。该子路径在 P2 实现注册面时发布,本节只冻结方向。 |
| Q3 | 分发是否纳入本次范围 | (A) 全量(安装+marketplace) / (B) 只做本地 link 与 git 安装,marketplace 后置 | **(A)** | 用户明确要求实施本计划全文,P5/P6 包含 marketplace;拆分会把 D10(auto-update 可见出口)与 Claude 兼容磁盘契约留成无验收状态。仍按阶段独立 PR 推进,P5 不依赖 P6 才能验收。 |
| Q4 | 事件投影粒度 | (A) 白名单子集(~12 个) / (B) 对齐 omp 全量 ~40 | **(A)** | 事件面扩张同时增加维护成本与攻击面(§11)。白名单 12 项在 `src/contracts/extensions/events.ts` 冻结,覆盖现有 5 类 hook 生命周期与 4 个扩展中间件需求;新增事件仍走 Runtime 04。 |

裁定带来的派生事实:

- `01` §13 的两条显式非目标(“任意 JS/TS 进程内 plugin entrypoint”与“marketplace、Git clone/update、签名分发和自动升级”)按本节修订:进程内 entrypoint 仍是**未放开**的非目标(改由 host 子进程承载);marketplace 与受治理 clone/update 转入本计划范围,签名分发与 publisher trust root 仍是非目标(§13)。
- `01` M7 的 plugin 版本化 store / install / update / uninstall / rollback / marketplace 条目不再作为“第二阶段后置”,改由本计划 P5–P6 交付;M7 保留的两条(签名与 publisher trust root、staged bounded probe 中的最小权限沙箱)按根 `AGENTS.md` 的 sandbox 边界**不实施**。
- §8 的事件增量已登记进 Runtime 04 的 canonical event catalog;扩展层不得自行扩 catalog。

## 13. 非目标

- OS sandbox、namespace、进程隔离新增或重构;扩展运行时的隔离强度以现有 governed process 为上限。
- 任意 npm 包安装、install script 执行、Node dependency 注入。
- `@oh-my-pi/*` / legacy `pi` specifier 兼容、虚拟模块、legacy 图重写与解析缓存。
- Extension UI:自定义组件、renderer、composer shape、widget、编辑器接管(见 D9)。
- 服务层级(service tier)控制、provider 动态模型注册。
- 扩展定义的 agent/child 委派、LSP server 由扩展注入、browser/apps 扩展。
- 文件系统 watcher 自动热重载(仅在 P7 可选,且不得绕过 idle 原子交换)。
- 远程 registry、签名分发、publisher trust root(可在本计划之后独立立项)。
- 用扩展 trust 替代逐工具授权;用扩展事件替代 canonical event。
- 恢复项目 `.runledger/`、旧 `~/.runledger/agent/` 或任意 session 路径 authority。
- 修改 Profile 门控语义以让扩展在 minimal/plan 会话生效。

## 14. 参考文件

### RunLedger 当前接入点

- `src/extensions/plugins/manager.ts`、`src/extensions/manager.ts`、`src/extensions/snapshot.ts`、`src/extensions/trust/**`、`src/extensions/hooks/**`、`src/extensions/mcp/**`、`src/extensions/skills/**`
- `src/runtime/session-runtime/extension-composition.ts`、`src/runtime/harness-profiles/{types,builtins}.ts`、`src/runtime/protocol/**`、`src/runtime/contracts/**`
- `src/security/**`(authorization/ExecutionGateway/attempt barrier)、`src/storage/{runledger-home,settings-manager}.ts`
- `src/cli/{control-commands,args,main}.ts`、`src/tui/interactive/extension-workflow.ts`、`src/tui/components/extension-toggle-modal.ts`
- `docs/subsystems/extensions.md`、`docs/cli.md`、`development-doc/{00-index.md,plugin-mcp-skill-hooks/01-implementation-plan.md,plugin-mcp-skill-hooks/02-skill-registry-discovery-provider-refactor-plan.md,runtime/04-governed-agent-harness-runtime-plan.md,runtime/06-session-owner-runtime-replacement-plan.md}`

### oh-my-pi(只读参考,`3b3a6dc9bb`,工作树干净)

- Extensions 运行时:`src/extensibility/extensions/{types,loader,runner,wrapper,managed-timers,index}.ts`、`src/extensibility/plugins/legacy-pi-compat.ts`、`src/sdk.ts`、`src/modes/{runtime-init.ts,controllers/extension-ui-controller.ts}`
- 插件与分发:`src/extensibility/plugins/{manager,loader,types,parser,git-url,marketplace-auto-update}.ts`、`src/extensibility/plugins/marketplace/*.ts`
- CLI:`src/cli-commands.ts`、`src/commands/{plugin,install,update}.ts`、`src/cli/{plugin-cli,classify-install-target}.ts`
- Discovery:`src/discovery/{omp-plugins,claude-plugins,agent-plugins,plugin-dir-roots,omp-extension-roots}.ts`、`packages/utils/src/dirs.ts`
- 文档:`docs/extensions.md`、`docs/extension-loading.md`、`docs/marketplace.md`、`docs/plugin-manager-installer-plumbing.md`、`docs/skills/authoring-{extensions,marketplaces}.md`

## 15. 状态表与实施记录

### 15.1 状态表

| 阶段 | 状态 | 证据 |
|---|---|---|
| P0 契约冻结与裁定 | **done** | `src/contracts/extensions/**`(8 文件);`src/runtime/protocol/events.ts` 12 个新事件;`tests/runtime-contracts/extensions-contracts.test.ts`(23 用例);§12 Q1–Q4 裁定;`01` §13/M7 同步;`npm run check` 与 `npm test` 见 §15.2 |
| P1 host 进程与协议骨架 | planned | — |
| P2 注册面与工具准入 | planned | — |
| P3 事件桥 | planned | — |
| P4 运行时动作 | planned | — |
| P5 分发:安装/scope/激活 | planned | — |
| P6 CLI/TUI 与 Marketplace | planned | — |
| P7 加固与真实 smoke | planned | — |

### 15.2 实施记录

- 2026-09-17 初版:依据三路只读侦察建立基线、逐项对照表、D1–D15、P0–P7 与验收口径;未实现任何代码,未提交。
- 2026-09-17 P0 收口:契约落 `src/contracts/extensions/**`;canonical event catalog 增量落 `src/runtime/protocol/events.ts`(并把 runtime `eventAction` 改为取最后一段,与类型层推断一致);新增 12 项事件投影白名单;marketplace/Claude 兼容磁盘契约成形。验证:`npx vitest run tests/runtime-contracts/extensions-contracts.test.ts` 23 passed;`npm run check:current-format`、`npm run check:runtime-boundaries`、`npx tsc --noEmit -p tsconfig.json` 通过。行为影响为零:未装配 supervisor、未改 operation manifest、未改 Profile 门控。
