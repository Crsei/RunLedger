/** MCP v1 配置解析、层级身份、secret 模板与 capability binding。 */

import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../runtime/protocol/v3/ids.ts";
import type { ResourceCapabilityDeclaration } from "../../runtime/resources/types.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import {
	createExtensionResourceIdentity,
	createExtensionResourceProvenance,
	qualifiedResourceId,
} from "../identity.ts";
import { resolveContainedPath, resolveDeclaredPath } from "../paths.ts";
import { McpConfigSchema, schemaAccepts } from "../schemas.ts";
import type { ExtensionStoragePort } from "../storage-port.ts";
import { buildResourceManifestDigest, digestFile, sha256 } from "../trust/digest.ts";
import type { TrustStore } from "../trust/trust-store.ts";
import type { ExtensionRuntimeScope, ExtensionSourceRoot, ExtensionStateDocument } from "../types.ts";
import type { McpConfigLoadResult, McpHttpConfig, McpServerConfig, McpServerDescriptor, McpStdioConfig } from "./types.ts";

interface RawMcpCommon {
	enabled?: boolean;
	required?: boolean;
	startupTimeoutMs?: number;
	toolTimeoutMs?: number;
	toolTimeouts?: Record<string, number>;
	enabledTools?: string[];
	disabledTools?: string[];
	pinnedTools?: string[];
	supportsParallelToolCalls?: boolean;
}

interface RawMcpStdio extends RawMcpCommon {
	transport: "stdio";
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

interface RawMcpHttp extends RawMcpCommon {
	transport: "streamable-http" | "sse";
	url: string;
	headers?: Record<string, string>;
	bearerTokenEnvVar?: string;
	legacyTransportExplicitlyEnabled?: true;
}

type RawMcpServer = RawMcpStdio | RawMcpHttp;

function common(raw: RawMcpCommon) {
	return {
		enabled: raw.enabled !== false,
		required: raw.required === true,
		startupTimeoutMs: raw.startupTimeoutMs ?? 30_000,
		toolTimeoutMs: raw.toolTimeoutMs ?? 120_000,
		toolTimeouts: raw.toolTimeouts ?? {},
		...(raw.enabledTools ? { enabledTools: raw.enabledTools } : {}),
		disabledTools: raw.disabledTools ?? [],
		pinnedTools: raw.pinnedTools ?? [],
		supportsParallelToolCalls: raw.supportsParallelToolCalls === true,
	};
}

function resolveTemplates(value: string, environment: Readonly<Record<string, string | undefined>>): { ok: true; value: string } | { ok: false; missing?: string } {
	if (value.includes("$(")) return { ok: false };
	let missing: string | undefined;
	const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_whole, name: string) => {
		const replacement = environment[name];
		if (replacement === undefined) {
			missing = name;
			return "";
		}
		return replacement;
	});
	return missing ? { ok: false, missing } : { ok: true, value: resolved };
}

function capability(scope: ExtensionRuntimeScope, qualifiedId: string, kind: "process" | "network" | "credential", digest: string): ResourceCapabilityDeclaration {
	const name = kind === "process" ? "process" : kind === "network" ? "network" : "credential";
	const boundary = kind === "process"
		? { kind: "process" as const, access: "spawn" as const, commandScopeDigest: digest }
		: kind === "network"
			? { kind: "network" as const, access: "connect" as const, hostScopeDigest: digest }
			: { kind: "credential" as const, access: "use" as const, credentialScopeDigest: digest };
	return { authorityId: scope.authorityId, tenantId: scope.tenantId, capabilityId: createRuntimeId("resource", canonicalDigest({ qualifiedId, kind, digest }).slice(0, 32)), claim: { authorityId: scope.authorityId, tenantId: scope.tenantId, name, resourceKind: kind, resourceDigest: digest, constraintsDigest: digest }, boundary, required: true };
}

async function normalizeServer(options: {
	raw: RawMcpServer;
	name: string;
	configPath: string;
	root: ExtensionSourceRoot;
	storage: ExtensionStoragePort;
	environment: Readonly<Record<string, string | undefined>>;
	pluginRoot?: string;
}): Promise<{ config?: McpServerConfig; identityDigest?: string; diagnostics: ExtensionDiagnostic[]; capabilities: Array<{ kind: "process" | "network" | "credential"; digest: string }> }> {
	const diagnostics: ExtensionDiagnostic[] = [];
	const capabilities: Array<{ kind: "process" | "network" | "credential"; digest: string }> = [];
	if (options.raw.transport === "stdio") {
		let cwd = options.pluginRoot ?? dirname(options.configPath);
		if (options.raw.cwd) {
			if (isAbsolute(options.raw.cwd)) return { diagnostics: [extensionDiagnostic("mcp.cwd_absolute", "error", "MCP cwd must be relative", "mcp", options.configPath)], capabilities };
			const cwdResult = await resolveContainedPath(options.storage, options.pluginRoot ?? dirname(options.configPath), options.raw.cwd);
			if (!cwdResult.ok) return { diagnostics: [extensionDiagnostic("mcp.cwd_escape", "error", cwdResult.message, "mcp", options.configPath)], capabilities };
			cwd = cwdResult.path;
		}
		let command = options.raw.command;
		let commandDigest = sha256(command);
		if (command.startsWith("./")) {
			const result = await resolveDeclaredPath(options.storage, options.pluginRoot ?? dirname(options.configPath), command);
			if (!result.ok) return { diagnostics: [extensionDiagnostic("mcp.command_escape", "error", result.message, "mcp", options.configPath)], capabilities };
			command = result.path;
			const digest = await digestFile(options.storage, command, DEFAULT_EXTENSION_LIMITS.maxFileBytes);
			if (!digest.ok) return { diagnostics: [extensionDiagnostic("mcp.command_digest", "error", digest.message, "mcp", options.configPath)], capabilities };
			commandDigest = digest.digest;
		} else if (isAbsolute(command)) {
			return { diagnostics: [extensionDiagnostic("mcp.command_absolute", "error", "absolute MCP command is not allowed", "mcp", options.configPath)], capabilities };
		}
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(options.raw.env ?? {})) {
			const resolved = resolveTemplates(value, options.environment);
			if (!resolved.ok) {
				diagnostics.push(extensionDiagnostic("mcp.env_missing", "error", `MCP environment template is unresolved${resolved.missing ? `: ${resolved.missing}` : ""}`, "mcp", options.configPath));
				continue;
			}
			env[key] = resolved.value;
		}
		if (diagnostics.some((item) => item.severity === "error")) return { diagnostics, capabilities };
		capabilities.push({ kind: "process", digest: commandDigest });
		if (Object.keys(env).length > 0) capabilities.push({ kind: "credential", digest: canonicalDigest(Object.keys(env).sort()) });
		const config: McpStdioConfig = { transport: "stdio", command, args: options.raw.args ?? [], cwd, env, commandDigest, ...common(options.raw) };
		return { config, identityDigest: canonicalDigest({ ...config, env: Object.keys(env).sort() }), diagnostics, capabilities };
	}
	let url: URL;
	try {
		url = new URL(options.raw.url);
	} catch {
		return { diagnostics: [extensionDiagnostic("mcp.url_invalid", "error", "MCP URL is invalid", "mcp", options.configPath)], capabilities };
	}
	const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return { diagnostics: [extensionDiagnostic("mcp.url_insecure", "error", "MCP URL must use HTTPS except loopback", "mcp", options.configPath)], capabilities };
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.raw.headers ?? {})) {
		const resolved = resolveTemplates(value, options.environment);
		if (!resolved.ok) diagnostics.push(extensionDiagnostic("mcp.header_missing", "error", `MCP header template is unresolved${resolved.missing ? `: ${resolved.missing}` : ""}`, "mcp", options.configPath));
		else headers[key] = resolved.value;
	}
	if (options.raw.bearerTokenEnvVar) {
		const token = options.environment[options.raw.bearerTokenEnvVar];
		if (!token) diagnostics.push(extensionDiagnostic("mcp.bearer_missing", "error", `MCP bearer token environment is missing: ${options.raw.bearerTokenEnvVar}`, "mcp", options.configPath));
		else headers.Authorization = `Bearer ${token}`;
	}
	if (diagnostics.some((item) => item.severity === "error")) return { diagnostics, capabilities };
	const hostDigest = sha256(url.origin);
	capabilities.push({ kind: "network", digest: hostDigest });
	if (Object.keys(headers).length > 0) capabilities.push({ kind: "credential", digest: canonicalDigest(Object.keys(headers).map((key) => key.toLocaleLowerCase()).sort()) });
	const config: McpHttpConfig = { transport: options.raw.transport, url: url.href, headers, legacyTransportExplicitlyEnabled: options.raw.transport === "sse" && options.raw.legacyTransportExplicitlyEnabled === true, ...common(options.raw) };
	return { config, identityDigest: canonicalDigest({ ...config, headers: Object.keys(headers).sort() }), diagnostics, capabilities };
}

export async function loadMcpConfig(options: {
	configPath: string;
	root: ExtensionSourceRoot;
	scope: ExtensionRuntimeScope;
	trustStore: TrustStore;
	storage: ExtensionStoragePort;
	optional?: boolean;
	environment?: Readonly<Record<string, string | undefined>>;
	state?: ExtensionStateDocument;
	pluginRoot?: string;
}): Promise<McpConfigLoadResult> {
	const read = await options.storage.readFile(options.configPath, DEFAULT_EXTENSION_LIMITS.maxConfigBytes);
	if (!read.ok) {
		if (options.optional && read.code === "missing") return { servers: [], diagnostics: [] };
		return { servers: [], diagnostics: [extensionDiagnostic("mcp.config_missing", "error", "MCP config cannot be read", "mcp", options.configPath)] };
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(read.value).toString("utf8"));
	} catch {
		return { servers: [], diagnostics: [extensionDiagnostic("mcp.config_json", "error", "MCP config is invalid JSON", "mcp", options.configPath)] };
	}
	if (!schemaAccepts(McpConfigSchema, value)) return { servers: [], diagnostics: [extensionDiagnostic("mcp.config_schema", "error", "MCP config does not match schema v1", "mcp", options.configPath)] };
	const rawServers = (value as { schemaVersion: 1; mcpServers: Record<string, RawMcpServer> }).mcpServers;
	const configDigest = sha256(read.value);
	const diagnostics: ExtensionDiagnostic[] = [];
	const servers: McpServerDescriptor[] = [];
	for (const [name, raw] of Object.entries(rawServers).sort(([left], [right]) => left.localeCompare(right))) {
		const normalized = await normalizeServer({ raw, name, configPath: options.configPath, root: options.root, storage: options.storage, environment: options.environment ?? {}, ...(options.pluginRoot ? { pluginRoot: options.pluginRoot } : {}) });
		diagnostics.push(...normalized.diagnostics);
		if (!normalized.config || !normalized.identityDigest) continue;
		const qualifiedId = qualifiedResourceId({ kind: "mcp-server", sourceKey: options.root.sourceKey, name, ...(options.root.pluginId ? { pluginId: options.root.pluginId } : {}) });
		const capabilityDigest = canonicalDigest(normalized.capabilities);
		const binding = buildResourceManifestDigest({ rootDigest: configDigest, configDigest, commandDigest: normalized.identityDigest, capabilityDigest });
		const identity = createExtensionResourceIdentity({ scope: options.scope, kind: "mcp-server", qualifiedId, version: "1", source: options.root.pluginId ? "plugin" : options.root.source, digest: binding.combinedDigest });
		const trust = await options.trustStore.evaluate({ identity, canonicalPath: resolve(options.configPath), binding, principalId: options.scope.principalId });
		const enabled = (options.state?.resources[qualifiedId]?.enabled ?? normalized.config.enabled) === true;
		const capabilities = normalized.capabilities.map((item) => capability(options.scope, qualifiedId, item.kind, item.digest));
		servers.push({
			descriptor: {
				schemaVersion: 1,
				kind: "mcp-server",
				identity,
				provenance: createExtensionResourceProvenance({
					scope: options.scope,
					source: options.root.pluginId ? "plugin" : options.root.source,
					canonicalLocator: options.configPath,
					sourceRoot: options.root.rootPath,
				}),
				manifest: binding,
				displayName: name,
				description: `${normalized.config.transport} MCP server`,
				sourcePath: options.configPath,
				...(options.root.pluginId ? { pluginId: options.root.pluginId } : {}),
				enabled,
				trust: trust.state,
				activation: !enabled ? "disabled" : trust.state === "trusted" ? "ready" : "blocked",
				...(trust.state === "trusted" ? { approvalReceiptId: trust.receipt.receiptId } : {}),
				capabilities,
				risk: { level: "high", sideEffect: normalized.config.transport === "stdio" ? "external" : "privileged", rationaleDigest: capabilityDigest },
				exposure: "hidden",
				diagnostics: trust.state === "trusted" ? [] : [extensionDiagnostic(`mcp.${trust.state}`, "warning", trust.reason, "mcp", options.configPath)],
			},
			rawName: name,
			config: normalized.config,
			configPath: options.configPath,
			priority: options.root.priority,
		});
	}
	return { servers, diagnostics };
}

export function mergeMcpServers(layers: readonly McpConfigLoadResult[]): McpConfigLoadResult {
	const diagnostics = layers.flatMap((layer) => layer.diagnostics);
	const byName = new Map<string, McpServerDescriptor>();
	for (const server of layers.flatMap((layer) => layer.servers).sort((left, right) => left.priority - right.priority || left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId))) {
		const key = `${server.descriptor.identity.source}:${server.rawName}`;
		const previous = byName.get(key);
		if (previous && previous.priority === server.priority) diagnostics.push(extensionDiagnostic("mcp.layer_conflict", "error", `MCP server conflict: ${server.rawName}`, "mcp", server.configPath));
		else byName.set(key, server);
	}
	return { servers: [...byName.values()].sort((left, right) => left.descriptor.identity.qualifiedId.localeCompare(right.descriptor.identity.qualifiedId)), diagnostics };
}
