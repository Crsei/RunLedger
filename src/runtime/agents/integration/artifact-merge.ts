/** Production declarative merge：读取 exact ArtifactRef，验证父 Workspace lease，再单次 apply。 */

import type { ArtifactAccessService } from "../../artifacts/access.ts";
import type { ArtifactMetadata } from "../../artifacts/types.ts";
import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, type PrincipalId } from "../../protocol/v3/ids.ts";
import type { GitOperations } from "../../../worktree/git-operations.ts";
import { inputLineagePreserves } from "../delegation.ts";
import { validateAgentHandoffManifest } from "../handoff.ts";
import { declarativeMergeRequestDigest } from "../merge.ts";
import type {
	AgentErrorCode,
	AgentMergeReceiptRef,
	AgentResult,
	DeclarativeMergePort,
	DeclarativeMergeRequest,
} from "../types.ts";
import type { ProductionAgentWorkspaceAdapter } from "./worktree-workspace.ts";

export interface ProductionArtifactMergeOptions {
	workspace: ProductionAgentWorkspaceAdapter;
	artifactAccess: ArtifactAccessService;
	git: GitOperations;
	principalId: PrincipalId;
	maxPatchBytes?: number;
	clock?: () => Date;
}

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function metadataMatches(
	metadata: ArtifactMetadata,
	report: DeclarativeMergeRequest["artifacts"][number],
	request: DeclarativeMergeRequest,
): boolean {
	const reference = report.artifact;
	return (
		metadata.state === "committed" &&
		metadata.authorityId === reference.authorityId &&
		metadata.tenantId === reference.tenantId &&
		metadata.artifactId === reference.artifactId &&
		metadata.storedDigest === reference.storedDigest &&
		metadata.kind === reference.kind &&
		metadata.mediaType === reference.mediaType &&
		metadata.originalSize === reference.originalSize &&
		metadata.storedSize === reference.storedSize &&
		metadata.redaction === reference.redaction &&
		metadata.transformReceipt.receiptId === reference.transformReceipt &&
		metadata.source.sessionId === request.sourceHandoff.sessionId &&
		metadata.source.workspaceId === request.sourceHandoff.workspaceId &&
		metadata.source.producerId === request.childAgentId &&
		metadata.source.workspaceId === reference.workspaceId &&
		metadata.lineage.status === "verified" &&
		metadata.evidenceStatus === "verified_transform" &&
		inputLineagePreserves(
			metadata.lineage.inputSources,
			metadata.lineage.declassificationReceipts,
			report.inputSources,
			report.declassificationReceipts,
		) &&
		inputLineagePreserves(
			report.inputSources,
			report.declassificationReceipts,
			metadata.lineage.inputSources,
			metadata.lineage.declassificationReceipts,
		)
	);
}

function requestLineageMatchesHandoff(request: DeclarativeMergeRequest): boolean {
	if (!validateAgentHandoffManifest(request.sourceHandoff).ok) return false;
	if (
		request.sourceHandoff.agentId !== request.childAgentId ||
		request.sourceHandoff.parentAgentId !== request.parentAgentId ||
		!inputLineagePreserves(
			request.sourceHandoff.inputSources,
			request.sourceHandoff.declassificationReceipts,
			request.inputSources,
			request.declassificationReceipts,
		) ||
		!inputLineagePreserves(
			request.inputSources,
			request.declassificationReceipts,
			request.sourceHandoff.inputSources,
			request.sourceHandoff.declassificationReceipts,
		)
	) return false;
	return request.artifacts.every((report) =>
		request.sourceHandoff.artifacts.some(
			(candidate) => canonicalDigest(candidate) === canonicalDigest(report),
		),
	);
}

function receiptBody(
	receipt: Omit<AgentMergeReceiptRef, "receiptDigest">,
): Omit<AgentMergeReceiptRef, "receiptDigest"> {
	return receipt;
}

export class ProductionArtifactMergeAdapter implements DeclarativeMergePort {
	readonly #options: ProductionArtifactMergeOptions;
	readonly #clock: () => Date;
	readonly #maxPatchBytes: number;

	public constructor(options: ProductionArtifactMergeOptions) {
		this.#options = options;
		this.#clock = options.clock ?? (() => new Date());
		this.#maxPatchBytes = options.maxPatchBytes ?? 4 * 1024 * 1024;
		if (!Number.isSafeInteger(this.#maxPatchBytes) || this.#maxPatchBytes < 1) {
			throw new RangeError("production Artifact merge patch bound is invalid");
		}
	}

	public async apply(
		request: DeclarativeMergeRequest,
		signal?: AbortSignal,
	): Promise<AgentResult<AgentMergeReceiptRef>> {
		if (signal?.aborted) return fail("reference_unavailable", "declarative merge was aborted", true);
		if (request.requestDigest !== declarativeMergeRequestDigest(request)) {
			return fail("merge_invalid", "production declarative merge request digest is invalid");
		}
		if (!requestLineageMatchesHandoff(request)) {
			return fail("merge_invalid", "merge request is not bound to its exact handoff lineage");
		}
		if (
			request.artifacts.length === 0 ||
			request.artifacts.some((report) =>
				report.agentId !== request.childAgentId ||
				report.artifact.kind !== "diff" ||
				report.artifact.workspaceId !== request.sourceHandoff.workspaceId ||
				report.integrity !== "valid" ||
				report.verification !== "verified"
			)
		) return fail("merge_invalid", "production merge accepts only verified child diff ArtifactRefs");

		return this.#options.workspace.withValidatedWorkspace(
			{
				requestId: request.requestId,
				agentId: request.parentAgentId,
				sessionId: request.targetWorkspace.sessionId,
				receipt: request.targetWorkspace,
			},
			async (workspace) => {
				const patches: Uint8Array[] = [];
				let totalBytes = 0;
				for (const report of request.artifacts) {
					const loaded = await this.#options.artifactAccess.read({
						authorityId: report.artifact.authorityId,
						tenantId: report.artifact.tenantId,
						artifactId: report.artifact.artifactId,
						principalId: this.#options.principalId,
						sessionId: request.sourceHandoff.sessionId,
						workspaceId: request.sourceHandoff.workspaceId,
						capability: "repository_read",
						targetSink: "filesystem",
						declassificationReceipts: request.declassificationReceipts,
					});
					if (!loaded.ok || !metadataMatches(loaded.value.metadata, report, request)) {
						return fail("merge_invalid", "merge ArtifactRef metadata or lineage could not be resolved exactly");
					}
					totalBytes += loaded.value.content.byteLength;
					if (totalBytes > this.#maxPatchBytes) {
						return fail("merge_invalid", "merge patch bytes exceed the configured bound");
					}
					patches.push(loaded.value.content);
				}
				const combined = patches
					.map((patch) => Buffer.from(patch).toString("utf8").replace(/\n*$/u, "\n"))
					.join("");
				if (combined.includes("\0")) return fail("merge_invalid", "merge patch contains NUL");
				const applied = await this.#options.git.applyPatch(
					workspace.envelope.worktreePath,
					combined,
					false,
					signal,
				);
				if (!applied.ok) return fail("merge_invalid", "Workspace rejected the declarative patch apply", applied.error.retryable);
				const appliedAt = this.#clock().toISOString();
				const body: Omit<AgentMergeReceiptRef, "receiptDigest"> = {
					receiptId: createRuntimeId(
						"receipt",
						`agent-merge-${canonicalDigest({ requestDigest: request.requestDigest, appliedAt }).slice(0, 48)}`,
					),
					requestId: request.requestId,
					parentAgentId: request.parentAgentId,
					childAgentId: request.childAgentId,
					targetWorkspaceId: request.targetWorkspace.workspaceId,
					artifactIds: request.artifacts.map((report) => report.artifact.artifactId),
					outcome: "applied",
					resultArtifactRefs: [],
					preservedArtifactRefs: [],
					appliedAt,
				};
				return { ok: true, value: { ...body, receiptDigest: canonicalDigest(receiptBody(body)) } };
			},
		);
	}
}
