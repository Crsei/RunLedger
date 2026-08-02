/** Channel-bound local peer attestation contract; no payload-supplied identity is trusted. */

import type { RuntimeDigest } from "../protocol/foundation.ts";
import type { PrincipalId } from "../protocol/ids.ts";

export interface PeerChannelEvidence {
	readonly channelId: string;
	readonly principalId: PrincipalId;
	readonly scopeDigest: RuntimeDigest;
	readonly channelBindingDigest: RuntimeDigest;
	readonly hostGeneration: number;
}

export type PeerValidationResult =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly code:
				| "peer_principal_forgery"
				| "peer_scope_mismatch"
				| "host_generation_conflict"
				| "channel_binding_mismatch";
		};

export function validateChannelBoundPrincipal(
	channel: PeerChannelEvidence,
	claimedPrincipalId: PrincipalId,
	expectedScopeDigest: RuntimeDigest,
	expectedHostGeneration: number,
	expectedChannelBindingDigest: RuntimeDigest,
): PeerValidationResult {
	if (channel.principalId !== claimedPrincipalId) return { ok: false, code: "peer_principal_forgery" };
	if (channel.scopeDigest.digest !== expectedScopeDigest.digest) return { ok: false, code: "peer_scope_mismatch" };
	if (channel.hostGeneration !== expectedHostGeneration) return { ok: false, code: "host_generation_conflict" };
	if (channel.channelBindingDigest.digest !== expectedChannelBindingDigest.digest) {
		return { ok: false, code: "channel_binding_mismatch" };
	}
	return { ok: true };
}

export interface RegisteredPeerAttestor {
	readonly kind: "linux-so-peercred" | "windows-named-pipe";
	readonly generation: number;
}

export type ProductionPeerAttestorResult =
	| { readonly ok: true; readonly adapter: RegisteredPeerAttestor }
	| { readonly ok: false; readonly code: "adapter_unsupported" };

export function createProductionPeerAttestor(input: {
	platform: NodeJS.Platform;
	adapter?: RegisteredPeerAttestor;
}): ProductionPeerAttestorResult {
	const expectedKind = input.platform === "linux" ? "linux-so-peercred" : input.platform === "win32" ? "windows-named-pipe" : undefined;
	if (!expectedKind || !input.adapter || input.adapter.kind !== expectedKind) {
		return { ok: false, code: "adapter_unsupported" };
	}
	return { ok: true, adapter: input.adapter };
}
