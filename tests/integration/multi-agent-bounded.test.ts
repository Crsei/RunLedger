import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, createProvider, type ProviderStreams } from "../../src/models.ts";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, StreamOptions, ToolCall } from "../../src/types.ts";
import { createAssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { buildRunledgerLayout, workspaceStorageKey } from "../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { loadLayeredProjectSettings, loadProjectSettings, saveProjectSettings } from "../../src/storage/settings-manager.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
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
			expect(domain.childRuntime.productionToolSource.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["read", "write", "bash", "grep", "find", "glob", "ls"]));
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
});
