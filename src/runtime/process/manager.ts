/** Host-owned managed process coordinator。
 *
 * 本模块只编排 durable process journal 与 backend port。backend receipt 是
 * 幂等重试的边界，public result 只暴露 safe handle/summary，不暴露 PID、路径
 * 或原始 command。
 */

import { canonicalDigest } from "../protocol/canonical-json.ts";
import type { RuntimeContentRef, RuntimeDigest } from "../protocol/foundation.ts";
import type { CommandId } from "../protocol/ids.ts";
import { createRuntimeId } from "../protocol/ids.ts";
import { createProcessEvent, type ProcessEvent } from "./events.ts";
import {
	projectProcessEvents,
	type ProcessProjection,
} from "./state-machine.ts";
import type {
	ExecutionHandleRef,
	ManagedProcessMutationReceipt,
	ManagedProcessRequest,
	ManagedProcessSummary,
	ProcessBackendKind,
	ProcessState,
} from "./types.ts";

export interface BackendSpawnReceipt {
	readonly receiptDigest: RuntimeDigest;
	readonly evidenceRef?: RuntimeContentRef;
}

export interface BackendSpawnInput {
	readonly handle: ExecutionHandleRef;
	readonly request: ManagedProcessRequest;
	readonly spawnClaimDigest: RuntimeDigest;
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
	recordSpawnClaim(handle: ExecutionHandleRef): void;
	hasSpawnClaim(handle: ExecutionHandleRef): boolean;
	spawnReceipt(handle: ExecutionHandleRef): BackendSpawnReceipt | undefined;
	recordSpawnReceipt(handle: ExecutionHandleRef, receipt: BackendSpawnReceipt): void;
}

export type ProcessManagerErrorCode =
	| "command_id_conflict"
	| "process_not_found"
	| "journal_invalid"
	| "journal_unavailable"
	| "backend_spawn_failed"
	| "uncertain_outcome"
	| "terminal_state_immutable"
	| "backend_mutation_unavailable";

export type ProcessCreateResult =
	| { readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: ManagedProcessSummary }
	| { readonly ok: false; readonly code: ProcessManagerErrorCode };

export type ProcessQueryResult =
	| { readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: ManagedProcessSummary }
	| { readonly ok: false; readonly code: Extract<ProcessManagerErrorCode, "process_not_found" | "journal_invalid"> };

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

	public constructor(journal: ProcessJournal, backend: BackendSpawnPort) {
		this.journal = journal;
		this.backend = backend;
	}

	public async create(request: ManagedProcessRequest): Promise<ProcessCreateResult> {
		const intent = this.journal.findIntent(request.correlationId);
		let handle: ExecutionHandleRef;
		if (intent) {
			if (!sameRequestScope(intent, request)) return { ok: false, code: "command_id_conflict" };
			handle = handleFromEvent(intent);
		} else {
			handle = createHandle(request);
			const requested = createProcessEvent({
				handle,
				sequence: 0,
				revision: 0,
				type: "process.execution_requested",
				previousState: null,
				nextState: "queued",
				previousEventHash: null,
				commandId: request.correlationId,
			});
			try {
				await this.journal.append(requested);
			} catch {
				return { ok: false, code: "journal_unavailable" };
			}
		}

		let projectionResult = this.project(handle);
		if (!projectionResult.ok) return { ok: false, code: projectionResult.code };
		if (isSettled(projectionResult.state.state) || isStarted(projectionResult.state.state)) {
			return this.success(projectionResult.state, request.backend);
		}

		if (projectionResult.state.state === "queued") {
			const starting = await this.appendTransition(
				projectionResult.state,
				"process.execution_starting",
				"starting",
				request.correlationId,
			);
			if (!starting.ok) return starting;
			projectionResult = starting;
		}

		if (projectionResult.state.state !== "starting") {
			return { ok: false, code: "journal_invalid" };
		}

		const current = projectionResult.state;
		try {
			if (!this.journal.hasSpawnClaim(current.handle)) this.journal.recordSpawnClaim(current.handle);
		} catch {
			return { ok: false, code: "journal_unavailable" };
		}

		let receipt = this.journal.spawnReceipt(current.handle);
		if (!receipt) {
			try {
				receipt = await this.backend.spawn({
					handle: current.handle,
					request,
					spawnClaimDigest: spawnClaimDigest(current.handle, request),
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
			return this.success(afterReceipt.state, request.backend);
		}
		const finalType = request.executionMode === "background"
			? "process.execution_backgrounded"
			: "process.execution_started";
		const finalState = request.executionMode === "background" ? "backgrounded" : "running";
		const started = await this.appendTransition(afterReceipt.state, finalType, finalState, request.correlationId);
		if (!started.ok) {
			return started.code === "journal_unavailable" ? { ok: false, code: "uncertain_outcome" } : started;
		}
		return this.success(started.state, request.backend);
	}

	public query(handle: ExecutionHandleRef, backend: ProcessBackendKind = "pipe"): ProcessQueryResult {
		const projected = this.project(handle);
		if (!projected.ok) return projected;
		return this.success(projected.state, backend);
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
		return projected.ok ? projected : { ok: false, code: "journal_invalid" };
	}

	private async appendTransition(
		projection: ProcessProjection,
		type: ProcessEvent["type"],
		nextState: ProcessState,
		commandId: CommandId,
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
			commandId,
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
		backend: ProcessBackendKind,
	): Extract<ProcessCreateResult, { readonly ok: true }> {
		return {
			ok: true,
			handle: projection.handle,
			summary: summaryFromProjection(projection, backend),
		};
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

function sameRequestScope(intent: ProcessEvent, request: ManagedProcessRequest): boolean {
	return (
		intent.requestDigest.digest === request.requestDigest.digest &&
		intent.authorityId === request.authorityId &&
		intent.tenantId === request.tenantId &&
		intent.workspaceId === request.workspaceId &&
		intent.sessionId === request.sessionId &&
		intent.hostGeneration === request.hostGeneration &&
		intent.sessionGeneration === request.sessionGeneration
	);
}

function spawnClaimDigest(handle: ExecutionHandleRef, request: ManagedProcessRequest): RuntimeDigest {
	return {
		algorithm: "sha256",
		digest: canonicalDigest({
			handle,
			requestDigest: request.requestDigest,
			commandRef: request.commandRef,
			cwdRef: request.cwdRef,
			backend: request.backend,
			executionMode: request.executionMode,
		}) as RuntimeDigest["digest"],
	};
}

function isSettled(state: ProcessState): boolean {
	return TERMINAL_STATES.has(state);
}

function isStarted(state: ProcessState): boolean {
	return state === "running" || state === "backgrounded";
}

function summaryFromProjection(projection: ProcessProjection, backend: ProcessBackendKind): ManagedProcessSummary {
	const terminal = projection.terminal
		? {
				...projection.terminal,
				evidenceRef: contentRef("receipt", projection.lastEventHash),
			}
		: undefined;
	const settled = isSettled(projection.state);
	return {
		handle: projection.handle,
		state: projection.state,
		outputCursor: projection.outputCursor,
		outputSize: projection.outputSize,
		capabilities: {
			canWrite: !settled,
			canEof: !settled,
			canResize: !settled && backend === "pty",
			canStop: !settled,
			canReadOutput: true,
		},
		...(terminal === undefined ? {} : { terminal }),
	};
}

function contentRef(subjectKind: RuntimeContentRef["subjectKind"], digest: RuntimeDigest | null): RuntimeContentRef {
	return {
		subjectKind,
		digest: digest ?? {
			algorithm: "sha256",
			digest: canonicalDigest({ subjectKind, empty: true }) as RuntimeDigest["digest"],
		},
		mediaType: "application/json",
		size: 0,
	};
}
