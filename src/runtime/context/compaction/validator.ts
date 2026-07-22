import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import type { ArtifactId } from "../../protocol/v3/ids.ts";
import { compactionInvariantsMatch } from "../invariants.ts";
import { conservativeTokenEstimate } from "../token-estimator.ts";
import type { CompactionCut, CompactionInvariantSnapshot, CompactionValidationCode, CompactionValidationDiagnostic, CompactionValidationResult, CompactionCheckpointRef } from "./types.ts";

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
