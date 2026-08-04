/** Hook lifecycle 到 Host 可消费结果的单向 adapter。 */

import type { RuntimeToolResult, RuntimeToolInvocation } from "../../runtime/resources/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import type { AdapterIdentityRef } from "../../runtime/protocol/adapter.ts";
import type { HookCommandRunner, HookDefinition, HookEvent, HookPipelineLimits, HookPipelineOptions, HookPipelineResult } from "../hooks/types.ts";
import {
	boundedCanonicalInput,
	checkResourceInvocationPort,
	type ExtensionAdapterRequestBase,
	type ExtensionAdapterResult,
	type RuntimeExtensionResourcePorts,
	DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES,
	digestOrFallback,
	sameResourceIdentity,
} from "./runtime-resource-adapter.ts";
import { createInvocationAudit } from "./runtime-audit-adapter.ts";

export type HookPipelinePort = (options: HookPipelineOptions) => Promise<HookPipelineResult>;

export interface RuntimeHookAdapterOptions {
	readonly pipeline: HookPipelinePort;
	readonly runner: HookCommandRunner;
	readonly resources: RuntimeExtensionResourcePorts;
	readonly adapter: AdapterIdentityRef;
	readonly maxInputBytes?: number;
	readonly maxAdditionalContextChars?: number;
}

export interface HookLifecycleInvocationRequest extends ExtensionAdapterRequestBase {
	readonly event: HookEvent;
	readonly hooks: readonly HookDefinition[];
	readonly userFailureMode?: "open" | "closed";
	readonly baseEnv?: Readonly<Record<string, string>>;
	readonly limits?: Partial<HookPipelineLimits>;
}

export interface HookHandlerSummary {
	readonly hookId: HookDefinition["resourceId"];
	readonly eventId: HookEvent["eventId"];
	readonly outcome: "allow" | "deny" | "failure";
	readonly effectiveFailureMode: "open" | "closed";
	readonly failureKind?: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly durationMs: number;
	readonly inputDigest: RuntimeDigest;
	readonly outputDigest: RuntimeDigest;
	readonly updatedInput: boolean;
}

export interface HookLifecycleInvocationValue {
	readonly invocation: RuntimeToolInvocation;
	readonly decision: "allow" | "deny" | "aborted";
	readonly blocked: boolean;
	readonly finalInput: unknown;
	readonly requiresRevalidation: boolean;
	readonly requiresAuthorization: boolean;
	readonly additionalContext: readonly string[];
	readonly handlers: readonly HookHandlerSummary[];
	readonly runtimeResult: RuntimeToolResult;
}

export interface HookLifecycleAdapterPort {
	invoke(request: HookLifecycleInvocationRequest): Promise<ExtensionAdapterResult<HookLifecycleInvocationValue>>;
}

export class RuntimeHookAdapter implements HookLifecycleAdapterPort {
	readonly #pipeline: HookPipelinePort;
	readonly #runner: HookCommandRunner;
	readonly #resources: RuntimeExtensionResourcePorts;
	readonly #adapter: AdapterIdentityRef;
	readonly #maxInputBytes: number;
	readonly #maxAdditionalContextChars: number;

	public constructor(options: RuntimeHookAdapterOptions) {
		this.#pipeline = options.pipeline;
		this.#runner = options.runner;
		this.#resources = options.resources;
		this.#adapter = options.adapter;
		this.#maxInputBytes = options.maxInputBytes ?? DEFAULT_EXTENSION_ADAPTER_INPUT_BYTES;
		this.#maxAdditionalContextChars = options.maxAdditionalContextChars ?? 16_384;
	}

	public async invoke(request: HookLifecycleInvocationRequest): Promise<ExtensionAdapterResult<HookLifecycleInvocationValue>> {
		const startedAt = Date.now();
		const input = boundedCanonicalInput(request.event.input, this.#maxInputBytes);
		const inputDigest = input.ok ? input.value.digest : input.digest;
		const inputBytes = input.ok ? input.value.bytes : input.bytes;
		if (request.invocation.tool.kind !== "hook") return this.#failure(request, "invalid_request", "hook invocation identity is not a hook resource", inputDigest, inputBytes, startedAt);
		if (request.invocation.snapshotId !== request.event.snapshotId || request.invocation.inputDigest.digest !== inputDigest.digest) {
			return this.#failure(request, "invalid_request", "hook invocation input or snapshot binding is invalid", inputDigest, inputBytes, startedAt);
		}
		if (!request.hooks.some((hook) => hook.resourceId === request.invocation.tool.resourceId)) {
			return this.#failure(request, "not_found", "hook resource is not present in the current pipeline", inputDigest, inputBytes, startedAt);
		}
		if (!input.ok) return this.#failure(request, input.error.code, input.error.message, inputDigest, inputBytes, startedAt);

		const gate = await checkResourceInvocationPort({
			port: this.#resources.invocation,
			identity: request.identity,
			requestId: request.invocation.requestId,
			traceId: request.invocation.correlationId,
			deadline: request.deadline,
			inputDigest,
			...(request.invocation.inputRef ? { inputRef: request.invocation.inputRef } : {}),
			signal: request.signal,
		});
		if (!gate.ok) return this.#failure(request, gate.error.code, gate.error.message, inputDigest, inputBytes, startedAt, gate.outputDigest);

		let pipelineResult: HookPipelineResult;
		try {
			pipelineResult = await this.#pipeline({
				event: { ...request.event, input: input.value.value },
				hooks: request.hooks,
				runner: this.#runner,
				...(request.signal ? { signal: request.signal } : {}),
				...(request.baseEnv ? { baseEnv: request.baseEnv } : {}),
				...(request.userFailureMode ? { userFailureMode: request.userFailureMode } : {}),
				...(request.limits ? { limits: request.limits } : {}),
			});
		} catch {
			return this.#failure(request, "execution_failed", "hook pipeline failed", inputDigest, inputBytes, startedAt, gate.outputDigest);
		}

		const finalInput = boundedCanonicalInput(pipelineResult.finalInput, this.#maxInputBytes);
		if (!finalInput.ok) return this.#failure(request, finalInput.error.code, finalInput.error.message, inputDigest, inputBytes, startedAt, gate.outputDigest);
		const additionalContext = [...pipelineResult.additionalContext];
		if (additionalContext.some((value) => value.length > this.#maxAdditionalContextChars)) {
			return this.#failure(request, "oversized", "hook additional context exceeds the adapter bound", inputDigest, inputBytes, startedAt, gate.outputDigest);
		}

		const handlers = pipelineResult.handlers.map((handler) => ({
			hookId: handler.hookId,
			eventId: handler.eventId,
			outcome: handler.outcome,
			effectiveFailureMode: handler.effectiveFailureMode,
			...(handler.failureKind ? { failureKind: handler.failureKind } : {}),
			exitCode: handler.exitCode,
			timedOut: handler.timedOut,
			aborted: handler.aborted,
			durationMs: handler.durationMs,
			inputDigest: handler.inputDigest,
			outputDigest: handler.outputDigest,
			updatedInput: handler.updatedInput,
		} satisfies HookHandlerSummary));
		const resultContent = [{ type: "text" as const, text: hookResultText(pipelineResult) }];
		const runtimeResult: RuntimeToolResult = {
			requestId: request.invocation.requestId,
			tool: request.invocation.tool,
			content: resultContent,
			outcome: pipelineResult.decision === "aborted" ? "cancelled" : pipelineResult.blocked ? "denied" : "ok",
			originalBytes: Buffer.byteLength(resultContent[0].text, "utf8"),
			truncated: false,
			contentDigest: runtimeDigest(resultContent),
		};
		const hasFailure = handlers.some((handler) => handler.outcome === "failure");
		const audit = createInvocationAudit({
			kind: "hook.run",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: pipelineResult.decision === "aborted" ? "cancelled" : pipelineResult.blocked ? "denied" : hasFailure ? "error" : "ok",
			inputDigest,
			outputDigest: runtimeResult.contentDigest,
			metadata: {
				decision: pipelineResult.decision,
				blocked: pipelineResult.blocked,
				requiresRevalidation: pipelineResult.requiresRevalidation,
				requiresAuthorization: pipelineResult.requiresAuthorization,
				additionalContextCount: additionalContext.length,
				additionalContextDigest: runtimeDigest(additionalContext),
				handlerDigest: runtimeDigest(handlers),
				pipelineAuditDigest: pipelineResult.auditDigest,
			},
			portDigest: gate.outputDigest,
			originalBytes: inputBytes,
			resultBytes: runtimeResult.originalBytes,
			durationMs: Date.now() - startedAt,
			...(hasFailure ? { errorCode: "execution_failed" as const } : {}),
		});
		return {
			ok: true,
			value: {
				invocation: request.invocation,
				decision: pipelineResult.decision,
				blocked: pipelineResult.blocked,
				finalInput: finalInput.value.value,
				requiresRevalidation: pipelineResult.requiresRevalidation,
				requiresAuthorization: pipelineResult.requiresAuthorization,
				additionalContext,
				handlers,
				runtimeResult,
			},
			audit: audit.audit,
			auditDigest: audit.auditDigest,
		};
	}

	#failure(
		request: HookLifecycleInvocationRequest,
		code: Parameters<typeof failureMessage>[0],
		message: string,
		inputDigest: RuntimeDigest,
		inputBytes: number,
		startedAt: number,
		portDigest = runtimeDigest("extension-hook-not-invoked"),
	): ExtensionAdapterResult<HookLifecycleInvocationValue> {
		const safeMessage = failureMessage(code, message);
		const audit = createInvocationAudit({
			kind: "hook.run",
			requestId: request.invocation.requestId,
			correlationId: request.invocation.correlationId,
			snapshotId: request.invocation.snapshotId,
			resource: request.invocation.tool,
			outcome: code === "cancelled" ? "cancelled" : code === "authorization_denied" ? "denied" : code === "unsupported" || code === "unknown_effect" ? "unsupported" : "error",
			inputDigest,
			outputDigest: runtimeDigest({ code }),
			metadata: { code },
			portDigest,
			originalBytes: inputBytes,
			resultBytes: 0,
			durationMs: Date.now() - startedAt,
			errorCode: code,
		});
		return { ok: false, error: { code, message: safeMessage, retryable: code === "unavailable" }, audit: audit.audit, auditDigest: audit.auditDigest };
	}
}

function hookResultText(result: HookPipelineResult): string {
	if (result.decision === "aborted") return "hook lifecycle cancelled";
	if (result.blocked) return "hook lifecycle denied";
	return "hook lifecycle allowed";
}

function failureMessage(code: import("./runtime-resource-adapter.ts").ExtensionAdapterErrorCode, _message: string): string {
	switch (code) {
		case "authorization_denied": return "hook resource authorization was denied";
		case "cancelled": return "hook lifecycle was cancelled";
		case "not_found": return "hook resource was not found in the current snapshot";
		case "unavailable": return "hook runtime resource is unavailable";
		case "unknown_effect": return "hook runtime resource returned an unknown effect";
		case "oversized": return "hook adapter input or output exceeded its bound";
		case "invalid_input": return "hook input is invalid";
		case "invalid_request": return "hook invocation request is invalid";
		case "unsupported": return "hook invocation is unsupported";
		case "execution_failed": return "hook pipeline failed";
		case "ambiguous": return "hook resource is ambiguous";
		case "blocked": return "hook resource is blocked";
		case "stale": return "hook resource is stale";
	}
}
