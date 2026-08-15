import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId, type AgentId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { encodeAgentGraphEventPayload, type AgentGraphCommand } from "../../../src/runtime/agents/graph-events.ts";
import { AgentGraphStore } from "../../../src/runtime/agents/graph-store.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import type { AppendEventInput, SessionEventRecord } from "../../../src/storage/session-store/session-store.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

let directory: string;
let database: ReturnType<typeof openSessionDatabase>;
let sessionStore: SessionStore;
let sessionId: SessionId;
let fence: OwnerFence;
const rootAgentId = createRuntimeId("agent", "root-store");

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "runledger-agent-graph-store-"));
	database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	sessionStore = new SessionStore(database);
	sessionId = createRuntimeId("session", "graph-store");
	const runtimeId = createRuntimeId("runtime", "graph-store");
	sessionStore.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "graph"),
		repositoryId: createRuntimeId("repository", "graph"),
		settingsDigest: "d".repeat(64),
	});
	database.runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	fence = { sessionId, runtimeId, generation: 1 };
});

afterEach(() => {
	database.close();
	rmSync(directory, { recursive: true, force: true });
});

function digest(seed: string) {
	return runtimeDigest({ seed });
}

function rootCommand(): AgentGraphCommand {
	return {
		type: "agent.root_registered",
		commandId: createRuntimeId("command", "store-root"),
		requestDigest: digest("store-root"),
		expectedRevision: 0,
		rootAgentId,
		agentId: rootAgentId,
		policyReceiptDigest: digest("policy"),
	};
}

function spawnCommand(expectedRevision: number): AgentGraphCommand {
	return {
		type: "agent.spawn_requested",
		commandId: createRuntimeId("command", "store-spawn"),
		requestDigest: digest("store-spawn"),
		expectedRevision,
		rootAgentId,
		agentId: createRuntimeId("agent", "store-child"),
		parentAgentId: rootAgentId,
		role: "research",
		objective: "Inspect the repository.",
		requestedCapabilities: ["workspace.read"],
		budget: { maxModelTurns: 1, maxToolCalls: 1, maxActiveDurationMs: 1000 },
		maxReportBytes: 1024,
	};
}

function appendOtherEvent(seed: string): SessionEventRecord {
	const previous = sessionStore.replaySessionEvents(sessionId).at(-1)?.currentEventHash ?? null;
	return sessionStore.appendEvent(fence, {
		eventId: createRuntimeId("event", `other-${seed}`),
		ownerGeneration: fence.generation,
		eventType: "ledger.message",
		payloadJson: JSON.stringify({ seed }),
		createdAtMs: Date.now(),
		expectedPreviousEventHash: previous,
	});
}

function createGraphStore(
	appendEvent?: (input: AppendEventInput) => SessionEventRecord,
	options: { readonly maxRetries?: number } = {},
): AgentGraphStore {
	return new AgentGraphStore({
		store: sessionStore,
		fence,
		rootAgentId,
		appendEvent,
		maxRetries: options.maxRetries,
	});
}

describe("durable bounded agent graph store", () => {
	it("keeps graph revision independent from unrelated session events", async () => {
		const graph = createGraphStore();
		const root = await graph.commit(rootCommand());
		expect(root).toMatchObject({ ok: true, value: { status: "committed", head: { revision: 1 } } });
		appendOtherEvent("between-graph-events");

		const loaded = await graph.load();
		expect(loaded).toMatchObject({ ok: true, value: { revision: 1 } });
		const child = await graph.commit(spawnCommand(1));
		expect(child).toMatchObject({ ok: true, value: { status: "committed", head: { revision: 2 } } });
		const record = await graph.findByCommand(createRuntimeId("command", "store-spawn"));
		expect(record).toMatchObject({ ok: true, value: { graphRevision: 2, eventType: "agent.spawn_requested" } });
	});

	it("replays duplicate commands, rejects digest conflicts, and survives append acknowledgement loss", async () => {
		let loseAck = true;
		const graph = createGraphStore((input) => {
			const appended = sessionStore.appendEvent(fence, input);
			if (loseAck) {
				loseAck = false;
				throw new Error("append acknowledgement lost");
			}
			return appended;
		});
		const root = rootCommand();
		const first = await graph.commit(root);
		expect(first).toMatchObject({ ok: true });
		const duplicate = await graph.commit(root);
		expect(duplicate).toMatchObject({ ok: true, value: { status: "duplicate" } });
		const conflict = await graph.commit({ ...root, requestDigest: digest("different") });
		expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
		expect(sessionStore.replaySessionEvents(sessionId).filter((event) => event.eventType === "agent.root_registered")).toHaveLength(1);
	});

	it("replays an idempotent duplicate graph event without advancing graph revision", async () => {
		const graph = createGraphStore();
		const root = rootCommand();
		await graph.commit(root);
		const previous = sessionStore.replaySessionEvents(sessionId).at(-1)?.currentEventHash ?? null;
		sessionStore.appendEvent(fence, {
			eventId: createRuntimeId("event", "duplicate-root-event"),
			ownerGeneration: fence.generation,
			eventType: root.type,
			payloadJson: encodeAgentGraphEventPayload(root, 1),
			createdAtMs: Date.now(),
			expectedPreviousEventHash: previous,
		});
		const loaded = await graph.load();
		expect(loaded).toMatchObject({ ok: true, value: { revision: 1 } });
		expect(sessionStore.replaySessionEvents(sessionId).filter((event) => event.eventType === root.type)).toHaveLength(2);
	});

	it("retries a session head conflict and stops after the bounded retry limit", async () => {
		let injected = false;
		const retrying = createGraphStore((input) => {
			if (!injected) {
				injected = true;
				appendOtherEvent("head-race");
			}
			return sessionStore.appendEvent(fence, input);
		});
		expect(await retrying.commit(rootCommand())).toMatchObject({ ok: true, value: { head: { revision: 1 } } });
		expect(await retrying.commit(spawnCommand(1))).toMatchObject({ ok: true, value: { head: { revision: 2 } } });

		let conflicts = 0;
		const bounded = createGraphStore((input) => {
			conflicts += 1;
			appendOtherEvent(`always-race-${conflicts}`);
			return sessionStore.appendEvent(fence, input);
		}, { maxRetries: 3 });
		const result = await bounded.commit({
			...spawnCommand(2),
			commandId: createRuntimeId("command", "second-spawn"),
			agentId: createRuntimeId("agent", "second-child"),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "store_conflict" } });
		expect(conflicts).toBe(3);
	});
});
