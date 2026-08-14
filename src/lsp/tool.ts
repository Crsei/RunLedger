/**
 * lsp 工具 —— 从 pi coding-agent `src/lsp/index.ts` 适配为 RunLedger AgentTool。
 *
 * 治理接缝:
 *   - spawn:注入 LspProcessSpawner(生产走 Session managed process,P6);
 *   - writeOperations:注入 LspWriteOperations(生产走 governed ExecutionEnv.fs,P4/P6);
 *   - 工具内混合只读与写动作,当前整体以保守元数据注册。
 */
import type { Static } from "typebox";
import * as path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../runtime/types.ts";
import type { ToolContext } from "../runtime/tool-context.ts";
import {
	getServerForFile, getServersForFile, loadConfig,
} from "./config.ts";
import {
	clearInitializationFailure, clientKey, ensureFileOpen, getActiveClients, getOrCreateClient, refreshFile, sendNotification, sendRequest,
	shutdownClient,
	waitForDiagnostics, waitForProjectLoaded,
} from "./client.ts";
import { applyWorkspaceEdit, localLspWriteOperations } from "./edits.ts";
import { getLinterClient } from "./clients/index.ts";
import type {
	Diagnostic, DocumentSymbol, Hover, LinterClientFactory, LspClient, LspConfig, LspParams, LspProcessSpawner,
	LspToolDetails, LspWriteOperations, Position, Range, SymbolInformation, WorkspaceEdit,
} from "./types.ts";
import { lspSchema } from "./types.ts";
import { fileToUri, resolveSymbolColumnInText } from "./utils.ts";

export interface LspToolOptions {
	/** 测试注入:覆盖 loadConfig。 */
	getConfig?: (cwd: string) => LspConfig;
	/** 生产注入:governed spawner(P6)。缺省 localLspSpawner。 */
	spawn?: LspProcessSpawner;
	/** 生产注入:governed 写操作(P4-2 起使用,P6 接线)。 */
	writeOperations?: LspWriteOperations;
	/** 工具级超时(ms),默认 20_000,上限 300_000。 */
	timeoutMs?: number;
	/** SessionRuntime 注入的 client ownership scope。 */
	scope?: string;
	/** SessionRuntime 注入的 governed Biome/SwiftLint factories。 */
	linterFactories?: Partial<Record<"biome" | "swiftlint", LinterClientFactory>>;
}

export const LSP_TOOL_DEFAULT_TIMEOUT_MS = 20_000;

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const WORKSPACE_SYMBOL_LIMIT = 200;
const SEVERITY_LABELS: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

function configFor(cwd: string, options: LspToolOptions): LspConfig {
	return options.getConfig === undefined ? loadConfig(cwd, { linterFactories: options.linterFactories }) : options.getConfig(cwd);
}

async function clientForFile(
	cwd: string,
	filePath: string,
	config: LspConfig,
	options: LspToolOptions,
	signal?: AbortSignal,
): Promise<{ client: LspClient; serverName: string } | { error: string }> {
	const match = getServerForFile(config, filePath);
	if (match === null) return { error: `No language server configured for ${filePath}` };
	const [serverName, serverConfig] = match;
	const client = await getOrCreateClient(serverConfig, cwd, {
		spawn: options.spawn,
		scope: options.scope,
		readFile: options.writeOperations?.readFile,
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
		if (item === null || typeof item !== "object") continue;
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
		else if (value !== null && typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (typeof record.value === "string") parts.push(record.value);
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
	cwd: string,
	filePath: string,
	config: LspConfig,
	options: LspToolOptions,
	signal?: AbortSignal,
): Promise<string> {
	const servers = getServersForFile(config, filePath);
	if (servers.length === 0) return `No language server configured for ${filePath}`;
	const results: string[] = [];
	for (const [serverName, serverConfig] of servers) {
		if (serverConfig.createClient !== undefined) {
			const linterClient = getLinterClient(serverName, serverConfig, cwd, options.scope);
			const diagnostics = await linterClient.lint(filePath, signal);
			if (diagnostics.length > 0) results.push(`${serverName}:\n${formatDiagnostics(diagnostics)}`);
			continue;
		}
		const client = await getOrCreateClient(serverConfig, cwd, {
			spawn: options.spawn,
			scope: options.scope,
			readFile: options.writeOperations?.readFile,
		}, signal);
		await ensureFileOpen(client, filePath, signal);
		await waitForProjectLoaded(client, signal);
		const baseline = client.diagnosticsVersion;
		const documentVersion = await refreshFile(client, filePath, signal);
		const cached = await waitForDiagnostics(client, fileToUri(filePath), baseline, documentVersion, signal);
		const diagnostics = cached?.diagnostics ?? [];
		if (diagnostics.length > 0) results.push(`${serverName}:\n${formatDiagnostics(diagnostics)}`);
	}
	return results.length === 0 ? "OK" : results.join("\n\n");
}

export function createLspTool(cwd: string, options: LspToolOptions = {}): AgentTool<typeof lspSchema, LspToolDetails> {
	const timeoutMs = Math.min(Math.max(options.timeoutMs ?? LSP_TOOL_DEFAULT_TIMEOUT_MS, 1), 300_000);
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
			onUpdate?: AgentToolUpdateCallback<LspToolDetails>,
			context?: ToolContext,
		): Promise<AgentToolResult<LspToolDetails>> {
			void toolCallId;
			void onUpdate;
			void context;
			const actionTimeoutMs = params.timeout === undefined
				? timeoutMs
				: Math.min(Math.max(Math.round(params.timeout * 1_000), 1_000), 300_000);
			const actionSignal = AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(actionTimeoutMs)]);
			const config = configFor(cwd, options);
			try {
				const text = await dispatchAction(cwd, params, config, options, actionSignal);
				return { content: [{ type: "text", text }], details: { action: params.action, success: true } };
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `LSP error: ${message}` }], details: { action: params.action, success: false } };
			}
		},
	};
}

async function dispatchAction(
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	switch (params.action) {
		case "status":
			return formatStatus(config, cwd, options.scope);
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
			return runRename(cwd, params, config, options, signal);
		case "rename_file":
			return runRenameFile(cwd, params, config, options, signal);
		case "code_actions":
			return runCodeActions(cwd, params, config, options, signal);
		case "reload":
			return runReload(cwd, params, config, options, signal);
		case "request":
			return runRequest(cwd, params, config, options, signal);
	}
	throw new Error("unsupported LSP action");
}

function requireFile(params: LspParams): string {
	if (!params.file) throw new Error("file parameter required");
	return params.file;
}

async function resolveClientPosition(client: LspClient, filePath: string, line: number, symbol?: string): Promise<Position> {
	return resolveSymbolColumnInText(await client.readFile(filePath), filePath, line, symbol);
}

async function runDiagnosticsForParams(
	cwd: string, params: LspParams, config: LspConfig, options: LspToolOptions, signal: AbortSignal,
): Promise<string> {
	if (params.file === "*") throw new Error("workspace diagnostics not implemented");
	const filePath = path.resolve(cwd, requireFile(params));
	if (getServersForFile(config, filePath).length === 0) throw new Error(`No language server configured for ${filePath}`);
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
	const position = params.line === undefined ? undefined : await resolveClientPosition(client, filePath, params.line, params.symbol);
	const requestParams = method === "textDocument/references"
		? { textDocument: { uri: fileToUri(filePath) }, position, context: { includeDeclaration: true } }
		: { textDocument: { uri: fileToUri(filePath) }, position };
	const result = await sendRequest(client, method, requestParams, signal);
	const kind = method === "textDocument/references" ? "reference"
		: method === "textDocument/typeDefinition" ? "type definition"
			: method === "textDocument/implementation" ? "implementation" : "definition";
	return formatLocations(kind, normalizeLocationResult(result));
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
	const position = params.line === undefined ? undefined : await resolveClientPosition(client, filePath, params.line, params.symbol);
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
			if (serverConfig.createClient !== undefined || serverConfig.isLinter === true) continue;
			const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn, scope: options.scope, readFile: options.writeOperations?.readFile }, signal);
			const result = await sendRequest(client, "workspace/symbol", { query: params.query }, signal) as SymbolInformation[];
			for (const symbol of result.slice(0, WORKSPACE_SYMBOL_LIMIT)) lines.push(`${symbol.name} @ ${symbol.location.uri}${formatRange(symbol.location.range)}`);
		}
		return lines.length === 0 ? `No symbols found matching "${params.query}"` : `Found ${lines.length} symbol(s) matching "${params.query}":\n${lines.join("\n")}`;
	}
	const filePath = path.resolve(cwd, requireFile(params));
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	const result = await sendRequest(client, "textDocument/documentSymbol", { textDocument: { uri: fileToUri(filePath) } }, signal) as Array<DocumentSymbol | SymbolInformation>;
	return formatDocumentSymbols(result);
}

function formatStatus(config: LspConfig, cwd: string, scope?: string): string {
	if (Object.keys(config.servers).length === 0) return "No language servers configured for this project";
	const active = new Map(getActiveClients(scope).map((client) => [client.name, client.status]));
	const lines = Object.entries(config.servers).map(([name, server]) => {
		const key = clientKey(server, cwd, scope);
		return `${name} (${active.get(key) ?? "configured, not started"})`;
	});
	return `Language servers:\n${lines.join("\n")}`;
}

async function formatCapabilities(
	cwd: string,
	config: LspConfig,
	options: LspToolOptions,
	file: string | undefined,
	signal: AbortSignal,
): Promise<string> {
	const targets: Array<[string, LspConfig["servers"][string]]> = file !== undefined && file !== "*"
		? getServersForFile(config, file).filter(([, server]) => server.createClient === undefined)
		: Object.entries(config.servers).filter(([, server]) => server.createClient === undefined);
	if (targets.length === 0) return "No language servers configured for this project";
	const lines: string[] = [];
	for (const [serverName, serverConfig] of targets) {
		const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn, scope: options.scope, readFile: options.writeOperations?.readFile }, signal);
		lines.push(`${serverName}:\n  capabilities: ${JSON.stringify(client.serverCapabilities ?? {})}`);
	}
	return lines.join("\n");
}

async function runRename(
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	if (!params.new_name) throw new Error("new_name parameter required for rename");
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client, serverName } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	await waitForProjectLoaded(client, signal);
	if (params.line !== undefined && params.symbol === undefined) throw new Error("symbol parameter required when line is given for rename");
	const position = params.line === undefined ? undefined : await resolveClientPosition(client, filePath, params.line, params.symbol);
	const edit = await sendRequest(client, "textDocument/rename", {
		textDocument: { uri: fileToUri(filePath) }, position, newName: params.new_name,
	}, signal) as WorkspaceEdit | null;
	if (edit === null) return "Rename returned no edits";
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
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	const source = path.resolve(cwd, requireFile(params));
	if (!params.new_name) throw new Error("new_name parameter required for rename_file");
	const destination = path.resolve(cwd, params.new_name);
	if (source === destination) throw new Error("source and destination are identical");
	const ops = options.writeOperations ?? localLspWriteOperations();
	try { await ops.readFile(source); } catch { throw new Error(`source does not exist or is not readable: ${source}`); }
	let destinationExists = true;
	try { await ops.readFile(destination); } catch { destinationExists = false; }
	if (destinationExists) throw new Error(`destination already exists: ${destination}`);
	if (params.apply === false) return `Rename preview: ${source} -> ${destination}`;
	await ops.renameFile(source, destination);
	for (const serverConfig of Object.values(config.servers)) {
		if (serverConfig.createClient !== undefined) continue;
		if (!serverConfig.fileTypes.some((type) => source.endsWith(type) || destination.endsWith(type))) continue;
		try {
			const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn, scope: options.scope, readFile: options.writeOperations?.readFile }, signal);
			await sendNotification(client, "workspace/didRenameFiles", {
				files: [{ oldUri: fileToUri(source), newUri: fileToUri(destination) }],
			}, signal);
		} catch {
			// 文件重命名已经经 ops 成功,服务端索引通知失败不回滚该副作用。
		}
	}
	return `Renamed ${source} -> ${destination}`;
}

async function runCodeActions(
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	const filePath = path.resolve(cwd, requireFile(params));
	const lookedUp = await clientForFile(cwd, filePath, config, options, signal);
	if ("error" in lookedUp) return lookedUp.error;
	const { client } = lookedUp;
	await ensureFileOpen(client, filePath, signal);
	const position = params.line === undefined ? undefined : await resolveClientPosition(client, filePath, params.line, params.symbol);
	const uri = fileToUri(filePath);
	const point = position ?? { line: 0, character: 0 };
	const cached = client.diagnostics.get(uri)?.diagnostics ?? [];
	const actions = await sendRequest(client, "textDocument/codeAction", {
		textDocument: { uri },
		range: { start: point, end: point },
		context: { diagnostics: cached, only: params.query ? [params.query] : undefined },
	}, signal) as Array<{ title: string; kind?: string; edit?: WorkspaceEdit; command?: { title: string; command: string; arguments?: unknown[] } }> | null;
	if (actions === null || actions.length === 0) return "No code actions available";
	if (params.apply !== true) {
		return `${actions.length} code action(s):\n${actions.map((action, index) => `${index}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	}
	if (!params.query) return `${actions.length} code action(s) (query selector required to apply):\n${actions.map((action, index) => `${index}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	const index = /^\d+$/u.test(params.query) ? Number(params.query) : actions.findIndex((action) => action.title.toLowerCase().includes(params.query!.toLowerCase()));
	const selected = actions[index];
	if (selected === undefined) return `No code action matches "${params.query}". Available actions:\n${actions.map((action, i) => `${i}: [${action.kind ?? "quickfix"}] ${action.title}`).join("\n")}`;
	const ops = options.writeOperations ?? localLspWriteOperations();
	const parts: string[] = [];
	if (selected.edit !== undefined) parts.push(...await applyWorkspaceEdit(client, selected.edit, ops, signal));
	if (selected.command !== undefined) {
		await sendRequest(client, "workspace/executeCommand", { command: selected.command.command, arguments: selected.command.arguments ?? [] }, signal);
		parts.push(`executed ${selected.command.command}`);
	}
	if (parts.length === 0) return `Action "${selected.title}" has no workspace edit or command to apply`;
	return `Applied "${selected.title}":\n${parts.join("\n")}`;
}

async function runReload(
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	const targets: Array<[string, LspConfig["servers"][string]]> = params.file !== undefined && params.file !== "*"
		? getServersForFile(config, params.file).filter(([, server]) => server.createClient === undefined)
		: Object.entries(config.servers).filter(([, server]) => server.createClient === undefined);
	const lines: string[] = [];
	for (const [serverName, serverConfig] of targets) {
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		clearInitializationFailure(serverConfig, cwd, options.scope);
		await shutdownClient(clientKey(serverConfig, cwd, options.scope));
		lines.push(`Restarted ${serverName} (cold restart on next request)`);
	}
	void options;
	return lines.join("\n");
}

async function runRequest(
	cwd: string,
	params: LspParams,
	config: LspConfig,
	options: LspToolOptions,
	signal: AbortSignal,
): Promise<string> {
	if (!params.query) throw new Error("query parameter required for request");
	let target: [string, LspConfig["servers"][string]] | undefined;
	if (params.file !== undefined && params.file !== "*") {
		const match = getServerForFile(config, params.file);
		if (match !== null && match[1].createClient === undefined) target = match;
	} else {
		target = Object.entries(config.servers).find(([, server]) => server.createClient === undefined);
	}
	if (target === undefined) return "No language server available for request";
	const [serverName, serverConfig] = target;
	const client = await getOrCreateClient(serverConfig, cwd, { spawn: options.spawn, scope: options.scope, readFile: options.writeOperations?.readFile }, signal);
	let requestParams: unknown = {};
	if (params.payload !== undefined) requestParams = JSON.parse(params.payload) as unknown;
	else if (params.file !== undefined && params.file !== "*") {
		const filePath = path.resolve(cwd, params.file);
		await ensureFileOpen(client, filePath, signal);
		const position = params.line === undefined ? undefined : await resolveClientPosition(client, filePath, params.line, params.symbol);
		requestParams = position === undefined ? { textDocument: { uri: fileToUri(filePath) } } : { textDocument: { uri: fileToUri(filePath) }, position };
	}
	const result = await sendRequest(client, params.query, requestParams, signal);
	const formatted = typeof result === "string" ? result : JSON.stringify(result, null, 2);
	return `${serverName} <- ${params.query}:\n${formatted ?? "null"}`;
}
