import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHookConfig } from "../../src/extensions/hooks/config.ts";
import { HookRunner } from "../../src/extensions/hooks/runner.ts";
import { loadMcpConfig } from "../../src/extensions/mcp/config.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import type { ExtensionSourceRoot } from "../../src/extensions/types.ts";
import {
	makeExtensionTempDir,
	NodeTestExtensionStorage,
	removeExtensionTempDir,
	TEST_SCOPE,
} from "./helpers.ts";

const storage = new NodeTestExtensionStorage();
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function fixture(label: string): Promise<{
	rootPath: string;
	root: ExtensionSourceRoot;
	trust: TrustStore;
}> {
	const rootPath = await makeExtensionTempDir(label);
	temporaryDirectories.push(rootPath);
	return {
		rootPath,
		root: {
			source: "project",
			sourceKey: `project:${label}`,
			rootPath,
			priority: 200,
		},
		trust: new TrustStore(join(rootPath, "trust.json"), storage),
	};
}

describe("Extension config schema v2 compatibility", () => {
	it("parses HTTP Hook handlers as network capabilities and routes execution through the injected policy handler", async () => {
		const value = await fixture("hook-v2");
		const configPath = join(value.rootPath, "hooks", "http.json");
		await mkdir(join(value.rootPath, "hooks"), { recursive: true });
		await writeFile(configPath, JSON.stringify({
			schemaVersion: 2,
			hooks: {
				PreToolUse: [{
					id: "policy-http",
					handlers: [{ type: "http", url: "https://hooks.example.test/review" }],
				}],
			},
		}));
		const loaded = await loadHookConfig({
			configPath,
			root: value.root,
			scope: TEST_SCOPE,
			trustStore: value.trust,
			storage,
		});
		expect(loaded.diagnostics).toEqual([]);
		const hook = loaded.hooks[0];
		if (!hook) throw new Error("HTTP Hook was not loaded");
		expect(hook.handlers).toMatchObject([{
			type: "http",
			url: "https://hooks.example.test/review",
		}]);
		expect(hook.descriptor.capabilities).toMatchObject([{
			boundary: { kind: "network", access: "connect" },
		}]);
		let calls = 0;
		const runner = new HookRunner({
			http: {
				invoke: async (url, envelope) => {
					calls += 1;
					expect(url).toBe("https://hooks.example.test/review");
					expect(envelope.payload).toMatchObject({ toolName: "Read" });
					return {
						ok: true,
						status: 200,
						responseDigest: "response-digest",
						output: { decision: "allow", updatedInput: { path: "safe.txt" } },
					};
				},
			},
		});
		const outcome = await runner.run(hook, hook.handlers[0]!, {
			schemaVersion: 1,
			event: "PreToolUse",
			eventId: "event-http-v2",
			timestamp: "2026-07-24T00:00:00.000Z",
			sessionId: "session-http-v2",
			cwd: value.rootPath,
			snapshotId: "snapshot-http-v2",
			source: "project",
			payload: { toolName: "Read", input: { path: "original.txt" } },
		});
		expect(calls).toBe(1);
		expect(outcome).toMatchObject({
			status: "allowed",
			decision: "allow",
			updatedInput: { path: "safe.txt" },
			stdoutDigest: "response-digest",
		});
	});

	it("keeps MCP v1 compatible and binds OAuth server, scopes, and client identity into v2 digest", async () => {
		const value = await fixture("mcp-v2");
		const configPath = join(value.rootPath, "mcp.json");
		const document = {
			schemaVersion: 2,
			mcpServers: {
				remote: {
					transport: "streamable-http",
					url: "https://mcp.example.test/rpc",
					oauth: {
						authorizationServer: "https://auth.example.test/",
						scopes: ["tools.read", "tools.call"],
						clientId: "runledger-cli",
						clientName: "RunLedger",
					},
				},
			},
		};
		await writeFile(configPath, JSON.stringify(document));
		const first = await loadMcpConfig({
			configPath,
			root: value.root,
			scope: TEST_SCOPE,
			trustStore: value.trust,
			storage,
		});
		expect(first.diagnostics).toEqual([]);
		const server = first.servers[0];
		if (!server || server.config.transport !== "streamable-http") {
			throw new Error("OAuth MCP server was not loaded");
		}
		expect(server.config.oauth).toMatchObject({
			authorizationServer: "https://auth.example.test/",
			scopes: ["tools.call", "tools.read"],
			clientId: "runledger-cli",
			clientName: "RunLedger",
		});
		const firstDigest = server.descriptor.manifest.combinedDigest;
		await writeFile(configPath, JSON.stringify({
			...document,
			mcpServers: {
				remote: {
					...document.mcpServers.remote,
					oauth: {
						...document.mcpServers.remote.oauth,
						clientName: "RunLedger Changed",
					},
				},
			},
		}));
		const changed = await loadMcpConfig({
			configPath,
			root: value.root,
			scope: TEST_SCOPE,
			trustStore: value.trust,
			storage,
		});
		expect(changed.servers[0]?.descriptor.manifest.combinedDigest).not.toBe(firstDigest);

		await writeFile(configPath, JSON.stringify({
			schemaVersion: 1,
			mcpServers: {
				legacy: {
					transport: "streamable-http",
					url: "https://legacy.example.test/rpc",
				},
			},
		}));
		expect((await loadMcpConfig({
			configPath,
			root: value.root,
			scope: TEST_SCOPE,
			trustStore: value.trust,
			storage,
		})).servers).toHaveLength(1);
	});
});
