import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	createProductionPeerAttestor,
	validateChannelBoundPrincipal,
	type PeerChannelEvidence,
} from "../../../src/runtime/host/peer-attestation.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function evidence(): PeerChannelEvidence {
	return {
		channelId: "channel-peer",
		principalId: createRuntimeId("principal", "peer"),
		scopeDigest: digest("a"),
		channelBindingDigest: digest("b"),
		hostGeneration: 2,
	};
}

describe("R3 channel-bound peer attestation", () => {
	it("rejects payload-principal forgery, scope replay, and binding mismatch", () => {
		const channel = evidence();
		expect(validateChannelBoundPrincipal(channel, channel.principalId, digest("a"), 2, digest("b"))).toEqual({ ok: true });
		expect(validateChannelBoundPrincipal(channel, createRuntimeId("principal", "forged"), digest("a"), 2, digest("b"))).toMatchObject({
			ok: false,
			code: "peer_principal_forgery",
		});
		expect(validateChannelBoundPrincipal(channel, channel.principalId, digest("c"), 2, digest("b"))).toMatchObject({
			ok: false,
			code: "peer_scope_mismatch",
		});
		expect(validateChannelBoundPrincipal(channel, channel.principalId, digest("a"), 3, digest("b"))).toMatchObject({
			ok: false,
			code: "host_generation_conflict",
		});
		expect(validateChannelBoundPrincipal(channel, channel.principalId, digest("a"), 2, digest("c"))).toMatchObject({
			ok: false,
			code: "channel_binding_mismatch",
		});
	});

	it("fails closed when the platform has no registered channel-bound adapter", () => {
		expect(createProductionPeerAttestor({ platform: "linux" })).toEqual({ ok: false, code: "adapter_unsupported" });
		expect(createProductionPeerAttestor({ platform: "win32" })).toEqual({ ok: false, code: "adapter_unsupported" });
	});
});
