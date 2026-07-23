import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { createVerificationResult } from "../../../src/runtime/verification/evidence.ts";
import { createGateManifest, isGateManifest } from "../../../src/runtime/verification/gate-loader.ts";
import {
	createVerificationReport,
	createVerifierReceipt,
} from "../../../src/runtime/verification/security.ts";
import type { VerifierReceiptBody } from "../../../src/runtime/verification/types.ts";
import {
	artifactReceipt,
	baselineReceipt,
	digest,
	executionEvidence,
	gateManifest,
	invocation,
	makeReceipt,
	registry,
	verificationResult,
} from "../verification/helpers.ts";

describe("Harness Regression: candidate verification attacks", () => {
	it("candidate gate tamper: rejects unknown fields, path traversal, and candidate-controlled evidence replay", () => {
		const trusted = gateManifest();
		expect(isGateManifest(trusted)).toBe(true);
		expect(isGateManifest({ ...trusted, candidateOverride: "npm run attacker-gate" })).toBe(false);
		expect(createGateManifest({
			...trusted,
			executable: { ...trusted.executable, path: "../candidate/forged-gate" },
		})).toMatchObject({ ok: false, error: { code: "invalid_schema" } });

		const command = invocation();
		const replayed = artifactReceipt({
			requestId: createRuntimeId("command", "candidate-old-verification"),
			candidateCommit: "0".repeat(40),
		});
		const result = createVerificationResult(
			baselineReceipt(),
			command,
			executionEvidence({ invocationDigest: command.invocationDigest, artifacts: [replayed] }),
		);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(["scope_mismatch", "cross_commit_evidence"]).toContain(result.error.code);
	});

	it("candidate verifier tamper: a recomputed receipt digest cannot replace a trusted issuer signature", async () => {
		const result = verificationResult();
		const valid = makeReceipt(result);
		const body: VerifierReceiptBody = {
			schemaVersion: valid.schemaVersion,
			authorityId: valid.authorityId,
			tenantId: valid.tenantId,
			receiptId: valid.receiptId,
			verificationId: valid.verificationId,
			issuerId: valid.issuerId,
			resultDigest: valid.resultDigest,
			gateDigest: valid.gateDigest,
			baselineReceiptDigest: valid.baselineReceiptDigest,
			candidateCommit: valid.candidateCommit,
			outcome: valid.outcome,
			issuedAt: valid.issuedAt,
		};
		const forged = createVerifierReceipt(body, {
			...valid.signature,
			value: canonicalDigest({ candidateKey: "attacker", input: digest("forged") }),
		});
		expect(forged.ok).toBe(true);
		if (!forged.ok) return;
		const report = createVerificationReport(result, forged.value);
		expect(report.ok).toBe(true);
		if (!report.ok) return;
		const verified = await registry("production").verify(report.value);
		expect(verified).toMatchObject({ ok: false, error: { code: "invalid_signature" } });
		expect(await registry("production").verifyForCompletion(report.value)).toBe(false);
	});
});
