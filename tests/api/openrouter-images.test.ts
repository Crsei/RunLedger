import { describe, expect, it } from "vitest";
import { generateImages } from "../../src/api/openrouter-images.ts";
import type { ImagesModel } from "../../src/types.ts";

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

describe("openrouter image API", () => {
	it("uses the injected governed fetch adapter and decodes text plus base64 images", async () => {
		const requests: Array<{ url: string; body: string | undefined }> = [];
		const result = await generateImages(MODEL, { input: [{ type: "text", text: "A green kite" }] }, {
			apiKey: "test-key",
			fetch: async (input, init) => {
				requests.push({ url: input, body: typeof init?.body === "string" ? init.body : undefined });
				return Response.json({
					id: "response-1",
					choices: [{ message: { content: "A green kite.", images: [{ image_url: { url: "data:image/png;base64,AQID" } }] } }],
				});
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://images.example/v1/chat/completions");
		expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ model: MODEL.id, modalities: ["image", "text"] });
		expect(result).toMatchObject({ stopReason: "stop", responseId: "response-1" });
		expect(result.output).toEqual([{ type: "text", text: "A green kite." }, { type: "image", mimeType: "image/png", data: "AQID" }]);
	});
});
