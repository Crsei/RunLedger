/** Session-owned child model/router seam；不持有 credential 或 Agent state。 */

import type { Models } from "../../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelThinkingLevel,
	SimpleStreamOptions,
} from "../../types.ts";
import { createAssistantMessageEventStream } from "../../utils/event-stream.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import type { AgentTool, LlmContext, StreamFn } from "../types.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "../model-routing/types.ts";
import type { MultiAgentResult } from "./types.ts";

export interface ChildModelRequestRouter {
	route(request: ModelRouteRequest): ModelRouteDecision | Promise<ModelRouteDecision>;
}

export interface ChildModelSelection {
	readonly model?: Model<Api>;
	readonly thinkingLevel: ModelThinkingLevel;
}

export interface ChildModelPrepareInput {
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
}

export interface ChildModelRuntimeDescriptor {
	readonly providerId: string;
	readonly modelId: string;
	readonly profileId: string;
	readonly api: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly systemPromptDigest: RuntimeDigest;
	readonly toolManifestDigest: RuntimeDigest;
}

export interface PreparedChildModelRuntime {
	readonly model: Model<Api>;
	readonly tools: readonly AgentTool[];
	readonly descriptor: ChildModelRuntimeDescriptor;
	readonly streamFn: StreamFn;
}

export interface ChildModelRuntimeFactoryPort {
	prepare(input: ChildModelPrepareInput): Promise<MultiAgentResult<PreparedChildModelRuntime>>;
}

export interface ChildModelRuntimeFactoryOptions {
	readonly models: Models;
	readonly sessionId: string;
	readonly getSelection: () => ChildModelSelection;
	readonly modelRequestRouter?: ChildModelRequestRouter;
}

export function createChildModelRuntimeFactory(
	options: ChildModelRuntimeFactoryOptions,
): ChildModelRuntimeFactoryPort {
	return {
		prepare: async (input) => {
			const selection = options.getSelection();
			const model = selection.model;
			if (model === undefined) return failure("runtime_unavailable", "parent Session has no available model selection");
			const resolved = options.models.getModel(model.provider, model.id);
			if (resolved === undefined) return failure("runtime_unavailable", "selected child model is no longer available in the Session catalog");
			if (!Number.isSafeInteger(input.tools.length) || input.tools.some((tool) => tool.name.length === 0)) {
				return failure("invalid_request", "child model tool manifest is invalid");
			}
			const toolManifestDigest = runtimeDigest(input.tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})));
			const descriptor: ChildModelRuntimeDescriptor = Object.freeze({
				providerId: resolved.provider,
				modelId: resolved.id,
				profileId: `${resolved.provider}/${resolved.id}`,
				api: resolved.api,
				thinkingLevel: selection.thinkingLevel,
				systemPromptDigest: runtimeDigest(input.systemPrompt),
				toolManifestDigest,
			});
			return {
				ok: true,
				value: Object.freeze({
					model: resolved,
					tools: Object.freeze([...input.tools]),
					descriptor,
					streamFn: createSessionModelStreamFn({
						models: options.models,
						modelRequestRouter: options.modelRequestRouter,
						sessionId: options.sessionId,
					}),
				}),
			};
		},
	};
}

export function createSessionModelStreamFn(options: {
	readonly models: Models;
	readonly sessionId: string;
	readonly modelRequestRouter?: ChildModelRequestRouter;
}): StreamFn {
	return async (requestModel, context, streamOptions) => {
		if (options.modelRequestRouter !== undefined) {
			const request = createModelRouteRequest(options.sessionId, requestModel, context, streamOptions);
			const decision = await options.modelRequestRouter.route(request);
			if (decision.outcome !== "compatible") return deniedModelStream(requestModel, decision);
		}
		return options.models.streamSimple(requestModel, context as Context, streamOptions);
	};
}

function createModelRouteRequest(
	sessionId: string,
	model: Model<Api>,
	context: LlmContext,
	options?: SimpleStreamOptions,
): ModelRouteRequest {
	const contextBody = JSON.parse(JSON.stringify({
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		reasoning: options?.reasoning,
	})) as Record<string, unknown>;
	const requestKind = options?.metadata?.requestKind;
	const contextDigest = runtimeDigest(contextBody);
	const sideRequestId = typeof options?.metadata?.requestId === "string" ? options.metadata.requestId : undefined;
	const ownerGeneration = typeof options?.metadata?.ownerGeneration === "number" && Number.isSafeInteger(options.metadata.ownerGeneration)
		? options.metadata.ownerGeneration
		: undefined;
	const activityGeneration = typeof options?.metadata?.activityGeneration === "number" && Number.isSafeInteger(options.metadata.activityGeneration)
		? options.metadata.activityGeneration
		: undefined;
	const requestId = createRuntimeId("command", runtimeDigest({
		sessionId,
		model: `${model.provider}/${model.id}`,
		contextDigest,
		...(sideRequestId === undefined ? {} : { sideRequestId }),
		...(ownerGeneration === undefined ? {} : { ownerGeneration }),
		...(activityGeneration === undefined ? {} : { activityGeneration }),
	}).digest.slice(0, 48));
	const traceId = createRuntimeId("trace", runtimeDigest({ requestId, sessionId }).digest.slice(0, 48));
	const content = JSON.stringify(contextBody);
	return {
		requestId,
		operation: "request",
		...(requestKind === "interactive" || requestKind === "idle-recap" || requestKind === "auto-title" ? { requestKind } : {}),
		targetProfileId: `${model.provider}/${model.id}`,
		contextDigest,
		planDigest: runtimeDigest({ kind: "plan-state", sessionId }),
		resourceDigest: runtimeDigest(context.tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) ?? []),
		requiredContextTokens: Math.ceil(Buffer.byteLength(content, "utf8") / 3),
		requiredOutputTokens: options?.maxTokens ?? model.maxTokens,
		requiresTools: (context.tools?.length ?? 0) > 0,
		requiresReasoningReplay: context.messages.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "thinking")),
		requiresImages: context.messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "image")),
		traceId,
	};
}

function deniedModelStream(model: Model<Api>, decision: ModelRouteDecision) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage: `model route denied (${decision.reasonCode})`,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "error", reason: "error", error: message });
		stream.end(message);
	});
	return stream;
}

function failure<T>(code: "invalid_request" | "runtime_unavailable", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
