import { describe, expect, it, vi } from "vitest";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { verifyRuntimeEventChain } from "../../../src/runtime/session/chain-verification.ts";
import {
	EventWriter,
	MANDATORY_FLUSH_EVENT_TYPES,
	openEventWriter,
} from "../../../src/runtime/session/event-writer.ts";
import { MemoryEventStore } from "../../../src/runtime/session/memory-event-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function setup() {
	const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
	const sessionId = createRuntimeId("session", "kernel-test");
	const stream = createSessionEventStreamRef(identity, sessionId);
	const fence: WriterFence = {
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		leaseId: createRuntimeId("lease", "kernel-test"),
		ownerRuntimeId: createRuntimeId("runtime", "kernel-test"),
		writerEpoch: 1,
		fencingToken: "secret-fence-token",
	};
	let activeToken = fence.fencingToken;
	const store = new MemoryEventStore({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		validateFence: (candidate) => candidate.writerEpoch === 1 && candidate.fencingToken === activeToken,
	});
	const writer = new EventWriter({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		stream,
		store,
		fence,
		clock: () => new Date("2026-07-22T00:00:00.000Z"),
	});
	return { identity, sessionId, stream, fence, store, writer, revoke: () => (activeToken = "revoked") };
}

async function appendGenesis(context: ReturnType<typeof setup>) {
	return context.writer.append({
		type: "session.created",
		principalId: context.identity.principalId,
		traceId: createRuntimeId("trace", "genesis"),
		payload: {
			origin: "test",
			runtimeId: context.fence.ownerRuntimeId,
			featureDigest: digest,
			initialGoalId: createRuntimeId("goal", "kernel-test"),
			rootAgentId: createRuntimeId("agent", "kernel-test"),
		},
	});
}

describe("RuntimeEventStore memory contract", () => {
	it("allocates concurrent appends through one deterministic writer queue", async () => {
		const context = setup();
		expect((await appendGenesis(context)).ok).toBe(true);
		const results = await Promise.all(
			Array.from({ length: 5 }, (_, index) =>
				context.writer.append({
					type: "conversation.message_recorded",
					principalId: context.identity.principalId,
					traceId: createRuntimeId("trace", `turn-${index}`),
					payload: {
						role: "user",
						messageJson: JSON.stringify({ role: "user", content: [{ type: "text", text: `turn-${index}` }] }),
						contentDigest: canonicalDigest(JSON.stringify({ role: "user", content: [{ type: "text", text: `turn-${index}` }] })),
						},
					}),
			),
		);
		expect(results.every((result) => result.ok)).toBe(true);
		expect(results.map((result) => (result.ok ? result.value.cursor.sequence : -1))).toEqual([1, 2, 3, 4, 5]);
		const verified = await context.store.verify(context.stream);
		expect(verified).toMatchObject({ ok: true, value: { integrity: "valid", eventCount: 6 } });
	});

	it("rejects stale expected revisions and permanently fences the old writer", async () => {
		const context = setup();
		expect((await appendGenesis(context)).ok).toBe(true);
		const competing = new EventWriter({
			authorityId: context.identity.authorityId,
			tenantId: context.identity.tenantId,
			stream: context.stream,
			store: context.store,
			fence: context.fence,
			clock: () => new Date("2026-07-22T00:00:00.000Z"),
		});
		const conflict = await competing.append({
			type: "session.created",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "competing"),
			payload: {
				origin: "test",
				runtimeId: context.fence.ownerRuntimeId,
				featureDigest: digest,
				initialGoalId: createRuntimeId("goal", "kernel-test"),
				rootAgentId: createRuntimeId("agent", "kernel-test"),
			},
		});
		expect(conflict).toMatchObject({ ok: false, error: { code: "sequence_conflict" } });

		context.revoke();
		const fenced = await context.writer.append({
			type: "session.stop_requested",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "stop"),
			payload: {
				reason: "test stop",
				requestedBy: context.identity.principalId,
				expectedRevision: {
					stream: context.stream,
					sequence: 0,
					eventHash: context.writer.currentHead()?.eventHash ?? digest,
				},
			},
		});
		expect(fenced).toMatchObject({ ok: false, error: { code: "writer_fenced" } });
		const repeated = await context.writer.append({
			type: "session.stop_requested",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "stop-again"),
			payload: {
				reason: "test stop again",
				requestedBy: context.identity.principalId,
				expectedRevision: { stream: context.stream, sequence: 0, eventHash: digest },
			},
		});
		expect(repeated).toMatchObject({ ok: false, error: { code: "writer_fenced" } });
	});

	it("replays committed events to subscribers and paginates by sequence", async () => {
		const context = setup();
		const subscription = context.store.subscribe(context.stream)[Symbol.asyncIterator]();
		const pending = subscription.next();
		const committed = await appendGenesis(context);
		expect(committed.ok).toBe(true);
		expect((await context.writer.flush()).ok).toBe(true);
		expect((await pending).value?.type).toBe("session.created");
		const page = await context.store.readPage(context.stream, { limit: 1 });
		expect(page).toMatchObject({ ok: true, value: { hasMore: false, events: [{ sequence: 0 }] } });
		await subscription.return?.();
	});

	it("detects the first canonical payload/hash tamper", async () => {
		const context = setup();
		const committed = await appendGenesis(context);
		if (!committed.ok) throw new Error("fixture append failed");
		const tampered = {
			...committed.value.event,
			payload: { ...committed.value.event.payload, featureDigest: "f".repeat(64) },
		};
		const verification = verifyRuntimeEventChain([tampered], {
			authorityId: context.identity.authorityId,
			tenantId: context.identity.tenantId,
			stream: context.stream,
		});
		expect(verification).toMatchObject({ integrity: "corrupted", firstBadSequence: 0, error: { code: "hash_mismatch" } });
	});

	it("flushes tool terminal events before allowing later work", async () => {
		expect(MANDATORY_FLUSH_EVENT_TYPES.has("tool.started")).toBe(true);
		const context = setup();
		expect((await appendGenesis(context)).ok).toBe(true);
		const flush = vi.spyOn(context.store, "flushThrough");
		const turnId = createRuntimeId("turn", "tool-terminal");
		const toolCallId = createRuntimeId("toolCall", "fixture");
		expect((await context.writer.append({
			type: "turn.started",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "tool-turn"),
			payload: { turnId, goalId: createRuntimeId("goal", "fixture") },
		})).ok).toBe(true);
		expect((await context.writer.append({
			type: "tool.requested",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "tool-request"),
			payload: {
				turnId,
				toolCallId,
				agentId: createRuntimeId("agent", "fixture"),
				toolIdentityDigest: digest,
				argumentsDigest: digest,
			},
		})).ok).toBe(true);
		const terminal = await context.writer.append({
			type: "tool.failed",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "tool-terminal"),
			payload: {
				toolCallId,
				error: { code: "fixture_failure", messageDigest: digest, retryable: false },
				outcomeCertain: true,
			},
		});
		expect(terminal.ok).toBe(true);
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("converts unexpected store failures into a terminal typed result", async () => {
		const context = setup();
		vi.spyOn(context.store, "append").mockRejectedValueOnce(new Error("disk details must not escape"));
		const first = await appendGenesis(context);
		expect(first).toMatchObject({
			ok: false,
			error: { code: "durable_write_failed", retryable: false, details: { errorName: "Error" } },
		});
		expect(JSON.stringify(first)).not.toContain("disk details");
		const repeated = await appendGenesis(context);
		expect(repeated).toMatchObject({ ok: false, error: { code: "durable_write_failed" } });
	});

	it("opens a writer only after verification and resumes from the durable head", async () => {
		const context = setup();
		expect((await appendGenesis(context)).ok).toBe(true);
		const reopened = await openEventWriter({
			authorityId: context.identity.authorityId,
			tenantId: context.identity.tenantId,
			stream: context.stream,
			store: context.store,
			fence: context.fence,
			clock: () => new Date("2026-07-22T00:00:01.000Z"),
		});
		expect(reopened.ok).toBe(true);
		if (!reopened.ok) return;
		const next = await reopened.value.append({
			type: "turn.started",
			principalId: context.identity.principalId,
			traceId: createRuntimeId("trace", "reopened"),
			payload: { turnId: createRuntimeId("turn", "reopened"), goalId: createRuntimeId("goal", "fixture") },
		});
		expect(next).toMatchObject({ ok: true, value: { cursor: { sequence: 1 } } });
	});
});
