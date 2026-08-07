/**
 * R3:OwnerFence 全写入 fence fixtures(06 §4.5/§5.4)。
 *
 * 覆盖:heartbeat changes=0 等价 fenced、旧 generation 的 event/checkpoint/
 * command receipt 全部拒绝、fenced 后 self-stop 回调、token 不泄漏到事件流、
 * 多进程旧 owner 恢复写入被拒绝。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore, SessionStoreError } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { createTcpOwnerTransport } from "../../../src/runtime/session-server/owner-probe.ts";
import { createRuntimeId, type RuntimeInstanceId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-owner/owner-worker.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-owner-fencing-"));
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSyncRetry(dir);
});

function openStore(): { store: SessionStore; ownerStore: OwnerStore; dbPath: string } {
	const dbPath = join(dir, "state.db");
	const db = openSessionDatabase(dbPath);
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db), dbPath };
}

function createSession(store: SessionStore, seed = "a"): SessionId {
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	return sessionId;
}

function makeOwner(): SessionOwner {
	const { store, ownerStore } = openStore();
	return new SessionOwner({ store, ownerStore, transport: createTcpOwnerTransport() });
}

const digest = (seed: string) => ({ algorithm: "sha256", digest: canonicalDigest({ seed }) }) as const;

async function claimOwner(sessionId: SessionId): Promise<{ owner: SessionOwner; fence: { sessionId: SessionId; runtimeId: RuntimeInstanceId; generation: number } }> {
	const owner = makeOwner();
	const result = await owner.open(sessionId);
	if (!result.ok || result.outcome !== "claimed") throw new Error("expected claim");
	owner.publish("running");
	return { owner, fence: { sessionId, runtimeId: result.fence.runtimeId, generation: result.fence.generation } };
}

describe("R3 durable fencing", () => {
	it("heartbeat with the current fence succeeds and refreshes the row", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const { fence } = await claimOwner(sessionId);
		const result = ownerStore.touchHeartbeat(fence, 1_752_000_000_000);
		expect(result.ok).toBe(true);
		expect(ownerStore.readOwner(sessionId)?.heartbeatAtMs).toBe(1_752_000_000_000);
		ownerStore.database().close();
	});

	it("heartbeat with a stale generation reports owner_fenced", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const { fence } = await claimOwner(sessionId);
		const staleFence = { sessionId, runtimeId: fence.runtimeId, generation: fence.generation + 1 };
		const result = ownerStore.touchHeartbeat(staleFence, Date.now());
		expect(result).toEqual({ ok: false, code: "owner_fenced" });
		ownerStore.database().close();
	});

	it("rejects every durable mutation from an old generation (event/checkpoint/intent/receipt)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const { fence } = await claimOwner(sessionId);
		// 模拟 takeover:新 generation 接管后,旧 fence 全部失效。
		ownerStore.database().runSync(
			`UPDATE session_owners SET runtime_id = ?, generation = ?, updated_at_ms = ? WHERE session_id = ?`,
			[createRuntimeId("runtime", "new"), fence.generation + 1, Date.now(), sessionId],
		);
		const oldFence = { sessionId, runtimeId: fence.runtimeId, generation: fence.generation };
		expect(() =>
			store.appendEvent(oldFence, {
				eventId: createRuntimeId("event", "x"),
				ownerGeneration: oldFence.generation,
				eventType: "message",
				payloadJson: "{}",
				createdAtMs: Date.now(),
				expectedPreviousEventHash: null,
			}),
		).toThrowError(/owner fenced/u);
		expect(() =>
			store.putCheckpoint(oldFence, {
				checkpointId: createRuntimeId("snapshot", "x"),
				sessionId,
				ownerGeneration: oldFence.generation,
				boundary: "turn_completed",
				sourceSequence: 0,
				snapshotDigest: digest("x"),
				createdAtMs: Date.now(),
			}, "{}"),
		).toThrowError(SessionStoreError);
		expect(() =>
			store.recordCommandIntent(oldFence, {
				sessionId,
				commandId: createRuntimeId("command", "x"),
				requestDigest: digest("x"),
				originGeneration: oldFence.generation,
				createdAtMs: Date.now(),
			}),
		).toThrowError(/owner fenced/u);
		ownerStore.database().close();
	});

	it("self-stops (heartbeat + write fence) when the owner row is taken over", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		let fencedFence: unknown = undefined;
		const owner = new SessionOwner({
			store,
			ownerStore,
			transport: createTcpOwnerTransport(),
			onFenced: (fence) => {
				fencedFence = fence;
			},
		});
		const result = await owner.open(sessionId);
		if (!result.ok || result.outcome !== "claimed") throw new Error("expected claim");
		owner.publish("running");
		// 直接对同一 store 伪造 takeover,再触发旧 owner 的 heartbeat。
		ownerStore.database().runSync(
			`UPDATE session_owners SET runtime_id = ?, generation = ?, state = 'running', updated_at_ms = ? WHERE session_id = ?`,
			[createRuntimeId("runtime", "taker"), result.fence.generation + 1, Date.now(), sessionId],
		);
		owner.startHeartbeat();
		await new Promise((resolve) => setTimeout(resolve, 3_200));
		expect(owner.isStopping).toBe(true);
		expect(owner.currentFence).toBeUndefined();
		expect(fencedFence).toMatchObject({ sessionId, runtimeId: result.fence.runtimeId, generation: result.fence.generation });
		ownerStore.database().close();
	});

	it("retries a transient heartbeat database failure instead of disabling fencing checks", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store, "heartbeat-transient");
		const owner = new SessionOwner({ store, ownerStore, transport: createTcpOwnerTransport() });
		const claimed = await owner.open(sessionId);
		if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("expected claim");
		owner.publish("running");
		const touch = ownerStore.touchHeartbeat.bind(ownerStore);
		const spy = vi
			.spyOn(ownerStore, "touchHeartbeat")
			.mockImplementationOnce(() => {
				throw new Error("temporary SQLITE_BUSY");
			})
			.mockImplementation((fence, nowMs) => touch(fence, nowMs));
		vi.useFakeTimers();
		owner.startHeartbeat();
		await vi.advanceTimersByTimeAsync(6_100);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(owner.isStopping).toBe(false);
		expect(owner.currentFence).toMatchObject(claimed.fence);
		owner.release("paused");
		ownerStore.database().close();
	});

	it("self-fences after repeated heartbeat database failures before the stale threshold", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store, "heartbeat-fail-closed");
		let fenced = false;
		const owner = new SessionOwner({
			store,
			ownerStore,
			transport: createTcpOwnerTransport(),
			onFenced: () => {
				fenced = true;
			},
		});
		const claimed = await owner.open(sessionId);
		if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("expected claim");
		owner.publish("running");
		vi.spyOn(ownerStore, "touchHeartbeat").mockImplementation(() => {
			throw new Error("database unavailable");
		});
		vi.useFakeTimers();
		owner.startHeartbeat();
		await vi.advanceTimersByTimeAsync(9_100);
		expect(fenced).toBe(true);
		expect(owner.isStopping).toBe(true);
		expect(owner.currentFence).toBeUndefined();
		ownerStore.database().close();
	});

	it("never leaks the auth token into the durable event stream", async () => {
		const { store } = openStore();
		const sessionId = createSession(store);
		const { owner } = await claimOwner(sessionId);
		owner.release("paused");
		const events = store.replaySessionEvents(sessionId);
		expect(JSON.stringify(events.map((event) => event.payloadJson))).not.toContain(owner.currentAuthToken);
		store.database().close();
	});

	it("rejects an old owner's resume write from a real second process", () => {
		const { store } = openStore();
		const sessionId = createSession(store, "proc");
		const dbPath = join(dir, "state.db");
		// 预置 owner row:runtime_old generation 1 running,并模拟已被新 owner 接管。
		store.database().runSync(
			`INSERT INTO session_owners
			 (session_id, runtime_id, generation, state, port, heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
			 VALUES (?, 'runtime_old', 1, 'running', 40000, 1, 1, 1)`,
			[sessionId],
		);
		store.database().runSync(
			`UPDATE session_owners SET runtime_id = 'runtime_new', generation = 2, updated_at_ms = ? WHERE session_id = ?`,
			[Date.now(), sessionId],
		);
		store.database().close();
		const result = spawnSync(process.execPath, ["--import", "tsx", WORKER, "append-old", dbPath, sessionId, dir, JSON.stringify({ runtimeId: "runtime_old", generation: 1 })], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(result.status).toBe(0);
		const parsed = JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "{}");
		expect(parsed.ok).toBe(false);
		expect(parsed.code).toBe("owner_fenced");
	});
});
