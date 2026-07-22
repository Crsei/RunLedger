import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "../../../src/types.ts";
import {
	MutationGatedToolExecutionGateway,
	SessionMutationAdmissionError,
	mutationGatedModelPreparation,
	type SessionMutationAdmissionGatePort,
	type SessionMutationAdmissionReceipt,
} from "../../../src/runtime/lifecycle/mutation-gate.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import type {
	AgentTool,
	ModelRequestPreparationInput,
	ToolExecutionAuthorizationGrant,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
} from "../../../src/runtime/types.ts";

type MutationRequest = Parameters<SessionMutationAdmissionGatePort["revalidate"]>[0];

const MODEL_REQUEST_ID = createRuntimeId("modelRequest", "mutation-adapter");
const TURN_ID = createRuntimeId("turn", "mutation-adapter");
const TOOL_CALL_ID = createRuntimeId("toolCall", "mutation-adapter");
const POLICY_DIGEST = canonicalDigest("mutation-adapter-policy");
const AUTHORITY_ID = createRuntimeId("authority", "mutation-adapter");
const TENANT_ID = createRuntimeId("tenant", "mutation-adapter");
const PRINCIPAL_ID = createRuntimeId("principal", "mutation-adapter");
const SESSION_ID = createRuntimeId("session", "mutation-adapter");
const EVENT_HEAD = {
	stream: createSessionEventStreamRef({
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
	}, SESSION_ID),
	sequence: 4,
	eventId: createRuntimeId("event", "mutation-adapter-head"),
	eventHash: canonicalDigest("mutation-adapter-head"),
};

function admissionReceipt(request: MutationRequest): SessionMutationAdmissionReceipt {
	const body = {
		schemaVersion: 1 as const,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		sessionId: SESSION_ID,
		kind: request.kind,
		correlationId: request.correlationId,
		eventHead: EVENT_HEAD,
		checkedAt: "2026-07-23T00:00:00.000Z",
		auditReceipts: [],
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

class RecordingGate implements SessionMutationAdmissionGatePort {
	public readonly requests: MutationRequest[] = [];
	public readonly events: string[];
	readonly #outcome: "allow" | "reject";

	public constructor(outcome: "allow" | "reject", events: string[] = []) {
		this.#outcome = outcome;
		this.events = events;
	}

	public async revalidate(request: MutationRequest): Promise<Awaited<ReturnType<SessionMutationAdmissionGatePort["revalidate"]>>> {
		this.events.push(`gate:${request.kind}`);
		this.requests.push(request);
		if (this.#outcome === "reject") {
			return {
				ok: false as const,
				error: {
					code: "external_unavailable" as const,
					message: "continuous receipt audit rejected the mutation",
					retryable: false,
				},
			};
		}
		return { ok: true as const, value: admissionReceipt(request) };
	}
}

function model(): Model<Api> {
	return {
		id: "fixture-model",
		name: "fixture-model",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 1_024,
	};
}

function modelRequest(): ModelRequestPreparationInput {
	return {
		turn: 1,
		turnId: TURN_ID,
		modelRequestId: MODEL_REQUEST_ID,
		model: model(),
		context: { systemPrompt: "fixture", messages: [], tools: [] },
		messages: [],
	};
}

const tool: AgentTool = {
	name: "mutation_fixture",
	label: "mutation fixture",
	description: "adapter ordering fixture",
	parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
	governedExecution: "tool-context",
	async execute() {
		return { content: [{ type: "text", text: "unused" }], details: {} };
	},
};

function toolRequest(): ToolExecutionGatewayRequest {
	return {
		turnId: TURN_ID,
		toolCallId: TOOL_CALL_ID,
		providerToolCallId: "provider-mutation-adapter",
		tool,
		arguments: { value: "fixture" },
		cwd: "/workspace",
		envVars: {},
	};
}

function grant(request: ToolExecutionGatewayRequest): ToolExecutionAuthorizationGrant {
	const runtimeId = createRuntimeId("runtime", "mutation-adapter");
	const authorizationBody = {
		receiptId: createRuntimeId("receipt", "mutation-adapter-authorization"),
		requestId: createRuntimeId("command", "mutation-adapter-authorization"),
		approvalId: createRuntimeId("approval", "mutation-adapter-authorization"),
		sessionId: SESSION_ID,
		runtimeId,
		runtimeGeneration: 1,
		turnId: request.turnId,
		toolCallId: request.toolCallId,
		requestDigest: canonicalDigest("mutation-adapter-request"),
		decisionDigest: canonicalDigest("mutation-adapter-decision"),
	};
	const authorization = {
		...authorizationBody,
		receiptDigest: canonicalDigest(authorizationBody),
	};
	const sandboxBody = {
		receiptId: createRuntimeId("receipt", "mutation-adapter-sandbox"),
		profileId: createRuntimeId("resource", "mutation-adapter-sandbox"),
		requested: "workspace-write" as const,
		resolved: "workspace-write" as const,
		policyDigest: POLICY_DIGEST,
		backendId: "fixture-sandbox",
		effectiveEnforcement: "enforced" as const,
	};
	const sandbox = { ...sandboxBody, resolutionDigest: canonicalDigest(sandboxBody) };
	const workspaceEnvelopeDigest = canonicalDigest("mutation-adapter-workspace-envelope");
	const body = {
		schemaVersion: 1 as const,
		toolCallId: request.toolCallId,
		providerToolCallDigest: canonicalDigest(request.providerToolCallId),
		toolIdentityDigest: canonicalDigest(request.tool.name),
		argumentsDigest: canonicalDigest(request.arguments),
		invocationDigest: canonicalDigest({ toolCallId: request.toolCallId, arguments: request.arguments }),
		workspaceEnvelopeDigest,
		workspaceValidation: {
			authorityId: AUTHORITY_ID,
			tenantId: TENANT_ID,
			principalId: PRINCIPAL_ID,
			receiptId: createRuntimeId("receipt", "mutation-adapter-workspace"),
			workspaceId: createRuntimeId("workspace", "mutation-adapter"),
			envelopeDigest: workspaceEnvelopeDigest,
			validatorId: PRINCIPAL_ID,
			validatedAt: "2026-07-23T00:00:00.000Z",
			outcome: "valid" as const,
		},
		authorization,
		capability: "workspace_write" as const,
		policyDigest: POLICY_DIGEST,
		sandbox,
	};
	return { ...body, grantDigest: canonicalDigest(body) };
}

class RecordingToolGateway implements ToolExecutionGatewayPort {
	public readonly authorizeRequests: ToolExecutionGatewayRequest[] = [];
	public readonly executeRequests: ToolExecutionGatewayExecuteRequest[] = [];
	public readonly events: string[];

	public constructor(events: string[] = []) {
		this.events = events;
	}

	public async authorize(request: ToolExecutionGatewayRequest): Promise<ToolExecutionAuthorizationResult> {
		this.events.push("delegate:authorize");
		this.authorizeRequests.push(request);
		return {
			status: "unavailable" as const,
			requestId: createRuntimeId("command", "delegate-authorize-result"),
			reason: "delegate result",
		};
	}

	public async execute(request: ToolExecutionGatewayExecuteRequest): Promise<ToolExecutionGatewayExecuteResult> {
		this.events.push("delegate:execute");
		this.executeRequests.push(request);
		return {
			status: "completed" as const,
			grantDigest: request.grant.grantDigest,
			result: { content: [{ type: "text" as const, text: "delegate result" }], details: {} },
		};
	}
}

describe("session mutation gate adapters", () => {
	it("fails model preparation closed before invoking the provider preparation delegate", async () => {
		const gate = new RecordingGate("reject");
		const prepare = vi.fn(async (request: ModelRequestPreparationInput) => ({
			model: request.model,
			context: request.context,
		}));
		const guarded = mutationGatedModelPreparation(gate, prepare);

		await expect(guarded(modelRequest())).rejects.toBeInstanceOf(SessionMutationAdmissionError);

		expect(prepare).not.toHaveBeenCalled();
		expect(gate.requests).toStrictEqual([{
			kind: "model_request",
			correlationId: MODEL_REQUEST_ID,
		}]);
	});

	it("revalidates tool authorization before the delegate can consult or populate its cache", async () => {
		const events: string[] = [];
		const gate = new RecordingGate("reject", events);
		const delegate = new RecordingToolGateway(events);
		const gateway = new MutationGatedToolExecutionGateway(gate, delegate);

		const result = await gateway.authorize(toolRequest());

		expect(result).toMatchObject({ status: "unavailable" });
		expect(delegate.authorizeRequests).toHaveLength(0);
		expect(events).toEqual(["gate:tool_authorize"]);
		expect(gate.requests).toStrictEqual([{
			kind: "tool_authorize",
			correlationId: TOOL_CALL_ID,
		}]);
	});

	it("revalidates tool execution before the delegate can claim a durable attempt", async () => {
		const events: string[] = [];
		const gate = new RecordingGate("reject", events);
		const delegate = new RecordingToolGateway(events);
		const gateway = new MutationGatedToolExecutionGateway(gate, delegate);
		const invocation = toolRequest();
		const authorizationGrant = grant(invocation);

		const result = await gateway.execute(
			{ invocation, grant: authorizationGrant },
			() => undefined,
		);

		expect(result).toEqual({
			status: "unavailable",
			grantDigest: authorizationGrant.grantDigest,
			reason: "continuous receipt audit rejected the mutation",
			outcomeCertain: true,
		});
		expect(delegate.executeRequests).toHaveLength(0);
		expect(events).toEqual(["gate:tool_execute"]);
		expect(gate.requests).toStrictEqual([{
			kind: "tool_execute",
			correlationId: TOOL_CALL_ID,
		}]);
	});

	it("passes exact correlations once and invokes each admitted delegate once", async () => {
		const events: string[] = [];
		const gate = new RecordingGate("allow", events);
		const prepare = vi.fn(async (request: ModelRequestPreparationInput) => ({
			model: request.model,
			context: request.context,
		}));
		const guardedPrepare = mutationGatedModelPreparation(gate, prepare);
		const delegate = new RecordingToolGateway(events);
		const gateway = new MutationGatedToolExecutionGateway(gate, delegate);
		const invocation = toolRequest();
		const authorizationGrant = grant(invocation);

		await guardedPrepare(modelRequest());
		await gateway.authorize(invocation);
		await gateway.execute({ invocation, grant: authorizationGrant }, () => undefined);

		expect(gate.requests).toStrictEqual([
			{ kind: "model_request", correlationId: MODEL_REQUEST_ID },
			{ kind: "tool_authorize", correlationId: TOOL_CALL_ID },
			{ kind: "tool_execute", correlationId: TOOL_CALL_ID },
		]);
		expect(prepare).toHaveBeenCalledOnce();
		expect(delegate.authorizeRequests).toEqual([invocation]);
		expect(delegate.executeRequests).toEqual([{ invocation, grant: authorizationGrant }]);
		expect(events).toEqual([
			"gate:model_request",
			"gate:tool_authorize",
			"delegate:authorize",
			"gate:tool_execute",
			"delegate:execute",
		]);
	});
});
