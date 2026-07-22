import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../../../src/runtime/protocol/v3/event-catalog.ts";
import {
	createSessionEventStreamRef,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventEnvelopeV3,
	type RuntimeEventV3,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	LEGACY_MIGRATION_SCHEMA,
	legacyMigrationManifestDigest,
	legacyMigrationRecordSetDigest,
} from "../../../src/runtime/session/legacy-migration-manifest.ts";
import { reduceSessionEvents } from "../../../src/runtime/session/reducer.ts";
import type { SessionProjection } from "../../../src/runtime/session/projections.ts";
import type { SessionResult } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const AUTHORITY_ID = createRuntimeId("authority", "fixture");
const TENANT_ID = createRuntimeId("tenant", "fixture");
const PRINCIPAL_ID = createRuntimeId("principal", "fixture");
const SESSION_ID = createRuntimeId("session", "fixture");
const STREAM = createSessionEventStreamRef({ authorityId: AUTHORITY_ID, tenantId: TENANT_ID }, SESSION_ID);
const RUNTIME_ID = createRuntimeId("runtime", "fixture");
const GOAL_ID = createRuntimeId("goal", "fixture");
const AGENT_ID = createRuntimeId("agent", "fixture");

function hashFor(sequence: number): string {
	return sequence.toString(16).padStart(64, "0");
}

function event<TType extends RuntimeEventType>(
	type: TType,
	sequence: number,
	payload: RuntimeEventPayloadMap[TType],
): RuntimeEventEnvelopeV3<TType> {
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: AUTHORITY_ID,
		tenantId: TENANT_ID,
		principalId: PRINCIPAL_ID,
		eventId: createRuntimeId("event", `fixture-${sequence}`),
		stream: STREAM,
		sequence,
		timestamp: "2026-07-22T00:00:00.000Z",
		type,
		previousEventHash: sequence === 0 ? null : hashFor(sequence - 1),
		payloadDigest: DIGEST,
		currentEventHash: hashFor(sequence),
		traceId: createRuntimeId("trace", `fixture-${sequence}`),
		payload,
	};
}

function created(sequence = 0): RuntimeEventV3 {
	return event("session.created", sequence, {
		origin: "test",
		runtimeId: RUNTIME_ID,
		featureDigest: DIGEST,
		initialGoalId: GOAL_ID,
		rootAgentId: AGENT_ID,
	});
}

function turnStarted(sequence: number, suffix = "active"): RuntimeEventV3 {
	return event("turn.started", sequence, {
		turnId: createRuntimeId("turn", suffix),
		goalId: GOAL_ID,
	});
}

function resultValue(result: SessionResult<SessionProjection>): SessionProjection {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

function resultError(result: SessionResult<SessionProjection>) {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("expected SessionResult failure");
	return result.error;
}

describe("SessionReducer", () => {
	it("preserves canonical explicit root identities across replay", () => {
		const first = resultValue(reduceSessionEvents([created()]));
		const reopened = resultValue(reduceSessionEvents([created()]));
		expect(reopened.genesis.initialGoalId).toBe(first.genesis.initialGoalId);
		expect(reopened.genesis.rootAgentId).toBe(first.genesis.rootAgentId);

		const explicitGoalId = createRuntimeId("goal", "explicit-root");
		const explicitAgentId = createRuntimeId("agent", "explicit-root");
		const explicit = resultValue(
			reduceSessionEvents([
				event("session.created", 0, {
					origin: "new",
					runtimeId: RUNTIME_ID,
					featureDigest: DIGEST,
					initialGoalId: explicitGoalId,
					rootAgentId: explicitAgentId,
				}),
			]),
		);
		expect(explicit.genesis.initialGoalId).toBe(explicitGoalId);
		expect(explicit.genesis.rootAgentId).toBe(explicitAgentId);
	});

	it("projects exact queue claim, consume, and cancellation lifecycles", () => {
		const messageJson = JSON.stringify({ role: "user", content: [{ type: "text", text: "same" }] });
		const content = { storage: "bounded_text" as const, messageJson };
		const contentDigest = canonicalDigest(content);
		const queueItemId = createRuntimeId("queueItem", "claimed");
		const sourceCommandId = createRuntimeId("command", "enqueue-claimed");
		const turnId = createRuntimeId("turn", "claimed");
		const modelRequestId = createRuntimeId("modelRequest", "claimed");
		const consumed = resultValue(
			reduceSessionEvents([
				created(),
				event("queue.enqueued", 1, {
					queueItemId,
					sourceCommandId,
					kind: "steer",
					enqueueRevision: { stream: STREAM, sequence: 0, eventHash: hashFor(0) },
					targetTurnRevision: null,
					nextTurnPolicy: "next_model_turn",
					contentDigest,
					content,
				}),
				event("turn.started", 2, { turnId, goalId: GOAL_ID, queueItemId }),
				event("queue.claimed", 3, {
					queueItemId,
					sourceCommandId,
					kind: "steer",
					turnId,
					modelRequestId,
					contentDigest,
				}),
				event("model.requested", 4, { turnId, requestId: modelRequestId, modelId: "fixture", contextDigest: DIGEST }),
				event("model.finished", 5, {
					turnId,
					requestId: modelRequestId,
					responseDigest: DIGEST,
					inputTokens: 1,
					outputTokens: 1,
				}),
				event("queue.consumed", 6, { queueItemId, sourceCommandId, kind: "steer", turnId, modelRequestId, contentDigest }),
				event("turn.finished", 7, { turnId, resultDigest: DIGEST, stopReason: "stop" }),
			]),
		);
		expect(consumed.queueItems[0]).toMatchObject({
			status: "consumed",
			content,
			claimedSequence: 3,
			consumedSequence: 6,
			turnId,
			modelRequestId,
		});

		const cancelledId = createRuntimeId("queueItem", "cancelled");
		const cancelledSourceCommandId = createRuntimeId("command", "enqueue-cancelled");
		const cancelled = resultValue(
			reduceSessionEvents([
				created(),
				event("queue.enqueued", 1, {
					queueItemId: cancelledId,
					sourceCommandId: cancelledSourceCommandId,
					kind: "follow_up",
					enqueueRevision: { stream: STREAM, sequence: 0, eventHash: hashFor(0) },
					targetTurnRevision: null,
					nextTurnPolicy: "after_active_run",
					contentDigest,
					content,
				}),
				event("queue.cancelled", 2, {
					queueItemId: cancelledId,
					sourceCommandId: cancelledSourceCommandId,
					kind: "follow_up",
					contentDigest,
					reason: "operator request",
					cancellationCommandId: createRuntimeId("command", "cancel-cancelled"),
				}),
			]),
		);
		expect(cancelled.queueItems[0]).toMatchObject({ status: "cancelled", cancelledSequence: 2 });
	});

	it("rejects QueueItemV3 target revision and terminal source/kind tampering", () => {
		const messageJson = JSON.stringify({ role: "user", content: [{ type: "text", text: "bound" }] });
		const content = { storage: "bounded_text" as const, messageJson };
		const contentDigest = canonicalDigest(content);
		const queueItemId = createRuntimeId("queueItem", "binding-tamper");
		const sourceCommandId = createRuntimeId("command", "binding-tamper");
		const turnId = createRuntimeId("turn", "binding-tamper");
		const modelRequestId = createRuntimeId("modelRequest", "binding-tamper");
		const activeTurn = event("turn.started", 1, { turnId, goalId: GOAL_ID });
		const targetTamper = event("queue.enqueued", 2, {
			queueItemId,
			sourceCommandId,
			kind: "steer",
			enqueueRevision: { stream: STREAM, sequence: 1, eventHash: hashFor(1) },
			targetTurnRevision: {
				turnId,
				sessionRevision: { stream: STREAM, sequence: 1, eventHash: hashFor(0) },
			},
			nextTurnPolicy: "next_model_turn",
			contentDigest,
			content,
		});
		expect(resultError(reduceSessionEvents([created(), activeTurn, targetTamper])).code).toBe("invalid_event");

		const enqueued = event("queue.enqueued", 1, {
			queueItemId,
			sourceCommandId,
			kind: "steer",
			enqueueRevision: { stream: STREAM, sequence: 0, eventHash: hashFor(0) },
			targetTurnRevision: null,
			nextTurnPolicy: "next_model_turn",
			contentDigest,
			content,
		});
		const consumingTurn = event("turn.started", 2, { turnId, goalId: GOAL_ID, queueItemId });
		const modelRequested = event("model.requested", 3, {
			turnId,
			requestId: modelRequestId,
			modelId: "fixture",
			contextDigest: DIGEST,
		});
		const terminal = {
			queueItemId,
			sourceCommandId,
			kind: "steer" as const,
			turnId,
			modelRequestId,
			contentDigest,
		};
		const prefix = [created(), enqueued, consumingTurn, modelRequested];
		const sourceTamper = event("queue.consumed", 4, {
			...terminal,
			sourceCommandId: createRuntimeId("command", "binding-tamper-other"),
		});
		const kindTamper = event("queue.consumed", 4, { ...terminal, kind: "follow_up" });
		expect(resultError(reduceSessionEvents([...prefix, sourceTamper])).code).toBe("invalid_event");
		expect(resultError(reduceSessionEvents([...prefix, kindTamper])).code).toBe("invalid_event");
	});

	it("accepts create, fork, and migration as the three explicit genesis forms", () => {
		const forkGoalId = createRuntimeId("goal", "fork-child");
		const forkRootAgentId = createRuntimeId("agent", "fork-child");
		const parentRootAgentId = createRuntimeId("agent", "fork-parent");
		const fork = event("session.forked", 0, {
			parentSessionId: createRuntimeId("session", "parent"),
			parentSequence: 7,
			parentEventHash: DIGEST,
			parentLeafId: createRuntimeId("leaf", "parent-leaf"),
			goalMode: "create_child_goal",
			initialGoalId: forkGoalId,
			rootAgentId: forkRootAgentId,
			parentRootAgentId,
			idempotencyKey: createRuntimeId("command", "fork"),
		});
		const manifest = {
			mode: "migrate",
			sourceVersion: 2 as const,
			sourceDigest: DIGEST,
			sourceSize: 42,
			headerDigest: DIGEST,
			sourceSessionId: "legacy-session",
			importerVersion: "fixture-importer",
			importSchema: "runtime-session-migration/v1",
			configurationJson: "{}",
			configurationDigest: canonicalDigest("{}"),
			recoveredFields: [],
			lostFields: [],
			expectedRecordCount: 0,
			expectedRecordSetDigest: legacyMigrationRecordSetDigest([]),
		};
		const migration = event("session.migration_started", 0, {
			...manifest,
			manifestDigest: legacyMigrationManifestDigest(manifest),
			idempotencyKey: createRuntimeId("command", "migration"),
		});

		expect(resultValue(reduceSessionEvents([created()])).genesis.kind).toBe("created");
		expect(resultValue(reduceSessionEvents([fork])).genesis).toMatchObject({
			kind: "forked",
			goalMode: "create_child_goal",
			initialGoalId: forkGoalId,
			rootAgentId: forkRootAgentId,
			parentRootAgentId,
		});
		const migrationProjection = resultValue(reduceSessionEvents([migration]));
		expect(migrationProjection.genesis.kind).toBe("migration");
		expect(migrationProjection).toMatchObject({
			lifecycle: "migration_in_progress",
			migration: { status: "in_progress", expectedRecordCount: 0 },
		});
	});

	it("keeps migration paused until one complete source-index digest set is committed", () => {
		const messageJson = JSON.stringify({ role: "user", content: [{ type: "text", text: "legacy" }] });
		const contentDigest = canonicalDigest(messageJson);
		const sourceRecordDigest = canonicalDigest("source-record");
			const importDescriptor = {
				sourceVersion: 2 as const,
				sourceIndex: 0,
				sourceEntryId: "legacy-entry",
				sourceRecordDigest,
				entryType: "message" as const,
				messageKind: "user" as const,
			disposition: "recovered" as const,
			messageJson,
			contentDigest,
			recoveredFields: ["content[].text", "role"],
			lostFields: [],
		};
		const recordSetDigest = legacyMigrationRecordSetDigest([importDescriptor]);
		const manifest = {
			mode: "migrate",
			sourceVersion: 2 as const,
			sourceDigest: DIGEST,
			sourceSize: 42,
			headerDigest: DIGEST,
			sourceSessionId: "legacy-session",
				importerVersion: "fixture-importer",
				importSchema: "runtime-session-migration/v1",
				configurationJson: "{}",
				configurationDigest: canonicalDigest("{}"),
				recoveredFields: ["content[].text", "role"],
				lostFields: [],
				expectedRecordCount: 1,
			expectedRecordSetDigest: recordSetDigest,
		};
		const manifestDigest = legacyMigrationManifestDigest(manifest);
		const started = event("session.migration_started", 0, {
			...manifest,
			manifestDigest,
			idempotencyKey: createRuntimeId("command", "migration-terminal"),
		});
		const imported = event("session.legacy_message_imported", 1, {
			manifestDigest,
				sourceVersion: 2,
				sourceIndex: 0,
				sourceEntryId: "legacy-entry",
				sourceRecordDigest,
				entryType: "message",
				messageKind: "user",
			disposition: "recovered",
			messageJson,
			contentDigest,
			recoveredFields: ["content[].text", "role"],
			lostFields: [],
		});
		const committed = event("session.migration_committed", 2, {
			manifestDigest,
			expectedRecordCount: 1,
			importedRecordCount: 1,
			recordSetDigest,
		});

		expect(resultValue(reduceSessionEvents([started, imported]))).toMatchObject({
			lifecycle: "migration_in_progress",
			migration: { status: "in_progress", records: [{ sourceIndex: 0, sourceRecordDigest }] },
		});
		expect(resultValue(reduceSessionEvents([started, imported, committed]))).toMatchObject({
			lifecycle: "active",
			migration: { status: "committed", terminalSequence: 2 },
		});
		expect(resultError(reduceSessionEvents([
			started,
			imported,
			event("session.legacy_message_imported", 2, imported.payload),
		]))).toMatchObject({ code: "invalid_event" });
		expect(resultError(reduceSessionEvents([
			started,
			event("session.migration_committed", 1, committed.payload),
		]))).toMatchObject({ code: "invalid_event" });
		const changedFieldReceipt = event("session.legacy_message_imported", 1, {
			...imported.payload,
			recoveredFields: ["content[].text"],
		});
		expect(resultError(reduceSessionEvents([
			started,
			changedFieldReceipt,
			committed,
		]))).toMatchObject({ code: "invalid_event" });
		const badManifest = event("session.migration_started", 0, {
			...started.payload,
			manifestDigest: DIGEST,
		});
		expect(resultError(reduceSessionEvents([badManifest]))).toMatchObject({ code: "invalid_event" });
		const unknownSchemaManifest = {
			...manifest,
			importSchema: `${LEGACY_MIGRATION_SCHEMA}-unknown`,
		};
		const unknownSchema = event("session.migration_started", 0, {
			...started.payload,
			...unknownSchemaManifest,
			manifestDigest: legacyMigrationManifestDigest(unknownSchemaManifest),
		});
		expect(resultError(reduceSessionEvents([unknownSchema]))).toMatchObject({ code: "invalid_event" });
	});

	it("projects paired turn, model, tool, queue, checkpoint, and session states", () => {
		const turnId = createRuntimeId("turn", "paired");
		const toolCallId = createRuntimeId("toolCall", "paired");
		const queueItemId = createRuntimeId("queueItem", "paired");
		const queueSourceCommandId = createRuntimeId("command", "queue-paired");
		const queueContent = { storage: "bounded_text" as const, messageJson: "{}" };
		const queueContentDigest = canonicalDigest(queueContent);
		const modelRequestId = createRuntimeId("modelRequest", "paired");
		const checkpointId = createRuntimeId("checkpoint", "paired");
		const beforeCheckpoint: RuntimeEventV3[] = [
			created(),
			event("queue.enqueued", 1, {
				queueItemId,
				sourceCommandId: queueSourceCommandId,
				kind: "steer",
				enqueueRevision: { stream: STREAM, sequence: 0, eventHash: hashFor(0) },
				targetTurnRevision: null,
				nextTurnPolicy: "next_model_turn",
				contentDigest: queueContentDigest,
				content: queueContent,
			}),
			event("turn.started", 2, { turnId, goalId: GOAL_ID, queueItemId }),
			event("model.routed", 3, {
				turnId,
				profileId: "profile-fixture",
				manifestDigest: DIGEST,
				decisionDigest: DIGEST,
				outcome: "compatible",
			}),
			event("model.requested", 4, {
				turnId,
				requestId: modelRequestId,
				modelId: "model-fixture",
				contextDigest: DIGEST,
			}),
			event("queue.consumed", 5, {
				queueItemId,
				sourceCommandId: queueSourceCommandId,
				kind: "steer",
				turnId,
				modelRequestId,
				contentDigest: queueContentDigest,
			}),
			event("model.finished", 6, {
				turnId,
				requestId: modelRequestId,
				responseDigest: DIGEST,
				inputTokens: 10,
				outputTokens: 5,
			}),
			event("tool.requested", 7, {
				turnId,
				toolCallId,
				agentId: AGENT_ID,
				toolIdentityDigest: DIGEST,
				argumentsDigest: DIGEST,
			}),
			event("tool.authorized", 8, {
				toolCallId,
				requestId: "authorization-paired",
				decisionReceiptId: createRuntimeId("receipt", "authorization-paired"),
			}),
			event("tool.started", 9, {
				toolCallId,
				invocationDigest: DIGEST,
				workspaceReceiptId: createRuntimeId("receipt", "workspace-paired"),
			}),
			event("tool.finished", 10, { toolCallId, resultDigest: DIGEST }),
			event("turn.finished", 11, { turnId, resultDigest: DIGEST, stopReason: "stop" }),
		];
		const beforeCheckpointProjection = resultValue(reduceSessionEvents(beforeCheckpoint));
		const reducerDigest = beforeCheckpointProjection.projectionDigest;
		const leafAfterRewind = createRuntimeId("leaf", "after-rewind");
		const events: RuntimeEventV3[] = [
			...beforeCheckpoint,
			event("checkpoint.created", 12, {
				checkpointId,
				sequence: 11,
				eventHash: hashFor(11),
				reducerDigest,
				activeLeafId: beforeCheckpointProjection.activeLeafId,
			}),
			event("checkpoint.rewound", 13, {
				checkpointId,
				fromLeafId: beforeCheckpointProjection.activeLeafId,
				toLeafId: leafAfterRewind,
			}),
			event("session.closed", 14, {
				headHash: hashFor(13),
				eventCount: 15,
				integrity: "valid",
				attestation: "unattested",
			}),
		];

		const projection = resultValue(reduceSessionEvents(events));
		expect(projection.lifecycle).toBe("closed");
		expect(projection.activeTurnId).toBeNull();
		expect(projection.activeModelRequestId).toBeNull();
		expect(projection.turns).toEqual([
			expect.objectContaining({ turnId, status: "finished", terminalSequence: 11 }),
		]);
		expect(projection.modelRequests).toEqual([
			expect.objectContaining({ requestId: modelRequestId, status: "finished", uncertain: false }),
		]);
		expect(projection.toolCalls).toEqual([
			expect.objectContaining({ toolCallId, status: "finished", uncertain: false }),
		]);
		expect(projection.queueItems).toEqual([
			expect.objectContaining({ queueItemId, status: "consumed", turnId }),
		]);
		expect(projection.checkpoints).toEqual([
			expect.objectContaining({ checkpointId, status: "rewound", rewoundSequence: 13 }),
		]);
		expect(projection.hasUncertainOperations).toBe(false);
		const { projectionDigest, ...state } = projection;
		expect(projectionDigest).toBe(canonicalDigest(state));
	});

	it("marks unterminated model and tool work as uncertain without inventing terminal events", () => {
		const modelProjection = resultValue(
			reduceSessionEvents([
				created(),
				turnStarted(1, "model-uncertain"),
				event("model.requested", 2, {
					turnId: createRuntimeId("turn", "model-uncertain"),
					requestId: createRuntimeId("modelRequest", "uncertain"),
					modelId: "model-fixture",
					contextDigest: DIGEST,
				}),
			]),
		);
		expect(modelProjection.modelRequests[0]).toMatchObject({ status: "requested", uncertain: true });
		expect(modelProjection.hasUncertainOperations).toBe(true);

		const toolCallId = createRuntimeId("toolCall", "uncertain");
		const toolProjection = resultValue(
			reduceSessionEvents([
				created(),
				turnStarted(1, "tool-uncertain"),
				event("tool.requested", 2, {
					turnId: createRuntimeId("turn", "tool-uncertain"),
					toolCallId,
					agentId: AGENT_ID,
					toolIdentityDigest: DIGEST,
					argumentsDigest: DIGEST,
				}),
				event("tool.authorized", 3, {
					toolCallId,
					requestId: "authorization-uncertain",
					decisionReceiptId: createRuntimeId("receipt", "authorization-uncertain"),
				}),
				event("tool.started", 4, {
					toolCallId,
					invocationDigest: DIGEST,
					workspaceReceiptId: createRuntimeId("receipt", "workspace-uncertain"),
				}),
			]),
		);
		expect(toolProjection.toolCalls[0]).toMatchObject({ status: "started", uncertain: true });
		expect(toolProjection.hasUncertainOperations).toBe(true);
	});

	it("rejects events before genesis and repeated active turns", () => {
		expect(resultError(reduceSessionEvents([turnStarted(0)])).code).toBe("invalid_event");
		expect(
			resultError(reduceSessionEvents([created(), turnStarted(1, "first"), turnStarted(2, "second")])).code,
		).toBe("invalid_event");
	});

	it("rejects terminal IDs that do not match the active turn, model request, or tool call", () => {
		const activeTurnId = createRuntimeId("turn", "match");
		const otherTurnId = createRuntimeId("turn", "other");
		const turnMismatch = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId: activeTurnId, goalId: GOAL_ID }),
			event("turn.finished", 2, { turnId: otherTurnId, resultDigest: DIGEST, stopReason: "stop" }),
		]);
		expect(resultError(turnMismatch).code).toBe("invalid_event");

		const modelMismatch = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId: activeTurnId, goalId: GOAL_ID }),
			event("model.requested", 2, {
				turnId: activeTurnId,
				requestId: "request-active",
				modelId: "model-fixture",
				contextDigest: DIGEST,
			}),
			event("model.failed", 3, {
				turnId: activeTurnId,
				requestId: "request-other",
				error: { code: "fixture", messageDigest: DIGEST, retryable: false },
			}),
		]);
		expect(resultError(modelMismatch).code).toBe("invalid_event");

		const activeToolCallId = createRuntimeId("toolCall", "active");
		const toolMismatch = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId: activeTurnId, goalId: GOAL_ID }),
			event("tool.requested", 2, {
				turnId: activeTurnId,
				toolCallId: activeToolCallId,
				agentId: AGENT_ID,
				toolIdentityDigest: DIGEST,
				argumentsDigest: DIGEST,
			}),
			event("tool.failed", 3, {
				toolCallId: createRuntimeId("toolCall", "other"),
				error: { code: "fixture", messageDigest: DIGEST, retryable: false },
				outcomeCertain: false,
			}),
		]);
		expect(resultError(toolMismatch).code).toBe("invalid_event");
	});

	it("rejects events after a terminal session and queue consumes without a pending item", () => {
		const closed = event("session.closed", 1, {
			headHash: hashFor(0),
			eventCount: 2,
			integrity: "valid",
			attestation: "unattested",
		});
		const afterTerminal = event("queue.enqueued", 2, {
			queueItemId: createRuntimeId("queueItem", "too-late"),
			sourceCommandId: createRuntimeId("command", "too-late"),
			kind: "follow_up",
			enqueueRevision: { stream: STREAM, sequence: 1, eventHash: hashFor(1) },
			targetTurnRevision: null,
			nextTurnPolicy: "after_active_run",
			contentDigest: canonicalDigest({ storage: "bounded_text", messageJson: "{}" }),
			content: { storage: "bounded_text", messageJson: "{}" },
		});
		expect(resultError(reduceSessionEvents([created(), closed, afterTerminal])).code).toBe("stopped");

		const missingQueueItem = event("queue.consumed", 1, {
			queueItemId: createRuntimeId("queueItem", "missing"),
			sourceCommandId: createRuntimeId("command", "missing"),
			kind: "steer",
			turnId: createRuntimeId("turn", "future"),
			modelRequestId: createRuntimeId("modelRequest", "future"),
			contentDigest: DIGEST,
		});
		expect(resultError(reduceSessionEvents([created(), missingQueueItem])).code).toBe("invalid_event");
	});

	it("requires queue and leaf references to remain connected", () => {
		const missingQueue = reduceSessionEvents([
			created(),
			event("turn.started", 1, {
				turnId: createRuntimeId("turn", "missing-queue"),
				goalId: GOAL_ID,
				queueItemId: createRuntimeId("queueItem", "missing-queue"),
			}),
		]);
		expect(resultError(missingQueue).code).toBe("invalid_event");

		const genesis = resultValue(reduceSessionEvents([created()]));
		const disconnectedCheckpoint = event("checkpoint.created", 1, {
			checkpointId: createRuntimeId("checkpoint", "disconnected"),
			sequence: 0,
			eventHash: hashFor(0),
			reducerDigest: genesis.projectionDigest,
			activeLeafId: createRuntimeId("leaf", "not-active"),
		});
		expect(resultError(reduceSessionEvents([created(), disconnectedCheckpoint])).code).toBe("invalid_event");
	});

	it("rejects invalid pair ordering for tools and checkpoints", () => {
		const turnId = createRuntimeId("turn", "ordering");
		const toolCallId = createRuntimeId("toolCall", "ordering");
		const toolStartWithoutAuthorization = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId, goalId: GOAL_ID }),
			event("tool.requested", 2, {
				turnId,
				toolCallId,
				agentId: AGENT_ID,
				toolIdentityDigest: DIGEST,
				argumentsDigest: DIGEST,
			}),
			event("tool.started", 3, {
				toolCallId,
				invocationDigest: DIGEST,
				workspaceReceiptId: createRuntimeId("receipt", "ordering"),
			}),
		]);
		expect(resultError(toolStartWithoutAuthorization).code).toBe("invalid_event");

		const rewindWithoutCheckpoint = event("checkpoint.rewound", 1, {
			checkpointId: createRuntimeId("checkpoint", "missing"),
			fromLeafId: "from",
			toLeafId: "to",
		});
		expect(resultError(reduceSessionEvents([created(), rewindWithoutCheckpoint])).code).toBe("invalid_event");
	});

	it("requires model/tool terminal handoff and binds checkpoints to the pre-event projection", () => {
		const turnId = createRuntimeId("turn", "handoff");
		const toolCallId = createRuntimeId("toolCall", "handoff");
		const toolDuringModel = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId, goalId: GOAL_ID }),
			event("model.requested", 2, {
				turnId,
				requestId: "request-handoff",
				modelId: "model-fixture",
				contextDigest: DIGEST,
			}),
			event("tool.requested", 3, {
				turnId,
				toolCallId,
				agentId: AGENT_ID,
				toolIdentityDigest: DIGEST,
				argumentsDigest: DIGEST,
			}),
		]);
		expect(resultError(toolDuringModel).code).toBe("invalid_event");

		const modelDuringTool = reduceSessionEvents([
			created(),
			event("turn.started", 1, { turnId, goalId: GOAL_ID }),
			event("tool.requested", 2, {
				turnId,
				toolCallId,
				agentId: AGENT_ID,
				toolIdentityDigest: DIGEST,
				argumentsDigest: DIGEST,
			}),
			event("model.requested", 3, {
				turnId,
				requestId: "request-too-early",
				modelId: "model-fixture",
				contextDigest: DIGEST,
			}),
		]);
		expect(resultError(modelDuringTool).code).toBe("invalid_event");

		const genesisDigest = resultValue(reduceSessionEvents([created()])).projectionDigest;
		const wrongCursor = event("checkpoint.created", 1, {
			checkpointId: createRuntimeId("checkpoint", "wrong-cursor"),
			sequence: 0,
			eventHash: "f".repeat(64),
			reducerDigest: genesisDigest,
			activeLeafId: "leaf-fixture",
		});
		expect(resultError(reduceSessionEvents([created(), wrongCursor])).code).toBe("invalid_event");

		const wrongReducerDigest = event("checkpoint.created", 1, {
			checkpointId: createRuntimeId("checkpoint", "wrong-reducer"),
			sequence: 0,
			eventHash: hashFor(0),
			reducerDigest: "f".repeat(64),
			activeLeafId: "leaf-fixture",
		});
		expect(resultError(reduceSessionEvents([created(), wrongReducerDigest])).code).toBe("invalid_event");
	});
});
