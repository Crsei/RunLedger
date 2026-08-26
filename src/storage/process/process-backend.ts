/**
 * Linux/Node pipe backend。
 *
 * 这是唯一持有 child_process 的 process backend。它只接受已经冻结并校验
 * 的 execution constraint snapshot；命令、cwd 和 child handle 留在 private
 * backend record，spawn receipt 只返回 digest/ref。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { ExecutionHandleRef, ManagedProcessRequest } from "../../runtime/process/types.ts";
import {
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
} from "../../runtime/process/execution-decision.ts";
import type { BackendLaunchPlan, BackendSpawnInput, BackendSpawnPort, BackendSpawnReceipt } from "../../runtime/process/manager.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import { clipUtf8Output, PROCESS_OUTPUT_BOUNDS } from "../../runtime/process/output.ts";
import {
	FileProcessOutputStore,
} from "./output-store.ts";

export interface PipeCommandDescriptor {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env?: NodeJS.ProcessEnv;
}

export interface PipeProcessBackendOptions {
	readonly resolveCommand: (
		request: ManagedProcessRequest,
	) => PipeCommandDescriptor | Promise<PipeCommandDescriptor>;
	readonly createOutputStore: (
		input: PipeSpawnInput,
	) => FileProcessOutputStore;
	/** Host-private observation seam; it receives bytes, never process text. */
	readonly onProcessIo?: (input: {
		readonly handle: ExecutionHandleRef;
		readonly stream: "stdin" | "stdout" | "stderr";
		readonly observedBytes: number;
		readonly retainedBytes: number;
	}) => void | Promise<void>;
	/** Host-private process identity; PID never crosses the public process DTO. */
	readonly onProcessSpawned?: (input: { readonly handle: ExecutionHandleRef; readonly pid: number }) => void | Promise<void>;
}

export interface PipeSpawnInput {
	readonly handle: ExecutionHandleRef;
	readonly request: ManagedProcessRequest;
	readonly spawnClaimDigest: RuntimeDigest;
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
	readonly constraintInput?: ExecutionConstraintInput;
	readonly launchPlan?: BackendLaunchPlan;
	readonly beforeSpawn?: () => Promise<void>;
}

export type PipeProcessOutcome = "completed" | "failed" | "timed_out" | "killed" | "uncertain";

export interface PipeProcessTerminal {
	readonly outcome: PipeProcessOutcome;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly durationMs: number;
	readonly containment: "not_requested" | "zero_members" | "unknown";
}

export interface PipeProcessWaitResult {
	readonly outcome: PipeProcessOutcome;
	readonly terminal?: PipeProcessTerminal;
}

export type PipeMutationResult =
	| { readonly ok: true; readonly receiptDigest: RuntimeDigest }
	| { readonly ok: false; readonly code: "input_frame_too_large" | "backend_unavailable" };

export interface PipeProcessControl {
	readonly output: FileProcessOutputStore;
	onTerminal(listener: (terminal: PipeProcessTerminal) => void): () => void;
	wait(timeoutMs?: number): Promise<PipeProcessWaitResult>;
	write(input: string): Promise<PipeMutationResult>;
	eof(): Promise<PipeMutationResult>;
	stop(signal?: NodeJS.Signals): PipeMutationResult;
}

export interface PipeSpawnResult {
	readonly receipt: BackendSpawnReceipt;
	readonly process: PipeProcessControl;
}

interface PrivatePipeProcess {
	readonly child: ChildProcessWithoutNullStreams;
	readonly output: FileProcessOutputStore;
	readonly request: ManagedProcessRequest;
	readonly handle: ExecutionHandleRef;
	readonly startedAt: number;
	readonly containment: "none" | "process_group" | "supervisor";
	readonly terminal: Promise<PipeProcessTerminal>;
	readonly stop: (signal: NodeJS.Signals) => PipeMutationResult;
}

export class PipeProcessBackend {
	private readonly resolveCommand: PipeProcessBackendOptions["resolveCommand"];
	private readonly createOutputStore: PipeProcessBackendOptions["createOutputStore"];
	private readonly onProcessIo: PipeProcessBackendOptions["onProcessIo"];
	private readonly onProcessSpawned: PipeProcessBackendOptions["onProcessSpawned"];
	private readonly processes = new Map<string, PrivatePipeProcess>();
	private readonly receipts = new Map<string, BackendSpawnReceipt>();

	public constructor(options: PipeProcessBackendOptions) {
		this.resolveCommand = options.resolveCommand;
		this.createOutputStore = options.createOutputStore;
		this.onProcessIo = options.onProcessIo;
		this.onProcessSpawned = options.onProcessSpawned;
	}

	public async spawn(input: PipeSpawnInput): Promise<PipeSpawnResult> {
		const existing = this.processes.get(input.handle.executionId);
		const existingReceipt = this.receipts.get(input.handle.executionId);
		if (existing && existingReceipt) return { receipt: existingReceipt, process: this.createControl(existing) };
		if (!input.constraintSnapshot || !input.constraintInput) throw new Error("execution constraint snapshot and independent input are required before spawn");
		if (!validateSpawnBinding(input) || !validateExecutionConstraintSnapshot(input.constraintInput, input.constraintSnapshot)) {
			throw new Error("execution constraint snapshot is invalid");
		}
		const containment = input.constraintSnapshot.modes.containment;
		if (containment === "supervisor" && process.platform === "win32") throw new Error("supervisor containment is unsupported on Windows");
		if (containment === "process_group" && process.platform === "win32") throw new Error("process-group containment is unsupported on Windows");
		if (input.beforeSpawn) await input.beforeSpawn();
		const descriptor = input.launchPlan === undefined
			? await this.resolveCommand(input.request)
			: launchPlanDescriptor(input.launchPlan);
		if (descriptor.executable.length === 0 || !isAbsolute(descriptor.cwd)) throw new Error("pipe command descriptor is invalid");
		const output = this.createOutputStore(input);
		const child = containment === "supervisor"
			? spawnSupervisedProcess(descriptor)
			: spawn(descriptor.executable, [...descriptor.args], {
					cwd: descriptor.cwd,
					env: descriptor.env,
					shell: false,
					detached: containment === "process_group",
					stdio: ["pipe", "pipe", "pipe"],
				});
		const privateProcess = this.createPrivateProcess(child, output, input, containment);
		if (child.pid !== undefined) void this.onProcessSpawned?.({ handle: input.handle, pid: child.pid });
		const receiptDigest = runtimeDigest({
			handle: input.handle,
			spawnClaimDigest: input.spawnClaimDigest,
			requestDigest: input.request.requestDigest,
			commandRef: input.request.commandRef,
			cwdRef: input.request.cwdRef,
		});
		const receipt: BackendSpawnReceipt = {
			receiptDigest,
			evidenceRef: { subjectKind: "receipt", digest: receiptDigest, mediaType: "application/json", size: 0 },
		};
		this.processes.set(input.handle.executionId, privateProcess);
		this.receipts.set(input.handle.executionId, receipt);
		return { receipt, process: this.createControl(privateProcess) };
	}

	/** Host control port; the private child record never crosses this method. */
	public control(handle: ExecutionHandleRef): PipeProcessControl | undefined {
		const process = this.processes.get(handle.executionId);
		return process === undefined ? undefined : this.createControl(process);
	}

	/** Safe Host recovery view; private child handles never leave this map. */
	public handles(): readonly ExecutionHandleRef[] {
		return [...this.processes.values()].map((process) => process.handle);
	}

	/** Adapt the rich spawn result to ProcessManager's receipt-only port. */
	public asManagerBackend(): BackendSpawnPort & { control: (handle: ExecutionHandleRef) => PipeProcessControl | undefined; handles: () => readonly ExecutionHandleRef[] } {
		return {
			spawn: async (input: BackendSpawnInput): Promise<BackendSpawnReceipt> => (await this.spawn(input)).receipt,
			control: (handle) => this.control(handle),
			handles: () => this.handles(),
		};
	}

	private createPrivateProcess(
		child: ChildProcessWithoutNullStreams,
		output: FileProcessOutputStore,
		input: PipeSpawnInput,
		containment: "none" | "process_group" | "supervisor",
	): PrivatePipeProcess {
		let outputTail: Promise<void> = Promise.resolve();
		let outputFailed = false;
		let outputBudgetExceeded = false;
		let outputBytes = 0;
		let stopRequested = false;
		let durationLimitExceeded = false;
		let durationTimer: NodeJS.Timeout | undefined;
		const stopResults = new Map<NodeJS.Signals, PipeMutationResult>();
		let strongestStop: NodeJS.Signals | undefined;
		let supervisorSettlement: "zero_members" | "unknown" | undefined;
		let supervisorExitCode: number | null | undefined;
		let supervisorExitSignal: string | null | undefined;
		let resolveSupervisorSettlement: ((value: "zero_members" | "unknown") => void) | undefined;
		const supervisorSettlementReady = containment === "supervisor"
			? new Promise<"zero_members" | "unknown">((resolve) => { resolveSupervisorSettlement = resolve; })
			: undefined;
		if (containment === "supervisor") {
			child.on("message", (message: unknown) => {
				if (!isSupervisorExit(message)) return;
				supervisorSettlement = message.containment;
				supervisorExitCode = message.exitCode;
				supervisorExitSignal = message.signal;
				resolveSupervisorSettlement?.(message.containment);
			});
		}
		const maxOutputBytes = input.request.limits?.maxOutputBytes ?? PROCESS_OUTPUT_BOUNDS.maxDurableOutputBytes;
		const stopProcess = (signal: NodeJS.Signals): PipeMutationResult => {
			const repeated = stopResults.get(signal);
			if (repeated !== undefined) return repeated;
			if (strongestStop === "SIGKILL") return stopResults.get("SIGKILL")!;
			let result: PipeMutationResult;
			if (child.exitCode !== null || child.signalCode !== null) {
				result = { ok: true, receiptDigest: runtimeDigest({ operation: "stop", handle: input.handle, signal, alreadyTerminated: true }) };
				stopResults.set(signal, result);
				return result;
			}
			try {
				const sent = containment === "supervisor"
					? sendSupervisorStop(child, signal)
					: containment === "process_group" && child.pid !== undefined && process.platform !== "win32"
						? sendProcessGroupSignal(child.pid, signal)
						: child.kill(signal);
				result = sent
					? { ok: true, receiptDigest: runtimeDigest({ operation: "stop", handle: input.handle, signal }) }
					: { ok: false, code: "backend_unavailable" };
			} catch {
				// close/error settlement will classify the result as uncertain if the stop is not observable.
				result = { ok: false, code: "backend_unavailable" };
			}
			stopResults.set(signal, result);
			if (result.ok) strongestStop = signal === "SIGKILL" ? "SIGKILL" : strongestStop ?? signal;
			return result;
		};
		const stopRoot = (): void => {
			if (stopRequested) return;
			stopRequested = true;
			stopProcess("SIGTERM");
		};
		const appendText = (text: string, stream: "stdout" | "stderr", observedBytes = 0): void => {
			const clipped = clipUtf8Output(text, Math.max(0, maxOutputBytes - outputBytes));
			outputBytes += clipped.byteLength;
			if (clipped.truncated || clipped.byteLength < Buffer.byteLength(text, "utf8")) outputBudgetExceeded = true;
			void this.onProcessIo?.({ handle: input.handle, stream, observedBytes, retainedBytes: clipped.byteLength });
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
		const stdoutDecoder = new TextDecoder("utf-8");
		const stderrDecoder = new TextDecoder("utf-8");
		child.stdout.on("data", (chunk: Buffer) => appendText(stdoutDecoder.decode(chunk, { stream: true }), "stdout", chunk.byteLength));
		child.stderr.on("data", (chunk: Buffer) => appendText(stderrDecoder.decode(chunk, { stream: true }), "stderr", chunk.byteLength));
		// A fast child may close stdin between the capability check and a write.
		// Keep the stream error observable by the operation callback without
		// allowing a late EPIPE event to escape as an uncaught process error.
		child.stdin.on("error", () => {});
		const startedAt = Date.now();
		let resolveTerminal: ((terminal: PipeProcessTerminal) => void) | undefined;
		let settled = false;
		const terminal = new Promise<PipeProcessTerminal>((resolve) => {
			resolveTerminal = resolve;
		});
		const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (durationTimer) clearTimeout(durationTimer);
			appendText(stdoutDecoder.decode(), "stdout");
			appendText(stderrDecoder.decode(), "stderr");
			void outputTail.then(async () => {
				if (supervisorSettlementReady !== undefined && supervisorSettlement === undefined) {
					await Promise.race([
						supervisorSettlementReady,
						new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
					]);
				}
				try {
					const sealed = await output.seal();
					if (!sealed.ok) outputFailed = true;
				} catch {
					outputFailed = true;
				}
				const effectiveCode = containment === "supervisor" && supervisorExitCode !== undefined ? supervisorExitCode : code;
				const effectiveSignal = containment === "supervisor" && supervisorExitSignal !== undefined ? supervisorExitSignal : signal;
				const outcome: PipeProcessOutcome = outputFailed
					? "uncertain"
					: durationLimitExceeded
						? "timed_out"
					: outputBudgetExceeded && effectiveSignal !== null
						? "killed"
					: effectiveSignal !== null
						? effectiveSignal === "SIGTERM" || effectiveSignal === "SIGKILL" ? "killed" : "failed"
						: effectiveCode === 0 ? "completed" : "failed";
				resolveTerminal?.({
					outcome,
					...(effectiveCode === null ? {} : { exitCode: effectiveCode }),
					...(effectiveSignal === null ? {} : { signal: effectiveSignal }),
					durationMs: Math.max(0, Date.now() - startedAt),
					containment: containmentSettlement(child, containment, supervisorSettlement),
				});
			});
		};
		if (input.request.timeoutMs !== undefined) {
			durationTimer = setTimeout(() => {
				durationLimitExceeded = true;
				stopRoot();
			}, input.request.timeoutMs);
		}
		child.once("error", () => settle(null, null));
		child.once("close", (code, signal) => settle(code, signal));
		return { child, output, request: input.request, handle: input.handle, startedAt, containment, terminal, stop: stopProcess };
	}

	private createControl(privateProcess: PrivatePipeProcess): PipeProcessControl {
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
					throw new Error("pipe wait timeout is outside the bounded range");
				}
				let timer: NodeJS.Timeout | undefined;
				const timeout = new Promise<PipeProcessWaitResult>((resolve) => {
					timer = setTimeout(() => resolve({ outcome: "timed_out" }), timeoutMs);
				});
				const finished = privateProcess.terminal.then((terminal) => ({ outcome: terminal.outcome, terminal }));
				const result = await Promise.race([finished, timeout]);
				if (timer) clearTimeout(timer);
				return result;
			},
			write: async (value: string): Promise<PipeMutationResult> => {
				if (Buffer.byteLength(value, "utf8") > (privateProcess.request.limits?.maxInputFrameBytes ?? RUNTIME_HOST_BOUNDS.maxInputFrameBytes)) {
					return { ok: false, code: "input_frame_too_large" };
				}
				const stdin = privateProcess.child.stdin;
				if (stdin.destroyed || privateProcess.child.killed) return { ok: false, code: "backend_unavailable" };
				return new Promise((resolve) => {
					let settled = false;
					const finish = (result: PipeMutationResult): void => {
						if (settled) return;
						settled = true;
						stdin.off("error", onError);
						resolve(result);
					};
					const onError = (): void => finish({ ok: false, code: "backend_unavailable" });
					stdin.once("error", onError);
					try {
					stdin.write(value, "utf8", (error: Error | null | undefined) => {
						if (!error) {
							const bytes = Buffer.byteLength(value, "utf8");
							void this.onProcessIo?.({ handle: privateProcess.handle, stream: "stdin", observedBytes: bytes, retainedBytes: bytes });
						}
						finish(error
							? { ok: false, code: "backend_unavailable" }
							: { ok: true, receiptDigest: runtimeDigest({ operation: "write", handle: privateProcess.handle, size: Buffer.byteLength(value, "utf8") }) });
						});
					} catch {
						finish({ ok: false, code: "backend_unavailable" });
					}
				});
			},
			eof: async (): Promise<PipeMutationResult> => {
				const stdin = privateProcess.child.stdin;
				if (stdin.destroyed || privateProcess.child.killed) {
					return { ok: true, receiptDigest: runtimeDigest({ operation: "eof", handle: privateProcess.handle, alreadyClosed: true }) };
				}
				return new Promise((resolve) => {
					let settled = false;
					const finish = (result: PipeMutationResult): void => {
						if (settled) return;
						settled = true;
						stdin.off("error", onError);
						resolve(result);
					};
					const onError = (): void => finish({ ok: false, code: "backend_unavailable" });
					stdin.once("error", onError);
					try {
						stdin.end(() => finish({ ok: true, receiptDigest: runtimeDigest({ operation: "eof", handle: privateProcess.handle }) }));
					} catch {
						finish({ ok: false, code: "backend_unavailable" });
					}
				});
			},
			stop: (signal = "SIGTERM"): PipeMutationResult => {
				return privateProcess.stop(signal);
			},
		};
	}
}

function launchPlanDescriptor(plan: BackendLaunchPlan): PipeCommandDescriptor {
	return {
		executable: plan.program,
		args: [...plan.arguments],
		cwd: plan.cwd,
		env: { ...plan.environment },
	};
}

function sendProcessGroupSignal(pid: number, signal: NodeJS.Signals): boolean {
	process.kill(-pid, signal);
	return true;
}

function containmentSettlement(
	child: ChildProcessWithoutNullStreams,
	containment: "none" | "process_group" | "supervisor",
	supervisorSettlement?: "zero_members" | "unknown",
): "not_requested" | "zero_members" | "unknown" {
	if (containment === "none") return "not_requested";
	if (containment === "supervisor") return supervisorSettlement ?? "unknown";
	if (process.platform === "win32" || child.pid === undefined) return "unknown";
	try {
		process.kill(-child.pid, 0);
		return "unknown";
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return "zero_members";
		return "unknown";
	}
}

function spawnSupervisedProcess(descriptor: PipeCommandDescriptor): ChildProcessWithoutNullStreams {
	if (process.platform === "win32") throw new Error("supervisor containment is unsupported on Windows");
	const compiled = fileURLToPath(new URL("./supervisor-runner.js", import.meta.url));
	const entryPath = existsSync(compiled)
		? compiled
		: fileURLToPath(new URL("./supervisor-runner.ts", import.meta.url));
	const args = entryPath.endsWith(".ts") ? ["--import", "tsx", entryPath] : [entryPath];
	const child = spawn(process.execPath, args, {
		// The supervisor itself must resolve the package-local TS loader when the
		// source tree is executed in tests/dev; the managed command still receives
		// its requested cwd through the private start message.
		cwd: process.cwd(),
		env: process.env,
		detached: true,
		stdio: ["pipe", "pipe", "pipe", "ipc"],
	});
	const supervised = child as unknown as ChildProcessWithoutNullStreams;
	try {
		child.send?.({ type: "start", command: descriptor }, (error) => {
			if (error) child.kill("SIGTERM");
		});
	} catch {
		child.kill("SIGTERM");
		throw new Error("supervisor startup failed");
	}
	return supervised;
}

function sendSupervisorStop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): boolean {
	if (!child.connected || child.send === undefined) return false;
	try {
		child.send({ type: "stop", signal });
		return true;
	} catch {
		return false;
	}
}

function isSupervisorExit(value: unknown): value is {
	readonly type: "exit";
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly containment: "zero_members" | "unknown";
} {
	return typeof value === "object" && value !== null && "type" in value && value.type === "exit" &&
		"exitCode" in value && (typeof value.exitCode === "number" || value.exitCode === null) &&
		"signal" in value && (typeof value.signal === "string" || value.signal === null) &&
		"containment" in value && (value.containment === "zero_members" || value.containment === "unknown");
}

function validateSpawnBinding(input: PipeSpawnInput): boolean {
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
