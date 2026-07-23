import { afterEach, describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactAccessService } from "../../src/runtime/artifacts/access.ts";
import {
	compositeCheckpointRef,
	createCompositeCheckpoint,
	isWorkspaceSnapshotManifest,
} from "../../src/runtime/artifacts/episode-manifest.ts";
import type {
	ArtifactAccessLogEntry,
	ArtifactAccessLogPort,
	ArtifactCapabilityDecision,
	ArtifactCapabilityGatewayPort,
	ArtifactCapabilityRequest,
	ArtifactMetadata,
	ArtifactResult,
	CompositeCheckpointRef,
	WorkspaceSnapshotManifest,
} from "../../src/runtime/artifacts/types.ts";
import type { ArtifactRef } from "../../src/runtime/protocol/v3/capability.ts";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type CommandId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
} from "../../src/runtime/protocol/v3/workspace.ts";
import {
	FileWorktreeCheckpointEffectPort,
	NodeGitCommandPort,
	NodeWorktreeContentPort,
	nodeWorktreeFileSystem,
} from "../../src/storage/worktree-node-adapter.ts";
import {
	ArtifactWorkspaceSnapshot,
	RepositoryWorktreeArtifactPort,
} from "../../src/worktree/artifact-snapshot.ts";
import { ArtifactWorkspaceCheckpoint } from "../../src/worktree/checkpoint-adapter.ts";
import { GitOperations } from "../../src/worktree/git-operations.ts";
import type {
	GitCommandRequest,
	WorktreeCheckpointArtifactResolverPort,
	WorktreeCheckpointEffectPort,
	WorktreeCheckpointEffectRecord,
	WorktreeForensicAuthorizationPort,
} from "../../src/worktree/ports.ts";
import type { WorktreeCreateRequest, WorktreeCreateResult } from "../../src/worktree/types.ts";
import { createArtifactHarness, type ArtifactHarness, NOW, valueOf } from "../runtime-v3/artifacts/helpers.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const worktrees: WorktreeTestHarness[] = [];
const artifactHarnesses: ArtifactHarness[] = [];

afterEach(async () => {
	for (const harness of worktrees.splice(0)) await harness.cleanup();
	for (const harness of artifactHarnesses.splice(0)) await harness.cleanup();
});

class AllowArtifactGateway implements ArtifactCapabilityGatewayPort {
	public async recheckArtifactAccess(request: ArtifactCapabilityRequest): Promise<ArtifactResult<ArtifactCapabilityDecision>> {
		return {
			ok: true,
			value: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				decision: "allow",
				receiptId: createRuntimeId("receipt", canonicalDigest(request).slice(0, 48)),
			},
		};
	}
}

class MemoryArtifactAccessLog implements ArtifactAccessLogPort {
	readonly entries: ArtifactAccessLogEntry[] = [];
	public async append(entry: ArtifactAccessLogEntry): Promise<ArtifactResult<void>> {
		this.entries.push(entry);
		return { ok: true, value: undefined };
	}
}

class ForensicAuthorization implements WorktreeForensicAuthorizationPort {
	readonly #allowed: boolean;
	public constructor(allowed = true) {
		this.#allowed = allowed;
	}
	public async authorizeCapture() {
		return this.#allowed
			? {
				ok: true as const,
				value: { approvalId: createRuntimeId("approval", "workspace-forensic-capture"), purpose: "reversible workspace checkpoint" },
			}
			: {
				ok: false as const,
				error: { code: "approval_required" as const, message: "forensic capture denied", retryable: false },
			};
	}
}

class FailOnceCompleteEffectPort implements WorktreeCheckpointEffectPort {
	readonly #delegate: WorktreeCheckpointEffectPort;
	#failed = false;

	public constructor(delegate: WorktreeCheckpointEffectPort) {
		this.#delegate = delegate;
	}

	public read(effectId: CommandId): Promise<WorktreeCheckpointEffectRecord | undefined> {
		return this.#delegate.read(effectId);
	}

	public begin(record: WorktreeCheckpointEffectRecord): Promise<"applied" | "replay" | "conflict"> {
		return this.#delegate.begin(record);
	}

	public complete(
		effectId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeCheckpointEffectRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		if (!this.#failed) {
			this.#failed = true;
			return Promise.reject(new Error("injected terminal receipt failure"));
		}
		return this.#delegate.complete(effectId, expectedRequestDigest, record);
	}
}

function artifactReference(metadata: ArtifactMetadata): ArtifactRef {
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

async function runGit(cwd: string, ...arguments_: string[]): Promise<void> {
	const request: GitCommandRequest = { cwd, arguments: arguments_, timeoutMs: 30_000 };
	const result = await new NodeGitCommandPort().run(request);
	if (result.exitCode !== 0) throw new Error(result.stderr);
}

function createRequest(harness: WorktreeTestHarness, seed: string): WorktreeCreateRequest {
	return {
		authorityId: createRuntimeId("authority", seed),
		tenantId: createRuntimeId("tenant", seed),
		principalId: createRuntimeId("principal", seed),
		sessionId: createRuntimeId("session", seed),
		repositoryId: createRuntimeId("repository", seed),
		sourceRepo: harness.sourceRepo,
		sourceCwd: harness.sourceCwd,
		label: "artifact",
		baseRef: "HEAD",
		branch: `runledger/${seed}`,
		ownerRuntimeId: createRuntimeId("runtime", seed),
		requestId: createRuntimeId("command", `create-${seed}`),
	};
}

function envelope(created: WorktreeCreateResult, seed: string): WorkspaceExecutionEnvelope {
	return {
		authorityId: created.record.authorityId,
		tenantId: created.record.tenantId,
		principalId: created.record.principalId,
		sessionId: created.record.sessionId,
		workspaceId: created.record.workspaceId,
		repositoryId: created.record.repositoryId,
		worktreePath: created.record.worktreePath,
		branch: created.record.branch,
		baseCommit: created.record.baseCommit,
		agentId: createRuntimeId("agent", seed),
		toolCallId: createRuntimeId("toolCall", seed),
		traceId: createRuntimeId("trace", seed),
		cwd: created.record.effectiveCwd,
		ownerRuntimeId: created.record.ownerRuntimeId,
		leaseRevision: created.lease.leaseRevision,
		fencingToken: created.fencingToken,
	};
}

async function artifactSetup(seed: string, options?: { authorization?: WorktreeForensicAuthorizationPort; keyProvider?: "available" | "unavailable" }) {
	const artifacts = await createArtifactHarness({ keyProvider: options?.keyProvider });
	artifactHarnesses.push(artifacts);
	const accessLog = new MemoryArtifactAccessLog();
	const access = new ArtifactAccessService({
		cas: artifacts.cas,
		metadata: artifacts.metadata,
		gateway: new AllowArtifactGateway(),
		accessLog,
		keyProvider: artifacts.keyProvider,
		clock: () => new Date(NOW),
	});
	const git = new GitOperations(new NodeGitCommandPort());
	const content = new NodeWorktreeContentPort();
	const snapshots = new ArtifactWorkspaceSnapshot({
		repository: artifacts.repository,
		access,
		git,
		content,
		authorization: options?.authorization ?? new ForensicAuthorization(),
	});
	const worktree = await createWorktreeHarness({ snapshots });
	worktrees.push(worktree);
	const request = createRequest(worktree, seed);
	const createdResult = await worktree.manager.create(request);
	if (!createdResult.ok) throw new Error(createdResult.error.message);
	return { artifacts, access, accessLog, git, content, worktree, request, created: createdResult.value, execution: envelope(createdResult.value, seed) };
}

async function checkpoint(value: Awaited<ReturnType<typeof artifactSetup>>, seed: string) {
	const eventCursor = {
		stream: createSessionEventStreamRef(value.request, value.request.sessionId),
		sequence: 4,
		eventId: createRuntimeId("event", seed),
		eventHash: canonicalDigest({ seed, event: 4 }),
	};
	const result = await value.worktree.manager.checkpoint({
		schemaVersion: 1,
		kind: "checkpoint",
		requestId: createRuntimeId("command", `checkpoint-${seed}`),
		authorityId: value.request.authorityId,
		tenantId: value.request.tenantId,
		principalId: value.request.principalId,
		sessionId: value.request.sessionId,
		agentId: value.execution.agentId,
		traceId: value.execution.traceId,
		envelope: value.execution,
		envelopeDigest: workspaceExecutionEnvelopeDigest(value.execution),
		eventCursor,
	});
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value.checkpoint;
}

async function readSnapshotManifest(
	value: Awaited<ReturnType<typeof artifactSetup>>,
	artifactId: NonNullable<Awaited<ReturnType<typeof checkpoint>>["snapshotArtifactId"]>,
): Promise<{ manifest: WorkspaceSnapshotManifest; reference: ArtifactRef }> {
	const read = valueOf(await value.access.read({
		authorityId: value.request.authorityId,
		tenantId: value.request.tenantId,
		artifactId,
		principalId: value.request.principalId,
		sessionId: value.request.sessionId,
		workspaceId: value.created.record.workspaceId,
		capability: "repository_read",
		forensicPurpose: "test checkpoint assembly",
	}));
	const manifest = JSON.parse(Buffer.from(read.content).toString("utf8")) as unknown;
	if (!isWorkspaceSnapshotManifest(manifest)) throw new Error("snapshot manifest is invalid");
	return { manifest, reference: artifactReference(read.metadata) };
}

async function persistComposite(
	value: Awaited<ReturnType<typeof artifactSetup>>,
	workspace: Awaited<ReturnType<typeof checkpoint>>,
): Promise<{ checkpoint: CompositeCheckpointRef; resolver: WorktreeCheckpointArtifactResolverPort }> {
	if (!workspace.snapshotArtifactId) throw new Error("snapshot artifact is missing");
	const snapshot = await readSnapshotManifest(value, workspace.snapshotArtifactId);
	const logical = {
		checkpointId: workspace.checkpointId,
		cursor: workspace.eventCursor,
		reducerDigest: canonicalDigest({ reducer: workspace.checkpointId }),
		activeLeafId: createRuntimeId("leaf", `logical-${workspace.checkpointId.split("_").at(-1)}`),
	};
	const composite = valueOf(createCompositeCheckpoint({
		authorityId: workspace.authorityId,
		tenantId: workspace.tenantId,
		logical,
		workspace,
		workspaceSnapshotManifest: snapshot.manifest,
		workspaceSnapshotManifestRef: snapshot.reference,
		diffArtifacts: [snapshot.manifest.stagedDiffArtifact, snapshot.manifest.unstagedDiffArtifact].filter((entry): entry is ArtifactRef => entry !== undefined),
		untrackedArtifacts: snapshot.manifest.untracked.flatMap((entry) => entry.contentArtifact ? [entry.contentArtifact] : []),
		createdAt: NOW,
	}));
	const artifactId = createRuntimeId("artifact", canonicalDigest({ checkpointId: workspace.checkpointId, kind: "composite" }).slice(0, 48));
	const outcome = valueOf(await value.artifacts.repository.write({
		authorityId: value.request.authorityId,
		tenantId: value.request.tenantId,
		artifactId,
		intentId: createRuntimeId("command", canonicalDigest({ artifactId, operation: "persist" }).slice(0, 48)),
		principalId: value.request.principalId,
		source: {
			sessionId: value.request.sessionId,
			workspaceId: value.created.record.workspaceId,
			producerId: value.request.principalId,
		},
		kind: "session_report",
		mediaType: "application/vnd.runledger.composite-checkpoint+json",
		content: canonicalJson(composite),
		references: [snapshot.reference.artifactId],
		redaction: "forensic",
		forensicAuthorization: { approvalId: createRuntimeId("approval", "composite-checkpoint"), purpose: "physical checkpoint recovery" },
		lineage: { origin: "internal", inputSources: [], declassificationReceipts: [] },
		createdAt: NOW,
	}));
	if (outcome.state !== "committed" || !outcome.reference) throw new Error("composite checkpoint was not committed");
	const reference = outcome.reference;
	const checkpointRef = valueOf(compositeCheckpointRef(composite));
	return {
		checkpoint: checkpointRef,
		resolver: {
			resolve: async (requested) => canonicalDigest(requested) === canonicalDigest(checkpointRef)
				? { ok: true, value: reference }
				: { ok: false, error: { code: "not_found", message: "checkpoint not indexed", retryable: false } },
		},
	};
}

describe("Artifact-backed physical workspace checkpoints", () => {
	it("captures exact encrypted state, rewinds it, replays durably, and physically cleans up the managed worktree", async () => {
		const value = await artifactSetup("physical");
		const trackedPath = join(value.created.record.effectiveCwd, "index.ts");
		const stagedPath = join(value.created.record.effectiveCwd, "staged.ts");
		const untrackedPath = join(value.created.record.effectiveCwd, "untracked.bin");
		const symlinkPath = join(value.created.record.effectiveCwd, "untracked-link");
		await writeFile(trackedPath, "export const checkpoint = 'secret=alpha';\n");
		await writeFile(stagedPath, "export const staged = true;\n");
		await runGit(value.created.record.worktreePath, "add", "packages/app/staged.ts");
		await writeFile(untrackedPath, Buffer.from([0, 1, 2, 255, 10]));
		await symlink("staged.ts", symlinkPath);
		const capturedStatus = valueOf(await value.git.status(value.created.record.worktreePath, value.created.record.baseCommit));
		const workspace = await checkpoint(value, "physical");
		expect(workspace).toMatchObject({ completeness: "complete", snapshotArtifactId: expect.stringMatching(/^artifact_/) });
		const snapshot = await readSnapshotManifest(value, workspace.snapshotArtifactId!);
		expect(snapshot.manifest.completeness).toBe("complete");
		expect(snapshot.manifest.untracked).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: "regular", contentArtifact: expect.objectContaining({ redaction: "encrypted_forensic" }) }),
			expect.objectContaining({ kind: "symlink", symlinkTarget: "staged.ts" }),
		]));
		expect(snapshot.reference.redaction).toBe("encrypted_forensic");
		expect(value.accessLog.entries.some((entry) => entry.operation === "read_forensic")).toBe(true);
		const composite = await persistComposite(value, workspace);
		const effectsPath = join(value.worktree.root, "effects", "workspace-checkpoints.json");
		const createAdapter = () => new ArtifactWorkspaceCheckpoint({
			managedRoot: value.worktree.managedRoot,
			filesystem: nodeWorktreeFileSystem,
			content: value.content,
			git: value.git,
			registry: value.worktree.registry,
			leases: value.worktree.leases,
			artifacts: new RepositoryWorktreeArtifactPort(value.artifacts.repository, value.access),
			checkpointArtifacts: composite.resolver,
			effects: new FileWorktreeCheckpointEffectPort(effectsPath),
			clock: () => new Date(NOW),
		});

		await writeFile(trackedPath, "destroyed\n");
		await writeFile(join(value.created.record.effectiveCwd, "later.txt"), "later\n");
		const rewindRequest = {
			checkpoint: composite.checkpoint,
			envelope: value.execution,
			expectedLeaseRevision: value.execution.leaseRevision,
			targetLeafId: createRuntimeId("leaf", "physical-rewind"),
		};
		const rewound = await createAdapter().rewind(rewindRequest);
		expect(rewound).toMatchObject({ ok: true, value: { outcome: "applied" } });
		expect(await readFile(trackedPath, "utf8")).toBe("export const checkpoint = 'secret=alpha';\n");
		expect([...await readFile(untrackedPath)]).toEqual([0, 1, 2, 255, 10]);
		expect(valueOf(await value.git.status(value.created.record.worktreePath, value.created.record.baseCommit))).toEqual(capturedStatus);
		expect(await createAdapter().rewind(rewindRequest)).toEqual(rewound);

		const cleanupRequest = {
			checkpoint: composite.checkpoint,
			envelope: value.execution,
			expectedLeaseRevision: value.execution.leaseRevision,
		};
		const cleaned = await createAdapter().cleanup(cleanupRequest);
		expect(cleaned).toMatchObject({ ok: true, value: { state: "completed" } });
		expect((await nodeWorktreeFileSystem.stat(value.created.record.worktreePath)).exists).toBe(false);
		expect((await nodeWorktreeFileSystem.stat(value.worktree.sourceRepo)).exists).toBe(true);
		expect(await value.worktree.leases.read(value.created.record.workspaceId)).toBeUndefined();
		expect(await createAdapter().cleanup(cleanupRequest)).toEqual(cleaned);
		const snapshotAfterCleanup = await readSnapshotManifest(value, workspace.snapshotArtifactId!);
		expect(snapshotAfterCleanup.manifest.manifestDigest).toBe(snapshot.manifest.manifestDigest);
	});

	it("marks ignored inputs partial and refuses both physical rewind and cleanup", async () => {
		const value = await artifactSetup("partial");
		await writeFile(join(value.created.record.worktreePath, ".gitignore"), "private.tmp\n");
		await writeFile(join(value.created.record.worktreePath, "private.tmp"), "secret\n");
		const workspace = await checkpoint(value, "partial");
		expect(workspace.completeness).toBe("partial");
		const snapshot = await readSnapshotManifest(value, workspace.snapshotArtifactId!);
		expect(snapshot.manifest.partialReasons).toContain("ignored_excluded");
		const adapter = new ArtifactWorkspaceCheckpoint({
			managedRoot: value.worktree.managedRoot,
			filesystem: nodeWorktreeFileSystem,
			content: value.content,
			git: value.git,
			registry: value.worktree.registry,
			leases: value.worktree.leases,
			artifacts: new RepositoryWorktreeArtifactPort(value.artifacts.repository, value.access),
			checkpointArtifacts: { resolve: async () => ({ ok: false, error: { code: "not_found", message: "must not resolve", retryable: false } }) },
			effects: new FileWorktreeCheckpointEffectPort(join(value.worktree.root, "effects.json")),
		});
		const partialRef: CompositeCheckpointRef = {
			authorityId: workspace.authorityId,
			tenantId: workspace.tenantId,
			checkpointId: workspace.checkpointId,
			checkpointDigest: canonicalDigest({ partial: true }),
			workspaceId: workspace.workspaceId,
			completeness: "partial",
		};
		expect(await adapter.rewind({ checkpoint: partialRef, envelope: value.execution, expectedLeaseRevision: 1, targetLeafId: createRuntimeId("leaf", "partial") })).toMatchObject({ ok: false, error: { code: "fenced" } });
		expect(await adapter.cleanup({ checkpoint: partialRef, envelope: value.execution, expectedLeaseRevision: 1 })).toMatchObject({ ok: false, error: { code: "fenced" } });
		expect((await nodeWorktreeFileSystem.stat(value.created.record.worktreePath)).exists).toBe(true);
	});

	it("fails closed without a real forensic approval/key path and rejects symlink-parent content writes", async () => {
		const denied = await artifactSetup("no-approval", { authorization: new ForensicAuthorization(false) });
		const deniedCheckpoint = await denied.worktree.manager.checkpoint({
			schemaVersion: 1, kind: "checkpoint", requestId: createRuntimeId("command", "no-approval"),
			authorityId: denied.request.authorityId, tenantId: denied.request.tenantId, principalId: denied.request.principalId,
			sessionId: denied.request.sessionId, agentId: denied.execution.agentId, traceId: denied.execution.traceId,
			envelope: denied.execution, envelopeDigest: workspaceExecutionEnvelopeDigest(denied.execution),
			eventCursor: {
				stream: createSessionEventStreamRef(denied.request, denied.request.sessionId),
				sequence: 1,
				eventId: createRuntimeId("event", "no-approval"),
				eventHash: canonicalDigest("no-approval"),
			},
		});
		expect(deniedCheckpoint).toMatchObject({ ok: false, error: { code: "approval_required" } });

		const noKey = await artifactSetup("no-key", { keyProvider: "unavailable" });
		await expect(checkpoint(noKey, "no-key")).rejects.toThrow(/checkpoint_failed/u);

		const outside = join(denied.worktree.root, "outside");
		await mkdir(outside);
		await symlink(outside, join(denied.created.record.worktreePath, "escape"));
		const protectedWrite = await denied.content.replace(
			denied.created.record.worktreePath,
			"escape/pwned.txt",
			{ kind: "regular", mode: "100644", content: Buffer.from("pwned") },
		);
		expect(protectedWrite).toMatchObject({ ok: false, error: { code: "outside_managed_root" } });
		expect((await nodeWorktreeFileSystem.stat(join(outside, "pwned.txt"))).exists).toBe(false);
	});

	it("reconciles rewind and cleanup after terminal receipt persistence fails once", async () => {
		const value = await artifactSetup("effect-recovery");
		const trackedPath = join(value.created.record.effectiveCwd, "index.ts");
		const workspace = await checkpoint(value, "effect-recovery");
		const composite = await persistComposite(value, workspace);
		const effectsPath = join(value.worktree.root, "effects", "fail-once.json");
		const createAdapter = (effects: WorktreeCheckpointEffectPort) => new ArtifactWorkspaceCheckpoint({
			managedRoot: value.worktree.managedRoot,
			filesystem: nodeWorktreeFileSystem,
			content: value.content,
			git: value.git,
			registry: value.worktree.registry,
			leases: value.worktree.leases,
			artifacts: new RepositoryWorktreeArtifactPort(value.artifacts.repository, value.access),
			checkpointArtifacts: composite.resolver,
			effects,
			clock: () => new Date(NOW),
		});

		await writeFile(trackedPath, "mutated after checkpoint\n");
		const rewindRequest = {
			checkpoint: composite.checkpoint,
			envelope: value.execution,
			expectedLeaseRevision: value.execution.leaseRevision,
			targetLeafId: createRuntimeId("leaf", "effect-recovery"),
		};
		const failedRewind = await createAdapter(
			new FailOnceCompleteEffectPort(new FileWorktreeCheckpointEffectPort(effectsPath)),
		).rewind(rewindRequest);
		expect(failedRewind).toMatchObject({ ok: false, error: { code: "durable_write_failed", retryable: true } });
		expect(await readFile(trackedPath, "utf8")).toBe("export const source = true;\n");

		const replayedRewind = await createAdapter(new FileWorktreeCheckpointEffectPort(effectsPath)).rewind(rewindRequest);
		expect(replayedRewind).toMatchObject({ ok: true, value: { outcome: "applied" } });

		const cleanupRequest = {
			checkpoint: composite.checkpoint,
			envelope: value.execution,
			expectedLeaseRevision: value.execution.leaseRevision,
		};
		const failedCleanup = await createAdapter(
			new FailOnceCompleteEffectPort(new FileWorktreeCheckpointEffectPort(effectsPath)),
		).cleanup(cleanupRequest);
		expect(failedCleanup).toMatchObject({ ok: false, error: { code: "durable_write_failed", retryable: true } });
		expect((await nodeWorktreeFileSystem.stat(value.created.record.worktreePath)).exists).toBe(false);
		expect(await value.worktree.leases.read(value.created.record.workspaceId)).toBeUndefined();

		const replayedCleanup = await createAdapter(new FileWorktreeCheckpointEffectPort(effectsPath)).cleanup(cleanupRequest);
		expect(replayedCleanup).toMatchObject({ ok: true, value: { state: "completed" } });
		expect(await createAdapter(new FileWorktreeCheckpointEffectPort(effectsPath)).cleanup(cleanupRequest)).toEqual(replayedCleanup);
	});

	it("fences cleanup when the managed worktree path is replaced by a source-repository symlink", async () => {
		const value = await artifactSetup("cleanup-symlink");
		const workspace = await checkpoint(value, "cleanup-symlink");
		const composite = await persistComposite(value, workspace);
		const adapter = new ArtifactWorkspaceCheckpoint({
			managedRoot: value.worktree.managedRoot,
			filesystem: nodeWorktreeFileSystem,
			content: value.content,
			git: value.git,
			registry: value.worktree.registry,
			leases: value.worktree.leases,
			artifacts: new RepositoryWorktreeArtifactPort(value.artifacts.repository, value.access),
			checkpointArtifacts: composite.resolver,
			effects: new FileWorktreeCheckpointEffectPort(join(value.worktree.root, "effects", "cleanup-symlink.json")),
			clock: () => new Date(NOW),
		});

		await nodeWorktreeFileSystem.rm(value.created.record.worktreePath);
		await symlink(value.worktree.sourceRepo, value.created.record.worktreePath);
		const attackedPath = await nodeWorktreeFileSystem.stat(value.created.record.worktreePath);
		expect(attackedPath).toMatchObject({ exists: true, isSymbolicLink: true });

		const cleanup = await adapter.cleanup({
			checkpoint: composite.checkpoint,
			envelope: value.execution,
			expectedLeaseRevision: value.execution.leaseRevision,
		});
		expect(cleanup).toMatchObject({ ok: false, error: { code: "fenced" } });
		expect(await readFile(join(value.worktree.sourceRepo, "README.md"), "utf8")).toBe("source\n");
		expect(await value.worktree.leases.read(value.created.record.workspaceId)).toBeDefined();
		expect(await value.worktree.registry.get(value.created.record.workspaceId)).toMatchObject({
			ok: true,
			value: { state: "active" },
		});
	});
});
