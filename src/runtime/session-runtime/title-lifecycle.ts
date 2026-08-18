/** Same-model, non-transcript asynchronous Session title lifecycle. */

import type { Models } from "../../models.ts";
import type { Api, Context, Model, ModelThinkingLevel } from "../../types.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import type { ModelRouteRequest } from "../model-routing/types.ts";
import type { ChildModelRequestRouter } from "../agents/child-model-runtime.ts";
import { assistantTextForSessionTitle, isLowSignalTitleInput, normalizeGeneratedSessionTitle, SESSION_TITLE_SYSTEM_PROMPT } from "./title-generator.ts";

export interface SessionTitleLifecycleSelection {
	readonly model?: Model<Api>;
	readonly thinkingLevel?: ModelThinkingLevel;
}

export interface SessionTitleLifecycleOptions {
	readonly sessionId: string;
	readonly fence: OwnerFence;
	readonly models: Models;
	readonly getSelection: () => SessionTitleLifecycleSelection;
	readonly getCurrentTitle: () => string | undefined;
	readonly setAutoTitle: (input: {
		readonly title: string;
		readonly expectedTitle: null;
		readonly providerId: string;
		readonly modelId: string;
		readonly trigger: "first-user-message" | "retry";
	}) => void;
	readonly modelRequestRouter?: ChildModelRequestRouter;
	readonly enabled?: boolean;
	readonly timeoutMs?: number;
	readonly onFailure?: (reason: "no-model" | "low-signal" | "command" | "busy" | "cancelled" | "provider-error" | "empty" | "invalid-output" | "stale") => void;
}

const DEFAULT_TITLE_TIMEOUT_MS = 12_000;

export class SessionTitleLifecycle {
	private readonly options: SessionTitleLifecycleOptions;
	private request: { readonly controller: AbortController; readonly modelKey: string; cancellationReported?: boolean } | undefined;
	private attemptedGeneration = false;
	private disposed = false;

	public constructor(options: SessionTitleLifecycleOptions) {
		this.options = options;
	}

	/** Fire-and-forget entry point called after prompt admission and hook success. */
	public handleAcceptedInput(input: string): void {
		void this.generate(input);
	}

	public dispose(): void {
		this.disposed = true;
		this.request?.controller.abort();
		this.request = undefined;
	}

	/** Called by the controller after a model selection mutation; stale title work is cancelled immediately. */
	public selectionChanged(): void {
		const request = this.request;
		if (request === undefined) return;
		request.cancellationReported = true;
		this.request = undefined;
		request.controller.abort();
		this.options.onFailure?.("cancelled");
	}

	private async generate(input: string): Promise<void> {
		if (this.disposed || this.options.enabled === false) return;
		if (this.options.getCurrentTitle() !== undefined) return;
		if (isLowSignalTitleInput(input)) {
			this.options.onFailure?.("low-signal");
			return;
		}
		if (/^\s*\//u.test(input)) {
			this.options.onFailure?.("command");
			return;
		}
		const selection = this.options.getSelection();
		const model = selection.model;
		if (model === undefined) {
			this.options.onFailure?.("no-model");
			return;
		}
		const modelKey = `${model.provider}/${model.id}`;
		if (this.request !== undefined) {
			this.options.onFailure?.("busy");
			return;
		}
		const trigger = this.attemptedGeneration ? "retry" : "first-user-message";
		this.attemptedGeneration = true;
		const controller = new AbortController();
		const request: { readonly controller: AbortController; readonly modelKey: string; cancellationReported?: boolean } = { controller, modelKey };
		this.request = request;
		const timeoutMs = this.options.timeoutMs ?? DEFAULT_TITLE_TIMEOUT_MS;
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const context: Context = {
				systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: `<user>${input}</user>`, timestamp: Date.now() }],
				// Explicitly no tools: this is not an Agent turn.
				tools: [],
			};
			if (this.options.modelRequestRouter !== undefined) {
				const decision = await this.options.modelRequestRouter.route(createSessionTitleRouteRequest(this.options.sessionId, model, context));
				if (decision.outcome !== "compatible") {
					this.options.onFailure?.("provider-error");
					return;
				}
			}
			const completion = await Promise.race([
				this.options.models.completeSimple(model, context, {
					signal: controller.signal,
					maxTokens: 64,
					temperature: 0,
					reasoning: "minimal",
					timeoutMs,
				}),
				abortOnSignal(controller.signal),
			]);
			if (this.disposed || controller.signal.aborted) {
				this.options.onFailure?.("cancelled");
				return;
			}
			const currentSelection = this.options.getSelection();
			if (currentSelection.model === undefined || `${currentSelection.model.provider}/${currentSelection.model.id}` !== modelKey) {
				this.options.onFailure?.("stale");
				return;
			}
			if (this.options.getCurrentTitle() !== undefined) {
				this.options.onFailure?.("stale");
				return;
			}
			if (completion.stopReason !== "stop") {
				this.options.onFailure?.("invalid-output");
				return;
			}
			const title = normalizeGeneratedSessionTitle(assistantTextForSessionTitle(completion));
			if (title === null) {
				this.options.onFailure?.("empty");
				return;
			}
			this.options.setAutoTitle({
				title,
				expectedTitle: null,
				providerId: model.provider,
				modelId: model.id,
				trigger,
			});
		} catch (error) {
			if (!(controller.signal.aborted && request.cancellationReported)) {
				this.options.onFailure?.(controller.signal.aborted ? "cancelled" : "provider-error");
			}
			void error;
		} finally {
			clearTimeout(timeout);
			if (this.request?.controller === controller) this.request = undefined;
		}
	}
}

function createSessionTitleRouteRequest(sessionId: string, model: Model<Api>, context: Context): ModelRouteRequest {
	const contextDigest = runtimeDigest({
		kind: "session-title",
		systemPrompt: context.systemPrompt,
		messages: context.messages,
		tools: [],
	});
	const requestId = createRuntimeId("command", runtimeDigest({ sessionId, model: `${model.provider}/${model.id}`, contextDigest }).digest.slice(0, 48));
		return {
			requestId,
			operation: "request",
			requestKind: "auto-title",
			targetProfileId: `${model.provider}/${model.id}`,
		contextDigest,
		planDigest: runtimeDigest({ kind: "session-title", sessionId }),
		resourceDigest: runtimeDigest([]),
		requiredContextTokens: Math.ceil(new TextEncoder().encode(JSON.stringify(context)).byteLength / 3),
		requiredOutputTokens: 64,
		requiresTools: false,
		requiresReasoningReplay: false,
		requiresImages: false,
		traceId: createRuntimeId("trace", runtimeDigest({ requestId, sessionId }).digest.slice(0, 48)),
	};
}

function abortOnSignal(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		if (signal.aborted) {
			reject(new Error("title request aborted"));
			return;
		}
		signal.addEventListener("abort", () => reject(new Error("title request aborted")), { once: true });
	});
}
