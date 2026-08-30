/**
 * S3 拆分:stdlib 前台 Bash 桥(foreground execution)。
 *
 * 通过窄 port 复用 mutate/plane/isTerminal;输出轮询受 maxOutputBytes
 * 上限约束,abort 触发 stop 与 deadline 兜底;uncertain 终止抛错。
 */

import { runtimeDigest } from "../../protocol/foundation.ts";
import { clipUtf8Output, type OutputCursor } from "../../process/output.ts";
import { SESSION_PROTOCOL_BOUNDS } from "../../session-server/protocol.ts";
import type { OwnerFence } from "../../session-owner/types.ts";
import type { SessionDomainResult } from "../domain-router.ts";
import type { ExecutionHandleRef } from "../../process/types.ts";
import type { ManagedProcessControlPlane, ControlPlaneWaitResult } from "../../../storage/process/control-plane.ts";
import type { ManagedForegroundBashInput } from "../../tools/bash.ts";
import type { ShellResult } from "../../execution-env.ts";

export interface ForegroundExecutionPort {
	readonly fence: OwnerFence;
	readonly plane: ManagedProcessControlPlane;
	readonly revision: () => number;
	readonly isTerminal: (handle: ExecutionHandleRef) => boolean;
	readonly findHandle: (executionId: string) => ExecutionHandleRef | undefined;
	mutate(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult>;
}

export async function executeForegroundProcess(input: ManagedForegroundBashInput, port: ForegroundExecutionPort): Promise<ShellResult> {
	const maxOutputBytes = input.maxOutputChars ?? 1_000_000;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new Error("foreground output limit is invalid");
	const contextSeed = runtimeDigest({
		sessionId: port.fence.sessionId,
		generation: port.fence.generation,
		command: input.command,
		cwd: input.cwd,
		now: Date.now(),
	});
	const started = await port.mutate("session.process.start", {
		command: input.command,
		cwd: input.cwd,
		timeoutMs: input.timeoutMs,
		backend: "pipe",
		executionMode: "foreground",
	}, {
		correlationId: `correlation_${contextSeed.digest.slice(0, 64)}`,
		effectId: `effect_${contextSeed.digest.slice(0, 64)}`,
		expectedRevision: port.revision(),
	});
	if (!started.ok) throw Object.assign(new Error("foreground process rejected"), { code: started.code });
	const executionId = stringValue(started.value.executionId);
	const handle = executionId === undefined ? undefined : port.findHandle(executionId);
	if (handle === undefined) throw new Error("foreground process handle is unavailable");

	if (input.stdin !== undefined && input.stdin.length > 0) {
		const written = await port.mutate("session.process.stdin", { executionId, input: input.stdin }, {
			correlationId: `correlation_${contextSeed.digest.slice(0, 60)}_stdin`,
			effectId: `effect_${contextSeed.digest.slice(0, 60)}_stdin`,
			expectedRevision: port.revision(),
		});
		if (!written.ok) throw new Error(`foreground process stdin failed: ${written.code}`);
	}
	const eof = await port.mutate("session.process.eof", { executionId }, {
		correlationId: `correlation_${contextSeed.digest.slice(0, 62)}_eof`,
		effectId: `effect_${contextSeed.digest.slice(0, 62)}_eof`,
		expectedRevision: port.revision(),
	});
	if (!eof.ok && !port.isTerminal(handle)) throw new Error(`foreground process EOF failed: ${eof.code}`);

	let cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	let stdout = "";
	let capturedBytes = 0;
	let stopRequested = false;
	let stopDeadline = Number.POSITIVE_INFINITY;
	let terminal: Extract<ControlPlaneWaitResult, { readonly ok: true }> | undefined;
	const flushOutput = async (): Promise<void> => {
		while (capturedBytes < maxOutputBytes) {
			const previousCursor = cursor;
			const result = await port.plane.processOutput(handle, cursor, SESSION_PROTOCOL_BOUNDS.maxOutputPageBytes);
			if (!result.ok) throw new Error(`foreground process output failed: ${result.code}`);
			cursor = result.page.nextCursor;
			if (result.page.text.length > 0) {
				const clipped = clipUtf8Output(result.page.text, maxOutputBytes - capturedBytes);
				if (clipped.text.length > 0) {
					stdout += clipped.text;
					capturedBytes += clipped.byteLength;
					input.onStdout?.(clipped.text);
				}
			}
			if (!result.page.truncated || sameOutputCursor(result.page.nextCursor, previousCursor)) return;
		}
	};
	const requestStop = async (): Promise<void> => {
		if (stopRequested) return;
		stopRequested = true;
		stopDeadline = Date.now() + SESSION_PROTOCOL_BOUNDS.maxWaitMs;
		const stopped = await port.mutate("session.process.stop", { executionId }, {
			correlationId: `correlation_${contextSeed.digest.slice(0, 60)}_stop`,
			effectId: `effect_${contextSeed.digest.slice(0, 60)}_stop`,
			expectedRevision: port.revision(),
		});
		if (!stopped.ok && !port.isTerminal(handle)) throw new Error(`foreground process stop failed: ${stopped.code}`);
	};
	let abortListener: (() => void) | undefined;
	let abortSignal: Promise<"aborted"> | undefined;
	if (input.signal) {
		abortSignal = new Promise<"aborted">((resolve) => {
			abortListener = () => resolve("aborted");
			input.signal?.addEventListener("abort", abortListener, { once: true });
		});
	}
	try {
		const deadline = Date.now() + input.timeoutMs;
		while (terminal === undefined) {
			await flushOutput();
			if (input.signal?.aborted) await requestStop();
			if (!stopRequested && Date.now() >= deadline) await requestStop();
			const waitMs = stopRequested
				? Math.min(SESSION_PROTOCOL_BOUNDS.maxWaitMs, Math.max(1, stopDeadline - Date.now()))
				: Math.min(SESSION_PROTOCOL_BOUNDS.maxWaitMs, Math.max(1, deadline - Date.now()));
			const waitPromise = port.plane.processWait(handle, waitMs, "driver");
			const waited = abortSignal === undefined || stopRequested
				? await waitPromise
				: await Promise.race([
						waitPromise,
						abortSignal.then(async () => {
							await requestStop();
							return waitPromise;
						}),
					]);
			const resolved = waited instanceof Promise ? await waited : waited;
			if (!resolved.ok) throw new Error(`foreground process wait failed: ${resolved.code}`);
			if (resolved.outcome === "terminal" || resolved.outcome === "uncertain") terminal = resolved;
			if (stopRequested && terminal === undefined && Date.now() >= stopDeadline) {
				throw new Error("foreground process termination is uncertain");
			}
		}
		await flushOutput();
		const evidence = terminal.summary.terminal;
		return {
			stdout,
			stderr: "",
			exitCode: evidence?.exitCode ?? (terminal.summary.state === "completed" ? 0 : 1),
			...(evidence?.signal === undefined ? {} : { signaled: true }),
		};
	} finally {
		if (input.signal && abortListener) input.signal.removeEventListener("abort", abortListener);
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256 * 1024 ? value : undefined;
}

function sameOutputCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}
