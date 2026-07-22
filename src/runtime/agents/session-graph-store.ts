/** canonical `agent.*` event chain backed graph projection store。 */

import { parseIdempotencyKey } from "../protocol/v3/coordination.ts";
import { sameRuntimeEventStream, type EventCursor, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import { createRuntimeId, isRuntimeId, type AgentId, type PrincipalId, type TraceId } from "../protocol/v3/ids.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import type { EventWriter } from "../session/event-writer.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import {
	agentGraphSemanticCommandDigest,
	applyAgentGraphCommand,
	cloneAgentGraphStoreHead,
	createEmptyAgentGraphProjection,
} from "./graph-store.ts";
import type {
	AgentErrorCode,
	AgentGraphCommitOutcome,
	AgentGraphLimits,
	AgentGraphSemanticCommand,
	AgentGraphStoreHead,
	AgentResult,
	DurableAgentGraphStorePort,
} from "./types.ts";
import { DEFAULT_AGENT_GRAPH_LIMITS } from "./types.ts";

const AGENT_GRAPH_EVENT_TYPES = [
	"agent.root_registered",
	"agent.root_revalidated",
	"agent.spawn_requested",
	"agent.spawned",
	"agent.spawn_failed",
	"agent.transitioned",
	"agent.paused",
	"agent.stopped",
	"agent.partial_committed",
	"agent.cursor_advanced",
	"agent.artifact_reported",
	"agent.residency_changed",
	"agent.budget_rebound",
	"agent.turn_recorded",
	"agent.launch_recorded",
	"agent.resume_revalidated",
	"agent.handoff_requested",
	"agent.handoff_committed",
	"agent.handoff_failed",
	"agent.merge_requested",
	"agent.merge_committed",
	"agent.merge_conflicted",
	"agent.merge_failed",
	"agent.finished",
	"agent.failed",
] as const;

type AgentGraphEventType = (typeof AGENT_GRAPH_EVENT_TYPES)[number];
type AgentGraphRuntimeEvent = Extract<RuntimeEventV3, { type: AgentGraphEventType }>;

interface DecodedAgentGraphEvent {
	rootAgentId: AgentId;
	graphRevision: number;
	command: AgentGraphSemanticCommand;
	cursor: EventCursor;
}

interface GraphReplayState {
	head: AgentGraphStoreHead;
	idempotency: Map<string, string>;
}

export interface SessionAgentGraphStoreOptions {
	writer: EventWriter;
	store: RuntimeEventStore;
	principalId: PrincipalId;
	limits?: AgentGraphLimits;
	traceIdFactory?: () => TraceId;
}

const WRITER_QUEUES = new WeakMap<EventWriter, Promise<void>>();

function serializeWriter<T>(writer: EventWriter, operation: () => Promise<T>): Promise<T> {
	const previous = WRITER_QUEUES.get(writer) ?? Promise.resolve();
	const result = previous.then(operation, operation);
	WRITER_QUEUES.set(
		writer,
		result.then(
			() => undefined,
			() => undefined,
		),
	);
	return result;
}

function fail<T>(code: AgentErrorCode, message: string, retryable = false): AgentResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function commandIdentityIsValid(command: AgentGraphSemanticCommand): boolean {
	return (
		isRuntimeId(command.requestId, "command") &&
		parseIdempotencyKey(command.idempotencyKey) !== undefined &&
		Number.isFinite(Date.parse(command.occurredAt))
	);
}

function isAgentGraphEvent(event: RuntimeEventV3): event is AgentGraphRuntimeEvent {
	switch (event.type) {
		case "agent.root_registered":
		case "agent.root_revalidated":
		case "agent.spawn_requested":
		case "agent.spawned":
		case "agent.spawn_failed":
		case "agent.transitioned":
		case "agent.paused":
		case "agent.stopped":
		case "agent.partial_committed":
		case "agent.cursor_advanced":
		case "agent.artifact_reported":
		case "agent.residency_changed":
		case "agent.budget_rebound":
		case "agent.turn_recorded":
		case "agent.launch_recorded":
		case "agent.resume_revalidated":
		case "agent.handoff_requested":
		case "agent.handoff_committed":
		case "agent.handoff_failed":
		case "agent.merge_requested":
		case "agent.merge_committed":
		case "agent.merge_conflicted":
		case "agent.merge_failed":
		case "agent.finished":
		case "agent.failed":
			return true;
		default:
			return false;
	}
}

function eventCursor(event: RuntimeEventV3): EventCursor {
	return {
		stream: event.stream,
		sequence: event.sequence,
		eventId: event.eventId,
		eventHash: event.currentEventHash,
	};
}

function decodeAgentGraphEvent(event: AgentGraphRuntimeEvent): AgentResult<DecodedAgentGraphEvent> {
	const base = {
		requestId: event.payload.requestId,
		idempotencyKey: event.payload.idempotencyKey,
		occurredAt: event.timestamp,
	};
	let command: AgentGraphSemanticCommand;
	switch (event.type) {
		case "agent.root_registered":
			command = { ...base, type: event.type, node: event.payload.node };
			break;
		case "agent.root_revalidated":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				workspaceReceipt: event.payload.workspaceReceipt,
				capabilityGrant: event.payload.capabilityGrant,
			};
			break;
		case "agent.spawn_requested":
			command = { ...base, type: event.type, intent: event.payload.intent };
			break;
		case "agent.spawned":
			command = {
				...base,
				type: event.type,
				intentRequestId: event.payload.intentRequestId,
				node: event.payload.node,
				edge: event.payload.edge,
			};
			break;
		case "agent.spawn_failed":
			command = {
				...base,
				type: event.type,
				intentRequestId: event.payload.intentRequestId,
				agentId: event.payload.agentId,
				error: event.payload.error,
			};
			break;
		case "agent.transitioned":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				from: event.payload.from,
				to: event.payload.to,
				...(event.payload.reason ? { reason: event.payload.reason } : {}),
			};
			break;
		case "agent.paused":
			command = { ...base, type: event.type, agentId: event.payload.agentId, from: event.payload.from, reason: event.payload.reason };
			break;
		case "agent.stopped":
			command = { ...base, type: event.type, agentId: event.payload.agentId, from: event.payload.from, reason: event.payload.reason };
			break;
		case "agent.partial_committed":
			command = { ...base, type: event.type, agentId: event.payload.agentId, from: event.payload.from, reason: event.payload.reason };
			break;
		case "agent.cursor_advanced":
			command = { ...base, type: event.type, agentId: event.payload.agentId, cursor: event.payload.cursor };
			break;
		case "agent.artifact_reported":
			command = { ...base, type: event.type, report: event.payload.report };
			break;
		case "agent.residency_changed":
			command = { ...base, type: event.type, receipt: event.payload.receipt };
			break;
		case "agent.budget_rebound":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				previousReservationId: event.payload.previousReservationId,
				reservation: event.payload.reservation,
			};
			break;
		case "agent.turn_recorded":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				turnId: event.payload.turnId,
				turnNumber: event.payload.turnNumber,
			};
			break;
		case "agent.launch_recorded":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				launchReceipt: event.payload.launchReceipt,
				residencyReceipt: event.payload.residencyReceipt,
			};
			break;
		case "agent.resume_revalidated":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				delegationReceipt: event.payload.delegationReceipt,
				workspaceReceipt: event.payload.workspaceReceipt,
				denialReceipt: event.payload.denialReceipt,
			};
			break;
		case "agent.handoff_requested":
		case "agent.handoff_committed":
			command = { ...base, type: event.type, handoff: event.payload.handoff };
			break;
		case "agent.handoff_failed":
			command = {
				...base,
				type: event.type,
				handoffId: event.payload.handoffId,
				agentId: event.payload.agentId,
				error: event.payload.error,
			};
			break;
		case "agent.merge_requested":
			command = { ...base, type: event.type, request: event.payload.request };
			break;
		case "agent.merge_committed":
		case "agent.merge_conflicted":
			command = { ...base, type: event.type, receipt: event.payload.receipt };
			break;
		case "agent.merge_failed":
			command = {
				...base,
				type: event.type,
				parentAgentId: event.payload.parentAgentId,
				childAgentId: event.payload.childAgentId,
				error: event.payload.error,
			};
			break;
		case "agent.finished":
			command = { ...base, type: event.type, agentId: event.payload.agentId, from: event.payload.from };
			break;
		case "agent.failed":
			command = {
				...base,
				type: event.type,
				agentId: event.payload.agentId,
				from: event.payload.from,
				reason: event.payload.reason,
				error: event.payload.error,
			};
			break;
	}
	if (!commandIdentityIsValid(command)) return fail("invalid_graph", "agent event command identity is invalid");
	let commandDigest: string;
	try {
		commandDigest = agentGraphSemanticCommandDigest(command);
	} catch {
		return fail("invalid_graph", "agent event command is not canonical");
	}
	if (commandDigest !== event.payload.commandDigest) {
		return fail("invalid_graph", "agent event command digest is invalid");
	}
	return {
		ok: true,
		value: {
			rootAgentId: event.payload.rootAgentId,
			graphRevision: event.payload.graphRevision,
			command,
			cursor: eventCursor(event),
		},
	};
}

async function appendAgentGraphCommand(
	writer: EventWriter,
	principalId: PrincipalId,
	traceId: TraceId,
	rootAgentId: AgentId,
	graphRevision: number,
	command: AgentGraphSemanticCommand,
): Promise<AgentResult<EventCursor>> {
	const common = {
		rootAgentId,
		graphRevision,
		requestId: command.requestId,
		idempotencyKey: command.idempotencyKey,
		commandDigest: agentGraphSemanticCommandDigest(command),
	};
	let appended;
	switch (command.type) {
		case "agent.root_registered":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, node: command.node } });
			break;
		case "agent.root_revalidated":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, workspaceReceipt: command.workspaceReceipt, capabilityGrant: command.capabilityGrant } });
			break;
		case "agent.spawn_requested":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, intent: command.intent } });
			break;
		case "agent.spawned":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, intentRequestId: command.intentRequestId, node: command.node, edge: command.edge } });
			break;
		case "agent.spawn_failed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, intentRequestId: command.intentRequestId, agentId: command.agentId, error: command.error } });
			break;
		case "agent.transitioned":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, from: command.from, to: command.to, ...(command.reason ? { reason: command.reason } : {}) } });
			break;
		case "agent.paused":
		case "agent.stopped":
		case "agent.partial_committed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, from: command.from, reason: command.reason } });
			break;
		case "agent.cursor_advanced":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, cursor: command.cursor } });
			break;
		case "agent.artifact_reported":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, report: command.report } });
			break;
		case "agent.residency_changed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, receipt: command.receipt } });
			break;
		case "agent.budget_rebound":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, previousReservationId: command.previousReservationId, reservation: command.reservation } });
			break;
		case "agent.turn_recorded":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, turnId: command.turnId, turnNumber: command.turnNumber } });
			break;
		case "agent.launch_recorded":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, launchReceipt: command.launchReceipt, residencyReceipt: command.residencyReceipt } });
			break;
		case "agent.resume_revalidated":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, delegationReceipt: command.delegationReceipt, workspaceReceipt: command.workspaceReceipt, denialReceipt: command.denialReceipt } });
			break;
		case "agent.handoff_requested":
		case "agent.handoff_committed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, handoff: command.handoff } });
			break;
		case "agent.handoff_failed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, handoffId: command.handoffId, agentId: command.agentId, error: command.error } });
			break;
		case "agent.merge_requested":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, request: command.request } });
			break;
		case "agent.merge_committed":
		case "agent.merge_conflicted":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, receipt: command.receipt } });
			break;
		case "agent.merge_failed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, parentAgentId: command.parentAgentId, childAgentId: command.childAgentId, error: command.error } });
			break;
		case "agent.finished":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, from: command.from } });
			break;
		case "agent.failed":
			appended = await writer.append({ type: command.type, principalId, traceId, timestamp: command.occurredAt, payload: { ...common, agentId: command.agentId, from: command.from, reason: command.reason, error: command.error } });
			break;
	}
	if (!appended.ok) {
		return fail("store_unavailable", "agent graph durable event append failed", appended.error.retryable);
	}
	const flushed = await writer.flush();
	return flushed.ok
		? { ok: true, value: appended.value.cursor }
		: fail("store_unavailable", "agent graph durable event flush failed", flushed.error.retryable);
}

/** Event Store 是唯一真源；load 只从 exact canonical `agent.*` event 重建 projection。 */
export class SessionAgentGraphStore implements DurableAgentGraphStorePort {
	readonly #writer: EventWriter;
	readonly #store: RuntimeEventStore;
	readonly #principalId: PrincipalId;
	readonly #limits: AgentGraphLimits;
	readonly #traceIdFactory: () => TraceId;

	public constructor(options: SessionAgentGraphStoreOptions) {
		this.#writer = options.writer;
		this.#store = options.store;
		this.#principalId = options.principalId;
		this.#limits = options.limits ?? DEFAULT_AGENT_GRAPH_LIMITS;
		this.#traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
	}

	async #verifiedEvents(): Promise<AgentResult<readonly RuntimeEventV3[]>> {
		let flushed;
		try {
			flushed = await this.#writer.flush();
		} catch {
			return fail("store_unavailable", "agent graph durable read barrier failed", true);
		}
		if (!flushed.ok) {
			return fail("store_unavailable", "agent graph durable read barrier failed", flushed.error.retryable);
		}
		let verified;
		try {
			verified = await this.#store.verify(this.#store.streamRef());
		} catch {
			return fail("store_unavailable", "agent graph event-store verification failed", true);
		}
		if (!verified.ok) return fail("store_unavailable", "agent graph event-store verification failed", verified.error.retryable);
		if (verified.value.integrity !== "valid") return fail("invalid_graph", "agent graph event chain is not complete and valid");
		const replay = await readAllRuntimeEvents(this.#store);
		if (!replay.ok) return fail("store_unavailable", "agent graph event replay failed", replay.error.retryable);
		const first = replay.value[0];
		if (!first) {
			return verified.value.eventCount === 0
				? { ok: true, value: [] }
				: fail("invalid_graph", "agent graph verification and replay disagree");
		}
		const chain = verifyRuntimeEventChain(replay.value, {
			authorityId: first.authorityId,
			tenantId: first.tenantId,
			stream: first.stream,
		});
		if (
			chain.integrity !== "valid" ||
			verified.value.authorityId !== first.authorityId ||
			verified.value.tenantId !== first.tenantId ||
			!sameRuntimeEventStream(verified.value.stream, first.stream) ||
			verified.value.eventCount !== replay.value.length
		) return fail("invalid_graph", "agent graph event chain failed canonical verification");
		return { ok: true, value: replay.value };
	}

	async #loadState(rootAgentId: AgentId): Promise<AgentResult<GraphReplayState>> {
		if (!isRuntimeId(rootAgentId, "agent")) return fail("invalid_request", "rootAgentId is invalid");
		const replay = await this.#verifiedEvents();
		if (!replay.ok) return replay;
		const graphs = new Map<AgentId, GraphReplayState>();
		for (const event of replay.value) {
			if (!isAgentGraphEvent(event)) continue;
			const decoded = decodeAgentGraphEvent(event);
			if (!decoded.ok) return decoded;
			const current = graphs.get(decoded.value.rootAgentId) ?? {
				head: { revision: 0, projection: createEmptyAgentGraphProjection() },
				idempotency: new Map<string, string>(),
			};
			if (decoded.value.graphRevision !== current.head.revision + 1) {
				return fail("invalid_graph", "agent graph revision is discontinuous");
			}
			const digest = agentGraphSemanticCommandDigest(decoded.value.command);
			if (current.idempotency.has(decoded.value.command.idempotencyKey)) {
				return fail("invalid_graph", "agent graph idempotency key is duplicated in the event chain");
			}
			const applied = applyAgentGraphCommand(current.head.projection, decoded.value.command, this.#limits);
			if (!applied.ok) return applied;
			const projection = { ...applied.value, revision: decoded.value.graphRevision };
			current.head = {
				revision: decoded.value.graphRevision,
				cursor: decoded.value.cursor,
				projection,
			};
			current.idempotency.set(decoded.value.command.idempotencyKey, digest);
			graphs.set(decoded.value.rootAgentId, current);
		}
		return {
			ok: true,
			value: graphs.get(rootAgentId) ?? {
				head: { revision: 0, projection: createEmptyAgentGraphProjection() },
				idempotency: new Map<string, string>(),
			},
		};
	}

	public async load(rootAgentId: AgentId): Promise<AgentResult<AgentGraphStoreHead>> {
		try {
			const loaded = await this.#loadState(rootAgentId);
			return loaded.ok ? { ok: true, value: cloneAgentGraphStoreHead(loaded.value.head) } : loaded;
		} catch {
			return fail("invalid_graph", "agent graph replay raised an unexpected error");
		}
	}

	async #commitSafely(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		if (
			!isRuntimeId(rootAgentId, "agent") ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0 ||
			!commandIdentityIsValid(command)
		) return fail("invalid_request", "agent graph commit identity or revision is invalid");
		let digest: string;
		try {
			digest = agentGraphSemanticCommandDigest(command);
		} catch {
			return fail("invalid_graph", "agent graph command is not canonical");
		}
		const loaded = await this.#loadState(rootAgentId);
		if (!loaded.ok) return loaded;
		const previous = loaded.value.idempotency.get(command.idempotencyKey);
		if (previous) {
			if (previous !== digest) return fail("idempotency_conflict", "agent graph idempotency key was reused");
			return { ok: true, value: { status: "duplicate", head: cloneAgentGraphStoreHead(loaded.value.head) } };
		}
		if (loaded.value.head.revision !== expectedRevision) {
			return { ok: true, value: { status: "conflict", actualRevision: loaded.value.head.revision } };
		}
		if (command.type === "agent.root_registered" && command.node.agentId !== rootAgentId) {
			return fail("invalid_graph", "root registration does not match the selected graph");
		}
		if (command.type !== "agent.root_registered" && loaded.value.head.projection.rootAgentId !== rootAgentId) {
			return fail("graph_not_initialized", "agent graph root is not registered");
		}
		const applied = applyAgentGraphCommand(loaded.value.head.projection, command, this.#limits);
		if (!applied.ok) return applied;
		const graphRevision = expectedRevision + 1;
		const appended = await appendAgentGraphCommand(
			this.#writer,
			this.#principalId,
			this.#traceIdFactory(),
			rootAgentId,
			graphRevision,
			command,
		);
		if (!appended.ok) return appended;
		const projection = { ...applied.value, revision: graphRevision };
		const head: AgentGraphStoreHead = { revision: graphRevision, cursor: appended.value, projection };
		return { ok: true, value: { status: "committed", head: cloneAgentGraphStoreHead(head) } };
	}

	public commit(
		rootAgentId: AgentId,
		expectedRevision: number,
		command: AgentGraphSemanticCommand,
	): Promise<AgentResult<AgentGraphCommitOutcome>> {
		return serializeWriter(this.#writer, async () => {
			try {
				return await this.#commitSafely(rootAgentId, expectedRevision, command);
			} catch {
				return fail("store_unavailable", "agent graph commit raised an unexpected error");
			}
		});
	}
}
