import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { ExtensionHostManager } from "../../src/extensions/host-manager.ts";
import { PluginManager } from "../../src/extensions/plugins/manager.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { createSkillRegistry } from "../../src/extensions/skills/registry.ts";
import { NodeExtensionStorage } from "../../src/storage/extensions/extension-storage.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import type { DiscoveryProvider } from "../../src/extensions/capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../../src/extensions/skills/registry.ts";

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
			const stateStore = new ExtensionStateStore(join(root, "home", "state", "extensions", "extensions-state.json"), storage);
			const pluginManager = new PluginManager({
				storage,
				trustStore: new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage),
				stateStore,
				scope: scope(),
				roots: [{ source: "project", sourceKey: "project:fixture", rootPath: resolve(pluginRoot), priority: 200 }],
			});
			const skillRegistry = createSkillRegistry({
				storage,
				trustStore: new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage),
				stateStore,
				scope: scope(),
				pluginContributions: () => pluginManager.last()?.skillContributions ?? [],
			});
			const manager = new ExtensionHostManager({ pluginManager, skillRegistry, now: () => new Date("2026-08-05T00:00:00.000Z") });
			const first = await manager.load();
			expect(first.status).toBe("ready");
			if (first.status !== "ready") return;
			expect(manager.currentHooks()).toEqual([]);
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

	it("redacts complete external roots from public provider failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-redaction-"));
		try {
			const fakeHome = join(root, "private-user-home");
			const storage = new NodeExtensionStorage({ runledgerHome: join(root, "home") });
			const stateStore = new ExtensionStateStore(join(root, "home", "state", "extensions", "extensions-state.json"), storage);
			const trustStore = new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage);
			const pluginManager = new PluginManager({ storage, trustStore, stateStore, scope: scope(), roots: [] });
			const skillRegistry = createSkillRegistry({ storage, trustStore, stateStore, scope: scope(), pluginContributions: () => [], codexUserHome: fakeHome });
			const manager = new ExtensionHostManager({
				pluginManager,
				skillRegistry,
				skillsPolicyLoader: async () => ({ masterEnabled: true, providerEnabled: new Map([["codex-user", true]]), diagnostics: [] }),
			});
			expect((await manager.load()).status).toBe("ready");
			const provider = manager.publicSnapshot()?.skillProviders.find((item) => item.providerId === "codex-user");
			expect(provider).toMatchObject({ state: "unavailable" });
			expect(provider?.lastError).not.toContain(fakeHome);
			expect(JSON.stringify(manager.publicSnapshot())).not.toContain(fakeHome);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects mutation for a provider that is not registered", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-provider-mutation-"));
		try {
			let writes = 0;
			const storage = new NodeExtensionStorage({ runledgerHome: join(root, "home") });
			const stateStore = new ExtensionStateStore(join(root, "home", "state", "extensions", "extensions-state.json"), storage);
			const trustStore = new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage);
			const pluginManager = new PluginManager({ storage, trustStore, stateStore, scope: scope(), roots: [] });
			const skillRegistry = createSkillRegistry({ storage, trustStore, stateStore, scope: scope(), pluginContributions: () => [] });
			const manager = new ExtensionHostManager({
				pluginManager,
				skillRegistry,
				updateSkillsProviderPolicy: async () => { writes += 1; },
			});
			expect((await manager.load()).status).toBe("ready");
			await expect(manager.setSkillProviderEnabled("unregistered-provider", true, "user")).resolves.toMatchObject({ status: "failed" });
			expect(writes).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("publishes parent and Skill snapshots atomically when turn admission rejects a reload", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-extension-snapshot-"));
		try {
			const pluginRoot = join(root, "plugin");
			const hookPath = join(pluginRoot, "hooks", "hooks.json");
			await mkdir(join(pluginRoot, ".runledger-plugin"), { recursive: true });
			await mkdir(join(pluginRoot, "hooks"), { recursive: true });
			await writeFile(join(pluginRoot, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "atomic-plugin", version: "1.0.0", description: "Atomic hook fixture", hooks: ["./hooks/hooks.json"] }));
			await writeFile(hookPath, JSON.stringify({ hooks: { SessionStart: [{ id: "start", handlers: [{ type: "command", command: "./start.sh", args: [], timeoutMs: 1000, env: {} }] }] } }));
			const alphaRoot = join(root, "skills", "alpha");
			const betaRoot = join(root, "skills", "beta");
			await mkdir(alphaRoot, { recursive: true });
			await mkdir(betaRoot, { recursive: true });
			await writeFile(join(alphaRoot, "SKILL.md"), "---\nname: alpha\ndescription: alpha\n---\nAlpha.\n");
			await writeFile(join(betaRoot, "SKILL.md"), "---\nname: beta\ndescription: beta\n---\nBeta.\n");
			let observations = [alphaRoot, betaRoot];
			let delayed = false;
			let releaseReload: (() => void) | undefined;
			let markReloadStarted: (() => void) | undefined;
			const reloadStarted = new Promise<void>((resolveStarted) => { markReloadStarted = resolveStarted; });
			const provider: DiscoveryProvider<SkillDiscoveryObservation> = {
				id: "atomic-probe",
				displayName: "Atomic probe",
				capabilityId: "skills",
				rank: 10,
				defaultEnabled: true,
				load: async () => {
					if (delayed) {
						markReloadStarted?.();
						await new Promise<void>((resolveReload) => { releaseReload = resolveReload; });
					}
					return {
						ok: true,
						providerId: "atomic-probe",
						observations: observations.map((canonicalRoot) => ({
							providerId: "atomic-probe",
							source: "user" as const,
							level: "user" as const,
							canonicalRoot,
							scanKind: "single-skill-directory" as const,
							priority: 100,
						})),
					};
				},
			};
			const storage = new NodeExtensionStorage({ runledgerHome: join(root, "home") });
			const stateStore = new ExtensionStateStore(join(root, "home", "state", "extensions", "extensions-state.json"), storage);
			const trustStore = new TrustStore(join(root, "home", "state", "extensions", "trust.json"), storage);
			const pluginManager = new PluginManager({ storage, trustStore, stateStore, scope: scope(), roots: [{ source: "project", sourceKey: "project:atomic", rootPath: resolve(pluginRoot), priority: 200 }] });
			const skillRegistry = createSkillRegistry({ storage, trustStore, stateStore, scope: scope(), pluginContributions: () => [], providers: [provider] });
			const manager = new ExtensionHostManager({ pluginManager, skillRegistry });

			const plugin = await pluginManager.discover();
			const pluginId = plugin.plugins[0]!.descriptor.identity.qualifiedId;
			await pluginManager.trust(pluginId);
			await pluginManager.setEnabled(pluginId, true);
			const discovered = await manager.load();
			expect(discovered.status).toBe("ready");
			for (const skill of skillRegistry.current()?.all ?? []) await skillRegistry.trust(skill.descriptor.identity.qualifiedId);
			const active = await manager.load();
			expect(active.status).toBe("ready");
			expect(manager.currentSkills().map((skill) => skill.descriptor.displayName).sort()).toEqual(["alpha", "beta"]);
			expect(manager.currentHooks()).toHaveLength(1);

			manager.beginTurn();
			await expect(manager.setEnabled(pluginId, false)).resolves.toMatchObject({ status: "pending" });
			expect(manager.currentHooks()).toHaveLength(1);
			await expect(manager.endTurn()).resolves.toMatchObject({ status: "ready" });
			expect(manager.currentHooks()).toHaveLength(0);
			await expect(manager.setEnabled(pluginId, true)).resolves.toMatchObject({ status: "ready" });
			expect(manager.currentHooks()).toHaveLength(1);
			const retained = manager.current();

			observations = [betaRoot];
			await writeFile(hookPath, JSON.stringify({ hooks: { SessionStart: [{ id: "changed", handlers: [{ type: "command", command: "./changed.sh", args: [], timeoutMs: 1000, env: {} }] }] } }));
			delayed = true;
			const reload = manager.reload();
			await reloadStarted;
			expect(manager.beginTurn()).toBe(retained);
			releaseReload?.();
			await expect(reload).resolves.toMatchObject({ status: "failed", retained });
			expect(manager.current()).toBe(retained);
			expect(manager.currentSkills().map((skill) => skill.descriptor.displayName).sort()).toEqual(["alpha", "beta"]);
			expect(manager.currentHooks()).toHaveLength(1);
			delayed = false;
			await expect(manager.endTurn()).resolves.toMatchObject({ status: "ready" });
			expect(manager.currentSkills().map((skill) => skill.descriptor.displayName)).toEqual(["beta"]);
			expect(manager.currentHooks()).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
