import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GatewayBoundCapabilitySubsetEvaluator,
	ProductionAgentWorkspaceAdapter,
	ProductionChildSessionLauncher,
	createProductionCapabilityGrantPolicy,
} from "../../../src/runtime/agents/integration/index.ts";
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
	AgentWorkspaceReceiptRef,
} from "../../../src/runtime/agents/types.ts";
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

async function fixture(mode: GateMode): Promise<{
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
			if (mode === "abort") controller.abort("caller cancelled during durable child creation");
			else await launcher.close();
			release?.();

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
