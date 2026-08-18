import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Api, Model } from "../../src/types.ts";
import { afterEach, describe, expect, test } from "vitest";

import { stream as streamOpenAICompletions } from "../../src/api/openai-completions.ts";
import { stream as streamPiMessages } from "../../src/api/pi-messages.ts";
import { fetchWithProviderProxy } from "../../src/utils/fetch-provider-proxy.ts";

type RequestObservation = {
	method: string;
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
};

type RecordingServer = {
	server: Server;
	url: string;
	observations: RequestObservation[];
	close: () => Promise<void>;
};

const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
const neutralNoProxy = "never-match.runledger.test";

function model<TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "proxy-integration-model",
		name: "Proxy integration model",
		api,
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as Model<TApi>;
}

async function startRecordingServer(body: string, contentType = "text/plain"): Promise<RecordingServer> {
	const observations: RequestObservation[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			observations.push({
				method: request.method ?? "",
				url: request.url ?? "",
				headers: request.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			response.writeHead(200, { "content-type": contentType });
			response.end(body);
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		throw new Error("Recording server did not bind to an ephemeral port");
	}

	return {
		server,
		url: `http://127.0.0.1:${address.port}`,
		observations,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function openAIStreamBody(text: string): string {
	return [
		`data: ${JSON.stringify({
			id: "chatcmpl-proxy-integration",
			object: "chat.completion.chunk",
			created: 1,
			model: "proxy-integration-model",
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
		})}`,
		`data: ${JSON.stringify({
			id: "chatcmpl-proxy-integration",
			object: "chat.completion.chunk",
			created: 1,
			model: "proxy-integration-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		})}`,
		"data: [DONE]",
	].join("\n\n");
}

function piMessagesBody(): string {
	return `data: ${JSON.stringify({
		type: "done",
		reason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	})}\n\n`;
}

function providerProxyEnv(provider: string, proxyUrl: string): Record<string, string> {
	return {
		[`RUNLEDGER_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`]: proxyUrl,
		no_proxy: neutralNoProxy,
	};
}

const openServers: RecordingServer[] = [];

afterEach(async () => {
	while (openServers.length > 0) {
		await openServers.pop()?.close();
	}
});

describe("real outbound proxy integration", () => {
	test("routes a real OpenAI SDK request through RUNLEDGER_PROXY", async () => {
		const proxy = await startRecordingServer(openAIStreamBody("through-global-proxy"), "text/event-stream");
		openServers.push(proxy);

		const result = await streamOpenAICompletions(
			model("proxy-integration-openai", "openai-completions", "http://openai-upstream.runledger.test/api"),
			context,
			{
				apiKey: "integration-key",
				env: { RUNLEDGER_PROXY: proxy.url, no_proxy: neutralNoProxy },
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "through-global-proxy" }]);
		expect(proxy.observations).toHaveLength(1);
		expect(proxy.observations[0]?.url).toBe("http://openai-upstream.runledger.test/api/chat/completions");
		expect(proxy.observations[0]?.headers.authorization).toBe("Bearer integration-key");
	});

	test("routes a real pi-messages request through a provider-scoped proxy", async () => {
		const proxy = await startRecordingServer(piMessagesBody(), "text/event-stream");
		openServers.push(proxy);
		const provider = "proxy-integration-pi";

		const result = await streamPiMessages(
			model(provider, "pi-messages", "http://pi-upstream.runledger.test/backend"),
			context,
			{ apiKey: "pi-integration-key", env: providerProxyEnv(provider, proxy.url) },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(proxy.observations).toHaveLength(1);
		expect(proxy.observations[0]?.url).toBe("http://pi-upstream.runledger.test/backend/messages");
		expect(proxy.observations[0]?.headers.authorization).toBe("Bearer pi-integration-key");
	});

	test("keeps NO_PROXY star targets direct", async () => {
		const upstream = await startRecordingServer("direct-star");
		const proxy = await startRecordingServer("proxy-should-not-see-this");
		openServers.push(upstream, proxy);

		const response = await fetchWithProviderProxy(
			"proxy-integration-no-proxy-star",
			`${upstream.url.replace("127.0.0.1", "0.0.0.0")}/direct`,
			undefined,
			{ RUNLEDGER_PROXY: proxy.url, NO_PROXY: "*" },
		);

		expect(await response.text()).toBe("direct-star");
		expect(upstream.observations).toHaveLength(1);
		expect(proxy.observations).toHaveLength(0);
	});

	test("keeps localhost targets direct", async () => {
		const upstream = await startRecordingServer("direct-localhost");
		const proxy = await startRecordingServer("proxy-should-not-see-this");
		openServers.push(upstream, proxy);

		const response = await fetchWithProviderProxy(
			"proxy-integration-localhost",
			`${upstream.url.replace("127.0.0.1", "localhost")}/direct`,
			undefined,
			{ RUNLEDGER_PROXY: proxy.url, no_proxy: neutralNoProxy },
		);

		expect(await response.text()).toBe("direct-localhost");
		expect(upstream.observations).toHaveLength(1);
		expect(proxy.observations).toHaveLength(0);
	});
});
