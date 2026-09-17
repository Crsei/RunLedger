/**
 * owner 侧的 extension host 通道：把既有 governed managed process 包装成
 * 行式双向通道。
 *
 * 这一层只持有 `ExecutionHandleRef` 与输出游标，不接触 PID、pipe、PTY
 * handle 或子进程对象。进程创建、停止与回收全部经注入的 process port
 * （与 Hook/MCP 同一套能力），因此 extension host 不新增任何进程 authority。
 */

import type { ExecutionHandleRef } from "../../runtime/process/types.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import type { ProcessToolClient } from "../../runtime/tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../../runtime/tools/bash.ts";
import type { ControlPlaneMutationResult, ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../storage/process/control-plane.ts";

export type ExtensionHostManagedProcessPort = ProcessToolClient & Pick<ManagedBackgroundBashOperations, "start">;

export interface ExtensionHostChannelOptions {
	readonly managedProcess: ExtensionHostManagedProcessPort;
	/** 已经按 shell 规则引用好的命令行。 */
	readonly command: string;
	readonly cwd: string;
	readonly startupTimeoutMs: number;
	readonly stopTimeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly pageBytes?: number;
}

export type ExtensionHostChannelRead =
	| { readonly ok: true; readonly lines: readonly string[]; readonly closed: false }
	| { readonly ok: true; readonly lines: readonly string[]; readonly closed: true; readonly exitCode: number | null; readonly state: string }
	| { readonly ok: false; readonly code: string };

export interface ExtensionHostChannel {
	readonly handle: ExecutionHandleRef;
	write(line: string): Promise<ControlPlaneMutationResult>;
	/** 读取下一批行；无数据时最多等待 `timeoutMs`。 */
	read(timeoutMs: number): Promise<ExtensionHostChannelRead>;
	/** 停止并回收进程；幂等。 */
	close(): Promise<void>;
}

const DEFAULT_PAGE_BYTES = 64 * 1024;
const MAX_PAGES_PER_READ = 8;
const DEFAULT_STOP_TIMEOUT_MS = 1_000;

function sameCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

class ManagedProcessExtensionHostChannel implements ExtensionHostChannel {
	public readonly handle: ExecutionHandleRef;
	readonly #port: ExtensionHostManagedProcessPort;
	readonly #pageBytes: number;
	readonly #stopTimeoutMs: number;
	#cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	#pending = "";
	#closed = false;
	#closePromise: Promise<void> | undefined;

	public constructor(port: ExtensionHostManagedProcessPort, handle: ExecutionHandleRef, pageBytes: number, stopTimeoutMs: number) {
		this.#port = port;
		this.handle = handle;
		this.#pageBytes = pageBytes;
		this.#stopTimeoutMs = stopTimeoutMs;
	}

	/** 把新增文本切成完整行；未完成的后缀留在 `#pending`，不做半解析。 */
	#consume(text: string): string[] {
		this.#pending += text;
		const lines: string[] = [];
		while (true) {
			const newline = this.#pending.indexOf("\n");
			if (newline < 0) return lines;
			const line = this.#pending.slice(0, newline).replace(/\r$/u, "");
			this.#pending = this.#pending.slice(newline + 1);
			if (line.length > 0) lines.push(line);
		}
	}

	async #drain(): Promise<{ readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly code: string }> {
		const lines: string[] = [];
		for (let page = 0; page < MAX_PAGES_PER_READ; page += 1) {
			const output: ControlPlaneOutputResult = await this.#port.processOutput(this.handle, this.#cursor, this.#pageBytes, "stdout");
			if (!output.ok) return { ok: false, code: output.code };
			const before = this.#cursor;
			this.#cursor = output.page.nextCursor;
			if (output.page.text.length > 0) lines.push(...this.#consume(output.page.text));
			if (!output.page.truncated || sameCursor(before, this.#cursor)) break;
		}
		return { ok: true, lines };
	}

	public async write(line: string): Promise<ControlPlaneMutationResult> {
		return this.#port.write(this.handle, "driver", `${line}\n`);
	}

	public async read(timeoutMs: number): Promise<ExtensionHostChannelRead> {
		const drained = await this.#drain();
		if (!drained.ok) return drained;
		if (drained.lines.length > 0) return { ok: true, lines: drained.lines, closed: false };
		const waited: ControlPlaneWaitResult = await this.#port.processWait(this.handle, timeoutMs, "driver");
		if (!waited.ok) return { ok: false, code: waited.code };
		if (waited.outcome !== "terminal" && waited.outcome !== "uncertain") return { ok: true, lines: [], closed: false };
		const trailing = await this.#drain();
		if (!trailing.ok) return trailing;
		return {
			ok: true,
			lines: trailing.lines,
			closed: true,
			exitCode: waited.summary.terminal?.exitCode ?? null,
			state: waited.summary.state,
		};
	}

	public close(): Promise<void> {
		this.#closePromise ??= (async () => {
			this.#closed = true;
			await this.#port.stop(this.handle, "driver", "SIGTERM").catch(() => undefined);
			const first = await this.#port.processWait(this.handle, this.#stopTimeoutMs, "driver").catch(() => undefined);
			if (first?.ok === true && (first.outcome === "terminal" || first.outcome === "uncertain")) return;
			await this.#port.stop(this.handle, "driver", "SIGKILL").catch(() => undefined);
			await this.#port.processWait(this.handle, this.#stopTimeoutMs, "driver").catch(() => undefined);
		})();
		return this.#closePromise;
	}
}

export type ExtensionHostChannelStart =
	| { readonly ok: true; readonly channel: ExtensionHostChannel }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * 用既有 governed managed process 启动 host 进程。这是生产路径上唯一创建
 * extension host 的地方：本模块不 import `node:child_process`，也不接受
 * 原始 spawn 函数。
 */
export async function startManagedExtensionHostChannel(options: ExtensionHostChannelOptions): Promise<ExtensionHostChannelStart> {
	const started = await options.managedProcess.start({
		command: options.command,
		cwd: options.cwd,
		timeoutMs: options.startupTimeoutMs,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (!started.ok) return { ok: false, code: started.code, message: `extension host process start failed: ${started.code}` };
	return {
		ok: true,
		channel: new ManagedProcessExtensionHostChannel(
			options.managedProcess,
			started.handle,
			options.pageBytes ?? DEFAULT_PAGE_BYTES,
			options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
		),
	};
}
