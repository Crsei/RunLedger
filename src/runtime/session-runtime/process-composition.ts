/** Session-owned managed process composition。 */

import { isAbsolute } from "node:path";
import { defaultShell } from "../../utils/shell.ts";
import type { RunledgerLayout } from "../contracts/storage-layout.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type AttemptId, type CommandId, type WorkspaceId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionDomainResult } from "./domain-router.ts";
import type { SessionProcessDomainPort } from "./session-runtime.ts";
import type { SessionManagedProcessSecurity } from "../../security/session-composition.ts";
import type { ManagedProcessRequest, ExecutionHandleRef, ManagedProcessSummary } from "../process/types.ts";
import { ProcessManager, AuditedProcessManager, type BackendLaunchPlan, type BackendSpawnInput, type BackendSpawnReceipt } from "../process/manager.ts";
import { FileProcessOutputStore } from "../../storage/process/output-store.ts";
import { PipeProcessBackend } from "../../storage/process/process-backend.ts";
import { PtyProcessBackend } from "../../storage/process/pty-backend.ts";
import { createPosixNodePtyAdapter } from "../../storage/process/node-pty-adapter.ts";
import { ManagedProcessControlPlane, type ManagedProcessBackendControl, type ManagedProcessBackendPort } from "../../storage/process/control-plane.ts";
import { SESSION_PROTOCOL_BOUNDS, type SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { ProcessToolClient } from "../tools/process-tool-support.ts";
import type { ManagedBackgroundBashOperations } from "../tools/bash.ts";
import { runtimeWorkspacePlatform } from "../../workspace/runtime-platform.ts";
import type { AttemptPort } from "./attempt-gateway.ts";
import { FileArtifactStore } from "../trace/artifact-store.ts";
import type { TraceRecorderFactory } from "../trace/composition.ts";
import type { RuntimeTraceRecorder } from "../trace/recorder.ts";
import { ManagedProcessOutputMaterializer, type ProcessOutputMaterializationRecord } from "../process/output-artifact.ts";
import type { RecordingFailurePolicy, RecordingMode } from "../../storage/settings-manager.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { SessionProcessJournal } from "./process-journal.ts";
import { SessionProcessCompletionQueue } from "./process-completion-queue.ts";

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

interface CommandDescriptor {
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
	private readonly authorizationCompletions = new Map<string, () => Promise<unknown>>();
	private readonly processAttempts = new Map<string, AttemptId>();
	private readonly processTraceRecorders = new Map<string, Promise<RuntimeTraceRecorder | undefined>>();

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
				onOutputMaterialized: (input: { readonly handle: ExecutionHandleRef; readonly record: ProcessOutputMaterializationRecord }) => this.recordOutputMaterialization(input.handle, input.record),
			}),
			onProcessTerminal: async (summary) => {
				await this.settleProcessAttempt(summary.handle.executionId, "committed");
				await this.completeAuthorization(summary.handle.executionId);
			},
		});
	}

	public async query(
		operation: string,
		payload: Record<string, unknown>,
		_context: { readonly correlationId: string; readonly effectId: string },
	): Promise<SessionDomainResult> {
		if (operation === "session.process.list") {
			const items = this.manager.handles().flatMap((handle) => {
				const result = this.manager.query(handle);
				return result.ok ? [safeSummary(result.summary)] : [];
			});
			return domainSuccess(operation, this.revision(), { items });
		}
		if (operation === "session.process.output") {
			const executionId = stringValue(payload.executionId);
			const cursor = outputCursor(payload.cursor);
			const maxBytes = integerValue(payload.maxBytes);
			if (executionId === undefined || cursor === undefined || maxBytes === undefined || maxBytes < 0 || maxBytes > SESSION_PROTOCOL_BOUNDS.maxOutputPageBytes) {
				return domainFailure(operation, "failed", "invalid_process_output_request");
			}
			const handle = this.findHandle(executionId);
			if (handle === undefined) return domainFailure(operation, "unavailable", "process_not_found");
			const result = this.backend.control(handle) === undefined
				? await this.readRecoveredOutput(handle, cursor, maxBytes)
				: await this.plane.processOutput(handle, cursor, maxBytes);
			if (!result.ok) return domainFailure(operation, "failed", result.code);
			return domainSuccess(operation, this.revision(), {
				executionId,
				text: result.page.text,
				startCursor: result.page.startCursor,
				endCursor: result.page.endCursor,
				nextCursor: result.page.nextCursor,
				truncated: result.page.truncated,
				head: result.head,
			});
		}
		if (operation === "session.process.wait") {
			const executionId = stringValue(payload.executionId);
			const timeoutMs = integerValue(payload.timeoutMs);
			if (executionId === undefined || timeoutMs === undefined || timeoutMs < 1 || timeoutMs > SESSION_PROTOCOL_BOUNDS.maxWaitMs) {
				return domainFailure(operation, "failed", "invalid_process_wait_request");
			}
			const handle = this.findHandle(executionId);
			if (handle === undefined) return domainFailure(operation, "unavailable", "process_not_found");
			const waited = await this.plane.processWait(handle, timeoutMs, "observer");
			if (!waited.ok) return domainFailure(operation, "failed", waited.code);
			if (waited.outcome === "terminal") await this.completeAuthorization(executionId);
			return domainSuccess(operation, this.revision(), {
				outcome: waited.outcome,
				summary: safeSummary(waited.summary),
				nextCursor: waited.nextCursor,
				...(waited.preview === undefined ? {} : { preview: waited.preview }),
			});
		}
		return domainFailure(operation, "unavailable", "operation_unavailable");
	}

	public async mutate(
		operation: string,
		payload: Record<string, unknown>,
		context: { readonly correlationId: string; readonly effectId: string; readonly expectedRevision: number },
	): Promise<SessionDomainResult> {
		if (operation !== "session.process.start") {
			const executionId = stringValue(payload.executionId);
			if (executionId === undefined) return domainFailure(operation, "failed", "execution_id_required");
			const handle = this.findHandle(executionId);
			if (handle === undefined) return domainFailure(operation, "unavailable", "process_not_found");
			const current = this.manager.query(handle);
			if (!current.ok) return domainFailure(operation, "failed", current.code);
			if (context.expectedRevision !== this.revision()) {
				return { ...domainFailure(operation, "stale", "domain_revision_conflict"), currentRevision: this.revision() };
			}
			if (operation === "session.process.stdin") {
				const input = typeof payload.input === "string" ? payload.input : undefined;
				if (input === undefined) return domainFailure(operation, "failed", "process_input_required");
				const result = await this.plane.write(handle, "driver", input);
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.eof") {
				const result = await this.plane.eof(handle, "driver");
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.resize") {
				const columns = integerValue(payload.columns);
				const rows = integerValue(payload.rows);
				if (columns === undefined || rows === undefined) return domainFailure(operation, "failed", "process_resize_required");
				const result = await this.plane.resize(handle, "driver", columns, rows);
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : domainFailure(operation, "failed", result.code);
			}
			if (operation === "session.process.stop") {
				const result = await this.plane.stop(handle, "driver");
				return result.ok ? this.commitMutation(operation, context.effectId, { executionId, receiptDigest: result.receiptDigest }) : domainFailure(operation, "failed", result.code);
			}
			return domainFailure(operation, "unavailable", "operation_unavailable");
		}
		if (context.expectedRevision !== this.revision()) {
			return { ...domainFailure(operation, "stale", "domain_revision_conflict"), currentRevision: this.revision() };
		}
		const command = stringValue(payload.command);
		const cwd = stringValue(payload.cwd) ?? this.options.cwd;
		const timeoutMs = integerValue(payload.timeoutMs);
		const backend = payload.backend;
		const executionMode = payload.executionMode;
		if (command === undefined || !isAbsolute(cwd) || timeoutMs === undefined || timeoutMs < 1 || (backend !== "pipe" && backend !== "pty") || (executionMode !== "foreground" && executionMode !== "background")) {
			return domainFailure(operation, "failed", "invalid_process_start_request");
		}
		const correlationId = createRuntimeId("command", runtimeDigest({
			sessionId: this.options.fence.sessionId,
			generation: this.options.fence.generation,
			correlationId: context.correlationId,
			effectId: context.effectId,
		}).digest.slice(0, 64));
		const requestDigest = runtimeDigest({ command, cwd, timeoutMs, backend, executionMode });
		const prepared = await this.options.security.prepare({
			commandId: correlationId,
			command,
			cwd,
			timeoutMs,
			backend,
			executionMode,
			requestDigest,
		});
		if (!prepared.ok) return domainFailure(operation, "denied", prepared.error.code);
		const attemptPort = this.options.attemptPort?.();
		const begun = attemptPort?.beginAttempt("process_spawn", requestDigest);
		if (begun !== undefined && "error" in begun) {
			return domainFailure(operation, "recovery_required", begun.error);
		}
		this.commands.set(correlationId, { command, cwd });
		const request: ManagedProcessRequest = {
			authorityId: createRuntimeId("authority", "session-owner-runtime"),
			tenantId: createRuntimeId("tenant", "local-user"),
			workspaceId: this.options.workspaceId,
			sessionId: this.options.fence.sessionId,
			hostGeneration: this.options.fence.generation,
			sessionGeneration: this.options.fence.generation,
			requestDigest: prepared.value.requestDigest,
			commandRef: { subjectKind: "content", digest: runtimeDigest(command), mediaType: "text/plain", size: Buffer.byteLength(command) },
			cwdRef: { subjectKind: "content", digest: runtimeDigest(cwd), mediaType: "text/plain", size: Buffer.byteLength(cwd) },
			backend,
			executionMode,
			timeoutMs,
			correlationId,
		};
		const launchPlan: BackendLaunchPlan | undefined = prepared.value.sandboxPlan === undefined
			? undefined
			: {
				program: prepared.value.sandboxPlan.program,
				arguments: prepared.value.sandboxPlan.arguments,
				cwd: prepared.value.sandboxPlan.cwd,
				environment: prepared.value.sandboxPlan.environment,
			};
		const created = await this.plane.create(request, prepared.value.constraintInput, {
			constraintSnapshot: prepared.value.constraintSnapshot,
			...(launchPlan === undefined ? {} : { launchPlan }),
			beforeSpawn: async () => {
				const finalLeaf = await prepared.value.validateFinalLeaf();
				if (!finalLeaf.ok) throw new Error(`${finalLeaf.error.code}: ${finalLeaf.error.message}`);
			},
		});
		if (!created.ok) {
			if (begun !== undefined && created.code !== "uncertain_outcome") {
				const settled = attemptPort?.settleAttempt(begun.attemptId, "rejected", runtimeDigest({ code: created.code }));
				if (settled !== undefined && !settled.ok) return domainFailure(operation, "failed", settled.code);
			}
			return domainFailure(operation, created.code.includes("denied") ? "denied" : "failed", created.code);
		}
		if (begun !== undefined) this.processAttempts.set(created.handle.executionId, begun.attemptId);
		this.authorizationCompletions.set(created.handle.executionId, prepared.value.complete);
		return this.commitMutation(operation, context.effectId, safeSummary(created.summary));
	}

	public toolClient(): ManagedBackgroundBashOperations & ProcessToolClient {
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
			processOutput: (handle, cursor, maxBytes) => this.plane.processOutput(handle, cursor, maxBytes),
			processWait: (handle, timeoutMs, actor) => this.plane.processWait(handle, timeoutMs, actor),
			write: (handle, actor, input) => this.plane.write(handle, actor, input),
			stop: (handle, actor, signal) => this.plane.stop(handle, actor, signal),
			resize: (handle, actor, columns, rows) => this.plane.resize(handle, actor, columns, rows),
		};
	}

	/** Takeover 只结算 durable projection；绝不按 PID/PTY handle 重连。 */
	public recoverUnattached(): ReturnType<ProcessManager["recoverUnattached"]> {
		return this.manager.recoverUnattached();
	}

	public hasRecoveryUncertainty(): boolean {
		return this.manager.handles().some((handle) => {
			const result = this.manager.query(handle);
			if (!result.ok) return true;
			return result.summary.state === "lost" || result.summary.state === "uncertain" ||
				(this.backend.control(handle) === undefined && !isTerminalSummary(result.summary));
		});
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
			await this.completeAuthorization(handle.executionId);
		}
		await this.plane.waitForTerminalTasks();
	}

	private findHandle(executionId: string): ExecutionHandleRef | undefined {
		return this.manager.handles().find((handle) => handle.executionId === executionId);
	}

	private revision(): number {
		return this.journal.domainRevision();
	}

	private commitMutation(operation: string, effectId: string, value: Record<string, unknown>): SessionDomainResult {
		try {
			return domainSuccess(operation, this.journal.commitDomainRevision(operation, effectId), value);
		} catch {
			return domainFailure(operation, "recovery_required", "process_domain_revision_commit_uncertain");
		}
	}

	private async completeAuthorization(executionId: string): Promise<void> {
		const complete = this.authorizationCompletions.get(executionId);
		if (complete === undefined) return;
		this.authorizationCompletions.delete(executionId);
		await complete();
	}

	private async settleProcessAttempt(executionId: string, outcome: "committed" | "rejected"): Promise<void> {
		const attemptId = this.processAttempts.get(executionId);
		if (attemptId === undefined) return;
		const port = this.options.attemptPort?.();
		if (port === undefined) throw new Error("Session process attempt port is unavailable");
		const settled = port.settleAttempt(attemptId, outcome, runtimeDigest({ executionId, outcome }));
		if (!settled.ok) throw new Error(`Session process attempt settlement failed: ${settled.code}`);
		this.processAttempts.delete(executionId);
	}

	private async recordOutputMaterialization(handle: ExecutionHandleRef, record: ProcessOutputMaterializationRecord): Promise<void> {
		const content = record.materialization.traceContent;
		if (record.mode === "off" || content === undefined) return;
		const factory = this.options.traceRecorderFactory;
		if (factory === undefined) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("Session process Trace recorder is unavailable");
			return;
		}
		const key = `${handle.executionId}:${handle.attemptId}`;
		let recorderPromise = this.processTraceRecorders.get(key);
		if (recorderPromise === undefined) {
			const traceId = createRuntimeId("trace", runtimeDigest({
				sessionId: this.options.fence.sessionId,
				ownerGeneration: this.options.fence.generation,
				executionId: handle.executionId,
				attemptId: handle.attemptId,
			}).digest.slice(0, 64));
			recorderPromise = factory.create({
				sessionId: this.options.fence.sessionId,
				ownerGeneration: this.options.fence.generation,
				traceId,
			}).catch((error: unknown) => {
				if (this.options.recordingFailurePolicy === "fail_closed") throw error;
				return undefined;
			});
			this.processTraceRecorders.set(key, recorderPromise);
		}
		const recorder = await recorderPromise;
		if (recorder === undefined) {
			if (this.options.recordingFailurePolicy === "fail_closed") throw new Error("Session process Trace recorder is unavailable");
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

	private async readRecoveredOutput(
		handle: ExecutionHandleRef,
		cursor: { readonly sequence: number; readonly byteOffset: number },
		maxBytes: number,
	) {
		const result = await new FileProcessOutputStore({
			layout: this.options.layout,
			workspaceStorageKey: this.storageKey,
			executionId: handle.executionId,
			attemptId: handle.attemptId,
		}).read(cursor, maxBytes);
		if (!result.ok) return { ok: false as const, code: result.code };
		return { ok: true as const, page: result.page, head: result.head };
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
		...(summary.terminal === undefined ? {} : { terminal: summary.terminal }),
	};
}

function isTerminalSummary(summary: ManagedProcessSummary): boolean {
	return summary.terminal !== undefined;
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

class SessionCompositeProcessBackend implements ManagedProcessBackendPort {
	private readonly pipe: ManagedProcessBackendPort;
	private readonly pty: ManagedProcessBackendPort | undefined;

	public constructor(pipe: ManagedProcessBackendPort, pty: ManagedProcessBackendPort | undefined) {
		this.pipe = pipe;
		this.pty = pty;
	}

	public async spawn(input: BackendSpawnInput): Promise<BackendSpawnReceipt> {
		if (input.request.backend === "pty") {
			if (this.pty === undefined) throw new Error("PTY backend is unavailable");
			return this.pty.spawn(input);
		}
		return this.pipe.spawn(input);
	}

	public control(handle: ExecutionHandleRef): ManagedProcessBackendControl | undefined {
		return this.pty?.control(handle) ?? this.pipe.control(handle);
	}

	public handles(): readonly ExecutionHandleRef[] {
		return [...(this.pty?.handles?.() ?? []), ...(this.pipe.handles?.() ?? [])];
	}
}
