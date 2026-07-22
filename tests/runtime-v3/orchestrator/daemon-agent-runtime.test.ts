import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { ProviderAuth } from "../../../src/auth/types.ts";
import { createModels, createProvider } from "../../../src/models.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import type { EventCursor } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	ControlPlaneRequestContext,
	PromptPreflightReceipt,
	TurnStartCommand,
} from "../../../src/runtime/control-plane/types.ts";
import type {
	ManagedSessionRuntime,
	SessionRuntimeFactoryPort,
} from "../../../src/runtime/control-plane/session-registry.ts";
import {
	DaemonAgentSessionRuntimeFactoryDecorator,
	DaemonOwnedAgentRuntime,
	type ManagedV3SessionRuntimePort,
} from "../../../src/runtime/integration/daemon-agent-runtime.ts";
import {
	ProductionDaemonAgentSessionFactory,
	type DaemonAgentSessionBindingFactoryPort,
	type DaemonAgentSessionBindingPort,
	type ProductionInteractiveRuntimeFactoryPort,
} from "../../../src/runtime/integration/daemon-agent-session.ts";
import type {
	AgentOperationBudgetCommitRequest,
	AgentOperationBudgetPort,
	AgentOperationBudgetRefundRequest,
	AgentOperationBudgetReservation,
	AgentOperationBudgetReserveRequest,
} from "../../../src/runtime/operation-budget.ts";
import { ToolRegistry } from "../../../src/runtime/tool-registry.ts";
import type {
	AgentTool,
	ModelRequestPreparationInput,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
	ToolResultArtifactSink,
} from "../../../src/runtime/types.ts";
import type { DurableQueueReceipt } from "../../../src/runtime/session/agent-loop-events.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import type { ProductionInteractiveRuntime } from "../../../src/storage/production-interactive-runtime.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ToolCall,
} from "../../../src/types.ts";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";

const roots: string[] = [];
const managers: V3SessionManager[] = [];
const FEATURES: RuntimeFeatureFlags = { ...DEFAULT_RUNTIME_FEATURES, sessionV3: true };
const POLICY_DIGEST = canonicalDigest("daemon-agent-policy");
const LOOP_MODEL: Model<Api> = {
	id: "daemon-loop-model",
	name: "Daemon loop model",
	api: "mock",
	provider: "daemon-fixture",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
};
const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const echoParameters = Type.Object({ text: Type.String() });

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.closeAll().catch(() => undefined)));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function managerFixture(): Promise<{ root: string; manager: V3SessionManager }> {
	const root = await mkdtemp(join(tmpdir(), "runledger-daemon-agent-"));
	roots.push(root);
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: FEATURES,
	});
	managers.push(manager);
	return { root, manager };
}

function ambientFixtureAuth(): ProviderAuth {
	return {
		apiKey: {
			name: "Daemon fixture",
			login: async () => ({ type: "api_key", key: "fixture" }),
			check: async () => ({ source: "daemon fixture", type: "api_key" }),
			resolve: async () => ({ auth: { apiKey: "fixture" }, source: "daemon fixture" }),
		},
	};
}

function assistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function oneToolThenStop(
	events: string[],
): (model: Model<Api>, context: Context) => AssistantMessageEventStream {
	return (model, llmContext) => {
		events.push("execute:provider");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const hasToolResult = llmContext.messages.some((message) => message.role === "toolResult");
			const toolCall: ToolCall = {
				type: "toolCall",
				id: "provider-daemon-echo",
				name: "echo",
				arguments: { text: "daemon-owned" },
			};
			const message = hasToolResult
				? assistantMessage(model, [{ type: "text", text: "done" }], "stop")
				: assistantMessage(model, [toolCall], "toolUse");
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (!hasToolResult) {
				stream.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall,
					partial: message,
				});
			}
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		});
		return stream;
	};
}

function loopModels(events: string[]) {
	const models = createModels();
	const stream = oneToolThenStop(events);
	models.setProvider(createProvider({
		id: LOOP_MODEL.provider,
		name: "Daemon fixture",
		auth: ambientFixtureAuth(),
		models: [LOOP_MODEL],
		api: { stream, streamSimple: stream },
	}));
	return models;
}

function governedEchoTool(directExecutions: { value: number }): AgentTool<typeof echoParameters> {
	return {
		name: "echo",
		label: "Echo",
		description: "Daemon-owned governed echo fixture",
		parameters: echoParameters,
		governedExecution: "tool-context",
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		prepareArguments: (input) => input,
		execute: async (_toolCallId, params) => {
			directExecutions.value += 1;
			return { content: [{ type: "text", text: params.text }] };
		},
	};
}

function installCommittedArtifactSink(manager: V3SessionManager): ToolResultArtifactSink {
	const identity = manager.identity();
	const sink: ToolResultArtifactSink = {
		storeToolResult: async (request) => ({
			content: [{ type: "text", text: "daemon artifact summary" }],
			artifactRef: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				artifactId: createRuntimeId("artifact", `daemon-tool-result-${request.toolCallId}`),
				storedDigest: canonicalDigest(request.content),
				kind: "tool_output",
				originalSize: JSON.stringify(request.content).length,
				storedSize: JSON.stringify(request.content).length,
				mediaType: "application/json",
				redaction: "redacted",
				transformReceipt: createRuntimeId("receipt", `daemon-tool-transform-${request.toolCallId}`),
			},
			resultDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				content: request.content,
			}),
		}),
	};
	Object.defineProperty(manager, "toolResultArtifactSink", {
		configurable: true,
		value: () => sink,
	});
	return sink;
}

class RecordingBudget implements AgentOperationBudgetPort {
	public readonly events: string[];
	public readonly commits: AgentOperationBudgetCommitRequest[] = [];
	#next = 0;

	public constructor(events: string[]) {
		this.events = events;
	}

	public async reserve(
		request: AgentOperationBudgetReserveRequest,
	): Promise<AgentOperationBudgetReservation> {
		this.#next += 1;
		this.events.push(`reserve:${request.kind}`);
		return {
			kind: request.kind,
			operationKey: request.operationKey,
			operationId: createRuntimeId("command", `daemon-budget-operation-${this.#next}`),
			reservationId: createRuntimeId("budgetReservation", `daemon-budget-reservation-${this.#next}`),
			estimatedUpperBound: { ...request.estimatedUpperBound },
			reservedAtMs: Date.now(),
		};
	}

	public async commit(request: AgentOperationBudgetCommitRequest): Promise<void> {
		this.events.push(`commit:${request.reservation.kind}`);
		this.commits.push(request);
	}

	public async refund(request: AgentOperationBudgetRefundRequest): Promise<void> {
		this.events.push(`refund:${request.reservation.kind}`);
	}
}

class RecordingToolGateway implements ToolExecutionGatewayPort {
	public readonly authorizeCalls: ToolExecutionGatewayRequest[] = [];
	public readonly executeCalls: ToolExecutionGatewayExecuteRequest[] = [];
	readonly #manager: V3SessionManager;
	readonly #events: string[];
	readonly #workspaceId = createRuntimeId("workspace", "daemon-agent-loop");

	public constructor(manager: V3SessionManager, events: string[]) {
		this.#manager = manager;
		this.#events = events;
	}

	public async authorize(
		request: ToolExecutionGatewayRequest,
	): Promise<ToolExecutionAuthorizationResult> {
		this.#events.push("authorize:tool");
		this.authorizeCalls.push(request);
		const identity = this.#manager.identity();
		const workspaceEnvelopeDigest = canonicalDigest({
			sessionId: this.#manager.sessionId(),
			workspaceId: this.#workspaceId,
			toolCallId: request.toolCallId,
			cwd: request.cwd,
		});
		const authorizationBody = {
			receiptId: createRuntimeId("receipt", `daemon-tool-authorization-${request.toolCallId}`),
			requestId: createRuntimeId("command", `daemon-tool-request-${request.toolCallId}`),
			approvalId: createRuntimeId("approval", `daemon-tool-approval-${request.toolCallId}`),
			sessionId: this.#manager.sessionId(),
			runtimeId: this.#manager.runtimeId(),
			runtimeGeneration: 1,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			requestDigest: canonicalDigest({ toolCallId: request.toolCallId, arguments: request.arguments }),
			decisionDigest: canonicalDigest({ toolCallId: request.toolCallId, decision: "allow" }),
		};
		const authorization = {
			...authorizationBody,
			receiptDigest: canonicalDigest(authorizationBody),
		};
		const sandboxBody = {
			receiptId: createRuntimeId("receipt", `daemon-tool-sandbox-${request.toolCallId}`),
			profileId: createRuntimeId("resource", "daemon-agent-loop-sandbox"),
			requested: "workspace-write" as const,
			resolved: "workspace-write" as const,
			policyDigest: POLICY_DIGEST,
			backendId: "daemon-fixture-sandbox",
			effectiveEnforcement: "enforced" as const,
		};
		const sandbox = { ...sandboxBody, resolutionDigest: canonicalDigest(sandboxBody) };
		const grantBody = {
			schemaVersion: 1 as const,
			toolCallId: request.toolCallId,
			providerToolCallDigest: canonicalDigest(request.providerToolCallId),
			toolIdentityDigest: canonicalDigest(request.tool.name.trim()),
			argumentsDigest: canonicalDigest(JSON.stringify(request.arguments)),
			invocationDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				providerToolCallId: request.providerToolCallId,
				arguments: request.arguments,
				workspaceEnvelopeDigest,
			}),
			workspaceEnvelopeDigest,
			workspaceValidation: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				receiptId: createRuntimeId("receipt", `daemon-workspace-validation-${request.toolCallId}`),
				workspaceId: this.#workspaceId,
				envelopeDigest: workspaceEnvelopeDigest,
				validatorId: createRuntimeId("principal", "daemon-workspace-validator"),
				validatedAt: "2026-07-22T00:00:00.000Z",
				outcome: "valid" as const,
			},
			authorization,
			capability: "workspace_write" as const,
			policyDigest: POLICY_DIGEST,
			sandbox,
		};
		return {
			status: "authorized",
			grant: { ...grantBody, grantDigest: canonicalDigest(grantBody) },
		};
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
	): Promise<ToolExecutionGatewayExecuteResult> {
		this.#events.push("execute:tool");
		this.executeCalls.push(request);
		return {
			status: "completed",
			grantDigest: request.grant.grantDigest,
			result: {
				content: [{ type: "text", text: "daemon gateway executed" }],
				isError: false,
			},
		};
	}
}

class RecordingProductionRuntimeFactory implements ProductionInteractiveRuntimeFactoryPort {
	public closeCount = 0;
	public prepareCalls: ModelRequestPreparationInput[] = [];
	readonly #cwd: string;
	readonly #tool: AgentTool;
	readonly #gateway: ToolExecutionGatewayPort;
	readonly #budget: AgentOperationBudgetPort;
	readonly #events: string[];

	public constructor(options: {
		cwd: string;
		tool: AgentTool;
		gateway: ToolExecutionGatewayPort;
		budget: AgentOperationBudgetPort;
		events: string[];
	}) {
		this.#cwd = options.cwd;
		this.#tool = options.tool;
		this.#gateway = options.gateway;
		this.#budget = options.budget;
		this.#events = options.events;
	}

	public async create(manager: V3SessionManager): Promise<ProductionInteractiveRuntime> {
		const identity = manager.identity();
		const workspaceId = createRuntimeId("workspace", "daemon-production-runtime");
		const repositoryId = createRuntimeId("repository", "daemon-production-runtime");
		const registry = new ToolRegistry();
		if (!registry.register(this.#tool, { namespace: "production", version: "1" })) {
			throw new Error("fixture tool registration failed");
		}
		const prepareModelRequest = async (input: ModelRequestPreparationInput) => {
			this.#events.push("prepare:model");
			this.prepareCalls.push(input);
			return { model: input.model, context: input.context };
		};
		let closePromise: Promise<void> | undefined;
		const runtime = {
			sessionId: manager.sessionId(),
			cwd: this.#cwd,
			tools: [this.#tool],
			prepareModelRequest,
			toolExecutionGateway: this.#gateway,
			sessionEvents: manager.sessionEvents(),
			toolResultArtifactSink: manager.toolResultArtifactSink(),
			operationBudget: this.#budget,
			workspace: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				principalId: identity.principalId,
				sessionId: manager.sessionId(),
				bindingKind: "source",
				workspaceId,
				repositoryId,
				sourceRepo: this.#cwd,
				sourceCwd: this.#cwd,
				effectiveCwd: this.#cwd,
				worktreePath: this.#cwd,
				subdirOffset: "",
				baseCommit: "0123456789abcdef",
				headCommit: "0123456789abcdef",
				branch: "worktree/daemon-fixture",
				leaseId: createRuntimeId("lease", "daemon-production-runtime"),
				leaseRevision: 1,
				ownerRuntimeId: manager.runtimeId(),
				bindingDigest: canonicalDigest({ workspaceId, manager: manager.runtimeId() }),
			},
			runtimeWorkspace: {
				authorityId: identity.authorityId,
				tenantId: identity.tenantId,
				workspaceId,
				repositoryId,
				bindingKind: "source",
				canonicalCwd: this.#cwd,
				effectiveCwd: this.#cwd,
				branch: "worktree/daemon-fixture",
				baseCommit: "0123456789abcdef",
				headCommit: "0123456789abcdef",
			},
			toolRegistry: registry,
			sessionRuntime: { operationBudget: this.#budget },
			modelRuntime: { prepare: prepareModelRequest },
			featureEvidence: { features: ["turn", "queue"], sessionMutationReady: true },
			paths: {
				workspace: { stateRoot: this.#cwd },
				toolGateway: { stateRoot: this.#cwd },
			},
			close: () => {
				closePromise ??= (async () => {
					this.closeCount += 1;
					await manager.closeAll();
				})();
				return closePromise;
			},
		} as unknown as ProductionInteractiveRuntime;
		return runtime;
	}
}

function context(manager: V3SessionManager): ControlPlaneRequestContext {
	const identity = manager.identity();
	return {
		peer: {
			kind: "local",
			transport: "jsonl",
			pid: process.pid,
			uid: null,
			principalId: identity.principalId,
			authenticatedVia: "stdio_parent",
		},
		handshake: {
			kind: "handshake_ack",
			requestId: "daemon-agent-test",
			serverName: "runledger-test",
			serverVersion: "0.0.1",
			protocol: { major: 1, minor: 0 },
			controlPlaneSchemaVersion: 1,
			runtimeSchemaVersion: 3,
			features: ["turn", "queue"],
			transport: "jsonl",
			serverInstanceId: manager.runtimeId(),
		},
	};
}

function startCommand(manager: V3SessionManager, commandId: string, text: string): TurnStartCommand {
	const head = manager.writer().currentHead();
	if (!head) throw new Error("fixture has no durable head");
	const identity = manager.identity();
	return {
		kind: "command",
		type: "turn:start",
		commandId: createRuntimeId("command", commandId),
		idempotencyKey: createIdempotencyKey(`daemon-agent-${commandId}-0001`),
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		expectedSessionRevision: {
			stream: head.stream,
			sequence: head.sequence,
			eventHash: head.eventHash,
		},
		expectedTurnId: null,
		sessionHandle: null,
		payload: {
			sessionId: manager.sessionId(),
			prompt: {
				storage: "bounded_text",
				text,
				contentDigest: canonicalDigest({ storage: "bounded_text", text }),
			},
		},
	};
}

class RecordingBinding implements DaemonAgentSessionBindingPort {
	public readonly sessionId: SessionId;
	public readonly manager: V3SessionManager;
	public readonly receipts: DurableQueueReceipt[] = [];
	public preflightCount = 0;
	public closeCount = 0;
	public waitForIdleImpl: () => Promise<void> = async () => undefined;
	public closeImpl: () => Promise<void> = async () => undefined;

	public constructor(manager: V3SessionManager) {
		this.manager = manager;
		this.sessionId = manager.sessionId();
	}

	public async preflightPrompt(): Promise<void> {
		this.preflightCount += 1;
	}

	public acceptPrompt(
		_commandId: string,
		text: string,
		_behavior: "start" | "steer" | "followUp",
		receipt: DurableQueueReceipt,
	) {
		this.manager.sessionEvents().claimQueueReceipt(
			receipt,
			{ role: "user", content: [{ type: "text", text }] },
		);
		this.receipts.push(receipt);
		return { started: Promise.resolve(), completion: Promise.resolve() };
	}

	public interrupt(): void {}

	public waitForIdle(): Promise<void> {
		return this.waitForIdleImpl();
	}

	public async close(): Promise<void> {
		this.closeCount += 1;
		await this.closeImpl();
	}
}

class RecordingBindingFactory implements DaemonAgentSessionBindingFactoryPort {
	public readonly bindings: RecordingBinding[] = [];
	public configure?: (binding: RecordingBinding) => void;

	public create(manager: V3SessionManager): Promise<DaemonAgentSessionBindingPort> {
		const binding = new RecordingBinding(manager);
		this.configure?.(binding);
		this.bindings.push(binding);
		return Promise.resolve(binding);
	}
}

class CompletionCapturingBinding implements DaemonAgentSessionBindingPort {
	public readonly sessionId: SessionId;
	public readonly manager: V3SessionManager;
	public completion: Promise<void> | undefined;
	readonly #delegate: DaemonAgentSessionBindingPort;

	public constructor(delegate: DaemonAgentSessionBindingPort) {
		this.#delegate = delegate;
		this.sessionId = delegate.sessionId;
		this.manager = delegate.manager;
	}

	public preflightPrompt(commandId: string, text: string, expectsActiveTurn: boolean): Promise<void> {
		return this.#delegate.preflightPrompt(commandId, text, expectsActiveTurn);
	}

	public acceptPrompt(
		commandId: string,
		text: string,
		behavior: "start" | "steer" | "followUp",
		receipt: DurableQueueReceipt,
	): ReturnType<DaemonAgentSessionBindingPort["acceptPrompt"]> {
		const accepted = this.#delegate.acceptPrompt(commandId, text, behavior, receipt);
		this.completion = accepted.completion;
		return accepted;
	}

	public interrupt(): void {
		this.#delegate.interrupt();
	}

	public waitForIdle(): Promise<void> {
		return this.#delegate.waitForIdle();
	}

	public close(): Promise<void> {
		return this.#delegate.close();
	}
}

class CompletionCapturingFactory implements DaemonAgentSessionBindingFactoryPort {
	public binding: CompletionCapturingBinding | undefined;
	readonly #delegate: DaemonAgentSessionBindingFactoryPort;

	public constructor(delegate: DaemonAgentSessionBindingFactoryPort) {
		this.#delegate = delegate;
	}

	public async create(manager: V3SessionManager): Promise<DaemonAgentSessionBindingPort> {
		const binding = new CompletionCapturingBinding(await this.#delegate.create(manager));
		this.binding = binding;
		return binding;
	}
}

class ManagedFixture implements ManagedV3SessionRuntimePort {
	public readonly sessionId: SessionId;
	public teardownCount = 0;
	readonly #manager: V3SessionManager;

	public constructor(manager: V3SessionManager) {
		this.#manager = manager;
		this.sessionId = manager.sessionId();
	}

	public manager(): V3SessionManager {
		return this.#manager;
	}

	public head(): EventCursor | null {
		return this.#manager.writer().currentHead() ?? null;
	}

	public teardown(_reason: "replacement" | "shutdown") {
		this.teardownCount += 1;
		return this.#manager.closeAll().then(() => ({ ok: true as const, value: undefined }));
	}
}

class SingleRuntimeFactory implements SessionRuntimeFactoryPort {
	readonly #runtime: ManagedSessionRuntime;

	public constructor(runtime: ManagedSessionRuntime) {
		this.#runtime = runtime;
	}

	public start() {
		return Promise.resolve({ ok: true as const, value: this.#runtime });
	}

	public resume(_sessionId: SessionId) {
		return this.start();
	}

	public fork(
		_parentSessionId: SessionId,
		_parentCursor: EventCursor,
		_goalMode: "continue_existing_goal" | "create_child_goal",
	) {
		return this.start();
	}
}

async function submitStart(
	runtime: DaemonOwnedAgentRuntime,
	command: TurnStartCommand,
	requestContext: ControlPlaneRequestContext,
): Promise<{ preflight: PromptPreflightReceipt; result: Awaited<ReturnType<DaemonOwnedAgentRuntime["enqueueDurable"]>> }> {
	const preflight = await runtime.preflight(command, requestContext);
	if (!preflight.ok) throw new Error(preflight.error.message);
	const result = await runtime.enqueueDurable(command, preflight.value, requestContext);
	return { preflight: preflight.value, result };
}

describe("daemon-owned Agent runtime", () => {
	it("claims only an exact queue receipt and rejects a tampered or repeated cursor", async () => {
		const { manager } = await managerFixture();
		const message = { role: "user" as const, content: [{ type: "text" as const, text: "exact" }] };
		const receipt = await manager.sessionEvents().enqueueWithReceipt("steer", message, {
			sourceCommandId: createRuntimeId("command", "exact-claim"),
		});
		const tampered = {
			...receipt,
			cursor: { ...receipt.cursor, eventHash: "f".repeat(64) },
		};
		expect(() => manager.sessionEvents().claimQueueReceipt(tampered, message)).toThrow(/exactly correlated/u);
		expect(manager.sessionEvents().claimQueueReceipt(receipt, message)).toBe(receipt.reference);
		expect(() => manager.sessionEvents().claimQueueReceipt(receipt, message)).toThrow(/already claimed/u);
	});

	it("does not append or accept a second prompt when canonical replay already contains the command", async () => {
		const { manager } = await managerFixture();
		const firstFactory = new RecordingBindingFactory();
		const firstRuntime = new DaemonOwnedAgentRuntime({ sessions: firstFactory });
		const firstManaged = new ManagedFixture(manager);
		expect(await firstRuntime.bindManagedRuntime(firstManaged)).toEqual({ ok: true, value: undefined });
		const command = startCommand(manager, "restart-replay", "do once");
		const first = await submitStart(firstRuntime, command, context(manager));
		expect(first.result.ok).toBe(true);
		expect(firstFactory.bindings[0]?.receipts).toHaveLength(1);

		const filePath = manager.filePath();
		const identity = manager.identity();
		await manager.closeAll();
		const reopened = await V3SessionManager.open(filePath, FEATURES, identity);
		managers.push(reopened);
		const secondFactory = new RecordingBindingFactory();
		const secondRuntime = new DaemonOwnedAgentRuntime({ sessions: secondFactory });
		expect(await secondRuntime.bindManagedRuntime(new ManagedFixture(reopened))).toEqual({ ok: true, value: undefined });
		const duplicate = await submitStart(secondRuntime, command, context(reopened));
		expect(duplicate.result).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "uncertain",
		});
		expect(secondFactory.bindings[0]?.receipts).toHaveLength(0);
		const events = await readAllRuntimeEventsForTest(reopened);
		expect(events.filter((event) => event.type === "queue.enqueued")).toHaveLength(1);
	});

	it("wires one daemon-owned production controller through model preparation, Tool Gateway, and BudgetGuard", async () => {
		const { root, manager } = await managerFixture();
		installCommittedArtifactSink(manager);
		const executionEvents: string[] = [];
		const directExecutions = { value: 0 };
		const tool = governedEchoTool(directExecutions);
		const budget = new RecordingBudget(executionEvents);
		const gateway = new RecordingToolGateway(manager, executionEvents);
		const productionRuntime = new RecordingProductionRuntimeFactory({
			cwd: root,
			tool,
			gateway,
			budget,
			events: executionEvents,
		});
		const sessionFactory = new ProductionDaemonAgentSessionFactory({
			models: loopModels(executionEvents),
			runtime: productionRuntime,
			systemPrompt: "daemon-owned production loop",
			settings: {
				provider: LOOP_MODEL.provider,
				model: LOOP_MODEL.id,
			},
		});
		const capturingFactory = new CompletionCapturingFactory(sessionFactory);
		const agents = new DaemonOwnedAgentRuntime({ sessions: capturingFactory });
		expect(await agents.bindManagedRuntime(new ManagedFixture(manager))).toEqual({
			ok: true,
			value: undefined,
		});

		const submitted = await submitStart(
			agents,
			startCommand(manager, "production-loop", "run governed echo"),
			context(manager),
		);
		expect(submitted.result.ok).toBe(true);
		await capturingFactory.binding?.completion;
		expect(await agents.closeSession(manager.sessionId(), "shutdown")).toEqual({
			ok: true,
			value: undefined,
		});
		expect(productionRuntime.prepareCalls).toHaveLength(2);
		expect(gateway.authorizeCalls).toHaveLength(1);
		expect(gateway.executeCalls).toHaveLength(1);
		expect(directExecutions.value).toBe(0);
		expect(productionRuntime.closeCount).toBe(1);
		expect(manager.isClosed()).toBe(true);
		expect(budget.commits.map((commit) => commit.reservation.kind)).toEqual([
			"provider",
			"tool",
			"provider",
		]);
		expect(budget.commits.every((commit) => /^[a-f0-9]{64}$/u.test(commit.resultDigest))).toBe(true);
		for (const kind of ["provider", "tool"] as const) {
			const reserve = executionEvents.indexOf(`reserve:${kind}`);
			const execute = executionEvents.indexOf(`execute:${kind}`);
			const commit = executionEvents.indexOf(`commit:${kind}`);
			expect(reserve).toBeGreaterThanOrEqual(0);
			expect(reserve).toBeLessThan(execute);
			expect(execute).toBeLessThan(commit);
		}
		expect(executionEvents.filter((event) => event === "prepare:model")).toHaveLength(2);
	});

	it("keeps the writer owned and skips managed teardown when bounded drain times out", async () => {
		const { manager } = await managerFixture();
		const bindingFactory = new RecordingBindingFactory();
		bindingFactory.configure = (binding) => {
			binding.waitForIdleImpl = () => new Promise<void>(() => undefined);
		};
		const agents = new DaemonOwnedAgentRuntime({ sessions: bindingFactory, drainTimeoutMs: 5 });
		const managed = new ManagedFixture(manager);
		const decorated = new DaemonAgentSessionRuntimeFactoryDecorator(
			new SingleRuntimeFactory(managed),
			agents,
		);
		const started = await decorated.start();
		expect(started.ok).toBe(true);
		if (!started.ok) throw new Error(started.error.message);
		const stopped = await started.value.teardown("shutdown");
		expect(stopped).toMatchObject({
			ok: false,
			error: { code: "recovery_required" },
			effect: "uncertain",
		});
		expect(bindingFactory.bindings[0]?.closeCount).toBe(0);
		expect(managed.teardownCount).toBe(0);
		expect(manager.isClosed()).toBe(false);
		expect(agents.isBound(manager.sessionId())).toBe(true);
	});

	it("does not release the managed writer when production session close is uncertain", async () => {
		const { manager } = await managerFixture();
		const bindingFactory = new RecordingBindingFactory();
		bindingFactory.configure = (binding) => {
			binding.closeImpl = async () => { throw new Error("injected close failure"); };
		};
		const agents = new DaemonOwnedAgentRuntime({ sessions: bindingFactory, drainTimeoutMs: 50 });
		const managed = new ManagedFixture(manager);
		const decorated = new DaemonAgentSessionRuntimeFactoryDecorator(
			new SingleRuntimeFactory(managed),
			agents,
		);
		const started = await decorated.start();
		if (!started.ok) throw new Error(started.error.message);
		const stopped = await started.value.teardown("replacement");
		expect(stopped).toMatchObject({ ok: false, effect: "uncertain" });
		expect(bindingFactory.bindings[0]?.closeCount).toBe(1);
		expect(managed.teardownCount).toBe(0);
		expect(manager.isClosed()).toBe(false);
	});
});

async function readAllRuntimeEventsForTest(manager: V3SessionManager) {
	const events = await readAllRuntimeEvents(manager.eventStore());
	if (!events.ok) throw new Error(events.error.message);
	return events.value;
}
