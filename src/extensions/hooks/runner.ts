/** Gateway 授权 executor 之上的 direct-spawn Hook runner。 */

import { canonicalDigest, canonicalJson } from "../../runtime/protocol/v3/canonical-json.ts";
import { DEFAULT_EXTENSION_LIMITS } from "../diagnostics.ts";
import type { ExtensionSpillPort } from "../types.ts";
import type { HookCommandExecutorPort, HookDescriptor, HookEnvelope, HookHandler, HookHttpHandlerPort, HookOutput, HookRunOutcome } from "./types.ts";

function preview(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

function parseOutput(stdout: string): HookOutput | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.decision !== "allow" && raw.decision !== "deny") return undefined;
	if (raw.reason !== undefined && typeof raw.reason !== "string") return undefined;
	if (raw.additionalContext !== undefined && raw.additionalContext !== null && typeof raw.additionalContext !== "string") return undefined;
	return {
		decision: raw.decision,
		...(typeof raw.reason === "string" ? { reason: raw.reason.slice(0, 2_048) } : {}),
		...(raw.updatedInput !== undefined && raw.updatedInput !== null ? { updatedInput: raw.updatedInput } : {}),
		...(typeof raw.additionalContext === "string" ? { additionalContext: raw.additionalContext.slice(0, 16_384) } : {}),
	};
}

export class HookRunner {
	readonly #executor?: HookCommandExecutorPort;
	readonly #http?: HookHttpHandlerPort;
	readonly #spill?: ExtensionSpillPort;

	public constructor(options: { executor?: HookCommandExecutorPort; http?: HookHttpHandlerPort; spill?: ExtensionSpillPort }) {
		this.#executor = options.executor;
		this.#http = options.http;
		this.#spill = options.spill;
	}

	public async run(descriptor: HookDescriptor, handler: HookHandler, envelope: HookEnvelope, signal?: AbortSignal): Promise<HookRunOutcome> {
		const hookId = descriptor.descriptor.identity.qualifiedId;
		const rawInput = canonicalJson(envelope);
		const inputBytes = Buffer.from(rawInput);
		let stdin = rawInput;
		let inputSpill;
		if (inputBytes.byteLength > DEFAULT_EXTENSION_LIMITS.maxHookInputBytes) {
			if (!this.#spill) return this.#failure(descriptor, "failed", "hook input exceeds bound and spill is unavailable", rawInput);
			inputSpill = await this.#spill.write("hook-input", inputBytes);
			stdin = canonicalJson({ ...envelope, payload: { preview: preview(canonicalJson(envelope.payload), 8_192), digest: canonicalDigest(envelope.payload), truncated: true, spill: inputSpill } });
		}
		if (handler.type === "http") {
			if (!this.#http) return this.#failure(descriptor, "failed", "Runtime Gateway HTTP Hook handler is unavailable", stdin);
			const startedAt = Date.now();
			const effectiveEnvelope = JSON.parse(stdin) as HookEnvelope;
			const result = await this.#http.invoke(handler.url, effectiveEnvelope, signal);
			const durationMs = Math.max(0, Date.now() - startedAt);
			if (!result.ok) {
				return {
					...this.#failure(descriptor, "failed", result.reason, stdin),
					durationMs,
					...(inputSpill ? { inputSpill } : {}),
				};
			}
			const output = result.output;
			return {
				hookId,
				event: descriptor.event,
				status: output.decision === "deny" ? "denied" : "allowed",
				decision: output.decision,
				failureMode: descriptor.failureMode,
				reason: output.reason ?? (output.decision === "deny" ? "HTTP hook denied operation" : "HTTP hook allowed operation"),
				durationMs,
				exitCode: result.status,
				stdoutDigest: result.responseDigest,
				stderrDigest: canonicalDigest(""),
				stdoutPreview: "",
				stderrPreview: "",
				inputDigest: canonicalDigest(effectiveEnvelope),
				...(inputSpill ? { inputSpill } : {}),
				...(output.updatedInput !== undefined ? { updatedInput: output.updatedInput } : {}),
				...(output.additionalContext ? { additionalContext: output.additionalContext } : {}),
			};
		}
		if (!this.#executor) return this.#failure(descriptor, "failed", "Runtime Gateway executor is unavailable", stdin);
		const environment: Record<string, string> = {
			...handler.env,
			RUNLEDGER_HOOK_EVENT: descriptor.event,
			RUNLEDGER_HOOK_ID: hookId,
			RUNLEDGER_SESSION_ID: envelope.sessionId,
			RUNLEDGER_WORKSPACE_ROOT: envelope.cwd,
			...(descriptor.descriptor.pluginId ? { RUNLEDGER_PLUGIN_ROOT: descriptor.descriptor.sourcePath, ...(descriptor.pluginDataPath ? { RUNLEDGER_PLUGIN_DATA: descriptor.pluginDataPath } : {}) } : {}),
		};
		const execution = await this.#executor.execute({ command: handler.command, args: handler.args, cwd: descriptor.configDirectory, environment, stdin, timeoutMs: handler.timeoutMs, maxStdoutBytes: DEFAULT_EXTENSION_LIMITS.maxStdoutBytes, maxStderrBytes: DEFAULT_EXTENSION_LIMITS.maxStderrBytes, hookId, commandDigest: handler.commandDigest }, signal);
		const stdoutDigest = canonicalDigest(execution.stdout);
		const stderrDigest = canonicalDigest(execution.stderr);
		let outputSpill;
		const combinedBytes = Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr);
		if (combinedBytes > DEFAULT_EXTENSION_LIMITS.maxStdoutBytes + DEFAULT_EXTENSION_LIMITS.maxStderrBytes && this.#spill) outputSpill = await this.#spill.write("hook-output", Buffer.from(`${execution.stdout}\n${execution.stderr}`));
		const base = { hookId, event: descriptor.event, failureMode: descriptor.failureMode, durationMs: execution.durationMs, exitCode: execution.exitCode, stdoutDigest, stderrDigest, stdoutPreview: preview(execution.stdout, 8_192), stderrPreview: preview(execution.stderr, 8_192), inputDigest: canonicalDigest(JSON.parse(stdin) as unknown), ...(inputSpill ? { inputSpill } : {}), ...(outputSpill ? { outputSpill } : {}) };
		if (execution.status !== "completed" || execution.exitCode !== 0) {
			const status = execution.status === "timed_out" ? "timed_out" : execution.status === "aborted" ? "aborted" : "failed";
			return { ...base, status, decision: descriptor.failureMode === "closed" ? "deny" : "allow", reason: `hook ${status}` };
		}
		const parsed = parseOutput(execution.stdout);
		if (!parsed) return { ...base, status: "failed", decision: descriptor.failureMode === "closed" ? "deny" : "allow", reason: "hook returned invalid JSON" };
		return { ...base, status: parsed.decision === "deny" ? "denied" : "allowed", decision: parsed.decision, reason: parsed.reason ?? (parsed.decision === "deny" ? "hook denied operation" : "hook allowed operation"), ...(parsed.updatedInput !== undefined ? { updatedInput: parsed.updatedInput } : {}), ...(parsed.additionalContext ? { additionalContext: parsed.additionalContext } : {}) };
	}

	#failure(descriptor: HookDescriptor, status: "failed", reason: string, input: string): HookRunOutcome {
		return { hookId: descriptor.descriptor.identity.qualifiedId, event: descriptor.event, status, decision: descriptor.failureMode === "closed" ? "deny" : "allow", failureMode: descriptor.failureMode, reason, durationMs: 0, exitCode: null, stdoutDigest: canonicalDigest(""), stderrDigest: canonicalDigest(reason), stdoutPreview: "", stderrPreview: reason, inputDigest: canonicalDigest(input) };
	}
}
