/** CLI/TUI 的本地 versioned Control Plane client 与 turn mutation composition。 */

import { randomUUID } from "node:crypto";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createIdempotencyKey, type IdempotencyKey } from "../protocol/v3/coordination.ts";
import { sameRuntimeEventStream, type EventCursor, type ExpectedRevision } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	type CommandId,
	type QueueItemId,
	type RuntimeInstanceId,
	type SessionId,
	type TurnId,
} from "../protocol/v3/ids.ts";
import type { UserAgentMessage } from "../types.ts";
import { ControlPlaneCommandBus } from "./command-bus.ts";
import { ControlPlaneError, controlPlaneFailure, type ControlPlaneResult } from "./errors.ts";
import { negotiateControlPlaneHandshake } from "./handshake.ts";
import type { CommandIdempotencyRepository } from "./idempotency.ts";
import type { GovernedInteractiveMutationPort } from "./interactive-facade.ts";
import { ControlPlaneQueryService } from "./query-service.ts";
import { ShutdownCoordinator } from "./shutdown.ts";
import type {
	ApprovalResolutionCoordinatorPort,
	ControlPlaneCommand,
	ControlPlaneCommandEffect,
	ControlPlaneFeature,
	ControlPlaneRequestContext,
	ControlPlaneScope,
	ControlPlaneSessionHandle,
	MutationExecutorPort,
	MutationStateGuardPort,
	PromptEnqueuePort,
	PromptPreflightReceipt,
	QueryExecutorPort,
	QueueControlPlanePort,
	QueueListItem,
	QueueListQuery,
	TurnFollowUpCommand,
	TurnInterruptCommand,
	TurnStartCommand,
	TurnSteerCommand,
} from "./types.ts";

export type InteractivePromptCommand = TurnStartCommand | TurnSteerCommand | TurnFollowUpCommand;

export interface InteractiveControlPlaneState {
	sessionId: SessionId;
	revision: EventCursor;
	activeTurnId: TurnId | null;
}

export interface InteractiveControlPlaneStatePort {
	inspect(): Promise<ControlPlaneResult<InteractiveControlPlaneState>>;
}

export interface InteractiveDurableQueueReceipt {
	queueItemId: QueueItemId;
	durableCursor: EventCursor;
}

export interface InteractiveDurableQueuePort extends QueueControlPlanePort {
	enqueue(
		command: InteractivePromptCommand,
		message: UserAgentMessage,
	): Promise<ControlPlaneResult<InteractiveDurableQueueReceipt>>;
}

export interface InteractiveRuntimeAcceptance {
	/** turn:start 必须等到 durable turn.started；queue mutation 可立即 resolve。 */
	started: Promise<void>;
	completion: Promise<void>;
}

export interface InteractiveControlPlaneRuntimePort {
	preflight(command: InteractivePromptCommand): Promise<ControlPlaneResult<void>>;
	acceptDurablyEnqueued(
		command: InteractivePromptCommand,
	): Promise<ControlPlaneResult<InteractiveRuntimeAcceptance>>;
	interrupt(command: TurnInterruptCommand): void;
	waitForIdle(): Promise<void>;
	dispose(): void;
}

export interface InteractiveCommandIdentity {
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
}

export interface InteractiveControlPlaneCompositionOptions {
	scope: ControlPlaneScope;
	sessionId: SessionId;
	serverInstanceId: RuntimeInstanceId;
	/** Production caller 必须传入已验证 composition evidence 派生出的能力。 */
	features: readonly ControlPlaneFeature[];
	idempotency: CommandIdempotencyRepository;
	state: InteractiveControlPlaneStatePort;
	queue: InteractiveDurableQueuePort;
	runtime: InteractiveControlPlaneRuntimePort;
	sessionHandle?: ControlPlaneSessionHandle;
	commandIdentity?: () => InteractiveCommandIdentity;
}

export interface InteractiveControlPlaneComposition {
	client: InteractiveControlPlaneClient;
	commands: ControlPlaneCommandBus;
	queries: ControlPlaneQueryService;
	context: ControlPlaneRequestContext;
	handle: ControlPlaneSessionHandle;
}

function sameRevision(left: EventCursor, right: ExpectedRevision): boolean {
	return (
		sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventHash === right.eventHash
	);
}

function sameHandle(left: ControlPlaneSessionHandle, right: ControlPlaneSessionHandle): boolean {
	return (
		left.handleId === right.handleId &&
		left.sessionId === right.sessionId &&
		left.generation === right.generation
	);
}

function userMessage(text: string): UserAgentMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

function hasQueueMessage(item: QueueListItem): item is QueueListItem & { message: UserAgentMessage } {
	return item.message !== null;
}

function commandPromptText(command: InteractivePromptCommand): ControlPlaneResult<string> {
	if (command.payload.prompt.storage !== "bounded_text") {
		return controlPlaneFailure("unsupported_feature", "interactive artifact prompts are not wired");
	}
	return { ok: true, value: command.payload.prompt.text };
}

class InteractiveMutationStateGuard implements MutationStateGuardPort {
	readonly #scope: ControlPlaneScope;
	readonly #sessionId: SessionId;
	readonly #handle: ControlPlaneSessionHandle;
	readonly #state: InteractiveControlPlaneStatePort;

	public constructor(options: {
		scope: ControlPlaneScope;
		sessionId: SessionId;
		handle: ControlPlaneSessionHandle;
		state: InteractiveControlPlaneStatePort;
	}) {
		this.#scope = options.scope;
		this.#sessionId = options.sessionId;
		this.#handle = options.handle;
		this.#state = options.state;
	}

	public async validate(
		command: ControlPlaneCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<void>> {
		const requiredFeature = command.type === "queue:cancel" ? "queue" : "turn";
		if (!context.handshake.features.includes(requiredFeature)) {
			return controlPlaneFailure("unsupported_feature", `${requiredFeature} was not negotiated`);
		}
		if (
			command.authorityId !== this.#scope.authorityId ||
			command.tenantId !== this.#scope.tenantId ||
			command.principalId !== this.#scope.principalId ||
			context.peer.principalId !== this.#scope.principalId
		) return controlPlaneFailure("unauthorized_peer", "interactive command scope is invalid");
		if (
			command.type !== "turn:start" &&
			command.type !== "turn:steer" &&
			command.type !== "turn:followUp" &&
			command.type !== "turn:interrupt" &&
			command.type !== "queue:cancel"
		) return controlPlaneFailure("unsupported_feature", "interactive client only accepts turn mutations");
		if (
			command.payload.sessionId !== this.#sessionId ||
			!command.sessionHandle ||
			!sameHandle(command.sessionHandle, this.#handle)
		) return controlPlaneFailure("stale_session_handle", "interactive session handle is stale");
		const actual = await this.#state.inspect();
		if (!actual.ok) return actual;
		if (
			actual.value.sessionId !== this.#sessionId ||
			!command.expectedSessionRevision ||
			!sameRevision(actual.value.revision, command.expectedSessionRevision)
		) {
			return controlPlaneFailure("expected_revision_conflict", "expected session revision is stale", true, {
				actualSequence: actual.value.revision.sequence,
			});
		}
		if (actual.value.activeTurnId !== command.expectedTurnId) {
			return controlPlaneFailure("expected_turn_conflict", "expected active turn is stale", true, {
				actualTurnId: actual.value.activeTurnId ?? "none",
			});
		}
		return { ok: true, value: undefined };
	}
}

class InteractivePromptAdapter implements PromptEnqueuePort {
	readonly #queue: InteractiveDurableQueuePort;
	readonly #runtime: InteractiveControlPlaneRuntimePort;

	public constructor(queue: InteractiveDurableQueuePort, runtime: InteractiveControlPlaneRuntimePort) {
		this.#queue = queue;
		this.#runtime = runtime;
	}

	public async preflight(
		command: InteractivePromptCommand,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<PromptPreflightReceipt>> {
		const prompt = commandPromptText(command);
		if (!prompt.ok) return prompt;
		const checked = await this.#runtime.preflight(command);
		if (!checked.ok) return checked;
		return {
			ok: true,
			value: {
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
			},
		};
	}

	public async enqueueDurable(
		command: InteractivePromptCommand,
		preflight: PromptPreflightReceipt,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<Extract<ControlPlaneCommandEffect, { type: "turn:start" | "turn:steer" | "turn:followUp" }>>> {
		const prompt = commandPromptText(command);
		if (!prompt.ok) return prompt;
		const queued = await this.#queue.enqueue(command, userMessage(prompt.value));
		if (!queued.ok) return queued;
		const accepted = await this.#runtime.acceptDurablyEnqueued(command);
		if (!accepted.ok) {
			return controlPlaneFailure(
				"recovery_required",
				"prompt was durable but the local runtime did not confirm acceptance",
				false,
				{ commandId: command.commandId },
				"uncertain",
			);
		}
		void accepted.value.completion.catch(() => {
			// Runtime event stream owns post-accept failure reporting; avoid an unhandled rejection.
		});
		try {
			await accepted.value.started;
		} catch {
			return controlPlaneFailure(
				"recovery_required",
				"prompt was durable but the turn did not cross its start barrier",
				false,
				{ commandId: command.commandId },
				"uncertain",
			);
		}
		return {
			ok: true,
			value: {
				type: command.type,
				sessionId: command.payload.sessionId,
				queueItemId: queued.value.queueItemId,
				durableCursor: queued.value.durableCursor,
				preflightDigest: preflight.preflightDigest,
			},
		};
	}
}

class InteractiveMutationExecutor implements MutationExecutorPort {
	readonly #sessionId: SessionId;
	readonly #state: InteractiveControlPlaneStatePort;
	readonly #runtime: InteractiveControlPlaneRuntimePort;

	public constructor(
		sessionId: SessionId,
		state: InteractiveControlPlaneStatePort,
		runtime: InteractiveControlPlaneRuntimePort,
	) {
		this.#sessionId = sessionId;
		this.#state = state;
		this.#runtime = runtime;
	}

	public async execute(
		command: ControlPlaneCommand,
		_context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneCommandEffect>> {
		if (command.type !== "turn:interrupt") {
			return controlPlaneFailure("unsupported_feature", "interactive mutation executor only accepts interrupt");
		}
		try {
			this.#runtime.interrupt(command);
			await this.#runtime.waitForIdle();
		} catch {
			return controlPlaneFailure(
				"recovery_required",
				"interrupt outcome was not confirmed",
				false,
				{ commandId: command.commandId },
				"uncertain",
			);
		}
		const state = await this.#state.inspect();
		if (!state.ok) return state;
		if (state.value.activeTurnId !== null) {
			return controlPlaneFailure(
				"recovery_required",
				"interrupt returned while the durable turn remained active",
				false,
				{ commandId: command.commandId },
				"uncertain",
			);
		}
		return {
			ok: true,
			value: {
				type: "turn:interrupt",
				sessionId: this.#sessionId,
				status: "accepted",
				durableCursor: state.value.revision,
			},
		};
	}
}

const unavailableApprovals: ApprovalResolutionCoordinatorPort = {
	resolve: async () => controlPlaneFailure("unsupported_feature", "interactive approval resolution is not wired"),
};

function asExpectedRevision(cursor: EventCursor): ExpectedRevision {
	return { stream: cursor.stream, sequence: cursor.sequence, eventHash: cursor.eventHash };
}

function throwFailure<T>(result: ControlPlaneResult<T>): T {
	if (!result.ok) throw new ControlPlaneError(result.error);
	return result.value;
}

export class InteractiveControlPlaneClient implements GovernedInteractiveMutationPort {
	readonly #scope: ControlPlaneScope;
	readonly #sessionId: SessionId;
	readonly #handle: ControlPlaneSessionHandle;
	readonly #commands: ControlPlaneCommandBus;
	readonly #queries: ControlPlaneQueryService;
	readonly #context: ControlPlaneRequestContext;
	readonly #state: InteractiveControlPlaneStatePort;
	readonly #runtime: InteractiveControlPlaneRuntimePort;
	readonly #commandIdentity: () => InteractiveCommandIdentity;
	#serial: Promise<void> = Promise.resolve();
	#backgroundError: unknown;
	#disposed = false;

	public constructor(options: {
		scope: ControlPlaneScope;
		sessionId: SessionId;
		handle: ControlPlaneSessionHandle;
		commands: ControlPlaneCommandBus;
		queries: ControlPlaneQueryService;
		context: ControlPlaneRequestContext;
		state: InteractiveControlPlaneStatePort;
		runtime: InteractiveControlPlaneRuntimePort;
		commandIdentity?: () => InteractiveCommandIdentity;
	}) {
		this.#scope = options.scope;
		this.#sessionId = options.sessionId;
		this.#handle = options.handle;
		this.#commands = options.commands;
		this.#queries = options.queries;
		this.#context = options.context;
		this.#state = options.state;
		this.#runtime = options.runtime;
		this.#commandIdentity = options.commandIdentity ?? (() => ({
			commandId: createRuntimeId("command"),
			idempotencyKey: createIdempotencyKey(),
		}));
	}

	#schedule<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #currentState(): Promise<InteractiveControlPlaneState> {
		const state = throwFailure(await this.#state.inspect());
		if (state.sessionId !== this.#sessionId) {
			throw new ControlPlaneError({
				code: "adapter_contract_violation",
				message: "interactive state crossed a session boundary",
				retryable: false,
			});
		}
		return state;
	}

	public prompt(text: string, behavior?: "steer" | "followUp"): Promise<void> {
		return this.#schedule(async () => {
			if (this.#disposed) throw new ControlPlaneError({ code: "daemon_shutting_down", message: "interactive client is disposed", retryable: false });
			const state = await this.#currentState();
			const identity = this.#commandIdentity();
			const base = {
				kind: "command" as const,
				...identity,
				...this.#scope,
				expectedSessionRevision: asExpectedRevision(state.revision),
				expectedTurnId: state.activeTurnId,
				sessionHandle: this.#handle,
			};
			const prompt = {
				storage: "bounded_text" as const,
				text,
				contentDigest: canonicalDigest({ storage: "bounded_text", text }),
			};
			const command: InteractivePromptCommand = state.activeTurnId === null
				? { ...base, type: "turn:start", expectedTurnId: null, payload: { sessionId: this.#sessionId, prompt } }
				: behavior === "followUp"
					? { ...base, type: "turn:followUp", payload: { sessionId: this.#sessionId, prompt } }
					: { ...base, type: "turn:steer", payload: { sessionId: this.#sessionId, prompt } };
			const response = throwFailure(await this.#commands.execute(command, this.#context));
			if (response.result.type !== command.type) {
				throw new ControlPlaneError({
					code: "adapter_contract_violation",
					message: "interactive command response type is inconsistent",
					retryable: false,
				});
			}
		});
	}

	public interrupt(): void {
		const operation = this.#schedule(async () => {
			if (this.#disposed) return;
			const state = await this.#currentState();
			if (state.activeTurnId === null) return;
			const identity = this.#commandIdentity();
			const command: TurnInterruptCommand = {
				kind: "command",
				type: "turn:interrupt",
				...identity,
				...this.#scope,
				expectedSessionRevision: asExpectedRevision(state.revision),
				expectedTurnId: state.activeTurnId,
				sessionHandle: this.#handle,
				payload: {
					sessionId: this.#sessionId,
					reasonDigest: canonicalDigest({ source: "interactive", reason: "interrupt" }),
				},
			};
			throwFailure(await this.#commands.execute(command, this.#context));
		});
		void operation.catch((error: unknown) => {
			this.#backgroundError = error;
		});
	}

	public cancelAllQueues(
		reason = "operator cleared queued messages",
	): Promise<{ steering: UserAgentMessage[]; followUp: UserAgentMessage[] }> {
		return this.#schedule(async () => {
			if (this.#disposed) {
				throw new ControlPlaneError({ code: "daemon_shutting_down", message: "interactive client is disposed", retryable: false });
			}
			const query: QueueListQuery = {
				kind: "query",
				type: "queue:list",
				queryId: `queue-${randomUUID()}`,
				...this.#scope,
				payload: { sessionId: this.#sessionId, sessionHandle: this.#handle },
			};
			const listed = throwFailure(await this.#queries.execute(query, this.#context));
			if (listed.result.type !== "queue:list") {
				throw new ControlPlaneError({
					code: "adapter_contract_violation",
					message: "interactive queue query response type is inconsistent",
					retryable: false,
				});
			}
			const cancellable = listed.result.items.filter((item) => item.status === "pending");
			if (cancellable.length === 0) return { steering: [], followUp: [] };
			const state = await this.#currentState();
			const identity = this.#commandIdentity();
			const command = {
				kind: "command" as const,
				type: "queue:cancel" as const,
				...identity,
				...this.#scope,
				expectedSessionRevision: asExpectedRevision(state.revision),
				expectedTurnId: state.activeTurnId,
				sessionHandle: this.#handle,
				payload: {
					sessionId: this.#sessionId,
					expectedQueueRevision: listed.result.queueRevision,
					items: cancellable.map((item) => ({ queueItemId: item.queueItemId, kind: item.kind })),
					reason,
				},
			};
			const response = throwFailure(await this.#commands.execute(command, this.#context));
			if (response.result.type !== "queue:cancel") {
				throw new ControlPlaneError({
					code: "adapter_contract_violation",
					message: "interactive queue cancellation response type is inconsistent",
					retryable: false,
				});
			}
			return {
				steering: cancellable
					.filter((item) => item.kind === "steer")
					.filter(hasQueueMessage)
					.map((item) => item.message),
				followUp: cancellable
					.filter((item) => item.kind === "follow_up")
					.filter(hasQueueMessage)
					.map((item) => item.message),
			};
		});
	}

	public async waitForIdle(): Promise<void> {
		await this.#serial;
		if (this.#backgroundError !== undefined) {
			const error = this.#backgroundError;
			this.#backgroundError = undefined;
			throw error;
		}
		await this.#runtime.waitForIdle();
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		void this.#serial.then(() => this.#runtime.dispose());
	}
}

export function createInteractiveControlPlaneComposition(
	options: InteractiveControlPlaneCompositionOptions,
): InteractiveControlPlaneComposition {
	const handle = options.sessionHandle ?? {
		handleId: `handle_${randomUUID()}`,
		sessionId: options.sessionId,
		generation: 1,
	};
	if (handle.sessionId !== options.sessionId) {
		throw new ControlPlaneError({ code: "stale_session_handle", message: "interactive handle does not match session", retryable: false });
	}
	const handshake = throwFailure(negotiateControlPlaneHandshake({
		kind: "handshake",
		requestId: `interactive-${randomUUID()}`,
		clientName: "runledger-tui",
		clientVersion: "1.0.0",
		protocol: { major: 1, minMinor: 0, maxMinor: 1 },
		controlPlaneSchemaVersions: [1, 2],
		runtimeSchemaVersions: [3],
		requestedFeatures: ["turn", "queue"],
		requiredFeatures: ["turn", "queue"],
		transport: "local_socket",
	}, {
		serverInstanceId: options.serverInstanceId,
		features: options.features,
	}));
	const context: ControlPlaneRequestContext = {
		peer: {
			kind: "local",
			transport: "local_socket",
			pid: process.pid,
			uid: typeof process.getuid === "function" ? process.getuid() : null,
			principalId: options.scope.principalId,
			authenticatedVia: "socket_peer_credentials",
		},
		handshake,
	};
	const shutdown = new ShutdownCoordinator();
	const queryExecutor: QueryExecutorPort = {
		execute: (query, queryContext) => query.type === "queue:list"
			? options.queue.list(query, queryContext)
			: Promise.resolve(controlPlaneFailure("unsupported_feature", "interactive query is not wired")),
	};
	const queries = new ControlPlaneQueryService({
		executor: queryExecutor,
		handles: {
			validate: (candidate) => sameHandle(candidate, handle)
				? { ok: true, value: undefined }
				: controlPlaneFailure("stale_session_handle", "interactive session handle is stale"),
		},
	});
	const commands = new ControlPlaneCommandBus({
		idempotency: options.idempotency,
		stateGuard: new InteractiveMutationStateGuard({
			scope: options.scope,
			sessionId: options.sessionId,
			handle,
			state: options.state,
		}),
		executor: new InteractiveMutationExecutor(options.sessionId, options.state, options.runtime),
		prompts: new InteractivePromptAdapter(options.queue, options.runtime),
		approvals: unavailableApprovals,
		queues: options.queue,
		shutdown,
	});
	const client = new InteractiveControlPlaneClient({
		scope: options.scope,
		sessionId: options.sessionId,
		handle,
		commands,
		queries,
		context,
		state: options.state,
		runtime: options.runtime,
		...(options.commandIdentity ? { commandIdentity: options.commandIdentity } : {}),
	});
	return { client, commands, queries, context, handle };
}
