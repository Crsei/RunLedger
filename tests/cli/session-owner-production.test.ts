/**
 * R6:session-owner production composition fixtures(06 §R6 退出条件)。
 *
 * 真实 Node 进程跑与生产相同的 createEmbeddedSessionRuntime / SessionClient:
 * - 两个进程 attach 同一 Session 观察同一 runtime(同 generation/port);
 * - owner 被 kill 后,另一进程 stale + 3 probes + CAS takeover →
 *   RECOVERY_REQUIRED,恢复同一 event head;
 * - 不同 Session 并行 owner;
 * - 最后一个 attachment 关闭 → pause + release(unowned)。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";

const WORKER = fileURLToPath(new URL("../fixtures/session-owner/runtime-worker.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-owner-production-"));
});

afterEach(() => {
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

function setupSession(seed = "prod"): SessionId {
	const db = openSessionDatabase(join(dir, "state.db"));
	const installed = db.querySingle("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'");
	if (installed === undefined || Number(installed.n) === 0) {
		installSessionStoreSchema(db);
	}
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	db.close();
	return sessionId;
}

function runWorkerSync(command: string, sessionId: string, jsonArgs: Record<string, unknown> = {}): Record<string, unknown> {
	const result = spawnSync(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, dir, JSON.stringify(jsonArgs)], {
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(result.status, `worker ${command} failed: ${result.stderr}`).toBe(0);
	return JSON.parse((result.stdout ?? "").trim().split("\n").pop() ?? "{}");
}

function spawnWorkerAsync(command: string, sessionId: string, jsonArgs: Record<string, unknown> = {}): { child: ChildProcess; stdout: () => string } {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, dir, JSON.stringify(jsonArgs)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	return { child, stdout: () => stdout };
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function lastResultLine(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split("\n");
	return JSON.parse(lines[lines.length - 1] ?? "{}");
}

/** result.json 可先于 parent pipe 的 data event 可见；只在完整 JSON frame 到达后解析。 */
function hasCompleteResultLine(stdout: string): boolean {
	try {
		lastResultLine(stdout);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

describe("R6 production composition", () => {
	it("separate processes claim different sessions through separate SQLite connections", async () => {
		const sessionIds = Array.from({ length: 4 }, (_, index) => setupSession(`claim-${index}`));
		const workers = sessionIds.map((sessionId, index) => {
			const workDir = join(dir, `claim-worker-${index}`);
			const child = spawn(process.execPath, ["--import", "tsx", WORKER, "claim-only", join(dir, "state.db"), sessionId, workDir, "{}"], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
			return { child, stdout: () => stdout };
		});
		await Promise.all(workers.map(({ child }) => new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`claim worker exited ${String(code)}`)));
		})));
		const results = workers.map((worker) => lastResultLine(worker.stdout()));
		expect(results.every((result) => result.ok === true && result.outcome === "claimed")).toBe(true);
		const { ownerStore } = openStores();
		expect(sessionIds.every((sessionId) => ownerStore.readOwner(sessionId)?.state === "starting")).toBe(true);
		ownerStore.database().close();
	});

	it("a second process attaches the same owner runtime (same generation and port)", async () => {
		const sessionId = setupSession("two");
		const holder = spawnWorkerAsync("embedded", sessionId);
		await waitFor(() => hasCompleteResultLine(holder.stdout()), 20_000, "owner claim stdout frame");
		const ownerResult = lastResultLine(holder.stdout());
		expect(ownerResult.ok).toBe(true);
		// attach worker 观察同一 runtime。
		const attach = spawnWorkerAsync("attach", sessionId, { holdMs: 2_000 });
		await waitFor(() => hasCompleteResultLine(attach.stdout()), 20_000, "attach result stdout frame");
		const attachResult = lastResultLine(attach.stdout());
		expect(attachResult.ok).toBe(true);
		expect(attachResult.outcome).toBe("attached");
		expect(attachResult.generation).toBe(ownerResult.generation);
		expect(attachResult.runtimeId).toBe(await readOwnerRuntimeId(sessionId));
		writeFileSync(join(dir, "release"), "release");
	});

	it("owner crash → takeover → RECOVERY_REQUIRED with the same event head", async () => {
		const sessionId = setupSession("crash");
		const holder = spawnWorkerAsync("embedded", sessionId);
		await waitFor(() => hasCompleteResultLine(holder.stdout()), 20_000, "owner claim stdout frame");
		const ownerResult = lastResultLine(holder.stdout());
		expect(ownerResult.ok).toBe(true);
		const priorGeneration = Number(ownerResult.generation);
		// kill owner 进程(SIGKILL 模拟 whole-process crash)。
		holder.child.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 500));
		// 模拟 owner 已死 60s:backdate heartbeat(stale 判定 20s)。
		const { ownerStore } = openStores();
		ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, sessionId]);
		ownerStore.database().close();
		// 新进程 takeover:stale heartbeat + 3 probe failures + CAS。
		const takeover = runWorkerSync("takeover-deadline", sessionId, { deadlineMs: 25_000 });
		expect(takeover.ok).toBe(true);
		expect(Number(takeover.generation)).toBe(priorGeneration + 1);
		expect(takeover.runtimeState).toBe("recovery_required");
		expect(takeover.barrierState).toBe("open");
		// 恢复同一 event head(无事件丢失/重复)。
		const { store } = openStores();
		const events = store.replaySessionEvents(sessionId);
		const ownerEvents = events.filter((event) => event.eventType.startsWith("owner."));
		expect(ownerEvents.some((event) => event.eventType === "owner.taken_over")).toBe(true);
		store.database().close();
	});

	it("two different sessions run with parallel owners", async () => {
		const sessionA = setupSession("pa");
		const sessionB = setupSession("pb");
		const holderA = spawnWorkerAsync("embedded", sessionA);
		await waitFor(() => hasCompleteResultLine(holderA.stdout()), 20_000, "owner A stdout frame");
		const resultA = lastResultLine(holderA.stdout());
		expect(resultA.ok).toBe(true);
		// 清空 result.json,再启动 B。
		rmSync(join(dir, "result.json"), { force: true });
		const holderB = spawnWorkerAsync("embedded", sessionB);
		await waitFor(() => hasCompleteResultLine(holderB.stdout()), 20_000, "owner B stdout frame");
		const resultB = lastResultLine(holderB.stdout());
		expect(resultB.ok).toBe(true);
		expect(resultA.port).not.toBe(resultB.port);
		expect(resultA.generation).toBe(1);
		expect(resultB.generation).toBe(1);
		writeFileSync(join(dir, "release"), "release");
	});

	it("the last attachment closing pauses the session and releases the owner (unowned)", async () => {
		const sessionId = setupSession("last");
		const holder = spawnWorkerAsync("embedded", sessionId);
		await waitFor(() => hasCompleteResultLine(holder.stdout()), 20_000, "owner claim stdout frame");
		const ownerResult = lastResultLine(holder.stdout());
		expect(ownerResult.ok).toBe(true);
		// 本地 view detach 后 attachment 归零 → headless loop pause + release。
		writeFileSync(join(dir, "release"), "release");
		await waitFor(() => holder.stdout().includes('"paused_after_last_attachment"'), 20_000, "owner release");
		const { ownerStore } = openStores();
		const record = ownerStore.readOwner(sessionId);
		expect(record?.state).toBe("unowned");
		// paused checkpoint 已写入。
		const { store } = openStores();
		expect(store.getSession(sessionId)?.currentCheckpointId).toBeTruthy();
		store.database().close();
	});
});

async function readOwnerRuntimeId(sessionId: string): Promise<string> {
	const { ownerStore } = openStores();
	const record = ownerStore.readOwner(sessionId);
	ownerStore.database().close();
	return record?.runtimeId ?? "";
}
