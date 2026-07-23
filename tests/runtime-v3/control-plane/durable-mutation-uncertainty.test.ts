import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { V3InteractiveDurableQueue } from "../../../src/cli/interactive-control-plane.ts";
import { createLocalIdentityContext } from "../../../src/runtime/identity/local-principal.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey } from "../../../src/runtime/protocol/v3/coordination.ts";
import { createSessionEventStreamRef } from "../../../src/runtime/protocol/v3/events.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/v3/ids.ts";
import { AgentLoopSessionEvents } from "../../../src/runtime/session/agent-loop-events.ts";
import { EventWriter } from "../../../src/runtime/session/event-writer.ts";
import { JsonlV3EventStore } from "../../../src/runtime/session/jsonl-v3-store.ts";
import type { WriterFence } from "../../../src/runtime/session/types.ts";
import type { TurnStartCommand } from "../../../src/runtime/control-plane/types.ts";
import type { UserAgentMessage } from "../../../src/runtime/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("durable interactive mutation uncertainty", () => {
	it("reports effect:uncertain when a JSONL queue event is written but its sync is not confirmed", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-uncertain-"));
		temporaryDirectories.push(root);
		const identity = createLocalIdentityContext(new Date("2026-07-22T00:00:00.000Z"));
		const sessionId = createRuntimeId("session", "jsonl-before-sync");
		const runtimeId = createRuntimeId("runtime", "jsonl-before-sync");
		const stream = createSessionEventStreamRef(identity, sessionId);
		const fence: WriterFence = {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			stream,
			leaseId: createRuntimeId("lease", "jsonl-before-sync"),
			ownerRuntimeId: runtimeId,
			writerEpoch: 1,
			fencingToken: "jsonl-before-sync",
		};
		let failBeforeEventSync = false;
		const opened = await JsonlV3EventStore.create({
			filePath: join(root, "events.jsonl"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			stream,
			validateFence: (candidate) => candidate.fencingToken === fence.fencingToken,
			onWritePhase: (phase) => {
				if (failBeforeEventSync && phase === "before_event_sync") {
					throw new Error("injected failure after write before sync");
				}
			},
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error(opened.error.message);
		const store = opened.value;
		const writer = new EventWriter({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			stream,
			store,
			fence,
		});
		const sessionEvents = new AgentLoopSessionEvents({
			writer,
			principalId: identity.principalId,
			runtimeId,
			featureDigest: "a".repeat(64),
		});
		await sessionEvents.ensureInitialized("test");
		const enqueueHead = writer.currentHead();
		if (!enqueueHead) throw new Error("missing initialized writer head");
		failBeforeEventSync = true;

		const queue = new V3InteractiveDurableQueue({ sessionEvents: () => sessionEvents });
		const text = "write once despite an unknown fsync outcome";
		const prompt = {
			storage: "bounded_text" as const,
			text,
			contentDigest: canonicalDigest({ storage: "bounded_text", text }),
		};
		const command: TurnStartCommand = {
			kind: "command",
			type: "turn:start",
			commandId: createRuntimeId("command", "jsonl-before-sync"),
			idempotencyKey: createIdempotencyKey("jsonl-before-sync-key"),
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			principalId: identity.principalId,
			expectedSessionRevision: {
				stream: enqueueHead.stream,
				sequence: enqueueHead.sequence,
				eventHash: enqueueHead.eventHash,
			},
			expectedTurnId: null,
			sessionHandle: null,
			payload: { sessionId, prompt },
		};
		const message: UserAgentMessage = { role: "user", content: [{ type: "text", text }] };
		const result = await queue.enqueue(command, message);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "durable_enqueue_failed" },
			effect: "uncertain",
		});
		const lines = (await readFile(join(root, "events.jsonl"), "utf8")).trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1] ?? "null")).toMatchObject({
			type: "queue.enqueued",
			payload: { sourceCommandId: command.commandId },
		});
		await store.close();
	});
});
