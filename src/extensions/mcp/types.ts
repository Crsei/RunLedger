/** MCP adapter 的纯数据与注入式 transport 合同；不拥有进程、网络或 Host 状态。 */

export type McpTransport = "stdio" | "streamable-http";
export type McpServerState =
	| "disabled"
	| "blocked-untrusted"
	| "starting"
	| "ready"
	| "auth-required"
	| "failed"
	| "stopping"
	| "stopped";

export interface McpToolAnnotations {
	readonly readOnly?: boolean;
	readonly destructive?: boolean;
	readonly concurrencySafe?: boolean;
}

export interface McpToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema: unknown;
	readonly annotations?: McpToolAnnotations;
}

export type McpRawContent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string }
	| { readonly type: "resource"; readonly uri: string; readonly mimeType?: string; readonly text?: string }
	| { readonly type: string; readonly [key: string]: unknown };

export interface McpRawToolResult {
	readonly isError: boolean;
	readonly content: readonly McpRawContent[];
}

export interface McpTransportClient {
	listTools(signal?: AbortSignal): Promise<readonly McpToolDefinition[]>;
	callTool(toolName: string, input: unknown, signal?: AbortSignal): Promise<McpRawToolResult>;
	close(): Promise<void>;
}

export interface McpClientFactory {
	connect(config: McpServerConfig, signal?: AbortSignal): Promise<McpTransportClient>;
}

export interface McpServerConfig {
	readonly serverId: string;
	readonly displayName: string;
	readonly transport: McpTransport;
	readonly enabled: boolean;
	readonly trusted: boolean;
	readonly required: boolean;
	readonly startupTimeoutMs: number;
	readonly toolTimeoutMs: number;
	readonly toolTimeouts?: Readonly<Record<string, number>>;
	readonly enabledTools?: readonly string[];
	readonly disabledTools?: readonly string[];
	readonly maxResultBytes?: number;
}

export interface McpToolDescriptor extends McpToolDefinition {
	readonly rawName: string;
	readonly runtimeName: string;
	readonly isReadOnly: boolean;
	readonly isDestructive: boolean;
	readonly isConcurrencySafe: boolean;
}

export interface McpDiagnostic {
	readonly code: string;
	readonly message: string;
	readonly severity: "info" | "warning" | "error";
}

export interface McpServerSnapshot {
	readonly serverId: string;
	readonly displayName: string;
	readonly transport: McpTransport;
	readonly required: boolean;
	readonly state: McpServerState;
	readonly generation: number;
	readonly tools: readonly McpToolDescriptor[];
	readonly diagnostics: readonly McpDiagnostic[];
}

export interface McpAuthorizationRequest {
	readonly serverId: string;
	readonly toolName: string;
	readonly input: unknown;
	readonly descriptor: McpToolDescriptor;
}

export type McpAuthorizationResult =
	| { readonly decision: "allow" }
	| { readonly decision: "deny"; readonly reason?: string };

export interface McpNormalizedContentText {
	readonly type: "text";
	readonly text: string;
}

export interface McpNormalizedContentImage {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface McpNormalizedContentResource {
	readonly type: "resource";
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
}

export type McpNormalizedContent = McpNormalizedContentText | McpNormalizedContentImage | McpNormalizedContentResource;

export interface McpCallValue {
	readonly serverId: string;
	readonly toolName: string;
	readonly outcome: "ok" | "error";
	readonly content: readonly McpNormalizedContent[];
	readonly originalBytes: number;
	readonly truncated: boolean;
	readonly contentDigest: { readonly algorithm: "sha256"; readonly digest: string };
}

export type McpErrorCode =
	| "invalid_config"
	| "blocked_untrusted"
	| "startup_failed"
	| "invalid_catalog"
	| "server_not_ready"
	| "tool_not_found"
	| "authorization_denied"
	| "tool_failed"
	| "tool_timeout";

export interface McpManagerError {
	readonly code: McpErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

export type McpManagerResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: McpManagerError };
