/** Capability Gateway 的 local peer/socket 与 signed-remote 认证适配。 */

import { canonicalDigest } from "../../runtime/protocol/v3/canonical-json.ts";
import {
	isCapabilityGatewayRequest,
	type CapabilityAuthenticationPort,
	type CapabilityAuthChannel,
	type CapabilityEventCursorAuthorityPort,
	type CapabilityGatewayRequest,
} from "../../runtime/protocol/v3/capability.ts";
import type { EventCursor } from "../../runtime/protocol/v3/events.ts";
import { isEventCursor } from "../../runtime/protocol/v3/schemas.ts";
import { createRuntimeId, type ReceiptId, type ResourceId } from "../../runtime/protocol/v3/ids.ts";

export interface CapabilityPeerBinding {
	authorityId: CapabilityGatewayRequest["request"]["authorityId"];
	tenantId: CapabilityGatewayRequest["request"]["tenantId"];
	principalId: CapabilityGatewayRequest["request"]["principalId"];
	channel: Exclude<CapabilityAuthChannel, "signed_remote">;
	channelBindingDigest: string;
	keyRevision: number;
	issuedAt: string;
	expiresAt?: string;
	revokedAt?: string;
}

export interface SignedCapabilityVerificationRequest {
	signingKeyId: ResourceId;
	signatureDigest: string;
	requestDigest: string;
	channelBindingDigest: string;
	keyRevision: number;
	authorityId: CapabilityGatewayRequest["request"]["authorityId"];
	tenantId: CapabilityGatewayRequest["request"]["tenantId"];
	principalId: CapabilityGatewayRequest["request"]["principalId"];
}

export interface SignedCapabilityVerifierPort {
	verify(
		request: SignedCapabilityVerificationRequest,
		signal?: AbortSignal,
	): Promise<{ status: "authenticated"; verifierReceiptId: ReceiptId } | { status: "rejected" | "unavailable" }>;
}

export interface CapabilityAuthenticationAdapterOptions {
	peerBindings: readonly CapabilityPeerBinding[];
	eventCursorAuthority: CapabilityEventCursorAuthorityPort;
	signedVerifier?: SignedCapabilityVerifierPort;
	clock?: () => Date;
}

export class CapabilityAuthenticationAdapter implements CapabilityAuthenticationPort {
	readonly #peerBindings: readonly CapabilityPeerBinding[];
	readonly #eventCursorAuthority: CapabilityEventCursorAuthorityPort;
	readonly #signedVerifier?: SignedCapabilityVerifierPort;
	readonly #clock: () => Date;

	public constructor(options: CapabilityAuthenticationAdapterOptions) {
		this.#peerBindings = options.peerBindings;
		this.#eventCursorAuthority = options.eventCursorAuthority;
		this.#signedVerifier = options.signedVerifier;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async verify(
		request: CapabilityGatewayRequest,
		signal?: AbortSignal,
	): ReturnType<CapabilityAuthenticationPort["verify"]> {
		const requestId = request.request.requestId;
		const requestDigest = request.authentication.requestDigest;
		if (!isCapabilityGatewayRequest(request)) return { requestId, requestDigest, status: "rejected" };
		const now = this.#clock().getTime();
		if (
			Date.parse(request.authentication.issuedAt) > now ||
			Date.parse(request.authentication.expiresAt) <= now ||
			signal?.aborted
		) return { requestId, requestDigest, status: "rejected" };
		if (request.authentication.channel === "signed_remote") {
			if (!this.#signedVerifier) return { requestId, requestDigest, status: "unavailable" };
			try {
				const verified = await this.#signedVerifier.verify({
					signingKeyId: request.authentication.signingKeyId!,
					signatureDigest: request.authentication.signatureDigest!,
					requestDigest,
					channelBindingDigest: request.authentication.channelBindingDigest,
					keyRevision: request.authentication.keyRevision,
					authorityId: request.request.authorityId,
					tenantId: request.request.tenantId,
					principalId: request.request.principalId,
				}, signal);
				return verified.status === "authenticated"
					? { requestId, requestDigest, status: "authenticated", verifierReceiptId: verified.verifierReceiptId }
					: { requestId, requestDigest, status: verified.status };
			} catch {
				return { requestId, requestDigest, status: "unavailable" };
			}
		}
		let currentCursor: EventCursor | undefined;
		try {
			currentCursor = await this.#eventCursorAuthority.current({
				authorityId: request.request.authorityId,
				tenantId: request.request.tenantId,
				sessionId: request.request.sessionId,
			});
		} catch {
			return { requestId, requestDigest, status: "unavailable" };
		}
		const requestCursor = request.authentication.eventCursor;
		if (
			!currentCursor ||
			!isEventCursor(currentCursor) ||
			currentCursor.stream.scope !== requestCursor.stream.scope ||
			currentCursor.stream.streamId !== requestCursor.stream.streamId ||
			(currentCursor.stream.scope === "session" &&
				requestCursor.stream.scope === "session" &&
				currentCursor.stream.sessionId !== requestCursor.stream.sessionId) ||
			currentCursor.sequence !== requestCursor.sequence ||
			currentCursor.eventId !== requestCursor.eventId ||
			currentCursor.eventHash !== requestCursor.eventHash
		) return { requestId, requestDigest, status: "rejected" };
		const binding = this.#peerBindings.find((candidate) =>
			candidate.authorityId === request.request.authorityId &&
			candidate.tenantId === request.request.tenantId &&
			candidate.principalId === request.request.principalId &&
			candidate.channel === request.authentication.channel &&
			candidate.channelBindingDigest === request.authentication.channelBindingDigest &&
			candidate.keyRevision === request.authentication.keyRevision,
		);
		if (
			!binding || binding.revokedAt !== undefined || Date.parse(binding.issuedAt) > now ||
			(binding.expiresAt !== undefined && Date.parse(binding.expiresAt) <= now)
		) return { requestId, requestDigest, status: "rejected" };
		return {
			requestId,
			requestDigest,
			status: "authenticated",
			verifierReceiptId: createRuntimeId(
				"receipt",
				`capability-peer-${canonicalDigest({ binding, requestDigest, eventCursor: requestCursor }).slice(0, 48)}`,
			),
		};
	}
}
