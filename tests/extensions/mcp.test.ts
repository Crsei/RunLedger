import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { loadMcpConfig, mergeMcpServers } from "../../src/extensions/mcp/config.ts";
import { OfficialMcpClientFactory, OfficialMcpSdkTransportBroker } from "../../src/extensions/mcp/client-factory.ts";
import { McpConnectionManager } from "../../src/extensions/mcp/connection-manager.ts";
import { normalizeMcpResult } from "../../src/extensions/mcp/result-normalizer.ts";
import { McpCallTool, McpSearchTool, pinnedMcpTools } from "../../src/extensions/mcp/tool-adapter.ts";
import type { McpServerDescriptor, McpTransportAuthorizationPort } from "../../src/extensions/mcp/types.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot, ExtensionSpillPort } from "../../src/extensions/types.ts";
import { FakeMcpAuthorization, FakeMcpEventSink, makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];
const fixturePluginRoot = resolve("tests/fixtures/extensions/plugin/team-tools");

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function root(path: string, priority = 200): ExtensionSourceRoot {
	return { source: "project", sourceKey: "project:mcp-test", rootPath: path, priority };
}

class ExactTransportAuthorization implements McpTransportAuthorizationPort {
	public enabled = true;
	public stale = false;

	public async authorize(server: McpServerDescriptor) {
		if (!this.enabled) return undefined;
		return {
			receiptId: "transport-test",
			serverId: server.descriptor.identity.qualifiedId,
			configDigest: server.descriptor.manifest.combinedDigest,
			transport: server.config.transport,
			expiresAt: this.stale ? "2000-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z",
		};
	}
}

async function trustedFixtureServer(): Promise<McpServerDescriptor> {
	const trustRoot = await temporary("mcp-trust");
	const trust = new TrustStore(join(trustRoot, "trust.json"), storage);
	const configPath = join(fixturePluginRoot, "mcp.json");
	const initial = await loadMcpConfig({ configPath, root: root(fixturePluginRoot), scope: TEST_SCOPE, trustStore: trust, storage, pluginRoot: fixturePluginRoot });
	const server = initial.servers[0];
	if (!server) throw new Error("fixture MCP server was not discovered");
	await trust.grant({ identity: server.descriptor.identity, canonicalPath: configPath, binding: server.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });
	const trusted = await loadMcpConfig({ configPath, root: root(fixturePluginRoot), scope: TEST_SCOPE, trustStore: trust, storage, pluginRoot: fixturePluginRoot });
	const result = trusted.servers[0];
	if (!result) throw new Error("trusted fixture MCP server was not discovered");
	return result;
}

describe("MCP configuration and connection manager", () => {
	it("treats absent root mcp.json as optional while preserving exact schema and secret-template failures", async () => {
		const parent = await temporary("mcp-config");
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const optional = await loadMcpConfig({ configPath: join(parent, "missing.json"), root: root(parent), scope: TEST_SCOPE, trustStore: trust, storage, optional: true });
		expect(optional).toEqual({ servers: [], diagnostics: [] });
		const configPath = join(parent, "mcp.json");
		await writeFile(configPath, JSON.stringify({ schemaVersion: 1, mcpServers: { fixture: { transport: "stdio", command: "node", env: { TOKEN: "${MISSING_TOKEN}" } } } }));
		const unresolved = await loadMcpConfig({ configPath, root: root(parent), scope: TEST_SCOPE, trustStore: trust, storage });
		expect(unresolved.servers).toHaveLength(0);
		expect(unresolved.diagnostics.map((item) => item.code)).toContain("mcp.env_missing");
		await writeFile(configPath, JSON.stringify({ schemaVersion: 1, mcpServers: { fixture: { transport: "stdio", command: "node", env: { TOKEN: "$(unsafe)" } } } }));
		const commandTemplate = await loadMcpConfig({ configPath, root: root(parent), scope: TEST_SCOPE, trustStore: trust, storage });
		expect(commandTemplate.servers).toHaveLength(0);
		expect(JSON.stringify(commandTemplate.diagnostics)).not.toContain("unsafe-token-value");
	});

	it("merges layers deterministically and reports equal-priority conflicts", async () => {
		const first = await trustedFixtureServer();
		const second = { ...first, descriptor: { ...first.descriptor, identity: { ...first.descriptor.identity, qualifiedId: `${first.descriptor.identity.qualifiedId}:duplicate` } } };
		const merged = mergeMcpServers([{ servers: [first], diagnostics: [] }, { servers: [second], diagnostics: [] }]);
		expect(merged.servers).toHaveLength(1);
		expect(merged.diagnostics.map((item) => item.code)).toContain("mcp.layer_conflict");
	});

	it("runs the official SDK stdio transport with search/call/pinned tools, per-call authorization and auxiliary authorization", async () => {
		const server = await trustedFixtureServer();
		const transportAuthorization = new ExactTransportAuthorization();
		const authorization = new FakeMcpAuthorization();
		const events = new FakeMcpEventSink();
		const manager = new McpConnectionManager({
			servers: [server],
			factory: new OfficialMcpClientFactory(transportAuthorization, new OfficialMcpSdkTransportBroker()),
			authorization,
			auxiliaryAuthorization: authorization,
			events,
		});
		try {
			const statuses = await manager.startAll();
			expect(statuses).toMatchObject([{ state: "ready", toolCount: 2 }]);
			expect(manager.requiredGate().ok).toBe(true);
			const search = new McpSearchTool(manager).execute({ query: "Echo", limit: 10 });
			expect(search).toHaveLength(1);
			expect(search[0]).toMatchObject({ rawName: "echo", runtimeName: "mcp__fixture__echo" });
			const serverId = server.descriptor.identity.qualifiedId;
			const called = await new McpCallTool(manager).execute({ serverId, toolName: "echo", input: { text: "hello" } });
			expect(called.ok).toBe(true);
			if (called.ok) {
				expect(called.value.content.some((item) => item.type === "text" && item.text === "hello")).toBe(true);
				expect(called.value.content.some((item) => item.type === "resource" && item.uri === "fixture://resource")).toBe(true);
			}
			expect(events.tools).toHaveLength(1);
			const pinned = pinnedMcpTools(manager);
			expect(pinned.map((tool) => tool.name)).toEqual(["mcp__fixture__echo"]);
			const resources = await manager.listResources(serverId);
			expect(resources.ok).toBe(true);
			const prompts = await manager.getPrompt(serverId, "fixture-prompt", {});
			expect(prompts.ok).toBe(true);
			authorization.stale = true;
			expect(await manager.call(serverId, "echo", { text: "denied" })).toMatchObject({ ok: false, code: "denied" });
			expect(await manager.readResource(serverId, "fixture://resource")).toMatchObject({ ok: false, code: "denied" });
		} finally {
			await manager.closeAll();
		}
		expect(events.states.map((item) => item.newState)).toEqual(expect.arrayContaining(["starting", "ready", "stopping", "stopped"]));
	});

	it("enforces tool timeout and required startup failure without leaking a ready catalog", async () => {
		const server = await trustedFixtureServer();
		const authorization = new FakeMcpAuthorization();
		const manager = new McpConnectionManager({
			servers: [server],
			factory: new OfficialMcpClientFactory(new ExactTransportAuthorization(), new OfficialMcpSdkTransportBroker()),
			authorization,
			events: new FakeMcpEventSink(),
		});
		try {
			await manager.startAll();
			expect(await manager.call(server.descriptor.identity.qualifiedId, "slow", {})).toMatchObject({ ok: false, code: "timeout" });
		} finally {
			await manager.closeAll();
		}
		const events = new FakeMcpEventSink();
		const failed = new McpConnectionManager({ servers: [server], factory: { connect: async () => { throw new Error("fixture startup failed"); } }, events });
		await failed.startAll();
		expect(failed.status()).toMatchObject([{ state: "failed", toolCount: 0 }]);
		expect(failed.catalog().list()).toHaveLength(0);
		expect(failed.requiredGate()).toMatchObject({ ok: false, code: "not_ready" });
		await failed.closeAll();
	});

	it("fails closed for missing or stale transport grants before creating a process", async () => {
		const server = await trustedFixtureServer();
		const authorization = new ExactTransportAuthorization();
		authorization.enabled = false;
		await expect(new OfficialMcpClientFactory(authorization, new OfficialMcpSdkTransportBroker()).connect(server)).rejects.toThrow(/denied or stale/u);
		authorization.enabled = true;
		authorization.stale = true;
		await expect(new OfficialMcpClientFactory(authorization, new OfficialMcpSdkTransportBroker()).connect(server)).rejects.toThrow(/denied or stale/u);
	});

	it("normalizes and spills oversized MCP results without exposing unbounded output", async () => {
		const writes: Array<{ kind: string; bytes: number }> = [];
		const spill: ExtensionSpillPort = {
			write: async (kind, bytes) => {
				writes.push({ kind, bytes: bytes.byteLength });
				return { relativePath: "spill/mcp-result", digest: canonicalDigest(bytes.byteLength), bytes: bytes.byteLength };
			},
		};
		const result = await normalizeMcpResult({ content: [{ type: "text", text: "x".repeat(300_000) }], structuredContent: { secret: "not-a-secret-field-contract" }, isError: false }, spill);
		expect(result.truncated).toBe(true);
		expect(result.spill?.bytes).toBeGreaterThan(256 * 1024);
		expect(writes).toMatchObject([{ kind: "mcp-result" }]);
		expect(JSON.stringify(result.content).length).toBeLessThan(270_000);
	});
});
