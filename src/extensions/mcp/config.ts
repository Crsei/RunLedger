/** Current-format MCP configuration loader owned by the resident Host. */

import { dirname, relative, resolve } from "node:path";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { extensionDiagnostic, sortExtensionDiagnostics, type ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import type { McpServerConfig, McpTransport } from "./types.ts";

const SERVER_KEYS = new Set([
	"transport", "command", "args", "cwd", "env", "url", "headers", "enabled", "required",
	"startupTimeoutMs", "toolTimeoutMs", "toolTimeouts", "enabledTools", "disabledTools", "maxResultBytes",
	"supportsParallelToolCalls",
]);
const DOCUMENT_KEYS = new Set(["mcpServers"]);
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
const RESERVED_ENV_PREFIX = "RUNLEDGER_";
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_SERVERS = 128;

export type McpConfigSource = "user" | "workspace" | "plugin" | "repo";

export interface McpConfigParseOptions {
	readonly source: McpConfigSource;
	readonly path: string;
	readonly rootPath?: string;
	readonly serverIdPrefix?: string;
	readonly trusted?: boolean;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface McpConfigParseResult {
	readonly ok: boolean;
	readonly configs: readonly McpServerConfig[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly digest: ReturnType<typeof runtimeDigest>;
	readonly declaredNames: readonly string[];
}

export interface CanonicalMcpConfigLoadOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly storage: ExtensionStoragePort;
	readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CanonicalMcpConfigLoadResult {
	readonly configs: readonly McpServerConfig[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly digest: ReturnType<typeof runtimeDigest>;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function positiveInteger(value: unknown, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function diagnostic(code: string, message: string, path: string): ExtensionDiagnostic {
	return extensionDiagnostic({ code, severity: "error", message, source: "mcp", path });
}

function contained(root: string, candidate: string): boolean {
	const offset = relative(root, candidate);
	return offset === "" || (!offset.startsWith("..") && !candidate.includes("\0"));
}

function resolveTemplate(value: string, options: McpConfigParseOptions, diagnostics: ExtensionDiagnostic[], fieldPath: string): string | undefined {
	let valid = true;
	const resolved = value.replace(VARIABLE, (_whole, name: string) => {
		if (name.startsWith(RESERVED_ENV_PREFIX)) {
			diagnostics.push(diagnostic("mcp.reserved_env", "reserved RUNLEDGER_ environment keys cannot be injected", fieldPath));
			valid = false;
			return "";
		}
		const environment = options.environment ?? process.env;
		const replacement = environment[name];
		if (replacement === undefined) {
			diagnostics.push(diagnostic("mcp.missing_env", "MCP environment template is not available", fieldPath));
			valid = false;
			return "";
		}
		return replacement;
	});
	return valid ? resolved : undefined;
}

function resolvePath(value: unknown, options: McpConfigParseOptions, diagnostics: ExtensionDiagnostic[], fieldPath: string): string | undefined {
	if (value === undefined) return options.rootPath ?? dirname(resolve(options.path));
	if (!boundedText(value, 4_096)) {
		diagnostics.push(diagnostic("mcp.cwd_invalid", "cwd must be a bounded string", fieldPath));
		return undefined;
	}
	const templated = resolveTemplate(value, options, diagnostics, fieldPath);
	if (templated === undefined) return undefined;
	const root = resolve(options.rootPath ?? dirname(resolve(options.path)));
	const candidate = resolve(root, templated);
	if (!contained(root, candidate)) {
		diagnostics.push(diagnostic("mcp.cwd_escape", "MCP cwd escapes its configuration root", fieldPath));
		return undefined;
	}
	return candidate;
}

function parseStringList(value: unknown, maxItems: number, maxItemBytes: number, diagnostics: ExtensionDiagnostic[], fieldPath: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => boundedText(item, maxItemBytes))) {
		diagnostics.push(diagnostic("mcp.list_invalid", "MCP list field contains invalid or oversized values", fieldPath));
		return undefined;
	}
	return value as string[];
}

function parseEnvironment(value: unknown, options: McpConfigParseOptions, diagnostics: ExtensionDiagnostic[], fieldPath: string): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).length > 128) {
		diagnostics.push(diagnostic("mcp.env_invalid", "MCP env must be a bounded object", fieldPath));
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const key of Object.keys(value).sort()) {
		const raw = value[key];
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !boundedText(raw, 8_192)) {
			diagnostics.push(diagnostic("mcp.env_invalid", "MCP env keys and values must be bounded", `${fieldPath}.${key}`));
			continue;
		}
		const resolved = resolveTemplate(raw, options, diagnostics, `${fieldPath}.${key}`);
		if (resolved !== undefined) result[key] = resolved;
	}
	return result;
}

function parseHeaders(value: unknown, options: McpConfigParseOptions, diagnostics: ExtensionDiagnostic[], fieldPath: string): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return undefined;
	if (!record(value) || Object.keys(value).length > 64) {
		diagnostics.push(diagnostic("mcp.headers_invalid", "MCP headers must be a bounded object", fieldPath));
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const key of Object.keys(value).sort()) {
		const raw = value[key];
		if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u.test(key) || !boundedText(raw, 8_192)) {
			diagnostics.push(diagnostic("mcp.headers_invalid", "MCP header names and values must be bounded", `${fieldPath}.${key}`));
			continue;
		}
		const resolved = resolveTemplate(raw, options, diagnostics, `${fieldPath}.${key}`);
		if (resolved !== undefined) result[key] = resolved;
	}
	return result;
}

function parseTimeout(value: unknown, fallback: number, diagnostics: ExtensionDiagnostic, fieldPath: string): number {
	if (value === undefined) return fallback;
	if (!positiveInteger(value, MAX_TIMEOUT_MS)) {
		return fallback;
	}
	void diagnostics;
	void fieldPath;
	return value;
}

function parseServer(
	name: string,
	value: unknown,
	options: McpConfigParseOptions,
	diagnostics: ExtensionDiagnostic[],
): McpServerConfig | undefined {
	const fieldPath = `${options.path}#/mcpServers/${name}`;
	if (!record(value)) {
		diagnostics.push(diagnostic("mcp.server_invalid", "MCP server entry must be an object", fieldPath));
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (!SERVER_KEYS.has(key)) diagnostics.push(diagnostic("mcp.unknown_field", `unknown MCP server field: ${key}`, `${fieldPath}/${key}`));
	}
	const transport = value.transport;
	if (transport !== "stdio" && transport !== "streamable-http") {
		diagnostics.push(diagnostic("mcp.transport_invalid", "MCP transport must be stdio or streamable-http", `${fieldPath}/transport`));
		return undefined;
	}
	const enabled = value.enabled === true;
	const required = value.required === true;
	const startupTimeoutMs = parseTimeout(value.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, diagnostics[0] ?? diagnostic("mcp.timeout_invalid", "MCP timeout is invalid", fieldPath), `${fieldPath}/startupTimeoutMs`);
	const toolTimeoutMs = parseTimeout(value.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS, diagnostics[0] ?? diagnostic("mcp.timeout_invalid", "MCP timeout is invalid", fieldPath), `${fieldPath}/toolTimeoutMs`);
	if (value.startupTimeoutMs !== undefined && !positiveInteger(value.startupTimeoutMs, MAX_TIMEOUT_MS)) diagnostics.push(diagnostic("mcp.timeout_invalid", "startupTimeoutMs must be a positive bounded integer", `${fieldPath}/startupTimeoutMs`));
	if (value.toolTimeoutMs !== undefined && !positiveInteger(value.toolTimeoutMs, MAX_TIMEOUT_MS)) diagnostics.push(diagnostic("mcp.timeout_invalid", "toolTimeoutMs must be a positive bounded integer", `${fieldPath}/toolTimeoutMs`));
	const args = parseStringList(value.args, 128, 4_096, diagnostics, `${fieldPath}/args`);
	const enabledTools = parseStringList(value.enabledTools, 512, 256, diagnostics, `${fieldPath}/enabledTools`);
	const disabledTools = parseStringList(value.disabledTools, 512, 256, diagnostics, `${fieldPath}/disabledTools`);
	const env = parseEnvironment(value.env, options, diagnostics, `${fieldPath}/env`);
	const headers = parseHeaders(value.headers, options, diagnostics, `${fieldPath}/headers`);
	const cwd = resolvePath(value.cwd, options, diagnostics, `${fieldPath}/cwd`);
	const serverId = `${options.serverIdPrefix ?? `mcp-server:${options.source}`}:${name}`;
	if (transport === "stdio") {
		if (!boundedText(value.command, 1_024)) diagnostics.push(diagnostic("mcp.command_invalid", "stdio MCP command is required and bounded", `${fieldPath}/command`));
		if (value.url !== undefined) diagnostics.push(diagnostic("mcp.transport_field", "stdio MCP server cannot define url", `${fieldPath}/url`));
	} else {
		if (!boundedText(value.url, 4_096)) diagnostics.push(diagnostic("mcp.url_invalid", "Streamable HTTP MCP url is required and bounded", `${fieldPath}/url`));
		else {
			try {
				const parsed = new URL(value.url);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
			} catch {
				diagnostics.push(diagnostic("mcp.url_invalid", "MCP url must use http or https", `${fieldPath}/url`));
			}
		}
		if (value.command !== undefined) diagnostics.push(diagnostic("mcp.transport_field", "Streamable HTTP MCP server cannot define command", `${fieldPath}/command`));
	}
	const toolTimeouts: Record<string, number> = {};
	if (value.toolTimeouts !== undefined) {
		if (!record(value.toolTimeouts) || Object.keys(value.toolTimeouts).length > 512) diagnostics.push(diagnostic("mcp.tool_timeouts_invalid", "toolTimeouts must be a bounded object", `${fieldPath}/toolTimeouts`));
		else for (const key of Object.keys(value.toolTimeouts).sort()) {
			const timeout = value.toolTimeouts[key];
			if (!positiveInteger(timeout, MAX_TIMEOUT_MS)) diagnostics.push(diagnostic("mcp.tool_timeout_invalid", "per-tool timeout is invalid", `${fieldPath}/toolTimeouts/${key}`));
			else toolTimeouts[key] = timeout;
		}
	}
	if (value.maxResultBytes !== undefined && !positiveInteger(value.maxResultBytes, MAX_RESULT_BYTES)) diagnostics.push(diagnostic("mcp.result_limit_invalid", "maxResultBytes is invalid", `${fieldPath}/maxResultBytes`));
	const hasError = diagnostics.some((item) => item.path?.startsWith(fieldPath));
	if (hasError || cwd === undefined) return undefined;
	return {
		serverId,
		displayName: name,
		transport: transport as McpTransport,
		enabled,
		trusted: options.trusted ?? (options.source === "user" || options.source === "workspace"),
		required,
		startupTimeoutMs,
		toolTimeoutMs,
		...(Object.keys(toolTimeouts).length === 0 ? {} : { toolTimeouts }),
		...(enabledTools === undefined ? {} : { enabledTools }),
		...(disabledTools === undefined ? {} : { disabledTools }),
		...(value.maxResultBytes === undefined ? {} : { maxResultBytes: value.maxResultBytes as number }),
		...(value.supportsParallelToolCalls === undefined ? {} : { supportsParallelToolCalls: value.supportsParallelToolCalls === true }),
		...(transport === "stdio"
			? { stdio: { command: value.command as string, ...(args === undefined ? {} : { args }), ...(env === undefined ? {} : { env }), cwd } }
			: { url: value.url as string, ...(headers === undefined ? {} : { headers }) }),
	};
}

export function parseMcpConfigDocument(value: unknown, options: McpConfigParseOptions): McpConfigParseResult {
	const diagnostics: ExtensionDiagnostic[] = [];
	const declaredNames = record(value) && record(value.mcpServers) ? Object.keys(value.mcpServers).sort() : [];
	if (!record(value)) diagnostics.push(diagnostic("mcp.document_invalid", "MCP config must be an object", options.path));
	else {
		for (const key of Object.keys(value)) if (!DOCUMENT_KEYS.has(key)) diagnostics.push(diagnostic("mcp.unknown_field", `unknown MCP config field: ${key}`, `${options.path}#/${key}`));
		if (!record(value.mcpServers)) diagnostics.push(diagnostic("mcp.servers_invalid", "mcpServers must be an object", `${options.path}#/mcpServers`));
		else if (declaredNames.length > MAX_SERVERS) diagnostics.push(diagnostic("mcp.servers_limit", "mcpServers exceeds the server bound", `${options.path}#/mcpServers`));
	}
	const configs: McpServerConfig[] = [];
	if (record(value) && record(value.mcpServers)) {
		for (const name of declaredNames) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u.test(name)) {
				diagnostics.push(diagnostic("mcp.name_invalid", "MCP server name is invalid", `${options.path}#/mcpServers/${name}`));
				continue;
			}
			const config = parseServer(name, value.mcpServers[name], options, diagnostics);
			if (config !== undefined) configs.push(config);
		}
	}
	const sorted = sortExtensionDiagnostics(diagnostics);
	return {
		ok: sorted.every((item) => item.severity !== "error"),
		configs: sorted.some((item) => item.severity === "error") ? [] : configs.sort((left, right) => left.serverId.localeCompare(right.serverId)),
		diagnostics: sorted,
		digest: runtimeDigest(value),
		declaredNames,
	};
}

async function readCanonicalFile(storage: ExtensionStoragePort, path: string, options: McpConfigParseOptions): Promise<McpConfigParseResult | undefined> {
	const bytes = await storage.readFile(path, 4 * 1024 * 1024);
	if (!bytes.ok) {
		if (bytes.code === "missing") return undefined;
		return { ok: false, configs: [], diagnostics: [diagnostic("mcp.read_failed", "MCP config could not be read", path)], digest: runtimeDigest({ path, unreadable: true }), declaredNames: [] };
	}
	const text = new TextDecoder().decode(bytes.value);
	try {
		return parseMcpConfigDocument(JSON.parse(text) as unknown, options);
	} catch {
		return { ok: false, configs: [], diagnostics: [diagnostic("mcp.json_invalid", "MCP config is not valid JSON", path)], digest: runtimeDigest({ path, invalid: true }), declaredNames: [] };
	}
}

export async function loadCanonicalMcpConfigs(options: CanonicalMcpConfigLoadOptions): Promise<CanonicalMcpConfigLoadResult> {
	const locations = [
		{ source: "user" as const, path: resolve(options.layout.state, "extensions", "user", "mcp.json"), prefix: "mcp-server:user" },
		{ source: "workspace" as const, path: resolve(options.layout.state, "extensions", "workspaces", options.workspaceStorageKey, "mcp.json"), prefix: "mcp-server:workspace" },
	];
	const configs = new Map<string, McpServerConfig>();
	const blocked = new Set<string>();
	const diagnostics: ExtensionDiagnostic[] = [];
	for (const location of locations) {
		const parsed = await readCanonicalFile(options.storage, location.path, { source: location.source, path: location.path, serverIdPrefix: location.prefix, trusted: true, environment: options.environment });
		if (parsed === undefined) continue;
		diagnostics.push(...parsed.diagnostics);
		if (!parsed.ok) for (const name of parsed.declaredNames) { blocked.add(name); configs.delete(name); }
		for (const config of parsed.configs) {
			const name = config.displayName;
			blocked.delete(name);
			configs.set(name, config);
		}
	}
	for (const name of blocked) configs.delete(name);
	return {
		configs: [...configs.values()].sort((left, right) => left.serverId.localeCompare(right.serverId)),
		diagnostics: sortExtensionDiagnostics(diagnostics),
		digest: runtimeDigest({ locations: locations.map((location) => location.path), configs: [...configs.values()] }),
	};
}
