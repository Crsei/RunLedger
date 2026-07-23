import { describe, expect, it } from "vitest";
import { ArtifactReadLeaseRegistry } from "../../../src/runtime/artifacts/access.ts";
import { ArtifactRetentionService } from "../../../src/runtime/artifacts/retention.ts";
import { createArtifactHarness, DIGEST, valueOf } from "./helpers.ts";

describe("artifact retention", () => {
	it("supports dry-run GC and preserves pin, reference, legal hold, and active-read evidence", async () => {
		const harness = await createArtifactHarness();
		try {
			const expiredAt = "2026-07-21T00:00:00.000Z";
			const eligible = valueOf(await harness.repository.write({
				...harness.request("eligible"),
				retention: { expiresAt: expiredAt },
			}));
			const pinned = valueOf(await harness.repository.write({
				...harness.request("pinned"),
				retention: { expiresAt: expiredAt, pins: ["verification-v1"] },
			}));
			const referenced = valueOf(await harness.repository.write({
				...harness.request("referenced"),
				retention: { expiresAt: expiredAt, referenceCount: 1 },
			}));
			const held = valueOf(await harness.repository.write({
				...harness.request("held"),
				retention: { expiresAt: expiredAt, legalHold: { status: "active", reasonDigest: DIGEST } },
			}));
			const active = valueOf(await harness.repository.write({
				...harness.request("active"),
				content: "different active content",
				retention: { expiresAt: expiredAt },
			}));
			const leases = new ArtifactReadLeaseRegistry();
			const releaseActive = leases.acquire(active.metadata.storedDigest);
			const retention = new ArtifactRetentionService({ cas: harness.cas, metadata: harness.metadata, readLeases: leases });

			const dryRun = valueOf(await retention.collect(eligible.metadata.authorityId, eligible.metadata.tenantId, {
				now: new Date("2026-07-22T00:00:00.000Z"),
				dryRun: true,
			}));
			expect(dryRun.deletedArtifactIds).toEqual([]);
			expect(dryRun.candidates).toEqual(expect.arrayContaining([
				expect.objectContaining({ artifactId: eligible.metadata.artifactId, action: "delete" }),
				expect.objectContaining({ artifactId: pinned.metadata.artifactId, reason: "pinned" }),
				expect.objectContaining({ artifactId: referenced.metadata.artifactId, reason: "referenced" }),
				expect.objectContaining({ artifactId: held.metadata.artifactId, reason: "legal_hold" }),
				expect.objectContaining({ artifactId: active.metadata.artifactId, reason: "active_read" }),
			]));

			const collected = valueOf(await retention.collect(eligible.metadata.authorityId, eligible.metadata.tenantId, {
				now: new Date("2026-07-22T00:00:00.000Z"),
				dryRun: false,
			}));
			expect(collected.deletedArtifactIds).toEqual([eligible.metadata.artifactId]);
			expect(collected.deletedDigests).toEqual([]);
			expect(valueOf(await harness.cas.read(pinned.metadata.storedDigest))).toBeInstanceOf(Uint8Array);
			releaseActive?.();
		} finally {
			await harness.cleanup();
		}
	});

	it("deletes the blob only after its final expired unreferenced metadata is removed", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write({
				...harness.request("delete-final"),
				retention: { expiresAt: "2026-07-21T00:00:00.000Z" },
			}));
			const retention = new ArtifactRetentionService({
				cas: harness.cas,
				metadata: harness.metadata,
				readLeases: new ArtifactReadLeaseRegistry(),
			});
			const report = valueOf(await retention.collect(written.metadata.authorityId, written.metadata.tenantId, {
				now: new Date("2026-07-22T00:00:00.000Z"),
				dryRun: false,
			}));
			expect(report.deletedArtifactIds).toEqual([written.metadata.artifactId]);
			expect(report.deletedDigests).toEqual([written.metadata.storedDigest]);
			expect(await harness.cas.read(written.metadata.storedDigest)).toMatchObject({ ok: false, error: { code: "not_found" } });
		} finally {
			await harness.cleanup();
		}
	});

	it("updates pin, reference count, and legal hold without changing stored evidence", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("retention-update")));
			const retention = new ArtifactRetentionService({
				cas: harness.cas,
				metadata: harness.metadata,
				readLeases: new ArtifactReadLeaseRegistry(),
			});
			const pinned = valueOf(await retention.pin(written.metadata.authorityId, written.metadata.tenantId, written.metadata.artifactId, "case-1"));
			expect(pinned.pins).toEqual(["case-1"]);
			const referenced = valueOf(await retention.addReference(pinned.authorityId, pinned.tenantId, pinned.artifactId));
			expect(referenced.referenceCount).toBe(1);
			const released = valueOf(await retention.releaseReference(referenced.authorityId, referenced.tenantId, referenced.artifactId));
			expect(released.referenceCount).toBe(0);
			const held = valueOf(await retention.setLegalHold(released.authorityId, released.tenantId, released.artifactId, {
				status: "active",
				reasonDigest: DIGEST,
			}));
			expect(held.legalHold.status).toBe("active");
			const unpinned = valueOf(await retention.unpin(held.authorityId, held.tenantId, held.artifactId, "case-1"));
			expect(unpinned.pins).toEqual([]);
			expect(unpinned.storedDigest).toBe(written.metadata.storedDigest);
		} finally {
			await harness.cleanup();
		}
	});
});
