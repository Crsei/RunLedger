import { describe, expect, it } from "vitest";
import {
	McpConnectionManager,
	type McpClientFactory,
	type McpRawToolResult,
	type McpServerConfig,
	type McpTransportClient,
} from "../../src/extensions/mcp/connection-manager.ts";

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		serverId: "mcp-server:fixture:issues",
		displayName: "issues",
		transport: "stdio",
		enabled: true,
		trusted: true,
		required: false,
		startupTimeoutMs: 100,
		toolTimeoutMs: 100,
		enabledTools: ["search", "slow"],
		disabledTools: ["slow"],
		maxResultBytes: 64,
		...overrides,
	};
}

function client(tools: readonly { name: string; description?: string }[], result?: McpRawToolResult): McpTransportClient {
	return {
		async listTools() {
			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? tool.name,
				inputSchema: { type: "object" },
				annotations: tool.name === "search" ? { readOnly: true, destructive: false, concurrencySafe: true } : undefined,
			}));
		},
		async callTool() {
			return result ?? { isError: false, content: [{ type: "text", text: "ok" }] };
		},
		async close() {},
	};
}

describe("McpConnectionManager", () => {
	it("starts a trusted server and filters tools before exposing stable runtime names", async () => {
		const factory: McpClientFactory = { async connect() { return client([{ name: "search" }, { name: "slow" }, { name: "hidden" }]); } };
		const manager = new McpConnectionManager({ factory });

		const started = await manager.start(config());

		expect(started).toMatchObject({ ok: true, value: { state: "ready" } });
		if (!started.ok) return;
		expect(started.value.tools.map((tool) => tool.runtimeName)).toEqual(["mcp__issues__search"]);
		expect(started.value.tools[0]).toMatchObject({
			rawName: "search",
			isReadOnly: true,
			isDestructive: false,
			isConcurrencySafe: true,
		});
	});

	it("blocks untrusted servers without calling the transport factory", async () => {
		let connects = 0;
		const factory: McpClientFactory = { async connect() { connects += 1; return client([]); } };
		const manager = new McpConnectionManager({ factory });

		const result = await manager.start(config({ trusted: false }));

		expect(result).toMatchObject({ ok: false, error: { code: "blocked_untrusted" } });
		expect(connects).toBe(0);
		expect(manager.snapshot("mcp-server:fixture:issues")).toMatchObject({ state: "blocked-untrusted" });
	});

	it("normalizes bounded tool results and denies calls through the injected authorizer", async () => {
		const raw: McpRawToolResult = {
			isError: false,
			content: [
				{ type: "text", text: "short" },
				{ type: "text", text: "x".repeat(200) },
			],
		};
		const factory: McpClientFactory = { async connect() { return client([{ name: "search" }], raw); } };
		const manager = new McpConnectionManager({ factory, authorize: async () => ({ decision: "allow" }) });
		await manager.start(config({ enabledTools: ["search"], disabledTools: [], maxResultBytes: 32 }));

		const allowed = await manager.call({ serverId: "mcp-server:fixture:issues", toolName: "search", input: { query: "a" } });
		expect(allowed).toMatchObject({ ok: true, value: { outcome: "ok", truncated: true, originalBytes: expect.any(Number) } });
		if (!allowed.ok) return;
		expect(allowed.value.content).toHaveLength(2);
		expect(allowed.value.content[0]).toMatchObject({ type: "text" });
		expect(allowed.value.content[1]).toMatchObject({ type: "text" });

		const deniedManager = new McpConnectionManager({ factory, authorize: async () => ({ decision: "deny", reason: "no grant" }) });
		await deniedManager.start(config({ enabledTools: ["search"], disabledTools: [] }));
		expect(await deniedManager.call({ serverId: "mcp-server:fixture:issues", toolName: "search", input: {} })).toMatchObject({
			ok: false,
			error: { code: "authorization_denied" },
		});
	});

	it("closes the active transport and rejects calls after shutdown", async () => {
		let closed = 0;
		const transport = client([{ name: "search" }]);
		const factory: McpClientFactory = { async connect() { return { ...transport, async close() { closed += 1; } }; } };
		const manager = new McpConnectionManager({ factory });
		await manager.start(config({ enabledTools: ["search"], disabledTools: [] }));

		await manager.closeAll();

		expect(closed).toBe(1);
		expect(manager.snapshot("mcp-server:fixture:issues")).toMatchObject({ state: "stopped" });
		expect(await manager.call({ serverId: "mcp-server:fixture:issues", toolName: "search", input: {} })).toMatchObject({
			ok: false,
			error: { code: "server_not_ready" },
		});
	});

	it("closes a connected transport when startup catalog discovery fails", async () => {
		let closed = 0;
		const factory: McpClientFactory = {
			async connect() {
				return {
					async listTools() { throw new Error("catalog unavailable"); },
					async callTool() { return { isError: false, content: [] }; },
					async close() { closed += 1; },
				};
			},
		};
		const manager = new McpConnectionManager({ factory });

		await expect(manager.start(config())).resolves.toMatchObject({
			ok: false,
			error: { code: "startup_failed" },
		});
		expect(closed).toBe(1);
		expect(manager.snapshot("mcp-server:fixture:issues")).toMatchObject({ state: "failed" });
	});
});
