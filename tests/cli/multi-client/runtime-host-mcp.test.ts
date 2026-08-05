import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { AdapterIdentityRef } from "../../../src/runtime/protocol/adapter.ts";
import type { RuntimeResourceInvocationPort } from "../../../src/runtime/contracts/ports.ts";
import { McpConnectionManager, type McpClientFactory, type McpServerConfig, type McpTransportClient } from "../../../src/extensions/mcp/connection-manager.ts";
import { createHostMcpResourceInvocationPort, createHostMcpRuntime } from "../../../src/cli/runtime-host-mcp.ts";
import { ToolRegistry } from "../../../src/runtime/tool-registry.ts";

const authorityId = createRuntimeId("authority", "host-mcp-test");
const tenantId = createRuntimeId("tenant", "host-mcp-test");
const principalId = createRuntimeId("principal", "host-mcp-test");
const sessionId = createRuntimeId("session", "host-mcp-test");
const snapshotId = createRuntimeId("snapshot", "host-mcp-test");
const adapter: AdapterIdentityRef = {
	adapterId: "runledger.test.mcp",
	generation: 1,
	configDigest: runtimeDigest("mcp-test-config"),
};

function config(): McpServerConfig {
	return {
		serverId: "mcp-server:fixture",
		displayName: "fixture",
		transport: "stdio",
		enabled: true,
		trusted: true,
		required: true,
		startupTimeoutMs: 1_000,
		toolTimeoutMs: 1_000,
	};
}

function fixtureClient(calls: { count: number }): McpTransportClient {
	return {
		async listTools() {
			return [{ name: "echo", description: "echo", inputSchema: { type: "object" }, annotations: { readOnly: true, destructive: false, concurrencySafe: true } }];
		},
		async callTool() {
			calls.count += 1;
			return { isError: false, content: [{ type: "text", text: "ok" }] };
		},
		async close() {},
	};
}

function acceptedInvocationPort(calls: { count: number }): RuntimeResourceInvocationPort {
	return {
		execute: async (request) => {
			calls.count += 1;
			return {
				port: request.port,
				action: request.action,
				requestId: request.requestId,
				outcome: "ok",
				effect: "terminal",
				adapter,
				outputDigest: runtimeDigest({ request }),
				receiptRef: { subjectKind: "receipt", digest: runtimeDigest({ request }), mediaType: "application/json", size: 0 },
				completedAt: new Date().toISOString(),
			};
		},
	};
}

function deniedInvocationPort(): RuntimeResourceInvocationPort {
	return {
		execute: async (request) => ({
			port: request.port,
			action: request.action,
			requestId: request.requestId,
			outcome: "denied",
			effect: "none",
			adapter,
			outputDigest: runtimeDigest("denied"),
			error: { code: "capability_denied", message: "fixture gateway denied", retryable: false, correlationId: createRuntimeId("trace", "mcp-denied") },
			completedAt: new Date().toISOString(),
		}),
	};
}

function runtime(options: { readonly invocation: RuntimeResourceInvocationPort; readonly factory: McpClientFactory; readonly toolRegistry?: ToolRegistry }) {
	return createHostMcpRuntime({
		manager: new McpConnectionManager({ factory: options.factory }),
		resources: { invocation: options.invocation },
		...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
		adapter,
		authorityId,
		tenantId,
		principalId,
		sessionId,
		snapshotId,
	});
}

describe("Host MCP runtime composition", () => {
	it("binds the Runtime resource invocation port to the Host authorization receipt", async () => {
		const port = createHostMcpResourceInvocationPort({
			adapter,
			sessionId,
			principalId,
			cwd: "/workspace",
			authorize: async () => ({ ok: true, value: { authorization: { outcome: "allow" }, authorizationDigest: runtimeDigest("authorized") } }),
		});
		const request = {
			port: "resource_invocation" as const,
			action: "invoke" as const,
			requestId: createRuntimeId("command", "resource-port"),
			identity: { authorityId, tenantId, principalId, principalKind: "local" as const, issuedAt: new Date(0).toISOString() },
			traceId: createRuntimeId("trace", "resource-port"),
			idempotencyKey: "mcp:resource-port",
			deadline: new Date(Date.now() + 1_000).toISOString(),
			inputDigest: runtimeDigest({ input: true }),
		};

		await expect(port.execute(request)).resolves.toMatchObject({
			outcome: "ok",
			effect: "terminal",
			receiptRef: { digest: runtimeDigest("authorized") },
		});
	});

	it("owns startup/doctor/restart and exposes only bounded MCP meta-tools in the mcp namespace", async () => {
		const calls = { count: 0 };
		const connections = { count: 0 };
		const host = runtime({ invocation: acceptedInvocationPort(calls), factory: { connect: async () => { connections.count += 1; return fixtureClient(calls); } } });

		await expect(host.start([config()])).resolves.toMatchObject({ ok: true });
		expect(host.toolRegistry().list("mcp").map((tool) => tool.name)).toEqual(["mcp_catalog", "mcp_call", "mcp_search"]);
		expect(host.catalog()).toMatchObject([{ serverId: "mcp-server:fixture", tools: [{ rawName: "echo", runtimeName: "mcp__fixture__echo" }] }]);
		expect(host.doctor()).toMatchObject([{ serverId: "mcp-server:fixture", state: "ready", connectivity: "ready" }]);

		await expect(host.restart("mcp-server:fixture")).resolves.toMatchObject({ ok: true, value: { state: "ready", generation: 2 } });
		await host.close();
		expect(connections.count).toBe(2);
	});

	it("does not invoke an MCP server when the Host resource/Gateway port denies", async () => {
		const clientCalls = { count: 0 };
		const host = runtime({ invocation: deniedInvocationPort(), factory: { connect: async () => fixtureClient(clientCalls) } });
		await expect(host.start([config()])).resolves.toMatchObject({ ok: true });

		const result = await host.invoke("mcp-server:fixture", "echo", {});
		expect(result).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
		expect(clientCalls.count).toBe(0);
		await host.close();
	});

	it("registers Host MCP meta-tools into the session-owned ToolRegistry", async () => {
		const registry = new ToolRegistry();
		const host = runtime({
			invocation: acceptedInvocationPort({ count: 0 }),
			factory: { connect: async () => fixtureClient({ count: 0 }) },
			toolRegistry: registry,
		});

		await expect(host.start([config()])).resolves.toMatchObject({ ok: true });
		expect(registry.list("mcp").map((tool) => tool.name)).toEqual(["mcp_catalog", "mcp_call", "mcp_search"]);
		expect(host.toolRegistry()).toBe(registry);
		await host.close();
	});
});
