import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult, ToolAuthorizationPolicy } from "../../src/runtime/types.ts";
import type { ExecutionEnv } from "../../src/runtime/execution-env.ts";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { SessionOwner } from "../../src/runtime/session-owner/session-owner.ts";
import { SESSION_OWNER_HEARTBEAT_PARAMS, type OwnerFence, type OwnerTransport } from "../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { createSessionProductionToolSource } from "../../src/runtime/agents/capability-subset.ts";
import { AgentGraphStore } from "../../src/runtime/agents/graph-store.ts";
import type { AgentGraphCommand } from "../../src/runtime/agents/graph-events.ts";
import { AgentSupervisor, type AgentSupervisorOptions } from "../../src/runtime/agents/supervisor.ts";
import type { ChildRuntimeProviderPort } from "../../src/runtime/agents/child-runtime.ts";
import type { ChildModelRuntimeFactoryPort } from "../../src/runtime/agents/child-model-runtime.ts";
import type { SubagentInvocationContext, ValidatedSpawnSubagentInput } from "../../src/runtime/agents/types.ts";

const FAST_OWNER_PARAMS = Object.freeze({
	...SESSION_OWNER_HEARTBEAT_PARAMS,
	heartbeatIntervalMs: 60_000,
	staleThresholdMs: 1,
	connectTimeoutMs: 1,
	startupGraceMs: 1,
	takeoverProbes: 1,
	probeSpacingMinMs: 0,
	retryBackoffBaseMs: 0,
	retryBackoffMaxMs: 1,
});

const ROOT_AGENT_ID = createRuntimeId("agent", "fault-root");
const POLICY_DIGEST = runtimeDigest("fault-policy");
const CHILD_REQUEST: ValidatedSpawnSubagentInput = {
	role: "research",
	objective: "Inspect the governed workspace and return a bounded report.",
	requestedCapabilities: ["workspace.read"],
	budget: { maxModelTurns: 2, maxToolCalls: 2, maxActiveDurationMs: 5_000 },
	output: { kind: "report", maxBytes: 1_024 },
};

interface FaultFixture {
	readonly directory: string;
	readonly database: ReturnType<typeof openSessionDatabase>;
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	readonly sessionId: SessionId;
	readonly owner: SessionOwner;
	readonly fence: OwnerFence;
}

let fixtures: FaultFixture[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		fixture.owner.selfStopFenced();
		fixture.database.close();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

function executionEnv(): ExecutionEnv {
	return {
		cwd: "/workspace",
		fs: {
			readFile: async () => Buffer.from("fixture"),
			writeFile: async () => undefined,
			stat: async () => ({ size: 7, mtimeMs: 1, isFile: true, isDirectory: false }),
			readdir: async () => [],
			mkdir: async () => undefined,
			rm: async () => undefined,
			rename: async () => undefined,
		},
		shell: { exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
	};
}

function authorizationPolicy(): ToolAuthorizationPolicy {
	return { authorize: () => ({ decision: "allow" }) };
}

function readTool(): AgentTool {
	const schema = Type.Object({}, { additionalProperties: false });
	return {
		name: "read",
		label: "read",
		description: "read",
		parameters: schema,
		isReadOnly: () => true,
		capabilityClaims: [{ name: "repository_read", resourceKind: "filesystem", scope: "invocation" }],
		execute: async (): Promise<AgentToolResult> => ({ content: [{ type: "text", text: "fixture" }], details: {} }),
	};
}

function childRuntime(sessionId: SessionId): AgentSupervisorOptions["childRuntime"] {
	const source = createSessionProductionToolSource({
		sessionId,
		cwd: "/workspace",
		executionEnv: executionEnv(),
		authorizationPolicy: authorizationPolicy(),
		tools: [readTool()],
	});
	const modelRuntimeFactory: ChildModelRuntimeFactoryPort = {
		prepare: async () => ({ ok: false, error: { code: "runtime_unavailable", message: "fault provider does not start a model" } }),
	};
	return {
		systemPrompt: "fault child",
		tools: source.tools,
		modelRuntimeFactory,
		cwd: source.cwd,
		executionEnv: source.executionEnv,
		authorizationPolicy: source.authorizationPolicy,
	};
}

function completedProvider(calls: { prepare: number }): ChildRuntimeProviderPort {
	return {
		providerId: "in_process",
		prepare: async (spec) => {
			calls.prepare += 1;
			const descriptorDigest = runtimeDigest({ agentId: spec.agentId, phase: "completed" });
			const report = {
				agentId: spec.agentId,
				outcome: "completed" as const,
				report: "durable terminal report",
				reportDigest: runtimeDigest("durable terminal report"),
				reportBytes: Buffer.byteLength("durable terminal report", "utf8"),
				usage: { modelTurns: 1, toolCalls: 1, activeDurationMs: 1 },
			};
			return {
				ok: true,
				value: {
					descriptor: {
						agentId: spec.agentId,
						model: {
							providerId: "fault",
							modelId: "fault",
							profileId: "fault/fault",
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
								receiptId: createRuntimeId("receipt", `fault-${spec.agentId}`),
								agentId: spec.agentId,
								activatedAtMs: 1,
								receiptDigest: descriptorDigest,
							},
							completion: Promise.resolve({ ok: true, value: { report, messages: [] } }),
						},
					}),
					cancel: async () => ({ ok: true, value: undefined }),
					dispose: async () => ({ ok: true, value: undefined }),
				},
			};
		},
	};
}

function uncertainActivationProvider(): ChildRuntimeProviderPort {
	return {
		providerId: "in_process",
		prepare: async (spec) => {
			const descriptorDigest = runtimeDigest({ agentId: spec.agentId, phase: "activation-uncertain" });
			return {
				ok: true,
				value: {
					descriptor: {
						agentId: spec.agentId,
						model: {
							providerId: "fault",
							modelId: "fault",
							profileId: "fault/fault",
							api: "mock",
							thinkingLevel: "off",
							systemPromptDigest: descriptorDigest,
							toolManifestDigest: descriptorDigest,
						},
						descriptorDigest,
					},
					activate: async () => ({ ok: false, error: { code: "recovery_required", message: "activation acknowledgement lost" } }),
					cancel: async () => ({ ok: true, value: undefined }),
					dispose: async () => ({ ok: true, value: undefined }),
				},
			};
		},
	};
}

function requestInvocation(fence: OwnerFence): SubagentInvocationContext {
	return {
		sessionId: fence.sessionId,
		ownerGeneration: fence.generation,
		rootAgentId: ROOT_AGENT_ID,
		parentAgentId: ROOT_AGENT_ID,
		source: "model_tool",
		effectId: "fault-effect",
		signal: new AbortController().signal,
	};
}

async function createFixture(seed: string): Promise<FaultFixture> {
	const directory = mkdtempSync(join(tmpdir(), `runledger-multi-agent-fault-${seed}-`));
	const database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	const store = new SessionStore(database);
	const ownerStore = new OwnerStore(database);
	const sessionId = createRuntimeId("session", `fault-${seed}`);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", `fault-${seed}`),
		repositoryId: createRuntimeId("repository", `fault-${seed}`),
		settingsDigest: "f".repeat(64),
	});
	let port = 40_000;
	const transport: OwnerTransport = {
		bindCandidate: async () => ({ host: "127.0.0.1", port: port++ }),
		closeCandidate: async () => undefined,
		probe: async () => ({ ok: false, code: "connect_failed" }),
	};
	const owner = new SessionOwner({ store, ownerStore, transport }, FAST_OWNER_PARAMS);
	const claimed = await owner.open(sessionId);
	if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("fault fixture owner claim failed");
	owner.publish("running");
	const fixture = { directory, database, store, ownerStore, sessionId, owner, fence: claimed.fence };
	fixtures.push(fixture);
	return fixture;
}

async function takeOver(fixture: FaultFixture): Promise<{ readonly owner: SessionOwner; readonly fence: OwnerFence }> {
	fixture.owner.selfStopFenced();
	fixture.database.runSync("UPDATE session_owners SET heartbeat_at_ms = 0, updated_at_ms = 0 WHERE session_id = ?", [fixture.sessionId]);
	let port = 50_000;
	const transport: OwnerTransport = {
		bindCandidate: async () => ({ host: "127.0.0.1", port: port++ }),
		closeCandidate: async () => undefined,
		probe: async () => ({ ok: false, code: "connect_failed" }),
	};
	const owner = new SessionOwner({ store: fixture.store, ownerStore: fixture.ownerStore, transport }, FAST_OWNER_PARAMS);
	const claimed = await owner.open(fixture.sessionId);
	if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("fault fixture takeover failed");
	return { owner, fence: claimed.fence };
}

function graph(fixture: FaultFixture, fence: OwnerFence): AgentGraphStore {
	return new AgentGraphStore({ store: fixture.store, fence, rootAgentId: ROOT_AGENT_ID });
}

async function commit(store: AgentGraphStore, command: AgentGraphCommand): Promise<void> {
	const result = await store.commit(command);
	if (!result.ok) throw new Error(result.error.message);
}

async function seedRequested(store: AgentGraphStore): Promise<void> {
	await commit(store, {
		type: "agent.root_registered",
		commandId: createRuntimeId("command", "fault-root"),
		requestDigest: runtimeDigest("fault-root"),
		expectedRevision: 0,
		rootAgentId: ROOT_AGENT_ID,
		agentId: ROOT_AGENT_ID,
		policyReceiptDigest: POLICY_DIGEST,
	});
	await commit(store, {
		type: "agent.spawn_requested",
		commandId: createRuntimeId("command", "fault-spawn"),
		requestDigest: runtimeDigest("fault-spawn"),
		expectedRevision: 1,
		rootAgentId: ROOT_AGENT_ID,
		agentId: createRuntimeId("agent", "fault-child"),
		parentAgentId: ROOT_AGENT_ID,
		role: CHILD_REQUEST.role,
		objective: CHILD_REQUEST.objective,
		requestedCapabilities: CHILD_REQUEST.requestedCapabilities,
		budget: CHILD_REQUEST.budget,
		maxReportBytes: CHILD_REQUEST.output.maxBytes,
	});
}

async function seedPrepared(store: AgentGraphStore): Promise<void> {
	await seedRequested(store);
	await commit(store, {
		type: "agent.spawned",
		commandId: createRuntimeId("command", "fault-prepared"),
		requestDigest: runtimeDigest("fault-prepared"),
		expectedRevision: 2,
		rootAgentId: ROOT_AGENT_ID,
		agentId: createRuntimeId("agent", "fault-child"),
		runtimeDescriptorDigest: runtimeDigest("fault-descriptor"),
	});
}

async function seedRunning(store: AgentGraphStore): Promise<void> {
	await seedPrepared(store);
	await commit(store, {
		type: "agent.activated",
		commandId: createRuntimeId("command", "fault-activated"),
		requestDigest: runtimeDigest("fault-activated"),
		expectedRevision: 3,
		rootAgentId: ROOT_AGENT_ID,
		agentId: createRuntimeId("agent", "fault-child"),
		activationReceiptDigest: runtimeDigest("fault-receipt"),
	});
}

function recoverySupervisor(fixture: FaultFixture, graphStore: AgentGraphStore, provider: ChildRuntimeProviderPort = completedProvider({ prepare: 0 })): AgentSupervisor {
	return new AgentSupervisor({
		graph: graphStore,
		rootAgentId: ROOT_AGENT_ID,
		policyReceiptDigest: POLICY_DIGEST,
		provider,
		childRuntime: childRuntime(fixture.sessionId),
		previousOwnerLiveness: () => "dead",
	});
}

describe("bounded multi-agent owner recreation fault matrix", () => {
	it.each([
		["after requested", seedRequested, ["agent.root_registered", "agent.spawn_requested", "agent.stopped"]],
		["after prepare", seedPrepared, ["agent.root_registered", "agent.spawn_requested", "agent.spawned", "agent.reconciliation_required", "agent.stopped"]],
		["after activated", seedRunning, ["agent.root_registered", "agent.spawn_requested", "agent.spawned", "agent.activated", "agent.reconciliation_required", "agent.stopped"]],
	] as const)("replays and recovers %s after recreating the Session Owner", async (_name, seed, expectedEvents) => {
		const fixture = await createFixture(_name.replaceAll(" ", "-"));
		const firstGraph = graph(fixture, fixture.fence);
		await seed(firstGraph);
		const takeover = await takeOver(fixture);
		const recreatedGraph = graph(fixture, takeover.fence);
		const supervisor = recoverySupervisor(fixture, recreatedGraph);
		const recovered = await supervisor.recover();
		expect(recovered).toMatchObject({ ok: true, value: { stopped: [createRuntimeId("agent", "fault-child")], recoveryRequired: [] } });
		expect(fixture.store.replaySessionEvents(fixture.sessionId).map((event) => event.eventType).filter((event) => event.startsWith("agent."))).toEqual(expectedEvents);
		const inspected = await supervisor.inspect();
		expect(JSON.parse(JSON.stringify(inspected))).toEqual(inspected);
	});

	it("marks activation acknowledgement loss as recovery_required before the new owner stops it", async () => {
		const fixture = await createFixture("activation-ack-loss");
		const firstGraph = graph(fixture, fixture.fence);
		const first = new AgentSupervisor({
			graph: firstGraph,
			rootAgentId: ROOT_AGENT_ID,
			policyReceiptDigest: POLICY_DIGEST,
			provider: uncertainActivationProvider(),
			childRuntime: childRuntime(fixture.sessionId),
		});
		expect(await first.registerRoot()).toMatchObject({ ok: true });
		expect(await first.spawn(CHILD_REQUEST, requestInvocation(fixture.fence))).toMatchObject({ ok: false, error: { code: "recovery_required" } });
		const takeover = await takeOver(fixture);
		const recreated = recoverySupervisor(fixture, graph(fixture, takeover.fence));
		expect(await recreated.recover()).toMatchObject({ ok: true, value: { stopped: [expect.any(String)] } });
		expect(fixture.store.replaySessionEvents(fixture.sessionId).map((event) => event.eventType).filter((event) => event.startsWith("agent."))).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.reconciliation_required",
			"agent.stopped",
		]);
	});

	it("replays a durable terminal after terminal append acknowledgement loss", async () => {
		const fixture = await createFixture("terminal-ack-loss");
		let loseAck = true;
		const calls = { prepare: 0 };
		const firstGraph = new AgentGraphStore({
			store: fixture.store,
			fence: fixture.fence,
			rootAgentId: ROOT_AGENT_ID,
			appendEvent: (input) => {
				const appended = fixture.store.appendEvent(fixture.fence, input);
				if (input.eventType === "agent.finished" && loseAck) {
					loseAck = false;
					throw new Error("terminal append acknowledgement lost");
				}
				return appended;
			},
		});
		const first = new AgentSupervisor({
			graph: firstGraph,
			rootAgentId: ROOT_AGENT_ID,
			policyReceiptDigest: POLICY_DIGEST,
			provider: completedProvider(calls),
			childRuntime: childRuntime(fixture.sessionId),
		});
		expect(await first.registerRoot()).toMatchObject({ ok: true });
		const firstResult = await first.spawn(CHILD_REQUEST, requestInvocation(fixture.fence));
		expect(firstResult).toMatchObject({ ok: true, value: { outcome: "completed" } });
		const takeover = await takeOver(fixture);
		const recreated = recoverySupervisor(fixture, graph(fixture, takeover.fence), completedProvider(calls));
		const replay = await recreated.spawn(CHILD_REQUEST, requestInvocation(takeover.fence));
		expect(JSON.stringify(replay)).toBe(JSON.stringify(firstResult));
		expect(calls.prepare).toBe(1);
		expect(fixture.store.replaySessionEvents(fixture.sessionId).map((event) => event.eventType).filter((event) => event === "agent.finished")).toHaveLength(1);
	});

	it("keeps the durable terminal as the replay winner when terminal precedes attempt settlement", async () => {
		const fixture = await createFixture("terminal-before-settle");
		const calls = { prepare: 0 };
		let settleCalls = 0;
		const attemptPort: NonNullable<AgentSupervisorOptions["attemptPort"]> = {
			beginAttempt: (input) => ({ status: "started", commandId: input.commandId, attemptId: input.attemptId }),
			settleAttempt: () => {
				settleCalls += 1;
				return { ok: false, code: "settlement_ack_lost" };
			},
		};
		const first = new AgentSupervisor({
			graph: graph(fixture, fixture.fence),
			rootAgentId: ROOT_AGENT_ID,
			policyReceiptDigest: POLICY_DIGEST,
			provider: completedProvider(calls),
			childRuntime: childRuntime(fixture.sessionId),
			attemptPort,
		});
		expect(await first.registerRoot()).toMatchObject({ ok: true });
		const firstResult = await first.spawn(CHILD_REQUEST, requestInvocation(fixture.fence));
		expect(firstResult).toMatchObject({ ok: true, value: { outcome: "completed" } });
		expect(settleCalls).toBe(1);
		const takeover = await takeOver(fixture);
		const recreated = recoverySupervisor(fixture, graph(fixture, takeover.fence), completedProvider(calls));
		const replay = await recreated.spawn(CHILD_REQUEST, requestInvocation(takeover.fence));
		expect(JSON.stringify(replay)).toBe(JSON.stringify(firstResult));
		expect(calls.prepare).toBe(1);
	});
});
