import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExecutionEnvFetch, createMcpGatewayFetch, createSdkMcpClientFactory } from "../../src/extensions/mcp/sdk-factory.ts";
import { McpConnectionManager } from "../../src/extensions/mcp/connection-manager.ts";
import { PolicyNetworkClient } from "../../src/security/policy-network.ts";
import { ProductionManagedProcessPort } from "../../src/cli/runtime-host-process.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../src/runtime/host/types.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";
import { createGovernedLspSpawner } from "../../src/runtime/session-runtime/lsp-composition.ts";
import type { ExecutionHandleRef } from "../../src/runtime/process/types.ts";

const requireFromTest = createRequire(import.meta.url);

function processScope(): RuntimeHostScope {
	const digest = (seed: string) => runtimeDigest(seed);
	return {
		authorityId: createRuntimeId("authority", "mcp-process"),
		tenantId: createRuntimeId("tenant", "mcp-process"),
		workspaceId: createRuntimeId("workspace", "mcp-process"),
		repositoryId: createRuntimeId("repository", "mcp-process"),
		workspaceStorageKey: `ws-${"m".repeat(64)}`,
		protocolVersion: 1,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extension"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

describe("official MCP SDK transport factory", () => {
	it("reaps a managed MCP child after invalid protocol output without waiting for its lifetime limit", { skip: IS_WINDOWS }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-mcp-invalid-protocol-"));
		const sessionId = createRuntimeId("session", "invalid-protocol");
		const processPort = new ProductionManagedProcessPort({ layout: buildRunledgerLayout(join(root, "home"), "posix"), scope: processScope(), hostGeneration: 1, allowTestOnlyUnrestrictedExecution: true });
		const manager = new McpConnectionManager({ factory: createSdkMcpClientFactory({ managedProcess: processPort.toolClient(sessionId, 1, "principal_mcp"), managedProcessCwd: process.cwd() }) });
		try {
			const started = await manager.start({ serverId: "mcp-server:invalid", displayName: "invalid", transport: "stdio", enabled: true, trusted: true, required: true, startupTimeoutMs: 10_000, toolTimeoutMs: 5_000, stdio: { command: process.execPath, args: ["-e", "process.stderr.write('protocol fixture failed\\n');process.stdout.write('invalid JSON\\n');setInterval(()=>{},1000)"] } });
			expect(started.ok).toBe(false);
			await manager.closeAll();
			await vi.waitFor(async () => {
				const states = (await processPort.list(sessionId)).map((item) => item.state);
				expect(states).toHaveLength(1);
				expect(states[0]).toMatch(/^(completed|failed|timed_out|killed)$/u);
			}, { timeout: 1500 });
		} finally {
			await manager.closeAll();
			for (const item of await processPort.list(sessionId)) {
				if (typeof item.executionId === "string") await processPort.stop(sessionId, item.executionId, "driver", "SIGKILL");
			}
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it.each([
		["mcp", "typed-failure"], ["mcp", "rejected"], ["lsp", "typed-failure"], ["lsp", "rejected"],
	] as const)("reaps a managed %s child after stderr reader %s", { skip: IS_WINDOWS }, async (protocol, mode) => {
		const root = await mkdtemp(join(tmpdir(), "runledger-mcp-reader-failure-"));
		const sessionId = createRuntimeId("session", "reader-failure");
		const processPort = new ProductionManagedProcessPort({ layout: buildRunledgerLayout(join(root, "home"), "posix"), scope: processScope(), hostGeneration: 1, allowTestOnlyUnrestrictedExecution: true });
		const original = processPort.toolClient(sessionId, 1, "principal_mcp");
		let handle: ExecutionHandleRef | undefined;
		const calls: string[] = [];
		const instrumented: typeof original = {
			...original,
			start: async (input) => { const result = await original.start(input); if (result.ok) handle = result.handle; return result; },
			processOutput: async (...args) => {
				if (args[3] === "stderr") {
					calls.push("stderr-failed");
					if (mode === "rejected") throw new Error("synthetic stderr read rejection");
					return { ok: false, code: "backend_unavailable" };
				}
				return original.processOutput(...args);
			},
			stop: async (...args) => { calls.push(`stop:${args[2]}`); return original.stop(...args); },
			processWait: async (...args) => { calls.push("wait"); return original.processWait(...args); },
		};
		const manager = new McpConnectionManager({ factory: createSdkMcpClientFactory({ managedProcess: instrumented, managedProcessCwd: process.cwd() }) });
		try {
			if (protocol === "mcp") {
				const started = await manager.start({ serverId: "mcp-server:reader-failure", displayName: "reader-failure", transport: "stdio", enabled: true, trusted: true, required: true, startupTimeoutMs: 10_000, toolTimeoutMs: 5_000, stdio: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } });
				expect(started.ok).toBe(false);
				await manager.closeAll();
			} else {
				const lsp = await createGovernedLspSpawner(instrumented).spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.cwd());
				expect(await lsp.exited).toBe(1);
			}
			expect(calls).toEqual(["stderr-failed", "stop:SIGTERM", "wait"]);
			const states = (await processPort.list(sessionId)).map((item) => item.state);
			expect(states).toHaveLength(1);
			expect(states[0]).toMatch(/^(completed|failed|timed_out|killed)$/u);
		} finally {
			await manager.closeAll();
			if (handle !== undefined) { await original.stop(handle, "driver", "SIGKILL"); await original.processWait(handle, 1_000, "driver"); }
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it.each(["mcp", "lsp"])("retains bounded sanitized stderr for failed managed %s without contaminating stdout", { skip: IS_WINDOWS }, async (protocol) => {
		const root = await mkdtemp(join(tmpdir(), "runledger-protocol-diagnostics-"));
		const sessionId = createRuntimeId("session", "protocol-diagnostics");
		const processPort = new ProductionManagedProcessPort({ layout: buildRunledgerLayout(join(root, "home"), "posix"), scope: processScope(), hostGeneration: 1, allowTestOnlyUnrestrictedExecution: true });
		const managedProcess = processPort.toolClient(sessionId, 1, "principal_mcp");
		const manager = new McpConnectionManager({ factory: createSdkMcpClientFactory({ managedProcess, managedProcessCwd: process.cwd() }) });
		const diagnostic = "\u001b[31mfixture invalid configuration token=fixture-secret\u001b[0m\n";
		const script = `process.stderr.write('noise\\n'.repeat(80_000)+${JSON.stringify(diagnostic)},()=>{process.exitCode=7});`;
		try {
			if (protocol === "mcp") {
				const config = { serverId: "mcp-server:failure", displayName: "failure", transport: "stdio" as const, enabled: true, trusted: true, required: true, startupTimeoutMs: 5_000, toolTimeoutMs: 5_000, stdio: { command: process.execPath, args: ["-e", script] } };
				const started = await manager.start(config);
				expect(started.ok).toBe(false);
				const diagnostics = JSON.stringify(manager.snapshot(config.serverId)?.diagnostics);
				expect(diagnostics).toContain("fixture invalid configuration");
				expect(diagnostics).not.toContain("fixture-secret");
				expect(Buffer.byteLength(diagnostics)).toBeLessThan(10_000);
			} else {
				const lsp = await createGovernedLspSpawner(managedProcess).spawn(process.execPath, ["-e", `process.stdout.write('Content-Length: 2\\r\\n\\r\\n{}');${script}`], process.cwd());
				const stdout = new Response(lsp.stdout).text();
				expect(await lsp.exited).toBe(7);
				expect(await stdout).toBe("Content-Length: 2\r\n\r\n{}");
				expect(lsp.peekStderr()).toContain("fixture invalid configuration");
				expect(lsp.peekStderr()).not.toContain("fixture-secret");
				expect(lsp.peekStderr()).not.toContain("\u001b");
				expect(Buffer.byteLength(lsp.peekStderr())).toBeLessThanOrEqual(8192);
				const missing = await createGovernedLspSpawner(managedProcess).spawn(join(root, "missing-executable"), [], process.cwd());
				await missing.exited;
				expect(missing.peekStderr()).toContain("missing-executable");
			}
			expect((await processPort.list(sessionId)).every((item) => item.state !== "running" && item.state !== "starting")).toBe(true);
		} finally {
			await manager.closeAll();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("adapts the Host ExecutionEnv network port without a raw fetch fallback", async () => {
		let calls = 0;
		const fetcher = createMcpExecutionEnvFetch({
			request: async (request) => {
				calls += 1;
				return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}"), finalUrl: request.url };
			},
		});
		const response = await fetcher("http://127.0.0.1/mcp", { method: "GET" });

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("{}");
		expect(calls).toBe(1);
	});

	it("connects to a real stdio MCP server, lists and calls a tool, then closes its child", async () => {
		const script = [
			"const {Server}=require('@modelcontextprotocol/sdk/server/index.js');",
			"const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');",
			"const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');",
			"const server=new Server({name:'runledger-fixture',version:'1.0.0'},{capabilities:{tools:{}}});",
			"server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}));",
			"server.setRequestHandler(CallToolRequestSchema,async(req)=>({content:[{type:'text',text:String(req.params.arguments?.text??'missing')+':'+String(process.env.FIXTURE_VALUE)+':'+String(process.env.RUNLEDGER_FORBIDDEN)}]}));",
			"server.connect(new StdioServerTransport());",
		].join("");
		const factory = createSdkMcpClientFactory();
		const manager = new McpConnectionManager({ factory });
		const started = await manager.start({
			serverId: "mcp-server:fixture",
			displayName: "fixture",
			transport: "stdio",
			enabled: true,
			trusted: true,
			required: true,
			startupTimeoutMs: 5_000,
			toolTimeoutMs: 5_000,
			stdio: { command: process.execPath, args: ["-e", script], env: { RUNLEDGER_FORBIDDEN: "no", FIXTURE_VALUE: "yes" } },
		});

		expect(started.ok, JSON.stringify(started)).toBe(true);
		if (!started.ok) return;
		expect(started.value.tools).toMatchObject([{ rawName: "echo", runtimeName: "mcp__fixture__echo" }]);
		await expect(manager.call({ serverId: "mcp-server:fixture", toolName: "echo", input: { text: "hello" } })).resolves.toMatchObject({
			ok: true,
			value: { content: [{ type: "text", text: "hello:yes:undefined" }] },
		});
		await manager.closeAll();
		expect(manager.snapshot("mcp-server:fixture")).toMatchObject({ state: "stopped" });
	});

	it("uses the official Streamable HTTP transport against a local protocol server", async () => {
		const createFixtureServer = (): Server => {
			const server = new Server({ name: "runledger-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
			server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "status", description: "fixture", inputSchema: { type: "object" } }] }));
			server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "http-ok" }] }));
			return server;
		};
		const httpServer = createServer((request, response) => {
			if (request.url !== "/mcp" || request.method !== "POST") {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
			request.on("end", () => {
				let body: unknown;
				try { body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { response.writeHead(400).end(); return; }
				const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				void createFixtureServer().connect(transport).then(() => transport.handleRequest(request, response, body)).catch(() => response.destroy());
			});
		});
		await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
		const address = httpServer.address();
		if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind");
		const network = new PolicyNetworkClient({
			request: async (input) => {
				const response = await fetch(input.url, {
					method: input.method,
					headers: input.headers,
					body: input.body === undefined ? undefined : typeof input.body === "string" ? input.body : new Uint8Array(input.body),
					signal: undefined,
				});
				const headers: Record<string, string> = {};
				response.headers.forEach((value, key) => { headers[key] = value; });
				return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()), finalUrl: input.url };
			},
		}, { mode: "allowlist", allowedHosts: ["127.0.0.1"] });
		const manager = new McpConnectionManager({ factory: createSdkMcpClientFactory({ httpFetch: createMcpGatewayFetch(network) }) });
		try {
			const started = await manager.start({
				serverId: "mcp-server:http-fixture",
				displayName: "http-fixture",
				transport: "streamable-http",
				enabled: true,
				trusted: true,
				required: true,
				startupTimeoutMs: 5_000,
				toolTimeoutMs: 5_000,
				url: `http://127.0.0.1:${address.port}/mcp`,
			});
			expect(started.ok, JSON.stringify(started)).toBe(true);
			if (!started.ok) return;
			expect(await manager.call({ serverId: "mcp-server:http-fixture", toolName: "status", input: {} })).toMatchObject({ ok: true, value: { content: [{ text: "http-ok" }] } });
		} finally {
			await manager.closeAll();
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	});

	it("keeps MCP stderr startup logs out of the Host-managed JSONL protocol stream", { skip: IS_WINDOWS }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-mcp-managed-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const scope = processScope();
		const sessionId = createRuntimeId("session", "mcp-managed");
		const script = [
			"const {Server}=require('@modelcontextprotocol/sdk/server/index.js');",
			"const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');",
				"const {ListToolsRequestSchema,CallToolRequestSchema}=require('@modelcontextprotocol/sdk/types.js');",
				"process.stderr.write('managed fixture booted\\n');",
			"const server=new Server({name:'runledger-managed-fixture',version:'1.0.0'},{capabilities:{tools:{}}});",
			"server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'managed',inputSchema:{type:'object'}}]}));",
			"server.setRequestHandler(CallToolRequestSchema,async(req)=>{if(req.params.arguments?.crash){process.stderr.write('fixture tool crashed token=private-crash-value\\n',()=>process.exit(7));return new Promise(()=>{});}return {content:[{type:'text',text:'managed-ok'}]}});",
			"server.connect(new StdioServerTransport());",
		].join("");
		const processPort = new ProductionManagedProcessPort({ layout, scope, hostGeneration: 1, allowTestOnlyUnrestrictedExecution: true });
		const manager = new McpConnectionManager({ factory: createSdkMcpClientFactory({ managedProcess: processPort.toolClient(sessionId, 1, "principal_mcp"), managedProcessCwd: process.cwd() }) });
		const assertManagedProcess = async (): Promise<void> => {
			expect(await processPort.list(sessionId)).toHaveLength(1);
		};
		try {
			const started = await manager.start({
				serverId: "mcp-server:managed",
				displayName: "managed",
				transport: "stdio",
				enabled: true,
				trusted: true,
				required: true,
				startupTimeoutMs: 5_000,
				toolTimeoutMs: 5_000,
				stdio: { command: process.execPath, args: ["-e", script] },
			});
			expect(started.ok, JSON.stringify(started)).toBe(true);
			if (!started.ok) return;
			expect(await manager.call({ serverId: "mcp-server:managed", toolName: "managed", input: {} })).toMatchObject({ ok: true, value: { content: [{ text: "managed-ok" }] } });
			await assertManagedProcess();
			const crashed = await manager.call({ serverId: "mcp-server:managed", toolName: "managed", input: { crash: true } });
			expect(crashed.ok).toBe(false);
			expect(JSON.stringify(crashed)).toContain("fixture tool crashed token=[REDACTED]");
			expect(JSON.stringify(crashed)).not.toContain("private-crash-value");
		} finally {
			await manager.closeAll();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("uses the Host execution cwd instead of an out-of-workspace MCP config cwd", { skip: IS_WINDOWS }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-mcp-managed-cwd-"));
		const workspaceCwd = join(root, "workspace");
		const configCwd = join(root, "extension-config");
		await mkdir(workspaceCwd);
		await mkdir(configCwd);
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const scope = processScope();
		const sessionId = createRuntimeId("session", "mcp-managed-cwd");
		const script = [
			`const {Server}=require(${JSON.stringify(requireFromTest.resolve("@modelcontextprotocol/sdk/server/index.js"))});`,
			`const {StdioServerTransport}=require(${JSON.stringify(requireFromTest.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});`,
			`const {ListToolsRequestSchema,CallToolRequestSchema}=require(${JSON.stringify(requireFromTest.resolve("@modelcontextprotocol/sdk/types.js"))});`,
			"const server=new Server({name:'runledger-managed-cwd-fixture',version:'1.0.0'},{capabilities:{tools:{}}});",
			"server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'cwd',inputSchema:{type:'object'}}]}));",
			"server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:process.cwd()}]}));",
			"server.connect(new StdioServerTransport());",
		].join("");
		const processPort = new ProductionManagedProcessPort({ layout, scope, hostGeneration: 1, allowTestOnlyUnrestrictedExecution: true });
		const manager = new McpConnectionManager({
			factory: createSdkMcpClientFactory({
				managedProcess: processPort.toolClient(sessionId, 1, "principal_mcp"),
				managedProcessCwd: workspaceCwd,
			}),
		});
		try {
			const started = await manager.start({
				serverId: "mcp-server:managed-cwd",
				displayName: "managed-cwd",
				transport: "stdio",
				enabled: true,
				trusted: true,
				required: true,
				startupTimeoutMs: 5_000,
				toolTimeoutMs: 5_000,
				stdio: { command: process.execPath, args: ["-e", script], cwd: configCwd },
			});
			expect(started.ok, JSON.stringify(started)).toBe(true);
			if (!started.ok) return;
			await expect(manager.call({ serverId: "mcp-server:managed-cwd", toolName: "cwd", input: {} })).resolves.toMatchObject({
				ok: true,
				value: { content: [{ type: "text", text: workspaceCwd }] },
			});
		} finally {
			await manager.closeAll();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});
});
