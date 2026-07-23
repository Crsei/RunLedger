/** CLI composition：把已打开的 V3SessionManager 与 TUI controller 接到本地 Control Plane。 */

import { AuthorityCommandIdempotencyRepository } from "../runtime/control-plane/authority-command-idempotency.ts";
import {
	createInteractiveControlPlaneComposition,
	type InteractiveControlPlaneRuntimePort,
	type InteractiveControlPlaneState,
	type InteractiveControlPlaneStatePort,
	type InteractiveDurableQueuePort,
	type InteractivePromptCommand,
} from "../runtime/control-plane/interactive-client.ts";
import { ControlPlaneError, controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import { GovernedInteractiveSessionFacade } from "../runtime/control-plane/interactive-facade.ts";
import type {
	GovernedPromptRuntimeAcceptance,
	InteractiveSessionController,
} from "../runtime/interactive-session-controller.ts";
import { readAllRuntimeEvents } from "../runtime/session/snapshot.ts";
import { reduceSessionEvents } from "../runtime/session/reducer.ts";
import {
	DurableQueueBindingError,
	DurableQueueCancellationPartialError,
	DurableQueueEnqueueRevisionConflictError,
	DurableQueueRevisionConflictError,
} from "../runtime/session/agent-loop-events.ts";
import type { TurnInterruptCommand } from "../runtime/control-plane/types.ts";
import type { V3SessionManager } from "../storage/v3-session-manager.ts";
import type { AuthorityRuntimeManager } from "../storage/authority-runtime-manager.ts";
import {
	validateProductionCompositionReceipt,
	type ValidatedProductionComposition,
} from "../daemon/production-composition.ts";

const REQUIRED_INTERACTIVE_FEATURES = ["turn", "queue"] as const;

function adapterFailure<T>(message: string, error?: unknown): ControlPlaneResult<T> {
	return controlPlaneFailure("adapter_unavailable", message, false, {
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
}

export class V3InteractiveControlPlaneState implements InteractiveControlPlaneStatePort {
	readonly #manager: V3SessionManager;

	public constructor(manager: V3SessionManager) {
		this.#manager = manager;
	}

	public async inspect(): Promise<ControlPlaneResult<InteractiveControlPlaneState>> {
		if (this.#manager.isClosed()) {
			return controlPlaneFailure("stale_session_handle", "v3 interactive session is closed");
		}
		const events = await readAllRuntimeEvents(this.#manager.eventStore());
		if (!events.ok) return controlPlaneFailure("recovery_required", "v3 interactive event replay failed");
		const projection = reduceSessionEvents(events.value);
		if (!projection.ok) return controlPlaneFailure("recovery_required", "v3 interactive projection failed");
		const head = this.#manager.writer().currentHead();
		if (
			!head ||
			head.stream.scope !== "session" ||
			head.stream.sessionId !== projection.value.sessionId ||
			head.sequence !== projection.value.headSequence ||
			head.eventId !== projection.value.headEventId ||
			head.eventHash !== projection.value.headEventHash
		) return controlPlaneFailure("recovery_required", "v3 interactive writer and projection diverged");
		if (projection.value.lifecycle !== "active") {
			return controlPlaneFailure("recovery_required", "v3 interactive session is not active");
		}
		return {
			ok: true,
			value: {
				sessionId: projection.value.sessionId,
				revision: head,
				activeTurnId: projection.value.activeTurnId,
			},
		};
	}
}

class CliInteractiveRuntimePort implements InteractiveControlPlaneRuntimePort {
	readonly #controller: InteractiveSessionController;

	public constructor(controller: InteractiveSessionController) {
		this.#controller = controller;
	}

	public async preflight(command: InteractivePromptCommand): Promise<ControlPlaneResult<void>> {
		if (command.payload.prompt.storage !== "bounded_text") {
			return controlPlaneFailure("unsupported_feature", "interactive artifact prompts are not wired");
		}
		try {
			await this.#controller.preflightGovernedPrompt(command.type !== "turn:start", {
				commandId: command.commandId,
				text: command.payload.prompt.text,
			});
			return { ok: true, value: undefined };
		} catch (error) {
			return controlPlaneFailure("preflight_rejected", "interactive prompt preflight was rejected", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	public acceptDurablyEnqueued(
		command: InteractivePromptCommand,
	): Promise<ControlPlaneResult<GovernedPromptRuntimeAcceptance>> {
		if (command.payload.prompt.storage !== "bounded_text") {
			return Promise.resolve(controlPlaneFailure("unsupported_feature", "interactive artifact prompts are not wired"));
		}
		try {
			const behavior = command.type === "turn:start"
				? "start"
				: command.type === "turn:followUp"
					? "followUp"
					: "steer";
			return Promise.resolve({
				ok: true,
				value: this.#controller.acceptDurablyEnqueuedPrompt(
					command.payload.prompt.text,
					behavior,
					command.commandId,
				),
			});
		} catch (error) {
			return Promise.resolve(adapterFailure("local runtime prompt acceptance failed", error));
		}
	}

	public interrupt(_command: TurnInterruptCommand): void {
		this.#controller.interrupt();
	}

	public waitForIdle(): Promise<void> {
		return this.#controller.waitForIdle();
	}

	public dispose(): void {
		this.#controller.dispose();
	}
}

type V3InteractiveQueueSessionEvents = Pick<
	ReturnType<V3SessionManager["sessionEvents"]>,
	"enqueueWithReceipt" | "inspectQueue" | "cancelQueueItems"
>;

export interface V3InteractiveDurableQueueManager {
	sessionEvents(): V3InteractiveQueueSessionEvents;
}

export class V3InteractiveDurableQueue implements InteractiveDurableQueuePort {
	readonly #manager: V3InteractiveDurableQueueManager;

	public constructor(manager: V3InteractiveDurableQueueManager) {
		this.#manager = manager;
	}

	public async enqueue(
		command: InteractivePromptCommand,
		message: Parameters<InteractiveDurableQueuePort["enqueue"]>[1],
	): Promise<Awaited<ReturnType<InteractiveDurableQueuePort["enqueue"]>>> {
		try {
			if (!command.expectedSessionRevision) {
				return controlPlaneFailure("invalid_request", "durable prompt enqueue requires an expected session revision");
			}
			const receipt = await this.#manager.sessionEvents().enqueueWithReceipt(
				command.type === "turn:followUp" ? "follow_up" : "steer",
				message,
				{
					sourceCommandId: command.commandId,
					enqueueRevision: command.expectedSessionRevision,
					targetTurnRevision: command.expectedTurnId === null
						? null
						: { turnId: command.expectedTurnId, sessionRevision: command.expectedSessionRevision },
					nextTurnPolicy: command.type === "turn:followUp" ? "after_active_run" : "next_model_turn",
				},
			);
			return {
				ok: true,
				value: { queueItemId: receipt.queueItemId, durableCursor: receipt.cursor },
			};
		} catch (error) {
			if (error instanceof DurableQueueEnqueueRevisionConflictError) {
				return controlPlaneFailure("expected_revision_conflict", "durable enqueue revision is stale", true, {
					expectedSequence: error.expectedRevision.sequence,
					actualSequence: error.actualRevision.sequence,
				});
			}
			return controlPlaneFailure("durable_enqueue_failed", "v3 prompt enqueue was not confirmed durable", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		}
	}

	public async list(
		query: Parameters<InteractiveDurableQueuePort["list"]>[0],
		_context: Parameters<InteractiveDurableQueuePort["list"]>[1],
	): Promise<Awaited<ReturnType<InteractiveDurableQueuePort["list"]>>> {
		try {
			const snapshot = await this.#manager.sessionEvents().inspectQueue();
			return {
				ok: true,
				value: {
					type: "queue:list",
					sessionId: query.payload.sessionId,
					queueRevision: snapshot.queueRevision,
					items: snapshot.items.map((item) => ({ ...item })),
				},
			};
		} catch (error) {
			return controlPlaneFailure("recovery_required", "interactive durable queue replay failed", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	public async cancel(
		command: Parameters<InteractiveDurableQueuePort["cancel"]>[0],
		_context: Parameters<InteractiveDurableQueuePort["cancel"]>[1],
	): Promise<Awaited<ReturnType<InteractiveDurableQueuePort["cancel"]>>> {
		try {
			const cancelled = await this.#manager.sessionEvents().cancelQueueItems(
				command.payload.expectedQueueRevision,
				command.payload.items,
				command.payload.reason,
				command.commandId,
			);
			return {
				ok: true,
				value: {
					type: "queue:cancel",
					sessionId: command.payload.sessionId,
					...cancelled,
				},
			};
		} catch (error) {
			if (error instanceof DurableQueueRevisionConflictError) {
				return controlPlaneFailure("expected_revision_conflict", "expected queue revision is stale", true, {
					expectedQueueRevision: error.expectedQueueRevision,
					actualQueueRevision: error.actualQueueRevision,
				});
			}
			if (error instanceof DurableQueueBindingError) return controlPlaneFailure("invalid_request", error.message);
			if (error instanceof DurableQueueCancellationPartialError) {
				return controlPlaneFailure("recovery_required", "interactive queue cancellation is partially durable", false, {
					confirmedCount: error.receipts.length,
					queueRevision: error.queueRevision,
				}, "uncertain");
			}
			return controlPlaneFailure("recovery_required", "interactive queue cancellation was not confirmed", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		}
	}
}

export interface CliGovernedInteractiveCompositionOptions {
	controller: InteractiveSessionController;
	manager: V3SessionManager;
	authorityRuntime: AuthorityRuntimeManager;
	/** 必须直接来自 createProductionInteractiveRuntime，不能从 rollout flags 推导。 */
	featureEvidence: ValidatedProductionComposition;
}

export async function createCliGovernedInteractiveController(
	options: CliGovernedInteractiveCompositionOptions,
): Promise<GovernedInteractiveSessionFacade> {
	const identity = options.manager.identity();
	const validated = validateProductionCompositionReceipt(options.featureEvidence.receipt, {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		serverInstanceId: options.manager.runtimeId(),
	});
	if (!validated.ok) throw new ControlPlaneError(validated.error);
	const evidence = validated.value;
	if (
		!evidence.sessionMutationReady ||
		!REQUIRED_INTERACTIVE_FEATURES.every((feature) => evidence.features.includes(feature))
	) {
		throw new ControlPlaneError({
			code: "unsupported_feature",
			message: "daemon interactive mode requires correlated production turn and queue evidence",
			retryable: false,
		});
	}
	if (
		options.manager.isClosed() ||
		options.manager.sessionId() !== options.controller.sessionId
	) {
		throw new ControlPlaneError({
			code: "adapter_contract_violation",
			message: "daemon interactive mode requires the active v3 session controller",
			retryable: false,
		});
	}
	const authorityIdentity = options.authorityRuntime.identity();
	if (
		options.authorityRuntime.isClosed() ||
		options.authorityRuntime.runtimeId() !== options.manager.runtimeId() ||
		authorityIdentity.authorityId !== identity.authorityId ||
		authorityIdentity.tenantId !== identity.tenantId ||
		authorityIdentity.principalId !== identity.principalId
	) {
		throw new ControlPlaneError({
			code: "adapter_contract_violation",
			message: "daemon interactive mode requires the active authority runtime owner",
			retryable: false,
		});
	}
	const idempotency = new AuthorityCommandIdempotencyRepository(
		options.authorityRuntime.authorityRepository(),
	);
	const inFlight = await idempotency.listInFlight();
	if (!inFlight.ok) throw new ControlPlaneError(inFlight.error);
	if (inFlight.value.length > 0) {
		throw new ControlPlaneError({
			code: "recovery_required",
			message: "canonical authority stream contains an uncertain command",
			retryable: false,
			details: { inFlightCount: inFlight.value.length },
		});
	}
	const composition = createInteractiveControlPlaneComposition({
		scope: {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
		},
		sessionId: options.manager.sessionId(),
		serverInstanceId: options.manager.runtimeId(),
		features: evidence.features,
		idempotency,
		state: new V3InteractiveControlPlaneState(options.manager),
		queue: new V3InteractiveDurableQueue(options.manager),
		runtime: new CliInteractiveRuntimePort(options.controller),
	});
	return new GovernedInteractiveSessionFacade({
		view: options.controller,
		mutations: composition.client,
	});
}
