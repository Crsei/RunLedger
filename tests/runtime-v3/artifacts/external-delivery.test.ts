import { describe, expect, it } from "vitest";
import { ArtifactReadLeaseRegistry } from "../../../src/runtime/artifacts/access.ts";
import {
	artifactDeliveryAllowsLocalCleanup,
	artifactDeliveryMayEnterEpisodeEvidence,
	createArtifactExternalDeliveryReceipt,
	reduceArtifactExternalDelivery,
} from "../../../src/runtime/artifacts/external-delivery.ts";
import { createEpisodeManifest } from "../../../src/runtime/artifacts/episode-manifest.ts";
import { ArtifactRetentionService } from "../../../src/runtime/artifacts/retention.ts";
import type {
	ArtifactExternalDeliveryProjection,
	ArtifactExternalDeliveryReceipt,
} from "../../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import type { ArtifactRef } from "../../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createArtifactHarness, NOW, valueOf } from "./helpers.ts";

const LATER = "2026-07-22T00:00:01.000Z";

function accepted(artifact: ArtifactRef): ArtifactExternalDeliveryReceipt {
	return valueOf(createArtifactExternalDeliveryReceipt({
		authorityId: artifact.authorityId,
		tenantId: artifact.tenantId,
		deliveryId: createRuntimeId("command", "artifact-export"),
		receiptId: createRuntimeId("receipt", "artifact-export-accepted"),
		artifact,
		destinationId: createRuntimeId("resource", "artifact-export-target"),
		destinationDigest: canonicalDigest("destination"),
		state: "accepted_enqueued",
		revision: 0,
		recordedAt: NOW,
	}));
}

function next(
	projection: ArtifactExternalDeliveryProjection,
	state: "durable" | "content_verified" | "externally_acknowledged" | "failed",
): ArtifactExternalDeliveryReceipt {
	const common = {
		authorityId: projection.authorityId,
		tenantId: projection.tenantId,
		deliveryId: projection.deliveryId,
		artifact: projection.artifact,
		destinationId: projection.destinationId,
		destinationDigest: projection.destinationDigest,
		revision: projection.revision + 1,
		previousState: projection.state,
		previousReceiptDigest: projection.lastReceiptDigest,
		recordedAt: LATER,
	};
	if (state === "durable") {
		if (projection.state !== "accepted_enqueued") throw new Error("invalid durable fixture state");
		return valueOf(createArtifactExternalDeliveryReceipt({
			...common,
			receiptId: createRuntimeId("receipt", "artifact-export-durable"),
			state,
			previousState: projection.state,
			storageReceiptDigest: canonicalDigest("remote durable receipt"),
			remoteObjectDigest: canonicalDigest("remote object"),
		}));
	}
	if (state === "content_verified") {
		if (projection.state !== "durable") throw new Error("invalid verification fixture state");
		return valueOf(createArtifactExternalDeliveryReceipt({
			...common,
			receiptId: createRuntimeId("receipt", "artifact-export-verified"),
			state,
			previousState: projection.state,
			verifiedContentDigest: projection.artifact.storedDigest,
			verificationReceiptDigest: canonicalDigest("remote verification receipt"),
		}));
	}
	if (state === "externally_acknowledged") {
		if (projection.state !== "content_verified") throw new Error("invalid acknowledgement fixture state");
		return valueOf(createArtifactExternalDeliveryReceipt({
			...common,
			receiptId: createRuntimeId("receipt", "artifact-export-acknowledged"),
			state,
			previousState: projection.state,
			externalAcknowledgementDigest: canonicalDigest("external acknowledgement"),
		}));
	}
	if (projection.state === "externally_acknowledged" || projection.state === "failed") {
		throw new Error("invalid failure fixture state");
	}
	return valueOf(createArtifactExternalDeliveryReceipt({
		...common,
		receiptId: createRuntimeId("receipt", "artifact-export-failed"),
		state,
		previousState: projection.state,
		failureCode: "external_write_failed",
		failureDigest: canonicalDigest("external write failed"),
	}));
}

function advance(
	projection: ArtifactExternalDeliveryProjection | undefined,
	receipt: ArtifactExternalDeliveryReceipt,
): ArtifactExternalDeliveryProjection {
	return valueOf(reduceArtifactExternalDelivery(projection, receipt));
}

describe("external Artifact delivery lifecycle", () => {
	it("separates accepted, durable, verified, and externally acknowledged states", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("delivery-state")));
			if (!written.reference) throw new Error("fixture Artifact did not commit");
			let projection = advance(undefined, accepted(written.reference));
			expect(projection.state).toBe("accepted_enqueued");
			expect(artifactDeliveryMayEnterEpisodeEvidence(projection)).toBe(false);
			expect(artifactDeliveryAllowsLocalCleanup(projection)).toBe(false);

			const skipped = createArtifactExternalDeliveryReceipt({
				authorityId: projection.authorityId,
				tenantId: projection.tenantId,
				deliveryId: projection.deliveryId,
				receiptId: createRuntimeId("receipt", "artifact-export-skipped"),
				artifact: projection.artifact,
				destinationId: projection.destinationId,
				destinationDigest: projection.destinationDigest,
				state: "content_verified",
				revision: 1,
				previousState: "durable",
				previousReceiptDigest: projection.lastReceiptDigest,
				verifiedContentDigest: projection.artifact.storedDigest,
				verificationReceiptDigest: canonicalDigest("invalid skip"),
				recordedAt: LATER,
			});
			expect(skipped.ok).toBe(true);
			if (skipped.ok) expect(reduceArtifactExternalDelivery(projection, skipped.value)).toMatchObject({ ok: false });

			projection = advance(projection, next(projection, "durable"));
			projection = advance(projection, next(projection, "content_verified"));
			projection = advance(projection, next(projection, "externally_acknowledged"));
			expect(artifactDeliveryMayEnterEpisodeEvidence(projection)).toBe(true);
			expect(artifactDeliveryAllowsLocalCleanup(projection)).toBe(true);
			expect(reduceArtifactExternalDelivery(projection, next({
				...projection,
				state: "content_verified",
				externallyAcknowledgedAt: undefined,
				externalAcknowledgementDigest: undefined,
			}, "externally_acknowledged"))).toMatchObject({ ok: false });
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps enqueued or failed exports out of Episode evidence", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write(harness.request("delivery-episode")));
			if (!written.reference || !written.reference.workspaceId) throw new Error("fixture Artifact did not commit");
			const enqueued = advance(undefined, accepted(written.reference));
			const eventStream = createSessionEventStreamRef(
				{ authorityId: written.reference.authorityId, tenantId: written.reference.tenantId },
				written.metadata.source.sessionId,
			);
			const base = {
				authorityId: written.reference.authorityId,
				tenantId: written.reference.tenantId,
				sessionId: written.metadata.source.sessionId,
				principalId: written.metadata.source.producerId,
				evidenceHead: {
					stream: eventStream,
					sequence: 4,
					eventId: createRuntimeId("event", "delivery-episode"),
					eventHash: canonicalDigest("delivery episode head"),
				},
				integrity: "valid" as const,
				attestation: "unattested" as const,
				workspace: {
					workspaceId: written.reference.workspaceId,
					repositoryId: createRuntimeId("repository", "delivery-episode"),
					baseCommit: "base",
				},
				artifacts: [written.reference],
				permissionReceiptIds: [],
				approvalIds: [],
				cost: { status: "unavailable" as const },
				verification: { status: "not_run" as const, verificationIds: [] },
				artifactKeyState: "available" as const,
				legacyUnverifiedCount: 0,
				createdAt: NOW,
			};
			expect(createEpisodeManifest({ ...base, externalDeliveries: [enqueued] })).toMatchObject({
				ok: false,
				error: { code: "invalid_request" },
			});
			const failed = advance(enqueued, next(enqueued, "failed"));
			expect(createEpisodeManifest({ ...base, externalDeliveries: [failed] })).toMatchObject({ ok: false });
			let acknowledged = advance(enqueued, next(enqueued, "durable"));
			acknowledged = advance(acknowledged, next(acknowledged, "content_verified"));
			acknowledged = advance(acknowledged, next(acknowledged, "externally_acknowledged"));
			expect(createEpisodeManifest({ ...base, externalDeliveries: [acknowledged] })).toMatchObject({ ok: true });
		} finally {
			await harness.cleanup();
		}
	});

	it("blocks local GC until external content is verified and acknowledged", async () => {
		const harness = await createArtifactHarness();
		try {
			const written = valueOf(await harness.repository.write({
				...harness.request("delivery-retention"),
				retention: { expiresAt: "2026-07-21T00:00:00.000Z" },
			}));
			if (!written.reference) throw new Error("fixture Artifact did not commit");
			const retention = new ArtifactRetentionService({
				cas: harness.cas,
				metadata: harness.metadata,
				readLeases: new ArtifactReadLeaseRegistry(),
			});
			let delivery = advance(undefined, accepted(written.reference));
			const pending = valueOf(await retention.collect(written.metadata.authorityId, written.metadata.tenantId, {
				now: new Date(NOW),
				dryRun: true,
				externalDeliveries: [delivery],
			}));
			expect(pending.candidates).toEqual([
				expect.objectContaining({ action: "retain", reason: "external_delivery_pending" }),
			]);
			delivery = advance(delivery, next(delivery, "durable"));
			delivery = advance(delivery, next(delivery, "content_verified"));
			delivery = advance(delivery, next(delivery, "externally_acknowledged"));
			const acknowledged = valueOf(await retention.collect(written.metadata.authorityId, written.metadata.tenantId, {
				now: new Date(NOW),
				dryRun: true,
				externalDeliveries: [delivery],
			}));
			expect(acknowledged.candidates).toEqual([
				expect.objectContaining({ action: "delete", reason: "expired_unreferenced" }),
			]);
		} finally {
			await harness.cleanup();
		}
	});
});
