/** Artifact-backed queue item 的 startup 完整性验证；不解析或返回正文。 */

import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type { ArtifactId, QueueItemId } from "../protocol/v3/ids.ts";
import type { RestoredDurableQueueItem } from "../session/durable-queue.ts";
import type { ArtifactCasStore } from "./cas-store.ts";
import type { ArtifactMetadataStore } from "./metadata-store.ts";
import type { ArtifactError, ArtifactMetadata } from "./types.ts";

export type ArtifactQueueRecoveryIssueReason =
	| "metadata_unavailable"
	| "blob_unavailable"
	| "metadata_corrupted"
	| "reference_mismatch"
	| "blob_digest_mismatch";

export interface ArtifactQueueRecoveryIssue {
	queueItemId: QueueItemId;
	sequence: number;
	artifactId: ArtifactId;
	reason: ArtifactQueueRecoveryIssueReason;
	errorCode?: ArtifactError["code"];
}

export type ArtifactQueueRecoveryResult =
	| { state: "ready"; checked: number }
	| {
			state: "reconciliation_required";
			checked: number;
			issues: readonly ArtifactQueueRecoveryIssue[];
	  }
	| {
			state: "corrupted";
			checked: number;
			issues: readonly ArtifactQueueRecoveryIssue[];
	  };

export interface ArtifactQueueRecoveryValidatorOptions {
	cas: ArtifactCasStore;
	metadata: ArtifactMetadataStore;
}

function referenceFor(metadata: ArtifactMetadata): ArtifactRef {
	return {
		authorityId: metadata.authorityId,
		tenantId: metadata.tenantId,
		artifactId: metadata.artifactId,
		storedDigest: metadata.storedDigest,
		kind: metadata.kind,
		originalSize: metadata.originalSize,
		storedSize: metadata.storedSize,
		mediaType: metadata.mediaType,
		redaction: metadata.redaction,
		transformReceipt: metadata.transformReceipt.receiptId,
		...(metadata.source.workspaceId ? { workspaceId: metadata.source.workspaceId } : {}),
	};
}

function referencesMatch(left: ArtifactRef, right: ArtifactRef): boolean {
	return (
		left.authorityId === right.authorityId &&
		left.tenantId === right.tenantId &&
		left.artifactId === right.artifactId &&
		left.storedDigest === right.storedDigest &&
		left.kind === right.kind &&
		left.originalSize === right.originalSize &&
		left.storedSize === right.storedSize &&
		left.mediaType === right.mediaType &&
		left.redaction === right.redaction &&
		left.transformReceipt === right.transformReceipt &&
		left.workspaceId === right.workspaceId
	);
}

function metadataIssue(
	item: RestoredDurableQueueItem,
	code: ArtifactError["code"],
): ArtifactQueueRecoveryIssue {
	const artifact = item.content.storage === "artifact" ? item.content.artifact : undefined;
	if (!artifact) throw new TypeError("metadata issue requires an Artifact-backed queue item");
	return {
		queueItemId: item.reference.queueItemId,
		sequence: item.enqueuedSequence,
		artifactId: artifact.artifactId,
		reason: code === "not_found" || code === "not_committed"
			? "metadata_unavailable"
			: "metadata_corrupted",
		errorCode: code,
	};
}

function blobIssue(
	item: RestoredDurableQueueItem,
	code: ArtifactError["code"],
): ArtifactQueueRecoveryIssue {
	const artifact = item.content.storage === "artifact" ? item.content.artifact : undefined;
	if (!artifact) throw new TypeError("blob issue requires an Artifact-backed queue item");
	return {
		queueItemId: item.reference.queueItemId,
		sequence: item.enqueuedSequence,
		artifactId: artifact.artifactId,
		reason: code === "digest_mismatch" ? "blob_digest_mismatch" : "blob_unavailable",
		errorCode: code,
	};
}

export class ArtifactQueueRecoveryValidator {
	readonly #cas: ArtifactCasStore;
	readonly #metadata: ArtifactMetadataStore;

	public constructor(options: ArtifactQueueRecoveryValidatorOptions) {
		this.#cas = options.cas;
		this.#metadata = options.metadata;
	}

	/**
	 * 只验证 queue 引用的 committed metadata 和 blob digest。成功读取的 bytes
	 * 不越过本方法边界，实际正文 adoption 仍必须走授权 resolver。
	 */
	public async validate(
		items: readonly RestoredDurableQueueItem[],
	): Promise<ArtifactQueueRecoveryResult> {
		const artifactItems = items.filter((item) => item.content.storage === "artifact");
		const issues: ArtifactQueueRecoveryIssue[] = [];
		for (const item of artifactItems) {
			if (item.content.storage !== "artifact") continue;
			const artifact = item.content.artifact;
			const metadata = await this.#metadata.readCommitted(
				artifact.authorityId,
				artifact.tenantId,
				artifact.artifactId,
			);
			if (!metadata.ok) {
				issues.push(metadataIssue(item, metadata.error.code));
				continue;
			}
			if (
				metadata.value.state !== "committed" ||
				!referencesMatch(referenceFor(metadata.value), artifact)
			) {
				issues.push({
					queueItemId: item.reference.queueItemId,
					sequence: item.enqueuedSequence,
					artifactId: artifact.artifactId,
					reason: "reference_mismatch",
				});
				continue;
			}
			const blob = await this.#cas.read(artifact.storedDigest);
			if (!blob.ok) issues.push(blobIssue(item, blob.error.code));
		}
		if (issues.some((issue) =>
			issue.reason === "metadata_corrupted" ||
			issue.reason === "reference_mismatch" ||
			issue.reason === "blob_digest_mismatch"
		)) return { state: "corrupted", checked: artifactItems.length, issues };
		if (issues.length > 0) {
			return {
				state: "reconciliation_required",
				checked: artifactItems.length,
				issues,
			};
		}
		return { state: "ready", checked: artifactItems.length };
	}
}
