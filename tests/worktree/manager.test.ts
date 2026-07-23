import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type WorkspaceId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceReleaseReceiptRef,
	type WorkspaceReleaseRequest,
} from "../../src/runtime/protocol/v3/workspace.ts";
import { nodeWorktreeFileSystem } from "../../src/storage/worktree-node-adapter.ts";
import { RuntimeWorkspaceServiceAdapter } from "../../src/worktree/integration/runtime-workspace-adapter.ts";
import { WorktreeManager } from "../../src/worktree/manager.ts";
import type {
	WorkspaceLeaseMutationPort,
	WorkspaceLeaseSecret,
	WorktreeReleaseJournalPort,
	WorktreeRegistryMutationPort,
} from "../../src/worktree/ports.ts";
import { WorktreeRegistry } from "../../src/worktree/registry.ts";
import { MemoryWorktreeReleaseJournalPort } from "../../src/worktree/release-journal.ts";
import type {
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreeRecord,
	WorktreeRegistryEntry,
	WorktreeRuntimeContext,
} from "../../src/worktree/types.ts";
import { createWorktreeHarness, type WorktreeTestHarness } from "./fixtures.ts";

const harnesses: WorktreeTestHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function createRequest(harness: WorktreeTestHarness, seed = "manager"): Promise<WorktreeCreateRequest> {
	return {
		authorityId: createRuntimeId("authority", seed), tenantId: createRuntimeId("tenant", seed),
		principalId: createRuntimeId("principal", seed), sessionId: createRuntimeId("session", seed),
		repositoryId: createRuntimeId("repository", seed), sourceRepo: harness.sourceRepo, sourceCwd: harness.sourceCwd,
		label: "task", baseRef: "HEAD", branch: `runledger/${seed}`, ownerRuntimeId: createRuntimeId("runtime", `${seed}-one`),
		requestId: createRuntimeId("command", `create-${seed}`),
	};
}

class FaultInjectingRegistryMutationPort implements WorktreeRegistryMutationPort {
	readonly #entries: WorktreeRegistryEntry[] = [];
	#failNext = false;

	public failNextAppend(): void {
		this.#failNext = true;
	}

	public async read(): Promise<readonly WorktreeRegistryEntry[]> {
		return this.#entries.map((entry) => structuredClone(entry));
	}

	public async append(entry: WorktreeRegistryEntry, expectedRevision: number): Promise<"applied" | "conflict"> {
		if (this.#failNext) {
			this.#failNext = false;
			throw new Error("injected registry append failure");
		}
		if (this.#entries.length !== expectedRevision || entry.revision !== expectedRevision + 1) return "conflict";
		this.#entries.push(structuredClone(entry));
		return "applied";
	}
}

class FailRegistryAfterReleasedLeaseCas implements WorkspaceLeaseMutationPort {
	readonly #delegate: WorkspaceLeaseMutationPort;
	readonly #registry: FaultInjectingRegistryMutationPort;
	releaseCasCount = 0;

	public constructor(delegate: WorkspaceLeaseMutationPort, registry: FaultInjectingRegistryMutationPort) {
		this.#delegate = delegate;
		this.#registry = registry;
	}

	public read(workspaceId: WorkspaceId): Promise<WorkspaceLeaseSecret | undefined> {
		return this.#delegate.read(workspaceId);
	}

	public create(secret: WorkspaceLeaseSecret): Promise<"applied" | "conflict"> {
		return this.#delegate.create(secret);
	}

	public async compareAndSwap(
		workspaceId: WorkspaceId,
		expectedRevision: number,
		expectedSecretDigest: string,
		next: WorkspaceLeaseSecret,
	): Promise<"applied" | "conflict"> {
		const result = await this.#delegate.compareAndSwap(
			workspaceId,
			expectedRevision,
			expectedSecretDigest,
			next,
		);
		if (result === "applied" && next.record.state === "released") {
			this.releaseCasCount += 1;
			this.#registry.failNextAppend();
		}
		return result;
	}

	public remove(
		workspaceId: WorkspaceId,
		expectedRevision: number,
		expectedSecretDigest: string,
	): Promise<"applied" | "conflict" | "not_found"> {
		return this.#delegate.remove(workspaceId, expectedRevision, expectedSecretDigest);
	}
}

class CompletionFaultJournal implements WorktreeReleaseJournalPort {
	readonly #delegate: WorktreeReleaseJournalPort;
	readonly #mode: "before" | "after";
	#failed = false;

	public constructor(delegate: WorktreeReleaseJournalPort, mode: "before" | "after") {
		this.#delegate = delegate;
		this.#mode = mode;
	}

	public read(operationId: Parameters<WorktreeReleaseJournalPort["read"]>[0]) {
		return this.#delegate.read(operationId);
	}

	public begin(record: Parameters<WorktreeReleaseJournalPort["begin"]>[0]) {
		return this.#delegate.begin(record);
	}

	public async complete(
		operationId: Parameters<WorktreeReleaseJournalPort["complete"]>[0],
		expectedRequestDigest: Parameters<WorktreeReleaseJournalPort["complete"]>[1],
		record: Parameters<WorktreeReleaseJournalPort["complete"]>[2],
	): Promise<"applied" | "replay" | "conflict"> {
		if (!this.#failed) {
			this.#failed = true;
			if (this.#mode === "after") {
				await this.#delegate.complete(operationId, expectedRequestDigest, record);
			}
			throw new Error(`injected release completion ${this.#mode}-write failure`);
		}
		return this.#delegate.complete(operationId, expectedRequestDigest, record);
	}
}

class BlockingRetainedRegistryMutationPort implements WorktreeRegistryMutationPort {
	readonly #delegate = new FaultInjectingRegistryMutationPort();
	readonly #blocked: Promise<void>;
	readonly #continued: Promise<void>;
	#resolveBlocked: () => void = () => undefined;
	#resolveContinued: () => void = () => undefined;
	#didBlock = false;

	public constructor() {
		this.#blocked = new Promise((resolve) => {
			this.#resolveBlocked = resolve;
		});
		this.#continued = new Promise((resolve) => {
			this.#resolveContinued = resolve;
		});
	}

	public waitUntilBlocked(): Promise<void> {
		return this.#blocked;
	}

	public continue(): void {
		this.#resolveContinued();
	}

	public read(): Promise<readonly WorktreeRegistryEntry[]> {
		return this.#delegate.read();
	}

	public async append(
		entry: WorktreeRegistryEntry,
		expectedRevision: number,
	): Promise<"applied" | "conflict"> {
		if (!this.#didBlock && entry.record.state === "retained") {
			this.#didBlock = true;
			this.#resolveBlocked();
			await this.#continued;
		}
		return this.#delegate.append(entry, expectedRevision);
	}
}

interface RegistryAppendGate {
	blocked: Promise<void>;
	continue(): void;
}

class PredicateBlockingRegistryMutationPort implements WorktreeRegistryMutationPort {
	readonly #delegate = new FaultInjectingRegistryMutationPort();
	#predicate?: (entry: WorktreeRegistryEntry) => boolean;
	#resolveBlocked: () => void = () => undefined;
	#continued: Promise<void> = Promise.resolve();

	public blockNext(predicate: (entry: WorktreeRegistryEntry) => boolean): RegistryAppendGate {
		let resolveContinued: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => {
			this.#resolveBlocked = resolve;
		});
		this.#continued = new Promise<void>((resolve) => {
			resolveContinued = resolve;
		});
		this.#predicate = predicate;
		return {
			blocked,
			continue: () => {
				resolveContinued();
			},
		};
	}

	public read(): Promise<readonly WorktreeRegistryEntry[]> {
		return this.#delegate.read();
	}

	public async append(
		entry: WorktreeRegistryEntry,
		expectedRevision: number,
	): Promise<"applied" | "conflict"> {
		if (this.#predicate?.(entry)) {
			this.#predicate = undefined;
			this.#resolveBlocked();
			await this.#continued;
		}
		return this.#delegate.append(entry, expectedRevision);
	}
}

let managerTokenSequence = 0;

function managerWithRegistry(
	harness: WorktreeTestHarness,
	registry: WorktreeRegistry,
	releaseJournal: WorktreeReleaseJournalPort,
	leases: WorkspaceLeaseMutationPort = harness.leases,
): WorktreeManager {
	return new WorktreeManager({
		managedRoot: harness.managedRoot,
		filesystem: nodeWorktreeFileSystem,
		git: harness.git,
		registry,
		releaseJournal,
		leases,
		tokens: {
			issue: async () => {
				managerTokenSequence += 1;
				return `manager-release-token-${managerTokenSequence}`;
			},
		},
		liveness: harness.liveness,
		validatorPrincipalId: createRuntimeId("principal", "workspace-validator"),
		clock: () => harness.clock.now,
	});
}

function envelope(result: WorktreeCreateResult): WorkspaceExecutionEnvelope {
	return {
		authorityId: result.record.authorityId, tenantId: result.record.tenantId, principalId: result.record.principalId,
		sessionId: result.record.sessionId, workspaceId: result.record.workspaceId, repositoryId: result.record.repositoryId,
		worktreePath: result.record.worktreePath, branch: result.record.branch, baseCommit: result.record.baseCommit,
		agentId: createRuntimeId("agent", "manager"), toolCallId: createRuntimeId("toolCall", "manager"), traceId: createRuntimeId("trace", "manager"),
		cwd: result.record.effectiveCwd, ownerRuntimeId: result.record.ownerRuntimeId, leaseRevision: result.lease.leaseRevision,
		fencingToken: result.fencingToken,
	};
}

function releaseRequest(
	request: WorktreeCreateRequest,
	created: WorktreeCreateResult,
	seed: string,
): WorkspaceReleaseRequest {
	const execution = envelope(created);
	return {
		schemaVersion: 1,
		kind: "release",
		requestId: createRuntimeId("command", `release-${seed}`),
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		principalId: request.principalId,
		sessionId: request.sessionId,
		agentId: execution.agentId,
		traceId: execution.traceId,
		envelope: execution,
		envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
		callerRequestDigest: canonicalDigest({ kind: "manager_release", seed }),
		expectedLeaseId: created.lease.leaseId,
		expectedLeaseRevision: created.lease.leaseRevision,
	};
}

describe("WorktreeManager", () => {
	it("creates one isolated worktree, preserves subdir offset, and replays create idempotently", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const request = await createRequest(harness);
		const first = await harness.manager.create(request);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.record.effectiveCwd).toBe(join(first.value.record.worktreePath, "packages", "app"));
		expect(first.value.runtimeBinding).toMatchObject({ bindingKind: "managed_worktree", branch: "runledger/manager" });
		await writeFile(join(first.value.record.effectiveCwd, "index.ts"), "export const isolated = true;\n");
		expect(await readFile(join(harness.sourceCwd, "index.ts"), "utf8")).toBe("export const source = true;\n");
		const replay = await harness.manager.create(request);
		expect(replay).toEqual(first);
	});

	it("validates canonical Git identity and exact fencing token", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const created = await harness.manager.create(await createRequest(harness, "validate"));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const execution = envelope(created.value);
		expect(await harness.manager.validate(execution)).toMatchObject({ ok: true, value: { validation: { outcome: "valid" } } });
		expect(await harness.manager.validate({ ...execution, fencingToken: "wrong-token" })).toMatchObject({ ok: false, error: { code: "lease_conflict" } });
		expect(await harness.manager.validate({ ...execution, cwd: harness.sourceRepo })).toMatchObject({ ok: false });
	});

	it("checkpoints, releases, and resumes with a higher fencing revision", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const request = await createRequest(harness, "resume");
		const created = await harness.manager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const execution = envelope(created.value);
		const checkpoint = await harness.manager.checkpoint({
			schemaVersion: 1, kind: "checkpoint", requestId: createRuntimeId("command", "checkpoint-resume"),
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: createRuntimeId("agent", "resume"), traceId: createRuntimeId("trace", "resume"),
			envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
			eventCursor: {
				stream: createSessionEventStreamRef(request, request.sessionId),
				sequence: 1,
				eventId: createRuntimeId("event", "resume"),
				eventHash: "a".repeat(64),
			},
		});
		if (!checkpoint.ok) throw new Error(checkpoint.error.message);
		expect(await harness.manager.release({
			schemaVersion: 1, kind: "release", requestId: createRuntimeId("command", "release-resume-invalid-checkpoint"),
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: execution.agentId, traceId: execution.traceId,
			envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
			callerRequestDigest: canonicalDigest("manager-release-resume-invalid-checkpoint"),
			expectedLeaseId: created.value.lease.leaseId, expectedLeaseRevision: 1,
			checkpoint: { ...checkpoint.value.checkpoint, baseCommit: "f".repeat(40) },
		})).toMatchObject({ ok: false, error: { code: "checkpoint_required" } });
		const released = await harness.manager.release({
			schemaVersion: 1, kind: "release", requestId: createRuntimeId("command", "release-resume"),
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: execution.agentId, traceId: execution.traceId,
			envelope: execution, envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
			callerRequestDigest: canonicalDigest("manager-release-resume"),
			expectedLeaseId: created.value.lease.leaseId, expectedLeaseRevision: 1,
			checkpoint: checkpoint.value.checkpoint,
		});
		expect(released).toMatchObject({ ok: true, value: { record: { state: "retained" } } });
		const context: WorktreeRuntimeContext = {
			authorityId: request.authorityId, tenantId: request.tenantId, principalId: request.principalId,
			sessionId: request.sessionId, agentId: createRuntimeId("agent", "resume-two"), traceId: createRuntimeId("trace", "resume-two"),
		};
		const resumed = await harness.manager.resume(created.value.record.workspaceId, context, createRuntimeId("runtime", "resume-two"));
		expect(resumed).toMatchObject({ ok: true, value: { lease: { leaseRevision: 2, state: "active" } } });
		if (!resumed.ok) return;
		expect(resumed.value.fencingToken).not.toBe(created.value.fencingToken);
	});

	it("does not take over a live or recently accessed lease", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const created = await harness.manager.create(await createRequest(harness, "takeover"));
		if (!created.ok) throw new Error(created.error.message);
		harness.liveness.owners = [created.value.record.ownerRuntimeId];
		expect(await harness.manager.takeoverStale(
			created.value.record.workspaceId,
			createRuntimeId("runtime", "takeover-two"),
			1,
			new Date("2026-07-23T00:00:00.000Z"),
		)).toMatchObject({ ok: false, error: { code: "active" } });
	});

	it("returns durable release authority evidence and cold-replays the exact receipt", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new FaultInjectingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const firstManager = managerWithRegistry(harness, registry, releaseJournal);
		const request = await createRequest(harness, "release-authority");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const release = releaseRequest(request, created.value, "release-authority");

		expect(await firstManager.release({
			...release,
			authorityId: createRuntimeId("authority", "release-authority-wrong"),
		})).toMatchObject({ ok: false, error: { code: "invalid_scope" } });
		expect(await firstManager.release({
			...release,
			agentId: createRuntimeId("agent", "release-authority-wrong"),
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await firstManager.release({
			...release,
			traceId: createRuntimeId("trace", "release-authority-wrong"),
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const released = await firstManager.release(release);
		if (!released.ok) throw new Error(released.error.message);
		expectTypeOf(released.value).toEqualTypeOf<{
			receipt: WorkspaceReleaseReceiptRef;
			record: WorktreeRecord;
		}>();
		const result = released.value as typeof released.value & { receipt: WorkspaceReleaseReceiptRef };
		const expectedReleasedLease = { ...created.value.lease, state: "released" as const };
		expect(result.receipt).toMatchObject({
			schemaVersion: 1,
			kind: "workspace_release_receipt",
			requestId: release.requestId,
			requestDigest: canonicalDigest(release),
			authorityId: release.authorityId,
			tenantId: release.tenantId,
			principalId: release.principalId,
			sessionId: release.sessionId,
			agentId: release.agentId,
			envelopeDigest: release.envelopeDigest,
			workspaceId: release.envelope.workspaceId,
			repositoryId: release.envelope.repositoryId,
			leaseId: expectedReleasedLease.leaseId,
			leaseRevision: expectedReleasedLease.leaseRevision,
			releasedLeaseDigest: canonicalDigest(expectedReleasedLease),
			retainedRecordDigest: canonicalDigest(result.record),
			releasedAt: "2026-07-22T00:00:00.000Z",
		});
		expect(result.receipt.receiptId).toMatch(/^receipt_/u);
		const { receiptDigest, ...receiptBody } = result.receipt;
		expect(receiptDigest).toBe(canonicalDigest(receiptBody));

		expect(await registry.append("upsert", {
			...result.record,
			state: "active",
			lease: result.record.lease
				? { ...result.record.lease, state: "active" }
				: undefined,
		})).toMatchObject({ ok: true });
		harness.clock.now = new Date("2026-07-23T00:00:00.000Z");
		const coldManager = managerWithRegistry(harness, registry, releaseJournal);
		expect(await coldManager.release(release)).toEqual(released);
		expect(await coldManager.replayRelease({
			requestId: release.requestId,
			callerRequestDigest: release.callerRequestDigest,
			authorityId: release.authorityId,
			tenantId: release.tenantId,
			principalId: release.principalId,
			sessionId: release.sessionId,
			agentId: release.agentId,
			workspaceId: release.envelope.workspaceId,
			leaseId: release.expectedLeaseId,
			leaseRevision: release.expectedLeaseRevision,
		})).toEqual(released);
		expect(await coldManager.replayRelease({
			requestId: release.requestId,
			callerRequestDigest: release.callerRequestDigest,
			authorityId: release.authorityId,
			tenantId: createRuntimeId("tenant", "release-authority-wrong"),
			principalId: release.principalId,
			sessionId: release.sessionId,
			agentId: release.agentId,
			workspaceId: release.envelope.workspaceId,
			leaseId: release.expectedLeaseId,
			leaseRevision: release.expectedLeaseRevision,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await registry.get(result.record.workspaceId)).toMatchObject({
			ok: true,
			value: { state: "active", lease: { state: "active" } },
		});

		const resumed = await coldManager.resume(
			result.record.workspaceId,
			{
				authorityId: release.authorityId,
				tenantId: release.tenantId,
				principalId: release.principalId,
				sessionId: release.sessionId,
				agentId: release.agentId,
				traceId: release.traceId,
			},
			createRuntimeId("runtime", "release-authority-resumed"),
		);
		expect(resumed).toMatchObject({ ok: true, value: { lease: { leaseRevision: 2 } } });
		expect(await coldManager.release(release)).toEqual(released);
	});

	it("cold-completes the registry record after lease release CAS succeeds but registry append fails", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new FaultInjectingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const leases = new FailRegistryAfterReleasedLeaseCas(harness.leases, storage);
		const firstManager = managerWithRegistry(harness, registry, releaseJournal, leases);
		const request = await createRequest(harness, "release-reconcile");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const release = releaseRequest(request, created.value, "release-reconcile");

		const interrupted = await firstManager.release(release);
		expect(interrupted.ok).toBe(false);
		expect(leases.releaseCasCount).toBe(1);
		expect(await harness.leases.read(created.value.record.workspaceId)).toMatchObject({
			record: { state: "released", leaseRevision: created.value.lease.leaseRevision },
			lastRenewedAt: "2026-07-22T00:00:00.000Z",
		});

		harness.clock.now = new Date("2026-07-24T00:00:00.000Z");
		const coldManager = managerWithRegistry(harness, registry, releaseJournal, leases);
		const reconciled = await coldManager.release(release);
		if (!reconciled.ok) throw new Error(reconciled.error.message);
		const result = reconciled.value as typeof reconciled.value & { receipt: WorkspaceReleaseReceiptRef };
		expect(result.record).toMatchObject({ state: "retained", lease: { state: "released" } });
		expect(result.receipt).toMatchObject({
			requestId: release.requestId,
			requestDigest: canonicalDigest(release),
			releasedAt: "2026-07-22T00:00:00.000Z",
			retainedRecordDigest: canonicalDigest(result.record),
		});
		expect(leases.releaseCasCount).toBe(1);
		expect(await registry.get(created.value.record.workspaceId)).toEqual({ ok: true, value: result.record });
	});

	it("cold-reconciles an incomplete release and lets retryable service failures re-enter the manager", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new FaultInjectingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const durableJournal = new MemoryWorktreeReleaseJournalPort();
		const beforeWriteJournal = new CompletionFaultJournal(durableJournal, "before");
		const firstManager = managerWithRegistry(harness, registry, beforeWriteJournal);
		const request = await createRequest(harness, "release-cold-replay");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const release = releaseRequest(request, created.value, "release-cold-replay");
		expect(await firstManager.release(release)).toMatchObject({
			ok: false,
			error: { code: "uncertain", retryable: true },
		});

		const coldManager = managerWithRegistry(harness, registry, durableJournal);
		const replayed = await coldManager.replayRelease({
			requestId: release.requestId,
			callerRequestDigest: release.callerRequestDigest,
			authorityId: release.authorityId,
			tenantId: release.tenantId,
			principalId: release.principalId,
			sessionId: release.sessionId,
			agentId: release.agentId,
			workspaceId: release.envelope.workspaceId,
			leaseId: release.expectedLeaseId,
			leaseRevision: release.expectedLeaseRevision,
		});
		expect(replayed).toMatchObject({
			ok: true,
			value: {
				receipt: {
					requestId: release.requestId,
					callerRequestDigest: release.callerRequestDigest,
				},
				record: { state: "retained" },
			},
		});

		const serviceStorage = new FaultInjectingRegistryMutationPort();
		const serviceRegistry = new WorktreeRegistry(serviceStorage);
		const serviceDurableJournal = new MemoryWorktreeReleaseJournalPort();
		const serviceManager = managerWithRegistry(
			harness,
			serviceRegistry,
			new CompletionFaultJournal(serviceDurableJournal, "after"),
		);
		const serviceRequest = await createRequest(harness, "release-service-retry");
		const serviceCreated = await serviceManager.create(serviceRequest);
		if (!serviceCreated.ok) throw new Error(serviceCreated.error.message);
		const serviceRelease = releaseRequest(serviceRequest, serviceCreated.value, "release-service-retry");
		const service = new RuntimeWorkspaceServiceAdapter(serviceManager);
		expect(await service.request(serviceRelease)).toMatchObject({
			kind: "rejected",
			code: "uncertain",
			retryable: true,
		});
		expect(await service.request(serviceRelease)).toMatchObject({
			kind: "released",
			receipt: {
				requestId: serviceRelease.requestId,
				callerRequestDigest: serviceRelease.callerRequestDigest,
			},
		});
		expect(await service.request({
			...serviceRelease,
			callerRequestDigest: canonicalDigest("release-service-retry-conflict"),
		})).toMatchObject({ kind: "rejected", code: "idempotency_conflict", retryable: false });
	});

	it("does not let a delayed release registry append overwrite a resumed higher revision", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new BlockingRetainedRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const firstManager = managerWithRegistry(harness, registry, releaseJournal);
		const request = await createRequest(harness, "release-resume-race");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const release = releaseRequest(request, created.value, "release-resume-race");
		const releasing = firstManager.release(release);
		await storage.waitUntilBlocked();

		const coldManager = managerWithRegistry(harness, registry, releaseJournal);
		const resumed = await coldManager.resume(
			created.value.record.workspaceId,
			{
				authorityId: release.authorityId,
				tenantId: release.tenantId,
				principalId: release.principalId,
				sessionId: release.sessionId,
				agentId: release.agentId,
				traceId: release.traceId,
			},
			createRuntimeId("runtime", "release-resume-race-next"),
		);
		expect(resumed).toMatchObject({
			ok: true,
			value: { lease: { state: "active", leaseRevision: 2 } },
		});
		storage.continue();
		expect(await releasing).toMatchObject({ ok: false, error: { code: "registry_failed" } });
		expect(await harness.leases.read(created.value.record.workspaceId)).toMatchObject({
			record: { state: "active", leaseRevision: 2 },
		});
		expect(await registry.get(created.value.record.workspaceId)).toMatchObject({
			ok: true,
			value: { state: "active", leaseRevision: 2, lease: { state: "active", leaseRevision: 2 } },
		});
	});

	it("does not let a delayed validation projection roll back a completed handoff", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new PredicateBlockingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const firstManager = managerWithRegistry(harness, registry, releaseJournal);
		const request = await createRequest(harness, "validate-handoff-race");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const execution = envelope(created.value);
		const gate = storage.blockNext((entry) =>
			entry.record.workspaceId === created.value.record.workspaceId &&
			entry.record.state === "active" &&
			entry.record.leaseRevision === 1);
		const validating = firstManager.validate(execution);
		await gate.blocked;

		const nextOwner = createRuntimeId("runtime", "validate-handoff-race-next");
		const coldManager = managerWithRegistry(harness, registry, releaseJournal);
		expect(await coldManager.handoff(
			created.value.record.workspaceId,
			created.value.record.ownerRuntimeId,
			nextOwner,
			1,
		)).toMatchObject({
			ok: true,
			value: { result: { lease: { ownerRuntimeId: nextOwner, leaseRevision: 2 } } },
		});
		gate.continue();
		expect(await validating).toMatchObject({
			ok: false,
			error: { code: "registry_failed" },
		});
		expect(await registry.get(created.value.record.workspaceId)).toMatchObject({
			ok: true,
			value: {
				state: "active",
				ownerRuntimeId: nextOwner,
				leaseRevision: 2,
				lease: { ownerRuntimeId: nextOwner, leaseRevision: 2 },
			},
		});
		expect(await harness.leases.read(created.value.record.workspaceId)).toMatchObject({
			record: { ownerRuntimeId: nextOwner, leaseRevision: 2 },
		});
	});

	it("does not let a delayed resume projection revive a physically removed worktree", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new PredicateBlockingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const firstManager = managerWithRegistry(harness, registry, releaseJournal);
		const request = await createRequest(harness, "resume-remove-race");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const execution = envelope(created.value);
		const checkpointed = await firstManager.checkpoint({
			schemaVersion: 1,
			kind: "checkpoint",
			requestId: createRuntimeId("command", "resume-remove-race-checkpoint"),
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			sessionId: request.sessionId,
			agentId: execution.agentId,
			traceId: execution.traceId,
			envelope: execution,
			envelopeDigest: workspaceExecutionEnvelopeDigest(execution),
			eventCursor: {
				stream: createSessionEventStreamRef(request, request.sessionId),
				sequence: 1,
				eventId: createRuntimeId("event", "resume-remove-race"),
				eventHash: canonicalDigest("resume-remove-race"),
			},
		});
		if (!checkpointed.ok) throw new Error(checkpointed.error.message);
		const release = {
			...releaseRequest(request, created.value, "resume-remove-race"),
			checkpoint: checkpointed.value.checkpoint,
		};
		const released = await firstManager.release(release);
		if (!released.ok) throw new Error(released.error.message);

		const gate = storage.blockNext((entry) =>
			entry.record.workspaceId === created.value.record.workspaceId &&
			entry.record.state === "active" &&
			entry.record.leaseRevision === 2);
		const nextOwner = createRuntimeId("runtime", "resume-remove-race-next");
		const resuming = firstManager.resume(
			created.value.record.workspaceId,
			{
				authorityId: request.authorityId,
				tenantId: request.tenantId,
				principalId: request.principalId,
				sessionId: request.sessionId,
				agentId: execution.agentId,
				traceId: execution.traceId,
			},
			nextOwner,
		);
		await gate.blocked;

		const coldManager = managerWithRegistry(harness, registry, releaseJournal);
		const removed = await coldManager.remove({
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			principalId: request.principalId,
			workspaceId: created.value.record.workspaceId,
			dryRun: false,
			force: false,
			expectedLeaseRevision: 2,
			requestId: createRuntimeId("command", "resume-remove-race-remove"),
			checkpoint: checkpointed.value.checkpoint,
		});
		expect(removed).toMatchObject({ ok: true });
		gate.continue();
		expect(await resuming).toMatchObject({
			ok: false,
			error: { code: "registry_failed" },
		});
		expect(await registry.get(created.value.record.workspaceId)).toMatchObject({
			ok: true,
			value: { state: "removed" },
		});
		expect(await harness.leases.read(created.value.record.workspaceId)).toBeUndefined();
		expect(await nodeWorktreeFileSystem.stat(created.value.record.worktreePath)).toMatchObject({
			exists: false,
		});
	});

	it("fences same-revision stale lease transitions with the exact secret digest", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const created = await harness.manager.create(await createRequest(harness, "lease-exact-cas"));
		if (!created.ok) throw new Error(created.error.message);
		const stale = await harness.leases.read(created.value.record.workspaceId);
		if (!stale) throw new Error("active lease was not persisted");
		const released = {
			...stale,
			record: { ...stale.record, state: "released" as const },
		};
		expect(await harness.leases.compareAndSwap(
			stale.record.workspaceId,
			stale.record.leaseRevision,
			canonicalDigest(stale),
			released,
		)).toBe("applied");
		const staleHandoff = {
			...stale,
			record: {
				...stale.record,
				ownerRuntimeId: createRuntimeId("runtime", "lease-exact-cas-next"),
				leaseRevision: stale.record.leaseRevision + 1,
				state: "active" as const,
			},
		};
		expect(await harness.leases.compareAndSwap(
			stale.record.workspaceId,
			stale.record.leaseRevision,
			canonicalDigest(stale),
			staleHandoff,
		)).toBe("conflict");
		const staleRevocation = {
			...stale,
			record: { ...stale.record, state: "revoked" as const },
		};
		expect(await harness.leases.compareAndSwap(
			stale.record.workspaceId,
			stale.record.leaseRevision,
			canonicalDigest(stale),
			staleRevocation,
		)).toBe("conflict");
		const currentReleased = await harness.leases.read(stale.record.workspaceId);
		if (!currentReleased) throw new Error("released lease disappeared");
		const revoked = {
			...currentReleased,
			record: { ...currentReleased.record, state: "revoked" as const },
		};
		expect(await harness.leases.compareAndSwap(
			stale.record.workspaceId,
			stale.record.leaseRevision,
			canonicalDigest(currentReleased),
			revoked,
		)).toBe("applied");
		expect(await harness.manager.resume(
			stale.record.workspaceId,
			{
				authorityId: stale.record.authorityId,
				tenantId: stale.record.tenantId,
				principalId: stale.record.principalId,
				sessionId: created.value.record.sessionId,
				agentId: createRuntimeId("agent", "lease-exact-cas"),
				traceId: createRuntimeId("trace", "lease-exact-cas"),
			},
			createRuntimeId("runtime", "lease-exact-cas-resume"),
		)).toMatchObject({ ok: false, error: { code: "lease_conflict" } });
	});

	it("rejects a cold release replay when the durable request identity is reused with changed input", async () => {
		const harness = await createWorktreeHarness(); harnesses.push(harness);
		const storage = new FaultInjectingRegistryMutationPort();
		const registry = new WorktreeRegistry(storage);
		const releaseJournal = new MemoryWorktreeReleaseJournalPort();
		const firstManager = managerWithRegistry(harness, registry, releaseJournal);
		const request = await createRequest(harness, "release-conflict");
		const created = await firstManager.create(request);
		if (!created.ok) throw new Error(created.error.message);
		const release = releaseRequest(request, created.value, "release-conflict");
		const released = await firstManager.release(release);
		if (!released.ok) throw new Error(released.error.message);

		const coldManager = managerWithRegistry(harness, registry, releaseJournal);
		const conflict = await coldManager.release({
			...release,
			callerRequestDigest: canonicalDigest("release-conflict-changed"),
		});
		expect(conflict.ok).toBe(false);
		if (conflict.ok) return;
		expect(conflict.error).toMatchObject({ retryable: false });
		expect(conflict.error.message).toMatch(/idempotency|request|reused/u);

		const takeover = await coldManager.release({
			...release,
			requestId: createRuntimeId("command", "release-conflict-takeover"),
		});
		expect(takeover.ok).toBe(false);
		if (takeover.ok) return;
		expect(takeover.error).toMatchObject({ retryable: false });
		expect(takeover.error.message).toMatch(/idempotency|request|reused/u);

		const secondRequest = await createRequest(harness, "release-conflict-second-workspace");
		const secondCreated = await firstManager.create(secondRequest);
		if (!secondCreated.ok) throw new Error(secondCreated.error.message);
		const crossOperation = await firstManager.release({
			...releaseRequest(secondRequest, secondCreated.value, "release-conflict-second-workspace"),
			requestId: release.requestId,
		});
		expect(crossOperation).toMatchObject({
			ok: false,
			error: { code: "invalid_request", retryable: false },
		});
		expect(await harness.leases.read(secondCreated.value.record.workspaceId)).toMatchObject({
			record: { state: "active", leaseRevision: 1 },
		});
	});
});
