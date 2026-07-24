import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionControlPlane } from "../../src/extensions/control-plane/control-plane.ts";
import { runBoundedDiscovery } from "../../src/extensions/discovery-worker.ts";
import { ExtensionManager } from "../../src/extensions/extension-manager.ts";
import type { HookCommandExecutorPort } from "../../src/extensions/hooks/types.ts";
import type { McpClientFactoryPort } from "../../src/extensions/mcp/types.ts";
import { discoverPlugins } from "../../src/extensions/plugins/discovery.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot } from "../../src/extensions/types.ts";
import {
	makeExtensionTempDir,
	NodeTestExtensionStorage,
	removeExtensionTempDir,
	TEST_SCOPE,
} from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const fixtureRoot = resolve("tests/fixtures/extensions/plugin/team-tools");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

describe("Extension discovery-only control plane", () => {
	it("inspects trusted plugin descriptors without MCP, process, network, or Hook execution side effects", async () => {
		const parent = await temporary("inspect-side-effects");
		const extensionRoot = join(parent, ".runledger");
		const pluginRoot = join(extensionRoot, "plugins", "team-tools");
		await mkdir(join(extensionRoot, "plugins"), { recursive: true });
		await cp(fixtureRoot, pluginRoot, { recursive: true });
		const root: ExtensionSourceRoot = {
			source: "project",
			sourceKey: "project:inspect",
			rootPath: extensionRoot,
			priority: 200,
		};
		const state = new ExtensionStateStore(join(parent, "state.json"), storage);
		const trust = new TrustStore(join(parent, "trust.json"), storage);
		const initial = await discoverPlugins({
			roots: [root],
			scope: TEST_SCOPE,
			trustStore: trust,
			storage,
			state: await state.load(),
			pluginDataRoot: join(parent, "plugin-data"),
		});
		const plugin = initial.plugins[0];
		if (!plugin) throw new Error("fixture plugin was not discovered");
		await state.setEnabled(plugin.descriptor.identity.qualifiedId, true);
		await trust.grant({
			identity: plugin.descriptor.identity,
			canonicalPath: plugin.rootPath,
			binding: plugin.descriptor.manifest,
			principalId: TEST_SCOPE.principalId,
			scope: "project",
		});
		let connectCalls = 0;
		let hookCalls = 0;
		const mcpFactory: McpClientFactoryPort = {
			connect: async () => {
				connectCalls += 1;
				throw new Error("inspect must not connect MCP");
			},
		};
		const hookExecutor: HookCommandExecutorPort = {
			execute: async () => {
				hookCalls += 1;
				throw new Error("inspect must not execute Hook");
			},
		};
		const manager = new ExtensionManager({
			scope: TEST_SCOPE,
			roots: [root],
			storage,
			trustStore: trust,
			stateStore: state,
			pluginDataRoot: join(parent, "plugin-data"),
			mcpFactory,
			hookExecutor,
		});
		const inspected = await manager.inspect();
		expect(connectCalls).toBe(0);
		expect(hookCalls).toBe(0);
		expect(manager.current()).toBeUndefined();
		expect(inspected.plugins).toHaveLength(1);
		expect(inspected.skills).toHaveLength(1);
		expect(inspected.hooks).toHaveLength(1);
		expect(inspected.mcpServers).toHaveLength(1);
		expect(inspected.mcpServers[0]?.descriptor).toMatchObject({
			trust: "trusted",
			activation: "blocked",
		});
		expect(JSON.stringify(inspected)).not.toContain("raw-access-token");
		expect(JSON.stringify(inspected)).not.toContain("fake-mcp-server.mjs\",\"args");
	});

	it("keeps worker results deterministic while limiting active tasks", async () => {
		let active = 0;
		let peak = 0;
		const results = await runBoundedDiscovery(
			["z", "a", "m", "b"].map((entryName, index) => ({
				rootPriority: index % 2,
				canonicalPath: `/root/${entryName}`,
				entryName,
				run: async () => {
					active += 1;
					peak = Math.max(peak, active);
					await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, (4 - index) * 3));
					active -= 1;
					return entryName;
				},
			})),
			2,
		);
		expect(peak).toBeLessThanOrEqual(2);
		expect(results).toEqual(["m", "z", "a", "b"]);
	});

	it("reports corrupt state and trust metadata without creating runtime objects", async () => {
		const parent = await temporary("inspect-corrupt-control-state");
		const statePath = join(parent, "state.json");
		const trustPath = join(parent, "trust.json");
		await writeFile(statePath, "{broken");
		await writeFile(trustPath, JSON.stringify({
			schemaVersion: 1,
			revision: 1,
			records: [{ schemaVersion: 1, receiptDigest: "tampered" }],
		}));
		const manager = new ExtensionManager({
			scope: TEST_SCOPE,
			roots: [],
			storage,
			trustStore: new TrustStore(trustPath, storage),
			stateStore: new ExtensionStateStore(statePath, storage),
			pluginDataRoot: join(parent, "plugin-data"),
		});
		const inspected = await manager.inspect();
		expect(inspected.snapshot.diagnostics).toMatchObject([
			{ code: "extensions.state_invalid", severity: "error" },
			{ code: "extensions.trust_invalid", severity: "error" },
		]);
		expect(manager.current()).toBeUndefined();
	});

	it("allows discovery commands and fails privileged commands closed without runtime ports", async () => {
		const parent = await temporary("inspect-control-plane");
		const manager = new ExtensionManager({
			scope: TEST_SCOPE,
			roots: [],
			storage,
			trustStore: new TrustStore(join(parent, "trust.json"), storage),
			stateStore: new ExtensionStateStore(join(parent, "state.json"), storage),
			pluginDataRoot: join(parent, "plugin-data"),
		});
		const control = new ExtensionControlPlane({ discovery: manager });
		expect(await control.execute({ kind: "inspect", json: true })).toMatchObject({
			schemaVersion: 1,
			ok: true,
			exitCode: 0,
		});
		expect(await control.execute({ kind: "plugin-list", json: true })).toMatchObject({
			ok: true,
			data: [],
		});
		expect(await control.execute({ kind: "mcp-doctor", json: true })).toMatchObject({
			ok: false,
			exitCode: 4,
			error: { code: "privileged_ports_unavailable" },
		});
		expect(await control.execute({
			kind: "trust-grant",
			resourceId: "plugin:project:missing",
			json: true,
		})).toMatchObject({
			ok: false,
			exitCode: 4,
			error: { code: "privileged_ports_unavailable" },
		});
	});
});
