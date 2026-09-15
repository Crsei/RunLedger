import { createServer, type IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../../src/types.ts";
import { compactOpenAIResponsesStreaming } from "../../src/api/openai-responses.ts";

const usage = { input_tokens: 200, output_tokens: 20, total_tokens: 220, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 0 } };
const item = { type: "compaction", id: "compact-1", encrypted_content: "opaque-streaming-fixture" };
const completed = { type: "response.completed", response: { id: "response-1", status: "completed", output: [item], usage } };
const done = { type: "response.output_item.done", output_index: 0, item };
async function fixture(events: readonly unknown[], hang = false, rotate = false) {
	const requests: { body: Record<string, unknown>; headers: IncomingHttpHeaders }[] = [];
	const server = createServer(async (req, res) => {
		let raw = ""; for await (const chunk of req) raw += String(chunk);
		requests.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		res.write(rotate ? payload.replaceAll("opaque-streaming-fixture", `opaque-streaming-fixture-${requests.length}`) : payload);
		if (!hang) res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); if (typeof address === "string" || address === null) throw new Error("listener unavailable");
	const model: Model<"openai-responses"> = { id: "fixture", name: "fixture", api: "openai-responses", provider: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"], contextWindow: 20_000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const options = { apiKey: "fixture-only", sessionId: "session-streaming-fixture", timeoutMs: 2000 };
	return { model, options, requests, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
const context: Context = { systemPrompt: "Fixture policy", tools: [], messages: [{ role: "user", content: "retain-user-fact", timestamp: 0 }] };
describe("streaming Responses compaction protocol", () => {
	it("uses the normal wire, appends one trigger, retains users, and replaces old opaque state", async () => {
		const f = await fixture([done, completed], false, true);
		try {
			const first = await compactOpenAIResponsesStreaming(f.model, context, f.options);
			const request = f.requests[0]!;
			expect(request.body).toMatchObject({ model: "fixture", stream: true, store: false, prompt_cache_key: f.options.sessionId });
			expect((request.body.input as unknown[]).at(-1)).toEqual({ type: "compaction_trigger" });
			expect(request.body.tools ?? []).toEqual([]);
			expect(request.headers.session_id).toBe(f.options.sessionId); expect(request.headers["x-client-request-id"]).toBe(f.options.sessionId);
			expect(first.state.output.filter((entry) => entry.type === "compaction")).toEqual([{ ...item, encrypted_content: "opaque-streaming-fixture-1" }]);
			expect(JSON.stringify(first.state.output)).toContain("retain-user-fact"); expect(JSON.stringify(first.state.output)).not.toContain("Fixture policy");
			const second = await compactOpenAIResponsesStreaming(f.model, { ...context, compaction: JSON.parse(JSON.stringify(first.state)) as typeof first.state, messages: [{ role: "user", content: "new-user-fact", timestamp: 1 }] }, f.options);
			expect(second.state.output.filter((entry) => entry.type === "compaction")).toEqual([{ ...item, encrypted_content: "opaque-streaming-fixture-2" }]);
			expect(JSON.stringify(second.state.output)).not.toContain("opaque-streaming-fixture-1");
			expect(JSON.stringify(second.state.output)).toContain("retain-user-fact"); expect(JSON.stringify(second.state.output)).toContain("new-user-fact");
			const count = f.requests.length;
			await expect(compactOpenAIResponsesStreaming({ ...f.model, id: "other" }, { ...context, compaction: first.state }, f.options)).rejects.toThrow("incompatible");
			await expect(compactOpenAIResponsesStreaming({ ...f.model, provider: "other" }, context, f.options)).rejects.toThrow("incompatible");
			expect(f.requests).toHaveLength(count);
		} finally { await f.close(); }
	});
	it.each([
		["missing item", [completed]], ["multiple items", [done, done, completed]], ["missing completion", [done]],
		["incomplete", [done, { type: "response.incomplete", response: { status: "incomplete" } }]],
		["error", [{ type: "error", message: "fixture failure", code: "fixture" }]],
		["empty encrypted content", [{ ...done, item: { ...item, encrypted_content: "" } }, completed]],
		["invalid usage", [done, { ...completed, response: { ...completed.response, usage: { ...usage, output_tokens: -1 } } }]],
	] as const)("rejects %s without retry or fallback", async (_label, events) => {
		const f = await fixture(events);
		try { await expect(compactOpenAIResponsesStreaming(f.model, context, f.options)).rejects.toThrow(); expect(f.requests).toHaveLength(1); }
		finally { await f.close(); }
	});
	it("bounds a stream that never completes", async () => {
		const f = await fixture([done], true);
		try { await expect(compactOpenAIResponsesStreaming(f.model, context, { ...f.options, timeoutMs: 100 })).rejects.toThrow(); }
		finally { await f.close(); }
	});
});
