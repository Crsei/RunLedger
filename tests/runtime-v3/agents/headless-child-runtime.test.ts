import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { ChildOperationBudget } from "../../../src/runtime/agents/integration/child-operation-budget.ts";
import { HeadlessChildRuntimeHost } from "../../../src/runtime/agents/integration/headless-child-runtime.ts";
import type { AgentBudgetRequest } from "../../../src/runtime/agents/types.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import {
	zeroAgentOperationBudgetUsage,
	type AgentOperationBudgetUsage,
} from "../../../src/runtime/operation-budget.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId, isRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { mockModel, mockStreamFn } from "../../../src/runtime/providers/mock-stream.ts";
import {
	DEFAULT_RUNTIME_FEATURES,
	type RuntimeFeatureFlags,
} from "../../../src/runtime/runtime-features.ts";
import { readAllRuntimeEvents } from "../../../src/runtime/session/snapshot.ts";
import { echoTool } from "../../../src/runtime/tools/echo.ts";
import type {
	AgentTool,
	StreamFn,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
} from "../../../src/runtime/types.ts";
import { V3SessionManager } from "../../../src/storage/v3-session-manager.ts";

const NOW = "2026-07-23T00:00:00.000Z";
const POLICY_DIGEST = canonicalDigest("headless child runtime test policy");
const FEATURES: RuntimeFeatureFlags = {
	...DEFAULT_RUNTIME_FEATURES,
	sessionV3: true,
};
const CHILD_BUDGET: AgentBudgetRequest = {
	maxTurns: 8,
	maxInputTokens: 16_384,
	maxOutputTokens: 8_192,
	maxUsdMicros: 1_000_000,
	maxWallTimeMs: 1_000_000,
	maxToolCalls: 8,
	maxNetworkBytes: 8_000_000,
	maxStorageBytes: 8_000_000,
};

const roots: string[] = [];
const managers: V3SessionManager[] = [];

type GatewayMode = "completed" | "uncertain";

function operationUsage(
	values: Partial<AgentOperationBudgetUsage> = {},
): AgentOperationBudgetUsage {
	return { ...zeroAgentOperationBudgetUsage(), ...values };
}

function governedEchoTool() {
	const execute = vi.fn(
		(...args: Parameters<typeof echoTool.execute>) =>
			echoTool.execute(...args),
	);
	const tool: AgentTool = {
		...echoTool,
		governedExecution: "tool-context",
		execute,
	};
	return { tool, execute };
}

class EchoGateway implements ToolExecutionGatewayPort {
	public readonly executeCalls: ToolExecutionGatewayExecuteRequest[] = [];
	readonly #manager: V3SessionManager;
	readonly #mode: GatewayMode;

	public constructor(manager: V3SessionManager, mode: GatewayMode) {
		this.#manager = manager;
		this.#mode = mode;
	}

	public async authorize(
		request: ToolExecutionGatewayRequest,
	): Promise<ToolExecutionAuthorizationResult> {
		const identity = this.#manager.identity();
		const workspaceId = createRuntimeId(
			"workspace",
			"headless-child-runtime",
		);
		const workspaceEnvelopeDigest = canonicalDigest({
			sessionId: this.#manager.sessionId(),
			workspaceId,
			toolCallId: request.toolCallId,
			cwd: request.cwd,
		});
		const authorizationBody = {
			receiptId: createRuntimeId(
				"receipt",
				`headless-auth-${request.toolCallId}`,
			),
			requestId: createRuntimeId(
				"command",
				`headless-auth-${request.toolCallId}`,
			),
			approvalId: createRuntimeId(
				"approval",
				`headless-auth-${request.toolCallId}`,
			),
			sessionId: this.#manager.sessionId(),
			runtimeId: this.#manager.runtimeId(),
			runtimeGeneration: 1,
			turnId: request.turnId,
			toolCallId: request.toolCallId,
			requestDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				arguments: request.arguments,
			}),
			decisionDigest: canonicalDigest({
				toolCallId: request.toolCallId,
				decision: "allow",
			}),
		};
		const authorization = {
			...authorizationBody,
			receiptDigest: canonicalDigest(authorizationBody),
		};
		const sandboxBody = {
			receiptId: createRuntimeId(
				"receipt",
				`headless-sandbox-${request.toolCallId}`,
			),
			profileId: createRuntimeId(
				"resource",
				"headless-child-runtime-sandbox",
			),
			requested: "read-only" as const,
			resolved: "read-only" as const,
			policyDigest: POLICY_DIGEST,
			backendId: "headless-child-runtime-test",
			effectiveEnforcement: "enforced" as const,
		};
		const sandbox = {
			...sandboxBody,
			resolutionDigest: canonicalDigest(sandboxBody),
		};
		const grantBody = {
			schemaVersion: 1 as const,
			toolCallId: request.toolCallId,
			providerToolCallDigest: canonicalDigest(
				request.providerToolCallId,
			),
			toolIdentityDigest: canonicalDigest(
				request.tool.name.trim(),
			),
			argumentsDigest: canonicalDigest(
				JSON.stringify(request.arguments),
			),
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
				receiptId: createRuntimeId(
					"receipt",
					`headless-workspace-${request.toolCallId}`,
				),
				workspaceId,
				envelopeDigest: workspaceEnvelopeDigest,
				validatorId: createRuntimeId(
					"principal",
					"headless-child-runtime-validator",
				),
				validatedAt: NOW,
				outcome: "valid" as const,
			},
			authorization,
			capability: "repository_read" as const,
			policyDigest: POLICY_DIGEST,
			sandbox,
		};
		return {
			status: "authorized",
			grant: {
				...grantBody,
				grantDigest: canonicalDigest(grantBody),
			},
		};
	}

	public async start(
		request: ToolExecutionGatewayExecuteRequest,
		durableStart: () => Promise<void>,
	): Promise<{ status: "ready"; grantDigest: string }> {
		await durableStart();
		return {
			status: "ready",
			grantDigest: request.grant.grantDigest,
		};
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
	): Promise<ToolExecutionGatewayExecuteResult> {
		this.executeCalls.push(request);
		if (this.#mode === "uncertain") {
			return {
				status: "uncertain",
				grantDigest: request.grant.grantDigest,
				reason: "injected tool outcome uncertainty",
				outcomeCertain: false,
			};
		}
		const result = await request.invocation.tool.execute(
			request.invocation.providerToolCallId,
			request.invocation.arguments as never,
		);
		return {
			status: "completed",
			grantDigest: request.grant.grantDigest,
			result,
		};
	}
}

async function createManager(seed: string): Promise<{
	manager: V3SessionManager;
	root: string;
}> {
	const root = await mkdtemp(
		join(tmpdir(), `runledger-headless-child-${seed}-`),
	);
	roots.push(root);
	const manager = await V3SessionManager.create({
		cwd: root,
		sessionDir: join(root, "sessions"),
		features: FEATURES,
		identity: createLocalIdentityContext(new Date(NOW)),
		sessionId: createRuntimeId("session", `headless-child-${seed}`),
		runtimeId: createRuntimeId("runtime", `headless-child-${seed}`),
	});
	managers.push(manager);
	return { manager, root };
}

async function createHost(options: {
	seed: string;
	streamFn?: StreamFn;
	gatewayMode?: GatewayMode;
	budget?: ChildOperationBudget;
}) {
	const { manager, root } = await createManager(options.seed);
	const budget =
		options.budget ??
		new ChildOperationBudget({
			budget: CHILD_BUDGET,
			clock: () => new Date(NOW),
		});
	const streamFn = options.streamFn ?? mockStreamFn;
	const stream = vi.fn(
		(...args: Parameters<StreamFn>): ReturnType<StreamFn> =>
			streamFn(...args),
	);
	const { tool, execute } = governedEchoTool();
	const gateway = new EchoGateway(
		manager,
		options.gatewayMode ?? "completed",
	);
	let agent: Agent | undefined;
	const host = new HeadlessChildRuntimeHost({
		manager,
		operationBudget: budget,
		prompt: "execute the bounded child fixture",
		agentFactory: ({ sessionEvents, operationBudget }) => {
			agent = new Agent({
				initialState: {
					systemPrompt: "bounded headless child",
					model: mockModel,
					tools: [tool],
				},
				streamFn: stream,
				loopConfig: {
					cwd: root,
					sessionEvents,
					operationBudget,
					toolExecutionGateway: gateway,
				},
			});
			return agent;
		},
	});
	return {
		host,
		manager,
		budget,
		stream,
		execute,
		gateway,
		agent: () => agent,
	};
}

afterEach(async () => {
	await Promise.all(
		managers
			.splice(0)
			.map((manager) => manager.closeAll().catch(() => undefined)),
	);
	await Promise.all(
		roots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
	vi.restoreAllMocks();
});

describe("HeadlessChildRuntimeHost", () => {
	it("keeps construction and prepare free of model and tool side effects", async () => {
		const fixture = await createHost({ seed: "prepare" });

		expect(fixture.stream).not.toHaveBeenCalled();
		expect(fixture.execute).not.toHaveBeenCalled();
		await fixture.host.prepare();
		await fixture.host.prepare();
		expect(fixture.agent()).toBeInstanceOf(Agent);
		expect(fixture.stream).not.toHaveBeenCalled();
		expect(fixture.execute).not.toHaveBeenCalled();
	});

	it("calls Agent.prompt only after activation and returns exact terminal evidence", async () => {
		const fixture = await createHost({ seed: "complete" });
		await fixture.host.prepare();
		const agent = fixture.agent();
		if (!agent) throw new Error("prepared fixture did not construct its Agent");
		const prompt = vi.spyOn(agent, "prompt");

		expect(prompt).not.toHaveBeenCalled();
		await fixture.host.activate();
		expect(prompt).toHaveBeenCalledTimes(1);

		const completed = await fixture.host.completion();
		expect(completed.ok).toBe(true);
		if (!completed.ok) throw new Error(completed.error.message);
		expect(completed.value.outcome).toBe("completed");
		expect(Object.keys(completed.value.usage).sort()).toEqual(
			[
				"inputTokens",
				"outputTokens",
				"usdMicros",
				"wallTimeMs",
				"toolCalls",
				"networkBytes",
				"storageBytes",
				"artifactCount",
				"verifications",
			].sort(),
		);
		expect(
			Object.values(completed.value.usage).every(
				(value) => Number.isSafeInteger(value) && value >= 0,
			),
		).toBe(true);
		expect(completed.value.usage.toolCalls).toBe(
			fixture.gateway.executeCalls.length,
		);
		expect(fixture.execute).toHaveBeenCalled();

		const replay = await readAllRuntimeEvents(
			fixture.manager.eventStore(),
		);
		expect(replay.ok).toBe(true);
		if (!replay.ok) throw new Error(replay.error.message);
		const canonicalTurnIds = replay.value
			.filter(
				(event) =>
					event.type === "turn.finished" ||
					event.type === "turn.failed" ||
					event.type === "turn.interrupted",
			)
			.map((event) => event.payload.turnId);
		expect(canonicalTurnIds.length).toBeGreaterThan(0);
		expect(completed.value.turnIds).toEqual(canonicalTurnIds);
		expect(
			completed.value.turnIds.every((turnId) =>
				isRuntimeId(turnId, "turn"),
			),
		).toBe(true);
		expect(completed.value.finalCursor).toEqual(
			fixture.manager.writer().currentHead(),
		);
	});

	it("makes interrupt and drain idempotent without inventing usage for an in-flight provider", async () => {
		let releaseStream: (() => void) | undefined;
		let reportStarted: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseStream = resolve;
		});
		const started = new Promise<void>((resolve) => {
			reportStarted = resolve;
		});
		const delayedStream: StreamFn = async (...args) => {
			reportStarted?.();
			await gate;
			return mockStreamFn(...args);
		};
		const fixture = await createHost({
			seed: "interrupt",
			streamFn: delayedStream,
		});
		await fixture.host.prepare();
		const agent = fixture.agent();
		if (!agent) throw new Error("prepared fixture did not construct its Agent");
		const interrupt = vi.spyOn(agent, "interrupt");
		const waitForIdle = vi.spyOn(agent, "waitForIdle");

		await fixture.host.activate();
		await started;
		fixture.host.interrupt();
		fixture.host.interrupt();
		expect(interrupt).toHaveBeenCalledTimes(1);
		releaseStream?.();

		const firstDrain = fixture.host.drain();
		const secondDrain = fixture.host.drain();
		await Promise.all([firstDrain, secondDrain]);
		await fixture.host.drain();
		expect(waitForIdle).toHaveBeenCalledTimes(1);

		const completed = await fixture.host.completion();
		expect(completed).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
	});

	it("returns an exact stopped completion when interrupted before activation", async () => {
		const fixture = await createHost({ seed: "pre-activation-interrupt" });
		await fixture.host.prepare();
		const agent = fixture.agent();
		if (!agent) throw new Error("prepared fixture did not construct its Agent");
		const prompt = vi.spyOn(agent, "prompt");
		const interrupt = vi.spyOn(agent, "interrupt");

		fixture.host.interrupt();
		fixture.host.interrupt();
		await fixture.host.activate();

		expect(prompt).not.toHaveBeenCalled();
		expect(interrupt).toHaveBeenCalledTimes(1);
		expect(await fixture.host.completion()).toMatchObject({
			ok: true,
			value: {
				outcome: "stopped",
				reason: "cancelled",
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					toolCalls: 0,
				},
				turnIds: [],
			},
		});
	});

	it("fails completion and usage closed when a provider outcome is uncertain", async () => {
		const providerFailure: StreamFn = () => {
			throw new Error("injected provider ACK loss");
		};
		const fixture = await createHost({
			seed: "provider-uncertain",
			streamFn: providerFailure,
		});
		await fixture.host.prepare();
		await fixture.host.activate();

		expect(await fixture.host.completion()).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(await fixture.budget.usage()).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
	});

	it("fails completion and usage closed when a tool outcome is uncertain", async () => {
		const fixture = await createHost({
			seed: "tool-uncertain",
			gatewayMode: "uncertain",
		});
		await fixture.host.prepare();
		await fixture.host.activate();

		expect(await fixture.host.completion()).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
		expect(fixture.gateway.executeCalls).toHaveLength(1);
		expect(await fixture.budget.usage()).toMatchObject({
			ok: false,
			error: {
				code: "reference_unavailable",
				retryable: true,
			},
		});
	});
});
