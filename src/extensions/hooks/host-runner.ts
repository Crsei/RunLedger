/** Host-owned Hook command runner.
 *
 * Hooks never receive a child-process object or a raw spawn function.  This
 * adapter converts the declarative command into one safely quoted managed
 * process request and owns only the bounded handle/cursor while it drains.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import { clipUtf8Output, type OutputCursor } from "../../runtime/process/output.ts";
import type { ExecutionHandleRef } from "../../runtime/process/types.ts";
import type { ProcessToolClient } from "../../runtime/tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../../runtime/tools/bash.ts";
import type { HookCommandRunner, HookCommandRunnerRequest, HookCommandRunnerResult } from "./types.ts";

type ManagedHookProcess = Pick<ProcessToolClient, "processOutput" | "processWait" | "stop"> & Pick<ManagedBackgroundBashOperations, "start">;

export interface HostManagedHookRunnerOptions {
	readonly managedProcess: ManagedHookProcess;
	readonly defaultCwd?: string;
	readonly maxOutputBytes?: number;
	readonly stopTimeoutMs?: number;
}

const RESERVED_ENVIRONMENT_KEYS = new Set([
	"BASH_ENV",
	"ENV",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"NODE_OPTIONS",
	"RUNLEDGER_HOST_HOME",
	"RUNLEDGER_HOST_SCOPE",
	"RUNLEDGER_HOST_CWD",
]);
const INJECTED_HOOK_KEYS = new Set(["RUNLEDGER_HOOK_EVENT", "RUNLEDGER_HOOK_ID", "RUNLEDGER_SESSION_ID"]);
const DEFAULT_STOP_TIMEOUT_MS = 1_000;

function shellQuote(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

function commandCwd(request: HookCommandRunnerRequest, fallback: string | undefined): string {
	const cwd = request.cwd ?? fallback;
	if (cwd === undefined || !isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Hook managed process requires an absolute cwd");
	return resolve(cwd);
}

function resolveDeclaredCommand(command: string, cwd: string): string {
	if (command.includes("\0")) throw new Error("Hook command contains NUL");
	if (!command.startsWith("./") && !command.startsWith(`.${sep}`) && !command.startsWith("../") && !isAbsolute(command)) return command;
	const resolved = isAbsolute(command) ? resolve(command) : resolve(cwd, command);
	if (!isAbsolute(command)) {
		const escaped = relative(cwd, resolved);
		if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error("Hook command escapes its source directory");
	}
	return resolved;
}

function filteredEnvironment(environment: Readonly<Record<string, string>>): string {
	const entries = Object.entries(environment)
		.filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof value === "string" && !RESERVED_ENVIRONMENT_KEYS.has(key) && (INJECTED_HOOK_KEYS.has(key) || !key.startsWith("RUNLEDGER_")))
		.sort(([left], [right]) => left.localeCompare(right));
	return entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
}

function sameCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

function appendBounded(current: string, value: string, remainingBytes: number): { readonly value: string; readonly bytes: number; readonly truncated: boolean } {
	if (remainingBytes <= 0) return { value: current, bytes: 0, truncated: value.length > 0 };
	const clipped = clipUtf8Output(value, remainingBytes);
	return { value: current + clipped.text, bytes: clipped.byteLength, truncated: clipped.truncated };
}

function terminalExitCode(outcome: "terminal" | "uncertain"): number {
	return outcome === "terminal" ? 0 : 1;
}

export function createHostManagedHookRunner(options: HostManagedHookRunnerOptions): HookCommandRunner {
	const maxOutputBytes = options.maxOutputBytes ?? RUNTIME_HOST_BOUNDS.maxOutputPageBytes;
	const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > RUNTIME_HOST_BOUNDS.maxOutputPageBytes) throw new Error("Hook output bound is invalid");
	if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) throw new Error("Hook stop timeout is invalid");

	return {
		run: async (request) => runManagedHook(options.managedProcess, request, commandCwd(request, options.defaultCwd), maxOutputBytes, stopTimeoutMs),
	};
}

async function runManagedHook(
	managedProcess: ManagedHookProcess,
	request: HookCommandRunnerRequest,
	cwd: string,
	maxOutputBytes: number,
	stopTimeoutMs: number,
): Promise<HookCommandRunnerResult> {
	if (request.signal.aborted) throw new Error("Hook command was aborted before start");
	const command = resolveDeclaredCommand(request.command, cwd);
	const environment = filteredEnvironment(request.env);
	const commandLine = [environment, shellQuote(command), ...request.args.map(shellQuote)].filter((part) => part.length > 0).join(" ");
	const started = await managedProcess.start({ command: commandLine, cwd, timeoutMs: request.timeoutMs, stdin: request.stdin, signal: request.signal });
	if (!started.ok) throw new Error(`managed hook process start failed: ${started.code}`);
	const execution = started.handle;
	let stopPromise: Promise<void> | undefined;
	const stopAndReap = (): Promise<void> => {
		stopPromise ??= (async () => {
			await managedProcess.stop(execution, "driver", "SIGTERM").catch(() => undefined);
			const first = await managedProcess.processWait(execution, stopTimeoutMs, "driver").catch(() => undefined);
			if (first?.ok === true && (first.outcome === "terminal" || first.outcome === "uncertain")) return;
			await managedProcess.stop(execution, "driver", "SIGKILL").catch(() => undefined);
			const second = await managedProcess.processWait(execution, stopTimeoutMs, "driver").catch(() => undefined);
			if (second?.ok !== true || (second.outcome !== "terminal" && second.outcome !== "uncertain")) throw new Error("managed hook process did not settle after SIGKILL");
		})();
		return stopPromise;
	};
	const abort = (): void => { void stopAndReap(); };
	request.signal.addEventListener("abort", abort, { once: true });
	let cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	let stdout = "";
	let capturedBytes = 0;
	try {
		while (true) {
			const page = await managedProcess.processOutput(execution, cursor, RUNTIME_HOST_BOUNDS.maxOutputPageBytes);
			if (!page.ok) throw new Error(`managed hook output failed: ${page.code}`);
			const appended = appendBounded(stdout, page.page.text, maxOutputBytes - capturedBytes);
			stdout = appended.value;
			capturedBytes += appended.bytes;
			const previous = cursor;
			cursor = page.page.nextCursor;
			if (page.page.truncated && !sameCursor(previous, cursor)) continue;
			const waited = await managedProcess.processWait(execution, Math.min(request.timeoutMs, RUNTIME_HOST_BOUNDS.maxWaitMs), "driver");
			if (!waited.ok) throw new Error(`managed hook wait failed: ${waited.code}`);
			if (waited.outcome === "terminal" || waited.outcome === "uncertain") {
				return { exitCode: terminalExitCode(waited.outcome), stdout, stderr: "" };
			}
			if (request.signal.aborted) {
				await stopAndReap();
				return { exitCode: null, stdout, stderr: "" };
			}
		}
	} catch (error) {
		await stopAndReap().catch(() => undefined);
		throw error;
	} finally {
		request.signal.removeEventListener("abort", abort);
	}
}

export type { ManagedHookProcess };
