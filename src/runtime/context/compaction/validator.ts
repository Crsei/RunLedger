import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { ArtifactId } from "../../protocol/v3/ids.ts";
import { compactionInvariantsMatch } from "../invariants.ts";
import { conservativeTokenEstimate } from "../token-estimator.ts";
import {
	CompactionCheckpointRefSchema,
	isCompactionCheckpointRef,
} from "./schema.ts";
import { Check } from "typebox/value";
import {
	COMPACTION_RECOVERY_CODES,
	type CompactionCut,
	type CompactionInvariantSnapshot,
	type CompactionValidationCode,
	type CompactionValidationDiagnostic,
	type CompactionValidationResult,
	type CompactionCheckpointRef,
	type CompactionRecoveryAssessment,
	type CompactionRecoveryCandidate,
	type CompactionRecoveryCode,
} from "./types.ts";

const SECRET_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:sk|api)[-_][A-Za-z0-9_-]{20,}\b/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

function diagnostic(code: CompactionValidationCode, extra: { sequence?: number; artifactId?: ArtifactId } = {}): CompactionValidationDiagnostic {
	return { code, diagnosticDigest: canonicalDigest({ code, ...extra }), ...extra };
}

export function validateCompactionSummary(options: {
	summary: string;
	cut: CompactionCut;
	before: CompactionInvariantSnapshot;
	after: CompactionInvariantSnapshot;
	maxSummaryTokens: number;
	targetInputBudget: number;
	retainedEstimatedTokens: number;
	previousCheckpoint?: CompactionCheckpointRef;
	validatedAt: string;
}): CompactionValidationResult {
	const diagnostics: CompactionValidationDiagnostic[] = [];
	const summaryTokens = conservativeTokenEstimate(options.summary);
	if (options.summary.trim().length === 0) diagnostics.push(diagnostic("summary_empty"));
	if (summaryTokens > options.maxSummaryTokens) diagnostics.push(diagnostic("summary_budget_exceeded"));
	if (summaryTokens + options.retainedEstimatedTokens > options.targetInputBudget) diagnostics.push(diagnostic("target_budget_exceeded"));
	if (options.cut.retainedFromSequence !== options.cut.sourceToSequence + 1) diagnostics.push(diagnostic("range_gap"));
	if (!compactionInvariantsMatch(options.before, options.after)) diagnostics.push(diagnostic("invariant_mismatch"));
	if (SECRET_PATTERNS.some((pattern) => pattern.test(options.summary))) diagnostics.push(diagnostic("secret_detected"));
	if (
		options.previousCheckpoint !== undefined &&
		(options.previousCheckpoint.sessionId !== options.before.sessionId || options.previousCheckpoint.sourceToSequence >= options.cut.sourceFromSequence)
	) diagnostics.push(diagnostic("checkpoint_chain_mismatch"));
	const validationDigest = canonicalDigest({ summaryDigest: canonicalDigest(options.summary), cut: options.cut, diagnostics });
	return diagnostics.length === 0
		? { outcome: "valid", validationDigest, validatedAt: options.validatedAt, diagnostics: [] }
		: { outcome: "invalid", validationDigest, validatedAt: options.validatedAt, diagnostics };
}

function recoveryAssessment(
	outcome: CompactionRecoveryAssessment["outcome"],
	codes: readonly CompactionRecoveryCode[],
	checkpointId?: CompactionCheckpointRef["checkpointId"],
): CompactionRecoveryAssessment {
	const orderedCodes = COMPACTION_RECOVERY_CODES.filter((code) => codes.includes(code));
	const body = {
		outcome,
		codes: orderedCodes,
		...(checkpointId === undefined ? {} : { checkpointId }),
	};
	return { ...body, assessmentDigest: canonicalDigest(body) };
}

/**
 * 对已读取的 checkpoint/replacement/suffix 证据做纯函数分类。
 * 缺失或无法验证的证明永远不会降级为 recoverable。
 */
export function assessCompactionRecovery(
	candidate: CompactionRecoveryCandidate,
): CompactionRecoveryAssessment {
	if (!Check(CompactionCheckpointRefSchema, candidate.checkpoint)) {
		return recoveryAssessment("corrupted", ["bad_checkpoint"]);
	}
	const checkpoint = candidate.checkpoint;
	const invalidCodes: CompactionRecoveryCode[] = [];
	const corruptedCodes: CompactionRecoveryCode[] = [];

	if (
		checkpoint.sourceFromSequence > checkpoint.sourceToSequence ||
		checkpoint.retainedFromSequence !== checkpoint.sourceToSequence + 1 ||
		checkpoint.survivingSuffixFromSequence !== checkpoint.retainedFromSequence ||
		candidate.suffix.fromSequence !== checkpoint.survivingSuffixFromSequence
	) {
		invalidCodes.push("invalid_window");
	}

	const hasPreviousLink =
		checkpoint.previousCheckpointId !== undefined ||
		checkpoint.previousCheckpointDigest !== undefined ||
		checkpoint.previousReplacementHistoryDigest !== undefined;
	if (hasPreviousLink) {
		if (!Check(CompactionCheckpointRefSchema, candidate.previousCheckpoint)) {
			invalidCodes.push("invalid_chain");
		} else {
			const previous = candidate.previousCheckpoint;
			if (
				!isCompactionCheckpointRef(previous) ||
				previous.sessionId !== checkpoint.sessionId ||
				previous.checkpointId !== checkpoint.previousCheckpointId ||
				previous.checkpointDigest !== checkpoint.previousCheckpointDigest ||
				previous.replacementHistoryDigest !== checkpoint.previousReplacementHistoryDigest ||
				previous.sourceToSequence >= checkpoint.sourceFromSequence
			) {
				invalidCodes.push("invalid_chain");
			}
		}
	} else if (candidate.previousCheckpoint !== undefined) {
		invalidCodes.push("invalid_chain");
	}

	if (!isCompactionCheckpointRef(checkpoint) && invalidCodes.length === 0) {
		corruptedCodes.push("bad_checkpoint");
	}
	if (candidate.checkpointIntegrity !== "verified") {
		corruptedCodes.push("bad_checkpoint");
	}
	if (candidate.observedInvariantDigest !== checkpoint.invariantDigest) {
		corruptedCodes.push("world_state_corruption");
	}
	if (candidate.replacementHistory === undefined) {
		(candidate.legacyImport ? invalidCodes : corruptedCodes).push(
			candidate.legacyImport ? "legacy_missing_replacement" : "replacement_missing",
		);
	} else {
		const replacement = candidate.replacementHistory;
		if (replacement.format !== "full") corruptedCodes.push("patch_without_full");
		if (
			replacement.sessionId !== checkpoint.sessionId ||
			replacement.storedDigest !== checkpoint.replacementHistoryArtifact.storedDigest ||
			replacement.contentDigest !== checkpoint.replacementHistoryDigest ||
			replacement.survivingSuffixFromSequence !== checkpoint.survivingSuffixFromSequence ||
			replacement.previousReplacementHistoryDigest !== checkpoint.previousReplacementHistoryDigest
		) {
			corruptedCodes.push("replacement_corrupted");
		}
	}
	if (candidate.suffix.integrity !== "verified") {
		corruptedCodes.push("suffix_jsonl_corruption");
	}

	const checkpointId = checkpoint.checkpointId;
	if (corruptedCodes.length > 0) {
		return recoveryAssessment("corrupted", corruptedCodes, checkpointId);
	}
	if (invalidCodes.length > 0) {
		return recoveryAssessment("invalid", invalidCodes, checkpointId);
	}
	return recoveryAssessment("recoverable", [], checkpointId);
}
