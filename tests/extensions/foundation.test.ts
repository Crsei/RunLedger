import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { buildExtensionSnapshot } from "../../src/extensions/snapshot.ts";
import { mergeExtensionConfigLayers } from "../../src/extensions/config-layers.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../../src/extensions/diagnostics.ts";
import { createExtensionResourceIdentity } from "../../src/extensions/identity.ts";
import { resolveContainedPath } from "../../src/extensions/paths.ts";
import { HooksConfigSchema, schemaAccepts } from "../../src/extensions/schemas.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { digestDirectory, buildResourceManifestDigest } from "../../src/extensions/trust/digest.ts";
import { TrustStore, trustRecordToApprovalReceipt } from "../../src/extensions/trust/trust-store.ts";
import { parsePluginManifest } from "../../src/extensions/plugins/manifest.ts";
import type { ExtensionResourceDescriptor } from "../../src/extensions/types.ts";
import { makeExtensionTempDir, NodeTestExtensionStorage, removeExtensionTempDir, TEST_SCOPE } from "./helpers.ts";

const temporaryDirectories: string[] = [];
const storage = new NodeTestExtensionStorage();

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(removeExtensionTempDir));
});

async function temporary(label: string): Promise<string> {
	const path = await makeExtensionTempDir(label);
	temporaryDirectories.push(path);
	return path;
}

function descriptor(qualifiedId = "skill:project:fixture", runtimeName?: string): ExtensionResourceDescriptor {
	const manifest = buildResourceManifestDigest({ rootDigest: canonicalDigest({ qualifiedId }) });
	return {
		schemaVersion: 1,
		kind: "skill",
		identity: createExtensionResourceIdentity({ scope: TEST_SCOPE, kind: "skill", qualifiedId, version: "1", source: "project", digest: manifest.combinedDigest }),
		provenance: { schemaVersion: 1, authorityId: TEST_SCOPE.authorityId, tenantId: TEST_SCOPE.tenantId, source: "project", canonicalLocator: `/repo/.runledger/skills/${qualifiedId}` },
		manifest,
		displayName: qualifiedId,
		description: "fixture skill",
		...(runtimeName ? { runtimeName } : {}),
		sourcePath: `/repo/.runledger/skills/${qualifiedId}/SKILL.md`,
		enabled: true,
		trust: "trusted",
		activation: "ready",
		capabilities: [],
		risk: { level: "low", sideEffect: "none", rationaleDigest: canonicalDigest("fixture") },
		exposure: "deferred",
		diagnostics: [],
	};
}

describe("Extension foundation contracts", () => {
	it("builds a stable immutable snapshot and rejects identity/name collisions", () => {
		const snapshot = buildExtensionSnapshot({
			snapshotId: "snapshot_fixture",
			generation: 1,
			createdAt: "2026-07-22T00:00:00.000Z",
			descriptors: [descriptor("skill:project:z"), descriptor("skill:project:a", "fixture_tool")],
			diagnostics: [extensionDiagnostic("fixture.warning", "warning", "pending", "test")],
		});
		expect(snapshot.descriptors.map((item) => item.identity.qualifiedId)).toEqual(["skill:project:a", "skill:project:z"]);
		expect(snapshot.counts).toMatchObject({ skills: 2, ready: 2 });
		expect(snapshot.digest).toHaveLength(64);
		expect(Object.isFrozen(snapshot.descriptors)).toBe(true);
		expect(() => buildExtensionSnapshot({ generation: 1, createdAt: snapshot.createdAt, descriptors: [descriptor(), descriptor()], diagnostics: [] })).toThrow(/duplicate extension identity/u);
		expect(() => buildExtensionSnapshot({ generation: 1, createdAt: snapshot.createdAt, descriptors: [descriptor("skill:one", "same"), descriptor("skill:two", "same")], diagnostics: [] })).toThrow(/runtime name conflict/u);
	});

	it("keeps config precedence and security budgets explicit", () => {
		const merged = mergeExtensionConfigLayers([
			{ source: "user", config: { enabled: false }, digest: "user" },
			{ source: "project", config: { enabled: true }, digest: "project" },
		]);
		expect(merged.config.enabled).toBe(true);
		expect(merged.sources).toEqual(["user", "project"]);
		expect(DEFAULT_EXTENSION_LIMITS.maxFiles).toBeGreaterThan(0);
		expect(DEFAULT_EXTENSION_LIMITS.maxSkillBodyBytes).toBeLessThanOrEqual(1024 * 1024);
	});

	it("enforces exact schema versions and rejects undeclared hook fields", () => {
		const invalidVersion = parsePluginManifest(Buffer.from(JSON.stringify({ schemaVersion: 2, name: "fixture", version: "1.0.0", description: "fixture" })), "plugin.json");
		expect(invalidVersion.ok).toBe(false);
		if (!invalidVersion.ok) expect(invalidVersion.diagnostics[0]?.code).toBe("plugin.schema_version");
		expect(schemaAccepts(HooksConfigSchema, { schemaVersion: 1, hooks: {}, extra: true })).toBe(false);
	});

	it("blocks lexical and symlink escapes and detects directory cycles", async () => {
		const parent = await temporary("extension-paths");
		const root = join(parent, "root");
		const outside = join(parent, "outside");
		await mkdir(root);
		await mkdir(outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "escape"));
		const lexical = await resolveContainedPath(storage, root, "../outside/secret.txt");
		const escaped = await resolveContainedPath(storage, root, "escape/secret.txt");
		expect(lexical).toMatchObject({ ok: false, code: "escape" });
		expect(escaped).toMatchObject({ ok: false, code: "escape" });
		const escapedDigest = await digestDirectory(storage, root);
		expect(escapedDigest).toMatchObject({ ok: false, code: "escape" });
		const cycleRoot = join(parent, "cycle-root");
		await mkdir(cycleRoot);
		await writeFile(join(cycleRoot, "safe.txt"), "safe");
		await symlink(cycleRoot, join(cycleRoot, "cycle"));
		const cycle = await digestDirectory(storage, cycleRoot);
		expect(cycle).toMatchObject({ ok: false, code: "cycle" });
	});

	it("binds trust to exact identity, canonical root, content, principal, expiry and revocation", async () => {
		const root = await temporary("extension-trust");
		const trustPath = join(root, "trust.json");
		const trust = new TrustStore(trustPath, storage);
		const resource = descriptor();
		const record = await trust.grant({ identity: resource.identity, canonicalPath: root, binding: resource.manifest, principalId: TEST_SCOPE.principalId, scope: "project", issuedAt: "2026-07-22T00:00:00.000Z" });
		const evaluated = await trust.evaluate({ identity: resource.identity, canonicalPath: root, binding: resource.manifest, principalId: TEST_SCOPE.principalId, at: new Date("2026-07-22T01:00:00.000Z") });
		expect(evaluated.state).toBe("trusted");
		expect(trustRecordToApprovalReceipt(record)).toMatchObject({ receiptId: record.receiptId, identity: resource.identity, binding: resource.manifest });
		const changed = buildResourceManifestDigest({ rootDigest: canonicalDigest("changed") });
		expect((await trust.evaluate({ identity: resource.identity, canonicalPath: root, binding: changed, principalId: TEST_SCOPE.principalId })).state).toBe("stale");
		expect((await trust.evaluate({ identity: resource.identity, canonicalPath: `${root}-other`, binding: resource.manifest, principalId: TEST_SCOPE.principalId })).state).toBe("stale");
		await trust.revoke(resource.identity.qualifiedId, new Date("2026-07-22T02:00:00.000Z"));
		expect((await trust.evaluate({ identity: resource.identity, canonicalPath: root, binding: resource.manifest, principalId: TEST_SCOPE.principalId })).state).toBe("revoked");
		expect((await stat(trustPath)).mode & 0o777).toBe(0o600);
	});

	it("writes extension state atomically with mode 0600 and preserves unknown top-level fields", async () => {
		const root = await temporary("extension-state");
		const statePath = join(root, "extensions-state.json");
		await writeFile(statePath, JSON.stringify({ schemaVersion: 1, revision: 0, resources: {}, future: { keep: true } }));
		const state = new ExtensionStateStore(statePath, storage);
		await state.setEnabled("skill:project:fixture", false, new Date("2026-07-22T00:00:00.000Z"));
		const stored = JSON.parse(await readFile(statePath, "utf8")) as { revision: number; resources: Record<string, { enabled: boolean }>; future: { keep: boolean } };
		expect(stored.revision).toBe(1);
		expect(stored.resources["skill:project:fixture"]?.enabled).toBe(false);
		expect(stored.future.keep).toBe(true);
		expect((await stat(statePath)).mode & 0o777).toBe(0o600);
	});
});
