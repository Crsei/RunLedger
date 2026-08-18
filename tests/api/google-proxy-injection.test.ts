import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import type { Model } from "../../src/types.ts";
import { stream as streamGoogle } from "../../src/api/google-generative-ai.ts";
import { stream as streamVertex } from "../../src/api/google-vertex.ts";

const proxyEnv = (proxyUrl: string, providerKey = "GOOGLE_GENERATIVE_AI") => ({
	[`RUNLEDGER_PROXY_${providerKey}`]: proxyUrl,
	no_proxy: "never-match.runledger.test",
});

function googleModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-proxy-test",
		name: "Gemini proxy test",
		api: "google-generative-ai",
		provider: "google-generative-ai",
		baseUrl: "http://api.runledger.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 128,
	};
}

function vertexModel(): Model<"google-vertex"> {
	return {
		id: "vertex-proxy-test",
		name: "Vertex proxy test",
		api: "google-vertex",
		provider: "google-vertex",
		baseUrl: "http://vertex.runledger.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 128,
	};
}

describe("Google GenAI provider proxy", () => {
	let proxyServer: Server | undefined;

	afterEach(async () => {
		if (proxyServer) {
			await new Promise<void>((resolve) => proxyServer?.close(() => resolve()));
			proxyServer = undefined;
		}
	});

	test("routes the SDK stream through the provider proxy", async () => {
		const requests: string[] = [];
		proxyServer = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({
				candidates: [{ content: { parts: [{ text: "proxied" }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
			})}\n\n`);
		});
		await new Promise<void>((resolve, reject) => {
			proxyServer?.once("error", reject);
			proxyServer?.listen(0, "127.0.0.1", resolve);
		});
		const address = proxyServer.address();
		if (!address || typeof address === "string") throw new Error("Expected an ephemeral proxy address");

		const message = await streamGoogle(
			googleModel(),
			{ messages: [{ role: "user", content: "ping", timestamp: 1 }] },
			{ apiKey: "test-key", env: proxyEnv(`http://127.0.0.1:${address.port}`) },
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("api.runledger.test");
		expect(message.content).toEqual([{ type: "text", text: "proxied" }]);
	});

	test("routes Vertex AI SDK streams through the provider proxy", async () => {
		const requests: string[] = [];
		proxyServer = createServer((request, response) => {
			requests.push(request.url ?? "");
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({
				candidates: [{ content: { parts: [{ text: "vertex-proxied" }] }, finishReason: "STOP" }],
				usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
			})}\n\n`);
		});
		await new Promise<void>((resolve, reject) => {
			proxyServer?.once("error", reject);
			proxyServer?.listen(0, "127.0.0.1", resolve);
		});
		const address = proxyServer.address();
		if (!address || typeof address === "string") throw new Error("Expected an ephemeral proxy address");

		const message = await streamVertex(
			vertexModel(),
			{ messages: [{ role: "user", content: "ping", timestamp: 1 }] },
			{ apiKey: "test-key", env: proxyEnv(`http://127.0.0.1:${address.port}`, "GOOGLE_VERTEX") },
		).result();

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("vertex.runledger.test");
		expect(message.content).toEqual([{ type: "text", text: "vertex-proxied" }]);
	});
});
