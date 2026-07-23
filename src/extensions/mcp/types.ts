import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionResourceDescriptor, ExtensionSpillRef } from "../types.ts";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";
export type McpServerState = "disabled" | "blocked-untrusted" | "starting" | "ready" | "auth-required" | "failed" | "stopping" | "stopped";

interface McpServerConfigCommon {
	transport: McpTransportKind;
	enabled: boolean;
	required: boolean;
	startupTimeoutMs: number;
	toolTimeoutMs: number;
	toolTimeouts: Readonly<Record<string, number>>;
	enabledTools?: readonly string[];
	disabledTools: readonly string[];
	pinnedTools: readonly string[];
	supportsParallelToolCalls: boolean;
}

export interface McpStdioConfig extends McpServerConfigCommon {
	transport: "stdio";
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
	commandDigest: string;
}

export interface McpHttpConfig extends McpServerConfigCommon {
	transport: "streamable-http" | "sse";
	url: string;
	headers: Readonly<Record<string, string>>;
	legacyTransportExplicitlyEnabled: boolean;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpServerDescriptor {
	descriptor: ExtensionResourceDescriptor;
	rawName: string;
	config: McpServerConfig;
	configPath: string;
	priority: number;
}

export interface McpConfigLoadResult {
	servers: readonly McpServerDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}

export interface McpToolAnnotations {
	readOnly: boolean;
	destructive: boolean;
	concurrencySafe: boolean;
}

export interface McpToolDefinition {
	serverId: string;
	serverName: string;
	rawName: string;
	qualifiedName: string;
	runtimeName: string;
	description: string;
	inputSchema: unknown;
	annotations: McpToolAnnotations;
	pinned: boolean;
}

export interface McpCallResult {
	content: readonly unknown[];
	structuredContent?: unknown;
	isError: boolean;
}

export interface McpClientPort {
	listTools(signal?: AbortSignal): Promise<readonly Omit<McpToolDefinition, "serverId" | "serverName" | "qualifiedName" | "runtimeName" | "pinned">[]>;
	callTool(name: string, input: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult>;
	ping(timeoutMs: number, signal?: AbortSignal): Promise<void>;
	listResources(signal?: AbortSignal): Promise<readonly unknown[]>;
	listResourceTemplates(signal?: AbortSignal): Promise<readonly unknown[]>;
	readResource(uri: string, signal?: AbortSignal): Promise<readonly unknown[]>;
	listPrompts(signal?: AbortSignal): Promise<readonly unknown[]>;
	getPrompt(name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
	onClose(listener: () => void): void;
}

export interface McpTransportGrant {
	receiptId: string;
	serverId: string;
	configDigest: string;
	transport: McpTransportKind;
	expiresAt: string;
	fetch?: FetchLike;
}

export interface McpTransportAuthorizationPort {
	authorize(server: McpServerDescriptor, signal?: AbortSignal): Promise<McpTransportGrant | undefined>;
}

export interface McpTransportBrokerPort {
	create(config: McpServerConfig, grant: McpTransportGrant): Promise<Transport>;
}

export interface McpClientFactoryPort {
	connect(server: McpServerDescriptor, signal?: AbortSignal): Promise<McpClientPort>;
}

export interface McpNormalizedResult {
	content: readonly {
		type: "text" | "image" | "resource" | "json";
		text?: string;
		mediaType?: string;
		dataBase64?: string;
		uri?: string;
		contentDigest: string;
	}[];
	isError: boolean;
	originalBytes: number;
	truncated: boolean;
	contentDigest: string;
	spill?: ExtensionSpillRef;
}

export interface McpServerStatus {
	serverId: string;
	state: McpServerState;
	generation: number;
	reason?: string;
	toolCount: number;
	restartAttempts: number;
}

export interface McpDoctorResult {
	serverId: string;
	state: McpServerState;
	ok: boolean;
	latencyMs: number;
	reason?: string;
}
