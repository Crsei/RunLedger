/**
 * Extension event bridge：把 canonical event 投影派发给 host，并把 handler
 * 返回值合成为 owner 侧可消费的结果（D5）。
 *
 * 合成结果的字段与既有 `HookPipelineResult` 对齐（`blocked` /
 * `updatedInput` / `requiresRevalidation` / `requiresAuthorization` /
 * `additionalContext`），因此扩展 handler 只是 PreToolUse pipeline 的
 * **另一个 handler 来源**，不引入第二套决策语义。
 *
 * fail-closed 边界：
 *   - 未注册事件名 → 拒绝派发，不投影空载荷；
 *   - 载荷超限 → 拒绝，不截断；
 *   - handler 返回值形状非法 → 整次合成失败（调用方按自身策略处理，
 *     PreToolUse 场景应视为 deny），绝不把畸形结果当成 allow；
 *   - `updatedInput` 只对 PreToolUse 合法，且强制 `requiresAuthorization`。
 */

import type { ExtensionHostLimits } from "../../contracts/extensions/registry.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../contracts/extensions/registry.ts";
import { projectExtensionEvent } from "./projection.ts";
import type { ExtensionProjectionFailure } from "./projection.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { extensionDiagnostic, redactDiagnosticText, sortExtensionDiagnostics, type ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionEventOutcome } from "../host/client.ts";
import type { ExtensionEventName } from "../../contracts/extensions/events.ts";

/** PreToolUse 是唯一允许重写工具输入的事件。 */
export const EXTENSION_INPUT_REWRITE_EVENT: ExtensionEventName = "PreToolUse";

export interface ExtensionHandlerOutcome {
	readonly index: number;
	readonly outcome: "result" | "timeout" | "error";
	readonly durationMs: number;
	readonly resultDigest: string;
	/** 形状合法且已被合成采用。 */
	readonly accepted: boolean;
}

export interface ExtensionEventBridgeResult {
	readonly name: string;
	readonly decision: "allow" | "deny";
	readonly blocked: boolean;
	readonly finalInput: unknown;
	readonly updatedInput?: unknown;
	readonly requiresRevalidation: boolean;
	readonly requiresAuthorization: boolean;
	readonly additionalContext: readonly string[];
	readonly replacement?: unknown;
	readonly replacements: readonly unknown[];
	readonly handlers: readonly ExtensionHandlerOutcome[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
	readonly auditDigest: string;
}

export type ExtensionEventBridgeOutcome =
	| { readonly ok: true; readonly result: ExtensionEventBridgeResult }
	| {
			readonly ok: false;
			readonly code: "event_not_projected" | "payload_oversize" | "handler_result_invalid" | "host_unavailable" | "aborted";
			readonly message: string;
			readonly diagnostics: readonly ExtensionDiagnostic[];
	  };

export interface ExtensionEventBridgeDispatch {
	readonly name: string;
	readonly source: Readonly<Record<string, unknown>>;
	readonly input?: unknown;
	readonly signal?: AbortSignal;
	/** 已订阅该事件的扩展 id；空数组表示无需派发（直接 allow）。 */
	readonly subscribers?: readonly string[];
}

export interface ExtensionEventBridgeOptions {
	readonly dispatch: (input: {
		readonly name: string;
		readonly cancelable: boolean;
		readonly payload: Readonly<Record<string, unknown>>;
		readonly deadlineMs?: number;
		readonly signal?: AbortSignal;
	}) => Promise<ExtensionEventOutcome>;
	readonly limits?: ExtensionHostLimits;
	readonly maxContextChars?: number;
	readonly maxReasonChars?: number;
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
}

const DEFAULT_MAX_CONTEXT_CHARS = 32_000;
const DEFAULT_MAX_REASON_CHARS = 2_048;
const ALLOWED_RESULT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	none: [],
	context: ["additionalContext"],
	decision: ["decision", "reason", "updatedInput"],
	replace: ["replacement"],
	middleware: ["replacement"],
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

function byteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function outcomeOf(value: unknown): { readonly ok: true; readonly handlers: readonly Record<string, unknown>[] } | { readonly ok: false; readonly message: string } {
	if (value === null || value === undefined) return { ok: true, handlers: [] };
	if (!isPlainRecord(value)) return { ok: false, message: "host event value must be an object" };
	const handlers = value.handlers;
	if (!Array.isArray(handlers)) return { ok: false, message: "host event value is missing the handler list" };
	for (const entry of handlers) {
		if (!isPlainRecord(entry)) return { ok: false, message: "host handler record must be an object" };
	}
	return { ok: true, handlers: handlers as readonly Record<string, unknown>[] };
}

export class ExtensionEventBridge {
	readonly #options: ExtensionEventBridgeOptions;

	public constructor(options: ExtensionEventBridgeOptions) {
		this.#options = options;
	}

	/**
	 * 派发一个投影事件并合成结果。返回值只在 `ok:true` 时可用于决策；
	 * `ok:false` 时调用方必须按自身 fail-closed 策略处理（PreToolUse 视为 deny）。
	 */
	public async dispatch(input: ExtensionEventBridgeDispatch): Promise<ExtensionEventBridgeOutcome> {
		const limits = this.#options.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
		const projected = projectExtensionEvent({
			name: input.name,
			source: input.source,
			maxPayloadBytes: limits.maxEventPayloadBytes,
		});
		if (!projected.ok) return failure(projected.error);

		const subscribers = input.subscribers ?? [];
		if (subscribers.length === 0) {
			// 没有订阅者时不做跨进程往返；结果与“有订阅者但没人改变决策”一致。
			return { ok: true, result: allowResult(projected.projection.name, input.input, []) };
		}

		const outcome = await this.#options.dispatch({
			name: projected.projection.name,
			cancelable: projected.projection.cancelable,
			payload: projected.projection.payload,
			deadlineMs: limits.handlerTimeoutMs,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		if (!outcome.ok) {
			const code = outcome.code === "host_event_aborted"
				? "aborted"
				: outcome.code === "host_unavailable"
					? "host_unavailable"
					: outcome.code === "event_payload_oversize"
						? "payload_oversize"
						: "host_unavailable";
			const diagnostics = [extensionDiagnostic({
				code: `extensions.event_${outcome.code}`,
				severity: "error",
				message: redactDiagnosticText(outcome.message),
				source: "extensions",
			})];
			await this.#audit("extension.event.failed", { event: projected.projection.name, code: outcome.code, subscribers: subscribers.length });
			return { ok: false, code, message: redactDiagnosticText(outcome.message), diagnostics };
		}

		const parsed = outcomeOf(outcome.value);
		if (!parsed.ok) {
			const diagnostics = [extensionDiagnostic({ code: "extensions.event_result_invalid", severity: "error", message: parsed.message, source: "extensions" })];
			await this.#audit("extension.event.failed", { event: projected.projection.name, code: "handler_result_invalid" });
			return { ok: false, code: "handler_result_invalid", message: parsed.message, diagnostics };
		}
		return this.#synthesize(projected.projection, parsed.handlers, input.input, subscribers.length);
	}

	async #synthesize(
		projection: { readonly name: string; readonly resultKind: string },
		handlers: readonly Record<string, unknown>[],
		input: unknown,
		subscriberCount: number,
	): Promise<ExtensionEventBridgeOutcome> {
		const limits = this.#options.limits ?? EXTENSION_DEFAULT_HOST_LIMITS;
		const maxContextChars = this.#options.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
		const maxReasonChars = this.#options.maxReasonChars ?? DEFAULT_MAX_REASON_CHARS;
		const allowed = new Set(ALLOWED_RESULT_KEYS[projection.resultKind] ?? []);
		const diagnostics: ExtensionDiagnostic[] = [];
		const records: ExtensionHandlerOutcome[] = [];
		const replacements: unknown[] = [];
		let additionalContext: string[] = [];
		let blocked = false;
		let reason: string | undefined;
		let updatedInput: unknown;
		let updated = false;

		for (const [position, handler] of handlers.entries()) {
			const index = typeof handler.index === "number" ? handler.index : position;
			const handlerOutcome = handler.outcome === "timeout" || handler.outcome === "error" ? handler.outcome : "result";
			const raw = handler.result;
			const resultDigest = runtimeDigest(raw ?? null).digest;
			if (handlerOutcome !== "result") {
				// handler 抛错或超时只产生 diagnostic：它不改变决策，也不让整次
				// 合成失败（与 P1 host 侧的错误隔离一致）。
				diagnostics.push(extensionDiagnostic({
					code: handlerOutcome === "timeout" ? "extensions.event_handler_timeout" : "extensions.event_handler_failed",
					severity: "warning",
					message: `extension handler ${index} for ${projection.name} did not produce a result`,
					source: "extensions",
				}));
				records.push({ index, outcome: handlerOutcome, durationMs: typeof handler.durationMs === "number" ? handler.durationMs : 0, resultDigest, accepted: false });
				continue;
			}
			if (raw === null || raw === undefined) {
				if (projection.resultKind !== "none") {
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
					continue;
				}
				records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
				continue;
			}
			if (!isPlainRecord(raw) || !Object.keys(raw).every((key) => allowed.has(key))) {
				const message = `extension handler ${index} returned a result outside the ${projection.resultKind} shape`;
				diagnostics.push(extensionDiagnostic({ code: "extensions.event_result_shape", severity: "error", message, source: "extensions" }));
				records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
				await this.#audit("extension.event.failed", { event: projection.name, code: "handler_result_invalid", handlerIndex: index });
				return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
			}

			if (projection.resultKind === "context") {
				const context = raw.additionalContext;
				if (typeof context !== "string" || context.length === 0 || context.length > maxContextChars) {
					const message = `extension handler ${index} returned an invalid additionalContext`;
					diagnostics.push(extensionDiagnostic({ code: "extensions.event_context_invalid", severity: "error", message, source: "extensions" }));
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
					return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
				}
				additionalContext = [...additionalContext, context];
			} else if (projection.resultKind === "decision") {
				const decision = raw.decision;
				if (decision !== "allow" && decision !== "deny") {
					const message = `extension handler ${index} returned an invalid decision`;
					diagnostics.push(extensionDiagnostic({ code: "extensions.event_decision_invalid", severity: "error", message, source: "extensions" }));
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
					return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
				}
				if (decision === "deny") {
					if (blocked) {
						records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
						continue;
					}
					const rawReason = raw.reason;
					if (rawReason !== undefined && (typeof rawReason !== "string" || rawReason.length === 0 || rawReason.length > maxReasonChars)) {
						const message = `extension handler ${index} returned an invalid reason`;
						diagnostics.push(extensionDiagnostic({ code: "extensions.event_reason_invalid", severity: "error", message, source: "extensions" }));
						records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
						return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
					}
					blocked = true;
					reason = redactDiagnosticText(typeof rawReason === "string" ? rawReason : "extension denied the operation");
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
					continue;
				}
				const candidate = raw.updatedInput;
				if (candidate !== undefined && candidate !== null) {
					if (projection.name !== EXTENSION_INPUT_REWRITE_EVENT) {
						const message = `extension handler ${index} rewrote input for ${projection.name}, which only ${EXTENSION_INPUT_REWRITE_EVENT} may do`;
						diagnostics.push(extensionDiagnostic({ code: "extensions.event_rewrite_not_allowed", severity: "error", message, source: "extensions" }));
						records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
						return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
					}
					if (byteLength(candidate) > limits.maxEventPayloadBytes) {
						const message = `extension handler ${index} rewrote input beyond the payload bound`;
						diagnostics.push(extensionDiagnostic({ code: "extensions.event_rewrite_oversize", severity: "error", message, source: "extensions" }));
						records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
						return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
					}
					updatedInput = candidate;
					updated = true;
				}
			} else if (projection.resultKind === "replace" || projection.resultKind === "middleware") {
				const replacement = raw.replacement;
				if (replacement === undefined) {
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
					continue;
				}
				if (byteLength(replacement) > limits.maxEventPayloadBytes) {
					const message = `extension handler ${index} returned a replacement beyond the payload bound`;
					diagnostics.push(extensionDiagnostic({ code: "extensions.event_replacement_oversize", severity: "error", message, source: "extensions" }));
					records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: false });
					return { ok: false, code: "handler_result_invalid", message, diagnostics: sortExtensionDiagnostics(diagnostics) };
				}
				replacements.push(replacement);
			}
			records.push({ index, outcome: "result", durationMs: durationOf(handler), resultDigest, accepted: true });
		}

		const finalInput = updatedInput ?? input;
		const result: ExtensionEventBridgeResult = {
			name: projection.name,
			decision: blocked ? "deny" : "allow",
			blocked,
			finalInput,
			...(updated ? { updatedInput } : {}),
			requiresRevalidation: updated || replacements.length > 0,
			requiresAuthorization: updated,
			additionalContext,
			...(replacements.length === 0 ? {} : { replacement: replacements[replacements.length - 1] }),
			replacements,
			handlers: records,
			diagnostics: sortExtensionDiagnostics(diagnostics),
			auditDigest: runtimeDigest({
				event: projection.name,
				decision: blocked ? "deny" : "allow",
				reason: reason ?? null,
				handlers: records,
				finalInputDigest: runtimeDigest(finalInput ?? null),
				replacementsDigest: runtimeDigest(replacements),
			}).digest,
		};
		await this.#audit("extension.event.dispatched", {
			event: projection.name,
			decision: result.decision,
			subscribers: subscriberCount,
			handlers: records.length,
			requiresAuthorization: result.requiresAuthorization,
			auditDigest: result.auditDigest,
		});
		return { ok: true, result };
	}

	async #audit(eventType: string, payload: Record<string, unknown>): Promise<void> {
		await this.#options.audit?.({ eventType, payload });
	}
}

function durationOf(handler: Record<string, unknown>): number {
	return typeof handler.durationMs === "number" ? handler.durationMs : 0;
}

function allowResult(name: string, input: unknown, handlers: readonly ExtensionHandlerOutcome[]): ExtensionEventBridgeResult {
	return {
		name,
		decision: "allow",
		blocked: false,
		finalInput: input,
		requiresRevalidation: false,
		requiresAuthorization: false,
		additionalContext: [],
		replacements: [],
		handlers,
		diagnostics: [],
		auditDigest: runtimeDigest({ event: name, decision: "allow", handlers: [] }).digest,
	};
}

function failure(error: ExtensionProjectionFailure): ExtensionEventBridgeOutcome {
	const code = error.code === "event_not_projected" ? "event_not_projected" : "payload_oversize";
	return {
		ok: false,
		code,
		message: error.message,
		diagnostics: [extensionDiagnostic({ code: `extensions.projection_${error.code}`, severity: "error", message: error.message, source: "extensions" })],
	};
}
