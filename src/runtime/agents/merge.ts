/** 声明式 merge：只向 Workspace adapter 传递已声明且已验证的 ArtifactRef。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type {
	AgentArtifactReport,
	AgentErrorCode,
	AgentHandoffManifest,
	AgentMergeReceiptRef,
	AgentNode,
	AgentResult,
	DeclarativeMergePort,
	DeclarativeMergeRequest,
} from "./types.ts";
import { validateAgentHandoffManifest } from "./handoff.ts";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

export function declarativeMergeRequestDigest(
	request: Omit<DeclarativeMergeRequest, "requestDigest">,
): string {
	return canonicalDigest({
		requestId: request.requestId,
		parentAgentId: request.parentAgentId,
		childAgentId: request.childAgentId,
		targetWorkspaceReceiptId: request.targetWorkspace.receiptId,
		targetWorkspaceReceiptDigest: request.targetWorkspace.receiptDigest,
		handoffId: request.sourceHandoff.handoffId,
		handoffDigest: request.sourceHandoff.manifestDigest,
		artifacts: request.artifacts,
		inputSources: request.inputSources,
		declassificationReceipts: request.declassificationReceipts,
	});
}

function receiptDigest(receipt: AgentMergeReceiptRef): string {
	const { receiptDigest: _receiptDigest, ...body } = receipt;
	return canonicalDigest(body);
}

function artifactIsDeclaredAndVerified(report: AgentArtifactReport, child: AgentNode): boolean {
	const expected = child.artifactContract.expected.find((candidate) => candidate.logicalName === report.logicalName);
	return Boolean(
		expected &&
			expected.kind === report.artifact.kind &&
			expected.mediaType === report.artifact.mediaType &&
			report.integrity === "valid" &&
			report.verification === "verified" &&
			child.artifacts.some(
				(candidate) =>
					candidate.logicalName === report.logicalName &&
					candidate.artifact.artifactId === report.artifact.artifactId,
			),
	);
}

export function buildDeclarativeMergeRequest(
	input: {
		requestId: DeclarativeMergeRequest["requestId"];
		idempotencyKey: DeclarativeMergeRequest["idempotencyKey"];
		parent: AgentNode;
		child: AgentNode;
		handoff: AgentHandoffManifest;
		logicalNames: readonly string[];
	},
): AgentResult<DeclarativeMergeRequest> {
	const handoff = validateAgentHandoffManifest(input.handoff, input.child);
	if (!handoff.ok) return handoff;
	if (
		input.child.parentAgentId !== input.parent.agentId ||
		input.parent.workspaceReceipt.workspaceId === input.child.workspaceReceipt.workspaceId ||
		input.parent.workspaceReceipt.status !== "active" ||
		input.parent.workspaceReceipt.strategy.kind === "readonly_checkout"
	) {
		return fail("merge_invalid", "merge parent/child workspace binding is invalid");
	}
	const names = new Set(input.logicalNames);
	if (names.size === 0 || names.size !== input.logicalNames.length) {
		return fail("merge_invalid", "merge must select unique declared logical artifact names");
	}
	const artifacts: AgentArtifactReport[] = [];
	for (const logicalName of input.logicalNames) {
		const report = [...input.handoff.artifacts]
			.reverse()
			.find((candidate) => candidate.logicalName === logicalName);
		if (!report || !artifactIsDeclaredAndVerified(report, input.child)) {
			return fail("merge_invalid", "merge selected an undeclared, corrupt, or unverified ArtifactRef");
		}
		artifacts.push(report);
	}
	const body: Omit<DeclarativeMergeRequest, "requestDigest"> = {
		requestId: input.requestId,
		idempotencyKey: input.idempotencyKey,
		parentAgentId: input.parent.agentId,
		childAgentId: input.child.agentId,
		targetWorkspace: { ...input.parent.workspaceReceipt },
		sourceHandoff: { ...input.handoff, artifacts: [...input.handoff.artifacts] },
		artifacts,
		inputSources: input.handoff.inputSources.map((source) => ({ ...source, taintLabels: [...source.taintLabels] })),
		declassificationReceipts: input.handoff.declassificationReceipts.map((receipt) => ({ ...receipt })),
	};
	return { ok: true, value: { ...body, requestDigest: declarativeMergeRequestDigest(body) } };
}

export function mergeReceiptMatches(receipt: AgentMergeReceiptRef, request: DeclarativeMergeRequest): boolean {
	let expectedReceiptDigest: string;
	try {
		expectedReceiptDigest = receiptDigest(receipt);
	} catch {
		return false;
	}
	const expectedIds = request.artifacts.map((report) => report.artifact.artifactId).sort();
	const actualIds = [...receipt.artifactIds].sort();
	if (
		!isRuntimeId(receipt.receiptId, "receipt") ||
		receipt.requestId !== request.requestId ||
		receipt.parentAgentId !== request.parentAgentId ||
		receipt.childAgentId !== request.childAgentId ||
		receipt.targetWorkspaceId !== request.targetWorkspace.workspaceId ||
		expectedIds.length !== actualIds.length ||
		expectedIds.some((value, index) => value !== actualIds[index]) ||
		!DIGEST_PATTERN.test(receipt.receiptDigest) ||
		receipt.receiptDigest !== expectedReceiptDigest
	) {
		return false;
	}
	if (receipt.outcome === "conflict") {
		const preserved = new Set(receipt.preservedArtifactRefs.map((artifact) => artifact.artifactId));
		return (
			expectedIds.every((artifactId) => preserved.has(artifactId)) &&
			receipt.resultArtifactRefs.length > 0 &&
			receipt.resultArtifactRefs.every(
				(artifact) => !artifact.workspaceId || artifact.workspaceId === request.targetWorkspace.workspaceId,
			)
		);
	}
	return receipt.outcome !== "applied" || receipt.preservedArtifactRefs.length === 0;
}

export async function executeDeclarativeMerge(
	request: DeclarativeMergeRequest,
	port: DeclarativeMergePort,
	signal?: AbortSignal,
): Promise<AgentResult<AgentMergeReceiptRef>> {
	if (request.requestDigest !== declarativeMergeRequestDigest(request)) {
		return fail("merge_invalid", "declarative merge request digest is invalid");
	}
	try {
		const result = await port.apply(request, signal);
		if (!result.ok) return result;
		return mergeReceiptMatches(result.value, request)
			? result
			: fail("merge_invalid", "Workspace merge adapter returned an uncorrelated receipt");
	} catch {
		return fail("reference_unavailable", "Workspace merge adapter is unavailable", true);
	}
}
