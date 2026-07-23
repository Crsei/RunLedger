import type { Static } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	CompactionAttemptReceiptSchema,
	CompactionCheckpointRefSchema,
	CompactionCheckpointSchema,
	CompactionProjectionInstallationReceiptSchema,
	CompactionRecoveryAssessmentSchema,
	CompactionRecoveryCandidateSchema,
	isCompactionAttemptReceipt,
	isCompactionCheckpoint,
	isCompactionCheckpointRef,
	isCompactionProjectionInstallationReceipt,
	isCompactionRecoveryAssessment,
} from "../../../src/runtime/context/compaction/schema.ts";
import type {
	CompactionCheckpoint,
	CompactionCheckpointRef,
	CompactionProjectionInstallationReceipt,
	CompactionRecoveryAssessment,
	CompactionRecoveryCandidate,
} from "../../../src/runtime/context/compaction/types.ts";
import { assessCompactionRecovery } from "../../../src/runtime/context/compaction/validator.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { runtimeEventPayloadSchema } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { asRecord, DIGEST, loadContractFixture } from "./helpers.ts";

function fixture(): Record<string, unknown> {
	return asRecord(loadContractFixture("compaction/multi-chain.json"));
}

describe("Phase 6 compaction contracts", () => {
	it("keeps schema static types aligned with public types", () => {
		expectTypeOf<Static<typeof CompactionCheckpointRefSchema>>().toEqualTypeOf<CompactionCheckpointRef>();
		expectTypeOf<Static<typeof CompactionCheckpointSchema>>().toEqualTypeOf<CompactionCheckpoint>();
		expectTypeOf<Static<typeof CompactionProjectionInstallationReceiptSchema>>()
			.toEqualTypeOf<CompactionProjectionInstallationReceipt>();
		expectTypeOf<Static<typeof CompactionRecoveryCandidateSchema>>()
			.toEqualTypeOf<CompactionRecoveryCandidate>();
		expectTypeOf<Static<typeof CompactionRecoveryAssessmentSchema>>()
			.toEqualTypeOf<CompactionRecoveryAssessment>();
	});

	it("round-trips a validated checkpoint and previous-checkpoint chain", () => {
		const value = fixture();
		expect(Check(CompactionCheckpointRefSchema, value.previous)).toBe(true);
		expect(isCompactionCheckpointRef(value.previous)).toBe(true);
		expect(Check(CompactionCheckpointSchema, value.current)).toBe(true);
		expect(isCompactionCheckpoint(value.current)).toBe(true);
		expect(isCompactionCheckpoint(JSON.parse(JSON.stringify(value.current)) as unknown)).toBe(true);
	});

	it("rejects unsafe cuts, invariant drift, invalid summaries and broken chains", () => {
		const current = asRecord(fixture().current);
		const cut = asRecord(current.cut);
		const after = asRecord(current.invariantsAfter);
		const previous = asRecord(current.previousCheckpoint);
		expect(isCompactionCheckpoint({ ...current, schemaVersion: 2 })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, future: true })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, cut: { ...cut, retainedFromSequence: 20 } })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, invariantsAfter: { ...after, invariantDigest: DIGEST } })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, invariantsAfter: { ...after, inputSources: [] } })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, validation: { outcome: "invalid", validationDigest: DIGEST, validatedAt: "2026-07-22T00:00:01.000Z", diagnostics: [{ code: "tool_pair_split", diagnosticDigest: DIGEST }] } })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, previousCheckpoint: { ...previous, sessionId: "session_other" } })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, replacementHistoryArtifact: undefined })).toBe(false);
		expect(isCompactionCheckpoint({ ...current, previousReplacementHistoryDigest: DIGEST })).toBe(false);
	});

	it("requires an exact CAS installation receipt after durable checkpoint commit", () => {
		const checkpoint = asRecord(fixture().previous);
		const body = {
			schemaVersion: 1 as const,
			authorityId: "authority_fixture",
			tenantId: "tenant_fixture",
			sessionId: "session_fixture",
			receiptId: "receipt_compaction-install",
			state: "live_projection_installed" as const,
			checkpointId: checkpoint.checkpointId,
			checkpointDigest: checkpoint.checkpointDigest,
			replacementHistoryArtifact: checkpoint.replacementHistoryArtifact,
			replacementHistoryDigest: checkpoint.replacementHistoryDigest,
			expectedProjectionRevision: 0,
			installedProjectionRevision: 1,
			previousProjectionDigest: DIGEST,
			projectionDigest: "abababababababababababababababababababababababababababababababab",
			installedAt: "2026-07-22T00:00:04.000Z",
		};
		const receipt = { ...body, receiptDigest: canonicalDigest(body) };
		expect(isCompactionProjectionInstallationReceipt(receipt)).toBe(true);
		expect(isCompactionProjectionInstallationReceipt({ ...receipt, installedProjectionRevision: 2 })).toBe(false);
		expect(isCompactionProjectionInstallationReceipt({ ...receipt, future: true })).toBe(false);
	});

	it("validates completed attempt receipts without implementing the service", () => {
		const previous = fixture().previous;
		const receipt = {
			schemaVersion: 1,
			authorityId: "authority_fixture",
			tenantId: "tenant_fixture",
			principalId: "principal_fixture",
			receiptId: "receipt_compaction",
			compactionId: "compaction_fixture-1",
			sessionId: "session_fixture",
			attemptDigest: DIGEST,
			status: "completed",
			checkpoint: previous,
			completedAt: "2026-07-22T00:00:03.000Z",
		};
		expect(Check(CompactionAttemptReceiptSchema, receipt)).toBe(true);
		expect(isCompactionAttemptReceipt(receipt)).toBe(true);
	});

	it("registers bounded lifecycle payloads with checkpoint links", () => {
		expect(Check(runtimeEventPayloadSchema("compaction.started"), {
			compactionId: "compaction_fixture",
			reason: "auto",
			sourceFromSequence: 1,
			sourceToSequence: 10,
			retainedFromSequence: 11,
			invariantDigest: DIGEST,
			idempotencyKey: "command_compaction",
		})).toBe(true);
		expect(Check(runtimeEventPayloadSchema("compaction.completed"), {
			compactionId: "compaction_fixture",
			checkpointId: "checkpoint_fixture",
			checkpointDigest: DIGEST,
			summaryArtifactId: "artifact_summary",
			summaryDigest: DIGEST,
			invariantDigest: DIGEST,
			previousCheckpointId: "checkpoint_previous",
		})).toBe(true);
	});

	it("classifies every recovery proof gap as invalid or corrupted without fallback", () => {
		const checkpoint = fixture().previous as CompactionCheckpointRef;
		const base: CompactionRecoveryCandidate = {
			checkpoint,
			checkpointIntegrity: "verified",
			replacementHistory: {
				format: "full",
				sessionId: checkpoint.sessionId,
				storedDigest: checkpoint.replacementHistoryArtifact.storedDigest,
				contentDigest: checkpoint.replacementHistoryDigest,
				survivingSuffixFromSequence: checkpoint.survivingSuffixFromSequence,
			},
			legacyImport: false,
			observedInvariantDigest: checkpoint.invariantDigest,
			suffix: { integrity: "verified", fromSequence: checkpoint.survivingSuffixFromSequence },
		};
		expect(Check(CompactionRecoveryCandidateSchema, base)).toBe(true);
		const recovered = assessCompactionRecovery(base);
		expect(Check(CompactionRecoveryAssessmentSchema, recovered)).toBe(true);
		expect(isCompactionRecoveryAssessment(recovered)).toBe(true);
		expect(recovered).toMatchObject({ outcome: "recoverable", codes: [] });

		const cases = [
			{
				name: "invalid-window",
				candidate: {
					...base,
					checkpoint: { ...checkpoint, retainedFromSequence: checkpoint.sourceToSequence + 2 },
				},
				expected: "invalid",
				code: "invalid_window",
			},
			{
				name: "invalid-chain",
				candidate: {
					...base,
					checkpoint: { ...checkpoint, previousCheckpointId: "checkpoint_missing" },
				},
				expected: "invalid",
				code: "invalid_chain",
			},
			{
				name: "world-state-corruption",
				candidate: { ...base, observedInvariantDigest: DIGEST },
				expected: "corrupted",
				code: "world_state_corruption",
			},
			{
				name: "patch-without-full",
				candidate: {
					...base,
					replacementHistory: { ...base.replacementHistory, format: "patch" as const },
				},
				expected: "corrupted",
				code: "patch_without_full",
			},
			{
				name: "legacy-missing-replacement",
				candidate: { ...base, replacementHistory: undefined, legacyImport: true },
				expected: "invalid",
				code: "legacy_missing_replacement",
			},
			{
				name: "bad-checkpoint",
				candidate: { ...base, checkpointIntegrity: "digest_mismatch" as const },
				expected: "corrupted",
				code: "bad_checkpoint",
			},
			{
				name: "suffix-jsonl-corruption",
				candidate: {
					...base,
					suffix: { ...base.suffix, integrity: "jsonl_corrupted" as const },
				},
				expected: "corrupted",
				code: "suffix_jsonl_corruption",
			},
		] as const;
		const declared = asRecord(loadContractFixture("compaction/recovery-failures-v1.json")).cases;
		expect(cases.map(({ name, expected }) => ({ name, expected }))).toEqual(declared);
		for (const item of cases) {
			expect(assessCompactionRecovery(item.candidate), item.name).toMatchObject({
				outcome: item.expected,
				codes: expect.arrayContaining([item.code]),
			});
		}
	});
});
