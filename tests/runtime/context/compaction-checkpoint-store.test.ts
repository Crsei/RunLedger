import { describe, expect, it } from "vitest";
import { calculateCompactionInvariantDigest } from "../../../src/runtime/context/invariants.ts";
import {
	InMemoryCompactionCheckpointStore,
	type CompactionCheckpointStoreResult,
} from "../../../src/runtime/context/compaction/checkpoint-store.ts";
import type { CompactionCheckpoint, CompactionStatus } from "../../../src/runtime/context/compaction/types.ts";
import { runtimeDigest, type RuntimeContentRef } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type SessionId, type SnapshotId } from "../../../src/runtime/protocol/ids.ts";

const EVENT_DIGEST = runtimeDigest("checkpoint-store-event");
const PROJECTION_DIGEST = runtimeDigest("checkpoint-store-projection");
const CREATED_AT = "2026-08-04T00:00:00.000Z";

function sourceRange(sessionId: SessionId, endSequence = 4): CompactionCheckpoint["sourceRange"] {
	return {
		stream: { scope: "session", streamId: sessionId, sessionId },
		startSequence: 0,
		endSequence,
		head: { streamId: sessionId, sequence: endSequence, eventHash: EVENT_DIGEST },
		rangeDigest: runtimeDigest({ sessionId, endSequence }),
		complete: true,
	};
}

function ref(subjectKind: RuntimeContentRef["subjectKind"], seed: string): RuntimeContentRef {
	return { subjectKind, digest: runtimeDigest(seed), mediaType: "application/json", size: seed.length };
}

function checkpoint(
	status: CompactionStatus,
	options: {
		readonly compactionId?: SnapshotId;
		readonly sessionId?: SessionId;
		readonly attempt?: number;
		readonly endSequence?: number;
		readonly replacementArtifactRef?: RuntimeContentRef;
		readonly terminalReceiptRef?: RuntimeContentRef;
	} = {},
): CompactionCheckpoint {
	const compactionId = options.compactionId ?? createRuntimeId("snapshot", "checkpoint-store");
	const sessionId = options.sessionId ?? createRuntimeId("session", "checkpoint-store");
	const body: Omit<CompactionCheckpoint, "invariantDigest"> = {
		compactionId,
		sessionId,
		reason: "manual",
		status,
		sourceRange: sourceRange(sessionId, options.endSequence),
		...(options.replacementArtifactRef === undefined ? {} : { replacementArtifactRef: options.replacementArtifactRef }),
		attempt: options.attempt ?? 1,
		...(options.terminalReceiptRef === undefined ? {} : { terminalReceiptRef: options.terminalReceiptRef }),
		projectionDigest: PROJECTION_DIGEST,
		completeness: "complete",
		createdAt: CREATED_AT,
	};
	return { ...body, invariantDigest: calculateCompactionInvariantDigest(body) };
}

function valueOf<T>(result: CompactionCheckpointStoreResult<T>): T {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

describe("InMemoryCompactionCheckpointStore", () => {
	it("accepts the planned to started to completed lifecycle and exposes the latest completed checkpoint", () => {
		const sessionId = createRuntimeId("session", "checkpoint-lifecycle");
		const compactionId = createRuntimeId("snapshot", "checkpoint-lifecycle");
		const planned = checkpoint("planned", { sessionId, compactionId, attempt: 1 });
		const started = checkpoint("started", { sessionId, compactionId, attempt: 1 });
		const completed = checkpoint("completed", {
			sessionId,
			compactionId,
			attempt: 1,
			replacementArtifactRef: ref("artifact", "summary"),
			terminalReceiptRef: ref("receipt", "completed"),
		});
		const store = new InMemoryCompactionCheckpointStore();

		expect(store.apply(planned)).toMatchObject({ ok: true, replayed: false });
		expect(store.apply(started)).toMatchObject({ ok: true, replayed: false });
		expect(store.apply(completed)).toMatchObject({ ok: true, replayed: false });
		expect(store.latest(sessionId)).toEqual(completed);
		expect(store.list(sessionId)).toEqual([completed]);
	});

	it("accepts the planned to started to failed terminal lifecycle", () => {
		const sessionId = createRuntimeId("session", "checkpoint-failed");
		const compactionId = createRuntimeId("snapshot", "checkpoint-failed");
		const planned = checkpoint("planned", { sessionId, compactionId });
		const started = checkpoint("started", { sessionId, compactionId });
		const failed = checkpoint("failed", {
			sessionId,
			compactionId,
			terminalReceiptRef: ref("receipt", "failed"),
		});
		const store = new InMemoryCompactionCheckpointStore();

		valueOf(store.apply(planned));
		valueOf(store.apply(started));
		valueOf(store.apply(failed));

		expect(store.get(compactionId)).toEqual(failed);
		expect(store.latest(sessionId)).toBeUndefined();
	});

	it("keeps attempts monotonic and treats an exact replay as a no-op", () => {
		const sessionId = createRuntimeId("session", "checkpoint-attempt");
		const compactionId = createRuntimeId("snapshot", "checkpoint-attempt");
		const planned = checkpoint("planned", { sessionId, compactionId, attempt: 1 });
		const started = checkpoint("started", { sessionId, compactionId, attempt: 2 });
		const completed = checkpoint("completed", {
			sessionId,
			compactionId,
			attempt: 2,
			replacementArtifactRef: ref("artifact", "attempt-summary"),
			terminalReceiptRef: ref("receipt", "attempt-completed"),
		});
		const store = new InMemoryCompactionCheckpointStore();

		valueOf(store.apply(planned));
		valueOf(store.apply(started));
		valueOf(store.apply(completed));
		const replay = store.apply(completed);

		expect(replay).toMatchObject({ ok: true, replayed: true, value: completed });
		expect(store.list()).toHaveLength(1);
		const lowerAttempt = checkpoint("completed", {
			sessionId,
			compactionId,
			attempt: 1,
			replacementArtifactRef: ref("artifact", "attempt-summary"),
			terminalReceiptRef: ref("receipt", "attempt-completed"),
		});
		expect(store.apply(lowerAttempt)).toMatchObject({ ok: false, error: { code: "attempt_not_monotonic" } });
	});

	it("replays an ordered lifecycle without duplicating state", () => {
		const sessionId = createRuntimeId("session", "checkpoint-replay");
		const compactionId = createRuntimeId("snapshot", "checkpoint-replay");
		const planned = checkpoint("planned", { sessionId, compactionId });
		const started = checkpoint("started", { sessionId, compactionId });
		const completed = checkpoint("completed", {
			sessionId,
			compactionId,
			replacementArtifactRef: ref("artifact", "replay-summary"),
			terminalReceiptRef: ref("receipt", "replay-completed"),
		});
		const store = new InMemoryCompactionCheckpointStore();

		const result = store.replay([planned, started, completed, completed]);

		expect(result).toMatchObject({ ok: true });
		expect(store.latest(sessionId)).toEqual(completed);
		expect(store.list()).toHaveLength(1);
	});

	it("rejects invalid schema, invalid invariant, and a completed checkpoint without refs", () => {
		const sessionId = createRuntimeId("session", "checkpoint-validation");
		const compactionId = createRuntimeId("snapshot", "checkpoint-validation");
		const planned = checkpoint("planned", { sessionId, compactionId });
		const store = new InMemoryCompactionCheckpointStore();

		expect(store.apply({ ...planned, attempt: 0 } as unknown)).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
		expect(store.apply({ ...planned, projectionDigest: runtimeDigest("tampered") })).toMatchObject({ ok: false, error: { code: "invalid_invariant" } });
		const incomplete = checkpoint("completed", { sessionId, compactionId });
		expect(store.apply(incomplete)).toMatchObject({ ok: false, error: { code: "invalid_schema" } });
	});

	it("rejects illegal transitions and session or source-range changes for one compaction", () => {
		const sessionId = createRuntimeId("session", "checkpoint-scope");
		const otherSessionId = createRuntimeId("session", "checkpoint-other-scope");
		const compactionId = createRuntimeId("snapshot", "checkpoint-scope");
		const planned = checkpoint("planned", { sessionId, compactionId });
		const started = checkpoint("started", { sessionId, compactionId });
		const completed = checkpoint("completed", {
			sessionId,
			compactionId,
			replacementArtifactRef: ref("artifact", "scope-summary"),
			terminalReceiptRef: ref("receipt", "scope-completed"),
		});
		const store = new InMemoryCompactionCheckpointStore();

		valueOf(store.apply(planned));
		expect(store.apply(completed)).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
		valueOf(store.apply(started));

		const otherSession = checkpoint("started", { sessionId: otherSessionId, compactionId });
		expect(store.apply(otherSession)).toMatchObject({ ok: false, error: { code: "scope_conflict" } });
		const changedRange = checkpoint("started", { sessionId, compactionId, endSequence: 5 });
		expect(store.apply(changedRange)).toMatchObject({ ok: false, error: { code: "source_range_conflict" } });
	});

	it("isolates read-only session queries and does not expose another session's latest checkpoint", () => {
		const firstSession = createRuntimeId("session", "checkpoint-list-first");
		const secondSession = createRuntimeId("session", "checkpoint-list-second");
		const firstCompactionId = createRuntimeId("snapshot", "checkpoint-list-first");
		const secondCompactionId = createRuntimeId("snapshot", "checkpoint-list-second");
		const first = checkpoint("completed", {
			sessionId: firstSession,
			compactionId: firstCompactionId,
			replacementArtifactRef: ref("artifact", "first-summary"),
			terminalReceiptRef: ref("receipt", "first-completed"),
		});
		const second = checkpoint("completed", {
			sessionId: secondSession,
			compactionId: secondCompactionId,
			replacementArtifactRef: ref("artifact", "second-summary"),
			terminalReceiptRef: ref("receipt", "second-completed"),
		});
		const firstPlanned = checkpoint("planned", { sessionId: firstSession, compactionId: firstCompactionId });
		const firstStarted = checkpoint("started", { sessionId: firstSession, compactionId: firstCompactionId });
		const secondPlanned = checkpoint("planned", { sessionId: secondSession, compactionId: secondCompactionId });
		const secondStarted = checkpoint("started", { sessionId: secondSession, compactionId: secondCompactionId });
		const store = new InMemoryCompactionCheckpointStore();

		valueOf(store.apply(firstPlanned));
		valueOf(store.apply(firstStarted));
		valueOf(store.apply(first));
		valueOf(store.apply(secondPlanned));
		valueOf(store.apply(secondStarted));
		valueOf(store.apply(second));

		expect(store.list(firstSession)).toEqual([first]);
		expect(store.latest(firstSession)).toEqual(first);
		expect(store.latest(createRuntimeId("session", "checkpoint-list-missing"))).toBeUndefined();
	});
});
