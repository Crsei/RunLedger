import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { CredentialBrokerPort } from "../../../src/runtime/identity/enterprise-ports.ts";
import type {
	CredentialAudienceValidationReceiptRef,
	CredentialAudienceValidationRequest,
} from "../../../src/runtime/identity/enterprise-types.ts";
import {
	FailClosedRemoteExecutorGateway,
	transferSessionHandoff,
	type ExecutorPortResult,
	type RemoteAttestationVerifierPort,
	type RemoteExecutorPort,
	type SessionHandoffPort,
} from "../../../src/runtime/executors/ports.ts";
import type { RemoteAttestationVerificationReceipt, RemoteExecutorInvocation, RemoteExecutorResultReceipt } from "../../../src/runtime/executors/types.ts";
import { handoff, handoffReceipt, invocation, result, verification } from "./helpers.ts";

class FakeExecutor implements RemoteExecutorPort {
	public readonly kind = "ci" as const;
	public calls = 0;
	public response: (request: RemoteExecutorInvocation) => Promise<ExecutorPortResult<RemoteExecutorResultReceipt>>;
	public constructor(response: (request: RemoteExecutorInvocation) => Promise<ExecutorPortResult<RemoteExecutorResultReceipt>>) { this.response = response; }
	public execute(request: RemoteExecutorInvocation): Promise<ExecutorPortResult<RemoteExecutorResultReceipt>> { this.calls += 1; return this.response(request); }
}

class FakeAttestation implements RemoteAttestationVerifierPort {
	public calls = 0;
	public async verify(_attestation: RemoteExecutorResultReceipt["attestation"], request: RemoteExecutorInvocation): Promise<ExecutorPortResult<RemoteAttestationVerificationReceipt>> {
		this.calls += 1;
		const execution = result(request);
		return { ok: true, value: verification(request, execution) };
	}
}

class FakeCredentialAudience implements Pick<CredentialBrokerPort, "validateAudience"> {
	public calls = 0;
	public outcome: CredentialAudienceValidationReceiptRef["outcome"] = "valid";

	public async validateAudience(
		request: CredentialAudienceValidationRequest,
	): Promise<Awaited<ReturnType<CredentialBrokerPort["validateAudience"]>>> {
		this.calls += 1;
		const base = {
			schemaVersion: 1 as const,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			receiptId: createRuntimeId("receipt", `credential-audience-${this.calls}`),
			requestId: request.requestId,
			grantId: request.grant.grantId,
			targetExecutorId: request.targetExecutorId,
			invocationDigest: request.invocationDigest,
			audienceDigest: request.grant.audienceDigest,
			outcome: this.outcome,
			validatedAt: request.requestedAt,
		};
		const body = this.outcome === "valid" ? base : { ...base, reasonDigest: "c".repeat(64) };
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } as CredentialAudienceValidationReceiptRef };
	}
}

describe("fail-closed remote executor gateway", () => {
	it("accepts only correlated result plus externally verified attestation", async () => {
		const port = new FakeExecutor(async (request) => ({ ok: true, value: result(request) }));
		const attestation = new FakeAttestation();
		const credentials = new FakeCredentialAudience();
		const gateway = new FailClosedRemoteExecutorGateway([port], attestation, credentials);
		const accepted = await gateway.execute(invocation());
		expect(accepted).toMatchObject({ ok: true, value: { result: { status: "succeeded" }, attestationVerification: { status: "verified" } } });
		expect(port.calls).toBe(1);
		expect(attestation.calls).toBe(1);
		expect(credentials.calls).toBe(1);
	});

	it("validates credential audience before invoking a remote adapter", async () => {
		const port = new FakeExecutor(async (request) => ({ ok: true, value: result(request) }));
		const credentials = new FakeCredentialAudience();
		credentials.outcome = "rejected";
		const rejected = await new FailClosedRemoteExecutorGateway(
			[port],
			new FakeAttestation(),
			credentials,
		).execute(invocation());
		expect(rejected).toMatchObject({ ok: false, error: { code: "remote_rejected" } });
		expect(credentials.calls).toBe(1);
		expect(port.calls).toBe(0);
	});

	it("returns unavailable when executor kind is absent and never invokes another/local fallback", async () => {
		const ssh: RemoteExecutorPort = { kind: "ssh", execute: async () => { throw new Error("must not execute"); } };
		const attestation = new FakeAttestation();
		const gateway = new FailClosedRemoteExecutorGateway([ssh], attestation, new FakeCredentialAudience());
		const rejected = await gateway.execute(invocation());
		expect(rejected).toMatchObject({ ok: false, error: { code: "unavailable" } });
		expect(attestation.calls).toBe(0);
	});

	it("does not fall back after remote failure, bad receipt, or attestation rejection", async () => {
		const request = invocation();
		const throwing = new FakeExecutor(async () => { throw new Error("remote down"); });
		expect(await new FailClosedRemoteExecutorGateway([throwing], new FakeAttestation(), new FakeCredentialAudience()).execute(request)).toMatchObject({ ok: false, error: { code: "unavailable" } });

		const bad = new FakeExecutor(async (value) => ({ ok: true, value: { ...result(value), invocationDigest: "f".repeat(64) } }));
		expect(await new FailClosedRemoteExecutorGateway([bad], new FakeAttestation(), new FakeCredentialAudience()).execute(request)).toMatchObject({ ok: false, error: { code: "invalid_receipt" } });

		const port = new FakeExecutor(async (value) => ({ ok: true, value: result(value) }));
		const rejecting: RemoteAttestationVerifierPort = { verify: async () => ({ ok: false, error: { code: "attestation_rejected", retryable: false, reasonDigest: "a".repeat(64) } }) };
		expect(await new FailClosedRemoteExecutorGateway([port], rejecting, new FakeCredentialAudience()).execute(request)).toMatchObject({ ok: false, error: { code: "attestation_rejected" } });
	});
});

describe("session handoff port", () => {
	it("accepts only a correlated specialty-service receipt", async () => {
		const manifest = handoff();
		const port: SessionHandoffPort = { transfer: async (value) => ({ ok: true, value: handoffReceipt(value) }) };
		expect(await transferSessionHandoff(port, manifest)).toMatchObject({ ok: true, value: { status: "accepted" } });
		const invalid: SessionHandoffPort = { transfer: async (value) => ({ ok: true, value: { ...handoffReceipt(value), manifestDigest: "f".repeat(64) } }) };
		expect(await transferSessionHandoff(invalid, manifest)).toMatchObject({ ok: false, error: { code: "handoff_rejected" } });
	});
});
