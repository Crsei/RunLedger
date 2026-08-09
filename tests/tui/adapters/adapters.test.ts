/**
 * B4：interactive-session / Session resource adapters 验收。
 *
 *   - controller 方法 -> typed workflow 结果；错误编码为 failed 不抛；
 *   - Host Record<string, unknown> 必须经 schema/typed validator 才进 workflow；
 *   - 标签有界 + 终端安全；invalid body 不落地；
 *   - 无端口 = unavailable（端口表聚合语义）。
 */

import { describe, expect, it, vi } from "vitest";
import { createInteractiveSessionAdapter } from "../../../src/tui/adapters/interactive-session.ts";
import { createSessionResourcePorts } from "../../../src/tui/adapters/session-resources.ts";
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
		supports: () => true,
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

	it("local transient queues are not exposed as a durable queue capability", () => {
		const clearAllQueues = vi.fn(() => ({ steering: [], followUp: [] }));
		const controller = fakeController({ clearAllQueues });
		const ports = createInteractiveSessionAdapter(controller).ports;
		expect(ports.queue).toBeUndefined();
		expect(capabilitiesFromPorts(ports, { sessionCatalog: true }).queue).toMatchObject({ state: "unavailable" });
		expect(clearAllQueues).not.toHaveBeenCalled();
	});

	it("keeps shutdown unavailable when no lifecycle operation was negotiated", () => {
		const ports = createInteractiveSessionAdapter(fakeController()).ports;
		expect(ports.shutdown).toBeUndefined();
	});
});

describe("B4 Session resource adapter", () => {
	const extensionSnapshot = (descriptors: unknown[]) => ({ ok: true, snapshot: { snapshotId: "s1", generation: 3, digest: "d", descriptors } });

	it("validates extension bodies into typed bounded resources", async () => {
		const query = vi.fn(async () => extensionSnapshot([
			{ kind: "plugin", identity: { qualifiedId: "plugin:a", version: "1.0.0", digest: { algorithm: "sha256", digest: "dd" } }, displayName: "A", enabled: true, trusted: true, ready: true },
			{ kind: "plugin", identity: { qualifiedId: "plugin:b" }, enabled: true, trusted: false, ready: false },
		]));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.resources).toHaveLength(2);
			expect(result.value.resources[0]).toMatchObject({ resourceId: "plugin:a", kind: "plugin", trust: "trusted", activation: "ready" });
			expect(result.value.resources[1]).toMatchObject({ trust: "untrusted", activation: "disabled" });
		}
		expect(query).toHaveBeenCalledWith("extension.inspect", {}, expect.objectContaining({ correlationId: "corr-1", effectId: "effect-1" }));
	});

	it("drops invalid descriptors; empty result stays typed", async () => {
		const query = vi.fn(async () => extensionSnapshot(["garbage", null, { identity: { qualifiedId: "" } }]));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.resources).toEqual([]);
	});

	it("host rejection is a typed failed envelope", async () => {
		const query = vi.fn(async () => ({ ok: false, code: "extension_snapshot_unavailable" }));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const result = await ports.extensions!.inspect(request);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("extension_snapshot_unavailable");
	});

	it("only creates ports backed by real Host operations", () => {
		const query = vi.fn(async () => ({ ok: true }));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		expect(ports.extensions).toBeDefined();
		expect(ports.plan).toBeDefined();
		expect(ports.securityMode).toBeDefined();
		expect(ports.workspaceGit).toBeDefined();
		expect(ports.runtimeSnapshot).toBeUndefined();
		expect(ports.taskGoal).toBeUndefined();
		expect(ports.agents).toBeUndefined();
		expect(ports.update).toBeUndefined();
		expect(ports.process).toBeUndefined();
	});

	it("creates each domain port only when its exact operation was negotiated", () => {
		const query = vi.fn(async () => ({ ok: true }));
		const ports = createSessionResourcePorts({
			query,
			supports: (operation) => operation === "session.security.inspect",
		});
		expect(ports.securityMode).toBeDefined();
		expect(ports.extensions).toBeUndefined();
		expect(ports.plan).toBeUndefined();
		expect(ports.workspaceGit).toBeUndefined();
	});

	it("no Host channel means the ports are undefined (unavailable)", () => {
		expect(createSessionResourcePorts(undefined).extensions).toBeUndefined();
		expect(createSessionResourcePorts({}).extensions).toBeUndefined();
	});

	it("P2-1: invalid plan enum values never cast into the contracts", async () => {
		const query = vi.fn(async () => ({
			ok: true,
			state: { status: "definitely-not-a-status", revision: 3 },
		}));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const planResult = await ports.plan!.inspect({
			...request,
			reference: { repositoryId: "repo-1", planId: "plan-1", revision: 0, digestPrefix: { text: "", truncated: false, byteLength: 0 } },
		});
		expect(planResult.ok).toBe(true);
		if (planResult.ok) expect(planResult.value.status).toBe("unknown");
	});

	it("maps security to the canonical Session read operation without exposing a mutation", async () => {
		const query = vi.fn(async (operation: string) => operation === "session.security.inspect"
			? { ok: true, profile: "danger-full-access", ownerGeneration: 7 }
			: { ok: true, binding: { workspaceId: "workspace-1", headCommit: "abcdef123456", leaseRevision: 4 } });
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const security = await ports.securityMode!.inspect(request);
		const workspace = await ports.workspaceGit!.inspect({ ...request, workspaceId: "workspace-1" });
		expect(security.ok && security.value).toMatchObject({ authorityGeneration: 7, mode: { state: "known", value: "unrestricted" } });
		expect(workspace.ok && workspace.value).toMatchObject({ workspaceId: "workspace-1", observedRevision: 4, head: { kind: "detached" } });
		expect(query.mock.calls.map(([operation]) => operation)).toEqual(["session.security.inspect", "worktree.inspect"]);
	});

	it("P1-3: Host security mutation is explicitly unavailable, not a stub", async () => {
		const query = vi.fn(async () => ({ ok: true, profile: "workspace-write" }));
		const ports = createSessionResourcePorts({ query, supports: () => true });
		const result = await ports.securityMode!.set({ ...request, target: "unrestricted", expectedRevision: { state: "known", value: 3 } });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("session_operation_unsupported");
		expect(query).not.toHaveBeenCalled();
	});
});
