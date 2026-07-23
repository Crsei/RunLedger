/** Runtime v3 session events 的无副作用 reducer。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { sameRuntimeEventStream, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type AgentId,
	type CheckpointId,
	type GoalId,
	type LeafId,
	type ModelRequestId,
	type QueueItemId,
	type RuntimeIdKind,
	type RuntimeId,
	type SessionId,
	type ToolCallId,
	type TurnId,
} from "../protocol/v3/ids.ts";
import type {
	CheckpointProjection,
	LegacyMigrationProjection,
	ModelRequestProjection,
	QueueItemProjection,
	SessionGenesisProjection,
	SessionLifecycleStatus,
	SessionProjection,
	SessionProjectionState,
	ToolCallProjection,
	TurnProjection,
} from "./projections.ts";
import type { SessionKernelError, SessionResult } from "./types.ts";
import {
	LEGACY_MIGRATION_SCHEMA,
	decodeLegacyMigrationConfiguration,
	legacyMigrationImportDescriptorFromPayload,
	legacyMigrationImportRecordDigest,
	legacyMigrationManifestDigest,
	legacyMigrationManifestFromStarted,
} from "./legacy-migration-manifest.ts";

interface MutableProjection {
	authorityId: SessionProjectionState["authorityId"];
	tenantId: SessionProjectionState["tenantId"];
	principalId: SessionProjectionState["principalId"];
	sessionId: SessionProjectionState["sessionId"];
	stream: SessionProjectionState["stream"];
	genesis: SessionGenesisProjection;
	migration: LegacyMigrationProjection | null;
	lifecycleHeadRef: SessionProjectionState["lifecycleHeadRef"];
	lifecycle: SessionLifecycleStatus;
	terminalEventId: SessionProjectionState["terminalEventId"];
	activeTurnId: TurnId | null;
	activeModelRequestId: ModelRequestId | null;
	turns: TurnProjection[];
	modelRequests: ModelRequestProjection[];
	toolCalls: ToolCallProjection[];
	queueItems: QueueItemProjection[];
	checkpoints: CheckpointProjection[];
	activeLeafId: LeafId;
	knownLeafIds: LeafId[];
	headSequence: number;
	headEventId: SessionProjectionState["headEventId"];
	headEventHash: string;
	headTraceId: SessionProjectionState["headTraceId"];
}

function initialLeafId(sessionId: SessionId): LeafId {
	return createRuntimeId("leaf", canonicalDigest({ sessionId, kind: "session-root" }).slice(0, 32));
}

function deterministicGoalId(sessionId: SessionId): GoalId {
	return createRuntimeId("goal", canonicalDigest({ sessionId, kind: "session-root-goal" }).slice(0, 32));
}

function deterministicRootAgentId(sessionId: SessionId): AgentId {
	return createRuntimeId("agent", canonicalDigest({ sessionId, kind: "session-root-agent" }).slice(0, 32));
}

function sessionIdOf(event: RuntimeEventV3): SessionId {
	if (event.stream.scope !== "session") throw new TypeError("session reducer received an authority/tenant stream event");
	return event.stream.sessionId;
}

function failure<T>(error: SessionKernelError): SessionResult<T> {
	return { ok: false, error };
}

function invalidEvent<T>(message: string, details?: SessionKernelError["details"]): SessionResult<T> {
	return failure({ code: "invalid_event", message, retryable: false, ...(details ? { details } : {}) });
}

function stopped<T>(message: string, details?: SessionKernelError["details"]): SessionResult<T> {
	return failure({ code: "stopped", message, retryable: false, ...(details ? { details } : {}) });
}

function parsePayloadId<K extends RuntimeIdKind>(
	kind: K,
	value: unknown,
	event: RuntimeEventV3,
): SessionResult<RuntimeId<K>> {
	if (typeof value !== "string") {
		return invalidEvent(`event ${event.type} contains a non-string ${kind} id`, {
			sequence: event.sequence,
			eventType: event.type,
		});
	}
	const parsed = parseRuntimeId(kind, value);
	if (parsed) return { ok: true, value: parsed };
	return invalidEvent(`event ${event.type} contains an invalid ${kind} id`, {
		sequence: event.sequence,
		eventType: event.type,
	});
}

function createGenesis(event: RuntimeEventV3): SessionResult<SessionGenesisProjection> {
	if (event.type === "session.migration_started" && event.payload.importSchema !== LEGACY_MIGRATION_SCHEMA) {
		return invalidEvent("legacy migration import schema is not supported", {
			sequence: event.sequence,
			importSchema: event.payload.importSchema,
		});
	}
	if (
		event.type === "session.migration_started" &&
		decodeLegacyMigrationConfiguration(
			event.payload.configurationJson,
			event.payload.configurationDigest,
		) === undefined
	) {
		return invalidEvent("legacy migration runtime configuration is not canonical or digest-bound", {
			sequence: event.sequence,
		});
	}
	if (
		event.type === "session.migration_started" &&
		legacyMigrationManifestDigest(legacyMigrationManifestFromStarted(event.payload)) !== event.payload.manifestDigest
	) {
		return invalidEvent("legacy migration manifest digest does not match its declared source and import set", {
			sequence: event.sequence,
		});
	}
	switch (event.type) {
		case "session.created": {
			const runtimeId = parsePayloadId("runtime", event.payload.runtimeId, event);
			if (!runtimeId.ok) return runtimeId;
			const initialGoalId = parsePayloadId("goal", event.payload.initialGoalId, event);
			if (!initialGoalId.ok) return initialGoalId;
			const rootAgentId = parsePayloadId("agent", event.payload.rootAgentId, event);
			if (!rootAgentId.ok) return rootAgentId;
			const sessionId = sessionIdOf(event);
			return {
				ok: true,
				value: {
					kind: "created",
					eventId: event.eventId,
					sequence: event.sequence,
					runtimeId: runtimeId.value,
					origin: event.payload.origin,
					initialGoalId: initialGoalId.value,
					rootAgentId: rootAgentId.value,
					initialLeafId: initialLeafId(sessionId),
				},
			};
		}
		case "session.forked": {
			const parentSessionId = parsePayloadId("session", event.payload.parentSessionId, event);
			if (!parentSessionId.ok) return parentSessionId;
			const parentLeafId = parsePayloadId("leaf", event.payload.parentLeafId, event);
			if (!parentLeafId.ok) return parentLeafId;
			const initialGoalId = parsePayloadId("goal", event.payload.initialGoalId, event);
			if (!initialGoalId.ok) return initialGoalId;
			const rootAgentId = parsePayloadId("agent", event.payload.rootAgentId, event);
			if (!rootAgentId.ok) return rootAgentId;
			const parentRootAgentId = parsePayloadId("agent", event.payload.parentRootAgentId, event);
			if (!parentRootAgentId.ok) return parentRootAgentId;
			if (parentSessionId.value === sessionIdOf(event)) {
				return invalidEvent("fork genesis must reference a distinct parent session", { sequence: event.sequence });
			}
			if (rootAgentId.value === parentRootAgentId.value) {
				return invalidEvent("fork genesis must create a distinct root agent", { sequence: event.sequence });
			}
			return {
				ok: true,
				value: {
					kind: "forked",
					eventId: event.eventId,
					sequence: event.sequence,
					parentSessionId: parentSessionId.value,
					parentSequence: event.payload.parentSequence,
					parentEventHash: event.payload.parentEventHash,
					parentLeafId: parentLeafId.value,
					goalMode: event.payload.goalMode,
					initialGoalId: initialGoalId.value,
					rootAgentId: rootAgentId.value,
					parentRootAgentId: parentRootAgentId.value,
					initialLeafId: initialLeafId(sessionIdOf(event)),
				},
			};
		}
		case "session.migration_started":
			return {
				ok: true,
				value: {
					kind: "migration",
					eventId: event.eventId,
					sequence: event.sequence,
					mode: event.payload.mode,
					sourceVersion: event.payload.sourceVersion,
					sourceDigest: event.payload.sourceDigest,
					sourceSize: event.payload.sourceSize,
					headerDigest: event.payload.headerDigest,
					sourceSessionId: event.payload.sourceSessionId,
					importerVersion: event.payload.importerVersion,
					importSchema: event.payload.importSchema,
					configurationJson: event.payload.configurationJson,
					configurationDigest: event.payload.configurationDigest,
					recoveredFields: [...event.payload.recoveredFields],
					lostFields: [...event.payload.lostFields],
					manifestDigest: event.payload.manifestDigest,
					initialGoalId: deterministicGoalId(sessionIdOf(event)),
					rootAgentId: deterministicRootAgentId(sessionIdOf(event)),
					initialLeafId: initialLeafId(sessionIdOf(event)),
				},
			};
		default:
			return invalidEvent("session projection must start from a create, fork, or migration event", {
				sequence: event.sequence,
				eventType: event.type,
			});
	}
}

function createInitialProjection(event: RuntimeEventV3): SessionResult<MutableProjection> {
	if (event.sequence !== 0) {
		return failure({
			code: "sequence_conflict",
			message: "session genesis must have sequence zero",
			retryable: false,
			details: { actualSequence: event.sequence },
		});
	}
	const genesis = createGenesis(event);
	if (!genesis.ok) return genesis;
	const rootLeafId = genesis.value.initialLeafId;
	const migration: LegacyMigrationProjection | null = event.type === "session.migration_started"
		? {
				status: "in_progress",
				manifestDigest: event.payload.manifestDigest,
				expectedRecordCount: event.payload.expectedRecordCount,
				expectedRecordSetDigest: event.payload.expectedRecordSetDigest,
				configurationJson: event.payload.configurationJson,
				configurationDigest: event.payload.configurationDigest,
				recoveredFields: [...event.payload.recoveredFields],
				lostFields: [...event.payload.lostFields],
				records: [],
				terminalSequence: null,
				failureReasonCode: null,
			}
		: null;
	return {
		ok: true,
		value: {
			authorityId: event.authorityId,
			tenantId: event.tenantId,
				principalId: event.principalId,
				sessionId: sessionIdOf(event),
				stream: event.stream as SessionProjectionState["stream"],
			genesis: genesis.value,
			migration,
			lifecycleHeadRef: null,
			lifecycle: migration ? "migration_in_progress" : "active",
			terminalEventId: null,
			activeTurnId: null,
			activeModelRequestId: null,
			turns: [],
			modelRequests: [],
			toolCalls: [],
			queueItems: [],
			checkpoints: [],
			activeLeafId: rootLeafId,
			knownLeafIds: [rootLeafId],
			headSequence: event.sequence,
			headEventId: event.eventId,
			headEventHash: event.currentEventHash,
			headTraceId: event.traceId,
		},
	};
}

function findTurn(state: MutableProjection, turnId: TurnId): number {
	return state.turns.findIndex((turn) => turn.turnId === turnId);
}

function findModelRequest(state: MutableProjection, requestId: ModelRequestId): number {
	return state.modelRequests.findIndex((request) => request.requestId === requestId);
}

function findToolCall(state: MutableProjection, toolCallId: ToolCallId): number {
	return state.toolCalls.findIndex((toolCall) => toolCall.toolCallId === toolCallId);
}

function findQueueItem(state: MutableProjection, queueItemId: QueueItemId): number {
	return state.queueItems.findIndex((item) => item.queueItemId === queueItemId);
}

function findCheckpoint(state: MutableProjection, checkpointId: CheckpointId): number {
	return state.checkpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
}

function hasOpenToolCall(state: MutableProjection, turnId: TurnId): boolean {
	return state.toolCalls.some(
		(toolCall) =>
			toolCall.turnId === turnId &&
			(toolCall.status === "requested" || toolCall.status === "authorized" || toolCall.status === "started"),
	);
}

function requireActiveTurn(state: MutableProjection, rawTurnId: string, event: RuntimeEventV3): SessionResult<TurnId> {
	const turnId = parsePayloadId("turn", rawTurnId, event);
	if (!turnId.ok) return turnId;
	if (state.activeTurnId !== turnId.value) {
		return invalidEvent(`event ${event.type} does not match the active turn`, {
			sequence: event.sequence,
			eventType: event.type,
			expectedTurnId: state.activeTurnId ?? "none",
			actualTurnId: turnId.value,
		});
	}
	return turnId;
}

function ensureNoOpenTurnOperations(state: MutableProjection, turnId: TurnId, event: RuntimeEventV3): SessionResult<void> {
	const activeModel = state.modelRequests.some(
		(request) => request.turnId === turnId && request.status === "requested",
	);
	const activeTool = hasOpenToolCall(state, turnId);
	if (activeModel || activeTool) {
		return invalidEvent(`event ${event.type} terminates a turn with unfinished model or tool work`, {
			sequence: event.sequence,
			eventType: event.type,
			activeModel,
			activeTool,
		});
	}
	return { ok: true, value: undefined };
}

function migrationRecordSetDigest(migration: LegacyMigrationProjection): string {
	return canonicalDigest(migration.records.map((record) => record.recordDigest));
}

function migrationFieldSummary(
	migration: LegacyMigrationProjection,
	field: "recoveredFields" | "lostFields",
): readonly string[] {
	return [...new Set(migration.records.flatMap((record) => record[field]))].sort();
}

function reduceMigration(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "session.legacy_message_imported": {
			const migration = state.migration;
			if (!migration || migration.status !== "in_progress" || state.lifecycle !== "migration_in_progress") {
				return invalidEvent("legacy import record requires an in-progress migration", {
					sequence: event.sequence,
				});
			}
			if (
				event.payload.manifestDigest !== migration.manifestDigest ||
				state.genesis.kind !== "migration" ||
				event.payload.sourceVersion !== state.genesis.sourceVersion
			) {
				return invalidEvent("legacy import record does not match its migration manifest", {
					sequence: event.sequence,
					sourceIndex: event.payload.sourceIndex,
				});
			}
			if (event.payload.sourceIndex !== migration.records.length) {
				return invalidEvent("legacy import source indexes must be contiguous and start at zero", {
					sequence: event.sequence,
					sourceIndex: event.payload.sourceIndex,
				});
			}
			if (migration.records.some((record) => record.sourceEntryId === event.payload.sourceEntryId)) {
				return invalidEvent("legacy import source entry ids must be unique", {
					sequence: event.sequence,
					sourceEntryId: event.payload.sourceEntryId,
				});
			}
			if (migration.records.length >= migration.expectedRecordCount) {
				return invalidEvent("legacy migration imported more records than its manifest declared", {
					sequence: event.sequence,
				});
			}
			state.migration = {
				...migration,
				records: [
					...migration.records,
					{
						sourceIndex: event.payload.sourceIndex,
						sourceEntryId: event.payload.sourceEntryId,
						sourceRecordDigest: event.payload.sourceRecordDigest,
						entryType: event.payload.entryType,
						messageKind: event.payload.messageKind,
						contentDigest: event.payload.contentDigest,
						disposition: event.payload.disposition,
						recoveredFields: [...event.payload.recoveredFields],
						lostFields: [...event.payload.lostFields],
						recordDigest: legacyMigrationImportRecordDigest(
							legacyMigrationImportDescriptorFromPayload(event.payload),
						),
					},
				],
			};
			return { ok: true, value: true };
		}
		case "session.migration_committed": {
			const migration = state.migration;
			if (!migration || migration.status !== "in_progress" || state.lifecycle !== "migration_in_progress") {
				return invalidEvent("migration commit requires an in-progress migration", {
					sequence: event.sequence,
				});
			}
			if (
				event.payload.manifestDigest !== migration.manifestDigest ||
				event.payload.expectedRecordCount !== migration.expectedRecordCount ||
				event.payload.importedRecordCount !== migration.records.length ||
				migration.records.length !== migration.expectedRecordCount ||
				event.payload.recordSetDigest !== migration.expectedRecordSetDigest ||
				migrationRecordSetDigest(migration) !== migration.expectedRecordSetDigest ||
				canonicalDigest(migrationFieldSummary(migration, "recoveredFields")) !==
					canonicalDigest([...migration.recoveredFields].sort()) ||
				canonicalDigest(migrationFieldSummary(migration, "lostFields")) !==
					canonicalDigest([...migration.lostFields].sort())
			) {
				return invalidEvent("migration commit does not prove the complete declared import set", {
					sequence: event.sequence,
					importedRecordCount: migration.records.length,
					expectedRecordCount: migration.expectedRecordCount,
				});
			}
			state.migration = {
				...migration,
				status: "committed",
				terminalSequence: event.sequence,
			};
			state.lifecycle = "active";
			return { ok: true, value: true };
		}
		case "session.migration_failed": {
			const migration = state.migration;
			if (!migration || migration.status !== "in_progress" || state.lifecycle !== "migration_in_progress") {
				return invalidEvent("migration failure requires an in-progress migration", {
					sequence: event.sequence,
				});
			}
			if (
				event.payload.manifestDigest !== migration.manifestDigest ||
				event.payload.expectedRecordCount !== migration.expectedRecordCount ||
				event.payload.importedRecordCount !== migration.records.length
			) {
				return invalidEvent("migration failure does not match the durable partial import", {
					sequence: event.sequence,
				});
			}
			state.migration = {
				...migration,
				status: "failed",
				terminalSequence: event.sequence,
				failureReasonCode: event.payload.reasonCode,
			};
			state.lifecycle = "migration_failed";
			state.terminalEventId = event.eventId;
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceSessionLifecycle(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "session.created":
		case "session.forked":
		case "session.migration_started":
			return invalidEvent("session genesis cannot be repeated", {
				sequence: event.sequence,
				eventType: event.type,
			});
		case "session.stop_requested":
			if (state.lifecycle !== "active") {
				return invalidEvent("session stop can only be requested from the active state", {
					sequence: event.sequence,
					lifecycle: state.lifecycle,
				});
			}
			state.lifecycle = "stop_requested";
			return { ok: true, value: true };
		case "session.stopped":
			if (state.lifecycle !== "stop_requested") {
				return invalidEvent("session stopped does not pair with a stop request", {
					sequence: event.sequence,
					lifecycle: state.lifecycle,
				});
			}
			state.lifecycle = "stopped";
			state.terminalEventId = event.eventId;
			return { ok: true, value: true };
		case "session.closed":
			if (state.lifecycle !== "active" && state.lifecycle !== "stopped") {
				return invalidEvent("session close is not valid from the current lifecycle", {
					sequence: event.sequence,
					lifecycle: state.lifecycle,
				});
			}
			state.lifecycle = "closed";
			state.terminalEventId = event.eventId;
			return { ok: true, value: true };
		case "session.corrupted":
			if (
				state.lifecycle !== "active" &&
				state.lifecycle !== "migration_in_progress" &&
				state.lifecycle !== "stop_requested"
			) {
				return invalidEvent("session corruption is not valid from the current lifecycle", {
					sequence: event.sequence,
					lifecycle: state.lifecycle,
				});
			}
			state.lifecycle = "corrupted";
			state.terminalEventId = event.eventId;
			return { ok: true, value: true };
		default:
			return { ok: true, value: false };
	}
}

function reduceTurn(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "turn.started": {
			if (state.activeTurnId !== null) {
				return invalidEvent("a second turn cannot start while another turn is active", {
					sequence: event.sequence,
					activeTurnId: state.activeTurnId,
				});
			}
			const turnId = parsePayloadId("turn", event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			const goalId = parsePayloadId("goal", event.payload.goalId, event);
			if (!goalId.ok) return goalId;
			let queueItemId: QueueItemId | null = null;
			if (event.payload.queueItemId) {
				const parsedQueueItemId = parsePayloadId("queueItem", event.payload.queueItemId, event);
				if (!parsedQueueItemId.ok) return parsedQueueItemId;
				const queueIndex = findQueueItem(state, parsedQueueItemId.value);
				const queueItem = state.queueItems[queueIndex];
				if (queueIndex < 0 || !queueItem || queueItem.status !== "enqueued") {
					return invalidEvent("turn references a queue item that is not pending", {
						sequence: event.sequence,
						queueItemId: parsedQueueItemId.value,
					});
				}
				queueItemId = parsedQueueItemId.value;
			}
			if (findTurn(state, turnId.value) >= 0) {
				return invalidEvent("turn id cannot be reused", { sequence: event.sequence, turnId: turnId.value });
			}
			state.turns.push({
				turnId: turnId.value,
				goalId: goalId.value,
				queueItemId,
				status: "active",
				startedSequence: event.sequence,
				terminalSequence: null,
			});
			state.activeTurnId = turnId.value;
			return { ok: true, value: true };
		}
		case "turn.finished":
		case "turn.interrupted":
		case "turn.failed": {
			const turnId = requireActiveTurn(state, event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			const settled = ensureNoOpenTurnOperations(state, turnId.value, event);
			if (!settled.ok) return settled;
			const index = findTurn(state, turnId.value);
			if (index < 0) return invalidEvent("turn terminal event has no matching start", { sequence: event.sequence });
			const current = state.turns[index];
			if (!current || current.status !== "active") {
				return invalidEvent("turn terminal event does not match an active turn", { sequence: event.sequence });
			}
			const status =
				event.type === "turn.finished" ? "finished" : event.type === "turn.interrupted" ? "interrupted" : "failed";
			state.turns[index] = { ...current, status, terminalSequence: event.sequence };
			state.activeTurnId = null;
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceModel(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "model.routed": {
			const turnId = requireActiveTurn(state, event.payload.turnId, event);
			return turnId.ok ? { ok: true, value: true } : turnId;
		}
		case "model.requested": {
			const turnId = requireActiveTurn(state, event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			if (state.activeModelRequestId !== null) {
				return invalidEvent("a second model request cannot start while another request is active", {
					sequence: event.sequence,
					activeRequestId: state.activeModelRequestId,
				});
			}
			if (hasOpenToolCall(state, turnId.value)) {
				return invalidEvent("a model request cannot start before active tool work reaches a terminal event", {
					sequence: event.sequence,
					turnId: turnId.value,
				});
			}
			const requestId = parsePayloadId("modelRequest", event.payload.requestId, event);
			if (!requestId.ok) return requestId;
			if (findModelRequest(state, requestId.value) >= 0) {
				return invalidEvent("model request id cannot be reused", {
					sequence: event.sequence,
					requestId: event.payload.requestId,
				});
			}
			const activeTurn = state.turns.find((turn) => turn.turnId === turnId.value);
			if (activeTurn?.queueItemId) {
				const queueItem = state.queueItems.find((item) => item.queueItemId === activeTurn.queueItemId);
				if (queueItem?.modelRequestId !== null && queueItem?.modelRequestId !== requestId.value) {
					return invalidEvent("model request does not match the durable queue claim", {
						sequence: event.sequence,
						queueItemId: activeTurn.queueItemId,
						expectedModelRequestId: queueItem?.modelRequestId ?? "none",
						actualModelRequestId: requestId.value,
					});
				}
			}
			state.modelRequests.push({
				requestId: requestId.value,
				turnId: turnId.value,
				modelId: event.payload.modelId,
				contextDigest: event.payload.contextDigest,
				status: "requested",
				requestedSequence: event.sequence,
				terminalSequence: null,
				uncertain: true,
			});
			state.activeModelRequestId = requestId.value;
			return { ok: true, value: true };
		}
		case "model.finished":
		case "model.failed": {
			const turnId = requireActiveTurn(state, event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			const requestId = parsePayloadId("modelRequest", event.payload.requestId, event);
			if (!requestId.ok) return requestId;
			if (state.activeModelRequestId !== requestId.value) {
				return invalidEvent("model terminal event does not match the active request", {
					sequence: event.sequence,
					expectedRequestId: state.activeModelRequestId ?? "none",
					actualRequestId: event.payload.requestId,
				});
			}
			const index = findModelRequest(state, requestId.value);
			const current = state.modelRequests[index];
			if (index < 0 || !current || current.turnId !== turnId.value || current.status !== "requested") {
				return invalidEvent("model terminal event has no matching request", { sequence: event.sequence });
			}
			state.modelRequests[index] = {
				...current,
				status: event.type === "model.finished" ? "finished" : "failed",
				terminalSequence: event.sequence,
				uncertain: false,
			};
			state.activeModelRequestId = null;
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceTool(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "tool.requested": {
			const turnId = requireActiveTurn(state, event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			if (state.activeModelRequestId !== null) {
				return invalidEvent("a tool call cannot start before the active model request reaches a terminal event", {
					sequence: event.sequence,
					activeRequestId: state.activeModelRequestId,
				});
			}
			const toolCallId = parsePayloadId("toolCall", event.payload.toolCallId, event);
			if (!toolCallId.ok) return toolCallId;
			const agentId = parsePayloadId("agent", event.payload.agentId, event);
			if (!agentId.ok) return agentId;
			if (findToolCall(state, toolCallId.value) >= 0) {
				return invalidEvent("tool call id cannot be reused", {
					sequence: event.sequence,
					toolCallId: toolCallId.value,
				});
			}
			state.toolCalls.push({
				toolCallId: toolCallId.value,
				turnId: turnId.value,
				agentId: agentId.value,
				status: "requested",
				requestedSequence: event.sequence,
				terminalSequence: null,
				uncertain: true,
			});
			return { ok: true, value: true };
		}
		case "tool.authorized":
		case "tool.started":
		case "tool.finished":
		case "tool.interrupted":
		case "tool.failed": {
			const toolCallId = parsePayloadId("toolCall", event.payload.toolCallId, event);
			if (!toolCallId.ok) return toolCallId;
			const index = findToolCall(state, toolCallId.value);
			const current = state.toolCalls[index];
			if (index < 0 || !current) {
				return invalidEvent("tool event has no matching request", {
					sequence: event.sequence,
					toolCallId: toolCallId.value,
				});
			}
			if (event.type === "tool.authorized") {
				if (current.status !== "requested") {
					return invalidEvent("tool authorization does not match a requested tool", { sequence: event.sequence });
				}
				state.toolCalls[index] = { ...current, status: "authorized" };
				return { ok: true, value: true };
			}
			if (event.type === "tool.started") {
				if (current.status !== "authorized") {
					return invalidEvent("tool start does not match an authorized tool", { sequence: event.sequence });
				}
				state.toolCalls[index] = { ...current, status: "started" };
				return { ok: true, value: true };
			}
			if (event.type === "tool.finished") {
				if (current.status !== "started") {
					return invalidEvent("tool finish does not match a started tool", { sequence: event.sequence });
				}
				state.toolCalls[index] = {
					...current,
					status: "finished",
					terminalSequence: event.sequence,
					uncertain: false,
				};
				return { ok: true, value: true };
			}
			if (current.status !== "requested" && current.status !== "authorized" && current.status !== "started") {
				return invalidEvent("tool terminal event does not match active tool work", { sequence: event.sequence });
			}
			state.toolCalls[index] = {
				...current,
				status: event.type === "tool.interrupted" ? "interrupted" : "failed",
				terminalSequence: event.sequence,
				uncertain: !event.payload.outcomeCertain,
			};
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceQueue(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
	case "queue.enqueued": {
			const queueItemId = parsePayloadId("queueItem", event.payload.queueItemId, event);
			if (!queueItemId.ok) return queueItemId;
			const sourceCommandId = parsePayloadId("command", event.payload.sourceCommandId, event);
			if (!sourceCommandId.ok) return sourceCommandId;
			if (findQueueItem(state, queueItemId.value) >= 0) {
				return invalidEvent("queue item id cannot be reused", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
				if (
					event.sequence === 0 ||
					!sameRuntimeEventStream(event.payload.enqueueRevision.stream, event.stream) ||
				event.payload.enqueueRevision.sequence !== event.sequence - 1 ||
				event.payload.enqueueRevision.eventHash !== event.previousEventHash
			) {
				return invalidEvent("queue enqueue revision must bind the immediately preceding session head", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				event.payload.contentDigest !== canonicalDigest(event.payload.content) ||
				(event.payload.content.storage === "artifact" &&
					(event.payload.content.artifact.authorityId !== event.authorityId ||
						event.payload.content.artifact.tenantId !== event.tenantId))
			) {
				return invalidEvent("queue content digest or artifact scope is invalid", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			const target = event.payload.targetTurnRevision;
				if (
					target !== null &&
					(!sameRuntimeEventStream(target.sessionRevision.stream, event.payload.enqueueRevision.stream) ||
					target.sessionRevision.sequence !== event.payload.enqueueRevision.sequence ||
					target.sessionRevision.eventHash !== event.payload.enqueueRevision.eventHash ||
					state.activeTurnId !== target.turnId)
			) {
				return invalidEvent("queue target turn revision is stale or does not match the active turn", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				(event.payload.kind === "steer" && event.payload.nextTurnPolicy !== "next_model_turn") ||
				(event.payload.kind === "follow_up" && event.payload.nextTurnPolicy !== "after_active_run")
			) {
				return invalidEvent("queue kind, target turn, and next-turn policy are inconsistent", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			state.queueItems.push({
				queueItemId: queueItemId.value,
				sourceCommandId: sourceCommandId.value,
				kind: event.payload.kind,
					enqueueRevision: {
						stream: event.stream,
					sequence: event.payload.enqueueRevision.sequence,
					eventHash: event.payload.enqueueRevision.eventHash,
				},
				targetTurnRevision: target === null ? null : {
					turnId: target.turnId as TurnId,
						sessionRevision: {
							stream: event.stream,
						sequence: target.sessionRevision.sequence,
						eventHash: target.sessionRevision.eventHash,
					},
				},
				nextTurnPolicy: event.payload.nextTurnPolicy,
				contentDigest: event.payload.contentDigest,
				content: event.payload.content,
				status: "enqueued",
				enqueuedSequence: event.sequence,
				claimedSequence: null,
				consumedSequence: null,
				cancelledSequence: null,
				turnId: null,
				modelRequestId: null,
			});
			return { ok: true, value: true };
		}
		case "queue.claimed": {
			const queueItemId = parsePayloadId("queueItem", event.payload.queueItemId, event);
			if (!queueItemId.ok) return queueItemId;
			const sourceCommandId = parsePayloadId("command", event.payload.sourceCommandId, event);
			if (!sourceCommandId.ok) return sourceCommandId;
			const index = findQueueItem(state, queueItemId.value);
			const current = state.queueItems[index];
			if (index < 0 || !current || current.status !== "enqueued") {
				return invalidEvent("queue claim has no matching pending item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				current.sourceCommandId !== sourceCommandId.value ||
				current.kind !== event.payload.kind ||
				current.contentDigest !== event.payload.contentDigest
			) {
				return invalidEvent("queue claim source, kind, or content digest does not match the pending item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			const turnId = parsePayloadId("turn", event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			const turn = state.turns.find((candidate) => candidate.turnId === turnId.value);
			if (!turn || turn.status !== "active" || turn.queueItemId !== queueItemId.value) {
				return invalidEvent("queue claim must reference the active turn bound to the item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
					turnId: turnId.value,
				});
			}
			const modelRequestId = parsePayloadId("modelRequest", event.payload.modelRequestId, event);
			if (!modelRequestId.ok) return modelRequestId;
			if (
				findModelRequest(state, modelRequestId.value) >= 0 ||
				state.queueItems.some((item) => item.modelRequestId === modelRequestId.value)
			) {
				return invalidEvent("queue claim model request id cannot be reused", {
					sequence: event.sequence,
					modelRequestId: modelRequestId.value,
				});
			}
			state.queueItems[index] = {
				...current,
				status: "claimed",
				claimedSequence: event.sequence,
				turnId: turnId.value,
				modelRequestId: modelRequestId.value,
			};
			return { ok: true, value: true };
		}
		case "queue.consumed": {
			const queueItemId = parsePayloadId("queueItem", event.payload.queueItemId, event);
			if (!queueItemId.ok) return queueItemId;
			const sourceCommandId = parsePayloadId("command", event.payload.sourceCommandId, event);
			if (!sourceCommandId.ok) return sourceCommandId;
			const index = findQueueItem(state, queueItemId.value);
			const current = state.queueItems[index];
			if (index < 0 || !current || (current.status !== "enqueued" && current.status !== "claimed")) {
				return invalidEvent("queue consume has no matching pending item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				current.sourceCommandId !== sourceCommandId.value ||
				current.kind !== event.payload.kind ||
				current.contentDigest !== event.payload.contentDigest
			) {
				return invalidEvent("queue consume source, kind, or content digest does not match the pending item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			const turnId = parsePayloadId("turn", event.payload.turnId, event);
			if (!turnId.ok) return turnId;
			if (state.activeTurnId !== turnId.value || findTurn(state, turnId.value) < 0) {
				return invalidEvent("queue consume must reference the active existing turn", {
					sequence: event.sequence,
					turnId: turnId.value,
				});
			}
			if (current.turnId !== null && current.turnId !== turnId.value) {
				return invalidEvent("queue consume turn does not match its durable claim", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			const modelRequestId = parsePayloadId("modelRequest", event.payload.modelRequestId, event);
			if (!modelRequestId.ok) return modelRequestId;
			const modelRequest = state.modelRequests.find((request) => request.requestId === modelRequestId.value);
			if (
				(current.modelRequestId !== null && current.modelRequestId !== modelRequestId.value) ||
				!modelRequest ||
				modelRequest.turnId !== turnId.value
			) {
				return invalidEvent("queue consume model request does not match its durable claim", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			state.queueItems[index] = {
				...current,
				status: "consumed",
				consumedSequence: event.sequence,
				turnId: turnId.value,
				modelRequestId: modelRequestId.value,
			};
			return { ok: true, value: true };
		}
		case "queue.cancelled": {
			const queueItemId = parsePayloadId("queueItem", event.payload.queueItemId, event);
			if (!queueItemId.ok) return queueItemId;
			const sourceCommandId = parsePayloadId("command", event.payload.sourceCommandId, event);
			if (!sourceCommandId.ok) return sourceCommandId;
			const index = findQueueItem(state, queueItemId.value);
			const current = state.queueItems[index];
			if (index < 0 || !current || (current.status !== "enqueued" && current.status !== "claimed")) {
				return invalidEvent("queue cancellation has no matching non-terminal item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				current.sourceCommandId !== sourceCommandId.value ||
				current.kind !== event.payload.kind ||
				current.contentDigest !== event.payload.contentDigest
			) {
				return invalidEvent("queue cancellation source, kind, or content digest does not match the pending item", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			if (
				current.modelRequestId !== null &&
				state.modelRequests.some((request) => request.requestId === current.modelRequestId)
			) {
				return invalidEvent("queue item cannot be cancelled after its model request was recorded", {
					sequence: event.sequence,
					queueItemId: event.payload.queueItemId,
				});
			}
			state.queueItems[index] = {
				...current,
				status: "cancelled",
				cancelledSequence: event.sequence,
			};
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceCheckpoint(state: MutableProjection, event: RuntimeEventV3): SessionResult<boolean> {
	switch (event.type) {
		case "checkpoint.created": {
			if (
				state.activeTurnId !== null ||
				state.activeModelRequestId !== null ||
				state.modelRequests.some((request) => request.uncertain) ||
				state.toolCalls.some((toolCall) => toolCall.uncertain)
			) return invalidEvent("checkpoint creation requires a stable operation boundary", { sequence: event.sequence });
			const checkpointId = parsePayloadId("checkpoint", event.payload.checkpointId, event);
			if (!checkpointId.ok) return checkpointId;
			const activeLeafId = parsePayloadId("leaf", event.payload.activeLeafId, event);
			if (!activeLeafId.ok) return activeLeafId;
			if (findCheckpoint(state, checkpointId.value) >= 0) {
				return invalidEvent("checkpoint id cannot be reused", {
					sequence: event.sequence,
					checkpointId: checkpointId.value,
				});
			}
			if (event.payload.sequence !== state.headSequence || event.payload.eventHash !== state.headEventHash) {
				return invalidEvent("checkpoint cursor does not match the pre-event projection head", {
					sequence: event.sequence,
					expectedSequence: state.headSequence,
					actualSequence: event.payload.sequence,
				});
			}
			if (activeLeafId.value !== state.activeLeafId || !state.knownLeafIds.includes(activeLeafId.value)) {
				return invalidEvent("checkpoint active leaf does not match the connected session leaf", {
					sequence: event.sequence,
					activeLeafId: activeLeafId.value,
					expectedLeafId: state.activeLeafId,
				});
			}
			const digest = digestProjectionState(state);
			if (!digest.ok) return digest;
			if (event.payload.reducerDigest !== digest.value) {
				return invalidEvent("checkpoint reducer digest does not match the pre-event projection", {
					sequence: event.sequence,
				});
			}
			state.checkpoints.push({
				checkpointId: checkpointId.value,
				status: "created",
				eventSequence: event.payload.sequence,
				eventHash: event.payload.eventHash,
				reducerDigest: event.payload.reducerDigest,
				activeLeafId: activeLeafId.value,
				createdSequence: event.sequence,
				rewoundSequence: null,
				fromLeafId: null,
				toLeafId: null,
			});
			return { ok: true, value: true };
		}
		case "checkpoint.rewound": {
			if (
				state.activeTurnId !== null ||
				state.activeModelRequestId !== null ||
				state.modelRequests.some((request) => request.uncertain) ||
				state.toolCalls.some((toolCall) => toolCall.uncertain)
			) return invalidEvent("checkpoint rewind requires a stable operation boundary", { sequence: event.sequence });
			const checkpointId = parsePayloadId("checkpoint", event.payload.checkpointId, event);
			if (!checkpointId.ok) return checkpointId;
			const index = findCheckpoint(state, checkpointId.value);
			const current = state.checkpoints[index];
			if (index < 0 || !current || current.status !== "created") {
				return invalidEvent("checkpoint rewind has no matching created checkpoint", {
					sequence: event.sequence,
					checkpointId: checkpointId.value,
				});
			}
			const fromLeafId = parsePayloadId("leaf", event.payload.fromLeafId, event);
			if (!fromLeafId.ok) return fromLeafId;
			const toLeafId = parsePayloadId("leaf", event.payload.toLeafId, event);
			if (!toLeafId.ok) return toLeafId;
			if (fromLeafId.value !== state.activeLeafId || !state.knownLeafIds.includes(fromLeafId.value)) {
				return invalidEvent("checkpoint rewind source is not the active connected leaf", {
					sequence: event.sequence,
					fromLeafId: fromLeafId.value,
					expectedLeafId: state.activeLeafId,
				});
			}
			if (state.knownLeafIds.includes(toLeafId.value)) {
				return invalidEvent("checkpoint rewind target leaf must be new", {
					sequence: event.sequence,
					toLeafId: toLeafId.value,
				});
			}
			state.checkpoints[index] = {
				...current,
				status: "rewound",
				rewoundSequence: event.sequence,
				fromLeafId: fromLeafId.value,
				toLeafId: toLeafId.value,
			};
			state.activeLeafId = toLeafId.value;
			state.knownLeafIds.push(toLeafId.value);
			return { ok: true, value: true };
		}
		default:
			return { ok: true, value: false };
	}
}

function reduceEvent(state: MutableProjection, event: RuntimeEventV3): SessionResult<void> {
	if (
		event.authorityId !== state.authorityId ||
		event.tenantId !== state.tenantId ||
			sessionIdOf(event) !== state.sessionId
	) {
		return failure({
			code: "identity_mismatch",
			message: "event authority, tenant, or session does not match the projection",
			retryable: false,
			details: { sequence: event.sequence },
		});
	}
	if (event.sequence !== state.headSequence + 1) {
		return failure({
			code: "sequence_conflict",
			message: "event sequence is discontinuous during projection",
			retryable: false,
			details: { expectedSequence: state.headSequence + 1, actualSequence: event.sequence },
		});
	}
	if (
		state.lifecycle === "closed" ||
		state.lifecycle === "corrupted" ||
		state.lifecycle === "migration_failed"
	) {
		return stopped("events cannot follow a terminal session event", {
			sequence: event.sequence,
			lifecycle: state.lifecycle,
		});
	}
	if (state.lifecycle === "stopped" && event.type !== "session.closed") {
		return stopped("only session close may follow a durable stop", {
			sequence: event.sequence,
			eventType: event.type,
		});
	}
	if (
		state.lifecycle === "stop_requested" &&
		event.type !== "session.stopped" &&
		event.type !== "session.corrupted"
	) {
		return stopped("new work cannot follow a durable stop request", {
			sequence: event.sequence,
			eventType: event.type,
		});
	}
	if (
		state.lifecycle === "migration_in_progress" &&
		event.type !== "session.legacy_message_imported" &&
		event.type !== "session.migration_committed" &&
		event.type !== "session.migration_failed" &&
		event.type !== "session.corrupted"
	) {
		return stopped("only migration records or a migration terminal may follow migration_started", {
			sequence: event.sequence,
			eventType: event.type,
		});
	}

	const migration = reduceMigration(state, event);
	if (!migration.ok) return migration;
	if (!migration.value) {
		const lifecycle = reduceSessionLifecycle(state, event);
		if (!lifecycle.ok) return lifecycle;
		if (!lifecycle.value) {
			const turn = reduceTurn(state, event);
			if (!turn.ok) return turn;
			if (!turn.value) {
				const model = reduceModel(state, event);
				if (!model.ok) return model;
				if (!model.value) {
					const tool = reduceTool(state, event);
					if (!tool.ok) return tool;
					if (!tool.value) {
						const queue = reduceQueue(state, event);
						if (!queue.ok) return queue;
						if (!queue.value) {
							const checkpoint = reduceCheckpoint(state, event);
							if (!checkpoint.ok) return checkpoint;
						}
					}
				}
			}
		}
	}

	state.headSequence = event.sequence;
	state.headEventId = event.eventId;
	state.headEventHash = event.currentEventHash;
	state.headTraceId = event.traceId;
	return { ok: true, value: undefined };
}

function toProjectionState(state: MutableProjection): SessionProjectionState {
	return {
		authorityId: state.authorityId,
		tenantId: state.tenantId,
		principalId: state.principalId,
		sessionId: state.sessionId,
		stream: state.stream,
		genesis: state.genesis,
		migration: state.migration,
		lifecycleHeadRef: state.lifecycleHeadRef,
		lifecycle: state.lifecycle,
		terminalEventId: state.terminalEventId,
		activeTurnId: state.activeTurnId,
		activeModelRequestId: state.activeModelRequestId,
		turns: state.turns,
		modelRequests: state.modelRequests,
		toolCalls: state.toolCalls,
		queueItems: state.queueItems,
		checkpoints: state.checkpoints,
		activeLeafId: state.activeLeafId,
		knownLeafIds: state.knownLeafIds,
		hasUncertainOperations:
			state.modelRequests.some((request) => request.uncertain) ||
			state.toolCalls.some((toolCall) => toolCall.uncertain),
		headSequence: state.headSequence,
		headEventId: state.headEventId,
		headEventHash: state.headEventHash,
		headTraceId: state.headTraceId,
	};
}

function digestProjectionState(state: MutableProjection): SessionResult<string> {
	try {
		return { ok: true, value: canonicalDigest(toProjectionState(state)) };
	} catch (error) {
		return invalidEvent("session projection cannot be canonically encoded", {
			errorName: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

function finalizeProjection(state: MutableProjection): SessionResult<SessionProjection> {
	const projectionState = toProjectionState(state);
	const digest = digestProjectionState(state);
	if (!digest.ok) return digest;
	return { ok: true, value: { ...projectionState, projectionDigest: digest.value } };
}

export function reduceSessionEvents(events: readonly RuntimeEventV3[]): SessionResult<SessionProjection> {
	const first = events[0];
	if (!first) return invalidEvent("session projection requires a genesis event");
	if (first.stream.scope !== "session") return invalidEvent("session projection requires a session-scoped genesis");
	if (events.some((event) => !sameRuntimeEventStream(event.stream, first.stream))) {
		return invalidEvent("session projection requires one session-scoped stream");
	}
	const initial = createInitialProjection(first);
	if (!initial.ok) return initial;
	const state = initial.value;
	for (let index = 1; index < events.length; index += 1) {
		const event = events[index];
		if (!event) continue;
		const reduced = reduceEvent(state, event);
		if (!reduced.ok) return reduced;
	}
	return finalizeProjection(state);
}

export const SessionReducer = {
	reduce: reduceSessionEvents,
} as const;
