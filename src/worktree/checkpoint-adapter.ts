/** Artifact-backed WorkspaceCheckpointPort；只执行物理 Git/FS，不激活 logical leaf。 */

import { resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../runtime/protocol/v3/capability.ts";
import { createRuntimeId, type CommandId } from "../runtime/protocol/v3/ids.ts";
import type { WorkspaceExecutionEnvelope } from "../runtime/protocol/v3/workspace.ts";
import {
	isCompositeCheckpoint,
	isWorkspaceSnapshotManifest,
} from "../runtime/artifacts/episode-manifest.ts";
import type {
	ArtifactError,
	ArtifactReadResult,
	ArtifactResult,
	CompositeCheckpoint,
	CompositeCheckpointRef,
	WorkspaceCheckpointPort,
	WorkspaceCleanupReceipt,
	WorkspaceRewindReceipt,
	WorkspaceSnapshotManifest,
} from "../runtime/artifacts/types.ts";
import { parseWorkspaceSnapshotRestoreIndex, type WorkspaceSnapshotRestoreIndex } from "./artifact-snapshot.ts";
import { GitOperations } from "./git-operations.ts";
import { pathWithin } from "./paths.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorktreeArtifactPort,
	WorktreeCheckpointArtifactResolverPort,
	WorktreeCheckpointEffectIntent,
	WorktreeCheckpointEffectPort,
	WorktreeCheckpointEffectReceipt,
	WorktreeCheckpointEffectRecord,
	WorktreeContentPort,
	WorktreeFileSystemPort,
} from "./ports.ts";
import { WorktreeRegistry } from "./registry.ts";
import type { WorktreeRecord, WorktreeRegistryEntry } from "./types.ts";

interface LoadedWorkspaceCheckpoint {
	composite: CompositeCheckpoint;
	manifest: WorkspaceSnapshotManifest;
	restoreIndex: WorkspaceSnapshotRestoreIndex;
	stagedPatch: string;
	unstagedPatch: string;
	contentByArtifactId: ReadonlyMap<ArtifactRef["artifactId"], Uint8Array>;
}

export interface ArtifactWorkspaceCheckpointOptions {
	managedRoot: string;
	filesystem: WorktreeFileSystemPort;
	content: WorktreeContentPort;
	git: GitOperations;
	registry: WorktreeRegistry;
	leases: WorkspaceLeaseMutationPort;
	artifacts: WorktreeArtifactPort;
	checkpointArtifacts: WorktreeCheckpointArtifactResolverPort;
	effects: WorktreeCheckpointEffectPort;
	clock?: () => Date;
}

function failure(code: ArtifactError["code"], message: string, retryable = false): ArtifactResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function referenceFor(read: ArtifactReadResult): ArtifactRef {
	const metadata = read.metadata;
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

function parseJson(content: Uint8Array): unknown {
	try {
		return JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function receiptBody<T extends { receiptDigest: string }>(receipt: T): Omit<T, "receiptDigest"> {
	const { receiptDigest: _digest, ...body } = receipt;
	return body;
}

function validEffectRecord(record: WorktreeCheckpointEffectRecord): boolean {
	if (record.recordDigest !== canonicalDigest({ intent: record.intent, receipt: record.receipt ?? null })) return false;
	if (!record.receipt) return true;
	return record.receipt.authorityId !== undefined &&
		record.receipt.tenantId !== undefined &&
		record.receipt.checkpointId === record.intent.checkpointId &&
		record.receipt.workspaceId === record.intent.workspaceId &&
		record.receipt.receiptDigest === canonicalDigest(receiptBody(record.receipt));
}

function effectRecord(
	intent: WorktreeCheckpointEffectIntent,
	receipt?: WorktreeCheckpointEffectReceipt,
): WorktreeCheckpointEffectRecord {
	return {
		intent,
		...(receipt ? { receipt } : {}),
		recordDigest: canonicalDigest({ intent, receipt: receipt ?? null }),
	};
}

function effectIdentity(
	operation: "rewind" | "cleanup",
	checkpoint: CompositeCheckpointRef,
	envelope: WorkspaceExecutionEnvelope,
	targetLeafId?: WorkspaceRewindReceipt["targetLeafId"],
): { effectId: CommandId; requestDigest: string } {
	const requestBody = {
		operation,
		checkpoint,
		envelopeDigest: canonicalDigest(envelope),
		expectedLeaseRevision: envelope.leaseRevision,
		...(targetLeafId ? { targetLeafId } : {}),
	};
	const requestDigest = canonicalDigest(requestBody);
	return {
		effectId: createRuntimeId("command", canonicalDigest({ requestBody, kind: "workspace_checkpoint_effect" }).slice(0, 48)),
		requestDigest,
	};
}

export class MemoryWorktreeCheckpointEffectPort implements WorktreeCheckpointEffectPort {
	readonly #records = new Map<CommandId, WorktreeCheckpointEffectRecord>();

	public async read(effectId: CommandId): Promise<WorktreeCheckpointEffectRecord | undefined> {
		const value = this.#records.get(effectId);
		return value ? structuredClone(value) : undefined;
	}

	public async begin(record: WorktreeCheckpointEffectRecord): Promise<"applied" | "replay" | "conflict"> {
		const existing = this.#records.get(record.intent.effectId);
		if (existing) return existing.recordDigest === record.recordDigest ? "replay" : "conflict";
		this.#records.set(record.intent.effectId, structuredClone(record));
		return "applied";
	}

	public async complete(
		effectId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeCheckpointEffectRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		const existing = this.#records.get(effectId);
		if (!existing || existing.intent.requestDigest !== expectedRequestDigest) return "conflict";
		if (existing.receipt) return existing.recordDigest === record.recordDigest ? "replay" : "conflict";
		if (canonicalDigest(existing.intent) !== canonicalDigest(record.intent)) return "conflict";
		this.#records.set(effectId, structuredClone(record));
		return "applied";
	}
}

export class ArtifactWorkspaceCheckpoint implements WorkspaceCheckpointPort {
	readonly #managedRoot: string;
	readonly #filesystem: WorktreeFileSystemPort;
	readonly #content: WorktreeContentPort;
	readonly #git: GitOperations;
	readonly #registry: WorktreeRegistry;
	readonly #leases: WorkspaceLeaseMutationPort;
	readonly #artifacts: WorktreeArtifactPort;
	readonly #checkpointArtifacts: WorktreeCheckpointArtifactResolverPort;
	readonly #effects: WorktreeCheckpointEffectPort;
	readonly #clock: () => Date;

	public constructor(options: ArtifactWorkspaceCheckpointOptions) {
		this.#managedRoot = resolve(options.managedRoot);
		this.#filesystem = options.filesystem;
		this.#content = options.content;
		this.#git = options.git;
		this.#registry = options.registry;
		this.#leases = options.leases;
		this.#artifacts = options.artifacts;
		this.#checkpointArtifacts = options.checkpointArtifacts;
		this.#effects = options.effects;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #appendProjection(
		operation: WorktreeRegistryEntry["operation"],
		expectedCurrent: WorktreeRecord,
		next: WorktreeRecord,
	): Promise<ArtifactResult<void>> {
		const appended = await this.#registry.appendIfCurrent(
			operation,
			next,
			canonicalDigest(expectedCurrent),
		);
		const readBack = await this.#registry.get(next.workspaceId);
		if (!readBack.ok) {
			return failure("durable_write_failed", readBack.error.message, readBack.error.retryable);
		}
		if (readBack.value && canonicalDigest(readBack.value) === canonicalDigest(next)) {
			return { ok: true, value: undefined };
		}
		if (!appended.ok) {
			return failure("durable_write_failed", appended.error.message, appended.error.retryable);
		}
		return failure("durable_write_failed", "workspace registry projection changed before exact read-back", true);
	}

	async #readExact(reference: ArtifactRef, envelope: WorkspaceExecutionEnvelope): Promise<ArtifactResult<ArtifactReadResult>> {
		const read = await this.#artifacts.read({
			authorityId: envelope.authorityId,
			tenantId: envelope.tenantId,
			artifactId: reference.artifactId,
			principalId: envelope.principalId,
			sessionId: envelope.sessionId,
			workspaceId: envelope.workspaceId,
			capability: "repository_read",
			targetSink: "filesystem",
			forensicPurpose: "physical workspace checkpoint recovery",
		});
		if (!read.ok) return read;
		if (
			canonicalDigest(referenceFor(read.value)) !== canonicalDigest(reference) ||
			read.value.metadata.redaction !== "encrypted_forensic" ||
			!read.value.metadata.encryption
		) return failure("corrupted_metadata", "workspace checkpoint Artifact reference or encryption metadata is invalid");
		return read;
	}

	async #load(
		checkpoint: CompositeCheckpointRef,
		envelope: WorkspaceExecutionEnvelope,
	): Promise<ArtifactResult<LoadedWorkspaceCheckpoint>> {
		if (
			checkpoint.authorityId !== envelope.authorityId ||
			checkpoint.tenantId !== envelope.tenantId ||
			checkpoint.workspaceId !== envelope.workspaceId ||
			checkpoint.completeness !== "complete"
		) return failure("fenced", "workspace checkpoint scope or completeness is invalid");
		const checkpointArtifact = await this.#checkpointArtifacts.resolve(checkpoint);
		if (!checkpointArtifact.ok) return checkpointArtifact;
		const checkpointRead = await this.#readExact(checkpointArtifact.value, envelope);
		if (!checkpointRead.ok) return checkpointRead;
		const compositeValue = parseJson(checkpointRead.value.content);
		if (!isCompositeCheckpoint(compositeValue)) return failure("corrupted_metadata", "CompositeCheckpoint Artifact is invalid");
		const composite = compositeValue;
		if (
			composite.checkpointId !== checkpoint.checkpointId ||
			composite.checkpointDigest !== checkpoint.checkpointDigest ||
			composite.workspace.workspaceId !== checkpoint.workspaceId ||
			composite.authorityId !== checkpoint.authorityId ||
			composite.tenantId !== checkpoint.tenantId ||
			composite.completeness !== "complete" ||
			composite.workspace.completeness !== "complete" ||
			composite.workspace.snapshotArtifactId !== composite.workspaceSnapshotManifestRef.artifactId
		) return failure("corrupted_metadata", "CompositeCheckpoint does not match its reference or complete workspace descriptor");

		const manifestRead = await this.#readExact(composite.workspaceSnapshotManifestRef, envelope);
		if (!manifestRead.ok) return manifestRead;
		const manifestValue = parseJson(manifestRead.value.content);
		if (!isWorkspaceSnapshotManifest(manifestValue)) return failure("corrupted_metadata", "WorkspaceSnapshotManifest Artifact is invalid");
		const manifest = manifestValue;
		if (
			manifest.completeness !== "complete" ||
			manifest.workspaceId !== envelope.workspaceId ||
			manifest.repositoryId !== envelope.repositoryId ||
			manifest.baseCommit !== composite.workspace.baseCommit ||
			manifest.headCommit !== composite.workspace.headCommit
		) return failure("corrupted_metadata", "WorkspaceSnapshotManifest is partial or not correlated");

		const restoreRead = await this.#readExact(manifest.rawIndexArtifact, envelope);
		if (!restoreRead.ok) return restoreRead;
		const restoreIndex = parseWorkspaceSnapshotRestoreIndex(restoreRead.value.content);
		if (
			!restoreIndex ||
			restoreIndex.checkpointId !== checkpoint.checkpointId ||
			restoreIndex.workspaceId !== envelope.workspaceId ||
			restoreIndex.headCommit !== manifest.headCommit ||
			restoreIndex.statusDigest !== composite.workspace.statusDigest
		) return failure("corrupted_metadata", "workspace restore index does not match the checkpoint");

		const contentByArtifactId = new Map<ArtifactRef["artifactId"], Uint8Array>();
		const readContent = async (reference: ArtifactRef): Promise<ArtifactResult<Uint8Array>> => {
			const existing = contentByArtifactId.get(reference.artifactId);
			if (existing) return { ok: true, value: existing };
			const read = await this.#readExact(reference, envelope);
			if (!read.ok) return read;
			contentByArtifactId.set(reference.artifactId, read.value.content);
			return { ok: true, value: read.value.content };
		};
		let stagedPatch = "";
		if (manifest.stagedDiffArtifact) {
			const read = await readContent(manifest.stagedDiffArtifact);
			if (!read.ok) return read;
			stagedPatch = Buffer.from(read.value).toString("utf8");
		}
		let unstagedPatch = "";
		if (manifest.unstagedDiffArtifact) {
			const read = await readContent(manifest.unstagedDiffArtifact);
			if (!read.ok) return read;
			unstagedPatch = Buffer.from(read.value).toString("utf8");
		}
		for (const reference of [
			...manifest.untracked.flatMap((entry) => entry.contentArtifact ? [entry.contentArtifact] : []),
			...manifest.lfsObjects.flatMap((entry) => entry.contentArtifact ? [entry.contentArtifact] : []),
		]) {
			const read = await readContent(reference);
			if (!read.ok) return read;
		}
		if (manifest.conflicts.length > 0 || manifest.submodules.some((entry) => entry.status !== "clean") || manifest.lfsObjects.some((entry) => entry.status !== "available")) {
			return failure("corrupted_metadata", "a complete workspace manifest contains non-rewindable entries");
		}
		return { ok: true, value: { composite, manifest, restoreIndex, stagedPatch, unstagedPatch, contentByArtifactId } };
	}

	async #recordFor(
		envelope: WorkspaceExecutionEnvelope,
		allowCleanupResume: boolean,
	): Promise<ArtifactResult<{ record: WorktreeRecord; cleanupResume: boolean }>> {
		const registered = await this.#registry.get(envelope.workspaceId);
		if (!registered.ok) return failure("durable_write_failed", registered.error.message, registered.error.retryable);
		const record = registered.value;
		if (!record || record.bindingKind === "source" || record.state === "removed" || record.state === "failed") {
			return failure("fenced", "managed workspace record is unavailable");
		}
		if (record.state !== "active" && !(allowCleanupResume && record.state === "removing")) {
			return failure("fenced", "workspace is not active or reconciling cleanup");
		}
		if (
			record.authorityId !== envelope.authorityId || record.tenantId !== envelope.tenantId ||
			record.principalId !== envelope.principalId || record.sessionId !== envelope.sessionId ||
			record.repositoryId !== envelope.repositoryId || record.ownerRuntimeId !== envelope.ownerRuntimeId ||
			record.leaseRevision !== envelope.leaseRevision || record.baseCommit !== envelope.baseCommit ||
			record.branch !== envelope.branch || record.worktreePath !== resolve(envelope.worktreePath) ||
			record.effectiveCwd !== resolve(envelope.cwd)
		) return failure("fenced", "workspace envelope does not match the durable binding");
		const secret = await this.#leases.read(envelope.workspaceId);
		const cleanupResume = allowCleanupResume && (record.state === "removing" || secret?.record.state === "revoked");
		if (
			!secret || secret.record.ownerRuntimeId !== envelope.ownerRuntimeId ||
			secret.record.leaseRevision !== envelope.leaseRevision || secret.fencingToken !== envelope.fencingToken ||
			canonicalDigest(envelope.fencingToken) !== secret.record.fencingTokenDigest ||
			(cleanupResume ? secret.record.state !== "revoked" : secret.record.state !== "active")
		) return failure("fenced", "workspace lease or fencing token is stale");
		return { ok: true, value: { record, cleanupResume } };
	}

	async #canonicalWorkspace(record: WorktreeRecord): Promise<ArtifactResult<string>> {
		try {
			const managedRoot = resolve(await this.#filesystem.realpath(this.#managedRoot));
			const workspace = resolve(await this.#filesystem.realpath(record.worktreePath));
			const cwd = resolve(await this.#filesystem.realpath(record.effectiveCwd));
			const sourceRepo = resolve(await this.#filesystem.realpath(record.sourceRepo));
			if (
				workspace !== record.worktreePath || cwd !== record.effectiveCwd || sourceRepo !== record.sourceRepo ||
				!pathWithin(managedRoot, workspace) || workspace === managedRoot || workspace === sourceRepo ||
				!pathWithin(workspace, cwd)
			) return failure("fenced", "workspace canonical path validation failed");
			const inspected = await this.#git.inspectRepository(cwd);
			if (!inspected.ok || resolve(inspected.value.root) !== workspace || inspected.value.branch !== record.branch) {
				return failure("fenced", "workspace Git identity changed");
			}
			return { ok: true, value: workspace };
		} catch {
			return failure("fenced", "workspace canonical path is unavailable");
		}
	}

	async #startEffect(
		operation: "rewind" | "cleanup",
		checkpoint: CompositeCheckpointRef,
		envelope: WorkspaceExecutionEnvelope,
		targetLeafId?: WorkspaceRewindReceipt["targetLeafId"],
	): Promise<ArtifactResult<{ intent: WorktreeCheckpointEffectIntent; terminal?: WorktreeCheckpointEffectReceipt }>> {
		const identity = effectIdentity(operation, checkpoint, envelope, targetLeafId);
		let existing: WorktreeCheckpointEffectRecord | undefined;
		try {
			existing = await this.#effects.read(identity.effectId);
		} catch {
			return failure("durable_write_failed", "workspace checkpoint effect journal is unavailable", true);
		}
		if (existing) {
			if (!validEffectRecord(existing) || existing.intent.requestDigest !== identity.requestDigest || existing.intent.operation !== operation) {
				return failure("corrupted_metadata", "workspace checkpoint effect journal correlation failed");
			}
			return { ok: true, value: { intent: existing.intent, ...(existing.receipt ? { terminal: existing.receipt } : {}) } };
		}
		const intent: WorktreeCheckpointEffectIntent = {
			effectId: identity.effectId,
			operation,
			requestDigest: identity.requestDigest,
			checkpointId: checkpoint.checkpointId,
			workspaceId: checkpoint.workspaceId,
			createdAt: this.#clock().toISOString(),
		};
		try {
			const begun = await this.#effects.begin(effectRecord(intent));
			return begun === "conflict"
				? failure("fenced", "workspace checkpoint effect id collided")
				: { ok: true, value: { intent } };
		} catch {
			return failure("durable_write_failed", "workspace checkpoint intent could not be persisted", true);
		}
	}

	async #completeEffect<T extends WorktreeCheckpointEffectReceipt>(
		intent: WorktreeCheckpointEffectIntent,
		receipt: T,
	): Promise<ArtifactResult<T>> {
		try {
			const completed = await this.#effects.complete(intent.effectId, intent.requestDigest, effectRecord(intent, receipt));
			return completed === "conflict"
				? failure("durable_write_failed", "workspace checkpoint terminal receipt CAS failed", true)
				: { ok: true, value: receipt };
		} catch {
			return failure("durable_write_failed", "workspace checkpoint terminal receipt is not durable", true);
		}
	}

	#pathFor(index: WorkspaceSnapshotRestoreIndex, digest: string): string | undefined {
		return index.paths.find((entry) => entry.pathDigest === digest)?.path;
	}

	async #restore(workspace: string, loaded: LoadedWorkspaceCheckpoint): Promise<ArtifactResult<void>> {
		const reset = await this.#git.resetHard(workspace, loaded.manifest.headCommit);
		if (!reset.ok) return failure("durable_write_failed", "workspace Git reset failed", true);
		const cleaned = await this.#git.cleanAllUntracked(workspace);
		if (!cleaned.ok) return failure("durable_write_failed", "workspace untracked cleanup failed", true);
		const staged = await this.#git.applyPatch(workspace, loaded.stagedPatch, true);
		if (!staged.ok) return failure("durable_write_failed", "workspace staged patch restore failed", true);
		const unstaged = await this.#git.applyPatch(workspace, loaded.unstagedPatch, false);
		if (!unstaged.ok) return failure("durable_write_failed", "workspace unstaged patch restore failed", true);
		for (const entry of loaded.manifest.untracked) {
			const path = this.#pathFor(loaded.restoreIndex, entry.pathDigest);
			if (!path) return failure("corrupted_metadata", "untracked snapshot path mapping is missing");
			if (entry.kind === "symlink") {
				if (entry.symlinkTarget === undefined) return failure("corrupted_metadata", "untracked symlink target is missing");
				const restored = await this.#content.replace(workspace, path, { kind: "symlink", mode: "120000", target: entry.symlinkTarget });
				if (!restored.ok) return failure("durable_write_failed", restored.error.message, restored.error.retryable);
				continue;
			}
			if (!entry.contentArtifact) return failure("corrupted_metadata", "untracked file content Artifact is missing");
			const content = loaded.contentByArtifactId.get(entry.contentArtifact.artifactId);
			if (!content) return failure("corrupted_metadata", "untracked file content was not loaded");
			const restored = await this.#content.replace(workspace, path, { kind: "regular", mode: entry.mode, content });
			if (!restored.ok) return failure("durable_write_failed", restored.error.message, restored.error.retryable);
		}
		for (const entry of loaded.manifest.lfsObjects) {
			if (entry.status !== "available" || !entry.contentArtifact) return failure("corrupted_metadata", "LFS snapshot is not physically restorable");
			const path = this.#pathFor(loaded.restoreIndex, entry.pathDigest);
			const content = loaded.contentByArtifactId.get(entry.contentArtifact.artifactId);
			const tracked = loaded.manifest.tracked.find((candidate) => candidate.pathDigest === entry.pathDigest);
			if (!path || !content || !tracked || (tracked.kind !== "regular" && tracked.kind !== "executable")) {
				return failure("corrupted_metadata", "LFS snapshot path, content, or mode is invalid");
			}
			const restored = await this.#content.replace(workspace, path, { kind: "regular", mode: tracked.mode, content });
			if (!restored.ok) return failure("durable_write_failed", restored.error.message, restored.error.retryable);
		}
		const status = await this.#git.status(workspace, loaded.manifest.baseCommit);
		if (!status.ok) return failure("durable_write_failed", "restored workspace status could not be verified", true);
		if (
			status.value.headCommit !== loaded.restoreIndex.headCommit ||
			status.value.status !== loaded.restoreIndex.status ||
			canonicalDigest(status.value) !== loaded.restoreIndex.statusDigest
		) return failure("digest_mismatch", "restored workspace does not match the captured status digest");
		return { ok: true, value: undefined };
	}

	public async rewind(request: {
		checkpoint: CompositeCheckpointRef;
		envelope: WorkspaceExecutionEnvelope;
		expectedLeaseRevision: number;
		targetLeafId: WorkspaceRewindReceipt["targetLeafId"];
	}): Promise<ArtifactResult<WorkspaceRewindReceipt>> {
		if (request.expectedLeaseRevision !== request.envelope.leaseRevision) return failure("fenced", "workspace rewind lease revision is stale");
		const loaded = await this.#load(request.checkpoint, request.envelope);
		if (!loaded.ok) return loaded;
		const effect = await this.#startEffect("rewind", request.checkpoint, request.envelope, request.targetLeafId);
		if (!effect.ok) return effect;
		if (effect.value.terminal) {
			return "targetLeafId" in effect.value.terminal
				? { ok: true, value: effect.value.terminal }
				: failure("corrupted_metadata", "rewind effect contains a cleanup receipt");
		}
		const registered = await this.#recordFor(request.envelope, false);
		if (!registered.ok) return registered;
		if (
			loaded.value.composite.workspace.baseCommit !== registered.value.record.baseCommit ||
			loaded.value.manifest.repositoryId !== registered.value.record.repositoryId
		) return failure("fenced", "rewind checkpoint does not belong to the durable workspace binding");
		const workspace = await this.#canonicalWorkspace(registered.value.record);
		if (!workspace.ok) return workspace;
		const restored = await this.#restore(workspace.value, loaded.value);
		if (!restored.ok) return restored;
		const rewoundRecord: WorktreeRecord = {
			...registered.value.record,
			headCommit: loaded.value.manifest.headCommit,
			lastCheckpoint: loaded.value.composite.workspace,
			lastAccessedAt: this.#clock().toISOString(),
		};
		const persisted = await this.#appendProjection("upsert", registered.value.record, rewoundRecord);
		if (!persisted.ok) return persisted;
		const body = {
			authorityId: request.checkpoint.authorityId,
			tenantId: request.checkpoint.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ effectId: effect.value.intent.effectId, outcome: "applied" }).slice(0, 48)),
			checkpointId: request.checkpoint.checkpointId,
			workspaceId: request.checkpoint.workspaceId,
			expectedLeaseRevision: request.expectedLeaseRevision,
			targetLeafId: request.targetLeafId,
			outcome: "applied" as const,
		};
		return this.#completeEffect(effect.value.intent, { ...body, receiptDigest: canonicalDigest(body) });
	}

	public async cleanup(request: {
		checkpoint: CompositeCheckpointRef;
		envelope: WorkspaceExecutionEnvelope;
		expectedLeaseRevision: number;
	}): Promise<ArtifactResult<WorkspaceCleanupReceipt>> {
		if (request.expectedLeaseRevision !== request.envelope.leaseRevision) return failure("fenced", "workspace cleanup lease revision is stale");
		const loaded = await this.#load(request.checkpoint, request.envelope);
		if (!loaded.ok) return loaded;
		const effect = await this.#startEffect("cleanup", request.checkpoint, request.envelope);
		if (!effect.ok) return effect;
		if (effect.value.terminal) {
			return "state" in effect.value.terminal
				? { ok: true, value: effect.value.terminal }
				: failure("corrupted_metadata", "cleanup effect contains a rewind receipt");
		}

		const latest = await this.#registry.get(request.envelope.workspaceId);
		if (!latest.ok) return failure("durable_write_failed", latest.error.message, latest.error.retryable);
		if (latest.value?.state === "removed") {
			const remaining = await this.#filesystem.stat(latest.value.worktreePath);
			const lease = await this.#leases.read(latest.value.workspaceId);
			if (remaining.exists || lease) return failure("corrupted_metadata", "removed workspace still has physical or lease state");
			const receipt = this.#cleanupReceipt(effect.value.intent, request, "completed");
			return this.#completeEffect(effect.value.intent, receipt);
		}

		const registered = await this.#recordFor(request.envelope, true);
		if (!registered.ok) return registered;
		if (
			loaded.value.composite.workspace.baseCommit !== registered.value.record.baseCommit ||
			loaded.value.composite.workspace.headCommit !== registered.value.record.headCommit ||
			loaded.value.manifest.repositoryId !== registered.value.record.repositoryId
		) return failure("fenced", "cleanup checkpoint is stale for the durable workspace binding");
		if (registered.value.cleanupResume) {
			const stats = await this.#filesystem.stat(registered.value.record.worktreePath);
			if (!stats.exists) {
				const stillRegistered = await this.#git.isRegistered(registered.value.record.sourceRepo, registered.value.record.worktreePath);
				if (!stillRegistered.ok) return failure("durable_write_failed", "workspace Git registration is unavailable", true);
				if (stillRegistered.value) return failure("corrupted_metadata", "missing worktree path remains registered in Git");
				const currentLease = await this.#leases.read(request.envelope.workspaceId);
				if (!currentLease) return failure("fenced", "workspace cleanup lease disappeared during reconciliation");
				const removedLease = await this.#leases.remove(
					request.envelope.workspaceId,
					request.expectedLeaseRevision,
					canonicalDigest(currentLease),
				);
				if (removedLease !== "applied") return failure("fenced", "workspace cleanup lease changed during reconciliation");
				const { lease: _lease, ...withoutLease } = registered.value.record;
				const tombstoneRecord: WorktreeRecord = {
					...withoutLease,
					state: "removed",
					lastAccessedAt: this.#clock().toISOString(),
				};
				const tombstone = await this.#appendProjection("remove", registered.value.record, tombstoneRecord);
				if (!tombstone.ok) return tombstone;
				return this.#completeEffect(effect.value.intent, this.#cleanupReceipt(effect.value.intent, request, "completed"));
			}
		}
		const workspace = await this.#canonicalWorkspace(registered.value.record);
		if (!workspace.ok) return workspace;
		const status = await this.#git.status(workspace.value, registered.value.record.baseCommit);
		if (!status.ok) return failure("durable_write_failed", "workspace cleanup status is unavailable", true);
		if (
			status.value.headCommit !== loaded.value.composite.workspace.headCommit ||
			status.value.status !== loaded.value.restoreIndex.status ||
			canonicalDigest(status.value) !== loaded.value.composite.workspace.statusDigest
		) return failure("fenced", "workspace changed after the cleanup checkpoint");

		let revoked = await this.#leases.read(request.envelope.workspaceId);
		if (!registered.value.cleanupResume) {
			if (!revoked) return failure("fenced", "workspace cleanup lease disappeared");
			const expectedSecretDigest = canonicalDigest(revoked);
			revoked = { ...revoked, record: { ...revoked.record, state: "revoked" as const }, lastRenewedAt: this.#clock().toISOString() };
			if (await this.#leases.compareAndSwap(
				request.envelope.workspaceId,
				request.expectedLeaseRevision,
				expectedSecretDigest,
				revoked,
			) !== "applied") {
				return failure("fenced", "workspace cleanup lost its lease CAS");
			}
		}
		if (!revoked || revoked.record.state !== "revoked") return failure("fenced", "workspace cleanup revocation state is invalid");
		let removingRecord = registered.value.record;
		if (registered.value.record.state !== "removing") {
			removingRecord = { ...registered.value.record, state: "removing", lease: revoked.record };
			const intent = await this.#appendProjection("upsert", registered.value.record, removingRecord);
			if (!intent.ok) return intent;
		}

		const registeredInGit = await this.#git.isRegistered(registered.value.record.sourceRepo, workspace.value);
		if (!registeredInGit.ok) return failure("durable_write_failed", "workspace Git registration is unavailable", true);
		if (!registeredInGit.value) return failure("corrupted_metadata", "workspace path exists but Git registration is missing");
		const removed = await this.#git.removeWorktree(registered.value.record.sourceRepo, workspace.value, true);
		if (!removed.ok) return failure("durable_write_failed", "physical worktree cleanup failed", true);
		const remaining = await this.#filesystem.stat(workspace.value);
		if (remaining.exists) return failure("durable_write_failed", "Git removed the worktree registration but the path remains", true);
		const leaseRemoved = await this.#leases.remove(
			request.envelope.workspaceId,
			request.expectedLeaseRevision,
			canonicalDigest(revoked),
		);
		if (leaseRemoved !== "applied") return failure("fenced", "workspace cleanup lease changed after physical removal");
		const { lease: _lease, ...withoutLease } = removingRecord;
		const tombstoneRecord: WorktreeRecord = {
			...withoutLease,
			state: "removed",
			lastAccessedAt: this.#clock().toISOString(),
		};
		const tombstone = await this.#appendProjection("remove", removingRecord, tombstoneRecord);
		if (!tombstone.ok) return tombstone;
		return this.#completeEffect(effect.value.intent, this.#cleanupReceipt(effect.value.intent, request, "completed"));
	}

	#cleanupReceipt(
		intent: WorktreeCheckpointEffectIntent,
		request: Parameters<WorkspaceCheckpointPort["cleanup"]>[0],
		state: WorkspaceCleanupReceipt["state"],
	): WorkspaceCleanupReceipt {
		const body = {
			authorityId: request.checkpoint.authorityId,
			tenantId: request.checkpoint.tenantId,
			receiptId: createRuntimeId("receipt", canonicalDigest({ effectId: intent.effectId, state }).slice(0, 48)),
			checkpointId: request.checkpoint.checkpointId,
			workspaceId: request.checkpoint.workspaceId,
			expectedLeaseRevision: request.expectedLeaseRevision,
			state,
		};
		return { ...body, receiptDigest: canonicalDigest(body) };
	}
}
