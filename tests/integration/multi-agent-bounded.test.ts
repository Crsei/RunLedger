import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, createProvider, type Provider } from "../../src/models.ts";
import type { ProviderStreams, Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions, ToolCall } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { buildRunledgerLayout, workspaceStorageKey } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { loadLayeredProjectSettings, loadProjectSettings, saveProjectSettings } from "../../src/storage/settings-manager.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";
import { createEmbeddedSessionRuntime } from "../../src/cli/embedded-session-runtime.ts";
import { makeToolContext } from "../../src/runtime/tool-context.ts";
import type { SessionDomainPort } from "../../src/runtime/session-runtime/session-runtime.ts";
import { mockModel } from "../../src/runtime/providers/mock-stream.ts";
import { createInProcessChildRuntimeProvider, type ChildRuntimeProviderPort } from "../../src/runtime/agents/child-runtime.ts";
import type { SessionDomainCompositionOptions } from "../../src/runtime/session-runtime/domain.ts";

const noPromptTestSecurity = [{

	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

let cleanup: (() => void) | undefined;

afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function workspacePolicyKey(workspaceId: string, repositoryId: string): string {
	return workspaceStorageKey({
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId: createRuntimeId("workspace", workspaceId),
		repositoryId: createRuntimeId("repository", repositoryId),
	});
}

function deterministicProvider(): ReturnType<typeof createProvider> {
	const streams: ProviderStreams = {
		stream: (model, context, options) => deterministicStream(model, context, options),
		streamSimple: (model, context, options) => deterministicStream(model, context, options),
	};
	return createProvider({
		id: mockModel.provider,
		name: "Deterministic integration model",
		auth: {
			apiKey: {
				name: "integration fixture",
				resolve: async () => ({ auth: { apiKey: "integration-only" }, source: "integration fixture" }),
			},
		},
		models: [mockModel],
		api: streams,
	});
}

function deterministicStream(model: Model<Api>, context: Context, options?: StreamOptions | SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const toolResults = context.messages.filter((message) => message.role === "toolResult");
	const toolCall = nextToolCall(toolResults.length);
	const signal = options?.signal;
	const base = assistant(model, []);
	queueMicrotask(() => {
		if (signal?.aborted) {
			const aborted = { ...base, stopReason: "aborted" as const, errorMessage: "aborted" };
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}
		stream.push({ type: "start", partial: base });
		if (toolCall !== undefined) {
			const partial = assistant(model, [toolCall]);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial });
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
			const finalMessage = { ...partial, stopReason: "toolUse" as const };
			stream.push({ type: "done", reason: "toolUse", message: finalMessage });
			stream.end(finalMessage);
			return;
		}
		const report = toolResults
			.flatMap((message) => message.content)
			.map((content) => content.type === "text" ? content.text : "")
			.join("\n");
		const finalMessage = assistant(model, [{ type: "text", text: `bounded report\n${report}` }]);
		stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
		stream.push({ type: "text_delta", contentIndex: 0, delta: finalMessage.content[0]?.type === "text" ? finalMessage.content[0].text : "", partial: finalMessage });
		stream.push({ type: "text_end", contentIndex: 0, content: finalMessage.content[0]?.type === "text" ? finalMessage.content[0].text : "", partial: finalMessage });
		stream.push({ type: "done", reason: "stop", message: finalMessage });
		stream.end(finalMessage);
	});
	return stream;
}

function nextToolCall(toolResultCount: number): ToolCall | undefined {
	if (toolResultCount === 0) return { type: "toolCall", id: "integration-read", name: "read", arguments: { path: "fixture.txt", lineNumbers: false } };
	if (toolResultCount === 1) return { type: "toolCall", id: "integration-write-denied", name: "write", arguments: { path: "should-not-exist.txt", content: "must not be written" } };
	if (toolResultCount === 2) return { type: "toolCall", id: "integration-grep", name: "grep", arguments: { pattern: "needle", path: "fixture.txt", literal: true } };
	return undefined;
}

function assistant(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/**
 * 父 Session 首轮就发 `spawn_agent` 的 provider:同一 provider 也服务 child,
 * 因此以"当前请求是否暴露 spawn_agent"区分父/子,而不是靠调用次数。
 */
function spawnProbeProvider(): Provider {
	const streams: ProviderStreams = {
		stream: (model, context, options) => spawnProbeStream(model, context, options),
		streamSimple: (model, context, options) => spawnProbeStream(model, context, options),
	};
	return createProvider({
		id: mockModel.provider,
		name: "Spawn probe integration model",
		auth: {
			apiKey: {
				name: "integration fixture",
				resolve: async () => ({ auth: { apiKey: "integration-only" }, source: "integration fixture" }),
			},
		},
		// mockModel 的 8k context 装不下 standard Session 的完整工具面与受保护上下文片段,
		// 会在 assemble 阶段抛 required_fragment_exceeds_budget;本用例只验证 admission。
		models: [{ ...mockModel, contextWindow: 200_000 }],
		api: streams,
	});
}

function spawnProbeStream(model: Model<Api>, context: Context, options?: StreamOptions | SimpleStreamOptions) {
	const parentExposesSpawn = context.tools?.some((tool) => tool.name === "spawn_agent") === true;
	const spawnCall: ToolCall = {
		type: "toolCall",
		id: "integration-spawn",
		name: "spawn_agent",
		arguments: {
			role: "research",
			objective: "Read fixture.txt and report the evidence.",
			requestedCapabilities: ["workspace.read"],
			budget: { maxModelTurns: 8, maxToolCalls: 4, maxActiveDurationMs: 20_000 },
			output: { kind: "report", maxBytes: 4_096 },
		},
	};
	const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
	const probe = parentExposesSpawn && toolResultCount === 0;
	return probe ? streamOneToolCall(model, options, spawnCall) : deterministicStream(model, context, options);
}

/**
 * 父 Session 发 `spawn_agent`;child 自己的模型请求挂起直到被 abort。
 * 用于在 child 仍处于 running 时驱动真实的 `agent.cancel`。
 */
function hangingChildProvider(): Provider {
	const streams: ProviderStreams = {
		stream: (model, context, options) => hangingChildStream(model, context, options),
		streamSimple: (model, context, options) => hangingChildStream(model, context, options),
	};
	return createProvider({
		id: mockModel.provider,
		name: "Hanging child integration model",
		auth: {
			apiKey: {
				name: "integration fixture",
				resolve: async () => ({ auth: { apiKey: "integration-only" }, source: "integration fixture" }),
			},
		},
		models: [{ ...mockModel, contextWindow: 200_000 }],
		api: streams,
	});
}

function hangingChildStream(model: Model<Api>, context: Context, options?: StreamOptions | SimpleStreamOptions) {
	const parentExposesSpawn = context.tools?.some((tool) => tool.name === "spawn_agent") === true;
	const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
	if (parentExposesSpawn && toolResultCount === 0) {
		return streamOneToolCall(model, options, {
			type: "toolCall",
			id: "integration-cancel-spawn",
			name: "spawn_agent",
			arguments: {
				role: "research",
				objective: "Read fixture.txt and report the evidence.",
				requestedCapabilities: ["workspace.read"],
				budget: { maxModelTurns: 8, maxToolCalls: 4, maxActiveDurationMs: 60_000 },
				output: { kind: "report", maxBytes: 4_096 },
			},
		});
	}
	// 拿到 stopped report 之后父 turn 必须能正常收束,否则用例无法区分
	// "cancel 结束 child" 与 "父 turn 一起挂死"。
	if (parentExposesSpawn) return streamFinalText(model, "parent observed the child stop");
	// child 侧:永不 settle 的 stream,只响应 abort。cancel 必须由 owner 侧收束,
	// 不能依赖模型自己结束。
	const stream = createAssistantMessageEventStream();
	const signal = options?.signal;
	const onAbort = (): void => {
		const message = assistant(model, []);
		stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" as const, errorMessage: "aborted" } });
		stream.end({ ...message, stopReason: "aborted" as const });
	};
	if (signal?.aborted) queueMicrotask(onAbort);
	else signal?.addEventListener("abort", onAbort, { once: true });
	return stream;
}

function streamFinalText(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const base = assistant(model, []);
	const message = { ...assistant(model, [{ type: "text" as const, text }]), stopReason: "stop" as const };
	queueMicrotask(() => {
		stream.push({ type: "start", partial: base });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function streamOneToolCall(model: Model<Api>, options: StreamOptions | SimpleStreamOptions | undefined, toolCall: ToolCall) {
	const stream = createAssistantMessageEventStream();
	const base = assistant(model, []);
	const signal = options?.signal;
	queueMicrotask(() => {
		if (signal?.aborted) {
			const aborted = { ...base, stopReason: "aborted" as const, errorMessage: "aborted" };
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}
		stream.push({ type: "start", partial: base });
		const partial = assistant(model, [toolCall]);
		stream.push({ type: "toolcall_start", contentIndex: 0, partial });
		stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(toolCall.arguments), partial });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
		const finalMessage = { ...partial, stopReason: "toolUse" as const };
		stream.push({ type: "done", reason: "toolUse", message: finalMessage });
		stream.end(finalMessage);
	});
	return stream;
}

describe("bounded multi-agent production integration", () => {
	it("runs a real child Agent through governed read/search and returns one parent tool report", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-bounded-integration-"));
		cleanup = () => rmSync(root, { recursive: true, force: true });
		writeFileSync(join(root, "fixture.txt"), "needle in the governed fixture\n", "utf8");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const workspaceId = "bounded-integration";
		const workspaceKey = workspacePolicyKey(workspaceId, workspaceId);
		await saveProjectSettings({ layout }, { provider: mockModel.provider, model: mockModel.id, multiAgent: { enabled: true } });
		await saveProjectSettings({ layout, workspaceKey }, { multiAgent: { enabled: true } });
		const sessionId = createRuntimeId("session", "bounded-integration");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", workspaceId),
			repositoryId: createRuntimeId("repository", workspaceId),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "i".repeat(64),
		});
		const models = createModels({ credentials: AuthStorage.create(layout) });
		models.setProvider(deterministicProvider());
		const settings = await loadProjectSettings({ layout });
		const layered = await loadLayeredProjectSettings({ layout, workspaceKey });
		const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid" ? layer.multiAgent.value : undefined;
		let providerPrepareCalls = 0;
		const baseProvider = createInProcessChildRuntimeProvider();
		const childRuntimeProvider: ChildRuntimeProviderPort = {
			providerId: "in_process",
			prepare: async (spec) => {
				providerPrepareCalls += 1;
				return baseProvider.prepare(spec);
			},
		};
		const compositionDomain: SessionDomainCompositionOptions = {
			cwd: root,
			layout,
			settings,
			models,
			securitySources: noPromptTestSecurity,
			multiAgent: { runtimeEnabled: true, user: source(layered.user), workspace: source(layered.workspace) },
			multiAgentChildRuntimeProvider: childRuntimeProvider,
		};
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: compositionDomain,
			});
			const runtime = embedded.runtime;
			expect(runtime).toBeDefined();
			if (runtime === undefined) throw new Error("runtime was not claimed");
			const domain = (runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const childTool = domain?.multiAgent?.tools.find((tool) => tool.name === "spawn_agent");
			expect(childTool).toBeDefined();
			if (childTool === undefined || domain?.childRuntime === undefined) throw new Error("production child tool was not composed");
			expect(domain.childRuntime.productionToolSource.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write", "bash", "grep", "glob", "ls", "todo"]));
			expect((childTool.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("parentAgentId");
			expect((childTool.parameters as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("providerId");
			const spawnInput = {
				role: "research" as const,
				objective: "Read fixture.txt, search for needle, and report the evidence.",
				requestedCapabilities: ["workspace.read" as const, "workspace.search" as const],
				budget: { maxModelTurns: 6, maxToolCalls: 4, maxActiveDurationMs: 30_000 },
				output: { kind: "report" as const, maxBytes: 8_192 },
			};
			const result = await childTool.execute(
				"tool-integration-spawn",
				spawnInput,
				new AbortController().signal,
				undefined,
				makeToolContext({
					cwd: domain.childRuntime.productionToolSource.cwd,
					env: domain.childRuntime.productionToolSource.executionEnv,
					signal: new AbortController().signal,
					sessionId,
					toolCallId: "tool-integration-spawn",
				}),
			);
			expect(result.isError).not.toBe(true);
			expect(providerPrepareCalls).toBe(1);
			expect(result.details).toMatchObject({ report: { outcome: "completed" } });
			const report = (result.details as { report: { report: string } }).report.report;
			expect(report).toContain("needle in the governed fixture");
			expect(report).toContain("1:needle in the governed fixture");
			expect(readFileSync(join(root, "fixture.txt"), "utf8")).toBe("needle in the governed fixture\n");
			expect(() => readFileSync(join(root, "should-not-exist.txt"), "utf8")).toThrow();
			const duplicate = await childTool.execute(
				"tool-integration-spawn",
				spawnInput,
				new AbortController().signal,
				undefined,
				makeToolContext({
					cwd: domain.childRuntime.productionToolSource.cwd,
					env: domain.childRuntime.productionToolSource.executionEnv,
					signal: new AbortController().signal,
					sessionId,
					toolCallId: "tool-integration-spawn",
				}),
			);
			expect(JSON.stringify(duplicate.details)).toBe(JSON.stringify(result.details));
			const inspect = await runtime.handleQuery({
				kind: "domain_query",
				body: {
					sessionId,
					generation: embedded.handle.generation,
					correlationId: "integration-inspect",
					effectId: "integration-inspect-effect",
					operation: "agent.inspect",
					payload: {},
				},
			});
			expect(JSON.parse(JSON.stringify(inspect))).toEqual(inspect);
			expect(store.replaySessionEvents(sessionId)
				.filter((event) => event.eventType.startsWith("agent."))
				.map((event) => event.eventType)).toEqual([
				"agent.root_registered",
				"agent.spawn_requested",
				"agent.spawned",
				"agent.activated",
				"agent.finished",
			]);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
		}
	});

	it("cancels a running child through the production domain and commits one durable stopped terminal", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-bounded-cancel-"));
		cleanup = () => rmSync(root, { recursive: true, force: true });
		writeFileSync(join(root, "fixture.txt"), "needle in the governed fixture\n", "utf8");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const workspaceId = "bounded-cancel";
		const workspaceKey = workspacePolicyKey(workspaceId, workspaceId);
		await saveProjectSettings({ layout }, { provider: mockModel.provider, model: mockModel.id, multiAgent: { enabled: true } });
		await saveProjectSettings({ layout, workspaceKey }, { multiAgent: { enabled: true } });
		const sessionId = createRuntimeId("session", "bounded-cancel");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", workspaceId),
			repositoryId: createRuntimeId("repository", workspaceId),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "c".repeat(64),
		});
		const models = createModels({ credentials: AuthStorage.create(layout) });
		models.setProvider(hangingChildProvider());
		const settings = await loadProjectSettings({ layout });
		const layered = await loadLayeredProjectSettings({ layout, workspaceKey });
		const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid" ? layer.multiAgent.value : undefined;
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					models,
					securitySources: noPromptTestSecurity,
					multiAgent: { runtimeEnabled: true, user: source(layered.user), workspace: source(layered.workspace) },
				},
			});
			const runtime = embedded.runtime;
			if (runtime === undefined) throw new Error("production runtime was not claimed");
			const domain = (runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			if (domain === undefined) throw new Error("production Session domain was not composed");
			const generation = embedded.handle.generation;
			const inspectGraph = async (): Promise<{ readonly revision: number; readonly counts: { readonly nonTerminalChildren: number; readonly totalAgents: number }; readonly nodes: readonly { readonly agentId: string; readonly role: string; readonly state: string }[] }> => {
				const inspected = await runtime.handleQuery({
					kind: "domain_query",
					body: { sessionId, generation, correlationId: createRuntimeId("connection", "cancel-inspect"), effectId: "cancel-inspect-effect", operation: "agent.inspect", payload: {} },
				});
				// handleQuery 直接返回 SessionDomainResult；handleCommand 才包一层 { ok, kind, result }。
				if (inspected.ok !== true) throw new Error(`agent.inspect failed: ${String(inspected.code)}`);
				return inspected.value as never;
			};

			// 父 turn 会阻塞在 spawn_agent 上;不 await,先等 child 进入 running。
			const parentTurn = domain.controller.prompt("spawn a scout to read the fixture");
			let running: Awaited<ReturnType<typeof inspectGraph>> | undefined;
			for (let attempt = 0; attempt < 400; attempt += 1) {
				const inspected = await inspectGraph();
				if (inspected.counts.nonTerminalChildren === 1 && inspected.nodes.some((node) => node.state === "running")) {
					running = inspected;
					break;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			}
			if (running === undefined) throw new Error("child never reached running");
			const child = running.nodes.find((node) => node.role === "research");
			if (child === undefined) throw new Error("child node was not projected");

			const cancelled = await runtime.handleCommand({
				commandId: createRuntimeId("command", "cancel-running-child"),
				kind: "domain_command",
				body: { sessionId, generation, correlationId: "corr-cancel", effectId: "effect-cancel", operation: "agent.cancel", expectedRevision: running.revision, payload: { agentId: child.agentId } },
			}, { connectionId: createRuntimeId("connection", "driver"), clientId: "client_driver", isDriver: true });
			expect(JSON.parse(JSON.stringify(cancelled))).toEqual(cancelled);
			expect(cancelled).toMatchObject({ ok: true, result: { ok: true, status: "ok", value: { report: { outcome: "stopped", reasonCode: "cancelled" } } } });

			const settled = await inspectGraph();
			expect(settled.counts.nonTerminalChildren).toBe(0);
			expect(settled.nodes.find((node) => node.agentId === child.agentId)).toMatchObject({ state: "stopped", reasonCode: "cancelled" });
			// 父 turn 以 stopped 报告收束,而不是挂死或重跑 child。
			await parentTurn;
			const terminalEvents = store.replaySessionEvents(sessionId).filter((event) => event.eventType === "agent.stopped");
			expect(terminalEvents).toHaveLength(1);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
		}
	});

	it("admits a model-issued spawn_agent call through the governed Session tool gate", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-bounded-admission-"));
		cleanup = () => rmSync(root, { recursive: true, force: true });
		writeFileSync(join(root, "fixture.txt"), "needle in the governed fixture\n", "utf8");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const workspaceId = "bounded-admission";
		const workspaceKey = workspacePolicyKey(workspaceId, workspaceId);
		await saveProjectSettings({ layout }, { provider: mockModel.provider, model: mockModel.id, multiAgent: { enabled: true } });
		await saveProjectSettings({ layout, workspaceKey }, { multiAgent: { enabled: true } });
		const sessionId = createRuntimeId("session", "bounded-admission");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", workspaceId),
			repositoryId: createRuntimeId("repository", workspaceId),
			harnessProfile: standardHarnessProfileRef(),
			settingsDigest: "a".repeat(64),
		});
		const models = createModels({ credentials: AuthStorage.create(layout) });
		models.setProvider(spawnProbeProvider());
		const settings = await loadProjectSettings({ layout });
		const layered = await loadLayeredProjectSettings({ layout, workspaceKey });
		const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid" ? layer.multiAgent.value : undefined;
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					models,
					securitySources: noPromptTestSecurity,
					multiAgent: { runtimeEnabled: true, user: source(layered.user), workspace: source(layered.workspace) },
				},
			});
			const runtime = embedded.runtime;
			if (runtime === undefined) throw new Error("production runtime was not claimed");
			const domain = (runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			if (domain === undefined) throw new Error("production Session domain was not composed");
			expect(domain.multiAgent?.tools.map((tool) => tool.name)).toEqual(["spawn_agent"]);
			// 走完整 Session 链路:controller 的 beforeToolCall → governed 门禁 →
			// spawn_agent.execute。名单式门禁会在这里静默拒绝,模型只看到 tool_admission_denied。
			await domain.controller.prompt("spawn a scout to read the fixture");
			const results = domain.snapshot().messages
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.content)
				.filter((content) => content.toolName === "spawn_agent");
			expect(results).toHaveLength(1);
			expect(results[0]!.isError).not.toBe(true);
			expect(JSON.stringify(results[0]!.details)).toContain("completed");
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
		}
	});
});
