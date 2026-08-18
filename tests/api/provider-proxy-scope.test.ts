import { describe, expect, test } from "vitest";
import { resolveBedrockProxyUrl } from "../../src/api/bedrock-converse-stream.ts";
import { resolveCodexWebSocketProxyUrl } from "../../src/api/openai-codex-responses.ts";

const noProxy = "never-match.runledger.test";

describe("provider-scoped proxy resolver integration points", () => {
	test("uses the Bedrock provider override before the global proxy", () => {
		const proxy = resolveBedrockProxyUrl(
			{
				id: "bedrock-model",
				name: "Bedrock model",
				api: "bedrock-converse-stream",
				provider: "bedrock-fixture",
				baseUrl: "https://bedrock-upstream.runledger.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
				maxTokens: 128,
			},
			{
				RUNLEDGER_PROXY_BEDROCK_FIXTURE: "http://bedrock-provider-proxy.runledger.test:3128",
				RUNLEDGER_PROXY: "http://global-proxy.runledger.test:3128",
				no_proxy: noProxy,
			},
		);

		expect(proxy).toEqual(new URL("http://bedrock-provider-proxy.runledger.test:3128"));
	});

	test("uses the Codex provider override for WebSocket targets", () => {
		const proxy = resolveCodexWebSocketProxyUrl(
			"openai-codex",
			"wss://codex-upstream.runledger.test/codex/responses",
			{
				RUNLEDGER_PROXY_OPENAI_CODEX: "http://codex-provider-proxy.runledger.test:3128",
				RUNLEDGER_PROXY: "http://global-proxy.runledger.test:3128",
				no_proxy: noProxy,
			},
		);

		expect(proxy).toEqual(new URL("http://codex-provider-proxy.runledger.test:3128"));
	});
});
