import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createModels } from "../../src/models.ts";
import { abliterationProvider } from "../../src/providers/abliteration.ts";
import { clinePassProvider } from "../../src/providers/cline-pass.ts";
import { deepinfraProvider } from "../../src/providers/deepinfra.ts";
import { yoloAutoProvider } from "../../src/providers/yolo-auto.ts";

let server: Server;
let origin: string;
const requests: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
	server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
		requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (request.url?.endsWith("/responses")) {
			for (const event of [
				{ type: "response.output_item.added", item: { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] } },
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "local fixture" },
				{ type: "response.output_item.done", item: { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "local fixture" }] } },
				{ type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
			]) response.write(`data: ${JSON.stringify(event)}\n\n`);
		} else {
			response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "local fixture" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
		}
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind TCP");
	origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("new providers through Models and real local HTTP", () => {
	test.each([
		["abliteration", abliterationProvider, "abliterated-model"],
		["cline-pass", clinePassProvider, "kimi-k3"],
		["deepinfra", deepinfraProvider, "deepseek-ai/DeepSeek-V4-Flash-0731"],
		["yolo-auto", yoloAutoProvider, "deepseek-flash-v4"],
	] as const)("%s resolves auth and consumes SSE without changing public identity", async (id, factory, modelId) => {
		const models = createModels({ authContext: { env: async () => "local-fixture-key", fileExists: async () => false } });
		models.setProvider(factory({ baseUrl: `${origin}/${id}/v1` }));
		const model = models.getModel(id, modelId)!;
		const result = await models.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { reasoning: "high" }).result();
		expect(result).toMatchObject({ provider: id, model: modelId, stopReason: "stop", usage: { input: 5, output: 3 } });
		expect(result.content).toMatchObject([{ type: "text", text: "local fixture" }]);
		const request = requests.at(-1)!;
		expect(request.authorization).toBe("Bearer local-fixture-key");
		expect(request.path).toBe(`/${id}/v1/${id === "abliteration" ? "responses" : "chat/completions"}`);
		expect(request.body.model).toBe(id === "cline-pass" ? "cline-pass/kimi-k3" : modelId);
	});
});
