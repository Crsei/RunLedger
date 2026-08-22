import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import { createRuntimeId, type AgentId, type SessionId, type ToolCallId } from "../../../src/runtime/protocol/ids.ts";
import type { AgentTool, AgentToolResult } from "../../../src/runtime/types.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { SessionDomainResult } from "../../../src/runtime/session-runtime/domain-router.ts";
import {
	createMultiAgentDomain,
	deriveRootAgentId,
	deriveSpawnEffectId,
	type MultiAgentDomainPort,
} from "../../../src/runtime/agents/domain.ts";
import { validateSpawnSubagentRequest } from "../../../src/runtime/agents/limits.ts";
import { createSpawnAgentTool } from "../../../src/runtime/agents/spawn-tool.ts";
import { createSessionProductionToolSource } from "../../../src/runtime/agents/capability-subset.ts";
import type { ChildModelRuntimeFactoryPort } from "../../../src/runtime/agents/child-model-runtime.ts";
import type { ChildRuntimeProviderPort } from "../../../src/runtime/agents/child-runtime.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { MultiAgentPolicy, ChildReport, SubagentInvocationContext } from "../../../src/runtime/agents/types.ts";
import { applyTaskPolicyNarrowing } from "../../../src/runtime/agents/limits.ts";
import type { SessionStore } from "../../../src/storage/session-store/session-store.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
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

function readTool(): AgentTool {
	const schema = Type.Object({}, { additionalProperties: false });
	return {
		name: "read",
		label: "read",
		description: "read",
		parameters: schema,
		isReadOnly: () => true,
		capabilityClaims: [{ name: "repository_read", resourceKind: "filesystem", scope: "invocation" }],
		execute: async (): Promise<AgentToolResult> => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function childModelRuntimeFactory(): ChildModelRuntimeFactoryPort {
	return {
		prepare: async ({ tools }) => ({
			ok: false,
			error: { code: "runtime_unavailable", message: "model is not used in this gate" },
		}),
	};
}

function childSource(sessionId: SessionId) {
	return createSessionProductionToolSource({
		sessionId,
		cwd: "/workspace",
		executionEnv: executionEnv(),
		authorizationPolicy: { authorize: () => ({ decision: "allow" }) },
		tools: [readTool()],
	});
}

function report(agentId: AgentId): ChildReport {
	return {
		agentId,
		outcome: "completed",
		report: "report",
		reportDigest: runtimeDigest("report"),
		reportBytes: 6,
		usage: { modelTurns: 1, toolCalls: 0, activeDurationMs: 1 },
	};
}

function policy(): MultiAgentPolicy {
	return {
		enabled: true,
		limits: {
			maxChildrenPerRoot: 3,
			maxTotalAgents: 4,
			maxModelTurnsPerAgent: 12,
			maxToolCallsPerAgent: 32,
			maxActiveDurationMsPerAgent: 300_000,
			maxReportBytes: 65_536,
		},
	};
}

describe("Session task policy narrowing", () => {
	it("narrows child runtime budget and rejects disabled roles without widening M1 limits", () => {
		const narrowed = applyTaskPolicyNarrowing(policy(), {
			maxConcurrency: 16,
			maxRecursionDepth: 8,
			maxRuntimeMs: 1_500,
			softRequestBudget: 2,
			disabledAgents: ["research"],
		});

		expect(narrowed.limits).toMatchObject({
			maxChildrenPerRoot: 3,
			maxTotalAgents: 4,
			maxModelTurnsPerAgent: 2,
			maxActiveDurationMsPerAgent: 1_500,
		});
		expect(narrowed.disabledAgents).toEqual(["research"]);
		expect(validateSpawnSubagentRequest({ role: "research", objective: "read" }, narrowed)).toMatchObject({
		ok: false,
		error: { code: "unsupported_feature", path: "role" },
	});
	});

	it("uses task narrowing in the durable multi-agent production policy", async () => {
		harness = await createRuntimeHarness("multi-agent-task-policy");
		const created = await createMultiAgentDomain({
			sessionId: harness.sessionId,
			ownerGeneration: harness.fence.generation,
			store: harness.store,
			fence: harness.fence,
			policySources: {
				runtimeEnabled: true,
				user: { enabled: true },
				taskPolicy: { maxConcurrency: 1, maxRecursionDepth: 1, maxRuntimeMs: 1_000, softRequestBudget: 3, disabledAgents: ["qa"] },
			},
			childRuntime: {
				systemPrompt: "child",
				productionToolSource: childSource(harness.sessionId),
				modelRuntimeFactory: childModelRuntimeFactory(),
			},
		});

		expect(created).toMatchObject({ ok: true, value: { policy: { limits: {
			maxModelTurnsPerAgent: 3,
			maxActiveDurationMsPerAgent: 1_000,
		}, disabledAgents: ["qa"] } } });
	});
});

describe("Session Domain multi-agent consumer", () => {
	it("does not register spawn_agent when runtime, user, workspace, or policy gates are closed", async () => {
		const sessionId = createRuntimeId("session", "multi-agent-gate");
		const disabledRuntime = await createMultiAgentDomain({
			sessionId,
			ownerGeneration: 1,
			store: {} as SessionStore,
			fence: {} as OwnerFence,
			policySources: { runtimeEnabled: false, user: { enabled: true } },
			childRuntime: { systemPrompt: "child", productionToolSource: childSource(sessionId), modelRuntimeFactory: childModelRuntimeFactory() },
		});
		const disabledUser = await createMultiAgentDomain({
			sessionId,
			ownerGeneration: 1,
			store: {} as SessionStore,
			fence: {} as OwnerFence,
			policySources: { runtimeEnabled: true, user: { enabled: false } },
			childRuntime: { systemPrompt: "child", productionToolSource: childSource(sessionId), modelRuntimeFactory: childModelRuntimeFactory() },
		});
		const disabledWorkspace = await createMultiAgentDomain({
			sessionId,
			ownerGeneration: 1,
			store: {} as SessionStore,
			fence: {} as OwnerFence,
			policySources: { runtimeEnabled: true, user: { enabled: true }, workspace: { enabled: false } },
			childRuntime: { systemPrompt: "child", productionToolSource: childSource(sessionId), modelRuntimeFactory: childModelRuntimeFactory() },
		});
		const invalidPolicy = await createMultiAgentDomain({
			sessionId,
			ownerGeneration: 1,
			store: {} as SessionStore,
			fence: {} as OwnerFence,
			policySources: { runtimeEnabled: true, user: { enabled: true, unknown: true } },
			childRuntime: { systemPrompt: "child", productionToolSource: childSource(sessionId), modelRuntimeFactory: childModelRuntimeFactory() },
		});

		expect(disabledRuntime).toMatchObject({ ok: true, value: undefined });
		expect(disabledUser).toMatchObject({ ok: true, value: undefined });
		expect(disabledWorkspace).toMatchObject({ ok: true, value: undefined });
		expect(invalidPolicy).toMatchObject({ ok: true, value: undefined });
	});

	it("makes inspect read-only, exposes only spawn/cancel mutations, and blocks spawn during recovery", async () => {
		const multiAgent: MultiAgentDomainPort = {
			operationManifest: [
				{ operation: "agent.inspect", capability: "session.multi-agent", access: "read" },
				{ operation: "agent.spawn", capability: "session.multi-agent", access: "mutate" },
				{ operation: "agent.cancel", capability: "session.multi-agent", access: "mutate" },
			],
			query: async () => ({ ok: true, status: "ok", operation: "agent.inspect", domainRevision: 0, value: { nodes: [] } }),
			mutate: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 0, value: {} }),
			spawn: async () => ({ ok: true, value: report(createRuntimeId("agent", "child")) }),
			recover: async () => ({ ok: true, value: { stopped: [], recoveryRequired: [] } }),
		};
		const domain: SessionDomainPort = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			multiAgent,
			snapshot: () => ({ messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, inFlight: false, providerStatuses: [] }),
		};
		harness = await createRuntimeHarness("multi-agent-domain-routing", { domain, crashTakeover: true });
		expect(harness.runtime.protocolManifest().operationManifest).toEqual(expect.arrayContaining(multiAgent.operationManifest));

		const inspect = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: { sessionId: harness.sessionId, generation: harness.fence.generation, correlationId: "c", effectId: "e", operation: "agent.inspect", payload: {} },
		});
		expect(inspect).toMatchObject({ ok: true, status: "ok", operation: "agent.inspect" });

		const observerSpawn = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "observer-spawn"),
			kind: "domain_command",
			body: { sessionId: harness.sessionId, generation: harness.fence.generation, correlationId: "c", effectId: "e", operation: "agent.spawn", expectedRevision: 0, payload: {} },
		}, { connectionId: createRuntimeId("connection", "observer"), clientId: "client_observer", isDriver: false });
		expect(observerSpawn).toEqual({ ok: false, code: "observer_mutation_forbidden" });

		const driverSpawn = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "driver-spawn"),
			kind: "domain_command",
			body: { sessionId: harness.sessionId, generation: harness.fence.generation, correlationId: "c", effectId: "e", operation: "agent.spawn", expectedRevision: 0, payload: {} },
		}, { connectionId: createRuntimeId("connection", "driver"), clientId: "client_driver", isDriver: true });
		expect(driverSpawn).toMatchObject({ ok: true, result: { ok: false, status: "recovery_required", code: "recovery_barrier_active" } });
	});

	it("derives tool identity from trusted ToolContext and keeps the schema free of authority fields", async () => {
		const calls: SubagentInvocationContext[] = [];
		const domain = {
			spawn: async (_input: unknown, invocation: SubagentInvocationContext) => {
				calls.push(invocation);
				return { ok: true as const, value: report(createRuntimeId("agent", "child")) };
			},
		};
		const tool = createSpawnAgentTool({
			domain,
			policy: policy(),
			rootAgentId: deriveRootAgentId(createRuntimeId("session", "tool-context")),
			ownerGeneration: 7,
		});
		const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
		expect(Object.keys(properties)).toEqual(expect.arrayContaining(["role", "objective", "requestedCapabilities", "budget", "output"]));
		expect(Object.keys(properties)).not.toEqual(expect.arrayContaining(["authority", "parentAgentId", "sessionId", "providerId", "modelId", "idempotencyKey"]));

		const sessionId = createRuntimeId("session", "tool-context");
		const toolCallId = createRuntimeId("toolCall", "trusted-call") as ToolCallId;
		await tool.execute("untrusted-argument", { role: "research", objective: "read the repository" }, new AbortController().signal, undefined, {
			cwd: "/workspace",
			env: executionEnv(),
			envVars: {},
			signal: new AbortController().signal,
			sessionId,
			toolCallId,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionId).toBe(sessionId);
		expect(calls[0]?.toolCallId).toBe(toolCallId);
		expect(calls[0]?.effectId).toBe(deriveSpawnEffectId(sessionId, toolCallId));
		expect(calls[0]?.source).toBe("model_tool");
	});

	it("shares the same replay identity between spawn_agent and agent.spawn", async () => {
		harness = await createRuntimeHarness("multi-agent-shared-replay");
		let prepareCalls = 0;
		const provider: ChildRuntimeProviderPort = {
			providerId: "in_process",
			prepare: async (spec) => {
				prepareCalls += 1;
				const descriptorDigest = runtimeDigest({ agentId: spec.agentId, kind: "domain-fixture" });
				return {
					ok: true,
					value: {
						descriptor: { agentId: spec.agentId, model: { providerId: "fixture", modelId: "fixture", profileId: "fixture", api: "mock", thinkingLevel: "off", systemPromptDigest: descriptorDigest, toolManifestDigest: descriptorDigest }, descriptorDigest },
						activate: async () => ({
							ok: true,
							value: {
								activationReceipt: { receiptId: createRuntimeId("receipt", "domain-fixture"), agentId: spec.agentId, activatedAtMs: 1, receiptDigest: descriptorDigest },
								completion: Promise.resolve({ ok: true, value: { report: report(spec.agentId), messages: [] } }),
							},
						}),
						cancel: async () => ({ ok: true, value: undefined }),
						dispose: async () => ({ ok: true, value: undefined }),
					},
				};
			},
		};
		const created = await createMultiAgentDomain({
			sessionId: harness.sessionId,
			ownerGeneration: harness.fence.generation,
			store: harness.store,
			fence: harness.fence,
			policySources: { runtimeEnabled: true, user: { enabled: true } },
			childRuntime: { systemPrompt: "child", productionToolSource: childSource(harness.sessionId), modelRuntimeFactory: childModelRuntimeFactory() },
			provider,
		});
		expect(created.ok).toBe(true);
		if (!created.ok || created.value === undefined) return;

		const input = { role: "research" as const, objective: "read the repository", requestedCapabilities: ["workspace.read" as const] };
		const tool = created.value.tools[0];
		const first = await tool.execute("ignored-tool-call-id", input, new AbortController().signal, undefined, {
			cwd: "/workspace",
			env: executionEnv(),
			envVars: {},
			signal: new AbortController().signal,
			sessionId: harness.sessionId,
			toolCallId: createRuntimeId("toolCall", "shared-replay"),
		});
		const second = await created.value.mutate("agent.spawn", input, { correlationId: "domain", effectId: deriveSpawnEffectId(harness.sessionId, createRuntimeId("toolCall", "shared-replay")), expectedRevision: 0 });
		expect(first.details).toEqual(expect.objectContaining({ report: expect.objectContaining({ outcome: "completed" }) }));
		expect(second).toMatchObject({ ok: true, status: "ok", value: { report: expect.objectContaining({ outcome: "completed" }) } });
		expect(prepareCalls).toBe(1);
		expect(harness.store.replaySessionEvents(harness.sessionId).filter((event) => event.eventType === "agent.spawn_requested")).toHaveLength(1);
	});

	it("records the complete effective policy receipt before root registration and fails closed on conflicting replay", async () => {
		harness = await createRuntimeHarness("multi-agent-policy-receipt");
		const options = {
			sessionId: harness.sessionId,
			ownerGeneration: harness.fence.generation,
			store: harness.store,
			fence: harness.fence,
			policySources: {
				runtimeEnabled: true,
				user: { enabled: true, maxToolCallsPerAgent: 7 },
				workspace: { enabled: true, maxToolCallsPerAgent: 5 },
			},
			childRuntime: {
				systemPrompt: "child",
				productionToolSource: childSource(harness.sessionId),
				modelRuntimeFactory: childModelRuntimeFactory(),
			},
		} as const;
		const first = await createMultiAgentDomain(options);
		const duplicate = await createMultiAgentDomain(options);
		expect(first.ok).toBe(true);
		expect(duplicate.ok).toBe(true);

		const events = harness.store.replaySessionEvents(harness.sessionId);
		expect(events.map((event) => event.eventType).filter((eventType) =>
			eventType === "policy.effective_recorded" || eventType === "agent.root_registered",
		)).toEqual([
			"policy.effective_recorded",
			"agent.root_registered",
		]);
		const policyEvents = events.filter((event) => event.eventType === "policy.effective_recorded");
		expect(policyEvents).toHaveLength(1);
		const payload = JSON.parse(policyEvents[0]!.payloadJson) as Record<string, unknown>;
		expect(payload).toMatchObject({
			policyKind: "multi_agent",
			receipt: {
				runtimeEnabled: true,
				userSourceDigest: runtimeDigest(options.policySources.user),
				workspaceSourceDigest: runtimeDigest(options.policySources.workspace),
				effectiveLimits: {
					maxChildrenPerRoot: 3,
					maxTotalAgents: 4,
					maxModelTurnsPerAgent: 12,
					maxToolCallsPerAgent: 5,
					maxActiveDurationMsPerAgent: 300_000,
					maxReportBytes: 65_536,
				},
				diagnostics: [],
				resolverVersion: "m1.0",
				receiptDigest: first.ok && first.value !== undefined ? first.value.policyReceipt.receiptDigest : undefined,
			},
		});

		const conflicting = await createMultiAgentDomain({
			...options,
			policySources: {
				...options.policySources,
				workspace: { enabled: true, maxToolCallsPerAgent: 4 },
			},
		});
		expect(conflicting).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(harness.store.replaySessionEvents(harness.sessionId).filter((event) => event.eventType === "policy.effective_recorded")).toHaveLength(1);
	});
});
