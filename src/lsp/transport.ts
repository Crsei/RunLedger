/**
 * LSP 传输层 —— 私有 stdio 子进程 (Bun.spawn)。
 *
 * 当前版本只保留私有进程模式;LspTransport 是传输无关的字节流契约,
 * broker 共享 mux 后续实现同一接口即可接入,上层零改动。
 */
import type { LspProcessSpawner, LspTransport } from "./types.ts";

export const WARMUP_TIMEOUT_MS = 5_000;

const STDERR_TAIL_BYTES = 64 * 1024;

interface BunSpawnProcess {
	stdin: {
		write(data: string | Uint8Array): number | Promise<number>;
		flush(): number | void | Promise<number | void>;
	};
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	exitCode: number | null;
	pid: number;
	kill(): void;
}

interface BunRuntime {
	spawn(command: string[], options: {
		cwd: string;
		stdin: "pipe";
		stdout: "pipe";
		stderr: "pipe";
	}): BunSpawnProcess;
}

function bunRuntime(): BunRuntime {
	const runtime = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
	if (runtime === undefined) throw new Error("Bun.spawn is required for the local LSP transport");
	return runtime;
}

export function bunSpawnTransport(command: string, args: string[], cwd: string): LspTransport {
	const proc = bunRuntime().spawn([command, ...args], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stderrTail = "";
	// 持续消费 stderr 防止管道阻塞;只保留尾部 64KB 用于崩溃报告。
	void (async () => {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return;
				stderrTail = (stderrTail + decoder.decode(value, { stream: true })).slice(-STDERR_TAIL_BYTES);
			}
		} finally {
			reader.releaseLock();
		}
	})();
	return {
		stdin: proc.stdin,
		stdout: proc.stdout,
		exited: proc.exited,
		exitCode: proc.exitCode,
		pid: proc.pid,
		kill: () => { proc.kill(); },
		peekStderr: () => stderrTail,
	};
}

/** 默认本地 spawner(测试/无会话场景)。生产由 P6 governed spawner 替换。 */
export function localLspSpawner(): LspProcessSpawner {
	return { spawn: (command, args, cwd) => bunSpawnTransport(command, args, cwd) };
}
