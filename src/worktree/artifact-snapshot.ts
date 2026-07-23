/** Git workspace 状态到加密 Artifact CAS 的可恢复快照。 */

import { createHash } from "node:crypto";
import { canonicalDigest, canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId, type ArtifactId, type CheckpointId } from "../runtime/protocol/v3/ids.ts";
import type { ArtifactRef } from "../runtime/protocol/v3/capability.ts";
import type { ArtifactAccessService } from "../runtime/artifacts/access.ts";
import type { ArtifactRepository } from "../runtime/artifacts/cas-store.ts";
import { createWorkspaceSnapshotManifest } from "../runtime/artifacts/episode-manifest.ts";
import type {
	ArtifactMetadata,
	ArtifactWriteRequest,
	WorkspaceConflictEntry,
	WorkspaceLfsEntry,
	WorkspaceSnapshotExclusion,
	WorkspaceSnapshotManifest,
	WorkspaceSubmoduleEntry,
	WorkspaceTrackedEntry,
} from "../runtime/artifacts/types.ts";
import { GitOperations, type GitWorkspaceSnapshot } from "./git-operations.ts";
import type {
	WorktreeArtifactPort,
	WorktreeContentEntry,
	WorktreeContentPort,
	WorktreeForensicAuthorization,
	WorktreeForensicAuthorizationPort,
	WorktreeSnapshotCaptureRequest,
	WorktreeSnapshotPort,
} from "./ports.ts";
import type { WorktreeRecord, WorktreeResult } from "./types.ts";

interface GitIndexEntry {
	mode: string;
	objectId: string;
	stage: number;
	path: string;
}

interface GitHeadEntry {
	mode: string;
	objectId: string;
	path: string;
}

export interface WorkspaceSnapshotRestorePath {
	pathDigest: string;
	path: string;
}

export interface WorkspaceSnapshotRestoreIndex {
	schemaVersion: 1;
	checkpointId: CheckpointId;
	workspaceId: WorktreeRecord["workspaceId"];
	headCommit: string;
	status: string;
	statusDigest: string;
	rawIndex: string;
	paths: readonly WorkspaceSnapshotRestorePath[];
	indexDigest: string;
}

export interface ArtifactWorkspaceSnapshotOptions {
	repository: ArtifactRepository;
	access: ArtifactAccessService;
	git: GitOperations;
	content: WorktreeContentPort;
	authorization: WorktreeForensicAuthorizationPort;
	maxEntryBytes?: number;
	maxSnapshotBytes?: number;
}

function failure(message: string, retryable = false): WorktreeResult<never> {
	return { ok: false, error: { code: "checkpoint_failed", message, retryable } };
}

function artifactFailure(message: string, retryable = false): WorktreeResult<never> {
	return { ok: false, error: { code: "checkpoint_failed", message, retryable } };
}

function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? Buffer.from(value, "utf8") : Uint8Array.from(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return Buffer.from(left).equals(Buffer.from(right));
}

function contentDigest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function pathDigest(path: string): string {
	return canonicalDigest(path);
}

function snapshotArtifactId(checkpointId: CheckpointId, role: string): ArtifactId {
	return createRuntimeId("artifact", canonicalDigest({ checkpointId, role }).slice(0, 48));
}

function snapshotIntentId(checkpointId: CheckpointId, role: string) {
	return createRuntimeId("command", canonicalDigest({ checkpointId, role, operation: "workspace_snapshot" }).slice(0, 48));
}

export function workspaceSnapshotManifestArtifactId(checkpointId: CheckpointId): ArtifactId {
	return snapshotArtifactId(checkpointId, "manifest");
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

function parseIndexEntries(raw: string): readonly GitIndexEntry[] | undefined {
	const result: GitIndexEntry[] = [];
	for (const record of raw.split("\0")) {
		if (record.length === 0) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) return undefined;
		const header = record.slice(0, tab).split(" ");
		const mode = header[0];
		const objectId = header[1];
		const stage = Number(header[2]);
		const path = record.slice(tab + 1);
		if (!mode || !objectId || !Number.isInteger(stage) || stage < 0 || stage > 3 || path.length === 0) return undefined;
		result.push({ mode, objectId, stage, path });
	}
	return result;
}

function parseHeadEntries(raw: string): readonly GitHeadEntry[] | undefined {
	const result: GitHeadEntry[] = [];
	for (const record of raw.split("\0")) {
		if (record.length === 0) continue;
		const tab = record.indexOf("\t");
		if (tab < 0) return undefined;
		const header = record.slice(0, tab).split(" ");
		const mode = header[0];
		const objectId = header[2];
		const path = record.slice(tab + 1);
		if (!mode || !objectId || path.length === 0) return undefined;
		result.push({ mode, objectId, path });
	}
	return result;
}

function parseChangedEntries(raw: string): ReadonlyMap<string, WorkspaceTrackedEntry["status"]> | undefined {
	const fields = raw.split("\0");
	const statuses = new Map<string, WorkspaceTrackedEntry["status"]>();
	for (let index = 0; index < fields.length;) {
		const code = fields[index++];
		if (!code) break;
		const kind = code[0];
		const firstPath = fields[index++];
		if (!firstPath) return undefined;
		if (kind === "R" || kind === "C") {
			const nextPath = fields[index++];
			if (!nextPath) return undefined;
			statuses.set(firstPath, kind === "R" ? "deleted" : "unchanged");
			statuses.set(nextPath, "added");
			continue;
		}
		const status = kind === "A" ? "added"
			: kind === "D" ? "deleted"
				: kind === "T" ? "type_changed"
					: "modified";
		statuses.set(firstPath, status);
	}
	return statuses;
}

function kindForMode(mode: string): WorkspaceTrackedEntry["kind"] | undefined {
	if (mode === "100644") return "regular";
	if (mode === "100755") return "executable";
	if (mode === "120000") return "symlink";
	if (mode === "160000") return "submodule";
	return undefined;
}

function parseSubmoduleStatus(raw: string): ReadonlyMap<string, WorkspaceSubmoduleEntry["status"]> {
	const result = new Map<string, WorkspaceSubmoduleEntry["status"]>();
	for (const line of raw.split(/\r?\n/u)) {
		if (line.length < 42) continue;
		const marker = line[0];
		const tail = line.slice(42);
		const path = tail.includes(" (") ? tail.slice(0, tail.indexOf(" (")) : tail;
		if (!path) continue;
		result.set(path, marker === " " ? "clean" : marker === "-" ? "missing" : "dirty");
	}
	return result;
}

function restoreIndexBody(value: WorkspaceSnapshotRestoreIndex): Omit<WorkspaceSnapshotRestoreIndex, "indexDigest"> {
	const { indexDigest: _digest, ...body } = value;
	return body;
}

export function parseWorkspaceSnapshotRestoreIndex(content: Uint8Array): WorkspaceSnapshotRestoreIndex | undefined {
	try {
		const parsed = JSON.parse(Buffer.from(content).toString("utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record = parsed as Record<string, unknown>;
		const expectedKeys = ["checkpointId", "headCommit", "indexDigest", "paths", "rawIndex", "schemaVersion", "status", "statusDigest", "workspaceId"];
		if (Object.keys(record).sort().join("\0") !== expectedKeys.join("\0")) return undefined;
		if (
			record.schemaVersion !== 1 ||
			!isRuntimeId(record.checkpointId, "checkpoint") ||
			!isRuntimeId(record.workspaceId, "workspace") ||
			typeof record.headCommit !== "string" || record.headCommit.length === 0 ||
			typeof record.status !== "string" ||
			typeof record.statusDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.statusDigest) ||
			typeof record.rawIndex !== "string" ||
			typeof record.indexDigest !== "string" || !/^[a-f0-9]{64}$/u.test(record.indexDigest) ||
			!Array.isArray(record.paths)
		) return undefined;
		const paths: WorkspaceSnapshotRestorePath[] = [];
		for (const value of record.paths) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
			const entry = value as Record<string, unknown>;
			if (
				Object.keys(entry).sort().join("\0") !== "path\0pathDigest" ||
				typeof entry.path !== "string" || entry.path.length === 0 ||
				typeof entry.pathDigest !== "string" || entry.pathDigest !== pathDigest(entry.path)
			) return undefined;
			paths.push({ path: entry.path, pathDigest: entry.pathDigest });
		}
		if (new Set(paths.map((entry) => entry.path)).size !== paths.length) return undefined;
		const value = record as unknown as WorkspaceSnapshotRestoreIndex;
		return value.indexDigest === canonicalDigest(restoreIndexBody(value)) ? value : undefined;
	} catch {
		return undefined;
	}
}

export class RepositoryWorktreeArtifactPort implements WorktreeArtifactPort {
	readonly #repository: ArtifactRepository;
	readonly #access: ArtifactAccessService;

	public constructor(repository: ArtifactRepository, access: ArtifactAccessService) {
		this.#repository = repository;
		this.#access = access;
	}

	public reconcile(scope: Parameters<ArtifactRepository["reconcile"]>[0]) {
		return this.#repository.reconcile(scope);
	}

	public write(request: ArtifactWriteRequest) {
		return this.#repository.write(request);
	}

	public read(request: Parameters<ArtifactAccessService["read"]>[0]) {
		return this.#access.read(request);
	}
}

export class ArtifactWorkspaceSnapshot implements WorktreeSnapshotPort {
	readonly #artifacts: WorktreeArtifactPort;
	readonly #git: GitOperations;
	readonly #content: WorktreeContentPort;
	readonly #authorization: WorktreeForensicAuthorizationPort;
	readonly #maxEntryBytes: number;
	readonly #maxSnapshotBytes: number;

	public constructor(options: ArtifactWorkspaceSnapshotOptions) {
		this.#artifacts = new RepositoryWorktreeArtifactPort(options.repository, options.access);
		this.#git = options.git;
		this.#content = options.content;
		this.#authorization = options.authorization;
		this.#maxEntryBytes = options.maxEntryBytes ?? 16 * 1024 * 1024;
		this.#maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
	}

	async #writeExact(
		request: WorktreeSnapshotCaptureRequest,
		authorization: WorktreeForensicAuthorization,
		role: string,
		content: string | Uint8Array,
		mediaType: string,
		references: readonly ArtifactId[] = [],
	): Promise<WorktreeResult<ArtifactRef>> {
		const artifactId = snapshotArtifactId(request.checkpointId, role);
		const original = bytes(content);
		const readRequest = {
			authorityId: request.record.authorityId,
			tenantId: request.record.tenantId,
			artifactId,
			principalId: request.record.principalId,
			sessionId: request.record.sessionId,
			workspaceId: request.record.workspaceId,
			capability: "repository_read" as const,
			forensicPurpose: authorization.purpose,
		};
		const existing = await this.#artifacts.read(readRequest);
		if (existing.ok) {
			if (
				existing.value.metadata.redaction !== "encrypted_forensic" ||
				!existing.value.metadata.encryption ||
				!sameBytes(existing.value.content, original)
			) return artifactFailure(`existing ${role} Artifact does not match the exact encrypted snapshot`);
			return { ok: true, value: referenceFor(existing.value.metadata) };
		}
		if (existing.error.code !== "not_found") {
			return artifactFailure(`existing ${role} Artifact could not be revalidated: ${existing.error.code}`, existing.error.retryable);
		}
		const written = await this.#artifacts.write({
			authorityId: request.record.authorityId,
			tenantId: request.record.tenantId,
			artifactId,
			intentId: snapshotIntentId(request.checkpointId, role),
			principalId: request.record.principalId,
			source: {
				sessionId: request.record.sessionId,
				workspaceId: request.record.workspaceId,
				producerId: request.record.principalId,
			},
			kind: role === "manifest" ? "session_report" : "diff",
			mediaType,
			content: original,
			references,
			redaction: "forensic",
			forensicAuthorization: authorization,
			lineage: { origin: "internal", inputSources: [], declassificationReceipts: [] },
			createdAt: request.capturedAt,
		});
		if (!written.ok) return artifactFailure(`${role} Artifact write failed: ${written.error.code}`, written.error.retryable);
		if (
			written.value.state !== "committed" ||
			!written.value.reference ||
			written.value.reference.redaction !== "encrypted_forensic" ||
			!written.value.metadata.encryption
		) return artifactFailure(`${role} Artifact was not durably committed with forensic encryption`, true);
		return { ok: true, value: written.value.reference };
	}

	async #readGitBlob(
		request: WorktreeSnapshotCaptureRequest,
		authorization: WorktreeForensicAuthorization,
		role: string,
		objectId: string,
	): Promise<WorktreeResult<ArtifactRef>> {
		const blob = await this.#git.readBlob(request.record.worktreePath, objectId);
		if (!blob.ok) return blob;
		return this.#writeExact(request, authorization, role, blob.value, "application/octet-stream");
	}

	public async capture(request: WorktreeSnapshotCaptureRequest): Promise<WorktreeResult<{ snapshotArtifactId: ArtifactId; completeness: "complete" | "partial" }>> {
		if (
			request.record.bindingKind === "source" ||
			request.record.workspaceId !== request.record.lease?.workspaceId ||
			request.status.headCommit.length === 0
		) return failure("workspace snapshot requires a leased non-source binding");
		const authorization = await this.#authorization.authorizeCapture(request);
		if (!authorization.ok) return authorization;
		if (authorization.value.purpose.trim().length === 0) return failure("forensic capture authorization has no purpose");
		const reconciled = await this.#artifacts.reconcile({ authorityId: request.record.authorityId, tenantId: request.record.tenantId });
		if (!reconciled.ok || reconciled.value.failed.length > 0 || reconciled.value.rolledBack.length > 0) {
			return failure("Artifact reconciliation did not establish a clean capture boundary", true);
		}
		const captured = await this.#git.captureWorkspaceSnapshot(request.record.worktreePath);
		if (!captured.ok) return captured;
		const indexEntries = parseIndexEntries(captured.value.rawIndex);
		const conflictEntries = parseIndexEntries(captured.value.conflictedEntries);
		const headEntries = parseHeadEntries(captured.value.headEntries);
		const changed = parseChangedEntries(captured.value.changedEntries);
		if (!indexEntries || !conflictEntries || !headEntries || !changed) return failure("Git snapshot metadata is not representable");

		const paths = [...new Set([
			...indexEntries.map((entry) => entry.path),
			...headEntries.map((entry) => entry.path),
			...captured.value.untrackedPaths,
			...captured.value.ignoredPaths,
		])].sort();
		const restoreBody = {
			schemaVersion: 1 as const,
			checkpointId: request.checkpointId,
			workspaceId: request.record.workspaceId,
			headCommit: request.status.headCommit,
			status: request.status.status,
			statusDigest: canonicalDigest(request.status),
			rawIndex: captured.value.rawIndex,
			paths: paths.map((path) => ({ pathDigest: pathDigest(path), path })),
		};
		const restoreIndex: WorkspaceSnapshotRestoreIndex = { ...restoreBody, indexDigest: canonicalDigest(restoreBody) };
		const restoreContent = canonicalJson(restoreIndex);
		if (Buffer.byteLength(restoreContent, "utf8") > this.#maxSnapshotBytes) return failure("workspace restore index exceeds snapshot bound");
		const rawIndexArtifact = await this.#writeExact(
			request,
			authorization.value,
			"restore-index",
			restoreContent,
			"application/vnd.runledger.workspace-index+json",
		);
		if (!rawIndexArtifact.ok) return rawIndexArtifact;

		let consumedBytes = Buffer.byteLength(restoreContent, "utf8");
		const exclusions: WorkspaceSnapshotExclusion[] = captured.value.ignoredPaths.map((path) => ({
			pathDigest: pathDigest(path),
			reason: "ignored_excluded",
			detailDigest: canonicalDigest({ path, reason: "ignored_excluded" }),
		}));
		const writeBounded = async (role: string, value: string | Uint8Array, mediaType: string): Promise<WorktreeResult<ArtifactRef | undefined>> => {
			const size = bytes(value).byteLength;
			if (size > this.#maxEntryBytes || consumedBytes + size > this.#maxSnapshotBytes) return { ok: true, value: undefined };
			const artifact = await this.#writeExact(request, authorization.value, role, value, mediaType);
			if (artifact.ok) consumedBytes += size;
			return artifact;
		};

		const stagedDiffArtifact = captured.value.stagedDiff.length > 0
			? await writeBounded("staged-diff", captured.value.stagedDiff, "application/vnd.git.binary-diff")
			: { ok: true as const, value: undefined };
		if (!stagedDiffArtifact.ok) return stagedDiffArtifact;
		if (captured.value.stagedDiff.length > 0 && !stagedDiffArtifact.value) exclusions.push({
			pathDigest: canonicalDigest("staged-diff"), reason: "size_limit", detailDigest: canonicalDigest({ role: "staged-diff", size: captured.value.stagedDiff.length }),
		});
		const unstagedDiffArtifact = captured.value.unstagedDiff.length > 0
			? await writeBounded("unstaged-diff", captured.value.unstagedDiff, "application/vnd.git.binary-diff")
			: { ok: true as const, value: undefined };
		if (!unstagedDiffArtifact.ok) return unstagedDiffArtifact;
		if (captured.value.unstagedDiff.length > 0 && !unstagedDiffArtifact.value) exclusions.push({
			pathDigest: canonicalDigest("unstaged-diff"), reason: "size_limit", detailDigest: canonicalDigest({ role: "unstaged-diff", size: captured.value.unstagedDiff.length }),
		});

		const currentByPath = new Map(indexEntries.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]));
		const headByPath = new Map(headEntries.map((entry) => [entry.path, entry]));
		const tracked: WorkspaceTrackedEntry[] = [];
		for (const path of [...new Set([...currentByPath.keys(), ...headByPath.keys()])].sort()) {
			const entry = currentByPath.get(path) ?? headByPath.get(path)!;
			const kind = kindForMode(entry.mode);
			if (!kind) {
				exclusions.push({ pathDigest: pathDigest(path), reason: "unrepresentable_entry", detailDigest: canonicalDigest({ path, mode: entry.mode }) });
				continue;
			}
			let symlinkTarget: string | undefined;
			if (kind === "symlink") {
				const blob = await this.#git.readBlob(request.record.worktreePath, entry.objectId);
				if (!blob.ok) {
					exclusions.push({ pathDigest: pathDigest(path), reason: "unrepresentable_entry", detailDigest: canonicalDigest({ path, reason: "symlink_blob_unavailable" }) });
					continue;
				}
				symlinkTarget = Buffer.from(blob.value).toString("utf8");
			}
			tracked.push({
				pathDigest: pathDigest(path),
				kind,
				mode: entry.mode,
				...(symlinkTarget === undefined ? {} : { symlinkTarget }),
				status: changed.get(path) ?? "unchanged",
			});
		}

		const untracked: WorkspaceTrackedEntry[] = [];
		for (const path of [...captured.value.untrackedPaths].sort()) {
			const read = await this.#content.read(request.record.worktreePath, path);
			if (!read.ok) {
				exclusions.push({ pathDigest: pathDigest(path), reason: "unrepresentable_entry", detailDigest: canonicalDigest({ path, error: read.error.code }) });
				continue;
			}
			if (read.value.kind === "symlink") {
				untracked.push({ pathDigest: pathDigest(path), kind: "symlink", mode: "120000", symlinkTarget: read.value.target, status: "added" });
				continue;
			}
			const artifact = await writeBounded(`untracked-${pathDigest(path)}`, read.value.content, "application/octet-stream");
			if (!artifact.ok) return artifact;
			if (!artifact.value) {
				exclusions.push({ pathDigest: pathDigest(path), reason: "size_limit", detailDigest: canonicalDigest({ path, size: read.value.content.byteLength }) });
				continue;
			}
			untracked.push({
				pathDigest: pathDigest(path),
				kind: read.value.mode === "100755" ? "executable" : "regular",
				mode: read.value.mode,
				contentArtifact: artifact.value,
				status: "added",
			});
		}

		const conflicts: WorkspaceConflictEntry[] = [];
		const conflictsByPath = new Map<string, GitIndexEntry[]>();
		for (const entry of conflictEntries) conflictsByPath.set(entry.path, [...(conflictsByPath.get(entry.path) ?? []), entry]);
		for (const [path, stages] of conflictsByPath) {
			exclusions.push({ pathDigest: pathDigest(path), reason: "unrepresentable_entry", detailDigest: canonicalDigest({ path, reason: "unmerged_index" }) });
			const refs: Partial<Record<"base" | "ours" | "theirs", ArtifactRef>> = {};
			for (const stage of stages) {
				const name = stage.stage === 1 ? "base" : stage.stage === 2 ? "ours" : stage.stage === 3 ? "theirs" : undefined;
				if (!name) continue;
				const blob = await this.#git.readBlob(request.record.worktreePath, stage.objectId);
				if (!blob.ok || blob.value.byteLength > this.#maxEntryBytes || consumedBytes + blob.value.byteLength > this.#maxSnapshotBytes) continue;
				const artifact = await this.#writeExact(request, authorization.value, `conflict-${name}-${pathDigest(path)}`, blob.value, "application/octet-stream");
				if (!artifact.ok) return artifact;
				consumedBytes += blob.value.byteLength;
				refs[name] = artifact.value;
			}
			if (refs.base || refs.ours || refs.theirs) conflicts.push({ pathDigest: pathDigest(path), ...refs });
		}

		const submoduleStates = parseSubmoduleStatus(captured.value.submoduleStatus);
		const submodules: WorkspaceSubmoduleEntry[] = indexEntries
			.filter((entry) => entry.stage === 0 && entry.mode === "160000")
			.map((entry) => ({
				pathDigest: pathDigest(entry.path),
				commit: entry.objectId,
				status: submoduleStates.get(entry.path) ?? "missing",
			}));

		const lfsCandidates = await this.#git.lfsTrackedPaths(request.record.worktreePath, [...currentByPath.keys()]);
		if (!lfsCandidates.ok) return lfsCandidates;
		const lfsObjects: WorkspaceLfsEntry[] = [];
		for (const path of lfsCandidates.value) {
			if (changed.get(path) === "deleted") continue;
			const read = await this.#content.read(request.record.worktreePath, path);
			if (!read.ok || read.value.kind !== "regular") {
				lfsObjects.push({ pathDigest: pathDigest(path), oid: `sha256:${"0".repeat(64)}`, size: 0, status: "missing" });
				continue;
			}
			const text = Buffer.from(read.value.content).toString("utf8");
			const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid (sha256:[a-f0-9]{64})\nsize (\d+)\n?$/u.exec(text);
			if (pointer) {
				lfsObjects.push({ pathDigest: pathDigest(path), oid: pointer[1]!, size: Number(pointer[2]), status: "pointer_only" });
				continue;
			}
			const artifact = await writeBounded(`lfs-${pathDigest(path)}`, read.value.content, "application/octet-stream");
			if (!artifact.ok) return artifact;
			if (!artifact.value) {
				exclusions.push({ pathDigest: pathDigest(path), reason: "size_limit", detailDigest: canonicalDigest({ path, size: read.value.content.byteLength }) });
				continue;
			}
			lfsObjects.push({
				pathDigest: pathDigest(path), oid: `sha256:${contentDigest(read.value.content)}`,
				size: read.value.content.byteLength, status: "available", contentArtifact: artifact.value,
			});
		}

		const manifestResult = createWorkspaceSnapshotManifest({
			authorityId: request.record.authorityId,
			tenantId: request.record.tenantId,
			workspaceId: request.record.workspaceId,
			repositoryId: request.record.repositoryId,
			baseCommit: request.record.baseCommit,
			headCommit: request.status.headCommit,
			rawIndexArtifact: rawIndexArtifact.value,
			...(stagedDiffArtifact.value ? { stagedDiffArtifact: stagedDiffArtifact.value } : {}),
			...(unstagedDiffArtifact.value ? { unstagedDiffArtifact: unstagedDiffArtifact.value } : {}),
			tracked,
			untracked,
			conflicts,
			submodules,
			lfsObjects,
			exclusions,
			capturedAt: request.capturedAt,
		});
		if (!manifestResult.ok) return failure(`workspace snapshot manifest is invalid: ${manifestResult.error.code}`);
		const manifest = manifestResult.value;
		const referencedIds = [
			rawIndexArtifact.value,
			...(stagedDiffArtifact.value ? [stagedDiffArtifact.value] : []),
			...(unstagedDiffArtifact.value ? [unstagedDiffArtifact.value] : []),
			...untracked.flatMap((entry) => entry.contentArtifact ? [entry.contentArtifact] : []),
			...conflicts.flatMap((entry) => [entry.base, entry.ours, entry.theirs].filter((value): value is ArtifactRef => value !== undefined)),
			...lfsObjects.flatMap((entry) => entry.contentArtifact ? [entry.contentArtifact] : []),
		].map((reference) => reference.artifactId);
		const manifestArtifact = await this.#writeExact(
			request,
			authorization.value,
			"manifest",
			canonicalJson(manifest),
			"application/vnd.runledger.workspace-snapshot+json",
			referencedIds,
		);
		if (!manifestArtifact.ok) return manifestArtifact;
		if (manifestArtifact.value.artifactId !== workspaceSnapshotManifestArtifactId(request.checkpointId)) {
			return failure("workspace snapshot manifest Artifact identity changed");
		}
		return { ok: true, value: { snapshotArtifactId: manifestArtifact.value.artifactId, completeness: manifest.completeness } };
	}
}

export function manifestFromBytes(content: Uint8Array): WorkspaceSnapshotManifest | undefined {
	try {
		return JSON.parse(Buffer.from(content).toString("utf8")) as WorkspaceSnapshotManifest;
	} catch {
		return undefined;
	}
}
