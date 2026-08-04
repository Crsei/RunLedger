/**
 * Governed PTY backend port。
 *
 * PTY implementation is deliberately injected as a platform adapter. The
 * backend owns the adapter handle and output sink; callers only receive the
 * bounded control surface. A platform without a real PTY adapter fails closed
 * instead of pretending that a pipe is a terminal.
 */

import { isAbsolute } from "node:path";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { ExecutionHandleRef, ManagedProcessRequest } from "../../runtime/process/types.ts";
import {
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
} from "../../runtime/process/execution-decision.ts";
import type { BackendSpawnInput, BackendSpawnPort, BackendSpawnReceipt } from "../../runtime/process/manager.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import { clipUtf8Output, PROCESS_OUTPUT_BOUNDS } from "../../runtime/process/output.ts";
import type { FileProcessOutputStore, ProcessOutputStoreErrorCode } from "./output-store.ts";

export interface PtyCommandDescriptor {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
}

export interface PtyAdapterExit {
	readonly exitCode: number | null;
	readonly signal: string | null;
}

export interface PtyAdapterProcess {
	onOutput(listener: (chunk: Uint8Array) => void): () => void;
	wait(): Promise<PtyAdapterExit>;
	write(input: string): Promise<void>;
	eof(): Promise<void>;
	resize(columns: number, rows: number): Promise<void>;
	stop(signal: NodeJS.Signals): boolean;
}

export interface PtyAdapter {
	spawn(input: {
		readonly command: PtyCommandDescriptor;
		readonly handle: ExecutionHandleRef;
		readonly request: ManagedProcessRequest;
		readonly constraintSnapshot: ExecutionConstraintSnapshot;
	}): Promise<PtyAdapterProcess>;
}

export interface PtyProcessBackendOptions {
	readonly adapter: PtyAdapter;
	readonly resolveCommand: (request: ManagedProcessRequest) => PtyCommandDescriptor | Promise<PtyCommandDescriptor>;
	readonly createOutputStore: (input: {
		readonly handle: ExecutionHandleRef;
		readonly request: ManagedProcessRequest;
		readonly constraintSnapshot: ExecutionConstraintSnapshot;
	}) => FileProcessOutputStore;
}

export type PtyProcessOutcome = "completed" | "failed" | "timed_out" | "killed" | "uncertain";

export interface PtyProcessTerminal {
	readonly outcome: PtyProcessOutcome;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly durationMs: number;
	readonly containment: "not_requested" | "zero_members" | "unknown";
}

export interface PtyProcessWaitResult {
	readonly outcome: PtyProcessOutcome;
	readonly terminal?: PtyProcessTerminal;
}

export type PtyMutationResult =
	| { readonly ok: true; readonly receiptDigest: RuntimeDigest }
	| {
			readonly ok: false;
			readonly code: "input_frame_too_large" | "backend_unavailable" | "resize_invalid" | ProcessOutputStoreErrorCode;
	  };

export interface PtyProcessControl {
	readonly output: FileProcessOutputStore;
	onTerminal(listener: (terminal: PtyProcessTerminal) => void): () => void;
	wait(timeoutMs?: number): Promise<PtyProcessWaitResult>;
	write(input: string): Promise<PtyMutationResult>;
	eof(): Promise<PtyMutationResult>;
	resize(columns: number, rows: number): Promise<PtyMutationResult>;
	stop(signal?: NodeJS.Signals): PtyMutationResult;
}

export interface PtySpawnResult {
	readonly receipt: BackendSpawnReceipt;
	readonly process: PtyProcessControl;
}

interface PrivatePtyProcess {
	readonly process: PtyAdapterProcess;
	readonly output: FileProcessOutputStore;
	readonly request: ManagedProcessRequest;
	readonly handle: ExecutionHandleRef;
	readonly startedAt: number;
	readonly terminal: Promise<PtyProcessTerminal>;
	readonly stop: (signal: NodeJS.Signals) => PtyMutationResult;
}

export class PtyProcessBackend {
	private readonly adapter: PtyAdapter;
	private readonly resolveCommand: PtyProcessBackendOptions["resolveCommand"];
	private readonly createOutputStore: PtyProcessBackendOptions["createOutputStore"];
	private readonly processes = new Map<string, PrivatePtyProcess>();
	private readonly receipts = new Map<string, BackendSpawnReceipt>();

	public constructor(options: PtyProcessBackendOptions) {
		this.adapter = options.adapter;
		this.resolveCommand = options.resolveCommand;
		this.createOutputStore = options.createOutputStore;
	}

	public async spawn(input: {
		readonly handle: ExecutionHandleRef;
		readonly request: ManagedProcessRequest;
		readonly spawnClaimDigest: RuntimeDigest;
		readonly constraintSnapshot?: ExecutionConstraintSnapshot;
		readonly constraintInput?: ExecutionConstraintInput;
	}): Promise<PtySpawnResult> {
		const existing = this.processes.get(input.handle.executionId);
		const existingReceipt = this.receipts.get(input.handle.executionId);
		if (existing && existingReceipt) return { receipt: existingReceipt, process: this.createControl(existing) };
		if (input.request.backend !== "pty") throw new Error("PTY backend received a non-PTY request");
		if (!input.constraintSnapshot || !input.constraintInput) throw new Error("execution constraint snapshot and independent input are required before PTY spawn");
		if (!validateSpawnBinding(input) || !validateExecutionConstraintSnapshot(input.constraintInput, input.constraintSnapshot)) {
			throw new Error("execution constraint snapshot is invalid");
		}
		if (input.constraintSnapshot.containment.mode !== "none") {
			throw new Error("PTY strong containment is unsupported by the configured adapter");
		}
		const command = await this.resolveCommand(input.request);
		if (command.executable.length === 0 || !isAbsolute(command.cwd)) throw new Error("PTY command descriptor is invalid");
		const output = this.createOutputStore({ handle: input.handle, request: input.request, constraintSnapshot: input.constraintSnapshot });
		const process = await this.adapter.spawn({ command, handle: input.handle, request: input.request, constraintSnapshot: input.constraintSnapshot });
		const privateProcess = this.createPrivateProcess(process, output, input);
		const receiptDigest = runtimeDigest({
			handle: input.handle,
			spawnClaimDigest: input.spawnClaimDigest,
			requestDigest: input.request.requestDigest,
			commandRef: input.request.commandRef,
			cwdRef: input.request.cwdRef,
			backend: "pty",
		});
		const receipt: BackendSpawnReceipt = {
			receiptDigest,
			evidenceRef: { subjectKind: "receipt", digest: receiptDigest, mediaType: "application/json", size: 0 },
		};
		this.processes.set(input.handle.executionId, privateProcess);
		this.receipts.set(input.handle.executionId, receipt);
		return { receipt, process: this.createControl(privateProcess) };
	}

	/** Host control port; the injected PTY adapter remains private to the backend. */
	public control(handle: ExecutionHandleRef): PtyProcessControl | undefined {
		const process = this.processes.get(handle.executionId);
		return process === undefined ? undefined : this.createControl(process);
	}

	/** Safe Host recovery view; the adapter process handle remains private. */
	public handles(): readonly ExecutionHandleRef[] {
		return [...this.processes.values()].map((process) => process.handle);
	}

	/** Adapt the rich spawn result to ProcessManager's receipt-only port. */
	public asManagerBackend(): BackendSpawnPort & { control: (handle: ExecutionHandleRef) => PtyProcessControl | undefined; handles: () => readonly ExecutionHandleRef[] } {
		return {
			spawn: async (input: BackendSpawnInput): Promise<BackendSpawnReceipt> => (await this.spawn(input)).receipt,
			control: (handle) => this.control(handle),
			handles: () => this.handles(),
		};
	}

	private createPrivateProcess(
		process: PtyAdapterProcess,
		output: FileProcessOutputStore,
		input: {
			readonly handle: ExecutionHandleRef;
			readonly request: ManagedProcessRequest;
		},
	): PrivatePtyProcess {
		let outputTail: Promise<void> = Promise.resolve();
		let outputFailed = false;
		let outputBudgetExceeded = false;
		let outputBytes = 0;
		let stopRequested = false;
		let durationLimitExceeded = false;
		let durationTimer: NodeJS.Timeout | undefined;
		const stopResults = new Map<NodeJS.Signals, PtyMutationResult>();
		let strongestStop: NodeJS.Signals | undefined;
		const maxOutputBytes = input.request.limits?.maxOutputBytes ?? PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes;
		const stopProcess = (signal: NodeJS.Signals): PtyMutationResult => {
			const repeated = stopResults.get(signal);
			if (repeated !== undefined) return repeated;
			if (strongestStop === "SIGKILL") return stopResults.get("SIGKILL")!;
			const result: PtyMutationResult = process.stop(signal)
				? { ok: true, receiptDigest: runtimeDigest({ operation: "stop", handle: input.handle, signal }) }
				: { ok: false, code: "backend_unavailable" };
			stopResults.set(signal, result);
			if (result.ok) strongestStop = signal === "SIGKILL" ? "SIGKILL" : strongestStop ?? signal;
			return result;
		};
		const stopRoot = (): void => {
			if (stopRequested) return;
			stopRequested = true;
			const result = stopProcess("SIGTERM");
			if (!result.ok) {
				outputFailed = true;
			}
		};
		const decoder = new TextDecoder("utf-8");
		const appendOutput = (chunk: Uint8Array): void => {
			const text = decoder.decode(chunk, { stream: true });
			if (text.length === 0) return;
			const clipped = clipUtf8Output(text, Math.max(0, maxOutputBytes - outputBytes));
			outputBytes += clipped.byteLength;
			if (clipped.truncated || clipped.byteLength < Buffer.byteLength(text, "utf8")) outputBudgetExceeded = true;
			if (clipped.text.length === 0) {
				if (outputBudgetExceeded) stopRoot();
				return;
			}
			outputTail = outputTail.then(async () => {
				const result = await output.append(clipped.text);
				if (!result.ok) outputFailed = true;
				if (outputBudgetExceeded) stopRoot();
			});
		};
		process.onOutput(appendOutput);
		const startedAt = Date.now();
		const terminal = process.wait().then(async (exit) => {
			if (durationTimer) clearTimeout(durationTimer);
			const remaining = decoder.decode();
			if (remaining.length > 0) {
				outputTail = outputTail.then(async () => {
					const result = await output.append(remaining);
					if (!result.ok) outputFailed = true;
				});
			}
			await outputTail;
			const sealed = await output.seal();
			if (!sealed.ok) outputFailed = true;
			const outcome: PtyProcessOutcome = outputFailed
				? "uncertain"
				: durationLimitExceeded
					? "timed_out"
					: outputBudgetExceeded && exit.signal !== null
						? "killed"
				: exit.signal !== null
					? exit.signal === "SIGTERM" || exit.signal === "SIGKILL" ? "killed" : "failed"
					: exit.exitCode === 0 ? "completed" : "failed";
			return {
				outcome,
				...(exit.exitCode === null ? {} : { exitCode: exit.exitCode }),
				...(exit.signal === null ? {} : { signal: exit.signal }),
				durationMs: Math.max(0, Date.now() - startedAt),
				containment: "not_requested" as const,
			};
		});
		if (input.request.timeoutMs !== undefined) {
			durationTimer = setTimeout(() => {
				durationLimitExceeded = true;
				stopRoot();
			}, input.request.timeoutMs);
		}
		return { process, output, request: input.request, handle: input.handle, startedAt, terminal, stop: stopProcess };
	}

	private createControl(privateProcess: PrivatePtyProcess): PtyProcessControl {
		return {
			output: privateProcess.output,
			onTerminal: (listener) => {
				let active = true;
				void privateProcess.terminal.then((terminal) => {
					if (active) listener(terminal);
				});
				return () => { active = false; };
			},
			wait: async (timeoutMs = privateProcess.request.timeoutMs ?? RUNTIME_HOST_BOUNDS.maxWaitMs) => {
				if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) {
					throw new Error("PTY wait timeout is outside the bounded range");
				}
				let timer: NodeJS.Timeout | undefined;
				const timeout = new Promise<PtyProcessWaitResult>((resolve) => {
					timer = setTimeout(() => resolve({ outcome: "timed_out" }), timeoutMs);
				});
				const finished = privateProcess.terminal.then((terminal) => ({ outcome: terminal.outcome, terminal }));
				const result = await Promise.race([finished, timeout]);
				if (timer) clearTimeout(timer);
				return result;
			},
			write: async (value: string): Promise<PtyMutationResult> => {
				if (Buffer.byteLength(value, "utf8") > (privateProcess.request.limits?.maxInputFrameBytes ?? RUNTIME_HOST_BOUNDS.maxInputFrameBytes)) {
					return { ok: false, code: "input_frame_too_large" };
				}
				try {
					await privateProcess.process.write(value);
					return { ok: true, receiptDigest: runtimeDigest({ operation: "write", handle: privateProcess.handle, size: Buffer.byteLength(value, "utf8") }) };
				} catch {
					return { ok: false, code: "backend_unavailable" };
				}
			},
			eof: async (): Promise<PtyMutationResult> => {
				try {
					await privateProcess.process.eof();
					return { ok: true, receiptDigest: runtimeDigest({ operation: "eof", handle: privateProcess.handle }) };
				} catch {
					return { ok: false, code: "backend_unavailable" };
				}
			},
			resize: async (columns: number, rows: number): Promise<PtyMutationResult> => {
				if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || columns > 500 || rows < 1 || rows > 200) {
					return { ok: false, code: "resize_invalid" };
				}
				try {
					await privateProcess.process.resize(columns, rows);
					return { ok: true, receiptDigest: runtimeDigest({ operation: "resize", handle: privateProcess.handle, columns, rows }) };
				} catch {
					return { ok: false, code: "backend_unavailable" };
				}
			},
			stop: (signal = "SIGTERM"): PtyMutationResult => {
				return privateProcess.stop(signal);
			},
		};
	}
}

function validateSpawnBinding(input: {
	readonly handle: ExecutionHandleRef;
	readonly request: ManagedProcessRequest;
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
	readonly constraintInput?: ExecutionConstraintInput;
}): boolean {
	const context = input.constraintInput;
	if (!context) return false;
	return context.authorityId === input.request.authorityId && context.authorityId === input.handle.authorityId &&
		context.tenantId === input.request.tenantId && context.tenantId === input.handle.tenantId &&
		context.workspaceId === input.request.workspaceId && context.workspaceId === input.handle.workspaceId &&
		input.request.sessionId === input.handle.sessionId &&
		input.request.hostGeneration === input.handle.hostGeneration &&
		input.request.sessionGeneration === input.handle.sessionGeneration &&
		context.executionId === input.handle.executionId && context.attemptId === input.handle.attemptId &&
		context.commandId === input.request.correlationId &&
		context.requestDigest.digest === input.request.requestDigest.digest &&
		context.requestDigest.digest === input.handle.requestDigest.digest;
}
