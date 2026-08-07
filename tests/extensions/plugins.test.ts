import { describe, expect, it } from "vitest";
import { canCreateSymlink } from "../helpers/platform.ts";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parsePluginManifest, PluginManager } from "../../src/extensions/plugins/manager.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

const CAN_SYMLINK = canCreateSymlink();

class NodeExtensionStorage implements ExtensionStoragePort {
	async realpath(path: string): Promise<ExtensionStorageResult<string>> {
		try { return { ok: true, value: await realpath(path) }; }
		catch { return { ok: false, code: "missing", message: "missing" }; }
	}
	async stat(path: string, options: { readonly followSymlinks?: boolean } = {}): Promise<ExtensionStorageResult<{ readonly kind: "file" | "directory" | "symlink" | "other"; readonly size: number }>> {
		try {
			const value = options.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" : value.isDirectory() ? "directory" : value.isSymbolicLink() ? "symlink" : "other";
			return { ok: true, value: { kind, size: value.size } };
		} catch { return { ok: false, code: "missing", message: "missing" }; }
	}
	async readDirectory(path: string): Promise<ExtensionStorageResult<readonly { readonly name: string; readonly kind: "file" | "directory" | "symlink" | "other" }[]>> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return { ok: true, value: entries.map((entry) => ({ name: entry.name, kind: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other" })) };
		} catch { return { ok: false, code: "missing", message: "missing" }; }
	}
	async readFile(path: string, maxBytes: number): Promise<ExtensionStorageResult<Uint8Array>> {
		try {
			const value = await readFile(path);
			if (value.byteLength > maxBytes) return { ok: false, code: "oversize", message: "oversize" };
			return { ok: true, value };
		} catch { return { ok: false, code: "missing", message: "missing" }; }
	}
	async writeFileAtomic(path: string, data: Uint8Array): Promise<ExtensionStorageResult<void>> {
		try {
			await mkdir(resolve(path, ".."), { recursive: true });
			await writeFile(path, data);
			return { ok: true, value: undefined };
		} catch {
			return { ok: false, code: "io", message: "write failed" };
		}
	}
}

function scope() {
	return {
		authorityId: createRuntimeId("authority", "plugin-test"),
		tenantId: createRuntimeId("tenant", "plugin-test"),
		principalId: createRuntimeId("principal", "plugin-test"),
	};
}

describe("Plugin manifest and manager", () => {
	it("parses the current exact manifest and rejects unknown fields", () => {
		const valid = parsePluginManifest({
			name: "team-tools",
			version: "1.0.0",
			description: "Audited team workflows",
			author: { name: "Platform Team" },
			keywords: ["review"],
			skills: ["./skills"],
			hooks: ["./hooks/hooks.json"],
			mcpServers: "./.mcp.json",
		}, "plugin.json");
		expect(valid.ok).toBe(true);
		const invalid = parsePluginManifest({ name: "team-tools", version: "1.0.0", description: "x", extra: true }, "plugin.json");
		expect(invalid.ok).toBe(false);
		expect(invalid.diagnostics.some((item) => item.code === "plugin.unknown_field")).toBe(true);
	});

	it("discovers an untrusted plugin without reading or executing component bodies", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-plugin-"));
		try {
			await mkdir(join(root, ".runledger-plugin"));
			await mkdir(join(root, "skills", "review-release"), { recursive: true });
			await mkdir(join(root, "hooks"));
			await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "team-tools", version: "1.0.0", description: "Audited team workflows", skills: ["./skills"], hooks: ["./hooks/hooks.json"], mcpServers: "./.mcp.json" }));
			await writeFile(join(root, "skills", "review-release", "SKILL.md"), "---\nname: review-release\ndescription: Review releases\n---\nbody");
			await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ id: "deny", handlers: [{ type: "command", command: "./deny.sh", args: [], timeoutMs: 1000, env: {} }] }] } }));
			await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
			const storage = new NodeExtensionStorage();
			const trust = new TrustStore(join(root, "trust.json"), storage);
			const state = new ExtensionStateStore(join(root, "state.json"), storage);
			const manager = new PluginManager({ storage, trustStore: trust, stateStore: state, scope: scope(), roots: [{ source: "project", sourceKey: "project:fixture", rootPath: resolve(root), priority: 200 }] });
			const result = await manager.discover();
			expect(result.plugins).toHaveLength(1);
			expect(result.plugins[0]?.descriptor.identity.qualifiedId).toBe("plugin:project:fixture:team-tools");
			expect(result.plugins[0]?.descriptor.enabled).toBe(false);
			expect(result.plugins[0]?.descriptor.trust).toBe("untrusted");
			expect(result.descriptors.filter((descriptor) => descriptor.kind !== "plugin").every((descriptor) => descriptor.pluginId === "plugin:project:fixture:team-tools")).toBe(true);
			expect(result.descriptors.some((descriptor) => descriptor.kind === "skill")).toBe(true);
			expect(result.descriptors.some((descriptor) => descriptor.kind === "hook")).toBe(true);
			expect(result.descriptors.some((descriptor) => descriptor.kind === "mcp-server")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retains trusted enabled hook definitions for the resident Host snapshot", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-plugin-hooks-"));
		const stateRoot = await mkdtemp(join(tmpdir(), "runledger-plugin-hooks-state-"));
		try {
			await mkdir(join(root, ".runledger-plugin"));
			await mkdir(join(root, "hooks"));
			await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "hook-plugin", version: "1.0.0", description: "Hook fixture", hooks: ["./hooks/hooks.json"] }));
			await writeFile(join(root, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ id: "start", handlers: [{ type: "command", command: "./start.sh", args: [], timeoutMs: 1000, env: {} }] }] } }));
			const storage = new NodeExtensionStorage();
			const manager = new PluginManager({ storage, trustStore: new TrustStore(join(stateRoot, "trust.json"), storage), stateStore: new ExtensionStateStore(join(stateRoot, "state.json"), storage), scope: scope(), roots: [{ source: "project", sourceKey: "project:hook", rootPath: resolve(root), priority: 200 }] });
			const initial = await manager.discover();
			const pluginId = initial.plugins[0]!.descriptor.identity.qualifiedId;
			await manager.trust(pluginId);
			const result = await manager.setEnabled(pluginId, true);
			expect(result.hooks).toHaveLength(1);
			expect(result.hooks[0]).toMatchObject({ id: "start", event: "SessionStart" });
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(stateRoot, { recursive: true, force: true });
		}
	});

	it("rejects a component path that resolves outside the plugin root", { skip: !CAN_SYMLINK }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-plugin-"));
		const outside = await mkdtemp(join(tmpdir(), "runledger-plugin-outside-"));
		try {
			await mkdir(join(root, ".runledger-plugin"));
			await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "escape", version: "1.0.0", description: "x", skills: ["./outside"] }));
			await symlink(outside, join(root, "outside"));
			const storage = new NodeExtensionStorage();
			const manager = new PluginManager({ storage, trustStore: new TrustStore(join(root, "trust.json"), storage), stateStore: new ExtensionStateStore(join(root, "state.json"), storage), scope: scope(), roots: [{ source: "project", sourceKey: "project:escape", rootPath: resolve(root), priority: 200 }] });
			const result = await manager.discover();
			expect(result.plugins[0]?.descriptor.activation).toBe("failed");
			expect(result.diagnostics.some((item) => item.code === "plugin.path_escape")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("projects an invalid manifest as a failed plugin descriptor", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-plugin-"));
		try {
			await mkdir(join(root, ".runledger-plugin"));
			await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({
				name: "TeamTools",
				version: "not-semver",
				description: "invalid",
				unknown: true,
			}));
			const storage = new NodeExtensionStorage();
			const manager = new PluginManager({
				storage,
				trustStore: new TrustStore(join(root, "trust.json"), storage),
				stateStore: new ExtensionStateStore(join(root, "state.json"), storage),
				scope: scope(),
				roots: [{ source: "project", sourceKey: "project:invalid", rootPath: resolve(root), priority: 200 }],
			});
			const result = await manager.discover();
			const plugin = result.descriptors.find((descriptor) => descriptor.kind === "plugin");
			expect(plugin?.activation).toBe("failed");
			expect(plugin?.enabled).toBe(false);
			expect(plugin?.ready).toBe(false);
			expect(result.diagnostics.some((item) => item.code === "plugin.name_invalid")).toBe(true);
			expect(result.diagnostics.some((item) => item.code === "plugin.unknown_field")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("marks duplicate plugin identities failed instead of selecting by discovery order", async () => {
		const first = await mkdtemp(join(tmpdir(), "runledger-plugin-"));
		const second = await mkdtemp(join(tmpdir(), "runledger-plugin-"));
		try {
			for (const root of [first, second]) {
				await mkdir(join(root, ".runledger-plugin"));
				await writeFile(join(root, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "same", version: "1.0.0", description: "duplicate" }));
			}
			const storage = new NodeExtensionStorage();
			const manager = new PluginManager({
				storage,
				trustStore: new TrustStore(join(first, "trust.json"), storage),
				stateStore: new ExtensionStateStore(join(first, "state.json"), storage),
				scope: scope(),
				roots: [
					{ source: "project", sourceKey: "project:duplicate", rootPath: resolve(first), priority: 200 },
					{ source: "project", sourceKey: "project:duplicate", rootPath: resolve(second), priority: 201 },
				],
			});
			const result = await manager.discover();
			expect(result.plugins).toHaveLength(2);
			expect(result.plugins.every((plugin) => plugin.descriptor.activation === "failed")).toBe(true);
			expect(result.diagnostics.some((item) => item.code === "plugin.duplicate_identity")).toBe(true);
		} finally {
			await rm(first, { recursive: true, force: true });
			await rm(second, { recursive: true, force: true });
		}
	});
});
