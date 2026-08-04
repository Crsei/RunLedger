/** Host-owned managed process coordinator。
 *
 * 本模块只编排 durable process journal 与 backend port。backend receipt 是
 * 幂等重试的边界，public result 只暴露 safe handle/summary，不暴露 PID、路径
 * 或原始 command。
 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import { RUNTIME_HOST_BOUNDS } from "../host/types.ts";
import type { CommandId } from "../protocol/ids.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { createProcessEvent, type ProcessEvent } from "./events.ts";
import {
	evaluateExecutionConstraints,
	createBuiltinNoneExecutionDecisionProviders,
	validateExecutionConstraintSnapshot,
	type ExecutionConstraintInput,
	type ExecutionConstraintProviders,
	type ExecutionConstraintSnapshot,
} from "./execution-decision.ts";
import {
	projectProcessEvents,
	type ProcessProjection,
} from "./state-machine.ts";
import type {
	ExecutionHandleRef,
	ManagedProcessMutationReceipt,
	ManagedProcessRequest,
	ManagedProcessSummary,
	ProcessState,
	ProcessTerminalState,
} from "./types.ts";
import type { OutputCursor } from "./output.ts";

export interface BackendSpawnReceipt {
	readonly receiptDigest: RuntimeDigest;
	readonly evidenceRef?: RuntimeContentRef;
}

/** Immutable launch command delivered by a validated Host final-leaf plan. */
export interface BackendLaunchPlan {
	readonly program: string;
	readonly arguments: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
}

/** Final-leaf callback runs after durable claim and immediately before raw spawn. */
export interface BackendSpawnOptions {
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
	readonly launchPlan?: BackendLaunchPlan;
	readonly beforeSpawn?: () => Promise<void>;
}

export interface BackendSpawnInput {
	readonly handle: ExecutionHandleRef;
	readonly request: ManagedProcessRequest;
	readonly spawnClaimDigest: RuntimeDigest;
	readonly constraintSnapshot?: ExecutionConstraintSnapshot;
	readonly constraintInput?: ExecutionConstraintInput;
	readonly launchPlan?: BackendLaunchPlan;
	readonly beforeSpawn?: () => Promise<void>;
}

export interface BackendSpawnPort {
	spawn(input: BackendSpawnInput): Promise<BackendSpawnReceipt>;
}

/**
 * R5 的最小 durable seam。真实 JSONL/store 实现可以在后续阶段替换，
 * 但不能减少 intent、claim、receipt 和按 handle 重放这四个能力。
 */
export interface ProcessJournal {
	append(event: ProcessEvent): Promise<void>;
	findIntent(commandId: CommandId): ProcessEvent | undefined;
	eventsFor(handle: ExecutionHandleRef): readonly ProcessEvent[];
	handles?(): readonly ExecutionHandleRef[];
	recordSpawnClaim(handle: ExecutionHandleRef): void;
	hasSpawnClaim(handle: ExecutionHandleRef): boolean;
	spawnReceipt(handle: ExecutionHandleRef): BackendSpawnReceipt | undefined;
	recordSpawnReceipt(handle: ExecutionHandleRef, receipt: BackendSpawnReceipt): void;
	constraintSnapshot?(commandId: CommandId): ExecutionConstraintSnapshot | undefined;
	recordConstraintSnapshot?(commandId: CommandId, snapshot: ExecutionConstraintSnapshot): void;
	reserveProcessCapacity(
		handle: ExecutionHandleRef,
		limits: { readonly maxPerSession: number; readonly maxPerHost: number },
	): "reserved" | "already_reserved" | "session_capacity_exceeded" | "host_capacity_exceeded";
	releaseProcessCapacity(handle: ExecutionHandleRef): void;
}

export type ProcessManagerErrorCode =
	| "command_id_conflict"
	| "process_not_found"
	| "journal_invalid"
	| "journal_unavailable"
	| "backend_spawn_failed"
	| "session_process_capacity_exceeded"
	| "host_process_capacity_exceeded"
	| "uncertain_outcome"
	| "terminal_state_immutable"
	| "backend_mutation_unavailable";

export type ProcessCreateResult =
	| { readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: ManagedProcessSummary }
	| { readonly ok: false; readonly code: ProcessManagerErrorCode };

export type ProcessQueryResult =
	| { readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: ManagedProcessSummary }
	| { readonly ok: false; readonly code: Extract<ProcessManagerErrorCode, "process_not_found" | "journal_invalid"> };

export type ProcessRecoveryResult =
	| ProcessQueryResult
	| { readonly ok: false; readonly code: "journal_unavailable" };

export type ProcessSettlementResult =
	| ProcessQueryResult
	| { readonly ok: false; readonly code: "journal_unavailable" | "terminal_state_immutable" };

export type ProcessMutationResult =
	| { readonly ok: true; readonly receipt: ManagedProcessMutationReceipt }
	| { readonly ok: false; readonly code: Extract<ProcessManagerErrorCode, "process_not_found" | "journal_invalid" | "terminal_state_immutable" | "backend_mutation_unavailable"> };

type ManagerProjectionResult =
	| { readonly ok: true; readonly state: ProcessProjection }
	| { readonly ok: false; readonly code: Extract<ProcessManagerErrorCode, "process_not_found" | "journal_invalid"> };

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set([
	"completed",
	"failed",
	"timed_out",
	"killed",
	"lost",
	"uncertain",
]);

export class ProcessManager {
	private readonly journal: ProcessJournal;
	private readonly backend: BackendSpawnPort;
	/**
	 * A claim without a receipt is retryable only by the manager instance that
	 * created the claim. A new Host must not guess whether the old backend
	 * actually spawned after a response loss.
	 */
	private readonly localSpawnClaims = new Set<string>();

	public constructor(journal: ProcessJournal, backend: BackendSpawnPort) {
		this.journal = journal;
		this.backend = backend;
	}

	public async create(
		request: ManagedProcessRequest,
		constraintSnapshot?: ExecutionConstraintSnapshot,
		constraintInput?: ExecutionConstraintInput,
		spawnOptions?: BackendSpawnOptions,
	): Promise<ProcessCreateResult> {
		const intent = this.journal.findIntent(request.correlationId);
		let handle: ExecutionHandleRef;
		if (intent) {
			if (!sameRequestScope(intent, request, constraintSnapshot)) return { ok: false, code: "command_id_conflict" };
			handle = handleFromEvent(intent);
		} else {
			handle = createHandle(request);
			let reservation: ReturnType<ProcessJournal["reserveProcessCapacity"]>;
			try {
				reservation = this.journal.reserveProcessCapacity(handle, {
					maxPerSession: RUNTIME_HOST_BOUNDS.maxProcessesPerSession,
					maxPerHost: RUNTIME_HOST_BOUNDS.maxProcessesPerHost,
				});
			} catch {
				return { ok: false, code: "journal_unavailable" };
			}
			if (reservation === "session_capacity_exceeded") return { ok: false, code: "session_process_capacity_exceeded" };
			if (reservation === "host_capacity_exceeded") return { ok: false, code: "host_process_capacity_exceeded" };
			if (reservation === "already_reserved") return { ok: false, code: "uncertain_outcome" };
			const requested = createProcessEvent({
				handle,
				sequence: 0,
				revision: 0,
				type: "process.execution_requested",
				previousState: null,
				nextState: "queued",
				previousEventHash: null,
				commandId: request.correlationId,
				managedRequestDigest: completeRequestDigest(request),
				backend: request.backend,
				executionMode: request.executionMode,
				...(constraintSnapshot === undefined ? {} : { constraintSnapshotDigest: constraintSnapshot.snapshotDigest }),
			});
			try {
				await this.journal.append(requested);
			} catch {
				this.journal.releaseProcessCapacity(handle);
				return { ok: false, code: "journal_unavailable" };
			}
		}
		if (constraintSnapshot !== undefined && this.journal.constraintSnapshot?.(request.correlationId) === undefined) {
			try {
				this.journal.recordConstraintSnapshot?.(request.correlationId, constraintSnapshot);
			} catch {
				return { ok: false, code: "journal_unavailable" };
			}
		}

		let projectionResult = this.project(handle);
		if (!projectionResult.ok) return { ok: false, code: projectionResult.code };
		if (isSettled(projectionResult.state.state) || isStarted(projectionResult.state.state)) {
			return this.success(projectionResult.state);
		}

		if (projectionResult.state.state === "queued") {
			const starting = await this.appendTransition(
				projectionResult.state,
				"process.execution_starting",
				"starting",
				request.correlationId,
				undefined,
				constraintSnapshot,
			);
			if (!starting.ok) return starting;
			projectionResult = starting;
		}

		if (projectionResult.state.state !== "starting") {
			return { ok: false, code: "journal_invalid" };
		}

		const current = projectionResult.state;
		const claimKey = processKey(current.handle);
		try {
			if (!this.journal.hasSpawnClaim(current.handle)) {
				this.journal.recordSpawnClaim(current.handle);
				this.localSpawnClaims.add(claimKey);
			} else if (!this.localSpawnClaims.has(claimKey) && this.journal.spawnReceipt(current.handle) === undefined) {
				return { ok: false, code: "uncertain_outcome" };
			}
		} catch {
			return { ok: false, code: "journal_unavailable" };
		}

		let receipt = this.journal.spawnReceipt(current.handle);
		if (!receipt) {
			try {
				receipt = await this.backend.spawn({
					handle: current.handle,
					request,
					spawnClaimDigest: spawnClaimDigest(current.handle, request, constraintSnapshot, constraintInput),
					...(constraintSnapshot === undefined ? {} : { constraintSnapshot }),
					...(constraintInput === undefined ? {} : { constraintInput }),
					...(spawnOptions?.launchPlan === undefined ? {} : { launchPlan: spawnOptions.launchPlan }),
					...(spawnOptions?.beforeSpawn === undefined ? {} : { beforeSpawn: spawnOptions.beforeSpawn }),
				});
			} catch {
				// claim 已 durable，但 spawn response 的真实结果未知；重试仍使用同一 handle
				// 和 backend idempotency boundary，不能伪造 failed 或再次分配 attempt。
				return { ok: false, code: "uncertain_outcome" };
			}
			try {
				this.journal.recordSpawnReceipt(current.handle, receipt);
			} catch {
				return { ok: false, code: "uncertain_outcome" };
			}
		}

		const afterReceipt = this.project(current.handle);
		if (!afterReceipt.ok) return { ok: false, code: afterReceipt.code };
		if (isSettled(afterReceipt.state.state) || isStarted(afterReceipt.state.state)) {
			return this.success(afterReceipt.state);
		}
		const finalType = request.executionMode === "background"
			? "process.execution_backgrounded"
			: "process.execution_started";
		const finalState = request.executionMode === "background" ? "backgrounded" : "running";
		const started = await this.appendTransition(afterReceipt.state, finalType, finalState, request.correlationId, receipt, constraintSnapshot);
		if (!started.ok) {
			return started.code === "journal_unavailable" ? { ok: false, code: "uncertain_outcome" } : started;
		}
		return this.success(started.state);
	}

	public query(handle: ExecutionHandleRef): ProcessQueryResult {
		const projected = this.project(handle);
		if (!projected.ok) return projected;
		return this.success(projected.state);
	}

	/** Durable Host restart enumeration; the in-memory backend registry is not authoritative. */
	public handles(): readonly ExecutionHandleRef[] {
		if (this.journal.handles) return this.journal.handles();
		const backend = this.backend as BackendSpawnPort & { readonly handles?: () => readonly ExecutionHandleRef[] };
		return backend.handles?.() ?? [];
	}

	/** Host restart recovery never guesses a PID; an unattached durable attempt is uncertain. */
	public async recoverUnattached(): Promise<readonly ProcessRecoveryResult[]> {
		const handles = this.journal.handles?.() ?? [];
		const recovered: ProcessRecoveryResult[] = [];
		for (const handle of handles) {
			const projection = this.project(handle);
			if (!projection.ok || isSettled(projection.state.state)) continue;
			let hasSpawnReceipt = false;
			let hasSpawnClaim = false;
			try {
				hasSpawnReceipt = this.journal.spawnReceipt(handle) !== undefined;
				hasSpawnClaim = this.journal.hasSpawnClaim(handle);
			} catch {
				recovered.push({ ok: false, code: "journal_invalid" });
				continue;
			}
			const state: ProcessTerminalState = hasSpawnReceipt || hasSpawnClaim ? "uncertain" : "lost";
			const settled = await this.settle(handle, {
				state,
				evidenceRef: {
					subjectKind: "receipt",
					digest: runtimeDigest({ handle, reason: "host_restart_unattached", state }),
					mediaType: "application/json",
					size: 0,
				},
			});
			if (settled.ok) recovered.push(settled);
			else if (settled.code === "journal_unavailable") recovered.push({ ok: false, code: "journal_unavailable" });
			else recovered.push({ ok: false, code: "journal_invalid" });
		}
		return recovered;
	}

	public constraintSnapshot(commandId: CommandId): ExecutionConstraintSnapshot | undefined {
		return this.journal.constraintSnapshot?.(commandId);
	}

	public async checkpointOutput(handle: ExecutionHandleRef, outputCursor: OutputCursor, outputSize: number): Promise<ProcessSettlementResult> {
		if (!isOutputCursor(outputCursor) || !Number.isSafeInteger(outputSize) || outputSize < 0) {
			return { ok: false, code: "journal_unavailable" };
		}
		const projection = this.project(handle);
		if (!projection.ok) return projection;
		if (isSettled(projection.state.state)) return { ok: false, code: "terminal_state_immutable" };
		const next = await this.appendTransition(
			projection.state,
			"process.output_checkpointed",
			projection.state.state,
			undefined,
			undefined,
			undefined,
			undefined,
			projection.state.constraintSnapshotDigest,
			outputCursor,
			outputSize,
		);
		if (!next.ok) return next;
		return this.query(handle);
	}

	public async requestTermination(handle: ExecutionHandleRef): Promise<ProcessSettlementResult> {
		const projection = this.project(handle);
		if (!projection.ok) return projection;
		if (isSettled(projection.state.state)) return { ok: false, code: "terminal_state_immutable" };
		const next = await this.appendTransition(
			projection.state,
			"process.termination_requested",
			projection.state.state,
			undefined,
			undefined,
			undefined,
			undefined,
			projection.state.constraintSnapshotDigest,
		);
		if (!next.ok) return next;
		return this.query(handle);
	}

	public async settle(
		handle: ExecutionHandleRef,
		terminal: {
			readonly state: ProcessTerminalState;
			readonly exitCode?: number;
			readonly signal?: string;
			readonly evidenceRef: RuntimeContentRef;
		},
	): Promise<ProcessSettlementResult> {
		const projection = this.project(handle);
		if (!projection.ok) return projection;
		if (isSettled(projection.state.state)) {
			return projection.state.state === terminal.state ? this.query(handle) : { ok: false, code: "terminal_state_immutable" };
		}
		const type: ProcessEvent["type"] = terminal.state === "lost"
			? "process.execution_lost"
			: terminal.state === "uncertain"
				? "process.execution_uncertain"
				: "process.execution_terminal";
		const next = await this.appendTransition(
			projection.state,
			type,
			terminal.state,
			undefined,
			undefined,
			undefined,
			terminal,
			projection.state.constraintSnapshotDigest,
		);
		if (!next.ok) return next;
		this.journal.releaseProcessCapacity(handle);
		return this.query(handle);
	}

	public mutate(handle: ExecutionHandleRef, operation: ManagedProcessMutationReceipt["operation"]): ProcessMutationResult {
		const projected = this.project(handle);
		if (!projected.ok) return projected;
		if (TERMINAL_STATES.has(projected.state.state)) return { ok: false, code: "terminal_state_immutable" };
		void operation;
		return { ok: false, code: "backend_mutation_unavailable" };
	}

	private project(handle: ExecutionHandleRef): ManagerProjectionResult {
		const events = [...this.journal.eventsFor(handle)].sort((left, right) => left.sequence - right.sequence);
		if (events.length === 0) return { ok: false, code: "process_not_found" };
		const projected = projectProcessEvents(events);
		if (!projected.ok) return { ok: false, code: "journal_invalid" };
		if (projected.state.spawnReceiptDigest) {
			let receipt: BackendSpawnReceipt | undefined;
			try {
				receipt = this.journal.spawnReceipt(handle);
			} catch {
				return { ok: false, code: "journal_invalid" };
			}
			if (!receipt || receipt.receiptDigest.digest !== projected.state.spawnReceiptDigest.digest) {
				return { ok: false, code: "journal_invalid" };
			}
			if (canonicalDigest(receipt.evidenceRef ?? null) !== canonicalDigest(projected.state.spawnEvidenceRef ?? null)) {
				return { ok: false, code: "journal_invalid" };
			}
		}
		return projected;
	}

	private async appendTransition(
		projection: ProcessProjection,
		type: ProcessEvent["type"],
		nextState: ProcessState,
		commandId: CommandId | undefined,
		spawnReceipt?: BackendSpawnReceipt,
		constraintSnapshot?: ExecutionConstraintSnapshot,
		terminal?: ProcessProjection["terminal"],
		constraintSnapshotDigest?: RuntimeDigest,
		outputCursor?: OutputCursor,
		outputSize?: number,
	): Promise<
		| { readonly ok: true; readonly state: ProcessProjection }
		| { readonly ok: false; readonly code: Extract<ProcessManagerErrorCode, "journal_unavailable" | "journal_invalid"> }
	> {
		const event = createProcessEvent({
			handle: projection.handle,
			sequence: projection.lastSequence + 1,
			revision: projection.revision + 1,
			type,
			previousState: projection.state,
			nextState,
			previousEventHash: projection.lastEventHash,
			...(commandId === undefined ? {} : { commandId }),
				...(spawnReceipt === undefined ? {} : {
				spawnReceiptDigest: spawnReceipt.receiptDigest,
				...(spawnReceipt.evidenceRef === undefined ? {} : { spawnEvidenceRef: spawnReceipt.evidenceRef }),
				}),
			...(constraintSnapshot === undefined && constraintSnapshotDigest === undefined ? {} : { constraintSnapshotDigest: constraintSnapshot?.snapshotDigest ?? constraintSnapshotDigest }),
			...(terminal === undefined ? {} : { terminal }),
			...(outputCursor === undefined ? {} : { outputCursor }),
			...(outputSize === undefined ? {} : { outputSize }),
		});
		try {
			await this.journal.append(event);
		} catch {
			return { ok: false, code: "journal_unavailable" };
		}
		const next = this.project(projection.handle);
		return next.ok ? next : { ok: false, code: "journal_invalid" };
	}

	private success(
		projection: ProcessProjection,
	): Extract<ProcessCreateResult, { readonly ok: true }> {
		return {
			ok: true,
			handle: projection.handle,
			summary: summaryFromProjection(projection),
		};
	}
}

export type AuditedProcessCreateResult =
	| ProcessCreateResult
	| {
			readonly ok: false;
			readonly code: "execution_constraint_denied" | "execution_constraint_unavailable" | "execution_constraint_invalid";
	  };

/** R6 production composition seam: decision first, ProcessManager second. */
export class AuditedProcessManager {
	private readonly manager: ProcessManager;
	private readonly providers: ExecutionConstraintProviders;

	public constructor(
		manager: ProcessManager,
		providers: ExecutionConstraintProviders = createBuiltinNoneExecutionDecisionProviders(),
	) {
		this.manager = manager;
		this.providers = providers;
	}

	public async create(
		request: ManagedProcessRequest,
		decisionInput: ExecutionConstraintInput,
		spawnOptions?: BackendSpawnOptions,
	): Promise<AuditedProcessCreateResult> {
		const handle = createHandle(request);
		const normalized: ExecutionConstraintInput = {
			...decisionInput,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			workspaceId: request.workspaceId,
			executionId: handle.executionId,
			attemptId: handle.attemptId,
			commandId: request.correlationId,
			requestDigest: request.requestDigest,
		};
		if (spawnOptions?.constraintSnapshot !== undefined) {
			if (!validateExecutionConstraintSnapshot(normalized, spawnOptions.constraintSnapshot)) {
				return { ok: false, code: "execution_constraint_invalid" };
			}
			return this.manager.create(request, spawnOptions.constraintSnapshot, normalized, spawnOptions);
		}
		const durableSnapshot = this.manager.constraintSnapshot(request.correlationId);
		if (durableSnapshot !== undefined) {
			if (!validateExecutionConstraintSnapshot(normalized, durableSnapshot)) {
				return { ok: false, code: "execution_constraint_invalid" };
			}
			return this.manager.create(request, durableSnapshot, normalized, spawnOptions);
		}
		const decision = await evaluateExecutionConstraints(normalized, this.providers);
		if (!decision.ok) {
			if (decision.code === "constraint_denied") return { ok: false, code: "execution_constraint_denied" };
			if (decision.code === "constraint_provider_unavailable") return { ok: false, code: "execution_constraint_unavailable" };
			return { ok: false, code: "execution_constraint_invalid" };
		}
		return this.manager.create(request, decision.snapshot, normalized, spawnOptions);
	}
}

function createHandle(request: ManagedProcessRequest): ExecutionHandleRef {
	const identityDigest = canonicalDigest({ commandId: request.correlationId, requestDigest: request.requestDigest });
	return {
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		workspaceId: request.workspaceId,
		sessionId: request.sessionId,
		hostGeneration: request.hostGeneration,
		sessionGeneration: request.sessionGeneration,
		executionId: createRuntimeId("execution", identityDigest),
		attemptId: createRuntimeId("attempt", `${identityDigest}_1`),
		revision: 0,
		requestDigest: request.requestDigest,
	};
}

function handleFromEvent(event: ProcessEvent): ExecutionHandleRef {
	return {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		workspaceId: event.workspaceId,
		sessionId: event.sessionId,
		hostGeneration: event.hostGeneration,
		sessionGeneration: event.sessionGeneration,
		executionId: event.executionId,
		attemptId: event.attemptId,
		revision: event.revision,
		requestDigest: event.requestDigest,
	};
}

function processKey(value: Pick<ExecutionHandleRef, "authorityId" | "tenantId" | "workspaceId" | "sessionId" | "hostGeneration" | "sessionGeneration" | "executionId" | "attemptId">): string {
	return JSON.stringify([
		value.authorityId,
		value.tenantId,
		value.workspaceId,
		value.sessionId,
		value.hostGeneration,
		value.sessionGeneration,
		value.executionId,
		value.attemptId,
	]);
}

function sameRequestScope(
	intent: ProcessEvent,
	request: ManagedProcessRequest,
	constraintSnapshot?: ExecutionConstraintSnapshot,
): boolean {
	return (
		intent.requestDigest.digest === request.requestDigest.digest &&
		intent.managedRequestDigest?.digest === completeRequestDigest(request).digest &&
		intent.authorityId === request.authorityId &&
		intent.tenantId === request.tenantId &&
		intent.workspaceId === request.workspaceId &&
		intent.sessionId === request.sessionId &&
		intent.hostGeneration === request.hostGeneration &&
		intent.sessionGeneration === request.sessionGeneration &&
		(intent.constraintSnapshotDigest?.digest ?? undefined) === constraintSnapshot?.snapshotDigest.digest
	);
}

function completeRequestDigest(request: ManagedProcessRequest): RuntimeDigest {
	return {
		algorithm: "sha256",
		digest: canonicalDigest(request) as RuntimeDigest["digest"],
	};
}

function spawnClaimDigest(
	handle: ExecutionHandleRef,
	request: ManagedProcessRequest,
	constraintSnapshot?: ExecutionConstraintSnapshot,
	constraintInput?: ExecutionConstraintInput,
): RuntimeDigest {
	return {
		algorithm: "sha256",
		digest: canonicalDigest({
			handle,
			requestDigest: request.requestDigest,
			commandRef: request.commandRef,
			cwdRef: request.cwdRef,
			backend: request.backend,
			executionMode: request.executionMode,
			...(constraintSnapshot === undefined ? {} : { constraintSnapshotDigest: constraintSnapshot.snapshotDigest }),
			...(constraintInput === undefined ? {} : { constraintInputDigest: runtimeDigest(constraintInput) }),
		}) as RuntimeDigest["digest"],
	};
}

function isSettled(state: ProcessState): boolean {
	return TERMINAL_STATES.has(state);
}

function isStarted(state: ProcessState): boolean {
	return state === "running" || state === "backgrounded";
}

function isOutputCursor(value: OutputCursor): boolean {
	return Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
		Number.isSafeInteger(value.byteOffset) && value.byteOffset >= 0;
}

function summaryFromProjection(projection: ProcessProjection): ManagedProcessSummary {
	const terminal = projection.terminal;
	const settled = isSettled(projection.state);
	return {
		handle: projection.handle,
		state: projection.state,
		outputCursor: projection.outputCursor,
		outputSize: projection.outputSize,
		capabilities: {
			canWrite: !settled,
			canEof: !settled,
			canResize: !settled && projection.backend === "pty",
			canStop: !settled,
			canReadOutput: true,
		},
		...(terminal === undefined ? {} : { terminal }),
	};
}
