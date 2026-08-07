/**
 * R5:checkpoint cache fixtures(06 §7.2)。
 *
 * 覆盖:六个 boundary、digest/序列校验、损坏/旧版 cache 自动回退 full replay、
 * 删除全部 checkpoint 后从 genesis 重建得到相同 projection、cache 不保存唯一事实。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { putSessionCheckpoint, restoreCheckpointReplay, validateCheckpointCache, SESSION_CHECKPOINT_CACHE_SCHEMA } from "../../../src/runtime/session-runtime/checkpoint.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import { SESSION_CHECKPOINT_BOUNDARIES } from "../../../src/runtime/session-owner/types.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { SessionRuntime, type SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { AgentEvent, AgentEventSink } from "../../../src/runtime/types.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-checkpoint-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

function openStore(): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
}

async function claimedHarness(seed = "ck"): Promise<{ store: SessionStore; sessionId: SessionId; fence: { sessionId: SessionId; runtimeId: string; generation: number } }> {
	const { store, ownerStore } = openStore();
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	const runtimeId = createRuntimeId("runtime", seed);
	store.database().runSync(
		`INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)`,
		[sessionId, runtimeId],
	);
	return { store, sessionId, fence: { sessionId, runtimeId, generation: 1 } };
}

describe("R5 checkpoint cache", () => {
	it("supports exactly the six frozen boundaries", () => {
		expect(SESSION_CHECKPOINT_BOUNDARIES).toEqual([
			"before_model",
			"after_model",
			"before_tool",
			"after_tool",
			"turn_completed",
			"paused",
		]);
	});

	it("persists a validated checkpoint with digest binding", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		// 先 append 一个 authority event(head=1)。
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "e1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ text: "hi" }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		const descriptor = putSessionCheckpoint(store, fence, "turn_completed", 1, { turns: 2 });
		expect(descriptor).toMatchObject({ sessionId, ownerGeneration: 1, boundary: "turn_completed", sourceSequence: 1 });
		const entry = store.getCheckpoint(descriptor.checkpointId)!;
		expect(entry.snapshotDigest.digest).toBe(descriptor.snapshotDigest.digest);
		const validation = validateCheckpointCache(entry, "turn_completed");
		expect(validation.ok).toBe(true);
		if (!validation.ok) throw new Error("expected valid");
		expect(validation.snapshot.state).toEqual({ turns: 2 });
		expect(validation.snapshot.cacheSchema).toBe(SESSION_CHECKPOINT_CACHE_SCHEMA);
		store.database().close();
	});

	it("restores from a valid checkpoint and replays the tail after it", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "e1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ n: 1 }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		const descriptor = putSessionCheckpoint(store, fence, "turn_completed", 1, { turns: 2 });
		const tail = store.replaySessionEvents(sessionId).at(-1)!;
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "e2"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ n: 2 }),
			createdAtMs: 2,
			expectedPreviousEventHash: tail.currentEventHash,
		});
		const restored = restoreSession(store, sessionId);
		expect(restored.ok).toBe(true);
		if (!restored.ok) throw new Error("expected restore");
		expect(restored.usedCheckpoint).toBe(true);
		expect(restored.checkpoint?.descriptor.checkpointId).toBe(descriptor.checkpointId);
		expect(restored.checkpoint?.snapshot.state).toEqual({ turns: 2 });
		expect(restored.headSequence).toBe(2);
		expect(restored.replayEvents.map((event) => event.sequence)).toEqual([2]);
		store.database().close();
	});

	it("applies a replay-ready paused checkpoint and its durable ledger tail", () => {
		const checkpoint = {
			cacheSchema: SESSION_CHECKPOINT_CACHE_SCHEMA,
			boundary: "paused" as const,
			sourceSequence: 4,
			state: {
				replayReady: true,
				messages: [{ role: "user", content: [{ type: "text", text: "base" }] }],
				warnings: [],
				auditEntries: [],
				selection: { provider: "fixture", thinkingLevel: "low" },
			},
		};
		const tail = [{
			id: "tail",
			sessionId: "session_tail",
			parentId: "base",
			timestamp: 5,
			type: "message" as const,
			payload: { role: "user", message: { role: "user", content: [{ type: "text", text: "tail" }] } },
		}];
		const replay = restoreCheckpointReplay(checkpoint, tail);
		expect(replay?.messages).toHaveLength(2);
		expect(replay?.config).toEqual({ provider: "fixture", thinkingLevel: "low" });
	});

	it("falls back to full replay when the checkpoint digest is tampered", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		store.appendEvent(fence, {
			eventId: createRuntimeId("event", "e1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ n: 1 }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		const descriptor = putSessionCheckpoint(store, fence, "turn_completed", 1, { turns: 2 });
		// 篡改 cache 内容:digest 不再匹配。
		store.database().runSync("UPDATE session_checkpoints SET snapshot_json = ? WHERE checkpoint_id = ?", [
			JSON.stringify({ cacheSchema: 1, boundary: "turn_completed", sourceSequence: 1, state: { tampered: true } }),
			descriptor.checkpointId,
		]);
		const validation = validateCheckpointCache(store.getCheckpoint(descriptor.checkpointId)!);
		expect(validation.ok).toBe(false);
		if (validation.ok) throw new Error("expected invalid");
		expect(validation.code).toBe("digest_mismatch");
		const restored = restoreSession(store, sessionId);
		expect(restored.ok && restored.usedCheckpoint).toBe(false);
		if (!restored.ok || restored.usedCheckpoint) throw new Error("expected full replay");
		expect(restored.headSequence).toBe(1);
		store.database().close();
	});

	it("falls back to full replay when the cache schema is newer than the binary", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		const descriptor = putSessionCheckpoint(store, fence, "turn_completed", 0, { turns: 1 });
		store.database().runSync("UPDATE session_checkpoints SET snapshot_json = ? WHERE checkpoint_id = ?", [
			JSON.stringify({ cacheSchema: 99, boundary: "turn_completed", sourceSequence: 0, state: { future: true } }),
			descriptor.checkpointId,
		]);
		const restored = restoreSession(store, sessionId);
		expect(restored.ok && restored.usedCheckpoint).toBe(false);
		if (!restored.ok || restored.usedCheckpoint) throw new Error("expected full replay");
		store.database().close();
	});

	it("rebuilds the identical projection from genesis after all checkpoints are deleted", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		let previous: string | null = null;
		for (let index = 0; index < 5; index += 1) {
			const event = store.appendEvent(fence, {
				eventId: createRuntimeId("event", `e${index}`),
				ownerGeneration: 1,
				eventType: "message",
				payloadJson: JSON.stringify({ n: index }),
				createdAtMs: index,
				expectedPreviousEventHash: previous,
			});
			previous = event.currentEventHash;
		}
		putSessionCheckpoint(store, fence, "turn_completed", 5, { turns: 5 });
		const before = store.projectSession(sessionId);
		expect(before.headSequence).toBe(5);
		store.clearCheckpoints(sessionId);
		store.database().runSync("UPDATE sessions SET head_sequence = 0, current_checkpoint_id = NULL WHERE session_id = ?", [sessionId]);
		const rebuilt = store.rebuildFromEvents(sessionId);
		expect(rebuilt).toMatchObject({ sessionId, headSequence: 5, status: "active", driverRevision: 0 });
		store.database().close();
	});

	it("returns typed corruption on authority hash tamper (never silently recovers)", async () => {
		const { store, sessionId, fence } = await claimedHarness();
		const event = store.appendEvent(fence, {
			eventId: createRuntimeId("event", "e1"),
			ownerGeneration: 1,
			eventType: "message",
			payloadJson: JSON.stringify({ n: 1 }),
			createdAtMs: 1,
			expectedPreviousEventHash: null,
		});
		expect(event.sequence).toBe(1);
		// 篡改 durable event 的 payload(不重算 hash)→ replay fail closed。
		store.database().runSync("UPDATE session_events SET payload_json = ? WHERE session_id = ? AND sequence = 1", [
			JSON.stringify({ n: 999 }),
			sessionId,
		]);
		const restored = restoreSession(store, sessionId);
		expect(restored.ok).toBe(false);
		if (restored.ok) throw new Error("expected corruption");
		expect(restored.code).toBe("corruption");
		store.database().close();
	});

	it("writes all five live agent checkpoint boundaries before the final paused boundary", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createRuntimeId("session", "live-boundaries");
		const runtimeId = createRuntimeId("runtime", "live-boundaries");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		store.database().runSync(
			"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
			[sessionId, runtimeId],
		);
		let listener: AgentEventSink | undefined;
		const domain: SessionDomainPort = {
			controller: {
				subscribe: (sink: AgentEventSink) => {
					listener = sink;
					return () => undefined;
				},
			} as unknown as SessionDomainPort["controller"],
			snapshot: () => ({ messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, inFlight: true, providerStatuses: [] }),
		};
		const restored = restoreSession(store, sessionId);
		if (!restored.ok) throw new Error("restore failed");
		new SessionRuntime({
			sessionId,
			store,
			ownerStore,
			owner: {} as never,
			server: {} as never,
			fence: { sessionId, runtimeId, generation: 1 },
			crashTakeover: false,
			restored,
			domain,
		});
		if (listener === undefined) throw new Error("domain listener missing");
		const events: AgentEvent[] = [
			{ type: "turn_start", timestamp: 1, turn: 1 },
			{ type: "message_end", timestamp: 2, role: "assistant", stopReason: "toolUse" },
			{ type: "tool_execution_start", timestamp: 3, toolCallId: "tc", toolName: "read", args: {} },
			{ type: "tool_execution_end", timestamp: 4, toolCallId: "tc", toolName: "read", isError: false, result: { type: "toolResult", toolCallId: "tc", toolName: "read", content: [], isError: false } },
			{ type: "turn_end", timestamp: 5, turn: 1, stopReason: "stop" },
		];
		for (const event of events) await listener(event);
		const rows = store.database().queryAll("SELECT boundary FROM session_checkpoints WHERE session_id = ? ORDER BY created_at_ms, boundary", [sessionId]);
		expect(new Set(rows.map((row) => row.boundary))).toEqual(new Set([
			"before_model",
			"after_model",
			"before_tool",
			"after_tool",
			"turn_completed",
		]));
		store.database().close();
	});
});
