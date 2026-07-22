import { describe, expect, it, vi } from "vitest";
import {
	BudgetGuard,
	createBudgetVector,
	type BudgetJournalRecord,
} from "../../../src/runtime/orchestrator/budget-guard.ts";
import {
	createDurableGoalStateMachine,
	type GoalJournalRecord,
} from "../../../src/runtime/orchestrator/goal-state-machine.ts";
import { openSavePointCoordinator } from "../../../src/runtime/orchestrator/save-point.ts";
import { InMemoryDurableOrchestratorJournal } from "../../../src/runtime/orchestrator/turn-orchestrator.ts";
import {
	SessionDurableOrchestratorJournal,
	type OrchestratorJournalKind,
} from "../../../src/runtime/orchestrator/session-journal.ts";
import type {
	DurableJournalTransaction,
	CompletionTrustPort,
	SavePointJournalRecord,
} from "../../../src/runtime/orchestrator/types.ts";
import { canonicalDigest, canonicalJson } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey, type IdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef, type RuntimeEventV3 } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES } from "../../../src/runtime/protocol/v3/event-payloads.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { bindings, budgetLimits } from "./helpers.ts";

const NOW = "2026-07-22T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const DENY_COMPLETION: CompletionTrustPort = { verify: async () => false };

interface FixtureRecord {
	kind: string;
	marker: string;
}

let sequence = 0;

function nextSeed(prefix: string): string {
	sequence += 1;
	return `${prefix}-${sequence}`;
}

function idempotency(seed: string): IdempotencyKey {
	return createIdempotencyKey(`${seed}-${"x".repeat(24)}`);
}

function transaction(
	seed: string,
	record: FixtureRecord,
	key: IdempotencyKey = idempotency(seed),
): DurableJournalTransaction<FixtureRecord> {
	const records = [record];
	return {
		transactionId: createRuntimeId("command", seed),
		idempotencyKey: key,
		transactionDigest: canonicalDigest(records),
		committedAt: NOW,
		records,
	};
}

function setup() {
	const authorityId = createRuntimeId("authority", nextSeed("orchestrator-journal"));
	const tenantId = createRuntimeId("tenant", nextSeed("orchestrator-journal"));
	const principalId = createRuntimeId("principal", nextSeed("orchestrator-journal"));
	const sessionId = createRuntimeId("session", nextSeed("orchestrator-journal"));
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const runtimeId = createRuntimeId("runtime", nextSeed("orchestrator-journal"));
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", nextSeed("orchestrator-journal")),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: `orchestrator-journal-fence-${nextSeed("token")}`,
	};
	const store = new MemoryEventStore({ authorityId, tenantId, stream, validateFence: () => true });
	const writer = new EventWriter({ authorityId, tenantId, stream, store, fence, clock: () => new Date(NOW) });
	const makeJournal = <TRecord = FixtureRecord>(journalKind: OrchestratorJournalKind, selectedWriter = writer) =>
		new SessionDurableOrchestratorJournal<TRecord>({
			journalKind,
			writer: selectedWriter,
			store,
			principalId,
			traceIdFactory: () => createRuntimeId("trace", nextSeed("orchestrator-journal")),
		});
	return { authorityId, tenantId, principalId, sessionId, stream, runtimeId, fence, store, writer, makeJournal };
}

async function appendGenesis(context: ReturnType<typeof setup>): Promise<void> {
	const result = await context.writer.append({
		type: "session.created",
		principalId: context.principalId,
		traceId: createRuntimeId("trace", nextSeed("orchestrator-genesis")),
		payload: {
			origin: "test",
			runtimeId: context.runtimeId,
			featureDigest: DIGEST,
			initialGoalId: createRuntimeId("goal", nextSeed("orchestrator-genesis")),
			rootAgentId: createRuntimeId("agent", nextSeed("orchestrator-genesis")),
		},
	});
	expect(result.ok).toBe(true);
}

interface RawAppendOptions {
	journalKind: OrchestratorJournalKind;
	journalRevision: number;
	records: readonly FixtureRecord[];
	idempotencyKey?: IdempotencyKey;
	transactionId?: ReturnType<typeof createRuntimeId<"command">>;
	transactionDigest?: string;
	recordsJson?: string;
}

async function appendRaw(context: ReturnType<typeof setup>, options: RawAppendOptions): Promise<void> {
	const recordsJson = options.recordsJson ?? canonicalJson(options.records);
	const result = await context.writer.append({
		type: "orchestrator.journal_committed",
		principalId: context.principalId,
		traceId: createRuntimeId("trace", nextSeed("raw-journal")),
		timestamp: NOW,
		payload: {
			journalKind: options.journalKind,
			journalRevision: options.journalRevision,
			transactionId: options.transactionId ?? createRuntimeId("command", nextSeed("raw-journal")),
			idempotencyKey: options.idempotencyKey ?? idempotency(nextSeed("raw-journal")),
			transactionDigest: options.transactionDigest ?? canonicalDigest(options.records),
			recordCount: options.records.length,
			recordsByteLength: Buffer.byteLength(recordsJson, "utf8"),
			recordsJson,
		},
	});
	expect(result.ok).toBe(true);
}

describe("SessionDurableOrchestratorJournal", () => {
	it("restarts the real goal/save-point/budget consumers from independent journal revisions", async () => {
		const context = setup();
		await appendGenesis(context);
		const goalId = createRuntimeId("goal", nextSeed("durable-goal"));
		const initialGoal = { goalId, phase: "planning" as const, revision: 0, evidence: [], partialResults: [] };
		const goalJournal = context.makeJournal<GoalJournalRecord>("goal");
		const goal = await createDurableGoalStateMachine(
			{
				journal: goalJournal,
				completionTrust: DENY_COMPLETION,
				clock: () => new Date(NOW),
			},
			initialGoal,
			idempotency(nextSeed("goal-genesis")),
		);
		expect(goal).toMatchObject({ ok: true });

		const initialBindings = bindings();
		const savePointJournal = context.makeJournal<SavePointJournalRecord>("save_point");
		const savePoints = await openSavePointCoordinator({
			initialBindings,
			journal: savePointJournal,
			clock: () => new Date(NOW),
		});
		expect(savePoints.ok).toBe(true);
		if (!savePoints.ok) return;
		const operationId = createRuntimeId("command", nextSeed("save-point-operation"));
		expect((await savePoints.value.begin(operationId, idempotency(nextSeed("save-point-begin")))).ok).toBe(true);

		const budgetJournal = context.makeJournal<BudgetJournalRecord>("budget");
		const budget = new BudgetGuard({
			goalId,
			limits: budgetLimits(),
			journal: budgetJournal,
			clock: () => new Date(NOW),
		});
		expect((await budget.reserve({
			reservationId: createRuntimeId("budgetReservation", nextSeed("budget-reservation")),
			operationId: createRuntimeId("command", nextSeed("budget-operation")),
			idempotencyKey: idempotency(nextSeed("budget-reserve")),
			estimatedUpperBound: createBudgetVector({ inputTokens: 1 }),
		})).ok).toBe(true);

		const reopenedWriter = new EventWriter({
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			stream: context.stream,
			store: context.store,
			fence: context.fence,
			initialHead: context.writer.currentHead(),
			clock: () => new Date(NOW),
		});
		const reopenedGoal = await createDurableGoalStateMachine(
			{
				journal: context.makeJournal<GoalJournalRecord>("goal", reopenedWriter),
				completionTrust: DENY_COMPLETION,
				clock: () => new Date(NOW),
			},
			initialGoal,
			idempotency(nextSeed("unused-goal-genesis")),
		);
		expect(reopenedGoal.ok && reopenedGoal.value.snapshot()).toMatchObject({ goalId, phase: "planning", revision: 0 });
		const reopenedSavePoints = await openSavePointCoordinator({
			initialBindings,
			journal: context.makeJournal<SavePointJournalRecord>("save_point", reopenedWriter),
			clock: () => new Date(NOW),
		});
		expect(reopenedSavePoints.ok && reopenedSavePoints.value.activeSavePoint()).toMatchObject({ operationId });
		const reopenedBudget = new BudgetGuard({
			goalId,
			limits: budgetLimits(),
			journal: context.makeJournal<BudgetJournalRecord>("budget", reopenedWriter),
			clock: () => new Date(NOW),
		});
		expect(await reopenedBudget.snapshot()).toMatchObject({ ok: true, value: { revision: 1, reserved: { inputTokens: 1 } } });
		const page = await context.store.readPage(context.stream, { limit: 100 });
		expect(page.ok && page.value.events.flatMap((event) =>
			event.type === "orchestrator.journal_committed" ? [event.payload.journalKind] : [],
		)).toEqual(["goal", "save_point", "budget"]);
	});

	it("matches the in-memory duplicate, idempotency-conflict, and stale-revision outcomes", async () => {
		const context = setup();
		await appendGenesis(context);
		const durable = context.makeJournal("goal");
		const reference = new InMemoryDurableOrchestratorJournal<FixtureRecord>();
		const key = idempotency(nextSeed("same-key"));
		const first = transaction(nextSeed("first"), { kind: "goal.created", marker: "one" }, key);
		expect(await durable.append(0, first)).toMatchObject({ ok: true, value: { status: "committed", revision: 1 } });
		expect(await reference.append(0, first)).toMatchObject({ ok: true, value: { status: "committed", revision: 1 } });

		const duplicate = { ...first, transactionId: createRuntimeId("command", nextSeed("duplicate")) };
		const durableDuplicate = await durable.append(999, duplicate);
		const referenceDuplicate = await reference.append(999, duplicate);
		expect(durableDuplicate).toMatchObject({
			ok: true,
			value: { status: "duplicate", revision: 1, transaction: { transactionId: first.transactionId } },
		});
		expect(referenceDuplicate).toMatchObject({
			ok: true,
			value: { status: "duplicate", revision: 1, transaction: { transactionId: first.transactionId } },
		});

		const collided = transaction(nextSeed("collision"), { kind: "goal.created", marker: "two" }, key);
		expect(await durable.append(1, collided)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});
		expect(await reference.append(1, collided)).toMatchObject({
			ok: false,
			error: { code: "idempotency_conflict", retryable: false },
		});

		const fresh = transaction(nextSeed("fresh"), { kind: "goal.transitioned", marker: "fresh" });
		expect(await durable.append(0, fresh)).toEqual({ ok: true, value: { status: "conflict", actualRevision: 1 } });
		expect(await reference.append(0, fresh)).toEqual({ ok: true, value: { status: "conflict", actualRevision: 1 } });
	});

	it("fails closed on hash tampering and on a hash-valid records digest mismatch", async () => {
		const context = setup();
		await appendGenesis(context);
		const journal = context.makeJournal("goal");
		expect((await journal.append(
			0,
			transaction(nextSeed("tamper"), { kind: "goal.created", marker: "original" }),
		)).ok).toBe(true);
		const originalPage = await context.store.readPage(context.stream, { limit: 100 });
		expect(originalPage.ok).toBe(true);
		if (!originalPage.ok) return;
		const tamperedEvents = originalPage.value.events.map((event): RuntimeEventV3 => {
			if (event.type !== "orchestrator.journal_committed") return event;
			return {
				...event,
				payload: { ...event.payload, recordsJson: event.payload.recordsJson.replace("original", "modified") },
			};
		});
		vi.spyOn(context.store, "readPage").mockResolvedValue({
			ok: true,
			value: { events: tamperedEvents, hasMore: false },
		});
		expect(await journal.load()).toMatchObject({ ok: false, error: { code: "invalid_input" } });

		const digestContext = setup();
		await appendGenesis(digestContext);
		await appendRaw(digestContext, {
			journalKind: "goal",
			journalRevision: 1,
			records: [{ kind: "goal.created", marker: "digest-mismatch" }],
			transactionDigest: "f".repeat(64),
		});
		expect(await digestContext.makeJournal("goal").load()).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal transaction digest mismatch" },
		});
	});

	it("rejects wrong record kinds, revision gaps, and duplicate durable keys during replay", async () => {
		const wrongKind = setup();
		await appendGenesis(wrongKind);
		await appendRaw(wrongKind, {
			journalKind: "goal",
			journalRevision: 1,
			records: [{ kind: "queue.enqueued", marker: "wrong-kind" }],
		});
		expect(await wrongKind.makeJournal("goal").load()).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal record kind does not match its journal" },
		});

		const nonCanonical = setup();
		await appendGenesis(nonCanonical);
		const nonCanonicalRecords = [{ kind: "goal.created", marker: "non-canonical" }];
		await appendRaw(nonCanonical, {
			journalKind: "goal",
			journalRevision: 1,
			records: nonCanonicalRecords,
			recordsJson: JSON.stringify(nonCanonicalRecords, null, 2),
		});
		expect(await nonCanonical.makeJournal("goal").load()).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal records JSON is not canonical" },
		});

		const gap = setup();
		await appendGenesis(gap);
		await appendRaw(gap, {
			journalKind: "goal",
			journalRevision: 2,
			records: [{ kind: "goal.created", marker: "revision-gap" }],
		});
		expect(await gap.makeJournal("goal").load()).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal revision is discontinuous" },
		});

		const duplicate = setup();
		await appendGenesis(duplicate);
		const duplicateKey = idempotency(nextSeed("durable-duplicate"));
		await appendRaw(duplicate, {
			journalKind: "budget",
			journalRevision: 1,
			records: [{ kind: "budget.reserved", marker: "first" }],
			idempotencyKey: duplicateKey,
		});
		await appendRaw(duplicate, {
			journalKind: "budget",
			journalRevision: 2,
			records: [{ kind: "budget.committed", marker: "second" }],
			idempotencyKey: duplicateKey,
		});
		expect(await duplicate.makeJournal("budget").load()).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal idempotency key is duplicated" },
		});
	});

	it("enforces the records UTF-8 byte bound without offloading journal records to Artifact", async () => {
		const context = setup();
		await appendGenesis(context);
		const oversized = transaction(nextSeed("oversized"), {
			kind: "goal.created",
			marker: "\u{1f642}".repeat(Math.floor(MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES / 3)),
		});
		expect(canonicalJson(oversized.records).length).toBeLessThan(MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES);
		expect(Buffer.byteLength(canonicalJson(oversized.records), "utf8")).toBeGreaterThan(
			MAX_ORCHESTRATOR_JOURNAL_RECORDS_JSON_BYTES,
		);
		expect(await context.makeJournal("goal").append(0, oversized)).toMatchObject({
			ok: false,
			error: { code: "invalid_input", message: "orchestrator journal records byte length is invalid" },
		});
		const page = await context.store.readPage(context.stream, { limit: 10 });
		expect(page.ok && page.value.events).toHaveLength(1);
	});

	it("uses a mandatory flush barrier and reports flush exceptions without throwing", async () => {
		const context = setup();
		await appendGenesis(context);
		const flush = vi.spyOn(context.store, "flushThrough").mockResolvedValueOnce({
			ok: false,
			error: { code: "durable_write_failed", message: "injected disk full", retryable: false },
		});
		expect(await context.makeJournal("goal").append(
			0,
			transaction(nextSeed("flush"), { kind: "goal.created", marker: "flush" }),
		)).toMatchObject({ ok: false, error: { code: "journal_unavailable", retryable: false } });
		expect(flush).toHaveBeenCalledTimes(1);

		const unavailable = setup();
		await appendGenesis(unavailable);
		vi.spyOn(unavailable.store, "verify").mockRejectedValueOnce(new Error("injected read failure"));
		await expect(unavailable.makeJournal("goal").load()).resolves.toMatchObject({
			ok: false,
			error: { code: "journal_unavailable" },
		});
	});
});
