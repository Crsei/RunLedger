/**
 * B4：interactive-session / host-domain adapters 验收。
 *
 *   - controller 方法 -> typed workflow 结果；错误编码为 failed 不抛；
 *   - Host Record<string, unknown> 必须经 schema/typed validator 才进 workflow；
 *   - 标签有界 + 终端安全；invalid body 不落地；
 *   - 无端口 = unavailable（端口表聚合语义）。
 */

import { describe, expect, it, vi } from "vitest";
import { createInteractiveSessionAdapter } from "../../../src/tui/adapters/interactive-session.ts";
import { createHostDomainPorts } from "../../../src/tui/adapters/host-domain.ts";
import { capabilitiesFromPorts } from "../../../src/tui/application/ports.ts";
import type { InteractiveSessionControllerPort, ProviderStatus, RuntimeSelection } from "../../../src/runtime/interactive-session-controller.ts";
import type { Model } from "../../../src/types.ts";

const request = { generation: 1, effectId: "effect-1", correlationId: "corr-1", signal: new AbortController().signal, authorityGeneration: 1 };

function fakeController(overrides: Partial<InteractiveSessionControllerPort> = {}): InteractiveSessionControllerPort {
	const statuses: ProviderStatus[] = [
		{ id: "anthropic", name: "Anthropic", configured: true, authTypes: ["api_key"], interactiveAuthTypes: ["api_key"] },
		{ id: "openai", name: "OpenAI", configured: false, authTypes: ["oauth"], interactiveAuthTypes: ["oauth"] },
	];
	return {
		sessionId: "session-1",
		inFlight: false,
		currentSelection: { thinkingLevel: "off" } as RuntimeSelection,
		messages: [],
		warnings: [],
		auditEntries: [],
		toolCount: 3,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: vi.fn(async () => statuses),
		getProvider: () => undefined,
		getAvailableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-x", name: "Claude X", api: {} } as Model<unknown>]),
		login: vi.fn(async () => ({ provider: "anthropic", type: "api_key", key: "k" } as never)),
		logout: vi.fn(async () => undefined),
		selectModel: vi.fn(async () => undefined),
		setThinkingLevel: vi.fn(async (level: never) => level),
		prompt: vi.fn(async () => undefined),
		interrupt: () => undefined,
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: vi.fn(async () => undefined),
		dispose: () => undefined,
		...overrides,
	};
}

describe("B4 interactive-session adapter", () => {
	it("projects provider statuses into a typed bounded catalog", async () => {
		const ports = createInteractiveSessionAdapter(fakeController()).ports;
		const result = await ports.provider!.list(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.providers).toHaveLength(2);
			expect(result.value.providers[0]).toMatchObject({ providerId: "anthropic", status: "ready" });
			expect(result.value.providers[0]!.label.byteLength).toBeLessThanOrEqual(120);
		}
	});

	it("projects model catalog with unknown context window instead of zero", async () => {
		const controller = fakeController({
			getAvailableModels: vi.fn(async () => [{ provider: "anthropic", id: "claude-x", name: "Claude X" } as Model<unknown>]),
		});
		const ports = createInteractiveSessionAdapter(controller).ports;
		const result = await ports.model!.list({ ...request, providerId: "anthropic" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.models[0]).toMatchObject({ modelId: "claude-x" });
			expect(result.value.models[0]!.contextWindow.state).toBe("unknown");
		}
	});

	it("encodes controller errors as failed envelopes, never throws", async () => {
		const controller = fakeController({ getProviderStatuses: vi.fn(async () => { throw new Error("boom"); }) });
		const ports = createInteractiveSessionAdapter(controller).ports;
		const result = await ports.provider!.list(request);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("controller_error");
	});

	it("absent controller yields empty ports (capability unavailable)", () => {
		const ports = createInteractiveSessionAdapter(undefined).ports;
		expect(ports.provider).toBeUndefined();
		const capabilities = capabilitiesFromPorts(ports, { sessionCatalog: false });
		expect(capabilities.provider.state).toBe("unavailable");
	});

	it("B5 mutations are explicitly not implemented here", async () => {
		const ports = createInteractiveSessionAdapter(fakeController()).ports;
		const selection = await ports.provider!.select({ ...request, providerId: "anthropic", modelId: "claude-x" });
		expect(selection.ok).toBe(false);
		if (!selection.ok) expect(selection.error.code).toBe("not_supported");
	});

	it("P1-3: local queue port exposes real controller queue facts", async () => {
		const steering = { role: "user" as const, content: [{ type: "text" as const, text: "steer me" }] };
		const controller = fakeController({
			getSteeringMessages: () => [steering] as never,
			getFollowUpMessages: () => [],
		});
		const ports = createInteractiveSessionAdapter(controller).ports;
		const inspect = await ports.queue!.inspect(request);
		expect(inspect.ok).toBe(true);
		if (inspect.ok) {
			expect(inspect.value.pendingCount).toEqual({ state: "known", value: 1 });
			expect(inspect.value.items).toHaveLength(1);
			expect(inspect.value.items[0]).toMatchObject({ state: "pending" });
		}
		const cancel = await ports.queue!.cancel({
			...request,
			item: { itemId: "queue-0", sessionId: "session-1", state: "pending", digestPrefix: { text: "d", truncated: false, byteLength: 1 }, label: { text: "l", truncated: false, byteLength: 1 }, queueRevision: 0 },
			reason: { text: "user", truncated: false, byteLength: 4 },
		});
		expect(cancel.ok).toBe(true);
		if (cancel.ok) expect(cancel.value.outcome).toBe("already-terminal"); // clearAllQueues 后已空
	});

	it("P1-3: local shutdown port accepts intent with trigger", async () => {
		const ports = createInteractiveSessionAdapter(fakeController()).ports;
		const result = await ports.shutdown!.request({ ...request, trigger: "user" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toMatchObject({ trigger: "user", outcome: "accepted" });
	});
});

describe("B4 host-domain adapter", () => {
	const extensionSnapshot = (descriptors: unknown[]) => ({ ok: true, snapshot: { snapshotId: "s1", generation: 3, digest: "d", descriptors } });

	it("validates extension bodies into typed bounded resources", async () => {
		const query = vi.fn(async () => extensionSnapshot([
			{ kind: "plugin", identity: { qualifiedId: "plugin:a", version: "1.0.0", digest: { algorithm: "sha256", digest: "dd" } }, displayName: "A", enabled: true, trusted: true, ready: true },
			{ kind: "plugin", identity: { qualifiedId: "plugin:b" }, enabled: true, trusted: false, ready: false },
		]));
		const ports = createHostDomainPorts({ query });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.resources).toHaveLength(2);
			expect(result.value.resources[0]).toMatchObject({ resourceId: "plugin:a", kind: "plugin", trust: "trusted", activation: "ready" });
			expect(result.value.resources[1]).toMatchObject({ trust: "untrusted", activation: "disabled" });
		}
		expect(query).toHaveBeenCalledWith("extension.inspect", {});
	});

	it("drops invalid descriptors; empty result stays typed", async () => {
		const query = vi.fn(async () => extensionSnapshot(["garbage", null, { identity: { qualifiedId: "" } }]));
		const ports = createHostDomainPorts({ query });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.resources).toEqual([]);
	});

	it("host rejection is a typed failed envelope", async () => {
		const query = vi.fn(async () => ({ ok: false, code: "extension_snapshot_unavailable" }));
		const ports = createHostDomainPorts({ query });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("extension_snapshot_unavailable");
	});

	it("raw Host response never enters the workflow without validation", async () => {
		const query = vi.fn(async () => ({ ok: true, snapshot: "not-an-object", descriptors: "nope" }));
		const ports = createHostDomainPorts({ query });
		const result = await ports.runtimeSnapshot!.getSnapshot(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			// 非结构化字段一律 unknown，不把 raw 值带进 state
			expect(result.value.sourceRevision.state).toBe("unknown");
			expect(result.value.authorityGeneration).toBe(0);
		}
	});

	it("no Host channel means the ports are undefined (unavailable)", () => {
		expect(createHostDomainPorts(undefined).extensions).toBeUndefined();
		expect(createHostDomainPorts({}).extensions).toBeUndefined();
	});

	it("P2-1: invalid enum values never cast into the contracts", async () => {
		const query = vi.fn(async () => ({
			ok: true,
			processes: [{ executionId: "execution_1", attemptId: "attempt_1", state: "not-a-real-state" }],
			state: { status: "definitely-not-a-status", revision: 3 },
			agents: [{ agentId: "agent-1", residency: "elsewhere", progress: 5 }],
			channel: "stable",
			releasePrefix: "release-1-2-3",
			message: "update available",
			policy: "aggressive-download",
		}));
		const ports = createHostDomainPorts({ query });
		const processResult = await ports.process!.list(request);
		expect(processResult.ok).toBe(true);
		if (processResult.ok) expect(processResult.value[0]!.state).toBe("uncertain");
		const planResult = await ports.plan!.inspect({ ...request, planId: "plan-1", expectedRevision: 0 });
		expect(planResult.ok).toBe(true);
		if (planResult.ok) expect(planResult.value.status).toBe("unknown");
		const agentResult = await ports.agents!.inspect(request);
		expect(agentResult.ok).toBe(true);
		if (agentResult.ok) expect(agentResult.value.agents[0]!.residency).toBe("unknown");
		const updateResult = await ports.update!.inspect(request);
		expect(updateResult.ok).toBe(true);
		if (updateResult.ok) expect(updateResult.value.policy).toBe("unknown");
	});

	it("P2-1: malformed runtime snapshot fields are unknown, never raw values", async () => {
		const query = vi.fn(async () => ({
			ok: true,
			runtime: {
				authorityGeneration: 5,
				sourceRevision: "not-an-object",
				session: { sessionId: "s-1", lifecycle: "active" },
				activity: { phase: "working", turn: "not-a-number" },
				queue: { steering: 1 },
			},
		}));
		const ports = createHostDomainPorts({ query });
		const result = await ports.runtimeSnapshot!.getSnapshot(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.sourceRevision.state).toBe("unknown");
			expect(result.value.activity.state).toBe("unknown");
			expect(result.value.session.state).toBe("known");
			expect(result.value.authorityGeneration).toBe(5);
		}
	});

	it("P1-4: task-goal inspects real Host tasks/goals instead of hardcoding empty", async () => {
		const query = vi.fn(async () => ({
			ok: true,
			repository: {
				repositoryId: "repo-1",
				repositoryRevision: 7,
				tasks: [
					{ taskId: "task-1", content: "write tests", priority: "high", status: "in_progress", revision: 2 },
					{ taskId: "task-2", content: "nope", priority: "urgent", status: "bogus", revision: 1 },
					"garbage",
				],
				goals: [{ goalId: "goal-1", label: "ship it", lifecycle: "active", repositoryRevision: 7, digestPrefix: "abc" }],
			},
		}));
		const ports = createHostDomainPorts({ query });
		const result = await ports.taskGoal!.inspect(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.repositoryRevision).toBe(7);
			expect(result.value.tasks).toHaveLength(2);
			expect(result.value.tasks[0]).toMatchObject({ taskId: "task-1", status: "in_progress" });
			// 非法枚举落缺省、非对象丢弃
			expect(result.value.tasks[1]).toMatchObject({ taskId: "task-2", priority: "medium", status: "pending" });
			expect(result.value.goals).toHaveLength(1);
		}
	});

	it("P1-3: Host security mutation is explicitly unavailable, not a stub", async () => {
		const query = vi.fn(async () => ({ ok: true, mode: "guarded", modeRevision: 3 }));
		const ports = createHostDomainPorts({ query });
		const result = await ports.securityMode!.set({ ...request, target: "unrestricted", expectedRevision: { state: "known", value: 3 } });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("host_operation_unsupported");
	});
});
