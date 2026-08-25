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
import { applyRetryPolicy, type RetryPolicy } from "../retry/policy.ts";
import type { ProviderPolicyProjection } from "../../storage/settings-policies.ts";

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
	readonly retryPolicy?: RetryPolicy;
	readonly providerPolicy?: ProviderPolicyProjection;
	readonly getRetryPolicy?: () => RetryPolicy | undefined;
	readonly getProviderPolicy?: () => ProviderPolicyProjection | undefined;
	readonly providerGate?: ProviderRequestGate;
}

export interface ProviderRequestGate {
	acquire(provider: string, signal?: AbortSignal): Promise<() => void>;
	reconfigure?(policy?: ProviderPolicyProjection): void;
}

export function createProviderRequestGate(policy?: ProviderPolicyProjection): ProviderRequestGate {
	return new ProviderRequestGateImpl(policy);
}

export function createChildModelRuntimeFactory(
	options: ChildModelRuntimeFactoryOptions,
): ChildModelRuntimeFactoryPort {
	return {
		prepare: async (input) => {
			const retryPolicy = options.getRetryPolicy?.() ?? options.retryPolicy;
			const providerPolicy = options.getProviderPolicy?.() ?? options.providerPolicy;
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
						retryPolicy,
						providerPolicy,
						providerGate: options.providerGate,
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
	readonly retryPolicy?: RetryPolicy;
	readonly providerPolicy?: ProviderPolicyProjection;
	readonly providerGate?: ProviderRequestGate;
}): StreamFn {
	const providerGate = options.providerGate ?? createProviderRequestGate(options.providerPolicy);
	return async (requestModel, context, streamOptions) => {
		if (options.providerPolicy?.disabledProviders?.includes(requestModel.provider)) {
			return deniedModelStream(requestModel, {
				requestId: createRuntimeId("command", runtimeDigest({ sessionId: options.sessionId, provider: requestModel.provider, model: requestModel.id }).digest.slice(0, 48)),
				outcome: "deny",
				targetProviderId: requestModel.provider,
				targetModelId: requestModel.id,
				targetProfileId: `${requestModel.provider}/${requestModel.id}`,
				manifestDigest: runtimeDigest({}),
				reasonCode: "provider_disabled_by_settings",
				diagnostics: [],
				decisionDigest: runtimeDigest({ reason: "provider_disabled_by_settings", provider: requestModel.provider }),
			});
		}
		if (options.modelRequestRouter !== undefined) {
			const request = createModelRouteRequest(options.sessionId, requestModel, context, streamOptions);
			const decision = await options.modelRequestRouter.route(request);
			if (decision.outcome !== "compatible") return deniedModelStream(requestModel, decision);
		}
		const effectiveOptions = options.retryPolicy === undefined
			? streamOptions
			: applyRetryPolicy(streamOptions ?? {}, options.retryPolicy);
		const release = await providerGate.acquire(requestModel.provider, streamOptions?.signal);
		try {
			const stream = options.models.streamSimple(requestModel, context as Context, effectiveOptions);
			void stream.result().then(release, release);
			return stream;
		} catch (error) {
			release();
			throw error;
		}
	};
}

interface ProviderWaiter {
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: Error) => void;
	readonly signal?: AbortSignal;
	onAbort?: () => void;
}

/** Session-owned provider semaphore；只限制请求数，不改变任何授权或路由决定。 */
class ProviderRequestGateImpl implements ProviderRequestGate {
	#limits: Readonly<Record<string, number>>;
	readonly #active = new Map<string, number>();
	readonly #waiters = new Map<string, ProviderWaiter[]>();

	public constructor(policy: ProviderPolicyProjection | undefined) {
		this.#limits = Object.freeze({ ...(policy?.maxInFlightRequests ?? {}) });
	}

	public reconfigure(policy?: ProviderPolicyProjection): void {
		this.#limits = Object.freeze({ ...(policy?.maxInFlightRequests ?? {}) });
		for (const provider of this.#waiters.keys()) this.drain(provider);
	}

	public acquire(provider: string, signal?: AbortSignal): Promise<() => void> {
		const limit = this.#limits[provider];
		if (limit === undefined) return Promise.resolve(() => undefined);
		if (signal?.aborted === true) return Promise.reject(new Error("provider concurrency wait aborted"));
		const active = this.#active.get(provider) ?? 0;
		if (active < limit) {
			this.#active.set(provider, active + 1);
			return Promise.resolve(this.releaseOnce(provider));
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter: ProviderWaiter = { resolve, reject, ...(signal === undefined ? {} : { signal }) };
			const onAbort = (): void => {
				const queue = this.#waiters.get(provider);
				if (queue !== undefined) {
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
					if (queue.length === 0) this.#waiters.delete(provider);
				}
				reject(new Error("provider concurrency wait aborted"));
			};
			waiter.onAbort = onAbort;
			signal?.addEventListener("abort", onAbort, { once: true });
			const queue = this.#waiters.get(provider) ?? [];
			queue.push(waiter);
			this.#waiters.set(provider, queue);
		});
	}

	private releaseOnce(provider: string): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const active = this.#active.get(provider) ?? 0;
			if (active <= 1) this.#active.delete(provider);
			else this.#active.set(provider, active - 1);
			this.drain(provider);
		};
	}

	private drain(provider: string): void {
		const limit = this.#limits[provider];
		const queue = this.#waiters.get(provider);
		if (queue === undefined) return;
		if (limit === undefined) {
			this.#waiters.delete(provider);
			for (const waiter of queue) {
				waiter.signal?.removeEventListener("abort", waiter.onAbort!);
				waiter.resolve(() => undefined);
			}
			return;
		}
		let active = this.#active.get(provider) ?? 0;
		while (active < limit && queue.length > 0) {
			const waiter = queue.shift();
			if (waiter === undefined) break;
			if (waiter.signal?.aborted === true) {
				waiter.reject(new Error("provider concurrency wait aborted"));
				continue;
			}
			waiter.signal?.removeEventListener("abort", waiter.onAbort!);
			active += 1;
			this.#active.set(provider, active);
			waiter.resolve(this.releaseOnce(provider));
		}
		if (queue.length === 0) this.#waiters.delete(provider);
	}
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
