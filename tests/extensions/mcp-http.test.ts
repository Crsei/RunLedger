import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/extensions/mcp/config.ts";
import { OfficialMcpClientFactory, OfficialMcpSdkTransportBroker } from "../../src/extensions/mcp/client-factory.ts";
import { McpConnectionManager } from "../../src/extensions/mcp/connection-manager.ts";
import type { McpServerDescriptor, McpTransportAuthorizationPort } from "../../src/extensions/mcp/types.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot } from "../../src/extensions/types.ts";
import { FakeMcpAuthorization, FakeMcpEventSink, makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

function root(path: string): ExtensionSourceRoot {
	return { source: "project", sourceKey: "project:mcp-http", rootPath: path, priority: 200 };
}

async function trustedServer(configRoot: string, url: string): Promise<McpServerDescriptor> {
	const configPath = join(configRoot, "mcp.json");
	await writeFile(configPath, JSON.stringify({ schemaVersion: 1, mcpServers: { http: { transport: "streamable-http", url, required: true, startupTimeoutMs: 5_000, toolTimeoutMs: 2_000 } } }));
	const trust = new TrustStore(join(configRoot, "trust.json"), storage);
	const initial = await loadMcpConfig({ configPath, root: root(configRoot), scope: TEST_SCOPE, trustStore: trust, storage });
	const server = initial.servers[0];
	if (!server) throw new Error("HTTP MCP config did not load");
	await trust.grant({ identity: server.descriptor.identity, canonicalPath: configPath, binding: server.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });
	const trusted = await loadMcpConfig({ configPath, root: root(configRoot), scope: TEST_SCOPE, trustStore: trust, storage });
	const result = trusted.servers[0];
	if (!result) throw new Error("trusted HTTP MCP config did not load");
	return result;
}

describe("Official MCP Streamable HTTP integration", () => {
	it("connects through an injected policy fetch and closes the local server", async () => {
		const active = new Set<{ transport: StreamableHTTPServerTransport; server: Server }>();
		const httpServer = createHttpServer(async (request, response) => {
			if (request.url !== "/mcp" || request.method !== "POST") {
				response.writeHead(405).end();
				return;
			}
			const server = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo-http", description: "HTTP echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }));
			server.setRequestHandler(CallToolRequestSchema, async (call) => ({ content: [{ type: "text", text: String(call.params.arguments?.text ?? "") }] }));
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			active.add({ transport, server });
			try {
				await server.connect(transport);
				await transport.handleRequest(request, response);
			} catch (error) {
				if (!response.headersSent) response.writeHead(500).end(error instanceof Error ? error.message : "MCP HTTP fixture failed");
			} finally {
				await transport.close().catch(() => undefined);
				await server.close().catch(() => undefined);
				for (const entry of active) {
					if (entry.transport === transport) active.delete(entry);
				}
			}
		});
		await new Promise<void>((resolve, reject) => {
			httpServer.once("error", reject);
			httpServer.listen(0, "127.0.0.1", resolve);
		});
		const address = httpServer.address() as AddressInfo;
		const origin = `http://127.0.0.1:${address.port}`;
		const fetches: string[] = [];
		const policyFetch: FetchLike = async (url, init) => {
			const resolved = new URL(url);
			if (resolved.origin !== origin) throw new Error("policy fetch blocked cross-origin request");
			fetches.push(resolved.href);
			return fetch(resolved, init);
		};
		const configRoot = await makeExtensionTempDir("mcp-http");
		temporaryDirectories.push(configRoot);
		const descriptor = await trustedServer(configRoot, `${origin}/mcp`);
		const transportAuthorization: McpTransportAuthorizationPort = {
			authorize: async (server) => ({ receiptId: "http-transport", serverId: server.descriptor.identity.qualifiedId, configDigest: server.descriptor.manifest.combinedDigest, transport: "streamable-http", expiresAt: "2999-01-01T00:00:00.000Z", fetch: policyFetch }),
		};
		const authorization = new FakeMcpAuthorization();
		const manager = new McpConnectionManager({ servers: [descriptor], factory: new OfficialMcpClientFactory(transportAuthorization, new OfficialMcpSdkTransportBroker()), authorization, events: new FakeMcpEventSink() });
		try {
			await manager.startAll();
			expect(manager.status()).toMatchObject([{ state: "ready", toolCount: 1 }]);
			const called = await manager.call(descriptor.descriptor.identity.qualifiedId, "echo-http", { text: "over-http" });
			if (!called.ok) throw new Error(`HTTP MCP call failed: ${called.code}: ${called.message}`);
			expect(called.ok).toBe(true);
			if (called.ok) expect(called.value.content[0]).toMatchObject({ type: "text", text: "over-http" });
			expect(fetches.length).toBeGreaterThanOrEqual(2);
		} finally {
			await manager.closeAll();
			for (const entry of active) {
				await entry.transport.close().catch(() => undefined);
				await entry.server.close().catch(() => undefined);
			}
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
		expect(active.size).toBe(0);
	});
});
