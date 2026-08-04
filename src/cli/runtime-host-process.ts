/** Production Host-owned managed process composition. */

import { isAbsolute } from "node:path";
import { defaultShell } from "../utils/shell.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../runtime/host/types.ts";
import { RUNTIME_HOST_BOUNDS } from "../runtime/host/types.ts";
import { createRuntimeId, type CommandId, type ExecutionId } from "../runtime/protocol/ids.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import type { ManagedProcessRequest, ExecutionHandleRef, ManagedProcessSummary } from "../runtime/process/types.ts";
import { clipUtf8Output, type OutputCursor } from "../runtime/process/output.ts";
import {
	createProductionExecutionDecisionProviders,
	type ExecutionConstraintInput,
} from "../runtime/process/execution-decision.ts";
import { ProcessManager, AuditedProcessManager, type BackendLaunchPlan, type BackendSpawnInput, type BackendSpawnPort, type BackendSpawnReceipt } from "../runtime/process/manager.ts";
import { FileArtifactStore } from "../runtime/trace/artifact-store.ts";
import { ManagedProcessOutputMaterializer } from "../runtime/process/output-artifact.ts";
import type { ProcessOutputArtifactStore, ProcessOutputMaterializationRecord } from "../runtime/process/output-artifact.ts";
import { JsonlProcessJournal, type ProcessCommandMutationOperation } from "../storage/process/recovery-store.ts";
import { FileProcessOutputStore } from "../storage/process/output-store.ts";
import type { OutputRetentionPlan } from "../storage/process/output-store.ts";
import { PipeProcessBackend } from "../storage/process/process-backend.ts";
import { PtyProcessBackend } from "../storage/process/pty-backend.ts";
import { createPosixNodePtyAdapter } from "../storage/process/node-pty-adapter.ts";
import { JsonlProcessCompletionQueue } from "../storage/process/completion-queue.ts";
import { CompletionReconciler, DurableAgentCompletionBridge, type CompletionAgentHostPort } from "../runtime/process/completion-reconciler.ts";
import type { RuntimeHostLifecycleProcess, RuntimeHostRecoveredProcess } from "../runtime/host/lifecycle.ts";
import type { TraceRecorderFactory } from "../runtime/trace/composition.ts";
import type { RuntimeTraceRecorder } from "../runtime/trace/recorder.ts";
import type { ShellResult } from "../runtime/execution-env.ts";
import type { ManagedForegroundBashInput, ManagedForegroundBashOperations } from "../runtime/tools/bash.ts";
import {
	ManagedProcessControlPlane,
	type ControlPlaneCreateResult,
	type ManagedProcessBackendControl,
	type ManagedProcessControlPlaneOptions,
} from "../storage/process/control-plane.ts";
import type { HostProcessCreateInput, HostProcessPort } from "./runtime-host-service.ts";
import type { ProcessToolClient } from "../runtime/tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../runtime/tools/bash.ts";
import type { ControlPlaneActor, ControlPlaneOutputResult, ControlPlaneWaitResult, ControlPlaneMutationResult } from "../storage/process/control-plane.ts";
import type { RecordingFailurePolicy } from "../storage/settings-manager.ts";
import type { ProductionHostSecurity, HostProcessSecurityRequest } from "./runtime-host-security.ts";
import type { SandboxLaunchPlan } from "../security/sandbox/types.ts";

export interface ProductionManagedProcessOptions {
	readonly layout: RunledgerLayout;
	readonly scope: RuntimeHostScope;
	readonly hostGeneration: number;
	readonly recordingMode?: "off" | "events" | "events_and_artifacts";
	readonly recordingFailurePolicy?: RecordingFailurePolicy;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly artifactStore?: ProcessOutputArtifactStore;
	/** Resident Host's sole Security/ExecutionGateway owner. */
	readonly security?: ProductionHostSecurity;
	/** Only low-level unit tests may opt into the unrestricted backend seam. */
	readonly allowTestOnlyUnrestrictedExecution?: boolean;
}

interface CommandDescriptor {
	readonly command: string;
	readonly cwd: string;
}

type ProductionProcessCreateResult = ControlPlaneCreateResult | {
	readonly ok: false;
	readonly code: "cwd_invalid" | "execution_constraint_denied" | "execution_constraint_unavailable" | "execution_constraint_invalid";
};

interface BackendWithControl extends BackendSpawnPort {
	control(handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined;
	handles(): readonly ExecutionHandleRef[];
}

/**
 * One durable manager owns both pipe and PTY backends. The private command map
 * is only a live resolver cache; after restart an old attempt is recovered as
 * uncertain instead of being guessed or respawned.
 */
export class ProductionManagedProcessPort implements HostProcessPort {
	private readonly options: ProductionManagedProcessOptions;
	private readonly journal: JsonlProcessJournal;
	private readonly commands = new Map<string, CommandDescriptor>();
	private readonly pipe: PipeProcessBackend;
	private readonly pty: PtyProcessBackend | undefined;
	private readonly backend: BackendWithControl;
	private readonly manager: ProcessManager;
	private readonly auditedManager: AuditedProcessManager;
	private readonly plane: ManagedProcessControlPlane;
	private readonly completionQueue: JsonlProcessCompletionQueue;
	private readonly completionAgents = new Map<string, CompletionAgentRegistration>();
	private readonly processTraceRecorders = new Map<string, Promise<RuntimeTraceRecorder | undefined>>();

	public constructor(options: ProductionManagedProcessOptions) {
		this.options = options;
		this.journal = new JsonlProcessJournal({
			layout: options.layout,
			workspaceStorageKey: options.scope.workspaceStorageKey,
		});
		const output = (input: { readonly handle: ExecutionHandleRef; readonly request: ManagedProcessRequest }): FileProcessOutputStore => new FileProcessOutputStore({
			layout: options.layout,
			workspaceStorageKey: options.scope.workspaceStorageKey,
			executionId: input.handle.executionId,
			attemptId: input.handle.attemptId,
		});
		this.pipe = new PipeProcessBackend({
			resolveCommand: (request) => this.resolveCommand(request),
			createOutputStore: output,
		});
		this.pty = process.platform === "win32" ? undefined : new PtyProcessBackend({
			adapter: createPosixNodePtyAdapter(),
			resolveCommand: (request) => this.resolveCommand(request),
			createOutputStore: output,
		});
		this.backend = new CompositeProcessBackend(this.pipe.asManagerBackend(), this.pty?.asManagerBackend());
		this.manager = new ProcessManager(this.journal, this.backend);
		this.auditedManager = new AuditedProcessManager(
			this.manager,
			createProductionExecutionDecisionProviders(process.platform === "win32" ? "win32" : "posix"),
		);
		const queue = new JsonlProcessCompletionQueue({
			layout: options.layout,
			workspaceStorageKey: options.scope.workspaceStorageKey,
		});
		this.completionQueue = queue;
		const mode = options.recordingMode ?? "off";
		const artifactStore = mode === "events_and_artifacts"
			? options.artifactStore ?? new FileArtifactStore({ dataRoot: options.layout.artifacts, metadataRoot: options.layout.artifactMetadata })
			: undefined;
		this.plane = new ManagedProcessControlPlane({
			manager: this.manager,
			auditedManager: this.auditedManager,
			backend: this.backend,
			completionQueue: queue,
			policyDigest: runtimeDigest({ source: "runledger-production", mode }),
			budgetDigest: runtimeDigest(RUNTIME_HOST_BOUNDS),
			recordingFailurePolicy: options.recordingFailurePolicy,
			outputMaterializer: new ManagedProcessOutputMaterializer({
				mode,
				...(artifactStore === undefined ? {} : { artifactStore }),
			}),
				...(mode === "off" ? {} : {
					onOutputMaterialized: (input: Parameters<NonNullable<ManagedProcessControlPlaneOptions["onOutputMaterialized"]>>[0]) => this.recordOutputMaterialization(input.handle, input.record),
				}),
			onAutomaticCompletion: (envelope) => this.scheduleCompletion(envelope.handle.sessionId),
		});
	}

	public attachCompletionAgent(
		sessionId: string,
		agent: CompletionAgentHostPort,
		onIdle?: (listener: () => void) => () => void,
	): () => void {
		this.completionAgents.get(sessionId)?.remove();
		const registration: CompletionAgentRegistration = {
			bridge: new DurableAgentCompletionBridge(agent),
			reconciler: new CompletionReconciler(this.completionQueue, { sessionId }),
			scheduled: false,
			removeIdle: () => {},
			remove: () => {},
		};
		this.completionAgents.set(sessionId, registration);
		registration.removeIdle = onIdle?.(() => this.scheduleCompletion(sessionId)) ?? (() => {});
		registration.remove = () => {
			registration.removeIdle();
			if (this.completionAgents.get(sessionId) === registration) this.completionAgents.delete(sessionId);
		};
		this.scheduleCompletion(sessionId);
		return registration.remove;
	}

	public async reconcileCompletions(sessionId: string): Promise<void> {
		const registration = this.completionAgents.get(sessionId);
		if (!registration) return;
		await registration.reconciler.reconcile(registration.bridge).catch(() => undefined);
	}

	public lifecycleProcesses(): readonly RuntimeHostLifecycleProcess[] {
		return this.plane.lifecycleProcesses();
	}

	public async create(input: HostProcessCreateInput & { readonly commandId?: string }): Promise<ProductionProcessCreateResult> {
		if (this.options.security === undefined && this.options.allowTestOnlyUnrestrictedExecution !== true) {
			return { ok: false, code: "execution_constraint_unavailable" };
		}
		if (!isAbsolute(input.cwd)) return { ok: false, code: "cwd_invalid" };
		const commandId = input.commandId ?? createRuntimeId("command");
		const stdinDigest = input.stdin === undefined ? undefined : runtimeDigest(input.stdin);
		const containment = input.containment ?? "none";
		if (input.backend === "pty" && containment !== "none") return { ok: false, code: "execution_constraint_unavailable" };
		if (process.platform === "win32" && containment !== "none") return { ok: false, code: "execution_constraint_unavailable" };
		const commandDigest = runtimeDigest({
			command: input.command,
			cwd: input.cwd,
			timeoutMs: input.timeoutMs,
			backend: input.backend,
			executionMode: input.executionMode,
			containment,
			stdin: stdinDigest === undefined ? null : { digest: stdinDigest, size: Buffer.byteLength(input.stdin ?? "", "utf8") },
		});
		const correlationId = createRuntimeId("command", commandId.length <= 128 ? commandId : runtimeDigest(commandId).digest.slice(0, 64));
		const securityRequest: HostProcessSecurityRequest = {
			sessionId: input.sessionId,
			principalId: input.principalId,
			commandId: correlationId,
			command: input.command,
			cwd: input.cwd,
			timeoutMs: input.timeoutMs,
			backend: input.backend,
			executionMode: input.executionMode,
			containment,
			requestDigest: commandDigest,
			...(input.stdin === undefined ? {} : { stdin: input.stdin }),
		};
		const prepared = this.options.security === undefined
			? undefined
			: await this.options.security.prepareProcess(securityRequest);
		if (prepared && !prepared.ok) return mapSecurityCreateFailure(prepared.error.code);
		const managedRequestDigest = prepared?.value.constraintInput.requestDigest ?? commandDigest;
		this.commands.set(correlationId, { command: input.command, cwd: input.cwd });
		const request: ManagedProcessRequest = {
			authorityId: this.options.scope.authorityId,
			tenantId: this.options.scope.tenantId,
			workspaceId: this.options.scope.workspaceId,
			sessionId: input.sessionId as ManagedProcessRequest["sessionId"],
			hostGeneration: this.options.hostGeneration,
			sessionGeneration: input.sessionGeneration,
			requestDigest: managedRequestDigest,
			commandRef: { subjectKind: "content", digest: runtimeDigest(input.command), mediaType: "text/plain", size: Buffer.byteLength(input.command, "utf8") },
			cwdRef: { subjectKind: "content", digest: runtimeDigest(input.cwd), mediaType: "text/plain", size: Buffer.byteLength(input.cwd, "utf8") },
			backend: input.backend,
			executionMode: input.executionMode,
			timeoutMs: input.timeoutMs,
			correlationId,
		};
		const decisionInput: ExecutionConstraintInput = prepared?.value.constraintInput ?? {
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			principalId: createRuntimeId("principal", input.principalId.length <= 128 ? input.principalId : runtimeDigest(input.principalId).digest.slice(0, 64)),
			executionId: createRuntimeId("execution", commandDigest.digest.slice(0, 64)),
			attemptId: createRuntimeId("attempt", `${commandDigest.digest.slice(0, 32)}_1`),
			commandId: correlationId,
			requestDigest: commandDigest,
			policyDigest: runtimeDigest({ source: "runledger-production", mode: this.options.recordingMode ?? "off" }),
			modes: { permission: "none", approval: "none", sandbox: "none", gateway: "none", containment },
		};
		const spawnOptions = prepared?.value === undefined || this.options.security === undefined
			? undefined
			: {
				constraintSnapshot: prepared.value.constraintSnapshot,
				launchPlan: prepared.value.sandboxPlan === undefined ? undefined : toBackendLaunchPlan(prepared.value.sandboxPlan),
				beforeSpawn: async () => {
					const finalLeaf = await this.options.security!.validateProcessFinalLeaf(prepared.value);
					if (!finalLeaf.ok) throw new Error(`${finalLeaf.error.code}: ${finalLeaf.error.message}`);
				},
			};
		const result = await this.plane.create(request, decisionInput, spawnOptions);
		if (!result.ok) return result;
		if (input.stdin !== undefined) {
			if (input.stdin.length > 0) {
				const writeError = await this.applyInitialMutation(
					correlationId,
					"write",
					stdinDigest ?? runtimeDigest(input.stdin),
					Buffer.byteLength(input.stdin, "utf8"),
					() => this.plane.write(result.handle, "driver", input.stdin ?? ""),
				);
				if (writeError !== undefined) return { ok: false, code: writeError };
			}
			const eofError = await this.applyInitialMutation(
				correlationId,
				"eof",
				runtimeDigest({ operation: "eof" }),
				0,
				() => this.plane.eof(result.handle, "driver"),
			);
			if (eofError !== undefined) return { ok: false, code: eofError };
		}
		return { ok: true, handle: result.handle, summary: result.summary };
	}

	public toolClient(sessionId: string, sessionGeneration: number, principalId: string): ProcessToolClient & ManagedForegroundBashOperations & {
		start: ManagedBackgroundBashOperations["start"];
	} {
		return {
			start: (input) => this.create({
				sessionId,
				sessionGeneration,
				principalId,
				command: input.command,
				cwd: input.cwd,
				timeoutMs: input.timeoutMs,
				...(input.stdin === undefined ? {} : { stdin: input.stdin }),
				backend: "pipe",
				executionMode: "background",
				commandId: createRuntimeId("command", runtimeDigest({ sessionId, command: input.command, cwd: input.cwd, now: Date.now() }).digest.slice(0, 64)),
			}),
			processOutput: (handle, cursor, maxBytes) => this.processOutputHandle(handle, cursor, maxBytes),
			processWait: (handle, timeoutMs, actor) => this.processWaitHandle(handle, timeoutMs, actor),
			exec: (input) => this.executeForeground({ sessionId, sessionGeneration, principalId, ...input }),
			write: (handle, actor, input) => this.plane.write(handle, actor, input),
			stop: (handle, actor, signal) => this.plane.stop(handle, actor, signal),
			resize: (handle, actor, columns, rows) => this.plane.resize(handle, actor, columns, rows),
		};
	}

	private async executeForeground(input: ManagedForegroundBashInput & {
		readonly sessionId: string;
		readonly sessionGeneration: number;
		readonly principalId: string;
	}): Promise<ShellResult> {
		const created = await this.create({
			sessionId: input.sessionId,
			sessionGeneration: input.sessionGeneration,
			principalId: input.principalId,
			command: input.command,
			cwd: input.cwd,
			timeoutMs: input.timeoutMs,
			// The foreground contract owns stdin. An omitted stdin still closes the
			// managed pipe, so commands cannot remain blocked on an implicit EOF.
			stdin: input.stdin ?? "",
			backend: "pipe",
			executionMode: "foreground",
			commandId: createRuntimeId("command", runtimeDigest({
				sessionId: input.sessionId,
				sessionGeneration: input.sessionGeneration,
				principalId: input.principalId,
				command: input.command,
				cwd: input.cwd,
				timeoutMs: input.timeoutMs,
				now: Date.now(),
			}).digest.slice(0, 64)),
		});
		if (!created.ok) throw new Error(`foreground process rejected: ${created.code}`);

		const maxOutputBytes = input.maxOutputChars ?? 1_000_000;
		if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new Error("foreground output limit is invalid");
		let cursor: OutputCursor = { sequence: 0, byteOffset: 0 };
		let stdout = "";
		let capturedBytes = 0;
		let stopRequested = false;
		let stopDeadline = Number.POSITIVE_INFINITY;
		let terminal: ControlPlaneWaitResult | undefined;

		const requestStop = async (): Promise<void> => {
			if (stopRequested) return;
			stopRequested = true;
			stopDeadline = Date.now() + RUNTIME_HOST_BOUNDS.maxWaitMs;
			const stopped = await this.plane.stop(created.handle, "driver", "SIGTERM");
			if (!stopped.ok && stopped.code !== "terminal_state_immutable") throw new Error(`foreground process stop failed: ${stopped.code}`);
		};
		const flushOutput = async (): Promise<void> => {
			while (capturedBytes < maxOutputBytes) {
				const previousCursor = cursor;
				const result = await this.processOutputHandle(created.handle, cursor, RUNTIME_HOST_BOUNDS.maxOutputPageBytes);
				if (!result.ok) throw new Error(`foreground process output failed: ${result.code}`);
				cursor = result.page.nextCursor;
				if (result.page.text.length > 0) {
					const clipped = clipUtf8Output(result.page.text, maxOutputBytes - capturedBytes);
					if (clipped.text.length > 0) {
						stdout += clipped.text;
						capturedBytes += clipped.byteLength;
						input.onStdout?.(clipped.text);
					}
				}
				if (!result.page.truncated || sameOutputCursor(result.page.nextCursor, previousCursor)) return;
			}
		};

		let abortListener: (() => void) | undefined;
		let abortSignal: Promise<"aborted"> | undefined;
		if (input.signal) {
			abortSignal = new Promise<"aborted">((resolve) => {
				abortListener = () => resolve("aborted");
				input.signal?.addEventListener("abort", abortListener, { once: true });
			});
		}
		try {
			const deadline = Date.now() + input.timeoutMs;
			while (terminal === undefined) {
				await flushOutput();
				if (input.signal?.aborted) await requestStop();
				if (!stopRequested && Date.now() >= deadline) await requestStop();
				const waitMs = stopRequested
					? Math.min(RUNTIME_HOST_BOUNDS.maxWaitMs, Math.max(1, stopDeadline - Date.now()))
					: Math.min(RUNTIME_HOST_BOUNDS.maxWaitMs, Math.max(1, deadline - Date.now()));
				const waitPromise = this.processWaitHandle(created.handle, waitMs, "driver");
				const waited = abortSignal === undefined || stopRequested
					? await waitPromise
					: await Promise.race([
							waitPromise,
							abortSignal.then(async () => {
								await requestStop();
								return waitPromise;
							}),
						]);
				const resolved = waited instanceof Promise ? await waited : waited;
				if (!resolved.ok) throw new Error(`foreground process wait failed: ${resolved.code}`);
				if (resolved.outcome === "terminal") {
					terminal = resolved;
					continue;
				}
				if (resolved.outcome === "uncertain") {
					terminal = resolved;
					continue;
				}
				if (stopRequested && Date.now() >= stopDeadline) throw new Error("foreground process termination is uncertain");
			}
			await flushOutput();
			if (terminal === undefined || !terminal.ok) throw new Error("foreground process did not settle");
			const evidence = terminal.summary.terminal;
			return {
				stdout,
				stderr: "",
				exitCode: evidence?.exitCode ?? (terminal.summary.state === "completed" ? 0 : 1),
				...(evidence?.signal === undefined ? {} : { signaled: true }),
			};
		} finally {
			if (input.signal && abortListener) input.signal.removeEventListener("abort", abortListener);
		}
	}

	public async list(sessionId: string): Promise<readonly Record<string, unknown>[]> {
		return this.manager.handles().filter((handle) => handle.sessionId === sessionId).flatMap((handle) => {
			const result = this.manager.query(handle);
			if (!result.ok) return [];
			return [safeSummary(result.summary)];
		});
	}

	public async output(sessionId: string, executionId: string, cursor: OutputCursor, maxBytes: number): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		if (!handle) return { ok: false, code: "process_not_found" };
		const control = this.backend.control(handle);
		if (control) {
			const result = await this.plane.processOutput(handle, cursor, maxBytes);
			if (!result.ok) return result;
			return { page: result.page.text, startCursor: result.page.startCursor, endCursor: result.page.endCursor, nextCursor: result.page.nextCursor, truncated: result.page.truncated, head: result.head };
		}
		const recovered = await this.createOutputStore(handle).read(cursor, maxBytes);
		if (!recovered.ok) return { ok: false, code: recovered.code };
		return { page: recovered.page.text, startCursor: recovered.page.startCursor, endCursor: recovered.page.endCursor, nextCursor: recovered.page.nextCursor, truncated: recovered.page.truncated, head: recovered.head };
	}

	public async planRetention(sessionId: string, executionId: string, cursor: OutputCursor): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		if (!handle) return { ok: false, code: "process_not_found" };
		return await this.createOutputStore(handle).planRetention(cursor);
	}

	public async commitRetention(sessionId: string, executionId: string, plan: unknown): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		if (!handle) return { ok: false, code: "process_not_found" };
		if (!isOutputRetentionPlan(plan)) return { ok: false, code: "output_retention_conflict" };
		return await this.createOutputStore(handle).commitRetention(plan);
	}

	public async pinOutput(sessionId: string, executionId: string, pinId: string, cursor: OutputCursor): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		if (!handle) return { ok: false, code: "process_not_found" };
		return await this.createOutputStore(handle).pin(pinId, cursor);
	}

	public async unpinOutput(sessionId: string, executionId: string, pinId: string): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		if (!handle) return { ok: false, code: "process_not_found" };
		return await this.createOutputStore(handle).unpin(pinId);
	}

	public async wait(sessionId: string, executionId: string, timeoutMs: number, actor: ControlPlaneActor): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		return handle ? this.processWaitHandle(handle, timeoutMs, actor) : { ok: false, code: "process_not_found" };
	}

	public async write(sessionId: string, executionId: string, actor: "driver" | "observer", input: string): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		return handle ? this.plane.write(handle, actor, input) : { ok: false, code: "process_not_found" };
	}

	public async eof(sessionId: string, executionId: string, actor: "driver" | "observer"): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		return handle ? this.plane.eof(handle, actor) : { ok: false, code: "process_not_found" };
	}

	public async resize(sessionId: string, executionId: string, actor: "driver" | "observer", columns: number, rows: number): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		return handle ? this.plane.resize(handle, actor, columns, rows) : { ok: false, code: "process_not_found" };
	}

	public async stop(sessionId: string, executionId: string, actor: "driver" | "observer", signal?: NodeJS.Signals): Promise<Record<string, unknown>> {
		const handle = this.findHandle(sessionId, executionId);
		return handle ? this.plane.stop(handle, actor, signal) : { ok: false, code: "process_not_found" };
	}

	public findHandle(sessionId: string, executionId: string): ExecutionHandleRef | undefined {
		return this.manager.handles().find((handle) => handle.sessionId === sessionId && handle.executionId === executionId);
	}

	public async recoverUnattached(): Promise<readonly RuntimeHostRecoveredProcess[]> {
		const results = await this.manager.recoverUnattached();
		const recovered: RuntimeHostRecoveredProcess[] = [];
		for (const result of results) {
			if (!result.ok) throw new Error("managed process recovery is unavailable");
			const materialized = await this.plane.materializeRecoveredOutput(result.handle, this.createOutputStore(result.handle));
				if (!materialized && (this.options.recordingFailurePolicy ?? "best_effort") === "fail_closed") {
					throw new Error("managed process Artifact materialization failed during recovery");
				}
				if (result.summary.state === "lost" || result.summary.state === "uncertain") {
					const output = this.createOutputStore(result.handle);
					const cursor = await output.head();
					const sealed = await output.seal();
					recovered.push({
						id: result.handle.executionId,
						state: result.summary.state,
						evidence: {
							id: result.handle.executionId,
							outputCheckpoint: { cursor, size: cursor.byteOffset },
							...(sealed.ok ? { outputSealDigest: sealed.seal.digest } : {}),
						...(result.summary.terminal?.evidenceRef === undefined ? {} : { settlementEvidenceRef: result.summary.terminal.evidenceRef }),
						},
					});
				}
		}
		return recovered;
	}

	private async processOutputHandle(
		handle: ExecutionHandleRef,
		cursor: { readonly sequence: number; readonly byteOffset: number },
		maxBytes: number,
	): Promise<ControlPlaneOutputResult> {
		const control = this.backend.control(handle);
		if (control) return this.plane.processOutput(handle, cursor, maxBytes);
		const result = await this.createOutputStore(handle).read(cursor, maxBytes);
		if (!result.ok) {
			return {
				ok: false,
				code: result.code === "output_cursor_resync_required" ? "output_cursor_resync_required" : "output_unavailable",
				...(result.earliestCursor === undefined ? {} : { earliestCursor: result.earliestCursor }),
			};
		}
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

	private async processWaitHandle(handle: ExecutionHandleRef, timeoutMs: number, actor: ControlPlaneActor): Promise<ControlPlaneWaitResult> {
		const control = this.backend.control(handle);
		if (control) return this.plane.processWait(handle, timeoutMs, actor);
		const current = this.manager.query(handle);
		if (!current.ok) return { ok: false, code: current.code === "process_not_found" ? "process_not_found" : "journal_invalid" };
		const nextCursor = await this.createOutputStore(handle).head();
		if (current.summary.terminal) return { ok: true, outcome: "terminal", summary: current.summary, nextCursor, terminalEvidenceRef: current.summary.terminal.evidenceRef };
		return { ok: true, outcome: "uncertain", summary: current.summary, nextCursor };
	}

	private resolveCommand(request: ManagedProcessRequest): { readonly executable: string; readonly args: readonly string[]; readonly cwd: string } {
		const descriptor = this.commands.get(request.correlationId);
		if (!descriptor) throw new Error("process command resolver unavailable after restart");
		return { executable: defaultShell(), args: ["-lc", descriptor.command], cwd: descriptor.cwd };
	}

	private async applyInitialMutation(
		commandId: CommandId,
		operation: ProcessCommandMutationOperation,
		payloadDigest: ReturnType<typeof runtimeDigest>,
		payloadSize: number,
		apply: () => Promise<ControlPlaneMutationResult>,
	): Promise<string | undefined> {
		const prior = this.journal.commandMutation(commandId, operation);
		if (prior !== undefined) {
			if (prior.payloadDigest.digest !== payloadDigest.digest || prior.payloadSize !== payloadSize) return "command_id_conflict";
			if (prior.receiptDigest !== undefined) return undefined;
			return "uncertain_outcome";
		}
		try {
			this.journal.recordCommandMutationIntent(commandId, operation, payloadDigest, payloadSize);
		} catch {
			return "journal_unavailable";
		}
		const result = await apply();
		if (!result.ok) return result.code;
		try {
			this.journal.recordCommandMutationReceipt(commandId, operation, result.receiptDigest);
		} catch {
			return "uncertain_outcome";
		}
		return undefined;
	}

	private createOutputStore(handle: ExecutionHandleRef): FileProcessOutputStore {
		return new FileProcessOutputStore({
			layout: this.options.layout,
			workspaceStorageKey: this.options.scope.workspaceStorageKey,
			executionId: handle.executionId,
			attemptId: handle.attemptId,
		});
	}

	private scheduleCompletion(sessionId: string): void {
		const registration = this.completionAgents.get(sessionId);
		if (!registration || registration.scheduled) return;
		registration.scheduled = true;
		queueMicrotask(() => {
			registration.scheduled = false;
			void this.reconcileCompletions(sessionId);
		});
	}

	private async recordOutputMaterialization(
		handle: ExecutionHandleRef,
		record: ProcessOutputMaterializationRecord,
	): Promise<void> {
		const content = record.materialization.traceContent;
		const factory = this.options.traceRecorderFactory;
		if (record.mode === "off" || content === undefined) return;
		if (factory === undefined) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("trace recorder is unavailable");
			return;
		}
		const key = `${handle.executionId}:${handle.attemptId}`;
		let recorderPromise = this.processTraceRecorders.get(key);
		if (recorderPromise === undefined) {
			const traceId = createRuntimeId("trace", runtimeDigest({
				workspaceStorageKey: this.options.scope.workspaceStorageKey,
				sessionId: handle.sessionId,
				executionId: handle.executionId,
				attemptId: handle.attemptId,
			}).digest.slice(0, 64));
			recorderPromise = factory.create({ sessionId: handle.sessionId, traceId }).catch((error: unknown) => {
				if (this.options.recordingFailurePolicy === "fail_closed") throw error;
				return undefined;
			});
			this.processTraceRecorders.set(key, recorderPromise);
		}
		const recorder = await recorderPromise;
		if (!recorder) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("trace recorder is unavailable");
			return;
		}
		await recorder.recordManagedProcessOutput({
				executionId: handle.executionId,
				attemptId: handle.attemptId,
			mode: record.mode,
			sourceDigest: record.sourceDigest,
			recordDigest: record.recordDigest,
			outputContent: content,
		});
	}
}

interface CompletionAgentRegistration {
	readonly bridge: DurableAgentCompletionBridge;
	readonly reconciler: CompletionReconciler;
	scheduled: boolean;
	removeIdle(): void;
	remove(): void;
}

class CompositeProcessBackend implements BackendWithControl {
	private readonly pipe: BackendWithControl;
	private readonly pty: BackendWithControl | undefined;

	public constructor(pipe: BackendWithControl, pty: BackendWithControl | undefined) {
		this.pipe = pipe;
		this.pty = pty;
	}

	public async spawn(input: BackendSpawnInput): Promise<BackendSpawnReceipt> {
		if (input.request.backend === "pty") {
			if (!this.pty) throw new Error("PTY backend unavailable");
			return this.pty.spawn(input);
		}
		return this.pipe.spawn(input);
	}

	public control(handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined {
		return (handleBackend(this.pty, handle) ?? handleBackend(this.pipe, handle));
	}

	public handles(): readonly ExecutionHandleRef[] {
		const seen = new Set<string>();
		return [...(this.pty?.handles() ?? []), ...this.pipe.handles()].filter((handle) => {
			if (seen.has(handle.executionId)) return false;
			seen.add(handle.executionId);
			return true;
		});
	}
}

function handleBackend(backend: BackendWithControl | undefined, handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined {
	return backend?.control(handle);
}

function safeSummary(summary: ManagedProcessSummary): Record<string, unknown> {
	return {
		executionId: summary.handle.executionId,
		attemptId: summary.handle.attemptId,
		state: summary.state,
		outputCursor: summary.outputCursor,
		outputSize: summary.outputSize,
		capabilities: summary.capabilities,
		...(summary.terminal === undefined ? {} : { terminal: summary.terminal }),
	};
}

function sameOutputCursor(left: OutputCursor, right: OutputCursor): boolean {
	return left.sequence === right.sequence && left.byteOffset === right.byteOffset;
}

function mapSecurityCreateFailure(code: string): ProductionProcessCreateResult {
	if (code === "policy_denied" || code === "approval_cancelled" || code === "approval_expired" || code === "approval_stale" || code === "path_escape" || code === "protected_path" || code === "network_denied") {
		return { ok: false, code: "execution_constraint_denied" };
	}
	if (code === "invalid_request" || code === "invalid_config") return { ok: false, code: "execution_constraint_invalid" };
	return { ok: false, code: "execution_constraint_unavailable" };
}

function toBackendLaunchPlan(plan: SandboxLaunchPlan): BackendLaunchPlan {
	return {
		program: plan.program,
		arguments: plan.arguments,
		cwd: plan.cwd,
		environment: plan.environment,
	};
}

function isOutputRetentionPlan(value: unknown): value is OutputRetentionPlan {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (!isOutputCursor(record.before) || !isOutputCursor(record.sourceEarliest) || !isOutputCursor(record.sourceHead)) return false;
	if (!Array.isArray(record.blockedBy) || !record.blockedBy.every((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 128)) return false;
	if (!isRuntimeDigest(record.planDigest)) return false;
	const { planDigest: _planDigest, ...body } = record;
	return runtimeDigest(body).digest === record.planDigest.digest;
}

function isOutputCursor(value: unknown): value is OutputCursor {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return isNonNegativeSafeInteger(record.sequence) && isNonNegativeSafeInteger(record.byteOffset);
}

function isRuntimeDigest(value: unknown): value is { readonly algorithm: "sha256"; readonly digest: string } {
	return typeof value === "object" && value !== null && !Array.isArray(value) &&
		(value as Record<string, unknown>).algorithm === "sha256" &&
		typeof (value as Record<string, unknown>).digest === "string" &&
		/^[a-f0-9]{64}$/u.test((value as Record<string, unknown>).digest as string);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
