import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createModels } from "../../src/models.ts";
import { opencodeGoProvider } from "../../src/providers/opencode-go.ts";
import { createSessionModelStreamFn } from "../../src/runtime/agents/child-model-runtime.ts";
import type { CacheRetention, Model } from "../../src/types.ts";

type GoApi = "openai-completions" | "anthropic-messages" | "openai-responses";
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
		server.closeAllConnections();
		server.close((error) => error ? reject(error) : resolve());
	})));
});

function sse(api: GoApi): string {
	const events = api === "anthropic-messages" ? [
		{ type: "message_start", message: { id: "msg-go", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	] : api === "openai-responses" ? [
		{ type: "response.completed", response: { id: "resp-go", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	] : [
		{ id: "chat-go", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
		{ id: "chat-go", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return events.map((event) => `${"type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
}

async function endpoint(api: GoApi) {
	const requests: IncomingHttpHeaders[] = [];
	const server = createServer((request, response) => {
		requests.push(request.headers);
		request.resume();
		if (!request.headers["x-opencode-session"]) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "MissingSessionID", message: "Request is missing x-opencode-session" }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(sse(api));
	});
	servers.push(server);
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("missing test server address");
	const provider = opencodeGoProvider();
	const source = provider.getModels().find((model) => model.api === api);
	if (source === undefined) throw new Error(`missing Go model for ${api}`);
	const model = { ...source, baseUrl: `http://127.0.0.1:${address.port}`, reasoning: false } as Model<GoApi>;
	return { requests, provider, model };
}

const APIs: readonly GoApi[] = ["openai-completions", "anthropic-messages", "openai-responses"];
const RETENTIONS: readonly CacheRetention[] = ["none", "short"];
describe("OpenCode Go conversation routing", () => {
	for (const api of APIs) {
		it.each(RETENTIONS)(`${api} preserves Session Owner identity with cache retention %s`, async (cacheRetention) => {
			const { requests, provider, model } = await endpoint(api);
			const models = createModels();
			models.setProvider(provider);
			for (const sessionId of ["session-go-a", "session-go-a", "session-go-b"]) {
				const stream = createSessionModelStreamFn({ models, sessionId });
				const result = await (await stream(model, { systemPrompt: "coding agent", messages: [], tools: [] }, {
					apiKey: "fixture-key", cacheRetention, headers: { "X-Test": "preserved" }, sessionId: "must-not-replace-owner",
				})).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
			}
			expect(requests.map((headers) => headers["x-opencode-session"])).toEqual(["session-go-a", "session-go-a", "session-go-b"]);
			for (const headers of requests) {
				expect(headers["user-agent"]).toBe("RunLedger");
				expect(headers["x-test"]).toBe("preserved");
			}
		});

		it(`${api} also supports direct provider streams and explicit client headers`, async () => {
			const { requests, provider, model } = await endpoint(api);
			const result = await provider.stream(model, { messages: [] }, {
				apiKey: "fixture-key", sessionId: "direct-session", cacheRetention: "none",
				headers: { "user-agent": "fixture-agent/1.0", "X-Test": "preserved" },
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(requests[0]).toMatchObject({ "x-opencode-session": "direct-session", "user-agent": "fixture-agent/1.0", "x-test": "preserved" });
		});
	}
});
