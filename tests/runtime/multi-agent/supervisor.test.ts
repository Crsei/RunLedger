import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { Api, AssistantMessage, Model } from "../../../src/types.ts";
import type { StreamFn, ToolAuthorizationPolicy } from "../../../src/runtime/types.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type AgentId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { AgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import { createInProcessChildRuntimeProvider, type ActiveChildHandle, type ChildRuntimeProviderPort } from "../../../src/runtime/agents/child-runtime.ts";
import type { ChildModelRuntimeFactoryPort } from "../../../src/runtime/agents/child-model-runtime.ts";
import type { MultiAgentResult, SubagentInvocationContext, ValidatedSpawnSubagentInput } from "../../../src/runtime/agents/types.ts";
import { AgentSupervisor, deriveChildIdentity, type AgentSupervisorOptions } from "../../../src/runtime/agents/supervisor.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const MODEL: Model<Api> = {
	id: "supervisor-fixture-model",
	name: "Supervisor Fixture Model",
	api: "mock",
	provider: "supervisor-fixture-provider",
	baseUrl: "http://supervisor-fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 1_024,
};

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ROOT_AGENT_ID = createRuntimeId("agent", "supervisor-root");

let directory: string;
let database: ReturnType<typeof openSessionDatabase>;
let sessionStore: SessionStore;
let sessionId: SessionId;
let fence: OwnerFence;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "runledger-supervisor-"));
	database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	sessionStore = new SessionStore(database);
	sessionId = createRuntimeId("session", "supervisor-session");
	const runtimeId = createRuntimeId("runtime", "supervisor-runtime");
	sessionStore.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "supervisor-workspace"),
		repositoryId: createRuntimeId("repository", "supervisor-repository"),
		settingsDigest: "s".repeat(64),
	});
	database.runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	fence = { sessionId, runtimeId, generation: 1 };
});

afterEach(() => {
	database.close();
	rmSync(directory, { recursive: true, force: true });
});

function executionEnv(): ExecutionEnv {
	return {
		cwd: "/workspace",
		fs: {
			readFile: async () => Buffer.from(""),
			writeFile: async () => undefined,
			stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
			readdir: async () => [],
			mkdir: async () => undefined,
			rm: async () => undefined,
			rename: async () => undefined,
		},
		shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
	};
}

function allowingPolicy(): ToolAuthorizationPolicy {
	return { authorize: () => ({ decision: "allow" }) };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function stopStream(calls: { count: number }, text = "bounded child report"): StreamFn {
	return (_model, _context) => {
		calls.count += 1;
		const stream = createAssistantMessageEventStream();
		const message = assistant(text);
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

function gatedStopStream(gate: { started: boolean; release: Promise<void> }, calls: { count: number }): StreamFn {
	return (_model, _context) => {
		calls.count += 1;
		gate.started = true;
		const stream = createAssistantMessageEventStream();
		const message = assistant("gated child report");
		void gate.release.then(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "gated child report" });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

function modelRuntimeFactory(streamFn: StreamFn): ChildModelRuntimeFactoryPort {
	return {
		prepare: async ({ tools }) => ({
			ok: true,
			value: {
				model: MODEL,
				tools: Object.freeze([...tools]),
				descriptor: {
					providerId: MODEL.provider,
					modelId: MODEL.id,
					profileId: `${MODEL.provider}/${MODEL.id}`,
					api: MODEL.api,
					thinkingLevel: "off",
					systemPromptDigest: runtimeDigest("supervisor-system"),
					toolManifestDigest: runtimeDigest(tools.map((tool) => tool.name)),
				},
				streamFn,
			},
		}),
	};
}

function childTemplate(streamFn: StreamFn): AgentSupervisorOptions["childRuntime"] {
	return {
		systemPrompt: "supervisor child system",
		tools: [],
		modelRuntimeFactory: modelRuntimeFactory(streamFn),
		cwd: "/workspace",
		executionEnv: executionEnv(),
		authorizationPolicy: allowingPolicy(),
	};
}

function request(overrides: Partial<ValidatedSpawnSubagentInput> = {}): ValidatedSpawnSubagentInput {
	return {
		role: "research",
		objective: "Inspect the governed repository and return a bounded report.",
		requestedCapabilities: ["workspace.read"],
		budget: { maxModelTurns: 3, maxToolCalls: 3, maxActiveDurationMs: 10_000 },
		output: { kind: "report", maxBytes: 1024 },
		...overrides,
	};
}

function invocation(effectId: string, parentAgentId: AgentId = ROOT_AGENT_ID): SubagentInvocationContext {
	return {
		sessionId,
		ownerGeneration: fence.generation,
		rootAgentId: ROOT_AGENT_ID,
		parentAgentId,
		source: "model_tool",
		effectId,
		signal: new AbortController().signal,
	};
}

function supervisor(
	streamFn: StreamFn = stopStream({ count: 0 }),
	options: Partial<AgentSupervisorOptions> = {},
): AgentSupervisor {
	const graph = options.graph ?? new AgentGraphStore({
		store: sessionStore,
		fence,
		rootAgentId: ROOT_AGENT_ID,
		...(options.limits === undefined ? {} : { limits: options.limits }),
	});
	return new AgentSupervisor({
		graph,
		rootAgentId: ROOT_AGENT_ID,
		policyReceiptDigest: runtimeDigest("supervisor-policy"),
		provider: createInProcessChildRuntimeProvider(),
		childRuntime: childTemplate(streamFn),
		...options,
	});
}

function eventTypes(): string[] {
	return sessionStore.replaySessionEvents(sessionId).map((event) => event.eventType);
}

async function waitForEvent(eventType: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (eventTypes().includes(eventType)) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`timed out waiting for ${eventType}`);
}

describe("bounded child supervisor", () => {
	it("commits each graph event around the real child lifecycle in order", async () => {
		const calls = { count: 0 };
		const ordering: string[] = [];
		const graph = new AgentGraphStore({
			store: sessionStore,
			fence,
			rootAgentId: ROOT_AGENT_ID,
			appendEvent: (input) => {
				ordering.push(input.eventType);
				return sessionStore.appendEvent(fence, input);
			},
		});
		const childSupervisor = supervisor((_model, context) => {
			ordering.push(context.messages.length === 1 ? "model" : "model-repeat");
			return stopStream(calls)(_model, context);
		}, { graph });
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const result = await childSupervisor.spawn(request(), invocation("tool-call-1"));
		expect(result).toMatchObject({ ok: true, value: { outcome: "completed", report: "bounded child report" } });
		expect(ordering).toEqual(["agent.root_registered", "agent.spawn_requested", "agent.spawned", "agent.activated", "model", "agent.finished"]);
		expect(calls.count).toBe(1);
		expect(eventTypes()).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.activated",
			"agent.finished",
		]);
	});

	it("replays a terminal duplicate byte-for-byte without starting a second child", async () => {
		const calls = { count: 0 };
		const childSupervisor = supervisor(stopStream(calls));
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const first = await childSupervisor.spawn(request(), invocation("duplicate-tool-call"));
		const second = await childSupervisor.spawn(request(), invocation("duplicate-tool-call"));
		expect(first).toEqual(second);
		expect(calls.count).toBe(1);
		expect(eventTypes().filter((eventType) => eventType === "agent.spawn_requested")).toHaveLength(1);
	});

	it("rejects a same-effect replay whose request digest changed after owner recreation", async () => {
		const calls = { count: 0 };
		const graph = new AgentGraphStore({ store: sessionStore, fence, rootAgentId: ROOT_AGENT_ID });
		const firstSupervisor = supervisor(stopStream(calls), { graph });
		expect(await firstSupervisor.registerRoot()).toMatchObject({ ok: true });
		const first = await firstSupervisor.spawn(request(), invocation("request-conflict"));
		const secondSupervisor = supervisor(stopStream(calls), { graph });
		const second = await secondSupervisor.spawn({ ...request(), objective: "a different objective" }, invocation("request-conflict"));
		expect(first).toMatchObject({ ok: true, value: { outcome: "completed" } });
		expect(second).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(calls.count).toBe(1);
	});

	it("derives command, child, and attempt identities independently of consumer source and owner generation", () => {
		const firstInvocation = invocation("shared-identity");
		const replayInvocation: SubagentInvocationContext = {
			...firstInvocation,
			ownerGeneration: firstInvocation.ownerGeneration + 1,
			source: "domain_command",
		};
		const first = deriveChildIdentity(request(), firstInvocation);
		const replay = deriveChildIdentity(request(), replayInvocation);
		const conflictingRequest = deriveChildIdentity(
			request({ objective: "Inspect a different bounded request." }),
			replayInvocation,
		);

		expect(replay.commandId).toBe(first.commandId);
		expect(replay.agentId).toBe(first.agentId);
		expect(replay.attemptId).toBe(first.attemptId);
		expect(replay.requestDigest).toEqual(first.requestDigest);
		expect(conflictingRequest.commandId).toBe(first.commandId);
		expect(conflictingRequest.agentId).toBe(first.agentId);
		expect(conflictingRequest.attemptId).toBe(first.attemptId);
		expect(conflictingRequest.requestDigest).not.toEqual(first.requestDigest);
	});

	it("rejects a child delegation and preserves the root-owned boundary", async () => {
		const childSupervisor = supervisor();
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const result = await childSupervisor.spawn(request(), invocation("nested-delegation", createRuntimeId("agent", "child-parent")));
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(eventTypes()).toEqual(["agent.root_registered"]);
	});

	it("holds one active-child slot until the first child reaches a durable terminal state", async () => {
		let release!: () => void;
		const gate = {
			started: false,
			release: new Promise<void>((resolve) => { release = resolve; }),
		};
		const calls = { count: 0 };
		const childSupervisor = supervisor(gatedStopStream(gate, calls));
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const firstPromise = childSupervisor.spawn(request(), invocation("active-one"));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(gate.started).toBe(true);
		const second = await childSupervisor.spawn(request(), invocation("active-two"));
		expect(second).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
		release();
		expect(await firstPromise).toMatchObject({ ok: true, value: { outcome: "completed" } });
		expect(calls.count).toBe(1);
	});

	it("does not publish running after an uncertain activation and opens recovery", async () => {
		const childSupervisor = supervisor(stopStream({ count: 0 }), {
			provider: createInProcessChildRuntimeProvider({
				start: () => {
					throw new Error("activation acknowledgement lost");
				},
			}),
		});
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const result = await childSupervisor.spawn(request(), invocation("activation-uncertain"));
		expect(result).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(eventTypes()).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.reconciliation_required",
		]);
		const inspected = await childSupervisor.inspect();
		expect(inspected).toMatchObject({ ok: true, value: { nodes: [{ role: "root" }, { state: "recovery_required", reasonCode: "activation_uncertain" }] } });
	});

	it("stops and disposes a live child when durable activation publication fails", async () => {
		let cancelCalls = 0;
		let disposeCalls = 0;
		let releaseCompletion!: () => void;
		const completionGate = new Promise<void>((resolve) => { releaseCompletion = resolve; });
		const graph = new AgentGraphStore({
			store: sessionStore,
			fence,
			rootAgentId: ROOT_AGENT_ID,
			appendEvent: (input) => {
				if (input.eventType === "agent.activated") throw new Error("activation event append failed");
				return sessionStore.appendEvent(fence, input);
			},
		});
		const provider: ChildRuntimeProviderPort = {
			providerId: "in_process",
			prepare: async (spec) => {
				const descriptorDigest = runtimeDigest({ agentId: spec.agentId, stage: "activation-publication" });
				return {
					ok: true,
					value: {
						descriptor: {
							agentId: spec.agentId,
							model: {
								providerId: "fixture",
								modelId: "fixture",
								profileId: "fixture/fixture",
								api: "mock",
								thinkingLevel: "off",
								systemPromptDigest: descriptorDigest,
								toolManifestDigest: descriptorDigest,
							},
							descriptorDigest,
						},
						activate: async () => ({
							ok: true,
							value: {
								activationReceipt: {
									receiptId: createRuntimeId("receipt", "activation-publication"),
									agentId: spec.agentId,
									activatedAtMs: 1,
									receiptDigest: descriptorDigest,
								},
								completion: completionGate.then(() => ({ ok: true as const, value: { report: {
									agentId: spec.agentId,
									outcome: "completed" as const,
									report: "must not escape",
									reportDigest: runtimeDigest("must not escape"),
									reportBytes: 15,
									usage: { modelTurns: 1, toolCalls: 0, activeDurationMs: 1 },
								}, messages: [] } })),
							},
						}),
						cancel: async () => { cancelCalls += 1; return { ok: true, value: undefined }; },
						dispose: async () => { disposeCalls += 1; return { ok: true, value: undefined }; },
					},
				};
			},
		};
		const childSupervisor = supervisor(stopStream({ count: 0 }), { graph, provider });
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });

		const result = await childSupervisor.spawn(request(), invocation("activation-publication-failure"));

		expect(result).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(cancelCalls).toBe(1);
		expect(disposeCalls).toBe(1);
		expect(eventTypes()).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.reconciliation_required",
		]);
		releaseCompletion();
		await Promise.resolve();
		expect(eventTypes().some((eventType) => eventType === "agent.finished")).toBe(false);
	});

	it("does not replay a durable requested child after owner recreation", async () => {
		let prepareCalls = 0;
		let releasePrepare!: (result: Awaited<ReturnType<ChildRuntimeProviderPort["prepare"]>>) => void;
		const provider: ChildRuntimeProviderPort = {
			providerId: "in_process",
			prepare: () => {
				prepareCalls += 1;
				return new Promise((resolve) => {
					releasePrepare = resolve;
				});
			},
		};
		const firstSupervisor = supervisor(stopStream({ count: 0 }), { provider });
		expect(await firstSupervisor.registerRoot()).toMatchObject({ ok: true });
		const firstPromise = firstSupervisor.spawn(request(), invocation("requested-owner-recreation"));
		await waitForEvent("agent.spawn_requested");

		const recreatedSupervisor = supervisor(stopStream({ count: 0 }), { provider });
		const duplicate = await recreatedSupervisor.spawn(request(), invocation("requested-owner-recreation"));
		expect(duplicate).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(prepareCalls).toBe(1);

		releasePrepare({ ok: false, error: { code: "runtime_unavailable", message: "prepared runtime was lost" } });
		expect(await firstPromise).toMatchObject({ ok: true, value: { outcome: "failed", reasonCode: "runtime_failed" } });
		expect(eventTypes()).toEqual(["agent.root_registered", "agent.spawn_requested", "agent.failed"]);
	});

	it("does not replay a durable prepared child after owner recreation", async () => {
		let prepareCalls = 0;
		let releaseActivation!: (result: MultiAgentResult<ActiveChildHandle>) => void;
		const baseProvider = createInProcessChildRuntimeProvider();
		const provider: ChildRuntimeProviderPort = {
			providerId: "in_process",
			prepare: async (spec) => {
				prepareCalls += 1;
				const prepared = await baseProvider.prepare(spec);
				if (!prepared.ok) return prepared;
				return {
					ok: true,
					value: {
						...prepared.value,
						activate: () => new Promise((resolve) => { releaseActivation = resolve; }),
					},
				};
			},
		};
		const firstSupervisor = supervisor(stopStream({ count: 0 }), { provider });
		expect(await firstSupervisor.registerRoot()).toMatchObject({ ok: true });
		const firstPromise = firstSupervisor.spawn(request(), invocation("prepared-owner-recreation"));
		await waitForEvent("agent.spawned");

		const recreatedSupervisor = supervisor(stopStream({ count: 0 }), { provider });
		const duplicate = await recreatedSupervisor.spawn(request(), invocation("prepared-owner-recreation"));
		expect(duplicate).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(prepareCalls).toBe(1);

		releaseActivation({ ok: false, error: { code: "recovery_required", message: "activation acknowledgement was lost" } });
		expect(await firstPromise).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(eventTypes()).toEqual(["agent.root_registered", "agent.spawn_requested", "agent.spawned", "agent.reconciliation_required"]);
	});

	it("does not replay a durable running child after owner recreation", async () => {
		let release!: () => void;
		const gate = {
			started: false,
			release: new Promise<void>((resolve) => { release = resolve; }),
		};
		const calls = { count: 0 };
		const firstSupervisor = supervisor(gatedStopStream(gate, calls));
		expect(await firstSupervisor.registerRoot()).toMatchObject({ ok: true });
		const firstPromise = firstSupervisor.spawn(request(), invocation("running-owner-recreation"));
		await waitForEvent("agent.activated");

		const recreatedSupervisor = supervisor(stopStream({ count: 0 }));
		const duplicate = await recreatedSupervisor.spawn(request(), invocation("running-owner-recreation"));
		expect(duplicate).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		expect(calls.count).toBe(1);

		release();
		expect(await firstPromise).toMatchObject({ ok: true, value: { outcome: "completed" } });
	});

	it("lets cancel win against completion and commits one stopped terminal", async () => {
		let release!: () => void;
		const gate = {
			started: false,
			release: new Promise<void>((resolve) => { release = resolve; }),
		};
		const childSupervisor = supervisor(gatedStopStream(gate, { count: 0 }));
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const spawnPromise = childSupervisor.spawn(request(), invocation("cancel-race"));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const inspected = await childSupervisor.inspect();
		expect(inspected.ok).toBe(true);
		if (!inspected.ok) return;
		const childId = inspected.value.nodes.find((node) => node.role !== "root")?.agentId;
		expect(childId).toBeDefined();
		if (childId === undefined) return;
		const cancelPromise = childSupervisor.cancel(childId);
		release();
		expect(await cancelPromise).toMatchObject({ ok: true, value: { outcome: "stopped", reasonCode: "cancelled" } });
		expect(await spawnPromise).toMatchObject({ ok: true, value: { outcome: "stopped", reasonCode: "cancelled" } });
		expect(eventTypes().filter((eventType) => eventType === "agent.stopped")).toHaveLength(1);
	});

	it("keeps completion as the first terminal when cancellation arrives during terminal append", async () => {
		let childSupervisor!: AgentSupervisor;
		let cancelPromise: Promise<MultiAgentResult<unknown>> | undefined;
		let cancelTarget: AgentId | undefined;
		const graph = new AgentGraphStore({
			store: sessionStore,
			fence,
			rootAgentId: ROOT_AGENT_ID,
			appendEvent: (input) => {
				if (input.eventType === "agent.spawn_requested") {
					cancelTarget = JSON.parse(input.payloadJson).agentId as AgentId;
				}
				if (input.eventType === "agent.finished" && cancelTarget !== undefined) {
					cancelPromise = childSupervisor.cancel(cancelTarget);
				}
				return sessionStore.appendEvent(fence, input);
			},
		});
		childSupervisor = supervisor(stopStream({ count: 0 }), { graph });
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const result = await childSupervisor.spawn(request(), invocation("completion-first-race"));
		expect(result).toMatchObject({ ok: true, value: { outcome: "completed", report: "bounded child report" } });
		expect(cancelPromise).toBeDefined();
		expect(await cancelPromise).toMatchObject({ ok: true, value: { outcome: "completed" } });
		expect(eventTypes().filter((eventType) => eventType === "agent.finished")).toHaveLength(1);
	});

	it("replays a durable terminal when its append acknowledgement is lost", async () => {
		let loseTerminalAck = true;
		let calls = 0;
		const graph = new AgentGraphStore({
			store: sessionStore,
			fence,
			rootAgentId: ROOT_AGENT_ID,
			appendEvent: (input) => {
				const appended = sessionStore.appendEvent(fence, input);
				if (input.eventType === "agent.finished" && loseTerminalAck) {
					loseTerminalAck = false;
					throw new Error("terminal append acknowledgement lost");
				}
				return appended;
			},
		});
		const childSupervisor = supervisor(stopStream({ count: calls }), { graph });
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const result = await childSupervisor.spawn(request(), invocation("terminal-append-ack-loss"));
		expect(result).toMatchObject({ ok: true, value: { outcome: "completed", report: "bounded child report" } });
		expect(eventTypes().filter((eventType) => eventType === "agent.finished")).toHaveLength(1);
	});

	it("keeps a durable terminal as the replay winner when attempt settlement is uncertain", async () => {
		let beginCalls = 0;
		let settleCalls = 0;
		const attemptPort: NonNullable<AgentSupervisorOptions["attemptPort"]> = {
			beginAttempt: (input) => {
				beginCalls += 1;
				return { status: "started", commandId: input.commandId, attemptId: input.attemptId };
			},
			settleAttempt: () => {
				settleCalls += 1;
				return { ok: false, code: "settlement_ack_lost" };
			},
		};
		const calls = { count: 0 };
		const childSupervisor = supervisor(stopStream(calls), { attemptPort });
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const first = await childSupervisor.spawn(request(), invocation("terminal-before-settle"));
		const second = await childSupervisor.spawn(request(), invocation("terminal-before-settle"));
		expect(first).toEqual(second);
		expect(first).toMatchObject({ ok: true, value: { outcome: "completed" } });
		expect(beginCalls).toBe(1);
		expect(settleCalls).toBe(1);
		expect(calls.count).toBe(1);
	});

	it("enforces lifetime slots and does not release a failed child slot", async () => {
		let prepareCalls = 0;
		const childSupervisor = supervisor(stopStream({ count: 0 }), {
			limits: {
				maxChildrenPerRoot: 1,
				maxTotalAgents: 2,
				maxModelTurnsPerAgent: 3,
				maxToolCallsPerAgent: 3,
				maxActiveDurationMsPerAgent: 10_000,
				maxReportBytes: 1024,
			},
			provider: {
				providerId: "in_process",
				prepare: async (spec) => {
					prepareCalls += 1;
					if (prepareCalls === 1) return { ok: false, error: { code: "runtime_unavailable", message: "fixture prepare failed" } };
					return createInProcessChildRuntimeProvider().prepare(spec);
				},
			},
		});
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		const failed = await childSupervisor.spawn(request(), invocation("failed-slot"));
		expect(failed).toMatchObject({ ok: true, value: { outcome: "failed" } });
		const second = await childSupervisor.spawn(request(), invocation("second-slot"));
		expect(second).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
	});

	it("returns a stable inspect DTO with report digest and no full report", async () => {
		const childSupervisor = supervisor();
		expect(await childSupervisor.registerRoot()).toMatchObject({ ok: true });
		await childSupervisor.spawn(request(), invocation("inspect"));
		const inspected = await childSupervisor.inspect();
		expect(inspected).toMatchObject({ ok: true, value: { counts: { totalAgents: 2 }, nodes: [{ role: "root" }, { state: "completed", reportBytes: 20 }] } });
		if (inspected.ok) {
			const child = inspected.value.nodes[1];
			expect(child).toBeDefined();
			expect(child?.reportDigest).toEqual(runtimeDigest("bounded child report"));
			expect(JSON.stringify(inspected.value)).not.toContain("bounded child report");
		}
	});
});
