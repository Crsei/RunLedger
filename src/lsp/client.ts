/**
 * LSP 客户端生命周期 —— 从 pi coding-agent `src/lsp/client.ts` 适配。
 *
 * 当前版本裁剪:无 lspmux/共享 mux/动态能力注册/idle 回收;
 * 保留 initialize 握手、Content-Length 帧读取、pending 路由、诊断缓存、
 * $/progress 项目加载、初始化失败负缓存与崩溃恢复。
 */
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	LspProcessSpawner,
	LspServerCapabilities,
	PublishDiagnosticsParams,
	ServerConfig,
} from "./types.ts";
import { localLspSpawner, WARMUP_TIMEOUT_MS } from "./transport.ts";
import { detectLanguageId, fileToUri } from "./utils.ts";

export const PROJECT_LOAD_TIMEOUT_MS = 15_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const connectingClients = new Map<string, { scope: string; proc: LspClient["proc"] }>();
const initFailures = new Map<string, { at: number; message: string }>();

export interface LspClientOptions {
	spawn?: LspProcessSpawner;
	initTimeoutMs?: number;
	scope?: string;
	readFile?: (path: string) => Promise<string>;
}

const DEFAULT_CLIENT_SCOPE = "standalone";

export function clientKey(config: ServerConfig, cwd: string, scope = DEFAULT_CLIENT_SCOPE): string {
	return `${scope}:${config.command}:${cwd}`;
}

/** 显式 reload 后允许立即重试同 key 的初始化失败。 */
export function clearInitializationFailure(config: ServerConfig, cwd: string, scope?: string): void {
	initFailures.delete(clientKey(config, cwd, scope));
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
		applyEdit: false,
		workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"] },
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
		if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw new Error("invalid LSP content length");
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
	if (signal === undefined) {
		await client.writeQueue;
		return;
	}
	await Promise.race([
		client.writeQueue,
		new Promise<void>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("LSP write stalled")), DEFAULT_REQUEST_TIMEOUT_MS);
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
			client.writeQueue.then(() => clearTimeout(timer), () => clearTimeout(timer));
		}),
	]);
}

// ===== 读路径 =====

async function handleMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification,
): Promise<void> {
	if ("id" in message && "method" in message) {
		await handleServerRequest(client, message);
		return;
	}
	if ("id" in message) {
		const pending = client.pendingRequests.get(message.id);
		if (pending === undefined) return;
		client.pendingRequests.delete(message.id);
		if (message.error !== undefined) pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
		else pending.resolve(message.result);
		return;
	}
	if (message.method === "textDocument/publishDiagnostics") {
		const params = message.params as PublishDiagnosticsParams;
		client.diagnostics.set(params.uri, params);
		client.diagnosticsVersion += 1;
	} else if (message.method === "$/progress" && progressEnded(message.params)) {
		client.resolveProjectLoaded();
	}
}

function progressEnded(params: unknown): boolean {
	if (typeof params !== "object" || params === null) return false;
	const value = (params as { value?: unknown }).value;
	return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "end";
}

function configurationValue(settings: Record<string, unknown>, section: unknown): unknown {
	if (typeof section !== "string" || section.length === 0) return settings;
	let current: unknown = settings;
	for (const part of section.split(".")) {
		if (typeof current !== "object" || current === null || !(part in current)) return null;
		current = (current as Record<string, unknown>)[part];
	}
	return current ?? null;
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		const params = message.params as { items?: Array<{ section?: unknown }> } | undefined;
		const settings = client.config.settings ?? {};
		const result = (params?.items ?? []).map((item) => configurationValue(settings, item.section));
		await writeMessage(client, { jsonrpc: "2.0", id: message.id, result });
	} else if (message.method === "window/workDoneProgress/create") {
		await writeMessage(client, { jsonrpc: "2.0", id: message.id, result: null });
	} else if (message.method === "workspace/workspaceFolders") {
		await writeMessage(client, {
			jsonrpc: "2.0",
			id: message.id,
			result: [{ uri: fileToUri(client.cwd), name: path.basename(client.cwd) || "workspace" }],
		});
	} else {
		await writeMessage(client, {
			jsonrpc: "2.0",
			id: message.id,
			error: { code: -32601, message: `method not handled: ${message.method}` },
		});
	}
}

async function startMessageReader(client: LspClient): Promise<void> {
	const reader = client.proc.stdout.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			const { frames, rest } = extractFrames(concatBytes(client.messageBuffer, value));
			client.messageBuffer = rest;
			for (const frame of frames) {
				await handleMessage(client, JSON.parse(frame) as LspJsonRpcRequest | LspJsonRpcResponse | LspJsonRpcNotification);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// ===== 生命周期 =====

export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	options: LspClientOptions = {},
	signal?: AbortSignal,
): Promise<LspClient> {
	const scope = options.scope ?? DEFAULT_CLIENT_SCOPE;
	const key = clientKey(config, cwd, scope);
	const existing = clients.get(key);
	if (existing !== undefined) {
		existing.lastActivity = Date.now();
		return existing;
	}
	const existingLock = clientLocks.get(key);
	if (existingLock !== undefined) return existingLock;

	const recentFailure = initFailures.get(key);
	if (recentFailure !== undefined) {
		if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
			throw new Error(`LSP server ${config.command} failed to initialize recently: ${recentFailure.message}`);
		}
		initFailures.delete(key);
	}

	const spawner = options.spawn ?? localLspSpawner();
	const initTimeoutMs = options.initTimeoutMs ?? config.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS;

	const clientPromise = (async () => {
		const proc = await spawner.spawn(config.resolvedCommand ?? config.command, config.args ?? [], cwd, signal);
		connectingClients.set(key, { scope, proc });
		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>((resolve) => { resolveProjectLoaded = resolve; });
		const loadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(loadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			scope,
			cwd,
			config,
			readFile: options.readFile ?? (async (filePath) => readFile(filePath, "utf8")),
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
			if (client.pendingRequests.size === 0) return;
			const stderr = proc.peekStderr().trim();
			const error = new Error(stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`);
			for (const pending of client.pendingRequests.values()) pending.reject(error);
			client.pendingRequests.clear();
		});

		void startMessageReader(client).catch((error: unknown) => {
			client.status = "error";
			const message = error instanceof Error ? error.message : String(error);
			for (const pending of client.pendingRequests.values()) pending.reject(new Error(`LSP reader failed: ${message}`));
			client.pendingRequests.clear();
		});

		try {
			const initResult = await sendRequest(client, "initialize", {
				processId: process.pid,
				rootUri: fileToUri(cwd),
				rootPath: cwd,
				capabilities: CLIENT_CAPABILITIES,
				initializationOptions: config.initOptions ?? {},
				workspaceFolders: [{ uri: fileToUri(cwd), name: path.basename(cwd) || "workspace" }],
			}, signal, initTimeoutMs) as { capabilities?: unknown } | undefined;
			if (initResult === undefined) throw new Error("Failed to initialize LSP: no response");
			client.serverCapabilities = initResult.capabilities as LspServerCapabilities | undefined;
			await sendNotification(client, "initialized", {}, signal);
			await sendNotification(client, "workspace/didChangeConfiguration", { settings: config.settings ?? {} }, signal);
			client.status = "ready";
			clients.set(key, client);
			connectingClients.delete(key);
			initFailures.delete(key);
			return client;
		} catch (error: unknown) {
			client.status = "error";
			if (clients.get(key) === client) clients.delete(key);
			proc.kill();
			const message = error instanceof Error ? error.message : String(error);
			const transient = signal?.aborted === true || message.includes("timed out");
			if (!transient) initFailures.set(key, { at: Date.now(), message });
			throw error;
		} finally {
			connectingClients.delete(key);
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
	const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
	return new Promise<unknown>((resolve, reject) => {
		const onAbort = () => {
			client.pendingRequests.delete(id);
			reject(new Error(`LSP request ${method} timed out after ${timeout}ms`));
			void writeMessage(client, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }, signal).catch(() => undefined);
		};
		const settle = (callback: () => void) => {
			combined.removeEventListener("abort", onAbort);
			callback();
		};
		combined.addEventListener("abort", onAbort, { once: true });
		client.pendingRequests.set(id, {
			resolve: (result) => settle(() => resolve(result)),
			reject: (error) => settle(() => reject(error)),
			method,
		});
		if (combined.aborted) onAbort();
		void writeMessage(client, { jsonrpc: "2.0", id, method, params }, signal).catch((error: unknown) => {
			client.pendingRequests.delete(id);
			settle(() => reject(error instanceof Error ? error : new Error(String(error))));
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
	const languageId = client.config.languageId ?? detectLanguageId(filePath);
	await sendNotification(client, "textDocument/didOpen", {
		textDocument: { uri, languageId, version: 1, text: await readFileText(client, filePath) },
	}, signal);
	client.openFiles.set(uri, { version: 1, languageId });
	client.lastActivity = Date.now();
}

export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<number> {
	const uri = fileToUri(filePath);
	const open = client.openFiles.get(uri);
	const version = (open?.version ?? 0) + 1;
	await sendNotification(client, "textDocument/didChange", {
		textDocument: { uri, version },
		contentChanges: [{ text: await readFileText(client, filePath) }],
	}, signal);
	await sendNotification(client, "textDocument/didSave", { textDocument: { uri } }, signal);
	client.openFiles.set(uri, { version, languageId: open?.languageId ?? client.config.languageId ?? detectLanguageId(filePath) });
	return version;
}

export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	afterDiagnosticsVersion: number,
	documentVersion: number,
	signal?: AbortSignal,
	timeoutMs = 1_000,
): Promise<PublishDiagnosticsParams | undefined> {
	const deadline = Date.now() + timeoutMs;
	let observedVersion = afterDiagnosticsVersion;
	let settleAt: number | undefined;
	while (Date.now() < deadline) {
		if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		const current = client.diagnostics.get(uri);
		if (client.diagnosticsVersion > observedVersion) {
			observedVersion = client.diagnosticsVersion;
			if (current?.version !== undefined && current.version >= documentVersion) return current;
			settleAt = Date.now() + 50;
		}
		if (settleAt !== undefined && Date.now() >= settleAt) return current;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return client.diagnostics.get(uri);
}

const RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS = 5_000;
const RUST_ANALYZER_WORKSPACE_READY_POLL_MS = 100;
const RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS = 1_000;

function isRustAnalyzerClient(client: LspClient): boolean {
	return path.basename(client.config.resolvedCommand ?? client.config.command).includes("rust-analyzer");
}

/** rust-analyzer 项目加载结束后 workspace 未必就绪;轮询 analyzerStatus 直至 ready。 */
export async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (!isRustAnalyzerClient(client)) return;
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS;
	const pollMs = timings?.pollMs ?? RUST_ANALYZER_WORKSPACE_READY_POLL_MS;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() > deadline) return;
		if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		try {
			const status = await sendRequest(
				client,
				"rust-analyzer/analyzerStatus",
				{ textDocument: null },
				signal,
				timings?.statusRequestTimeoutMs ?? RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS,
			) as { status?: string };
			if (status.status === "ready") return;
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal === undefined) await client.projectLoaded;
	else await Promise.race([
		client.projectLoaded,
		new Promise<void>((_, reject) => {
			const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}),
	]);
	await waitForRustAnalyzerWorkspace(client, signal);
}

export async function shutdownClient(key: string): Promise<boolean> {
	const client = clients.get(key);
	if (client === undefined) {
		const connecting = connectingClients.get(key);
		if (connecting === undefined) return false;
		connectingClients.delete(key);
		connecting.proc.kill();
		return true;
	}
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

export async function shutdownAll(scope?: string): Promise<void> {
	const connectingKeys = [...connectingClients.entries()]
		.filter(([, connecting]) => scope === undefined || connecting.scope === scope)
		.map(([key]) => key);
	const keys = [...clients.entries()]
		.filter(([, client]) => scope === undefined || client.scope === scope)
		.map(([key]) => key);
	await Promise.allSettled([...connectingKeys, ...keys].map((key) => shutdownClient(key)));
}

export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
}

export function getActiveClients(scope?: string): LspServerStatus[] {
	return [...clients.values()]
		.filter((client) => scope === undefined || client.scope === scope)
		.map((client) => ({ name: client.name, status: client.status }));
}

async function readFileText(client: LspClient, filePath: string): Promise<string> {
	return client.readFile(filePath);
}
