import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { streamSimple as completions } from "../../src/api/openai-completions.ts";
import { streamSimple as responses } from "../../src/api/openai-responses.ts";
import { streamSimple as anthropic } from "../../src/api/anthropic-messages.ts";
import { runAgentLoop } from "../../src/runtime/agent-loop.ts";
import { DEFAULT_AGENT_RUN_BUDGET, type AgentContext, type StreamFn } from "../../src/runtime/types.ts";
import { ModelRequestSnapshots, type RequestDumpResult } from "../../src/runtime/model-request-snapshots.ts";
import { RequestDumpPager } from "../../src/runtime/session-runtime/request-dump-pager.ts";
import { readRequestDump } from "../../src/runtime/request-dump-reader.ts";
import { MemoryLedger } from "../../src/runtime/ledger/memory-ledger.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { assembleAgentModelContext } from "../../src/runtime/context/model-request-adapter.ts";
import type { Api, Model } from "../../src/types.ts";

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => error ? reject(error) : resolve());
	})));
});

async function endpoint(api: Api): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		bodies.push(Buffer.concat(chunks).toString("utf8"));
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (api === "anthropic-messages") {
			for (const event of [
				{ type: "message_start", message: { id: "msg-local", type: "message", role: "assistant", content: [], model: "dump-local", stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
				{ type: "message_stop" },
			]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		} else if (api === "openai-responses") {
			for (const event of [
				{ type: "response.output_item.added", item: { type: "message", id: "msg-local", role: "assistant", status: "in_progress", content: [] } },
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "done" },
				{ type: "response.output_item.done", item: { type: "message", id: "msg-local", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done" }] } },
				{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
			]) response.write(`data: ${JSON.stringify(event)}\n\n`);
		} else {
			response.write(`data: ${JSON.stringify({ id: "chat-local", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
			response.write("data: [DONE]\n\n");
		}
		response.end();
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("No local address");
	return { url: `http://127.0.0.1:${address.port}`, bodies };
}

const base = { systemPrompt: "base", tools: [], source: "base" as const, assembledPromptDigest: runtimeDigest("base") };
function model(api: Api, baseUrl: string): Model<Api> {
	return { id: "dump-local", name: "Dump local", api, provider: "dump-local", baseUrl, reasoning: false,
		input: ["text"], contextWindow: 128_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
function context(): AgentContext {
	return { systemPrompt: "raw\u001b\u0085\n中文\r\n", messages: [], tools: [{
		name: "inspect", label: "Inspect", description: "Inspect test data", parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [], details: undefined }),
	}] };
}
function dump(result: RequestDumpResult) {
	if (!result.ok) throw new Error(result.code);
	return result.dump;
}

async function readAll(pager: RequestDumpPager, view: "request" | "system" | "assembled" | "base" = "request") {
	return readRequestDump(view, async (payload) => {
		const page = pager.read(payload);
		return page.ok ? { ok: true, status: "ok", operation: "session.request.inspect", domainRevision: 1, value: page.value }
			: { ok: false, status: "failed", operation: "session.request.inspect", code: page.code };
	});
}

describe("request dump observes the request sent by the provider", () => {
	it.each(["openai-completions", "anthropic-messages", "openai-responses"] as const)("matches local HTTP body after %s payload replacement", async (api) => {
		const server = await endpoint(api);
		const requestModel = model(api, server.url);
		const snapshots = new ModelRequestSnapshots();
		const replacementText = "replacement\u001b\n中文\r\n";
		const provider: StreamFn = (selected, input, options) => {
			const adjusted = { ...options, apiKey: "local-fixture-key", maxRetries: 0, env: { HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*" },
				onPayload: (payload: unknown) => {
					const original = payload as Record<string, unknown>;
					return api === "anthropic-messages"
						? { ...original, system: [{ type: "text", text: "identity" }, { type: "text", text: replacementText }], stream: false }
						: api === "openai-responses" ? { ...original, input: [{ role: "developer", content: replacementText }, ...(original.input as unknown[]).slice(1)] }
						: { ...original, messages: [{ role: "system", content: replacementText }, ...(original.messages as unknown[]).slice(1)] };
				} };
			return api === "anthropic-messages" ? anthropic(selected as Model<"anthropic-messages">, input, adjusted)
				: api === "openai-responses" ? responses(selected as Model<"openai-responses">, input, adjusted)
				: completions(selected as Model<"openai-completions">, input, adjusted);
		};
		const ledger = new MemoryLedger();
		await runAgentLoop([{ role: "user", content: [{ type: "text", text: "hello" }] }], context(),
			{ model: requestModel, ledger, runBudget: DEFAULT_AGENT_RUN_BUDGET, modelContextAssembler: assembleAgentModelContext, modelRequestObserver: snapshots.observe },
			() => {}, undefined, provider);
		expect(server.bodies).toHaveLength(1);
		const exported = dump(await readAll(new RequestDumpPager((view) => snapshots.dump(view, base))));
		expect(JSON.parse(exported.content)).toEqual(JSON.parse(server.bodies[0]!));
		expect(exported.metadata).toMatchObject({ layer: "provider-input", state: "completed", responseStatus: 200, requestKind: "interactive", turn: 1 });
		expect(exported.content).not.toContain("local-fixture-key");
		const system = dump(snapshots.dump("system", base));
		if (api === "anthropic-messages") expect(JSON.parse(system.content)).toEqual([{ type: "text", text: "identity" }, { type: "text", text: replacementText }]);
		else expect(system.content).toBe(replacementText);
		expect(JSON.parse(dump(snapshots.dump("assembled", base)).content).systemPrompt).toBe(context().systemPrompt);
	}, 20_000);

	it("includes the Anthropic OAuth system identity injected after assembly", async () => {
		const server = await endpoint("anthropic-messages");
		let captured = "";
		const result = await anthropic(model("anthropic-messages", server.url) as Model<"anthropic-messages">,
			{ systemPrompt: "my raw system", messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "sk-ant-oat-local-fixture", onRequestPrepared: (json) => { captured = json; } }).result();
		expect(result.stopReason).toBe("stop");
		expect(JSON.parse(captured)).toEqual(JSON.parse(server.bodies[0]!));
		expect(JSON.parse(captured).system).toEqual(expect.arrayContaining([
			expect.objectContaining({ text: "You are Claude Code, Anthropic's official CLI for Claude." }),
			expect.objectContaining({ text: "my raw system" }),
		]));
	});

	it("does not let a failing read-only observer change provider execution", async () => {
		const server = await endpoint("openai-completions");
		const result = await completions(model("openai-completions", server.url) as Model<"openai-completions">,
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "local-fixture", onRequestPrepared: () => { throw new Error("observer failed"); } }).result();
		expect(result.stopReason).toBe("stop");
		expect(server.bodies).toHaveLength(1);
	});

	it("does not replace a missing provider request with base or cancelled assembly", async () => {
		const snapshots = new ModelRequestSnapshots();
		const controller = new AbortController();
		let called = false;
		await runAgentLoop([{ role: "user", content: [{ type: "text", text: "cancel" }] }], context(), {
			model: model("openai-completions", "http://127.0.0.1"), runBudget: DEFAULT_AGENT_RUN_BUDGET, modelRequestObserver: snapshots.observe,
			modelContextAssembler: (input) => { const assembled = assembleAgentModelContext(input); controller.abort(); return assembled; },
		}, () => {}, controller.signal, () => { called = true; throw new Error("must not dispatch"); });
		expect(called).toBe(false);
		expect(snapshots.dump("request", base)).toEqual({ ok: false, code: "provider_request_unavailable" });
		expect(dump(snapshots.dump("assembled", base)).metadata.state).toBe("aborted");
		expect(dump(snapshots.dump("base", base)).content).toBe("base");
	});

	it("pins more than 192 KiB of Unicode and escaped text across a changing live snapshot", async () => {
		const content = "abc" + "\u001b\u0000中文😀\r\n".repeat(40_000);
		let current = { content, metadata: { view: "system" as const, layer: "provider-input" as const, mediaType: "text/plain" as const, capturedAtMs: 1, state: "completed" as const } };
		const pager = new RequestDumpPager(() => ({ ok: true, dump: current }));
		let pages = 0;
		const result = await readRequestDump("system", async (payload) => {
			const page = pager.read(payload);
			current = { ...current, content: "new request", metadata: { ...current.metadata, capturedAtMs: 2 } };
			pages++;
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(192 * 1024);
			if (!page.ok) throw new Error(page.code);
			return { ok: true, status: "ok", operation: "session.request.inspect", domainRevision: 1, value: page.value };
		});
		expect(pages).toBeGreaterThan(1);
		expect(dump(result).content).toBe(content);
		expect(dump(result).metadata.capturedAtMs).toBe(1);
	});

	it("keeps the last provider request when a later dispatch throws and ignores side requests", async () => {
		const snapshots = new ModelRequestSnapshots();
		const requestModel = model("openai-completions", "http://127.0.0.1");
		snapshots.observe({ kind: "assembled", requestId: "first", runId: "run-first", turn: 1, requestKind: "interactive", model: requestModel, thinkingLevel: "off", context: { systemPrompt: "first", messages: [], tools: [] } });
		snapshots.observe({ kind: "prepared", requestId: "first", payloadJson: '{"messages":[{"role":"system","content":"first"}]}', model: requestModel });
		snapshots.observe({ kind: "finished", requestId: "first", stopReason: "stop" });
		snapshots.observe({ kind: "assembled", requestId: "title", runId: "run-title", turn: 1, requestKind: "auto-title", model: requestModel, thinkingLevel: "off", context: { messages: [], tools: [] } });
		snapshots.observe({ kind: "prepared", requestId: "title", payloadJson: '{}', model: requestModel });
		await expect(runAgentLoop([], context(), { model: requestModel, runBudget: DEFAULT_AGENT_RUN_BUDGET, modelRequestObserver: snapshots.observe },
			() => {}, undefined, () => { throw new Error("routing denied"); })).rejects.toThrow("routing denied");
		const exported = dump(snapshots.dump("system", base));
		expect(exported.content).toBe("first");
		expect(exported.metadata).toMatchObject({ requestId: "first", latestAttemptState: "error" });
		expect(exported.metadata.latestAttemptId).not.toBe("first");
	});

	it("preserves native roles for multiple system messages and an intentionally absent system", () => {
		const snapshots = new ModelRequestSnapshots();
		const requestModel = model("openai-completions", "http://127.0.0.1");
		snapshots.observe({ kind: "assembled", requestId: "multi", runId: "run-multi", turn: 1, requestKind: "interactive", model: requestModel, thinkingLevel: "off", context: { messages: [], tools: [] } });
		expect(snapshots.promptInspection?.systemPrompt).toBe("");
		expect(JSON.parse(dump(snapshots.dump("assembled", base)).content)).not.toHaveProperty("systemPrompt");
		const messages = [{ role: "system", content: "first" }, { role: "developer", content: [{ type: "text", text: "second" }] }];
		snapshots.observe({ kind: "prepared", requestId: "multi", model: requestModel, payloadJson: JSON.stringify({ messages: [...messages, { role: "user", content: "question" }] }) });
		expect(JSON.parse(dump(snapshots.dump("system", base)).content)).toEqual(messages);
	});

	it("rejects mixed pages and never returns a partial dump", async () => {
		const pager = new RequestDumpPager(() => ({ ok: true, dump: { content: "a".repeat(40_000), metadata: { view: "request", layer: "provider-input", mediaType: "application/json", capturedAtMs: 1, state: "prepared" } } }));
		const result = await readRequestDump("request", async (payload) => {
			const page = pager.read(payload);
			if (!page.ok) throw new Error(page.code);
			return { ok: true, status: "ok", operation: "session.request.inspect", domainRevision: 1,
				value: { ...page.value, ...(payload.offset === 0 ? {} : { snapshotId: "different" }) } };
		});
		expect(result).toEqual({ ok: false, code: "malformed_request_dump" });
	});
});
