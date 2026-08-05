import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionHostManager } from "../../src/extensions/host-manager.ts";
import { PluginManager } from "../../src/extensions/plugins/manager.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { NodeExtensionStorage } from "../../src/storage/extensions/extension-storage.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";

function scope() {
	return {
		authorityId: createRuntimeId("authority", "extension-host-test"),
		tenantId: createRuntimeId("tenant", "extension-host-test"),
		principalId: createRuntimeId("principal", "extension-host-test"),
	};
}

describe("resident ExtensionHostManager", () => {
	it("keeps one immutable snapshot during a turn and applies reload at idle", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-host-"));
		try {
			const pluginRoot = join(root, "plugin");
			await mkdir(join(pluginRoot, ".runledger-plugin"), { recursive: true });
			await writeFile(join(pluginRoot, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "fixture", version: "1.0.0", description: "fixture" }));
			const storage = new NodeExtensionStorage({ runledgerHome: join(root, "home") });
			const pluginManager = new PluginManager({
				storage,
				trustStore: new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage),
				stateStore: new ExtensionStateStore(join(root, "home", "state", "extensions", "extensions-state.json"), storage),
				scope: scope(),
				roots: [{ source: "project", sourceKey: "project:fixture", rootPath: resolve(pluginRoot), priority: 200 }],
			});
			const manager = new ExtensionHostManager({ pluginManager, now: () => new Date("2026-08-05T00:00:00.000Z") });
			const first = await manager.load();
			expect(first.status).toBe("ready");
			if (first.status !== "ready") return;
			expect(first.snapshot.generation).toBe(1);
			expect(first.snapshot.counts.plugins).toBe(1);
			const firstDigest = first.snapshot.digest;

			manager.beginTurn();
			const pending = await manager.reload();
			expect(pending).toMatchObject({ status: "pending" });
			expect(manager.current()?.digest).toBe(firstDigest);
			const applied = await manager.endTurn();
			expect(applied).toMatchObject({ status: "ready", snapshot: { generation: 2 } });

			const projection = manager.publicSnapshot();
			expect(projection?.descriptors[0]).not.toHaveProperty("sourcePath");
			expect(JSON.stringify(projection)).not.toContain(pluginRoot);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
