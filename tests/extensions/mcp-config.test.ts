import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { loadCanonicalMcpConfigs, parseMcpConfigDocument } from "../../src/extensions/mcp/config.ts";
import { NodeExtensionStorage } from "../../src/storage/extensions/extension-storage.ts";

describe("canonical MCP config", () => {
	it("resolves bounded env templates without exposing the template source", () => {
		const parsed = parseMcpConfigDocument({
			mcpServers: {
				fixture: {
					transport: "stdio",
					command: "node",
					args: ["server.js"],
					cwd: ".",
					env: { TOKEN: "${MCP_FIXTURE_TOKEN}" },
					enabled: true,
					startupTimeoutMs: 1000,
					toolTimeoutMs: 2000,
				},
			},
		}, { source: "user", path: "/runledger/state/extensions/user/mcp.json", environment: { MCP_FIXTURE_TOKEN: "secret-value" } });

		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.configs[0]).toMatchObject({ serverId: "mcp-server:user:fixture", trusted: true, stdio: { cwd: "/runledger/state/extensions/user" } });
			expect(parsed.configs[0]?.stdio?.env).toEqual({ TOKEN: "secret-value" });
		}
	});

	it("fails closed on unknown fields and missing secret templates", () => {
		const parsed = parseMcpConfigDocument({
			mcpServers: {
				broken: {
					transport: "stdio",
					command: "node",
					enabled: true,
					unknown: true,
					env: { TOKEN: "${MISSING_TOKEN}" },
				},
			},
		}, { source: "user", path: "/runledger/state/extensions/user/mcp.json", environment: {} });

		expect(parsed.ok).toBe(false);
		expect(parsed.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(["mcp.missing_env", "mcp.unknown_field"]);
	});

	it("loads user and workspace authority with workspace override", async () => {
		const home = await mkdtemp(join(tmpdir(), "runledger-mcp-config-"));
		const layout = buildRunledgerLayout(home, "posix");
		const userRoot = join(layout.state, "extensions", "user");
		const workspaceRoot = join(layout.state, "extensions", "workspaces", "ws-test");
		await mkdir(userRoot, { recursive: true });
		await mkdir(workspaceRoot, { recursive: true });
		await writeFile(join(userRoot, "mcp.json"), JSON.stringify({ mcpServers: { shared: { transport: "stdio", command: "node", enabled: false } } }));
		await writeFile(join(workspaceRoot, "mcp.json"), JSON.stringify({ mcpServers: { shared: { transport: "stdio", command: "node", enabled: true, required: true } } }));

		const loaded = await loadCanonicalMcpConfigs({ layout, workspaceStorageKey: "ws-test", storage: new NodeExtensionStorage({ runledgerHome: home }), environment: {} });
		expect(loaded.diagnostics).toEqual([]);
		expect(loaded.configs).toHaveLength(1);
		expect(loaded.configs[0]).toMatchObject({ serverId: "mcp-server:workspace:shared", enabled: true, required: true, trusted: true });
	});
});
