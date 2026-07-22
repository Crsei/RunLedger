import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactAccessService } from "../../src/runtime/artifacts/access.ts";
import type {
	ArtifactAccessLogPort,
	ArtifactCapabilityGatewayPort,
	ArtifactResult,
} from "../../src/runtime/artifacts/types.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceBindRequest,
} from "../../src/runtime/protocol/v3/workspace.ts";
import { echoTool } from "../../src/runtime/tools/echo.ts";
import type { ToolExecutionGatewayRequest } from "../../src/runtime/types.ts";
import {
	createProductionWorkspaceComposition,
	type ProductionWorkspaceCompositionOptions,
} from "../../src/storage/worktree-production.ts";
import {
	FileWorkspaceLeaseMutationPort,
	FileWorktreeRegistryMutationPort,
	type DurableWorktreeScope,
} from "../../src/storage/worktree-state-adapter.ts";
import type {
	WorkspaceLeaseSecret,
	WorktreeForensicAuthorizationPort,
} from "../../src/worktree/ports.ts";
import { WorktreeRegistry } from "../../src/worktree/registry.ts";
import type { WorktreeRecord } from "../../src/worktree/types.ts";
import { createArtifactHarness, type ArtifactHarness, NOW } from "../runtime-v3/artifacts/helpers.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const worktrees: WorktreeTestHarness[] = [];
const artifacts: ArtifactHarness[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const harness of worktrees.splice(0)) await harness.cleanup();
	for (const harness of artifacts.splice(0)) await harness.cleanup();
	for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

class AllowArtifactGateway implements ArtifactCapabilityGatewayPort {
	public async recheckArtifactAccess(request: Parameters<ArtifactCapabilityGatewayPort["recheckArtifactAccess"]>[0]) {
		return {
			ok: true as const,
			value: {
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				decision: "allow" as const,
				receiptId: createRuntimeId("receipt", canonicalDigest(request).slice(0, 48)),
			},
		};
	}
}

class NullArtifactAccessLog implements ArtifactAccessLogPort {
	public async append(): Promise<ArtifactResult<void>> {
		return { ok: true, value: undefined };
	}
}

class AllowForensicCapture implements WorktreeForensicAuthorizationPort {
	public async authorizeCapture() {
		return {
			ok: true as const,
			value: {
				approvalId: createRuntimeId("approval", "production-workspace-checkpoint"),
				purpose: "production workspace recovery test",
			},
		};
	}
}

function scope(seed: string): DurableWorktreeScope {
	return {
		authorityId: createRuntimeId("authority", seed),
		tenantId: createRuntimeId("tenant", seed),
	};
}

function record(root: string, configuredScope: DurableWorktreeScope, seed: string): WorktreeRecord {
	return {
		authorityId: configuredScope.authorityId,
		tenantId: configuredScope.tenantId,
		principalId: createRuntimeId("principal", seed),
		workspaceId: createRuntimeId("workspace", seed),
		repositoryId: createRuntimeId("repository", seed),
		sessionId: createRuntimeId("session", seed),
		createRequestId: createRuntimeId("command", seed),
		createRequestDigest: canonicalDigest({ seed, kind: "test-record" }),
		bindingKind: "managed_worktree",
		sourceRepo: join(root, "source"),
		sourceCwd: join(root, "source"),
		worktreeId: `worktree_${seed}`,
		worktreePath: join(root, "managed", seed),
		effectiveCwd: join(root, "managed", seed),
		subdirOffset: ".",
		label: seed,
		baseRef: "HEAD",
		baseCommit: "a".repeat(40),
		headCommit: "a".repeat(40),
		branch: `runledger/${seed}`,
		state: "creating",
		createdAt: NOW,
		lastAccessedAt: NOW,
		ownerRuntimeId: createRuntimeId("runtime", seed),
		leaseRevision: 1,
	};
}

function lease(configuredScope: DurableWorktreeScope, seed: string, revision = 1): WorkspaceLeaseSecret {
	const fencingToken = `secret-token-${seed}-${revision}`;
	return {
		record: {
			authorityId: configuredScope.authorityId,
			tenantId: configuredScope.tenantId,
			principalId: createRuntimeId("principal", seed),
			leaseId: createRuntimeId("lease", seed),
			workspaceId: createRuntimeId("workspace", seed),
			ownerRuntimeId: createRuntimeId("runtime", `${seed}-${revision}`),
			leaseRevision: revision,
			fencingTokenDigest: canonicalDigest(fencingToken),
			state: "active",
		},
		fencingToken,
		issuedAt: NOW,
		lastRenewedAt: NOW,
	};
}

async function productionSetup(seed: string) {
	const worktree = await createWorktreeHarness();
	worktrees.push(worktree);
	const artifact = await createArtifactHarness();
	artifacts.push(artifact);
	const configuredScope = scope(seed);
	const access = new ArtifactAccessService({
		cas: artifact.cas,
		metadata: artifact.metadata,
		gateway: new AllowArtifactGateway(),
		accessLog: new NullArtifactAccessLog(),
		keyProvider: artifact.keyProvider,
		clock: () => new Date(NOW),
	});
	const options: ProductionWorkspaceCompositionOptions = {
		scope: configuredScope,
		managedRoot: join(worktree.root, "production-managed"),
		stateRoot: join(worktree.root, "production-state"),
		validatorPrincipalId: createRuntimeId("principal", `${seed}-validator`),
		liveness: worktree.liveness,
		repository: artifact.repository,
		artifactAccess: access,
		forensicAuthorization: new AllowForensicCapture(),
		clock: () => new Date(NOW),
	};
	const info = await worktree.git.inspectRepository(worktree.sourceCwd);
	if (!info.ok) throw new Error(info.error.message);
	return { worktree, configuredScope, options, info: info.value };
}

function bindRequest(
	setup: Awaited<ReturnType<typeof productionSetup>>,
	seed: string,
	bindingKind: "source" | "managed_worktree",
): WorkspaceBindRequest {
	return {
		schemaVersion: 1,
		kind: "bind",
		requestId: createRuntimeId("command", seed),
		authorityId: setup.configuredScope.authorityId,
		tenantId: setup.configuredScope.tenantId,
		principalId: createRuntimeId("principal", seed),
		sessionId: createRuntimeId("session", seed),
		agentId: createRuntimeId("agent", seed),
		traceId: createRuntimeId("trace", seed),
		repositoryId: createRuntimeId("repository", seed),
		bindingKind,
		requestedCwd: setup.worktree.sourceCwd,
		branch: bindingKind === "source" ? setup.info.branch : `runledger/${seed}`,
		baseCommit: setup.info.headCommit,
		ownerRuntimeId: createRuntimeId("runtime", seed),
	};
}

function toolRequest(seed: string, cwd: string): ToolExecutionGatewayRequest {
	return {
		toolCallId: createRuntimeId("toolCall", seed),
		providerToolCallId: `provider-${seed}`,
		tool: echoTool,
		arguments: { text: seed },
		cwd,
		envVars: {},
	};
}

describe("production workspace persistence and composition", () => {
	it("persists scoped registry and lease CAS state with corruption detection", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-worktree-state-"));
		temporaryRoots.push(root);
		const configuredScope = scope("file-state");
		const registryPath = join(root, "state", "registry.json");
		const firstRegistry = new WorktreeRegistry(new FileWorktreeRegistryMutationPort(registryPath, configuredScope));
		const secondRegistry = new WorktreeRegistry(new FileWorktreeRegistryMutationPort(registryPath, configuredScope));
		const [first, second] = await Promise.all([
			firstRegistry.append("upsert", record(root, configuredScope, "registry-one")),
			secondRegistry.append("upsert", record(root, configuredScope, "registry-two")),
		]);
		expect(first.ok && second.ok).toBe(true);
		expect(await new WorktreeRegistry(new FileWorktreeRegistryMutationPort(registryPath, configuredScope)).list(true)).toMatchObject({
			ok: true,
			value: [{ createRequestId: createRuntimeId("command", "registry-one") }, { createRequestId: createRuntimeId("command", "registry-two") }],
		});
		await expect(new FileWorktreeRegistryMutationPort(registryPath, scope("wrong-scope")).verify()).rejects.toThrow(/scope/u);

		const leasePath = join(root, "state", "leases.json");
		const initialLease = lease(configuredScope, "lease-one");
		const firstLeases = new FileWorkspaceLeaseMutationPort(leasePath, configuredScope);
		expect(await firstLeases.create(initialLease)).toBe("applied");
		expect(await new FileWorkspaceLeaseMutationPort(leasePath, configuredScope).read(initialLease.record.workspaceId)).toEqual(initialLease);
		const nextLease = lease(configuredScope, "lease-one", 2);
		expect(await new FileWorkspaceLeaseMutationPort(leasePath, configuredScope).compareAndSwap(
			initialLease.record.workspaceId,
			1,
			nextLease,
		)).toBe("applied");
		expect((await new FileWorkspaceLeaseMutationPort(leasePath, configuredScope).read(initialLease.record.workspaceId))?.record.leaseRevision).toBe(2);

		const raw = JSON.parse(await readFile(leasePath, "utf8")) as Record<string, unknown>;
		raw.stateDigest = "0".repeat(64);
		await writeFile(leasePath, JSON.stringify(raw));
		await expect(new FileWorkspaceLeaseMutationPort(leasePath, configuredScope).verify()).rejects.toThrow(/digest/u);
	});

	it("binds source and managed workspaces, reopens exactly, and keeps raw tokens out of registry", async () => {
		const setup = await productionSetup("production-bind");
		const first = await createProductionWorkspaceComposition(setup.options);
		const sourceRequest = bindRequest(setup, "production-source", "source");
		const managedRequest = bindRequest(setup, "production-managed", "managed_worktree");
		const sourceBound = await first.workspaceService.request(sourceRequest);
		const managedBound = await first.workspaceService.request(managedRequest);
		if (sourceBound.kind !== "bound" || managedBound.kind !== "bound") throw new Error("workspace bind failed");
		expect(sourceBound.binding).toMatchObject({ bindingKind: "source", canonicalCwd: setup.worktree.sourceRepo });
		expect(managedBound.binding).toMatchObject({ bindingKind: "managed_worktree" });
		expect(await setup.worktree.git.isRegistered(setup.worktree.sourceRepo, managedBound.binding.canonicalCwd)).toEqual({ ok: true, value: true });

		const sourceResolver = first.createToolExecutionWorkspaceResolver({
			authorityId: sourceRequest.authorityId,
			tenantId: sourceRequest.tenantId,
			principalId: sourceRequest.principalId,
			sessionId: sourceRequest.sessionId,
			agentId: sourceRequest.agentId,
			traceId: sourceRequest.traceId,
			workspaceId: sourceBound.binding.workspaceId,
			repositoryId: sourceRequest.repositoryId,
			ownerRuntimeId: sourceRequest.ownerRuntimeId,
		});
		const sourceTool = toolRequest("production-source", sourceBound.binding.effectiveCwd);
		const sourceEnvelope = await sourceResolver.resolve(sourceTool);
		expect(sourceEnvelope).toMatchObject({
			workspaceId: sourceBound.binding.workspaceId,
			toolCallId: sourceTool.toolCallId,
			cwd: sourceBound.binding.effectiveCwd,
		});
		expect(await sourceResolver.resolve({ ...sourceTool, cwd: setup.worktree.root })).toBeUndefined();
		if (!sourceEnvelope) throw new Error("source envelope was not resolved");
		expect(await readFile(first.paths.registryFile, "utf8")).not.toContain(sourceEnvelope.fencingToken);
		expect((await stat(first.paths.registryFile)).mode & 0o077).toBe(0);
		expect((await stat(first.paths.leaseFile)).mode & 0o077).toBe(0);

		const reopened = await createProductionWorkspaceComposition(setup.options);
		expect(await reopened.workspaceService.request(sourceRequest)).toEqual(sourceBound);
		expect(await reopened.workspaceService.request(managedRequest)).toEqual(managedBound);
		const listed = await reopened.manager.list();
		expect(listed.ok ? listed.value : []).toHaveLength(2);
		const collisionAfterRestart = await createProductionWorkspaceComposition(setup.options);
		expect(await collisionAfterRestart.workspaceService.request({
			...sourceRequest,
			principalId: createRuntimeId("principal", "production-source-collision"),
		})).toMatchObject({ kind: "rejected", code: "invalid_request" });
	});

	it("recovers a released lease after reopen and fences the old resolver", async () => {
		const setup = await productionSetup("production-resume");
		const first = await createProductionWorkspaceComposition(setup.options);
		const request = bindRequest(setup, "production-resume-managed", "managed_worktree");
		const bound = await first.workspaceService.request(request);
		if (bound.kind !== "bound") throw new Error("managed workspace bind failed");
		const oldResolver = first.createToolExecutionWorkspaceResolver({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
			workspaceId: bound.binding.workspaceId,
			repositoryId: request.repositoryId,
			ownerRuntimeId: request.ownerRuntimeId,
		});
		const invocation = toolRequest("production-resume-old", bound.binding.effectiveCwd);
		const envelope = await oldResolver.resolve(invocation);
		if (!envelope) throw new Error("managed envelope was not resolved");
		const released = await first.workspaceService.request({
			schemaVersion: 1,
			kind: "release",
			requestId: createRuntimeId("command", "production-release"),
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
			envelope,
			envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
			expectedLeaseRevision: envelope.leaseRevision,
		});
		expect(released).toMatchObject({ kind: "released", leaseRevision: 1 });

		const reopened = await createProductionWorkspaceComposition(setup.options);
		const nextOwner = createRuntimeId("runtime", "production-resume-next");
		const resumed = await reopened.manager.resume(bound.binding.workspaceId, {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
		}, nextOwner);
		expect(resumed).toMatchObject({ ok: true, value: { lease: { leaseRevision: 2, ownerRuntimeId: nextOwner } } });
		expect(await oldResolver.resolve(invocation)).toBeUndefined();
		const nextResolver = reopened.createToolExecutionWorkspaceResolver({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
			workspaceId: bound.binding.workspaceId,
			repositoryId: request.repositoryId,
			ownerRuntimeId: nextOwner,
		});
		expect(await nextResolver.resolve({ ...invocation, toolCallId: createRuntimeId("toolCall", "production-resume-next") })).toMatchObject({
			leaseRevision: 2,
			ownerRuntimeId: nextOwner,
		});
	});

	it("wires encrypted Artifact checkpoints and a private durable effect journal", async () => {
		const setup = await productionSetup("production-checkpoint");
		const composition = await createProductionWorkspaceComposition(setup.options);
		const request = bindRequest(setup, "production-checkpoint-managed", "managed_worktree");
		const bound = await composition.workspaceService.request(request);
		if (bound.kind !== "bound") throw new Error("managed workspace bind failed");
		const resolver = composition.createToolExecutionWorkspaceResolver({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
			workspaceId: bound.binding.workspaceId,
			repositoryId: request.repositoryId,
			ownerRuntimeId: request.ownerRuntimeId,
		});
		const envelope = await resolver.resolve(toolRequest("production-checkpoint", bound.binding.effectiveCwd));
		if (!envelope) throw new Error("managed envelope was not resolved");
		const checkpointed = await composition.workspaceService.request({
			schemaVersion: 1,
			kind: "checkpoint",
			requestId: createRuntimeId("command", "production-checkpoint"),
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: request.agentId,
			traceId: request.traceId,
			envelope,
			envelopeDigest: workspaceExecutionEnvelopeDigest(envelope),
			eventCursor: {
				stream: createSessionEventStreamRef(request, request.sessionId),
				sequence: 1,
				eventId: createRuntimeId("event", "production-checkpoint"),
				eventHash: canonicalDigest("production-checkpoint"),
			},
		});
		expect(checkpointed).toMatchObject({
			kind: "checkpointed",
			checkpoint: { completeness: "complete", snapshotArtifactId: expect.stringMatching(/^artifact_/u) },
		});
		expect(JSON.parse(await readFile(composition.paths.effectFile, "utf8"))).toEqual({ version: 1, records: {} });
		expect((await stat(composition.paths.effectFile)).mode & 0o077).toBe(0);
	});

	it("fails production reopen closed on scope, digest, or file-permission corruption", async () => {
		const setup = await productionSetup("production-corruption");
		const first = await createProductionWorkspaceComposition(setup.options);
		const registryRaw = await readFile(first.paths.registryFile, "utf8");
		const leaseRaw = await readFile(first.paths.leaseFile, "utf8");

		await expect(createProductionWorkspaceComposition({
			...setup.options,
			scope: { ...setup.configuredScope, tenantId: createRuntimeId("tenant", "wrong-production-scope") },
		})).rejects.toThrow(/scope/u);

		const registry = JSON.parse(registryRaw) as Record<string, unknown>;
		registry.stateDigest = "f".repeat(64);
		await writeFile(first.paths.registryFile, JSON.stringify(registry));
		await expect(createProductionWorkspaceComposition(setup.options)).rejects.toThrow(/digest/u);
		await writeFile(first.paths.registryFile, registryRaw);

		const leases = JSON.parse(leaseRaw) as Record<string, unknown>;
		leases.stateDigest = "e".repeat(64);
		await writeFile(first.paths.leaseFile, JSON.stringify(leases));
		await expect(createProductionWorkspaceComposition(setup.options)).rejects.toThrow(/digest/u);
		await writeFile(first.paths.leaseFile, leaseRaw);

		await chmod(first.paths.leaseFile, 0o644);
		await expect(createProductionWorkspaceComposition(setup.options)).rejects.toThrow(/private|mode/u);
	});

	it("rejects a source binding that overlaps the production control-plane state root", async () => {
		const setup = await productionSetup("production-root-overlap");
		const composition = await createProductionWorkspaceComposition({
			...setup.options,
			stateRoot: join(setup.worktree.sourceRepo, ".runledger-production-state"),
		});
		const request = bindRequest(setup, "production-root-overlap-source", "source");
		expect(await composition.workspaceService.request(request)).toMatchObject({
			kind: "rejected",
			code: "outside_managed_root",
		});
		expect(await composition.manager.list(true)).toEqual({ ok: true, value: [] });
	});
});
