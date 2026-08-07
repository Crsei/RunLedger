/**
 * R3:SessionOwner claim fixtures(06 §5.1/§5.2)。
 *
 * 覆盖:bind-before-publish、fresh claim(generation 1)、unowned row claim
 * (generation 单调)、claim 失败清理 candidate、admission gate 拒绝、真实
 * 多进程 2/10 contender 同 session 竞争(至多一个 claim 成功)、loser 在
 * winner release 后 attach。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { beginOfflineMigration } from "../../../src/storage/session-store/schema-compatibility.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner, SessionOwnerOpenError } from "../../../src/runtime/session-owner/session-owner.ts";
import { createTcpOwnerTransport } from "../../../src/runtime/session-server/owner-probe.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-owner/owner-worker.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-owner-claim-"));
});
afterEach(() => {
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

function runWorkerSync(command: string, sessionId: string, jsonArgs: Record<string, unknown> = {}): Record<string, unknown> {
	const result = spawnSync(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, dir, JSON.stringify(jsonArgs)], {
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(result.status, `worker ${command} failed: ${result.stderr}`).toBe(0);
	return JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "{}");
}

function spawnWorkerAsync(command: string, sessionId: string, jsonArgs: Record<string, unknown> = {}): {
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
} {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, dir, JSON.stringify(jsonArgs)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return { child, stdout: () => stdout, stderr: () => stderr };
}

function setupWorker(sessionSeed = "a"): SessionId {
	const { store } = openStore();
	const sessionId = createSession(store, sessionSeed);
	store.database().close();
	return sessionId;
}

async function waitFor(fn: () => boolean, timeoutMs = 15_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function waitExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
}

function lastResultLine(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1] ?? "{}");
}

describe("R3 claim", () => {
	it("binds the candidate listener before publishing the endpoint (bind-before-publish)", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const owner = makeOwner();
		const result = await owner.open(sessionId);
		expect(result.ok).toBe(true);
		if (!result.ok || result.outcome !== "claimed") throw new Error("expected claim");
		expect(result.endpoint.host).toBe("127.0.0.1");
		expect(result.endpoint.port).toBeGreaterThan(0);
		const record = ownerStore.readOwner(sessionId);
		expect(record?.endpoint?.port).toBe(result.endpoint.port);
		expect(record?.state).toBe("starting");
		expect(record?.generation).toBe(1);
		owner.release("detached");
		store.database().close();
	});

	it("claims a fresh session at generation 1 and appends owner.claimed in the same transaction", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const owner = makeOwner();
		const result = await owner.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		if (!result.ok) throw new Error("expected claim");
		const events = store.replaySessionEvents(sessionId);
		const claimed = events.filter((event) => event.eventType === "owner.claimed");
		expect(claimed).toHaveLength(1);
		const payload = JSON.parse(claimed[0]!.payloadJson) as Record<string, unknown>;
		expect(payload.generation).toBe(1);
		expect(payload.port).toBe(result.endpoint.port);
		// §4.6:token 不得进入 event payload。
		expect(JSON.stringify(events)).not.toContain(owner.currentAuthToken);
		owner.release("detached");
		store.database().close();
	});

	it("increments generation when claiming an explicitly released (unowned) row", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const first = makeOwner();
		const claimed = await first.open(sessionId);
		expect(claimed.ok && claimed.outcome === "claimed").toBe(true);
		if (!claimed.ok) throw new Error("expected claim");
		first.release("paused");
		expect(ownerStore.readOwner(sessionId)?.state).toBe("unowned");
		const second = makeOwner();
		const result = await second.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		if (!result.ok) throw new Error("expected claim");
		expect(result.fence.generation).toBe(2);
		expect(ownerStore.readOwner(sessionId)?.generation).toBe(2);
		second.release("detached");
		store.database().close();
	});

	it("fails closed while the store admission gate is blocked", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const gate = beginOfflineMigration(store.database());
		expect(gate.ok).toBe(true);
		const owner = makeOwner();
		const result = await owner.open(sessionId);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.code).toBe("upgrade_requires_sessions_closed");
		expect(result.retryable).toBe(false);
		gate.ok && gate.gate.release();
		store.database().close();
	});

	it("throws a typed error when claiming a nonexistent session", async () => {
		const owner = makeOwner();
		await expect(owner.open(createRuntimeId("session", "missing"))).rejects.toThrowError(SessionOwnerOpenError);
	});

	it("a claim loser closes its candidate listener and reports owner_claim_lost", async () => {
		const { store } = openStore();
		const sessionId = createSession(store);
		const winner = makeOwner();
		const claimed = await winner.open(sessionId);
		expect(claimed.ok && claimed.outcome === "claimed").toBe(true);
		if (!claimed.ok) throw new Error("expected claim");
		const loser = makeOwner();
		const result = await loser.tryClaim({ mode: "fresh", sessionId });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected loss");
		expect(result.code).toBe("owner_claim_lost");
		expect(result.retryable).toBe(true);
		expect(loser.currentFence).toBeUndefined();
		winner.release("detached");
		store.database().close();
	});

	it("lets two real processes race a fresh claim; exactly one wins", async () => {
		const sessionId = setupWorker("race");
		const results = [runWorkerSync("claim-single", sessionId), runWorkerSync("claim-single", sessionId)];
		const winners = results.filter((result) => result.ok === true);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.outcome).toBe("claimed");
		const losers = results.filter((result) => result.ok === false);
		expect(losers[0]?.code).toBe("owner_claim_lost");
		const { ownerStore } = openStore();
		const record = ownerStore.readOwner(sessionId);
		expect(record?.generation).toBe(1);
		ownerStore.database().close();
	});

	it("lets ten real processes race a fresh claim; exactly one wins", async () => {
		const sessionId = setupWorker("race10");
		const results = Array.from({ length: 10 }, () => runWorkerSync("claim-single", sessionId));
		const winners = results.filter((result) => result.ok === true && result.outcome === "claimed");
		expect(winners).toHaveLength(1);
		expect(results.filter((result) => result.ok === false && result.code === "owner_claim_lost")).toHaveLength(9);
	});

	it("a loser attaches while the winner is healthy and claims after release (real processes)", async () => {
		const sessionId = setupWorker("attach");
		const holder = spawnWorkerAsync("claim-and-hold", sessionId);
		await waitFor(() => existsSync(join(dir, "result.json")), 15_000, "holder claim result");
		expect(lastResultLine(holder.stdout())).toMatchObject({ outcome: "claimed" });
		// P0-1:winner 持有期间(heartbeat fresh),统一 open 即时 attach,不 retry 也不抢占。
		const loserResult = runWorkerSync("open-deadline", sessionId, { deadlineMs: 3_000 });
		expect(loserResult.ok).toBe(true);
		expect(loserResult.outcome).toBe("attached");
		expect(loserResult.generation).toBe(1);
		// 释放(unowned)后:同一 open 路径重新评估 → claim 成功,generation 单调递增。
		writeFileSync(join(dir, "release"), "release");
		await waitExit(holder.child);
		const second = runWorkerSync("open-deadline", sessionId, { deadlineMs: 8_000 });
		expect(second.ok).toBe(true);
		expect(second.outcome).toBe("claimed");
		expect(second.generation).toBe(2);
	});

	it("rejects a takeover claim when the expected row no longer matches", async () => {
		const { store, ownerStore } = openStore();
		const sessionId = createSession(store);
		const winner = makeOwner();
		const claimed = await winner.open(sessionId);
		expect(claimed.ok && claimed.outcome === "claimed").toBe(true);
		if (!claimed.ok) throw new Error("expected claim");
		// expected 与 row 不一致(错误 runtime/generation)→ CAS 失败。
		const loser = makeOwner();
		const result = await loser.tryClaim({
			mode: "takeover",
			sessionId,
			expected: { runtimeId: "runtime_ghost", generation: 99, state: "running" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected loss");
		expect(result.code).toBe("owner_claim_lost");
		winner.release("detached");
		store.database().close();
	});
});
