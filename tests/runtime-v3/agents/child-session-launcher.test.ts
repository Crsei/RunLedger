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
import { ChildOperationBudget } from "../../../src/runtime/agents/integration/child-operation-budget.ts";
import {
	HeadlessChildRuntimeHost,
	type HeadlessChildRuntimeFactoryPort,
} from "../../../src/runtime/agents/integration/headless-child-runtime.ts";
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
import { createWorktreeId } from "../../../src/runtime/protocol/v3/workspace.ts";
import type { RuntimeIdentityContext } from "../../../src/runtime/identity/types.ts";
import type {
	SessionMutationAdmissionGatePort,
	SessionMutationAdmissionReceipt,
} from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { DEFAULT_RUNTIME_FEATURES } from "../../../src/runtime/runtime-features.ts";
import type {
	AgentCancelRequest,
	AgentLaunchRequest,
	AgentResult,
	AgentResumeLaunchRequest,
	AgentRuntimeActivationRequest,
	AgentRuntimeReleaseRequest,
	AgentWorkspaceReceiptRef,
} from "../../../src/runtime/agents/types.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import { AgentLoopSessionEvents } from "../../../src/runtime/session/agent-loop-events.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type { WorktreeManager } from "../../../src/worktree/manager.ts";
import {
	MemoryChildRuntimeAuthorityStore,
	type ChildRuntimeAuthorityStorePort,
} from "../../../src/runtime/agents/child-runtime-authority.ts";

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
const PARENT_RUNTIME_ID = createRuntimeId(
	"runtime",
	"child-gate-parent",
);
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

function parentWriterFence() {
	const body = {
		authorityId: IDENTITY.authorityId,
		tenantId: IDENTITY.tenantId,
		sessionId: PARENT_SESSION_ID,
		runtimeId: PARENT_RUNTIME_ID,
		stream: createSessionEventStreamRef(
			IDENTITY,
			PARENT_SESSION_ID,
		),
		leaseId: createRuntimeId("lease", "child-gate-parent"),
		writerEpoch: 1,
		fencingTokenDigest: canonicalDigest(
			"child gate parent fence",
		),
		acquiredAt: NOW,
		expiresAt: "2026-07-23T00:01:00.000Z",
	};
	const receiptDigest = canonicalDigest(body);
	return {
		...body,
		receiptId: createRuntimeId(
			"receipt",
			`writer-fence-${receiptDigest.slice(0, 48)}`,
		),
		receiptDigest,
	};
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
		budget: {
			maxTurns: 2,
			maxInputTokens: 2_000,
			maxOutputTokens: 1_000,
			maxUsdMicros: 1_000,
			maxWallTimeMs: 60_000,
			maxToolCalls: 2,
			maxNetworkBytes: 0,
			maxStorageBytes: 1_000_000,
		},
		requestedCapabilities: [],
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

function runtimeCancelRequest(
	launch: AgentLaunchRequest,
	seed = "child-gate-cancel",
): AgentCancelRequest {
	const body: Omit<AgentCancelRequest, "requestDigest"> = {
		requestId: createRuntimeId("command", seed),
		agentId: launch.agentId,
		sessionId: launch.sessionId,
		reasonDigest: canonicalDigest("child gate cancellation"),
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

function runtimeActivationRequest(
	launch: AgentLaunchRequest,
	launchReceipt: AgentRuntimeActivationRequest["launchReceipt"],
	residencyReceipt: AgentRuntimeActivationRequest["residencyReceipt"],
	seed = "child-gate-activation",
): AgentRuntimeActivationRequest {
	const body: Omit<
		AgentRuntimeActivationRequest,
		"requestDigest"
	> = {
		requestId: createRuntimeId("command", seed),
		agentId: launch.agentId,
		sessionId: launch.sessionId,
		launchReceipt,
		residencyReceipt,
		parentGraphRevision: 1,
		parentGraphCursor: {
			stream: createSessionEventStreamRef(
				IDENTITY,
				PARENT_SESSION_ID,
			),
			sequence: 1,
			eventId: createRuntimeId(
				"event",
				`${seed}-parent-graph`,
			),
			eventHash: canonicalDigest({
				seed,
				parentGraphRevision: 1,
			}),
		},
		childNodeDigest: canonicalDigest({
			seed,
			agentId: launch.agentId,
			sessionId: launch.sessionId,
		}),
	};
	return { ...body, requestDigest: canonicalDigest(body) };
}

function controlledRuntimeFactory(options: {
	prepareFailure?: Error;
	onActivate?: () => void;
} = {}): {
	runtimeFactory: HeadlessChildRuntimeFactoryPort;
	host(): HeadlessChildRuntimeHost;
} {
	let host: HeadlessChildRuntimeHost | undefined;
	const prepare = vi.fn(
		async (
			input: Parameters<
				HeadlessChildRuntimeFactoryPort["prepare"]
			>[0],
		): Promise<AgentResult<HeadlessChildRuntimeHost>> => {
			const prepared = new HeadlessChildRuntimeHost({
				manager: input.manager,
				operationBudget: new ChildOperationBudget({
					budget: input.request.budget,
					clock: () => new Date(NOW),
				}),
				prompt: input.request.objective,
				agentFactory: () => {
					throw new Error(
						"controlled launcher test host must not construct an Agent",
					);
				},
			});
			vi.spyOn(prepared, "prepare").mockImplementation(
				async () => {
					if (options.prepareFailure) {
						throw options.prepareFailure;
					}
				},
			);
			vi.spyOn(prepared, "activate").mockImplementation(
				async () => {
					options.onActivate?.();
				},
			);
			host = prepared;
			return { ok: true, value: prepared };
		},
	);
	return {
		runtimeFactory: { prepare },
		host: () => {
			if (!host) {
				throw new Error(
					"controlled launcher test host is unavailable",
				);
			}
			return host;
		},
	};
}

async function fixture(
	mode: GateMode,
	processIsolation?: ProductionChildSessionLauncherOptions["processIsolation"],
	authorityStore: ChildRuntimeAuthorityStorePort =
		new MemoryChildRuntimeAuthorityStore(),
	runtimeFactory?: HeadlessChildRuntimeFactoryPort,
): Promise<{
	launcher: ProductionChildSessionLauncher;
	gate: ControlledParentMutationGate;
	workspace: RecordingWorkspaceAdapter;
	request: AgentLaunchRequest;
	sessionDir: string;
	controller: AbortController;
	authorityStore: ChildRuntimeAuthorityStorePort;
	launcherOptions: ProductionChildSessionLauncherOptions;
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
		runtimeBinding: {
			authorityId: IDENTITY.authorityId,
			tenantId: IDENTITY.tenantId,
			workspaceId: request.workspaceReceipt.workspaceId,
			repositoryId: request.workspaceReceipt.repositoryId,
			bindingKind: "managed_worktree",
			canonicalCwd: root,
			effectiveCwd: root,
			branch: "worktree/child-gate",
			baseCommit: DIGEST,
			headCommit: DIGEST,
			worktreeId: createWorktreeId("child-gate"),
		},
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
	const launcherOptions: ProductionChildSessionLauncherOptions = {
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
		authorityStore,
			parentAuthority: {
				parentSessionId: PARENT_SESSION_ID,
				resolve: async (activation) => {
					const revision =
						activation.activationType === "resume" ? 2 : 1;
					const cursor = admissionReceipt({
						kind: "child_spawn",
						correlationId: activation.request.requestId,
					}).eventHead;
					return {
						ok: true,
						value: {
							parentSessionId: PARENT_SESSION_ID,
							ownerParentRuntimeId: PARENT_RUNTIME_ID,
							parentGraphRevision: revision,
							parentGraphCursor: {
								...cursor,
								sequence: revision,
								eventId: createRuntimeId(
									"event",
									`child-gate-head-${revision}`,
								),
								eventHash: canonicalDigest({
									revision,
									requestId:
										activation.request.requestId,
								}),
							},
							parentNodeDigest: canonicalDigest({
								revision,
								parent: "child gate parent node",
							}),
							ownerParentWriterFence:
								parentWriterFence(),
						},
					};
				},
			},
		...(processIsolation ? { processIsolation } : {}),
		...(runtimeFactory ? { runtimeFactory } : {}),
		clock: () => new Date(NOW),
	};
	const launcher = new ProductionChildSessionLauncher(
		launcherOptions,
	);
	launchers.push(launcher);
	return {
		launcher,
		gate,
		workspace,
		request,
		sessionDir,
		controller,
		authorityStore,
		launcherOptions,
	};
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

	it("quarantines the durable authority claim when the caller aborts before create", async () => {
		const {
			launcher,
			gate,
			workspace,
			request,
			sessionDir,
			controller,
			authorityStore,
		} = await fixture("allow");
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
		expect(
			await authorityStore.read(request.agentId),
		).toMatchObject({
			state: "quarantined",
			reason: "launch_admission_lost_before_create",
		});
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

	it("latches admission, drains deferred create, and refuses idle close on the cold partial authority", async () => {
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
		const closing = launcher.closeIfIdle().finally(() => {
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
		await expect(closing).rejects.toThrow(
			"active or cold-partial child runtime",
		);
		expect(closeSettled).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(launcher.snapshots()).toEqual([]);
		expect(await launcher.launch(request, controller.signal)).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(gate.requests).toHaveLength(2);
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
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);

		expect(launched).toMatchObject({ ok: true, value: { status: "started" } });
		expect(launcher.snapshots()).toEqual([
			expect.objectContaining({
				agentId: request.agentId,
				sessionId: request.sessionId,
				runtimeInstanceId: createRuntimeId("runtime", "child-gate-workspace"),
				}),
			]);
		expect(await authorityStore.read(request.agentId)).toMatchObject({
			state: "resident",
			launchRequestDigest: request.requestDigest,
			runtimeInstanceId: createRuntimeId(
				"runtime",
				"child-gate-workspace",
			),
			parentSessionId: PARENT_SESSION_ID,
			parentAgentId: request.parentAgentId,
		});
	});

	it("durably claims exact parent authority before creating a child session", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const createManager =
			V3SessionManager.create.bind(V3SessionManager);
		const create = vi
			.spyOn(V3SessionManager, "create")
			.mockImplementation(async (options) => {
					expect(
						await authorityStore.read(request.agentId),
					).toMatchObject({
						state: "creating",
						claimAttemptId:
							expect.stringMatching(/^command_/u),
						sessionFilePath: options.filePath,
						initialActivationEvidence: {
							activationType: "launch",
							requestId: request.requestId,
							requestDigest: request.requestDigest,
							parentGraphRevision: 1,
							parentGraphCursor: {
								stream: {
									scope: "session",
									sessionId: PARENT_SESSION_ID,
								},
							},
						},
						ownerParentRuntimeId: PARENT_RUNTIME_ID,
				});
				expect(options).toMatchObject({
					writeGenesis: false,
					filePath: expect.stringMatching(
						new RegExp(`_${request.sessionId}\\.jsonl$`, "u"),
					),
				});
				return createManager(options);
			});

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(
			await authorityStore.read(request.agentId),
		).toMatchObject({ state: "resident", revision: 4 });
	});

	it("persists creating and provisional authority before create and genesis effects", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const transitions: string[] = [];
		const compareAndSwap =
			authorityStore.compareAndSwap.bind(authorityStore);
		vi.spyOn(authorityStore, "compareAndSwap").mockImplementation(
			async (
				agentId,
				expectedRevision,
				expectedRecordDigest,
				next,
			) => {
				transitions.push(next.state);
				return compareAndSwap(
					agentId,
					expectedRevision,
					expectedRecordDigest,
					next,
				);
			},
		);
		const ensureInitialized =
			AgentLoopSessionEvents.prototype.ensureInitialized;
		vi.spyOn(
			AgentLoopSessionEvents.prototype,
			"ensureInitialized",
		).mockImplementation(async function (
			this: AgentLoopSessionEvents,
			origin,
		) {
			const provisional = await authorityStore.read(
				request.agentId,
			);
			expect(provisional).toMatchObject({
				state: "provisional",
				sessionFilePath:
					expect.stringMatching(
						new RegExp(`_${request.sessionId}\\.jsonl$`, "u"),
					),
				childWriterFence: {
					runtimeId: createRuntimeId(
						"runtime",
						"child-gate-workspace",
					),
				},
			});
			if (!provisional) {
				throw new Error("provisional authority is unavailable");
			}
			expect(await readFile(provisional.sessionFilePath, "utf8")).toBe("");
			return ensureInitialized.call(this, origin);
		});

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		expect(transitions).toEqual([
			"creating",
			"provisional",
			"resident",
		]);
		const resident = await authorityStore.read(request.agentId);
		expect(resident).toMatchObject({
			state: "resident",
			revision: 4,
			genesisCursor: { sequence: 0 },
		});
		if (!resident) throw new Error("resident authority is unavailable");
		expect(await readFile(resident.sessionFilePath, "utf8")).toContain(
			'"type":"session.created"',
		);
	});

	it("quarantines provisional evidence when genesis cannot be established", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		vi.spyOn(
			AgentLoopSessionEvents.prototype,
			"ensureInitialized",
		).mockRejectedValueOnce(
			new Error("injected genesis initialization failure"),
		);
		const close = vi.spyOn(
			V3SessionManager.prototype,
			"closeAll",
		);

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(launcher.snapshots()).toEqual([]);
		expect(close).toHaveBeenCalledTimes(1);
		const quarantined = await authorityStore.read(request.agentId);
		expect(quarantined).toMatchObject({
			state: "quarantined",
			reason: "genesis_write_failed",
			createStartedAt: NOW,
			launchReceipt: { launchRevision: 1 },
			residencyReceipt: { revision: 1 },
			childWriterFence: {
				runtimeId: createRuntimeId(
					"runtime",
					"child-gate-workspace",
				),
			},
		});
		if (!quarantined) {
			throw new Error("quarantined authority is unavailable");
		}
		expect(await readFile(quarantined.sessionFilePath, "utf8")).toBe("");
	});

	it("recovers a durable genesis barrier acknowledgement loss by exact retry", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const flushCurrentHead =
			V3SessionManager.prototype.flushCurrentHead;
		const flush = vi
			.spyOn(V3SessionManager.prototype, "flushCurrentHead")
			.mockImplementationOnce(async function (
				this: V3SessionManager,
			) {
				const durable = await flushCurrentHead.call(this);
				if (!durable.ok) return durable;
				throw new Error(
					"injected durable genesis receipt acknowledgement loss",
				);
			});

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		expect(flush).toHaveBeenCalledTimes(2);
		expect(await authorityStore.read(request.agentId)).toMatchObject({
			state: "resident",
			genesisCursor: { sequence: 0 },
		});
	});

	it("preserves the exact genesis cursor when resident record construction fails", async () => {
		const {
			request,
			controller,
			authorityStore,
			launcherOptions,
		} = await fixture("allow");
		let failNextClockRead = false;
		const launcher = new ProductionChildSessionLauncher({
			...launcherOptions,
			clock: () => {
				if (failNextClockRead) {
					failNextClockRead = false;
					return new Date(Number.NaN);
				}
				return new Date(NOW);
			},
		});
		launchers.push(launcher);
		const ensureInitialized =
			AgentLoopSessionEvents.prototype.ensureInitialized;
		vi.spyOn(
			AgentLoopSessionEvents.prototype,
			"ensureInitialized",
		).mockImplementation(async function (
			this: AgentLoopSessionEvents,
			origin,
		) {
			const initialized = await ensureInitialized.call(this, origin);
			failNextClockRead = true;
			return initialized;
		});

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "launch_failed",
				retryable: false,
			},
		});
		const quarantined = await authorityStore.read(request.agentId);
		expect(quarantined).toMatchObject({
			state: "quarantined",
			reason: "resident_evidence_invalid",
			genesisCursor: { sequence: 0 },
		});
		if (!quarantined) {
			throw new Error("quarantined authority is unavailable");
		}
		expect(await readFile(quarantined.sessionFilePath, "utf8")).toContain(
			'"type":"session.created"',
		);
	});

	it.each(["manager close", "authority quarantine"] as const)(
		"keeps resident-construction cleanup retryable when %s is uncertain",
		async (fault) => {
			const {
				request,
				controller,
				authorityStore,
				launcherOptions,
			} = await fixture("allow");
			let failNextClockRead = false;
			const launcher = new ProductionChildSessionLauncher({
				...launcherOptions,
				clock: () => {
					if (failNextClockRead) {
						failNextClockRead = false;
						return new Date(Number.NaN);
					}
					return new Date(NOW);
				},
			});
			launchers.push(launcher);
			const ensureInitialized =
				AgentLoopSessionEvents.prototype.ensureInitialized;
			vi.spyOn(
				AgentLoopSessionEvents.prototype,
				"ensureInitialized",
			).mockImplementation(async function (
				this: AgentLoopSessionEvents,
				origin,
			) {
				const initialized = await ensureInitialized.call(
					this,
					origin,
				);
				failNextClockRead = true;
				return initialized;
			});
			const createManager = V3SessionManager.create;
			let createdManager: V3SessionManager | undefined;
			vi.spyOn(V3SessionManager, "create").mockImplementation(
				async (options) => {
					createdManager = await createManager(options);
					return createdManager;
				},
			);
			if (fault === "manager close") {
				const closeAll = V3SessionManager.prototype.closeAll;
				let injectFailure = true;
				vi.spyOn(
					V3SessionManager.prototype,
					"closeAll",
				).mockImplementation(async function (
					this: V3SessionManager,
				) {
					if (injectFailure) {
						injectFailure = false;
						throw new Error(
							"injected manager close uncertainty",
						);
					}
					return closeAll.call(this);
				});
			} else {
				const compareAndSwap =
					authorityStore.compareAndSwap.bind(authorityStore);
				vi.spyOn(
					authorityStore,
					"compareAndSwap",
				).mockImplementation(
					(
						agentId,
						expectedRevision,
						expectedRecordDigest,
						next,
					) =>
						next.state === "quarantined"
							? Promise.resolve("conflict")
							: compareAndSwap(
									agentId,
									expectedRevision,
									expectedRecordDigest,
									next,
								),
				);
			}

			expect(
				await launcher.launch(request, controller.signal),
			).toMatchObject({
				ok: false,
				error: {
					code: "reference_unavailable",
					retryable: true,
				},
			});
			expect(await authorityStore.read(request.agentId)).toMatchObject({
				state:
					fault === "manager close"
						? "quarantined"
						: "provisional",
			});
			await createdManager?.closeAll();
		},
	);

	it.each(["provisional", "resident"] as const)(
		"preserves exact recovery evidence when the %s authority CAS conflicts",
		async (failedState) => {
			const {
				launcher,
				request,
				controller,
				authorityStore,
			} = await fixture("allow");
			const compareAndSwap =
				authorityStore.compareAndSwap.bind(authorityStore);
			let injected = false;
			vi.spyOn(authorityStore, "compareAndSwap").mockImplementation(
				(
					agentId,
					expectedRevision,
					expectedRecordDigest,
					next,
				) => {
					if (!injected && next.state === failedState) {
						injected = true;
						return Promise.resolve("conflict");
					}
					return compareAndSwap(
						agentId,
						expectedRevision,
						expectedRecordDigest,
						next,
					);
				},
			);
			const ensure = vi.spyOn(
				AgentLoopSessionEvents.prototype,
				"ensureInitialized",
			);

			expect(
				await launcher.launch(request, controller.signal),
			).toMatchObject({
				ok: false,
				error: {
					code: "reference_unavailable",
					retryable: true,
				},
			});
			expect(launcher.snapshots()).toEqual([]);
			const quarantined = await authorityStore.read(
				request.agentId,
			);
			expect(quarantined).toMatchObject({
				state: "quarantined",
				reason:
					failedState === "provisional"
						? "provisional_activation_failed"
						: "resident_activation_failed",
				sessionFilePath:
					expect.stringMatching(
						new RegExp(`_${request.sessionId}\\.jsonl$`, "u"),
					),
				launchReceipt: { launchRevision: 1 },
				residencyReceipt: { revision: 1 },
				childWriterFence: {
					runtimeId: createRuntimeId(
						"runtime",
						"child-gate-workspace",
					),
				},
				...(failedState === "resident"
					? { genesisCursor: { sequence: 0 } }
					: {}),
			});
			if (!quarantined) {
				throw new Error("quarantined authority is unavailable");
			}
			expect(
				await readFile(
					`${quarantined.sessionFilePath}.state/writer-lease.json`,
					"utf8",
				).then((source) => JSON.parse(source) as unknown),
			).toMatchObject({ state: "released" });
			const sessionSource = await readFile(
				quarantined.sessionFilePath,
				"utf8",
			);
			expect(sessionSource.includes('"type":"session.created"')).toBe(
				failedState === "resident",
			);
			expect(ensure).toHaveBeenCalledTimes(
				failedState === "resident" ? 1 : 0,
			);
		},
	);

	it.each(["creating", "provisional", "resident"] as const)(
		"uses exact read-back after the %s authority CAS loses its acknowledgement",
		async (lostState) => {
			const {
				launcher,
				request,
				controller,
				authorityStore,
			} = await fixture("allow");
			const compareAndSwap =
				authorityStore.compareAndSwap.bind(authorityStore);
			let injected = false;
			vi.spyOn(authorityStore, "compareAndSwap").mockImplementation(
				async (
					agentId,
					expectedRevision,
					expectedRecordDigest,
					next,
				) => {
					const result = await compareAndSwap(
						agentId,
						expectedRevision,
						expectedRecordDigest,
						next,
					);
					if (!injected && next.state === lostState) {
						injected = true;
						throw new Error(
							`injected ${lostState} CAS acknowledgement loss`,
						);
					}
					return result;
				},
			);
			const create = vi.spyOn(V3SessionManager, "create");

			expect(
				await launcher.launch(request, controller.signal),
			).toMatchObject({
				ok: true,
				value: { status: "started" },
			});
			expect(create).toHaveBeenCalledTimes(1);
			expect(await authorityStore.read(request.agentId)).toMatchObject({
				state: "resident",
				revision: 4,
				genesisCursor: { sequence: 0 },
			});
		},
	);

	it("reserves the active-child bound before await and shares the exact in-flight launch", async () => {
		const {
			launcherOptions,
			request,
			controller,
		} = await fixture("allow");
		const bounded = new ProductionChildSessionLauncher({
			...launcherOptions,
			maxActiveChildren: 1,
		});
		launchers.push(bounded);
		const createManager =
			V3SessionManager.create.bind(V3SessionManager);
		let enteredCreate: (() => void) | undefined;
		let releaseCreate: (() => void) | undefined;
		const createEntered = new Promise<void>((resolve) => {
			enteredCreate = resolve;
		});
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const create = vi
			.spyOn(V3SessionManager, "create")
			.mockImplementation(async (options) => {
				enteredCreate?.();
				await createGate;
				return createManager(options);
			});
		const first = bounded.launch(request, controller.signal);
		expect(bounded.launch(request, controller.signal)).toBe(first);
		await createEntered;

			const {
				requestDigest: _requestDigest,
				...originalBody
			} = request;
			const secondBody: Omit<AgentLaunchRequest, "requestDigest"> = {
				...originalBody,
				requestId: createRuntimeId(
					"command",
					"child-gate-concurrent-bound",
			),
			agentId: createRuntimeId(
				"agent",
				"child-gate-concurrent-bound",
			),
			sessionId: createRuntimeId(
				"session",
				"child-gate-concurrent-bound",
			),
		};
		const second = {
			...secondBody,
			requestDigest: canonicalDigest(secondBody),
		};
		expect(
			await bounded.launch(second, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "rejected", retryable: true },
		});
		expect(create).toHaveBeenCalledTimes(1);
		releaseCreate?.();
		expect(await first).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
	});

	it("performs no create when parent graph or writer authority changes after the claim", async () => {
		const {
			launcherOptions,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const resolveParent =
			launcherOptions.parentAuthority.resolve.bind(
				launcherOptions.parentAuthority,
			);
		let resolutions = 0;
		const guarded = new ProductionChildSessionLauncher({
			...launcherOptions,
			parentAuthority: {
				parentSessionId:
					launcherOptions.parentAuthority.parentSessionId,
				resolve: async (activation) => {
					const resolved = await resolveParent(activation);
					resolutions += 1;
					if (!resolved.ok || resolutions === 1) {
						return resolved;
					}
					return {
						ok: true,
						value: {
							...resolved.value,
							parentGraphRevision:
								resolved.value.parentGraphRevision + 1,
							parentNodeDigest: canonicalDigest(
								"changed parent authority",
							),
						},
					};
				},
			},
		});
		launchers.push(guarded);
		const create = vi.spyOn(V3SessionManager, "create");

		expect(
			await guarded.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(resolutions).toBe(2);
		expect(create).not.toHaveBeenCalled();
		expect(
			await authorityStore.read(request.agentId),
		).toMatchObject({
			state: "quarantined",
			reason: "parent_authority_changed_before_create",
		});
	});

	it("advances resident authority on resume without changing the durable session or writer fence", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const before = await authorityStore.read(request.agentId);
		if (!before || before.state !== "resident") {
			throw new Error("resident child authority is unavailable");
		}

			const resumeRequest = runtimeResumeRequest(request);
			const resumed = await launcher.resume(
				resumeRequest,
				controller.signal,
			);
		expect(resumed).toMatchObject({
			ok: true,
			value: {
				status: "started",
				launchReceipt: { launchRevision: 2 },
				residencyReceipt: { state: "resident", revision: 2 },
			},
		});
		const after = await authorityStore.read(request.agentId);
		expect(after).toMatchObject({
			state: "resident",
			revision: before.revision + 1,
			previousRecordDigest: before.recordDigest,
			sessionFilePath: before.sessionFilePath,
			genesisCursor: before.genesisCursor,
				childWriterFence: before.childWriterFence,
				initialActivationEvidence:
					before.initialActivationEvidence,
				activationEvidence: {
					activationType: "resume",
					requestId: resumeRequest.requestId,
					requestDigest: resumeRequest.requestDigest,
					parentGraphRevision: 2,
					delegationReceiptDigest:
						resumeRequest.delegationReceipt.receiptDigest,
					workspaceReceiptDigest:
						resumeRequest.workspaceReceipt.receiptDigest,
					budgetReservationDigest: canonicalDigest(
						resumeRequest.budgetReservation,
					),
				},
				launchReceipt: { launchRevision: 2 },
				residencyReceipt: { state: "resident", revision: 2 },
			});
			const revisionAfterResume = after?.revision;
			expect(
				await launcher.resume(
					resumeRequest,
					controller.signal,
				),
			).toEqual(resumed);
			expect(
				(await authorityStore.read(request.agentId))?.revision,
			).toBe(revisionAfterResume);
		});

	it("performs no child create when the durable authority claim conflicts", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		vi.spyOn(authorityStore, "begin").mockResolvedValue(
			"conflict",
		);
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			authorityStore,
		);
		const create = vi.spyOn(V3SessionManager, "create");

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("performs no child create when an applied authority claim cannot be read back exactly", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		const read = authorityStore.read.bind(authorityStore);
		let reads = 0;
		vi.spyOn(authorityStore, "read").mockImplementation(
			async (agentId) => {
				reads += 1;
				return reads === 2 ? undefined : read(agentId);
			},
		);
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			authorityStore,
		);
		const create = vi.spyOn(V3SessionManager, "create");

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("creates exactly once when claim begin commits but loses its acknowledgement", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		const begin = authorityStore.begin.bind(authorityStore);
		vi.spyOn(authorityStore, "begin").mockImplementation(
			async (record) => {
				await begin(record);
				throw new Error(
					"injected acknowledgement loss after child claim commit",
				);
			},
		);
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			authorityStore,
		);
		const create = vi.spyOn(V3SessionManager, "create");

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		expect(create).toHaveBeenCalledTimes(1);
		expect(
			await authorityStore.read(request.agentId),
		).toMatchObject({
			state: "resident",
			claimAttemptId: expect.stringMatching(/^command_/u),
		});
	});

	it("releases a child runtime with an exact replayable nonresident receipt", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
			launcherOptions,
		} = await fixture("allow");
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
					releasedAt: expect.any(String),
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

		const durable = await authorityStore.read(request.agentId);
		expect(durable).toMatchObject({
			state: "released",
			releaseRequest: {
				requestDigest: release.requestDigest,
			},
			releaseReceipt: first.value,
			writerLeaseReleasedEvidence: {
				releasedAt: first.value.releasedAt,
				evidenceDigest: expect.stringMatching(
					/^[a-f0-9]{64}$/u,
				),
			},
		});
		const fresh = new ProductionChildSessionLauncher(
			launcherOptions,
		);
		launchers.push(fresh);
		const stop = vi.spyOn(
			V3SessionManager.prototype,
			"requestStop",
		);
		const close = vi.spyOn(
			V3SessionManager.prototype,
			"closeAll",
		);
		expect(
			await fresh.release(release, controller.signal),
		).toEqual(first);
		expect(stop).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it("releases successfully after the child writer heartbeat refreshes its fence receipt", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		try {
			const {
				launcher,
				request,
				controller,
				authorityStore,
			} = await fixture("allow");
			const launched = await launcher.launch(
				request,
				controller.signal,
			);
			if (!launched.ok || launched.value.status !== "started") {
				throw new Error("child launch failed");
			}
			const before = await authorityStore.read(request.agentId);
			if (before?.state !== "resident") {
				throw new Error("resident authority is unavailable");
			}

			await vi.advanceTimersByTimeAsync(10_001);
			const release = runtimeReleaseRequest(
				request,
				launched.value.launchReceipt,
				launched.value.residencyReceipt,
				"completed",
				"child-gate-release-after-heartbeat",
			);
			expect(
				await launcher.release(release, controller.signal),
			).toMatchObject({ ok: true });
			const released = await authorityStore.read(request.agentId);
			expect(released).toMatchObject({
				state: "released",
				preStopWriterFence: {
					leaseId: before.childWriterFence.leaseId,
					writerEpoch: before.childWriterFence.writerEpoch,
				},
			});
			if (released?.state !== "released") {
				throw new Error("released authority is unavailable");
			}
			expect(
				Date.parse(released.preStopWriterFence.expiresAt),
			).toBeGreaterThan(
				Date.parse(before.childWriterFence.expiresAt),
			);
			expect(released.preStopWriterFence.receiptDigest).not.toBe(
				before.childWriterFence.receiptDigest,
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists release_pending before stop and performs no stop when the CAS conflicts", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		const {
			launcher,
			request,
			controller,
		} = await fixture("allow", undefined, authorityStore);
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"completed",
			"child-gate-release-cas-conflict",
		);
		const compareAndSwap =
			authorityStore.compareAndSwap.bind(authorityStore);
		vi.spyOn(
			authorityStore,
			"compareAndSwap",
		).mockImplementation(
			async (
				agentId,
				expectedRevision,
				expectedDigest,
				next,
			) =>
				next.state === "release_pending"
					? "conflict"
					: compareAndSwap(
							agentId,
							expectedRevision,
							expectedDigest,
							next,
						),
		);
		const stop = vi.spyOn(
			V3SessionManager.prototype,
			"requestStop",
		);

		expect(
			await launcher.release(release, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(stop).not.toHaveBeenCalled();
		expect(
			await authorityStore.read(request.agentId),
		).toMatchObject({ state: "resident" });
	});

	it("makes release_pending durable before the first stop effect", async () => {
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture("allow");
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"completed",
			"child-gate-release-order",
		);
		const originalStop =
			V3SessionManager.prototype.requestStop;
		const stop = vi
			.spyOn(V3SessionManager.prototype, "requestStop")
			.mockImplementation(async function (reason) {
				expect(
					await authorityStore.read(request.agentId),
				).toMatchObject({
					state: "release_pending",
					releaseRequest: {
						requestDigest: release.requestDigest,
					},
				});
				return originalStop.call(this, reason);
			});

		expect(
			await launcher.release(release, controller.signal),
		).toMatchObject({ ok: true });
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("recovers a released authority CAS acknowledgement loss by exact read-back", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		const {
			launcher,
			request,
			controller,
		} = await fixture("allow", undefined, authorityStore);
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
			"completed",
			"child-gate-release-ack-loss",
		);
		const compareAndSwap =
			authorityStore.compareAndSwap.bind(authorityStore);
		let injected = false;
		vi.spyOn(
			authorityStore,
			"compareAndSwap",
		).mockImplementation(
			async (
				agentId,
				expectedRevision,
				expectedDigest,
				next,
			) => {
				const result = await compareAndSwap(
					agentId,
					expectedRevision,
					expectedDigest,
					next,
				);
				if (!injected && next.state === "released") {
					injected = true;
					throw new Error(
						"injected acknowledgement loss after released authority commit",
					);
				}
				return result;
			},
		);
		const stop = vi.spyOn(
			V3SessionManager.prototype,
			"requestStop",
		);

		const released = await launcher.release(
			release,
			controller.signal,
		);
		expect(released).toMatchObject({
			ok: true,
			value: {
				requestDigest: release.requestDigest,
				releasedAt: expect.any(String),
			},
		});
		expect(injected).toBe(true);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(launcher.snapshots()).toEqual([]);
		expect(await authorityStore.read(request.agentId)).toMatchObject({
			state: "released",
			releaseRequest: { requestDigest: release.requestDigest },
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

	it("deduplicates concurrent cancel through public release while preserving its receipt-id result", async () => {
		const authorityStore =
			new MemoryChildRuntimeAuthorityStore();
		const {
			launcher,
			request,
			controller,
		} = await fixture("allow", undefined, authorityStore);
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const seed = "child-gate-concurrent-cancel";
		const cancel = runtimeCancelRequest(request, seed);
		const compareAndSwap =
			authorityStore.compareAndSwap.bind(authorityStore);
		let releasePendingCas: (() => void) | undefined;
		const releasePendingCasGate = new Promise<void>((resolve) => {
			releasePendingCas = resolve;
		});
		const authorityCas = vi
			.spyOn(authorityStore, "compareAndSwap")
			.mockImplementation(
				async (
					agentId,
					expectedRevision,
					expectedDigest,
					next,
				) => {
					const result = await compareAndSwap(
						agentId,
						expectedRevision,
						expectedDigest,
						next,
					);
					if (next.state === "release_pending") {
						await releasePendingCasGate;
					}
					return result;
				},
			);
		const originalStop =
			V3SessionManager.prototype.requestStop;
		let sharedStop: Promise<void> | undefined;
		const stop = vi
			.spyOn(V3SessionManager.prototype, "requestStop")
			.mockImplementation(function (reason) {
				sharedStop ??= originalStop.call(this, reason);
				return sharedStop;
			});

		const firstCancellation = launcher.cancel(
			cancel,
			controller.signal,
		);
		const secondCancellation = launcher.cancel(
			cancel,
			controller.signal,
		);
		await vi.waitFor(() => {
			expect(
				authorityCas.mock.calls.some(
					([, , , next]) =>
						next.state === "release_pending",
				),
			).toBe(true);
		});
		await new Promise<void>((resolveImmediate) => {
			setImmediate(resolveImmediate);
		});
		releasePendingCas?.();

		const [first, second] = await Promise.all([
			firstCancellation,
			secondCancellation,
		]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(first).toMatchObject({
			ok: true,
			value: expect.stringMatching(/^receipt_/u),
		});
		expect(second).toEqual(first);
		const replayed = await launcher.release(
			runtimeReleaseRequest(
				request,
				launched.value.launchReceipt,
				launched.value.residencyReceipt,
				"stopped",
				seed,
			),
			controller.signal,
		);
		expect(replayed).toMatchObject({
			ok: true,
			value: { receiptId: first.ok ? first.value : undefined },
		});
	});

	it("reopens admission after active-child close refusal so governed cleanup and close can retry", async () => {
		const { launcher, request, controller } = await fixture("allow");
		const launched = await launcher.launch(request, controller.signal);
		if (!launched.ok || launched.value.status !== "started") throw new Error("child launch failed");

		await expect(launcher.closeIfIdle()).rejects.toThrow(
			"requires governed terminal cleanup for 1 active or cold-partial child runtime(s)",
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

	it("performs startup and idle decisions through the authority root audit primitive", async () => {
		const authorityStore = new MemoryChildRuntimeAuthorityStore();
		const { launcher } = await fixture("allow", undefined, authorityStore);
		const audit = vi.spyOn(authorityStore, "withExclusiveRootAudit");
		const list = vi.spyOn(authorityStore, "list");

		await expect(launcher.auditAuthority()).resolves.toBeUndefined();
		await expect(launcher.closeIfIdle()).resolves.toBeUndefined();

		expect(audit).toHaveBeenCalledTimes(2);
		expect(list).not.toHaveBeenCalled();
	});

	it("fails startup closed when a fresh launcher observes a cold resident authority", async () => {
		const {
			launcher,
			launcherOptions,
			request,
			controller,
		} = await fixture("allow");
		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({ ok: true, value: { status: "started" } });
		const fresh = new ProductionChildSessionLauncher(launcherOptions);
		launchers.push(fresh);

		await expect(fresh.auditAuthority()).rejects.toThrow(
			"requires explicit recovery for 1 cold partial or resident runtime",
		);
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

	it("quarantines an unregistered child when headless runtime preparation fails", async () => {
		const controlled = controlledRuntimeFactory({
			prepareFailure: new Error(
				"injected headless runtime preparation failure",
			),
		});
		const {
			launcher,
			request,
			controller,
			authorityStore,
		} = await fixture(
			"allow",
			undefined,
			undefined,
			controlled.runtimeFactory,
		);

		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(controlled.runtimeFactory.prepare).toHaveBeenCalledTimes(
			1,
		);
		expect(controlled.host().prepare).toHaveBeenCalledTimes(1);
		expect(launcher.snapshots()).toEqual([]);
		expect(await authorityStore.read(request.agentId)).toMatchObject(
			{
				state: "quarantined",
				reason: "headless_runtime_prepare_failed",
			},
		);
	});

	it("keeps launch side-effect free and activates exactly once for exact graph evidence", async () => {
		const provider = vi.fn();
		const controlled = controlledRuntimeFactory({
			onActivate: provider,
		});
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			undefined,
			controlled.runtimeFactory,
		);

		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const host = controlled.host();
		expect(controlled.runtimeFactory.prepare).toHaveBeenCalledTimes(
			1,
		);
		expect(host.prepare).toHaveBeenCalledTimes(1);
		expect(host.activate).not.toHaveBeenCalled();
		expect(provider).not.toHaveBeenCalled();

		const activation = runtimeActivationRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
		);
		const first = await launcher.activate(
			activation,
			controller.signal,
		);
		if (!first.ok) throw new Error(first.error.message);
		expect(first.value.receipt).toMatchObject({
			requestId: activation.requestId,
			requestDigest: activation.requestDigest,
			parentGraphRevision: activation.parentGraphRevision,
			parentGraphCursor: activation.parentGraphCursor,
			childNodeDigest: activation.childNodeDigest,
		});
		expect(host.activate).toHaveBeenCalledTimes(1);
		expect(provider).toHaveBeenCalledTimes(1);

		const retry = await launcher.activate(
			activation,
			controller.signal,
		);
		expect(retry).toMatchObject({ ok: true });
		if (!retry.ok) throw new Error(retry.error.message);
		expect(retry.value).toBe(first.value);

		const {
			requestDigest: _requestDigest,
			...activationBody
		} = activation;
		const changedBody = {
			...activationBody,
			childNodeDigest: canonicalDigest(
				"changed durable parent graph evidence",
			),
		};
		const conflicting = {
			...changedBody,
			requestDigest: canonicalDigest(changedBody),
		};
		expect(
			await launcher.activate(conflicting, controller.signal),
		).toMatchObject({
			ok: false,
			error: {
				code: "idempotency_conflict",
				retryable: false,
			},
		});
		expect(host.activate).toHaveBeenCalledTimes(1);
		expect(provider).toHaveBeenCalledTimes(1);
	});

	it("interrupts and drains the headless host before manager stop and close on release", async () => {
		const controlled = controlledRuntimeFactory();
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			undefined,
			controlled.runtimeFactory,
		);
		const launched = await launcher.launch(
			request,
			controller.signal,
		);
		if (!launched.ok || launched.value.status !== "started") {
			throw new Error("child launch failed");
		}
		const order: string[] = [];
		const host = controlled.host();
		vi.spyOn(host, "interrupt").mockImplementation(() => {
			order.push("host.interrupt");
		});
		vi.spyOn(host, "drain").mockImplementation(async () => {
			order.push("host.drain");
		});
		const requestStop = V3SessionManager.prototype.requestStop;
		vi.spyOn(
			V3SessionManager.prototype,
			"requestStop",
		).mockImplementation(async function (reason) {
			order.push("manager.requestStop");
			return requestStop.call(this, reason);
		});
		const closeAll = V3SessionManager.prototype.closeAll;
		vi.spyOn(
			V3SessionManager.prototype,
			"closeAll",
		).mockImplementation(async function () {
			order.push("manager.closeAll");
			return closeAll.call(this);
		});
		const release = runtimeReleaseRequest(
			request,
			launched.value.launchReceipt,
			launched.value.residencyReceipt,
		);

		expect(
			await launcher.release(release, controller.signal),
		).toMatchObject({ ok: true });
		expect(order).toEqual([
			"host.interrupt",
			"host.drain",
			"manager.requestStop",
			"manager.closeAll",
		]);
	});

	it("interrupts and drains the headless host before manager close during forced shutdown", async () => {
		const controlled = controlledRuntimeFactory();
		const { launcher, request, controller } = await fixture(
			"allow",
			undefined,
			undefined,
			controlled.runtimeFactory,
		);
		expect(
			await launcher.launch(request, controller.signal),
		).toMatchObject({
			ok: true,
			value: { status: "started" },
		});
		const order: string[] = [];
		const host = controlled.host();
		vi.spyOn(host, "interrupt").mockImplementation(() => {
			order.push("host.interrupt");
		});
		vi.spyOn(host, "drain").mockImplementation(async () => {
			order.push("host.drain");
		});
		const closeAll = V3SessionManager.prototype.closeAll;
		vi.spyOn(
			V3SessionManager.prototype,
			"closeAll",
		).mockImplementation(async function () {
			order.push("manager.closeAll");
			return closeAll.call(this);
		});

		await expect(launcher.close()).resolves.toBeUndefined();
		expect(order).toEqual([
			"host.interrupt",
			"host.drain",
			"manager.closeAll",
		]);
		expect(launcher.snapshots()).toEqual([]);
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
