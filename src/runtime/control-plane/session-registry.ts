/** replacement 的 teardown/rebind 顺序与旧 handle fencing。 */

import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type EventCursor } from "../protocol/v3/events.ts";
import {
	isRuntimeId,
	type CommandId,
	type CompositionReceiptId,
	type ReceiptId,
	type RuntimeInstanceId,
	type SessionId,
} from "../protocol/v3/ids.ts";
import type { ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type { ControlPlaneSessionHandle, SessionBootstrap } from "./types.ts";
import { isApprovedPlanForkSeed } from "../modes/plan/schema.ts";
import type { ApprovedPlanForkSeed } from "../modes/plan/types.ts";

type FailedControlPlaneResult = Extract<ControlPlaneResult<never>, { ok: false }>;

function requireFailure<T>(result: ControlPlaneResult<T>): FailedControlPlaneResult {
	if (result.ok) throw new TypeError("expected a failed control-plane result");
	return result;
}

export interface ManagedSessionRuntime {
	sessionId: SessionId;
	head(): EventCursor | null;
	/** Production candidate 必须提供不可变 authority/composition/fencing identity。 */
	authorityBinding?(): CandidateAuthorityBinding;
	teardown(reason: "replacement" | "shutdown"): Promise<ControlPlaneResult<void>>;
}

/** Candidate 尚未成为 authority；这里只暴露 durable transition 所需的不可变身份。 */
export interface CandidateAuthorityBinding {
	readonly runtimeId: RuntimeInstanceId;
	readonly generation: number;
	readonly compositionReceiptId: CompositionReceiptId;
	readonly compositionDigest: string;
	readonly fencingIntentDigest: string;
}

export interface RuntimeGenerationTransitionContext {
	readonly sessionId: SessionId;
	readonly recovery: SessionBootstrap["recovery"];
	readonly previous: CandidateAuthorityBinding | null;
	readonly candidate: CandidateAuthorityBinding;
}

export interface PreparedRuntimeGenerationTransition {
	readonly replacementId: CommandId;
	readonly candidateRuntimeId: RuntimeInstanceId;
	readonly candidateGeneration: number;
	readonly durableCursor: EventCursor;
}

export interface RuntimeWriterFencingReceipt {
	readonly candidateRuntimeId: RuntimeInstanceId;
	readonly candidateGeneration: number;
	readonly receiptId: ReceiptId;
	readonly receiptDigest: string;
}

export interface ActivatedRuntimeGenerationTransition {
	readonly replacementId: CommandId;
	readonly activeRuntimeId: RuntimeInstanceId;
	readonly activeGeneration: number;
	readonly durableCursor: EventCursor;
}

export type RuntimeGenerationFailurePhase = "writer_fencing" | "activation" | "authority_swap" | "old_runtime_drain";

export interface RuntimeGenerationFailureTransition extends RuntimeGenerationTransitionContext {
	readonly prepared: PreparedRuntimeGenerationTransition;
	readonly phase: RuntimeGenerationFailurePhase;
	readonly errorCode: string;
	readonly errorDigest: string;
	readonly outcomeCertain: boolean;
}

/**
 * Production adapter 必须把 prepare/activate/fail 映射到同一 canonical authority stream。
 * rotateWriterFence 返回 adapter-owned receipt；raw fencing token 不得穿过该端口。
 */
export interface RuntimeGenerationTransitionPort {
	prepare(
		context: RuntimeGenerationTransitionContext,
	): Promise<ControlPlaneResult<PreparedRuntimeGenerationTransition>>;
	rotateWriterFence(
		context: RuntimeGenerationTransitionContext & { readonly prepared: PreparedRuntimeGenerationTransition },
	): Promise<ControlPlaneResult<RuntimeWriterFencingReceipt>>;
	activate(
		context: RuntimeGenerationTransitionContext & {
			readonly prepared: PreparedRuntimeGenerationTransition;
			readonly fencing: RuntimeWriterFencingReceipt;
		},
	): Promise<ControlPlaneResult<ActivatedRuntimeGenerationTransition>>;
	recordFailure(failure: RuntimeGenerationFailureTransition): Promise<ControlPlaneResult<void>>;
}

export interface SessionRuntimeRegistryOptions {
	readonly clock?: () => Date;
	readonly transition?: RuntimeGenerationTransitionPort;
	readonly requireDurableTransition?: boolean;
	/** 仅用于 deterministic fixture/fault injection；production 默认 randomUUID。 */
	readonly handleIdFactory?: () => string;
}

export interface SessionRuntimeFactoryPort {
	start(): Promise<ControlPlaneResult<ManagedSessionRuntime>>;
	resume(sessionId: SessionId): Promise<ControlPlaneResult<ManagedSessionRuntime>>;
	fork(
		parentSessionId: SessionId,
		parentCursor: EventCursor,
		goalMode: "continue_existing_goal" | "create_child_goal",
	): Promise<ControlPlaneResult<ManagedSessionRuntime>>;
}

export interface ApprovedPlanSessionRuntimeFactoryPort extends SessionRuntimeFactoryPort {
	forkApprovedPlan(seed: ApprovedPlanForkSeed): Promise<ControlPlaneResult<ManagedSessionRuntime>>;
}

interface ActiveRuntime {
	runtime: ManagedSessionRuntime;
	handle: ControlPlaneSessionHandle;
	authorityBinding?: CandidateAuthorityBinding;
}

async function teardownRuntime(
	runtime: ManagedSessionRuntime,
	reason: "replacement" | "shutdown",
): Promise<ControlPlaneResult<void>> {
	try {
		return await runtime.teardown(reason);
	} catch (error) {
		return controlPlaneFailure(
			"recovery_required",
			"session runtime teardown threw before a terminal receipt was observed",
			false,
			{ errorName: error instanceof Error ? error.name : "UnknownError" },
			"uncertain",
		);
	}
}

function runtimeHead(runtime: ManagedSessionRuntime): EventCursor | null {
	try {
		return runtime.head();
	} catch {
		return null;
	}
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function validDigest(value: string): boolean {
	return DIGEST_PATTERN.test(value);
}

function inspectAuthorityBinding(
	runtime: ManagedSessionRuntime,
): ControlPlaneResult<CandidateAuthorityBinding | undefined> {
	if (!runtime.authorityBinding) return { ok: true, value: undefined };
	let binding: CandidateAuthorityBinding;
	try {
		binding = runtime.authorityBinding();
	} catch (error) {
		return controlPlaneFailure("adapter_contract_violation", "candidate authority binding inspection threw", false, {
			errorName: error instanceof Error ? error.name : "UnknownError",
		});
	}
	if (
		!isRuntimeId(binding.runtimeId, "runtime") ||
		!Number.isSafeInteger(binding.generation) ||
		binding.generation <= 0 ||
		!isRuntimeId(binding.compositionReceiptId, "compositionReceipt") ||
		!validDigest(binding.compositionDigest) ||
		!validDigest(binding.fencingIntentDigest)
	) {
		return controlPlaneFailure("adapter_contract_violation", "candidate authority binding is invalid");
	}
	return { ok: true, value: { ...binding } };
}

function validPreparedTransition(
	prepared: PreparedRuntimeGenerationTransition,
	candidate: CandidateAuthorityBinding,
): boolean {
	return (
		isRuntimeId(prepared.replacementId, "command") &&
		prepared.candidateRuntimeId === candidate.runtimeId &&
		prepared.candidateGeneration === candidate.generation &&
		prepared.durableCursor.stream.scope === "authority_tenant"
	);
}

function validFencingReceipt(
	receipt: RuntimeWriterFencingReceipt,
	candidate: CandidateAuthorityBinding,
): boolean {
	return (
		receipt.candidateRuntimeId === candidate.runtimeId &&
		receipt.candidateGeneration === candidate.generation &&
		isRuntimeId(receipt.receiptId, "receipt") &&
		validDigest(receipt.receiptDigest)
	);
}

function validActivatedTransition(
	activated: ActivatedRuntimeGenerationTransition,
	prepared: PreparedRuntimeGenerationTransition,
	candidate: CandidateAuthorityBinding,
): boolean {
	return (
		activated.replacementId === prepared.replacementId &&
		activated.activeRuntimeId === candidate.runtimeId &&
		activated.activeGeneration === candidate.generation &&
		activated.durableCursor.stream.scope === "authority_tenant" &&
		sameRuntimeEventStream(activated.durableCursor.stream, prepared.durableCursor.stream) &&
		activated.durableCursor.sequence > prepared.durableCursor.sequence
	);
}

export interface FailedSessionReplacementProjection {
	status: "paused" | "stopped";
	phase: "teardown_failed" | "create_failed";
	previousSessionId: SessionId | null;
	previousHead: EventCursor | null;
	invalidatedHandleGeneration: number | null;
	candidateSessionId: SessionId | null;
	candidateHead: EventCursor | null;
	activeHandleGeneration: number | null;
	attemptedRecovery: SessionBootstrap["recovery"];
	errorCode: string;
	errorDigest: string;
	recordedAt: string;
}

export class SessionRuntimeRegistry {
	readonly #factory: SessionRuntimeFactoryPort;
	readonly #transition: RuntimeGenerationTransitionPort | undefined;
	readonly #requireDurableTransition: boolean;
	#active: ActiveRuntime | undefined;
	#generation = 0;
	#replacing = false;
	#failedReplacement: FailedSessionReplacementProjection | undefined;
	#retiredRuntime: ManagedSessionRuntime | undefined;
	#preparedRuntime: ManagedSessionRuntime | undefined;
	#serial: Promise<void> = Promise.resolve();
	readonly #clock: () => Date;
	readonly #handleIdFactory: () => string;
	#durableReconciliationRequired = false;

	public constructor(
		factory: SessionRuntimeFactoryPort,
		optionsOrClock: SessionRuntimeRegistryOptions | (() => Date) = {},
	) {
		const options = typeof optionsOrClock === "function" ? { clock: optionsOrClock } : optionsOrClock;
		if (options.requireDurableTransition === true && !options.transition) {
			throw new TypeError("production session runtime registry requires durable generation transitions");
		}
		this.#factory = factory;
		this.#transition = options.transition;
		this.#requireDurableTransition = options.requireDurableTransition ?? false;
		this.#clock = options.clock ?? (() => new Date());
		this.#handleIdFactory = options.handleIdFactory ?? (() => `handle_${randomUUID()}`);
	}

	#exclusive<T>(operation: () => Promise<ControlPlaneResult<T>>): Promise<ControlPlaneResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#createHandle(sessionId: SessionId, authorityGeneration?: number): ControlPlaneSessionHandle {
		const generation = authorityGeneration ?? this.#generation + 1;
		if (!Number.isSafeInteger(generation) || generation <= this.#generation) {
			throw new TypeError("session handle generation did not advance");
		}
		const handleId = this.#handleIdFactory();
		if (typeof handleId !== "string" || handleId.length === 0 || handleId.length > 256) {
			throw new TypeError("session handle factory returned an invalid id");
		}
		this.#generation = generation;
		return { handleId, sessionId, generation };
	}

	#sameHandle(left: ControlPlaneSessionHandle, right: ControlPlaneSessionHandle): boolean {
		return left.handleId === right.handleId && left.sessionId === right.sessionId && left.generation === right.generation;
	}

	public validate(handle: ControlPlaneSessionHandle): ControlPlaneResult<ManagedSessionRuntime> {
		if (this.#replacing) return controlPlaneFailure("session_replacing", "session runtime is being replaced", true);
		if (!this.#active || !this.#sameHandle(this.#active.handle, handle)) {
			return controlPlaneFailure("stale_session_handle", "session handle is no longer current", false);
		}
		if (this.#failedReplacement) {
			return controlPlaneFailure(
				"recovery_required",
				"session runtime replacement requires explicit reconciliation",
				false,
				{ phase: this.#failedReplacement.phase },
			);
		}
		return { ok: true, value: this.#active.runtime };
	}

	public current(): { runtime: ManagedSessionRuntime; handle: ControlPlaneSessionHandle } | undefined {
		return this.#active ? { runtime: this.#active.runtime, handle: { ...this.#active.handle } } : undefined;
	}

	/** replacement 失败后的只读诊断投影；不暴露已失效 runtime handle。 */
	public replacementFailure(): FailedSessionReplacementProjection | undefined {
		return this.#failedReplacement ? structuredClone(this.#failedReplacement) : undefined;
	}

	/**
	 * 显式 reconcile replacement failure。teardown 不确定时会重试 teardown；只有确认
	 * terminal 后才重新开放 replacement gate。该动作不恢复旧 handle。
	 */
	public reconcileReplacementFailure(): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(async () => {
			const failed = this.#failedReplacement;
			if (!failed) return { ok: true, value: undefined };
			if (this.#durableReconciliationRequired) {
				return controlPlaneFailure(
					"recovery_required",
					"durable runtime generation state requires authority-stream reconciliation",
					false,
					{ phase: failed.phase },
					"uncertain",
				);
			}
			if (this.#preparedRuntime) {
				const settled = await teardownRuntime(this.#preparedRuntime, "replacement");
				if (!settled.ok) return settled;
				this.#preparedRuntime = undefined;
			}
			if (failed.phase === "teardown_failed") {
				const retired = this.#retiredRuntime;
				if (!retired) return controlPlaneFailure("recovery_required", "failed replacement lost its retired runtime", false);
				const settled = await teardownRuntime(retired, "replacement");
				if (!settled.ok) return settled;
			}
			this.#retiredRuntime = undefined;
			this.#failedReplacement = undefined;
			return { ok: true, value: undefined };
		});
	}

	public start(): Promise<ControlPlaneResult<SessionBootstrap>> {
		return this.#replace("new", () => this.#factory.start());
	}

	public resume(sessionId: SessionId): Promise<ControlPlaneResult<SessionBootstrap>> {
		return this.#replace("resumed", () => this.#factory.resume(sessionId));
	}

	public fork(
		parentSessionId: SessionId,
		parentCursor: EventCursor,
		goalMode: "continue_existing_goal" | "create_child_goal",
	): Promise<ControlPlaneResult<SessionBootstrap>> {
		return this.#replace("forked", () => this.#factory.fork(parentSessionId, parentCursor, goalMode));
	}

	public forkApprovedPlan(seed: ApprovedPlanForkSeed): Promise<ControlPlaneResult<SessionBootstrap>> {
		if (!isApprovedPlanForkSeed(seed)) {
			return Promise.resolve(controlPlaneFailure("invalid_request", "approved-plan fork seed is invalid"));
		}
		if (!("forkApprovedPlan" in this.#factory) || typeof this.#factory.forkApprovedPlan !== "function") {
			return Promise.resolve(controlPlaneFailure(
				"unsupported_feature",
				"session runtime factory does not support approved-plan forks",
			));
		}
		const factory = this.#factory as ApprovedPlanSessionRuntimeFactoryPort;
		return this.#replace("forked", () => factory.forkApprovedPlan(seed));
	}

	#replace(
		recovery: SessionBootstrap["recovery"],
		create: () => Promise<ControlPlaneResult<ManagedSessionRuntime>>,
	): Promise<ControlPlaneResult<SessionBootstrap>> {
		return this.#exclusive(async () => {
			if (this.#failedReplacement) {
				return controlPlaneFailure(
					"recovery_required",
					"previous session replacement failure requires explicit reconciliation",
					false,
					{ phase: this.#failedReplacement.phase },
				);
			}
			this.#replacing = true;
			const previous = this.#active;
			try {
				// create/probe 失败仍在 durable prepare 之前，旧 authority/handle 可原样恢复。
				let created: ControlPlaneResult<ManagedSessionRuntime>;
				try {
					created = await create();
				} catch (error) {
					return controlPlaneFailure("adapter_unavailable", "session runtime candidate preparation threw", true, {
						errorName: error instanceof Error ? error.name : "UnknownError",
					});
				}
				if (!created.ok) return created;
				const candidate = created.value;
				if (previous && candidate === previous.runtime) {
					return controlPlaneFailure("adapter_contract_violation", "replacement candidate reused the active runtime instance");
				}

				let candidateHead: EventCursor | null;
				try {
					candidateHead = candidate.head();
				} catch (error) {
					return this.#cleanupPreActivationCandidate(
						candidate,
						previous,
						recovery,
						requireFailure(controlPlaneFailure("adapter_contract_violation", "session runtime candidate head inspection threw", false, {
							errorName: error instanceof Error ? error.name : "UnknownError",
						})),
						null,
					);
				}
				if (
					candidateHead &&
					(candidateHead.stream.scope !== "session" || candidateHead.stream.sessionId !== candidate.sessionId)
				) {
					return this.#cleanupPreActivationCandidate(
						candidate,
						previous,
						recovery,
						requireFailure(controlPlaneFailure("adapter_contract_violation", "session runtime candidate head is bound to another session")),
						candidateHead,
					);
				}

				const inspectedBinding = inspectAuthorityBinding(candidate);
				if (!inspectedBinding.ok) {
					return this.#cleanupPreActivationCandidate(
						candidate,
						previous,
						recovery,
						inspectedBinding,
						candidateHead,
					);
				}
				const candidateBinding = inspectedBinding.value;
				if (this.#transition || this.#requireDurableTransition) {
					if (!this.#transition || !candidateBinding) {
						return this.#cleanupPreActivationCandidate(
							candidate,
							previous,
							recovery,
							requireFailure(controlPlaneFailure(
								"adapter_contract_violation",
								"durable runtime generation transition requires a candidate authority binding",
							)),
							candidateHead,
						);
					}
					const previousBinding = previous?.authorityBinding ?? null;
					if (
						(previous && !previousBinding) ||
						candidateBinding.generation !== (previousBinding?.generation ?? 0) + 1 ||
						candidateBinding.runtimeId === previousBinding?.runtimeId
					) {
						return this.#cleanupPreActivationCandidate(
							candidate,
							previous,
							recovery,
							requireFailure(controlPlaneFailure(
								"adapter_contract_violation",
								"candidate authority binding does not extend the active generation",
							)),
							candidateHead,
						);
					}
					const transitionContext: RuntimeGenerationTransitionContext = {
						sessionId: candidate.sessionId,
						recovery,
						previous: previousBinding,
						candidate: candidateBinding,
					};
					const prepared = await this.#callTransition(
						"prepare",
						() => this.#transition!.prepare(transitionContext),
					);
					if (!prepared.ok) {
						if (prepared.effect === "uncertain") {
							this.#freezeUncertainTransition(candidate, previous, recovery, prepared, candidateHead);
							return prepared;
						}
						return this.#cleanupPreActivationCandidate(
							candidate,
							previous,
							recovery,
							prepared,
							candidateHead,
						);
					}
					if (!validPreparedTransition(prepared.value, candidateBinding)) {
						const invalid = requireFailure(controlPlaneFailure(
							"recovery_required",
							"durable runtime preparation returned an uncorrelated receipt",
							false,
							undefined,
							"uncertain",
						));
						this.#freezeUncertainTransition(candidate, previous, recovery, invalid, candidateHead);
						return invalid;
					}

					const fencing = await this.#callTransition(
						"writer fencing",
						() => this.#transition!.rotateWriterFence({ ...transitionContext, prepared: prepared.value }),
					);
					if (!fencing.ok) {
						return this.#settlePreparedFailure({
							candidate,
							candidateHead,
							previous,
							recovery,
							transitionContext,
							prepared: prepared.value,
							phase: "writer_fencing",
							failure: fencing,
						});
					}
					if (!validFencingReceipt(fencing.value, candidateBinding)) {
						return this.#settlePreparedFailure({
							candidate,
							candidateHead,
							previous,
							recovery,
							transitionContext,
							prepared: prepared.value,
							phase: "writer_fencing",
							failure: requireFailure(controlPlaneFailure(
								"recovery_required",
								"writer fencing returned an uncorrelated receipt",
								false,
								undefined,
								"uncertain",
							)),
						});
					}

					const activated = await this.#callTransition(
						"activation",
						() => this.#transition!.activate({
							...transitionContext,
							prepared: prepared.value,
							fencing: fencing.value,
						}),
					);
					if (!activated.ok) {
						return this.#settlePreparedFailure({
							candidate,
							candidateHead,
							previous,
							recovery,
							transitionContext,
							prepared: prepared.value,
							phase: "activation",
							failure: activated,
						});
					}
					if (!validActivatedTransition(activated.value, prepared.value, candidateBinding)) {
						return this.#settlePreparedFailure({
							candidate,
							candidateHead,
							previous,
							recovery,
							transitionContext,
							prepared: prepared.value,
							phase: "activation",
							failure: requireFailure(controlPlaneFailure(
								"recovery_required",
								"runtime activation returned an uncorrelated durable receipt",
								false,
								undefined,
								"uncertain",
							)),
						});
					}

					// Durable activation 是唯一 commit 点；从这里开始旧 handle 永久失效。
					this.#active = undefined;
					let handle: ControlPlaneSessionHandle;
					try {
						handle = this.#createHandle(candidate.sessionId, candidateBinding.generation);
					} catch (error) {
						await this.#recordPostActivationFailure(
							transitionContext,
							prepared.value,
							"authority_swap",
							"internal_error",
							"in-process authority swap failed after durable activation",
						);
						this.#preparedRuntime = candidate;
						this.#retiredRuntime = previous?.runtime;
						this.#durableReconciliationRequired = true;
						this.#failedReplacement = this.#failureProjection(
							previous,
							recovery,
							"create_failed",
							"internal_error",
							"in-process authority swap failed after durable activation",
							candidate,
							candidateHead,
						);
						return controlPlaneFailure("recovery_required", "runtime activated durably but local authority swap failed", false, {
							errorName: error instanceof Error ? error.name : "UnknownError",
						}, "uncertain");
					}
					this.#active = { runtime: candidate, handle, authorityBinding: candidateBinding };
					if (previous) {
						const tornDown = await teardownRuntime(previous.runtime, "replacement");
						if (!tornDown.ok) {
							await this.#recordPostActivationFailure(
								transitionContext,
								prepared.value,
								"old_runtime_drain",
								tornDown.error.code,
								tornDown.error.message,
							);
							this.#retiredRuntime = previous.runtime;
							this.#durableReconciliationRequired = true;
							this.#failedReplacement = this.#failureProjection(
								previous,
								recovery,
								"teardown_failed",
								tornDown.error.code,
								tornDown.error.message,
								candidate,
								candidateHead,
								this.#active,
							);
							return controlPlaneFailure(
								"recovery_required",
								"new runtime is authoritative but old runtime drain was not confirmed",
								false,
								undefined,
								"uncertain",
							);
						}
					}
					return this.#bootstrap(candidate, handle, candidateHead, recovery);
				}

				// Isolated fixture compatibility：无 transition 时沿用纯进程内 replacement。
				const handle = this.#createHandle(candidate.sessionId);
				this.#active = { runtime: candidate, handle };
				if (previous) {
					const tornDown = await teardownRuntime(previous.runtime, "replacement");
					if (!tornDown.ok) {
						this.#retiredRuntime = previous.runtime;
						this.#failedReplacement = this.#failureProjection(
							previous,
							recovery,
							"teardown_failed",
							tornDown.error.code,
							tornDown.error.message,
							candidate,
							candidateHead,
							this.#active,
						);
						return tornDown;
					}
				}
				return this.#bootstrap(candidate, handle, candidateHead, recovery);
			} finally {
				this.#replacing = false;
			}
		});
	}

	#bootstrap(
		runtime: ManagedSessionRuntime,
		handle: ControlPlaneSessionHandle,
		head: EventCursor | null,
		recovery: SessionBootstrap["recovery"],
	): ControlPlaneResult<SessionBootstrap> {
		return { ok: true, value: { sessionId: runtime.sessionId, handle: { ...handle }, head, recovery } };
	}

	async #callTransition<T>(
		operation: string,
		invoke: () => Promise<ControlPlaneResult<T>>,
	): Promise<ControlPlaneResult<T>> {
		try {
			return await invoke();
		} catch (error) {
			return controlPlaneFailure(
				"recovery_required",
				`runtime generation ${operation} threw before its durable outcome was confirmed`,
				false,
				{ errorName: error instanceof Error ? error.name : "UnknownError" },
				"uncertain",
			);
		}
	}

	async #cleanupPreActivationCandidate(
		candidate: ManagedSessionRuntime,
		previous: ActiveRuntime | undefined,
		recovery: SessionBootstrap["recovery"],
		failure: FailedControlPlaneResult,
		candidateHead: EventCursor | null,
	): Promise<ControlPlaneResult<SessionBootstrap>> {
		const cleanup = await teardownRuntime(candidate, "replacement");
		if (cleanup.ok) return failure;
		this.#preparedRuntime = candidate;
		this.#failedReplacement = this.#failureProjection(
			previous,
			recovery,
			"create_failed",
			cleanup.error.code,
			cleanup.error.message,
			candidate,
			candidateHead,
		);
		return cleanup;
	}

	#freezeUncertainTransition(
		candidate: ManagedSessionRuntime,
		previous: ActiveRuntime | undefined,
		recovery: SessionBootstrap["recovery"],
		failure: FailedControlPlaneResult,
		candidateHead: EventCursor | null,
	): void {
		this.#preparedRuntime = candidate;
		this.#durableReconciliationRequired = true;
		this.#failedReplacement = this.#failureProjection(
			previous,
			recovery,
			"create_failed",
			failure.error.code,
			failure.error.message,
			candidate,
			candidateHead,
		);
	}

	async #settlePreparedFailure(options: {
		candidate: ManagedSessionRuntime;
		candidateHead: EventCursor | null;
		previous: ActiveRuntime | undefined;
		recovery: SessionBootstrap["recovery"];
		transitionContext: RuntimeGenerationTransitionContext;
		prepared: PreparedRuntimeGenerationTransition;
		phase: Extract<RuntimeGenerationFailurePhase, "writer_fencing" | "activation">;
		failure: FailedControlPlaneResult;
	}): Promise<ControlPlaneResult<SessionBootstrap>> {
		const recorded = await this.#callTransition("failure terminal", () => this.#transition!.recordFailure({
			...options.transitionContext,
			prepared: options.prepared,
			phase: options.phase,
			errorCode: options.failure.error.code,
			errorDigest: canonicalDigest(options.failure.error.message),
			outcomeCertain: options.failure.effect === "none",
		}));
		if (options.failure.effect === "uncertain" || !recorded.ok) {
			const unresolved = options.failure.effect === "uncertain"
				? options.failure
				: requireFailure(controlPlaneFailure(
						"recovery_required",
						"runtime replacement failure did not reach a durable terminal",
						false,
						undefined,
						"uncertain",
					));
			this.#freezeUncertainTransition(
				options.candidate,
				options.previous,
				options.recovery,
				unresolved,
				options.candidateHead,
			);
			return unresolved;
		}
		return this.#cleanupPreActivationCandidate(
			options.candidate,
			options.previous,
			options.recovery,
			options.failure,
			options.candidateHead,
		);
	}

	async #recordPostActivationFailure(
		transitionContext: RuntimeGenerationTransitionContext,
		prepared: PreparedRuntimeGenerationTransition,
		phase: Extract<RuntimeGenerationFailurePhase, "authority_swap" | "old_runtime_drain">,
		errorCode: string,
		message: string,
	): Promise<void> {
		await this.#callTransition("post-activation failure terminal", () => this.#transition!.recordFailure({
			...transitionContext,
			prepared,
			phase,
			errorCode: errorCode.slice(0, 128),
			errorDigest: canonicalDigest(message),
			outcomeCertain: true,
		}));
	}

	#failureProjection(
		previous: ActiveRuntime | undefined,
		recovery: SessionBootstrap["recovery"],
		phase: FailedSessionReplacementProjection["phase"],
		errorCode: string,
		message: string,
		candidateRuntime?: ManagedSessionRuntime,
		candidateHead?: EventCursor | null,
		candidateActive?: ActiveRuntime,
	): FailedSessionReplacementProjection {
		return {
			status: "paused",
			phase,
			previousSessionId: previous?.runtime.sessionId ?? null,
			previousHead: previous ? runtimeHead(previous.runtime) : null,
			invalidatedHandleGeneration: previous?.handle.generation ?? null,
			candidateSessionId: candidateRuntime?.sessionId ?? candidateActive?.runtime.sessionId ?? null,
			candidateHead: candidateHead ?? (candidateActive ? runtimeHead(candidateActive.runtime) : null),
			activeHandleGeneration: candidateActive?.handle.generation ?? null,
			attemptedRecovery: recovery,
			errorCode: errorCode.slice(0, 128),
			errorDigest: canonicalDigest(message),
			recordedAt: this.#clock().toISOString(),
		};
	}

	public shutdown(): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(async () => {
			this.#replacing = true;
			const active = this.#active;
			this.#active = undefined;
			const retired = this.#retiredRuntime;
			this.#retiredRuntime = undefined;
			const prepared = this.#preparedRuntime;
			this.#preparedRuntime = undefined;
			if (active) {
				const result = await teardownRuntime(active.runtime, "shutdown");
				if (!result.ok) return result;
			}
			if (retired && retired !== active?.runtime) {
				const result = await teardownRuntime(retired, "shutdown");
				if (!result.ok) return result;
			}
			if (prepared && prepared !== active?.runtime && prepared !== retired) {
				const result = await teardownRuntime(prepared, "shutdown");
				if (!result.ok) return result;
			}
			return { ok: true, value: undefined };
		});
	}
}
