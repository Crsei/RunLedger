import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions, streamSimple as streamSimpleOpenAICompletions } from "../../src/api/openai-completions.ts";
import { createModels, createProvider } from "../../src/models.ts";
import { createCatalogModelRouter } from "../../src/runtime/model-routing/catalog-router.ts";
import { InteractiveSessionController } from "../../src/runtime/interactive-session-controller.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { replaySession } from "../../src/storage/session-codec.ts";
import { loadProjectSettings } from "../../src/storage/settings-manager.ts";
import { JsonlTraceEventStore } from "../../src/runtime/trace/event-store.ts";
import { RuntimeTraceRecorder } from "../../src/runtime/trace/recorder.ts";
import { TrajectoryIndex } from "../../src/runtime/trajectory/index-store.ts";
import { projectSessionEvent, projectTraceEvent } from "../../src/runtime/trajectory/projection.ts";
import type { AgentEvent } from "../../src/runtime/types.ts";
import type { Model } from "../../src/types.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), "runledger-model-switch-test-"));
	const requests: { path: string; auth?: string; body: Record<string, unknown> }[] = [];
	let beforeResponse: (() => Promise<void>) | undefined;
	const server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += String(chunk);
		requests.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
		await beforeResponse?.();
		const first = req.url?.startsWith("/first/");
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
			id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: "shared",
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
		res.write(`data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: `reasoning-${first ? "first" : "second"}` }, null))}\n\n`);
		res.write(`data: ${JSON.stringify(chunk({ content: first ? "reply-first" : "reply-second" }, null))}\n\n`);
		res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing fixture address");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const index = new TrajectoryIndex(join(home, "trajectory-test.db"));
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		index.close();
		await rm(home, { recursive: true, force: true });
	});
	const models = createModels();
	function model(provider: string): Model<"openai-completions"> {
		return {
			id: "shared", name: provider, provider, api: "openai-completions", baseUrl: `${baseUrl}/${provider}/v1`,
			reasoning: true, input: ["text"], contextWindow: 32_768, maxTokens: 1_024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	}
	const first = model("first");
	const second = model("second");
	for (const selected of [first, second]) models.setProvider(createProvider({
		id: selected.provider, models: [selected],
		auth: { apiKey: {
			name: "Fixture key",
			check: async () => ({ type: "api_key", source: "fixture" }),
			resolve: async () => ({ auth: { apiKey: `fixture-${selected.provider}` }, source: "fixture" }),
		} },
		api: { stream: streamOpenAICompletions, streamSimple: streamSimpleOpenAICompletions },
	}));
	const layout = buildRunledgerLayout(home, "posix");
	const ledger = new MemoryLedger({ sessionId: "model-switch-session" });
	const traces: JsonlTraceEventStore[] = [];
	const events: AgentEvent[] = [];
	let sequence = 0;
	const create = async () => {
		const controller = await InteractiveSessionController.create({
			cwd: home, layout, models, ledger, systemPrompt: "fixture", tools: [],
			settings: { provider: first.provider, model: first.id, thinkingLevel: "low" }, replay: await replaySession(ledger),
			modelRequestRouter: createCatalogModelRouter(models),
			traceRecorderFactory: { create: async () => {
				const traceId = `trace_switch_${traces.length}`;
				const eventStore = new JsonlTraceEventStore({ filePath: join(home, `${traceId}.jsonl`), traceId });
				traces.push(eventStore);
				return new RuntimeTraceRecorder({ eventStore, traceId, redactionPolicyDigest: "fixture", mode: "events", failurePolicy: "fail_closed" });
			} },
		});
		controller.subscribe((event) => { events.push(event); projectSessionEvent(index, { ...event }, ++sequence, 1); });
		cleanups.push(async () => { controller.dispose(); });
		return controller;
	};
	return { home, layout, models, first, second, ledger, traces, index, events, requests, create,
		pause: (hook: () => Promise<void>) => { beforeResponse = hook; } };
}

describe("same-session model switching", () => {
	it("budgets the converted history when an old image is omitted for a text-only target", async () => {
		const f = await fixture();
		f.ledger.append({ id: "old-image", sessionId: f.ledger.sessionId, parentId: f.ledger.sessionId, timestamp: 1,
			type: "message", payload: { message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(120_000) }] } } });
		const controller = await f.create();
		await controller.prompt("continue without the image");
		expect(f.requests).toHaveLength(1);
		expect(JSON.stringify(f.requests[0].body)).toContain("image omitted");
		expect(JSON.stringify(f.requests[0].body)).not.toContain("A".repeat(100));
		expect(controller.messages.at(-1)).toMatchObject({ stopReason: "stop", provider: "first" });
	});

	it("converts real adapter requests, preserves replay identities, and records each model in session and trajectory", async () => {
		const f = await fixture();
		const controller = await f.create();
		await controller.prompt("first question");
		const firstMessage = structuredClone(controller.messages.at(-1));
		await controller.selectModel(f.second);
		expect(controller.sessionId).toBe(f.ledger.sessionId);
		expect(controller.currentSelection.thinkingLevel).toBe("low");
		await controller.prompt("continue the same conversation");
		expect(controller.messages[1]).toEqual(firstMessage);
		expect(f.requests.map((request) => [request.path, request.auth])).toEqual([
			["/first/v1/chat/completions", "Bearer fixture-first"],
			["/second/v1/chat/completions", "Bearer fixture-second"],
		]);
		const wireHistory = f.requests[1].body.messages as Record<string, unknown>[];
		const foreignAssistant = wireHistory.find((message) => message.role === "assistant");
		expect(foreignAssistant?.content).toContain("reasoning-first");
		expect(foreignAssistant?.content).toContain("reply-first");
		expect(foreignAssistant).not.toHaveProperty("reasoning_content");
		controller.dispose();
		const resumed = await f.create();
		expect(resumed.currentSelection.model?.provider).toBe("second");
		await resumed.selectModel(f.first);
		await resumed.prompt("back to first");
		const replay = await replaySession(f.ledger);
		expect(replay.messages.filter((message) => message.role === "assistant").map((message) => [message.provider, message.model, message.api])).toEqual([
			["first", "shared", "openai-completions"], ["second", "shared", "openai-completions"], ["first", "shared", "openai-completions"],
		]);
		expect(replay.messages[1]).toEqual(firstMessage);
		expect(replay.config).toMatchObject({ provider: "first", model: "shared", thinkingLevel: "low" });
		const runIds = f.events.filter((event) => event.type === "agent_start").map((event) => event.runId);
		for (let i = 0; i < f.traces.length; i++) {
			const runId = runIds[i];
			if (runId === undefined) throw new Error("missing run identity");
			const events = await f.traces[i].events();
			const expected = i === 1 ? "second" : "first";
			const modelEvents = events.filter((event) => event.kind === "model");
			expect(modelEvents.map((event) => event.metadata)).toEqual([
				expect.objectContaining({ provider: expected, model: "shared", api: "openai-completions" }),
				expect.objectContaining({ provider: expected, model: "shared", api: "openai-completions" }),
			]);
			const step = modelEvents[0].metadata?.turn;
			const id = `model/${runId}/${step}`;
			expect(f.index.find(id)).toMatchObject({ provider: expected, model: "shared", api: "openai-completions", name: `${expected}/shared` });
			for (const event of events) projectTraceEvent(f.index, event, runId, 1);
			expect(f.index.find(id)).toMatchObject({ provider: expected, model: "shared", api: "openai-completions" });
		}
	});

	it("rejects unavailable targets and a failed durable selection without changing the active model or defaults", async () => {
		const f = await fixture();
		const controller = await f.create();
		const before = controller.currentSelection;
		await expect(controller.selectModel({ ...f.second, id: "missing" })).rejects.toThrow("Unknown model selection");
		const check = vi.spyOn(f.models, "getAvailable").mockResolvedValueOnce([]);
		await expect(controller.selectModel(f.second)).rejects.toThrow("not available");
		check.mockRestore();
		const defaults = await loadProjectSettings({ layout: f.layout });
		vi.spyOn(f.ledger, "append").mockImplementationOnce(() => { throw new Error("durable write failed"); });
		await expect(controller.selectModel(f.second)).rejects.toThrow("durable write failed");
		expect(controller.currentSelection).toEqual(before);
		expect((await replaySession(f.ledger)).config.provider).toBe("first");
		expect(await loadProjectSettings({ layout: f.layout })).toEqual(defaults);
		expect(f.requests).toEqual([]);
	});

	it("prevents a model or thinking change during an active request", async () => {
		const f = await fixture();
		const controller = await f.create();
		let release!: () => void;
		let entered!: () => void;
		const received = new Promise<void>((resolve) => { entered = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		f.pause(async () => { entered(); await blocked; });
		const prompt = controller.prompt("wait for response");
		try {
			await Promise.race([received, prompt.then(() => { throw new Error("request ended before reaching the fixture"); })]);
			await expect(controller.selectModel(f.second)).rejects.toThrow("active request");
			await expect(controller.setThinkingLevel("high")).rejects.toThrow("active request");
			expect(controller.currentSelection).toMatchObject({ provider: "first", thinkingLevel: "low" });
		} finally { release(); await prompt; }
		await controller.selectModel(f.second);
		expect(controller.currentSelection.provider).toBe("second");
	});
});
