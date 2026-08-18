import type { Api, Model } from "../../src/types.ts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { stream as streamCodex } from "../../src/api/openai-codex-responses.ts";
import { stream as streamPiMessages } from "../../src/api/pi-messages.ts";

type FetchCall = {
	input: unknown;
	init: RequestInit | undefined;
};

const context = { messages: [] };
const neutralNoProxy = "never-match.runledger.test";
const apiVersion = ["v", "1"].join("");

function model<TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "fetch-proxy-test-model",
		name: "Fetch proxy test model",
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

function stubFetch(responseBody: string): FetchCall[] {
	const calls: FetchCall[] = [];
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
		calls.push({ input, init });
		return new Response(responseBody, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return calls;
}

function proxyEnv(provider: string): Record<string, string> {
	return {
		[`RUNLEDGER_PROXY_${provider.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`]:
			"http://proxy.runledger.test:3128",
		no_proxy: neutralNoProxy,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("bare provider fetch proxy integration", () => {
	test("routes pi-messages through the provider proxy fetch", async () => {
		const calls = stubFetch(
			`data: ${JSON.stringify({
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
			})}\n\n`,
		);

		const result = await streamPiMessages(
			model("pi-proxy-provider", "pi-messages", `https://pi-backend.runledger.test/${apiVersion}`),
			context,
			{ apiKey: "test-key", env: proxyEnv("pi-proxy-provider") },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe(`https://pi-backend.runledger.test/${apiVersion}/messages`);
		expect((calls[0]?.init as RequestInit & { agent?: unknown }).agent).toBeDefined();
	});

	test("routes Codex SSE fallback through the provider proxy fetch", async () => {
		const calls = stubFetch(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "response-fetch-proxy-test",
					status: "completed",
					output: [],
					usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
				},
			})}\n\n`,
		);
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-fetch-proxy-test" } }),
		).toString("base64");

		const result = await streamCodex(
			model("openai-codex-proxy", "openai-codex-responses", `https://codex.runledger.test/backend-api`),
			context,
			{
				apiKey: `header.${tokenPayload}.signature`,
				transport: "sse",
				env: proxyEnv("openai-codex-proxy"),
			},
		).result();

		expect(result.stopReason).toBe("stop");
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe("https://codex.runledger.test/backend-api/codex/responses");
		expect((calls[0]?.init as RequestInit & { agent?: unknown }).agent).toBeDefined();
	});
});
