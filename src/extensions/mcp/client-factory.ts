/** 官方 MCP SDK client；transport 创建前必须获得 exact authorization grant。 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
	McpCallResult,
	McpClientFactoryPort,
	McpClientPort,
	McpServerConfig,
	McpServerDescriptor,
	McpToolAnnotations,
	McpTransportAuthorizationPort,
	McpTransportBrokerPort,
	McpTransportGrant,
} from "./types.ts";

function annotations(value: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } | undefined): McpToolAnnotations {
	return {
		readOnly: value?.readOnlyHint === true,
		destructive: value?.destructiveHint !== false,
		concurrencySafe: value?.readOnlyHint === true || value?.idempotentHint === true,
	};
}

class OfficialMcpClient implements McpClientPort {
	readonly #client: Client;
	readonly #transport: Transport;
	readonly #listeners = new Set<() => void>();

	public constructor(client: Client, transport: Transport) {
		this.#client = client;
		this.#transport = transport;
		client.onclose = () => {
			for (const listener of this.#listeners) listener();
		};
	}

	public async listTools(signal?: AbortSignal) {
		const result = await this.#client.listTools({}, { signal, timeout: 30_000 });
		return result.tools.map((tool) => ({ rawName: tool.name, description: tool.description ?? "MCP tool", inputSchema: tool.inputSchema, annotations: annotations(tool.annotations) }));
	}

	public async callTool(name: string, input: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
		const args = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : { value: input };
		const result = await this.#client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
		if (!("content" in result) || !Array.isArray(result.content)) return { content: [{ type: "json", value: result.toolResult }], isError: false };
		return { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}), isError: result.isError === true };
	}

	public async ping(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		await this.#client.ping({ signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
	}

	public async listResources(signal?: AbortSignal): Promise<readonly unknown[]> {
		return (await this.#client.listResources({}, { signal, timeout: 30_000 })).resources;
	}

	public async listResourceTemplates(signal?: AbortSignal): Promise<readonly unknown[]> {
		return (await this.#client.listResourceTemplates({}, { signal, timeout: 30_000 })).resourceTemplates;
	}

	public async readResource(uri: string, signal?: AbortSignal): Promise<readonly unknown[]> {
		return (await this.#client.readResource({ uri }, { signal, timeout: 30_000 })).contents;
	}

	public async listPrompts(signal?: AbortSignal): Promise<readonly unknown[]> {
		return (await this.#client.listPrompts({}, { signal, timeout: 30_000 })).prompts;
	}

	public async getPrompt(name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<unknown> {
		return this.#client.getPrompt({ name, arguments: { ...args } }, { signal, timeout: 30_000 });
	}

	public async close(): Promise<void> {
		await this.#client.close();
		await this.#transport.close().catch(() => undefined);
	}

	public onClose(listener: () => void): void {
		this.#listeners.add(listener);
	}
}

/**
 * SDK transport 是特权 integration edge。grant 由 Runtime Gateway adapter 生成；
 * HTTP 必须注入 policy-aware FetchLike，绝不回退到 global fetch。
 */
export class OfficialMcpSdkTransportBroker implements McpTransportBrokerPort {
	public async create(config: McpServerConfig, grant: McpTransportGrant): Promise<Transport> {
		if (grant.transport !== config.transport || new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error("MCP transport grant is stale");
		if (config.transport === "stdio") return new StdioClientTransport({ command: config.command, args: [...config.args], cwd: config.cwd, env: { ...config.env }, stderr: "pipe" });
		if (!grant.fetch) throw new Error("policy-aware MCP HTTP transport is unavailable");
		const requestInit: RequestInit = { headers: { ...config.headers } };
		if (config.transport === "streamable-http") return new StreamableHTTPClientTransport(new URL(config.url), { requestInit, fetch: grant.fetch, reconnectionOptions: { initialReconnectionDelay: 500, maxReconnectionDelay: 5_000, reconnectionDelayGrowFactor: 2, maxRetries: 2 } });
		if (!config.legacyTransportExplicitlyEnabled) throw new Error("legacy SSE transport is not explicitly enabled");
		return new SSEClientTransport(new URL(config.url), { requestInit, fetch: grant.fetch });
	}
}

export class OfficialMcpClientFactory implements McpClientFactoryPort {
	readonly #authorization: McpTransportAuthorizationPort;
	readonly #broker: McpTransportBrokerPort;

	public constructor(authorization: McpTransportAuthorizationPort, broker: McpTransportBrokerPort) {
		this.#authorization = authorization;
		this.#broker = broker;
	}

	public async connect(server: McpServerDescriptor, signal?: AbortSignal): Promise<McpClientPort> {
		const grant = await this.#authorization.authorize(server, signal);
		if (!grant || grant.serverId !== server.descriptor.identity.qualifiedId || grant.configDigest !== server.descriptor.manifest.combinedDigest || grant.transport !== server.config.transport || new Date(grant.expiresAt).getTime() <= Date.now()) throw new Error("MCP connection authorization denied or stale");
		const transport = await this.#broker.create(server.config, grant);
		const client = new Client({ name: "runledger", version: "1.0.0" }, { capabilities: {} });
		await client.connect(transport, { signal, timeout: server.config.startupTimeoutMs, maxTotalTimeout: server.config.startupTimeoutMs });
		return new OfficialMcpClient(client, transport);
	}
}
