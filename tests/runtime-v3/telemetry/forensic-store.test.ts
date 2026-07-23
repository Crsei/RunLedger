import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ArtifactKeyDescriptor,
	ArtifactKeyProvider,
	ArtifactKeyProviderStatus,
	ArtifactKeyRequest,
} from "../../../src/runtime/artifacts/key-provider.ts";
import type { ArtifactResult } from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createForensicAccessDecision,
	EncryptedForensicStore,
	type ForensicAccessControlPort,
	type ForensicAccessOperation,
	type ForensicAccessRequest,
} from "../../../src/runtime/telemetry/forensic-store.ts";
import {
	evaluateForensicTraceGate,
	type ForensicTracePermit,
	type ForensicTraceRequestRef,
} from "../../../src/runtime/telemetry/redaction.ts";
import { TELEMETRY_SCHEMA_VERSION } from "../../../src/runtime/telemetry/types.ts";

const roots: string[] = [];
const authorityId = createRuntimeId("authority", "forensic-store");
const tenantId = createRuntimeId("tenant", "forensic-store");
const otherTenantId = createRuntimeId("tenant", "forensic-store-other");
const principalId = createRuntimeId("principal", "forensic-store");
const sessionId = createRuntimeId("session", "forensic-store");
const D = canonicalDigest("forensic-fixture");

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MemoryKeyProvider implements ArtifactKeyProvider {
	public available = true;
	readonly #key = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);

	public async status(): Promise<ArtifactKeyProviderStatus> {
		return this.available
			? { state: "available", activeVersion: "memory-v1", availableVersions: ["memory-v1"], backend: "os_keyring" }
			: { state: "unavailable", availableVersions: [], backend: "unavailable" };
	}

	public async withKey<T>(
		_request: ArtifactKeyRequest,
		operation: (descriptor: Readonly<ArtifactKeyDescriptor>) => Promise<T> | T,
	): Promise<ArtifactResult<T>> {
		if (!this.available) {
			return { ok: false, error: { code: "key_unavailable", message: "memory key unavailable", retryable: true } };
		}
		const key = Uint8Array.from(this.#key);
		try {
			return { ok: true, value: await operation({ version: "memory-v1", backend: "os_keyring", key }) };
		} catch {
			return { ok: false, error: { code: "key_unavailable", message: "memory key operation failed", retryable: false } };
		} finally {
			key.fill(0);
		}
	}
}

class MemoryAcl implements ForensicAccessControlPort {
	public readonly denied = new Set<ForensicAccessOperation>();

	public async authorize(request: ForensicAccessRequest) {
		const decidedAt = request.requestedAt;
		const expiresAt = new Date(Date.parse(request.requestedAt) + 60 * 60 * 1_000).toISOString();
		return createForensicAccessDecision(request, {
			allowed: !this.denied.has(request.operation),
			receiptId: createRuntimeId("receipt", `forensic-acl-${canonicalDigest(request).slice(0, 40)}`),
			policyDigest: canonicalDigest("forensic-acl-policy"),
			decidedAt,
			expiresAt,
		});
	}
}

function permit(validFrom: string, validUntil: string): ForensicTracePermit {
	const seed = canonicalDigest({ validFrom, validUntil }).slice(0, 40);
	const request: ForensicTraceRequestRef = {
		schemaVersion: TELEMETRY_SCHEMA_VERSION,
		authorityId,
		tenantId,
		principalId,
		sessionId,
		requestId: createRuntimeId("command", `forensic-${seed}`),
		approvalId: createRuntimeId("approval", `forensic-${seed}`),
		approvalReceiptId: createRuntimeId("receipt", `forensic-approval-${seed}`),
		effectivePolicyReceiptId: createRuntimeId("receipt", `forensic-policy-${seed}`),
		effectivePolicyDigest: D,
		organizationDecision: "allow",
		purposeDigest: D,
		encryptedArtifact: {
			authorityId,
			tenantId,
			artifactId: createRuntimeId("artifact", `forensic-${seed}`),
			storedDigest: D,
			kind: "log",
			originalSize: 1,
			storedSize: 1,
			mediaType: "application/octet-stream",
			redaction: "encrypted_forensic",
			transformReceipt: createRuntimeId("receipt", `forensic-transform-${seed}`),
		},
		keyLifecycleReceiptId: createRuntimeId("receipt", `forensic-key-${seed}`),
		auditReceiptId: createRuntimeId("receipt", `forensic-audit-${seed}`),
		requestedAt: validFrom,
		expiresAt: validUntil,
	};
	const evaluated = evaluateForensicTraceGate(request, new Date(validFrom));
	if (!evaluated.ok) throw new Error(evaluated.error.message);
	return evaluated.value;
}

async function allFileText(root: string): Promise<string> {
	let output = "";
	async function visit(path: string): Promise<void> {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			for (const entry of entries) {
				const target = join(path, entry.name);
				if (entry.isDirectory()) await visit(target);
				else output += await readFile(target, "utf8");
			}
		} catch {
			return;
		}
	}
	await visit(root);
	return output;
}

describe("EncryptedForensicStore", () => {
	it("keeps raw content encrypted in an independent tenant root and audits ACL-bound access", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-forensic-store-"));
		roots.push(root);
		const telemetryRoot = join(root, "telemetry-spool");
		const forensicRoot = join(root, "forensic-root");
		await mkdir(telemetryRoot, { recursive: true });
		await writeFile(join(telemetryRoot, "metadata.json"), JSON.stringify({ event: "turn.finished", status: "ok" }));
		const keys = new MemoryKeyProvider();
		const acl = new MemoryAcl();
		const store = new EncryptedForensicStore({
			rootDir: forensicRoot,
			storeId: "forensic-main",
			keyProvider: keys,
			accessControl: acl,
			clock: () => new Date("2026-07-22T00:05:00.000Z"),
		});
		const secret = "raw prompt and tool output: super-secret-token";
		const written = await store.write({
			permit: permit("2026-07-22T00:00:00.000Z", "2026-07-22T00:10:00.000Z"),
			content: Buffer.from(secret),
			contentType: "text/plain",
			retentionUntil: "2026-07-22T01:05:00.000Z",
			purposeDigest: canonicalDigest("incident-investigation"),
		});
		expect(written).toMatchObject({ ok: true });
		if (!written.ok) return;

		const forensicText = await allFileText(forensicRoot);
		expect(forensicText).not.toContain(secret);
		expect(await allFileText(telemetryRoot)).not.toContain(secret);
		expect(forensicText).toContain(written.value.recordId);
		const tenantRecordRoot = join(forensicRoot, "forensic-v1", authorityId, tenantId, "records", written.value.recordId);
		expect((await readdir(tenantRecordRoot)).sort()).toEqual(["content.enc.json", "key.enc.json", "metadata.json"]);

		const read = await store.read({
			authorityId,
			tenantId,
			recordId: written.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("incident-investigation"),
		});
		expect(read.ok && Buffer.from(read.value).toString("utf8")).toBe(secret);
		if (read.ok) read.value.fill(0);

		expect(await store.read({
			authorityId,
			tenantId: otherTenantId,
			recordId: written.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("cross-tenant"),
		})).toMatchObject({ ok: false, error: { code: "forensic_not_found" } });
		acl.denied.add("read");
		expect(await store.read({
			authorityId,
			tenantId,
			recordId: written.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("denied-read"),
		})).toMatchObject({ ok: false, error: { code: "forensic_denied" } });
		const audit = await readFile(join(forensicRoot, "forensic-v1", authorityId, tenantId, "audit", "access.jsonl"), "utf8");
		expect(audit).toMatch(/"operation":"write".*"outcome":"allowed"/u);
		expect(audit).toMatch(/"operation":"read".*"outcome":"allowed"/u);
		expect(audit).toMatch(/"operation":"read".*"outcome":"denied"/u);
		expect(audit).not.toContain(secret);
	});

	it("stops capture on permit/key failure and enforces legal hold, retention, and crypto erase", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-forensic-lifecycle-"));
		roots.push(root);
		let now = new Date("2026-07-22T00:05:00.000Z");
		const keys = new MemoryKeyProvider();
		const acl = new MemoryAcl();
		const store = new EncryptedForensicStore({
			rootDir: root,
			storeId: "forensic-lifecycle",
			keyProvider: keys,
			accessControl: acl,
			clock: () => now,
			maxRetentionMs: 24 * 60 * 60 * 1_000,
		});
		const livePermit = permit("2026-07-22T00:00:00.000Z", "2026-07-22T00:10:00.000Z");
		const writeRecord = (suffix: string) => store.write({
			permit: livePermit,
			content: Buffer.from(`forensic-secret-${suffix}`),
			contentType: "text/plain",
			retentionUntil: "2026-07-22T00:06:00.000Z",
			purposeDigest: canonicalDigest(`purpose-${suffix}`),
		});
		const held = await writeRecord("held");
		const deletable = await writeRecord("deletable");
		if (!held.ok || !deletable.ok) throw new Error("forensic fixture write failed");
		expect(await store.setLegalHold({
			authorityId,
			tenantId,
			recordId: held.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("place-hold"),
			holdId: "legal-case-42",
			policyDigest: canonicalDigest("legal-hold-policy"),
			active: true,
		})).toMatchObject({ ok: true, value: { legalHold: { holdId: "legal-case-42" } } });

		now = new Date("2026-07-22T00:11:00.000Z");
		expect(await writeRecord("expired")).toMatchObject({ ok: false, error: { code: "forensic_denied" } });
		keys.available = false;
		now = new Date("2026-07-22T00:05:30.000Z");
		expect(await writeRecord("no-key")).toMatchObject({ ok: false, error: { code: "forensic_key_unavailable" } });
		keys.available = true;

		now = new Date("2026-07-22T00:07:00.000Z");
		const purged = await store.purgeExpired({
			authorityId,
			tenantId,
			principalId,
			purposeDigest: canonicalDigest("retention-sweep"),
		});
		expect(purged).toMatchObject({
			ok: true,
			value: { deleted: [deletable.value.recordId], held: [held.value.recordId], denied: [] },
		});
		expect(await store.cryptoErase({
			authorityId,
			tenantId,
			recordId: held.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("erase-held"),
		})).toMatchObject({ ok: false, error: { code: "forensic_retention_blocked" } });
		expect(await store.setLegalHold({
			authorityId,
			tenantId,
			recordId: held.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("release-hold"),
			holdId: "legal-case-42",
			policyDigest: canonicalDigest("legal-hold-policy"),
			active: false,
		})).toMatchObject({ ok: true, value: { legalHold: null } });
		expect(await store.cryptoErase({
			authorityId,
			tenantId,
			recordId: held.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("erase-released"),
		})).toMatchObject({ ok: true, value: { state: "erased" } });
		expect(await store.read({
			authorityId,
			tenantId,
			recordId: held.value.recordId,
			principalId,
			purposeDigest: canonicalDigest("read-erased"),
		})).toMatchObject({ ok: false, error: { code: "forensic_not_found" } });
	});
});
