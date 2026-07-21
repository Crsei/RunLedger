# RunLedger 工具系统适配 pi 的实施计划

> 文档属性:历史实施计划。原始来源:`.zcode/plans/plan-sess_a0969a3b-1c6e-4abc-b39b-2b816e0477b3.md`。
> 本文记录工具注册、ExecutionEnv、stdlib 工具与 StreamFn 桥接的设计过程;当前接口与已落地边界以仓库根目录 `AGENTS.md` §1.2 和 §5 为准。

## 背景与目标

`feat/agent-loop-resurrect` 分支已让 `runAgentLoop` 端到端跑通（mock-stream + echo）。但工具系统只是 `echo.ts` 单点示范：`AgentTool.execute(toolCallId, input, signal)` 签名与 pi 不一致、无 `ToolContext`/`ExecutionEnv`/`ToolRegistry`、`AgentToolResult` 也缩水为 `ToolResultContent`。

本计划目标：**全量 fork pi 的工具系统架构**——补齐 `AgentTool`/`AgentToolResult`/`ToolDefinition`/`ToolRegistry`/`ToolContext`/`ExecutionEnv`/内置工具集（bash/read/write/edit/grep/find/ls 7 个）——同时保留 RunLedger 的 `LedgerSink` 审计切点，不污染 pi-ai 移植层。

## 设计决策（已与用户对齐）

| 决策项 | 选定方案 |
|---|---|
| 适配范围 | **全量 fork**（含 ExecutionEnv/Shell/工具集），解锁 AGENTS.md §1.3 的"显式不实现" |
| Registry 形态 | **Map 形态 `ToolRegistry`**（命名空间+版本元数据，为企业级多命名空间铺路） |
| AGENTS.md | 同步更新文档反映 `src/_legacy/` 已迁移到 `src/runtime/` 的现状 |

## 类型层设计（核心）

对齐 pi `packages/agent/src/types.ts`，但在 `src/runtime/types.ts` 重写为 RunLedger 版本（不引入新 import 别名，保持 verbatimModuleSyntax 纯净）。

### 新/改类型清单

1. **`AgentTool<TParameters, TDetails>`**（改 self-typed `AgentTool`）
   - 字段对齐 pi: `name / description / parameters: TSchema / label / prepareArguments? / execute / executionMode?`
   - `execute(toolCallId, params, signal?, onUpdate?) => Promise<AgentToolResult<TDetails>>`
   - **契约改 throw-on-failure**（替换 RunLedger 当前"工具不抛错"约定，由 agent-loop 兜底转 isError）
   - `ToolExecutionMode = "sequential" | "parallel"` 提为顶层导出

2. **`AgentToolResult<T>`**（替换 `ToolResultContent`）
   ```ts
   {
     content: (TextContent | ImageContent)[];  // 加 ImageContent 支持
     details: T;                                // 强制结构化 details(可 unknown)
     addedToolNames?: string[];                // deferred tooling
     terminate?: boolean;                        // 全员同意才停
   }
   ```
   旧 `ToolResultContent` 退役，由 agent-loop 在 `convertToLlm` 边界把 `AgentToolResult` 摊平为 pi-ai `ToolResultMessage`（含 `toolCallId`/`toolName`/`isError`/`addedToolNames`）。

3. **`AgentToolCall`** 改为复用 pi-ai `ToolCall`（`Extract<AssistantMessage["content"][number], { type: "toolCall" }>`），消除当前 `id/name/input` 自定义形态与 `toolCall.arguments` 译码。

4. **`BeforeToolCallResult` / `AfterToolCallResult`** 对齐 pi 字段（`block?: boolean` 替代 `block?: true`；`afterToolCall` 加 `terminate?`）。

5. **`BeforeToolCallContext` / `AfterToolCallContext`**（新）—— 包含 `assistantMessage` + `context` + 验证后 args，替代当前简陋的 `{ tool, toolCall, messages, result }` 4 元组。

6. **`AgentContext.tools` 改为 `AgentTool<any>[] | undefined`** —— 与 pi 一致，允许"无工具" turn。

7. **`AgentLoopConfig` 增字段**: `beforeToolCall(ctx, signal)` 而非当前 `(tool, toolCall, messages)`。

### ToolContext（新）

`src/runtime/tool-context.ts` 定义：
```ts
interface ToolContext {
  cwd: string;
  fs: FileSystem;        // ExecutionEnv.fs
  shell: Shell;           // ExecutionEnv.shell
  ledger?: LedgerSink;    // 工具可主动记账(审计扩展点)
  env: Record<string, string>;
  signal: AbortSignal;
  sessionId: string;
  toolCallId: string;
}
```

`AgentTool.execute` 签名变为 `(toolCallId, params, signal, onUpdate, ctx: ToolContext)` —— 与 pi `ToolDefinition.execute(..., ctx: ExtensionContext)` 对齐（去掉 UI 字段，保留审计/backends）。

### ToolRegistry（新）

`src/runtime/tool-registry.ts`：
```ts
class ToolRegistry {
  private tools = new Map<string, { tool: AgentTool; namespace: string; version?: string }>();
  register(tool, opts: { namespace?: string; version?: string }): void
  unregister(name: string): void
  get(name: string): AgentTool | undefined          // 取首个匹配
  has(name: string): boolean
  list(namespace?: string): AgentTool[]
  toContext(): AgentTool[]                           // 投影为 AgentContext.tools
  schemaOnlyView(): Tool[]                            // 给 LLM 用,丢 execute/label
}
```
合并策略改为"域内 first-wins + 跨 namespace 隔离"（与 pi 不同，但更适合多租户审计）。

## ExecutionEnv（新，§1.3 解禁）

`src/runtime/execution-env.ts` —— 把 pi `BashOperations` / `ReadOperations` / `EditOperations` 上提一层统一抽象：
```ts
interface FileSystem {
  readFile(path): Promise<Buffer>
  writeFile(path, data): Promise<void>
  stat(path): Promise<Stats>
  // ...
}
interface Shell {
  exec(cmd, opts): Promise<{ stdout: string; stderr: string; exitCode: number }>
}
interface ExecutionEnv {
  fs: FileSystem
  shell: Shell
  cwd: string
}
```
- 默认实现 `localExecutionEnv(): ExecutionEnv`：基于 `node:fs/promises` + `node:child_process` spawn
- git-bash 检测：移植 pi `utils/shell.ts` 的 win32 路径解析逻辑到 `src/utils/shell.ts`（RunLedger 已禁用此条 → 文档同步解锁）

## 内置工具集（7 个 fork from pi）

`src/runtime/tools/` 下新增，每个一个文件，三件套结构对齐 pi：
```ts
// read.ts 范例
export const readSchema = Type.Object({ path: Type.String(), ... });
export type ReadArgs = Static<typeof readSchema>;
export function createReadTool(ctx: ToolContext): AgentTool<typeof readSchema, ReadDetails> { ... }
```

- `read.ts` — `ReadOperations` 接口 + 默认 fs 实现
- `write.ts` — `WriteOperations` + 文件变更队列
- `edit.ts` — `EditOperations` + diff 算法（移植 pi `core/tools/edit-diff.ts`）
- `bash.ts` — `BashOperations` + `BashSpawnHook` + output 累积器
- `grep.ts` / `find.ts` / `ls.ts` — 较薄，纯 fs 调用
- `glob.ts`（pi `find.ts` 实际是 glob 语义，与 ls/find 各自负责不同语义）—— 视 pi 实际而定
- `index.ts` barrel — `getDefaultTools(ctx): AgentTool[]`

**pi 的 `renderCall`/`renderResult`/`promptSnippet`/`promptGuidelines` 4 个 UI 字段不 fork**：RunLedger 是 runtime 不是 TUI 工具，这些字段直接丢弃，审计负载改成 `details` 自由形态（ledger 入库时序列化）。

## StreamFn 适配（新）

`src/runtime/providers/stdlib-stream.ts` —— Fix #4 报告中的"P3 StreamFn 桥接"。一个薄 wrapper：
```ts
export function stdlibStreamFn(model, ctx: LlmContext, opts): AssistantMessageEventStream {
  const piCtx: Context = {
    systemPrompt: ctx.systemPrompt,
    messages: ctx.messages,
    tools: agentToolsToPiTools(ctx.tools),   // schema-only 投影
  };
  return stream(model, piCtx, opts);
}
```
不强制本期 LLM 集成测，但让 `Agent.streamFn` 字段从 `mockStreamFn` 可平滑切换到 `stdlibStreamFn`。echo 工具保留作为 mock 测试用例不变。

## Agent 调用一致性改动

`src/runtime/agent.ts:140` 当前用 `...({ ledger: ... } as Record<string, unknown>)` 绕开类型契约的方式，本次清理：把 `ledger` 升级为 `AgentLoopConfig` 第一公民字段（在 types.ts 显式声明），删除 `WithLedger` 反射 trick。

`agent-loop.ts:500` `tool.execute` 调用点：改 4 参数 → 5 参数（加 `ctx` 与 `onUpdate`）；prepare→execute→finalize 三段语义补齐：
- `prepareToolCall`: 走 `validateToolArguments`（移植 pi-ai `utils/validation.ts:263-310`）
- `executePreparedToolCall`: try/catch → `createErrorToolResult(message)` + `isError: true`
- `finalizeExecutedToolCall`: 跑 `afterToolCall`，字段级浅合并到 `AgentToolResult`
- `toolCalls.length > 0` 之外的"`length` 截断降级路径"补齐（agent-loop.ts 当前缺）

## 测试与回归

1. **保留** `tests/agent-loop.test.ts` 现有 2 个用例不动；mock-stream + echo 仍是默认测。
2. **新增** `tests/tool-registry.test.ts`：register/unregister/list/schemaOnlyView 回归。
3. **新增** `tests/tools/read.test.ts`：用 tmpdir 写文件，调 `createReadTool(ctx).execute` 读回内容比对。bash/edit/grep 同理 ≤5 个测。
4. **新增** `tests/execution-env.test.ts`：local fs/shell 基本契约。
5. echo 工具改新签名后，必须保持 message 顺序断言不破。

所有改动须通过 `npm run check`(完整输出)，按 AGENTS.md §2 严守 erasableSyntaxOnly / verbatimModuleSyntax / .ts 后缀 / 中文注释规约。

## 文档同步

更新 `AGENTS.md`：
- §1.1 把 `agent-loop.ts` / `agent.ts` / `ledger/*.ts` 从"待填实"移除（这些已实化于 `src/runtime/`）
- §1.2 "暂存 _legacy" 整段删除（_legacy 目录已不存在）
- §1.3 移除 "ExecutionEnv (FileSystem + Shell) 抽象层"（本期解禁）；其余 Skills/PromptTemplates/streamProxy 仍标"显式不实现"
- §4 目录约定补 `src/runtime/` 子树说明
- §5 "未引入 utils/shell.ts" 改为"本期已引入最小版 git-bash 检测"

## 实施顺序（PR 拆分建议）

按 5 个独立 commit，每 commit 跑 `npm run check` + `npm test`：

| # | commit | 改动文件 | 工作量 |
|---|---|---|---|
| 1 | `feat(runtime): AgentTool/AgentToolResult 对齐 pi signatures` | `src/runtime/types.ts`、`agent-loop.ts`、`agent.ts`、`tools/echo.ts`、`tests/agent-loop.test.ts` 跟进 | 中 |
| 2 | `feat(runtime): ToolRegistry + ToolContext 抽象` | 新 `tool-registry.ts`、`tool-context.ts`、`tests/tool-registry.test.ts`、接入 `agent-loop.ts` 调用点 | 中 |
| 3 | `feat(runtime): ExecutionEnv (FileSystem/Shell) 默认实现` | 新 `execution-env.ts`、`utils/shell.ts`、`tests/execution-env.test.ts` | 中 |
| 4 | `feat(runtime): fork pi 内置工具集 read/write/edit/bash/grep/find/ls` | 新 `tools/{read,write,edit,bash,grep,find,ls}.ts`、`tools/index.ts`、5 个测试 | 大 |
| 5 | `feat(runtime): stdlibStreamFn + AGENTS.md 文档同步` | 新 `providers/stdlib-stream.ts`、改 `AGENTS.md`、`tests/*` 选增 | 中 |

## 边界与非目标

- **不做**：Skills loader / Prompt templates / OTel / metrics / Session 树分叉 / `streamProxy` / `cli.ts` 产物层
- **不做**：MCP 工具桥（pi 有 `tools/mcp.ts`，本期留作未来扩展点）
- **不做**：TUI 渲染字段（renderCall/renderResult/promptSnippet/promptGuidelines）—— 直接砍
- **不做**：每 turn 重建 registry（pi `agent-session.ts:2425` 模式）—— 长存 registry 即可，审计原子性更好
- **不修**：pi-ai 移植层（`src/api/` / `src/auth/` / `src/providers/` / `src/storage/` / `src/utils/` 共 35+ provider 文件不动）

完成时间预估：单 commit 中等工作量，5 个 commit 合计 ~半天到一天聚焦开发。
