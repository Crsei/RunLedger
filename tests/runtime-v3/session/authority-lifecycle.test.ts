import { describe, expect, it, vi } from "vitest";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import type { RuntimeEventPayloadMap } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import {
	createAuthorityTenantEventStreamRef,
	createSessionEventStreamRef,
	type EventCursor,
} from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import {
	joinSessionLifecycle,
	requireCommittedDeletionForGc,
} from "../../../src/runtime/session/authority-lifecycle-projection.ts";
import { AuthorityLifecycleRepository } from "../../../src/runtime/session/authority-lifecycle-repository.ts";
import { AuthorityLifecycleService } from "../../../src/runtime/session/authority-lifecycle-service.ts";
import { EventWriter, MANDATORY_FLUSH_EVENT_TYPES, openEventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import { createSessionSnapshot, replaySessionSnapshot } from "../../../src/runtime/session/snapshot.ts";
import type { SessionProjection } from "../../../src/runtime/session/projections.ts";
import { loadSessionProjection } from "../../../src/runtime/session/snapshot.ts";
import type { SessionResult, WriterFence } from "../../../src/runtime/session/types.ts";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-07-22T00:00:00.000Z");

function valueOf<T>(result: SessionResult<T>): T {
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
}

function fence(
	authorityId: ReturnType<typeof createLocalIdentityContext>["authorityId"],
	tenantId: ReturnType<typeof createLocalIdentityContext>["tenantId"],
	stream: ReturnType<typeof createSessionEventStreamRef> | ReturnType<typeof createAuthorityTenantEventStreamRef>,
	seed: string,
): WriterFence {
	return {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", seed),
		ownerRuntimeId: createRuntimeId("runtime", seed),
		writerEpoch: 1,
		fencingToken: `fencing-token-${seed}-0123456789abcdef`,
	};
}

async function createSessionFixture(seed: string) {
	const identity = createLocalIdentityContext(NOW);
	const sessionId = createRuntimeId("session", seed);
	const stream = createSessionEventStreamRef(identity, sessionId);
	const writerFence = fence(identity.authorityId, identity.tenantId, stream, `${seed}-session`);
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.fencingToken === writerFence.fencingToken,
		clock: () => NOW,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence: writerFence,
		clock: () => NOW,
	});
	valueOf(await writer.append({
		type: "session.created",
		principalId: identity.principalId,
		traceId: createRuntimeId("trace", `${seed}-genesis`),
		payload: {
			origin: "test",
			runtimeId: writerFence.ownerRuntimeId,
			featureDigest: DIGEST,
			initialGoalId: createRuntimeId("goal", `${seed}-goal`),
			rootAgentId: createRuntimeId("agent", `${seed}-root`),
		},
	}));
	valueOf(await writer.flush());
	const loaded = valueOf(await loadSessionProjection(store));
	return { identity, sessionId, stream, store, writer, writerFence, projection: loaded.projection };
}

async function createAuthorityFixture(seed: string, identity = createLocalIdentityContext(NOW)) {
	const stream = createAuthorityTenantEventStreamRef(identity);
	const writerFence = fence(identity.authorityId, identity.tenantId, stream, `${seed}-authority`);
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.fencingToken === writerFence.fencingToken,
		clock: () => NOW,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence: writerFence,
		clock: () => NOW,
	});
	const repository = valueOf(await AuthorityLifecycleRepository.open({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		store,
		writer,
	}));
	return { identity, stream, store, writer, writerFence, repository, service: new AuthorityLifecycleService(repository) };
}

function sessionHead(projection: SessionProjection): RuntimeEventPayloadMap["session.handoff_requested"]["finalSessionHead"] {
	return {
		authorityId: projection.authorityId,
		tenantId: projection.tenantId,
		sessionId: projection.sessionId,
		cursor: projectionCursor(projection),
	};
}

function projectionCursor(projection: SessionProjection): EventCursor {
	return {
		stream: projection.stream,
		sequence: projection.headSequence,
		eventId: projection.headEventId,
		eventHash: projection.headEventHash,
	};
}

function context(identity: ReturnType<typeof createLocalIdentityContext>, seed: string) {
	return { principalId: identity.principalId, traceId: createRuntimeId("trace", seed), timestamp: NOW.toISOString() };
}

function handoffRequest(
	projection: SessionProjection,
	seed: string,
): RuntimeEventPayloadMap["session.handoff_requested"] {
	return {
		handoffId: createRuntimeId("command", `${seed}-handoff`),
		idempotencyKey: createIdempotencyKey(`${seed}-handoff-idempotency-key`),
		subjectSessionId: projection.sessionId,
		sourceAuthorityId: projection.authorityId,
		sourceTenantId: projection.tenantId,
		targetAuthorityId: createRuntimeId("authority", `${seed}-target`),
		targetTenantId: createRuntimeId("tenant", `${seed}-target`),
		finalSessionHead: sessionHead(projection),
		referenceGraphDigest: canonicalDigest({ seed, kind: "reference-graph" }),
		leaseTransferIntentDigest: canonicalDigest({ seed, kind: "lease-transfer" }),
	};
}

function deletionPlan(
	projection: SessionProjection,
	seed: string,
): RuntimeEventPayloadMap["session.deletion_planned"] {
	return {
		deletionId: createRuntimeId("command", `${seed}-deletion`),
		idempotencyKey: createIdempotencyKey(`${seed}-deletion-idempotency-key`),
		subjectSessionId: projection.sessionId,
		finalSessionHead: sessionHead(projection),
		referenceGraphDigest: canonicalDigest({ seed, kind: "reference-graph" }),
		legalHoldDecision: "clear",
		legalHoldReceiptId: createRuntimeId("receipt", `${seed}-legal-hold`),
		legalHoldReceiptDigest: canonicalDigest({ seed, kind: "legal-hold" }),
	};
}

describe("authority lifecycle true source", () => {
	it("keeps authority and session chains independent and joins only through explicit heads", async () => {
		const session = await createSessionFixture("handoff");
		const authority = await createAuthorityFixture("handoff", session.identity);
		const claim = valueOf(await authority.repository.append({
			type: "command.claimed",
			...context(session.identity, "handoff-command-claim"),
			payload: {
				commandId: createRuntimeId("command", "handoff-claim"),
				commandType: "session:stop",
				idempotencyKey: createIdempotencyKey("handoff-command-claim-key"),
				requestDigest: DIGEST,
				requestedBy: session.identity.principalId,
				runtimeId: authority.writerFence.ownerRuntimeId,
				runtimeGeneration: 1,
				domain: "lifecycle",
				subjectSessionId: session.sessionId,
				domainExpectedRevision: null,
			},
		}));
		expect(claim.durableReceipt.cursor.sequence).toBe(0);
		expect(claim.projection.sessions).toEqual([]);

		const request = handoffRequest(session.projection, "handoff");
		const requested = valueOf(await authority.service.requestHandoff(context(session.identity, "handoff-request"), request));
		expect(requested).toMatchObject({ disposition: "committed", cursor: { sequence: 1 } });
		expect(session.projection.headSequence).toBe(0);
		expect(valueOf(await authority.service.recoveryDecision(session.sessionId))).toMatchObject({
			kind: "reconciliation_required",
			lifecycle: "handoff",
		});

		const reopenedWriter = valueOf(await openEventWriter({
			authorityId: session.identity.authorityId,
			tenantId: session.identity.tenantId,
			stream: authority.stream,
			store: authority.store,
			fence: authority.writerFence,
			clock: () => NOW,
		}));
		const reopenedRepository = valueOf(await AuthorityLifecycleRepository.open({
			authorityId: session.identity.authorityId,
			tenantId: session.identity.tenantId,
			store: authority.store,
			writer: reopenedWriter,
		}));
		const restarted = new AuthorityLifecycleService(reopenedRepository);
		expect(valueOf(await restarted.recoveryDecision(session.sessionId)).kind).toBe("reconciliation_required");

		const committed = valueOf(await restarted.commitHandoff(context(session.identity, "handoff-commit"), {
			handoffId: request.handoffId,
			subjectSessionId: session.sessionId,
			finalSessionHead: request.finalSessionHead,
			targetAuthorityId: request.targetAuthorityId,
			targetTenantId: request.targetTenantId,
			targetRuntimeId: createRuntimeId("runtime", "handoff-target"),
			leaseTransferReceiptId: createRuntimeId("receipt", "handoff-transfer"),
			leaseTransferReceiptDigest: canonicalDigest("handoff-transfer"),
			referenceGraphDigest: request.referenceGraphDigest,
		}));
		expect(committed.cursor.sequence).toBe(2);
		const joined = valueOf(joinSessionLifecycle(session.projection, committed.projection));
		expect(joined.lifecycleHeadRef).toMatchObject({
			lifecycle: "handoff",
			state: "committed",
			cursor: { sequence: 2 },
			finalSessionHead: { sequence: 0 },
		});
		expect(joined.projectionDigest).not.toBe(session.projection.projectionDigest);
		expect((await reopenedRepository.replay()).ok).toBe(true);
	});

	it("requires deletion tombstone plus commit before GC and verifies snapshot lifecycle joins", async () => {
		const session = await createSessionFixture("delete");
		const authority = await createAuthorityFixture("delete", session.identity);
		const plannedPayload = deletionPlan(session.projection, "delete");
		const planned = valueOf(await authority.service.planDeletion(context(session.identity, "delete-plan"), plannedPayload));
		const finalCursor = projectionCursor(session.projection);
		expect(requireCommittedDeletionForGc(
			planned.projection,
			session.sessionId,
			finalCursor,
			plannedPayload.referenceGraphDigest,
		).ok).toBe(false);

		const tombstoned = valueOf(await authority.service.tombstoneDeletion(context(session.identity, "delete-tombstone"), {
			deletionId: plannedPayload.deletionId,
			subjectSessionId: session.sessionId,
			plannedEventId: planned.event.eventId,
			finalSessionHead: plannedPayload.finalSessionHead,
			referenceGraphDigest: plannedPayload.referenceGraphDigest,
			tombstoneReceiptId: createRuntimeId("receipt", "delete-tombstone"),
			tombstoneReceiptDigest: canonicalDigest("delete-tombstone"),
		}));
		expect(requireCommittedDeletionForGc(
			tombstoned.projection,
			session.sessionId,
			finalCursor,
			plannedPayload.referenceGraphDigest,
		).ok).toBe(false);

		const committed = valueOf(await authority.service.commitDeletion(context(session.identity, "delete-commit"), {
			deletionId: plannedPayload.deletionId,
			subjectSessionId: session.sessionId,
			tombstoneEventId: tombstoned.event.eventId,
			finalSessionHead: plannedPayload.finalSessionHead,
			referenceGraphDigest: plannedPayload.referenceGraphDigest,
			deletionReceiptId: createRuntimeId("receipt", "delete-commit"),
			deletionReceiptDigest: canonicalDigest("delete-commit"),
		}));
		expect(requireCommittedDeletionForGc(
			committed.projection,
			session.sessionId,
			finalCursor,
			plannedPayload.referenceGraphDigest,
		).ok).toBe(true);
		expect(requireCommittedDeletionForGc(
			committed.projection,
			session.sessionId,
			{ ...finalCursor, eventHash: "f".repeat(64) },
			plannedPayload.referenceGraphDigest,
		).ok).toBe(false);

		const snapshot = valueOf(createSessionSnapshot(
			valueOf(await session.store.readPage(session.stream, { limit: 100 })).events,
			{
				snapshotId: createRuntimeId("snapshot", "delete"),
				activeLeafId: session.projection.activeLeafId,
				writtenAt: NOW.toISOString(),
				authorityLifecycle: committed.projection,
			},
		));
		expect(snapshot.lifecycleHeadRef).toMatchObject({ lifecycle: "deletion", state: "committed" });
		expect((await replaySessionSnapshot(session.store, snapshot)).ok).toBe(false);
		const replayed = valueOf(await replaySessionSnapshot(session.store, snapshot, committed.projection));
		expect(replayed.projection.projectionDigest).toBe(snapshot.projectionDigest);
	});

	it("rejects wrong subjects, tenants, and cross-stream final cursors before append", async () => {
		const session = await createSessionFixture("reject");
		const authority = await createAuthorityFixture("reject", session.identity);
		const base = handoffRequest(session.projection, "reject");
		const wrongSubject = await authority.service.requestHandoff(context(session.identity, "reject-subject"), {
			...base,
			subjectSessionId: createRuntimeId("session", "other"),
		});
		expect(wrongSubject).toMatchObject({ ok: false, error: { code: "invalid_event" } });
		const wrongTenant = await authority.service.requestHandoff(context(session.identity, "reject-tenant"), {
			...base,
			idempotencyKey: createIdempotencyKey("reject-tenant-idempotency-key"),
			sourceTenantId: createRuntimeId("tenant", "other"),
		});
		expect(wrongTenant).toMatchObject({ ok: false });
		const crossStream = await authority.service.requestHandoff(context(session.identity, "reject-stream"), {
			...base,
			idempotencyKey: createIdempotencyKey("reject-stream-idempotency-key"),
			finalSessionHead: {
				...base.finalSessionHead,
				cursor: { ...base.finalSessionHead.cursor, stream: authority.stream },
			},
		});
		expect(crossStream).toMatchObject({ ok: false });
		expect(valueOf(await authority.repository.replay()).events).toHaveLength(0);
	});

	it("publishes subscriptions only after flush and flushes every authority mutation class", async () => {
		const session = await createSessionFixture("subscription");
		const freshSessionId = createRuntimeId("session", "subscription-fresh");
		const stream = createSessionEventStreamRef(session.identity, freshSessionId);
		const writerFence = fence(session.identity.authorityId, session.identity.tenantId, stream, "subscription-fresh");
		const store = new MemoryEventStore({
			authorityId: session.identity.authorityId,
			tenantId: session.identity.tenantId,
			stream,
			validateFence: () => true,
		});
		const writer = new EventWriter({
			authorityId: session.identity.authorityId,
			tenantId: session.identity.tenantId,
			stream,
			store,
			fence: writerFence,
		});
		const iterator = store.subscribe(stream)[Symbol.asyncIterator]();
		let published = false;
		const pending = iterator.next().then((result) => {
			published = true;
			return result;
		});
		valueOf(await writer.append({
			type: "session.created",
			...context(session.identity, "subscription-genesis"),
			payload: {
				origin: "test",
				runtimeId: writerFence.ownerRuntimeId,
				featureDigest: DIGEST,
				initialGoalId: createRuntimeId("goal", "subscription"),
				rootAgentId: createRuntimeId("agent", "subscription"),
			},
		}));
		await Promise.resolve();
		expect(published).toBe(false);
		valueOf(await writer.flush());
		expect((await pending).value?.type).toBe("session.created");
		await iterator.return?.();

		for (const type of [
			"session.handoff_requested",
			"session.deletion_planned",
			"command.claimed",
			"command.applied",
			"command.rejected",
			"command.reconciliation_required",
			"runtime.replacement_prepared",
			"runtime.generation_activated",
			"runtime.replacement_failed",
			"daemon.shutdown_requested",
			"daemon.shutdown_completed",
			"daemon.shutdown_failed",
			"policy.effective_recorded",
			"resource.approved",
		] as const) expect(MANDATORY_FLUSH_EVENT_TYPES.has(type)).toBe(true);
	});

	it("closes the repository mutation gate when a mandatory durable receipt is uncertain", async () => {
		const session = await createSessionFixture("uncertain");
		const authority = await createAuthorityFixture("uncertain", session.identity);
		vi.spyOn(authority.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: { code: "durable_write_failed", message: "injected", retryable: false, effect: "uncertain" },
		});
		const first = await authority.service.requestHandoff(
			context(session.identity, "uncertain-request"),
			handoffRequest(session.projection, "uncertain"),
		);
		expect(first).toMatchObject({ ok: false, error: { code: "durable_write_failed", effect: "uncertain" } });
		expect(authority.repository.mutationError()).toBeDefined();
		const second = await authority.repository.append({
			type: "policy.effective_recorded",
			...context(session.identity, "uncertain-after"),
			payload: {
				policyId: createRuntimeId("resource", "uncertain"),
				policyRevision: 1,
				policyDigest: DIGEST,
				sourceReceiptId: createRuntimeId("receipt", "uncertain"),
				sourceReceiptDigest: DIGEST,
				effectiveAt: NOW.toISOString(),
			},
		});
		expect(second).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
	});
});
