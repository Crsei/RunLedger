/** Owner-fenced durable store for the bounded agent graph. */

import type { RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, isRuntimeId, type AgentId, type CommandId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type {
	AppendEventInput,
	SessionEventRecord,
	SessionStore,
} from "../../storage/session-store/session-store.ts";
import {
	agentGraphCommandDigest,
	createAgentGraphEventPayload,
	decodeAgentGraphEventPayload,
	encodeAgentGraphEventPayload,
	isAgentGraphEventType,
	cloneAgentGraphCommand,
	type AgentGraphCommand,
	type AgentGraphCommandRecord,
	type AgentGraphEventType,
} from "./graph-events.ts";
import {
	applyAgentGraphCommand,
	cloneAgentGraphProjection,
	createEmptyAgentGraphProjection,
	type AgentGraphProjection,
} from "./graph-projection.ts";
import type { MultiAgentLimits, MultiAgentResult } from "./types.ts";
import { MULTI_AGENT_HARD_LIMITS } from "./limits.ts";

export interface AgentGraphHead {
	readonly revision: number;
	readonly projection: AgentGraphProjection;
	readonly sessionHeadSequence: number;
	readonly sessionHeadHash: string | null;
	readonly commands: ReadonlyMap<CommandId, AgentGraphCommandRecord>;
}

export type AgentGraphCommitOutcome =
	| {
			readonly status: "committed" | "duplicate";
			readonly head: AgentGraphHead;
		}
	| {
			readonly status: "conflict";
			readonly actualRevision: number;
			readonly head: AgentGraphHead;
		};

export interface AgentGraphStoreOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly rootAgentId: AgentId;
	readonly limits?: MultiAgentLimits;
	readonly maxRetries?: number;
	/** 测试和故障演练接缝；生产默认直接调用 owner-fenced SessionStore。 */
	readonly appendEvent?: (input: AppendEventInput) => SessionEventRecord;
}

interface LoadedGraph {
	readonly head: AgentGraphHead;
	readonly commands: ReadonlyMap<CommandId, AgentGraphCommandRecord>;
}

const DEFAULT_MAX_RETRIES = 8;

export class AgentGraphStore {
	private readonly store: SessionStore;
	private readonly fence: OwnerFence;
	private readonly rootAgentId: AgentId;
	private readonly limits: MultiAgentLimits;
	private readonly maxRetries: number;
	private readonly appendEvent: (input: AppendEventInput) => SessionEventRecord;
	private queue: Promise<void> = Promise.resolve();

	public constructor(options: AgentGraphStoreOptions) {
		this.store = options.store;
		this.fence = options.fence;
		this.rootAgentId = options.rootAgentId;
		this.limits = Object.freeze({ ...(options.limits ?? MULTI_AGENT_HARD_LIMITS) });
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.appendEvent = options.appendEvent ?? ((input) => this.store.appendEvent(this.fence, input));
	}

	public load(): Promise<MultiAgentResult<AgentGraphHead>> {
		return Promise.resolve().then(() => {
			const loaded = this.loadGraph();
			return loaded.ok ? { ok: true, value: cloneHead(loaded.value.head) } : loaded;
		});
	}

	public commit(command: AgentGraphCommand): Promise<MultiAgentResult<AgentGraphCommitOutcome>> {
		return this.enqueue(() => this.commitOnceQueued(command));
	}

	public findByCommand(commandId: CommandId): Promise<MultiAgentResult<AgentGraphCommandRecord | undefined>> {
		return Promise.resolve().then(() => {
			if (!isRuntimeId(commandId, "command")) return failure("invalid_request", "commandId is invalid");
			const loaded = this.loadGraph();
			if (!loaded.ok) return loaded;
			const record = loaded.value.commands.get(commandId);
			return { ok: true, value: record === undefined ? undefined : cloneRecord(record) };
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async commitOnceQueued(command: AgentGraphCommand): Promise<MultiAgentResult<AgentGraphCommitOutcome>> {
		const checked = validateCommand(command);
		if (!checked.ok) return checked;
		if (command.rootAgentId !== this.rootAgentId) return failure("invalid_request", "command rootAgentId does not match the store");

		for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
			const loaded = this.loadGraph();
			if (!loaded.ok) return loaded;
			const previous = loaded.value.commands.get(command.commandId);
			if (previous !== undefined) {
				if (!sameDigest(previous.commandDigest, agentGraphCommandDigest(command)) || !sameDigest(previous.requestDigest, command.requestDigest)) {
					return failure("idempotency_conflict", "commandId was already used for a different graph command");
				}
				return { ok: true, value: { status: "duplicate", head: cloneHead(loaded.value.head) } };
			}
			if (command.expectedRevision !== loaded.value.head.revision) {
				return {
					ok: true,
					value: {
						status: "conflict",
						actualRevision: loaded.value.head.revision,
						head: cloneHead(loaded.value.head),
					},
				};
			}

			const graphRevision = loaded.value.head.revision + 1;
			const next = applyAgentGraphCommand(loaded.value.head.projection, command, graphRevision);
			if (!next.ok) return next;
			let payloadJson: string;
			try {
				payloadJson = encodeAgentGraphEventPayload(command, graphRevision);
			} catch (error) {
				return failure("invalid_request", error instanceof Error ? error.message : "agent graph payload is invalid");
			}
			const eventId = createRuntimeId(
				"event",
				`agent-graph-${agentGraphCommandDigest(command).digest.slice(0, 64)}`,
			);
			try {
				this.appendEvent({
					eventId,
					ownerGeneration: this.fence.generation,
					eventType: command.type,
					payloadJson,
					createdAtMs: Date.now(),
					expectedPreviousEventHash: loaded.value.head.sessionHeadHash,
				});
			} catch {
				const afterFailure = this.loadGraph();
				if (afterFailure.ok) {
					const durable = afterFailure.value.commands.get(command.commandId);
					if (durable !== undefined) {
						if (!sameDigest(durable.commandDigest, agentGraphCommandDigest(command)) || !sameDigest(durable.requestDigest, command.requestDigest)) {
							return failure("idempotency_conflict", "durable command identity conflicts after append uncertainty");
						}
						return { ok: true, value: { status: "committed", head: cloneHead(afterFailure.value.head) } };
					}
				}
				if (attempt + 1 >= this.maxRetries) return failure("store_conflict", "agent graph append remained uncertain or conflicted");
				continue;
			}

			const afterAppend = this.loadGraph();
			if (!afterAppend.ok) return afterAppend;
			const durable = afterAppend.value.commands.get(command.commandId);
			if (durable === undefined) {
				if (attempt + 1 >= this.maxRetries) return failure("store_conflict", "agent graph append acknowledgement could not be verified");
				continue;
			}
			return { ok: true, value: { status: "committed", head: cloneHead(afterAppend.value.head) } };
		}
		return failure("store_conflict", "agent graph commit exceeded the retry limit");
	}

	private loadGraph(): MultiAgentResult<LoadedGraph> {
		let events: SessionEventRecord[];
		try {
			events = this.store.replaySessionEvents(this.fence.sessionId);
		} catch (error) {
			return failure("store_conflict", error instanceof Error ? error.message : "agent graph session replay failed");
		}
		let projection = createEmptyAgentGraphProjection(this.limits);
		const commands = new Map<CommandId, AgentGraphCommandRecord>();
		let sessionHeadSequence = 0;
		let sessionHeadHash: string | null = null;
		for (const event of events) {
			sessionHeadSequence = event.sequence;
			sessionHeadHash = event.currentEventHash;
			if (!isAgentGraphEventType(event.eventType)) continue;
			const decoded = decodeAgentGraphEventPayload(event.eventType, parseJson(event.payloadJson));
			if (!decoded.ok) return decoded;
			const { graphRevision, ...commandValue } = decoded.value;
			const command = cloneAgentGraphCommand(commandValue);
			if (command.rootAgentId !== this.rootAgentId) return failure("invalid_request", "durable graph event rootAgentId does not match the store");
			const digest = agentGraphCommandDigest(command);
			const existing = commands.get(command.commandId);
			if (existing !== undefined) {
				if (!sameDigest(existing.commandDigest, digest) || existing.graphRevision !== graphRevision) return failure("idempotency_conflict", "durable graph command identity is inconsistent");
				continue;
			}
			if (graphRevision !== projection.revision + 1) return failure("store_conflict", "durable graph revision is discontinuous");
			const applied = applyAgentGraphCommand(projection, command, graphRevision);
			if (!applied.ok) return applied;
			projection = applied.value;
			commands.set(command.commandId, {
				commandId: command.commandId,
				commandDigest: digest,
				eventId: event.eventId as AgentGraphCommandRecord["eventId"],
				eventType: event.eventType as AgentGraphEventType,
				requestDigest: { ...command.requestDigest },
				graphRevision,
				sessionSequence: event.sequence,
				sessionEventHash: event.currentEventHash,
				command,
			});
		}
		if (projection.rootAgentId !== undefined && projection.rootAgentId !== this.rootAgentId) return failure("invalid_request", "durable graph root does not match the store");
		return {
			ok: true,
			value: {
				commands,
				head: {
					revision: projection.revision,
					projection,
					sessionHeadSequence,
					sessionHeadHash,
					commands,
				},
			},
		};
	}
}

function validateCommand(command: AgentGraphCommand): MultiAgentResult<AgentGraphCommand> {
	let payload: unknown;
	try {
		payload = createAgentGraphEventPayload(command, command.expectedRevision + 1);
	} catch (error) {
		return failure("invalid_request", error instanceof Error ? error.message : "agent graph command is invalid");
	}
	const result = decodeAgentGraphEventPayload(command.type, payload);
	if (!result.ok) return result;
	const { graphRevision: _graphRevision, ...value } = result.value;
	return { ok: true, value };
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}

function cloneHead(head: AgentGraphHead): AgentGraphHead {
	return {
		revision: head.revision,
		projection: cloneAgentGraphProjection(head.projection),
		sessionHeadSequence: head.sessionHeadSequence,
		sessionHeadHash: head.sessionHeadHash,
		commands: new Map([...head.commands.entries()].map(([id, record]) => [id, cloneRecord(record)])),
	};
}

function cloneRecord(record: AgentGraphCommandRecord): AgentGraphCommandRecord {
	return {
		...record,
		commandDigest: { ...record.commandDigest },
		requestDigest: { ...record.requestDigest },
		command: cloneAgentGraphCommand(record.command),
	};
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function failure<T>(code: "invalid_request" | "idempotency_conflict" | "store_conflict", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
