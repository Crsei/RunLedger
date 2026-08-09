/**
 * Host-owned managed-process control port。
 *
 * Tool、TUI 和 transport 只依赖这一层：它把 manager 的 durable projection
 * 与 backend 的 private control surface 拼起来，并在 terminal 成为 journal
 * truth 后才写 completion Queue。backend 的 child/PID/PTY handle 不会越过此
 * 文件进入 public result。
 */

import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import type { RuntimeHostLifecycleProcess } from "../../runtime/host/lifecycle.ts";
import {
	AuditedProcessManager,
	ProcessManager,
	type BackendSpawnOptions,
	type BackendSpawnPort,
	type ProcessCreateResult,
} from "../../runtime/process/manager.ts";
import type { ExecutionConstraintInput } from "../../runtime/process/execution-decision.ts";
import { CompletionReconciler, type CompletionAgentPort, type CompletionQueuePort, type CompletionSchedulerResult } from "../../runtime/process/completion-reconciler.ts";
import {
	ManagedProcessOutputMaterializer,
	type ProcessOutputMaterializationRecord,
	type ProcessOutputMaterializationResult,
} from "../../runtime/process/output-artifact.ts";
import type {
	ExecutionHandleRef,
	ManagedProcessOutputPage,
	ManagedProcessSummary,
	ProcessCompletionEnvelope,
	ProcessState,
	ProcessTerminalState,
} from "../../runtime/process/types.ts";
import type { OutputCursor } from "../../runtime/process/output.ts";
import type { FileProcessOutputStore, ProcessOutputReadResult } from "./output-store.ts";
import type { RecordingFailurePolicy } from "../../storage/settings-manager.ts";

export type ControlPlaneActor = "driver" | "observer";

export interface ManagedProcessBackendWaitTerminal {
	readonly outcome: Exclude<ProcessTerminalState, "lost">;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly durationMs: number;
	readonly containment: "not_requested" | "zero_members" | "unknown";
}

export interface ManagedProcessBackendWaitResult {
	readonly outcome: "completed" | "failed" | "timed_out" | "killed" | "uncertain";
	readonly terminal?: ManagedProcessBackendWaitTerminal;
}

export type ManagedProcessBackendMutationResult =
	| { readonly ok: true; readonly receiptDigest: RuntimeDigest }
	| { readonly ok: false; readonly code: string };

/**
 * The only backend shape exposed to the control plane. Implementations may
 * keep any process handle privately; control() returns only bounded methods.
 */
export interface ManagedProcessBackendControl {
	readonly output: Pick<FileProcessOutputStore, "read" | "head" | "seal"> & Partial<Pick<FileProcessOutputStore, "readAll" | "readMaterialization" | "recordMaterialization">>;
	onTerminal?(listener: (terminal: ManagedProcessBackendWaitTerminal) => void): () => void;
	wait(timeoutMs: number): Promise<ManagedProcessBackendWaitResult>;
	write(input: string): Promise<ManagedProcessBackendMutationResult>;
	eof(): Promise<ManagedProcessBackendMutationResult>;
	stop(signal?: NodeJS.Signals): ManagedProcessBackendMutationResult;
	resize?(columns: number, rows: number): Promise<ManagedProcessBackendMutationResult>;
}

export interface ManagedProcessBackendPort extends BackendSpawnPort {
	handles?(): readonly ExecutionHandleRef[];
	control(handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined;
}

export interface ManagedProcessControlPlaneOptions {
	readonly manager: ProcessManager;
	readonly auditedManager: AuditedProcessManager;
	readonly backend: ManagedProcessBackendPort;
	readonly completionQueue: CompletionQueuePort;
	readonly completionReconciler?: CompletionReconciler;
	/** Host-owned Agent bridge; terminal watchers never call it directly. */
	readonly completionAgent?: CompletionAgentPort;
	readonly outputMaterializer?: ManagedProcessOutputMaterializer;
	/** Durable materialization succeeds before this callback is observed; callback failure is best effort. */
	readonly onOutputMaterialized?: (input: {
		readonly handle: ExecutionHandleRef;
		readonly record: ProcessOutputMaterializationRecord;
	}) => void | Promise<void>;
	/** Durable terminal truth 已提交后的 Session/Host attempt 收口回调。 */
	readonly onProcessTerminal?: (summary: ManagedProcessSummary) => void | Promise<void>;
	readonly recordingFailurePolicy?: RecordingFailurePolicy;
	/** Queue admission is followed by a scheduler wake-up; this callback never prompts the Agent directly. */
	readonly onAutomaticCompletion?: (envelope: ProcessCompletionEnvelope) => void;
	readonly policyDigest: RuntimeDigest;
	readonly budgetDigest: RuntimeDigest;
}

export type ControlPlaneErrorCode =
	| "backend_unavailable"
	| "process_not_found"
	| "journal_invalid"
	| "journal_unavailable"
	| "invalid_timeout"
	| "output_cursor_invalid"
	| "output_cursor_resync_required"
	| "output_unavailable"
	| "observer_mutation_forbidden"
	| "terminal_state_immutable"
	| "mutation_rejected"
	| "queue_unavailable"
	| "artifact_materialization_failed"
	| "uncertain_outcome";

export type ControlPlaneCreateResult =
	| Extract<ProcessCreateResult, { readonly ok: true }>
	| { readonly ok: false; readonly code: ControlPlaneErrorCode | string };

export type ControlPlaneOutputResult =
	| {
			readonly ok: true;
			readonly page: ManagedProcessOutputPage;
			readonly head: OutputCursor;
	  }
	| { readonly ok: false; readonly code: ControlPlaneErrorCode; readonly earliestCursor?: OutputCursor };

export type ControlPlaneWaitResult =
	| {
			readonly ok: true;
			readonly outcome: "terminal" | "running" | "timed_out" | "uncertain";
			readonly summary: ManagedProcessSummary;
			readonly preview?: string;
			readonly nextCursor: OutputCursor;
			readonly terminalEvidenceRef?: RuntimeContentRef;
	  }
	| { readonly ok: false; readonly code: ControlPlaneErrorCode };

export type ControlPlaneMutationResult =
	| {
			readonly ok: true;
			readonly operation: "write" | "eof" | "resize" | "stop";
			readonly receiptDigest: RuntimeDigest;
			readonly summary: ManagedProcessSummary;
	  }
	| { readonly ok: false; readonly code: ControlPlaneErrorCode };

interface TerminalSettlement {
	readonly state: Extract<ProcessState, "completed" | "failed" | "killed" | "timed_out" | "uncertain">;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly durationMs?: number;
	readonly evidenceRef: RuntimeContentRef;
}

export class ManagedProcessControlPlane {
	private readonly manager: ProcessManager;
	private readonly auditedManager: AuditedProcessManager;
	private readonly backend: ManagedProcessBackendPort;
	private readonly completionQueue: CompletionQueuePort;
	private readonly policyDigest: RuntimeDigest;
	private readonly budgetDigest: RuntimeDigest;
	private readonly completionReconciler: CompletionReconciler;
	private readonly completionAgent: CompletionAgentPort | undefined;
	private readonly terminalWatchers = new Map<string, () => void>();
	private readonly terminalTasks = new Set<Promise<void>>();
	private readonly terminalFailures: Error[] = [];
	private readonly outputMaterializer: ManagedProcessOutputMaterializer | undefined;
	private readonly materializations = new Map<string, Promise<ProcessOutputMaterializationResult>>();
	private readonly onAutomaticCompletion: ((envelope: ProcessCompletionEnvelope) => void) | undefined;
	private readonly onOutputMaterialized: ((input: {
		readonly handle: ExecutionHandleRef;
		readonly record: ProcessOutputMaterializationRecord;
	}) => void | Promise<void>) | undefined;
	private readonly onProcessTerminal: ((summary: ManagedProcessSummary) => void | Promise<void>) | undefined;
	private readonly recordingFailurePolicy: RecordingFailurePolicy;

	public constructor(options: ManagedProcessControlPlaneOptions) {
		this.manager = options.manager;
		this.auditedManager = options.auditedManager;
		this.backend = options.backend;
		this.completionQueue = options.completionQueue;
		this.completionReconciler = options.completionReconciler ?? new CompletionReconciler(options.completionQueue);
		this.completionAgent = options.completionAgent;
		this.policyDigest = options.policyDigest;
		this.budgetDigest = options.budgetDigest;
		this.outputMaterializer = options.outputMaterializer;
		this.onAutomaticCompletion = options.onAutomaticCompletion;
		this.onOutputMaterialized = options.onOutputMaterialized;
		this.onProcessTerminal = options.onProcessTerminal;
		this.recordingFailurePolicy = options.recordingFailurePolicy ?? "best_effort";
	}

	public async create(
		request: Parameters<AuditedProcessManager["create"]>[0],
		decisionInput: ExecutionConstraintInput,
		spawnOptions?: BackendSpawnOptions,
	): Promise<ControlPlaneCreateResult> {
		const created = await this.auditedManager.create(request, decisionInput, spawnOptions);
		if (!created.ok) return created;
		const control = this.backend.control(created.handle);
		// A restarted Host may safely replay a durable terminal projection and its
		// mutation receipts without reattaching a PID. Non-terminal state still
		// requires a live backend control surface and fails closed.
		if (!control) return isTerminalSummary(created.summary) ? created : { ok: false, code: "backend_unavailable" };
		this.watchTerminal(created.handle, control);
		return created;
	}

	/** Host lifecycle 只取得 safe execution handles，不取得 backend locator。 */
	public activeHandles(): readonly ExecutionHandleRef[] {
		return this.backend.handles?.() ?? [];
	}

	public lifecycleProcesses(timeoutMs = RUNTIME_HOST_BOUNDS.maxWaitMs): readonly RuntimeHostLifecycleProcess[] {
		return this.activeHandles().map((handle) => this.createLifecycleProcess(handle, timeoutMs));
	}

	/**
	 * Host scheduler hook for the durable completion Queue. The terminal watcher
	 * only enqueues; this method is the sole Control Plane path that may hand a
	 * bounded batch to the Host-owned Agent bridge.
	 */
	public reconcileCompletions(maxItems = RUNTIME_HOST_BOUNDS.maxCompletionBatchMembers): Promise<CompletionSchedulerResult> {
		if (!this.completionAgent) return Promise.resolve({ ok: false, code: "agent_unavailable" });
		return this.completionReconciler.reconcile(this.completionAgent, maxItems);
	}

	/** Graceful shutdown 在关闭 Session Store 前等待所有自动 terminal 投影。 */
	public async waitForTerminalTasks(): Promise<void> {
		while (this.terminalTasks.size > 0) await Promise.all([...this.terminalTasks]);
		const failure = this.terminalFailures.shift();
		if (failure !== undefined) throw failure;
	}

	/** 把一个 Host-owned process 映射为 R10 admission/drain/seal/settle port。 */
	public createLifecycleProcess(handle: ExecutionHandleRef, timeoutMs = RUNTIME_HOST_BOUNDS.maxWaitMs): RuntimeHostLifecycleProcess {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) {
			throw new Error("lifecycle timeout is outside the bounded range");
		}
		const requireControl = (): ManagedProcessBackendControl => {
			const control = this.backend.control(handle);
			if (!control) throw new Error("managed process backend is unavailable");
			return control;
		};
		return {
			id: handle.executionId,
			drain: async () => {
				const current = this.manager.query(handle);
				if (!current.ok) throw new Error("managed process journal is unavailable");
				if (isTerminalSummary(current.summary)) return;
				const control = requireControl();
				let waited = await control.wait(timeoutMs);
				if (waited.terminal !== undefined) return;
				const requested = await this.manager.requestTermination(handle);
				if (!requested.ok && requested.code !== "terminal_state_immutable") throw new Error("process termination request failed");
				const stopped = control.stop("SIGTERM");
				if (!stopped.ok) throw new Error("process stop failed");
				waited = await control.wait(timeoutMs);
				if (waited.terminal !== undefined) return;
				const killed = control.stop("SIGKILL");
				if (!killed.ok) throw new Error("process kill escalation failed");
				waited = await control.wait(timeoutMs);
				if (waited.terminal === undefined) throw new Error("process drain deadline exceeded after SIGKILL");
			},
			checkpoint: async () => {
				const control = requireControl();
				const current = this.manager.query(handle);
				if (!current.ok) throw new Error("managed process journal is unavailable");
				if (isTerminalSummary(current.summary)) return;
				const head = await control.output.head();
				const checkpointed = await this.manager.checkpointOutput(handle, head, head.byteOffset);
				if (!checkpointed.ok && checkpointed.code !== "terminal_state_immutable") throw new Error("process output checkpoint failed");
			},
			seal: async () => {
				const control = requireControl();
				const sealed = await control.output.seal();
				if (!sealed.ok) throw new Error("process output seal failed");
			},
			settle: async () => {
				const current = this.manager.query(handle);
				if (!current.ok) throw new Error("managed process journal is unavailable");
				if (isTerminalSummary(current.summary)) return;
				const waited = await requireControl().wait(timeoutMs);
				if (waited.terminal === undefined) throw new Error("process terminal settlement is unknown");
				const settled = await this.manager.settle(handle, toSettlement(handle, waited.terminal));
				if (!settled.ok && settled.code !== "terminal_state_immutable") throw new Error("process terminal settlement failed");
			},
			materializeArtifacts: async () => {
				const control = requireControl();
				if (!(await this.materializeOutput(handle, control))) throw new Error("process Artifact materialization failed");
			},
				evidence: async () => {
				const current = this.manager.query(handle);
				if (!current.ok) throw new Error("managed process journal is unavailable");
				const control = requireControl();
				const cursor = await control.output.head();
				const sealed = await control.output.seal();
				if (!sealed.ok) throw new Error("process output seal evidence is unavailable");
				return {
					id: handle.executionId,
					outputCheckpoint: { cursor, size: cursor.byteOffset },
					outputSealDigest: sealed.seal.digest,
					...(current.summary.terminal?.evidenceRef === undefined ? {} : { settlementEvidenceRef: current.summary.terminal.evidenceRef }),
				};
			},
			};
	}

	public async processOutput(
		handle: ExecutionHandleRef,
		cursor: OutputCursor,
		maxBytes = RUNTIME_HOST_BOUNDS.maxOutputPageBytes,
	): Promise<ControlPlaneOutputResult> {
		const control = this.backend.control(handle);
		if (!control) return { ok: false, code: "backend_unavailable" };
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > RUNTIME_HOST_BOUNDS.maxOutputPageBytes) {
			return { ok: false, code: "output_cursor_invalid" };
		}
		const result = await control.output.read(cursor, maxBytes);
		if (!result.ok) return mapOutputError(result);
		const checkpointed = await this.checkpointOutputHead(handle, control);
		if (!checkpointed.ok) return checkpointed;
		return {
			ok: true,
			page: {
				handle,
				startCursor: result.page.startCursor,
				endCursor: result.page.endCursor,
				text: result.page.text,
				nextCursor: result.page.nextCursor,
				truncated: result.page.truncated,
			},
			head: result.head,
		};
	}

	public async processWait(
		handle: ExecutionHandleRef,
		timeoutMs: number,
		_actor: ControlPlaneActor,
	): Promise<ControlPlaneWaitResult> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_HOST_BOUNDS.maxWaitMs) {
			return { ok: false, code: "invalid_timeout" };
		}
		const control = this.backend.control(handle);
		if (!control) return { ok: false, code: "backend_unavailable" };
		const beforeWait = this.manager.query(handle);
		if (!beforeWait.ok) return mapManagerError(beforeWait);
		if (beforeWait.summary.terminal !== undefined) {
			return this.terminalResult(control, beforeWait.summary, "explicit_wait");
		}
		const waited = await control.wait(timeoutMs);
		const current = this.manager.query(handle);
		if (!current.ok) return mapManagerError(current);
		if (waited.outcome === "timed_out") {
			return { ok: true, outcome: "timed_out", summary: current.summary, nextCursor: await control.output.head() };
		}
		if (waited.terminal === undefined) {
			return {
				ok: true,
				outcome: waited.outcome === "uncertain" ? "uncertain" : "running",
				summary: current.summary,
				nextCursor: await control.output.head(),
			};
		}

		const checkpointed = await this.checkpointOutputHead(handle, control);
		if (!checkpointed.ok) return checkpointed;
		const settlement = toSettlement(handle, waited.terminal);
		const settled = await this.manager.settle(handle, settlement);
		if (!settled.ok) return mapManagerError(settled);
		const nextCursor = await control.output.head();
		const preview = await this.preview(control, checkpointed.summary.outputCursor);
		const terminalEvidenceRef = settlement.evidenceRef;
		const summary = settled.summary;
		await this.onProcessTerminal?.(summary);
		if (!await this.materializeOutput(handle, control)) return { ok: false, code: "artifact_materialization_failed" };
		return this.finishTerminal(summary, preview, nextCursor, terminalEvidenceRef, "explicit_wait");
	}

	public async write(handle: ExecutionHandleRef, actor: ControlPlaneActor, input: string): Promise<ControlPlaneMutationResult> {
		if (actor !== "driver") return { ok: false, code: "observer_mutation_forbidden" };
		const control = await this.authorizeMutation(handle);
		if (!control.ok) return control;
		const result = await control.control.write(input);
		return this.mutationResult(handle, "write", result);
	}

	public async eof(handle: ExecutionHandleRef, actor: ControlPlaneActor): Promise<ControlPlaneMutationResult> {
		if (actor !== "driver") return { ok: false, code: "observer_mutation_forbidden" };
		const control = await this.authorizeMutation(handle);
		if (!control.ok) return control;
		return this.mutationResult(handle, "eof", await control.control.eof());
	}

	public async resize(handle: ExecutionHandleRef, actor: ControlPlaneActor, columns: number, rows: number): Promise<ControlPlaneMutationResult> {
		if (actor !== "driver") return { ok: false, code: "observer_mutation_forbidden" };
		const control = await this.authorizeMutation(handle);
		if (!control.ok) return control;
		if (!control.control.resize) return { ok: false, code: "mutation_rejected" };
		return this.mutationResult(handle, "resize", await control.control.resize(columns, rows));
	}

	public async stop(handle: ExecutionHandleRef, actor: ControlPlaneActor, signal: NodeJS.Signals = "SIGTERM"): Promise<ControlPlaneMutationResult> {
		if (actor !== "driver") return { ok: false, code: "observer_mutation_forbidden" };
		const control = await this.authorizeMutation(handle);
		if (!control.ok) return control;
		const requested = await this.manager.requestTermination(handle);
		if (!requested.ok) return mapManagerError(requested);
		return this.mutationResult(handle, "stop", control.control.stop(signal));
	}

	private async authorizeMutation(handle: ExecutionHandleRef): Promise<
		| { readonly ok: true; readonly control: ManagedProcessBackendControl }
		| { readonly ok: false; readonly code: ControlPlaneErrorCode }
	> {
		const current = this.manager.query(handle);
		if (!current.ok) return mapManagerError(current);
		if (!current.summary.capabilities.canWrite && !current.summary.capabilities.canStop) return { ok: false, code: "terminal_state_immutable" };
		const control = this.backend.control(handle);
		return control ? { ok: true, control } : { ok: false, code: "backend_unavailable" };
	}

	private async mutationResult(
		handle: ExecutionHandleRef,
		operation: "write" | "eof" | "resize" | "stop",
		result: ManagedProcessBackendMutationResult,
	): Promise<ControlPlaneMutationResult> {
		if (!result.ok) return { ok: false, code: result.code === "backend_unavailable" ? "backend_unavailable" : "mutation_rejected" };
		const summary = this.manager.query(handle);
		if (!summary.ok) return mapManagerError(summary);
		return { ok: true, operation, receiptDigest: result.receiptDigest, summary: summary.summary };
	}

	private async preview(control: ManagedProcessBackendControl, cursor: OutputCursor): Promise<string | undefined> {
		const page = await control.output.read(cursor, Math.min(RUNTIME_HOST_BOUNDS.maxOutputPageBytes, 4 * 1024));
		return page.ok && page.page.text.length > 0 ? page.page.text : undefined;
	}

	private async terminalResult(
		control: ManagedProcessBackendControl,
		summary: ManagedProcessSummary,
		origin: ProcessCompletionEnvelope["origin"] = "explicit_wait",
	): Promise<ControlPlaneWaitResult> {
		const checkpointed = await this.checkpointOutputHead(summary.handle, control);
		if (!checkpointed.ok) return checkpointed;
		summary = checkpointed.summary;
		const nextCursor = await control.output.head();
		const preview = await this.preview(control, summary.outputCursor);
		if (!await this.materializeOutput(summary.handle, control)) return { ok: false, code: "artifact_materialization_failed" };
		return this.finishTerminal(summary, preview, nextCursor, summary.terminal?.evidenceRef, origin);
	}

	private async finishTerminal(
		summary: ManagedProcessSummary,
		preview: string | undefined,
		nextCursor: OutputCursor,
		terminalEvidenceRef: RuntimeContentRef | undefined,
		origin: ProcessCompletionEnvelope["origin"],
	): Promise<ControlPlaneWaitResult> {
		const delivery = await this.reconcileCompletion(summary, preview, nextCursor, origin);
		if (!delivery) return { ok: false, code: "queue_unavailable" };
		return {
			ok: true,
			outcome: "terminal",
			summary,
			...(preview === undefined ? {} : { preview }),
			nextCursor,
			...(terminalEvidenceRef === undefined ? {} : { terminalEvidenceRef }),
		};
	}

	private async reconcileCompletion(
		summary: ManagedProcessSummary,
		preview: string | undefined,
		nextCursor: OutputCursor,
		origin: ProcessCompletionEnvelope["origin"],
	): Promise<boolean> {
		const envelope: ProcessCompletionEnvelope = {
			deliveryKey: completionDeliveryKey(summary.handle, summary.handle.revision, this.policyDigest),
			origin,
			handle: summary.handle,
			terminalSequence: summary.handle.revision,
			summary,
			...(preview === undefined ? {} : { preview }),
			nextCursor,
			policyDigest: this.policyDigest,
			budgetDigest: this.budgetDigest,
		};
		if (origin === "automatic_follow_up") {
			const queued = await this.completionReconciler.enqueueAutomatic(envelope);
			if (queued.ok) this.onAutomaticCompletion?.(envelope);
			return queued.ok;
		}
		return (await this.completionReconciler.commitExplicit(envelope)).ok;
	}

	private watchTerminal(handle: ExecutionHandleRef, control: ManagedProcessBackendControl): void {
		if (!control.onTerminal || this.terminalWatchers.has(handle.executionId)) return;
		const unsubscribe = control.onTerminal((terminal) => {
			const task = this.handleWatchedTerminal(handle, terminal).catch((error: unknown) => {
				this.terminalFailures.push(error instanceof Error ? error : new Error(String(error)));
			}).finally(() => {
				this.terminalTasks.delete(task);
			});
			this.terminalTasks.add(task);
		});
		this.terminalWatchers.set(handle.executionId, unsubscribe);
	}

	private async handleWatchedTerminal(handle: ExecutionHandleRef, terminal: ManagedProcessBackendWaitTerminal): Promise<void> {
		const control = this.backend.control(handle);
		if (!control) return;
		const checkpointed = await this.checkpointOutputHead(handle, control);
		if (!checkpointed.ok) return;
		const settled = await this.manager.settle(handle, toSettlement(handle, terminal));
		if (!settled.ok) return;
		await this.onProcessTerminal?.(settled.summary);
		const nextCursor = await control.output.head();
		const preview = await this.preview(control, settled.summary.outputCursor);
		if (!await this.materializeOutput(handle, control)) return;
		await this.reconcileCompletion(settled.summary, preview, nextCursor, "automatic_follow_up");
	}

	private async checkpointOutputHead(
		handle: ExecutionHandleRef,
		control: ManagedProcessBackendControl,
	): Promise<
		| { readonly ok: true; readonly summary: ManagedProcessSummary }
		| { readonly ok: false; readonly code: ControlPlaneErrorCode }
	> {
		let head: OutputCursor;
		try {
			head = await control.output.head();
		} catch {
			return { ok: false, code: "output_unavailable" };
		}
		const current = this.manager.query(handle);
		if (!current.ok) return mapManagerError(current);
		if (current.summary.state === "completed" || current.summary.state === "failed" || current.summary.state === "timed_out" || current.summary.state === "killed" || current.summary.state === "lost" || current.summary.state === "uncertain") {
			return { ok: true, summary: current.summary };
		}
		if (sameCursor(current.summary.outputCursor, head) && current.summary.outputSize === head.byteOffset) {
			return { ok: true, summary: current.summary };
		}
		const checkpointed = await this.manager.checkpointOutput(handle, head, head.byteOffset);
		if (!checkpointed.ok) return mapManagerError(checkpointed);
		return { ok: true, summary: checkpointed.summary };
	}

	private async materializeOutput(handle: ExecutionHandleRef, control: ManagedProcessBackendControl): Promise<boolean> {
		if (!this.outputMaterializer || typeof control.output.readAll !== "function") return true;
		return this.materializeOutputStore(handle, control.output);
	}

	/** Recovery path may have durable output but no reattached live backend. */
	public async materializeRecoveredOutput(handle: ExecutionHandleRef, output: ManagedProcessBackendControl["output"]): Promise<boolean> {
		if (!this.outputMaterializer || typeof output.readAll !== "function") return true;
		return this.materializeOutputStore(handle, output);
	}

	private async materializeOutputStore(handle: ExecutionHandleRef, output: ManagedProcessBackendControl["output"]): Promise<boolean> {
		const prior = this.materializations.get(handle.executionId);
		if (prior !== undefined) {
			return (await prior).ok;
		}
		const task = this.outputMaterializer!.materialize({
			readAll: () => output.readAll!(),
			...(output.readMaterialization === undefined ? {} : { readMaterialization: () => output.readMaterialization!() }),
			...(output.recordMaterialization === undefined ? {} : { recordMaterialization: (record) => output.recordMaterialization!(record) }),
			}).then(async (result) => {
				if (!result.ok) {
					this.materializations.delete(handle.executionId);
					return result;
				}
				try {
					await this.onOutputMaterialized?.({ handle, record: result.record });
				} catch (error) {
					if (this.recordingFailurePolicy === "fail_closed") {
						this.materializations.delete(handle.executionId);
						return { ok: false as const, code: "artifact_materialization_failed" as const };
					}
					void error;
					// best_effort 记录失败不能回滚 durable process truth。
				}
			return result;
		}).catch(() => {
			this.materializations.delete(handle.executionId);
			return { ok: false as const, code: "output_read_failed" as const };
		});
		this.materializations.set(handle.executionId, task);
		return (await task).ok;
	}
}

function sameCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

function isTerminalSummary(summary: ManagedProcessSummary): boolean {
	return summary.state === "completed" || summary.state === "failed" || summary.state === "timed_out" || summary.state === "killed" || summary.state === "lost" || summary.state === "uncertain";
}

function toSettlement(handle: ExecutionHandleRef, terminal: ManagedProcessBackendWaitTerminal): TerminalSettlement {
	const evidenceRef: RuntimeContentRef = {
		subjectKind: "receipt",
		digest: runtimeDigest({ handle, terminal }),
		mediaType: "application/json",
		size: 0,
	};
	return {
		state: terminal.outcome,
		...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
		...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
		evidenceRef,
	};
}

function completionDeliveryKey(handle: ExecutionHandleRef, terminalSequence: number, policyDigest: RuntimeDigest): string {
	return `completion-${runtimeDigest({ executionId: handle.executionId, attemptId: handle.attemptId, terminalSequence, policyDigest }).digest}`;
}

function mapOutputError(result: Exclude<ProcessOutputReadResult, { readonly ok: true }>): ControlPlaneOutputResult {
	return {
		ok: false,
		code: result.code === "output_cursor_resync_required"
			? "output_cursor_resync_required"
			: result.code === "output_cursor_invalid"
				? "output_cursor_invalid"
				: "output_unavailable",
		...(result.earliestCursor === undefined ? {} : { earliestCursor: result.earliestCursor }),
	};
}

function mapManagerError(result: { readonly ok: false; readonly code: string }): { readonly ok: false; readonly code: ControlPlaneErrorCode } {
	switch (result.code) {
		case "backend_mutation_unavailable":
			return { ok: false, code: "mutation_rejected" };
		case "journal_unavailable":
			return { ok: false, code: "journal_unavailable" };
		case "terminal_state_immutable":
			return { ok: false, code: "terminal_state_immutable" };
		case "process_not_found":
			return { ok: false, code: "process_not_found" };
		case "journal_invalid":
			return { ok: false, code: "journal_invalid" };
		default:
			return { ok: false, code: "uncertain_outcome" };
	}
}
