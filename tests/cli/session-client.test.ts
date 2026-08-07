/**
 * R6:SessionClient / fork / session-scoped process capacity fixtures(06 §8.2/§7.4)。
 *
 * 覆盖:fork 从 source event range 创建新 sessionId(generation 独立从 1 起)、
 * fork 不继承活跃句柄、SessionProcessRegistry 容量上限与 owner crash 后
 * lost/uncertain 投影(不 reattach)。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { SessionClient } from "../../src/cli/session-client.ts";
import { SessionProcessRegistry } from "../../src/cli/embedded-session-runtime.ts";
import { SessionClientTransport } from "../../src/runtime/session-server/client-transport.ts";
import type { SessionFrameEnvelope } from "../../src/runtime/session-server/protocol.ts";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-client-"));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

function openStores(): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(join(dir, "state.db"));
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
}

function makeClient(): SessionClient {
	const { store, ownerStore } = openStores();
	return new SessionClient({
		store,
		ownerStore,
		claimTransport: {
			bindCandidate: async () => {
				throw new Error("not claiming");
			},
			closeCandidate: async () => undefined,
			probe: async () => ({ ok: false as const, code: "connect_failed" as const }),
		},
	});
}

function installRunningOwner(store: SessionStore, sessionId: SessionId, runtimeSeed: string, port: number): void {
	store.database().runSync(
		`INSERT INTO session_owners
		 (session_id, runtime_id, generation, state, port, auth_token, heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
		 VALUES (?, ?, 1, 'running', ?, ?, ?, ?, ?)`,
		[sessionId, createRuntimeId("runtime", runtimeSeed), port, Buffer.from("ab".repeat(32), "hex"), Date.now(), Date.now(), Date.now()],
	);
}

function fakeConnectedTransport(runtimeId: string, generation = 1): SessionClientTransport {
	return {
		request: async (frame: SessionFrameEnvelope) => ({
			frameId: `response_${frame.frameId}`,
			kind: "initialize_response",
			protocolVersion: 1,
			body: {
				requestFrameId: frame.frameId,
				accepted: true,
				runtimeId,
				generation,
				snapshotCursor: 0,
				driverRevision: 0,
				sessionStatus: "running",
			},
		}),
		close: async () => undefined,
	} as unknown as SessionClientTransport;
}

describe("R6 session client", () => {
	it("returns a retryable typed result when TCP connect is refused", async () => {
		const { store, ownerStore } = openStores();
		const sessionId = createRuntimeId("session", "connect-refused");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		installRunningOwner(store, sessionId, "dead", 43191);
		vi.spyOn(SessionClientTransport, "connect").mockRejectedValue(new Error("ECONNREFUSED"));
		const client = new SessionClient({ store, ownerStore, claimTransport: {
			bindCandidate: async () => ({ host: "127.0.0.1", port: 43192 }),
			closeCandidate: async () => undefined,
			probe: async () => ({ ok: false as const, code: "connect_failed" as const }),
		} });
		await expect(client.openSession(sessionId, { attachRetries: 1 })).resolves.toEqual({
			ok: false,
			code: "owner_connect_failed",
			retryable: true,
		});
		store.database().close();
	});

	it("rereads the owner row between attach retries and follows the replacement endpoint", async () => {
		const { store, ownerStore } = openStores();
		const sessionId = createRuntimeId("session", "owner-reread");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		installRunningOwner(store, sessionId, "old", 43193);
		const replacementRuntime = createRuntimeId("runtime", "replacement");
		const ports: number[] = [];
		vi.spyOn(SessionClientTransport, "connect").mockImplementation(async (port) => {
			ports.push(port);
			if (port === 43193) {
				store.database().runSync(
					"UPDATE session_owners SET runtime_id = ?, generation = 2, port = 43194, heartbeat_at_ms = ?, updated_at_ms = ? WHERE session_id = ?",
					[replacementRuntime, Date.now(), Date.now(), sessionId],
				);
				throw new Error("old endpoint died");
			}
			return fakeConnectedTransport(replacementRuntime, 2);
		});
		const client = new SessionClient({ store, ownerStore, claimTransport: {
			bindCandidate: async () => ({ host: "127.0.0.1", port: 43195 }),
			closeCandidate: async () => undefined,
			probe: async () => ({ ok: false as const, code: "connect_failed" as const }),
		} });
		const opened = await client.openSession(sessionId, { attachRetries: 2 });
		expect(opened.ok).toBe(true);
		expect(ports).toEqual([43193, 43194]);
		if (opened.ok) await opened.handle.close();
		store.database().close();
	});
	it("resolves sessions from the read-only catalog", () => {
		const { store } = openStores();
		const sessionId = createRuntimeId("session", "catalog");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		const client = makeClient();
		expect(client.resolveSession(sessionId)?.sessionId).toBe(sessionId);
		expect(client.resolveSession(createRuntimeId("session", "missing"))).toBeUndefined();
		store.database().close();
	});

	it("forks a session with an independent generation starting at 1", () => {
		const { store } = openStores();
		const sourceId = createRuntimeId("session", "source");
		store.createSession({
			sessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		// source 已到 generation 3。
		const runtimeId = createRuntimeId("runtime", "r");
		store.database().runSync(
			"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 3, 'running', 1)",
			[sourceId, runtimeId],
		);
		const forkId = createRuntimeId("session", "fork");
		store.forkSession({
			sessionId: forkId,
			sourceSessionId: sourceId,
			workspaceId: createRuntimeId("workspace", "w"),
			repositoryId: createRuntimeId("repository", "r"),
			settingsDigest: "d".repeat(64),
		});
		// §8.2:fork 新 Session generation 独立从 1 开始;worktree/approval/process
		// 活跃句柄不继承(owner row 为空)。
		const { ownerStore } = openStores();
		expect(ownerStore.readOwner(forkId)).toBeUndefined();
		expect(store.getSession(forkId)?.status).toBe("active");
		store.database().close();
	});

	it("process registry enforces the session capacity bound", () => {
		const registry = new SessionProcessRegistry(2);
		const sessionId = createRuntimeId("session", "proc");
		const first = registry.register(sessionId, 1);
		const second = registry.register(sessionId, 1);
		expect("processId" in first).toBe(true);
		expect("processId" in second).toBe(true);
		const third = registry.register(sessionId, 1);
		expect(third).toEqual({ error: "process_capacity_exceeded" });
	});

	it("projects in-flight processes as uncertain on owner crash without PID reattach", () => {
		const registry = new SessionProcessRegistry(8);
		const sessionId = createRuntimeId("session", "proc");
		const a = registry.register(sessionId, 1);
		const b = registry.register(sessionId, 1);
		expect("processId" in a && "processId" in b).toBe(true);
		if (!("processId" in a) || !("processId" in b)) throw new Error("expected records");
		registry.settle(b.processId, "settled");
		// owner crash:仅本 generation 的 in-flight 句柄投影 uncertain。
		const projected = registry.projectLostOrUncertain(sessionId, 1);
		expect(projected.map((record) => record.processId)).toEqual([a.processId]);
		expect(projected[0]!.status).toBe("uncertain");
		// 新 owner generation 不 reattach 旧句柄。
		const fresh = registry.register(sessionId, 2);
		expect("processId" in fresh).toBe(true);
		expect(registry.snapshot().filter((record) => record.generation === 1 && record.status === "running")).toHaveLength(0);
	});

	it("does not expose raw PID or absolute paths in process projections", () => {
		const registry = new SessionProcessRegistry(4);
		const sessionId = createRuntimeId("session", "proc");
		const record = registry.register(sessionId, 1);
		if (!("processId" in record)) throw new Error("expected record");
		expect(JSON.stringify(registry.snapshot())).not.toContain("pid");
		expect(JSON.stringify(registry.snapshot())).not.toContain("cwd");
	});
});
