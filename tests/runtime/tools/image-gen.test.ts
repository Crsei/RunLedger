import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import type { ImagesModels } from "../../../src/images-models.ts";
import type { ImagesContext, ImagesModel, ImagesOptions } from "../../../src/types.ts";
import type { Network, NetworkRequest } from "../../../src/runtime/execution-env.ts";
import { evaluatePlanModeCapabilities } from "../../../src/runtime/modes/plan/policy.ts";
import { createImageGenerationTool, imageGenSchema } from "../../../src/runtime/tools/image-gen.ts";
import {
	createImageGenerationPort,
	IMAGE_GENERATION_MAX_IMAGE_BYTES,
} from "../../../src/runtime/tools/image-generation-port.ts";
import { createStdlibTools } from "../../../src/runtime/tools/index.ts";

const MODEL: ImagesModel<"openrouter-images"> = {
	id: "example/image-model",
	name: "Example image model",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://images.example/v1",
	input: ["text", "image"],
	output: ["image", "text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

interface FakeImagesOptions {
	readonly credential?: boolean;
	readonly generate?: (model: ImagesModel<"openrouter-images">, context: ImagesContext, options?: ImagesOptions) => Promise<ReturnType<ImagesModels["generateImages"]> extends Promise<infer Output> ? Output : never>;
}

function fakeImages(options: FakeImagesOptions = {}): ImagesModels {
	return {
		getProviders: () => [],
		getProvider: () => undefined,
		getModels: () => [MODEL],
		getModel: (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : undefined,
		refresh: async () => undefined,
		getAuth: async () => options.credential === false ? undefined : { auth: { apiKey: "test-secret" }, source: "test" },
		generateImages: async (model, context, requestOptions) => options.generate === undefined
			? {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [{ type: "image", mimeType: "image/png", data: "AQID" }],
				stopReason: "stop",
				timestamp: 1,
			}
			: options.generate(model as ImagesModel<"openrouter-images">, context, requestOptions),
	};
}

function recordedNetwork(requests: NetworkRequest[], behavior: "ok" | "deny" = "ok"): Network {
	return {
		request: async (request) => {
			requests.push(request);
			if (behavior === "deny") throw new Error("network policy denied image request");
			return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}"), finalUrl: request.url };
		},
	};
}

describe("image_gen", () => {
	it("has a closed schema and projects catalog output over the image_gen network principal", async () => {
		expect(Value.Check(imageGenSchema, { prompt: "A paper kite", aspect_ratio: "16:9", image_size: "1536x1024", input_images: [{ mime_type: "image/png", data: "AQID" }] })).toBe(true);
		expect(Value.Check(imageGenSchema, { prompt: "A kite", provider_options: { raw: true } })).toBe(false);

		const requests: NetworkRequest[] = [];
		let received: ImagesContext | undefined;
		const images = fakeImages({
			generate: async (model, context, options) => {
				received = context;
				await options?.fetch?.("https://images.example/v1/generate", { method: "POST", body: "{}" });
				return {
					api: model.api, provider: model.provider, model: model.id, responseId: "response-1",
					usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					output: [{ type: "text", text: "A bright kite." }, { type: "image", mimeType: "image/png", data: "AQID" }],
					stopReason: "stop", timestamp: 1,
				};
			},
		});
		const tool = createImageGenerationTool(createImageGenerationPort({ images, network: recordedNetwork(requests) }));
		const result = await tool.execute("image-1", { prompt: "A paper kite", aspect_ratio: "16:9", image_size: "1536x1024", input_images: [{ mime_type: "image/png", data: "AQID" }] });

		expect(received?.input[0]).toEqual({ type: "text", text: "A paper kite\n\nRequested aspect ratio: 16:9.\n\nRequested image size: 1536x1024." });
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ principal: "image_gen", method: "POST" });
		expect(result).toMatchObject({ details: { ok: true, provider: "openrouter", model: MODEL.id, responseId: "response-1", imageCount: 1 } });
		expect(result.content).toEqual([{ type: "text", text: "A bright kite." }, { type: "image", mimeType: "image/png", data: "AQID" }]);

		const registry = createStdlibTools("/workspace", { imageGeneration: createImageGenerationPort({ images, network: recordedNetwork([]) }) });
		expect(registry.get("image_gen")?.capabilityClaims?.[0]?.name).toBe("network");
		expect(evaluatePlanModeCapabilities({ state: undefined, claims: registry.get("image_gen")?.capabilityClaims ?? [], enforceReadonly: true }))
			.toMatchObject({ decision: "deny" });
	});

	it("fails catalog and credential lookups without dispatching a network request", async () => {
		const requests: NetworkRequest[] = [];
		const noModel = createImageGenerationTool(createImageGenerationPort({ images: fakeImages(), network: recordedNetwork(requests) }));
		const missing = await noModel.execute("missing", { prompt: "A lantern", model: "missing-model" });
		expect(missing).toMatchObject({ isError: true, details: { ok: false, code: "model_not_found" } });
		expect(requests).toHaveLength(0);

		const noCredential = createImageGenerationTool(createImageGenerationPort({ images: fakeImages({ credential: false }), network: recordedNetwork(requests) }));
		const unavailable = await noCredential.execute("credential", { prompt: "A lantern" });
		expect(unavailable).toMatchObject({ isError: true, details: { ok: false, code: "credential_unavailable" } });
		expect(requests).toHaveLength(0);
	});

	it("maps a governed network denial and cancellation to bounded errors", async () => {
		const denied = createImageGenerationTool(createImageGenerationPort({
			images: fakeImages({ generate: async (_model, _context, options) => {
				await options?.fetch?.("https://images.example/v1/generate", { method: "POST" });
				return {
					api: MODEL.api, provider: MODEL.provider, model: MODEL.id, output: [],
					stopReason: "error", errorMessage: "network policy denied image request", timestamp: 1,
				};
			} }),
			network: recordedNetwork([], "deny"),
		}));
		const deniedResult = await denied.execute("denied", { prompt: "A lantern" });
		expect(deniedResult).toMatchObject({ isError: true, details: { ok: false, code: "network_unavailable" } });
		expect((deniedResult.content[0] as { text: string }).text).not.toContain("network policy denied");

		const abort = new AbortController();
		abort.abort();
		const cancelled = await denied.execute("aborted", { prompt: "A lantern" }, abort.signal);
		expect(cancelled).toMatchObject({ isError: true, details: { ok: false, code: "aborted" } });
	});

	it("rejects invalid base64 and oversized provider image output", async () => {
		const requests: NetworkRequest[] = [];
		const invalidInput = createImageGenerationTool(createImageGenerationPort({ images: fakeImages(), network: recordedNetwork(requests) }));
		const invalid = await invalidInput.execute("invalid", { prompt: "A lantern", input_images: [{ mime_type: "image/png", data: "bad?" }] });
		expect(invalid).toMatchObject({ isError: true, details: { ok: false, code: "invalid_input" } });
		expect(requests).toHaveLength(0);

		const oversized = createImageGenerationTool(createImageGenerationPort({
			images: fakeImages({ generate: async (model) => ({
				api: model.api, provider: model.provider, model: model.id,
				output: [{ type: "image", mimeType: "image/png", data: Buffer.alloc(IMAGE_GENERATION_MAX_IMAGE_BYTES + 1).toString("base64") }],
				stopReason: "stop", timestamp: 1,
			}) }),
			network: recordedNetwork([]),
		}));
		const oversizedResult = await oversized.execute("oversized", { prompt: "A lantern" });
		expect(oversizedResult).toMatchObject({ isError: true, details: { ok: false, code: "provider_output_invalid" } });
	});
});
