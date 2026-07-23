/** Git worktree 生命周期、session binding、lease、checkpoint 与安全删除。 */

import { dirname, join, resolve } from "node:path";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createSessionEventStreamRef,
	sameRuntimeEventStream,
} from "../runtime/protocol/v3/events.ts";
import {
	createRuntimeId,
	type RuntimeInstanceId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import {
	createWorktreeId,
	workspaceBindingDigest,
	workspaceExecutionEnvelopeDigest,
	type WorkspaceBindingRef,
	type WorkspaceCheckpointRequest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceReleaseReceiptRef,
	type WorkspaceReleaseRequest,
} from "../runtime/protocol/v3/workspace.ts";
import { GitOperations } from "./git-operations.ts";
import { buildManagedWorktreePath, pathWithin, resolveSubdirOffset, validateBranchName, validateWorktreeLabel } from "./paths.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorkspaceLeaseSecret,
	WorktreeFileSystemPort,
	WorktreeForceApprovalPort,
	WorktreeLivenessPort,
	WorktreeReleaseIntent,
	WorktreeReleaseJournalPort,
	WorktreeReleaseJournalRecord,
	WorktreeSnapshotPort,
	WorktreeTokenPort,
} from "./ports.ts";
import {
	isValidWorktreeReleaseJournalRecord,
	MemoryWorktreeReleaseJournalPort,
	WorktreeReleaseJournalCorruptionError,
	worktreeReleaseIntentDigest,
	worktreeReleaseJournalRecordDigest,
	worktreeReleaseOperationId,
} from "./release-journal.ts";
import { WorktreeRegistry } from "./registry.ts";
import type {
	PersistedWorkspaceBinding,
	SourceBindingRequest,
	WorktreeApplyPreview,
	WorktreeCheckpointResult,
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreeLeaseHandoff,
	WorktreeRecord,
	WorktreeRemovePreview,
	WorktreeRemoveRequest,
	WorktreeReleaseReplayRequest,
	WorktreeRegistryEntry,
	WorktreeResult,
	WorktreeRuntimeContext,
	WorktreeValidationResult,
} from "./types.ts";

function failure(
	code: "invalid_request" | "invalid_scope" | "outside_managed_root" | "collision" | "already_exists" |
		"not_found" | "dirty" | "unpublished" | "active" | "checkpoint_required" | "stale" |
		"checkpoint_failed" |
		"lease_conflict" | "approval_required" | "git_failed" | "registry_failed" | "cleanup_failed" | "uncertain",
	message: string,
	retryable = false,
): WorktreeResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function releaseJournalFailure(cause: unknown, message: string): WorktreeResult<never> {
	const corrupted = cause instanceof WorktreeReleaseJournalCorruptionError;
	return failure(
		"uncertain",
		corrupted ? `${message}: durable release journal is corrupted` : message,
		!corrupted,
	);
}

function workspaceIdFor(request: WorktreeCreateRequest | SourceBindingRequest): WorkspaceId {
	return createRuntimeId("workspace", canonicalDigest({
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		sessionId: request.sessionId,
		repositoryId: request.repositoryId,
		requestId: request.requestId,
	}).slice(0, 48));
}

function statusDigest(status: { status: string; headCommit: string; dirty: boolean; unpublished: boolean }): string {
	return canonicalDigest(status);
}

function persistedBinding(
	record: WorktreeRecord,
	lease: NonNullable<WorktreeRecord["lease"]>,
): PersistedWorkspaceBinding {
	const body: Omit<PersistedWorkspaceBinding, "bindingDigest"> = {
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		principalId: record.principalId,
		sessionId: record.sessionId,
		bindingKind: record.bindingKind,
		workspaceId: record.workspaceId,
		repositoryId: record.repositoryId,
		sourceRepo: record.sourceRepo,
		sourceCwd: record.sourceCwd,
		effectiveCwd: record.effectiveCwd,
		...(record.worktreeId ? { worktreeId: record.worktreeId } : {}),
		worktreePath: record.worktreePath,
		subdirOffset: record.subdirOffset,
		baseCommit: record.baseCommit,
		headCommit: record.headCommit,
		branch: record.branch,
		leaseId: lease.leaseId,
		leaseRevision: lease.leaseRevision,
		ownerRuntimeId: lease.ownerRuntimeId,
	};
	return { ...body, bindingDigest: canonicalDigest(body) };
}

function runtimeBinding(record: WorktreeRecord): WorkspaceBindingRef {
	const body = {
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		workspaceId: record.workspaceId,
		repositoryId: record.repositoryId,
		bindingKind: record.bindingKind,
		canonicalCwd: record.worktreePath,
		effectiveCwd: record.effectiveCwd,
		branch: record.branch,
		baseCommit: record.baseCommit,
		headCommit: record.headCommit,
	};
	return record.worktreeId ? { ...body, worktreeId: record.worktreeId } : body;
}

export interface WorktreeManagerOptions {
	managedRoot: string;
	filesystem: WorktreeFileSystemPort;
	git: GitOperations;
	registry: WorktreeRegistry;
	leases: WorkspaceLeaseMutationPort;
	releaseJournal?: WorktreeReleaseJournalPort;
	tokens: WorktreeTokenPort;
	liveness: WorktreeLivenessPort;
	forceApproval?: WorktreeForceApprovalPort;
	snapshots?: WorktreeSnapshotPort;
	validatorPrincipalId: WorktreeRuntimeContext["principalId"];
	clock?: () => Date;
	maxPreviewBytes?: number;
	/** control-plane state roots must never overlap a source repository. */
	protectedRoots?: readonly string[];
}

export class WorktreeManager {
	readonly #managedRoot: string;
	readonly #filesystem: WorktreeFileSystemPort;
	readonly #git: GitOperations;
	readonly #registry: WorktreeRegistry;
	readonly #leases: WorkspaceLeaseMutationPort;
	readonly #releaseJournal: WorktreeReleaseJournalPort;
	readonly #tokens: WorktreeTokenPort;
	readonly #liveness: WorktreeLivenessPort;
	readonly #forceApproval?: WorktreeForceApprovalPort;
	readonly #snapshots?: WorktreeSnapshotPort;
	readonly #validatorPrincipalId: WorktreeRuntimeContext["principalId"];
	readonly #clock: () => Date;
	readonly #maxPreviewBytes: number;
	readonly #protectedRoots: readonly string[];

	public constructor(options: WorktreeManagerOptions) {
		this.#managedRoot = resolve(options.managedRoot);
		this.#filesystem = options.filesystem;
		this.#git = options.git;
		this.#registry = options.registry;
		this.#leases = options.leases;
		this.#releaseJournal = options.releaseJournal ?? new MemoryWorktreeReleaseJournalPort();
		this.#tokens = options.tokens;
		this.#liveness = options.liveness;
		this.#forceApproval = options.forceApproval;
		this.#snapshots = options.snapshots;
		this.#validatorPrincipalId = options.validatorPrincipalId;
		this.#clock = options.clock ?? (() => new Date());
		this.#maxPreviewBytes = options.maxPreviewBytes ?? 2 * 1024 * 1024;
		this.#protectedRoots = (options.protectedRoots ?? []).map((path) => resolve(path));
	}

	#sourceRootConflicts(sourceRepo: string): boolean {
		return [this.#managedRoot, ...this.#protectedRoots].some((root) =>
			pathWithin(sourceRepo, root) || pathWithin(root, sourceRepo));
	}

	async #canonicalManagedRoot(): Promise<WorktreeResult<string>> {
		try {
			await this.#filesystem.mkdir(this.#managedRoot);
			return { ok: true, value: resolve(await this.#filesystem.realpath(this.#managedRoot)) };
		} catch {
			return failure("outside_managed_root", "managed worktree root is unavailable", true);
		}
	}

	async #source(request: WorktreeCreateRequest | SourceBindingRequest): Promise<WorktreeResult<{
		sourceRepo: string;
		sourceCwd: string;
		subdirOffset: string;
		headCommit: string;
		branch: string;
	}>> {
		try {
			const sourceRepo = resolve(await this.#filesystem.realpath(request.sourceRepo));
			const sourceCwd = resolve(await this.#filesystem.realpath(request.sourceCwd));
			const inspected = await this.#git.inspectRepository(sourceCwd);
			if (!inspected.ok) return inspected;
			const gitRoot = resolve(await this.#filesystem.realpath(inspected.value.root));
			if (gitRoot !== sourceRepo || !pathWithin(sourceRepo, sourceCwd)) return failure("invalid_request", "source repository identity does not match cwd");
			if (this.#sourceRootConflicts(sourceRepo)) return failure("outside_managed_root", "source repository overlaps managed or control-plane state roots");
			const offset = resolveSubdirOffset(sourceRepo, sourceCwd);
			if (!offset.ok) return offset;
			return { ok: true, value: { sourceRepo, sourceCwd, subdirOffset: offset.value, headCommit: inspected.value.headCommit, branch: inspected.value.branch } };
		} catch {
			return { ok: false, error: { code: "not_repository", message: "source repository cannot be canonicalized", retryable: false } };
		}
	}

	public async discoverSource(cwd: string): Promise<WorktreeResult<{ sourceRepo: string; sourceCwd: string; headCommit: string; branch: string }>> {
		try {
			const sourceCwd = resolve(await this.#filesystem.realpath(cwd));
			const inspected = await this.#git.inspectRepository(sourceCwd);
			if (!inspected.ok) return inspected;
			const sourceRepo = resolve(await this.#filesystem.realpath(inspected.value.root));
			if (!pathWithin(sourceRepo, sourceCwd)) return failure("invalid_request", "requested cwd escapes its Git repository");
			if (this.#sourceRootConflicts(sourceRepo)) return failure("outside_managed_root", "source repository overlaps managed or control-plane state roots");
			return { ok: true, value: { sourceRepo, sourceCwd, headCommit: inspected.value.headCommit, branch: inspected.value.branch } };
		} catch {
			return { ok: false, error: { code: "not_repository", message: "requested cwd cannot be canonicalized", retryable: false } };
		}
	}

	async #newLease(record: WorktreeRecord): Promise<WorktreeResult<WorkspaceLeaseSecret>> {
		let token: string;
		try {
			token = await this.#tokens.issue();
		} catch {
			return failure("lease_conflict", "fencing token issuer is unavailable", true);
		}
		if (!token || token.length > 512) return failure("lease_conflict", "fencing token issuer returned an invalid token");
		const now = this.#clock().toISOString();
		const lease = {
			authorityId: record.authorityId,
			tenantId: record.tenantId,
			principalId: record.principalId,
			leaseId: createRuntimeId("lease", canonicalDigest({ workspaceId: record.workspaceId, token }).slice(0, 48)),
			workspaceId: record.workspaceId,
			ownerRuntimeId: record.ownerRuntimeId,
			leaseRevision: record.leaseRevision,
			fencingTokenDigest: canonicalDigest(token),
			state: "active" as const,
		};
		return { ok: true, value: { record: lease, fencingToken: token, issuedAt: now, lastRenewedAt: now } };
	}

	#result(record: WorktreeRecord, secret: WorkspaceLeaseSecret): WorktreeCreateResult {
		return {
			record,
			binding: persistedBinding(record, secret.record),
			runtimeBinding: runtimeBinding(record),
			lease: secret.record,
			fencingToken: secret.fencingToken,
			receiptId: createRuntimeId("receipt", canonicalDigest({ record, lease: secret.record }).slice(0, 48)),
		};
	}

	async #appendProjection(
		operation: WorktreeRegistryEntry["operation"],
		expectedCurrent: WorktreeRecord,
		next: WorktreeRecord,
	): Promise<WorktreeResult<void>> {
		const appended = await this.#registry.appendIfCurrent(
			operation,
			next,
			canonicalDigest(expectedCurrent),
		);
		const readBack = await this.#registry.get(next.workspaceId);
		if (!readBack.ok) return readBack;
		if (readBack.value && canonicalDigest(readBack.value) === canonicalDigest(next)) {
			return { ok: true, value: undefined };
		}
		if (!appended.ok) return appended;
		return failure("uncertain", "worktree registry projection changed before exact read-back", true);
	}

	public async create(request: WorktreeCreateRequest, signal?: AbortSignal): Promise<WorktreeResult<WorktreeCreateResult>> {
		const existing = await this.#registry.findByCreateRequest(request.requestId);
		if (!existing.ok) return existing;
		if (existing.value) {
			if (existing.value.createRequestDigest !== canonicalDigest(request)) {
				return failure("invalid_request", "create request id was replayed with another payload");
			}
			const secret = await this.#leases.read(existing.value.workspaceId);
			return secret && ["ready", "active", "retained"].includes(existing.value.state)
				? { ok: true, value: this.#result(existing.value, secret) }
				: failure("stale", "existing create request has no resumable lease");
		}
		const validLabel = validateWorktreeLabel(request.label);
		if (!validLabel.ok) return validLabel;
		const source = await this.#source(request);
		if (!source.ok) return source;
		const managedRoot = await this.#canonicalManagedRoot();
		if (!managedRoot.ok) return managedRoot;
		if (pathWithin(source.value.sourceRepo, managedRoot.value) || pathWithin(managedRoot.value, source.value.sourceRepo)) {
			return failure("outside_managed_root", "managed root and source repository must not contain each other");
		}
		const workspaceId = workspaceIdFor(request);
		const target = buildManagedWorktreePath(managedRoot.value, request.repositoryId, workspaceId, validLabel.value);
		if (!target.ok) return target;
		try {
			const targetStats = await this.#filesystem.stat(target.value);
			if (targetStats.exists) return failure("collision", "managed worktree target already exists");
		} catch {
			return failure("outside_managed_root", "managed worktree target cannot be inspected", true);
		}
		const baseRef = request.baseRef ?? "HEAD";
		const baseCommit = await this.#git.resolveCommit(source.value.sourceRepo, baseRef, signal);
		if (!baseCommit.ok) return baseCommit;
		const bindingKind = request.bindingKind ?? "managed_worktree";
		const proposedBranch = request.branch ?? `runledger/${validLabel.value}-${canonicalDigest(workspaceId).slice(0, 10)}`;
		const branch = bindingKind === "readonly_checkout" ? "HEAD" : proposedBranch;
		if (bindingKind === "managed_worktree") {
			const validBranch = validateBranchName(branch);
			if (!validBranch.ok) return validBranch;
			const exists = await this.#git.branchExists(source.value.sourceRepo, branch, signal);
			if (!exists.ok) return exists;
			if (exists.value) return failure("already_exists", "worktree branch already exists");
		}
		const now = this.#clock().toISOString();
		const creating: WorktreeRecord = {
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			workspaceId, repositoryId: request.repositoryId, sessionId: request.sessionId, createRequestId: request.requestId,
			createRequestDigest: canonicalDigest(request),
			bindingKind, sourceRepo: source.value.sourceRepo, sourceCwd: source.value.sourceCwd,
			worktreeId: createWorktreeId(canonicalDigest(workspaceId).slice(0, 48)), worktreePath: target.value,
			effectiveCwd: source.value.subdirOffset === "." ? target.value : join(target.value, source.value.subdirOffset),
			subdirOffset: source.value.subdirOffset, label: validLabel.value, baseRef, baseCommit: baseCommit.value,
			headCommit: baseCommit.value, branch, state: "creating", createdAt: now, lastAccessedAt: now,
			ownerRuntimeId: request.ownerRuntimeId, leaseRevision: 1,
		};
		const claimed = await this.#registry.append("upsert", creating);
		if (!claimed.ok) return claimed;
		try {
			await this.#filesystem.mkdir(dirname(target.value));
		} catch {
			const failed = { ...creating, state: "failed" as const, errorDigest: canonicalDigest("managed parent creation failed") };
			await this.#appendProjection("upsert", creating, failed);
			return failure("cleanup_failed", "managed worktree parent cannot be created", true);
		}
		const created = bindingKind === "readonly_checkout"
			? await this.#git.createDetachedWorktree(source.value.sourceRepo, target.value, baseCommit.value, signal)
			: await this.#git.createWorktree(source.value.sourceRepo, target.value, branch, baseCommit.value, signal);
		if (!created.ok) {
			const failed = { ...creating, state: "failed" as const, errorDigest: canonicalDigest(created.error) };
			await this.#appendProjection("upsert", creating, failed);
			return created;
		}
		let canonicalWorktree: string;
		let canonicalEffectiveCwd: string;
		try {
			canonicalWorktree = resolve(await this.#filesystem.realpath(target.value));
			canonicalEffectiveCwd = resolve(await this.#filesystem.realpath(creating.effectiveCwd));
		} catch {
			await this.#git.removeWorktree(source.value.sourceRepo, target.value, true, signal);
			return failure("cleanup_failed", "created worktree could not be canonicalized", true);
		}
		if (!pathWithin(managedRoot.value, canonicalWorktree) || !pathWithin(canonicalWorktree, canonicalEffectiveCwd) || canonicalWorktree === source.value.sourceRepo) {
			await this.#git.removeWorktree(source.value.sourceRepo, canonicalWorktree, true, signal);
			return failure("outside_managed_root", "created worktree escaped its managed boundary");
		}
		const activeBase: WorktreeRecord = { ...creating, worktreePath: canonicalWorktree, effectiveCwd: canonicalEffectiveCwd, state: "active" };
		const secret = await this.#newLease(activeBase);
		if (!secret.ok) {
			await this.#git.removeWorktree(source.value.sourceRepo, canonicalWorktree, true, signal);
			return secret;
		}
		if (await this.#leases.create(secret.value) !== "applied") {
			await this.#git.removeWorktree(source.value.sourceRepo, canonicalWorktree, true, signal);
			return failure("lease_conflict", "workspace lease already exists");
		}
		const active: WorktreeRecord = { ...activeBase, lease: secret.value.record };
		const finalized = await this.#appendProjection("upsert", creating, active);
		if (!finalized.ok) {
			await this.#leases.remove(
				workspaceId,
				secret.value.record.leaseRevision,
				canonicalDigest(secret.value),
			);
			const cleanup = await this.#git.removeWorktree(source.value.sourceRepo, canonicalWorktree, true, signal);
			return cleanup.ok
				? failure("registry_failed", "worktree was rolled back after registry finalization failed", true)
				: failure("uncertain", "registry finalization and worktree rollback both failed", true);
		}
		return { ok: true, value: this.#result(active, secret.value) };
	}

	public async bindSource(request: SourceBindingRequest): Promise<WorktreeResult<WorktreeCreateResult>> {
		const existing = await this.#registry.findByCreateRequest(request.requestId);
		if (!existing.ok) return existing;
		if (existing.value) {
			if (existing.value.createRequestDigest !== canonicalDigest(request)) {
				return failure("invalid_request", "source bind request id was replayed with another payload");
			}
			const secret = await this.#leases.read(existing.value.workspaceId);
			return secret ? { ok: true, value: this.#result(existing.value, secret) } : failure("stale", "source binding lease is missing");
		}
		const source = await this.#source(request);
		if (!source.ok) return source;
		const now = this.#clock().toISOString();
		const record: WorktreeRecord = {
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			workspaceId: workspaceIdFor(request), repositoryId: request.repositoryId, sessionId: request.sessionId,
			createRequestId: request.requestId, createRequestDigest: canonicalDigest(request), bindingKind: "source",
			sourceRepo: source.value.sourceRepo, sourceCwd: source.value.sourceCwd,
			worktreePath: source.value.sourceRepo, effectiveCwd: source.value.sourceCwd, subdirOffset: source.value.subdirOffset,
			label: "source", baseRef: "HEAD", baseCommit: source.value.headCommit, headCommit: source.value.headCommit,
			branch: source.value.branch, state: "active", createdAt: now, lastAccessedAt: now,
			ownerRuntimeId: request.ownerRuntimeId, leaseRevision: 1,
		};
		const secret = await this.#newLease(record);
		if (!secret.ok) return secret;
		if (await this.#leases.create(secret.value) !== "applied") return failure("lease_conflict", "source workspace lease already exists");
		const active = { ...record, lease: secret.value.record };
		const persisted = await this.#registry.append("upsert", active);
		if (!persisted.ok) {
			await this.#leases.remove(
				record.workspaceId,
				secret.value.record.leaseRevision,
				canonicalDigest(secret.value),
			);
			return persisted;
		}
		return { ok: true, value: this.#result(active, secret.value) };
	}

	public async validate(envelope: WorkspaceExecutionEnvelope): Promise<WorktreeResult<WorktreeValidationResult>> {
		const registered = await this.#registry.get(envelope.workspaceId);
		if (!registered.ok) return registered;
		const record = registered.value;
		if (!record || !["active", "ready", "retained"].includes(record.state)) return failure("not_found", "workspace binding is unavailable");
		if (
			record.authorityId !== envelope.authorityId || record.tenantId !== envelope.tenantId || record.principalId !== envelope.principalId ||
			record.sessionId !== envelope.sessionId || record.repositoryId !== envelope.repositoryId ||
			record.ownerRuntimeId !== envelope.ownerRuntimeId || record.leaseRevision !== envelope.leaseRevision ||
			record.baseCommit !== envelope.baseCommit || record.branch !== envelope.branch
		) return failure("invalid_scope", "workspace envelope does not match its durable binding");
		const secret = await this.#leases.read(envelope.workspaceId);
		if (!secret || secret.record.state !== "active" || secret.record.ownerRuntimeId !== envelope.ownerRuntimeId ||
			secret.record.leaseRevision !== envelope.leaseRevision || canonicalDigest(envelope.fencingToken) !== secret.record.fencingTokenDigest ||
			envelope.fencingToken !== secret.fencingToken) return failure("lease_conflict", "workspace fencing token or lease is stale");
		let canonicalRoot: string;
		let canonicalCwd: string;
		try {
			canonicalRoot = resolve(await this.#filesystem.realpath(envelope.worktreePath));
			canonicalCwd = resolve(await this.#filesystem.realpath(envelope.cwd));
		} catch {
			return failure("stale", "workspace path no longer exists");
		}
		if (canonicalRoot !== record.worktreePath || canonicalCwd !== record.effectiveCwd || !pathWithin(canonicalRoot, canonicalCwd)) {
			return failure("outside_managed_root", "workspace path identity changed");
		}
		const inspected = await this.#git.inspectRepository(canonicalCwd);
		if (!inspected.ok || resolve(inspected.value.root) !== canonicalRoot || inspected.value.branch !== record.branch) {
			return failure("stale", "workspace Git identity changed");
		}
		const now = this.#clock().toISOString();
		const current: WorktreeRecord = { ...record, headCommit: inspected.value.headCommit, lastAccessedAt: now, state: "active" };
		const updated = await this.#appendProjection("upsert", record, current);
		if (!updated.ok) return updated;
		const binding = persistedBinding(current, secret.record);
		return {
			ok: true,
			value: {
				binding,
				envelope,
				validation: {
					authorityId: record.authorityId, tenantId: record.tenantId, principalId: record.principalId,
					receiptId: createRuntimeId("receipt", canonicalDigest({ envelope, now }).slice(0, 48)),
					workspaceId: record.workspaceId, envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
					validatorId: this.#validatorPrincipalId, validatedAt: now, outcome: "valid",
				},
			},
		};
	}

	public async checkpoint(request: WorkspaceCheckpointRequest): Promise<WorktreeResult<WorktreeCheckpointResult>> {
		if (request.envelopeDigest !== workspaceExecutionEnvelopeDigest(request.envelope)) return failure("invalid_request", "checkpoint envelope digest is invalid");
		const validated = await this.validate(request.envelope);
		if (!validated.ok) return validated;
		const status = await this.#git.status(request.envelope.worktreePath, request.envelope.baseCommit);
		if (!status.ok) return status;
		const checkpointId = createRuntimeId("checkpoint", canonicalDigest({ workspaceId: request.envelope.workspaceId, cursor: request.eventCursor, status: status.value }).slice(0, 48));
		const record = await this.#registry.get(request.envelope.workspaceId);
		if (!record.ok || !record.value) return failure("not_found", "workspace disappeared during checkpoint");
		const capturedAt = this.#clock().toISOString();
		const snapshot = this.#snapshots
			? await this.#snapshots.capture({
				record: record.value,
				checkpointId,
				eventCursor: request.eventCursor,
				status: status.value,
				capturedAt,
			})
			: undefined;
		if (snapshot && !snapshot.ok) return snapshot;
		const checkpoint = {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			checkpointId,
			workspaceId: request.envelope.workspaceId,
			eventCursor: request.eventCursor,
			baseCommit: request.envelope.baseCommit,
			headCommit: status.value.headCommit,
			statusDigest: statusDigest(status.value),
			...(snapshot?.value.snapshotArtifactId
				? { snapshotArtifactId: snapshot.value.snapshotArtifactId }
				: {}),
			completeness: snapshot?.value.completeness ?? "metadata_only" as const,
		};
		const checkpointed = { ...record.value, headCommit: status.value.headCommit, lastCheckpoint: checkpoint };
		const stored = await this.#appendProjection("upsert", record.value, checkpointed);
		if (!stored.ok) return stored;
		return { ok: true, value: { checkpoint, receiptId: createRuntimeId("receipt", canonicalDigest(checkpoint).slice(0, 48)) } };
	}

	public async release(
		request: WorkspaceReleaseRequest,
	): Promise<WorktreeResult<{ receipt: WorkspaceReleaseReceiptRef; record: WorktreeRecord }>> {
		if (request.envelopeDigest !== workspaceExecutionEnvelopeDigest(request.envelope)) {
			return failure("invalid_request", "release envelope digest is invalid");
		}
		if (
			request.authorityId !== request.envelope.authorityId ||
			request.tenantId !== request.envelope.tenantId ||
			request.principalId !== request.envelope.principalId ||
			request.sessionId !== request.envelope.sessionId
		) {
			return failure("invalid_scope", "release request context does not match its workspace envelope");
		}
		if (
			request.agentId !== request.envelope.agentId ||
			request.traceId !== request.envelope.traceId
		) {
			return failure("invalid_request", "release agent or trace identity does not match its workspace envelope");
		}
		if (request.expectedLeaseRevision !== request.envelope.leaseRevision) {
			return failure("lease_conflict", "release lease revision is stale");
		}
		const requestDigest = canonicalDigest(request);
		const operationId = worktreeReleaseOperationId(
			request.envelope.workspaceId,
			request.expectedLeaseId,
			request.expectedLeaseRevision,
		);
		let durable: WorktreeReleaseJournalRecord | undefined;
		try {
			durable = await this.#releaseJournal.read(operationId);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release journal is unavailable");
		}
		if (durable) {
			if (!isValidWorktreeReleaseJournalRecord(durable)) {
				return failure("uncertain", "workspace release journal record is corrupted");
			}
			if (
				durable.intent.requestId !== request.requestId ||
				durable.intent.requestDigest !== requestDigest
			) {
				return failure("invalid_request", "release request identity was reused with another payload");
			}
			if (durable.receipt) {
				return {
					ok: true,
					value: {
						receipt: structuredClone(durable.receipt),
						record: structuredClone(durable.intent.retainedRecord),
					},
				};
			}
			return this.#reconcileRelease(durable);
		}
		let current: WorkspaceLeaseSecret | undefined;
		try {
			current = await this.#leases.read(request.envelope.workspaceId);
		} catch {
			return failure("uncertain", "workspace release lease state is unavailable", true);
		}
		if (
			!current ||
			current.record.leaseId !== request.expectedLeaseId ||
			current.record.leaseRevision !== request.expectedLeaseRevision
		) {
			return failure("lease_conflict", "workspace release lease identity is stale");
		}
		if (current.record.state !== "active") {
			return failure("stale", "workspace release has no durable intent for the current lease");
		}
		const validated = await this.validate(request.envelope);
		if (!validated.ok) return validated;
		try {
			current = await this.#leases.read(request.envelope.workspaceId);
		} catch {
			return failure("uncertain", "workspace release lease state is unavailable after validation", true);
		}
		if (
			!current ||
			current.record.state !== "active" ||
			current.record.leaseId !== request.expectedLeaseId ||
			current.record.leaseId !== validated.value.binding.leaseId ||
			current.record.leaseRevision !== request.expectedLeaseRevision
		) {
			return failure("lease_conflict", "workspace lease changed during release validation");
		}
		if (request.checkpoint) {
			const expectedStream = createSessionEventStreamRef(request, request.sessionId);
			if (
				request.checkpoint.authorityId !== request.authorityId ||
				request.checkpoint.tenantId !== request.tenantId ||
				request.checkpoint.workspaceId !== request.envelope.workspaceId ||
				request.checkpoint.baseCommit !== request.envelope.baseCommit ||
				!sameRuntimeEventStream(request.checkpoint.eventCursor.stream, expectedStream)
			) {
				return failure("checkpoint_required", "release checkpoint authority or event stream is not correlated");
			}
			const status = await this.#git.status(request.envelope.worktreePath, request.envelope.baseCommit);
			if (!status.ok) return status;
			if (
				request.checkpoint.workspaceId !== request.envelope.workspaceId ||
				request.checkpoint.headCommit !== status.value.headCommit ||
				request.checkpoint.statusDigest !== statusDigest(status.value)
			) {
				return failure("checkpoint_required", "release checkpoint is stale");
			}
		}
		const registered = await this.#registry.get(request.envelope.workspaceId);
		if (!registered.ok) return registered;
		if (!registered.value) return failure("not_found", "workspace disappeared during release");
		const releasedAt = this.#clock().toISOString();
		const releasedLease = { ...current.record, state: "released" as const };
		const checkpoint = request.checkpoint ?? registered.value.lastCheckpoint;
		const retainedRecord: WorktreeRecord = {
			...registered.value,
			state: "retained",
			lease: releasedLease,
			...(checkpoint === undefined ? {} : { lastCheckpoint: checkpoint }),
		};
		const receiptId = createRuntimeId("receipt", canonicalDigest({
			operationId,
			requestDigest,
		}).slice(0, 48));
		const intentBody: Omit<WorktreeReleaseIntent, "intentDigest"> = {
			schemaVersion: 1,
			kind: "worktree_release_intent",
			operationId,
			requestId: request.requestId,
			requestDigest,
			callerRequestDigest: request.callerRequestDigest,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			workspaceId: request.envelope.workspaceId,
			repositoryId: request.envelope.repositoryId,
			envelopeDigest: request.envelopeDigest,
			leaseId: releasedLease.leaseId,
			leaseRevision: releasedLease.leaseRevision,
			releasedAt,
			releasedLease,
			releasedLeaseDigest: canonicalDigest(releasedLease),
			retainedRecord,
			retainedRecordDigest: canonicalDigest(retainedRecord),
			receiptId,
			...(checkpoint === undefined ? {} : { checkpoint }),
		};
		const intent: WorktreeReleaseIntent = {
			...intentBody,
			intentDigest: worktreeReleaseIntentDigest(intentBody),
		};
		const journalBody = {
			schemaVersion: 1 as const,
			kind: "worktree_release_journal_record" as const,
			intent,
		};
		const proposed: WorktreeReleaseJournalRecord = {
			...journalBody,
			recordDigest: worktreeReleaseJournalRecordDigest(journalBody),
		};
		let begun: "applied" | "replay" | "conflict";
		try {
			begun = await this.#releaseJournal.begin(proposed);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release intent could not be persisted");
		}
		if (begun === "conflict") {
			return failure("invalid_request", "release request identity was reused with another payload");
		}
		try {
			durable = await this.#releaseJournal.read(operationId);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release intent read-back failed");
		}
		if (!durable || !isValidWorktreeReleaseJournalRecord(durable)) {
			return failure("uncertain", "workspace release intent read-back is missing or corrupted", true);
		}
		if (durable.intent.requestId !== request.requestId || durable.intent.requestDigest !== requestDigest) {
			return failure("invalid_request", "release request identity was reused with another payload");
		}
		return this.#reconcileRelease(durable);
	}

	public async replayRelease(
		request: WorktreeReleaseReplayRequest,
	): Promise<WorktreeResult<{ receipt: WorkspaceReleaseReceiptRef; record: WorktreeRecord }>> {
		const operationId = worktreeReleaseOperationId(
			request.workspaceId,
			request.leaseId,
			request.leaseRevision,
		);
		let durable: WorktreeReleaseJournalRecord | undefined;
		try {
			durable = await this.#releaseJournal.read(operationId);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release journal replay is unavailable");
		}
		if (!durable) return failure("not_found", "workspace release journal record is missing");
		if (!isValidWorktreeReleaseJournalRecord(durable)) {
			return failure("uncertain", "workspace release journal record is corrupted");
		}
		if (
			durable.intent.requestId !== request.requestId ||
			durable.intent.callerRequestDigest !== request.callerRequestDigest ||
			durable.intent.authorityId !== request.authorityId ||
			durable.intent.tenantId !== request.tenantId ||
			durable.intent.principalId !== request.principalId ||
			durable.intent.sessionId !== request.sessionId ||
			durable.intent.agentId !== request.agentId
		) {
			return failure("invalid_request", "release replay identity was reused with another payload");
		}
		return durable.receipt
			? {
				ok: true,
				value: {
					receipt: structuredClone(durable.receipt),
					record: structuredClone(durable.intent.retainedRecord),
				},
			}
			: this.#reconcileRelease(durable);
	}

	async #reconcileRelease(
		journal: WorktreeReleaseJournalRecord,
	): Promise<WorktreeResult<{ receipt: WorkspaceReleaseReceiptRef; record: WorktreeRecord }>> {
		const intent = journal.intent;
		let current: WorkspaceLeaseSecret | undefined;
		try {
			current = await this.#leases.read(intent.workspaceId);
		} catch {
			return failure("uncertain", "workspace release lease reconcile is unavailable", true);
		}
		if (!current) return failure("lease_conflict", "workspace release lease disappeared");
		if (current.record.state === "active") {
			const expectedActive = { ...intent.releasedLease, state: "active" as const };
			if (canonicalDigest(current.record) !== canonicalDigest(expectedActive)) {
				return failure("lease_conflict", "workspace release active lease no longer matches its durable intent");
			}
			const releasedSecret: WorkspaceLeaseSecret = {
				...current,
				record: intent.releasedLease,
				lastRenewedAt: intent.releasedAt,
			};
			let swapped: "applied" | "conflict";
			try {
				swapped = await this.#leases.compareAndSwap(
					intent.workspaceId,
					intent.leaseRevision,
					canonicalDigest(current),
					releasedSecret,
				);
			} catch {
				return failure("uncertain", "workspace release lease CAS outcome is uncertain", true);
			}
			if (swapped !== "applied") {
				try {
					current = await this.#leases.read(intent.workspaceId);
				} catch {
					return failure("uncertain", "workspace release lease CAS read-back failed", true);
				}
			} else {
				current = releasedSecret;
			}
		}
		if (
			!current ||
			current.record.state !== "released" ||
			canonicalDigest(current.record) !== intent.releasedLeaseDigest ||
			current.lastRenewedAt !== intent.releasedAt
		) {
			return failure("lease_conflict", "workspace released lease does not match its durable intent");
		}
		const projected = await this.#ensureReleaseProjection(intent);
		if (!projected.ok) return projected;
		let latestJournal: WorktreeReleaseJournalRecord | undefined;
		try {
			latestJournal = await this.#releaseJournal.read(intent.operationId);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release journal read-back is unavailable");
		}
		if (!latestJournal || !isValidWorktreeReleaseJournalRecord(latestJournal)) {
			return failure("uncertain", "workspace release journal read-back is missing or corrupted");
		}
		if (latestJournal.receipt) {
			return {
				ok: true,
				value: {
					receipt: structuredClone(latestJournal.receipt),
					record: structuredClone(latestJournal.intent.retainedRecord),
				},
			};
		}
		try {
			current = await this.#leases.read(intent.workspaceId);
		} catch {
			return failure("uncertain", "workspace release lease final read-back is unavailable", true);
		}
		if (
			!current ||
			current.record.state !== "released" ||
			canonicalDigest(current.record) !== intent.releasedLeaseDigest ||
			current.lastRenewedAt !== intent.releasedAt
		) {
			return failure("lease_conflict", "workspace release lease changed before receipt persistence");
		}
		const receiptBody: Omit<WorkspaceReleaseReceiptRef, "receiptDigest"> = {
			schemaVersion: 1,
			kind: "workspace_release_receipt",
			receiptId: intent.receiptId,
			requestId: intent.requestId,
			requestDigest: intent.requestDigest,
			callerRequestDigest: intent.callerRequestDigest,
			authorityId: intent.authorityId,
			tenantId: intent.tenantId,
			principalId: intent.principalId,
			sessionId: intent.sessionId,
			agentId: intent.agentId,
			workspaceId: intent.workspaceId,
			repositoryId: intent.repositoryId,
			envelopeDigest: intent.envelopeDigest,
			leaseId: intent.leaseId,
			leaseRevision: intent.leaseRevision,
			releasedLeaseDigest: intent.releasedLeaseDigest,
			retainedRecordDigest: intent.retainedRecordDigest,
			releasedAt: intent.releasedAt,
		};
		const receipt: WorkspaceReleaseReceiptRef = {
			...receiptBody,
			receiptDigest: canonicalDigest(receiptBody),
		};
		const completedBody = {
			schemaVersion: 1 as const,
			kind: "worktree_release_journal_record" as const,
			intent,
			receipt,
		};
		const completed: WorktreeReleaseJournalRecord = {
			...completedBody,
			recordDigest: worktreeReleaseJournalRecordDigest(completedBody),
		};
		let completion: "applied" | "replay" | "conflict";
		try {
			completion = await this.#releaseJournal.complete(
				intent.operationId,
				intent.requestDigest,
				completed,
			);
		} catch (cause) {
			return releaseJournalFailure(cause, "workspace release receipt persistence is uncertain");
		}
		if (completion === "conflict") {
			return failure("uncertain", "workspace release receipt conflicts with its durable intent");
		}
		return {
			ok: true,
			value: {
				receipt: structuredClone(receipt),
				record: structuredClone(intent.retainedRecord),
			},
		};
	}

	async #ensureReleaseProjection(intent: WorktreeReleaseIntent): Promise<WorktreeResult<void>> {
		const registered = await this.#registry.get(intent.workspaceId);
		if (!registered.ok) return registered;
		if (!registered.value) return failure("not_found", "workspace disappeared during release reconcile");
		if (canonicalDigest(registered.value) === intent.retainedRecordDigest) {
			return { ok: true, value: undefined };
		}
		const expectedActiveRecord: WorktreeRecord = {
			...intent.retainedRecord,
			state: "active",
			lease: { ...intent.releasedLease, state: "active" },
		};
		if (
			registered.value.state !== "active" ||
			canonicalDigest(registered.value) !== canonicalDigest(expectedActiveRecord)
		) {
			return failure("uncertain", "workspace registry changed outside the durable release intent");
		}
		const repaired = await this.#registry.appendIfCurrent(
			"upsert",
			intent.retainedRecord,
			canonicalDigest(registered.value),
		);
		if (!repaired.ok) return repaired;
		const readBack = await this.#registry.get(intent.workspaceId);
		if (!readBack.ok) return readBack;
		if (!readBack.value || canonicalDigest(readBack.value) !== intent.retainedRecordDigest) {
			return failure("uncertain", "workspace retained projection read-back failed", true);
		}
		return { ok: true, value: undefined };
	}

	public async resume(
		workspaceId: WorkspaceId,
		context: WorktreeRuntimeContext,
		ownerRuntimeId: RuntimeInstanceId,
	): Promise<WorktreeResult<WorktreeCreateResult>> {
		let registered = await this.#registry.get(workspaceId);
		if (!registered.ok) return registered;
		let record = registered.value;
		if (!record || record.state === "removed" || record.state === "removing" || record.state === "failed") {
			return failure("not_found", "workspace cannot be resumed");
		}
		if (record.authorityId !== context.authorityId || record.tenantId !== context.tenantId || record.principalId !== context.principalId || record.sessionId !== context.sessionId) {
			return failure("invalid_scope", "workspace resume scope does not match");
		}
		let current = await this.#leases.read(workspaceId);
		if (!current) return failure("lease_conflict", "workspace lease is missing");
		if (current.record.state === "released") {
			const operationId = worktreeReleaseOperationId(
				workspaceId,
				current.record.leaseId,
				current.record.leaseRevision,
			);
			let pending: WorktreeReleaseJournalRecord | undefined;
			try {
				pending = await this.#releaseJournal.read(operationId);
			} catch (cause) {
				return releaseJournalFailure(cause, "workspace release journal is unavailable during resume");
			}
			if (pending) {
				if (
					!isValidWorktreeReleaseJournalRecord(pending) ||
					pending.intent.authorityId !== context.authorityId ||
					pending.intent.tenantId !== context.tenantId ||
					pending.intent.principalId !== context.principalId ||
					pending.intent.sessionId !== context.sessionId
				) {
					return failure("uncertain", "workspace release journal does not match resume scope");
				}
				const settled = pending.receipt
					? await this.#ensureReleaseProjection(pending.intent)
					: await this.#reconcileRelease(pending);
				if (!settled.ok) return settled;
				registered = await this.#registry.get(workspaceId);
				if (!registered.ok) return registered;
				record = registered.value;
				current = await this.#leases.read(workspaceId);
				if (!record || !current || current.record.state !== "released") {
					return failure("lease_conflict", "workspace release changed during resume reconciliation");
				}
			}
		}
		if (current.record.state === "active") {
			if (current.record.ownerRuntimeId !== ownerRuntimeId) {
				return failure("active", "workspace is owned by another live runtime");
			}
			if (
				record.state !== "active" ||
				record.ownerRuntimeId !== current.record.ownerRuntimeId ||
				record.leaseRevision !== current.record.leaseRevision ||
				record.lease === undefined ||
				canonicalDigest(record.lease) !== canonicalDigest(current.record)
			) {
				const recovered: WorktreeRecord = {
					...record,
					ownerRuntimeId: current.record.ownerRuntimeId,
					leaseRevision: current.record.leaseRevision,
					lease: current.record,
					state: "active",
					lastAccessedAt: this.#clock().toISOString(),
				};
				const projected = await this.#appendProjection("upsert", record, recovered);
				if (!projected.ok) return projected;
				record = recovered;
			}
			return { ok: true, value: this.#result(record, current) };
		}
		if (current.record.state === "revoked") {
			return failure("lease_conflict", "workspace lease was revoked and cannot be resumed");
		}
		const token = await this.#tokens.issue();
		const nextRecord = {
			...current.record,
			ownerRuntimeId,
			leaseRevision: current.record.leaseRevision + 1,
			fencingTokenDigest: canonicalDigest(token),
			state: "active" as const,
		};
		const next: WorkspaceLeaseSecret = { record: nextRecord, fencingToken: token, issuedAt: this.#clock().toISOString(), lastRenewedAt: this.#clock().toISOString() };
		if (await this.#leases.compareAndSwap(
			workspaceId,
			current.record.leaseRevision,
			canonicalDigest(current),
			next,
		) !== "applied") return failure("lease_conflict", "workspace resume lost its lease CAS");
		const resumed = { ...record, ownerRuntimeId, leaseRevision: nextRecord.leaseRevision, lease: nextRecord, state: "active" as const, lastAccessedAt: this.#clock().toISOString() };
		const stored = await this.#appendProjection("upsert", record, resumed);
		if (!stored.ok) return stored;
		return { ok: true, value: this.#result(resumed, next) };
	}

	public async handoff(
		workspaceId: WorkspaceId,
		fromRuntimeId: RuntimeInstanceId,
		toRuntimeId: RuntimeInstanceId,
		expectedRevision: number,
	): Promise<WorktreeResult<{ handoff: WorktreeLeaseHandoff; result: WorktreeCreateResult }>> {
		const registered = await this.#registry.get(workspaceId);
		if (!registered.ok || !registered.value) return failure("not_found", "workspace handoff target is missing");
		const record = registered.value;
		if (record.state === "removed" || record.state === "removing" || record.state === "failed") {
			return failure("not_found", "workspace handoff target is unavailable");
		}
		const current = await this.#leases.read(workspaceId);
		if (
			current?.record.state === "active" &&
			current.record.ownerRuntimeId === toRuntimeId &&
			current.record.leaseRevision === expectedRevision + 1 &&
			record.ownerRuntimeId === fromRuntimeId &&
			record.leaseRevision === expectedRevision
		) {
			const recovered: WorktreeRecord = {
				...record,
				ownerRuntimeId: toRuntimeId,
				leaseRevision: current.record.leaseRevision,
				lease: current.record,
				state: "active",
				lastAccessedAt: this.#clock().toISOString(),
			};
			const projected = await this.#appendProjection("upsert", record, recovered);
			if (!projected.ok) return projected;
			const handoff: WorktreeLeaseHandoff = {
				authorityId: record.authorityId,
				tenantId: record.tenantId,
				principalId: record.principalId,
				workspaceId,
				leaseId: current.record.leaseId,
				fromRuntimeId,
				toRuntimeId,
				expectedRevision,
				nextRevision: current.record.leaseRevision,
				handoffTokenDigest: current.record.fencingTokenDigest,
				receiptId: createRuntimeId("receipt", canonicalDigest({
					workspaceId,
					fromRuntimeId,
					toRuntimeId,
					expectedRevision,
				}).slice(0, 48)),
			};
			return { ok: true, value: { handoff, result: this.#result(recovered, current) } };
		}
		if (!current || current.record.ownerRuntimeId !== fromRuntimeId || current.record.leaseRevision !== expectedRevision || current.record.state !== "active") {
			return failure("lease_conflict", "workspace handoff lease is stale");
		}
		const token = await this.#tokens.issue();
		const nextRecord = { ...current.record, ownerRuntimeId: toRuntimeId, leaseRevision: expectedRevision + 1, fencingTokenDigest: canonicalDigest(token), state: "active" as const };
		const next: WorkspaceLeaseSecret = { record: nextRecord, fencingToken: token, issuedAt: this.#clock().toISOString(), lastRenewedAt: this.#clock().toISOString() };
		if (await this.#leases.compareAndSwap(
			workspaceId,
			expectedRevision,
			canonicalDigest(current),
			next,
		) !== "applied") return failure("lease_conflict", "workspace handoff lost its lease CAS");
		const moved = { ...record, ownerRuntimeId: toRuntimeId, leaseRevision: nextRecord.leaseRevision, lease: nextRecord, lastAccessedAt: this.#clock().toISOString() };
		const stored = await this.#appendProjection("upsert", record, moved);
		if (!stored.ok) return stored;
		const handoff: WorktreeLeaseHandoff = {
			authorityId: record.authorityId, tenantId: record.tenantId, principalId: record.principalId,
			workspaceId, leaseId: nextRecord.leaseId, fromRuntimeId, toRuntimeId,
			expectedRevision, nextRevision: nextRecord.leaseRevision, handoffTokenDigest: nextRecord.fencingTokenDigest,
			receiptId: createRuntimeId("receipt", canonicalDigest({ workspaceId, fromRuntimeId, toRuntimeId, expectedRevision }).slice(0, 48)),
		};
		return { ok: true, value: { handoff, result: this.#result(moved, next) } };
	}

	public async takeoverStale(
		workspaceId: WorkspaceId,
		toRuntimeId: RuntimeInstanceId,
		expectedRevision: number,
		staleBefore: Date,
	): Promise<WorktreeResult<WorktreeCreateResult>> {
		const registered = await this.#registry.get(workspaceId);
		if (!registered.ok || !registered.value) return failure("not_found", "workspace takeover target is missing");
		const record = registered.value;
		const owners = await this.#liveness.activeOwners(workspaceId, record.worktreePath);
		if (owners.length > 0 || Date.parse(record.lastAccessedAt) >= staleBefore.getTime()) return failure("active", "workspace is not stale enough for takeover");
		const moved = await this.handoff(workspaceId, record.ownerRuntimeId, toRuntimeId, expectedRevision);
		return moved.ok ? { ok: true, value: moved.value.result } : moved;
	}

	public async applyPreview(workspaceId: WorkspaceId): Promise<WorktreeResult<WorktreeApplyPreview>> {
		const registered = await this.#registry.get(workspaceId);
		if (!registered.ok) return registered;
		const record = registered.value;
		if (!record || record.bindingKind === "source") return failure("not_found", "managed worktree is unavailable");
		const status = await this.#git.status(record.worktreePath, record.baseCommit);
		if (!status.ok) return status;
		const diff = await this.#git.diff(record.worktreePath, record.baseCommit, this.#maxPreviewBytes);
		if (!diff.ok) return diff;
		const body = {
			workspaceId, sourceRepo: record.sourceRepo, baseCommit: record.baseCommit, headCommit: status.value.headCommit,
			status: status.value.status, diff: diff.value, conflicts: [] as readonly string[],
		};
		return { ok: true, value: { ...body, previewDigest: canonicalDigest(body) } };
	}

	public async removePreview(request: WorktreeRemoveRequest): Promise<WorktreeResult<WorktreeRemovePreview>> {
		const registered = await this.#registry.get(request.workspaceId);
		if (!registered.ok) return registered;
		const record = registered.value;
		if (!record || record.bindingKind === "source") return failure("not_found", "managed worktree is unavailable");
		if (record.authorityId !== request.authorityId || record.tenantId !== request.tenantId || record.principalId !== request.principalId) {
			return failure("invalid_scope", "worktree removal scope does not match");
		}
		const managedRoot = await this.#canonicalManagedRoot();
		if (!managedRoot.ok) return managedRoot;
		let canonicalPath: string;
		try {
			canonicalPath = resolve(await this.#filesystem.realpath(record.worktreePath));
		} catch {
			return failure("stale", "worktree path is missing");
		}
		if (canonicalPath !== record.worktreePath || !pathWithin(managedRoot.value, canonicalPath) || canonicalPath === record.sourceRepo) {
			return failure("outside_managed_root", "worktree removal target failed canonical recheck");
		}
		const [status, registeredInGit, owners] = await Promise.all([
			this.#git.status(canonicalPath, record.baseCommit),
			this.#git.isRegistered(record.sourceRepo, canonicalPath),
			this.#liveness.activeOwners(record.workspaceId, canonicalPath),
		]);
		if (!status.ok) return status;
		if (!registeredInGit.ok) return registeredInGit;
		const checkpointCurrent = request.checkpoint !== undefined && request.checkpoint.workspaceId === record.workspaceId &&
			request.checkpoint.headCommit === status.value.headCommit && request.checkpoint.statusDigest === statusDigest(status.value);
		const reasons: string[] = [];
		if (status.value.dirty) reasons.push("dirty");
		if (status.value.unpublished) reasons.push("unpublished");
		if (owners.length > 0) reasons.push("active");
		if (!registeredInGit.value) reasons.push("unregistered");
		if (!checkpointCurrent) reasons.push("checkpoint_required");
		const body = {
			workspaceId: record.workspaceId, worktreePath: canonicalPath, dirty: status.value.dirty,
			unpublished: status.value.unpublished, active: owners.length > 0, registered: registeredInGit.value,
			checkpointCurrent, removable: reasons.length === 0, reasonCodes: [...new Set(reasons)].sort(),
		};
		return { ok: true, value: { ...body, previewDigest: canonicalDigest(body) } };
	}

	public async remove(request: WorktreeRemoveRequest): Promise<WorktreeResult<WorktreeRemovePreview>> {
		const first = await this.removePreview(request);
		if (!first.ok || request.dryRun) return first;
		const record = await this.#registry.get(request.workspaceId);
		if (!record.ok || !record.value) return failure("not_found", "worktree disappeared before removal");
		if (!first.value.removable) {
			if (!request.force || !request.forceApproval || !this.#forceApproval) {
				return failure("approval_required", `worktree removal requires exact force approval: ${first.value.reasonCodes.join(",")}`);
			}
			const approved = await this.#forceApproval.verify(request, record.value, request.forceApproval);
			if (!approved.ok) return approved;
		}
		const second = await this.removePreview(request);
		if (!second.ok) return second;
		if (second.value.previewDigest !== first.value.previewDigest) return failure("stale", "worktree changed after removal preview");
		let currentLease = await this.#leases.read(request.workspaceId);
		if (!currentLease || currentLease.record.leaseRevision !== request.expectedLeaseRevision) {
			return failure("lease_conflict", "workspace lease changed before removal");
		}
		if (currentLease.record.state !== "revoked") {
			const revoked: WorkspaceLeaseSecret = {
				...currentLease,
				record: { ...currentLease.record, state: "revoked" },
				lastRenewedAt: this.#clock().toISOString(),
			};
			if (await this.#leases.compareAndSwap(
				request.workspaceId,
				request.expectedLeaseRevision,
				canonicalDigest(currentLease),
				revoked,
			) !== "applied") {
				return failure("lease_conflict", "workspace removal lost its exact lease fence");
			}
			currentLease = revoked;
		}
		const removing = {
			...record.value,
			state: "removing" as const,
			lease: currentLease.record,
			lastAccessedAt: this.#clock().toISOString(),
		};
		const intent = await this.#appendProjection("upsert", record.value, removing);
		if (!intent.ok) return intent;
		const removed = await this.#git.removeWorktree(record.value.sourceRepo, record.value.worktreePath, request.force);
		if (!removed.ok) return removed;
		const remaining = await this.#filesystem.stat(record.value.worktreePath);
		if (remaining.exists) return failure("uncertain", "Git reported removal but worktree path still exists", true);
		const leaseRemoved = await this.#leases.remove(
			request.workspaceId,
			request.expectedLeaseRevision,
			canonicalDigest(currentLease),
		);
		if (leaseRemoved === "conflict") return failure("lease_conflict", "workspace lease changed during removal");
		const { lease: _lease, ...withoutLease } = removing;
		const tombstone: WorktreeRecord = { ...withoutLease, state: "removed" };
		const finalized = await this.#appendProjection("remove", removing, tombstone);
		if (!finalized.ok) return failure("uncertain", "worktree was removed but registry tombstone failed", true);
		return { ok: true, value: second.value };
	}

	public list(includeRemoved = false): ReturnType<WorktreeRegistry["list"]> {
		return this.#registry.list(includeRemoved);
	}
}
