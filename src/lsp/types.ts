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

export type DiagnosticSeverity = 1 | 2 | 3 | 4;

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
	scope: string;
	cwd: string;
	config: ServerConfig;
	readFile(path: string): Promise<string>;
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
	file: Type.Optional(Type.String({ description: "文件路径;symbols/request 的 workspace 形态可用 \"*\";diagnostics 仅支持单文件" })),
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
