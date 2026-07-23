import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	ProductionAgentWorkspaceAdapter,
	ProductionChildSessionLauncher,
	createProductionCapabilityGrantPolicy,
} from "../../../src/runtime/agents/integration/index.ts";
import type {
	ChildIsolatedCommandRequest,
	ProductionChildSessionLauncherOptions,
} from "../../../src/runtime/agents/integration/child-session-launcher.ts";
import type { ValidatedAgentWorkspaceContext } from "../../../src/runtime/agents/integration/worktree-workspace.ts";
import { capabilitySubsetRequestDigest } from "../../../src/runtime/agents/delegation.ts";
import type {
	AgentId,
	CommandId,
	SessionId,
} from "../../../src/runtime/protocol/v3/ids.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import type {
	SessionMutationAdmissionGatePort,
	SessionMutationAdmissionReceipt,
} from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import type {
	AgentLaunchRequest,
	AgentResult,
	AgentResumeLaunchRequest,
	AgentRuntimeReleaseRequest,
	AgentWorkspaceReceiptRef,
} from "../../../src/runtime/agents/types.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { WorktreeManager } from "../../../src/worktree/manager.ts";

const NOW = "2026-07-23T00:00:00.000Z";
const IDENTITY: RuntimeIdentityContext = {
	authorityId: createRuntimeId("authority", "child-gate"),
	tenantId: createRuntimeId("tenant", "child-gate"),
	principalId: createRuntimeId("principal", "child-gate"),
	source: "managed",
	issuedAt: NOW,
};
const PARENT_SESSION_ID = createRuntimeId("session", "child-gate-parent");
const ROOT_AGENT_ID = createRuntimeId("agent", "child-gate-root");
const DIGEST = canonicalDigest("child gate fixture");
const roots: string[] = [];
const launchers: ProductionChildSessionLauncher[] = [];

type GateRequest = Parameters<SessionMutationAdmissionGatePort["revalidate"]>[0];
type GateMode = "allow" | "deny" | "throw" | "abort";

function admissionReceipt(request: GateRequest): SessionMutationAdmissionReceipt {
	const body: Omit<SessionMutationAdmissionReceipt, "receiptDigest"> = {
		schemaVersion: 1,
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		sessionId: PARENT_SESSION_ID,
		kind: request.kind,
		correlationId: request.correlationId,
		eventHead: {
			stream: createSessionEventStreamRef(IDENTITY, PARENT_SESSION_ID),
			sequence: 1,
			eventId: createRuntimeId("event", "child-gate-head"),
			eventHash: DIGEST,
		},
		checkedAt: NOW,
		auditReceipts: [],
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

class ControlledParentMutationGate implements SessionMutationAdmissionGatePort {
	public mode: GateMode;
	public readonly requests: GateRequest[] = [];
	public readonly signals: Array<AbortSignal | undefined> = [];
	readonly #abortController: AbortController | undefined;

	public constructor(mode: GateMode, abortController?: AbortController) {
		this.mode = mode;
		this.#abortController = abortController;
	}

	public async revalidate(
		request: GateRequest,
		signal?: AbortSignal,
	): Promise<Awaited<ReturnType<SessionMutationAdmissionGatePort["revalidate"]>>> {
		this.requests.push(structuredClone(request));
		this.signals.push(signal);
		if (this.mode === "throw") throw new Error("injected child-spawn gate failure");
		if (this.mode === "deny") {
			return {
				ok: false,
				error: {
					code: "external_unavailable",
					message: "parent mutation receipt is unavailable",
					retryable: true,
				},
			};
		}
		if (this.mode === "abort") this.#abortController?.abort("injected child-spawn abort");
		return { ok: true, value: admissionReceipt(request) };
	}
}

class RecordingWorkspaceAdapter extends ProductionAgentWorkspaceAdapter {
	public validationCount = 0;
	public beforeOperation: (() => void) | undefined;
	readonly #context: ValidatedAgentWorkspaceContext;

	public constructor(context: ValidatedAgentWorkspaceContext) {
		super({
			manager: {} as WorktreeManager,
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			principalId: context.principalId,
			repositoryId: context.repositoryId,
			sourceRepo: context.envelope.worktreePath,
			sourceCwd: context.envelope.cwd,
			rootAgentId: ROOT_AGENT_ID,
			rootOwnerRuntimeId: context.envelope.ownerRuntimeId,
		});
		this.#context = context;
	}

	public override async withValidatedWorkspace<T>(
		_input: {
			requestId: CommandId;
			agentId: AgentId;
			sessionId: SessionId;
			receipt: AgentWorkspaceReceiptRef;
		},
		operation: (context: ValidatedAgentWorkspaceContext) => Promise<AgentResult<T>>,
	): Promise<AgentResult<T>> {
		this.validationCount += 1;
		this.beforeOperation?.();
		return operation(this.#context);
	}
}

function workspaceReceipt(sessionId: SessionId): AgentWorkspaceReceiptRef {
	const body: Omit<AgentWorkspaceReceiptRef, "receiptDigest"> = {
		receiptId: createRuntimeId("receipt", "child-gate-workspace"),
		strategy: {
			strategyId: createRuntimeId("resource", "child-gate-workspace"),
			kind: "managed_worktree",
			strategyDigest: canonicalDigest("child gate workspace strategy"),
		},
		sessionId,
		workspaceId: createRuntimeId("workspace", "child-gate"),
		repositoryId: createRuntimeId("repository", "child-gate"),
		bindingRevision: 1,
		bindingDigest: canonicalDigest("child gate workspace binding"),
		leaseId: createRuntimeId("lease", "child-gate"),
		leaseRevision: 1,
		status: "active",
		issuedAt: NOW,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

async function createLaunchRequest(): Promise<AgentLaunchRequest> {
	const requestId = createRuntimeId("command", "child-gate-launch");
	const agentId = createRuntimeId("agent", "child-gate-child");
	const sessionId = createRuntimeId("session", "child-gate-child");
	const parentGrant = {
		receiptId: createRuntimeId("receipt", "child-gate-parent-grant"),
		receiptDigest: canonicalDigest("child gate parent grant"),
		decisionRevision: 1,
		expiresAt: "2026-07-24T00:00:00.000Z",
	};
	const capabilitySubset = new GatewayBoundCapabilitySubsetEvaluator([
		createProductionCapabilityGrantPolicy({
			policyReceiptId: createRuntimeId("receipt", "child-gate-policy"),
			parentGrant,
			allowedRequests: [],
			delegableToolKinds: [],
			childSpawnAllowed: true,
			decisionRevision: 2,
			evaluatorId: IDENTITY.principalId,
			issuedAt: NOW,
			expiresAt: "2026-07-24T00:00:00.000Z",
		}),
	], () => new Date(NOW));
	const delegationRequest = {
		requestId,
		parentAgentId: ROOT_AGENT_ID,
		childAgentId: agentId,
		parentGrant,
		requestedCapabilities: [],
		inputSources: [],
		declassificationReceipts: [],
	};
	const delegation = await capabilitySubset.evaluate({
		...delegationRequest,
		requestDigest: capabilitySubsetRequestDigest(
			delegationRequest.parentAgentId,
			delegationRequest.childAgentId,
			delegationRequest.parentGrant,
			delegationRequest.requestedCapabilities,
			delegationRequest.inputSources,
			delegationRequest.declassificationReceipts,
		),
	});
	if (!delegation.ok) throw new Error(delegation.error.message);
	const artifactContractBody = { expected: [], allowPartial: false };
	const body: Omit<AgentLaunchRequest, "requestDigest"> = {
		requestId,
		agentId,
		sessionId,
		parentAgentId: ROOT_AGENT_ID,
		role: "build",
		objective: "exercise the parent child-spawn mutation gate",
		delegationReceipt: delegation.value,
		workspaceReceipt: workspaceReceipt(sessionId),
		budgetReservation: {
			reservationId: createRuntimeId("budgetReservation", "child-gate"),
			operationId: requestId,
			requestDigest: canonicalDigest("child gate budget reservation"),
		},
		artifactContract: {
			...artifactContractBody,
			contractDigest: canonicalDigest(artifactContractBody),
		},
		inputSources: [],
		declassificationReceipts: [],
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

function runtimeReleaseRequest(
	launch: AgentLaunchRequest,
	launchReceipt: AgentRuntimeReleaseRequest["launchReceipt"],
	previousResidencyReceipt: AgentRuntimeReleaseRequest["previousResidencyReceipt"],
	reason: AgentRuntimeReleaseRequest["reason"] = "completed",
	seed = "child-gate-release",
): AgentRuntimeReleaseRequest {
	const body: Omit<AgentRuntimeReleaseRequest, "requestDigest"> = {
		requestId: createRuntimeId("command", seed),
		agentId: launch.agentId,
		sessionId: launch.sessionId,
		launchReceipt,
		previousResidencyReceipt,
		reason,
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

function runtimeResumeRequest(
	launch: AgentLaunchRequest,
	seed = "child-gate-resume",
): AgentResumeLaunchRequest {
	const body: Omit<AgentResumeLaunchRequest, "requestDigest"> = {
		requestId: createRuntimeId("command", seed),
		agentId: launch.agentId,
		sessionId: launch.sessionId,
		parentAgentId: launch.parentAgentId,
		delegationReceipt: launch.delegationReceipt,
		workspaceReceipt: launch.workspaceReceipt,
		budgetReservation: launch.budgetReservation,
		inputSources: launch.inputSources,
		declassificationReceipts: launch.declassificationReceipts,
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

async function fixture(
	mode: GateMode,
	processIsolation?: ProductionChildSessionLauncherOptions["processIsolation"],
): Promise<{
	launcher: ProductionChildSessionLauncher;
	gate: ControlledParentMutationGate;
	workspace: RecordingWorkspaceAdapter;
	request: AgentLaunchRequest;
	sessionDir: string;
	controller: AbortController;
}> {
	const root = await mkdtemp(join(tmpdir(), "runledger-child-gate-"));
	roots.push(root);
	const request = await createLaunchRequest();
	const controller = new AbortController();
	const gate = new ControlledParentMutationGate(mode, controller);
	const workspace = new RecordingWorkspaceAdapter({
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		principalId: IDENTITY.principalId,
		repositoryId: request.workspaceReceipt.repositoryId,
		agentId: request.agentId,
		sessionId: request.sessionId,
		workspaceReceipt: request.workspaceReceipt,
		envelope: {
			authorityId: IDENTITY.authorityId,
			tenantId: IDENTITY.tenantId,
			principalId: IDENTITY.principalId,
			sessionId: request.sessionId,
			workspaceId: request.workspaceReceipt.workspaceId,
			repositoryId: request.workspaceReceipt.repositoryId,
			worktreePath: root,
			branch: "worktree/child-gate",
			baseCommit: DIGEST,
			agentId: request.agentId,
			toolCallId: createRuntimeId("toolCall", "child-gate-workspace"),
			traceId: createRuntimeId("trace", "child-gate-workspace"),
			cwd: root,
			ownerRuntimeId: createRuntimeId("runtime", "child-gate-workspace"),
			leaseRevision: 1,
			fencingToken: "test-only-child-gate-fencing-token",
		},
	});
	const sessionDir = join(root, "child-sessions");
	const launcher = new ProductionChildSessionLauncher({
		workspace,
		capabilitySubset: new GatewayBoundCapabilitySubsetEvaluator([
			createProductionCapabilityGrantPolicy({
				policyReceiptId: createRuntimeId("receipt", "child-gate-policy"),
				parentGrant: {
					receiptId: request.delegationReceipt.parentGrantReceiptId,
					receiptDigest: request.delegationReceipt.parentGrantDigest,
					decisionRevision: 1,
					expiresAt: "2026-07-24T00:00:00.000Z",
				},
				allowedRequests: [],
				delegableToolKinds: [],
				childSpawnAllowed: true,
				decisionRevision: 2,
				evaluatorId: IDENTITY.principalId,
				issuedAt: NOW,
				expiresAt: "2026-07-24T00:00:00.000Z",
			}),
		], () => new Date(NOW)),
		parentMutationGate: gate,
		sessionDir,
		features: { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true },
		identity: IDENTITY,
		maxActiveChildren: 2,
		...(processIsolation ? { processIsolation } : {}),
		clock: () => new Date(NOW),
	});
	launchers.push(launcher);
	return { launcher, gate, workspace, request, sessionDir, controller };
}

afterEach(async () => {
	await Promise.all(launchers.splice(0).map((launcher) => launcher.close().catch(() => undefined)));
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production child session launcher mutation gate", () => {
	it.each(["deny", "throw", "abort"] as const)(
		"fails closed before every launcher side effect when the parent gate mode is %s",
		async (mode) => {
			const { launcher, gate, workspace, request, sessionDir, controller } = await fixture(mode);
			const create = vi.spyOn(V3SessionManager, "create");
			const result = await launcher.launch(request, controller.signal);

			expect(result).toEqual({
				ok: false,
				error: {
					code: "reference_unavailable",
					message: "parent session child-spawn admission is unavailable",
					retryable: false,
				},
			});
			expect(gate.requests).toEqual([{ kind: "child_spawn", correlationId: request.requestId }]);
			expect(gate.signals).toEqual([controller.signal]);
			expect(workspace.validationCount).toBe(0);
			expect(create).not.toHaveBeenCalled();
			expect(launcher.snapshots()).toEqual([]);
			await expect(readdir(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
		},
	);

	it("treats a pre-aborted launch as a non-retryable admission failure", async () => {
		const { launcher, gate, workspace, request, sessionDir, controller } = await fixture("allow");
		const create = vi.spyOn(V3SessionManager, "create");
		controller.abort("caller cancelled child launch");

		expect(await launcher.launch(request, controller.signal)).toEqual({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "parent session child-spawn admission is unavailable",
				retryable: false,
			},
		});
		expect(gate.requests).toEqual([]);
		expect(workspace.validationCount).toBe(0);
		expect(create).not.toHaveBeenCalled();
		expect(launcher.snapshots()).toEqual([]);
		await expect(readdir(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not create a claim when the caller aborts during Workspace validation", async () => {
		const { launcher, gate, workspace, request, sessionDir, controller } = await fixture("allow");
		const create = vi.spyOn(V3SessionManager, "create");
		workspace.beforeOperation = () => controller.abort("caller cancelled during Workspace validation");

		expect(await launcher.launch(request, controller.signal)).toEqual({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "parent session child-spawn admission is unavailable",
				retryable: false,
			},
		});
		expect(gate.requests).toEqual([{ kind: "child_spawn", correlationId: request.requestId }]);
		expect(workspace.validationCount).toBe(1);
		expect(create).not.toHaveBeenCalled();
		expect(launcher.snapshots()).toEqual([]);
		await expect(readdir(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes the durable claim when the caller aborts while it is being written", async () => {
		const { launcher, gate, workspace, request, sessionDir, controller } = await fixture("allow");
		const create = vi.spyOn(V3SessionManager, "create");
		workspace.beforeOperation = () => queueMicrotask(() => controller.abort("caller cancelled during launch claim"));

		expect(await launcher.launch(request, controller.signal)).toEqual({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "parent session child-spawn admission is unavailable",
				retryable: false,
			},
		});
		expect(gate.requests).toEqual([{ kind: "child_spawn", correlationId: request.requestId }]);
		expect(workspace.validationCount).toBe(1);
		expect(create).not.toHaveBeenCalled();
		expect(launcher.snapshots()).toEqual([]);
		expect(await readdir(sessionDir)).toEqual([]);
	});

	it.each(["abort", "close"] as const)(
		"does not register the child when %s wins while durable creation is completing",
		async (mode) => {
			const { launcher, gate, workspace, request, sessionDir, controller } = await fixture("allow");
			const createManager = V3SessionManager.create.bind(V3SessionManager);
			let created: (() => void) | undefined;
			let release: (() => void) | undefined;
			const createdManager = new Promise<void>((resolve) => {
				created = resolve;
			});
			const releaseCreate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const create = vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
				const manager = await createManager(options);
				created?.();
				await releaseCreate;
				return manager;
			});

			const launched = launcher.launch(request, controller.signal);
			await createdManager;
			let closing: Promise<void> | undefined;
			if (mode === "abort") controller.abort("caller cancelled during durable child creation");
			else closing = launcher.close();
			release?.();
			await closing;

			expect(await launched).toEqual({
				ok: false,
				error: {
					code: "reference_unavailable",
					message: "child session creation lost admission and requires explicit recovery",
					retryable: false,
				},
			});
			expect(gate.requests).toEqual([{ kind: "child_spawn", correlationId: request.requestId }]);
			expect(workspace.validationCount).toBe(1);
			expect(create).toHaveBeenCalledTimes(1);
			expect(launcher.snapshots()).toEqual([]);
			const sessionEntries = await readdir(sessionDir);
			expect(sessionEntries.some((entry) => entry === `.${request.sessionId}.launch-claim`)).toBe(false);
			expect(sessionEntries.some((entry) => entry.endsWith(`_${request.sessionId}.jsonl`))).toBe(true);
		},
	);

	it("latches admission and drains a deferred durable create before idle close succeeds", async () => {
		const { launcher, gate, request, controller } = await fixture("allow");
		const createManager = V3SessionManager.create.bind(V3SessionManager);
		let created: (() => void) | undefined;
		let release: (() => void) | undefined;
		const createdManager = new Promise<void>((resolve) => {
			created = resolve;
		});
		const releaseCreate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const create = vi.spyOn(V3SessionManager, "create").mockImplementation(async (options) => {
			const manager = await createManager(options);
			created?.();
			await releaseCreate;
			return manager;
		});

		const launched = launcher.launch(request, controller.signal);
		await createdManager;
		let closeSettled = false;
		const closing = launcher.closeIfIdle().then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		expect(await launcher.launch(request, controller.signal)).toMatchObject({
			ok: true,
			value: { status: "unavailable", retryable: true },
		});
		expect(gate.requests).toHaveLength(1);
		release?.();

		expect(await launched).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "child session creation lost admission and requires explicit recovery",
			},
		});
		await expect(closing).resolves.toBeUndefined();
		expect(closeSettled).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(launcher.snapshots()).toEqual([]);
		expect(await launcher.launch(request, controller.signal)).toMatchObject({
			ok: true,
			value: { status: "unavailable", retryable: true },
		});
		expect(gate.requests).toHaveLength(1);
	});

	it("revalidates before serving an idempotent cached launch result", async () => {
		const { launcher, gate, workspace, request, controller } = await fixture("allow");
		const create = vi.spyOn(V3SessionManager, "create");
		const first = await launcher.launch(request, controller.signal);
		expect(first).toMatchObject({ ok: true, value: { status: "started" } });
		expect(workspace.validationCount).toBe(1);
		expect(create).toHaveBeenCalledTimes(1);

		gate.mode = "deny";
		expect(await launcher.launch(request, controller.signal)).toEqual({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "parent session child-spawn admission is unavailable",
				retryable: false,
			},
		});
		expect(gate.requests).toEqual([
			{ kind: "child_spawn", correlationId: request.requestId },
			{ kind: "child_spawn", correlationId: request.requestId },
		]);
		expect(workspace.validationCount).toBe(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(launcher.snapshots()).toHaveLength(1);
	});

	it("binds the durable child runtime identity to the validated Workspace owner", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);

		expect(launched).toMatchObject({ ok: true, value: { status: "started" } });
		expect(launcher.snapshots()).toEqual([
			expect.objectContaining({
				agentId: request.agentId,
				sessionId: request.sessionId,
				runtimeInstanceId: createRuntimeId("runtime", "child-gate-workspace"),
			}),
		]);
	});

	it("releases a child runtime with an exact replayable nonresident receipt", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(request, launched.value.launchReceipt, launched.value.residencyReceipt);

		const first = await launcher.release(release, controller.signal);
		expect(first).toMatchObject({
			ok: true,
			value: {
				requestId: release.requestId,
				requestDigest: release.requestDigest,
				agentId: request.agentId,
				sessionId: request.sessionId,
				runtimeInstanceId: createRuntimeId("runtime", "child-gate-workspace"),
				launchReceiptId: launched.value.launchReceipt.receiptId,
				launchRevision: launched.value.launchReceipt.launchRevision,
				writerFenceReceiptId: expect.stringMatching(/^receipt_/u),
				writerFenceReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
				finalCursor: expect.objectContaining({
					stream: expect.objectContaining({ scope: "session", sessionId: request.sessionId }),
				}),
				residencyReceipt: expect.objectContaining({
					agentId: request.agentId,
					sessionId: request.sessionId,
					state: "nonresident",
					revision: launched.value.residencyReceipt.revision + 1,
				}),
				releasedAt: NOW,
				receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
			},
		});
		if (!first.ok) return;
		const { receiptDigest, ...receiptBody } = first.value;
		expect(receiptDigest).toBe(canonicalDigest(receiptBody));
		expect(await launcher.release(release, controller.signal)).toEqual(first);
		expect(launcher.snapshots()).toEqual([]);

		const conflicting = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"failed",
			"child-gate-release-conflict",
		);
		expect(await launcher.release(conflicting, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
	});

	it("shares the complete in-flight release promise and rejects a conflicting digest", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"completed",
			"child-gate-concurrent-release",
		);
		const conflicting = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"failed",
			"child-gate-concurrent-release-conflict",
		);
		const originalCloseAll = V3SessionManager.prototype.closeAll;
		let enteredClose: (() => void) | undefined;
		let releaseClose: (() => void) | undefined;
		const closeEntered = new Promise<void>((resolve) => {
			enteredClose = resolve;
		});
		const closeGate = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const closeAll = vi.spyOn(V3SessionManager.prototype, "closeAll").mockImplementation(async function () {
			enteredClose?.();
			await closeGate;
			return originalCloseAll.call(this);
		});

		const firstPromise = launcher.release(release, controller.signal);
		await closeEntered;
		const secondPromise = launcher.release(release, controller.signal);
		expect(secondPromise).toBe(firstPromise);
		expect(await launcher.release(conflicting, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
		releaseClose?.();

		const [first, second] = await Promise.all([firstPromise, secondPromise]);
		expect(second).toBe(first);
		expect(first).toMatchObject({ ok: true, value: { requestDigest: release.requestDigest } });
		expect(closeAll).toHaveBeenCalledTimes(1);
	});

	it("reopens admission after active-child close refusal so governed cleanup and close can retry", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");

		await expect(launcher.closeIfIdle()).rejects.toThrow(
			"requires governed terminal cleanup for 1 active child runtime(s)",
		);
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"completed",
			"child-gate-release-after-close-refusal",
		);
		expect(await launcher.release(release, controller.signal)).toMatchObject({ ok: true });
		await expect(launcher.closeIfIdle()).resolves.toBeUndefined();
	});

	it("retains a stopped child after close failure and retries without duplicating stop", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"stopped",
			"child-gate-release-retry",
		);
		const originalCloseAll = V3SessionManager.prototype.closeAll;
		let closeAttempts = 0;
		const stop = vi.spyOn(V3SessionManager.prototype, "requestStop");
		vi.spyOn(V3SessionManager.prototype, "closeAll").mockImplementation(async function () {
			closeAttempts += 1;
			if (closeAttempts === 1) throw new Error("injected child release close failure");
			return originalCloseAll.call(this);
		});

		expect(await launcher.release(release, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(launcher.snapshots()).toHaveLength(1);
		expect(stop).toHaveBeenCalledTimes(1);

		expect(await launcher.release(release, controller.signal)).toMatchObject({ ok: true });
		expect(stop).toHaveBeenCalledTimes(1);
		expect(closeAttempts).toBe(2);
		expect(launcher.snapshots()).toEqual([]);
	});

	it("quarantines a child after an uncertain partial close while preserving exact release retry", async () => {
		const { launcher, workspace, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"stopped",
			"child-gate-partial-close",
		);
		const originalClose = JsonlV3EventStore.prototype.close;
		let closeAttempts = 0;
		vi.spyOn(JsonlV3EventStore.prototype, "close").mockImplementation(async function () {
			closeAttempts += 1;
			const result = await originalClose.call(this);
			if (closeAttempts === 1 && result.ok) {
				return {
					ok: false,
					error: {
						code: "durable_write_failed",
						message: "injected result loss after the child event store closed",
						retryable: false,
						effect: "uncertain",
					},
				};
			}
			return result;
		});

		expect(await launcher.release(release, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(launcher.snapshots()).toHaveLength(1);
		const validationsAfterLaunch = workspace.validationCount;
		expect(await launcher.launch(request, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(await launcher.resume(runtimeResumeRequest(request), controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		const isolatedRequest: ChildIsolatedCommandRequest = {
			requestId: createRuntimeId("command", "child-gate-partial-close-command"),
			agentId: request.agentId,
			sessionId: request.sessionId,
			workspaceReceipt: request.workspaceReceipt,
			executable: "/bin/echo",
			arguments: ["must-not-run"],
		};
		expect(await launcher.runIsolatedCommand(isolatedRequest, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(workspace.validationCount).toBe(validationsAfterLaunch);

		expect(await launcher.release(release, controller.signal)).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				message: "child runtime release failed",
				retryable: true,
			},
		});
		expect(closeAttempts).toBe(1);
		expect(launcher.snapshots()).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")("rechecks release quarantine after isolated TMPDIR creation before process spawn", async () => {
		const isolationRoot = await mkdtemp(join(tmpdir(), "runledger-child-process-isolation-"));
		roots.push(isolationRoot);
		const { launcher, workspace, request, controller } = await fixture("allow", {
			rootDir: isolationRoot,
			allowedExecutables: ["/bin/sh"],
		});
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"stopped",
			"child-gate-isolated-spawn-race-release",
		);
		const originalRequestStop = V3SessionManager.prototype.requestStop;
		let enteredStop: (() => void) | undefined;
		let releaseStop: (() => void) | undefined;
		const stopEntered = new Promise<void>((resolve) => {
			enteredStop = resolve;
		});
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		vi.spyOn(V3SessionManager.prototype, "requestStop").mockImplementation(async function (reason) {
			enteredStop?.();
			await stopGate;
			return originalRequestStop.call(this, reason);
		});
		let releasePromise: ReturnType<ProductionChildSessionLauncher["release"]> | undefined;
		workspace.beforeOperation = () => {
			workspace.beforeOperation = undefined;
			queueMicrotask(() => {
				releasePromise = launcher.release(release, controller.signal);
			});
		};
		const marker = join(isolationRoot, "forbidden-spawn-marker");
		const isolatedRequest: ChildIsolatedCommandRequest = {
			requestId: createRuntimeId("command", "child-gate-isolated-spawn-race-command"),
			agentId: request.agentId,
			sessionId: request.sessionId,
			workspaceReceipt: request.workspaceReceipt,
			executable: "/bin/sh",
			arguments: ["-c", `printf forbidden > ${marker}`],
		};

		const command = launcher.runIsolatedCommand(isolatedRequest, controller.signal);
		await stopEntered;
		expect(await command).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		if (!releasePromise) throw new Error("release did not start during isolated TMPDIR creation");
		releaseStop?.();
		expect(await releasePromise).toMatchObject({ ok: true });
	});

	it.skipIf(process.platform === "win32")("aborts and drains the released agent's spawned command before signing its receipt", async () => {
		const isolationRoot = await mkdtemp(join(tmpdir(), "runledger-child-command-drain-"));
		roots.push(isolationRoot);
		const { launcher, request, controller } = await fixture("allow", {
			rootDir: isolationRoot,
			allowedExecutables: ["/bin/sh"],
			timeoutMs: 60_000,
		});
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"stopped",
			"child-gate-running-command-release",
		);
		const marker = join(isolationRoot, "spawned-command-started");
		const commandSignal = new AbortController();
		const isolatedRequest: ChildIsolatedCommandRequest = {
			requestId: createRuntimeId("command", "child-gate-running-command"),
			agentId: request.agentId,
			sessionId: request.sessionId,
			workspaceReceipt: request.workspaceReceipt,
			executable: "/bin/sh",
			arguments: ["-c", 'printf started > "$1"; exec /bin/sleep 60', "sh", marker],
		};
		let commandSettled = false;
		const command = launcher.runIsolatedCommand(isolatedRequest, commandSignal.signal).then((result) => {
			commandSettled = true;
			return result;
		});
		await vi.waitFor(async () => {
			expect(await readFile(marker, "utf8")).toBe("started");
		}, { timeout: 2_000, interval: 10 });

		let commandHadExitedWhenReleaseSettled = false;
		let releaseSettled = false;
		const releasing = launcher.release(release, controller.signal).then((result) => {
			commandHadExitedWhenReleaseSettled = commandSettled;
			releaseSettled = true;
			return result;
		});
		await Promise.resolve();
		expect(releaseSettled).toBe(false);
		expect(await command).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(commandSignal.signal.aborted).toBe(false);
		expect(await releasing).toMatchObject({ ok: true });
		expect(commandHadExitedWhenReleaseSettled).toBe(true);
		expect(launcher.snapshots()).toEqual([]);
	});

	it.skipIf(process.platform === "win32")(
		"kills background descendants in the isolated process group before release completes",
		async () => {
			const isolationRoot = await mkdtemp(join(tmpdir(), "runledger-child-descendant-drain-"));
			roots.push(isolationRoot);
			const { launcher, request, controller } = await fixture("allow", {
				rootDir: isolationRoot,
				allowedExecutables: ["/bin/sh"],
				timeoutMs: 60_000,
			});
			const launched = await launcher.launch(request, controller.signal);
			if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
			const release = runtimeReleaseRequest(
				request,
				launched.value.launchReceipt,
				launched.value.residencyReceipt,
				"stopped",
				"child-gate-descendant-release",
			);
			const descendantStarted = join(isolationRoot, "descendant-started");
			const escapedMarker = join(isolationRoot, "descendant-escaped");
			const isolatedRequest: ChildIsolatedCommandRequest = {
				requestId: createRuntimeId("command", "child-gate-descendant-command"),
				agentId: request.agentId,
				sessionId: request.sessionId,
				workspaceReceipt: request.workspaceReceipt,
				executable: "/bin/sh",
				arguments: [
					"-c",
					'(/bin/sleep 1; printf escaped > "$2") & descendant=$!; printf %s "$descendant" > "$1"; exec /bin/sleep 60',
					"sh",
					descendantStarted,
					escapedMarker,
				],
			};
			let commandSettled = false;
			const command = launcher.runIsolatedCommand(isolatedRequest).then((result) => {
				commandSettled = true;
				return result;
			});
			await vi.waitFor(async () => {
				expect(await readFile(descendantStarted, "utf8")).toMatch(/^\d+$/u);
			}, { timeout: 2_000, interval: 10 });

			let releaseObservedCommandExit = false;
			const releasing = launcher.release(release, controller.signal).then((result) => {
				releaseObservedCommandExit = commandSettled;
				return result;
			});
			expect(await command).toMatchObject({
				ok: false,
				error: { code: "reference_unavailable", retryable: true },
			});
			expect(await releasing).toMatchObject({ ok: true });
			expect(releaseObservedCommandExit).toBe(true);
			await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_200));
			await expect(readFile(escapedMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			expect(launcher.snapshots()).toEqual([]);
		},
	);

	it("retains the resident child and emits no release receipt when stop fails", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"failed",
			"child-gate-release-stop-fail",
		);
		const close = vi.spyOn(V3SessionManager.prototype, "closeAll");
		vi.spyOn(V3SessionManager.prototype, "requestStop").mockRejectedValueOnce(new Error("injected stop failure"));

		expect(await launcher.release(release, controller.signal)).toMatchObject({
			ok: false,
			error: { code: "reference_unavailable", retryable: true },
		});
		expect(close).not.toHaveBeenCalled();
		expect(launcher.snapshots()).toHaveLength(1);
	});

	it("retains a child whose manager failed to close so shutdown can be retried", async () => {
		const { launcher, request, controller } = await fixture("allow");
		expect(await launcher.launch(request, controller.signal)).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		const closeAll = V3SessionManager.prototype.closeAll;
		let attempts = 0;
		vi.spyOn(V3SessionManager.prototype, "closeAll").mockImplementation(async function () {
			attempts += 1;
			if (attempts === 1) throw new Error("injected child close failure");
			return closeAll.call(this);
		});

		await expect(launcher.close()).rejects.toThrow("production child launcher close failed");
		expect(launcher.snapshots()).toHaveLength(1);
		await expect(launcher.close()).resolves.toBeUndefined();
		expect(launcher.snapshots()).toEqual([]);
		expect(attempts).toBe(2);
	});

	it("rejects malformed local inputs before consulting the parent gate", async () => {
		const { launcher, gate, workspace, request, sessionDir } = await fixture("allow");
		const create = vi.spyOn(V3SessionManager, "create");
		const invalidDigest = { ...request, requestDigest: canonicalDigest("invalid child launch") };
		const staleDelegationBody = {
			...request,
			delegationReceipt: {
				...request.delegationReceipt,
				receiptDigest: canonicalDigest("stale child delegation"),
			},
		};
		const { requestDigest: _requestDigest, ...staleBody } = staleDelegationBody;
		const staleDelegation = { ...staleBody, requestDigest: canonicalDigest(staleBody) };

		expect(await launcher.launch(invalidDigest)).toMatchObject({
			ok: false,
			error: { code: "launch_failed", retryable: false },
		});
		expect(await launcher.launch(staleDelegation)).toMatchObject({
			ok: false,
			error: { code: "delegation_denied", retryable: false },
		});
		expect(gate.requests).toEqual([]);
		expect(workspace.validationCount).toBe(0);
		expect(create).not.toHaveBeenCalled();
		expect(launcher.snapshots()).toEqual([]);
		await expect(readdir(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
