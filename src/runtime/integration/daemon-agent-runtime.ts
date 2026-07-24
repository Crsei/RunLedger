/** Canonical queue 到真实 Agent loop 的 daemon-owned production port。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { EventCursor } from "../protocol/v3/events.ts";
import type { SessionId } from "../protocol/v3/ids.ts";
import {
	controlPlaneFailure,
	type ControlPlaneResult,
} from "../control-plane/errors.ts";
import type {
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneRequestContext,
	MutationExecutorPort,
	PromptEnqueuePort,
	PromptPreflightReceipt,
	TurnFollowUpCommand,
	TurnInterruptCommand,
	TurnStartCommand,
	TurnSteerCommand,
} from "../control-plane/types.ts";
import type {
	ApprovedPlanSessionRuntimeFactoryPort,
	ManagedSessionRuntime,
	SessionRuntimeFactoryPort,
} from "../control-plane/session-registry.ts";
import type { ApprovedPlanForkSeed } from "../modes/plan/types.ts";
import {
	DurableQueueBindingError,
	DurableQueueEnqueueRevisionConflictError,
	type DurableQueueReceipt,
} from "../session/agent-loop-events.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import type { V3SessionManager } from "../../storage/v3-session-manager.ts";
import type { SessionMutationAdmissionGatePort } from "../lifecycle/mutation-gate.ts";
import type {
	DaemonAgentSessionBindingFactoryPort,
	DaemonAgentSessionBindingPort,
} from "./daemon-agent-session.ts";
import {
	ProductionPlanContextMemoryControlPlaneExecutor,
	type ActivePlanContextMemorySessionResolverPort,
	type ProductionPlanContextMemorySessionPort,
} from "./production-plan-context-memory-control-plane.ts";
import type {
	PlanContextMemoryMutationExecutorPort,
	PlanContextMemoryQueryExecutorPort,
} from "../control-plane/plan-context-memory-control-plane.ts";

type PromptCommand = TurnStartCommand | TurnSteerCommand | TurnFollowUpCommand;

interface BoundAgentSession {
	binding: DaemonAgentSessionBindingPort;
	phase: "ready" | "closing";
}

interface AcceptedPromptPreflight {
	receipt: PromptPreflightReceipt;
	commandDigest: string;
	runtimeId: string;
	binding: DaemonAgentSessionBindingPort;
}

export interface DaemonOwnedAgentRuntimeOptions {
	sessions: DaemonAgentSessionBindingFactoryPort;
	/** replacement/shutdown/interrupt 都必须在此上限内到达 externally idle。 */
	drainTimeoutMs?: number;
}

export interface ManagedV3SessionRuntimePort extends ManagedSessionRuntime {
	manager(): V3SessionManager;
	mutationGate(): SessionMutationAdmissionGatePort;
}

function isManagedV3SessionRuntime(
	runtime: ManagedSessionRuntime,
): runtime is ManagedV3SessionRuntimePort {
	const candidate = runtime as ManagedSessionRuntime & { manager?: unknown; mutationGate?: unknown };
	return typeof candidate.manager === "function" && typeof candidate.mutationGate === "function";
}

function promptText(command: PromptCommand): ControlPlaneResult<string> {
	if (command.payload.prompt.storage !== "bounded_text") {
		return controlPlaneFailure("unsupported_feature", "daemon Agent runtime does not resolve artifact-backed prompts");
	}
	const expectedDigest = canonicalDigest({
		storage: "bounded_text",
		text: command.payload.prompt.text,
	});
	if (command.payload.prompt.contentDigest !== expectedDigest) {
		return controlPlaneFailure("invalid_request", "prompt content digest does not match the bounded text");
	}
	return { ok: true, value: command.payload.prompt.text };
}

function promptPreflightReceipt(command: PromptCommand): PromptPreflightReceipt {
	return {
		commandId: command.commandId,
		promptDigest: command.payload.prompt.contentDigest,
		preflightDigest: canonicalDigest({
			commandId: command.commandId,
			type: command.type,
			sessionId: command.payload.sessionId,
			expectedSessionRevision: command.expectedSessionRevision,
			expectedTurnId: command.expectedTurnId,
			promptDigest: command.payload.prompt.contentDigest,
		}),
		accepted: true,
	};
}

function samePreflight(
	left: PromptPreflightReceipt,
	right: PromptPreflightReceipt,
): boolean {
	return (
		left.commandId === right.commandId &&
		left.promptDigest === right.promptDigest &&
		left.preflightDigest === right.preflightDigest &&
		left.accepted === right.accepted
	);
}

function sameScope(
	binding: DaemonAgentSessionBindingPort,
	command: PromptCommand | TurnInterruptCommand,
	context: ControlPlaneRequestContext,
): boolean {
	const identity = binding.manager.identity();
	return (
		command.payload.sessionId === binding.sessionId &&
		command.authorityId === identity.authorityId &&
		command.tenantId === identity.tenantId &&
		command.principalId === identity.principalId &&
		context.peer.principalId === identity.principalId
	);
}

function boundedWait(
	promise: Promise<void>,
	timeoutMs: number,
	operation: string,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`${operation} did not reach externally idle within ${timeoutMs}ms`));
		}, timeoutMs);
		void promise.then(
			() => {
				clearTimeout(timeout);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

/**
 * 同一个实例同时是 daemon 的 PromptEnqueuePort、turn interrupt executor 和
 * session lifecycle owner。所有 mutation 在 per-session 串行锁内执行。
 */
export class DaemonOwnedAgentRuntime
	implements PromptEnqueuePort, MutationExecutorPort, ActivePlanContextMemorySessionResolverPort {
	readonly #factory: DaemonAgentSessionBindingFactoryPort;
	readonly #drainTimeoutMs: number;
	readonly #sessions = new Map<SessionId, BoundAgentSession>();
	readonly #preflights = new Map<string, AcceptedPromptPreflight>();
	readonly #sessionLocks = new Map<SessionId, Promise<void>>();

	public constructor(options: DaemonOwnedAgentRuntimeOptions) {
		this.#factory = options.sessions;
		this.#drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
		if (
			!Number.isSafeInteger(this.#drainTimeoutMs) ||
			this.#drainTimeoutMs < 1 ||
			this.#drainTimeoutMs > 300_000
		) throw new Error("daemon Agent drain timeout is outside the supported range");
	}

	#withSessionLock<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
		const previous = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
		const result = previous.then(operation);
		const barrier = result.then(
			() => undefined,
			() => undefined,
		);
		this.#sessionLocks.set(sessionId, barrier);
		void barrier.then(() => {
			if (this.#sessionLocks.get(sessionId) === barrier) this.#sessionLocks.delete(sessionId);
		});
		return result;
	}

	#readySession(sessionId: SessionId): ControlPlaneResult<DaemonAgentSessionBindingPort> {
		const state = this.#sessions.get(sessionId);
		if (!state) return controlPlaneFailure("stale_session_handle", "daemon Agent session is not bound");
		if (state.phase !== "ready" || state.binding.manager.isClosed()) {
			return controlPlaneFailure(
				"recovery_required",
				"daemon Agent session is closing or its writer is unavailable",
				false,
				undefined,
				"uncertain",
			);
		}
		return { ok: true, value: state.binding };
	}

	public withSession<T>(
		sessionId: SessionId,
		operation: (
			session: ProductionPlanContextMemorySessionPort,
		) => Promise<ControlPlaneResult<T>>,
	): Promise<ControlPlaneResult<T>> {
		return this.#withSessionLock(sessionId, async () => {
			const ready = this.#readySession(sessionId);
			if (!ready.ok) return ready;
			if (!ready.value.planContextMemory) {
				return controlPlaneFailure(
					"adapter_unavailable",
					"active daemon session has no production Plan/Context/Memory runtime",
					true,
				);
			}
			let specialty: ProductionPlanContextMemorySessionPort;
			try {
				specialty = ready.value.planContextMemory();
			} catch (error) {
				return controlPlaneFailure(
					"adapter_unavailable",
					"active daemon specialty runtime lookup failed",
					true,
					{ errorName: error instanceof Error ? error.name : "UnknownError" },
				);
			}
			if (
				specialty.manager !== ready.value.manager ||
				specialty.manager.sessionId() !== sessionId ||
				specialty.workspace.sessionId !== sessionId
			) {
				return controlPlaneFailure(
					"adapter_contract_violation",
					"daemon specialty runtime is cross-session or detached from the active writer",
				);
			}
			return operation(specialty);
		});
	}

	/** Decorated SessionRuntimeFactory 在返回 bootstrap 前调用，保证 daemon 是唯一 owner。 */
	public bindManagedRuntime(
		runtime: ManagedV3SessionRuntimePort,
	): Promise<ControlPlaneResult<void>> {
		return this.#withSessionLock(runtime.sessionId, async () => {
			if (this.#sessions.has(runtime.sessionId)) {
				return controlPlaneFailure("session_replacing", "daemon Agent session is already bound", true);
			}
			try {
				const binding = await this.#factory.create(runtime.manager(), runtime.mutationGate());
				if (
					binding.sessionId !== runtime.sessionId ||
					binding.manager !== runtime.manager() ||
					binding.manager.isClosed()
				) {
					await binding.close().catch(() => undefined);
					return controlPlaneFailure(
						"adapter_contract_violation",
						"daemon Agent factory returned a cross-session or closed binding",
					);
				}
				this.#sessions.set(runtime.sessionId, { binding, phase: "ready" });
				return { ok: true, value: undefined };
			} catch (error) {
				return controlPlaneFailure(
					"recovery_required",
					"daemon Agent production session could not be initialized",
					false,
					{ errorName: error instanceof Error ? error.name : "UnknownError" },
					"uncertain",
				);
			}
		});
	}

	public preflight(
		command: PromptCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<PromptPreflightReceipt>> {
		return this.#withSessionLock(command.payload.sessionId, async () => {
			const session = this.#readySession(command.payload.sessionId);
			if (!session.ok) return session;
			if (!sameScope(session.value, command, context)) {
				return controlPlaneFailure("unauthorized_peer", "prompt scope does not match the daemon Agent session");
			}
			const text = promptText(command);
			if (!text.ok) return text;
			try {
				await session.value.preflightPrompt(
					command.commandId,
					text.value,
					command.type !== "turn:start",
				);
			} catch (error) {
				return controlPlaneFailure("preflight_rejected", "daemon Agent prompt preflight was rejected", false, {
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
			}
			const receipt = promptPreflightReceipt(command);
			if (this.#preflights.size >= 1_024) {
				const oldest = this.#preflights.keys().next().value;
				if (oldest !== undefined) this.#preflights.delete(oldest);
			}
			this.#preflights.set(command.commandId, {
				receipt,
				commandDigest: canonicalDigest(command),
				runtimeId: session.value.manager.runtimeId(),
				binding: session.value,
			});
			return { ok: true, value: receipt };
		});
	}

	public enqueueDurable(
		command: PromptCommand,
		preflight: PromptPreflightReceipt,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<
		ControlPlaneCommandEffect,
		{ type: "turn:start" | "turn:steer" | "turn:followUp" }
	>>> {
		return this.#withSessionLock(command.payload.sessionId, async () => {
			const session = this.#readySession(command.payload.sessionId);
			if (!session.ok) return session;
			if (!sameScope(session.value, command, context)) {
				return controlPlaneFailure("unauthorized_peer", "prompt scope does not match the daemon Agent session");
			}
			const text = promptText(command);
			if (!text.ok) return text;
			if (!command.expectedSessionRevision) {
				return controlPlaneFailure("invalid_request", "durable prompt enqueue requires an expected session revision");
			}
			const acceptedPreflight = this.#preflights.get(command.commandId);
			this.#preflights.delete(command.commandId);
			if (
				!acceptedPreflight ||
				acceptedPreflight.binding !== session.value ||
				acceptedPreflight.runtimeId !== session.value.manager.runtimeId() ||
				acceptedPreflight.commandDigest !== canonicalDigest(command) ||
				!samePreflight(acceptedPreflight.receipt, preflight)
			) {
				return controlPlaneFailure("preflight_rejected", "prompt preflight is absent, stale, or cross-runtime");
			}

			const replay = await readAllRuntimeEvents(session.value.manager.eventStore());
			if (!replay.ok) {
				return controlPlaneFailure("recovery_required", "canonical queue replay failed before enqueue");
			}
			if (replay.value.some((event) =>
				event.type === "queue.enqueued" && event.payload.sourceCommandId === command.commandId
			)) {
				return controlPlaneFailure(
					"recovery_required",
					"command already has canonical queue evidence and requires idempotency recovery",
					false,
					{ commandId: command.commandId },
					"uncertain",
				);
			}

			let durableReceipt: DurableQueueReceipt | undefined;
			try {
				const kind = command.type === "turn:followUp" ? "follow_up" : "steer";
				durableReceipt = await session.value.manager.sessionEvents().enqueueWithReceipt(
					kind,
					{ role: "user", content: [{ type: "text", text: text.value }] },
					{
						sourceCommandId: command.commandId,
						enqueueRevision: command.expectedSessionRevision,
						targetTurnRevision: command.expectedTurnId === null
							? null
							: {
								turnId: command.expectedTurnId,
								sessionRevision: command.expectedSessionRevision,
							},
						nextTurnPolicy: kind === "follow_up" ? "after_active_run" : "next_model_turn",
					},
				);
				const behavior = command.type === "turn:start"
					? "start"
					: command.type === "turn:followUp"
						? "followUp"
						: "steer";
				const accepted = session.value.acceptPrompt(
					command.commandId,
					text.value,
					behavior,
					durableReceipt,
				);
				void accepted.completion.catch(() => {
					// Agent/Session event stream owns the post-accept terminal evidence.
				});
				await accepted.started;
				return {
					ok: true,
					value: {
						type: command.type,
						sessionId: command.payload.sessionId,
						queueItemId: durableReceipt.queueItemId,
						durableCursor: durableReceipt.cursor,
						preflightDigest: preflight.preflightDigest,
					},
				};
			} catch (error) {
				if (error instanceof DurableQueueEnqueueRevisionConflictError) {
					return controlPlaneFailure("expected_revision_conflict", "durable enqueue revision is stale", true, {
						expectedSequence: error.expectedRevision.sequence,
						actualSequence: error.actualRevision.sequence,
					});
				}
				if (error instanceof DurableQueueBindingError && !durableReceipt) {
					return controlPlaneFailure("invalid_request", error.message);
				}
				return controlPlaneFailure(
					"recovery_required",
					durableReceipt
						? "prompt is durable but exact canonical queue acceptance failed"
						: "durable prompt enqueue outcome was not confirmed",
					false,
					{ errorName: error instanceof Error ? error.name : "UnknownError" },
					"uncertain",
				);
			}
		});
	}

	public execute(
		command: ControlPlaneCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandEffect>> {
		if (command.type !== "turn:interrupt") {
			return Promise.resolve(controlPlaneFailure("unsupported_feature", "daemon Agent runtime only handles turn interrupt"));
		}
		return this.#withSessionLock(command.payload.sessionId, async () => {
			const session = this.#readySession(command.payload.sessionId);
			if (!session.ok) return session;
			if (!sameScope(session.value, command, context)) {
				return controlPlaneFailure("unauthorized_peer", "interrupt scope does not match the daemon Agent session");
			}
			try {
				session.value.interrupt();
				await boundedWait(
					session.value.waitForIdle(),
					this.#drainTimeoutMs,
					"turn interrupt",
				);
				const head = session.value.manager.writer().currentHead();
				if (!head) throw new Error("turn interrupt completed without a durable cursor");
				return {
					ok: true,
					value: {
						type: "turn:interrupt",
						sessionId: command.payload.sessionId,
						status: "accepted",
						durableCursor: head,
					},
				};
			} catch (error) {
				return controlPlaneFailure(
					"recovery_required",
					"turn interrupt did not reach a confirmed externally idle state",
					false,
					{ errorName: error instanceof Error ? error.name : "UnknownError" },
					"uncertain",
				);
			}
		});
	}

	/** 先 bounded drain/close Agent composition；失败时保留 writer 与 managed runtime。 */
	public closeSession(
		sessionId: SessionId,
		reason: "replacement" | "shutdown",
	): Promise<ControlPlaneResult<void>> {
		return this.#withSessionLock(sessionId, async () => {
			const state = this.#sessions.get(sessionId);
			if (!state) return { ok: true, value: undefined };
			state.phase = "closing";
			try {
				await boundedWait(
					state.binding.waitForIdle(),
					this.#drainTimeoutMs,
					`session ${reason} drain`,
				);
				await state.binding.close();
			} catch (error) {
				return controlPlaneFailure(
					"recovery_required",
					"daemon Agent teardown did not reach a confirmed terminal boundary",
					false,
					{ reason, errorName: error instanceof Error ? error.name : "UnknownError" },
					"uncertain",
				);
			}
			this.#sessions.delete(sessionId);
			for (const [commandId, preflight] of this.#preflights) {
				if (preflight.binding === state.binding) this.#preflights.delete(commandId);
			}
			return { ok: true, value: undefined };
		});
	}

	public async closeAll(reason: "replacement" | "shutdown" = "shutdown"): Promise<ControlPlaneResult<void>> {
		for (const sessionId of [...this.#sessions.keys()]) {
			const closed = await this.closeSession(sessionId, reason);
			if (!closed.ok) return closed;
		}
		return { ok: true, value: undefined };
	}

	public isBound(sessionId: SessionId): boolean {
		return this.#sessions.has(sessionId);
	}
}

class DaemonAgentManagedSessionRuntime implements ManagedSessionRuntime {
	public readonly sessionId: SessionId;
	readonly #delegate: ManagedSessionRuntime;
	readonly #agents: DaemonOwnedAgentRuntime;

	public constructor(delegate: ManagedSessionRuntime, agents: DaemonOwnedAgentRuntime) {
		this.sessionId = delegate.sessionId;
		this.#delegate = delegate;
		this.#agents = agents;
	}

	public head(): EventCursor | null {
		return this.#delegate.head();
	}

	public async teardown(reason: "replacement" | "shutdown"): Promise<ControlPlaneResult<void>> {
		const drained = await this.#agents.closeSession(this.sessionId, reason);
		if (!drained.ok) return drained;
		try {
			return await this.#delegate.teardown(reason);
		} catch (error) {
			return controlPlaneFailure(
				"recovery_required",
				"v3 managed runtime teardown threw after Agent composition settled",
				false,
				{ errorName: error instanceof Error ? error.name : "UnknownError" },
				"uncertain",
			);
		}
	}
}

/** 把 Agent composition 加入 SessionRuntimeRegistry 的 candidate/teardown 临界区。 */
export class DaemonAgentSessionRuntimeFactoryDecorator implements ApprovedPlanSessionRuntimeFactoryPort {
	readonly #delegate: SessionRuntimeFactoryPort;
	readonly #agents: DaemonOwnedAgentRuntime;

	public constructor(delegate: SessionRuntimeFactoryPort, agents: DaemonOwnedAgentRuntime) {
		this.#delegate = delegate;
		this.#agents = agents;
	}

	async #activate(
		created: ControlPlaneResult<ManagedSessionRuntime>,
	): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		if (!created.ok) return created;
		const runtime = created.value;
		if (!isManagedV3SessionRuntime(runtime)) {
			const cleanup = await runtime.teardown("replacement");
			if (!cleanup.ok) return cleanup;
			return controlPlaneFailure(
				"adapter_contract_violation",
				"daemon Agent session factory requires a managed v3 runtime",
			);
		}
		const bound = await this.#agents.bindManagedRuntime(runtime);
		if (!bound.ok) {
			const cleanup = await runtime.teardown("replacement");
			return cleanup.ok ? bound : cleanup;
		}
		return {
			ok: true,
			value: new DaemonAgentManagedSessionRuntime(runtime, this.#agents),
		};
	}

	public async start(): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		return this.#activate(await this.#delegate.start());
	}

	public async resume(sessionId: SessionId): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		return this.#activate(await this.#delegate.resume(sessionId));
	}

	public async fork(
		parentSessionId: SessionId,
		parentCursor: EventCursor,
		goalMode: "continue_existing_goal" | "create_child_goal",
	): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		return this.#activate(await this.#delegate.fork(parentSessionId, parentCursor, goalMode));
	}

	public async forkApprovedPlan(
		seed: ApprovedPlanForkSeed,
	): Promise<ControlPlaneResult<ManagedSessionRuntime>> {
		if (
			!("forkApprovedPlan" in this.#delegate) ||
			typeof this.#delegate.forkApprovedPlan !== "function"
		) {
			return controlPlaneFailure(
				"adapter_contract_violation",
				"daemon Agent session factory requires a specialized approved-plan fork",
			);
		}
		return this.#activate(await this.#delegate.forkApprovedPlan(seed));
	}
}

export interface DaemonOwnedAgentRuntimePorts {
	readonly runtime: DaemonOwnedAgentRuntime;
	readonly sessionFactory: SessionRuntimeFactoryPort;
	readonly prompts: PromptEnqueuePort;
	readonly mutationExecutor: MutationExecutorPort;
	readonly planContextMemoryMutations: PlanContextMemoryMutationExecutorPort;
	readonly planContextMemoryQueries: PlanContextMemoryQueryExecutorPort;
}

/** local-v3-daemon composition 可直接消费此 factory/ports，不再由 CLI 构造 controller。 */
export function createDaemonOwnedAgentRuntimePorts(
	options: DaemonOwnedAgentRuntimeOptions,
	sessionFactory: SessionRuntimeFactoryPort,
): DaemonOwnedAgentRuntimePorts {
	const runtime = new DaemonOwnedAgentRuntime(options);
	const specialty = new ProductionPlanContextMemoryControlPlaneExecutor(runtime);
	return {
		runtime,
		sessionFactory: new DaemonAgentSessionRuntimeFactoryDecorator(sessionFactory, runtime),
		prompts: runtime,
		mutationExecutor: runtime,
		planContextMemoryMutations: specialty,
		planContextMemoryQueries: specialty,
	};
}
