/**
 * POSIX production PTY adapter backed by node-pty.
 *
 * The native IPty object remains private to this module. The managed process
 * backend receives only the bounded PtyAdapterProcess surface, while strong
 * containment stays capability-gated because node-pty does not provide a
 * descendant-tree supervisor contract.
 */

import { spawn as spawnPty, type IPty } from "node-pty";
import type { ExecutionConstraintSnapshot } from "../../runtime/process/execution-decision.ts";
import type { ExecutionHandleRef, ManagedProcessRequest } from "../../runtime/process/types.ts";
import type { PtyAdapter, PtyAdapterProcess, PtyCommandDescriptor } from "./pty-backend.ts";

export interface NodePtyAdapterCapabilities {
	readonly canResize: true;
	readonly containment: "none";
}

export interface NodePtyAdapterOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly terminalName?: string;
}

export class NodePtyAdapter implements PtyAdapter {
	public readonly capabilities: NodePtyAdapterCapabilities = {
		canResize: true,
		containment: "none",
	};

	private readonly columns: number;
	private readonly rows: number;
	private readonly terminalName: string;

	public constructor(options: NodePtyAdapterOptions = {}) {
		if (process.platform === "win32") throw new Error("POSIX node-pty adapter is unavailable on Windows");
		this.columns = options.columns ?? 80;
		this.rows = options.rows ?? 24;
		this.terminalName = options.terminalName ?? "xterm-256color";
		if (!Number.isSafeInteger(this.columns) || this.columns < 1 || this.columns > 500) throw new Error("PTY columns are outside the bounded range");
		if (!Number.isSafeInteger(this.rows) || this.rows < 1 || this.rows > 200) throw new Error("PTY rows are outside the bounded range");
	}

	public async spawn(input: {
		readonly command: PtyCommandDescriptor;
		readonly handle: ExecutionHandleRef;
		readonly request: ManagedProcessRequest;
		readonly constraintSnapshot: ExecutionConstraintSnapshot;
	}): Promise<PtyAdapterProcess> {
		if (process.platform === "win32") throw new Error("POSIX node-pty adapter is unavailable on Windows");
		const terminal = spawnPty(input.command.executable, [...input.command.args], {
			name: this.terminalName,
			cols: this.columns,
			rows: this.rows,
			cwd: input.command.cwd,
			env: input.command.env ?? process.env,
			encoding: "utf8",
		});
		return new NodePtyProcess(terminal);
	}
}

export function createPosixNodePtyAdapter(options: NodePtyAdapterOptions = {}): NodePtyAdapter {
	return new NodePtyAdapter(options);
}

class NodePtyProcess implements PtyAdapterProcess {
	private readonly terminal: IPty;
	public readonly pid: number;
	private readonly encoder = new TextEncoder();
	private readonly finished: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>;
	private exited = false;

	public constructor(terminal: IPty) {
		this.terminal = terminal;
		this.pid = terminal.pid;
		this.finished = new Promise((resolve) => {
			terminal.onExit((event) => {
				this.exited = true;
				resolve({
					exitCode: Number.isSafeInteger(event.exitCode) ? event.exitCode : null,
					signal: signalName(event.signal),
				});
			});
		});
	}

	public onOutput(listener: (chunk: Uint8Array) => void): () => void {
		const subscription = this.terminal.onData((value) => listener(this.encoder.encode(value)));
		return () => subscription.dispose();
	}

	public wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
		return this.finished;
	}

	public async write(input: string): Promise<void> {
		if (this.exited) throw new Error("PTY is no longer running");
		this.terminal.write(input);
	}

	public async eof(): Promise<void> {
		if (this.exited) throw new Error("PTY is no longer running");
		this.terminal.write("\u0004");
	}

	public async resize(columns: number, rows: number): Promise<void> {
		if (this.exited) throw new Error("PTY is no longer running");
		this.terminal.resize(columns, rows);
	}

	public stop(signal: NodeJS.Signals): boolean {
		if (this.exited) return false;
		try {
			this.terminal.kill(signal);
			return true;
		} catch {
			return false;
		}
	}
}

function signalName(signal: number | undefined): string | null {
	if (signal === undefined || signal === 0) return null;
	const names: Readonly<Record<number, string>> = {
		1: "SIGHUP",
		2: "SIGINT",
		9: "SIGKILL",
		15: "SIGTERM",
	};
	return names[signal] ?? `SIG${signal}`;
}
