/**
 * TUI MCP 资源端口 —— /mcp 管理视图的 typed bounded 投影。
 *
 * 所有字段有界 + 终端安全;capability 缺失(无 Session 通道)时 port
 * undefined,不发 effect。
 */

import type { TuiPortRequest, TuiResultEnvelope } from "../application/common.ts";
import type { SafeBoundedText } from "../presentation/tools/types.ts";

export type McpServerViewState = "disabled" | "starting" | "ready" | "stopping" | "stopped" | "failed" | "blocked-untrusted";

export interface McpToolView {
	readonly rawName: SafeBoundedText;
	readonly runtimeName: SafeBoundedText;
	readonly description?: SafeBoundedText;
	readonly isReadOnly: boolean;
	readonly isDestructive: boolean;
}

export interface McpDiagnosticView {
	readonly code: SafeBoundedText;
	readonly message: SafeBoundedText;
	readonly severity: SafeBoundedText;
}

export interface McpServerView {
	readonly serverId: string;
	readonly displayName: SafeBoundedText;
	readonly transport: string;
	readonly required: boolean;
	readonly state: McpServerViewState;
	readonly generation: number;
	readonly tools: readonly McpToolView[];
	readonly diagnostics: readonly McpDiagnosticView[];
}

export interface McpCatalogSnapshot {
	readonly servers: readonly McpServerView[];
}

export type McpCatalogResult = TuiResultEnvelope<McpCatalogSnapshot>;
export type McpRestartResult = TuiResultEnvelope<McpServerView>;

export interface McpResourcePort {
	readonly list: (input: TuiPortRequest) => Promise<McpCatalogResult>;
	readonly restart: (input: TuiPortRequest & { readonly serverId: string }) => Promise<McpRestartResult>;
}
