/**
 * R3:crash takeover fixtures(06 §5.3/§5.4)。
 *
 * 覆盖:stale + 连续 3 次 authenticated probe 失败 → takeover CAS(generation+1,
 * owner.fenced + owner.taken_over 同事务);heartbeat fresh 不 takeover(sleep/wake);
 * stale 但 endpoint healthy → attach 不抢占;token 错误 → probe 失败计数;
 * 无 port row → 直接 takeover。
 */

import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { bindCandidateListener, probeOwner } from "../../../src/runtime/session-server/owner-probe.ts";
import { generateOwnerAuthToken, ownerTokenConstantTimeEqual } from "../../../src/runtime/session-owner/fence.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-owner-takeover-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

function openStore(): { store: SessionStore; ownerStore: OwnerStore } {
	const dbPath = join(dir, "state.db");
	const db = openSessionDatabase(dbPath);
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
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
	return new SessionOwner({ store, ownerStore, transport: realTransport() });
}

/** 生产 transport:bind 真实 127.0.0.1:0 listener + TCP probe。 */
function realTransport() {
	return {
		async bindCandidate() {
			const bound = await bindCandidateListener("127.0.0.1");
			return bound.endpoint;
		},
		async closeCandidate() {
			return undefined;
		},
		async probe(endpoint: { host: "127.0.0.1"; port: number }, input: { sessionId: string; expectedRuntimeId: string; expectedGeneration: number; authToken: string }, timeoutMs: number) {
			return probeOwner(endpoint, input, timeoutMs);
		},
	};
}

/** 可控 transport:记录绑定的 listener,允许测试模拟 owner crash(关闭 listener)。 */
function controllableTransport(): { transport: ReturnType<typeof realTransport>; closeListener: () => Promise<void> } {
	let bound: { close(): Promise<void> } | undefined;
	return {
		transport: {
			async bindCandidate() {
				const listener = await bindCandidateListener("127.0.0.1");
				bound = listener;
				return listener.endpoint;
			},
			async closeCandidate() {
				return undefined;
			},
			async probe(endpoint: { host: "127.0.0.1"; port: number }, input: { sessionId: string; expectedRuntimeId: string; expectedGeneration: number; authToken: string }, timeoutMs: number) {
				return probeOwner(endpoint, input, timeoutMs);
			},
		},
		closeListener: async () => {
			await bound?.close();
		},
	};
}

function backdateHeartbeat(ownerStore: OwnerStore, sessionId: string, ageMs = 60_000): void {
	ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - ageMs, sessionId]);
}

/** 认证 probe 用的最小 handshake fixture server(测试专用,不是生产 server)。 */
function startHandshakeFixture(verifyToken: (token: string) => boolean): Promise<{ endpoint: { host: "127.0.0.1"; port: number }; close: () => Promise<void>; probeCount: () => number }> {
	let count = 0;
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				let frame: Record<string, unknown>;
				try {
					frame = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
				} catch {
					socket.destroy();
					return;
				}
				if (frame.kind !== "initialize_request") {
					socket.destroy();
					return;
				}
				count += 1;
				const body = (frame.body ?? {}) as Record<string, unknown>;
				const accepted = typeof body.authToken === "string" && verifyToken(body.authToken);
				socket.end(
					`${JSON.stringify({
						frameId: `resp_${String(frame.frameId)}`,
						kind: "initialize_response",
						protocolVersion: 1,
						body: {
							accepted,
							runtimeId: body.expectedRuntimeId,
							generation: body.expectedGeneration,
							protocolCapabilities: [],
							snapshotCursor: 0,
							driverRevision: 0,
							sessionStatus: "active",
						},
					})}\n`,
				);
			});
			socket.on("error", () => undefined);
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("no tcp address"));
				return;
			}
			resolve({
				endpoint: { host: "127.0.0.1", port: address.port },
				close: () => new Promise<void>((done) => server.close(() => done())),
				probeCount: () => count,
			});
		});
	});
}

const timeout = (ms: number): Promise<{ ok: false; code: "test_timeout"; retryable: true }> =>
	new Promise((resolve) => setTimeout(() => resolve({ ok: false, code: "test_timeout", retryable: true }), ms));

describe("R3 crash takeover", () => {
	it("takes over a stale owner after 3 consecutive probe failures (real listener closed)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const controlled = controllableTransport();
		const ownerA = new SessionOwner({ store, ownerStore, transport: controlled.transport });
		const claimedA = await ownerA.open(sessionId);
		if (!claimedA.ok || claimedA.outcome !== "claimed") throw new Error("expected claim");
		ownerA.publish("running");
		// 模拟 crash:listener 关闭 + heartbeat 过期 + 不 release。
		await controlled.closeListener();
		backdateHeartbeat(ownerStore, sessionId);
		const ownerB = makeOwner();
		const result = await ownerB.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		if (!result.ok || result.outcome !== "claimed") throw new Error("expected takeover");
		expect(result.fence.generation).toBe(claimedA.fence.generation + 1);
		// owner.fenced + owner.taken_over 与 row CAS 同事务落库。
		const events = store.replaySessionEvents(sessionId);
		const fenced = events.filter((event) => event.eventType === "owner.fenced");
		const takenOver = events.filter((event) => event.eventType === "owner.taken_over");
		expect(fenced).toHaveLength(1);
		expect(takenOver).toHaveLength(1);
		const takenPayload = JSON.parse(takenOver[0]!.payloadJson) as Record<string, unknown>;
		expect(takenPayload.priorGeneration).toBe(claimedA.fence.generation);
		expect(takenPayload.generation).toBe(result.fence.generation);
		const fencedPayload = JSON.parse(fenced[0]!.payloadJson) as Record<string, unknown>;
		expect(fencedPayload.runtimeId).toBe(claimedA.fence.runtimeId);
		expect(fencedPayload.generation).toBe(claimedA.fence.generation);
		expect(store.getSession(sessionId)?.status).toBe("recovery_required");
		expect(store.rebuildFromEvents(sessionId).status).toBe("recovery_required");
		ownerStore.database().close();
	});

	it("does NOT take over while heartbeat is fresh even if the endpoint is dead (sleep/wake)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const controlled = controllableTransport();
		const ownerA = new SessionOwner({ store, ownerStore, transport: controlled.transport });
		const claimedA = await ownerA.open(sessionId);
		if (!claimedA.ok || claimedA.outcome !== "claimed") throw new Error("expected claim");
		ownerA.publish("running");
		await controlled.closeListener(); // endpoint dead,但 heartbeat fresh。
		const ownerB = makeOwner();
		// P0-1:heartbeat fresh 时统一 open 直接返回 attach(不做 probe、绝不 takeover)。
		const result = await ownerB.open(sessionId);
		expect(result.ok && result.outcome === "attached").toBe(true);
		expect(ownerStore.readOwner(sessionId)?.generation).toBe(claimedA.fence.generation);
		// heartbeat 过期后,新的 open 才允许完成 takeover。
		backdateHeartbeat(ownerStore, sessionId);
		const ownerC = makeOwner();
		const takeoverResult = await ownerC.open(sessionId);
		expect(takeoverResult.ok && takeoverResult.outcome === "claimed").toBe(true);
		if (!takeoverResult.ok || takeoverResult.outcome !== "claimed") throw new Error("expected takeover after staleness");
		expect(takeoverResult.fence.generation).toBe(claimedA.fence.generation + 1);
		ownerStore.database().close();
	});

	it("attaches instead of taking over when the endpoint authenticates (stale but healthy)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const ownerA = makeOwner();
		const claimedA = await ownerA.open(sessionId);
		if (!claimedA.ok || claimedA.outcome !== "claimed") throw new Error("expected claim");
		const token = ownerStore.readProbeSecret(sessionId)?.authTokenHex ?? "";
		const fixture = await startHandshakeFixture((candidate) => ownerTokenConstantTimeEqual(candidate, token));
		// 把 row 的 endpoint 指向仍健康的 fixture(模拟 owner 进程活着)。
		ownerStore.database().runSync("UPDATE session_owners SET port = ? WHERE session_id = ?", [fixture.endpoint.port, sessionId]);
		backdateHeartbeat(ownerStore, sessionId);
		const ownerB = makeOwner();
		const result = await ownerB.open(sessionId);
		expect(result.ok && result.outcome === "attached").toBe(true);
		// 任一次 authenticated probe 成功都不继续抢占。
		expect(fixture.probeCount()).toBe(1);
		expect(ownerStore.readOwner(sessionId)?.generation).toBe(claimedA.fence.generation);
		await fixture.close();
		ownerStore.database().close();
	});

	it("counts a rejected (wrong-token) authenticated probe as a failure and takes over", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const ownerA = makeOwner();
		const claimedA = await ownerA.open(sessionId);
		if (!claimedA.ok || claimedA.outcome !== "claimed") throw new Error("expected claim");
		// fixture 只接受与 row 不同的 token → 每次 probe 都 rejected。
		const fixture = await startHandshakeFixture(() => false);
		ownerStore.database().runSync("UPDATE session_owners SET port = ? WHERE session_id = ?", [fixture.endpoint.port, sessionId]);
		backdateHeartbeat(ownerStore, sessionId);
		const ownerB = makeOwner();
		const result = await ownerB.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		expect(fixture.probeCount()).toBe(3);
		await fixture.close();
		ownerStore.database().close();
	});

	it("takes over immediately when the stale row has no endpoint port", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		// 直接构造 crash 于 claim 后、publish 前的 row:无 port、无 heartbeat。
		ownerStore.database().runSync(
			`INSERT INTO session_owners
			 (session_id, runtime_id, generation, state, port, heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
			 VALUES (?, 'runtime_stuck', 1, 'starting', NULL, NULL, 1, 1)`,
			[sessionId],
		);
		const ownerB = makeOwner();
		const result = await ownerB.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		if (!result.ok || result.outcome !== "claimed") throw new Error("expected takeover");
		expect(result.fence.generation).toBe(2);
		const events = store.replaySessionEvents(sessionId);
		expect(events.some((event) => event.eventType === "owner.taken_over")).toBe(true);
		ownerStore.database().close();
	});

	it("never takes over a healthy owner even when probes see a dead port (stale + 1 failure insufficient)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const ownerA = makeOwner();
		const claimedA = await ownerA.open(sessionId);
		if (!claimedA.ok || claimedA.outcome !== "claimed") throw new Error("expected claim");
		// 只模拟“单次 connect failure”:heartbeat 过期但很快恢复(直接改回 fresh)。
		backdateHeartbeat(ownerStore, sessionId);
		const ownerB = makeOwner();
		const probeAttempt = ownerB.open(sessionId);
		const raced = await Promise.race([probeAttempt, timeout(300)]);
		// 恢复 heartbeat 后,ownerB 重读应回到 retry,而不是继续 probe。
		ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now(), sessionId]);
		const raced2 = await Promise.race([raced, timeout(1_200)]);
		expect(raced2).toMatchObject({ ok: false, code: "test_timeout" });
		expect(ownerStore.readOwner(sessionId)?.generation).toBe(claimedA.fence.generation);
		ownerStore.database().close();
	});
});
