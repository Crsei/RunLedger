/** Production workspace composition；持久状态、Artifact snapshot 与 raw fencing token 均留在 adapter 边界。 */

import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type { ArtifactAccessService } from "../runtime/artifacts/access.ts";
import type { ArtifactRepository } from "../runtime/artifacts/cas-store.ts";
import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type PrincipalId,
	type RepositoryId,
	type RuntimeInstanceId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import {
	isWorkspaceExecutionEnvelope,
	type WorkspaceExecutionEnvelope,
} from "../runtime/protocol/v3/workspace.ts";
import type { ToolExecutionGatewayRequest } from "../runtime/types.ts";
import type { ToolExecutionWorkspaceResolverPort } from "../security/integration/tool-execution-gateway.ts";
import {
	ArtifactWorkspaceSnapshot,
	RepositoryWorktreeArtifactPort,
} from "../worktree/artifact-snapshot.ts";
import { ArtifactWorkspaceCheckpoint } from "../worktree/checkpoint-adapter.ts";
import { GitOperations } from "../worktree/git-operations.ts";
import { RuntimeWorkspaceServiceAdapter } from "../worktree/integration/runtime-workspace-adapter.ts";
import { WorktreeManager } from "../worktree/manager.ts";
import { pathWithin } from "../worktree/paths.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorktreeCheckpointArtifactResolverPort,
	WorktreeFileSystemPort,
	WorktreeForceApprovalPort,
	WorktreeForensicAuthorizationPort,
	WorktreeLivenessPort,
	WorktreeTokenPort,
} from "../worktree/ports.ts";
import { WorktreeRegistry } from "../worktree/registry.ts";
import type { WorktreeRuntimeContext } from "../worktree/types.ts";
import {
	FileWorktreeCheckpointEffectPort,
	NodeGitCommandPort,
	NodeWorktreeContentPort,
	nodeWorktreeFileSystem,
} from "./worktree-node-adapter.ts";
import {
	FileWorkspaceLeaseMutationPort,
	FileWorktreeReleaseJournalPort,
	FileWorktreeRegistryMutationPort,
	type DurableWorktreeScope,
} from "./worktree-state-adapter.ts";

export interface ProductionWorkspaceStatePaths {
	managedRoot: string;
	stateRoot: string;
	registryFile: string;
	leaseFile: string;
	releaseFile: string;
	effectFile: string;
}

export interface ProductionWorkspaceResolverContext extends WorktreeRuntimeContext {
	workspaceId: WorkspaceId;
	repositoryId: RepositoryId;
	ownerRuntimeId: RuntimeInstanceId;
}

export interface ProductionWorkspaceCompositionOptions {
	scope: DurableWorktreeScope;
	managedRoot: string;
	stateRoot: string;
	validatorPrincipalId: PrincipalId;
	liveness: WorktreeLivenessPort;
	repository: ArtifactRepository;
	artifactAccess: ArtifactAccessService;
	forensicAuthorization: WorktreeForensicAuthorizationPort;
	forceApproval?: WorktreeForceApprovalPort;
	tokens?: WorktreeTokenPort;
	clock?: () => Date;
	maxPreviewBytes?: number;
	maxSnapshotEntryBytes?: number;
	maxSnapshotBytes?: number;
}

export interface ProductionWorkspaceComposition {
	paths: ProductionWorkspaceStatePaths;
	manager: WorktreeManager;
	workspaceService: RuntimeWorkspaceServiceAdapter;
	registry: WorktreeRegistry;
	createToolExecutionWorkspaceResolver(context: ProductionWorkspaceResolverContext): ToolExecutionWorkspaceResolverPort;
	createCheckpointAdapter(checkpointArtifacts: WorktreeCheckpointArtifactResolverPort): ArtifactWorkspaceCheckpoint;
}

export class NodeWorktreeTokenPort implements WorktreeTokenPort {
	public async issue(): Promise<string> {
		return randomBytes(32).toString("base64url");
	}
}

interface FileBackedWorkspaceEnvelopeResolverOptions {
	registry: WorktreeRegistry;
	leases: WorkspaceLeaseMutationPort;
	filesystem: WorktreeFileSystemPort;
	context: ProductionWorkspaceResolverContext;
}

export class FileBackedWorkspaceEnvelopeResolver implements ToolExecutionWorkspaceResolverPort {
	readonly #registry: WorktreeRegistry;
	readonly #leases: WorkspaceLeaseMutationPort;
	readonly #filesystem: WorktreeFileSystemPort;
	readonly #context: ProductionWorkspaceResolverContext;

	public constructor(options: FileBackedWorkspaceEnvelopeResolverOptions) {
		this.#registry = options.registry;
		this.#leases = options.leases;
		this.#filesystem = options.filesystem;
		this.#context = structuredClone(options.context);
	}

	public async resolve(
		request: ToolExecutionGatewayRequest,
		signal?: AbortSignal,
	): Promise<WorkspaceExecutionEnvelope | undefined> {
		if (signal?.aborted) return undefined;
		const registered = await this.#registry.get(this.#context.workspaceId);
		if (!registered.ok) throw new Error(`workspace registry unavailable: ${registered.error.message}`);
		const record = registered.value;
		if (!record || record.state !== "active" || request.cwd !== record.effectiveCwd ||
			record.authorityId !== this.#context.authorityId || record.tenantId !== this.#context.tenantId ||
			record.principalId !== this.#context.principalId || record.sessionId !== this.#context.sessionId ||
			record.repositoryId !== this.#context.repositoryId || record.ownerRuntimeId !== this.#context.ownerRuntimeId) return undefined;
		const secret = await this.#leases.read(record.workspaceId);
		if (!secret || !record.lease || secret.record.state !== "active" ||
			canonicalDigest(secret.record) !== canonicalDigest(record.lease) ||
			secret.record.authorityId !== record.authorityId || secret.record.tenantId !== record.tenantId ||
			secret.record.principalId !== record.principalId || secret.record.workspaceId !== record.workspaceId ||
			secret.record.ownerRuntimeId !== record.ownerRuntimeId || secret.record.leaseRevision !== record.leaseRevision ||
			secret.record.fencingTokenDigest !== canonicalDigest(secret.fencingToken)) return undefined;
		let workspace: string;
		let cwd: string;
		try {
			workspace = resolve(await this.#filesystem.realpath(record.worktreePath));
			cwd = resolve(await this.#filesystem.realpath(record.effectiveCwd));
		} catch {
			return undefined;
		}
		if (workspace !== record.worktreePath || cwd !== record.effectiveCwd || !pathWithin(workspace, cwd)) return undefined;
		const envelope: WorkspaceExecutionEnvelope = {
			authorityId: record.authorityId,
			tenantId: record.tenantId,
			principalId: record.principalId,
			sessionId: record.sessionId,
			workspaceId: record.workspaceId,
			repositoryId: record.repositoryId,
			worktreePath: record.worktreePath,
			branch: record.branch,
			baseCommit: record.baseCommit,
			agentId: this.#context.agentId,
			toolCallId: request.toolCallId,
			traceId: this.#context.traceId,
			cwd: record.effectiveCwd,
			ownerRuntimeId: record.ownerRuntimeId,
			leaseRevision: record.leaseRevision,
			fencingToken: secret.fencingToken,
		};
		return isWorkspaceExecutionEnvelope(envelope) ? envelope : undefined;
	}
}

function exactAbsolutePath(path: string, label: string): string {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
		throw new Error(`${label} must be an exact absolute path`);
	}
	return path;
}

async function canonicalRoot(path: string, label: string): Promise<string> {
	await nodeWorktreeFileSystem.mkdir(path);
	const canonical = resolve(await nodeWorktreeFileSystem.realpath(path));
	const stats = await nodeWorktreeFileSystem.stat(path);
	if (canonical !== path || !stats.exists || !stats.isDirectory || stats.isSymbolicLink) {
		throw new Error(`${label} must be a canonical non-symlink directory`);
	}
	return canonical;
}

function validateScope(scope: DurableWorktreeScope, validatorPrincipalId: PrincipalId): void {
	if (!isRuntimeId(scope.authorityId, "authority") || !isRuntimeId(scope.tenantId, "tenant") ||
		!isRuntimeId(validatorPrincipalId, "principal")) {
		throw new Error("production workspace scope or validator identity is invalid");
	}
}

export async function createProductionWorkspaceComposition(
	options: ProductionWorkspaceCompositionOptions,
): Promise<ProductionWorkspaceComposition> {
	validateScope(options.scope, options.validatorPrincipalId);
	const requestedManagedRoot = exactAbsolutePath(options.managedRoot, "managedRoot");
	const requestedStateRoot = exactAbsolutePath(options.stateRoot, "stateRoot");
	if (pathWithin(requestedManagedRoot, requestedStateRoot) || pathWithin(requestedStateRoot, requestedManagedRoot)) {
		throw new Error("managedRoot and stateRoot must be disjoint");
	}
	const [managedRoot, stateRoot] = await Promise.all([
		canonicalRoot(requestedManagedRoot, "managedRoot"),
		canonicalRoot(requestedStateRoot, "stateRoot"),
	]);
	const paths: ProductionWorkspaceStatePaths = {
		managedRoot,
		stateRoot,
		registryFile: join(stateRoot, "worktree-registry.json"),
		leaseFile: join(stateRoot, "workspace-leases.json"),
		releaseFile: join(stateRoot, "workspace-release-journal.json"),
		effectFile: join(stateRoot, "workspace-checkpoint-effects.json"),
	};
	const registryStorage = new FileWorktreeRegistryMutationPort(paths.registryFile, options.scope);
	const leases = new FileWorkspaceLeaseMutationPort(paths.leaseFile, options.scope);
	const releaseJournal = new FileWorktreeReleaseJournalPort(paths.releaseFile, options.scope);
	const effects = new FileWorktreeCheckpointEffectPort(paths.effectFile);
	await Promise.all([
		registryStorage.verify(),
		leases.verify(),
		releaseJournal.verify(),
		effects.read(createRuntimeId("command", "production-workspace-effect-preflight")),
	]);
	const registry = new WorktreeRegistry(registryStorage);
	const git = new GitOperations(new NodeGitCommandPort());
	const content = new NodeWorktreeContentPort();
	const snapshots = new ArtifactWorkspaceSnapshot({
		repository: options.repository,
		access: options.artifactAccess,
		git,
		content,
		authorization: options.forensicAuthorization,
		...(options.maxSnapshotEntryBytes === undefined ? {} : { maxEntryBytes: options.maxSnapshotEntryBytes }),
		...(options.maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes: options.maxSnapshotBytes }),
	});
	const manager = new WorktreeManager({
		managedRoot,
		filesystem: nodeWorktreeFileSystem,
		git,
		registry,
		leases,
		releaseJournal,
		tokens: options.tokens ?? new NodeWorktreeTokenPort(),
		liveness: options.liveness,
		snapshots,
		validatorPrincipalId: options.validatorPrincipalId,
		...(options.forceApproval === undefined ? {} : { forceApproval: options.forceApproval }),
		...(options.clock === undefined ? {} : { clock: options.clock }),
		...(options.maxPreviewBytes === undefined ? {} : { maxPreviewBytes: options.maxPreviewBytes }),
		protectedRoots: [stateRoot],
	});
	const artifactPort = new RepositoryWorktreeArtifactPort(options.repository, options.artifactAccess);
	return {
		paths,
		manager,
		workspaceService: new RuntimeWorkspaceServiceAdapter(manager),
		registry,
		createToolExecutionWorkspaceResolver: (context) => new FileBackedWorkspaceEnvelopeResolver({
			registry,
			leases,
			filesystem: nodeWorktreeFileSystem,
			context,
		}),
		createCheckpointAdapter: (checkpointArtifacts) => new ArtifactWorkspaceCheckpoint({
			managedRoot,
			filesystem: nodeWorktreeFileSystem,
			content,
			git,
			registry,
			leases,
			artifacts: artifactPort,
			checkpointArtifacts,
			effects,
			...(options.clock === undefined ? {} : { clock: options.clock }),
		}),
	};
}
