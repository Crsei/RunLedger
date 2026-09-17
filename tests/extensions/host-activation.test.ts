import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { ExtensionInstaller } from "../../src/extensions/plugins/installer.ts";
import type { ExtensionSourceMaterializer } from "../../src/extensions/plugins/installer.ts";
import { ExtensionDistributionRegistry, resolveExtensionDistributionPaths } from "../../src/extensions/plugins/marketplace/registry.ts";
import { TrustStore } from "../../src/extensions/trust/trust-store.ts";
import { buildResourceManifestDigest } from "../../src/extensions/trust/digest.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import {
	describeHostGate,
	distributionHostIdentity,
	selectDistributionHostCandidates,
} from "../../src/extensions/plugins/host-activation.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const principalId = createRuntimeId("principal", "host-activation-test");

function manifest(version: string, entrypoints: readonly string[]): Record<string, unknown> {
	return {
		name: "exec-plugin",
		version,
		description: "executable plugin",
		capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false },
		extensions: [...entrypoints],
		commands: [],
		skills: [],
		hooks: [],
	};
}

async function environment(options: { readonly executable?: boolean } = {}) {
	const base = await mkdtemp(join(tmpdir(), "runledger-host-act-"));
	roots.push(base);
	const home = join(base, "home");
	const source = join(base, "source");
	const stateRoot = join(home, "state", "extensions");
	await mkdir(join(source, "src"), { recursive: true });
	await mkdir(home, { recursive: true });
	const entrypoints = options.executable === false ? [] : ["./src/index.ts"];
	await writeFile(join(source, "package.json"), JSON.stringify({
		name: "exec-plugin",
		version: "1.0.0",
		runledger: manifest("1.0.0", entrypoints),
	}), "utf8");
	await writeFile(join(source, "src", "index.ts"), "export default () => undefined;\n", "utf8");

	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	const registry = new ExtensionDistributionRegistry({
		storage,
		paths: resolveExtensionDistributionPaths({ stateRoot, pluginsRoot: join(stateRoot, "plugins") }),
	});
	const materializer: ExtensionSourceMaterializer = { materialize: async () => ({ ok: false, code: "network_denied", message: "no network" }) };
	const installer = new ExtensionInstaller({
		storage, registry, materializer,
		pluginsRoot: join(stateRoot, "plugins"),
		scopeRoot: (scope) => scope === "user" ? join(stateRoot, "plugins", "user") : join(stateRoot, "plugins", "workspaces", "ws-1"),
	});
	const trustStore = new TrustStore(join(stateRoot, "trust.json"), storage);
	const install = await installer.install({
		packageId: "exec-plugin@local",
		name: "exec-plugin",
		source: { kind: "local", path: source, locator: "plugins/exec-plugin" },
		scope: "user",
	});
	if (!install.ok) throw new Error(`fixture install failed: ${install.code} ${install.message}`);
	return { home, stateRoot, storage, registry, installer, trustStore, receipt: install.receipt };
}

/** 与 host-activation 相同的 binding 形状；grant 时必须一致。 */
function bindingFor(digest: string, entrypoints: readonly string[]) {
	return buildResourceManifestDigest({
		rootDigest: digest,
		manifestDigest: runtimeDigest({ entrypoints }).digest,
		configDigest: canonicalDigest({ packageId: "exec-plugin@local", version: "1.0.0" }),
		assetsDigest: digest,
		capabilityDigest: canonicalDigest({ entrypoints }),
	});
}

async function grant(env: Awaited<ReturnType<typeof environment>>, digest = env.receipt.digest) {
	const candidate = {
		packageId: "exec-plugin@local",
		name: "exec-plugin",
		version: "1.0.0",
		digest,
		installPath: env.receipt.installPath,
		scope: "user" as const,
		enabled: true,
		entrypoints: ["./src/index.ts"],
		declaredTools: [],
	};
	await env.trustStore.grant({
		identity: distributionHostIdentity(candidate),
		canonicalPath: env.receipt.installPath,
		binding: bindingFor(digest, candidate.entrypoints),
		principalId,
		scope: "user",
	});
}

describe("distribution host activation", () => {
	it("selects only packages that declare executable entrypoints", async () => {
		const env = await environment({ executable: false });
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		expect(selection.candidates).toEqual([]);
		expect(selection.gates).toEqual([]);
		expect(selection.diagnostics).toEqual([]);
	});

	it("reports an installed executable package as disabled until it is enabled", async () => {
		const env = await environment();
		await grant(env);
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		expect(selection.candidates).toHaveLength(1);
		expect(selection.ready).toEqual([]);
		const gate = selection.gates[0];
		expect(gate?.ok).toBe(false);
		if (gate !== undefined && !gate.ok) {
			expect(gate.code).toBe("disabled");
			expect(describeHostGate(gate)).toContain("disabled");
		}
	});

	it("reports enabled-but-never-trusted as untrusted, not as ready", async () => {
		const env = await environment();
		// 启用但不 grant：安装/启用都不授予执行，缺 receipt 必须是 `untrusted`。
		const registry = await env.registry.loadRunledgerRegistry();
		if (!registry.ok) throw new Error("registry must load");
		const record = registry.document.plugins["exec-plugin@local"];
		if (record === undefined) throw new Error("record must exist");
		await env.registry.saveRunledgerRegistry({ ...registry.document, plugins: { ...registry.document.plugins, "exec-plugin@local": { ...record, enabled: true } } });
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		const gate = selection.gates[0];
		expect(gate?.ok).toBe(false);
		if (gate !== undefined && !gate.ok) {
			expect(gate.code).toBe("untrusted");
			expect(gate.message).toContain("trust record is missing");
		}
		expect(selection.ready).toEqual([]);
	});

	it("becomes ready only when enabled and trusted for the current content", async () => {
		const env = await environment();
		await grant(env);
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (!registry.ok) return;
		const record = registry.document.plugins["exec-plugin@local"];
		if (record === undefined) throw new Error("record must exist");
		await env.registry.saveRunledgerRegistry({ ...registry.document, plugins: { ...registry.document.plugins, "exec-plugin@local": { ...record, enabled: true } } });

		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		expect(selection.gates.map(describeHostGate)).toEqual(["exec-plugin@local@1.0.0: host-ready"]);
		expect(selection.ready).toHaveLength(1);
		expect(selection.ready[0]?.ok).toBe(true);
		if (selection.ready[0]?.ok) expect(selection.ready[0].receiptId.length).toBeGreaterThan(0);
	});

	it("turns stale when the installed content changes after approval", async () => {
		const env = await environment();
		await grant(env);
		const registry = await env.registry.loadRunledgerRegistry();
		if (!registry.ok) throw new Error("registry must load");
		const record = registry.document.plugins["exec-plugin@local"];
		if (record === undefined) throw new Error("record must exist");
		// 篡改内容并把账本 digest 改成新值：内容变了，旧 receipt 不再匹配（D8）。
		await writeFile(join(env.receipt.installPath, "src", "index.ts"), "export default () => 1;\n", "utf8");
		await env.registry.saveRunledgerRegistry({
			...registry.document,
			plugins: { ...registry.document.plugins, "exec-plugin@local": { ...record, enabled: true, digest: "f".repeat(64) } },
		});
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		const gate = selection.gates[0];
		expect(gate?.ok).toBe(false);
		if (gate !== undefined && !gate.ok) expect(gate.code).toBe("trust_stale");
	});

	it("reports revocation distinctly from a missing receipt", async () => {
		const env = await environment();
		await grant(env);
		const registry = await env.registry.loadRunledgerRegistry();
		if (!registry.ok) throw new Error("registry must load");
		const record = registry.document.plugins["exec-plugin@local"];
		if (record === undefined) throw new Error("record must exist");
		await env.registry.saveRunledgerRegistry({ ...registry.document, plugins: { ...registry.document.plugins, "exec-plugin@local": { ...record, enabled: true } } });
		const candidate = {
			packageId: "exec-plugin@local", name: "exec-plugin", version: "1.0.0", digest: env.receipt.digest,
			installPath: env.receipt.installPath, scope: "user" as const, enabled: true, entrypoints: ["./src/index.ts"], declaredTools: [],
		};
		await env.trustStore.revoke(distributionHostIdentity(candidate));
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		const gate = selection.gates[0];
		expect(gate?.ok).toBe(false);
		if (gate !== undefined && !gate.ok) expect(gate.code).toBe("trust_revoked");
	});

	it("surfaces an unreadable registry as a diagnostic instead of an empty selection", async () => {
		const env = await environment();
		await writeFile(join(env.stateRoot, "plugins", "registry.json"), "{ broken", "utf8");
		const selection = await selectDistributionHostCandidates({ registry: env.registry, storage: env.storage, trustStore: env.trustStore, principalId });
		expect(selection.candidates).toEqual([]);
		expect(selection.diagnostics).toHaveLength(1);
		expect(selection.diagnostics[0]?.message).toContain("registry.json");
	});
});
