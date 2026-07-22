/** 外部 Artifact upload/export 的严格、可重放状态机。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ArtifactRefSchema } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION,
	type ArtifactError,
	type ArtifactExternalDeliveryProjection,
	type ArtifactExternalDeliveryReceipt,
	type ArtifactExternalDeliveryState,
	type ArtifactResult,
} from "./types.ts";

const digestPattern = "^[a-f0-9]{64}$";
const timestampPattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$";
const digest = Type.String({ pattern: digestPattern, minLength: 64, maxLength: 64 });
const timestamp = Type.String({ pattern: timestampPattern, maxLength: 24 });
const runtimeId = (kind: string) =>
	Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const commonReceipt = {
	schemaVersion: Type.Literal(ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	deliveryId: runtimeId("command"),
	receiptId: runtimeId("receipt"),
	artifact: ArtifactRefSchema,
	destinationId: runtimeId("resource"),
	destinationDigest: digest,
	recordedAt: timestamp,
	receiptDigest: digest,
} as const;

export const ArtifactExternalDeliveryReceiptSchema = Type.Unsafe<ArtifactExternalDeliveryReceipt>(
	Type.Union([
		exact({
			...commonReceipt,
			state: Type.Literal("accepted_enqueued"),
			revision: Type.Literal(0),
		}),
		exact({
			...commonReceipt,
			state: Type.Literal("durable"),
			revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			previousState: Type.Literal("accepted_enqueued"),
			previousReceiptDigest: digest,
			storageReceiptDigest: digest,
			remoteObjectDigest: digest,
		}),
		exact({
			...commonReceipt,
			state: Type.Literal("content_verified"),
			revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			previousState: Type.Literal("durable"),
			previousReceiptDigest: digest,
			verifiedContentDigest: digest,
			verificationReceiptDigest: digest,
		}),
		exact({
			...commonReceipt,
			state: Type.Literal("externally_acknowledged"),
			revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			previousState: Type.Literal("content_verified"),
			previousReceiptDigest: digest,
			externalAcknowledgementDigest: digest,
		}),
		exact({
			...commonReceipt,
			state: Type.Literal("failed"),
			revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
			previousState: Type.Union([
				Type.Literal("accepted_enqueued"),
				Type.Literal("durable"),
				Type.Literal("content_verified"),
			]),
			previousReceiptDigest: digest,
			failureCode: Type.String({ minLength: 1, maxLength: 128 }),
			failureDigest: digest,
		}),
	]),
);

export const ArtifactExternalDeliveryProjectionSchema = Type.Unsafe<ArtifactExternalDeliveryProjection>(
	exact({
		schemaVersion: Type.Literal(ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION),
		authorityId: runtimeId("authority"),
		tenantId: runtimeId("tenant"),
		deliveryId: runtimeId("command"),
		artifact: ArtifactRefSchema,
		destinationId: runtimeId("resource"),
		destinationDigest: digest,
		state: Type.Union([
			Type.Literal("accepted_enqueued"),
			Type.Literal("durable"),
			Type.Literal("content_verified"),
			Type.Literal("externally_acknowledged"),
			Type.Literal("failed"),
		]),
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		lastReceiptDigest: digest,
		acceptedAt: timestamp,
		durableAt: Type.Optional(timestamp),
		contentVerifiedAt: Type.Optional(timestamp),
		externallyAcknowledgedAt: Type.Optional(timestamp),
		failedAt: Type.Optional(timestamp),
		remoteObjectDigest: Type.Optional(digest),
		verifiedContentDigest: Type.Optional(digest),
		externalAcknowledgementDigest: Type.Optional(digest),
		failureDigest: Type.Optional(digest),
		projectionDigest: digest,
	}),
);

type ReceiptInput<TReceipt extends ArtifactExternalDeliveryReceipt = ArtifactExternalDeliveryReceipt> =
	TReceipt extends ArtifactExternalDeliveryReceipt
		? Omit<TReceipt, "schemaVersion" | "receiptDigest">
		: never;

export type ArtifactExternalDeliveryReceiptInput = ReceiptInput;

function failure(
	code: ArtifactError["code"],
	message: string,
	retryable = false,
): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function withoutReceiptDigest(
	receipt: ArtifactExternalDeliveryReceipt,
): Omit<ArtifactExternalDeliveryReceipt, "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return body;
}

function withoutProjectionDigest(
	projection: ArtifactExternalDeliveryProjection,
): Omit<ArtifactExternalDeliveryProjection, "projectionDigest"> {
	const { projectionDigest: _projectionDigest, ...body } = projection;
	return body;
}

function scopeAndArtifactMatch(receipt: ArtifactExternalDeliveryReceipt): boolean {
	return (
		receipt.artifact.authorityId === receipt.authorityId &&
		receipt.artifact.tenantId === receipt.tenantId
	);
}

export function isArtifactExternalDeliveryReceipt(
	value: unknown,
): value is ArtifactExternalDeliveryReceipt {
	if (!Check(ArtifactExternalDeliveryReceiptSchema, value)) return false;
	const receipt = value as ArtifactExternalDeliveryReceipt;
	return (
		scopeAndArtifactMatch(receipt) &&
		receipt.receiptDigest === canonicalDigest(withoutReceiptDigest(receipt)) &&
		(receipt.state !== "content_verified" ||
			receipt.verifiedContentDigest === receipt.artifact.storedDigest)
	);
}

export function createArtifactExternalDeliveryReceipt(
	input: ArtifactExternalDeliveryReceiptInput,
): ArtifactResult<ArtifactExternalDeliveryReceipt> {
	const body = {
		...input,
		schemaVersion: ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION,
	} as Omit<ArtifactExternalDeliveryReceipt, "receiptDigest">;
	const receipt = {
		...body,
		receiptDigest: canonicalDigest(body),
	} as ArtifactExternalDeliveryReceipt;
	return isArtifactExternalDeliveryReceipt(receipt)
		? { ok: true, value: receipt }
		: failure("invalid_request", "external Artifact delivery receipt is invalid");
}

function sameDelivery(
	projection: ArtifactExternalDeliveryProjection,
	receipt: ArtifactExternalDeliveryReceipt,
): boolean {
	return (
		projection.authorityId === receipt.authorityId &&
		projection.tenantId === receipt.tenantId &&
		projection.deliveryId === receipt.deliveryId &&
		projection.destinationId === receipt.destinationId &&
		projection.destinationDigest === receipt.destinationDigest &&
		canonicalDigest(projection.artifact) === canonicalDigest(receipt.artifact)
	);
}

function stateFieldsAreValid(projection: ArtifactExternalDeliveryProjection): boolean {
	const durable = projection.durableAt !== undefined && projection.remoteObjectDigest !== undefined;
	const verified = projection.contentVerifiedAt !== undefined &&
		projection.verifiedContentDigest === projection.artifact.storedDigest;
	const acknowledged = projection.externallyAcknowledgedAt !== undefined &&
		projection.externalAcknowledgementDigest !== undefined;
	const failed = projection.failedAt !== undefined && projection.failureDigest !== undefined;
	switch (projection.state) {
		case "accepted_enqueued":
			return projection.revision === 0 && !durable && !verified && !acknowledged && !failed;
		case "durable":
			return projection.revision >= 1 && durable && !verified && !acknowledged && !failed;
		case "content_verified":
			return projection.revision >= 2 && durable && verified && !acknowledged && !failed;
		case "externally_acknowledged":
			return projection.revision >= 3 && durable && verified && acknowledged && !failed;
		case "failed":
			return projection.revision >= 1 && failed && !acknowledged;
	}
}

export function isArtifactExternalDeliveryProjection(
	value: unknown,
): value is ArtifactExternalDeliveryProjection {
	if (!Check(ArtifactExternalDeliveryProjectionSchema, value)) return false;
	const projection = value as ArtifactExternalDeliveryProjection;
	return (
		projection.artifact.authorityId === projection.authorityId &&
		projection.artifact.tenantId === projection.tenantId &&
		stateFieldsAreValid(projection) &&
		projection.projectionDigest === canonicalDigest(withoutProjectionDigest(projection))
	);
}

function finalizeProjection(
	body: Omit<ArtifactExternalDeliveryProjection, "projectionDigest">,
): ArtifactResult<ArtifactExternalDeliveryProjection> {
	const projection: ArtifactExternalDeliveryProjection = {
		...body,
		projectionDigest: canonicalDigest(body),
	};
	return isArtifactExternalDeliveryProjection(projection)
		? { ok: true, value: projection }
		: failure("corrupted_metadata", "external Artifact delivery projection is invalid");
}

export function reduceArtifactExternalDelivery(
	current: ArtifactExternalDeliveryProjection | undefined,
	receipt: ArtifactExternalDeliveryReceipt,
): ArtifactResult<ArtifactExternalDeliveryProjection> {
	if (!isArtifactExternalDeliveryReceipt(receipt)) {
		return failure("invalid_request", "external Artifact delivery receipt failed validation");
	}
	if (current === undefined) {
		if (receipt.state !== "accepted_enqueued") {
			return failure("invalid_request", "external Artifact delivery must begin at accepted/enqueued");
		}
		return finalizeProjection({
			schemaVersion: ARTIFACT_EXTERNAL_DELIVERY_SCHEMA_VERSION,
			authorityId: receipt.authorityId,
			tenantId: receipt.tenantId,
			deliveryId: receipt.deliveryId,
			artifact: receipt.artifact,
			destinationId: receipt.destinationId,
			destinationDigest: receipt.destinationDigest,
			state: receipt.state,
			revision: receipt.revision,
			lastReceiptDigest: receipt.receiptDigest,
			acceptedAt: receipt.recordedAt,
		});
	}
	if (!isArtifactExternalDeliveryProjection(current) || !sameDelivery(current, receipt)) {
		return failure("corrupted_metadata", "external Artifact delivery identity changed");
	}
	if (current.lastReceiptDigest === receipt.receiptDigest) {
		return { ok: true, value: current };
	}
	if (current.state === "externally_acknowledged" || current.state === "failed") {
		return failure("invalid_request", "external Artifact delivery terminal state cannot transition");
	}
	if (
		receipt.state === "accepted_enqueued" ||
		receipt.revision !== current.revision + 1 ||
		receipt.previousState !== current.state ||
		receipt.previousReceiptDigest !== current.lastReceiptDigest
	) return failure("invalid_request", "external Artifact delivery transition is not contiguous");

	const common = {
		...withoutProjectionDigest(current),
		state: receipt.state,
		revision: receipt.revision,
		lastReceiptDigest: receipt.receiptDigest,
	};
	if (receipt.state === "durable") {
		return finalizeProjection({
			...common,
			durableAt: receipt.recordedAt,
			remoteObjectDigest: receipt.remoteObjectDigest,
		});
	}
	if (receipt.state === "content_verified") {
		return finalizeProjection({
			...common,
			contentVerifiedAt: receipt.recordedAt,
			verifiedContentDigest: receipt.verifiedContentDigest,
		});
	}
	if (receipt.state === "externally_acknowledged") {
		return finalizeProjection({
			...common,
			externallyAcknowledgedAt: receipt.recordedAt,
			externalAcknowledgementDigest: receipt.externalAcknowledgementDigest,
		});
	}
	return finalizeProjection({
		...common,
		failedAt: receipt.recordedAt,
		failureDigest: receipt.failureDigest,
	});
}

export function replayArtifactExternalDelivery(
	receipts: readonly ArtifactExternalDeliveryReceipt[],
): ArtifactResult<ArtifactExternalDeliveryProjection> {
	let projection: ArtifactExternalDeliveryProjection | undefined;
	for (const receipt of receipts) {
		const next = reduceArtifactExternalDelivery(projection, receipt);
		if (!next.ok) return next;
		projection = next.value;
	}
	return projection
		? { ok: true, value: projection }
		: failure("invalid_request", "external Artifact delivery history is empty");
}

export function artifactDeliveryIsTerminal(
	projection: ArtifactExternalDeliveryProjection,
): boolean {
	return projection.state === "externally_acknowledged" || projection.state === "failed";
}

export function artifactDeliveryIsFullyAcknowledged(
	projection: ArtifactExternalDeliveryProjection,
): boolean {
	return (
		isArtifactExternalDeliveryProjection(projection) &&
		projection.state === "externally_acknowledged" &&
		projection.verifiedContentDigest === projection.artifact.storedDigest
	);
}

export const artifactDeliveryMayEnterEpisodeEvidence = artifactDeliveryIsFullyAcknowledged;
export const artifactDeliveryAllowsLocalCleanup = artifactDeliveryIsFullyAcknowledged;
