/** McpSearch/McpCall 与 pinned direct tool 的有界 public adapters。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import type { McpConnectionManager, McpManagerResult } from "./connection-manager.ts";
import type { McpNormalizedResult, McpServerDescriptor, McpToolDefinition } from "./types.ts";

export interface McpSearchInput {
	query: string;
	limit?: number;
}

export interface McpCallInput {
	serverId: string;
	toolName: string;
	input: unknown;
}

export interface McpToolPresentation {
	name: string;
	description: string;
	inputSchema: Readonly<Record<string, unknown>>;
	execute(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

export class McpSearchTool {
	readonly name = "McpSearch";
	readonly description = "Search the bounded MCP tool catalog without executing a tool.";
	readonly #manager: McpConnectionManager;

	public constructor(manager: McpConnectionManager) {
		this.#manager = manager;
	}

	public execute(input: McpSearchInput): readonly Pick<McpToolDefinition, "serverId" | "rawName" | "qualifiedName" | "runtimeName" | "description" | "inputSchema" | "annotations">[] {
		return this.#manager.search(input.query, input.limit).map(({ serverId, rawName, qualifiedName, runtimeName, description, inputSchema, annotations }) => ({ serverId, rawName, qualifiedName, runtimeName, description, inputSchema, annotations }));
	}
}

export class McpCallTool {
	readonly name = "McpCall";
	readonly description = "Call one exact MCP server/tool identity after Runtime authorization.";
	readonly #manager: McpConnectionManager;

	public constructor(manager: McpConnectionManager) {
		this.#manager = manager;
	}

	public execute(input: McpCallInput, signal?: AbortSignal): Promise<McpManagerResult<McpNormalizedResult>> {
		return this.#manager.call(input.serverId, input.toolName, input.input, signal);
	}
}

export function pinnedMcpTools(manager: McpConnectionManager): readonly McpToolPresentation[] {
	return manager.catalog().pinned().map((tool) => ({
		name: tool.runtimeName,
		description: tool.description,
		inputSchema: typeof tool.inputSchema === "object" && tool.inputSchema !== null && !Array.isArray(tool.inputSchema) ? tool.inputSchema as Record<string, unknown> : { type: "object" },
		execute: (input, signal) => manager.call(tool.serverId, tool.rawName, input, signal),
	}));
}

/** Runtime 使用这些受信事实推导最终 claims；调用方不能提交最终 claim。 */
export function mcpCapabilityDerivationInput(server: McpServerDescriptor, tool: McpToolDefinition, rawInput: unknown): Readonly<Record<string, unknown>> {
	return {
		serverId: server.descriptor.identity.qualifiedId,
		serverDigest: server.descriptor.manifest.combinedDigest,
		transport: server.config.transport,
		process: server.config.transport === "stdio" ? { commandDigest: server.config.commandDigest, cwdDigest: canonicalDigest(server.config.cwd), environmentKeys: Object.keys(server.config.env).sort() } : undefined,
		network: server.config.transport !== "stdio" ? { originDigest: canonicalDigest(new URL(server.config.url).origin), headerNames: Object.keys(server.config.headers).map((name) => name.toLocaleLowerCase()).sort() } : undefined,
		tool: { rawName: tool.rawName, schemaDigest: canonicalDigest(tool.inputSchema), annotations: tool.annotations },
		canonicalInputDigest: canonicalDigest(rawInput),
	};
}
