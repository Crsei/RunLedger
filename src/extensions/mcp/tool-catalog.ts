/** MCP tool 的 exact identity、allow/deny、search 与 runtime-name 冲突门。 */

import { mcpRuntimeName } from "../identity.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import { extensionDiagnostic } from "../diagnostics.ts";
import type { McpServerDescriptor, McpToolDefinition } from "./types.ts";

export class McpToolCatalog {
	readonly #tools: readonly McpToolDefinition[];
	readonly #diagnostics: readonly ExtensionDiagnostic[];

	public constructor(entries: readonly { server: McpServerDescriptor; tools: readonly Omit<McpToolDefinition, "serverId" | "serverName" | "qualifiedName" | "runtimeName" | "pinned">[] }[]) {
		const tools: McpToolDefinition[] = [];
		const diagnostics: ExtensionDiagnostic[] = [];
		const runtimeOwners = new Map<string, string>();
		for (const { server, tools: rawTools } of [...entries].sort((left, right) => left.server.descriptor.identity.qualifiedId.localeCompare(right.server.descriptor.identity.qualifiedId))) {
			for (const tool of rawTools) {
				if (server.config.enabledTools && !server.config.enabledTools.includes(tool.rawName)) continue;
				if (server.config.disabledTools.includes(tool.rawName)) continue;
				const runtimeName = mcpRuntimeName(server.rawName, tool.rawName);
				const qualifiedName = `${server.descriptor.identity.qualifiedId}:${tool.rawName}`;
				const owner = runtimeOwners.get(runtimeName);
				if (owner) {
					diagnostics.push(extensionDiagnostic("mcp.runtime_name_conflict", "error", `MCP runtime name collision: ${runtimeName}`, "mcp", server.configPath));
					continue;
				}
				runtimeOwners.set(runtimeName, qualifiedName);
				tools.push({ ...tool, serverId: server.descriptor.identity.qualifiedId, serverName: server.rawName, qualifiedName, runtimeName, pinned: server.config.pinnedTools.includes(tool.rawName) });
			}
		}
		this.#tools = tools.sort((left, right) => left.qualifiedName.localeCompare(right.qualifiedName));
		this.#diagnostics = diagnostics;
	}

	public list(): readonly McpToolDefinition[] {
		return this.#tools;
	}

	public diagnostics(): readonly ExtensionDiagnostic[] {
		return this.#diagnostics;
	}

	public resolveExact(serverId: string, rawName: string): McpToolDefinition | undefined {
		return this.#tools.find((tool) => tool.serverId === serverId && tool.rawName === rawName);
	}

	public resolveRuntimeName(runtimeName: string): McpToolDefinition | undefined {
		return this.#tools.find((tool) => tool.runtimeName === runtimeName);
	}

	public search(query: string, limit = 20): readonly McpToolDefinition[] {
		const normalized = query.toLocaleLowerCase();
		return this.#tools.filter((tool) => `${tool.rawName}\n${tool.qualifiedName}\n${tool.description}`.toLocaleLowerCase().includes(normalized)).slice(0, Math.max(0, Math.min(limit, 100)));
	}

	public pinned(): readonly McpToolDefinition[] {
		return this.#tools.filter((tool) => tool.pinned);
	}
}
