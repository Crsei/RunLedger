import * as path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/runtime/agent.ts";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import {
	approvalTicketDigest,
	approvalTicketRequestDigest,
	CAPABILITY_GATEWAY_SCHEMA_VERSION,
	capabilityGatewayRequestDigest,
	type ApprovalCoordinatorPort,
	type ApprovalCoordinatorRequest,
	type ApprovalCoordinatorResult,
	type ApprovalReceiptRef,
	type ApprovalTicket,
	type CapabilityGatewayPort,
	type CapabilityGatewayRequest,
	type CapabilityGatewayResult,
	type SecurityPortCancelRequest,
	type SecurityPortCancelResult,
} from "../../src/runtime/protocol/v3/capability.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import {
	workspaceExecutionEnvelopeDigest,
	type WorkspaceExecutionEnvelope,
	type WorkspaceServicePort,
	type WorkspaceServiceRequest,
	type WorkspaceServiceResult,
} from "../../src/runtime/protocol/v3/workspace.ts";
import { AgentLoopSessionEvents } from "../../src/runtime/session/agent-loop-events.ts";
import { EventWriter } from "../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../src/runtime/session/memory-event-store.ts";
import { reduceSessionEvents } from "../../src/runtime/session/reducer.ts";
import {
	createSessionEventStreamRef,
	type RuntimeEventV3,
} from "../../src/runtime/protocol/v3/events.ts";
import type { WriterFence } from "../../src/runtime/session/types.ts";
import {
	MemoryToolExecutionAttemptStore,
	PortBackedToolExecutionGateway,
	type RestrictedToolExecutionEnvironmentPort,
	type RestrictedToolExecutionLease,
	type ToolExecutionCapabilityRequestFactoryPort,
	type ToolExecutionWorkspaceResolverPort,
} from "../../src/security/integration/tool-execution-gateway.ts";
import {
	createApprovalSupersessionReceipt,
	MemoryApprovalStateStore,
} from "../../src/security/permission/approval-coordinator.ts";
import type {
	AgentTool,
	AgentToolResult,
	LlmContext,
	StreamFn,
	ToolExecutionAuthorizationGrant,
	ToolExecutionGatewayPort,
	ToolExecutionGatewayRequest,
	ToolSandboxResolutionReceiptRef,
} from "../../src/runtime/types.ts";
import type { Api, AssistantMessage, Model, ToolCall } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = "2026-07-22T00:00:00.000Z";
const ROOT = "/repo";
const AUTHORITY = createRuntimeId("authority", "governed-e2e");
const TENANT = createRuntimeId("tenant", "governed-e2e");
const PRINCIPAL = createRuntimeId("principal", "governed-e2e");
const SESSION = createRuntimeId("session", "governed-e2e");
const SESSION_STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY, tenantId: TENANT }, SESSION);
const AGENT = createRuntimeId("agent", "governed-e2e");
const RUNTIME = createRuntimeId("runtime", "governed-e2e");
const REPOSITORY = createRuntimeId("repository", "governed-e2e");
const WORKSPACE = createRuntimeId("workspace", "governed-e2e");
const PROFILE = createRuntimeId("resource", "governed-e2e-sandbox");

const MODEL: Model<Api> = {
	id: "governed-model", name: "Governed", api: "mock", provider: "fixture", baseUrl: "http://localhost",
	reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192, maxTokens: 1024,
};
const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", content, api: MODEL.api, provider: MODEL.provider, model: MODEL.id, usage: ZERO_USAGE, stopReason, timestamp: 0 };
}

function oneToolThenStop(call: ToolCall, count?: { value: number }): StreamFn {
	return (_model, context: LlmContext) => {
		count && (count.value += 1);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const hasResult = context.messages.some((message) => message.role === "toolResult");
			const message = hasResult ? assistant([{ type: "text", text: "done" }], "stop") : assistant([call], "toolUse");
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (!hasResult) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
			stream.push({ type: "done", reason: message.stopReason, message });
			stream.end(message);
		});
		return stream;
	};
}

function envelope(request: ToolExecutionGatewayRequest): WorkspaceExecutionEnvelope {
	return {
		authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL, sessionId: SESSION,
		workspaceId: WORKSPACE, repositoryId: REPOSITORY, worktreePath: ROOT, branch: "worktree/governed",
		baseCommit: "0123456789abcdef", agentId: AGENT, toolCallId: request.toolCallId,
		traceId: createRuntimeId("trace", `tool-${request.toolCallId}`), cwd: request.cwd,
		ownerRuntimeId: RUNTIME, leaseRevision: 1, fencingToken: "adapter-owned-fencing-token",
	};
}

class StrictWorkspace implements WorkspaceServicePort {
	public calls = 0;
	public async request(request: WorkspaceServiceRequest): Promise<WorkspaceServiceResult> {
		this.calls += 1;
		if (request.kind !== "validate" || request.envelope.cwd !== ROOT) {
			return { schemaVersion: 1, requestId: request.requestId, kind: "rejected", code: "path_escape", messageDigest: DIGEST, retryable: false };
		}
		return {
			schemaVersion: 1, requestId: request.requestId, kind: "validated",
			validation: {
				authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL,
				receiptId: createRuntimeId("receipt", `workspace-${request.envelope.toolCallId}`),
				workspaceId: WORKSPACE, envelopeDigest: request.envelopeDigest,
				validatorId: createRuntimeId("principal", "workspace-validator"), validatedAt: NOW, outcome: "valid",
			},
		};
	}
}

function approvalTicket(request: CapabilityGatewayRequest): ApprovalTicket {
	return {
		authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL,
		approvalId: request.request.approvalId,
		request: request.request, scope: "once", createdAt: NOW,
	};
}

function approvalReceipt(ticket: ApprovalTicket, decision: ApprovalReceiptRef["decision"]): ApprovalReceiptRef {
	const body = {
		authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL,
		receiptId: createRuntimeId("receipt", `approval-${decision}-${ticket.approvalId}`), approvalId: ticket.approvalId,
		requestId: ticket.request.requestId,
		requestDigest: approvalTicketRequestDigest(ticket),
		ticketDigest: approvalTicketDigest(ticket),
		decision, decisionRevision: 1, decidedBy: PRINCIPAL, decidedAt: NOW,
		evidenceComplete: true, evidenceTruncated: false,
		originalInputDigest: ticket.request.argumentsDigest,
	};
	return { ...body, receiptDigest: canonicalDigest(body) };
}

class StrictCapability implements CapabilityGatewayPort {
	public calls = 0;
	public mode: "allow" | "ask" | "deny" = "allow";
	public forgeDenyReceipt = false;
	public async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		this.calls += 1;
		const args = request.invocation.rawArguments as { path?: string };
		const mode = args.path?.includes("..") ? "deny" : this.mode;
		const ticket = approvalTicket(request);
		if (mode === "ask") {
			return { requestId: request.request.requestId, decision: "ask", decisionDigest: canonicalDigest({ request: request.request, decision: "ask" }), approvalTicket: ticket };
		}
		if (mode === "deny") {
			const receipt = approvalReceipt(ticket, "denied");
			return {
				requestId: request.request.requestId, decision: "deny", decisionDigest: canonicalDigest({ request: request.request, decision: "deny" }),
				approvalReceipt: this.forgeDenyReceipt ? { ...receipt, requestId: createRuntimeId("command", "forged") } : receipt,
			};
		}
		return {
			requestId: request.request.requestId, decision: "allow", decisionDigest: canonicalDigest({ request: request.request, decision: "allow" }),
			sandboxProfile: { authorityId: AUTHORITY, tenantId: TENANT, profileId: PROFILE, requested: "workspace-write", policyDigest: DIGEST },
		};
	}
	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return { ...request, status: "not_found" };
	}
}

class AllowApproval implements ApprovalCoordinatorPort {
	public readonly state = new MemoryApprovalStateStore();
	public receipt: ApprovalReceiptRef | undefined;
	public ticket: ApprovalTicket | undefined;
	public forgeReceiptDigest = false;

	public async request(request: ApprovalCoordinatorRequest): Promise<ApprovalCoordinatorResult> {
		const receipt = approvalReceipt(request.ticket, "allowed");
		this.ticket = request.ticket;
		const candidate = this.forgeReceiptDigest
			? { ...receipt, receiptDigest: "f".repeat(64) }
			: receipt;
		if (this.forgeReceiptDigest) {
			this.receipt = candidate;
		} else {
			const committed = await this.state.commit(candidate, 0);
			if (!committed.ok) throw new Error(committed.error.message);
			this.receipt = committed.value;
		}
		return {
			approvalId: request.ticket.approvalId,
			ticketDigest: approvalTicketDigest(request.ticket),
			receipt: this.receipt,
		};
	}
	public async read(approvalId: ApprovalReceiptRef["approvalId"]): Promise<ApprovalReceiptRef | undefined> {
		return this.state.read(approvalId);
	}
	public async cancel(request: SecurityPortCancelRequest): Promise<SecurityPortCancelResult> {
		return { ...request, status: "not_found" };
	}
}

class ResumingCapability extends StrictCapability {
	private readonly approval: AllowApproval;

	public constructor(approval: AllowApproval) {
		super();
		this.approval = approval;
	}

	public override async authorize(request: CapabilityGatewayRequest): Promise<CapabilityGatewayResult> {
		this.calls += 1;
		if (!this.approval.receipt) {
			return {
				requestId: request.request.requestId,
				decision: "ask",
				decisionDigest: canonicalDigest({ request: request.request, decision: "ask" }),
				approvalTicket: approvalTicket(request),
			};
		}
		return {
			requestId: request.request.requestId,
			decision: "allow",
			decisionDigest: canonicalDigest({ request: request.request, decision: "allow" }),
			approvalReceipt: this.approval.receipt,
			sandboxProfile: {
				authorityId: AUTHORITY,
				tenantId: TENANT,
				profileId: PROFILE,
				requested: "workspace-write",
				policyDigest: DIGEST,
			},
		};
	}
}

class StrictFactory implements ToolExecutionCapabilityRequestFactoryPort {
	private readonly capability: "workspace_write" | "process";

	public constructor(capability: "workspace_write" | "process" = "workspace_write") {
		this.capability = capability;
	}

	public async create(request: ToolExecutionGatewayRequest, value: WorkspaceExecutionEnvelope): Promise<CapabilityGatewayRequest> {
		const requestId = createRuntimeId("command", `capability-${request.toolCallId}`);
		const body = {
			schemaVersion: CAPABILITY_GATEWAY_SCHEMA_VERSION,
			request: {
				authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL, requestId,
				approvalId: createRuntimeId("approval", `capability-${request.toolCallId}`),
				sessionId: value.sessionId,
				runtimeId: value.ownerRuntimeId,
				runtimeGeneration: value.leaseRevision,
				turnId: request.turnId,
				toolCallId: request.toolCallId,
				capability: this.capability, argumentsDigest: canonicalDigest(request.arguments),
				workspaceEnvelopeDigest: workspaceExecutionEnvelopeDigest(value), policyDigest: DIGEST,
				serverScope: "tool_server" as const,
				resourceScopeDigest: canonicalDigest({ tool: request.tool.name, capability: this.capability }),
				commandScopeDigest: canonicalDigest({ requestId, arguments: request.arguments }),
			},
			invocation: {
				requestId, toolManifestDigest: DIGEST, rawArguments: request.arguments, envelope: value,
				requestedClaims: [{
					authorityId: AUTHORITY,
					tenantId: TENANT,
					name: this.capability,
					resourceKind: this.capability === "process" ? "process" as const : "filesystem" as const,
					resourceDigest: canonicalDigest(request.arguments),
					constraintsDigest: DIGEST,
				}],
			},
			idempotencyKey: requestId,
			inputSources: [],
			targetSink: "context" as const,
			declassificationReceipts: [],
		};
		return {
			...body,
			authentication: {
				channel: "local_process", channelBindingDigest: DIGEST,
				requestDigest: capabilityGatewayRequestDigest(body), nonce: "0123456789abcdef",
				issuedAt: NOW, expiresAt: "2026-07-22T00:05:00.000Z", keyRevision: 0,
				eventCursor: {
					stream: SESSION_STREAM,
					sequence: 1,
					eventId: createRuntimeId("event", "governed-e2e-head"),
					eventHash: DIGEST,
				},
			},
		};
	}
}

function resolution(fakeDigest = false): ToolSandboxResolutionReceiptRef {
	const body = {
		receiptId: createRuntimeId("receipt", "sandbox-resolution-governed"), profileId: PROFILE,
		requested: "workspace-write" as const, resolved: "workspace-write" as const, policyDigest: DIGEST,
		backendId: "strict-fake", effectiveEnforcement: "enforced" as const,
	};
	return { ...body, resolutionDigest: fakeDigest ? "f".repeat(64) : canonicalDigest(body) };
}

class StrictEnvironment implements RestrictedToolExecutionEnvironmentPort {
	public effects = 0;
	public unavailable = false;
	public fakeResolution = false;
	public uncertainSettlement = false;
	public async prepare(): Promise<{ status: "ready"; lease: RestrictedToolExecutionLease } | { status: "unavailable"; reason: string }> {
		if (this.unavailable) return { status: "unavailable", reason: "sandbox backend unavailable" };
		const self = this;
		return {
			status: "ready",
			lease: {
				resolution: resolution(this.fakeResolution),
				async open(grant: ToolExecutionAuthorizationGrant) {
					return {
						cwd: ROOT,
						governance: {
							kind: "governed", grantDigest: grant.grantDigest,
							workspaceEnvelopeDigest: grant.workspaceEnvelopeDigest,
							workspaceValidationReceiptId: grant.workspaceValidation.receiptId,
							authorizationReceiptId: grant.authorization.receiptId,
							sandboxResolutionReceiptId: grant.sandbox.receiptId,
						},
						fs: {
							async readFile() { throw new Error("not implemented"); },
							async writeFile(target: string) {
								const resolved = path.resolve(ROOT, target);
								if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error("path escape");
								self.effects += 1;
							},
							async stat() { return { size: 0, mtimeMs: 0, isFile: true, isDirectory: false }; },
							async readdir() { return []; }, async mkdir() {}, async rm() {},
						},
						shell: { async exec() { throw new Error("raw shell unavailable"); } },
					};
				},
				async settle() { return { outcomeCertain: !self.uncertainSettlement }; },
			},
		};
	}
}

function governedTool(rawCounter?: { value: number }): AgentTool<typeof writeParameters> {
	return {
		name: "write", label: "write", description: "context-bound fixture", parameters: writeParameters,
		governedExecution: "tool-context", isDestructive: () => true,
		async execute(_id, params, _signal, _update, context): Promise<AgentToolResult> {
			rawCounter && (rawCounter.value += 1);
			if (!context?.authorizationGrant) throw new Error("missing governed authorization");
			await context.env.fs.writeFile(params.path, params.content);
			return { content: [{ type: "text", text: "written" }], details: {} };
		},
	};
}

function gateway(options: {
	capability?: StrictCapability;
	environment?: StrictEnvironment;
	attempts?: MemoryToolExecutionAttemptStore;
	approval?: ApprovalCoordinatorPort;
	approvalState?: { read(approvalId: ApprovalReceiptRef["approvalId"]): Promise<ApprovalReceiptRef | undefined> };
	factory?: ToolExecutionCapabilityRequestFactoryPort;
} = {}) {
	const workspace = new StrictWorkspace();
	const capability = options.capability ?? new StrictCapability();
	const environment = options.environment ?? new StrictEnvironment();
	const attempts = options.attempts ?? new MemoryToolExecutionAttemptStore();
	const workspaceResolver: ToolExecutionWorkspaceResolverPort = { resolve: async (request) => envelope(request) };
	return {
		workspace, capability, environment, attempts,
		value: new PortBackedToolExecutionGateway({
			workspace, workspaceResolver, capability,
			capabilityRequestFactory: options.factory ?? new StrictFactory(),
			environment,
			attempts,
			...(options.approval ? { approval: options.approval } : {}),
			...(options.approvalState ? { approvalState: options.approvalState } : {}),
		}),
	};
}

function sessionSetup() {
	const fence: WriterFence = {
		authorityId: AUTHORITY, tenantId: TENANT, stream: SESSION_STREAM,
		leaseId: createRuntimeId("lease", "governed-e2e"), ownerRuntimeId: RUNTIME,
		writerEpoch: 1, fencingToken: "writer-fence",
	};
	const store = new MemoryEventStore({ authorityId: AUTHORITY, tenantId: TENANT, stream: SESSION_STREAM, validateFence: (candidate) => candidate.fencingToken === fence.fencingToken });
	const writer = new EventWriter({ authorityId: AUTHORITY, tenantId: TENANT, stream: SESSION_STREAM, store, fence });
	const sessionEvents = new AgentLoopSessionEvents({ writer, principalId: PRINCIPAL, runtimeId: RUNTIME, agentId: AGENT, featureDigest: DIGEST });
	return { store, sessionEvents };
}

async function events(store: MemoryEventStore): Promise<readonly RuntimeEventV3[]> {
	const page = await store.readPage(store.streamRef(), { limit: 1000 });
	if (!page.ok) throw new Error(page.error.message);
	return page.value.events;
}

describe("governed tool execution path", () => {
	it("validates Workspace, Capability and sandbox receipts before the context-bound side effect", async () => {
		const ports = gateway();
		const session = sessionSetup();
		const flush = vi.spyOn(session.store, "flushThrough");
		const claim = vi.spyOn(ports.attempts, "claim");
		const call: ToolCall = { type: "toolCall", id: "provider-write", name: "write", arguments: { path: "inside.txt", content: "ok" } };
		const agent = new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call),
			loopConfig: { cwd: ROOT, sessionEvents: session.sessionEvents, toolExecutionGateway: ports.value },
		});
		await agent.prompt("write");
		expect(ports.workspace.calls).toBe(1);
		expect(ports.capability.calls).toBe(1);
		expect(ports.environment.effects).toBe(1);
		const durable = await events(session.store);
		expect(durable.map((event) => event.type)).toContain("sandbox.resolved");
		expect(durable.map((event) => event.type)).toContain("tool.authorized");
		expect(durable.map((event) => event.type)).toContain("tool.started");
		expect(durable.map((event) => event.type)).toContain("tool.finished");
		const authorized = durable.find((event) => event.type === "tool.authorized");
		const started = durable.find((event) => event.type === "tool.started");
		expect(authorized?.payload.decisionReceiptId).not.toBe(started?.payload.workspaceReceiptId);
		const startedFlush = flush.mock.calls.findIndex(([, cursor]) => cursor.sequence === started?.sequence);
		expect(startedFlush).toBeGreaterThanOrEqual(0);
		expect(claim).toHaveBeenCalledOnce();
		expect(flush.mock.invocationCallOrder[startedFlush]).toBeLessThan(claim.mock.invocationCallOrder[0] ?? 0);
	});

	it("does not claim an execution attempt when the durable tool.started flush fails", async () => {
		const ports = gateway();
		const session = sessionSetup();
		vi.spyOn(session.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: {
				code: "durable_write_failed",
				message: "injected tool start flush failure",
				retryable: false,
				effect: "uncertain",
			},
		});
		const claim = vi.spyOn(ports.attempts, "claim");
		const execute = vi.spyOn(ports.value, "execute");
		const call: ToolCall = {
			type: "toolCall",
			id: "provider-start-flush-failure",
			name: "write",
			arguments: { path: "inside.txt", content: "must-not-run" },
		};

		await expect(new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call),
			loopConfig: {
				cwd: ROOT,
				sessionEvents: session.sessionEvents,
				toolExecutionGateway: ports.value,
			},
		}).prompt("fail durable start flush")).rejects.toThrow("durable event barrier failed");

		expect(claim).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(ports.environment.effects).toBe(0);
	});

	it("closes the model gate when attempt claim fails after durable tool start", async () => {
		const ports = gateway();
		const session = sessionSetup();
		const modelCalls = { value: 0 };
		const claim = vi.spyOn(ports.attempts, "claim").mockRejectedValueOnce(new Error("injected claim failure"));
		const call: ToolCall = {
			type: "toolCall",
			id: "provider-claim-after-start-failure",
			name: "write",
			arguments: { path: "inside.txt", content: "must-not-run" },
		};

		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call, modelCalls),
			loopConfig: {
				cwd: ROOT,
				sessionEvents: session.sessionEvents,
				toolExecutionGateway: ports.value,
			},
		}).prompt("fail claim after durable start");

		const durable = await events(session.store);
		expect(claim).toHaveBeenCalledOnce();
		expect(durable.some((event) => event.type === "tool.started")).toBe(true);
		expect(durable.find((event) => event.type === "tool.failed")?.payload.outcomeCertain).toBe(false);
		expect(modelCalls.value).toBe(1);
		expect(ports.environment.effects).toBe(0);
	});

	it("binds the durable tool request and Gateway grant to validated PreToolUse updatedInput", async () => {
		const ports = gateway();
		const session = sessionSetup();
		const call: ToolCall = {
			type: "toolCall",
			id: "provider-rewritten-write",
			name: "write",
			arguments: { path: "original.txt", content: "original" },
		};
		const agent = new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call),
			loopConfig: {
				cwd: ROOT,
				sessionEvents: session.sessionEvents,
				toolExecutionGateway: ports.value,
				beforeToolCall: () => ({ updatedInput: { path: "rewritten.txt", content: "rewritten" } }),
			},
		});
		await agent.prompt("rewrite then write");
		expect(ports.environment.effects).toBe(1);
		const durable = await events(session.store);
		const requested = durable.find((event) => event.type === "tool.requested");
		const terminal = durable.find((event) => event.type === "tool.finished");
		expect(requested?.payload.argumentsDigest).toBe(canonicalDigest(JSON.stringify({
			path: "rewritten.txt",
			content: "rewritten",
		})));
		expect(terminal).toBeDefined();
	});

	it("denies path escape, sandbox unavailable and forged resolution before invoking the tool", async () => {
		for (const mode of ["escape", "unavailable", "forged"] as const) {
			const environment = new StrictEnvironment();
			if (mode === "unavailable") environment.unavailable = true;
			if (mode === "forged") environment.fakeResolution = true;
			const ports = gateway({ environment });
			const request: ToolExecutionGatewayRequest = {
				turnId: createRuntimeId("turn", mode),
				toolCallId: createRuntimeId("toolCall", mode), providerToolCallId: `provider-${mode}`,
				tool: governedTool(), arguments: { path: mode === "escape" ? "../outside.txt" : "inside.txt", content: "x" }, cwd: ROOT, envVars: {},
			};
			const result = await ports.value.authorize(request);
			expect(result.status).not.toBe("authorized");
			expect(environment.effects).toBe(0);
		}
	});

	it("keeps the adapter-owned fencing token out of the public authorization grant", async () => {
		const ports = gateway();
		const result = await ports.value.authorize({
			turnId: createRuntimeId("turn", "no-fencing-leak"),
			toolCallId: createRuntimeId("toolCall", "no-fencing-leak"),
			providerToolCallId: "provider-no-fencing-leak",
			tool: governedTool(),
			arguments: { path: "inside.txt", content: "x" },
			cwd: ROOT,
			envVars: {},
		});
		if (result.status !== "authorized") throw new Error(result.reason);
		const serialized = JSON.stringify(result.grant);
		expect(serialized).not.toContain("adapter-owned-fencing-token");
		expect(serialized).not.toContain("fencingToken");
	});

	it("rejects a fake denial receipt and never converts it into a grant", async () => {
		const capability = new StrictCapability();
		capability.mode = "deny";
		capability.forgeDenyReceipt = true;
		const ports = gateway({ capability });
		const result = await ports.value.authorize({
			turnId: createRuntimeId("turn", "fake-denial"),
			toolCallId: createRuntimeId("toolCall", "fake-denial"), providerToolCallId: "provider-fake-denial",
			tool: governedTool(), arguments: { path: "inside.txt", content: "x" }, cwd: ROOT, envVars: {},
		});
		expect(result).toMatchObject({ status: "denied", reason: "capability denial receipt is invalid or uncorrelated" });
		expect(ports.environment.effects).toBe(0);
	});

	it("resumes an approved request only with the coordinator's exact receipt", async () => {
		const approval = new AllowApproval();
		const capability = new ResumingCapability(approval);
		const ports = gateway({ approval, approvalState: approval.state, capability });
		const result = await ports.value.authorize({
			turnId: createRuntimeId("turn", "approval-resume"),
			toolCallId: createRuntimeId("toolCall", "approval-resume"),
			providerToolCallId: "provider-approval-resume",
			tool: governedTool(),
			arguments: { path: "inside.txt", content: "x" },
			cwd: ROOT,
			envVars: {},
		});
		expect(result.status).toBe("authorized");
		expect(capability.calls).toBe(2);
		expect(approval.receipt?.decision).toBe("allowed");
	});

	it("rejects an approval resume with a forged receipt self-digest", async () => {
		const approval = new AllowApproval();
		approval.forgeReceiptDigest = true;
		const capability = new ResumingCapability(approval);
		const ports = gateway({ approval, approvalState: approval.state, capability });
		const result = await ports.value.authorize({
			turnId: createRuntimeId("turn", "approval-forged-digest"),
			toolCallId: createRuntimeId("toolCall", "approval-forged-digest"),
			providerToolCallId: "provider-approval-forged-digest",
			tool: governedTool(),
			arguments: { path: "inside.txt", content: "x" },
			cwd: ROOT,
			envVars: {},
		});
		expect(result).toMatchObject({
			status: "denied",
			reason: "approval receipt is invalid or uncorrelated",
		});
		expect(capability.calls).toBe(1);
		expect(ports.environment.effects).toBe(0);
	});

	it("does not publish a stale tool start when durable approval is revoked after authorize", async () => {
		const approval = new AllowApproval();
		const capability = new ResumingCapability(approval);
		const ports = gateway({ approval, approvalState: approval.state, capability });
		const session = sessionSetup();
		const execute = vi.spyOn(ports.value, "execute");
		let authorizedGrant: ToolExecutionAuthorizationGrant | undefined;
		const revokingGateway: ToolExecutionGatewayPort = {
			authorize: async (request, signal) => {
				const result = await ports.value.authorize(request, signal);
				if (result.status !== "authorized") return result;
				const ticket = approval.ticket;
				const allowed = approval.receipt;
				if (!ticket || !allowed) throw new Error("approval fixture did not persist an allowed receipt");
				authorizedGrant = result.grant;
				await session.sessionEvents.recordApprovalRequested(ticket, {
					attemptId: createRuntimeId("command", "revoke-after-authorize-attempt"),
					resourceKind: "filesystem",
					summary: {
						operation: "write",
						toolIdentityDigest: canonicalDigest("write"),
						targetDigest: canonicalDigest("inside.txt"),
						environmentKeyDigests: [],
					},
				});
				await session.sessionEvents.recordApprovalTerminal(ticket, allowed);
				const revoked = createApprovalSupersessionReceipt(
					allowed,
					"revoked",
					"2026-07-22T00:00:01.000Z",
					PRINCIPAL,
				);
				const committed = await approval.state.commit(revoked, allowed.decisionRevision);
				if (!committed.ok) throw new Error(committed.error.message);
				approval.receipt = committed.value;
				await session.sessionEvents.recordApprovalTerminal(ticket, committed.value);
				return result;
			},
			start: (request, durableStart, signal) => ports.value.start(request, durableStart, signal),
			execute: (request, onUpdate, signal) => ports.value.execute(request, onUpdate, signal),
		};
		const call: ToolCall = {
			type: "toolCall",
			id: "provider-revoked-after-authorize",
			name: "write",
			arguments: { path: "inside.txt", content: "must-not-run" },
		};

		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call),
			loopConfig: {
				cwd: ROOT,
				sessionEvents: session.sessionEvents,
				toolExecutionGateway: revokingGateway,
			},
		}).prompt("revoke after authorize");

		const durable = await events(session.store);
		const revoked = durable.find((event) => event.type === "permission.revoked");
		const currentApproval = approval.ticket
			? await approval.state.read(approval.ticket.approvalId)
			: undefined;
		expect(currentApproval).toMatchObject({ decision: "revoked", decisionRevision: 2 });
		expect(revoked?.payload).toMatchObject({
			decisionRevision: 2,
			receiptId: currentApproval?.receiptId,
			receiptDigest: currentApproval?.receiptDigest,
		});
		expect(durable.some((event) => event.type === "sandbox.resolved")).toBe(false);
		expect(durable.some((event) => event.type === "tool.authorized")).toBe(false);
		expect(durable.some((event) => event.type === "tool.started")).toBe(false);
		const projection = reduceSessionEvents(durable);
		if (!projection.ok) throw new Error(projection.error.message);
		expect(projection.value.toolCalls).toMatchObject([{ status: "failed", uncertain: false }]);
		expect(ports.environment.effects).toBe(0);
		expect(execute).not.toHaveBeenCalled();
		if (!authorizedGrant) throw new Error("authorization grant was not captured");
		expect(await ports.attempts.read(authorizedGrant.grantDigest)).toBeUndefined();
	});

	it("rejects a fake authorized grant before durable authorization events", async () => {
		const backing = gateway();
		const session = sessionSetup();
		let executeCalls = 0;
		const fake: ToolExecutionGatewayPort = {
			authorize: async (request, signal) => {
				const result = await backing.value.authorize(request, signal);
				if (result.status !== "authorized") return result;
				return {
					status: "authorized",
					grant: { ...result.grant, argumentsDigest: "f".repeat(64) },
				};
			},
			start: (request, durableStart, signal) => backing.value.start(request, durableStart, signal),
			execute: async (request) => {
				executeCalls += 1;
				return {
					status: "aborted",
					grantDigest: request.grant.grantDigest,
					reason: "must not execute",
					outcomeCertain: true,
				};
			},
		};
		const call: ToolCall = {
			type: "toolCall", id: "provider-fake-grant", name: "write",
			arguments: { path: "inside.txt", content: "x" },
		};
		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call),
			loopConfig: { cwd: ROOT, sessionEvents: session.sessionEvents, toolExecutionGateway: fake },
		}).prompt("fake grant");
		const durable = await events(session.store);
		expect(executeCalls).toBe(0);
		expect(durable.some((event) => event.type === "sandbox.resolved")).toBe(false);
		expect(durable.some((event) => event.type === "tool.authorized")).toBe(false);
		expect(durable.some((event) => event.type === "tool.started")).toBe(false);
		expect(durable.find((event) => event.type === "tool.failed")?.payload.outcomeCertain).toBe(true);
	});

	it("treats process completion without a sandbox execution receipt as uncertain", async () => {
		const ports = gateway({ factory: new StrictFactory("process") });
		const invocation: ToolExecutionGatewayRequest = {
			turnId: createRuntimeId("turn", "process-no-receipt"),
			toolCallId: createRuntimeId("toolCall", "process-no-receipt"),
			providerToolCallId: "provider-process-no-receipt",
			tool: governedTool(),
			arguments: { path: "inside.txt", content: "x" },
			cwd: ROOT,
			envVars: {},
		};
		const authorization = await ports.value.authorize(invocation);
		if (authorization.status !== "authorized") throw new Error(authorization.reason);
		expect(await ports.value.start(
			{ invocation, grant: authorization.grant },
			async () => undefined,
		)).toMatchObject({ status: "ready", grantDigest: authorization.grant.grantDigest });
		const result = await ports.value.execute({ invocation, grant: authorization.grant }, () => undefined);
		expect(result).toMatchObject({
			status: "uncertain",
			reason: "process execution lacks a sandbox receipt",
			outcomeCertain: false,
		});
		expect(ports.environment.effects).toBe(1);
	});

	it("does not bypass the gateway and closes the next-model gate on uncertain side effects", async () => {
		const directCounter = { value: 0 };
		const noGateway = sessionSetup();
		const call: ToolCall = { type: "toolCall", id: "provider-direct", name: "write", arguments: { path: "inside.txt", content: "x" } };
		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool(directCounter)] },
			streamFn: oneToolThenStop(call), loopConfig: { cwd: ROOT, sessionEvents: noGateway.sessionEvents },
		}).prompt("no gateway");
		expect(directCounter.value).toBe(0);
		expect((await events(noGateway.store)).find((event) => event.type === "tool.failed")?.payload.outcomeCertain).toBe(true);

		const environment = new StrictEnvironment();
		environment.uncertainSettlement = true;
		const ports = gateway({ environment });
		const uncertain = sessionSetup();
		const modelCalls = { value: 0 };
		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call, modelCalls),
			loopConfig: { cwd: ROOT, sessionEvents: uncertain.sessionEvents, toolExecutionGateway: ports.value },
		}).prompt("uncertain");
		expect(environment.effects).toBe(1);
		expect(modelCalls.value).toBe(1);
		expect((await events(uncertain.store)).find((event) => event.type === "tool.failed")?.payload.outcomeCertain).toBe(false);
	});

	it("closes the next-model gate after a certain abort", async () => {
		const backing = gateway();
		const session = sessionSetup();
		const modelCalls = { value: 0 };
		const aborting: ToolExecutionGatewayPort = {
			authorize: (request, signal) => backing.value.authorize(request, signal),
			start: (request, durableStart, signal) => backing.value.start(request, durableStart, signal),
			execute: async (request) => ({
				status: "aborted",
				grantDigest: request.grant.grantDigest,
				reason: "operator cancelled",
				outcomeCertain: true,
			}),
		};
		const call: ToolCall = {
			type: "toolCall", id: "provider-aborted-certain", name: "write",
			arguments: { path: "inside.txt", content: "x" },
		};
		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call, modelCalls),
			loopConfig: { cwd: ROOT, sessionEvents: session.sessionEvents, toolExecutionGateway: aborting },
		}).prompt("abort");
		const durable = await events(session.store);
		expect(modelCalls.value).toBe(1);
		expect(durable.find((event) => event.type === "tool.interrupted")?.payload.outcomeCertain).toBe(true);
		expect(durable.some((event) => event.type === "turn.interrupted")).toBe(true);
	});

	it("reuses a durable terminal attempt after gateway reconstruction instead of repeating the side effect", async () => {
		const attempts = new MemoryToolExecutionAttemptStore();
		const environment = new StrictEnvironment();
		const first = gateway({ attempts, environment });
		const invocation: ToolExecutionGatewayRequest = {
			turnId: createRuntimeId("turn", "restart"),
			toolCallId: createRuntimeId("toolCall", "restart"), providerToolCallId: "provider-restart",
			tool: governedTool(), arguments: { path: "inside.txt", content: "once" }, cwd: ROOT, envVars: {},
		};
		const authorization = await first.value.authorize(invocation);
		if (authorization.status !== "authorized") throw new Error(authorization.reason);
		expect(await first.value.start(
			{ invocation, grant: authorization.grant },
			async () => undefined,
		)).toMatchObject({ status: "ready", grantDigest: authorization.grant.grantDigest });
		const firstResult = await first.value.execute({ invocation, grant: authorization.grant }, () => undefined);
		expect(firstResult.status).toBe("completed");
		expect(environment.effects).toBe(1);

		const restarted = gateway({ attempts, environment });
		const replay = await restarted.value.execute({ invocation, grant: authorization.grant }, () => undefined);
		expect(replay).toEqual(firstResult);
		expect(environment.effects).toBe(1);
	});

	it.each([
		"read failure",
		"missing record",
		"mismatched invocation",
		"mismatched terminal identity",
	] as const)("keeps a consumed durable start claim uncertain after %s", async (mode) => {
		const ports = gateway();
		const caseId = canonicalDigest(mode).slice(0, 16);
		const invocation: ToolExecutionGatewayRequest = {
			turnId: createRuntimeId("turn", `claimed-${caseId}`),
			toolCallId: createRuntimeId("toolCall", `claimed-${caseId}`),
			providerToolCallId: `provider-claimed-${caseId}`,
			tool: governedTool(),
			arguments: { path: "inside.txt", content: "must-not-run" },
			cwd: ROOT,
			envVars: {},
		};
		const authorization = await ports.value.authorize(invocation);
		if (authorization.status !== "authorized") throw new Error(authorization.reason);
		expect(await ports.value.start(
			{ invocation, grant: authorization.grant },
			async () => undefined,
		)).toEqual({ status: "ready", grantDigest: authorization.grant.grantDigest });

		const foreignInvocationDigest = `${authorization.grant.invocationDigest[0] === "0" ? "1" : "0"}${authorization.grant.invocationDigest.slice(1)}`;
		const foreignGrantDigest = `${authorization.grant.grantDigest[0] === "0" ? "1" : "0"}${authorization.grant.grantDigest.slice(1)}`;
		const read = vi.spyOn(ports.attempts, "read");
		if (mode === "read failure") read.mockRejectedValueOnce(new Error("injected attempt read failure"));
		if (mode === "missing record") read.mockResolvedValueOnce(undefined);
		if (mode === "mismatched invocation") {
			read.mockResolvedValueOnce({ status: "started", invocationDigest: foreignInvocationDigest });
		}
		if (mode === "mismatched terminal identity") {
			read.mockResolvedValueOnce({
				status: "completed",
				invocationDigest: authorization.grant.invocationDigest,
				result: {
					status: "unavailable",
					grantDigest: foreignGrantDigest,
					reason: "foreign terminal result",
					outcomeCertain: true,
				},
			});
		}

		const result = await ports.value.execute({ invocation, grant: authorization.grant }, () => undefined);
		expect(result).toMatchObject({
			status: "uncertain",
			grantDigest: authorization.grant.grantDigest,
			outcomeCertain: false,
		});
		expect(ports.environment.effects).toBe(0);
		expect(await ports.value.execute({ invocation, grant: authorization.grant }, () => undefined)).toMatchObject({
			status: "uncertain",
			grantDigest: authorization.grant.grantDigest,
			outcomeCertain: false,
		});
		expect(ports.environment.effects).toBe(0);
	});

	it.each([
		["approval_required", "tool.failed"],
		["denied", "tool.failed"],
		["aborted", "tool.interrupted"],
	] as const)("records %s authorization as an explicit tool terminal", async (status, terminalType) => {
		const session = sessionSetup();
		const ticketRequestId = createRuntimeId("command", `terminal-${status}`);
		const fake: ToolExecutionGatewayPort = {
			authorize: async (invocation) => {
				const ticket: ApprovalTicket = {
					authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL,
					approvalId: createRuntimeId("approval", `terminal-${status}`),
					request: {
						authorityId: AUTHORITY, tenantId: TENANT, principalId: PRINCIPAL,
						requestId: ticketRequestId,
						approvalId: createRuntimeId("approval", `terminal-${status}`),
						sessionId: SESSION,
						runtimeId: RUNTIME,
						runtimeGeneration: 1,
						turnId: invocation.turnId,
						toolCallId: invocation.toolCallId,
						capability: "workspace_write",
						argumentsDigest: canonicalDigest(invocation.arguments),
						workspaceEnvelopeDigest: DIGEST,
						policyDigest: DIGEST,
						serverScope: "tool_server",
						resourceScopeDigest: DIGEST,
						commandScopeDigest: DIGEST,
					},
					scope: "once", createdAt: NOW,
				};
				return status === "approval_required"
					? { status, requestId: ticketRequestId, ticket, reason: "approval required" }
					: { status, requestId: ticketRequestId, reason: status };
			},
			start: async (request, durableStart) => {
				await durableStart();
				return { status: "ready", grantDigest: request.grant.grantDigest };
			},
			execute: async () => { throw new Error("must not execute"); },
		};
		const call: ToolCall = { type: "toolCall", id: `provider-${status}`, name: "write", arguments: { path: "inside.txt", content: "x" } };
		await new Agent({
			initialState: { systemPrompt: "test", model: MODEL, tools: [governedTool()] },
			streamFn: oneToolThenStop(call), loopConfig: { cwd: ROOT, sessionEvents: session.sessionEvents, toolExecutionGateway: fake },
		}).prompt(status);
		expect((await events(session.store)).some((event) => event.type === terminalType)).toBe(true);
	});
});
