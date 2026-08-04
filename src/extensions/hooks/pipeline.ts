/** Hooks M3 的 bounded command pipeline；真实进程必须由注入的 runner port 提供。 */

import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic, redactDiagnosticText, sortExtensionDiagnostics } from "../diagnostics.ts";
import { compileHookMatcher, defaultHookFailureMode, orderHookHandlers } from "./matcher.ts";
import type {
	HookCommandRunnerRequest,
	HookCommandRunnerResult,
	HookEvent,
	HookFailureKind,
	HookFailureMode,
	HookHandlerReference,
	HookHandlerRunResult,
	HookPipelineLimits,
	HookPipelineOptions,
	HookPipelineResult,
	HookStdoutParseResult,
	HookStdoutValue,
} from "./types.ts";

export const DEFAULT_HOOK_PIPELINE_LIMITS: Readonly<HookPipelineLimits> = Object.freeze({
	maxInputBytes: DEFAULT_EXTENSION_LIMITS.maxFileBytes,
	maxStdoutBytes: DEFAULT_EXTENSION_LIMITS.maxStdoutBytes,
	maxStderrBytes: DEFAULT_EXTENSION_LIMITS.maxStderrBytes,
	maxReasonChars: 2_048,
	maxAdditionalContextChars: DEFAULT_EXTENSION_LIMITS.maxContextChars,
});

const RESERVED_ENV_KEYS = new Set([
	"RUNLEDGER_HOOK_EVENT",
	"RUNLEDGER_HOOK_ID",
	"RUNLEDGER_SESSION_ID",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function outputDiagnostic(code: string, message: string): ReturnType<typeof extensionDiagnostic> {
	return extensionDiagnostic({
		code,
		severity: "error",
		message: redactDiagnosticText(message),
		source: "hooks",
		path: "stdout",
	});
}

/** 解析 command stdout 的 exact JSON shape，不接受隐式 shell 文本或未知字段。 */
export function parseHookStdout(stdout: string): HookStdoutParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid JSON";
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_invalid_json", message)] };
	}
	if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["decision"], ["reason", "updatedInput", "additionalContext"])) {
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_fields", "hook output must be an object with an exact result shape")] };
	}
	if (parsed.decision !== "allow" && parsed.decision !== "deny") {
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_decision", "decision must be allow or deny")] };
	}
	if (parsed.reason !== undefined && (typeof parsed.reason !== "string" || parsed.reason.length > 4_096)) {
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_reason", "reason must be a bounded string")] };
	}
	if (parsed.additionalContext !== undefined && parsed.additionalContext !== null && (typeof parsed.additionalContext !== "string" || parsed.additionalContext.length > 16_384)) {
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_context", "additionalContext must be a bounded string or null")] };
	}
	if (parsed.decision === "deny" && parsed.updatedInput !== undefined && parsed.updatedInput !== null) {
		return { ok: false, diagnostics: [outputDiagnostic("hooks.output_update_on_deny", "updatedInput is only valid with an allow decision")] };
	}
	const value: HookStdoutValue = {
		decision: parsed.decision,
		...(parsed.reason !== undefined ? { reason: parsed.reason as string } : {}),
		...(Object.hasOwn(parsed, "updatedInput") ? { updatedInput: parsed.updatedInput } : {}),
		...(Object.hasOwn(parsed, "additionalContext") ? { additionalContext: parsed.additionalContext as string | null } : {}),
	};
	return { ok: true, value };
}

export function buildHookEnvironment(
	baseEnv: Readonly<Record<string, string>> = {},
	declaredEnv: Readonly<Record<string, string>> = {},
	injected: { readonly event: string; readonly hookId: string; readonly sessionId: string },
): Readonly<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (!RESERVED_ENV_KEYS.has(key)) result[key] = value;
	}
	for (const [key, value] of Object.entries(declaredEnv)) {
		if (!RESERVED_ENV_KEYS.has(key)) result[key] = value;
	}
	result.RUNLEDGER_HOOK_EVENT = injected.event;
	result.RUNLEDGER_HOOK_ID = injected.hookId;
	result.RUNLEDGER_SESSION_ID = injected.sessionId;
	return Object.freeze(result);
}

function resolvedLimits(options: HookPipelineOptions): HookPipelineLimits {
	return {
		maxInputBytes: options.limits?.maxInputBytes ?? DEFAULT_HOOK_PIPELINE_LIMITS.maxInputBytes,
		maxStdoutBytes: options.limits?.maxStdoutBytes ?? DEFAULT_HOOK_PIPELINE_LIMITS.maxStdoutBytes,
		maxStderrBytes: options.limits?.maxStderrBytes ?? DEFAULT_HOOK_PIPELINE_LIMITS.maxStderrBytes,
		maxReasonChars: options.limits?.maxReasonChars ?? DEFAULT_HOOK_PIPELINE_LIMITS.maxReasonChars,
		maxAdditionalContextChars: options.limits?.maxAdditionalContextChars ?? DEFAULT_HOOK_PIPELINE_LIMITS.maxAdditionalContextChars,
	};
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function failureModeRank(mode: HookFailureMode): number {
	return mode === "closed" ? 1 : 0;
}

/** 用户层可设置安全下限；项目/plugin 不能把 closed 阻断策略降成 open。 */
export function effectiveHookFailureMode(
	ref: HookHandlerReference,
	event: HookEvent["event"],
	userFailureMode?: HookFailureMode,
): HookFailureMode {
	const defaultMode = defaultHookFailureMode(event);
	const requested = ref.hook.failureMode ?? defaultMode;
	const userFloor = userFailureMode ?? defaultMode;
	if (userFailureMode !== undefined && failureModeRank(requested) < failureModeRank(userFloor)) return userFloor;
	if ((ref.hook.sourceLayer === "project" || ref.hook.sourceLayer === "plugin") && failureModeRank(requested) < failureModeRank(userFloor)) return userFloor;
	return requested;
}

type RunnerRace =
	| { readonly kind: "result"; readonly result: HookCommandRunnerResult }
	| { readonly kind: "error"; readonly error: unknown }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" };

async function invokeRunner(
	options: HookPipelineOptions,
	request: Omit<HookCommandRunnerRequest, "signal">,
): Promise<RunnerRace> {
	if (options.signal?.aborted) return { kind: "aborted" };
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let abortListener: (() => void) | undefined;
	const timeoutPromise = new Promise<RunnerRace>((resolve) => {
		timeoutHandle = setTimeout(() => {
			controller.abort();
			resolve({ kind: "timeout" });
		}, Math.max(1, request.timeoutMs));
	});
	const abortPromise = options.signal
		? new Promise<RunnerRace>((resolve) => {
			abortListener = () => {
				controller.abort(options.signal?.reason);
				resolve({ kind: "aborted" });
			};
			options.signal?.addEventListener("abort", abortListener, { once: true });
		})
		: new Promise<RunnerRace>(() => undefined);
	const runnerPromise: Promise<RunnerRace> = Promise.resolve()
		.then(() => options.runner.run({ ...request, signal: controller.signal }))
		.then((result) => ({ kind: "result", result }) satisfies RunnerRace, (error: unknown) => ({ kind: "error", error }) satisfies RunnerRace);
	try {
		const raced = await Promise.race([runnerPromise, timeoutPromise, abortPromise]);
		if (raced.kind === "result" && options.signal?.aborted) return { kind: "aborted" };
		return raced;
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
		const externalReason = options.signal?.reason;
		if (!controller.signal.aborted && (options.signal?.aborted ?? false)) controller.abort(externalReason);
	}
}

function auditDigestFor(result: HookHandlerRunResult): ReturnType<typeof runtimeDigest> {
	return runtimeDigest({
		hookId: result.hookId,
		eventId: result.eventId,
		outcome: result.outcome,
		effectiveFailureMode: result.effectiveFailureMode,
		failureKind: result.failureKind ?? null,
		reason: result.reason ?? null,
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		aborted: result.aborted,
		durationMs: result.durationMs,
		inputDigest: result.inputDigest,
		outputDigest: result.outputDigest,
		diagnosticDigest: result.diagnosticDigest,
		updatedInput: result.updatedInput,
	});
}

function makeFailureResult(args: {
	readonly ref: HookHandlerReference;
	readonly event: HookEvent;
	readonly mode: HookFailureMode;
	readonly kind: HookFailureKind;
	readonly reason: string;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly durationMs: number;
	readonly inputDigest: ReturnType<typeof runtimeDigest>;
	readonly outputDigest: ReturnType<typeof runtimeDigest>;
	readonly diagnostics: readonly ReturnType<typeof extensionDiagnostic>[];
}): HookHandlerRunResult {
	const diagnostics = sortExtensionDiagnostics(args.diagnostics);
	const result: HookHandlerRunResult = {
		hookId: args.ref.hook.resourceId,
		eventId: args.event.eventId,
		outcome: "failure",
		effectiveFailureMode: args.mode,
		failureKind: args.kind,
		reason: redactDiagnosticText(args.reason),
		exitCode: args.exitCode,
		timedOut: args.timedOut,
		aborted: args.aborted,
		durationMs: args.durationMs,
		inputDigest: args.inputDigest,
		outputDigest: args.outputDigest,
		diagnosticDigest: runtimeDigest(diagnostics),
		diagnostics,
		updatedInput: false,
	};
	return result;
}

function finishPipeline(
	decision: HookPipelineResult["decision"],
	blocked: boolean,
	currentInput: unknown,
	updated: boolean,
	requiresAuthorization: boolean,
	additionalContext: readonly string[],
	handlers: readonly HookHandlerRunResult[],
	diagnostics: readonly ReturnType<typeof extensionDiagnostic>[],
	event: HookEvent,
): HookPipelineResult {
	const finalDiagnostics = sortExtensionDiagnostics(diagnostics);
	return {
		decision,
		blocked,
		finalInput: currentInput,
		...(updated ? { updatedInput: currentInput } : {}),
		requiresRevalidation: updated,
		requiresAuthorization,
		additionalContext: [...additionalContext],
		handlers: [...handlers],
		diagnostics: finalDiagnostics,
		auditDigest: runtimeDigest({
			event: event.event,
			eventId: event.eventId,
			decision,
			blocked,
			handlers: handlers.map((handler) => auditDigestFor(handler)),
			finalInputDigest: runtimeDigest(currentInput),
		}),
	};
}

/**
 * 串行执行已解析 handler。该函数只调用注入 runner，不持有或创建真实子进程。
 * updatedInput 只改变后续 hook envelope，并在结果中显式标记必须重新校验和授权。
 */
export async function runHookPipeline(options: HookPipelineOptions): Promise<HookPipelineResult> {
	const limits = resolvedLimits(options);
	let currentInput = options.event.input;
	let updated = false;
	let requiresAuthorization = false;
	let additionalContext: string[] = [];
	const handlers: HookHandlerRunResult[] = [];
	const diagnostics: ReturnType<typeof extensionDiagnostic>[] = [];
	const selected = orderHookHandlers(options.hooks, options.event.event, options.event.matcherValue);

	for (const ref of selected) {
		const mode = effectiveHookFailureMode(ref, options.event.event, options.userFailureMode);
		const startedAt = Date.now();
		let stdin: string;
		let inputDigest: ReturnType<typeof runtimeDigest>;
		try {
			inputDigest = runtimeDigest(currentInput);
			stdin = canonicalJson({
				event: options.event.event,
				eventId: options.event.eventId,
				timestamp: options.event.timestamp,
				sessionId: options.event.sessionId,
				snapshotId: options.event.snapshotId,
				source: options.event.source,
				...(options.event.matcherValue !== undefined ? { matcherValue: options.event.matcherValue } : {}),
				input: currentInput,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "hook input is not canonical JSON";
			const fallbackDigest = runtimeDigest({ input: "unavailable", eventId: options.event.eventId });
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "spawn_error",
				reason: `hook input could not be encoded: ${message}`,
				exitCode: null,
				timedOut: false,
				aborted: false,
				durationMs: Date.now() - startedAt,
				inputDigest: fallbackDigest,
				outputDigest: runtimeDigest({ error: "input_not_canonical" }),
				diagnostics: [extensionDiagnostic({ code: "hooks.input_invalid", severity: "error", message: "hook input could not be encoded as canonical JSON", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}
		if (byteLength(stdin) > limits.maxInputBytes) {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "oversized_input",
				reason: "hook stdin exceeds the configured byte limit",
				exitCode: null,
				timedOut: false,
				aborted: false,
				durationMs: Date.now() - startedAt,
				inputDigest,
				outputDigest: runtimeDigest({ error: "oversized_input", bytes: byteLength(stdin) }),
				diagnostics: [extensionDiagnostic({ code: "hooks.input_oversized", severity: "error", message: "hook stdin exceeds the configured byte limit", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}

		const request: Omit<HookCommandRunnerRequest, "signal"> = {
			command: ref.handler.command,
			args: ref.handler.args,
			env: buildHookEnvironment(options.baseEnv, ref.handler.env, {
				event: options.event.event,
				hookId: ref.hook.id,
				sessionId: options.event.sessionId,
			}),
			stdin,
			timeoutMs: ref.handler.timeoutMs,
		};
		const raced = await invokeRunner(options, request);
		const durationMs = Date.now() - startedAt;
		if (raced.kind === "timeout" || raced.kind === "aborted" || raced.kind === "error") {
			const kind: HookFailureKind = raced.kind === "timeout" ? "timeout" : raced.kind === "aborted" ? "aborted" : "spawn_error";
			const reason = raced.kind === "timeout" ? "hook command timed out" : raced.kind === "aborted" ? "hook command was aborted" : `hook runner failed: ${raced.error instanceof Error ? raced.error.message : "unknown runner error"}`;
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind,
				reason,
				exitCode: null,
				timedOut: raced.kind === "timeout",
				aborted: raced.kind === "aborted",
				durationMs,
				inputDigest,
				outputDigest: runtimeDigest({ failure: kind, hookId: ref.hook.resourceId }),
				diagnostics: [extensionDiagnostic({ code: raced.kind === "aborted" ? "hooks.handler_aborted" : raced.kind === "timeout" ? "hooks.handler_timeout" : "hooks.handler_spawn_error", severity: "error", message: redactDiagnosticText(reason), source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (raced.kind === "aborted") return finishPipeline("aborted", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}

		const outputDigest = runtimeDigest({ stdout: raced.result.stdout, stderr: raced.result.stderr });
		if (byteLength(raced.result.stdout) > limits.maxStdoutBytes || byteLength(raced.result.stderr) > limits.maxStderrBytes) {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "oversized_output",
				reason: "hook stdout or stderr exceeds the configured byte limit",
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnostics: [extensionDiagnostic({ code: "hooks.output_oversized", severity: "error", message: "hook stdout or stderr exceeds the configured byte limit", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}
		if (raced.result.exitCode !== 0) {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: raced.result.exitCode === null ? "spawn_error" : "nonzero",
				reason: raced.result.exitCode === null ? "hook runner returned no exit code" : `hook command exited with code ${raced.result.exitCode}`,
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnostics: [extensionDiagnostic({ code: "hooks.handler_failed", severity: "error", message: "hook command returned a failure exit code", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}

		const parsed = parseHookStdout(raced.result.stdout);
		if (!parsed.ok) {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "invalid_output",
				reason: "hook stdout did not match the exact result schema",
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnostics: [...parsed.diagnostics, extensionDiagnostic({ code: "hooks.handler_invalid_output", severity: "error", message: "hook stdout did not match the exact result schema", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}

		const output = parsed.value;
		if ((output.reason?.length ?? 0) > limits.maxReasonChars || (output.additionalContext?.length ?? 0) > limits.maxAdditionalContextChars) {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "invalid_output",
				reason: "hook output text exceeds the configured character limit",
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnostics: [extensionDiagnostic({ code: "hooks.output_text_oversized", severity: "error", message: "hook output text exceeds the configured character limit", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}
		if (output.decision === "deny") {
			const reason = redactDiagnosticText(output.reason ?? "hook denied the operation");
			const result: HookHandlerRunResult = {
				hookId: ref.hook.resourceId,
				eventId: options.event.eventId,
				outcome: "deny",
				effectiveFailureMode: mode,
				reason,
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnosticDigest: runtimeDigest([]),
				diagnostics: [],
				updatedInput: false,
			};
			handlers.push(result);
			return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
		}

		if (output.updatedInput !== undefined && output.updatedInput !== null && options.event.event !== "PreToolUse") {
			const failure = makeFailureResult({
				ref,
				event: options.event,
				mode,
				kind: "invalid_output",
				reason: "updatedInput is only accepted for PreToolUse",
				exitCode: raced.result.exitCode,
				timedOut: false,
				aborted: false,
				durationMs,
				inputDigest,
				outputDigest,
				diagnostics: [extensionDiagnostic({ code: "hooks.updated_input_event", severity: "error", message: "updatedInput is only accepted for PreToolUse", source: "hooks", path: ref.hook.sourcePath, resourceId: ref.hook.resourceId })],
			});
			handlers.push(failure);
			diagnostics.push(...failure.diagnostics);
			if (mode === "closed") return finishPipeline("deny", true, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
			continue;
		}

		const hasUpdatedInput = output.updatedInput !== undefined && output.updatedInput !== null;
		if (hasUpdatedInput) {
			currentInput = output.updatedInput;
			updated = true;
			requiresAuthorization = true;
		}
		if (output.additionalContext !== undefined && output.additionalContext !== null) additionalContext = [...additionalContext, output.additionalContext];
		const result: HookHandlerRunResult = {
			hookId: ref.hook.resourceId,
			eventId: options.event.eventId,
			outcome: "allow",
			effectiveFailureMode: mode,
			exitCode: raced.result.exitCode,
			timedOut: false,
			aborted: false,
			durationMs,
			inputDigest,
			outputDigest,
			diagnosticDigest: runtimeDigest([]),
			diagnostics: [],
			updatedInput: hasUpdatedInput,
		};
		handlers.push(result);
	}

	return finishPipeline("allow", false, currentInput, updated, requiresAuthorization, additionalContext, handlers, diagnostics, options.event);
}
