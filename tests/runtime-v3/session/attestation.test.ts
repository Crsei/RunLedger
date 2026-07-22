import { describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createSessionHeadAttestation, type SessionHeadClaim } from "../../../src/runtime/session/attestation.ts";

function claim(): SessionHeadClaim {
	const sessionId = createRuntimeId("session", "fixture");
	const authorityId = createRuntimeId("authority", "local");
	const tenantId = createRuntimeId("tenant", "local");
	return {
		authorityId,
		tenantId,
		sessionId,
		cursor: {
			stream: createSessionEventStreamRef({ authorityId, tenantId }, sessionId),
			sequence: 0,
			eventId: createRuntimeId("event", "fixture"),
			eventHash: "a".repeat(64),
		},
		integrity: "valid",
		issuedAt: "2026-07-22T00:00:00.000Z",
	};
}

describe("session head attestation", () => {
	it("never presents a local hash chain as signed without a signer", async () => {
		const result = await createSessionHeadAttestation(claim());
		expect(result).toMatchObject({
			ok: true,
			value: { integrity: "valid", attestation: "unattested", anchorStatus: "not_requested" },
		});
		if (result.ok) expect(result.value.proof).toBeUndefined();
	});

	it("records signer and anchor receipts separately", async () => {
		const result = await createSessionHeadAttestation(claim(), {
			signer: {
				sign: async () => ({ ok: true, value: { signerId: "fixture-signer", keyVersion: "v1", signature: "signed" } }),
			},
			anchor: {
				anchor: async () => ({ ok: true, value: createRuntimeId("receipt", "anchor") }),
			},
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				attestation: "attested",
				proof: { signerId: "fixture-signer", keyVersion: "v1" },
				anchorReceiptId: createRuntimeId("receipt", "anchor"),
				anchorStatus: "anchored",
			},
		});
	});

	it("reports signer failure as unavailable without forging proof", async () => {
		const result = await createSessionHeadAttestation(claim(), {
			signer: {
				sign: async () => ({
					ok: false,
					error: { code: "durable_write_failed", message: "signer unavailable", retryable: true },
				}),
			},
		});
		expect(result).toMatchObject({ ok: true, value: { attestation: "unavailable" } });
		if (result.ok) expect(result.value.proof).toBeUndefined();
	});
});
