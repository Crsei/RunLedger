import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionManager } from "../../src/extensions/extension-manager.ts";
import { HookRunner } from "../../src/extensions/hooks/runner.ts";
import { OfficialMcpClientFactory, OfficialMcpSdkTransportBroker } from "../../src/extensions/mcp/client-factory.ts";
import { McpConnectionManager } from "../../src/extensions/mcp/connection-manager.ts";
import type { McpServerDescriptor, McpTransportAuthorizationPort } from "../../src/extensions/mcp/types.ts";
import { discoverPlugins } from "../../src/extensions/plugins/discovery.ts";
import { PluginManager } from "../../src/extensions/plugins/plugin-manager.ts";
import { SkillCatalog } from "../../src/extensions/skills/catalog.ts";
import { SkillToolResolver } from "../../src/extensions/skills/skill-tool.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot } from "../../src/extensions/types.ts";
import { FakeMcpAuthorization, FakeMcpEventSink, NodeTestExtensionStorage, NodeTestHookExecutor, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];
const fixtureRoot = resolve("tests/fixtures/extensions/plugin/team-tools");

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(resolve("tests/fixtures/extensions"), `.tmp-${label}-`));
	temporaryDirectories.push(path);
	return path;
}

function root(path: string): ExtensionSourceRoot {
	return { source: "project", sourceKey: "project:plugin-test", rootPath: path, priority: 200 };
}

class PluginTransportAuthorization implements McpTransportAuthorizationPort {
	public async authorize(server: McpServerDescriptor) {
		return { receiptId: "plugin-transport", serverId: server.descriptor.identity.qualifiedId, configDigest: server.descriptor.manifest.combinedDigest, transport: server.config.transport, expiresAt: "2999-01-01T00:00:00.000Z" };
	}
}

describe("Plugin composition lifecycle", () => {
	it("keeps untrusted plugins metadata-only, then composes Skill/Hook/MCP with parent provenance after exact trust", async () => {
		const parent = await temporary("plugin-lifecycle");
		const extensionRoot = join(parent, ".runledger");
		const pluginRoot = join(extensionRoot, "plugins", "team-tools");
		await mkdir(join(extensionRoot, "plugins"), { recursive: true });
		await cp(fixtureRoot, pluginRoot, { recursive: true });
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const stateStore = new ExtensionStateStore(join(parent, "extensions-state.json"), storage);
		const source = root(extensionRoot);
		const initial = await discoverPlugins({ roots: [source], scope: TEST_SCOPE, trustStore: trust, storage, state: await stateStore.load(), pluginDataRoot: join(parent, "plugin-data") });
		expect(initial.plugins).toHaveLength(1);
		const plugin = initial.plugins[0];
		if (!plugin) throw new Error("fixture plugin was not discovered");
		expect(plugin.descriptor).toMatchObject({ enabled: false, trust: "untrusted", activation: "disabled" });
		expect(plugin.blockedComponentCount).toBe(3);
		const blocked = await new PluginManager({ scope: TEST_SCOPE, trustStore: trust, storage, state: await stateStore.load() }).contributions(plugin);
		expect(blocked).toMatchObject({ skills: [], hooks: [], mcpServers: [] });
		await stateStore.setEnabled(plugin.descriptor.identity.qualifiedId, true);
		await trust.grant({ identity: plugin.descriptor.identity, canonicalPath: plugin.rootPath, binding: plugin.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });
		const enabled = await discoverPlugins({ roots: [source], scope: TEST_SCOPE, trustStore: trust, storage, state: await stateStore.load(), pluginDataRoot: join(parent, "plugin-data") });
		const trustedPlugin = enabled.plugins[0];
		if (!trustedPlugin) throw new Error("trusted fixture plugin was not discovered");
		expect(trustedPlugin.descriptor).toMatchObject({ enabled: true, trust: "trusted", activation: "ready" });
		const contributions = await new PluginManager({ scope: TEST_SCOPE, trustStore: trust, storage, state: await stateStore.load() }).contributions(trustedPlugin);
		expect(contributions.skills).toHaveLength(1);
		expect(contributions.hooks).toHaveLength(1);
		expect(contributions.mcpServers).toHaveLength(1);
		for (const component of [...contributions.skills, ...contributions.hooks, ...contributions.mcpServers]) {
			expect(component.descriptor.pluginId).toBe(trustedPlugin.descriptor.identity.qualifiedId);
			expect(component.descriptor.provenance.parentPlugin).toEqual(trustedPlugin.descriptor.identity);
			expect(component.descriptor.activation).toBe("ready");
		}
		const skill = await new SkillToolResolver({ catalog: new SkillCatalog(contributions.skills), trustStore: trust, principalId: TEST_SCOPE.principalId, storage, currentTools: () => ["Read", "Bash", "Write"] }).load("$release-review release-1");
		expect(skill).toMatchObject({ ok: true, value: { argument: "release-1" } });
		const hook = contributions.hooks[0];
		if (!hook) throw new Error("plugin hook missing");
		const hookResult = await new HookRunner({ executor: new NodeTestHookExecutor() }).run(hook, hook.handlers[0]!, { schemaVersion: 1, event: "PreToolUse", eventId: "plugin-hook", timestamp: "2026-07-22T00:00:00.000Z", sessionId: "plugin-session", cwd: parent, snapshotId: "plugin-snapshot", source: "plugin", payload: { toolName: "Bash", input: { command: "echo unsafe" } } });
		expect(hookResult).toMatchObject({ status: "denied", decision: "deny" });
		const mcpAuthorization = new FakeMcpAuthorization();
		const mcp = new McpConnectionManager({ servers: contributions.mcpServers, factory: new OfficialMcpClientFactory(new PluginTransportAuthorization(), new OfficialMcpSdkTransportBroker()), authorization: mcpAuthorization, events: new FakeMcpEventSink() });
		try {
			await mcp.startAll();
			expect(mcp.status()).toMatchObject([{ state: "ready", toolCount: 2 }]);
		} finally {
			await mcp.closeAll();
		}
	});

	it("keeps the active immutable snapshot through a turn and marks changed plugin content stale at idle reload", async () => {
		const parent = await temporary("plugin-reload");
		const extensionRoot = join(parent, ".runledger");
		const pluginRoot = join(extensionRoot, "plugins", "team-tools");
		await mkdir(join(extensionRoot, "plugins"), { recursive: true });
		await cp(fixtureRoot, pluginRoot, { recursive: true });
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const state = new ExtensionStateStore(join(parent, "extensions-state.json"), storage);
		const discovery = await discoverPlugins({ roots: [root(extensionRoot)], scope: TEST_SCOPE, trustStore: trust, storage, state: await state.load(), pluginDataRoot: join(parent, "plugin-data") });
		const plugin = discovery.plugins[0];
		if (!plugin) throw new Error("fixture plugin missing");
		await state.setEnabled(plugin.descriptor.identity.qualifiedId, true);
		await trust.grant({ identity: plugin.descriptor.identity, canonicalPath: plugin.rootPath, binding: plugin.descriptor.manifest, principalId: TEST_SCOPE.principalId, scope: "project" });
		const authorization = new FakeMcpAuthorization();
		const manager = new ExtensionManager({
			scope: TEST_SCOPE,
			roots: [root(extensionRoot)],
			storage,
			trustStore: trust,
			stateStore: state,
			pluginDataRoot: join(parent, "plugin-data"),
			hookExecutor: new NodeTestHookExecutor(),
			mcpFactory: new OfficialMcpClientFactory(new PluginTransportAuthorization(), new OfficialMcpSdkTransportBroker()),
			mcpAuthorization: authorization,
			mcpEvents: new FakeMcpEventSink(),
		});
		try {
			const loaded = await manager.reload();
			expect(loaded.status).toBe("applied");
			const active = manager.beginTurn();
			expect(active.plugins[0]?.descriptor.activation).toBe("ready");
			const pending = manager.requestReload();
			expect(pending.status).toBe("pending");
			await writeFile(join(pluginRoot, "skills", "release-review", "references", "checklist.md"), "# Changed after snapshot\n");
			expect(manager.current()?.snapshot.snapshotId).toBe(active.snapshot.snapshotId);
			const reloaded = await manager.endTurn();
			expect(reloaded?.status).toBe("applied");
			expect(manager.current()?.plugins[0]?.descriptor.trust).toBe("stale");
			expect(manager.current()?.plugins[0]?.descriptor.activation).toBe("blocked");
			expect(manager.current()?.skills).toHaveLength(0);
		} finally {
			await manager.close();
		}
	});
});
