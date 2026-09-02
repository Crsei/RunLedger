/** 可审计的本机确定性 auto-review；它从不读取 prompt/LLM 输出作为 authority。 */

import { isAbsolute, relative } from "node:path";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/contracts/public.ts";
import type { AuthorizationRequest, SecurityAccessEvaluation } from "../types.ts";

export const DETERMINISTIC_AUTO_REVIEW_CLASSIFICATION_VERSION = "deterministic-rules-current";

export type AutoApprovalReviewDecision = "allow-once" | "ask-user" | "deny";

export interface AutoApprovalReviewInput {
	readonly request: AuthorizationRequest;
	readonly evaluation: SecurityAccessEvaluation;
	readonly canonicalTarget: string;
	readonly sessionGeneration: number;
	readonly inputDigest: RuntimeDigest;
}

export interface AutoApprovalReviewResult {
	readonly decision: AutoApprovalReviewDecision;
	readonly classificationVersion: string;
	/** 只允许固定、无敏感正文的分类理由。 */
	readonly reason: string;
}

export interface AutoApprovalReviewerPort {
	review(input: AutoApprovalReviewInput, signal?: AbortSignal): Promise<AutoApprovalReviewResult>;
}

export interface AutoApprovalReviewAuditPort {
	recorded(input: {
		readonly inputDigest: RuntimeDigest;
		readonly policyDigest: RuntimeDigest;
		readonly sessionGeneration: number;
		readonly classificationVersion: string;
		readonly decision: AutoApprovalReviewDecision;
		readonly reason: string;
	}): Promise<void>;
}

const SAFE_EXTENSIONS = new Set([
	".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs",
	".ts", ".tsx", ".txt", ".yaml", ".yml",
]);

function safeRelativeWorkspaceFile(workspaceRoot: string, canonicalTarget: string): boolean {
	const relativeTarget = relative(workspaceRoot, canonicalTarget);
	if (relativeTarget.length === 0 || isAbsolute(relativeTarget) || relativeTarget === ".." || relativeTarget.startsWith("../")) return false;
	const segments = relativeTarget.split(/[\\/]/u);
	if (segments.some((segment) => segment.length === 0 || segment.startsWith("."))) return false;
	const extension = relativeTarget.slice(relativeTarget.lastIndexOf("."));
	return SAFE_EXTENSIONS.has(extension);
}

/** 第一版仅允许已 canonicalize 的 workspace 常见文本源码写入。 */
export class DeterministicAutoApprovalReviewer implements AutoApprovalReviewerPort {
	public async review(input: AutoApprovalReviewInput, signal?: AbortSignal): Promise<AutoApprovalReviewResult> {
		if (signal?.aborted) return this.#ask("review_aborted");
		const request = input.request.requests.length === 1 ? input.request.requests[0] : undefined;
		if (input.evaluation.decision !== "ask" || request?.kind !== "filesystem" || request.operation !== "write") return this.#ask("unsupported_request_shape");
		if (!safeRelativeWorkspaceFile(input.request.snapshot.workspaceRoot, input.canonicalTarget)) return this.#ask("workspace_target_not_low_risk");
		return {
			decision: "allow-once",
			classificationVersion: DETERMINISTIC_AUTO_REVIEW_CLASSIFICATION_VERSION,
			reason: "canonical_workspace_source_write",
		};
	}

	#ask(reason: string): AutoApprovalReviewResult {
		return {
			decision: "ask-user",
			classificationVersion: DETERMINISTIC_AUTO_REVIEW_CLASSIFICATION_VERSION,
			reason: reason,
		};
	}
}

export function autoApprovalReviewInputDigest(input: Omit<AutoApprovalReviewInput, "inputDigest">): RuntimeDigest {
	return runtimeDigest({
		requestId: input.request.requestId,
		sessionId: input.request.sessionId,
		toolCallId: input.request.toolCallId,
		policyDigest: input.request.snapshot.policyDigest,
		canonicalTarget: input.canonicalTarget,
		sessionGeneration: input.sessionGeneration,
		requestDigest: runtimeDigest(input.request.requests),
	});
}
