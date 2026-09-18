/** Agent-facing, bounded image generation tool. */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import {
	IMAGE_GENERATION_MAX_IMAGES,
	IMAGE_GENERATION_MAX_INPUT_IMAGE_BYTES,
	type ImageGenerationPort,
	type ImageGenerationResult,
	type ImageGenerationRequest,
} from "./image-generation-port.ts";

const inputImageSchema = Type.Object({
	mime_type: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg"), Type.Literal("image/webp")]),
	data: Type.String({ minLength: 4, maxLength: Math.ceil(IMAGE_GENERATION_MAX_INPUT_IMAGE_BYTES / 3) * 4 }),
}, { additionalProperties: false });

export const imageGenSchema = Type.Object({
	prompt: Type.String({ minLength: 1, maxLength: 8_000, description: "What to generate." }),
	model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact image model id from the host catalog." })),
	aspect_ratio: Type.Optional(Type.Union([Type.Literal("1:1"), Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("4:3"), Type.Literal("3:4")])),
	image_size: Type.Optional(Type.Union([Type.Literal("1024x1024"), Type.Literal("1536x1024"), Type.Literal("1024x1536")])),
	input_images: Type.Optional(Type.Array(inputImageSchema, { maxItems: IMAGE_GENERATION_MAX_IMAGES })),
}, { additionalProperties: false });

export type ImageGenToolInput = Static<typeof imageGenSchema>;

export function createImageGenerationTool(port?: ImageGenerationPort): AgentTool<typeof imageGenSchema, ImageGenerationResult> {
	return {
		name: "image_gen",
		label: "Generate Image",
		description: "Generate an image with a model from the host image catalog. Optional reference images are base64 data and are sent only to the selected provider through the governed network policy.",
		parameters: imageGenSchema,
		isConcurrencySafe: () => false,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<ImageGenerationResult>> {
			const unavailable: ImageGenerationResult = { ok: false, code: "network_unavailable", message: "Image generation is unavailable in this session." };
			const result: ImageGenerationResult = port === undefined ? unavailable : await port.generate(toPortRequest(params), signal);
			return result.ok
				? {
					content: [...result.content],
					details: result,
				}
				: {
					content: [{ type: "text", text: `image_gen failed: ${result.code}.` }],
					details: result,
					isError: true,
				};
		},
	};
}

function toPortRequest(params: ImageGenToolInput): ImageGenerationRequest {
	return {
		prompt: params.prompt,
		...(params.model === undefined ? {} : { model: params.model }),
		...(params.aspect_ratio === undefined ? {} : { aspectRatio: params.aspect_ratio }),
		...(params.image_size === undefined ? {} : { imageSize: params.image_size }),
		...(params.input_images === undefined ? {} : {
			inputImages: params.input_images.map((image) => ({ mimeType: image.mime_type, data: image.data })),
		}),
	};
}
