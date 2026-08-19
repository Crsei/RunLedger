import { afterEach, describe, expect, test } from "vitest";
import { request as httpRequest } from "node:http";
import type { AssistantMessage, Api, Context, Model, Provider, StreamOptions } from "../../src/types.ts";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { createModels, type MutableModels } from "../../src/models.ts";
import { createAssistantMessageEventStream, AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { startAuthGatewayServer, type AuthGatewayServerHandle } from "../../src/auth-gateway/server.ts";

const openServers: AuthGatewayServerHandle[] = [];

afterEach(async () => {
	await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function fixtureModel(id = "fixture-model"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	};
}

function assistant(model: Model<Api>, content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function completedStream(model: Model<Api>, text = "pong"): AssistantMessageEventStream {
	const message = assistant(model, [{ type: "text", text }]);
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "text_start", contentIndex: 0, partial: message });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

type FixtureOptions = {
	readonly credential?: string;
	readonly stream?: (model: Model<Api>, context: Context, options: StreamOptions | undefined) => AssistantMessageEventStream;
	readonly streamSimple?: (model: Model<Api>, context: Context, options: StreamOptions | undefined) => AssistantMessageEventStream;
};

function fixtureModels(options: FixtureOptions = {}): MutableModels {
	const model = fixtureModel();
	const models = createModels({
		credentials: AuthStorage.inMemory(options.credential === undefined ? {} : { fixture: { type: "api_key", key: options.credential } }),
	});
	const provider: Provider = {
		id: "fixture",
		name: "Fixture",
		auth: {
			apiKey: {
				name: "Fixture key",
				resolve: async ({ credential }) => credential?.key === undefined ? undefined : { auth: { apiKey: credential.key }, source: "fixture credential" },
			},
		},
		getModels: () => [model],
		stream: (requestModel, context, streamOptions) => options.stream?.(requestModel, context, streamOptions) ?? completedStream(requestModel),
		streamSimple: (requestModel, context, streamOptions) => options.streamSimple?.(requestModel, context, streamOptions) ?? completedStream(requestModel),
	};
	models.setProvider(provider);
	return models;
}

function duplicateFixtureModels(configuredProviderIds: readonly string[]): MutableModels {
	const credentials = Object.fromEntries(
		configuredProviderIds.map((providerId) => [providerId, { type: "api_key" as const, key: `${providerId}-secret` }]),
	);
	const models = createModels({ credentials: AuthStorage.inMemory(credentials) });
	for (const providerId of ["fixture-a", "fixture-b"]) {
		const model = { ...fixtureModel("shared-model"), provider: providerId };
		models.setProvider({
			id: providerId,
			name: providerId,
			auth: {
				apiKey: {
					name: `${providerId} key`,
					resolve: async ({ credential }) => credential?.key === undefined
						? undefined
						: { auth: { apiKey: credential.key }, source: "fixture credential" },
				},
			},
			getModels: () => [model],
			stream: (requestModel) => completedStream(requestModel),
			streamSimple: (requestModel) => completedStream(requestModel),
		});
	}
	return models;
}

async function open(models: MutableModels): Promise<AuthGatewayServerHandle> {
	const server = await startAuthGatewayServer({ bindHost: "127.0.0.1", port: 0, token: "gateway-secret", models });
	openServers.push(server);
	return server;
}

function url(server: AuthGatewayServerHandle, path: string): string {
	return `http://127.0.0.1:${server.port}${path}`;
}

async function post(server: AuthGatewayServerHandle, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
	return fetch(url(server, path), {
		method: "POST",
		headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
}

describe("auth-gateway model dispatch", () => {
	test.each([
		["/v1/chat/completions", { model: "fixture-model", messages: [{ role: "user", content: "ping" }] }, "pong"],
		["/v1/messages", { model: "fixture-model", max_tokens: 32, messages: [{ role: "user", content: "ping" }] }, "message_start"],
		["/v1/responses", { model: "fixture-model", input: "ping" }, "response.created"],
		["/messages", { model: "fixture-model", context: { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, options: {}, stream: true }, '"type":"start"'],
		["/v1/pi/stream", { model: "fixture-model", context: { messages: [{ role: "user", content: "ping", timestamp: 1 }] }, options: {}, stream: true }, '"type":"start"'],
	] as const)("dispatches %s through the configured provider and re-encodes its stream", async (path, body, marker) => {
		const server = await open(fixtureModels({ credential: "upstream-secret" }));
		const response = await post(server, path, body);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toMatch(/text\/event-stream/i);
		const text = await response.text();
		expect(text).toContain(marker);
		expect(text).not.toContain("upstream-secret");
	});

	test("accepts provider/model and bare model ids while keeping credentials in the provider options", async () => {
		const seen: Array<{ model: string; apiKey: string | undefined }> = [];
		const server = await open(fixtureModels({
			credential: "upstream-secret",
			streamSimple: (model, _context, streamOptions) => {
				seen.push({ model: model.id, apiKey: streamOptions?.apiKey });
				return completedStream(model);
			},
		}));

		const composite = await post(server, "/v1/chat/completions", { model: "fixture/fixture-model", messages: [{ role: "user", content: "ping" }] });
		const bare = await post(server, "/v1/chat/completions", { model: "fixture-model", messages: [{ role: "user", content: "ping" }] });

		expect(composite.status).toBe(200);
		expect(bare.status).toBe(200);
		expect(seen).toEqual([{ model: "fixture-model", apiKey: "upstream-secret" }, { model: "fixture-model", apiKey: "upstream-secret" }]);
	});

	test("rejects an ambiguous bare model id and accepts an explicit provider/model id", async () => {
		const server = await open(duplicateFixtureModels(["fixture-a", "fixture-b"]));

		const ambiguous = await post(server, "/v1/chat/completions", {
			model: "shared-model",
			messages: [{ role: "user", content: "ping" }],
		});
		const explicit = await post(server, "/v1/chat/completions", {
			model: "fixture-b/shared-model",
			messages: [{ role: "user", content: "ping" }],
		});
		const catalog = await fetch(url(server, "/v1/models"), {
			headers: { authorization: "Bearer gateway-secret" },
		});

		expect(ambiguous.status).toBe(400);
		expect(await ambiguous.json()).toMatchObject({ error: { code: "ambiguous_model" } });
		expect(explicit.status).toBe(200);
		expect(await catalog.json()).toMatchObject({
			data: [
				{ id: "fixture-a/shared-model", owned_by: "fixture-a" },
				{ id: "fixture-b/shared-model", owned_by: "fixture-b" },
			],
		});
	});

	test("accepts a duplicated bare model id when exactly one provider is available", async () => {
		const server = await open(duplicateFixtureModels(["fixture-b"]));

		const response = await post(server, "/v1/chat/completions", {
			model: "shared-model",
			messages: [{ role: "user", content: "ping" }],
		});

		expect(response.status).toBe(200);
	});

	test("lists only models whose provider credentials resolve", async () => {
		const server = await open(fixtureModels({ credential: "upstream-secret" }));
		const response = await fetch(url(server, "/v1/models"), { headers: { authorization: "Bearer gateway-secret" } });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ object: "list", data: [{ id: "fixture-model", object: "model", owned_by: "fixture" }] });
	});

	test("maps malformed input, missing auth, and unknown models to wire errors", async () => {
		const server = await open(fixtureModels({ credential: "upstream-secret" }));
		const malformed = await post(server, "/v1/chat/completions", { model: "fixture-model" });
		const unknown = await post(server, "/v1/messages", { model: "fixture/missing", messages: [{ role: "user", content: "ping" }] });
		const missingAuth = await open(fixtureModels());
		const unauthorizedProvider = await post(missingAuth, "/v1/responses", { model: "fixture-model", input: "ping" });

		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: { type: "invalid_request_error" } });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: { code: "model_not_found" } });
		expect(unauthorizedProvider.status).toBe(401);
		expect(await unauthorizedProvider.json()).toMatchObject({ error: { type: "authentication_error" } });
	});

	test("maps a provider stream setup failure to a 502 wire error before SSE starts", async () => {
		const server = await open(fixtureModels({
			credential: "upstream-secret",
			streamSimple: (model) => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "error", reason: "error", error: { ...assistant(model), stopReason: "error", errorMessage: "upstream failed upstream-secret" } });
				return stream;
			},
		}));
		const response = await post(server, "/v1/chat/completions", { model: "fixture-model", messages: [{ role: "user", content: "ping" }] });

		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ error: { type: "upstream_error", message: "upstream failed [redacted]" } });
	});

	test("redacts provider credentials from an error emitted after SSE starts", async () => {
		const credential = 'upstream-"secret';
		const server = await open(fixtureModels({
			credential,
			streamSimple: (model) => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: assistant(model) });
				stream.push({
					type: "error",
					reason: "error",
					error: {
						...assistant(model),
						stopReason: "error",
						errorMessage: `upstream echoed ${credential}`,
					},
				});
				return stream;
			},
		}));

		const response = await post(server, "/v1/chat/completions", {
			model: "fixture-model",
			messages: [{ role: "user", content: "ping" }],
		});
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(body).toContain("upstream echoed [redacted]");
		expect(body).not.toContain(JSON.stringify(credential).slice(1, -1));
	});

	test("propagates client disconnect abort to the provider stream", async () => {
		let observedSignal: AbortSignal | undefined;
		let release: (() => void) | undefined;
		const released = new Promise<void>((resolve) => { release = resolve; });
		const server = await open(fixtureModels({
			credential: "upstream-secret",
			streamSimple: (model, _context, streamOptions) => {
				const signal = streamOptions?.signal;
				observedSignal = signal;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: assistant(model) });
				signal?.addEventListener("abort", () => {
					release?.();
					stream.push({ type: "error", reason: "aborted", error: { ...assistant(model), stopReason: "aborted", errorMessage: "Request aborted" } });
				}, { once: true });
				return stream;
			},
		}));
		await new Promise<void>((resolve, reject) => {
			const client = httpRequest({
				host: "127.0.0.1",
				port: server.port,
				path: "/v1/chat/completions",
				method: "POST",
				headers: { authorization: "Bearer gateway-secret", "content-type": "application/json" },
			}, (response) => {
				response.once("data", () => {
					client.destroy();
					resolve();
				});
			});
			client.once("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "ECONNRESET") reject(error);
			});
			client.end(JSON.stringify({ model: "fixture-model", messages: [{ role: "user", content: "ping" }] }));
		});

		await expect(Promise.race([
			released,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort was not propagated")), 2_000)),
		])).resolves.toBeUndefined();
		expect(observedSignal?.aborted).toBe(true);
	});

	test("aborts an in-flight provider stream when the gateway closes", async () => {
		let observedSignal: AbortSignal | undefined;
		let released: (() => void) | undefined;
		const providerReleased = new Promise<void>((resolve) => { released = resolve; });
		const server = await open(fixtureModels({
			credential: "upstream-secret",
			streamSimple: (model, _context, streamOptions) => {
				observedSignal = streamOptions?.signal;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "start", partial: assistant(model) });
				streamOptions?.signal?.addEventListener("abort", () => {
					released?.();
					stream.push({ type: "error", reason: "aborted", error: { ...assistant(model), stopReason: "aborted", errorMessage: "Request aborted" } });
				}, { once: true });
				return stream;
			},
		}));
		const response = await post(server, "/v1/chat/completions", { model: "fixture-model", messages: [{ role: "user", content: "ping" }] });
		expect(response.status).toBe(200);

		const closing = server.close();
		try {
			await expect(Promise.race([
				providerReleased,
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gateway close did not abort the provider")), 1_000)),
			])).resolves.toBeUndefined();
			await response.body?.cancel();
			await closing;
		} finally {
			await response.body?.cancel();
			await closing;
		}
		expect(observedSignal?.aborted).toBe(true);
	});

	test("keeps a long-thinking stream alive while SSE activity stays below the idle timeout", async () => {
		const server = await startAuthGatewayServer({
			bindHost: "127.0.0.1",
			port: 0,
			token: "gateway-secret",
			idleTimeoutMs: 80,
			models: fixtureModels({
				credential: "upstream-secret",
				streamSimple: (model) => {
					const stream = createAssistantMessageEventStream();
					const partial = assistant(model);
					stream.push({ type: "start", partial });
					setTimeout(() => stream.push({ type: "thinking_start", contentIndex: 0, partial }), 20);
					setTimeout(() => stream.push({ type: "thinking_delta", contentIndex: 0, delta: "reasoning", partial }), 45);
					setTimeout(() => stream.push({ type: "thinking_end", contentIndex: 0, content: "reasoning", partial }), 70);
					setTimeout(() => stream.push({ type: "done", reason: "stop", message: partial }), 110);
					return stream;
				},
			}),
		});
		openServers.push(server);
		const response = await post(server, "/v1/chat/completions", { model: "fixture-model", messages: [{ role: "user", content: "think" }] });

		const text = await response.text();
		expect(response.status, text).toBe(200);
		expect(text).toContain("reasoning");
		expect(text).toContain("data: [DONE]");
	});
});
