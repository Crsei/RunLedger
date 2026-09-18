/** Session-scoped, governed image-generation adapter. */

import type { ImagesModels } from "../../images-models.ts";
import type { ImageContent, ImagesApi, ImagesInputContent, ImagesModel, TextContent, Usage } from "../../types.ts";
import type { Network } from "../execution-env.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createWebSearchFetch } from "../../websource/transport.ts";

export const IMAGE_GENERATION_NETWORK_MAX_BYTES = 12 * 1024 * 1024;
export const IMAGE_GENERATION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_GENERATION_MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_GENERATION_MAX_IMAGES = 4;
export const IMAGE_GENERATION_MAX_TEXT_CHARS = 16_000;
export const IMAGE_GENERATION_MAX_INPUT_IMAGE_BYTES = 2 * 1024 * 1024;

export type ImageGenerationAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageGenerationSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageGenerationInputImage {
	readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
	readonly data: string;
}

export interface ImageGenerationRequest {
	readonly prompt: string;
	readonly model?: string;
	readonly aspectRatio?: ImageGenerationAspectRatio;
	readonly imageSize?: ImageGenerationSize;
	readonly inputImages?: readonly ImageGenerationInputImage[];
}

export interface ImageGenerationSuccess {
	readonly ok: true;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly provider: string;
	readonly model: string;
	readonly responseId?: string;
	readonly usage?: Usage;
	readonly responseDigest: RuntimeDigest;
	readonly imageCount: number;
}

export interface ImageGenerationFailure {
	readonly ok: false;
	readonly code: "aborted" | "model_not_found" | "credential_unavailable" | "network_unavailable" | "provider_error" | "provider_output_invalid" | "invalid_input";
	readonly message: string;
}

export type ImageGenerationResult = ImageGenerationSuccess | ImageGenerationFailure;

export interface ImageGenerationPort {
	generate(input: ImageGenerationRequest, signal?: AbortSignal): Promise<ImageGenerationResult>;
}

export interface ImageGenerationPortOptions {
	readonly images: ImagesModels;
	readonly network: Network;
}

/**
 * The only image-provider adapter exposed to an Agent tool. It resolves a
 * catalog model and credentials before calling the provider, and its injected
 * fetch can only reach the session's governed Network port.
 */
export function createImageGenerationPort(options: ImageGenerationPortOptions): ImageGenerationPort {
	const fetch = createWebSearchFetch({
		network: options.network,
		principal: "image_gen",
		maxBytes: IMAGE_GENERATION_NETWORK_MAX_BYTES,
	});
	return {
		async generate(input, signal): Promise<ImageGenerationResult> {
			if (isAborted(signal)) return failure("aborted", "Image generation was cancelled.");
			const normalized = normalizeInput(input);
			if (!normalized.ok) return normalized;
			const model = resolveModel(options.images, input.model);
			if (model === undefined) return failure("model_not_found", "The requested image model is not available in this host catalog.");
			try {
				const auth = await options.images.getAuth(model);
				if (auth === undefined) return failure("credential_unavailable", "No credential is configured for the selected image provider.");
				if (isAborted(signal)) return failure("aborted", "Image generation was cancelled.");
				const response = await options.images.generateImages(model, normalized.context, {
					signal,
					fetch,
					apiKey: auth.auth.apiKey,
					headers: auth.auth.headers,
					env: auth.env,
					maxRetries: 0,
				});
				if (response.stopReason === "aborted" || isAborted(signal)) return failure("aborted", "Image generation was cancelled.");
				if (response.stopReason !== "stop") {
					return failure(isNetworkError(response.errorMessage) ? "network_unavailable" : "provider_error", "The image provider could not complete the request.");
				}
				const output = projectOutput(response.output);
				if (!output.ok) return output;
				return {
					ok: true,
					content: output.content,
					provider: response.provider,
					model: response.model,
					...(response.responseId === undefined ? {} : { responseId: response.responseId }),
					...(response.usage === undefined ? {} : { usage: response.usage }),
					responseDigest: runtimeDigest({
						provider: response.provider,
						model: response.model,
						responseId: response.responseId ?? null,
						usage: response.usage ?? null,
						output: output.content.map(digestContent),
					}),
					imageCount: output.imageCount,
				};
			} catch (error) {
				if (isAborted(signal)) return failure("aborted", "Image generation was cancelled.");
				return failure(isNetworkError(error) ? "network_unavailable" : "provider_error", "The image provider could not complete the request.");
			}
		},
	};
}

function resolveModel(images: ImagesModels, modelId: string | undefined): ImagesModel<ImagesApi> | undefined {
	const catalog = images.getModels();
	if (modelId === undefined) return catalog[0];
	const matches = catalog.filter((candidate) => candidate.id === modelId);
	return matches.length === 1 ? matches[0] : undefined;
}

function normalizeInput(input: ImageGenerationRequest): { readonly ok: true; readonly context: { input: ImagesInputContent[] } } | ImageGenerationFailure {
	const prompt = input.prompt.trim();
	if (prompt.length === 0) return failure("invalid_input", "Image prompt must not be empty.");
	const imageInputs: ImageContent[] = [];
	let totalInputBytes = 0;
	for (const image of input.inputImages ?? []) {
		const bytes = decodeBase64(image.data);
		if (bytes === undefined || bytes.byteLength > IMAGE_GENERATION_MAX_INPUT_IMAGE_BYTES) {
			return failure("invalid_input", "An input image is not valid base64 data or exceeds the image size limit.");
		}
		totalInputBytes += bytes.byteLength;
		if (totalInputBytes > IMAGE_GENERATION_MAX_TOTAL_IMAGE_BYTES) {
			return failure("invalid_input", "Input images exceed the total image size limit.");
		}
		imageInputs.push({ type: "image", mimeType: image.mimeType, data: image.data });
	}
	if (imageInputs.length > IMAGE_GENERATION_MAX_IMAGES) return failure("invalid_input", "Too many input images were supplied.");
	const directions = [prompt];
	if (input.aspectRatio !== undefined) directions.push(`Requested aspect ratio: ${input.aspectRatio}.`);
	if (input.imageSize !== undefined) directions.push(`Requested image size: ${input.imageSize}.`);
	return { ok: true, context: { input: [{ type: "text", text: directions.join("\n\n") }, ...imageInputs] } };
}

function projectOutput(output: readonly (TextContent | ImageContent)[]): { readonly ok: true; readonly content: readonly (TextContent | ImageContent)[]; readonly imageCount: number } | ImageGenerationFailure {
	const content: (TextContent | ImageContent)[] = [];
	let imageCount = 0;
	let totalImageBytes = 0;
	for (const item of output) {
		if (item.type === "text") {
			if (item.text.length > 0) content.push({ type: "text", text: item.text.slice(0, IMAGE_GENERATION_MAX_TEXT_CHARS) });
			continue;
		}
		if (!isOutputMimeType(item.mimeType)) continue;
		const bytes = decodeBase64(item.data);
		if (bytes === undefined || bytes.byteLength > IMAGE_GENERATION_MAX_IMAGE_BYTES) {
			return failure("provider_output_invalid", "The image provider returned an invalid or oversized image.");
		}
		imageCount += 1;
		totalImageBytes += bytes.byteLength;
		if (imageCount > IMAGE_GENERATION_MAX_IMAGES || totalImageBytes > IMAGE_GENERATION_MAX_TOTAL_IMAGE_BYTES) {
			return failure("provider_output_invalid", "The image provider returned too much image data.");
		}
		content.push({ type: "image", mimeType: item.mimeType, data: item.data });
	}
	return imageCount === 0
		? failure("provider_output_invalid", "The image provider did not return a usable image.")
		: { ok: true, content, imageCount };
}

function decodeBase64(value: string): Buffer | undefined {
	if (value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return undefined;
	const bytes = Buffer.from(value, "base64");
	const normalized = value.replace(/=+$/, "");
	return bytes.toString("base64").replace(/=+$/, "") === normalized ? bytes : undefined;
}

function isOutputMimeType(value: string): value is ImageGenerationInputImage["mimeType"] {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function digestContent(item: TextContent | ImageContent): Record<string, unknown> {
	return item.type === "text"
		? { type: "text", digest: runtimeDigest(item.text).digest, chars: item.text.length }
		: { type: "image", mimeType: item.mimeType, digest: runtimeDigest(item.data).digest, bytes: Buffer.from(item.data, "base64").byteLength };
}

function failure(code: ImageGenerationFailure["code"], message: string): ImageGenerationFailure {
	return { ok: false, code, message };
}

function isNetworkError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return /network|fetch|request|denied/i.test(message);
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}
