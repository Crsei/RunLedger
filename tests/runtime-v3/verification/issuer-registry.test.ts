import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	createVerificationReport,
	createVerifierReceipt,
	TrustedVerifierIssuerRegistry,
	verifierSignatureInputDigest,
} from "../../../src/runtime/verification/security.ts";
import type { VerificationResult, VerifierReceipt, VerifierReceiptBody } from "../../../src/runtime/verification/types.ts";
import {
	ISSUER_ID,
	KEY_ID,
	makeReceipt,
	registry,
	verificationResult,
} from "./helpers.ts";

function receiptAt(result: VerificationResult, issuedAt: string, validSignature = true): VerifierReceipt {
	const standard = makeReceipt(result);
	const body: VerifierReceiptBody = {
		schemaVersion: 1,
		authorityId: result.authorityId,
		tenantId: result.tenantId,
		receiptId: standard.receiptId,
		verificationId: result.verificationId,
		issuerId: ISSUER_ID,
		resultDigest: result.resultDigest,
		gateDigest: result.gateDigest,
		baselineReceiptDigest: result.baseline.receiptDigest,
		candidateCommit: result.candidate.candidateCommit,
		outcome: result.outcome,
		issuedAt,
	};
	const inputDigest = verifierSignatureInputDigest(body);
	const created = createVerifierReceipt(body, {
		algorithm: "hmac-sha256",
		keyId: KEY_ID,
		value: validSignature ? canonicalDigest({ key: "test-secret", inputDigest }) : canonicalDigest("forged"),
	});
	if (!created.ok) throw new Error(created.error.message);
	return created.value;
}

describe("trusted verifier issuer registry", () => {
	it("accepts a correlated signed report and unlocks completion only for passed outcome", async () => {
		const result = verificationResult();
		const report = createVerificationReport(result, makeReceipt(result));
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		const trusted = registry("production");
		expect((await trusted.verify(report.value)).ok).toBe(true);
		expect(await trusted.verifyForCompletion(report.value)).toBe(true);

		for (const nonPass of [verificationResult({ exitCode: 1 }), verificationResult({ enforcement: "degraded" })]) {
			const nonPassReport = createVerificationReport(nonPass, makeReceipt(nonPass));
			if (!nonPassReport.ok) throw new Error(nonPassReport.error.message);
			expect((await trusted.verify(nonPassReport.value)).ok).toBe(true);
			expect(await trusted.verifyForCompletion(nonPassReport.value)).toBe(false);
		}
	});

	it("rejects a recomputed receipt digest carrying an invalid signature", async () => {
		const result = verificationResult();
		const report = createVerificationReport(result, receiptAt(result, "2026-07-22T08:00:03.000Z", false));
		if (!report.ok) throw new Error(report.error.message);
		const verified = await registry().verify(report.value);
		expect(verified.ok).toBe(false);
		if (!verified.ok) expect(verified.error.code).toBe("invalid_signature");
	});

	it("rejects stale receipts, unknown issuers, and candidate correlation changes", async () => {
		const result = verificationResult();
		const staleReport = createVerificationReport(result, receiptAt(result, "2026-07-22T07:59:59.000Z"));
		if (!staleReport.ok) throw new Error(staleReport.error.message);
		const stale = await registry().verify(staleReport.value);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.code).toBe("stale_evidence");

		const noIssuers = new TrustedVerifierIssuerRegistry({ environment: "test" });
		const standard = createVerificationReport(result, makeReceipt(result));
		if (!standard.ok) throw new Error(standard.error.message);
		expect((await noIssuers.verify(standard.value)).ok).toBe(false);

		const receipt = makeReceipt(result);
		const crossCommit = createVerifierReceipt(
			{
				schemaVersion: 1,
				authorityId: receipt.authorityId,
				tenantId: receipt.tenantId,
				receiptId: createRuntimeId("receipt", "cross-commit"),
				verificationId: receipt.verificationId,
				issuerId: receipt.issuerId,
				resultDigest: receipt.resultDigest,
				gateDigest: receipt.gateDigest,
				baselineReceiptDigest: receipt.baselineReceiptDigest,
				candidateCommit: "9".repeat(40),
				outcome: receipt.outcome,
				issuedAt: receipt.issuedAt,
			},
			receipt.signature,
		);
		if (!crossCommit.ok) throw new Error(crossCommit.error.message);
		expect(createVerificationReport(result, crossCommit.value).ok).toBe(false);
	});

	it("prevents duplicate issuer registration and test-only issuer registration in production", () => {
		const production = registry("production");
		expect(production.register({
			issuerId: ISSUER_ID,
			environment: "production",
			schemaVersions: [1],
			algorithms: ["hmac-sha256"],
			keyIds: [KEY_ID],
			verify: () => true,
		}).ok).toBe(false);
		const rejected = production.register({
			issuerId: "test-verifier",
			environment: "test-only",
			schemaVersions: [1],
			algorithms: ["hmac-sha256"],
			keyIds: ["test-key"],
			verify: () => true,
		});
		expect(rejected.ok).toBe(false);
	});
});
