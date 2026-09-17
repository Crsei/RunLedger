# oh-my-pi 工具注册与呈现机制

> 基线日期：2026-09-18（调查时点）。
> 上游快照：`oh-my-pi` `1c0303b1f2ec515cbf4b44a9a49d68a029531aac`，`packages/coding-agent` 版本 `18.2.4`。
> 目标快照：RunLedger 工作树，分支 `rollback/before-composer-shape`，HEAD `0b2c501b194e0a65d80741dfe650814ea9de42dc`。
> 本文是**机制说明事实记录**，不是实施计划，也不改变任何模块的 authority。

本文回答一个问题：**oh-my-pi 有 100+ 个工具定义，它如何注册、发现、以及在不炸 context 的前提下呈现给模型。**

本文是 [00](00-oh-my-pi-coding-agent-module-gap-report.md) 与 [01](01-oh-my-pi-monorepo-package-and-crate-gap-report.md) 的机制补充：那两份说「缺什么」，本文说「上游是怎么拼起来的」。涉及的模块在 00 中的编号：`tools/`（§4）、`capability/`（§4）、`discovery/`（§4）、`extensibility/`（§4）、`mcp/`（§4）、`xdev`（00 §3 #27 内部 URL 的一部分）。

---

## 0. 口径与引用约定

- 上游路径相对 `oh-my-pi/packages/coding-agent/src/`，写作 `src/<module>/<file>`；跨包引用写全 `packages/<pkg>/src/<file>`。
- 本文所有文件路径与行号**均经实际读取或 grep 验证**；第 1 轮出现过编造子路径与拼错目录的教训，凡本节出现的路径都可按 §9 复现。
- 行号会随上游前进而漂移；引用时以函数名 / 常量名 / 字符串字面量为主要锚点，行号仅作辅助。

## 1. 结论：三层彻底分离

「工具多」不构成 context 压力的原因不是有个聪明的大注册表，而是**发现、注册、呈现被拆成三层，各有独立的数据结构与生命周期**：

```text
磁盘/远程                                    每 session 一次                 每请求
─────────                                   ─────────────                 ────────
~/.omp, .omp/          ┐
~/.claude, .cursor/    │  capability registry  ┌──────────────┐          ┌──────────────────┐
plugins/node_modules   ├─►14 种 kind, 优先级   │ toolRegistry │─────────►│ essential 12 个   │
MCP servers (远程)     │  排序 + 去重          │ Map<name,    │          │ → 顶层 schema     │
hooks / rules / skills │                       │   Tool>      │          ├──────────────────┤
context files          ┘                       └──────────────┘          │ discoverable     │
                                                     ▲                   │ → 卸载到 xd://    │
                                                     │                   ├──────────────────┤
                          createTools() 唯一调用点 ────┘                   │ code mode: 8 个   │
                          sdk.ts:2017                                    │ 直连 + eval 桥    │
                                                                         └──────────────────┘
```

| 层 | 位置 | 性质 | 生命周期 |
|---|---|---|---|
| **发现层** | `src/capability/` + `src/discovery/` | 声明式 inventory（「在哪能找到东西」） | 每次 `loadCapability` 重跑；仅缓存原始 FS 读取 |
| **注册层** | `src/tools/index.ts` + `session.toolRegistry` | session 级实例化（「这个 session 能调什么」） | **每 session 一次**，`sdk.ts:2017` 唯一入口 |
| **呈现层** | `loadMode` / `xd://` / Code Mode / prompt 投影 | 每请求 schema 预算（「这次请求发什么」） | 只在显式事件上变更 |

三层的解耦程度是本文最值得记的一点：**注册 ≠ 呈现**。一个工具可以被注册、可被调用，却不出现在任何一次请求的顶层 schema 里。

---

## 2. 发现层：capability registry

### 2.1 API 只有两个动词 + 一个执行原语

`src/capability/index.ts`：

```ts
// index.ts:67
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) throw new Error(`Capability "${def.id}" is already defined`);
	…
}

// index.ts:79
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	…
	// Insert in priority order (highest first)
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) providers.push(provider); else providers.splice(idx, 0, provider);
}

// index.ts:297
export async function loadCapability<T>(capabilityId: string, options: LoadOptions<T> = {}): Promise<CapabilityResult<T>>
```

注册表是**模块级全局状态**（`index.ts:30-51`）：`capabilities: Map`、`providerCapabilities: Map<providerId, Set<capabilityId>>`、`providerMeta`、`disabledProviders: Set`、`enabledProviders: Set`。

### 2.2 Provider 的形状

`src/capability/types.ts:75`：

```ts
interface Provider<T> {
  id: string;                 // "claude"、"native"、"mcp-json"、"agents-md"
  displayName: string;        // UI
  description: string;        // UI
  priority: number;           // 越大越优先（已按此排序存进 Capability.providers）
  load(ctx: LoadContext): Promise<LoadResult<T>>;
}
```

`priority` 的档位约定（`types.ts:100` 注释）：**100+ 为原生/主 provider，50–99 为工具特化，1–49 为共享标准**。

### 2.3 14 种 capability kind

每种的 item 类型与 `key()` 去重键（`src/capability/<kind>.ts`）：

| kind | id | item 类型 | `key()` | `toExtensionId` |
|---|---|---|---|---|
| `context-file` | `context-files` | `ContextFile` | `level==='user' ? 'user' : \`project:${depth}\`` | `context-file:<level>:<basename>` |
| `skill` | `skills` | `Skill` | `skill.name` | `skill:<name>` |
| `rule` | `rules` | `Rule` | `rule.name` | `rule:<name>` |
| `tool` | `tools` | `CustomTool` | `tool.name` | `tool:<name>` |
| `hook` | `hooks` | `Hook` | `\`${type}:${tool}:${name}\`` | `hook:<type>:<tool>:<name>` |
| `mcp` | `mcps` | `MCPServer` | `server.name` | `mcp:<name>` |
| `prompt` | `prompts` | `Prompt` | `prompt.name` | `prompt:<name>` |
| `slash-command` | `slash-commands` | `SlashCommand` | `cmd.name` | `slash-command:<name>` |
| `extension` | `extensions` | `Extension`/`ExtensionManifest` | `ext.name` | —（不可单独开关） |
| `extension-module` | `extension-modules` | `ExtensionModule` | `ext.name` | `extension-module:<name>` |
| `instruction` | `instructions` | `Instruction` | `inst.name` | `instruction:<name>` |
| `settings` | `settings` | `Settings` | `() => undefined` ⚠️ | `settings:<…>` |
| `ssh` | `ssh` | `SSHHost` | `host.name` | — |
| `system-prompt` | `system-prompts` | `SystemPrompt` | `sp.level` | — |

⚠️ `settings` 的 `key` **故意返回 `undefined`**，即永不 dedupe —— 配置是**合并**语义而非遮蔽语义。这是 14 种里唯一的例外，容易看漏。

`mcp` 是唯一使用 `equivalent()` 的 kind（`capability/mcp.ts` 的 `isSameMCPConnection`）：不同名字但 transport/env/header 完全相同的连接会被视为同一项别名。

### 2.4 注册是自注册，由一个副作用 import 引爆

```ts
// sdk.ts:87
import "./discovery";
```

`src/discovery/index.ts` 的 import 顺序是刻意的，注释写明「ensures capabilities are defined before providers register」：

1. 先 import 14 个 `../capability/<kind>` 模块 → 每个顶层调 `defineCapability`
2. 再 import 19 个 provider 模块 → 每个顶层调 `registerProvider`

**实测规模：87 个 `registerProvider` 调用点，分布在 `src/discovery/` 的 19 个文件里**（generic 形式 `registerProvider<Type>(...)`，按文件计数）：

| provider 文件 | 注册数 | priority |
|---|---|---|
| `builtin.ts` | 14 | 100 |
| `codex.ts` | 9 | 70 |
| `claude.ts` | 9 | 80 |
| `omp-plugins.ts` | 7 | 90 |
| `opencode.ts` | 6 | 55 |
| `gemini.ts` | 6 | 60 |
| `claude-plugins.ts` | 6 | 70 |
| `agents.ts` | 6 | 70 |
| `github.ts` | 5 | 30 |
| `cursor.ts` | 3 | 50 |
| `windsurf.ts` | 2 | 50 |
| `agent-plugins.ts` | 2 | 75 |
| `vscode.ts` / `ssh.ts` / `mcp-json.ts` / `cline.ts` / `claude-md.ts` / `builtin-defaults.ts` / `agents-md.ts` | 各 1 | 20 / 5 / 5 / 40 / 10 / 1 / 10 |

`builtin.ts` 单文件就注册 14 次（一一对应 14 种 kind，另有一个 `managed-skills` 子 provider），示例形状：

```ts
// discovery/builtin.ts:424
registerProvider<Rule>(ruleCapability.id, { id: "native", displayName: …, priority: 100, load: … });
```

⚠️ **同名陷阱**：`ModelRegistry.registerProvider`（`src/config/model-registry.ts:2863`，LLM provider 注册）与 extension API 的 `registerProvider`（`src/extensibility/extensions/types.ts:1548`，第三方 provider 注册）**与本 registry 无关**。全仓 grep `registerProvider` 命中 134 处，其中只有 87 处在 `discovery/`。

### 2.5 加载流程

`loadCapability`（`index.ts:297`）→ `loadImpl`（`index.ts:116-278`）：

1. 按 id 取 capability，未定义则抛错
2. 构造 `LoadContext`：`cwd`、`home`、`repoRoot`（走 `findRepoRoot`）
3. `filterProviders`（`:280`）：减去 `disabledProviders` → 与 `options.providers` 取交 → 减去 `options.excludeProviders`
4. **并行**跑所有 provider：`Promise.all(providers.map(p => logger.time(…, p.load, ctx)))`；**抛错的 provider 转成 warning，不使整体失败**
5. 逐项：`_source` 缺失 → 丢弃 + 警告；`disabledExtensions` 命中 → 跳过；`filter` 硬丢；`suppress` 保留在 `all` 但进不了 `items`
6. 按 `key()` 去重，**first-wins = 高优先级赢**；失利者进 `all` 并标 `_shadowed`
7. `validate()` 只对幸存者跑

返回值 `CapabilityResult<T>` = `{ items, all, warnings, providers }`——`items` 是去重后的，`all` 含被遮蔽项供 UI 诊断。

### 2.6 缓存策略（易误解处）

`src/capability/fs.ts` **只缓存原始 FS 读取**：`contentCache: Map<path, string|null>`（`readFile`）与 `dirCache: Map<path, Dirent[]>`（`readDirEntries`/`readDir`/`walkUp`/`findRepoRoot`）。

关键事实：**没有 mtime 检查，`CapabilityResult` 本身也不缓存。** 每次 `loadCapability` 都会重跑全部 provider；进程内的新鲜度靠这个 FS 缓存 + 显式失效：

- `invalidate(filePath, cwd?)`（`index.ts:575`）——删该文件、其目录、父目录三项缓存
- `reset()`（`index.ts:558`，别名 `resetCapabilities`）——清空两个 map，在**切换 cwd / 项目**时调用

## 3. 注册层：`createTools` 每 session 执行一次

### 3.1 唯一的装配入口

```ts
// src/tools/index.ts:519
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]>
```

**实测：全 `src/` 只有 1 个调用点**——`src/sdk.ts:2017`：

```ts
// sdk.ts:2016-2017
// Create built-in tools (already wrapped with meta notice formatting)
await logger.time("createAllTools", createTools, toolSession, options.toolNames);
```

⚠️ 网上/文档中常见的 `createStdlibTools` 在这个仓库**不存在**（`grep` 0 命中）。这个函数名是 RunLedger 的（见 §8），不要混。

### 3.2 两个静态 factory 表

```ts
// tools/index.ts:477
export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
  read: s => new ReadTool(s),
  security_scan: s => new SecurityScanTool(s),
  bash: s => new BashTool(s),
  …
  memory_edit: MemoryEditTool.createIf,   // createIf 形式：条件不满足返回 null
  …
};

// tools/index.ts:508
export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
  think: () => new ThinkTool(),
  yield: s => new YieldTool(s),
  goal:  s => new GoalTool(s),
};
```

```ts
// tools/index.ts:471
export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;
```

`ToolFactory` 的两条路径：`s => new XTool(s)`（无条件）与 `XTool.createIf`（工具自己判定是否可用）。`null` 表示「不要这个工具」。

名字常量（`tools/builtin-names.ts`）：`BUILTIN_TOOL_NAMES` **28 个** + `HIDDEN_TOOL_NAMES` **3 个**（`yield`/`goal`/`think`），另有 legacy 别名映射 `search→grep`、`find→glob`，`normalizeToolNames` 保序去重。

### 3.3 逐工具门表 `isToolAllowed`

`tools/index.ts:683-737` 是一张长 if 链，每个条件工具一条。摘录（完整清单见 §3.4）：

```ts
if (name === "think") return externalThinkingActive;
if (name === "retain" || name === "recall" || name === "reflect")
  return ["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "");
if (name === "task") return canSpawnAtDepth(session.settings.get("task.maxRecursionDepth") ?? 2, session.taskDepth ?? 0);
return true;
```

### 3.4 条件清单（按 gate 来源归类）

| gate 来源 | 受控工具 |
|---|---|
| settings 布尔 | `bash`/`glob`/`grep`/`web_search`/`security_scan`（各自 `.enabled`）、`ask.enabled`、`checkpoint.enabled`、`debug.enabled`、`lsp.enabled`、`astGrep.enabled`、`astEdit.enabled`、`todo.enabled`、`goal.enabled`、`autolearn.enabled`、`github.enabled` |
| settings 枚举 | `memory.backend`：`retain`/`recall`/`reflect` 需 `hindsight\|mnemopi`，`memory_edit` 需 `mnemopi`；`learn` 需 `hindsight\|mnemopi\|local`；`compaction.experimentalContextManagement` → `context_notes`/`new_context` |
| 模型能力探针 | `think` ← `supportsExternalThinking(model)`；`eval` ← `resolveEvalBackends` + `checkPythonKernelAvailability` |
| 外部程序探针 | `github` ← `GithubTool.createIf` → GH CLI 存在性 |
| 递归深度 | `task` ← `canSpawnAtDepth(maxRecursionDepth, taskDepth)`；`hub` ← `isIrcEnabled`（子代理恒有，顶层需仍可 spawn） |
| UI 能力 | `ask` ← `session.canPromptUser ?? session.hasUI` |
| 深度 + 显式授权 | `checkpoint`/`rewind`、`manage_skill`、`learn` 额外要求 `taskDepth === 0 \|\| requestedTools !== undefined` |
| 会话模式 | `goal` ← goal mode active 时**强制 push** 进 `requestedTools` |
| 传输可用性 | `write`（xd:// 设备专用通道）、`read`（挂载时回填） |

注意区分三类语义：
- **gate**：`isToolAllowed` 决定是否实例化
- **auto-include**：显式 `requestedTools` 时自动补齐姊妹工具（`checkpoint`↔`rewind`、`grep`→`ast_grep`、`read`+`grep`→`context_notes`+`new_context`、`edit`→`ast_edit`）
- **force push**：模式要求时无条件加入（goal）

### 3.5 实例化与注册

```ts
// tools/index.ts:721-733（节选）
const baseResults = await Promise.all(baseEntries.map(async ([name, factory]) => {
  const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
  return tool ? wrapToolWithMetaNotice(tool) : null;
}));
let tools = baseResults.filter((r): r is Tool => r !== null);
const toolRegistry = session.toolRegistry ?? new Map<string, Tool>();
for (const tool of tools) toolRegistry.set(tool.name, tool);
```

`wrapToolWithMetaNotice` 给每个工具套一层输出元信息包装（截断提示等）。

### 3.6 完整装配调用链

从 session 创建到最终 `AgentTool[]`（`packages/` 相对路径）：

| # | 位置 | 动作 |
|---|---|---|
| 1 | `src/sdk.ts:1335` | `createAgentSession(options)` 公开入口 |
| 2 | `src/sdk.ts:1342` | `createAgentSessionScoped(options)` 会话构造主体 |
| 3 | `src/sdk.ts:1816-1831` | 分配 `activeToolNames: Set`、`toolRegistry: Map`、`toolSession` 字面量 |
| 4 | `src/sdk.ts:2017` | **`createTools(toolSession, options.toolNames)`** |
| 5 | `src/tools/index.ts:519-815` | gate → 实例化 → 写 registry → xd:// 切分 |
| 6 | `src/sdk.ts:2131-2210` | 追加 image-gen / TTS / 文件系统自定义工具 / 扩展 |
| 7 | `src/sdk.ts:2942-2949` | `goal` 兜底懒注册 |
| 8 | `src/sdk.ts:2951-2968` | 扩展工具覆盖同名项；MCP 占位符（`deferMCPDiscoveryForUI`） |
| 9 | `src/sdk.ts:2974-2976` | **全表过 `ExtensionToolWrapper`**（审批门，见 §6.2） |
| 10 | `src/sdk.ts:3348-3420` | 投影 `initialToolNames`（含 `defaultInactive`/`hidden` 排除） |
| 11 | `src/sdk.ts:3491-3495` | 首次构建 system prompt |
| 12 | `src/sdk.ts:3594-3596` | `initialTools = initialToolNames.map(→toolRegistry.get).filter(≠undefined)` |
| 13 | `src/sdk.ts:3658` | ★ **`new Agent({ initialState: { …, tools: initialTools } })` 冻结** |
| 14 | `src/session/agent-session.ts:1676` | `SessionTools` 接管 registry（消费方，非装配方） |
| 15 | `src/session/session-tools.ts:355-363` | 从冻结数组播种 `#enabledToolNames` |
| 16 | 每请求 | `packages/agent/src/agent.ts:828-832` → `agent-loop.ts:1811-1818` → `stream(…, tools)` |

### 3.7 冻结语义（核心问答）

**静态**：
- 注册决策与 `toolRegistry` 成员集。`sdk.ts:4337` 注释明说：`createTools` 只在 session 启动时构建一次，**之后任何 settings 变更都不重建**；`sdk.ts:2988` 同理（「roster 在 session 创建时构建一次」）。
- 每 session 重新实例化全部 factory —— 既不是进程级单例，也不复用。

**动态**：
- `agent.state.tools`（呈现集）与 system prompt，由 `SessionTools`（`session/session-tools.ts`）持有。
- **绝不因为「新的一轮开始」而变**——一轮只做 normalize。

**变更触发器（枚举）**：

| 事件 | 位置 |
|---|---|
| MCP 连/断 | `session-tools.ts:1886` `refreshMCPTools` |
| 扩展迟到 `registerTool` | `sdk.ts:3988-4075` `scheduleToolRegistration`（带回滚） |
| goal / plan 模式切换 | `modes/interactive-mode.ts:3634` / `:3552` / `:3728` |
| Code Mode 边界 | `agent-session.ts:2052` `reconcileCodeMode` |
| RPC host 工具 | `session-tools.ts:1974` `refreshRpcHostTools` |
| memory backend 切换 | `session-tools.ts:1595` `replaceMemoryTools` |
| vibe 工具集 | `session-tools.ts:628-668` |
| prewalk / 子代理过滤 / 复活 run | `session/prewalk.ts:315`、`task/executor.ts:3865`、`task/persisted-revive.ts:213` |
| browser/computer 开关 | `agent-session.ts:2022-2039`（**只重建 prompt**，二者是 eval prelude 不是 registry 工具） |
| skill / rule / context-file 变动 | `session-tools.ts:1475`、`:1664`（**只重建 prompt**） |

**幂等与缓存**：
1. 工具数组不额外 memo，只有 `agent.state.tools` 一份；`setTools` 有 identity 早退（`session-tools.ts:1120-1126`）
2. prompt 重建由 `#computeAppliedToolSignature`（`:1827-1868`）签名比对跳过——签名含保序名字、每工具 `name/label/description/customWireName/readsSkillUris`、排序后的 MCP server instructions、挂载路由投影、Code Mode 直连名单
3. **刻意的隐式刷新冻结**（`:1070-1084`）：模型声明 `thinking.prefixBinding === true` 且已有 assistant turn 时，签名变了也**不重建 prompt**，而是发 roster delta 通知——纯粹为保住 provider 的 prompt-cache 前缀
4. wire schema 每工具缓存一次（`packages/ai/src/utils/schema/wire.ts:602` 的 `kJsonWireSchema` symbol）
5. token 估算按工具数组 identity 缓存（`modes/utils/context-usage.ts:169-182`）

## 4. 呈现层：三个减负杠杆

### 4.1 `ToolLoadMode` —— 注册与呈现的解耦点

`packages/agent/src/types.ts:939`：

```ts
export type ToolLoadMode = "essential" | "discoverable";
```

- `essential` → 正常顶层工具，schema 进请求
- `discoverable` → **从顶层 schema 移除**，改挂 `xd://`

判定函数（`src/tools/xdev.ts:86`）：

```ts
export function isMountableUnderXdev(tool: { name: string; loadMode?: ToolLoadMode }): boolean {
	if (tool.name in XDEV_TRANSPORT_TOOLS || tool.name in XDEV_KEEP_TOP_LEVEL) return false;
	return tool.loadMode === "discoverable";
}
```

### 4.2 12 个不可下沉的 essential

`src/tools/essential-tools.ts` 钉死：`read`、`write`、`bash`、`edit`、`glob`、`eval`、`task`、`hub`、`learn`、`manage_skill`、`context_notes`、`new_context`。

文件头注释记录了动因（issue #5764）：UI 侧为了自定义渲染而**重新注册** `read`/`write`/`bash`/`edit`/`glob` 时，若 `loadMode` 缺省会被适配器规范化成 `"discoverable"`，开了 `tools.xdev` 就会被静默卸载 —— 而 `read xd://` 是列出设备的唯一通道，等于**所有挂载设备不可达**。`defaultLoadModeForToolName(name, declared)` 就是这道防线：显式声明优先，否则命中的 essential 名字钉成 `"essential"`，其余才是 `"discoverable"`。

另有 `XDEV_KEEP_TOP_LEVEL`（`tools/xdev.ts:59`）保留 5 个发现类工具在顶层，各有理由：

| 工具 | 理由（代码注释原文要点） |
|---|---|
| `todo` | 喂 todo prelude / prewalk 机制 |
| `yield` | 终止结构化子代理 run，藏在 dispatch 后不可用 |
| `ask` | 模型与用户交互的唯一手段 |
| `grep` | bash 拦截器规则的重定向目标 |
| `web_search` | 多数模型不懂 `xd://` 协议，藏起来实际不可达（issue #5973） |

`XDEV_TRANSPORT_TOOLS` = `{ read, write }` —— 二者**承载传输本身**，永不可被挂载。

### 4.3 `xd://` 虚拟设备（主减负机制）

`tools/xdev.ts` 头注释原文：

```text
read  xd://          → mounted tool listing (discovery)
read  xd://<tool>    → tool docs + JSON parameter schema
write xd://<tool>    → execute: `content` is the JSON args object
```

即 **`read`/`write` 同时充当传输层**，挂载设备通过它们驱动，参数走与其他工具相同的校验（`validateToolArguments`，schema 不匹配时**把 schema 回给模型**使其自校正，无需往返）。

系统提示中的文档内联有硬预算（`tools/xdev.ts:257-261`）：

```ts
export const XDEV_DOCS_TOTAL_BUDGET = 48_000;      // 挂载设备段落总字符预算
export const XDEV_DOCS_PER_DEVICE_CAP = 10_000;    // 单设备上限，防一个畸形描述饿死后续
export const XDEV_EXTERNAL_DESCRIPTION_CAP = 200;  // 外部工具描述上限
```

超预算的设备**被推出内联、转为按需读取**（不是截断）。

`tools.xdevDocs` 三档（`config/settings-schema.ts:4924`，默认 `builtins`）：

| 值 | 行为 |
|---|---|
| `inline` | 所有挂载设备的文档与 schema 都内联 |
| `builtins` | 内置内联；MCP 与扩展工具按需获取 |
| `catalog` | 只列设备名；全部按需获取 |

另有 `tools.xdevInlineDevices`（glob 数组）在 `builtins` 档下额外内联匹配的动态设备。

### 4.4 另两个杠杆

**inlineToolDescriptors**（`src/config/inline-tool-descriptors-mode.ts`）：把工具描述搬进 system prompt，同时 wire 上 `stripSchemaDescriptions(toolWireSchema(t))` + `description: ""`（`packages/agent/src/agent-loop.ts:967-970`），schema 退化为裸形状。`auto` 档下仅 Gemini 类模型为真（按 `classifyModel(...).class === "gemini"`）。

**Code Mode**（`src/session/code-mode.ts:49-63`）：

```ts
const active =
  args.provider === "openai-codex" &&
  args.enabledToolNames.includes("eval") &&
  args.evalTransportAvailable &&
  (args.setting === "on" || (args.setting === "auto" && args.toolMode === "code_mode_only"));
```

激活后顶层直连只剩 `CODE_MODE_KEEP_TOOLS` 的 8 个：`eval`、`ask`、`todo`、`yield`、`think`、`checkpoint`、`rewind`、`new_context`（加 eval 桥内部操作 `__agent__`/`__budget__`/`__completion__`/`__wait__`/`__status__`/`__cancel__`/`__workpool__`），其余全走 eval 桥。

精细之处（`session-tools.ts:1094-1098`）：registry **不重建**，且 `#toolPredicateNames` 与 prompt 用的是**宽集合**，只有 `directToolNames` 收窄。注释说明原因——「provider 只收到 `appliedNames`，但 prompt 的能力与安全门必须看到所有仍可经 eval 桥调用的工具；同时渲染出的工具清单限于直连名，以免 prompt 把桥内工具宣称为 provider 可直调的函数」。

### 4.5 模型侧的两条投递路径

**(a) provider schema（主路径）**：`agent.state.tools` → `#toolsForModel(model)` → `normalizeTools(...)`（`packages/agent/src/agent.ts:828-832`）→ `toolWireSchema(t)` 逐工具（结果按 symbol 缓存）→ `stream(model, { tools: llmContext.tools, … })`（`agent-loop.ts:1811-1818`）。每项 `{ name, description, parameters }`。

**(b) system prompt roster**：`SystemPromptToolMetadata` / `projectSystemPromptToolMetadata`（`src/system-prompt.ts:509-578`）两种模式：
- `{ mode: "compact", toolNames }` —— 只出 `label` + `wireName` + `readsSkillUris`，`description: ""`；在 `nativeTools && !inlineToolDescriptors` 时选中
- `{ mode: "full" }` —— 全 registry 带完整描述；否则选中

二者由 `shouldInlineToolDescriptors` 在 session 启动时解析一次决定（`sdk.ts:3157`）。`toolListMode = !inlineToolDescriptors && nativeTools` —— 即**native tool schema 可用时只出紧凑名单，不可用时才出完整 Harmony 风格 `namespace functions { … }` 目录**。

顺带：`readsSkillUris` 不只是文本，它驱动 `hasSkillReader`/`hasSkillUriAccess`（`:1017-1020`），进而决定 skills 目录与 `skill://` 指引是否出现。

## 5. 动态来源：全都汇进同一个 `toolRegistry`

| 来源 | 加载器 | 模块契约 | 进入路径 |
|---|---|---|---|
| **自定义工具** | `extensibility/custom-tools/loader.ts:78` | `default (pi: CustomToolAPI) => CustomTool \| CustomTool[]`；非函数 default 报错 | → 包成 inline 扩展 → `registerTool` |
| **扩展** | `extensibility/extensions/loader.ts:205` | `(pi: ExtensionAPI) => void`；调 `pi.registerTool(def)` | → `runner.getAllRegisteredTools()` |
| **插件** | `extensibility/plugins/loader.ts` | `package.json` 的 `omp`（或 legacy `pi`）字段：`{tools, hooks, extensions, commands, features, settings}` | → 复用上面两条契约 |
| **SDK 宿主** | `src/sdk.ts:2904` | 调用方直接传 `CustomTool`/`ToolDefinition` 对象 | → `customToolToDefinition` |
| **MCP** | `mcp/tool-bridge.ts:712` | 远程 `tools/list` → `class MCPTool implements CustomTool` | → `manager.#onToolsChanged` → `refreshMCPTools` |
| **RPC host** | `session-tools.ts:1974` | 已构造对象 | → `#applyRpcHostToolRefresh` |
| **skills** | `extensibility/skills.ts` | 目录式（`SKILL.md` + frontmatter），**不注册工具** | → prompt 目录 + `/skill:<name>` + `manage_skill`/`learn` 工具 |
| **hooks** | `extensibility/hooks/loader.ts:150` | `default (pi: HookAPI) => void` | → 仅拦截，不新增工具（**但见 §7.2**） |

跨会话继承：父会话向子代理转发**路径列表**而非已加载实例（`preloadedCustomToolPaths` / `preloadedPreparedExtensions`，`sdk.ts:525-534`），子会话用自己的 `CustomToolAPI` 重新绑定 factory —— 避免工具执行回调穿回父会话。

MCP 的启动竞态处理值得一提：`MCPToolCache` 把 `{version:1, configHash: SHA-256, tools}` 持久化到 `agent.db`（`mcp_tools:<server>`，TTL 30 天），连接未就绪时用 `DeferredMCPTool.fromTools(name, cached, () => waitForConnection(name), …)` 先让工具存在，连上后再换实体。

## 6. 命名冲突与准入

### 6.1 冲突策略：分层、fail-loud，不静默改名

| 来源 | 策略 |
|---|---|
| 内置名 | 28 + 3 常量表；`normalizeToolName` 归一大小写与 legacy 别名；`normalizeToolNames` 保序去重 |
| 自定义工具 | `#seenNames` 以内置名播种；撞名 → `errors.push` + **skip，不改名**（`custom-tools/loader.ts:176`） |
| MCP | **铸造**名而非裸名：`mcp__<server>_<tool>`，sanitize 到 `[a-z0-9_]`，去冗余前缀，长度封顶；跨 server 撞名按 `originKey` **稳定择胜**（`deduplicateMCPToolsByName`），**不按数组序**——因为 MCPManager 重连会重新追加；`legacyName` 保留旧拼写使 `tools.approval` 用户键不因改名失效 |
| 扩展 | name-keyed `Map`，**last-wins**（`getRegisteredTool` 反向扫描）；迟到注册若输给既有 RPC-host / SDK-custom 工具则丢弃（`sdk.ts:4004-4006`） |
| RPC host | 最严：批内重复、或撞任何非 RPC 工具名 → **抛错** |

⚠️ 两个易误认的模块：`tools/auto-generated-guard.ts` **不是**命名守卫，是 `edit.blockAutoGenerated` 的路径门；`session/tool-call-loop-redirect.ts` **不是**命名机制，是重复调用循环守卫。

### 6.2 准入：四个层级

1. **发现/准入钳制**：子代理的 `restrictToolNames` 清空 `getAllRegisteredTools()` 与 `options.customTools`（除非 `allowRestrictedCustomTools === true`），并丢弃自定义工具路径。
2. **激活/呈现**：`loadMode` 决定顶层还是挂载；`hidden`/`defaultInactive` 让工具「注册但不在初始活跃集」；`tools.xdev` 可将其改为挂载而非顶层。
3. **运行时审批门（真正的一道）**：`ExtensionToolWrapper.execute` 先 `resolveApprovalFromContext`，然后 `resolveApproval(...)`；`policy === "deny"` 在任何事件前直接抛；针对可能被 hook 改写后的 `effectiveParams` **重新解析**，封堵「批准 A 跑 B」。关键是这道门**对全 registry 无差别施加**：

```ts
// sdk.ts:2974-2976
for (const tool of toolRegistry.values()) toolRegistry.set(tool.name, new ExtensionToolWrapper(tool, extensionRunner));
```

`sdk.ts:2848-2852` 的注释记录：即便零扩展也构造 runner，就是为了让审批门不能静默消失。策略输入：`tools.approval.<tool>: allow|deny|prompt`、`tools.approvalMode: always-ask|write|yolo`、`--auto-approve` 强制 `yolo`、tier 排序 `read < write < exec`、函数式 `approval(args)`、`policyKey` 子工具路由、`legacyName` 回退。

`resolveApprovalFromContext` 在缺 context 时 **fail-closed**（`always-ask` + 空策略）；但注意 settings 存在时用的是配置值，而 **schema 默认是 `yolo`**（`tools/approval.ts:55-95` 注释原文）。

4. **路径级写门**：`assertEditableFile`（`tools/auto-generated-guard.ts`），与准入正交。

## 7. 三个反直觉点

### 7.1 BM25 工具搜索已被移除，但类型的文档注释还在提

`config/settings.ts:2672-2682` 的迁移代码：

```ts
// BM25 tool discovery removal: tools.discoveryMode / tools.essentialOverride /
// mcp.discoveryMode / mcp.discoveryDefaultServers are gone with no
// replacement (`tools.xdev` stays at its own default). Dead keys are
// deleted so they stop lingering in config.yml.
```

但 `packages/agent/src/types.ts:932` 的 `ToolLoadMode` 文档注释仍写着 discoverable 工具「either mounted under `xd://` device URLs (when that transport is active) **or surfaced through BM25 tool search**」。

**判定：文档与代码漂移。** 本树内 `discoverable` 只有两个下沉出口——`xd://` 挂载与 Code Mode eval 桥。读者按类型注释理解会得出错误结论。

### 7.2 Hook 的工具拦截在生产链路上没有接线

实测：

```text
new HookRunner         → 0 命中
new HookToolWrapper    → 0 命中
import "hooks/tool-wrapper" 的模块 → 0 个（该文件无任何 importer）
```

`modes/` 里的 `initializeHookRunner` 是**同名但不同物**——它操作的是 `session.extensionRunner`（扩展运行时），不是 `extensibility/hooks/runner.ts` 的 `HookRunner`。

Hook **文件路径仍被 discovery 发现**（`hookCapability` 有 5 个 provider），但拦截路径未接到执行链。实际生效的等价物是**扩展**的 `on("tool_call")`：`agent.beforeToolCall`（`session/agent-session.ts:1778`）→ `runner.emitToolCall(...)`（`:4176-4181`）+ `ExtensionToolWrapper.execute`。

**判定：需要 owner 确认这是刻意的（扩展已取代 hook）还是遗留。** 本文只记录事实：hook 的 `tool_call`/`tool_result` 拦截在本树不生效。

### 7.3 `capability` 的 `tool` kind 只管「在哪能找到工具定义」

它与运行时工具是两个不同的轴：

- `toolCapability`（`capability/tool.ts:27`，id `"tools"`，item = `CustomTool`，key = `tool.name`）——**声明式 inventory**
- `session.toolRegistry`（`tools/index.ts`）——**命令式、session 作用域、可变**

桥接点：`discoverCustomToolPaths`（`custom-tools/loader.ts:242-271`）调 `loadCapability<CustomTool>("tools", { filter: /\.(ts|js|mjs|cjs)$/ 且非 .d.ts })`，用 `_source` 的 `provider`/`level` 标注路径来源，再交给 `loadCustomTools` 绑到 session 级 `CustomToolAPI`。filter 的存在是为了让非可执行的元数据行（`.json`/`.md`/`.sh`）不能遮蔽同名模块。

`rules`/`skills`/`hooks`/`mcps` 同构：**capability 发现，session 级 loader 消费**。

## 8. 与 RunLedger 的对照

RunLedger 是**整体性 profile 替换**，不是逐工具 `loadMode`。两者不可互相套用。

| 维度 | oh-my-pi | RunLedger |
|---|---|---|
| 装配入口 | `src/tools/index.ts:519` `createTools`（async），**1 个调用点** `sdk.ts:2017` | `src/runtime/tools/index.ts:82` `createStdlibTools`（sync），4 个生产调用点：`session-runtime/domain.ts:739`、`stdlib-stream.ts:83`、`interactive-session-controller.ts:822`、`cli/runtime-host-session.ts:210` |
| 装配方式 | 逐工具门表 + `createIf` 条件工厂 + `null` 语义 | 顺序 `register(...)` 约 20 个，**无逐工具 gate**；条件项存在（`options.webSearch`、`options.managedProcess`、`options.permissionRequester`）但无条件门表 |
| 发现层 | 14 kind capability registry，87 个 provider 注册点，优先级去重 | **无**同类 registry；`src/extensions/capabilities/{registry,types}.ts` 是泛型 capability 编排器，仍 passive 且只有 skills 一个具体接线（见 01 §3 #14） |
| 呈现减负 | `ToolLoadMode` + `xd://` 挂载 + Code Mode + inline descriptors | **无逐工具 demotion**；用 Harness Profile 的 `allowlist` 整体替换 |
| 子集机制 | `requestedTools` + auto-include + force push | `HarnessProfileDescriptor.tools` = `{mode:"standard"}` 直通 或 `{mode:"allowlist", allowlist}`；`projectHarnessTools` 做纯投影，**allowlist 名字必须恰好存在一次**否则抛 `HarnessToolProjectionError`，并校验 frozen manifest digest 防漂移 |
| 现有 profile | — | `minimal@1` = `["bash","edit"]`、`minimal@2` = `["bash"]`、`plan@1` = `["read","glob","ls","plan_read","plan_write"]`、`standard@2` = 直通 |
| 运行时可变性 | 高：MCP / 扩展 / 模式 / Code Mode / RPC 均可热改呈现集 | 低：profile 在 Session 创建时冻结、fork 继承（根 `AGENTS.md` §2）；工具集变更走 profile 而非增量 |
| 审批门 | 全 registry 无差别套 `ExtensionToolWrapper` | Security/ExecutionGateway + attempt gateway + owner fence（不同模型，见 00 §5） |
| 动态来源 | custom tools / extensions / plugins / MCP / RPC host / SDK | 扩展 out-of-process host（`registerTool`/`registerCommand`/`registerFlag`/`on`）+ MCP 客户端 |

**结论**：RunLedger 不需要「工具多到炸 context」的解法，因为它没有 100+ 工具面（00 §4 `tools/`：26 文件 vs 上游 159）。若将来 `tools/` 缺口被填补（00 §8 优先级 P0 列的 `ast-grep`/`ask`/`checkpoint` 等），`loadMode`-style 呈现层会从「不需要」变成「必须有」——这是本文对 RunLedger 的唯一前瞻性提示，不是当前缺陷。

## 9. 复现命令

```sh
# 以下命令在同时包含两个 checkout 的父目录执行
OMP=oh-my-pi/packages/coding-agent/src

# 装配入口唯一性（应为空 = 只有定义，无第二个调用点）
grep -rn "createTools(" --include=*.ts $OMP | grep -v "^$OMP/tools/index.ts:519"

# provider 注册点计数（注意 generic 形式，普通正则漏计）
grep -rnE "^[[:space:]]*registerProvider(<[^>]*>)?\(" --include=*.ts $OMP/discovery | wc -l   # 87
grep -rlE "^[[:space:]]*registerProvider" --include=*.ts $OMP/discovery | wc -l               # 19

# capability 定义（14 个）
grep -rn "defineCapability<" --include=*.ts $OMP/capability

# 同名陷阱：非 capability 的 registerProvider
grep -rnE "^[[:space:]]*registerProvider(<[^>]*>)?\(" --include=*.ts $OMP | grep -v "^$OMP/discovery/"

# provider 优先级表
for f in builtin omp-plugins claude agent-plugins agents claude-plugins codex gemini \
         opencode cursor windsurf cline github vscode builtin-defaults; do
  printf '%-18s %s\n' "$f" "$(grep -oE 'PRIORITY = [0-9]+' $OMP/discovery/$f.ts | head -1)"; done

# 常量与预算
grep -c '"' $OMP/tools/builtin-names.ts     # 28 builtin + 3 hidden 见 HIDDEN_TOOL_NAMES
grep -n "XDEV_DOCS_TOTAL_BUDGET\|XDEV_DOCS_PER_DEVICE_CAP\|XDEV_EXTERNAL_DESCRIPTION_CAP" $OMP/tools/xdev.ts

# BM25 移除（迁移代码）vs 文档漂移（类型注释）
grep -n "BM25" $OMP/config/settings.ts $OMP/../agent/src/types.ts

# Hook 拦截是否接线（应输出 0）
grep -rn "new HookRunner\|new HookToolWrapper" --include=*.ts $OMP | wc -l
grep -rn "hooks/tool-wrapper" --include=*.ts $OMP | grep -v "^$OMP/extensibility/hooks/tool-wrapper.ts" | wc -l
```

## 10. 证据限制

1. 本文是**静态源码阅读**结论：未运行上游任何代码，未做真实 provider 请求验证。「注册 ≠ 呈现」的运行时行为由代码路径推定，非实测观测。
2. §7.2（hook 未接线）是**基于 grep 的否定判定**。若存在动态 import、字符串拼接 import 或经未纳入检索的构建产物装载的路径，可能被误判；标注为需 owner 确认。
3. §3.7 的触发器枚举基于 grep `applyActiveToolsByName` / `reconcileCodeMode` / `refreshMCPTools` / `setActiveToolsByName` 的调用点，不保证穷尽非常规入口。
4. 上游行号会漂移；复核请用 §9 的符号名检索而非硬编码行号。
5. 本文不评估这套机制的好坏，也不构成 RunLedger 的改造建议；§8 的对照仅陈述两侧机制差异。
