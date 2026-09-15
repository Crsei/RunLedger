import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface TestChunkResult {
	readonly pid: number | null;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly durationMs: number;
	readonly exitCode: number;
	readonly signal: NodeJS.Signals | null;
	readonly timeoutKind: "watchdog" | null;
	readonly failureKind: "test_failure" | "spawn_error" | "timeout" | "signal" | null;
	readonly errorCode: string | null;
}

interface TestChunkOptions {
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly watchdogMs: number;
}

/** watchdog 直接终止独立进程组，避免同步 spawn 等待忽略 SIGTERM 的 runner。 */
export function runTestChunk(command: string, args: readonly string[], options: TestChunkOptions): Promise<TestChunkResult> {
	const startedAt = new Date().toISOString();
	const start = performance.now();
	return new Promise((resolve) => {
		let timedOut = false;
		let errorCode: string | null = null;
		const grouped = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: options.cwd, env: options.env, stdio: "inherit", shell: false, detached: grouped,
		});
		const watchdog = setTimeout(() => {
			timedOut = true;
			try {
				if (grouped && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ESRCH") errorCode = code ?? "kill_failed";
			}
		}, options.watchdogMs);
		child.on("error", (error: NodeJS.ErrnoException) => { errorCode = error.code ?? "spawn_failed"; });
		child.once("close", (code, signal) => {
			clearTimeout(watchdog);
			resolve({
				pid: child.pid ?? null, startedAt, finishedAt: new Date().toISOString(),
				durationMs: performance.now() - start,
				exitCode: timedOut || errorCode !== null ? 1 : code ?? 1,
				signal, timeoutKind: timedOut ? "watchdog" : null,
				failureKind: timedOut ? "timeout" : errorCode !== null ? "spawn_error" : signal !== null ? "signal" : code !== 0 ? "test_failure" : null,
				errorCode,
			});
		});
	});
}
