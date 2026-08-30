/**
 * S3 拆分:Session-owned managed process composition facade。
 *
 * 本文件只做装配与生命周期:backend/manager/plane 组合、handler 注入、
 * toolClient 桥与 shutdown;query/mutation 实现位于
 * `process/query-handler.ts` / `process/mutation-handler.ts`,输出/Trace
 * 物化在 `process/output-materializer.ts`,结算在
 * `process/completion-settlement.ts`,恢复投影在 `process/recovery.ts`。
 * 公共 export 与 import 路径不变。
 */

import { defaultShell } from "../../../utils/shell.ts";
import type { RunledgerLayout } from "../../contracts/storage-layout.ts";
import { runtimeDigest } from "../../protocol/foundation.ts";
import { createRuntimeId, type CommandId, type WorkspaceId } from "../../protocol/ids.ts";
import type { OwnerFence } from "../../session-owner/types.ts";
import type { SessionDomainResult } from "../domain-router.ts";
import type { SessionProcessDomainPort } from "../session-runtime.ts";
import type { SessionManagedProcessSecurity } from "../../../security/session-composition.ts";
import type { AttemptPort } from "../attempt-gateway.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../../process/types.ts";
import { ProcessManager, AuditedProcessManager } from "../../process/manager.ts";
import { FileProcessOutputStore } from "../../../storage/process/output-store.ts";
import { PipeProcessBackend } from "../../../storage/process/process-backend.ts";
import { PtyProcessBackend } from "../../../storage/process/pty-backend.ts";
import { createPosixNodePtyAdapter } from "../../../storage/process/node-pty-adapter.ts";
import { ManagedProcessControlPlane } from "../../../storage/process/control-plane.ts";
import { SESSION_PROTOCOL_BOUNDS, type SessionProtocolOperationDescriptor } from "../../session-server/protocol.ts";
import type { ProcessToolClient } from "../../tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations, ManagedForegroundBashOperations } from "../../tools/bash.ts";
import { runtimeWorkspacePlatform } from "../../../workspace/runtime-platform.ts";
import { FileArtifactStore } from "../../trace/artifact-store.ts";
import type { TraceRecorderFactory } from "../../trace/composition.ts";
import { ManagedProcessOutputMaterializer, type ProcessOutputMaterializationRecord } from "../../process/output-artifact.ts";
import type { RecordingFailurePolicy, RecordingMode } from "../../../storage/settings-manager.ts";
import type { SessionStore } from "../../../storage/session-store/session-store.ts";
import { SessionProcessJournal } from "../process-journal.ts";
import { SessionProcessCompletionQueue } from "../process-completion-queue.ts";
import { SessionCompositeProcessBackend } from "./composite-backend.ts";
import { SessionProcessOutputMaterializer } from "./output-materializer.ts";
import { ProcessCompletionSettlement } from "./completion-settlement.ts";
import { hasProcessRecoveryUncertainty, isTerminalSummary, recoverUnattachedProcesses } from "./recovery.ts";
import { ProcessQueryHandler, type ProcessResultShaping } from "./query-handler.ts";
import { ProcessMutationHandler } from "./mutation-handler.ts";
import { executeForegroundProcess } from "./foreground-execution.ts";

export interface SessionProcessCompositionOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	readonly fence: OwnerFence;
	readonly workspaceId: WorkspaceId;
	readonly security: SessionManagedProcessSecurity;
	readonly store: SessionStore;
	readonly attemptPort?: () => AttemptPort | undefined;
	readonly recordingMode?: RecordingMode;
	readonly recordingFailurePolicy?: RecordingFailurePolicy;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly maxProcessesPerSession?: number;
}

const PROCESS_OPERATIONS: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "session.process.list", capability: "session.process", access: "read" }),
	Object.freeze({ operation: "session.process.output", capability: "session.process", access: "read" }),
	Object.freeze({ operation: "session.process.wait", capability: "session.process", access: "read" }),
	Object.freeze({ operation: "session.process.start", capability: "session.process", access: "mutate" }),
	Object.freeze({ operation: "session.process.stdin", capability: "session.process", access: "mutate" }),
	Object.freeze({ operation: "session.process.eof", capability: "session.process", access: "mutate" }),
	Object.freeze({ operation: "session.process.resize", capability: "session.process", access: "mutate" }),
	Object.freeze({ operation: "session.process.stop", capability: "session.process", access: "mutate" }),
]);

export interface CommandDescriptor {
	readonly command: string;
	readonly cwd: string;
}

export class SessionManagedProcessComposition implements SessionProcessDomainPort {
	public readonly operationManifest = PROCESS_OPERATIONS;
	private readonly options: SessionProcessCompositionOptions;
	private readonly storageKey: string;
	private readonly commands = new Map<CommandId, CommandDescriptor>();
	private readonly manager: ProcessManager;
	private readonly journal: SessionProcessJournal;
	private readonly plane: ManagedProcessControlPlane;
	private readonly backend: SessionCompositeProcessBackend;
	private readonly output: SessionProcessOutputMaterializer;
	private readonly settlement: ProcessCompletionSettlement;
	private readonly queryHandler: ProcessQueryHandler;
	private readonly mutationHandler: ProcessMutationHandler;

	public constructor(options: SessionProcessCompositionOptions) {
		this.options = options;
		const storageKey = sessionProcessStorageKey(options.fence);
		this.storageKey = storageKey;
		const journal = new SessionProcessJournal({ store: options.store, fence: options.fence, workspaceId: options.workspaceId });
		this.journal = journal;
		const output = (input: { readonly handle: ExecutionHandleRef }): FileProcessOutputStore => new FileProcessOutputStore({
			layout: options.layout,
			workspaceStorageKey: storageKey,
			executionId: input.handle.executionId,
			attemptId: input.handle.attemptId,
		});
		const pipe = new PipeProcessBackend({
			resolveCommand: (request) => {
				const descriptor = this.commands.get(request.correlationId);
				if (descriptor === undefined) throw new Error("Session process command resolver is unavailable");
				return { executable: defaultShell(), args: ["-lc", descriptor.command], cwd: descriptor.cwd };
			},
			createOutputStore: output,
		});
		const platform = runtimeWorkspacePlatform();
		const pty = platform === "linux" || platform === "macos"
			? new PtyProcessBackend({
				adapter: createPosixNodePtyAdapter(),
				resolveCommand: (request) => {
					const descriptor = this.commands.get(request.correlationId);
					if (descriptor === undefined) throw new Error("Session PTY command resolver is unavailable");
					return { executable: defaultShell(), args: ["-lc", descriptor.command], cwd: descriptor.cwd };
				},
				createOutputStore: output,
			})
			: undefined;
		const backend = new SessionCompositeProcessBackend(pipe.asManagerBackend(), pty?.asManagerBackend());
		this.backend = backend;
		this.manager = new ProcessManager(journal, backend, {
			maxProcessesPerSession: options.maxProcessesPerSession ?? SESSION_PROTOCOL_BOUNDS.maxProcessesPerSession,
			maxProcessesTotal: options.maxProcessesPerSession ?? SESSION_PROTOCOL_BOUNDS.maxProcessesPerSession,
		});
		const queue = new SessionProcessCompletionQueue({ store: options.store, fence: options.fence, workspaceId: options.workspaceId });
		const recordingMode = options.recordingMode ?? "off";
		const artifactStore = recordingMode === "events_and_artifacts"
			? new FileArtifactStore({ dataRoot: options.layout.artifacts, metadataRoot: options.layout.artifactMetadata })
			: undefined;
		this.output = new SessionProcessOutputMaterializer(options, storageKey);
		this.settlement = new ProcessCompletionSettlement(options);
		this.plane = new ManagedProcessControlPlane({
			manager: this.manager,
			auditedManager: new AuditedProcessManager(this.manager),
			backend,
			completionQueue: queue,
			policyDigest: runtimeDigest({ source: "session-process", generation: options.fence.generation }),
			budgetDigest: runtimeDigest(SESSION_PROTOCOL_BOUNDS),
			recordingFailurePolicy: options.recordingFailurePolicy,
			outputMaterializer: new ManagedProcessOutputMaterializer({
				mode: recordingMode,
				...(artifactStore === undefined ? {} : { artifactStore }),
			}),
			...(recordingMode === "off" ? {} : {
				onOutputMaterialized: (input: { readonly handle: ExecutionHandleRef; readonly record: ProcessOutputMaterializationRecord }) => this.output.recordOutputMaterialization(input.handle, input.record),
			}),
			onProcessTerminal: async (summary) => {
				await this.output.finishProcessTrace(summary);
				await this.settlement.settle(summary.handle.executionId, "committed");
				await this.settlement.complete(summary.handle.executionId);
			},
		});
		const shaping: ProcessResultShaping = {
			domainSuccess,
			domainFailure,
			stringValue,
			integerValue,
			outputCursor,
			safeSummary,
		};
		this.queryHandler = new ProcessQueryHandler({
			manager: this.manager,
			plane: this.plane,
			backend: this.backend,
			revision: () => this.journal.domainRevision(),
			completeAuthorization: (executionId) => this.settlement.complete(executionId),
			readRecoveredOutput: (handle, cursor, maxBytes) => this.output.readRecoveredOutput(handle, cursor, maxBytes),
			...shaping,
		});
		this.mutationHandler = new ProcessMutationHandler({
			options,
			manager: this.manager,
			commands: this.commands,
			plane: this.plane,
			journal: this.journal,
			revision: () => this.journal.domainRevision(),
			settlement: this.settlement,
			attemptPort: () => options.attemptPort?.(),
			...shaping,
		});
	}

	public async query(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult> {
		return this.queryHandler.query(operation, payload, context);
	}

	public async mutate(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult> {
		return this.mutationHandler.mutate(operation, payload, context);
	}

	public toolClient(): ManagedBackgroundBashOperations & ManagedForegroundBashOperations & ProcessToolClient {
		return {
			start: async (input) => {
				const contextSeed = runtimeDigest({
					sessionId: this.options.fence.sessionId,
					generation: this.options.fence.generation,
					command: input.command,
					cwd: input.cwd,
					now: Date.now(),
				});
				const result = await this.mutate("session.process.start", {
					command: input.command,
					cwd: input.cwd,
					timeoutMs: input.timeoutMs,
					backend: "pipe",
					executionMode: "background",
				}, {
					correlationId: `correlation_${contextSeed.digest.slice(0, 64)}`,
					effectId: `effect_${contextSeed.digest.slice(0, 64)}`,
					expectedRevision: this.revision(),
				});
				if (!result.ok) return { ok: false, code: result.code };
				const executionId = stringValue(result.value.executionId);
				const handle = executionId === undefined ? undefined : this.findHandle(executionId);
				if (handle === undefined) return { ok: false, code: "process_not_found" };
				const current = this.manager.query(handle);
				return current.ok
					? { ok: true, handle: current.handle, summary: current.summary }
					: { ok: false, code: current.code };
			},
			exec: (input) => executeForegroundProcess(input, {
				fence: this.options.fence,
				plane: this.plane,
				revision: () => this.revision(),
				isTerminal: (handle) => this.isTerminal(handle),
				findHandle: (executionId) => this.findHandle(executionId),
				mutate: (operation, payload, context) => this.mutate(operation, payload, context),
			}),
			processOutput: (handle, cursor, maxBytes) => this.plane.processOutput(handle, cursor, maxBytes),
			processWait: (handle, timeoutMs, actor) => this.plane.processWait(handle, timeoutMs, actor),
			write: (handle, actor, input) => this.plane.write(handle, actor, input),
			stop: (handle, actor, signal) => this.plane.stop(handle, actor, signal),
			resize: (handle, actor, columns, rows) => this.plane.resize(handle, actor, columns, rows),
		};
	}

	/** Takeover 只结算 durable projection；绝不按 PID/PTY handle 重连。 */
	public async recoverUnattached(): ReturnType<ProcessManager["recoverUnattached"]> {
		return recoverUnattachedProcesses({
			manager: this.manager,
			plane: this.plane,
			backend: this.backend,
			storageKey: this.storageKey,
			layout: this.options.layout,
			recordingFailurePolicy: this.options.recordingFailurePolicy,
			finishProcessTrace: (summary) => this.output.finishProcessTrace(summary),
		});
	}

	public hasRecoveryUncertainty(): boolean {
		return hasProcessRecoveryUncertainty({ manager: this.manager, backend: this.backend });
	}

	public async shutdown(_reason: "paused" | "detached" | "error" | "fenced"): Promise<void> {
		for (const handle of this.manager.handles()) {
			const current = this.manager.query(handle);
			if (!current.ok || isTerminalSummary(current.summary)) continue;
			const stopped = await this.plane.stop(handle, "driver", "SIGTERM");
			if (!stopped.ok && stopped.code !== "terminal_state_immutable") {
				throw new Error(`Session process stop failed: ${stopped.code}`);
			}
			let waited = await this.plane.processWait(handle, 5_000, "driver");
			if (waited.ok && waited.outcome !== "terminal") {
				const killed = await this.plane.stop(handle, "driver", "SIGKILL");
				if (!killed.ok && killed.code !== "terminal_state_immutable") {
					throw new Error(`Session process kill failed: ${killed.code}`);
				}
				waited = await this.plane.processWait(handle, 5_000, "driver");
			}
			if (!waited.ok || waited.outcome !== "terminal") throw new Error("Session process shutdown settlement is uncertain");
			await this.settlement.complete(handle.executionId);
		}
		await this.plane.waitForTerminalTasks();
	}

	private findHandle(executionId: string): ExecutionHandleRef | undefined {
		return this.manager.handles().find((handle) => handle.executionId === executionId);
	}

	private isTerminal(handle: ExecutionHandleRef): boolean {
		const current = this.manager.query(handle);
		return current.ok && current.summary.terminal !== undefined;
	}

	private revision(): number {
		return this.journal.domainRevision();
	}
}

export function createSessionProcessComposition(options: SessionProcessCompositionOptions): SessionManagedProcessComposition {
	return new SessionManagedProcessComposition(options);
}

function sessionProcessStorageKey(fence: OwnerFence): string {
	return `session-${runtimeDigest(fence.sessionId).digest}`;
}

function safeSummary(summary: ManagedProcessSummary): Record<string, unknown> {
	return {
		executionId: summary.handle.executionId,
		attemptId: summary.handle.attemptId,
		state: summary.state,
		outputCursor: summary.outputCursor,
		outputSize: summary.outputSize,
		capabilities: summary.capabilities,
		commandDisplay: summary.commandDisplay ?? { authority: "unavailable" },
		...(summary.terminal === undefined ? {} : { terminal: summary.terminal }),
	};
}

function domainSuccess(operation: string, domainRevision: number, value: Record<string, unknown>): SessionDomainResult {
	return { ok: true, status: "ok", operation, domainRevision, value };
}

function domainFailure(operation: string, status: "unavailable" | "denied" | "stale" | "failed" | "recovery_required", code: string): Extract<SessionDomainResult, { readonly ok: false }> {
	return { ok: false, status, code, operation };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 256 * 1024 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function outputCursor(value: unknown): { readonly sequence: number; readonly byteOffset: number } | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const sequence = integerValue(record.sequence);
	const byteOffset = integerValue(record.byteOffset);
	return sequence === undefined || byteOffset === undefined || sequence < 0 || byteOffset < 0 ? undefined : { sequence, byteOffset };
}
