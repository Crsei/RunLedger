/** Trusted production Git broker；参数数组直传 spawn，禁止 shell 拼接。 */

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { GitCommandPort, GitCommandRequest, GitCommandResult } from "../worktree/ports.ts";

const MAX_PRODUCTION_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

export function createProductionGitCommandPort(): GitCommandPort {
	return { run: (request, signal) => runProductionGitCommand(request, signal) };
}

function runProductionGitCommand(request: GitCommandRequest, signal?: AbortSignal): Promise<GitCommandResult> {
	if (!isValidGitRequest(request)) {
		return Promise.resolve({ stdout: "", stderr: "invalid Git command request", exitCode: 2, signaled: false });
	}
	return new Promise<GitCommandResult>((resolveResult) => {
		const child = spawn("git", [...request.arguments], {
			cwd: request.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let settled = false;
		let timedOut = false;
		let overflowed = false;
		const finish = (result: GitCommandResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolveResult(result);
		};
		const abort = (): void => {
			try { child.kill("SIGTERM"); } catch { /* 子进程可能已结束。 */ }
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill("SIGKILL"); } catch { /* 子进程可能已结束。 */ }
		}, request.timeoutMs);
		const append = (target: Buffer[], chunk: Buffer): void => {
			const current = target.reduce((sum, value) => sum + value.byteLength, 0);
			if (current + chunk.byteLength > MAX_PRODUCTION_GIT_OUTPUT_BYTES) {
				overflowed = true;
				try { child.kill("SIGKILL"); } catch { /* 子进程可能已结束。 */ }
				return;
			}
			target.push(Buffer.from(chunk));
		};
		child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
		child.stdin.on("error", () => undefined);
		child.once("error", (error) => finish({ stdout: "", stderr: error.message, exitCode: 127, signaled: false }));
		child.once("close", (code, closeSignal) => finish({
			stdout: Buffer.concat(stdout).toString("utf8"),
			stderr: Buffer.concat(stderr).toString("utf8"),
			exitCode: timedOut || overflowed ? 124 : code ?? 1,
			signaled: timedOut || overflowed || closeSignal !== null || signal?.aborted === true,
		}));
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted === true) abort();
		child.stdin.end(request.stdin);
	});
}

function isValidGitRequest(request: GitCommandRequest): boolean {
	return isAbsolute(request.cwd) && request.arguments.length > 0 && request.arguments.length <= 64 &&
		request.arguments.every((argument) => argument.length <= 1024 && !argument.includes("\0")) &&
		Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 && request.timeoutMs <= 120_000;
}
