/**
 * LSP 生产组合 —— Session managed spawner / governed filesystem / linter runner。
 *
 * process attempt 由 Session process domain 持有到终态；文件副作用只经
 * gated ExecutionEnv 产生一次 workspace_mutation attempt。
 */
import type { FileSystem } from "../execution-env.ts";
import type { LspProcessSpawner, LspTransport, LspWriteOperations } from "../../lsp/types.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../process/types.ts";
import type { OutputCursor } from "../process/output.ts";
import { StderrDiagnostics, STDERR_DRAIN_BOUNDS } from "../process/stderr-diagnostics.ts";
import type { ProcessToolClient } from "../tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../tools/bash.ts";
import type { ManagedForegroundBashOperations } from "../tools/bash.ts";
import type { BiomeRunner } from "../../lsp/clients/biome-client.ts";
import { BiomeClient } from "../../lsp/clients/biome-client.ts";
import type { SwiftLintRunner } from "../../lsp/clients/swiftlint-client.ts";
import { SwiftLintClient } from "../../lsp/clients/swiftlint-client.ts";
import type { LinterClientFactory } from "../../lsp/types.ts";

const LSP_PROCESS_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const LSP_OUTPUT_PAGE_BYTES = 64 * 1024;
const LSP_WAIT_POLL_MS = 500;

interface ManagedLspProcessPort extends ProcessToolClient {
	start(input: Parameters<ManagedBackgroundBashOperations["start"]>[0]): ReturnType<ManagedBackgroundBashOperations["start"]>;
}

function shellQuote(value: string): string {
	return value.length === 0 ? "''" : `'${value.replaceAll("'", "'\\''")}'`;
}

function managedLspCommand(command: string, args: readonly string[]): string {
	return [shellQuote(command), ...args.map(shellQuote)].join(" ");
}

function managedCliRunner(processPort: ManagedForegroundBashOperations): BiomeRunner & SwiftLintRunner {
	return async (args, cwd, resolvedCommand, signal) => {
		const result = await processPort.exec({
			command: [shellQuote(resolvedCommand ?? ""), ...args.map(shellQuote)].join(" "),
			cwd,
			timeoutMs: 300_000,
			maxOutputChars: 1024 * 1024,
			...(signal === undefined ? {} : { signal }),
		});
		return { stdout: result.stdout, stderr: result.stderr, success: result.exitCode === 0 };
	};
}

export function createGovernedLinterFactories(
	processPort: ManagedForegroundBashOperations,
	fileSystem: FileSystem,
): Record<"biome" | "swiftlint", LinterClientFactory> {
	const run = managedCliRunner(processPort);
	return {
		biome: (config, cwd) => new BiomeClient(config, cwd, {
			run,
			readFile: async (filePath) => (await fileSystem.readFile(filePath)).toString("utf8"),
		}),
		swiftlint: (config, cwd) => new SwiftLintClient(config, cwd, { run }),
	};
}

function sameCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

function terminalExitCode(summary: ManagedProcessSummary): number {
	return summary.terminal?.exitCode ?? (summary.state === "completed" ? 0 : 1);
}

/**
 * Host-owned LSP stdio transport.只持有 capability handle 与有界 output cursor,
 * 不暴露 PID、child process、pipe 或 spool path。
 */
class HostManagedLspTransport implements LspTransport {
	readonly stdin: LspTransport["stdin"];
	readonly stdout: ReadableStream<Uint8Array>;
	readonly exited: Promise<number>;
	readonly exitCode = null;
	private readonly processPort: ManagedLspProcessPort;
	private readonly handle: ExecutionHandleRef;
	private readonly resolveExited: (code: number) => void;
	private readonly outputController: ReadableStreamDefaultController<Uint8Array>;
	private cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	private stderrCursor: OutputCursor = { sequence: 0, byteOffset: 0 };
	private readonly diagnostics = new StderrDiagnostics();
	private settled = false;
	private stopping: Promise<void> | undefined;

	constructor(processPort: ManagedLspProcessPort, handle: ExecutionHandleRef) {
		this.processPort = processPort;
		this.handle = handle;
		let outputController!: ReadableStreamDefaultController<Uint8Array>;
		this.stdout = new ReadableStream<Uint8Array>({
			start(controller) { outputController = controller; },
		});
		this.outputController = outputController;
		let resolveExited!: (code: number) => void;
		this.exited = new Promise<number>((resolve) => { resolveExited = resolve; });
		this.resolveExited = resolveExited;
		this.stdin = {
			write: async (data) => {
				const text = typeof data === "string" ? data : new TextDecoder().decode(data);
				const result = await this.processPort.write(this.handle, "driver", text);
				if (!result.ok) throw new Error(`LSP managed process write failed: ${result.code}`);
				return Buffer.byteLength(text, "utf8");
			},
			flush: () => undefined,
		};
		void this.pumpOutput();
	}

	kill(): void {
		this.stopping ??= this.stopAndReap();
	}

	peekStderr(): string { return this.diagnostics.peek(); }

	private async pumpOutput(): Promise<void> {
		try {
			while (!this.settled) {
				const before = this.cursor;
				await this.drainStderr();
				const output = await this.processPort.processOutput(this.handle, this.cursor, LSP_OUTPUT_PAGE_BYTES, "stdout");
				if (!output.ok) throw new Error(`LSP managed process output failed: ${output.code}`);
				this.cursor = output.page.nextCursor;
				if (output.page.text.length > 0) this.outputController.enqueue(new TextEncoder().encode(output.page.text));
				if (output.page.truncated && !sameCursor(before, this.cursor)) continue;
				const waited = await this.processPort.processWait(this.handle, LSP_WAIT_POLL_MS, "driver");
				if (!waited.ok) throw new Error(`LSP managed process wait failed: ${waited.code}`);
				if (waited.outcome === "terminal" || waited.outcome === "uncertain") {
					await this.flushTrailingOutput(waited.nextCursor);
					this.finish(terminalExitCode(waited.summary));
				}
			}
		} catch {
			this.stopping ??= this.stopAndReap(1);
			await this.stopping;
		}
	}

	private async flushTrailingOutput(terminalHead: OutputCursor): Promise<void> {
		await this.drainStderr(terminalHead);
		while (!this.settled) {
			const before = this.cursor;
			const output = await this.processPort.processOutput(this.handle, this.cursor, LSP_OUTPUT_PAGE_BYTES, "stdout");
			if (!output.ok) return;
			this.cursor = output.page.nextCursor;
			if (output.page.text.length > 0) this.outputController.enqueue(new TextEncoder().encode(output.page.text));
			if (!output.page.truncated || sameCursor(before, this.cursor)) return;
		}
	}

	private async drainStderr(terminalHead?: OutputCursor): Promise<void> {
		const maxPages = terminalHead === undefined ? STDERR_DRAIN_BOUNDS.livePages : STDERR_DRAIN_BOUNDS.terminalPages;
		for (let page = 0; page < maxPages && !this.settled; page += 1) {
			if (terminalHead !== undefined && this.stderrCursor.byteOffset >= terminalHead.byteOffset) return;
			const before = this.stderrCursor;
			const output = await this.processPort.processOutput(this.handle, before, LSP_OUTPUT_PAGE_BYTES, "stderr");
			if (!output.ok) throw new Error(`LSP stderr unavailable: ${output.code}`);
			this.stderrCursor = output.page.nextCursor;
			this.diagnostics.append(output.page.text);
			if (!output.page.truncated || sameCursor(before, this.stderrCursor)) return;
		}
	}

	private async stopAndReap(failureExitCode?: number): Promise<void> {
		await this.processPort.stop(this.handle, "driver", "SIGTERM").catch(() => undefined);
		const waited = await this.processPort.processWait(this.handle, 1_000, "driver").catch(() => undefined);
		if (waited?.ok === true && (waited.outcome === "terminal" || waited.outcome === "uncertain")) {
			this.finish(failureExitCode ?? terminalExitCode(waited.summary));
			return;
		}
		await this.processPort.stop(this.handle, "driver", "SIGKILL").catch(() => undefined);
		const reaped = await this.processPort.processWait(this.handle, 1_000, "driver").catch(() => undefined);
		this.finish(failureExitCode ?? (reaped?.ok === true ? terminalExitCode(reaped.summary) : 1));
	}

	private finish(code: number): void {
		if (this.settled) return;
		this.settled = true;
		this.outputController.close();
		this.resolveExited(code);
	}
}

export function createGovernedLspSpawner(processPort: ManagedLspProcessPort): LspProcessSpawner {
	return {
		async spawn(command, args, cwd, signal) {
			if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("LSP process startup aborted");
			const started = await processPort.start({
				command: managedLspCommand(command, args),
				cwd,
				timeoutMs: LSP_PROCESS_MAX_DURATION_MS,
			});
			if (!started.ok) throw new Error(`LSP managed process start failed: ${started.code}`);
			return new HostManagedLspTransport(processPort, started.handle);
		},
	};
}

export function createGovernedLspWriteOperations(
	fileSystem: FileSystem,
): LspWriteOperations {
	return {
		readFile: async (filePath) => (await fileSystem.readFile(filePath)).toString("utf8"),
		writeFile: (filePath, content) => fileSystem.writeFile(filePath, content),
		createDirectory: (directory) => fileSystem.mkdir(directory, { recursive: true }),
		deleteFile: (filePath) => fileSystem.rm(filePath, { force: true }),
		renameFile: (oldPath, newPath) => fileSystem.rename(oldPath, newPath),
	};
}
