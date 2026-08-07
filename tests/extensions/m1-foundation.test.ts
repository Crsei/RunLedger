import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAN_ASSERT_FILE_MODE, canCreateSymlink } from "../helpers/platform.ts";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { boundDiagnostics, DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, redactDiagnosticText, sortExtensionDiagnostics } from "../../src/extensions/diagnostics.ts";
import { intersectAllowedTools, mergeExtensionConfigLayers } from "../../src/extensions/config-layers.ts";
import { digestDirectory, buildResourceManifestDigest } from "../../src/extensions/trust/digest.ts";
import { TrustStore, trustRecordToApprovalReceipt } from "../../src/extensions/trust/trust-store.ts";
import { ExtensionStateStore } from "../../src/extensions/state-store.ts";
import { buildExtensionSnapshot, ExtensionSnapshotStore } from "../../src/extensions/snapshot.ts";
import { resolveContainedPath } from "../../src/extensions/paths.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";
import type { ExtensionResourceDescriptor } from "../../src/extensions/types.ts";
import type { ResourceIdentity } from "../../src/runtime/resources/types.ts";

const temporaryRoots: string[] = [];

const CAN_SYMLINK = canCreateSymlink();

function storageError(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT") return { ok: false, code: "missing", message: "path is missing" };
	if (code === "EACCES" || code === "EPERM") return { ok: false, code: "denied", message: "path access denied" };
	return { ok: false, code: "io", message: error instanceof Error ? error.message : "storage operation failed" };
}

class NodeTestExtensionStorage implements ExtensionStoragePort {
	public async realpath(path: string) {
		try {
			return { ok: true as const, value: await realpath(path) };
		} catch (error) {
			return storageError(error);
		}
	}

	public async stat(path: string, options?: { followSymlinks?: boolean }) {
		try {
			const value = options?.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" as const : value.isDirectory() ? "directory" as const : value.isSymbolicLink() ? "symlink" as const : "other" as const;
			return { ok: true as const, value: { kind, size: value.size } };
		} catch (error) {
			return storageError(error);
		}
	}

	public async readDirectory(path: string) {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return {
				ok: true as const,
				value: entries.map((entry) => ({
					name: entry.name,
					kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : entry.isSymbolicLink() ? "symlink" as const : "other" as const,
				})),
			};
		} catch (error) {
			return storageError(error);
		}
	}

	public async readFile(path: string, maxBytes: number) {
		try {
			const info = await stat(path);
			if (info.size > maxBytes) return { ok: false as const, code: "oversize" as const, message: "file exceeds byte bound" };
			const value = await readFile(path);
			return value.byteLength > maxBytes
				? { ok: false as const, code: "oversize" as const, message: "file exceeds byte bound" }
				: { ok: true as const, value };
		} catch (error) {
			return storageError(error);
		}
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) {
		const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
		try {
			await mkdir(dirname(path), { recursive: true, mode: options.directoryMode });
			await writeFile(temporary, bytes, { mode: options.fileMode });
			await rename(temporary, path);
			return { ok: true as const, value: undefined };
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			return storageError(error);
		}
	}
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary(label: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), `runledger-extension-${label}-`));
	temporaryRoots.push(path);
	return path;
}

function resourceIdentity(qualifiedId = "skill:project:fixture"): ResourceIdentity {
	const digest = "a".repeat(64) as ResourceIdentity["digest"]["digest"];
		return {
		resourceId: createRuntimeId("resource", "extension-fixture"),
		kind: "skill",
		qualifiedId,
		version: "1.0.0",
		source: "project",
		digest: { algorithm: "sha256", digest },
	};
}

function descriptor(qualifiedId: string, runtimeName?: string): ExtensionResourceDescriptor {
	const digest = { algorithm: "sha256" as const, digest: "b".repeat(64) as ResourceIdentity["digest"]["digest"] };
	return {
		identity: { kind: "skill", qualifiedId, version: "1.0.0", source: "project", digest: "extension-digest" },
		resource: { ...resourceIdentity(qualifiedId), digest },
		provenance: { source: "project", sourceLocatorDigest: digest },
		enabled: true,
		trusted: true,
		ready: true,
		...(runtimeName ? { runtimeName } : {}),
	};
}

describe("M1 extension foundation", () => {
	it("sorts and bounds diagnostics while redacting secret-shaped text", () => {
		const diagnostics = [
			extensionDiagnostic("z.warning", "warning", "token=private-value", "test", "/z"),
			extensionDiagnostic("a.error", "error", "bad", "test", "/a"),
			extensionDiagnostic("i.info", "info", "ok", "test", "/i"),
		];
		expect(sortExtensionDiagnostics(diagnostics).map((item) => item.code)).toEqual(["a.error", "z.warning", "i.info"]);
		expect(redactDiagnosticText("Authorization: Bearer private-value", ["private-value"])).toBe("[redacted-key]: [redacted-key] [redacted]");
		expect(boundDiagnostics(diagnostics, 2)).toHaveLength(2);
		expect(DEFAULT_EXTENSION_LIMITS.maxEntries).toBeGreaterThan(0);
	});

	it("merges layers by explicit priority and only narrows allowed tools", () => {
		const merged = mergeExtensionConfigLayers([
			{ source: "user", config: { enabled: false, nested: { safe: true } }, digest: "user" },
			{ source: "project", config: { enabled: true, nested: { project: true } }, digest: "project" },
		]);
		expect(merged.config).toEqual({ enabled: true, nested: { safe: true, project: true } });
		expect(merged.digest).toHaveLength(64);
		expect(intersectAllowedTools(["read", "write", "bash"], ["bash", "read", "unknown"])).toEqual(["read", "bash"]);
		expect(intersectAllowedTools(["read"], ["write"])).toEqual([]);
	});

	it("rejects lexical and symlink escapes and bounds deterministic directory digests", { skip: !CAN_SYMLINK }, async () => {
		const root = await temporary("paths");
		const outside = await temporary("outside");
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "safe.txt"), "safe");
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(outside, join(root, "escape"));
		const storage = new NodeTestExtensionStorage();
		expect(await resolveContainedPath(storage, root, "../outside/secret.txt")).toMatchObject({ ok: false, code: "escape" });
		expect(await resolveContainedPath(storage, root, "escape/secret.txt")).toMatchObject({ ok: false, code: "invalid" });
		expect(await digestDirectory(storage, root)).toMatchObject({ ok: false, code: "escape" });
		const digestRoot = await temporary("digest");
		await mkdir(join(digestRoot, "nested"), { recursive: true });
		await writeFile(join(digestRoot, "nested", "safe.txt"), "safe");
		const digest = await digestDirectory(storage, digestRoot);
		expect(digest).toMatchObject({ ok: true, files: 1 });
		const repeated = await digestDirectory(storage, digestRoot);
		if (digest.ok && repeated.ok) expect(repeated.digest).toBe(digest.digest);
		const bounded = await digestDirectory(storage, digestRoot, { ...DEFAULT_EXTENSION_LIMITS, maxDiscoveryDepth: 0 });
		expect(bounded).toMatchObject({ ok: false, code: "oversize" });
	});

	it("binds trust to exact identity, path, digest, principal and revocation", async () => {
		const root = await temporary("trust");
		const storage = new NodeTestExtensionStorage();
		const trust = new TrustStore(join(root, "trust.json"), storage);
		const identity = resourceIdentity();
		const binding = buildResourceManifestDigest({ rootDigest: canonicalDigest("root"), manifestDigest: canonicalDigest("manifest"), assetsDigest: canonicalDigest("assets") });
		const principalId = createRuntimeId("principal", "extension-principal");
		const record = await trust.grant({ identity, canonicalPath: root, binding, principalId, scope: "project", issuedAt: "2026-08-04T00:00:00.000Z" });
		expect((await trust.evaluate({ identity, canonicalPath: root, binding, principalId })).state).toBe("trusted");
		expect(trustRecordToApprovalReceipt(record)).toMatchObject({ receiptId: record.receiptId, identity, configDigest: { algorithm: "sha256" } });
		expect((await trust.evaluate({ identity, canonicalPath: `${root}-other`, binding, principalId })).state).toBe("stale");
		expect((await trust.evaluate({ identity, canonicalPath: root, binding: { ...binding, assetsDigest: canonicalDigest("changed") }, principalId })).state).toBe("stale");
		await trust.revoke(identity.qualifiedId, new Date("2026-08-04T01:00:00.000Z"));
		expect((await trust.evaluate({ identity, canonicalPath: root, binding, principalId })).state).toBe("revoked");
		if (CAN_ASSERT_FILE_MODE) expect((await stat(join(root, "trust.json"))).mode & 0o777).toBe(0o600);
	});

	it("rejects a trust document missing its binding metadata instead of treating it as trusted", async () => {
		const root = await temporary("trust-schema");
		const storage = new NodeTestExtensionStorage();
		const path = join(root, "trust.json");
		const trust = new TrustStore(path, storage);
		const identity = resourceIdentity();
		const binding = buildResourceManifestDigest({ rootDigest: canonicalDigest("root"), manifestDigest: canonicalDigest("manifest") });
		const principalId = createRuntimeId("principal", "schema-principal");
		const record = await trust.grant({ identity, canonicalPath: root, binding, principalId, scope: "project", issuedAt: "2026-08-04T00:00:00.000Z" });
		const document = JSON.parse(await readFile(path, "utf8")) as { records: Array<Record<string, unknown>> };
		const stored = document.records[0];
		if (!stored) throw new Error("missing trust fixture");
		delete stored.locatorDigest;
		await writeFile(path, `${JSON.stringify(document)}\n`);
		const reloaded = new TrustStore(path, storage);
		expect((await reloaded.evaluate({ identity, canonicalPath: root, binding, principalId })).state).toBe("untrusted");
		expect(reloaded.loadError()).toContain("schema");
		expect(record.receiptId).toBeTypeOf("string");
	});

	it("atomically stores enabled state and retains a last-known-good snapshot across pending reload", async () => {
		const root = await temporary("state-snapshot");
		const storage = new NodeTestExtensionStorage();
		const state = new ExtensionStateStore(join(root, "extensions-state.json"), storage);
		await state.setEnabled("skill:project:fixture", false, new Date("2026-08-04T00:00:00.000Z"));
		const saved = JSON.parse(await readFile(join(root, "extensions-state.json"), "utf8")) as { resources: Record<string, { enabled: boolean }> };
		expect(saved.resources["skill:project:fixture"]?.enabled).toBe(false);
		if (CAN_ASSERT_FILE_MODE) expect((await stat(join(root, "extensions-state.json"))).mode & 0o777).toBe(0o600);
		const first = buildExtensionSnapshot({ snapshotId: "snapshot-one", generation: 1, createdAt: "2026-08-04T00:00:00.000Z", descriptors: [descriptor("skill:project:a", "tool_a")], diagnostics: [] });
		const second = buildExtensionSnapshot({ snapshotId: "snapshot-two", generation: 2, createdAt: "2026-08-04T00:01:00.000Z", descriptors: [descriptor("skill:project:b", "tool_b")], diagnostics: [] });
		expect(Object.isFrozen(first.descriptors)).toBe(true);
		const snapshots = new ExtensionSnapshotStore();
		expect(snapshots.swap(first)).toMatchObject({ ok: true });
		snapshots.beginTurn();
		expect(snapshots.swap(second)).toMatchObject({ ok: false, retained: first });
		expect(snapshots.pending()).toBe(true);
		expect(snapshots.endTurn()).toBe(true);
		expect(snapshots.swap(second)).toMatchObject({ ok: true, snapshot: second });
	});
});
