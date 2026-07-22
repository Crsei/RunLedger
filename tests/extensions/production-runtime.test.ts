import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { ToolRegistry } from "../../src/runtime/tool-registry.ts";
import type { AgentTool, ToolExecutionGatewayPort, ToolExecutionGatewayRequest } from "../../src/runtime/types.ts";
import { createExtensionResourceIdentity } from "../../src/extensions/identity.ts";
import type { HookDescriptor, HookDispatchResult, HookEnvelope, HookEvent, HookRunOutcome } from "../../src/extensions/hooks/types.ts";
import type {
	ProductionExtensionAuditPort,
	ProductionExtensionHookDispatcherPort,
	ProductionExtensionManagerPort,
	ProductionExtensionManagerSnapshot,
	ProductionExtensionMcpPort,
	ProductionExtensionReloadResult,
} from "../../src/extensions/integration/production-runtime.ts";
import { ProductionExtensionRuntime } from "../../src/extensions/integration/production-runtime.ts";
import type { McpManagerResult } from "../../src/extensions/mcp/connection-manager.ts";
import type { McpNormalizedResult, McpToolDefinition } from "../../src/extensions/mcp/types.ts";
import type { SkillDescriptor } from "../../src/extensions/skills/types.ts";
import { buildExtensionSnapshot } from "../../src/extensions/snapshot.ts";
import { buildResourceManifestDigest } from "../../src/extensions/trust/digest.ts";
import type { ExtensionLifecycleAudit, ExtensionResourceDescriptor } from "../../src/extensions/types.ts";
import { TEST_SCOPE } from "./helpers.ts";

const SESSION_ID = createRuntimeId("session", "extension-production-runtime");
const TOOL_CALL_ID = createRuntimeId("toolCall", "extension-production-runtime");

function resourceDescriptor(kind: "skill" | "hook" | "mcp-tool", qualifiedId: string, runtimeName?: string): ExtensionResourceDescriptor {
	const manifest = buildResourceManifestDigest({
		rootDigest: canonicalDigest(`${qualifiedId}:root`),
		manifestDigest: canonicalDigest(`${qualifiedId}:manifest`),
		capabilityDigest: canonicalDigest(`${qualifiedId}:capability`),
	});
	const identity = createExtensionResourceIdentity({ scope: TEST_SCOPE, kind, qualifiedId, version: "1", source: "project", digest: manifest.combinedDigest });
	return {
		schemaVersion: 1,
		kind,
		identity,
		provenance: { schemaVersion: 1, authorityId: TEST_SCOPE.authorityId, tenantId: TEST_SCOPE.tenantId, source: "project", canonicalLocator: `/fixture/${qualifiedId}` },
		manifest,
		displayName: qualifiedId,
		description: `${kind} fixture`,
		...(runtimeName ? { runtimeName } : {}),
		sourcePath: `/fixture/${qualifiedId}`,
		enabled: true,
		trust: "trusted",
		activation: "ready",
		capabilities: [],
		risk: { level: "low", sideEffect: kind === "mcp-tool" ? "external" : "read", rationaleDigest: canonicalDigest(`${qualifiedId}:risk`) },
		exposure: runtimeName ? "direct" : "deferred",
		diagnostics: [],
		...(runtimeName ? { tool: { inputSchemaJson: canonicalJson({ type: "object", properties: { text: { type: "string" } }, additionalProperties: false }), maxInputBytes: 4_096, resultContentKinds: ["text" as const], execution: { readOnly: true, destructive: false, concurrencySafe: true } } } : {}),
	};
}

function skillDescriptor(): SkillDescriptor {
	const descriptor = resourceDescriptor("skill", "skill:project:fixture");
	return {
		descriptor,
		frontmatter: { name: "fixture", description: "Fixture Skill", userInvocable: true, disableModelInvocation: false, metadata: {} },
		rootPath: "/fixture/skill",
		skillFile: "/fixture/skill/SKILL.md",
		bodyDigest: canonicalDigest("fixture body"),
		resourceSet: {
			schemaVersion: 1,
			authorityId: TEST_SCOPE.authorityId,
			tenantId: TEST_SCOPE.tenantId,
			qualifiedId: descriptor.identity.qualifiedId,
			metadata: { role: "metadata", identity: descriptor.identity, capabilities: [] },
			body: { role: "body", identity: descriptor.identity, capabilities: [] },
		},
		trustBinding: { identity: descriptor.identity, canonicalPath: "/fixture/skill", binding: descriptor.manifest },
	};
}

function hookDescriptor(event: HookEvent): HookDescriptor {
	const descriptor = resourceDescriptor("hook", `hook:project:${event.toLocaleLowerCase()}`);
	return {
		descriptor,
		event,
		failureMode: "closed",
		handlers: [{ type: "command", command: "fixture", args: [], timeoutMs: 1_000, env: {}, commandDigest: canonicalDigest(`command:${event}`) }],
		configPath: `/fixture/${event}.json`,
		configDirectory: "/fixture",
		priority: 100,
		declarationIndex: 0,
	};
}

function hookOutcome(hook: HookDescriptor): HookRunOutcome {
	return {
		hookId: hook.descriptor.identity.qualifiedId,
		event: hook.event,
		status: "allowed",
		decision: "allow",
		failureMode: hook.failureMode,
		reason: "fixture allowed",
		durationMs: 1,
		exitCode: 0,
		stdoutDigest: canonicalDigest("allow"),
		stderrDigest: canonicalDigest(""),
		stdoutPreview: "allow",
		stderrPreview: "",
		inputDigest: canonicalDigest("input"),
	};
}

const PINNED_TOOL: McpToolDefinition = {
	serverId: "mcp-server:project:fixture",
	serverName: "fixture",
	rawName: "echo",
	qualifiedName: "mcp-server:project:fixture:echo",
	runtimeName: "mcp__fixture__echo",
	description: "Echo through fixture MCP",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
	annotations: { readOnly: true, destructive: false, concurrencySafe: true },
	pinned: true,
};

class FakeMcpRuntime implements ProductionExtensionMcpPort {
	readonly #tools: readonly McpToolDefinition[];
	public calls = 0;

	public constructor(tools: readonly McpToolDefinition[] = []) {
		this.#tools = tools;
	}

	public search(query: string, limit = 20): readonly McpToolDefinition[] {
		return this.#tools.filter((tool) => tool.rawName.includes(query) || tool.description.includes(query)).slice(0, limit);
	}

	public async call(): Promise<McpManagerResult<McpNormalizedResult>> {
		this.calls += 1;
		return {
			ok: true,
			value: {
				content: [{ type: "text", text: "fixture", contentDigest: canonicalDigest("fixture") }],
				isError: false,
				originalBytes: 7,
				truncated: false,
				contentDigest: canonicalDigest("fixture-content"),
			},
		};
	}

	public catalog() {
		return {
			list: () => this.#tools,
			pinned: () => this.#tools.filter((tool) => tool.pinned),
		};
	}
}

class FakeHookDispatcher implements ProductionExtensionHookDispatcherPort {
	public readonly events: HookEvent[] = [];
	readonly #handler: (envelope: HookEnvelope, signal?: AbortSignal) => Promise<HookDispatchResult>;

	public constructor(handler?: (envelope: HookEnvelope, signal?: AbortSignal) => Promise<HookDispatchResult>) {
		this.#handler = handler ?? (async (envelope) => ({ decision: "allow", input: envelope.payload.input, inputUpdated: false, outcomes: [] }));
	}

	public async dispatch(envelope: HookEnvelope, signal?: AbortSignal): Promise<HookDispatchResult> {
		this.events.push(envelope.event);
		return this.#handler(envelope, signal);
	}
}

function managerSnapshot(options: {
	generation: number;
	skills?: readonly SkillDescriptor[];
	hooks?: readonly HookDescriptor[];
	dispatcher?: ProductionExtensionHookDispatcherPort;
	mcp?: FakeMcpRuntime;
}): ProductionExtensionManagerSnapshot {
	const skills = options.skills ?? [];
	const hooks = options.hooks ?? [];
	const mcp = options.mcp ?? new FakeMcpRuntime();
	const descriptors = [
		...skills.map((skill) => skill.descriptor),
		...hooks.map((hook) => hook.descriptor),
		...mcp.catalog().list().map((tool) => resourceDescriptor("mcp-tool", `mcp-tool:project:${tool.serverName}:${tool.rawName}`, tool.runtimeName)),
	];
	return {
		snapshot: buildExtensionSnapshot({ generation: options.generation, createdAt: `2026-07-22T00:00:0${options.generation}.000Z`, descriptors, diagnostics: [] }),
		skills,
		hooks,
		skillCatalog: { list: () => skills },
		hookDispatcher: options.dispatcher ?? new FakeHookDispatcher(),
		mcp,
	};
}

class FakeExtensionManager implements ProductionExtensionManagerPort {
	#current?: ProductionExtensionManagerSnapshot;
	#next?: ProductionExtensionManagerSnapshot;
	#activeTurns = 0;
	#pending = false;
	readonly #onClose?: () => void;

	public constructor(current?: ProductionExtensionManagerSnapshot, onClose?: () => void) {
		this.#current = current;
		this.#onClose = onClose;
	}

	public setNext(next: ProductionExtensionManagerSnapshot): void {
		this.#next = next;
	}

	public current(): ProductionExtensionManagerSnapshot | undefined {
		return this.#current;
	}

	public beginTurn(): ProductionExtensionManagerSnapshot {
		if (!this.#current) throw new Error("snapshot unavailable");
		this.#activeTurns += 1;
		return this.#current;
	}

	public async endTurn(): Promise<ProductionExtensionReloadResult | undefined> {
		this.#activeTurns = Math.max(0, this.#activeTurns - 1);
		if (this.#activeTurns === 0 && this.#pending) return this.reload();
		return undefined;
	}

	public requestReload(): ProductionExtensionReloadResult {
		this.#pending = true;
		return { status: "pending", ...(this.#current ? { current: this.#current } : {}) };
	}

	public async reload(): Promise<ProductionExtensionReloadResult> {
		if (this.#activeTurns > 0) {
			this.#pending = true;
			return { status: "pending", ...(this.#current ? { current: this.#current } : {}) };
		}
		if (!this.#next) return { status: "failed", reason: "no candidate", ...(this.#current ? { retained: this.#current } : {}) };
		this.#current = this.#next;
		this.#next = undefined;
		this.#pending = false;
		return { status: "applied", current: this.#current };
	}

	public async close(): Promise<void> {
		this.#onClose?.();
		this.#current = undefined;
	}
}

class RecordingGateway implements ToolExecutionGatewayPort {
	public readonly requests: ToolExecutionGatewayRequest[] = [];

	public async authorize(request: ToolExecutionGatewayRequest) {
		this.requests.push(request);
		return { status: "denied" as const, requestId: createRuntimeId("command", `deny-${this.requests.length}`), reason: "fixture policy denied final input" };
	}

	public async execute(request: Parameters<ToolExecutionGatewayPort["execute"]>[0]) {
		return { status: "unavailable" as const, grantDigest: request.grant.grantDigest, reason: "fixture execution unavailable", outcomeCertain: true as const };
	}
}

function v3Audit(entries: ExtensionLifecycleAudit[]): ProductionExtensionAuditPort {
	return { mode: "v3", appendCanonical: async (entry) => { entries.push(entry); return true; } };
}

function simpleTool(): AgentTool {
	const schema = Type.Object({ path: Type.String() }, { additionalProperties: false });
	return {
		name: "read_fixture",
		label: "Read fixture",
		description: "Fixture tool",
		parameters: schema,
		governedExecution: "tool-context",
		async execute() {
			return { content: [{ type: "text", text: "unused" }], details: {}, terminate: false };
		},
	};
}

describe("ProductionExtensionRuntime", () => {
	it("keeps a turn on one generation, atomically swaps registry tools at idle, and rejects stale handles", async () => {
		const skill = skillDescriptor();
		const firstMcp = new FakeMcpRuntime([PINNED_TOOL]);
		const secondMcp = new FakeMcpRuntime([PINNED_TOOL]);
		const first = managerSnapshot({ generation: 1, skills: [skill], mcp: firstMcp });
		const second = managerSnapshot({ generation: 2, skills: [skill], mcp: secondMcp });
		const manager = new FakeExtensionManager(first);
		manager.setNext(second);
		const registry = new ToolRegistry();
		const audits: ExtensionLifecycleAudit[] = [];
		const runtime = new ProductionExtensionRuntime({
			manager,
			registry,
			gateway: new RecordingGateway(),
			audit: v3Audit(audits),
			sessionId: SESSION_ID,
			cwd: "/workspace",
			createSkillResolver: (snapshot) => ({
				load: async () => ({ ok: true, value: { skillId: snapshot.skills[0]?.descriptor.identity.qualifiedId ?? "missing", body: "fixture body", bodyDigest: canonicalDigest("fixture body"), allowedTools: [], trigger: "model-tool" } }),
			}),
		});
		expect(await runtime.start()).toMatchObject({ status: "ready", generation: 1 });
		expect(registry.list("extensions").map((tool) => tool.name).sort()).toEqual(["McpCall", "McpSearch", "Skill", "mcp__fixture__echo"].sort());
		expect(runtime.catalog()).toMatchObject({ generation: 1, pinnedTools: [{ runtimeName: "mcp__fixture__echo" }] });
		const staleSkill = registry.get("Skill", "extensions");
		if (!staleSkill) throw new Error("Skill tool was not registered");
		expect(runtime.beginTurn()).toMatchObject({ status: "ready", generation: 1 });
		expect(runtime.requestReload()).toMatchObject({ status: "pending", current: { snapshot: { generation: 1 } } });
		expect(await runtime.reload()).toMatchObject({ status: "pending", current: { snapshot: { generation: 1 } } });
		expect(registry.get("Skill", "extensions")).toBe(staleSkill);
		expect(await runtime.endTurn()).toMatchObject({ status: "applied", current: { snapshot: { generation: 2 } } });
		expect(registry.get("Skill", "extensions")).not.toBe(staleSkill);
		expect(runtime.catalog()).toMatchObject({ generation: 2 });
		const staleResult = await staleSkill.execute("stale", { name: "fixture" });
		expect(staleResult).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("stale snapshot generation") }] });
		expect(audits.filter((entry) => entry.kind === "extensions.snapshot/v1")).toHaveLength(2);
		await runtime.close();
	});

	it("validates malicious PreToolUse updatedInput and sends only the final canonical input through the gateway", async () => {
		let update: unknown = { path: "/outside/workspace" };
		const dispatcher = new FakeHookDispatcher(async () => ({ decision: "allow", input: update, inputUpdated: true, outcomes: [] }));
		const manager = new FakeExtensionManager(managerSnapshot({ generation: 1, dispatcher }));
		const gateway = new RecordingGateway();
		const runtime = new ProductionExtensionRuntime({ manager, registry: new ToolRegistry(), gateway, audit: v3Audit([]), sessionId: SESSION_ID, cwd: "/workspace" });
		expect((await runtime.start()).status).toBe("ready");
		const request: ToolExecutionGatewayRequest = {
			toolCallId: TOOL_CALL_ID,
			providerToolCallId: "provider-call-1",
			tool: simpleTool(),
			arguments: { path: "/workspace/safe.txt" },
			cwd: "/workspace",
			envVars: {},
		};
		const denied = await runtime.preToolUse(request);
		expect(denied).toMatchObject({ status: "blocked", reason: "fixture policy denied final input" });
		expect(gateway.requests).toHaveLength(1);
		expect(gateway.requests[0]?.arguments).toEqual({ path: "/outside/workspace" });
		expect(gateway.requests[0]?.arguments).not.toEqual(request.arguments);

		update = { path: "/outside/workspace", injected: true };
		const invalid = await runtime.preToolUse({ ...request, providerToolCallId: "provider-call-2" });
		expect(invalid).toMatchObject({ status: "blocked", reason: expect.stringContaining("failed schema validation") });
		expect(gateway.requests).toHaveLength(1);
		await runtime.close();
	});

	it("dispatches all five hook phases and writes hook outcomes only to the selected canonical audit port", async () => {
		const preHook = hookDescriptor("PreToolUse");
		const dispatcher = new FakeHookDispatcher(async (envelope) => ({
			decision: "allow",
			input: envelope.payload.input,
			inputUpdated: false,
			outcomes: envelope.event === "PreToolUse" ? [hookOutcome(preHook)] : [],
		}));
		const audits: ExtensionLifecycleAudit[] = [];
		const manager = new FakeExtensionManager(managerSnapshot({ generation: 1, hooks: [preHook], dispatcher }));
		const runtime = new ProductionExtensionRuntime({ manager, registry: new ToolRegistry(), gateway: new RecordingGateway(), audit: v3Audit(audits), sessionId: SESSION_ID, cwd: "/workspace" });
		await runtime.start();
		await runtime.sessionStart({ reason: "test" });
		await runtime.userPromptSubmit("hello");
		await runtime.preToolUse({ toolCallId: TOOL_CALL_ID, providerToolCallId: "provider-five-phases", tool: simpleTool(), arguments: { path: "/workspace/a" }, cwd: "/workspace", envVars: {} });
		await runtime.postToolUse({ toolName: "read_fixture", toolInput: { path: "/workspace/a" }, result: "ok", isError: false });
		await runtime.sessionEnd({ reason: "done" });
		expect(dispatcher.events).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"]);
		expect(audits.map((entry) => entry.kind)).toEqual(["extensions.snapshot/v1", "hook.run/v1"]);
		await runtime.close();
	});

	it("shuts down watcher, aborts active hooks, then closes MCP manager, plugin, and hook runtimes in order", async () => {
		const order: string[] = [];
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		const dispatcher = new FakeHookDispatcher(async (envelope, signal) => {
			markStarted?.();
			return new Promise<HookDispatchResult>((resolve) => {
				const finish = () => {
					order.push("hook-aborted");
					resolve({ decision: "allow", input: envelope.payload.input, inputUpdated: false, outcomes: [] });
				};
				if (signal?.aborted) finish();
				else signal?.addEventListener("abort", finish, { once: true });
			});
		});
		const manager = new FakeExtensionManager(managerSnapshot({ generation: 1, dispatcher }), () => order.push("mcp-manager"));
		const runtime = new ProductionExtensionRuntime({
			manager,
			registry: new ToolRegistry(),
			gateway: new RecordingGateway(),
			audit: v3Audit([]),
			sessionId: SESSION_ID,
			cwd: "/workspace",
			watcher: { start: async () => undefined, close: async () => { order.push("watcher"); } },
			pluginRuntime: { close: async () => { order.push("plugin"); } },
			hookRuntime: { close: async () => { order.push("hook-runtime"); } },
		});
		await runtime.start();
		const activeHook = runtime.sessionStart();
		await started;
		await runtime.close();
		await activeHook;
		expect(order).toEqual(["watcher", "hook-aborted", "mcp-manager", "plugin", "hook-runtime"]);
		await runtime.close();
	});
});
