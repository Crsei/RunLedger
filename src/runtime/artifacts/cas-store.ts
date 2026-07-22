/** SHA-256 Artifact CAS 与 intent/pending/commit 协调器。 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import type { AuthorityId, CommandId, TenantId } from "../protocol/v3/ids.ts";
import type { ArtifactKeyProvider } from "./key-provider.ts";
import { createArtifactLineage } from "./lineage.ts";
import { ArtifactMetadataStore, finalizeArtifactMetadata } from "./metadata-store.ts";
import {
	transformArtifactContent,
	transformLegacyArtifactContent,
	type ArtifactTransformResult,
} from "./redaction.ts";
import {
	ARTIFACT_METADATA_SCHEMA_VERSION,
	type ArtifactAbortReason,
	type ArtifactError,
	type ArtifactEventJournalPort,
	type ArtifactIntentRecord,
	type ArtifactJournalState,
	type ArtifactMetadata,
	type ArtifactMetadataBody,
	type ArtifactResult,
	type ArtifactScope,
	type ArtifactWriteOutcome,
	type ArtifactWriteRequest,
} from "./types.ts";

export type ArtifactCasWritePhase = "before_write" | "before_rename";

export interface ArtifactCasStoreOptions {
	rootDir: string;
	onWritePhase?: (phase: ArtifactCasWritePhase, targetPath: string) => Promise<void> | void;
}

export interface ArtifactRepositoryOptions {
	cas: ArtifactCasStore;
	metadata: ArtifactMetadataStore;
	journal: ArtifactEventJournalPort;
	keyProvider: ArtifactKeyProvider;
	clock?: () => Date;
}

export interface ArtifactReconciliationReport {
	recovered: readonly CommandId[];
	rolledBack: readonly CommandId[];
	failed: readonly { intentId: CommandId; error: ArtifactError }[];
}

export interface LegacyTmpImportRequest extends Omit<ArtifactWriteRequest, "content" | "redaction" | "forensicAuthorization"> {
	legacyPath: string;
}

function failure(
	code: ArtifactError["code"],
	message: string,
	retryable = false,
): Extract<ArtifactResult<never>, { ok: false }> {
	return { ok: false, error: { code, message, retryable } };
}

function digestOf(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function isDigest(value: string): boolean {
	return /^[a-f0-9]{64}$/.test(value);
}

async function exists(path: string): Promise<boolean> {
	try {
		const handle = await open(path, "r");
		await handle.close();
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw cause;
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

export class ArtifactCasStore {
	readonly #rootDir: string;
	readonly #onWritePhase?: ArtifactCasStoreOptions["onWritePhase"];

	public constructor(options: ArtifactCasStoreOptions) {
		this.#rootDir = options.rootDir;
		this.#onWritePhase = options.onWritePhase;
	}

	#blobPath(digest: string): string {
		return join(this.#rootDir, "blobs", "sha256", digest.slice(0, 2), digest.slice(2, 4), `${digest}.blob`);
	}

	#pendingPath(scope: ArtifactScope, intentId: CommandId, digest: string): string {
		return join(this.#rootDir, "pending", scope.authorityId, scope.tenantId, intentId, `${digest}.blob`);
	}

	async #readVerified(path: string, expectedDigest: string): Promise<ArtifactResult<Uint8Array>> {
		let content: Uint8Array;
		try {
			content = await readFile(path);
		} catch (cause) {
			const nodeError = cause as NodeJS.ErrnoException;
			if (nodeError.code === "ENOENT") return failure("not_found", "artifact blob not found");
			return failure("durable_write_failed", nodeError.message, true);
		}
		if (digestOf(content) !== expectedDigest) {
			return failure("digest_mismatch", "artifact blob digest mismatch");
		}
		return { ok: true, value: Uint8Array.from(content) };
	}

	public async stage(
		scope: ArtifactScope,
		intentId: CommandId,
		content: Uint8Array,
		expectedDigest: string,
	): Promise<ArtifactResult<void>> {
		if (
			!isRuntimeId(scope.authorityId, "authority") ||
			!isRuntimeId(scope.tenantId, "tenant") ||
			!isRuntimeId(intentId, "command") ||
			!isDigest(expectedDigest) ||
			digestOf(content) !== expectedDigest
		) return failure("invalid_request", "artifact stage identity or digest is invalid");

		const target = this.#pendingPath(scope, intentId, expectedDigest);
		const parent = dirname(target);
		const temporary = join(parent, `.${randomUUID()}.partial`);
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(parent, { recursive: true, mode: 0o700 });
			if (await exists(target)) {
				const existing = await this.#readVerified(target, expectedDigest);
				return existing.ok ? { ok: true, value: undefined } : existing;
			}
			await this.#onWritePhase?.("before_write", target);
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(content);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.#onWritePhase?.("before_rename", target);
			await rename(temporary, target);
			await syncDirectory(parent);
			return { ok: true, value: undefined };
		} catch (cause) {
			if (handle) await handle.close().catch(() => undefined);
			await rm(temporary, { force: true }).catch(() => undefined);
			return failure("durable_write_failed", cause instanceof Error ? cause.message : "artifact blob stage failed", true);
		}
	}

	public async promote(
		scope: ArtifactScope,
		intentId: CommandId,
		digest: string,
	): Promise<ArtifactResult<void>> {
		if (
			!isRuntimeId(scope.authorityId, "authority") ||
			!isRuntimeId(scope.tenantId, "tenant") ||
			!isRuntimeId(intentId, "command") ||
			!isDigest(digest)
		) return failure("invalid_request", "artifact promotion identity or digest is invalid");
		const pending = this.#pendingPath(scope, intentId, digest);
		const target = this.#blobPath(digest);
		const parent = dirname(target);
		// promote 是 startup reconcile 的幂等边界。rename 已完成但 metadata commit
		// 尚未落盘时，pending 不再存在；此时经过 digest 验证的 committed blob
		// 就是成功证据，不能把它误报为 not_found。
		const existingTarget = await this.#readVerified(target, digest);
		if (existingTarget.ok) {
			await rm(pending, { force: true }).catch(() => undefined);
			return { ok: true, value: undefined };
		}
		if (existingTarget.error.code !== "not_found") return existingTarget;
		const verifiedPending = await this.#readVerified(pending, digest);
		if (!verifiedPending.ok) {
			// 跨进程 promote 可能发生在两次读取之间；再次验证 target 后再失败。
			const racedTarget = await this.#readVerified(target, digest);
			return racedTarget.ok ? { ok: true, value: undefined } : verifiedPending;
		}
		try {
			await mkdir(parent, { recursive: true, mode: 0o700 });
			if (await exists(target)) {
				const existing = await this.#readVerified(target, digest);
				if (!existing.ok) return existing;
				await rm(pending, { force: true });
				return { ok: true, value: undefined };
			}
			await this.#onWritePhase?.("before_rename", target);
			await rename(pending, target);
			await syncDirectory(parent);
			return { ok: true, value: undefined };
		} catch (cause) {
			const nodeError = cause as NodeJS.ErrnoException;
			if (nodeError.code === "EEXIST" || nodeError.code === "ENOENT") {
				const existing = await this.#readVerified(target, digest);
				if (existing.ok) {
					await rm(pending, { force: true }).catch(() => undefined);
					return { ok: true, value: undefined };
				}
			}
			return failure("durable_write_failed", nodeError.message, true);
		}
	}

	public read(digest: string): Promise<ArtifactResult<Uint8Array>> {
		if (!isDigest(digest)) return Promise.resolve(failure("invalid_request", "artifact digest is invalid"));
		return this.#readVerified(this.#blobPath(digest), digest);
	}

	public async removePending(scope: ArtifactScope, intentId: CommandId, digest: string): Promise<ArtifactResult<void>> {
		if (!isDigest(digest)) return failure("invalid_request", "artifact digest is invalid");
		return this.removePendingIntent(scope, intentId);
	}

	public async removePendingIntent(scope: ArtifactScope, intentId: CommandId): Promise<ArtifactResult<void>> {
		if (
			!isRuntimeId(scope.authorityId, "authority") ||
			!isRuntimeId(scope.tenantId, "tenant") ||
			!isRuntimeId(intentId, "command")
		) return failure("invalid_request", "artifact pending identity is invalid");
		try {
			await rm(join(this.#rootDir, "pending", scope.authorityId, scope.tenantId, intentId), { recursive: true, force: true });
			return { ok: true, value: undefined };
		} catch (cause) {
			return failure("durable_write_failed", cause instanceof Error ? cause.message : "pending blob removal failed", true);
		}
	}

	public async remove(digest: string): Promise<ArtifactResult<void>> {
		if (!isDigest(digest)) return failure("invalid_request", "artifact digest is invalid");
		try {
			await rm(this.#blobPath(digest), { force: true });
			return { ok: true, value: undefined };
		} catch (cause) {
			return failure("durable_write_failed", cause instanceof Error ? cause.message : "artifact blob removal failed", true);
		}
	}
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

function validWriteRequest(request: ArtifactWriteRequest): boolean {
	return (
		isRuntimeId(request.authorityId, "authority") &&
		isRuntimeId(request.tenantId, "tenant") &&
		isRuntimeId(request.artifactId, "artifact") &&
		isRuntimeId(request.intentId, "command") &&
		isRuntimeId(request.principalId, "principal") &&
		isRuntimeId(request.source.sessionId, "session") &&
		(!request.source.workspaceId || isRuntimeId(request.source.workspaceId, "workspace")) &&
		(isRuntimeId(request.source.producerId, "agent") || isRuntimeId(request.source.producerId, "principal")) &&
		request.mediaType.length > 0 &&
		(request.compression === undefined || request.compression === "none")
	);
}

function finalMetadataFromPending(pending: ArtifactMetadata, committedAt: string): ArtifactMetadata {
	const { metadataDigest: _digest, ...body } = pending;
	return finalizeArtifactMetadata({ ...body, state: "committed", committedAt });
}

export class ArtifactRepository {
	readonly #cas: ArtifactCasStore;
	readonly #metadata: ArtifactMetadataStore;
	readonly #journal: ArtifactEventJournalPort;
	readonly #keyProvider: ArtifactKeyProvider;
	readonly #clock: () => Date;

	public constructor(options: ArtifactRepositoryOptions) {
		this.#cas = options.cas;
		this.#metadata = options.metadata;
		this.#journal = options.journal;
		this.#keyProvider = options.keyProvider;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #abortIntent(
		request: ArtifactWriteRequest,
		reason: ArtifactAbortReason,
		error: ArtifactError,
	): Promise<ArtifactResult<void>> {
		return this.#journal.recordAbort({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			intentId: request.intentId,
			artifactId: request.artifactId,
			reason,
			reasonDigest: canonicalDigest({ reason, code: error.code, retryable: error.retryable }),
			abortedAt: this.#clock().toISOString(),
		});
	}

	async #writePrepared(
		request: ArtifactWriteRequest,
		transformed: ArtifactTransformResult,
		evidenceStatus: "verified_transform" | "legacy_unverified",
	): Promise<ArtifactResult<ArtifactWriteOutcome>> {
		const createdAt = request.createdAt ?? this.#clock().toISOString();
		const lineage = createArtifactLineage(request, request.lineage, evidenceStatus === "legacy_unverified");
		if (!lineage.ok) return lineage;
		const intent: ArtifactIntentRecord = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			intentId: request.intentId,
			artifactId: request.artifactId,
			sessionId: request.source.sessionId,
			...(request.source.workspaceId ? { workspaceId: request.source.workspaceId } : {}),
			producerId: request.source.producerId,
			kind: request.kind,
			mediaType: request.mediaType,
			lineageDigest: lineage.value.lineageDigest,
			createdAt,
		};
		const existingState = await this.#journal.stateForIntent(intent.intentId);
		if (!existingState.ok) return existingState;
		if (existingState.value.state === "aborted") {
			return failure("invalid_request", "an aborted artifact intent cannot be retried");
		}
		if (existingState.value.state === "committed") {
			if (canonicalDigest(existingState.value.intent) !== canonicalDigest(intent)) {
				return failure("invalid_request", "artifact intent id is already committed for different metadata");
			}
			const reconciled = await this.reconcile(request);
			if (!reconciled.ok) return reconciled;
			if (reconciled.value.failed.some((entry) => entry.intentId === intent.intentId)) {
				return failure("durable_write_failed", "committed artifact retry could not be reconciled", true);
			}
			const metadata = await this.#metadata.readCommitted(request.authorityId, request.tenantId, request.artifactId);
			if (!metadata.ok) return metadata;
			if (
				metadata.value.intentId !== request.intentId ||
				metadata.value.storedDigest !== transformed.storedDigest ||
				metadata.value.storedDigest !== existingState.value.commit.storedDigest ||
				metadata.value.metadataDigest !== existingState.value.commit.metadataDigest ||
				metadata.value.lineage.lineageDigest !== lineage.value.lineageDigest ||
				metadata.value.transformReceipt.receiptId !== existingState.value.commit.transformReceiptId
			) return failure("corrupted_metadata", "committed artifact retry does not match durable content");
			return {
				ok: true,
				value: { state: "committed", metadata: metadata.value, reference: referenceFor(metadata.value) },
			};
		}
		const intentRecorded = await this.#journal.recordIntent(intent);
		if (!intentRecorded.ok) return intentRecorded;

		const stagedBlob = await this.#cas.stage(request, request.intentId, transformed.storedContent, transformed.storedDigest);
		if (!stagedBlob.ok) {
			const aborted = await this.#abortIntent(request, "staging_failed", stagedBlob.error);
			return aborted.ok
				? stagedBlob
				: failure("durable_write_failed", "artifact staging failed and its intent could not be durably aborted", true);
		}

		const body: ArtifactMetadataBody = {
			schemaVersion: ARTIFACT_METADATA_SCHEMA_VERSION,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: request.artifactId,
			intentId: request.intentId,
			state: "pending",
			kind: request.kind,
			mediaType: request.mediaType,
			originalSize: transformed.originalSize,
			storedSize: transformed.storedSize,
			compression: "none",
			storedDigest: transformed.storedDigest,
			source: request.source,
			sourceReceipt: transformed.sourceReceipt,
			redaction: transformed.redaction,
			redactionPolicy: transformed.transformReceipt.policy,
			transformReceipt: transformed.transformReceipt,
			lineage: lineage.value,
			...(transformed.encryption ? { encryption: transformed.encryption } : {}),
			references: [...new Set(request.references ?? [])],
			...(request.retention?.expiresAt ? { expiresAt: request.retention.expiresAt } : {}),
			pins: [...new Set(request.retention?.pins ?? [])],
			referenceCount: request.retention?.referenceCount ?? 0,
			legalHold: request.retention?.legalHold ?? { status: "none" },
			evidenceStatus,
			createdAt,
		};
		let pending: ArtifactMetadata;
		try {
			pending = finalizeArtifactMetadata(body);
		} catch (cause) {
			await this.#cas.removePending(request, request.intentId, transformed.storedDigest);
			const invalid = failure("invalid_request", cause instanceof Error ? cause.message : "artifact metadata is not canonical");
			const aborted = await this.#abortIntent(request, "metadata_failed", invalid.error);
			return aborted.ok
				? invalid
				: failure("durable_write_failed", "artifact metadata failed and its intent could not be durably aborted", true);
		}
		const stagedMetadata = await this.#metadata.stage(pending);
		if (!stagedMetadata.ok) {
			await this.#cas.removePending(request, request.intentId, transformed.storedDigest);
			const aborted = await this.#abortIntent(request, "metadata_failed", stagedMetadata.error);
			return aborted.ok
				? stagedMetadata
				: failure("durable_write_failed", "artifact metadata write failed and its intent could not be durably aborted", true);
		}

		const committedAt = this.#clock().toISOString();
		const expectedCommitted = finalMetadataFromPending(pending, committedAt);
		const committedEvent = await this.#journal.recordCommit({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			intentId: request.intentId,
			artifactId: request.artifactId,
			storedDigest: transformed.storedDigest,
			storedSize: transformed.storedSize,
			metadataDigest: expectedCommitted.metadataDigest,
			transformReceiptId: transformed.transformReceipt.receiptId,
			committedAt,
		});
		if (!committedEvent.ok) return { ok: true, value: { state: "pending", metadata: pending } };

		const promoted = await this.#cas.promote(request, request.intentId, transformed.storedDigest);
		if (!promoted.ok) return { ok: true, value: { state: "pending", metadata: pending } };
		const committed = await this.#metadata.commit(
			request.authorityId,
			request.tenantId,
			request.intentId,
			committedAt,
		);
		if (!committed.ok) return { ok: true, value: { state: "pending", metadata: pending } };
		if (committed.value.metadataDigest !== expectedCommitted.metadataDigest) {
			return failure("corrupted_metadata", "committed artifact metadata digest changed after event commit");
		}
		return { ok: true, value: { state: "committed", metadata: committed.value, reference: referenceFor(committed.value) } };
	}

	public async write(request: ArtifactWriteRequest): Promise<ArtifactResult<ArtifactWriteOutcome>> {
		if (!validWriteRequest(request)) return failure("invalid_request", "artifact write request is invalid");
		const transformed = await transformArtifactContent({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: request.artifactId,
			content: request.content,
			mediaType: request.mediaType,
			mode: request.redaction ?? "default",
			keyProvider: this.#keyProvider,
			...(request.forensicAuthorization ? { forensicAuthorization: request.forensicAuthorization } : {}),
		});
		if (!transformed.ok) return transformed;
		return this.#writePrepared(request, transformed.value, "verified_transform");
	}

	public async importLegacyTmp(request: LegacyTmpImportRequest): Promise<ArtifactResult<ArtifactWriteOutcome>> {
		if (!validWriteRequest({ ...request, content: "" })) return failure("invalid_request", "legacy import request is invalid");
		if (!basename(request.legacyPath).startsWith("tool-output-")) {
			return failure("invalid_request", "legacy import accepts only tool-output-* files");
		}
		let content: Uint8Array;
		try {
			content = await readFile(resolve(request.legacyPath));
		} catch (cause) {
			return failure("not_found", cause instanceof Error ? cause.message : "legacy tool output not found");
		}
		const transformed = await transformLegacyArtifactContent({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			artifactId: request.artifactId,
			content,
			mediaType: request.mediaType,
			keyProvider: this.#keyProvider,
		});
		if (!transformed.ok) return transformed;
		return this.#writePrepared({ ...request, content }, transformed.value, "legacy_unverified");
	}

	public async reconcile(scope: ArtifactScope): Promise<ArtifactResult<ArtifactReconciliationReport>> {
		const pending = await this.#metadata.listPending(scope.authorityId, scope.tenantId);
		if (!pending.ok) return pending;
		let openIntents: ArtifactResult<readonly ArtifactIntentRecord[]>;
		try {
			openIntents = await this.#journal.listOpenIntents(scope);
		} catch (cause) {
			return failure("durable_write_failed", cause instanceof Error ? cause.message : "artifact journal unavailable", true);
		}
		if (!openIntents.ok) return openIntents;
		const recovered: CommandId[] = [];
		const rolledBack: CommandId[] = [];
		const failed: { intentId: CommandId; error: ArtifactError }[] = [];
		const handled = new Set<CommandId>();
		for (const metadata of pending.value) {
			handled.add(metadata.intentId);
			let state: ArtifactResult<ArtifactJournalState>;
			try {
				state = await this.#journal.stateForIntent(metadata.intentId);
			} catch (cause) {
				state = failure("durable_write_failed", cause instanceof Error ? cause.message : "artifact journal unavailable", true);
			}
			if (!state.ok) {
				failed.push({ intentId: metadata.intentId, error: state.error });
				continue;
			}
			if (state.value.state !== "committed") {
				if (state.value.state === "intent_recorded") {
					const aborted = await this.#journal.recordAbort({
						authorityId: scope.authorityId,
						tenantId: scope.tenantId,
						intentId: metadata.intentId,
						artifactId: metadata.artifactId,
						reason: "reconciled_rollback",
						reasonDigest: canonicalDigest({ reason: "reconciled_rollback", metadataDigest: metadata.metadataDigest }),
						abortedAt: this.#clock().toISOString(),
					});
					if (!aborted.ok) {
						// 保留 pending metadata 作为下次 startup reconcile 的 durable 枚举锚点。
						failed.push({ intentId: metadata.intentId, error: aborted.error });
						continue;
					}
				}
				const removedBlob = await this.#cas.removePending(scope, metadata.intentId, metadata.storedDigest);
				if (!removedBlob.ok) {
					failed.push({ intentId: metadata.intentId, error: removedBlob.error });
					continue;
				}
				const removedMetadata = await this.#metadata.removePending(scope.authorityId, scope.tenantId, metadata.intentId);
				if (!removedMetadata.ok) {
					failed.push({ intentId: metadata.intentId, error: removedMetadata.error });
					continue;
				}
				rolledBack.push(metadata.intentId);
				continue;
			}
			const commit = state.value.commit;
			if (
				commit.artifactId !== metadata.artifactId ||
				commit.storedDigest !== metadata.storedDigest ||
				commit.transformReceiptId !== metadata.transformReceipt.receiptId
			) {
				failed.push({
					intentId: metadata.intentId,
					error: { code: "corrupted_metadata", message: "artifact commit does not match pending metadata", retryable: false },
				});
				continue;
			}
			const promoted = await this.#cas.promote(scope, metadata.intentId, metadata.storedDigest);
			if (!promoted.ok) {
				failed.push({ intentId: metadata.intentId, error: promoted.error });
				continue;
			}
			const committedAt = commit.committedAt;
			const expected = finalMetadataFromPending(metadata, committedAt);
			if (expected.metadataDigest !== commit.metadataDigest) {
				failed.push({
					intentId: metadata.intentId,
					error: { code: "corrupted_metadata", message: "artifact commit metadata digest is not reproducible", retryable: false },
				});
				continue;
			}
			const committed = await this.#metadata.commit(scope.authorityId, scope.tenantId, metadata.intentId, committedAt);
			if (!committed.ok) {
				failed.push({ intentId: metadata.intentId, error: committed.error });
				continue;
			}
			recovered.push(metadata.intentId);
		}
		for (const intent of openIntents.value) {
			if (handled.has(intent.intentId)) continue;
			const aborted = await this.#journal.recordAbort({
				authorityId: scope.authorityId,
				tenantId: scope.tenantId,
				intentId: intent.intentId,
				artifactId: intent.artifactId,
				reason: "reconciled_rollback",
				reasonDigest: canonicalDigest({ reason: "reconciled_rollback", intentDigest: canonicalDigest(intent) }),
				abortedAt: this.#clock().toISOString(),
			});
			if (!aborted.ok) {
				failed.push({ intentId: intent.intentId, error: aborted.error });
				continue;
			}
			const removedBlob = await this.#cas.removePendingIntent(scope, intent.intentId);
			if (!removedBlob.ok) {
				failed.push({ intentId: intent.intentId, error: removedBlob.error });
				continue;
			}
			rolledBack.push(intent.intentId);
		}
		return { ok: true, value: { recovered, rolledBack, failed } };
	}
}
