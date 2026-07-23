import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactQueueRecoveryValidator } from "../../../src/runtime/artifacts/queue-recovery.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { RestoredDurableQueueItem } from "../../../src/runtime/session/durable-queue.ts";
import { createArtifactHarness, valueOf } from "./helpers.ts";

function item(
	artifact: ArtifactRef,
): RestoredDurableQueueItem {
	const content = { storage: "artifact" as const, artifact };
	const authorityId = artifact.authorityId;
	const tenantId = artifact.tenantId;
	const sessionId = createRuntimeId("session", "queue-recovery");
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	return {
		reference: {
			queueItemId: createRuntimeId("queueItem", "queue-recovery"),
			sourceCommandId: createRuntimeId("command", "queue-recovery-source"),
			kind: "follow_up",
			enqueueRevision: {
				stream,
				sequence: 0,
				eventHash: "a".repeat(64),
			},
			targetTurnRevision: null,
			nextTurnPolicy: "after_active_run",
			contentDigest: canonicalDigest(content),
			status: "pending",
		},
		content,
		message: null,
		enqueuedSequence: 1,
		enqueuedCursor: {
			stream,
			sequence: 1,
			eventId: createRuntimeId("event", "queue-recovery"),
			eventHash: "b".repeat(64),
		},
	};
}

describe("Artifact-backed queue recovery", () => {
	it("accepts an exact committed metadata/blob pair without returning content", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("queue-ready")));
			if (!written.reference) throw new Error("fixture Artifact did not commit");
			const result = await new ArtifactQueueRecoveryValidator({
				cas: harness.cas,
				metadata: harness.metadata,
			}).validate([item(written.reference)]);
			expect(result).toEqual({ state: "ready", checked: 1 });
		} finally {
			await harness.cleanup();
		}
	});

	it("requires reconciliation when committed metadata or the blob is missing", async () => {
		const harness = await createArtifactHarness();
		try {
			const metadataMissing = valueOf(await harness.repository.write(harness.request("queue-metadata-missing")));
			if (!metadataMissing.reference) throw new Error("fixture Artifact did not commit");
			valueOf(await harness.metadata.removeCommitted(
				metadataMissing.metadata.authorityId,
				metadataMissing.metadata.tenantId,
				metadataMissing.metadata.artifactId,
			));
			const validator = new ArtifactQueueRecoveryValidator({
				cas: harness.cas,
				metadata: harness.metadata,
			});
			expect(await validator.validate([item(metadataMissing.reference)])).toMatchObject({
				state: "reconciliation_required",
				issues: [{ reason: "metadata_unavailable" }],
			});

			const blobMissing = valueOf(await harness.repository.write(harness.request("queue-blob-missing")));
			if (!blobMissing.reference) throw new Error("fixture Artifact did not commit");
			valueOf(await harness.cas.remove(blobMissing.reference.storedDigest));
			expect(await validator.validate([item(blobMissing.reference)])).toMatchObject({
				state: "reconciliation_required",
				issues: [{ reason: "blob_unavailable" }],
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("marks a mismatched reference or tampered blob corrupted", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("queue-corrupted")));
			if (!written.reference) throw new Error("fixture Artifact did not commit");
			const validator = new ArtifactQueueRecoveryValidator({
				cas: harness.cas,
				metadata: harness.metadata,
			});
			expect(await validator.validate([
				item({ ...written.reference, mediaType: "application/json" }),
			])).toMatchObject({
				state: "corrupted",
				issues: [{ reason: "reference_mismatch" }],
			});

			const digest = written.reference.storedDigest;
			await writeFile(
				join(harness.rootDir, "blobs", "sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}.blob`),
				"tampered",
			);
			expect(await validator.validate([item(written.reference)])).toMatchObject({
				state: "corrupted",
				issues: [{ reason: "blob_digest_mismatch" }],
			});
		} finally {
			await harness.cleanup();
		}
	});
});
