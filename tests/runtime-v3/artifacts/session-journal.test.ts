import { describe, expect, it } from "vitest";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import { SessionArtifactJournal } from "../../../src/runtime/artifacts/session-journal.ts";

const DIGEST = "a".repeat(64);
const NOW = "2026-07-22T00:00:00.000Z";

function setup() {
	const authorityId = createRuntimeId("authority", "artifact-journal");
	const tenantId = createRuntimeId("tenant", "artifact-journal");
	const principalId = createRuntimeId("principal", "artifact-journal");
	const sessionId = createRuntimeId("session", "artifact-journal");
	const runtimeId = createRuntimeId("runtime", "artifact-journal");
	const initialGoalId = createRuntimeId("goal", "artifact-journal");
	const rootAgentId = createRuntimeId("agent", "artifact-journal");
	const stream = createSessionEventStreamRef({ authorityId, tenantId }, sessionId);
	const fence: WriterFence = {
		authorityId,
		tenantId,
		stream,
		leaseId: createRuntimeId("lease", "artifact-journal"),
		ownerRuntimeId: runtimeId,
		writerEpoch: 1,
		fencingToken: "artifact-journal-fencing-token-0001",
	};
	const store = new MemoryEventStore({ authorityId, tenantId, stream, validateFence: () => true });
	const writer = new EventWriter({ authorityId, tenantId, stream, store, fence, clock: () => new Date(NOW) });
	const journal = new SessionArtifactJournal({ writer, store, principalId });
	return { authorityId, tenantId, principalId, sessionId, runtimeId, initialGoalId, rootAgentId, stream, store, writer, journal };
}

describe("SessionArtifactJournal", () => {
	it("persists intent/created/committed events and reconstructs state after adapter replacement", async () => {
		const context = setup();
		expect((await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "artifact-journal-genesis"),
			payload: { origin: "test", runtimeId: context.runtimeId, featureDigest: DIGEST, initialGoalId: context.initialGoalId, rootAgentId: context.rootAgentId },
		})).ok).toBe(true);
		const intent = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: createRuntimeId("command", "artifact-journal"),
			artifactId: createRuntimeId("artifact", "artifact-journal"),
			sessionId: context.sessionId,
			producerId: context.principalId,
			kind: "tool_output" as const,
			mediaType: "application/json",
			lineageDigest: DIGEST,
			createdAt: NOW,
		};
		expect((await context.journal.recordIntent(intent)).ok).toBe(true);
		expect(await context.writer.flush()).toEqual({ ok: true, value: undefined });
		const commit = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: intent.intentId,
			artifactId: intent.artifactId,
			storedDigest: DIGEST,
			storedSize: 42,
			metadataDigest: "b".repeat(64),
			transformReceiptId: createRuntimeId("receipt", "artifact-journal"),
			committedAt: NOW,
		};
		expect((await context.journal.recordCommit(commit)).ok).toBe(true);
		expect((await context.journal.recordCommit(commit)).ok).toBe(true);

		const page = await context.store.readPage(context.stream, { limit: 16 });
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		expect(page.value.events.map((event) => event.type)).toEqual([
			"session.created",
			"artifact.intent_recorded",
			"artifact.created",
			"artifact.committed",
		]);
		const reopened = new SessionArtifactJournal({
			writer: context.writer,
			store: context.store,
			principalId: context.principalId,
		});
		expect(await reopened.stateForIntent(intent.intentId)).toEqual({
			ok: true,
			value: { state: "committed", intent, commit },
		});
	});

	it("rejects an idempotency-key collision instead of appending a second intent", async () => {
		const context = setup();
		expect((await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "artifact-journal-collision"),
			payload: { origin: "test", runtimeId: context.runtimeId, featureDigest: DIGEST, initialGoalId: context.initialGoalId, rootAgentId: context.rootAgentId },
		})).ok).toBe(true);
		const intentId = createRuntimeId("command", "artifact-journal-collision");
		const base = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId,
			artifactId: createRuntimeId("artifact", "artifact-journal-one"),
			sessionId: context.sessionId,
			producerId: context.principalId,
			kind: "tool_output" as const,
			mediaType: "application/json",
			lineageDigest: DIGEST,
			createdAt: NOW,
		};
		expect((await context.journal.recordIntent(base)).ok).toBe(true);
		expect(await context.journal.listOpenIntents(base)).toEqual({ ok: true, value: [base] });
		expect(await context.journal.recordIntent({
			...base,
			artifactId: createRuntimeId("artifact", "artifact-journal-two"),
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});

	it("durably terminates a rolled-back intent and forbids a later commit", async () => {
		const context = setup();
		expect((await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "artifact-journal-abort"),
			payload: { origin: "test", runtimeId: context.runtimeId, featureDigest: DIGEST, initialGoalId: context.initialGoalId, rootAgentId: context.rootAgentId },
		})).ok).toBe(true);
		const intent = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: createRuntimeId("command", "artifact-journal-abort"),
			artifactId: createRuntimeId("artifact", "artifact-journal-abort"),
			sessionId: context.sessionId,
			producerId: context.principalId,
			kind: "tool_output" as const,
			mediaType: "application/json",
			lineageDigest: DIGEST,
			createdAt: NOW,
		};
		expect((await context.journal.recordIntent(intent)).ok).toBe(true);
		const abort = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: intent.intentId,
			artifactId: intent.artifactId,
			reason: "reconciled_rollback" as const,
			reasonDigest: DIGEST,
			abortedAt: NOW,
		};
		expect((await context.journal.recordAbort(abort)).ok).toBe(true);
		expect((await context.journal.recordAbort(abort)).ok).toBe(true);
		expect(await context.journal.recordAbort({
			...abort,
			reasonDigest: "b".repeat(64),
			abortedAt: "2026-07-22T00:00:01.000Z",
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		expect(await context.journal.stateForIntent(intent.intentId)).toEqual({
			ok: true,
			value: { state: "aborted", intent, abort },
		});
		expect(await context.journal.recordIntent(intent)).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(await context.journal.recordCommit({
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: intent.intentId,
			artifactId: intent.artifactId,
			storedDigest: DIGEST,
			storedSize: 1,
			metadataDigest: DIGEST,
			transformReceiptId: createRuntimeId("receipt", "abort"),
			committedAt: NOW,
		})).toMatchObject({ ok: false, error: { code: "invalid_request" } });
		const page = await context.store.readPage(context.stream, { limit: 16 });
		expect(page.ok && page.value.events.filter((event) => event.type === "artifact.aborted")).toHaveLength(1);
	});

	it("fails closed when a hash-valid journal contains both commit and abort terminals", async () => {
		const context = setup();
		expect((await context.writer.append({
			type: "session.created",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "artifact-journal-conflict"),
			payload: { origin: "test", runtimeId: context.runtimeId, featureDigest: DIGEST, initialGoalId: context.initialGoalId, rootAgentId: context.rootAgentId },
		})).ok).toBe(true);
		const intent = {
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: createRuntimeId("command", "artifact-journal-conflict"),
			artifactId: createRuntimeId("artifact", "artifact-journal-conflict"),
			sessionId: context.sessionId,
			producerId: context.principalId,
			kind: "tool_output" as const,
			mediaType: "application/json",
			lineageDigest: DIGEST,
			createdAt: NOW,
		};
		expect((await context.journal.recordIntent(intent)).ok).toBe(true);
		expect((await context.journal.recordCommit({
			authorityId: context.authorityId,
			tenantId: context.tenantId,
			intentId: intent.intentId,
			artifactId: intent.artifactId,
			storedDigest: DIGEST,
			storedSize: 1,
			metadataDigest: "b".repeat(64),
			transformReceiptId: createRuntimeId("receipt", "artifact-journal-conflict"),
			committedAt: NOW,
		})).ok).toBe(true);
		expect((await context.writer.append({
			type: "artifact.aborted",
			principalId: context.principalId,
			traceId: createRuntimeId("trace", "artifact-journal-conflict-abort"),
			payload: {
				artifactId: intent.artifactId,
				operationId: intent.intentId,
				reason: "reconciled_rollback",
				reasonDigest: DIGEST,
			},
		})).ok).toBe(true);
		expect(await context.journal.stateForIntent(intent.intentId)).toMatchObject({
			ok: false,
			error: { code: "corrupted_metadata" },
		});
	});
});
