import { describe, expect, it } from "vitest";
import {
	artifactEvidenceReceiptDigest,
	createVerificationResult,
	isVerificationResult,
} from "../../../src/runtime/verification/evidence.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type { ArtifactEvidenceReceipt } from "../../../src/runtime/verification/types.ts";
import {
	artifactReceipt,
	admissionBundle,
	baselineReceipt,
	digest,
	executionEvidence,
	invocation,
} from "./helpers.ts";

function replaceArtifact(
	receipt: ArtifactEvidenceReceipt,
	patch: Partial<Omit<ArtifactEvidenceReceipt, "receiptDigest">>,
): ArtifactEvidenceReceipt {
	const { receiptDigest: _receiptDigest, ...original } = receipt;
	const body = { ...original, ...patch };
	return { ...body, receiptDigest: artifactEvidenceReceiptDigest(body) };
}

describe("verification evidence and deterministic result", () => {
	it("creates a replayable passed result from exit, sandbox, command, and Artifact receipts", () => {
		const command = invocation();
		const evidence = executionEvidence({ invocationDigest: command.invocationDigest });
		const result = createVerificationResult(baselineReceipt(), command, evidence, admissionBundle(command));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.outcome).toBe("passed");
		expect(result.value.command.executable.source).toBe("trusted_baseline");
		expect(isVerificationResult(result.value)).toBe(true);
	});

	it("ignores forged success text and fails on a nonzero process exit", () => {
		const command = invocation();
		const original = artifactReceipt();
		const forgedStdout = replaceArtifact(original, {
			artifact: { ...original.artifact, storedDigest: digest("PASSED all tests") },
		});
		const evidence = executionEvidence({
			invocationDigest: command.invocationDigest,
			exitCode: 1,
			artifacts: [forgedStdout],
		});
		const result = createVerificationResult(baselineReceipt(), command, evidence, admissionBundle(command));
		expect(result.ok && result.value.outcome).toBe("failed");
		if (result.ok) expect(result.value.reasonCodes).toContain("unexpected_exit");
	});

	it.each([
		["degraded sandbox", { enforcement: "degraded" as const }, "sandbox_not_enforced"],
		["unavailable Artifact validation", { artifacts: [artifactReceipt({ validation: "unavailable" })] }, "artifact_validation_unavailable"],
		["quarantined Artifact lineage", { artifacts: [artifactReceipt({ lineageStatus: "quarantined" })] }, "artifact_lineage_unverified"],
	] as const)("classifies %s as inconclusive", (_name, options, reason) => {
		const command = invocation();
		const evidence = executionEvidence({ invocationDigest: command.invocationDigest, ...options });
		const result = createVerificationResult(baselineReceipt(), command, evidence, admissionBundle(command));
		expect(result.ok && result.value.outcome).toBe("inconclusive");
		if (result.ok) expect(result.value.reasonCodes).toContain(reason);
	});

	it("treats a schema-invalid Artifact as a failed gate", () => {
		const command = invocation();
		const invalid = artifactReceipt({ validation: "invalid" });
		const result = createVerificationResult(
			baselineReceipt(),
			command,
			executionEvidence({ invocationDigest: command.invocationDigest, artifacts: [invalid] }),
			admissionBundle(command),
		);
		expect(result.ok && result.value.outcome).toBe("failed");
		if (result.ok) expect(result.value.reasonCodes).toContain("artifact_schema_invalid");
	});

	it("rejects old Artifact evidence from another commit even when its receipt digest is recomputed", () => {
		const command = invocation();
		const stale = artifactReceipt({ candidateCommit: "0".repeat(40) });
		const result = createVerificationResult(
			baselineReceipt(),
			command,
			executionEvidence({ invocationDigest: command.invocationDigest, artifacts: [stale] }),
			admissionBundle(command),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("cross_commit_evidence");
	});

	it("rejects Artifact schema substitution and request replay", () => {
		const command = invocation();
		const wrongSchema = replaceArtifact(artifactReceipt(), { schemaDigest: digest("candidate-schema") });
		const wrongSchemaResult = createVerificationResult(
			baselineReceipt(),
			command,
			executionEvidence({ invocationDigest: command.invocationDigest, artifacts: [wrongSchema] }),
			admissionBundle(command),
		);
		expect(wrongSchemaResult.ok).toBe(false);
		if (!wrongSchemaResult.ok) expect(wrongSchemaResult.error.code).toBe("artifact_invalid");

		const replayedArtifact = artifactReceipt({ requestId: createRuntimeId("command", "old-run") });
		const replayResult = createVerificationResult(
			baselineReceipt(),
			command,
			executionEvidence({ invocationDigest: command.invocationDigest, artifacts: [replayedArtifact] }),
			admissionBundle(command),
		);
		expect(replayResult.ok).toBe(false);
		if (!replayResult.ok) expect(replayResult.error.code).toBe("scope_mismatch");
	});
});
