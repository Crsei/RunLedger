import { describe, expect, it } from "vitest";
import { createLocalIdentityContext } from "../../src/runtime/identity/local-principal.ts";
import { canonicalDigest, canonicalJson } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../src/runtime/protocol/v3/coordination.ts";
import {
	createSessionEventStreamRef,
	isAllowedGoalTransition,
	RUNTIME_SCHEMA_VERSION,
	type RuntimeEventV3,
} from "../../src/runtime/protocol/v3/events.ts";
import { RUNTIME_EVENT_TYPES } from "../../src/runtime/protocol/v3/event-catalog.ts";
import { RUNTIME_EVENT_PAYLOAD_SCHEMAS } from "../../src/runtime/protocol/v3/event-payloads.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import { MANDATORY_FLUSH_EVENT_TYPES } from "../../src/runtime/session/event-writer.ts";
import {
	isRuntimeEventSchemaCatalogExhaustive,
	isEventCursor,
	isExpectedRevision,
	MAX_RUNTIME_EVENT_PAYLOAD_BYTES,
	validateRuntimeEvent,
} from "../../src/runtime/protocol/v3/schemas.ts";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function validEvent(): RuntimeEventV3 {
	const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
	const sessionId = createRuntimeId("session", "fixture");
	return {
		schemaVersion: RUNTIME_SCHEMA_VERSION,
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		principalId: identity.principalId,
		eventId: createRuntimeId("event", "fixture"),
		stream: createSessionEventStreamRef(identity, sessionId),
		sequence: 0,
		timestamp: "2026-07-22T00:00:00.000Z",
		type: "session.created",
		previousEventHash: null,
		payloadDigest: digest,
		currentEventHash: digest,
		traceId: createRuntimeId("trace", "fixture"),
		payload: {
			origin: "test",
			runtimeId: createRuntimeId("runtime", "fixture"),
			featureDigest: digest,
			initialGoalId: createRuntimeId("goal", "fixture"),
			rootAgentId: createRuntimeId("agent", "fixture"),
		},
	};
}

describe("Runtime v3 exact event schemas", () => {
	it("validates a catalogued event envelope", () => {
		const event = validEvent();
		expect(validateRuntimeEvent(event)).toEqual({ ok: true, value: event });
	});

	it("rejects unknown versions and event types", () => {
		const event = validEvent();
		expect(validateRuntimeEvent({ ...event, schemaVersion: 4 })).toMatchObject({ ok: false, code: "unknown_schema_version" });
		expect(validateRuntimeEvent({ ...event, type: "future.event" })).toMatchObject({ ok: false, code: "unknown_event_type" });
	});

	it("rejects unknown root, payload, and nested fields", () => {
		const event = validEvent();
		expect(validateRuntimeEvent({ ...event, future: true })).toMatchObject({ ok: false, code: "unknown_field" });
		expect(validateRuntimeEvent({ ...event, payload: { ...event.payload, future: true } })).toMatchObject({
			ok: false,
			code: "unknown_field",
		});
		const failedTool = {
			...event,
			type: "tool.failed",
			payload: {
				toolCallId: createRuntimeId("toolCall", "fixture"),
				error: { code: "failure", messageDigest: digest, retryable: false, secret: "no" },
				outcomeCertain: false,
			},
		};
		expect(validateRuntimeEvent(failedTool)).toMatchObject({ ok: false });
	});

	it("fails closed at payload byte boundaries", () => {
		const event = validEvent();
		const payloadWithEmptyPadding = { ...event.payload, padding: "" };
		const fixedBytes = Buffer.byteLength(canonicalJson(payloadWithEmptyPadding), "utf8");
		const payloadAt = (bytes: number) => ({ ...event.payload, padding: "x".repeat(bytes - fixedBytes) });
		expect(validateRuntimeEvent({ ...event, payload: payloadAt(MAX_RUNTIME_EVENT_PAYLOAD_BYTES - 1) })).toMatchObject({
			ok: false,
			code: "unknown_field",
		});
		expect(validateRuntimeEvent({ ...event, payload: payloadAt(MAX_RUNTIME_EVENT_PAYLOAD_BYTES) })).toMatchObject({
			ok: false,
			code: "unknown_field",
		});
		expect(validateRuntimeEvent({ ...event, payload: payloadAt(MAX_RUNTIME_EVENT_PAYLOAD_BYTES + 1) })).toMatchObject({
			ok: false,
			code: "oversized_payload",
		});
	});

	it("rejects malformed IDs, digests, timestamps, and payload discriminants", () => {
		const event = validEvent();
		expect(validateRuntimeEvent({
			...event,
			stream: { ...event.stream, sessionId: "wrong" },
		})).toMatchObject({ ok: false, code: "invalid_schema" });
		expect(validateRuntimeEvent({ ...event, currentEventHash: "short" })).toMatchObject({ ok: false, code: "invalid_schema" });
		expect(validateRuntimeEvent({ ...event, timestamp: "yesterday" })).toMatchObject({ ok: false, code: "invalid_schema" });
		expect(validateRuntimeEvent({ ...event, payload: { ...event.payload, origin: "future" } })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
	});

	it("keeps catalog and independent payload schemas exhaustive", () => {
		expect(isRuntimeEventSchemaCatalogExhaustive()).toBe(true);
		expect(Object.keys(RUNTIME_EVENT_PAYLOAD_SCHEMAS)).toEqual([...RUNTIME_EVENT_TYPES]);
		expect(new Set(Object.values(RUNTIME_EVENT_PAYLOAD_SCHEMAS)).size).toBe(RUNTIME_EVENT_TYPES.length);
	});

	it("freezes semantic terminal and ordered Agent cleanup event payloads", () => {
		const base = validEvent();
		const agentId = createRuntimeId("agent", "cleanup-schema");
		const sessionId = base.stream.scope === "session" ? base.stream.sessionId : createRuntimeId("session", "cleanup-schema");
		const requestId = createRuntimeId("command", "cleanup-schema");
		const cleanupRequestId = createRuntimeId("command", "cleanup-schema-intent");
		const common = {
			rootAgentId: createRuntimeId("agent", "cleanup-schema-root"),
			graphRevision: 1,
			requestId,
			idempotencyKey: createIdempotencyKey("cleanup-schema-idempotency-key"),
			commandDigest: digest,
		};
		const terminal = {
			requestId,
			requestDigest: digest,
			outcome: "failed" as const,
			reason: "crash" as const,
			partialResults: [],
			terminalDigest: digest,
		};
		const residencyReceipt = {
			receiptId: createRuntimeId("receipt", "cleanup-schema-residency"),
			agentId,
			sessionId,
			runtimeInstanceId: createRuntimeId("runtime", "cleanup-schema"),
			state: "nonresident" as const,
			revision: 2,
			observedAt: base.timestamp,
			receiptDigest: digest,
		};
		const runtimeReceipt = {
			receiptId: createRuntimeId("receipt", "cleanup-schema-runtime"),
			requestId,
			requestDigest: digest,
			agentId,
			sessionId,
			runtimeInstanceId: residencyReceipt.runtimeInstanceId,
			launchReceiptId: createRuntimeId("receipt", "cleanup-schema-launch"),
			launchRevision: 1,
			writerFenceReceiptId: createRuntimeId("receipt", "cleanup-schema-fence"),
			writerFenceReceiptDigest: digest,
			finalCursor: {
				stream: {
					scope: "session" as const,
					streamId: createRuntimeId("eventStream", "cleanup-schema-child"),
					sessionId,
				},
				sequence: 2,
				eventId: createRuntimeId("event", "cleanup-schema-child-final"),
				eventHash: digest,
			},
			residencyReceipt,
			releasedAt: base.timestamp,
			receiptDigest: digest,
		};
		const workspaceReceipt = {
			receiptId: createRuntimeId("receipt", "cleanup-schema-workspace"),
			strategy: {
				strategyId: createRuntimeId("resource", "cleanup-schema-strategy"),
				kind: "managed_worktree" as const,
				strategyDigest: digest,
			},
			sessionId,
			workspaceId: createRuntimeId("workspace", "cleanup-schema"),
			repositoryId: createRuntimeId("repository", "cleanup-schema"),
			bindingRevision: 1,
			bindingDigest: digest,
			status: "released" as const,
			issuedAt: base.timestamp,
			receiptDigest: digest,
		};
		const budgetReceipt = {
			receiptId: createRuntimeId("receipt", "cleanup-schema-budget"),
			reservationId: createRuntimeId("budgetReservation", "cleanup-schema"),
			outcome: "failed" as const,
			usageDigest: digest,
			partialResultsDigest: digest,
			requestDigest: digest,
			settledAt: base.timestamp,
			receiptDigest: digest,
		};
		const cleanupReceipt = {
			receiptId: createRuntimeId("receipt", "cleanup-schema-completed"),
			requestId: cleanupRequestId,
			requestDigest: digest,
			agentId,
			sessionId,
			terminalDigest: terminal.terminalDigest,
			runtimeReleaseReceiptId: runtimeReceipt.receiptId,
			runtimeReleaseReceiptDigest: runtimeReceipt.receiptDigest,
			workspaceReleaseReceiptId: workspaceReceipt.receiptId,
			workspaceReleaseReceiptDigest: workspaceReceipt.receiptDigest,
			budgetSettlementReceiptId: budgetReceipt.receiptId,
			budgetSettlementReceiptDigest: budgetReceipt.receiptDigest,
			completedAt: base.timestamp,
			receiptDigest: digest,
		};
		const payloads = {
			"agent.finished": {
				...common,
				agentId,
				from: "running" as const,
				terminal: {
					requestId: terminal.requestId,
					requestDigest: terminal.requestDigest,
					outcome: "completed" as const,
					partialResults: terminal.partialResults,
					terminalDigest: terminal.terminalDigest,
				},
			},
			"agent.stopped": {
				...common,
				agentId,
				from: "running" as const,
				reason: "cancelled" as const,
				terminal: {
					...terminal,
					outcome: "stopped" as const,
					reason: "cancelled" as const,
					reasonEvidenceDigest: digest,
				},
			},
			"agent.cleanup_requested": { ...common, agentId, terminalDigest: terminal.terminalDigest, requestDigest: digest },
			"agent.runtime_released": { ...common, agentId, cleanupRequestId, receipt: runtimeReceipt },
			"agent.workspace_released": { ...common, agentId, cleanupRequestId, requestDigest: digest, receipt: workspaceReceipt },
			"agent.budget_settled": { ...common, agentId, cleanupRequestId, receipt: budgetReceipt },
			"agent.cleanup_reconciliation_required": {
				...common,
				agentId,
				cleanupRequestId,
				stage: "runtime_release" as const,
				error: { code: "close_uncertain", messageDigest: digest, retryable: true, outcomeCertain: false, effect: "uncertain" as const },
			},
			"agent.cleanup_completed": { ...common, agentId, cleanupRequestId, receipt: cleanupReceipt },
		} as const;
		for (const [type, payload] of Object.entries(payloads)) {
			expect(validateRuntimeEvent({ ...base, type, payload })).toMatchObject({ ok: true });
			expect(validateRuntimeEvent({ ...base, type, payload: { ...payload, future: true } })).toMatchObject({
				ok: false,
				code: "unknown_field",
			});
			expect(MANDATORY_FLUSH_EVENT_TYPES.has(type as keyof typeof payloads)).toBe(true);
		}
		const stoppedPayload = payloads["agent.stopped"];
		const { reasonEvidenceDigest: _reasonEvidenceDigest, ...legacyTerminal } = stoppedPayload.terminal;
		expect(validateRuntimeEvent({
			...base,
			type: "agent.stopped",
			payload: { ...stoppedPayload, terminal: legacyTerminal },
		})).toMatchObject({ ok: true });
		expect(validateRuntimeEvent({
			...base,
			type: "agent.stopped",
			payload: {
				...stoppedPayload,
				terminal: { ...stoppedPayload.terminal, reasonEvidenceDigest: "malformed" },
			},
		})).toMatchObject({ ok: false, code: "invalid_schema" });
	});

	it("publishes fail-closed goal transition rules", () => {
		expect(isAllowedGoalTransition("planning", "awaiting_plan_approval")).toBe(true);
		expect(isAllowedGoalTransition("planning", "completed")).toBe(false);
		expect(isAllowedGoalTransition("completed", "remediation")).toBe(false);
	});

	it("requires stable fork goal and root-agent lineage in the exact genesis payload", () => {
		const base = validEvent();
		const forked = {
			...base,
			type: "session.forked",
			payload: {
				parentSessionId: createRuntimeId("session", "parent"),
				parentSequence: 4,
				parentEventHash: digest,
				parentLeafId: createRuntimeId("leaf", "parent"),
				goalMode: "create_child_goal",
				initialGoalId: createRuntimeId("goal", "child"),
				rootAgentId: createRuntimeId("agent", "child"),
				parentRootAgentId: createRuntimeId("agent", "parent"),
				idempotencyKey: createRuntimeId("command", "fork"),
			},
		};
		expect(validateRuntimeEvent(forked)).toMatchObject({ ok: true });
		const { rootAgentId: _rootAgentId, ...missingRoot } = forked.payload;
		expect(validateRuntimeEvent({ ...forked, payload: missingRoot })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		expect(validateRuntimeEvent({
			...forked,
			payload: { ...forked.payload, goalMode: "implicit" },
		})).toMatchObject({ ok: false, code: "invalid_schema" });
	});

	it("validates cursor and expected revision contracts exactly", () => {
		const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const sessionId = createRuntimeId("session", "fixture");
		const stream = createSessionEventStreamRef(identity, sessionId);
		const eventId = createRuntimeId("event", "fixture");
		expect(isEventCursor({ stream, sequence: 0, eventId, eventHash: digest })).toBe(true);
		expect(isEventCursor({ stream, sequence: 0, eventId, eventHash: digest, future: true })).toBe(false);
		expect(isExpectedRevision({ stream, sequence: 0, eventHash: digest })).toBe(true);
		expect(isExpectedRevision({ stream, sequence: -1, eventHash: digest })).toBe(false);
	});

	it("freezes exact Episode seal, Draft PR, and human-gate payloads behind flush barriers", () => {
		const base = validEvent();
		const cursor = {
			stream: base.stream,
			sequence: 3,
			eventId: createRuntimeId("event", "episode-cursor"),
			eventHash: digest,
		};
		const proposalId = createRuntimeId("changeProposal", "schema");
		const requestId = createRuntimeId("command", "schema-boundary");
		const sealId = createRuntimeId("episodeSeal", "schema");
		const payloads = {
			"episode.manifest_committed": {
				receiptId: createRuntimeId("receipt", "manifest-commit"),
				manifestBodyDigest: digest,
				manifestArtifact: {
					authorityId: base.authorityId,
					tenantId: base.tenantId,
					artifactId: createRuntimeId("artifact", "episode-manifest"),
					storedDigest: digest,
					kind: "episode_manifest",
					originalSize: 128,
					storedSize: 128,
					mediaType: "application/vnd.runledger.episode-manifest-body+json",
					redaction: "metadata_only",
					transformReceipt: createRuntimeId("receipt", "episode-manifest-transform"),
					workspaceId: createRuntimeId("workspace", "schema"),
				},
				evidenceHead: cursor,
			},
			"episode.seal_recorded": {
				receiptId: createRuntimeId("receipt", "seal-record"),
				sealId,
				sealDigest: digest,
				manifestBodyDigest: digest,
				manifestCommitCursor: cursor,
				referenceClosureDigest: digest,
				verificationReceiptDigests: [digest],
				sealJson: "{}",
			},
			"draft_pr.requested": {
				requestId,
				idempotencyKey: requestId,
				proposalId,
				proposalDigest: digest,
				sealId,
				sealDigest: digest,
				repositoryId: createRuntimeId("repository", "schema"),
				workspaceId: createRuntimeId("workspace", "schema"),
				candidateCommit: "candidate-commit",
				providerId: "github-enterprise",
				authorizationReceiptId: createRuntimeId("receipt", "draft-authorization"),
				authorizationReceiptDigest: digest,
			},
			"draft_pr.created": {
				requestId,
				proposalId,
				proposalDigest: digest,
				sealId,
				sealDigest: digest,
				providerId: "github-enterprise",
				receiptId: createRuntimeId("receipt", "draft-created"),
				receiptDigest: digest,
				draft: true,
				externalReferenceDigest: digest,
				providerRevision: 1,
			},
			"draft_pr.failed": {
				requestId,
				proposalId,
				proposalDigest: digest,
				providerId: "github-enterprise",
				error: { code: "provider_unavailable", messageDigest: digest, retryable: false },
				outcomeCertain: false,
			},
			"human_gate.requested": {
				humanGateId: createRuntimeId("humanGate", "schema"),
				requestId,
				requestedBy: base.principalId,
				action: "merge",
				proposalId,
				proposalDigest: digest,
				sealId,
				sealDigest: digest,
				requestDigest: digest,
			},
			"human_gate.decided": {
				humanGateId: createRuntimeId("humanGate", "schema"),
				requestId,
				proposalId,
				proposalDigest: digest,
				action: "merge",
				decision: "approved",
				decisionAuthority: "human",
				decidedBy: createRuntimeId("principal", "independent-reviewer"),
				receiptId: createRuntimeId("receipt", "human-decision"),
				decisionReasonDigest: digest,
				receiptDigest: digest,
			},
		} as const;
		for (const [type, payload] of Object.entries(payloads)) {
			expect(validateRuntimeEvent({ ...base, type, payload })).toMatchObject({ ok: true });
			expect(validateRuntimeEvent({ ...base, type, payload: { ...payload, future: true } })).toMatchObject({
				ok: false,
				code: "unknown_field",
			});
			expect(MANDATORY_FLUSH_EVENT_TYPES.has(type as keyof typeof payloads)).toBe(true);
		}
	});

	it("freezes complete QueueItemV3 enqueue, claim, consume, and cancellation payloads", () => {
		const base = validEvent();
		const queueItemId = createRuntimeId("queueItem", "schema");
		const turnId = createRuntimeId("turn", "schema");
		const modelRequestId = createRuntimeId("modelRequest", "schema");
		const commandId = createRuntimeId("command", "schema");
		const content = { storage: "bounded_text" as const, messageJson: "{}" };
		const revision = { stream: base.stream, sequence: 0, eventHash: digest };
		const enqueued = {
			...base,
			type: "queue.enqueued",
			payload: {
				queueItemId,
				sourceCommandId: commandId,
				kind: "steer",
				enqueueRevision: revision,
				targetTurnRevision: { turnId, sessionRevision: revision },
				nextTurnPolicy: "next_model_turn",
				contentDigest: canonicalDigest(content),
				content,
			},
		};
		expect(validateRuntimeEvent(enqueued)).toMatchObject({ ok: true });
		expect(validateRuntimeEvent({ ...enqueued, payload: { ...enqueued.payload, messageJson: "{}" } })).toMatchObject({
			ok: false,
			code: "unknown_field",
		});
		const artifactContent = {
			storage: "artifact" as const,
			artifact: {
				authorityId: base.authorityId,
				tenantId: base.tenantId,
				artifactId: createRuntimeId("artifact", "queue-schema"),
				storedDigest: digest,
				kind: "tool_output" as const,
				originalSize: 42,
				storedSize: 42,
				mediaType: "application/json",
				redaction: "redacted" as const,
				transformReceipt: createRuntimeId("receipt", "queue-schema"),
			},
		};
		expect(validateRuntimeEvent({
			...enqueued,
			payload: { ...enqueued.payload, content: artifactContent, contentDigest: canonicalDigest(artifactContent) },
		})).toMatchObject({ ok: true });
		const claimed = {
			...base,
			type: "queue.claimed",
			payload: {
				queueItemId,
				sourceCommandId: commandId,
				kind: "steer",
				turnId,
				modelRequestId,
				contentDigest: digest,
			},
		};
		expect(validateRuntimeEvent(claimed)).toMatchObject({ ok: true });
		expect(validateRuntimeEvent({ ...claimed, payload: { ...claimed.payload, kind: "followup" } })).toMatchObject({
			ok: false,
			code: "invalid_schema",
		});
		const cancelled = {
			...base,
			type: "queue.cancelled",
			payload: {
				queueItemId,
				sourceCommandId: commandId,
				kind: "steer",
				contentDigest: digest,
				reason: "operator request",
				cancellationCommandId: createRuntimeId("command", "cancel-schema"),
			},
		};
		expect(validateRuntimeEvent(cancelled)).toMatchObject({ ok: true });
		const consumed = {
			...base,
			type: "queue.consumed",
			payload: { queueItemId, sourceCommandId: commandId, kind: "steer", turnId, modelRequestId, contentDigest: digest },
		};
		expect(validateRuntimeEvent(consumed)).toMatchObject({ ok: true });
		expect(validateRuntimeEvent({ ...consumed, payload: { ...consumed.payload, kind: undefined } })).toMatchObject({ ok: false });
	});
});
