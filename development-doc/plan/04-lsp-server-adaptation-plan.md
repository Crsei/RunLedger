# RunLedger LSP Server 适配实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 oh-my-pi（pi-coding-agent，v17.2.15）的 LSP Server 设计与适配机制移植进 RunLedger：配置层（defaults + `lsp.json` 覆盖 + 自动探测）、客户端层（LspClient 生命周期 + JSON-RPC）、传输层（私有 stdio 子进程）、适配层（`isLinter` + `LinterClient` 工厂），以一个 `lsp` AgentTool 进入会话工具集。

**Architecture:** 复用 pi 的四层结构（配置 → 客户端 → 传输 → 适配），按 RunLedger 架构重接三个点：工具载体改为 `AgentTool`（TypeBox schema + 注入 ops 治理接缝）；生产 LSP/Biome/SwiftLint 进程统一由 Session managed-process domain 持有并在终态结算 recovery attempt；文件读写/rename 统一经 governed `ExecutionEnv.fs`，再由单一 attempt gateway 记录副作用。`Bun.spawn` 只保留为 standalone/test 默认接缝。参考实现：`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/lsp/*`。

**Tech Stack:** TypeScript（strict + erasableSyntaxOnly + NodeNext）、Session managed process（生产 stdio/CLI）、Bun（standalone stdio）、TypeBox、Vitest、governed `ExecutionEnv`。

## 本工作树执行记录（2026-08-14）

- 隔离工作树：`RunLedger-lsp-server-adaptation`；分支：`worktree/lsp-server-adaptation`；基线：`b699b70`。
- P0–P6 已实现并通过聚焦测试；完整 `npm run check`、`npm test`、`npm run build` 均通过。全量证据为 Vitest 351 files / 2063 tests passed / 3 skipped、Bun OpenTUI 89 tests / 443 assertions passed。
- 已执行标准 PATH 入口 `runledger --help` 与 `runledger --version`，确认链接指向本工作树；未创建 commit、未 merge、未 push。
- P7 已完成全量门禁、CLI 入口 smoke、隔离真实 TTY 启动/退出 smoke，以及真实 rust-analyzer stdio smoke（`status=ready`、`documentSymbol` 返回 66 个符号）。TypeScript/Biome 二进制未安装，RunLedger TypeScript/Biome dogfood 与 TUI 内 LSP 动作 smoke 保持 pending，不宣称完成。

### Review 修复记录（2026-08-14）

- 修复生产 authorization：`lsp` 加入 governed tool admission；Plan Mode 仍因无只读 capability claim 而 fail closed。
- 生产 LSP stdio 改用 Session managed-process handle；动作 timeout signal 不再附着到缓存进程，attempt 由 process terminal state 结算。
- client、connecting client 与 linter cache 全部按 `sessionId` 隔离；Session shutdown 只清理本 scope。
- 文件 open/change、符号定位、WorkspaceEdit 与 rename_file 统一使用 governed filesystem；`rename` 加入 `FileSystem`、Gateway 与 recovery attempt 链，去掉 raw rename 与双层 attempt。
- diagnostics 等待 refresh 后的新发布；`$/progress` 只在 `kind=end` 完成。`workspace/configuration` 返回对齐数组，支持 `window/workDoneProgress/create`，不再宣称未实现的 applyEdit 与事务回滚。
- Biome/SwiftLint 生产 runner 改用 managed foreground process，传播 abort、限制输出并显式报告启动/JSON 错误；Biome 按 UTF-8 byte span 转 LSP UTF-16 位置并兼容 `description`。
- URI 使用 `fileURLToPath`，覆盖 Windows drive/UNC；`params.timeout` 已按秒覆盖工具默认值；schema 不再声称 diagnostics 支持 glob。
- fresh 自动证据：LSP/Session/Security focused 12 files / 94 tests、`npm run check`、`npm test`、`npm run build`、标准 PATH help/version 与隔离 TTY smoke 全部通过。全局链接确认指向本工作树。
- 修复后的真实 Session-managed rust-analyzer 与 TUI 内 LSP 动作尚未重跑；旧 standalone rust-analyzer 结果只保留为历史证据。Biome/SwiftLint/TypeScript server 当前不在 PATH，因此 P7 继续保持部分完成。

## 适配总览（pi → RunLedger）

| pi 机制 | RunLedger 适配 | 决策理由 |
|---|---|---|
| `LspTool` 独立工具类 + session 审批分级（`LSP_READONLY_ACTIONS`） | 单个 `lsp` `AgentTool`（`src/lsp/tool.ts`），TypeBox schema，写动作经注入 `LspWriteOperations` 治理 | RunLedger 工具统一走 `AgentTool` + 注入 ops 契约（`src/runtime/tools/write.ts` 同款）；静态 capability claim 无法区分混合读写动作，v1 fail-closed（见 P3） |
| 传输三选一：私有 `ptree.spawn` / broker 共享 mux（`mux/daemon.ts`）/ 外部 `lspmux` | v1 仅私有 stdio；生产 `LspProcessSpawner` 适配 Session managed process，standalone 才使用 `Bun.spawn` | Session process domain 已提供 owner fencing、permission/approval/constraint/sandbox/final-leaf 与终态 attempt 结算；共享 mux 仍为非目标 |
| 配置合并多来源（`~/lsp.*`、插件、`~/.claude` 等、`<cwd>/lsp.*`） | v1 仅 `<cwd>/lsp.json` + `<cwd>/.lsp.json` 覆盖内建 defaults；无 YAML、无用户级 | RunLedger authority 严格（`RunledgerLayout` canonical 文件只有 settings/auth/agents）；v1 项目级文件不触碰 layout 契约，用户级留待显式 ADR |
| `idleTimeoutMs` 空闲回收 | v1 无；client/connecting/linter cache 以 `sessionId` 为 scope，由 Session domain shutdown 精确清理 | 不做后台定时器，也不允许全局 shutdown 影响其他 Session |
| 53 个内建服务 + lspmux | 精选 20 个内建服务（见 P1）；其余按需追加（纯数据） | 覆盖 RunLedger 自身生态（TS/biome/Python/Go/Rust/C）+ 通用前端/文档 |
| `capabilities`（flycheck/ssr 等）、`workspaceReadyTimings` | 保留，rust-analyzer 轮询在 P5 实现 | 与 pi 对齐，成本低 |
| `createClient` 工厂（BiomeClient/SwiftLintClient） | 保留；standalone 使用本地默认，生产由 Session 注入 managed runner 与 governed read | Biome LSP 有 stale diagnostics 已知问题，CLI 适配值得保留，但不能绕过 Session authority |

## 显式非目标（v1）

- broker 共享 mux daemon、外部 lspmux 包装、`lsp.shared` 设置。
- 用户级 `~/.runledger/lsp.json`、插件 LSP 配置、YAML 配置。
- `idleTimeoutMs`、动态能力注册（`client/registerCapability`）、`workspace/didChangeWatchedFiles` 广播。
- workspace diagnostics（`cargo check`/`npx tsc` 子命令直跑）、glob 批量诊断。
- 会话级 `lsp.enabled` 开关（v1 由生产接线显式决定是否注册该工具；配置入口留待 settings ADR）。
- 每动作 capability claim 分级（Plan Mode 下 `lsp` 工具整体 fail-closed，见 P3 与 P6）。

## 文件结构

```text
src/lsp/
├── types.ts                  # ServerConfig / LspTransport / LspClient / 协议类型 / 工具 schema / 注入接缝
├── transport.ts              # Bun.spawn 私有 stdio 适配器 + localLspSpawner
├── defaults.json             # 20 个内建服务定义(唯一内建表)
├── config.ts                 # loadConfig / 合并 / 自动探测 / 二进制解析 / 文件路由
├── client.ts                 # getOrCreateClient / 握手 / 帧读取 / sendRequest / open/sync / shutdown
├── utils.ts                  # fileToUri / detectLanguageId / resolveSymbolColumn / positionAt / offsetAt
├── edits.ts                  # applyWorkspaceEdit(经 LspWriteOperations) + 本地默认 ops
├── tool.ts                   # createLspTool:AgentTool,14 动作派发
└── clients/
    ├── index.ts              # getLinterClient / clearLinterClientCache
    ├── lsp-linter-client.ts  # LSP 协议 linter 兜底客户端
    ├── biome-client.ts       # Biome CLI JSON 输出适配
    └── swiftlint-client.ts   # SwiftLint CLI JSON 输出适配
src/runtime/session-runtime/
└── lsp-composition.ts        # P6:managed stdio / governed write ops / managed linter factories
tests/lsp/
├── fake-transport.ts         # 测试用脚本化 LspTransport(公共 fixture)
├── transport.test.ts
├── config.test.ts
├── client.test.ts
├── utils.test.ts
├── edits.test.ts
├── tool-read.test.ts
├── tool-write.test.ts
└── clients.test.ts
tests/runtime/session-runtime/
└── lsp-composition.test.ts   # P6 生产组合测试
src/runtime/session-runtime/domain.ts   # P6 修改:productionSessionTools 增加 lsp 选项
development-doc/00-index.md             # 本计划完成登记(规划阶段已加行)
```

## Global Constraints

- 相对路径导入必须带 `.ts` 后缀；`module: NodeNext`；`import values from "./defaults.json" with { type: "json" }`。
- 只允许可擦除 TS 语法：禁止 `enum`/`namespace`/`import =`/`export =`/参数属性；类显式声明字段并赋值。
- 严禁 `any`（确需时立即给 `// why any` 注释）；异步工具方法不抛错，错误以 `throw` 交给 agent-loop 转 isError（`AgentTool` 契约）；内部非工具模块可以 throw。
- 中文注释，简洁技术化，不放 emoji。
- 业务模块禁止 `process.platform` 分支（平台能力经 `src/workspace/runtime-platform.ts`）；LSP 模块不做任何平台分支，`Bun.spawn` 跨平台处理可执行名。
- 修改代码后必须 `npm run check`（完整输出）、`npm test`、`npm run build` 全绿再提交；提交只暂存本任务明确涉及路径，禁止 `git add -A`/`git add .`。
- 测试不依赖真实语言服务器二进制；协议行为用 `tests/lsp/fake-transport.ts` 脚本化假传输，CLI 适配注入假 runner。真实二进制只出现在 P7 手动 smoke。
- vitest 运行于 Node（无 `Bun` 全局），`bunSpawnTransport` 的真实 spawn 路径不进单测。

---

### P0-1: 类型与契约（`src/lsp/types.ts`）

**Files:**
- Create: `src/lsp/types.ts`

**Interfaces:**
- Produces（后续全部任务依赖）: `ServerConfig`、`LspConfig`、`LspTransport`、`LspProcessSpawner`、`LspWriteOperations`、`LspClient`、`LspServerCapabilities`、JSON-RPC 三元组、协议子集类型、`LSP_ACTIONS`/`LspAction`、`lspSchema`/`LspParams`、`LspToolDetails`、`LinterClient`/`LinterClientFactory`、`WorkspaceReadyTimings`。

- [x] **Step 1: 写类型文件**

```ts
/**
 * LSP Server 适配层类型 —— 从 pi coding-agent `src/lsp/types.ts` 适配。
 * RunLedger 差异:无 enum(erasableSyntaxOnly)、TypeBox schema 只描述工具入参、
 * 注入接缝(spawner / writeOperations)纳入本文件统一契约。
 */
import type { Static } from "typebox";
import { Type } from "typebox";

// ===== ServerConfig =====

export interface ServerCapabilities {
	flycheck?: boolean;
	ssr?: boolean;
	expandMacro?: boolean;
	runnables?: boolean;
	relatedTests?: boolean;
}

export interface WorkspaceReadyTimings {
	timeoutMs?: number;
	pollMs?: number;
	settleMs?: number;
	statusRequestTimeoutMs?: number;
}

export interface LinterClient {
	lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]>;
	format?(filePath: string, content: string, signal?: AbortSignal): Promise<string>;
	dispose?(): void;
}

export type LinterClientFactory = (config: ServerConfig, cwd: string) => LinterClient;

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	/** didOpen 携带的 LSP language id;缺省按文件路径推断。 */
	languageId?: string;
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	/** 每服务 warmup 超时(ms),覆盖全局默认。 */
	warmupTimeoutMs?: number;
	/** rust-analyzer workspace-ready 轮询覆写。 */
	workspaceReadyTimings?: WorkspaceReadyTimings;
	capabilities?: ServerCapabilities;
	/** 纯 linter/formatter 服务:只参与诊断,不做类型智能。 */
	isLinter?: boolean;
	/** 配置加载阶段解析出的命令绝对路径。 */
	resolvedCommand?: string;
	/** 自定义 linter 客户端工厂(绕开 LSP 协议)。运行时字段,配置不可写。 */
	createClient?: LinterClientFactory;
}

// ===== 传输层 =====

export interface LspWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | void | Promise<number | void>;
}

export interface LspTransport {
	readonly stdin: LspWriteSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	readonly pid?: number;
	kill(): void;
	peekStderr(): string;
}

export interface LspProcessSpawner {
	spawn(command: string, args: string[], cwd: string, signal?: AbortSignal): LspTransport | Promise<LspTransport>;
}

// ===== 治理接缝 =====

export interface LspWriteOperations {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	createDirectory(path: string): Promise<void>;
	renameFile(oldPath: string, newPath: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
}

// ===== JSON-RPC =====

export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	method: string;
	params?: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

// ===== 协议子集 =====

export interface Position { line: number; character: number; }
export interface Range { start: Position; end: Position; }
export interface Location { uri: string; range: Range; }
export interface LocationLink {
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // error | warning | info | hint

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	source?: string;
	message: string;
	relatedInformation?: Array<{ location: Location; message: string }>;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
	version?: number;
}

export interface TextEdit { range: Range; newText: string; }
export interface TextDocumentEdit {
	textDocument: { uri: string; version: number | null };
	edits: TextEdit[];
}
export interface CreateFile {
	kind: "create";
	uri: string;
	options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}
export interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}
export interface DeleteFile {
	kind: "delete";
	uri: string;
	options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
}
export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
}

export interface Command { title: string; command: string; arguments?: unknown[]; }

export interface CodeAction {
	title: string;
	kind?: string;
	diagnostics?: Diagnostic[];
	edit?: WorkspaceEdit;
	command?: Command;
	isPreferred?: boolean;
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: number;
	location: Location;
	containerName?: string;
}

export interface Hover {
	contents: unknown;
	range?: Range;
}

// ===== 客户端状态 =====

export interface OpenFile { version: number; languageId: string; }

export interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

export interface LspServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	typeDefinitionProvider?: boolean;
	implementationProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
	diagnosticProvider?: boolean | Record<string, unknown>;
	[key: string]: unknown;
}

export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	proc: LspTransport;
	requestId: number;
	diagnostics: Map<string, PublishDiagnosticsParams>;
	diagnosticsVersion: number;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number | string, PendingRequest>;
	/** 未解析完的入站字节缓冲(帧解析跨 chunk 累积)。 */
	messageBuffer: Uint8Array;
	serverCapabilities?: LspServerCapabilities;
	/** "connecting" 直到 initialize 完成;init 失败或 reader 死亡置 "error"。 */
	status: "connecting" | "ready" | "error";
	lastActivity: number;
	/** 串行化出站 JSON-RPC 写。 */
	writeQueue: Promise<void>;
	/** 服务端初始项目加载完成(resolve 或超时兜底)。 */
	projectLoaded: Promise<void>;
	resolveProjectLoaded: () => void;
}

// ===== 配置 =====

export interface LspConfig {
	servers: Record<string, ServerConfig>;
}

// ===== 工具 =====

export const LSP_ACTIONS = [
	"diagnostics", "definition", "type_definition", "implementation", "references",
	"hover", "symbols", "status", "capabilities", "rename", "rename_file",
	"code_actions", "reload", "request",
] as const;

export type LspAction = (typeof LSP_ACTIONS)[number];

export const lspSchema = Type.Object({
	action: Type.Union(LSP_ACTIONS.map((action) => Type.Literal(action))),
	file: Type.Optional(Type.String({ description: "文件路径;diagnostics 支持 glob;workspace 形态用 \"*\"" })),
	line: Type.Optional(Type.Number({ minimum: 1, description: "1 起始行号" })),
	symbol: Type.Optional(Type.String({ description: "行内符号子串;支持 name#N 出现次选择器" })),
	query: Type.Optional(Type.String()),
	new_name: Type.Optional(Type.String({ description: "rename/rename_file 的新名字或目标路径" })),
	apply: Type.Optional(Type.Boolean({ description: "rename/rename_file 默认应用;code_actions 默认仅列出" })),
	timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: "秒,默认 20" })),
	payload: Type.Optional(Type.String({ description: "action=request 的 JSON 参数" })),
});

export type LspParams = Static<typeof lspSchema>;

export interface LspToolDetails {
	action: LspAction;
	success: boolean;
	serverName?: string;
}
```

- [x] **Step 2: 类型检查**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npm run check`
Expected: 全绿，无新增 error/warning/info（新文件无消费者，确认无 unused 报错后继续）。

- [ ] **Step 3: 提交**

```bash
git add -- src/lsp/types.ts
git commit -m "lsp: 增加 LSP 适配层类型与注入接缝契约"
```

---

### P0-2: 私有 stdio 传输（`src/lsp/transport.ts`）

**Files:**
- Create: `src/lsp/transport.ts`
- Test: `tests/lsp/fake-transport.ts`（公共 fixture，非测试文件）、`tests/lsp/transport.test.ts`

**Interfaces:**
- Consumes: `LspTransport`、`LspProcessSpawner`（P0-1）。
- Produces: `bunSpawnTransport(command, args, cwd): LspTransport`、`localLspSpawner(): LspProcessSpawner`、`WARMUP_TIMEOUT_MS`；`FakeTransport`（测试 fixture，P2 起复用）。

- [x] **Step 1: 写传输适配器**

```ts
/**
 * LSP 传输层 —— 私有 stdio 子进程 (Bun.spawn)。
 *
 * v1 只保留私有进程模式;LspTransport 是传输无关的字节流契约,
 * broker 共享 mux(pi mux/daemon.ts)后续实现同一接口即可接入,上层零改动。
 */
import type { LspProcessSpawner, LspTransport } from "./types.ts";

export const WARMUP_TIMEOUT_MS = 5_000;

const STDERR_TAIL_BYTES = 64 * 1024;

export function bunSpawnTransport(command: string, args: string[], cwd: string): LspTransport {
	const proc = Bun.spawn([command, ...args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stderrTail = "";
	// 持续消费 stderr 防止管道阻塞;只保留尾部 64KB 用于崩溃报告。
	void (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			stderrTail = (stderrTail + decoder.decode(value)).slice(-STDERR_TAIL_BYTES);
		}
	})();
	return {
		// Bun.spawn 的 FileSink/ReadableStream 结构上满足 LspWriteSink/LspTransport。
		// 断言集中在本适配器,避免 Bun 类型泄漏进协议层。
		stdin: proc.stdin as unknown as LspTransport["stdin"],
		stdout: proc.stdout as unknown as ReadableStream<Uint8Array>,
		exited: proc.exited,
		exitCode: proc.exitCode,
		pid: proc.pid,
		kill: () => { proc.kill(); },
		peekStderr: () => stderrTail,
	};
}

/** 默认本地 spawner(测试/无会话场景)。生产由 P6 governed spawner 替换。 */
export function localLspSpawner(): LspProcessSpawner {
	return { spawn: (command, args, cwd) => bunSpawnTransport(command, args, cwd) };
}
```

- [x] **Step 2: 写假传输 fixture**

```ts
/**
 * 测试用脚本化 LspTransport:stdin 写出即记录帧文本,
 * 测试经 emitResponse / emitNotification 注入服务端消息。
 */
import type { LspJsonRpcNotification, LspJsonRpcRequest, LspJsonRpcResponse, LspTransport, LspWriteSink } from "../../src/lsp/types.ts";

const encoder = new TextEncoder();

export class FakeTransport implements LspTransport {
	readonly sent: string[] = [];
	readonly stdin: LspWriteSink;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	exitCode: number | null = null;
	pid = 42;
	private killed = false;
	private streamController!: ReadableStreamDefaultController<Uint8Array>;
	private stderrTail = "";
	private readonly decoder = new TextDecoder();

	constructor() {
		this.stdout = new ReadableStream<Uint8Array>({
			start: (controller) => { this.streamController = controller; },
		});
		this.stdin = {
			write: (data) => {
				this.sent.push(typeof data === "string" ? data : this.decoder.decode(data));
				return typeof data === "string" ? data.length : data.length;
			},
			flush: () => 0,
		};
		let resolveExit!: (code: number) => void;
		this.exited = new Promise<number>((resolve) => { resolveExit = resolve; });
		this.emitExit = (code: number) => { this.exitCode = code; resolveExit(code); };
	}
	readonly emitExit: (code: number) => void;

	emitResponse(id: number | string, result: unknown): void {
		this.pushFrame({ jsonrpc: "2.0", id, result });
	}

	emitRequest(method: string, params: unknown, id: number | string): void {
		this.pushFrame({ jsonrpc: "2.0", id, method, params });
	}

	emitNotification(method: string, params: unknown): void {
		this.pushFrame({ jsonrpc: "2.0", method, params });
	}

	/** 已发送帧中匹配 method 的请求参数(测试断言)。 */
	lastRequest(method: string): LspJsonRpcRequest | undefined {
		for (let i = this.sent.length - 1; i >= 0; i -= 1) {
			const message = JSON.parse(this.sent[i]) as LspJsonRpcRequest | LspJsonRpcNotification;
			if ("method" in message && message.method === method) return message as LspJsonRpcRequest;
		}
		return undefined;
	}

	kill(): void { this.killed = true; }

	isKilled(): boolean { return this.killed; }

	peekStderr(): string { return this.stderrTail; }

	appendStderr(text: string): void { this.stderrTail += text; }

	private pushFrame(message: unknown): void {
		const body = JSON.stringify(message);
		const frame = `Content-Length: ${encoder.encode(body).length}\r\n\r\n${body}`;
		this.streamController.enqueue(encoder.encode(frame));
	}
}
```

- [x] **Step 3: 写测试**

```ts
import { describe, expect, it } from "vitest";
import { localLspSpawner } from "../../src/lsp/transport.ts";
import { FakeTransport } from "./fake-transport.ts";

describe("localLspSpawner", () => {
	it("返回的 spawn 委托 Bun.spawn(真实 spawn 由 P7 smoke 覆盖)", () => {
		const spawner = localLspSpawner();
		expect(typeof spawner.spawn).toBe("function");
	});
});

describe("FakeTransport", () => {
	it("stdin 写出即记录帧文本,供测试断言出站协议", () => {
		const transport = new FakeTransport();
		void transport.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
		expect(transport.sent).toEqual(['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}']);
	});

	it("emitNotification 经 stdout 流送达,帧头 Content-Length 正确", async () => {
		const transport = new FakeTransport();
		transport.emitNotification("textDocument/publishDiagnostics", { uri: "file:///a.ts", diagnostics: [] });
		const reader = transport.stdout.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toContain("Content-Length: ");
		expect(text).toContain("textDocument/publishDiagnostics");
	});
});
```

- [x] **Step 4: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/transport.test.ts`
Expected: 2 passed。

- [ ] **Step 5: 提交**

```bash
git add -- src/lsp/transport.ts tests/lsp/fake-transport.ts tests/lsp/transport.test.ts
git commit -m "lsp: 增加私有 stdio 传输适配器与测试假传输"
```

---

### P1-1: 内建服务表（`src/lsp/defaults.json`）

**Files:**
- Create: `src/lsp/defaults.json`

**Interfaces:**
- Produces: 内建服务表（P1-2 经 `import defaults from "./defaults.json" with { type: "json" }` 消费）。字段与 `ServerConfig` 一一对应；每个服务含 `command`/`fileTypes`/`rootMarkers`，可含 `args`/`initOptions`/`settings`/`isLinter`/`capabilities`/`warmupTimeoutMs`。

- [x] **Step 1: 写内建表（20 服务，字段值逐条取自 pi defaults.json，`hostInfo` 改 runledger）**

```json
{
	"rust-analyzer": {
		"command": "rust-analyzer",
		"args": [],
		"fileTypes": [".rs"],
		"rootMarkers": ["Cargo.toml", "rust-analyzer.toml"],
		"initOptions": {},
		"settings": { "rust-analyzer": { "checkOnSave": false } },
		"capabilities": { "flycheck": true, "ssr": true, "expandMacro": true, "runnables": true, "relatedTests": true }
	},
	"clangd": {
		"command": "clangd",
		"args": ["--background-index", "--clang-tidy", "--header-insertion=iwyu"],
		"fileTypes": [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".m", ".mm"],
		"rootMarkers": ["compile_commands.json", "CMakeLists.txt", ".clangd", ".clang-format", "Makefile"]
	},
	"gopls": {
		"command": "gopls",
		"args": ["serve"],
		"fileTypes": [".go", ".mod", ".sum"],
		"rootMarkers": ["go.mod", "go.work", "go.sum"],
		"settings": { "gopls": { "analyses": { "unusedparams": true, "shadow": true }, "staticcheck": true, "gofumpt": true } }
	},
	"typescript-language-server": {
		"command": "typescript-language-server",
		"args": ["--stdio"],
		"fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		"rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"],
		"initOptions": {
			"hostInfo": "runledger-coding-agent",
			"preferences": {
				"includeInlayParameterNameHints": "all",
				"includeInlayVariableTypeHints": true,
				"includeInlayFunctionParameterTypeHints": true
			}
		}
	},
	"biome": {
		"command": "biome",
		"args": ["lsp-proxy"],
		"fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
		"rootMarkers": ["biome.json", "biome.jsonc"],
		"isLinter": true
	},
	"eslint": {
		"command": "vscode-eslint-language-server",
		"args": ["--stdio"],
		"fileTypes": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"],
		"rootMarkers": [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yml", "eslint.config.js", "eslint.config.mjs"],
		"isLinter": true,
		"settings": { "validate": "on", "run": "onType" }
	},
	"denols": {
		"command": "deno",
		"args": ["lsp"],
		"fileTypes": [".ts", ".tsx", ".js", ".jsx"],
		"rootMarkers": ["deno.json", "deno.jsonc", "deno.lock"],
		"initOptions": { "enable": true, "lint": true, "unstable": true }
	},
	"vscode-html-language-server": {
		"command": "vscode-html-language-server",
		"args": ["--stdio"],
		"fileTypes": [".html", ".htm"],
		"rootMarkers": ["package.json", ".git"],
		"initOptions": { "provideFormatter": true }
	},
	"vscode-css-language-server": {
		"command": "vscode-css-language-server",
		"args": ["--stdio"],
		"fileTypes": [".css", ".scss", ".sass", ".less"],
		"rootMarkers": ["package.json", ".git"],
		"initOptions": { "provideFormatter": true }
	},
	"vscode-json-language-server": {
		"command": "vscode-json-language-server",
		"args": ["--stdio"],
		"fileTypes": [".json", ".jsonc"],
		"rootMarkers": ["package.json", ".git"],
		"initOptions": { "provideFormatter": true }
	},
	"tailwindcss": {
		"command": "tailwindcss-language-server",
		"args": ["--stdio"],
		"fileTypes": [".html", ".css", ".scss", ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte"],
		"rootMarkers": ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"]
	},
	"svelte": {
		"command": "svelteserver",
		"args": ["--stdio"],
		"fileTypes": [".svelte"],
		"rootMarkers": ["svelte.config.js", "svelte.config.mjs", "package.json"]
	},
	"vue-language-server": {
		"command": "vue-language-server",
		"args": ["--stdio"],
		"fileTypes": [".vue"],
		"rootMarkers": ["vue.config.js", "nuxt.config.js", "nuxt.config.ts", "package.json"]
	},
	"astro": {
		"command": "astro-ls",
		"args": ["--stdio"],
		"fileTypes": [".astro"],
		"rootMarkers": ["astro.config.mjs", "astro.config.js", "astro.config.ts"]
	},
	"pyright": {
		"command": "pyright-langserver",
		"args": ["--stdio"],
		"fileTypes": [".py", ".pyi"],
		"rootMarkers": ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
		"settings": { "python": { "analysis": { "autoSearchPaths": true, "diagnosticMode": "openFilesOnly", "useLibraryCodeForTypes": true } } }
	},
	"pylsp": {
		"command": "pylsp",
		"args": [],
		"fileTypes": [".py"],
		"rootMarkers": ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"]
	},
	"ruff": {
		"command": "ruff",
		"args": ["server"],
		"fileTypes": [".py", ".pyi"],
		"rootMarkers": ["pyproject.toml", "ruff.toml", ".ruff.toml"],
		"isLinter": true
	},
	"bashls": {
		"command": "bash-language-server",
		"args": ["start"],
		"fileTypes": [".sh", ".bash", ".zsh"],
		"rootMarkers": [".git"],
		"settings": { "bashIde": { "globPattern": "*@(.sh|.inc|.bash|.command)" } }
	},
	"yamlls": {
		"command": "yaml-language-server",
		"args": ["--stdio"],
		"fileTypes": [".yaml", ".yml"],
		"rootMarkers": [".git"],
		"settings": {
			"yaml": { "validate": true, "format": { "enable": true }, "hover": true, "completion": true },
			"redhat": { "telemetry": { "enabled": false } }
		}
	},
	"marksman": {
		"command": "marksman",
		"args": ["server"],
		"fileTypes": [".md", ".markdown"],
		"rootMarkers": [".marksman.toml", ".git"],
		"warmupTimeoutMs": 2000
	}
}
```

- [x] **Step 2: 校验 JSON 可解析且 key 合法**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && node -e "JSON.parse(require('node:fs').readFileSync('src/lsp/defaults.json','utf8')); console.log('ok')"`
Expected: `ok`。

- [ ] **Step 3: 提交**

```bash
git add -- src/lsp/defaults.json
git commit -m "lsp: 内建 20 服务 defaults 表(取自 pi defaults.json)"
```

---

### P1-2: 配置加载与路由（`src/lsp/config.ts`）

**Files:**
- Create: `src/lsp/config.ts`
- Test: `tests/lsp/config.test.ts`

**Interfaces:**
- Consumes: `ServerConfig`、`LspConfig`（P0-1）、`defaults.json`（P1-1）。
- Produces: `loadConfig(cwd, options?: LspConfigLoadOptions): LspConfig`、`hasRootMarkers(cwd, markers)`、`resolveCommand(command, cwd)`、`getServersForFile(config, filePath)`、`getServerForFile(config, filePath)`、`hasCapability(config, name)`。P5 在此追加 `createClient` 注入。

- [x] **Step 1: 写配置模块**

```ts
/**
 * LSP 配置层 —— 从 pi coding-agent `src/lsp/config.ts` 适配。
 *
 * v1 权威裁剪:
 *   - 只读 `<cwd>/lsp.json` 与 `<cwd>/.lsp.json`(JSON only),无 YAML/用户级/插件级;
 *   - 覆盖为浅合并:同名服务的高层字段整体替换(settings/initOptions 替换而非深合并);
 *   - 自动探测:至少一个配置源贡献了服务映射时才跳过;否则按 rootMarkers + 二进制解析
 *     从 defaults 筛选;合并结果再筛 rootMarkers、二进制与 disabled。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import defaults from "./defaults.json" with { type: "json" };
import type { ServerCapabilities, ServerConfig, LspConfig } from "./types.ts";

export interface LspConfigLoadOptions {
	/** 测试注入:返回文件文本;缺省读 node:fs。 */
	readFile?: (filePath: string) => string | null;
}

const REQUIRED_FIELDS = ["command", "fileTypes", "rootMarkers"] as const;

/** 项目本地 bin 目录(优先于 $PATH),与 pi LOCAL_BIN_PATHS 对齐。 */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	{ markers: ["package.json"], binDir: "node_modules/.bin" },
	{ markers: ["pyproject.toml", "requirements.txt"], binDir: ".venv/bin" },
	{ markers: ["pyproject.toml", "requirements.txt"], binDir: "venv/bin" },
	{ markers: ["go.mod"], binDir: "bin" },
];

interface NormalizedConfig {
	servers: Record<string, ServerConfig>;
}

export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	return markers.some((marker) => {
		if (marker.startsWith("*.")) {
			const suffix = marker.slice(1);
			const entries = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
			return entries.some((entry) => entry.endsWith(suffix));
		}
		return fs.existsSync(path.join(cwd, marker));
	});
}

export function resolveCommand(command: string, cwd: string): string | null {
	if (command.includes(path.sep) && fs.existsSync(command)) return path.resolve(command);
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;
		const candidate = path.join(cwd, binDir, command);
		if (fs.existsSync(candidate)) return candidate;
	}
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
	for (const dir of pathDirs) {
		const candidate = path.join(dir, command);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** 归一化单个服务定义;新服务缺必需字段返回 null(调用方丢弃并告警)。 */
function normalizeServerConfig(name: string, raw: Record<string, unknown>): ServerConfig | null {
	const command = typeof raw.command === "string" ? raw.command : "";
	const fileTypes = toStringArray(raw.fileTypes);
	const rootMarkers = toStringArray(raw.rootMarkers);
	if (!command || !fileTypes || !rootMarkers) {
		console.warn(`Ignoring invalid LSP server config (missing required fields). { name: ${name} }`);
		return null;
	}
	const config: ServerConfig = { command, fileTypes, rootMarkers };
	if (Array.isArray(raw.args)) config.args = raw.args as string[];
	if (typeof raw.languageId === "string") config.languageId = raw.languageId;
	if (isRecord(raw.initOptions)) config.initOptions = raw.initOptions;
	if (isRecord(raw.settings)) config.settings = raw.settings;
	if (typeof raw.disabled === "boolean") config.disabled = raw.disabled;
	if (typeof raw.warmupTimeoutMs === "number") config.warmupTimeoutMs = raw.warmupTimeoutMs;
	if (typeof raw.isLinter === "boolean") config.isLinter = raw.isLinter;
	if (isRecord(raw.capabilities)) config.capabilities = raw.capabilities as ServerCapabilities;
	if (isRecord(raw.workspaceReadyTimings)) config.workspaceReadyTimings = raw.workspaceReadyTimings as ServerConfig["workspaceReadyTimings"];
	return config;
}

function parseConfigContent(content: string): NormalizedConfig | null {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return null;
		const rawServers = isRecord(parsed.servers) ? parsed.servers : parsed;
		const servers: Record<string, ServerConfig> = {};
		for (const [name, raw] of Object.entries(rawServers)) {
			if (!isRecord(raw)) continue;
			const normalized = normalizeServerConfig(name, raw);
			if (normalized) servers[name] = normalized;
		}
		return { servers };
	} catch {
		return null;
	}
}

/** 浅合并:override 的字段整体替换 base 同名字段。 */
function mergeServers(base: Record<string, ServerConfig>, overrides: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, override] of Object.entries(overrides)) {
		merged[name] = { ...merged[name], ...override };
	}
	return merged;
}

function readConfigFiles(cwd: string, readFile: (filePath: string) => string | null): NormalizedConfig[] {
	const configs: NormalizedConfig[] = [];
	// lsp.json 优先于 .lsp.json(pi 同款变体优先级)。
	for (const fileName of ["lsp.json", ".lsp.json"]) {
		const content = readFile(path.join(cwd, fileName));
		if (content !== null) {
			const parsed = parseConfigContent(content);
			if (parsed) configs.push(parsed);
		}
	}
	return configs;
}

export function loadConfig(cwd: string, options: LspConfigLoadOptions = {}): LspConfig {
	const readFile = options.readFile ?? ((filePath: string) => {
		try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
	});
	const overrides = readConfigFiles(cwd, readFile);
	let servers: Record<string, ServerConfig> = { ...(defaults as Record<string, ServerConfig>) };
	if (overrides.length > 0) {
		for (const override of overrides) servers = mergeServers(servers, override.servers);
	}
	// 最终筛选:rootMarkers 匹配 + 二进制解析 + 未禁用。
	const filtered: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		if (config.disabled === true) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (resolved === null) continue;
		filtered[name] = { ...config, resolvedCommand: resolved };
	}
	return { servers: filtered };
}

/** 按扩展名/精确 basename 匹配;主服务排在 linter 之前(pi 同款排序)。 */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const basename = path.basename(filePath);
	const matches: Array<[string, ServerConfig]> = [];
	for (const [name, server] of Object.entries(config.servers)) {
		if (server.fileTypes.includes(path.extname(filePath)) || server.fileTypes.includes(basename)) {
			matches.push([name, server]);
		}
	}
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter === true ? 1 : 0;
		const bIsLinter = b[1].isLinter === true ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	return getServersForFile(config, filePath)[0] ?? null;
}

export function hasCapability(config: ServerConfig, capability: keyof NonNullable<ServerConfig["capabilities"]>): boolean {
	return config.capabilities?.[capability] === true;
}
```

- [x] **Step 2: 写测试（真实 tmp 目录 + 注入 readFile 两种形态）**

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getServerForFile, getServersForFile, hasRootMarkers, loadConfig } from "../../src/lsp/config.ts";

function makeProject(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lsp-config-"));
	writeFileSync(path.join(dir, "package.json"), "{}");
	mkdirSync(path.join(dir, "node_modules/.bin"), { recursive: true });
	writeFileSync(path.join(dir, "node_modules/.bin/typescript-language-server"), "");
	return dir;
}

const made: string[] = [];
function project(): string { const dir = makeProject(); made.push(dir); return dir; }
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("loadConfig", () => {
	it("自动探测:package.json + 本地 bin 命中 typescript-language-server", () => {
		const cwd = project();
		const config = loadConfig(cwd);
		expect(config.servers["typescript-language-server"]).toBeDefined();
		expect(config.servers["typescript-language-server"]?.resolvedCommand).toContain("node_modules/.bin");
		expect(config.servers["gopls"]).toBeUndefined();
	});

	it("lsp.json 覆盖内建字段且保留未覆盖字段", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { "typescript-language-server": { args: ["--stdio", "--log-level", "4"] } },
		}));
		const config = loadConfig(cwd);
		const server = config.servers["typescript-language-server"];
		expect(server?.args).toEqual(["--stdio", "--log-level", "4"]);
		expect(server?.fileTypes).toContain(".ts");
	});

	it("新服务要求三字段齐全,缺失被忽略", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { broken: { command: "broken-lsp" } },
		}));
		const config = loadConfig(cwd);
		expect(config.servers["broken"]).toBeUndefined();
		expect(config.servers["typescript-language-server"]).toBeDefined();
	});

	it("disabled 覆盖后不进入结果", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "lsp.json"), JSON.stringify({
			servers: { "typescript-language-server": { disabled: true } },
		}));
		const config = loadConfig(cwd);
		expect(config.servers["typescript-language-server"]).toBeUndefined();
	});

	it("读取失败(注入 readFile 返回 null)时静默忽略该源", () => {
		const cwd = project();
		const config = loadConfig(cwd, { readFile: () => null });
		expect(config.servers["typescript-language-server"]).toBeDefined();
	});
});

describe("hasRootMarkers", () => {
	it("通配 marker 只匹配直接子项", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "Cargo.toml"), "");
		expect(hasRootMarkers(cwd, ["*.toml"])).toBe(true);
		expect(hasRootMarkers(cwd, ["go.mod"])).toBe(false);
	});
});

describe("getServersForFile", () => {
	it("扩展名路由,主服务排在 linter 前", () => {
		const cwd = project();
		writeFileSync(path.join(cwd, "biome.json"), "{}");
		const config = loadConfig(cwd);
		const servers = getServersForFile(config, "src/a.ts");
		expect(servers.map(([name]) => name)[0]).toBe("typescript-language-server");
		expect(servers.map(([name]) => name)).toContain("biome");
		expect(getServerForFile(config, "src/a.ts")?.[0]).toBe("typescript-language-server");
	});
});
```

- [x] **Step 3: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/config.test.ts`
Expected: 8 passed。

- [x] **Step 4: 门禁**

Run: `npm run check`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add -- src/lsp/config.ts tests/lsp/config.test.ts
git commit -m "lsp: 配置加载、浅合并、自动探测与文件路由"
```

---

### P2-1: 客户端生命周期（`src/lsp/client.ts`）

**Files:**
- Create: `src/lsp/client.ts`
- Test: `tests/lsp/client.test.ts`

**Interfaces:**
- Consumes: P0-1 类型、`FakeTransport`（P0-2）、`fileToUri`（本任务同时定义于 `src/lsp/utils.ts` 的 URI 部分，见 Step 1）。
- Produces: `getOrCreateClient(config, cwd, options?)`、`sendRequest`、`sendNotification`、`ensureFileOpen`、`refreshFile`、`waitForProjectLoaded`、`shutdownClient`、`shutdownAll`、`getActiveClients`、`CLIENT_CAPABILITIES`、`PROJECT_LOAD_TIMEOUT_MS`、`INIT_FAILURE_BACKOFF_MS`、`DEFAULT_REQUEST_TIMEOUT_MS`。

- [x] **Step 1: 写 utils.ts 的 URI 部分（其余函数 P3-1 补齐）**（按下方修正步骤落地）

```ts
/**
 * LSP 工具函数 —— URI 转换 / 语言 id 推断 / 符号列解析 / 偏移换算。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Position } from "./types.ts";

export function fileToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFilePath(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:") throw new Error(`Unsupported URI protocol: ${url.protocol}`);
	return decodeURIComponent(url.pathname);
}

/** 占位:detectLanguageId / resolveSymbolColumn / positionAt / offsetAt 在 P3-1 补齐。 */
export function detectLanguageId(_filePath: string): string {
	throw new Error("not implemented until P3-1");
}

export function resolveSymbolColumn(_filePath: string, _line: number, _symbol?: string): Position {
	throw new Error("not implemented until P3-1");
}

export function positionAt(_text: string, _offset: number): Position {
	throw new Error("not implemented until P3-1");
}

export function offsetAt(_text: string, _position: Position): number {
	throw new Error("not implemented until P3-1");
}

// 防 unused(占位阶段)
void fs;
```

Wait — 占位函数违反 "No Placeholders" 原则。改为：utils.ts 在本任务只创建 `fileToUri`/`uriToFilePath`，其余函数在 P3-1 追加。

- [x] **Step 1（修正）: 创建 utils.ts，只含 URI 转换**

```ts
/**
 * LSP 工具函数 —— URI 转换(其余函数按 P3-1 追加)。
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export function fileToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFilePath(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:") throw new Error(`Unsupported URI protocol: ${url.protocol}`);
	return decodeURIComponent(url.pathname);
}
```

- [x] **Step 2: 写客户端模块**

```ts
/**
 * LSP 客户端生命周期 —— 从 pi coding-agent `src/lsp/client.ts` 适配。
 *
 * v1 裁剪:无 lspmux/共享 mux/动态能力注册/idle 回收;
 * 保留 initialize 握手、Content-Length 帧读取、pending 路由、诊断缓存、
 * $/progress 项目加载、初始化失败负缓存与崩溃恢复。
 */
import * as path from "node:path";
import type {
	LspClient, LspJsonRpcNotification, LspJsonRpcRequest, LspJsonRpcResponse,
	LspProcessSpawner, LspServerCapabilities, PublishDiagnosticsParams,
	ServerConfig,
} from "./types.ts";
import { localLspSpawner, WARMUP_TIMEOUT_MS } from "./transport.ts";
import { fileToUri } from "./utils.ts";

export const PROJECT_LOAD_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const initFailures = new Map<string, { at: number; message: string }>();

export interface LspClientOptions {
	spawn?: LspProcessSpawner;
	initTimeoutMs?: number;
}

function clientKey(config: ServerConfig, cwd: string): string {
	return `${config.command}:${cwd}`;
}

/** 显式 reload 后允许立即重试同 key 的初始化失败。 */
export function clearInitializationFailure(config: ServerConfig, cwd: string): void {
	initFailures.delete(clientKey(config, cwd));
}

export const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: false },
		hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] } },
		rename: { dynamicRegistration: false, prepareSupport: true },
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
			resolveSupport: { properties: ["edit"] },
		},
		publishDiagnostics: { relatedInformation: true, versionSupport: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true, dataSupport: true },
	},
	window: { workDoneProgress: true },
	workspace: {
		applyEdit: true,
		workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"], failureHandling: "textOnlyTransactional" },
		configuration: true,
		workspaceFolders: true,
		symbol: { dynamicRegistration: false, symbolKind: { valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26] } },
		fileOperations: { dynamicRegistration: false, willRename: true, didRename: true, willDelete: false, didDelete: false, willCreate: false, didCreate: false },
	},
	experimental: { snippetTextEdit: true },
};

// ===== 帧解析 =====

const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const decoder = new TextDecoder();

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const merged = new Uint8Array(a.length + b.length);
	merged.set(a, 0);
	merged.set(b, a.length);
	return merged;
}

function extractFrames(buffer: Uint8Array): { frames: string[]; rest: Uint8Array } {
	const frames: string[] = [];
	let view = buffer;
	for (;;) {
		const headerEnd = indexOfSequence(view, HEADER_END);
		if (headerEnd === -1) return { frames, rest: view };
		const headerText = decoder.decode(view.subarray(0, headerEnd));
		const match = /^Content-Length: (\d+)$/m.exec(headerText);
		if (!match) throw new Error(`invalid LSP frame header: ${headerText}`);
		const bodyStart = headerEnd + 4;
		const contentLength = Number(match[1]);
		if (view.length < bodyStart + contentLength) return { frames, rest: view };
		frames.push(decoder.decode(view.subarray(bodyStart, bodyStart + contentLength)));
		view = view.subarray(bodyStart + contentLength);
	}
}

// ===== 写路径 =====

async function writeMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	const body = JSON.stringify(message);
	const frame = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
	const write = async () => {
		await client.proc.stdin.write(frame);
		await client.proc.stdin.flush();
	};
	client.writeQueue = client.writeQueue.then(write, write);
	if (signal) {
		// 出站写超时:服务端停止排水时,写队列本身不能永久悬挂调用方。
		await Promise.race([client.writeQueue, new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error("LSP write stalled")), DEFAULT_REQUEST_TIMEOUT_MS);
			signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")); }, { once: true });
			client.writeQueue.then(() => clearTimeout(timer), () => clearTimeout(timer));
		})]);
	} else {
		await client.writeQueue;
	}
}

// ===== 读路径 =====

async function handleMessage(client: LspClient, message: LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification): Promise<void> {
	if ("id" in message && "method" in message) {
		// 服务端反向请求:v1 只支持 workspace/configuration 与 workspace/applyEdit。
		await handleServerRequest(client, message);
		return;
	}
	if ("id" in message) {
		const pending = client.pendingRequests.get(message.id);
		if (!pending) return;
		client.pendingRequests.delete(message.id);
		if (message.error) pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
		else pending.resolve(message.result);
		return;
	}
	const notification = message as LspJsonRpcNotification;
	if (notification.method === "textDocument/publishDiagnostics") {
		const params = notification.params as PublishDiagnosticsParams;
		client.diagnostics.set(params.uri, params);
		client.diagnosticsVersion += 1;
	} else if (notification.method === "$/progress") {
		const params = notification.params as { token: string | number };
		client.resolveProjectLoaded();
	} else if (notification.method === "window/workDoneProgress/create") {
		// 无需应答的服务端通知。
	} else if (notification.method === "workspace/didChangeConfiguration") {
		// 出站方向,不会进入读路径。
	}
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await writeMessage(client, { jsonrpc: "2.0", id: message.id, result: client.config.settings ?? {} });
	} else if (message.method === "workspace/workspaceFolders") {
		await writeMessage(client, { jsonrpc: "2.0", id: message.id, result: [{ uri: fileToUri(client.cwd), name: path.basename(client.cwd) || "workspace" }] });
	} else {
		await writeMessage(client, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not handled: ${message.method}` } });
	}
}

async function startMessageReader(client: LspClient): Promise<void> {
	const reader = client.proc.stdout.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		const { frames, rest } = extractFrames(concatBytes(client.messageBuffer, value));
		client.messageBuffer = rest;
		for (const frame of frames) {
			await handleMessage(client, JSON.parse(frame) as LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification);
		}
	}
}

// ===== 生命周期 =====

export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	options: LspClientOptions = {},
	signal?: AbortSignal,
): Promise<LspClient> {
	const key = clientKey(config, cwd);
	const existing = clients.get(key);
	if (existing) {
		existing.lastActivity = Date.now();
		return existing;
	}
	const existingLock = clientLocks.get(key);
	if (existingLock) return existingLock;

	const recentFailure = initFailures.get(key);
	if (recentFailure) {
		if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
			throw new Error(`LSP server ${config.command} failed to initialize recently: ${recentFailure.message}`);
		}
		initFailures.delete(key);
	}

	const spawner = options.spawn ?? localLspSpawner();
	const initTimeoutMs = options.initTimeoutMs ?? config.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS;

	const clientPromise = (async () => {
		const proc = await spawner.spawn(config.resolvedCommand ?? config.command, config.args ?? [], cwd, signal);

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>((resolve) => { resolveProjectLoaded = resolve; });
		const loadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => { clearTimeout(loadTimeout); originalResolve(); };

		const client: LspClient = {
			name: key,
			cwd,
			config,
			proc,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(0),
			status: "connecting",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			projectLoaded,
			resolveProjectLoaded,
		};

		void proc.exited.then((code) => {
			if (clients.get(key) === client) clients.delete(key);
			if (clientLocks.get(key) === clientPromise) clientLocks.delete(key);
			client.resolveProjectLoaded();
			if (client.pendingRequests.size > 0) {
				const stderr = proc.peekStderr().trim();
				const error = new Error(stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`);
				for (const pending of client.pendingRequests.values()) pending.reject(error);
				client.pendingRequests.clear();
			}
		});

		void startMessageReader(client);

		try {
			const initResult = (await sendRequest(client, "initialize", {
				processId: process.pid,
				rootUri: fileToUri(cwd),
				rootPath: cwd,
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: config.initOptions ?? {},
				workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) || "workspace" }],
			}, signal, initTimeoutMs)) as { capabilities?: unknown };
			if (!initResult) throw new Error("Failed to initialize LSP: no response");
			client.serverCapabilities = initResult.capabilities as LspServerCapabilities;
			await sendNotification(client, "initialized", {}, signal);
			await sendNotification(client, "workspace/didChangeConfiguration", { settings: config.settings ?? {} }, signal);
			client.status = "ready";
			clients.set(key, client);
			initFailures.delete(key);
			return client;
		} catch (error) {
			client.status = "error";
			if (clients.get(key) === client) clients.delete(key);
			proc.kill();
			const message = error instanceof Error ? error.message : String(error);
			// 超时/调用方取消属瞬时失败,不进负缓存;确定性失败负缓存 3 分钟。
			const transient = signal?.aborted || message.includes("timed out");
			if (!transient) initFailures.set(key, { at: Date.now(), message });
			throw error;
		} finally {
			clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	client.requestId += 1;
	const id = client.requestId;
	const timeout = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeout);
	const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	return new Promise<unknown>((resolve, reject) => {
		const onAbort = () => {
			client.pendingRequests.delete(id);
			reject(new Error(`LSP request ${method} timed out after ${timeout}ms`));
			// 尽力通知服务端取消,不等待应答。
			void writeMessage(client, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }, signal).catch(() => undefined);
		};
		combined.addEventListener("abort", onAbort, { once: true });
		client.pendingRequests.set(id, {
			resolve: (result) => { combined.removeEventListener("abort", onAbort); resolve(result); },
			reject: (error) => { combined.removeEventListener("abort", onAbort); reject(error); },
			method,
		});
		void writeMessage(client, { jsonrpc: "2.0", id, method, params }, signal).catch((error) => {
			client.pendingRequests.delete(id);
			reject(error);
		});
	});
}

export async function sendNotification(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<void> {
	await writeMessage(client, { jsonrpc: "2.0", method, params }, signal);
}

export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	if (client.openFiles.has(uri)) return;
	// 语言 id 推断由 P3-1 的 detectLanguageId 提供;v1 用扩展名小写作为最小实现。
	const languageId = client.config.languageId ?? languageIdFromExt(filePath);
	await sendNotification(client, "textDocument/didOpen", {
		textDocument: { uri, languageId, version: 1, text: readFileText(filePath) },
	}, signal);
	client.openFiles.set(uri, { version: 1, languageId });
	client.lastActivity = Date.now();
}

export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const open = client.openFiles.get(uri);
	const version = (open?.version ?? 0) + 1;
	await sendNotification(client, "textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: readFileText(filePath) }],
	}, signal);
	await sendNotification(client, "textDocument/didSave", { textDocument: { uri } }, signal);
	client.openFiles.set(uri, { version, languageId: open?.languageId ?? client.config.languageId ?? languageIdFromExt(filePath) });
}

export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal) {
		await Promise.race([client.projectLoaded, new Promise<void>((_, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
		})]);
	} else {
		await client.projectLoaded;
	}
}

export async function shutdownClient(key: string): Promise<boolean> {
	const client = clients.get(key);
	if (!client) return false;
	clients.delete(key);
	client.status = "error";
	try {
		await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS);
		await sendNotification(client, "exit", null);
	} catch {
		// 服务端已死或超时:直接杀进程。
	}
	client.proc.kill();
	return true;
}

export async function shutdownAll(): Promise<void> {
	await Promise.allSettled([...clients.keys()].map((key) => shutdownClient(key)));
}

export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
}

export function getActiveClients(): LspServerStatus[] {
	return [...clients.values()].map((client) => ({ name: client.name, status: client.status }));
}

// ===== 小工具 =====

function readFileText(filePath: string): string {
	const fs = require("node:fs") as typeof import("node:fs");
	return fs.readFileSync(filePath, "utf8");
}

function languageIdFromExt(filePath: string): string {
	const map: Record<string, string> = {
		".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
		".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".jsonc": "jsonc",
		".py": "python", ".pyi": "python", ".rs": "rust", ".go": "go",
		".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp",
		".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".vue": "vue", ".svelte": "svelte",
		".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".markdown": "markdown",
		".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript",
	};
	return map[path.extname(filePath)] ?? "plaintext";
}
```

注意：本任务使用 `readFileSync`（client 内部读文件只读直读，不进治理接缝）；`require` 是 CJS 互操作，在 NodeNext ESM 下可用但风格不佳——改为顶层 `import * as fs from "node:fs"` 并在 Step 2 修正。

- [x] **Step 2: 修正导入（把 `readFileText` 里的 `require` 换成顶层导入）**

```ts
import * as fs from "node:fs";

function readFileText(filePath: string): string {
	return fs.readFileSync(filePath, "utf8");
}
```

- [x] **Step 3: 写测试（FakeTransport 脚本化 initialize → request 往返）**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getOrCreateClient, sendRequest, shutdownAll } from "../../src/lsp/client.ts";
import type { ServerConfig } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const config: ServerConfig = {
	command: "fake-lsp",
	fileTypes: [".ts"],
	rootMarkers: ["package.json"],
};

const made: string[] = [];
function project(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "lsp-client-"));
	made.push(dir);
	return dir;
}
afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeSpawner(transport: FakeTransport) {
	return {
		spawn: async () => transport,
	};
}

describe("getOrCreateClient", () => {
	it("完成 initialize 握手后 status=ready,并推送 settings", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		// 脚本化:应答 initialize。
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initRequest = transport.lastRequest("initialize");
		expect(initRequest).toBeDefined();
		transport.emitResponse(initRequest!.id, { capabilities: { hoverProvider: true } });
		const client = await clientPromise;
		expect(client.status).toBe("ready");
		expect(client.serverCapabilities?.hoverProvider).toBe(true);
		expect(transport.sent.some((frame) => frame.includes("workspace/didChangeConfiguration"))).toBe(true);
	});

	it("并发创建同一 key 只 spawn 一次", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		let spawns = 0;
		const spawner = { spawn: async () => { spawns += 1; return transport; } };
		const first = getOrCreateClient(config, cwd, { spawn: spawner });
		const second = getOrCreateClient(config, cwd, { spawn: spawner });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const initRequest = transport.lastRequest("initialize");
		transport.emitResponse(initRequest!.id, { capabilities: {} });
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(spawns).toBe(1);
	});

	it("initialize 失败负缓存:第二次调用快速失败", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const init = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport), initTimeoutMs: 200 });
		transport.emitExit(1);
		await expect(init).rejects.toThrow();
		const retry = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport), initTimeoutMs: 200 });
		await expect(retry).rejects.toThrow(/failed to initialize recently/);
	});

	it("服务端退出 reject 所有 pending 请求", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		const pending = sendRequest(client, "textDocument/hover", {});
		transport.emitExit(9);
		await expect(pending).rejects.toThrow(/exited/);
	});

	it("publishDiagnostics 通知进入诊断缓存", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const clientPromise = getOrCreateClient(config, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		transport.emitNotification("textDocument/publishDiagnostics", { uri: "file:///a.ts", diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "bad" }] });
		expect(client.diagnostics.get("file:///a.ts")?.diagnostics[0]?.message).toBe("bad");
	});
});
```

- [x] **Step 4: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/client.test.ts`
Expected: 5 passed。

- [x] **Step 5: 门禁**

Run: `npm run check`
Expected: 全绿。若 `FakeTransport` 的 `emitExit` 赋值写法触发 lint（readonly 属性在构造器外赋值），改为构造器内 `this.emitExit = ...` 直接定义非 readonly 字段。

- [ ] **Step 6: 提交**

```bash
git add -- src/lsp/utils.ts src/lsp/client.ts tests/lsp/client.test.ts
git commit -m "lsp: 客户端生命周期与 JSON-RPC 帧协议"
```

---

### P3-1: 工具函数（`src/lsp/utils.ts` 补齐）

**Files:**
- Modify: `src/lsp/utils.ts`
- Test: `tests/lsp/utils.test.ts`

**Interfaces:**
- Produces: `detectLanguageId(filePath)`、`resolveSymbolColumn(filePath, line, symbol?)`（精确 → 忽略大小写 → `#N` 选择器；找不到 throw）、`positionAt(text, offset)`、`offsetAt(text, position)`（行号 0 起始，UTF-16 码元计数，与 LSP 一致）。

- [x] **Step 1: 追加实现（替换 P2-1 文件内容）**

```ts
/**
 * LSP 工具函数 —— URI 转换 / 语言 id 推断 / 符号列解析 / 偏移换算。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Position } from "./types.ts";

export function fileToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFilePath(uri: string): string {
	const url = new URL(uri);
	if (url.protocol !== "file:") throw new Error(`Unsupported URI protocol: ${url.protocol}`);
	return decodeURIComponent(url.pathname);
}

const EXTENSION_LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact",
	".mjs": "javascript", ".cjs": "javascript", ".json": "json", ".jsonc": "jsonc",
	".py": "python", ".pyi": "python", ".rs": "rust", ".go": "go",
	".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cc": "cpp", ".m": "objective-c", ".mm": "objective-cpp",
	".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".less": "less",
	".vue": "vue", ".svelte": "svelte", ".astro": "astro",
	".yaml": "yaml", ".yml": "yaml", ".md": "markdown", ".markdown": "markdown",
	".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript",
};

export function detectLanguageId(filePath: string): string {
	return EXTENSION_LANGUAGE_IDS[path.extname(filePath)] ?? "plaintext";
}

/**
 * 解析 line(1 起始)上 symbol 的列位置。
 * 精确匹配 → 忽略大小写匹配 → `name#N` 出现次选择器(N 从 1 计)。
 * 只扫描目标行;找不到 throw(不静默回退首列)。
 */
export function resolveSymbolColumn(filePath: string, line: number, symbol?: string): Position {
	const text = fs.readFileSync(filePath, "utf8");
	const lines = text.split("\n");
	if (line < 1 || line > lines.length) throw new Error(`line ${line} out of range in ${filePath}`);
	const target = lines[line - 1];
	if (!target) throw new Error(`line ${line} out of range in ${filePath}`);
	if (!symbol) {
		const character = target.length - target.trimStart().length;
		return { line: line - 1, character };
	}
	const hashIndex = symbol.lastIndexOf("#");
	const base = hashIndex > 0 ? symbol.slice(0, hashIndex) : symbol;
	const occurrence = hashIndex > 0 ? Number(symbol.slice(hashIndex + 1)) : 1;
	if (!Number.isInteger(occurrence) || occurrence < 1) throw new Error(`invalid symbol occurrence selector: ${symbol}`);
	let seen = 0;
	let index = target.indexOf(base);
	while (index !== -1) {
		seen += 1;
		if (seen === occurrence) return { line: line - 1, character: index };
		index = target.indexOf(base, index + base.length);
	}
	// 精确匹配失败,忽略大小写重试一次。
	const lower = target.toLowerCase();
	const lowerBase = base.toLowerCase();
	let lowerIndex = lower.indexOf(lowerBase);
	let seenLower = 0;
	while (lowerIndex !== -1) {
		seenLower += 1;
		if (seenLower === occurrence) return { line: line - 1, character: lowerIndex };
		lowerIndex = lower.indexOf(lowerBase, lowerIndex + lowerBase.length);
	}
	throw new Error(`symbol "${base}" not found on line ${line} of ${filePath}`);
}

/** 文本偏移 → LSP 位置(0 起始行,UTF-16 码元列)。 */
export function positionAt(text: string, offset: number): Position {
	let line = 0;
	let character = 0;
	for (let i = 0; i < offset && i < text.length; i += 1) {
		if (text[i] === "\n") { line += 1; character = 0; } else { character += 1; }
	}
	return { line, character };
}

/** LSP 位置 → 文本偏移。 */
export function offsetAt(text: string, position: Position): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < position.line; i += 1) {
		offset += (lines[i]?.length ?? 0) + 1;
	}
	return offset + position.character;
}
```

- [x] **Step 2: client.ts 切换到 detectLanguageId**

`src/lsp/client.ts`:
- 导入改为 `import { detectLanguageId, fileToUri } from "./utils.ts";`
- `ensureFileOpen` 与 `refreshFile` 中两处 `languageIdFromExt(filePath)` 改为 `detectLanguageId(filePath)`;
- 删除文件尾部的 `languageIdFromExt` 函数(连同其 `path.extname` 映射表);
- 删除 `ensureFileOpen` 上方的过时注释(「v1 用扩展名小写作为最小实现」);
- Run: `npm run check`,全绿后继续。

- [x] **Step 3: 写测试**

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectLanguageId, fileToUri, offsetAt, positionAt, resolveSymbolColumn, uriToFilePath } from "../../src/lsp/utils.ts";

describe("fileToUri / uriToFilePath", () => {
	it("往返一致", () => {
		const uri = fileToUri("/tmp/a b.ts");
		expect(uri.startsWith("file://")).toBe(true);
		expect(uriToFilePath(uri)).toBe("/tmp/a b.ts");
	});

	it("非 file 协议抛错", () => {
		expect(() => uriToFilePath("http://x/a.ts")).toThrow(/Unsupported URI protocol/);
	});
});

describe("detectLanguageId", () => {
	it("常见扩展名", () => {
		expect(detectLanguageId("a.ts")).toBe("typescript");
		expect(detectLanguageId("a.tsx")).toBe("typescriptreact");
		expect(detectLanguageId("a.rs")).toBe("rust");
		expect(detectLanguageId("a.unknown")).toBe("plaintext");
	});
});

describe("resolveSymbolColumn", () => {
	const made: string[] = [];
	function file(content: string): string {
		const dir = mkdtempSync(path.join(tmpdir(), "lsp-utils-"));
		const filePath = path.join(dir, "a.ts");
		writeFileSync(filePath, content);
		made.push(dir);
		return filePath;
	}
	afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

	it("缺省 symbol 取首个非空白列", () => {
		expect(resolveSymbolColumn(file("  const a = 1;"), 1)).toEqual({ line: 0, character: 2 });
	});

	it("精确匹配", () => {
		expect(resolveSymbolColumn(file("const a = foo(1);"), 1, "foo")).toEqual({ line: 0, character: 10 });
	});

	it("忽略大小写回退", () => {
		expect(resolveSymbolColumn(file("const A = 1;"), 1, "a")).toEqual({ line: 0, character: 6 });
	});

	it("#N 选择器取第 N 次出现", () => {
		expect(resolveSymbolColumn(file("a(a, a);"), 1, "a#2")).toEqual({ line: 0, character: 5 });
	});

	it("找不到抛错", () => {
		expect(() => resolveSymbolColumn(file("const x = 1;"), 1, "nope")).toThrow(/not found/);
	});
});

describe("positionAt / offsetAt", () => {
	const text = "ab\ncd";
	it("互逆", () => {
		expect(positionAt(text, 3)).toEqual({ line: 1, character: 0 });
		expect(offsetAt(text, { line: 1, character: 0 })).toBe(3);
		expect(positionAt(text, offsetAt(text, { line: 1, character: 1 }))).toEqual({ line: 1, character: 1 });
	});
});
```

- [x] **Step 4: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/utils.test.ts`
Expected: 12 passed。

- [ ] **Step 5: 提交**

```bash
git add -- src/lsp/utils.ts tests/lsp/utils.test.ts
git commit -m "lsp: 语言 id 推断、符号列解析与偏移换算"
```

---

### P3-2: 只读 lsp 工具（`src/lsp/tool.ts` 第一部分）

**Files:**
- Create: `src/lsp/tool.ts`（只读动作；写动作分支在 P4-2 追加）
- Test: `tests/lsp/tool-read.test.ts`

**Interfaces:**
- Consumes: P0-1 schema、`loadConfig`/`getServersForFile`（P1-2）、`getOrCreateClient`/`sendRequest`/`ensureFileOpen`/`refreshFile`/`waitForProjectLoaded`（P2-1）、`utils.ts`（P3-1）。
- Produces: `createLspTool(cwd, options?: LspToolOptions): AgentTool`；`LspToolOptions { getConfig?, spawn?, writeOperations?, timeoutMs? }`（`writeOperations` 在 P4-1 定义后于 P4-2 使用）。动作 `diagnostics`/`definition`/`type_definition`/`implementation`/`references`/`hover`/`symbols`/`status`/`capabilities`。

- [x] **Step 1: 写工具模块（只读部分）**

```ts
/**
 * lsp 工具 —— 从 pi coding-agent `src/lsp/index.ts` 适配为 RunLedger AgentTool。
 *
 * 治理接缝:
 *   - spawn:注入 LspProcessSpawner(生产走 AttemptPort process_spawn,P6);
 *   - writeOperations:注入 LspWriteOperations(生产走 AttemptPort workspace_mutation,P4/P6);
 *   - 无静态 capability claim:v1 Plan Mode 下整体 fail-closed(P6 说明扩展路径)。
 */
import { Type } from "typebox";
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "../runtime/types.ts";
import type { ToolContext } from "../runtime/types.ts";
import {
	getServerForFile, getServersForFile, loadConfig,
} from "./config.ts";
import {
	ensureFileOpen, getActiveClients, getOrCreateClient, refreshFile, sendRequest,
	waitForProjectLoaded,
} from "./client.ts";
import type {
	Diagnostic, DocumentSymbol, Hover, LspClient, LspConfig, LspParams, LspProcessSpawner,
	LspToolDetails, LspWriteOperations, Position, Range, SymbolInformation,
} from "./types.ts";
import { lspSchema } from "./types.ts";
import { fileToUri, resolveSymbolColumn } from "./utils.ts";

export interface LspToolOptions {
	/** 测试注入:覆盖 loadConfig。 */
	getConfig?: (cwd: string) => LspConfig;
	/** 生产注入:governed spawner(P6)。缺省 localLspSpawner。 */
	spawn?: LspProcessSpawner;
	/** 生产注入:governed 写操作(P4-2 起使用,P6 接线)。 */
	writeOperations?: LspWriteOperations;
	/** 工具级超时(ms),默认 20_000,上限 300_000。 */
	timeoutMs?: number;
}

export const LSP_TOOL_DEFAULT_TIMEOUT_MS = 20_000;

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const WORKSPACE_SYMBOL_LIMIT = 200;
const SEVERITY_LABELS: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function configFor(cwd: string, options: LspToolOptions): LspConfig {
	return options.getConfig ? options.getConfig(cwd) : loadConfig(cwd);
}

async function clientForFile(
	cwd: string, filePath: string, config: LspConfig, options: LspToolOptions, signal?: AbortSignal,
): Promise<{ client: LspClient; serverName: string } | { error: string }> {
	const match = getServerForFile(config, filePath);
	if (!match) return { error: `No language server configured for ${filePath}` };
	const [serverName, serverConfig] = match;
	const client = await getOrCreateClient(serverConfig, cwd, {
		spawn: options.spawn,
	}, signal);
	return { client, serverName };
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
	if (diagnostics.length === 0) return "OK";
	const lines: string[] = [];
	for (const diagnostic of diagnostics.slice(0, DIAGNOSTIC_MESSAGE_LIMIT)) {
		const severity = SEVERITY_LABELS[diagnostic.severity ?? 1] ?? "unknown";
		lines.push(`${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} [${severity}] ${diagnostic.message}${diagnostic.code !== undefined ? ` (${String(diagnostic.code)})` : ""}`);
	}
	return lines.join("\n");
}

function formatRange(range: Range): string {
	return `${range.start.line + 1}:${range.start.character + 1}`;
}

function normalizeLocationResult(result: unknown): Array<{ uri: string; range: Range }> {
	const list = Array.isArray(result) ? result : [result];
	const locations: Array<{ uri: string; range: Range }> = [];
	for (const item of list) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (typeof record.uri === "string" && isRange(record.range)) {
			locations.push({ uri: record.uri, range: record.range });
		} else if (typeof record.targetUri === "string" && isRange(record.targetSelectionRange) && isRange(record.targetRange)) {
			locations.push({ uri: record.targetUri, range: record.targetSelectionRange });
		}
	}
	return locations;
}

function isRange(value: unknown): value is Range {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return isPosition(record.start) && isPosition(record.end);
}

function isPosition(value: unknown): value is Position {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.line === "number" && typeof record.character === "number";
}

function formatLocations(kind: string, locations: Array<{ uri: string; range: Range }>): string {
	if (locations.length === 0) return `No ${kind} found`;
	const lines = locations.map((location) => `${location.uri}${formatRange(location.range)}`);
	return `Found ${locations.length} ${kind}(s):\n${lines.join("\n")}`;
}

function extractHoverText(hover: Hover | null | undefined): string {
	if (!hover) return "No hover information";
	const contents = hover.contents;
	if (typeof contents === "string") return contents;
	const parts: string[] = [];
	const flatten = (value: unknown): void => {
		if (typeof value === "string") parts.push(value);
		else if (Array.isArray(value)) value.forEach(flatten);
		else if (value && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (typeof record.value === "string") parts.push(record.value);
			else if (typeof record.language === "string" && typeof record.value === "string") parts.push(record.value);
		}
	};
	flatten(contents);
	return parts.join("\n").trim() || "No hover information";
}

function formatDocumentSymbols(symbols: Array<DocumentSymbol | SymbolInformation>): string {
	const lines: string[] = [];
	const walk = (symbol: DocumentSymbol, depth: number): void => {
		lines.push(`${"  ".repeat(depth)}${symbol.name} @ ${formatRange(symbol.range)}`);
		for (const child of symbol.children ?? []) walk(child, depth + 1);
	};
	for (const symbol of symbols) {
		if (isDocumentSymbol(symbol)) walk(symbol, 0);
		else lines.push(`${symbol.name} @ ${formatRange(symbol.location.range)}`);
	}
	return lines.length === 0 ? "No symbols found" : `Symbols:\n${lines.join("\n")}`;
}

function isDocumentSymbol(symbol: DocumentSymbol | SymbolInformation): symbol is DocumentSymbol {
	return "range" in symbol && "selectionRange" in symbol;
}

async function runDiagnostics(
	cwd: string, filePath: string, config: LspConfig, options: LspToolOptions, signal?: AbortSignal,
): Promise<string> {
	const servers = getServersForFile(config, filePath);
	if (servers.length === 0) return `No language server configured for ${filePath}`;
	const results: string[] = [];
	for (const [serverName, serverConfig] of servers) {
		if (serverConfig.createClient) continue; // 自定义 linter 客户端 P5 接入
		const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
		await ensureFileOpen(client, filePath, signal);
		await waitForProjectLoaded(client, signal);
		await refreshFile(client, filePath, signal);
		const cached = client.diagnostics.get(fileToUri(filePath));
		const diagnostics = cached?.diagnostics ?? [];
		if (diagnostics.length === 0) continue;
		results.push(`${serverName}:\n${formatDiagnostics(diagnostics)}`);
	}
	return results.length === 0 ? "OK" : results.join("\n\n");
}

export function createLspTool(cwd: string, options: LspToolOptions = {}): AgentTool<typeof lspSchema, LspToolDetails> {
	const timeoutMs = options.timeoutMs ?? LSP_TOOL_DEFAULT_TIMEOUT_MS;
	return {
		name: "lsp",
		label: "lsp",
		description: "查询语言服务器:诊断、定义、引用、悬停、符号、状态与能力;写动作(rename/code_actions)经治理接缝执行。",
		parameters: lspSchema,
		// 工具内混合只读与写动作:保守声明非只读、串行、可破坏。
		isReadOnly: () => false,
		isConcurrencySafe: () => false,
		isDestructive: () => true,
		async execute(
			toolCallId: string,
			params: Static<typeof lspSchema>,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			context?: ToolContext,
		): Promise<AgentToolResult<LspToolDetails>> {
			void toolCallId;
			void context;
			const actionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
			const config = configFor(cwd, options);
			try {
				const text = await dispatchAction(cwd, params, config, options, actionSignal);
				return { content: [{ type: "text", text }], details: { action: params.action, success: true } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `LSP error: ${message}` }], details: { action: params.action, success: false } };
			}
		},
	};
}

async function dispatchAction(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	switch (params.action) {
		case "status":
			return formatStatus(config);
		case "capabilities":
			return formatCapabilities(cwd, config, options, params.file, signal);
		case "diagnostics":
			return runDiagnosticsForParams(cwd, params, config, options, signal);
		case "symbols":
			return runSymbols(cwd, params, config, options, signal);
		case "definition":
		case "type_definition":
		case "implementation":
		case "references":
			return runNavigation(cwd, params, config, options, signal);
		case "hover":
			return runHover(cwd, params, config, options, signal);
		case "rename":
		case "rename_file":
		case "code_actions":
		case "reload":
		case "request":
			throw new Error(`action "${params.action}" implemented in P4`);
	}
}

function requireFile(params: LspParams): string {
	if (!params.file) throw new Error("file parameter required");
	return params.file;
}

async function runDiagnosticsForParams(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	if (params.file === "*") throw new Error("workspace diagnostics not implemented (v1)");
	const filePath = path.resolve(cwd, requireFile(params));
	return runDiagnostics(cwd, filePath, config, options, signal);
}

async function runNavigation(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	const method = params.action === "definition" ? "textDocument/definition"
		: params.action === "type_definition" ? "textDocument/typeDefinition"
			: params.action === "implementation" ? "textDocument/implementation"
				: "textDocument/references";
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	await waitForProjectLoaded(client, signal);
	if (params.line !== undefined && params.symbol === undefined) {
		throw new Error(`symbol parameter required when line is given for ${params.action}`);
	}
	const position = params.line !== undefined ? resolveSymbolColumn(filePath, params.line, params.symbol) : undefined;
	const requestParams = method === "textDocument/references"
		? { textDocument: { uri: fileToUri(filePath) }, position, context: { includeDeclaration: true } }
		: { textDocument: { uri: fileToUri(filePath) }, position };
	const result = await sendRequest(client, method, requestParams, signal);
	if (method === "textDocument/references") {
		const locations = normalizeLocationResult(result);
		return formatLocations("reference", locations);
	}
	return formatLocations(params.action.replace("_", " "), normalizeLocationResult(result));
}

async function runHover(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	await waitForProjectLoaded(client, signal);
	const position = params.line !== undefined ? resolveSymbolColumn(filePath, params.line, params.symbol) : undefined;
	const hover = await sendRequest(client, "textDocument/hover", {
		textDocument: { uri: fileToUri(filePath) }, position,
	}, signal) as Hover | null | undefined;
	return extractHoverText(hover);
}

async function runSymbols(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	if (params.file === "*") {
		if (!params.query) throw new Error("query parameter required for workspace symbols");
		const lines: string[] = [];
		for (const serverConfig of Object.values(config.servers)) {
			if (serverConfig.createClient || serverConfig.isLinter === true) continue;
			const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
			const result = await sendRequest(client, "workspace/symbol", { query: params.query }, signal) as SymbolInformation[];
			for (const symbol of result.slice(0, WORKSPACE_SYMBOL_LIMIT)) {
				lines.push(`${symbol.name} @ ${symbol.location.uri}${formatRange(symbol.location.range)}`);
			}
		}
		return lines.length === 0 ? `No symbols found matching "${params.query}"` : `Found ${lines.length} symbol(s) matching "${params.query}":\n${lines.join("\n")}`;
	}
	const filePath = path.resolve(cwd, requireFile(params));
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	const result = await sendRequest(client, "textDocument/documentSymbol", {
		textDocument: { uri: fileToUri(filePath) },
	}, signal) as Array<DocumentSymbol | SymbolInformation>;
	return formatDocumentSymbols(result);
}

function formatStatus(config: LspConfig): string {
	if (Object.keys(config.servers).length === 0) return "No language servers configured for this project";
	const active = new Map(getActiveClients().map((client) => [client.name, client.status]));
	const lines = Object.entries(config.servers).map(([name, server]) => {
		const status = active.get(`${server.command}:${process.cwd()}`) ?? active.get(server.command);
		return `${name} (${status ?? "configured, not started"})`;
	});
	return `Language servers:\n${lines.join("\n")}`;
}

async function formatCapabilities(
	cwd: string, config: LspConfig, options: LspToolOptions, file: string | undefined, signal: AbortSignal,
): Promise<string> {
	const targets: Array<[string, LspConfig["servers"][string]]> = file !== undefined && file !== "*"
		? getServersForFile(config, file).filter(([, server]) => !server.createClient) as Array<[string, LspConfig["servers"][string]]>
		: Object.entries(config.servers).filter(([, server]) => !server.createClient);
	if (targets.length === 0) return "No language servers configured for this project";
	const lines: string[] = [];
	for (const [serverName, serverConfig] of targets) {
		const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
		lines.push(`${serverName}:\n  capabilities: ${JSON.stringify(client.serverCapabilities ?? {})}`);
	}
	return lines.join("\n");
}
```

注意：`formatStatus` 里的 `active.get(server.command)` 是错误回退——client name 是 `${command}:${cwd}` 形态，`formatStatus` 应直接用完整 key 匹配（Step 3 修正）。同时 `_onUpdate` 参数类型应为 `AgentToolUpdateCallback`。这两处在 Step 2 一并修正。

- [x] **Step 2: 修正 formatStatus 与 execute 签名**

```ts
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../runtime/types.ts";

async function execute(
	toolCallId: string,
	params: Static<typeof lspSchema>,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
	context?: ToolContext,
): Promise<AgentToolResult<LspToolDetails>>

function formatStatus(config: LspConfig, cwd: string): string {
	if (Object.keys(config.servers).length === 0) return "No language servers configured for this project";
	const active = new Map(getActiveClients().map((client) => [client.name, client.status]));
	const lines = Object.entries(config.servers).map(([name, server]) => {
		const key = `${server.command}:${cwd}`;
		return `${name} (${active.get(key) ?? "configured, not started"})`;
	});
	return `Language servers:\n${lines.join("\n")}`;
}
```

（`dispatchAction` 的 `status` 分支相应改为 `return formatStatus(config, cwd)`。）

- [x] **Step 3: 写测试（脚本化 navigation/hover/diagnostics 往返）**

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLspTool } from "../../src/lsp/tool.ts";
import { shutdownAll } from "../../src/lsp/client.ts";
import type { LspConfig } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const SERVER = "fake-lsp";

function fixtureConfig(): { cwd: string; config: LspConfig } {
	const cwd = mkdtempSync(path.join(tmpdir(), "lsp-tool-"));
	writeFileSync(path.join(cwd, "a.ts"), "const a = 1;\n");
	return {
		cwd,
		config: { servers: { [SERVER]: { command: SERVER, fileTypes: [".ts"], rootMarkers: ["a.ts"], resolvedCommand: SERVER } } },
	};
}

const made: string[] = [];
afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// 每次 tool 调用前脚本化应答 initialize(工具内部自动冷启动)。
async function answerInitialize(transport: FakeTransport): Promise<void> {
	for (let i = 0; i < 50; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const init = transport.lastRequest("initialize");
		if (init && !transport.sent.some((frame) => frame.includes('"result"') && frame.includes(String(init.id)))) {
			transport.emitResponse(init.id, { capabilities: { hoverProvider: true, definitionProvider: true } });
			return;
		}
	}
}

describe("createLspTool 只读动作", () => {
	it("diagnostics 打开文件并聚合 publishDiagnostics 缓存", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-1", { action: "diagnostics", file: "a.ts" });
		await answerInitialize(transport);
		transport.emitNotification("textDocument/publishDiagnostics", {
			uri: new URL(`file://${path.join(cwd, "a.ts")}`).href,
			diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "boom" }],
		});
		const result = await pending;
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("[error] boom");
	});

	it("definition 返回位置列表", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-2", { action: "definition", file: "a.ts", line: 1, symbol: "a" });
		await answerInitialize(transport);
		const request = transport.lastRequest("textDocument/definition");
		transport.emitResponse(request!.id, [{ uri: "file:///other.ts", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } }]);
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("Found 1 definition");
	});

	it("definition 给行号不给 symbol 报错", async () => {
		const { cwd, config } = fixtureConfig();
		made.push(cwd);
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-3", { action: "definition", file: "a.ts", line: 1 });
		await answerInitialize(transport);
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("symbol parameter required");
	});

	it("status 列出配置服务与未启动状态", async () => {
		const { cwd, config } = fixtureConfig();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => new FakeTransport() } });
		const result = await tool.execute("call-4", { action: "status" });
		expect((result.content[0] as { text: string }).text).toContain("fake-lsp (configured, not started)");
	});

	it("无匹配服务时返回错误文本且 details.success=false", async () => {
		const { cwd } = fixtureConfig();
		made.push(cwd);
		const tool = createLspTool(cwd, { getConfig: () => ({ servers: {} }), spawn: { spawn: async () => new FakeTransport() } });
		const result = await tool.execute("call-5", { action: "diagnostics", file: "a.ts" });
		expect(result.details).toMatchObject({ action: "diagnostics", success: false });
	});
});
```

- [x] **Step 4: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/tool-read.test.ts`
Expected: 5 passed。

- [x] **Step 5: 门禁**

Run: `npm run check`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -- src/lsp/tool.ts tests/lsp/tool-read.test.ts
git commit -m "lsp: 只读 lsp 工具(diagnostics/definition/hover/symbols/status/capabilities)"
```

---

### P4-1: 工作区编辑应用（`src/lsp/edits.ts`）

**Files:**
- Create: `src/lsp/edits.ts`
- Test: `tests/lsp/edits.test.ts`

**Interfaces:**
- Consumes: `LspWriteOperations`（P0-1）、`uriToFilePath`/`positionAt`/`offsetAt`（P3-1）、`LspClient`。
- Produces: `localLspWriteOperations(): LspWriteOperations`（node:fs/promises 直写）、`applyWorkspaceEdit(client, edit, ops, signal?): Promise<string[]>`（返回 applied 变更行；`documentChanges` 支持 TextDocumentEdit/CreateFile/RenameFile/DeleteFile；`changes` 映射同 URI 合并后按偏移倒序应用）。

- [x] **Step 1: 写编辑模块**

```ts
/**
 * WorkspaceEdit 应用 —— 从 pi coding-agent `src/lsp/edits.ts` 适配。
 * 所有落盘经注入 LspWriteOperations;URI→路径转换、偏移换算与应用顺序在本模块完成一次。
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sendNotification } from "./client.ts";
import type {
	CreateFile, DeleteFile, DocumentChange, LspClient, LspWriteOperations, RenameFile,
	TextEdit, TextDocumentEdit, WorkspaceEdit,
} from "./types.ts";
import { offsetAt, uriToFilePath } from "./utils.ts";

export function localLspWriteOperations(): LspWriteOperations {
	return {
		readFile: async (filePath) => await fs.readFile(filePath, "utf8"),
		writeFile: async (filePath, content) => {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, "utf8");
		},
		createDirectory: async (directory) => { await fs.mkdir(directory, { recursive: true }); },
		renameFile: async (oldPath, newPath) => {
			await fs.mkdir(path.dirname(newPath), { recursive: true });
			await fs.rename(oldPath, newPath);
		},
		deleteFile: async (filePath) => { await fs.rm(filePath, { force: true }); },
	};
}

function applyTextEdits(content: string, edits: TextEdit[]): string {
	// 倒序按偏移应用,避免前序编辑改变后续偏移。
	const sorted = [...edits].sort((a, b) => offsetAt(content, b.range.start) - offsetAt(content, a.range.start));
	let text = content;
	for (const edit of sorted) {
		const start = offsetAt(text, edit.range.start);
		const end = offsetAt(text, edit.range.end);
		text = text.slice(0, start) + edit.newText + text.slice(end);
	}
	return text;
}

function formatChange(change: DocumentChange): string {
	switch (change.kind) {
		case "create": return `create ${change.uri}`;
		case "rename": return `rename ${change.oldUri} -> ${change.newUri}`;
		case "delete": return `delete ${change.uri}`;
		default: return `edit ${change.textDocument.uri}`;
	}
}

export async function applyWorkspaceEdit(
	client: LspClient, edit: WorkspaceEdit, ops: LspWriteOperations, signal?: AbortSignal,
): Promise<string[]> {
	const applied: string[] = [];
	const changes = edit.documentChanges ?? [];
	for (const change of changes) {
		if ("kind" in change) {
			await applyResourceOperation(change, ops);
		} else {
			await applyTextDocumentEdit(change, ops);
		}
		applied.push(formatChange(change));
	}
	// changes 映射(旧形态):同 URI 合并后应用。
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
		const filePath = uriToFilePath(uri);
		const content = await ops.readFile(filePath);
		await ops.writeFile(filePath, applyTextEdits(content, edits));
		applied.push(`edit ${uri}`);
	}
	// 通知服务端工作区变更(rename 场景服务器据此更新索引)。
	if (changes.some((change) => "kind" in change && change.kind === "rename")) {
		await sendNotification(client, "workspace/didRenameFiles", {
			files: (changes as RenameFile[]).filter((change) => change.kind === "rename").map((change) => ({ oldUri: change.oldUri, newUri: change.newUri })),
		}, signal).catch(() => undefined);
	}
	return applied;
}

async function applyResourceOperation(change: CreateFile | RenameFile | DeleteFile, ops: LspWriteOperations): Promise<void> {
	if (change.kind === "create") {
		const filePath = uriToFilePath(change.uri);
		try { await ops.readFile(filePath); return; } catch { /* 不存在则创建 */ }
		await ops.createDirectory(path.dirname(filePath));
		await ops.writeFile(filePath, "");
	} else if (change.kind === "rename") {
		await ops.renameFile(uriToFilePath(change.oldUri), uriToFilePath(change.newUri));
	} else {
		await ops.deleteFile(uriToFilePath(change.uri));
	}
}

async function applyTextDocumentEdit(change: TextDocumentEdit, ops: LspWriteOperations): Promise<void> {
	const filePath = uriToFilePath(change.textDocument.uri);
	const content = await ops.readFile(filePath);
	await ops.writeFile(filePath, applyTextEdits(content, change.edits));
}
```

- [x] **Step 2: 写测试（注入记录型 ops）**

```ts
import { describe, expect, it } from "vitest";
import { applyWorkspaceEdit, localLspWriteOperations } from "../../src/lsp/edits.ts";
import { shutdownAll } from "../../src/lsp/client.ts";
import type { LspClient, LspWriteOperations, WorkspaceEdit } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

function makeClient(): LspClient {
	const transport = new FakeTransport();
	const client: LspClient = {
		name: "fake:.",
		cwd: "/tmp",
		config: { command: "fake", fileTypes: [], rootMarkers: [] },
		proc: transport,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => undefined,
	};
	return client;
}

function recordingOps(): LspWriteOperations & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		readFile: async (filePath) => (log.push(`read ${filePath}`), "const a = 1;\n"),
		writeFile: async (filePath, content) => { log.push(`write ${filePath} ${JSON.stringify(content)}`); },
		createDirectory: async (directory) => { log.push(`mkdir ${directory}`); },
		renameFile: async (oldPath, newPath) => { log.push(`rename ${oldPath} ${newPath}`); },
		deleteFile: async (filePath) => { log.push(`rm ${filePath}`); },
	};
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe("applyWorkspaceEdit", () => {
	it("TextDocumentEdit 应用文本编辑并写回", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ textDocument: { uri: "file:///a.ts", version: null }, edits: [{ range, newText: "const b = 1;" }] }] };
		const applied = await applyWorkspaceEdit(client, edit, ops);
		expect(applied).toEqual(["edit file:///a.ts"]);
		expect(ops.log).toContain('write /a.ts "const b = 1;\n"');
	});

	it("多个编辑按偏移倒序应用", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "x" }, { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } }, newText: "y" }] } };
		await applyWorkspaceEdit(client, edit, ops);
		const write = ops.log.find((entry) => entry.startsWith("write"));
		expect(write).toBeDefined();
		expect(write).toContain('"xconyst a = 1;\n"');
	});

	it("rename 资源操作落盘并发 didRenameFiles 通知", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ kind: "rename", oldUri: "file:///a.ts", newUri: "file:///b.ts" }] };
		await applyWorkspaceEdit(client, edit, ops);
		expect(ops.log).toContain("rename /a.ts /b.ts");
		const sent = (client.proc as FakeTransport).sent.some((frame) => frame.includes("workspace/didRenameFiles"));
		expect(sent).toBe(true);
	});

	it("create 已存在文件时不重复写入", async () => {
		const client = makeClient();
		const ops = recordingOps();
		const edit: WorkspaceEdit = { documentChanges: [{ kind: "create", uri: "file:///a.ts" }] };
		await applyWorkspaceEdit(client, edit, ops);
		expect(ops.log.filter((entry) => entry.startsWith("write")).length).toBe(0);
	});
});

describe("localLspWriteOperations", () => {
	it("接口完整", () => {
		const ops = localLspWriteOperations();
		for (const key of ["readFile", "writeFile", "createDirectory", "renameFile", "deleteFile"] as const) {
			expect(typeof ops[key]).toBe("function");
		}
	});
});
```

- [x] **Step 3: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/edits.test.ts`
Expected: 5 passed。

- [ ] **Step 4: 提交**

```bash
git add -- src/lsp/edits.ts tests/lsp/edits.test.ts
git commit -m "lsp: WorkspaceEdit 应用与治理写接缝"
```

---

### P4-2: 写动作与治理（`src/lsp/tool.ts` 第二部分）

**Files:**
- Modify: `src/lsp/tool.ts`（追加 rename/rename_file/code_actions/reload/request 分支）
- Test: `tests/lsp/tool-write.test.ts`

**Interfaces:**
- Consumes: `applyWorkspaceEdit`/`localLspWriteOperations`（P4-1）、`clearInitializationFailure`（P2-1）。
- Produces: 五动作完整实现；`writeOperations` 缺省 `localLspWriteOperations()`。

- [x] **Step 1: 在 dispatchAction 的写动作分支追加实现**

```ts
const MAX_RENAME_PAIRS = 1_000;

async function runRename(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	if (!params.new_name) throw new Error("new_name parameter required for rename");
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client, serverName } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	await waitForProjectLoaded(client, signal);
	if (params.line !== undefined && params.symbol === undefined) throw new Error("symbol parameter required when line is given for rename");
	const position = params.line !== undefined ? resolveSymbolColumn(filePath, params.line, params.symbol) : undefined;
	const edit = await sendRequest(client, "textDocument/rename", {
		textDocument: { uri: fileToUri(filePath) }, position, newName: params.new_name,
	}, signal) as WorkspaceEdit | null;
	if (!edit) return "Rename returned no edits";
	if (params.apply === false) return `Rename preview:\n${previewWorkspaceEdit(edit)}`;
	const ops = options.writeOperations ?? localLspWriteOperations();
	const applied = await applyWorkspaceEdit(client, edit, ops, signal);
	return `Applied rename (${serverName}):\n${applied.join("\n")}`;
}

function previewWorkspaceEdit(edit: WorkspaceEdit): string {
	const lines: string[] = [];
	for (const change of edit.documentChanges ?? []) {
		if ("kind" in change) lines.push(`${change.kind} ${change.kind === "rename" ? `${change.oldUri} -> ${change.newUri}` : change.uri}`);
		else lines.push(`edit ${change.textDocument.uri} (${change.edits.length} edits)`);
	}
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) lines.push(`edit ${uri} (${edits.length} edits)`);
	return lines.join("\n");
}

async function runRenameFile(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const source = path.resolve(cwd, requireFile(params));
	if (!params.new_name) throw new Error("new_name parameter required for rename_file");
	const destination = path.resolve(cwd, params.new_name);
	if (source === destination) throw new Error("source and destination are identical");
	if (!fs.existsSync(source)) throw new Error(`source does not exist: ${source}`);
	if (fs.existsSync(destination)) throw new Error(`destination already exists: ${destination}`);
	if (params.apply === false) return `Rename preview: ${source} -> ${destination}`;
	const ops = options.writeOperations ?? localLspWriteOperations();
	await ops.renameFile(source, destination);
	// 通知所有匹配服务(尽力而为,失败不阻断重命名)。
	for (const serverConfig of Object.values(config.servers)) {
		if (serverConfig.createClient) continue;
		if (!serverConfig.fileTypes.some((type) => source.endsWith(type) || destination.endsWith(type))) continue;
		const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
		await sendNotification(client, "workspace/didRenameFiles", {
			files: [{ oldUri: fileToUri(source), newUri: fileToUri(destination) }],
		}, signal).catch(() => undefined);
	}
	return `Renamed ${source} -> ${destination}`;
}

async function runCodeActions(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	const position = params.line !== undefined ? resolveSymbolColumn(filePath, params.line, params.symbol) : undefined;
	const uri = fileToUri(filePath);
	const cached = client.diagnostics.get(uri)?.diagnostics ?? [];
	const actions = await sendRequest(client, "textDocument/codeAction", {
		textDocument: { uri },
		range: { start: position ?? { line: 0, character: 0 }, end: position ?? { line: 0, character: 0 } },
		context: { diagnostics: cached, only: params.query ? [params.query] : undefined },
	}, signal) as Array<{ title: string; kind?: string; edit?: WorkspaceEdit; command?: { title: string; command: string; arguments?: unknown[] } }> | null;
	if (!actions || actions.length === 0) return "No code actions available";
	if (params.apply !== true) {
		return `${actions.length} code action(s):\n${actions.map((action, index) => `${index}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	}
	if (!params.query) return `${actions.length} code action(s) (query selector required to apply):\n${actions.map((action, index) => `${index}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	const index = /^\d+$/.test(params.query) ? Number(params.query) : actions.findIndex((action) => action.title.toLowerCase().includes(params.query!.toLowerCase()));
	const selected = actions[index];
	if (!selected) return `No code action matches "${params.query}". Available actions:\n${actions.map((action, i) => `${i}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	const ops = options.writeOperations ?? localLspWriteOperations();
	const parts: string[] = [];
	if (selected.edit) {
		parts.push(...await applyWorkspaceEdit(client, selected.edit, ops, signal));
	}
	if (selected.command) {
		await sendRequest(client, "workspace/executeCommand", { command: selected.command.command, arguments: selected.command.arguments ?? [] }, signal);
		parts.push(`executed ${selected.command.command}`);
	}
	if (parts.length === 0) return `Action "${selected.title}" has no workspace edit or command to apply`;
	return `Applied "${selected.title}":\n${parts.join("\n")}`;
}

async function runReload(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	const targets: Array<[string, LspConfig["servers"][string]]> = params.file && params.file !== "*"
		? getServersForFile(config, params.file).filter(([, server]) => !server.createClient) as Array<[string, LspConfig["servers"][string]]>
		: Object.entries(config.servers).filter(([, server]) => !server.createClient);
	const lines: string[] = [];
	for (const [serverName, serverConfig] of targets) {
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		clearInitializationFailure(serverConfig, cwd);
		const key = `${serverConfig.command}:${cwd}`;
		await shutdownClient(key);
		lines.push(`Restarted ${serverName} (cold restart on next request)`);
	}
	return lines.join("\n");
}

async function runRequest(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	if (!params.query) throw new Error("query parameter required for request");
	const method = params.query;
	let target: [string, LspConfig["servers"][string]] | undefined;
	if (params.file && params.file !== "*") {
		const match = getServerForFile(config, params.file);
		if (match && !match[1].createClient) target = match;
	} else {
		target = Object.entries(config.servers).find(([, server]) => !server.createClient);
	}
	if (!target) return "No language server available for request";
	const [serverName, serverConfig] = target;
	const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
	let requestParams: unknown = {};
	if (params.payload) {
		requestParams = JSON.parse(params.payload);
	} else if (params.file && params.file !== "*") {
		const filePath = path.resolve(cwd, params.file);
		await ensureFileOpen(client, filePath, signal);
		const position = params.line !== undefined ? resolveSymbolColumn(filePath, params.line, params.symbol) : undefined;
		requestParams = position ? { textDocument: { uri: fileToUri(filePath) }, position } : { textDocument: { uri: fileToUri(filePath) } };
	}
	const result = await sendRequest(client, method, requestParams, signal);
	const formatted = typeof result === "string" ? result : JSON.stringify(result, null, 2);
	return `${serverName} <- ${method}:\n${formatted ?? "null"}`;
}
```

- [x] **Step 1.5: dispatchAction 写分支接线**

`src/lsp/tool.ts` 顶部补导入:

```ts
import * as fs from "node:fs";
import { shutdownClient } from "./client.ts";
```

（`WorkspaceEdit` 并入现有 `./types.ts` 类型导入。）`dispatchAction` 的五个占位 case 替换为:

```ts
		case "rename":
			return runRename(cwd, params, config, options, signal);
		case "rename_file":
			return runRenameFile(cwd, params, config, options, signal);
		case "code_actions":
			return runCodeActions(cwd, params, config, options, signal);
		case "reload":
			return runReload(cwd, params, config, options, signal);
		case "request":
			return runRequest(cwd, params, config, options, signal);
```

Run: `npm run check`,全绿后继续。

- [x] **Step 2: 写测试**

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { shutdownAll } from "../../src/lsp/client.ts";
import { createLspTool } from "../../src/lsp/tool.ts";
import type { LspConfig, LspWriteOperations, WorkspaceEdit } from "../../src/lsp/types.ts";
import { FakeTransport } from "./fake-transport.ts";

const made: string[] = [];
afterEach(async () => {
	await shutdownAll();
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { cwd: string; config: LspConfig } {
	const cwd = mkdtempSync(path.join(tmpdir(), "lsp-write-"));
	made.push(cwd);
	writeFileSync(path.join(cwd, "a.ts"), "const a = 1;\n");
	return { cwd, config: { servers: { fake: { command: "fake", fileTypes: [".ts"], rootMarkers: ["a.ts"], resolvedCommand: "fake" } } } };
}

function recordingOps(): LspWriteOperations & { log: string[] } {
	const log: string[] = [];
	return {
		log,
		readFile: async () => "const a = 1;\n",
		writeFile: async (filePath, content) => { log.push(`write ${filePath} ${JSON.stringify(content)}`); },
		createDirectory: async (directory) => { log.push(`mkdir ${directory}`); },
		renameFile: async (oldPath, newPath) => { log.push(`rename ${oldPath} ${newPath}`); },
		deleteFile: async (filePath) => { log.push(`rm ${filePath}`); },
	};
}

async function answerInitialize(transport: FakeTransport): Promise<void> {
	for (let i = 0; i < 50; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const init = transport.lastRequest("initialize");
		if (init && !transport.sent.some((frame) => frame.includes('"result"') && frame.includes(String(init.id)))) {
			transport.emitResponse(init.id, { capabilities: { renameProvider: true, codeActionProvider: true } });
			return;
		}
	}
}

describe("createLspTool 写动作", () => {
	it("rename apply 经注入 writeOperations 落盘", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-1", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b" });
		await answerInitialize(transport);
		const request = transport.lastRequest("textDocument/rename");
		const edit: WorkspaceEdit = { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "b" }] } };
		transport.emitResponse(request!.id, edit);
		const result = await pending;
		expect(ops.log.some((entry) => entry.startsWith("write"))).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("Applied rename");
	});

	it("rename apply=false 只预览不落盘", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-2", { action: "rename", file: "a.ts", line: 1, symbol: "a", new_name: "b", apply: false });
		await answerInitialize(transport);
		transport.emitResponse(transport.lastRequest("textDocument/rename").id, { changes: { "file:///a.ts": [] } });
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain("Rename preview");
		expect(ops.log).toHaveLength(0);
	});

	it("rename_file 经 ops.renameFile 落盘", async () => {
		const { cwd, config } = fixture();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => new FakeTransport() }, writeOperations: ops });
		const result = await tool.execute("call-3", { action: "rename_file", file: "a.ts", new_name: "b.ts" });
		expect(ops.log).toContain(`rename ${path.join(cwd, "a.ts")} ${path.join(cwd, "b.ts")}`);
		expect((result.content[0] as { text: string }).text).toContain("Renamed");
	});

	it("code_actions apply 按 query 选择并应用 edit", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const ops = recordingOps();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport }, writeOperations: ops });
		const pending = tool.execute("call-4", { action: "code_actions", file: "a.ts", apply: true, query: "fix" });
		await answerInitialize(transport);
		const request = transport.lastRequest("textDocument/codeAction");
		transport.emitResponse(request!.id, [
			{ title: "Fix it", kind: "quickfix", edit: { changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }] } } },
		]);
		const result = await pending;
		expect(ops.log.some((entry) => entry.startsWith("write"))).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain('Applied "Fix it"');
	});

	it("request 走 query 方法名并透传 payload", async () => {
		const { cwd, config } = fixture();
		const transport = new FakeTransport();
		const tool = createLspTool(cwd, { getConfig: () => config, spawn: { spawn: async () => transport } });
		const pending = tool.execute("call-5", { action: "request", query: "rust-analyzer/analyzerStatus", payload: "{\"textDocument\":null}" });
		await answerInitialize(transport);
		const request = transport.lastRequest("rust-analyzer/analyzerStatus");
		expect(request!.params).toEqual({ textDocument: null });
		transport.emitResponse(request!.id, { status: "ready" });
		const result = await pending;
		expect((result.content[0] as { text: string }).text).toContain('"status": "ready"');
	});
});
```

- [x] **Step 3: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/tool-write.test.ts`
Expected: 5 passed。

- [x] **Step 4: 门禁**

Run: `npm run check && npx vitest run tests/lsp`
Expected: 全绿，tests/lsp 累计 42 用例通过。

- [ ] **Step 5: 提交**

```bash
git add -- src/lsp/tool.ts tests/lsp/tool-write.test.ts
git commit -m "lsp: rename/rename_file/code_actions/reload/request 写动作"
```

---

### P5-1: Linter 客户端适配（`src/lsp/clients/`）

**Files:**
- Create: `src/lsp/clients/lsp-linter-client.ts`、`src/lsp/clients/biome-client.ts`、`src/lsp/clients/swiftlint-client.ts`、`src/lsp/clients/index.ts`
- Modify: `src/lsp/config.ts`（合并后注入 `createClient`）、`src/lsp/tool.ts`（diagnostics 聚合 custom clients）
- Test: `tests/lsp/clients.test.ts`

**Interfaces:**
- Consumes: `LinterClient`（P0-1）、client 生命周期（P2-1）、`loadConfig` 尾段。
- Produces: `getLinterClient(serverName, config, cwd): LinterClient`、`clearLinterClientCache()`；`BiomeClient`（`BiomeClient.create`，注入 `run?: BiomeRunner` 测试接缝）、`SwiftLintClient`、`LspLinterClient`。

- [x] **Step 1: 写 LSP 兜底 linter 客户端**

```ts
/**
 * LSP 协议兜底 linter 客户端:真实语言服务器跑 linter 的默认路径。
 */
import { ensureFileOpen, getOrCreateClient, refreshFile, waitForProjectLoaded } from "../client.ts";
import type { Diagnostic, LinterClient, LspProcessSpawner, ServerConfig } from "../types.ts";
import { fileToUri } from "../utils.ts";

export interface LspLinterClientOptions {
	spawn?: LspProcessSpawner;
}

export class LspLinterClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): LspLinterClient {
		return new LspLinterClient(config, cwd);
	}

	private readonly config: ServerConfig;
	private readonly cwd: string;

	constructor(config: ServerConfig, cwd: string, private readonly options: LspLinterClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
	}

	async lint(filePath: string, signal?: AbortSignal): Promise<Diagnostic[]> {
		const client = await getOrCreateClient(this.config, this.cwd, { spawn: this.options.spawn }, signal);
		await ensureFileOpen(client, filePath, signal);
		await waitForProjectLoaded(client, signal);
		await refreshFile(client, filePath, signal);
		return client.diagnostics.get(fileToUri(filePath))?.diagnostics ?? [];
	}
}
```

- [x] **Step 2: 写 Biome CLI 适配**

```ts
/**
 * Biome CLI linter 适配 —— pi 同款理由:Biome 的 LSP 有 stale diagnostics 已知问题,
 * 直接跑 `biome lint --reporter=json` 并把字节偏移换算为行列。
 */
import * as path from "node:path";
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../types.ts";

export type BiomeRunner = (args: string[], cwd: string, resolvedCommand?: string) => Promise<{ stdout: string; stderr: string; success: boolean }>;

async function runBiomeCli(args: string[], cwd: string, resolvedCommand?: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const proc = Bun.spawn([resolvedCommand ?? "biome", ...args], { cwd, stdin: "null", stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, success: exitCode === 0 };
}

interface BiomeJsonOutput {
	diagnostics: Array<{
		severity: string;
		message?: { message?: string };
		location?: { span?: number[]; path?: { file?: string } };
	}>;
}

function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "error": return 1;
		case "warning": return 2;
		case "information": return 3;
		default: return 4;
	}
}

/** 单遍把字节偏移换算为行列(pi offsetsToPositions 同款)。 */
function offsetsToPositions(source: string, offsets: number[]): Map<number, { line: number; column: number }> {
	const result = new Map<number, { line: number; column: number }>();
	let line = 0;
	let column = 0;
	const sorted = [...offsets].sort((a, b) => a - b);
	let offsetIndex = 0;
	for (let i = 0; i <= source.length; i += 1) {
		while (offsetIndex < sorted.length && sorted[offsetIndex] === i) {
			result.set(sorted[offsetIndex], { line, column });
			offsetIndex += 1;
		}
		if (offsetIndex === sorted.length) break;
		if (source[i] === "\n") { line += 1; column = 0; } else { column += 1; }
	}
	return result;
}

export interface BiomeClientOptions {
	run?: BiomeRunner;
}

export class BiomeClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): BiomeClient {
		return new BiomeClient(config, cwd);
	}

	private readonly config: ServerConfig;
	private readonly cwd: string;
	private readonly run: BiomeRunner;

	constructor(config: ServerConfig, cwd: string, options: BiomeClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
		this.run = options.run ?? runBiomeCli;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const { stdout, success } = await this.run(["lint", "--reporter=json", path.relative(this.cwd, filePath)], this.cwd, this.config.resolvedCommand);
		if (!stdout) return [];
		let parsed: BiomeJsonOutput;
		try { parsed = JSON.parse(stdout) as BiomeJsonOutput; } catch { return []; }
		const fileUri = new URL(`file://${filePath}`).href;
		const source = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
		const diagnostics: Diagnostic[] = [];
		for (const item of parsed.diagnostics ?? []) {
			const span = item.location?.span ?? [];
			const [start = 0, end = 0] = span;
			const positions = offsetsToPositions(source, [start, end]);
			const startPos = positions.get(start) ?? { line: 0, column: 0 };
			const endPos = positions.get(end) ?? startPos;
			diagnostics.push({
				range: { start: { line: startPos.line, character: startPos.column }, end: { line: endPos.line, character: endPos.column } },
				severity: parseSeverity(item.severity),
				source: "biome",
				message: item.message?.message ?? "biome diagnostic",
			});
		}
		void success;
		void fileUri;
		return diagnostics;
	}
}
```

注意：`fileUri`/`success` 未使用变量与内联动态 `import()`（AGENTS.md 禁止内联动态导入）需在 Step 4 修正。

- [x] **Step 3: 写 SwiftLint 适配与工厂**

```ts
/**
 * SwiftLint CLI linter 适配:`swiftlint lint --reporter json` 输出换算为 LSP Diagnostic。
 */
import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../types.ts";

export type SwiftLintRunner = (args: string[], cwd: string, resolvedCommand?: string) => Promise<{ stdout: string; stderr: string; success: boolean }>;

async function runSwiftLintCli(args: string[], cwd: string, resolvedCommand?: string): Promise<{ stdout: string; stderr: string; success: boolean }> {
	const proc = Bun.spawn([resolvedCommand ?? "swiftlint", ...args], { cwd, stdin: "null", stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;
	return { stdout, stderr, success: exitCode === 0 || exitCode === 2 }; // swiftlint 退出码 2 = lint 发现违规
}

function parseSeverity(severity: string): DiagnosticSeverity {
	switch (severity) {
		case "Error": return 1;
		case "Warning": return 2;
		default: return 3;
	}
}

interface SwiftLintOutputItem {
	file?: string;
	line?: number;
	character?: number;
	severity?: string;
	reason?: string;
	rule_id?: string;
}

export interface SwiftLintClientOptions {
	run?: SwiftLintRunner;
}

export class SwiftLintClient implements LinterClient {
	static create(config: ServerConfig, cwd: string): SwiftLintClient {
		return new SwiftLintClient(config, cwd);
	}

	private readonly config: ServerConfig;
	private readonly cwd: string;
	private readonly run: SwiftLintRunner;

	constructor(config: ServerConfig, cwd: string, options: SwiftLintClientOptions = {}) {
		this.config = config;
		this.cwd = cwd;
		this.run = options.run ?? runSwiftLintCli;
	}

	async lint(filePath: string): Promise<Diagnostic[]> {
		const { stdout } = await this.run(["lint", "--reporter", "json", "--path", filePath], this.cwd, this.config.resolvedCommand);
		if (!stdout) return [];
		let items: SwiftLintOutputItem[];
		try { items = JSON.parse(stdout) as SwiftLintOutputItem[]; } catch { return []; }
		return items.map((item) => {
			const line = Math.max((item.line ?? 1) - 1, 0);
			const character = Math.max((item.character ?? 1) - 1, 0);
			return {
				range: { start: { line, character }, end: { line, character } },
				severity: parseSeverity(item.severity ?? "Warning"),
				source: "swiftlint",
				message: item.reason ?? item.rule_id ?? "swiftlint diagnostic",
			};
		});
	}
}
```

```ts
/**
 * Linter 客户端工厂与缓存 —— pi clients/index.ts 同款。
 */
import type { LinterClient, ServerConfig } from "../types.ts";
import { LspLinterClient } from "./lsp-linter-client.ts";

export { BiomeClient } from "./biome-client.ts";
export { LspLinterClient } from "./lsp-linter-client.ts";
export { SwiftLintClient } from "./swiftlint-client.ts";

const clientCache = new Map<string, LinterClient>();

export function getLinterClient(serverName: string, config: ServerConfig, cwd: string): LinterClient {
	const key = `${serverName}:${cwd}`;
	const existing = clientCache.get(key);
	if (existing) return existing;
	const client = config.createClient ? config.createClient(config, cwd) : LspLinterClient.create(config, cwd);
	clientCache.set(key, client);
	return client;
}

export function clearLinterClientCache(): void {
	for (const client of clientCache.values()) client.dispose?.();
	clientCache.clear();
}
```

- [x] **Step 4: 修正 Biome 客户端（去掉内联动态导入与未用变量）**

```ts
import * as fs from "node:fs/promises";

async lint(filePath: string): Promise<Diagnostic[]> {
	const { stdout } = await this.run(["lint", "--reporter=json", path.relative(this.cwd, filePath)], this.cwd, this.config.resolvedCommand);
	if (!stdout) return [];
	let parsed: BiomeJsonOutput;
	try { parsed = JSON.parse(stdout) as BiomeJsonOutput; } catch { return []; }
	const source = await fs.readFile(filePath, "utf8");
	const diagnostics: Diagnostic[] = [];
	for (const item of parsed.diagnostics ?? []) {
		const span = item.location?.span ?? [];
		const [start = 0, end = 0] = span;
		const positions = offsetsToPositions(source, [start, end]);
		const startPos = positions.get(start) ?? { line: 0, column: 0 };
		const endPos = positions.get(end) ?? startPos;
		diagnostics.push({
			range: { start: { line: startPos.line, character: startPos.column }, end: { line: endPos.line, character: endPos.column } },
			severity: parseSeverity(item.severity),
			source: "biome",
			message: item.message?.message ?? "biome diagnostic",
		});
	}
	return diagnostics;
}
```

- [x] **Step 5: config.ts 注入工厂**

在 `loadConfig` 返回前追加（pi `config.ts:153-159` 同款）：

```ts
	// 运行时工厂注入:CLI 适配客户端不可由配置文件构造。
	if (filtered.biome) filtered.biome = { ...filtered.biome, createClient: BiomeClient.create };
	if (filtered.swiftlint) filtered.swiftlint = { ...filtered.swiftlint, createClient: SwiftLintClient.create };
	return { servers: filtered };
```

（文件顶部补 `import { BiomeClient } from "./clients/biome-client.ts"; import { SwiftLintClient } from "./clients/swiftlint-client.ts";`）

- [x] **Step 6: tool.ts 诊断聚合接入 custom clients**

`src/lsp/tool.ts` 顶部补 `import { getLinterClient } from "./clients/index.ts";`。`runDiagnostics` 的循环体改为：

```ts
	for (const [serverName, serverConfig] of servers) {
		if (serverConfig.createClient) {
			const linterClient = getLinterClient(serverName, serverConfig, cwd);
			const diagnostics = await linterClient.lint(filePath, signal);
			if (diagnostics.length > 0) results.push(`${serverName}:\n${formatDiagnostics(diagnostics)}`);
			continue;
		}
		const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn }, signal);
		await ensureFileOpen(client, filePath, signal);
		await waitForProjectLoaded(client, signal);
		await refreshFile(client, filePath, signal);
		const cached = client.diagnostics.get(fileToUri(filePath));
		const diagnostics = cached?.diagnostics ?? [];
		if (diagnostics.length === 0) continue;
		results.push(`${serverName}:\n${formatDiagnostics(diagnostics)}`);
	}
```

- [x] **Step 7: 写测试（注入假 runner）**

```ts
import { describe, expect, it } from "vitest";
import { BiomeClient } from "../../src/lsp/clients/biome-client.ts";
import { SwiftLintClient } from "../../src/lsp/clients/swiftlint-client.ts";
import { clearLinterClientCache, getLinterClient } from "../../src/lsp/clients/index.ts";
import { LspLinterClient } from "../../src/lsp/clients/lsp-linter-client.ts";
import type { ServerConfig } from "../../src/lsp/types.ts";

const config: ServerConfig = { command: "biome", fileTypes: [".ts"], rootMarkers: [] };

describe("BiomeClient", () => {
	it("把 biome JSON 字节偏移换算为 LSP 位置", async () => {
		const client = new BiomeClient(config, "/tmp", {
			run: async () => ({
				stdout: JSON.stringify({ diagnostics: [{ severity: "error", message: { message: "boom" }, location: { span: [1, 2] } }] }),
				stderr: "", success: false,
			}),
		});
		const diagnostics = await client.lint("/tmp/a.ts");
		expect(diagnostics[0]).toMatchObject({
			range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
			severity: 1,
			message: "boom",
		});
	});

	it("空输出返回空诊断", async () => {
		const client = new BiomeClient(config, "/tmp", { run: async () => ({ stdout: "", stderr: "", success: true }) });
		expect(await client.lint("/tmp/a.ts")).toEqual([]);
	});
});

describe("SwiftLintClient", () => {
	it("1 起始行列换算为 0 起始 LSP 位置", async () => {
		const client = new SwiftLintClient(config, "/tmp", {
			run: async () => ({ stdout: JSON.stringify([{ line: 3, character: 5, severity: "Warning", reason: "no" }]), stderr: "", success: true }),
		});
		const diagnostics = await client.lint("/tmp/a.swift");
		expect(diagnostics[0]?.range.start).toEqual({ line: 2, character: 4 });
		expect(diagnostics[0]?.severity).toBe(2);
	});
});

describe("getLinterClient", () => {
	it("无 createClient 时回退 LspLinterClient,并按 name:cwd 缓存", () => {
		const plain: ServerConfig = { ...config, command: "eslint" };
		const first = getLinterClient("eslint", plain, "/tmp");
		const second = getLinterClient("eslint", plain, "/tmp");
		expect(first).toBe(second);
		expect(first instanceof LspLinterClient).toBe(true);
		clearLinterClientCache();
	});
});
```

- [x] **Step 8: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/clients.test.ts`
Expected: 4 passed。

- [x] **Step 9: 门禁**

Run: `npm run check && npx vitest run tests/lsp`
Expected: 全绿。

- [ ] **Step 10: 提交**

```bash
git add -- src/lsp/clients src/lsp/config.ts src/lsp/tool.ts tests/lsp/clients.test.ts
git commit -m "lsp: LinterClient 适配层(biome/swiftlint CLI + LSP 兜底)"
```

---

### P5-2: rust-analyzer workspace-ready 轮询

**Files:**
- Modify: `src/lsp/client.ts`
- Test: `tests/lsp/client.test.ts`（追加用例）

**Interfaces:**
- Consumes: `workspaceReadyTimings`（P0-1）。
- Produces: `waitForRustAnalyzerWorkspace(client, signal?)`；`waitForProjectLoaded` 改为对 rust-analyzer 客户端轮询 `rust-analyzer/analyzerStatus` 至 workspace 就绪（超时/请求失败快速返回，不阻断）。

- [x] **Step 1: 追加实现**

```ts
const RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS = 5_000;
const RUST_ANALYZER_WORKSPACE_READY_POLL_MS = 100;
const RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS = 1_000;

function isRustAnalyzerClient(client: LspClient): boolean {
	return path.basename(client.config.command).includes("rust-analyzer");
}

/**
 * rust-analyzer 项目加载结束后 workspace 未必就绪;轮询 analyzerStatus 直至 ready。
 * 请求失败(方法未实现/超时)快速返回,不阻塞后续请求。
 */
export async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (!isRustAnalyzerClient(client)) return;
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS;
	const pollMs = timings?.pollMs ?? RUST_ANALYZER_WORKSPACE_READY_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() > deadline) return;
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		try {
			const status = await sendRequest(client, "rust-analyzer/analyzerStatus", { textDocument: null }, signal, timings?.statusRequestTimeoutMs ?? RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS) as { status?: string };
			if (status?.status === "ready") return;
		} catch {
			return; // 方法未实现/超时:放弃轮询。
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
```

`waitForProjectLoaded` 改为在 `client.projectLoaded` 后追加轮询：

```ts
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal) {
		await Promise.race([client.projectLoaded, new Promise<void>((_, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
		})]);
	} else {
		await client.projectLoaded;
	}
	await waitForRustAnalyzerWorkspace(client, signal);
}
```

- [x] **Step 2: 追加测试用例**

```ts
	it("rust-analyzer 客户端在项目加载后轮询 analyzerStatus 至 ready", async () => {
		const transport = new FakeTransport();
		const cwd = project();
		const rustConfig: ServerConfig = { ...config, command: "rust-analyzer" };
		const clientPromise = getOrCreateClient(rustConfig, cwd, { spawn: fakeSpawner(transport) });
		await new Promise((resolve) => setTimeout(resolve, 0));
		transport.emitResponse(transport.lastRequest("initialize")!.id, { capabilities: {} });
		const client = await clientPromise;
		const waiting = waitForProjectLoaded(client);
		transport.emitNotification("$/progress", { token: "t", value: { kind: "end" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const statusRequest = transport.lastRequest("rust-analyzer/analyzerStatus");
		expect(statusRequest).toBeDefined();
		transport.emitResponse(statusRequest.id, { status: "ready" });
		await waiting;
	});
```

- [x] **Step 3: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/lsp/client.test.ts`
Expected: 6 passed。

- [ ] **Step 4: 提交**

```bash
git add -- src/lsp/client.ts tests/lsp/client.test.ts
git commit -m "lsp: rust-analyzer workspace-ready 轮询"
```

---

### P6-1: 生产接线（managed spawner / governed filesystem / Session scope）

> 本节早期代码块保留为实施历史，不是当前生产 authority。Review 修复后的权威实现是 `src/runtime/session-runtime/lsp-composition.ts` 与 `domain.ts`：不得恢复 raw `Bun.spawn`、全局 cleanup、额外 direct AttemptPort 或 raw rename。

**Files:**
- Create: `src/runtime/session-runtime/lsp-composition.ts`
- Modify: `src/runtime/session-runtime/domain.ts`（`productionSessionTools` 增加可选 `lsp` 参数并追加 `createLspTool`）
- Test: `tests/runtime/session-runtime/lsp-composition.test.ts`

**Interfaces:**
- Consumes: `AttemptPort`（`beginAttempt(effectClass, requestDigest)` / `settleAttempt(attemptId, outcome)`）、`ExecutionEnv.fs`、`registerSessionResourceCleanup`（`src/session-resources.ts`）、`bunSpawnTransport`（P0-2）、`LspWriteOperations`（P0-1）、`shutdownAll`（P2-1）、`createLspTool`（P3-2）。
- Produces: `createGovernedLspSpawner(attemptPort: LateBoundAttemptPort): LspProcessSpawner`、`createGovernedLspWriteOperations(attemptPort, fs: FileSystem): LspWriteOperations`、`attachLspSessionCleanup(): () => void`。

- [x] **Step 1: 写组合模块**

```ts
/**
 * LSP 生产组合 —— governed spawner / governed write ops / 会话清理。
 *
 * 治理模型:
 *   - spawn 一次 = 一次 process_spawn attempt(spawn 成功即 committed;进程随会话清理回收);
 *   - 每次文件落盘 = 一次 workspace_mutation attempt(成功 committed / 失败 rejected);
 *   - barrier 拒绝时抛错,工具把错误回灌给模型(AgentTool 契约)。
 */
import * as fs from "node:fs/promises";
import type { AttemptId, CommandId } from "../protocol/ids.ts";
import type { AttemptPort, LateBoundAttemptPort } from "./attempt-gateway.ts";
import type { FileSystem } from "../execution-env.ts";
import type { LspProcessSpawner, LspWriteOperations, LspTransport } from "../../lsp/types.ts";
import { bunSpawnTransport } from "../../lsp/transport.ts";
import { shutdownAll } from "../../lsp/client.ts";
import { registerSessionResourceCleanup } from "../../session-resources.ts";
import { runtimeDigest } from "../protocol/foundation.ts";

function requireAttempt(attemptPort: LateBoundAttemptPort, operation: string): { port: AttemptPort; handle: { attemptId: AttemptId; commandId: CommandId } } {
	const port = attemptPort();
	if (port === undefined) throw new Error("attempt port unavailable; LSP side effect not executed");
	const begun = port.beginAttempt("workspace_mutation", runtimeDigest({ operation }));
	if ("error" in begun) throw new Error(`recovery barrier active (${begun.error}); LSP side effect not executed`);
	return { port, handle: begun };
}

export function createGovernedLspSpawner(attemptPort: LateBoundAttemptPort): LspProcessSpawner {
	return {
		spawn(command, args, cwd) {
			const port = attemptPort();
			if (port === undefined) throw new Error("attempt port unavailable; LSP process not spawned");
			const begun = port.beginAttempt("process_spawn", runtimeDigest({ operation: "lsp.spawn", command, cwd }));
			if ("error" in begun) throw new Error(`recovery barrier active (${begun.error}); LSP process not spawned`);
			const transport: LspTransport = bunSpawnTransport(command, args, cwd);
			port.settleAttempt(begun.attemptId, "committed", runtimeDigest({ command, pid: transport.pid }));
			return transport;
		},
	};
}

export function createGovernedLspWriteOperations(attemptPort: LateBoundAttemptPort, fileSystem: FileSystem): LspWriteOperations {
	const guardedWrite = async (operation: string, run: () => Promise<void>): Promise<void> => {
		const { port, handle } = requireAttempt(attemptPort, operation);
		try {
			await run();
			port.settleAttempt(handle.attemptId, "committed");
		} catch (error) {
			port.settleAttempt(handle.attemptId, "rejected");
			throw error;
		}
	};
	return {
		readFile: async (filePath) => (await fileSystem.readFile(filePath)).toString("utf8"),
		writeFile: (filePath, content) => guardedWrite("lsp.writeFile", () => fileSystem.writeFile(filePath, content)),
		createDirectory: (directory) => guardedWrite("lsp.createDirectory", () => fileSystem.mkdir(directory, { recursive: true })),
		deleteFile: (filePath) => guardedWrite("lsp.deleteFile", () => fileSystem.rm(filePath, { force: true })),
		renameFile: (oldPath, newPath) => guardedWrite("lsp.renameFile", () => fs.rename(oldPath, newPath)),
	};
}

/** 注册会话级清理:会话结束时关闭全部 LSP 客户端。返回注销函数。 */
export function attachLspSessionCleanup(): () => void {
	return registerSessionResourceCleanup(() => { void shutdownAll(); });
}
```

- [x] **Step 2: domain.ts 接线**

`productionSessionTools` 签名与实现追加：

```ts
import { createLspTool, type LspToolOptions } from "../../lsp/tool.ts";

export function productionSessionTools(
	cwd: string,
	executionEnv: ExecutionEnv,
	managedProcess?: StdlibToolsOptions["managedProcess"],
	permissionRequester?: StdlibToolsOptions["permissionRequester"],
	lspOptions?: LspToolOptions,
): AgentTool[] {
	const registry = createStdlibTools(cwd, {
		executionEnv,
		...(managedProcess === undefined ? {} : { managedProcess }),
		...(permissionRequester === undefined ? {} : { permissionRequester }),
	});
	const tools = registry.toContext().filter((tool) => !["echo", "skill", "notebook-edit"].includes(tool.name));
	if (lspOptions) tools.push(createLspTool(cwd, lspOptions));
	return tools;
}
```

`assembleSessionDomain` 内构造处传入 governed 选项（在已有 attemptPort 参数可用处）：

```ts
	const lspOptions: LspToolOptions | undefined = attemptPort === undefined ? undefined : {
		spawn: createGovernedLspSpawner(attemptPort),
		writeOperations: createGovernedLspWriteOperations(attemptPort, executionEnv.fs),
	};
	// 生产工具集构造调用点传入 lspOptions;会话清理随 assemble 注册一次。
	attachLspSessionCleanup();
```

（`executionEnv` 与 `attemptPort` 已存在于 `assembleSessionDomain` 作用域；精确插入位置以当前函数体为准。）

- [x] **Step 3: 写测试**

```ts
import { describe, expect, it } from "vitest";
import { createGovernedLspSpawner, createGovernedLspWriteOperations } from "../../../runtime/session-runtime/lsp-composition.ts";
import type { AttemptId, CommandId } from "../../../runtime/protocol/ids.ts";
import type { AttemptPort } from "../../../runtime/session-runtime/attempt-gateway.ts";
import type { FileSystem } from "../../../runtime/execution-env.ts";

function makePort(): AttemptPort & { calls: Array<{ effectClass: string; outcome: string }> } {
	const calls: Array<{ effectClass: string; outcome: string }> = [];
	return {
		calls,
		beginAttempt(effectClass) {
			calls.push({ effectClass, outcome: "begin" });
			return { attemptId: `a-${calls.length}` as AttemptId, commandId: `c-${calls.length}` as CommandId };
		},
		settleAttempt(attemptId, outcome) {
			calls.push({ effectClass: String(attemptId), outcome });
			return { ok: true };
		},
	};
}

const memoryFs: FileSystem = {
	readFile: async () => Buffer.from("x"),
	writeFile: async () => undefined,
	stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
	readdir: async () => [],
	mkdir: async () => undefined,
	rm: async () => undefined,
};

describe("lsp-composition", () => {
	it("write 成功走 workspace_mutation attempt 并 committed", async () => {
		const port = makePort();
		const ops = createGovernedLspWriteOperations(() => port, memoryFs);
		await ops.writeFile("/a.ts", "x");
		expect(port.calls).toEqual([
			{ effectClass: "workspace_mutation", outcome: "begin" },
			{ effectClass: "a-1", outcome: "committed" },
		]);
	});

	it("write 失败 settle rejected 并向上抛", async () => {
		const port = makePort();
		const failing: FileSystem = { ...memoryFs, writeFile: async () => { throw new Error("disk full"); } };
		const ops = createGovernedLspWriteOperations(() => port, failing);
		await expect(ops.writeFile("/a.ts", "x")).rejects.toThrow("disk full");
		expect(port.calls[1]?.outcome).toBe("rejected");
	});

	it("barrier 拒绝时 spawn 与写都不执行", async () => {
		const port = makePort();
		const barrierPort: AttemptPort = {
			...port,
			beginAttempt: () => ({ error: "recovery_barrier_active" }),
		};
		const spawner = createGovernedLspSpawner(() => barrierPort);
		expect(() => spawner.spawn("x", [], "/tmp")).toThrow(/recovery barrier active/);
		const ops = createGovernedLspWriteOperations(() => barrierPort, memoryFs);
		await expect(ops.writeFile("/a.ts", "x")).rejects.toThrow(/recovery barrier active/);
	});
});
```

- [x] **Step 4: 运行测试**

Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npx vitest run tests/runtime/session-runtime/lsp-composition.test.ts`
Expected: 3 passed。

- [x] **Step 5: 门禁**

Run: `npm run check && npx vitest run tests/lsp tests/runtime/session-runtime/lsp-composition.test.ts`
Expected: 全绿。注意 `assembleSessionDomain` 的插入点必须位于 `executionEnv`（gatedExecutionEnv 产物）定义之后；若 R6 未完成域使该函数无 executionEnv 变量，先按当前函数体定位等价注入点，或把 lsp 工具构造保持在 `productionSessionTools` 调用点。

- [ ] **Step 6: 提交**

```bash
git add -- src/runtime/session-runtime/lsp-composition.ts src/runtime/session-runtime/domain.ts tests/runtime/session-runtime/lsp-composition.test.ts
git commit -m "lsp: 生产接线(governed spawn/write ops/会话清理)"
```

---

### P7-1: 真实验收与门禁

**Files:** 无新文件；如需 dogfood 依赖则 `package.json` 增加 devDependency（`typescript-language-server`）。

**验收前置（一次性）：**
Run: `cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger && npm i -D typescript-language-server`
（biome 已是 devDependency；`node_modules/.bin` 解析在 P1-2 的本地 bin 路径覆盖内。）

- [x] **Step 1: 全量门禁**

```bash
cd /data2-HDD-SATA-20T/Digital_avatar/haoweiyao/RunLedger
npm run check && npm test && npm run build
```

Expected: 全绿（Vitest 全量 + Bun OpenTUI + build），无截断输出。

- [ ] **Step 2: RunLedger 仓库 dogfood（真实语言服务器）**

```bash
npm run build
node --input-type=module -e '
import { loadConfig } from "./dist/lsp/config.js";
const config = loadConfig(process.cwd());
console.log(Object.keys(config.servers));
'
```

Expected: 输出包含 `typescript-language-server` 与 `biome`（RunLedger 根目录有 `package.json` 与 `biome.json`，本地 bin 解析命中）。

- [ ] **Step 3: 真实 TUI 会话验证（真实 TTY，tmux 捕获）**

```bash
which runledger  # 确认指向本仓库;缺失先 npm link
tmux new-session -d -s lsp-smoke 'runledger'
tmux send-keys -t lsp-smoke '/lsp' Enter
```

在会话中依次执行（由真实模型驱动或直接以工具调用形式）：
1. `lsp status` → 列出配置服务；
2. `lsp diagnostics file=src/lsp/tool.ts` → 返回 typescript-language-server 与 biome 的诊断或 `OK`；
3. `lsp definition file=src/lsp/tool.ts line=<createLspTool 定义行> symbol=createLspTool` → 返回 `file:line:col` 定位。

Expected: 三项均返回真实结果文本；`tmux capture-pane -t lsp-smoke -p` 截帧留档；结束后 `tmux kill-session -t lsp-smoke`。

- [x] **Step 4: 状态表回写**（状态表与索引已回写；真实服务/TUI smoke pending，计划归档暂缓）

把验收结果回写本文档状态表（通过/失败 + 证据截帧路径）；确认 `development-doc/00-index.md` 已含本计划行。

- [ ] **Step 5: 提交验收证据（如产生 devDependency 变更）**

```bash
git add -- package.json package-lock.json
git commit -m "lsp: dogfood 依赖 typescript-language-server"
```

---

## 状态表

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| P0 | 类型/契约 + stdio 传输 | 已实现/验证 | `npm run check`；`tests/lsp/transport.test.ts` |
| P1 | defaults(20) + 配置加载/自动探测 | 已实现/验证 | `tests/lsp/config.test.ts`；全量门禁 |
| P2 | 客户端生命周期 | 已实现/验证 | `tests/lsp/client.test.ts`；全量门禁 |
| P3 | 只读 lsp 工具 | 已实现/验证 | `tests/lsp/utils.test.ts`、`tool-read.test.ts`；全量门禁 |
| P4 | 写动作 + 治理接缝 | 已实现/验证 | `tests/lsp/edits.test.ts`、`tool-write.test.ts`；全量门禁 |
| P5 | LinterClient 适配 + rust-analyzer 轮询 | 已实现/验证 | `tests/lsp/clients.test.ts`、`client.test.ts`；全量门禁 |
| P6 | 生产接线 | 已修复/自动验证 | managed LSP/linter、governed filesystem、Session isolation 与 authorization 回归；focused 12 files / 94 tests；fresh check/test/build |
| P7 | 真实验收与门禁 | 部分完成 | fresh 标准入口与隔离 TTY 已通过；旧 standalone rust-analyzer（ready + 66 symbols）仅为历史证据；修复后 Session-managed rust-analyzer、TUI LSP 动作与缺失二进制 dogfood pending |

## 测试矩阵（完成后预期）

| 文件 | 用例数 |
|---|---|
| `tests/lsp/transport.test.ts` | 3 |
| `tests/lsp/config.test.ts` | 7 |
| `tests/lsp/client.test.ts` | 6 |
| `tests/lsp/utils.test.ts` | 9 |
| `tests/lsp/tool-read.test.ts` | 6 |
| `tests/lsp/edits.test.ts` | 5 |
| `tests/lsp/tool-write.test.ts` | 5 |
| `tests/lsp/clients.test.ts` | 4 |
| `tests/runtime/session-runtime/lsp-composition.test.ts` | 3 |
| 合计 | 48 |

## 风险与已知限制

- `lsp` 工具无静态 capability claim：Plan Mode 下整体拒绝（fail-closed）。需要 Plan Mode 可用只读 LSP 时，后续 ADR 决定 split 两个工具或给 capability 系统加 per-action 分级。
- `formatStatus` 的 key 匹配依赖 `command:cwd` 客户端缓存键；跨 cwd 会话的状态展示以当前会话 cwd 为准。
- `runRenameFile` 只支持单文件（目录重命名与 `workspace/willRenameFiles` 多服务聚合留待后续）；`runDiagnostics` 无 glob 与 workspace 模式。
- vitest 单测全部走 FakeTransport/假 runner；真实 spawn 与真实服务仅 P7 smoke 覆盖。
