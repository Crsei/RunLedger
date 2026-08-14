import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream } from "../../../src/utils/event-stream.ts";
import type { Api, AssistantMessage, Model } from "../../../src/types.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { StreamFn, ToolAuthorizationPolicy } from "../../../src/runtime/types.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { AgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import type { AgentGraphCommand as AgentGraphCommandType } from "../../../src/runtime/agents/graph-events.ts";
import { createInProcessChildRuntimeProvider } from "../../../src/runtime/agents/child-runtime.ts";
import type { ChildModelRuntimeFactoryPort } from "../../../src/runtime/agents/child-model-runtime.ts";
import { AgentSupervisor, type AgentSupervisorOptions } from "../../../src/runtime/agents/supervisor.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const MODEL: Model<Api> = {
	id: "recovery-fixture-model",
	name: "Recovery Fixture Model",
	api: "mock",
	provider: "recovery-fixture-provider",
	baseUrl: "http://recovery-fixture.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4_096,
	maxTokens: 512,
};

const USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ROOT_AGENT_ID = createRuntimeId("agent", "recovery-root");
const CHILD_AGENT_ID = createRuntimeId("agent", "recovery-child");
const POLICY_DIGEST = runtimeDigest("recovery-policy");
const REQUEST_DIGEST = runtimeDigest("recovery-request");
const DESCRIPTOR_DIGEST = runtimeDigest("recovery-descriptor");

let directory: string;
let database: ReturnType<typeof openSessionDatabase>;
let sessionStore: SessionStore;
let sessionId: SessionId;
let fence: OwnerFence;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "runledger-recovery-"));
	database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	sessionStore = new SessionStore(database);
	sessionId = createRuntimeId("session", "recovery-session");
	const runtimeId = createRuntimeId("runtime", "recovery-runtime");
	sessionStore.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "recovery-workspace"),
		repositoryId: createRuntimeId("repository", "recovery-repository"),
		settingsDigest: "r".repeat(64),
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

function unusedStream(): StreamFn {
	return (_model, _context) => {
		const stream = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "unused" }],
			api: MODEL.api,
			provider: MODEL.provider,
			model: MODEL.id,
			usage: USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		};
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		});
		return stream;
	};
}

function childRuntime(): AgentSupervisorOptions["childRuntime"] {
	const modelRuntimeFactory: ChildModelRuntimeFactoryPort = {
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
					systemPromptDigest: runtimeDigest("recovery-system"),
					toolManifestDigest: runtimeDigest(tools.map((tool) => tool.name)),
				},
				streamFn: unusedStream(),
			},
		}),
	};
	return {
		systemPrompt: "recovery system",
		tools: [],
		modelRuntimeFactory,
		cwd: "/workspace",
		executionEnv: executionEnv(),
		authorizationPolicy: allowingPolicy(),
	};
}

function graphStore(): AgentGraphStore {
	return new AgentGraphStore({ store: sessionStore, fence, rootAgentId: ROOT_AGENT_ID });
}

function rootCommand(): AgentGraphCommandType {
	return {
		type: "agent.root_registered",
		commandId: createRuntimeId("command", "recovery-root-registration"),
		requestDigest: runtimeDigest("recovery-root-registration"),
		expectedRevision: 0,
		rootAgentId: ROOT_AGENT_ID,
		agentId: ROOT_AGENT_ID,
		policyReceiptDigest: POLICY_DIGEST,
	};
}

function spawnCommand(): AgentGraphCommandType {
	return {
		type: "agent.spawn_requested",
		commandId: createRuntimeId("command", "recovery-spawn-request"),
		requestDigest: REQUEST_DIGEST,
		expectedRevision: 1,
		rootAgentId: ROOT_AGENT_ID,
		agentId: CHILD_AGENT_ID,
		parentAgentId: ROOT_AGENT_ID,
		role: "research",
		objective: "Recover this child.",
		requestedCapabilities: ["workspace.read"],
		budget: { maxModelTurns: 2, maxToolCalls: 2, maxActiveDurationMs: 1000 },
		maxReportBytes: 1024,
	};
}

async function commit(graph: AgentGraphStore, command: AgentGraphCommandType): Promise<void> {
	const result = await graph.commit(command);
	if (!result.ok) throw new Error(result.error.message);
}

async function setupRequested(): Promise<AgentGraphStore> {
	const graph = graphStore();
	await commit(graph, rootCommand());
	await commit(graph, spawnCommand());
	return graph;
}

async function setupRunning(): Promise<AgentGraphStore> {
	const graph = await setupRequested();
	await commit(graph, {
		type: "agent.spawned",
		commandId: createRuntimeId("command", "recovery-prepared"),
		requestDigest: runtimeDigest("recovery-prepared"),
		expectedRevision: 2,
		rootAgentId: ROOT_AGENT_ID,
		agentId: CHILD_AGENT_ID,
		runtimeDescriptorDigest: DESCRIPTOR_DIGEST,
	});
	await commit(graph, {
		type: "agent.activated",
		commandId: createRuntimeId("command", "recovery-activated"),
		requestDigest: runtimeDigest("recovery-activated"),
		expectedRevision: 3,
		rootAgentId: ROOT_AGENT_ID,
		agentId: CHILD_AGENT_ID,
		activationReceiptDigest: runtimeDigest("recovery-activation-receipt"),
	});
	return graph;
}

function supervisor(graph: AgentGraphStore, liveness: "dead" | "unknown" | "alive"): AgentSupervisor {
	return new AgentSupervisor({
		graph,
		rootAgentId: ROOT_AGENT_ID,
		policyReceiptDigest: POLICY_DIGEST,
		provider: createInProcessChildRuntimeProvider(),
		childRuntime: childRuntime(),
		previousOwnerLiveness: () => liveness,
	});
}

function eventTypes(): string[] {
	return sessionStore.replaySessionEvents(sessionId).map((event) => event.eventType);
}

describe("bounded child recovery", () => {
	it("takes over a requested child as stopped only when previous owner death is proven", async () => {
		const graph = await setupRequested();
		const childSupervisor = supervisor(graph, "dead");
		const recovered = await childSupervisor.recover();
		expect(recovered).toMatchObject({ ok: true, value: { stopped: [CHILD_AGENT_ID], recoveryRequired: [] } });
		expect(eventTypes()).toEqual(["agent.root_registered", "agent.spawn_requested", "agent.stopped"]);
		const inspection = await childSupervisor.inspect();
		expect(inspection).toMatchObject({ ok: true, value: { nodes: [{ role: "root" }, { state: "stopped", reasonCode: "owner_takeover" }] } });
	});

	it("keeps a running child in recovery_required when previous owner death is not proven", async () => {
		const graph = await setupRunning();
		const childSupervisor = supervisor(graph, "unknown");
		const recovered = await childSupervisor.recover();
		expect(recovered).toMatchObject({ ok: true, value: { stopped: [], recoveryRequired: [CHILD_AGENT_ID] } });
		expect(eventTypes()).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.activated",
			"agent.reconciliation_required",
		]);
		const blocked = await childSupervisor.spawn({
			role: "review",
			objective: "new child",
			requestedCapabilities: ["workspace.read"],
			budget: { maxModelTurns: 1, maxToolCalls: 1, maxActiveDurationMs: 1000 },
			output: { kind: "report", maxBytes: 128 },
		}, {
			sessionId,
			ownerGeneration: 2,
			rootAgentId: ROOT_AGENT_ID,
			parentAgentId: ROOT_AGENT_ID,
			source: "model_tool",
			effectId: "blocked-during-recovery",
			signal: new AbortController().signal,
		});
		expect(blocked).toMatchObject({ ok: false, error: { code: "recovery_required" } });
	});

	it("stops a prepared/running child after takeover and preserves its bounded terminal evidence", async () => {
		const graph = await setupRunning();
		const childSupervisor = supervisor(graph, "dead");
		const recovered = await childSupervisor.recover();
		expect(recovered).toMatchObject({ ok: true, value: { stopped: [CHILD_AGENT_ID] } });
		expect(eventTypes()).toEqual([
			"agent.root_registered",
			"agent.spawn_requested",
			"agent.spawned",
			"agent.activated",
			"agent.reconciliation_required",
			"agent.stopped",
		]);
		const inspection = await childSupervisor.inspect();
		if (inspection.ok) {
			const child = inspection.value.nodes.find((node) => node.agentId === CHILD_AGENT_ID);
			expect(child).toMatchObject({ state: "stopped", reportBytes: 0, reasonCode: "owner_takeover" });
		}
	});
});
