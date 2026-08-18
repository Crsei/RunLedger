import type { Api, ImagesModel, Model } from "../../src/types.ts";
import { beforeEach, describe, expect, test, vi } from "vitest";

const openAiOptions = vi.hoisted(() => [] as unknown[]);
const anthropicOptions = vi.hoisted(() => [] as unknown[]);
const mistralOptions = vi.hoisted(() => [] as unknown[]);

vi.mock("openai", () => {
	const rejectWithResponse = () => ({
		withResponse: () => Promise.reject(new Error("proxy injection test")),
	});
	class MockOpenAI {
		chat = { completions: { create: rejectWithResponse } };
		responses = { create: rejectWithResponse };

		constructor(options: unknown) {
			openAiOptions.push(options);
		}
	}

	class MockAzureOpenAI extends MockOpenAI {}

	return { default: MockOpenAI, OpenAI: MockOpenAI, AzureOpenAI: MockAzureOpenAI };
});

vi.mock("@anthropic-ai/sdk", () => {
	class MockAnthropic {
		messages = {
			create: () => ({
				asResponse: () => Promise.reject(new Error("proxy injection test")),
			}),
		};

		constructor(options: unknown) {
			anthropicOptions.push(options);
		}
	}

	return { default: MockAnthropic };
});

vi.mock("@mistralai/mistralai", () => {
	class MockHTTPClient {
		constructor(public readonly options: unknown) {}
	}

	class MockMistral {
		chat = { stream: () => Promise.reject(new Error("proxy injection test")) };

		constructor(options: unknown) {
			mistralOptions.push(options);
		}
	}

	return { Mistral: MockMistral, HTTPClient: MockHTTPClient };
});

import { stream as streamAnthropic } from "../../src/api/anthropic-messages.ts";
import { stream as streamAzure } from "../../src/api/azure-openai-responses.ts";
import { stream as streamMistral } from "../../src/api/mistral-conversations.ts";
import { stream as streamOpenAICompletions } from "../../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../../src/api/openai-responses.ts";
import { generateImages } from "../../src/api/openrouter-images.ts";

const context = { messages: [] };
const apiVersion = ["v", "1"].join("");

function asRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected an object");
	}
	return value as Record<string, unknown>;
}

function model<TApi extends Api>(provider: string, api: TApi, baseUrl: string): Model<TApi> {
	return {
		id: "proxy-test-model",
		name: "Proxy test model",
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

function imagesModel(provider: string, baseUrl: string): ImagesModel<"openrouter-images"> {
	return {
		id: "proxy-test-image-model",
		name: "Proxy test image model",
		api: "openrouter-images",
		provider,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 1024,
		output: ["text", "image"],
	};
}

const proxyEnv = (providerKey: string) => ({
	[`RUNLEDGER_PROXY_${providerKey}`]: "http://scoped-proxy.runledger.test:3128",
	no_proxy: "never-match.runledger.test",
});

describe("SDK provider proxy injection", () => {
	beforeEach(() => {
		openAiOptions.length = 0;
		anthropicOptions.length = 0;
		mistralOptions.length = 0;
	});

	test("injects a provider-scoped fetch into Anthropic", async () => {
		await streamAnthropic(
			model("anthropic", "anthropic-messages", "https://anthropic.runledger.test"),
			context,
			{ apiKey: "test-key", env: proxyEnv("ANTHROPIC") },
		).result();

		expect(typeof asRecord(anthropicOptions[0]).fetch).toBe("function");
	});

	test("injects a provider-scoped fetch into OpenAI Completions", async () => {
		await streamOpenAICompletions(
			model("openai", "openai-completions", `https://openai.runledger.test/${apiVersion}`),
			context,
			{ apiKey: "test-key", env: proxyEnv("OPENAI") },
		).result();

		expect(typeof asRecord(openAiOptions[0]).fetch).toBe("function");
	});

	test("injects a provider-scoped fetch into OpenAI Responses", async () => {
		await streamOpenAIResponses(
			model("openai", "openai-responses", `https://openai-responses.runledger.test/${apiVersion}`),
			context,
			{ apiKey: "test-key", env: proxyEnv("OPENAI") },
		).result();

		expect(typeof asRecord(openAiOptions[0]).fetch).toBe("function");
	});

	test("injects a provider-scoped fetch into Azure OpenAI", async () => {
		await streamAzure(
			model("azure-openai-responses", "azure-openai-responses", `https://azure.runledger.test/openai/${apiVersion}`),
			context,
			{ apiKey: "test-key", env: proxyEnv("AZURE_OPENAI_RESPONSES") },
		).result();

		expect(typeof asRecord(openAiOptions[0]).fetch).toBe("function");
	});

	test("injects a provider-scoped fetcher into Mistral's HTTP client", async () => {
		await streamMistral(
			model("mistral", "mistral-conversations", "https://mistral.runledger.test"),
			context,
			{ apiKey: "test-key", env: proxyEnv("MISTRAL") },
		).result();

		const options = asRecord(mistralOptions[0]);
		const httpClient = asRecord(options.httpClient);
		const httpClientOptions = asRecord(httpClient.options);
		expect(typeof httpClientOptions.fetcher).toBe("function");
	});

	test("injects a provider-scoped fetch into OpenRouter image generation", async () => {
		await generateImages(
			imagesModel("openrouter", `https://openrouter.runledger.test/api/${apiVersion}`),
			{ input: [{ type: "text", text: "test" }] },
			{ apiKey: "test-key", env: proxyEnv("OPENROUTER") },
		);

		expect(typeof asRecord(openAiOptions[0]).fetch).toBe("function");
	});
});
