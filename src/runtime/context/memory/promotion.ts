import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, type CommandId } from "../../protocol/v3/ids.ts";
import type { MemoryRef } from "./types.ts";

export const MEMORY_PROMOTION_LEVELS = [
	"case",
	"repository_rule",
	"repeated_validation",
	"regression_suite",
	"global_rule",
] as const;

export type MemoryPromotionLevel = (typeof MEMORY_PROMOTION_LEVELS)[number];

export interface MemoryPromotionCandidate {
	schemaVersion: 1;
	promotionId: CommandId;
	memory: MemoryRef;
	fromLevel?: MemoryPromotionLevel;
	targetLevel: MemoryPromotionLevel;
	previousCandidateDigest?: string;
	evidenceArtifacts: readonly ArtifactRef[];
	disposition: "memory_proposal_required" | "managed_handoff_required";
	directPublicationAllowed: false;
	candidateDigest: string;
}

function expectedTarget(previous: MemoryPromotionCandidate | undefined): MemoryPromotionLevel {
	if (previous === undefined) return "case";
	const index = MEMORY_PROMOTION_LEVELS.indexOf(previous.targetLevel);
	const target = MEMORY_PROMOTION_LEVELS[index + 1];
	if (target === undefined) throw new Error("global memory rule is terminal and cannot be promoted further");
	return target;
}

function validatePrevious(previous: MemoryPromotionCandidate): void {
	const { candidateDigest, ...body } = previous;
	if (candidateDigest !== canonicalDigest(body)) throw new Error("previous memory promotion candidate digest drifted");
}

/**
 * 经验只能逐级生成候选，不在此处发布 Memory 或全局策略。
 * global_rule 没有公共 MemoryScope，必须交给受管策略审批面继续处理。
 */
export function createMemoryPromotionCandidate(input: {
	memory: MemoryRef;
	targetLevel: MemoryPromotionLevel;
	evidenceArtifacts: readonly ArtifactRef[];
	previous?: MemoryPromotionCandidate;
}): MemoryPromotionCandidate {
	if (input.memory.status !== "approved") throw new Error("only approved memory can enter the promotion ladder");
	if (input.previous !== undefined) {
		validatePrevious(input.previous);
		if (
			input.previous.memory.memoryId !== input.memory.memoryId ||
			input.previous.memory.contentDigest !== input.memory.contentDigest ||
			input.previous.memory.revision !== input.memory.revision
		) throw new Error("memory promotion cannot change its reviewed record between levels");
	}
	if (input.targetLevel !== expectedTarget(input.previous)) {
		throw new Error("memory promotion must advance exactly one level");
	}
	if (input.evidenceArtifacts.length === 0) throw new Error("memory promotion requires evidence");
	const evidenceDigests = new Set<string>();
	for (const artifact of input.evidenceArtifacts) {
		if (artifact.authorityId !== input.memory.authorityId || artifact.tenantId !== input.memory.tenantId) {
			throw new Error("memory promotion evidence crosses an authority or tenant boundary");
		}
		if (evidenceDigests.has(artifact.storedDigest)) throw new Error("memory promotion evidence must be distinct");
		evidenceDigests.add(artifact.storedDigest);
	}
	if (input.targetLevel !== "case" && input.memory.scope.scope !== "workspace") {
		throw new Error("repository and higher rules require workspace-scoped memory");
	}
	if (input.targetLevel === "repeated_validation") {
		const validations = input.evidenceArtifacts.filter((artifact) => artifact.kind === "test_report");
		if (new Set(validations.map((artifact) => artifact.storedDigest)).size < 2) {
			throw new Error("repeated validation requires at least two distinct test reports");
		}
	}
	if (input.targetLevel === "regression_suite" || input.targetLevel === "global_rule") {
		if (!input.evidenceArtifacts.some((artifact) => artifact.kind === "test_report")) {
			throw new Error("regression and global rule candidates require regression-suite evidence");
		}
	}

	const body = {
		schemaVersion: 1 as const,
		promotionId: createRuntimeId("command"),
		memory: input.memory,
		...(input.previous === undefined ? {} : {
			fromLevel: input.previous.targetLevel,
			previousCandidateDigest: input.previous.candidateDigest,
		}),
		targetLevel: input.targetLevel,
		evidenceArtifacts: [...input.evidenceArtifacts].sort((left, right) =>
			left.storedDigest.localeCompare(right.storedDigest) || left.artifactId.localeCompare(right.artifactId)),
		disposition: input.targetLevel === "global_rule"
			? "managed_handoff_required" as const
			: "memory_proposal_required" as const,
		directPublicationAllowed: false as const,
	};
	return { ...body, candidateDigest: canonicalDigest(body) };
}
